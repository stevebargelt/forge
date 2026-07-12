// FG-540 integration tests: Codex structured-result recovery — end-to-end
// wiring of the DISPATCH-time paths (invoke + runNext). The extraction rule
// itself is unit-tested in stream-result-recovery.test.ts; reconcile-time
// recovery is tested in reconcile.integration.test.ts. Every test here drives
// a complete dispatch → container-return → result-read → status-write cycle
// and asserts the externally-visible outcome: DB task status, result.json on
// disk, lifecycle events (task.result_recovered_from_stream, task.completed /
// task.failed), and failure_kind where a failure is expected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { invoke } from "./invoke.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { failureKindForTask } from "./failure-kind.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";

// ---------------------------------------------------------------------------
// Codex JSONL fixture builders (sanitized from the preserved incident stream:
// run-review-loop-fg-536-eaa5be / task-red-wide-0dc174)
// ---------------------------------------------------------------------------

const PASS_OBJECT = {
  status: "complete",
  verdict: "pass",
  findings: [],
  notes: "Adjacent-surface matrix reviewed: invoke and workflow/runNext dispatch…",
};

function codexStream(terminalText: string): string {
  return [
    `{"type":"thread.started","thread_id":"019f557b-3c14-7f50-92fa-d38a1675ecb6"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'm auditing the working tree against the acceptance path."}}`,
    `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc rg"}}`,
    `{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":${JSON.stringify(terminalText)}}}`,
    `{"type":"turn.completed","usage":{"input_tokens":179821,"output_tokens":2226}}`,
  ].join("\n");
}

// Writes codex JSONL to stdout; leaves result.json unwritten (the incident shape).
function makeCodexNoResultExec(stdoutJsonl: string, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

function ensureCodexRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "codex-stub.yml");
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `name: codex-stub
description: test stub codex runtime
log_format: codex-jsonl
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

let wfSeq = 0;
function makeWorkflow(agent: string): Workflow {
  const uid = ++wfSeq;
  return {
    name: `fg540-int-${uid}`,
    description: "FG-540 integration test workflow",
    inputs: [{ name: "brief", required: true, type: "text" }],
    steps: [
      { id: "step", agent, gate: "auto", manual: false, depends_on: [], runtime: "codex-stub", reds: [] },
    ],
  };
}

// ---------------------------------------------------------------------------
// invoke path
// ---------------------------------------------------------------------------

test("FG-540 int: invoke — structured role, clean exit, terminal JSON agent_message, no result.json → task COMPLETES with the recovered object", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "red-wide",
    task: "review the diff",
    projectDir: "/tmp/test-project",
    readOnlyProject: true,
    runtimeName: "codex-stub",
    dockerExec: makeCodexNoResultExec(codexStream(JSON.stringify(PASS_OBJECT))),
  });

  assert.equal(r.status, "complete");
  assert.deepEqual(r.result, PASS_OBJECT, "the recovered object is the EXACT terminal JSON, not an inferred narrative");

  const task = getTask(r.taskId)!;
  assert.equal(task.status, "complete");
  assert.deepEqual(task.result, PASS_OBJECT);

  // AC2: persisted to result.json on disk, like a file-written result.
  const onDisk = JSON.parse(readFileSync(join(taskDir(r.runId, r.taskId), "result.json"), "utf8"));
  assert.deepEqual(onDisk, PASS_OBJECT);

  // Provenance event + normal completion event.
  const evTypes = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(evTypes.includes("task.result_recovered_from_stream"), "recovery provenance event must be recorded");
  assert.ok(evTypes.includes("task.completed"));
  assert.ok(!evTypes.includes("task.failed"));
});

test("FG-540 int: invoke — terminal agent_message is PROSE → still fails result_missing (never converted to a pass)", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "red-wide",
    task: "review the diff",
    projectDir: "/tmp/test-project",
    readOnlyProject: true,
    runtimeName: "codex-stub",
    dockerExec: makeCodexNoResultExec(codexStream("Everything looks good, passing.")),
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /no_result_json/);
  assert.equal(failureKindForTask(r.taskId), "result_missing");
  const evTypes = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(!evTypes.includes("task.result_recovered_from_stream"));
});

test("FG-540 int: invoke — turn.failed in the stream → recovery refuses; failure classified model_error (FG-513 semantics untouched)", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const stream = [
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"a","type":"agent_message","text":${JSON.stringify(JSON.stringify(PASS_OBJECT))}}}`,
    `{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}`,
  ].join("\n");

  const r = await invoke({
    agentRole: "red-wide",
    task: "review the diff",
    projectDir: "/tmp/test-project",
    readOnlyProject: true,
    runtimeName: "codex-stub",
    dockerExec: makeCodexNoResultExec(stream),
  });

  assert.equal(r.status, "failed");
  assert.equal(r.failureKind, "model_error", "a provider failure stays model_error — FG-513's bounded retry surface, not recovery");
  const evTypes = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(!evTypes.includes("task.result_recovered_from_stream"));
});

