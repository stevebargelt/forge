// FG-664 half (B): the recheck ledger stops recording a FALSE FACT about lanes that
// executed nothing.
//
// THE LIVE DEFECT. A rechecker that could not load the project's real native database
// driver substituted a different SQLite implementation, ran the regression suite against
// it, and reported the resulting engine-difference failures as three findings still being
// present (FG-662, review-6b9e07e48cc6 / RF-1, RF-3, RF-4). Stage 8 recorded all three with
// `coverage: "executed"` — a hardcoded constant on the non-`resolved` arm — so the ledger
// asserted that tests had run for findings whose lane could not run one.
//
// WHAT THESE TESTS PIN. Coverage on that arm is now CLASSIFIED from what the entry actually
// carries; nothing is `executed` by default. The verdict plane is untouched, and the
// `resolved` arm is unchanged — the last two tests here exist to keep it that way.
//
// WHAT THEY DELIBERATELY DO NOT PIN. A substituted engine that emits plausible `not ok`
// lines is textually indistinguishable from a real regression. No assertion in this file
// detects that, and none should be added claiming to: that is FG-664's host-side half.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestRecheck } from "./review-recheck.js";
import { classifyRecheckCoverage } from "./review-evidence.js";
import type { ReviewFinding } from "../store/reviews.js";

const REVIEW = "review-r1";
const SHA = "final222";
const TEST_NAME = "the reconcile path guards a partial write";

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

function output(rechecked: unknown[]) {
  return { review_id: REVIEW, candidate_sha: SHA, rechecked, new_findings: [] };
}

/** Ingest ONE entry about RF-1 and hand back the application it produced. */
function ingestOne(entry: Record<string, unknown>) {
  const r = ingestRecheck(output([{ finding_id: "RF-1", ...entry }]), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 })],
  });
  assert.equal(r.ok, true, r.ok ? "" : r.refusal);
  if (!r.ok) throw new Error("unreachable");
  const a = r.applications[0];
  assert.ok(a !== undefined);
  return a;
}

// ─── the honest record for a still_present verdict ──────────────────────────

test("FG-664: a still_present entry whose cited test RAN AND FAILED records coverage executed", () => {
  const a = ingestOne({
    result: "still_present",
    evidence_kind: "regression_test",
    evidence: {
      kind: "regression_test",
      test_name: TEST_NAME,
      runner_output: [`not ok 1 - ${TEST_NAME}`, "  ---", "  error: 'expected 1, got 0'", "  ..."].join("\n"),
    },
    note: "the guard is still after the early return at src/a.ts:14",
  });

  // A test that ran and went red IS executed coverage — and it is the shape a truthful
  // `still_present` verdict has. The resolution arm records a red cited test `not_executed`
  // for its own (correct) reason; that calibration must not leak onto this arm.
  assert.equal(a.coverage, "executed");
  assert.equal(a.resolution, "still_present", "the verdict plane is untouched");
  assert.equal(a.detail, "the guard is still after the early return at src/a.ts:14");
});

test("FG-664: a still_present entry whose cited test PASSED still records executed — coverage is 'it ran', not 'it was green'", () => {
  const a = ingestOne({
    result: "still_present",
    evidence_kind: "regression_test",
    evidence: { kind: "regression_test", test_name: TEST_NAME, runner_output: `ok 1 - ${TEST_NAME}` },
    note: "the test passes but the mechanism it covers is not the one the finding names",
  });
  assert.equal(a.coverage, "executed");
});

// ─── the defect: a lane that executed nothing ───────────────────────────────

test("FG-664: a still_present entry with NO runner output records not_executed, not executed", () => {
  const a = ingestOne({
    result: "still_present",
    evidence_kind: "regression_test",
    evidence: { kind: "regression_test", test_name: TEST_NAME },
    note: "I read the code and the guard is still missing",
  });
  assert.equal(a.coverage, "not_executed", "a citation with nothing behind it never records executed coverage");
  assert.equal(a.resolution, "still_present", "the verdict the rechecker reported is recorded as reported");
});

test("FG-664: an inconclusive entry with no runner output records not_executed", () => {
  const a = ingestOne({
    result: "inconclusive",
    evidence_kind: "regression_test",
    evidence: { kind: "regression_test", test_name: TEST_NAME, runner_output: "   " },
    note: "could not tell",
  });
  assert.equal(a.coverage, "not_executed");
  assert.equal(a.resolution, "inconclusive");
});

