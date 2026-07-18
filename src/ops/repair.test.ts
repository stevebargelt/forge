import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { eventsForTask, eventsForRun } from "../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
import type { LivenessState } from "./reconcile-candidate.js";
import { performOpsRepair } from "./repair.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function mkRun(id: string, status: RunStatus): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z" };
}
function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

// ── repairs the orphan shape ─────────────────────────────────────────────────

test("performOpsRepair: marks a genuine orphan failed (orphaned) with audit events; run untouched", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-orphan", "run-term", "pending"));

  const outcome = performOpsRepair("t-orphan");
  assert.equal(outcome.kind, "repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, false);

  // task is now failed
  assert.equal(getTask("t-orphan")!.status, "failed");
  // audit events: task.failed (orphaned) + task.reconciled (retry_orphan_repaired)
  const events = eventsForTask("t-orphan");
  const failed = events.find((e) => e.eventType === "task.failed");
  const reconciled = events.find((e) => e.eventType === "task.reconciled");
  assert.ok(failed, "emits task.failed");
  assert.equal((failed!.payload as { failure_kind?: string }).failure_kind, "orphaned");
  assert.ok(reconciled, "emits task.reconciled");
  assert.equal((reconciled!.payload as { reason?: string }).reason, "retry_orphan_repaired");
  // run status deliberately untouched
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get("run-term") as { status: string };
  assert.equal(runStatus.status, "complete");
});

test("performOpsRepair: treats a FAILED run as terminal — a pending task under it is a genuine orphan (FG-585)", () => {
  insertRun(mkRun("run-failed", "failed"));
  insertTask(mkTask("t-orphan-failed", "run-failed", "pending"));

  const outcome = performOpsRepair("t-orphan-failed");
  assert.equal(outcome.kind, "repaired", "a failed run is terminal, same as complete — the pending task is orphaned");
  assert.equal(getTask("t-orphan-failed")!.status, "failed");
  // run status deliberately untouched — the fix is the task, not the already-terminal run
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get("run-failed") as { status: string };
  assert.equal(runStatus.status, "failed", "failed run is not reconciled/repaired as if it were live");
});

// ── dry-run writes nothing ───────────────────────────────────────────────────

test("performOpsRepair: --dry-run reports the repair but writes nothing", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-orphan", "run-term", "pending"));

  const outcome = performOpsRepair("t-orphan", { dryRun: true });
  assert.equal(outcome.kind, "repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, true);

  assert.equal(getTask("t-orphan")!.status, "pending", "task stays pending");
  assert.equal(eventsForTask("t-orphan").length, 0, "no events written");
});

// ── refuses everything that is not the orphan shape ──────────────────────────

test("performOpsRepair: refuses a running task under a terminal run (not pending)", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-running", "run-term", "running"));
  const outcome = performOpsRepair("t-running");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not pending/);
  assert.equal(getTask("t-running")!.status, "running", "unchanged");
});

test("performOpsRepair: refuses a pending task under an ACTIVE run (not orphaned)", () => {
  insertRun(mkRun("run-live", "active"));
  insertTask(mkTask("t-live", "run-live", "pending"));
  const outcome = performOpsRepair("t-live");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not terminal/);
  assert.equal(getTask("t-live")!.status, "pending", "unchanged");
});

test("performOpsRepair: refuses an already-terminal task", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-done", "run-term", "failed"));
  const outcome = performOpsRepair("t-done");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not pending/);
});

test("performOpsRepair: unknown task id", () => {
  assert.equal(performOpsRepair("nope").kind, "unknown");
});

// ── idempotent ───────────────────────────────────────────────────────────────

test("performOpsRepair: idempotent — repairing twice refuses the second (now failed, not pending)", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-orphan", "run-term", "pending"));

  assert.equal(performOpsRepair("t-orphan").kind, "repaired");
  const second = performOpsRepair("t-orphan");
  assert.equal(second.kind, "refused");
  assert.match((second as { reason: string }).reason, /not pending/);
});

// ── stuck_run repair (FG-414): repair takes a run id, not a task id ─────────

const NEVER_ALIVE = (): LivenessState => "gone";
const ALWAYS_ALIVE = (): LivenessState => "alive";
const ALWAYS_UNKNOWN = (): LivenessState => "unknown";

test("performOpsRepair: transitions a stuck run (active, all tasks terminal, no live container) to abandoned", () => {
  insertRun(mkRun("run-stuck", "active"));
  insertTask(mkTask("t-stuck-1", "run-stuck", "complete"));
  insertTask(mkTask("t-stuck-2", "run-stuck", "failed"));

  const outcome = performOpsRepair("run-stuck", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "run-repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, false);

  assert.equal(getRun("run-stuck")!.status, "abandoned");
  const events = eventsForRun("run-stuck");
  const abandoned = events.find((e) => e.eventType === "run.abandoned");
  const reconciled = events.find((e) => e.eventType === "run.reconciled");
  assert.ok(abandoned, "emits run.abandoned");
  assert.ok(reconciled, "emits run.reconciled");
  assert.equal((reconciled!.payload as { reason?: string }).reason, "stuck_run_repaired");
});

test("performOpsRepair: --dry-run reports the stuck-run repair but writes nothing", () => {
  insertRun(mkRun("run-stuck-dry", "active"));
  insertTask(mkTask("t-stuck-dry", "run-stuck-dry", "failed"));

  const outcome = performOpsRepair("run-stuck-dry", { dryRun: true }, NEVER_ALIVE);
  assert.equal(outcome.kind, "run-repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, true);
  assert.equal(getRun("run-stuck-dry")!.status, "active", "run stays active");
  assert.equal(eventsForRun("run-stuck-dry").length, 0, "no events written");
});

test("performOpsRepair: refuses a run with a non-terminal task (not orphaned)", () => {
  insertRun(mkRun("run-live", "active"));
  insertTask(mkTask("t-live-done", "run-live", "complete"));
  insertTask(mkTask("t-live-pending", "run-live", "pending"));

  const outcome = performOpsRepair("run-live", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /non-terminal task/);
  assert.equal(getRun("run-live")!.status, "active", "unchanged");
});

test("performOpsRepair: refuses a run with a live container even though every task row is terminal", () => {
  insertRun(mkRun("run-live-container", "active"));
  insertTask(mkTask("t-live-container", "run-live-container", "failed"));

  const outcome = performOpsRepair("run-live-container", {}, ALWAYS_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /container.*still alive/);
  assert.equal(getRun("run-live-container")!.status, "active", "unchanged");
});

test("performOpsRepair: refuses a run when container liveness is unknown (probe failure, not coerced to gone)", () => {
  insertRun(mkRun("run-unknown", "active"));
  insertTask(mkTask("t-unknown", "run-unknown", "failed"));

  const outcome = performOpsRepair("run-unknown", {}, ALWAYS_UNKNOWN);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /liveness is unknown/);
  assert.equal(getRun("run-unknown")!.status, "active", "unchanged — a probe failure must not be treated as gone");
});

test("performOpsRepair: refuses a run that is not active (already terminal)", () => {
  insertRun(mkRun("run-already-done", "complete"));
  insertTask(mkTask("t-already-done", "run-already-done", "complete"));

  const outcome = performOpsRepair("run-already-done", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not active/);
});

test("performOpsRepair: refuses a run with no tasks", () => {
  insertRun(mkRun("run-no-tasks", "active"));
  const outcome = performOpsRepair("run-no-tasks", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /no tasks/);
});
