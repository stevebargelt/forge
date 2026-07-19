// FG-562 (BD-5): the durable continuation-claim primitive.
//
// A controller that observes a launch reaching a terminal disposition must
// advance the workflow's next action EXACTLY ONCE, even though completion events
// are delivered at-least-once (duplicated, delayed, or lost). This module is the
// durable claim that makes advancement idempotent: the controller reads the
// authoritative launch record (readLaunch/classifyExit — the canonical terminal
// vocabulary, BD-10), records the observed disposition here, then claims the
// single `awaiting_completion|ready -> dispatching` transition through a
// PHASE-BOUND compare-and-set. The grant is `changes === 1`; a lost/stale/racing
// claim writes NO state.
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
import type { LaunchStatus } from "../v2/launch.js";

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
// as BD-3 evidence when the controller wakes; owner_gone/unknown are legitimate
// dispositions with NO exit record and must remain recordable/claimable.
export type ObservedStatus = LaunchStatus["state"];

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
 * Record the canonical disposition the controller observed on wake (BD-3
 * evidence), and move `awaiting_completion -> ready` when that disposition is
 * terminal. This NEVER reads or fabricates an exit file — the controller passes
 * the state readLaunch/classifyExit already returned, INCLUDING owner_gone/unknown
 * (legitimate terminal dispositions with NO exit record). Recording evidence is
 * NOT the claim: a stale/duplicate observation is recorded and then IGNORED by the
 * phase-bound CAS below.
 *
 * A pure record: it advances state to `ready` only from `awaiting_completion`, so
 * observing a launch again after a claim/advance updates the evidence without
 * disturbing the claim.
 */
export function observeLaunchStatus(
  continuationId: string,
  status: ObservedStatus,
  opts: { terminal: boolean },
): Continuation | undefined {
  return writeTransaction((): Continuation | undefined => {
    const db = getDb();
    const iso = nowIso(storeNowMs());
    if (opts.terminal) {
      db.prepare(
        `UPDATE continuations
            SET last_observed_status = ?,
                state = CASE WHEN state = 'awaiting_completion' THEN 'ready' ELSE state END,
                updated_at = ?
          WHERE continuation_id = ?`,
      ).run(status, iso, continuationId);
    } else {
      db.prepare(
        `UPDATE continuations SET last_observed_status = ?, updated_at = ? WHERE continuation_id = ?`,
      ).run(status, iso, continuationId);
    }
    return getContinuation(continuationId);
  });
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
  // The prior state the caller expects. A FRESH claim expects 'awaiting_completion'
  // or 'ready' (claim_owner IS NULL). An expired-lease RECOVERY (F16) expects
  // 'dispatching' and grants only when the lease is strictly in the past.
  expectedState: Extract<ContinuationState, "awaiting_completion" | "ready" | "dispatching">;
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
 * any dispatch — so a recovery after the claim-to-dispatch crash adopts the same
 * receipt (F17). The takeover path (expectedState='dispatching', lease expired)
 * recomputes the IDENTICAL key, so a taken-over dispatch is idempotent too.
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
          WHERE continuation_id = ? AND claim_owner = ? AND state = 'dispatching'`,
      )
      .run(ids.runId ?? null, ids.taskId ?? null, nowIso(storeNowMs()), continuationId, owner);
    return res.changes > 0;
  });
}

/**
 * Record the run/task ids the claim dispatched, WITHOUT advancing — the crash
 * window F17 closes: the ids are written after dispatch, before the settling
 * advance, so a recovery that finds a dispatch_key but no ids knows a dispatch was
 * issued under that key and adopts it rather than duplicating. Scoped to the owner.
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
          WHERE continuation_id = ? AND claim_owner = ? AND state = 'dispatching'`,
      )
      .run(ids.runId ?? null, ids.taskId ?? null, nowIso(storeNowMs()), continuationId, owner);
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
