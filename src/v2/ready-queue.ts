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
    // Skip if any task already exists for this step (regardless of status).
    // Re-dispatching a step (e.g. after reject) is handled separately by the
    // gate machinery, which inserts a fresh pending task that this function
    // will then pick up.
    const existing = tasksByPhase.get(step.id);
    if (existing && existing.length > 0) {
      // Special case: if all existing tasks for this step are failed AND a
      // pending replacement exists (e.g. from gate request-changes), the
      // replacement is the one we want to dispatch. For simplicity in v1:
      // pending is the signal that the step needs dispatch. Other statuses
      // mean "in progress or done; not ready".
      const hasPending = existing.some((t) => t.status === "pending");
      if (!hasPending) continue;
      // If a pending task exists for this step, still need to check deps.
    }

    // Check all depends_on are complete.
    const depsMet = step.depends_on.every((depId) => {
      const depTasks = tasksByPhase.get(depId);
      if (!depTasks || depTasks.length === 0) return false;
      // Use the most recent primary (non-child) task as the dep's status.
      const primary = depTasks
        .filter((t) => t.parentId === undefined)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .pop();
      if (!primary) return false;
      return COMPLETE_LIKE.has(primary.status);
    });

    if (depsMet) ready.push(step);
  }

  return ready;
}
