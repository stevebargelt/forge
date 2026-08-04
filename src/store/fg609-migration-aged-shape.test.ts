// FG-609 (FG-496 Slice D) — A10 / A12 / A14: forward-open safety against a
// HAND-AUTHORED AGED-CONSTRAINT FIXTURE, and lossless enrichment of the Slice A
// rows that fixture carries.
//
// ─── WHY THE FIXTURE IS HAND-AUTHORED ────────────────────────────────────────
// Every test DB in this repo is created FRESH from SCHEMA_SQL, so a column present
// in a CREATE but missing its guarded ALTER stays green across the ENTIRE suite and
// fails only on the aged host DB — that is exactly what reopened FG-608.
//
// The obvious fix (build the "old" DB by DROPping columns off today's fresh
// schema) does NOT close it, and is deliberately not what this file does. A
// drop-from-fresh fixture carries TODAY'S CONSTRAINTS by construction: today's PK
// membership, today's UNIQUE shape, today's FK. The dogfood host's real defect was
// a ticket_events table with a SINGLE-COLUMN primary key — a constraint shape no
// amount of column dropping can produce — and that is precisely why it stayed
// invisible. So the DDL below is written out by hand, in the shape a pre-Slice-D
// binary actually created, and the migration path is then asked to bring it
// forward and SERVE EVERY NEW READ/WRITE PATH.
//
// Column-presence parity alone does NOT satisfy A10: fg608-migration-parity.test.ts
// already proves that generically for every table. This file proves the aged DB
// WORKS — rank, enqueue, reorder, readiness, queue history — which is the thing a
// column census cannot tell you.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, setDbForTest, writeTransaction } from "./db.js";
import {
  blockerEvidenceForTicket,
  getTicket,
  upsertBlockerEvidence,
  LEGACY_BLOCKED_SOURCE,
} from "./tickets.js";
import { dependencyBlockerSource } from "./blocked-source.js";
import {
  enqueueTicket,
  dequeueTicket,
  executableQueue,
  moveQueuePosition,
  queueEvents,
  rankTicket,
  rankedOrder,
  readinessView,
  recheckReadiness,
  unrankTicket,
} from "./queue.js";

const PK = "pk-aged";
const AGED_AT = "2026-03-04T05:06:07.000Z";

const READY_BODY = [
  "## Problem",
  "An aged store must open.",
  "",
  "## Goal",
  "It opens, migrates, and serves every new path.",
  "",
  "## Acceptance Criteria",
  "- it opens",
].join("\n");

// The store as a PRE-SLICE-D binary wrote it. Hand-authored, with the aged
// CONSTRAINT shapes, not a stripped copy of today's:
//
//   tickets            — no priority_rank; and no CHECK on status, because the
//                        CHECK arrived with FG-606 and an older row is not bound
//                        by it. A drop-from-fresh fixture would carry it.
//   blocker_evidence   — the Slice A five columns only (no kind / detail /
//                        body_hash / queue_projection), with the natural-key
//                        UNIQUE it has always had.
//   ticket_events      — the DOGFOOD HOST'S SINGLE-COLUMN PRIMARY KEY. Kept in the
//                        fixture on purpose: it is the shape that proves this
//                        fixture is genuinely aged rather than a fresh one with
//                        columns removed, and the FG-608 rebuild has to converge it
//                        before any of Slice D's paths run.
//   tasks / runs /     — the minimum the derived in_progress projection joins
//   ticket_dispatch_…    against, at their aged shapes.
//
// No queue_membership, no readiness_assessments, no queue_events: those tables do
// not exist at all in an aged store, which is the other half of forward-open safety.
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
CREATE INDEX idx_blocker_evidence_ticket ON blocker_evidence(project_key, ticket_id);

