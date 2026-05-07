import type { Run, Workflow, Task, TaskPackage } from "../types/index.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { tasksForRun, insertTask, tasksForRunPhase } from "../store/tasks.js";
import { findPhase, loadWorkflow, nextPhaseAfter } from "./workflows.js";
import { dispatch } from "./dispatch.js";
import { logEvent } from "../store/events.js";
import { newTaskId, nowIso } from "../util/ids.js";
import { startSsoWatchdog, stopSsoWatchdog } from "../util/sso-watchdog.js";
import { reconcileRun } from "./reconcile.js";

export type NextOptions = {
  projectDir: string;
};

export type NextResult =
  | { kind: "running"; tasks: Task[] }
  | { kind: "awaiting_gate"; tasks: Task[] }
  | { kind: "blocked_by_red"; tasks: Task[] }
  | { kind: "dispatched"; phase: string; tasks: Task[] }
  | { kind: "advanced"; phase: string; tasks: Task[] }
  | { kind: "complete" }
  | { kind: "crashed"; tasks: Task[] };

export async function next(runId: string, opts: NextOptions): Promise<NextResult> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== "active") {
    return { kind: "complete" };
  }

  const workflow = await loadWorkflow(run.workflow);

  // Reconcile: any task in `running` whose result.json exists on disk gets finished here.
  // Recovers from orphaned spawns where the agent finished but forge lost the docker child.
  const reconciled = reconcileRun(runId, workflow);
  const recovered = reconciled.filter((r) => r.resolution !== "still_running");
  if (recovered.length > 0) {
    console.log(`Reconciled ${recovered.length} orphaned task(s).`);
  }

  let tasks = tasksForRun(runId);

  startSsoWatchdog(run.id);
  try {
    const running = tasks.filter((t) => t.status === "running");
    if (running.length > 0) return { kind: "running", tasks: running };

    const blocked = tasks.filter((t) => t.status === "blocked_by_red");
    if (blocked.length > 0) return { kind: "blocked_by_red", tasks: blocked };

    const awaiting = tasks.filter((t) => t.status === "awaiting_gate");
    if (awaiting.length > 0) return { kind: "awaiting_gate", tasks: awaiting };

    const failed = tasks.filter((t) => t.status === "failed" && t.error?.startsWith("container_crash"));
    if (failed.length > 0) return { kind: "crashed", tasks: failed };

    const pending = tasks.filter((t) => t.status === "pending");
    if (pending.length > 0) {
      const phaseName = pending[0]!.phase;
      await dispatch(runId, phaseName, { projectDir: opts.projectDir });
      const refreshed = tasksForRun(runId).filter((t) => t.phase === phaseName);
      // After dispatch, blue tasks usually land in awaiting_gate (human-gated phases) or
      // blocked_by_red. Surface those terminal-for-this-tick statuses so the caller's hint
      // points the user at `forge gate ...` rather than another `forge next ...`.
      const postBlocked = refreshed.filter((t) => t.status === "blocked_by_red");
      if (postBlocked.length > 0) return { kind: "blocked_by_red", tasks: postBlocked };
      const postAwaiting = refreshed.filter((t) => t.status === "awaiting_gate");
      if (postAwaiting.length > 0) return { kind: "awaiting_gate", tasks: postAwaiting };
      return { kind: "dispatched", phase: phaseName, tasks: refreshed };
    }

    // No pending, none running, none awaiting. Either advance to next phase or finish.
    const lastCompletedPhase = lastPhaseWithCompletedTasks(workflow, tasks);
    const nextPhase = lastCompletedPhase ? nextPhaseAfter(workflow, lastCompletedPhase) : workflow.phases[0];
    if (!nextPhase) {
      updateRunStatus(run.id, "complete");
      logEvent("run.completed", { runId: run.id });
      return { kind: "complete" };
    }

    // Create tasks for the next phase. For phases without explicit fanout, one task per agent.
    const created = createPhaseTasks(run, workflow, nextPhase.name);
    if (created.length === 0) {
      // Phase has no agents — advance.
      updateRunStatus(run.id, "complete");
      return { kind: "complete" };
    }
    return { kind: "advanced", phase: nextPhase.name, tasks: created };
  } finally {
    // Watchdog stays alive for the run; only stop it on full completion.
    const refreshedRun = getRun(run.id);
    if (refreshedRun?.status === "complete" || refreshedRun?.status === "abandoned") {
      stopSsoWatchdog();
    }
  }
}

function lastPhaseWithCompletedTasks(workflow: Workflow, tasks: Task[]): string | undefined {
  for (let i = workflow.phases.length - 1; i >= 0; i--) {
    const p = workflow.phases[i]!;
    if (tasks.some((t) => t.phase === p.name && t.status === "complete")) return p.name;
  }
  return undefined;
}

// Collect completed blue task results from the immediately-upstream phase. Returns
// undefined if there is no upstream phase (this is the first phase) or if no completed
// blue tasks exist there. Excludes red tasks (their role starts with "red-") so the
// upstream context is the artifact, not its critique.
function collectUpstreamResults(
  workflow: Workflow,
  runId: string,
  currentPhaseName: string
): Array<{ taskId: string; agentRole: string; result: unknown }> | undefined {
  const idx = workflow.phases.findIndex((p) => p.name === currentPhaseName);
  if (idx <= 0) return undefined;
  const upstreamName = workflow.phases[idx - 1]!.name;
  const upstreamTasks = tasksForRunPhase(runId, upstreamName).filter(
    (t) => t.status === "complete" && t.result !== undefined && !t.agentRole.startsWith("red-")
  );
  if (upstreamTasks.length === 0) return undefined;
  return upstreamTasks.map((t) => ({
    taskId: t.id,
    agentRole: t.agentRole,
    result: t.result,
  }));
}

export function createPhaseTasks(
  run: Run,
  workflow: Workflow,
  phaseName: string,
  opts: {
    parentId?: string;
    perAgentInputs?: Array<Record<string, unknown>>;
    commonInputs?: Record<string, unknown>;
  } = {}
): Task[] {
  const phase = findPhase(workflow, phaseName);
  if (!phase) throw new Error(`Phase ${phaseName} not in workflow ${workflow.name}`);
  const created: Task[] = [];

  // Auto-inject upstream phase results so downstream agents have context. This is the
  // bridge between phases — without it, e.g. a reporter receives empty inputs and reports
  // "no assessment data." Reds get upstream via the `spec` field; blues get it here.
  const upstream = collectUpstreamResults(workflow, run.id, phase.name);

  const inputsList = opts.perAgentInputs ?? [{}];
  const common = opts.commonInputs ?? {};
  for (const inputs of inputsList) {
    for (const agent of phase.agents) {
      const taskId = newTaskId(phase.name);
      const mergedInputs = upstream
        ? { ...common, ...inputs, upstream }
        : { ...common, ...inputs };
      const taskPackage: TaskPackage = {
        taskId,
        runId: run.id,
        phase: phase.name,
        role: agent.role,
        inputs: mergedInputs,
        composedSystemPrompt: "", // composed at dispatch time
      };
      const task: Task = {
        id: taskId,
        runId: run.id,
        parentId: opts.parentId,
        phase: phase.name,
        agentRole: agent.role,
        status: "pending",
        taskPackage,
        createdAt: nowIso(),
      };
      insertTask(task);
      logEvent("task.created", { runId: run.id, taskId });
      created.push(task);
    }
  }
  return created;
}
