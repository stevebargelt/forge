import type { GateDecision, Task, VerdictRow } from "../types/index.js";
import { getTask, setTaskStatus, insertTask, tasksForRun } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import { insertGate } from "../store/gates.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { newGateId, newTaskId, nowIso } from "../util/ids.js";
import { findPhase, loadWorkflow, nextPhaseAfter } from "./workflows.js";
import { stopSsoWatchdog } from "../util/sso-watchdog.js";

export type GateOptions = {
  force?: boolean;        // override blocked_by_red
  decidedBy?: string;     // default "steven"
};

// Verdict aggregation rule (from sketch):
//   pass if all reds pass; fail if any authoritative fails; inconclusive otherwise.
//   Specialist fails warn but don't block without rationale.
export type AggregatedVerdict = {
  verdict: "pass" | "fail" | "inconclusive";
  authoritativeFails: VerdictRow[];
  specialistFails: VerdictRow[];
};

export function aggregateVerdicts(verdicts: VerdictRow[]): AggregatedVerdict {
  const authoritativeFails = verdicts.filter(
    (v) => v.verdict === "fail" && v.authority === "authoritative"
  );
  const specialistFails = verdicts.filter(
    (v) => v.verdict === "fail" && v.authority === "specialist"
  );
  if (authoritativeFails.length > 0) {
    return { verdict: "fail", authoritativeFails, specialistFails };
  }
  if (verdicts.length > 0 && verdicts.every((v) => v.verdict === "pass")) {
    return { verdict: "pass", authoritativeFails, specialistFails };
  }
  return { verdict: "inconclusive", authoritativeFails, specialistFails };
}

