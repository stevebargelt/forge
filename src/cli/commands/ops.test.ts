import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask, getTask } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../../types/index.js";
import type { LivenessState } from "../../ops/reconcile-candidate.js";
import { RunBusyError } from "../../util/run-lock.js";
import { runDir } from "../../util/paths.js";
import { performOpsRepairCommand, performOpsReapContainers } from "./ops.js";
import type { ContainerReap } from "../../v2/reconcile.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function mkRun(id: string, status: RunStatus): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z" };
}
function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

const NEVER_ALIVE = (): LivenessState => "gone";
const lockFile = (id: string) => join(runDir(id), ".dispatch.lock");

// ── id resolution: dispatches on task id vs run id, lock keyed on the run ──

test("performOpsRepairCommand: resolves a task id to its run id and repairs the retry_orphan", () => {
  insertRun(mkRun("run-cmd-orphan", "complete"));
  insertTask(mkTask("t-cmd-orphan", "run-cmd-orphan", "pending"));

  const outcome = performOpsRepairCommand("t-cmd-orphan");
  assert.equal(outcome.kind, "repaired");
  assert.equal(getTask("t-cmd-orphan")!.status, "failed");
  // lock was acquired and released against the RUN id, not the task id.
  assert.equal(existsSync(lockFile("run-cmd-orphan")), false, "lock released");
  assert.equal(existsSync(lockFile("t-cmd-orphan")), false, "never locked under the task id");
});

test("performOpsRepairCommand: a bare run id repairs the stuck_run directly", () => {
  insertRun(mkRun("run-cmd-stuck", "active"));
  insertTask(mkTask("t-cmd-stuck", "run-cmd-stuck", "failed"));

  const outcome = performOpsRepairCommand("run-cmd-stuck", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "run-repaired");
  assert.equal(existsSync(lockFile("run-cmd-stuck")), false, "lock released");
});

// ── lock dispatch: serializes against a concurrent lifecycle command ──

test("performOpsRepairCommand: refuses (throws RunBusyError) when the resolved run is already locked, and writes nothing", () => {
  insertRun(mkRun("run-cmd-busy", "complete"));
  insertTask(mkTask("t-cmd-busy", "run-cmd-busy", "pending"));
  mkdirSync(runDir("run-cmd-busy"), { recursive: true });
  writeFileSync(
    lockFile("run-cmd-busy"),
    JSON.stringify({ pid: process.pid, command: "forge next", acquiredAtMs: Date.now(), acquiredAt: new Date().toISOString() })
  );

  assert.throws(() => performOpsRepairCommand("t-cmd-busy"), RunBusyError);
  assert.equal(getTask("t-cmd-busy")!.status, "pending", "no repair happened while the run was locked");
});

// ── dry-run takes no lock at all ──

