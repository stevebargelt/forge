// FG-591 (step 4 / D10): THE PARALLEL-COMPATIBILITY PREDICATE, and the hydration
// that feeds it.
//
// FG-610 shipped claimNextEligible with an OPTIONAL caller predicate and a stated
// PURITY CONTRACT (queue-claims.ts): the predicate is pure, I/O-free, deterministic
// and total over already-hydrated arguments, and is evaluated in the scan's READ
// phase only — never under the machine-wide write lock every forge process shares.
// This module is the two halves that contract implies, kept deliberately apart:
//
//   hydrateActiveRunFacts()   — the READ. Every store query lives here, runs ONCE
//                               per evaluation pass, and produces a plain snapshot.
//   evaluateCompatibility()   — the DECISION. A pure, total, deterministic function
//                               over that snapshot. It makes no store call, opens no
//                               socket, reads no clock and mutates no argument.
//
// makeCompatibilityPredicate(facts) closes the second over the first and hands
// claimNextEligible something that satisfies its contract by CONSTRUCTION rather
// than by care: the closure has no db handle in scope to misuse.
//
// ─── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────
// It does NOT reimplement duplicate-execution prevention between two dispatchers.
// idx_queue_claims_live already makes at-most-one-live-claim-per-ticket atomic in
// SQLite, and phase 2 of claimNextEligible re-validates the active set it was shown.
// What this module adds is the DIFFERENT question that no index can answer: given
// that this candidate is claimable, would running it CONCURRENTLY with the work
// already in flight corrupt something. That is a semantic question about workspaces,
// ticket ordering and out-of-band execution, and FG-591's AC requires the answer be
// RECORDED rather than guessed.
//
// It also writes NOTHING — not a claim, not a rank, and above all not a
// blocker_evidence row. A temporary scheduling incompatibility is per-evaluation
// evidence that evaporates the moment the active set changes; blocker_evidence is
// durable, per-ticket and partly CONTAINER-VISIBLE through blocked-source.ts, so a
// scheduling wait written there would flip every agent container's view of the
// ticket's status. The AC's distinction — "a genuine blocker and a temporary
// scheduling incompatibility are different things" — is enforced here by this module
// having no writer at all.
//
// ─── WHY IT REFUSES ON AMBIGUITY ─────────────────────────────────────────────
// The two errors are not symmetric. A false REFUSAL costs one dispatch cycle: the
// candidate keeps its durable rank (nothing here mutates one), the scan names it
// `incompatible` with this module's reason string, and it is reconsidered the moment
// capacity or the active set changes. A false ADMISSION costs a corrupted worktree,
// two containers mutating one checkout, or a run built on a base that moved under it.
// So every unresolved fact — a claim with no lane yet, an active claim absent from
// the snapshot, a relation type this module does not recognise — is INCOMPATIBLE
// with a reason that names what was unknown.
//
// The cost that follows, stated rather than discovered: a claim that has been granted
// but has not yet recorded a task holds an UNKNOWN lane, so a second candidate in the
// SAME project waits until the first run's first task exists. Across projects nothing
// waits. The window is short and self-clearing, but it is real: FG-591's dispatcher
// loop should treat a task spawn as a wake source, and its watchdog is the backstop
// if it does not.
//
// ─── LANES ARE KEYED ON project_key, THEN REFINED ────────────────────────────
// project_key IS the repository identity in this store (project_identity, derived
// from repo evidence), so two claims sharing a project_key are two runs in one repo
// and two claims that do not share one are in different repos. Within one repo,
// isolation comes from FG-345/FG-351 per-task workspaces: a run whose live tasks each
// carry a worktree_path holds no shared lane, while a run with a live task and NO
// worktree_path is executing against the shared checkout and excludes everything else
// in that repo. That refinement is read from tasks — it is never assumed from an env
// var, because FORGE_NO_WORKTREES and the platform default are host state the store
// cannot see.

import { getDb } from "../store/db.js";
import { storeNowMs } from "../store/publications.js";
import {
  liveClaimsInScope,
  type ActiveClaimSummary,
  type CapacityScope,
  type ClaimCandidate,
  type CompatibilityPredicate,
  type CompatibilityVerdict,
} from "../store/queue-claims.js";

