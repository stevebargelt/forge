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
  resolveTestExecution,
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

// ─── kind-aware execution: a verification step is not always a test ─────────
//
// The TAP/glyph parser answers "did this test run" about a TEST RUNNER's output. Applied to
// tsc, a curl or a script it can only ever answer "absent", so a typecheck that genuinely ran
// was refused for not being TAP — while a markdown bullet, which the glyph class used to match
// on the ASCII hyphen, read as a PASSING test line. Both directions are wrong, and both are
// pinned here.

// Real `npm run typecheck` output for a clean tree: the npm banner, then nothing from tsc.
const TSC_CLEAN = ["", "> forge@0.1.0 typecheck", "> tsc --noEmit", ""].join("\n");
const TSC_RED = [
  "",
  "> forge@0.1.0 typecheck",
  "> tsc --noEmit",
  "",
  "src/v2/review-run.ts(249,17): error TS2345: Argument of type 'string | undefined' is not assignable.",
  "",
].join("\n");

test("FG-639: a NON-TEST verification step is accepted on its own runner's record — command, output, exit 0", () => {
  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/review-run.ts",
      line: 249,
      fact: "the base sha is read from persisted state before the diff is computed",
      verification_step: { command: "npm run typecheck", output: TSC_CLEAN, exit_status: 0 },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-10" },
  );
  assert.equal(check.ok, true, check.ok ? "" : check.refusal);
  assert.match(check.ok ? check.detail : "", /npm run typecheck/, "the step that ran is named in the record");
});

test("FG-639: a FAILED non-test step is refused as resolution evidence, naming the exit status", () => {
  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/review-run.ts",
      line: 249,
      fact: "the guard is first",
      verification_step: { command: "npm run typecheck", output: TSC_RED, exit_status: 2 },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-10" },
  );
  assert.equal(check.ok, false, "a step that ran and FAILED resolves nothing");
  if (check.ok) return;
  assert.match(check.refusal, /exited 2/, "the refusal names what failed and how");
  assert.match(check.refusal, /FAILED is never resolution evidence/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-639: a non-test step with NO exit status does not validate — the exit status IS the execution record", () => {
  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 12,
      fact: "the guard is first",
      verification_step: { command: "npm run typecheck", output: TSC_CLEAN },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-10" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /did not validate/);
});

test("FG-639: MARKDOWN BULLET PROSE does not read as an executed test", () => {
  const bullets = ["- ran the typecheck", "- ran the unit tier", "- the guard is first"].join("\n");
  assert.equal(testExecution(bullets, "ran the typecheck"), "absent", "a bullet is not a runner line");

  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 12,
      fact: "the guard is first",
      verification_step: { ran: "ran the typecheck", runner_output: bullets },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-11" },
  );
  assert.equal(check.ok, false, "prose formatted as a list is still prose");
  assert.match(check.ok ? "" : check.refusal, /nowhere at all, so nothing establishes that it ran/);
});

test("FG-639: TAP is still parsed for a TEST verification step", () => {
  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/a.ts",
      line: 12,
      fact: "the guard is first",
      verification_step: { ran: "dedup keeps both when the invariants differ", runner_output: TAP_GREEN_WITH_SKIP },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-12" },
  );
  assert.equal(check.ok, true, check.ok ? "" : check.refusal);
});

// ─── the trichotomy gains `failed` ──────────────────────────────────────────

test("FG-639: a `not ok` TAP line reads as FAILED, not as executed", () => {
  assert.equal(testExecution("not ok 3 - the reconcile path guards a partial write", "the reconcile path guards a partial write"), "failed");
  assert.equal(testExecution("✖ the reconcile path guards a partial write (2.1ms)", "the reconcile path guards a partial write"), "failed");
});

test("FG-639: a failure dominates a green sibling of the same name", () => {
  const mixed = ["ok 1 - guard holds", "not ok 2 - guard holds"].join("\n");
  assert.equal(testExecution(mixed, "guard holds"), "failed", "a red assertion is not cancelled by a green one");
});

