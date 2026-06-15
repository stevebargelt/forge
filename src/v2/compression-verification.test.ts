import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasAgentCompressionMetadata,
  findLargeStringFields,
  maybeOrchestratorCompress,
  RESULT_COMPRESSION_THRESHOLD,
} from "./compression-verification.js";
import { COMPRESSION_THRESHOLD } from "./compression.js";
import type { CompressResult as HeadroomResult } from "headroom-ai";

function makeMockCompress(output: string, ratio = 0.5): (messages: { role: string; content: string }[]) => Promise<HeadroomResult> {
  return async () => ({
    messages: [{ role: "system", content: output }],
    tokensBefore: 1000,
    tokensAfter: Math.round(1000 * ratio),
    tokensSaved: Math.round(1000 * (1 - ratio)),
    compressionRatio: ratio,
    transformsApplied: ["truncate"],
    ccrHashes: [],
    compressed: true,
  });
}

function tmpResultPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cv-test-"));
  return join(dir, "result.json");
}

// --- hasAgentCompressionMetadata ---

test("hasAgentCompressionMetadata: returns true when *_compressed object field present", () => {
  const result = {
    status: "complete",
    stdout_compressed: { compressed_id: "abc", original_size: 5000, compressed_size: 600, compression_ratio: 0.88 },
  };
  assert.equal(hasAgentCompressionMetadata(result), true);
});

test("hasAgentCompressionMetadata: returns true for findings_compressed", () => {
  assert.equal(
    hasAgentCompressionMetadata({ findings_compressed: { compressed_id: "x", original_size: 1000, compressed_size: 100, compression_ratio: 0.9 } }),
    true,
  );
});

test("hasAgentCompressionMetadata: returns false when no *_compressed field", () => {
  assert.equal(hasAgentCompressionMetadata({ status: "complete", output: "hello" }), false);
});

test("hasAgentCompressionMetadata: ignores *_compressed fields that are not objects", () => {
  assert.equal(hasAgentCompressionMetadata({ stdout_compressed: "some string" }), false);
  assert.equal(hasAgentCompressionMetadata({ stdout_compressed: null }), false);
  assert.equal(hasAgentCompressionMetadata({ stdout_compressed: 42 }), false);
  assert.equal(hasAgentCompressionMetadata({ stdout_compressed: ["a"] }), false);
});

// --- findLargeStringFields ---

test("findLargeStringFields: finds string fields above threshold", () => {
  const big = "x".repeat(COMPRESSION_THRESHOLD + 1);
  const result = { status: "complete", notes: big };
  const fields = findLargeStringFields(result);
  assert.deepEqual(fields, ["notes"]);
});

test("findLargeStringFields: ignores strings at or below threshold", () => {
  const small = "x".repeat(COMPRESSION_THRESHOLD);
  const result = { status: "complete", notes: small };
  const fields = findLargeStringFields(result);
  assert.deepEqual(fields, []);
});

test("findLargeStringFields: ignores non-string fields regardless of size", () => {
  const result = { findings: ["a".repeat(50000)], count: 99 };
  const fields = findLargeStringFields(result);
  assert.deepEqual(fields, []);
});

test("findLargeStringFields: returns multiple large fields", () => {
  const big = "x".repeat(COMPRESSION_THRESHOLD + 1);
  const result = { a: big, b: big, c: "small" };
  const fields = findLargeStringFields(result);
  assert.ok(fields.includes("a"));
  assert.ok(fields.includes("b"));
  assert.equal(fields.length, 2);
});

// --- maybeOrchestratorCompress ---

test("maybeOrchestratorCompress: no-op when result is below 20KB threshold", async () => {
  const small = { status: "complete", output: "ok" };
  const path = tmpResultPath();
  const { result, verification } = await maybeOrchestratorCompress({
    result: small,
    resultRawSize: 100,
    resultPath: path,
    taskId: "task-test-123",
  });
  assert.deepEqual(result, small);
  assert.equal(verification, null);
});

