import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReadyQueue, isRunSettled, isOnRejectRecoveryTask, resolvePhasePrimary, classifyRunTerminalState, formatRunFailure } from "./ready-queue.js";
import type { Workflow } from "./schema.js";
import type { Task, TaskPackage } from "../types/index.js";

// Test fixtures. Minimal but valid shapes.

function mkWorkflow(steps: Workflow["steps"]): Workflow {
  return {
    name: "test",
    description: "test",
    inputs: [],
    steps,
  };
}

const STUB_TP: TaskPackage = {
  taskId: "t-stub",
  runId: "r-stub",
  phase: "p",
  role: "r",
  inputs: {},
  composedSystemPrompt: "",
};

function mkTask(opts: {
  id: string;
  phase: string;
  status: Task["status"];
  parentId?: string;
  createdAt?: string;
  agentRole?: string;
  inputs?: TaskPackage["inputs"];
  dispatchSource?: TaskPackage["dispatchSource"];
}): Task {
  const taskPackage: TaskPackage = {
    ...STUB_TP,
    ...(opts.inputs ? { inputs: opts.inputs } : {}),
    ...(opts.dispatchSource ? { dispatchSource: opts.dispatchSource } : {}),
  };
  return {
    id: opts.id,
    runId: "r1",
    parentId: opts.parentId,
    phase: opts.phase,
    agentRole: opts.agentRole ?? "test-agent",
    status: opts.status,
    taskPackage,
    createdAt: opts.createdAt ?? "2026-05-13T00:00:00.000Z",
  };
}

/** A `forge invoke` row: phase `task`, recorded provenance, no parent. */
function mkAdHocTask(id: string, status: Task["status"], parentId?: string): Task {
  return mkTask({ id, phase: "task", status, dispatchSource: "invoke", ...(parentId ? { parentId } : {}) });
}

test("computeReadyQueue: step with no deps and no existing task is ready", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const ready = computeReadyQueue(wf, []);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "a");
});

test("computeReadyQueue: step with deps satisfied is ready", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b-agent", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-a", phase: "a", status: "complete" })];
  const ready = computeReadyQueue(wf, tasks);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "b");
});

test("computeReadyQueue: step with unmet deps is NOT ready", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b-agent", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-a", phase: "a", status: "running" })];
  const ready = computeReadyQueue(wf, tasks);
  // 'a' has a task (running, not pending), 'b' depends on 'a' but 'a' isn't complete.
  assert.deepEqual(ready.map((s) => s.id), []);
});

test("computeReadyQueue: step with existing complete task is NOT in ready queue", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-a", phase: "a", status: "complete" })];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), []);
});

