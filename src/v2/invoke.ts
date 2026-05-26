// forge v2 — invoke: dispatch a single agent against a freeform task.
//
// This is the primary primitive for the RACI-driven orchestrator pattern:
// most user requests resolve to one or two `forge invoke` calls. The pipeline
// (`forge new feature`) is reserved for implementation work.
//
// Behavior:
// - Loads the runtime (detects from env or accepts an override)
// - Composes the agent's system prompt (CLAUDE.md + constraints + freeform task framing)
// - Spawns one container via the existing v2 spawn machinery
// - Writes a task row to SQLite (visible in dashboard)
// - If --run-id is unset, creates a synthetic 1-task run with workflow name 'invoke'
// - Returns the parsed result.json
//
// What this does NOT handle (deliberately, see DECISIONS.md):
// - No depends_on linkage; orchestrator chains by passing prior results into next task text
// - No fanout; orchestrator parallelizes via multiple Bash forge invoke calls
// - No reds; reds are themselves invoke targets, dispatched by the orchestrator
// - No gate concept; agent completes or fails

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { join } from "node:path";
import type { Task, TaskPackage, Run } from "../types/index.js";
import type { Workflow, Step, Runtime } from "./schema.js";
import { insertTask, markTaskRunning, markTaskComplete, markTaskFailed } from "../store/tasks.js";
import { captureUsageForTask } from "../store/model-calls.js";
import { insertRun, getRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { composeSystemPrompt } from "./compose.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";
import { loadRuntime, resolveModelForTask } from "./loader.js";
import { newRunId, newTaskId } from "../util/ids.js";

export type InvokeArgs = {
  agentRole: string;
  task: string;
  projectDir: string;
  designDir?: string;
  modelAlias?: string;       // override the step's model alias
  runtimeName?: string;      // override the runtime to load (default: "claude")
  readOnlyProject?: boolean; // mount /project ro (default: false)
  runId?: string;            // attach to existing run; if absent, create a new one
  runTitle?: string;         // used only when creating a new run
  /** The orchestrator's home directory. When set, `forge status` filters
   *  this run into the current-workspace view even if projectDir points
   *  elsewhere (audit-workspace pattern: workspace=~/code/audit-workspace,
   *  projectDir=~/code/audit-workspace/repos/team-payments). Defaults at
   *  the CLI layer to cwd. */
  workspace?: string;
  // Injected for tests; real callers leave undefined → docker is used.
  dockerExec?: DockerExecFn;
};

export type InvokeResult = {
  runId: string;
  taskId: string;
  status: "complete" | "failed";
  result?: unknown;
  error?: string;
};

export async function invoke(args: InvokeArgs): Promise<InvokeResult> {
  // Resolve / create the run.
  const runId = args.runId ?? createInvokeRun(args.agentRole, args.projectDir, args.designDir, args.runTitle, args.workspace);
  const run = getRun(runId);
  if (!run) throw new Error(`invoke: run not found: ${runId}`);

  // Build a synthetic single-step workflow + step. The runner machinery
  // (compose, spawn) takes Workflow + Step types; for invoke we create
  // minimal ones in-memory rather than loading from YAML. The runner's heavy
  // step lifecycle (depends_on, gates, reds) isn't exercised here.
  const step: Step = {
    id: "task",                           // synthetic phase id; matches v1 single-task runs
    agent: args.agentRole,
    model: args.modelAlias,
    runtime: args.runtimeName ?? "claude",
    depends_on: [],
    gate: "auto",
    manual: false,
    reds: [],
    workflow_additions:
      `You are receiving a single freeform task. Read the user's task description below carefully and produce a result.\n\n` +
      `## Task\n\n${args.task}\n`,
  };

  const workflow: Workflow = {
    name: "invoke",
    description: "Single-agent invocation (forge invoke)",
    inputs: [],
    steps: [step],
  };

  const taskId = newTaskId("task");
  const taskPackage: TaskPackage = {
    taskId,
    runId,
    phase: "task",
    role: args.agentRole,
    inputs: { task: args.task } as Record<string, unknown>,
    composedSystemPrompt: composeSystemPrompt({
      role: args.agentRole,
      workflow,
      step,
    }),
  };

  // Insert task row first; the spawn writes files into the task dir and the
  // dashboard / forge status reads the row.
  const task: Task = {
    id: taskId,
    runId,
    phase: "task",
    agentRole: args.agentRole,
    agentAlias: args.modelAlias,
    agentModel: resolveModelForTask(args.runtimeName ?? "claude", args.modelAlias),
    status: "pending",
    taskPackage,
    createdAt: new Date().toISOString(),
  };
  insertTask(task);

  // Materialize the task dir.
  const dir = taskDir(runId, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), taskPackage.composedSystemPrompt);
  writeFileSync(join(dir, "package.md"), renderInvokeTaskPackage(taskPackage, args.task));
  writeFileSync(join(dir, "result.json"), "");
  chmodSync(dir, 0o777);

  markTaskRunning(taskId);
  logEvent("task.started", { runId, taskId });

  // Load runtime + build docker args.
  let runtime: Runtime;
  try {
    runtime = loadRuntime(step.runtime);
  } catch (e) {
    markTaskFailed(taskId, `loadRuntime failed: ${(e as Error).message}`);
    return { runId, taskId, status: "failed", error: (e as Error).message };
  }

  const ctx: SpawnContext = {
    TASK_ID: taskId,
    TASK_DIR: dir,
    PROJECT_DIR: args.projectDir,
    PROJECT_MODE: args.readOnlyProject ? "ro" : "rw",
    MODEL: resolveModel(step.model, runtime),
    SYSTEM_PROMPT: taskPackage.composedSystemPrompt,
    TASK_PACKAGE_MARKDOWN: renderInvokeTaskPackage(taskPackage, args.task),
    DESIGN_DIR: args.designDir,
  };

  let dockerArgs;
  try {
    dockerArgs = buildDockerArgs(runtime, ctx);
  } catch (e) {
    markTaskFailed(taskId, `buildDockerArgs failed: ${(e as Error).message}`);
    return { runId, taskId, status: "failed", error: (e as Error).message };
  }

  const exec = args.dockerExec ?? defaultDockerExec;
  const stdoutPath = join(dir, "container.stdout.log");
  let exitCode: number;
  try {
    exitCode = await exec({
      args: dockerArgs.args,
      stdin: dockerArgs.stdin,
      stdoutPath,
      stderrPath: join(dir, "container.stderr.log"),
    });
  } catch (e) {
    // #155: capture usage even on docker failure — the task may have streamed
    // tokens before crashing, and we want to account for them.
    captureUsageForTask(stdoutPath, { taskId, ...(args.modelAlias ? { alias: args.modelAlias } : {}) });
    markTaskFailed(taskId, `docker exec threw: ${(e as Error).message}`);
    return { runId, taskId, status: "failed", error: (e as Error).message };
  }
  // #155: capture token usage from the stream-json log. Best-effort; never
  // throws or affects task status.
  captureUsageForTask(stdoutPath, { taskId, ...(args.modelAlias ? { alias: args.modelAlias } : {}) });

  // Read result.json.
  const resultPath = join(dir, "result.json");
  const resultRaw = existsSync(resultPath) ? readFileSync(resultPath, "utf8").trim() : "";
  if (exitCode !== 0 && !resultRaw) {
    const error = `container_crash (exit ${exitCode})`;
    markTaskFailed(taskId, error);
    return { runId, taskId, status: "failed", error };
  }

  let result: unknown = undefined;
  try {
    if (resultRaw.length > 0) result = JSON.parse(resultRaw);
  } catch {
    const error = "result.json malformed";
    markTaskFailed(taskId, error);
    return { runId, taskId, status: "failed", error };
  }
  if (!result) {
    const error = "no_result_json";
    markTaskFailed(taskId, error);
    return { runId, taskId, status: "failed", error };
  }

  markTaskComplete(taskId, result);
  logEvent("task.completed", { runId, taskId });
  return { runId, taskId, status: "complete", result };
}

