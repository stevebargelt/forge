import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask, getTask } from "../../store/tasks.js";
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

test("performOpsReapContainers: --dry-run reports without calling the reaper", () => {
  insertRun(mkRun("run-reap-2", "active"));
  insertTask(mkTask("t-reap-dry", "run-reap-2", "failed"));

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
  const old: Task = { ...mkTask("t-reap-old", "run-reap-4", "failed"), completedAt: "2020-01-01T00:00:00Z" };
  insertTask(old);

  let called = 0;
  const reap: ContainerReap = () => { called++; return "killed"; };

  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap);
  assert.deepEqual(outcome.retained, ["forge-t-reap-recent"], "still within the retention window");
  assert.deepEqual(outcome.reaped, ["forge-t-reap-old"]);
  assert.equal(called, 1, "only the old one's container is actually reaped");
});
