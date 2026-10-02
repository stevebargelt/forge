// FG-808: requested vs served model — the classifier over stream fixtures (same,
// switched, mixed, unverifiable), the codex/pi no-echo rule, the record/event writer,
// the ops detector, and the review-lens provenance carry.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";
import { eventsForTask } from "./events.js";
import {
  PRIMARY_SERVED_SHARE,
  UNVERIFIABLE_SERVED_MODEL,
  classifyServedModelRows,
  extractUsageFromCodexLog,
  extractUsageFromPiLog,
  extractUsageFromStdoutLog,
  insertUsageRows,
  usageModelMismatches,
  type UsageRow,
} from "./model-calls.js";
import { recordServedModelCheck, describeServedModelCheck, modelMismatchForTask } from "../v2/served-model.js";
import { readTaskManifest, writeTaskManifest, type TaskManifest } from "../v2/task-manifest.js";
import { detectModelMismatch } from "../ops/detect.js";
import { assessLens } from "../v2/review-discovery.js";
import type { Run, Task } from "../types/index.js";

const REQUESTED = "claude-opus-5-5";
const dir = mkdtempSync(join(tmpdir(), "forge-fg808-"));

/** A claude stream-json stdout in the real event shape (see __fixtures__/real-claude-stream.jsonl):
 *  system/init names the REQUESTED id; each assistant event's message.model is the SERVED id for
 *  its request; the message_delta carries the request's final usage. */
function claudeStream(name: string, served: Array<{ model: string; out: number }>): string {
  const session = "sess";
  const lines: unknown[] = [{ type: "system", subtype: "init", session_id: session, model: `us.anthropic.${REQUESTED}` }];
  served.forEach((s, i) => {
    lines.push({ type: "assistant", session_id: session, request_id: `req_${i}`, message: { id: `msg_${i}`, model: s.model, usage: { input_tokens: 5, output_tokens: 1 } } });
    lines.push({ type: "stream_event", session_id: session, event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: s.out } } });
  });
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function classifyStream(name: string, served: Array<{ model: string; out: number }>) {
  return classifyServedModelRows(extractUsageFromStdoutLog(claudeStream(name, served), { taskId: "t" }), REQUESTED);
}

test("FG-808 same: every request served by the requested model (bedrock-qualified form included)", () => {
  const c = classifyStream("same.jsonl", [{ model: REQUESTED, out: 100 }, { model: `us.anthropic.${REQUESTED}`, out: 50 }]);
  assert.equal(c?.classification, "same");
  assert.equal(c?.servedModels.length, 1);
  assert.deepEqual(c?.servedModels[0]?.requestIds, ["req_0", "req_1"]);
});

test("FG-808 switched: a mid-session switch whose later turns out-write the requested model", () => {
  const c = classifyStream("switched.jsonl", [
    { model: REQUESTED, out: 100 },
    { model: "claude-opus-4-1", out: 300 },
    { model: "claude-opus-4-1", out: 300 },
  ]);
  assert.equal(c?.classification, "switched");
  const other = c?.servedModels.find((m) => m.model === "claude-opus-4-1");
  assert.deepEqual(other?.requestIds, ["req_1", "req_2"]);
  assert.ok(Math.abs((other?.share ?? 0) - 6 / 7) < 1e-9);
  assert.match(describeServedModelCheck(c!), /^requested claude-opus-5-5, served claude-opus-4-1 ×2 \(86%\), claude-opus-5-5 ×1 \(14%\) \(switched\)$/);
});

test("FG-808 switched: no request at all on the requested model", () => {
  assert.equal(classifyStream("all-other.jsonl", [{ model: "claude-sonnet-4-6", out: 10 }])?.classification, "switched");
});

test("FG-808 mixed: side-calls outnumber the main turns by COUNT but not by output tokens", () => {
  const c = classifyStream("mixed.jsonl", [
    { model: REQUESTED, out: 2000 },
    { model: "claude-haiku-4-5-20251001", out: 20 },
    { model: "claude-haiku-4-5-20251001", out: 20 },
    { model: "claude-haiku-4-5-20251001", out: 20 },
  ]);
  assert.equal(c?.classification, "mixed", "output tokens, not request count, decide the primary share");
});

