// FG-428: integration coverage for collectReconcileEvidence — real temp git repo
// (real commits, real merge-base ancestor/non-ancestor) and a real in-memory store
// DB with inserted host-verification rows and events.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { insertHostVerification, queryHostVerificationRows, queryHostVerificationRowsForGate } from "../store/host-verifications.js";
import { logEvent } from "../store/events.js";
import { collectReconcileEvidence, collectAuthoritativeEvents, getRequiredHostGate, runAndRecordHostVerification } from "./reconcile-collect.js";
import type { CiCheckStatus } from "../store/host-verifications.js";
import type { CampaignItem } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let markerDir: string;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function makeCommit(label: string): string {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function item(overrides: Partial<CampaignItem> = {}): CampaignItem {
  return {
    id: "citem-1",
    campaignId: "campaign-1",
    itemOrder: 0,
    ticketId: "FG-200",
    lifecycleStatus: "failed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "reconcile-collect-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  // FG-474: OUTSIDE projectDir on purpose — a marker written INSIDE the repo
  // would itself dirty the working tree and trip runAndRecordHostVerification's
  // own TOCTOU guard (post-run tree-changed check), defeating the "did the gate
  // actually execute" assertion the marker exists to make.
  markerDir = mkdtempSync(join(tmpdir(), "reconcile-collect-marker-"));
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  rmSync(markerDir, { recursive: true, force: true });
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

test("closedCommitReachableOnBase: true when the commit is an ancestor of main", () => {
  const commit = makeCommit("on-main");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Ancestor case",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, true);
  assert.equal(result.ticketStatus, "done");
  assert.equal(result.ticketClosedCommit, commit);
});

test("closedCommitReachableOnBase: false when the commit is on a branch never merged to main", () => {
  makeCommit("main-base");
  gitExec(["checkout", "-b", "feature/off-main"], projectDir);
  const offMainCommit = makeCommit("off-main-only");
  gitExec(["checkout", "main"], projectDir);

  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: offMainCommit,
    title: "Non-ancestor case",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, false);
});

test("closedCommitReachableOnBase respects a configured baseBranch other than main", () => {
  makeCommit("main-base");
  gitExec(["checkout", "-b", "release"], projectDir);
  const releaseCommit = makeCommit("release-only");
  gitExec(["checkout", "main"], projectDir);

  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ baseBranch: "release" }));

  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: releaseCommit,
    title: "Configured base branch",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, true, "reachable on the configured 'release' base, not main");
});

test("closedCommitReachableOnBase is null when closedCommit is malformed (option-injection guard)", () => {
  makeCommit("main-base-injection");
  // An operator-editable ticket frontmatter value crafted to be parsed as a git
  // option rather than a positional commit-ish, if it ever reached git unvalidated.
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: "--upload-pack=evil",
    title: "Malformed closedCommit",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, null, "a malformed closedCommit must never reach git as a positional arg");
});

test("closedCommitReachableOnBase is null when baseBranch is malformed (option-injection guard)", () => {
  const commit = makeCommit("main-base-injection-2");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ baseBranch: "--upload-pack=evil" }));
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Malformed baseBranch",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, null);
});

test("closedCommitReachableOnBase is null when there is no closedCommit", () => {
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "active",
    title: "No closed commit",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, null);
});

test("hostVerification: recorded true + passed true when a row for the actual closedCommit exits 0", () => {
  const commit = makeCommit("verified");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Verified",
    body: "",
  });
  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(result.hostVerification, { recorded: true, passed: true });
});

test("hostVerification: passed false when the only covering row for the closedCommit is non-zero", () => {
  const commit = makeCommit("mixed-verify");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Mixed",
    body: "",
  });
  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(result.hostVerification, { recorded: true, passed: false });
});

test("hostVerification: null when no rows recorded for the closedCommit", () => {
  const commit = makeCommit("unverified");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Unverified",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(result.hostVerification, { recorded: false, passed: false });
});

test("hostVerification respects a configured requiredHostGate", () => {
  const commit = makeCommit("custom-gate");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Custom gate",
    body: "",
  });
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ requiredHostGate: "npm run verify" }));

  // A row under the DEFAULT gate name must not satisfy the configured gate.
  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  const wrongGate = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(wrongGate.hostVerification, { recorded: false, passed: false });

  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run verify",
    command: "npm run verify",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:01Z",
  });
  const rightGate = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(rightGate.hostVerification, { recorded: true, passed: true });
});

