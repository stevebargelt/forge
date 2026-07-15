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
import { getDb, writeTransaction, LEGACY_MODEL_CALLS_COLUMNS } from "./db.js";

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
      const reqId =
        typeof event["request_id"] === "string" ? event["request_id"] :
        typeof msg["id"] === "string" ? msg["id"] :
        undefined;
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

// AWN-7 Walk: per-provider usage parser. Codex (`codex exec --json`) emits JSONL
// events on stdout — entirely unlike claude-code's stream-json. Token usage is a
// single `turn.completed` event per turn:
//   { type:"turn.completed", usage:{ input_tokens, cached_input_tokens,
//                                    output_tokens, reasoning_output_tokens } }
// Verified against codex-cli 0.135.0.
//
// Mapping onto model_calls (kept consistent with the claude convention so the
// `forge usage` cache math is uniform):
//   input_tokens is the TOTAL prompt; cached_input_tokens is the cached SUBSET.
//   So non-cached input = input_tokens − cached_input_tokens, and the cached
//   portion is the cache_read column. output_tokens already includes reasoning
//   tokens (reasoning_output_tokens is a breakdown subset), so we don't add it.
//   Codex exposes no cache-CREATION counter → cache_creation stays 0.
//
// request_id is `${thread_id}#${turnIndex}` so a multi-turn run yields one row
// per turn (matching claude's one-row-per-request model) instead of the last
// turn overwriting the first under insertUsageRows' (task_id, request_id) key.
export function extractUsageFromCodexLog(
  logPath: string,
  opts?: { taskId?: string; alias?: string; model?: string },
): UsageRow[] {
  let raw: string;
  try { raw = readFileSync(logPath, "utf8"); }
  catch { return []; }

  const rows: UsageRow[] = [];
  let threadId: string | undefined;
  let turnIndex = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (!isObject(event)) continue;

    if (event["type"] === "thread.started" && typeof event["thread_id"] === "string") {
      threadId = event["thread_id"];
      continue;
    }

    if (event["type"] === "turn.completed" && isObject(event["usage"])) {
      const u = event["usage"];
      const cached = numField(u, "cached_input_tokens");
      const totalInput = numField(u, "input_tokens");
      rows.push({
        taskId: opts?.taskId ?? null,
        requestId: `${threadId ?? "codex"}#${turnIndex++}`,
        model: opts?.model ?? "codex",
        alias: opts?.alias ?? null,
        inputTokens: Math.max(0, totalInput - cached),
        outputTokens: numField(u, "output_tokens"),
        cacheReadTokens: cached,
        cacheCreationTokens: 0,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return rows;
}

// #262: pi (`pi --mode json`) usage parser. pi emits JSONL; each turn's
// AssistantMessage carries normalized usage { input, output, cacheRead,
// cacheWrite, totalTokens, cost }. The run's `agent_end` event holds every
// message — we read its assistant messages (the complete, authoritative set) and
// emit one row per assistant turn, falling back to `turn_end` events if the run
// was cut off before agent_end. Verified against a live stream captured from pi
// 0.74.2: src/store/__fixtures__/pi-usage-stream.jsonl.
//
// Mapping (pi → model_calls): input → input_tokens — FRESH, no subtraction: pi
// reports cache separately and totalTokens = input+output+cacheRead+cacheWrite,
// so `input` already excludes cache (unlike codex's total input_tokens). output →
// output_tokens, cacheRead → cache_read, cacheWrite → cache_creation. pi
// pre-computes cost, but model_calls is token-only (#295), so cost is dropped.
//
// THE PARSER IS SELECTED BY log_format (pi-jsonl), NEVER the upstream provider:
// pi may run anthropic / openai / groq / ollama, so provider can't pick it (#262).
// request_id = the message's responseId when present, else `${sessionId}#${index}`
// (one row per assistant turn, matching the claude/codex one-row-per-request model).
export function extractUsageFromPiLog(
  logPath: string,
  opts?: { taskId?: string; alias?: string; model?: string },
): UsageRow[] {
  let raw: string;
  try { raw = readFileSync(logPath, "utf8"); }
  catch { return []; }

  let sessionId: string | undefined;
  let agentEndAssistants: Record<string, unknown>[] | undefined;
  const turnAssistants: Record<string, unknown>[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isObject(ev)) continue;

    if (ev["type"] === "session" && typeof ev["id"] === "string") {
      sessionId = ev["id"];
    } else if (ev["type"] === "agent_end" && Array.isArray(ev["messages"])) {
      agentEndAssistants = ev["messages"].filter(
        (m): m is Record<string, unknown> => isObject(m) && m["role"] === "assistant",
      );
    } else if (ev["type"] === "turn_end" && isObject(ev["message"]) && ev["message"]["role"] === "assistant") {
      turnAssistants.push(ev["message"]); // crash fallback when no agent_end
    }
  }

  // agent_end is authoritative + complete; turn_end is the partial-log fallback.
  const assistants = agentEndAssistants ?? turnAssistants;
  return assistants.map((m, i) => {
    const usage = isObject(m["usage"]) ? m["usage"] : {};
    const responseId = m["responseId"];
    return {
      taskId: opts?.taskId ?? null,
      requestId: typeof responseId === "string" && responseId.length > 0 ? responseId : `${sessionId ?? "pi"}#${i}`,
      model: typeof m["model"] === "string" ? m["model"] : (opts?.model ?? "pi"),
      alias: opts?.alias ?? null,
      inputTokens: numField(usage, "input"),
      outputTokens: numField(usage, "output"),
      cacheReadTokens: numField(usage, "cacheRead"),
      cacheCreationTokens: numField(usage, "cacheWrite"),
      createdAt: typeof m["timestamp"] === "number" ? new Date(m["timestamp"]).toISOString() : new Date().toISOString(),
    };
  });
}

// Capture usage from a just-completed task's stdout log into model_calls.
// Best-effort: swallows all errors so a telemetry failure can never block or
// alter task semantics. Call site is right after docker exec returns, in both
// invoke.ts and runNext.ts spawn paths.
//
// #292: the parser choice, isolated as a pure decision so it can be unit-tested
// independent of the DB insert. `log_format` (an EXECUTION fact) is authoritative;
// every supported format is mapped EXPLICITLY. A recognized-but-unimplemented
// format (today: `pi-jsonl`, whose parser lands with #262) returns "unsupported"
// rather than silently falling through to the claude parser — that silent
// fallthrough is exactly the provider-name shortcut #292 exists to kill (it would
// record zero usage and look like success). Any unmapped explicit format is
// likewise "unsupported", so adding a log_format to the schema FORCES a parser
// decision here. `provider` is only the legacy fallback for the pre-#292 path
// where no log_format is threaded through (the openai → codex mapping AWN-7 used).
export function selectUsageParser(opts: { logFormat?: string; provider?: string }): "codex" | "claude" | "pi" | "unsupported" {
  if (opts.logFormat !== undefined) {
    switch (opts.logFormat) {
      case "claude-stream-json": return "claude";
      case "codex-jsonl": return "codex";
      case "pi-jsonl": return "pi"; // #262
      default: return "unsupported"; // any unmapped format
    }
  }
  return opts.provider === "openai" ? "codex" : "claude"; // legacy fallback
}

// Parse-only usage extraction, dispatched by the SAME log_format decision as
// captureUsageForTask. Shared so every consumer (live capture + `forge usage
// backfill`, incl. its dry-run) selects the right parser instead of hardcoding
// the claude one. Returns [] for an unsupported/unknown format (the loud-error
// treatment of that case lives in captureUsageForTask).
export function extractUsageByLogFormat(
  logPath: string,
  opts: { taskId?: string; alias?: string; logFormat?: string; provider?: string; model?: string },
): UsageRow[] {
  switch (selectUsageParser(opts)) {
    case "codex": return extractUsageFromCodexLog(logPath, opts);
    case "pi": return extractUsageFromPiLog(logPath, opts);
    case "claude": return extractUsageFromStdoutLog(logPath, opts);
    case "unsupported": return [];
  }
}

// Capture usage from a just-completed task's stdout log into model_calls.
// Best-effort: swallows transient parse/insert errors so a telemetry failure can
// never block or alter task semantics. Call site is right after docker exec
// returns, in both invoke.ts and runNext.ts spawn paths.
export function captureUsageForTask(
  stdoutPath: string,
  opts: { taskId: string; alias?: string; logFormat?: string; provider?: string; model?: string },
): { rowCount: number; error?: string } {
  if (selectUsageParser(opts) === "unsupported") {
    // FAIL LOUD — not swallowed like a transient error. A runtime declared a
    // log_format whose parser doesn't exist; misattributing it to the claude
    // parser would hide it behind a zero-usage "success".
    const error = `usage capture: no parser for log_format='${opts.logFormat}' — unsupported (no usage parser for this runtime's log format yet)`;
    console.error(`forge: ${error} [task ${opts.taskId}]`);
    return { rowCount: 0, error };
  }
  try {
    const rows = extractUsageByLogFormat(stdoutPath, opts);
    if (rows.length === 0) return { rowCount: 0 };
    insertUsageRows(rows);
    return { rowCount: rows.length };
  } catch (e) {
    return { rowCount: 0, error: (e as Error).message };
  }
}

// Extract usage from a Claude Code .jsonl transcript (the file Claude Code writes
// to ~/.claude/projects/<hash>/<session-id>.jsonl). Different event shape from
// --output-format=stream-json logs, but same usage payload inside message.usage.
// Each assistant turn produces one entry with { message: { id, model, usage } }.
export function extractUsageFromTranscript(
  transcriptPath: string,
  opts?: { taskId?: string; alias?: string },
): UsageRow[] {
  let raw: string;
  try { raw = readFileSync(transcriptPath, "utf8"); }
  catch { return []; }

  const byRequest = new Map<string, UsageRow>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch { continue; }
    if (!isObject(entry)) continue;

    const msg = isObject(entry["message"]) ? entry["message"] : undefined;
    if (!msg) continue;
    if (msg["role"] !== "assistant") continue;

    const reqId = typeof msg["id"] === "string" ? msg["id"] : undefined;
    const model = typeof msg["model"] === "string" ? msg["model"] : undefined;
    const usage = isObject(msg["usage"]) ? msg["usage"] : undefined;
    if (!reqId || !model || !usage) continue;

    const timestamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : undefined;
    const row: UsageRow = {
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
    if (!existing) { byRequest.set(reqId, row); continue; }
    existing.inputTokens         = Math.max(existing.inputTokens,         row.inputTokens);
    existing.outputTokens        = Math.max(existing.outputTokens,        row.outputTokens);
    existing.cacheReadTokens     = Math.max(existing.cacheReadTokens,     row.cacheReadTokens);
    existing.cacheCreationTokens = Math.max(existing.cacheCreationTokens, row.cacheCreationTokens);
  }

  return Array.from(byRequest.values());
}

// Insert a batch of usage rows. Idempotent via (task_id, request_id) — re-running
// against the same log replaces existing rows for that pair so backfill can be
// re-run safely. (request_id alone isn't unique enough; a session might appear
// in multiple task logs during fanout edge cases.)
/** All model-call rows for a task (token counts only — no secrets). Used by the
 *  debug bundle (RUN-4). */
export function usageForTask(taskId: string): UsageRow[] {
  const rows = getDb({ readOnly: true })
    .prepare(`SELECT task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at
              FROM model_calls WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as Array<{
      task_id: string | null; request_id: string; model: string; alias: string | null;
      input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; created_at: string;
    }>;
  return rows.map((r) => ({
    taskId: r.task_id, requestId: r.request_id, model: r.model, alias: r.alias,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens, createdAt: r.created_at,
  }));
}

export function insertUsageRows(rows: UsageRow[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const del = db.prepare(`DELETE FROM model_calls WHERE task_id = ? AND request_id = ?`);

  // FG-568: dual-shape insertion. A version-B writer must capture usage on BOTH
  // schema shapes — the fresh schema AND an unconverged 0.1.x-migrated store that
  // still carries the legacy NOT NULL columns (prompt_tokens/completion_tokens/
  // cost). The additive-only open path deliberately does NOT drop those columns
  // (only `forge store converge` does), so a real store can carry them for the
  // whole version-overlap window.
  //
  // Why this matters — this WAS a silent prod bug, not cosmetic: on a legacy store
  // the fresh-only INSERT below violates the legacy NOT NULL columns and throws.
  // captureUsageForTask catches it into {rowCount:0, error}, but runNext/invoke
  // DISCARD that error and the orchestrator capture path swallows it — so a legacy-
  // store insert failure lost usage with NO operator signal. Writing the legacy
  // columns with 0/0/0 (the established pre-#295 compatibility placeholders — those
  // columns are documented unread dead weight, so 0 is correct and harmless)
  // eliminates the failure on both real shapes. We do NOT auto-drop or auto-converge.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(model_calls)`).all() as { name: string }[]).map((c) => c.name),
  );
  const legacy = LEGACY_MODEL_CALLS_COLUMNS;
  const present = legacy.filter((c) => cols.has(c));

  // Prepare the correct statement ONCE per call (not per row). Both the fresh and
  // the legacy statements bind the same nine value params; the legacy one appends
  // the three legacy columns filled with the 0/0/0 placeholders as SQL literals.
  let insSql: string;
  if (present.length === 0) {
    insSql = `
      INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
  } else if (present.length === legacy.length) {
    insSql = `
      INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, prompt_tokens, completion_tokens, cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
    `;
  } else {
    // A SUBSET of the legacy columns exists — an inconsistent/corrupt schema no
    // real migration produces. Refuse LOUDLY rather than silently lose usage.
    const missing = legacy.filter((c) => !cols.has(c));
    throw new Error(
      `insertUsageRows: inconsistent model_calls schema — legacy columns present [${present.join(", ")}] ` +
        `but missing [${missing.join(", ")}]. A valid store has all three legacy columns (unconverged 0.1.x) ` +
        `or none (fresh/converged). Run \`forge store converge\` to converge this store to the fresh shape.`,
    );
  }
  const ins = db.prepare(insSql);

  writeTransaction(() => {
    for (const r of rows) {
      del.run(r.taskId, r.requestId);
      ins.run(r.taskId, r.requestId, r.model, r.alias, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.createdAt);
    }
  });
  return rows.length;
}
