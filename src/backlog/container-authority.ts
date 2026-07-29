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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_DB_BASENAME } from "./snapshot.js";
import type { StructuredTicket, TicketStatus, TicketType } from "./structured.js";

/** The mount pointer. Set by spawn.ts alongside the read-only directory mount.
 *
 *  FG-608 red F2: this env var is NOT the authority gate. A child process owns its
 *  own environment — an agent can `unset` it or repoint it at a directory it wrote
 *  itself — so gating container mode on it meant the gate could be opened from
 *  inside. It survives only as the HOST-SIDE test seam (a host process pointing at
 *  a published directory exercises the real read path) and as a convenience for the
 *  in-container reader; the MARKER below outranks it and is checked first. */
export const SNAPSHOT_DIR_ENV = "FORGE_BACKLOG_SNAPSHOT_DIR";

/** The fixed in-container path of the read-only authority mount. Compiled in, never
 *  read from the environment — that is the whole point: an agent cannot make this
 *  path stop existing, so it cannot make itself look like a host process. Must match
 *  the mount spawn.ts writes. */
export const CONTAINER_AUTHORITY_MOUNT = "/forge-backlog";

/** The unforgeable container-runtime marker. Written by the host into the mount
 *  source BEFORE the container starts, and readable at a FIXED path on a `:ro`
 *  bind — the one primitive passwordless root cannot undo. Its presence is what
 *  "this process is a dispatched agent container" MEANS here. */
export const AUTHORITY_MARKER_BASENAME = "authority.json";

/** What the host dispatched as this task's ticket authority.
 *
 *   db       — a snapshot was published into this directory; it is the ONLY ticket
 *              truth this container may read, and its absence is a refusal.
 *   markdown — the project has not cut over; backlog/*.md in the mounted checkout
 *              is the truth, exactly as on the host. No snapshot exists.
 *   unknown  — the host could not resolve the project's store at dispatch time. Not
 *              a licence to guess: the host store stays unreachable either way. */
export type AuthorityMode = "db" | "markdown" | "unknown";

export type AuthorityMarker = {
  kind: "forge-backlog-authority";
  version: 1;
  mode: AuthorityMode;
  projectKey: string | null;
  taskId: string | null;
};

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

export type ContainerAuthority = { dir: string; marker: AuthorityMarker };

/** HOST SIDE. The one writer of the marker, kept here so its shape has exactly one
 *  definition. Called by the dispatch path (spawn.ts) into the directory it is about
 *  to bind `:ro`, before the container starts — after which the marker is beyond the
 *  agent's reach even with root. */
export function writeAuthorityMarker(
  dir: string,
  fields: { mode: AuthorityMode; projectKey: string | null; taskId: string | null },
): void {
  mkdirSync(dir, { recursive: true });
  const marker: AuthorityMarker = { kind: "forge-backlog-authority", version: 1, ...fields };
  writeFileSync(join(dir, AUTHORITY_MARKER_BASENAME), JSON.stringify(marker, null, 2) + "\n");
}

function parseMarker(path: string): AuthorityMarker {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — the container authority marker at ${path} exists but ` +
        `could not be read (${(e as Error).message}). A container never falls back to the host store.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — the container authority marker at ${path} is not valid ` +
        `JSON. A malformed marker is a broken dispatch, not a licence to answer from somewhere else.`,
    );
  }
  const m = parsed as Partial<AuthorityMarker>;
  if (m.kind !== "forge-backlog-authority" || (m.mode !== "db" && m.mode !== "markdown" && m.mode !== "unknown")) {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — the container authority marker at ${path} is not a forge ` +
        `authority marker.`,
    );
  }
  return {
    kind: "forge-backlog-authority",
    version: 1,
    mode: m.mode,
    projectKey: m.projectKey ?? null,
    taskId: m.taskId ?? null,
  };
}

/** The dispatched authority, or null when this is an ordinary host process.
 *
 *  RESOLUTION ORDER IS THE SECURITY PROPERTY. The compiled-in mount path is checked
 *  FIRST and, when its marker is there, the environment is not consulted at all —
 *  so neither `unset FORGE_BACKLOG_SNAPSHOT_DIR` nor repointing it at an
 *  agent-authored directory can move, weaken, or switch off the gate. The env
 *  branch below is reachable ONLY on a host with no marker at the fixed path,
 *  which is exactly the host-side test seam. */
export function containerAuthority(): ContainerAuthority | null {
  const fixed = join(CONTAINER_AUTHORITY_MOUNT, AUTHORITY_MARKER_BASENAME);
  if (existsSync(fixed)) return { dir: CONTAINER_AUTHORITY_MOUNT, marker: parseMarker(fixed) };
  const envDir = (process.env[SNAPSHOT_DIR_ENV] ?? "").trim();
  if (!envDir) return null;
  const marked = join(envDir, AUTHORITY_MARKER_BASENAME);
  if (existsSync(marked)) return { dir: envDir, marker: parseMarker(marked) };
  // A pointed-at directory with no marker: a hand-built snapshot dir in a host
  // test. Treated as a db authority so the read path below is the SAME code, and
  // the snapshot's own absence still refuses.
  return {
    dir: envDir,
    marker: { kind: "forge-backlog-authority", version: 1, mode: "db", projectKey: null, taskId: null },
  };
}

