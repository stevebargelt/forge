// forge v2 — workflow run lifecycle evaluator (FG-477, slice 1: task lineage).
//
// ONE pure, total function: given a workflow and a run's task rows, say what
// KIND of attempt each row is. Nothing else — no DB, no IO, no state derivation.
// It replaces the four incompatible lineage heuristics that ready-queue.ts,
// runNext.ts, reconcile.ts and retry.ts each re-derived locally (the "task
// identity and lineage are implicit" root cause in FG-477's problem statement).
//
// Total: every task row maps to exactly one kind. No throw, no undefined, no
// default case. Where provenance is genuinely unknowable (a marker-less legacy
// row whose phase collides with the invoke phase — run-kind.ts's
// `legacy_ambiguous_phase`), that gets its OWN kind rather than a guess.

import type { Workflow, Step } from "./schema.js";
import type { Task } from "../types/index.js";

// The phase every `forge invoke` row carries (run-kind.ts's INVOKE_PHASE — a
// workflow may legally declare a step with this id, which is the collision the
// dispatchSource marker exists to resolve).
const INVOKE_PHASE = "task";

export type LineageKind =
  /** Parent-less row, the first one in its phase: fresh dispatch, a manual step,
   *  or a fanout parent (a fanout parent is just a primary whose step declares
   *  `fanout` — there is no separate marker for it). */
  | "primary"
  /** Parent-less row in a phase that already had an earlier parent-less row: a
   *  replacement attempt. Deliberately unifies `forge retry`'s replacement
   *  (marked with inputs.previous_failure) and gate request-changes' replacement
   *  (marked with inputs.requestedChanges) — both are structurally identical
   *  fresh pending primaries, and every consumer treats them the same. */
  | "retry_replacement"
  /** gate.ts's reject -> on_reject branch: parented to the REJECTED task
   *  (lineage, not fanout) and carrying the explicit `rejectedTaskId` marker. */
  | "on_reject_recovery"
  /** A red reviewer child: parented to the primary it audits, sharing its phase,
   *  and named by that step's `reds[].agent`. This is the workflow lookup that
   *  REPLACES the `red-` role-name-prefix convention — which misclassifies every
   *  red whose agent name doesn't happen to start with `red-` (feature.yml's
   *  `shipping-reviewer` is one; see the FG-477 notes). */
  | "red_review"
  /** A fanout child: parented, in its parent's phase, not a red, not a recovery. */
  | "fanout_child"
  /** A `forge invoke` row (dispatchSource === "invoke"). NOT workflow lineage:
   *  it is dispatched directly and never by the runner, so it is invisible to the
   *  ready queue, dispatch's pending-row reuse and reconcile's orphan sweep
   *  (FG-507). Present in the map with this kind rather than dropped, so a
   *  consumer that forgets about it fails a totality test instead of silently
   *  treating it as a step's primary. */
  | "adhoc_invoke"
  /** A marker-less LEGACY row (pre-FG-512) whose phase is the invoke phase AND
   *  whose workflow declares a step with that id — run-kind.ts's
   *  `legacy_ambiguous_phase`. A legacy `forge invoke --run` row and a genuine
   *  step primary are structurally identical here, and nothing recorded tells
   *  them apart. The classifier refuses to guess; it names the state instead.
   *
   *  Consumers today treat such a row as a workflow primary (isAdHocInvokeTask
   *  is marker-only, so it returns false). isWorkflowPrimaryRow preserves that
   *  decision exactly — see its comment. The one site that MUST know the answer
   *  (retry.ts) asks run-kind.ts's taskDispatchKind and refuses to write. */
  | "legacy_ambiguous_invoke";

/** Rows that a workflow step's own bookkeeping counts as its primary: the ready
 *  queue's phase-primary lookups, dispatch's pending-row reuse, reconcile's
 *  orphaned-duplicate-primary sweep.
 *
 *  `legacy_ambiguous_invoke` is included because every consumer's pre-FG-477
 *  predicate (`parentId === undefined && !isAdHocInvokeTask(t)`) already counted
 *  it — isAdHocInvokeTask is marker-only and a legacy row has no marker. The
 *  classifier surfaces the ambiguity as its own kind rather than laundering it
 *  into `primary`, but MIGRATING a consumer must not change its decision
 *  (FG-477's migration-freeze rule). Excluding these rows is a separate,
 *  deliberate behavior change, not a refactor. */
