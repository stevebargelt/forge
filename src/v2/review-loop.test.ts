import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCommitRange,
  parseReviewerVerdict,
  runVerification,
  runReviewLoop,
  type GitRunner,
  type CommandRunner,
  type ReviewLoopDeps,
  type VerificationResult,
  type ReviewDispatch,
  type Finding,
} from "./review-loop.js";

// ── Slice 1: resolveCommitRange ──────────────────────────────────────────────

test("#301 range: --since yields <sha>..HEAD with its shas", () => {
  const git: GitRunner = (args) => {
    assert.deepEqual(args, ["log", "--format=%H", "abc..HEAD"]);
    return "h2\nh1\n";
  };
  const r = resolveCommitRange("301", { since: "abc", git });
  assert.equal(r.mode, "since");
  assert.equal(r.diffRange, "abc..HEAD");
  assert.deepEqual(r.shas, ["h2", "h1"]);
});

test("#301 range: inferred from commits referencing the ticket → oldest^..newest", () => {
  const git: GitRunner = (args) => {
    assert.ok(args.includes("--grep=#301\\b"), "greps the ticket number with a word boundary");
    return "hNew\nhMid\nhOld\n"; // newest-first
  };
  const r = resolveCommitRange("#301", { git });
  assert.equal(r.mode, "inferred");
  assert.equal(r.diffRange, "hOld^..hNew");
  assert.deepEqual(r.shas, ["hNew", "hMid", "hOld"]);
});

test("#301 range: no --since and no matching commits → mode none", () => {
  const r = resolveCommitRange("999", { git: () => "\n  \n" });
  assert.deepEqual(r, { mode: "none", diffRange: "", shas: [] });
});

// ── Slice 2: parseReviewerVerdict ────────────────────────────────────────────

test("#301 verdict: valid pass with no findings", () => {
  const r = parseReviewerVerdict({ verdict: "pass" });
  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "pass");
});

test("#301 verdict: needs_fix with an anchored finding", () => {
  const r = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "off-by-one", file: "src/x.ts", line: 42 }] });
  assert.equal(r.ok, true);
  assert.equal((r as { findings: Finding[] }).findings[0]!.file, "src/x.ts");
});

test("#301 verdict: needs_fix with no findings is rejected", () => {
  const r = parseReviewerVerdict({ verdict: "needs_fix", findings: [] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /needs_fix requires at least one finding/);
});

test("#301 verdict: a finding must be anchored or explicitly unanchored", () => {
  const bad = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "vague" }] });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /anchored.*or.*unanchored/);
  const okUnanchored = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "broad concern", unanchored: true }] });
  assert.equal(okUnanchored.ok, true);
});

test("#301 verdict: unknown verdict value is rejected (never treated as pass)", () => {
  assert.equal(parseReviewerVerdict({ verdict: "lgtm" }).ok, false);
  assert.equal(parseReviewerVerdict("not json shaped").ok, false);
});

// ── Slice 3: runVerification ─────────────────────────────────────────────────

test("#301 verify: runs typecheck then test when both scripts exist; ok when all pass", () => {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, output: "ok" }; };
  const r = runVerification({ typecheck: "tsc --noEmit", test: "node --test" }, { run });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.name), ["typecheck", "test"]);
  assert.deepEqual(calls, [["npm", "run", "--silent", "typecheck"], ["npm", "run", "--silent", "test"]]);
});

test("#301 verify: any failing step → ok false", () => {
  const run: CommandRunner = (_cmd, args) => ({ ok: !args.includes("test"), output: args.includes("test") ? "1 failing" : "ok" });
  const r = runVerification({ typecheck: "x", test: "y" }, { run });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === "test")!.ok, false);
});

test("#301 verify: no discoverable scripts → ok false, no steps", () => {
  const r = runVerification({ build: "x" }, { run: () => ({ ok: true, output: "" }) });
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 0);
});

// ── Slice 4: runReviewLoop ───────────────────────────────────────────────────

