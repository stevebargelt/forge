// FG-608 (reopen) — the fresh-vs-migrated schema parity guard.
//
// THE FAILURE THIS EXISTS TO PREVENT. `forge backlog migrate` died on the dogfood
// host with "table tickets has no column named imported_from". SCHEMA_SQL's CREATE
// named the column, so every fresh DB — every test, all of CI — had it. The host's
// `tickets` predated it, CREATE TABLE IF NOT EXISTS no-opped, no ALTER existed, and
// the column was silently absent on exactly the databases that matter. The whole
// suite was green while migrate could not run at all.
//
// The class is "a column in SCHEMA_SQL with no matching entry in ADDITIVE_COLUMNS",
// and no amount of care kills it — only a test that a fresh DB cannot satisfy
// vacuously. So this file never asks "does column X exist"; it builds the OLDEST
// shape SQLite will let a table have, migrates it, and demands PRAGMA table_info
// parity with a fresh DB for EVERY table.
//
// The oldest shape is derived from SQLite, not from parsing SCHEMA_SQL: create the
// fresh schema, then DROP COLUMN every column ADD COLUMN could put back (not part
// of the primary key; nullable or carrying a DEFAULT). A handful are structurally
// undroppable because an index references them — those are listed explicitly below
// so shrinking coverage has to be a deliberate edit, and they are covered instead by
// the list-completeness test, which reads the fresh shape directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL, ADDITIVE_COLUMNS } from "./schema.js";
import { applyMigrations } from "./db.js";

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

function tableNames(db: DatabaseInstance): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columns(db: DatabaseInstance, table: string): Col[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Col[];
}

// The shape a column has, ordinal-independent: a migrated column is appended at the
// end of the table, so cid order legitimately differs from a fresh DB's.
function shapeOf(db: DatabaseInstance, table: string): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const c of columns(db, table)) {
    shape[c.name] = `${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "NULL"} pk=${c.pk}`;
  }
  return shape;
}

// The CONSTRAINT shape: everything CREATE TABLE fixes for the life of a table and
// ALTER cannot change — PK membership and ordering, index/UNIQUE shape, foreign keys.
//
// Column parity alone cannot see this class. The synthetic "old" DB below is built by
// dropping columns from the CURRENT fresh schema, so it carries today's constraints by
// construction; the dogfood host's single-column-PK ticket_events (FG-608 reopen) was
// invisible here while it made `forge backlog migrate` impossible. Comparing shape for
// EVERY table is what stops a synthetic-current-schema fixture from hiding the next one.
//
// Each index carries its sqlite_master CREATE text as well as its PRAGMA fingerprint:
// index_info reports neither DESC nor COLLATE, so an index diverging only in sort order
// or collation is invisible to the PRAGMAs alone. Auto-indexes have no CREATE text.
function constraintsOf(db: DatabaseInstance, table: string): Record<string, string[]> {
  const pk = columns(db, table)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

  const indexes = (
    db.prepare(`PRAGMA index_list(${table})`).all() as {
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }[]
  )
    .map((i) => {
      const cols = (db.prepare(`PRAGMA index_info(${i.name})`).all() as { seqno: number; name: string | null }[])
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name ?? "<expr>");
      const sql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(i.name) as
          | { sql: string | null }
          | undefined
      )?.sql;
      const definition = (sql ?? "<auto>").replace(/\s+/g, " ").trim();
      return `${i.name} unique=${i.unique} origin=${i.origin} partial=${i.partial} (${cols.join(", ")}) [${definition}]`;
    })
    .sort();

  const foreignKeys = (
    db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
      on_update: string;
    }[]
  )
    .map((f) => `${f.from} -> ${f.table}(${f.to}) on_delete=${f.on_delete} on_update=${f.on_update}`)
    .sort();

  return { pk, indexes, foreignKeys };
}

// Can SQLite's ALTER TABLE ADD COLUMN put this column back? PK columns cannot be
// added, and NOT NULL without a DEFAULT cannot either.
function isRestorable(c: Col): boolean {
  return c.pk === 0 && (c.notnull === 0 || c.dflt_value !== null);
}

// Columns an index references, so SQLite refuses to DROP them. Not a waiver: the
// list-completeness test below covers them, and a DB missing one would already have
// died in SCHEMA_SQL's CREATE INDEX, before applyMigrations ever ran.
// FG-679 added launch_observations with indexes on run_id and project_dir, so both
// join this list. Deliberate, not a waiver: both carry ADDITIVE_COLUMNS entries, so
// the completeness test below still covers them.
// FG-655 RF-4 joins review_docs_dispatches.state for the same reason: the partial UNIQUE
// index that holds "at most one LIVE docs binding per review" names it in its WHERE
// clause, and it carries an ADDITIVE_COLUMNS entry.
const UNDROPPABLE = new Set([
  "events.run_id",
  "events.task_id",
  "continuations.dispatch_key",
  "launch_observations.run_id",
  "launch_observations.project_dir",
  "review_docs_dispatches.state",
]);

function freshDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