export function isWorkflowPrimaryRow(kind: LineageKind): boolean {
  return kind === "primary" || kind === "retry_replacement" || kind === "legacy_ambiguous_invoke";
}

// Deterministic total order over rows, so classification cannot depend on the
// order the caller happened to hand us (SQLite row order, a test's literal
// array). createdAt is an ISO string; ids are unique, so the pair is total even
// when two rows share a millisecond.
function earlier(a: Task, b: Task): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

/**
 * Classify every task row's attempt kind. Pure and total: `tasks.length` entries
 * out, exactly one kind each, no throw.
 *
 * Rules, IN PRIORITY ORDER (FG-477's architecture pass, "Classifier decision table"):
 *   0. dispatchSource === "invoke"                          => adhoc_invoke
 *      (and, for a marker-less legacy row that could be one => legacy_ambiguous_invoke)
 *   1. no parent, first parent-less row in its phase         => primary
 *   2. no parent, a parent-less row already exists there     => retry_replacement
 *   3. parent + inputs.rejectedTaskId                        => on_reject_recovery
 *   4. parent + role is one of the phase's reds[].agent      => red_review
 *   5. parent, anything else                                 => fanout_child
 *
 * Rule 3 sits above rules 4/5 deliberately: it preserves isOnRejectRecoveryTask's
 * priority, including the schema-legal self-referencing on_reject (on_reject ===
 * step.id), where the recovery row lands in the SAME phase as the task that
 * rejected it and would otherwise collide with rule 4 or 5.
 *
 * Rules 1/2 rank by (createdAt, id) over the phase's non-invoke parent-less rows.
 * `adhoc_invoke` rows are excluded from that universe — an invoke row in a
 * `task`-declaring workflow is not the `task` step's primary (FG-507) — while
 * `legacy_ambiguous_invoke` rows stay in it, matching what consumers do today.
 */
export function classifyTaskLineage(workflow: Workflow, tasks: Task[]): Map<string, LineageKind> {
  const stepsById = new Map(workflow.steps.map((s) => [s.id, s]));
  const kinds = new Map<string, LineageKind>();

  const provenance = new Map<string, LineageKind | undefined>();
  for (const t of tasks) {
    if (isAdHocInvokeRow(t)) {
      provenance.set(t.id, "adhoc_invoke");
    } else if (
      t.taskPackage.dispatchSource === undefined &&
      t.parentId === undefined &&
      t.phase === INVOKE_PHASE &&
      stepsById.has(INVOKE_PHASE)
    ) {
      provenance.set(t.id, "legacy_ambiguous_invoke");
    } else {
      provenance.set(t.id, undefined);
    }
  }

  // The phase-primary universe rules 1/2 rank within: parent-less rows this
  // workflow could own (everything except a proven invoke row).
  const parentlessByPhase = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parentId !== undefined) continue;
    if (provenance.get(t.id) === "adhoc_invoke") continue;
    const arr = parentlessByPhase.get(t.phase) ?? [];
    arr.push(t);
    parentlessByPhase.set(t.phase, arr);
  }
  for (const arr of parentlessByPhase.values()) arr.sort(earlier);

  for (const t of tasks) {
    const provenanceKind = provenance.get(t.id);
    if (provenanceKind !== undefined) {
      kinds.set(t.id, provenanceKind);
      continue;
    }

    if (t.parentId === undefined) {
      const phaseRows = parentlessByPhase.get(t.phase) ?? [];
      const isFirst = phaseRows.length > 0 && phaseRows[0]!.id === t.id;
      kinds.set(t.id, isFirst ? "primary" : "retry_replacement");
      continue;
    }

    if (isOnRejectRecoveryRow(t)) {
      kinds.set(t.id, "on_reject_recovery");
      continue;
    }

    const step = stepsById.get(t.phase);
    if (step?.reds.some((r) => r.agent === t.agentRole)) {
      kinds.set(t.id, "red_review");
      continue;
    }

    kinds.set(t.id, "fanout_child");
  }

  return kinds;
}

// Rules 0 and 3 are the two that need neither the workflow nor the row's phase
// siblings, so they are also the two that consumers can ask about a single row.
// They are exported as predicates (rather than duplicated) so classifyTaskLineage
// and the single-row callers — gate.ts's recovery-row lookup, ready-queue's
// exported isOnRejectRecoveryTask/isAdHocInvokeTask wrappers — cannot drift.

