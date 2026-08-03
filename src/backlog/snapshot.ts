// FG-608 (FG-496 Slice C, 1d): THE SNAPSHOT PUBLISHER.
//
// This module resolves the architecture-gate red finding verbatim — "the proposed
// push-snapshot design leaves the only mechanism that can satisfy post-start
// amendment visibility unowned and unspecified". It is that owner.
//
// ─── THE MODEL (accepted default (a)): PUSH ──────────────────────────────────
// The HOST publishes a per-project, BACKLOG-ONLY snapshot database; the container
// reads a read-only DIRECTORY mount. Nothing live is shared across the VM
// boundary.
//
// ─── WHY THE SHAPE IS FORCED (both halves measured) ──────────────────────────
// (i) A read-only mount cannot host a WAL database at all: opening a
//     journal_mode=WAL DB read-only from a non-writable directory fails
//     SQLITE_READONLY_DIRECTORY (SQLite must be able to create/attach the -shm
//     and -wal files), while the same database as journal_mode=DELETE opens and
//     reads fine. So the published artifact MUST be non-WAL. buildSnapshot below
//     therefore never leaves WAL on, and assertNonWalSnapshot is a real assertion,
//     not a comment.
//
// (ii) A FILE bind-mount pins the INODE at container start. A host-side atomic
//     replace (write-temp + rename) allocates a NEW inode, so the container would
//     keep reading the original file for its entire life — and forge containers
//     are one-per-task, long-lived and never restarted (docker-exec.ts;
//     retry.ts mints a FRESH container rather than restarting one). The only way
//     to make a pinned inode change is an in-place rewrite, which is exactly the
//     torn read the concurrency AC forbids. So the containing DIRECTORY is
//     mounted read-only and publication happens by write-temp + rename INSIDE it.
//     This is a MOUNT-SHAPE REQUIREMENT asserted by the tests, not an
//     implementation detail.
//
// ─── OWNERSHIP (the finding being paid off) ──────────────────────────────────
//   * OWNER — this module. Publication is invoked from ONE choke point on the
//     host write path (markBacklogDirty, called by the store-level ticket writers
//     in src/store/tickets.ts), never scattered per-caller.
//   * INTEGRATION — every authoritative ticket write funnels through those store
//     writers: the structured.ts seam writers (writeTicket / closeTicket /
//     retitleTicket / moveTicket / fillClosedCommit / fileNewTicket all go through
//     writeTicketRow -> upsertSeamTicket + relation/evidence writers) and
//     importBacklog. src/backlog/fg608-publish-writepath-coverage.test.ts FAILS
//     when a new write path is added without publication wiring, so this is
//     enforced rather than conventional.
//   * ORDERING — publication runs AFTER the durable commit, never inside the
//     transaction. markBacklogDirty only records the dirty project_key; the flush
//     happens when the outermost writeTransaction commits (see beginPublishBarrier
//     / endPublishBarrier, called from db.ts:writeTransaction) or immediately when
//     no transaction is open. Publishing inside the transaction would do external
//     I/O while holding the write lock AND could publish rows that then roll back.
//   * FAILURE — a publication failure NEVER fails or rolls back the authoritative
//     host write. The DB is truth; the snapshot is derived. Bounded retry
//     (PUBLISH_MAX_ATTEMPTS); on exhaustion the target is marked STALE durably.
//   * OPERATOR VISIBILITY — describeStalePublications() surfaces stale targets in
//     `forge backlog` output, so an unpublished amendment is visible as stale and
//     never indistinguishable from an up-to-date container.
//   * FAN-OUT — every host-side ticket write refreshes the snapshot of EVERY live
//     target registered for that project_key.

import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
// (rmSync is used both for temp-file cleanup and for releasing a finished target.)
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getDb } from "../store/db.js";

/** The snapshot database's basename inside the published directory. The container
 *  resolves exactly this name under its mount pointer. */
export const SNAPSHOT_DB_BASENAME = "backlog.db";

/** Bounded retry. Deliberately small and synchronous: publication is on the tail
 *  of a host write, and a slow retry loop would stall interactive CLI commands.
 *  Exhaustion is not silent — it sets the durable stale marker. */