test("events: ordered verdict.received and gate.decided events mapped by ascending event id", () => {
  const runId = "run-collect-1";
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("gate.decided", { runId, payload: { decision: "advance", rationale: "override", force: true } });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  // Non-matching event types must be filtered out.
  logEvent("task.started", { runId });

  const result = collectReconcileEvidence(projectDir, item({ runId }));
  assert.equal(result.events.length, 3);
  assert.ok(result.events[0]!.id < result.events[1]!.id);
  assert.ok(result.events[1]!.id < result.events[2]!.id);

  assert.equal(result.events[0]!.kind, "verdict");
  assert.equal((result.events[0] as { verdict: string }).verdict, "fail");
  assert.equal(result.events[1]!.kind, "gate");
  assert.equal((result.events[1] as { force: boolean }).force, true);
  assert.equal(result.events[2]!.kind, "verdict");
  assert.equal((result.events[2] as { verdict: string }).verdict, "pass");
});

test("events: empty when the item has no runId", () => {
  const result = collectReconcileEvidence(projectDir, item({ runId: undefined }));
  assert.deepEqual(result.events, []);
});

// FG-427: collectAuthoritativeEvents is the single events->ReconcileRunEvent[]
// translation shared by collectReconcileEvidence and executor.ts's drive-path
// reconciliation — verify it carries taskId through from the store Event.
test("collectAuthoritativeEvents: taskId is carried through from the store event onto both verdict and gate events", () => {
  const runId = "run-collect-taskid";
  logEvent("verdict.received", {
    runId,
    taskId: "task-a",
    payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" },
  });
  logEvent("gate.decided", {
    runId,
    taskId: "task-a",
    payload: { decision: "advance", rationale: "override", force: true },
  });
  logEvent("verdict.received", {
    runId,
    taskId: "task-b",
    payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" },
  });

  const events = collectAuthoritativeEvents(runId);
  assert.equal(events.length, 3);
  assert.equal(events[0]!.taskId, "task-a");
  assert.equal(events[1]!.taskId, "task-a");
  assert.equal(events[2]!.taskId, "task-b");

  // collectReconcileEvidence must delegate to the exact same translation.
  const evidence = collectReconcileEvidence(projectDir, item({ runId }));
  assert.deepEqual(evidence.events, events);
});

test("collectAuthoritativeEvents: taskId is undefined when the underlying event has no task_id", () => {
  const runId = "run-collect-no-taskid";
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });

  const events = collectAuthoritativeEvents(runId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.taskId, undefined);
});

test("ticket unreadable: ticketStatus/ticketClosedCommit undefined, no throw", () => {
  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-DOES-NOT-EXIST" }));
  assert.equal(result.ticketStatus, undefined);
  assert.equal(result.ticketClosedCommit, undefined);
  assert.equal(result.closedCommitReachableOnBase, null);
});

// ── FG-440: getRequiredHostGate + runAndRecordHostVerification ─────────────────
//
// The gate now runs in projectDir itself (which has node_modules, since it's
// the real project checkout) at whatever HEAD currently is — never a detached
// checkout of some other commit (that earlier design guaranteed npm-based
// gates would false-fail on missing dependencies). Recorded commitSha is
// always the real tested HEAD.

function writePackageJsonWithGateScript(scriptBody: string): void {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.0.0", scripts: { "test:all": scriptBody } }, null, 2)
  );
}

// FG-474 red-review fix (task-red-wide-16933b): the CI-sourced evidence branch
// now content-verifies the pairing against THIS projectDir's own ci.yml
// (projectCiRunsCommand) rather than a hardcoded constant — so a stubbed green
// check only reaches (or is correctly rejected before reaching) the provider
// when the project actually has a workflow named "CI" whose "test" job runs
// the given command. Committed alongside the gate script so the tree stays
// clean for runAndRecordHostVerification's dirty-tree guard.
function writeMatchingCiWorkflow(command: string): void {
  mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(projectDir, ".github", "workflows", "ci.yml"),
    `name: CI\njobs:\n  test:\n    steps:\n      - run: ${command}\n`
  );
}

function commitAll(label: string): string {
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function headSha(): string {
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

test("getRequiredHostGate: project default when unconfigured, configured value when set", () => {
  assert.equal(getRequiredHostGate(projectDir), "npm run test:all");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ requiredHostGate: "npm run verify" }));
  assert.equal(getRequiredHostGate(projectDir), "npm run verify");
});