/** Rule 0: dispatchSource === "invoke". Marker only: a marker-less legacy row is
 *  NOT resolved here (that is taskDispatchKind's question, and it refuses to
 *  guess — see LineageKind's `legacy_ambiguous_invoke`). */
export function isAdHocInvokeRow(task: Task): boolean {
  return task.taskPackage.dispatchSource === "invoke";
}

/** Rule 3: parented AND carrying gate.ts's explicit `rejectedTaskId` marker. A
 *  parented row WITHOUT the marker is a fanout/red child, never a recovery. */
export function isOnRejectRecoveryRow(task: Task): boolean {
  return task.parentId !== undefined && task.taskPackage.inputs?.["rejectedTaskId"] !== undefined;
}

/** isWorkflowPrimaryRow(classifyTaskLineage(...).get(task.id)) for a caller that
 *  has no workflow to hand — reconcile's never-throw sweeps, which must not take
 *  on a workflow load just to ask this.
 *
 *  The equivalence is exact and not a coincidence: rules 1/2 assign EVERY
 *  parent-less non-invoke row to primary | retry_replacement |
 *  legacy_ambiguous_invoke (the three isWorkflowPrimaryRow accepts), and no
 *  parented row can receive any of them. Which of the three it is depends on the
 *  workflow and on the phase's other rows; WHETHER it is one of them does not.
 *  A property test pins this to the classifier over the generated corpus. */
export function isPhasePrimaryRow(task: Task): boolean {
  return task.parentId === undefined && !isAdHocInvokeRow(task);
}

/** The `fanout_child` cell of classifyTaskLineage for a caller with no workflow —
 *  reconcile's never-throw sweeps and recover's inspector, both of which must not
 *  take on a workflow load just to ask this.
 *
 *  The classifier derives fanout_child by role: a parented, non-recovery row whose
 *  agentRole is NOT one of its phase-step's reds (the fallback after rules 0/3/4).
 *  This primitive instead reads `fanoutIndex`, which dispatchFanoutChild (runNext.ts)
 *  stamps on EXACTLY the fanout children it mints and nothing else stamps (FG-584 D6).
 *  The two coincide because those are the same rows: an invoke row is adhoc_invoke by
 *  rule 0, a red child carries a red role and no fanoutIndex, a recovery row carries
 *  rejectedTaskId, and a fanout child carries neither. A property test pins this
 *  equivalence to the classifier over the generated corpus. fanoutIndex stays
 *  ordering/diagnostics only — read here as a presence marker, never as an edge key.
 *
 *  The `!isAdHocInvokeRow` guard mirrors the classifier's rule-0 precedence
 *  (dispatchSource === "invoke" => adhoc_invoke, before any lineage rule). It is not
 *  production-reachable today — only dispatchFanoutChild stamps fanoutIndex, and it
 *  stamps dispatchSource "workflow" — but a parented invoke row carrying fanoutIndex
 *  is a shape the classifier calls adhoc_invoke, so this primitive must too. */
export function isFanoutChildRow(task: Task): boolean {
  return (
    task.parentId !== undefined &&
    !isAdHocInvokeRow(task) &&
    !isOnRejectRecoveryRow(task) &&
    typeof task.taskPackage.inputs?.["fanoutIndex"] === "number"
  );
}

// FG-519/FG-477: the one canonical phase-primary resolution rule, shared by the
// three sites that used to disagree — the ready queue (ready-queue.ts), inputs.
// deriveUpstream, and runNext's fanout upstream read. Returns the latest (by
// createdAt) COMPLETE, parent-less (parentId === undefined) task row for `phase`,
// or undefined.
//
// It selects the latest COMPLETED parent-less output even when a NEWER FAILED
// attempt exists (a healed duplicate-primary pair [complete older, failed newer]
// resolves to the complete row, not the failed one whose result.json is missing)
// — hence "CompletedPhasePrimary", not "step-attempt": canonical step state is
// child C's concern, not this selector's.
//
// "parent-less" excludes red/fanout children; "COMPLETE" is what makes the row
// safe for a downstream reader. Callers own the INPUT filtering (e.g.
// computeReadyQueue drops ad-hoc invoke rows before calling); this canonicalizes
// only the SELECTION rule over whatever row universe (`candidateRows`) it is
// handed. It takes NO ad-hoc/workflow policy flag and does NOT filter the universe
// itself — that would narrow the row set for callers who pass an unfiltered
// universe (deriveUpstream, runNext's fanout upstream read), a behavior change
// this migration must not make.
//
// Equal timestamps stay input-order-dependent (Array.sort is stable, so the last
// same-timestamp row survives .pop()); adding a tie-break would be a behavior
// change, not a refactor.
export function resolveCompletedPhasePrimary(
  candidateRows: Task[],
  phase: string,
): Task | undefined {
  return candidateRows
    .filter((t) => t.phase === phase && t.parentId === undefined && t.status === "complete")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .pop();
}

