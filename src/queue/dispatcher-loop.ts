// FG-591 (step 8): THE LONG-LIVED DISPATCHER — the durable progress engine the
// ticket's binding controller requirement demands.
//
// Steps 6 and 7 shipped a DECISION (runDispatchCycle) and an EXECUTION LIFECYCLE
// (launch / adopt / heartbeat / reconcile / release). Neither owns a process, and
// neither can answer the question the ticket's live reproduction is about: the
// interactive orchestrator went away, the first ticket finished, and the second one
// never started because nothing was left running to notice. This module is what is
// left running.
//
// ─── WHAT MAKES IT A CONTROLLER RATHER THAN A POLLER ─────────────────────────
// Three durable facts, none of them a process:
//
//   THE IDENTITY   dispatcher_leases. An instance-stable owner with a fenced
//                  generation. A restart ADOPTS its own identity (the policy
//                  module's `renewed` mode) instead of waiting out its own lease or
//                  starting a second dispatcher beside itself. A different owner's
//                  lease can only be taken over after STRICT expiry.
//   THE SIGNAL     dispatcher_wakes. A durable, at-least-once, idempotent record of
//                  "something changed; look again", consumed by compare-and-set. A
//                  restart cannot lose one and a duplicate is harmless by
//                  construction — which is what lets the loop be event-driven at all
//                  in a system with no IPC between forge processes.
//   THE EVIDENCE   dispatcher_evaluations. Every tick runs exactly one dispatch
//                  cycle, and every pass of that cycle writes a row — including the
//                  passes that granted nothing.
//
// The wake POLL (a short read of pending wakes) is how a durable record is
// DELIVERED, not what makes the system correct: a missed poll loses nothing, because
// the record persists until it is consumed. The WATCHDOG is a low-frequency HEALTH
// bound on the case where no wake was ever recorded — a signal nobody wrote, a
// dispatcher that died mid-tick, an observation this process never got to make. It
// is deliberately not sized from any estimate of how long a ticket takes, and it is
// never the only thing standing between a finished run and the next one starting.
//
// ─── THE TICK, AND WHY ITS ORDER IS THE SAFETY ARGUMENT ──────────────────────
//   1. IDENTITY FIRST. Renew or adopt the dispatcher lease. If a DIFFERENT live
//      owner holds it we are not the dispatcher: we claim nothing, we heartbeat
//      nothing, and we stop LOUDLY. Continuing to renew our claim leases while not
//      driving them would keep them alive under a dispatcher that has stopped
//      deciding — the successor could never take them over, and the work under them
//      would be stranded rather than adopted.
//   2. CONSUME THE WAKES. Compare-and-set, so two dispatchers partition them.
//   3. HEARTBEAT THE CLAIMS WE HOLD, on the policy cadence and REGARDLESS of the
//      armed flag (D5). A disarmed dispatcher keeps its existing leases alive; a
//      lease that lapses over a running container invites a takeover and a duplicate.
//   4. RECONCILE. Bind the run each launch created; retire the reservation once its
//      EXECUTION is terminal. This is where a finished run frees a capacity slot, and
//      it happens BEFORE the cycle so the same tick can refill it.
//   5. DECIDE AND LAUNCH. One dispatch cycle, then one launch per grant.
//
// Steps 3, 4 and 5 are skipped entirely when step 1 says we are not the dispatcher.
// Step 3 is NOT skipped when dispatch is disarmed, and step 5's cycle still runs and
// still records `disabled` — "the operator turned it off" is the single most useful
// answer to "why is nothing running" and the only one otherwise invisible.
//
// ─── PHYSICAL LIVENESS IS NOT A PROCESS TREE (THE TICKET'S REPRODUCTION) ─────
// Nothing here keys off a pid, a parent process or an interactive session. A claimed
// ticket is launched through step 7's tmux-owned ownership transfer, so the container
// outlives this loop; and if this loop dies, its claim leases lapse and a successor
// takes them over and ADOPTS the launch rather than starting a second container. The
// recorded pid on the lease row is operator output and authorizes nothing.
//
// ─── D9: NOTHING HERE AUTO-RESTARTS ──────────────────────────────────────────
// This module has no supervisor, no relaunch-on-exit and no login-agent install. A
// host reboot leaves the dispatcher DOWN, its lease strictly expired, and every
// operator surface saying so out loud (dispatcherHealth below). That is a deliberate
// choice: a dispatcher that silently resurrects itself after a reboot is authority to
// run repo-writing containers unattended that no operator granted at that moment.
//
// ─── THE CLOCK RULE ──────────────────────────────────────────────────────────
// Every deadline compared here — the watchdog, the lease renewal cadence, the claim
// heartbeat cadence — is read from the STORE's clock (storeNowMs). A loop pacing
// itself by a process clock would disagree with the leases it is renewing on any host
// whose clock has been stepped, and the disagreement only shows up as a self-inflicted
// takeover. The sleep BETWEEN ticks is the one exception and is honestly one: it paces
// a process, it decides nothing, and it is a seam.

