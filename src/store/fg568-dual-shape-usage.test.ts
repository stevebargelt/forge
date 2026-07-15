// FG-568 corrective — DUAL-SHAPE usage insertion, proven by EXECUTION against real
// in-memory SQLite stores of each schema shape (never ~/.forge/forge.db).
//
// The additive-only open path deliberately leaves the 0.1.x legacy NOT NULL
// columns (prompt_tokens/completion_tokens/cost) in place on an unconverged store;
// only the explicit `forge store converge` drops them. A version-B usage writer
// must therefore capture usage on BOTH shapes. Before this corrective the writer
// emitted only the fresh column list, so a legacy-store insert threw — and because
// runNext/invoke DISCARD captureUsageForTask's returned error and the orchestrator
// capture path swallows it, that was a SILENT usage-loss bug on real migrated
// stores, not a cosmetic one.
//
// The seven operator-specified evidence items, each a real executed test:
//   1  fresh schema                              → insert SUCCEEDS
//   2  unconverged 0.1.x (all 3 legacy cols)     → insert SUCCEEDS, fills 0/0/0
//   3  old reader/writer stay compatible         → after the new writer inserts
//   4  after runDestructiveConvergenceMigration  → insert STILL succeeds (fresh)
//   5  MUTANT always-current-columns             → RED on the legacy schema
//   6  MUTANT always-include-legacy              → RED on the fresh schema
//   7  partial legacy shape (subset)             → NAMED ACTIONABLE failure (throw)
//
// Read-only clarification (intent, stated here so it is unmistakable): an ordinary
// open — including a logically read-only caller — MAY perform backward-compatible
// ADDITIVE evolution; what "fixes read-only-open-still-migrates" means is that the
// DESTRUCTIVE DDL is gone from ordinary opens, NOT that they perform no schema
// maintenance at all. These insert-path tests exercise the additive/dual-shape
// side of that guarantee; the destructive-DDL-absence side lives in the FG-568
// integration test (E3/E5).

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, runDestructiveConvergenceMigration } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { insertUsageRows, type UsageRow } from "./model-calls.js";

// A store whose model_calls carries the 0.1.x legacy NOT NULL columns alongside
// the current ones — exactly a 0.1.x-migrated store that has NOT been converged.
// CREATE allows NOT NULL-without-default (an ALTER ADD would not), matching the
// real 0.1.x CREATE.
const LEGACY_MODEL_CALLS_DDL = `CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
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
)`;

function legacyShapeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("DROP TABLE model_calls");
  db.exec(LEGACY_MODEL_CALLS_DDL);
  return db;
}

const usageRow = (requestId: string): UsageRow => ({
  taskId: null, // null avoids the task_id FK so these tests isolate the insert-shape logic
  requestId,
  model: "claude-sonnet-4-6",
  alias: "default",
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 20,
  cacheCreationTokens: 5,
  createdAt: "2026-06-05T00:00:01Z",
});

function withDb<T>(db: Database.Database, fn: () => T): T {
  const prev = setDbForTest(db);
  try {
    return fn();
  } finally {
    if (prev) setDbForTest(prev);
  }
}

// ---------------------------------------------------------------------------
// 1 — fresh schema: insertion SUCCEEDS.
// ---------------------------------------------------------------------------
test("E1(dual-shape): fresh schema — usage insertion succeeds", () => {
  const db = makeInMemoryDb(); // SCHEMA_SQL + applyMigrations — no legacy columns
  withDb(db, () => {
    assert.equal(insertUsageRows([usageRow("req_fresh")]), 1, "insert must not throw on the fresh schema");
    const row = db.prepare("SELECT input_tokens, output_tokens FROM model_calls WHERE request_id = ?").get("req_fresh") as {
      input_tokens: number;
      output_tokens: number;
    };
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 40);
  });
});

