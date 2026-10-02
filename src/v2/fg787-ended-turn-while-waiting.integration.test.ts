// FG-787 (AC3) integration: a claude-stream-json container that armed a Monitor
// and ended its turn — clean exit 0, no result.json — is classified
// ended_turn_while_waiting through the REAL dispatch → stdout parse → classify →
// failTask path (invoke and runNext), with the operator-facing message as the
// task error. A plain clean-exit-no-result on the same runtime stays result_missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { invoke } from "./invoke.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { failureKindForTask, endedTurnWhileWaitingMessage } from "./failure-kind.js";
import { retryPolicy } from "./retry-policy.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { monitorThenEndTurnStream, sInit, sResult, sStop, sText, sToolResult, sToolUse } from "./fg787-stream.testkit.js";
import { NODE_EXEC as node, BUILT_CLI_ENTRY as cli, REPO_ROOT } from "../integration-cli-spawn.js";

function makeNoResultExec(stdout: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function makeResultExec(stdout: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, "");
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", summary: "wait delivered" }));
    return 0;
  };
}

// No hard-coded cwd: "/project" exists only inside the agent container, and a missing
// cwd makes spawnSync fail with ENOENT — status null, no signal, empty stderr.
function forge(args: string[]): { status: number | null; stdout: string; stderr: string; why: string } {
  const r = spawnSync(node, [cli, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: process.env.FORGE_HOME!, NO_NOTIFY: "true" },
  });
  const why = `forge ${args.join(" ")} exited status=${r.status} signal=${r.signal} error=${r.error?.message ?? "none"}: ${r.stderr ?? ""}`;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", why };
}

function ensureClaudeRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "claude-stream-stub.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `name: claude-stream-stub
description: test stub claude-code runtime
log_format: claude-stream-json
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

const EXPECTED_ERROR = endedTurnWhileWaitingMessage("Monitor");

test("FG-787 int: invoke — Monitor armed then end_turn, no result.json → ended_turn_while_waiting with the operator message", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const r = await invoke({
    agentRole: "engineer",
    task: "run the browser suite",
    projectDir: "/tmp/test-project",
    runtimeName: "claude-stream-stub",
    dockerExec: makeNoResultExec(monitorThenEndTurnStream()),
  });
  assert.equal(r.status, "failed");
  assert.equal(r.failureKind, "ended_turn_while_waiting");
  assert.equal(r.error, EXPECTED_ERROR);
  assert.equal(getTask(r.taskId)!.error, EXPECTED_ERROR);
  assert.equal(failureKindForTask(r.taskId), "ended_turn_while_waiting");
  assert.equal(retryPolicy(failureKindForTask(r.taskId)).retryable, true);

  // Real command registration and a separate dashboard DB reader must surface
  // the same durable cause, not a renderer-local paraphrase.
  const show = forge(["show", r.taskId]);
  assert.equal(show.status, 0, show.why);
  assert.match(show.stdout, /failure:\s+ended_turn_while_waiting/);
  assert.ok(show.stdout.includes(EXPECTED_ERROR), "forge show renders the canonical task error verbatim");

  const status = forge(["status", getTask(r.taskId)!.runId, "--json"]);
  assert.equal(status.status, 0, status.why);
  const statusTask = (JSON.parse(status.stdout) as { tasks: Array<{ id: string; failureKind: string | null; error: string | null }> })
    .tasks.find((task) => task.id === r.taskId);
  assert.equal(statusTask?.failureKind, "ended_turn_while_waiting");
  assert.equal(statusTask?.error, EXPECTED_ERROR);

  // The dashboard task-detail DTO is a projection of this durable lifecycle
  // event. Assert the exact persisted payload it reads rather than a duplicate
  // dashboard renderer, so all consumers have one canonical reason string.
  const failedEvent = eventsForTask(r.taskId).find((event) => event.eventType === "task.failed");
  assert.equal((failedEvent?.payload as Record<string, unknown>)?.["error"], EXPECTED_ERROR);
});

