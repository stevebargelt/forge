// FG-536: reconcile's surviving idle bound for detached containers, exercised
// through the REAL reconcileRun with an injected activity/kill probe. With
// detached execution the in-process watchdog dies with its watcher; these pin
// the reconcile-side bound's guards — budget from the task manifest, the
// kill + container.idle_timeout evidence trail, no status write in the same
// pass, and the fail-safe non-enforcement cases (recent activity, unknowable
// activity, disabled budget).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { taskDir, runDir } from "../util/paths.js";
import { reconcileRun, type ContainerIdleBound } from "./reconcile.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = { id: "run-fg536", workflow: "feature", title: "fg536", status: "active", createdAt: "2026-07-12T00:00:00Z" };

function insertLiveContainerTask(id: string, idleTimeoutMs?: number): Task {
  const t: Task = {
    id, runId: RUN.id, phase: "build", agentRole: "engineer", status: "running",
    taskPackage: {
      taskId: id, runId: RUN.id, phase: "build", role: "engineer",
      inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow",
    },
    createdAt: "2026-07-12T00:00:00Z", startedAt: "2026-07-12T00:00:01Z",
  };
  insertTask(t);
  logEvent("container.started", { runId: RUN.id, taskId: id, payload: { containerName: `forge-${id}` } });
  if (idleTimeoutMs !== undefined) {
    const dir = taskDir(RUN.id, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ container: { idleTimeoutMs } }));
  }
  return t;
}

function bound(activityMs: number | null): { idleBound: ContainerIdleBound; kills: string[] } {
  const kills: string[] = [];
  return { idleBound: { activity: () => activityMs, kill: (n) => kills.push(n) }, kills };
}

const ALIVE = () => true;

function idleEvents(taskId: string) {
  return eventsForTask(taskId).filter((e) => e.eventType === "container.idle_timeout");
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  try { rmSync(runDir(RUN.id), { recursive: true, force: true }); } catch { /* absent */ }
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-536 idle bound: a live container past its manifest budget is killed, with container.idle_timeout evidence and NO status write this pass", () => {
  insertLiveContainerTask("task-build-hung", 60_000);
  const { idleBound, kills } = bound(Date.now() - 120_000); // 2min silent vs 1min budget

  const r = reconcileRun(RUN.id, ALIVE, undefined, undefined, undefined, idleBound);

  assert.deepEqual(kills, ["forge-task-build-hung"], "the container itself is killed — authoritative, like the watchdog");
  const evs = idleEvents("task-build-hung");
  assert.equal(evs.length, 1);
  assert.equal((evs[0]!.payload as { source?: string }).source, "reconcile_idle_bound");
  assert.equal(getTask("task-build-hung")!.status, "running", "no status write in the kill pass — the next pass lands it from container-gone evidence");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-536 idle bound: recent activity within the budget enforces nothing", () => {
  insertLiveContainerTask("task-build-busy", 60_000);
  const { idleBound, kills } = bound(Date.now() - 5_000);

  reconcileRun(RUN.id, ALIVE, undefined, undefined, undefined, idleBound);

  assert.deepEqual(kills, []);
  assert.equal(idleEvents("task-build-busy").length, 0);
});

test("FG-536 idle bound: unknowable activity (docker can't answer) enforces NOTHING — never kill on missing evidence", () => {
  insertLiveContainerTask("task-build-unknown", 60_000);
  const { idleBound, kills } = bound(null);

  reconcileRun(RUN.id, ALIVE, undefined, undefined, undefined, idleBound);

  assert.deepEqual(kills, []);
  assert.equal(idleEvents("task-build-unknown").length, 0);
  assert.equal(getTask("task-build-unknown")!.status, "running");
});

test("FG-536 idle bound: a zero/disabled budget enforces nothing", () => {
  insertLiveContainerTask("task-build-nolimit", 0);
  const { idleBound, kills } = bound(Date.now() - 3_600_000);

  reconcileRun(RUN.id, ALIVE, undefined, undefined, undefined, idleBound);

  assert.deepEqual(kills, []);
  assert.equal(idleEvents("task-build-nolimit").length, 0);
});

test("FG-536 idle bound: a task without container.started (host-side / pre-container) is never idle-probed", () => {
  const t: Task = {
    id: "task-design-x", runId: RUN.id, phase: "design", agentRole: "designer", status: "running",
    taskPackage: { taskId: "task-design-x", runId: RUN.id, phase: "design", role: "designer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-12T00:00:00Z", startedAt: "2026-07-12T00:00:01Z",
  };
  insertTask(t);
  const { idleBound, kills } = bound(Date.now() - 3_600_000);

  reconcileRun(RUN.id, ALIVE, undefined, undefined, undefined, idleBound);

  assert.deepEqual(kills, []);
  assert.equal(getTask("task-design-x")!.status, "running");
});
