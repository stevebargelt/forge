// FG-566 — review-loop-path falsification suite (falsification 6) plus the
// engine half of the shared observable contract.
//
// THE DEFECT THIS FILE FALSIFIES. A Forge-owned host-side verification runs in a
// freshly-created workspace that has no dependencies installed, and the resulting
// failure is reported as if the reviewed CODE were broken. On the review-loop
// path (live instance run-review-loop-fg-356-34ce60) `npm run typecheck` and
// `npm run test` failed only because the binaries were not installed;
// runReviewLoop converted both failures into fixer findings, so round 1
// dispatched the FIXER against a failure no code change could fix, round 2
// re-verified, and the loop stopped `verification_failed` having burned two
// rounds and invited an agent to "fix" passing code.
//
// ── THE CONTRACT THIS FILE PINS ─────────────────────────────────────────────
// This file imports NO symbol introduced by the readiness build step and compares
// every new-vocabulary value through String(...), so it typechecks against the
// pre-readiness tree as well as the post-readiness one. It therefore names the
// contract structurally rather than importing it:
//
//   1. deps.verify() may report a DISTINCT THIRD state — an environment that
//      could not be made runnable, carrying the readiness contract's own
//      classification (`reason` from the shared vocabulary, plus `workspace`,
//      `command`, `exitStatus`, `stderrTail`, `message`) — rather than a
//      pass/fail verdict on the code. See refusedVerification for why the
//      fixtures encode that state two ways.
//   2. runReviewLoop must return on it BEFORE it consults `ok` / `steps` — an
//      environment fault treated as `ok === false` is precisely the defect,
//      because that path dispatches the fixer.
//   3. That return is a StopReason whose literal token is
//      `verification_environment_unavailable`, with ZERO RoundRecords pushed and
//      NEITHER deps.review NOR deps.fix invoked.
//   4. renderReviewLoopNote renders that token AND the refusal reason.
//
// One fixture deliberately carries the refusal ALONGSIDE the failed `steps` a
// dependency-less local run produced. That is the pre-fix shape, so it is what
// makes the pre-fix RED observation complete — the loop turns those steps into
// findings and dispatches the fixer. Post-fix it is a strictly stronger assertion
// than a bare refusal: it proves the refusal is consulted BEFORE the failed steps
// are, not merely that an empty result stops the loop.
//
// SCOPE. The primitive's own fidelity checks (lockfile digest, interpreter
// resolution, ABI equality via checkAbi) belong to the readiness module and its
// own tests; what this file owns is the LOOP's projection of one classified
// result — which is where the misclassification actually happened.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runReviewLoop, renderReviewLoopNote,
  type ReviewLoopDeps, type ReviewLoopNoteMeta, type VerificationResult, type Finding,
} from "./review-loop.js";

/** The literal operator-facing token. Asserted as a STRING on both surfaces (the
 *  rendered note here, CLI stdout in the integration half) so this file never
 *  references a StopReason union member that does not exist in the current tree. */
const READINESS_TOKEN = "verification_environment_unavailable";

/** The refusal vocabulary. Every member must project onto the same terminal
 *  state — a refusal is a refusal regardless of which fidelity check produced it. */
const REFUSAL_REASONS = [
  "no_setup_contract",
  "ambiguous_setup_contract",
  "runtime_unresolved",
  "runtime_abi_mismatch",
  "setup_failed",
  "setup_timed_out",
  "setup_contended",
  "workspace_dirtied_by_setup",
] as const;

/** Construct a verification outcome structurally — including the environment-
 *  unavailable arm and the step-level `command`/`tier` provenance, neither of
 *  which the pre-readiness types declare. The cast is what lets this file
 *  typecheck against BOTH trees while importing no new symbol; it is never used
 *  to assert anything about the declared types. */
function verification(v: Record<string, unknown>): VerificationResult {
  return v as unknown as VerificationResult;
}