test("runAndRecordHostVerification: real pass — runs in projectDir at HEAD, records exitCode 0, commitSha equal to the REAL HEAD sha, gateName/command equal to the configured requiredHostGate string", () => {
  writePackageJsonWithGateScript("exit 0");
  const commit = commitAll("add passing gate script");

  const result = runAndRecordHostVerification(projectDir, "FG-600");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.equal((result as { commitSha: string }).commitSha, commit, "commitSha must equal rev-parse HEAD, not any closedCommit value");
  assert.equal((result as { commitSha: string }).commitSha, headSha());

  const rows = queryHostVerificationRowsForGate("FG-600", projectDir, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 0);
  assert.equal(rows[0]!.gateName, "npm run test:all", "gateName must be the configured gate string, never the executed argv");
  assert.equal(rows[0]!.command, "npm run test:all");
  assert.equal(rows[0]!.commitSha, commit);
});

test("runAndRecordHostVerification: real failure — records the ACTUAL non-zero exit code, never a fabricated 0", () => {
  writePackageJsonWithGateScript("exit 7");
  const commit = commitAll("add failing gate script");

  const result = runAndRecordHostVerification(projectDir, "FG-601");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 7);

  const rows = queryHostVerificationRows("FG-601", projectDir, commit, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 7);
});

test("runAndRecordHostVerification: skip when the required gate's script is absent in projectDir — writes NO row", () => {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synthetic", scripts: { lint: "exit 0" } }, null, 2)
  );
  commitAll("package.json without the required gate script");

  const result = runAndRecordHostVerification(projectDir, "FG-602");
  assert.equal(result.status, "skipped");
  assert.equal(
    queryHostVerificationRowsForGate("FG-602", projectDir, "npm run test:all").length,
    0,
    "a skipped gate must never write a synthetic pass row"
  );
});

test("runAndRecordHostVerification: skip when there is no package.json at all in projectDir — writes NO row", () => {
  makeCommit("no-package-json");
  const result = runAndRecordHostVerification(projectDir, "FG-603");
  assert.equal(result.status, "skipped");
  assert.equal(queryHostVerificationRowsForGate("FG-603", projectDir, "npm run test:all").length, 0);
});

test("runAndRecordHostVerification: dirty working tree (uncommitted change) — writes NO row, does not run the gate", () => {
  writePackageJsonWithGateScript("exit 0");
  commitAll("add passing gate script");
  // Uncommitted modification — the working tree is no longer clean.
  writeFileSync(join(projectDir, "uncommitted-change.txt"), "uncommitted change");

  const result = runAndRecordHostVerification(projectDir, "FG-608");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /not clean/, "reason must explain the dirty-tree refusal");
  assert.equal(
    queryHostVerificationRowsForGate("FG-608", projectDir, "npm run test:all").length,
    0,
    "an operator's dirty working state must never be recorded as a tested result"
  );
});

test("runAndRecordHostVerification: dirty working tree (untracked file) — writes NO row", () => {
  writePackageJsonWithGateScript("exit 0");
  commitAll("add passing gate script");
  writeFileSync(join(projectDir, "untracked.txt"), "not added or committed");

  const result = runAndRecordHostVerification(projectDir, "FG-609");
  assert.equal(result.status, "skipped");
  assert.equal(queryHostVerificationRowsForGate("FG-609", projectDir, "npm run test:all").length, 0);
});

test("runAndRecordHostVerification: a gate that times out records a real non-zero sentinel, never exit 0", () => {
  writePackageJsonWithGateScript("sleep 2 && exit 0");
  commitAll("add slow gate script");

  const prevTimeout = process.env["FORGE_HOST_GATE_TIMEOUT_MS"];
  process.env["FORGE_HOST_GATE_TIMEOUT_MS"] = "200";
  try {
    const result = runAndRecordHostVerification(projectDir, "FG-606");
    assert.equal(result.status, "recorded");
    assert.notEqual((result as { exitCode: number }).exitCode, 0, "a timeout must never be recorded as a pass");
  } finally {
    if (prevTimeout === undefined) delete process.env["FORGE_HOST_GATE_TIMEOUT_MS"];
    else process.env["FORGE_HOST_GATE_TIMEOUT_MS"] = prevTimeout;
  }
});

// ── FG-440: ancestry-based coverage (checkClosedCommitCoveredByTestedSha via collectReconcileEvidence) ──

