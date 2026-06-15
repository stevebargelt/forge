// Integration tests for FG-324: compression event metrics enhancement.
// Verifies that compression.verification events include original_size_bytes,
// compressed_size_bytes, compression_ratio, and method fields when orchestrator
// compresses; and that these fields are absent/undefined on agent-compressed paths.
//
// Covers: invoke.ts (orchestrator-compressed path), runNext.ts (orchestrator-compressed
// path), agent-compressed path (no size metrics), and SQLite event payload shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { RESULT_COMPRESSION_THRESHOLD } from "./compression-verification.js";
import { COMPRESSION_THRESHOLD } from "./compression.js";
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

/** Builds a result that exceeds RESULT_COMPRESSION_THRESHOLD (20KB) and has one
 *  large string field that will be compressed by the orchestrator. */
function makeLargeResult(): Record<string, unknown> {
  return {
    status: "complete",
    notes: "X".repeat(25 * 1024),  // 25KB — exceeds both thresholds
    summary: "large result for fg324 test",
  };
}

const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "test-compression-metrics",
  description: "single step workflow for compression metrics tests",
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

// --- Tests: invoke.ts orchestrator-compressed path ---

test("FG-324/invoke: original_size_bytes is set and matches raw result size", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg324-orig-size-"));
  const bigResult = makeLargeResult();
  const rawSize = Buffer.byteLength(JSON.stringify(bigResult), "utf8");
  assert.ok(rawSize > RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must exceed 20KB (got ${rawSize}B)`);

  const r = await invoke({
    agentRole: "engineer",
    task: "produce large output for FG-324 original_size test",
    projectDir,
    dockerExec: makeStubExec(bigResult),
  });

  assert.equal(r.status, "complete");

  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged");

  const payload = cvEvent!.payload as Record<string, unknown>;
  assert.equal(typeof payload["original_size_bytes"], "number", "original_size_bytes must be a number in the event payload");
  assert.ok((payload["original_size_bytes"] as number) > 0, "original_size_bytes must be positive");
  // original_size_bytes must equal the raw JSON byte size before compression
  assert.equal(payload["original_size_bytes"], rawSize, "original_size_bytes must match the pre-compression JSON byte size");
});

test("FG-324/invoke: compressed_size_bytes is less than original when orchestrator compresses", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg324-comp-size-"));
  const bigResult = makeLargeResult();

  const r = await invoke({
    agentRole: "engineer",
    task: "produce large output for FG-324 compressed_size test",
    projectDir,
    dockerExec: makeStubExec(bigResult),
  });

  assert.equal(r.status, "complete");

  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged");

  const payload = cvEvent!.payload as Record<string, unknown>;
  // Only assert on compressed_size_bytes when orchestrator actually compressed.
  if (payload["orchestrator_compressed"] === true) {
    assert.equal(typeof payload["compressed_size_bytes"], "number", "compressed_size_bytes must be a number");
    assert.ok((payload["compressed_size_bytes"] as number) > 0, "compressed_size_bytes must be positive");
    assert.ok(
      (payload["compressed_size_bytes"] as number) < (payload["original_size_bytes"] as number),
      `compressed_size_bytes (${payload["compressed_size_bytes"]}) must be less than original_size_bytes (${payload["original_size_bytes"]}) — compression must have reduced size`,
    );
  }
});

test("FG-324/invoke: compression_ratio = compressed / original within reasonable bounds", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg324-ratio-"));
  const bigResult = makeLargeResult();

  const r = await invoke({
    agentRole: "engineer",
    task: "produce large output for FG-324 compression_ratio test",
    projectDir,
    dockerExec: makeStubExec(bigResult),
  });

  assert.equal(r.status, "complete");

  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged");

  const payload = cvEvent!.payload as Record<string, unknown>;
  if (payload["orchestrator_compressed"] === true) {
    assert.equal(typeof payload["compression_ratio"], "number", "compression_ratio must be a number");

    const ratio = payload["compression_ratio"] as number;
    const compressed = payload["compressed_size_bytes"] as number;
    const original = payload["original_size_bytes"] as number;

    // ratio = compressed / original — must be in (0, 1) when compression succeeded
    assert.ok(ratio > 0, "compression_ratio must be positive");
    assert.ok(ratio < 1.0, `compression_ratio (${ratio}) must be < 1.0 when compression reduced size`);

    // The ratio must be consistent with compressed_size_bytes / original_size_bytes
    const expectedRatio = compressed / original;
    assert.ok(
      Math.abs(ratio - expectedRatio) < 0.001,
      `compression_ratio ${ratio} must match compressed_size_bytes/original_size_bytes = ${expectedRatio}`,
    );
  }
});

test("FG-324/invoke: method field contains a valid compression method name", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg324-method-"));
  const bigResult = makeLargeResult();

  const r = await invoke({
    agentRole: "engineer",
    task: "produce large output for FG-324 method test",
    projectDir,
    dockerExec: makeStubExec(bigResult),
  });

  assert.equal(r.status, "complete");

  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged");

  const payload = cvEvent!.payload as Record<string, unknown>;
  if (payload["orchestrator_compressed"] === true) {
    assert.equal(typeof payload["method"], "string", "method must be a string");
    // Valid methods known to compression.ts: 'headroom' or 'none'
    // For orchestrator compression, only 'headroom' is used (method=none means no compression happened)
    const validMethods = ["headroom"];
    assert.ok(
      validMethods.includes(payload["method"] as string),
      `method '${payload["method"]}' must be one of: ${validMethods.join(", ")}`,
    );
  }
});

// --- Test: agent-compressed path — metrics absent (no orchestrator compression) ---

test("FG-324/invoke: agent-compressed path does NOT include size/ratio/method metrics in event", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg324-agent-comp-"));

  // Agent-compressed result: has *_compressed metadata + padding to exceed 20KB
  const agentCompressedResult = {
    status: "complete",
    notes_compressed: {
      compressed_id: "abc123",
      original_size: 50000,
      compressed_size: 600,
      compression_ratio: 0.012,
    },
    padding: "P".repeat(25 * 1024),
  };
  const rawSize = Buffer.byteLength(JSON.stringify(agentCompressedResult), "utf8");
  assert.ok(rawSize > RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must exceed 20KB (got ${rawSize}B)`);

  const r = await invoke({
    agentRole: "engineer",
    task: "produce agent-compressed output for FG-324",
    projectDir,
    dockerExec: makeStubExec(agentCompressedResult),
  });

  assert.equal(r.status, "complete");

  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged");

  const payload = cvEvent!.payload as Record<string, unknown>;
  assert.equal(payload["agent_compressed"], true, "agent_compressed must be true");
  assert.equal(payload["orchestrator_compressed"], false, "orchestrator must not have compressed");

  // When agent compressed, orchestrator skips — no size metrics should be set
  // (original_size_bytes may be undefined or absent; compressed_size_bytes/ratio/method must not be set)
  assert.equal(
    payload["compressed_size_bytes"],
    undefined,
    "compressed_size_bytes must be absent on agent-compressed path",
  );
  assert.equal(
    payload["compression_ratio"],
    undefined,
    "compression_ratio must be absent on agent-compressed path",
  );
  assert.equal(
    payload["method"],
    undefined,
    "method must be absent on agent-compressed path",
  );
});

