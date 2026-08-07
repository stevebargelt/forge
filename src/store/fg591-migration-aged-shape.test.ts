// FG-591 (the operator work queue and its dispatcher), step 1 — forward-open safety
// for the FOUR dispatcher tables against a HAND-AUTHORED AGED CONSTRAINT SHAPE.
//
// ─── WHY THE FIXTURE IS HAND-AUTHORED ────────────────────────────────────────
// fg608-migration-parity.test.ts already proves COLUMN parity generically, and it
// builds its "old" DB by DROPping columns off today's fresh schema — so that fixture
// carries TODAY'S CONSTRAINTS by construction. The dogfood host's real defect was a
// ticket_events table with a SINGLE-COLUMN primary key, a constraint shape no amount
// of column dropping can produce, and that is exactly why it stayed invisible until
// `forge backlog migrate` died on the host.
//
// So the DDL below is written out BY HAND in the shape a pre-FG-591 binary actually
// created — aged CONSTRAINTS, not merely absent columns, including an FG-610
// queue_claims whose live-claim index is NON-UNIQUE under the canonical name (a
// divergence `CREATE ... IF NOT EXISTS` can never repair, and therefore proof the
// fixture is genuinely aged). The ordinary open path (SCHEMA_SQL then applyMigrations,
// exactly as getDb does it) is then asked to bring it forward, and the four new tables
// must arrive WHOLE from the CREATE path — never from an ALTER, never bumping
// user_version, and never pinning a restorable column undroppable.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL, ADDITIVE_COLUMNS } from "./schema.js";
import { applyMigrations, setDbForTest } from "./db.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { enqueueTicket, rankTicket, rankedOrder } from "./queue.js";
import { claimNextEligible, MIN_LEASE_TTL_MS } from "./queue-claims.js";

const PK = "pk-aged-591";
const AGED_AT = "2026-03-04T05:06:07.000Z";

const READY_BODY = [
  "## Problem",
  "An aged store must dispatch.",
  "",
  "## Goal",
  "It opens, migrates, and carries the dispatcher's durable evidence.",
  "",
  "## Acceptance Criteria",
  "- it dispatches",
].join("\n");

// The four tables this step adds, in their canonical CREATE order.
const DISPATCHER_TABLES = [
  "dispatcher_policy",
  "dispatcher_leases",
  "dispatcher_wakes",
  "dispatcher_evaluations",
] as const;

const EXPECTED_COLUMNS: Record<string, string[]> = {
  dispatcher_policy: [
    "scope_key",
    "armed",
    "max_active_runs",
    "capacity_scope",
    "lease_ttl_ms",
    "heartbeat_ms",
    "default_workflow",
    "updated_at",
    "updated_by",
  ],
  dispatcher_leases: [
    "project_key",
    "owner",
    "generation",
    "lease_expires_at_ms",
    "heartbeat_at_ms",
    "host",
    "pid",
    "created_at",
    "updated_at",
  ],
  dispatcher_wakes: [
    "id",
    "project_key",
    "kind",
    "wake_key",
    "detail",
    "state",
    "consumed_by",
    "consumed_at_ms",
    "created_at",
  ],
  dispatcher_evaluations: [
    "id",
    "project_key",
    "dispatcher_owner",
    "dispatcher_generation",
    "reason",
    "detail",
    "claimed_ticket_id",
    "claim_id",
    "capacity_scope",
    "capacity_limit",
    "capacity_used",
    "capacity_holders",
    "scan_evidence",
    "wake_kind",
    "next_watchdog_at_ms",
    "evaluated_at_ms",
    "evaluated_at",
  ],
};

