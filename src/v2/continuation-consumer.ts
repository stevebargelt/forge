// FG-563 (Slice 4): the interactive orchestrator's durable continuation CONSUMER.
//
// FG-564 (Slice 5b, AC6): the claim/adopt/observe control flow was EXTRACTED into the
// shared `consumer-core` module (consumed by both the orchestrator and the campaign
// controller — one module, not a copy). This file is now the ORCHESTRATOR ADAPTER over
// that core: it binds the expected consumer kind, and it wraps the raw run-creation
// dispatch with the orchestrator's receipt-keyed check-before-spawn (runByDispatchKey) —
// the behavior that keys the physical run on the FG-562 continuation receipt. The campaign
// adapter (FG-564 continuation-adapter.ts) instead keys its physical run on the FG-596
// reservation; that branch lives entirely in the injected PhysicalDispatch, per AC6.
//
// The end-to-end contract is unchanged: on wake the consumer RE-READS the canonical
// launch record (BD-3), claims exactly-once (FG-562 phase-bound CAS), ADOPTS an existing
// run rather than duplicating (F17), and — on the watchdog path — records a durable
// lost-signal audit row before the advance is observable (BD-4).

import {
  consumeCore,
  recoverInFlightCore,
  assertFullIdentity as coreAssertFullIdentity,
  deriveTerminalDisposition as coreDeriveTerminalDisposition,
  DEFAULT_CLAIM_LEASE_MS,
  LOST_SIGNAL_WATCHDOG_INTERVAL_MS,
  type ConsumeOutcome,
  type ContinuationIdentity,
  type CoreConsumeDeps,
  type PhysicalDispatch,
  type WakeTrigger,
} from "./consumer-core.js";
import { runByDispatchKey as realRunByDispatchKey } from "../store/runs.js";

export {
  DEFAULT_CLAIM_LEASE_MS,
  LOST_SIGNAL_WATCHDOG_INTERVAL_MS,
  type ConsumeOutcome,
  type ContinuationIdentity,
  type PhysicalDispatch,
  type WakeTrigger,
};

/** The orchestrator adapter's deps: the shared core deps plus the orchestrator-only
 *  `runByDispatchKey` seam that keys check-before-spawn on the FG-562 continuation receipt. */
export type ConsumeDeps = CoreConsumeDeps & {
  runByDispatchKey?: (dispatchKey: string) => { id: string } | undefined;
};

/** CP4: the orchestrator surface carries the COMPLETE phase-bound identity and MUST be
 *  consumerKind='orchestrator'. Delegates to the generalized core guard. */
export function assertFullIdentity(identity: Partial<ContinuationIdentity>): asserts identity is ContinuationIdentity {
  coreAssertFullIdentity(identity, "orchestrator");
}

export const deriveTerminalDisposition = coreDeriveTerminalDisposition;

/**
 * Wrap the raw orchestrator run-creation dispatch with receipt-keyed check-before-spawn
 * (F17). The orchestrator's physical run key IS the FG-562 continuation receipt: resolve
 * an already-created run by that receipt (adopt it, never duplicate); adopt recorded ids
 * on the crash-after-record path; else create now. A duplicate-insert constraint race
 * (two same-owner controllers) re-resolves to the winner's run rather than duplicating.
 */
function orchestratorDispatch(
  rawDispatch: PhysicalDispatch,
  runByDispatchKey: (dispatchKey: string) => { id: string } | undefined,
): PhysicalDispatch {
  return (args) => {
    const existing = runByDispatchKey(args.dispatchKey);
    if (existing) return { runId: existing.id };
    if (args.adopting && (args.recorded.runId || args.recorded.taskId)) {
      return {
        ...(args.recorded.runId ? { runId: args.recorded.runId } : {}),
        ...(args.recorded.taskId ? { taskId: args.recorded.taskId } : {}),
      };
    }
    try {
      return rawDispatch(args);
    } catch (e) {
      // The runs UNIQUE(dispatch_key) index may have rejected our duplicate insert because
      // a concurrent same-owner controller already created the run under this receipt. That
      // is the exactly-one-run-per-receipt guarantee firing, not a failure to recover from —
      // re-resolve by the receipt and adopt the winner. A genuine (non-collision) failure
      // re-throws, which the core turns into a recoverable `blocked`.
      const raced = runByDispatchKey(args.dispatchKey);
      if (raced) return { runId: raced.id };
      throw e;
    }
  };
}

function coreDeps(deps: ConsumeDeps): CoreConsumeDeps {
  const runByKey =
    deps.runByDispatchKey ??
    ((key: string) => {
      const r = realRunByDispatchKey(key);
      return r ? { id: r.id } : undefined;
    });
  const { runByDispatchKey: _omit, ...rest } = deps;
  return { ...rest, dispatch: orchestratorDispatch(deps.dispatch, runByKey) };
}

/**
 * The orchestrator continuation-consumer operation, invoked on every wake. Idempotent
 * and crash-safe: a duplicate wake or watchdog re-fire produces exactly ONE claim and
 * ONE advance.
 */
export function consumeContinuation(identity: ContinuationIdentity, deps: ConsumeDeps): ConsumeOutcome {
  assertFullIdentity(identity);
  return consumeCore(identity, coreDeps(deps));
}

/**
 * F17 restart-replay recovery for the orchestrator: adopt every in-flight (claimed-but-
 * not-advanced) orchestrator dispatch via the receipt — NEVER spawn a second physical run.
 */
export function recoverInFlightDispatches(deps: Omit<ConsumeDeps, "trigger">): ConsumeOutcome[] {
  return recoverInFlightCore(coreDeps(deps as ConsumeDeps), "orchestrator");
}