// ---------------------------------------------------------------------------
// 2 — unconverged 0.1.x schema (all 3 legacy cols): insertion SUCCEEDS and fills
//     the legacy placeholders 0,0,0.
// ---------------------------------------------------------------------------
test("E2(dual-shape): unconverged 0.1.x schema — insertion succeeds and fills legacy placeholders 0,0,0", () => {
  const db = legacyShapeDb();
  withDb(db, () => {
    assert.equal(insertUsageRows([usageRow("req_legacy")]), 1, "dual-shape writer succeeds on the unconverged legacy shape");
    const row = db
      .prepare("SELECT prompt_tokens, completion_tokens, cost, input_tokens, output_tokens FROM model_calls WHERE request_id = ?")
      .get("req_legacy") as { prompt_tokens: number; completion_tokens: number; cost: number; input_tokens: number; output_tokens: number };
    assert.equal(row.prompt_tokens, 0, "legacy prompt_tokens filled with the 0 placeholder");
    assert.equal(row.completion_tokens, 0, "legacy completion_tokens filled with the 0 placeholder");
    assert.equal(row.cost, 0, "legacy cost filled with the 0 placeholder");
    assert.equal(row.input_tokens, 100, "the real counts still land in the current columns");
    assert.equal(row.output_tokens, 40);
  });
});