// The store as a PRE-FG-591 binary wrote it. Hand-authored, carrying AGED CONSTRAINT
// SHAPES a drop-from-fresh fixture cannot produce:
//
//   ticket_events   — the DOGFOOD HOST'S SINGLE-COLUMN PRIMARY KEY, which the FG-608
//                     rebuild has to converge before anything else runs.
//   queue_membership— FG-609's table WITHOUT its composite FOREIGN KEY and index.
//   queue_events    — an INTEGER PRIMARY KEY with NO AUTOINCREMENT.
//   queue_claims    — FG-610's table missing every ALTER-restorable column, and with
//                     idx_queue_claims_live created NON-UNIQUE under the canonical
//                     name. CREATE UNIQUE INDEX IF NOT EXISTS no-ops over an existing
//                     index of that name forever, so this divergence SURVIVES the
//                     open — which is exactly what makes the fixture genuinely aged.
//
// There are NO dispatcher_* tables at all — that is the half this step adds.
const AGED_SCHEMA_SQL = `
CREATE TABLE tickets (
  project_key   TEXT NOT NULL,
  ticket_id     TEXT NOT NULL,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL,
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

CREATE TABLE blocker_evidence (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  reason      TEXT,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (project_key, ticket_id, source),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);

CREATE TABLE ticket_events (
  event_key   TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE queue_membership (
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id)
);

CREATE TABLE readiness_assessments (
  project_key  TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  body_hash    TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id)
);

CREATE TABLE queue_events (
  id          INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE queue_claims (
  id                  TEXT PRIMARY KEY,
  project_key         TEXT NOT NULL,
  ticket_id           TEXT NOT NULL,
  owner               TEXT NOT NULL,
  generation          INTEGER NOT NULL,
  ticket_revision     INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  heartbeat_at_ms     INTEGER NOT NULL,
  state               TEXT NOT NULL,
  claimed_at          TEXT NOT NULL
);
CREATE INDEX idx_queue_claims_live ON queue_claims(project_key, ticket_id);

CREATE TABLE project_identity (
  project_key          TEXT PRIMARY KEY,
  repo_evidence_key    TEXT NOT NULL UNIQUE,
  repo_evidence_source TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE ticket_storage_mode (
  project_key TEXT PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT 'markdown',
  updated_at  TEXT NOT NULL
);

CREATE TABLE runs (
  id         TEXT PRIMARY KEY,
  workflow   TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  phase        TEXT NOT NULL,
  agent_role   TEXT NOT NULL,
  status       TEXT NOT NULL,
  task_package TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE ticket_dispatch_evidence (
  task_id       TEXT PRIMARY KEY,
  project_key   TEXT NOT NULL,
  ticket_id     TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  body_hash     TEXT NOT NULL,
  dispatched_at TEXT NOT NULL
);
`;

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

function columns(db: DatabaseInstance, table: string): Col[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Col[];
}

function columnNames(db: DatabaseInstance, table: string): string[] {
  return columns(db, table).map((c) => c.name);
}

/** fg608-migration-parity.test.ts's own predicate, replicated: can ALTER TABLE ADD
 *  COLUMN put this column back? PK columns cannot, and NOT NULL without a DEFAULT
 *  cannot either. */
function isRestorable(c: Col): boolean {
  return c.pk === 0 && (c.notnull === 0 || c.dflt_value !== null);
}

function indexNames(db: DatabaseInstance, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name).sort();
}

function masterSql(db: DatabaseInstance, tables: readonly string[]): string {
  const like = tables.map((t) => `'${t}'`).join(", ");
  return JSON.stringify(
    db
      .prepare(
        `SELECT name, type, tbl_name, sql FROM sqlite_master
         WHERE tbl_name IN (${like}) ORDER BY name`,
      )
      .all(),
  );
}

