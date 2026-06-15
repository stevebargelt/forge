// Integration tests for FG-317: orchestrator compression safety net.
// Exercises the maybeOrchestratorCompress integration in invoke.ts and runNext.ts.
// Uses stubbed dockerExec (no real containers); asserts:
//   - Large uncompressed result (>20KB) triggers post-hoc orchestrator compression
//   - compression.verification event is logged with correct payload
//   - Compressed result can be read back (round-trip)
//   - Agent that properly compresses does NOT trigger fallback compression

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { RESULT_COMPRESSION_THRESHOLD } from "./compression-verification.js";
import { COMPRESSION_THRESHOLD } from "./compression.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";

// --- Helpers ---

function makeStubExec(resultJson: unknown, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(resultJson));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

function setupRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `
name: claude
description: test stub
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

/** Build a result object with a single large string field that exceeds 20KB total. */
function makeLargeUncompressedResult(): Record<string, unknown> {
  // The result must exceed RESULT_COMPRESSION_THRESHOLD (20KB).
  // notes must also exceed COMPRESSION_THRESHOLD (10KB) so maybeOrchestratorCompress
  // flags it as a large field. Using 25KB ensures both thresholds are exceeded.
  const notes = "X".repeat(25 * 1024);
  return {
    status: "complete",
    notes,
    summary: "integration test result",
  };
}

// Minimal single-step workflow for runNext integration tests.
const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "test-compression-safety",
  description: "single step for compression safety net test",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    {
      id: "work",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
  ],
};

// --- Tests: invoke.ts path ---

test("FG-317/invoke: large uncompressed result triggers orchestrator post-hoc compression", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg317-invoke-large-"));
  const bigResult = makeLargeUncompressedResult();
  const rawSize = Buffer.byteLength(JSON.stringify(bigResult), "utf8");
  assert.ok(rawSize > RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must exceed 20KB (got ${rawSize}B)`);

  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));

  try {
    const r = await invoke({
      agentRole: "engineer",
      task: "produce large output",
      projectDir,
      dockerExec: makeStubExec(bigResult),
    });

    assert.equal(r.status, "complete", "invoke must complete successfully");

    // The result must carry compressionVerification — the safety net fires when
    // large string fields are found, regardless of whether headroom succeeds.
    const resultObj = r.result as Record<string, unknown>;
    assert.ok("compressionVerification" in resultObj, "compressionVerification key must be present after safety net runs");
    const cv = resultObj["compressionVerification"] as Record<string, unknown>;
    assert.equal(cv["agent_compressed"], false, "agent_compressed must be false");
    assert.equal(typeof cv["orchestrator_compressed"], "boolean", "orchestrator_compressed must be a boolean");
    assert.ok(Array.isArray(cv["fields_compressed"]), "fields_compressed must be an array");
    // If headroom compressed the field, it should be listed.
    if (cv["orchestrator_compressed"] === true) {
      assert.ok((cv["fields_compressed"] as string[]).includes("notes"), "notes field must be in fields_compressed when compressed");
    }
  } finally {
    console.error = origError;
  }
});

test("FG-317/invoke: compression.verification event is logged for large uncompressed result", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg317-invoke-event-"));
  const bigResult = makeLargeUncompressedResult();

  const r = await invoke({
    agentRole: "engineer",
    task: "produce large output for event test",
    projectDir,
    dockerExec: makeStubExec(bigResult),
  });

  assert.equal(r.status, "complete");

  // Check that compression.verification event was logged for this task.
  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged");

  // Payload should carry the verification metadata.
  const payload = cvEvent!.payload as Record<string, unknown>;
  assert.equal(payload["agent_compressed"], false);
  assert.equal(typeof payload["orchestrator_compressed"], "boolean");
  assert.ok(Array.isArray(payload["fields_compressed"]), "fields_compressed must be an array");
  // If headroom compressed, notes must appear in fields_compressed.
  if (payload["orchestrator_compressed"] === true) {
    assert.ok((payload["fields_compressed"] as string[]).includes("notes"));
  }
});

test("FG-317/invoke: compressed result can be read back (round-trip via result.json on disk)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg317-invoke-roundtrip-"));
  const bigResult = makeLargeUncompressedResult();

  const r = await invoke({
    agentRole: "engineer",
    task: "produce large output for round-trip test",
    projectDir,
    dockerExec: makeStubExec(bigResult),
  });

  assert.equal(r.status, "complete");

  // Find the result.json on disk and verify it's valid JSON with compressionVerification.
  const resultPath = join(taskDir(r.runId, r.taskId), "result.json");
  assert.ok(existsSync(resultPath), `result.json must exist at ${resultPath}`);

  const raw = readFileSync(resultPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  // The on-disk result must carry compressionVerification.
  assert.ok("compressionVerification" in parsed, "on-disk result must have compressionVerification");
  const cv = parsed["compressionVerification"] as Record<string, unknown>;
  assert.equal(typeof cv["orchestrator_compressed"], "boolean");
  assert.ok(Array.isArray(cv["fields_compressed"]));

  // notes field must still be a valid string — orchestrator must not lose the field.
  assert.equal(typeof parsed["notes"], "string", "notes field must remain a string after compression");
});

