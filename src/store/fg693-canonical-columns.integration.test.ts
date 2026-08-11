// FG-693 — the CANONICAL PROJECT-IDENTITY COLUMNS, proved against a store this binary
// did not create.
//
// FG-693 adds one column, `project_dir_canonical`, to each of the five tables keyed on a
// project directory: runs, campaigns, host_verifications, orchestrator_receipts and
// launch_observations. Every one of those tables ALREADY EXISTS on an operator's
// `~/.forge/forge.db`, so every one of the columns arrives by ALTER on a table whose
// CREATE TABLE IF NOT EXISTS no-ops. That is the exact shape in which a missing migration
// stays invisible: every test DB in this repo is built FRESH from SCHEMA_SQL, whose CREATE
// now names the column, so a column with no ADDITIVE_COLUMNS entry would be green across
// the entire suite and would fail only on the machine-wide store an operator has been
// using for months. That is the FG-608 defect ("table tickets has no column named
// imported_from"), and it is why this file hand-authors an aged fixture rather than
// asserting PRAGMAs over a fresh store — the same discipline as
// fg700-migration-aged-shape.test.ts and fg591-migration-aged-shape.test.ts.
//
// THE BLAST RADIUS, stated plainly, because it is what the assertions here are for.
// db.ts execs SCHEMA_SQL + applyMigrations on EVERY writable open, so this change reaches
// every forge process on the machine at its next DB open — migrated or not, for every
// project. That is only safe because the change is ADDITIVE ONLY: five ALTER TABLE ADD
// COLUMN statements and nothing else. No UPDATE, no backfill, no data-dependent pass, no
// column drop, no table rebuild. The tests below hold that to the ROWS, not just to the
// shape: every pre-existing row's `project_dir` must be byte-identical afterward (it is
// audit evidence and this migration must never rewrite it), and every pre-existing row's
// new canonical column must read back NULL (nothing proved its identity, and resolving a
// stored spelling at migration time would establish only that it resolves TODAY — never
// that it resolves to the tree the row was written against).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL, ADDITIVE_COLUMNS, CANONICAL_IDENTITY_INDEXES } from "./schema.js";
import { applyMigrations } from "./db.js";

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

/** The five tables FG-693 gives a canonical-identity column, and the as-written column
 *  each one already carried. */
const CANONICAL_TABLES = [
  { table: "runs", asWritten: "project_dir", key: "id" },
  { table: "campaigns", asWritten: "project_dir", key: "id" },
  { table: "host_verifications", asWritten: "project_dir", key: "id" },
  { table: "orchestrator_receipts", asWritten: "project_dir", key: "receipt_id" },
  { table: "launch_observations", asWritten: "project_dir", key: "launch_id" },
] as const;

const CANONICAL_COLUMN = "project_dir_canonical";

// Spellings that alias one tree. They are FIXTURE DATA here, never a mechanism: nothing
// in this file (or in schema.ts) inspects a path for `/private`, `/tmp` or `/var`. The
// point is only that a real aged store holds rows written under whatever the operator
// typed, and the migration must not touch any of them.
const AS_WRITTEN_A = "/private/var/folders/zz/forge-checkout";
const AS_WRITTEN_B = "/var/folders/zz/forge-checkout";
const AS_WRITTEN_C = "/repos/forge/";
const AGED_AT = "2026-08-01T09:00:00.000Z";

