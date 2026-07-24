// FG-606 (FG-496 Slice A): store accessors for the DB ticket shadow. All rows are
// keyed by (project_key, ticket_id). Every write is an idempotent UPSERT so a
// pre-cutover re-import (DB mirrors authoritative Markdown) never duplicates or
// drifts. Nothing READS these for product behavior in Slice A — the DB is a
// write-only shadow; Markdown stays the sole source of truth.
//
// These helpers call getDb() directly, so a caller that wraps them in
// writeTransaction() (the import orchestrator does) executes every statement
// inside that one BEGIN IMMEDIATE — partial failure rolls back whole.

import { getDb } from "./db.js";

export type DbTicketStatus = "active" | "done" | "deferred";
// Open vocabulary — bug/story/epic/idea today, but stored as free TEXT so a new
// type never needs a migration (enum-as-convention, FG-585 precedent).
export type DbTicketType = string;

export type TicketRow = {
  projectKey: string;
  ticketId: string;
  type: DbTicketType;
  status: DbTicketStatus;
  title: string;
  body: string;
  created?: string | null;
  closed?: string | null;
  closedCommit?: string | null;
  epic?: string | null;
  frontmatter?: Record<string, unknown> | null;
  importedAt: string;
  // Canonical source directory (realpath) this ticket was last imported from — the
  // reconcile provenance key (see schema.ts). Nullable for non-import upserts.
  importedFrom?: string | null;
};

type TicketDbRow = {
  project_key: string;
  ticket_id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  created: string | null;
  closed: string | null;
  closed_commit: string | null;
  epic: string | null;
  frontmatter: string | null;
  imported_at: string;
  imported_from: string | null;
};

function rowToTicket(row: TicketDbRow): TicketRow {
  return {
    projectKey: row.project_key,
    ticketId: row.ticket_id,
    type: row.type,
    status: row.status as DbTicketStatus,
    title: row.title,
    body: row.body,
    created: row.created,
    closed: row.closed,
    closedCommit: row.closed_commit,
    epic: row.epic,
    frontmatter: row.frontmatter ? (JSON.parse(row.frontmatter) as Record<string, unknown>) : null,
    importedAt: row.imported_at,
    importedFrom: row.imported_from,
  };
}

// UPSERT keyed by the (project_key, ticket_id) primary key. Re-importing the same
// ticket overwrites every mutable field; it never inserts a duplicate row.
export function upsertTicket(t: TicketRow): void {
  getDb()
    .prepare(
      `INSERT INTO tickets
         (project_key, ticket_id, type, status, title, body, created, closed, closed_commit, epic, frontmatter, imported_at, imported_from)
       VALUES (@projectKey, @ticketId, @type, @status, @title, @body, @created, @closed, @closedCommit, @epic, @frontmatter, @importedAt, @importedFrom)
       ON CONFLICT(project_key, ticket_id) DO UPDATE SET
         type = excluded.type,
         status = excluded.status,
         title = excluded.title,
         body = excluded.body,
         created = excluded.created,
         closed = excluded.closed,
         closed_commit = excluded.closed_commit,
         epic = excluded.epic,
         frontmatter = excluded.frontmatter,
         imported_at = excluded.imported_at,
         imported_from = excluded.imported_from`,
    )
    .run({
      projectKey: t.projectKey,
      ticketId: t.ticketId,
      type: t.type,
      status: t.status,
      title: t.title,
      body: t.body,
      created: t.created ?? null,
      closed: t.closed ?? null,
      closedCommit: t.closedCommit ?? null,
      epic: t.epic ?? null,
      frontmatter: t.frontmatter ? JSON.stringify(t.frontmatter) : null,
      importedAt: t.importedAt,
      importedFrom: t.importedFrom ?? null,
    });
}

export function getTicket(projectKey: string, ticketId: string): TicketRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM tickets WHERE project_key = ? AND ticket_id = ?`)
    .get(projectKey, ticketId) as TicketDbRow | undefined;
  return row ? rowToTicket(row) : undefined;
}

export function ticketsForProject(projectKey: string): TicketRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tickets WHERE project_key = ? ORDER BY ticket_id ASC`)
    .all(projectKey) as TicketDbRow[];
  return rows.map(rowToTicket);
}

// ─── ticket relations ────────────────────────────────────────────────────────

export type TicketRelation = {
  projectKey: string;
  ticketId: string;
  relatedId: string;
  relType: string;
};

export function upsertTicketRelation(r: TicketRelation): void {
  getDb()
    .prepare(
      `INSERT INTO ticket_relations (project_key, ticket_id, related_id, rel_type)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_key, ticket_id, related_id, rel_type) DO NOTHING`,
    )
    .run(r.projectKey, r.ticketId, r.relatedId, r.relType);
}

export function relationsForTicket(projectKey: string, ticketId: string): TicketRelation[] {
  const rows = getDb()
    .prepare(
      `SELECT project_key, ticket_id, related_id, rel_type
         FROM ticket_relations WHERE project_key = ? AND ticket_id = ?
        ORDER BY related_id ASC, rel_type ASC`,
    )
    .all(projectKey, ticketId) as {
    project_key: string;
    ticket_id: string;
    related_id: string;
    rel_type: string;
  }[];
  return rows.map((r) => ({
    projectKey: r.project_key,
    ticketId: r.ticket_id,
    relatedId: r.related_id,
    relType: r.rel_type,
  }));
}

// ─── ticket events ───────────────────────────────────────────────────────────

