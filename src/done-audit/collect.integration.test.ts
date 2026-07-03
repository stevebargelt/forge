import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { writeTicket } from "../backlog/structured.js";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { collectDoneAuditInput, collectDoneAuditInputFor } from "./collect.js";
import { evaluateDoneAudit } from "./done-audit.js";
import type { CampaignItem, Run, Task } from "../types/index.js";

let projectDir: string;
let prevDb: DatabaseInstance | null = null;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

function makeItem(ticketId: string, runId?: string): CampaignItem {
  return {
    id: `item-${ticketId}`,
    campaignId: "campaign-test",
    itemOrder: 1,
    ticketId,
    runId,
    lifecycleStatus: "complete",
    outcome: "shipped",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function makeRun(id: string): Run {
  return { id, workflow: "feature", title: "Test Run", status: "complete", createdAt: "2024-01-01T00:00:00Z" };
}

function makeTask(id: string, runId: string, result?: unknown): Task {
  return {
    id,
    runId,
    phase: "engineer",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    result,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "collect-integ-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  prevDb = setDbForTest(makeInMemoryDb());
});

afterEach(() => {
  if (prevDb) setDbForTest(prevDb);
  prevDb = null;
  rmSync(projectDir, { recursive: true, force: true });
});

// ── missing ticket → ticket null ──────────────────────────────────────────────

test("collect: missing ticket → ticket null (unknown checks)", () => {
  // Do NOT write any ticket to projectDir — ticketId does not exist
  const item = makeItem("FG-NONEXISTENT-9999");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.ticket, null, "ticket must be null when ticketId not found in backlog");
  // ticket=null → ticket_closed and closed_commit_present will be unknown
  // (covered by the evaluator; here we verify collect returns null, not throws)
});

// ── dirty working tree (uncommitted backlog close) → git.dirty=true ──────────

test("collect: uncommitted backlog close state → git.dirty=true", () => {
  // Simulate the dirty state caused by a ticket moved from done/ back to stories/
  // without committing — this is the canonical "uncommitted backlog close" scenario.
  const doneDir = join(projectDir, "backlog", "done");
  const storiesDir = join(projectDir, "backlog", "stories");
  mkdirSync(doneDir, { recursive: true });
  mkdirSync(storiesDir, { recursive: true });

  const doneFile = join(doneDir, "FG-COLLECT-1-some-title.md");
  writeFileSync(doneFile, "---\nid: FG-COLLECT-1\ntype: story\nstatus: done\ntitle: Collect Test One\n---\ndone\n");

  // Commit the done/ version so git sees a clean base
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "close ticket"], projectDir);

  // Now move it back to stories/ without committing — dirty working tree
  const storiesFile = join(storiesDir, "FG-COLLECT-1-some-title.md");
  writeFileSync(storiesFile, "---\nid: FG-COLLECT-1\ntype: story\nstatus: active\ntitle: Collect Test One\n---\nactive\n");

  writeTicket(projectDir, {
    id: "FG-COLLECT-1",
    type: "story",
    status: "done",
    title: "Collect Test One",
    body: "done",
    related: [],
  });

  const item = makeItem("FG-COLLECT-1");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.git.dirty, true, "dirty must be true when backlog close state is uncommitted");
});

// ── clean working tree → git.dirty=false ──────────────────────────────────────

test("collect: clean working tree → git.dirty=false", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-2",
    type: "story",
    status: "done",
    title: "Collect Test Two",
    body: "done",
    related: [],
  });

  // Make a commit so git status is clean (nothing staged, nothing untracked)
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "--allow-empty", "-m", "initial"], projectDir);

  const item = makeItem("FG-COLLECT-2");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.git.dirty, false, "dirty must be false when working tree is clean");
});

// ── FG-428: host-local operational noise must not block shipped work ─────────

test("collect: only backlog/notes.md + untracked .forge-scratch/ file dirty → git.dirty=false", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-NOISE-1",
    type: "story",
    status: "done",
    title: "Collect Noise One",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "initial"], projectDir);

  // Modify backlog/notes.md (tracked, host-local operator scratch)
  const notesPath = join(projectDir, "backlog", "notes.md");
  mkdirSync(join(projectDir, "backlog"), { recursive: true });
  writeFileSync(notesPath, "operator scratch notes\n");

  // Untracked file under .forge-scratch/
  const scratchDir = join(projectDir, ".forge-scratch");
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(join(scratchDir, "temp.txt"), "scratch\n");

  const item = makeItem("FG-COLLECT-NOISE-1");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.git.dirty, false, "backlog/notes.md and .forge-scratch/ noise must not count as dirty");
});

