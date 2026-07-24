// FG-606 (FG-496 Slice A): store accessors for the DB ticket shadow. Tests run
// REAL store code against a real in-memory SQLite DB (makeInMemoryDb), never
// ~/.forge/forge.db.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  upsertTicket,
  getTicket,
  ticketsForProject,
  upsertTicketRelation,
  relationsForTicket,
  upsertTicketEvent,
  eventsForTicket,
  upsertBlockerEvidence,
  blockerEvidenceForTicket,
  blockerEvidenceId,
  setStorageMode,
  getStorageMode,
  ensureStorageMode,
  bumpIdSequence,
  getIdSequence,
  type TicketRow,
} from "./tickets.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const NOW = "2026-07-24T00:00:00Z";

function ticket(over: Partial<TicketRow> = {}): TicketRow {
  return {
    projectKey: over.projectKey ?? "pk-A",
    ticketId: over.ticketId ?? "FG-123",
    type: over.type ?? "story",
    status: over.status ?? "active",
    title: over.title ?? "a title",
    body: over.body ?? "body text",
    created: over.created ?? "2026-01-01",
    closed: over.closed ?? null,
    closedCommit: over.closedCommit ?? null,
    epic: over.epic ?? null,
    frontmatter: over.frontmatter ?? null,
    importedAt: over.importedAt ?? NOW,
    importedFrom: over.importedFrom ?? null,
  };
}

// AC (1): (project_key, ticket_id) coexistence — FG-123 under two DIFFERENT
// project_keys coexist as distinct rows, no collision.
test("FG-123 coexists under two different project_keys as distinct rows", () => {
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-123", title: "A's ticket" }));
  upsertTicket(ticket({ projectKey: "pk-B", ticketId: "FG-123", title: "B's ticket" }));

  const a = getTicket("pk-A", "FG-123");
  const b = getTicket("pk-B", "FG-123");
  assert.ok(a && b);
  assert.equal(a!.title, "A's ticket");
  assert.equal(b!.title, "B's ticket");
  assert.equal(ticketsForProject("pk-A").length, 1);
  assert.equal(ticketsForProject("pk-B").length, 1);
});

test("upsertTicket is idempotent and overwrites mutable fields on the same key", () => {
  upsertTicket(ticket({ title: "v1", status: "active" }));
  upsertTicket(ticket({ title: "v2", status: "done", closed: "2026-02-02" }));

  const rows = ticketsForProject("pk-A");
  assert.equal(rows.length, 1, "no duplicate row for the same (project_key, ticket_id)");
  assert.equal(rows[0]!.title, "v2");
  assert.equal(rows[0]!.status, "done");
  assert.equal(rows[0]!.closed, "2026-02-02");
});

test("upsertTicket round-trips frontmatter JSON", () => {
  upsertTicket(ticket({ frontmatter: { epic: "FG-593", related: ["FG-1", "FG-2"] } }));
  const got = getTicket("pk-A", "FG-123");
  assert.deepEqual(got!.frontmatter, { epic: "FG-593", related: ["FG-1", "FG-2"] });
});

test("ticket relations UPSERT idempotently on the composite key", () => {
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-1" }));
  upsertTicketRelation({ projectKey: "pk-A", ticketId: "FG-1", relatedId: "FG-2", relType: "related" });
  upsertTicketRelation({ projectKey: "pk-A", ticketId: "FG-1", relatedId: "FG-2", relType: "related" });
  const rels = relationsForTicket("pk-A", "FG-1");
  assert.equal(rels.length, 1);
  assert.equal(rels[0]!.relatedId, "FG-2");
});

test("ticket events UPSERT idempotently on event_key", () => {
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-1" }));
  upsertTicketEvent({
    eventKey: "import:pk-A:FG-1",
    projectKey: "pk-A",
    ticketId: "FG-1",
    eventType: "imported",
    payload: { fileStatus: "blocked" },
    createdAt: NOW,
  });
  upsertTicketEvent({
    eventKey: "import:pk-A:FG-1",
    projectKey: "pk-A",
    ticketId: "FG-1",
    eventType: "imported",
    payload: { fileStatus: "active" },
    createdAt: NOW,
  });
  const events = eventsForTicket("pk-A", "FG-1");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { fileStatus: "active" });
});

// The ticket_events PRIMARY KEY is composite (project_key, ticket_id, event_key),
// NOT a global event_key. The SAME event_key coexists across different
// (project_key, ticket_id) owners — both cross-project and cross-ticket — so a
// future writer cannot collide idempotency keys between projects or tickets.
// Insert directly against the schema: no composite-aware writer exists in Slice A.
test("ticket_events with the same event_key coexist across project and ticket owners", () => {
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-1" }));
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-2" }));
  upsertTicket(ticket({ projectKey: "pk-B", ticketId: "FG-1" }));

  const insert = db.prepare(
    `INSERT INTO ticket_events (event_key, project_key, ticket_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Same event_key across three distinct owners: cross-project (pk-B vs pk-A) and
  // cross-ticket (FG-2 vs FG-1). None must overwrite another.
  insert.run("shared-key", "pk-A", "FG-1", "imported", '{"who":"A/FG-1"}', NOW);
  insert.run("shared-key", "pk-B", "FG-1", "imported", '{"who":"B/FG-1"}', NOW);
  insert.run("shared-key", "pk-A", "FG-2", "imported", '{"who":"A/FG-2"}', NOW);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ticket_events`).get() as { n: number }).n;
  assert.equal(total, 3, "three independent rows persist — no cross-owner overwrite");

  const a1 = eventsForTicket("pk-A", "FG-1");
  const b1 = eventsForTicket("pk-B", "FG-1");
  const a2 = eventsForTicket("pk-A", "FG-2");
  assert.equal(a1.length, 1);
  assert.equal(b1.length, 1);
  assert.equal(a2.length, 1);
  assert.deepEqual(a1[0]!.payload, { who: "A/FG-1" });
  assert.deepEqual(b1[0]!.payload, { who: "B/FG-1" }, "cross-project row is distinct, not overwritten");
  assert.deepEqual(a2[0]!.payload, { who: "A/FG-2" }, "cross-ticket row is distinct, not overwritten");

  // The composite PK still forbids a true duplicate within one owner.
  assert.throws(
    () => insert.run("shared-key", "pk-A", "FG-1", "imported", "{}", NOW),
    /(UNIQUE|PRIMARY KEY)/,
    "same (project_key, ticket_id, event_key) is a genuine duplicate",
  );
});

