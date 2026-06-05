// #295: usage capture must work on a FRESH schema, and a 0.1.x-migrated DB must
// converge to that same shape. The bug: insertUsageRows wrote the legacy
// prompt_tokens/completion_tokens/cost columns, which a fresh SCHEMA_SQL doesn't
// create — so every insert threw (silently swallowed) on a brand-new install.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, applyMigrations } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { insertUsageRows } from "./model-calls.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";

function seedTask(taskId: string): void {
  insertRun({ id: `run-${taskId}`, workflow: "invoke", title: taskId, status: "active", createdAt: "2026-06-05T00:00:00Z" });
  insertTask({
    id: taskId, runId: `run-${taskId}`, phase: "engineer", agentRole: "engineer", status: "running",
    taskPackage: { taskId, runId: `run-${taskId}`, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-05T00:00:00Z",
  });
}

const usageRow = (taskId: string) => ({
  taskId, requestId: "req_A", model: "claude-sonnet-4-6", alias: "default",
  inputTokens: 100, outputTokens: 40, cacheReadTokens: 20, cacheCreationTokens: 0,
  createdAt: "2026-06-05T00:00:01Z",
});

test("#295: usage capture works on a FRESH schema (no 0.1.x migration history)", () => {
  const db = makeInMemoryDb(); // SCHEMA_SQL + applyMigrations, no legacy columns
  const prev = setDbForTest(db);
  try {
    seedTask("t-fresh");
    assert.equal(insertUsageRows([usageRow("t-fresh")]), 1, "insert must not throw on a fresh schema");
    const row = db.prepare("SELECT input_tokens, output_tokens FROM model_calls WHERE task_id = ?").get("t-fresh") as { input_tokens: number; output_tokens: number };
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 40);
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("#295: applyMigrations drops the legacy columns on a 0.1.x-migrated-shaped DB, and insert then works", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  // Re-shape model_calls to the post-#155-migrated state: the legacy NOT NULL
  // columns (no DEFAULT — exactly the 0.1.x CREATE) still present alongside the
  // new ones. CREATE allows NOT NULL-without-default; ALTER ADD would not.
  db.exec("DROP TABLE model_calls");
  db.exec(`CREATE TABLE model_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id),
    request_id TEXT NOT NULL,
    model TEXT NOT NULL,
    alias TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost REAL NOT NULL
  )`);

  applyMigrations(db);

  const cols = new Set((db.prepare("PRAGMA table_info(model_calls)").all() as { name: string }[]).map((r) => r.name));
  assert.ok(!cols.has("prompt_tokens"), "prompt_tokens dropped");
  assert.ok(!cols.has("completion_tokens"), "completion_tokens dropped");
  assert.ok(!cols.has("cost"), "cost dropped");
  assert.ok(cols.has("input_tokens"), "new columns retained");

  // The real assertion: an insert omitting the (now-gone) legacy columns succeeds.
  const prev = setDbForTest(db);
  try {
    seedTask("t-migrated");
    assert.equal(insertUsageRows([usageRow("t-migrated")]), 1, "insert works after legacy columns dropped");
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("#295: applyMigrations is idempotent on the drop (second run is a no-op)", () => {
  const db = makeInMemoryDb(); // already has no legacy columns
  assert.doesNotThrow(() => applyMigrations(db), "re-running migrations must not throw when legacy columns are already absent");
});
