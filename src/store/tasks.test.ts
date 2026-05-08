import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import {
  insertTask,
  getTask,
  markTaskRunning,
  markTaskComplete,
  markTaskFailed,
  setTaskStatus,
  pendingTasksForRun,
  tasksForRunPhase,
} from "./tasks.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-x",
  workflow: "investigation",
  title: "test",
  status: "active",
  createdAt: "2026-05-06T00:00:00Z",
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task-1",
    runId: overrides.runId ?? "run-x",
    parentId: overrides.parentId,
    phase: overrides.phase ?? "frame",
    agentRole: overrides.agentRole ?? "framer",
    agentAlias: overrides.agentAlias,
    agentModel: overrides.agentModel,
    status: overrides.status ?? "pending",
    taskPackage: overrides.taskPackage ?? {
      taskId: overrides.id ?? "task-1",
      runId: overrides.runId ?? "run-x",
      phase: overrides.phase ?? "frame",
      role: overrides.agentRole ?? "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-05-06T00:00:00Z",
    error: overrides.error,
    result: overrides.result,
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

test("insertTask + getTask round-trips", () => {
  insertTask(task({ id: "task-a" }));
  const got = getTask("task-a");
  assert.ok(got);
  assert.equal(got!.id, "task-a");
  assert.equal(got!.status, "pending");
});

test("markTaskRunning sets status, started_at, clears stale error and result", () => {
  insertTask(task({ id: "task-b", status: "pending", error: "old error", result: { stale: true } }));
  markTaskRunning("task-b");
  const t = getTask("task-b")!;
  assert.equal(t.status, "running");
  assert.ok(t.startedAt);
  assert.equal(t.error, undefined);
  assert.equal(t.result, undefined);
});

test("markTaskComplete sets result, completed_at, status, clears error", () => {
  insertTask(task({ id: "task-c", error: "old" }));
  markTaskRunning("task-c");
  markTaskComplete("task-c", { status: "complete", payload: 42 });
  const t = getTask("task-c")!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { status: "complete", payload: 42 });
  assert.ok(t.completedAt);
  assert.equal(t.error, undefined);
});

test("markTaskFailed sets error and status", () => {
  insertTask(task({ id: "task-d" }));
  markTaskFailed("task-d", "container_crash");
  const t = getTask("task-d")!;
  assert.equal(t.status, "failed");
  assert.equal(t.error, "container_crash");
});

test("setTaskStatus moves through state machine: pending → running → awaiting_gate → complete", () => {
  insertTask(task({ id: "task-e" }));
  setTaskStatus("task-e", "running");
  assert.equal(getTask("task-e")!.status, "running");
  setTaskStatus("task-e", "awaiting_gate");
  assert.equal(getTask("task-e")!.status, "awaiting_gate");
  setTaskStatus("task-e", "complete");
  assert.equal(getTask("task-e")!.status, "complete");
});

test("setTaskStatus blocked_by_red transitions correctly", () => {
  insertTask(task({ id: "task-f", status: "running" }));
  setTaskStatus("task-f", "blocked_by_red");
  assert.equal(getTask("task-f")!.status, "blocked_by_red");
});

test("pendingTasksForRun returns only pending rows for the given run", () => {
  insertTask(task({ id: "task-g1", status: "pending" }));
  insertTask(task({ id: "task-g2", status: "running" }));
  insertTask(task({ id: "task-g3", status: "pending" }));
  const pending = pendingTasksForRun(RUN.id);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((t) => t.id).sort(), ["task-g1", "task-g3"]);
});

test("tasksForRunPhase filters by phase", () => {
  insertTask(task({ id: "task-h1", phase: "frame" }));
  insertTask(task({ id: "task-h2", phase: "investigate" }));
  insertTask(task({ id: "task-h3", phase: "frame" }));
  const frameTasks = tasksForRunPhase(RUN.id, "frame");
  assert.equal(frameTasks.length, 2);
});

test("re-running a failed task: markTaskRunning clears error, then markTaskComplete leaves error null", () => {
  // The exact bug Steven hit on the bedrock retry — stale `error` shown after success.
  insertTask(task({ id: "task-retry", status: "failed", error: "first failure" }));
  markTaskRunning("task-retry");
  assert.equal(getTask("task-retry")!.error, undefined);
  markTaskComplete("task-retry", { status: "complete" });
  const t = getTask("task-retry")!;
  assert.equal(t.status, "complete");
  assert.equal(t.error, undefined);
});

// ---------- agent_alias / agent_model (#38) ----------

test("insertTask persists agentAlias + agentModel; getTask returns them", () => {
  insertTask(task({
    id: "task-with-model",
    agentAlias: "spec-writer",
    agentModel: "us.anthropic.claude-sonnet-4-6",
  }));
  const got = getTask("task-with-model");
  assert.equal(got?.agentAlias, "spec-writer");
  assert.equal(got?.agentModel, "us.anthropic.claude-sonnet-4-6");
});

test("insertTask leaves agentAlias + agentModel undefined when not set (legacy compatibility)", () => {
  insertTask(task({ id: "task-no-model" }));
  const got = getTask("task-no-model");
  assert.equal(got?.agentAlias, undefined);
  assert.equal(got?.agentModel, undefined);
});

test("schema migration: legacy tasks table without agent_alias / agent_model gains both columns", async () => {
  const { default: Database } = await import("better-sqlite3");
  const legacy = new Database(":memory:");
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT, title TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_id TEXT,
      phase TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      status TEXT NOT NULL,
      task_package TEXT NOT NULL,
      result TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    );
  `);

  let cols = legacy.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  assert.ok(!cols.some((c) => c.name === "agent_alias"), "legacy schema must not have agent_alias");
  assert.ok(!cols.some((c) => c.name === "agent_model"), "legacy schema must not have agent_model");

  // Apply same migration db.ts runs on open.
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("agent_alias")) legacy.exec(`ALTER TABLE tasks ADD COLUMN agent_alias TEXT`);
  if (!have.has("agent_model")) legacy.exec(`ALTER TABLE tasks ADD COLUMN agent_model TEXT`);

  cols = legacy.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  assert.ok(cols.some((c) => c.name === "agent_alias"));
  assert.ok(cols.some((c) => c.name === "agent_model"));
  legacy.close();
});
