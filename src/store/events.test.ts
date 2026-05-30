import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";
import { logEvent, eventsForTask, eventsForRun } from "./events.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-ev-test",
  workflow: "feature",
  title: "events test",
  status: "active",
  createdAt: "2026-05-29T00:00:00Z",
};

function task(id: string): Task {
  return {
    id,
    runId: RUN.id,
    phase: "engineer",
    agentRole: "engineer",
    status: "pending",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: "engineer",
      role: "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-29T00:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(task("task-ev-1"));
  insertTask(task("task-ev-2"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("eventsForTask returns events for that task ordered by created_at ASC, id ASC", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.completed", { runId: RUN.id, taskId: "task-ev-1" });
  const events = eventsForTask("task-ev-1");
  assert.equal(events.length, 2);
  assert.equal(events[0]!.eventType, "task.started");
  assert.equal(events[1]!.eventType, "task.completed");
});

test("eventsForTask filters to only the given task, not other tasks in same run", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-2" });
  const events = eventsForTask("task-ev-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.taskId, "task-ev-1");
});

test("eventsForTask parses payload JSON from string back to object", () => {
  logEvent("task.completed", { runId: RUN.id, taskId: "task-ev-1", payload: { status: "complete", score: 42 } });
  const events = eventsForTask("task-ev-1");
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { status: string; score: number };
  assert.equal(payload.status, "complete");
  assert.equal(payload.score, 42);
});

test("eventsForTask returns null payload when no payload set", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  const events = eventsForTask("task-ev-1");
  assert.equal(events[0]!.payload, null);
});

test("eventsForTask returns [] for unknown taskId", () => {
  assert.deepEqual(eventsForTask("no-such-task"), []);
});

test("eventsForRun returns all events for the run ordered chronologically", () => {
  logEvent("run.created", { runId: RUN.id });
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.completed", { runId: RUN.id, taskId: "task-ev-1" });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 3);
  assert.equal(events[0]!.eventType, "run.created");
  assert.equal(events[1]!.eventType, "task.started");
  assert.equal(events[2]!.eventType, "task.completed");
});

test("eventsForRun filters to only the given run, not other runs", () => {
  const otherRun: Run = { ...RUN, id: "run-other" };
  insertRun(otherRun);
  logEvent("run.created", { runId: RUN.id });
  logEvent("run.created", { runId: "run-other" });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.runId, RUN.id);
});

test("eventsForRun parses payload JSON from string back to object", () => {
  logEvent("run.completed", { runId: RUN.id, payload: { workflow: "feature", tasks: 3 } });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { workflow: string; tasks: number };
  assert.equal(payload.workflow, "feature");
  assert.equal(payload.tasks, 3);
});

test("eventsForRun returns [] for unknown runId", () => {
  assert.deepEqual(eventsForRun("no-such-run"), []);
});

test("eventsForRun includes events with taskId populated when set", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-2" });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 2);
  const taskIds = events.map((e) => e.taskId).sort();
  assert.deepEqual(taskIds, ["task-ev-1", "task-ev-2"]);
});

test("eventsForRun exposes runId on each event row", () => {
  logEvent("run.created", { runId: RUN.id });
  const events = eventsForRun(RUN.id);
  assert.equal(events[0]!.runId, RUN.id);
});

// #194: new event types are accepted by logEvent (runtime guard for union additions)
test("logEvent accepts new #194 event types without throwing", () => {
  logEvent("run.abandoned", { runId: RUN.id, taskId: "task-ev-1", payload: { via: "forge cancel" } });
  logEvent("task.awaiting_gate", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("container.started", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1" } });
  logEvent("container.exited", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1", exitCode: 0 } });
  logEvent("container.idle_timeout", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1", exitCode: 124 } });
  logEvent("container.killed", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1" } });
  logEvent("auth.profile_applied", { runId: RUN.id, taskId: "task-ev-1", payload: { profile: "my-profile" } });
  logEvent("auth.profile_failed", { runId: RUN.id, taskId: "task-ev-1", payload: { profile: "my-profile", reason: "not found" } });

  const events = eventsForTask("task-ev-1");
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("run.abandoned"));
  assert.ok(types.includes("task.awaiting_gate"));
  assert.ok(types.includes("container.started"));
  assert.ok(types.includes("container.exited"));
  assert.ok(types.includes("container.idle_timeout"));
  assert.ok(types.includes("container.killed"));
  assert.ok(types.includes("auth.profile_applied"));
  assert.ok(types.includes("auth.profile_failed"));
});