test("blocker_evidence UPSERTs on the natural key (project_key, ticket_id, source)", () => {
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-9" }));
  const b = {
    projectKey: "pk-A",
    ticketId: "FG-9",
    reason: "legacy blocked",
    source: "import-legacy-blocked",
    createdAt: NOW,
  };
  upsertBlockerEvidence(b);
  upsertBlockerEvidence({ ...b, reason: "legacy blocked (re-import)" });
  const rows = blockerEvidenceForTicket("pk-A", "FG-9");
  assert.equal(rows.length, 1, "re-import does not duplicate evidence");
  assert.equal(rows[0]!.reason, "legacy blocked (re-import)");
  assert.equal(
    blockerEvidenceId("pk-A", "FG-9", "import-legacy-blocked"),
    "blk:pk-A:FG-9:import-legacy-blocked",
  );
});

test("storage mode defaults to markdown and is stored per project_key", () => {
  assert.equal(getStorageMode("pk-unknown"), "markdown", "default when no record");
  ensureStorageMode("pk-A", NOW);
  assert.equal(getStorageMode("pk-A"), "markdown");
  setStorageMode("pk-A", "db", NOW);
  assert.equal(getStorageMode("pk-A"), "db");
  // ensure never downgrades an existing record
  ensureStorageMode("pk-A", NOW);
  assert.equal(getStorageMode("pk-A"), "db");
  // isolation across project_keys
  assert.equal(getStorageMode("pk-B"), "markdown");
});

// The composite FK invariant: dependent rows cannot orphan or cross projects, and
// the status CHECK rejects an out-of-vocabulary value even on a direct write.
test("dependent rows are refused when no matching (project_key, ticket_id) ticket exists", () => {
  assert.throws(
    () => upsertTicketEvent({ eventKey: "e:orphan", projectKey: "pk-A", ticketId: "FG-nope", eventType: "imported", createdAt: NOW }),
    /FOREIGN KEY/,
    "an event with no owning ticket is refused",
  );
  assert.throws(
    () => upsertTicketRelation({ projectKey: "pk-A", ticketId: "FG-nope", relatedId: "FG-2", relType: "related" }),
    /FOREIGN KEY/,
    "a relation with no owning ticket is refused",
  );
  assert.throws(
    () => upsertBlockerEvidence({ projectKey: "pk-A", ticketId: "FG-nope", source: "s", createdAt: NOW }),
    /FOREIGN KEY/,
    "blocker evidence with no owning ticket is refused",
  );
});

test("a dependent row cannot cross projects to a ticket owned by a different project_key", () => {
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-1" }));
  // The ticket exists under pk-A; referencing it under pk-B has no matching parent.
  assert.throws(
    () => upsertTicketEvent({ eventKey: "e:cross", projectKey: "pk-B", ticketId: "FG-1", eventType: "imported", createdAt: NOW }),
    /FOREIGN KEY/,
  );
});

test("deleting a ticket cascades its dependent event/relation/blocker rows", () => {
  upsertTicket(ticket({ projectKey: "pk-A", ticketId: "FG-1" }));
  upsertTicketEvent({ eventKey: "e:A:FG-1", projectKey: "pk-A", ticketId: "FG-1", eventType: "imported", createdAt: NOW });
  upsertTicketRelation({ projectKey: "pk-A", ticketId: "FG-1", relatedId: "FG-2", relType: "related" });
  upsertBlockerEvidence({ projectKey: "pk-A", ticketId: "FG-1", source: "import-legacy-blocked", createdAt: NOW });

  db.prepare(`DELETE FROM tickets WHERE project_key = 'pk-A' AND ticket_id = 'FG-1'`).run();

  assert.equal(eventsForTicket("pk-A", "FG-1").length, 0, "event cascaded");
  assert.equal(relationsForTicket("pk-A", "FG-1").length, 0, "relation cascaded");
  assert.equal(blockerEvidenceForTicket("pk-A", "FG-1").length, 0, "blocker evidence cascaded");
});

test("the status CHECK rejects an out-of-vocabulary value on a direct write", () => {
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at)
           VALUES ('pk-A', 'FG-5', 'story', 'blocked', 't', '', ?)`,
        )
        .run(NOW),
    /CHECK constraint/,
    "'blocked' (and any status outside active/done/deferred) is refused",
  );
});

test("id sequence is monotonic per (project_key, prefix)", () => {
  bumpIdSequence("pk-A", "FG", 10);
  bumpIdSequence("pk-A", "FG", 5); // lower — ignored
  assert.equal(getIdSequence("pk-A", "FG"), 10);
  bumpIdSequence("pk-A", "FG", 42);
  assert.equal(getIdSequence("pk-A", "FG"), 42);
  // per-prefix isolation
  bumpIdSequence("pk-A", "MG", 3);
  assert.equal(getIdSequence("pk-A", "MG"), 3);
  assert.equal(getIdSequence("pk-A", "FG"), 42);
  assert.equal(getIdSequence("pk-A", "ZZ"), undefined);
});
