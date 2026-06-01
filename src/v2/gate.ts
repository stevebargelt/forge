// forge v2 — gate: mark a task complete/failed, optionally seed re-dispatch.
//
// Unlike v1's gate.ts, this does NOT proactively create next-phase tasks.
// In v2 the runner's ready-queue picks up unblocked successors on the next
// runNext call. Gate's only job is to set the primary task's final status
// and, for non-advance decisions, seed a fresh `pending` task that the
// runner will pick up.
//
// Decision matrix:
//   - advance           → mark task complete (runner picks up successors)
//   - reject (no onRej) → mark task failed (run effectively halts there)
//   - reject + on_reject → mark task failed + insert pending task in on_reject step
//   - request-changes   → mark task failed + insert pending task in SAME step
//                         with `requestedChanges` in inputs (rationale)
//
// Verdict re-check on advance mirrors v1 behavior (#110):
//   - verdict-gated step + authoritative fail → block unless --force
//   - any specialist fail → require --rationale
//
// blocked_by_red also requires --force to advance.

import type { GateDecision, Task, TaskPackage, VerdictRow } from "../types/index.js";
import { getTask, setTaskStatus, insertTask, markTaskComplete } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import { insertGate } from "../store/gates.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { newGateId, newTaskId, nowIso } from "../util/ids.js";
import { loadWorkflow } from "./loader.js";
import type { Workflow, Step } from "./schema.js";
import { tasksForRun } from "../store/tasks.js";
import { failTask, classify } from "./failure-kind.js";

export type GateOptions = {
  force?: boolean;
  decidedBy?: string;
};

export type AggregatedVerdict = {
  verdict: "pass" | "fail" | "inconclusive";
  authoritativeFails: VerdictRow[];
  specialistFails: VerdictRow[];
};

export function aggregateVerdicts(verdicts: VerdictRow[]): AggregatedVerdict {
  const authoritativeFails = verdicts.filter(
    (v) => v.verdict === "fail" && v.authority === "authoritative",
  );
  const specialistFails = verdicts.filter(
    (v) => v.verdict === "fail" && v.authority === "specialist",
  );
  if (authoritativeFails.length > 0) {
    return { verdict: "fail", authoritativeFails, specialistFails };
  }
  if (verdicts.length > 0 && verdicts.every((v) => v.verdict === "pass")) {
    return { verdict: "pass", authoritativeFails, specialistFails };
  }
  return { verdict: "inconclusive", authoritativeFails, specialistFails };
}

export type GateResult = {
  task: Task;
  // Tasks created as a follow-up (request-changes redispatch, reject->on_reject).
  // The runner picks these up on the next runNext call.
  nextTasks: Task[];
};