test("FG-639: a `not ok` line carrying a TAP directive reads as FAILED, not as skipped", () => {
  // The directive branch used to be evaluated FIRST, so a red line with `# TODO` on it read
  // as `skipped` — and a skipped reading is the one an alternate lane may rescue.
  assert.equal(testExecution("not ok 1 - the guard # TODO", "the guard"), "failed");
  assert.equal(testExecution("not ok 1 - the guard # SKIP no image", "the guard"), "failed");
  assert.equal(
    testExecution(["TAP version 13", "not ok 4 - the guard # TODO not written yet", "1..4"].join("\n"), "the guard"),
    "failed",
  );
});

test("FG-639: a directive on a PASSING line still reads as skipped — the reorder narrowed nothing", () => {
  assert.equal(testExecution("ok 1 - the guard # SKIP no image", "the guard"), "skipped");
  assert.equal(testExecution("ok 1 - the guard # TODO", "the guard"), "skipped");
  assert.equal(testExecution("﹣ the guard (0ms) # SKIP no image", "the guard"), "skipped");
});

test("FG-639: a RED cited test with a TODO directive is not rescued by a well-formed alternate lane", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the guard",
      runner_output: "not ok 1 - the guard # TODO",
      alternate_lane: {
        lane: "test-extended",
        candidate_sha: SHA,
        executed_assertion: "the guard",
        runner_output: "ok 1 - the guard",
      },
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-1" },
  );
  assert.equal(check.ok, false, "the directive must not downgrade a red test into a rescuable skip");
  if (check.ok) return;
  assert.match(check.refusal, /FAILED in the cited runner output/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-639: a verification step whose test line is red UNDER a directive is refused as failed", () => {
  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/review-evidence.ts",
      line: 216,
      fact: "the skip branch runs before the failure branch",
      verification_step: { ran: "the guard", runner_output: "not ok 1 - the guard # SKIP no image" },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-1" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /FAILED — a failed check is never resolution evidence/);
});

test("FG-639: a cited regression test that FAILED is refused as resolution evidence", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the reconcile path guards a partial write",
      runner_output: ["TAP version 13", "not ok 1 - the reconcile path guards a partial write", "1..1", "# fail 1"].join("\n"),
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-13" },
  );
  assert.equal(check.ok, false, "a red test is the finding still being present");
  if (check.ok) return;
  assert.match(check.refusal, /FAILED in the cited runner output/);
  assert.match(check.refusal, /never resolution evidence/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-639: a failing cited test is NOT rescued by an alternate lane", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the guard",
      runner_output: "not ok 1 - the guard",
      alternate_lane: {
        lane: "test-extended",
        candidate_sha: SHA,
        executed_assertion: "the guard",
        runner_output: "ok 1 - the guard",
      },
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-13" },
  );
  assert.equal(check.ok, false, "a skip is a gap another lane can fill; a failure at this candidate is not");
  assert.match(check.ok ? "" : check.refusal, /FAILED in the cited runner output/);
});

test("FG-639: an alternate lane whose own output shows the assertion FAILING is refused by name", () => {
  const check = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: "the guard",
      runner_output: "ok 1 - the guard # SKIP",
      alternate_lane: {
        lane: "test-extended",
        candidate_sha: SHA,
        executed_assertion: "the guard",
        runner_output: "not ok 1 - the guard",
      },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-14" },
  );
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /shows that assertion FAILING/);
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

// ─── a cited identity may name MORE THAN ONE test (FG-657) ──────────────────
//
// One finding is often covered by several tests, and the honest thing an agent writes is
// all of them. The composite never equalled any single captured name, so a complete and
// passing citation read as ABSENT and its coverage was recorded not_executed — a false
// negative that no fix cycle could clear. The list is now resolved to its members, and
// the standard is UNCHANGED in every direction that matters: every named test must have
// executed, one skipped/failed/absent member refuses the whole claim, and the refusal
// names WHICH member rather than handing back the list the reader already had.

