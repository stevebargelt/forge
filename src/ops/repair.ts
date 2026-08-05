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

//
// resurrected_gate_decision repair (FG-676): the third shape — a task row sitting
// at `awaiting_gate` whose event stream's newest terminal fact is a gate
// rejection. A human decided it; a later write moved it back off its terminal
// status and NULLed its error, leaving a phantom blocker no agent runs for and no
// gate decision resolves. The event stream is authoritative here (it is the only
// surviving copy of the rejection error), so the repair RECONSTRUCTS the terminal
// row from it rather than inventing a disposition — and refuses by name whenever
// the events do not PROVE the shape. It is operator-invoked by design: nothing in
// a wave or any autonomous path performs it, because these rows are audit history.

import { getTask, tasksForRun, markTaskFailed, restoreTaskFailed } from "../store/tasks.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { logEvent, eventsForTask, type Event } from "../store/events.js";
import { getDb, writeTransaction } from "../store/db.js";
import { probeContainerLiveness, type LivenessProbe } from "./reconcile-candidate.js";
import type { Run, Task } from "../types/index.js";

const TERMINAL_RUN = new Set(["complete", "failed", "abandoned"]);
const TERMINAL_TASK = new Set(["complete", "failed"]);
const ORPHAN_ERROR = "orphaned: pending task under a terminal run, reconciled via forge ops repair";
const STUCK_RUN_REASON = "stuck_run_repaired";
const RESURRECTED_GATE_REASON = "resurrected_gate_decision_repaired";

export type OpsRepairOutcome =
  | { kind: "repaired"; taskId: string; runId: string; dryRun: boolean }
  | { kind: "run-repaired"; runId: string; dryRun: boolean }
  // FG-676: a DISTINCT outcome from "repaired" — the retry_orphan wording
  // ("marked failed (orphaned)") names the wrong cause for a row whose terminal
  // state is being reinstated, not invented. Carries the error recovered from the
  // event stream so the CLI can show the operator what was restored.
  | { kind: "gate-decision-restored"; taskId: string; runId: string; dryRun: boolean; restoredError: string }
  | { kind: "refused"; id: string; reason: string }
  | { kind: "unknown"; id: string };

/** Repair a retry_orphan (task id), a resurrected_gate_decision (task id) or a
 *  stuck_run (run id). Refuses anything that is not exactly one of those three
 *  shapes. dry-run writes nothing. */
export function performOpsRepair(
  id: string,
  opts: { dryRun?: boolean } = {},
  probe: LivenessProbe = probeContainerLiveness
): OpsRepairOutcome {
  const task = getTask(id);
  // FG-676: status discriminates the two task-shaped repairs cleanly — a
  // retry_orphan is strictly `pending`, so an `awaiting_gate` row is never one.
  // Routing it through repairRetryOrphan would refuse it as "not pending", which
  // names neither the condition nor its fix.
  if (task) {
    return task.status === "awaiting_gate"
      ? repairResurrectedGateDecision(task, opts)
      : repairRetryOrphan(task.id, task.runId, task.status, opts);
  }

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

/** The newest task.failed / task.completed on a task's stream — the same
 *  "latest terminal lifecycle event wins" rule failureKindFromEvents applies,
 *  kept explicit here so each refusal can name WHICH fact blocked it (a recovery
 *  reads differently from a wrong failure kind). Non-terminal events in between
 *  — including the task.awaiting_gate the resurrection wrote — are walked past. */
function latestTerminalLifecycleEvent(events: Event[]): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.eventType === "task.completed" || e.eventType === "task.failed") return e;
  }
  return undefined;
}

/** The raw `result` column TEXT, not the parsed value. The repair must prove it
 *  can reproduce the rejected artifact byte-for-byte before it rewrites the row —
 *  that artifact IS the audit record for why the gate rejected the task, and
 *  markTaskFailed rewrites the column on every call (NULLing it when the argument
 *  is omitted — the mistake gate.ts:332 records having had to correct once
 *  already). Read-only; the write still goes through the store accessor. */
function rawResultColumn(taskId: string): string | null {
  const row = getDb().prepare(`SELECT result FROM tasks WHERE id = ?`).get(taskId) as
    | { result: string | null }
    | undefined;
  return row?.result ?? null;
}