export const PUBLISH_MAX_ATTEMPTS = 3;

/** Backoff between publish attempts, multiplied by the attempt number. Small on
 *  purpose: this runs on the tail of an interactive CLI write. */
export const PUBLISH_BACKOFF_MS = 25;

/** A synchronous pause. Publication is synchronous from markBacklogDirty down, so
 *  there is no event loop to yield to — Atomics.wait on a private buffer is the one
 *  sleep that does not busy-spin a core. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── the published schema (backlog-only, project-scoped) ─────────────────────
// PROJECT ISOLATION is structural, not a WHERE clause the container could drop:
// the snapshot file physically contains ONLY this project_key's backlog rows, and
// contains NO runs / tasks / events / gates / verdicts / campaigns tables at all.
// The full ~/.forge/forge.db is never mounted.
const SNAPSHOT_SCHEMA_SQL = `
CREATE TABLE snapshot_meta (
  project_key   TEXT NOT NULL,
  published_at  TEXT NOT NULL,
  max_revision  INTEGER NOT NULL,
  publication_ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE tickets (
  ticket_id     TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  created       TEXT,
  closed        TEXT,
  closed_commit TEXT,
  epic          TEXT,
  revision      INTEGER NOT NULL DEFAULT 1,
  body_hash     TEXT
);
CREATE TABLE ticket_relations (
  ticket_id  TEXT NOT NULL,
  related_id TEXT NOT NULL,
  rel_type   TEXT NOT NULL,
  PRIMARY KEY (ticket_id, related_id, rel_type)
);
CREATE TABLE blocker_evidence (
  ticket_id  TEXT NOT NULL,
  reason     TEXT,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, source)
);
`;

export type SnapshotTarget = {
  projectKey: string;
  targetDir: string;
  taskId: string | null;
  createdAt: string | null;
};

/** What the dispatch path can say about a registered target's owning task. An
 *  UNKNOWN task is not a finished one — see releaseFinishedTargets. */
export type TargetLiveness = "live" | "finished" | "unknown";

/** How long an UNKNOWN target's row is kept fanning out before an age sweep stops
 *  it. Long enough that a task the store has not caught up on yet is never cut off
 *  mid-run; short enough that a genuinely orphaned row does not fan out forever. */
export const UNKNOWN_TARGET_SWEEP_MS = 24 * 60 * 60 * 1000;