// --- Test: runNext.ts orchestrator-compressed path ---

test("FG-324/runNext: compression event via runNext pipeline includes all 4 metric fields", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg324-runnext-"));
  const bigResult = makeLargeResult();
  const rawSize = Buffer.byteLength(JSON.stringify(bigResult), "utf8");
  assert.ok(rawSize > RESULT_COMPRESSION_THRESHOLD, `pre-condition: result must exceed 20KB (got ${rawSize}B)`);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg324 runNext compression metrics test",
    projectDir,
    inputs: { brief: "metrics integration test" },
  });

  const result = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeStubExec(bigResult),
  });

  assert.ok(result.completedSteps.includes("work"), "work step must complete");

  const tasks = tasksForRun(runId);
  const workTask = tasks.find((t) => t.phase === "work" && t.parentId === undefined);
  assert.ok(workTask, "work task must exist");

  const events = eventsForTask(workTask!.id);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification event must be logged via runNext path");

  const payload = cvEvent!.payload as Record<string, unknown>;

  // original_size_bytes must always be present and equal the raw JSON size
  assert.equal(typeof payload["original_size_bytes"], "number", "original_size_bytes must be a number in runNext path");
  assert.equal(payload["original_size_bytes"], rawSize, "original_size_bytes must match raw result JSON size");

  if (payload["orchestrator_compressed"] === true) {
    // All 4 fields must be present and internally consistent
    assert.equal(typeof payload["compressed_size_bytes"], "number", "compressed_size_bytes must be a number");
    assert.equal(typeof payload["compression_ratio"], "number", "compression_ratio must be a number");
    assert.equal(typeof payload["method"], "string", "method must be a string");

    const compressed = payload["compressed_size_bytes"] as number;
    const original = payload["original_size_bytes"] as number;
    const ratio = payload["compression_ratio"] as number;

    assert.ok(compressed < original, "compressed_size_bytes must be less than original_size_bytes");
    assert.ok(ratio > 0 && ratio < 1.0, `compression_ratio ${ratio} must be in (0, 1)`);
    assert.equal(payload["method"], "headroom", "method must be 'headroom' for orchestrator compression");
  }
});

