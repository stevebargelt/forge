// Reconciliation: recover from orphaned tasks where the agent finished but forge lost track.
//
// Symptom: a task is `running` in the DB, but result.json exists on disk and the container is gone.
// Cause: the docker child process didn't fire 'close' to the Node parent — terminal exited, signal
// dropped, etc. The agent did its job; forge just didn't observe the finish.
//
// Recovery: parse the on-disk result, write the verdict (if red), transition status the same way
// spawn()+spawnRed() would have. Idempotent: tasks not in `running` status are skipped.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, Workflow, Phase, RedAuthority } from "../types/index.js";
import { tasksForRun, getTask, markTaskComplete, markTaskFailed, markTaskAwaitingGate, setTaskStatus } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { logEvent } from "../store/events.js";
import { findPhase } from "./workflows.js";
import { taskDir } from "../util/paths.js";
import { newVerdictId, nowIso } from "../util/ids.js";
import { getDb } from "../store/db.js";

// Test seam: when set, this fault is thrown at the named point inside the
// reconcileTask transaction. Lets fault-injection tests verify the txn
// rolls back without resorting to monkey-patching the store module. Not
// part of the public API; production code never sets this.
let _injectedFault: { afterStep: ReconcileStep; error: Error } | null = null;
type ReconcileStep =
  | "after-mark-blue"
  | "after-log-completed"
  | "after-insert-verdict"
  | "after-log-verdict";
export function _setReconcileFaultForTest(
  step: ReconcileStep | null,
  error?: Error
): void {
  _injectedFault = step ? { afterStep: step, error: error ?? new Error("injected") } : null;
}
function _fault(at: ReconcileStep): void {
  if (_injectedFault && _injectedFault.afterStep === at) {
    throw _injectedFault.error;
  }
}

export type ReconciledTask = {
  taskId: string;
  resolution: "complete" | "failed" | "still_running";
};

export function reconcileRun(runId: string, workflow: Workflow): ReconciledTask[] {
  const tasks = tasksForRun(runId);
  // Manual-phase tasks (FORGE-DEC-016) never go through reconcile — they have no
  // result.json on disk, only get a result via `forge submit`.
  // awaiting_red blues (FORGE-DEC-017) are also intentionally skipped — they're
  // not orphaned; reds are running. If a red itself crashes the blue stays in
  // awaiting_red indefinitely; that's tracked separately (similar shape to #74).
  const running = tasks.filter((t) => t.status === "running");
  const out: ReconciledTask[] = [];
  for (const t of running) {
    out.push(reconcileTask(t, workflow, tasks));
  }
  return out;
}

