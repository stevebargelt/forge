// FG-638 — the ledger on a GENUINELY pre-FG-638 database.
//
// THE FG-608 LESSON, restated. `forge backlog migrate` died on the dogfood host
// with "table tickets has no column named imported_from": SCHEMA_SQL's CREATE named
// the column, so every fresh DB — every test, all of CI — had it, while the host's
// older table silently did not. The whole suite was green while migrate could not
// run. FG-638 adds two BRAND-NEW TABLES and one NEW COLUMN on `runs`, so it is
// exactly the shape of change that class hides in.
//
// fg608-migration-parity.test.ts is the generic guard and it does cover the new
// columns — but its fixture is built by DROPPING columns from the current fresh
// schema, so it can never represent a database that lacks a whole table, and it
// never inserts a row, so it cannot say anything about data preservation. This file
// covers both halves it structurally cannot:
//
//   - the fixture is a real pre-FG-638 store: `runs` created from the verbatim
//     pre-FG-638 DDL (so SCHEMA_SQL's CREATE TABLE IF NOT EXISTS no-ops on it,
//     precisely as it did on the host) and NO reviews / review_findings tables at
//     all, carrying real runs / tasks / verdicts / events / gates rows;
//   - and it asserts on the ROWS: every pre-existing row byte-identical after the
//     migration, `runs` gaining review_mode readable as 'legacy_verdict' with no
//     backfill, user_version untouched, full fresh-vs-migrated parity, and the
//     ledger actually usable afterward without disturbing the immutable verdicts.
//
// The last test is the guard's own sensitivity: for EACH FG-638 entry in
// ADDITIVE_COLUMNS, removing it must make the parity comparison go red on that
// column. A guard that passes because it is not looking is the failure mode here.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL, ADDITIVE_COLUMNS, type AdditiveColumn } from "./schema.js";
import { applyMigrations, setDbForTest, closeDb } from "./db.js";
import { getRun, runReviewMode } from "./runs.js";
import { insertReview, ingestFindings, summarizeReview } from "./reviews.js";

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

// `runs` EXACTLY as it stood before FG-638 — no review_mode. Created with a verbatim
// CREATE (no IF NOT EXISTS) so the later SCHEMA_SQL exec hits the same no-op path
// production does, which is the only reason the FG-608 class of bug is invisible.
const LEGACY_RUNS_DDL = `
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  metadata        TEXT,
  project_dir     TEXT
);
`;

const LEGACY_TABLES = ["runs", "tasks", "verdicts", "events", "gates"] as const;

function columns(db: DatabaseInstance, table: string): Col[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Col[];
}

function columnNames(db: DatabaseInstance, table: string): string[] {
  return columns(db, table).map((c) => c.name);
}

function tableNames(db: DatabaseInstance): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function tableExists(db: DatabaseInstance, table: string): boolean {
  return columns(db, table).length > 0;
}

// Ordinal-independent column shape: a migrated column is appended at the end, so cid
// order legitimately differs from a fresh DB's. Same fingerprint the FG-608 guard
// compares — a deliberate copy, because that one lives in a test file and exports
// nothing, and a shared helper would let one edit weaken both at once.
function shapeOf(db: DatabaseInstance, table: string): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const c of columns(db, table)) {
    shape[c.name] = `${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "NULL"} pk=${c.pk}`;
  }
  return shape;
}