test("FG-787 int: invoke — synchronous Bash then end_turn, no result.json → stays result_missing", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const stream = [sInit(), sToolUse("toolu_b", "Bash", { command: "npm test" }), sToolResult("toolu_b", "12 passed"), sText("done"), sStop("end_turn"), sResult()].join("\n");
  const r = await invoke({
    agentRole: "engineer",
    task: "run the suite",
    projectDir: "/tmp/test-project",
    runtimeName: "claude-stream-stub",
    dockerExec: makeNoResultExec(stream),
  });
  assert.equal(r.status, "failed");
  assert.equal(r.failureKind, "result_missing");
  assert.equal(failureKindForTask(r.taskId), "result_missing");
});

test("FG-787 int: real stream shapes — sub-agent Monitor is ignored and top-level background Bash is named", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const stream = [
    sInit(),
    sToolUse("toolu_sub_monitor", "Monitor", { file: "/tmp/sub.log" }, "toolu_agent"),
    sToolResult("toolu_sub_monitor", "armed", "toolu_agent"),
    sToolUse("toolu_bg", "Bash", { command: "npm run test:e2e", run_in_background: true }),
    sToolResult("toolu_bg", "Command running in background"),
    sStop("end_turn"),
    sResult("end_turn"),
  ].join("\n");
  const r = await invoke({ agentRole: "engineer", task: "wait", projectDir: "/tmp/test-project", runtimeName: "claude-stream-stub", dockerExec: makeNoResultExec(stream) });
  assert.equal(r.failureKind, "ended_turn_while_waiting");
  assert.equal(r.error, endedTurnWhileWaitingMessage("Bash run_in_background"));
});

test("FG-787 int: result.json and a later assistant turn win over a waiting-shaped stream", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const r = await invoke({ agentRole: "engineer", task: "finish", projectDir: "/tmp/test-project", runtimeName: "claude-stream-stub", dockerExec: makeResultExec(monitorThenEndTurnStream()) });
  assert.equal(r.status, "complete");
  assert.equal(r.failureKind, undefined);
  assert.equal(failureKindForTask(r.taskId), undefined);
});

test("FG-787 int: max_tokens and malformed trailing stream data stay on the generic result_missing path without throwing", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const maxTokens = [sInit(), sToolUse("toolu_mon", "Monitor", { file: "/tmp/suite.log" }), sToolResult("toolu_mon", "Monitor armed."), sStop("max_tokens"), sResult("max_tokens")].join("\n");
  const limited = await invoke({ agentRole: "engineer", task: "limited", projectDir: "/tmp/test-project", runtimeName: "claude-stream-stub", dockerExec: makeNoResultExec(maxTokens) });
  assert.equal(limited.failureKind, "result_missing");

  const malformed = await invoke({ agentRole: "engineer", task: "malformed tail", projectDir: "/tmp/test-project", runtimeName: "claude-stream-stub", dockerExec: makeNoResultExec(`${sInit()}\n{synthesized-but-truncated`) });
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.failureKind, "result_missing");
});

test("FG-787 int: runNext — the workflow path classifies the same stream ended_turn_while_waiting", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf: Workflow = {
    name: "fg787-int",
    description: "FG-787 integration test workflow",
    review_mode: "legacy_verdict",
    inputs: [{ name: "brief", required: true, type: "text" }],
    steps: [{ id: "step", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude-stream-stub", reds: [] }],
  };
  const { runId } = startRun({ workflow: wf, title: "fg787-rn", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });
  const wave = await runNext({ runId, workflow: wf, dockerExec: makeNoResultExec(monitorThenEndTurnStream()) });
  assert.deepEqual(wave.failedSteps, ["step"]);
  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, EXPECTED_ERROR);
  assert.equal(failureKindForTask(task.id), "ended_turn_while_waiting");
  const failed = eventsForTask(task.id).find((e) => e.eventType === "task.failed")!;
  assert.equal((failed.payload as Record<string, unknown>)["error"], EXPECTED_ERROR);
});
