// FG-533: reconcile's pre-container crash-window sweep, exercised directly over
// hand-built state through the REAL reconcileRun. The matrix cell in
// fg530-crash-matrix.integration.test.ts proves end-to-end recovery through
// runNext's real pre-container kill point; this file pins the sweep's GUARDS —
// the dispatch-provenance gate (workflow-only), the manual-role exemption, the
// live-agent-container skip, the any-age live-lock-holder skip (deliberately
// stricter than FG-531's default staleness), the FG-437 provisioning handoff,
// and idempotence — each of which has a false-positive failure mode the matrix
// (workflow rows only, all containers dead, no lock) never reaches.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { runDir, taskDir } from "../util/paths.js";
import { reconcileRun } from "./reconcile.js";
import type { Run, Task, TaskPackage } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = { id: "run-fg533", workflow: "feature", title: "fg533", status: "active", createdAt: "2026-07-11T00:00:00Z" };

function mkRunning(id: string, o: Partial<Task> & { dispatchSource?: TaskPackage["dispatchSource"] } = {}): Task {
  const { dispatchSource, ...rest } = o;
  const t: Task = {
    id, runId: RUN.id, phase: "build", agentRole: "engineer", status: "running",
    taskPackage: {
      taskId: id, runId: RUN.id, phase: "build", role: "engineer",
      inputs: {}, composedSystemPrompt: "",
      ...(dispatchSource !== undefined ? { dispatchSource } : {}),
    },
    createdAt: "2026-07-11T00:00:00Z", startedAt: "2026-07-11T00:00:01Z", ...rest,
  };
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
const NO_REAP = () => "not_found" as const;
const NO_EXIT_INFO = () => ({});

function writeResult(taskId: string, result: unknown): void {
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
}

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

test("FG-533 sweep: a runner-dispatched running row with no container.started (no lock, no container) lands as retryable pre_container_crash", () => {
  mkRunning("task-build-a", { dispatchSource: "workflow" });

  const r = reconcileRun(RUN.id, GONE);

  const t = getTask("task-build-a")!;
  assert.equal(t.status, "failed");
  assert.equal(failureKindOf("task-build-a"), "pre_container_crash");
  assert.match(t.error ?? "", /forge retry task-build-a/);
  assert.doesNotMatch(t.error ?? "", /--force/, "no work exists, so the landing names the PLAIN retry verb");
  assert.ok(r.taskChanges.some((c) => c.taskId === "task-build-a" && c.from === "running" && c.to === "failed" && c.reason === "pre_container_crash"));
});

test("FG-533 exemption: an invoke row in the same shape stays untouched (invoke survivability is FG-536's scope, not this sweep's)", () => {
  mkRunning("task-invoke-a", { dispatchSource: "invoke" });

  const r = reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-invoke-a")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 exemption: a marker-less row (host-side session/design/legacy) in the same shape stays untouched", () => {
  mkRunning("task-design-a", { agentRole: "designer", phase: "design" });

  const r = reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-design-a")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 exemption: a runner-minted manual-step row carries the workflow marker but runs host-side — stays untouched", () => {
  mkRunning("task-manual-a", { agentRole: "manual", dispatchSource: "workflow" });

  const r = reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-manual-a")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 exemption: a fanout PARENT (running, no container of its own, children in flight) is the FG-455-p2 pass's to recover — stays untouched here", () => {
  mkRunning("task-build-parent", { dispatchSource: "workflow" });
  mkRunning("task-build-child-0", {
    parentId: "task-build-parent", dispatchSource: "workflow",
    taskPackage: {
      taskId: "task-build-child-0", runId: RUN.id, phase: "build", role: "engineer",
      inputs: { fanoutIndex: 0 }, composedSystemPrompt: "", dispatchSource: "workflow",
    },
  });
  // The child has a live container — the wave is genuinely in progress.
  const aliveOnlyChild = (name: string) => name === "forge-task-build-child-0";

  const r = reconcileRun(RUN.id, aliveOnlyChild);

  assert.equal(getTask("task-build-parent")!.status, "running", "a mid-wave parent must never be false-failed as pre_container_crash");
  assert.equal(getTask("task-build-child-0")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 liveness guard: a LIVE foreign lock holder means a forge process is driving the run — the sweep must not touch it", () => {
  mkRunning("task-build-live", { dispatchSource: "workflow" });
  // process.ppid is a real, live, foreign pid (the test runner's parent).
  writeLock(process.ppid);

  const r = reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-build-live")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 liveness guard: a live holder OLDER than the default staleness still blocks — the lock is the only liveness signal here, so age never decays it", () => {
  mkRunning("task-build-oldlock", { dispatchSource: "workflow" });
  writeLock(process.ppid, 2 * 60 * 60 * 1000); // 2h — past acquireRunLock's 1h default staleness

  const r = reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-build-oldlock")!.status, "running", "a live pid of any age is presumptively driving the pre-container span");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 liveness guard: a DEAD lock holder does not block the sweep (the crashed process's own lock is exactly the orphan shape)", () => {
  mkRunning("task-build-deadlock", { dispatchSource: "workflow" });
  writeLock(999999999); // no such pid

  reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-build-deadlock")!.status, "failed");
  assert.equal(failureKindOf("task-build-deadlock"), "pre_container_crash");
});

test("FG-533 container guard: a live agent container without container.started (crash between docker start and the event append) is real work — untouched", () => {
  mkRunning("task-build-racing", { dispatchSource: "workflow" });
  const aliveOnlyAgent = (name: string) => name === "forge-task-build-racing";

  const r = reconcileRun(RUN.id, aliveOnlyAgent);

  assert.equal(getTask("task-build-racing")!.status, "running");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 container guard: a container that launched, ran, and EXITED before the container.started append is an event-lost completion — its result is preserved, never swept as pre_container_crash", () => {
  mkRunning("task-build-eventlost", { dispatchSource: "workflow" });
  writeResult("task-build-eventlost", { status: "complete", tests_run: 3 });

  const r = reconcileRun(RUN.id, GONE, NO_REAP, NO_EXIT_INFO);

  const t = getTask("task-build-eventlost")!;
  assert.notEqual(failureKindOf("task-build-eventlost"), "pre_container_crash", "real agent work exists — 'no work exists to lose' is false here");
  assert.equal(failureKindOf("task-build-eventlost"), "orphaned_needs_finalize", "a pipeline step's result never completes without the host-side finalize");
  assert.deepEqual(t.result, { status: "complete", tests_run: 3 }, "the agent's result must be preserved on the row, not discarded");
  assert.ok(r.taskChanges.some((c) => c.taskId === "task-build-eventlost" && c.reason === "container_gone_pipeline_unfinalized"));
});

test("FG-533 provisioning handoff: a live provisioner keeps FG-437 ownership — the pre-container sweep never reaches the row", () => {
  mkRunning("task-build-prov", { dispatchSource: "workflow" });
  logEvent("container.provision_started", {
    runId: RUN.id, taskId: "task-build-prov",
    payload: { containerName: "forge-provision-key1", cacheKey: "key1", phase: "dependency_provisioning" },
  });
  const aliveOnlyProvisioner = (name: string) => name === "forge-provision-key1";

  const r = reconcileRun(RUN.id, aliveOnlyProvisioner);

  assert.equal(getTask("task-build-prov")!.status, "running", "FG-376 rule: never touch a live provisioner");
  assert.equal(r.taskChanges.length, 0);
});

test("FG-533 post-provisioning sub-window: provision_succeeded but no container.started falls through FG-437 to this sweep", () => {
  mkRunning("task-build-postprov", { dispatchSource: "workflow" });
  logEvent("container.provision_started", {
    runId: RUN.id, taskId: "task-build-postprov",
    payload: { containerName: "forge-provision-key2", cacheKey: "key2", phase: "dependency_provisioning" },
  });
  logEvent("container.provision_succeeded", {
    runId: RUN.id, taskId: "task-build-postprov",
    payload: { containerName: "forge-provision-key2", cacheKey: "key2" },
  });

  reconcileRun(RUN.id, GONE);

  const t = getTask("task-build-postprov")!;
  assert.equal(t.status, "failed");
  assert.equal(failureKindOf("task-build-postprov"), "pre_container_crash");
});

test("FG-533 mixed run: one reconcile pass over workflow + invoke + marker-less rows in the same shape sweeps EXACTLY the workflow row", () => {
  mkRunning("task-build-wf", { dispatchSource: "workflow" });
  mkRunning("task-build-inv", { dispatchSource: "invoke" });
  mkRunning("task-build-legacy", {});

  const r = reconcileRun(RUN.id, GONE);

  assert.equal(getTask("task-build-wf")!.status, "failed");
  assert.equal(getTask("task-build-inv")!.status, "running");
  assert.equal(getTask("task-build-legacy")!.status, "running");
  assert.equal(r.taskChanges.length, 1);
  assert.equal(r.taskChanges[0]!.taskId, "task-build-wf");
});

test("FG-533 idempotence: a second reconcile pass over the swept state changes nothing", () => {
  mkRunning("task-build-idem", { dispatchSource: "workflow" });

  reconcileRun(RUN.id, GONE);
  const second = reconcileRun(RUN.id, GONE);

  assert.equal(second.taskChanges.length, 0);
  assert.equal(getTask("task-build-idem")!.status, "failed");
});