// ─── the vocabularies this module reads (never a second copy of a status) ────

/** queue.ts:83's TERMINAL_TASK_STATUSES, restated because it is not exported.
 *  launch-observations.ts:118 sets the precedent for restating a classifier rather
 *  than widening another module's export surface, and the same discipline applies:
 *  fg591-compatibility.test.ts proves this set agrees with queue.ts's own isInProgress
 *  derivation for every value, so the two cannot drift silently. */
const TERMINAL_TASK_STATUSES: readonly string[] = ["complete", "failed"];

/** runs.ts:235's TERMINAL_RUN_STATES, restated for the same reason and pinned by the
 *  same parity test. A terminal run holds no workspace lane. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["complete", "failed", "abandoned"]);

/** Relations that impose an ORDER between two tickets in either direction. A
 *  candidate linked this way to a ticket currently executing must wait: the whole
 *  point of the ordering is that one integrates before the other starts. Both
 *  directions conflict — a candidate that depends on running work would build on an
 *  unintegrated prerequisite, and running work that depends on the candidate is
 *  already executing against a prerequisite that has not landed. */
export const ORDERING_RELATIONS: ReadonlySet<string> = new Set([
  "depends_on",
  "blocked_by",
  "blocks",
  "before",
  "after",
  "parent_of",
  "child_of",
  "supersedes",
  "superseded_by",
]);

/** Relations that assert two tickets must never execute at the same time, with no
 *  implied order. `duplicates` belongs here rather than with the neutral links: two
 *  tickets naming the same work, executed concurrently, is the overlap this predicate
 *  exists to prevent even though neither is "first". */
export const EXCLUSIVE_RELATIONS: ReadonlySet<string> = new Set([
  "exclusive_with",
  "conflicts_with",
  "duplicates",
]);

/** Relations KNOWN to carry no scheduling meaning — a see-also link between two
 *  tickets that may freely run together. container-authority.ts:369 reads 'related'
 *  as exactly that. This set is what keeps the ambiguity rule from refusing on every
 *  ordinary cross-reference, and it is deliberately SHORT: an unrecognised relation
 *  between the candidate and running work is ambiguous, and ambiguity refuses. */
export const NEUTRAL_RELATIONS: ReadonlySet<string> = new Set(["related", "see_also", "mentions"]);

// ─── the hydrated snapshot ───────────────────────────────────────────────────

/** What workspace an active claim's execution occupies. Derived from durable rows
 *  only; `unknown` is a first-class answer rather than an optimistic default. */
export type ActiveRunLane =
  /** Every live task of the run has its own workspace. Holds no shared lane. */
  | { kind: "isolated"; worktreePaths: readonly string[] }
  /** A live task has NO worktree_path: it is executing against the repo checkout
   *  itself, and excludes every other run in that repo. */
  | { kind: "shared_checkout"; projectDir: string | null; taskId: string }
  /** The run (or the launch) reached a terminal state: the lane is free. */
  | { kind: "idle"; detail: string }
  /** Nothing durable yet says where this claim's work will execute. Refuses. */
  | { kind: "unknown"; detail: string };

/** One active claim, with the execution facts a compatibility decision needs. The
 *  claim table is authoritative for the RESERVATION and the run/launch record for the
 *  EXECUTION; the two are read separately here and joined in MEMORY, never in one
 *  query, so neither is derived from the other. */
export type ActiveRunFact = {
  claimId: string;
  projectKey: string;
  ticketId: string;
  owner: string;
  generation: number;
  leaseExpiresAtMs: number;
  launchId: string | null;
  runId: string | null;
  runStatus: string | null;
  launchTerminal: boolean | null;
  lane: ActiveRunLane;
};

/** A durable ticket-to-ticket link, as stored. rel_type is NOT interpreted here —
 *  classification happens in the pure half, so the snapshot stays a transcript of the
 *  store rather than a decision already taken. */
export type TicketRelationFact = {
  ticketId: string;
  relatedId: string;
  relType: string;
};

/** Execution of a ticket that the claim ledger does NOT account for — an operator's
 *  `forge new --ticket`, a campaign item, a review loop. The claim primitive cannot
 *  see these (they have no claim row), so admitting a candidate whose ticket is
 *  already executing this way is a duplicate execution the index cannot prevent. */
