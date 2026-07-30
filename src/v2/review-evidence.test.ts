// FG-639: what counts as evidence.
//
// THE OPERATOR'S SKIP-EVIDENCE RULE (2026-07-29) IS THE CENTRE OF THIS FILE. Its named
// acceptance test — "a recheck result citing a skipped test as resolution evidence is
// rejected by the host with a named reason" — is below, and so is the property that makes
// it more than a string check: execution is established PER TEST from the runner's own
// output, so a green suite containing a skipped test is refused exactly as loudly as a red
// one. The alternate-lane escape hatch is tested from both sides: named completely — lane,
// candidate sha, assertion AND that lane's own execution record for it — it works, and every
// way of being vague about it, including naming a lane with no record, does not.
//
// The rule holds ACROSS EVIDENCE KINDS, not just for a cited test: every kind is enforced
// structurally per kind, and an anchored verification whose step skipped is refused exactly
// like a skipped regression test.
//
// The proportionality half is the other non-negotiable: a `demonstrated` finding cannot be
// closed by re-inspecting the code (PRD #26), and a `bounded_inspection` must state its
// own limitation to be usable at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessAcceptanceClaims,
  testExecution,
  validateResolutionEvidence,
} from "./review-evidence.js";

const SHA = "cand1111";

// Real node:test TAP output, including the two skip shapes it emits.
const TAP_GREEN_WITH_SKIP = [
  "TAP version 13",
  "ok 1 - the ledger records one source per reviewer",
  "ok 2 - a blocked environment never resolves a finding # SKIP agent image unavailable",
  "ok 3 - dedup keeps both when the invariants differ",
  "1..3",
  "# pass 2",
  "# skipped 1",
  "# fail 0",
].join("\n");

const GLYPH_OUTPUT = [
  "✔ the ledger records one source per reviewer (1.204ms)",
  "﹣ a blocked environment never resolves a finding (0ms) # SKIP agent image unavailable",
  "✔ dedup keeps both when the invariants differ (0.9ms)",
].join("\n");

// ─── per-test execution identity ────────────────────────────────────────────

test("FG-639: per-test identity reads EXECUTED from TAP output", () => {
  assert.equal(testExecution(TAP_GREEN_WITH_SKIP, "the ledger records one source per reviewer"), "executed");
});

test("FG-639: per-test identity reads SKIPPED even though the suite exited green", () => {
  assert.equal(testExecution(TAP_GREEN_WITH_SKIP, "a blocked environment never resolves a finding"), "skipped");
});

test("FG-639: a test that never appears in the output is ABSENT, not passing", () => {
  assert.equal(testExecution(TAP_GREEN_WITH_SKIP, "a test nobody wrote"), "absent");
});

test("FG-639: the glyph reporter's skip marker is read as skipped, its check as executed", () => {
  assert.equal(testExecution(GLYPH_OUTPUT, "dedup keeps both when the invariants differ"), "executed");
  assert.equal(testExecution(GLYPH_OUTPUT, "a blocked environment never resolves a finding"), "skipped");
});

test("FG-639: a name that is skipped in one variant and executed in another reads as executed", () => {
  const out = ["ok 1 - guard holds # SKIP no image", "ok 2 - guard holds"].join("\n");
  assert.equal(testExecution(out, "guard holds"), "executed");
});

test("FG-639: a subtest path is matched by its leaf name", () => {
  assert.equal(testExecution("ok 1 - reviews > guard holds", "guard holds"), "executed");
});

// ─── THE skip-evidence acceptance test ──────────────────────────────────────

test("FG-639 / PRD #29 (operator skip-evidence rule): a recheck citing a SKIPPED test is REJECTED with a named reason", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "a blocked environment never resolves a finding",
      test_file: "src/store/reviews.test.ts",
      runner_output: TAP_GREEN_WITH_SKIP,
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-4" },
  );

  assert.equal(check.ok, false, "a skipped test is never evidence");
  if (check.ok) return;
  assert.match(check.refusal, /SKIPPED/, "the refusal must NAME the reason");
  assert.match(check.refusal, /even when the enclosing suite exited green/);
  assert.equal(check.coverage, "not_executed", "the coverage is recorded not_executed, never green");
});

