// FG-425 (AD-2): ONE FIFO integration lane per canonical project identity.
//
// TWO AUTHORITIES, DELIBERATELY NOT COLLAPSED:
//   - ORDERING (this file): who goes NEXT. Derived from the DURABLE enqueue key
//     assigned when the publication request was RECORDED — before any contention.
//     "Take a file lock and hope" is rejected outright: OS lock grants are
//     unordered, so lock-acquisition order can never be FIFO evidence.
//   - MUTUAL EXCLUSION (publication-target via the publisher's short mutex): who
//     is INSIDE the CAS window right now.
//
// LEASE, NOT STALENESS-WINDOW. Lane ownership is a renewable durable lease.
// Explicitly NOT liveRunLockHolder (src/util/run-lock.ts:119-123) or any fixed
// staleness rule: that reports "no holder" once a lock exceeds DEFAULT_STALE_MS
// (1h) EVEN WHEN the owning pid is alive — which would declare a legitimately
// long-waiting queued run abandoned and admit a SECOND concurrent publisher.
// Here, waiting is never evidence of abandonment: every entry (queued OR
// holding) carries an owner-written expiry, a live waiter renews it on its own
// poll tick and is therefore never evictable, and a takeover is permitted ONLY
// when the recorded expiry is genuinely in the past.
//
// WHY RENEWAL IS INLINE AND NOT ON A TIMER: runIntegrationGate is a SYNCHRONOUS
// execFileSync (integration-gate.ts) that blocks the event loop for the whole
// test-suite run. A setInterval heartbeat cannot fire during it, so a naive
// timer lease would let the HOLDER self-expire mid-gate and be taken over.
// Waiters therefore renew inline on their poll tick, and the holder PRE-EXTENDS
// its lease across the declared gate span using the gate's OWN configurable
// timeout (integrationGateTimeoutMs) as the ceiling — never a duplicated literal.
//
// AD-7 IS BINDING: takeover NEVER signals, probes, reaps, or classifies liveness.
// No PID checks, no process-group probes, no "confirm it is really dead" logic.
// A lease is a durable timestamp the owner refreshes — that is not process
// supervision. See the ADR for why the lane is ALLOWED to be approximate.

import {
  laneTick,
  extendLaneLease,
  releaseLaneEntry,
  type LaneEntry,
  type LaneState,
} from "../store/publications.js";
import { integrationGateTimeoutMs } from "./integration-gate.js";
import { describeWait } from "./project-identity.js";

/** Base lease TTL. Comfortably longer than a poll tick, so an ordinary scheduling
 *  hiccup can never expire a live owner. */
export const LANE_BASE_TTL_MS = 90_000;

/** Poll cadence for a waiter. Every tick renews our own lease (see above). */
export const LANE_POLL_MS = 12_000;

/** The lease a holder must carry across the synchronous gate: the gate's own
 *  ceiling plus a margin for process startup and result handling. Read from
 *  integration-gate.ts so raising FORGE_INTEGRATION_GATE_TIMEOUT_MS cannot
 *  silently desync the lease from the thing it is covering. */
export function gateSpanLeaseMs(): number {
  return integrationGateTimeoutMs() + 60_000;
}

/** Our lane entry was taken over by a later attempt while we were still alive: a
 *  span we blocked in outlived our lease. TERMINAL and NAMED — the owner parks
 *  with `lane_taken_over` rather than throwing a TypeError or waiting for a turn
 *  it can no longer be given. Nothing is signalled, probed, or reaped (AD-7). */
export class LaneTakenOverError extends Error {
  readonly reason = "lane_taken_over" as const;
  constructor(public readonly attemptId: string, canonicalDir: string) {
    super(
      `publication lane: attempt ${attemptId} was taken over on ${canonicalDir} — its lease lapsed and a later ` +
        `attempt claimed the lane. Nothing was published by this attempt. It is terminal; a retry enqueues a new ` +
        `attempt with a fresh worktree (AD-7).`,
    );
    this.name = "LaneTakenOverError";
  }
}

export type LaneWaitOpts = {
  pollMs?: number;
  ttlMs?: number;
  log?: (line: string) => void;
  /** Bounds the wait so a test can assert queueing without hanging forever.
   *  Unset in production: a queued attempt waits as long as the lane needs. */
  maxWaitMs?: number;
};

