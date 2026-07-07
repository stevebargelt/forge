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

const COMPLETE_LIKE: ReadonlySet<string> = new Set(["complete"]);

// True for a task inserted by gate.ts's reject->on_reject branch: parented to
// the rejected task (lineage, not fanout) AND carrying the explicit marker
// gate.ts stamps on every recovery task's inputs. A parentId-tagged task
// WITHOUT the marker is a genuine fanout/red child, never a recovery task.
export function isOnRejectRecoveryTask(task: Task): boolean {
  return task.parentId !== undefined && task.taskPackage.inputs?.["rejectedTaskId"] !== undefined;
}

export function computeReadyQueue(workflow: Workflow, tasks: Task[]): Step[] {
  const tasksByPhase = new Map<string, Task[]>();
  for (const t of tasks) {
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
      (t) => t.status === "pending" && isOnRejectRecoveryTask(t),
    );
    if (hasCompletePrimary(existing) && !hasLiveRecovery) continue;

    // No complete primary. If a task row exists but none is pending, the step is
    // in progress or terminally failed-without-retry — not ready. A pending row
    // (fresh dispatch, or a gate request-changes / retry replacement) means the
    // step still needs dispatch, so fall through to the deps check.
    if (existing.length > 0 && !existing.some((t) => t.status === "pending")) continue;

    // Deps: a dependency phase is satisfied if ANY of its primaries is complete —
    // not just the most-recent one. Using "most recent" let an orphaned pending
    // duplicate primary (created after, but never run) shadow the real complete
    // primary, permanently blocking the downstream step. "Any complete" is
    // identical to "most recent" in the normal one-primary-per-phase case and in
    // legit retries (old failed + new pending ⇒ no complete ⇒ still blocks until
    // the retry completes); it only diverges to fix the duplicate-primary bug.
    const depsMet = step.depends_on.every((depId) =>
      hasCompletePrimary(tasksByPhase.get(depId) ?? []),
    );

    if (depsMet) ready.push(step);
  }

  return ready;
}

// True when at least one primary (non-child) task in the set is complete.
function hasCompletePrimary(tasks: Task[]): boolean {
  return tasks.some((t) => t.parentId === undefined && COMPLETE_LIKE.has(t.status));
}

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

export function isRunSettled(workflow: Workflow, tasks: Task[]): boolean {
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
  for (const t of tasks) {
    if (t.parentId !== undefined) {
      if (!isOnRejectRecoveryTask(t)) continue; // red/fanout child — ignore
      const arr = recoveryTasksByPhase.get(t.phase) ?? [];
      arr.push(t);
      recoveryTasksByPhase.set(t.phase, arr);
      continue;
    }
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
