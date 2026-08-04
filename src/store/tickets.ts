// FG-606 (FG-496 Slice A): store accessors for the DB ticket shadow. All rows are
// keyed by (project_key, ticket_id). Every write is an idempotent UPSERT so a
// pre-cutover re-import (DB mirrors authoritative Markdown) never duplicates or
// drifts. Nothing READS these for product behavior in Slice A — the DB is a
// write-only shadow; Markdown stays the sole source of truth.
//
// These helpers call getDb() directly, so a caller that wraps them in
// writeTransaction() (the import orchestrator does) executes every statement
// inside that one BEGIN IMMEDIATE — partial failure rolls back whole.

import { createHash } from "node:crypto";
import { getDb, registerPublishBarrier } from "./db.js";
import { LEGACY_BLOCKED_KIND, type BlockerEvidenceKind } from "./blocked-source.js";
import {
  beginPublishBarrier,
  endPublishBarrier,
  markBacklogDirty,
} from "../backlog/snapshot.js";

// FG-608 (1d): install the publish barrier into db.ts's writeTransaction. Done
// HERE, in the module that owns every ticket write, so importing any ticket
// accessor arms publication — a caller cannot get the writers without the
// fan-out. db.ts cannot import snapshot.ts directly (snapshot.ts needs getDb).
registerPublishBarrier({ beginPublishBarrier, endPublishBarrier });

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
  // FG-608: read-back only. The MONOTONIC revision counter and the content basis
  // are owned by the writers below (never supplied by a caller) — a caller that
  // could set them could make a ticket appear not to have advanced.
  revision?: number;
  bodyHash?: string | null;
  importBasisHash?: string | null;
  // FG-609: read-back ONLY. The operator stack rank is HOST-AUTHORED state owned by
  // src/store/queue.ts; neither writer below names it, so an import or a seam edit
  // can never silently drop an operator's queue position. See the note on the
  // UPSERTs and the fg609-import-isolation guard that pins it.
  priorityRank?: number | null;
};