/** True when this process runs under a dispatched container authority of ANY mode.
 *  The host store is unreachable from here regardless of what that mode is. */
export function inContainerBacklogMode(): boolean {
  return containerAuthority() !== null;
}

/** True when the dispatched authority is a MOUNTED SNAPSHOT — i.e. ticket reads
 *  must resolve from the mount and mutations must refuse. Callers branch on THIS,
 *  never on "am I in a container" heuristics. */
export function hasContainerBacklogAuthority(): boolean {
  return containerAuthority()?.marker.mode === "db";
}

/** The refusal F1 exists for: a container whose marker says the ticket authority is
 *  NOT a mounted snapshot must still never reach the host store. With FORGE_HOME
 *  unset, resolveDbPath() lands on /home/agent/.forge/forge.db — the SHARED
 *  forge-claude-oauth volume, carrying a full ticket schema for unrelated projects —
 *  so a db-mode resolution here would answer, plausibly and wrongly, from another
 *  project's store. */
export function assertNoHostStoreInContainer(resolvedMode: string): void {
  const authority = containerAuthority();
  if (!authority) return;
  if (authority.marker.mode === "db") return; // handled by the snapshot path
  if (resolvedMode !== "db") return;
  throw new ContainerAuthorityUnavailable(
    `forge: refusing to read the backlog — this task was dispatched with a '${authority.marker.mode}' ` +
      `ticket authority, but the store resolved to db mode inside the container. There is no mounted ` +
      `snapshot to read, and forge does NOT fall back to $HOME/.forge here: inside an agent container ` +
      `that path is a shared named volume belonging to no project. Ask the operator to re-dispatch ` +
      `this task with a backlog snapshot mount.`,
  );
}

function requireSnapshotAuthority(): ContainerAuthority {
  const authority = containerAuthority();
  if (!authority) {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — no ticket authority was mounted for this task. forge ` +
        `does NOT fall back to $HOME/.forge here: inside an agent container that path is a shared ` +
        `named volume belonging to no project, and reading it would silently answer from another ` +
        `project's store. Ask the operator to re-dispatch this task with a backlog snapshot mount.`,
    );
  }
  if (authority.marker.mode !== "db") {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — this task's authority marker says '${authority.marker.mode}', ` +
        `so no snapshot was published for it. The marker is the dispatched fact; the environment cannot ` +
        `override it.`,
    );
  }
  return authority;
}

function snapshotPath(): string {
  return join(requireSnapshotAuthority().dir, SNAPSHOT_DB_BASENAME);
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
  const authority = requireSnapshotAuthority();
  const path = join(authority.dir, SNAPSHOT_DB_BASENAME);
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
  // F2: the artifact must MATCH THE DISPATCHED MOUNT, not merely be openable. A
  // file that opens but carries no snapshot_meta, or one published for a different
  // project_key than the host dispatched, is not this task's authority — answering
  // from it is the same failure as answering from the shared volume.
  const meta = db
    .prepare(`SELECT project_key FROM snapshot_meta LIMIT 1`)
    .get() as { project_key: string } | undefined;
  if (!meta) {
    throw new ContainerAuthorityUnavailable(
      `forge: the mounted backlog authority at ${path} carries no snapshot_meta row — it is not a ` +
        `forge backlog snapshot.`,
    );
  }
  if (authority.marker.projectKey && meta.project_key !== authority.marker.projectKey) {
    throw new ContainerAuthorityUnavailable(
      `forge: refusing to read the backlog — the mounted snapshot at ${path} was published for ` +
        `project_key '${meta.project_key}', but this task was dispatched against ` +
        `'${authority.marker.projectKey}'. A snapshot that does not match the dispatched mount is ` +
        `another project's ticket truth.`,
    );
  }
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
  // The reason is mode-specific, because a markdown-mode container has no snapshot
  // to be read-only ABOUT — what it must not reach is the host store, and saying
  // "read-only mounted snapshot" there would be a plausible lie.
  const snapshot = containerAuthority()?.marker.mode === "db";
  throw new ContainerMutationRefused(
    `forge: refusing \`backlog ${verb}\` — ` +
      (snapshot
        ? `this task's backlog authority is a READ-ONLY mounted snapshot. `
        : `this command writes the host store, which no agent container may reach. `) +
      `Ticket mutations happen on the host, against the authoritative store; there is no write path ` +
      `from an agent container, and a local write would be invisible to everyone. Report the change ` +
      `you want in your result instead.`,
  );
}
