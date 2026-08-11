import { getDb, writeTransaction } from "./db.js";
import type { Run, RunStatus, ReviewMode } from "../types/index.js";
import { nowIso } from "../util/ids.js";
import { notifyOnRunTransition } from "../notify/trigger.js";
import { identify, provenPhysical, provenSameOnly, type PathIdentity } from "../util/path-identity.js";
import { attributeLegacyRow, retargetProofIdentity } from "./legacy-path-attribution.js";

// ── FG-693: project identity for runs ────────────────────────────────────────
//
// A run row records WHERE it ran. Until FG-693 that was a raw string on both
// halves: project_dir was stored exactly as the caller spelled it (setRunProjectDir
// did not even path.resolve it) and every project-scoped read compared those bytes
// with `===` or GROUP BY. One checkout reached through two spellings — a symlinked
// parent, a system directory exposed under two prefixes, a relative path, a
// trailing separator — was therefore two different projects to `forge status` and
// to the project registry, and a run created under one spelling was invisible from
// the other.
//
// What replaces it, per src/util/path-identity.ts (the ONE contract):
//
//   WRITE  project_dir keeps the caller's bytes VERBATIM — it is audit evidence and
//          it is never rewritten. project_dir_canonical carries the PROVEN identity
//          at write time, or NULL when the filesystem would not confirm the path.
//          A lexically-resolved path is NEVER written there.
//   READ   post-change rows match by exact equality on project_dir_canonical —
//          indexed (idx_runs_project_canonical), alias-agnostic, no filesystem call
//          per row. NULL-canonical rows (everything written before this change,
//          plus anything written while its path was unresolvable) go through the
//          retarget-proof rule in ./legacy-path-attribution.ts — the SAME module
//          host_verifications and orchestrator_receipts use, so the three cannot
//          drift.
//
// Scope is the ACTING class. Deciding that a run belongs to the workspace an
// operator is asking about is a scoping decision, and the contract's rule is that
// an operator's spelling never decides scope — so an INDETERMINATE comparison
// excludes the run rather than including it on a guess. Concretely: byte-identical
// spellings that neither side can resolve no longer match. In production the
// asking side is a real directory the operator is standing in, so this costs
// nothing there; it deliberately costs a match for a query against a path that is
// gone, where the honest answer is that nothing can be proven.
//
// THE READS NEVER WRITE. Neither listRunsForWorkspace nor uniqueProjectDirs
// opportunistically fills project_dir_canonical for a legacy row it just resolved:
// the dashboard holds a read-only store handle by design, and a read that
// sometimes writes would fail on exactly the aged stores this serves.

type RunRow = {
  id: string;
  workflow: string;
  title: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  metadata: string | null;
  project_dir: string | null;
  // FG-638: absent on a hand-shaped minimal `runs` fixture, hence the optional —
  // production and every migrated store carry it NOT NULL with a default.
  review_mode?: string | null;
  // FG-693: PROVEN identity of project_dir at WRITE time, or NULL. Optional for the
  // same reason review_mode is — a hand-shaped fixture predating the column.
  project_dir_canonical?: string | null;
};

/** The value the canonical column may hold for a run: a PROVEN physical path, or
 *  null. `undefined` (no project dir at all) costs no filesystem call. */
function provenCanonical(projectDir: string | null | undefined): string | null {
  return projectDir ? provenPhysical(projectDir) : null;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    workflow: row.workflow,
    title: row.title,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    projectDir: row.project_dir ?? undefined,
    reviewMode: (row.review_mode ?? "legacy_verdict") as Run["reviewMode"],
  };
}

// FG-638: the one answer to "which review authority model settles this run".
// A run with no `reviews` row is not ambiguous — it reads back the column, which a
// legacy row carries as 'legacy_verdict' by DEFAULT rather than by backfill.
export function runReviewMode(id: string): ReviewMode | undefined {
  return getRun(id)?.reviewMode;
}

/** FG-693: projectDir is persisted VERBATIM (audit evidence, and what the
 *  operator will see); its PROVEN identity is derived here and stored beside it,
 *  or NULL when the filesystem would not confirm the path. A NULL is not a
 *  failure to record the run — the run is real; it just cannot later claim to
 *  belong to a checkout nobody proved it belonged to. */
