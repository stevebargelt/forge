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
import { tasksForRun, getTask, markTaskComplete, markTaskFailed, setTaskStatus } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { logEvent } from "../store/events.js";
import { findPhase } from "./workflows.js";
import { taskDir } from "../util/paths.js";
import { newVerdictId, nowIso } from "../util/ids.js";

export type ReconciledTask = {
  taskId: string;
  resolution: "complete" | "failed" | "still_running";
};

export function reconcileRun(runId: string, workflow: Workflow): ReconciledTask[] {
  const tasks = tasksForRun(runId);
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
  if (!parsed) {
    markTaskFailed(task.id, "reconcile: result.json present but unparseable");
    logEvent("task.failed", { runId: task.runId, taskId: task.id, payload: { reconciled: true } });
    return { taskId: task.id, resolution: "failed" };
  }

  const reportedStatus =
    typeof (parsed as { status?: unknown }).status === "string"
      ? ((parsed as { status: string }).status as string)
      : "complete";

  if (reportedStatus === "failed") {
    const errMsg = (parsed as { error?: string }).error ?? "agent reported failure";
    markTaskFailed(task.id, errMsg, parsed);
    logEvent("task.failed", { runId: task.runId, taskId: task.id, payload: { reconciled: true } });
    return { taskId: task.id, resolution: "failed" };
  }

  markTaskComplete(task.id, parsed);
  logEvent("task.completed", { runId: task.runId, taskId: task.id, payload: { reconciled: true } });

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
        logEvent("verdict.received", {
          runId: task.runId,
          taskId: parent.id,
          payload: { redRole: task.agentRole, verdict: verdict.verdict, reconciled: true },
        });
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
