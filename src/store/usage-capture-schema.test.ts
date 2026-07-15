// #295: usage capture must work on a FRESH schema, and a 0.1.x-migrated DB must
// converge to that same shape. The bug: insertUsageRows wrote the legacy
// prompt_tokens/completion_tokens/cost columns, which a fresh SCHEMA_SQL doesn't
// create — so every insert threw (silently swallowed) on a brand-new install.
//
// FG-568 (BD-15): the convergence DROP moved OFF the ordinary open path (it is
// destructive DDL that would break an in-flight old peer) into the explicit,
// quiesce-gated runDestructiveConvergenceMigration. So applyMigrations is now
// additive-only and leaves the legacy columns in place; converging them to the
// fresh shape is the explicit migration's job. These tests are updated to that
// split.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, applyMigrations, runDestructiveConvergenceMigration } from "./db.js";
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

test("#295/FG-568: applyMigrations LEAVES the legacy columns (additive-only); the explicit convergence migration drops them so insert works", () => {
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

  // FG-568: the ordinary open path is additive-only — it must NOT drop.
  const afterMigrate = new Set((db.prepare("PRAGMA table_info(model_calls)").all() as { name: string }[]).map((r) => r.name));
  assert.ok(afterMigrate.has("prompt_tokens"), "additive-only: prompt_tokens NOT dropped on the open path");
  assert.ok(afterMigrate.has("completion_tokens"), "additive-only: completion_tokens NOT dropped on the open path");
  assert.ok(afterMigrate.has("cost"), "additive-only: cost NOT dropped on the open path");

  // FG-568 corrective: the legacy NOT NULL columns survive, but the DUAL-SHAPE
  // writer now detects them and fills the 0/0/0 compatibility placeholders — so
  // the current insert SUCCEEDS on the unconverged shape instead of throwing.
  // (The pre-corrective behavior was a silent usage-loss bug; see model-calls.ts.)
  const prev = setDbForTest(db);
  try {
    seedTask("t-migrated");
    assert.equal(insertUsageRows([usageRow("t-migrated")]), 1, "dual-shape writer succeeds on the unconverged legacy shape");
    const legacyRow = db.prepare("SELECT prompt_tokens, completion_tokens, cost, input_tokens FROM model_calls WHERE task_id = ?").get("t-migrated") as { prompt_tokens: number; completion_tokens: number; cost: number; input_tokens: number };
    assert.equal(legacyRow.prompt_tokens, 0, "legacy prompt_tokens filled with the 0 placeholder");
    assert.equal(legacyRow.completion_tokens, 0, "legacy completion_tokens filled with the 0 placeholder");
    assert.equal(legacyRow.cost, 0, "legacy cost filled with the 0 placeholder");
    assert.equal(legacyRow.input_tokens, 100, "the real token counts still land in the current columns");

    // Now converge explicitly (quiesce is a no-op on :memory:), then it still works.
    const { dropped } = runDestructiveConvergenceMigration(db);
    assert.deepEqual(dropped.sort(), ["completion_tokens", "cost", "prompt_tokens"], "the explicit migration drops the legacy columns");
    const afterConverge = new Set((db.prepare("PRAGMA table_info(model_calls)").all() as { name: string }[]).map((r) => r.name));
    assert.ok(!afterConverge.has("prompt_tokens") && !afterConverge.has("completion_tokens") && !afterConverge.has("cost"), "legacy columns gone");
    assert.ok(afterConverge.has("input_tokens"), "new columns retained");
    assert.equal(insertUsageRows([usageRow("t-migrated")]), 1, "insert works after explicit convergence");
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("#295: applyMigrations is idempotent and additive-only (a fresh DB never has the legacy columns)", () => {
  const db = makeInMemoryDb(); // fresh schema — legacy columns never created
  assert.doesNotThrow(() => applyMigrations(db), "re-running migrations must not throw");
  const cols = new Set((db.prepare("PRAGMA table_info(model_calls)").all() as { name: string }[]).map((r) => r.name));
  assert.ok(!cols.has("prompt_tokens") && !cols.has("cost"), "fresh schema has no legacy columns to converge");
});