/** Block until this attempt is at the head of its project's lane.
 *
 *  Renews our lease on every tick (inline — see the header). Emits the salvaged
 *  operator-visible waiting line so a queued forge never looks like a hung one.
 *
 *  Throws LaneTakenOverError if our entry went terminal underneath us. It never
 *  loops on an entry it cannot win, and it never dereferences a head that isn't
 *  there. */
export async function awaitLaneTurn(
  attemptId: string,
  canonicalDir: string,
  opts?: LaneWaitOpts,
): Promise<LaneEntry> {
  const pollMs = opts?.pollMs ?? LANE_POLL_MS;
  const ttlMs = opts?.ttlMs ?? LANE_BASE_TTL_MS;
  const log = opts?.log ?? ((line: string) => console.log(line));
  const startedAt = Date.now();
  let lastReportMs = -Infinity;

  for (;;) {
    const turn = laneTick(attemptId, ttlMs);
    if (turn.ready) return turn.entry;
    if (turn.takenOver) throw new LaneTakenOverError(attemptId, canonicalDir);

    const elapsedMs = Date.now() - startedAt;
    if (opts?.maxWaitMs !== undefined && elapsedMs >= opts.maxWaitMs) {
      throw new Error(
        `publication lane wait exceeded ${opts.maxWaitMs}ms on ${canonicalDir} — ` +
          `held by run ${turn.holder.runId} (attempt ${turn.holder.attemptId})`,
      );
    }
    if (elapsedMs - lastReportMs >= 10_000) {
      lastReportMs = elapsedMs;
      log(
        describeWait({
          what: "lane",
          canonicalDir,
          holderRunId: turn.holder.runId,
          holderAttemptId: turn.holder.attemptId,
          elapsedMs,
          position: turn.ahead,
        }),
      );
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

/** Cover a declared SYNCHRONOUS span (the gate) with a lease long enough that the
 *  holder cannot self-expire inside it. Call immediately before the blocking
 *  call; the next laneTick/renewal resets the TTL to normal. */
export function preExtendLeaseForGate(attemptId: string): void {
  extendLaneLease(attemptId, gateSpanLeaseMs());
}

/** Renew our lease. Returns false when we NO LONGER OWN an active lane entry — a
 *  later attempt found our lease lapsed and took the lane over while we were in a
 *  span we could not renew across. A caller about to do anything that touches the
 *  target must fail closed on that (LaneTakenOverError); a caller that is merely
 *  keeping the lease warm (the heartbeat) can ignore it, because the load-bearing
 *  check is the one the window makes. */
export function renewLease(attemptId: string, ttlMs: number = LANE_BASE_TTL_MS): boolean {
  return extendLaneLease(attemptId, ttlMs);
}

/** Renew cadence for the heartbeat below: comfortably inside LANE_BASE_TTL_MS, so
 *  several ticks may be missed before a lease could ever lapse. */
export const LANE_HEARTBEAT_MS = 20_000;

/** THE RULE: the owner's lease must be renewed across EVERY span it can block in
 *  — not just the ones we happened to think of. A holder whose lease lapses is
 *  taken over by a later attempt, which is exactly the FIFO break the lease exists
 *  to prevent; leaving a single un-renewed blocking span reintroduces it one span
 *  further along.
 *
 *  Two mechanisms, because there are two kinds of blocking span and neither
 *  mechanism covers both:
 *
 *    - ASYNC spans (awaiting reds, polling for the publication mutex, awaiting a
 *      lane turn): the event loop is free, so a timer CAN fire. That's this
 *      heartbeat.
 *    - SYNCHRONOUS spans (runIntegrationGate is an execFileSync that blocks the
 *      event loop for the whole test-suite run): NO timer can fire inside one. A
 *      heartbeat is useless there, so the span is PRE-EXTENDED instead, using the
 *      gate's own timeout as the ceiling (preExtendLeaseForGate).
 *
 *  Validation is both — an async red dispatch wrapped around a synchronous gate —
 *  so it gets both. */
export function startLeaseHeartbeat(attemptId: string, everyMs: number = LANE_HEARTBEAT_MS): { stop: () => void } {
  const timer = setInterval(() => renewLease(attemptId), everyMs);
  // Never hold the process open on the publisher's account.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function leaveLane(attemptId: string, state: Extract<LaneState, "done" | "abandoned"> = "done"): void {
  releaseLaneEntry(attemptId, state);
}