/** The aged store, with real pre-FG-591 rows. */
function agedDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(AGED_SCHEMA_SQL);

  const ins = db.prepare(
    `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, created, imported_at)
     VALUES (?, ?, 'story', 'active', ?, ?, '2026-01-01', ?)`,
  );
  ins.run(PK, "FG-1", "aged one", READY_BODY, AGED_AT);
  ins.run(PK, "FG-2", "aged two", READY_BODY, AGED_AT);

  // The project was already cut over to db mode by the aged binary.
  db.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, 'aged-591-evidence', 'path', ?)`,
  ).run(PK, AGED_AT);
  db.prepare(`INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', ?)`).run(PK, AGED_AT);
  db.prepare(`INSERT INTO queue_membership (project_key, ticket_id, enqueued_at) VALUES (?, 'FG-1', ?)`).run(PK, AGED_AT);
  return db;
}

/** Opened exactly as a real open does: SCHEMA_SQL (whose CREATEs no-op over the
 *  existing tables — the very reason the FG-608 bug was invisible) then applyMigrations. */
function agedThenMigrated(): DatabaseInstance {
  const db = agedDb();
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function withAgedDb<T>(fn: (db: DatabaseInstance) => T): T {
  const db = agedThenMigrated();
  const prev = setDbForTest(db);
  setPublicationClockOffsetForTest(0);
  try {
    return fn(db);
  } finally {
    setPublicationClockOffsetForTest(0);
    setDbForTest(prev as DatabaseInstance);
    db.close();
  }
}

// ─── the fixture is genuinely aged ───────────────────────────────────────────

test("FG-591: the fixture carries AGED CONSTRAINT SHAPES and no dispatcher tables at all", () => {
  const raw = agedDb();

  // The dogfood host's single-column ticket_events PK.
  assert.deepEqual(
    columns(raw, "ticket_events")
      .filter((c) => c.pk > 0)
      .map((c) => c.name),
    ["event_key"],
    "the fixture must carry the dogfood host's aged constraint shape",
  );
  // FG-609's queue table WITHOUT its foreign key — CREATE TABLE IF NOT EXISTS can
  // never repair that, so the new paths genuinely run against it.
  assert.deepEqual(raw.prepare(`PRAGMA foreign_key_list(queue_membership)`).all(), []);
  // FG-610's live-claim index present but NON-UNIQUE under the canonical name.
  const agedLive = (raw.prepare(`PRAGMA index_list(queue_claims)`).all() as { name: string; unique: number }[]).find(
    (i) => i.name === "idx_queue_claims_live",
  );
  assert.equal(agedLive?.unique, 0, "the aged live-claim index is NON-UNIQUE — a divergence the open path cannot repair");

  for (const table of DISPATCHER_TABLES) {
    assert.equal(
      (
        raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { n: number }
      ).n,
      0,
      `precondition: the aged store has no ${table} at all`,
    );
  }
  raw.close();

  withAgedDb((db) => {
    // ...the open path converges ticket_events, which is what lets the rest run...
    assert.deepEqual(
      columns(db, "ticket_events")
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
      ["project_key", "ticket_id", "event_key"],
    );
    // ...and leaves the aged divergences it does not have to repair. Additive-only
    // means the open path repairs nothing it need not, and nothing here depends on them.
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(queue_membership)`).all(), []);
    assert.equal(
      (db.prepare(`PRAGMA index_list(queue_claims)`).all() as { name: string; unique: number }[]).find(
        (i) => i.name === "idx_queue_claims_live",
      )?.unique,
      0,
      "the aged non-unique claim index survives — proof this store was not silently rebuilt",
    );
    // The aged queue_claims DID gain its ALTER-restorable columns, which is the
    // contrast: an aged table travels the ALTER path, a brand-new one does not.
    for (const c of ["launch_id", "run_id", "outcome", "scan_evidence", "released_at"]) {
      assert.ok(columnNames(db, "queue_claims").includes(c), `queue_claims.${c} restored by the ALTER path`);
    }
  });
});

// ─── the four tables arrive WHOLE, from the CREATE path ──────────────────────

test("FG-591: all four dispatcher tables arrive WHOLE on an aged store", () => {
  withAgedDb((db) => {
    for (const table of DISPATCHER_TABLES) {
      assert.deepEqual(columnNames(db, table), EXPECTED_COLUMNS[table], `${table} did not arrive whole`);
    }

    // The wake idempotency backstop: PARTIAL and UNIQUE over the pending state.
    const wakeIndexes = db.prepare(`PRAGMA index_list(dispatcher_wakes)`).all() as {
      name: string;
      unique: number;
      partial: number;
    }[];
    const pending = wakeIndexes.find((i) => i.name === "idx_dispatcher_wakes_pending");
    assert.ok(pending, "the at-most-one-pending-wake backstop arrived");
    assert.equal(pending.unique, 1, "a duplicate poke is collapsed by the STORE, not by the caller");
    assert.equal(pending.partial, 1, "and only over pending rows — consumed wakes are history");
    assert.ok(
      wakeIndexes.some((i) => i.name === "idx_dispatcher_wakes_scan"),
      "the consume-scan index arrived too",
    );
    assert.ok(
      indexNames(db, "dispatcher_evaluations").includes("idx_dispatcher_evaluations_project"),
      "the per-project evaluation read index arrived",
    );
  });
});

test("FG-591: the four tables come from CREATE TABLE IF NOT EXISTS — no ALTER path is used", () => {
  // SCHEMA_SQL ALONE, without applyMigrations: if the tables are already whole here,
  // the CREATE path is what delivered them.
  const createOnly = agedDb();
  createOnly.exec(SCHEMA_SQL);
  for (const table of DISPATCHER_TABLES) {
    assert.deepEqual(
      columnNames(createOnly, table),
      EXPECTED_COLUMNS[table],
      `${table} must be whole after SCHEMA_SQL alone`,
    );
  }
  const beforeMigrations = masterSql(createOnly, DISPATCHER_TABLES);

  // ...and applyMigrations changes not one byte of their shape: every ADDITIVE_COLUMNS
  // entry for these tables is a declared no-op that exists only so the FG-608 parity
  // guard can check the list is exhaustive.
  applyMigrations(createOnly);
  assert.equal(
    masterSql(createOnly, DISPATCHER_TABLES),
    beforeMigrations,
    "applyMigrations must not touch a brand-new table's shape",
  );

  // The guard cannot pass vacuously: the entries really are declared, and every one of
  // them names a column the CREATE already produced.
  const declared = ADDITIVE_COLUMNS.filter((c) => (DISPATCHER_TABLES as readonly string[]).includes(c.table));
  const restorable = DISPATCHER_TABLES.flatMap((t) =>
    columns(createOnly, t)
      .filter(isRestorable)
      .map((c) => `${t}.${c.name}`),
  ).sort();
  assert.deepEqual(
    declared.map((c) => `${c.table}.${c.column}`).sort(),
    restorable,
    "the additive list for these tables must be EXHAUSTIVE — that is the only thing that makes the invariant checkable",
  );
  for (const entry of declared) {
    assert.ok(
      columnNames(createOnly, entry.table).includes(entry.column),
      `${entry.table}.${entry.column} must already exist from the CREATE — its ALTER never fires`,
    );
  }
  createOnly.close();
});

test("FG-591: opening an aged store does not bump user_version, and re-opening is a no-op", () => {
  withAgedDb((db) => {
    assert.equal(db.pragma("user_version", { simple: true }), 0, "additive-only: an older binary still opens this store");
    const shape = (): string => JSON.stringify(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all());
    const before = shape();
    db.exec(SCHEMA_SQL);
    applyMigrations(db);
    assert.equal(shape(), before, "re-running the open path changes nothing");
  });
});

test("FG-591: no dispatcher table pins a restorable column undroppable — the UNDROPPABLE set cannot grow", () => {
  // The FG-608 parity guard strips a fresh DB by DROPping every ALTER-restorable
  // column, and any it cannot drop must be listed in its UNDROPPABLE set. An index
  // over a restorable column is what pins one. Asserted here directly rather than by
  // waiting for that test to fail with a diff nobody can read.
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  for (const table of DISPATCHER_TABLES) {
    const restorable = new Set(
      columns(db, table)
        .filter(isRestorable)
        .map((c) => c.name),
    );
    for (const index of indexNames(db, table)) {
      const indexed = (db.prepare(`PRAGMA index_info(${index})`).all() as { name: string | null }[]).map((c) => c.name);
      for (const col of indexed) {
        assert.equal(
          col !== null && restorable.has(col),
          false,
          `${table}.${col} is indexed by ${index} AND restorable — that grows the FG-608 UNDROPPABLE set`,
        );
      }
    }
    // ...and the columns really are droppable, which is what the parity guard needs.
    for (const col of restorable) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    }
    assert.equal(
      columnNames(db, table).some((c) => restorable.has(c)),
      false,
      `${table}: every restorable column dropped cleanly`,
    );
  }
  db.close();
});

test("FG-591: no CHECK constraint and no FOREIGN KEY on any dispatcher table", () => {
  withAgedDb((db) => {
    for (const table of DISPATCHER_TABLES) {
      const sql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string }
      ).sql;
      assert.equal(
        /\bCHECK\s*\(/i.test(sql),
        false,
        `${table} must carry NO CHECK — FG-591 owns these vocabularies and SQLite cannot widen a CHECK additively`,
      );
      assert.deepEqual(
        db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
        [],
        `${table} must carry NO FOREIGN KEY — an operator dequeue must never cascade away a record for a container that may still be executing`,
      );
    }
  });
});

// ─── the aged store SERVES the new tables ────────────────────────────────────

test("FG-591: an aged store serves policy, lease, wake CAS and evaluation evidence", () => {
  withAgedDb((db) => {
    // POLICY — the host singleton beside an optional per-project workflow row.
    db.prepare(
      `INSERT INTO dispatcher_policy
         (scope_key, armed, max_active_runs, capacity_scope, lease_ttl_ms, heartbeat_ms, updated_at, updated_by)
       VALUES ('host', 1, 2, 'host', ?, 300000, ?, 'steve')`,
    ).run(MIN_LEASE_TTL_MS, AGED_AT);
    db.prepare(
      `INSERT INTO dispatcher_policy (scope_key, default_workflow, updated_at) VALUES (?, 'feature', ?)`,
    ).run(PK, AGED_AT);
    const host = db.prepare(`SELECT * FROM dispatcher_policy WHERE scope_key = 'host'`).get() as {
      armed: number;
      max_active_runs: number;
      capacity_scope: string;
      default_workflow: string | null;
    };
    assert.equal(host.armed, 1);
    assert.equal(host.max_active_runs, 2);
    assert.equal(host.capacity_scope, "host");
    assert.equal(host.default_workflow, null, "the host row carries no workflow; a project row carries no ceiling");

    // LEASE — the fenced dispatcher identity, generation as the fencing token.
    db.prepare(
      `INSERT INTO dispatcher_leases
         (project_key, owner, generation, lease_expires_at_ms, heartbeat_at_ms, host, pid, created_at, updated_at)
       VALUES (?, 'dispatcher@1', 1, 1000, 900, 'laptop', 4242, ?, ?)`,
    ).run(PK, AGED_AT, AGED_AT);
    // A takeover bumps the generation in place; a superseded owner writes nothing.
    const superseded = db
      .prepare(
        `UPDATE dispatcher_leases SET owner = 'dispatcher@stale', updated_at = ?
         WHERE project_key = ? AND owner = 'dispatcher@1' AND generation = 1`,
      )
      .run(AGED_AT, PK);
    assert.equal(superseded.changes, 1, "the live owner can write");
    db.prepare(
      `UPDATE dispatcher_leases SET owner = 'dispatcher@2', generation = generation + 1, updated_at = ?
       WHERE project_key = ? AND lease_expires_at_ms < 2000`,
    ).run(AGED_AT, PK);
    const fenced = db
      .prepare(
        `UPDATE dispatcher_leases SET heartbeat_at_ms = 5000
         WHERE project_key = ? AND owner = 'dispatcher@stale' AND generation = 1`,
      )
      .run(PK);
    assert.equal(fenced.changes, 0, "a superseded generation renews nothing");

    // WAKES — a duplicate poke collapses onto the ONE pending record...
    const poke = db.prepare(
      `INSERT INTO dispatcher_wakes (project_key, kind, wake_key, detail, state, created_at)
       VALUES (?, 'run_terminal', 'run-9', ?, 'pending', ?)`,
    );
    poke.run(PK, "first delivery", AGED_AT);
    assert.throws(
      () => poke.run(PK, "duplicate delivery", AGED_AT),
      /UNIQUE constraint failed/,
      "a duplicate wake is harmless BY CONSTRUCTION, not by caller discipline",
    );
    const wakeId = (db.prepare(`SELECT id FROM dispatcher_wakes WHERE wake_key = 'run-9'`).get() as { id: number }).id;

    // ...and the CAS consume admits exactly one of two concurrent consumers.
    const consume = db.prepare(
      `UPDATE dispatcher_wakes SET state = 'consumed', consumed_by = ?, consumed_at_ms = ?
       WHERE id = ? AND state = 'pending'`,
    );
    assert.equal(consume.run("dispatcher@2", 1234, wakeId).changes, 1, "the first consumer wins");
    assert.equal(consume.run("dispatcher@other", 1235, wakeId).changes, 0, "the second consumes nothing");

    // ...and the NEXT change to the same subject gets its own record: the partial
    // index is over pending rows only, so a consumed wake never blocks a real signal.
    poke.run(PK, "a later transition", AGED_AT);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatcher_wakes WHERE wake_key = 'run-9'`).get() as { n: number }).n,
      2,
    );

    // EVALUATIONS — a pass that granted NOTHING still leaves the operator an answer.
    const scan = [
      { ticketId: "FG-1", rank: 1, reason: "queue_blocked", detail: "waiting on FG-9" },
      { ticketId: "FG-2", rank: 2, reason: "incompatible", detail: "waiting for FG-1 to finish" },
    ];
    db.prepare(
      `INSERT INTO dispatcher_evaluations
         (project_key, dispatcher_owner, dispatcher_generation, reason, detail, capacity_scope, capacity_limit,
          capacity_used, capacity_holders, scan_evidence, wake_kind, next_watchdog_at_ms, evaluated_at_ms, evaluated_at)
       VALUES (?, 'dispatcher@2', 2, 'incompatible_only', 'no compatible candidate this pass', 'host', 2, 2, ?, ?, 'run_terminal', 60000, 1000, ?)`,
    ).run(
      PK,
      JSON.stringify([{ projectKey: "other-project", ticketId: "OT-7", owner: "dispatcher@other", runId: "run-7" }]),
      JSON.stringify(scan),
      AGED_AT,
    );
    const evaluation = db
      .prepare(`SELECT * FROM dispatcher_evaluations WHERE project_key = ? ORDER BY id DESC LIMIT 1`)
      .get(PK) as { reason: string; scan_evidence: string; capacity_holders: string; next_watchdog_at_ms: number };
    assert.equal(evaluation.reason, "incompatible_only");
    assert.deepEqual(JSON.parse(evaluation.scan_evidence), scan, "every bypassed candidate keeps its own reason");
    assert.equal(
      JSON.parse(evaluation.capacity_holders)[0].projectKey,
      "other-project",
      "a host-scoped refusal names the OTHER project holding the slot",
    );
    assert.equal(evaluation.next_watchdog_at_ms, 60000);

    // A SCHEDULING WAIT IS NOT A BLOCKER. Recording the incompatibility above wrote
    // nothing to blocker_evidence — that table is partly container-visible and drives
    // the Blocked projection, and a temporary wait must never reinterpret a status.
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence WHERE project_key = ?`).get(PK) as { n: number }).n,
      0,
    );
  });
});

test("FG-591: an operator dequeue or ticket removal never cascades away dispatcher evidence", () => {
  withAgedDb((db) => {
    db.prepare(
      `INSERT INTO dispatcher_wakes (project_key, kind, wake_key, state, created_at)
       VALUES (?, 'queue_change', 'FG-1', 'pending', ?)`,
    ).run(PK, AGED_AT);
    db.prepare(
      `INSERT INTO dispatcher_evaluations
         (project_key, dispatcher_owner, reason, claimed_ticket_id, claim_id, evaluated_at_ms, evaluated_at)
       VALUES (?, 'dispatcher@2', 'granted', 'FG-1', 'claim-1', 1000, ?)`,
    ).run(PK, AGED_AT);
    db.prepare(
      `INSERT INTO dispatcher_leases
         (project_key, owner, generation, lease_expires_at_ms, heartbeat_at_ms, created_at, updated_at)
       VALUES (?, 'dispatcher@2', 1, 9999, 9000, ?, ?)`,
    ).run(PK, AGED_AT, AGED_AT);

    // The operator dequeues, and then FG-608 removal reconciliation deletes the ticket
    // outright — the harshest cascade the store can produce, with foreign_keys ON.
    db.prepare(`DELETE FROM queue_membership WHERE project_key = ? AND ticket_id = 'FG-1'`).run(PK);
    db.prepare(`DELETE FROM tickets WHERE project_key = ? AND ticket_id = 'FG-1'`).run(PK);

    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_key = ?`).get(PK) as { n: number }).n;
    assert.equal(count("dispatcher_wakes"), 1, "the wake survived — losing it is how a signal is lost forever");
    assert.equal(
      count("dispatcher_evaluations"),
      1,
      "the evaluation survived — losing it is how a takeover finds an empty slot and launches a duplicate",
    );
    assert.equal(count("dispatcher_leases"), 1, "the dispatcher's identity survived");
  });
});

