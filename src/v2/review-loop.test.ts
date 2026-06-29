import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCommitRange,
  parseReviewerVerdict,
  runVerification,
  runReviewLoop,
  renderReviewLoopNote,
  type GitRunner,
  type CommandRunner,
  type ReviewLoopDeps,
  type VerificationResult,
  type Finding,
} from "./review-loop.js";

// ── Slice 1: resolveCommitRange ──────────────────────────────────────────────

test("#301 range: --since yields <sha>..HEAD with its shas", async () => {
  const git: GitRunner = (args) => {
    assert.deepEqual(args, ["log", "--format=%H", "abc..HEAD"]);
    return "h2\nh1\n";
  };
  const r = resolveCommitRange("301", { since: "abc", git });
  assert.equal(r.mode, "since");
  assert.equal(r.diffRange, "abc..HEAD");
  assert.deepEqual(r.shas, ["h2", "h1"]);
  assert.equal(r.spansUnmatched, false);
});

test("#301 range: inferred, contiguous → oldest^..newest, spansUnmatched false", async () => {
  const git: GitRunner = (args) => {
    if (args.includes("--grep=#301([^0-9]|$)")) return "hNew\nhMid\nhOld\n"; // 3 matched, newest-first
    if (args[2] === "hOld^..hNew") return "hNew\nhMid\nhOld\n";        // span == matched
    return "";
  };
  const r = resolveCommitRange("#301", { git });
  assert.equal(r.mode, "inferred");
  assert.equal(r.diffRange, "hOld^..hNew");
  assert.deepEqual(r.shas, ["hNew", "hMid", "hOld"]);
  assert.equal(r.spansUnmatched, false);
});

test("#301 range: inferred span containing unrelated commits → spansUnmatched true; shas stays precise", async () => {
  const git: GitRunner = (args) => {
    if (args.includes("--grep=#777([^0-9]|$)")) return "hNew\nhOld\n";        // 2 matched
    if (args[2] === "hOld^..hNew") return "hNew\nhUnrelated\nhOld\n";  // span has a 3rd, non-ticket commit
    return "";
  };
  const r = resolveCommitRange("777", { git });
  assert.equal(r.spansUnmatched, true, "caller must diff the precise shas, not the span");
  assert.deepEqual(r.shas, ["hNew", "hOld"]);
});

test("#301 range: no --since and no matching commits → mode none", async () => {
  const r = resolveCommitRange("999", { git: () => "\n  \n" });
  assert.deepEqual(r, { mode: "none", diffRange: "", shas: [], spansUnmatched: false });
});

// ── Slice 2: parseReviewerVerdict ────────────────────────────────────────────

test("#301 verdict: valid pass with no findings", async () => {
  const r = parseReviewerVerdict({ verdict: "pass" });
  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "pass");
});

test("#301 verdict: needs_fix with a fully anchored finding (file AND line)", async () => {
  const r = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "off-by-one", file: "src/x.ts", line: 42 }] });
  assert.equal(r.ok, true);
  assert.equal((r as { findings: Finding[] }).findings[0]!.line, 42);
});

test("#301 verdict: a file with no line is rejected (anchored needs both)", async () => {
  const r = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "somewhere in x", file: "src/x.ts" }] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /both `file` and `line`.*or.*unanchored/);
});

test("#301 verdict: explicitly unanchored finding is accepted", async () => {
  const r = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "broad concern", unanchored: true }] });
  assert.equal(r.ok, true);
});

test("#301 verdict: needs_fix with no findings is rejected", async () => {
  const r = parseReviewerVerdict({ verdict: "needs_fix", findings: [] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /needs_fix requires at least one finding/);
});

test("#301 verdict: unknown verdict value is rejected (never treated as pass)", async () => {
  assert.equal(parseReviewerVerdict({ verdict: "lgtm" }).ok, false);
  assert.equal(parseReviewerVerdict("not json shaped").ok, false);
});

// ── Slice 3: runVerification ─────────────────────────────────────────────────

test("#301 verify: runs typecheck then test when both scripts exist; ok when all pass", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, output: "ok" }; };
  const r = runVerification({ typecheck: "tsc --noEmit", test: "node --test" }, { run });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.name), ["typecheck", "test"]);
  assert.deepEqual(calls, [["npm", "run", "--silent", "typecheck"], ["npm", "run", "--silent", "test"]]);
});