// The five tables EXACTLY as a PRE-FG-693 binary created them. Written out by hand rather
// than derived from today's CREATE: a fixture built by dropping columns off the fresh
// schema carries today's shape by construction, and the point is a store this binary did
// not create. Verbatim CREATEs (no IF NOT EXISTS) so SCHEMA_SQL's later exec hits the same
// no-op path production does — the only reason the FG-608 class of bug is invisible.
const AGED_SCHEMA_SQL = `
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  metadata        TEXT,
  project_dir     TEXT,
  review_mode     TEXT NOT NULL DEFAULT 'legacy_verdict'
);

CREATE TABLE campaigns (
  id                  TEXT PRIMARY KEY,
  status              TEXT NOT NULL,
  source_kind         TEXT NOT NULL,
  source_input        TEXT NOT NULL,
  mode                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  metadata            TEXT,
  plan_hash           TEXT,
  approved_by         TEXT,
  approved_at         TEXT,
  approval_rationale  TEXT,
  approved_plan_hash  TEXT,
  project_dir         TEXT
);

CREATE TABLE host_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  gate_name   TEXT NOT NULL,
  command     TEXT NOT NULL,
  exit_code   INTEGER NOT NULL,
  run_id      TEXT,
  recorded_at TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'host',
  ci_url      TEXT
);
CREATE INDEX idx_host_verifications_lookup
  ON host_verifications(ticket_id, project_dir, commit_sha, gate_name);

CREATE TABLE orchestrator_receipts (
  receipt_id          TEXT PRIMARY KEY,
  session_key         TEXT NOT NULL,
  state               TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  project_dir         TEXT NOT NULL,
  project_name        TEXT,
  resolved_profile    TEXT,
  runtime             TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT,
  auth_mode           TEXT,
  resolved_by         TEXT,
  adapter             TEXT NOT NULL,
  session_operation   TEXT NOT NULL,
  session_target      TEXT,
  provider_session_id TEXT,
  identity_strength   TEXT NOT NULL DEFAULT 'unknown',
  identity_basis      TEXT,
  carrier_generation  TEXT,
  carrier_path        TEXT,
  carrier_acceptance  TEXT NOT NULL DEFAULT 'unproven',
  carrier_evidence    TEXT,
  limitations         TEXT,
  task_id             TEXT,
  launcher_pid        INTEGER,
  launcher_identity   TEXT,
  started_at          TEXT,
  closed_at           TEXT,
  exit_code           INTEGER,
  exit_signal         TEXT,
  failure_reason      TEXT
);
CREATE INDEX idx_orchestrator_receipts_project
  ON orchestrator_receipts(project_dir, created_at);

CREATE TABLE launch_observations (
  launch_id        TEXT PRIMARY KEY,
  name             TEXT,
  command          TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  project_dir      TEXT,
  association_kind TEXT NOT NULL,
  run_id           TEXT,
  task_id          TEXT,
  ticket_id        TEXT,
  campaign_id      TEXT,
  item_id          TEXT,
  started_at       TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  state            TEXT NOT NULL,
  exit_code        INTEGER,
  signal           TEXT,
  purpose          TEXT,
  terminal         INTEGER NOT NULL
);
CREATE INDEX idx_launch_observations_project ON launch_observations(project_dir);
`;

/** An aged store with real pre-FG-693 rows in it, written the aged way — no canonical
 *  column to write. Deliberately spelled three different ways, including two macOS
 *  aliases of one tree and one trailing-separator spelling. */
