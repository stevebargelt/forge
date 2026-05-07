import type { DispatchResult, Phase, Run, Workflow, Task } from "../types/index.js";
import { findPhase, loadWorkflow } from "./workflows.js";
import { spawn } from "./spawn.js";
import { spawnRed } from "./spawnRed.js";
import { composeSystemPrompt } from "./composeSystemPrompt.js";
import { tasksForRun, getTask, setTaskStatus } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";

export type DispatchOptions = {
  projectDir: string;
};

export async function dispatch(
  runId: string,
  phaseName: string,
  opts: DispatchOptions
): Promise<DispatchResult> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const workflow = await loadWorkflow(run.workflow);
  const phase = findPhase(workflow, phaseName);
  if (!phase) throw new Error(`Phase ${phaseName} not in workflow ${workflow.name}`);

  const allTasks = tasksForRun(runId);
  const pending = allTasks.filter(
    (t) => t.phase === phaseName && t.status === "pending" && t.agentRole !== mostRedRole(phase)
  );

  const concurrency = phase.fanout?.maxConcurrency ?? 4;
  const failureMode = phase.fanout?.failureMode ?? "fail-phase";

  const taskIds: string[] = [];
  let succeeded = 0;
  let failed = 0;

  // Compose system prompts up-front so all blue tasks have their prompts captured before launch.
  for (const t of pending) {
    const agent = phase.agents.find((a) => a.role === t.agentRole) ?? phase.agents[0];
    if (!agent) throw new Error(`Phase ${phaseName} has no agents configured`);
    if (!t.taskPackage.composedSystemPrompt || t.taskPackage.composedSystemPrompt.length === 0) {
      t.taskPackage.composedSystemPrompt = composeSystemPrompt({
        role: t.agentRole,
        agentDir: agent.agentDir,
        run,
        workflow,
        phase,
        taskPackageFraming: phase.workflowAdditions
          ? undefined
          : "# Output schema\n\nWrite to /task/result.json: {status:'complete'|'failed', ...role-specific output}",
      });
    }
  }

  // Launch in batches honoring maxConcurrency.
  const queue = [...pending];
  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    const launched = await Promise.all(
      batch.map((t) => runBlueTask(t, phase, run, workflow, opts.projectDir))
    );
    for (const r of launched) {
      taskIds.push(r.taskId);
      if (r.status === "complete") succeeded++;
      else failed++;
    }
    if (failed > 0 && failureMode === "fail-phase") break;
  }

  return { spawned: taskIds.length, succeeded, failed, taskIds };
}

async function runBlueTask(
  task: Task,
  phase: Phase,
  run: Run,
  workflow: Workflow,
  projectDir: string
): Promise<{ taskId: string; status: "complete" | "failed" }> {
  const agent = phase.agents.find((a) => a.role === task.agentRole) ?? phase.agents[0];
  if (!agent) throw new Error(`No agent found for task ${task.id}`);

  const result = await spawn({
    taskPackage: task.taskPackage,
    agentConfig: agent,
    projectDir,
    readOnlyProject: false,
    image: agent.image,
  });

  if (result.status === "failed") {
    return { taskId: task.id, status: "failed" };
  }

  // Refresh task from store after spawn updated its status.
  const refreshed = getTask(task.id);
  if (!refreshed) return { taskId: task.id, status: "failed" };

  if (phase.reds && (phase.reds.wide || phase.reds.narrow)) {
    await spawnRed({
      blueTask: refreshed,
      redConfig: phase.reds,
      run,
      workflow,
      phase,
      projectDir,
    });
  } else if (phase.gate === "auto") {
    setTaskStatus(task.id, "complete");
    logEvent("task.completed", { runId: run.id, taskId: task.id });
  } else {
    setTaskStatus(task.id, "awaiting_gate");
  }

  return { taskId: task.id, status: "complete" };
}

function mostRedRole(phase: Phase): string | undefined {
  // Sentinel: dispatch() runs blue tasks; reds are spawned by spawnRed() within runBlueTask.
  // We never want dispatch to pick up a red task that lives in the same phase row.
  return phase.reds?.wide?.role ?? phase.reds?.narrow?.role;
}
