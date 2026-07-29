// FG-608 (reopen) — the ticket_events CONSTRAINT-shape rebuild.
//
// THE FAILURE THIS EXISTS TO PREVENT. `forge backlog migrate` died on the dogfood
// host with "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
// constraint". Every COLUMN was present, so the column-parity guard was green: the
// host's ticket_events carried a PRIMARY KEY of event_key ALONE. CREATE TABLE IF NOT
// EXISTS no-ops over a table that already exists whatever its constraints, no
// migration rebuilt shape, and upsertTicketEvent's ON CONFLICT(project_key,
// ticket_id, event_key) was therefore rejected at PREPARE time — on exactly the
// databases that matter and none of the ones CI builds.
//
// The fixture below is the observed host DDL, FIXED — literal text, never derived
// from SCHEMA_SQL. A fixture synthesized from today's schema carries today's
// constraints by construction, which is precisely why the existing parity guard
// could not express this divergence at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, rebuildTicketEventsIfDivergent, ticketEventsShapeDivergence, setDbForTest } from "./db.js";
import { upsertTicketEvent, eventsForTicket } from "./tickets.js";

const HOST_TICKET_EVENTS_DDL = `
  CREATE TABLE ticket_events (
    event_key   TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    ticket_id   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    payload     TEXT,
    created_at  TEXT NOT NULL
  )
`;

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type EventRow = {
  event_key: string;
  project_key: string;
  ticket_id: string;
  event_type: string;
  payload: string | null;
  created_at: string;
};

function tableNames(db: DatabaseInstance): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function shapeOf(db: DatabaseInstance, table: string): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const c of db.prepare(`PRAGMA table_info(${table})`).all() as Col[]) {
    shape[c.name] = `${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "NULL"} pk=${c.pk}`;
  }
  return shape;
}

function primaryKeyOf(db: DatabaseInstance, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Col[])
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

// Table identity as well as text: rootpage changes when a table is rebuilt, so an
// unchanged sqlite_master snapshot is proof no rebuild ran.
function schemaSnapshot(db: DatabaseInstance): { name: string; type: string; sql: string | null; rootpage: number }[] {
  return db
    .prepare(`SELECT name, type, sql, rootpage FROM sqlite_master ORDER BY type, name`)
    .all() as { name: string; type: string; sql: string | null; rootpage: number }[];
}

// Just the ticket_events objects: applyMigrations legitimately advances OTHER tables
// before it reaches the rebuild, so a rolled-back rebuild is proven by this table's
// own sqlite_master rows (its temp table included), not by the whole schema.
function ticketEventsSchema(db: DatabaseInstance): { name: string; type: string; sql: string | null; rootpage: number }[] {
  return schemaSnapshot(db).filter((o) => o.name.startsWith("ticket_events"));
}

function events(db: DatabaseInstance): EventRow[] {
  return db
    .prepare(`SELECT event_key, project_key, ticket_id, event_type, payload, created_at FROM ticket_events
              ORDER BY project_key, ticket_id, event_key`)
    .all() as EventRow[];
}

function freshDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