test("FG-591: FG-609's and FG-610's paths still serve on an aged store carrying the new tables", () => {
  withAgedDb((db) => {
    rankTicket(PK, "FG-1");
    rankTicket(PK, "FG-2");
    assert.deepEqual(rankedOrder(PK).map((r) => r.ticketId), ["FG-1", "FG-2"]);
    assert.equal(enqueueTicket(PK, "FG-1").ok, true);
    assert.equal(enqueueTicket(PK, "FG-2").ok, true);

    const claim = claimNextEligible({
      projectKey: PK,
      owner: "dispatcher@aged",
      capacity: 2,
      capacityScope: "host",
      leaseTtlMs: MIN_LEASE_TTL_MS,
    });
    assert.equal(claim.reason, "granted");
    assert.equal(claim.claimed?.ticketId, "FG-1");

    // Nothing about the four new tables perturbed the claim ledger, and the tables
    // this step only adds SHAPE for are still empty.
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM queue_claims`).get() as { n: number }).n, 1);
    for (const table of DISPATCHER_TABLES) {
      if (table === "dispatcher_wakes") continue;
      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        0,
        `${table} must stay empty — no code writes it yet`,
      );
    }
    // dispatcher_wakes IS written, on the aged store like any other: AC15's queue
    // change signal commits with the change. One pending record per subject ticket,
    // and rank+enqueue for the same ticket collapse onto one.
    const wakes = db
      .prepare(`SELECT kind, wake_key, state FROM dispatcher_wakes WHERE project_key = ? ORDER BY wake_key ASC`)
      .all(PK) as { kind: string; wake_key: string; state: string }[];
    assert.deepEqual(wakes, [
      { kind: "queue_changed", wake_key: "ticket:FG-1", state: "pending" },
      { kind: "queue_changed", wake_key: "ticket:FG-2", state: "pending" },
    ]);
  });
});
