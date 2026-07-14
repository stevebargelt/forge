// FG-568 (FG-553 Child 1 / BD-15) — store-compatibility policy, proven by
// EXECUTION against real SQLite files (never ~/.forge/forge.db — every DB here
// lives under the per-process temp FORGE_HOME the harness installs, src/test-setup.ts).
//
// Per the FG-551 rule: a property about the store's RUNTIME behavior is
// demonstrated by RUNNING the real store code against a real DB, never by
// asserting on source patterns. "Two Forge versions" is simulated by running the
// real store code at two schema states against one temp DB (an "old" schema/insert
// path vs the "new" migrated one) — real separate DB opens, not mocks.
//
// The seven load-bearing evidence items (operator-specified), each a real test:
//   E1  two versions against one real SQLite file (F35 two-process shape)
//   E2  BOTH directions: old-writer/new-reader AND new-writer/old-reader
//   E3  a logically read-only command's first open reproduces migration-on-open,
//       and the fix makes it additive/safe
//   E4  an incompatible additive mutation goes RED (breaks an old writer)
//   E5  destructive DDL is absent from EVERY ordinary open path (getDb / getDb ro)
//   E6  the destructive migration is a recorded one-way rollback boundary
//   E7  the forward schema-version gate refuses a newer-than-understood store —
//       AND cannot constrain already-installed old binaries

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  getDb,
  applyMigrations,
  assertSchemaVersionSupported,
  runDestructiveConvergenceMigration,
  SCHEMA_VERSION,
  DESTRUCTIVE_BOUNDARY_VERSION,
} from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { DB_PATH, FORGE_HOME } from "../util/paths.js";

// ---------------------------------------------------------------------------
// Helpers — every one runs REAL store code (SCHEMA_SQL + the exported migration
// functions) against a real file, the way an upgraded install actually opens.
// ---------------------------------------------------------------------------

function tempDb(name: string): string {
  return join(FORGE_HOME, name);
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// A "NEW binary" open: exactly getDb()'s writable path — forward gate, SCHEMA_SQL,
// additive migrations. `understoodVersion` stands in for an older-schema binary.
function openAsNewBinary(path: string, understoodVersion: number = SCHEMA_VERSION): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  assertSchemaVersionSupported(db, understoodVersion);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("busy_timeout = 5000");
  return db;
}

