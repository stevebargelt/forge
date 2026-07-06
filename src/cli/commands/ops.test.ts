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
import { performOpsRepairCommand } from "./ops.js";

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