test("#301 verify: any failing step → ok false", async () => {
  const run: CommandRunner = (_cmd, args) => ({ ok: !args.includes("test"), output: args.includes("test") ? "1 failing" : "ok" });
  const r = runVerification({ typecheck: "x", test: "y" }, { run });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === "test")!.ok, false);
});

test("#301 verify: no discoverable scripts → ok false, no steps", async () => {
  const r = runVerification({ build: "x" }, { run: () => ({ ok: true, output: "" }) });
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 0);
});

// ── Slice 4: runReviewLoop ───────────────────────────────────────────────────

const VERIFY_OK: VerificationResult = { ok: true, steps: [{ name: "test", ok: true, output: "" }] };
const VERIFY_BAD: VerificationResult = { ok: false, steps: [{ name: "test", ok: false, output: "1 failing" }] };
const ANCHORED: Finding[] = [{ summary: "fix me", file: "a.ts", line: 1 }];

function deps(over: Partial<ReviewLoopDeps>): ReviewLoopDeps {
  return {
    verify: () => VERIFY_OK,
    review: () => ({ ok: true, verdict: "pass", findings: [] }),
    fix: () => ({ ok: true }),
    ...over,
  };
}

test("#301 loop: verification ok + reviewer pass → passed + closeable", async () => {
  const r = await runReviewLoop({}, deps({}));
  assert.equal(r.stopReason, "passed");
  assert.equal(r.closeable, true);
  assert.equal(r.rounds.length, 1);
});

test("#301 loop: failing verification SHORT-CIRCUITS the reviewer", async () => {
  let reviewed = false;
  const r = await runReviewLoop({ maxRounds: 1 }, deps({
    verify: () => VERIFY_BAD,
    review: () => { reviewed = true; return { ok: true, verdict: "pass", findings: [] }; },
  }));
  assert.equal(reviewed, false, "reviewer must NOT run when verification fails");
  assert.equal(r.stopReason, "verification_failed");
  assert.equal(r.closeable, false);
  assert.equal(r.rounds[0]!.verdict, undefined, "no verdict recorded — review was skipped");
});

test("#301 loop: failing verification → fixer gets verification-derived unanchored findings", async () => {
  let given: Finding[] = [];
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    verify: () => VERIFY_BAD,
    fix: (f) => { given = f; return { ok: true }; },
  }));
  assert.equal(r.rounds[0]!.fixAttempted, true);
  assert.equal(given.length, 1);
  assert.equal(given[0]!.unanchored, true);
  assert.match(given[0]!.summary, /verification step 'test' failed/);
  // round 2 also fails verification → verification_failed at max rounds
  assert.equal(r.stopReason, "verification_failed");
});

test("#301 loop: verification recovers after a fix → review runs → passed", async () => {
  let round = 0;
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    verify: () => (++round === 1 ? VERIFY_BAD : VERIFY_OK), // first round red, then green after fix
    review: () => ({ ok: true, verdict: "pass", findings: [] }),
  }));
  assert.equal(r.stopReason, "passed");
  assert.equal(r.closeable, true);
  assert.equal(r.rounds[0]!.verdict, undefined, "round 1 skipped review (verify failed)");
  assert.equal(r.rounds[1]!.verdict, "pass");
});

test("#301 loop: needs_fix → fix → pass on round 2 → passed", async () => {
  let round = 0;
  let fixes = 0;
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    review: () => (++round === 1
      ? { ok: true, verdict: "needs_fix", findings: ANCHORED }
      : { ok: true, verdict: "pass", findings: [] }),
    fix: () => { fixes++; return { ok: true }; },
  }));
  assert.equal(r.stopReason, "passed");
  assert.equal(fixes, 1);
  assert.equal(r.rounds.length, 2);
});

test("#301 loop: still needs_fix at max rounds → needs_fix_max_rounds (no fix on the last round)", async () => {
  let fixes = 0;
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: ANCHORED }),
    fix: () => { fixes++; return { ok: true }; },
  }));
  assert.equal(r.stopReason, "needs_fix_max_rounds");
  assert.equal(r.closeable, false);
  assert.equal(fixes, 1, "fix runs between rounds 1→2 but NOT after the final review");
});

