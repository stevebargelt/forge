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

import type { Workflow, Step } from "./schema.js";
import type { Task } from "../types/index.js";
import {
  classifyTaskLineage,
  isAdHocInvokeRow,
  isOnRejectRecoveryRow,
  isWorkflowPrimaryRow,
  resolveCompletedPhasePrimary,
  type LineageKind,
} from "./lifecycle-evaluator.js";

const COMPLETE_LIKE: ReadonlySet<string> = new Set(["complete"]);

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

export function computeReadyQueue(workflow: Workflow, tasks: Task[]): Step[] {
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
    if (resolvePhasePrimary(existing, step.id) !== undefined && !hasLiveRecovery) continue;

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
    // resolvePhasePrimary (FG-519) returns the latest-complete parent-less row,
    // and `!== undefined` is the presence check. Selecting by "latest complete"
    // rather than "latest primary regardless of status" is what stops an orphaned
    // pending duplicate primary (created after, but never run) from shadowing the
    // real complete primary and permanently blocking the downstream step. In the
    // normal one-primary-per-phase case, and in legit retries (old failed + new
    // pending ⇒ no complete ⇒ still blocks until the retry completes), this is
    // identical to the old any-complete check; it only diverges to fix the
    // duplicate-primary bug.
    const depsMet = step.depends_on.every((depId) =>
      resolvePhasePrimary(tasksByPhase.get(depId) ?? [], depId) !== undefined,
    );

    if (depsMet) ready.push(step);
  }

  return ready;
}

// True when at least one row in the set is complete. The set is always a phase's
// classifier-derived primary rows (isWorkflowPrimaryRow), so the old inline
// `parentId === undefined` guard here is now the classifier's job.
function hasCompletePrimary(tasks: Task[]): boolean {
  return tasks.some((t) => COMPLETE_LIKE.has(t.status));
}

// FG-717: the canonical phase-primary selection rule now lives in
// lifecycle-evaluator.ts as resolveCompletedPhasePrimary. This is a thin alias so
// computeReadyQueue's call sites read as before; the rule (and its FG-519/FG-477
// rationale) is documented there. deriveUpstream and runNext import the evaluator
// export directly — this wrapper is for the ready-queue call sites only.
export const resolvePhasePrimary = resolveCompletedPhasePrimary;

// Shared "is this run settled" reachability check, consumed identically by
// gate.ts's finalizeRunIfDone (advance AND reject branches) and runNext.ts's
// two independent "is the run done" checks. A run is settled when every step
// is either COMPLETE (has a complete primary) or permanently BLOCKED
// (unreachable — its only primary(s) are terminally failed with no pending
// replacement, or a dependency is itself permanently blocked). Any step still
// ACTIVE (has a pending/running/awaiting_gate/awaiting_red/blocked_by_red
// primary, or is dispatchable right now because its deps are all complete but
// it has no task row yet) means the run still has outstanding work.
//
// This recursive definition is what "any complete primary" in computeReadyQueue
// above is missing: computeReadyQueue only asks "is this ONE step ready to
// dispatch right now" — it has no notion of "will this step EVER be ready,
// transitively". A step whose dependency failed terminally is never ready and
// never gets a task row, so a naive "does every step have a task row" check
// (the pre-fix behavior) waits forever. isRunSettled instead asks "is there
// any step that could still produce a task row or is waiting on a human", and
// treats a step downstream of a terminally-failed dependency as unreachable
// rather than pending.
type StepSettleState = "complete" | "active" | "blocked";

// FG-507: a top-level ad-hoc row that has not reached a terminal status is a
// live `forge invoke` container, dispatched outside the workflow entirely. No
// step's settle state describes it — computeStepSettleStates below skips it, as
// computeReadyQueue must — so settledness has to see it here or a concurrent
// `forge next` / `forge gate` finalizes the run out from under a container that
// is still writing its result. Terminal ad-hoc rows say nothing either way; the
// steps' own states decide.
//
// Only settledness widens. Step classification and the ready queue stay blind
// to these rows: they are run-level work, not workflow-step work, and admitting
// them to either would run an ad-hoc row as a pipeline step (worktree merge,
// gates, reds) — exactly what retry promised it would not get.
function hasLiveAdHocInvokeTask(tasks: Task[]): boolean {
  return tasks.some(
    (t) =>
      t.parentId === undefined &&
      isAdHocInvokeTask(t) &&
      t.status !== "complete" &&
      t.status !== "failed",
  );
}

export function isRunSettled(workflow: Workflow, tasks: Task[]): boolean {
  if (hasLiveAdHocInvokeTask(tasks)) return false;
  const states = computeStepSettleStates(workflow, tasks);
  for (const state of states.values()) {
    if (state === "active") return false;
  }
  return true;
}