// FG-608: the CONTENT basis. Hashes exactly the authoritative content of a ticket
// — everything a reader would call "the ticket" — and nothing about when or where
// it was written. imported_at / imported_from are deliberately excluded: a
// re-import of unchanged Markdown must not look like a content change.
//
// This is the answer to "did the content diverge", NOT to "did the ticket
// advance": an edit-and-revert returns the ORIGINAL hash. That is why the
// monotonic `revision` counter exists alongside it, with a different owner.
export function ticketContentHash(t: {
  type: string;
  status: string;
  title: string;
  body: string;
  created?: string | null;
  closed?: string | null;
  closedCommit?: string | null;
  epic?: string | null;
}): string {
  const canonical = JSON.stringify([
    t.type,
    t.status,
    t.title,
    t.body,
    t.created ?? null,
    t.closed ?? null,
    t.closedCommit ?? null,
    t.epic ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

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
  revision: number;
  body_hash: string | null;
  import_basis_hash: string | null;
  priority_rank: number | null;
};

function rowToTicket(row: TicketDbRow): TicketRow {
  return {
    revision: row.revision,
    bodyHash: row.body_hash,
    importBasisHash: row.import_basis_hash,
    priorityRank: row.priority_rank,
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
//
// FG-609: this UPSERT is COLUMN-EXPLICIT and its DO UPDATE SET deliberately does
// NOT name priority_rank. Operator queue state is host-authored and survives
// re-import only because of that. Adding rank to the SET clause — or replacing
// this with a delete-then-insert refresh — would drop an operator's stack rank
// with no error and no queue event. Pinned by src/store/fg609-import-isolation.test.ts.
//
// FG-608: this is the IMPORT writer, so it stamps BOTH revision semantics — the
// monotonic counter advances (an import IS an authoritative write) and the content
// basis is REBASED: body_hash and import_basis_hash are set to the same value,
// which is precisely what makes "the DB row was edited since its import basis" a
// decidable question later (see importConflict in backlog-import.ts).
export function upsertTicket(t: TicketRow): void {
  const hash = ticketContentHash(t);
  getDb()
    .prepare(
      `INSERT INTO tickets
         (project_key, ticket_id, type, status, title, body, created, closed, closed_commit, epic, frontmatter, imported_at, imported_from, revision, body_hash, import_basis_hash)
       VALUES (@projectKey, @ticketId, @type, @status, @title, @body, @created, @closed, @closedCommit, @epic, @frontmatter, @importedAt, @importedFrom, 1, @hash, @hash)
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
         imported_from = excluded.imported_from,
         -- FG-608 F11: the counter advances on a CONTENT CHANGE, not on a write.
         -- A re-import of byte-identical Markdown is a no-op in every way an agent
         -- can observe, so bumping here published a snapshot whose only difference
         -- was the number — and every running container then reported "this ticket
         -- has ADVANCED since dispatch" for a ticket that had not moved. Once that
         -- notice cries wolf on routine re-imports it stops meaning anything on the
         -- amendment it exists to announce. The hash covers type/status/title/body,
         -- so any real edit still advances it.
         revision = CASE WHEN tickets.body_hash IS excluded.body_hash
                         THEN tickets.revision ELSE tickets.revision + 1 END,
         body_hash = excluded.body_hash,
         import_basis_hash = excluded.import_basis_hash`,
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
      hash,
    });
  markBacklogDirty(t.projectKey);
}

// FG-607: the SEAM's write path. Identical to upsertTicket except that it never
// modifies imported_at / imported_from — those columns record when and where a row
// was imported FROM MARKDOWN (see schema.ts), and a db-mode edit is not an import.
// Carrying them forward on every write made both columns mean "last edited", which
// is what the import's own reconcile provenance needs them NOT to mean.
//
// On INSERT (a ticket the seam creates, never imported) imported_from is left
// null — the discriminator provenance actually reads. imported_at is NOT NULL in
// the schema, so the row's creation time is the only value available there.
// FG-608: the seam writer stamps the counter and the CURRENT content hash, and
// deliberately leaves import_basis_hash ALONE. That asymmetry is the conflict
// rule: after a db-mode edit, body_hash != import_basis_hash, and the next import
// can see that this row moved since the basis it was imported from. Before FG-608
// this writer touched no provenance at all, so the conflict rule would have been
// blind to exactly the edits it exists to protect.
export function upsertSeamTicket(t: TicketRow): void {
  const hash = ticketContentHash(t);
  getDb()
    .prepare(
      `INSERT INTO tickets
         (project_key, ticket_id, type, status, title, body, created, closed, closed_commit, epic, frontmatter, imported_at, imported_from, revision, body_hash, import_basis_hash)
       VALUES (@projectKey, @ticketId, @type, @status, @title, @body, @created, @closed, @closedCommit, @epic, @frontmatter, @importedAt, NULL, 1, @hash, NULL)
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
         revision = tickets.revision + 1,
         body_hash = excluded.body_hash`,
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
      hash,
    });
  // Default (d): the FIRST db-only edit is RECORDED, so `mode --set markdown` can
  // refuse afterward. Only fires in db mode — the seam calls this writer only when
  // the DB is authoritative, which is exactly when backlog/*.md starts freezing.
  recordFirstDbEdit(t.projectKey, t.ticketId, t.importedAt);
  markBacklogDirty(t.projectKey);
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
  markBacklogDirty(r.projectKey);
}

// Replace-set support for the seam: import is idempotent-ADDITIVE by design, but
// writing a ticket whose `related:` list dropped an id must actually drop it.
// The seam deletes then re-inserts inside one write transaction.
export function deleteTicketRelations(projectKey: string, ticketId: string, relType: string): void {
  getDb()
    .prepare(`DELETE FROM ticket_relations WHERE project_key = ? AND ticket_id = ? AND rel_type = ?`)
    .run(projectKey, ticketId, relType);
  markBacklogDirty(projectKey);
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
  markBacklogDirty(e.projectKey);
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
  // FG-609 enrichment. Every field is optional so every Slice A call site is
  // unchanged and every Slice A row reads back exactly what it was written with:
  // `kind` falls back to the column DEFAULT 'legacy_blocked', the rest to null.
  kind?: BlockerEvidenceKind;
  detail?: Record<string, unknown> | null;
  // The ticket body hash this blocker was observed against (readiness binding).
  bodyHash?: string | null;
  // The operator QUEUE PROJECTION this row feeds. Never a status: it does not make
  // the ticket read back as 'blocked' anywhere, and it never makes one queue-eligible.
  queueProjection?: "blocked" | "not_ready" | null;
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
      `INSERT INTO blocker_evidence
         (id, project_key, ticket_id, reason, source, created_at, kind, detail, body_hash, queue_projection)
       VALUES (@id, @projectKey, @ticketId, @reason, @source, @createdAt, @kind, @detail, @bodyHash, @queueProjection)
       ON CONFLICT(project_key, ticket_id, source) DO UPDATE SET
         reason = excluded.reason,
         created_at = excluded.created_at,
         kind = excluded.kind,
         detail = excluded.detail,
         body_hash = excluded.body_hash,
         queue_projection = excluded.queue_projection`,
    )
    .run({
      id: blockerEvidenceId(b.projectKey, b.ticketId, b.source),
      projectKey: b.projectKey,
      ticketId: b.ticketId,
      reason: b.reason ?? null,
      source: b.source,
      createdAt: b.createdAt,
      // A caller that predates the enrichment gets the legacy kind, which is what
      // the column DEFAULT gives an aged row too — one classification, one place.
      kind: b.kind ?? LEGACY_BLOCKED_KIND,
      detail: b.detail ? JSON.stringify(b.detail) : null,
      bodyHash: b.bodyHash ?? null,
      queueProjection: b.queueProjection ?? null,
    });
  markBacklogDirty(b.projectKey);
}

// The evidence source both writers use for a legacy `status: blocked` ticket: the
// import (Markdown -> DB) and the FG-607 seam (a ticket written with status
// 'blocked' in db mode). There is exactly ONE constant — two writers with two
// copies of this string drift silently, and a blocked ticket would round-trip as
// active.
//
// FG-609 MOVED THE DECLARATION to the zero-import leaf ./blocked-source.ts, and
// this is a RE-EXPORT so every existing importer is unchanged. The move is
// load-bearing rather than tidy: line 12 of this module imports getDb, so the
// dashboard (the fourth blocked-derivation surface) could not reach the literal
// through here without dragging the store handle into its typecheck and bundle.
export { LEGACY_BLOCKED_SOURCE, isStatusBearingEvidenceSource } from "./blocked-source.js";

// The inverse of upsertBlockerEvidence — used by the seam for the
// blocked -> unblocked transition. Silently no-ops when no row exists.
export function deleteBlockerEvidence(projectKey: string, ticketId: string, source: string): void {
  getDb()
    .prepare(`DELETE FROM blocker_evidence WHERE project_key = ? AND ticket_id = ? AND source = ?`)
    .run(projectKey, ticketId, source);
  markBacklogDirty(projectKey);
}

type BlockerEvidenceDbRow = {
  project_key: string;
  ticket_id: string;
  reason: string | null;
  source: string;
  created_at: string;
  kind: string;
  detail: string | null;
  body_hash: string | null;
  queue_projection: string | null;
};

const BLOCKER_EVIDENCE_COLUMNS =
  "project_key, ticket_id, reason, source, created_at, kind, detail, body_hash, queue_projection";

function rowToBlockerEvidence(r: BlockerEvidenceDbRow): BlockerEvidence {
  return {
    projectKey: r.project_key,
    ticketId: r.ticket_id,
    reason: r.reason,
    source: r.source,
    createdAt: r.created_at,
    kind: r.kind as BlockerEvidenceKind,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    bodyHash: r.body_hash,
    queueProjection: (r.queue_projection as "blocked" | "not_ready" | null) ?? null,
  };
}

export function blockerEvidenceForTicket(projectKey: string, ticketId: string): BlockerEvidence[] {
  const rows = getDb()
    .prepare(
      `SELECT ${BLOCKER_EVIDENCE_COLUMNS}
         FROM blocker_evidence WHERE project_key = ? AND ticket_id = ? ORDER BY source ASC`,
    )
    .all(projectKey, ticketId) as BlockerEvidenceDbRow[];
  return rows.map(rowToBlockerEvidence);
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

// ─── FG-608: the cutover record ──────────────────────────────────────────────

export type StorageModeRecord = {
  projectKey: string;
  mode: StorageMode;
  updatedAt: string;
  firstDbEditAt: string | null;
  firstDbEditTicket: string | null;
  flippedAt: string | null;
  flippedByRevision: string | null;
};

export function getStorageModeRecord(projectKey: string): StorageModeRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT project_key, mode, updated_at, first_db_edit_at, first_db_edit_ticket,
              flipped_at, flipped_by_revision
         FROM ticket_storage_mode WHERE project_key = ?`,
    )
    .get(projectKey) as
    | {
        project_key: string;
        mode: string;
        updated_at: string;
        first_db_edit_at: string | null;
        first_db_edit_ticket: string | null;
        flipped_at: string | null;
        flipped_by_revision: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    projectKey: row.project_key,
    mode: row.mode as StorageMode,
    updatedAt: row.updated_at,
    firstDbEditAt: row.first_db_edit_at,
    firstDbEditTicket: row.first_db_edit_ticket,
    flippedAt: row.flipped_at,
    flippedByRevision: row.flipped_by_revision,
  };
}

// Default (d): record the FIRST db-only edit, once, durably. The one-way cutover
// property is otherwise documentation-only — the operator has to remember that
// backlog/*.md froze. With this row, `mode --set markdown` can REFUSE.
//
// Only stamps when the project is actually in db mode (a markdown-mode project's
// DB writes are shadow writes, not db-only edits) and only when the column is
// still NULL — "first" means first, so a later edit never moves it.
export function recordFirstDbEdit(projectKey: string, ticketId: string, at: string): void {
  getDb()
    .prepare(
      `UPDATE ticket_storage_mode
          SET first_db_edit_at = ?, first_db_edit_ticket = ?
        WHERE project_key = ? AND mode = 'db' AND first_db_edit_at IS NULL`,
    )
    .run(at, ticketId, projectKey);
}

// WHICH forge performed the flip. Recorded because nothing in the DB can stop an
// OLDER binary from opening the migrated store and continuing to read the frozen
// backlog/*.md: additive migrations never bump user_version, so the forward gate
// (assertSchemaVersionSupported) does not fire. Naming the flipping revision in
// the record and in the cutover UX is the honest alternative to pretending it is
// prevented.
export function recordModeFlip(
  projectKey: string,
  at: string,
  forgeRevision: string,
): void {
  getDb()
    .prepare(
      `UPDATE ticket_storage_mode SET flipped_at = ?, flipped_by_revision = ? WHERE project_key = ?`,
    )
    .run(at, forgeRevision, projectKey);
}

// ─── FG-608: per-source membership (removal reconciliation substrate) ────────
//
// Prune authority belongs to the SET OF LIVE SOURCES, never to the checkout
// running the import. An import may add its OWN membership and may remove its OWN
// membership; a row is deleted from the product tables only when NO live source
// claims it. Absence of a source is not evidence of absence of a ticket.

export type MembershipKind = "ticket" | "relation" | "blocker_evidence";

export type SourceRecord = {
  projectKey: string;
  sourceId: string;
  lastPath: string | null;
  lastScannedAt: string | null;
  forgottenAt: string | null;
  createdAt: string;
};

export function upsertBacklogSource(
  projectKey: string,
  sourceId: string,
  lastPath: string,
  at: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO backlog_sources (project_key, source_id, last_path, last_scanned_at, forgotten_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(project_key, source_id) DO UPDATE SET
         last_path = excluded.last_path,
         last_scanned_at = excluded.last_scanned_at,
         forgotten_at = NULL`,
    )
    .run(projectKey, sourceId, lastPath, at, at);
}