const VERIFY_OK: VerificationResult = { ok: true, steps: [{ name: "test", ok: true, output: "" }] };
const VERIFY_BAD: VerificationResult = { ok: false, steps: [{ name: "test", ok: false, output: "fail" }] };
const ANCHORED: Finding[] = [{ summary: "fix me", file: "a.ts", line: 1 }];

function deps(over: Partial<ReviewLoopDeps>): ReviewLoopDeps {
  return {
    verify: () => VERIFY_OK,
    review: () => ({ ok: true, verdict: "pass", findings: [] }),
    fix: () => ({ ok: true }),
    ...over,
  };
}

test("#301 loop: reviewer pass + verification ok → passed + closeable", () => {
  const r = runReviewLoop({}, deps({}));
  assert.equal(r.stopReason, "passed");
  assert.equal(r.closeable, true);
  assert.equal(r.rounds.length, 1);
});

test("#301 loop: reviewer pass but verification fails → verification_failed, NOT closeable", () => {
  const r = runReviewLoop({}, deps({ verify: () => VERIFY_BAD }));
  assert.equal(r.stopReason, "verification_failed");
  assert.equal(r.closeable, false);
});

test("#301 loop: needs_fix → fix → pass on round 2 → passed", () => {
  let round = 0;
  const review: ReviewLoopDeps["review"] = () => (++round === 1
    ? { ok: true, verdict: "needs_fix", findings: ANCHORED }
    : { ok: true, verdict: "pass", findings: [] });
  let fixes = 0;
  const r = runReviewLoop({ maxRounds: 2 }, deps({ review, fix: () => { fixes++; return { ok: true }; } }));
  assert.equal(r.stopReason, "passed");
  assert.equal(r.closeable, true);
  assert.equal(fixes, 1, "fixer ran once between the two review rounds");
  assert.equal(r.rounds.length, 2);
  assert.equal(r.rounds[0]!.fixAttempted, true);
});

test("#301 loop: still needs_fix at max rounds → needs_fix_max_rounds (no fix on the last round)", () => {
  let fixes = 0;
  const r = runReviewLoop({ maxRounds: 2 }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: ANCHORED }),
    fix: () => { fixes++; return { ok: true }; },
  }));
  assert.equal(r.stopReason, "needs_fix_max_rounds");
  assert.equal(r.closeable, false);
  assert.equal(fixes, 1, "fix runs between rounds 1→2 but NOT after the final review");
});

test("#301 loop: blocked verdict → blocked_by_reviewer", () => {
  const r = runReviewLoop({}, deps({ review: () => ({ ok: true, verdict: "blocked", findings: [] }) }));
  assert.equal(r.stopReason, "blocked_by_reviewer");
  assert.equal(r.closeable, false);
});

test("#301 loop: reviewer dispatch failure → reviewer_failed", () => {
  const r = runReviewLoop({}, deps({ review: () => ({ ok: false, error: "unparseable verdict" }) }));
  assert.equal(r.stopReason, "reviewer_failed");
  assert.equal(r.closeable, false);
});

test("#301 loop: fixer failure → fixer_failed", () => {
  const r = runReviewLoop({ maxRounds: 3 }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: ANCHORED }),
    fix: () => ({ ok: false, error: "engineer crashed" }),
  }));
  assert.equal(r.stopReason, "fixer_failed");
  assert.equal(r.rounds.at(-1)!.fixError, "engineer crashed");
});

test("#301 loop: re-verifies every round (verify failure can change after a fix)", () => {
  let verifies = 0;
  let round = 0;
  runReviewLoop({ maxRounds: 2 }, deps({
    verify: () => { verifies++; return VERIFY_OK; },
    review: () => (++round === 1
      ? { ok: true, verdict: "needs_fix", findings: ANCHORED }
      : { ok: true, verdict: "pass", findings: [] }),
  }));
  assert.equal(verifies, 2, "verification runs at the start of each round");
});

test("#301 loop: maxRounds clamps to >= 1", () => {
  const r = runReviewLoop({ maxRounds: 0 }, deps({}));
  assert.equal(r.rounds.length, 1, "0 is treated as 1 round, not a no-op");
  assert.equal(r.stopReason, "passed");
});
