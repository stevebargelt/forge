import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractUsageFromStdoutLog, extractUsageFromCodexLog, extractUsageFromPiLog } from "./model-calls.js";

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

test("#262: pi-jsonl selects the pi parser (independent of provider)", () => {
  assert.equal(selectUsageParser({ logFormat: "pi-jsonl" }), "pi");
  // log_format is authoritative — pi may run any upstream provider.
  assert.equal(selectUsageParser({ logFormat: "pi-jsonl", provider: "anthropic" }), "pi");
  assert.equal(selectUsageParser({ logFormat: "pi-jsonl", provider: "openai" }), "pi");
});

test("#292: any unmapped explicit log_format is unsupported (forces a parser decision)", () => {
  assert.equal(selectUsageParser({ logFormat: "some-future-format" }), "unsupported");
});

test("#292: captureUsageForTask reports an unsupported log_format as an error, does not parse", () => {
  const path = writeLog("unsup.jsonl", [{ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 5 } }]);
  const r = captureUsageForTask(path, { taskId: "t-unsup", logFormat: "made-up-format" });
  assert.equal(r.rowCount, 0);
  assert.match(r.error ?? "", /no parser for log_format='made-up-format'/);
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

// ---- #262: pi (`pi --mode json`) usage parser ----
// Shapes are the real ones — the live-captured fixture below was produced by pi
// 0.74.2 against a streaming mock (see scripts/ + the #263 harness).

const PI_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "pi-usage-stream.jsonl");

test("#262: extractUsageFromPiLog parses the LIVE captured stream (real pi event shape)", () => {
  const rows = extractUsageFromPiLog(PI_FIXTURE, { taskId: "t-pi", alias: "default" });
  assert.equal(rows.length, 1, "one assistant turn → one row");
  const r = rows[0]!;
  assert.equal(r.taskId, "t-pi");
  assert.equal(r.alias, "default");
  assert.equal(r.model, "mock-model");
  assert.equal(r.requestId, "msg_1", "uses the message responseId");
  assert.equal(r.inputTokens, 1234);
  assert.equal(r.outputTokens, 56);
  assert.equal(r.cacheReadTokens, 100);
  assert.equal(r.cacheCreationTokens, 20);
});

test("#262: input is FRESH (no subtraction) — pi reports cache separately", () => {
  // Regression guard for the codex-vs-pi difference: codex's input_tokens is the
  // TOTAL (cache subtracted); pi's `input` already excludes cache.
  const path = writeLog("pi-fresh.jsonl", [
    { type: "session", id: "sess-1" },
    { type: "agent_end", messages: [
      { role: "user", content: [] },
      { role: "assistant", model: "claude-sonnet-4-6", responseId: "r1", timestamp: 1780706571454,
        usage: { input: 1000, output: 50, cacheRead: 900, cacheWrite: 10, totalTokens: 1960 } },
    ] },
  ]);
  const r = extractUsageFromPiLog(path)[0]!;
  assert.equal(r.inputTokens, 1000, "input mapped directly, NOT input-minus-cache");
  assert.equal(r.cacheReadTokens, 900);
});

test("#262: one row per assistant turn across a multi-turn agent_end", () => {
  const path = writeLog("pi-multi.jsonl", [
    { type: "session", id: "sess-m" },
    { type: "agent_end", messages: [
      { role: "user", content: [] },
      { role: "assistant", model: "m", responseId: "a", usage: { input: 10, output: 1 } },
      { role: "user", content: [] },
      { role: "assistant", model: "m", responseId: "b", usage: { input: 20, output: 2 } },
    ] },
  ]);
  const rows = extractUsageFromPiLog(path);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.requestId), ["a", "b"]);
  assert.deepEqual(rows.map((r) => r.inputTokens), [10, 20]);
});

test("#262: falls back to turn_end when the run was cut off before agent_end", () => {
  const path = writeLog("pi-crash.jsonl", [
    { type: "session", id: "sess-c" },
    { type: "turn_end", message: { role: "assistant", model: "m", responseId: "t1", usage: { input: 7, output: 3 } } },
    // no agent_end — crashed mid-run
  ]);
  const rows = extractUsageFromPiLog(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.inputTokens, 7);
  assert.equal(rows[0]!.requestId, "t1");
});

test("#262: agent_end (authoritative) does not double-count the turn_end events", () => {
  const path = writeLog("pi-nodupe.jsonl", [
    { type: "session", id: "s" },
    { type: "turn_end", message: { role: "assistant", responseId: "x", usage: { input: 5, output: 1 } } },
    { type: "agent_end", messages: [{ role: "assistant", responseId: "x", usage: { input: 5, output: 1 } }] },
  ]);
  assert.equal(extractUsageFromPiLog(path).length, 1, "agent_end is authoritative; turn_end not added on top");
});

test("#262: synthesizes a requestId from session id when responseId is absent", () => {
  const path = writeLog("pi-noid.jsonl", [
    { type: "session", id: "sess-x" },
    { type: "agent_end", messages: [{ role: "assistant", usage: { input: 1, output: 1 } }] },
  ]);
  assert.equal(extractUsageFromPiLog(path)[0]!.requestId, "sess-x#0");
});

test("#262: tolerates missing file / empty / corrupt lines", () => {
  assert.deepEqual(extractUsageFromPiLog(join(dir, "nope.jsonl")), []);
  assert.deepEqual(extractUsageFromPiLog(writeLog("pi-empty.jsonl", [])), []);
  const p = join(dir, "pi-corrupt.jsonl");
  writeFileSync(p, ["not json", JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", usage: { input: 9, output: 0 } }] }), "}{"].join("\n"));
  assert.equal(extractUsageFromPiLog(p)[0]!.inputTokens, 9);
});

// #262 acceptance: a usage row is actually RECORDED for a pi task (end-to-end
// through captureUsageForTask → insertUsageRows), keyed off log_format pi-jsonl.
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";

test("#262: captureUsageForTask records a pi usage row from log_format pi-jsonl", () => {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    insertRun({ id: "run-pi", workflow: "invoke", title: "pi", status: "active", createdAt: "2026-06-06T00:00:00Z" });
    insertTask({
      id: "t-pi-usage", runId: "run-pi", phase: "engineer", agentRole: "engineer", status: "running",
      taskPackage: { taskId: "t-pi-usage", runId: "run-pi", phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
      createdAt: "2026-06-06T00:00:00Z",
    });
    // provider is anthropic here, but the pi parser is chosen by log_format — proving
    // the architectural correction (#262): upstream provider does not select it.
    const r = captureUsageForTask(PI_FIXTURE, { taskId: "t-pi-usage", logFormat: "pi-jsonl", provider: "anthropic" });
    assert.equal(r.rowCount, 1, r.error ? `error: ${r.error}` : "expected one pi usage row");
    const row = db.prepare("SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM model_calls WHERE task_id = ?").get("t-pi-usage") as Record<string, unknown>;
    assert.equal(row.model, "mock-model");
    assert.equal(row.input_tokens, 1234);
    assert.equal(row.output_tokens, 56);
    assert.equal(row.cache_read_tokens, 100);
    assert.equal(row.cache_creation_tokens, 20);
  } finally {
    if (prev) setDbForTest(prev);
  }
});