/** Live = registered and not forgotten. A forgotten source no longer holds any
 *  ticket back from pruning. */
export function liveBacklogSources(projectKey: string): SourceRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT project_key, source_id, last_path, last_scanned_at, forgotten_at, created_at
         FROM backlog_sources WHERE project_key = ? AND forgotten_at IS NULL
        ORDER BY source_id ASC`,
    )
    .all(projectKey) as {
    project_key: string;
    source_id: string;
    last_path: string | null;
    last_scanned_at: string | null;
    forgotten_at: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    projectKey: r.project_key,
    sourceId: r.source_id,
    lastPath: r.last_path,
    lastScannedAt: r.last_scanned_at,
    forgottenAt: r.forgotten_at,
    createdAt: r.created_at,
  }));
}

/** The operator verb's store half: mark a permanently-removed source forgotten and
 *  drop its membership, so the tickets only it claimed become prunable. Returns
 *  false when the source was not registered (so the CLI can say so instead of
 *  silently succeeding). */
export function forgetBacklogSource(projectKey: string, sourceId: string, at: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE backlog_sources SET forgotten_at = ? WHERE project_key = ? AND source_id = ? AND forgotten_at IS NULL`,
    )
    .run(at, projectKey, sourceId);
  // The membership rows are deliberately NOT deleted. claimedMembers() joins on
  // forgotten_at IS NULL, so a forgotten source's rows stop COUNTING AS A CLAIM
  // immediately — but they still mark the ticket as something a source once held,
  // which is what makes it a prune CANDIDATE on the next import. Deleting them
  // would erase that fact and the ticket would be pinned forever with nothing
  // claiming it: the exact stale-source deadlock this verb exists to break.
  return res.changes > 0;
}

