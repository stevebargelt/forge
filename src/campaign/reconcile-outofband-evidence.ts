// FG-443: pure evidence evaluator for the out-of-band completion path.
//
// Re-derives whether a campaign item parked at `awaiting_gate` — because its
// ticket was delivered through a re-routed, non-pipeline lane (e.g. the
// documentation-maintainer lane) rather than the engineer+test-engineer feature
// run that produced the gate — can be marked complete, from durable
// machine-checked facts ONLY. Deliberately carries NO `events` field: the
// item's own run never produced the verdict/gate history
// evaluateReconcileEvidence relies on (the delivering work happened outside
// that run), so this evaluator must not be able to accept run events as a
// substitute for real out-of-band delivery evidence.

import {
  evaluateReconcileEvidence,
  AUTHORITATIVE_OUTCOME_MISSING_CODES,
  type ReconcileEvidenceInput,
} from "./reconcile-evidence.js";

export type OutOfBandLaneEvidence =
  | { kind: "non_code_diff" }
  | { kind: "host_verification"; recorded: true; allExitZero: true };

export type OutOfBandEvidenceInput = {
  ticketStatus: string | undefined;
  ticketClosedCommit: string | undefined;
  closedCommitReachableOnBase: boolean | null;
  laneEvidence: OutOfBandLaneEvidence | null;
};

export type OutOfBandEvidence = {
  ticketStatus: string | null;
  closedCommit: string | null;
  closedCommitReachableOnBase: boolean | null;
  laneEvidence: OutOfBandLaneEvidence | null;
};

export type OutOfBandEvidenceResult = {
  eligible: boolean;
  missing: string[];
  evidence: OutOfBandEvidence;
};

// FG-460/FG-473: the run's authoritative-outcome contribution to an out-of-band
// item's eligibility. An out-of-band item WITH a runId must also agree with its
// run's OWN authoritative-review outcome (the FG-458 fact) — otherwise a path
// could ship a row another path would refuse for an unresolved authoritative
// fail or inconclusive verdict. An item with NO runId was never attached to a
// run (the pure FG-443 delivery case) and contributes nothing here. Only the
// authoritative-outcome codes that represent a REAL objection are folded in
// (see AUTHORITATIVE_OUTCOME_MISSING_CODES) — NOT full events-aware
// eligibility, which would double-count host-verification, and NOT "no
// authoritative reviewer ran at all," which is the normal shape for an
// invoke-lane (quick_implementation) run with no red-team step: that absence
// is no-objection, and the out-of-band lane evidence below is what vouches for
// the work instead. Prefixed `run_evidence:` so a consumer can tell "the run's
// own review is unresolved" apart from "the out-of-band delivery lacks lane
// evidence."
export type AuthoritativeContribution = { missing: string[]; evidence: unknown };

export function authoritativeOutcomeContribution(
  runEventsCollected: ReconcileEvidenceInput | null,
): AuthoritativeContribution {
  if (!runEventsCollected) return { missing: [], evidence: null };
  const evaluated = evaluateReconcileEvidence(runEventsCollected);
  return {
    missing: evaluated.missing
      .filter((m) => AUTHORITATIVE_OUTCOME_MISSING_CODES.has(m))
      .map((m) => `run_evidence:${m}`),
    evidence: evaluated.evidence,
  };
}

// FG-460: the SINGLE shared composition of "is this out-of-band item eligible" —
// out-of-band lane evidence AND (when it has a runId) the run's authoritative
// outcome must both hold. Called by BOTH `forge campaign reconcile` (reconcile.ts
// isOutOfBand branch, with lane evidence gathered AFTER its host-verification
// capture) and `forge campaign resume` (executor.ts FG-441 reattach, with NO
// capture — resume must never run a real host gate). Because both feed the same
// two evaluators into this one function, they cannot reach opposite verdicts for
// the same evidence: the only asymmetry is reconcile's capture step, which can
// turn a code-touching-uncovered item into a covered one before this runs —
// resume deliberately lacks that, so it refuses un-verified code rather than
// shipping it.
export function composeOutOfBandEligibility(input: {
  outOfBand: OutOfBandEvidenceResult;
  authoritative: AuthoritativeContribution;
  hasRunId: boolean;
}): { eligible: boolean; missing: string[]; evidence: unknown } {
  return {
    eligible: input.outOfBand.eligible && input.authoritative.missing.length === 0,
    missing: [...input.outOfBand.missing, ...input.authoritative.missing],
    evidence: input.hasRunId
      ? { ...input.outOfBand.evidence, eventsAware: input.authoritative.evidence }
      : input.outOfBand.evidence,
  };
}

export function evaluateOutOfBandEvidence(input: OutOfBandEvidenceInput): OutOfBandEvidenceResult {
  const missing: string[] = [];

  if (input.ticketStatus !== "done") {
    missing.push("ticket_status_not_done");
  }
  if (!input.ticketClosedCommit) {
    missing.push("ticket_closed_commit_missing");
  }
  if (input.closedCommitReachableOnBase !== true) {
    missing.push("closed_commit_not_reachable_on_base_branch");
  }
  if (!input.laneEvidence) {
    missing.push("lane_evidence_missing");
  }

  return {
    eligible: missing.length === 0,
    missing,
    evidence: {
      ticketStatus: input.ticketStatus ?? null,
      closedCommit: input.ticketClosedCommit ?? null,
      closedCommitReachableOnBase: input.closedCommitReachableOnBase,
      laneEvidence: input.laneEvidence,
    },
  };
}
