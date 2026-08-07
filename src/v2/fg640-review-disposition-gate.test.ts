// FG-640 (evidence-led review, Change 3): the `review_disposition` gate.
//
// EVERY BLOCKING CONDITION GETS ITS OWN NEGATIVE TEST. A gate is only as good as the half
// that refuses, and a suite that only proves the settled case passes would keep passing if
// every condition were deleted. So each test below starts from one SETTLED ledger, breaks
// exactly one thing, and asserts the gate names that condition and only that condition.
//
// The settled fixture is shared for the same reason: if `settledReview()` ever stopped being
// settled, the "advances without --force" test would go red and take the whole file with it,
// rather than the negatives quietly passing for the wrong reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Review, ReviewFinding } from "../store/reviews.js";
import type { VerdictRow } from "../types/index.js";
import { assessReviewDisposition, assessEvidenceLedGate, REVIEW_DISPOSITION_GATE } from "./review-gate.js";
import type { DispositionGateConditionId } from "./review-gate.js";
import { oneShardPlan, shardOutcome } from "./review-shards.testkit.js";

const SHA = "cand640";
const OLD_SHA = "cand639";

const CONTRACT = {
  threat_model: "an evidence-led gate that can be talked past",
  protected_invariants: ["one review_mode per run"],
  acceptance_refs: ["FG-640 AC 18"],
  risk_lenses: ["backend", "security"],
  non_goals: ["rewriting every workflow"],
  lens_scopes: { backend: ["src/v2/review-gate.ts"], security: ["src/v2/review-discovery.ts"] },
};

/** A completed, reviewer-authored outcome for a lens. `authored: true` is the whole point —
 *  see review-discovery.ts. */
function lensOutcome(lens: string, outcome = "pass"): unknown {
  // FG-689: an outcome says WHICH shard of the lens's scope it reviewed. One that carries no
  // shard identity satisfies nothing — it cannot say which of the lens's shards was read.
  return shardOutcome({ lens, role: `red-${lens}`, complete: true, outcome, authored: true, findings: [] });
}

function shippingRecord(sha: string, overrides: Array<{ id: string; ok: boolean; detail: string }> = []): unknown {
  const base = [
    { id: "verification_green", ok: true, detail: "green" },
    { id: "acceptance_mapped", ok: true, detail: "2 acceptance criteria met on executed evidence" },
    { id: "findings_settled", ok: true, detail: "settled" },
    { id: "fix_now_resolved", ok: true, detail: "resolved" },
    { id: "tip_equality", ok: true, detail: "equal" },
    { id: "identity_continuity", ok: true, detail: "continuous" },
    { id: "contract_covers_diff", ok: true, detail: "covered" },
    { id: "docs_closeout", ok: true, detail: "no gaps" },
  ];
  const checks = base.map((c) => overrides.find((o) => o.id === c.id) ?? c);
  return { sha, at: "2026-07-30T00:00:00Z", detail: "shipping", meta: { checks } };
}

function settledReview(over: Partial<Review> = {}): Review {
  return {
    id: "review-640",
    runId: "run-640",
    subjectTaskId: "task-build",
    reviewMode: "evidence_led",
    state: "settled",
    candidateSha: SHA,
    contractConfirmedSha: SHA,
    trustedRemoteSha: SHA,
    contract: CONTRACT,
    // FG-689: what discovery was OWED. The gate blocks on its absence, so a fixture that is
    // settled in every other respect has to carry one — an unrecorded expectation is
    // unestablished coverage, and the gate is right to refuse it.
    shardPlan: oneShardPlan(["backend", "security"], { candidateSha: SHA }),
    lensOutcomes: [lensOutcome("backend"), lensOutcome("security")],
    stageEvidence: {
      verified_entry: { sha: SHA, at: "2026-07-30T00:00:00Z" },
      verified_final: { sha: SHA, at: "2026-07-30T00:00:00Z", detail: "green CI at cand640" },
      shipping: shippingRecord(SHA) as never,
    },
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
    ...over,
  };
}

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  const ordinal = over.ordinal ?? 1;
  return {
    id: `review-640/RF-${ordinal}`,
    reviewId: "review-640",
    ordinal,
    findingRef: `RF-${ordinal}`,
    summary: `finding ${ordinal}`,
    reachability: "demonstrated",
    sources: [{ redRole: "red-backend" }],
    disposition: "fix_now",
    resolution: "resolved",
    resolvedSha: SHA,
    resolutionEvidenceKind: "regression_test",
    decidedCandidateSha: SHA,
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
    ...over,
  };
}

