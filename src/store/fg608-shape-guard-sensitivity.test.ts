// FG-608 (reopen) — CAN THE GUARD FAIL?
//
// A guard that cannot fail is not a guard. The constraint-shape work added two:
// the production detector (ticketEventsShapeDivergence, which decides whether to
// rebuild) and the fresh-vs-migrated CONSTRAINT comparison in
// fg608-migration-parity.test.ts. Both are asserted GREEN elsewhere; green is
// exactly what a guard that has stopped looking also reports.
//
// So every case here is a deliberate mutation of the shape, and each one is held to
// three claims: the detector NAMES the divergence, the parity comparison REPORTS it
// as unequal to a fresh DB (the assertion that would fire), and a real open
// converges it with every row intact.
//
// The mutations are not variations on one theme. The detector inspects PK
// membership AND ordering, UNIQUE/index shape, and the composite FK — so there is a
// case per branch, including two that are canonical in every respect the ORIGINAL
// host bug exercised (a same-membership PK in the wrong order, and a correct FK
// without ON DELETE CASCADE) and would sail past a PK-membership-only check.
//
// The last test is the boundary: the rebuild converges ticket_events and nothing
// else, so a divergence in any OTHER table survives a full open. That is not a
// complaint — it is what makes the parity comparison the thing that catches the
// next one, and it is asserted here so a future reader knows which mechanism is
// load-bearing where.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, rebuildTicketEventsIfDivergent, ticketEventsShapeDivergence } from "./db.js";

type Col = { name: string; pk: number };
type EventRow = {
  event_key: string;
  project_key: string;
  ticket_id: string;
  event_type: string;
  payload: string | null;
  created_at: string;
};

// The same fingerprint the parity guard compares: PK membership AND ordering,
// index shape (name, uniqueness, origin, partiality, columns) and foreign keys.
// Deliberately a copy rather than an import — the guard's version lives inside a
// test file and exports nothing, and a shared helper would let one edit weaken
// both at once.
function constraintsOf(db: DatabaseInstance, table: string): Record<string, string[]> {
  const pk = (db.prepare(`PRAGMA table_info(${table})`).all() as Col[])
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
      return `${i.name} unique=${i.unique} origin=${i.origin} partial=${i.partial} (${cols.join(", ")})`;
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

function events(db: DatabaseInstance): EventRow[] {
  return db
    .prepare(
      `SELECT event_key, project_key, ticket_id, event_type, payload, created_at FROM ticket_events
        ORDER BY project_key, ticket_id, event_key`,
    )
    .all() as EventRow[];
}

function freshDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

const CANONICAL_INDEX = `CREATE INDEX idx_ticket_events_ticket ON ticket_events(project_key, ticket_id)`;

// Every DDL below is LITERAL. Deriving one from SCHEMA_SQL would give it today's
// constraints by construction, which is precisely how the host's divergence stayed
// invisible to a guard built on a synthesized fixture.
const DIVERGENT_SHAPES: { name: string; ddl: string; expect: RegExp }[] = [
  {
    name: "the host's single-column PK",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT PRIMARY KEY, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL)`,
    expect: /PRIMARY KEY is \(event_key\), canonical is \(project_key, ticket_id, event_key\)/,
  },
  {
    name: "the right PK columns in the wrong ORDER",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (event_key, project_key, ticket_id),
      FOREIGN KEY (project_key, ticket_id) REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE);
      ${CANONICAL_INDEX}`,
    expect: /PRIMARY KEY is \(event_key, project_key, ticket_id\)/,
  },
  {
    name: "a PK missing event_key entirely",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_id));
      ${CANONICAL_INDEX}`,
    expect: /PRIMARY KEY is \(project_key, ticket_id\)/,
  },
  {
    name: "no PRIMARY KEY at all",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
      ${CANONICAL_INDEX}`,
    expect: /PRIMARY KEY is \(none\)/,
  },
  {
    name: "the canonical PK plus a stray UNIQUE index",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_id, event_key),
      FOREIGN KEY (project_key, ticket_id) REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE);
      ${CANONICAL_INDEX};
      CREATE UNIQUE INDEX ux_ticket_events_event_key ON ticket_events(event_key)`,
    expect: /unexpected UNIQUE index: ux_ticket_events_event_key/,
  },
  {
    name: "the canonical PK with the lookup index missing",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_id, event_key),
      FOREIGN KEY (project_key, ticket_id) REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE)`,
    expect: /idx_ticket_events_ticket is missing/,
  },
  {
    name: "the canonical PK with NO foreign key",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_id, event_key));
      ${CANONICAL_INDEX}`,
    expect: /FOREIGN KEY shape is \[\]/,
  },
  {
    name: "the composite FK without ON DELETE CASCADE",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_id, event_key),
      FOREIGN KEY (project_key, ticket_id) REFERENCES tickets(project_key, ticket_id));
      ${CANONICAL_INDEX}`,
    expect: /ON DELETE NO ACTION/,
  },
  {
    name: "a single-column FK where the composite one belongs",
    ddl: `CREATE TABLE ticket_events (
      event_key TEXT NOT NULL, project_key TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_id, event_key),
      FOREIGN KEY (project_key) REFERENCES tickets(project_key) ON DELETE CASCADE);
      ${CANONICAL_INDEX}`,
    expect: /FOREIGN KEY shape is \[tickets\(project_key\) <- project_key ON DELETE CASCADE\]/,
  },
];

