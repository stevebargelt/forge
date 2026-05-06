import { spawn as cpSpawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentRef, AgentResult, TaskPackage } from "../types/index.js";
import { taskDir } from "../util/paths.js";
import { ensureCreds, detectCredsMode, oauthVolumeName } from "../util/creds.js";
import { logEvent } from "../store/events.js";
import { markTaskRunning, markTaskComplete, markTaskFailed } from "../store/tasks.js";

export type SpawnOptions = {
  taskPackage: TaskPackage;
  agentConfig: AgentRef;
  projectDir: string;
  readOnlyProject: boolean; // true for red agents
  image?: string;            // default agent-dev-worker
  litellmUrl?: string;       // default http://host.docker.internal:4000
};

const DEFAULT_IMAGE = "agent-dev-worker";
const DEFAULT_LITELLM = "http://host.docker.internal:4000";

export async function spawn(opts: SpawnOptions): Promise<AgentResult> {
  ensureCreds();
  const tp = opts.taskPackage;
  const dir = taskDir(tp.runId, tp.taskId);
  mkdirSync(dir, { recursive: true });

  const claudeMdPath = join(dir, "CLAUDE.md");
  const packagePath = join(dir, "package.md");
  const resultPath = join(dir, "result.json");
  const stderrPath = join(dir, "container.stderr.log");
  const stdoutPath = join(dir, "container.stdout.log");

  writeFileSync(claudeMdPath, tp.composedSystemPrompt);
  writeFileSync(packagePath, renderTaskPackageMarkdown(tp));
  // Pre-create the result file so the bind mount has a target. Empty until agent writes.
  writeFileSync(resultPath, "");

  markTaskRunning(tp.taskId);
  logEvent("task.started", { runId: tp.runId, taskId: tp.taskId });

  const dockerArgs = buildDockerArgs({
    claudeMdPath,
    packagePath,
    resultPath,
    projectDir: opts.projectDir,
    readOnlyProject: opts.readOnlyProject,
    image: opts.image ?? DEFAULT_IMAGE,
    litellmUrl: opts.litellmUrl ?? DEFAULT_LITELLM,
    model: opts.agentConfig.model,
    systemPrompt: tp.composedSystemPrompt,
  });

  const exitCode = await runDocker(dockerArgs, stderrPath, stdoutPath, packagePath);
  const resultJson = readResultJson(resultPath) ?? readResultJson(stdoutPath);

  if (exitCode !== 0 && !resultJson) {
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").slice(-4000) : "";
    const error = `container_crash (exit ${exitCode})`;
    markTaskFailed(tp.taskId, error);
    logEvent("task.crashed", {
      runId: tp.runId,
      taskId: tp.taskId,
      payload: { exitCode, stderr },
    });
    return { taskId: tp.taskId, status: "failed", output: undefined, error };
  }

  if (!resultJson) {
    markTaskFailed(tp.taskId, "no_result_json");
    logEvent("task.failed", {
      runId: tp.runId,
      taskId: tp.taskId,
      payload: { reason: "no_result_json" },
    });
    return { taskId: tp.taskId, status: "failed", output: undefined, error: "no_result_json" };
  }

  const reportedStatus =
    typeof (resultJson as { status?: unknown }).status === "string"
      ? ((resultJson as { status: string }).status as string)
      : "complete";
  if (reportedStatus === "failed") {
    const errMsg = (resultJson as { error?: string }).error ?? "agent reported failure";
    markTaskFailed(tp.taskId, errMsg, resultJson);
    logEvent("task.failed", { runId: tp.runId, taskId: tp.taskId, payload: { error: errMsg } });
    return { taskId: tp.taskId, status: "failed", output: resultJson, error: errMsg };
  }

  markTaskComplete(tp.taskId, resultJson);
  logEvent("task.completed", { runId: tp.runId, taskId: tp.taskId });
  return { taskId: tp.taskId, status: "complete", output: resultJson };
}