test("hostVerification: ancestry — an item whose closedCommit is an ANCESTOR of a recorded row's tested HEAD is covered", () => {
  writePackageJsonWithGateScript("exit 0");
  const closedCommit = commitAll("closedCommit for FG-630");
  writeTicket(projectDir, { id: "FG-630", type: "story", status: "done", closedCommit, title: "Ancestor coverage", body: "" });

  // HEAD advances beyond closedCommit before the gate runs — the recorded row's
  // commitSha will be this later HEAD, not closedCommit itself.
  const testedHead = commitAll("HEAD advances past closedCommit");

  const captured = runAndRecordHostVerification(projectDir, "FG-630");
  assert.equal(captured.status, "recorded");
  assert.equal((captured as { commitSha: string }).commitSha, testedHead);

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-630" }));
  assert.deepEqual(
    result.hostVerification,
    { recorded: true, passed: true },
    "closedCommit is an ancestor of the tested HEAD — covered, even though the row's commitSha != closedCommit"
  );
});

test("hostVerification: ancestry — an item whose closedCommit is NOT an ancestor of any recorded row's commitSha is NOT covered", () => {
  writePackageJsonWithGateScript("exit 0");
  makeCommit("main-base-631");
  gitExec(["checkout", "-b", "feature/off-main-631"], projectDir);
  const offMainCommit = makeCommit("off-main-631-closed-commit");
  gitExec(["checkout", "main"], projectDir);

  // A row is recorded for main's HEAD (tree still clean — the ticket write below
  // happens after), which never includes the off-main commit.
  const captured = runAndRecordHostVerification(projectDir, "FG-631");
  assert.equal(captured.status, "recorded");

  writeTicket(projectDir, { id: "FG-631", type: "story", status: "done", closedCommit: offMainCommit, title: "Non-ancestor coverage", body: "" });

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-631" }));
  assert.deepEqual(
    result.hostVerification,
    { recorded: false, passed: false },
    "closedCommit is not reachable from the tested row's commitSha — must not be covered"
  );
});

// ── FIX 1 (FG-440 follow-up): testedSha must itself be reachable on the base branch ──

