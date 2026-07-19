// FG-563 (Slice 4): the interactive orchestrator's durable continuation CONSUMER.
//
// This is the first WIRED consumer of the FG-552 wait primitive and the FG-562
// claim primitive. It replaces the orchestrator's fixed-estimate `ScheduleWakeup`
// + hand-rolled `Monitor` polling happy path with a completion-DRIVEN, durable,
// idempotent, crash-safe advance:
//
//   1. A disposable session adapter blocks on `forge launch wait <id>` (OQ-2). When
//      it observes a terminal disposition it wakes the controller, which invokes
//      THIS consumer (the `forge continue` command) carrying the FULL phase-bound
//      continuation identity.
//   2. On wake the consumer RE-READS the canonical launch record itself
//      (readLaunch/classifyExit, BD-3) — it NEVER trusts the waiter's stdout, a
//      cached status, or a caller-supplied disposition. A claim may rest ONLY on a
//      classification the authoritative durable record supports.
//   3. It claims the single next-action transition EXACTLY ONCE (FG-562 phase-bound
//      CAS) and ADOPTS an already-created physical run rather than spawning a
//      duplicate (F17), keyed on the deterministic dispatch receipt.
//   4. `ScheduleWakeup` is demoted to a FIXED, health-bound lost-signal WATCHDOG
//      (BD-9) — never sized from a guessed job duration. When the watchdog (not the
//      normal event) recovers a terminal-but-unadvanced launch it records a durable
//      lost-signal audit row (continuation_lost_signal_recoveries); when it fires on
//      a still-running launch it re-arms and records nothing; when the normal event
//      already advanced it records nothing (F18 — no false lost-signal claim).
//
// SCOPE: this consumes the FG-552/FG-562 primitives UNCHANGED. The physical
// run-creation is INJECTED (`dispatch`) so this module stays free of the docker/
// spawn stack and testable on the real store path; the `forge continue` command
// wires the real run-creation path (startRun / invoke), which stamps the receipt
// into run metadata (runByDispatchKey) BEFORE the spawn is observable.

import {
  adoptOrClaimDispatch as realAdoptOrClaimDispatch,
  claimContinuationDispatch as realClaimContinuationDispatch,
  continuationsInDispatch as realContinuationsInDispatch,
  getContinuation as realGetContinuation,
  markAdvanced as realMarkAdvanced,
  markBlocked as realMarkBlocked,
  observeLaunchStatus as realObserveLaunchStatus,
  recordDispatchResult as realRecordDispatchResult,
  renewClaim as realRenewClaim,
  type Continuation,
  type ConsumerKind,
  type NextAction,
} from "../store/continuations.js";
import { runByDispatchKey as realRunByDispatchKey } from "../store/runs.js";
import { recordLostSignalRecovery as realRecordLostSignalRecovery } from "../store/continuation-lost-signal.js";
import {
  isTerminalStatus,
  readLaunch as realReadLaunch,
  type LaunchStatus,
  type LaunchView,
  type WaitOutcome,
} from "./launch.js";

/** BD-9: the FIXED, health-bound lost-signal watchdog interval. This is a
 *  system-health cadence, NEVER sized from a guessed job duration — a launch that
 *  runs longer than any estimate still produces NO model wake until it completes
 *  (F19). The orchestrator arms `ScheduleWakeup` at this interval as a watchdog;
 *  the normal completion path is the `forge launch wait` adapter, not this timer. */
export const LOST_SIGNAL_WATCHDOG_INTERVAL_MS = 30 * 60 * 1000;

/** The default claim lease. Long enough to cover a physical dispatch, short enough
 *  that a crashed controller's claim is recoverable by a watchdog re-fire. */
export const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

/** Which wake channel invoked the consumer. `delivery` = the normal completion
 *  event (the `forge launch wait` adapter woke us). `watchdog` = the low-frequency
 *  health timer fired. The distinction is what makes a lost-signal recovery
 *  truthful: only a `watchdog` advance of terminal-but-unadvanced work is a
 *  recovered lost signal. */
export type WakeTrigger = "delivery" | "watchdog";

/** The COMPLETE phase-bound continuation identity the consumer carries on every
 *  wake. A launch-id-only surface is explicitly non-conforming (CP4): the claim is
 *  phase-bound, so all five fields are required. */
