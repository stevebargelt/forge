import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, eventsForRun, logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { reconcileRun } from "./reconcile.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = { id: "run-rec", workflow: "invoke", title: "rec", status: "active", createdAt: "2026-05-30T00:00:00Z" };

function mkTask(id: string, o: Partial<Task> = {}): Task {
  return { id, runId: o.runId ?? RUN.id, phase: "task", agentRole: "engineer", status: o.status ?? "running",
    taskPackage: { taskId: id, runId: o.runId ?? RUN.id, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z", startedAt: "2026-05-30T00:00:01Z", ...o };
}
// Insert a CONTAINERIZED task (emits container.started — the signal reconcile
// gates on). Most agent tasks; not session/manual tasks.
function insertContainerized(t: Task) {
  insertTask(t);
  logEvent("container.started", { runId: t.runId, taskId: t.id, payload: { containerName: `forge-${t.id}` } });
}
const ALIVE = () => true;
const GONE = () => false;

beforeEach(() => { db = makeInMemoryDb(); prev = setDbForTest(db); insertRun(RUN); });
afterEach(() => { setDbForTest(prev as DatabaseInstance); db.close(); });

test("reconcile: container still running → task untouched", () => {
  insertContainerized(mkTask("t-live", { status: "running" }));
  const r = reconcileRun(RUN.id, ALIVE);
  assert.equal(r.taskChanges.length, 0);
  assert.equal(getTask("t-live")!.status, "running");
});

test("reconcile: container gone, NO result → task failed with failure_kind=orphaned + reconciled event", () => {
  insertContainerized(mkTask("t-orphan", { status: "running" }));
  const r = reconcileRun(RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId: "t-orphan", from: "running", to: "failed", reason: "container_gone_no_result" }]);
  assert.equal(getTask("t-orphan")!.status, "failed");
  const types = eventsForTask("t-orphan").map((e) => e.eventType);
  assert.ok(types.includes("task.failed"), "emits the normal terminal event");
  assert.ok(types.includes("task.reconciled"), "emits the reconciliation audit event");
  const failed = eventsForTask("t-orphan").find((e) => e.eventType === "task.failed")!;
  assert.equal((failed.payload as Record<string, unknown>).failure_kind, "orphaned");
});

test("reconcile: container gone WITH a valid result → finalized as complete (lost DB write recovered)", () => {
  insertContainerized(mkTask("t-result", { status: "running" }));
  const dir = taskDir(RUN.id, "t-result");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "done" }));
  const r = reconcileRun(RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId: "t-result", from: "running", to: "complete", reason: "container_gone_result_present" }]);
  const t = getTask("t-result")!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { status: "complete", output: "done" });
  const types = eventsForTask("t-result").map((e) => e.eventType);
  assert.ok(types.includes("task.completed") && types.includes("task.reconciled"));
});

test("reconcile: a host-side session task (no container.started) is NEVER reconciled (regression)", () => {
  // forge design / orchestrator session tasks run host-side, not in a container.
  // docker inspect would say "gone" — but they must NOT be orphaned. The guard is
  // the absence of a container.started event. (Caught live on the real DB.)
  insertTask(mkTask("task-session-x", { status: "running", phase: "session", agentRole: "orchestrator" }));
  const r = reconcileRun(RUN.id, GONE); // GONE = docker says no such container
  assert.equal(r.taskChanges.length, 0, "no container.started → not reconcilable");
  assert.equal(getTask("task-session-x")!.status, "running", "session task stays running");
});

test("reconcile: active invoke run with no live work → run completed + run.reconciled event", () => {
  insertTask(mkTask("t-done", { status: "complete" }));
  const r = reconcileRun(RUN.id, ALIVE);
  assert.ok(r.runChange, "run should be reconciled");
  assert.equal(r.runChange!.to, "complete");
  assert.equal(getRun(RUN.id)!.status, "complete");
  assert.ok(eventsForRun(RUN.id).some((e) => e.eventType === "run.reconciled"));
});

test("reconcile: orphaned last task ALSO completes the invoke run (chained)", () => {
  insertContainerized(mkTask("t-only", { status: "running" }));
  const r = reconcileRun(RUN.id, GONE);
  assert.equal(getTask("t-only")!.status, "failed");
  assert.equal(getRun(RUN.id)!.status, "complete", "run with all-terminal tasks completes");
  assert.ok(r.runChange);
});

test("reconcile: does NOT complete a multi-step pipeline run (only invoke runs)", () => {
  insertRun({ id: "run-pipe", workflow: "feature", title: "pipe", status: "active", createdAt: "2026-05-30T00:00:00Z" });
  insertTask(mkTask("p1", { runId: "run-pipe", status: "complete" }));
  const r = reconcileRun("run-pipe", ALIVE);
  assert.equal(r.runChange, undefined, "pipeline run-completion is left to forge next (has the workflow)");
  assert.equal(getRun("run-pipe")!.status, "active");
});

test("reconcile: idempotent — a second pass changes nothing and emits no new events", () => {
  insertContainerized(mkTask("t-i", { status: "running" }));
  reconcileRun(RUN.id, GONE);
  const eventsAfterFirst = eventsForRun(RUN.id).length;
  const r2 = reconcileRun(RUN.id, GONE);
  assert.equal(r2.taskChanges.length, 0, "nothing to change on the second pass");
  assert.equal(r2.runChange, undefined);
  assert.equal(eventsForRun(RUN.id).length, eventsAfterFirst, "no duplicate events");
});