// --- Helpers ---

function createInvokeRun(
  agentRole: string,
  projectDir: string,
  designDir: string | undefined,
  titleOverride: string | undefined,
  workspace: string | undefined
): string {
  const title = titleOverride ?? `invoke ${agentRole}`;
  const runId = newRunId(title);
  const metadata: Record<string, unknown> = { invokeAgent: agentRole };
  if (designDir) metadata["designDir"] = designDir;
  if (workspace) metadata["workspace"] = workspace;

  const run: Run = {
    id: runId,
    workflow: "invoke",  // sentinel; not a registered workflow
    title,
    status: "active",
    createdAt: new Date().toISOString(),
    metadata,
    projectDir,
  };
  insertRun(run);
  logEvent("run.created", { runId, payload: { kind: "invoke", agent: agentRole } });
  return runId;
}

function renderInvokeTaskPackage(tp: TaskPackage, task: string): string {
  return [
    `# Task ${tp.taskId}`,
    ``,
    `Run: ${tp.runId}`,
    `Agent: ${tp.role}`,
    ``,
    `## Task`,
    ``,
    task,
    ``,
    `## Output contract`,
    ``,
    `Write a single JSON object to /task/result.json. At minimum: {"status": "complete"|"failed", ...your role-specific output}.`,
    ``,
  ].join("\n");
}

function resolveModel(alias: string | undefined, runtime: Runtime): string {
  if (!alias) return runtime.models.default!;
  return runtime.models[alias] ?? runtime.models.default!;
}

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