const THREE_NAMES = [
  "FG-654: a manifest-consistent generation BEHIND the executing release refuses as stale",
  "FG-654: doctor's inspection carries the same stale arm, by role",
  "integ FG-654: a generation BEHIND the executing release refuses at dispatch, before any container",
];

const THREE_GREEN = [
  `✔ ${THREE_NAMES[0]} (1.612ms)`,
  `✔ ${THREE_NAMES[1]} (0.742ms)`,
  `✔ ${THREE_NAMES[2]} (3.104ms)`,
  "ℹ tests 23",
  "ℹ pass 23",
  "ℹ fail 0",
  "ℹ skipped 0",
].join("\n");

test("FG-657: a SINGLE-name identity is unchanged — the list rule is not a new reading of one name", () => {
  assert.equal(testExecution(TAP_GREEN_WITH_SKIP, "the ledger records one source per reviewer"), "executed");
  assert.equal(testExecution(TAP_GREEN_WITH_SKIP, "a blocked environment never resolves a finding"), "skipped");
  assert.equal(testExecution(TAP_GREEN_WITH_SKIP, "a test nobody wrote"), "absent");
  assert.equal(testExecution("not ok 1 - the guard # TODO", "the guard"), "failed");
  assert.equal(testExecution("ok 1 - reviews > guard holds", "guard holds"), "executed", "suite-qualified still matches");
  assert.equal(testExecution(GLYPH_OUTPUT, "dedup keeps both when the invariants differ"), "executed", "timing still stripped");
});

test("FG-657: a step naming N tests, all present and passing, is EXECUTED — as a string and as an array", () => {
  assert.equal(testExecution(THREE_GREEN, THREE_NAMES.join("; ")), "executed");
  assert.equal(testExecution(THREE_GREEN, THREE_NAMES), "executed");
});

test("FG-657: the FG-654 rechecker evidence that was recorded not_executed validates as executed", () => {
  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/dispatch.ts",
      line: 412,
      fact: "the executing release's generation is compared before dispatch, not after",
      verification_step: { ran: THREE_NAMES.join("; "), runner_output: THREE_GREEN },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-6" },
  );
  assert.equal(check.ok, true, check.ok ? "" : check.refusal);
});

test("FG-657: one SKIPPED member refuses the whole step, and the refusal names that member only", () => {
  const output = [
    `✔ ${THREE_NAMES[0]} (1.612ms)`,
    `﹣ ${THREE_NAMES[1]} (0ms) # SKIP agent image unavailable`,
    `✔ ${THREE_NAMES[2]} (3.104ms)`,
  ].join("\n");
  assert.equal(testExecution(output, THREE_NAMES.join("; ")), "skipped");
  assert.deepEqual(resolveTestExecution(output, THREE_NAMES), { execution: "skipped", test: THREE_NAMES[1] });

  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/dispatch.ts",
      line: 412,
      fact: "the generation is compared before dispatch",
      verification_step: { ran: THREE_NAMES.join("; "), runner_output: output },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-6" },
  );
  assert.equal(check.ok, false, "a green suite around one skipped member is still a skip");
  if (check.ok) return;
  assert.match(check.refusal, /SKIPPED — a skipped check is never evidence/);
  assert.match(check.refusal, /doctor's inspection carries the same stale arm/, "the refusal names WHICH member");
  assert.doesNotMatch(check.refusal, /refuses at dispatch/, "and not the members that were fine");
  assert.match(check.refusal, /one of the 3 tests that step names/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-657: one FAILED member refuses the whole step, and failure dominates a skipped sibling", () => {
  const output = [
    `✔ ${THREE_NAMES[0]} (1.612ms)`,
    `﹣ ${THREE_NAMES[1]} (0ms) # SKIP agent image unavailable`,
    `✖ ${THREE_NAMES[2]} (3.104ms)`,
  ].join("\n");
  assert.equal(testExecution(output, THREE_NAMES.join("; ")), "failed", "a red member is not masked by an earlier skip");
  assert.equal(resolveTestExecution(output, THREE_NAMES).test, THREE_NAMES[2]);

  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/dispatch.ts",
      line: 412,
      fact: "the generation is compared before dispatch",
      verification_step: { ran: THREE_NAMES, runner_output: output },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-6" },
  );
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.refusal, /FAILED — a failed check is never resolution evidence/);
  assert.match(check.refusal, /refuses at dispatch, before any container/, "the refusal names the RED member");
  assert.equal(check.coverage, "not_executed");
});