// The CONSTRAINT shape — everything CREATE TABLE fixes for the life of a table and
// ALTER cannot change. A brand-new table gets this from the CREATE, so the real
// question it answers here is whether the reviews tables an old store receives are
// the SAME tables a fresh store is born with (CHECK bodies included, via the
// sqlite_master text below).
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
      return `${i.name} unique=${i.unique} origin=${i.origin} partial=${i.partial} (${cols.join(", ")}) [${(sql ?? "<auto>").replace(/\s+/g, " ").trim()}]`;
    })
    .sort();

  const foreignKeys = (
    db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
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

/** The normalized CREATE text. Comparable ONLY between tables both stores built from
 *  the same CREATE — SQLite rewrites this text when ALTER adds a column (dropping
 *  the comments and appending the column), so a migrated `runs` legitimately differs
 *  from a fresh one. For the two FG-638 tables, both stores run the identical CREATE
 *  TABLE IF NOT EXISTS, which is what makes the CHECK bodies comparable here at all —
 *  no PRAGMA reports a CHECK constraint. */
function createTextOf(db: DatabaseInstance, table: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { sql: string | null }
    | undefined;
  return (row?.sql ?? "").replace(/\s+/g, " ").trim();
}

/** Does this statement get rejected? The behavioral half of constraint parity — the
 *  question "did the migrated store get the CHECK too" is better asked by handing it
 *  a value the vocabulary forbids than by diffing DDL text. */
function rejects(db: DatabaseInstance, sql: string, params: unknown[] = []): boolean {
  try {
    db.prepare(sql).run(...(params as never[]));
    return false;
  } catch {
    return true;
  }
}

function rawRows(db: DatabaseInstance, table: string, cols: string[]): unknown[] {
  return db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${table} ORDER BY rowid`).all();
}

function freshDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

/** A store as a pre-FG-638 binary left it: legacy `runs` (no review_mode), every
 *  other table at its current shape, and NO ledger tables — the state no
 *  drop-columns-from-fresh fixture can produce. */
function legacyStore(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(LEGACY_RUNS_DDL);
  db.exec(SCHEMA_SQL);
  // SCHEMA_SQL just created the FG-638 tables; a real pre-FG-638 store never had
  // them, so take them away. The index goes with the table.
  db.exec(`DROP TABLE review_findings; DROP TABLE reviews;`);

  assert.equal(
    columnNames(db, "runs").includes("review_mode"),
    false,
    "precondition: the legacy shape must lack runs.review_mode, or this test proves nothing",
  );
  assert.equal(tableExists(db, "reviews"), false, "precondition: the legacy store must have no reviews table");
  assert.equal(tableExists(db, "review_findings"), false, "precondition: the legacy store must have no review_findings table");

  // Real history, written the way the old binary wrote it: the runs INSERT does not
  // name review_mode because the column did not exist.
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, metadata, project_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("run-legacy", "feature", "a run from before the ledger", "complete", "2026-01-02T03:04:05Z", "2026-01-02T04:00:00Z", '{"dispatchKey":null}', "/legacy/project");
  for (const [id, role] of [
    ["task-legacy-impl", "engineer"],
    ["task-legacy-red", "red-wide"],
  ] as const) {
    db.prepare(
      `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, "run-legacy", role, role, "complete", '{"taskId":"' + id + '"}', "2026-01-02T03:05:00Z");
  }
  db.prepare(
    `INSERT INTO verdicts (id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "verdict-legacy-1",
    "task-legacy-impl",
    "task-legacy-red",
    "red-wide",
    "fail",
    0.9,
    "authoritative",
    '[{"severity":"high","summary":"auth bypass on the admin route"}]',
    "2026-01-02T03:30:00Z",
  );
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    "run-legacy",
    "task-legacy-impl",
    "task.completed",
    '{"status":"complete"}',
    "2026-01-02T03:40:00Z",
  );
  db.prepare(`INSERT INTO gates (id, task_id, decision, rationale, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "gate-legacy-1",
    "task-legacy-impl",
    "advance",
    "shipped under the legacy verdict model",
    "2026-01-02T03:50:00Z",
    "operator",
  );
  return db;
}

