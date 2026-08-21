// FG-744: exact-candidate CI evidence for a stranded fix_now finding.
//
// The shape this file exists for is the FG-737 RF-1 occurrence: a fixer's cited
// executed_assertion lives in an INTEGRATION tier the recheck's fast gate structurally
// cannot run, so the recheck recorded `inconclusive / not_executed`; then green required CI
// went green at the EXACT candidate and executed the assertion. Every test here is a way of
// admitting that evidence WITHOUT weakening evidence sufficiency — a skipped, red, or absent
// assertion, CI at another candidate, or a fast-tier test never resolves anything, and the
// binding is always to the FIXER's own named assertion at the exact candidate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestCandidateCiEvidence, tierOfTestFile } from "./review-ci-evidence.js";
import type { ReviewFinding } from "../store/reviews.js";
import type { GateEvidence } from "../store/host-verifications.js";

const REVIEW = "review-fg744";
const SHA = "8e9fe0d0";
const ASSERTION = "refreshes a SETTLED row ONLY for the live lease holder";
const TEST_FILE = "src/campaign/fg737-detached-resume-fence.integration.test.ts";

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  const ordinal = over.ordinal ?? 1;
  return {
    id: `${REVIEW}/RF-${ordinal}`,
    reviewId: REVIEW,
    ordinal,
    findingRef: `RF-${ordinal}`,
    summary: `finding ${ordinal}`,
    evidence: "stale-launcher rebind of a settled linkage",
    reachability: "demonstrated",
    riskLens: "backend",
    sources: [{ redRole: "red-backend" }],
    disposition: "fix_now",
    dispositionRationale: "will be remediated this cycle",
    // The stranded state the recheck left it in.
    resolution: "inconclusive",
    resolvedSha: SHA,
    resolutionEvidenceKind: "not_executed",
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
    ...over,
  };
}

const ciGate: GateEvidence = {
  source: "ci",
  sha: SHA,
  checkUrl: "https://ci/run/1",
  checks: [
    { context: "CI / test" },
    { context: "CI / test-extended" },
  ],
};

function tap(name: string, mark: "ok" | "skip" | "not ok" = "ok"): string {
  if (mark === "not ok") return `not ok 1 - ${name}`;
  if (mark === "skip") return `ok 1 - ${name} # SKIP no db lane`;
  return `ok 1 - ${name}`;
}

function evidenceInput(over: Record<string, unknown> = {}) {
  return {
    review_id: REVIEW,
    candidate_sha: SHA,
    findings: [
      {
        finding_id: `${REVIEW}/RF-1`,
        test_file: TEST_FILE,
        ci_lane: "CI / test-extended",
        ci_runner_output: tap(ASSERTION),
      },
    ],
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof ingestCandidateCiEvidence>[1]> = {}) {
  return {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
    fixerAssertions: { [`${REVIEW}/RF-1`]: ASSERTION },
    gateEvidence: ciGate,
    ...over,
  };
}

// ─── the happy path (AC2/AC3/AC4) ───────────────────────────────────────────

test("FG-744: green exact-candidate CI that executed the cited integration assertion resolves the stranded finding", () => {
  const r = ingestCandidateCiEvidence(evidenceInput(), ctx());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applications.length, 1);
  const a = r.applications[0]!;
  assert.equal(a.findingRef, "RF-1");
  assert.equal(a.evidenceKind, "regression_test", "regression_test is proportional to a demonstrated finding");
  assert.match(a.detail, new RegExp(ASSERTION.slice(0, 20)));
});

// ─── evidence sufficiency is unchanged (AC3) ────────────────────────────────

