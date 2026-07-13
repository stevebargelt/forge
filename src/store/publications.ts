// FG-425: durable state for the serialized integration publisher.
//
// THE WRITE RULE (FG-548): every mutation here takes its write lock IMMEDIATELY
// — db.transaction(fn).immediate(), i.e. BEGIN IMMEDIATE — never a deferred txn
// that reads first and upgrades to a writer mid-flight. The lane is the highest-
// contention cross-process write path in the system, and a deferred txn that
// upgrades under multi-process WAL is exactly FG-548's SQLITE_BUSY shape. This
// is a constraint on HOW the publisher writes; it is not FG-548's broader fix.
//
// THE CLOCK RULE: every lease timestamp is written and compared against ONE
// clock — the store's (storeNowMs, read from SQLite itself). Never against an
// independently-sourced process clock, which would let two Forge processes with
// skewed clocks disagree about whether a lease has expired.

import { getDb } from "./db.js";

export type PublicationState =
  | "intent"      // recorded BEFORE any mutation (AD-5); nothing has happened yet
  | "building"    // candidate worktree created, sources merging
  | "validating"  // gate/reds running against the candidate — NOT against the target
  | "publishing"  // inside the short CAS window
  | "published"   // publishedSha === candidateSha landed on the target
  | "failed"      // merge or validation failed; evidence retained
  | "parked"      // named blocker: publish_base_churn | dirty_publish_target
  | "abandoned";  // lane lease expired and a later attempt took over (AD-7)

export type LaneState = "queued" | "holding" | "done" | "abandoned";

export type ParkReason = "publish_base_churn" | "dirty_publish_target" | "lane_taken_over";