test("FG-638: a pre-FG-638 store gains the ledger tables and review_mode, with every legacy row byte-identical", () => {
  const db = legacyStore();

  // What the store held before the migration, read through the columns the LEGACY
  // shape had — the only fair comparison for a table that is about to gain one.
  const legacyColumns = new Map<string, string[]>(LEGACY_TABLES.map((t) => [t, columnNames(db, t)]));
  const before = new Map<string, unknown[]>(
    LEGACY_TABLES.map((t) => [t, rawRows(db, t, legacyColumns.get(t) as string[])]),
  );

  // Exactly what a real upgraded install runs on first writable open.
  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  assert.ok(tableExists(db, "reviews"), "the migration must create the reviews table on an old store");
  assert.ok(tableExists(db, "review_findings"), "the migration must create the review_findings table on an old store");

  const reviewMode = columns(db, "runs").find((c) => c.name === "review_mode");
  assert.ok(reviewMode, "runs must gain review_mode");
  assert.equal(reviewMode.notnull, 1, "review_mode is NOT NULL — a run's authority model is never null");
  assert.equal(reviewMode.dflt_value, "'legacy_verdict'", "the DEFAULT is what makes a legacy run unambiguous with no backfill");

  for (const t of LEGACY_TABLES) {
    assert.deepEqual(
      rawRows(db, t, legacyColumns.get(t) as string[]),
      before.get(t),
      `${t}: an additive migration must not rewrite a single pre-existing value`,
    );
  }

  // The new column, on the row that predates it — read, not back-filled.
  const migratedRun = db.prepare(`SELECT review_mode FROM runs WHERE id = 'run-legacy'`).get() as { review_mode: string };
  assert.equal(migratedRun.review_mode, "legacy_verdict");

  assert.equal(db.pragma("user_version", { simple: true }), 0, "an additive migration never bumps user_version");
});

test("FG-638: a migrated store is shape- and constraint-identical to a fresh one, for every table", () => {
  const fresh = freshDb();
  const migrated = legacyStore();
  migrated.exec(SCHEMA_SQL);
  applyMigrations(migrated);

  assert.deepEqual(tableNames(migrated), tableNames(fresh), "migrated and fresh must carry the same tables");

  for (const table of tableNames(fresh)) {
    assert.deepEqual(
      shapeOf(migrated, table),
      shapeOf(fresh, table),
      `${table}: a migrated store diverges from a fresh one — add the missing column(s) to ADDITIVE_COLUMNS in schema.ts`,
    );
    assert.deepEqual(
      constraintsOf(migrated, table),
      constraintsOf(fresh, table),
      `${table}: the CONSTRAINT shape (PK / indexes / FKs) diverges from a fresh store`,
    );
  }

  // The two brand-new tables come from the SAME CREATE on both paths, so their full
  // DDL — CHECK bodies, UNIQUE (review_id, ordinal), the FK's ON DELETE CASCADE —
  // must match character for character.
  for (const table of ["reviews", "review_findings"]) {
    assert.equal(createTextOf(migrated, table), createTextOf(fresh, table), `${table}: DDL text diverges from a fresh store`);
    assert.ok(createTextOf(fresh, table).length > 0, `${table} must exist in the fresh schema, or this comparison is empty`);
  }
  assert.match(
    createTextOf(migrated, "review_findings"),
    /UNIQUE \(review_id, ordinal\)/,
    "the ordinal uniqueness constraint is what keeps RF-n dense and single-assignment",
  );
  assert.match(createTextOf(migrated, "review_findings"), /REFERENCES reviews\(id\) ON DELETE CASCADE/);
});

