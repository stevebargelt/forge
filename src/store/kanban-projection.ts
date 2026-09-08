// FG-785 (external kanban projection, OUTBOUND-ONLY) — the store accessors for the
// two FG-785 tables. This module is the DURABLE substrate for a provider-neutral
// one-way projection of Forge planning onto an external kanban board:
//
//   kanban_projection_map — the Forge->external-card IDENTITY map. Card identity is the
//     OPAQUE (project_identity, ticket_identity, provider) triple, NEVER the card's
//     name/labels/column position (AC1). Records the external card id, the content HASH
//     of the last projected card DTO (the incremental-sync signal), and write provenance.
//     upsert is idempotent on the identity triple, so a repeated sync converges rather
//     than minting a duplicate (AC3).
//
//   kanban_conflicts — the conflict-resolution AUTHORITY. A provider-reported external
//     move/delete/edit is recorded here carrying BOTH versions and is NEVER applied to
//     any Forge state (AC4). A conflict persists until an AUTHORIZED resolution closes it;
//     last-writer-wins is not the default (AC5). The attention inbox is an open-only
//     PROJECTION of these rows (step 5) and holds no resolution state of its own.
//
// SCOPE (deliberate, per PLAN.md): OUTBOUND ONLY. Nothing here applies an external change
// to Forge; there is no inbound write path. Both tables are additive-only (CREATE TABLE IF
// NOT EXISTS, no user_version bump) — see the FG-785 block in schema.ts. This module writes
// ONLY these two tables and NEVER a lifecycle table (runs/tasks/gates/campaigns/tickets),
// so no projection or conflict record can ever reorder or mutate Forge state.
//
// Timestamps and provenance are CALLER-SUPPLIED (like ci-waits' startedAt), keeping the
// accessors deterministic and process/clock-free for the sync engine and its tests.

import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, writeTransaction } from "./db.js";

/** The projection lifecycle of a mapped card. Enum-as-convention (FG-585): TEXT with no
 *  DB CHECK, so an old/new binary never fights a constraint the other lacks. An `archived`
 *  card keeps its identity row so a later sync never re-creates it. */
export type ProjectionState = "active" | "archived";

/** The external-change class a conflict records. Enum-as-convention (no DB CHECK). */
export type KanbanConflictKind = "moved" | "deleted" | "edited";

/** The conflict lifecycle position. `open` until an authorized resolution writes `resolved`. */
export type KanbanConflictState = "open" | "resolved";

/** The OPAQUE Forge identity a card is keyed on — never the card's name/labels/column
 *  position (AC1). projectIdentity is the durable project key; ticketIdentity the ticket. */
export type ForgeCardIdentity = {
  projectIdentity: string;
  ticketIdentity: string;
  provider: string;
};

export type ProjectionMapRow = ForgeCardIdentity & {
  externalCardId: string;
  projectionState: ProjectionState;
  lastProjectedHash: string;
  projectedBy: string;
  projectedAt: string;
  createdAt: string;
};

/** The upsert input. createdAt is set only on first insert; a re-projection preserves the
 *  original createdAt and refreshes card id / state / hash / provenance. */
export type UpsertProjectionMapInput = ForgeCardIdentity & {
  externalCardId: string;
  projectionState: ProjectionState;
  lastProjectedHash: string;
  projectedBy: string;
  projectedAt: string;
  createdAt: string;
};

type ProjectionMapDbRow = {
  project_identity: string;
  ticket_identity: string;
  provider: string;
  external_card_id: string;
  projection_state: string;
  last_projected_hash: string;
  projected_by: string;
  projected_at: string;
  created_at: string;
};

const PROJECTION_MAP_COLUMNS = [
  "project_identity", "ticket_identity", "provider", "external_card_id",
  "projection_state", "last_projected_hash", "projected_by", "projected_at", "created_at",
].join(", ");

function rowToProjectionMap(row: ProjectionMapDbRow): ProjectionMapRow {
  return {
    projectIdentity: row.project_identity,
    ticketIdentity: row.ticket_identity,
    provider: row.provider,
    externalCardId: row.external_card_id,
    projectionState: row.projection_state as ProjectionState,
    lastProjectedHash: row.last_projected_hash,
    projectedBy: row.projected_by,
    projectedAt: row.projected_at,
    createdAt: row.created_at,
  };
}