/** The failed step a dependency-less local run actually produces: the binary is
 *  not installed, so the step dies before it can examine the implementation.
 *  `command`/`tier` are the step-level provenance the round-entry finding must
 *  report; the marker sits on a LATER line so today's
 *  `summary.split("\n")[0]` truncation drops it. */
function depsMissingStep(): Record<string, unknown> {
  return {
    name: "typecheck",
    ok: false,
    output: [
      "npm error Missing script or binary",
      "node:internal/modules/package_json_reader:301",
      "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' FG566-STDERR-TAIL-MARKER",
    ].join("\n"),
    command: "npm run --silent typecheck",
    tier: "fast",
  };
}

/** A readiness REFUSAL travelling up from the workspace preflight: nothing ever
 *  ran, so there are no steps to report.
 *
 *  DUAL-ENCODED ON PURPOSE. The refusal is presented BOTH as a `readiness` field
 *  carrying the shared vocabulary AND as a `kind: "environment_unavailable"`
 *  discriminant. Both are faithful renderings of the same fact, and encoding both
 *  keeps these tests pinned to the loop's BEHAVIOUR — zero rounds, neither agent
 *  dispatched, the token on every surface — rather than to whichever of the two
 *  the production discriminant happens to read. What is asserted below is never
 *  the encoding; it is always what the loop DOES with a refusal. */
function refusedVerification(reason: string): VerificationResult {
  const refusal = {
    reason,
    workspace: "/tmp/forge-fg566-clone",
    command: "npm ci",
    exitStatus: 1,
    stderrTail: "npm error code EUSAGE FG566-STDERR-TAIL-MARKER",
    message: `verification_environment_unavailable: review-loop could not establish an execution-ready verification environment (${reason}).`,
  };
  return verification({
    kind: "environment_unavailable",
    ...refusal,
    ok: false,
    steps: [],
    readiness: { outcome: "refused", ...refusal },
  });
}

/** The same refusal, but also carrying the failed `steps` a pre-fix local run
 *  produced. Proves the refusal is consulted BEFORE `ok`/`steps` — a loop that
 *  reads `ok` first turns those steps into findings and dispatches the fixer,
 *  which is the defect itself. */
function refusedVerificationWithFailedSteps(reason: string): VerificationResult {
  return verification({
    ...(refusedVerification(reason) as unknown as Record<string, unknown>),
    steps: [depsMissingStep()],
  });
}

/** Readiness established successfully — the workspace is execution-ready, so the
 *  loop must behave exactly as it always has from here on. */
function preparedVerification(over: Record<string, unknown> = {}): VerificationResult {
  return verification({
    ok: true,
    steps: [{ name: "typecheck", ok: true, output: "", command: "npm run --silent typecheck", tier: "fast" }],
    readiness: { outcome: "prepared", workspace: "/tmp/forge-fg566-clone" },
    ...over,
  });
}

type Spy = { deps: ReviewLoopDeps; reviewed: () => number; fixed: () => number; findingsSeen: () => Finding[] };

function spyDeps(over: Partial<ReviewLoopDeps>): Spy {
  let reviewed = 0;
  let fixed = 0;
  let findingsSeen: Finding[] = [];
  const deps: ReviewLoopDeps = {
    verify: () => preparedVerification(),
    review: () => { reviewed++; return { ok: true, verdict: "pass", findings: [] }; },
    fix: (f) => { fixed++; findingsSeen = f; return { ok: true, committedSha: "fixsha" }; },
    ...over,
  };
  return { deps, reviewed: () => reviewed, fixed: () => fixed, findingsSeen: () => findingsSeen };
}

const NOTE_META: ReviewLoopNoteMeta = {
  ticketId: "FG-566",
  maxRounds: 2,
  range: { mode: "since", diffRange: "base..HEAD", shas: ["abc1234"], spansUnmatched: false },
  reviewedTipSha: "abc1234",
  remoteTrust: { kind: "trusted", remoteRef: "origin/main" },
};