export async function gate(
  taskId: string,
  decision: GateDecision,
  rationale: string | undefined,
  opts: GateOptions = {},
): Promise<GateResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const blocked = task.status === "blocked_by_red";
  if (blocked && !opts.force) {
    throw new Error(
      `Task ${taskId} is blocked_by_red. Re-run with --force --rationale "..." to override.`,
    );
  }
  if (task.status !== "awaiting_gate" && !blocked) {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not awaiting_gate. Cannot gate.`,
    );
  }

  const run = getRun(task.runId);
  if (!run) throw new Error(`Run not found for task ${taskId}`);
  const workflow = loadWorkflow(run.workflow, { projectDir: run.projectDir });
  const step = findStep(workflow, task.phase);
  if (!step) throw new Error(`Step '${task.phase}' not in workflow '${workflow.name}'`);

  // Verdict re-check on advance.
  if (decision === "advance" && !opts.force) {
    const verdicts = verdictsForTask(taskId);
    const agg = aggregateVerdicts(verdicts);
    if (step.gate === "verdict" && agg.verdict === "fail") {
      throw new Error(
        `Cannot advance ${taskId}: verdict aggregation = fail. Authoritative fails: ${agg.authoritativeFails
          .map((v) => v.redRole)
          .join(", ")}. Override with --force --rationale "...".`,
      );
    }
    if (agg.specialistFails.length > 0 && !rationale) {
      throw new Error(
        `Specialist red(s) failed on ${taskId}: ${agg.specialistFails
          .map((v) => v.redRole)
          .join(", ")}. Provide --rationale to advance over their objections.`,
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
  logEvent("gate.decided", {
    runId: run.id,
    taskId,
    payload: { decision, rationale, force: opts.force ?? false },
  });

  let nextTasks: Task[] = [];

  if (decision === "advance") {
    markTaskComplete(taskId, task.result);
    logEvent("task.completed", { runId: run.id, taskId });

    // If this was the last step (no step depends on it) and every primary
    // task is now terminal, mark the run complete. The runner does this on
    // its own when called, but the CLI's UX is "user gates, returns to prompt"
    // — we don't want them to need a follow-up `forge next` just to flip the
    // run row.
    finalizeRunIfDone(run.id, workflow);
  } else if (decision === "reject") {
    failTask(taskId, {
      runId: run.id,
      kind: classify({ source: "gate_rejected" }),
      error: rationale ?? "rejected by gate",
    });

    if (step.on_reject) {
      const targetStep = findStep(workflow, step.on_reject);
      if (!targetStep) {
        throw new Error(
          `step '${step.id}' on_reject references unknown step '${step.on_reject}'`,
        );
      }
      // Insert a fresh pending task in the on_reject step. The runner's
      // ready-queue will pick it up. Inject the rejection rationale into
      // inputs so the on_reject agent has context.
      const newId = newTaskId(targetStep.id);
      const tp: TaskPackage = {
        taskId: newId,
        runId: task.runId,
        phase: targetStep.id,
        role: targetStep.agent ?? task.agentRole,
        inputs: {
          rejectedRationale: rationale ?? "",
          rejectedTaskId: taskId,
        },
        composedSystemPrompt: "",
      };
      const newTask: Task = {
        id: newId,
        runId: task.runId,
        parentId: taskId,
        phase: targetStep.id,
        agentRole: targetStep.agent ?? task.agentRole,
        agentAlias: targetStep.activity,
        status: "pending",
        taskPackage: tp,
        createdAt: nowIso(),
      };
      insertTask(newTask);
      logEvent("task.created", {
        runId: run.id,
        taskId: newId,
        payload: { from: "reject->on_reject" },
      });
      nextTasks = [newTask];
    }
  } else if (decision === "request-changes") {
    if (step.manual) {
      throw new Error(
        `Task ${taskId} is in a manual step ('${step.id}'); request-changes is not supported. Use 'reject' to loop back to '${step.on_reject ?? "the prior step"}', or re-submit with corrected artifacts.`,
      );
    }
    // Close the current task, seed a fresh pending in the SAME step. The
    // runner's "reuse pending row in same step" logic picks it up.
    failTask(taskId, {
      runId: run.id,
      kind: classify({ source: "gate_rejected" }),
      error: "request-changes; superseded",
    });
    const newId = newTaskId(task.phase);
    const tp: TaskPackage = {
      ...task.taskPackage,
      taskId: newId,
      composedSystemPrompt: "",
      inputs: {
        ...task.taskPackage.inputs,
        requestedChanges: rationale ?? "",
      },
    };
    const newTask: Task = {
      id: newId,
      runId: task.runId,
      // PRIMARY task (parentId undefined) so runNext.dispatchStep reuses this
      // pending row — a parentId-child is ignored, dropping the requestedChanges
      // guidance. Matches this block's stated intent ("runner reuses the pending
      // row in the same step"). Same fix as forge retry (AWN-3 finding).
      phase: task.phase,
      agentRole: task.agentRole,
      agentAlias: task.agentAlias,
      status: "pending",
      taskPackage: tp,
      createdAt: nowIso(),
    };
    insertTask(newTask);
    logEvent("task.created", {
      runId: run.id,
      taskId: newId,
      payload: { from: "request-changes" },
    });
    nextTasks = [newTask];
  }

  return { task: getTask(taskId)!, nextTasks };
}

function findStep(workflow: Workflow, stepId: string): Step | undefined {
  return workflow.steps.find((s) => s.id === stepId);
}

// After an advance, if every step has a complete primary task and no work is
// pending or running, flip the run to "complete". The runner already does
// this, but gate runs in the user's foreground call — without finalizing
// here, the run row would still say "active" until the user runs `forge next`
// or `forge status` again.
function finalizeRunIfDone(runId: string, workflow: Workflow): void {
  const tasks = tasksForRun(runId);
  const allStepsHavePrimary = workflow.steps.every((s) =>
    tasks.some((t) => t.phase === s.id && t.parentId === undefined),
  );
  if (!allStepsHavePrimary) return;
  const noPending = tasks.every(
    (t) => t.status === "complete" || t.status === "failed" || t.parentId !== undefined,
  );
  if (!noPending) return;
  updateRunStatus(runId, "complete");
  logEvent("run.completed", { runId, payload: { via: "gate" } });
}

export type BatchGateResult = {
  runId: string;
  decision: GateDecision;
  gated: Array<{ taskId: string; followups: number }>;
  skippedBlocked: Array<{ taskId: string; phase: string }>;
  failed: Array<{ taskId: string; error: string }>;
};

export async function batchGate(
  runId: string,
  decision: GateDecision,
  rationale: string | undefined,
  opts: GateOptions = {},
): Promise<BatchGateResult> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (decision !== "advance") {
    throw new Error(
      `batchGate currently supports 'advance' only. ${decision} typically needs per-task rationale; gate those individually.`,
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