test("FG-664: a cited test that SKIPPED records not_executed — a skipped test is never coverage, on any arm", () => {
  const a = ingestOne({
    result: "still_present",
    evidence_kind: "regression_test",
    evidence: {
      kind: "regression_test",
      test_name: TEST_NAME,
      runner_output: [`ok 1 - ${TEST_NAME} # SKIP no agent image`, "# pass 0", "# skipped 1"].join("\n"),
    },
    note: "still there",
  });
  assert.equal(a.coverage, "not_executed");
});

test("FG-664: a cited test ABSENT from the output records not_executed — a green suite is not per-test execution", () => {
  const a = ingestOne({
    result: "still_present",
    evidence_kind: "regression_test",
    evidence: {
      kind: "regression_test",
      test_name: TEST_NAME,
      runner_output: ["ok 1 - some other assertion entirely", "# pass 1", "# fail 0"].join("\n"),
    },
    note: "still there",
  });
  assert.equal(a.coverage, "not_executed");
});

test("FG-664: a still_present entry declaring environment_blocked records blocked_environment", () => {
  const a = ingestOne({
    result: "still_present",
    evidence_kind: "regression_test",
    evidence: {
      kind: "regression_test",
      test_name: TEST_NAME,
      environment_blocked:
        "better-sqlite3 could not be loaded in this container (NODE_MODULE_VERSION mismatch)",
    },
    note: "the suite failed under a substituted engine",
  });
  assert.equal(a.coverage, "blocked_environment");
  assert.equal(a.resolution, "still_present", "the stop that consumes this value is a separate caller's job");
});