function renderTaskPackageMarkdown(tp: TaskPackage): string {
  const sections: string[] = [];
  sections.push(`# Task ${tp.taskId}`);
  sections.push(`Run: ${tp.runId}\nPhase: ${tp.phase}\nRole: ${tp.role}`);
  sections.push(`## Inputs\n\n\`\`\`json\n${JSON.stringify(tp.inputs, null, 2)}\n\`\`\``);
  if (tp.spec) sections.push(`## Spec\n\n${tp.spec}`);
  if (tp.artifact) sections.push(`## Artifact under review\n\n${tp.artifact}`);
  if (tp.failureModes && tp.failureModes.length > 0) {
    sections.push(
      `## Failure modes (anti-prompts)\n\n${tp.failureModes.map((s) => `- ${s}`).join("\n")}`
    );
  }
  sections.push(
    `## Output contract\n\nWrite a single JSON object to /task/result.json with at minimum the fields {"status": "complete"|"failed", ...role-specific output}. For red agents, the role-specific output must match the Verdict schema (verdict, confidence, findings).`
  );
  return sections.join("\n\n");
}

type DockerArgsInput = {
  claudeMdPath: string;
  packagePath: string;
  resultPath: string;
  projectDir: string;
  readOnlyProject: boolean;
  image: string;
  litellmUrl: string;
  model: string;
  systemPrompt: string;
};

function buildDockerArgs(input: DockerArgsInput): string[] {
  const projectMount = `${input.projectDir}:/project:${input.readOnlyProject ? "ro" : "rw"}`;
  // -i forwards stdin into the container so the task package piped from the host
  // reaches `claude --print`. Without -i the prompt is silently empty.
  const args = ["run", "--rm", "-i"];

  // Env vars + auth mounts depend on the resolved credentials mode.
  const mode = detectCredsMode();
  if (mode === "bedrock") {
    args.push("-e", "CLAUDE_CODE_USE_BEDROCK=1");
    for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"]) {
      const v = process.env[k];
      if (v) args.push("-e", `${k}=${v}`);
    }
  } else if (mode === "anthropic-apikey") {
    args.push("-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  } else {
    // anthropic-oauth: mount the named volume that holds the OAuth credential file.
    // Read-write — claude writes cache/history alongside the credentials. The volume is
    // agent-scoped (not host-scoped); the blast radius of any agent write is the volume itself.
    args.push("-v", `${oauthVolumeName()}:/home/agent/.claude`);
  }
  if (process.env.FORGE_USE_LITELLM === "1") {
    args.push("-e", `ANTHROPIC_BASE_URL=${input.litellmUrl}`);
  }

  // Mounts. CLAUDE.md is written to disk for audit but not mounted — the prompt is
  // passed via --append-system-prompt on the argv.
  args.push("-v", `${input.packagePath}:/task/package.md:ro`);
  args.push("-v", `${input.resultPath}:/task/result.json`);
  args.push("-v", projectMount);

  args.push(input.image);
  args.push(
    "claude",
    "--model",
    input.model,
    "--append-system-prompt",
    input.systemPrompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    "--print"
  );
  return args;
}

function runDocker(
  args: string[],
  stderrPath: string,
  stdoutPath: string,
  packagePath: string
): Promise<number> {
  return new Promise((resolve) => {
    const proc = cpSpawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const errChunks: Buffer[] = [];
    const outChunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.stdout.on("data", (d: Buffer) => outChunks.push(d));
    proc.stdin.end(readFileSync(packagePath));
    const finish = (code: number) => {
      writeFileSync(stderrPath, Buffer.concat(errChunks));
      writeFileSync(stdoutPath, Buffer.concat(outChunks));
      resolve(code);
    };
    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", () => finish(1));
  });
}

function readResultJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return undefined;
  const parsed = tryParseJson(raw) ?? (() => {
    const last = extractLastJsonBlock(raw);
    return last ? tryParseJson(last) : undefined;
  })();
  if (!parsed) return undefined;
  // Unwrap claude --output-format=json envelope: it returns {type:"result", result:"...text..."}.
  // The agent's own JSON lives inside the inner `result` string. Otherwise the parsed object
  // IS the agent's result.json and we return it directly.
  if (typeof (parsed as { type?: unknown }).type === "string" && (parsed as { type: string }).type === "result") {
    const env = parsed as { result?: unknown; is_error?: unknown };
    if (env.is_error === true) {
      const msg = typeof env.result === "string" ? env.result : "claude reported is_error";
      return { status: "failed", error: msg };
    }
    const inner = env.result;
    if (typeof inner === "string") {
      const innerLast = extractLastJsonBlock(inner) ?? inner.trim();
      const innerParsed = tryParseJson(innerLast);
      if (innerParsed) return innerParsed;
    }
  }
  return parsed;
}

function tryParseJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function extractLastJsonBlock(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let candidate: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        candidate = text.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return candidate;
}
