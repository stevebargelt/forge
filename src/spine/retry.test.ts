// retry: resets a failed task to pending so the next forge next redispatches.
// Scoped to failed status only.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
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
    status: "failed",
    taskPackage: {
      taskId: "t-failed",
      runId: RUN.id,
      phase: "frame-question",
      role: "framer",
      inputs: { question: "test" },
      composedSystemPrompt: "",
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

test("retry: success resets failed task to pending and clears error/startedAt/completedAt/result", async () => {
  insertTask(failedTask());
  const out = await retry("t-failed");
  assert.equal(out.task.status, "pending");
  assert.equal(out.task.error, undefined);
  assert.equal(out.task.startedAt, undefined);
  assert.equal(out.task.completedAt, undefined);
  assert.equal(out.task.result, undefined);
  // Persisted in the DB
  const refreshed = getTask("t-failed")!;
  assert.equal(refreshed.status, "pending");
  assert.equal(refreshed.error, undefined);
});

test("retry: idempotent semantics — retrying a pending task throws (caller should check first)", async () => {
  // The status guard catches the second retry attempt; first one already
  // moved task to pending, so the second sees status=pending and refuses.
  // This is intentional — retry only resets failed tasks; treating
  // already-pending as a noop would mask bugs.
  insertTask(failedTask());
  await retry("t-failed");
  await assert.rejects(retry("t-failed"), /not failed/);
});

test("retry: does not change phase, runId, agentRole, or taskPackage", async () => {
  insertTask(failedTask());
  await retry("t-failed");
  const refreshed = getTask("t-failed")!;
  assert.equal(refreshed.phase, "frame-question");
  assert.equal(refreshed.runId, RUN.id);
  assert.equal(refreshed.agentRole, "framer");
  assert.deepEqual(refreshed.taskPackage.inputs, { question: "test" });
});