test("FG-657: one ABSENT member refuses the whole step — a passing majority establishes nothing about it", () => {
  const output = [`✔ ${THREE_NAMES[0]} (1.612ms)`, `✔ ${THREE_NAMES[2]} (3.104ms)`, "ℹ pass 2", "ℹ fail 0"].join("\n");
  assert.equal(testExecution(output, THREE_NAMES.join("; ")), "absent");
  assert.equal(resolveTestExecution(output, THREE_NAMES).test, THREE_NAMES[1]);

  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/dispatch.ts",
      line: 412,
      fact: "the generation is compared before dispatch",
      verification_step: { ran: THREE_NAMES.join("; "), runner_output: output },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-6" },
  );
  assert.equal(check.ok, false, "absence is unproven, not passing — for one member as much as for one test");
  if (check.ok) return;
  assert.match(check.refusal, /nowhere at all, so nothing establishes that it ran/);
  assert.match(check.refusal, /doctor's inspection carries the same stale arm/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-657: a multi-name CITED TEST is held to the same rule as a multi-name step", () => {
  const executed = validateResolutionEvidence(
    { kind: "regression_test", test_name: THREE_NAMES.join("; "), runner_output: THREE_GREEN },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-7" },
  );
  assert.equal(executed.ok, true, executed.ok ? "" : executed.refusal);

  const oneRed = validateResolutionEvidence(
    {
      kind: "regression_test",
      test_name: THREE_NAMES.join("; "),
      runner_output: THREE_GREEN.replace(`✔ ${THREE_NAMES[0]}`, `✖ ${THREE_NAMES[0]}`),
    },
    { candidateSha: SHA, reachability: "demonstrated", findingRef: "RF-7" },
  );
  assert.equal(oneRed.ok, false);
  if (oneRed.ok) return;
  assert.match(oneRed.refusal, /a manifest-consistent generation BEHIND the executing release refuses as stale FAILED/);
  assert.equal(oneRed.coverage, "not_executed");
});

test("FG-657: an EMPTY list of names is absent, not vacuously executed", () => {
  assert.equal(testExecution(THREE_GREEN, " ; ; "), "absent", "a separator-only identity names no test at all");

  const check = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/dispatch.ts",
      line: 412,
      fact: "the generation is compared before dispatch",
      verification_step: { ran: ";", runner_output: THREE_GREEN },
    },
    { candidateSha: SHA, reachability: "supported", findingRef: "RF-8" },
  );
  assert.equal(check.ok, false, "naming nothing must not pass the gate a green suite cannot pass");
  assert.match(check.ok ? "" : check.refusal, /nowhere at all/);
});

// ─── FG-657, the ENFORCEMENT half: what a list of names must not let through ─
//
// The list rule exists to stop a complete, passing, multi-test citation reading as ABSENT.
// The danger in that fix is the opposite direction: a split that widens identity, or a
// green majority that carries a member nothing ran. Everything below is that direction —
// each test names a way the gate could have got cheaper, and asserts it did not. Coverage
// is asserted alongside every refusal, because a refusal that forgets to record
// `not_executed` is the finding quietly leaving the ledger.

const PAIR = ["the reconcile path guards a partial write", "the reconcile path retries once"] as const;
const PAIR_GREEN = [`✔ ${PAIR[0]} (1.2ms)`, `✔ ${PAIR[1]} (0.4ms)`, "ℹ pass 2", "ℹ fail 0"].join("\n");

function citedTest(over: Record<string, unknown>) {
  return { kind: "regression_test", runner_output: PAIR_GREEN, ...over };
}