test("hostVerification: MATCH-time base-reachability — a row whose testedSha is off the base branch does NOT cover, even though closedCommit IS an ancestor of testedSha", () => {
  const closedCommit = makeCommit("closedCommit-for-off-branch-632");

  // A feature branch cut AFTER closedCommit: closedCommit is its ancestor, but
  // the branch itself is never merged to main. The ticket write happens AFTER
  // returning to main — writing it before the checkout would let `makeCommit`'s
  // `git add .` on the feature branch sweep up the uncommitted ticket file and
  // commit it there instead, which `checkout main` would then delete.
  gitExec(["checkout", "-b", "feature/off-branch-632"], projectDir);
  const offBranchTestedSha = makeCommit("off-branch-tested-head-632");
  gitExec(["checkout", "main"], projectDir);

  writeTicket(projectDir, { id: "FG-632", type: "story", status: "done", closedCommit, title: "Off-branch tested sha", body: "" });

  insertHostVerification({
    ticketId: "FG-632",
    projectDir,
    commitSha: offBranchTestedSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-632" }));
  assert.deepEqual(
    result.hostVerification,
    { recorded: false, passed: false },
    "a never-merged off-branch build must never permanently cover the ticket, even though closedCommit is its ancestor"
  );
});

test("hostVerification: a row whose testedSha IS on the base branch covers (positive control for the base-reachability check above)", () => {
  const closedCommit = makeCommit("closedCommit-for-on-branch-633");
  writeTicket(projectDir, { id: "FG-633", type: "story", status: "done", closedCommit, title: "On-branch tested sha", body: "" });
  const onBranchTestedSha = makeCommit("on-branch-tested-head-633");

  insertHostVerification({
    ticketId: "FG-633",
    projectDir,
    commitSha: onBranchTestedSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-633" }));
  assert.deepEqual(result.hostVerification, { recorded: true, passed: true });
});

test("runAndRecordHostVerification: CAPTURE-time — HEAD not reachable on the base branch SKIPS, never runs the gate, writes NO row", () => {
  writePackageJsonWithGateScript("exit 0");
  commitAll("add gate script on main");
  gitExec(["checkout", "-b", "feature/off-main-634"], projectDir);
  makeCommit("feature-commit-634");

  const result = runAndRecordHostVerification(projectDir, "FG-634");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /not reachable on base branch/, "reason must explain the off-branch refusal");
  assert.equal(
    queryHostVerificationRowsForGate("FG-634", projectDir, "npm run test:all").length,
    0,
    "an operator sitting on a feature branch must never have that build recorded as the tested base line"
  );
});

// ── FIX 3 (FG-440 follow-up): capture-window TOCTOU ─────────────────────────────

test("runAndRecordHostVerification: TOCTOU — the working tree becomes dirty DURING the gate run itself — discards the result, writes NO row", () => {
  writePackageJsonWithGateScript("echo dirty > mid-run-dirty.txt && exit 0");
  commitAll("add gate script that dirties the tree while running");

  const result = runAndRecordHostVerification(projectDir, "FG-640");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /changed during the gate run/, "reason must explain the discarded unstable result");
  assert.equal(
    queryHostVerificationRowsForGate("FG-640", projectDir, "npm run test:all").length,
    0,
    "a gate result observed against a tree that changed mid-run must never be recorded"
  );
});

test("runAndRecordHostVerification: TOCTOU — HEAD moves DURING the gate run itself — discards the result, writes NO row", () => {
  writePackageJsonWithGateScript('git commit --allow-empty -m "sneaky-commit-during-gate" && exit 0');
  commitAll("add gate script that advances HEAD while running");

  const result = runAndRecordHostVerification(projectDir, "FG-641");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /changed during the gate run/, "reason must explain the discarded unstable result");
  assert.equal(
    queryHostVerificationRowsForGate("FG-641", projectDir, "npm run test:all").length,
    0,
    "a gate result observed against a HEAD that moved mid-run must never be recorded against the stale pre-run sha"
  );
});

// ── FG-474: evidence-reuse consult (findCoveringGateEvidence) ──────────────────
//
// One canonical deterministic gate per commit: runAndRecordHostVerification
// consults covering evidence BEFORE executing anything. The gate script below
// writes a marker file when it actually runs, so "the gate must never have
// executed" is a real, observable assertion — not just an inference from the
// returned status.

function markerPath(): string {
  return join(markerDir, "executed.marker");
}

// Quoted so a marker path is safe even if the platform tmpdir ever contains a
// space; the marker lives outside projectDir (see beforeEach).
function execMarkerScript(): string {
  return `touch "${markerPath()}" && exit 0`;
}

test("runAndRecordHostVerification: reuse — an existing PASSING host_verifications row at HEAD's exact sha+command short-circuits: no exec, no duplicate row", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  const commit = commitAll("add gate script with exec marker");

  insertHostVerification({
    ticketId: "FG-700",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = runAndRecordHostVerification(projectDir, "FG-700");
  assert.equal(result.status, "reused");
  assert.equal((result as { commitSha: string }).commitSha, commit);
  assert.ok((result as { coveringRowId: number }).coveringRowId > 0);
  assert.equal(existsSync(markerPath()), false, "the gate script must never have executed — evidence was reused");

  const rows = queryHostVerificationRowsForGate("FG-700", projectDir, "npm run test:all");
  assert.equal(rows.length, 1, "no duplicate row written on reuse");
});

test("runAndRecordHostVerification: CI reuse — a stubbed green required CI check at HEAD's exact sha records a source='ci' row, skips exec", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  writeMatchingCiWorkflow("npm run test:all");
  const commit = commitAll("add gate script with exec marker (CI reuse case)");

  const stub = (opts: { projectDir: string; sha: string; checkContext: string }): CiCheckStatus | null =>
    opts.sha === commit
      ? { sha: commit, state: "success", detailsUrl: "https://github.com/acme/forge/actions/runs/42" }
      : null;

  const result = runAndRecordHostVerification(projectDir, "FG-701", { checkStatusProvider: stub });
  assert.equal(result.status, "recorded");
  assert.equal((result as { source: string }).source, "ci");
  assert.equal((result as { commitSha: string }).commitSha, commit);
  assert.equal((result as { ciUrl?: string }).ciUrl, "https://github.com/acme/forge/actions/runs/42");
  assert.equal(existsSync(markerPath()), false, "the gate script must never have executed — CI evidence was reused");

  const rows = queryHostVerificationRowsForGate("FG-701", projectDir, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "ci");
  assert.equal(rows[0]!.ciUrl, "https://github.com/acme/forge/actions/runs/42");
  assert.equal(rows[0]!.exitCode, 0);
  assert.equal(rows[0]!.commitSha, commit);
});

test("runAndRecordHostVerification: a row at a DIFFERENT sha does not satisfy — falls back to a real exec", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  const commit = commitAll("add gate script (different-sha negative)");

  insertHostVerification({
    ticketId: "FG-702", projectDir, commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = runAndRecordHostVerification(projectDir, "FG-702", { checkStatusProvider: () => null });
  assert.equal(result.status, "recorded");
  assert.equal((result as { source: string }).source, "host");
  assert.equal((result as { commitSha: string }).commitSha, commit);
  assert.equal(existsSync(markerPath()), true, "no covering evidence for this exact sha — the gate must actually run");
});

test("runAndRecordHostVerification: a row for a DIFFERENT command does not satisfy — falls back to a real exec", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  const commit = commitAll("add gate script (different-command negative)");

  insertHostVerification({
    ticketId: "FG-703", projectDir, commitSha: commit,
    gateName: "npm run test", command: "npm run test", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = runAndRecordHostVerification(projectDir, "FG-703", { checkStatusProvider: () => null });
  assert.equal(result.status, "recorded");
  assert.equal((result as { commitSha: string }).commitSha, commit);
  assert.equal(existsSync(markerPath()), true, "a row for a lesser/different command must not satisfy the required gate — the gate must actually run");
});

test("runAndRecordHostVerification: a FAILING covering row at the exact sha+command does not satisfy — falls back to a real exec", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  const commit = commitAll("add gate script (failing-row negative)");

  insertHostVerification({
    ticketId: "FG-704", projectDir, commitSha: commit,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 1, recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = runAndRecordHostVerification(projectDir, "FG-704", { checkStatusProvider: () => null });
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 0, "the fresh real exec passed — a stale failing row must not block a real re-run");
  assert.equal(existsSync(markerPath()), true, "a failing covering row must not satisfy the lookup — the gate must actually run");

  const rows = queryHostVerificationRowsForGate("FG-704", projectDir, "npm run test:all");
  assert.equal(rows.length, 2, "the stale failing row AND the fresh passing row both persist (passing-row model)");
});

test("runAndRecordHostVerification: a PENDING CI check does not satisfy — falls back to a real exec", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  writeMatchingCiWorkflow("npm run test:all");
  const commit = commitAll("add gate script (CI pending negative)");

  const result = runAndRecordHostVerification(projectDir, "FG-705", {
    checkStatusProvider: () => ({ sha: commit, state: "pending" }),
  });
  assert.equal(result.status, "recorded");
  assert.equal((result as { source: string }).source, "host");
  assert.equal(existsSync(markerPath()), true, "a pending CI check must not satisfy the lookup — the gate must actually run");
});

test("runAndRecordHostVerification: a FAILED CI check does not satisfy — falls back to a real exec", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  writeMatchingCiWorkflow("npm run test:all");
  commitAll("add gate script (CI failed negative)");

  const result = runAndRecordHostVerification(projectDir, "FG-706", {
    checkStatusProvider: () => ({ sha: headSha(), state: "failure" }),
  });
  assert.equal(result.status, "recorded");
  assert.equal((result as { source: string }).source, "host");
  assert.equal(existsSync(markerPath()), true, "a failed CI check must not satisfy the lookup — the gate must actually run");
});

test("runAndRecordHostVerification: a green CI check for a DIFFERENT sha does not satisfy — falls back to a real exec (spoof/staleness guard)", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  writeMatchingCiWorkflow("npm run test:all");
  commitAll("add gate script (CI different-sha negative)");

  const result = runAndRecordHostVerification(projectDir, "FG-707", {
    checkStatusProvider: () => ({ sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", state: "success" }),
  });
  assert.equal(result.status, "recorded");
  assert.equal((result as { source: string }).source, "host");
  assert.equal(existsSync(markerPath()), true, "a green CI check reported for a DIFFERENT sha must never satisfy the requested sha — the gate must actually run");
});

test("runAndRecordHostVerification: FG-474 red re-check (task-red-wide-16933b) — a green required CI check at the exact sha, but THIS projectDir's own ci.yml runs a DIFFERENT command — falls back to a real exec, provider never consulted", () => {
  writePackageJsonWithGateScript(execMarkerScript());
  writeMatchingCiWorkflow("npm run something-else");
  const commit = commitAll("add gate script (ci.yml pairing mismatch negative)");

  let providerCalled = false;
  const result = runAndRecordHostVerification(projectDir, "FG-714", {
    checkStatusProvider: () => {
      providerCalled = true;
      return { sha: commit, state: "success", detailsUrl: "https://github.com/acme/forge/actions/runs/1" };
    },
  });
  assert.equal(providerCalled, false, "the pairing check runs BEFORE the provider — a project whose ci.yml never ran opts.command must never even consult it");
  assert.equal(result.status, "recorded");
  assert.equal((result as { source: string }).source, "host", "must never be labeled 'ci' — THIS project's ci.yml never ran the required command");
  assert.equal(existsSync(markerPath()), true, "no covering evidence — the gate must actually run");

  const rows = queryHostVerificationRowsForGate("FG-714", projectDir, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "host");
  assert.equal(rows[0]!.ciUrl, null);
});

test("runAndRecordHostVerification: FG-474 red-review fix — a configured requiredHostGate OTHER than REQUIRED_CI_GATE_COMMAND is never covered by a green required CI check, even at the exact HEAD sha — the gate actually executes", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ requiredHostGate: "npm run verify" }));
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.0.0", scripts: { verify: execMarkerScript() } }, null, 2)
  );
  const commit = commitAll("add verify gate script with exec marker (custom-gate CI-spoof negative)");

  const result = runAndRecordHostVerification(projectDir, "FG-712", {
    checkStatusProvider: () => ({ sha: commit, state: "success", detailsUrl: "https://github.com/acme/forge/actions/runs/999" }),
  });

  assert.equal(result.status, "recorded", "no covering evidence for the configured gate — the real gate must run");
  assert.equal((result as { source: string }).source, "host", "must never be labeled 'ci' — CI never ran the configured 'npm run verify' command");
  assert.equal((result as { commitSha: string }).commitSha, commit);
  assert.equal(existsSync(markerPath()), true, "a green CI check for an uncovered command must never short-circuit exec — the gate must actually run");

  const rows = queryHostVerificationRowsForGate("FG-712", projectDir, "npm run verify");
  assert.equal(rows.length, 1, "no CI-sourced row must have been written in addition to the real host row");
  assert.equal(rows[0]!.source, "host");
  assert.equal(rows[0]!.ciUrl, null, "a real host row must never carry a ci_url");
  assert.equal(rows[0]!.exitCode, 0, "the real exec's actual exit code");
});

