import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../../store/db.js";
import { insertRun, getRun } from "../../store/runs.js";
import { insertTask, getTask } from "../../store/tasks.js";
import { performCancel } from "./cancel.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-cancel-test",
  workflow: "feature",
  title: "cancel test",
  status: "active",
  createdAt: "2026-05-29T00:00:00Z",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? "task-cancel-1";
  const runId = overrides.runId ?? RUN.id;
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
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// (1) killContainer called with the correct forge-<taskId> name
test("cancel task: killContainer called with forge-<taskId>", () => {
  insertTask(makeTask({ id: "task-abc", status: "running" }));
  const killed: string[] = [];
  performCancel("task-abc", {}, (name) => killed.push(name));
  assert.deepEqual(killed, ["forge-task-abc"]);
});

// (2) non-terminal task -> failed
test("cancel task: non-terminal task marked failed with correct error message", () => {
  insertTask(makeTask({ id: "task-running", status: "running" }));
  performCancel("task-running", {});
  const t = getTask("task-running")!;
  assert.equal(t.status, "failed");
  assert.equal(t.error, "cancelled via forge cancel");
});

// (3) run -> abandoned when all its tasks are terminal
test("cancel task: run marked abandoned when no non-terminal tasks remain", () => {
  insertTask(makeTask({ id: "task-only", status: "running" }));
  performCancel("task-only", {});
  assert.equal(getRun(RUN.id)!.status, "abandoned");
});

test("cancel task: run NOT abandoned when other non-terminal tasks remain", () => {
  insertTask(makeTask({ id: "task-t1", status: "running" }));
  insertTask(makeTask({ id: "task-t2", status: "running" }));
  performCancel("task-t1", {});
  assert.equal(getRun(RUN.id)!.status, "active");
});

// (4) already-terminal task left untouched
test("cancel task: already-terminal task left untouched", () => {
  insertTask(makeTask({ id: "task-done", status: "complete" }));
  const killed: string[] = [];
  const outcome = performCancel("task-done", {}, (name) => killed.push(name));
  assert.equal(outcome.kind, "task-terminal");
  assert.equal(killed.length, 0);
  assert.equal(getTask("task-done")!.status, "complete");
});

test("cancel task: failed task is already terminal, left untouched", () => {
  insertTask(makeTask({ id: "task-failed", status: "failed" }));
  const outcome = performCancel("task-failed", {});
  assert.equal(outcome.kind, "task-terminal");
  assert.equal(getTask("task-failed")!.status, "failed");
});

// (5) unknown id errors cleanly
test("cancel: unknown id returns kind unknown", () => {
  const outcome = performCancel("no-such-id-xyz", {});
  assert.equal(outcome.kind, "unknown");
  if (outcome.kind === "unknown") {
    assert.equal(outcome.id, "no-such-id-xyz");
  }
});

// (6) --dry-run writes nothing and issues no kill
test("cancel task: --dry-run issues no kill and writes nothing", () => {
  insertTask(makeTask({ id: "task-dry", status: "running" }));
  const killed: string[] = [];
  const outcome = performCancel("task-dry", { dryRun: true }, (name) => killed.push(name));
  assert.equal(killed.length, 0);
  assert.equal(getTask("task-dry")!.status, "running");
  assert.equal(getRun(RUN.id)!.status, "active");
  assert.equal(outcome.kind, "task-cancelled");
  if (outcome.kind === "task-cancelled") {
    assert.equal(outcome.killed, false);
    assert.equal(outcome.runAbandoned, true); // would abandon since only task
  }
});

test("cancel run: kills all non-terminal tasks and marks run abandoned", () => {
  insertTask(makeTask({ id: "task-r1", status: "running" }));
  insertTask(makeTask({ id: "task-r2", status: "pending" }));
  insertTask(makeTask({ id: "task-r3", status: "complete" }));
  const killed: string[] = [];
  const outcome = performCancel(RUN.id, {}, (name) => killed.push(name));
  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.deepEqual(outcome.tasksKilled.sort(), ["task-r1", "task-r2"]);
  }
  assert.deepEqual(killed.sort(), ["forge-task-r1", "forge-task-r2"]);
  assert.equal(getTask("task-r1")!.status, "failed");
  assert.equal(getTask("task-r2")!.status, "failed");
  assert.equal(getTask("task-r3")!.status, "complete");
  assert.equal(getRun(RUN.id)!.status, "abandoned");
});

test("cancel run: --dry-run issues no kills and writes nothing", () => {
  insertTask(makeTask({ id: "task-dr1", status: "running" }));
  const killed: string[] = [];
  performCancel(RUN.id, { dryRun: true }, (name) => killed.push(name));
  assert.equal(killed.length, 0);
  assert.equal(getTask("task-dr1")!.status, "running");
  assert.equal(getRun(RUN.id)!.status, "active");
});

