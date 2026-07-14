// RUN-5: export a run's events as JSONL or OpenTelemetry (OTLP) spans.
//
// This is an EXPORT path, not the source of truth. The WALK-2 trace shape
// (run → task → … with spanKind) is realized here: the run is a root span, each
// task a child span, and lifecycle events become span events. No collector and
// no OTel SDK dependency — we emit OTLP/JSON that any OTLP/HTTP endpoint or the
// otel-cli can ingest.

import { createHash } from "node:crypto";
import type { Run, Task } from "../types/index.js";
import type { Event } from "../store/events.js";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";

// ── JSONL ────────────────────────────────────────────────────────────────────

/** One event per line: { runId, taskId, eventType, ts, payload }. */
export function exportRunJsonl(runId: string): string {
  if (!getRun(runId)) throw new Error(`export: run not found: ${runId}`);
  return eventsForRun(runId)
    .map((e) => JSON.stringify({ runId: e.runId, taskId: e.taskId, eventType: e.eventType, ts: e.createdAt, payload: e.payload ?? null }))
    .join("\n");
}

// ── OTLP/JSON ────────────────────────────────────────────────────────────────

// Deterministic IDs derived from forge ids: 16-byte trace (32 hex), 8-byte span
// (16 hex). Same run/task always maps to the same span — re-exports are stable.
function traceIdFor(runId: string): string {
  return createHash("sha256").update(`forge-trace:${runId}`).digest("hex").slice(0, 32);
}
function spanIdFor(key: string): string {
  return createHash("sha256").update(`forge-span:${key}`).digest("hex").slice(0, 16);
}

// ms → unix nanoseconds as a string. BigInt: ms*1e6 exceeds MAX_SAFE_INTEGER.
function unixNano(iso: string | undefined, fallbackMs: number): string {
  const ms = iso ? new Date(iso).getTime() : NaN;
  const useMs = Number.isFinite(ms) ? ms : fallbackMs;
  return (BigInt(Math.trunc(useMs)) * 1_000_000n).toString();
}

function attr(key: string, value: string | number | boolean) {
  if (typeof value === "number") return { key, value: { intValue: Math.trunc(value) } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

// task.status → OTLP status code: 0 UNSET, 1 OK, 2 ERROR.
function statusCode(status: string): number {
  if (status === "failed" || status === "blocked_by_red") return 2;
  if (status === "complete") return 1;
  // FG-425 (AC5): awaiting_recovery lands here — UNSET, deliberately. It is not an
  // ERROR (nothing has failed; the candidate may be on the target) and it is not OK
  // (nothing is settled). A span that claimed either would be the same lie the task
  // row is forbidden to tell.
  return 0;
}

function payloadAttrs(payload: unknown): Array<ReturnType<typeof attr>> {
  if (!payload || typeof payload !== "object") return [];
  const out: Array<ReturnType<typeof attr>> = [];
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.push(attr(k, v));
  }
  return out;
}

function spanEvent(e: Event) {
  return {
    name: e.eventType,
    timeUnixNano: unixNano(e.createdAt, 0),
    attributes: payloadAttrs(e.payload),
  };
}

export function exportRunOtlp(runId: string, nowMs = Date.now()): unknown {
  const run = getRun(runId);
  if (!run) throw new Error(`export: run not found: ${runId}`);

  const traceId = traceIdFor(runId);
  const runSpanId = spanIdFor(`run:${runId}`);
  const events = eventsForRun(runId);
  const tasks = tasksForRun(runId);

  const runStart = unixNano(run.createdAt, nowMs);
  const runEnd = unixNano(run.completedAt, nowMs);

  // Root span = the run. Run-level events (no taskId) attach here.
  const runSpan = {
    traceId, spanId: runSpanId, name: `run ${run.workflow}`, kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: runStart, endTimeUnixNano: runEnd,
    attributes: [attr("forge.run_id", runId), attr("forge.workflow", run.workflow), attr("forge.run_status", run.status), attr("span.kind", "run")],
    events: events.filter((e) => e.taskId === null).map(spanEvent),
    status: { code: run.status === "abandoned" ? 2 : 1 },
  };

  // Child spans = tasks. Task lifecycle events attach to their task span.
  const taskSpans = tasks.map((t: Task) => ({
    traceId, spanId: spanIdFor(`task:${t.id}`), parentSpanId: runSpanId,
    name: `task ${t.phase} ${t.agentRole}`, kind: 1,
    startTimeUnixNano: unixNano(t.startedAt, nowMs), endTimeUnixNano: unixNano(t.completedAt, nowMs),
    attributes: [attr("forge.task_id", t.id), attr("forge.phase", t.phase), attr("forge.role", t.agentRole), attr("forge.task_status", t.status), attr("span.kind", "task")],
    events: events.filter((e) => e.taskId === t.id).map(spanEvent),
    status: { code: statusCode(t.status) },
  }));

  return {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", "forge"), attr("forge.run_id", runId)] },
      scopeSpans: [{ scope: { name: "forge" }, spans: [runSpan, ...taskSpans] }],
    }],
  };
}

export type { Run };