test("FG-639 / PRD #29: the same skipped test IS accepted once a mandatory lane shows the assertion EXECUTING", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "a blocked environment never resolves a finding",
      runner_output: TAP_GREEN_WITH_SKIP,
      alternate_lane: {
        lane: "test-extended / integration_2",
        candidate_sha: SHA,
        executed_assertion: "a blocked environment never resolves a finding",
        runner_output: "ok 1 - a blocked environment never resolves a finding",
      },
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-4" },
  );
  assert.equal(check.ok, true);
  assert.match(check.ok ? check.detail : "", /mandatory lane 'test-extended \/ integration_2' executed/);
});

test("FG-639 / PRD #29: an alternate lane named WITHOUT its execution record resolves nothing", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "a blocked environment never resolves a finding",
      runner_output: TAP_GREEN_WITH_SKIP,
      alternate_lane: {
        lane: "test-extended / integration_2",
        candidate_sha: SHA,
        executed_assertion: "a blocked environment never resolves a finding",
      },
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-4" },
  );
  assert.equal(check.ok, false, "free text naming a lane is not an execution record");
  if (check.ok) return;
  assert.match(check.refusal, /carries no execution record/, "the refusal must name what is missing");
  assert.match(check.refusal, /same per-test identity the primary lane is/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-639 / PRD #29: an alternate lane whose record shows the assertion ABSENT is refused for being absent", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the guard",
      runner_output: "ok 1 - the guard # SKIP",
      alternate_lane: {
        lane: "test-extended",
        candidate_sha: SHA,
        executed_assertion: "the guard",
        runner_output: "ok 1 - something else entirely",
      },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-9" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /does not appear in its own output at all/);
});

test("FG-639 / PRD #29: a blocked environment is not rescued by an alternate lane named without its record", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the container starts",
      environment_blocked: "the agent-dev-worker image is not built in this lane",
      alternate_lane: { lane: "test-extended", candidate_sha: SHA, executed_assertion: "the container starts" },
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-7" },
  );
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.coverage, "blocked_environment", "the coverage outcome the blocked case calls for is kept");
  assert.match(check.refusal, /carries no execution record/);
});

test("FG-639 / PRD #29: unnamed \"covered elsewhere\" is refused — the lane, sha and assertion are all required", () => {
  const check = validateResolutionEvidence(
    { kind: "regression_test", test_name: "the guard", runner_output: "ok 1 - the guard # SKIP" },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-9" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /No alternate lane is named/);
  assert.match(check.ok ? "" : check.refusal, /unnamed "covered elsewhere" is refused/);
});

test("FG-639 / PRD #29: an alternate lane at a DIFFERENT candidate sha is refused by name", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the guard",
      runner_output: "ok 1 - the guard # SKIP",
      alternate_lane: { lane: "test-extended", candidate_sha: "someotherSha", executed_assertion: "the guard" },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-9" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /names candidate someotherSha, not this review's candidate/);
});

test("FG-639 / PRD #29: an alternate lane whose OWN output shows the assertion skipped is refused", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the guard",
      runner_output: "ok 1 - the guard # SKIP",
      alternate_lane: {
        lane: "test-extended",
        candidate_sha: SHA,
        executed_assertion: "the guard",
        runner_output: "ok 1 - the guard # SKIP also here",
      },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-9" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /its own output shows that assertion skipped/);
  assert.match(check.ok ? "" : check.refusal, /never evidence, in any lane/);
});

test("FG-639: a cited test with NO runner output cannot establish execution", () => {
  const check = validateResolutionEvidence(
    { kind: "regression_test", test_name: "the guard", test_file: "src/x.test.ts" },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-1" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /A green suite is not per-test execution/);
  assert.equal(check.ok ? "" : check.coverage, "not_executed");
});

test("FG-639: a test ABSENT from the cited output is refused for being absent, not for being red", () => {
  const check = validateResolutionEvidence(
    { kind: "regression_test", test_name: "a test nobody wrote", runner_output: TAP_GREEN_WITH_SKIP },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-1" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /does not appear in the cited runner output at all/);
});

test("FG-639 / PRD #29: a blocked environment records blocked_environment, never green", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the container starts",
      environment_blocked: "the agent-dev-worker image is not built in this lane",
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-7" },
  );
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.coverage, "blocked_environment");
  assert.match(check.refusal, /never green and never resolved/);
});

