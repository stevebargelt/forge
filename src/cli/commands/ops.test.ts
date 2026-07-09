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
import type { ContainerReap, ContainerLister, ContainerListEntry } from "../../v2/reconcile.js";

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

// FG-503: fake `docker ps -a` result — the disk-truth source performOpsReapContainers
// now reconciles against task rows instead of task/event scans. Mirrors the
// existing ContainerReap fake-injection style.
function containerList(entries: Array<{ name: string; running?: boolean; finishedAt?: string }>): ContainerLister {
  const list: ContainerListEntry[] = entries.map((e) => ({
    name: e.name,
    running: e.running ?? false,
    ...(e.finishedAt !== undefined ? { finishedAt: e.finishedAt } : {}),
  }));
  return () => list;
}

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

// ── FG-492/FG-503: forge ops reap-containers (disk-truth-driven) ───────────
// Candidacy now comes from `docker ps -a` (the fake `containerList` lister
// injected below), reconciled against task rows — NOT from event presence.
// A container that never shows up in the listing is never a candidate,
// regardless of what the task row/events say; a container that IS listed is
// a candidate purely on task-status + age, with no event requirement at all.

test("performOpsReapContainers: reaps a retained failed-task container, never touches a running one", () => {
  insertRun(mkRun("run-reap-1", "active"));
  insertTask(mkTask("t-reap-failed", "run-reap-1", "failed"));
  insertTask(mkTask("t-reap-running", "run-reap-1", "running"));

  const calls: string[] = [];
  const reap: ContainerReap = (name) => {
    calls.push(name);
    return "killed";
  };
  const list = containerList([
    { name: "forge-t-reap-failed" },
    { name: "forge-t-reap-running", running: true },
  ]);

  const outcome = performOpsReapContainers({}, reap, list);
  assert.equal(outcome.scanned, 1, "only the stopped, terminal-task container is a candidate — never a live one");
  assert.deepEqual(outcome.reaped, ["forge-t-reap-failed"]);
  assert.deepEqual(calls, ["forge-t-reap-failed"]);
  assert.equal(outcome.retained.length, 0);
  assert.equal(outcome.errors.length, 0);
});

test("performOpsReapContainers: a task with no container on disk (docker ps -a doesn't list it) is never a candidate", () => {
  insertRun(mkRun("run-reap-nocontainer", "active"));
  insertTask(mkTask("t-reap-fanout-parent", "run-reap-nocontainer", "failed"));
  // A fanout parent (never gets its own agent container) or host-side/manual
  // task structurally never has a `forge-<taskId>` container, so it never
  // appears in the docker ps -a listing at all — nothing to reconcile against.
  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "not_found"; };

  const outcome = performOpsReapContainers({}, reap, containerList([]));
  assert.equal(outcome.scanned, 0);
  assert.deepEqual(outcome.reaped, []);
  assert.deepEqual(calls, [], "the reaper must never be invoked for a task with no container evidence");
});

test("performOpsReapContainers: a stopped container with no matching task row is never a candidate", () => {
  // Disk truth alone isn't enough — a container docker knows about but whose
  // task id doesn't resolve to any row (unknown origin) is left alone rather
  // than reaped blind.
  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };

  const outcome = performOpsReapContainers({}, reap, containerList([{ name: "forge-t-unknown-origin" }]));
  assert.equal(outcome.scanned, 0);
  assert.deepEqual(calls, []);
});

test("performOpsReapContainers: --dry-run reports without calling the reaper", () => {
  insertRun(mkRun("run-reap-2", "active"));
  insertTask(mkTask("t-reap-dry", "run-reap-2", "failed"));

  let called = false;
  const reap: ContainerReap = () => {
    called = true;
    return "killed";
  };

  const outcome = performOpsReapContainers({ dryRun: true }, reap, containerList([{ name: "forge-t-reap-dry" }]));
  assert.equal(outcome.dryRun, true);
  assert.deepEqual(outcome.reaped, ["forge-t-reap-dry"]);
  assert.equal(called, false, "dry-run must never invoke the reaper");
});

test("performOpsReapContainers: reap 'error' (not confirmed gone) is reported distinctly from 'retained'", () => {
  insertRun(mkRun("run-reap-3", "active"));
  insertTask(mkTask("t-reap-error", "run-reap-3", "failed"));

  const reap: ContainerReap = () => "error";
  const outcome = performOpsReapContainers({}, reap, containerList([{ name: "forge-t-reap-error" }]));
  assert.deepEqual(outcome.errors, ["forge-t-reap-error"]);
  assert.equal(outcome.reaped.length, 0);
  assert.equal(outcome.retained.length, 0, "a reap failure is not the same as a deliberate retention decision");
});