// ── Falsification 6: a forced preparation failure stops before round 1 ───────
//
// RED pre-fix: the loop sees ok === false, builds a fixer finding out of the
// failed step, dispatches deps.fix, and records a RoundRecord — one review round
// consumed against a failure no code change could fix.

test("FG-566 falsification 6 — a readiness REFUSAL stops the loop BEFORE round 1: zero RoundRecords, no reviewer, no fixer", async () => {
  const spy = spyDeps({ verify: () => refusedVerificationWithFailedSteps("setup_failed") });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);

  assert.equal(outcome.rounds.length, 0, "a preparation failure consumes ZERO review rounds — no RoundRecord may be pushed");
  assert.equal(spy.reviewed(), 0, "the reviewer must NOT be dispatched for an environment fault");
  assert.equal(spy.fixed(), 0, "the fixer must NOT be dispatched for an environment fault — this is the round the live instance burned");
  assert.equal(outcome.closeable, false);
});

test("FG-566 falsification 6 — the refusal's stop reason is the distinct readiness terminal state, never verification_failed", async () => {
  const spy = spyDeps({ verify: () => refusedVerificationWithFailedSteps("setup_failed") });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);

  assert.equal(
    String(outcome.stopReason), READINESS_TOKEN,
    "an environment fault must be its own terminal state, not a verdict on the reviewed code",
  );
  assert.notEqual(
    String(outcome.stopReason), "verification_failed",
    "verification_failed is a CODE verdict — reporting an unrunnable environment as one is the defect FG-566 exists to eliminate",
  );
});

test("FG-566 falsification 6 — readiness is consulted BEFORE verification: a refusal with NO steps at all stops identically", async () => {
  // The production shape: readiness refuses, so verification never ran and there
  // are no steps to report.
  const spy = spyDeps({ verify: () => refusedVerification("no_setup_contract") });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);

  assert.equal(String(outcome.stopReason), READINESS_TOKEN);
  assert.equal(outcome.rounds.length, 0);
  assert.equal(spy.reviewed(), 0);
  assert.equal(spy.fixed(), 0);
});

test("FG-566 falsification 6 — an incompatible Node ABI is refused, never accepted as ready", async () => {
  // The loop's half of the ABI invariant: a workspace whose installed native
  // bindings do not match the intended verification runtime is NOT ready, and the
  // loop must stop on it rather than run (and mis-blame) the reviewed code. The
  // ABI equality check itself is the readiness primitive's own concern.
  const spy = spyDeps({ verify: () => refusedVerification("runtime_abi_mismatch") });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);

  assert.equal(String(outcome.stopReason), READINESS_TOKEN, "an ABI mismatch must refuse, not proceed as if the workspace were ready");
  assert.equal(outcome.rounds.length, 0);
  assert.equal(spy.reviewed(), 0);
  assert.equal(spy.fixed(), 0);
});

test("FG-566 — EVERY refusal reason in the vocabulary lands on the same terminal state with zero rounds", async () => {
  for (const reason of REFUSAL_REASONS) {
    const spy = spyDeps({ verify: () => refusedVerification(reason) });
    const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);
    assert.equal(String(outcome.stopReason), READINESS_TOKEN, `reason '${reason}' must project onto the readiness terminal state`);
    assert.equal(outcome.rounds.length, 0, `reason '${reason}' must consume zero rounds`);
    assert.equal(spy.reviewed() + spy.fixed(), 0, `reason '${reason}' must dispatch neither reviewer nor fixer`);
  }
});

// ── The observable contract: the rendered note ──────────────────────────────

test("FG-566 observable contract — the rendered loop note carries the literal token verification_environment_unavailable", async () => {
  const spy = spyDeps({ verify: () => refusedVerificationWithFailedSteps("setup_failed") });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);
  const note = renderReviewLoopNote(NOTE_META, outcome);

  assert.ok(
    note.includes(READINESS_TOKEN),
    `the durable note must name the environment outcome verbatim so an operator can tell it from a code failure. Note was:\n${note}`,
  );
  assert.ok(
    !note.includes("verification_failed"),
    `no verification ever ran, so the note must not carry the CODE verdict anywhere. Note was:\n${note}`,
  );
});