/** Idempotent upsert of the identity map, keyed on (project_identity, ticket_identity,
 *  provider). A repeated sync UPSERTs the same row — never a duplicate card (AC3). The
 *  ON CONFLICT clause preserves the ORIGINAL created_at (identity was first established
 *  then) and refreshes everything a re-projection changes. */
export function upsertProjectionMap(input: UpsertProjectionMapInput): void {
  writeTransaction(() => {
    getDb().prepare(`
      INSERT INTO kanban_projection_map (${PROJECTION_MAP_COLUMNS})
      VALUES (@project_identity, @ticket_identity, @provider, @external_card_id,
              @projection_state, @last_projected_hash, @projected_by, @projected_at, @created_at)
      ON CONFLICT(project_identity, ticket_identity, provider) DO UPDATE SET
        external_card_id    = excluded.external_card_id,
        projection_state    = excluded.projection_state,
        last_projected_hash = excluded.last_projected_hash,
        projected_by        = excluded.projected_by,
        projected_at        = excluded.projected_at
    `).run({
      project_identity: input.projectIdentity,
      ticket_identity: input.ticketIdentity,
      provider: input.provider,
      external_card_id: input.externalCardId,
      projection_state: input.projectionState,
      last_projected_hash: input.lastProjectedHash,
      projected_by: input.projectedBy,
      projected_at: input.projectedAt,
      created_at: input.createdAt,
    });
  });
}

/** Read the map row for one card identity, or undefined when the ticket has never been
 *  projected to this provider. The incremental sync reads last_projected_hash from here to
 *  decide whether a card needs re-pushing. */
