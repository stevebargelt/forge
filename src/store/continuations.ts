// FG-562 (BD-5): the durable continuation-claim primitive.
//
// A controller that observes a launch reaching a terminal disposition must
// advance the workflow's next action EXACTLY ONCE, even though completion events
// are delivered at-least-once (duplicated, delayed, or lost). This module is the
// durable claim that makes advancement idempotent: the controller reads the
// canonical launch record (readLaunch/classifyExit — the canonical terminal
// vocabulary, BD-10), records the observed disposition here, then claims the
// single `ready -> dispatching` transition through a PHASE-BOUND compare-and-set.
// A fresh claim can ONLY proceed from `ready` — i.e. AFTER a terminal disposition
// has been durably observed (BD-3) — so a claim never precedes a recorded terminal
// observation. The grant is `changes === 1`; a lost/stale/racing claim writes NO state.
//
// SCOPE BOUNDARY — FG-562 is the PRIMITIVE only. This module records the
// caller-supplied observation, VALIDATES the canonical vocabulary, and DERIVES
// terminality via the one classifier — but it does NOT establish that the recorded
// disposition matches the REAL launch. The end-to-end BD-3 guarantee (reading the
// canonical source readLaunch/classifyExit IMMEDIATELY before observing/claiming and
// passing that exact observation in) is the production CONSUMER's responsibility
// (orchestrator FG-563 / campaign FG-564) and is OPEN there — NOT delivered
// end-to-end by this primitive. The primitive trusts the observation it is given.
//
// TWO SOURCES OF TRUTH, NEVER JOINED IN ONE QUERY. The filesystem launch record
// (readLaunch/classifyExit) is authoritative for the terminal DISPOSITION; this
// table is authoritative for the CLAIM + ADVANCEMENT. A controller reads the
// launch record (canonical classifier) THEN CAS-writes the continuation. Nothing
// here infers advancement from a launch record or re-derives a disposition from
// continuation columns — that would reintroduce the check-then-act race the CAS
// closes.
//
// THE WRITE RULE (FG-548): every mutation takes its write lock IMMEDIATELY via
// writeTransaction (BEGIN IMMEDIATE), never a deferred txn that upgrades mid-flight.
// THE CLOCK RULE (FG-425): every lease timestamp is written and compared against
// the store's own clock (storeNowMs), never an independently-sourced process clock.

import { createHash } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { storeNowMs } from "./publications.js";
import { isTerminalStatus, type LaunchStatus } from "../v2/launch.js";

// Enum-as-CONVENTION (FG-585): TEXT columns with no DB CHECK, so an old/new binary
// never fights a constraint the other doesn't share. These types document the
// convention; they do not constrain the store.
export type ConsumerKind = "orchestrator" | "campaign";

export type ContinuationState =
  | "awaiting_completion" // recorded; the launch this step awaits is still running
  | "ready" // the awaited launch is terminal and observed; a claim may proceed
  | "dispatching" // a controller holds the claim and is issuing the next action
  | "advanced" // the next action was dispatched and recorded; terminal for this step
  | "blocked"; // the claim-to-dispatch window could not be completed; visibly stuck

// The canonical LaunchStatus.state (BD-10 — no second terminal vocabulary). Recorded
// as the caller-supplied observation when the controller wakes; owner_gone/unknown are
// legitimate dispositions with NO exit record and must remain recordable/claimable.
export type ObservedStatus = LaunchStatus["state"];

// The canonical LaunchStatus.state vocabulary as a validation whitelist. Typed as
// Record<ObservedStatus, true> so a state ADDED to LaunchStatus upstream forces this
// to be updated (compile error) rather than silently rejecting a real disposition.
// This is a VALIDATION whitelist, NOT a second TERMINAL vocabulary — terminality is
// still derived through the one canonical isTerminalStatus classifier (BD-10).
const LAUNCH_STATUS_STATES: Record<ObservedStatus, true> = {
  running: true,
  exited_ok: true,
  exited_error: true,
  signaled: true,
  terminated_unattributed: true,
  owner_gone: true,
  unknown: true,
};

function isObservedStatus(s: string): s is ObservedStatus {
  return Object.prototype.hasOwnProperty.call(LAUNCH_STATUS_STATES, s);
}

// A typed, structured next action — NEVER an opaque shell string. Serialized
// canonically (stable key order) so the CAS `next_action = ?` compare and the
// derived dispatch_key are identical across processes and versions.
export type NextAction = { kind: string } & Record<string, unknown>;