// A store written by a binary whose ticket_events carried the divergent shape: the
// host DDL FIRST, so SCHEMA_SQL's CREATE hits the same no-op path production did,
// then the rest of the schema, then rows. The caller opens it (SCHEMA_SQL +
// applyMigrations) to simulate today's binary.
function hostShapedDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(HOST_TICKET_EVENTS_DDL);
  db.exec(SCHEMA_SQL);

  const ticket = db.prepare(
    `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at)
     VALUES (?, ?, 'story', 'active', 'a title', 'body', '2026-07-01T00:00:00Z')`,
  );
  ticket.run("pk-A", "FG-1");
  ticket.run("pk-B", "FG-1");

  const event = db.prepare(
    `INSERT INTO ticket_events (event_key, project_key, ticket_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  event.run("evt-a", "pk-A", "FG-1", "imported", '{"fileStatus":"active"}', "2026-07-01T00:00:00Z");
  event.run("evt-b", "pk-B", "FG-1", "imported", null, "2026-07-02T00:00:00Z");
  event.run("evt-c", "pk-A", "FG-1", "closed", '{"commit":"deadbeef"}', "2026-07-03T00:00:00Z");
  // An event whose ticket is absent: legal under the old shape (no FK), and the
  // rebuild must carry it rather than silently drop audit history.
  event.run("evt-orphan", "pk-C", "FG-9", "imported", '{"orphan":true}', "2026-07-04T00:00:00Z");
  return db;
}

test("FG-608: the host's single-column-PK ticket_events rebuilds to the canonical shape", () => {
  const db = hostShapedDb();
  assert.deepEqual(primaryKeyOf(db, "ticket_events"), ["event_key"], "precondition: the fixture must carry the divergent PK");
  assert.match(
    ticketEventsShapeDivergence(db) ?? "",
    /PRIMARY KEY is \(event_key\)/,
    "precondition: the divergence must be detected, or this test proves nothing",
  );
  const before = events(db);

  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  assert.equal(ticketEventsShapeDivergence(db), null, "the rebuilt table must be canonical");
  assert.deepEqual(primaryKeyOf(db, "ticket_events"), ["project_key", "ticket_id", "event_key"]);

  // Full parity with a fresh DB — columns AND constraints, for every table.
  const fresh = freshDb();
  assert.deepEqual(tableNames(db), tableNames(fresh));
  for (const table of tableNames(fresh)) {
    assert.deepEqual(shapeOf(db, table), shapeOf(fresh, table), `${table}: column shape diverges from fresh`);
    assert.deepEqual(primaryKeyOf(db, table), primaryKeyOf(fresh, table), `${table}: PK diverges from fresh`);
  }
  const fk = db.prepare(`PRAGMA foreign_key_list(ticket_events)`).all() as { table: string; from: string; on_delete: string }[];
  assert.deepEqual(
    fk.map((f) => `${f.table}.${f.from}/${f.on_delete}`).sort(),
    ["tickets.project_key/CASCADE", "tickets.ticket_id/CASCADE"],
    "the canonical composite FK must be present after the rebuild",
  );
  assert.ok(
    (db.prepare(`PRAGMA index_list(ticket_events)`).all() as { name: string }[]).some(
      (i) => i.name === "idx_ticket_events_ticket",
    ),
    "idx_ticket_events_ticket must be recreated on the rebuilt table",
  );

  // Every row preserved — payload, timestamps, the cross-project row, the orphan.
  assert.deepEqual(events(db), before, "the rebuild must preserve every row byte for byte");
  assert.equal(before.length, 4);
  assert.equal(db.pragma("user_version", { simple: true }), 0, "the rebuild never bumps user_version");

  // The statement that could not even PREPARE on the host, through the real accessor.
  const prev = setDbForTest(db);
  let updated: string[] = [];
  let otherOwner = 0;
  try {
    upsertTicketEvent({
      eventKey: "evt-a",
      projectKey: "pk-A",
      ticketId: "FG-1",
      eventType: "reimported",
      payload: { fileStatus: "done" },
      createdAt: "2026-07-29T00:00:00Z",
    });
    // The same event_key under a DIFFERENT owner is a distinct row, not a conflict.
    upsertTicketEvent({
      eventKey: "evt-a",
      projectKey: "pk-B",
      ticketId: "FG-1",
      eventType: "imported",
      payload: null,
      createdAt: "2026-07-29T00:00:00Z",
    });
    updated = eventsForTicket("pk-A", "FG-1").map((e) => `${e.eventKey}:${e.eventType}`);
    otherOwner = eventsForTicket("pk-B", "FG-1").length;
  } finally {
    setDbForTest(prev as DatabaseInstance);
  }

  assert.deepEqual(
    updated,
    ["evt-c:closed", "evt-a:reimported"], // eventsForTicket orders by created_at; the upsert restamped evt-a
    "the ON CONFLICT DO UPDATE path must update in place, not duplicate",
  );
  assert.equal(otherOwner, 2, "the same event_key under a different owner is a distinct row");

  db.close();
  fresh.close();
});

test("FG-608: a second open of a rebuilt DB rebuilds nothing and mutates nothing", () => {
  const db = hostShapedDb();
  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  const schema = schemaSnapshot(db);
  const rows = events(db);

  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  assert.equal(rebuildTicketEventsIfDivergent(db), false, "a canonical table must not be rebuilt again");
  assert.deepEqual(schemaSnapshot(db), schema, "the second open must leave sqlite_master identical (rootpage included)");
  assert.deepEqual(events(db), rows, "the second open must leave every row untouched");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "additive migrations never bump user_version");

  db.close();
});

test("FG-608: a rebuild that cannot copy rolls back whole — table, rows, no temp table", () => {
  // A divergent shape with NO primary key at all, carrying two rows that share
  // (project_key, ticket_id, event_key). The copy into the canonical composite PK
  // must fail partway, and the whole rebuild must roll back.
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ticket_events (
      event_key   TEXT NOT NULL,
      project_key TEXT NOT NULL,
      ticket_id   TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     TEXT,
      created_at  TEXT NOT NULL
    )
  `);
  db.exec(SCHEMA_SQL);
  const insert = db.prepare(
    `INSERT INTO ticket_events (event_key, project_key, ticket_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("dup", "pk-A", "FG-1", "imported", '{"n":1}', "2026-07-01T00:00:00Z");
  insert.run("dup", "pk-A", "FG-1", "imported", '{"n":2}', "2026-07-02T00:00:00Z");
  insert.run("solo", "pk-A", "FG-1", "closed", null, "2026-07-03T00:00:00Z");

  const schema = ticketEventsSchema(db);
  const rows = events(db);
  assert.equal(rows.length, 3);

  assert.throws(
    () => applyMigrations(db),
    /could not rebuild ticket_events into its canonical constraint shape/,
    "an uncopyable table must fail loudly, not half-rebuild",
  );

  assert.deepEqual(ticketEventsSchema(db), schema, "the original table must survive the rollback unchanged");
  assert.deepEqual(events(db), rows, "every row must survive the rollback");
  assert.equal(
    db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'ticket_events__%'`).get(),
    undefined,
    "no temp rebuild table may be left behind",
  );

  db.close();
});
