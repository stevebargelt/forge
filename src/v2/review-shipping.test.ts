// FG-639: Stage 9 — the shipping review's checks (eight since FG-640 added docs_closeout).
//
// PRD #17 is the reason each check is separate and named: a clean ledger with an unproven
// acceptance criterion must BLOCK, and a review that could only say "not shippable" would
// leave an operator guessing which of the reasons applied. Every test below asserts on
// the failing check's ID, not on a boolean.
//
// PRD #11 is the mirror image: a historical fail against a superseded sha must NOT block a
// settled candidate once every finding is settled and the rechecks cover the new sha.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessShippingReview, type ShippingInput } from "./review-shipping.js";
import type { ReviewFinding } from "../store/reviews.js";

const SHA = "final222";
const EXECUTED_AC = {
  kind: "regression_test",
  test_name: "the coordinator never repeats a completed stage",
  runner_output: "ok 1 - the coordinator never repeats a completed stage",
};

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  const ordinal = over.ordinal ?? 1;
  return {
    id: `review-s/RF-${ordinal}`,
    reviewId: "review-s",
    ordinal,
    findingRef: `RF-${ordinal}`,
    summary: `finding ${ordinal}`,
    reachability: "demonstrated",
    sources: [{ redRole: "red-wide" }],
    disposition: "fix_now",
    resolution: "resolved",
    resolvedSha: SHA,
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
    ...over,
  };
}

function input(over: Partial<ShippingInput> = {}): ShippingInput {
  return {
    candidateSha: SHA,
    findings: [finding()],
    verification: { ok: true, sha: SHA, executedRequiredChecks: true, detail: "reused green CI at final222" },
    acceptance: [{ ref: "FG-639 AC 1", verdict: "met", evidence: EXECUTED_AC }],
    tipTrust: { kind: "trusted", reviewedSha: SHA, remoteSha: SHA },
    identity: { continuous: true, detail: "candidate/gate/receipt/publication identity is continuous" },
    contractCoverage: { confirmedSha: SHA, finalSha: SHA, postConfirmationPaths: [], deltaReviewed: true },
    docsCloseout: { assessed: true, gaps: [], detail: "the ticket requires no doc update this run" },
    ...over,
  };
}

function failing(a: ReturnType<typeof assessShippingReview>): string[] {
  return a.checks.filter((c) => !c.ok).map((c) => c.id);
}

test("FG-639: all checks green settles the review, and all of them are reported", () => {
  const a = assessShippingReview(input());
  assert.equal(a.ok, true);
  assert.deepEqual(a.checks.map((c) => c.id), [
    "verification_green",
    "acceptance_mapped",
    "findings_settled",
    "fix_now_resolved",
    "tip_equality",
    "identity_continuity",
    "contract_covers_diff",
    "docs_closeout",
  ]);
});

// FG-640 duty 6. Unassessed and clean are DIFFERENT answers, and only one of them ships.
test("FG-640: a ticket-required docs/closeout gap blocks the shipping review", () => {
  const a = assessShippingReview(input({ docsCloseout: { assessed: true, gaps: ["how-to-testing.md still documents the removed --browser tier"] } }));
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["docs_closeout"]);
});

test("FG-640: docs/closeout NOT assessed is not a clean answer", () => {
  const a = assessShippingReview(input({ docsCloseout: undefined }));
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["docs_closeout"]);
  assert.match(a.checks.find((c) => c.id === "docs_closeout")!.detail, /unasked question is not a clean answer/);
});

test("FG-639 / PRD #17: an UNPROVEN acceptance criterion blocks even with a clean ledger", () => {
  const a = assessShippingReview(input({ findings: [], acceptance: [{ ref: "AC 1", verdict: "unproven" }] }));
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["acceptance_mapped"]);
  assert.equal(a.checks.find((c) => c.id === "findings_settled")?.ok, true, "the ledger really is clean");
});

test("FG-639 / PRD #17: an UNMET acceptance criterion blocks", () => {
  const a = assessShippingReview(input({ acceptance: [{ ref: "AC 1", verdict: "unmet" }] }));
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["acceptance_mapped"]);
});

test("FG-639 / PRD #17: NO acceptance mapping at all blocks — a clean ledger is not proof of the work", () => {
  const a = assessShippingReview(input({ findings: [], acceptance: [] }));
  assert.equal(a.ok, false);
  assert.match(
    a.checks.find((c) => c.id === "acceptance_mapped")?.detail ?? "",
    /a clean ledger is not evidence that the work was done/,
  );
});

test("FG-639 / PRD #29: an acceptance criterion whose only evidence is a SKIPPED test is unproven and blocks", () => {
  const a = assessShippingReview(
    input({
      acceptance: [
        {
          ref: "AC 1",
          verdict: "met",
          evidence: { kind: "regression_test", test_name: "the guard", runner_output: "ok 1 - the guard # SKIP no image" },
        },
      ],
    }),
  );
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["acceptance_mapped"]);
  assert.equal(a.acceptance[0]?.verdict, "unproven");
});

test("FG-639: verification recorded at a DIFFERENT sha does not satisfy the current candidate", () => {
  const a = assessShippingReview(
    input({ verification: { ok: true, sha: "older111", executedRequiredChecks: true, detail: "green" } }),
  );
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["verification_green"]);
  assert.match(a.checks[0]?.detail ?? "", /not the current candidate/);
});