test("computeReadyQueue: step with pending replacement task IS ready (re-dispatch case)", () => {
  // gate.ts pattern: after request-changes, a fresh `pending` task is inserted
  // alongside the previous `failed` one. Ready-queue should pick this up.
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-a-1", phase: "a", status: "failed", createdAt: "2026-05-13T00:00:00.000Z" }),
    mkTask({ id: "t-a-2", phase: "a", status: "pending", createdAt: "2026-05-13T01:00:00.000Z" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "a");
});

test("computeReadyQueue: parallel-within-wave — multiple steps with deps met return together", () => {
  const wf = mkWorkflow([
    { id: "root", agent: "r", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "l", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "rt", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-root", phase: "root", status: "complete" })];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id).sort(), ["left", "right"]);
});

test("computeReadyQueue: complete step that's a dep for multiple downstream", () => {
  // Diamond: root → (left, right) → merge
  const wf = mkWorkflow([
    { id: "root", agent: "r", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "l", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "rt", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "merge", agent: "m", gate: "auto", manual: false, depends_on: ["left", "right"], runtime: "claude", reds: [] },
  ]);
  // root complete, left complete, right still running → merge not ready
  const tasks = [
    mkTask({ id: "t-root", phase: "root", status: "complete" }),
    mkTask({ id: "t-left", phase: "left", status: "complete" }),
    mkTask({ id: "t-right", phase: "right", status: "running" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), []);
});

test("computeReadyQueue: diamond merge becomes ready when both legs complete", () => {
  const wf = mkWorkflow([
    { id: "root", agent: "r", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "l", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "rt", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "merge", agent: "m", gate: "auto", manual: false, depends_on: ["left", "right"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-root", phase: "root", status: "complete" }),
    mkTask({ id: "t-left", phase: "left", status: "complete" }),
    mkTask({ id: "t-right", phase: "right", status: "complete" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), ["merge"]);
});

test("computeReadyQueue: child (red) tasks don't affect dep satisfaction", () => {
  // A primary task with several red children. Reds spawn AFTER primary completes.
  // The primary's status is what matters for downstream dep satisfaction.
  const wf = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-a", phase: "a", status: "complete" }),
    mkTask({ id: "t-a-red1", phase: "a", parentId: "t-a", status: "complete" }),
    mkTask({ id: "t-a-red2", phase: "a", parentId: "t-a", status: "running" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "b");
});

// ----- duplicate-primary robustness (orphaned retry primary) -----
// Models the forge-site bug: `forge retry` minted a parallel pending primary
// (created LATER than the real one) while another rerun path completed the
// phase. The ready queue must treat the phase as done and not re-dispatch it,
// and must still satisfy a downstream dep from the complete primary.

test("computeReadyQueue: phase with a complete primary is NOT re-dispatched despite a newer orphan pending primary", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "build-real", phase: "build", status: "complete", createdAt: "2026-06-03T16:57:00.000Z" }),
    mkTask({ id: "build-orphan", phase: "build", status: "pending", createdAt: "2026-06-03T17:49:00.000Z" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), [], "complete primary wins; orphan pending must not trigger a redundant wave");
});

test("computeReadyQueue: downstream dep is satisfied by a complete primary even when a NEWER orphan primary is pending", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "verify", agent: "test-engineer", gate: "auto", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "build-real", phase: "build", status: "complete", createdAt: "2026-06-03T16:57:00.000Z" }),
    mkTask({ id: "build-orphan", phase: "build", status: "pending", createdAt: "2026-06-03T17:49:00.000Z" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), ["verify"], "verify must become ready off the complete build primary, not be blocked by the newer orphan");
});

test("computeReadyQueue: a failed orphan primary also does not shadow a complete primary's dep", () => {
  // After self-healing, the orphan is `failed` (most-recent primary) — must still
  // not block the downstream step.
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "verify", agent: "test-engineer", gate: "auto", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "build-real", phase: "build", status: "complete", createdAt: "2026-06-03T16:57:00.000Z" }),
    mkTask({ id: "build-orphan", phase: "build", status: "failed", createdAt: "2026-06-03T17:49:00.000Z" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), ["verify"]);
});

test("computeReadyQueue: legit retry (old failed + new pending, NO complete) still re-dispatches and blocks downstream", () => {
  // Regression guard: the duplicate-primary fix must NOT change normal retry. With
  // no complete primary, the phase is still pending work and downstream waits.
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "verify", agent: "test-engineer", gate: "auto", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "build-1", phase: "build", status: "failed", createdAt: "2026-06-03T16:57:00.000Z" }),
    mkTask({ id: "build-2", phase: "build", status: "pending", createdAt: "2026-06-03T17:49:00.000Z" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), ["build"], "retry replacement is dispatched; verify stays blocked until build completes");
});

// ----- resolvePhasePrimary: the FG-519 canonical rule, unit-tested directly -----
// Latest (by createdAt) COMPLETE parent-less row for a phase, or undefined.

test("resolvePhasePrimary: [complete older + failed newer] resolves to the complete row (FG-519)", () => {
  const tasks = [
    mkTask({ id: "c", phase: "a", status: "complete", createdAt: "2026-05-13T00:00:00Z" }),
    mkTask({ id: "f", phase: "a", status: "failed", createdAt: "2026-05-13T02:00:00Z" }),
  ];
  assert.equal(resolvePhasePrimary(tasks, "a")?.id, "c");
});

