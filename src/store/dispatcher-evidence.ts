// FG-591 (step 3 / D6): THE DURABLE ANSWER TO "WHY DID NOTHING START", and the
// durable wake records that make polling a fallback rather than the mechanism.
//
// Two tables, two different operator questions, deliberately kept apart:
//
//   dispatcher_wakes       — "something changed; look again." A DURABLE
//                            AT-LEAST-ONCE record, idempotent per
//                            (project_key, kind, wake_key) and consumed by
//                            compare-and-set, so a duplicate poke is harmless by
//                            CONSTRUCTION and a restart cannot lose one.
//   dispatcher_evaluations — "here is what the last look concluded, and why."
//                            ONE row per evaluation PASS, INCLUDING the passes
//                            that granted nothing.
//
// ─── WHY THE EVALUATION ROW EXISTS AT ALL ────────────────────────────────────
// queue_claims cannot carry this. A claim row exists only on a GRANT (and its
// scan_evidence with it, by queue-claims' own statement), so the three refusals —
// no eligible candidate, capacity full, lost — leave that table byte-identical.
// An idle queue that leaves no record of why is precisely the operator blindness
// FG-591 exists to close: "nothing is running" and "nothing CAN run because
// another project holds both host slots" must be distinguishable without
// transcript archaeology.
//
// ─── WHAT THIS MODULE NEVER WRITES ───────────────────────────────────────────
// blocker_evidence. Not on any path. A TEMPORARY SCHEDULING INCOMPATIBILITY is
// per-evaluation evidence that evaporates the moment the active set changes;
// blocker_evidence is durable, per-ticket and partly CONTAINER-VISIBLE through
// blocked-source.ts, and it drives the Blocked projection through isQueueBlocked.
// A scheduling wait written there would silently reinterpret the ticket's status
// for every agent container on the next publish, with no change to the container
// path at all. The AC's distinction — a genuine blocker and a temporary scheduling
// incompatibility are DIFFERENT THINGS — is enforced here by this module having no
// writer for that table and no import that could reach one.
// fg591-dispatcher-evidence.test.ts asserts that directly, over the SQL every
// exported writer actually prepares.
//
// ─── NO SECOND VOCABULARY ────────────────────────────────────────────────────
// The per-candidate reasons are queue-claims' ScanEntry[] exactly as
// claimNextEligible returns them, imported TYPE-ONLY and serialized verbatim.
// There is deliberately no runtime whitelist of ScanReason here: a copied list
// would BE the second vocabulary FG-591's non-goals forbid, and it would rot the
// first time queue-claims names a new reason. `reason` (the TOP-LEVEL pass
// outcome) is a different question from a per-candidate ScanReason, and that one
// IS owned here — so it is validated here.
//
// ─── WHY THERE IS NO MARKDOWN-MODE REFUSAL ───────────────────────────────────
// queue-claims guards every verb with FG-609 D6 because a claim is a RESERVATION:
// reading an empty claim set out of an unresolvable project makes a recovery
// caller conclude "nothing to recover", which is a fail-open with consequences.
// This module is an append-only JOURNAL about dispatcher behaviour. It authorizes
// nothing, gates nothing and is never consulted to decide whether work may start.
// Refusing to RECORD why nothing started would delete the one answer the module
// exists to give — including, most usefully, the answer "the claim primitive
// refused this project by name". So the journal always accepts, and the eligibility
// guard stays where the eligibility decision is.
//
// THE WRITE RULE (FG-548): every mutation takes its write lock IMMEDIATELY via
// writeTransaction (BEGIN IMMEDIATE), never a deferred txn that upgrades
// mid-flight. THE CLOCK RULE (FG-425): every timestamp is the store's own clock
// (storeNowMs), never a process clock — two forge processes with skewed clocks
// must not disagree about when a wake was consumed or a watchdog is due.

import { getDb, writeTransaction } from "./db.js";
import { storeNowMs } from "./publications.js";
import { QueueRefusal } from "./queue.js";
import type { CapacityScope, QueueClaim, ScanEntry } from "./queue-claims.js";

// ─── wake kinds ──────────────────────────────────────────────────────────────

