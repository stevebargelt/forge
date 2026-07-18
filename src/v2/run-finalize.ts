// forge v2 — shared settled-finalization helper (FG-484, extended FG-585).
//
// Every finalize site (gate's finalizeRunIfDone, runNext's wave-complete check,
// reconcile's active->terminal site, invoke's closeRunIfIdle) independently
// classifies a run's terminal state (via the ONE shared
// classifyRunTerminalState) and then needs to actually flip the row to that
// state. That second half — re-reading the run so a concurrent `forge cancel`
// isn't clobbered, doing the guarded CAS, and logging the paired lifecycle
// event — lives here, once.
//
// FG-585 added the `failed` terminal state: this helper takes the classified
// TARGET ("complete" | "failed") and does the guarded CAS to it, logging
// run.completed for a success and run.failed (naming the failed + unreachable
// phases) for a failure. The re-read guard against a concurrent abandon stays.

import { getRun, completeRun, failRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";

/**
 * Finalize a run to `target` iff it is currently "active". Re-reads the run so
 * a concurrent `forge cancel` (or an already-terminal run) is never
 * resurrected/re-finalized. Returns true iff this call actually finalized the
 * run; false on any short-circuit.
 *
 * The status write and its lifecycle event (run.completed / run.failed) — plus,
 * via onApplied, any caller-specific paired audit event such as reconcile's
 * run.reconciled — commit in ONE transaction (FG-463): completeRun/failRun's
 * CAS runs inside its own transaction, and onApplied executes inside that same
 * transaction, before commit.
 */
export function finalizeRunIfSettled(
  runId: string,
  target: "complete" | "failed",
  logSource: string,
  extraPayload?: Record<string, unknown>,
  onApplied?: () => void,
): boolean {
  const run = getRun(runId);
  if (!run || run.status !== "active") return false;

  const eventType = target === "failed" ? "run.failed" : "run.completed";
  const write = target === "failed" ? failRun : completeRun;
  return write(runId, {
    onApplied: () => {
      logEvent(eventType, { runId, payload: { via: logSource, ...extraPayload } });
      onApplied?.();
    },
  });
}
