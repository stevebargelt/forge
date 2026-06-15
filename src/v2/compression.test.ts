import { test } from "node:test";
import assert from "node:assert/strict";
import { compressPrompt, COMPRESSION_THRESHOLD } from "./compression.js";
import type { CompressResult as HeadroomResult } from "headroom-ai";

function makeText(bytes: number): string {
  return "x".repeat(bytes);
}

function makeMockResult(overrides: Partial<HeadroomResult> = {}): HeadroomResult {
  return {
    messages: [{ role: "system", content: "compressed content" }],
    tokensBefore: 100,
    tokensAfter: 60,
    tokensSaved: 40,
    compressionRatio: 0.6,
    transformsApplied: ["truncate"],
    ccrHashes: [],
    compressed: true,
    ...overrides,
  };
}

test("compressPrompt: skips compression for text <= 10KB", async () => {
  const text = makeText(COMPRESSION_THRESHOLD);
  const result = await compressPrompt(text);
  assert.equal(result.content, text);
  assert.equal(result.meta.method, "none");
  assert.equal(result.meta.compression_ratio, 1.0);
  assert.equal(result.meta.original_size, COMPRESSION_THRESHOLD);
  assert.equal(result.meta.compressed_size, COMPRESSION_THRESHOLD);
});

test("compressPrompt: skips compression for empty string", async () => {
  const result = await compressPrompt("");
  assert.equal(result.content, "");
  assert.equal(result.meta.method, "none");
  assert.equal(result.meta.original_size, 0);
});

test("compressPrompt: compresses text > 10KB and returns metadata", async () => {
  const bigText = makeText(COMPRESSION_THRESHOLD + 1);
  const mockCompress = async () => makeMockResult({ compressionRatio: 0.7 });
  const result = await compressPrompt(bigText, mockCompress);
  assert.equal(result.content, "compressed content");
  assert.equal(result.meta.method, "headroom");
  assert.equal(result.meta.compression_ratio, 0.7);
  assert.equal(result.meta.original_size, COMPRESSION_THRESHOLD + 1);
  assert.ok(result.meta.compressed_size < result.meta.original_size);
});

test("compressPrompt: fallback on headroom error returns original + logs warning", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);

  try {
    const bigText = makeText(COMPRESSION_THRESHOLD + 1);
    const failingCompress = async (): Promise<HeadroomResult> => {
      throw new Error("mock headroom failure");
    };
    const result = await compressPrompt(bigText, failingCompress);
    assert.equal(result.content, bigText, "fallback must return original text");
    assert.equal(result.meta.method, "none", "fallback method must be 'none'");
    assert.equal(result.meta.compression_ratio, 1.0);
    assert.ok(warnings.some(w => w.includes("compression failed")), "must log a warning");
  } finally {
    console.warn = origWarn;
  }
});

test("compressPrompt: meta sizes are consistent on fallback", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const bigText = makeText(COMPRESSION_THRESHOLD + 500);
    const failingCompress = async (): Promise<HeadroomResult> => { throw new Error("forced"); };
    const { meta } = await compressPrompt(bigText, failingCompress);
    assert.equal(meta.original_size, meta.compressed_size);
    assert.equal(meta.compression_ratio, 1.0);
  } finally {
    console.warn = origWarn;
  }
});

test("compressPrompt: uses original text when compressed message lacks content field", async () => {
  const bigText = makeText(COMPRESSION_THRESHOLD + 1);
  const mockCompress = async () => makeMockResult({ messages: [{ role: "system" }] });
  const result = await compressPrompt(bigText, mockCompress);
  assert.equal(result.content, bigText, "must fall through to original when content field is absent");
});
