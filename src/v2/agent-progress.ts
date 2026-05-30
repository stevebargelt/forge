// WALK-3: optional agent progress records.
//
// Agents MAY (never must) write structured progress records to a `progress.jsonl`
// file in their task dir — one JSON object per line. Forge parses them into
// task.progress / task.artifact / task.decision events.
//
// Why a file and not stdout: the container runs `claude --output-format
// stream-json`, so the container's stdout is pure stream-json — an agent cannot
// inject a raw top-level line there. The task dir is already the agent↔forge
// interface (result.json, manifest.json) and is mounted writable, so a sibling
// progress.jsonl is the runtime-agnostic channel. (observability.md §2 describes
// the mechanism as "stdout"; this realizes the same intent against the actual
// runtime.)
//
// Everything here is defensive: malformed lines, foreign JSON (e.g. a stray
// stream-json blob), and unknown types are ignored, never throwing. If an agent
// emits nothing, forge still works entirely from lifecycle + logs.

import { statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "../store/events.js";

export type ProgressRecord =
  | { kind: "progress"; message: string; percent?: number }
  | { kind: "artifact"; artifactKind: string; path: string }
  | { kind: "decision"; summary: string };

// Cap individual fields so a runaway agent line can't bloat an event payload.
const MAX_FIELD_CHARS = 500;
// Cap total records parsed from one log so a pathological file can't flood the
// event table. Truncation is surfaced by the caller (no silent cap).
export const MAX_PROGRESS_RECORDS = 500;

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) + "…" : v;
}

/** Parse one line into a ProgressRecord, or null if it isn't a well-formed
 *  forge progress record. Never throws. */
export function parseProgressLine(line: string): ProgressRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (obj["type"]) {
    case "progress": {
      const message = str(obj["message"]);
      if (message === undefined) return null;
      const rec: ProgressRecord = { kind: "progress", message };
      const pct = obj["percent"];
      if (typeof pct === "number" && Number.isFinite(pct)) {
        rec.percent = Math.max(0, Math.min(100, pct));
      }
      return rec;
    }
    case "artifact": {
      const artifactKind = str(obj["kind"]);
      const path = str(obj["path"]);
      if (artifactKind === undefined || path === undefined) return null;
      return { kind: "artifact", artifactKind, path };
    }
    case "decision": {
      const summary = str(obj["summary"]);
      if (summary === undefined) return null;
      return { kind: "decision", summary };
    }
    default:
      return null;
  }
}

export type ParseProgressResult = {
  records: ProgressRecord[];
  truncated: boolean; // more than MAX_PROGRESS_RECORDS valid records were present
};

/** Parse a full progress.jsonl body into records, ignoring junk lines and
 *  capping the count. Never throws. */
export function parseProgressLog(content: string): ParseProgressResult {
  const records: ProgressRecord[] = [];
  let truncated = false;
  for (const line of content.split("\n")) {
    const rec = parseProgressLine(line);
    if (!rec) continue;
    if (records.length >= MAX_PROGRESS_RECORDS) {
      truncated = true;
      break;
    }
    records.push(rec);
  }
  return { records, truncated };
}

/** The event type a record maps to. */
export function progressEventType(rec: ProgressRecord): "task.progress" | "task.artifact" | "task.decision" {
  switch (rec.kind) {
    case "progress": return "task.progress";
    case "artifact": return "task.artifact";
    case "decision": return "task.decision";
  }
}

const PROGRESS_FILE = "progress.jsonl";
// Bound the file read so a runaway progress file can't blow up memory; the
// record cap handles flooding, this caps the bytes we even parse.
const MAX_PROGRESS_BYTES = 1024 * 1024;

function progressPayload(rec: ProgressRecord): Record<string, unknown> {
  switch (rec.kind) {
    case "progress": return rec.percent === undefined ? { message: rec.message } : { message: rec.message, percent: rec.percent };
    case "artifact": return { kind: rec.artifactKind, path: rec.path };
    case "decision": return { summary: rec.summary };
  }
}

/** Read an optional progress.jsonl from a task dir and emit one task.progress /
 *  task.artifact / task.decision event per valid record. No-op (and never
 *  throws) when the file is absent or empty. Returns the count emitted. WALK-3. */
export function emitAgentProgressEvents(taskDirPath: string, runId: string, taskId: string): number {
  const path = join(taskDirPath, PROGRESS_FILE);
  let content: string;
  try {
    const { size } = statSync(path);
    if (size === 0) return 0;
    if (size <= MAX_PROGRESS_BYTES) {
      content = readFileSync(path, "utf8");
    } else {
      // Read only the leading window; trailing partial line is dropped by the
      // line-by-line parser (it won't be valid JSON).
      const buf = Buffer.alloc(MAX_PROGRESS_BYTES);
      const fd = openSync(path, "r");
      try { readSync(fd, buf, 0, MAX_PROGRESS_BYTES, 0); } finally { closeSync(fd); }
      content = buf.toString("utf8");
    }
  } catch {
    return 0; // no progress file — the common case
  }

  const { records, truncated } = parseProgressLog(content);
  for (const rec of records) {
    logEvent(progressEventType(rec), { runId, taskId, payload: progressPayload(rec) });
  }
  if (truncated) {
    logEvent("task.progress", {
      runId,
      taskId,
      payload: { message: `progress.jsonl truncated: only the first ${MAX_PROGRESS_RECORDS} records were ingested`, truncated: true },
    });
  }
  return records.length;
}