export function recordMembership(
  projectKey: string,
  sourceId: string,
  kind: MembershipKind,
  ticketId: string,
  memberKey: string,
  at: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO ticket_source_membership
         (project_key, source_id, kind, ticket_id, member_key, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_key, source_id, kind, ticket_id, member_key) DO UPDATE SET
         observed_at = excluded.observed_at`,
    )
    .run(projectKey, sourceId, kind, ticketId, memberKey, at);
}

/** Replace THIS source's membership for a kind with exactly what it observed. An
 *  import removes its own membership; it never touches a sibling source's. */
export function replaceSourceMembership(
  projectKey: string,
  sourceId: string,
  kind: MembershipKind,
  members: { ticketId: string; memberKey: string }[],
  at: string,
): void {
  getDb()
    .prepare(`DELETE FROM ticket_source_membership WHERE project_key = ? AND source_id = ? AND kind = ?`)
    .run(projectKey, sourceId, kind);
  for (const m of members) recordMembership(projectKey, sourceId, kind, m.ticketId, m.memberKey, at);
}

/** What ONE source currently claims for a kind. The prune side reads this BEFORE
 *  replaceSourceMembership overwrites it — it is the only evidence of what this
 *  source used to claim, and therefore the only basis on which it may propose a
 *  removal. */
export function sourceMembership(
  projectKey: string,
  sourceId: string,
  kind: MembershipKind,
): { ticketId: string; memberKey: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT ticket_id, member_key FROM ticket_source_membership
        WHERE project_key = ? AND source_id = ? AND kind = ?
        ORDER BY ticket_id ASC, member_key ASC`,
    )
    .all(projectKey, sourceId, kind) as { ticket_id: string; member_key: string }[];
  return rows.map((r) => ({ ticketId: r.ticket_id, memberKey: r.member_key }));
}

