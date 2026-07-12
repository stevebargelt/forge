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
  type RunLockProbe,
} from "./reconcile-candidate.js";
import { detectReconcileCandidate } from "./detect.js";
import { renderHuman } from "../cli/commands/ops.js";

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

/** FG-533: a running task that was dispatched by the workflow runner but crashed
 *  BEFORE its agent container launched — `running`, no container.started. */
function mkPreContainerRunning(
  taskId: string,
  runId: string,
  overrides: { agentRole?: string; dispatchSource?: "invoke" | "workflow" | undefined } = {},
): void {
  insertRun(mkRun(runId, "active"));
  const t = mkTask(taskId, runId, "running");
  const role = overrides.agentRole ?? "engineer";
  insertTask({
    ...t,
    agentRole: role,
    taskPackage: {
      ...t.taskPackage,
      role,
      ...("dispatchSource" in overrides ? { dispatchSource: overrides.dispatchSource } : { dispatchSource: "workflow" as const }),
    },
  });
  logEvent("task.started", { runId, taskId }); // the runner marked it running…
  // …and nothing else: no container.started — the crash window FG-533 recovers.
}

/** Run-lock probe stub: no live holder unless the run is listed. */
function lockLiveOf(live: string[] = []): RunLockProbe {
  return (runId) => live.includes(runId);
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

// ── FG-533: the pre-container crash window ───────────────────────────────────
//
// A crash between markTaskRunning and the container.started append (image pull,
// auth staging, provisioning — minutes) left a running row that the old
// container.started SQL gate omitted entirely: `forge ops check` and `forge show`
// reported nothing to reconcile, so the ops diagnostic/rescue path was blind to
// the one shape that can never self-heal. Each guard below mirrors reconcile.ts's
// FG-533 sweep, so this read surface reports exactly what a lifecycle command
// would sweep — no looser.

test("FG-533: workflow-dispatched running task, container never started, no live lock → reconcile_candidate (pre_container_crash)", () => {
  mkPreContainerRunning("task-engineer-fg533", "run-pre");

  const got = findReconcileCandidates(
    db,
    {},
    probeOf({ "forge-task-engineer-fg533": "gone" }),
    resultOf({}),
    lockLiveOf(),
  );

  assert.equal(got.length, 1);
  assert.equal(got[0]!.classification, "reconcile_candidate");
  assert.equal(got[0]!.reason, "pre_container_crash");
  assert.equal(got[0]!.hasResult, false);
});

test("FG-533: a LIVE run-lock holder of any age blocks the sweep — forge is still in the pre-container window", () => {
  mkPreContainerRunning("task-provisioning", "run-live-lock");

  const got = findReconcileCandidates(
    db,
    {},
    probeOf({ "forge-task-provisioning": "gone" }),
    resultOf({}),
    lockLiveOf(["run-live-lock"]),
  );
  assert.equal(got[0]!.classification, "running", "a live holder means the work is real, not stranded");
  assert.equal(got[0]!.reason, null);
});

test("FG-533: a live agent container (container.started event lost) is NOT a candidate", () => {
  mkPreContainerRunning("task-event-lost", "run-event-lost");

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-event-lost": "alive" }), resultOf({}), lockLiveOf());
  assert.equal(got[0]!.classification, "running");
});

test("FG-533: ambiguous docker on a pre-container task is liveness_unknown, never a candidate", () => {
  mkPreContainerRunning("task-amb-pre", "run-amb-pre");

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-amb-pre": "unknown" }), resultOf({}), lockLiveOf());
  assert.equal(got[0]!.classification, "liveness_unknown");
  assert.equal(got[0]!.reason, null);
});

test("FG-533: invoke-dispatched and legacy marker-less rows stay exempt (never probed)", () => {
  mkPreContainerRunning("task-invoke", "run-invoke", { dispatchSource: "invoke" });
  mkPreContainerRunning("task-legacy", "run-legacy", { dispatchSource: undefined });

  let probed = false;
  const got = findReconcileCandidates(db, {}, () => { probed = true; return "gone"; }, resultOf({}), lockLiveOf());
  assert.deepEqual(got, [], "invoke survivability is FG-536's scope; legacy rows carry no provenance to trust");
  assert.equal(probed, false, "and neither is ever docker-probed");
});

test("FG-533: a runner-minted manual step carries the workflow marker but runs host-side — exempt", () => {
  mkPreContainerRunning("task-manual", "run-manual", { agentRole: "manual" });

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-manual": "gone" }), resultOf({}), lockLiveOf());
  assert.deepEqual(got, []);
});

test("FG-533: a fanout PARENT (has children) is exempt — it is never 'pre-container'", () => {
  mkPreContainerRunning("task-parent", "run-fanout");
  const child = mkTask("task-child", "run-fanout", "running");
  insertTask({ ...child, parentId: "task-parent" });
  logEvent("container.started", { runId: "run-fanout", taskId: "task-child" });

  const got = findReconcileCandidates(
    db,
    {},
    probeOf({ "forge-task-parent": "gone", "forge-task-child": "alive" }),
    resultOf({}),
    lockLiveOf(),
  );
  assert.deepEqual(got.map((c) => c.taskId), ["task-child"], "the parent belongs to the FG-455-p2 / FG-531 passes");
});

test("FG-533: mid-provisioning (provision_started, not succeeded) is exempt — reconcile's FG-437 branch owns it", () => {
  mkPreContainerRunning("task-provisioning-mid", "run-mid");
  logEvent("container.provision_started", {
    runId: "run-mid",
    taskId: "task-provisioning-mid",
    payload: { containerName: "forge-provision-abc", cacheKey: "abc" },
  });

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-provisioning-mid": "gone" }), resultOf({}), lockLiveOf());
  assert.deepEqual(got, [], "the provisioner is a differently-named container — classifying it here would name the wrong cause");
});

test("FG-533: a crash AFTER provisioning succeeded but before container.started is still a candidate", () => {
  mkPreContainerRunning("task-post-provision", "run-post");
  logEvent("container.provision_started", { runId: "run-post", taskId: "task-post-provision", payload: { containerName: "forge-provision-x", cacheKey: "x" } });
  logEvent("container.provision_succeeded", { runId: "run-post", taskId: "task-post-provision", payload: { cacheKey: "x" } });

  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-post-provision": "gone" }), resultOf({}), lockLiveOf());
  assert.equal(got[0]!.classification, "reconcile_candidate");
  assert.equal(got[0]!.reason, "pre_container_crash");
});

test("FG-533: the read path still never mutates — no status change, no task.reconciled", () => {
  mkPreContainerRunning("task-readonly-fg533", "run-readonly");

  const before = {
    status: (db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-readonly-fg533") as { status: string }).status,
    events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  };
  const got = findReconcileCandidates(db, {}, probeOf({ "forge-task-readonly-fg533": "gone" }), resultOf({}), lockLiveOf());
  assert.equal(got[0]!.classification, "reconcile_candidate", "precondition: a candidate was detected");

  assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-readonly-fg533") as { status: string }).status, before.status);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, before.events);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'task.reconciled'").get() as { n: number }).n, 0);
});