function disprovingEvidence(sha = SHA): string {
  return JSON.stringify({
    kind: "replayed_command",
    detail: { command: "npm run typecheck", output: "no errors" },
    candidateSha: sha,
  });
}

function blocking(review: Review, findings: ReviewFinding[], verdicts: VerdictRow[] = []): DispositionGateConditionId[] {
  return assessReviewDisposition({ review, findings, verdicts }).conditions.map((c) => c.id);
}

// ── the settled case ─────────────────────────────────────────────────────────

test("FG-640 / PRD #18: a clean ledger + green verification + trusted-tip equality advances with NO --force", () => {
  const a = assessReviewDisposition({ review: settledReview(), findings: [finding()] });
  assert.equal(a.blocked, false, JSON.stringify(a.conditions, null, 2));
  assert.deepEqual(a.conditions, []);
  assert.equal(a.gateKind, REVIEW_DISPOSITION_GATE);
});

// ── each blocking condition, one at a time ───────────────────────────────────

test("FG-640 blocks: a selected lens has no reviewer-authored outcome", () => {
  const review = settledReview({ lensOutcomes: [lensOutcome("backend")] });
  assert.deepEqual(blocking(review, [finding()]), ["lens_outcome_missing"]);
});

test("FG-640 blocks: an untriaged finding", () => {
  assert.deepEqual(
    blocking(settledReview(), [finding(), finding({ ordinal: 2, disposition: "untriaged", resolution: undefined })]),
    ["finding_untriaged"],
  );
});

test("FG-640 blocks: an open architecture question", () => {
  assert.deepEqual(
    blocking(settledReview(), [
      finding({ ordinal: 2, disposition: "architecture_question", resolution: undefined }),
    ]),
    ["architecture_question_open"],
  );
});

test("FG-640 blocks: a rejected_premise with no candidate-bound disproving evidence", () => {
  const bare = finding({ ordinal: 2, disposition: "rejected_premise", resolution: undefined, dispositionEvidence: undefined });
  assert.deepEqual(blocking(settledReview(), [bare]), ["rejected_premise_unproven"]);

  // Prose where a structured payload belongs is the same refusal.
  const prose = finding({ ordinal: 3, disposition: "rejected_premise", resolution: undefined, dispositionEvidence: "seems unlikely" });
  assert.deepEqual(blocking(settledReview(), [prose]), ["rejected_premise_unproven"]);
});

test("FG-640 blocks: a rejected_premise whose evidence is bound to a SUPERSEDED candidate", () => {
  const stale = finding({
    ordinal: 2,
    disposition: "rejected_premise",
    resolution: undefined,
    dispositionEvidence: disprovingEvidence(OLD_SHA),
  });
  assert.deepEqual(blocking(settledReview(), [stale]), ["rejected_premise_unproven"]);
});

test("FG-640 blocks: a fix_now with no resolved recheck evidence", () => {
  assert.deepEqual(blocking(settledReview(), [finding({ resolution: "still_present" })]), ["fix_now_unresolved"]);
  assert.deepEqual(blocking(settledReview(), [finding({ resolution: undefined, resolvedSha: undefined })]), [
    "fix_now_unresolved",
  ]);
});

test("FG-640 blocks: a fix_now resolved at a SUPERSEDED sha — proof about code that moved", () => {
  assert.deepEqual(blocking(settledReview(), [finding({ resolvedSha: OLD_SHA })]), ["fix_now_unresolved"]);
});

test("FG-640 blocks: a fix_now resolution weaker than its original reachability requires (PRD #26)", () => {
  const inspected = finding({ reachability: "demonstrated", resolutionEvidenceKind: "bounded_inspection" });
  assert.deepEqual(blocking(settledReview(), [inspected]), ["fix_now_evidence_insufficient"]);

  // The SAME evidence closes a speculative finding — the rule is proportional, not absolute.
  const speculative = finding({ reachability: "speculative", resolutionEvidenceKind: "bounded_inspection" });
  assert.deepEqual(blocking(settledReview(), [speculative]), []);
});

test("FG-640 blocks: an absent reachability is treated as demonstrated, not as permissive", () => {
  const noReachability = finding({ reachability: undefined, resolutionEvidenceKind: "anchored_verification" });
  assert.deepEqual(blocking(settledReview(), [noReachability]), ["fix_now_evidence_insufficient"]);
});

test("FG-640 blocks: deterministic verification absent, or recorded at a superseded sha", () => {
  const none = settledReview({ stageEvidence: { verified_entry: { sha: SHA, at: "t" }, shipping: shippingRecord(SHA) as never } });
  assert.deepEqual(blocking(none, [finding()]), ["verification_absent_or_red"]);

  const stale = settledReview({
    stageEvidence: {
      verified_final: { sha: OLD_SHA, at: "t" },
      shipping: shippingRecord(SHA) as never,
    },
  });
  assert.deepEqual(blocking(stale, [finding()]), ["verification_absent_or_red"]);
});