export type ContinuationIdentity = {
  continuationId: string;
  sourceLaunchId: string;
  consumerKind: ConsumerKind;
  currentPhase: string;
  nextAction: NextAction;
};

/** The physical run-creation seam. Given the next action + the dispatch receipt, it
 *  creates the physical run/task and MUST stamp `dispatchKey` into run metadata (the
 *  real startRun/createInvokeRun path does) so a later recovery adopts it by key
 *  instead of duplicating. Returns whatever ids it created. */
export type PhysicalDispatch = (args: {
  nextAction: NextAction;
  dispatchKey: string;
  continuationId: string;
  sourceLaunchId: string;
  currentPhase: string;
}) => { runId?: string; taskId?: string };

export type ConsumeDeps = {
  /** The controller identity claiming the transition (WHICH controller). */
  owner: string;
  /** The physical run-creation seam (required — orchestrator-specific). */
  dispatch: PhysicalDispatch;
  leaseTtlMs?: number;
  /** delivery (default) | watchdog. */
  trigger?: WakeTrigger;
  /** The waiter-control outcome that drove this wake, when a disposable `forge launch
   *  wait` adapter woke us (OQ-2). It is a CONTROL signal ONLY, NEVER the source of the
   *  disposition (BD-3): the consumer ignores the waiter's stdout status and re-derives
   *  from the authoritative record itself. A `wait_timeout` / `wait_cancelled` /
   *  `unknown_launch` outcome (waiter-control, not a launch disposition) NEVER advances
   *  — it re-observes the canonical record and re-arms. A `terminal` outcome, or NO
   *  outcome at all (a watchdog fire), re-derives + advances. */
  waitOutcome?: WaitOutcome;
  // ── Injectable seams. Default to the real canonical readers / primitives; tests
  //    drive the launch record + store without real timers or docker. ──
  readLaunch?: (id: string) => LaunchView | undefined;
  runByDispatchKey?: (dispatchKey: string) => { id: string } | undefined;
  getContinuation?: typeof realGetContinuation;
  observeLaunchStatus?: typeof realObserveLaunchStatus;
  adoptOrClaimDispatch?: typeof realAdoptOrClaimDispatch;
  claimContinuationDispatch?: typeof realClaimContinuationDispatch;
  recordDispatchResult?: typeof realRecordDispatchResult;
  markAdvanced?: typeof realMarkAdvanced;
  markBlocked?: typeof realMarkBlocked;
  renewClaim?: typeof realRenewClaim;
  recordLostSignalRecovery?: typeof realRecordLostSignalRecovery;
  continuationsInDispatch?: typeof realContinuationsInDispatch;
};

type Resolved = Required<Omit<ConsumeDeps, "trigger" | "waitOutcome">> & {
  trigger: WakeTrigger;
  waitOutcome?: WaitOutcome;
};

export type ConsumeOutcome =
  /** The continuation advanced this call (one claim, one dispatch). `adopted` =
   *  a pre-existing physical run was adopted (F17) rather than spawned;
   *  `lostSignalRecovered` = a watchdog recovered a lost completion signal and a
   *  durable audit row was written. */
  | { kind: "advanced"; continuation: Continuation; dispatchKey: string; adopted: boolean; lostSignalRecovered: boolean }
  /** The launch is NOT terminal (still running, or its record is absent/unknown).
   *  The watchdog re-arms; NOTHING advances and no lost-signal row is written. */
  | { kind: "rearmed"; reason: "still_running" | "unknown_launch"; status?: LaunchStatus }
  /** The slot already advanced (a prior normal event won). A duplicate wake or a
   *  watchdog re-fire performs no action and writes no lost-signal row (F13/F18). */
  | { kind: "already_advanced"; continuation: Continuation }
  /** We lost the claim/lease race to a concurrent controller/wake (F14). Nothing
   *  was dispatched; observe the winner's claimed/advanced state. */
  | { kind: "lost_claim"; continuation: Continuation | undefined }
  /** The physical dispatch threw. This is a RECOVERABLE outcome, not a permanent
   *  wedge (FIX4a): the durable slot is left IN-FLIGHT (state stays `dispatching`,
   *  the receipt stays set), so a watchdog re-fire AND recoverInFlightDispatches both
   *  re-attempt it — a transient dispatch failure recovers. The `blocked` kind is the
   *  operator-visible surface for the failed attempt; the slot is never silently gone. */
  | { kind: "blocked"; continuation: Continuation | undefined; error: string };