// ── FG-500: real-exec fallback runs+records EVERY member of the derived gate
// list (fast tier + test:extended, when the project's package.json defines
// it), fail-closed on the first failing member — a failing extended run
// blocks exactly like a failing fast run.

function writePackageJsonWithGateScripts(testAllBody: string, testExtendedBody: string): void {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      { name: "synthetic", version: "0.0.0", scripts: { "test:all": testAllBody, "test:extended": testExtendedBody } },
      null,
      2
    )
  );
}

test("runAndRecordHostVerification FG-500: a project with test:extended runs+records BOTH gates on real exec — both passing", () => {
  writePackageJsonWithGateScripts("exit 0", "exit 0");
  const commit = commitAll("add passing fast+extended gate scripts");

  const result = runAndRecordHostVerification(projectDir, "FG-500-BOTH-PASS");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.equal((result as { commitSha: string }).commitSha, commit);

  const fastRows = queryHostVerificationRowsForGate("FG-500-BOTH-PASS", projectDir, "npm run test:all");
  const extendedRows = queryHostVerificationRowsForGate("FG-500-BOTH-PASS", projectDir, "npm run test:extended");
  assert.equal(fastRows.length, 1, "the fast gate must be run and recorded under its own command");
  assert.equal(fastRows[0]!.exitCode, 0);
  assert.equal(extendedRows.length, 1, "the extended gate must ALSO be run and recorded under its own command");
  assert.equal(extendedRows[0]!.exitCode, 0);
  assert.equal(extendedRows[0]!.commitSha, commit);
});