test("FG-640 blocks: the shipping review reports an unmet/unproven AC (PRD #17), clean ledger notwithstanding", () => {
  const review = settledReview({
    stageEvidence: {
      verified_final: { sha: SHA, at: "t" },
      shipping: shippingRecord(SHA, [
        { id: "acceptance_mapped", ok: false, detail: "1 acceptance criteria are unmet/unproven: AC 3 (unproven)" },
      ]) as never,
    },
  });
  const a = assessReviewDisposition({ review, findings: [] });
  assert.deepEqual(a.conditions.map((c) => c.id), ["acceptance_unmet"]);
  assert.match(a.conditions[0]!.detail, /unproven/);
});

test("FG-640 blocks: no shipping review has run at all", () => {
  const review = settledReview({ stageEvidence: { verified_final: { sha: SHA, at: "t" } } });
  const a = assessReviewDisposition({ review, findings: [] });
  assert.deepEqual(a.conditions.map((c) => c.id), ["acceptance_unmet"]);
  assert.match(a.conditions[0]!.detail, /not evidence that the work was done/);
});

test("FG-640 blocks: reviewed-tip trust that is not EQUALITY with the fetched remote head", () => {
  assert.deepEqual(blocking(settledReview({ trustedRemoteSha: undefined }), [finding()]), ["tip_not_trusted"]);
  assert.deepEqual(blocking(settledReview({ trustedRemoteSha: "someotherhead" }), [finding()]), ["tip_not_trusted"]);
});

// ── the explicit NON-blocking half ───────────────────────────────────────────

test("FG-640 does NOT block: a raw advisory red fail whose findings are dispositioned", () => {
  const advisoryFail: VerdictRow = {
    id: "v-1",
    taskId: "task-build",
    redTaskId: "task-red",
    redRole: "red-security",
    verdict: "fail",
    confidence: 0.9,
    authority: "specialist",
    findings: [],
    createdAt: "2026-07-30T00:00:00Z",
    gateOnVerdict: false,
  };
  const a = assessReviewDisposition({
    review: settledReview(),
    findings: [finding({ disposition: "accepted_risk", resolution: undefined, decidedBy: "operator" })],
    verdicts: [advisoryFail],
  });
  assert.equal(a.blocked, false, JSON.stringify(a.conditions));
  assert.ok(a.nonBlocking.some((n) => n.id === "advisory_red_fail_dispositioned"));
});

test("FG-640 does NOT block: settled accepted_risk / deferred / rejected_premise / duplicate", () => {
  const findings = [
    finding({ ordinal: 1, disposition: "accepted_risk", resolution: undefined, decidedBy: "operator" }),
    finding({ ordinal: 2, disposition: "deferred", resolution: undefined, followupTicketId: "FG-999" }),
    finding({ ordinal: 3, disposition: "rejected_premise", resolution: undefined, dispositionEvidence: disprovingEvidence() }),
    finding({ ordinal: 4, disposition: "duplicate", resolution: undefined, duplicateOf: "review-640/RF-1" }),
  ];
  const a = assessReviewDisposition({ review: settledReview(), findings });
  assert.equal(a.blocked, false, JSON.stringify(a.conditions));
  assert.ok(a.nonBlocking.some((n) => n.id === "settled_disposition"));
});

test("FG-640 does NOT block: a disposition decided against a superseded sha (PRD #11)", () => {
  // The DECISION is about the finding, not about a tree — so it survives the candidate moving.
  // Only the candidate-bound halves (resolution, disproving evidence) are re-bound to the sha.
  const a = assessReviewDisposition({
    review: settledReview(),
    findings: [finding({ decidedCandidateSha: OLD_SHA })],
  });
  assert.equal(a.blocked, false, JSON.stringify(a.conditions));
  assert.ok(a.nonBlocking.some((n) => n.id === "superseded_verdict"));
});

// ── the migration-safety conditions ──────────────────────────────────────────

test("FG-640: an evidence_led task with NO ledger fails closed, it does not read clean", () => {
  const { assessment } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [],
    findingsFor: () => [],
    verdicts: [],
  });
  assert.equal(assessment.blocked, true);
  assert.deepEqual(assessment.conditions.map((c) => c.id), ["review_absent"]);
});