export type Continuation = {
  continuationId: string;
  consumerKind: ConsumerKind;
  sourceLaunchId: string;
  currentPhase: string;
  nextAction: NextAction;
  state: ContinuationState;
  claimOwner?: string;
  claimExpiresAt?: number;
  dispatchKey?: string;
  dispatchedRunId?: string;
  dispatchedTaskId?: string;
  lastObservedStatus?: ObservedStatus;
  createdAt: string;
  updatedAt: string;
};

type ContinuationRow = {
  continuation_id: string;
  consumer_kind: string;
  source_launch_id: string;
  current_phase: string;
  next_action: string;
  state: string;
  claim_owner: string | null;
  claim_expires_at: number | null;
  dispatch_key: string | null;
  dispatched_run_id: string | null;
  dispatched_task_id: string | null;
  last_observed_status: string | null;
  created_at: string;
  updated_at: string;
};

function toContinuation(r: ContinuationRow): Continuation {
  return {
    continuationId: r.continuation_id,
    consumerKind: r.consumer_kind as ConsumerKind,
    sourceLaunchId: r.source_launch_id,
    currentPhase: r.current_phase,
    nextAction: JSON.parse(r.next_action) as NextAction,
    state: r.state as ContinuationState,
    ...(r.claim_owner !== null ? { claimOwner: r.claim_owner } : {}),
    ...(r.claim_expires_at !== null ? { claimExpiresAt: r.claim_expires_at } : {}),
    ...(r.dispatch_key !== null ? { dispatchKey: r.dispatch_key } : {}),
    ...(r.dispatched_run_id !== null ? { dispatchedRunId: r.dispatched_run_id } : {}),
    ...(r.dispatched_task_id !== null ? { dispatchedTaskId: r.dispatched_task_id } : {}),
    ...(r.last_observed_status !== null ? { lastObservedStatus: r.last_observed_status as ObservedStatus } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Canonical (stable key order, recursive) JSON of a structured action. The CAS
 *  compares next_action byte-for-byte and dispatch_key is derived from this, so
 *  two processes that mean the same action MUST produce identical bytes — a plain
 *  JSON.stringify would not, because object key order is insertion order. */
export function canonicalizeAction(action: NextAction): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = canon((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(action));
}

/** The deterministic idempotency receipt: a hash of the composite identity
 *  (continuation_id, source_launch_id, canonical next_action). Deterministic on
 *  purpose — a recovery or an expired-lease takeover recomputes the IDENTICAL key,
 *  so the downstream dispatch (keyed on it) is idempotent whichever controller
 *  runs it (F17). */
export function deriveDispatchKey(continuationId: string, sourceLaunchId: string, canonicalAction: string): string {
  return createHash("sha256")
    .update(`${continuationId}\n${sourceLaunchId}\n${canonicalAction}`)
    .digest("hex");
}

// ── records ──────────────────────────────────────────────────────────────────

/** Record a continuation the moment a controller launches the work its next step
 *  awaits — BEFORE the launch can complete, so a completion delivered at-least-once
 *  always finds a durable row to claim against (closes the record-vs-completion
 *  race, BD-6-adjacent). next_action is stored canonically. */
export function recordContinuation(rec: {
  continuationId: string;
  consumerKind: ConsumerKind;
  sourceLaunchId: string;
  currentPhase: string;
  nextAction: NextAction;
}): Continuation {
  return writeTransaction((): Continuation => {
    const iso = nowIso(storeNowMs());
    const canonical = canonicalizeAction(rec.nextAction);
    getDb()
      .prepare(
        `INSERT INTO continuations
           (continuation_id, consumer_kind, source_launch_id, current_phase, next_action,
            state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'awaiting_completion', ?, ?)`,
      )
      .run(rec.continuationId, rec.consumerKind, rec.sourceLaunchId, rec.currentPhase, canonical, iso, iso);
    return {
      continuationId: rec.continuationId,
      consumerKind: rec.consumerKind,
      sourceLaunchId: rec.sourceLaunchId,
      currentPhase: rec.currentPhase,
      nextAction: rec.nextAction,
      state: "awaiting_completion",
      createdAt: iso,
      updatedAt: iso,
    };
  });
}

export function getContinuation(continuationId: string): Continuation | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM continuations WHERE continuation_id = ?`)
    .get(continuationId) as ContinuationRow | undefined;
  return row ? toContinuation(row) : undefined;
}

export function continuationByDispatchKey(dispatchKey: string): Continuation | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM continuations WHERE dispatch_key = ?`)
    .get(dispatchKey) as ContinuationRow | undefined;
  return row ? toContinuation(row) : undefined;
}

export function continuationsForLaunch(sourceLaunchId: string): Continuation[] {
  const rows = getDb()
    .prepare(`SELECT * FROM continuations WHERE source_launch_id = ? ORDER BY created_at ASC`)
    .all(sourceLaunchId) as ContinuationRow[];
  return rows.map(toContinuation);
}

/**
 * THE RESTART-REPLAY ENTRY-POINT — the durable set a consumer resumes after a
 * controller restart. It returns every continuation currently in the
 * claim-to-dispatch crash window: CLAIMED (state='dispatching', so dispatch_key is
 * set) but NOT yet settled to `advanced` (and NOT the `awaiting_completion`/`ready`
 * slots that never dispatched, nor the `blocked` ones an operator owns). Ordered
 * oldest-first (updated_at) so the longest-stuck claim is reconciled first.
 * Optionally scoped to one consumer so an orchestrator and a campaign reconciler each
 * collect only their own in-flight claims.
 *
 * THE CONTRACT with the consumer: this primitive supplies the SET; the consumer
 * (orchestrator FG-563 / campaign FG-564) drives the replay LOOP. For each returned
 * continuation the consumer calls adoptOrClaimDispatch (or continuationByDispatchKey
 * directly) with the slot's identity — which returns `disposition:'adopt'` because the
 * receipt is already present — then looks up whether the physical run was created
 * (found → adopt it, recording ids via recordDispatchResult; not found → the dispatch
 * never happened, so it completes it) and, to become the owner that settles it, takes
 * over the lease via claimContinuationDispatch(expectedState:'dispatching'). The
 * physical check-before-spawn is the CONSUMER's job (ticket non-scope); this function
 * only makes the replay set durable and enumerable.
 */
export function continuationsInDispatch(opts: { consumerKind?: ConsumerKind } = {}): Continuation[] {
  const rows = opts.consumerKind
    ? (getDb()
        .prepare(`SELECT * FROM continuations WHERE state = 'dispatching' AND consumer_kind = ? ORDER BY updated_at ASC`)
        .all(opts.consumerKind) as ContinuationRow[])
    : (getDb()
        .prepare(`SELECT * FROM continuations WHERE state = 'dispatching' ORDER BY updated_at ASC`)
        .all() as ContinuationRow[]);
  return rows.map(toContinuation);
}

/**
 * READ-ONLY operator/reporting reader over the continuations table (FG-565 G1).
 *
 * Unlike continuationsInDispatch — which is hard-scoped to state='dispatching' as
 * the restart-replay set — this returns rows in ANY state (including `blocked`, the
 * "stuck, human needed" slot an operator must see) so a read surface can render the
 * durable continuation evidence. It is a pure SELECT: it takes no write lock, makes
 * no claim, and never inherits the dispatching-only filter semantics. Optional
 * filters narrow to one state and/or one consumer. Ordered newest-activity-first
 * (updated_at DESC), mirroring the `forge lost-signals` newest-first listing.
 */
/** The default cap on a single listContinuations page — a read surface must never
 *  issue an unbounded SELECT over an ever-growing table. Callers may raise/lower it,
 *  but the default keeps the operator listing bounded. */
export const LIST_CONTINUATIONS_DEFAULT_LIMIT = 200;

export function listContinuations(
  opts: { state?: ContinuationState; consumerKind?: ConsumerKind; limit?: number } = {},
): Continuation[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.state) {
    clauses.push("state = ?");
    params.push(opts.state);
  }
  if (opts.consumerKind) {
    clauses.push("consumer_kind = ?");
    params.push(opts.consumerKind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? LIST_CONTINUATIONS_DEFAULT_LIMIT;
  params.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM continuations ${where} ORDER BY updated_at DESC, continuation_id ASC LIMIT ?`)
    .all(...params) as ContinuationRow[];
  return rows.map(toContinuation);
}

export type StaleObservation = {
  continuationId: string;
  sourceLaunchId: string;
  currentPhase: string;
  status: ObservedStatus;
  observedAt: string;
};

/**
 * Record the caller-supplied disposition the controller observed on wake, and move
 * `awaiting_completion -> ready` when that disposition is terminal. This NEVER reads
 * or fabricates an exit file — the controller passes the state readLaunch/classifyExit
 * already returned, INCLUDING owner_gone/unknown (legitimate terminal dispositions
 * with NO exit record). Recording an observation is NOT the claim: a stale/duplicate
 * observation is recorded and then IGNORED by the phase-bound CAS below.
 *
 * WHAT THE PRIMITIVE GUARANTEES — AND WHAT IT DOES NOT (BD-3, FG-562 review round 3).
 * Terminality is DERIVED from the status itself via the ONE canonical classifier
 * (isTerminalStatus) — it is NEVER taken as a caller assertion of terminality. A
 * promotion to `ready` can therefore happen ONLY for a status that IS a terminal
 * LaunchStatus.state; a non-terminal (`running`) or an invalid status can NEVER
 * promote the slot, no matter what the caller asserts. An arbitrary/fabricated status
 * string is REJECTED outright. What the primitive does NOT do: it does not establish
 * that the recorded disposition matches the REAL launch — it TRUSTS the observation it
 * is given. Establishing that authority (reading readLaunch/classifyExit immediately
 * before observing and passing that exact state in) is the production CONSUMER's job
 * (orchestrator FG-563 / campaign FG-564), where end-to-end BD-3 enforcement is OPEN.
 * The controller passes the state readLaunch/classifyExit returned (two sources of
 * truth, never joined — the primitive does not itself read the fs launch record). A
 * non-terminal observation still records `last_observed_status` without promoting.
 *
 * THE OBSERVATION IS LAUNCH-BOUND (FG-562 review round 2). The disposition belongs
 * to a SPECIFIC launch, so the write matches `source_launch_id = ?` — the launch
 * the event is about. Without this binding, a DELAYED terminal event from launch A,
 * arriving after rearmForNextPhase has rebound the slot to launch B, would promote
 * phase B's `awaiting_completion` row to `ready` (and stamp launch A's disposition
 * into phase B's evidence) — fabricating terminal evidence for a launch that never
 * ran in phase B and making B wrongly claimable before its OWN launch finished. The
 * phase-bound CAS cannot undo that fabricated `ready`; the promotion itself must be
 * launch-bound. A stale launch-A event now matches nothing (source_launch_id is
 * launch-B) and writes NO state to the slot — but it is NOT silently discarded: the
 * evidence is appended to `continuation_stale_observations` (durable audit,
 * observed-RECORDED-and-ignored), so the audit is not lost when the slot advanced.
 *
 * A pure record: it advances state to `ready` only from `awaiting_completion`, so
 * observing the CURRENT launch again after a claim/advance updates the evidence
 * without disturbing the claim.
 */
export function observeLaunchStatus(
  continuationId: string,
  sourceLaunchId: string,
  status: ObservedStatus,
): Continuation | undefined {
  if (!isObservedStatus(status)) {
    throw new Error(`observeLaunchStatus: '${status}' is not a canonical LaunchStatus.state`);
  }
  // Terminal via the ONE canonical classifier (never a caller assertion, never a
  // second inline vocabulary): only a terminal LaunchStatus.state may promote to ready.
  const terminal = isTerminalStatus({ state: status } as LaunchStatus);
  return writeTransaction((): Continuation | undefined => {
    const db = getDb();
    const iso = nowIso(storeNowMs());
    const res = terminal
      ? db
          .prepare(
            `UPDATE continuations
                SET last_observed_status = ?,
                    state = CASE WHEN state = 'awaiting_completion' THEN 'ready' ELSE state END,
                    updated_at = ?
              WHERE continuation_id = ? AND source_launch_id = ?`,
          )
          .run(status, iso, continuationId, sourceLaunchId)
      : db
          .prepare(
            `UPDATE continuations SET last_observed_status = ?, updated_at = ?
              WHERE continuation_id = ? AND source_launch_id = ?`,
          )
          .run(status, iso, continuationId, sourceLaunchId);

    // A stale observation — the continuation EXISTS but is now bound to a DIFFERENT
    // launch (a delayed event from a superseded phase) — matched 0 rows above. It
    // MUST leave durable evidence (observed-recorded-and-ignored, BD-3 audit) rather
    // than being silently discarded, and it MUST NOT touch the slot or advance any
    // phase. Append it to the audit table. A missing continuation (never recorded)
    // has nothing to audit against and is left alone.
    if (res.changes === 0) {
      const current = getContinuation(continuationId);
      if (current && current.sourceLaunchId !== sourceLaunchId) {
        db.prepare(
          `INSERT INTO continuation_stale_observations
             (continuation_id, source_launch_id, current_phase, status, observed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(continuationId, sourceLaunchId, current.currentPhase, status, iso);
      }
    }
    return getContinuation(continuationId);
  });
}

