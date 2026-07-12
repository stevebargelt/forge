// FG-536: reconcile's surviving idle bound for detached containers, exercised
// through the REAL reconcileRun with an injected activity/kill probe. With
// detached execution the in-process watchdog dies with its watcher; these pin
// the reconcile-side bound's guards — budget from the task manifest, the
// kill + container.idle_timeout evidence trail, no status write in the same
// pass, and the fail-safe non-enforcement cases (recent activity, unknowable
// activity, disabled budget).
//
// Plus the two review findings this file also covers:
//   - the daemon-start-to-callback window: an INVOKE row killed after
//     `docker run -d` but before the container.started append, whose detached
//     container ran on and left a real result.json.
//   - container IDENTITY: every docker call reconcile makes must address the
//     daemon's recorded container ID, not the reusable forge-<taskId> name.

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

// ── the daemon-start-to-callback window (review finding 1) ──────────────────
// `docker run -d` created the container; the CLI was killed before the
// container.started append. The container ran to completion and left a real
// result.json. The FG-533 sweep is (correctly) inert for invoke rows, so
// without the result-on-disk branch this row strands `running` forever.

const INVOKE_RUN: Run = { id: "run-fg536-inv", workflow: "invoke", title: "fg536 invoke", status: "active", createdAt: "2026-07-12T00:00:00Z" };

function insertInvokeRunning(id: string): void {
  insertTask({
    id, runId: INVOKE_RUN.id, phase: "task", agentRole: "engineer", status: "running",
    taskPackage: {
      taskId: id, runId: INVOKE_RUN.id, phase: "task", role: "engineer",
      inputs: {}, composedSystemPrompt: "", dispatchSource: "invoke",
    },
    createdAt: "2026-07-12T00:00:00Z", startedAt: "2026-07-12T00:00:01Z",
  });
}

function writeResult(runId: string, taskId: string, result: unknown): void {
  const dir = taskDir(runId, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
}

test("FG-536 start-callback window: an invoke row with NO container.started whose detached container left a real result is finalized, not stranded", () => {
  insertRun(INVOKE_RUN);
  insertInvokeRunning("task-inv-window");
  writeResult(INVOKE_RUN.id, "task-inv-window", { status: "complete", answer: 42 });

  const r = reconcileRun(INVOKE_RUN.id, () => false);

  const t = getTask("task-inv-window")!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { status: "complete", answer: 42 }, "the REAL result the detached container wrote — not a synthesized one");
  assert.ok(r.taskChanges.some((c) => c.taskId === "task-inv-window" && c.to === "complete" && c.reason === "container_gone_result_present"));

  try { rmSync(runDir(INVOKE_RUN.id), { recursive: true, force: true }); } catch { /* absent */ }
});

test("FG-536 start-callback window: the same invoke row while its container is still ALIVE is left running (no result yet is not evidence of death)", () => {
  insertRun(INVOKE_RUN);
  insertInvokeRunning("task-inv-live");

  const r = reconcileRun(INVOKE_RUN.id, ALIVE);

  assert.equal(getTask("task-inv-live")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

// ── container identity (review finding 2) ───────────────────────────────────

test("FG-536 identity: liveness and the idle kill address the RECORDED daemon container ID, never the reusable forge-<taskId> name", () => {
  const id = insertLiveContainerTask("task-build-detached", 60_000).id;
  logEvent("container.started", { runId: RUN.id, taskId: id, payload: { containerName: `forge-${id}`, containerId: "c0ffee1234" } });

  const probed: string[] = [];
  const { idleBound, kills } = bound(Date.now() - 120_000);

  reconcileRun(RUN.id, (n) => { probed.push(n); return true; }, undefined, undefined, undefined, idleBound);

  assert.deepEqual(probed, ["c0ffee1234"], "liveness probes the container ID");
  assert.deepEqual(kills, ["c0ffee1234"], "the idle bound kills the container ID — a name kill could hit a replacement that acquired forge-<taskId>");
});

test("FG-536 identity: exit-info and the reap address the recorded container ID too", () => {
  insertRun(INVOKE_RUN);
  const id = "task-inv-identity";
  insertInvokeRunning(id);
  logEvent("container.started", { runId: INVOKE_RUN.id, taskId: id, payload: { containerName: `forge-${id}`, containerId: "dead1234beef" } });
  writeResult(INVOKE_RUN.id, id, { status: "complete" });

  const exitInfoSeen: string[] = [];
  const reaped: string[] = [];
  reconcileRun(
    INVOKE_RUN.id,
    () => false,
    (n) => { reaped.push(n); return "killed" as const; },
    (n) => { exitInfoSeen.push(n); return {}; },
  );

  assert.equal(getTask(id)!.status, "complete");
  assert.deepEqual(exitInfoSeen, ["dead1234beef"], "exit info is read from the container ID");
  assert.deepEqual(reaped, ["dead1234beef"], "`docker rm -f` targets the container ID — never a name another container may now hold");

  try { rmSync(runDir(INVOKE_RUN.id), { recursive: true, force: true }); } catch { /* absent */ }
});

test("FG-536 identity: a task whose container.started carries no ID (attached executor, legacy rows) still addresses the name", () => {
  insertLiveContainerTask("task-build-legacy", 60_000);
  const probed: string[] = [];
  const { idleBound, kills } = bound(Date.now() - 120_000);

  reconcileRun(RUN.id, (n) => { probed.push(n); return true; }, undefined, undefined, undefined, idleBound);

  assert.deepEqual(probed, ["forge-task-build-legacy"]);
  assert.deepEqual(kills, ["forge-task-build-legacy"]);
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