/** THE WAKE SOURCES FG-591 AC15 ENUMERATES, plus the watchdog that bounds a lost
 *  one. Enum-as-CONVENTION (FG-585): the column is unconstrained TEXT, so an old
 *  binary never fights a kind a newer one records.
 *
 *  `watchdog` is listed beside the event kinds on purpose and is NOT a peer of
 *  them: it is the low-frequency HEALTH bound that catches a lost signal, never
 *  the correctness mechanism and never an estimate of ticket duration. */
export type WakeKind =
  /** Enqueue, dequeue, rank, unrank, defer, reorder. */
  | "queue_changed"
  /** A run reached a terminal disposition, so a slot may have freed. */
  | "run_terminal"
  /** A blocker appeared or cleared (blocker_evidence changed — READ elsewhere,
   *  never written here). */
  | "blocker_changed"
  /** A readiness assessment was recorded or invalidated by a ticket edit. */
  | "readiness_changed"
  /** max_active_runs or the capacity scope moved. */
  | "capacity_changed"
  /** The armed flag, lease TTL, heartbeat cadence or default workflow moved. */
  | "policy_changed"
  /** A lease expired and was taken over, or a claim was recovered. */
  | "recovery"
  /** The demoted health bound, not a signal. */
  | "watchdog"
  /** An operator asked for a look explicitly. */
  | "manual";

export type WakeState = "pending" | "consumed";

export type DispatcherWake = {
  id: number;
  projectKey: string;
  kind: WakeKind;
  /** The caller's IDEMPOTENCY KEY within (project, kind) — the subject that
   *  changed (a ticket id, a run id, `policy`), never a timestamp or a nonce. Two
   *  processes observing the same change must produce the SAME key, which is what
   *  makes the collapse below meaningful. */
  wakeKey: string;
  detail: string | null;
  state: WakeState;
  consumedBy: string | null;
  consumedAtMs: number | null;
  createdAt: string;
};

type WakeDbRow = {
  id: number;
  project_key: string;
  kind: string;
  wake_key: string;
  detail: string | null;
  state: string;
  consumed_by: string | null;
  consumed_at_ms: number | null;
  created_at: string;
};

const WAKE_COLUMNS = `id, project_key, kind, wake_key, detail, state, consumed_by,
  consumed_at_ms, created_at`;

function toWake(r: WakeDbRow): DispatcherWake {
  return {
    id: r.id,
    projectKey: r.project_key,
    kind: r.kind as WakeKind,
    wakeKey: r.wake_key,
    detail: r.detail,
    state: r.state as WakeState,
    consumedBy: r.consumed_by,
    consumedAtMs: r.consumed_at_ms,
    createdAt: r.created_at,
  };
}

// ─── the top-level evaluation outcome ────────────────────────────────────────

/** THE CLOSED TOP-LEVEL VOCABULARY FG-591 OWNS. One value per evaluation pass,
 *  answering "what happened to this look" — a strictly different question from a
 *  per-candidate ScanReason, which answers "what happened to this candidate".
 *
 *    granted           — a claim was granted this pass.
 *    disabled          — autonomous dispatch is disarmed. Nothing was scanned.
 *    no_capacity       — a candidate was otherwise eligible and the ceiling was
 *                        full. capacity_holders names who holds the slots.
 *    no_eligible_work  — the scan selected nothing: no member was ranked, active,
 *                        unblocked, ready and unclaimed.
 *    lost              — a claim attempt whose re-validation failed; a concurrent
 *                        dispatcher won or a durable fact moved under the scan.
 *    incompatible_only — the ONLY thing standing between the queue and a claim was
 *                        parallel-safety. Kept distinct from no_eligible_work
 *                        because it is TEMPORARY and self-clearing, and reads to
 *                        the operator as "waiting for FG-123 to finish" rather
 *                        than "there is nothing to do".
 *
 *  The column carries no CHECK (FG-585 — SQLite cannot widen one on the
 *  additive-only path), so the closure is enforced HERE, by named refusal, and
 *  pinned by a test. */
export const DISPATCH_REASONS = [
  "granted",
  "disabled",
  "no_capacity",
  "no_eligible_work",
  "lost",
  "incompatible_only",
] as const;

export type DispatchReason = (typeof DISPATCH_REASONS)[number];

const DISPATCH_REASON_SET = new Set<string>(DISPATCH_REASONS);

