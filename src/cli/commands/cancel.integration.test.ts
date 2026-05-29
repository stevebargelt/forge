import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, getRun } from "../../store/runs.js";
import { insertTask, getTask } from "../../store/tasks.js";
import { performCancel } from "./cancel.js";
import type { Run, Task, TaskStatus } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const BASE_RUN: Run = {
  id: "run-cancel-integ",
  workflow: "feature",
  title: "cancel integration tests",
  status: "active",
  createdAt: "2026-05-29T00:00:00Z",
};

function makeTask(id: string, overrides: Partial<Omit<Task, "id" | "taskPackage">> = {}): Task {
  const runId = overrides.runId ?? BASE_RUN.id;
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
  insertRun(BASE_RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── 1. Task-id form ────────────────────────────────────────────────────────

test("integ cancel: task-id form marks task failed and abandons run (sole non-terminal)", () => {
  insertTask(makeTask("t-solo-run", { status: "running" }));

  const killed: string[] = [];
  const outcome = performCancel("t-solo-run", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-cancelled");
  if (outcome.kind === "task-cancelled") {
    assert.equal(outcome.taskId, "t-solo-run");
    assert.equal(outcome.runId, BASE_RUN.id);
    assert.equal(outcome.killed, true);
    assert.equal(outcome.runAbandoned, true);
  }

  const task = getTask("t-solo-run")!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, "cancelled via forge cancel");
  assert.ok(task.completedAt, "completedAt must be set after cancel");

  const run = getRun(BASE_RUN.id)!;
  assert.equal(run.status, "abandoned");
  assert.ok(run.completedAt, "run.completedAt must be set after abandon");

  assert.deepEqual(killed, ["forge-t-solo-run"]);
});

// ─── 2. Run-id form ─────────────────────────────────────────────────────────

test("integ cancel: run-id form fails all non-terminal tasks and abandons run", () => {
  const nonTerminalStatuses: TaskStatus[] = [
    "running",
    "pending",
    "awaiting_gate",
    "awaiting_human_input",
  ];
  for (const s of nonTerminalStatuses) {
    insertTask(makeTask(`t-multi-${s}`, { status: s }));
  }

  const killed: string[] = [];
  const outcome = performCancel(BASE_RUN.id, {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.equal(outcome.runId, BASE_RUN.id);
    assert.deepEqual(
      [...outcome.tasksKilled].sort(),
      nonTerminalStatuses.map((s) => `t-multi-${s}`).sort(),
    );
  }

  for (const s of nonTerminalStatuses) {
    const t = getTask(`t-multi-${s}`)!;
    assert.equal(t.status, "failed", `original-status '${s}' task must become failed`);
    assert.equal(t.error, "cancelled via forge cancel");
  }
  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned");
  assert.deepEqual(
    killed.sort(),
    nonTerminalStatuses.map((s) => `forge-t-multi-${s}`).sort(),
  );
});

// ─── 3. Orphaned running task (bug #185/#186) ────────────────────────────────
// Real-world case: run active, task stuck 'running', container already gone.
// killFn is best-effort (no-op when container absent) — must not throw.

test("integ cancel: orphaned running task with absent container - noop kill reaps task and run", () => {
  insertTask(makeTask("t-orphan", { status: "running" }));

  let killAttempted = false;
  const noopKill = (name: string): void => {
    killAttempted = true;
    assert.equal(name, "forge-t-orphan");
    // Simulates container already gone — kill is a silent best-effort no-op
  };

  let threw = false;
  let outcome: ReturnType<typeof performCancel> | undefined;
  try {
    outcome = performCancel("t-orphan", {}, noopKill);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "cancel must not throw when container is absent");
  assert.equal(killAttempted, true, "kill must be attempted even if container is gone");
  assert.equal(outcome?.kind, "task-cancelled");
  if (outcome?.kind === "task-cancelled") {
    assert.equal(outcome.runAbandoned, true);
  }

  assert.equal(getTask("t-orphan")!.status, "failed");
  assert.equal(getTask("t-orphan")!.error, "cancelled via forge cancel");
  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned");
});

// ─── 4. Mixed terminal + non-terminal ───────────────────────────────────────

test("integ cancel: mixed-status run leaves terminal tasks untouched, fails non-terminal", () => {
  insertTask(makeTask("t-mix-complete", { status: "complete" }));
  insertTask(makeTask("t-mix-failed", { status: "failed" }));
  insertTask(makeTask("t-mix-running", { status: "running" }));
  insertTask(makeTask("t-mix-pending", { status: "pending" }));

  const killed: string[] = [];
  const outcome = performCancel(BASE_RUN.id, {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.deepEqual(
      [...outcome.tasksKilled].sort(),
      ["t-mix-pending", "t-mix-running"],
    );
  }

  // Terminal tasks remain untouched
  assert.equal(getTask("t-mix-complete")!.status, "complete");
  assert.equal(getTask("t-mix-failed")!.status, "failed");

  // Non-terminal tasks become failed
  assert.equal(getTask("t-mix-running")!.status, "failed");
  assert.equal(getTask("t-mix-pending")!.status, "failed");

  assert.equal(getRun(BASE_RUN.id)!.status, "abandoned");
  assert.deepEqual(killed.sort(), ["forge-t-mix-pending", "forge-t-mix-running"]);
});

// ─── 5. Idempotent re-cancel ─────────────────────────────────────────────────

test("integ cancel: cancelling already-complete task is a clean no-op (task-terminal)", () => {
  insertTask(makeTask("t-idem-complete", { status: "complete" }));
  const killed: string[] = [];
  const outcome = performCancel("t-idem-complete", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-terminal");
  if (outcome.kind === "task-terminal") {
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.taskId, "t-idem-complete");
  }
  assert.equal(killed.length, 0, "no kill for already-terminal task");
  assert.equal(getTask("t-idem-complete")!.status, "complete");
  assert.equal(getRun(BASE_RUN.id)!.status, "active", "run unaffected by no-op cancel");
});

test("integ cancel: cancelling already-failed task is a clean no-op (task-terminal)", () => {
  insertTask(makeTask("t-idem-failed", { status: "failed" }));
  const killed: string[] = [];
  const outcome = performCancel("t-idem-failed", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-terminal");
  if (outcome.kind === "task-terminal") {
    assert.equal(outcome.status, "failed");
  }
  assert.equal(killed.length, 0);
  assert.equal(getTask("t-idem-failed")!.status, "failed");
});

test("integ cancel: cancelling already-abandoned run yields empty kill list, task statuses unchanged", () => {
  const abandonedRun: Run = {
    id: "run-abandoned-integ",
    workflow: "feature",
    title: "already abandoned",
    status: "abandoned",
    createdAt: "2026-05-29T01:00:00Z",
  };
  insertRun(abandonedRun);
  insertTask(makeTask("t-done-a", { runId: "run-abandoned-integ", status: "failed" }));
  insertTask(makeTask("t-done-b", { runId: "run-abandoned-integ", status: "complete" }));

  const killed: string[] = [];
  const outcome = performCancel("run-abandoned-integ", {}, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.equal(outcome.tasksKilled.length, 0, "no non-terminal tasks to kill");
  }
  assert.equal(killed.length, 0);
  assert.equal(getTask("t-done-a")!.status, "failed");
  assert.equal(getTask("t-done-b")!.status, "complete");
});

test("integ cancel: unknown id returns unknown outcome and makes no writes", () => {
  const outcome = performCancel("nonexistent-id-xyz", {});
  assert.equal(outcome.kind, "unknown");
  if (outcome.kind === "unknown") {
    assert.equal(outcome.id, "nonexistent-id-xyz");
  }
  assert.equal(getRun(BASE_RUN.id)!.status, "active");
});

// ─── 6. --dry-run: zero DB writes ────────────────────────────────────────────

test("integ cancel: --dry-run by task-id issues no kill and makes zero DB writes", () => {
  insertTask(makeTask("t-dry-task", { status: "running" }));
  const killed: string[] = [];

  const outcome = performCancel("t-dry-task", { dryRun: true }, (n) => killed.push(n));

  assert.equal(outcome.kind, "task-cancelled");
  if (outcome.kind === "task-cancelled") {
    assert.equal(outcome.killed, false);
    assert.equal(outcome.runAbandoned, true, "reports would-abandon for sole non-terminal task");
  }

  assert.equal(killed.length, 0, "no kill issued in dry-run");
  assert.equal(getTask("t-dry-task")!.status, "running", "task status unchanged after dry-run");
  assert.equal(getRun(BASE_RUN.id)!.status, "active", "run status unchanged after dry-run");
});

test("integ cancel: --dry-run by run-id issues no kills and makes zero DB writes", () => {
  insertTask(makeTask("t-drun-1", { status: "running" }));
  insertTask(makeTask("t-drun-2", { status: "pending" }));
  insertTask(makeTask("t-drun-3", { status: "complete" }));
  const killed: string[] = [];

  const outcome = performCancel(BASE_RUN.id, { dryRun: true }, (n) => killed.push(n));

  assert.equal(outcome.kind, "run-cancelled");
  if (outcome.kind === "run-cancelled") {
    assert.deepEqual(
      [...outcome.tasksKilled].sort(),
      ["t-drun-1", "t-drun-2"].sort(),
      "reports what would be killed without writing",
    );
  }

  assert.equal(killed.length, 0, "no kills issued in dry-run");
  assert.equal(getTask("t-drun-1")!.status, "running", "running task status unchanged");
  assert.equal(getTask("t-drun-2")!.status, "pending", "pending task status unchanged");
  assert.equal(getTask("t-drun-3")!.status, "complete", "complete task status unchanged");
  assert.equal(getRun(BASE_RUN.id)!.status, "active", "run status unchanged after dry-run");
});