test("#301 loop: blocked verdict → blocked_by_reviewer", async () => {
  const r = await runReviewLoop({}, deps({ review: () => ({ ok: true, verdict: "blocked", findings: [] }) }));
  assert.equal(r.stopReason, "blocked_by_reviewer");
});

test("#301 loop: reviewer dispatch failure → reviewer_failed", async () => {
  const r = await runReviewLoop({}, deps({ review: () => ({ ok: false, error: "unparseable verdict" }) }));
  assert.equal(r.stopReason, "reviewer_failed");
});

test("#301 loop: fixer failure → fixer_failed", async () => {
  const r = await runReviewLoop({ maxRounds: 3 }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: ANCHORED }),
    fix: () => ({ ok: false, error: "engineer crashed" }),
  }));
  assert.equal(r.stopReason, "fixer_failed");
  assert.equal(r.rounds.at(-1)!.fixError, "engineer crashed");
});

test("#301 loop: re-verifies every round", async () => {
  let verifies = 0;
  let round = 0;
  await runReviewLoop({ maxRounds: 2 }, deps({
    verify: () => { verifies++; return VERIFY_OK; },
    review: () => (++round === 1
      ? { ok: true, verdict: "needs_fix", findings: ANCHORED }
      : { ok: true, verdict: "pass", findings: [] }),
  }));
  assert.equal(verifies, 2, "verification runs at the start of each round");
});

test("#301 loop: maxRounds clamps to >= 1", async () => {
  const r = await runReviewLoop({ maxRounds: 0 }, deps({}));
  assert.equal(r.rounds.length, 1, "0 is treated as 1 round, not a no-op");
  assert.equal(r.stopReason, "passed");
});

// ── Slice 5: renderReviewLoopNote ────────────────────────────────────────────

test("#301 note: records stop reason, closeable, range, and per-round detail", () => {
  const note = renderReviewLoopNote(
    { ticketId: "301", route: "implementation_quick", maxRounds: 2, range: { mode: "since", diffRange: "abc..HEAD", shas: ["h1"], spansUnmatched: false } },
    {
      stopReason: "needs_fix_max_rounds",
      closeable: false,
      rounds: [
        { round: 1, verification: { ok: true, steps: [{ name: "test", ok: true, output: "" }] }, verdict: "needs_fix", findings: [{ summary: "off-by-one", file: "a.ts", line: 7 }], fixAttempted: true },
        { round: 2, verification: { ok: true, steps: [{ name: "test", ok: true, output: "" }] }, verdict: "needs_fix", findings: [{ summary: "still off", unanchored: true }], fixAttempted: false },
      ],
    },
  );
  assert.match(note, /ticket #301/);
  assert.match(note, /stop reason:\*\* needs_fix_max_rounds/);
  assert.match(note, /closeable:\*\* no/);
  assert.match(note, /implementation_quick/);
  assert.match(note, /abc\.\.HEAD/);
  assert.match(note, /## Round 1/);
  assert.match(note, /a\.ts:7 off-by-one/);
  assert.match(note, /\[unanchored\] still off/);
  assert.match(note, /fix: applied/);
});

test("#301 note: a skipped review (verification failed) is shown", () => {
  const note = renderReviewLoopNote(
    { ticketId: "301", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    { stopReason: "verification_failed", closeable: false, rounds: [
      { round: 1, verification: { ok: false, steps: [{ name: "typecheck", ok: false, output: "TS error" }] }, findings: [], fixAttempted: false },
    ] },
  );
  assert.match(note, /reviewer: skipped \(verification failed\)/);
  assert.match(note, /typecheck=FAIL/);
});

test("#301 loop: verification ok:false with NO failed steps (no checks) → verification_failed, fixer NOT called", async () => {
  let fixed = false;
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    verify: () => ({ ok: false, steps: [] }), // e.g. no discoverable typecheck/test scripts
    fix: () => { fixed = true; return { ok: true }; },
  }));
  assert.equal(r.stopReason, "verification_failed");
  assert.equal(fixed, false, "no empty fix dispatched when there are no actionable findings");
  assert.equal(r.rounds.length, 1, "stops on round 1 — nothing to fix");
});

// ── FG-415: richer FixDispatch / out-of-scope / per-round commit ─────────────

