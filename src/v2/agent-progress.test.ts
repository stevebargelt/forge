import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { eventsForTask } from "../store/events.js";
import {
  parseProgressLine,
  parseProgressLog,
  progressEventType,
  emitAgentProgressEvents,
  MAX_PROGRESS_RECORDS,
} from "./agent-progress.js";
import type { Run } from "../types/index.js";

// ─── parseProgressLine ───────────────────────────────────────────────────────

test("parseProgressLine: valid progress record with percent clamped", () => {
  const r = parseProgressLine('{"type":"progress","message":"running tests","percent":150}');
  assert.deepEqual(r, { kind: "progress", message: "running tests", percent: 100 });
});

test("parseProgressLine: progress without percent omits it", () => {
  assert.deepEqual(parseProgressLine('{"type":"progress","message":"hi"}'), { kind: "progress", message: "hi" });
});

test("parseProgressLine: artifact maps kind→artifactKind", () => {
  assert.deepEqual(
    parseProgressLine('{"type":"artifact","kind":"screenshot","path":"/task/home.png"}'),
    { kind: "artifact", artifactKind: "screenshot", path: "/task/home.png" },
  );
});

test("parseProgressLine: decision record", () => {
  assert.deepEqual(parseProgressLine('{"type":"decision","summary":"used qa-admin profile"}'), { kind: "decision", summary: "used qa-admin profile" });
});

test("parseProgressLine: foreign stream-json blob is ignored", () => {
  assert.equal(parseProgressLine('{"type":"assistant","message":{"content":[]}}'), null);
});

test("parseProgressLine: malformed JSON / non-object / blank are ignored", () => {
  assert.equal(parseProgressLine("not json"), null);
  assert.equal(parseProgressLine("{ broken"), null);
  assert.equal(parseProgressLine("[1,2,3]"), null);
  assert.equal(parseProgressLine(""), null);
  assert.equal(parseProgressLine("   "), null);
});

test("parseProgressLine: missing required fields are rejected", () => {
  assert.equal(parseProgressLine('{"type":"progress"}'), null); // no message
  assert.equal(parseProgressLine('{"type":"artifact","kind":"x"}'), null); // no path
  assert.equal(parseProgressLine('{"type":"decision"}'), null); // no summary
});

test("progressEventType: maps each kind to its event type", () => {
  assert.equal(progressEventType({ kind: "progress", message: "x" }), "task.progress");
  assert.equal(progressEventType({ kind: "artifact", artifactKind: "k", path: "p" }), "task.artifact");
  assert.equal(progressEventType({ kind: "decision", summary: "s" }), "task.decision");
});

// ─── parseProgressLog ────────────────────────────────────────────────────────

test("parseProgressLog: parses valid lines, skips junk, reports not-truncated", () => {
  const body = [
    '{"type":"progress","message":"a","percent":10}',
    'garbage line that is not json',
    '{"type":"artifact","kind":"screenshot","path":"/x.png"}',
    '{"type":"assistant","message":{}}',
    '{"type":"decision","summary":"d"}',
  ].join("\n");
  const { records, truncated } = parseProgressLog(body);
  assert.equal(records.length, 3);
  assert.equal(truncated, false);
  assert.deepEqual(records.map((r) => r.kind), ["progress", "artifact", "decision"]);
});

test("parseProgressLog: caps at MAX_PROGRESS_RECORDS and flags truncated", () => {
  const lines = Array.from({ length: MAX_PROGRESS_RECORDS + 50 }, (_, i) => `{"type":"progress","message":"m${i}"}`);
  const { records, truncated } = parseProgressLog(lines.join("\n"));
  assert.equal(records.length, MAX_PROGRESS_RECORDS);
  assert.equal(truncated, true);
});

// ─── emitAgentProgressEvents ─────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let tmpDir: string;

const RUN: Run = { id: "run-prog", workflow: "feature", title: "prog", status: "active", createdAt: "2026-05-29T00:00:00Z" };

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  tmpDir = mkdtempSync(join(tmpdir(), "forge-prog-test-"));
});
afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("emitAgentProgressEvents: emits one event per record into the task timeline", () => {
  writeFileSync(join(tmpDir, "progress.jsonl"), [
    '{"type":"progress","message":"installed deps","percent":25}',
    '{"type":"artifact","kind":"screenshot","path":"/task/home.png"}',
    '{"type":"decision","summary":"used existing auth"}',
  ].join("\n") + "\n");

  const n = emitAgentProgressEvents(tmpDir, RUN.id, "task-prog");
  assert.equal(n, 3);
  const types = eventsForTask("task-prog").map((e) => e.eventType);
  assert.deepEqual(types, ["task.progress", "task.artifact", "task.decision"]);
  const progress = eventsForTask("task-prog").find((e) => e.eventType === "task.progress")!;
  assert.equal((progress.payload as Record<string, unknown>).percent, 25);
});

test("emitAgentProgressEvents: no file → no events, returns 0, never throws", () => {
  assert.equal(emitAgentProgressEvents(tmpDir, RUN.id, "task-none"), 0);
  assert.equal(eventsForTask("task-none").length, 0);
});

test("emitAgentProgressEvents: empty file → no events", () => {
  writeFileSync(join(tmpDir, "progress.jsonl"), "");
  assert.equal(emitAgentProgressEvents(tmpDir, RUN.id, "task-empty"), 0);
});
