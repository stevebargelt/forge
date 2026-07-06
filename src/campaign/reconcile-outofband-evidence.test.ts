import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOutOfBandEvidence,
  authoritativeOutcomeContribution,
  composeOutOfBandEligibility,
} from "./reconcile-outofband-evidence.js";
import type { OutOfBandEvidenceInput } from "./reconcile-outofband-evidence.js";
import type { ReconcileEvidenceInput } from "./reconcile-evidence.js";

function baseInput(): OutOfBandEvidenceInput {
  return {
    ticketStatus: "done",
    ticketClosedCommit: "abc123",
    closedCommitReachableOnBase: true,
    laneEvidence: { kind: "non_code_diff" },
  };
}

test("all facts satisfied (docs lane) → eligible, no missing", () => {
  const result = evaluateOutOfBandEvidence(baseInput());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.evidence.ticketStatus, "done");
  assert.equal(result.evidence.closedCommit, "abc123");
  assert.deepEqual(result.evidence.laneEvidence, { kind: "non_code_diff" });
});

test("all facts satisfied (host-verification lane) → eligible, no missing", () => {
  const result = evaluateOutOfBandEvidence({
    ...baseInput(),
    laneEvidence: { kind: "host_verification", recorded: true, allExitZero: true },
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.missing, []);
});

test("ticket.status !== 'done' → ineligible with ticket_status_not_done", () => {
  const result = evaluateOutOfBandEvidence({ ...baseInput(), ticketStatus: "active" });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["ticket_status_not_done"]);
});

test("ticket.closedCommit absent → ineligible with ticket_closed_commit_missing", () => {
  const result = evaluateOutOfBandEvidence({ ...baseInput(), ticketClosedCommit: undefined });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["ticket_closed_commit_missing"]);
});

test("closedCommitReachableOnBase !== true → ineligible with closed_commit_not_reachable_on_base_branch", () => {
  const falseCase = evaluateOutOfBandEvidence({ ...baseInput(), closedCommitReachableOnBase: false });
  assert.equal(falseCase.eligible, false);
  assert.deepEqual(falseCase.missing, ["closed_commit_not_reachable_on_base_branch"]);

  const nullCase = evaluateOutOfBandEvidence({ ...baseInput(), closedCommitReachableOnBase: null });
  assert.equal(nullCase.eligible, false);
  assert.deepEqual(nullCase.missing, ["closed_commit_not_reachable_on_base_branch"]);
});

test("laneEvidence null → ineligible with lane_evidence_missing", () => {
  const result = evaluateOutOfBandEvidence({ ...baseInput(), laneEvidence: null });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["lane_evidence_missing"]);
});

test("all facts missing at once → all four missing codes reported", () => {
  const result = evaluateOutOfBandEvidence({
    ticketStatus: "active",
    ticketClosedCommit: undefined,
    closedCommitReachableOnBase: null,
    laneEvidence: null,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, [
    "ticket_status_not_done",
    "ticket_closed_commit_missing",
    "closed_commit_not_reachable_on_base_branch",
    "lane_evidence_missing",
  ]);
});

// ── type-level guard: OutOfBandEvidenceInput has no `events` field ────────────
//
// evaluateReconcileEvidence's ReconcileEvidenceInput carries an `events` field
// used to derive supersession (fact 5). The out-of-band shape must never accept
// that field — the item's own run never produced the delivering work, so run
// events must not be usable as a substitute for real evidence. TypeScript's
// excess-property check on an object literal enforces this at compile time
// (caught by `npm run typecheck`, not by `node --test`).
test("type-level: OutOfBandEvidenceInput rejects an `events` property (compile-time guard)", () => {
  const withEvents: OutOfBandEvidenceInput = {
    ticketStatus: "done",
    ticketClosedCommit: "abc123",
    closedCommitReachableOnBase: true,
    laneEvidence: { kind: "non_code_diff" },
    // @ts-expect-error — `events` is not part of OutOfBandEvidenceInput; passing it
    // must fail to typecheck even though the other required fields are present.
    events: [],
  };
  // Runtime is irrelevant here — evaluateOutOfBandEvidence ignores unknown
  // properties — this test's value is entirely the @ts-expect-error above.
  assert.equal(evaluateOutOfBandEvidence(withEvents).eligible, true);
});

// ── FG-473: "no authoritative reviewer ran at all" is not an objection ───────

function reconcileBaseInput(): ReconcileEvidenceInput {
  return {
    ticketStatus: "done",
    ticketClosedCommit: "abc123",
    closedCommitReachableOnBase: true,
    hostVerification: { recorded: true, passed: true },
    events: [],
  };
}

test("FG-473: authoritativeOutcomeContribution with ZERO authoritative-verdict events → no missing codes (invoke-lane runs never produce a reviewer verdict)", () => {
  const result = authoritativeOutcomeContribution(reconcileBaseInput());
  assert.deepEqual(result.missing, [], "no authoritative reviewer ever ran — that absence is no-objection, not a blocker");
});

test("FG-473 regression: authoritativeOutcomeContribution STILL folds in an unresolved authoritative FAIL", () => {
  const input: ReconcileEvidenceInput = {
    ...reconcileBaseInput(),
    events: [{ id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" }],
  };
  const result = authoritativeOutcomeContribution(input);
  assert.deepEqual(result.missing, [
    "run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance",
  ]);
});

test("FG-473 regression: authoritativeOutcomeContribution STILL folds in an unresolved authoritative INCONCLUSIVE verdict", () => {
  const input: ReconcileEvidenceInput = {
    ...reconcileBaseInput(),
    events: [{ id: 1, kind: "verdict", verdict: "inconclusive", authority: "authoritative" }],
  };
  const result = authoritativeOutcomeContribution(input);
  assert.deepEqual(result.missing, [
    "run_evidence:latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance",
  ]);
});

test("FG-473: composeOutOfBandEligibility ships an invoke-lane item (zero authoritative verdicts) with full lane evidence", () => {
  const outOfBand = evaluateOutOfBandEvidence(baseInput());
  const authoritative = authoritativeOutcomeContribution(reconcileBaseInput());
  const composed = composeOutOfBandEligibility({ outOfBand, authoritative, hasRunId: true });
  assert.equal(composed.eligible, true);
  assert.deepEqual(composed.missing, []);
});
