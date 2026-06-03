import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, getRun } from "../../store/runs.js";
import { insertTask, getTask } from "../../store/tasks.js";
import { performCancel } from "./cancel.js";
import { runNext, type DockerExecFn } from "../../v2/runNext.js";
import type { Workflow } from "../../v2/schema.js";
import type { Run, Task, TaskStatus } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const BASE_RUN: Run = {
  id: "run-cancel-integ",
  workflow: "feature",
  title: "cancel integration tests",
  status: "active",
  createdAt: "2026-05-29T00:00:00Z",
};

// Used by the resurrection-prevention test (Finding 1).
const TWO_STEP_WORKFLOW: Workflow = {
  name: "cancel-test",
  description: "two-step workflow for resurrection-prevention test",
  inputs: [],
  steps: [
    { id: "step-one", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "step-two", agent: "engineer", gate: "auto", manual: false, depends_on: ["step-one"], runtime: "claude", reds: [] },
  ],
};

function makeTask(id: string, overrides: Partial<Omit<Task, "id" | "taskPackage">> = {}): Task {
  const runId = overrides.runId ?? BASE_RUN.id;
  return {
    id,
    runId,
    phase: overrides.phase ?? "engineer",
    agentRole: overrides.agentRole ?? "engineer",
    status: overrides.status ?? "running",
    taskPackage: {
      taskId: id,
      runId,
      phase: overrides.phase ?? "engineer",
      role: overrides.agentRole ?? "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-05-29T00:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(BASE_RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── 1. Task-id form ────────────────────────────────────────────────────────

test("integ cancel: task-id form marks task failed and abandons run (sole non-terminal)", () => {
  insertTask(makeTask("t-solo-run", { status: "running" }));

  const killed: string[] = [];
  const outcome = performCancel("t-solo-run", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-cancelled");
  if (outcome.kind === "task-cancelled") {
    assert.equal(outcome.taskId, "t-solo-run");
    assert.equal(outcome.runId, BASE_RUN.id);
    assert.equal(outcome.killed, true);
    assert.equal(outcome.runAbandoned, true);
  }

  const task = getTask("t-solo-run")!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, "cancelled via forge cancel");
  assert.ok(task.completedAt, "completedAt must be set after cancel");

  const run = getRun(BASE_RUN.id)!;
  assert.equal(run.status, "abandoned");
  assert.ok(run.completedAt, "run.completedAt must be set after abandon");

  assert.deepEqual(killed, ["forge-t-solo-run"]);
});

// ─── 2. Run-id form ─────────────────────────────────────────────────────────

test("integ cancel: run-id form fails all non-terminal tasks and abandons run", () => {
  const nonTerminalStatuses: TaskStatus[] = [
    "running",
    "pending",
    "awaiting_gate",
    "awaiting_human_input",
  ];
  for (const s of nonTerminalStatuses) {
    insertTask(makeTask(`t-multi-${s}`, { status: s }));
  }

  const killed: string[] = [];
  const outcome = performCancel(BASE_RUN.id, {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.equal(outcome.runId, BASE_RUN.id);
    assert.deepEqual(
      [...outcome.tasksKilled].sort(),
      nonTerminalStatuses.map((s) => `t-multi-${s}`).sort(),
    );
  }

  for (const s of nonTerminalStatuses) {
    const t = getTask(`t-multi-${s}`)!;
    assert.equal(t.status, "failed", `original-status '${s}' task must become failed`);
    assert.equal(t.error, "cancelled via forge cancel");
  }
  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned");
  assert.deepEqual(
    killed.sort(),
    nonTerminalStatuses.map((s) => `forge-t-multi-${s}`).sort(),
  );
});

// ─── 3. Orphaned running task (bug #185/#186) ────────────────────────────────
// Real-world case: run active, task stuck 'running', container already gone.
// killFn is best-effort (no-op when container absent) — must not throw.

test("integ cancel: orphaned running task with absent container - noop kill reaps task and run", () => {
  insertTask(makeTask("t-orphan", { status: "running" }));

  let killAttempted = false;
  const noopKill = (name: string): void => {
    killAttempted = true;
    assert.equal(name, "forge-t-orphan");
    // Simulates container already gone — kill is a silent best-effort no-op
  };

  let threw = false;
  let outcome: ReturnType<typeof performCancel> | undefined;
  try {
    outcome = performCancel("t-orphan", {}, noopKill);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "cancel must not throw when container is absent");
  assert.equal(killAttempted, true, "kill must be attempted even if container is gone");
  assert.equal(outcome?.kind, "task-cancelled");
  if (outcome?.kind === "task-cancelled") {
    assert.equal(outcome.runAbandoned, true);
  }

  assert.equal(getTask("t-orphan")!.status, "failed");
  assert.equal(getTask("t-orphan")!.error, "cancelled via forge cancel");
  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned");
});

// ─── 4. Mixed terminal + non-terminal ───────────────────────────────────────

test("integ cancel: mixed-status run leaves terminal tasks untouched, fails non-terminal", () => {
  insertTask(makeTask("t-mix-complete", { status: "complete" }));
  insertTask(makeTask("t-mix-failed", { status: "failed" }));
  insertTask(makeTask("t-mix-running", { status: "running" }));
  insertTask(makeTask("t-mix-pending", { status: "pending" }));

  const killed: string[] = [];
  const outcome = performCancel(BASE_RUN.id, {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.deepEqual(
      [...outcome.tasksKilled].sort(),
      ["t-mix-pending", "t-mix-running"],
    );
  }

  // Terminal tasks remain untouched
  assert.equal(getTask("t-mix-complete")!.status, "complete");
  assert.equal(getTask("t-mix-failed")!.status, "failed");

  // Non-terminal tasks become failed
  assert.equal(getTask("t-mix-running")!.status, "failed");
  assert.equal(getTask("t-mix-pending")!.status, "failed");

  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned");
  assert.deepEqual(killed.sort(), ["forge-t-mix-pending", "forge-t-mix-running"]);
});

// ─── 5. Idempotent re-cancel ─────────────────────────────────────────────────

test("integ cancel: cancelling already-complete task is a clean no-op (task-terminal)", () => {
  insertTask(makeTask("t-idem-complete", { status: "complete" }));
  const killed: string[] = [];
  const outcome = performCancel("t-idem-complete", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-terminal");
  if (outcome.kind === "task-terminal") {
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.taskId, "t-idem-complete");
  }
  assert.equal(killed.length, 0, "no kill for already-terminal task");
  assert.equal(getTask("t-idem-complete")!.status, "complete");
  assert.equal(getRun(BASE_RUN.id)!.status, "active", "run unaffected by no-op cancel");
});

test("integ cancel: cancelling already-failed task is a clean no-op (task-terminal)", () => {
  insertTask(makeTask("t-idem-failed", { status: "failed" }));
  const killed: string[] = [];
  const outcome = performCancel("t-idem-failed", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-terminal");
  if (outcome.kind === "task-terminal") {
    assert.equal(outcome.status, "failed");
  }
  assert.equal(killed.length, 0);
  assert.equal(getTask("t-idem-failed")!.status, "failed");
});

test("integ cancel: cancelling already-abandoned run yields empty kill list, task statuses unchanged", () => {
  const abandonedRun: Run = {
    id: "run-abandoned-integ",
    workflow: "feature",
    title: "already abandoned",
    status: "abandoned",
    createdAt: "2026-05-29T01:00:00Z",
  };
  insertRun(abandonedRun);
  insertTask(makeTask("t-done-a", { runId: "run-abandoned-integ", status: "failed" }));
  insertTask(makeTask("t-done-b", { runId: "run-abandoned-integ", status: "complete" }));

  const killed: string[] = [];
  const outcome = performCancel("run-abandoned-integ", {}, (n) => killed.push(n));

  // Finding 2: history-rewrite guard — already-abandoned run returns run-terminal
  // immediately; status stays 'abandoned' (NOT re-written by a second cancel).
  assert.equal(outcome.kind, "run-terminal");
  if (outcome.kind === "run-terminal") {
    assert.equal(outcome.status, "abandoned");
    assert.equal(outcome.runId, "run-abandoned-integ");
  }
  assert.equal(killed.length, 0);
  assert.equal(getTask("t-done-a")!.status, "failed");
  assert.equal(getTask("t-done-b")!.status, "complete");
});

test("integ cancel: unknown id returns unknown outcome and makes no writes", () => {
  const outcome = performCancel("nonexistent-id-xyz", {});
  assert.equal(outcome.kind, "unknown");
  if (outcome.kind === "unknown") {
    assert.equal(outcome.id, "nonexistent-id-xyz");
  }
  assert.equal(getRun(BASE_RUN.id)!.status, "active");
});

// ─── 6. --dry-run: zero DB writes ────────────────────────────────────────────

test("integ cancel: --dry-run by task-id issues no kill and makes zero DB writes", () => {
  insertTask(makeTask("t-dry-task", { status: "running" }));
  const killed: string[] = [];

  const outcome = performCancel("t-dry-task", { dryRun: true }, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-cancelled");
  if (outcome.kind === "task-cancelled") {
    assert.equal(outcome.killed, false);
    assert.equal(outcome.runAbandoned, true, "reports would-abandon for sole non-terminal task");
  }

  assert.equal(killed.length, 0, "no kill issued in dry-run");
  assert.equal(getTask("t-dry-task")!.status, "running", "task status unchanged after dry-run");
  assert.equal(getRun(BASE_RUN.id)!.status, "active", "run status unchanged after dry-run");
});

test("integ cancel: --dry-run by run-id issues no kills and makes zero DB writes", () => {
  insertTask(makeTask("t-drun-1", { status: "running" }));
  insertTask(makeTask("t-drun-2", { status: "pending" }));
  insertTask(makeTask("t-drun-3", { status: "complete" }));
  const killed: string[] = [];

  const outcome = performCancel(BASE_RUN.id, { dryRun: true }, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.deepEqual(
      [...outcome.tasksKilled].sort(),
      ["t-drun-1", "t-drun-2"].sort(),
      "reports what would be killed without writing",
    );
  }

  assert.equal(killed.length, 0, "no kills issued in dry-run");
  assert.equal(getTask("t-drun-1")!.status, "running", "running task status unchanged");
  assert.equal(getTask("t-drun-2")!.status, "pending", "pending task status unchanged");
  assert.equal(getTask("t-drun-3")!.status, "complete", "complete task status unchanged");
  assert.equal(getRun(BASE_RUN.id)!.status, "active", "run status unchanged after dry-run");
});

// ─── 7. Resurrection prevention (Finding 1) ─────────────────────────────────
// The High finding: forge next was able to resurrect a cancelled run by seeing
// unstarted steps and dispatching them even though the run was abandoned.
// This end-to-end test locks in the fix: runNext must exit early and dispatch
// nothing when the run is not 'active'.

test("integ cancel: cancelled run cannot be resurrected — runNext dispatches nothing and run stays abandoned", async () => {
  // Seed: one task stuck 'running' on step-one; step-two has no task row yet.
  insertTask(makeTask("t-resurrect-running", { status: "running", phase: "step-one" }));

  // Cancel the run. Running task becomes failed, run becomes abandoned.
  const killed: string[] = [];
  performCancel(BASE_RUN.id, {}, (n) => killed.push(n));

  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned");
  assert.equal(getTask("t-resurrect-running")!.status, "failed");

  // A dockerExec that proves no container was spawned. If runNext ever reaches
  // dispatchStep, this throw propagates and the test fails.
  const forbiddenExec: DockerExecFn = async () => {
    throw new Error("runNext must not spawn any container on an abandoned run");
  };

  const result = await runNext({
    runId: BASE_RUN.id,
    workflow: TWO_STEP_WORKFLOW,
    dockerExec: forbiddenExec,
  });

  assert.deepEqual(result.dispatchedSteps, [], "no steps dispatched on an abandoned run");
  assert.deepEqual(result.completedSteps, []);
  assert.deepEqual(result.awaitingGate, []);
  assert.deepEqual(result.failedSteps, []);
  assert.equal(result.runStatus, "abandoned", "run status must stay abandoned after runNext");
  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned", "DB confirms run is still abandoned");
});

// ─── 8. History-rewrite guard (Finding 2) — complete run ─────────────────────
// Cancelling an already-complete run must be a no-op: status must NOT be
// flipped to 'abandoned', no tasks touched, no containers killed.

test("integ cancel: cancelling already-complete run is a no-op (run-terminal, status stays complete)", () => {
  const completeRun: Run = {
    id: "run-complete-integ",
    workflow: "feature",
    title: "already complete",
    status: "complete",
    createdAt: "2026-05-29T02:00:00Z",
    completedAt: "2026-05-29T02:30:00Z",
  };
  insertRun(completeRun);
  insertTask(makeTask("t-comp-task", { runId: "run-complete-integ", status: "complete" }));

  const killed: string[] = [];
  const outcome = performCancel("run-complete-integ", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-terminal");
  if (outcome.kind === "run-terminal") {
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.runId, "run-complete-integ");
  }
  assert.equal(killed.length, 0, "no containers killed for an already-complete run");
  // Status must NOT be flipped to 'abandoned'.
  assert.equal(getRun("run-complete-integ")!.status, "complete", "status must not change from complete");
  assert.equal(getTask("t-comp-task")!.status, "complete");
});

// ─── 9. Event emission (Finding 4) — non-dry-run emits events ────────────────
// A real cancel must write task.cancelled for every failed task and exactly
// one run.cancelled when the run is abandoned.

test("integ cancel: non-dry-run cancel emits task.cancelled per failed task and one run.cancelled", () => {
  insertTask(makeTask("t-evt-running", { status: "running" }));
  insertTask(makeTask("t-evt-pending", { status: "pending" }));
  insertTask(makeTask("t-evt-done", { status: "complete" }));   // terminal — no event expected

  const outcome = performCancel(BASE_RUN.id, {}, () => { /* stub kill — no docker */ });

  assert.equal(outcome.kind, "run-cancelled");

  type EventRow = { event_type: string; task_id: string | null };
  const events = db
    .prepare("SELECT event_type, task_id FROM events WHERE run_id = ? ORDER BY id ASC")
    .all(BASE_RUN.id) as EventRow[];

  const taskCancelledEvents = events.filter((e) => e.event_type === "task.cancelled");
  const runCancelledEvents = events.filter((e) => e.event_type === "run.cancelled");

  assert.equal(taskCancelledEvents.length, 2, "one task.cancelled per non-terminal task");
  assert.deepEqual(
    taskCancelledEvents.map((e) => e.task_id).sort(),
    ["t-evt-pending", "t-evt-running"],
    "task.cancelled events carry correct task IDs",
  );
  assert.equal(runCancelledEvents.length, 1, "exactly one run.cancelled event");
  assert.equal(runCancelledEvents[0]!.task_id, null, "run.cancelled has no task_id");
});

// ─── 10. Event emission (Finding 4) — dry-run emits NO events ────────────────
// A --dry-run cancel must not write any rows to the events table.

test("integ cancel: --dry-run cancel emits no events", () => {
  insertTask(makeTask("t-dryevt-running", { status: "running" }));
  insertTask(makeTask("t-dryevt-pending", { status: "pending" }));

  const outcome = performCancel(BASE_RUN.id, { dryRun: true }, () => { /* stub — not called in dry-run */ });

  assert.equal(outcome.kind, "run-cancelled");

  type EventRow = { event_type: string };
  const events = db
    .prepare("SELECT event_type FROM events WHERE run_id = ?")
    .all(BASE_RUN.id) as EventRow[];

  assert.equal(events.length, 0, "dry-run must write no rows to the events table");
  assert.equal(getRun(BASE_RUN.id)!.status, "active", "dry-run must not change run status");
});

// ─── 7. Advanceable-run guard (#255 follow-up, end-to-end via the REAL default
//        canAdvance: writes a workflow YAML and exercises loadWorkflow +
//        computeReadyQueue + the cancelled-task projection) ─────────────────────

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ADVANCE_WF_NAME = "cancel-advance-test";
const ADVANCE_WF_YAML = `name: ${ADVANCE_WF_NAME}
description: build then verify, for the cancel-advanceability guard
inputs: []
steps:
  - id: build
    agent: engineer
  - id: verify
    agent: test-engineer
    depends_on: [build]
`;

function installAdvanceWorkflow() {
  const dir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ADVANCE_WF_NAME}.yml`), ADVANCE_WF_YAML);
}

test("integ cancel: cancelling an orphan in a COMPLETED phase leaves the run active (verify is ready)", () => {
  installAdvanceWorkflow();
  const run: Run = { id: "run-advance", workflow: ADVANCE_WF_NAME, title: "advance", status: "active", createdAt: "2026-06-03T00:00:00Z" };
  insertRun(run);
  // The forge-site shape: build completed (real primary), plus a stranded orphan
  // pending primary in the same phase. verify hasn't been created yet.
  insertTask(makeTask("build-real", { runId: run.id, phase: "build", status: "complete" }));
  insertTask(makeTask("build-orphan", { runId: run.id, phase: "build", status: "pending", createdAt: "2026-06-03T01:00:00Z" }));

  const outcome = performCancel("build-orphan", {}, () => {}); // REAL default canAdvance

  assert.equal(getTask("build-orphan")!.status, "failed", "orphan is cancelled");
  assert.equal(getRun("run-advance")!.status, "active", "run stays active — verify is ready off the complete build primary");
  if (outcome.kind === "task-cancelled") assert.equal(outcome.runAbandoned, false);
});

test("integ cancel: cancelling the sole running task of a not-yet-advanced phase abandons the run", () => {
  installAdvanceWorkflow();
  const run: Run = { id: "run-advance-2", workflow: ADVANCE_WF_NAME, title: "advance2", status: "active", createdAt: "2026-06-03T00:00:00Z" };
  insertRun(run);
  // build is the only work and it's running — no completed phase, nothing downstream ready.
  insertTask(makeTask("build-running", { runId: run.id, phase: "build", status: "running" }));

  performCancel("build-running", {}, () => {}); // REAL default canAdvance

  assert.equal(getRun("run-advance-2")!.status, "abandoned", "no ready next step ⇒ genuinely dead ⇒ abandon");
});