function repairResurrectedGateDecision(task: Task, opts: { dryRun?: boolean }): OpsRepairOutcome {
  const terminal = latestTerminalLifecycleEvent(eventsForTask(task.id));
  if (!terminal) {
    return {
      kind: "refused",
      id: task.id,
      reason: `task ${task.id} is awaiting_gate with no terminal event on its stream — it is legitimately awaiting a gate decision, not a resurrected one`,
    };
  }
  if (terminal.eventType === "task.completed") {
    return {
      kind: "refused",
      id: task.id,
      reason: `task ${task.id}'s newest terminal event is task.completed — it recovered after any earlier failure; there is no terminal state to restore`,
    };
  }
  const payload = terminal.payload as Record<string, unknown> | null;
  const failureKind = typeof payload?.["failure_kind"] === "string" ? (payload["failure_kind"] as string) : undefined;
  if (failureKind !== "gate_rejected") {
    return {
      kind: "refused",
      id: task.id,
      reason: `task ${task.id}'s newest terminal failure is ${failureKind ?? "unclassified"}, not gate_rejected — no gate-rejection evidence, so this is not a resurrected_gate_decision`,
    };
  }
  // The row's own error was NULLed by the resurrection; the event payload is the
  // only surviving copy. Without it there is no reason to restore, and inventing
  // one would put a fabricated rationale into audit history.
  const restoredError = typeof payload?.["error"] === "string" ? (payload["error"] as string) : "";
  if (restoredError.length === 0) {
    return {
      kind: "refused",
      id: task.id,
      reason: `task ${task.id}'s gate_rejected task.failed event carries no error string — refusing to restore a terminal row with a fabricated reason`,
    };
  }
  // The rejected artifact must survive the repair BYTE-IDENTICALLY. markTaskFailed
  // re-serializes whatever it is handed, so prove the round trip reproduces the
  // stored bytes before writing; if it doesn't, refuse rather than rewrite audit
  // history into a merely-equivalent shape.
  const rawBefore = rawResultColumn(task.id);
  const wouldWrite = task.result ? JSON.stringify(task.result) : null;
  if (wouldWrite !== rawBefore) {
    return {
      kind: "refused",
      id: task.id,
      reason: `task ${task.id}'s result column cannot be reproduced byte-for-byte (stored ${rawBefore === null ? "NULL" : `${rawBefore.length} bytes`}, would write ${wouldWrite === null ? "NULL" : `${wouldWrite.length} bytes`}) — refusing to rewrite the rejected artifact; the row is left untouched`,
    };
  }

  // Confirmed resurrected_gate_decision.
  if (opts.dryRun) {
    return { kind: "gate-decision-restored", taskId: task.id, runId: task.runId, dryRun: true, restoredError };
  }

  // Atomic, for the same reason gate.ts:221 wraps insertGate + gate.decided: a
  // crash between the two would leave a restored terminal row with no record that
  // a repair touched it, and FG-427 makes the events table the sole source for
  // outcome derivation. An audit repair that can lose its own audit event is
  // self-defeating.
  //
  // CAS'd on the status the shape checks above actually OBSERVED. Every one of
  // them read a snapshot; a human can decide this task in the window between them
  // and this write, and an unconditional UPDATE would overwrite that newer
  // decision — which is precisely the defect FG-676 exists to eliminate, arriving
  // through the repair meant to clean it up. On refusal: no write, NO event, and
  // the operator is told the row moved.
  let restored = false;
  writeTransaction(() => {
    restored = restoreTaskFailed(task.id, {
      error: restoredError,
      result: task.result,
      // FG-676: the TRUE terminal time, off the decision's own event. The
      // resurrection NULLed completed_at, so this event is the only surviving
      // copy — and a repair restoring audit fidelity must not stamp the row with
      // the moment of repair.
      completedAt: terminal.createdAt,
      expectedStatus: task.status,
    });
    if (!restored) return;
    // Exactly ONE event. Deliberately NOT a second task.failed: the original one
    // already carries `gate_rejected` and failureKindFromEvents reads it correctly
    // past the task.awaiting_gate the resurrection wrote, so a new terminal failure
    // would fabricate a second, contradictory disposition for one decision. This
    // records the reconciliation itself, mirroring reconcile.ts and the
    // retry_orphan repair above.
    logEvent("task.reconciled", {
      runId: task.runId,
      taskId: task.id,
      payload: { from: "awaiting_gate", to: "failed", reason: RESURRECTED_GATE_REASON },
    });
  });
  if (!restored) {
    return {
      kind: "refused",
      id: task.id,
      reason: `task ${task.id} changed underneath the repair — it was ${task.status} when the shape was checked and is ${getTask(task.id)?.status ?? "gone"} now, so a newer decision won the race; nothing was written and no repair was recorded`,
    };
  }
  // Run status deliberately untouched — restoring the rejected task changes
  // nothing about whether its replacement settled the phase.
  return { kind: "gate-decision-restored", taskId: task.id, runId: task.runId, dryRun: false, restoredError };
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
  for (const t of tasks) {
    const liveness = probe(`forge-${t.id}`);
    if (liveness === "alive") {
      return {
        kind: "refused",
        id: run.id,
        reason: `task ${t.id}'s container forge-${t.id} is still alive — run is not orphaned`,
      };
    }
    if (liveness === "unknown") {
      return {
        kind: "refused",
        id: run.id,
        reason: `task ${t.id}'s container forge-${t.id} liveness is unknown (probe failed) — refusing to abandon a run we can't confirm is orphaned`,
      };
    }
  }

  // Confirmed stuck_run.
  if (opts.dryRun) return { kind: "run-repaired", runId: run.id, dryRun: true };

  updateRunStatus(run.id, "abandoned");
  logEvent("run.abandoned", { runId: run.id, payload: { via: "forge ops repair", reason: STUCK_RUN_REASON } });
  logEvent("run.reconciled", { runId: run.id, payload: { from: "active", to: "abandoned", reason: STUCK_RUN_REASON } });
  return { kind: "run-repaired", runId: run.id, dryRun: false };
}
