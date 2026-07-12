// FG-531: reconcile's awaiting_red crash-window sweep, exercised directly over
// hand-built state through the REAL reconcileRun. The matrix cells in
// fg530-crash-matrix.integration.test.ts prove end-to-end recovery through
// runNext's real kill points; this file pins the sweep's GUARDS — the run-lock
// liveness probe, the live-red-container skip, dead-red settlement, the
// single-step vs fanout-parent landings, and idempotence — each of which has a
// false-positive failure mode the matrix (all containers dead, no lock) never
// reaches.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { taskDir, runDir } from "../util/paths.js";
import { reconcileRun } from "./reconcile.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = { id: "run-fg531", workflow: "feature", title: "fg531", status: "active", createdAt: "2026-07-11T00:00:00Z" };

const PRIMARY_RESULT = { status: "complete", summary: "merged work awaiting review", tests_run: 3 };

function mkTask(id: string, o: Partial<Task> = {}): Task {
  return {
    id, runId: RUN.id, phase: "build", agentRole: "engineer", status: "awaiting_red",
    taskPackage: {
      taskId: id, runId: RUN.id, phase: "build", role: "engineer",
      inputs: {}, composedSystemPrompt: "",
      ...(o.taskPackage ?? {}),
    },
    createdAt: "2026-07-11T00:00:00Z", startedAt: "2026-07-11T00:00:01Z", ...o,
  };
}

function insertAwaitingRedPrimary(id: string): Task {
  const t = mkTask(id);
  insertTask(t);
  logEvent("container.started", { runId: RUN.id, taskId: id, payload: { containerName: `forge-${id}` } });
  const dir = taskDir(RUN.id, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(PRIMARY_RESULT));
  return t;
}

function insertRedChild(id: string, parentId: string, status: Task["status"]): Task {
  const t = mkTask(id, {
    parentId, agentRole: "red-wide", status,
    taskPackage: { taskId: id, runId: RUN.id, phase: "build", role: "red-wide", inputs: {}, composedSystemPrompt: "" },
  });
  insertTask(t);
  return t;
}

function lockPath(): string {
  return join(runDir(RUN.id), ".dispatch.lock");
}

function writeLock(pid: number, ageMs = 0): void {
  mkdirSync(runDir(RUN.id), { recursive: true });
  const acquiredAtMs = Date.now() - ageMs;
  writeFileSync(lockPath(), JSON.stringify({ pid, command: "next", acquiredAtMs, acquiredAt: new Date(acquiredAtMs).toISOString() }));
}

const GONE = () => false;

function failureKindOf(taskId: string): string | undefined {
  const failed = eventsForTask(taskId).filter((e) => e.eventType === "task.failed");
  const payload = failed[failed.length - 1]?.payload as { failure_kind?: string } | undefined;
  return payload?.failure_kind;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  try { unlinkSync(lockPath()); } catch { /* absent */ }
  try { rmSync(runDir(RUN.id), { recursive: true, force: true }); } catch { /* absent */ }
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-531 sweep: an orphaned awaiting_red primary (no reds, no lock) lands as orphaned_needs_finalize with its disk result preserved on the row", () => {
  insertAwaitingRedPrimary("task-build-a");

  const r = reconcileRun(RUN.id, GONE);

  const t = getTask("task-build-a")!;
  assert.equal(t.status, "failed");
  assert.equal(failureKindOf("task-build-a"), "orphaned_needs_finalize");
  assert.match(t.error ?? "", /forge retry task-build-a --force/);
  assert.deepEqual(t.result, PRIMARY_RESULT, "the persisted result.json rides the failed row as evidence");
  assert.ok(r.taskChanges.some((c) => c.taskId === "task-build-a" && c.from === "awaiting_red" && c.reason === "awaiting_red_reds_dead"));
});

test("FG-531 liveness guard: a LIVE foreign lock holder means the state is in-flight — the sweep must not touch it", () => {
  insertAwaitingRedPrimary("task-build-live");
  // process.ppid is a real, live, foreign pid (the test runner's parent).
  writeLock(process.ppid);

  const r = reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-build-live")!.status, "awaiting_red", "a live foreign driver owns this state");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-531 liveness guard: a DEAD lock holder does not block the sweep (the crashed process's own lock is exactly the orphan shape)", () => {
  insertAwaitingRedPrimary("task-build-deadlock");
  writeLock(999999999); // no such pid

  reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-build-deadlock")!.status, "failed");
  assert.equal(failureKindOf("task-build-deadlock"), "orphaned_needs_finalize");
});

test("FG-531 red-liveness guard: a live red container means the review is in flight — primary and red both untouched", () => {
  insertAwaitingRedPrimary("task-build-redlive");
  insertRedChild("task-red-build-1", "task-build-redlive", "running");
  const aliveOnlyRed = (name: string) => name === "forge-task-red-build-1";

  const r = reconcileRun(RUN.id, aliveOnlyRed);

  assert.equal(getTask("task-build-redlive")!.status, "awaiting_red");
  assert.equal(getTask("task-red-build-1")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-531 dead-red settlement: pending and pre-container running red rows are failed alongside the primary (no non-terminal orphans left behind)", () => {
  insertAwaitingRedPrimary("task-build-deadreds");
  insertRedChild("task-red-build-p", "task-build-deadreds", "pending");
  insertRedChild("task-red-build-r", "task-build-deadreds", "running"); // no container.started — the shape the per-task loop can't sweep

  reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-build-deadreds")!.status, "failed");
  assert.equal(getTask("task-red-build-p")!.status, "failed");
  assert.equal(getTask("task-red-build-r")!.status, "failed");
  assert.equal(failureKindOf("task-red-build-p"), "orphaned");
  assert.equal(failureKindOf("task-red-build-r"), "orphaned");
});

test("FG-531 fanout-parent landing: fanout_wave_orphaned with recover --re-drive named; completed wave children stay complete with results preserved", () => {
  // A fanout PARENT at awaiting_red: no container of its own, wave children terminal.
  const parent = mkTask("task-build-parent");
  insertTask(parent);
  const dir = taskDir(RUN.id, parent.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", children: [] }));
  for (const i of [0, 1]) {
    insertTask(mkTask(`task-build-child-${i}`, {
      parentId: parent.id, status: "complete", result: { status: "complete", slice: i },
      taskPackage: { taskId: `task-build-child-${i}`, runId: RUN.id, phase: "build", role: "engineer", inputs: { fanoutIndex: i }, composedSystemPrompt: "" },
    }));
  }

  reconcileRun(RUN.id, GONE);

  const p = getTask("task-build-parent")!;
  assert.equal(p.status, "failed");
  assert.equal(failureKindOf("task-build-parent"), "fanout_wave_orphaned");
  assert.match(p.error ?? "", /forge recover task-build-parent --re-drive/);
  for (const i of [0, 1]) {
    const c = getTask(`task-build-child-${i}`)!;
    assert.equal(c.status, "complete", "a completed wave child is never touched");
    assert.deepEqual(c.result, { status: "complete", slice: i });
  }
});

test("FG-531 idempotence: a second reconcile pass over the swept state changes nothing", () => {
  insertAwaitingRedPrimary("task-build-idem");
  insertRedChild("task-red-build-i", "task-build-idem", "pending");

  reconcileRun(RUN.id, GONE);
  const second = reconcileRun(RUN.id, GONE);

  assert.equal(second.taskChanges.length, 0);
  assert.equal(getTask("task-build-idem")!.status, "failed");
});