// FG-718 (FG-477 child C): the ONE pure lifecycle-snapshot provider. Every private
// lifecycle derivation ready-queue.ts used to hold — the ready queue, the per-step
// settle states, the run-settled reachability check, and the terminal
// classification — is computed here, once, from a workflow + its task rows.
// ready-queue.ts's public functions are now thin projections of this snapshot.
//
// Same input universe and purity contract as classifyTaskLineage: ROW-PURE — no
// DB, no IO, no event reads, no verdict reads. The two graph-level reason codes
// (own_primaries_failed / dependency_unreachable) are the existing
// failedPhases/unreachablePhases split, re-read from the settle-states map; this
// provider never emits a FailureKind (that stays in failure-kind.ts, a separate
// per-task, event-derived axis) and never carries a campaign BlockerKind.

const COMPLETE_LIKE: ReadonlySet<string> = new Set(["complete"]);

/** A step's settledness within a run: COMPLETE (has a complete primary),
 *  permanently BLOCKED (unreachable), or still ACTIVE (work in flight, a human
 *  decision outstanding, or dispatchable-but-not-yet-dispatched). */
export type StepSettle = "complete" | "active" | "blocked";

/** Per-step lifecycle facts. `ready` is the ready-queue membership (a running
 *  step is active-but-not-ready; the hasLiveRecovery re-admission lives only in
 *  the ready path), carried independently of `settle`. `blockedReason` is
 *  present iff `settle === "blocked"` — the graph-level reason a step is blocked:
 *  its own primaries failed, or a dependency is itself unreachable. */
export type StepLifecycle = {
  settle: StepSettle;
  ready: boolean;
  blockedReason?: "own_primaries_failed" | "dependency_unreachable";
};

// FG-585: the ONE shared terminal-state classifier's shape. Kept campaign-neutral:
// step ids + the two-value graph reason (the failed/unreachable split), never a
// BlockerKind.
//   - null       => NOT settled (live work or a human decision outstanding)
//   - "complete" => settled and every declared step reached a complete primary
//   - "failed"   => settled and at least one step is permanently BLOCKED (its own
//                   primaries terminally failed with no pending replacement, OR a
//                   dependency is permanently blocked → a downstream phase can
//                   never dispatch).
// A SUPERSEDED failed phase (request-changes: a complete replacement exists in
// the same phase) resolves to "complete" via hasCompletePrimary — it does NOT
// make the run failed.
export type RunTerminalClassification = {
  status: "complete" | "failed";
  failedPhases: string[]; // steps whose own primaries terminally failed
  unreachablePhases: string[]; // steps that can never dispatch (a dep is blocked)
};

/** The pure snapshot of a run's lifecycle. Every field is a distinct fact:
 *  `readyWork` is carried on its own (NOT derived from `steps`, because a running
 *  step is active-but-not-ready and the recovery re-admission lives only in the
 *  ready path); `liveAdHocInvoke` is surfaced as its own fact; `runSettled` is the
 *  isRunSettled conjunction (workflow shape) or classifyInvokeTerminalState's
 *  settledness (invoke shape); `terminal` is null exactly when `!runSettled`. */
export type LifecycleSnapshot = {
  steps: Map<string, StepLifecycle>;
  readyWork: Step[];
  runSettled: boolean;
  liveAdHocInvoke: boolean;
  terminal: RunTerminalClassification | null;
};

// True when at least one row in the set is complete. The set is always a phase's
// classifier-derived primary rows (isWorkflowPrimaryRow), so an inline
// `parentId === undefined` guard is the classifier's job, not this predicate's.
function hasCompletePrimary(tasks: Task[]): boolean {
  return tasks.some((t) => COMPLETE_LIKE.has(t.status));
}