/** Every (ticket_id, member_key) of `kind` that ANY source — live OR forgotten —
 *  has ever been recorded as holding. This is the prune CANDIDATE set, snapshotted
 *  BEFORE an import replaces its own membership.
 *
 *  It must be the candidate set rather than "what THIS source used to claim", for
 *  two reasons that only show up across imports:
 *    * a source that dropped a ticket, was blocked from pruning by a sibling, and
 *      re-imported has already forgotten it ever claimed it — so a later
 *      forget-source of that sibling would never re-propose the prune;
 *    * a ticket claimed ONLY by a source the operator just forgot has no live
 *      claim and no scanning source, and would otherwise be pinned forever.
 *
 *  A row NO membership has ever mentioned (a pre-FG-608 import) is deliberately
 *  absent here, which is what keeps it un-prunable. */
export function allMembership(
  projectKey: string,
  kind: MembershipKind,
): { ticketId: string; memberKey: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT ticket_id, member_key FROM ticket_source_membership
        WHERE project_key = ? AND kind = ? ORDER BY ticket_id ASC, member_key ASC`,
    )
    .all(projectKey, kind) as { ticket_id: string; member_key: string }[];
  return rows.map((r) => ({ ticketId: r.ticket_id, memberKey: r.member_key }));
}

/** Every (ticket_id, member_key) of `kind` that ANY live source still claims. */
export function claimedMembers(projectKey: string, kind: MembershipKind): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT m.ticket_id, m.member_key
         FROM ticket_source_membership m
         JOIN backlog_sources s
           ON s.project_key = m.project_key AND s.source_id = m.source_id
        WHERE m.project_key = ? AND m.kind = ? AND s.forgotten_at IS NULL`,
    )
    .all(projectKey, kind) as { ticket_id: string; member_key: string }[];
  return new Set(rows.map((r) => membershipKey(r.ticket_id, r.member_key)));
}

export function membershipKey(ticketId: string, memberKey: string): string {
  return `${ticketId} ${memberKey}`;
}

