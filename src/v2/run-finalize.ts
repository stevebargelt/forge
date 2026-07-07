// forge v2 — shared settled-finalization helper (FG-484).
//
// Every finalize site (gate's finalizeRunIfDone, runNext's two AWN-2 checks,
// reconcile's active->complete site, invoke's closeRunIfIdle) independently
// decides a run is "settled" and then needs to actually flip it to complete.
// That second half — re-reading the run so a concurrent `forge cancel` isn't
// clobbered, doing the guarded write, and logging run.completed — used to be
// copy-pasted (and, at gate.ts's site, missing the re-read entirely — the
// FG-484 bug). This is the one place that logic lives now.
//
// Callers keep their own settledness predicate (isRunSettled + workflow
// shape, or invoke's top-level-non-terminal-task check) — this helper's only
// job is the guarded completion write plus the run.completed event.

import { getRun, completeRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";

/**
 * Complete a run iff it is currently "active". Re-reads the run so a
 * concurrent `forge cancel` (or an already-completed run) is never
 * resurrected/re-completed. Returns true iff this call actually completed
 * the run; false on any short-circuit.
 *
 * The status write and its run.completed event — plus, via onCompleted, any
 * caller-specific paired audit event such as reconcile's run.reconciled —
 * commit in ONE transaction (FG-463's guarantee, restored here after the
 * FG-484 refactor split them into separate statements): completeRun's CAS
 * runs inside its own transaction, and onApplied (which logs both events)
 * executes inside that same transaction, before commit.
 */
export function finalizeRunIfSettled(
  runId: string,
  logSource: string,
  extraPayload?: Record<string, unknown>,
  onCompleted?: () => void,
): boolean {
  const run = getRun(runId);
  if (!run || run.status !== "active") return false;

  return completeRun(runId, {
    onApplied: () => {
      logEvent("run.completed", { runId, payload: { via: logSource, ...extraPayload } });
      onCompleted?.();
    },
  });
}
