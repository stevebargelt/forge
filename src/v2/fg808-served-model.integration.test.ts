// FG-808 integration: requested vs served model, through the REAL invoke completion
// path. A docker-exec stub writes a claude stream-json stdout (the shape a real
// `claude -p --output-format stream-json` emits: system/init, then assistant events
// whose message.model is the SERVED model, then message_delta usage) plus a result.json.
// Asserted: the task.model_mismatch event, the manifest block, and the `forge show` /
// `forge status --json` surfaces read through the built CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { eventsForTask } from "../store/events.js";
import { readTaskManifest } from "./task-manifest.js";
import { taskDir } from "../util/paths.js";
import { NODE_EXEC, BUILT_CLI_ENTRY } from "../integration-cli-spawn.js";

const REQUESTED = "claude-opus-5-5";

function ensureClaudeRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "claude-stub.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `name: claude-stub
description: test stub claude runtime
runtime_kind: claude-code
log_format: claude-stream-json
prompt_strategy: claude-stdin-package
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: ${REQUESTED}
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: claude
  args: ["-p"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function streamLines(served: Array<{ model: string; out: number }>): string {
  const session = "sess-808";
  const lines: unknown[] = [{ type: "system", subtype: "init", session_id: session, model: REQUESTED }];
  served.forEach((s, i) => {
    lines.push({
      type: "assistant",
      session_id: session,
      request_id: `req_${i}`,
      message: { id: `msg_${i}`, model: s.model, usage: { input_tokens: 10, output_tokens: 1 } },
    });
    lines.push({
      type: "stream_event",
      session_id: session,
      event: { type: "message_delta", usage: { input_tokens: 10, output_tokens: s.out } },
    });
  });
  lines.push({ type: "result", subtype: "success", is_error: false, session_id: session });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function makeStreamExec(served: Array<{ model: string; out: number }>): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", summary: "ok" }));
    writeFileSync(stdoutPath, streamLines(served));
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function cli(args: string[], cwd: string) {
  return spawnSync(NODE_EXEC, [BUILT_CLI_ENTRY, ...args], { cwd, env: process.env, encoding: "utf8" });
}

async function dispatch(served: Array<{ model: string; out: number }>, projectDir: string) {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  return invoke({
    agentRole: "architecture-advisor",
    task: "advise",
    projectDir,
    runtimeName: "claude-stub",
    dockerExec: makeStreamExec(served),
  });
}

test("FG-808: a switched dispatch records the manifest block, ONE task.model_mismatch event, and forge show/status surface it", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg808-switched-"));
  try {
    const r = await dispatch(
      [
        { model: REQUESTED, out: 50 },
        { model: "claude-opus-4-1", out: 400 },
        { model: "claude-opus-4-1", out: 600 },
      ],
      projectDir,
    );
    assert.equal(r.status, "complete", "a model mismatch never fails the task");

    const events = eventsForTask(r.taskId).filter((e) => e.eventType === "task.model_mismatch");
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as { requested: string; classification: string; servedModels: Array<{ model: string; requestIds: string[] }> };
    assert.equal(payload.requested, REQUESTED);
    assert.equal(payload.classification, "switched");
    assert.deepEqual(payload.servedModels.find((m) => m.model === "claude-opus-4-1")?.requestIds, ["req_1", "req_2"]);

    const manifest = readTaskManifest(taskDir(r.runId, r.taskId));
    assert.equal(manifest?.servedModel?.classification, "switched");

    const show = cli(["show", r.taskId], projectDir);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /model: +requested claude-opus-5-5, served claude-opus-4-1 ×2 \(95%\), claude-opus-5-5 ×1 \(5%\) \(switched\)/);

    const status = cli(["status", r.runId, "--json"], projectDir);
    assert.equal(status.status, 0, status.stderr);
    const row = (JSON.parse(status.stdout) as { tasks: Array<{ id: string; modelMismatch: { classification: string } | null }> })
      .tasks.find((t) => t.id === r.taskId);
    assert.equal(row?.modelMismatch?.classification, "switched");

    const ops = cli(["ops", "check", "--json", "--project", projectDir], projectDir);
    assert.equal(ops.status, 0, ops.stderr);
    const incident = (JSON.parse(ops.stdout) as Array<{ kind: string; taskId: string; severity: string }>)
      .find((i) => i.kind === "model_mismatch" && i.taskId === r.taskId);
    assert.equal(incident?.severity, "low");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-808: a same-model dispatch records the manifest block and NO event; forge show prints no served line", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg808-same-"));
  try {
    // Bedrock-qualified vs short form is the SAME model (normalizeModelId).
    const r = await dispatch([{ model: REQUESTED, out: 100 }, { model: `us.anthropic.${REQUESTED}`, out: 100 }], projectDir);
    assert.equal(r.status, "complete");
    assert.equal(eventsForTask(r.taskId).filter((e) => e.eventType === "task.model_mismatch").length, 0);
    assert.equal(readTaskManifest(taskDir(r.runId, r.taskId))?.servedModel?.classification, "same");
    const show = cli(["show", r.taskId], projectDir);
    assert.equal(show.status, 0, show.stderr);
    assert.doesNotMatch(show.stdout, /served/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-808: a mixed dispatch records the event but is NOT an ops check incident", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg808-mixed-"));
  try {
    const r = await dispatch([{ model: REQUESTED, out: 900 }, { model: "claude-haiku-4-5-20251001", out: 30 }], projectDir);
    const events = eventsForTask(r.taskId).filter((e) => e.eventType === "task.model_mismatch");
    assert.equal(events.length, 1);
    assert.equal((events[0]!.payload as { classification: string }).classification, "mixed");
    const ops = cli(["ops", "check", "--json", "--project", projectDir], projectDir);
    assert.equal(ops.status, 0, ops.stderr);
    const forTask = (JSON.parse(ops.stdout) as Array<{ kind: string; taskId: string }>).filter((i) => i.taskId === r.taskId);
    assert.deepEqual(forTask.filter((i) => i.kind === "model_mismatch"), [], "mixed is not an ops incident");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
