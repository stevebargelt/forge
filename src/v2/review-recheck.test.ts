// FG-639: Stage 8 — exact recheck + bounded remediation-delta review.
//
// The scenario this file exists for is #1: A FINDING ABSENT FROM RECHECK OUTPUT REMAINS
// OPEN. Every other test here is a way of not weakening it — omission refuses the whole
// result, an unknown id refuses, a duplicate refuses, and a `resolved` whose evidence does
// not carry it is recorded `inconclusive` rather than taken at its word.
//
// The other half is what the rechecker is NOT allowed to do: #28 says an inconclusive
// returns to disposition rather than synthesizing closure or launching another discovery
// panel, and the schema is the enforcement — there is no arm for either.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestRecheck, recheckIsNoOp } from "./review-recheck.js";
import type { ReviewFinding } from "../store/reviews.js";

const REVIEW = "review-r1";
const SHA = "final222";

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  const ordinal = over.ordinal ?? 1;
  return {
    id: `${REVIEW}/RF-${ordinal}`,
    reviewId: REVIEW,
    ordinal,
    findingRef: `RF-${ordinal}`,
    summary: `finding ${ordinal}`,
    evidence: "the guard is skipped",
    reachability: "demonstrated",
    riskLens: "backend",
    sources: [{ redRole: "red-backend" }],
    disposition: "fix_now",
    dispositionRationale: "will be remediated this cycle",
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
    ...over,
  };
}

const EXECUTED = "ok 1 - the reconcile path guards a partial write";
const SKIPPED = ["ok 1 - the reconcile path guards a partial write # SKIP no agent image", "# pass 0", "# skipped 1"].join("\n");

function resolvedEntry(ref: string, over: Record<string, unknown> = {}) {
  return {
    finding_id: ref,
    result: "resolved",
    evidence_kind: "regression_test",
    evidence: {
      kind: "regression_test",
      test_name: "the reconcile path guards a partial write",
      test_file: "src/store/reviews.test.ts",
      runner_output: EXECUTED,
    },
    ...over,
  };
}

function output(over: Record<string, unknown> = {}) {
  return { review_id: REVIEW, candidate_sha: SHA, rechecked: [], new_findings: [], ...over };
}

// ─── PRD #1 — omission is never resolution ──────────────────────────────────