// FG-507: a top-level ad-hoc row that has not reached a terminal status is a
// live `forge invoke` container, dispatched outside the workflow entirely. No
// step's settle state describes it — the settle-state pass skips it, as the
// ready queue must — so settledness has to see it here, or a concurrent
// `forge next` / `forge gate` finalizes the run out from under a container that
// is still writing its result. Terminal ad-hoc rows say nothing either way; the
// steps' own states decide.
function hasLiveAdHocInvokeTask(tasks: Task[]): boolean {
  return tasks.some(
    (t) =>
      t.parentId === undefined &&
      isAdHocInvokeRow(t) &&
      t.status !== "complete" &&
      t.status !== "failed",
  );
}

// Moved verbatim from ready-queue.ts's computeReadyQueue (FG-519/FG-476/FG-528
// rationale unchanged). Returns the steps ready to dispatch RIGHT NOW: deps met
// and no live primary/recovery already covering the phase.
function computeReadyWork(workflow: Workflow, tasks: Task[]): Step[] {
  const kinds = classifyTaskLineage(workflow, tasks);
  const kindOf = (t: Task): LineageKind => kinds.get(t.id)!;

  const tasksByPhase = new Map<string, Task[]>();
  for (const t of tasks) {
    if (kindOf(t) === "adhoc_invoke") continue;
    const arr = tasksByPhase.get(t.phase) ?? [];
    arr.push(t);
    tasksByPhase.set(t.phase, arr);
  }

  const ready: Step[] = [];
  for (const step of workflow.steps) {
    const existing = tasksByPhase.get(step.id) ?? [];

    // A phase with a COMPLETE primary is done — skip it, even if a stray pending
    // primary also exists. That pairing (complete + pending primary) is only ever
    // produced by the duplicate-primary bug: `forge retry` mints a parallel
    // pending primary, and if another rerun path completes the phase first, the
    // retry's pending row is left orphaned. Re-dispatching here would run a
    // redundant wave; treating the complete primary as authoritative ignores the
    // orphan. Legit retries never hit this: there the old primary is `failed`,
    // not `complete`, so there's no complete primary to skip on.
    //
    // EXCEPTION (FG-476): a live pending on_reject recovery task targeting this
    // phase means gate.ts's reject branch fired on_reject back at an already-
    // complete step (security-audit.yml's audit->investigate shape). That
    // recovery task must still be admitted to the ready set so it actually
    // dispatches — otherwise it sits pending forever (isRunSettled correctly
    // keeps the run "active" per FG-475, but nothing ever runs to settle it).
    // A fanout/red child (parentId-tagged, no marker) does NOT qualify — this
    // must never broaden to "any parentId-tagged task re-admits the phase".
    const hasLiveRecovery = existing.some(
      (t) => t.status === "pending" && kindOf(t) === "on_reject_recovery",
    );
    if (resolveCompletedPhasePrimary(existing, step.id) !== undefined && !hasLiveRecovery) continue;

    // No complete primary. Only the phase's own ATTEMPT rows answer "does this
    // step still need dispatch": the classifier's primary kinds and an on_reject
    // recovery. A red/fanout child is not an attempt — counting one (FG-528) let
    // a terminally-failed primary with a still-pending red child fall through as
    // ready, and dispatchSingleStep, finding no pending primary and no recovery,
    // minted a fresh primary and silently reran a terminal failure.
    //
    // Among the attempts: none pending ⇒ in progress or terminally
    // failed-without-retry, not ready. A pending one (fresh dispatch, a gate
    // request-changes / retry replacement, or a live recovery) ⇒ deps check.
    const attempts = existing.filter(
      (t) => isWorkflowPrimaryRow(kindOf(t)) || kindOf(t) === "on_reject_recovery",
    );
    if (attempts.length > 0 && !attempts.some((t) => t.status === "pending")) continue;

    // Deps: a dependency phase is satisfied when it has a COMPLETE primary —
    // resolveCompletedPhasePrimary (FG-519) returns the latest-complete parent-less
    // row, and `!== undefined` is the presence check. Selecting by "latest complete"
    // rather than "latest primary regardless of status" is what stops an orphaned
    // pending duplicate primary (created after, but never run) from shadowing the
    // real complete primary and permanently blocking the downstream step.
    const depsMet = step.depends_on.every(
      (depId) => resolveCompletedPhasePrimary(tasksByPhase.get(depId) ?? [], depId) !== undefined,
    );

    if (depsMet) ready.push(step);
  }

  return ready;
}