test("resolvePhasePrimary: [complete + newer pending] resolves to the complete row", () => {
  const tasks = [
    mkTask({ id: "c", phase: "a", status: "complete", createdAt: "2026-05-13T00:00:00Z" }),
    mkTask({ id: "p", phase: "a", status: "pending", createdAt: "2026-05-13T03:00:00Z" }),
  ];
  assert.equal(resolvePhasePrimary(tasks, "a")?.id, "c");
});

test("resolvePhasePrimary: two complete primaries => the newest by createdAt", () => {
  const tasks = [
    mkTask({ id: "old", phase: "a", status: "complete", createdAt: "2026-05-13T00:00:00Z" }),
    mkTask({ id: "new", phase: "a", status: "complete", createdAt: "2026-05-13T04:00:00Z" }),
  ];
  assert.equal(resolvePhasePrimary(tasks, "a")?.id, "new");
});

test("resolvePhasePrimary: single complete primary => it", () => {
  assert.equal(resolvePhasePrimary([mkTask({ id: "c", phase: "a", status: "complete" })], "a")?.id, "c");
});

test("resolvePhasePrimary: single failed primary => undefined", () => {
  assert.equal(resolvePhasePrimary([mkTask({ id: "f", phase: "a", status: "failed" })], "a"), undefined);
});

test("resolvePhasePrimary: empty phase => undefined", () => {
  assert.equal(resolvePhasePrimary([], "a"), undefined);
});

test("resolvePhasePrimary: ignores a complete child (parentId-tagged) row", () => {
  const tasks = [
    mkTask({ id: "c", phase: "a", status: "complete" }),
    mkTask({ id: "child", phase: "a", parentId: "c", status: "complete", agentRole: "red-wide" }),
  ];
  const primary = resolvePhasePrimary(tasks, "a");
  assert.equal(primary?.id, "c", "only parent-less rows are candidates");
});

test("resolvePhasePrimary: filters by the requested phase", () => {
  const tasks = [
    mkTask({ id: "a-c", phase: "a", status: "complete" }),
    mkTask({ id: "b-c", phase: "b", status: "complete" }),
  ];
  assert.equal(resolvePhasePrimary(tasks, "b")?.id, "b-c");
});

// FG-519 parity: a phase with [complete + failed-newer] still closes (the phase
// is not re-admitted to the ready set), and a downstream dep is satisfied off the
// complete row. The live-recovery (FG-475/FG-476) re-admit shape is covered below.
test("computeReadyQueue: [complete + failed-newer] phase closes and satisfies downstream (FG-519 parity)", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "verify", agent: "test-engineer", gate: "auto", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "build-real", phase: "build", status: "complete", createdAt: "2026-06-03T16:57:00.000Z" }),
    mkTask({ id: "build-heal", phase: "build", status: "failed", createdAt: "2026-06-03T17:49:00.000Z" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), ["verify"], "build must not be re-admitted; verify becomes ready off the complete row");
});

// FG-528: a terminally-failed primary must stay failed. Its still-pending red /
// fanout child is not an attempt at the step, so it must not re-admit the phase:
// dispatchSingleStep would find no pending primary and no recovery, mint a fresh
// primary, and silently rerun a terminal failure.
test("computeReadyQueue: failed primary + pending red child does NOT re-admit the phase (FG-528)", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude",
      reds: [{ agent: "shipping-reviewer", authority: "authoritative", gate_on_verdict: true }] },
  ]);
  const tasks = [
    mkTask({ id: "build-1", phase: "build", status: "failed" }),
    mkTask({ id: "build-red", phase: "build", parentId: "build-1", status: "pending", agentRole: "shipping-reviewer" }),
  ];
  assert.deepEqual(computeReadyQueue(wf, tasks).map((s) => s.id), []);
});

test("computeReadyQueue: failed primary + pending fanout child does NOT re-admit the phase (FG-528)", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "build-1", phase: "build", status: "failed" }),
    mkTask({ id: "build-child", phase: "build", parentId: "build-1", status: "pending" }),
  ];
  assert.deepEqual(computeReadyQueue(wf, tasks).map((s) => s.id), []);
});

