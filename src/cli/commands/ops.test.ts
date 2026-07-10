import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask, getTask } from "../../store/tasks.js";
import { logEvent, eventsForTask, eventsForRun } from "../../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../../types/index.js";
import type { LivenessState } from "../../ops/reconcile-candidate.js";
import { RunBusyError } from "../../util/run-lock.js";
import { runDir } from "../../util/paths.js";
import { performOpsRepairCommand, performOpsReapContainers, notifyLiveIncidents } from "./ops.js";
import { runOpsCheck } from "../../ops/detect.js";
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

// ── FG-504: durable container.reaped resolution + completed-leak wording split ──

test("performOpsReapContainers (FG-504): a 'killed' outcome records a container.reaped event and clears a prior container.reap_failed incident", () => {
  insertRun(mkRun("run-reap-resolve-killed", "active"));
  insertTask({ ...mkTask("t-reap-resolve-killed", "run-reap-resolve-killed", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  logEvent("container.reap_failed", {
    runId: "run-reap-resolve-killed", taskId: "t-reap-resolve-killed",
    payload: { containerName: "forge-t-reap-resolve-killed", why: "docker rm -f -v failed after task completion" },
  });

  const reap: ContainerReap = () => "killed";
  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-resolve-killed" }]));
  assert.deepEqual(outcome.reaped, ["forge-t-reap-resolve-killed"]);

  const events = eventsForTask("t-reap-resolve-killed");
  const reapedEvents = events.filter((e) => e.eventType === "container.reaped");
  assert.equal(reapedEvents.length, 1, "the sweep must record a durable resolution event");
  assert.deepEqual(reapedEvents[0]!.payload, { containerName: "forge-t-reap-resolve-killed", outcome: "killed" });
});

test("performOpsReapContainers (FG-504): a 'not_found' outcome also records a container.reaped event (confirmed gone either way)", () => {
  insertRun(mkRun("run-reap-resolve-notfound", "active"));
  insertTask({ ...mkTask("t-reap-resolve-notfound", "run-reap-resolve-notfound", "complete"), completedAt: "2020-01-01T00:00:00Z" });

  const reap: ContainerReap = () => "not_found";
  performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-resolve-notfound" }]));

  const events = eventsForTask("t-reap-resolve-notfound").filter((e) => e.eventType === "container.reaped");
  assert.equal(events.length, 1, "not_found is confirmed-gone too — the resolution must still be recorded");
  assert.deepEqual(events[0]!.payload, { containerName: "forge-t-reap-resolve-notfound", outcome: "not_found" });
});

test("performOpsReapContainers (FG-504): an 'error' outcome records NO container.reaped event — not confirmed gone", () => {
  insertRun(mkRun("run-reap-resolve-error", "active"));
  insertTask({ ...mkTask("t-reap-resolve-error", "run-reap-resolve-error", "complete"), completedAt: "2020-01-01T00:00:00Z" });

  const reap: ContainerReap = () => "error";
  performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-resolve-error" }]));

  const events = eventsForTask("t-reap-resolve-error").filter((e) => e.eventType === "container.reaped");
  assert.deepEqual(events, [], "an unconfirmed reap must never emit a resolution event");
});

test("performOpsReapContainers (FG-504): --dry-run records NO container.reaped event (writes nothing)", () => {
  insertRun(mkRun("run-reap-resolve-dry", "active"));
  insertTask({ ...mkTask("t-reap-resolve-dry", "run-reap-resolve-dry", "complete"), completedAt: "2020-01-01T00:00:00Z" });

  const reap: ContainerReap = () => "killed";
  performOpsReapContainers({ dryRun: true, olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-resolve-dry" }]));

  const events = eventsForTask("t-reap-resolve-dry").filter((e) => e.eventType === "container.reaped");
  assert.deepEqual(events, [], "dry-run must never write a resolution event");
});

test("performOpsReapContainers (FG-504): a completed-task leak whose reap errors is surfaced as completedTaskLeaksUnconfirmed, NOT completedTaskLeaks", () => {
  insertRun(mkRun("run-reap-unconfirmed", "active"));
  insertTask({ ...mkTask("t-reap-unconfirmed", "run-reap-unconfirmed", "complete"), completedAt: "2020-01-01T00:00:00Z" });

  const reap: ContainerReap = () => "error";
  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-unconfirmed" }]));
  assert.deepEqual(outcome.completedTaskLeaks, [], "an unconfirmed reap must never claim to be swept");
  assert.deepEqual(outcome.completedTaskLeaksUnconfirmed, ["forge-t-reap-unconfirmed"]);
});

test("performOpsReapContainers (FG-504): an ordinary failed-task retention candidate never lands in completedTaskLeaksUnconfirmed, even on error", () => {
  insertRun(mkRun("run-reap-unconfirmed-failed", "active"));
  insertTask({ ...mkTask("t-reap-unconfirmed-failed", "run-reap-unconfirmed-failed", "failed"), completedAt: "2020-01-01T00:00:00Z" });

  const reap: ContainerReap = () => "error";
  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-unconfirmed-failed" }]));
  assert.deepEqual(outcome.errors, ["forge-t-reap-unconfirmed-failed"]);
  assert.deepEqual(outcome.completedTaskLeaksUnconfirmed, [], "only a completed-task leak candidate belongs in this field");
});

test("performOpsReapContainers (FG-504): an ordinary failed-task retention candidate ('failed_retained' source, not a completed-task leak) ALSO records container.reaped and clears a prior container.reap_failed incident on success", () => {
  // container.reaped is logged unconditionally on any non-error outcome (ops.ts's
  // else-branch isn't gated on source === "completed_leak") — every other FG-504
  // test above exercises this only via a "complete" task (completed_leak source).
  // This confirms the same resolution wiring holds for the ordinary retained-on-
  // failure candidate too, since detectContainerReapFailed doesn't filter by
  // task status either.
  insertRun(mkRun("run-reap-resolve-failed", "active"));
  insertTask({ ...mkTask("t-reap-resolve-failed", "run-reap-resolve-failed", "failed"), completedAt: "2020-01-01T00:00:00Z" });
  logEvent("container.reap_failed", {
    runId: "run-reap-resolve-failed", taskId: "t-reap-resolve-failed",
    payload: { containerName: "forge-t-reap-resolve-failed", why: "docker rm -f -v failed after task completion" },
  });

  const reap: ContainerReap = () => "killed";
  const outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, containerList([{ name: "forge-t-reap-resolve-failed" }]));
  assert.deepEqual(outcome.reaped, ["forge-t-reap-resolve-failed"]);
  assert.deepEqual(outcome.completedTaskLeaks, [], "a failed_retained candidate is never a completed-task leak");

  const events = eventsForTask("t-reap-resolve-failed").filter((e) => e.eventType === "container.reaped");
  assert.equal(events.length, 1, "the resolution event must be recorded regardless of candidate source");
  assert.deepEqual(events[0]!.payload, { containerName: "forge-t-reap-resolve-failed", outcome: "killed" });
});

// ── FG-505: absence-heal — a lost resolution write eventually heals itself ──
// A `container.reap_failed` event is otherwise sticky forever once its
// container is no longer in the `docker ps -a` listing at all (FG-503
// candidacy only reconciles containers docker still knows about), whether
// because the resolution write itself was lost (crash between `docker rm`
// and logEvent) or an operator ran `docker rm` by hand. The absence-heal pass
// reconciles unresolved reap_failed events against the SAME listing this
// scan already fetched — no extra docker calls.

test("performOpsReapContainers (FG-505): an unresolved reap_failed whose container is absent from docker ps -a gets healed with a distinct outcome", () => {
  insertRun(mkRun("run-absence-heal", "active"));
  insertTask({ ...mkTask("t-absence-heal", "run-absence-heal", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  logEvent("container.reap_failed", {
    runId: "run-absence-heal", taskId: "t-absence-heal",
    payload: { containerName: "forge-t-absence-heal", why: "docker rm -f -v failed after task completion" },
  });

  const calls: string[] = [];
  const reap: ContainerReap = (name) => { calls.push(name); return "killed"; };
  // The container never appears in this scan's docker ps -a listing at all —
  // not merely stopped, genuinely gone (or never existed at scan time).
  const outcome = performOpsReapContainers({}, reap, containerList([]));

  assert.deepEqual(outcome.absenceHealed, ["forge-t-absence-heal"]);
  assert.deepEqual(calls, [], "absence-heal never calls the reaper — the container isn't there to reap");
  assert.equal(outcome.scanned, 0, "absence-heal is a separate pass, not a scan candidate");

  const events = eventsForTask("t-absence-heal").filter((e) => e.eventType === "container.reaped");
  assert.equal(events.length, 1);
  assert.deepEqual(
    events[0]!.payload,
    { containerName: "forge-t-absence-heal", outcome: "confirmed-absent-at-scan" },
    "distinct payload flag from an actively-removed resolution (outcome: 'killed'/'not_found')",
  );
});

test("performOpsReapContainers (FG-505): absence-heal never fires in --dry-run", () => {
  insertRun(mkRun("run-absence-heal-dry", "active"));
  insertTask({ ...mkTask("t-absence-heal-dry", "run-absence-heal-dry", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  logEvent("container.reap_failed", {
    runId: "run-absence-heal-dry", taskId: "t-absence-heal-dry",
    payload: { containerName: "forge-t-absence-heal-dry", why: "docker rm -f -v failed after task completion" },
  });

  const reap: ContainerReap = () => "killed";
  const outcome = performOpsReapContainers({ dryRun: true }, reap, containerList([]));

  assert.deepEqual(outcome.absenceHealed, [], "dry-run must never write a resolution event");
  const events = eventsForTask("t-absence-heal-dry").filter((e) => e.eventType === "container.reaped");
  assert.deepEqual(events, []);
});

test("performOpsReapContainers (FG-505): absence-heal never fires when the container is still present (even stopped)", () => {
  insertRun(mkRun("run-absence-heal-present", "active"));
  insertTask({ ...mkTask("t-absence-heal-present", "run-absence-heal-present", "failed"), completedAt: "2020-01-01T00:00:00Z" });
  logEvent("container.reap_failed", {
    runId: "run-absence-heal-present", taskId: "t-absence-heal-present",
    payload: { containerName: "forge-t-absence-heal-present", why: "docker rm -f -v failed after task completion" },
  });

  // Still on disk (stopped, but present) — the ordinary candidate loop, past
  // its retention window, reaps it directly; absence-heal must not also fire
  // for it.
  const reap: ContainerReap = () => "killed";
  const outcome = performOpsReapContainers({}, reap, containerList([{ name: "forge-t-absence-heal-present" }]));

  assert.deepEqual(outcome.absenceHealed, [], "the container is present — never absence-healed");
  assert.deepEqual(outcome.reaped, ["forge-t-absence-heal-present"], "handled by the ordinary candidate loop instead");
});

test("performOpsReapContainers (FG-505): absence-heal respects project scoping, same as the ordinary candidate loop", () => {
  insertRun({ ...mkRun("run-absence-heal-scope-a", "active"), projectDir: "/projects/alpha" });
  insertRun({ ...mkRun("run-absence-heal-scope-b", "active"), projectDir: "/projects/beta" });
  insertTask({ ...mkTask("t-absence-heal-scope-a", "run-absence-heal-scope-a", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  insertTask({ ...mkTask("t-absence-heal-scope-b", "run-absence-heal-scope-b", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  logEvent("container.reap_failed", {
    runId: "run-absence-heal-scope-a", taskId: "t-absence-heal-scope-a",
    payload: { containerName: "forge-t-absence-heal-scope-a", why: "docker rm -f -v failed after task completion" },
  });
  logEvent("container.reap_failed", {
    runId: "run-absence-heal-scope-b", taskId: "t-absence-heal-scope-b",
    payload: { containerName: "forge-t-absence-heal-scope-b", why: "docker rm -f -v failed after task completion" },
  });

  const reap: ContainerReap = () => "killed";
  const outcome = performOpsReapContainers({ projectDir: "/projects/alpha" }, reap, containerList([]));

  assert.deepEqual(outcome.absenceHealed, ["forge-t-absence-heal-scope-a"], "only the in-scope project's unresolved reap_failed is healed");
});

test("performOpsReapContainers (FG-505): a thrown post-rm resolution write is reported, not fatal — remaining candidates still process, and the docker-confirmed reap still counts", () => {
  insertRun(mkRun("run-write-fail", "active"));
  insertTask({ ...mkTask("t-write-fail-1", "run-write-fail", "complete"), completedAt: "2020-01-01T00:00:00Z" });
  insertTask({ ...mkTask("t-write-fail-2", "run-write-fail", "complete"), completedAt: "2020-01-01T00:00:00Z" });

  const reap: ContainerReap = () => "killed";
  const list = containerList([{ name: "forge-t-write-fail-1" }, { name: "forge-t-write-fail-2" }]);

  const originalPrepare = db.prepare.bind(db);
  let failNext = true;
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    if (failNext && sql.trim().startsWith("INSERT INTO events")) {
      failNext = false;
      return { run: () => { throw new Error("simulated write failure"); } } as unknown as ReturnType<typeof db.prepare>;
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;

  let outcome;
  try {
    outcome = performOpsReapContainers({ olderThanMinutes: 60 }, reap, list);
  } finally {
    (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
  }

  assert.deepEqual(
    outcome.reaped.sort(),
    ["forge-t-write-fail-1", "forge-t-write-fail-2"].sort(),
    "docker already confirmed both gone — a failed event write doesn't undo that",
  );
  assert.equal(outcome.resolutionWriteErrors.length, 1, "exactly one of the two resolution writes was made to throw");
  assert.equal(
    outcome.completedTaskLeaks.length,
    2,
    "the completedTaskLeaks bookkeeping reflects the confirmed docker outcome, not the event-write outcome",
  );
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

// ── FG-516: LIVE-mode `forge ops check` notifications ────────────────────────
// The LIVE (human) path pushes one milestone per NEW incident, deduped on
// incident identity (kind + runId + taskId) scoped to the incident's run so a
// re-run over the same standing incidents never re-pushes. The --json path is
// read-only and never calls notifyLiveIncidents. Provider mocking mirrors
// milestone.test.ts: FORGE_NOTIFY=ntfy + NTFY_URL + a stubbed global fetch,
// NO_NOTIFY cleared so a push actually fires; fetch calls count the real pushes.

const NOTIFY_ENV_KEYS = ["NO_NOTIFY", "FORGE_NOTIFY", "NTFY_URL"] as const;

function withStubProvider(fn: (fetchCalls: () => number) => Promise<void> | void, opts: { noNotify?: boolean } = {}): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of NOTIFY_ENV_KEYS) saved[k] = process.env[k];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env["NO_NOTIFY"] = opts.noNotify ? "true" : "";
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as typeof fetch;
  return (async () => {
    try {
      await fn(() => calls);
    } finally {
      globalThis.fetch = originalFetch;
      for (const k of NOTIFY_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k] as string;
      }
    }
  })();
}

function dispatchedOpsMilestones(runId: string): number {
  return eventsForRun(runId)
    .filter((e) => e.eventType === "orchestrator.milestone")
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => typeof p["dedupeKey"] === "string" && (p["dedupeKey"] as string).startsWith("ops-incident:") && p["dispatched"] === true).length;
}

test("notifyLiveIncidents: pushes one milestone per new incident", async () => {
  insertRun(mkRun("run-orphan-ops", "complete"));
  insertTask(mkTask("t-orphan-ops", "run-orphan-ops", "pending")); // retry_orphan
  insertRun(mkRun("run-stuck-ops", "active"));
  insertTask(mkTask("t-stuck-ops", "run-stuck-ops", "failed")); // stuck_run

  const incidents = runOpsCheck();
  assert.equal(incidents.length, 2, "two synthetic incidents detected");

  await withStubProvider(async (fetchCalls) => {
    await notifyLiveIncidents(incidents);
    assert.equal(fetchCalls(), 2, "one push per new incident");
    assert.equal(dispatchedOpsMilestones("run-orphan-ops"), 1);
    assert.equal(dispatchedOpsMilestones("run-stuck-ops"), 1);
  });
});

test("notifyLiveIncidents: a second run over the same standing incidents pushes nothing (dedupe on incident identity)", async () => {
  insertRun(mkRun("run-orphan-dd", "complete"));
  insertTask(mkTask("t-orphan-dd", "run-orphan-dd", "pending"));

  const incidents = runOpsCheck();
  assert.equal(incidents.length, 1);

  await withStubProvider(async (fetchCalls) => {
    await notifyLiveIncidents(incidents);
    assert.equal(fetchCalls(), 1, "first run pushes the incident");

    // Re-run over the identical standing incident — the incident-identity key +
    // emitMilestone's persistent, run-scoped dedupe must suppress the re-push.
    await notifyLiveIncidents(runOpsCheck());
    assert.equal(fetchCalls(), 1, "no second push for the same standing incident");
    assert.equal(dispatchedOpsMilestones("run-orphan-dd"), 1);
  });
});

test("notifyLiveIncidents: NO_NOTIFY suppresses every push", async () => {
  insertRun(mkRun("run-orphan-nn", "complete"));
  insertTask(mkTask("t-orphan-nn", "run-orphan-nn", "pending"));

  const incidents = runOpsCheck();
  assert.equal(incidents.length, 1);

  await withStubProvider(async (fetchCalls) => {
    await notifyLiveIncidents(incidents);
    assert.equal(fetchCalls(), 0, "NO_NOTIFY → no provider push attempted");
  }, { noNotify: true });
});
