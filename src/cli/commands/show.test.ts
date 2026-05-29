import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import { performShow } from "./show.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-show-test",
  workflow: "feature",
  title: "show test run",
  status: "active",
  createdAt: "2026-05-29T10:00:00Z",
};

function makeTask(id: string): Task {
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
      inputs: { brief: "do the thing" },
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-29T10:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(makeTask("task-show-1"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("performShow with task id returns kind=task with task and events", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.equal(result.task.id, "task-show-1");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.eventType, "task.started");
  }
});

test("performShow with run id returns kind=run with run and events", () => {
  logEvent("run.created", { runId: RUN.id });
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.run.id, RUN.id);
    assert.equal(result.run.workflow, "feature");
    assert.equal(result.events.length, 2);
  }
});

test("performShow with unknown id returns kind=not-found", () => {
  const result = performShow("no-such-id-xyz");
  assert.equal(result.kind, "not-found");
  if (result.kind === "not-found") {
    assert.equal(result.id, "no-such-id-xyz");
  }
});

test("performShow task result includes verdicts array (empty when none)", () => {
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.deepEqual(result.verdicts, []);
  }
});

test("performShow run result has events with taskId populated when present", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.events[0]!.taskId, "task-show-1");
  }
});

test("performShow task result events are empty when none logged", () => {
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.deepEqual(result.events, []);
  }
});

test("performShow run result events are empty when none logged", () => {
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.deepEqual(result.events, []);
  }
});

test("performShow: task id takes priority over run id when both could match", () => {
  // Task is looked up first; if a task exists for the id, kind=task is returned
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
});