test(`FG-808: an even split names no primary — ${PRIMARY_SERVED_SHARE} is a strict floor, so it is switched`, () => {
  const c = classifyStream("even.jsonl", [{ model: REQUESTED, out: 100 }, { model: "claude-opus-4-1", out: 100 }]);
  assert.equal(c?.classification, "switched");
});

test("FG-808: no output tokens anywhere falls back to request-count shares", () => {
  const rows: UsageRow[] = ["a", "b", "c"].map((id, i) => ({
    taskId: "t", requestId: id, model: i === 0 ? "claude-haiku-4-5" : REQUESTED, alias: null,
    inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, createdAt: "x",
  }));
  assert.equal(classifyServedModelRows(rows, REQUESTED)?.classification, "mixed");
});

test("FG-808 AC4 unverifiable (codex): rows carry `unverifiable`, never the requested id; classification is unverifiable", () => {
  const path = join(dir, "codex.jsonl");
  writeFileSync(path, [
    { type: "thread.started", thread_id: "th" },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
  ].map((l) => JSON.stringify(l)).join("\n"));
  const rows = extractUsageFromCodexLog(path, { taskId: "t", model: "gpt-5.5" });
  assert.equal(rows[0]?.model, UNVERIFIABLE_SERVED_MODEL);
  assert.equal(classifyServedModelRows(rows, "gpt-5.5")?.classification, "unverifiable");
  assert.deepEqual(usageModelMismatches(rows, "gpt-5.5"), [], "an unverifiable row is not a mismatch");
});

test("FG-808 AC4 (pi): a message with no model is unverifiable; a reported model is kept verbatim", () => {
  const path = join(dir, "pi.jsonl");
  writeFileSync(path, [
    { type: "agent_end", messages: [
      { role: "assistant", responseId: "r1", usage: { input: 1, output: 1 } },
      { role: "assistant", responseId: "r2", model: "claude-sonnet-4-6", usage: { input: 1, output: 1 } },
    ] },
  ].map((l) => JSON.stringify(l)).join("\n"));
  const rows = extractUsageFromPiLog(path, { taskId: "t", model: "requested-model" });
  assert.deepEqual(rows.map((r) => r.model), [UNVERIFIABLE_SERVED_MODEL, "claude-sonnet-4-6"]);
});

function writeStream(name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("FG-808 RF-1: an interleaved request's message_delta keeps ITS OWN served model, not the last one seen", () => {
  const rows = extractUsageFromStdoutLog(writeStream("interleaved.jsonl", [
    { type: "assistant", session_id: "sA", request_id: "req_A", message: { id: "msg_A", model: REQUESTED, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "assistant", session_id: "sB", request_id: "req_B", message: { id: "msg_B", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "stream_event", session_id: "sA", event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: 900 } } },
    { type: "stream_event", session_id: "sB", event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: 10 } } },
  ]), { taskId: "t" });
  const byId = new Map(rows.map((r) => [r.requestId, r]));
  assert.equal(byId.get("req_A")?.model, REQUESTED);
  assert.equal(byId.get("req_A")?.outputTokens, 900);
  assert.equal(byId.get("req_B")?.model, "claude-haiku-4-5-20251001");
  assert.equal(classifyServedModelRows(rows, REQUESTED)?.classification, "mixed");
});

test("FG-808 RF-2: an assistant event with no message.model is unverifiable, never a previously observed model", () => {
  const rows = extractUsageFromStdoutLog(writeStream("no-model.jsonl", [
    { type: "assistant", session_id: "s", request_id: "req_0", message: { id: "msg_0", model: REQUESTED, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "stream_event", session_id: "s", event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: 10 } } },
    { type: "assistant", session_id: "s", request_id: "req_1", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "stream_event", session_id: "s", event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: 500 } } },
  ]), { taskId: "t" });
  const byId = new Map(rows.map((r) => [r.requestId, r]));
  assert.equal(byId.get("req_0")?.model, REQUESTED);
  assert.equal(byId.get("req_1")?.model, UNVERIFIABLE_SERVED_MODEL);
  assert.equal(classifyServedModelRows(rows, REQUESTED)?.classification, "unverifiable");
  assert.deepEqual(usageModelMismatches(rows, REQUESTED), [], "an unverifiable row raises no mismatch");
});