test("FG-664: THE LIVE FG-662 SHAPE — a lane that ran nothing no longer writes executed coverage for three findings", () => {
  const blocked = (ref: string) => ({
    finding_id: ref,
    result: "still_present",
    evidence_kind: "regression_test",
    evidence: {
      kind: "regression_test",
      test_name: TEST_NAME,
      environment_blocked: "better-sqlite3 ABI mismatch; substituted a node:sqlite shim",
    },
    note: "the regression suite failed at this candidate",
  });
  const r = ingestRecheck(output([blocked("RF-1"), blocked("RF-3"), blocked("RF-4")]), {
    reviewId: REVIEW,
    candidateSha: SHA,
    expected: [finding({ ordinal: 1 }), finding({ ordinal: 3 }), finding({ ordinal: 4 })],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    r.applications.map((a) => [a.findingRef, a.coverage]),
    [
      ["RF-1", "blocked_environment"],
      ["RF-3", "blocked_environment"],
      ["RF-4", "blocked_environment"],
    ],
  );
  assert.equal(
    r.applications.some((a) => a.resolution === "resolved"),
    false,
    "a blocked lane resolves nothing — it is never green in either direction",
  );
});

// ─── nothing is `executed` by default ───────────────────────────────────────

test("FG-664: NO entry is recorded executed by default — every non-executing evidence shape records not_executed", () => {
  const shapes: Array<[string, unknown]> = [
    ["empty object (the shape a note-only entry carries today)", {}],
    ["prose masquerading as evidence", "I checked and it is still broken"],
    ["null", null],
    ["a bounded inspection — reading the source executes nothing", {
      kind: "bounded_inspection",
      inspection: "read src/a.ts:14 and the guard is still after the early return",
      limitation: "static reading only; nothing was run",
    }],
    ["an anchored verification whose step's test never appears", {
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 14,
      fact: "the guard is still after the early return",
      verification_step: { ran: TEST_NAME, runner_output: "ok 1 - a different test" },
    }],
    ["an anchored verification whose step's test SKIPPED", {
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 14,
      fact: "the guard is still after the early return",
      verification_step: { ran: TEST_NAME, runner_output: `ok 1 - ${TEST_NAME} # SKIP` },
    }],
  ];

  for (const [label, evidence] of shapes) {
    const a = ingestOne({ result: "still_present", evidence_kind: "anchored_verification", evidence, note: label });
    assert.equal(a.coverage, "not_executed", `recorded executed coverage for ${label}`);
    assert.equal(a.resolution, "still_present", `the verdict changed for ${label}`);
  }
});

test("FG-664: evidence that DID execute records executed — the classifier is not a blanket downgrade", () => {
  // The mirror of the test above: classifying is not "record not_executed for everything
  // that is not a green regression test". A step that ran is recorded as having run.
  assert.equal(
    classifyRecheckCoverage({
      kind: "replayed_reproduction",
      command: "node dist/repro.js",
      output: "TypeError: cannot read property 'id' of undefined",
    }),
    "executed",
  );
  assert.equal(
    classifyRecheckCoverage({
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 14,
      fact: "the guard is still after the early return",
      verification_step: { command: "npx tsc --noEmit", output: "src/a.ts(14,3): error TS2532", exit_status: 2 },
    }),
    "executed",
    "a command that ran and exited nonzero RAN — a red check is executed coverage on this arm",
  );
  assert.equal(
    classifyRecheckCoverage({
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 14,
      fact: "the guard is still after the early return",
      verification_step: { ran: TEST_NAME, runner_output: `not ok 1 - ${TEST_NAME}` },
    }),
    "executed",
  );
  assert.equal(
    classifyRecheckCoverage({
      kind: "regression_test",
      test_name: `${TEST_NAME}; the second assertion`,
      runner_output: [`ok 1 - ${TEST_NAME}`, "not ok 2 - the second assertion"].join("\n"),
    }),
    "executed",
    "a multi-name citation where one member went red still RAN",
  );
});

test("FG-719: a PASSING cited test with environment_blocked:false records executed coverage, not blocked_environment", () => {
  // The boolean `false` means 'nothing blocked the check'. It must normalize to absent, so
  // the classifier reads the runner output rather than short-circuiting to blocked_environment
  // (or failing the parse into not_executed).
  assert.equal(
    classifyRecheckCoverage({
      kind: "regression_test",
      test_name: TEST_NAME,
      runner_output: `ok 1 - ${TEST_NAME}`,
      environment_blocked: false,
    }),
    "executed",
  );
});

// ─── the resolved arm is unchanged ──────────────────────────────────────────

test("FG-664: the resolved arm is unchanged — evidence kind, coverage and detail are exactly as before", () => {
  const a = ingestOne({
    result: "resolved",
    evidence_kind: "regression_test",
    evidence: {
      kind: "regression_test",
      test_name: TEST_NAME,
      test_file: "src/store/reviews.test.ts",
      runner_output: `ok 1 - ${TEST_NAME}`,
    },
  });
  assert.equal(a.resolution, "resolved");
  assert.equal(a.coverage, "executed");
  assert.equal(a.evidenceKind, "regression_test");
  assert.equal(a.evidence, `${TEST_NAME} executed against ${SHA}`);
  assert.equal(a.detail, `${TEST_NAME} executed against ${SHA}`);
});

test("FG-664: the resolved arm's refusal strings are unchanged — a red cited test still records not_executed there", () => {
  // The calibration this ticket deliberately did NOT share. On the resolution arm a FAILED
  // cited test is `not_executed` (a red assertion resolves nothing); on the still_present
  // arm the same payload is `executed` (the test ran). Both are asserted here so a later
  // "unify these" refactor has to face the divergence rather than discover it.
  const failed = ingestOne({
    result: "resolved",
    evidence_kind: "regression_test",
    evidence: { kind: "regression_test", test_name: TEST_NAME, runner_output: `not ok 1 - ${TEST_NAME}` },
  });
  assert.equal(failed.resolution, "inconclusive");
  assert.equal(failed.coverage, "not_executed");
  assert.match(failed.detail, /FAILED in the cited runner output — a failing test is never resolution evidence/);

  const skipped = ingestOne({
    result: "resolved",
    evidence_kind: "regression_test",
    evidence: { kind: "regression_test", test_name: TEST_NAME, runner_output: `ok 1 - ${TEST_NAME} # SKIP` },
  });
  assert.equal(skipped.resolution, "inconclusive");
  assert.equal(skipped.coverage, "not_executed");
  assert.match(skipped.detail, /SKIPPED in the cited runner output — a skipped test is never evidence/);

  const blocked = ingestOne({
    result: "resolved",
    evidence_kind: "regression_test",
    evidence: { kind: "regression_test", test_name: TEST_NAME, environment_blocked: "no agent image" },
  });
  assert.equal(blocked.resolution, "inconclusive");
  assert.equal(blocked.coverage, "blocked_environment");
  assert.match(blocked.detail, /coverage is recorded blocked_environment, never green and never resolved/);
});