function agedStore(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(AGED_SCHEMA_SQL);

  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, 'active', ?, ?)`,
  ).run("run-aged-a", "aged run under the private spelling", AGED_AT, AS_WRITTEN_A);
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, 'complete', ?, ?)`,
  ).run("run-aged-b", "aged run under the short spelling", AGED_AT, AS_WRITTEN_B);
  // A run with NO project dir at all — the column has always been nullable, and the
  // migration must leave that row exactly as unclaimed as it found it.
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'invoke', ?, 'complete', ?, NULL)`,
  ).run("run-aged-c", "aged run with no project dir", AGED_AT);

  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
     VALUES (?, 'active', 'tickets', 'FG-693', 'sequential', ?, ?, ?)`,
  ).run("campaign-aged-a", AGED_AT, AGED_AT, AS_WRITTEN_C);

  db.prepare(
    `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at)
     VALUES (?, ?, ?, 'npm run test:all', 'npm run test:all', 0, ?, ?)`,
  ).run("FG-693", AS_WRITTEN_A, "abc1234", "run-aged-a", AGED_AT);
  db.prepare(
    `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at)
     VALUES (?, ?, ?, 'npm run test:all', 'npm run test:all', 0, NULL, ?)`,
  ).run("FG-693", AS_WRITTEN_B, "abc1234", AGED_AT);

  db.prepare(
    `INSERT INTO orchestrator_receipts
       (receipt_id, session_key, state, created_at, updated_at, project_dir, runtime, provider, adapter, session_operation)
     VALUES (?, ?, 'running', ?, ?, ?, 'claude-code', 'anthropic', 'claude', 'new')`,
  ).run("receipt-aged-a", "session-aged-a", AGED_AT, AGED_AT, AS_WRITTEN_A);

  db.prepare(
    `INSERT INTO launch_observations
       (launch_id, name, command, cwd, project_dir, association_kind, run_id, started_at, observed_at, state, terminal)
     VALUES (?, 'worktree-tier', ?, ?, ?, 'explicit', 'run-aged-a', ?, ?, 'running', 0)`,
  ).run("launch-aged-a", JSON.stringify(["npm", "run", "test:all"]), AS_WRITTEN_A, AS_WRITTEN_A, AGED_AT, AGED_AT);

  return db;
}

/** The aged store opened exactly as a real writable open does. */
function agedThenMigrated(): DatabaseInstance {
  const db = agedStore();
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

function freshDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

function columns(db: DatabaseInstance, table: string): Col[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Col[];
}

function withDb<T>(make: () => DatabaseInstance, fn: (db: DatabaseInstance) => T): T {
  const db = make();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every row of every canonical-keyed table, keyed by primary key, as raw as SQLite will
 *  give it — the before/after comparison the "no row is touched" claim rests on. */
function rowSnapshot(db: DatabaseInstance): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const { table, key } of CANONICAL_TABLES) {
    snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all();
  }
  return snapshot;
}