test("runAndRecordHostVerification FG-500: a failing extended run blocks exactly like a failing fast run — the fast pass is still recorded, the extended failure is recorded, exec stops there", () => {
  writePackageJsonWithGateScripts("exit 0", "exit 3");
  const commit = commitAll("add passing fast + failing extended gate scripts");

  const result = runAndRecordHostVerification(projectDir, "FG-500-EXT-FAIL");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 3, "the overall recorded result reflects the extended failure — it blocks like a failing fast run");
  assert.equal((result as { commitSha: string }).commitSha, commit);

  const fastRows = queryHostVerificationRowsForGate("FG-500-EXT-FAIL", projectDir, "npm run test:all");
  const extendedRows = queryHostVerificationRowsForGate("FG-500-EXT-FAIL", projectDir, "npm run test:extended");
  assert.equal(fastRows.length, 1, "the fast gate still ran (it's earlier in the list) and its real passing result is recorded");
  assert.equal(fastRows[0]!.exitCode, 0);
  assert.equal(extendedRows.length, 1);
  assert.equal(extendedRows[0]!.exitCode, 3, "the extended gate's real failing exit code, never fabricated");
});

test("runAndRecordHostVerification FG-500: a failing FAST run never even attempts the extended gate — fail-closed on first failure", () => {
  writePackageJsonWithGateScripts("exit 1", "exit 0");
  commitAll("add failing fast + passing extended gate scripts");

  const result = runAndRecordHostVerification(projectDir, "FG-500-FAST-FAIL");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 1);

  const fastRows = queryHostVerificationRowsForGate("FG-500-FAST-FAIL", projectDir, "npm run test:all");
  const extendedRows = queryHostVerificationRowsForGate("FG-500-FAST-FAIL", projectDir, "npm run test:extended");
  assert.equal(fastRows.length, 1);
  assert.equal(fastRows[0]!.exitCode, 1);
  assert.equal(extendedRows.length, 0, "the extended gate must never run once the fast gate has already failed");
});