test("FG-566 observable contract — the rendered loop note NAMES the refusal reason", async () => {
  const spy = spyDeps({ verify: () => refusedVerification("workspace_dirtied_by_setup") });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);
  const note = renderReviewLoopNote(NOTE_META, outcome);

  assert.ok(
    note.includes("workspace_dirtied_by_setup"),
    `the note must name WHICH readiness check refused — 'diagnosis took a manual ls node_modules' is the failure mode being removed. Note was:\n${note}`,
  );
});

test("FG-566 observable contract — a refused note reports no rounds, consistent with the zero rounds consumed", async () => {
  const spy = spyDeps({ verify: () => refusedVerification("runtime_unresolved") });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);
  const note = renderReviewLoopNote(NOTE_META, outcome);

  assert.ok(!note.includes("## Round 1"), "no round was consumed, so the note must not present one");
});

// ── The inverse defect: preparation success must change NOTHING downstream ──
//
// This is the more dangerous direction and the reason readiness is a
// PRECONDITION rather than a post-hoc reinterpretation of verification output: a
// real code failure must never be laundered into an infrastructure outcome.
// These are non-regression guards, green both pre- and post-fix by construction.

test("FG-566 INVERSE DEFECT — a genuine verification failure AFTER a successful preparation retains existing behavior: fixer dispatched, round consumed", async () => {
  const spy = spyDeps({
    verify: () => verification({
      ok: false,
      steps: [{ name: "test", ok: false, output: "1) expected 2 to equal 3", command: "npm run --silent test", tier: "fast" }],
    }),
  });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);

  assert.notEqual(
    String(outcome.stopReason), READINESS_TOKEN,
    "a real test failure after a successful preparation must NEVER be laundered into an environment outcome",
  );
  assert.equal(String(outcome.stopReason), "verification_failed");
  assert.ok(outcome.rounds.length > 0, "a real failure still consumes rounds — unchanged behavior");
  assert.ok(spy.fixed() > 0, "a real failure still reaches the fixer — unchanged behavior");
});

test("FG-566 falsification 6 — a successful preparation does NOT stop the loop: readiness 'prepared' reaches round 1 and dispatches the reviewer", async () => {
  const spy = spyDeps({ verify: () => preparedVerification() });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);

  assert.equal(String(outcome.stopReason), "passed");
  assert.equal(outcome.rounds.length, 1, "preparation is not a review round — round 1 is still round 1");
  assert.equal(spy.reviewed(), 1, "a prepared workspace reaches the reviewer");
});

test("FG-566 falsification 6 — trusted covering CI evidence: a reused verification is never turned into a readiness stop", async () => {
  // CI reuse stays first-class: covering evidence returns from the CLI's
  // verifyWithReuse BEFORE any local provisioning, so the engine only ever sees an
  // ordinary reused result and proceeds normally. Guards against a fix that makes
  // readiness an unconditional precondition. (The CLI half — that no provisioning
  // is even ATTEMPTED — is asserted in the integration file.)
  const spy = spyDeps({
    verify: () => verification({
      ok: true,
      steps: [{ name: "reused", ok: true, output: "green CI check at abc1234" }],
      reusedEvidence: "green CI check at abc1234",
    }),
  });
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-566" }, spy.deps);
  assert.equal(String(outcome.stopReason), "passed", "reused CI evidence must reach the reviewer, never a readiness stop");
  assert.equal(spy.reviewed(), 1);
});