export type TicketEvent = {
  eventKey: string;
  projectKey: string;
  ticketId: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
};

export function upsertTicketEvent(e: TicketEvent): void {
  getDb()
    .prepare(
      `INSERT INTO ticket_events (event_key, project_key, ticket_id, event_type, payload, created_at)
       VALUES (@eventKey, @projectKey, @ticketId, @eventType, @payload, @createdAt)
       ON CONFLICT(project_key, ticket_id, event_key) DO UPDATE SET
         event_type = excluded.event_type,
         payload = excluded.payload,
         created_at = excluded.created_at`,
    )
    .run({
      eventKey: e.eventKey,
      projectKey: e.projectKey,
      ticketId: e.ticketId,
      eventType: e.eventType,
      payload: e.payload ? JSON.stringify(e.payload) : null,
      createdAt: e.createdAt,
    });
}

export function eventsForTicket(projectKey: string, ticketId: string): TicketEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT event_key, project_key, ticket_id, event_type, payload, created_at
         FROM ticket_events WHERE project_key = ? AND ticket_id = ? ORDER BY created_at ASC`,
    )
    .all(projectKey, ticketId) as {
    event_key: string;
    project_key: string;
    ticket_id: string;
    event_type: string;
    payload: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    eventKey: r.event_key,
    projectKey: r.project_key,
    ticketId: r.ticket_id,
    eventType: r.event_type,
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  }));
}

// ─── blocker evidence ────────────────────────────────────────────────────────

export type BlockerEvidence = {
  projectKey: string;
  ticketId: string;
  reason?: string | null;
  source: string;
  createdAt: string;
};

// UPSERT on the natural key (project_key, ticket_id, source). The id is a
// deterministic function of that key so re-import is idempotent — a legacy
// blocked ticket re-imported yields exactly one evidence row, never a duplicate.
export function blockerEvidenceId(projectKey: string, ticketId: string, source: string): string {
  return `blk:${projectKey}:${ticketId}:${source}`;
}

export function upsertBlockerEvidence(b: BlockerEvidence): void {
  getDb()
    .prepare(
      `INSERT INTO blocker_evidence (id, project_key, ticket_id, reason, source, created_at)
       VALUES (@id, @projectKey, @ticketId, @reason, @source, @createdAt)
       ON CONFLICT(project_key, ticket_id, source) DO UPDATE SET
         reason = excluded.reason,
         created_at = excluded.created_at`,
    )
    .run({
      id: blockerEvidenceId(b.projectKey, b.ticketId, b.source),
      projectKey: b.projectKey,
      ticketId: b.ticketId,
      reason: b.reason ?? null,
      source: b.source,
      createdAt: b.createdAt,
    });
}

export function blockerEvidenceForTicket(projectKey: string, ticketId: string): BlockerEvidence[] {
  const rows = getDb()
    .prepare(
      `SELECT project_key, ticket_id, reason, source, created_at
         FROM blocker_evidence WHERE project_key = ? AND ticket_id = ? ORDER BY source ASC`,
    )
    .all(projectKey, ticketId) as {
    project_key: string;
    ticket_id: string;
    reason: string | null;
    source: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    projectKey: r.project_key,
    ticketId: r.ticket_id,
    reason: r.reason,
    source: r.source,
    createdAt: r.created_at,
  }));
}

// ─── storage mode (keyed by project_key, default 'markdown') ─────────────────

export type StorageMode = "markdown" | "db";

export function setStorageMode(projectKey: string, mode: StorageMode, updatedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO ticket_storage_mode (project_key, mode, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_key) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    )
    .run(projectKey, mode, updatedAt);
}

// The stored mode, or 'markdown' when no record exists (the default — nothing
// has cut over). Nothing consumes this for behavior in Slice A.
export function getStorageMode(projectKey: string): StorageMode {
  const row = getDb()
    .prepare(`SELECT mode FROM ticket_storage_mode WHERE project_key = ?`)
    .get(projectKey) as { mode: string } | undefined;
  return (row?.mode as StorageMode | undefined) ?? "markdown";
}

// Ensure a storage-mode record exists (default 'markdown'); never downgrade an
// existing record. Called at import so every known project has an explicit row.
export function ensureStorageMode(projectKey: string, updatedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO ticket_storage_mode (project_key, mode, updated_at)
       VALUES (?, 'markdown', ?)
       ON CONFLICT(project_key) DO NOTHING`,
    )
    .run(projectKey, updatedAt);
}

// ─── id-allocation sequence (per project_key, prefix) ────────────────────────
// Defined and seedable here; the allocate-next BEHAVIOR lands in Slice B.

// Raise the recorded high-water mark for (project_key, prefix) to at least
// `seq`. Idempotent and monotonic — a re-import with the same max never lowers
// it, and a smaller value is ignored.
export function bumpIdSequence(projectKey: string, prefix: string, seq: number): void {
  getDb()
    .prepare(
      `INSERT INTO ticket_id_sequence (project_key, prefix, next_seq)
       VALUES (?, ?, ?)
       ON CONFLICT(project_key, prefix) DO UPDATE SET
         next_seq = MAX(ticket_id_sequence.next_seq, excluded.next_seq)`,
    )
    .run(projectKey, prefix, seq);
}

export function getIdSequence(projectKey: string, prefix: string): number | undefined {
  const row = getDb()
    .prepare(`SELECT next_seq FROM ticket_id_sequence WHERE project_key = ? AND prefix = ?`)
    .get(projectKey, prefix) as { next_seq: number } | undefined;
  return row?.next_seq;
}
