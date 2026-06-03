// Ops intelligence substrate (#250) — the single choke point every detector
// routes through to emit an Incident. The invariant guard here is load-bearing:
// it is what lets the orchestrator trust an `auto-safe` action without re-deriving
// confidence itself. A pure type union would be bypassable by a cast and unwieldy
// across the kinds; one runtime factory centralizes the rule at exactly one place.

import type { Incident } from "../types/index.js";

/** Construct + validate an Incident. Throws on an invariant violation — these are
 *  programmer errors (a detector author wired confidence/action wrong), so failing
 *  loud at construction is correct, not a runtime data condition to tolerate. */
export function makeIncident(incident: Incident): Incident {
  const { kind, confidence, recommendedAction } = incident;

  // The core safety invariant: only a `db-confirmed` incident may carry an
  // `auto-safe` action. You cannot safely auto-act on a condition the DB can't
  // fully confirm (db-candidate / external-required).
  if (confidence !== "db-confirmed" && recommendedAction.autonomy === "auto-safe") {
    throw new Error(
      `ops incident invariant: ${kind} is ${confidence} but recommends an auto-safe action; only db-confirmed incidents may be auto-safe`
    );
  }

  // `repair_unavailable` means there is nothing to run — it must not smuggle a
  // command (which a consumer might execute).
  if (recommendedAction.type === "repair_unavailable" && recommendedAction.command !== null) {
    throw new Error(
      `ops incident invariant: ${kind} is repair_unavailable but carries a command; it must be null`
    );
  }

  return incident;
}
