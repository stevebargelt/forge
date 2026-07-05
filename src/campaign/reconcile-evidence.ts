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
  // FG-427: which reviewing task this verdict belongs to. Optional for backward
  // compatibility with callers/fixtures that predate per-task grouping — every
  // event missing taskId is bucketed together under one shared "no task" bucket
  // (see evaluateAuthoritativeOutcome below), never merged with any real taskId's
  // bucket.
  taskId?: string;
};

export type ReconcileGateEvent = {
  id: number;
  kind: "gate";
  decision: GateDecision;
  rationale?: string;
  force: boolean;
  // FG-427: see ReconcileVerdictEvent.taskId above.
  taskId?: string;
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
  // FG-458: the run's OWN authoritative-review outcome, folded into an out-of-band
  // item's eligibility with a `run_evidence:` prefix (see
  // authoritativeOutcomeContribution). The suffix is the underlying reconcile
  // reason code. A prefix, not a fixed value, so it's matched before the switch.
  if (reason.startsWith("run_evidence:")) {
    const inner = reason.slice("run_evidence:".length);
    return (
      `${reason} (the run's own authoritative review is unresolved: ${inner} — the ` +
      "out-of-band item shares that run, so the run must reach a passing (or force-advanced) " +
      "review before it can ship; resolve the run's review, don't wait it out or override)"
    );
  }
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
    // FG-452: the docs-only out-of-band lane isn't satisfied AND no covering
    // passing host-verification row exists yet. Tone matches report.ts's hint.
    case "lane_evidence_missing":
      return (
        "lane_evidence_missing (no covering passing host-verification row recorded yet for this " +
        "out-of-band delivery — run `forge campaign reconcile` to capture a real host-verification gate and re-check)"
      );
    default:
      return reason;
  }
}

function isQualifyingForceAdvance(e: ReconcileGateEvent): boolean {
  return e.decision === "advance" && e.force === true && !!e.rationale && e.rationale.trim().length > 0;
}

// Events missing taskId (pre-FG-427 callers/fixtures) all fall into this one
// shared bucket — grouped with each other exactly as before, but never merged
// with any bucket keyed by a real taskId.
const NO_TASK_BUCKET = "__no_task__";

function taskBucketKey(e: ReconcileRunEvent): string {
  return e.taskId ?? NO_TASK_BUCKET;
}

// FG-458/FG-460: the subset of evaluateReconcileEvidence's `missing` reason
// codes that are specific to the run's OWN authoritative-review outcome (its
// Fact 5). The out-of-band composition (reconcile.ts's isOutOfBand branch AND
// `forge campaign resume`'s FG-441 reattach path — see composeOutOfBandEligibility
// in reconcile-outofband-evidence.ts) folds ONLY these codes in, so the two
// paths agree on the authoritative-outcome axis by construction. Deliberately
// excludes the other four facts (ticket status, closed-commit presence/
// reachability, host-verification): those are independently re-derived by the
// out-of-band evaluator from the same underlying data — and folding
// host-verification in here specifically would be self-defeating (a not-yet-
// captured item would show host_verification_not_recorded forever, blocking the
// very capture meant to resolve it). Single exported definition — reconcile.ts,
// report.ts, and the resume path all import THIS one (previously duplicated).
export const AUTHORITATIVE_OUTCOME_MISSING_CODES: ReadonlySet<string> = new Set([
  "no_authoritative_verdict_or_force_advance_event",
  "latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance",
]);

export type AuthoritativeOutcome = "pass" | "fail" | "unresolved";

export type AuthoritativeOutcomeResult = {
  outcome: AuthoritativeOutcome;
  supersedingEventsByTask: Map<string, ReconcileRunEvent>;
};

// FG-427: the SINGLE shared evaluator for "did this item's authoritative
// review pass" — used by both the `forge campaign reconcile` command (Fact 5,
// below) and the drive/resume-path reconciliation in executor.ts, so the two
// paths cannot drift.
//
// Resolved PER REVIEWING TASK, not by a single run-wide MAX(id): a later
// authoritative pass on one task must never be masked by — nor mask — an
// unresolved authoritative fail on a different task in the same run. Within a
// task's bucket, the highest-id event among {authoritative verdicts} ∪
// {qualifying force-advances} wins (MAX(id), never array order — event arrays
// are sorted by created_at first, id only a tiebreak, so a later event can
// carry an earlier-or-equal timestamp).
//
// A qualifying force-advance can only ever supersede an EXISTING authoritative
// verdict on the same task — a task with zero authoritative verdicts on record
// gets no credit from a force-advance alone (closes the abuse gap where an
// operator could force-advance a task that was never actually reviewed).
export function evaluateAuthoritativeOutcome(events: ReconcileRunEvent[]): AuthoritativeOutcomeResult {
  const byTask = new Map<string, ReconcileRunEvent[]>();
  for (const e of events) {
    const isAuthoritativeVerdict = e.kind === "verdict" && e.authority === "authoritative";
    const isQualifyingGate = e.kind === "gate" && isQualifyingForceAdvance(e);
    if (!isAuthoritativeVerdict && !isQualifyingGate) continue;
    const key = taskBucketKey(e);
    const bucket = byTask.get(key);
    if (bucket) {
      bucket.push(e);
    } else {
      byTask.set(key, [e]);
    }
  }

  const supersedingEventsByTask = new Map<string, ReconcileRunEvent>();
  let anyTaskWithAuthoritativeVerdict = false;
  let anyTaskFailed = false;

  for (const [key, bucket] of byTask) {
    const hasAuthoritativeVerdict = bucket.some((e) => e.kind === "verdict" && e.authority === "authoritative");
    if (!hasAuthoritativeVerdict) {
      // Force-advance(s) only, no authoritative verdict recorded for this task —
      // contributes nothing to resolution.
      continue;
    }
    anyTaskWithAuthoritativeVerdict = true;
    const highest = bucket.reduce((a, b) => (b.id > a.id ? b : a));
    const resolvesPass = highest.kind === "gate" || (highest.kind === "verdict" && highest.verdict === "pass");
    if (resolvesPass) {
      supersedingEventsByTask.set(key, highest);
    } else {
      anyTaskFailed = true;
    }
  }

  let outcome: AuthoritativeOutcome;
  if (!anyTaskWithAuthoritativeVerdict) {
    outcome = "unresolved";
  } else if (anyTaskFailed) {
    outcome = "fail";
  } else {
    outcome = "pass";
  }

  return { outcome, supersedingEventsByTask };
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

  // Fact 5 — supersession, evaluated per reviewing task by the shared
  // evaluateAuthoritativeOutcome (see above) — the same function the drive-path
  // reconciliation in executor.ts uses, so the two paths cannot drift.
  const { outcome, supersedingEventsByTask } = evaluateAuthoritativeOutcome(input.events);

  let supersedingEvent: ReconcileRunEvent | null = null;
  if (outcome === "unresolved") {
    missing.push("no_authoritative_verdict_or_force_advance_event");
  } else if (outcome === "fail") {
    missing.push("latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance");
  } else {
    // Representative superseding event for existing consumers of
    // evidence.supersedingEvent — the highest-id winner across all
    // resolved-pass tasks.
    supersedingEvent = [...supersedingEventsByTask.values()].reduce((a, b) => (b.id > a.id ? b : a));
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
