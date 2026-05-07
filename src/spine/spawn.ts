import { spawn as cpSpawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { AgentRef, AgentResult, TaskPackage } from "../types/index.js";
import { taskDir } from "../util/paths.js";
import { ensureCreds, detectCredsMode, oauthVolumeName, awsConfigDir } from "../util/creds.js";
import { logEvent } from "../store/events.js";
import { markTaskRunning, markTaskComplete, markTaskFailed } from "../store/tasks.js";

export type SpawnOptions = {
  taskPackage: TaskPackage;
  agentConfig: AgentRef;
  projectDir: string;
  readOnlyProject: boolean; // true for red agents
  image?: string;            // default agent-dev-worker
  litellmUrl?: string;       // default http://host.docker.internal:4000
  // Kill the container if no stdout for this many ms. Default 5min, override via
  // FORGE_AGENT_IDLE_TIMEOUT_MS env. 0 disables.
  idleTimeoutMs?: number;
};

const DEFAULT_IMAGE = "agent-dev-worker";
const DEFAULT_LITELLM = "http://host.docker.internal:4000";
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_EXIT_CODE = 137; // matches SIGKILL convention

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

  // Stable name lets us `docker kill <name>` from the idle watchdog without parsing IDs.
  const containerName = `forge-${tp.taskId}`;
  const idleTimeoutMs = resolveIdleTimeoutMs(opts.idleTimeoutMs);

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
    containerName,
  });

  const exitCode = await runDocker(dockerArgs, stderrPath, stdoutPath, packagePath, {
    containerName,
    idleTimeoutMs,
  });
  const resultJson = readResultJson(resultPath) ?? readResultJson(stdoutPath);

  if (exitCode === IDLE_TIMEOUT_EXIT_CODE && !resultJson) {
    const error = `idle_timeout (no stdout for ${Math.round(idleTimeoutMs / 1000)}s)`;
    markTaskFailed(tp.taskId, error);
    logEvent("task.idle_timeout", {
      runId: tp.runId,
      taskId: tp.taskId,
      payload: { idleTimeoutMs, containerName },
    });
    return { taskId: tp.taskId, status: "failed", output: undefined, error };
  }

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
      : undefined;

  if (reportedStatus === "failed") {
    const errMsg = (resultJson as { error?: string }).error ?? "agent reported failure";
    markTaskFailed(tp.taskId, errMsg, resultJson);
    logEvent("task.failed", { runId: tp.runId, taskId: tp.taskId, payload: { error: errMsg } });
    return { taskId: tp.taskId, status: "failed", output: resultJson, error: errMsg };
  }

  if (reportedStatus !== "complete") {
    // Missing or unrecognized status. Treated as failure rather than silently passed —
    // a result without {status: "complete"} is a contract violation and previously masked
    // real failures (e.g. agents that replied with prose instead of writing a JSON object).
    const reason = reportedStatus
      ? `unrecognized_status:${reportedStatus}`
      : "missing_status";
    markTaskFailed(tp.taskId, reason, resultJson);
    logEvent("task.failed", {
      runId: tp.runId,
      taskId: tp.taskId,
      payload: { reason, result: resultJson },
    });
    return { taskId: tp.taskId, status: "failed", output: resultJson, error: reason };
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
  containerName: string;
};

// Exported for unit testing the credential/mount wiring. Not part of the public API.
export function _buildDockerArgs(input: DockerArgsInput): string[] {
  return buildDockerArgs(input);
}