// The counterpart the FG-528 filter must NOT break: a pending on_reject recovery
// IS an attempt at the phase (FG-476), so it still re-admits — even alongside the
// failed primary that rejected it.
test("computeReadyQueue: failed primary + pending on_reject recovery IS ready (FG-476 preserved)", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "build-1", phase: "build", status: "failed" }),
    mkTask({ id: "build-recover", phase: "build", parentId: "build-1", status: "pending",
      inputs: { rejectedTaskId: "build-1" } }),
  ];
  assert.deepEqual(computeReadyQueue(wf, tasks).map((s) => s.id), ["build"]);
});

// ----- isRunSettled (FG-475) -----
// The shared "is this run done, permanently unreachable steps included" check.
// computeReadyQueue only answers "is this ONE step dispatchable right now" — it
// has no notion of "will this run ever produce more ready work". isRunSettled is
// what gate.ts's finalizeRunIfDone and runNext.ts's two "is the run done" checks
// both now consume identically.

test("isRunSettled: linear chain A->B->C, A's primary failed terminally (no pending replacement) => settled", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
    { id: "c", agent: "c", gate: "auto", manual: false, depends_on: ["b"], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-a", phase: "a", status: "failed" })];
  // B/C never materialize task rows — computeReadyQueue correctly reports [] forever.
  assert.deepEqual(computeReadyQueue(wf, tasks), []);
  assert.equal(isRunSettled(wf, tasks), true, "A terminally failed with no retry ⇒ B and C are permanently unreachable ⇒ run is settled");
});

test("isRunSettled: same linear chain but A has a fresh pending primary (retry in flight) => NOT settled", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
    { id: "c", agent: "c", gate: "auto", manual: false, depends_on: ["b"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-a-1", phase: "a", status: "failed", createdAt: "2026-06-03T16:57:00.000Z" }),
    mkTask({ id: "t-a-2", phase: "a", status: "pending", createdAt: "2026-06-03T17:49:00.000Z" }),
  ];
  assert.equal(isRunSettled(wf, tasks), false, "a pending retry replacement means the run still has outstanding work");
});

test("isRunSettled: diamond A->B, A->C — B fails terminally but C (deps only on A, complete) is still outstanding => NOT settled", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
    { id: "c", agent: "c", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-a", phase: "a", status: "complete" }),
    mkTask({ id: "t-b", phase: "b", status: "failed" }),
    // 'c' has no task row yet — still dispatchable off 'a' being complete.
  ];
  assert.equal(
    isRunSettled(wf, tasks),
    false,
    "failure of one branch (b) must not falsely settle the run while an unrelated branch (c) is still outstanding",
  );
});

test("isRunSettled: fully-complete run => settled", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-a", phase: "a", status: "complete" }),
    mkTask({ id: "t-b", phase: "b", status: "complete" }),
  ];
  assert.equal(isRunSettled(wf, tasks), true);
});