// A fresh DB stripped back to the oldest shape SQLite permits, then brought forward
// exactly as a real open would: SCHEMA_SQL (whose CREATEs no-op on the existing
// tables — the very reason the bug was invisible) followed by applyMigrations.
function oldestShapeThenMigrated(): { db: DatabaseInstance; stripped: string[]; refused: string[] } {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);

  const stripped: string[] = [];
  const refused: string[] = [];
  for (const table of tableNames(db)) {
    for (const col of columns(db, table)) {
      if (!isRestorable(col)) continue;
      try {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${col.name}`);
        stripped.push(`${table}.${col.name}`);
      } catch {
        refused.push(`${table}.${col.name}`);
      }
    }
  }

  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return { db, stripped, refused };
}

test("FG-608: every table an old DB carries migrates to full fresh-DB parity", () => {
  const fresh = freshDb();
  const { db: migrated, stripped, refused } = oldestShapeThenMigrated();

  // The guard must not be able to pass by stripping nothing.
  assert.ok(
    stripped.includes("tickets.imported_from"),
    "the strip must remove tickets.imported_from — the column whose missing migration broke migrate on the host",
  );
  assert.ok(stripped.length > 50, `expected a broad strip, got ${stripped.length} columns`);
  assert.deepEqual(
    refused.sort(),
    [...UNDROPPABLE].sort(),
    "the set of structurally undroppable columns changed — update UNDROPPABLE deliberately, don't let coverage shrink silently",
  );

  assert.deepEqual(tableNames(migrated), tableNames(fresh), "migrated and fresh must carry the same tables");

  for (const table of tableNames(fresh)) {
    assert.deepEqual(
      shapeOf(migrated, table),
      shapeOf(fresh, table),
      `${table}: a migrated DB diverges from a fresh one — add the missing column(s) to ADDITIVE_COLUMNS in schema.ts`,
    );
    assert.deepEqual(
      constraintsOf(migrated, table),
      constraintsOf(fresh, table),
      `${table}: the CONSTRAINT shape diverges from a fresh DB — a column migration cannot fix this, the table needs a rebuild (see rebuildTicketEventsIfDivergent in db.ts)`,
    );
  }
});

test("FG-608: ADDITIVE_COLUMNS names exactly the columns ADD COLUMN can restore", () => {
  const fresh = freshDb();

  const declared = new Set(ADDITIVE_COLUMNS.map((c) => `${c.table}.${c.column}`));
  assert.equal(declared.size, ADDITIVE_COLUMNS.length, "ADDITIVE_COLUMNS has a duplicate entry");

  const required = new Set<string>();
  for (const table of tableNames(fresh)) {
    for (const col of columns(fresh, table)) {
      if (isRestorable(col)) required.add(`${table}.${col.name}`);
    }
  }

  const missing = [...required].filter((k) => !declared.has(k)).sort();
  assert.deepEqual(missing, [], "SCHEMA_SQL columns with no migration — an old DB will never get these");

  const stale = [...declared].filter((k) => !required.has(k)).sort();
  assert.deepEqual(stale, [], "ADDITIVE_COLUMNS entries that no longer match a restorable SCHEMA_SQL column");

  // The DDL text must actually name the table and column it claims to add.
  for (const c of ADDITIVE_COLUMNS) {
    assert.match(c.ddl, new RegExp(`^ALTER TABLE ${c.table} ADD COLUMN ${c.column}\\b`), `bad DDL: ${c.ddl}`);
  }
});

test("FG-608: the host failure itself — an FG-606-shaped tickets table gains imported_from", () => {
  // The dogfood host's shape: imported_at present, imported_from and the FG-608
  // columns absent. Verbatim CREATE (no IF NOT EXISTS) so SCHEMA_SQL's later exec
  // hits the same no-op path production did.
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tickets (
      project_key   TEXT NOT NULL,
      ticket_id     TEXT NOT NULL,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('active', 'done', 'deferred')),
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      created       TEXT,
      closed        TEXT,
      closed_commit TEXT,
      epic          TEXT,
      frontmatter   TEXT,
      imported_at   TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_id)
    );
  `);
  assert.equal(
    columns(db, "tickets").some((c) => c.name === "imported_from"),
    false,
    "precondition: the legacy shape must lack imported_from, or this test proves nothing",
  );

  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  const have = new Set(columns(db, "tickets").map((c) => c.name));
  for (const col of ["imported_from", "revision", "body_hash", "import_basis_hash"]) {
    assert.ok(have.has(col), `${col} must be added to a pre-existing tickets table`);
  }

  // The exact statement that failed on the host: an import INSERT naming imported_from.
  db.prepare(
    `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at, imported_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("pk-host", "FG-608", "story", "active", "reopened", "body", "2026-07-29T00:00:00Z", "/home/steve/code/forge");
  const row = db.prepare(`SELECT imported_from, revision FROM tickets WHERE ticket_id = 'FG-608'`).get() as {
    imported_from: string;
    revision: number;
  };
  assert.equal(row.imported_from, "/home/steve/code/forge");
  assert.equal(row.revision, 1, "pre-FG-608 rows read back the DEFAULT revision");
});

test("FG-608: re-running applyMigrations on a migrated DB is a no-op", () => {
  const fresh = freshDb();
  const { db: migrated } = oldestShapeThenMigrated();

  applyMigrations(migrated);
  applyMigrations(migrated);

  for (const table of tableNames(fresh)) {
    assert.deepEqual(shapeOf(migrated, table), shapeOf(fresh, table), `${table}: re-migration must not change the shape`);
    assert.deepEqual(
      constraintsOf(migrated, table),
      constraintsOf(fresh, table),
      `${table}: re-migration must not change the constraint shape`,
    );
  }
  assert.equal(migrated.pragma("user_version", { simple: true }), 0, "additive migrations never bump user_version");
});
