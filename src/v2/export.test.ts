import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { exportRunJsonl, exportRunOtlp } from "./export.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = { id: "run-exp", workflow: "feature", title: "exp", status: "complete", createdAt: "2026-05-20T00:00:00Z", completedAt: "2026-05-20T00:10:00Z" };

function mkTask(id: string, o: Partial<Task> = {}): Task {
  return { id, runId: RUN.id, phase: o.phase ?? "engineer", agentRole: o.agentRole ?? "engineer", status: o.status ?? "complete",
    taskPackage: { taskId: id, runId: RUN.id, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-20T00:00:00Z", startedAt: o.startedAt, completedAt: o.completedAt, ...o };
}

beforeEach(() => {
  db = makeInMemoryDb(); prev = setDbForTest(db);
  insertRun(RUN);
});
afterEach(() => { setDbForTest(prev as DatabaseInstance); db.close(); });

// ── JSONL ──

test("exportRunJsonl: one JSON line per event with stable fields", () => {
  insertTask(mkTask("task-1"));
  logEvent("task.created", { runId: RUN.id, taskId: "task-1" });
  logEvent("task.completed", { runId: RUN.id, taskId: "task-1" });
  logEvent("run.completed", { runId: RUN.id, payload: { source: "test" } });

  const lines = exportRunJsonl(RUN.id).split("\n");
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]!);
  assert.deepEqual(Object.keys(first).sort(), ["eventType", "payload", "runId", "taskId", "ts"]);
  assert.equal(first.eventType, "task.created");
  assert.equal(first.taskId, "task-1");
  const runEv = lines.map((l) => JSON.parse(l)).find((e) => e.eventType === "run.completed");
  assert.equal(runEv.taskId, null, "run-level event has null taskId");
});

test("exportRunJsonl: throws on unknown run", () => {
  assert.throws(() => exportRunJsonl("nope"), /run not found/);
});

// ── OTLP ──

test("exportRunOtlp: run is the root span, tasks are child spans sharing one trace", () => {
  insertTask(mkTask("task-a", { startedAt: "2026-05-20T00:01:00Z", completedAt: "2026-05-20T00:03:00Z" }));
  logEvent("task.started", { runId: RUN.id, taskId: "task-a" });
  logEvent("run.completed", { runId: RUN.id });

  const otlp = exportRunOtlp(RUN.id) as any;
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2, "one run span + one task span");

  const runSpan = spans[0];
  const taskSpan = spans[1];
  // Shared trace, task parented to the run.
  assert.equal(runSpan.traceId, taskSpan.traceId);
  assert.equal(runSpan.traceId.length, 32, "16-byte trace id (32 hex)");
  assert.equal(runSpan.spanId.length, 16, "8-byte span id (16 hex)");
  assert.equal(taskSpan.parentSpanId, runSpan.spanId);
  assert.equal(runSpan.parentSpanId, undefined, "root span has no parent");

  // Timestamps are unix-nano strings (BigInt-derived, no precision loss).
  assert.match(runSpan.startTimeUnixNano, /^\d+$/);
  assert.equal(runSpan.startTimeUnixNano, (BigInt(new Date(RUN.createdAt).getTime()) * 1_000_000n).toString());

  // Events route to the right span.
  assert.ok(runSpan.events.some((e: any) => e.name === "run.completed"), "run event on run span");
  assert.ok(taskSpan.events.some((e: any) => e.name === "task.started"), "task event on task span");
});

test("exportRunOtlp: deterministic ids — same run exports the same ids", () => {
  insertTask(mkTask("task-a"));
  const a = exportRunOtlp(RUN.id) as any;
  const b = exportRunOtlp(RUN.id) as any;
  assert.equal(a.resourceSpans[0].scopeSpans[0].spans[0].spanId, b.resourceSpans[0].scopeSpans[0].spans[0].spanId);
  assert.equal(a.resourceSpans[0].scopeSpans[0].spans[0].traceId, b.resourceSpans[0].scopeSpans[0].spans[0].traceId);
});

test("exportRunOtlp: failed task span gets ERROR status code 2", () => {
  insertTask(mkTask("task-bad", { status: "failed" }));
  const otlp = exportRunOtlp(RUN.id) as any;
  const taskSpan = otlp.resourceSpans[0].scopeSpans[0].spans[1];
  assert.equal(taskSpan.status.code, 2);
});
