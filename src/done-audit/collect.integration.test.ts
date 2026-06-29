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
import { collectDoneAuditInput } from "./collect.js";
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
  gitExec(["init"], projectDir);
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

// ── verification fields: host always null in current scope ────────────────────

test("collect: hostVerified is always null (recorder not implemented in FG-383)", () => {
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

  assert.equal(input.verification.hostVerified, null, "hostVerified must be null — recorder is out of scope for FG-383");
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
    verification: { hostVerified: null, containerTestsRun: 42, acceptedException: null },
  };

  const result = evaluateDoneAudit(auditInput);

  assert.equal(result.outcome, "unknown", "container evidence must not satisfy host_verification");
  const hostCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(hostCheck?.status, "unknown");
  const containerCheck = result.checks.find((c) => c.name === "container_verification");
  assert.equal(containerCheck?.status, "pass", "container_verification check should pass (informational)");
});