test("FG-317/invoke: agent that properly compresses does NOT trigger orchestrator fallback", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg317-invoke-agent-compressed-"));

  // Build a result that exceeds 20KB BUT has agent-written *_compressed metadata,
  // so maybeOrchestratorCompress must skip compression and report agent_compressed=true.
  const notes = "A".repeat(25 * 1024);
  const agentCompressedResult = {
    status: "complete",
    notes_compressed: {
      compressed_id: "abc123",
      original_size: Buffer.byteLength(notes, "utf8"),
      compressed_size: 600,
      compression_ratio: 0.9,
    },
    summary: "agent compressed this result",
    // Add enough padding to push total JSON size above 20KB.
    padding: "P".repeat(25 * 1024),
  };
  const rawSize = Buffer.byteLength(JSON.stringify(agentCompressedResult), "utf8");
  assert.ok(rawSize > RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must exceed 20KB (got ${rawSize}B)`);

  const r = await invoke({
    agentRole: "engineer",
    task: "produce agent-compressed output",
    projectDir,
    dockerExec: makeStubExec(agentCompressedResult),
  });

  assert.equal(r.status, "complete");

  // compression.verification event must be logged.
  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged even when agent compressed");

  const payload = cvEvent!.payload as Record<string, unknown>;
  assert.equal(payload["agent_compressed"], true, "agent_compressed must be true");
  assert.equal(payload["orchestrator_compressed"], false, "orchestrator must NOT have compressed when agent already did");
  assert.deepEqual(payload["fields_compressed"], [], "fields_compressed must be empty when agent compressed");

  // The result must be passed through unchanged (no compressionVerification added by orchestrator).
  const resultObj = r.result as Record<string, unknown>;
  assert.ok(!("compressionVerification" in resultObj), "orchestrator must NOT add compressionVerification when agent already compressed");
});

test("FG-317/invoke: small result (<20KB) does NOT trigger compression or log event", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg317-invoke-small-"));

  // A small result well below 20KB.
  const smallResult = { status: "complete", output: "hello world" };
  const rawSize = Buffer.byteLength(JSON.stringify(smallResult), "utf8");
  assert.ok(rawSize < RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must be below 20KB (got ${rawSize}B)`);

  const r = await invoke({
    agentRole: "engineer",
    task: "produce small output",
    projectDir,
    dockerExec: makeStubExec(smallResult),
  });

  assert.equal(r.status, "complete");

  // No compression.verification event should be logged for small results.
  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.equal(cvEvent, undefined, "compression.verification must NOT be logged for small results");

  // Result must be unchanged.
  const resultObj = r.result as Record<string, unknown>;
  assert.ok(!("compressionVerification" in resultObj), "compressionVerification must NOT be in small result");
  assert.equal(resultObj["output"], "hello world");
});

// --- Tests: runNext.ts path ---

test("FG-317/runNext: large uncompressed result triggers orchestrator compression via runNext pipeline", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg317-runnext-large-"));
  const bigResult = makeLargeUncompressedResult();
  const rawSize = Buffer.byteLength(JSON.stringify(bigResult), "utf8");
  assert.ok(rawSize > RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must exceed 20KB (got ${rawSize}B)`);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg317 compression integration test",
    projectDir,
    inputs: { brief: "integration test" },
  });

  const result = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeStubExec(bigResult),
  });

  assert.ok(result.completedSteps.includes("work"), "work step must complete");

  // Find the task and verify compression.verification event.
  const tasks = tasksForRun(runId);
  const workTask = tasks.find((t) => t.phase === "work" && t.parentId === undefined);
  assert.ok(workTask, "work task must exist");

  const events = eventsForTask(workTask!.id);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged via runNext path");

  const payload = cvEvent!.payload as Record<string, unknown>;
  assert.equal(payload["agent_compressed"], false);
  assert.equal(typeof payload["orchestrator_compressed"], "boolean");
  assert.ok(Array.isArray(payload["fields_compressed"]));

  // Verify via the on-disk result.json.
  const resultPath = join(taskDir(runId, workTask!.id), "result.json");
  if (existsSync(resultPath)) {
    const diskResult = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    assert.ok("compressionVerification" in diskResult, "on-disk result must have compressionVerification");
  }
});

test("FG-317/runNext: agent-compressed result passes through without orchestrator intervention", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg317-runnext-agentcomp-"));

  // Agent-compressed result: has *_compressed metadata key, total JSON > 20KB.
  const agentCompressedResult = {
    status: "complete",
    output_compressed: {
      compressed_id: "xyz789",
      original_size: 50000,
      compressed_size: 5000,
      compression_ratio: 0.9,
    },
    // Pad to exceed 20KB total JSON.
    padding: "P".repeat(25 * 1024),
  };
  const rawSize = Buffer.byteLength(JSON.stringify(agentCompressedResult), "utf8");
  assert.ok(rawSize > RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must exceed 20KB (got ${rawSize}B)`);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg317 agent-compressed integration test",
    projectDir,
    inputs: { brief: "agent compressed test" },
  });

  await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeStubExec(agentCompressedResult),
  });

  const tasks = tasksForRun(runId);
  const workTask = tasks.find((t) => t.phase === "work" && t.parentId === undefined);
  assert.ok(workTask, "work task must exist");

  const events = eventsForTask(workTask!.id);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged");

  const payload = cvEvent!.payload as Record<string, unknown>;
  assert.equal(payload["agent_compressed"], true, "agent_compressed must be true");
  assert.equal(payload["orchestrator_compressed"], false, "orchestrator must not compress when agent already did");
});
