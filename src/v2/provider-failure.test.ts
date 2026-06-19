import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCodexFailure, analyzeClaudeFailure, analyzeProviderFailure } from "./provider-failure.js";

// The exact shape from FG-228: a codex invalid-model run exits 1 emitting a
// top-level error then turn.failed, both carrying the cause.
const CODEX_INVALID_MODEL = [
  `{"type":"error","message":"status 400 The 'gpt-9' model is not supported when using Codex with a ChatGPT account."}`,
  `{"type":"turn.failed","error":{"message":"turn aborted: model not supported"}}`,
].join("\n");

test("analyzeCodexFailure: surfaces the provider cause as a model error", () => {
  const a = analyzeCodexFailure(CODEX_INVALID_MODEL);
  assert.equal(a.modelError, true);
  assert.match(a.error ?? "", /codex run failed:/);
  assert.match(a.error ?? "", /turn aborted: model not supported/); // last signal wins
});

test("analyzeCodexFailure: a top-level error with no turn.failed still attributes", () => {
  const a = analyzeCodexFailure(`{"type":"error","message":"rate limit exceeded"}`);
  assert.equal(a.modelError, true);
  assert.match(a.error ?? "", /rate limit exceeded/);
});

test("analyzeCodexFailure: no error signal → not a model error (fallback)", () => {
  const a = analyzeCodexFailure(`{"type":"item.completed"}\n{"type":"turn.completed"}`);
  assert.equal(a.modelError, false);
  assert.equal(a.error, undefined);
});

test("analyzeClaudeFailure: an error event attributes the cause", () => {
  const a = analyzeClaudeFailure(`{"type":"error","message":"overloaded_error: server busy"}`);
  assert.equal(a.modelError, true);
  assert.match(a.error ?? "", /claude run failed: overloaded_error/);
});

test("analyzeClaudeFailure: a terminal is_error result attributes the cause", () => {
  const a = analyzeClaudeFailure(`{"type":"result","is_error":true,"result":"credit balance too low"}`);
  assert.equal(a.modelError, true);
  assert.match(a.error ?? "", /credit balance too low/);
});

test("analyzeClaudeFailure: a normal stream is not a model error", () => {
  const a = analyzeClaudeFailure(`{"type":"assistant","message":{}}\n{"type":"result","is_error":false}`);
  assert.equal(a.modelError, false);
});

test("analyzeProviderFailure: dispatches by log_format", () => {
  assert.equal(analyzeProviderFailure({ logFormat: "codex-jsonl", stdoutRaw: CODEX_INVALID_MODEL }).modelError, true);
  assert.equal(analyzeProviderFailure({ logFormat: "claude-stream-json", stdoutRaw: `{"type":"error","message":"x"}` }).modelError, true);
});

test("analyzeProviderFailure: falls back to runtime_kind when no log_format", () => {
  assert.equal(analyzeProviderFailure({ runtimeKind: "codex", stdoutRaw: CODEX_INVALID_MODEL }).modelError, true);
});

test("analyzeProviderFailure: pi delegates to the pi analyzer", () => {
  const piErr = `{"type":"agent_end","messages":[{"role":"assistant","errorMessage":"401 invalid api key"}]}`;
  const a = analyzeProviderFailure({ logFormat: "pi-jsonl", stdoutRaw: piErr });
  assert.equal(a.modelError, true);
  assert.match(a.error ?? "", /pi run failed: 401 invalid api key/);
});

test("analyzeProviderFailure: unknown format → no attribution", () => {
  assert.deepEqual(analyzeProviderFailure({ logFormat: "mystery", stdoutRaw: "boom" }), { modelError: false });
});