export type ForeignExecutionFact = {
  ticketId: string;
  kind: "task" | "launch";
  runId: string | null;
  launchId: string | null;
  detail: string;
};

/** A durable resource lock held over the project. Today that is the FG-425
 *  publication mutex: while it is held, an integration publish is fetching, merging
 *  and pushing against this repository's refs. */
export type ResourceLockFact = {
  projectKey: string;
  lockKind: "publication";
  holder: string;
  runId: string | null;
  expiresAtMs: number;
};

/** The whole READ, as one plain snapshot. Serializable on purpose: FG-591's
 *  dispatcher persists the evidence behind a decision, and a snapshot full of live
 *  handles could not be recorded. */
export type ActiveRunFacts = {
  projectKey: string;
  capacityScope: CapacityScope;
  /** The STORE clock (storeNowMs), never a process clock — lease expiry is compared
   *  against it in the pure half, and a process clock there would let two dispatchers
   *  with skewed clocks disagree about which predecessor is recoverable. */
  hydratedAtMs: number;
  activeRuns: readonly ActiveRunFact[];
  relations: readonly TicketRelationFact[];
  foreignExecutions: readonly ForeignExecutionFact[];
  resourceLocks: readonly ResourceLockFact[];
};

// ─── the READ half ───────────────────────────────────────────────────────────

type TaskRow = { run_id: string; id: string; status: string; worktree_path: string | null };

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

function laneFor(
  claim: { claimId: string; runId: string | null; launchId: string | null },
  runStatus: string | null,
  runProjectDir: string | null,
  launchTerminal: boolean | null,
  tasks: readonly TaskRow[],
): ActiveRunLane {
  if (claim.runId === null) {
    if (claim.launchId === null) {
      return {
        kind: "unknown",
        detail: "the claim has been granted but has recorded no launch and no run yet",
      };
    }
    if (launchTerminal === true) {
      return { kind: "idle", detail: `launch ${claim.launchId} reached a terminal state` };
    }
    return {
      kind: "unknown",
      detail: `launch ${claim.launchId} is recorded but no run identity has been stamped yet`,
    };
  }
  if (runStatus === null) {
    return { kind: "unknown", detail: `run ${claim.runId} has no row in this store` };
  }
  if (TERMINAL_RUN_STATUSES.has(runStatus)) {
    return { kind: "idle", detail: `run ${claim.runId} is ${runStatus}` };
  }
  const live = tasks.filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status));
  if (live.length === 0) {
    return {
      kind: "unknown",
      detail: `run ${claim.runId} is ${runStatus} but has recorded no live task, so its workspace is not yet knowable`,
    };
  }
  const shared = live.find((t) => t.worktree_path === null);
  if (shared !== undefined) {
    return { kind: "shared_checkout", projectDir: runProjectDir, taskId: shared.id };
  }
  return {
    kind: "isolated",
    worktreePaths: live.map((t) => t.worktree_path as string).sort(),
  };
}

/** THE READ PHASE. One pass over the durable tables that already exist — no new
 *  table, no new index, no write of any kind.
 *
 *  The active-claim set is read through queue-claims' own guarded export rather than
 *  re-queried here: liveClaimsInScope carries the FG-609 D6 refusal (a markdown-mode
 *  or unresolvable project refuses BY NAME instead of hydrating an empty set that a
 *  caller would read as "nothing is running"), and re-deriving the set locally would
 *  be a second copy of the capacity-scope semantics.
 *
 *  There is deliberately NO parameter for the caller to supply the active set with.
 *  claimNextEligible reads its own inside the scan, so a caller could not hand over the
 *  exact set the predicate will be shown even if it wanted to — and a supplied set
 *  would bypass the D6 guard above, which is the one thing standing between an
 *  unresolvable project and a snapshot that reads as "nothing is running". The pure
 *  half closes the remaining gap instead: an active claim MISSING from this snapshot,
 *  or one the snapshot no longer describes, REFUSES rather than being treated as
 *  absent. */
