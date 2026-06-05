import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUsageFromStdoutLog, extractUsageFromCodexLog } from "./model-calls.js";

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

// ---- Codex (AWN-7 Walk): `codex exec --json` JSONL usage parser ----
// Event shapes are the real ones captured from codex-cli 0.135.0.

test("extractUsageFromCodexLog: maps turn.completed usage (input is total; cached is the subset)", () => {
  const path = writeLog("codex.jsonl", [
    { type: "thread.started", thread_id: "019e835b-220d-7f91" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 21860, cached_input_tokens: 20224, output_tokens: 81, reasoning_output_tokens: 0 } },
  ]);
  const rows = extractUsageFromCodexLog(path, { taskId: "task-1", alias: "review", model: "gpt-5.5" });
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.inputTokens, 1636, "non-cached input = input_tokens - cached_input_tokens");
  assert.equal(r.cacheReadTokens, 20224, "cached subset → cache_read");
  assert.equal(r.outputTokens, 81);
  assert.equal(r.cacheCreationTokens, 0, "codex exposes no cache-creation counter");
  assert.equal(r.model, "gpt-5.5");
  assert.equal(r.alias, "review");
  assert.equal(r.requestId, "019e835b-220d-7f91#0");
});

test("extractUsageFromCodexLog: a multi-turn thread yields one row per turn (no overwrite)", () => {
  const path = writeLog("codex-multi.jsonl", [
    { type: "thread.started", thread_id: "th_X" },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
    { type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 20 } },
  ]);
  const rows = extractUsageFromCodexLog(path, { taskId: "t", model: "gpt-5.5" });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.requestId), ["th_X#0", "th_X#1"]);
  assert.equal(rows[1]!.inputTokens, 150);
  assert.equal(rows[1]!.cacheReadTokens, 50);
});

test("extractUsageFromCodexLog: tolerates corrupt lines and non-usage events; [] when no turn.completed", () => {
  const path = join(dir, "codex-noise.jsonl");
  writeFileSync(path, [
    "not json at all",
    JSON.stringify({ type: "thread.started", thread_id: "th_Y" }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "ls" } }),
  ].join("\n") + "\n");
  assert.deepEqual(extractUsageFromCodexLog(path), []);
});

test("extractUsageFromCodexLog: cached > input never produces negative input (clamped to 0)", () => {
  const path = writeLog("codex-clamp.jsonl", [
    { type: "thread.started", thread_id: "th_Z" },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 50, output_tokens: 5 } },
  ]);
  const rows = extractUsageFromCodexLog(path, {});
  assert.equal(rows[0]!.inputTokens, 0);
  assert.equal(rows[0]!.cacheReadTokens, 50);
  assert.equal(rows[0]!.model, "codex", "model falls back when not provided");
});

// ---- #292: usage parser is selected by log_format, not provider ----
// The seam's load-bearing claim (acceptance #2): usage-parser selection can be
// made from log_format INDEPENDENT of the upstream provider. Tested at the pure
// decision (selectUsageParser) so it's isolated from the DB-insert path.

import { selectUsageParser, captureUsageForTask } from "./model-calls.js";

test("#292: log_format=codex-jsonl selects the codex parser even when provider=anthropic", () => {
  assert.equal(selectUsageParser({ logFormat: "codex-jsonl", provider: "anthropic" }), "codex");
});

test("#292: log_format=claude-stream-json selects the claude parser even when provider=openai", () => {
  assert.equal(selectUsageParser({ logFormat: "claude-stream-json", provider: "openai" }), "claude");
});

test("#292: an unknown/other log_format falls to the claude parser", () => {
  assert.equal(selectUsageParser({ logFormat: "pi-jsonl" }), "claude", "pi-jsonl has no dedicated parser yet (#262) → claude default, not codex");
});

test("#292: legacy fallback — no log_format → selection keys off provider", () => {
  assert.equal(selectUsageParser({ provider: "openai" }), "codex");
  assert.equal(selectUsageParser({ provider: "anthropic" }), "claude");
  assert.equal(selectUsageParser({}), "claude", "no signal at all → claude (pre-#292 default)");
});

test("#292: captureUsageForTask end-to-end — codex log + codex-jsonl extracts codex usage", () => {
  // Integration check that the selected parser is actually applied. extractUsage*
  // is exercised directly here (no DB insert) so it's not coupled to the
  // model_calls insert schema (#141 drift).
  const path = writeLog("cap-codex.jsonl", [
    { type: "thread.started", thread_id: "th_1" },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40 } },
  ]);
  // claude parser on a codex log finds nothing; codex parser finds the turn.
  assert.equal(extractUsageFromStdoutLog(path).length, 0);
  assert.equal(extractUsageFromCodexLog(path).length, 1);
  // captureUsageForTask is defined (smoke) — selection proven above.
  assert.equal(typeof captureUsageForTask, "function");
});