export type PublicationState = {
  projectKey: string;
  targetDir: string;
  state: "ok" | "stale";
  attempts: number;
  lastOkAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

// ─── live target registry (fan-out membership) ───────────────────────────────

/** Register a live container's snapshot directory for this project_key. Called by
 *  the dispatch path (spawn.ts) BEFORE the container starts, so the very first
 *  in-container read already has an artifact and every subsequent host write fans
 *  out to it. Idempotent. */
export function registerSnapshotTarget(projectKey: string, targetDir: string, taskId?: string): void {
  getDb()
    .prepare(
      `INSERT INTO backlog_snapshot_targets (project_key, target_dir, task_id, created_at, released_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(project_key, target_dir) DO UPDATE SET
         task_id = excluded.task_id, released_at = NULL`,
    )
    .run(projectKey, targetDir, taskId ?? null, new Date().toISOString());
}

/** Stop fanning out to a target whose container is gone.
 *
 *  THE ROW AND THE DIRECTORY ARE TWO DECISIONS, and FG-608 red F12 is what happens
 *  when they are one. `targetDir` is the SOURCE of a live `:ro` bind mount: deleting
 *  it out from under a running container does not "clean up", it strands that agent
 *  with an unlinked mount for the rest of its task. Releasing the ROW is always
 *  safe — it only stops future fan-out — so it is unconditional. Deleting the
 *  ARTIFACT requires positive knowledge that the owning task has finished, which
 *  only the caller has. Default: keep the bytes — reclaimReleasedTargets below is
 *  what reclaims them once that knowledge exists, so keeping them is a deferral
 *  rather than a strand. */
export function releaseSnapshotTarget(
  projectKey: string,
  targetDir: string,
  opts: { deleteArtifact?: boolean } = {},
): void {
  getDb()
    .prepare(
      `UPDATE backlog_snapshot_targets SET released_at = ? WHERE project_key = ? AND target_dir = ?`,
    )
    .run(new Date().toISOString(), projectKey, targetDir);
  // N2: RECLAIM the publication row with the target. A stale row belonging to a
  // container that no longer exists is not an operator signal — nothing can act on
  // it and nothing will ever clear it, so it warns on every `forge backlog` command
  // forever and trains the operator to ignore the warning that matters.
  getDb()
    .prepare(`DELETE FROM backlog_snapshot_publications WHERE project_key = ? AND target_dir = ?`)
    .run(projectKey, targetDir);
  if (!opts.deleteArtifact) return;
  try {
    rmSync(targetDir, { recursive: true, force: true });
  } catch {
    // The artifact is derived and the row is already released, so a failed cleanup
    // costs disk, not correctness. Never let it propagate into a ticket write.
  }
}

/** Release every live target of `projectKey` whose owning task is FINISHED. Called
 *  before registering a new target (spawn.ts), which is the one moment we are
 *  guaranteed to be on the dispatch path for this project.
 *
 *  The liveness predicate is INJECTED rather than imported so this module keeps
 *  knowing only about backlogs — snapshot.ts must not grow a dependency on the task
 *  state machine. It returns THREE states, not a boolean, because "the store has no
 *  row for this task" and "this task finished" are different facts and only the
 *  second one licenses deleting a mount source. An unknown target ages out: its row
 *  is released once it is older than UNKNOWN_TARGET_SWEEP_MS, and its bytes are
 *  never deleted here — reclaimReleasedTargets picks those up on a later dispatch.
 *
 *  Returns the target dirs it released. */
export function releaseFinishedTargets(
  projectKey: string,
  liveness: (taskId: string) => TargetLiveness,
  now: number = Date.now(),
): string[] {
  const released: string[] = [];
  for (const target of liveSnapshotTargets(projectKey)) {
    // A target with no task id was registered by a test or an ad-hoc caller; it has
    // no liveness signal, so leave it alone rather than guess.
    if (!target.taskId) continue;
    const state = liveness(target.taskId);
    if (state === "live") continue;
    if (state === "finished") {
      releaseSnapshotTarget(projectKey, target.targetDir, { deleteArtifact: true });
      released.push(target.targetDir);
      continue;
    }
    const age = target.createdAt ? now - Date.parse(target.createdAt) : Number.NaN;
    if (Number.isFinite(age) && age > UNKNOWN_TARGET_SWEEP_MS) {
      releaseSnapshotTarget(projectKey, target.targetDir);
      released.push(target.targetDir);
    }
  }
  return released;
}

/** Reclaim the BYTES of targets that have ALREADY been released.
 *
 *  The second half of releaseFinishedTargets, and the reason a released row is not
 *  a permanent strand: releasing a row takes the target out of liveSnapshotTargets,
 *  which is the only thing the sweep above iterates — so before this existed, a
 *  directory holding the project's full ticket bodies was reachable by no sweep at
 *  all once its row had been released (by dispatch compensation, or by the sweep
 *  above's own unknown-target age-out). Called from the same dispatch-time moment,
 *  with the same injected liveness predicate.
 *
 *  The polarity is unchanged from releaseFinishedTargets: bytes are deleted only
 *  against a POSITIVE fact that nothing is reading them. A released row whose task
 *  still reads `live` keeps its bytes — a row is released when the container is
 *  known to be gone, but a task that is somehow still live outranks that. An
 *  unresolvable task ages out on the same UNKNOWN_TARGET_SWEEP_MS bound.
 *
 *  The ROW is deleted with the bytes: it has no reader left, and leaving released
 *  rows behind forever just moves the unbounded growth from disk to the table.
 *
 *  Returns the target dirs it reclaimed. */
export function reclaimReleasedTargets(
  projectKey: string,
  liveness: (taskId: string) => TargetLiveness,
  now: number = Date.now(),
): string[] {
  const reclaimed: string[] = [];
  for (const target of releasedSnapshotTargets(projectKey)) {
    const state = target.taskId ? liveness(target.taskId) : "unknown";
    if (state === "live") continue;
    if (state === "unknown") {
      const age = target.createdAt ? now - Date.parse(target.createdAt) : Number.NaN;
      if (!Number.isFinite(age) || age <= UNKNOWN_TARGET_SWEEP_MS) continue;
    }
    try {
      rmSync(target.targetDir, { recursive: true, force: true });
    } catch {
      // Derived bytes; a failed unlink costs disk, not correctness. Leave the row
      // so the next dispatch tries again rather than losing track of the directory.
      continue;
    }
    getDb()
      .prepare(`DELETE FROM backlog_snapshot_targets WHERE project_key = ? AND target_dir = ?`)
      .run(projectKey, target.targetDir);
    reclaimed.push(target.targetDir);
  }
  return reclaimed;
}

export function liveSnapshotTargets(projectKey: string): SnapshotTarget[] {
  return targetRows(
    `SELECT project_key, target_dir, task_id, created_at FROM backlog_snapshot_targets
      WHERE project_key = ? AND released_at IS NULL ORDER BY target_dir ASC`,
    projectKey,
  );
}

export function releasedSnapshotTargets(projectKey: string): SnapshotTarget[] {
  return targetRows(
    `SELECT project_key, target_dir, task_id, created_at FROM backlog_snapshot_targets
      WHERE project_key = ? AND released_at IS NOT NULL ORDER BY target_dir ASC`,
    projectKey,
  );
}

function targetRows(sql: string, projectKey: string): SnapshotTarget[] {
  const rows = getDb()
    .prepare(sql)
    .all(projectKey) as {
    project_key: string;
    target_dir: string;
    task_id: string | null;
    created_at: string | null;
  }[];
  return rows.map((r) => ({
    projectKey: r.project_key,
    targetDir: r.target_dir,
    taskId: r.task_id,
    createdAt: r.created_at,
  }));
}

// ─── durable publication state ───────────────────────────────────────────────

function recordPublication(
  projectKey: string,
  targetDir: string,
  state: "ok" | "stale",
  attempts: number,
  error: string | null,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO backlog_snapshot_publications
         (project_key, target_dir, state, attempts, last_ok_at, last_error, updated_at)
       VALUES (@projectKey, @targetDir, @state, @attempts, @lastOkAt, @lastError, @updatedAt)
       ON CONFLICT(project_key, target_dir) DO UPDATE SET
         state = excluded.state,
         attempts = excluded.attempts,
         last_ok_at = COALESCE(excluded.last_ok_at, backlog_snapshot_publications.last_ok_at),
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run({
      projectKey,
      targetDir,
      state,
      attempts,
      lastOkAt: state === "ok" ? now : null,
      lastError: error,
      updatedAt: now,
    });
}

export function publicationStates(projectKey: string): PublicationState[] {
  // N2: a publication row describes a LIVE target. Releasing the target retires the
  // row (releaseSnapshotTarget), and this join is the second half of the same fact:
  // a row whose target has been released — by any path, including one that never
  // went through releaseSnapshotTarget — describes a container that is gone, and
  // reporting it as a current stale publication is a warning no operator can act on.
  const rows = getDb()
    .prepare(
      `SELECT p.project_key, p.target_dir, p.state, p.attempts, p.last_ok_at, p.last_error, p.updated_at
         FROM backlog_snapshot_publications p
         JOIN backlog_snapshot_targets t
           ON t.project_key = p.project_key AND t.target_dir = p.target_dir
        WHERE p.project_key = ? AND t.released_at IS NULL
        ORDER BY p.target_dir ASC`,
    )
    .all(projectKey) as {
    project_key: string;
    target_dir: string;
    state: string;
    attempts: number;
    last_ok_at: string | null;
    last_error: string | null;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    projectKey: r.project_key,
    targetDir: r.target_dir,
    state: r.state === "stale" ? "stale" : "ok",
    attempts: r.attempts,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  }));
}