function demonstrated(findingRef = "RF-9") {
  return { candidateSha: SHA, reachability: "demonstrated" as const, findingRef };
}

test("FG-657: a name that is a strict SUBSTRING of a real test does not match it — splitting never widens identity", () => {
  assert.equal(testExecution(PAIR_GREEN, "the reconcile path guards"), "absent", "a prefix is not the test");
  assert.equal(testExecution(PAIR_GREEN, "guards a partial write"), "absent", "a suffix is not the test");
  assert.equal(testExecution(PAIR_GREEN, "reconcile"), "absent", "a bare word is not the test");
  assert.equal(
    testExecution(PAIR_GREEN, `${PAIR[0]}; guards a partial write`),
    "absent",
    "a fragment the split itself produced must not match the whole it came from",
  );
  assert.equal(testExecution(PAIR_GREEN, ["retries once"]), "absent", "and the array form widens no further");
});

test("FG-657: one ABSENT member refuses a cited regression test — a passing majority proves nothing about the missing one", () => {
  const check = validateResolutionEvidence(
    citedTest({ test_name: `${PAIR[0]}; a test nobody wrote` }),
    demonstrated(),
  );
  assert.equal(check.ok, false, "one member nothing ran is the whole claim unproven");
  if (check.ok) return;
  assert.match(check.refusal, /a test nobody wrote does not appear in the cited runner output at all/);
  assert.doesNotMatch(check.refusal, /guards a partial write does not appear/, "the refusal names the MISSING member");
  assert.equal(check.coverage, "not_executed", "recorded not_executed, never silently dropped");
});

test("FG-657: one SKIPPED member refuses a cited regression test, and coverage is recorded not_executed", () => {
  const check = validateResolutionEvidence(
    citedTest({
      test_name: PAIR.join("; "),
      runner_output: [`✔ ${PAIR[0]} (1.2ms)`, `﹣ ${PAIR[1]} (0ms) # SKIP no agent image`, "ℹ pass 1", "ℹ fail 0"].join("\n"),
    }),
    demonstrated(),
  );
  assert.equal(check.ok, false, "a green suite around one skipped member is still a skip");
  if (check.ok) return;
  assert.match(check.refusal, /the reconcile path retries once SKIPPED in the cited runner output/);
  assert.equal(check.coverage, "not_executed");
});

test("FG-657: FAILURE dominates the list whatever ORDER the members are named in, and a skipped sibling never masks it", () => {
  const redFirst = [`✖ ${PAIR[0]} (1.2ms)`, `﹣ ${PAIR[1]} (0ms) # SKIP`].join("\n");
  const redLast = [`﹣ ${PAIR[0]} (0ms) # SKIP`, `✖ ${PAIR[1]} (1.2ms)`].join("\n");
  assert.equal(testExecution(redFirst, PAIR.join("; ")), "failed");
  assert.equal(testExecution(redLast, PAIR.join("; ")), "failed");
  assert.equal(resolveTestExecution(redFirst, PAIR).test, PAIR[0]);
  assert.equal(resolveTestExecution(redLast, PAIR).test, PAIR[1], "the refusal follows the RED member, not the position");

  // A member that skipped in one variant and ran in another is EXECUTED on its own; that
  // must not soften a red sibling into a skip, which is the one downgrade an alternate
  // lane could legitimately fill.
  const paramPlusRed = [`﹣ ${PAIR[0]} (0ms) # SKIP`, `✔ ${PAIR[0]} (1.2ms)`, `✖ ${PAIR[1]} (0.4ms)`].join("\n");
  assert.equal(testExecution(paramPlusRed, PAIR), "failed");

  const check = validateResolutionEvidence(citedTest({ test_name: PAIR.join("; "), runner_output: redFirst }), demonstrated());
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.refusal, /the reconcile path guards a partial write FAILED in the cited runner output/);
  assert.equal(check.coverage, "not_executed", "a red member is not_executed coverage, not blocked_environment");
});