import { getDb } from "../store/db.js";
import { storeNowMs } from "../store/publications.js";
import { dequeueTicket, QueueRefusal } from "../store/queue.js";
import { liveClaims, type QueueClaim } from "../store/queue-claims.js";
import {
  acquireDispatcherLease,
  dispatcherLeaseView,
  getDispatcherPolicy,
  renewDispatcherLease,
  releaseDispatcherLease,
  type DispatcherLease,
  type DispatcherLeaseView,
  type DispatcherPolicy,
} from "../store/dispatcher-policy.js";
import {
  claimWakes,
  latestEvaluation,
  nextWatchdogDeadlineMs,
  pendingWakeCount,
  recordWake,
  type DispatcherEvaluation,
  type DispatcherWake,
} from "../store/dispatcher-evidence.js";
import { getRun } from "../store/runs.js";
import { runDispatchCycle, type DispatchCycleResult } from "./dispatch-cycle.js";
import {
  discoverRunForClaim,
  heartbeatOwnedClaims,
  observeClaimExecution,
  reconcileClaimExecution,
  launchClaimedTicket,
  type ExecutionSeams,
  type HeartbeatResult,
  type LaunchClaimResult,
} from "./dispatch-execution.js";

// ─── bounds ──────────────────────────────────────────────────────────────────

/** THE HEALTH BOUND, not a schedule. Five minutes is short enough that a lost
 *  signal costs one cycle rather than an afternoon, and long enough that an idle
 *  dispatcher is not a continuous writer on the machine-wide store. It is
 *  deliberately NOT derived from how long a ticket takes: the watchdog does not
 *  estimate work, it bounds the failure of the signal path. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/** A floor under the watchdog, refused by name. Below this the "low-frequency health
 *  bound" becomes the primary mechanism by volume, which is the shape the AC forbids:
 *  a tick writes an evaluation row and takes the machine-wide write lock to do it. */
export const MIN_WATCHDOG_INTERVAL_MS = 10_000;

/** How often the loop LOOKS for durable wakes while otherwise idle. This is the
 *  delivery cadence of an at-least-once record, not the correctness mechanism: a
 *  poll that is missed, slow or suppressed loses nothing, because the wake row
 *  persists until it is consumed. */
export const DEFAULT_WAKE_POLL_MS = 2_000;

/** The env var naming THIS dispatcher instance. */
export const DISPATCHER_ID_ENV = "FORGE_DISPATCHER_ID";

// ─── identity ────────────────────────────────────────────────────────────────

/**
 * THE INSTANCE-STABLE DISPATCHER OWNER, resolved the way campaign.ts resolves a
 * campaign-controller owner and refusing for the same reason.
 *
 * A HOST-STABLE value (a hostname, a path) is deliberately NOT acceptable: it cannot
 * fence a same-host peer, so two dispatchers started on one machine would both read
 * as "the same owner", both renew the same lease and both decide. A caller-supplied
 * string cannot prove identity either — which is exactly why it is the OPERATOR's
 * declaration, made once per dispatcher instance and kept ACROSS RESTARTS. That
 * stability is what makes restart adoption possible at all: a successor carrying the
 * same declared id re-adopts its own lease and its own claims instead of waiting out
 * its own expiry and taking over from itself.
 *
 * The consequence, stated rather than hidden: two processes given the SAME id are ONE
 * identity by declaration, and this module cannot tell them apart. Duplicate
 * EXECUTION is still prevented where it must be — idx_queue_claims_live and the
 * ceiling counted inside claimNextEligible's write transaction — so the cost of that
 * operator error is bounded to a redundant decider, not a duplicated container.
 */
export function resolveDispatcherOwner(
  projectKey: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; owner: string } | { ok: false; error: string } {
  const instanceId = env[DISPATCHER_ID_ENV]?.trim();
  if (!instanceId) {
    return {
      ok: false,
      error:
        `no stable dispatcher identity resolved — refusing to acquire or renew a dispatcher lease. ` +
        `A host-stable owner (a hostname) cannot fence a same-host peer, and an anonymous owner cannot ` +
        `be fenced at all, so a restart could neither adopt its own lease nor be told apart from a ` +
        `second dispatcher. Set ${DISPATCHER_ID_ENV} to this dispatcher instance's stable identity and ` +
        `keep it stable across restarts of the same instance.`,
    };
  }
  return { ok: true, owner: `dispatcher@${projectKey}@${instanceId}` };
}

// ─── seams ───────────────────────────────────────────────────────────────────

export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type DispatcherLoopSeams = {
  /** Paces the process between ticks. Decides nothing. */
  sleep?: SleepFn;
  /** Passed straight through to step 7 — the tmux/subprocess boundary. */
  execution?: ExecutionSeams;
  /**
   * THE PRIMARY WAKE OBSERVER. Defaults to observeRunTerminalWakes, which turns a
   * terminal execution under one of OUR claims into a durable `run_terminal` wake.
   *
   * It is a seam because FG-591's required falsification needs to SUPPRESS the primary
   * signal and prove the watchdog still recovers the work exactly once. Suppressing it
   * is a legitimate configuration of the system, not a mock of it: the wake path and
   * the watchdog path are two independent mechanisms, and the ticket asks for evidence
   * that the second one alone is sufficient.
   */
  observeWakes?: (input: { projectKey: string; owner: string; seen: Set<string> }) => DispatcherWake[];
  /** Called after every executed tick — the CLI's progress output, a test's probe. */
  onTick?: (tick: DispatcherTick) => void;
};

// ─── the primary wake observer ───────────────────────────────────────────────

/** The wake key for a claim whose EXECUTION reached a terminal state. Keyed by the
 *  subject that changed (the run, or the reservation when no run was ever bound) so
 *  two processes observing the same transition produce the SAME key and the store
 *  collapses them. Never a timestamp, never a nonce. */