// An "OLD binary" that predates project_dir on runs — it creates the store, and
// only ever references the pre-migration column set. This is the version-A code.
const LEGACY_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  workflow     TEXT NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  metadata     TEXT
);
`;

function oldWriterInsertRun(db: Database.Database, id: string, workflow = "feature"): void {
  // Old code knows nothing of project_dir — it inserts only the columns it has.
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    workflow,
    `title ${id}`,
    "active",
    "2026-01-01T00:00:00Z",
  );
}

function oldReaderRuns(db: Database.Database): Array<{ id: string; workflow: string; status: string }> {
  // Old code selects only the columns it knows — never project_dir.
  return db.prepare(`SELECT id, workflow, status FROM runs ORDER BY created_at`).all() as Array<{
    id: string;
    workflow: string;
    status: string;
  }>;
}

// ===========================================================================
// E1 + E2 — two versions on ONE real store, BOTH compatibility directions.
// ===========================================================================
test("E1/E2: old-writer/new-reader AND new-writer/old-reader both hold across one real store", () => {
  const path = tempDb("e1-two-version.db");

  // --- Version A (old binary) creates the store and writes an old-shape row. ---
  const a = new Database(path);
  a.pragma("journal_mode = WAL");
  a.exec(LEGACY_RUNS_DDL);
  assert.equal(columnNames(a, "runs").has("project_dir"), false, "precondition: version-A store has no project_dir");
  oldWriterInsertRun(a, "run-A-old");
  a.close();

  // --- Version B (new binary) opens the SAME file — additive migration adds project_dir. ---
  const b = openAsNewBinary(path);
  assert.ok(columnNames(b, "runs").has("project_dir"), "B's additive migration added project_dir to the shared store");

  // Direction 1 — OLD-WRITER / NEW-READER: B reads the row A wrote in the old shape.
  const seenByB = b.prepare(`SELECT id, project_dir FROM runs WHERE id = ?`).get("run-A-old") as {
    id: string;
    project_dir: string | null;
  };
  assert.equal(seenByB.id, "run-A-old", "new reader tolerates the old-written row");
  assert.equal(seenByB.project_dir, null, "the migrated column reads back null for A's pre-migration row — no data invented");

  // B (new writer) writes a row USING the new additive column.
  b.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "run-B-new",
    "feature",
    "written by B",
    "active",
    "2026-02-02T00:00:00Z",
    "/proj/b",
  );
  b.close();

  // --- Version A is STILL RUNNING (old code) against the now-migrated store. ---
  const a2 = new Database(path);
  a2.pragma("journal_mode = WAL");

  // Direction 2 — NEW-WRITER / OLD-READER: A keeps writing old-shape rows AND
  // reads B's new-shape row through its old column set — both must tolerate.
  assert.doesNotThrow(
    () => oldWriterInsertRun(a2, "run-A-old-2"),
    "an in-flight old writer is NOT broken by B's additive migration (new column is nullable)",
  );
  const rowsByA = oldReaderRuns(a2);
  assert.deepEqual(
    rowsByA.map((r) => r.id).sort(),
    ["run-A-old", "run-A-old-2", "run-B-new"].sort(),
    "the old reader sees every row, including B's new-shape one, via its old column set",
  );
  a2.close();
});

// ===========================================================================
// E4 — an incompatible additive mutation goes RED (breaks an old writer).
// This is the mutation-test proving additive-only is load-bearing, not decorative:
// a change that is additive-in-form but incompatible (a UNIQUE/CHECK an in-flight
// version-A writer can't satisfy — BD-15 correction #5) breaks A WITHOUT any DROP.
// ===========================================================================
test("E4: an incompatible additive change (a new UNIQUE a version-A writer can't satisfy) reddens an old writer", () => {
  const path = tempDb("e4-incompatible-additive.db");
  const db = openAsNewBinary(path);

  // Version A's real behavior: it writes multiple runs with the same workflow.
  oldWriterInsertRun(db, "r1", "feature");
  oldWriterInsertRun(db, "r2", "feature");

  // MUTANT — a would-be "new binary" adds a UNIQUE constraint the old writer's
  // stream of inserts cannot satisfy. Additive in form; breaking in effect.
  db.exec(`DELETE FROM runs`);
  db.exec(`CREATE UNIQUE INDEX mutant_unique_workflow ON runs(workflow)`);

  oldWriterInsertRun(db, "r3", "feature");
  assert.throws(
    () => oldWriterInsertRun(db, "r4", "feature"),
    /UNIQUE/i,
    "the incompatible additive change breaks the in-flight old writer — exactly the red additive-only forbids",
  );
  db.close();
});

// ===========================================================================
// E6 — the destructive convergence migration is a recorded ONE-WAY boundary,
// and it is QUIESCE-gated.
// ===========================================================================
test("E6: the destructive migration is quiesce-gated, converges the legacy shape, and stamps a one-way boundary", () => {
  const path = tempDb("e6-boundary.db");

  // Build a real store that still carries the 0.1.x legacy model_calls columns.
  const setup = new Database(path);
  setup.pragma("journal_mode = WAL");
  setup.exec(SCHEMA_SQL);
  setup.exec(`DROP TABLE model_calls`);
  setup.exec(`CREATE TABLE model_calls (
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
  )`);
  setup.close();

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "precondition: pre-boundary store is user_version 0");

  // --- QUIESCE: a peer actively holding the store's write lock blocks the migration. ---
  const peer = new Database(path);
  peer.pragma("busy_timeout = 0");
  peer.exec("BEGIN IMMEDIATE"); // a version-A peer is using the store
  assert.throws(
    () => runDestructiveConvergenceMigration(db),
    /quiesce/i,
    "the destructive migration refuses while another process holds the store",
  );
  // The refusal is total — nothing was dropped or stamped.
  assert.ok(columnNames(db, "model_calls").has("prompt_tokens"), "a refused migration drops nothing");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "a refused migration stamps no boundary");
  peer.exec("ROLLBACK");
  peer.close();

  // --- Quiescent: the migration converges the shape and stamps the boundary. ---
  const { dropped, boundaryVersion } = runDestructiveConvergenceMigration(db);
  assert.deepEqual(dropped.sort(), ["completion_tokens", "cost", "prompt_tokens"], "the legacy columns are dropped");
  assert.equal(boundaryVersion, DESTRUCTIVE_BOUNDARY_VERSION);
  const cols = columnNames(db, "model_calls");
  assert.ok(!cols.has("prompt_tokens") && !cols.has("completion_tokens") && !cols.has("cost"), "converged to the fresh shape");
  assert.equal(db.pragma("user_version", { simple: true }), DESTRUCTIVE_BOUNDARY_VERSION, "the one-way boundary is recorded");
  db.close();

  // --- ONE-WAY: an older-schema-version process now refuses the store. ---
  const postBoundary = new Database(path);
  assert.throws(
    () => assertSchemaVersionSupported(postBoundary, DESTRUCTIVE_BOUNDARY_VERSION - 1),
    /newer than this binary understands/i,
    "after the boundary, an older-schema-version process refuses the store — rollback cannot cross it silently",
  );
  // The binary that ran the migration still opens it (it understands the boundary).
  assert.doesNotThrow(() => assertSchemaVersionSupported(postBoundary, DESTRUCTIVE_BOUNDARY_VERSION));
  postBoundary.close();
});

// ===========================================================================
// E7 — the forward schema-version gate refuses a newer-than-understood store,
// AND (honest limit) cannot constrain an already-installed old binary.
// ===========================================================================
test("E7: the forward gate refuses a future store — but is powerless over an already-installed old binary", () => {
  const path = tempDb("e7-forward-gate.db");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);

  // A same-or-older-version store opens fine.
  assert.doesNotThrow(() => assertSchemaVersionSupported(db), "a current store (user_version 0) opens");

  // A NEWER forge migrated this store past a boundary THIS binary doesn't know.
  db.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
  assert.throws(
    () => assertSchemaVersionSupported(db),
    /newer than this binary understands/i,
    "the forward gate refuses a store newer than we understand",
  );
  // Through the full production open path the same refusal holds (openAsNewBinary
  // is getDb()'s writable path) — the gate runs BEFORE any schema is touched.
  db.close();
  assert.throws(() => openAsNewBinary(path), /newer than this binary understands/i, "getDb()'s open path refuses the future store");

  // HONEST LIMIT — this gate constrains only FUTURE binaries. An already-installed
  // OLD binary predates the gate and never performs the check, so it still opens
  // (and could still corrupt) the future store. Demonstrated: a gate-LESS open —
  // the deployed old binary's behavior — succeeds against the very store the gate
  // refuses. This is exactly why the ordinary open path must ALSO be additive-only.
  const oldBinary = new Database(path); // no assertSchemaVersionSupported call at all
  assert.doesNotThrow(
    () => oldBinary.exec(SCHEMA_SQL),
    "a pre-gate old binary opens the future store regardless — the gate cannot reach back to constrain it",
  );
  oldBinary.close();
});

// ===========================================================================
// E3 + E5 — the REAL getDb() path: a logically read-only command's first open
// reproduces migration-on-open (the db.ts:169 defect), and that open runs NO
// destructive DDL (additive-only, on EVERY ordinary open path).
//
// This is the one test that drives the production getDb() singleton, so it owns
// DB_PATH for this file's process. It builds the store at DB_PATH first, then the
// FIRST getDb() call is a READ-ONLY one — reproducing today's behavior where a
// read-only caller bootstraps a writable handle and migrates.
// ===========================================================================
before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  const legacy = new Database(DB_PATH);
  legacy.pragma("journal_mode = WAL");
  // runs WITHOUT project_dir — so applyMigrations must ADD it (migration-on-open).
  legacy.exec(LEGACY_RUNS_DDL);
  // model_calls WITH the 0.1.x legacy NOT NULL columns — the destructive-DROP
  // candidates. If the ordinary open path drops them, E5 fails.
  legacy.exec(`CREATE TABLE model_calls (
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
  )`);
  oldWriterInsertRun(legacy, "run-legacy-1");
  legacy
    .prepare(
      `INSERT INTO model_calls (request_id, model, input_tokens, output_tokens, created_at, prompt_tokens, completion_tokens, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("req_legacy", "claude-opus-4-7", 10, 5, "2026-01-01T00:00:00Z", 10, 5, 0.0);
  legacy.close();
});