CREATE TABLE ticket_events (
  event_key   TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE ticket_relations (
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  related_id  TEXT NOT NULL,
  rel_type    TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id, related_id, rel_type)
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

/** An aged store with real Slice A rows in it, opened exactly as a real open
 *  does: SCHEMA_SQL (whose CREATEs no-op over the existing tables — the very
 *  reason the FG-608 bug was invisible) followed by applyMigrations. */
function agedThenMigrated(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(AGED_SCHEMA_SQL);

  const ins = db.prepare(
    `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, created, imported_at)
     VALUES (?, ?, 'story', 'active', ?, ?, '2026-01-01', ?)`,
  );
  ins.run(PK, "FG-1", "aged one", READY_BODY, AGED_AT);
  ins.run(PK, "FG-2", "aged two", READY_BODY, AGED_AT);
  ins.run(PK, "FG-3", "aged three", READY_BODY, AGED_AT);

  // The Slice A legacy blocked row, written the aged way: five columns, no kind.
  db.prepare(
    `INSERT INTO blocker_evidence (id, project_key, ticket_id, reason, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `blk:${PK}:FG-3:${LEGACY_BLOCKED_SOURCE}`,
    PK,
    "FG-3",
    "blocked on an upstream decision, recorded before Slice D existed",
    LEGACY_BLOCKED_SOURCE,
    AGED_AT,
  );

  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function withAgedDb<T>(fn: (db: DatabaseInstance) => T): T {
  const db = agedThenMigrated();
  const prev = setDbForTest(db);
  try {
    return fn(db);
  } finally {
    setDbForTest(prev as DatabaseInstance);
    db.close();
  }
}

// ─── A10: the aged DB opens, migrates, and SERVES every new path ────────────

test("FG-609 A10: an aged store opens and serves rank / enqueue / reorder / dequeue end to end", () => {
  withAgedDb(() => {
    // rank
    rankTicket(PK, "FG-1");
    rankTicket(PK, "FG-2");
    rankTicket(PK, "FG-3", 1);
    assert.deepEqual(rankedOrder(PK).map((r) => [r.ticketId, r.rank]), [
      ["FG-3", 1], ["FG-1", 2], ["FG-2", 3],
    ]);

    // enqueue — including the readiness evaluation and its persisted assessment
    assert.equal(enqueueTicket(PK, "FG-1").ok, true);
    assert.equal(enqueueTicket(PK, "FG-2").ok, true);
    assert.equal(readinessView(PK, "FG-1")?.outcome, "ready");
    assert.equal(readinessView(PK, "FG-1")?.stale, false);

    // FG-3 carries the aged legacy blocked row, so it evaluates 'blocked' and is
    // REFUSED — with a concrete reason, on an aged store.
    const refused = enqueueTicket(PK, "FG-3");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /Ticket is marked blocked/);

    // reorder
    moveQueuePosition(PK, "FG-2", 1);
    assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-2", "FG-1"]);

    // dequeue, then unrank
    dequeueTicket(PK, "FG-1");
    assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-2"]);
    unrankTicket(PK, "FG-1");
    assert.equal(getTicket(PK, "FG-1")!.priorityRank, null);

    // the append-only history survived every one of those
    const types = queueEvents(PK).map((e) => e.eventType);
    for (const t of ["rank", "enqueue", "readiness", "reorder", "dequeue", "unrank"]) {
      assert.ok(types.includes(t as never), `an aged store must append '${t}' events too`);
    }
  });
});

test("FG-609 A10: the aged fixture is genuinely aged — its ticket_events PK is single-column pre-open", () => {
  // Guards the fixture itself. A drop-from-fresh construction cannot produce this
  // shape, so if this ever stops holding, the fixture has silently become a fresh
  // one and A10's whole point is gone.
  const raw = new Database(":memory:");
  raw.exec(AGED_SCHEMA_SQL);
  const pk = (raw.prepare(`PRAGMA table_info(ticket_events)`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .map((c) => c.name);
  assert.deepEqual(pk, ["event_key"], "the fixture must carry the dogfood host's aged constraint shape");
  raw.close();

  // ...and the open path converges it, which is what lets the rest of this file run.
  withAgedDb((db) => {
    const converged = (db.prepare(`PRAGMA table_info(ticket_events)`).all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    assert.deepEqual(converged, ["project_key", "ticket_id", "event_key"]);
  });
});

test("FG-609 A10: the aged store gains the queue tables and the new columns", () => {
  withAgedDb((db) => {
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (t) => t.name,
      ),
    );
    for (const t of ["queue_membership", "readiness_assessments", "queue_events"]) {
      assert.ok(tables.has(t), `${t} must arrive whole via CREATE TABLE IF NOT EXISTS`);
    }
    const ticketCols = (db.prepare(`PRAGMA table_info(tickets)`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(ticketCols.includes("priority_rank"), "the guarded ALTER must add priority_rank to an aged tickets");
    const evidenceCols = (db.prepare(`PRAGMA table_info(blocker_evidence)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of ["kind", "detail", "body_hash", "queue_projection"]) {
      assert.ok(evidenceCols.includes(c), `the guarded ALTER must add blocker_evidence.${c}`);
    }
  });
});