test("FG-639: an executed test resolves and reports the candidate it executed against", () => {
  const check = validateResolutionEvidence(
    { kind: "regression_test", test_name: "dedup keeps both when the invariants differ", runner_output: TAP_GREEN_WITH_SKIP },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-2" },
  );
  assert.equal(check.ok, true);
  assert.match(check.ok ? check.detail : "", new RegExp(`executed against ${SHA}`));
});

// ─── proportional resolution evidence ───────────────────────────────────────

test("FG-639 / PRD #26: a DEMONSTRATED finding cannot be resolved by bounded inspection alone", () => {
  const check = validateResolutionEvidence(
    { kind: "bounded_inspection", inspection: "I read the new guard and it looks right", limitation: "not executed" },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-3" },
  );
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.refusal, /never closed by model re-inspection/);
  assert.match(check.refusal, /named regression test/);
});

const EXECUTED_STEP = {
  ran: "dedup keeps both when the invariants differ",
  runner_output: TAP_GREEN_WITH_SKIP,
};

test("FG-639 / PRD #26: a demonstrated finding is not resolved by anchored verification either", () => {
  const check = validateResolutionEvidence(
    { kind: "anchored_verification", file: "src/a.ts", line: 12, fact: "the guard is now first", verification_step: EXECUTED_STEP },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-3" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /requires regression_test or replayed_reproduction/);
});

test("FG-639: a demonstrated finding IS resolved by a replayed reproduction with its output", () => {
  const check = validateResolutionEvidence(
    { kind: "replayed_reproduction", command: "node --test src/store/reviews.test.ts", output: "ok 1 - the guard" },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-3" },
  );
  assert.equal(check.ok, true);
});

// ─── per-kind structural enforcement (the two kinds that used to bypass it) ──

test("FG-639: a replayed reproduction MISSING its command, or its output, is refused writing nothing", () => {
  for (const partial of [
    { kind: "replayed_reproduction", output: "ok 1 - the guard" },
    { kind: "replayed_reproduction", command: "node --test src/store/reviews.test.ts" },
    { kind: "replayed_reproduction", command: "node --test x", output: "   " },
  ]) {
    const check = validateResolutionEvidence(partial, {
      candidateSha: SHA,
      reachability: "demonstrated",
      findingRef: "RF-3",
    });
    assert.equal(check.ok, false, `${JSON.stringify(partial)} must not resolve anything`);
    assert.match(check.ok ? "" : check.refusal, /did not validate/);
    assert.equal(check.ok ? "" : check.coverage, "not_executed");
  }
});

test("FG-639: an anchored verification MISSING file, line or its verification step is refused", () => {
  for (const partial of [
    { kind: "anchored_verification", line: 12, fact: "the guard is first", verification_step: EXECUTED_STEP },
    { kind: "anchored_verification", file: "src/a.ts", fact: "the guard is first", verification_step: EXECUTED_STEP },
    { kind: "anchored_verification", file: "src/a.ts", line: 0, fact: "the guard is first", verification_step: EXECUTED_STEP },
    { kind: "anchored_verification", file: "src/a.ts", line: 12, fact: "the guard is first" },
  ]) {
    const check = validateResolutionEvidence(partial, {
      candidateSha: SHA,
      reachability: "supported",
      findingRef: "RF-5",
    });
    assert.equal(check.ok, false, `${JSON.stringify(partial)} must not resolve anything`);
    assert.match(check.ok ? "" : check.refusal, /did not validate/);
  }
});

test("FG-639: a verification step given as PROSE is refused — the step must carry its executed identity", () => {
  const check = validateResolutionEvidence(
    { kind: "anchored_verification", file: "src/a.ts", line: 12, fact: "the guard is first", verification_step: "I ran npm run test:unit" },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-5" },
  );
  assert.equal(check.ok, false, "a claim that a step ran is not the step's outcome");
  assert.match(check.ok ? "" : check.refusal, /did not validate/);
});

test("FG-639 / PRD #29: a verification step citing a SKIPPED check resolves nothing", () => {
  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 12,
      fact: "the guard is first",
      verification_step: {
        ran: "a blocked environment never resolves a finding",
        runner_output: TAP_GREEN_WITH_SKIP,
      },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-5" },
  );
  assert.equal(check.ok, false, "the skip rule is not bypassed by the evidence kind");
  if (check.ok) return;
  assert.match(check.refusal, /SKIPPED/);
  assert.match(check.refusal, /never evidence, in any lane or any evidence kind/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-639: a SUPPORTED finding needs anchored evidence PLUS an EXECUTED verification step", () => {
  const complete = validateResolutionEvidence(
    { kind: "anchored_verification", file: "src/a.ts", line: 12, fact: "the guard is first", verification_step: EXECUTED_STEP },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-5" },
  );
  assert.equal(complete.ok, true);
  assert.match(complete.ok ? complete.detail : "", /which executed/);

  const noStep = validateResolutionEvidence(
    { kind: "anchored_verification", file: "src/a.ts", line: 12, fact: "the guard is first" },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-5" },
  );
  assert.equal(noStep.ok, false, "anchored code reading alone is an argument about the source");
});

test("FG-639: a SPECULATIVE finding may be resolved by bounded inspection with its limitation explicit", () => {
  const withLimit = validateResolutionEvidence(
    { kind: "bounded_inspection", inspection: "read every caller of the guard", limitation: "callers reached by reflection not covered" },
    { candidateSha: SHA, reachability: "speculative", findingRef: "RF-6" },
  );
  assert.equal(withLimit.ok, true);

  const noLimit = validateResolutionEvidence(
    { kind: "bounded_inspection", inspection: "read every caller of the guard" },
    { candidateSha: SHA, reachability: "speculative", findingRef: "RF-6" },
  );
  assert.equal(noLimit.ok, false, "a bounded inspection whose bound is unstated claims more than it is");
});

test("FG-639: an unrecognized evidence shape is refused, naming what did not validate", () => {
  const check = validateResolutionEvidence(
    { kind: "vibes", note: "trust me" },
    { candidateSha: SHA, reachability: "speculative", findingRef: "RF-8" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /resolution evidence did not validate/);
});

// ─── acceptance-criterion mapping (Stage 9 check 2) ─────────────────────────

test("FG-639 / PRD #29: an acceptance criterion whose only evidence is a SKIPPED test is unproven", () => {
  const [a] = assessAcceptanceClaims(
    [
      {
        ref: "FG-639 AC 1",
        verdict: "met",
        evidence: {
          kind: "regression_test",
          test_name: "a blocked environment never resolves a finding",
          runner_output: TAP_GREEN_WITH_SKIP,
        },
      },
    ],
    SHA,
  );
  assert.equal(a?.verdict, "unproven");
  assert.match(a?.detail ?? "", /SKIPPED/);
});

test("FG-639: an acceptance criterion claimed met with NO cited evidence is unproven", () => {
  const [a] = assessAcceptanceClaims([{ ref: "AC 1", verdict: "met" }], SHA);
  assert.equal(a?.verdict, "unproven");
  assert.match(a?.detail ?? "", /no cited evidence/);
});

test("FG-639: an acceptance criterion citing an EXECUTED test is met", () => {
  const [a] = assessAcceptanceClaims(
    [
      {
        ref: "AC 1",
        verdict: "met",
        evidence: { kind: "regression_test", test_name: "dedup keeps both when the invariants differ", runner_output: TAP_GREEN_WITH_SKIP },
      },
    ],
    SHA,
  );
  assert.equal(a?.verdict, "met");
});

test("FG-639: an unmet claim is reported as claimed, not re-derived", () => {
  const [a] = assessAcceptanceClaims([{ ref: "AC 2", verdict: "unmet" }], SHA);
  assert.equal(a?.verdict, "unmet");
});