function resolve(deps: ConsumeDeps): Resolved {
  return {
    owner: deps.owner,
    dispatch: deps.dispatch,
    leaseTtlMs: deps.leaseTtlMs ?? DEFAULT_CLAIM_LEASE_MS,
    trigger: deps.trigger ?? "delivery",
    ...(deps.waitOutcome ? { waitOutcome: deps.waitOutcome } : {}),
    readLaunch: deps.readLaunch ?? ((id) => realReadLaunch(id)),
    runByDispatchKey:
      deps.runByDispatchKey ??
      ((key) => {
        const r = realRunByDispatchKey(key);
        return r ? { id: r.id } : undefined;
      }),
    getContinuation: deps.getContinuation ?? realGetContinuation,
    observeLaunchStatus: deps.observeLaunchStatus ?? realObserveLaunchStatus,
    adoptOrClaimDispatch: deps.adoptOrClaimDispatch ?? realAdoptOrClaimDispatch,
    claimContinuationDispatch: deps.claimContinuationDispatch ?? realClaimContinuationDispatch,
    recordDispatchResult: deps.recordDispatchResult ?? realRecordDispatchResult,
    markAdvanced: deps.markAdvanced ?? realMarkAdvanced,
    markBlocked: deps.markBlocked ?? realMarkBlocked,
    renewClaim: deps.renewClaim ?? realRenewClaim,
    recordLostSignalRecovery: deps.recordLostSignalRecovery ?? realRecordLostSignalRecovery,
    continuationsInDispatch: deps.continuationsInDispatch ?? realContinuationsInDispatch,
  };
}

/** CP4: the surface carries the COMPLETE phase-bound identity. Reject a partial
 *  (launch-id-only) shape BEFORE any store touch — a launch id alone cannot bind a
 *  phase-bound claim. This is the consumer-side guard the CLI command relies on. */
export function assertFullIdentity(identity: Partial<ContinuationIdentity>): asserts identity is ContinuationIdentity {
  const missing: string[] = [];
  if (!identity.continuationId) missing.push("continuationId");
  if (!identity.sourceLaunchId) missing.push("sourceLaunchId");
  if (!identity.consumerKind) missing.push("consumerKind");
  if (!identity.currentPhase) missing.push("currentPhase");
  if (!identity.nextAction || typeof identity.nextAction.kind !== "string" || identity.nextAction.kind === "") {
    missing.push("nextAction");
  }
  if (missing.length > 0) {
    throw new Error(
      `continuation-consumer: incomplete continuation identity (missing: ${missing.join(", ")}). ` +
        `A launch-id-only surface is non-conforming — the claim is phase-bound and requires the ` +
        `full identity (continuationId, sourceLaunchId, consumerKind, currentPhase, nextAction).`,
    );
  }
  if (identity.consumerKind !== "orchestrator") {
    throw new Error(
      `continuation-consumer: this is the ORCHESTRATOR consumer (consumerKind='orchestrator'); ` +
        `got '${identity.consumerKind}'. Campaign adoption is FG-564, out of scope here.`,
    );
  }
}

/**
 * The orchestrator continuation-consumer operation, invoked on every wake (normal
 * delivery OR watchdog). Idempotent and crash-safe: a duplicate wake or watchdog
 * re-fire produces exactly ONE claim and ONE advance.
 */