/** The durable append-only audit of stale observations for a continuation (a
 *  delayed launch-completion event that arrived after the slot advanced past that
 *  launch). Oldest-first. Audit-only: the claim path never reads this. */
export function staleObservationsFor(continuationId: string): StaleObservation[] {
  const rows = getDb()
    .prepare(`SELECT * FROM continuation_stale_observations WHERE continuation_id = ? ORDER BY id ASC`)
    .all(continuationId) as {
    continuation_id: string;
    source_launch_id: string;
    current_phase: string;
    status: string;
    observed_at: string;
  }[];
  return rows.map((r) => ({
    continuationId: r.continuation_id,
    sourceLaunchId: r.source_launch_id,
    currentPhase: r.current_phase,
    status: r.status as ObservedStatus,
    observedAt: r.observed_at,
  }));
}

/**
 * Batched form of staleObservationsFor for a LIST render: fetch the stale-observation
 * audit for MANY continuations in ONE query (a single IN, keyed by continuation id),
 * so a list surface renders without an N+1. Returns a map keyed by continuation id;
 * a continuation with no stale observations is simply absent (callers default to []).
 * Same oldest-first (id ASC) order per continuation as staleObservationsFor.
 */
export function staleObservationsForMany(continuationIds: string[]): Map<string, StaleObservation[]> {
  const out = new Map<string, StaleObservation[]>();
  if (continuationIds.length === 0) return out;
  const placeholders = continuationIds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT * FROM continuation_stale_observations WHERE continuation_id IN (${placeholders}) ORDER BY id ASC`,
    )
    .all(...continuationIds) as {
    continuation_id: string;
    source_launch_id: string;
    current_phase: string;
    status: string;
    observed_at: string;
  }[];
  for (const r of rows) {
    const obs: StaleObservation = {
      continuationId: r.continuation_id,
      sourceLaunchId: r.source_launch_id,
      currentPhase: r.current_phase,
      status: r.status as ObservedStatus,
      observedAt: r.observed_at,
    };
    const list = out.get(r.continuation_id);
    if (list) list.push(obs);
    else out.set(r.continuation_id, [obs]);
  }
  return out;
}

/**
 * Bind the SAME continuation slot to the next phase after the current one
 * advanced: set the new launch it awaits, the new phase, and the new next action,
 * and reset to `awaiting_completion`, clearing the prior claim/receipt/observation.
 * Scoped to state='advanced' so the next phase is bound only after this one settled.
 *
 * This is what makes phase-binding load-bearing across phases: once the slot moves
 * to phase B (a new source_launch_id + current_phase + next_action), a DELAYED
 * completion from the phase-A launch can no longer satisfy the CAS predicate.
 */
export function rearmForNextPhase(
  continuationId: string,
  rec: { sourceLaunchId: string; currentPhase: string; nextAction: NextAction },
): Continuation | undefined {
  return writeTransaction((): Continuation | undefined => {
    getDb()
      .prepare(
        `UPDATE continuations
            SET source_launch_id = ?,
                current_phase = ?,
                next_action = ?,
                state = 'awaiting_completion',
                claim_owner = NULL,
                claim_expires_at = NULL,
                dispatch_key = NULL,
                dispatched_run_id = NULL,
                dispatched_task_id = NULL,
                last_observed_status = NULL,
                updated_at = ?
          WHERE continuation_id = ? AND state = 'advanced'`,
      )
      .run(rec.sourceLaunchId, rec.currentPhase, canonicalizeAction(rec.nextAction), nowIso(storeNowMs()), continuationId);
    return getContinuation(continuationId);
  });
}

// ── the phase-bound CAS claim (the load-bearing correctness) ──────────────────

export type ClaimRequest = {
  continuationId: string;
  sourceLaunchId: string;
  consumerKind: ConsumerKind;
  currentPhase: string;
  nextAction: NextAction;
  // The prior state the caller expects. A FRESH claim expects 'ready' ONLY — the
  // awaited launch's terminal disposition MUST already be durably observed (BD-3),
  // so a claim can never precede a durably-recorded terminal observation (claim_owner
  // IS NULL). 'awaiting_completion' is deliberately NOT claimable: a controller must
  // observe a terminal status (observeLaunchStatus moves the slot to 'ready')
  // before any dispatch. An expired-lease RECOVERY (F16) expects 'dispatching' and
  // grants only when the lease is strictly in the past.
  expectedState: Extract<ContinuationState, "ready" | "dispatching">;
  owner: string;
  leaseTtlMs: number;
};

export type ClaimOutcome =
  | { granted: true; continuation: Continuation; dispatchKey: string }
  /** Lost/stale/racing: the CAS matched nothing (changes === 0) and wrote no
   *  state. `continuation` is the row as it stands now (or undefined if it never
   *  existed) so the loser can observe the winning claimed/advanced state (F14). */
  | { granted: false; reason: "lost"; continuation: Continuation | undefined };

/**
 * Grant the `<expectedState> -> dispatching` transition via ONE immediate
 * transaction whose WHERE matches ALL of the phase-binding keys plus the prior
 * state and lease. THE PHASE-BINDING IS THE POINT: because source_launch_id,
 * current_phase, next_action, consumer_kind, and the expected prior state are all
 * in the predicate, a DELAYED completion from launch A can NEVER claim/advance a
 * newer phase B — the CAS matches nothing (changes === 0), the stale completion is
 * IGNORED, and no state is written. Uniqueness (exactly-once) alone would NOT stop
 * that: a claim keyed only on continuation_id would wrongly advance the newer phase.
 *
 * dispatch_key is derived deterministically and written HERE, at claim time, BEFORE
 * any dispatch — it is the idempotency receipt the primitive supplies for F17. The
 * takeover path (expectedState='dispatching', lease expired) recomputes the IDENTICAL
 * key, so recovery lands on the same receipt rather than a new one. This primitive
 * owns the receipt, the crash-window collector (continuationsInDispatch), and late
 * adoption (recordDispatchResult); the PHYSICAL dispatcher that keys run-creation on
 * this receipt and looks up an already-created run before re-dispatching lives in the
 * consumers (orchestrator FG-563 / campaign FG-564) that adopt this primitive.
 *
 * BD-3: this grants on whatever disposition the controller observed — it neither
 * requires nor fabricates an exit record. owner_gone/unknown claims are legitimate.
 */
export function claimContinuationDispatch(req: ClaimRequest): ClaimOutcome {
  return writeTransaction((): ClaimOutcome => {
    const db = getDb();
    const now = storeNowMs();
    const iso = nowIso(now);
    const canonical = canonicalizeAction(req.nextAction);
    const dispatchKey = deriveDispatchKey(req.continuationId, req.sourceLaunchId, canonical);

    const res = db
      .prepare(
        `UPDATE continuations
            SET state = 'dispatching',
                claim_owner = ?,
                claim_expires_at = ?,
                dispatch_key = ?,
                updated_at = ?
          WHERE continuation_id = ?
            AND source_launch_id = ?
            AND consumer_kind = ?
            AND current_phase = ?
            AND next_action = ?
            AND state = ?
            AND (claim_owner IS NULL OR claim_expires_at < ?)`,
      )
      .run(
        req.owner,
        now + req.leaseTtlMs,
        dispatchKey,
        iso,
        req.continuationId,
        req.sourceLaunchId,
        req.consumerKind,
        req.currentPhase,
        canonical,
        req.expectedState,
        now,
      );

    const continuation = getContinuation(req.continuationId);
    if (res.changes === 1 && continuation) {
      return { granted: true, continuation, dispatchKey };
    }
    return { granted: false, reason: "lost", continuation };
  });
}

// ── the F17 adoption entry-point (adopt-not-duplicate, made a real function) ───

export type AdoptOrClaimRequest = {
  continuationId: string;
  sourceLaunchId: string;
  consumerKind: ConsumerKind;
  currentPhase: string;
  nextAction: NextAction;
  owner: string;
  leaseTtlMs: number;
};

export type AdoptOrClaimOutcome =
  /** A prior dispatch already exists under the deterministic receipt (the slot was
   *  claimed — dispatch_key is set — regardless of whether the run/task ids were
   *  recorded yet). The caller ADOPTS it: looks up the already-created run keyed on
   *  `dispatchKey` and continues from there, NEVER dispatching a duplicate. This is
   *  the F17 no-duplicate guarantee made concrete — the adopted `continuation`
   *  carries `dispatchedRunId`/`dispatchedTaskId` when the crashed owner got as far
   *  as recordDispatchResult, and neither when it crashed before. */
  | { disposition: "adopt"; continuation: Continuation; dispatchKey: string }
  /** No prior dispatch existed; a FRESH claim was granted from `ready`. The caller
   *  performs the physical dispatch, then recordDispatchResult + markAdvanced. */
  | { disposition: "claim"; continuation: Continuation; dispatchKey: string }
  /** No prior dispatch AND the fresh claim was NOT granted (the slot was not `ready`,
   *  or a concurrent controller won the CAS). Nothing was dispatched and no state was
   *  written; the caller re-observes/retries per F14. `continuation` is the row as it
   *  stands (or undefined if it never existed). */
  | { disposition: "unclaimable"; continuation: Continuation | undefined; dispatchKey: string };

/**
 * THE F17 ADOPTION ENTRY-POINT — the single call a consumer makes on recovery to
 * ADOPT an existing dispatch rather than re-dispatch it. It is the F17 contract as a
 * real function, not a comment: derive the deterministic `dispatch_key` from the
 * identity, and —
 *
 *   • if a continuation already carries that receipt (it was claimed — dispatch_key
 *     is written at claim time, BEFORE any physical dispatch, so `dispatching`,
 *     `advanced`, and `blocked` all carry it) → return `disposition:'adopt'` with the
 *     existing row. The caller looks up the already-created run keyed on the receipt
 *     and continues; it does NOT dispatch again. A re-derived key COLLIDES with the
 *     existing dispatch instead of duplicating it.
 *   • else (no prior dispatch, dispatch_key is null) → grant a FRESH claim from
 *     `ready` via the phase-bound CAS. `disposition:'claim'` on grant,
 *     `disposition:'unclaimable'` when the slot is not claimable / the CAS was lost.
 *
 * The lookup and the conditional claim run in ONE immediate transaction so a fresh
 * claim is granted ONLY when the read still shows no prior dispatch (write rule,
 * FG-548). Lease TAKEOVER of an already-adopted dispatch (F16 — becoming the owner to
 * finish/advance a crashed claim) is a SEPARATE, explicit call the consumer makes
 * after deciding to adopt: claimContinuationDispatch with expectedState:'dispatching'.
 *
 * MECHANISM vs CONSUMER (auditable boundary — ticket non-scope). This primitive
 * supplies the adoption MECHANISM (the deterministic receipt + this lookup); the
 * CONSUMER (orchestrator FG-563 / campaign FG-564) performs the physical
 * check-before-spawn — keying run-creation on `dispatchKey` and looking up an
 * already-created run before it re-dispatches. No production dispatcher lives here.
 */
export function adoptOrClaimDispatch(req: AdoptOrClaimRequest): AdoptOrClaimOutcome {
  return writeTransaction((): AdoptOrClaimOutcome => {
    const canonical = canonicalizeAction(req.nextAction);
    const dispatchKey = deriveDispatchKey(req.continuationId, req.sourceLaunchId, canonical);
    const existing = continuationByDispatchKey(dispatchKey);
    if (existing) {
      // The receipt binds (continuationId + sourceLaunchId + canonical nextAction)
      // but NOT consumerKind or currentPhase — so a receipt can collide across a
      // wrong consumer/phase presenting the same three. Adopt ONLY when the row
      // matches the COMPLETE phase-bound identity; any mismatch FAILS CLOSED as
      // unclaimable and writes nothing — never signalling adopt/dispatch on a stale
      // or wrong-identity request.
      const identityMatches =
        existing.continuationId === req.continuationId &&
        existing.sourceLaunchId === req.sourceLaunchId &&
        existing.consumerKind === req.consumerKind &&
        existing.currentPhase === req.currentPhase &&
        canonicalizeAction(existing.nextAction) === canonical;
      if (identityMatches) {
        return { disposition: "adopt", continuation: existing, dispatchKey };
      }
      return { disposition: "unclaimable", continuation: existing, dispatchKey };
    }
    const outcome = claimContinuationDispatch({ ...req, expectedState: "ready" });
    if (outcome.granted) {
      return { disposition: "claim", continuation: outcome.continuation, dispatchKey: outcome.dispatchKey };
    }
    return { disposition: "unclaimable", continuation: outcome.continuation, dispatchKey };
  });
}

/** Renew OUR live claim lease across a span the dispatch can block in. Scoped to
 *  (continuation_id, owner, state='dispatching'); returns false when the row is no
 *  longer ours (a takeover already stepped past us), so the caller FAILS CLOSED. */
export function renewClaim(continuationId: string, owner: string, leaseTtlMs: number): boolean {
  return writeTransaction((): boolean => {
    const res = getDb()
      .prepare(
        `UPDATE continuations SET claim_expires_at = ?, updated_at = ?
          WHERE continuation_id = ? AND claim_owner = ? AND state = 'dispatching'`,
      )
      .run(storeNowMs() + leaseTtlMs, nowIso(storeNowMs()), continuationId, owner);
    return res.changes > 0;
  });
}

/**
 * Record the dispatch result and settle `dispatching -> advanced`, scoped to the
 * claim owner so a taken-over claim can never overwrite the winner's advance. This
 * is the terminal, exactly-once advancement for the step. Returns false when the
 * row is no longer ours (lease was taken over) — the caller must not treat the
 * dispatch as advanced.
 *
 * Dispatch identity is IMMUTABLE: the compare-and-set guard allows a run/task id to
 * be written only when its column is NULL or already EQUALS the supplied value. A
 * DIFFERENT id conflicting with a recorded one matches nothing (changes === 0) —
 * the operation fails and writes NO column (id/state/updated_at), so a stale caller
 * can never advance the step under a rewritten identity.
 */
export function markAdvanced(
  continuationId: string,
  owner: string,
  ids: { runId?: string; taskId?: string } = {},
): boolean {
  return writeTransaction((): boolean => {
    const res = getDb()
      .prepare(
        `UPDATE continuations
            SET state = 'advanced',
                dispatched_run_id = COALESCE(?, dispatched_run_id),
                dispatched_task_id = COALESCE(?, dispatched_task_id),
                updated_at = ?
          WHERE continuation_id = ? AND claim_owner = ? AND state = 'dispatching'
            AND (? IS NULL OR dispatched_run_id IS NULL OR dispatched_run_id = ?)
            AND (? IS NULL OR dispatched_task_id IS NULL OR dispatched_task_id = ?)`,
      )
      .run(
        ids.runId ?? null,
        ids.taskId ?? null,
        nowIso(storeNowMs()),
        continuationId,
        owner,
        ids.runId ?? null,
        ids.runId ?? null,
        ids.taskId ?? null,
        ids.taskId ?? null,
      );
    return res.changes > 0;
  });
}

/**
 * Record the run/task ids the claim dispatched, WITHOUT advancing — the crash
 * window F17 closes: the ids are written after dispatch, before the settling
 * advance, so a recovery that finds a dispatch_key but no ids knows a dispatch was
 * issued under that key and adopts it rather than duplicating. Scoped to the owner.
 *
 * Dispatch identity is IMMUTABLE (same compare-and-set guard as markAdvanced): a
 * previously-recorded run/task id is never overwritten by a DIFFERENT value —
 * re-recording the SAME id is idempotently successful, filling a NULL slot is
 * allowed, but a conflicting id fails and writes nothing.
 */
export function recordDispatchResult(
  continuationId: string,
  owner: string,
  ids: { runId?: string; taskId?: string },
): boolean {
  return writeTransaction((): boolean => {
    const res = getDb()
      .prepare(
        `UPDATE continuations
            SET dispatched_run_id = COALESCE(?, dispatched_run_id),
                dispatched_task_id = COALESCE(?, dispatched_task_id),
                updated_at = ?
          WHERE continuation_id = ? AND claim_owner = ? AND state = 'dispatching'
            AND (? IS NULL OR dispatched_run_id IS NULL OR dispatched_run_id = ?)
            AND (? IS NULL OR dispatched_task_id IS NULL OR dispatched_task_id = ?)`,
      )
      .run(
        ids.runId ?? null,
        ids.taskId ?? null,
        nowIso(storeNowMs()),
        continuationId,
        owner,
        ids.runId ?? null,
        ids.runId ?? null,
        ids.taskId ?? null,
        ids.taskId ?? null,
      );
    return res.changes > 0;
  });
}

/**
 * Mark a claim `blocked` — the claim-to-dispatch window could not be completed and
 * the transition must remain VISIBLE, never silently gone (F16). Scoped to the
 * owner; a `blocked` row is recoverable by an operator or a later reconciler. The
 * dispatch_key stays set, so a recovery still adopts the original receipt.
 */
export function markBlocked(continuationId: string, owner: string): boolean {
  return writeTransaction((): boolean => {
    const res = getDb()
      .prepare(
        `UPDATE continuations SET state = 'blocked', updated_at = ?
          WHERE continuation_id = ? AND claim_owner = ? AND state = 'dispatching'`,
      )
      .run(nowIso(storeNowMs()), continuationId, owner);
    return res.changes > 0;
  });
}