test("FG-657: a separator-only identity is refused at the CITED TEST surface too, not vacuously executed", () => {
  for (const empty of [" ; ; ", ";", " ;"]) {
    const check = validateResolutionEvidence(citedTest({ test_name: empty }), demonstrated());
    assert.equal(check.ok, false, `naming no test at all must not pass: ${JSON.stringify(empty)}`);
    assert.equal(check.ok ? "" : check.coverage, "not_executed");
    assert.match(check.ok ? "" : check.refusal, /does not appear in the cited runner output at all/);
  }
});

test("FG-657: an empty or blank ARRAY of names is refused by the schema, before any matching runs", () => {
  const anchored = (ran: unknown) => ({
    kind: "anchored_verification",
    file: "src/v2/reconcile.ts",
    line: 88,
    fact: "the partial write is guarded first",
    verification_step: { ran, runner_output: PAIR_GREEN },
  });
  for (const ran of [[], ["  "], ["", PAIR[0]]]) {
    const check = validateResolutionEvidence(anchored(ran), { candidateSha: SHA, reachability: "supported", findingRef: "RF-10" });
    assert.equal(check.ok, false, `an empty member list must not be vacuously executed: ${JSON.stringify(ran)}`);
    assert.match(check.ok ? "" : check.refusal, /resolution evidence did not validate: verification_step\.ran/);
    assert.equal(check.ok ? "" : check.coverage, "not_executed");
  }
});

test("FG-657: an ARRAY member is taken literally — the honest form is not re-split on its own text", () => {
  const output = "✔ a guard; and its sibling (1ms)";
  assert.equal(testExecution(output, ["a guard; and its sibling"]), "executed", "the array removes the delimiter guess");
  assert.equal(
    testExecution(output, "a guard; and its sibling"),
    "absent",
    "the string form splits, so a name that genuinely contains the separator refuses — narrower, never wider",
  );
});

test("FG-657: the runner shapes are unchanged inside a list — TAP, glyph, suite-qualified and stripped timing all still match", () => {
  const mixed = [
    "TAP version 13",
    "ok 1 - reviews > the reconcile path guards a partial write",
    "✔ the reconcile path retries once (12.75ms)",
    "ok 3 - a third assertion # SKIP",
    "1..3",
  ].join("\n");
  assert.equal(testExecution(mixed, PAIR.join("; ")), "executed", "one TAP member and one glyph member, both executed");
  assert.equal(testExecution(mixed, [...PAIR, "a third assertion"]), "skipped", "and the skipped third still refuses");
  assert.equal(resolveTestExecution(mixed, [...PAIR, "a third assertion"]).test, "a third assertion");
});

test("FG-657: reachability is untouched — a fully GREEN multi-name step still cannot close a demonstrated finding", () => {
  const anchored = validateResolutionEvidence(
    {
      kind: "anchored_verification",
      file: "src/v2/reconcile.ts",
      line: 88,
      fact: "the partial write is guarded first",
      verification_step: { ran: PAIR, runner_output: PAIR_GREEN },
    },
    demonstrated("RF-11"),
  );
  assert.equal(anchored.ok, false, "naming more tests does not make anchored verification proportional");
  if (anchored.ok) return;
  assert.match(anchored.refusal, /requires regression_test or replayed_reproduction/);
  assert.match(anchored.refusal, /never closed by model re-inspection/);
  assert.equal(anchored.coverage, "not_executed");

  const inspected = validateResolutionEvidence(
    { kind: "bounded_inspection", inspection: "read every caller of the guard", limitation: "no runner was available" },
    demonstrated("RF-11"),
  );
  assert.equal(inspected.ok, false, "model re-inspection closes a demonstrated finding in no shape at all");
});

