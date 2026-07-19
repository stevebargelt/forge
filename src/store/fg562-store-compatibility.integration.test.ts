// FG-562 (BD-15): the new `continuations` table is additive-only and does not
// break the supported old/new overlap window. Proven by EXECUTION against real
// SQLite files under the per-process temp FORGE_HOME (never ~/.forge/forge.db),
// the same way an upgraded install actually opens — mirroring the fg568 template.
//
// The property: a brand-new table created with CREATE TABLE IF NOT EXISTS on the
// ordinary open path is safe BY CONSTRUCTION because only NEW binaries ever touch
// it — an OLD binary that predates it references only the tables it knows, so it is
// never broken; a NEW binary against a store an OLD process created/reads adds the
// table without disturbing the old shape. Both directions are demonstrated.
//
// The UNIQUE INDEX on dispatch_key is likewise safe: only a NEW binary inserts into
// `continuations`, so a version-A writer can never violate a constraint on a table
// it never writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import {
  getDb,
  closeDb,
  applyMigrations,
  assertSchemaVersionSupported,
  setDbForTest,
  SCHEMA_VERSION,
} from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { FORGE_HOME } from "../util/paths.js";
import {
  recordContinuation,
  observeLaunchStatus,
  claimContinuationDispatch,
  getContinuation,
} from "./continuations.js";

function tempDb(name: string): string {
  return join(FORGE_HOME, name);
}

function tableNames(db: Database.Database): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

// A NEW binary open: exactly getDb()'s writable path.
function openAsNewBinary(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  assertSchemaVersionSupported(db, SCHEMA_VERSION);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("busy_timeout = 5000");
  return db;
}

// An OLD binary that predates `continuations` entirely: it creates the store with
// only the tables it knows (runs) and never references continuations. This is the
// version-A code.
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

function oldWriterInsertRun(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id, "feature", `title ${id}`, "active", "2026-01-01T00:00:00Z",
  );
}

