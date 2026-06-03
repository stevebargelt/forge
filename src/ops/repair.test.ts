import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
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