export type PublicationAttempt = {
  attemptId: string;
  projectKey: string;
  canonicalDir: string;
  runId: string;
  taskId: string;
  target: string;
  baseSha?: string;
  candidateSha?: string;
  publishedSha?: string;
  state: PublicationState;
  parkReason?: ParkReason;
  worktreePath?: string;
  rebuildCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LaneEntry = {
  attemptId: string;
  projectKey: string;
  enqueueSeq: number;
  runId: string;
  state: LaneState;
  leaseExpiresAtMs: number;
  enqueuedAt: string;
};

type AttemptRow = {
  attempt_id: string;
  project_key: string;
  canonical_dir: string;
  run_id: string;
  task_id: string;
  target: string;
  base_sha: string | null;
  candidate_sha: string | null;
  published_sha: string | null;
  state: string;
  park_reason: string | null;
  worktree_path: string | null;
  rebuild_count: number;
  created_at: string;
  updated_at: string;
};

type LaneRow = {
  attempt_id: string;
  project_key: string;
  enqueue_seq: number;
  run_id: string;
  state: string;
  lease_expires_at_ms: number;
  enqueued_at: string;
};

function toAttempt(r: AttemptRow): PublicationAttempt {
  return {
    attemptId: r.attempt_id,
    projectKey: r.project_key,
    canonicalDir: r.canonical_dir,
    runId: r.run_id,
    taskId: r.task_id,
    target: r.target,
    ...(r.base_sha !== null ? { baseSha: r.base_sha } : {}),
    ...(r.candidate_sha !== null ? { candidateSha: r.candidate_sha } : {}),
    ...(r.published_sha !== null ? { publishedSha: r.published_sha } : {}),
    state: r.state as PublicationState,
    ...(r.park_reason !== null ? { parkReason: r.park_reason as ParkReason } : {}),
    ...(r.worktree_path !== null ? { worktreePath: r.worktree_path } : {}),
    rebuildCount: r.rebuild_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toLane(r: LaneRow): LaneEntry {
  return {
    attemptId: r.attempt_id,
    projectKey: r.project_key,
    enqueueSeq: r.enqueue_seq,
    runId: r.run_id,
    state: r.state as LaneState,
    leaseExpiresAtMs: r.lease_expires_at_ms,
    enqueuedAt: r.enqueued_at,
  };
}

// ── the one clock ─────────────────────────────────────────────────────────────

// Test seam ONLY: shifts the store clock so a test can age a lease past its
// expiry without sleeping. Nothing in production writes it.
let clockOffsetMs = 0;
export function setPublicationClockOffsetForTest(ms: number): void {
  clockOffsetMs = ms;
}

/** Milliseconds since epoch, read from SQLite — the single clock every lease is
 *  written and compared against. julianday() rather than unixepoch('subsec') so
 *  this does not depend on the bundled SQLite being recent. */
export function storeNowMs(): number {
  const row = getDb()
    .prepare(`SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS ms`)
    .get() as { ms: number };
  return row.ms + clockOffsetMs;
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── attempts ──────────────────────────────────────────────────────────────────

/** AD-5: record publication INTENT and take a lane ticket, in ONE immediate txn,
 *  BEFORE any target mutation and before any contention. The returned enqueueSeq
 *  is the durable FIFO key — assigned here, at record time, and never re-derived
 *  from lock-acquisition order later.
 *
 *  enqueue_seq is monotonic across the WHOLE table (not per-project) so a pruned
 *  lane can never hand a later attempt a number an earlier one already used.
 *  Ordering WITHIN a project is what matters, and it is still strictly correct. */
export function recordPublicationIntent(rec: {
  attemptId: string;
  projectKey: string;
  canonicalDir: string;
  runId: string;
  taskId: string;
  target: string;
  leaseTtlMs: number;
}): LaneEntry {
  const db = getDb();
  return db.transaction((): LaneEntry => {
    const now = storeNowMs();
    const iso = nowIso(now);
    db.prepare(
      `INSERT INTO publication_attempts
         (attempt_id, project_key, canonical_dir, run_id, task_id, target, state, rebuild_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'intent', 0, ?, ?)`,
    ).run(rec.attemptId, rec.projectKey, rec.canonicalDir, rec.runId, rec.taskId, rec.target, iso, iso);

    const seqRow = db
      .prepare(`SELECT COALESCE(MAX(enqueue_seq), 0) + 1 AS seq FROM publication_lane`)
      .get() as { seq: number };

    db.prepare(
      `INSERT INTO publication_lane
         (attempt_id, project_key, enqueue_seq, run_id, state, lease_expires_at_ms, enqueued_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(rec.attemptId, rec.projectKey, seqRow.seq, rec.runId, now + rec.leaseTtlMs, iso);

    return {
      attemptId: rec.attemptId,
      projectKey: rec.projectKey,
      enqueueSeq: seqRow.seq,
      runId: rec.runId,
      state: "queued",
      leaseExpiresAtMs: now + rec.leaseTtlMs,
      enqueuedAt: iso,
    };
  }).immediate();
}

export function updatePublicationAttempt(
  attemptId: string,
  patch: Partial<Pick<PublicationAttempt,
    "baseSha" | "candidateSha" | "publishedSha" | "state" | "parkReason" | "worktreePath" | "rebuildCount">>,
): void {
  const db = getDb();
  db.transaction(() => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, v: unknown): void => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.baseSha !== undefined) push("base_sha", patch.baseSha);
    if (patch.candidateSha !== undefined) push("candidate_sha", patch.candidateSha);
    if (patch.publishedSha !== undefined) push("published_sha", patch.publishedSha);
    if (patch.state !== undefined) push("state", patch.state);
    if (patch.parkReason !== undefined) push("park_reason", patch.parkReason);
    if (patch.worktreePath !== undefined) push("worktree_path", patch.worktreePath);
    if (patch.rebuildCount !== undefined) push("rebuild_count", patch.rebuildCount);
    if (sets.length === 0) return;
    push("updated_at", nowIso(storeNowMs()));
    vals.push(attemptId);
    db.prepare(`UPDATE publication_attempts SET ${sets.join(", ")} WHERE attempt_id = ?`).run(...vals);
  }).immediate();
}

export function getPublicationAttempt(attemptId: string): PublicationAttempt | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM publication_attempts WHERE attempt_id = ?`)
    .get(attemptId) as AttemptRow | undefined;
  return row ? toAttempt(row) : undefined;
}

export function publicationAttemptsForProject(projectKey: string): PublicationAttempt[] {
  const rows = getDb()
    .prepare(`SELECT * FROM publication_attempts WHERE project_key = ? ORDER BY created_at DESC`)
    .all(projectKey) as AttemptRow[];
  return rows.map(toAttempt);
}

/** Attempts left INSIDE the publication window — recorded as `publishing` and never
 *  resolved. This is the one non-terminal state in which the target may already have
 *  been mutated (AD-5), so it is the state the run path must sweep and recover
 *  before it publishes anything else against that project.
 *
 *  ABANDONED, NOT MERELY UNFINISHED. An attempt that is `publishing` RIGHT NOW, in
 *  another live forge process, is not something to recover — converging it would run
 *  a checkout underneath a publisher that is still working. The two are told apart
 *  the only way AD-7 permits: by the LEASE, a durable timestamp the owner refreshes.
 *  An attempt is swept only when its lane entry is terminal (its owner left without
 *  resolving the attempt) or its lease has genuinely lapsed (its owner is gone).
 *  A live owner renews across every span it can block in, including the mutex wait
 *  and the window itself, so it is never swept. Nothing is probed, signalled, or
 *  classified. */
export function unfinishedPublications(projectKey: string): PublicationAttempt[] {
  const now = storeNowMs();
  const rows = getDb()
    .prepare(
      `SELECT a.* FROM publication_attempts a
         LEFT JOIN publication_lane l ON l.attempt_id = a.attempt_id
        WHERE a.project_key = ?
          AND a.state = 'publishing'
          AND (l.attempt_id IS NULL
               OR l.state IN ('done', 'abandoned')
               OR l.lease_expires_at_ms < ?)
        ORDER BY a.created_at ASC`,
    )
    .all(projectKey, now) as AttemptRow[];
  return rows.map(toAttempt);
}

export function allPublicationAttempts(): PublicationAttempt[] {
  const rows = getDb()
    .prepare(`SELECT * FROM publication_attempts ORDER BY created_at DESC`)
    .all() as AttemptRow[];
  return rows.map(toAttempt);
}

// ── the lane ──────────────────────────────────────────────────────────────────

export type LaneTurn =
  | { ready: true; entry: LaneEntry }
  /** OUR entry is no longer active: a later attempt found our lease expired and
   *  took the lane over (AD-7 — a lease expiring is a durable timestamp lapsing,
   *  never a liveness judgement). A live owner CAN reach this: it means the owner
   *  blocked somewhere it did not renew. Terminal, and NAMED — the owner must
   *  neither wait for a turn it can no longer get nor pretend it still holds one. */
  | { ready: false; takenOver: true }
  | { ready: false; takenOver: false; holder: LaneEntry; ahead: number };

/** One tick of the lane: renew OUR lease, expire anyone whose owner-written
 *  lease is actually in the past, and answer "is it our turn?" — all in ONE
 *  immediate txn, so two processes can never both read themselves as head.
 *
 *  Takeover NEVER probes, signals, reaps, or classifies liveness (AD-7). A lease
 *  is a durable timestamp its owner refreshes; an expired one is skipped, and a
 *  live waiter that keeps renewing is never evictable no matter how long it
 *  waits. The lane is ALLOWED to be approximate: it owns ORDERING only.
 *  Correctness is owned independently by the mutex, the CAS against baseSha, the
 *  ancestry proof, and publication bound to the recorded candidateSha — so a
 *  wrongly-skipped entry loses the CAS and rebuilds or parks; it can never cause
 *  a wrong publication. */
export function laneTick(attemptId: string, leaseTtlMs: number): LaneTurn {
  const db = getDb();
  return db.transaction((): LaneTurn => {
    const now = storeNowMs();

    const me = db.prepare(`SELECT * FROM publication_lane WHERE attempt_id = ?`).get(attemptId) as
      | LaneRow
      | undefined;
    if (!me) throw new Error(`publication lane: no entry for attempt ${attemptId}`);

    // Read our OWN state before doing anything else. A previous tick of ours may
    // have been slow enough (or blocked somewhere it did not renew) that another
    // attempt found our lease lapsed and marked us abandoned. From that moment we
    // are not in the lane: we can never become head, and the head is someone else
    // — so both "wait for our turn" and "assume we're head" are wrong. Renewing
    // the lease of an entry that is already terminal would be worse still: it
    // would resurrect a row a second process has already stepped past.
    if (me.state !== "queued" && me.state !== "holding") {
      return { ready: false, takenOver: true };
    }

    // Renew our own lease: a waiter must never expire itself while waiting.
    db.prepare(`UPDATE publication_lane SET lease_expires_at_ms = ? WHERE attempt_id = ?`)
      .run(now + leaseTtlMs, attemptId);

    // Expire abandoned entries — ONLY those whose recorded expiry is genuinely
    // past. Marked terminal in this same immediate txn, so the lane cannot wedge
    // on a crashed owner.
    db.prepare(
      `UPDATE publication_lane
          SET state = 'abandoned'
        WHERE project_key = ?
          AND state IN ('queued', 'holding')
          AND attempt_id != ?
          AND lease_expires_at_ms < ?`,
    ).run(me.project_key, attemptId, now);
    db.prepare(
      `UPDATE publication_attempts
          SET state = 'abandoned', updated_at = ?
        WHERE state NOT IN ('published', 'failed', 'parked', 'abandoned')
          AND attempt_id IN (SELECT attempt_id FROM publication_lane WHERE project_key = ? AND state = 'abandoned')`,
    ).run(nowIso(now), me.project_key);

    const head = db
      .prepare(
        `SELECT * FROM publication_lane
          WHERE project_key = ? AND state IN ('queued', 'holding')
          ORDER BY enqueue_seq ASC
          LIMIT 1`,
      )
      .get(me.project_key) as LaneRow | undefined;

    // No head at all, or the head is us: our turn. (`!head` is unreachable — our
    // own row is queued/holding — but treating it as our turn keeps this total,
    // with no cast that a future edit could turn into a TypeError.)
    if (!head || head.attempt_id === attemptId) {
      db.prepare(`UPDATE publication_lane SET state = 'holding' WHERE attempt_id = ?`).run(attemptId);
      return { ready: true, entry: toLane({ ...me, state: "holding", lease_expires_at_ms: now + leaseTtlMs }) };
    }
    const ahead = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM publication_lane
            WHERE project_key = ? AND state IN ('queued','holding') AND enqueue_seq < ?`,
        )
        .get(me.project_key, me.enqueue_seq) as { n: number }
    ).n;
    return { ready: false, takenOver: false, holder: toLane(head), ahead };
  }).immediate();
}

/** Pre-extend OUR lease across a declared blocking span (the synchronous gate).
 *  See publication-lane.ts for why a timer-driven heartbeat cannot do this job.
 *
 *  Scoped to an ACTIVE entry, and returns false when there isn't one: a renewal
 *  that wrote to a row a takeover had already marked terminal would resurrect the
 *  lease of an attempt a second process has stepped past — the lane would then
 *  hold two live owners, which is the FIFO break the lease exists to prevent. The
 *  caller must fail closed on false. */
export function extendLaneLease(attemptId: string, ttlMs: number): boolean {
  const db = getDb();
  return db.transaction((): boolean => {
    const res = db
      .prepare(
        `UPDATE publication_lane SET lease_expires_at_ms = ?
          WHERE attempt_id = ? AND state IN ('queued', 'holding')`,
      )
      .run(storeNowMs() + ttlMs, attemptId);
    return res.changes > 0;
  }).immediate();
}

/** Leave the lane. Scoped to an ACTIVE entry so a takeover's `abandoned` mark is
 *  never overwritten with `done` on the way out — the row is the durable evidence
 *  that this attempt was stepped past. */
export function releaseLaneEntry(attemptId: string, state: Extract<LaneState, "done" | "abandoned">): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE publication_lane SET state = ?
        WHERE attempt_id = ? AND state IN ('queued', 'holding')`,
    ).run(state, attemptId);
  }).immediate();
}

/** Operator view: the lane for one project, in durable enqueue order. */
export function laneForProject(projectKey: string): LaneEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM publication_lane WHERE project_key = ? ORDER BY enqueue_seq ASC`)
    .all(projectKey) as LaneRow[];
  return rows.map(toLane);
}

export function activeLaneForProject(projectKey: string): LaneEntry[] {
  return laneForProject(projectKey).filter((e) => e.state === "queued" || e.state === "holding");
}

export function allLaneEntries(): LaneEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM publication_lane ORDER BY enqueue_seq ASC`)
    .all() as LaneRow[];
  return rows.map(toLane);
}

// ── the publication mutex (short window: CAS + fast-forward + checkout) ────────

export type MutexHolder = {
  projectKey: string;
  attemptId: string;
  runId: string;
  acquiredAtMs: number;
  expiresAtMs: number;
};

/** Try to take the project's publication mutex. Returns the holder when someone
 *  else has it (caller waits and retries). An EXPIRED holder is taken over in
 *  this same immediate txn — no liveness probe, no reaping (AD-7): a crashed
 *  holder's mutex must never wedge the project, and taking it over is safe
 *  because the CAS inside the window is what actually protects the target.
 *
 *  Used bare ONLY by recovery, which holds the window without a lane entry by
 *  design. A PUBLISHER must go through tryAcquirePublicationMutexAsLaneOwner. */
export function tryAcquirePublicationMutex(rec: {
  projectKey: string;
  attemptId: string;
  runId: string;
  ttlMs: number;
}): { acquired: true } | { acquired: false; holder: MutexHolder } {
  const db = getDb();
  return db.transaction((): { acquired: true } | { acquired: false; holder: MutexHolder } => {
    const now = storeNowMs();
    const held = db
      .prepare(`SELECT * FROM publication_locks WHERE project_key = ?`)
      .get(rec.projectKey) as
      | { project_key: string; attempt_id: string; run_id: string; acquired_at_ms: number; expires_at_ms: number }
      | undefined;

    if (held && held.expires_at_ms >= now && held.attempt_id !== rec.attemptId) {
      return {
        acquired: false,
        holder: {
          projectKey: held.project_key,
          attemptId: held.attempt_id,
          runId: held.run_id,
          acquiredAtMs: held.acquired_at_ms,
          expiresAtMs: held.expires_at_ms,
        },
      };
    }
    db.prepare(
      `INSERT INTO publication_locks (project_key, attempt_id, run_id, acquired_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_key) DO UPDATE SET
         attempt_id = excluded.attempt_id,
         run_id = excluded.run_id,
         acquired_at_ms = excluded.acquired_at_ms,
         expires_at_ms = excluded.expires_at_ms`,
    ).run(rec.projectKey, rec.attemptId, rec.runId, now, now + rec.ttlMs);
    return { acquired: true };
  }).immediate();
}

export type LaneOwnerAcquisition =
  | { acquired: true }
  | { acquired: false; reason: "held"; holder: MutexHolder }
  /** Our lane entry went terminal underneath us: a later attempt found our lease
   *  lapsed and took the lane over. We are not in the lane any more, so we must
   *  never enter the window — a taken-over attempt that published anyway would move
   *  the base of the attempt that stepped past it, out of FIFO order. */
  | { acquired: false; reason: "lane_lost" };

/** The PUBLISHER's acquire: the same mutex, granted only while the caller still
 *  owns an ACTIVE lane entry — checked in the SAME immediate txn as the grant, so a
 *  takeover cannot land between the check and the window. A renewal alone would be
 *  a TOCTOU; this is what actually keeps a taken-over owner out of the target. */
export function tryAcquirePublicationMutexAsLaneOwner(rec: {
  projectKey: string;
  attemptId: string;
  runId: string;
  ttlMs: number;
}): LaneOwnerAcquisition {
  const db = getDb();
  return db.transaction((): LaneOwnerAcquisition => {
    const now = storeNowMs();
    const lane = db
      .prepare(`SELECT state FROM publication_lane WHERE attempt_id = ?`)
      .get(rec.attemptId) as { state: string } | undefined;
    if (!lane || (lane.state !== "queued" && lane.state !== "holding")) {
      return { acquired: false, reason: "lane_lost" };
    }

    const held = db
      .prepare(`SELECT * FROM publication_locks WHERE project_key = ?`)
      .get(rec.projectKey) as
      | { project_key: string; attempt_id: string; run_id: string; acquired_at_ms: number; expires_at_ms: number }
      | undefined;

    if (held && held.expires_at_ms >= now && held.attempt_id !== rec.attemptId) {
      return {
        acquired: false,
        reason: "held",
        holder: {
          projectKey: held.project_key,
          attemptId: held.attempt_id,
          runId: held.run_id,
          acquiredAtMs: held.acquired_at_ms,
          expiresAtMs: held.expires_at_ms,
        },
      };
    }
    db.prepare(
      `INSERT INTO publication_locks (project_key, attempt_id, run_id, acquired_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_key) DO UPDATE SET
         attempt_id = excluded.attempt_id,
         run_id = excluded.run_id,
         acquired_at_ms = excluded.acquired_at_ms,
         expires_at_ms = excluded.expires_at_ms`,
    ).run(rec.projectKey, rec.attemptId, rec.runId, now, now + rec.ttlMs);
    return { acquired: true };
  }).immediate();
}

/** Push OUR mutex lease out. Returns false when the row is no longer ours — a
 *  later attempt found the lease lapsed and took the window over — so the caller
 *  can FAIL CLOSED rather than keep writing to a working tree it no longer owns.
 *  Scoped to (project_key, attempt_id), so it can never re-take a mutex someone
 *  else now holds.
 *
 *  The window is a SYNCHRONOUS span of git calls: no timer can fire inside it, so
 *  the holder renews BETWEEN ops instead of on a heartbeat. That is only sufficient
 *  because each op carries its own hard ceiling (WINDOW_GIT_TIMEOUT_MS in
 *  publication-target.ts) — bounded op + TTL derived from that bound means a LIVE
 *  holder's lease cannot lapse mid-window, so an expired lease still means what
 *  takeover assumes it means: the holder is gone (AD-7 — a durable timestamp
 *  lapsing, never a liveness probe). */
export function renewPublicationMutex(projectKey: string, attemptId: string, ttlMs: number): boolean {
  const db = getDb();
  return db.transaction((): boolean => {
    const res = db
      .prepare(`UPDATE publication_locks SET expires_at_ms = ? WHERE project_key = ? AND attempt_id = ?`)
      .run(storeNowMs() + ttlMs, projectKey, attemptId);
    return res.changes > 0;
  }).immediate();
}

/** Release the mutex iff WE still hold it — never unlink a holder that took it
 *  over from us after our lease expired. */
export function releasePublicationMutex(projectKey: string, attemptId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM publication_locks WHERE project_key = ? AND attempt_id = ?`)
      .run(projectKey, attemptId);
  }).immediate();
}

export function publicationMutexHolder(projectKey: string): MutexHolder | undefined {
  const held = getDb()
    .prepare(`SELECT * FROM publication_locks WHERE project_key = ?`)
    .get(projectKey) as
    | { project_key: string; attempt_id: string; run_id: string; acquired_at_ms: number; expires_at_ms: number }
    | undefined;
  if (!held) return undefined;
  return {
    projectKey: held.project_key,
    attemptId: held.attempt_id,
    runId: held.run_id,
    acquiredAtMs: held.acquired_at_ms,
    expiresAtMs: held.expires_at_ms,
  };
}