test("FG-808 RF-4: a model-less assistant event on a request that already named a model fails closed to unverifiable", () => {
  const rows = extractUsageFromStdoutLog(writeStream("rf4-overwrite.jsonl", [
    { type: "assistant", session_id: "s", request_id: "req", message: { id: "msg", model: REQUESTED } },
    { type: "assistant", session_id: "s", request_id: "req", message: { id: "msg" } },
    { type: "stream_event", session_id: "s", event: { type: "message_delta", usage: { output_tokens: 100 } } },
  ]), { taskId: "t" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.model, UNVERIFIABLE_SERVED_MODEL);
  assert.equal(rows[0]?.outputTokens, 100);
  assert.equal(classifyServedModelRows(rows, REQUESTED)?.classification, "unverifiable");
  assert.deepEqual(usageModelMismatches(rows, REQUESTED), []);
});

test("FG-808 RF-4: once unverifiable, a later model-bearing event on the same request does not un-mark it", () => {
  const rows = extractUsageFromStdoutLog(writeStream("rf4-sticky.jsonl", [
    { type: "assistant", session_id: "s", request_id: "req", message: { id: "msg", usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "assistant", session_id: "s", request_id: "req", message: { id: "msg", model: REQUESTED, usage: { input_tokens: 5, output_tokens: 2 } } },
    { type: "stream_event", session_id: "s", event: { type: "message_delta", usage: { input_tokens: 5, output_tokens: 100 } } },
  ]), { taskId: "t" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.model, UNVERIFIABLE_SERVED_MODEL);
  assert.equal(classifyServedModelRows(rows, REQUESTED)?.classification, "unverifiable");
});

test("FG-808: nothing to compare (no requested model, or no rows) → undefined", () => {
  const rows = extractUsageFromStdoutLog(claudeStream("none.jsonl", [{ model: REQUESTED, out: 1 }]));
  assert.equal(classifyServedModelRows(rows, ""), undefined);
  assert.equal(classifyServedModelRows([], REQUESTED), undefined);
});

// ── recorder, event, ops detector — against an in-memory store ────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function seedTask(taskId: string, runId: string, served: Array<{ model: string; out: number }>): string {
  insertRun({ id: runId, workflow: "invoke", title: runId, status: "active", createdAt: "2026-10-02T00:00:00Z", projectDir: "/p" } as Run);
  insertTask({
    id: taskId, runId, phase: "task", agentRole: "red-security", status: "running",
    taskPackage: { taskId, runId, phase: "task", role: "red-security", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-10-02T00:00:00Z",
  } as Task);
  insertUsageRows(extractUsageFromStdoutLog(claudeStream(`${taskId}.jsonl`, served), { taskId }));
  const tdir = mkdtempSync(join(tmpdir(), `forge-fg808-${taskId}-`));
  writeTaskManifest(tdir, { taskId, runId } as TaskManifest);
  return tdir;
}

test("FG-808: recordServedModelCheck — switched writes the manifest block and exactly ONE event; detectModelMismatch lists it, informational", () => {
  const tdir = seedTask("t-sw", "r-sw", [{ model: REQUESTED, out: 10 }, { model: "claude-opus-4-1", out: 90 }]);
  const check = recordServedModelCheck({ runId: "r-sw", taskId: "t-sw", taskDir: tdir, requestedModel: REQUESTED });
  assert.equal(check?.classification, "switched");
  assert.equal(readTaskManifest(tdir)?.servedModel?.classification, "switched");
  assert.equal(readTaskManifest(tdir)?.taskId, "t-sw", "the rest of the manifest is preserved");
  assert.equal(eventsForTask("t-sw").filter((e) => e.eventType === "task.model_mismatch").length, 1);
  assert.equal(modelMismatchForTask("t-sw")?.classification, "switched");

  const incidents = detectModelMismatch(db, { projectDir: "/p" });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.kind, "model_mismatch");
  assert.equal(incidents[0]?.severity, "low");
  assert.equal(incidents[0]?.recommendedAction.type, "investigate");
  assert.equal(incidents[0]?.recommendedAction.autonomy, "manual-only");
  assert.match(incidents[0]?.evidence.join(" ") ?? "", /claude-opus-4-1 \(1 request\(s\): req_1\)/);
});

test("FG-808 RF-1: recordServedModelCheck re-entered on the same task appends NO second task.model_mismatch event", () => {
  const tdir = seedTask("t-re", "r-re", [{ model: REQUESTED, out: 10 }, { model: "claude-opus-4-1", out: 90 }]);
  assert.equal(recordServedModelCheck({ runId: "r-re", taskId: "t-re", taskDir: tdir, requestedModel: REQUESTED })?.classification, "switched");
  assert.equal(recordServedModelCheck({ runId: "r-re", taskId: "t-re", taskDir: tdir, requestedModel: REQUESTED })?.classification, "switched");
  writeTaskManifest(tdir, { taskId: "t-re", runId: "r-re" } as TaskManifest);
  assert.equal(recordServedModelCheck({ runId: "r-re", taskId: "t-re", taskDir: tdir, requestedModel: REQUESTED })?.classification, "switched");
  assert.equal(readTaskManifest(tdir)?.servedModel?.classification, "switched", "the manifest block is still refreshed on re-entry");
  assert.equal(eventsForTask("t-re").filter((e) => e.eventType === "task.model_mismatch").length, 1);
});

test("FG-808: same records the manifest block and NO event; mixed records an event but is NOT an ops incident", () => {
  const sameDir = seedTask("t-same", "r-same", [{ model: REQUESTED, out: 10 }]);
  assert.equal(recordServedModelCheck({ runId: "r-same", taskId: "t-same", taskDir: sameDir, requestedModel: REQUESTED })?.classification, "same");
  assert.equal(readTaskManifest(sameDir)?.servedModel?.classification, "same");
  assert.equal(eventsForTask("t-same").filter((e) => e.eventType === "task.model_mismatch").length, 0);

  const mixedDir = seedTask("t-mix", "r-mix", [{ model: REQUESTED, out: 900 }, { model: "claude-haiku-4-5", out: 10 }]);
  assert.equal(recordServedModelCheck({ runId: "r-mix", taskId: "t-mix", taskDir: mixedDir, requestedModel: REQUESTED })?.classification, "mixed");
  assert.equal(eventsForTask("t-mix").filter((e) => e.eventType === "task.model_mismatch").length, 1);
  assert.deepEqual(detectModelMismatch(db, {}), []);
});

test("FG-808: the served-model record rides a lens outcome on both branches (review provenance)", () => {
  const servedModel = classifyStream("lens.jsonl", [{ model: "claude-opus-4-1", out: 10 }])!;
  const done = assessLens({
    lens: "security", role: "red-security", dispatched: true, taskId: "t",
    result: { outcome: "pass", findings: [] }, servedModel,
  });
  assert.equal(done.servedModel?.classification, "switched");
  const crashed = assessLens({ lens: "security", role: "red-security", dispatched: false, failureKind: "container_crash", servedModel });
  assert.equal(crashed.complete, false);
  assert.equal(crashed.servedModel?.classification, "switched");
});

test("FG-808 RF-4: the review's sequence records unverifiable with NO mismatch event", () => {
  insertRun({ id: "r-rf4", workflow: "invoke", title: "r-rf4", status: "active", createdAt: "2026-10-02T00:00:00Z", projectDir: "/p" } as Run);
  insertTask({
    id: "t-rf4", runId: "r-rf4", phase: "task", agentRole: "red-security", status: "running",
    taskPackage: { taskId: "t-rf4", runId: "r-rf4", phase: "task", role: "red-security", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-10-02T00:00:00Z",
  } as Task);
  insertUsageRows(extractUsageFromStdoutLog(writeStream("t-rf4.jsonl", [
    { type: "assistant", session_id: "s", request_id: "req", message: { id: "msg", model: REQUESTED } },
    { type: "assistant", session_id: "s", request_id: "req", message: { id: "msg" } },
    { type: "stream_event", session_id: "s", event: { type: "message_delta", usage: { output_tokens: 100 } } },
  ]), { taskId: "t-rf4" }));
  const tdir = mkdtempSync(join(tmpdir(), "forge-fg808-t-rf4-"));
  writeTaskManifest(tdir, { taskId: "t-rf4", runId: "r-rf4" } as TaskManifest);
  const check = recordServedModelCheck({ runId: "r-rf4", taskId: "t-rf4", taskDir: tdir, requestedModel: REQUESTED });
  assert.equal(check?.classification, "unverifiable");
  assert.equal(eventsForTask("t-rf4").filter((e) => e.eventType === "task.model_mismatch").length, 0);
});
