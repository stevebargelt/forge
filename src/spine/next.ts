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
  | { kind: "awaiting_human_input"; tasks: Task[] }
  | { kind: "awaiting_red"; tasks: Task[] }
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

    // awaiting_red — blue done, reds in flight. Surface so the user knows to
    // wait rather than thinking the run has stalled. Not actionable — same
    // as `running` from the user's perspective, just a different phase.
    const awaitingRed = tasks.filter((t) => t.status === "awaiting_red");
    if (awaitingRed.length > 0) return { kind: "awaiting_red", tasks: awaitingRed };

    const blocked = tasks.filter((t) => t.status === "blocked_by_red");
    if (blocked.length > 0) return { kind: "blocked_by_red", tasks: blocked };

    const awaiting = tasks.filter((t) => t.status === "awaiting_gate");
    if (awaiting.length > 0) return { kind: "awaiting_gate", tasks: awaiting };

    const awaitingHuman = tasks.filter((t) => t.status === "awaiting_human_input");
    if (awaitingHuman.length > 0) return { kind: "awaiting_human_input", tasks: awaitingHuman };

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
      // Auto-gated terminal phase: every task in the just-dispatched phase is complete,
      // and there's no next phase to advance to. Finalize the run here instead of making
      // the user run `forge next` a second time just to discover the run is done.
      if (shouldAutoFinalize(workflow, phaseName, refreshed)) {
        updateRunStatus(run.id, "complete");
        logEvent("run.completed", { runId: run.id });
        return { kind: "complete" };
      }
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
      // Phase has zero agents AND no manual-phase task got created — degenerate.
      updateRunStatus(run.id, "complete");
      return { kind: "complete" };
    }
    // Manual phases (FORGE-DEC-016) create their task directly in awaiting_human_input.
    // Surface that immediately so the next-command hint points at `forge submit`.
    if (created.every((t) => t.status === "awaiting_human_input")) {
      return { kind: "awaiting_human_input", tasks: created };
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

// True when the just-dispatched phase has finished all its work (every refreshed task
// is `complete`) AND the workflow has no successor phase. In that case `next()` finalizes
// the run inline instead of returning `kind:"dispatched"` and forcing a second `forge
// next` to discover the run is done. Exported for unit testing.
export function shouldAutoFinalize(
  workflow: Workflow,
  phaseName: string,
  refreshed: Task[]
): boolean {
  if (refreshed.length === 0) return false;
  if (!refreshed.every((t) => t.status === "complete")) return false;
  return !nextPhaseAfter(workflow, phaseName);
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

  // Manual phase (FORGE-DEC-016): no agents → one task in awaiting_human_input. The human
  // produces artifacts off-forge (e.g. runs PROMPT.md against Pencil), then `forge submit`
  // validates + transitions to awaiting_gate. Inputs still get upstream + commonInputs so
  // onReject rationale propagates if the prior review was rejected.
  if (phase.agents.length === 0) {
    const inputsList = opts.perAgentInputs ?? [{}];
    const common = opts.commonInputs ?? {};
    const inputs = inputsList[0] ?? {};
    const taskId = newTaskId(phase.name);
    const mergedInputs = upstream
      ? { ...common, ...inputs, upstream }
      : { ...common, ...inputs };
    const taskPackage: TaskPackage = {
      taskId,
      runId: run.id,
      phase: phase.name,
      role: "",
      inputs: mergedInputs,
      composedSystemPrompt: "",
    };
    const task: Task = {
      id: taskId,
      runId: run.id,
      parentId: opts.parentId,
      phase: phase.name,
      agentRole: "",
      status: "awaiting_human_input",
      taskPackage,
      createdAt: nowIso(),
    };
    insertTask(task);
    logEvent("task.created", { runId: run.id, taskId, payload: { manual: true } });
    return [task];
  }

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
        agentAlias: agent.alias,
        agentModel: agent.model,
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