function terminalWakeKey(claim: QueueClaim, runId?: string | null): string {
  const bound = runId ?? claim.runId;
  return bound !== null && bound !== undefined ? `run:${bound}` : `claim:${claim.id}`;
}

/** Mirrors dispatch-execution's private set, and watch.ts / ops-detect / ops-repair
 *  before it. Copied rather than exported across a module boundary for the same reason
 *  they were: it is the RUN vocabulary, owned by the run store, and three call sites
 *  reading three literals is how this repo already spells it. */
const RUN_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["complete", "failed", "abandoned"]);

/** The EXECUTION half for one reservation, whether or not the reservation has caught
 *  up with it. A claim carries its run id only once a tick has RECONCILED it, so an
 *  observer that looked only at the bound id could never see the very first terminal
 *  transition — the wake path would depend on the tick it is supposed to trigger.
 *  Discovery here is step 7's own durable-evidence discovery, reused rather than
 *  re-derived; nothing is written and nothing is bound. */
function terminalRunFor(claim: QueueClaim): { runId: string; status: string } | null {
  const runId =
    claim.runId ?? (claim.launchId === null ? null : discoveredRunId(discoverRunForClaim(claim)));
  if (runId === null) return null;
  const run = getRun(runId);
  if (!run || !RUN_TERMINAL_STATUSES.has(run.status)) return null;
  return { runId, status: run.status };
}

function discoveredRunId(discovery: ReturnType<typeof discoverRunForClaim>): string | null {
  return discovery.kind === "found" ? discovery.runId : null;
}

/**
 * Turn a terminal execution under one of our own claims into a DURABLE wake.
 *
 * This is the loop's own observation of the run-terminal transition the AC names. It
 * is a read over the claims this owner holds — a handful of rows bounded by the
 * ceiling, not a scan of the queue — and it WRITES only when a transition is seen for
 * the first time.
 *
 * `seen` is in-process dedup, and is deliberately not durable: a wake that was
 * consumed while its claim could not be retired (the fence refused) would otherwise be
 * re-recorded on every poll, turning a stuck reservation into a continuous writer.
 * Losing the set on restart is harmless — the transition is re-observed and the wake
 * is recorded again, which is the at-least-once contract working as intended.
 */
export function observeRunTerminalWakes(input: {
  projectKey: string;
  owner: string;
  seen?: Set<string>;
}): DispatcherWake[] {
  const seen = input.seen;
  const recorded: DispatcherWake[] = [];
  for (const claim of liveClaims(input.projectKey)) {
    if (claim.owner !== input.owner) continue;
    const terminalRun = terminalRunFor(claim);
    // A reservation with no discoverable run is not evidence that nothing ran (step 7
    // is explicit about that window), so it is observed as "nothing to report" rather
    // than as a terminal transition. observeClaimExecution is what the tick uses to
    // decide the reservation's fate; this is only the signal.
    const key = terminalWakeKey(claim, terminalRun?.runId ?? null);
    if (seen?.has(key)) continue;
    if (terminalRun === null) {
      const view = observeClaimExecution({ projectKey: input.projectKey, claimId: claim.id });
      if (view.verdict.kind !== "terminal") continue;
      seen?.add(key);
      recorded.push(
        recordWake({
          projectKey: input.projectKey,
          kind: "run_terminal",
          wakeKey: key,
          detail: `${claim.ticketId}: ${view.verdict.detail}`,
        }),
      );
      continue;
    }
    seen?.add(key);
    recorded.push(
      recordWake({
        projectKey: input.projectKey,
        kind: "run_terminal",
        wakeKey: key,
        detail: `${claim.ticketId}: run ${terminalRun.runId} is ${terminalRun.status}`,
      }),
    );
  }
  return recorded;
}

// ─── retiring the PLANNING intent once the work has actually run ─────────────
//
// A DECISION THIS STEP HAD TO MAKE, stated here rather than discovered later.
//
// Releasing a reservation does NOT change the ticket. A completed run leaves the
// ticket `active` (closeout is the orchestrator's job after merge), still ranked and
// still a queue member — so the very next scan finds it at the top of the canonical
// order and claims it again. Composing steps 6 and 7 without an answer here is an
// unattended re-launch loop over the same ticket: the ceiling is respected, no
// invariant is violated, and the same work runs forever.
//
// The answer is that queue membership is PLANNING INTENT — "run this next" — and that
// intent is SATISFIED once the work it asked for actually ran and ended. So a
// reservation retired on a terminal EXECUTION also retires the ticket's queue
// membership, and nothing else:
//   * the RANK is untouched (dequeueTicket retains it, `rankRetained: true`), so
//     re-enqueueing returns the item to exactly the position the operator gave it;
//   * the ticket's lifecycle status is untouched — nothing here writes `done`, and
//     Done stays derived;
//   * a durable `dequeue` queue event records it, so the board can show WHY an item
//     left the queue rather than having it silently vanish.
//
// `failed` retires the membership as well as `completed`, deliberately: an unattended
// dispatcher that re-claims a ticket whose run just failed is an infinite retry loop
// against a failing ticket, and "look at it, then put it back" is the operator act
// that is missing there. `launch_failed` is NOT in this set — step 7 states that a
// reservation which never started a container leaves its ticket immediately
// re-claimable, and it releases on that path itself, never through this one.
//
// This is the ONE queue mutation the dispatcher makes. It never ranks, never
// reorders, never defers and never enqueues.
const MEMBERSHIP_RETIRING_OUTCOMES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

