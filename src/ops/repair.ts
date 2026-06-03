// Ops intelligence substrate (#250) — the repair half. The action counterpart to
// detect.ts: a narrowly-scoped, shape-guarded fix for ONE impossible DB state,
// not a generic "cancel any task." The shape guard is the point — it is what
// makes the repair trustworthy enough for the orchestrator to run on `ask`.
//
// retry_orphan repair (#232): a pending task stranded under a terminal run will
// never dispatch (forge next treats the run as terminal). The fix is to mark the
// dead pending task failed (orphaned) — it clears the inconsistency without
// resurrecting a deliberately-closed run. If the work is still wanted, re-invoke
// (the documented #232 workaround). Run status is deliberately left untouched.

import { getTask, markTaskFailed } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";

const TERMINAL_RUN = new Set(["complete", "abandoned"]);
const ORPHAN_ERROR = "orphaned: pending task under a terminal run, reconciled via forge ops repair";

export type OpsRepairOutcome =
  | { kind: "repaired"; taskId: string; runId: string; dryRun: boolean }
  | { kind: "refused"; id: string; reason: string }
  | { kind: "unknown"; id: string };

/** Repair a single retry_orphan. Refuses anything that is not exactly the orphan
 *  shape (pending task whose parent run is terminal). dry-run writes nothing. */
export function performOpsRepair(taskId: string, opts: { dryRun?: boolean } = {}): OpsRepairOutcome {
  const task = getTask(taskId);
  if (!task) return { kind: "unknown", id: taskId };

  if (task.status !== "pending") {
    return { kind: "refused", id: taskId, reason: `task is ${task.status}, not pending — not a retry_orphan` };
  }
  const run = getRun(task.runId);
  if (!run) return { kind: "refused", id: taskId, reason: `run ${task.runId} not found` };
  if (!TERMINAL_RUN.has(run.status)) {
    return {
      kind: "refused",
      id: taskId,
      reason: `run ${task.runId} is ${run.status}, not terminal — task is not orphaned (forge next can still dispatch it)`,
    };
  }

  // Confirmed retry_orphan.
  if (opts.dryRun) return { kind: "repaired", taskId, runId: task.runId, dryRun: true };

  markTaskFailed(taskId, ORPHAN_ERROR);
  // Normal failure lifecycle event (the existing convention), carrying the
  // orphaned failure_kind...
  logEvent("task.failed", { runId: task.runId, taskId, payload: { failure_kind: "orphaned", error: ORPHAN_ERROR } });
  // ...plus the explicit reconciliation audit event, mirroring reconcile.ts.
  logEvent("task.reconciled", {
    runId: task.runId,
    taskId,
    payload: { from: "pending", to: "failed", reason: "retry_orphan_repaired" },
  });
  // Run status deliberately untouched — it is already terminal; the fix is the
  // task, not the run.
  return { kind: "repaired", taskId, runId: task.runId, dryRun: false };
}