// ---------------------------------------------------------------------------
// 3 — an OLD reader/writer stays compatible AFTER the new writer inserts: the
//     legacy NOT NULL columns still satisfy an old writer's own inserts, and an
//     old reader (reading the legacy column set) still reads every row.
// ---------------------------------------------------------------------------
test("E3(dual-shape): after the new writer inserts, an old writer still writes and an old reader still reads", () => {
  const db = legacyShapeDb();

  // New (version-B) writer inserts through the dual-shape path.
  withDb(db, () => {
    assert.equal(insertUsageRows([usageRow("req_new")]), 1);
  });

  // An OLD (version-A) writer knows the legacy NOT NULL columns and supplies them
  // itself — the new writer's presence did not break its insert.
  assert.doesNotThrow(
    () =>
      db
        .prepare(
          `INSERT INTO model_calls (task_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, prompt_tokens, completion_tokens, cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(null, "req_old", "claude-opus-4-7", 7, 3, 1, 0, "2026-06-05T00:00:02Z", 7, 3, 0.0),
    "an old writer's own legacy-shape insert still satisfies the NOT NULL columns",
  );

  // An OLD reader selects only the columns it knows (legacy set) and sees BOTH rows,
  // including the one the new writer wrote with the 0/0/0 placeholders.
  const rows = db
    .prepare("SELECT request_id, prompt_tokens, completion_tokens, cost FROM model_calls ORDER BY request_id")
    .all() as Array<{ request_id: string; prompt_tokens: number; completion_tokens: number; cost: number }>;
  assert.deepEqual(rows.map((r) => r.request_id), ["req_new", "req_old"], "the old reader sees every row via its legacy column set");
  assert.equal(rows[0]!.prompt_tokens, 0, "the new writer's row reads back the 0 placeholder to the old reader");
  db.close();
});

// ---------------------------------------------------------------------------
// 4 — after explicit runDestructiveConvergenceMigration, current insertion STILL
//     succeeds (now the fresh shape).
// ---------------------------------------------------------------------------
test("E4(dual-shape): after explicit convergence, insertion still succeeds against the converged (fresh) shape", () => {
  const db = legacyShapeDb();
  // Quiesce is a no-op on a private :memory: store (no peers), so the migration converges.
  const { dropped } = runDestructiveConvergenceMigration(db);
  assert.deepEqual(dropped.sort(), ["completion_tokens", "cost", "prompt_tokens"], "convergence drops the legacy columns");
  const cols = new Set((db.prepare("PRAGMA table_info(model_calls)").all() as { name: string }[]).map((c) => c.name));
  assert.ok(!cols.has("prompt_tokens") && !cols.has("completion_tokens") && !cols.has("cost"), "converged to the fresh shape");

  withDb(db, () => {
    assert.equal(insertUsageRows([usageRow("req_post_converge")]), 1, "insertion still succeeds after convergence");
  });
});

// ---------------------------------------------------------------------------
// 5 — MUTANT: a writer that ALWAYS uses only the current columns (the pre-corrective
//     behavior / a "delete the legacy branch" mutant) goes RED on the legacy schema.
//     This proves the legacy branch of the real code is load-bearing, not decorative.
// ---------------------------------------------------------------------------
test("E5(mutant): always-current-columns writer is RED on the legacy schema — proves the legacy branch is real", () => {
  const db = legacyShapeDb();
  const r = usageRow("req_mutant_fresh_only");

  // The mutant: the fresh-only INSERT the real code uses ONLY on a fresh store,
  // applied unconditionally. On the legacy schema the NOT NULL legacy columns have
  // no value and no default → the insert throws. (The real dual-shape code takes
  // the legacy branch here instead and succeeds — item 2.)
  const mutantFreshOnly = () =>
    db
      .prepare(
        `INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.taskId, r.requestId, r.model, r.alias, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.createdAt);

  assert.throws(mutantFreshOnly, /NOT NULL|constraint/i, "the always-current-columns mutant fails on the legacy schema");
  db.close();
});

// ---------------------------------------------------------------------------
// 6 — MUTANT: a writer that ALWAYS includes the legacy columns (a "delete the fresh
//     branch" mutant) goes RED on the fresh schema. Proves the fresh branch is real.
// ---------------------------------------------------------------------------
test("E6(mutant): always-include-legacy writer is RED on the fresh schema — proves the fresh branch is real", () => {
  const db = makeInMemoryDb(); // fresh schema — the legacy columns do not exist
  const r = usageRow("req_mutant_legacy_only");

  // The mutant: the legacy-shape INSERT applied unconditionally. On the fresh schema
  // prompt_tokens/completion_tokens/cost do not exist → the insert throws.
  const mutantLegacyAlways = () =>
    db
      .prepare(
        `INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, prompt_tokens, completion_tokens, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
      )
      .run(r.taskId, r.requestId, r.model, r.alias, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.createdAt);

  assert.throws(mutantLegacyAlways, /no column named|has no column/i, "the always-include-legacy mutant fails on the fresh schema");
  db.close();
});

// ---------------------------------------------------------------------------
// 7 — a PARTIAL legacy shape (a subset of the legacy columns — an inconsistent /
//     corrupt schema no real migration produces) fails with a NAMED, ACTIONABLE
//     error, NOT a silent {rowCount:0}.
// ---------------------------------------------------------------------------
test("E7(dual-shape): a partial legacy shape fails with a named, actionable error — never a silent no-op", () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("DROP TABLE model_calls");
  // Only prompt_tokens present — completion_tokens and cost missing. Inconsistent.
  db.exec(`CREATE TABLE model_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    request_id TEXT NOT NULL,
    model TEXT NOT NULL,
    alias TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL
  )`);

  withDb(db, () => {
    let threw: Error | undefined;
    try {
      insertUsageRows([usageRow("req_partial")]);
    } catch (e) {
      threw = e as Error;
    }
    assert.ok(threw, "a subset legacy shape must THROW, not return {rowCount:0} with no signal");
    assert.match(threw!.message, /inconsistent/i, "the error names the inconsistency");
    assert.match(threw!.message, /prompt_tokens/, "the error names the column present");
    assert.match(threw!.message, /completion_tokens/, "the error names a missing column");
    assert.match(threw!.message, /cost/, "the error names a missing column");
    assert.match(threw!.message, /forge store converge/, "the error points at the actionable converge command");
    // Nothing was inserted — the refusal is loud, not a partial write.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM model_calls").get() as { n: number }).n, 0);
  });
  db.close();
});