// ── The round-entry finding-detail defect ───────────────────────────────────
//
// FG-625 owns the POST-FIXER path; this is the ROUND-ENTRY verifier, so fixing
// FG-625 alone would not have surfaced it. Both live rounds reported literally
// `deterministic verification step 'typecheck' failed:` with nothing after the
// colon — no command, no tier, no stderr — because verificationFindings puts the
// output on line 2+ and renderReviewLoopNote truncates to summary.split("\n")[0].

test("FG-566 round-entry finding detail — a failed verification step's rendered finding names the COMMAND that ran", async () => {
  const spy = spyDeps({
    verify: () => verification({ ok: false, steps: [depsMissingStep()] }),
  });
  const outcome = await runReviewLoop({ maxRounds: 1, ticketId: "FG-566" }, spy.deps);
  const note = renderReviewLoopNote(NOTE_META, outcome);

  assert.match(
    note, /npm run [^\n]*typecheck/,
    `the finding must name the command actually run, not just the step name. Note was:\n${note}`,
  );
});

test("FG-566 round-entry finding detail — the rendered finding names the TIER", async () => {
  const spy = spyDeps({
    verify: () => verification({ ok: false, steps: [depsMissingStep()] }),
  });
  const outcome = await runReviewLoop({ maxRounds: 1, ticketId: "FG-566" }, spy.deps);
  const note = renderReviewLoopNote(NOTE_META, outcome);

  assert.match(note, /\bfast\b/, `the finding must name the verification tier. Note was:\n${note}`);
});

test("FG-566 round-entry finding detail — the rendered finding carries a STDERR TAIL, not a bare colon", async () => {
  const spy = spyDeps({
    verify: () => verification({ ok: false, steps: [depsMissingStep()] }),
  });
  const outcome = await runReviewLoop({ maxRounds: 1, ticketId: "FG-566" }, spy.deps);
  const note = renderReviewLoopNote(NOTE_META, outcome);

  assert.ok(
    note.includes("FG566-STDERR-TAIL-MARKER"),
    `the step's stderr tail is the whole diagnosis — today it is truncated away by summary.split("\\n")[0], which cost a manual 'ls node_modules'. Note was:\n${note}`,
  );
});

// ── FG-625 Defect B: the POST-FIXER readiness preflight (engine projection) ──
//
// The round-entry env-unavailable disposition above is driven by deps.verify()
// returning a refusal. FG-625 owns the SIBLING path: the post-fixer, pre-commit
// verification inside fix(). A refusal there travels up as a DISTINCT FixDispatch
// shape (environmentUnavailable + the classified readiness), and the loop must map
// it to the SAME terminal state — never verification_failed, never a consumed
// round — so an unprepared workspace on the CI-reuse path is never reported as a
// code failure. These pin the engine's projection of that FixDispatch shape; the
// CLI integration half drives a real npm-ci refusal through fix() itself.
//
// Constructed structurally (VerificationResult["readiness"] cast) so this file
// still imports NO symbol introduced by the readiness build step.
const REFUSED_READINESS = (reason: string): VerificationResult["readiness"] => ({
  outcome: "refused",
  reason,
  workspace: "/tmp/forge-fg625-clone",
  command: "npm ci",
  exitStatus: 1,
  stderrTail: "npm error code EUSAGE FG625-POST-FIXER-TAIL",
  message: `verification_environment_unavailable: the post-fixer verification could not be prepared (${reason}).`,
}) as unknown as VerificationResult["readiness"];

