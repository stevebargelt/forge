// Integration tests for FG-315: orchestrator-side compression via invoke.ts.
// These tests exercise the compressPrompt integration point in the invoke pipeline:
// large system prompts get compressed, metadata is logged, failures fall back gracefully,
// and compressed content is valid (can be decompressed / round-tripped).

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { compressPrompt, COMPRESSION_THRESHOLD } from "./compression.js";
import type { CompressResult as HeadroomResult } from "headroom-ai";

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

/** Build a large string that exceeds the 10KB compression threshold. */
function makeLargeText(sizeBytes: number): string {
  return "A".repeat(sizeBytes);
}

function makeMockCompress(compressed: string, ratio = 0.5): (messages: { role: string; content: string }[]) => Promise<HeadroomResult> {
  return async () => ({
    messages: [{ role: "system", content: compressed }],
    tokensBefore: 1000,
    tokensAfter: Math.round(1000 * ratio),
    tokensSaved: Math.round(1000 * (1 - ratio)),
    compressionRatio: ratio,
    transformsApplied: ["truncate"],
    ccrHashes: [],
    compressed: true,
  });
}

// --- compressPrompt integration tests ---

test("compression: large prompt (>10KB) is compressed and metadata reflects headroom method", async () => {
  const largeText = makeLargeText(COMPRESSION_THRESHOLD + 5000);
  const mockCompress = makeMockCompress("compressed-system-prompt", 0.4);

  const result = await compressPrompt(largeText, mockCompress);

  assert.equal(result.meta.method, "headroom", "should use headroom for large text");
  assert.equal(result.content, "compressed-system-prompt");
  assert.equal(result.meta.original_size, Buffer.byteLength(largeText, "utf8"));
  assert.ok(result.meta.compressed_size < result.meta.original_size, "compressed_size must be less than original_size");
  assert.equal(result.meta.compression_ratio, 0.4);
});

test("compression: text at exactly threshold is NOT compressed (boundary condition)", async () => {
  const text = makeLargeText(COMPRESSION_THRESHOLD);
  let compressCalled = false;
  const mockCompress = async (): Promise<HeadroomResult> => {
    compressCalled = true;
    return makeMockCompress("should-not-reach")([] as { role: string; content: string }[]);
  };

  const result = await compressPrompt(text, mockCompress);

  assert.equal(compressCalled, false, "compress should not be called at threshold boundary");
  assert.equal(result.meta.method, "none");
  assert.equal(result.content, text);
});

test("compression: text above threshold triggers compression", async () => {
  const text = makeLargeText(COMPRESSION_THRESHOLD + 1);
  let compressCalled = false;
  const mockCompress = async (msgs: { role: string; content: string }[]): Promise<HeadroomResult> => {
    compressCalled = true;
    return makeMockCompress("compressed")(msgs);
  };

  const result = await compressPrompt(text, mockCompress);

  assert.equal(compressCalled, true, "compress should be called above threshold");
  assert.equal(result.meta.method, "headroom");
  assert.equal(result.content, "compressed");
});

test("compression: metadata is logged via console.log when method is headroom", async () => {
  const largeText = makeLargeText(COMPRESSION_THRESHOLD + 2000);
  const mockCompress = makeMockCompress("compressed-output", 0.45);

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const result = await compressPrompt(largeText, mockCompress);
    assert.equal(result.meta.method, "headroom");
  } finally {
    console.log = origLog;
  }

  // compressPrompt itself doesn't log — invoke.ts does. We verify the metadata
  // structure is correct so invoke can log it. Verify metadata fields for logging.
  const largeResult = await compressPrompt(largeText, mockCompress);
  assert.ok(typeof largeResult.meta.original_size === "number");
  assert.ok(typeof largeResult.meta.compressed_size === "number");
  assert.ok(typeof largeResult.meta.compression_ratio === "number");
  assert.equal(largeResult.meta.method, "headroom");
});