export function consumeContinuation(identity: ContinuationIdentity, deps: ConsumeDeps): ConsumeOutcome {
  assertFullIdentity(identity);
  const d = resolve(deps);

  // FIX2 / BD-7 / BD-3: a WAITER-CONTROL outcome — the disposable `forge launch wait`
  // adapter timed out, was cancelled, or reported an unknown launch — is NOT a launch
  // disposition and NEVER advances. Re-observe the canonical record and re-arm. We do
  // NOT ingest the waiter's `lastObserved` stdout as truth (that would violate BD-3);
  // we re-read the authoritative record ourselves and simply decline to advance.
  if (d.waitOutcome && d.waitOutcome.kind !== "terminal") {
    const controlView = d.readLaunch(identity.sourceLaunchId);
    if (!controlView) return { kind: "rearmed", reason: "unknown_launch" };
    const reason = d.waitOutcome.kind === "unknown_launch" ? "unknown_launch" : "still_running";
    return { kind: "rearmed", reason, status: controlView.status };
  }

  // BD-3 (CP3): re-derive the disposition from the AUTHORITATIVE launch record — we
  // NEVER trust a caller/Monitor-stdout status; a fabricated 'exited_ok' handed to
  // this consumer has ZERO effect because we ignore it and read the record ourselves.
  const view = d.readLaunch(identity.sourceLaunchId);
  if (view === undefined) {
    // unknown_launch: no authoritative record to advance on. Re-arm; never advance.
    return { kind: "rearmed", reason: "unknown_launch" };
  }
  // FIX2 / F22: derive the authoritative disposition via the SAME reconciling
  // terminal-derivation the canonical waiter uses (waitForLaunchTerminal) — a real
  // terminal status OR a reconciled persistently-unreadable terminal
  // (owner_gone/unknown surfaced through pendingUnreadableExit). A BARE
  // isTerminalStatus(view.status) would report a persistently-unreadable owner-gone
  // launch as `running` forever and strand it (BD-7 violation).
  const disposition = deriveTerminalDisposition(view);
  if (!disposition.terminal) {
    // CP5/F18: STILL RUNNING. A watchdog fire here records NO lost-signal event and
    // re-arms; a spurious delivery wake likewise re-arms. NEVER advance (F19: a job
    // outrunning any estimate produces no advance until it is genuinely terminal).
    return { kind: "rearmed", reason: "still_running", status: disposition.status };
  }
  const status = disposition.status;

  // Terminal. F18: if the slot ALREADY advanced (a prior normal event won), a
  // watchdog re-fire / duplicate delivery does NOTHING and — crucially — writes NO
  // false lost-signal row.
  const pre = d.getContinuation(identity.continuationId);
  if (pre && pre.state === "advanced") {
    return { kind: "already_advanced", continuation: pre };
  }

  // BD-3 evidence: record the authoritative, launch-bound observation
  // (awaiting_completion -> ready). The primitive derives terminality via the ONE
  // canonical classifier — a non-terminal/fabricated status can never promote.
  d.observeLaunchStatus(identity.continuationId, identity.sourceLaunchId, status.state);

  // FIX1 / BD-4 (record-before-notify): on the WATCHDOG path the durable lost-signal
  // audit row MUST be committed BEFORE the advance is observable. If we advanced
  // FIRST and crashed before the audit insert, the continuation would read `advanced`
  // forever and every later watchdog would write nothing — the recovery would be
  // permanently unauditable. So we hand dispatchAndAdvance a hook it fires AFTER
  // winning the claim + dispatching but STRICTLY BEFORE the settling markAdvanced.
  // Recording only after WINNING the claim keeps a watchdog that lost the race to a
  // concurrent delivery from writing a false row.
  let lostSignalRecovered = false;
  const onBeforeAdvance =
    d.trigger === "watchdog"
      ? (ctx: { dispatchKey: string; ids: { runId?: string; taskId?: string } }): void => {
          d.recordLostSignalRecovery({
            continuationId: identity.continuationId,
            sourceLaunchId: identity.sourceLaunchId,
            currentPhase: identity.currentPhase,
            consumerKind: identity.consumerKind,
            controller: d.owner,
            observedStatus: status.state,
            recoveryTrigger: "watchdog",
            dispatchKey: ctx.dispatchKey,
            ...(ctx.ids.runId ? { dispatchedRunId: ctx.ids.runId } : {}),
            ...(ctx.ids.taskId ? { dispatchedTaskId: ctx.ids.taskId } : {}),
          });
          lostSignalRecovered = true;
        }
      : undefined;

  const result = dispatchAndAdvance(identity, d, onBeforeAdvance);
  if (result.kind === "advanced" && lostSignalRecovered) {
    return { ...result, lostSignalRecovered: true };
  }
  return result;
}