/** The operator-facing stale-publication line, or null when every live target is
 *  current. Surfaced by the `forge backlog` store banner so an amendment that
 *  never reached a running container is visible AS STALE rather than looking
 *  identical to an up-to-date one. */
export function describeStalePublications(projectKey: string): string | null {
  const stale = publicationStates(projectKey).filter((p) => p.state === "stale");
  if (stale.length === 0) return null;
  const detail = stale
    .map((p) => `${p.targetDir}${p.lastError ? ` (${p.lastError})` : ""}`)
    .join(", ");
  return (
    `warning: ${stale.length} container backlog snapshot(s) are STALE and did not receive the ` +
    `latest ticket write — a running agent may be reading an older ticket: ${detail}`
  );
}

// ─── snapshot construction ───────────────────────────────────────────────────

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

/** The ordering stamp a build carries. `ordinal` is the primary key and the whole
 *  point of F7's recheck: it advances on EVERY write that dirties the project, so
 *  two builds from consecutive states are strictly ordered even when the ticket that
 *  moved is not the project's highest-revision one. `maxRevision` is kept as a
 *  secondary tiebreak — it still catches an older build in the (production-
 *  unreachable, test-reachable) case where the ordinal did not move. */
type SnapshotStamp = { ordinal: number; maxRevision: number };

