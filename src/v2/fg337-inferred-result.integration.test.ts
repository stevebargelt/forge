// FG-337 integration tests: inferred-result fallback — end-to-end wiring.
//
// These tests exercise the FULL runNext/invoke dispatch cycle against real pi
// JSONL fixtures. They do NOT test the unit-level analyzePiFailure or
// requiresStructuredResult functions in isolation — that's covered by
// pi-result.test.ts and role-capabilities unit tests. Instead, every test here
// drives a complete dispatch → container-return → result-read → status-write
// cycle and asserts the externally-visible outcome:
//   • task status in the DB (complete vs. failed)
//   • result.json content on disk
//   • lifecycle events emitted (task.completed, task.failed)
//   • failure_kind when a failure is expected
//
// Requirements exercised:
//   1. All three narrative roles (research-specialist, prompt-author, manual-qa)
//      complete via inferred result — both via runNext and invoke paths.
//   2. Structured role (engineer) still hard-fails — unchanged behavior.
//   3. Truncation (no agent_end) and model_error (errorMessage / auto_retry)
//      still fail with the right failure_kind even for a narrative role.
//   4. Symmetry: runNext and invoke produce identical inferred-result shape.
//   5. Non-pi runtime (claude): finalAssistantText is never extracted →
//      the inferred fallback is NOT triggered → unchanged failure behavior.
//   6. Content as an array of text blocks is captured and joined.
//   7. result.json is written to disk (not just the in-memory task row).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { invoke } from "./invoke.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { failureKindForTask } from "./failure-kind.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";

// ---------------------------------------------------------------------------
// Pi JSONL fixture builders
// ---------------------------------------------------------------------------

function piCleanEnd(content: string): string {
  return (
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "end_turn", content }],
    }) + "\n"
  );
}

function piCleanEndBlocks(blocks: Array<{ type: string; text: string }>): string {
  return (
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "end_turn", content: blocks }],
    }) + "\n"
  );
}

const PI_TRUNCATED =
  JSON.stringify({ type: "agent_start" }) + "\n";
  // no agent_end — simulates a crashed/truncated run

const PI_MODEL_ERROR_ASSISTANT =
  JSON.stringify({ type: "agent_start" }) + "\n" +
  JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "401 authentication_error: invalid x-api-key" }],
  }) + "\n";

const PI_AUTO_RETRY =
  JSON.stringify({ type: "auto_retry_warning", retryIn: 5 }) + "\n" +
  JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", content: "some narrative text" }],
  }) + "\n";
// NOTE: auto_retry_warning sets sawAutoRetry=true which takes priority over
// sawAgentEnd in analyzePiFailure → modelError=true, no finalAssistantText.

// ---------------------------------------------------------------------------
// Docker exec stub helpers
// ---------------------------------------------------------------------------

// Writes pi JSONL to stdout; leaves result.json empty (pi exits 0 without writing it).
function makePiNoResultExec(stdoutJsonl: string, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// Non-pi exec: writes plain text to stdout, leaves result.json empty, exits 0.
function makeClaudeNoResultExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "some plain-text output that is not pi JSONL");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

// ---------------------------------------------------------------------------
// Runtime YAML setup (idempotent)
// ---------------------------------------------------------------------------

function ensurePiRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "pi-stub.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `name: pi-stub
description: test stub pi runtime
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: pi
  args: ["-p"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function ensureClaudeRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `name: claude
description: test stub claude runtime
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
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// ---------------------------------------------------------------------------
// Workflow helper
// ---------------------------------------------------------------------------

let wfSeq = 0;
function makeWorkflow(agent: string, runtime: string): Workflow {
  const uid = ++wfSeq;
  return {
    name: `fg337-int-${uid}`,
    description: `FG-337 integration test workflow (${agent}/${runtime})`,
    inputs: [{ name: "brief", required: true, type: "text" }],
    steps: [
      {
        id: "step",
        agent,
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime,
        reds: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Requirement 1 — narrative roles via the runNext (workflow) path
// ---------------------------------------------------------------------------

test("FG-337 int: runNext — research-specialist completes via inferred result (string content)", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("research-specialist", "pi-stub");
  const { runId } = startRun({
    workflow: wf, title: "fg337-rn-rs", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const text = "Paris is the capital of France.";
  const wave = await runNext({ runId, workflow: wf, dockerExec: makePiNoResultExec(piCleanEnd(text)) });

  assert.deepEqual(wave.completedSteps, ["step"], "research-specialist step must complete");
  assert.deepEqual(wave.failedSteps, [], "no failed steps");
  assert.equal(wave.runStatus, "complete");

  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "complete");
  const result = task.result as Record<string, unknown>;
  assert.equal(result.contract, "inferred");
  assert.equal(result.summary, text);
  assert.equal(result.status, "complete");

  // Lifecycle: task.completed emitted; task.failed must NOT appear.
  const evTypes = eventsForTask(task.id).map((e) => e.eventType);
  assert.ok(evTypes.includes("task.completed"), "task.completed must be emitted");
  assert.ok(!evTypes.includes("task.failed"), "task.failed must NOT be emitted on inferred completion");
});

test("FG-337 int: runNext — prompt-author completes via inferred result", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("prompt-author", "pi-stub");
  const { runId } = startRun({
    workflow: wf, title: "fg337-rn-pa", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const text = "This is the authored prompt.";
  const wave = await runNext({ runId, workflow: wf, dockerExec: makePiNoResultExec(piCleanEnd(text)) });

  assert.deepEqual(wave.completedSteps, ["step"]);
  assert.deepEqual(wave.failedSteps, []);

  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "complete");
  const result = task.result as Record<string, unknown>;
  assert.equal(result.contract, "inferred");
  assert.equal(result.summary, text);
});

test("FG-337 int: runNext — manual-qa completes via inferred result", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("manual-qa", "pi-stub");
  const { runId } = startRun({
    workflow: wf, title: "fg337-rn-mqa", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const text = "QA found no issues in the tested flow.";
  const wave = await runNext({ runId, workflow: wf, dockerExec: makePiNoResultExec(piCleanEnd(text)) });

  assert.deepEqual(wave.completedSteps, ["step"]);

  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "complete");
  const result = task.result as Record<string, unknown>;
  assert.equal(result.contract, "inferred");
  assert.equal(result.summary, text);
});

// ---------------------------------------------------------------------------
// Requirement 1 — narrative roles via the invoke path
// ---------------------------------------------------------------------------

test("FG-337 int: invoke — prompt-author completes via inferred result + result.json persisted to disk", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-pa-"));
  try {
    const text = "Authored prompt text output.";
    const r = await invoke({
      agentRole: "prompt-author",
      task: "write a design prompt",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(piCleanEnd(text)),
    });

    assert.equal(r.status, "complete");
    const result = r.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred");
    assert.equal(result.summary, text);
    assert.equal(result.status, "complete");

    // Persisted to disk
    const dir = taskDir(r.runId, r.taskId);
    assert.ok(existsSync(join(dir, "result.json")), "result.json must exist on disk");
    const onDisk = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.contract, "inferred");
    assert.equal(onDisk.summary, text);

    // Events
    const evTypes = eventsForTask(r.taskId).map((e) => e.eventType);
    assert.ok(evTypes.includes("task.completed"), "task.completed must be emitted on invoke path");
    assert.ok(!evTypes.includes("task.failed"), "task.failed must NOT be emitted");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-337 int: invoke — manual-qa completes via inferred result", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-mqa-"));
  try {
    const text = "All user flows work as expected.";
    const r = await invoke({
      agentRole: "manual-qa",
      task: "test the dashboard",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(piCleanEnd(text)),
    });
    assert.equal(r.status, "complete");
    const result = r.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred");
    assert.equal(result.summary, text);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 2 — structured role still hard-fails (unchanged behavior)
// ---------------------------------------------------------------------------

test("FG-337 int: runNext — engineer still hard-fails even with clean pi completion + text", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("engineer", "pi-stub");
  const { runId } = startRun({
    workflow: wf, title: "fg337-rn-eng-fail", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const wave = await runNext({
    runId, workflow: wf,
    dockerExec: makePiNoResultExec(piCleanEnd("I wrote the code.")),
  });

  assert.deepEqual(wave.failedSteps, ["step"], "engineer step must fail");
  assert.deepEqual(wave.completedSteps, [], "no completed steps");

  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /completed but wrote no .*result\.json/);

  // task.failed emitted, task.completed NOT emitted
  const evTypes = eventsForTask(task.id).map((e) => e.eventType);
  assert.ok(evTypes.includes("task.failed"), "task.failed must be emitted for structured role");
  assert.ok(!evTypes.includes("task.completed"), "task.completed must NOT be emitted when engineer fails");
});

test("FG-337 int: invoke — engineer still hard-fails even with clean pi completion + text", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-eng-inv-"));
  try {
    const r = await invoke({
      agentRole: "engineer",
      task: "write some code",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(piCleanEnd("Here is my implementation.")),
    });
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /completed but wrote no .*result\.json/);
    const task = getTask(r.taskId)!;
    assert.equal(task.status, "failed");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 3 — truncation and model_error fail even for narrative roles
// ---------------------------------------------------------------------------

test("FG-337 int: runNext — truncated pi run (no agent_end) fails for research-specialist", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("research-specialist", "pi-stub");
  const { runId } = startRun({
    workflow: wf, title: "fg337-rn-trunc", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const wave = await runNext({ runId, workflow: wf, dockerExec: makePiNoResultExec(PI_TRUNCATED) });

  assert.deepEqual(wave.failedSteps, ["step"], "truncated run must fail even for narrative role");
  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /no completion event/,
    "truncated run error must mention missing completion event");
});

test("FG-337 int: invoke — truncated pi run (no agent_end) fails for prompt-author", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-trunc-inv-"));
  try {
    const r = await invoke({
      agentRole: "prompt-author",
      task: "write a prompt",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(PI_TRUNCATED),
    });
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /no completion event/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-337 int: runNext — model error (errorMessage) fails for manual-qa with model_error kind", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("manual-qa", "pi-stub");
  const { runId } = startRun({
    workflow: wf, title: "fg337-rn-modelerr", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const wave = await runNext({
    runId, workflow: wf, dockerExec: makePiNoResultExec(PI_MODEL_ERROR_ASSISTANT),
  });

  assert.deepEqual(wave.failedSteps, ["step"], "model error must fail even for narrative role");
  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /pi run failed/);
  assert.equal(failureKindForTask(task.id), "model_error",
    "model error must be classified as model_error, not result_missing");
});

test("FG-337 int: invoke — auto_retry signal fails for research-specialist with model_error kind", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-retry-inv-"));
  try {
    // auto_retry_warning takes priority over sawAgentEnd in analyzePiFailure →
    // modelError=true, finalAssistantText never returned.
    const r = await invoke({
      agentRole: "research-specialist",
      task: "research with auto-retry",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(PI_AUTO_RETRY),
    });
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /pi run failed/);
    assert.match(r.error ?? "", /auto-retried/i);
    assert.equal(failureKindForTask(r.taskId), "model_error",
      "auto_retry must be classified as model_error (not result_missing)");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 4 — symmetry: identical result shape via runNext and invoke
// ---------------------------------------------------------------------------

test("FG-337 int: symmetry — runNext and invoke produce identical inferred result shape", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const text = "Symmetry check: the inferred text is the same on both paths.";
  const stdout = piCleanEnd(text);

  // runNext path
  const wfRn = makeWorkflow("research-specialist", "pi-stub");
  const { runId: rnRunId } = startRun({
    workflow: wfRn, title: "fg337-symm-rn", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });
  await runNext({ runId: rnRunId, workflow: wfRn, dockerExec: makePiNoResultExec(stdout) });
  const rnTask = tasksForRun(rnRunId).find((t) => t.phase === "step")!;
  const rnResult = rnTask.result as Record<string, unknown>;

  // invoke path
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-symm-"));
  try {
    const invR = await invoke({
      agentRole: "research-specialist",
      task: "symmetric task",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(stdout),
    });

    // Both paths must report complete
    assert.equal(rnTask.status, "complete", "runNext: task must be complete");
    assert.equal(invR.status, "complete", "invoke: must report complete");

    // Both paths must produce the same result shape
    const invResult = invR.result as Record<string, unknown>;
    assert.equal(rnResult.contract, "inferred", "runNext: contract=inferred");
    assert.equal(invResult.contract, "inferred", "invoke: contract=inferred");
    assert.equal(rnResult.summary, text, "runNext: summary must carry assistant text");
    assert.equal(invResult.summary, text, "invoke: summary must carry assistant text");
    assert.equal(rnResult.status, "complete", "runNext: result.status=complete");
    assert.equal(invResult.status, "complete", "invoke: result.status=complete");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 5 — non-pi runtime: finalAssistantText not extracted → no fallback
// ---------------------------------------------------------------------------

test("FG-337 int: invoke — non-pi runtime (claude) does NOT trigger inferred fallback for research-specialist", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-nonpi-"));
  try {
    // claude runtime: resolveRuntimeMetadata returns logFormat="claude-stream-json".
    // analyzeClaudeFailure on non-JSONL text returns { modelError: false } with no
    // finalAssistantText — the inferred fallback condition never fires.
    const r = await invoke({
      agentRole: "research-specialist",
      task: "research with claude runtime",
      projectDir,
      runtimeName: "claude",
      dockerExec: makeClaudeNoResultExec(),
    });

    assert.equal(r.status, "failed",
      "non-pi runtime must still fail when no result.json is written (no inferred fallback)");
    // Error must be the generic no_result_json attribution, not a model error
    assert.equal(r.error, "no_result_json", "error must be the bare no_result_json (not an inferred result)");

    const task = getTask(r.taskId)!;
    assert.equal(task.status, "failed");
    // result.json on disk must be empty or absent — never written with contract: "inferred"
    const dir = taskDir(r.runId, r.taskId);
    const onDiskRaw = readFileSync(join(dir, "result.json"), "utf8").trim();
    if (onDiskRaw.length > 0) {
      const onDisk = JSON.parse(onDiskRaw) as Record<string, unknown>;
      assert.notEqual(onDisk.contract, "inferred",
        "non-pi runtime must not write an inferred result to disk");
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 6 — content as array of text blocks
// ---------------------------------------------------------------------------

test("FG-337 int: invoke — content as array of text blocks is captured and joined", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-blocks-"));
  try {
    const blocks = [
      { type: "text", text: "First research finding." },
      { type: "text", text: "Second research finding." },
    ];
    const r = await invoke({
      agentRole: "research-specialist",
      task: "research with block content",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(piCleanEndBlocks(blocks)),
    });
    assert.equal(r.status, "complete");
    const result = r.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred");
    // extractAssistantText joins blocks with "\n"
    assert.equal(result.summary, "First research finding.\nSecond research finding.");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 7 — result.json written to disk on the runNext path
// ---------------------------------------------------------------------------

test("FG-337 int: runNext — inferred result is written to result.json on disk (not just task DB row)", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf = makeWorkflow("research-specialist", "pi-stub");
  const { runId } = startRun({
    workflow: wf, title: "fg337-disk-rn", inputs: { brief: "x" }, projectDir: "/tmp/test-project",
  });

  const text = "Disk persistence verification text.";
  await runNext({ runId, workflow: wf, dockerExec: makePiNoResultExec(piCleanEnd(text)) });

  const task = tasksForRun(runId).find((t) => t.phase === "step")!;
  assert.equal(task.status, "complete", "task must complete");

  // runContainer writes the inferred result to disk before returning ok.
  const dir = taskDir(runId, task.id);
  const resultPath = join(dir, "result.json");
  assert.ok(existsSync(resultPath), "result.json must exist on disk after runNext inferred completion");
  const onDisk = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.contract, "inferred", "on-disk contract must be 'inferred'");
  assert.equal(onDisk.summary, text, "on-disk summary must carry the assistant text");
  assert.equal(onDisk.status, "complete");
});