test("FG-638: the CHECK vocabularies are enforced on a migrated store, not just a fresh one", () => {
  const migrated = legacyStore();
  migrated.exec(SCHEMA_SQL);
  applyMigrations(migrated);

  const goodReview = `INSERT INTO reviews (id, review_mode, state, created_at, updated_at) VALUES (?, ?, ?, 'T', 'T')`;
  assert.equal(rejects(migrated, goodReview, ["review-ok", "evidence_led", "settled"]), false, "a valid review must insert");
  assert.ok(rejects(migrated, goodReview, ["review-bad-mode", "sudo_mode", "settled"]), "review_mode CHECK must reject an unknown mode");
  assert.ok(rejects(migrated, goodReview, ["review-bad-state", "evidence_led", "vibing"]), "state CHECK must reject a state outside the 11");

  const finding = `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, disposition, created_at, updated_at)
                   VALUES (?, 'review-ok', ?, ?, ?, 'T', 'T')`;
  assert.equal(rejects(migrated, finding, ["review-ok/RF-1", 1, "RF-1", "fix_now"]), false, "a valid finding must insert");
  assert.ok(rejects(migrated, finding, ["review-ok/RF-2", 2, "RF-2", "wont_fix"]), "disposition CHECK must reject a word outside the vocabulary");
  assert.ok(rejects(migrated, finding, ["review-ok/RF-3", 1, "RF-3", "fix_now"]), "UNIQUE (review_id, ordinal) must reject a re-used ordinal");

  // runs.review_mode arrives by ALTER, which cannot carry a CHECK — the type/NOT
  // NULL/DEFAULT triple is the whole contract there. Pinned so a future reader does
  // not assume a migrated store validates the value.
  assert.equal(
    rejects(migrated, `INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES ('run-x','w','t','active','T','sudo_mode')`),
    false,
    "documented: a migrated runs.review_mode has no CHECK (ADD COLUMN cannot add one) — the accessor's type is the guard",
  );
});

test("FG-638: re-opening a migrated store is a no-op, and the ledger is usable on it", () => {
  const migrated = legacyStore();
  migrated.exec(SCHEMA_SQL);
  applyMigrations(migrated);

  const fresh = freshDb();
  applyMigrations(migrated);
  applyMigrations(migrated);
  for (const table of tableNames(fresh)) {
    assert.deepEqual(shapeOf(migrated, table), shapeOf(fresh, table), `${table}: re-migration must not change the shape`);
  }

  const verdictsBefore = rawRows(migrated, "verdicts", columnNames(migrated, "verdicts"));
  const prev = setDbForTest(migrated);
  try {
    // The legacy run reads back its authority model through the accessor, not just
    // through raw SQL — rowToRun's fallback and the column must agree.
    assert.equal(runReviewMode("run-legacy"), "legacy_verdict");
    assert.equal(getRun("run-legacy")?.reviewMode, "legacy_verdict");

    insertReview({
      id: "review-on-migrated",
      runId: "run-legacy",
      subjectTaskId: "task-legacy-impl",
      reviewMode: "evidence_led",
      candidateSha: "cand-migrated",
      state: "awaiting_disposition",
    });
    const findings = ingestFindings("review-on-migrated", [
      { summary: "the same mechanism the legacy verdict reported", riskLens: "wide", modelFindingId: "red-wide-1" },
    ]);
    assert.deepEqual(
      findings.map((f) => f.id),
      ["review-on-migrated/RF-1"],
    );
    assert.equal(summarizeReview("review-on-migrated")?.findings.length, 1);

    // The migrated run had never been marked — it read 'legacy_verdict' from the
    // DEFAULT, not from a decision — so its FIRST ledger review marks it, and the run
    // row moves with the review rather than the two disagreeing about which authority
    // model settles the run.
    assert.equal(runReviewMode("run-legacy"), "evidence_led");
    assert.equal(getRun("run-legacy")?.reviewMode, "evidence_led");

    // And once marked, a conflicting mode is REFUSED on a migrated store exactly as on
    // a fresh one — the guard travels with the accessor, not with the schema version.
    const runsBefore = rawRows(migrated, "runs", columnNames(migrated, "runs"));
    const reviewsBefore = rawRows(migrated, "reviews", columnNames(migrated, "reviews"));
    assert.throws(
      () => insertReview({ id: "review-conflicting", runId: "run-legacy", reviewMode: "legacy_verdict" }),
      /run-legacy is evidence_led/,
    );
    assert.deepEqual(rawRows(migrated, "runs", columnNames(migrated, "runs")), runsBefore, "a refused review must not touch the run row");
    assert.deepEqual(rawRows(migrated, "reviews", columnNames(migrated, "reviews")), reviewsBefore, "a refused review must write no review row");
  } finally {
    setDbForTest(prev as DatabaseInstance);
    closeDb();
  }

  assert.deepEqual(
    rawRows(migrated, "verdicts", columnNames(migrated, "verdicts")),
    verdictsBefore,
    "verdicts is immutable provenance — ingesting a ledger finding must not touch a verdict row",
  );
});