test("FG-625 Defect B — a post-fixer env-unavailable FixDispatch maps to verification_environment_unavailable with ZERO rounds pushed, never verification_failed", async () => {
  let fixed = 0;
  const deps: ReviewLoopDeps = {
    verify: () => preparedVerification(),
    review: () => ({ ok: true, verdict: "needs_fix", findings: [{ summary: "harden the retry path", file: "src.ts", line: 1 }] }),
    fix: () => { fixed++; return { ok: false, environmentUnavailable: true, readiness: REFUSED_READINESS("setup_failed") }; },
  };
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-625" }, deps);

  assert.equal(
    String(outcome.stopReason), READINESS_TOKEN,
    "an unprepared post-fixer workspace is an environment fault, not a verdict on the reviewed code",
  );
  assert.notEqual(
    String(outcome.stopReason), "verification_failed",
    "the whole point of Defect B: the post-fixer path must never launder an environment fault into a code failure",
  );
  assert.equal(outcome.rounds.length, 0, "a post-fixer environment fault consumes ZERO review rounds — no RoundRecord may be pushed");
  assert.equal(fixed, 1, "the fixer WAS dispatched — its post-fixer readiness preflight is what refused");
  assert.equal(outcome.closeable, false);
  assert.ok(outcome.environment, "the classified refusal is carried on outcome.environment, exactly like the round-entry disposition");
  assert.equal(String(outcome.environment?.outcome), "refused");
  assert.equal(String(outcome.environment?.reason), "setup_failed");
});

test("FG-625 Defect B — a post-fixer env-unavailable on the verification-FAILED short-circuit path ALSO maps to the env terminal state", async () => {
  // Round-entry verification FAILS (a real code failure, readiness prepared — NOT a
  // refusal), so the reviewer is short-circuited and the failure goes straight to
  // the fixer. The fixer's own post-fixer preflight then refuses. Both fix()
  // dispatch sites must honour the distinct shape.
  const deps: ReviewLoopDeps = {
    verify: () => verification({ ok: false, steps: [depsMissingStep()], readiness: { outcome: "prepared", workspace: "/tmp/w" } }),
    review: () => { throw new Error("the reviewer must be short-circuited when round-entry verification fails"); },
    fix: () => ({ ok: false, environmentUnavailable: true, readiness: REFUSED_READINESS("runtime_abi_mismatch") }),
  };
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-625" }, deps);

  assert.equal(String(outcome.stopReason), READINESS_TOKEN);
  assert.notEqual(String(outcome.stopReason), "verification_failed");
  assert.equal(outcome.rounds.length, 0, "zero rounds pushed on the short-circuit path too");
  assert.equal(String(outcome.environment?.reason), "runtime_abi_mismatch");
});

test("FG-625 Defect B — a genuine post-fixer CODE failure still stops verification_failed WITH the full step evidence, never the env state", async () => {
  // The inverse guard, and the more dangerous direction: a real post-fixer code
  // failure must retain the step-1 evidence behaviour and must NOT be laundered
  // into an environment outcome just because a readiness preflight now runs first.
  const failedPostFixer = verification({
    ok: false,
    steps: [depsMissingStep()],
    readiness: { outcome: "reused", workspace: "/tmp/w" },
  });
  const deps: ReviewLoopDeps = {
    verify: () => preparedVerification(),
    review: () => ({ ok: true, verdict: "needs_fix", findings: [{ summary: "harden the retry path", file: "src.ts", line: 1 }] }),
    fix: () => ({ ok: false, verificationFailed: true, dirtyPaths: ["src.ts"], verification: failedPostFixer }),
  };
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-625" }, deps);

  assert.equal(String(outcome.stopReason), "verification_failed", "a real code failure is still a code verdict");
  assert.notEqual(String(outcome.stopReason), READINESS_TOKEN, "readiness 'reused' means the environment was fine — the FAILURE is the code");
  assert.equal(outcome.rounds.length, 1, "a genuine code failure consumes the round — unchanged step-1 behaviour");
  assert.ok(outcome.rounds[0]!.fixVerification, "FG-625 step 1: the post-fixer evidence still survives onto the RoundRecord");

  const note = renderReviewLoopNote(NOTE_META, outcome);
  assert.match(note, /post-fixer verification failed steps:/, "the note still enumerates the failed step (step 1)");
  assert.ok(
    note.includes("FG566-STDERR-TAIL-MARKER"),
    `the failed step's output tail still survives into the note — Defect B must not regress step 1. Note was:\n${note}`,
  );
});