test("collect: real tracked source file modified alongside noise → git.dirty=true (regression)", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-NOISE-2",
    type: "story",
    status: "done",
    title: "Collect Noise Two",
    body: "done",
    related: [],
  });
  writeFileSync(join(projectDir, "src.ts"), "export const a = 1;\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "initial"], projectDir);

  // Noise: backlog/notes.md + .forge-scratch/
  mkdirSync(join(projectDir, "backlog"), { recursive: true });
  writeFileSync(join(projectDir, "backlog", "notes.md"), "operator scratch notes\n");
  const scratchDir = join(projectDir, ".forge-scratch");
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(join(scratchDir, "temp.txt"), "scratch\n");

  // Genuine dirty change: modify a real tracked source file
  writeFileSync(join(projectDir, "src.ts"), "export const a = 2;\n");

  const item = makeItem("FG-COLLECT-NOISE-2");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.git.dirty, true, "a genuinely dirty tracked file must still report dirty=true even alongside noise");
});

// ── non-existent closedCommit → commitExists=false ───────────────────────────

test("collect: non-existent closedCommit → commitExists=false (not null)", () => {
  const fakeCommit = "deadbeef1234567890deadbeef1234567890dead";

  writeTicket(projectDir, {
    id: "FG-COLLECT-3",
    type: "story",
    status: "done",
    closedCommit: fakeCommit,
    title: "Collect Test Three",
    body: "done",
    related: [],
  });

  // Init a bare git repo with no commits — the fake commit cannot exist
  const item = makeItem("FG-COLLECT-3");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.ticket?.closedCommit, fakeCommit, "ticket must contain the closedCommit");
  assert.equal(
    input.git.commitExists,
    false,
    "commitExists must be false when closedCommit does not exist in the repository"
  );
  assert.notEqual(input.git.commitExists, null, "commitExists must be false, not null — the commit is definitely absent");
});

// ── existing closedCommit → commitExists=true ────────────────────────────────

test("collect: existing closedCommit → commitExists=true", () => {
  // Make an initial commit so we have a real commit hash
  writeFileSync(join(projectDir, "README.md"), "init");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init commit"], projectDir);

  const realCommit = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  writeTicket(projectDir, {
    id: "FG-COLLECT-4",
    type: "story",
    status: "done",
    closedCommit: realCommit,
    title: "Collect Test Four",
    body: "done",
    related: [],
  });

  const item = makeItem("FG-COLLECT-4");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.ticket?.closedCommit, realCommit);
  assert.equal(input.git.commitExists, true, "commitExists must be true when the commit exists in the repo");
});

// ── ticket fields passed through correctly ────────────────────────────────────

test("collect: ticket fields (status, body, related) passed through from backlog", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-5",
    type: "story",
    status: "done",
    title: "Collect Test Five",
    body: "## Deferred\nFollow-up in FG-999.\n",
    related: ["FG-999"],
  });

  const item = makeItem("FG-COLLECT-5");
  const input = collectDoneAuditInput(projectDir, item);

  assert.ok(input.ticket !== null, "ticket must not be null for a readable ticket");
  assert.equal(input.ticket!.status, "done");
  assert.ok(input.ticket!.body.includes("Deferred"), "ticket body must be passed through");
  assert.deepEqual(input.ticket!.related, ["FG-999"]);
});

// ── verification fields: host null when no evidence rows exist ────────────────

test("collect: hostVerified is null when no evidence rows exist", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-6",
    type: "story",
    status: "done",
    title: "Collect Test Six",
    body: "done",
    related: [],
  });

  const item = makeItem("FG-COLLECT-6");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.verification.hostVerified, null, "hostVerified must be null when no evidence rows exist");
  assert.equal(input.verification.containerTestsRun, null, "containerTestsRun must be null — item has no runId");
  assert.equal(input.verification.acceptedException, null, "acceptedException must be null");
});

