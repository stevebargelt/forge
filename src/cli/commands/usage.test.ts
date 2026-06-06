// #262: forge usage backfill must select the parser from each task's manifest
// runtime.logFormat — a pi/codex historical log would otherwise backfill ZERO
// rows through the claude default. Tests the command path (performBackfill), not
// just the dispatcher, so dropping the manifestLogFormat() call is caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { performBackfill } from "./usage.js";

// A real pi --mode json shape: usage lives on agent_end's assistant messages.
// The claude parser (which keys off type:"assistant" events) finds nothing here.
const PI_STREAM =
  JSON.stringify({ type: "session", id: "sess-bf" }) + "\n" +
  JSON.stringify({ type: "agent_end", messages: [
    { role: "user", content: [] },
    { role: "assistant", model: "claude-sonnet-4-6", responseId: "r1", usage: { input: 500, output: 25, cacheRead: 0, cacheWrite: 0 } },
  ] }) + "\n";

function seedTask(taskId: string): void {
  insertRun({ id: `run-${taskId}`, workflow: "invoke", title: taskId, status: "active", createdAt: "2026-06-06T00:00:00Z" });
  insertTask({
    id: taskId, runId: `run-${taskId}`, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId, runId: `run-${taskId}`, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-06T00:00:00Z",
  });
}

function writeRunLog(runsDir: string, taskId: string, withManifest: boolean): void {
  const dir = join(runsDir, `run-${taskId}`, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "container.stdout.log"), PI_STREAM);
  if (withManifest) {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      runtime: { name: "pi-apikey", kind: "pi", logFormat: "pi-jsonl", promptStrategy: "message-arg", authStrategy: "env-provider-api-key" },
    }));
  }
}

function withDb(fn: (db: DatabaseInstance, runsDir: string) => void): void {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  const runsDir = mkdtempSync(join(tmpdir(), "forge-bf-runs-"));
  try { fn(db, runsDir); }
  finally { if (prev) setDbForTest(prev); rmSync(runsDir, { recursive: true, force: true }); }
}

test("#262 backfill: dry-run counts a pi log via the manifest log_format", () => {
  withDb((_db, runsDir) => {
    seedTask("task-bf-dry");
    writeRunLog(runsDir, "task-bf-dry", true);
    const s = performBackfill(runsDir, { dryRun: true });
    assert.equal(s.scanned, 1);
    assert.equal(s.withData, 1, "pi log parsed via the manifest's pi-jsonl, not the claude default");
    assert.equal(s.totalRows, 1);
  });
});

test("#262 backfill: non-dry-run inserts the pi usage row through the write path", () => {
  withDb((db, runsDir) => {
    seedTask("task-bf-write");
    writeRunLog(runsDir, "task-bf-write", true);
    const s = performBackfill(runsDir, {});
    assert.equal(s.totalRows, 1);
    const row = db.prepare("SELECT input_tokens, output_tokens FROM model_calls WHERE task_id = ?").get("task-bf-write") as Record<string, unknown>;
    assert.equal(row.input_tokens, 500);
    assert.equal(row.output_tokens, 25);
  });
});

test("#262 backfill: a pi log WITHOUT a manifest falls back to claude and records nothing (manifest is load-bearing)", () => {
  withDb((_db, runsDir) => {
    seedTask("task-bf-nomani");
    writeRunLog(runsDir, "task-bf-nomani", false); // no manifest → no logFormat → claude default
    const s = performBackfill(runsDir, { dryRun: true });
    assert.equal(s.scanned, 1);
    assert.equal(s.withData, 0, "claude parser finds no usage in a pi stream — proves the manifest is what enables it");
  });
});
