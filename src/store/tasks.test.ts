import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, applyMigrations } from "./db.js";
import { insertRun } from "./runs.js";
import {
  insertTask,
  getTask,
  markTaskRunning,
  markTaskComplete,
  markTaskBlockedByRed,
  markTaskFailed,
  markTaskFailedIfNotTerminal,
  setTaskStatus,
  reopenFailedTaskForRecovery,
  restoreTaskFailed,
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
    resolvedProfile: overrides.resolvedProfile,
    resolvedProvider: overrides.resolvedProvider,
    resolvedAuth: overrides.resolvedAuth,
    resolvedBy: overrides.resolvedBy,
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

test("insertTask round-trips the AWN-7 resolution record", () => {
  insertTask(
    task({
      id: "task-res",
      agentRole: "red-security",
      agentAlias: "review",
      agentModel: "us.anthropic.claude-sonnet-4-6",
      resolvedProfile: "claude-bedrock",
      resolvedProvider: "anthropic",
      resolvedAuth: "bedrock",
      resolvedBy: "overrides.agents.red-security",
    })
  );
  const got = getTask("task-res");
  assert.ok(got);
  assert.equal(got!.resolvedProfile, "claude-bedrock");
  assert.equal(got!.resolvedProvider, "anthropic");
  assert.equal(got!.resolvedAuth, "bedrock");
  assert.equal(got!.resolvedBy, "overrides.agents.red-security");
});

test("insertTask leaves resolution fields undefined in legacy mode", () => {
  insertTask(task({ id: "task-legacy" }));
  const got = getTask("task-legacy");
  assert.ok(got);
  assert.equal(got!.resolvedProfile, undefined);
  assert.equal(got!.resolvedProvider, undefined);
  assert.equal(got!.resolvedAuth, undefined);
  assert.equal(got!.resolvedBy, undefined);
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

// FG-676: the laundering guard, at the writer. A bare UPDATE here moves a terminal
// row off terminal, and markTaskHeldForGate's CAS then passes over it — which is how
// a human's decision gets resurrected to awaiting_gate with its error NULLed. The
// guard has to be structural, or the next caller re-opens the hole.

test("setTaskStatus REFUSES to move a terminal row off terminal — a failed row is not laundered to awaiting_red", () => {
  insertTask(task({ id: "task-term-f", status: "running" }));
  markTaskFailed("task-term-f", "cancelled via forge cancel");

  assert.equal(setTaskStatus("task-term-f", "awaiting_red"), false, "the CAS refuses");
  const t = getTask("task-term-f")!;
  assert.equal(t.status, "failed", "the row stays terminal");
  assert.equal(t.error, "cancelled via forge cancel", "with its error intact");
});

test("setTaskStatus REFUSES to move a complete row off terminal, and reports true when it does move one", () => {
  insertTask(task({ id: "task-term-c", status: "running" }));
  markTaskComplete("task-term-c", { status: "complete" });
  assert.equal(setTaskStatus("task-term-c", "pending"), false);
  assert.equal(getTask("task-term-c")!.status, "complete");

  insertTask(task({ id: "task-live", status: "running" }));
  assert.equal(setTaskStatus("task-live", "awaiting_red"), true, "a non-terminal row still moves");
  assert.equal(getTask("task-live")!.status, "awaiting_red");
});

// FG-676 (AC2): the background-settlement writer. markTaskFailed above is the LANDING
// writer and overwrites deliberately; this one arrives after the fact, so the row a
// human's decision put there has to survive it — error, result and completed_at whole.
test("markTaskFailedIfNotTerminal REFUSES a row a human's decision already made terminal, and never touches its record", () => {
  insertTask(task({ id: "task-settle-cancelled", status: "awaiting_recovery" }));
  markTaskFailed("task-settle-cancelled", "cancelled via forge cancel", { artifact: "the human's" });
  const decided = getTask("task-settle-cancelled")!;

  assert.equal(
    markTaskFailedIfNotTerminal("task-settle-cancelled", "publication attempt was converged to `abandoned`", { other: 1 }),
    false,
    "a background settlement may not move a terminal row",
  );
  const after = getTask("task-settle-cancelled")!;
  assert.equal(after.error, "cancelled via forge cancel", "the human's error is never replaced");
  assert.deepEqual(after.result, decided.result, "nor their result");
  assert.equal(after.completedAt, decided.completedAt, "nor the time they decided");

  insertTask(task({ id: "task-settle-live", status: "awaiting_recovery" }));
  assert.equal(
    markTaskFailedIfNotTerminal("task-settle-live", "publication attempt was converged to `abandoned`"),
    true,
    "a row nobody has decided still settles — the guard must not make failures unfalsifiable",
  );
  assert.equal(getTask("task-settle-live")!.status, "failed");
  assert.equal(getTask("task-settle-live")!.error, "publication attempt was converged to `abandoned`");

  insertTask(task({ id: "task-settle-complete", status: "running" }));
  markTaskComplete("task-settle-complete", { status: "complete" });
  assert.equal(markTaskFailedIfNotTerminal("task-settle-complete", "too late"), false, "and a complete row is terminal too");
  assert.equal(getTask("task-settle-complete")!.status, "complete");
});

test("reopenFailedTaskForRecovery is the ONE deliberate terminal exit — failed only, awaiting_recovery only", () => {
  insertTask(task({ id: "task-reopen", status: "running" }));
  markTaskFailed("task-reopen", "publication window lost");
  assert.equal(reopenFailedTaskForRecovery("task-reopen"), true);
  assert.equal(getTask("task-reopen")!.status, "awaiting_recovery");

  insertTask(task({ id: "task-reopen-c", status: "running" }));
  markTaskComplete("task-reopen-c", { status: "complete" });
  assert.equal(reopenFailedTaskForRecovery("task-reopen-c"), false, "a complete row is not reopenable");
  assert.equal(getTask("task-reopen-c")!.status, "complete");
});

test("restoreTaskFailed reinstates a terminal row only from the status the caller observed", () => {
  insertTask(task({ id: "task-restore", status: "awaiting_gate", result: { a: 1 } }));

  assert.equal(
    restoreTaskFailed("task-restore", {
      error: "request-changes; superseded",
      result: { a: 1 },
      completedAt: "2026-06-02T05:00:29Z",
      expectedStatus: "running",
    }),
    false,
    "a status other than the observed one refuses",
  );
  assert.equal(getTask("task-restore")!.status, "awaiting_gate", "and writes nothing");

  assert.equal(
    restoreTaskFailed("task-restore", {
      error: "request-changes; superseded",
      result: { a: 1 },
      completedAt: "2026-06-02T05:00:29Z",
      expectedStatus: "awaiting_gate",
    }),
    true,
  );
  const t = getTask("task-restore")!;
  assert.equal(t.status, "failed");
  assert.equal(t.error, "request-changes; superseded");
  assert.equal(t.completedAt, "2026-06-02T05:00:29Z", "the time it was given, never nowIso()");
  assert.deepEqual(t.result, { a: 1 });
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

// FG-341: applyMigrations must NOT rename 'frame' → 'frame-question'.
// The investigation workflow (which had that rename) is gone; research-synthesis
// legitimately uses a 'frame' phase. Re-opening the DB (applyMigrations re-runs)
// must leave research-synthesis frame tasks intact.
test("FG-341: applyMigrations does not rename phase 'frame' to 'frame-question'", () => {
  insertTask(task({ id: "task-fg341", phase: "frame" }));
  applyMigrations(db);
  const t = getTask("task-fg341");
  assert.ok(t, "task must still exist after re-migration");
  assert.equal(t!.phase, "frame", "phase must remain 'frame' — not renamed to 'frame-question'");
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

// ---------- markTaskBlockedByRed (FG-482) ----------

test("markTaskBlockedByRed writes status+result together from awaiting_red", () => {
  insertTask(task({ id: "task-bred-1", status: "awaiting_red" }));
  const applied = markTaskBlockedByRed("task-bred-1", { verdict: "fail" });
  assert.equal(applied, true);
  const t = getTask("task-bred-1")!;
  assert.equal(t.status, "blocked_by_red");
  assert.deepEqual(t.result, { verdict: "fail" });
  assert.equal(t.completedAt, undefined);
});

test("markTaskBlockedByRed returns false and leaves the row untouched from a non-awaiting_red status", () => {
  for (const status of ["running", "complete", "failed", "awaiting_gate"] as const) {
    insertTask(task({ id: `task-bred-${status}`, status }));
    const applied = markTaskBlockedByRed(`task-bred-${status}`, { verdict: "fail" });
    assert.equal(applied, false, `expected CAS to fail from status=${status}`);
    const t = getTask(`task-bred-${status}`)!;
    assert.equal(t.status, status, `status must remain ${status}`);
    assert.equal(t.result, undefined, "result must not be written on a failed CAS");
  }
});

test("markTaskBlockedByRed never leaves a row observable as awaiting_gate", () => {
  insertTask(task({ id: "task-bred-2", status: "awaiting_red" }));
  markTaskBlockedByRed("task-bred-2", { verdict: "fail" });
  assert.notEqual(getTask("task-bred-2")!.status, "awaiting_gate");
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
