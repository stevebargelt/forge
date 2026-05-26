// #155: persistence + parsing for the model_calls table.
//
// claude-code in --output-format=stream-json mode emits one JSON object per
// line on stdout. Many event types appear (system/init, stream_event,
// assistant, message_delta, user, etc.); usage data appears in several of them
// keyed by request_id. We dedupe per request_id and take the canonical final
// usage from the message_delta event (it has the iterations array with the
// full input/output/cache breakdown).
//
// The schema-vs-stream mapping is intentional:
//   stream.usage.input_tokens             → model_calls.input_tokens
//   stream.usage.output_tokens            → model_calls.output_tokens
//   stream.usage.cache_read_input_tokens  → model_calls.cache_read_tokens
//   stream.usage.cache_creation_input_tokens → model_calls.cache_creation_tokens
//
// Cache hit/reuse semantics (used downstream by `forge usage`):
//   cache hit rate     = cache_read / (cache_read + cache_creation + input)
//   cache reuse ratio  = cache_read / cache_creation
//
// The model field in stream events is unqualified (e.g. "claude-opus-4-7"); we
// store it verbatim. Bedrock model IDs include a provider prefix
// ("us.anthropic.claude-opus-4-7") in the runtime YAML but the stream events
// from claude-code still emit the short form. Normalize-once happens at query
// time in the rollup CLI.

import { readFileSync } from "node:fs";
import { getDb } from "./db.js";

export type UsageRow = {
  taskId: string | null;
  requestId: string;
  model: string;
  alias: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  createdAt: string; // ISO; sourced from message event timestamp when present
};

// Extract one row per unique request_id from a stream-json log file. Tolerant
// of partial / corrupt lines; skips anything that doesn't parse. The final
// message_delta event for a request carries the canonical usage with
// `iterations`; if we see only earlier message_start events we still keep the
// best-effort numbers (a crash mid-stream leaves a partial log).
export function extractUsageFromStdoutLog(
  logPath: string,
  opts?: { taskId?: string; alias?: string },
): UsageRow[] {
  let raw: string;
  try { raw = readFileSync(logPath, "utf8"); }
  catch { return []; }

  // Per-request accumulator. Keyed by request_id; we keep the FINAL observed
  // usage (last writer wins, biased toward message_delta's iterations).
  const byRequest = new Map<string, UsageRow>();
  // session_id → currently-active request_id. Used to attribute message_delta
  // events (which only carry session_id, not request_id) back to the right
  // request. Function-scope so different log files don't contaminate each other.
  const sessionToActiveRequest = new Map<string, string>();
  let lastSeenModel: string | undefined;
  let lastSeenTimestamp: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (!isObject(event)) continue;

    if (typeof event["timestamp"] === "string") lastSeenTimestamp = event["timestamp"];

    // assistant message events: { type:"assistant", message:{ model, usage, ... }, request_id, session_id }
    // Always update session→request mapping (used to attribute later
    // message_delta events to the right request) BEFORE any continue.
    if (event["type"] === "assistant" && isObject(event["message"])) {
      const msg = event["message"];
      const reqId = typeof event["request_id"] === "string" ? event["request_id"] : undefined;
      const sessionId = typeof event["session_id"] === "string" ? event["session_id"] : undefined;
      if (reqId && sessionId) sessionToActiveRequest.set(sessionId, reqId);
      const model = typeof msg["model"] === "string" ? msg["model"] : lastSeenModel;
      if (model) lastSeenModel = model;
      const usage = isObject(msg["usage"]) ? msg["usage"] : undefined;
      if (reqId && model && usage) {
        mergeUsage(byRequest, reqId, model, usage, lastSeenTimestamp, opts);
      }
      continue;
    }

    // message_delta event (the canonical final usage for a request, with
    // iterations). Shape: { type:"stream_event", event:{ type:"message_delta",
    // delta:{...}, usage:{...} }, session_id, ... }
    // request_id isn't on the outer event here — we have to thread it via
    // sessionToActiveRequest populated above by the preceding assistant event.
    if (event["type"] === "stream_event" && isObject(event["event"])) {
      const inner = event["event"];
      if (inner["type"] !== "message_delta") continue;
      const usage = isObject(inner["usage"]) ? inner["usage"] : undefined;
      if (!usage) continue;
      const sessionId = typeof event["session_id"] === "string" ? event["session_id"] : undefined;
      const reqId = sessionId ? sessionToActiveRequest.get(sessionId) : undefined;
      if (!reqId) continue;
      const model = lastSeenModel;
      if (!model) continue;
      mergeUsage(byRequest, reqId, model, usage, lastSeenTimestamp, opts, /* preferThis = */ true);
    }
  }

  return Array.from(byRequest.values());
}

