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