test("FG-540 int: invoke — an existing non-empty result.json ALWAYS wins; stream recovery never overwrites it", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const fileResult = { status: "complete", verdict: "needs_fix", findings: [{ summary: "real finding", file: "a.ts", line: 1 }] };
  const writesBoth: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, codexStream(JSON.stringify(PASS_OBJECT)));
    writeFileSync(stderrPath, "");
    writeFileSync(join(dir, "result.json"), JSON.stringify(fileResult));
    return 0;
  };

  const r = await invoke({
    agentRole: "red-wide",
    task: "review the diff",
    projectDir: "/tmp/test-project",
    readOnlyProject: true,
    runtimeName: "codex-stub",
    dockerExec: writesBoth,
  });

  assert.equal(r.status, "complete");
  assert.deepEqual(r.result, fileResult, "the file-written result is authoritative over the stream");
  const onDisk = JSON.parse(readFileSync(join(taskDir(r.runId, r.taskId), "result.json"), "utf8"));
  assert.deepEqual(onDisk, fileResult);
  const evTypes = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(!evTypes.includes("task.result_recovered_from_stream"));
});

// Leaves result.json empty but unwritable, so the recovery write throws EACCES.
function makeUnwritableResultExec(stdoutJsonl: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    const resultPath = join(dir, "result.json");
    writeFileSync(resultPath, "");
    chmodSync(resultPath, 0o444);
    return 0;
  };
}

test("FG-540 int: invoke — recovered result that cannot be persisted FAILS CLOSED as result_missing (no throw out of dispatch)", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "red-wide",
    task: "review the diff",
    projectDir: "/tmp/test-project",
    readOnlyProject: true,
    runtimeName: "codex-stub",
    dockerExec: makeUnwritableResultExec(codexStream(JSON.stringify(PASS_OBJECT))),
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /could not be persisted/);
  assert.equal(failureKindForTask(r.taskId), "result_missing");
  const task = getTask(r.taskId)!;
  assert.equal(task.status, "failed");
  const evTypes = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(!evTypes.includes("task.result_recovered_from_stream"), "no recovery provenance for a result that never landed");
  assert.ok(!evTypes.includes("task.completed"));
});

// ---------------------------------------------------------------------------
// runNext (workflow) path — symmetry with invoke via the one shared rule
// ---------------------------------------------------------------------------

test("FG-540 int: runNext — a recovered object rides the NORMAL workflow path, including the FG-523 validation gate (engineer result without tests_run holds at awaiting_gate, not complete)", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("engineer");
  const { runId } = startRun({
    workflow: wf, title: "fg540-rn", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const wave = await runNext({ runId, workflow: wf, dockerExec: makeCodexNoResultExec(codexStream(JSON.stringify(PASS_OBJECT))) });

  // Recovery supplied the result — the step did NOT fail result_missing —
  // and then the FG-523 validation contract held it exactly as it would hold
  // a file-written implementer result missing tests_run. Recovery pre-blesses
  // nothing downstream.
  assert.deepEqual(wave.failedSteps, [], "recovery must prevent the result_missing failure");
  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "awaiting_gate");
  assert.deepEqual(task.result, PASS_OBJECT);
  const onDisk = JSON.parse(readFileSync(join(taskDir(runId, task.id), "result.json"), "utf8"));
  assert.deepEqual(onDisk, PASS_OBJECT);
  const evTypes = eventsForTask(task.id).map((e) => e.eventType);
  assert.ok(evTypes.includes("task.result_recovered_from_stream"));
  assert.ok(evTypes.includes("task.awaiting_gate"), "the recovered result passes through the normal validation-contract gate");
});

test("FG-540 int: runNext — a recovered object that satisfies the validation contract completes the step normally", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("engineer");
  const { runId } = startRun({
    workflow: wf, title: "fg540-rn-ok", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const validated = { ...PASS_OBJECT, tests_run: 12, tests_passed: 12 };
  const wave = await runNext({ runId, workflow: wf, dockerExec: makeCodexNoResultExec(codexStream(JSON.stringify(validated))) });

  assert.deepEqual(wave.completedSteps, ["step"]);
  assert.deepEqual(wave.failedSteps, []);
  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "complete");
  assert.deepEqual(task.result, validated);
  const evTypes = eventsForTask(task.id).map((e) => e.eventType);
  assert.ok(evTypes.includes("task.result_recovered_from_stream"));
  assert.ok(evTypes.includes("task.completed"));
});

test("FG-540 int: runNext — recovered result that cannot be persisted FAILS the step closed (dispatcher records the failure, never throws)", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("engineer");
  const { runId } = startRun({
    workflow: wf, title: "fg540-rn-unwritable", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const validated = { ...PASS_OBJECT, tests_run: 12, tests_passed: 12 };
  const wave = await runNext({ runId, workflow: wf, dockerExec: makeUnwritableResultExec(codexStream(JSON.stringify(validated))) });

  assert.deepEqual(wave.failedSteps, ["step"]);
  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "failed");
  assert.equal(failureKindForTask(task.id), "result_missing");
  assert.match(task.error ?? "", /could not be persisted/);
  const evTypes = eventsForTask(task.id).map((e) => e.eventType);
  assert.ok(!evTypes.includes("task.result_recovered_from_stream"));
});

test("FG-540 int: runNext — prose terminal message on a structured step still fails result_missing (no narrative inference for structured roles)", async () => {
  ensureCodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("engineer");
  const { runId } = startRun({
    workflow: wf, title: "fg540-rn-neg", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const wave = await runNext({ runId, workflow: wf, dockerExec: makeCodexNoResultExec(codexStream("narrative only")) });

  assert.deepEqual(wave.failedSteps, ["step"]);
  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "failed");
  assert.equal(failureKindForTask(task.id), "result_missing");
});