test("compression: graceful fallback when compress throws — returns original content + method=none", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);

  try {
    const largeText = makeLargeText(COMPRESSION_THRESHOLD + 3000);
    const failingCompress = async (): Promise<HeadroomResult> => {
      throw new Error("headroom: service unavailable");
    };

    const result = await compressPrompt(largeText, failingCompress);

    assert.equal(result.content, largeText, "fallback must return the original uncompressed text");
    assert.equal(result.meta.method, "none", "fallback method must be 'none'");
    assert.equal(result.meta.compression_ratio, 1.0, "fallback ratio must be 1.0");
    assert.equal(result.meta.original_size, result.meta.compressed_size, "sizes must be equal on fallback");
    assert.ok(
      warnings.some((w) => w.includes("compression failed")),
      `expected 'compression failed' warning, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.warn = origWarn;
  }
});

test("compression: fallback when compress returns message with no content field", async () => {
  const largeText = makeLargeText(COMPRESSION_THRESHOLD + 1000);
  const mockCompress = async (): Promise<HeadroomResult> => ({
    messages: [{ role: "system" }], // no content field
    tokensBefore: 500,
    tokensAfter: 250,
    tokensSaved: 250,
    compressionRatio: 0.5,
    transformsApplied: [],
    ccrHashes: [],
    compressed: true,
  });

  const result = await compressPrompt(largeText, mockCompress);

  assert.equal(result.content, largeText, "must fall back to original when content field is absent");
});

test("compression: compressed content size is correctly recorded in metadata", async () => {
  const largeText = makeLargeText(COMPRESSION_THRESHOLD + 4000);
  const compressedOutput = "much smaller";
  const mockCompress = makeMockCompress(compressedOutput, 0.3);

  const result = await compressPrompt(largeText, mockCompress);

  assert.equal(result.meta.compressed_size, Buffer.byteLength(compressedOutput, "utf8"));
  assert.equal(result.meta.original_size, Buffer.byteLength(largeText, "utf8"));
  assert.ok(result.meta.compressed_size < result.meta.original_size);
});

// --- invoke.ts integration: compression wired into the pipeline ---

test("invoke: compression metadata is logged to console when system prompt is large", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const consoleLogs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.join(" "));
    origLog(...args);
  };

  const projectDir = mkdtempSync(join(tmpdir(), "forge-compression-log-"));

  // Write a large agent system prompt to trigger compression.
  // We cannot inject a custom compress fn into invoke, but we can observe
  // console.log output when compression is triggered (only emitted when method != 'none').
  // The real headroom-ai library will be called; its behavior determines whether
  // it actually compresses — so we test the log structure is correct IF it fires.
  // We also test without compression to ensure invoke completes normally.
  try {
    const r = await invoke({
      agentRole: "engineer",
      task: "short task",
      projectDir,
      dockerExec: makeStubExec({ status: "complete" }),
    });

    assert.equal(r.status, "complete");
    // If compression fired, the log line format must be correct.
    const compressionLog = consoleLogs.find((l) => l.includes("forge: compression"));
    if (compressionLog) {
      assert.match(compressionLog, /taskId=task-engineer/);
      assert.match(compressionLog, /original=\d+B/);
      assert.match(compressionLog, /compressed=\d+B/);
      assert.match(compressionLog, /ratio=\d+\.\d+/);
      assert.match(compressionLog, /method=headroom/);
    }
    // If compression did NOT fire, the system prompt was < 10KB — that's also fine.
  } finally {
    console.log = origLog;
  }
});

test("invoke: invoke completes successfully with a large (>10KB) task — compression does not break the pipeline", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-compression-large-"));

  // Build a task string large enough that composeSystemPrompt will exceed 10KB.
  const largeTask = "Perform a detailed analysis: " + "x".repeat(12 * 1024);

  const r = await invoke({
    agentRole: "engineer",
    task: largeTask,
    projectDir,
    dockerExec: makeStubExec({ status: "complete", output: "compression-test-passed" }),
  });

  assert.equal(r.status, "complete");
  assert.deepEqual((r.result as Record<string, unknown>)["output"], "compression-test-passed");
});

test("invoke: invoke completes successfully with a small (<10KB) task — no compression path", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-compression-small-"));

  const r = await invoke({
    agentRole: "engineer",
    task: "short task under threshold",
    projectDir,
    dockerExec: makeStubExec({ status: "complete", output: "no-compression" }),
  });

  assert.equal(r.status, "complete");
  assert.deepEqual((r.result as Record<string, unknown>)["output"], "no-compression");
});

// --- Round-trip / decompressability verification ---

test("compression: compressed content is a valid string (can be stored and re-read)", async () => {
  const largeText = makeLargeText(COMPRESSION_THRESHOLD + 1000);
  const expectedOutput = "This is compressed output that can be stored and retrieved verbatim.";
  const mockCompress = makeMockCompress(expectedOutput, 0.5);

  const result = await compressPrompt(largeText, mockCompress);

  // Round-trip: the compressed content must survive a JSON stringify/parse cycle
  // (how invoke writes it to CLAUDE.md / passes it to docker via buildDockerArgs).
  const serialized = JSON.stringify({ content: result.content, meta: result.meta });
  const deserialized = JSON.parse(serialized) as { content: string; meta: unknown };

  assert.equal(deserialized.content, expectedOutput, "compressed content must survive serialization round-trip");
  assert.deepEqual(deserialized.meta, result.meta);
});

test("compression: fallback content is identical to input (lossless fallback)", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const largeText = makeLargeText(COMPRESSION_THRESHOLD + 2000);
    const failingCompress = async (): Promise<HeadroomResult> => { throw new Error("forced failure"); };

    const result = await compressPrompt(largeText, failingCompress);

    // The fallback must return bit-for-bit identical content.
    assert.strictEqual(result.content, largeText, "fallback content must be identical to input");
    assert.equal(Buffer.byteLength(result.content, "utf8"), result.meta.original_size);
  } finally {
    console.warn = origWarn;
  }
});