export function getProjectionMap(identity: ForgeCardIdentity): ProjectionMapRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT ${PROJECTION_MAP_COLUMNS} FROM kanban_projection_map
        WHERE project_identity = ? AND ticket_identity = ? AND provider = ?`,
    )
    .get(identity.projectIdentity, identity.ticketIdentity, identity.provider) as
    | ProjectionMapDbRow
    | undefined;
  return row === undefined ? undefined : rowToProjectionMap(row);
}

/** All map rows for a (project_identity, provider), newest-projection-first. The sync
 *  engine reads this to reconcile the full projected set for a project. */
export function listProjectionMap(projectIdentity: string, provider: string): ProjectionMapRow[] {
  const rows = getDb()
    .prepare(
      `SELECT ${PROJECTION_MAP_COLUMNS} FROM kanban_projection_map
        WHERE project_identity = ? AND provider = ?
        ORDER BY projected_at DESC, ticket_identity ASC`,
    )
    .all(projectIdentity, provider) as ProjectionMapDbRow[];
  return rows.map(rowToProjectionMap);
}

export type KanbanConflict = ForgeCardIdentity & {
  id: string;
  externalCardId: string;
  kind: KanbanConflictKind;
  /** The both-versions payload: Forge's canonical projection and the observed external state. */
  forgeVersion: unknown;
  externalVersion: unknown;
  state: KanbanConflictState;
  detectedBy: string;
  detectedAt: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
};

/** Record a bounded conflict. `forgeVersion` / `externalVersion` are arbitrary values and
 *  are JSON-serialized for storage (the both-versions payload). The row is inserted `open`
 *  and NEVER applies the external change to Forge — recording it is all that happens (AC4). */
export type InsertConflictInput = ForgeCardIdentity & {
  id: string;
  externalCardId: string;
  kind: KanbanConflictKind;
  forgeVersion: unknown;
  externalVersion: unknown;
  detectedBy: string;
  detectedAt: string;
  createdAt: string;
};

type KanbanConflictDbRow = {
  id: string;
  project_identity: string;
  ticket_identity: string;
  provider: string;
  external_card_id: string;
  kind: string;
  forge_version: string;
  external_version: string;
  state: string;
  detected_by: string;
  detected_at: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
};

const CONFLICT_COLUMNS = [
  "id", "project_identity", "ticket_identity", "provider", "external_card_id", "kind",
  "forge_version", "external_version", "state", "detected_by", "detected_at", "created_at",
  "resolved_by", "resolved_at", "resolution",
].join(", ");

// A conflict's JSON payloads are stored verbatim as text. Parse defensively: a row a newer
// binary wrote with a shape this one cannot parse must not throw the whole read — the raw
// string is returned instead, so the conflict still surfaces.
function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function rowToConflict(row: KanbanConflictDbRow): KanbanConflict {
  return {
    id: row.id,
    projectIdentity: row.project_identity,
    ticketIdentity: row.ticket_identity,
    provider: row.provider,
    externalCardId: row.external_card_id,
    kind: row.kind as KanbanConflictKind,
    forgeVersion: decodeJson(row.forge_version),
    externalVersion: decodeJson(row.external_version),
    state: row.state as KanbanConflictState,
    detectedBy: row.detected_by,
    detectedAt: row.detected_at,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}

/** Insert a conflict in the `open` state. Idempotent on the opaque conflict id (a caller
 *  that derives a deterministic id for the same logical external change UPSERTs a no-op
 *  rather than duplicating). Never writes a lifecycle table. */
export function insertConflict(input: InsertConflictInput): void {
  writeTransaction(() => {
    getDb().prepare(`
      INSERT INTO kanban_conflicts (${CONFLICT_COLUMNS})
      VALUES (@id, @project_identity, @ticket_identity, @provider, @external_card_id, @kind,
              @forge_version, @external_version, 'open', @detected_by, @detected_at, @created_at,
              NULL, NULL, NULL)
      ON CONFLICT(id) DO NOTHING
    `).run({
      id: input.id,
      project_identity: input.projectIdentity,
      ticket_identity: input.ticketIdentity,
      provider: input.provider,
      external_card_id: input.externalCardId,
      kind: input.kind,
      forge_version: JSON.stringify(input.forgeVersion ?? null),
      external_version: JSON.stringify(input.externalVersion ?? null),
      detected_by: input.detectedBy,
      detected_at: input.detectedAt,
      created_at: input.createdAt,
    });
  });
}

/** Read one conflict by id (open or resolved), or undefined. */
export function getConflict(id: string): KanbanConflict | undefined {
  const row = getDb()
    .prepare(`SELECT ${CONFLICT_COLUMNS} FROM kanban_conflicts WHERE id = ?`)
    .get(id) as KanbanConflictDbRow | undefined;
  return row === undefined ? undefined : rowToConflict(row);
}

export type ListConflictsScope = {
  projectIdentity?: string;
  provider?: string;
};

/** The currently-OPEN conflicts, newest-first. This is the inbox source's read (step 5):
 *  a conflict item exists exactly while its row is open, so a resolved row simply stops
 *  appearing on the next projection — the inbox stores no resolution state of its own (AC5). */
export function listOpenConflicts(scope: ListConflictsScope = {}): KanbanConflict[] {
  const clauses = ["state = 'open'"];
  const params: string[] = [];
  if (scope.projectIdentity !== undefined) {
    clauses.push("project_identity = ?");
    params.push(scope.projectIdentity);
  }
  if (scope.provider !== undefined) {
    clauses.push("provider = ?");
    params.push(scope.provider);
  }
  const rows = getDb()
    .prepare(
      `SELECT ${CONFLICT_COLUMNS} FROM kanban_conflicts
        WHERE ${clauses.join(" AND ")}
        ORDER BY detected_at DESC, id ASC`,
    )
    .all(...params) as KanbanConflictDbRow[];
  return rows.map(rowToConflict);
}

/** The AUTHORIZED resolution: close an open conflict, recording who resolved it, when, and
 *  the resolution rationale/disposition. The store is the resolution authority — this is the
 *  ONLY path that closes a conflict, and it is host-operator driven (step 6 CLI), never a
 *  remote/browser or inbox mutation. Only an `open` row transitions (the first resolution
 *  wins); returns whether a row was closed. Last-writer-wins is not the default: nothing
 *  here silently overwrites a resolution. */
export function resolveConflict(
  id: string,
  resolution: { resolvedBy: string; resolvedAt: string; resolution: string },
): boolean {
  return writeTransaction(() => {
    const res = getDb().prepare(`
      UPDATE kanban_conflicts
         SET state = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ?
       WHERE id = ? AND state = 'open'
    `).run(resolution.resolvedBy, resolution.resolvedAt, resolution.resolution, id);
    return res.changes === 1;
  });
}

/** Test/introspection seam: the raw column set of a table, so a fresh-vs-migrated
 *  assertion can probe the shape without a second copy of the list. */
export function kanbanTableColumns(db: DatabaseInstance, table: "kanban_projection_map" | "kanban_conflicts"): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}