describe("FG-693 — the canonical-identity columns reach an aged store, additively and without touching a row", () => {
  test("the fixture is genuinely aged: pre-open, NOT ONE of the five tables carries the canonical column", () => {
    // Guards the fixture itself. If this ever stops holding, the fixture has silently
    // become a fresh store and every assertion below proves nothing.
    withDb(agedStore, (db) => {
      for (const { table, asWritten } of CANONICAL_TABLES) {
        const names = columns(db, table).map((c) => c.name);
        assert.equal(
          names.includes(CANONICAL_COLUMN),
          false,
          `${table}: the aged shape must not already carry ${CANONICAL_COLUMN}`,
        );
        assert.ok(names.includes(asWritten), `${table}: the aged shape must carry the as-written ${asWritten}`);
      }
    });
  });

  test("the guarded ALTER adds the column to every table a pre-FG-693 binary created", () => {
    withDb(agedThenMigrated, (db) => {
      for (const { table } of CANONICAL_TABLES) {
        const col = columns(db, table).find((c) => c.name === CANONICAL_COLUMN);
        assert.ok(col, `${table}: CREATE TABLE IF NOT EXISTS no-ops over the aged table — only the ALTER can add this`);
        assert.equal(col.type, "TEXT", `${table}.${CANONICAL_COLUMN} must be TEXT`);
        assert.equal(
          col.notnull,
          0,
          `${table}.${CANONICAL_COLUMN} must be NULLABLE — a pre-FG-693 row's identity was never proven`,
        );
        assert.equal(
          col.dflt_value,
          null,
          `${table}.${CANONICAL_COLUMN} must be UNDEFAULTED — a default would mint proof that does not exist`,
        );
        assert.equal(col.pk, 0, `${table}.${CANONICAL_COLUMN} must not be part of the primary key`);
      }
    });
  });

  test("every pre-existing row reads the new column back as NULL — nothing is backfilled", () => {
    withDb(agedThenMigrated, (db) => {
      for (const { table, key } of CANONICAL_TABLES) {
        const rows = db.prepare(`SELECT ${key} AS k, ${CANONICAL_COLUMN} AS c FROM ${table} ORDER BY ${key}`).all() as {
          k: string | number;
          c: string | null;
        }[];
        assert.ok(rows.length > 0, `${table}: the fixture must carry rows, or this proves nothing`);
        for (const row of rows) {
          assert.equal(
            row.c,
            null,
            `${table} row ${row.k}: the migration adds a column, it never resolves a stored spelling into one. ` +
              `Resolving at migration time proves only that the spelling resolves TODAY — never that it resolves ` +
              `to the tree the row was written against.`,
          );
        }
      }
    });
  });

  test("the as-written project_dir is byte-identical after the migration — audit evidence is never rewritten", () => {
    const before = withDb(agedStore, (db) => rowSnapshot(db));
    withDb(agedThenMigrated, (db) => {
      const after = rowSnapshot(db);
      for (const { table, key } of CANONICAL_TABLES) {
        const beforeRows = before[table] as Record<string, unknown>[];
        const afterRows = after[table] as Record<string, unknown>[];
        assert.equal(afterRows.length, beforeRows.length, `${table}: the migration must not add or remove rows`);
        for (let i = 0; i < beforeRows.length; i++) {
          const beforeRow = beforeRows[i]!;
          const afterRow = afterRows[i]!;
          // Every column the aged row carried, compared verbatim. Not just project_dir:
          // an in-place UPDATE anywhere in this table would be just as much a rewrite of
          // audit evidence, and comparing the whole row is what catches one nobody
          // thought to look for.
          for (const [name, value] of Object.entries(beforeRow)) {
            assert.deepEqual(
              afterRow[name],
              value,
              `${table} row ${String(beforeRow[key])}: column ${name} was modified by the migration`,
            );
          }
        }
      }

      // And the specific bytes, named, so a failure reads as what it is.
      const dirs = db.prepare(`SELECT id, project_dir FROM runs ORDER BY id`).all() as {
        id: string;
        project_dir: string | null;
      }[];
      assert.deepEqual(dirs, [
        { id: "run-aged-a", project_dir: AS_WRITTEN_A },
        { id: "run-aged-b", project_dir: AS_WRITTEN_B },
        { id: "run-aged-c", project_dir: null },
      ]);
      assert.equal(
        (db.prepare(`SELECT project_dir FROM campaigns WHERE id = 'campaign-aged-a'`).get() as { project_dir: string })
          .project_dir,
        AS_WRITTEN_C,
        "the trailing separator the operator typed survives verbatim — presentation fidelity is preserved",
      );
    });
  });

  test("opening an aged store does not bump user_version — an older binary must still open it", () => {
    withDb(agedThenMigrated, (db) => {
      assert.equal(db.pragma("user_version", { simple: true }), 0);
    });
  });

  test("re-running the open path on an already-migrated aged store is a no-op", () => {
    withDb(agedThenMigrated, (db) => {
      const shape = (): string => JSON.stringify(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all());
      const rows = (): string => JSON.stringify(rowSnapshot(db));
      const shapeBefore = shape();
      const rowsBefore = rows();

      db.exec(SCHEMA_SQL);
      applyMigrations(db);
      db.exec(SCHEMA_SQL);
      applyMigrations(db);

      assert.equal(shape(), shapeBefore, "a second open must not change the schema");
      assert.equal(rows(), rowsBefore, "a second open must not change a row");
    });
  });

  test("a fresh store is born with the columns, and a migrated one matches it column for column", () => {
    withDb(freshDb, (fresh) => {
      withDb(agedThenMigrated, (migrated) => {
        for (const { table } of CANONICAL_TABLES) {
          const shapeOf = (db: DatabaseInstance): Record<string, string> =>
            Object.fromEntries(
              columns(db, table).map((c) => [
                c.name,
                `${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "NULL"} pk=${c.pk}`,
              ]),
            );
          assert.deepEqual(
            shapeOf(migrated),
            shapeOf(fresh),
            `${table}: a migrated store must reach full parity with a fresh one`,
          );
        }
      });
    });
  });

  test("a POST-migration write stores a proven identity, and it is readable beside the untouched as-written bytes", () => {
    withDb(agedThenMigrated, (db) => {
      db.prepare(
        `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, project_dir_canonical)
         VALUES (?, 'feature', ?, 'active', ?, ?, ?)`,
      ).run("run-new-a", "written after FG-693", AGED_AT, AS_WRITTEN_A, AS_WRITTEN_B);

      const row = db.prepare(`SELECT project_dir, project_dir_canonical FROM runs WHERE id = 'run-new-a'`).get() as {
        project_dir: string;
        project_dir_canonical: string | null;
      };
      assert.equal(row.project_dir, AS_WRITTEN_A, "the caller's bytes are kept verbatim");
      assert.equal(row.project_dir_canonical, AS_WRITTEN_B, "the proven identity is what a lookup compares");

      // The point of the pair: aged rows stay honestly NULL beside a proven new one. A
      // reader can tell "never proven" from "proven", which is the whole ambiguity the
      // column exists to remove.
      const canonical = db.prepare(`SELECT id, project_dir_canonical AS c FROM runs ORDER BY id`).all() as {
        id: string;
        c: string | null;
      }[];
      assert.deepEqual(canonical, [
        { id: "run-aged-a", c: null },
        { id: "run-aged-b", c: null },
        { id: "run-aged-c", c: null },
        { id: "run-new-a", c: AS_WRITTEN_B },
      ]);
    });
  });
});