test("runAndRecordHostVerification FG-500: reuse requires BOTH gates already covering the exact sha — a fast-only passing row does not short-circuit, the extended gate still actually runs", () => {
  writePackageJsonWithGateScripts(execMarkerScript(), "exit 0");
  const commit = commitAll("add fast gate script with exec marker + extended gate script");

  insertHostVerification({
    ticketId: "FG-500-PARTIAL-REUSE", projectDir, commitSha: commit,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = runAndRecordHostVerification(projectDir, "FG-500-PARTIAL-REUSE");
  assert.equal(result.status, "recorded", "not a full-list reuse — the fast-only row does not cover the derived list");
  assert.equal(existsSync(markerPath()), true, "the fast gate must actually run (a fast-only prior row is insufficient coverage)");

  const extendedRows = queryHostVerificationRowsForGate("FG-500-PARTIAL-REUSE", projectDir, "npm run test:extended");
  assert.equal(extendedRows.length, 1, "the extended gate must be run and recorded too");
  assert.equal(extendedRows[0]!.exitCode, 0);
});

test("runAndRecordHostVerification FG-500 regression: NO test:extended script in package.json -> single-gate behavior unchanged (only the configured gate runs/records)", () => {
  writePackageJsonWithGateScript("exit 0");
  const commit = commitAll("add passing gate script (no test:extended)");

  const result = runAndRecordHostVerification(projectDir, "FG-500-REGRESSION-SINGLE");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.equal((result as { commitSha: string }).commitSha, commit);

  const fastRows = queryHostVerificationRowsForGate("FG-500-REGRESSION-SINGLE", projectDir, "npm run test:all");
  const extendedRows = queryHostVerificationRowsForGate("FG-500-REGRESSION-SINGLE", projectDir, "npm run test:extended");
  assert.equal(fastRows.length, 1);
  assert.equal(extendedRows.length, 0, "no test:extended script exists — the derived list must stay single-gate, no phantom row written");
});

test("runAndRecordHostVerification FG-500 regression: a CUSTOM requiredHostGate is never expanded, even when test:extended exists in package.json", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ requiredHostGate: "npm run verify" }));
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      { name: "synthetic", version: "0.0.0", scripts: { verify: "exit 0", "test:extended": "exit 0" } },
      null,
      2
    )
  );
  const commit = commitAll("add verify gate script + an (irrelevant) test:extended script");

  const result = runAndRecordHostVerification(projectDir, "FG-500-REGRESSION-CUSTOM");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.equal((result as { commitSha: string }).commitSha, commit);

  const verifyRows = queryHostVerificationRowsForGate("FG-500-REGRESSION-CUSTOM", projectDir, "npm run verify");
  const extendedRows = queryHostVerificationRowsForGate("FG-500-REGRESSION-CUSTOM", projectDir, "npm run test:extended");
  assert.equal(verifyRows.length, 1);
  assert.equal(extendedRows.length, 0, "a custom requiredHostGate must never pull in test:extended, even though the script exists");
});