test("performOpsReapContainers: --older-than-minutes leaves a recently-failed task's container alone (falls back to task.completedAt)", () => {
  insertRun(mkRun("run-reap-4", "active"));
  const recent: Task = { ...mkTask("t-reap-recent", "run-reap-4", "failed"), completedAt: new Date().toISOString() };
  insertTask(recent);
  const old: Task = { ...mkTask("t-reap-old", "run-reap-4", "failed"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(old);

  let called = 0;
  const reap: ContainerReap = () => { called++; return "killed"; };
  // No container finishedAt supplied — the age check falls back to the task's
  // own completedAt.
  const list = containerList([{ name: "forge-t-reap-recent" }, { name: "forge-t-reap-old" }]);

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, list);
  assert.deepEqual(outcome.retained, ["forge-t-reap-recent"], "still within the retention window");
  assert.deepEqual(outcome.reaped, ["forge-t-reap-old"]);
  assert.equal(called, 1, "only the old one's container is actually reaped");
});

test("performOpsReapContainers: the container's own finishedAt (disk truth) takes precedence over task.completedAt for the age threshold", () => {
  insertRun(mkRun("run-reap-finishedat", "active"));
  // Task row says it completed long ago, but the container itself (disk
  // truth) only just finished — still within the retention window.
  const t: Task = { ...mkTask("t-reap-finishedat", "run-reap-finishedat", "failed"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(t);

  let called = 0;
  const reap: ContainerReap = () => { called++; return "killed"; };
  const list = containerList([{ name: "forge-t-reap-finishedat", finishedAt: new Date().toISOString() }]);

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, list);
  assert.deepEqual(outcome.retained, ["forge-t-reap-finishedat"], "the container's own finishedAt, not the stale task.completedAt, drives the age check");
  assert.equal(called, 0);
});

// ── FG-503: also sweeps a leaked container on an otherwise-SUCCESSFUL task,
// with NO event dependency at all ───────────────────────────────────────────

test("performOpsReapContainers (FG-503 AC2): crash-window leak — completed task, no events beyond container.started, container still exists — is swept", () => {
  insertRun(mkRun("run-reap-crash-window", "active"));
  // markTaskComplete ran (status is 'complete', completedAt is set) but the
  // forge process died before the reap call ever ran — so there is no
  // container.reap_failed event, and in fact no event beyond container.started.
  // The old event-driven scan required container.reap_failed to see this at
  // all; disk truth (the container still existing) sees it regardless.
  const leaked: Task = { ...mkTask("t-reap-crash-window", "run-reap-crash-window", "complete"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(leaked);
  logEvent("container.started", { runId: "run-reap-crash-window", taskId: "t-reap-crash-window" });

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };
  const list = containerList([{ name: "forge-t-reap-crash-window" }]);

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, list);
  assert.equal(outcome.scanned, 1);
  assert.deepEqual(outcome.reaped, ["forge-t-reap-crash-window"]);
  assert.deepEqual(outcome.completedTaskLeaks, ["forge-t-reap-crash-window"], "surfaced distinctly as a leak from a SUCCESSFUL task");
  assert.deepEqual(calls, ["forge-t-reap-crash-window"]);
});

test("performOpsReapContainers: --older-than-minutes leaves a recently-completed leaked container alone too", () => {
  insertRun(mkRun("run-reap-6", "active"));
  const recentLeak: Task = { ...mkTask("t-reap-leak-recent", "run-reap-6", "complete"), completedAt: new Date().toISOString() };
  insertTask(recentLeak);

  let called = 0;
  const reap: ContainerReap = () => { called++; return "killed"; };

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-leak-recent" }]));
  assert.deepEqual(outcome.retained, ["forge-t-reap-leak-recent"]);
  assert.equal(called, 0, "still within the retention window — never reaped");
  assert.deepEqual(outcome.completedTaskLeaks, []);
});

test("performOpsReapContainers: never touches a container whose task is still non-terminal, even if the container appears stopped on disk", () => {
  insertRun(mkRun("run-reap-7", "active"));
  insertTask(mkTask("t-reap-running-leak", "run-reap-7", "running"));

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };
  // The container shows up stopped in the listing (e.g. a docker-level race),
  // but the task itself is still 'running' — must still be skipped.
  const outcome = performOpsReapContainers({}, reap, containerList([{ name: "forge-t-reap-running-leak" }]));
  assert.equal(outcome.scanned, 0, "a non-terminal task's container is never a candidate, even if docker reports it stopped");
  assert.deepEqual(calls, []);
});

test("performOpsReapContainers: never touches a container that is still running on disk, even if its task is terminal", () => {
  insertRun(mkRun("run-reap-live-edge", "active"));
  insertTask(mkTask("t-reap-live-edge", "run-reap-live-edge", "failed"));

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };
  const outcome = performOpsReapContainers({}, reap, containerList([{ name: "forge-t-reap-live-edge", running: true }]));
  assert.equal(outcome.scanned, 0);
  assert.deepEqual(calls, []);
});

test("performOpsReapContainers: a completed task that reaped cleanly (no container left on disk) is never re-scanned", () => {
  insertRun(mkRun("run-reap-8", "active"));
  insertTask({ ...mkTask("t-reap-ok", "run-reap-8", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  // No container in the listing — it reaped cleanly on the happy path.

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "not_found"; };

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([]));
  assert.equal(outcome.scanned, 0, "a completed task with no container on disk must never be scanned/attempted again");
  assert.deepEqual(calls, []);
});

test("performOpsReapContainers: a 'not_found' reap result on a completed-task leak candidate is NOT counted as a leak (already cleaned up by an earlier sweep)", () => {
  insertRun(mkRun("run-reap-9", "active"));
  const leaked: Task = { ...mkTask("t-reap-leak-gone", "run-reap-9", "complete"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(leaked);

  const reap: ContainerReap = () => "not_found";

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-leak-gone" }]));
  assert.deepEqual(outcome.reaped, ["forge-t-reap-leak-gone"], "not_found is still 'nothing left behind' — counts as reaped");
  assert.deepEqual(outcome.completedTaskLeaks, [], "but must NOT be counted as a leak — it was already gone");
});

test("performOpsReapContainers: docker unavailable is reported, not thrown", () => {
  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };
  const listUnavailable: ContainerLister = () => undefined;

  const outcome = performOpsReapContainers({}, reap, listUnavailable);
  assert.equal(outcome.dockerUnavailable, true);
  assert.equal(outcome.scanned, 0);
  assert.deepEqual(outcome.reaped, []);
  assert.deepEqual(calls, [], "the reaper must never be invoked when the listing itself failed");
});