// Moved verbatim from ready-queue.ts's computeStepSettleStates. A run is settled
// when every step is either COMPLETE or permanently BLOCKED; any ACTIVE step means
// outstanding work. The recursive definition treats a step downstream of a
// terminally-failed dependency as unreachable (blocked) rather than pending.
function computeStepSettleStates(workflow: Workflow, tasks: Task[]): Map<string, StepSettle> {
  const tasksByPhase = new Map<string, Task[]>();
  // gate.ts's reject->on_reject path inserts a fresh recovery task whose
  // parentId is the REJECTED task's id — lineage ("who rejected me"), not
  // fanout ("who spawned me as a child"). Phase equality can't distinguish the
  // two: a self-referencing on_reject (on_reject === step.id) puts the recovery
  // task in the SAME phase as the primary it's recovering. The classifier keys
  // off the explicit marker instead (on_reject_recovery kind).
  const recoveryTasksByPhase = new Map<string, Task[]>();
  const kinds = classifyTaskLineage(workflow, tasks);
  for (const t of tasks) {
    // An ad-hoc invoke row is not this workflow's work; it can neither complete
    // a step nor keep one active. Skipped here for the same reason the ready
    // queue skips it — otherwise the two disagree on a `task`-step workflow. A
    // LIVE one still blocks the run from settling, surfaced as liveAdHocInvoke.
    const kind = kinds.get(t.id)!;
    if (kind === "adhoc_invoke") continue;
    if (kind === "on_reject_recovery") {
      const arr = recoveryTasksByPhase.get(t.phase) ?? [];
      arr.push(t);
      recoveryTasksByPhase.set(t.phase, arr);
      continue;
    }
    if (!isWorkflowPrimaryRow(kind)) continue; // red/fanout child — ignore
    const arr = tasksByPhase.get(t.phase) ?? [];
    arr.push(t);
    tasksByPhase.set(t.phase, arr);
  }
  const stepsById = new Map(workflow.steps.map((s) => [s.id, s]));
  const states = new Map<string, StepSettle>();

  function resolve(stepId: string): StepSettle {
    const cached = states.get(stepId);
    if (cached) return cached;
    // Cycle defensive-guard (schema already forbids cycles, but never hang here).
    states.set(stepId, "active");

    const step = stepsById.get(stepId);
    const primaries = tasksByPhase.get(stepId) ?? [];
    const recoveryTasks = recoveryTasksByPhase.get(stepId) ?? [];

    let state: StepSettle;
    if (recoveryTasks.some((t) => t.status !== "failed" && !COMPLETE_LIKE.has(t.status))) {
      // A live (pending/running/...) on_reject recovery task targeting this
      // phase — even when the phase already has a complete primary left over
      // from before the reject. There is real outstanding work here again.
      state = "active";
    } else if (hasCompletePrimary(primaries)) {
      state = "complete";
    } else if (primaries.some((t) => t.status !== "failed")) {
      // A live primary — pending (fresh dispatch or retry replacement), running,
      // awaiting_gate, awaiting_red, or blocked_by_red — means there is still
      // work in flight or a human decision outstanding. Not settled.
      state = "active";
    } else if (!step) {
      state = "active";
    } else {
      // No primary rows yet, or only terminally-failed primaries with no
      // pending replacement. Reachability now depends entirely on deps.
      const depStates = step.depends_on.map((depId) => resolve(depId));
      if (depStates.some((s) => s === "blocked")) {
        // A dep is permanently unreachable ⇒ this step can never dispatch either.
        state = "blocked";
      } else if (depStates.every((s) => s === "complete")) {
        state = primaries.length === 0
          ? "active" // deps satisfied, no task row yet ⇒ ready-queue will dispatch it
          : "blocked"; // deps satisfied but this step's own primary(s) are terminally failed
      } else {
        // Some dep is still active (in progress) — this step's fate isn't
        // determined yet, but the run is already not-settled because of that dep.
        state = "active";
      }
    }

    states.set(stepId, state);
    return state;
  }

  for (const step of workflow.steps) resolve(step.id);
  return states;
}