/** True when a build carrying `built` must NOT rename over what is already on disk. */
function isSuperseded(onDisk: SnapshotStamp, built: SnapshotStamp): boolean {
  if (onDisk.ordinal !== built.ordinal) return onDisk.ordinal > built.ordinal;
  return onDisk.maxRevision > built.maxRevision;
}

/** Advance this project's publication ordinal. Called from the dirty choke point, so
 *  under an open writeTransaction the bump is atomic with the ticket write that
 *  caused it — a build that sees the row sees the ordinal that goes with it. */
function bumpPublicationOrdinal(projectKey: string): void {
  getDb()
    .prepare(
      `INSERT INTO backlog_publication_ordinal (project_key, ordinal) VALUES (?, 1)
       ON CONFLICT(project_key) DO UPDATE SET ordinal = ordinal + 1`,
    )
    .run(projectKey);
}

/** Build a complete, self-contained, NON-WAL snapshot database at `path`. Returns
 *  the ordering stamp it captured — what publishSnapshotOnce compares against
 *  whatever is already on disk. */
function buildSnapshot(projectKey: string, path: string): SnapshotStamp {
  const src = getDb();
  // F8: ONE read transaction over all three source tables. Un-transacted, the
  // tickets SELECT could observe a state that the relations SELECT then does not —
  // a published artifact mixing two committed states, e.g. a ticket whose 'blocked'
  // reconstruction lost the blocker_evidence row that justified it. A deferred read
  // transaction gives all three statements one consistent view; it takes no write
  // lock and blocks nobody.
  const { tickets, relations, evidence, ordinal } = src.transaction(() => ({
    // Read INSIDE the same view as the rows: the stamp must describe exactly the
    // state this build captured, not the state the DB reached while it was building.
    ordinal:
      (
        src.prepare(`SELECT ordinal FROM backlog_publication_ordinal WHERE project_key = ?`).get(projectKey) as
          | { ordinal: number }
          | undefined
      )?.ordinal ?? 0,
    tickets: src
      .prepare(
        `SELECT ticket_id, type, status, title, body, created, closed, closed_commit, epic,
                revision, body_hash
           FROM tickets WHERE project_key = ? ORDER BY ticket_id ASC`,
      )
      .all(projectKey) as SnapshotTicketRow[],
    relations: src
      .prepare(
        `SELECT ticket_id, related_id, rel_type FROM ticket_relations
          WHERE project_key = ? ORDER BY ticket_id ASC`,
      )
      .all(projectKey) as { ticket_id: string; related_id: string; rel_type: string }[],
    evidence: src
      .prepare(
        `SELECT ticket_id, reason, source, created_at FROM blocker_evidence
          WHERE project_key = ? ORDER BY ticket_id ASC`,
      )
      .all(projectKey) as {
      ticket_id: string;
      reason: string | null;
      source: string;
      created_at: string;
    }[],
  })).deferred();

  const out: DatabaseInstance = new Database(path);
  try {
    // NON-WAL, deliberately (forced shape (i) above). A brand-new better-sqlite3
    // database defaults to the rollback journal; set it explicitly anyway so the
    // artifact's mode is an asserted property rather than an inherited default.
    out.pragma("journal_mode = DELETE");
    out.exec(SNAPSHOT_SCHEMA_SQL);
    const insTicket = out.prepare(
      `INSERT INTO tickets
         (ticket_id, type, status, title, body, created, closed, closed_commit, epic, revision, body_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insRel = out.prepare(
      `INSERT INTO ticket_relations (ticket_id, related_id, rel_type) VALUES (?, ?, ?)`,
    );
    const insEvidence = out.prepare(
      `INSERT INTO blocker_evidence (ticket_id, reason, source, created_at) VALUES (?, ?, ?, ?)`,
    );
    let maxRevision = 0;
    out.transaction(() => {
      for (const t of tickets) {
        insTicket.run(
          t.ticket_id, t.type, t.status, t.title, t.body, t.created, t.closed,
          t.closed_commit, t.epic, t.revision, t.body_hash,
        );
        if (t.revision > maxRevision) maxRevision = t.revision;
      }
      for (const r of relations) insRel.run(r.ticket_id, r.related_id, r.rel_type);
      for (const b of evidence) insEvidence.run(b.ticket_id, b.reason, b.source, b.created_at);
      out
        .prepare(
          `INSERT INTO snapshot_meta (project_key, published_at, max_revision, publication_ordinal)
           VALUES (?, ?, ?, ?)`,
        )
        .run(projectKey, new Date().toISOString(), maxRevision, ordinal);
    }).immediate();
    return { ordinal, maxRevision };
  } finally {
    out.close();
  }
}

/** The ordering stamp already on disk at `path`, or null when there is nothing
 *  readable there. A file that will not open, carries no snapshot_meta, or predates
 *  the ordinal column is treated as ABSENT, never as newer: refusing to publish over
 *  an unreadable artifact would leave a container permanently stranded on garbage. */
function onDiskStamp(path: string): SnapshotStamp | null {
  if (!existsSync(path)) return null;
  let db: DatabaseInstance | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT max_revision, publication_ordinal FROM snapshot_meta LIMIT 1`).get() as
      | { max_revision: number; publication_ordinal: number }
      | undefined;
    return row ? { ordinal: row.publication_ordinal, maxRevision: row.max_revision } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Publish ONE target: write-temp + rename INSIDE the mounted directory.
 *
 *  ATOMICITY (property (i) of MANDATE 5): rename(2) within one filesystem is
 *  atomic, so a concurrent reader either opens the whole previous file or the
 *  whole new one — never a partially-written database. The temp name is random,
 *  so two concurrent publishers never share a temp file and never interleave
 *  writes into one. Note this proves atomic REPLACEMENT only; it is NOT evidence
 *  of end-to-end delivery to a container (property (ii)), which is tested
 *  separately and must go through the production path. */
export function publishSnapshotOnce(projectKey: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  const finalPath = join(targetDir, SNAPSHOT_DB_BASENAME);
  const tmpPath = join(targetDir, `.${SNAPSHOT_DB_BASENAME}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const built = buildSnapshot(projectKey, tmpPath);
    // ORDERING (F7). rename(2) is atomic but not ordered: two publishers racing on
    // one target_dir can land in either order, and the LOSER wins the file. So the
    // published artifact carries a stamp and an older build declines — a skipped
    // rename leaves the container reading MORE recent truth, which is the objective.
    //
    // THE STAMP IS THE PUBLICATION ORDINAL, NOT THE PROJECT-WIDE MAX REVISION. Max
    // revision is the maximum over ALL tickets, so editing any ticket that is not
    // the highest-revision one does not move it: the two racing builds carried EQUAL
    // stamps, the guard's strict `>` never fired, and the older build renamed over
    // the newer one and was recorded 'ok'. That is the common case, not the corner.
    // The ordinal advances on every write that dirties the project, so consecutive
    // states are strictly ordered whichever ticket moved.
    const onDisk = onDiskStamp(finalPath);
    if (onDisk !== null && isSuperseded(onDisk, built)) {
      rmSync(tmpPath, { force: true });
      return;
    }
    renameSync(tmpPath, finalPath);
  } catch (e) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      // A leftover temp file is inert (the container only ever opens
      // SNAPSHOT_DB_BASENAME) — never let cleanup mask the real publish error.
    }
    throw e;
  }
}

/** Publish to every live target for a project_key. NEVER throws: the caller is on
 *  the tail of a committed authoritative write, and the DB is truth. */
export function publishToLiveTargets(projectKey: string): void {
  let targets: SnapshotTarget[];
  try {
    targets = liveSnapshotTargets(projectKey);
  } catch {
    return; // no store / no table — nothing to fan out to
  }
  for (const target of targets) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
      try {
        publishSnapshotOnce(projectKey, target.targetDir);
      } catch (e) {
        lastError = e;
        // Backoff between attempts (F13). Retrying instantly re-runs the same
        // failure against the same transiently-busy filesystem; a short pause is
        // what makes a bounded retry a retry rather than three copies of one
        // attempt. Synchronous by necessity — this whole path is.
        if (attempt < PUBLISH_MAX_ATTEMPTS) sleepSync(PUBLISH_BACKOFF_MS * attempt);
        continue;
      }
      // SUCCESS BOOKKEEPING SITS OUTSIDE THE PUBLISH TRY (F13). Inside it, a failing
      // recordPublication was indistinguishable from a failing publish: the loop
      // republished an artifact that was already CURRENT, up to the attempt ceiling,
      // and then marked a perfectly fresh snapshot STALE. The bytes are delivered at
      // this point; only the record of it can still fail.
      lastError = undefined;
      try {
        recordPublication(projectKey, target.targetDir, "ok", attempt, null);
      } catch {
        // The artifact IS published. A lost bookkeeping row costs operator
        // visibility, never delivery, and must not re-enter the retry loop.
      }
      break;
    }
    if (lastError !== undefined) {
      // Retry exhausted. The host write already committed and STAYS committed —
      // marking stale is the whole point of the bounded retry having a floor.
      try {
        recordPublication(
          projectKey,
          target.targetDir,
          "stale",
          PUBLISH_MAX_ATTEMPTS,
          (lastError as Error).message ?? String(lastError),
        );
      } catch {
        // Even the marker write failed (store gone). Nothing further is safe to
        // do here; the authoritative write is untouched, which is the invariant.
      }
    }
  }
}

// ─── the choke point ─────────────────────────────────────────────────────────

// Dirty project_keys accumulated inside an open writeTransaction. Publication is
// POST-COMMIT: publishing mid-transaction would do file I/O under the write lock
// and could publish rows that then roll back.
let barrierDepth = 0;
const pendingProjects = new Set<string>();

/** Test/ops seam: publication is opt-in per process. It is armed by the dispatch
 *  path and by tests that exercise delivery; a plain `forge backlog list` on a
 *  project with no live containers has no targets anyway, so the default costs
 *  one indexed SELECT. */
export function markBacklogDirty(projectKey: string): void {
  if (!projectKey) return;
  // F7: advance the ordering stamp with the write that dirtied the project. Wrapped
  // because this runs on the authoritative write path and the whole module's
  // invariant is that no publication concern can fail a committed ticket write — a
  // lost bump degrades the ordering guard, it must never roll back the truth.
  try {
    bumpPublicationOrdinal(projectKey);
  } catch {
    /* no store / no table — the guard falls back to the revision tiebreak */
  }
  if (barrierDepth > 0) {
    pendingProjects.add(projectKey);
    return;
  }
  publishToLiveTargets(projectKey);
}

/** Called by db.ts:writeTransaction. Nested transactions increment; only the
 *  OUTERMOST commit flushes, and a rollback discards the pending set entirely
 *  (nothing was durable, so nothing may be published). */
export function beginPublishBarrier(): void {
  barrierDepth++;
}

export function endPublishBarrier(committed: boolean): void {
  barrierDepth = Math.max(0, barrierDepth - 1);
  if (barrierDepth > 0) return;
  const keys = [...pendingProjects];
  pendingProjects.clear();
  if (!committed) return;
  for (const key of keys) publishToLiveTargets(key);
}

/** Test seam: forget any pending publication (used between tests that swap DBs). */
export function resetPublishBarrierForTest(): void {
  barrierDepth = 0;
  pendingProjects.clear();
}
