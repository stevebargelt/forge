import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCodexFailure, analyzeClaudeFailure, analyzeProviderFailure, detectEndedTurnWhileWaiting } from "./provider-failure.js";
import { monitorThenEndTurnStream, sInit, sResult, sStop, sText, sToolResult, sToolUse } from "./fg787-stream.testkit.js";

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

// ── FG-787: detectEndedTurnWhileWaiting ──

test("FG-787 detectEndedTurnWhileWaiting: Monitor armed, ack only, end_turn → fires naming Monitor", () => {
  assert.deepEqual(detectEndedTurnWhileWaiting(monitorThenEndTurnStream()), { tool: "Monitor", toolUseId: "toolu_mon" });
});

test("FG-787 detectEndedTurnWhileWaiting: last tool_use is Bash run_in_background → fires", () => {
  const s = [sInit(), sToolUse("toolu_bg", "Bash", { command: "npm test", run_in_background: true }), sToolResult("toolu_bg", "started"), sText("waiting"), sStop("end_turn"), sResult()].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s)?.tool, "Bash run_in_background");
});

test("FG-787 detectEndedTurnWhileWaiting: ScheduleWakeup with no tool_result at all → fires", () => {
  const s = [sInit(), sToolUse("toolu_w", "ScheduleWakeup", { delaySeconds: 600 }), sResult()].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s)?.tool, "ScheduleWakeup");
});

test("FG-787 detectEndedTurnWhileWaiting: last tool_use is a synchronous Bash → does not fire", () => {
  const s = [sInit(), sToolUse("toolu_b", "Bash", { command: "npm test" }), sToolResult("toolu_b", "ok"), sText("done"), sStop("end_turn"), sResult()].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 detectEndedTurnWhileWaiting: Bash with run_in_background false → does not fire", () => {
  const s = [sInit(), sToolUse("toolu_b", "Bash", { command: "npm test", run_in_background: false }), sToolResult("toolu_b", "ok"), sResult()].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 detectEndedTurnWhileWaiting: a later tool_result after the ack (the wait delivered) → does not fire", () => {
  const s = [
    sInit(),
    sToolUse("toolu_mon", "Monitor", { file: "/tmp/x" }),
    sToolResult("toolu_mon", "Monitor armed."),
    sToolResult("toolu_other", "suite finished: 12 passed"),
    sText("done"), sStop("end_turn"), sResult(),
  ].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 detectEndedTurnWhileWaiting: a second tool_result reusing the wait's id → does not fire", () => {
  const s = [
    sInit(),
    sToolUse("toolu_mon", "Monitor", { file: "/tmp/x" }),
    sToolResult("toolu_mon", "Monitor armed."),
    sToolResult("toolu_mon", "suite finished: 12 passed"),
    sText("done"), sStop("end_turn"), sResult(),
  ].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 detectEndedTurnWhileWaiting: two same-id tool_results in one user event → does not fire", () => {
  const twoBlocks = JSON.stringify({
    type: "user",
    message: { role: "user", content: [
      { tool_use_id: "toolu_mon", type: "tool_result", content: "Monitor armed." },
      { tool_use_id: "toolu_mon", type: "tool_result", content: "suite finished" },
    ] },
    parent_tool_use_id: null,
  });
  const s = [sInit(), sToolUse("toolu_mon", "Monitor", {}), twoBlocks, sStop("end_turn"), sResult()].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 detectEndedTurnWhileWaiting: exactly one ack then end_turn → still fires", () => {
  const s = [sInit(), sToolUse("toolu_mon", "Monitor", {}), sToolResult("toolu_mon", "Monitor armed."), sText("waiting"), sStop("end_turn"), sResult()].join("\n");
  assert.deepEqual(detectEndedTurnWhileWaiting(s), { tool: "Monitor", toolUseId: "toolu_mon" });
});

test("FG-787 detectEndedTurnWhileWaiting: a later tool_use after the Monitor → does not fire", () => {
  const s = [
    sInit(),
    sToolUse("toolu_mon", "Monitor", { file: "/tmp/x" }), sToolResult("toolu_mon", "armed"),
    sToolUse("toolu_r", "Read", { file_path: "/tmp/x" }), sToolResult("toolu_r", "12 passed"),
    sResult(),
  ].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 detectEndedTurnWhileWaiting: final stop_reason is not end_turn → does not fire", () => {
  const s = [sInit(), sToolUse("toolu_mon", "Monitor", {}), sToolResult("toolu_mon", "armed"), sStop("max_tokens"), sResult("max_tokens")].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 detectEndedTurnWhileWaiting: a SUB-AGENT's Monitor is ignored", () => {
  const s = [
    sInit(),
    sToolUse("toolu_b", "Bash", { command: "ls" }), sToolResult("toolu_b", "ok"),
    sToolUse("toolu_sub", "Monitor", {}, "toolu_task"),
    sText("done"), sStop("end_turn"), sResult(),
  ].join("\n");
  assert.equal(detectEndedTurnWhileWaiting(s), undefined);
});

test("FG-787 analyzeProviderFailure: claude-stream-json surfaces endedTurnWhileWaiting; codex never does", () => {
  const a = analyzeProviderFailure({ logFormat: "claude-stream-json", stdoutRaw: monitorThenEndTurnStream() });
  assert.equal(a.modelError, false);
  assert.equal(a.endedTurnWhileWaiting?.tool, "Monitor");
  assert.equal(analyzeProviderFailure({ logFormat: "codex-jsonl", stdoutRaw: monitorThenEndTurnStream() }).endedTurnWhileWaiting, undefined);
});