// ── container evidence: runId with task carrying tests_run → sum ──────────────

test("collect: runId with one completed task with tests_run → containerTestsRun equals that value", () => {
  const runId = "run-collect-7";
  insertRun(makeRun(runId));
  insertTask(makeTask("task-collect-7a", runId, { status: "complete", tests_run: 12, tests_passed: 12 }));

  const item = makeItem("FG-COLLECT-7", runId);
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.verification.containerTestsRun, 12);
  assert.equal(input.verification.hostVerified, null);
});

test("collect: runId with multiple tasks → containerTestsRun is the sum across tasks", () => {
  const runId = "run-collect-8";
  insertRun(makeRun(runId));
  insertTask(makeTask("task-collect-8a", runId, { status: "complete", tests_run: 7 }));
  insertTask(makeTask("task-collect-8b", runId, { status: "complete", tests_run: 5, tests_passed: 5 }));

  const item = makeItem("FG-COLLECT-8", runId);
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.verification.containerTestsRun, 12);
});

test("collect: no runId → containerTestsRun null", () => {
  const item = makeItem("FG-COLLECT-9");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.verification.containerTestsRun, null);
});

test("collect: runId with task carrying tests_run=0 → containerTestsRun is 0 (not null)", () => {
  const runId = "run-collect-0";
  insertRun(makeRun(runId));
  insertTask(makeTask("task-collect-0a", runId, { status: "complete", tests_run: 0 }));

  const item = makeItem("FG-COLLECT-0", runId);
  const input = collectDoneAuditInput(projectDir, item);

  assert.strictEqual(input.verification.containerTestsRun, 0, "tests_run=0 is a numeric contribution — containerTestsRun must be 0, not null");
});

test("collect: runId with tasks but none carry numeric tests_run → containerTestsRun null", () => {
  const runId = "run-collect-10";
  insertRun(makeRun(runId));
  insertTask(makeTask("task-collect-10a", runId, { status: "complete", notes: "no tests_run field" }));
  insertTask(makeTask("task-collect-10b", runId, { status: "complete", tests_run: "seven" }));

  const item = makeItem("FG-COLLECT-10", runId);
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.verification.containerTestsRun, null);
});

// ── regression: container evidence does not flip outcome ─────────────────────

test("collect+evaluate: containerTestsRun set but hostVerified null → outcome still unknown", () => {
  const auditInput = {
    ticket: { status: "done", closedCommit: "abc123", body: "done", related: [] },
    item: { lifecycleStatus: "complete", outcome: "shipped" },
    git: { dirty: false, commitExists: true, pushed: true },
    verification: { hostVerified: null, hostVerificationDetail: null, containerTestsRun: 42, acceptedException: null },
  };

  const result = evaluateDoneAudit(auditInput);

  assert.equal(result.outcome, "unknown", "container evidence must not satisfy host_verification");
  const hostCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(hostCheck?.status, "unknown");
  const containerCheck = result.checks.find((c) => c.name === "container_verification");
  assert.equal(containerCheck?.status, "pass", "container_verification check should pass (informational)");
});

// ── host verification recorder evidence ───────────────────────────────────────

