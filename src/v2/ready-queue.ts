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
    if (hasCompletePrimary(existing)) continue;

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