// Invoke / no-step run: settled iff no top-level task is still non-terminal.
// A failed top-level task is SUPERSEDED (and does not fail the run) when another
// top-level task in the same phase is not failed — the retry-replacement shape,
// matching the heuristic runNext used before this classifier existed.
function classifyInvokeTerminalState(tasks: Task[]): RunTerminalClassification | null {
  const topLevel = tasks.filter((t) => t.parentId === undefined);
  // No top-level work at all ⇒ settled with nothing failed (the review-loop
  // eager-run shape: a run row created before any dispatch that stops with zero
  // tasks). Callers that must NOT complete an empty run — reconcile, which may
  // be racing a not-yet-inserted task — guard on task count before classifying.
  if (topLevel.length === 0) return { status: "complete", failedPhases: [], unreachablePhases: [] };
  if (topLevel.some((t) => t.status !== "complete" && t.status !== "failed")) return null;
  const failedPhases = topLevel
    .filter(
      (t) =>
        t.status === "failed" &&
        !topLevel.some((other) => other.phase === t.phase && other.status !== "failed"),
    )
    .map((t) => t.phase);
  return failedPhases.length > 0
    ? { status: "failed", failedPhases, unreachablePhases: [] }
    : { status: "complete", failedPhases: [], unreachablePhases: [] };
}

/**
 * Evaluate a run's full lifecycle in ONE pure pass. Total over the same input
 * universe as classifyTaskLineage: any `(workflow | undefined, tasks)` yields a
 * snapshot with no throw.
 *
 * Preserves the two-shape branch verbatim: an ad-hoc invoke / no-step run
 * (`!workflow || workflow.steps.length === 0`) has an empty `steps` map, no
 * `readyWork`, and takes classifyInvokeTerminalState's settledness. There is NO
 * internal empty-run guard — callers keep their pre-call guards (reconcile's
 * `after.length > 0`, invoke's sentinel path).
 *
 * `resolveCompletedPhasePrimary` stays a STANDALONE export used internally here;
 * this provider must not swallow it — doing so would narrow deriveUpstream /
 * runNext's unfiltered caller universes (the FG-717 invariant).
 */
export function evaluateLifecycle(
  workflow: Workflow | undefined,
  tasks: Task[],
): LifecycleSnapshot {
  const liveAdHocInvoke = hasLiveAdHocInvokeTask(tasks);

  // Ad-hoc invoke run shape: no workflow steps describe the work, so the
  // top-level ad-hoc task(s) carry the outcome and settledness.
  if (!workflow || workflow.steps.length === 0) {
    const terminal = classifyInvokeTerminalState(tasks);
    return {
      steps: new Map(),
      readyWork: [],
      runSettled: terminal !== null,
      liveAdHocInvoke,
      terminal,
    };
  }

  const states = computeStepSettleStates(workflow, tasks);
  const readyWork = computeReadyWork(workflow, tasks);
  const readyIds = new Set(readyWork.map((s) => s.id));

  // isRunSettled's exact conjunction: no live ad-hoc invoke AND no step active.
  let anyActive = false;
  for (const state of states.values()) {
    if (state === "active") {
      anyActive = true;
      break;
    }
  }
  const runSettled = !liveAdHocInvoke && !anyActive;

  const steps = new Map<string, StepLifecycle>();
  const failedPhases: string[] = [];
  const unreachablePhases: string[] = [];
  for (const step of workflow.steps) {
    const settle = states.get(step.id)!;
    if (settle !== "blocked") {
      steps.set(step.id, { settle, ready: readyIds.has(step.id) });
      continue;
    }
    // Mirror resolve()'s precedence: a blocked dependency is the reason a step
    // is unreachable; only when every dep is complete does the block mean this
    // step's OWN primaries failed. Same split classifyRunTerminalState used, so
    // failedPhases/unreachablePhases stay in workflow-step order.
    if (step.depends_on.some((depId) => states.get(depId) === "blocked")) {
      unreachablePhases.push(step.id);
      steps.set(step.id, { settle, ready: readyIds.has(step.id), blockedReason: "dependency_unreachable" });
    } else {
      failedPhases.push(step.id);
      steps.set(step.id, { settle, ready: readyIds.has(step.id), blockedReason: "own_primaries_failed" });
    }
  }

  const terminal: RunTerminalClassification | null = runSettled
    ? {
        status: failedPhases.length > 0 || unreachablePhases.length > 0 ? "failed" : "complete",
        failedPhases,
        unreachablePhases,
      }
    : null;

  return { steps, readyWork, runSettled, liveAdHocInvoke, terminal };
}