test("FG-639: required coverage that no lane EXECUTED is not_executed, which is not green", () => {
  const a = assessShippingReview(
    input({ verification: { ok: true, sha: SHA, executedRequiredChecks: false, detail: "dashboard_browser skipped" } }),
  );
  assert.equal(a.ok, false);
  assert.match(a.checks[0]?.detail ?? "", /recorded not_executed, which is not green/);
});

test("FG-639: an UNTRIAGED finding is unsettled and returns the review to disposition", () => {
  const a = assessShippingReview(input({ findings: [finding({ disposition: "untriaged", resolution: undefined })] }));
  assert.equal(a.ok, false);
  assert.ok(failing(a).includes("findings_settled"));
  assert.equal(a.returnsToDisposition, true);
});

test("FG-639: an open ARCHITECTURE QUESTION leaves the review unsettled", () => {
  const a = assessShippingReview(
    input({ findings: [finding({ disposition: "architecture_question", resolution: undefined })] }),
  );
  assert.equal(a.ok, false);
  assert.ok(failing(a).includes("findings_settled"));
});

test("FG-639: a fix_now finding without a resolved recheck blocks on BOTH settlement and resolution", () => {
  const a = assessShippingReview(input({ findings: [finding({ resolution: "still_present" })] }));
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a).sort(), ["findings_settled", "fix_now_resolved"]);
});

test("FG-639: accepted_risk, deferred, rejected_premise and duplicate are settled and do not block", () => {
  const a = assessShippingReview(
    input({
      findings: [
        finding({ ordinal: 1, disposition: "accepted_risk", resolution: undefined }),
        finding({ ordinal: 2, disposition: "deferred", resolution: undefined, followupTicketId: "FG-999" }),
        finding({ ordinal: 3, disposition: "rejected_premise", resolution: undefined }),
        finding({ ordinal: 4, disposition: "duplicate", resolution: undefined }),
      ],
    }),
  );
  assert.equal(a.ok, true);
});

test("FG-639 / PRD #11: a historical fail against a SUPERSEDED sha does not block the settled candidate", () => {
  // RF-1 was raised and failed at sha A; the recheck covers the current candidate.
  const a = assessShippingReview(
    input({
      findings: [finding({ discoveredSha: "shaA000", resolution: "resolved", resolvedSha: SHA })],
    }),
  );
  assert.equal(a.ok, true);
  assert.equal(a.checks.find((c) => c.id === "fix_now_resolved")?.ok, true);
});

// The DIVISION OF LABOUR, stated as a test so a reader does not go looking for
// candidate-change handling here. The shipping review reads the ledger row; keeping that
// row honest when the candidate moves belongs to the store, which CLEARS the resolution
// (invalidateResolutionsForCandidate — PRD #14, covered in src/store/reviews.test.ts and
// src/v2/review-run.test.ts). If it did not, this check would read a stale proof.
test("FG-639 / PRD #14: the shipping review trusts the row; clearing a stale resolution is the store's job", () => {
  const stale = assessShippingReview(input({ findings: [finding({ resolution: "resolved", resolvedSha: "shaA000" })] }));
  assert.equal(stale.checks.find((c) => c.id === "fix_now_resolved")?.ok, true);

  const cleared = assessShippingReview(
    input({ findings: [finding({ resolution: undefined, resolvedSha: undefined })] }),
  );
  assert.equal(cleared.ok, false, "once the store clears it, the shipping review blocks");
  assert.deepEqual(failing(cleared).sort(), ["findings_settled", "fix_now_resolved"]);
});

test("FG-639: reviewed-tip trust that is not EQUALITY blocks, naming which withholding outcome", () => {
  for (const kind of ["local_only", "remote_ahead", "diverged", "remote_unavailable"] as const) {
    const a = assessShippingReview(input({ tipTrust: { kind, reviewedSha: SHA } }));
    assert.equal(a.ok, false, `${kind} must block`);
    assert.ok(failing(a).includes("tip_equality"));
    assert.match(a.checks.find((c) => c.id === "tip_equality")?.detail ?? "", new RegExp(kind));
  }
});

test("FG-639: broken candidate/gate/receipt/publication continuity blocks", () => {
  const a = assessShippingReview(
    input({ identity: { continuous: false, detail: "the working tree head is other333, not the reviewed candidate" } }),
  );
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["identity_continuity"]);
});

test("FG-639: post-confirmation drift with no bounded delta review fails the contract-coverage check", () => {
  const a = assessShippingReview(
    input({
      contractCoverage: { confirmedSha: "conf111", finalSha: SHA, postConfirmationPaths: ["src/new.ts"], deltaReviewed: false },
    }),
  );
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), ["contract_covers_diff"]);
});

test("FG-639: a free-form finding raised DURING shipping review returns to disposition rather than settling", () => {
  const a = assessShippingReview(input({ newFindings: [{ summary: "the publication path is unguarded" }] }));
  assert.equal(a.ok, false);
  assert.deepEqual(failing(a), [], "no numbered check failed — the new finding is what blocks");
  assert.equal(a.returnsToDisposition, true);
  assert.match(a.blocking[0] ?? "", /return to disposition/);
});

test("FG-639 / PRD #18: a clean ledger plus green verification plus tip equality advances with no override", () => {
  const a = assessShippingReview(input({ findings: [] }));
  assert.equal(a.ok, true);
  assert.deepEqual(a.blocking, []);
});