export function isDispatchReason(s: string): s is DispatchReason {
  return DISPATCH_REASON_SET.has(s);
}

/** ONE HOLDER OF A CAPACITY SLOT, as it was at the moment the ceiling refused.
 *  Recorded rather than re-derived at read time: by the time an operator looks,
 *  the holder may have finished, and "who held the slot when I was refused" is the
 *  question. `projectKey` is the whole point under a HOST-scoped ceiling — without
 *  it a per-project board cannot explain a refusal caused by another project. */
export type CapacityHolder = {
  claimId: string;
  projectKey: string;
  ticketId: string;
  owner: string;
  launchId: string | null;
  runId: string | null;
};

export type DispatcherEvaluation = {
  id: number;
  projectKey: string;
  dispatcherOwner: string;
  /** The fencing generation the pass ran under, so a decision recorded by a
   *  superseded dispatcher is identifiable after the fact. */
  dispatcherGeneration: number | null;
  reason: DispatchReason;
  detail: string | null;
  claimedTicketId: string | null;
  claimId: string | null;
  capacityScope: CapacityScope | null;
  capacityLimit: number | null;
  capacityUsed: number | null;
  capacityHolders: CapacityHolder[] | null;
  /** queue-claims' ScanEntry[] verbatim. Null only when nothing was scanned
   *  (a `disabled` pass), which is itself the honest record. */
  scanEvidence: ScanEntry[] | null;
  /** Which wake caused this look — or null when the watchdog/refill loop drove
   *  it. Lets the operator see whether the event path is delivering at all. */
  wakeKind: string | null;
  nextWatchdogAtMs: number | null;
  evaluatedAtMs: number;
  evaluatedAt: string;
};

type EvaluationDbRow = {
  id: number;
  project_key: string;
  dispatcher_owner: string;
  dispatcher_generation: number | null;
  reason: string;
  detail: string | null;
  claimed_ticket_id: string | null;
  claim_id: string | null;
  capacity_scope: string | null;
  capacity_limit: number | null;
  capacity_used: number | null;
  capacity_holders: string | null;
  scan_evidence: string | null;
  wake_kind: string | null;
  next_watchdog_at_ms: number | null;
  evaluated_at_ms: number;
  evaluated_at: string;
};

const EVALUATION_COLUMNS = `id, project_key, dispatcher_owner, dispatcher_generation, reason,
  detail, claimed_ticket_id, claim_id, capacity_scope, capacity_limit, capacity_used,
  capacity_holders, scan_evidence, wake_kind, next_watchdog_at_ms, evaluated_at_ms, evaluated_at`;

function toEvaluation(r: EvaluationDbRow): DispatcherEvaluation {
  return {
    id: r.id,
    projectKey: r.project_key,
    dispatcherOwner: r.dispatcher_owner,
    dispatcherGeneration: r.dispatcher_generation,
    reason: r.reason as DispatchReason,
    detail: r.detail,
    claimedTicketId: r.claimed_ticket_id,
    claimId: r.claim_id,
    capacityScope: r.capacity_scope === null ? null : (r.capacity_scope as CapacityScope),
    capacityLimit: r.capacity_limit,
    capacityUsed: r.capacity_used,
    capacityHolders: r.capacity_holders === null ? null : (JSON.parse(r.capacity_holders) as CapacityHolder[]),
    scanEvidence: r.scan_evidence === null ? null : (JSON.parse(r.scan_evidence) as ScanEntry[]),
    wakeKind: r.wake_kind,
    nextWatchdogAtMs: r.next_watchdog_at_ms,
    evaluatedAtMs: r.evaluated_at_ms,
    evaluatedAt: r.evaluated_at,
  };
}

function isoFrom(ms: number): string {
  return new Date(ms).toISOString();
}

function requireNonEmpty(value: string, field: string, verb: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new QueueRefusal(
      `forge: dispatcher ${verb} refuses — ${field} is required and was empty. An evidence row ` +
        `that cannot say which project or which dispatcher it describes is worse than no row: it ` +
        `reads as an answer and carries none. Nothing was written.`,
      verb,
      null,
    );
  }
  return value;
}

// ─── wakes ───────────────────────────────────────────────────────────────────