// ─── the tick ────────────────────────────────────────────────────────────────

export type TickTrigger =
  | "startup"
  | "wake"
  | "watchdog"
  /** A FOLLOW-UP to a tick that launched. Step 6 states the shape and why: a claim
   *  that has just been granted has recorded no launch and no run yet, so
   *  compatibility reports its workspace lane as `unknown` and refuses every later
   *  candidate in the same repository. That refusal clears as soon as the launch is
   *  stamped and its run binds, which the NEXT tick's reconcile does. Without this
   *  follow-up the remaining capacity is filled by the watchdog — the health bound
   *  doing a signal's job, which is exactly what the AC forbids. It is bounded: a
   *  follow-up re-arms only if it launched something itself, and every launch consumes
   *  a slot, so it terminates at the ceiling. */
  | "refill";

export type DispatcherIdentityState =
  | { held: true; lease: DispatcherLease; mode: "created" | "renewed" | "took_over"; alert: null }
  /** A DIFFERENT owner holds a live lease, or our own generation was superseded. We
   *  are not the dispatcher; nothing is claimed and nothing is renewed. */
  | { held: false; lease: DispatcherLease | null; mode: null; alert: string };

/** One released reservation, and whether the EVENT path or the WATCHDOG found it. */
export type ReconciledClaim = {
  claimId: string;
  ticketId: string;
  runId: string | null;
  /** The run this pass bound to the claim, if any. */
  bound: string | null;
  outcome: string | null;
  released: boolean;
  releaseRefused: string | null;
  /** True when NO delivered wake announced this terminal reservation — the event path
   *  did not deliver and a non-event look (the watchdog, a refill follow-up, a
   *  restart's first tick) is what found it. The durable record of that is the
   *  `recovery` wake named below; this flag is its in-memory twin. */
  recoveredWithoutWake: boolean;
  /** The durable lost-signal record written for a watchdog recovery. Exactly one per
   *  claim, because a claim is released exactly once. */
  recoveryWakeId: number | null;
  /** Whether this pass retired the ticket's QUEUE MEMBERSHIP (rank retained), and why
   *  not when it did not. See MEMBERSHIP_RETIRING_OUTCOMES. */
  membershipRetired: boolean;
  membershipNote: string | null;
};

export type DispatcherTick = {
  projectKey: string;
  owner: string;
  trigger: TickTrigger;
  nowMs: number;
  policy: DispatcherPolicy;
  identity: DispatcherIdentityState;
  /** The wakes this tick consumed (compare-and-set), in delivery order. */
  wakes: DispatcherWake[];
  heartbeats: HeartbeatResult[];
  /** Claims whose lease renewal was REFUSED — superseded or lapsed. We have lost
   *  them; a successor recovers them by takeover and adopts their launch. */
  lostClaims: HeartbeatResult[];
  reconciled: ReconciledClaim[];
  cycle: DispatchCycleResult | null;
  launches: LaunchClaimResult[];
  nextWatchdogAtMs: number;
  /** Set when the tick did NOT decide anything, and why. */
  skipped: string | null;
};

export type DispatcherTickInput = {
  projectKey: string;
  owner: string;
  trigger: TickTrigger;
  /** The forge binary argv prefix, exactly as step 7 wants it. Passed in rather than
   *  derived so nothing here reaches for process.argv. */
  forgeBin: readonly string[];
  /** The generation this process last held, so the ordinary path is a RENEWAL of our
   *  own identity rather than a fresh acquisition. Null/absent on the first tick and
   *  after a restart — acquireDispatcherLease then adopts our own lease by owner
   *  match, which is what makes a restart adoption rather than a duplication. */
  generation?: number | null;
  watchdogIntervalMs?: number;
  /** An explicit checkout / workflow for the launch, forwarded verbatim. */
  projectDir?: string | undefined;
  workflow?: string | undefined;
  host?: string;
  pid?: number;
  /** Retire the queue MEMBERSHIP of a ticket whose reservation was retired on a
   *  terminal execution (rank retained). Default true — see
   *  MEMBERSHIP_RETIRING_OUTCOMES for why, and what turning it off costs. */
  retireMembership?: boolean;
  seams?: DispatcherLoopSeams;
};

function requireWatchdogInterval(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < MIN_WATCHDOG_INTERVAL_MS) {
    throw new QueueRefusal(
      `forge: queue dispatcher run refuses — a watchdog interval of ${String(ms)}ms is below the ` +
        `${MIN_WATCHDOG_INTERVAL_MS}ms floor. The watchdog is a low-frequency HEALTH bound on a lost ` +
        `signal; at a shorter interval it becomes the primary mechanism by volume, and every tick takes ` +
        `the machine-wide write lock to record its evaluation. Nothing was started.`,
      "queue dispatcher run",
      null,
    );
  }
  return ms;
}

/**
 * Adopt or create the fenced dispatcher identity.
 *
 * A renewal is attempted first when we already hold a generation, because renewing is
 * the cheap ordinary path and a failed renewal is INFORMATION — it means we were
 * superseded or our lease strictly lapsed, and re-acquiring after that is a takeover
 * decision the store, not this code, is allowed to make.
 */
