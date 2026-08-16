// forge v2 — ready-queue computation.
//
// Given a workflow and the current set of tasks in SQLite, returns the steps
// that are ready to dispatch right now: their depends_on ancestors are all
// satisfied (status complete) AND no task row exists for this step yet.
//
// "Satisfied" = the dep's task is `complete` (gate auto-advanced) OR the dep
// was advanced through a human/verdict gate (which writes a gate row that the
// dep's task status reflects as `complete`). Either way the dep's task is
// `complete` and we can proceed.
//
// Decisions encoded here (see DECISIONS.md):
// - depends_on means: ALL listed deps must be complete. No "any-of" semantics.
// - A step with no depends_on is always ready as long as no task row exists.
// - Manual steps (manual: true) are dispatchable like agent steps; the runner
//   handles them differently when it actually dispatches.
// - Fanout steps are treated as one step at the ready-queue level; the runner
//   spawns N children when dispatching, but ready-queue says "this step is ready".
//
// FG-718 (FG-477 child C): the private lifecycle derivations that used to live
// here — the ready queue, per-step settle states, the run-settled reachability
// check, and the terminal classifier — now live behind ONE pure snapshot
// provider (evaluateLifecycle) in lifecycle-evaluator.ts. The three public
// functions below are thin projections of that snapshot; each keeps its original
// signature and return type. Consumer repointing onto the snapshot directly is a
// later FG-477 slice (children D/E) — this slice is provider-only.

import type { Workflow, Step } from "./schema.js";
import type { Task } from "../types/index.js";
import {
  evaluateLifecycle,
  isAdHocInvokeRow,
  isOnRejectRecoveryRow,
  resolveCompletedPhasePrimary,
  type RunTerminalClassification,
} from "./lifecycle-evaluator.js";

// The terminal-classification shape now lives with the provider that produces it;
// re-exported here so existing consumers (status.ts, show.ts, runNext.ts) keep
// importing the type from ready-queue.js unchanged.
export type { RunTerminalClassification } from "./lifecycle-evaluator.js";

// True for a task inserted by gate.ts's reject->on_reject branch: parented to
// the rejected task (lineage, not fanout) AND carrying the explicit marker
// gate.ts stamps on every recovery task's inputs. A parentId-tagged task
// WITHOUT the marker is a genuine fanout/red child, never a recovery task.
//
// FG-477: the rule itself now lives in the lineage classifier (rule 3, the one
// rule that needs neither the workflow nor the row's phase siblings). This name
// stays for gate.ts and runNext.ts, which hold a single row and no workflow.
export function isOnRejectRecoveryTask(task: Task): boolean {
  return isOnRejectRecoveryRow(task);
}

// FG-507: a row `forge invoke` minted — including the fresh row `forge retry`
// mints to re-dispatch one through the invoke path — is dispatched directly and
// never by the workflow runner. Its phase is always `task`, an id a workflow may
// legally declare as a step, so PROVENANCE and not phase is what keeps it out of
// the workflow's bookkeeping: the ready queue, the settle states, dispatch's
// pending-primary reuse, and reconcile's orphaned-primary sweep.
//
// Without this, an attached invoke row in a `task`-declaring workflow is
// indistinguishable from that step's primary. A concurrent `forge next` in the
// window between retry's row insert and its direct dispatch would reuse the
// pending row and run it as a pipeline step (worktree merge, gates, reds) —
// exactly the semantics retry promised it would not get.
//
// Marker-less legacy rows can't be resolved here; retry refuses them up front
// rather than guess (run-kind.ts's `legacy_ambiguous_phase`).
export function isAdHocInvokeTask(task: Task): boolean {
  return isAdHocInvokeRow(task);
}

// FG-717: the canonical phase-primary selection rule lives in
// lifecycle-evaluator.ts as resolveCompletedPhasePrimary. This is a thin alias so
// the ready-queue call sites read as before; the rule (and its FG-519/FG-477
// rationale) is documented there. deriveUpstream and runNext import the evaluator
// export directly — this wrapper is for the ready-queue call sites only.
export const resolvePhasePrimary = resolveCompletedPhasePrimary;

// The steps ready to dispatch right now. FG-718: projects the snapshot's
// readyWork field (the exact Step[] this function computed before the body moved
// to the provider).
export function computeReadyQueue(workflow: Workflow, tasks: Task[]): Step[] {
  return evaluateLifecycle(workflow, tasks).readyWork;
}

// Shared "is this run settled" reachability check, consumed identically by
// gate.ts's finalizeRunIfDone (advance AND reject branches) and runNext.ts's
// two independent "is the run done" checks. A run is settled when every step is
// either COMPLETE (has a complete primary) or permanently BLOCKED (unreachable),
// and no live ad-hoc invoke container is still writing its result. FG-718:
// projects the snapshot's runSettled field.
export function isRunSettled(workflow: Workflow, tasks: Task[]): boolean {
  return evaluateLifecycle(workflow, tasks).runSettled;
}

// FG-585: the ONE shared terminal-state classifier (the FG-477 anti-drift slice).
// Every finalize site routes through this instead of re-deriving "did the run
// fail" with its own heuristic. Returns null when not settled, else the
// complete/failed classification with the failed/unreachable phase split. FG-718:
// projects the snapshot's terminal field. The two-shape branch (workflow-run vs
// invoke/no-step-run) lives in the provider; callers keep their pre-call guards
// (reconcile.ts:1631 `after.length > 0`, invoke's sentinel path).
export function classifyRunTerminalState(
  workflow: Workflow | undefined,
  tasks: Task[],
): RunTerminalClassification | null {
  return evaluateLifecycle(workflow, tasks).terminal;
}

// FG-585: one-line human summary for the failed terminal state, e.g.
// "verify failed; docs never ran". Callers (forge next / gate / show) use it so
// the phrasing stays consistent across every operator surface.
export function formatRunFailure(c: RunTerminalClassification): string {
  const parts: string[] = [];
  if (c.failedPhases.length > 0) parts.push(`${c.failedPhases.join(", ")} failed`);
  if (c.unreachablePhases.length > 0) parts.push(`${c.unreachablePhases.join(", ")} never ran`);
  return parts.join("; ") || "a required phase failed";
}
