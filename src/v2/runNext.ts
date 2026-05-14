// forge v2 — runNext: dispatch one wave of ready steps.
//
// One invocation = one wave. Computes ready queue from SQLite state, spawns
// each ready step in parallel, awaits all, writes results to SQLite, returns.
//
// The orchestrator (the conversational agent) calls runNext in a loop. Between
// invocations it decides whether to advance gates (calling forge gate ...) or
// surface to the human. The runner itself is dumb — it doesn't know about
// gates beyond "step transitions to awaiting_gate" being a terminal state for
// this invocation.
//
// NOT YET WIRED TO CLI. This is the v2 runner core, callable as a library.
// Wiring into `forge next` is a separate change at v2 cutover.
//
// See DECISIONS.md for the architectural calls made here.

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { join } from "node:path";
import type { Task, TaskPackage } from "../types/index.js";
import type { Workflow, Step, Runtime } from "./schema.js";
import { tasksForRun } from "../store/tasks.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { insertTask, markTaskRunning, markTaskComplete, markTaskFailed, markTaskAwaitingGate } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { computeReadyQueue } from "./ready-queue.js";
import { deriveUpstream } from "./inputs.js";
import { composeSystemPrompt } from "./compose.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";
import { loadRuntime } from "./loader.js";
import { newTaskId } from "../util/ids.js";

export type RunNextResult = {
  dispatchedSteps: string[];      // step ids that got dispatched this call
  completedSteps: string[];       // step ids that completed (auto gate)
  awaitingGate: string[];         // step ids that hit awaiting_gate (human/verdict)
  failedSteps: string[];          // step ids that failed
  runStatus: string;              // post-call run status
};

export async function runNext(args: {
  runId: string;
  workflow: Workflow;
  // For testing: override the docker spawn. Real callers leave this undefined
  // and the real `docker run ...` is invoked via buildDockerArgs + child_process.
  dockerExec?: DockerExecFn;
}): Promise<RunNextResult> {
  const run = getRun(args.runId);
  if (!run) throw new Error(`runNext: run not found: ${args.runId}`);

  const tasks = tasksForRun(args.runId);
  const ready = computeReadyQueue(args.workflow, tasks);

  if (ready.length === 0) {
    // Either everything's done, gated, or running (some other runNext is in flight).
    return {
      dispatchedSteps: [],
      completedSteps: [],
      awaitingGate: [],
      failedSteps: [],
      runStatus: run.status,
    };
  }

  if (!run.projectDir) {
    throw new Error(`runNext: run ${args.runId} has no projectDir set — cannot spawn containers`);
  }

  // Read --design-dir if set on this run (stored as run.metadata.designDir per
  // #114 + the existing spine pattern).
  const designDir = typeof run.metadata?.["designDir"] === "string"
    ? (run.metadata["designDir"] as string)
    : undefined;

  // Dispatch all ready steps in parallel (Promise.all → "parallel within wave").
  // Each dispatchStep returns the post-dispatch task status for its step.
  const dispatched: string[] = ready.map((s) => s.id);
  const outcomes = await Promise.all(
    ready.map((step) => dispatchStep({
      runId: args.runId,
      workflow: args.workflow,
      step,
      projectDir: run.projectDir!,
      designDir,
      dockerExec: args.dockerExec,
    }))
  );

  const completed: string[] = [];
  const awaitingGate: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const stepId = ready[i]!.id;
    const status = outcomes[i]!;
    if (status === "complete") completed.push(stepId);
    else if (status === "awaiting_gate" || status === "blocked_by_red") awaitingGate.push(stepId);
    else if (status === "failed") failed.push(stepId);
  }

  // If every step completed and no more steps remain ready in the workflow,
  // the run is done. Check by recomputing after this wave's writes.
  const tasksAfter = tasksForRun(args.runId);
  const readyAfter = computeReadyQueue(args.workflow, tasksAfter);
  const allStepsHaveTasks = args.workflow.steps.every((s) =>
    tasksAfter.some((t) => t.phase === s.id && t.parentId === undefined)
  );
  const noPendingWork = tasksAfter.every(
    (t) => t.status === "complete" || t.status === "failed" || t.parentId !== undefined
  );

  let runStatus: string = run.status;
  if (readyAfter.length === 0 && allStepsHaveTasks && noPendingWork) {
    const anyFailed = tasksAfter.some((t) => t.status === "failed" && t.parentId === undefined);
    // RunStatus union is "active" | "complete" | "abandoned" — there's no
    // "failed" state for runs. Mark complete regardless; the human / orchestrator
    // reads task statuses to know whether the run failed. Aligns with how the
    // v1 spine treats run completion.
    runStatus = "complete";
    updateRunStatus(args.runId, "complete");
    logEvent("run.completed", { runId: args.runId, payload: { anyFailed } });
  }

  return {
    dispatchedSteps: dispatched,
    completedSteps: completed,
    awaitingGate,
    failedSteps: failed,
    runStatus,
  };
}

