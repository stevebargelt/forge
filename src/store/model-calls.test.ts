import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUsageFromStdoutLog } from "./model-calls.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "forge-usage-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeLog(name: string, lines: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("extractUsageFromStdoutLog: returns [] for missing file", () => {
  assert.deepEqual(extractUsageFromStdoutLog(join(dir, "nope.log")), []);
});

test("extractUsageFromStdoutLog: returns [] for empty file", () => {
  const p = writeLog("empty.log", []);
  assert.deepEqual(extractUsageFromStdoutLog(p), []);
});

test("extractUsageFromStdoutLog: extracts one row per request_id from assistant events", () => {
  const path = writeLog("two-reqs.log", [
    {
      type: "assistant",
      message: { model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } },
      session_id: "s1",
      request_id: "req_A",
      timestamp: "2026-05-26T20:00:00Z",
    },
    {
      type: "assistant",
      message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 60, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } },
      session_id: "s1",
      request_id: "req_B",
      timestamp: "2026-05-26T20:00:05Z",
    },
  ]);
  const rows = extractUsageFromStdoutLog(path, { taskId: "task-1", alias: "spec-writer" });
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.requestId === "req_A")!;
  assert.equal(a.inputTokens, 10);
  assert.equal(a.outputTokens, 20);
  assert.equal(a.cacheReadTokens, 100);
  assert.equal(a.cacheCreationTokens, 50);
  assert.equal(a.taskId, "task-1");
  assert.equal(a.alias, "spec-writer");
  assert.equal(a.model, "claude-opus-4-7");
});

test("extractUsageFromStdoutLog: message_delta overrides earlier assistant numbers for same request", () => {
  // Stream-json reality: assistant event fires multiple times during a request,
  // and the final message_delta has the canonical totals from `iterations`.
  const path = writeLog("delta-overrides.log", [
    // First assistant event for req_A — partial counts.
    {
      type: "assistant",
      message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } },
      session_id: "s1",
      request_id: "req_A",
    },
    // Final message_delta with the full output_tokens count from iterations.
    {
      type: "stream_event",
      event: { type: "message_delta", delta: {}, usage: { input_tokens: 5, output_tokens: 250, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } },
      session_id: "s1",
    },
  ]);
  const rows = extractUsageFromStdoutLog(path, { taskId: "task-1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.outputTokens, 250, "message_delta's output_tokens should win");
});

test("extractUsageFromStdoutLog: takes the max across multiple assistant events for the same request", () => {
  // Without a delta event, we take per-field max — captures the latest
  // observed state from streaming partials.
  const path = writeLog("max.log", [
    {
      type: "assistant",
      message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } },
      session_id: "s1",
      request_id: "req_A",
    },
    {
      type: "assistant",
      message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 25, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } },
      session_id: "s1",
      request_id: "req_A",
    },
  ]);
  const rows = extractUsageFromStdoutLog(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.outputTokens, 25, "should take max across observations");
});

test("extractUsageFromStdoutLog: skips corrupt JSON lines without crashing", () => {
  const path = join(dir, "broken.log");
  writeFileSync(path, [
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: "s1", request_id: "req_OK" }),
    "{ not valid json },",
    "",
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
  ].join("\n"));
  const rows = extractUsageFromStdoutLog(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.requestId, "req_OK");
});

test("extractUsageFromStdoutLog: ignores events without request_id", () => {
  // system/init, stream_event without an active session, etc.
  const path = writeLog("no-reqs.log", [
    { type: "system", subtype: "init", session_id: "s1" },
    { type: "rate_limit_event", rate_limit_info: {}, session_id: "s1" },
    { type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: "s1" }, // no request_id
  ]);
  const rows = extractUsageFromStdoutLog(path);
  assert.equal(rows.length, 0);
});

test("extractUsageFromStdoutLog: message_delta without a preceding assistant event is dropped", () => {
  // Defensive: a malformed stream that has a delta but no assistant context
  // to attribute it to. We have no request_id, so we drop it rather than
  // attributing to the wrong place.
  const path = writeLog("orphan-delta.log", [
    { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: "s1" },
  ]);
  const rows = extractUsageFromStdoutLog(path);
  assert.equal(rows.length, 0);
});

test("extractUsageFromStdoutLog: two sessions in one log don't cross-contaminate", () => {
  // Reproduces the contamination bug if the session→active-request map were
  // module-scope. Different sessions, different active requests at the time
  // of each message_delta — each delta must hit its own request.
  const path = writeLog("two-sessions.log", [
    { type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: "s1", request_id: "req_S1A" },
    { type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: "s2", request_id: "req_S2A" },
    // delta for s1 — should attribute to req_S1A
    { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: "s1" },
    // delta for s2 — should attribute to req_S2A
    { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: "s2" },
  ]);
  const rows = extractUsageFromStdoutLog(path);
  assert.equal(rows.length, 2);
  const s1Row = rows.find((r) => r.requestId === "req_S1A");
  const s2Row = rows.find((r) => r.requestId === "req_S2A");
  assert.equal(s1Row?.outputTokens, 100, "s1 should get its delta");
  assert.equal(s2Row?.outputTokens, 200, "s2 should get its delta");
});

test("extractUsageFromStdoutLog: missing usage fields default to 0 (not NaN)", () => {
  const path = writeLog("partial-usage.log", [
    { type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 5 } }, session_id: "s1", request_id: "req_A" },
  ]);
  const rows = extractUsageFromStdoutLog(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.inputTokens, 5);
  assert.equal(rows[0]?.outputTokens, 0);
  assert.equal(rows[0]?.cacheReadTokens, 0);
  assert.equal(rows[0]?.cacheCreationTokens, 0);
});

test("extractUsageFromStdoutLog: rejects negative or non-numeric token counts (defaults to 0)", () => {
  const path = writeLog("garbage-usage.log", [
    { type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: -5, output_tokens: "lots", cache_read_input_tokens: null, cache_creation_input_tokens: 100 } }, session_id: "s1", request_id: "req_A" },
  ]);
  const rows = extractUsageFromStdoutLog(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.inputTokens, 0);
  assert.equal(rows[0]?.outputTokens, 0);
  assert.equal(rows[0]?.cacheReadTokens, 0);
  assert.equal(rows[0]?.cacheCreationTokens, 100, "valid fields still extracted");
});