export function ensureDispatcherIdentity(input: {
  projectKey: string;
  owner: string;
  generation?: number | null;
  policy?: DispatcherPolicy;
  host?: string;
  pid?: number;
}): DispatcherIdentityState {
  const policy = input.policy ?? getDispatcherPolicy(input.projectKey);
  if (input.generation !== undefined && input.generation !== null) {
    const renewed = renewDispatcherLease({
      projectKey: input.projectKey,
      owner: input.owner,
      generation: input.generation,
      ttlMs: policy.leaseTtlMs,
    });
    if (renewed) {
      const lease = dispatcherLeaseView(input.projectKey).lease as DispatcherLease;
      return { held: true, lease, mode: "renewed", alert: null };
    }
  }

  const grant = acquireDispatcherLease({
    projectKey: input.projectKey,
    owner: input.owner,
    ttlMs: policy.leaseTtlMs,
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
  });
  if (grant.granted) return { held: true, lease: grant.lease, mode: grant.mode, alert: null };

  const view = dispatcherLeaseView(input.projectKey);
  return {
    held: false,
    lease: grant.lease,
    mode: null,
    alert:
      `the dispatcher lease for ${input.projectKey} is held by ${grant.lease.owner} at generation ` +
      `${grant.lease.generation}, whose lease is still LIVE (last heartbeat ${view.msSinceHeartbeat ?? "?"}ms ` +
      `ago). This process is NOT the dispatcher: it claims nothing, renews nothing and stops. Waiting is ` +
      `not evidence of abandonment — a takeover is possible only after STRICT expiry, and the successor ` +
      `then adopts the prior launch rather than starting a second container.`,
  };
}

/** Project keys other than this one that have a dispatcher lease row. Direct SQL for
 *  the same reason step 7 reads runs directly: there is no cross-project reader on the
 *  policy module, and inventing a table-shaped abstraction for one SELECT would be
 *  more surface than the query. */
function otherDispatcherProjects(projectKey: string): string[] {
  const rows = getDb()
    .prepare(`SELECT project_key FROM dispatcher_leases WHERE project_key <> ? ORDER BY project_key ASC`)
    .all(projectKey) as { project_key: string }[];
  return rows.map((r) => r.project_key);
}

/**
 * ONE TICK: identity, wakes, heartbeats, reconcile, decide, launch.
 *
 * Exported because it is the honest unit — a caller that wants the dispatcher to look
 * exactly once (a CLI one-shot, a test, the falsification harness) should not have to
 * reason about a sleep loop's termination to get one. The loop below is a thin pacing
 * shell over this function and holds no decision of its own.
 */