/**
 * Record a durable wake, collapsing onto the existing PENDING record for the same
 * (project_key, kind, wake_key) if there is one.
 *
 * The collapse is ONE STATEMENT against the partial unique index
 * (idx_dispatcher_wakes_pending), not a check-then-insert: a duplicate poke is
 * harmless because the STORE refuses the second row, not because every call site
 * remembered to look first. Two processes that both observe the same run
 * transition therefore cannot leave two pending records — the FG-610
 * idx_queue_claims_live precedent, applied to a signal instead of a reservation.
 *
 * The collapse is NOT a merge: the FIRST pending record's `detail` and
 * `created_at` are kept and the duplicate's are discarded. `wake_key` is the
 * idempotency key, so two records that share one are by definition the same fact,
 * and rewriting the timestamp would make the record say the change happened later
 * than it did.
 *
 * Once a wake is CONSUMED, the next change to the same subject gets its OWN row —
 * the index is partial over `pending` for exactly that reason. Consumed rows are
 * history and are never revived.
 */
export function recordWake(rec: {
  projectKey: string;
  kind: WakeKind;
  wakeKey: string;
  detail?: string | null;
}): DispatcherWake {
  requireNonEmpty(rec.projectKey, "projectKey", "wake");
  requireNonEmpty(rec.kind, "kind", "wake");
  requireNonEmpty(rec.wakeKey, "wakeKey", "wake");

  return writeTransaction((): DispatcherWake => {
    const db = getDb();
    const iso = isoFrom(storeNowMs());
    db.prepare(
      `INSERT INTO dispatcher_wakes
         (project_key, kind, wake_key, detail, state, consumed_by, consumed_at_ms, created_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)
       ON CONFLICT (project_key, kind, wake_key) WHERE state = 'pending' DO NOTHING`,
    ).run(rec.projectKey, rec.kind, rec.wakeKey, rec.detail ?? null, iso);

    // Re-read rather than trusting lastInsertRowid: on a collapse nothing was
    // inserted, and the caller is owed the record that actually stands.
    const row = db
      .prepare(
        `SELECT ${WAKE_COLUMNS} FROM dispatcher_wakes
          WHERE project_key = ? AND kind = ? AND wake_key = ? AND state = 'pending'`,
      )
      .get(rec.projectKey, rec.kind, rec.wakeKey) as WakeDbRow | undefined;
    if (!row) {
      // Unreachable: the INSERT either added the pending row or found one. If it
      // ever fires, the partial index has been altered underneath us and silently
      // returning a fabricated record would hide a lost wake.
      throw new QueueRefusal(
        `forge: dispatcher wake refuses — no pending wake exists for ` +
          `(${rec.projectKey}, ${rec.kind}, ${rec.wakeKey}) immediately after recording one. ` +
          `idx_dispatcher_wakes_pending is not in its canonical shape; a wake may be lost.`,
        "wake",
        null,
      );
    }
    return toWake(row);
  });
}

/** Pending wakes for one project, oldest-first. A READ — it consumes nothing, so
 *  an operator surface can show "three wakes queued" without racing the
 *  dispatcher for them. */
export function pendingWakes(projectKey: string, opts: { limit?: number } = {}): DispatcherWake[] {
  const limit = opts.limit ?? 200;
  const rows = getDb()
    .prepare(
      `SELECT ${WAKE_COLUMNS} FROM dispatcher_wakes
        WHERE project_key = ? AND state = 'pending' ORDER BY id ASC LIMIT ?`,
    )
    .all(projectKey, limit) as WakeDbRow[];
  return rows.map(toWake);
}