test("isRunSettled: a run with a running/awaiting_gate task => NOT settled", () => {
  const wfRunning = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  assert.equal(
    isRunSettled(wfRunning, [mkTask({ id: "t-a", phase: "a", status: "running" })]),
    false,
  );

  const wfGate = mkWorkflow([
    { id: "a", agent: "a", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  assert.equal(
    isRunSettled(wfGate, [mkTask({ id: "t-a", phase: "a", status: "awaiting_gate" })]),
    false,
  );
});

test("isRunSettled: no tasks at all (run just started) => NOT settled", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  assert.equal(isRunSettled(wf, []), false, "first step is dispatchable but hasn't run yet — not settled");
});

// ----- on_reject recovery vs. red/fanout child discriminator (FG-475 edge) -----
// computeStepSettleStates used to tell an on_reject recovery task (live phase
// primary — must keep the run active) apart from a red/fanout child (ignored
// for step-settle) by PHASE EQUALITY: parent.phase === t.phase meant "child,
// ignore". That's wrong for a step whose on_reject targets its OWN step id
// (schema-legal — schema.ts only checks the target step exists), because then
// the recovery task lands in the SAME phase as the rejected primary and gets
// misclassified as a fanout/red child. The fix keys off the explicit marker
// gate.ts stamps on every on_reject recovery task: `inputs.rejectedTaskId`.

test("isRunSettled: self-referencing on_reject (recovery task shares its parent's phase) => phase active, run NOT settled", () => {
  const wf = mkWorkflow([
    {
      id: "review",
      agent: "review",
      gate: "human",
      manual: false,
      depends_on: [],
      on_reject: "review",
      runtime: "claude",
      reds: [],
    },
  ]);
  const tasks = [
    mkTask({ id: "t-review-1", phase: "review", status: "failed" }),
    mkTask({
      id: "t-review-2",
      phase: "review",
      parentId: "t-review-1",
      status: "pending",
      inputs: { rejectedTaskId: "t-review-1", rejectedRationale: "needs another pass" },
    }),
  ];
  // Pre-fix trace (phase-equality discriminator): parent ("t-review-1").phase
  // === t.phase ("review") for the recovery task, so it was dropped as a
  // "red/fanout child — ignore". With no recovery task counted, 'review''s
  // only primary is the terminally-failed t-review-1, depends_on is empty
  // (every() on [] is vacuously true), so the step resolved to "blocked" and
  // isRunSettled wrongly returned true — finalizing the run while the live
  // pending recovery task sat orphaned. This assertion would have failed
  // against that code path.
  assert.equal(
    isRunSettled(wf, tasks),
    false,
    "a live pending on_reject recovery task must keep its phase active even when it shares the rejected primary's phase",
  );
});

test("isRunSettled: genuine fanout/red child (same phase as parent, no recovery marker) => correctly ignored, run settled", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "build", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-build-1", phase: "build", status: "complete" }),
    // Red reviewer child — same phase as its parent, but carries no
    // rejectedTaskId marker. Must NOT be treated as a live on_reject recovery
    // task, or a still-running red would wrongly keep the run "active".
    mkTask({ id: "t-build-1-red1", phase: "build", parentId: "t-build-1", status: "running" }),
  ];
  assert.equal(
    isRunSettled(wf, tasks),
    true,
    "a red/fanout child without the recovery marker must not by itself keep the run active",
  );
});

