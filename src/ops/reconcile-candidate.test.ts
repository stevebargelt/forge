import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
import {
  findReconcileCandidates,
  type LivenessProbe,
  type LivenessState,
  type ResultProbe,
} from "./reconcile-candidate.js";
import { detectReconcileCandidate } from "./detect.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function mkRun(id: string, status: RunStatus, projectDir?: string): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z", projectDir };
}

function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

/** A running task that actually launched a container (the only kind eligible for
 *  liveness-based reconciliation — the container.started event is the proof). */
function mkContainerizedRunning(taskId: string, runId: string, runStatus: RunStatus = "active"): void {
  insertRun(mkRun(runId, runStatus));
  insertTask(mkTask(taskId, runId, "running"));
  logEvent("container.started", { runId, taskId });
}

/** Liveness probe stub keyed by container name (`forge-<taskId>`). */
function probeOf(map: Record<string, LivenessState>): LivenessProbe {
  return (name) => map[name] ?? "alive";
}
/** Result probe stub keyed by taskId. */
function resultOf(present: Record<string, boolean>): ResultProbe {
  return (_runId, taskId) => present[taskId] ?? false;
}

// ── the classifier ───────────────────────────────────────────────────────────

// The Pixtron regression: result.json written, container gone, DB still running.
test("findReconcileCandidates: Pixtron shape (container_gone_result_present) → reconcile_candidate", () => {
  mkContainerizedRunning("task-engineer-de709d", "run-pixtron");

  const got = findReconcileCandidates(
    db,
    {},
    probeOf({ "forge-task-engineer-de709d": "gone" }),
    resultOf({ "task-engineer-de709d": true })
  );

  assert.equal(got.length, 1);
  assert.equal(got[0]!.classification, "reconcile_candidate");
  assert.equal(got[0]!.reason, "container_gone_result_present");
  assert.equal(got[0]!.hasResult, true);
});

test("findReconcileCandidates: container gone with no result → container_gone_no_result", () => {
  mkContainerizedRunning("task-orphan", "run-o");

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-orphan": "gone" }), resultOf({}));
  assert.equal(got[0]!.classification, "reconcile_candidate");
  assert.equal(got[0]!.reason, "container_gone_no_result");
});

test("findReconcileCandidates: ambiguous docker (unknown) is NOT a candidate", () => {
  mkContainerizedRunning("task-amb", "run-amb");

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-amb": "unknown" }), resultOf({ "task-amb": true }));
  assert.equal(got[0]!.classification, "liveness_unknown");
  assert.equal(got[0]!.reason, null);
});

test("findReconcileCandidates: container alive → ordinary running", () => {
  mkContainerizedRunning("task-live", "run-live");

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-live": "alive" }), resultOf({}));
  assert.equal(got[0]!.classification, "running");
});

test("findReconcileCandidates: alive but result already present → anomalous, not terminal", () => {
  mkContainerizedRunning("task-anom", "run-anom");

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-anom": "alive" }), resultOf({ "task-anom": true }));
  assert.equal(got[0]!.classification, "anomalous_result_while_alive");
});

test("findReconcileCandidates: a running task that never launched a container is excluded (no probe)", () => {
  // No container.started event → host-side/session task → not eligible.
  insertRun(mkRun("run-sess", "active"));
  insertTask(mkTask("task-orch", "run-sess", "running"));

  let probed = false;
  const got = findReconcileCandidates(db, {}, () => { probed = true; return "gone"; }, resultOf({}));
  assert.equal(got.length, 0, "non-containerized running task must not be classified");
  assert.equal(probed, false, "and it must never be docker-probed");
});

test("findReconcileCandidates: project scoping filters by project_dir", () => {
  insertRun(mkRun("run-a", "active", "/projects/alpha"));
  insertTask(mkTask("task-a", "run-a", "running"));
  logEvent("container.started", { runId: "run-a", taskId: "task-a" });
  insertRun(mkRun("run-b", "active", "/projects/beta"));
  insertTask(mkTask("task-b", "run-b", "running"));
  logEvent("container.started", { runId: "run-b", taskId: "task-b" });

  const probe = probeOf({ "forge-task-a": "gone", "forge-task-b": "gone" });
  const alpha = findReconcileCandidates(db, { projectDir: "/projects/alpha" }, probe, resultOf({ "task-a": true, "task-b": true }));
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0]!.taskId, "task-a");
  assert.equal(findReconcileCandidates(db, {}, probe, resultOf({ "task-a": true, "task-b": true })).length, 2);
});

// ── read-only invariant (the load-bearing #290 safety claim) ─────────────────

test("findReconcileCandidates never mutates: task status unchanged and no task.reconciled event", () => {
  mkContainerizedRunning("task-engineer-de709d", "run-pixtron"); // the Pixtron shape

  const snapshot = () => ({
    tasks: db.prepare("SELECT id, status FROM tasks ORDER BY id").all(),
    runs: db.prepare("SELECT id, status FROM runs ORDER BY id").all(),
    events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    reconciled: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'task.reconciled'").get() as { n: number }).n,
  });

  const before = snapshot();
  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-engineer-de709d": "gone" }), resultOf({ "task-engineer-de709d": true }));
  assert.equal(got[0]!.classification, "reconcile_candidate", "precondition: a candidate was detected");

  const after = snapshot();
  assert.deepEqual(after.tasks, before.tasks, "task status must be unchanged (still running)");
  assert.deepEqual(after.runs, before.runs, "run status must be unchanged");
  assert.equal(after.events, before.events, "no events written");
  assert.equal(after.reconciled, 0, "no task.reconciled event emitted by the read path");
});

// ── the ops detector wrapper ─────────────────────────────────────────────────

test("detectReconcileCandidate: emits a medium/external-required incident with a lifecycle-command action", () => {
  mkContainerizedRunning("task-engineer-de709d", "run-pixtron");

  const incidents = detectReconcileCandidate(db, {}, probeOf({ "forge-task-engineer-de709d": "gone" }));
  // result.json existence here goes through the real disk probe (no file) → no_result.
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "reconcile_candidate");
  assert.equal(i.severity, "medium");
  assert.equal(i.confidence, "external-required");
  assert.equal(i.taskId, "task-engineer-de709d");
  assert.equal(i.recommendedAction.type, "repair");
  assert.equal(i.recommendedAction.autonomy, "ask");
  assert.equal(i.recommendedAction.command, "forge show task-engineer-de709d --json");
  assert.ok(i.evidence.some((e) => /container forge-task-engineer-de709d is gone/.test(e)));
});

test("detectReconcileCandidate: ambiguous docker emits no incident", () => {
  mkContainerizedRunning("task-amb", "run-amb");
  assert.deepEqual(detectReconcileCandidate(db, {}, probeOf({ "forge-task-amb": "unknown" })), []);
});

test("detectReconcileCandidate: live container emits no incident", () => {
  mkContainerizedRunning("task-live", "run-live");
  assert.deepEqual(detectReconcileCandidate(db, {}, probeOf({ "forge-task-live": "alive" })), []);
});
