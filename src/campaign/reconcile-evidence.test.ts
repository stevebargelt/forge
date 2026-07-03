import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReconcileEvidence, describeMissingReason } from "./reconcile-evidence.js";
import type { ReconcileEvidenceInput, ReconcileRunEvent } from "./reconcile-evidence.js";

// All-facts-satisfied baseline: a stale authoritative fail (id 1) superseded by a
// later authoritative pass (id 2). Each test below knocks out exactly one fact.
function baseInput(): ReconcileEvidenceInput {
  return {
    ticketStatus: "done",
    ticketClosedCommit: "abc123",
    closedCommitReachableOnBase: true,
    hostVerification: { recorded: true, passed: true },
    events: [
      { id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "verdict", verdict: "pass", authority: "authoritative" },
    ],
  };
}

test("all five facts satisfied → eligible, no missing", () => {
  const result = evaluateReconcileEvidence(baseInput());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.evidence.ticketStatus, "done");
  assert.equal(result.evidence.closedCommit, "abc123");
  assert.equal(result.evidence.supersedingEvent?.id, 2);
});

// ── each of the 5 facts missing, in isolation ──────────────────────────────────

test("fact 1 missing: ticket.status !== 'done' → ineligible with ticket_status_not_done", () => {
  const input = { ...baseInput(), ticketStatus: "active" };
  const result = evaluateReconcileEvidence(input);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["ticket_status_not_done"]);
});

test("fact 2 missing: ticket.closedCommit absent → ineligible with ticket_closed_commit_missing", () => {
  const input = { ...baseInput(), ticketClosedCommit: undefined };
  const result = evaluateReconcileEvidence(input);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["ticket_closed_commit_missing"]);
});

test("fact 3 missing: closedCommitReachableOnBase !== true → ineligible with closed_commit_not_reachable_on_base_branch", () => {
  const falseCase = evaluateReconcileEvidence({ ...baseInput(), closedCommitReachableOnBase: false });
  assert.equal(falseCase.eligible, false);
  assert.deepEqual(falseCase.missing, ["closed_commit_not_reachable_on_base_branch"]);

  const nullCase = evaluateReconcileEvidence({ ...baseInput(), closedCommitReachableOnBase: null });
  assert.equal(nullCase.eligible, false);
  assert.deepEqual(nullCase.missing, ["closed_commit_not_reachable_on_base_branch"]);
});

// FG-440: fact 4 splits into two distinct reason codes — "not yet recorded"
// (nothing has run, eligible for reconcile-time capture) vs "recorded but the
// real run failed" (a genuine failure, never conflated with the former).
test("fact 4a missing: no host-verification rows at all → ineligible with host_verification_not_recorded", () => {
  const notRecorded = evaluateReconcileEvidence({ ...baseInput(), hostVerification: null });
  assert.equal(notRecorded.eligible, false);
  assert.deepEqual(notRecorded.missing, ["host_verification_not_recorded"]);

  const recordedFalse = evaluateReconcileEvidence({
    ...baseInput(),
    hostVerification: { recorded: false, passed: false },
  });
  assert.equal(recordedFalse.eligible, false);
  assert.deepEqual(recordedFalse.missing, ["host_verification_not_recorded"]);
});

test("fact 4b missing: rows recorded but none passing → ineligible with host_verification_recorded_but_failed, distinct from not_recorded", () => {
  const recordedButFailing = evaluateReconcileEvidence({
    ...baseInput(),
    hostVerification: { recorded: true, passed: false },
  });
  assert.equal(recordedButFailing.eligible, false);
  assert.deepEqual(recordedButFailing.missing, ["host_verification_recorded_but_failed"]);
});

test("describeMissingReason: not_recorded and recorded_but_failed render distinct operator-facing text", () => {
  const notRecordedText = describeMissingReason("host_verification_not_recorded");
  const recordedFailedText = describeMissingReason("host_verification_recorded_but_failed");

  assert.notEqual(notRecordedText, recordedFailedText);
  assert.match(notRecordedText, /forge campaign reconcile/, "not_recorded must point at the automatic capture path");
  assert.match(recordedFailedText, /ran for real and failed/, "recorded_but_failed must read as a genuine failure");
  assert.doesNotMatch(recordedFailedText, /will be captured/i, "a real failure must never suggest waiting for automatic capture");
});

test("describeMissingReason: unrecognized codes pass through unchanged", () => {
  assert.equal(describeMissingReason("ticket_status_not_done"), "ticket_status_not_done");
});

test("fact 5 missing: no authoritative verdict or force-advance event at all → ineligible with no_authoritative_verdict_or_force_advance_event", () => {
  const input = { ...baseInput(), events: [] as ReconcileRunEvent[] };
  const result = evaluateReconcileEvidence(input);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["no_authoritative_verdict_or_force_advance_event"]);
});

// ── supersession combinations ──────────────────────────────────────────────────

test("fail-then-later-pass: eligible", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "verdict", verdict: "pass", authority: "authoritative" },
    ],
  });
  assert.equal(result.eligible, true);
});

test("fail-then-force-advance (qualifying): eligible", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "gate", decision: "advance", force: true, rationale: "operator override: verified out of band" },
    ],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.evidence.supersedingEvent?.id, 2);
});

test("fail-with-no-later-event: ineligible with latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [{ id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" }],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);
});

test("fail-then-force-advance-without-rationale: does not count as qualifying → ineligible", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "gate", decision: "advance", force: true, rationale: "" },
    ],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);
});

test("fail-then-force-advance-without-force: does not count as qualifying → ineligible", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "gate", decision: "advance", force: false, rationale: "human said ok, but forgot --force" },
    ],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);
});

test("pass-with-no-prior-fail: eligible", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [{ id: 1, kind: "verdict", verdict: "pass", authority: "authoritative" }],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.evidence.supersedingEvent?.id, 1);
});

test("ordering is by event id, not array order: a lower-id pass after a higher-id fail must still refuse", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 5, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "verdict", verdict: "pass", authority: "authoritative" },
    ],
  });
  assert.equal(result.eligible, false, "highest event id (5, fail) must win even though it is listed first");
});

test("id wins over timestamp: a higher-id authoritative fail with an earlier-or-equal created_at than a lower-id authoritative pass must still be selected as superseding — item stays ineligible", () => {
  // eventsForRun sorts `ORDER BY created_at ASC, id ASC` — created_at first, id only
  // a tiebreak. A stale-fail-carries-earlier-timestamp inversion means the higher-id
  // fail can sort BEFORE the lower-id pass in the array the producer hands back. The
  // evaluator must not be fooled by that array position: it selects by MAX(id) only.
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 7, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 3, kind: "verdict", verdict: "pass", authority: "authoritative" },
    ],
  });
  assert.equal(result.eligible, false, "higher event id (7, fail) must win even though its created_at ties/precedes the pass's");
  assert.deepEqual(result.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);
  assert.equal(result.evidence.supersedingEvent, null);
});

test("specialist fail does not count as a qualifying event and does not block a later authoritative pass", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "verdict", verdict: "fail", authority: "specialist" },
      { id: 3, kind: "verdict", verdict: "pass", authority: "authoritative" },
    ],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.evidence.supersedingEvent?.id, 3);
});

test("reject/request-changes gate decisions never qualify as supersession even with force+rationale", () => {
  const result = evaluateReconcileEvidence({
    ...baseInput(),
    events: [
      { id: 1, kind: "verdict", verdict: "fail", authority: "authoritative" },
      { id: 2, kind: "gate", decision: "reject", force: true, rationale: "still rejecting" },
    ],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);
});
