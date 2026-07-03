// FG-428: pure evidence evaluator for `forge campaign reconcile`.
//
// Re-derives whether a campaign item wedged on a stale historical authoritative
// red-fail can be marked shipped, from durable machine-checked facts ONLY. This
// function accepts no operator-supplied evidence ARGUMENT — every input is a
// fact gathered elsewhere (reconcile-collect.ts) from the ticket store, git,
// the host-verification table, and the run's event log. Two of those facts
// (ticketStatus, ticketClosedCommit — see facts 1-2 below) originate in
// hand-editable ticket frontmatter, but the AND-gate still requires them to be
// cross-checked against non-editable git+DB evidence (facts 3-5), and
// ticketClosedCommit is the exact key the host-verification lookup is bound to
// (see reconcile-collect.ts) — so frontmatter alone can never satisfy the gate.

import type { GateDecision } from "../types/index.js";

export type ReconcileVerdictEvent = {
  id: number;
  kind: "verdict";
  verdict: "pass" | "fail" | "inconclusive";
  authority: "authoritative" | "specialist";
};

export type ReconcileGateEvent = {
  id: number;
  kind: "gate";
  decision: GateDecision;
  rationale?: string;
  force: boolean;
};

export type ReconcileRunEvent = ReconcileVerdictEvent | ReconcileGateEvent;

export type ReconcileHostVerificationSummary = {
  // At least one row covers this item (ancestry + base-reachable + gateName
  // match), regardless of its exit code.
  recorded: boolean;
  // At least one COVERING row has exitCode 0. A historical covering failure
  // does not clear this — but it also does not prevent a later covering pass
  // from setting it: existence of a pass is what ships, not unanimity.
  passed: boolean;
};

export type ReconcileEvidenceInput = {
  ticketStatus: string | undefined;
  ticketClosedCommit: string | undefined;
  closedCommitReachableOnBase: boolean | null;
  hostVerification: ReconcileHostVerificationSummary | null;
  // Caller order is NOT trusted — the events table is sorted by created_at first
  // and id only as a tiebreak (see eventsForRun/eventsForTask), so a later event
  // can carry an earlier-or-equal timestamp. The evaluator below selects the
  // qualifying event by explicit MAX(id), never by array position.
  events: ReconcileRunEvent[];
};

export type ReconcileEvidence = {
  ticketStatus: string | null;
  closedCommit: string | null;
  closedCommitReachableOnBase: boolean | null;
  hostVerification: ReconcileHostVerificationSummary | null;
  supersedingEvent: ReconcileRunEvent | null;
};

export type ReconcileEvidenceResult = {
  eligible: boolean;
  missing: string[];
  evidence: ReconcileEvidence;
};

// FG-440: human-readable text for a `missing` reason code, shared by the
// `forge campaign reconcile` CLI output (campaign.ts) and the campaign report
// (report.ts) so both surfaces render the same distinction — "not yet recorded,
// will be captured automatically" is fundamentally different from "ran for real
// and failed," and the latter must never read as something to wait out or
// override. Unrecognized codes pass through unchanged.
export function describeMissingReason(reason: string): string {
  switch (reason) {
    case "host_verification_not_recorded":
      return (
        "host_verification_not_recorded (no real host gate run recorded yet — " +
        "will be captured automatically on the next `forge campaign reconcile` / drive run)"
      );
    case "host_verification_recorded_but_failed":
      return (
        "host_verification_recorded_but_failed (the required gate ran for real and failed — " +
        "fix the failure and re-merge; this is a genuine failure, not something to wait out or override)"
      );
    default:
      return reason;
  }
}

function isQualifyingForceAdvance(e: ReconcileGateEvent): boolean {
  return e.decision === "advance" && e.force === true && !!e.rationale && e.rationale.trim().length > 0;
}

export function evaluateReconcileEvidence(input: ReconcileEvidenceInput): ReconcileEvidenceResult {
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
  // FG-440: split into two reason codes so an operator (and the reconcile-time
  // capture writer) can tell "no real gate run recorded yet — will be captured
  // automatically" apart from "the gate ran for real and failed" — the latter
  // is a genuine failure that must never be rendered as something pending or
  // overridable. This is a passing-row model: `passed` reflects whether ANY
  // covering row is green, not whether every covering row ever recorded is
  // green — a historical failure must never permanently outrank a later real
  // pass (see reconcile.ts's needsCapture, which re-runs the gate exactly
  // when `passed` is false).
  if (!input.hostVerification || !input.hostVerification.recorded) {
    missing.push("host_verification_not_recorded");
  } else if (!input.hostVerification.passed) {
    missing.push("host_verification_recorded_but_failed");
  }

  // Fact 5 — supersession: among authoritative verdicts and qualifying force-advance
  // gate decisions, the highest-id one must be either an authoritative pass or a
  // qualifying force-advance. Selected by explicit MAX(id) comparison below, never
  // by taking the last array element — the caller's array order is not trusted.
  const qualifying = input.events.filter(
    (e): e is ReconcileVerdictEvent | ReconcileGateEvent =>
      (e.kind === "verdict" && e.authority === "authoritative") ||
      (e.kind === "gate" && isQualifyingForceAdvance(e))
  );

  let supersedingEvent: ReconcileRunEvent | null = null;
  if (qualifying.length === 0) {
    missing.push("no_authoritative_verdict_or_force_advance_event");
  } else {
    const highest = qualifying.reduce((a, b) => (b.id > a.id ? b : a));
    const supersedes = highest.kind === "gate" || (highest.kind === "verdict" && highest.verdict === "pass");
    if (supersedes) {
      supersedingEvent = highest;
    } else {
      missing.push("latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance");
    }
  }

  return {
    eligible: missing.length === 0,
    missing,
    evidence: {
      ticketStatus: input.ticketStatus ?? null,
      closedCommit: input.ticketClosedCommit ?? null,
      closedCommitReachableOnBase: input.closedCommitReachableOnBase,
      hostVerification: input.hostVerification,
      supersedingEvent,
    },
  };
}