// ─── the guard's own sensitivity ─────────────────────────────────────────────

const FG638_ADDITIVE = ADDITIVE_COLUMNS.filter((c) => c.table === "reviews" || c.table === "review_findings" || (c.table === "runs" && c.column === "review_mode"));

/** db.ts's additive loop, with the column list as a parameter. A DELIBERATE copy —
 *  applyMigrations reads the module-level ADDITIVE_COLUMNS, so a missing-entry
 *  mutation cannot be expressed through it. Kept honest by the assertion below that
 *  running it with the FULL list reproduces applyMigrations' result exactly. */
function applyAdditiveColumns(db: DatabaseInstance, cols: AdditiveColumn[]): void {
  for (const col of cols) {
    const have = new Set(columnNames(db, col.table));
    if (have.size === 0) continue; // table absent — nothing to bring forward
    if (have.has(col.column)) continue;
    db.exec(col.ddl);
  }
}

/** A fresh DB with the FG-638 tables stripped to the oldest shape SQLite permits,
 *  brought forward with `omit` (a `table.column` key) left out of the list. */
function strippedThenMigrated(omit: string | null): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  for (const table of ["reviews", "review_findings", "runs"]) {
    for (const col of columns(db, table)) {
      // Exactly ADD COLUMN's restorability rule: not part of the PK, and either
      // nullable or carrying a DEFAULT.
      if (col.pk !== 0 || (col.notnull !== 0 && col.dflt_value === null)) continue;
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${col.name}`);
    }
  }
  db.exec(SCHEMA_SQL);
  applyAdditiveColumns(
    db,
    ADDITIVE_COLUMNS.filter((c) => `${c.table}.${c.column}` !== omit),
  );
  return db;
}

test("FG-638: the copied additive loop reproduces applyMigrations, so the mutations below mean something", () => {
  const viaCopy = strippedThenMigrated(null);
  const fresh = freshDb();
  for (const table of ["reviews", "review_findings", "runs"]) {
    assert.deepEqual(
      shapeOf(viaCopy, table),
      shapeOf(fresh, table),
      `${table}: the full ADDITIVE_COLUMNS list must restore fresh parity through the copied loop too`,
    );
  }
});

test("FG-638: removing ANY FG-638 ADDITIVE_COLUMNS entry makes fresh-vs-migrated parity go red on exactly that column", () => {
  const fresh = freshDb();

  // Non-vacuity first: the FG-638 change really is on this list, and every entry
  // names a column the fresh schema has.
  assert.ok(FG638_ADDITIVE.length >= 30, `expected the FG-638 entries to be on ADDITIVE_COLUMNS, found ${FG638_ADDITIVE.length}`);
  for (const c of FG638_ADDITIVE) {
    assert.ok(columnNames(fresh, c.table).includes(c.column), `${c.table}.${c.column} is declared but not in the fresh schema`);
  }

  for (const c of FG638_ADDITIVE) {
    const key = `${c.table}.${c.column}`;
    const mutated = strippedThenMigrated(key);
    const missing = Object.keys(shapeOf(fresh, c.table)).filter((name) => !(name in shapeOf(mutated, c.table)));
    assert.deepEqual(
      missing,
      [c.column],
      `dropping ${key} from ADDITIVE_COLUMNS must leave exactly that column missing — if it leaves nothing missing, ` +
        `the parity guard is not covering this column and an old store would never get it`,
    );
  }
});