describe("FG-693 — ADDITIVE ONLY, held mechanically rather than by review memory", () => {
  test("each canonical column has exactly one ADDITIVE_COLUMNS entry, and it is a plain ADD COLUMN", () => {
    for (const { table } of CANONICAL_TABLES) {
      const entries = ADDITIVE_COLUMNS.filter((c) => c.table === table && c.column === CANONICAL_COLUMN);
      assert.equal(
        entries.length,
        1,
        `${table}.${CANONICAL_COLUMN} needs exactly one ADDITIVE_COLUMNS entry — without it the column is silently ` +
          `absent on exactly the databases that matter (FG-608's "no column named imported_from")`,
      );
      assert.equal(entries[0]!.ddl, `ALTER TABLE ${table} ADD COLUMN ${CANONICAL_COLUMN} TEXT`);
    }
  });

  test("the FG-693 DDL adds columns and nothing else — no UPDATE, no backfill, no drop, no rebuild", () => {
    const ddl = [
      ...ADDITIVE_COLUMNS.filter((c) => c.column === CANONICAL_COLUMN).map((c) => c.ddl),
      ...CANONICAL_IDENTITY_INDEXES.map((i) => i.ddl),
    ];
    assert.equal(ddl.length, CANONICAL_TABLES.length * 2, "every canonical table contributes one ALTER and one index");
    for (const statement of ddl) {
      assert.match(
        statement,
        /^(ALTER TABLE \w+ ADD COLUMN |CREATE INDEX IF NOT EXISTS )/,
        `FG-693 DDL must be ALTER TABLE ADD COLUMN or CREATE INDEX IF NOT EXISTS: ${statement}`,
      );
      // The blast radius is machine-wide — every running forge process re-runs migrations
      // on its next DB open — so a migration that touches a ROW is disallowed outright,
      // not merely discouraged.
      for (const forbidden of ["UPDATE ", "DELETE ", "DROP ", "INSERT ", "RENAME "]) {
        assert.equal(statement.includes(forbidden), false, `FG-693 DDL must never ${forbidden.trim()}: ${statement}`);
      }
      assert.equal(statement.includes(";"), false, `one statement per DDL entry: ${statement}`);
    }
  });

  test("SCHEMA_SQL does NOT index a canonical column — that would brick every aged open (the FG-563 hazard)", () => {
    // The columns arrive by ALTER, from applyMigrations, which runs AFTER db.ts has exec'd
    // SCHEMA_SQL. A CREATE INDEX in SCHEMA_SQL naming a column the live table does not yet
    // have throws SQLITE_ERROR — and SCHEMA_SQL is exec'd on EVERY writable open, so the
    // index would fail every open of every aged store on the machine before the ALTER that
    // adds its column could ever run. Hence CANONICAL_IDENTITY_INDEXES is declared as data
    // for the guarded migration path, and this test exists so a future edit cannot
    // helpfully move it back.
    // Asked of SQLite rather than of a regex over the source: a store built from
    // SCHEMA_SQL ALONE is exactly what an aged open exec's first, so its sqlite_master is
    // the ground truth for "what SCHEMA_SQL creates".
    const db = new Database(":memory:");
    try {
      db.exec(SCHEMA_SQL);
      const offending = (
        db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`).all() as {
          name: string;
          sql: string;
        }[]
      ).filter((i) => i.sql.includes(CANONICAL_COLUMN));
      assert.deepEqual(
        offending,
        [],
        `SCHEMA_SQL must not index ${CANONICAL_COLUMN} — the column arrives by ALTER, so on an aged store whose ` +
          `table predates it the CREATE INDEX throws before the ALTER can run, and SCHEMA_SQL is exec'd on EVERY ` +
          `writable open`,
      );
    } finally {
      db.close();
    }
    assert.ok(CANONICAL_IDENTITY_INDEXES.length > 0, "…and the indexes must exist somewhere: as guarded-path data");
  });

  test("the declared indexes apply cleanly and idempotently, and land identically on a fresh and a migrated store", () => {
    const applyIndexes = (db: DatabaseInstance): void => {
      for (const { table, column, ddl } of CANONICAL_IDENTITY_INDEXES) {
        // The guard the migration path owes them: the table must exist and must already
        // carry the column. PRAGMA table_info on a missing table returns zero rows.
        const have = new Set(columns(db, table).map((c) => c.name));
        if (!have.has(column)) continue;
        db.exec(ddl);
      }
    };
    const indexShape = (db: DatabaseInstance): string[] =>
      (
        db
          .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`)
          .all() as { name: string; sql: string }[]
      )
        .filter((i) => i.sql.includes(CANONICAL_COLUMN))
        .map((i) => `${i.name} :: ${i.sql.replace(/\s+/g, " ").trim()}`);

    withDb(freshDb, (fresh) => {
      withDb(agedThenMigrated, (migrated) => {
        applyIndexes(fresh);
        applyIndexes(migrated);
        applyIndexes(migrated); // IF NOT EXISTS — a second pass changes nothing

        const shape = indexShape(fresh);
        assert.equal(
          shape.length,
          CANONICAL_IDENTITY_INDEXES.length,
          "every declared index must actually be creatable against the schema it names",
        );
        assert.deepEqual(
          indexShape(migrated),
          shape,
          "an aged store that migrated must carry the same indexes as a fresh one — otherwise the fresh-vs-migrated " +
            "parity guard would report a constraint-shape divergence the moment these are wired up",
        );

        // And they are usable: an indexed equality probe on the canonical column.
        migrated
          .prepare(
            `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, project_dir_canonical)
             VALUES ('run-indexed', 'feature', 'indexed', 'active', ?, ?, ?)`,
          )
          .run(AGED_AT, AS_WRITTEN_A, AS_WRITTEN_B);
        const found = migrated
          .prepare(`SELECT id FROM runs WHERE project_dir_canonical = ?`)
          .all(AS_WRITTEN_B) as { id: string }[];
        assert.deepEqual(found, [{ id: "run-indexed" }]);
      });
    });
  });
});