export async function gate(
  taskId: string,
  decision: GateDecision,
  rationale: string | undefined,
  opts: GateOptions = {}
): Promise<{ task: Task; nextTasks: Task[] }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const blocked = task.status === "blocked_by_red";
  if (blocked && !opts.force) {
    throw new Error(
      `Task ${taskId} is blocked_by_red. Re-run with --force --rationale "..." to override.`
    );
  }
  if (task.status !== "awaiting_gate" && !blocked) {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not awaiting_gate. Cannot gate.`
    );
  }

  const run = getRun(task.runId);
  if (!run) throw new Error(`Run not found for task ${taskId}`);
  const workflow = await loadWorkflow(run.workflow);
  const phase = findPhase(workflow, task.phase);
  if (!phase) throw new Error(`Phase ${task.phase} not in workflow ${workflow.name}`);

  // Re-check verdicts on advance. Two checks:
  //   1. Authoritative fail → block unless --force. Only applies to verdict-
  //      gated phases (human-gated phases get authoritative-red protection
  //      via the blocked_by_red status check at line 51).
  //   2. Specialist fail → require rationale. Applies to BOTH gate types
  //      (#110). Without this, a human-gated phase with a specialist red fail
  //      lets the human advance without any audit trail for overriding the
  //      red's objection. The whole point of attaching specialist reds is
  //      that their fails should at least force the human to acknowledge.
  if (decision === "advance" && !opts.force) {
    const verdicts = verdictsForTask(taskId);
    const agg = aggregateVerdicts(verdicts);
    if (phase.gate === "verdict" && agg.verdict === "fail") {
      throw new Error(
        `Cannot advance ${taskId}: verdict aggregation = fail. Authoritative fails: ${agg.authoritativeFails
          .map((v) => v.redRole)
          .join(", ")}. Override with --force --rationale "...".`
      );
    }
    if (agg.specialistFails.length > 0 && !rationale) {
      throw new Error(
        `Specialist red(s) failed on ${taskId}: ${agg.specialistFails
          .map((v) => v.redRole)
          .join(", ")}. Provide --rationale to advance over their objections.`
      );
    }
  }

  insertGate({
    id: newGateId(),
    taskId,
    decision,
    rationale,
    decidedAt: nowIso(),
    decidedBy: opts.decidedBy ?? "steven",
  });
  logEvent("gate.decided", { runId: run.id, taskId, payload: { decision, rationale, force: opts.force ?? false } });

  let nextTasks: Task[] = [];
  if (decision === "advance") {
    setTaskStatus(taskId, "complete");
    logEvent("task.completed", { runId: run.id, taskId });
    // Create next-phase tasks if siblings have all advanced.
    const refreshed = getTask(taskId)!;
    const allSiblings = (await import("../store/tasks.js")).tasksForRunPhase(refreshed.runId, refreshed.phase);
    const allAdvanced = allSiblings.every(
      (t) => t.status === "complete" || t.status === "failed"
    );
    if (allAdvanced) {
      const np = nextPhaseAfter(workflow, refreshed.phase);
      if (np) {
        const perAgentInputs = deriveFanoutInputs(np, allSiblings);
        nextTasks = (await import("./next.js")).createPhaseTasks(run, workflow, np.name, {
          parentId: refreshed.id,
          perAgentInputs,
        });
      } else {
        // Terminal phase + every sibling advanced + no successor → run is done.
        // #41 closed this for next()'s auto-gate path; gate() needs the same finalize
        // for the human-gate path (gating from CLI/dashboard never re-enters next()).
        updateRunStatus(run.id, "complete");
        logEvent("run.completed", { runId: run.id });
        stopSsoWatchdog();
      }
    }
  } else if (decision === "reject") {
    setTaskStatus(taskId, "failed");
    logEvent("task.failed", { runId: run.id, taskId, payload: { gate: "reject", rationale } });
    if (phase.onReject) {
      const np = findPhase(workflow, phase.onReject);
      if (np) {
        // Propagate the rationale and a pointer to the rejected task so the remediation
        // phase isn't working blind. Without this it would only see upstream results.
        nextTasks = (await import("./next.js")).createPhaseTasks(run, workflow, np.name, {
          parentId: taskId,
          commonInputs: {
            rejectedRationale: rationale ?? "",
            rejectedTaskId: taskId,
          },
        });
      }
    }
  } else if (decision === "request-changes") {
    // Manual phase (FORGE-DEC-016): re-queueing would create a `pending` task with no
    // agent to dispatch — it would sit forever. The right escape hatch on a manual
    // phase is reject (loops to onReject) or advance with corrected artifacts.
    if (phase.agents.length === 0) {
      throw new Error(
        `Task ${taskId} is in a manual phase ('${phase.name}'); request-changes is not supported. Use 'reject' to loop back to '${phase.onReject ?? "the prior phase"}', or re-submit with corrected artifacts.`
      );
    }
    // Re-queue same phase: create a new pending task with the rationale injected.
    const newId = newTaskId(task.phase);
    const newTask: Task = {
      id: newId,
      runId: task.runId,
      parentId: task.id,
      phase: task.phase,
      agentRole: task.agentRole,
      status: "pending",
      taskPackage: {
        ...task.taskPackage,
        taskId: newId,
        composedSystemPrompt: "",
        inputs: { ...task.taskPackage.inputs, requestedChanges: rationale ?? "" },
      },
      createdAt: nowIso(),
    };
    insertTask(newTask);
    logEvent("task.created", { runId: run.id, taskId: newId, payload: { from: "request-changes" } });
    setTaskStatus(taskId, "failed"); // close the prior task; the new one supersedes it
    nextTasks = [newTask];
  }

  return { task: getTask(taskId)!, nextTasks };
}

// If the next phase declares fanoutFromUpstream, read the named array from the most
// recent completed upstream task and produce one input record per array entry.
// Returns undefined when the phase doesn't fan out, the array is missing, or it's empty —
// callers fall back to one task per agent in that case.
// Exported for tests; internal use only.
export function deriveFanoutInputs(
  nextPhase: { fanoutFromUpstream?: { arrayKey: string; inputKey?: string } },
  upstreamSiblings: Task[]
): Array<Record<string, unknown>> | undefined {
  const cfg = nextPhase.fanoutFromUpstream;
  if (!cfg) return undefined;

  const completed = upstreamSiblings.filter((t) => t.status === "complete" && t.result);
  if (completed.length === 0) return undefined;

  // For now: pick the first completed upstream task. In a multi-agent upstream phase
  // this would aggregate; that's a future extension when a workflow needs it.
  const result = completed[0]!.result as Record<string, unknown>;
  const raw = result[cfg.arrayKey];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const inputKey = cfg.inputKey ?? singularize(cfg.arrayKey);
  return raw.map((entry) => ({ [inputKey]: entry }));
}

function singularize(s: string): string {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("ses")) return s.slice(0, -2);
  if (s.endsWith("s")) return s.slice(0, -1);
  return s;
}

export type BatchGateResult = {
  runId: string;
  decision: GateDecision;
  // Tasks the caller actually advanced (status was awaiting_gate at the time of the call).
  gated: Array<{ taskId: string; followups: number }>;
  // Tasks skipped because they were blocked_by_red — those need per-task --force + rationale.
  skippedBlocked: Array<{ taskId: string; phase: string }>;
  // Per-task gate failures (e.g. the task transitioned out from under us). Rare; surface for
  // visibility rather than silently ignore.
  failed: Array<{ taskId: string; error: string }>;
};

// Batch-gate every awaiting_gate task in a run. Initial scope per BACKLOG #40:
// 'advance' only. reject and request-changes typically need per-task rationale and
// don't make sense in bulk. blocked_by_red tasks are skipped (the caller can gate
// those individually with --force --rationale "...").
export async function batchGate(
  runId: string,
  decision: GateDecision,
  rationale: string | undefined,
  opts: GateOptions = {}
): Promise<BatchGateResult> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (decision !== "advance") {
    throw new Error(
      `batchGate currently supports 'advance' only. ` +
        `${decision} typically needs per-task rationale; gate those individually.`
    );
  }

  const tasks = tasksForRun(runId);
  const eligible = tasks.filter((t) => t.status === "awaiting_gate");
  const blocked = tasks.filter((t) => t.status === "blocked_by_red");

  const result: BatchGateResult = {
    runId,
    decision,
    gated: [],
    skippedBlocked: blocked.map((t) => ({ taskId: t.id, phase: t.phase })),
    failed: [],
  };

  for (const t of eligible) {
    try {
      const r = await gate(t.id, decision, rationale, opts);
      result.gated.push({ taskId: t.id, followups: r.nextTasks.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed.push({ taskId: t.id, error: msg });
    }
  }

  return result;
}
