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
//
// stuck_run repair (FG-414): the inverse shape — an active run whose tasks are
// ALL terminal will never progress (forge next's self-healing completion check
// never ran). The fix is to mark the run abandoned, mirroring what `forge cancel
// <runId> --abandon-run` already does for this exact shape (empty non-terminal
// task set). Refuses anything that isn't a genuine orphan: any non-terminal task,
// or a live container on ANY of the run's tasks (belt-and-suspenders against a
// container that outlived its task's terminal DB write).

import { getTask, tasksForRun, markTaskFailed } from "../store/tasks.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { probeContainerLiveness, type LivenessProbe } from "./reconcile-candidate.js";
import type { Run } from "../types/index.js";

const TERMINAL_RUN = new Set(["complete", "abandoned"]);
const TERMINAL_TASK = new Set(["complete", "failed"]);
const ORPHAN_ERROR = "orphaned: pending task under a terminal run, reconciled via forge ops repair";
const STUCK_RUN_REASON = "stuck_run_repaired";

export type OpsRepairOutcome =
  | { kind: "repaired"; taskId: string; runId: string; dryRun: boolean }
  | { kind: "run-repaired"; runId: string; dryRun: boolean }
  | { kind: "refused"; id: string; reason: string }
  | { kind: "unknown"; id: string };

/** Repair a retry_orphan (task id) or a stuck_run (run id). Refuses anything
 *  that is not exactly one of those two shapes. dry-run writes nothing. */
export function performOpsRepair(
  id: string,
  opts: { dryRun?: boolean } = {},
  probe: LivenessProbe = probeContainerLiveness
): OpsRepairOutcome {
  const task = getTask(id);
  if (task) return repairRetryOrphan(task.id, task.runId, task.status, opts);

  const run = getRun(id);
  if (run) return repairStuckRun(run, opts, probe);

  return { kind: "unknown", id };
}

function repairRetryOrphan(
  taskId: string,
  runId: string,
  taskStatus: string,
  opts: { dryRun?: boolean }
): OpsRepairOutcome {
  if (taskStatus !== "pending") {
    return { kind: "refused", id: taskId, reason: `task is ${taskStatus}, not pending — not a retry_orphan` };
  }
  const run = getRun(runId);
  if (!run) return { kind: "refused", id: taskId, reason: `run ${runId} not found` };
  if (!TERMINAL_RUN.has(run.status)) {
    return {
      kind: "refused",
      id: taskId,
      reason: `run ${runId} is ${run.status}, not terminal — task is not orphaned (forge next can still dispatch it)`,
    };
  }

  // Confirmed retry_orphan.
  if (opts.dryRun) return { kind: "repaired", taskId, runId, dryRun: true };

  markTaskFailed(taskId, ORPHAN_ERROR);
  // Normal failure lifecycle event (the existing convention), carrying the
  // orphaned failure_kind...
  logEvent("task.failed", { runId, taskId, payload: { failure_kind: "orphaned", error: ORPHAN_ERROR } });
  // ...plus the explicit reconciliation audit event, mirroring reconcile.ts.
  logEvent("task.reconciled", {
    runId,
    taskId,
    payload: { from: "pending", to: "failed", reason: "retry_orphan_repaired" },
  });
  // Run status deliberately untouched — it is already terminal; the fix is the
  // task, not the run.
  return { kind: "repaired", taskId, runId, dryRun: false };
}

function repairStuckRun(run: Run, opts: { dryRun?: boolean }, probe: LivenessProbe): OpsRepairOutcome {
  if (run.status !== "active") {
    return { kind: "refused", id: run.id, reason: `run is ${run.status}, not active — not a stuck_run` };
  }
  const tasks = tasksForRun(run.id);
  if (tasks.length === 0) {
    return { kind: "refused", id: run.id, reason: `run ${run.id} has no tasks — nothing to repair` };
  }
  const nonTerminal = tasks.filter((t) => !TERMINAL_TASK.has(t.status));
  if (nonTerminal.length > 0) {
    return {
      kind: "refused",
      id: run.id,
      reason: `run ${run.id} has a non-terminal task (${nonTerminal[0]!.id} is ${nonTerminal[0]!.status}) — forge next can still dispatch it`,
    };
  }
  const liveTask = tasks.find((t) => probe(`forge-${t.id}`) === "alive");
  if (liveTask) {
    return {
      kind: "refused",
      id: run.id,
      reason: `task ${liveTask.id}'s container forge-${liveTask.id} is still alive — run is not orphaned`,
    };
  }

  // Confirmed stuck_run.
  if (opts.dryRun) return { kind: "run-repaired", runId: run.id, dryRun: true };

  updateRunStatus(run.id, "abandoned");
  logEvent("run.abandoned", { runId: run.id, payload: { via: "forge ops repair", reason: STUCK_RUN_REASON } });
  logEvent("run.reconciled", { runId: run.id, payload: { from: "active", to: "abandoned", reason: STUCK_RUN_REASON } });
  return { kind: "run-repaired", runId: run.id, dryRun: false };
}