function mergeUsage(
  byRequest: Map<string, UsageRow>,
  reqId: string,
  model: string,
  usage: Record<string, unknown>,
  timestamp: string | undefined,
  opts: { taskId?: string; alias?: string } | undefined,
  preferThis = false,
): void {
  const candidate: UsageRow = {
    taskId: opts?.taskId ?? null,
    requestId: reqId,
    model,
    alias: opts?.alias ?? null,
    inputTokens: numField(usage, "input_tokens"),
    outputTokens: numField(usage, "output_tokens"),
    cacheReadTokens: numField(usage, "cache_read_input_tokens"),
    cacheCreationTokens: numField(usage, "cache_creation_input_tokens"),
    createdAt: timestamp ?? new Date().toISOString(),
  };
  const existing = byRequest.get(reqId);
  if (!existing) { byRequest.set(reqId, candidate); return; }
  // preferThis=true (message_delta) overrides the early message_start values
  // wholesale because the delta has the iteration-final counts. Otherwise we
  // take the max across observations — early events show 0 for output_tokens
  // while the stream is still building up.
  if (preferThis) { byRequest.set(reqId, candidate); return; }
  existing.inputTokens         = Math.max(existing.inputTokens,         candidate.inputTokens);
  existing.outputTokens        = Math.max(existing.outputTokens,        candidate.outputTokens);
  existing.cacheReadTokens     = Math.max(existing.cacheReadTokens,     candidate.cacheReadTokens);
  existing.cacheCreationTokens = Math.max(existing.cacheCreationTokens, candidate.cacheCreationTokens);
}

function numField(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Capture usage from a just-completed task's stdout log into model_calls.
// Best-effort: swallows all errors so a telemetry failure can never block or
// alter task semantics. Call site is right after docker exec returns, in both
// invoke.ts and runNext.ts spawn paths.
export function captureUsageForTask(
  stdoutPath: string,
  opts: { taskId: string; alias?: string },
): { rowCount: number; error?: string } {
  try {
    const rows = extractUsageFromStdoutLog(stdoutPath, opts);
    if (rows.length === 0) return { rowCount: 0 };
    insertUsageRows(rows);
    return { rowCount: rows.length };
  } catch (e) {
    return { rowCount: 0, error: (e as Error).message };
  }
}

// Insert a batch of usage rows. Idempotent via (task_id, request_id) — re-running
// against the same log replaces existing rows for that pair so backfill can be
// re-run safely. (request_id alone isn't unique enough; a session might appear
// in multiple task logs during fanout edge cases.)
export function insertUsageRows(rows: UsageRow[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const del = db.prepare(`DELETE FROM model_calls WHERE task_id = ? AND request_id = ?`);
  const ins = db.prepare(`
    INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, prompt_tokens, completion_tokens, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
  `);
  const tx = db.transaction((batch: UsageRow[]) => {
    for (const r of batch) {
      del.run(r.taskId, r.requestId);
      ins.run(r.taskId, r.requestId, r.model, r.alias, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.createdAt);
    }
  });
  tx(rows);
  return rows.length;
}
