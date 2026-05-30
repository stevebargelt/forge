import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import { taskDir } from "../../util/paths.js";
import { diffEvents, snapshot, type Snapshot, type TaskSnap } from "./watch.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let tmpDir: string;

const RUN: Run = {
  id: "run-watch-test",
  workflow: "feature",
  title: "watch test",
  status: "active",
  createdAt: "2026-05-29T00:00:00Z",
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    runId: overrides.runId ?? RUN.id,
    phase: overrides.phase ?? "engineer",
    agentRole: overrides.agentRole ?? "engineer",
    status: overrides.status ?? "running",
    taskPackage: { taskId: id, runId: overrides.runId ?? RUN.id, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-29T00:00:00Z",
    ...overrides,
  };
}

function snap(tasks: TaskSnap[], runStatus = "active"): Snapshot {
  return {
    runStatus,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    verdicts: new Map(),
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  tmpDir = mkdtempSync(join(tmpdir(), "forge-watch-test-"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── trace-shape fields ──────────────────────────────────────────────────────

test("diffEvents: every emitted event carries runId and a spanKind", () => {
  const prevS = snap([]);
  const nextS = snap([{ id: "task-a", phase: "engineer", agentRole: "engineer", status: "running" }]);
  const events = diffEvents(prevS, nextS, RUN.id);
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.runId, RUN.id, "event must carry runId");
    assert.equal(typeof e.spanKind, "string", "event must carry spanKind");
  }
});

test("diffEvents: task_created has spanKind task; run_status_changed has spanKind run", () => {
  const prevS = snap([], "active");
  const nextS = snap([{ id: "task-a", phase: "engineer", agentRole: "engineer", status: "running" }], "complete");
  const events = diffEvents(prevS, nextS, RUN.id);
  const created = events.find((e) => e.type === "task_created")!;
  const runChanged = events.find((e) => e.type === "run_status_changed")!;
  assert.equal(created.spanKind, "task");
  assert.equal(runChanged.spanKind, "run");
});

// ─── failure_kind on failure transition (WALK-2) ─────────────────────────────

test("diffEvents: task_status_changed to failed carries failureKind from the task's events", () => {
  insertTask(makeTask("task-fk", { status: "failed" }));
  logEvent("task.failed", { runId: RUN.id, taskId: "task-fk", payload: { failure_kind: "idle_timeout", error: "no output" } });
  const prevS = snap([{ id: "task-fk", phase: "engineer", agentRole: "engineer", status: "running" }]);
  const nextS = snap([{ id: "task-fk", phase: "engineer", agentRole: "engineer", status: "failed" }]);
  const events = diffEvents(prevS, nextS, RUN.id);
  const changed = events.find((e) => e.type === "task_status_changed")!;
  assert.equal(changed.to, "failed");
  assert.equal(changed.failureKind, "idle_timeout");
});

test("diffEvents: non-failure status change has no failureKind", () => {
  const prevS = snap([{ id: "task-ok", phase: "engineer", agentRole: "engineer", status: "running" }]);
  const nextS = snap([{ id: "task-ok", phase: "engineer", agentRole: "engineer", status: "complete" }]);
  const changed = diffEvents(prevS, nextS, RUN.id).find((e) => e.type === "task_status_changed")!;
  assert.equal(changed.to, "complete");
  assert.equal(changed.failureKind, undefined);
});

// ─── live activity (WALK-2) ──────────────────────────────────────────────────

test("diffEvents: task_activity emitted when a running task's stdout mtime advances", () => {
  const base: Omit<TaskSnap, "lastOutputMtime" | "idle"> = { id: "task-run", phase: "engineer", agentRole: "engineer", status: "running" };
  const prevS = snap([{ ...base, lastOutputMtime: 1000, idle: { hasOutput: true, idleMs: 5000, remainingMs: 895000, expired: false, measured: true } }]);
  const nextS = snap([{ ...base, lastOutputMtime: 2000, idle: { hasOutput: true, idleMs: 100, remainingMs: 899900, expired: false, measured: true } }]);
  const activity = diffEvents(prevS, nextS, RUN.id).find((e) => e.type === "task_activity");
  assert.ok(activity, "advancing mtime must emit task_activity");
  assert.equal(activity!.spanKind, "task");
});

test("diffEvents: no task_activity when mtime is unchanged (agent silent)", () => {
  const base: Omit<TaskSnap, "lastOutputMtime" | "idle"> = { id: "task-run", phase: "engineer", agentRole: "engineer", status: "running" };
  const idle = { hasOutput: true, idleMs: 5000, remainingMs: 895000, expired: false, measured: true };
  const prevS = snap([{ ...base, lastOutputMtime: 1000, idle }]);
  const nextS = snap([{ ...base, lastOutputMtime: 1000, idle }]);
  assert.equal(diffEvents(prevS, nextS, RUN.id).find((e) => e.type === "task_activity"), undefined);
});

test("diffEvents: task_idle_warning emitted once when idle budget crosses into exhausted", () => {
  const base: Omit<TaskSnap, "lastOutputMtime" | "idle"> = { id: "task-idle", phase: "engineer", agentRole: "engineer", status: "running" };
  const prevS = snap([{ ...base, lastOutputMtime: 1000, idle: { hasOutput: true, idleMs: 800000, remainingMs: 100000, expired: false, measured: true } }]);
  const nextS = snap([{ ...base, lastOutputMtime: 1000, idle: { hasOutput: true, idleMs: 900000, remainingMs: 0, expired: true, measured: true } }]);
  const warning = diffEvents(prevS, nextS, RUN.id).find((e) => e.type === "task_idle_warning");
  assert.ok(warning, "crossing into expired must emit task_idle_warning");
  // Already-expired in both snapshots → no repeat warning.
  const stillExpired = snap([{ ...base, lastOutputMtime: 1000, idle: { hasOutput: true, idleMs: 950000, remainingMs: 0, expired: true, measured: true } }]);
  assert.equal(diffEvents(nextS, stillExpired, RUN.id).find((e) => e.type === "task_idle_warning"), undefined);
});

// ─── snapshot populates activity only for running tasks ──────────────────────

test("snapshot: running task gets idle countdown from its stdout mtime + manifest timeout; terminal task does not", () => {
  // running task with a real stdout file + manifest
  insertTask(makeTask("task-running", { status: "running" }));
  const rDir = taskDir(RUN.id, "task-running");
  mkdirSync(rDir, { recursive: true });
  writeFileSync(join(rDir, "manifest.json"), JSON.stringify({ container: { name: "forge-x", idleTimeoutMs: 600000 } }));
  const logPath = join(rDir, "container.stdout.log");
  writeFileSync(logPath, "output\n");
  const past = Date.now() / 1000 - 30; // 30s ago
  utimesSync(logPath, past, past);

  // terminal task — no activity expected
  insertTask(makeTask("task-done", { status: "complete" }));

  const s = snapshot(RUN.id);
  const running = s.tasks.get("task-running")!;
  const done = s.tasks.get("task-done")!;
  assert.ok(running.idle, "running task must have an idle countdown");
  assert.equal(running.idle!.hasOutput, true);
  assert.equal(running.idle!.remainingMs + running.idle!.idleMs, 600000, "budget reflects manifest timeout");
  assert.equal(done.idle, undefined, "terminal task must not have an idle countdown");
});