test("FG-657: an ALTERNATE LANE's own multi-name assertion is held to exactly the same rule", () => {
  const check = validateResolutionEvidence(
    citedTest({
      test_name: PAIR[0],
      runner_output: `﹣ ${PAIR[0]} (0ms) # SKIP no agent image`,
      alternate_lane: {
        lane: "ci",
        candidate_sha: SHA,
        executed_assertion: PAIR.join("; "),
        runner_output: [`ok 1 - ${PAIR[0]}`, `ok 2 - ${PAIR[1]} # SKIP`].join("\n"),
      },
    }),
    demonstrated("RF-12"),
  );
  assert.equal(check.ok, false, "a lane that skipped one of the assertions it names has not executed them");
  if (check.ok) return;
  assert.match(check.refusal, /Alternate lane 'ci' cites 'the reconcile path retries once', but its own output shows that assertion skipped/);
  assert.equal(check.coverage, "not_executed");
});

// PINS TODAY'S BEHAVIOR — NOT AN ENDORSEMENT. `checkAlternateLane` never required the
// lane's `executed_assertion` to correspond to the member that skipped here; that is the
// FG-639 lane design, unchanged by FG-657, and it is why the paragraph below reads the way
// it does rather than asserting a correspondence the code does not check. Recorded so the
// looseness is visible in the suite instead of being rediscovered as a surprise.
test("FG-657: a lane rescue is checked for EXECUTION, not for per-member correspondence (pins today's behavior)", () => {
  const check = validateResolutionEvidence(
    citedTest({
      test_name: PAIR.join("; "),
      runner_output: [`✔ ${PAIR[0]} (1.2ms)`, `﹣ ${PAIR[1]} (0ms) # SKIP no agent image`].join("\n"),
      alternate_lane: {
        lane: "ci",
        candidate_sha: SHA,
        executed_assertion: PAIR[1],
        runner_output: `ok 1 - ${PAIR[1]}`,
      },
    }),
    demonstrated("RF-13"),
  );
  assert.equal(check.ok, true, check.ok ? "" : check.refusal);
  assert.equal(check.ok ? check.detail : "", `${PAIR[1]} skipped here, but mandatory lane 'ci' executed '${PAIR[1]}' against ${SHA}`);
  assert.match(check.ok ? check.detail : "", /skipped here, but mandatory lane/, "the detail states the gap it is standing in for");
});

// PINS TODAY'S BEHAVIOR — THE KNOWN FG-658 GAP, filed separately with its own acceptance
// criteria. A cited name annotated with its source file does not match output whose
// captured name is bare, so an otherwise complete citation refuses as ABSENT. That is a
// FALSE NEGATIVE, not a hole: it refuses evidence, it never accepts any. This test is here
// to fail loudly when FG-658 lands, not to describe what the gate should do.
test("FG-658 (KNOWN GAP, pinned not endorsed): a member annotated with its source file does not match a bare captured name", () => {
  assert.equal(
    testExecution(PAIR_GREEN, `${PAIR[0]} (src/v2/reconcile.test.ts)`),
    "absent",
    "today the file annotation is part of the identity; FG-658 owns making it not be",
  );
  assert.equal(resolveTestExecution(PAIR_GREEN, [PAIR[0], `${PAIR[1]} (src/v2/reconcile.test.ts)`]).execution, "absent");

  const check = validateResolutionEvidence(
    citedTest({ test_name: `${PAIR[0]}; ${PAIR[1]} (src/v2/reconcile.test.ts)` }),
    demonstrated("RF-14"),
  );
  assert.equal(check.ok, false, "refusing complete evidence is the FG-658 defect — it errs closed, so the gate is not widened");
  assert.equal(check.ok ? "" : check.coverage, "not_executed");
});

// The ticket's prose says a cited regression test's name may arrive as an array OR as the
// joined string; only the STEP's `ran` accepts both. `test_name` is still string-only, so
// the array form is refused at the schema. Recorded because the asymmetry is deliberate to
// verify, not to guess at: refusing a shape errs closed, so it is a completeness gap in the
// change, never a way past the gate.
test("FG-657: an ARRAY test_name on a cited regression test is refused at the schema (string-only, unlike a step's `ran`)", () => {
  const check = validateResolutionEvidence(citedTest({ test_name: PAIR }), demonstrated("RF-15"));
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.refusal, /resolution evidence did not validate: test_name/);
  assert.equal(check.ok ? "" : check.coverage, "not_executed");
});