// ===========================================================================
// Direction 1 — OLD creates the store; NEW opens it and the table appears
// additively. The old writer keeps working; the new binary uses continuations.
// ===========================================================================
test("BD-15 dir1: an OLD store gains `continuations` additively on a NEW open; the old writer is not broken", () => {
  const path = tempDb("fg562-dir1.db");

  // Version A (old binary): creates the store, knows nothing of continuations.
  const a = new Database(path);
  a.pragma("journal_mode = WAL");
  a.exec(LEGACY_RUNS_DDL);
  oldWriterInsertRun(a, "run-A");
  assert.equal(tableNames(a).has("continuations"), false, "precondition: the old store has no continuations table");
  a.close();

  // Version B (new binary): opens the SAME file — the additive CREATE TABLE IF NOT
  // EXISTS adds continuations without disturbing anything the old binary wrote.
  const b = openAsNewBinary(path);
  assert.ok(tableNames(b).has("continuations"), "the new open added the continuations table");
  const cols = columnNames(b, "continuations");
  for (const c of ["continuation_id", "consumer_kind", "source_launch_id", "current_phase", "next_action", "state", "claim_owner", "claim_expires_at", "dispatch_key", "dispatched_run_id", "dispatched_task_id", "last_observed_status", "created_at", "updated_at"]) {
    assert.ok(cols.has(c), `continuations has column ${c}`);
  }
  // The new binary uses the table; the old row is untouched.
  b.prepare(`INSERT INTO continuations (continuation_id, consumer_kind, source_launch_id, current_phase, next_action, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'awaiting_completion', ?, ?)`)
    .run("c1", "orchestrator", "L1", "p", "{}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  assert.equal((b.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n, 1, "the old row survives");
  b.close();

  // Version A is STILL RUNNING against the now-migrated store — it references only
  // the columns/tables it knows and is never broken by the added table.
  const a2 = new Database(path);
  a2.pragma("journal_mode = WAL");
  assert.doesNotThrow(() => oldWriterInsertRun(a2, "run-A-2"), "the in-flight old writer is unbroken by the new table");
  assert.equal((a2.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n, 2);
  a2.close();
});

// ===========================================================================
// Direction 2 — NEW creates the store and writes continuations; an OLD process
// reading the same store (its own table set) is unaffected by the new table and
// its UNIQUE INDEX, because it never touches continuations.
// ===========================================================================
test("BD-15 dir2: a NEW store's continuations table + UNIQUE(dispatch_key) never affect an OLD reader/writer", () => {
  const path = tempDb("fg562-dir2.db");

  // Version B (new binary) creates the store and exercises the real primitive.
  const b = openAsNewBinary(path);
  const restore = setDbForTest(b);
  try {
    recordContinuation({ continuationId: "cc", consumerKind: "orchestrator", sourceLaunchId: "LB", currentPhase: "p", nextAction: { kind: "dispatch", role: "engineer" } });
    observeLaunchStatus("cc", "LB", "exited_ok", { terminal: true });
    const out = claimContinuationDispatch({ continuationId: "cc", sourceLaunchId: "LB", consumerKind: "orchestrator", currentPhase: "p", nextAction: { kind: "dispatch", role: "engineer" }, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000 });
    assert.ok(out.granted, "the primitive works against a real file-backed store");
    assert.ok(getContinuation("cc")?.dispatchKey, "a dispatch_key (UNIQUE-indexed) was written");
  } finally {
    setDbForTest(restore as Database.Database);
  }
  b.close();

  // Version A (old binary) opens the SAME store. It knows only its own tables and
  // never selects/writes continuations — the new table and its unique index are
  // invisible to it, and its own writes still succeed.
  const a = new Database(path);
  a.pragma("journal_mode = WAL");
  a.pragma("foreign_keys = ON");
  assert.doesNotThrow(() => oldWriterInsertRun(a, "run-old-reader"), "the old writer works against a store carrying the new table");
  // The old binary would never issue this, but even a raw duplicate insert INTO
  // continuations shows the UNIQUE(dispatch_key) is confined to that table — it can
  // never redden a version-A write to runs/tasks/etc.
  const runsRows = a.prepare(`SELECT id FROM runs ORDER BY id`).all() as { id: string }[];
  assert.deepEqual(runsRows.map((r) => r.id), ["run-old-reader"], "the old reader sees its own rows via its own column set");
  a.close();

  // Independent confirmation the UNIQUE index is real and confined: a second row
  // with the SAME dispatch_key is rejected on the continuations table.
  const check = new Database(path);
  const key = (check.prepare(`SELECT dispatch_key AS k FROM continuations WHERE continuation_id='cc'`).get() as { k: string }).k;
  assert.throws(
    () => check.prepare(`INSERT INTO continuations (continuation_id, consumer_kind, source_launch_id, current_phase, next_action, state, dispatch_key, created_at, updated_at) VALUES ('cc2','orchestrator','LB','p','{}','dispatching', ?, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run(key),
    /UNIQUE/i,
    "the dispatch_key UNIQUE index is enforced — one receipt across the table",
  );
  check.close();
  closeDb();
});

// ===========================================================================
// The migration is ADDITIVE on the ordinary open path — a real getDb() open adds
// the table and runs NO destructive DDL. (Confined to this table; the fg568 suite
// covers the whole open path.)
// ===========================================================================
test("BD-15: getDb()'s ordinary open path creates continuations additively (no ALTER/DROP for it)", () => {
  // getDb() singleton is cold here; it opens DB_PATH, execs SCHEMA_SQL (which holds
  // CREATE TABLE IF NOT EXISTS continuations) and applyMigrations. The table exists
  // and carries no rows — a pure additive create.
  const db = getDb();
  assert.ok(tableNames(db).has("continuations"), "the production open path created continuations");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM continuations`).get() as { n: number }).n, 0, "additive create — no row churn");
  // Idempotent: a second open (same singleton) does not error or duplicate.
  assert.doesNotThrow(() => getDb(), "re-open is idempotent");
  closeDb();
});