// --- Test: SQLite event payload shape ---

test("FG-324/sqlite: compression.verification event payload JSON in SQLite has new metric fields", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg324-sqlite-"));
  const bigResult = makeLargeResult();

  const r = await invoke({
    agentRole: "engineer",
    task: "produce large output for FG-324 SQLite payload test",
    projectDir,
    dockerExec: makeStubExec(bigResult),
  });

  assert.equal(r.status, "complete");

  // eventsForTask reads the events table from SQLite — this verifies the full
  // round-trip: compression-verification.ts wrote the fields, invoke.ts called
  // logEvent, and the store persisted + deserialized them correctly.
  const events = eventsForTask(r.taskId);
  const cvEvent = events.find((e) => e.eventType === "compression.verification");
  assert.ok(cvEvent !== undefined, "compression.verification must be stored in SQLite");

  // The payload must be a plain object (JSON deserialized from the events.payload column)
  assert.ok(cvEvent!.payload !== null, "event payload must not be null");
  assert.equal(typeof cvEvent!.payload, "object", "event payload must be an object");
  assert.ok(!Array.isArray(cvEvent!.payload), "event payload must not be an array");

  const payload = cvEvent!.payload as Record<string, unknown>;

  // Core fields from FG-317 must still be present
  assert.ok("agent_compressed" in payload, "agent_compressed must be in SQLite payload");
  assert.ok("orchestrator_compressed" in payload, "orchestrator_compressed must be in SQLite payload");
  assert.ok("fields_compressed" in payload, "fields_compressed must be in SQLite payload");

  // FG-324 fields: original_size_bytes is always set for orchestrator-processed results
  assert.ok("original_size_bytes" in payload, "original_size_bytes must be in SQLite payload");
  assert.equal(typeof payload["original_size_bytes"], "number", "original_size_bytes must be a number in SQLite");

  // If orchestrator actually compressed, the other 3 metrics must be in SQLite too
  if (payload["orchestrator_compressed"] === true) {
    assert.ok("compressed_size_bytes" in payload, "compressed_size_bytes must be in SQLite payload when compressed");
    assert.ok("compression_ratio" in payload, "compression_ratio must be in SQLite payload when compressed");
    assert.ok("method" in payload, "method must be in SQLite payload when compressed");

    assert.equal(typeof payload["compressed_size_bytes"], "number");
    assert.equal(typeof payload["compression_ratio"], "number");
    assert.equal(typeof payload["method"], "string");
  }
});