function buildDockerArgs(input: DockerArgsInput): string[] {
  const projectMount = `${input.projectDir}:/project:${input.readOnlyProject ? "ro" : "rw"}`;
  // -i forwards stdin into the container so the task package piped from the host
  // reaches `claude --print`. Without -i the prompt is silently empty.
  const args = ["run", "--rm", "-i", "--name", input.containerName];

  // Env vars + auth mounts depend on the resolved credentials mode.
  const mode = detectCredsMode();
  if (mode === "bedrock") {
    // Profile-mount model (FORGE-DEC-013): pass AWS_PROFILE + AWS_REGION through and
    // bind-mount ~/.aws read-only. The container's AWS SDK reads SSO cache + config
    // from the mount on every Bedrock call, so a host-side watchdog refreshing the
    // cache is enough to keep long-running containers authenticated. No env-var
    // snapshot of STS tokens — those would go stale within an hour.
    args.push("-e", "CLAUDE_CODE_USE_BEDROCK=1");
    args.push("-e", `AWS_PROFILE=${process.env.AWS_PROFILE}`);
    if (process.env.AWS_REGION) args.push("-e", `AWS_REGION=${process.env.AWS_REGION}`);
    args.push("-v", `${awsConfigDir()}:/home/agent/.aws:ro`);
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
  packagePath: string,
  watchdog: { containerName: string; idleTimeoutMs: number }
): Promise<number> {
  return new Promise((resolve) => {
    const proc = cpSpawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const errChunks: Buffer[] = [];
    const outChunks: Buffer[] = [];
    let timedOut = false;

    // Watchdog: kill the container if no stdout chunk arrives for idleTimeoutMs.
    // Disabled when idleTimeoutMs <= 0.
    const watcher =
      watchdog.idleTimeoutMs > 0
        ? startIdleWatchdog(proc.stdout, watchdog.idleTimeoutMs, () => {
            timedOut = true;
            const note = `\n[forge] killed by idle timeout: no stdout for ${Math.round(
              watchdog.idleTimeoutMs / 1000
            )}s. container=${watchdog.containerName}\n`;
            errChunks.push(Buffer.from(note));
            // Best-effort: ask the docker daemon to stop the named container. The host
            // docker CLI will exit shortly after.
            try {
              spawnSync("docker", ["kill", watchdog.containerName], { stdio: "ignore" });
            } catch {
              // ignore — proc.kill below covers the docker CLI itself
            }
            proc.kill("SIGTERM");
          })
        : { stop: () => {} };

    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.stdout.on("data", (d: Buffer) => outChunks.push(d));
    proc.stdin.end(readFileSync(packagePath));
    const finish = (code: number) => {
      watcher.stop();
      writeFileSync(stderrPath, Buffer.concat(errChunks));
      writeFileSync(stdoutPath, Buffer.concat(outChunks));
      resolve(timedOut ? IDLE_TIMEOUT_EXIT_CODE : code);
    };
    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", () => finish(1));
  });
}

// Exported for unit testing. Resets the idle timer on every chunk; calls onIdle once if
// the gap between chunks (or between start and first chunk) exceeds idleTimeoutMs.
export function startIdleWatchdog(
  stream: Readable,
  idleTimeoutMs: number,
  onIdle: () => void
): { stop: () => void } {
  let fired = false;
  let timer: NodeJS.Timeout = setTimeout(trigger, idleTimeoutMs);
  function trigger() {
    if (fired) return;
    fired = true;
    onIdle();
  }
  function reset() {
    if (fired) return;
    clearTimeout(timer);
    timer = setTimeout(trigger, idleTimeoutMs);
  }
  stream.on("data", reset);
  return {
    stop: () => {
      fired = true; // suppress any pending fire after the process exits cleanly
      clearTimeout(timer);
      stream.off("data", reset);
    },
  };
}

function resolveIdleTimeoutMs(explicit: number | undefined): number {
  if (typeof explicit === "number") return explicit;
  const env = process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

// Exported for unit testing the envelope-parsing logic. Not part of the public API.
export function _readResultJson(path: string): unknown | undefined {
  return readResultJson(path);
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
      // Inner is a string but not JSON — the agent replied with prose instead of a result
      // object. That's a contract violation; surface it as a clean failure with the agent's
      // text preserved as diagnostic context (truncated).
      return {
        status: "failed",
        error: "agent_replied_text",
        agentText: inner.slice(0, 1000),
      };
    }
    // Envelope with no inner string at all — also a contract violation.
    return { status: "failed", error: "agent_envelope_missing_inner_result" };
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