export function pendingWakeCount(projectKey: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM dispatcher_wakes WHERE project_key = ? AND state = 'pending'`)
    .get(projectKey) as { n: number };
  return row.n;
}

/** One wake by id, whatever its state. History included — a consumed wake is the
 *  evidence that the signal was delivered and by whom. */
export function getWake(id: number): DispatcherWake | undefined {
  const row = getDb().prepare(`SELECT ${WAKE_COLUMNS} FROM dispatcher_wakes WHERE id = ?`).get(id) as
    | WakeDbRow
    | undefined;
  return row ? toWake(row) : undefined;
}

/** Wake history for one project, newest-first, pending and consumed alike. */
export function listWakes(projectKey: string, opts: { limit?: number } = {}): DispatcherWake[] {
  const limit = opts.limit ?? 100;
  const rows = getDb()
    .prepare(`SELECT ${WAKE_COLUMNS} FROM dispatcher_wakes WHERE project_key = ? ORDER BY id DESC LIMIT ?`)
    .all(projectKey, limit) as WakeDbRow[];
  return rows.map(toWake);
}

// ─── test seam: the window BETWEEN the SELECT and the CAS ─────────────────────
// Load-bearing for the "consumed EXACTLY once under two concurrent consumers"
// proof. A single process cannot otherwise open the window in which the other
// consumer takes a row this one has already selected, and "the CAS is there" is
// not evidence that it fires — a select-then-take with no CAS passes every
// sequential test. queue-claims' setClaimPhaseHookForTest is the precedent. Never
// armed in production.
let _betweenSelectAndCasHook: ((wakeId: number) => void) | null = null;

export function setWakeConsumePhaseHookForTest(fn: ((wakeId: number) => void) | null): void {
  _betweenSelectAndCasHook = fn;
}

/**
 * CONSUME pending wakes for one project, exactly once each.
 *
 * Each row is taken by a COMPARE-AND-SET (`... WHERE id = ? AND state =
 * 'pending'`, continuations.ts's shape) and is returned only when
 * `changes === 1`. Two concurrent consumers therefore partition the pending set
 * between them and never both see the same row: the loser's CAS reports 0 changes
 * and the row is simply not in its result. The grant is the changed row, never the
 * prior SELECT — a select-then-take without the CAS is the check-then-act race
 * this closes.
 *
 * The returned wakes are what this consumer OWNS. It is not a lease and there is
 * no renewal: a consumer that dies after consuming loses those signals, and the
 * watchdog — never this function — is what bounds that loss. Wakes are a
 * coalescing hint about WHERE to look, not a work queue, so re-deriving the same
 * conclusion from durable state on the next pass is always correct.
 */
export function claimWakes(req: { projectKey: string; consumer: string; limit?: number }): DispatcherWake[] {
  requireNonEmpty(req.projectKey, "projectKey", "claim-wakes");
  requireNonEmpty(req.consumer, "consumer", "claim-wakes");
  const limit = req.limit ?? 200;

  return writeTransaction((): DispatcherWake[] => {
    const db = getDb();
    const now = storeNowMs();
    const candidates = db
      .prepare(
        `SELECT ${WAKE_COLUMNS} FROM dispatcher_wakes
          WHERE project_key = ? AND state = 'pending' ORDER BY id ASC LIMIT ?`,
      )
      .all(req.projectKey, limit) as WakeDbRow[];

    const cas = db.prepare(
      `UPDATE dispatcher_wakes
          SET state = 'consumed', consumed_by = ?, consumed_at_ms = ?
        WHERE id = ? AND state = 'pending'`,
    );

    const taken: DispatcherWake[] = [];
    for (const row of candidates) {
      if (_betweenSelectAndCasHook) _betweenSelectAndCasHook(row.id);
      const res = cas.run(req.consumer, now, row.id);
      if (res.changes === 1) {
        taken.push({ ...toWake(row), state: "consumed", consumedBy: req.consumer, consumedAtMs: now });
      }
    }
    return taken;
  });
}

// ─── evaluations ─────────────────────────────────────────────────────────────

/** Map live claims to the recorded holder list. Kept here rather than at the call
 *  site so the JSON shape the board reads has exactly one author. */
export function capacityHoldersFrom(claims: readonly QueueClaim[]): CapacityHolder[] {
  return claims.map((c) => ({
    claimId: c.id,
    projectKey: c.projectKey,
    ticketId: c.ticketId,
    owner: c.owner,
    launchId: c.launchId,
    runId: c.runId,
  }));
}

export type EvaluationRecord = {
  projectKey: string;
  dispatcherOwner: string;
  dispatcherGeneration?: number | null;
  reason: DispatchReason;
  /** Prose for the operator, in the AC's own register — "waiting for FG-123 to
   *  finish", "2/2 live claims in host scope". Never a substitute for the
   *  structured columns beside it. */
  detail?: string | null;
  claimedTicketId?: string | null;
  claimId?: string | null;
  capacityScope?: CapacityScope | null;
  capacityLimit?: number | null;
  capacityUsed?: number | null;
  capacityHolders?: readonly CapacityHolder[] | null;
  scanEvidence?: readonly ScanEntry[] | null;
  wakeKind?: string | null;
  nextWatchdogAtMs?: number | null;
};

/**
 * Persist ONE row for ONE evaluation pass. Called on EVERY outcome, including
 * every refusal — a pass that granted nothing is the pass the operator most needs
 * a record of.
 *
 * TWO THINGS ARE REFUSED BY NAME rather than stored:
 *
 *  - a `reason` outside DISPATCH_REASONS. The column has no CHECK (FG-585), so an
 *    unrecognised value would persist and then read as an unexplained outcome on
 *    every surface downstream.
 *  - a `granted` row with no claim, or a NON-granted row carrying one. Those two
 *    shapes are lies in opposite directions: the first claims work started when
 *    the claim table has no such row, and the second attributes a claim to a pass
 *    that refused. Either would make the evidence trail unusable as evidence,
 *    which is the only thing this table is for.
 *
 * The pass's own `capacity_*` values are recorded as ENFORCED, not re-derived at
 * read time. The ceiling is counted inside claimNextEligible's write transaction
 * and nowhere else; what is written here is a REPORT of that count, and nothing
 * reads it back to admit or refuse anything.
 */
export function recordEvaluation(rec: EvaluationRecord): DispatcherEvaluation {
  requireNonEmpty(rec.projectKey, "projectKey", "evaluation");
  requireNonEmpty(rec.dispatcherOwner, "dispatcherOwner", "evaluation");

  if (!isDispatchReason(rec.reason)) {
    throw new QueueRefusal(
      `forge: dispatcher evaluation refuses — '${String(rec.reason)}' is not one of the ` +
        `${DISPATCH_REASONS.length} top-level outcomes FG-591 owns ` +
        `(${DISPATCH_REASONS.join(" | ")}). dispatcher_evaluations.reason carries no CHECK ` +
        `(FG-585: SQLite cannot widen one on the additive-only path), so an unrecognised value ` +
        `would persist and then read as an unexplained outcome on the board, the CLI and the API ` +
        `alike. Nothing was written.`,
      "evaluation",
      null,
    );
  }

  const claimedTicketId = rec.claimedTicketId ?? null;
  const claimId = rec.claimId ?? null;
  if (rec.reason === "granted" && (claimedTicketId === null || claimId === null)) {
    throw new QueueRefusal(
      `forge: dispatcher evaluation refuses — reason 'granted' needs both claimedTicketId and ` +
        `claimId, and got ${claimedTicketId === null ? "no ticket" : `ticket '${claimedTicketId}'`} / ` +
        `${claimId === null ? "no claim" : `claim '${claimId}'`}. A granted row with no claim says ` +
        `work started while queue_claims holds no such reservation — the exact ambiguity this ` +
        `evidence trail exists to remove. Nothing was written.`,
      "evaluation",
      null,
    );
  }
  if (rec.reason !== "granted" && (claimedTicketId !== null || claimId !== null)) {
    throw new QueueRefusal(
      `forge: dispatcher evaluation refuses — reason '${rec.reason}' is a REFUSAL and must carry ` +
        `no claim, but claimedTicketId='${claimedTicketId ?? ""}' claimId='${claimId ?? ""}' was ` +
        `supplied. None of the refusals writes a claim (queue-claims states it), so attributing ` +
        `one to this pass would credit a reservation to the pass that declined to make it. ` +
        `Nothing was written.`,
      "evaluation",
      null,
    );
  }

  return writeTransaction((): DispatcherEvaluation => {
    const now = storeNowMs();
    const iso = isoFrom(now);
    const holders = rec.capacityHolders ?? null;
    const scanned = rec.scanEvidence ?? null;
    const info = getDb()
      .prepare(
        `INSERT INTO dispatcher_evaluations
           (project_key, dispatcher_owner, dispatcher_generation, reason, detail,
            claimed_ticket_id, claim_id, capacity_scope, capacity_limit, capacity_used,
            capacity_holders, scan_evidence, wake_kind, next_watchdog_at_ms,
            evaluated_at_ms, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.projectKey,
        rec.dispatcherOwner,
        rec.dispatcherGeneration ?? null,
        rec.reason,
        rec.detail ?? null,
        claimedTicketId,
        claimId,
        rec.capacityScope ?? null,
        rec.capacityLimit ?? null,
        rec.capacityUsed ?? null,
        holders === null ? null : JSON.stringify(holders),
        scanned === null ? null : JSON.stringify(scanned),
        rec.wakeKind ?? null,
        rec.nextWatchdogAtMs ?? null,
        now,
        iso,
      );
    return {
      id: Number(info.lastInsertRowid),
      projectKey: rec.projectKey,
      dispatcherOwner: rec.dispatcherOwner,
      dispatcherGeneration: rec.dispatcherGeneration ?? null,
      reason: rec.reason,
      detail: rec.detail ?? null,
      claimedTicketId,
      claimId,
      capacityScope: rec.capacityScope ?? null,
      capacityLimit: rec.capacityLimit ?? null,
      capacityUsed: rec.capacityUsed ?? null,
      capacityHolders: holders === null ? null : holders.map((h) => ({ ...h })),
      scanEvidence: scanned === null ? null : scanned.map((s) => ({ ...s })),
      wakeKind: rec.wakeKind ?? null,
      nextWatchdogAtMs: rec.nextWatchdogAtMs ?? null,
      evaluatedAtMs: now,
      evaluatedAt: iso,
    };
  });
}