// Finding 2: cancelling already-terminal run is a no-op
test("cancel run: complete run returns run-terminal and is NOT flipped to abandoned", () => {
  const completeRun: Run = { ...RUN, id: "run-complete", status: "complete" };
  insertRun(completeRun);
  const outcome = performCancel("run-complete", {});
  assert.equal(outcome.kind, "run-terminal");
  if (outcome.kind === "run-terminal") {
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.runId, "run-complete");
  }
  assert.equal(getRun("run-complete")!.status, "complete");
});

test("cancel run: abandoned run returns run-terminal", () => {
  const abandonedRun: Run = { ...RUN, id: "run-abandoned", status: "abandoned" };
  insertRun(abandonedRun);
  const outcome = performCancel("run-abandoned", {});
  assert.equal(outcome.kind, "run-terminal");
  if (outcome.kind === "run-terminal") {
    assert.equal(outcome.status, "abandoned");
  }
  assert.equal(getRun("run-abandoned")!.status, "abandoned");
});

// Finding 3: --json emits structured error for unknown id
test("cancel: unknown id outcome has correct structure for JSON output", () => {
  const outcome = performCancel("no-such-id-json", { json: true });
  assert.equal(outcome.kind, "unknown");
  if (outcome.kind === "unknown") {
    const jsonPayload = { dryRun: false, error: "unknown id", id: outcome.id, kind: "unknown" };
    assert.equal(jsonPayload.error, "unknown id");
    assert.equal(jsonPayload.kind, "unknown");
    assert.equal(jsonPayload.id, "no-such-id-json");
    assert.equal(jsonPayload.dryRun, false);
  }
});

function getEvents(runId: string): Array<{ event_type: string; task_id: string | null; payload: string | null }> {
  return getDb()
    .prepare(`SELECT event_type, task_id, payload FROM events WHERE run_id = ? ORDER BY created_at`)
    .all(runId) as Array<{ event_type: string; task_id: string | null; payload: string | null }>;
}

// Finding 4: event emission on real cancel
test("cancel task: emits task.cancelled and run.cancelled on real cancel", () => {
  insertTask(makeTask({ id: "task-ev1", status: "running" }));
  performCancel("task-ev1", {});
  const events = getEvents(RUN.id);
  const types = events.map((e) => e.event_type);
  assert.ok(types.includes("task.cancelled"), "should emit task.cancelled");
  assert.ok(types.includes("run.cancelled"), "should emit run.cancelled");
  const taskEvent = events.find((e) => e.event_type === "task.cancelled");
  assert.equal(taskEvent!.task_id, "task-ev1");
  assert.equal(JSON.parse(taskEvent!.payload!).via, "forge cancel");
});

test("cancel task: emits run.abandoned when the run enters abandoned state", () => {
  insertTask(makeTask({ id: "task-ev-abn", status: "running" }));
  performCancel("task-ev-abn", {});
  const events = getEvents(RUN.id);
  const types = events.map((e) => e.event_type);
  assert.ok(types.includes("run.abandoned"), "should emit run.abandoned when run enters abandoned state");
  const abandonedEvent = events.find((e) => e.event_type === "run.abandoned");
  assert.equal(JSON.parse(abandonedEvent!.payload!).via, "forge cancel");
});

test("cancel task: does NOT emit events on dry-run", () => {
  insertTask(makeTask({ id: "task-ev2", status: "running" }));
  performCancel("task-ev2", { dryRun: true });
  const events = getEvents(RUN.id);
  const types = events.map((e) => e.event_type);
  assert.ok(!types.includes("task.cancelled"), "dry-run must not emit task.cancelled");
  assert.ok(!types.includes("run.cancelled"), "dry-run must not emit run.cancelled");
});

test("cancel run: emits task.cancelled per task and run.cancelled on real cancel", () => {
  insertTask(makeTask({ id: "task-rev1", status: "running" }));
  insertTask(makeTask({ id: "task-rev2", status: "pending" }));
  performCancel(RUN.id, {});
  const events = getEvents(RUN.id);
  const taskCancelledEvents = events.filter((e) => e.event_type === "task.cancelled");
  const runCancelledEvents = events.filter((e) => e.event_type === "run.cancelled");
  assert.equal(taskCancelledEvents.length, 2);
  assert.equal(runCancelledEvents.length, 1);
});

test("cancel run: emits run.abandoned when cancelling a run directly", () => {
  insertTask(makeTask({ id: "task-rev-abn", status: "running" }));
  performCancel(RUN.id, {});
  const events = getEvents(RUN.id);
  const abandonedEvents = events.filter((e) => e.event_type === "run.abandoned");
  assert.equal(abandonedEvents.length, 1);
  assert.equal(JSON.parse(abandonedEvents[0]!.payload!).via, "forge cancel");
});

test("cancel run: does NOT emit events on dry-run", () => {
  insertTask(makeTask({ id: "task-rev3", status: "running" }));
  performCancel(RUN.id, { dryRun: true });
  const events = getEvents(RUN.id);
  const types = events.map((e) => e.event_type);
  assert.ok(!types.includes("task.cancelled"), "dry-run must not emit task.cancelled");
  assert.ok(!types.includes("run.cancelled"), "dry-run must not emit run.cancelled");
});