export function insertRun(run: Run): void {
  const canonical = provenCanonical(run.projectDir);
  getDb()
    .prepare(
      `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, metadata, project_dir, review_mode, project_dir_canonical)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.id,
      run.workflow,
      run.title,
      run.status,
      run.createdAt,
      run.completedAt ?? null,
      run.metadata ? JSON.stringify(run.metadata) : null,
      run.projectDir ?? null,
      run.reviewMode ?? "legacy_verdict",
      canonical
    );
}

// Set the project_dir on a run. Used by `forge next --project ...` to remember
// the path so subsequent calls can omit it. Returns the previous value (if any)
// so the caller can decide whether to warn the user about a change.
//
// FG-693: both columns move together — the caller's bytes into project_dir and
// the PROVEN identity (or NULL) into project_dir_canonical — because a row whose
// canonical value described the PREVIOUS directory would be worse than one with
// no canonical value at all. The realpath is taken BEFORE the transaction opens:
// a filesystem call must never be held across the write lock. The returned
// previous value is the AS-WRITTEN spelling, unchanged, since its only consumer
// prints it.
export function setRunProjectDir(id: string, projectDir: string): string | undefined {
  const canonical = provenCanonical(projectDir);
  return writeTransaction(() => {
    const row = getDb()
      .prepare(`SELECT project_dir FROM runs WHERE id = ?`)
      .get(id) as { project_dir: string | null } | undefined;
    const prev = row?.project_dir ?? undefined;
    getDb()
      .prepare(`UPDATE runs SET project_dir = ?, project_dir_canonical = ? WHERE id = ?`)
      .run(projectDir, canonical, id);
    return prev;
  });
}

export function getRun(id: string): Run | undefined {
  const row = getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

// FG-563 (CP2, F17 receipt bridge): find the ONE physical run created under a
// deterministic continuation dispatch_key. The run-creation path (startRun /
// createInvokeRun) stamps the receipt into run metadata BEFORE the container spawn
// is externally observable, so a recovery — continuationsInDispatch supplies the
// receipt, this resolves the physical run — always lands on the original in-flight
// run rather than spawning a duplicate. This closes the crash-after-spawn-before-
// recordDispatchResult window: even if the ids were never written back into the
// continuation, the run itself carries the key and is discoverable.
//
// Correlation is by dispatch_key ALONE — NEVER by title, role, ticket, timestamp,
// or any heuristic (F17). A dispatch_key is unique across runs by construction
// (derived from the continuation identity), so at most one row matches; the oldest
// match is returned defensively (created_at ASC) if a caller ever reused a key.
//
// FG-563 (FIX5): this is the check-before-spawn HOT path — fired on every
// continuation wake/dispatch — so it queries with json_extract on the receipt
// rather than scanning every run + JSON.parse-ing each metadata blob. SQLite uses
// the additive idx_runs_dispatch_key expression index (schema.ts) for the equality
// probe. Behavior is unchanged: the one matching run, or undefined.
export function runByDispatchKey(dispatchKey: string): Run | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM runs
        WHERE json_extract(metadata, '$.dispatchKey') = ?
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(dispatchKey) as RunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

export function listRuns(): Run[] {
  const rows = getDb().prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as RunRow[];
  return rows.map(rowToRun);
}

function metadataWorkspace(row: RunRow): string | undefined {
  if (!row.metadata) return undefined;
  const ws = (JSON.parse(row.metadata) as Record<string, unknown>)["workspace"];
  return typeof ws === "string" && ws.length > 0 ? ws : undefined;
}

/** Runs whose projectDir OR metadata.workspace names the given directory.
 *  Used by `forge status` to filter out runs from other workspaces by default
 *  (per #138). The metadata.workspace clause handles audit-workspace runs
 *  where the orchestrator's workspace ≠ the target repo's projectDir.
 *
 *  FG-693: "names" is decided by proven filesystem identity, never by string
 *  equality, so one checkout reached through a symlinked parent, a system alias
 *  prefix, a relative spelling or a trailing separator is ONE workspace. Two
 *  populations:
 *
 *    project_dir_canonical NOT NULL — the identity was proven when the row was
 *      written; an exact equality against the caller's proven identity settles it
 *      with no filesystem call.
 *    project_dir_canonical NULL — a pre-FG-693 row, or one whose path was
 *      unresolvable at write time. It records a SPELLING, not a tree, so it goes
 *      through the shared retarget-proof rule: resolving it at read time would
 *      only establish that it resolves TODAY, never that it resolves to the tree
 *      it was written against.
 *
 *  metadata.workspace has no canonical column and never had one, so no equality
 *  probe settles it — but it does NOT take the legacy rule either. That rule's
 *  link-free clause exists to protect a PROOF: a pre-FG-693 project_dir records
 *  bytes nobody confirmed, and resolving them at read time could credit the row to a
 *  tree it was never written against. Nothing here is protected by declining — no
 *  vintage of metadata.workspace was ever proven, so the rule removes no exposure
 *  the `ws === workspace` it replaced did not already carry. What it does remove is
 *  the clause itself: every workspace reached through a symlinked prefix is declined,
 *  INCLUDING the byte-identical spelling the operator is standing in, and on a host
 *  that aliases its temp or home root (darwin's /var -> /private/var) that is the
 *  ordinary case rather than the exotic one. An audit run then disappears from its
 *  own workspace listing. So the workspace half is decided by PROVEN identity: both
 *  sides resolve and name one directory. That subsumes byte equality wherever the
 *  directory still exists, and keeps the ACTING projection's refusal where it does
 *  not — a spelling neither side can resolve still matches nothing. */
export function listRunsForWorkspace(workspace: string): Run[] {
  const target: PathIdentity = identify(workspace);

  // Filter in-process rather than in SQL — metadata is JSON-encoded TEXT, and
  // adding a SQL JSON predicate makes the query non-portable for what is at
  // most O(hundreds) of runs in practice. Distinct legacy spellings are far
  // fewer than rows and each costs a realpath, so the verdict is memoized per
  // call; the map is call-scoped, so no read caches a filesystem answer beyond
  // the query that asked for it.
  const legacyVerdicts = new Map<string, boolean>();
  const legacyAttributes = (spelling: string): boolean => {
    let verdict = legacyVerdicts.get(spelling);
    if (verdict === undefined) {
      verdict = attributeLegacyRow(spelling, target).outcome === "attributed";
      legacyVerdicts.set(spelling, verdict);
    }
    return verdict;
  };

  // Memoized for the same reason and with the same call-scoped lifetime.
  const workspaceVerdicts = new Map<string, boolean>();
  const workspaceNamesTarget = (spelling: string): boolean => {
    let verdict = workspaceVerdicts.get(spelling);
    if (verdict === undefined) {
      verdict = provenSameOnly(spelling, target);
      workspaceVerdicts.set(spelling, verdict);
    }
    return verdict;
  };

  const rows = getDb().prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as RunRow[];
  return rows
    .filter((row) => {
      const canonical = row.project_dir_canonical ?? null;
      if (canonical !== null) {
        if (target.kind === "resolved" && canonical === target.physical) return true;
      } else if (row.project_dir && legacyAttributes(row.project_dir)) {
        return true;
      }
      const ws = metadataWorkspace(row);
      return ws !== undefined && workspaceNamesTarget(ws);
    })
    .map(rowToRun);
}

// Per-project aggregate for the registry view (#152). Returns one row per
// distinct project_dir with lifetime + current-state counts.
export type ProjectAggregate = {
  projectDir: string;
  lastRunAt: string;     // ISO of most recent run's created_at
  runCount: number;
  inFlightCount: number; // active or awaiting_gate runs
};

// FG-414: "in-flight" for this aggregate must agree with the dashboard's
// in-flight view — a run with >= 1 non-terminal task, excluding orchestrator
// session rows (`forge claude`'s long-lived session run/task, workflow ===
// "orchestrator"; tracked separately via liveSessions/#153 heartbeats). Plain
// `status = 'active'` over-counted: it included orchestrator rows that never
// terminate on a crashed session, and stuck_run/un-reconciled orphans whose
// tasks are all terminal despite the run row still saying active.
const NON_TERMINAL_TASK_STATES = ["running", "awaiting_gate", "awaiting_red", "blocked_by_red", "awaiting_recovery"];

// The in-flight predicate, shared verbatim by both halves of the aggregate below
// so the two populations cannot come to count "in flight" differently.
const IN_FLIGHT_SUM = `
  SUM(CASE WHEN r.status = 'active' AND r.workflow != 'orchestrator' AND EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.run_id = r.id
          AND t.status IN (${NON_TERMINAL_TASK_STATES.map(() => "?").join(",")})
      ) THEN 1 ELSE 0 END) AS inFlightCount`;

type AggregateRow = { key: string; lastRunAt: string; runCount: number; inFlightCount: number };

/** The namespace an UNPROVEN as-written bucket is keyed under. A NUL byte cannot
 *  appear in any path a filesystem hands back or a caller can store, so a bucket
 *  keyed with it is unforgeable by a proven physical path: an unresolvable
 *  spelling can never be absorbed into a proven group by looking alike. */
const UNPROVEN_BUCKET_PREFIX = "\u0000unproven\u0000";

/** FG-693: one entry per PROJECT, not per spelling. Runs recorded under two
 *  spellings of one checkout are ONE row here (the registry view counted them as
 *  two projects, and showed the same checkout twice).
 *
 *  Two populations, merged on proven identity:
 *
 *    project_dir_canonical NOT NULL — grouped by the proven identity in SQL,
 *      using the additive idx_runs_project_canonical index. The reported
 *      projectDir is that proven path.
 *    project_dir_canonical NULL — grouped by the as-written bytes in SQL, then
 *      passed through the shared retarget-proof rule. A spelling that traversed
 *      no symlink can be claimed, so it MERGES into the proven group for the same
 *      tree; anything else keeps its own bucket, reported under the operator's
 *      own spelling.
 *
 *  That fallback bucket is a PRESENTATION grouping of identical recorded bytes —
 *  it is deliberately namespaced so it can never merge with a proven group or be
 *  mistaken for an identity claim, and it authorizes nothing. It exists so an
 *  aged store's projects stay visible and stay counted, exactly as before this
 *  change, rather than fragmenting to one entry per run.
 *
 *  This read performs no write: a legacy row it resolves here is NOT backfilled. */
export function uniqueProjectDirs(): ProjectAggregate[] {
  const db = getDb();

  const provenRows = db.prepare(`
    SELECT
      r.project_dir_canonical AS key,
      MAX(r.created_at) AS lastRunAt,
      COUNT(*) AS runCount,${IN_FLIGHT_SUM}
    FROM runs r
    WHERE r.project_dir_canonical IS NOT NULL AND r.project_dir_canonical != ''
    GROUP BY r.project_dir_canonical
  `).all(...NON_TERMINAL_TASK_STATES) as AggregateRow[];

  const legacyRows = db.prepare(`
    SELECT
      r.project_dir AS key,
      MAX(r.created_at) AS lastRunAt,
      COUNT(*) AS runCount,${IN_FLIGHT_SUM}
    FROM runs r
    WHERE r.project_dir_canonical IS NULL AND r.project_dir IS NOT NULL AND r.project_dir != ''
    GROUP BY r.project_dir
  `).all(...NON_TERMINAL_TASK_STATES) as AggregateRow[];

  const merged = new Map<string, ProjectAggregate>();
  const absorb = (key: string, projectDir: string, row: AggregateRow): void => {
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { projectDir, lastRunAt: row.lastRunAt, runCount: row.runCount, inFlightCount: row.inFlightCount });
      return;
    }
    existing.runCount += row.runCount;
    existing.inFlightCount += row.inFlightCount;
    if (row.lastRunAt > existing.lastRunAt) existing.lastRunAt = row.lastRunAt;
  };

  for (const row of provenRows) absorb(row.key, row.key, row);
  for (const row of legacyRows) {
    const proof = retargetProofIdentity(row.key);
    // The unproven bucket's key is namespaced with a NUL byte, which no path a
    // filesystem can hand back may contain — so an unproven bucket is unforgeable
    // by any proven physical path, and two spellings nobody proved are never
    // merged into one project.
    if (proof.provable) absorb(proof.identity.physical, proof.identity.physical, row);
    else absorb(`${UNPROVEN_BUCKET_PREFIX}${row.key}`, row.key, row);
  }

  // lastRunAt DESC, as the SQL always ordered it, with projectDir as the tie-break
  // so a merge of two populations is deterministic rather than dependent on which
  // statement happened to run first.
  return [...merged.values()].sort((a, b) =>
    a.lastRunAt < b.lastRunAt ? 1
      : a.lastRunAt > b.lastRunAt ? -1
      : a.projectDir < b.projectDir ? -1
      : a.projectDir > b.projectDir ? 1
      : 0
  );
}

// FG-484: compare-and-set that completes a run ONLY out of 'active' — the
// only other live state RunStatus has is 'abandoned', so this equally
// refuses abandoned->complete (a concurrent `forge cancel` won the race) and
// complete->complete (redundant re-finalization double-notifying / clobbering
// completed_at). Returns true iff this call completed it. Mirrors
// store/tasks.ts's markTaskComplete CAS shape.
//
// The status read + guarded UPDATE run inside ONE transaction so no
// concurrent writer can interleave between "read previous status" and
// "write" — better-sqlite3 transactions serialize against the same
// connection. The notification fires strictly AFTER that transaction
// commits, and only when the write actually applied, so a refused call never
// emits a false "complete" push and no interleaving can double-notify.
//
// opts.onApplied runs INSIDE the same transaction as the status write, before
// commit — callers (finalizeRunIfSettled) use it to make their own paired
// run.completed/run.reconciled events atomic with the status write (FG-463).
export function completeRun(id: string, opts?: { onApplied?: () => void }): boolean {
  const completedAt = nowIso();
  const { applied, prevStatus } = writeTransaction(() => {
    const prev = getDb()
      .prepare(`SELECT status FROM runs WHERE id = ?`)
      .get(id) as { status: string } | undefined;
    const info = getDb()
      .prepare(`UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'active'`)
      .run(completedAt, id);
    const applied = info.changes === 1;
    if (applied) opts?.onApplied?.();
    return { applied, prevStatus: prev?.status };
  });

  if (!applied) return false;

  const updated = getRun(id);
  if (updated) {
    void notifyOnRunTransition(updated, "complete", prevStatus);
  }
  return true;
}

// FG-585: compare-and-set that fails a run ONLY out of 'active' — mirrors
// completeRun exactly (same transaction shape, onApplied-inside-transaction,
// post-commit notification). CAS from 'active' means it equally refuses
// abandoned->failed (a concurrent `forge cancel` won, AWN-2), complete->failed
// (a run that already succeeded never flips), and failed->failed (redundant
// re-finalization). Returns true iff this call failed it.
export function failRun(id: string, opts?: { onApplied?: () => void }): boolean {
  const completedAt = nowIso();
  const { applied, prevStatus } = writeTransaction(() => {
    const prev = getDb()
      .prepare(`SELECT status FROM runs WHERE id = ?`)
      .get(id) as { status: string } | undefined;
    const info = getDb()
      .prepare(`UPDATE runs SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'active'`)
      .run(completedAt, id);
    const applied = info.changes === 1;
    if (applied) opts?.onApplied?.();
    return { applied, prevStatus: prev?.status };
  });

  if (!applied) return false;

  const updated = getRun(id);
  if (updated) {
    void notifyOnRunTransition(updated, "failed", prevStatus);
  }
  return true;
}

// FG-688: compare-and-set that reactivates a run ONLY out of 'failed' — the exact
// MIRROR of failRun in the other direction, and nothing more. The adopt-preserving
// re-drive reopens a terminally-failed ordered wave's parent task, and a reopened
// parent on a settled run would never dispatch (both `forge next` entry points
// refuse a non-active run), so the run row has to come back with it.
//
// CAS from 'failed' means it equally refuses complete->active (a run that already
// succeeded is never reopened), abandoned->active (a human's `forge cancel` is
// authoritatively terminal, AWN-2), and active->active (the caller must handle the
// no-op explicitly rather than read a true it did not earn). Returns true iff this
// call moved the row.
//
// Three deliberate omissions, each load-bearing:
//   (a) NO notification. Every existing reactivation is silent (updateRunStatus
//       only notifies on terminal targets), and a post-commit side effect here
//       could escape a caller's rollback.
//   (b) NO re-drive-shaped exemption, allowlist, or caller-identity check. The CAS
//       on status='failed' is the same universal shape completeRun/failRun already
//       use (`AND status = 'active'`) — a transition, not a policy table. The
//       FG-585 terminal-crossing backstop in updateRunStatus is untouched: 'active'
//       is not in TERMINAL_RUN_STATES, so failed->active was already permitted.
//       WHICH failures may be re-driven is decided at the verb, never here.
//   (c) NO schema change. runs.status, runs.completed_at and the `run.reactivated`
//       EventType all already exist, so no migration runs and an aged
//       ~/.forge/forge.db needs no different handling from a fresh one.
//
// Deliberately NOT reused: reactivateTerminalRun (src/v2/invoke.ts) — its
// accept-set includes 'complete' and 'abandoned', and its status write and audit
// event sit in two unsynchronized transactions, so a crash between them loses the
// only record that the run was ever reactivated (the write itself nulls
// completed_at, erasing the row's own trace of the failure).
//
// opts.onApplied runs INSIDE the same transaction as the status write, before
// commit — the same FG-463 seam completeRun/failRun expose, so the caller's
// `run.reactivated` audit event commits atomically with the status flip. A throw
// from onApplied rolls the status write back with it.
export function reactivateFailedRun(id: string, opts?: { onApplied?: () => void }): boolean {
  return writeTransaction(() => {
    const info = getDb()
      .prepare(`UPDATE runs SET status = 'active', completed_at = NULL WHERE id = ? AND status = 'failed'`)
      .run(id);
    const applied = info.changes === 1;
    if (applied) opts?.onApplied?.();
    return applied;
  });
}

const TERMINAL_RUN_STATES: ReadonlySet<RunStatus> = new Set(["complete", "failed", "abandoned"]);

export function updateRunStatus(id: string, status: RunStatus): void {
  // Read the previous status and apply the FG-484/FG-585 universal backstop in
  // the SAME transaction as the write, so no concurrent writer can interleave
  // between the read and the UPDATE. This is the store layer's own guard — it
  // holds regardless of which caller reaches it, unlike relying on every call
  // site to route through completeRun/failRun.
  const { applied, prevStatus } = writeTransaction(() => {
    const prev = getDb()
      .prepare(`SELECT status FROM runs WHERE id = ?`)
      .get(id) as { status: string } | undefined;

    // FG-585: a settled run's terminal truth is immutable except an explicit
    // reactivation to active (retry/attach via reactivateTerminalRun). No
    // caller — including ones that bypass completeRun/failRun/
    // finalizeRunIfSettled entirely — may cross a terminal run to a DIFFERENT
    // terminal state: this refuses failed<->complete (false green light /
    // wrong-ship), terminal->abandoned, and abandoned->{complete,failed}
    // alike, while still allowing terminal->active (reactivation),
    // active->terminal (normal finalize), and idempotent same->same.
    if (
      prev &&
      TERMINAL_RUN_STATES.has(prev.status as RunStatus) &&
      TERMINAL_RUN_STATES.has(status) &&
      status !== prev.status
    ) {
      return { applied: false, prevStatus: prev?.status };
    }

    const completedAt =
      status === "complete" || status === "failed" || status === "abandoned" ? nowIso() : null;
    getDb()
      .prepare(`UPDATE runs SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, completedAt, id);
    return { applied: true, prevStatus: prev?.status };
  });

  if (!applied) return;

  // Notification: fires on terminal transitions only (complete/failed/abandoned).
  // Reads the just-updated row so durationMs reflects the completed_at write.
  // Async fire-and-forget — never throws, never blocks the caller.
  if (status === "complete" || status === "failed" || status === "abandoned") {
    const updated = getRun(id);
    if (updated) {
      void notifyOnRunTransition(updated, status, prevStatus);
    }
  }
}