export function runDispatcherTick(input: DispatcherTickInput): DispatcherTick {
  const { projectKey, owner, trigger } = input;
  const seams = input.seams ?? {};
  const watchdogIntervalMs = requireWatchdogInterval(input.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
  const retireMembership = input.retireMembership ?? true;
  const policy = getDispatcherPolicy(projectKey);
  const nowMs = storeNowMs();
  const nextWatchdogAtMs = nowMs + watchdogIntervalMs;

  const base = {
    projectKey,
    owner,
    trigger,
    nowMs,
    policy,
    nextWatchdogAtMs,
  };

  // ── 1. IDENTITY. Everything below is skipped when this is not the dispatcher.
  const identity = ensureDispatcherIdentity({
    projectKey,
    owner,
    generation: input.generation ?? null,
    policy,
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
  });
  if (!identity.held) {
    return {
      ...base,
      identity,
      wakes: [],
      heartbeats: [],
      lostClaims: [],
      reconciled: [],
      cycle: null,
      launches: [],
      skipped: identity.alert,
    };
  }
  const generation = identity.lease.generation;

  // ── 2. THE WAKES. Consumed by CAS, so two dispatchers partition them rather than
  // both acting on the same one. Consuming them BEFORE the decision is deliberate: a
  // change that lands mid-tick leaves its own pending wake and gets its own tick,
  // rather than being silently folded into a decision made before it happened.
  const wakes = claimWakes({ projectKey, consumer: owner });
  const consumedKeys = new Set(wakes.map((w) => w.wakeKey));

  // ── 3. THE CLAIM LEASES. On the policy cadence, and NOT gated on `armed` (D5).
  const heartbeats = heartbeatOwnedClaims({ projectKey, owner, policy });
  const lostClaims = heartbeats.filter((h) => !h.renewed);

  // ── 4. RECONCILE. Bind the run each launch created and retire the reservations
  // whose EXECUTION is terminal — before the cycle, so this tick can refill the slot
  // it just freed.
  const reconciled: ReconciledClaim[] = [];
  const mine = liveClaims(projectKey).filter((c) => c.owner === owner);
  for (const claim of mine) {
    const result = reconcileClaimExecution({
      projectKey,
      claimId: claim.id,
      ...(seams.execution !== undefined ? { seams: seams.execution } : {}),
    });
    const released = result.released !== null;
    if (!released && result.bound === null && result.releaseRefused === null) continue;

    // Either spelling of this claim's terminal key counts as "a wake announced it":
    // the observer keys on the RUN as soon as one is discoverable, while a claim that
    // never bound one is keyed by the reservation. Treating a key mismatch as a
    // missing signal would report a healthy event path as a watchdog recovery.
    const runIdNow = result.released?.runId ?? result.bound ?? claim.runId;
    const announced =
      consumedKeys.has(terminalWakeKey(claim, null)) ||
      (runIdNow !== null && consumedKeys.has(terminalWakeKey(claim, runIdNow)));

    // THE LOST-SIGNAL RECORD. A terminal-but-unretired reservation that NO delivered
    // wake announced: the event path did not deliver, and "did the signal get lost"
    // must have an answer that is not transcript archaeology
    // (continuation-lost-signal.ts's rule, applied to this controller).
    //
    // The condition is "no wake announced it", not "the watchdog found it". The
    // watchdog is the bound that guarantees SOMETHING eventually looks, but a refill
    // follow-up or a restart's first tick can get there first, and in every one of
    // those cases the signal was equally lost. Recording only the watchdog's finds
    // would under-report a broken event path exactly when the loop is busy enough to
    // paper over it. The trigger that found it is named in the record.
    //
    // Exactly one record per claim: a claim is released once, and the key is its own.
    const recoveredWithoutWake = released && trigger !== "wake" && !announced;
    let recoveryWakeId: number | null = null;
    if (recoveredWithoutWake) {
      recoveryWakeId = recordWake({
        projectKey,
        kind: "recovery",
        wakeKey: `lost-signal:${claim.id}`,
        detail:
          `the ${trigger} look found ${claim.ticketId}'s reservation terminal with no delivered wake. ` +
          `The primary signal path did not deliver; this look recovered it and the slot is free.`,
      }).id;
    }

    // A HOST-scoped ceiling means a slot freed HERE is a slot freed for every other
    // project on this host, and no other dispatcher can see this release without being
    // told. Keyed by the claim, so a duplicate is collapsed by the store.
    if (released && policy.capacityScope === "host") {
      for (const other of otherDispatcherProjects(projectKey)) {
        recordWake({
          projectKey: other,
          kind: "capacity_changed",
          wakeKey: `claim-released:${claim.id}`,
          detail: `a host-scoped capacity slot was freed by ${projectKey} releasing ${claim.ticketId}`,
        });
      }
    }

    const outcome = result.released?.outcome ?? null;
    let membershipRetired = false;
    let membershipNote: string | null = null;
    if (released && outcome !== null && MEMBERSHIP_RETIRING_OUTCOMES.has(outcome) && retireMembership) {
      try {
        dequeueTicket(projectKey, claim.ticketId);
        membershipRetired = true;
        membershipNote =
          `${claim.ticketId} left the queue because the work it asked for ran and ended (${outcome}). ` +
          `Its rank is retained, so re-enqueueing returns it to the same position.`;
      } catch (e) {
        // The operator dequeued it while it ran — the first-class not-a-member AND
        // executing state (D4). Nothing to retire, and nothing is wrong.
        if (!(e instanceof QueueRefusal)) throw e;
        membershipNote = `${claim.ticketId} was already out of the queue when its reservation was retired`;
      }
    }

    reconciled.push({
      claimId: claim.id,
      ticketId: claim.ticketId,
      runId: result.released?.runId ?? claim.runId,
      bound: result.bound,
      outcome,
      released,
      releaseRefused: result.releaseRefused,
      recoveredWithoutWake,
      recoveryWakeId,
      membershipRetired,
      membershipNote,
    });
  }

  // ── 5. DECIDE, THEN LAUNCH. The cycle writes one evaluation row per pass whatever
  // it concludes, so an idle queue still leaves the operator an answer.
  const cycle = runDispatchCycle({
    projectKey,
    owner,
    generation,
    wakeKind: wakes[0]?.kind ?? (trigger === "watchdog" ? "watchdog" : null),
    nextWatchdogAtMs,
  });

  const launches: LaunchClaimResult[] = [];
  for (const grant of cycle.grants) {
    launches.push(
      launchClaimedTicket({
        claim: grant.claim,
        forgeBin: input.forgeBin,
        takenOverFrom: grant.takenOverFrom,
        projectDir: input.projectDir,
        workflow: input.workflow,
        dispatcherOwner: owner,
        dispatcherGeneration: generation,
        ...(seams.execution !== undefined ? { seams: seams.execution } : {}),
      }),
    );
  }

  return {
    ...base,
    identity,
    wakes,
    heartbeats,
    lostClaims,
    reconciled,
    cycle,
    launches,
    skipped: null,
  };
}

// ─── the loop ────────────────────────────────────────────────────────────────

export type DispatcherStopReason =
  /** A different live owner holds the dispatcher lease, or ours was superseded. */
  | "lease_lost"
  | "aborted"
  | "max_ticks"
  | "max_iterations"
  | "stop_requested";

export type DispatcherLoopOptions = {
  projectKey: string;
  /** The instance-stable owner. resolveDispatcherOwner is how the CLI gets one. */
  owner: string;
  forgeBin: readonly string[];
  watchdogIntervalMs?: number;
  wakePollMs?: number;
  projectDir?: string | undefined;
  workflow?: string | undefined;
  host?: string;
  pid?: number;
  /** Forwarded to every tick. See MEMBERSHIP_RETIRING_OUTCOMES. */
  retireMembership?: boolean;
  /** Stop after this many EXECUTED ticks. A bound for one-shot and test drivers; the
   *  operator's dispatcher runs without one. */
  maxTicks?: number;
  /** A structural backstop on poll iterations, so a driver that can never satisfy its
   *  own stop condition ends rather than spins. */
  maxIterations?: number;
  /** Consulted before every iteration. */
  stopWhen?: () => boolean;
  signal?: AbortSignal;
  /** Release the dispatcher lease on an orderly exit, so a successor does not have to
   *  wait out a TTL. Releasing the LEASE releases no CLAIM — the two are separate
   *  durable facts and the claim primitive's own takeover/adoption path is what
   *  recovers live reservations. Defaults to true. */
  releaseLeaseOnStop?: boolean;
  seams?: DispatcherLoopSeams;
};

export type DispatcherLoopSummary = {
  projectKey: string;
  owner: string;
  ticks: DispatcherTick[];
  iterations: number;
  stopReason: DispatcherStopReason;
  /** Non-null when the loop stopped because it is not (or is no longer) the
   *  dispatcher. Surfaced loudly rather than exiting quietly as if idle. */
  alert: string | null;
  generation: number | null;
};

/**
 * THE LONG-LIVED DISPATCHER.
 *
 * Every iteration: keep the identity and the claim leases alive, look for durable
 * wakes, and tick when there is something to look at (a wake) or the health bound is
 * due (the watchdog). An iteration with neither sleeps and decides nothing.
 *
 * The FIRST iteration always ticks. A dispatcher that started because an operator ran
 * it, or restarted after a crash, must look at the world before it sleeps — the state
 * it needs to act on is durable and already there, and waiting a watchdog interval to
 * discover it is the stall this ticket exists to close.
 */
export async function runDispatcherLoop(opts: DispatcherLoopOptions): Promise<DispatcherLoopSummary> {
  const { projectKey, owner } = opts;
  const seams = opts.seams ?? {};
  const sleep = seams.sleep ?? defaultSleep;
  const observeWakes = seams.observeWakes ?? ((i) => observeRunTerminalWakes(i));
  const watchdogIntervalMs = requireWatchdogInterval(opts.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
  const wakePollMs = opts.wakePollMs ?? DEFAULT_WAKE_POLL_MS;

  const ticks: DispatcherTick[] = [];
  const seen = new Set<string>();
  let generation: number | null = null;
  let nextWatchdogAtMs = 0;
  let iterations = 0;
  /** Set by a tick that launched, consumed by the ONE follow-up tick after it. */
  let refillPending = false;
  let stopReason: DispatcherStopReason = "max_iterations";
  let alert: string | null = null;

  for (;;) {
    if (opts.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    if (opts.stopWhen?.()) {
      stopReason = "stop_requested";
      break;
    }
    if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) {
      stopReason = "max_iterations";
      break;
    }
    iterations++;

    // The primary signal, recorded durably by whoever observes the transition first.
    // Suppressible by the falsification harness; the watchdog below is what bounds
    // its absence.
    observeWakes({ projectKey, owner, seen });

    const nowMs = storeNowMs();
    const pending = pendingWakeCount(projectKey);
    const watchdogDue = nowMs >= nextWatchdogAtMs;
    const trigger: TickTrigger | null =
      ticks.length === 0
        ? "startup"
        : pending > 0
          ? "wake"
          : watchdogDue
            ? "watchdog"
            : refillPending
              ? "refill"
              : null;

    if (trigger === null) {
      // IDLE. Nothing is decided, but the identity and the claim leases must stay
      // alive: a lease that lapses while a container runs invites a takeover.
      const maintained = maintainLeases({ projectKey, owner, generation, nowMs });
      if (!maintained.held) {
        stopReason = "lease_lost";
        alert = maintained.alert;
        break;
      }
      generation = maintained.lease.generation;
      await sleep(Math.max(1, Math.min(wakePollMs, Math.max(1, nextWatchdogAtMs - nowMs))));
      continue;
    }

    const tick = runDispatcherTick({
      projectKey,
      owner,
      trigger,
      forgeBin: opts.forgeBin,
      watchdogIntervalMs,
      projectDir: opts.projectDir,
      workflow: opts.workflow,
      ...(opts.retireMembership !== undefined ? { retireMembership: opts.retireMembership } : {}),
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
      generation,
      seams,
    });
    ticks.push(tick);
    seams.onTick?.(tick);

    if (!tick.identity.held) {
      stopReason = "lease_lost";
      alert = tick.identity.alert;
      break;
    }
    generation = tick.identity.lease.generation;
    nextWatchdogAtMs = tick.nextWatchdogAtMs;
    refillPending = tick.launches.some((l) => l.kind === "launched" || l.kind === "adopted");

    // A claim we no longer hold is one a successor will recover. Drop the whole
    // observation cache rather than trying to evict the right key: the cache is a hint
    // that suppresses duplicate WRITES, re-observation is idempotent by the wake
    // table's own construction, and a cache that evicts nearly the right entry is
    // worse than one that forgets.
    if (tick.lostClaims.length > 0) seen.clear();

    if (opts.maxTicks !== undefined && ticks.length >= opts.maxTicks) {
      stopReason = "max_ticks";
      break;
    }
    await sleep(Math.max(1, wakePollMs));
  }

  if ((opts.releaseLeaseOnStop ?? true) && generation !== null && stopReason !== "lease_lost") {
    releaseDispatcherLease(projectKey, owner, generation);
  }

  return { projectKey, owner, ticks, iterations, stopReason, alert, generation };
}

type MaintainResult =
  | { held: true; lease: DispatcherLease }
  | { held: false; alert: string };

/** The idle-iteration maintenance: renew the dispatcher lease when the policy cadence
 *  says it is due, and heartbeat the claims we hold. Both are due-checked against the
 *  STORE clock, so an idle loop is not a continuous writer. */
function maintainLeases(input: {
  projectKey: string;
  owner: string;
  generation: number | null;
  nowMs: number;
}): MaintainResult {
  const policy = getDispatcherPolicy(input.projectKey);
  const view = dispatcherLeaseView(input.projectKey);
  const ours =
    view.lease !== null && view.lease.owner === input.owner && view.lease.generation === input.generation;

  if (!ours || view.lease === null) {
    return {
      held: false,
      alert:
        `the dispatcher lease for ${input.projectKey} is no longer ours: it is held by ` +
        `${view.lease?.owner ?? "nobody"} at generation ${view.lease?.generation ?? "-"} and we ran at ` +
        `generation ${input.generation ?? "-"}. This process stops rather than driving under a lease it ` +
        `does not hold; its claim leases lapse and are recovered by takeover, which ADOPTS the running ` +
        `launch rather than starting a second container.`,
    };
  }

  if (input.nowMs - view.lease.heartbeatAtMs >= policy.heartbeatMs) {
    const renewed = renewDispatcherLease({
      projectKey: input.projectKey,
      owner: input.owner,
      generation: view.lease.generation,
      ttlMs: policy.leaseTtlMs,
    });
    if (!renewed) {
      return {
        held: false,
        alert:
          `renewing the dispatcher lease for ${input.projectKey} was REFUSED at generation ` +
          `${view.lease.generation}: it was superseded by a takeover, or it strictly lapsed. Failing ` +
          `closed — a dispatcher that kept deciding under a dead lease is how two dispatchers drive one ` +
          `queue.`,
      };
    }
  }

  // NOT gated on `armed` (D5): a disarmed dispatcher keeps the leases it already holds
  // alive, because the containers under them are still running.
  heartbeatOwnedClaims({ projectKey: input.projectKey, owner: input.owner, policy });
  return { held: true, lease: view.lease };
}

// ─── the operator's health read ──────────────────────────────────────────────

export type DispatcherHealth = {
  projectKey: string;
  policy: DispatcherPolicy;
  lease: DispatcherLeaseView;
  /** Loud, named and non-null whenever the dispatcher is not demonstrably alive. The
   *  six no-run states the CLI must distinguish are built ON this plus the latest
   *  evaluation; collapsing "nothing to do" and "the dispatcher died four hours ago"
   *  into one answer is the operator blindness this ticket exists to close. */
  alert: string | null;
  pendingWakes: number;
  latestEvaluation: DispatcherEvaluation | undefined;
  /** The deadline the last pass ARMED. undefined: no pass has ever run. null: the last
   *  pass armed none — a dispatcher that stopped re-arming. */
  nextWatchdogAtMs: number | null | undefined;
  /** True when that deadline is in the past on the store clock: the watchdog that
   *  should have fired did not, so no process is ticking. */
  watchdogOverdue: boolean;
  liveClaims: QueueClaim[];
  nowMs: number;
};

/**
 * A pure READ. Writes nothing, renews nothing and starts nothing — safe from a CLI, a
 * dashboard handler or a test.
 *
 * D9 lives here as much as in the loop: after a host reboot this is what says the
 * dispatcher is DOWN, out loud, instead of a quiet board that looks the same as an
 * idle one.
 */
export function dispatcherHealth(projectKey: string): DispatcherHealth {
  const policy = getDispatcherPolicy(projectKey);
  const lease = dispatcherLeaseView(projectKey);
  const nowMs = lease.nowMs;
  const watchdogAt = nextWatchdogDeadlineMs(projectKey);
  const watchdogOverdue = typeof watchdogAt === "number" && watchdogAt < nowMs;

  let alert: string | null = null;
  if (lease.lease === null) {
    alert =
      `no dispatcher has ever held a lease for ${projectKey}. Nothing is watching this queue, so a ` +
      `queued, ready, compatible ticket will not start on its own. Start one with ` +
      `\`forge queue dispatcher run\`.`;
  } else if (lease.expired) {
    alert =
      `the dispatcher lease for ${projectKey} is EXPIRED — ${lease.lease.owner} last heartbeated ` +
      `${lease.msSinceHeartbeat ?? "?"}ms ago and its lease ended at ` +
      `${new Date(lease.lease.leaseExpiresAtMs).toISOString()}. The dispatcher is dead or the host ` +
      `rebooted; forge does NOT auto-restart it (D9). Any claim it held is recoverable by takeover, and ` +
      `a successor ADOPTS the running launch rather than starting a second container.`;
  } else if (watchdogOverdue) {
    alert =
      `the dispatcher for ${projectKey} holds a live lease but its watchdog deadline ` +
      `(${new Date(watchdogAt as number).toISOString()}) has passed with no evaluation since. The lease ` +
      `is being renewed but no tick is completing — the loop is stuck, not idle.`;
  }

  return {
    projectKey,
    policy,
    lease,
    alert,
    pendingWakes: pendingWakeCount(projectKey),
    latestEvaluation: latestEvaluation(projectKey),
    nextWatchdogAtMs: watchdogAt,
    watchdogOverdue,
    liveClaims: liveClaims(projectKey),
    nowMs,
  };
}