/** THE OPERATOR SURFACE'S PRIMARY READ: the most recent pass for one project.
 *  This is what turns "nothing is running" into a named reason. */
export function latestEvaluation(projectKey: string): DispatcherEvaluation | undefined {
  const row = getDb()
    .prepare(`SELECT ${EVALUATION_COLUMNS} FROM dispatcher_evaluations WHERE project_key = ? ORDER BY id DESC LIMIT 1`)
    .get(projectKey) as EvaluationDbRow | undefined;
  return row ? toEvaluation(row) : undefined;
}

/** The most recent pass for EVERY project that has one, newest project-pass
 *  first. The host-wide view: a project whose queue is stalled by another
 *  project's slots needs both rows to explain itself. */
export function latestEvaluationPerProject(): DispatcherEvaluation[] {
  const rows = getDb()
    .prepare(
      `SELECT ${EVALUATION_COLUMNS} FROM dispatcher_evaluations
        WHERE id IN (SELECT MAX(id) FROM dispatcher_evaluations GROUP BY project_key)
        ORDER BY id DESC`,
    )
    .all() as EvaluationDbRow[];
  return rows.map(toEvaluation);
}

/** Evaluation history for one project, newest-first. */
export function evaluationsFor(
  projectKey: string,
  opts: { limit?: number; reason?: DispatchReason } = {},
): DispatcherEvaluation[] {
  const limit = opts.limit ?? 50;
  const rows = opts.reason
    ? (getDb()
        .prepare(
          `SELECT ${EVALUATION_COLUMNS} FROM dispatcher_evaluations
            WHERE project_key = ? AND reason = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(projectKey, opts.reason, limit) as EvaluationDbRow[])
    : (getDb()
        .prepare(
          `SELECT ${EVALUATION_COLUMNS} FROM dispatcher_evaluations
            WHERE project_key = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(projectKey, limit) as EvaluationDbRow[]);
  return rows.map(toEvaluation);
}

/** THE HOLDER LIST WHEN THE CEILING REFUSED. The latest `no_capacity` pass, whose
 *  capacityHolders answer the question a HOST-scoped refusal raises and a
 *  per-project board otherwise cannot: which OTHER project is holding the slots.
 *  Deliberately not folded into latestEvaluation — the last pass may since have
 *  granted, and the operator asking "why did I wait" still needs the refusal. */
export function latestCapacityRefusal(projectKey: string): DispatcherEvaluation | undefined {
  const found = evaluationsFor(projectKey, { limit: 1, reason: "no_capacity" });
  return found[0];
}

/** The next watchdog deadline the latest pass ARMED, as a durable fact rather
 *  than a recomputation. `undefined` means no pass has run for this project;
 *  `null` means the last pass armed no deadline — two different answers, and
 *  collapsing them would hide a dispatcher that stopped re-arming. */
export function nextWatchdogDeadlineMs(projectKey: string): number | null | undefined {
  const latest = latestEvaluation(projectKey);
  return latest === undefined ? undefined : latest.nextWatchdogAtMs;
}