function reconcileTask(task: Task, workflow: Workflow, allTasks: Task[]): ReconciledTask {
  const resultPath = join(taskDir(task.runId, task.id), "result.json");
  if (!existsSync(resultPath)) {
    return { taskId: task.id, resolution: "still_running" };
  }
  const raw = readFileSync(resultPath, "utf8").trim();
  if (!raw) {
    return { taskId: task.id, resolution: "still_running" };
  }
  const parsed = tryParseJson(raw);

  // From here on, every branch performs multiple DB writes per task. Wrap in
  // a transaction so a failure mid-sequence (disk full, constraint violation,
  // testing fault injection) rolls back the whole task — no half-written
  // state where status is updated but verdict/event aren't. Per #109. The
  // transaction also speeds up the multi-write case slightly (one commit
  // instead of N).
  const tx = getDb().transaction((): ReconciledTask => {
    if (!parsed) {
      markTaskFailed(task.id, "reconcile: result.json present but unparseable");
      logEvent("task.failed", { runId: task.runId, taskId: task.id, payload: { reconciled: true } });
      return { taskId: task.id, resolution: "failed" };
    }

    const reportedStatus =
      typeof (parsed as { status?: unknown }).status === "string"
        ? ((parsed as { status: string }).status as string)
        : undefined;

    if (reportedStatus === "failed") {
      const errMsg = (parsed as { error?: string }).error ?? "agent reported failure";
      markTaskFailed(task.id, errMsg, parsed);
      logEvent("task.failed", { runId: task.runId, taskId: task.id, payload: { reconciled: true } });
      return { taskId: task.id, resolution: "failed" };
    }

    if (reportedStatus !== "complete") {
      // Same contract as spawn(): result without a recognized status is a failure, not
      // a silent pass. Reconcile follows the same rule so orphaned tasks recovered later
      // get the same treatment as live spawns.
      const reason = reportedStatus
        ? `reconcile: unrecognized_status:${reportedStatus}`
        : "reconcile: missing_status";
      markTaskFailed(task.id, reason, parsed);
      logEvent("task.failed", { runId: task.runId, taskId: task.id, payload: { reconciled: true, reason } });
      return { taskId: task.id, resolution: "failed" };
    }

    if (!task.parentId) {
      const taskPhase = findPhase(workflow, task.phase);
      if (taskPhase?.gate === "auto") {
        markTaskComplete(task.id, parsed);
      } else {
        markTaskAwaitingGate(task.id, parsed);
      }
    } else {
      markTaskComplete(task.id, parsed);
    }
    _fault("after-mark-blue");
    logEvent("task.completed", { runId: task.runId, taskId: task.id, payload: { reconciled: true } });
    _fault("after-log-completed");

    // If this is a red task (parent exists and parent's phase has reds), write the verdict
    // and transition the parent's status the way spawnRed() would.
    if (task.parentId) {
      const parent = allTasks.find((t) => t.id === task.parentId);
      if (parent) {
        const phase = findPhase(workflow, parent.phase);
        if (phase?.reds) {
          const verdict = parseVerdict(parsed);
          insertVerdict({
            id: newVerdictId(),
            taskId: parent.id,
            redTaskId: task.id,
            redRole: task.agentRole,
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            authority: phase.reds.authority,
            findings: verdict.findings,
            createdAt: nowIso(),
          });
          _fault("after-insert-verdict");
          logEvent("verdict.received", {
            runId: task.runId,
            taskId: parent.id,
            payload: { redRole: task.agentRole, verdict: verdict.verdict, reconciled: true },
          });
          _fault("after-log-verdict");
          // Re-evaluate the parent's gate status. Only do this if the parent is still in a
          // pre-gate state — if the user already gated it, leave it alone.
          const refreshedParent = getTask(parent.id);
          if (refreshedParent && (refreshedParent.status === "complete" || refreshedParent.status === "running")) {
            maybeBlockOrAwait(parent, phase, verdict.verdict, phase.reds.authority);
          }
        }
      }
    }

    return { taskId: task.id, resolution: "complete" };
  });

  try {
    return tx();
  } catch (err) {
    // The transaction rolled back; the task stays in `running` and reconcile
    // can re-attempt on a future invocation. Log so the failure is auditable.
    // We deliberately don't write to the DB here because the failure may
    // itself be a DB write failure.
    process.stderr.write(
      `[reconcile] transaction failed for task ${task.id}: ${(err as Error).message}\n`
    );
    return { taskId: task.id, resolution: "still_running" };
  }
}

function maybeBlockOrAwait(
  parent: Task,
  phase: Phase,
  redVerdict: "pass" | "fail" | "inconclusive",
  authority: RedAuthority
): void {
  if (
    phase.reds?.gateOnVerdict &&
    authority === "authoritative" &&
    redVerdict === "fail"
  ) {
    setTaskStatus(parent.id, "blocked_by_red");
    logEvent("task.blocked_by_red", { runId: parent.runId, taskId: parent.id });
  } else if (phase.gate !== "auto") {
    setTaskStatus(parent.id, "awaiting_gate");
  }
}

function parseVerdict(output: unknown): {
  verdict: "pass" | "fail" | "inconclusive";
  confidence: number;
  findings: import("../types/index.js").Finding[];
} {
  const obj = (output ?? {}) as Record<string, unknown>;
  const verdict =
    obj.verdict === "pass" || obj.verdict === "fail" || obj.verdict === "inconclusive"
      ? obj.verdict
      : "inconclusive";
  const confidence =
    typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
      ? obj.confidence
      : 0.5;
  const findings = Array.isArray(obj.findings)
    ? (obj.findings as import("../types/index.js").Finding[])
    : [];
  return { verdict, confidence, findings };
}

function tryParseJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