// Helper: create a real commit in the test git repo and return its SHA
function makeCommit(label: string): string {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

test("collect: required-gate pass row → hostVerified: true", () => {
  const commitSha = makeCommit("hv-pass");

  writeTicket(projectDir, {
    id: "FG-HV-PASS-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV Pass",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  insertHostVerification({
    ticketId: "FG-HV-PASS-1",
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-PASS-1");

  assert.equal(input.verification.hostVerified, true, "hostVerified must be true when required-gate row has exit_code=0");
  assert.ok(input.verification.hostVerificationDetail !== null, "detail must be set");
  assert.ok(input.verification.hostVerificationDetail!.includes("npm run test:all"), "detail must include gate/command");
  assert.ok(input.verification.hostVerificationDetail!.includes("exit_code: 0"), "detail must include exit_code");
});

test("collect FG-452: a row recorded at a later commit than closedCommit still covers it — ancestry, not exact-sha equality", () => {
  const closedCommit = makeCommit("hv-ancestry-closed");

  writeTicket(projectDir, {
    id: "FG-HV-ANCESTRY-1",
    type: "story",
    status: "done",
    closedCommit,
    title: "HV Ancestry",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  // The gate ran at whatever projectDir's HEAD was AFTER the ticket was closed —
  // exactly the out-of-band code-touching shape (FG-452): the row's commit_sha
  // is a descendant of closedCommit, never equal to it.
  const testedHead = makeCommit("hv-ancestry-tested");

  insertHostVerification({
    ticketId: "FG-HV-ANCESTRY-1",
    projectDir,
    commitSha: testedHead,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-ANCESTRY-1");

  assert.equal(
    input.verification.hostVerified,
    true,
    "hostVerified must be true — closedCommit is an ancestor of the row's tested commit, even though the shas differ"
  );
  assert.ok(input.verification.hostVerificationDetail!.includes(testedHead));
});

test("collect FG-452 round 2: a row whose tested sha descends from closedCommit but is NOT itself reachable on base does not count as covering — hostVerified stays null, not true", () => {
  const closedCommit = makeCommit("hv-offbranch-closed");

  writeTicket(projectDir, {
    id: "FG-HV-OFFBRANCH-1",
    type: "story",
    status: "done",
    closedCommit,
    title: "HV Off Branch",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  gitExec(["checkout", "-b", "off-branch-verify"], projectDir);
  const offBranchHead = makeCommit("hv-offbranch-tested");
  gitExec(["checkout", "main"], projectDir);

  insertHostVerification({
    ticketId: "FG-HV-OFFBRANCH-1",
    projectDir,
    commitSha: offBranchHead,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-OFFBRANCH-1");

  assert.equal(
    input.verification.hostVerified,
    null,
    "closedCommit IS an ancestor of offBranchHead, but offBranchHead itself was never merged to base — must not count as covering"
  );
});

test("collect: required-gate fail row → hostVerified: false → outcome: fail", () => {
  const commitSha = makeCommit("hv-fail");

  writeTicket(projectDir, {
    id: "FG-HV-FAIL-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV Fail",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  insertHostVerification({
    ticketId: "FG-HV-FAIL-1",
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-FAIL-1");

  assert.equal(input.verification.hostVerified, false, "hostVerified must be false when required-gate row has exit_code != 0");

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail", "outcome must be fail when host verification failed");
  const hostCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(hostCheck?.status, "fail");
});

test("collect: no matching rows → hostVerified: null → outcome: unknown", () => {
  const commitSha = makeCommit("hv-none");

  writeTicket(projectDir, {
    id: "FG-HV-NONE-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV None",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  // No host verification rows inserted

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-NONE-1");

  assert.equal(input.verification.hostVerified, null, "hostVerified must be null when no evidence rows exist");

  const result = evaluateDoneAudit(input);
  const hostCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(hostCheck?.status, "unknown", "host_verification check must be unknown");
  assert.notEqual(result.outcome, "pass", "outcome must not be pass with unknown host verification");
});

test("collect: only non-required-gate rows → hostVerified: null → outcome: unknown", () => {
  const commitSha = makeCommit("hv-wrong-gate");

  writeTicket(projectDir, {
    id: "FG-HV-GATE-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV Wrong Gate",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  // Insert a row for a DIFFERENT gate name — must not count as required-gate evidence
  insertHostVerification({
    ticketId: "FG-HV-GATE-1",
    projectDir,
    commitSha,
    gateName: "make check",
    command: "make check",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-GATE-1");

  assert.equal(
    input.verification.hostVerified,
    null,
    "hostVerified must be null when only non-required-gate rows exist"
  );

  const result = evaluateDoneAudit(input);
  const hostCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(hostCheck?.status, "unknown", "non-required-gate evidence must not satisfy host_verification");
});

// Criterion 8: real collect→evaluate path with all checks satisfied produces outcome: pass
test("collect+evaluate: full done-audit pass via real collect→evaluate with host evidence (criterion 8)", () => {
  // Set up a bare remote OUTSIDE projectDir so it doesn't dirty the working tree
  const remoteDir = mkdtempSync(join(tmpdir(), "collect-remote-"));
  try {
  gitExec(["init", "--bare", remoteDir], remoteDir);
  gitExec(["remote", "add", "origin", remoteDir], projectDir);

  // Initial commit (SHA_A = the commit that will be the closedCommit)
  writeFileSync(join(projectDir, "README.md"), "init");
  gitExec(["add", "README.md"], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);
  const closedSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // Write the ticket with closedCommit pointing at closedSha
  writeTicket(projectDir, {
    id: "FG-HV-FULLPASS-1",
    type: "story",
    status: "done",
    closedCommit: closedSha,
    title: "Full done-audit pass",
    body: "no deferred scope",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "close ticket"], projectDir);

  // Push both commits to origin — closedSha is now reachable from origin/main
  gitExec(["push", "origin", "HEAD:refs/heads/main"], projectDir);

  // Insert matching pass evidence for closedSha
  insertHostVerification({
    ticketId: "FG-HV-FULLPASS-1",
    projectDir,
    commitSha: closedSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T12:00:00Z",
  });

  // Real collect path
  const input = collectDoneAuditInputFor(projectDir, "FG-HV-FULLPASS-1");

  assert.equal(input.verification.hostVerified, true, "hostVerified must be true after recording pass evidence");
  assert.equal(input.git.commitExists, true, "closedCommit must exist in the repo");
  assert.equal(input.git.pushed, true, "closedCommit must be reachable from origin");
  assert.equal(input.git.dirty, false, "working tree must be clean");

  // Real evaluate path
  const result = evaluateDoneAudit(input);

  assert.equal(result.outcome, "pass", "done-audit outcome must be pass when all required checks pass");
  const hostCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(hostCheck?.status, "pass");
  assert.ok(hostCheck?.detail?.includes("npm run test:all"), "detail must include gate/command");
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

// ── FG-419 gate-label spoofing regression tests ──────────────────────────────

test("collect FG419: weaker command (typecheck) without --gate does NOT satisfy required gate → hostVerified: null", () => {
  // Regression: recorder previously defaulted gate_name to "npm run test:all" regardless of command,
  // so --command "npm run typecheck" (no --gate) would spoof host_verification. After the fix,
  // gate_name = command = "npm run typecheck", which does not match the required gate.
  const commitSha = makeCommit("hv-spoof-typecheck");

  writeTicket(projectDir, {
    id: "FG-HV-SPOOF-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV Spoof Typecheck",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  // Insert a row whose gate_name is "npm run typecheck" (what the recorder now writes
  // when --command "npm run typecheck" is passed without --gate). The required gate is
  // "npm run test:all" (default), so this must NOT satisfy host_verification.
  insertHostVerification({
    ticketId: "FG-HV-SPOOF-1",
    projectDir,
    commitSha,
    gateName: "npm run typecheck",
    command: "npm run typecheck",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-SPOOF-1");

  assert.equal(
    input.verification.hostVerified,
    null,
    "hostVerified must be null — typecheck gate_name does not match the required gate 'npm run test:all'"
  );
});

test("collect FG419: --command 'npm run test:all' without --gate satisfies required gate → hostVerified: true", () => {
  // Positive case: when command = required gate, gate_name = command = required gate → pass.
  const commitSha = makeCommit("hv-testall-nogate");

  writeTicket(projectDir, {
    id: "FG-HV-TESTALL-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV TestAll NoGate",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  insertHostVerification({
    ticketId: "FG-HV-TESTALL-1",
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-TESTALL-1");

  assert.equal(input.verification.hostVerified, true, "hostVerified must be true — gate_name matches required gate");
});

test("collect FG419: explicit --gate override with different command satisfies required gate → hostVerified: true", () => {
  // Operator explicitly overrides gate name: --command "npm test --workspaces" --gate "npm run test:all".
  // The gate_name recorded is "npm run test:all" → matches required gate → satisfies host_verification.
  const commitSha = makeCommit("hv-explicit-gate");

  writeTicket(projectDir, {
    id: "FG-HV-EXPGATE-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV Explicit Gate",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  insertHostVerification({
    ticketId: "FG-HV-EXPGATE-1",
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm test --workspaces",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-EXPGATE-1");

  assert.equal(
    input.verification.hostVerified,
    true,
    "hostVerified must be true — explicit --gate override of 'npm run test:all' satisfies required gate"
  );
});

// ── FIX 2: any-fail-wins detail reflects the FAILING row, not the trailing pass ─

test("collect FIX2: fail row then pass row → hostVerified=false AND detail reflects failure exit_code", () => {
  const commitSha = makeCommit("hv-fail-then-pass");

  writeTicket(projectDir, {
    id: "FG-HV-FIX2-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV Fix2",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  // Insert fail row first, then a pass row for the same gate
  insertHostVerification({
    ticketId: "FG-HV-FIX2-1",
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  insertHostVerification({
    ticketId: "FG-HV-FIX2-1",
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T01:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-FIX2-1");

  assert.equal(input.verification.hostVerified, false, "any-fail-wins: hostVerified must be false when a fail row exists");
  assert.ok(input.verification.hostVerificationDetail !== null, "detail must be set");
  assert.ok(
    input.verification.hostVerificationDetail!.includes("exit_code: 1"),
    `detail must reflect the FAILING row's exit_code, not the trailing pass\ndetail: ${input.verification.hostVerificationDetail}`
  );
  assert.ok(
    !input.verification.hostVerificationDetail!.includes("exit_code: 0"),
    `detail must NOT show exit_code: 0 when hostVerified=false\ndetail: ${input.verification.hostVerificationDetail}`
  );
});

// ── FG-367: remote exists but commit not pushed → pushed=false ──────────────

test("collect: remote exists but commit not pushed → pushed=false", () => {
  // Add a bare remote but do NOT push the commit to it — `git branch -r --contains` returns empty
  const remoteDir = mkdtempSync(join(tmpdir(), "collect-remote-nopush-"));
  try {
    gitExec(["init", "--bare", remoteDir], remoteDir);
    gitExec(["remote", "add", "origin", remoteDir], projectDir);

    writeFileSync(join(projectDir, "unpushed.txt"), "content");
    gitExec(["add", "."], projectDir);
    gitExec(["commit", "-m", "unpushed commit"], projectDir);
    const commitSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

    writeTicket(projectDir, {
      id: "FG-COLLECT-UNPUSHED",
      type: "story",
      status: "done",
      closedCommit: commitSha,
      title: "Unpushed Remote Test",
      body: "done",
      related: [],
    });

    const input = collectDoneAuditInputFor(projectDir, "FG-COLLECT-UNPUSHED");

    assert.equal(
      input.git.pushed,
      false,
      "pushed must be false when a remote exists but the commit has not been pushed to it"
    );
    assert.notEqual(input.git.pushed, null, "pushed must be false (not null) — a remote exists, the commit simply isn't there");
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

// ── FG-367: no remote configured → pushed=null, pushedReason="no_remote" ─────

test("collect: no remote configured → pushed=null and pushedReason='no_remote'", () => {
  // beforeEach only does git init — no remote is added, so `git remote` returns empty
  writeFileSync(join(projectDir, "no-remote.txt"), "content");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "no-remote commit"], projectDir);
  const commitSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  writeTicket(projectDir, {
    id: "FG-COLLECT-NO-REMOTE",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "No Remote Test",
    body: "done",
    related: [],
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-COLLECT-NO-REMOTE");

  assert.equal(input.git.pushed, null, "pushed must be null (unknown) when no remote is configured — not false (fail)");
  assert.notEqual(input.git.pushed, false, "pushed must NOT be false — a local-only repo is unknown, not unpushed");
  assert.equal(input.git.pushedReason, "no_remote", "pushedReason must be 'no_remote' when git remote returns empty");
});

// ── FG-367 post-close: no-remote truthfulness through collect→evaluate ────────

test("collect+evaluate: no-remote, all other checks pass → outcome unknown AND requestedAction says 'no remote configured; push/PR unavailable' (not 'push <sha>')", () => {
  // Set up a local-only repo with a real commit, ticket, and host evidence — everything
  // passes except pushed (no remote). Verifies the no-remote case produces truthful
  // operator text instead of "push <sha>".
  writeFileSync(join(projectDir, "README.md"), "init");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);
  const closedSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  writeTicket(projectDir, {
    id: "FG-NOREMOTE-ALLPASS",
    type: "story",
    status: "done",
    closedCommit: closedSha,
    title: "No Remote All Pass",
    body: "no deferred scope",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "close ticket"], projectDir);

  insertHostVerification({
    ticketId: "FG-NOREMOTE-ALLPASS",
    projectDir,
    commitSha: closedSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T12:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-NOREMOTE-ALLPASS");
  assert.equal(input.git.pushed, null, "pushed must be null for no-remote repo");
  assert.equal(input.git.pushedReason, "no_remote", "pushedReason must be 'no_remote'");

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "unknown", "outcome must be unknown (not fail) for no-remote repo");

  const pushedCheck = result.checks.find((c) => c.name === "pushed");
  assert.equal(pushedCheck!.status, "unknown", "pushed check must be unknown for no-remote");
  assert.ok(
    pushedCheck!.detail?.includes("no remote configured"),
    `pushed check detail must say 'no remote configured; push/PR unavailable'; got: ${pushedCheck!.detail}`,
  );

  assert.ok(
    !result.requestedAction?.includes(`push ${closedSha}`),
    `requestedAction must NOT include 'push <sha>' for no-remote repo; got: ${result.requestedAction}`,
  );
  assert.ok(
    result.requestedAction?.includes("no remote configured"),
    `requestedAction must say 'no remote configured; push/PR unavailable'; got: ${result.requestedAction}`,
  );
});

test("collect+evaluate: remote exists but commit not pushed → requestedAction includes 'push <sha>'", () => {
  // Verifies that the genuine remote-but-unpushed case still produces "push <sha>",
  // distinguishing it from the no-remote case.
  const remoteDir = mkdtempSync(join(tmpdir(), "collect-remote-ra-"));
  try {
    gitExec(["init", "--bare", remoteDir], remoteDir);
    gitExec(["remote", "add", "origin", remoteDir], projectDir);

    writeFileSync(join(projectDir, "README.md"), "init");
    gitExec(["add", "."], projectDir);
    gitExec(["commit", "-m", "init"], projectDir);
    const closedSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

    writeTicket(projectDir, {
      id: "FG-REMOTE-UNPUSHED-RA",
      type: "story",
      status: "done",
      closedCommit: closedSha,
      title: "Remote Unpushed RA",
      body: "no deferred scope",
      related: [],
    });
    gitExec(["add", "."], projectDir);
    gitExec(["commit", "-m", "close ticket"], projectDir);

    insertHostVerification({
      ticketId: "FG-REMOTE-UNPUSHED-RA",
      projectDir,
      commitSha: closedSha,
      gateName: "npm run test:all",
      command: "npm run test:all",
      exitCode: 0,
      recordedAt: "2026-01-01T12:00:00Z",
    });

    const input = collectDoneAuditInputFor(projectDir, "FG-REMOTE-UNPUSHED-RA");
    assert.equal(input.git.pushed, false, "pushed must be false when remote exists but commit not pushed");
    assert.notEqual(input.git.pushedReason, "no_remote", "pushedReason must not be 'no_remote' when a remote exists");

    const result = evaluateDoneAudit(input);
    assert.equal(result.outcome, "fail", "outcome must be fail for genuinely unpushed commit");

    const pushedCheck = result.checks.find((c) => c.name === "pushed");
    assert.equal(pushedCheck!.status, "fail");

    assert.ok(
      result.requestedAction?.includes(`push ${closedSha}`),
      `requestedAction must include 'push <sha>' for genuinely unpushed commit; got: ${result.requestedAction}`,
    );
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

// ── malformed .forge/config.json → falls back to default gate ────────────────

test("collect: malformed .forge/config.json → falls back to default gate and resolves hostVerified", () => {
  const commitSha = makeCommit("hv-malformed-config");

  writeTicket(projectDir, {
    id: "FG-HV-MALFORMED-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "HV Malformed Config",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  // Write a malformed .forge/config.json — exercises the JSON-parse-error fallback path
  const forgeConfigDir = join(projectDir, ".forge");
  mkdirSync(forgeConfigDir, { recursive: true });
  writeFileSync(join(forgeConfigDir, "config.json"), "{ this is not valid JSON }");

  // Record pass evidence under the DEFAULT required gate (malformed config must not override it)
  insertHostVerification({
    ticketId: "FG-HV-MALFORMED-1",
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-HV-MALFORMED-1");

  assert.equal(
    input.verification.hostVerified,
    true,
    "hostVerified must be true — malformed config falls back to default gate and matches pass evidence"
  );
});