test("#415 loop: fix outOfScope → fixer_out_of_scope, closeable false, round has outOfScopePaths", async () => {
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: ANCHORED }),
    fix: () => ({ ok: false, outOfScope: true, offendingPaths: ["docs/x.md"] }),
  }));
  assert.equal(r.stopReason, "fixer_out_of_scope");
  assert.equal(r.closeable, false);
  assert.deepEqual(r.rounds.at(-1)!.outOfScopePaths, ["docs/x.md"]);
});

test("#415 loop: fix verificationFailed (verification-failed path) → stopReason verification_failed", async () => {
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    verify: () => VERIFY_BAD,
    fix: () => ({ ok: false, verificationFailed: true, dirtyPaths: ["src/foo.ts"] }),
  }));
  assert.equal(r.stopReason, "verification_failed");
  assert.equal(r.closeable, false);
  assert.deepEqual(r.rounds.at(-1)!.fixDirtyPaths, ["src/foo.ts"]);
});

test("#415 loop: fix verificationFailed (needs_fix path) → stopReason verification_failed", async () => {
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: ANCHORED }),
    fix: () => ({ ok: false, verificationFailed: true, dirtyPaths: ["src/bar.ts"] }),
  }));
  assert.equal(r.stopReason, "verification_failed");
  assert.equal(r.closeable, false);
  assert.deepEqual(r.rounds.at(-1)!.fixDirtyPaths, ["src/bar.ts"]);
});

test("#415 loop: fix { ok:true, committedSha:'abc' } → committedSha recorded on the round", async () => {
  let round = 0;
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    review: () => (++round === 1
      ? { ok: true, verdict: "needs_fix", findings: ANCHORED }
      : { ok: true, verdict: "pass", findings: [] }),
    fix: () => ({ ok: true, committedSha: "abc" }),
  }));
  assert.equal(r.stopReason, "passed");
  assert.equal(r.rounds[0]!.committedSha, "abc");
});

// ── FG-415: renderReviewLoopNote new fields ───────────────────────────────────

test("#415 note: committed sha shown when fix succeeded with committedSha", () => {
  const note = renderReviewLoopNote(
    { ticketId: "415", maxRounds: 2, range: { mode: "since", diffRange: "a..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "passed", closeable: true,
      rounds: [{
        round: 1, verification: VERIFY_OK, verdict: "needs_fix", findings: ANCHORED,
        fixAttempted: true, committedSha: "deadbeef",
      }],
    },
  );
  assert.match(note, /committed: deadbeef/);
});

test("#415 note: fixer out-of-scope paths shown", () => {
  const note = renderReviewLoopNote(
    { ticketId: "415", maxRounds: 2, range: { mode: "since", diffRange: "a..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "fixer_out_of_scope", closeable: false,
      rounds: [{
        round: 1, verification: VERIFY_OK, verdict: "needs_fix", findings: ANCHORED,
        fixAttempted: true, outOfScopePaths: ["docs/concepts.md", "backlog/x.md"],
      }],
    },
  );
  assert.match(note, /fixer out-of-scope paths: docs\/concepts\.md, backlog\/x\.md/);
});

test("#415 note: fix left uncommitted (verification failed) shown with paths", () => {
  const note = renderReviewLoopNote(
    { ticketId: "415", maxRounds: 2, range: { mode: "since", diffRange: "a..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "verification_failed", closeable: false,
      rounds: [{
        round: 1, verification: VERIFY_OK, verdict: "needs_fix", findings: ANCHORED,
        fixAttempted: true, fixDirtyPaths: ["src/foo.ts"],
      }],
    },
  );
  assert.match(note, /fix left uncommitted \(verification failed\): src\/foo\.ts/);
});

test("#415 note: fixer_out_of_scope stop reason in header", () => {
  const note = renderReviewLoopNote(
    { ticketId: "415", maxRounds: 2, range: { mode: "since", diffRange: "a..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "fixer_out_of_scope", closeable: false,
      rounds: [{ round: 1, verification: VERIFY_OK, verdict: "needs_fix", findings: ANCHORED, fixAttempted: true, outOfScopePaths: ["docs/x.md"] }],
    },
  );
  assert.match(note, /stop reason:\*\* fixer_out_of_scope/);
});
