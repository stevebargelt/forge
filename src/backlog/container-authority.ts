// FG-608 (FG-496 Slice C, 1e): the IN-CONTAINER backlog read surface.
//
// ─── THE BOUNDARY ────────────────────────────────────────────────────────────
// Ticket authority inside a container is ASSERTED BY THE MOUNT. It is never
// derived from the checkout, never from the project registry, never from
// repository evidence, and never from .forge/config.yml. Two measured reasons:
//
//  1. CONTAINER GIT EVIDENCE IS DETERMINISTICALLY WRONG AND COLLIDES. /project's
//     origin is a bare local path that normalizeGitRemoteUrl rejects, so
//     repositoryCheckoutIdentity falls to the git-common-dir rung — '/project/.git'
//     — which is IDENTICAL in every container for every project. storage-mode.ts's
//     identity cross-check would then refuse every in-container `forge backlog`
//     command, and its remedy (`forge backlog reidentify --confirm`) is
//     operator-present and host-side by design, so a container has no repair path.
//
//  2. THE REGISTRY/CLAIM PATH MUST BE UNREACHABLE FROM A CONTAINER. One
//     container-derived evidence key would otherwise become the registered owner
//     for unrelated projects.
//
// ─── WHY IT MUST REFUSE RATHER THAN FALL BACK ────────────────────────────────
// This is the load-bearing half, and it is measured, not theoretical. FORGE_HOME
// is unset in the container, so resolveDbPath() lands on /home/agent/.forge/forge.db
// — and /home/agent is the `forge-claude-oauth` NAMED VOLUME, mounted READ-WRITE
// and SHARED by every claude-oauth container on the host regardless of project. It
// already contains a full-schema forge.db (tickets, ticket_relations,
// ticket_events, ticket_storage_mode, project_identity, blocker_evidence). A naive
// in-container read would therefore SUCCEED against that wrong, shared store, and
// the "mutation fails without changing host state" acceptance case would be
// satisfied VACUOUSLY — the mutation would land in a store that leaks into the
// next container of any project.
//
// So: resolve from the explicit mount pointer or REFUSE. Nothing in this module
// imports getDb, resolveBacklogStore, or the project registry — that is enforced
// by a source-level assertion in the container tests, not just by discipline.

import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_DB_BASENAME } from "./snapshot.js";
import type { StructuredTicket, TicketStatus, TicketType } from "./structured.js";

/** The mount pointer. Set by spawn.ts alongside the read-only directory mount;
 *  its ABSENCE is what tells this module it is not running under a mounted
 *  authority. Never defaulted. */
export const SNAPSHOT_DIR_ENV = "FORGE_BACKLOG_SNAPSHOT_DIR";

/** Dispatch-time ticket evidence, injected as `<id>:<revision>:<bodyHash>`. The
 *  dispatched snapshot and the live authority are TWO SEPARATE RECORDS; neither
 *  overwrites the other. When they differ, `forge backlog show` says so. */
export const DISPATCHED_TICKET_ENV = "FORGE_DISPATCHED_TICKET";

export class ContainerAuthorityUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerAuthorityUnavailable";
  }
}

export class ContainerMutationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerMutationRefused";
  }
}

/** True when this process is running against a mounted backlog authority. Callers
 *  branch on THIS, never on "am I in a container" heuristics — the mount is the
 *  fact, and a host process with the env set is deliberately treated the same way
 *  (that is how the host-side tests exercise the real read path). */
export function hasContainerBacklogAuthority(): boolean {
  return (process.env[SNAPSHOT_DIR_ENV] ?? "").trim().length > 0;
}

function snapshotPath(): string {
  const dir = (process.env[SNAPSHOT_DIR_ENV] ?? "").trim();
  if (!dir) {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — ${SNAPSHOT_DIR_ENV} is not set, so no ticket authority ` +
        `was mounted for this task. forge does NOT fall back to $HOME/.forge here: inside an agent ` +
        `container that path is a shared named volume belonging to no project, and reading it would ` +
        `silently answer from another project's store. Ask the operator to re-dispatch this task ` +
        `with a backlog snapshot mount.`,
    );
  }
  return join(dir, SNAPSHOT_DB_BASENAME);
}