// Rows chosen to be legal under EVERY shape above — including the one that makes
// (project_key, ticket_id) unique and the one that makes event_key globally unique
// — so a case can never pass because its fixture failed to seed. One row is an
// orphan (no tickets parent), which only the FK-less shapes permit and which the
// rebuild must carry regardless.
const SEED_ROWS: readonly (readonly [string, string, string, string, string | null, string])[] = [
  ["evt-1", "pk-a", "FG-1", "imported", null, "2026-07-01T00:00:00Z"],
  ["evt-2", "pk-b", "FG-2", "closed", '{"n":2,"s":"it\'s \\"quoted\\""}', "2026-07-02T00:00:00Z"],
];

test("FG-608: the detector reports nothing on a canonical store — it is not a constant", () => {
  const fresh = freshDb();
  assert.equal(ticketEventsShapeDivergence(fresh), null);
  assert.equal(rebuildTicketEventsIfDivergent(fresh), false, "a canonical table must never be rebuilt");
  // And an absent table is not a divergence — SCHEMA_SQL creates it canonically.
  const empty = new Database(":memory:");
  assert.equal(ticketEventsShapeDivergence(empty), null, "no ticket_events at all must not be reported as divergent");
  empty.close();
  fresh.close();
});

for (const shape of DIVERGENT_SHAPES) {
  test(`FG-608 (shape guard): ${shape.name} is detected, reported as unequal to fresh, and converged`, () => {
    const fresh = freshDb();
    // The divergent table ALONE first, and the detector is read before SCHEMA_SQL
    // runs: SCHEMA_SQL legitimately heals one of these shapes (its
    // `CREATE INDEX IF NOT EXISTS` restores a missing lookup index), so the
    // detector has to be seen against the shape as the old binary wrote it.
    const db = new Database(":memory:");
    // Explicitly OFF: better-sqlite3 opens with foreign_keys ON, and these rows
    // predate the parent table (one of them has no parent at all). This is the
    // state the old binary wrote them in, and it is why orphans exist to carry.
    db.pragma("foreign_keys = OFF");
    db.exec(shape.ddl);
    const insert = db.prepare(
      `INSERT INTO ticket_events (event_key, project_key, ticket_id, event_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of SEED_ROWS) insert.run(...row);
    const before = events(db);
    assert.equal(before.length, SEED_ROWS.length, "precondition: the fixture rows must be seeded");

    // CLAIM 1 — the production detector names it.
    const divergence = ticketEventsShapeDivergence(db);
    assert.notEqual(divergence, null, "precondition: an undetected divergence is a silent one");
    assert.match(divergence ?? "", shape.expect);

    // CLAIM 2 — the parity comparison would FIRE on it. This is the mutation: the
    // assertion fg608-migration-parity.test.ts makes must be capable of failing,
    // and here is a shape that fails it.
    assert.notDeepEqual(
      constraintsOf(db, "ticket_events"),
      constraintsOf(fresh, "ticket_events"),
      "the constraint comparison must report this shape as unequal to a fresh DB",
    );

    // CLAIM 3 — a real open converges it, with every row intact. SCHEMA_SQL first
    // (creating every other table, and no-opping over ticket_events exactly as it
    // did on the host), then a parent ticket for one of the rows so the copy is
    // exercised with a mix of referenced and orphaned rows, then the migrations.
    db.exec(SCHEMA_SQL);
    db.prepare(
      `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at)
       VALUES ('pk-a', 'FG-1', 'story', 'active', 't', 'b', '2026-07-01T00:00:00Z')`,
    ).run();
    db.pragma("foreign_keys = ON"); // as getDb() opens it
    applyMigrations(db);

    assert.equal(ticketEventsShapeDivergence(db), null, "the open must converge this shape");
    assert.deepEqual(
      constraintsOf(db, "ticket_events"),
      constraintsOf(fresh, "ticket_events"),
      "and the converged table must match a fresh DB's constraint shape exactly",
    );
    assert.deepEqual(events(db), before, "every row must survive — orphan, NULL payload and quoted JSON included");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1, "foreign_keys must be restored after a rebuild");
    assert.equal(db.pragma("user_version", { simple: true }), 0, "a rebuild never bumps user_version");
    assert.equal(rebuildTicketEventsIfDivergent(db), false, "and converging is idempotent");

    db.close();
    fresh.close();
  });
}

test("FG-608: the rebuild's remit is ticket_events ALONE — the parity comparison is what catches any other table", () => {
  // ticket_relations with the same class of defect: a PK that CREATE TABLE IF NOT
  // EXISTS will never fix and no ALTER can change. Nothing in applyMigrations
  // rebuilds this table, so the divergence survives a full open — and the guard
  // that has to notice is the fresh-vs-migrated CONSTRAINT comparison.
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE ticket_relations (
    project_key TEXT NOT NULL, ticket_id TEXT NOT NULL, related_id TEXT NOT NULL, rel_type TEXT NOT NULL,
    PRIMARY KEY (project_key, ticket_id))`);
  db.exec(SCHEMA_SQL);
  db.pragma("foreign_keys = ON");
  applyMigrations(db);

  const fresh = freshDb();
  assert.deepEqual(
    constraintsOf(db, "ticket_events"),
    constraintsOf(fresh, "ticket_events"),
    "ticket_events is still converged — this test must not pass because the open failed",
  );
  assert.notDeepEqual(
    constraintsOf(db, "ticket_relations"),
    constraintsOf(fresh, "ticket_relations"),
    "an unrepaired divergence in another table must be VISIBLE to the constraint comparison — " +
      "if this ever stops being unequal, either the rebuild grew a second table (good, retarget this test) " +
      "or the comparison stopped looking (bad)",
  );

  db.close();
  fresh.close();
});