test("maybeOrchestratorCompress: no-op when result is null", async () => {
  const path = tmpResultPath();
  const { result, verification } = await maybeOrchestratorCompress({
    result: null,
    resultRawSize: RESULT_COMPRESSION_THRESHOLD + 1,
    resultPath: path,
    taskId: "task-test-123",
  });
  assert.equal(result, null);
  assert.equal(verification, null);
});

test("maybeOrchestratorCompress: no-op when result is an array", async () => {
  const path = tmpResultPath();
  const { result, verification } = await maybeOrchestratorCompress({
    result: [1, 2, 3],
    resultRawSize: RESULT_COMPRESSION_THRESHOLD + 1,
    resultPath: path,
    taskId: "task-test-123",
  });
  assert.deepEqual(result, [1, 2, 3]);
  assert.equal(verification, null);
});

test("maybeOrchestratorCompress: detects agent compression, sets verification accordingly", async () => {
  const path = tmpResultPath();
  const bigResult = {
    status: "complete",
    stdout_compressed: { compressed_id: "x", original_size: 50000, compressed_size: 5000, compression_ratio: 0.9 },
  };
  const { result, verification } = await maybeOrchestratorCompress({
    result: bigResult,
    resultRawSize: RESULT_COMPRESSION_THRESHOLD + 1,
    resultPath: path,
    taskId: "task-test-123",
  });
  assert.deepEqual(result, bigResult);
  assert.ok(verification !== null);
  assert.equal(verification!.agent_compressed, true);
  assert.equal(verification!.orchestrator_compressed, false);
  assert.deepEqual(verification!.fields_compressed, []);
});

test("maybeOrchestratorCompress: compresses large field and rewrites result.json", async () => {
  const path = tmpResultPath();
  const largeNotes = "A".repeat(COMPRESSION_THRESHOLD + 1);
  const bigResult = { status: "complete", notes: largeNotes };
  const rawSize = Buffer.byteLength(JSON.stringify(bigResult), "utf8");
  const mockCompress = makeMockCompress("compressed-notes", 0.4);

  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: string) => errors.push(msg);
  try {
    const { result, verification } = await maybeOrchestratorCompress({
      result: bigResult,
      resultRawSize: rawSize > RESULT_COMPRESSION_THRESHOLD ? rawSize : RESULT_COMPRESSION_THRESHOLD + 1,
      resultPath: path,
      taskId: "task-test-abc",
      _compress: mockCompress,
    });

    assert.ok(verification !== null);
    assert.equal(verification!.agent_compressed, false);
    assert.equal(verification!.orchestrator_compressed, true);
    assert.deepEqual(verification!.fields_compressed, ["notes"]);

    const r = result as Record<string, unknown>;
    assert.equal(r["notes"], "compressed-notes");
    assert.ok(r["compressionVerification"] !== undefined);

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(onDisk["notes"], "compressed-notes");
    assert.ok(errors.some((e) => e.includes("did not compress") && e.includes("task-test-abc")));
  } finally {
    console.error = origError;
  }
});

test("maybeOrchestratorCompress: no fields compressed when no string fields are large", async () => {
  const path = tmpResultPath();
  const bigResult = {
    status: "complete",
    count: 9999,
    notes: "small",
    findings: Array.from({ length: 200 }, (_, i) => ({ file: `src/foo${i}.ts`, line: i })),
  };
  const rawJson = JSON.stringify(bigResult);

  const { result, verification } = await maybeOrchestratorCompress({
    result: bigResult,
    resultRawSize: rawJson.length > RESULT_COMPRESSION_THRESHOLD ? rawJson.length : RESULT_COMPRESSION_THRESHOLD + 1,
    resultPath: path,
    taskId: "task-test-nofields",
  });

  if (verification !== null) {
    assert.equal(verification.orchestrator_compressed, false);
    assert.deepEqual(verification.fields_compressed, []);
  }
  // result unchanged
  assert.deepEqual(result, bigResult);
});