test("performOpsRepairCommand: --dry-run never acquires a lock, even on an already-locked run", () => {
  insertRun(mkRun("run-cmd-dry", "complete"));
  insertTask(mkTask("t-cmd-dry", "run-cmd-dry", "pending"));
  mkdirSync(runDir("run-cmd-dry"), { recursive: true });
  writeFileSync(
    lockFile("run-cmd-dry"),
    JSON.stringify({ pid: process.pid, command: "forge next", acquiredAtMs: Date.now(), acquiredAt: new Date().toISOString() })
  );

  const outcome = performOpsRepairCommand("t-cmd-dry", { dryRun: true });
  assert.equal(outcome.kind, "repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, true);
  assert.equal(getTask("t-cmd-dry")!.status, "pending", "dry-run writes nothing");
});

// ── FG-492: forge ops reap-containers ───────────────────────────────────────

test("performOpsReapContainers: reaps a retained failed-task container, never touches a running one", () => {
  insertRun(mkRun("run-reap-1", "active"));
  insertTask(mkTask("t-reap-failed", "run-reap-1", "failed"));
  logEvent("container.started", { runId: "run-reap-1", taskId: "t-reap-failed" });
  insertTask(mkTask("t-reap-running", "run-reap-1", "running"));

  const calls: string[] = [];
  const reap: ContainerReap = (name) => {
    calls.push(name);
    return "killed";
  };

  const outcome = performOpsReapContainers({}, reap);
  assert.equal(outcome.scanned, 1, "only the failed task is a candidate — never a running one's container");
  assert.deepEqual(outcome.reaped, ["forge-t-reap-failed"]);
  assert.deepEqual(calls, ["forge-t-reap-failed"]);
  assert.equal(outcome.retained.length, 0);
  assert.equal(outcome.errors.length, 0);
});

test("performOpsReapContainers: never scans a failed task that structurally never had a container (fanout parent / host-side dispatch)", () => {
  insertRun(mkRun("run-reap-nocontainer", "active"));
  insertTask(mkTask("t-reap-fanout-parent", "run-reap-nocontainer", "failed"));
  // No container.started event — e.g. a fanout parent (never gets its own agent
  // container) or a host-side/manual task. Must not be scanned, so a "not_found"
  // docker-rm result on a name that was never real can't get counted as "reaped".
  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "not_found"; };

  const outcome = performOpsReapContainers({}, reap);
  assert.equal(outcome.scanned, 0);
  assert.deepEqual(outcome.reaped, []);
  assert.deepEqual(calls, [], "the reaper must never be invoked for a task with no container evidence");
});

test("performOpsReapContainers: --dry-run reports without calling the reaper", () => {
  insertRun(mkRun("run-reap-2", "active"));
  insertTask(mkTask("t-reap-dry", "run-reap-2", "failed"));
  logEvent("container.started", { runId: "run-reap-2", taskId: "t-reap-dry" });

  let called = false;
  const reap: ContainerReap = () => {
    called = true;
    return "killed";
  };

  const outcome = performOpsReapContainers({ dryRun: true }, reap);
  assert.equal(outcome.dryRun, true);
  assert.deepEqual(outcome.reaped, ["forge-t-reap-dry"]);
  assert.equal(called, false, "dry-run must never invoke the reaper");
});

test("performOpsReapContainers: reap 'error' (not confirmed gone) is reported distinctly from 'retained'", () => {
  insertRun(mkRun("run-reap-3", "active"));
  insertTask(mkTask("t-reap-error", "run-reap-3", "failed"));
  logEvent("container.started", { runId: "run-reap-3", taskId: "t-reap-error" });

  const reap: ContainerReap = () => "error";
  const outcome = performOpsReapContainers({}, reap);
  assert.deepEqual(outcome.errors, ["forge-t-reap-error"]);
  assert.equal(outcome.reaped.length, 0);
  assert.equal(outcome.retained.length, 0, "a reap failure is not the same as a deliberate retention decision");
});