/** FIX2 / BD-3 / F22: re-derive the authoritative disposition the SAME way the
 *  canonical waiter does (waitForLaunchTerminal's reconciling derivation) — a real
 *  terminal `status`, OR a reconciled PERSISTENTLY-unreadable terminal
 *  (owner_gone/unknown) surfaced via `pendingUnreadableExit` when the record stayed
 *  unreadable past its bound while owner evidence went terminal. This is re-derived
 *  from the authoritative launch record + its own owner reconciliation ONLY, never
 *  from a caller-supplied/stale status. A bare isTerminalStatus(view.status) misses
 *  the reconciled dispositions and would strand them (BD-7). */
function deriveTerminalDisposition(
  view: LaunchView,
): { terminal: true; status: LaunchStatus } | { terminal: false; status: LaunchStatus } {
  if (isTerminalStatus(view.status)) return { terminal: true, status: view.status };
  if (view.pendingUnreadableExit) return { terminal: true, status: view.pendingUnreadableExit.terminal };
  return { terminal: false, status: view.status };
}

/**
 * CP4 + F17: claim exactly-once, then ADOPT-not-duplicate. Shared by the normal
 * wake path and the restart-replay recovery path.
 */
function dispatchAndAdvance(
  identity: ContinuationIdentity,
  d: Resolved,
  onBeforeAdvance?: (ctx: { dispatchKey: string; ids: { runId?: string; taskId?: string } }) => void,
): ConsumeOutcome {
  const claimReq = {
    continuationId: identity.continuationId,
    sourceLaunchId: identity.sourceLaunchId,
    consumerKind: identity.consumerKind,
    currentPhase: identity.currentPhase,
    nextAction: identity.nextAction,
    owner: d.owner,
    leaseTtlMs: d.leaseTtlMs,
  };

  const outcome = d.adoptOrClaimDispatch(claimReq);
  const dispatchKey = outcome.dispatchKey;

  if (outcome.disposition === "unclaimable") {
    // F13/F14: another controller/wake won the claim, or the slot is not 'ready'.
    // Observe the winner's state; take NO action and spawn NOTHING.
    return { kind: "lost_claim", continuation: outcome.continuation };
  }

  // An ADOPT (F16/F17 recovery of an existing receipt) requires we OWN the lease
  // before settling.
  if (outcome.disposition === "adopt") {
    if (outcome.continuation.claimOwner === d.owner) {
      // FIX4(b) / F17 restart-adoption: a fresh process presenting the SAME owner id
      // is the crash-recovery case — the in-flight claim is ALREADY ours. Re-adopt it
      // by renewing OUR OWN lease. A same-owner takeover must NOT wait for the lease
      // to expire against ourselves: claimContinuationDispatch(expectedState:
      // 'dispatching') refuses a non-expired lease, which would wedge a controller
      // that restarts before its own crashed claim's lease elapses. renewClaim is
      // owner-scoped, so it grants iff we are still the owner (else a real takeover
      // stepped past us and we lose).
      if (!d.renewClaim(identity.continuationId, d.owner, d.leaseTtlMs)) {
        return { kind: "lost_claim", continuation: d.getContinuation(identity.continuationId) };
      }
    } else {
      // A DIFFERENT owner holds it — only an EXPIRED lease may be taken over; a LIVE
      // owner means another controller holds this dispatch, so we lose and spawn nothing.
      const takeover = d.claimContinuationDispatch({ ...claimReq, expectedState: "dispatching" });
      if (!takeover.granted) {
        return { kind: "lost_claim", continuation: takeover.continuation };
      }
    }
  }

  // We own the lease. CHECK-BEFORE-SPAWN (F17): resolve the physical run by the
  // deterministic receipt. If one already exists — crash-after-spawn-before-record,
  // or a prior claim's dispatch — ADOPT it; NEVER spawn a duplicate.
  let ids: { runId?: string; taskId?: string };
  const existingRun = d.runByDispatchKey(dispatchKey);
  if (existingRun) {
    ids = { runId: existingRun.id };
  } else if (
    outcome.disposition === "adopt" &&
    (outcome.continuation.dispatchedRunId || outcome.continuation.dispatchedTaskId)
  ) {
    // The crashed owner recorded ids but no run resolves by key (e.g. a dispatch that
    // predates the CP2 metadata bridge). Adopt the recorded ids rather than duplicate.
    ids = {
      ...(outcome.continuation.dispatchedRunId ? { runId: outcome.continuation.dispatchedRunId } : {}),
      ...(outcome.continuation.dispatchedTaskId ? { taskId: outcome.continuation.dispatchedTaskId } : {}),
    };
  } else {
    // No physical run under this receipt — the dispatch never happened (fresh claim,
    // or a crash BEFORE the spawn). Dispatch NOW, passing the receipt so the created
    // run is discoverable by key from this instant (closes the F17 crash window).
    try {
      ids = d.dispatch({
        nextAction: identity.nextAction,
        dispatchKey,
        continuationId: identity.continuationId,
        sourceLaunchId: identity.sourceLaunchId,
        currentPhase: identity.currentPhase,
      });
    } catch (e) {
      // FIX4(a): a dispatch exception is RECOVERABLE, not a permanent wedge. We do
      // NOT sink the slot into a non-recoverable `blocked` state — that left it
      // unreachable to both the watchdog and recoverInFlightDispatches. Instead we
      // leave the claim IN-FLIGHT (state stays `dispatching`, receipt stays set): a
      // watchdog re-fire re-reads terminal + re-adopts (this same path), and
      // recoverInFlightDispatches enumerates it via continuationsInDispatch — so a
      // TRANSIENT dispatch failure recovers. The lease still expires naturally, so a
      // different controller can also take it over. We surface a `blocked` OUTCOME
      // (operator-visible) for the failed attempt; the durable slot is never gone.
      return { kind: "blocked", continuation: d.getContinuation(identity.continuationId), error: (e as Error).message };
    }
  }

  // FIX4(c): renew the lease across the dispatch->settle window. A long physical
  // dispatch can exceed the claim lease; without a renewal a concurrent
  // watchdog/controller could take the claim over between our claim and our settle,
  // and our owner-scoped writes below would then no-op. Renewing (owner-scoped) keeps
  // the claim ours through recordDispatchResult + markAdvanced.
  d.renewClaim(identity.continuationId, d.owner, d.leaseTtlMs);

  // Record the dispatched ids (immutable identity). Owner-scoped: a taken-over claim
  // can never overwrite the winner.
  d.recordDispatchResult(identity.continuationId, d.owner, ids);

  // FIX1 record-before-advance: the lost-signal audit (watchdog path) commits HERE,
  // STRICTLY BEFORE the settling markAdvanced makes the advance observable.
  if (onBeforeAdvance) onBeforeAdvance({ dispatchKey, ids });

  // Settle dispatching -> advanced (owner-scoped).
  const advanced = d.markAdvanced(identity.continuationId, d.owner, ids);
  const continuation = d.getContinuation(identity.continuationId);
  if (!advanced || !continuation) {
    // A concurrent takeover stepped past us between dispatch and settle. Observe the
    // current state; take no further action.
    return { kind: "lost_claim", continuation };
  }
  return {
    kind: "advanced",
    continuation,
    dispatchKey,
    adopted: outcome.disposition === "adopt",
    lostSignalRecovered: false,
  };
}

/**
 * F17 restart-replay recovery. On controller restart, adopt every in-flight
 * (claimed-but-not-advanced) orchestrator dispatch via continuationsInDispatch +
 * the receipt — NEVER spawn a second physical run. Each row's own identity drives
 * the adopt: runByDispatchKey lands on the ONE original in-flight run created under
 * the receipt (CP2 metadata bridge), so the crash-after-spawn window resolves to
 * adoption, not duplication.
 */
export function recoverInFlightDispatches(deps: Omit<ConsumeDeps, "trigger">): ConsumeOutcome[] {
  const d = resolve({ ...deps, trigger: "delivery" });
  const inFlight = d.continuationsInDispatch({ consumerKind: "orchestrator" });
  return inFlight.map((c) =>
    dispatchAndAdvance(
      {
        continuationId: c.continuationId,
        sourceLaunchId: c.sourceLaunchId,
        consumerKind: c.consumerKind,
        currentPhase: c.currentPhase,
        nextAction: c.nextAction,
      },
      d,
    ),
  );
}