// ─── A12: every Slice A legacy row is preserved without loss ────────────────

test("FG-609 A12: the aged legacy blocked row keeps its fact, reason, source and created_at", () => {
  withAgedDb(() => {
    const rows = blockerEvidenceForTicket(PK, "FG-3");
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.source, LEGACY_BLOCKED_SOURCE);
    assert.equal(row.reason, "blocked on an upstream decision, recorded before Slice D existed");
    assert.equal(row.createdAt, AGED_AT, "the preserved 'blocked since' timestamp survives the migration");
    // The enrichment classifies it correctly with NO backfill, purely from the
    // column DEFAULT — which is what makes it lossless.
    assert.equal(row.kind, "legacy_blocked");
    assert.equal(row.detail, null);
    assert.equal(row.bodyHash, null);
    assert.equal(row.queueProjection, null);
  });
});

test("FG-609 A12: 'blocked since' survives later queue and enrichment writes", () => {
  withAgedDb(() => {
    // A whole slice's worth of activity lands on the same ticket...
    rankTicket(PK, "FG-3");
    assert.equal(enqueueTicket(PK, "FG-3").ok, false);
    recheckReadiness(PK, "FG-3");
    writeTransaction(() =>
      upsertBlockerEvidence({
        projectKey: PK,
        ticketId: "FG-3",
        reason: "also waits on FG-77",
        source: dependencyBlockerSource("FG-77"),
        createdAt: "2026-08-04T00:00:00.000Z",
        kind: "dependency",
        detail: { dependency: "FG-77" },
        queueProjection: "blocked",
      }),
    );

    const rows = blockerEvidenceForTicket(PK, "FG-3");
    assert.equal(rows.length, 2, "the enriched row is ADDED, never merged over the legacy one");
    const legacy = rows.find((r) => r.source === LEGACY_BLOCKED_SOURCE)!;
    assert.equal(legacy.createdAt, AGED_AT);
    assert.equal(legacy.reason, "blocked on an upstream decision, recorded before Slice D existed");
    assert.equal(legacy.kind, "legacy_blocked");
  });
});

// ─── A14: additive only ─────────────────────────────────────────────────────

test("FG-609 A14: opening an aged store does not bump user_version", () => {
  withAgedDb((db) => {
    assert.equal(db.pragma("user_version", { simple: true }), 0);
  });
});

test("FG-609 A14: tickets.priority_rank is left UNINDEXED, so it stays ALTER-droppable", () => {
  withAgedDb((db) => {
    const indexes = db.prepare(`PRAGMA index_list(tickets)`).all() as { name: string }[];
    for (const idx of indexes) {
      const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string | null }[]).map(
        (c) => c.name,
      );
      assert.equal(
        cols.includes("priority_rank"),
        false,
        `${idx.name} indexes priority_rank — that pins it undroppable and shrinks the FG-608 parity guard`,
      );
    }
    // Positively: SQLite will actually drop it.
    const probe = new Database(":memory:");
    probe.exec(SCHEMA_SQL);
    applyMigrations(probe);
    probe.exec(`ALTER TABLE tickets DROP COLUMN priority_rank`);
    probe.close();
  });
});

test("FG-609 A14: re-running the open path on an already-migrated aged store is a no-op", () => {
  withAgedDb((db) => {
    const shape = () =>
      JSON.stringify(
        (db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all() as {
          name: string;
          sql: string | null;
        }[]),
      );
    const before = shape();
    db.exec(SCHEMA_SQL);
    applyMigrations(db);
    assert.equal(shape(), before);
  });
});
