// retry: preserves the failed task as audit record; inserts a new pending
// task that inherits the same phase/role/inputs and points back via parentId.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask, tasksForRun } from "../store/tasks.js";
import { retry } from "./retry.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-retry",
  workflow: "investigation",
  title: "retry test",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
};

function failedTask(): Task {
  return {
    id: "t-failed",
    runId: RUN.id,
    phase: "frame-question",
    agentRole: "framer",
    agentAlias: "spec-writer",
    agentModel: "us.anthropic.claude-sonnet-4-6",
    status: "failed",
    taskPackage: {
      taskId: "t-failed",
      runId: RUN.id,
      phase: "frame-question",
      role: "framer",
      inputs: { question: "test" },
      composedSystemPrompt: "PRE-COMPOSED-PROMPT",
    },
    result: { status: "failed", error: "transient_auth_error" },
    error: "Failed to authenticate. API Error: 403 ...",
    createdAt: "2026-05-08T00:00:00Z",
    startedAt: "2026-05-08T00:00:01Z",
    completedAt: "2026-05-08T00:00:30Z",
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

test("retry: throws when task not found", async () => {
  await assert.rejects(retry("does-not-exist"), /Task not found/);
});

test("retry: throws when task is not in failed status", async () => {
  insertTask({ ...failedTask(), status: "complete" });
  await assert.rejects(retry("t-failed"), /not failed/);
});

test("retry: throws on awaiting_gate", async () => {
  insertTask({ ...failedTask(), status: "awaiting_gate" });
  await assert.rejects(retry("t-failed"), /not failed/);
});

test("retry: original task stays failed (audit record preserved)", async () => {
  insertTask(failedTask());
  await retry("t-failed");
  const original = getTask("t-failed")!;
  assert.equal(original.status, "failed");
  assert.equal(original.error, "Failed to authenticate. API Error: 403 ...");
  assert.deepEqual(original.result, { status: "failed", error: "transient_auth_error" });
  assert.equal(original.startedAt, "2026-05-08T00:00:01Z");
  assert.equal(original.completedAt, "2026-05-08T00:00:30Z");
});

test("retry: creates a new pending task with parentId pointing to the failed one", async () => {
  insertTask(failedTask());
  const out = await retry("t-failed");
  assert.equal(out.newTask.status, "pending");
  assert.equal(out.newTask.parentId, "t-failed");
  assert.notEqual(out.newTask.id, "t-failed");
  // The new task starts fresh — no error, no startedAt, no completedAt, no result.
  assert.equal(out.newTask.error, undefined);
  assert.equal(out.newTask.startedAt, undefined);
  assert.equal(out.newTask.completedAt, undefined);
  assert.equal(out.newTask.result, undefined);
});

test("retry: new task inherits phase, role, agent metadata, and inputs", async () => {
  insertTask(failedTask());
  const out = await retry("t-failed");
  assert.equal(out.newTask.phase, "frame-question");
  assert.equal(out.newTask.runId, RUN.id);
  assert.equal(out.newTask.agentRole, "framer");
  assert.equal(out.newTask.agentAlias, "spec-writer");
  assert.equal(out.newTask.agentModel, "us.anthropic.claude-sonnet-4-6");
  assert.deepEqual(out.newTask.taskPackage.inputs, { question: "test" });
});

test("retry: new task gets a fresh composedSystemPrompt slot (re-composed at dispatch)", async () => {
  insertTask(failedTask());
  const out = await retry("t-failed");
  // The original had a non-empty composedSystemPrompt; the retry should have
  // an empty one so dispatch re-composes against the current workflow + agent
  // state (constraints may have changed since the original spawn).
  assert.equal(out.newTask.taskPackage.composedSystemPrompt, "");
});

test("retry: cascading retries form a walkable chain via parentId", async () => {
  // Original fails. First retry creates A'. A' fails. Second retry creates A''.
  // Chain: A → A' → A''.
  insertTask(failedTask());
  const r1 = await retry("t-failed");
  // Simulate A' failing too — retry() already inserted it as `pending`; flip
  // it to `failed` directly so retry() can run again.
  db.prepare(`UPDATE tasks SET status='failed', error='second failure' WHERE id=?`).run(r1.newTask.id);

  const r2 = await retry(r1.newTask.id);
  assert.equal(r2.newTask.parentId, r1.newTask.id);
  // Walk the chain: r2 → r1 → t-failed
  const r1Refreshed = getTask(r1.newTask.id)!;
  assert.equal(r1Refreshed.parentId, "t-failed");
});

test("retry: all rows persist; tasksForRun returns the chain", async () => {
  insertTask(failedTask());
  await retry("t-failed");
  const all = tasksForRun(RUN.id);
  assert.equal(all.length, 2);
  const failed = all.find((t) => t.status === "failed")!;
  const pending = all.find((t) => t.status === "pending")!;
  assert.equal(failed.id, "t-failed");
  assert.equal(pending.parentId, "t-failed");
});