let _handle: DatabaseInstance | null = null;
let _handlePath: string | null = null;

/** Open the mounted snapshot READ-ONLY.
 *
 *  `readonly: true` is not merely a flag here — the mount is a docker `:ro` bind,
 *  so the kernel refuses writes regardless. That is the point: agents have
 *  passwordless root (the image creates `agent` with NOPASSWD:ALL and no --user is
 *  ever passed), so a CLI-level refusal is not an enforcement primitive — sudo
 *  undoes it. The `:ro` mount is the one primitive sudo cannot undo, and the
 *  mutation-refusal tests assert at THAT boundary.
 *
 *  The artifact is non-WAL by construction (see snapshot.ts): a WAL database
 *  cannot be opened at all from a non-writable directory (SQLITE_READONLY_DIRECTORY),
 *  because SQLite must create the -shm/-wal sidecars next to it.
 *
 *  The handle is re-opened whenever the file's identity may have changed. The host
 *  publishes by write-temp + rename, which allocates a NEW inode, so a cached
 *  handle would keep reading the REPLACED file forever — exactly the
 *  permanently-stale dispatch-time snapshot the acceptance criteria forbid. Hence
 *  every call opens fresh; a snapshot database is small and this is a CLI. */
function openSnapshot(): DatabaseInstance {
  const path = snapshotPath();
  if (!existsSync(path)) {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — the mounted authority at ${path} does not exist. ` +
        `The host publishes this file; its absence means no snapshot was ever published for this ` +
        `task, not that the project has no tickets.`,
    );
  }
  if (_handle) {
    try {
      _handle.close();
    } catch {
      /* already closed */
    }
    _handle = null;
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  _handle = db;
  _handlePath = path;
  return db;
}

/** Test seam: drop any cached handle (the file may have been replaced under us). */
export function closeContainerAuthorityForTest(): void {
  if (_handle) {
    try {
      _handle.close();
    } catch {
      /* already closed */
    }
  }
  _handle = null;
  _handlePath = null;
}

export type SnapshotMeta = { projectKey: string; publishedAt: string; maxRevision: number };

export function containerSnapshotMeta(): SnapshotMeta {
  const row = openSnapshot()
    .prepare(`SELECT project_key, published_at, max_revision FROM snapshot_meta LIMIT 1`)
    .get() as { project_key: string; published_at: string; max_revision: number } | undefined;
  if (!row) {
    throw new ContainerAuthorityUnavailable(
      `forge: the mounted backlog authority at ${_handlePath} carries no snapshot_meta row — it is ` +
        `not a forge backlog snapshot.`,
    );
  }
  return { projectKey: row.project_key, publishedAt: row.published_at, maxRevision: row.max_revision };
}

type SnapshotTicketRow = {
  ticket_id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  created: string | null;
  closed: string | null;
  closed_commit: string | null;
  epic: string | null;
  revision: number;
  body_hash: string | null;
};

export type ContainerTicket = StructuredTicket & { revision: number; bodyHash: string | null };

function hydrate(db: DatabaseInstance, row: SnapshotTicketRow): ContainerTicket {
  const related = (
    db
      .prepare(`SELECT related_id FROM ticket_relations WHERE ticket_id = ? AND rel_type = 'related' ORDER BY related_id`)
      .all(row.ticket_id) as { related_id: string }[]
  ).map((r) => r.related_id);
  // Same reconstruction the host seam performs: 'blocked' is not a stored status,
  // it is active + durable blocker evidence.
  const blocked =
    row.status === "active" &&
    (db.prepare(`SELECT 1 FROM blocker_evidence WHERE ticket_id = ? LIMIT 1`).get(row.ticket_id) as
      | unknown
      | undefined) !== undefined;
  const status: TicketStatus = blocked ? "blocked" : (row.status as TicketStatus);
  return {
    id: row.ticket_id,
    type: row.type as TicketType,
    status,
    title: row.title,
    ...(related.length > 0 ? { related } : {}),
    ...(row.created ? { created: row.created } : {}),
    ...(row.closed ? { closed: row.closed } : {}),
    ...(row.closed_commit ? { closedCommit: row.closed_commit } : {}),
    ...(row.epic ? { epic: row.epic } : {}),
    body: row.body,
    revision: row.revision,
    bodyHash: row.body_hash,
  };
}

export function containerReadTicket(id: string): ContainerTicket {
  const db = openSnapshot();
  const row = db
    .prepare(
      `SELECT ticket_id, type, status, title, body, created, closed, closed_commit, epic, revision, body_hash
         FROM tickets WHERE ticket_id = ?`,
    )
    .get(id) as SnapshotTicketRow | undefined;
  if (!row) throw new Error(`Ticket ${id} not found`);
  return hydrate(db, row);
}

export function containerListTickets(
  filters: { type?: string; status?: string; search?: string } = {},
): ContainerTicket[] {
  const db = openSnapshot();
  const rows = db
    .prepare(
      `SELECT ticket_id, type, status, title, body, created, closed, closed_commit, epic, revision, body_hash
         FROM tickets ORDER BY ticket_id ASC`,
    )
    .all() as SnapshotTicketRow[];
  const search = filters.search?.toLowerCase();
  return rows
    .map((r) => hydrate(db, r))
    .filter((t) => {
      if (filters.type && t.type !== filters.type) return false;
      if (filters.status && t.status !== filters.status) return false;
      if (search && !(t.title + " " + t.body).toLowerCase().includes(search)) return false;
      return true;
    });
}

export type DispatchedTicketEvidence = { ticketId: string; revision: number; bodyHash: string };

export function dispatchedTicketEvidence(): DispatchedTicketEvidence | null {
  const raw = (process.env[DISPATCHED_TICKET_ENV] ?? "").trim();
  if (!raw) return null;
  const [ticketId, revision, bodyHash] = raw.split(":");
  if (!ticketId || !revision || !bodyHash) return null;
  const parsed = Number.parseInt(revision, 10);
  if (!Number.isFinite(parsed)) return null;
  return { ticketId, revision: parsed, bodyHash };
}

/** The revision-drift line, or null when the live ticket has not advanced past the
 *  dispatched one. NO SILENT RECONCILIATION IN EITHER DIRECTION: the dispatched
 *  record is not rewritten to match the live one, and the live body is not held
 *  back to match the dispatch. Both numbers are simply stated. */
export function describeRevisionDrift(live: ContainerTicket): string | null {
  const dispatched = dispatchedTicketEvidence();
  if (!dispatched || dispatched.ticketId !== live.id) return null;
  if (dispatched.revision === live.revision && dispatched.bodyHash === live.bodyHash) return null;
  return (
    `note: this ticket has ADVANCED since the task was dispatched — dispatched revision ` +
    `${dispatched.revision} (body ${dispatched.bodyHash.slice(0, 12)}), current revision ` +
    `${live.revision} (body ${(live.bodyHash ?? "unknown").slice(0, 12)}). The task package you were ` +
    `given describes the dispatched revision; the text above is current authority.`
  );
}

/** Every mutating verb's answer under a mounted authority. EXPLICIT refusal with a
 *  non-zero exit — never a silent no-op, and never a local write. The snapshot is
 *  a derived read artifact; the authoritative store is on the host and is not
 *  reachable from here by design. */
export function refuseContainerMutation(verb: string): never {
  throw new ContainerMutationRefused(
    `forge: refusing \`backlog ${verb}\` — this task's backlog authority is a READ-ONLY mounted ` +
      `snapshot. Ticket mutations happen on the host, against the authoritative store; there is no ` +
      `write path from an agent container, and a local write would be invisible to everyone. Report ` +
      `the change you want in your result instead.`,
  );
}