test("isRunSettled: cross-step on_reject (audit->investigate, different phase) => target phase active, run NOT settled", () => {
  const wf = mkWorkflow([
    {
      id: "audit",
      agent: "audit",
      gate: "human",
      manual: false,
      depends_on: [],
      on_reject: "investigate",
      runtime: "claude",
      reds: [],
    },
    { id: "investigate", agent: "investigate", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-audit-1", phase: "audit", status: "failed" }),
    mkTask({
      id: "t-investigate-1",
      phase: "investigate",
      parentId: "t-audit-1",
      status: "pending",
      inputs: { rejectedTaskId: "t-audit-1", rejectedRationale: "audit rejected, investigate further" },
    }),
  ];
  assert.equal(
    isRunSettled(wf, tasks),
    false,
    "a live pending on_reject recovery task in a different phase from its rejected parent must keep the run active",
  );
});

// ----- FG-476: a live on_reject recovery task must actually be dispatchable -----
// FG-475 fixed isRunSettled so the run doesn't wrongly finalize while a recovery
// task is pending. But computeReadyQueue's "complete primary => skip" rule (line
// 45 above) never had a matching exception, so that same pending recovery task
// was ALSO never admitted to the ready queue — a permanent hang: correctly
// "active" forever, never dispatched. These tests assert the admission exception.

test("computeReadyQueue: phase with a COMPLETE primary PLUS a PENDING rejectedTaskId-marked task IS admitted (FG-476)", () => {
  const wf = mkWorkflow([
    { id: "investigate", agent: "investigate", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "audit", agent: "audit", gate: "human", manual: false, depends_on: ["investigate"], on_reject: "investigate", runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-investigate-1", phase: "investigate", status: "complete" }),
    mkTask({ id: "t-audit-1", phase: "audit", status: "failed" }),
    mkTask({
      id: "t-investigate-2",
      phase: "investigate",
      parentId: "t-audit-1",
      status: "pending",
      inputs: { rejectedTaskId: "t-audit-1", rejectedRationale: "scope too narrow" },
    }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(
    ready.map((s) => s.id),
    ["investigate"],
    "the pending recovery task must make 'investigate' ready again despite its complete primary",
  );
});

test("computeReadyQueue: phase with a COMPLETE primary plus a fanout/red child (parentId-tagged, NO rejectedTaskId marker) is still NOT admitted (FG-476 hard constraint)", () => {
  const wf = mkWorkflow([
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-build-1", phase: "build", status: "complete" }),
    // Red reviewer child — parentId-tagged, same phase, but carries no
    // rejectedTaskId marker. Must NOT be mistaken for a recovery task.
    mkTask({ id: "t-build-1-red1", phase: "build", parentId: "t-build-1", status: "pending" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(
    ready.map((s) => s.id),
    [],
    "a pending fanout/red child must never re-admit a phase with a complete primary",
  );
});

test("isOnRejectRecoveryTask: true only for a parentId-tagged task carrying rejectedTaskId", () => {
  const recovery = mkTask({
    id: "t-recovery",
    phase: "investigate",
    parentId: "t-audit-1",
    status: "pending",
    inputs: { rejectedTaskId: "t-audit-1", rejectedRationale: "why" },
  });
  assert.equal(isOnRejectRecoveryTask(recovery), true);

  const redChild = mkTask({ id: "t-red", phase: "build", parentId: "t-build-1", status: "pending" });
  assert.equal(isOnRejectRecoveryTask(redChild), false, "fanout/red child without the marker is not a recovery task");

  const primary = mkTask({ id: "t-primary", phase: "build", status: "pending" });
  assert.equal(isOnRejectRecoveryTask(primary), false, "a parentId===undefined primary is never a recovery task");
});

// ----- ad-hoc invoke rows vs settledness (FG-507) -----
// A `forge invoke` row (including the fresh row `forge retry` mints to
// re-dispatch one) is dispatched directly, never by the workflow runner. It is
// invisible to the ready queue and to step classification — but a LIVE one is
// real outstanding work on the run, so isRunSettled must see it. Otherwise a
// concurrent `forge next` / `forge gate` finalizes the run while the ad-hoc
// container is still writing its result.

const ONE_STEP_WF = mkWorkflow([
  { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
]);
const COMPLETE_BUILD = mkTask({ id: "t-build", phase: "build", status: "complete" });

test("isRunSettled: a PENDING top-level ad-hoc invoke row keeps the run unsettled", () => {
  assert.equal(
    isRunSettled(ONE_STEP_WF, [COMPLETE_BUILD, mkAdHocTask("t-adhoc", "pending")]),
    false,
    "a pending ad-hoc row is live run-level work — no other actor may finalize the run",
  );
});

test("isRunSettled: a RUNNING top-level ad-hoc invoke row keeps the run unsettled", () => {
  assert.equal(
    isRunSettled(ONE_STEP_WF, [COMPLETE_BUILD, mkAdHocTask("t-adhoc", "running")]),
    false,
    "the direct invoke container is still executing — finalizing here loses its result",
  );
});

test("isRunSettled: a TERMINAL ad-hoc invoke row leaves settledness to the workflow steps alone", () => {
  for (const status of ["complete", "failed"] as const) {
    assert.equal(
      isRunSettled(ONE_STEP_WF, [COMPLETE_BUILD, mkAdHocTask("t-adhoc", status)]),
      true,
      `a ${status} ad-hoc row is done; the complete step decides ⇒ settled`,
    );
    assert.equal(
      isRunSettled(ONE_STEP_WF, [mkTask({ id: "t-build", phase: "build", status: "running" }), mkAdHocTask("t-adhoc", status)]),
      false,
      `a ${status} ad-hoc row must not settle a run whose own step is still active`,
    );
  }
});

test("isRunSettled: only TOP-LEVEL ad-hoc rows block — a parented one is a fanout/red child", () => {
  assert.equal(
    isRunSettled(ONE_STEP_WF, [COMPLETE_BUILD, mkAdHocTask("t-child", "running", "t-build")]),
    true,
    "children are the parent's business; settledness only widens for parentId===undefined rows",
  );
});

test("computeReadyQueue: a live ad-hoc row stays out of the projection, even on a workflow owning a `task` step", () => {
  const wf = mkWorkflow([
    { id: "task", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const adHoc = mkAdHocTask("t-adhoc", "pending");

  // The phase collides with a real step id, so only the recorded provenance
  // keeps the row out. `task` reads as never-dispatched, exactly as if the
  // ad-hoc row weren't there — the runner must never adopt it as its primary.
  assert.deepEqual(computeReadyQueue(wf, [adHoc]).map((s) => s.id), ["task"]);
  assert.equal(isRunSettled(wf, [adHoc]), false, "the step is undispatched AND the ad-hoc row is live");

  const dispatchedStep = mkTask({ id: "t-step", phase: "task", status: "complete" });
  assert.deepEqual(computeReadyQueue(wf, [adHoc, dispatchedStep]), []);
  assert.equal(
    isRunSettled(wf, [adHoc, dispatchedStep]),
    false,
    "the step is complete but the ad-hoc row is still live ⇒ the run is not settled",
  );
});

// FG-585: the shared terminal-state classifier (the FG-477 anti-drift slice).
const FEATURE_WF = mkWorkflow([
  { id: "verify", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  { id: "docs", agent: "a", gate: "auto", manual: false, depends_on: ["verify"], runtime: "claude", reds: [] },
]);

test("classifyRunTerminalState: not settled while a step is still active ⇒ null", () => {
  const tasks = [mkTask({ id: "v1", phase: "verify", status: "running" })];
  assert.equal(classifyRunTerminalState(FEATURE_WF, tasks), null);
});

test("classifyRunTerminalState: verify failed, docs unreachable ⇒ failed, naming both phases", () => {
  const tasks = [mkTask({ id: "v1", phase: "verify", status: "failed" })];
  const c = classifyRunTerminalState(FEATURE_WF, tasks);
  assert.ok(c);
  assert.equal(c!.status, "failed");
  assert.deepEqual(c!.failedPhases, ["verify"]);
  assert.deepEqual(c!.unreachablePhases, ["docs"]);
});

test("classifyRunTerminalState: both phases complete ⇒ complete, no failed/unreachable", () => {
  const tasks = [
    mkTask({ id: "v1", phase: "verify", status: "complete" }),
    mkTask({ id: "d1", phase: "docs", status: "complete" }),
  ];
  const c = classifyRunTerminalState(FEATURE_WF, tasks);
  assert.ok(c);
  assert.equal(c!.status, "complete");
  assert.deepEqual(c!.failedPhases, []);
  assert.deepEqual(c!.unreachablePhases, []);
});

test("classifyRunTerminalState: a SUPERSEDED failed verify (a complete replacement exists) ⇒ complete", () => {
  const tasks = [
    mkTask({ id: "v1", phase: "verify", status: "failed" }),
    mkTask({ id: "v2", phase: "verify", status: "complete" }),
    mkTask({ id: "d1", phase: "docs", status: "complete" }),
  ];
  const c = classifyRunTerminalState(FEATURE_WF, tasks);
  assert.equal(c!.status, "complete", "a request-changes/retry replacement must not fail the run");
});

test("classifyRunTerminalState: invoke shape (no workflow) — a failed top-level task ⇒ failed", () => {
  const failed = mkAdHocTask("i1", "failed");
  const c = classifyRunTerminalState(undefined, [failed]);
  assert.equal(c!.status, "failed");
  assert.deepEqual(c!.failedPhases, ["task"]);
});

test("classifyRunTerminalState: invoke shape — a live top-level task ⇒ null (not settled)", () => {
  assert.equal(classifyRunTerminalState(undefined, [mkAdHocTask("i1", "running")]), null);
});

test("classifyRunTerminalState: invoke shape — all complete ⇒ complete", () => {
  const c = classifyRunTerminalState(undefined, [mkAdHocTask("i1", "complete")]);
  assert.equal(c!.status, "complete");
});

test("formatRunFailure: names failed then unreachable phases", () => {
  assert.equal(
    formatRunFailure({ status: "failed", failedPhases: ["verify"], unreachablePhases: ["docs"] }),
    "verify failed; docs never ran",
  );
});