function computeStepSettleStates(workflow: Workflow, tasks: Task[]): Map<string, StepSettleState> {
  const tasksByPhase = new Map<string, Task[]>();
  // gate.ts's reject->on_reject path inserts a fresh recovery task whose
  // parentId is the REJECTED task's id — lineage ("who rejected me"), not
  // fanout ("who spawned me as a child"). Phase equality can't distinguish the
  // two: a self-referencing on_reject (on_reject === step.id, schema-legal —
  // schema.ts only checks the target step exists) puts the recovery task in
  // the SAME phase as the primary it's recovering, indistinguishable by phase
  // from a red/fanout child. Instead key off the explicit marker gate.ts
  // stamps on every on_reject recovery task's inputs (see gate.ts's reject
  // branch): only a recovery task carries `rejectedTaskId`. A parentId-tagged
  // task without that marker is a genuine fanout/red child and is ignored.
  const recoveryTasksByPhase = new Map<string, Task[]>();
  const kinds = classifyTaskLineage(workflow, tasks);
  for (const t of tasks) {
    // An ad-hoc invoke row is not this workflow's work; it can neither complete
    // a step nor keep one active. Skipped here for the same reason
    // computeReadyQueue skips it — otherwise the two disagree on a `task`-step
    // workflow: the queue says the step is ready, settledness says it's done.
    // A LIVE one still blocks the run from settling, one level up, in
    // isRunSettled — run-level work, not step-level work.
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
  const states = new Map<string, StepSettleState>();

  function resolve(stepId: string): StepSettleState {
    const cached = states.get(stepId);
    if (cached) return cached;
    // Cycle defensive-guard (schema already forbids cycles, but never hang here).
    states.set(stepId, "active");

    const step = stepsById.get(stepId);
    const primaries = tasksByPhase.get(stepId) ?? [];
    const recoveryTasks = recoveryTasksByPhase.get(stepId) ?? [];

    let state: StepSettleState;
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

// FG-585: the ONE shared terminal-state classifier (the FG-477 anti-drift slice).
// Every finalize site routes through this instead of re-deriving "did the run
// fail" with its own heuristic. Returns:
//   - null       => NOT settled (live work or a human decision outstanding)
//   - "complete" => settled and every declared step reached a complete primary
//   - "failed"   => settled and at least one step is permanently BLOCKED (its own
//                   primaries terminally failed with no pending replacement, OR a
//                   dependency is permanently blocked → a downstream phase can
//                   never dispatch).
// A SUPERSEDED failed phase (request-changes: a complete replacement exists in
// the same phase) resolves to "complete" via hasCompletePrimary — it does NOT
// make the run failed. Reuses computeStepSettleStates/isRunSettled as the single
// source of truth; the failed/unreachable split below only labels an already
// computed "blocked" state and never re-derives settle logic.
export type RunTerminalClassification = {
  status: "complete" | "failed";
  failedPhases: string[]; // steps whose own primaries terminally failed
  unreachablePhases: string[]; // steps that can never dispatch (a dep is blocked)
};

export function classifyRunTerminalState(
  workflow: Workflow | undefined,
  tasks: Task[],
): RunTerminalClassification | null {
  // Ad-hoc invoke run shape: no workflow steps describe the work, so the
  // top-level ad-hoc task(s) carry the outcome. Kept here so invoke's
  // closeRunIfIdle and reconcile's invoke-only finalize route through the same
  // authority as workflow runs.
  if (!workflow || workflow.steps.length === 0) {
    return classifyInvokeTerminalState(tasks);
  }
  if (!isRunSettled(workflow, tasks)) return null;
  const states = computeStepSettleStates(workflow, tasks);
  const failedPhases: string[] = [];
  const unreachablePhases: string[] = [];
  for (const step of workflow.steps) {
    if (states.get(step.id) !== "blocked") continue;
    // Mirror resolve()'s precedence: a blocked dependency is the reason a step
    // is unreachable; only when every dep is complete does the block mean this
    // step's OWN primaries failed.
    if (step.depends_on.some((depId) => states.get(depId) === "blocked")) {
      unreachablePhases.push(step.id);
    } else {
      failedPhases.push(step.id);
    }
  }
  const failed = failedPhases.length > 0 || unreachablePhases.length > 0;
  return { status: failed ? "failed" : "complete", failedPhases, unreachablePhases };
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

// FG-585: one-line human summary for the failed terminal state, e.g.
// "verify failed; docs never ran". Callers (forge next / gate / show) use it so
// the phrasing stays consistent across every operator surface.
export function formatRunFailure(c: RunTerminalClassification): string {
  const parts: string[] = [];
  if (c.failedPhases.length > 0) parts.push(`${c.failedPhases.join(", ")} failed`);
  if (c.unreachablePhases.length > 0) parts.push(`${c.unreachablePhases.join(", ")} never ran`);
  return parts.join("; ") || "a required phase failed";
}
