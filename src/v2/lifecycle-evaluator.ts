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

import type { Workflow } from "./schema.js";
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