// The regression this guards: `forge review start` binds a review to a TICKET and a RUN, never
// to a task, and no verb binds one to a task afterwards. A gate that only consulted
// subject_task_id would report `review_absent` on every real run with the settled ledger sitting
// right there — making --force the only way past a gate whose entire purpose is to be settled.
test("FG-640: a review that names the RUN is the run's ledger — the gate does not demand a task-bound one", () => {
  const runScoped = settledReview({ id: "review-run-scoped", subjectTaskId: undefined });
  const { review, assessment } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [],
    runReviews: [runScoped],
    findingsFor: () => [finding()],
    verdicts: [],
  });
  assert.equal(review?.id, "review-run-scoped");
  assert.equal(assessment.blocked, false, JSON.stringify(assessment.conditions));
});

test("FG-640: a TASK-bound review wins over a run-scoped one — the more specific answer", () => {
  const { review } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [settledReview({ id: "review-task" })],
    runReviews: [settledReview({ id: "review-run", subjectTaskId: undefined })],
    findingsFor: () => [finding()],
    verdicts: [],
  });
  assert.equal(review?.id, "review-task");
});

// Fail-OPEN was the bug here: the completeness assessor iterates what is OWED, so an
// unparseable contract yields zero lenses and reads trivially complete — the review with the
// least-established coverage would be the one owing no outcomes at all.
test("FG-640 blocks: an unreadable review contract, rather than owing no lens outcomes at all", () => {
  for (const bad of [undefined, {}, { risk_lenses: [] }, "backend"]) {
    const conditions = blocking(settledReview({ contract: bad }), [finding()]);
    assert.ok(
      conditions.includes("contract_unreadable"),
      `an unreadable contract (${JSON.stringify(bad)}) did not block: ${conditions.join(", ")}`,
    );
    assert.ok(!conditions.includes("lens_outcome_missing"), "an unreadable contract cannot also name missing lenses");
  }
});

test("FG-640: a step that still DECLARES blocking reds is mixed-authority even when every red passed", () => {
  const { assessment } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [settledReview()],
    findingsFor: () => [finding()],
    verdicts: [],
    declaredReds: [
      { agent: "red-backend", authority: "authoritative", gate_on_verdict: true },
      { agent: "red-security", authority: "specialist", gate_on_verdict: false },
    ],
  });
  assert.deepEqual(assessment.conditions.map((c) => c.id), ["mixed_authority_model"]);
  assert.match(assessment.conditions[0]!.detail, /still DECLARES blocking red\(s\) \(red-backend/);
});

test("FG-640: fully migrated declared reds are NOT mixed authority", () => {
  const { assessment } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [settledReview()],
    findingsFor: () => [finding()],
    verdicts: [],
    declaredReds: [
      { agent: "red-backend", authority: "specialist", gate_on_verdict: false },
      { agent: "shipping-reviewer", authority: "specialist", gate_on_verdict: false },
    ],
  });
  assert.equal(assessment.blocked, false, JSON.stringify(assessment.conditions));
});

test("FG-640: a run moved between authority models after creation is refused by name", () => {
  const { assessment } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [settledReview()],
    findingsFor: () => [finding()],
    verdicts: [],
    modeDrift: { runMode: "legacy_verdict", workflowMode: "evidence_led" },
  });
  assert.deepEqual(assessment.conditions.map((c) => c.id), ["review_mode_drift"]);
  assert.match(assessment.conditions[0]!.detail, /fixed at creation/);
});

test("FG-640: a still-authoritative verdict on an evidence_led run is refused as mixed authority", () => {
  const authoritative: VerdictRow = {
    id: "v-2",
    taskId: "task-build",
    redTaskId: "task-red",
    redRole: "red-wide",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-30T00:00:00Z",
    gateOnVerdict: true,
  };
  const review = settledReview();
  const { assessment } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [review],
    findingsFor: () => [finding()],
    verdicts: [authoritative],
  });
  assert.equal(assessment.blocked, true);
  assert.deepEqual(assessment.conditions.map((c) => c.id), ["mixed_authority_model"]);
  assert.match(assessment.conditions[0]!.detail, /exactly one review_mode settles a run/);
});

test("FG-640: the newest review is the one the gate is decided against", () => {
  const older = settledReview({ id: "review-old", createdAt: "2026-07-01T00:00:00Z", candidateSha: OLD_SHA });
  const newer = settledReview({ id: "review-new", createdAt: "2026-07-30T00:00:00Z" });
  const { review } = assessEvidenceLedGate({
    taskId: "task-build",
    reviews: [older, newer],
    findingsFor: () => [finding()],
    verdicts: [],
  });
  assert.equal(review?.id, "review-new");
});
