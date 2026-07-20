// FG-564 (Slice 5b, AC6): the SHARED claim/adopt/observe control flow, extracted from
// the orchestrator's FG-563 continuation-consumer so BOTH the orchestrator and the
// campaign controller drive it — one module, not a copy.
//
// What is shared (the whole crash-safe advance):
//   - the waiter-control (waitOutcome) guard — a non-terminal waiter signal NEVER advances;
//   - the BD-3 re-read of the AUTHORITATIVE launch record + deriveTerminalDisposition
//     (the SAME reconciling terminal derivation the canonical waiter uses);
//   - the already-advanced short-circuit (no duplicate action, no false lost-signal row);
//   - observeLaunchStatus (awaiting_completion -> ready) via the one canonical classifier;
//   - the FG-562 phase-bound claim/adopt, owner-scoped lease handling (same-owner
//     re-adoption vs expired-lease takeover), and the record-before-advance watchdog hook;
//   - recordDispatchResult + markAdvanced, both owner-scoped and immutable-identity;
//   - the consumer-scoped restart-replay recovery loop.
//
// What each consumer INJECTS (the ONLY branch points, per AC6):
//   1. `dispatch` — the PhysicalDispatch. The orchestrator keys its physical run on the
//      FG-562 continuation receipt (runByDispatchKey); the campaign instead translates the
//      authorized drive_campaign_item action into the FG-596 reservation
//      (reserveCampaignDriveDispatch — the SOLE item-run create/adopt authority) and
//      records the resulting immutable run identity. The core NEVER assumes the receipt is
//      the physical run key; the adapter owns check-before-spawn.
//   2. the recover filter (`consumerKind`) so each side collects only its own in-flight claims.
//   3. the full-identity assertion's expected consumerKind (generalized here).
//
// The core does NOT import docker/spawn/reservation code — the physical seam is injected,
// so the whole module stays testable on the real store path without real timers or docker.

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
import { recordLostSignalRecovery as realRecordLostSignalRecovery } from "../store/continuation-lost-signal.js";
import {
  isTerminalStatus,
  readLaunch as realReadLaunch,
  type LaunchStatus,
  type LaunchView,
  type WaitOutcome,
} from "./launch.js";

export type { ConsumerKind } from "../store/continuations.js";

/** BD-9: the FIXED, health-bound lost-signal watchdog interval — a system-health
 *  cadence, NEVER sized from a guessed job duration. */
export const LOST_SIGNAL_WATCHDOG_INTERVAL_MS = 30 * 60 * 1000;

/** The default claim lease. Long enough to cover a physical dispatch, short enough that
 *  a crashed controller's claim is recoverable by a watchdog re-fire. */
export const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type WakeTrigger = "delivery" | "watchdog";

/** The COMPLETE phase-bound continuation identity carried on every wake. */
export type ContinuationIdentity = {
  continuationId: string;
  sourceLaunchId: string;
  consumerKind: ConsumerKind;
  currentPhase: string;
  nextAction: NextAction;
};

/**
 * The physical run-creation/adoption seam. The core hands it the authorized next action
 * + the dispatch receipt + whether the continuation claim was an ADOPT (recovery) and
 * any ids the crashed owner recorded, and expects back the resulting run/task ids. The
 * ADAPTER owns check-before-spawn: it must NEVER create a duplicate physical run. A
 * RECOVERABLE failure (a genuine dispatch error; or, for the campaign, a `lost`/fenced
 * reservation) is signalled by THROWING — the core then leaves the slot IN-FLIGHT
 * (state stays `dispatching`, receipt stays set) and returns `blocked`, so the work is
 * recoverable and is NEVER marked successfully advanced.
 */
export type PhysicalDispatch = (args: {
  nextAction: NextAction;
  dispatchKey: string;
  continuationId: string;
  sourceLaunchId: string;
  currentPhase: string;
  /** true when the continuation claim was an ADOPT (recovery of an existing receipt). */
  adopting: boolean;
  /** ids the crashed owner recorded before crashing, if any (adopt path). */
  recorded: { runId?: string; taskId?: string };
}) => { runId?: string; taskId?: string };