test("FG-639 / PRD #1: a finding ABSENT from recheck output remains open — the whole result is refused", () => {
  const expected = [finding({ ordinal: 1 }), finding({ ordinal: 2 })];
  const r = ingestRecheck(output({ rechecked: [resolvedEntry("RF-1")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected,
  });

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /omits RF-2/);
  assert.match(r.refusal, /omission is a schema failure, never resolution/);
  assert.match(r.refusal, /That finding remains open/);
  assert.match(r.refusal, /Nothing was written/, "RF-1 is not resolved either — the result is refused whole");
});

test("FG-639 / PRD #1: an EMPTY recheck output for a non-empty expected set is refused", () => {
  const r = ingestRecheck(output(), { reviewId: REVIEW, candidateSha: SHA, expected: [finding()] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /omits RF-1/);
});

test("FG-639: an id the rechecker was never asked about is refused, naming what it WAS asked about", () => {
  const r = ingestRecheck(output({ rechecked: [resolvedEntry("RF-1"), resolvedEntry("RF-77")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /not one of the findings it was asked to recheck \(RF-1\)/);
});

test("FG-639: the same id reported twice is refused", () => {
  const r = ingestRecheck(output({ rechecked: [resolvedEntry("RF-1"), resolvedEntry("RF-1")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /more than once — exactly one result per id/);
});

test("FG-639: a recheck bound to ANOTHER candidate is refused — it is not evidence about this one", () => {
  const r = ingestRecheck(output({ candidate_sha: "someothersha", rechecked: [resolvedEntry("RF-1")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /a recheck at another candidate is not evidence about this one/);
});

test("FG-639: a recheck naming another review is refused on identity", () => {
  const r = ingestRecheck(output({ review_id: "review-elsewhere", rechecked: [resolvedEntry("RF-1")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /names review review-elsewhere/);
});

test("FG-639: a malformed per-finding entry is a schema failure, not a partial application", () => {
  const r = ingestRecheck(
    output({ rechecked: [{ finding_id: "RF-1", result: "definitely fixed" }] }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /recheck result\.json invalid/);
});

// ─── FG-650: tolerate-and-record at the root ────────────────────────────────

test("FG-650: extra ROOT keys the harness contract mandates are tolerated and recorded by name", () => {
  const r = ingestRecheck(
    output({ status: "complete", verdict: "pass", confidence: 0.9, notes: "rechecked RF-1", rechecked: [resolvedEntry("RF-1")] }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, true, "an honest rechecker output carrying `status` is not invalid");
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "resolved", "the per-id results survive the root tolerance intact");
  assert.deepEqual(r.toleratedRootKeys, ["confidence", "notes", "status", "verdict"]);
});

test("FG-650: root tolerance does not weaken the omission refusal", () => {
  const r = ingestRecheck(output({ status: "complete", rechecked: [resolvedEntry("RF-1")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 }), finding({ ordinal: 2 })],
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /omits RF-2/);
  assert.match(r.ok ? "" : r.refusal, /omission is a schema failure, never resolution/);
});

test("FG-650: root tolerance does not reach inside a per-id result", () => {
  const r = ingestRecheck(
    output({ status: "complete", rechecked: [resolvedEntry("RF-1", { certainty: "high" })] }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, false, "an unknown key inside a per-id result is still refused");
  assert.match(r.ok ? "" : r.refusal, /certainty/);
});

test("FG-650: a rechecker output with nothing extra records an empty tolerance list", () => {
  const r = ingestRecheck(output({ rechecked: [resolvedEntry("RF-1")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.deepEqual(r.ok ? r.toleratedRootKeys : ["unset"], []);
});

// ─── resolution, on evidence ────────────────────────────────────────────────

test("FG-639: a resolved finding with EXECUTED regression-test evidence is applied", () => {
  const r = ingestRecheck(output({ rechecked: [resolvedEntry("RF-1")] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "resolved");
  assert.equal(r.applications[0]?.evidenceKind, "regression_test");
  assert.equal(r.applications[0]?.coverage, "executed");
  assert.equal(r.returnsToDisposition, false);
});

test("FG-639 / PRD #29: a resolved claim citing a SKIPPED test becomes inconclusive with not_executed coverage", () => {
  const r = ingestRecheck(
    output({
      rechecked: [
        resolvedEntry("RF-1", {
          evidence: {
            kind: "regression_test",
            test_name: "the reconcile path guards a partial write",
            runner_output: SKIPPED,
          },
        }),
      ],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "inconclusive", "never resolved");
  assert.equal(r.applications[0]?.coverage, "not_executed", "never green");
  assert.match(r.applications[0]?.detail ?? "", /SKIPPED/);
  assert.equal(r.returnsToDisposition, true);
});

test("FG-639 / PRD #26: a DEMONSTRATED finding claimed resolved by re-inspection becomes inconclusive", () => {
  const r = ingestRecheck(
    output({
      rechecked: [
        {
          finding_id: "RF-1",
          result: "resolved",
          evidence_kind: "bounded_inspection",
          evidence: { kind: "bounded_inspection", inspection: "I read the new guard", limitation: "not executed" },
        },
      ],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1, reachability: "demonstrated" })] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "inconclusive");
  assert.match(r.applications[0]?.detail ?? "", /never closed by model re-inspection/);
});

test("FG-639: a finding with NO recorded reachability is held to the STRICTEST bar", () => {
  const r = ingestRecheck(
    output({
      rechecked: [
        {
          finding_id: "RF-1",
          result: "resolved",
          evidence_kind: "bounded_inspection",
          evidence: { kind: "bounded_inspection", inspection: "read it", limitation: "not executed" },
        },
      ],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1, reachability: undefined })] },
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok ? r.applications[0]?.resolution : "", "inconclusive");
});

test("FG-639: a declared evidence_kind that disagrees with the payload is recorded inconclusive, not guessed", () => {
  const r = ingestRecheck(
    output({
      rechecked: [
        resolvedEntry("RF-1", {
          evidence_kind: "replayed_reproduction",
          evidence: { kind: "regression_test", test_name: "the reconcile path guards a partial write", runner_output: EXECUTED },
        }),
      ],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "inconclusive");
  assert.match(r.applications[0]?.detail ?? "", /does not match the payload/);
});

// ─── PRD #6 / #28 — what happens when it is not resolved ────────────────────

test("FG-639 / PRD #6: still_present returns to disposition and does NOT launch a fixer", () => {
  const r = ingestRecheck(
    output({
      rechecked: [
        resolvedEntry("RF-1"),
        { finding_id: "RF-2", result: "still_present", evidence_kind: "anchored_verification", evidence: {}, note: "the guard is still after the early return at src/a.ts:14" },
      ],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 }), finding({ ordinal: 2 })] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "resolved");
  assert.equal(r.applications[1]?.resolution, "still_present");
  assert.equal(r.returnsToDisposition, true, "the review returns to disposition");
  // The ingestion result carries no dispatch instruction of any kind — there is no arm in
  // the type that could ask for a fixer.
  assert.equal("dispatchFixer" in r, false);
});

test("FG-639 / PRD #28: an inconclusive returns to disposition — no synthesized closure, no new panel", () => {
  const r = ingestRecheck(
    output({
      rechecked: [
        {
          finding_id: "RF-1",
          result: "inconclusive",
          evidence_kind: "bounded_inspection",
          evidence: {},
          note: "the domain-specific claim needs a live device I do not have",
        },
      ],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "inconclusive");
  assert.match(r.applications[0]?.detail ?? "", /needs a live device/);
  assert.equal(r.returnsToDisposition, true);
  assert.deepEqual(r.newFindings, [], "an inconclusive does not launch another discovery panel");
});

// ─── PRD #7 / #8 / #24 — the bounded delta review's new findings ────────────

const NEW_FINDING = {
  summary: "the new retry loop can double-apply the ledger write",
  evidence: "src/store/x.ts:44 re-enters without the idempotence key",
  severity: "critical",
  risk_lens: "backend",
  reachability: "demonstrated",
  challenges_contract: false,
  remediation_advice: "advice: key the retry on the batch id",
  file: "src/store/x.ts",
  line: 44,
  quoted_text: "for (const r of incoming) insert.run(...)",
  invariant_ref: "no partial write",
};

test("FG-639 / PRD #24: a fixer-introduced reachable defect becomes a NEW ledger finding from the delta review", () => {
  const r = ingestRecheck(output({ rechecked: [resolvedEntry("RF-1")], new_findings: [NEW_FINDING] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "resolved", "every KNOWN finding was resolved");
  assert.equal(r.newFindings.length, 1, "and the delta review still found a new one");
  assert.equal(r.returnsToDisposition, true);
});

test("FG-639 / PRD #7: a late SPECULATIVE low is recorded and gains no blocking force from lateness", () => {
  const r = ingestRecheck(
    output({
      rechecked: [resolvedEntry("RF-1")],
      new_findings: [{ ...NEW_FINDING, severity: "low", reachability: "speculative", invariant_ref: undefined }],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const late = r.newFindings[0];
  assert.equal(late?.severity, "low", "lateness does not escalate severity");
  assert.equal(late?.reachability, "speculative", "nor reachability");
  assert.equal(late?.invariant_ref, undefined, "nor does it acquire an invariant it never named");
});

test("FG-639 / PRD #8: a demonstrated invariant violation from the delta review is recorded with its invariant", () => {
  const r = ingestRecheck(output({ rechecked: [resolvedEntry("RF-1")], new_findings: [NEW_FINDING] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.newFindings[0]?.reachability, "demonstrated");
  assert.equal(r.newFindings[0]?.invariant_ref, "no partial write");
  assert.equal(r.returnsToDisposition, true, "it returns to disposition BEFORE shipping");
});

test("FG-639: a new finding missing a required field invalidates the whole recheck result", () => {
  const r = ingestRecheck(
    output({ rechecked: [resolvedEntry("RF-1")], new_findings: [{ summary: "vague worry" }] }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1 })] },
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /recheck result\.json invalid/);
});

// ─── the no-op condition ────────────────────────────────────────────────────

test("FG-639: recheck is a no-op ONLY with no fix_now findings AND an unmoved candidate", () => {
  assert.equal(recheckIsNoOp({ fixNowCount: 0, contractConfirmedSha: "a1", candidateSha: "a1" }), true);
  assert.equal(
    recheckIsNoOp({ fixNowCount: 0, contractConfirmedSha: "a1", candidateSha: "b2" }),
    false,
    "any post-discovery candidate change still gets the bounded delta review",
  );
  assert.equal(recheckIsNoOp({ fixNowCount: 1, contractConfirmedSha: "a1", candidateSha: "a1" }), false);
  assert.equal(
    recheckIsNoOp({ fixNowCount: 0, contractConfirmedSha: undefined, candidateSha: "a1" }),
    false,
    "with no confirmed sha there is nothing to compare, so it is never a no-op",
  );
});

test("FG-639: a bare RF-n ref resolves against the expected set, as an operator would type it", () => {
  const r = ingestRecheck(output({ rechecked: [resolvedEntry(`${REVIEW}/RF-1`)] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok ? r.applications[0]?.findingRef : "", "RF-1");
});

// ─── FG-657: a multi-name citation, at the surface the ledger actually calls ──
//
// `validateResolutionEvidence` is where the list rule lives, but `ingestRecheck` is what
// decides whether a finding LEAVES the ledger. These go through that path: the question is
// not just "was the claim refused" but "what did the ledger then record" — a refusal that
// wrote `resolved`, or wrote nothing, would be the trust gate failing open no matter how
// correct the refusal string was.

const PAIR_657 = ["the reconcile path guards a partial write", "the reconcile path retries once"];
const PAIR_657_GREEN = [`✔ ${PAIR_657[0]} (1.2ms)`, `✔ ${PAIR_657[1]} (0.4ms)`, "ℹ pass 2", "ℹ fail 0"].join("\n");

function multiNameEntry(runnerOutput: string, over: Record<string, unknown> = {}) {
  return resolvedEntry("RF-1", {
    evidence: {
      kind: "regression_test",
      test_name: PAIR_657.join("; "),
      test_file: "src/v2/reconcile.test.ts",
      runner_output: runnerOutput,
      ...over,
    },
  });
}

function ingestOne(runnerOutput: string, over: Record<string, unknown> = {}) {
  return ingestRecheck(output({ rechecked: [multiNameEntry(runnerOutput, over)] }), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
}

test("FG-657: a citation naming several tests, all executed, resolves the finding through the ledger", () => {
  const r = ingestOne(PAIR_657_GREEN);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const [a] = r.applications;
  assert.equal(a?.resolution, "resolved", "a complete passing citation is no longer read as absent");
  assert.equal(a?.coverage, "executed");
  assert.equal(a?.evidenceKind, "regression_test");
  assert.equal(r.returnsToDisposition, false);
});

test("FG-657: one SKIPPED member is recorded inconclusive + not_executed by the ledger, never resolved", () => {
  const r = ingestOne([`✔ ${PAIR_657[0]} (1.2ms)`, `﹣ ${PAIR_657[1]} (0ms) # SKIP no agent image`, "ℹ pass 1"].join("\n"));
  assert.equal(r.ok, true, "the result is ingested; it is the RESOLUTION that is refused");
  if (!r.ok) return;
  const [a] = r.applications;
  assert.equal(a?.resolution, "inconclusive");
  assert.equal(a?.coverage, "not_executed", "the skip is recorded, not silently dropped");
  assert.equal(a?.evidenceKind, undefined, "nothing is stored as validated evidence");
  assert.match(a?.detail ?? "", /the reconcile path retries once SKIPPED/, "the ledger detail names WHICH member");
  assert.equal(r.returnsToDisposition, true, "the finding returns to disposition");
});

test("FG-657: one FAILED member is recorded inconclusive + not_executed, and is not masked by a passing sibling", () => {
  const r = ingestOne([`✔ ${PAIR_657[0]} (1.2ms)`, `✖ ${PAIR_657[1]} (0.4ms)`, "ℹ fail 1"].join("\n"));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const [a] = r.applications;
  assert.equal(a?.resolution, "inconclusive");
  assert.equal(a?.coverage, "not_executed");
  assert.match(a?.detail ?? "", /the reconcile path retries once FAILED in the cited runner output/);
  assert.match(a?.detail ?? "", /it is the finding still being present/);
  assert.equal(r.returnsToDisposition, true);
});

test("FG-657: one ABSENT member is recorded inconclusive — a passing majority never carries the missing one", () => {
  const r = ingestOne([`✔ ${PAIR_657[0]} (1.2ms)`, "ℹ pass 1", "ℹ fail 0"].join("\n"));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const [a] = r.applications;
  assert.equal(a?.resolution, "inconclusive");
  assert.equal(a?.coverage, "not_executed");
  assert.match(a?.detail ?? "", /the reconcile path retries once does not appear in the cited runner output at all/);
  assert.equal(r.returnsToDisposition, true);
});

test("FG-657: a separator-only test_name resolves nothing through the ledger either", () => {
  const r = ingestOne(PAIR_657_GREEN, { test_name: " ; ; " });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "inconclusive", "naming no test at all is not a cheaper way past the gate");
  assert.equal(r.applications[0]?.coverage, "not_executed");
});

test("FG-657: a finding with NO recorded reachability still gets the strictest rule, multi-name step and all", () => {
  const r = ingestRecheck(
    output({
      rechecked: [
        resolvedEntry("RF-1", {
          evidence_kind: "anchored_verification",
          evidence: {
            kind: "anchored_verification",
            file: "src/v2/reconcile.ts",
            line: 88,
            fact: "the partial write is guarded first",
            verification_step: { ran: PAIR_657, runner_output: PAIR_657_GREEN },
          },
        }),
      ],
    }),
    { reviewId: REVIEW, candidateSha: SHA, expected: [finding({ ordinal: 1, reachability: undefined })] },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications[0]?.resolution, "inconclusive", "an unknown reachability is treated as demonstrated");
  assert.match(r.applications[0]?.detail ?? "", /requires regression_test or replayed_reproduction/);
  assert.equal(r.applications[0]?.coverage, "not_executed");
});