test("E3/E5: a read-only FIRST open still migrates (defect reproduced) — additively, running NO destructive DDL", () => {
  // The FIRST production open in this process is logically read-only. getDb bootstraps
  // a writable handle (db.ts:169) and runs SCHEMA_SQL + applyMigrations — the defect.
  const ro = getDb({ readOnly: true });

  // E3 — migration-on-open reproduced: the additive ALTER that adds project_dir ran
  // even though the caller only wanted to read.
  assert.ok(columnNames(ro, "runs").has("project_dir"), "migration-on-open reproduced: the read-only first open added project_dir");

  // E5 — but it was ADDITIVE-ONLY: the destructive-DROP candidates SURVIVE. No
  // DROP/RENAME ran on the ordinary open path (proven by their continued presence,
  // not by grepping the source — FG-551).
  const mcCols = columnNames(ro, "model_calls");
  assert.ok(mcCols.has("prompt_tokens"), "no destructive DDL on open: prompt_tokens survives");
  assert.ok(mcCols.has("completion_tokens"), "no destructive DDL on open: completion_tokens survives");
  assert.ok(mcCols.has("cost"), "no destructive DDL on open: cost survives");

  // Data and boundary untouched by an ordinary open.
  assert.equal(countRows(ro, "runs"), 1, "no row churn on open");
  assert.equal(countRows(ro, "model_calls"), 1, "no row churn on open");
  assert.equal(ro.pragma("user_version", { simple: true }), 0, "an ordinary open never stamps the one-way boundary");

  // The writable handle getDb bootstrapped points at the same file — assert the
  // SAME survival there, covering the writable ordinary open path too.
  const rw = getDb();
  const rwCols = columnNames(rw, "model_calls");
  assert.ok(
    rwCols.has("prompt_tokens") && rwCols.has("completion_tokens") && rwCols.has("cost"),
    "the writable getDb() open path is likewise additive-only — legacy columns survive",
  );
});