export type CoreConsumeDeps = {
  /** The controller identity claiming the transition (WHICH controller). */
  owner: string;
  /** The injected physical run-creation/adoption seam (consumer-specific). */
  dispatch: PhysicalDispatch;
  leaseTtlMs?: number;
  trigger?: WakeTrigger;
  waitOutcome?: WaitOutcome;
  // ── Injectable store/reader seams. Default to the real canonical readers / primitives. ──
  readLaunch?: (id: string) => LaunchView | undefined;
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

type Resolved = Required<Omit<CoreConsumeDeps, "trigger" | "waitOutcome">> & {
  trigger: WakeTrigger;
  waitOutcome?: WaitOutcome;
};

export type ConsumeOutcome =
  | { kind: "advanced"; continuation: Continuation; dispatchKey: string; adopted: boolean; lostSignalRecovered: boolean }
  | { kind: "rearmed"; reason: "still_running" | "unknown_launch"; status?: LaunchStatus }
  | { kind: "already_advanced"; continuation: Continuation }
  | { kind: "lost_claim"; continuation: Continuation | undefined }
  | { kind: "blocked"; continuation: Continuation | undefined; error: string };

function resolve(deps: CoreConsumeDeps): Resolved {
  return {
    owner: deps.owner,
    dispatch: deps.dispatch,
    leaseTtlMs: deps.leaseTtlMs ?? DEFAULT_CLAIM_LEASE_MS,
    trigger: deps.trigger ?? "delivery",
    ...(deps.waitOutcome ? { waitOutcome: deps.waitOutcome } : {}),
    readLaunch: deps.readLaunch ?? ((id) => realReadLaunch(id)),
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

/** CP4 (generalized): the surface carries the COMPLETE phase-bound identity AND the
 *  EXPECTED consumer kind. Reject a partial (launch-id-only) shape, or a wrong-consumer
 *  identity, BEFORE any store touch. Each adapter binds its own expected kind. */
export function assertFullIdentity(
  identity: Partial<ContinuationIdentity>,
  expectedKind: ConsumerKind,
): asserts identity is ContinuationIdentity {
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
      `consumer-core: incomplete continuation identity (missing: ${missing.join(", ")}). ` +
        `A launch-id-only surface is non-conforming — the claim is phase-bound and requires the ` +
        `full identity (continuationId, sourceLaunchId, consumerKind, currentPhase, nextAction).`,
    );
  }
  if (identity.consumerKind !== expectedKind) {
    throw new Error(
      `consumer-core: this is the ${expectedKind.toUpperCase()} consumer (consumerKind='${expectedKind}'); ` +
        `got '${identity.consumerKind}'.`,
    );
  }
}

/**
 * The shared continuation-consume engine, invoked on every wake (normal delivery OR
 * watchdog). Idempotent and crash-safe: a duplicate wake or watchdog re-fire produces
 * exactly ONE claim and ONE advance. The caller (adapter) has already asserted the
 * full identity for its expected consumer kind.
 */
export function consumeCore(identity: ContinuationIdentity, deps: CoreConsumeDeps): ConsumeOutcome {
  const d = resolve(deps);

  // BD-7/BD-3: a WAITER-CONTROL outcome (timed out / cancelled / unknown launch) is NOT a
  // launch disposition and NEVER advances. Re-observe the canonical record and re-arm.
  if (d.waitOutcome && d.waitOutcome.kind !== "terminal") {
    const controlView = d.readLaunch(identity.sourceLaunchId);
    if (!controlView) return { kind: "rearmed", reason: "unknown_launch" };
    const reason = d.waitOutcome.kind === "unknown_launch" ? "unknown_launch" : "still_running";
    return { kind: "rearmed", reason, status: controlView.status };
  }

  // BD-3 (CP3): re-derive the disposition from the AUTHORITATIVE launch record — a
  // fabricated 'exited_ok' handed to this consumer has ZERO effect (we ignore it and
  // read the record ourselves).
  const view = d.readLaunch(identity.sourceLaunchId);
  if (view === undefined) return { kind: "rearmed", reason: "unknown_launch" };
  const disposition = deriveTerminalDisposition(view);
  if (!disposition.terminal) {
    return { kind: "rearmed", reason: "still_running", status: disposition.status };
  }
  const status = disposition.status;

  const pre = d.getContinuation(identity.continuationId);
  if (pre && pre.state === "advanced") {
    return { kind: "already_advanced", continuation: pre };
  }

  // BD-3 evidence: record the authoritative, launch-bound observation
  // (awaiting_completion -> ready). Terminality is derived via the one canonical classifier.
  d.observeLaunchStatus(identity.continuationId, identity.sourceLaunchId, status.state);

  // FIX1 / BD-4 (record-before-advance): on the WATCHDOG path the durable lost-signal
  // audit row MUST commit BEFORE the advance is observable — so hand dispatchAndAdvance a
  // hook it fires AFTER winning the claim + dispatching but STRICTLY BEFORE markAdvanced.
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

/** FIX2 / BD-3 / F22: re-derive the authoritative disposition the SAME way the canonical
 *  waiter does — a real terminal `status`, OR a reconciled PERSISTENTLY-unreadable terminal
 *  (owner_gone/unknown) surfaced via `pendingUnreadableExit`. A bare isTerminalStatus would
 *  strand a reconciled owner-gone launch (BD-7). */
export function deriveTerminalDisposition(
  view: LaunchView,
): { terminal: true; status: LaunchStatus } | { terminal: false; status: LaunchStatus } {
  if (isTerminalStatus(view.status)) return { terminal: true, status: view.status };
  if (view.pendingUnreadableExit) return { terminal: true, status: view.pendingUnreadableExit.terminal };
  return { terminal: false, status: view.status };
}

/**
 * CP4 + F17: claim exactly-once, then ADOPT-not-duplicate through the INJECTED dispatch.
 * Shared by the normal wake path and the restart-replay recovery path.
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
    return { kind: "lost_claim", continuation: outcome.continuation };
  }

  // An ADOPT (F16/F17 recovery of an existing receipt) requires we OWN the lease.
  if (outcome.disposition === "adopt") {
    if (outcome.continuation.claimOwner === d.owner) {
      // Same-owner restart-adoption: re-adopt by renewing OUR OWN lease (owner-scoped).
      if (!d.renewClaim(identity.continuationId, d.owner, d.leaseTtlMs)) {
        return { kind: "lost_claim", continuation: d.getContinuation(identity.continuationId) };
      }
    } else {
      // A DIFFERENT owner holds it — only an EXPIRED lease may be taken over.
      const takeover = d.claimContinuationDispatch({ ...claimReq, expectedState: "dispatching" });
      if (!takeover.granted) {
        return { kind: "lost_claim", continuation: takeover.continuation };
      }
    }
  }

  // We own the lease. The INJECTED dispatch performs check-before-spawn and returns the
  // resulting ids, or THROWS on a recoverable failure (genuine dispatch error, or a
  // campaign `lost`/fenced reservation). A throw leaves the slot IN-FLIGHT and returns
  // `blocked` — recoverable by a watchdog re-fire AND recoverInFlightDispatches, never
  // falsely advanced.
  const recorded = {
    ...(outcome.disposition === "adopt" && outcome.continuation.dispatchedRunId
      ? { runId: outcome.continuation.dispatchedRunId }
      : {}),
    ...(outcome.disposition === "adopt" && outcome.continuation.dispatchedTaskId
      ? { taskId: outcome.continuation.dispatchedTaskId }
      : {}),
  };
  let ids: { runId?: string; taskId?: string };
  try {
    ids = d.dispatch({
      nextAction: identity.nextAction,
      dispatchKey,
      continuationId: identity.continuationId,
      sourceLaunchId: identity.sourceLaunchId,
      currentPhase: identity.currentPhase,
      adopting: outcome.disposition === "adopt",
      recorded,
    });
  } catch (e) {
    return { kind: "blocked", continuation: d.getContinuation(identity.continuationId), error: (e as Error).message };
  }

  // Renew the lease across the dispatch->settle window (owner-scoped). A concurrent
  // takeover between our claim and our settle makes this false — bail BEFORE the
  // audit-write and the advance so a lease-losing watchdog writes NO false recovery row.
  if (!d.renewClaim(identity.continuationId, d.owner, d.leaseTtlMs)) {
    return { kind: "lost_claim", continuation: d.getContinuation(identity.continuationId) };
  }

  d.recordDispatchResult(identity.continuationId, d.owner, ids);

  if (onBeforeAdvance) onBeforeAdvance({ dispatchKey, ids });

  const advanced = d.markAdvanced(identity.continuationId, d.owner, ids);
  const continuation = d.getContinuation(identity.continuationId);
  if (!advanced || !continuation) {
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
 * F17 restart-replay recovery, consumer-scoped. On controller restart, adopt every
 * in-flight (claimed-but-not-advanced) dispatch for THIS consumer via
 * continuationsInDispatch + the receipt — NEVER spawn a second physical run.
 */
export function recoverInFlightCore(
  deps: Omit<CoreConsumeDeps, "trigger">,
  consumerKind: ConsumerKind,
): ConsumeOutcome[] {
  const d = resolve({ ...deps, trigger: "delivery" });
  const inFlight = d.continuationsInDispatch({ consumerKind });
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
