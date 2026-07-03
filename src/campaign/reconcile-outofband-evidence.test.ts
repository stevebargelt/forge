import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOutOfBandEvidence } from "./reconcile-outofband-evidence.js";
import type { OutOfBandEvidenceInput } from "./reconcile-outofband-evidence.js";

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