test("performOpsReapContainers: --older-than-minutes leaves a recently-failed task's container alone", () => {
  insertRun(mkRun("run-reap-4", "active"));
  const recent: Task = { ...mkTask("t-reap-recent", "run-reap-4", "failed"), completedAt: new Date().toISOString() };
  insertTask(recent);
  logEvent("container.started", { runId: "run-reap-4", taskId: "t-reap-recent" });
  const old: Task = { ...mkTask("t-reap-old", "run-reap-4", "failed"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(old);
  logEvent("container.started", { runId: "run-reap-4", taskId: "t-reap-old" });

  let called = 0;
  const reap: ContainerReap = () => { called++; return "killed"; };

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap);
  assert.deepEqual(outcome.retained, ["forge-t-reap-recent"], "still within the retention window");
  assert.deepEqual(outcome.reaped, ["forge-t-reap-old"]);
  assert.equal(called, 1, "only the old one's container is actually reaped");
});

// ── FG-503: also sweeps a leaked container on an otherwise-SUCCESSFUL task ──

test("performOpsReapContainers: sweeps a completed task's leaked container (container.reap_failed) past the age threshold", () => {
  insertRun(mkRun("run-reap-5", "active"));
  const leaked: Task = { ...mkTask("t-reap-leak", "run-reap-5", "complete"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(leaked);
  logEvent("container.started", { runId: "run-reap-5", taskId: "t-reap-leak" });
  logEvent("container.reap_failed", { runId: "run-reap-5", taskId: "t-reap-leak", payload: { containerName: "forge-t-reap-leak" } });

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap);
  assert.equal(outcome.scanned, 1);
  assert.deepEqual(outcome.reaped, ["forge-t-reap-leak"]);
  assert.deepEqual(outcome.completedTaskLeaks, ["forge-t-reap-leak"], "surfaced distinctly as a leak from a SUCCESSFUL task");
  assert.deepEqual(calls, ["forge-t-reap-leak"]);
});

test("performOpsReapContainers: --older-than-minutes leaves a recently-completed leaked container alone too", () => {
  insertRun(mkRun("run-reap-6", "active"));
  const recentLeak: Task = { ...mkTask("t-reap-leak-recent", "run-reap-6", "complete"), completedAt: new Date().toISOString() };
  insertTask(recentLeak);
  logEvent("container.started", { runId: "run-reap-6", taskId: "t-reap-leak-recent" });
  logEvent("container.reap_failed", { runId: "run-reap-6", taskId: "t-reap-leak-recent", payload: { containerName: "forge-t-reap-leak-recent" } });

  let called = 0;
  const reap: ContainerReap = () => { called++; return "killed"; };

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap);
  assert.deepEqual(outcome.retained, ["forge-t-reap-leak-recent"]);
  assert.equal(called, 0, "still within the retention window — never reaped");
  assert.deepEqual(outcome.completedTaskLeaks, []);
});

test("performOpsReapContainers: never touches a live/running task's container, even one that later gets a container.reap_failed-shaped event", () => {
  insertRun(mkRun("run-reap-7", "active"));
  insertTask(mkTask("t-reap-running-leak", "run-reap-7", "running"));
  logEvent("container.started", { runId: "run-reap-7", taskId: "t-reap-running-leak" });
  // A running task can never itself carry container.reap_failed (only 'complete'/
  // 'failed' tasks reach a finalizeContainerRetention(..., true) call) — inserted
  // here anyway to prove the scan's status filter, not the event, is what excludes it.
  logEvent("container.reap_failed", { runId: "run-reap-7", taskId: "t-reap-running-leak", payload: { containerName: "forge-t-reap-running-leak" } });

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };

  const outcome = performOpsReapContainers({}, reap);
  assert.equal(outcome.scanned, 0, "a running task's container is never a candidate, regardless of events recorded against it");
  assert.deepEqual(calls, []);
});

test("performOpsReapContainers: never scans a completed task with no container.reap_failed event (ordinary successful reap)", () => {
  insertRun(mkRun("run-reap-8", "active"));
  insertTask({ ...mkTask("t-reap-ok", "run-reap-8", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  logEvent("container.started", { runId: "run-reap-8", taskId: "t-reap-ok" });
  // No container.reap_failed — the ordinary silent happy path.

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "not_found"; };

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap);
  assert.equal(outcome.scanned, 0, "a completed task that reaped cleanly must never be scanned/attempted again");
  assert.deepEqual(calls, []);
});

test("performOpsReapContainers: a 'not_found' reap result on a completed-task leak candidate is NOT counted as a leak (already cleaned up by an earlier sweep)", () => {
  insertRun(mkRun("run-reap-9", "active"));
  const leaked: Task = { ...mkTask("t-reap-leak-gone", "run-reap-9", "complete"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(leaked);
  logEvent("container.started", { runId: "run-reap-9", taskId: "t-reap-leak-gone" });
  logEvent("container.reap_failed", { runId: "run-reap-9", taskId: "t-reap-leak-gone", payload: { containerName: "forge-t-reap-leak-gone" } });

  const reap: ContainerReap = () => "not_found";

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap);
  assert.deepEqual(outcome.reaped, ["forge-t-reap-leak-gone"], "not_found is still 'nothing left behind' — counts as reaped");
  assert.deepEqual(outcome.completedTaskLeaks, [], "but must NOT be counted as a leak — it was already gone");
});