// ── FG-533: the `forge ops check` surfaces (JSON incident + human render) ─────

test("FG-533: `forge ops check` (JSON surface) raises a reconcile_candidate incident naming the never-launched container and the retry path", () => {
  mkPreContainerRunning("task-engineer-fg533", "run-pre");

  const incidents = detectReconcileCandidate(db, {}, probeOf({ "forge-task-engineer-fg533": "gone" }));
  assert.equal(incidents.length, 1, "the crash shape must be visible to `forge ops check`, not omitted");
  const i = incidents[0]!;
  assert.equal(i.kind, "reconcile_candidate");
  assert.equal(i.severity, "medium");
  assert.equal(i.confidence, "external-required");
  assert.equal(i.taskId, "task-engineer-fg533");
  assert.equal(i.runId, "run-pre");
  assert.equal(i.recommendedAction.type, "repair");
  assert.equal(i.recommendedAction.autonomy, "ask");
  assert.equal(i.recommendedAction.command, "forge show --reconcile task-engineer-fg533");
  assert.ok(
    i.evidence.some((e) => /never launched \(no container\.started event\)/.test(e)),
    "must name the real cause — the container never started",
  );
  assert.ok(
    !i.evidence.some((e) => /container forge-task-engineer-fg533 is gone/.test(e)),
    "must NOT claim a container went away — there never was one",
  );
  assert.ok(/forge retry task-engineer-fg533/.test(i.recommendedAction.reason), "the rescue path ends in a retry");
});

test("FG-533: `forge ops check` (human surface) renders the incident with its cause and action", () => {
  mkPreContainerRunning("task-engineer-fg533", "run-pre");

  const out = renderHuman(detectReconcileCandidate(db, {}, probeOf({ "forge-task-engineer-fg533": "gone" })));
  assert.ok(/reconcile_candidate/.test(out));
  assert.ok(/run-pre \/ task-engineer-fg533/.test(out));
  assert.ok(/never launched/.test(out));
  assert.ok(/forge show --reconcile task-engineer-fg533/.test(out));
  assert.ok(/autonomy: ask/.test(out));
});