// Dispatch one step: create task row, spawn container (or stub), read result,
// write status. Returns the post-dispatch task status string.
async function dispatchStep(args: {
  runId: string;
  workflow: Workflow;
  step: Step;
  projectDir: string;
  designDir?: string;
  dockerExec?: DockerExecFn;
}): Promise<string> {
  const step = args.step;

  // For manual steps: create task at pending, never spawn. The runner returns
  // immediately; forge submit transitions it to awaiting_gate later.
  if (step.manual) {
    return dispatchManualStep(args.runId, step);
  }

  // For non-manual: agent must be declared (schema enforces this).
  const agentRole = step.agent!;

  // Find or create a pending task row for this step. If a pending row exists
  // (e.g. from request-changes), reuse it; otherwise create fresh.
  const existing = tasksForRun(args.runId).find(
    (t) => t.phase === step.id && t.status === "pending" && t.parentId === undefined
  );
  const taskId = existing?.id ?? newTaskId(step.id);

  const allTasks = tasksForRun(args.runId);
  const upstream = deriveUpstream({
    step,
    allTasks,
    runDir: join(homeForge(), "runs", args.runId),
  });

  const taskPackage: TaskPackage = {
    taskId,
    runId: args.runId,
    phase: step.id,
    role: agentRole,
    inputs: { upstream } as Record<string, unknown>,
    composedSystemPrompt: composeSystemPrompt({
      role: agentRole,
      workflow: args.workflow,
      step,
    }),
  };

  if (!existing) {
    const task: Task = {
      id: taskId,
      runId: args.runId,
      phase: step.id,
      agentRole,
      agentAlias: step.model,
      status: "pending",
      taskPackage,
      createdAt: new Date().toISOString(),
    };
    insertTask(task);
  }

  // Materialize files on disk: task dir, CLAUDE.md, package.md, result.json.
  const dir = taskDir(args.runId, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), taskPackage.composedSystemPrompt);
  writeFileSync(join(dir, "package.md"), renderTaskPackage(taskPackage));
  writeFileSync(join(dir, "result.json"), "");
  chmodSync(dir, 0o777);

  markTaskRunning(taskId);
  logEvent("task.started", { runId: args.runId, taskId });

  // Spawn the container.
  let runtime: Runtime;
  try {
    runtime = loadRuntime(step.runtime);
  } catch (e) {
    markTaskFailed(taskId, `loadRuntime failed: ${(e as Error).message}`);
    return "failed";
  }

  const spawnCtx: SpawnContext = {
    TASK_ID: taskId,
    TASK_DIR: dir,
    PROJECT_DIR: args.projectDir,
    PROJECT_MODE: "rw", // reds get ro; this is the primary agent
    MODEL: resolveModel(step.model, runtime),
    SYSTEM_PROMPT: taskPackage.composedSystemPrompt,
    DESIGN_DIR: args.designDir,
  };

  let dockerArgs;
  try {
    dockerArgs = buildDockerArgs(runtime, spawnCtx);
  } catch (e) {
    markTaskFailed(taskId, `buildDockerArgs failed: ${(e as Error).message}`);
    return "failed";
  }

  // Either use the injected dockerExec (tests) or invoke real docker.
  const exec = args.dockerExec ?? defaultDockerExec;
  let exitCode: number;
  try {
    exitCode = await exec({
      args: dockerArgs.args,
      stdin: dockerArgs.stdin,
      stdoutPath: join(dir, "container.stdout.log"),
      stderrPath: join(dir, "container.stderr.log"),
    });
  } catch (e) {
    markTaskFailed(taskId, `docker exec threw: ${(e as Error).message}`);
    return "failed";
  }

  // Read result.json. If empty/missing/malformed, mark failed.
  const resultPath = join(dir, "result.json");
  const resultRaw = existsSync(resultPath) ? readFileSync(resultPath, "utf8").trim() : "";
  if (exitCode !== 0 && !resultRaw) {
    markTaskFailed(taskId, `container_crash (exit ${exitCode})`);
    return "failed";
  }
  let result: unknown = undefined;
  try {
    if (resultRaw.length > 0) result = JSON.parse(resultRaw);
  } catch {
    markTaskFailed(taskId, `result.json malformed`);
    return "failed";
  }
  if (!result) {
    markTaskFailed(taskId, "no_result_json");
    return "failed";
  }

  // Reds: not implemented in this first pass. Tracked in DECISIONS.md.
  if (step.reds.length > 0) {
    // For now, treat as "primary completed; reds pending".
    // Real reds dispatch will be the next iteration. Mark awaiting_gate so
    // the run pauses cleanly instead of plowing forward without verdicts.
    markTaskAwaitingGate(taskId, result);
    return "awaiting_gate";
  }

  // Status mapping based on step.gate:
  switch (step.gate) {
    case "auto":
    case "none":
      markTaskComplete(taskId, result);
      return "complete";
    case "human":
      markTaskAwaitingGate(taskId, result);
      return "awaiting_gate";
    case "verdict":
      // Schema enforces reds.length > 0 for gate=verdict, so we shouldn't
      // reach here. But defensively:
      markTaskAwaitingGate(taskId, result);
      return "awaiting_gate";
  }
}