export function deleteTicketRow(projectKey: string, ticketId: string): void {
  // ticket_events / ticket_relations / blocker_evidence cascade off the composite
  // FK (schema.ts), so this one DELETE removes the whole ticket.
  getDb().prepare(`DELETE FROM tickets WHERE project_key = ? AND ticket_id = ?`).run(projectKey, ticketId);
  getDb()
    .prepare(`DELETE FROM ticket_source_membership WHERE project_key = ? AND ticket_id = ?`)
    .run(projectKey, ticketId);
  markBacklogDirty(projectKey);
}

export function deleteTicketRelation(
  projectKey: string,
  ticketId: string,
  relatedId: string,
  relType: string,
): void {
  getDb()
    .prepare(
      `DELETE FROM ticket_relations
        WHERE project_key = ? AND ticket_id = ? AND related_id = ? AND rel_type = ?`,
    )
    .run(projectKey, ticketId, relatedId, relType);
  markBacklogDirty(projectKey);
}

export function allRelationsForProject(projectKey: string): TicketRelation[] {
  const rows = getDb()
    .prepare(
      `SELECT project_key, ticket_id, related_id, rel_type FROM ticket_relations WHERE project_key = ?`,
    )
    .all(projectKey) as {
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

export function allBlockerEvidenceForProject(projectKey: string): BlockerEvidence[] {
  const rows = getDb()
    .prepare(`SELECT ${BLOCKER_EVIDENCE_COLUMNS} FROM blocker_evidence WHERE project_key = ?`)
    .all(projectKey) as BlockerEvidenceDbRow[];
  return rows.map(rowToBlockerEvidence);
}

// ─── FG-608: dispatch evidence ───────────────────────────────────────────────

export type DispatchEvidence = {
  taskId: string;
  projectKey: string;
  ticketId: string;
  revision: number;
  bodyHash: string;
  dispatchedAt: string;
};

export function recordDispatchEvidence(e: DispatchEvidence): void {
  getDb()
    .prepare(
      `INSERT INTO ticket_dispatch_evidence
         (task_id, project_key, ticket_id, revision, body_hash, dispatched_at)
       VALUES (@taskId, @projectKey, @ticketId, @revision, @bodyHash, @dispatchedAt)
       ON CONFLICT(task_id) DO UPDATE SET
         project_key = excluded.project_key,
         ticket_id = excluded.ticket_id,
         revision = excluded.revision,
         body_hash = excluded.body_hash,
         dispatched_at = excluded.dispatched_at`,
    )
    .run(e);
}

export function dispatchEvidenceForTask(taskId: string): DispatchEvidence | undefined {
  const row = getDb()
    .prepare(
      `SELECT task_id, project_key, ticket_id, revision, body_hash, dispatched_at
         FROM ticket_dispatch_evidence WHERE task_id = ?`,
    )
    .get(taskId) as
    | {
        task_id: string;
        project_key: string;
        ticket_id: string;
        revision: number;
        body_hash: string;
        dispatched_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    taskId: row.task_id,
    projectKey: row.project_key,
    ticketId: row.ticket_id,
    revision: row.revision,
    bodyHash: row.body_hash,
    dispatchedAt: row.dispatched_at,
  };
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

// FG-607: allocate the next id for (project_key, prefix) and advance the sequence.
//
// MUST be called from inside the caller's writeTransaction (BEGIN IMMEDIATE) — it
// has no transaction of its own, so the read and the bump are only atomic against
// a concurrent forge process when the caller holds the write lock. That is what
// makes two `forge backlog file` invocations in two linked worktrees allocate
// distinct ids instead of both observing the same next_seq.
//
// THROWS on an unseeded sequence rather than defaulting to 1: a project flipped
// to db mode without a prior import would otherwise silently mint ids that
// duplicate its entire Markdown history — the DB's collision check knows nothing
// about ids that only exist in backlog/*.md.
export function allocateTicketId(projectKey: string, prefix: string): string {
  const next = getIdSequence(projectKey, prefix);
  if (next === undefined) {
    throw new Error(
      `forge: cannot allocate a ticket id — no id sequence is seeded for prefix '${prefix}' under ` +
        `project_key '${projectKey}'. Run \`forge backlog import\` so allocation continues past the ` +
        `existing Markdown ids instead of duplicating them.`,
    );
  }
  getDb()
    .prepare(`UPDATE ticket_id_sequence SET next_seq = ? WHERE project_key = ? AND prefix = ?`)
    .run(next + 1, projectKey, prefix);
  return `${prefix}-${next}`;
}