test("FG-744: a SKIPPED assertion in the CI output never resolves — a skip is not evidence", () => {
  const r = ingestCandidateCiEvidence(
    evidenceInput({
      findings: [{ finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: tap(ASSERTION, "skip") }],
    }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /skip/i);
  assert.match(r.ok ? "" : r.refusal, /Nothing was written/);
});

test("FG-744: a RED (failed) assertion never resolves — a red check is the finding still present", () => {
  const r = ingestCandidateCiEvidence(
    evidenceInput({
      findings: [{ finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: tap(ASSERTION, "not ok") }],
    }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /fail/i);
});

test("FG-744: an assertion ABSENT from the CI output never resolves", () => {
  const r = ingestCandidateCiEvidence(
    evidenceInput({
      findings: [{ finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: "ok 1 - some other test" }],
    }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /does not appear|never established/i);
});

// ─── exact-candidate binding (AC2/AC3) ──────────────────────────────────────

test("FG-744: no covering-gate evidence at the candidate resolves nothing", () => {
  const r = ingestCandidateCiEvidence(evidenceInput(), ctx({ gateEvidence: null }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /no green required-CI covering evidence/);
});

test("FG-744: covering-gate evidence bound to a DIFFERENT sha resolves nothing", () => {
  const r = ingestCandidateCiEvidence(evidenceInput(), ctx({ gateEvidence: { source: "ci", sha: "deadbeef", checks: [] } }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /bound to deadbeef, not the current candidate/);
});

test("FG-744: the CI runner output's assertion must be at THIS candidate — an alternate lane at another sha is refused inside the evidence", () => {
  // The candidate_sha the ingestion builds into the alternate lane is ctx.candidateSha, so a
  // green lane is only ever checked against this candidate — proven by the happy path binding to
  // SHA. This test guards the input identity: an input naming a different candidate is refused.
  const r = ingestCandidateCiEvidence(evidenceInput({ candidate_sha: "other999" }), ctx());
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /bound to candidate other999/);
});

// ─── the tier gate (AC1) ────────────────────────────────────────────────────

test("FG-744: a FAST-tier test_file is refused — that assertion is the normal recheck's job", () => {
  const r = ingestCandidateCiEvidence(
    evidenceInput({
      findings: [{ finding_id: `${REVIEW}/RF-1`, test_file: "src/store/reviews.test.ts", ci_lane: "CI / test", ci_runner_output: tap(ASSERTION) }],
    }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /fast-tier test/);
});

test("FG-744: tierOfTestFile classifies the tier partition's infixes", () => {
  assert.equal(tierOfTestFile("src/a.integration.test.ts"), "integration");
  assert.equal(tierOfTestFile("src/a.worktree.test.ts"), "worktree");
  assert.equal(tierOfTestFile("src/a.test.ts"), "fast");
  assert.equal(tierOfTestFile("src/a.integration.test.tsx"), "integration");
});

// ─── the RF-5 binding to the fixer's own assertion ──────────────────────────

test("FG-744: a finding the fixer named no executed_assertion for cannot be rescued", () => {
  const r = ingestCandidateCiEvidence(evidenceInput(), ctx({ fixerAssertions: {} }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /named no executed_assertion/);
});

test("FG-744: CI output that ran a DIFFERENT test than the fixer named resolves nothing (the identity is the fixer's, not the operator's)", () => {
  // The operator cannot substitute a different assertion: the ingestion binds test_name to the
  // fixer's named assertion, so CI output that only ran some other test leaves the fixer's
  // assertion executed nowhere.
  const r = ingestCandidateCiEvidence(
    evidenceInput({
      findings: [{ finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: tap("a totally different assertion") }],
    }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /does not appear|never established/i);
});

// ─── identity + membership refusals ─────────────────────────────────────────

test("FG-744: an input naming another review is refused", () => {
  const r = ingestCandidateCiEvidence(evidenceInput({ review_id: "review-other" }), ctx());
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /names review review-other/);
});

test("FG-744: an id that is not a fix_now finding is refused", () => {
  const r = ingestCandidateCiEvidence(
    evidenceInput({ findings: [{ finding_id: `${REVIEW}/RF-9`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: tap(ASSERTION) }] }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /not one of this review's fix_now findings/);
});

test("FG-744: a finding already resolved at the candidate has nothing to rescue", () => {
  const r = ingestCandidateCiEvidence(evidenceInput(), ctx({ expected: [finding({ ordinal: 1, resolution: "resolved", resolvedSha: SHA })] }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /already resolved at/);
});

test("FG-744: a duplicate finding entry is refused", () => {
  const r = ingestCandidateCiEvidence(
    evidenceInput({
      findings: [
        { finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: tap(ASSERTION) },
        { finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: tap(ASSERTION) },
      ],
    }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /more than once/);
});

test("FG-744: a bare RF-n ref resolves against the fix_now set", () => {
  const r = ingestCandidateCiEvidence(
    evidenceInput({ findings: [{ finding_id: "RF-1", test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: tap(ASSERTION) }] }),
    ctx(),
  );
  assert.equal(r.ok, true);
});

test("FG-744: a host_row covering source at the exact candidate is admissible too", () => {
  const row = {
    id: 1,
    ticketId: "FG-744",
    projectDir: "/p",
    commitSha: SHA,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-08-21T00:00:00Z",
    source: "host" as const,
  };
  const hostGate: GateEvidence = { source: "host_row", row, rows: [row] };
  const r = ingestCandidateCiEvidence(evidenceInput(), ctx({ gateEvidence: hostGate }));
  assert.equal(r.ok, true);
});