function dispatchManualStep(runId: string, step: Step): string {
  // Look for an existing pending task; if none, create one at pending status.
  // Manual steps never spawn a container; they're transitioned by `forge submit`.
  const existing = tasksForRun(runId).find(
    (t) => t.phase === step.id && t.parentId === undefined
  );
  if (existing) return existing.status;

  const taskId = newTaskId(step.id);
  const taskPackage: TaskPackage = {
    taskId,
    runId,
    phase: step.id,
    role: "manual",
    inputs: {},
    composedSystemPrompt: "",
  };
  insertTask({
    id: taskId,
    runId,
    phase: step.id,
    agentRole: "manual",
    status: "pending",
    taskPackage,
    createdAt: new Date().toISOString(),
  });
  logEvent("task.created", { runId, taskId, payload: { manual: true } });
  return "pending";
}

// --- Helpers ---

type DockerExecArgs = {
  args: string[];
  stdin: string | undefined;
  stdoutPath: string;
  stderrPath: string;
};
export type DockerExecFn = (args: DockerExecArgs) => Promise<number>;

const defaultDockerExec: DockerExecFn = async ({ args, stdin, stdoutPath, stderrPath }) => {
  return new Promise<number>((resolve) => {
    const proc = cpSpawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => outChunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
    proc.on("close", (code) => {
      writeFileSync(stdoutPath, Buffer.concat(outChunks));
      writeFileSync(stderrPath, Buffer.concat(errChunks));
      resolve(code ?? 1);
    });
    proc.on("error", () => resolve(1));
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
};

function homeForge(): string {
  return process.env.FORGE_HOME ?? join(process.env.HOME ?? "/", ".forge");
}

function renderTaskPackage(tp: TaskPackage): string {
  return [
    `# Task ${tp.taskId}`,
    ``,
    `Run: ${tp.runId}`,
    `Phase: ${tp.phase}`,
    `Role: ${tp.role}`,
    ``,
    `## Inputs`,
    ``,
    "```json",
    JSON.stringify(tp.inputs, null, 2),
    "```",
    ``,
    `## Output contract`,
    ``,
    `Write a single JSON object to /task/result.json with at minimum the fields {"status": "complete"|"failed", ...role-specific output}.`,
    ``,
  ].join("\n");
}

function resolveModel(alias: string | undefined, runtime: Runtime): string {
  if (!alias) return runtime.models.default!;
  return runtime.models[alias] ?? runtime.models.default!;
}