export function hydrateActiveRunFacts(input: {
  projectKey: string;
  capacityScope: CapacityScope;
}): ActiveRunFacts {
  const { projectKey, capacityScope } = input;
  const db = getDb();
  const hydratedAtMs = storeNowMs();

  const active: readonly ActiveClaimSummary[] = liveClaimsInScope(capacityScope, projectKey).map((c) => ({
    claimId: c.id,
    projectKey: c.projectKey,
    ticketId: c.ticketId,
    owner: c.owner,
    generation: c.generation,
    leaseExpiresAtMs: c.leaseExpiresAtMs,
    launchId: c.launchId,
    runId: c.runId,
  }));

  const runIds = [...new Set(active.map((a) => a.runId).filter((r): r is string => r !== null))];
  const launchIds = [...new Set(active.map((a) => a.launchId).filter((l): l is string => l !== null))];

  const runRows =
    runIds.length === 0
      ? []
      : (db
          .prepare(`SELECT id, status, project_dir FROM runs WHERE id IN (${placeholders(runIds.length)})`)
          .all(...runIds) as { id: string; status: string; project_dir: string | null }[]);
  const runById = new Map(runRows.map((r) => [r.id, r]));

  const taskRows =
    runIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT run_id, id, status, worktree_path FROM tasks
              WHERE run_id IN (${placeholders(runIds.length)}) ORDER BY id ASC`,
          )
          .all(...runIds) as TaskRow[]);
  const tasksByRun = new Map<string, TaskRow[]>();
  for (const t of taskRows) {
    const list = tasksByRun.get(t.run_id);
    if (list) list.push(t);
    else tasksByRun.set(t.run_id, [t]);
  }

  const launchRows =
    launchIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT launch_id, terminal, project_dir FROM launch_observations
              WHERE launch_id IN (${placeholders(launchIds.length)})`,
          )
          .all(...launchIds) as { launch_id: string; terminal: number; project_dir: string | null }[]);
  const launchById = new Map(launchRows.map((l) => [l.launch_id, l]));

  const activeRuns: ActiveRunFact[] = active.map((a) => {
    const run = a.runId === null ? undefined : runById.get(a.runId);
    const launch = a.launchId === null ? undefined : launchById.get(a.launchId);
    const launchTerminal = launch === undefined ? null : launch.terminal === 1;
    return {
      claimId: a.claimId,
      projectKey: a.projectKey,
      ticketId: a.ticketId,
      owner: a.owner,
      generation: a.generation,
      leaseExpiresAtMs: a.leaseExpiresAtMs,
      launchId: a.launchId,
      runId: a.runId,
      runStatus: run?.status ?? null,
      launchTerminal,
      lane: laneFor(
        { claimId: a.claimId, runId: a.runId, launchId: a.launchId },
        run?.status ?? null,
        run?.project_dir ?? null,
        launchTerminal,
        a.runId === null ? [] : (tasksByRun.get(a.runId) ?? []),
      ),
    };
  });

  const relations = (
    db
      .prepare(
        `SELECT ticket_id, related_id, rel_type FROM ticket_relations
          WHERE project_key = ? ORDER BY ticket_id ASC, related_id ASC, rel_type ASC`,
      )
      .all(projectKey) as { ticket_id: string; related_id: string; rel_type: string }[]
  ).map((r) => ({ ticketId: r.ticket_id, relatedId: r.related_id, relType: r.rel_type }));

  // The project's known checkout directories, used ONLY to keep a foreign launch in
  // ANOTHER project from being read as this project's ticket executing. Ticket ids
  // are per-project (FG-123 can exist in two projects) and launch_observations carries
  // no project_key, so its project_dir is the narrowing evidence available.
  const projectDirs = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT r.project_dir AS dir
             FROM ticket_dispatch_evidence e
             JOIN tasks t ON t.id = e.task_id
             JOIN runs r ON r.id = t.run_id
            WHERE e.project_key = ? AND r.project_dir IS NOT NULL
            UNION
           SELECT DISTINCT imported_from AS dir FROM tickets
            WHERE project_key = ? AND imported_from IS NOT NULL`,
        )
        .all(projectKey, projectKey) as { dir: string }[]
    ).map((r) => r.dir),
  );

  // Execution the claim ledger cannot account for. The dispatch-evidence half is
  // queue.ts's own isInProgress derivation, project-keyed and exact; the launch half
  // covers the window BEFORE a run's first task spawns, which is precisely when
  // dispatch evidence does not exist yet.
  const foreignExecutions: ForeignExecutionFact[] = (
    db
      .prepare(
        `SELECT DISTINCT e.ticket_id, t.id AS task_id, t.run_id, t.status
           FROM ticket_dispatch_evidence e
           JOIN tasks t ON t.id = e.task_id
          WHERE e.project_key = ?
            AND t.status NOT IN (${placeholders(TERMINAL_TASK_STATUSES.length)})
          ORDER BY e.ticket_id ASC, t.id ASC`,
      )
      .all(projectKey, ...TERMINAL_TASK_STATUSES) as {
      ticket_id: string;
      task_id: string;
      run_id: string;
      status: string;
    }[]
  ).map((r) => ({
    ticketId: r.ticket_id,
    kind: "task" as const,
    runId: r.run_id,
    launchId: null,
    detail: `task ${r.task_id} of run ${r.run_id} is ${r.status}`,
  }));

  for (const l of db
    .prepare(
      `SELECT launch_id, ticket_id, run_id, project_dir, state FROM launch_observations
        WHERE terminal = 0 AND ticket_id IS NOT NULL
        ORDER BY launch_id ASC`,
    )
    .all() as {
    launch_id: string;
    ticket_id: string;
    run_id: string | null;
    project_dir: string | null;
    state: string;
  }[]) {
    // A launch with no project_dir cannot be attributed away from this project, so it
    // is KEPT: an unattributable in-flight launch of this ticket id is exactly the
    // ambiguity this module refuses on rather than admits through.
    if (l.project_dir !== null && projectDirs.size > 0 && !projectDirs.has(l.project_dir)) continue;
    foreignExecutions.push({
      ticketId: l.ticket_id,
      kind: "launch",
      runId: l.run_id,
      launchId: l.launch_id,
      detail: `launch ${l.launch_id} is ${l.state}`,
    });
  }

  const resourceLocks: ResourceLockFact[] = (
    db
      .prepare(
        `SELECT project_key, attempt_id, run_id, expires_at_ms FROM publication_locks
          WHERE project_key = ? ORDER BY project_key ASC`,
      )
      .all(projectKey) as {
      project_key: string;
      attempt_id: string;
      run_id: string;
      expires_at_ms: number;
    }[]
  ).map((r) => ({
    projectKey: r.project_key,
    lockKind: "publication" as const,
    holder: r.attempt_id,
    runId: r.run_id,
    expiresAtMs: r.expires_at_ms,
  }));

  return {
    projectKey,
    capacityScope,
    hydratedAtMs,
    activeRuns,
    relations,
    foreignExecutions,
    resourceLocks,
  };
}

// ─── the PURE half ───────────────────────────────────────────────────────────

const COMPATIBLE: CompatibilityVerdict = { compatible: true };

function no(reason: string): CompatibilityVerdict {
  return { compatible: false, reason };
}

/** How a relation between the candidate and an executing ticket is read. Returns null
 *  when the relation carries no scheduling meaning. */
function relationConflict(relType: string): "ordering" | "exclusive" | "ambiguous" | null {
  if (ORDERING_RELATIONS.has(relType)) return "ordering";
  if (EXCLUSIVE_RELATIONS.has(relType)) return "exclusive";
  if (NEUTRAL_RELATIONS.has(relType)) return null;
  return "ambiguous";
}

/** An ISO stamp that cannot throw. `new Date(x).toISOString()` raises RangeError on a
 *  non-finite or out-of-range value, and a reason string is not worth losing TOTALITY
 *  over — an unformattable timestamp is reported as the raw number instead. */
function safeIso(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? `${ms}` : d.toISOString();
}

/** A stable description of an active claim for a reason string. */
function nameOf(fact: ActiveRunFact): string {
  const run = fact.runId !== null ? `run ${fact.runId}` : `claim ${fact.claimId}`;
  return `${run} (owner ${fact.owner})`;
}

/** THE PREDICATE. Pure, I/O-free, deterministic and TOTAL over already-hydrated
 *  arguments: every input in the type domain produces a verdict and none throws.
 *
 *  Determinism does not depend on the caller's array order — the active set is sorted
 *  by claimId before it is walked, and the axes within one active claim are applied in
 *  a fixed order — so the same (candidate, active) pair against the same snapshot
 *  always returns the same verdict, whatever order claimNextEligible happened to read
 *  the claims in.
 *
 *  Order of decision, fixed and documented because the REASON is durable evidence and
 *  a reason that moved between two identical evaluations would be worthless:
 *    1. per active claim, in claimId order:
 *       a. the claim is absent from the snapshot, or the snapshot no longer describes
 *          it → refuse (the read moved under the decision);
 *       b. the claim belongs to ANOTHER project → skipped: ticket identity, relations
 *          and lanes are all repository-local, and only the CEILING is host-scoped;
 *       c. the same ticket, already executing under a LIVE lease → refuse;
 *       d. a durable relation between the two tickets that orders, excludes, or is
 *          not recognised → refuse;
 *       e. a workspace lane in the candidate's own repo that is shared or unknown →
 *          refuse.
 *    2. the candidate's ticket executing OUTSIDE the claim ledger → refuse.
 *    3. a live durable resource lock over the candidate's project → refuse.
 *
 *  The RECOVERABLE PREDECESSOR is the one active claim deliberately skipped: a claim
 *  for the CANDIDATE's own ticket whose lease has strictly expired is what
 *  takeoverExpiredClaim retires and adopts in the same transaction. Refusing on it
 *  would make every takeover impossible and turn a crashed controller into a
 *  permanently unrecoverable ticket. Its still-running container is not ignored — it
 *  arrives at the caller as `takenOverFrom` carrying the prior launch identity, which
 *  is FG-591's adoption path (step 7), not a compatibility question. */
export function evaluateCompatibility(
  facts: ActiveRunFacts,
  candidate: ClaimCandidate,
  active: readonly ActiveClaimSummary[],
): CompatibilityVerdict {
  const byClaimId = new Map(facts.activeRuns.map((f) => [f.claimId, f]));
  const ordered = [...active].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));

  for (const a of ordered) {
    // The recoverable predecessor of this very ticket: skipped entirely, on every axis.
    if (a.projectKey === facts.projectKey && a.ticketId === candidate.ticketId && a.leaseExpiresAtMs < facts.hydratedAtMs) {
      continue;
    }

    const fact = byClaimId.get(a.claimId);
    if (fact === undefined) {
      return no(
        `refusing ${candidate.ticketId}: claim ${a.claimId} (ticket ${a.ticketId}) is in the active set but ` +
          `not in the hydrated snapshot, so nothing is known about what it is executing. The read moved ` +
          `under the decision; re-scan rather than admit against facts that do not describe it.`,
      );
    }
    if (fact.generation !== a.generation || fact.runId !== a.runId || fact.launchId !== a.launchId) {
      return no(
        `refusing ${candidate.ticketId}: the hydrated facts for claim ${a.claimId} (ticket ${a.ticketId}) no ` +
          `longer match the active set — generation ${fact.generation}/${a.generation}, run ` +
          `${fact.runId ?? "none"}/${a.runId ?? "none"}, launch ${fact.launchId ?? "none"}/${a.launchId ?? "none"}. ` +
          `The snapshot is stale; re-scan rather than admit against it.`,
      );
    }

    // EVERY axis below is repository-local: ticket identity, ticket relations and
    // workspace lanes are all per-project facts, and project_key IS the repository
    // identity here. A host-scoped active set (D3's ceiling scope) therefore carries
    // claims this candidate has nothing to say about — FG-1 in another repository is
    // not this FG-1, its relations are not in this project's relation table, and it
    // shares no checkout. The ceiling still counts them; compatibility does not.
    if (a.projectKey !== facts.projectKey) continue;

    if (a.ticketId === candidate.ticketId) {
      return no(
        `waiting for ${candidate.ticketId} to finish — it is already executing under ${nameOf(fact)} on a live ` +
          `lease, so starting it again would be a duplicate execution.`,
      );
    }

    for (const rel of facts.relations) {
      const forward = rel.ticketId === candidate.ticketId && rel.relatedId === a.ticketId;
      const reverse = rel.ticketId === a.ticketId && rel.relatedId === candidate.ticketId;
      if (!forward && !reverse) continue;
      const conflict = relationConflict(rel.relType);
      if (conflict === null) continue;
      if (conflict === "ambiguous") {
        return no(
          `waiting for ${a.ticketId} to finish — ${candidate.ticketId} and ${a.ticketId} carry the relation ` +
            `'${rel.relType}', which this dispatcher does not recognise as safe to overlap. An unrecognised ` +
            `relation is refused rather than assumed harmless: a bypass costs a cycle, a bad overlap costs a ` +
            `corrupted workspace. ${a.ticketId} is executing under ${nameOf(fact)}.`,
        );
      }
      const clause =
        conflict === "ordering"
          ? forward
            ? `${candidate.ticketId} ${rel.relType} ${a.ticketId}`
            : `${a.ticketId} ${rel.relType} ${candidate.ticketId}`
          : `${candidate.ticketId} and ${a.ticketId} are marked '${rel.relType}'`;
      return no(
        `waiting for ${a.ticketId} to finish — ${clause}, and ${a.ticketId} is executing under ${nameOf(fact)}.`,
      );
    }

    if (fact.lane.kind === "unknown") {
      return no(
        `waiting for ${a.ticketId} to finish — it holds a live claim in this repository but its workspace is ` +
          `not yet knowable (${fact.lane.detail}), so whether it would overlap ${candidate.ticketId} cannot be ` +
          `decided. Refusing costs a cycle and this clears as soon as the run records a task; admitting could ` +
          `put two containers in one checkout. Executing under ${nameOf(fact)}.`,
      );
    }
    if (fact.lane.kind === "shared_checkout") {
      return no(
        `waiting for ${a.ticketId} to finish — it is executing against the shared checkout ` +
          `${fact.lane.projectDir ?? "of this repository"} (task ${fact.lane.taskId}, ${nameOf(fact)}), which ` +
          `${candidate.ticketId} would also mutate.`,
      );
    }
  }

  for (const f of facts.foreignExecutions) {
    if (f.ticketId !== candidate.ticketId) continue;
    // Execution the claim ledger DOES account for is not foreign: an active claim's own
    // run and launch are already decided above (and a recoverable predecessor is
    // adopted, not fought). Only work with no live claim behind it reaches here.
    const claimed = active.some(
      (a) =>
        a.ticketId === candidate.ticketId &&
        ((f.runId !== null && f.runId === a.runId) || (f.launchId !== null && f.launchId === a.launchId)),
    );
    if (claimed) continue;
    return no(
      `waiting for ${candidate.ticketId} to finish — it is already executing outside the queue's claim ledger ` +
        `(${f.detail}), so no claim row can prevent a second container. An operator-initiated run, a campaign ` +
        `item and a review loop all look like this.`,
    );
  }

  for (const lock of facts.resourceLocks) {
    if (lock.projectKey !== facts.projectKey) continue;
    if (lock.expiresAtMs < facts.hydratedAtMs) continue;
    return no(
      `waiting for the ${lock.lockKind} lock on ${lock.projectKey} to clear — attempt ${lock.holder}` +
        `${lock.runId !== null ? ` (run ${lock.runId})` : ""} holds it until ${safeIso(lock.expiresAtMs)}, so ` +
        `this repository's refs are being rewritten and the base ${candidate.ticketId} would start from is in ` +
        `motion.`,
    );
  }

  return COMPATIBLE;
}

/** Close the pure half over one hydrated snapshot and hand claimNextEligible a
 *  predicate that satisfies its purity contract BY CONSTRUCTION: the returned function
 *  captures a plain data snapshot and no database handle, so it has nothing to misuse.
 *  Hydrate once per evaluation pass, in the dispatcher's read phase, and discard the
 *  snapshot with the pass — a snapshot reused across passes is a stale snapshot, and
 *  the staleness checks above would refuse everything rather than admit wrongly. */
export function makeCompatibilityPredicate(facts: ActiveRunFacts): CompatibilityPredicate {
  return (candidate, active) => evaluateCompatibility(facts, candidate, active);
}
