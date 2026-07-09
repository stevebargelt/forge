import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCommitRange,
  parseReviewerVerdict,
  runVerification,
  runReviewLoop,
  renderReviewLoopNote,
  isCloseoutFinding,
  partitionCloseoutFindings,
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

test("#301 verdict: a file with no line is coerced to unanchored (anchored needs both, but isn't rejected)", async () => {
  const r = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "somewhere in x", file: "src/x.ts" }] });
  assert.equal(r.ok, true);
  assert.deepEqual((r as { findings: Finding[] }).findings, [{ summary: "somewhere in x", file: "src/x.ts", unanchored: true }]);
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

// ── FG-457: RED vocabulary (fail/inconclusive) normalization ─────────────────

test("#457 verdict: red-style fail with findings normalizes to needs_fix, findings preserved", async () => {
  const r = parseReviewerVerdict({ verdict: "fail", findings: [{ summary: "off-by-one", file: "src/x.ts", line: 42 }] });
  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "needs_fix");
  assert.deepEqual((r as { findings: Finding[] }).findings, [{ summary: "off-by-one", file: "src/x.ts", line: 42 }]);
});

test("#457 verdict: red-style inconclusive normalizes to blocked", async () => {
  const r = parseReviewerVerdict({ verdict: "inconclusive", findings: [{ summary: "can't tell", unanchored: true }] });
  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "blocked");
});

test("#457 verdict: native needs_fix/pass/blocked still parse unchanged", async () => {
  const nf = parseReviewerVerdict({ verdict: "needs_fix", findings: [{ summary: "x", file: "a.ts", line: 1 }] });
  assert.equal(nf.ok, true);
  assert.equal((nf as { verdict: string }).verdict, "needs_fix");

  const p = parseReviewerVerdict({ verdict: "pass" });
  assert.equal(p.ok, true);
  assert.equal((p as { verdict: string }).verdict, "pass");

  const b = parseReviewerVerdict({ verdict: "blocked", findings: [{ summary: "ambiguous", unanchored: true }] });
  assert.equal(b.ok, true);
  assert.equal((b as { verdict: string }).verdict, "blocked");
});

test("#457 verdict: red-style fail with ZERO findings is still an error (empty fail isn't actionable)", async () => {
  const r = parseReviewerVerdict({ verdict: "fail", findings: [] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /needs_fix requires at least one finding/);
});

// ── FG-493: a well-formed red-schema fail (findings following red's OWN
// omit-anchor-entirely convention, not the loop's `unanchored: true` flag) must
// parse as needs_fix, not fail the whole result ────────────────────────────────

test("#493 verdict: red-style fail with findings that omit file/line/unanchored entirely (red's native 'omit or cite' convention) still parses", async () => {
  // Mirrors the real red-wide docs_drift finding shape from the FG-493 evidence:
  // extra red-native keys (finding_type, severity, evidence, hypothesis) alongside
  // a concern that isn't pinned to one line, and NO explicit `unanchored: true` —
  // red's seed says to omit file/line entirely for such a concern, never to set a flag.
  const r = parseReviewerVerdict({
    status: "complete",
    verdict: "fail",
    confidence: 0.8,
    findings: [
      { severity: "medium", summary: "doc describes the old flag name", finding_type: "docs_drift" },
      { severity: "low", summary: "README still documents the removed command", finding_type: "docs_drift" },
    ],
    invariants_verified: ["x"],
    notes: "some notes",
  });
  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "needs_fix");
  assert.deepEqual(
    (r as { findings: Finding[] }).findings.map((f) => f.unanchored),
    [true, true],
  );
});

test("#493 verdict: a genuinely unparseable reviewer result is still rejected — negative half preserved", async () => {
  assert.equal(parseReviewerVerdict({ status: "complete", findings: [{ summary: "x" }] } /* verdict key missing entirely */).ok, false);
  assert.equal(parseReviewerVerdict({ verdict: "lgtm", findings: [] } /* verdict outside the accepted vocabulary */).ok, false);
  assert.equal(parseReviewerVerdict(undefined).ok, false);
});

// ── FG-462: closeout-finding partition ───────────────────────────────────────

test("#462 closeout: a finding anchored on the CURRENT ticket's active backlog file is closeout (never fixer work)", () => {
  assert.equal(isCloseoutFinding({ summary: "still active in stories — should be moved to backlog/done", file: "backlog/stories/FG-459-x.md", line: 3 }, "FG-459"), true);
});

test("#462 closeout: AC1 robustness — a finding anchored on the current ticket's active backlog file is closeout even with NO explicit close/move verb (the literal FG-459 incident phrasing)", () => {
  // The FG-459 incident finding named the ticket's own file as still-active with no
  // "move/close/done" verb. It is anchored on a backlog/ file the fixer can NEVER
  // commit (DISALLOWED_RE), so it must be withheld regardless of wording — content-
  // gating this branch reintroduced the exact AC1 violation the ticket fixes.
  assert.equal(isCloseoutFinding({ summary: "still active in stories despite the fix being implemented in cc3a09f", file: "backlog/stories/FG-459-x.md", line: 3 }, "FG-459"), true);
  assert.equal(isCloseoutFinding({ summary: "AC #3 is ambiguous about scope", file: "backlog/stories/FG-459-x.md", line: 3 }, "FG-459"), true);
});

test("#462 closeout: a finding anchored on backlog/done/ (already-closed ticket) is NOT closeout — genuine stale-docs catch stays fixable", () => {
  assert.equal(isCloseoutFinding({ summary: "stale done text", file: "backlog/done/FG-459-x.md", line: 1 }, "FG-459"), false);
});

test("#462 closeout: a finding anchored on an UNRELATED ticket's backlog file is NOT closeout — scoped to the current ticket (FG-462 AC)", () => {
  // another ticket's story, an epic/idea file, backlog/notes.md — none is the ticket
  // under review, so none is closeout. Left fixable so it is not silently relabeled
  // routine post-merge closeout (DISALLOWED_RE gives a clean fixer_out_of_scope stop).
  assert.equal(isCloseoutFinding({ summary: "another ticket still active", file: "backlog/stories/FG-100-y.md", line: 2 }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "stale epic text", file: "backlog/epics/FG-370-z.md", line: 4 }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "stale handoff note", file: "backlog/notes.md", line: 9 }, "FG-462"), false);
});

test("#462 closeout: ticketId boundary — FG-462 does not match FG-4620 (no substring bleed)", () => {
  assert.equal(isCloseoutFinding({ summary: "should be moved to backlog/done", file: "backlog/stories/FG-4620-x.md", line: 1 }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "should be moved to backlog/done", file: "backlog/stories/FG-462-x.md", line: 1 }, "FG-462"), true);
});

test("#462 closeout: an UNANCHORED finding proposing close/move/mark-done is closeout", () => {
  assert.equal(isCloseoutFinding({ summary: "run forge backlog close FG-459 after merge", unanchored: true }, "FG-459"), true);
  assert.equal(isCloseoutFinding({ summary: "the ticket should be moved to backlog/done", unanchored: true }, "FG-459"), true);
  assert.equal(isCloseoutFinding({ summary: "set status: done for this ticket", unanchored: true }, "FG-459"), true);
  assert.equal(isCloseoutFinding({ summary: "this ticket should be closed", unanchored: true }, "FG-459"), true);
  assert.equal(isCloseoutFinding({ summary: "move the ticket to done", unanchored: true }, "FG-459"), true);
});

test("#462 closeout: an UNANCHORED finding using bare close/done vocabulary with no ticket/backlog context is NOT closeout (application-domain sense)", () => {
  // "move ... done" / "status ... done" / "mark ... done" / "should be closed" read
  // just as plausibly as app-domain bug reports — only treat them as closeout when
  // the summary also names a ticket/backlog, else legitimate bugs get silently
  // dropped from the fixer.
  assert.equal(isCloseoutFinding({ summary: "move this to done", unanchored: true }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "the job's status becomes done before the callback fires, causing a race", unanchored: true }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "marking the request done twice sends a duplicate completion event", unanchored: true }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "this stream should be closed once the response finishes", unanchored: true }, "FG-462"), false);
});

test("#462 closeout: an UNANCHORED domain bug report that mentions 'ticket'/'backlog' far from unrelated close/done vocabulary is NOT closeout", () => {
  // The ticket/backlog mention and the close/done vocabulary must be near each
  // other (same clause) to read as one recommendation — a summary that opens by
  // noting it came out of backlog triage, then separately describes an unrelated
  // application bug using generic mark/done vocabulary many characters later,
  // must not be misread as a close/move recommendation just because both
  // vocabularies appear somewhere in the same (multi-clause) summary.
  assert.equal(isCloseoutFinding({
    summary: "Filed via backlog triage last week. Completely unrelated: the invoice worker's retry path marks the payment as done before the charge is confirmed, producing duplicate ledger entries during peak load.",
    unanchored: true,
  }, "FG-462"), false);
});

test("#462 closeout: a CODE-anchored finding is fixer work regardless of close/move phrasing", () => {
  // e.g. "remove the stale 'close after merge' comment" — a real code fix, not closeout.
  assert.equal(isCloseoutFinding({ summary: "remove the stale 'close the ticket after merge' comment", file: "src/x.ts", line: 12 }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "status: done handling is wrong here", file: "src/status.ts", line: 5 }, "FG-462"), false);
});

test("#462 closeout: an unanchored real concern (no close/move phrasing) stays fixable", () => {
  assert.equal(isCloseoutFinding({ summary: "the new behavior lacks test coverage", unanchored: true }, "FG-462"), false);
  assert.equal(isCloseoutFinding({ summary: "off-by-one in the retry counter", unanchored: true }, "FG-462"), false);
});

test("#462 closeout: partition splits closeout from fixable, order-preserving", () => {
  const findings: Finding[] = [
    { summary: "off-by-one", file: "a.ts", line: 1 },                                   // fixable
    { summary: "move FG-459 to backlog/done", file: "backlog/stories/FG-459-x.md", line: 2 }, // closeout (current-ticket backlog)
    { summary: "missing coverage", unanchored: true },                                  // fixable
    { summary: "run forge backlog close after merge", unanchored: true },               // closeout (phrase)
    { summary: "another ticket still active", file: "backlog/stories/FG-100-y.md", line: 7 }, // fixable (unrelated ticket)
  ];
  const { fixable, closeout } = partitionCloseoutFindings(findings, "FG-459");
  assert.deepEqual(fixable.map((f) => f.summary), ["off-by-one", "missing coverage", "another ticket still active"]);
  assert.deepEqual(closeout.map((f) => f.summary), ["move FG-459 to backlog/done", "run forge backlog close after merge"]);
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

// ── FG-500: fallback verification adds test:extended when the script exists ──

test("FG-500 verify: runs typecheck, test, THEN test:extended when all three scripts exist; ok when all pass", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, output: "ok" }; };
  const r = runVerification({ typecheck: "tsc --noEmit", test: "node --test", "test:extended": "npm run test:integration" }, { run });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.name), ["typecheck", "test", "test:extended"]);
  assert.deepEqual(calls, [
    ["npm", "run", "--silent", "typecheck"],
    ["npm", "run", "--silent", "test"],
    ["npm", "run", "--silent", "test:extended"],
  ]);
});

test("FG-500 verify: a failing test:extended step → ok false, even though typecheck+test passed", async () => {
  const run: CommandRunner = (_cmd, args) =>
    args.includes("test:extended") ? { ok: false, output: "1 failing" } : { ok: true, output: "ok" };
  const r = runVerification({ typecheck: "x", test: "y", "test:extended": "z" }, { run });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === "test:extended")!.ok, false);
});

test("FG-500 verify regression: no test:extended script → unchanged (only typecheck+test run)", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, output: "ok" }; };
  const r = runVerification({ typecheck: "tsc --noEmit", test: "node --test" }, { run });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.name), ["typecheck", "test"], "no test:extended script — the fallback list stays the same as before FG-500");
  assert.equal(calls.length, 2);
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

// ── FG-462: closeout findings are withheld from the fixer ────────────────────

test("#462 loop: FG-459 shape — reviewer flags the active backlog file + a real code finding; fixer gets ONLY the code finding", async () => {
  let round = 0;
  let given: Finding[] = [];
  const mixed: Finding[] = [
    { summary: "FG-459 still active in the backlog — move to done", file: "backlog/stories/FG-459-x.md", line: 3 }, // closeout
    { summary: "reconcile.integration.test.ts missing a case", file: "src/v2/reconcile.integration.test.ts", line: 42 },                // fixable
  ];
  const r = await runReviewLoop({ maxRounds: 2, ticketId: "FG-459" }, deps({
    review: () => (++round === 1
      ? { ok: true, verdict: "needs_fix", findings: mixed }
      : { ok: true, verdict: "pass", findings: [] }),
    fix: (f) => { given = f; return { ok: true }; },
  }));
  assert.equal(r.stopReason, "passed");
  // The fixer received ONLY the legitimate code finding — never the backlog close/move.
  assert.deepEqual(given.map((f) => f.summary), ["reconcile.integration.test.ts missing a case"]);
  // The closeout finding is surfaced on the round, not dropped silently.
  assert.deepEqual(r.rounds[0]!.closeoutFindings?.map((f) => f.file), ["backlog/stories/FG-459-x.md"]);
});

test("#462 loop: reviewer's ONLY findings are closeout → closeout_guidance_only, fixer NOT called, not closeable", async () => {
  let fixCalled = false;
  const r = await runReviewLoop({ maxRounds: 2, ticketId: "FG-462" }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: [
      { summary: "move this ticket to backlog/done and set status: done", file: "backlog/stories/FG-462-x.md", line: 1 },
    ] }),
    fix: () => { fixCalled = true; return { ok: true }; },
  }));
  assert.equal(r.stopReason, "closeout_guidance_only");
  assert.equal(r.closeable, false, "orchestrator retains final closeout authority");
  assert.equal(fixCalled, false, "fixer must never be dispatched to close/move the ticket");
  assert.equal(r.rounds.length, 1);
  assert.equal(r.rounds[0]!.closeoutFindings?.length, 1);
});

test("#462 loop: an UNRELATED-ticket backlog finding is NOT withheld — it flows to the fixer (scoped to the current ticket)", async () => {
  let given: Finding[] = [];
  const r = await runReviewLoop({ maxRounds: 1, ticketId: "FG-462" }, deps({
    review: () => ({ ok: true, verdict: "needs_fix", findings: [
      { summary: "unrelated ticket's stale backlog text", file: "backlog/stories/FG-100-y.md", line: 2 },
    ] }),
    fix: (f) => { given = f; return { ok: true }; },
  }));
  // max rounds 1 → no fix on the final round, but the finding is fixable (not closeout).
  assert.equal(r.stopReason, "needs_fix_max_rounds");
  assert.equal(r.rounds[0]!.closeoutFindings, undefined, "an unrelated-ticket backlog finding is not closeout");
});

test("#462 note: closeout guidance is rendered ONCE (not duplicated in the general findings list) as orchestrator post-merge", () => {
  const shared = { summary: "move to done", file: "backlog/stories/FG-462-x.md", line: 1 };
  const codeFinding = { summary: "off-by-one", file: "src/x.ts", line: 9 };
  const note = renderReviewLoopNote(
    { ticketId: "462", maxRounds: 2, range: { mode: "since", diffRange: "a..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "needs_fix_max_rounds", closeable: false,
      rounds: [{
        round: 1, verification: VERIFY_OK, verdict: "needs_fix",
        findings: [codeFinding, shared],       // full unpartitioned set
        closeoutFindings: [shared],            // distinct-instance value (proves value-keyed dedup)
        fixAttempted: false,
      }],
    },
  );
  assert.match(note, /closeout guidance \(orchestrator post-merge — NOT sent to fixer\)/);
  assert.match(note, /backlog\/stories\/FG-462-x\.md:1 move to done/);
  // #3: the closeout finding renders exactly once (dedup'd out of the general list),
  // while the genuine code finding still shows under "findings:".
  assert.equal((note.match(/move to done/g) ?? []).length, 1, "closeout finding must not be double-listed");
  assert.match(note, /- findings:/);
  assert.match(note, /src\/x\.ts:9 off-by-one/);
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

// FG-474: reused covering evidence renders WHAT covered it (row id / CI url + sha)
// in place of run output.
test("FG-474 note: reused verification evidence is shown in the round detail", () => {
  const note = renderReviewLoopNote(
    { ticketId: "474", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "passed", closeable: true,
      rounds: [
        {
          round: 1,
          verification: { ok: true, steps: [{ name: "reused", ok: true, output: "host_verifications row #7 (sha abc123, command: npm run test:all)" }], reusedEvidence: "host_verifications row #7 (sha abc123, command: npm run test:all)" },
          verdict: "pass", findings: [], fixAttempted: false,
        },
      ],
    },
  );
  assert.match(note, /verification reused evidence: host_verifications row #7/);
});

// Existing behavior preserved: a round with no reusedEvidence renders exactly as
// before (no extra line).
test("FG-474 note: a round with NO reusedEvidence renders unchanged — no reuse line", () => {
  const note = renderReviewLoopNote(
    { ticketId: "474", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "passed", closeable: true,
      rounds: [{ round: 1, verification: { ok: true, steps: [{ name: "test", ok: true, output: "" }] }, verdict: "pass", findings: [], fixAttempted: false }],
    },
  );
  assert.doesNotMatch(note, /verification reused evidence/);
});

// FG-501 AC6: renderReviewLoopNote's operator-facing rendering of HOW the
// CI-consuming path (buildReviewLoopDeps.verify in cli/commands/review-loop.ts)
// resolved verification. The reused_after_wait case is already exercised
// end-to-end in review-loop.integration.test.ts's AC7 block; these pin the
// two cases that block doesn't render through the note: a failing required CI
// check (ci_failed) and the local fallback's reason + fast-only/full tier
// wording (local_fallback), including the --local-extended toggle.

test("FG-501 note: local fallback (CI unavailable) records the reason and the fast-only tier wording by default", () => {
  const note = renderReviewLoopNote(
    { ticketId: "501", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "passed", closeable: true,
      rounds: [{
        round: 1,
        verification: {
          ok: true, steps: [{ name: "typecheck", ok: true, output: "" }, { name: "test", ok: true, output: "" }],
          ciOutcome: { kind: "local_fallback", reason: 'no CI status available for check "CI / test" at sha abc1234', extendedDelegatedToCi: true },
        },
        verdict: "pass", findings: [], fixAttempted: false,
      }],
    },
  );
  assert.match(note, /CI: local fallback — no CI status available for check "CI \/ test"/);
  assert.match(note, /local fallback tier: fast only \(test:extended delegated to CI\)/);
});

test("FG-501 note: local fallback with --local-extended records the full tier wording", () => {
  const note = renderReviewLoopNote(
    { ticketId: "501", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "passed", closeable: true,
      rounds: [{
        round: 1,
        verification: {
          ok: true, steps: [{ name: "typecheck", ok: true, output: "" }],
          ciOutcome: { kind: "local_fallback", reason: "CI wait timed out after 1200s — still pending: CI / test", extendedDelegatedToCi: false },
        },
        verdict: "pass", findings: [], fixAttempted: false,
      }],
    },
  );
  assert.match(note, /CI: local fallback — CI wait timed out after 1200s/);
  assert.match(note, /local fallback tier: full \(incl\. test:extended\)/);
});

test("FG-501 note: a failing required CI check records the context+url with no local run", () => {
  const note = renderReviewLoopNote(
    { ticketId: "501", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "verification_failed", closeable: false,
      rounds: [{
        round: 1,
        verification: {
          ok: false,
          steps: [{ name: "CI / test", ok: false, output: 'required CI check "CI / test" failed for abc1234 — https://example.com/ci/run-fail' }],
          ciOutcome: { kind: "ci_failed", context: "CI / test", url: "https://example.com/ci/run-fail" },
        },
        findings: [{ summary: "deterministic verification step 'CI / test' failed", unanchored: true }],
        fixAttempted: false,
      }],
    },
  );
  assert.match(note, /CI: required check "CI \/ test" failed — https:\/\/example\.com\/ci\/run-fail \(no local run\)/);
});

test("FG-501 note: a failing required CI check with NO url still records the context, with no local run", () => {
  const note = renderReviewLoopNote(
    { ticketId: "501", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    {
      stopReason: "verification_failed", closeable: false,
      rounds: [{
        round: 1,
        verification: {
          ok: false,
          steps: [{ name: "CI / test", ok: false, output: 'required CI check "CI / test" failed for abc1234' }],
          ciOutcome: { kind: "ci_failed", context: "CI / test" },
        },
        findings: [{ summary: "deterministic verification step 'CI / test' failed", unanchored: true }],
        fixAttempted: false,
      }],
    },
  );
  assert.match(note, /CI: required check "CI \/ test" failed \(no local run\)/);
  assert.doesNotMatch(note, /CI: required check "CI \/ test" failed —/);
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

// ── FG-457: red-vocabulary fail drives a real loop round, never reviewer_failed ──

test("#457 loop e2e: reviewer returning RED-style fail (+ findings) never yields reviewer_failed, and findings surface in the rounds", async () => {
  const r = await runReviewLoop({ maxRounds: 2 }, deps({
    review: () => {
      // Mimics the real CLI wiring (buildReviewLoopDeps): the reviewer's raw
      // result.json is fed through parseReviewerVerdict before becoming a
      // ReviewDispatch, exactly like a real red-wide result would be.
      const parsed = parseReviewerVerdict({ verdict: "fail", findings: [{ summary: "off-by-one", file: "a.ts", line: 3 }] });
      return parsed.ok ? { ok: true, verdict: parsed.verdict, findings: parsed.findings } : { ok: false, error: parsed.error };
    },
  }));
  assert.notEqual(r.stopReason, "reviewer_failed");
  assert.equal(r.stopReason, "needs_fix_max_rounds");
  assert.equal(r.rounds[0]!.verdict, "needs_fix");
  assert.deepEqual(r.rounds[0]!.findings, [{ summary: "off-by-one", file: "a.ts", line: 3 }]);
});

// ── FG-493: a well-formed red-schema fail, with findings that follow red's OWN
// omit-anchor convention (no `unanchored: true` flag), drives a real needs_fix
// round + fixer dispatch through the real loop path — not a false reviewer_failed ──

test("#493 loop e2e: reviewer returning a well-formed red-schema fail (unpinned docs-drift findings) produces needs_fix + fixer dispatch, not reviewer_failed", async () => {
  const fixCalls: Finding[][] = [];
  const r = await runReviewLoop({ maxRounds: 2, ticketId: "FG-489" }, deps({
    review: () => {
      // The exact shape from the FG-493 evidence: extra red-native top-level keys
      // (status, confidence, invariants_verified, notes) and two docs-drift
      // findings that are real concerns but aren't pinned to one line — red's own
      // seed contract says to omit file/line entirely here, not set a flag.
      const raw = {
        status: "complete",
        verdict: "fail",
        confidence: 0.8,
        findings: [
          { severity: "medium", summary: "doc still describes the removed --legacy flag", finding_type: "docs_drift" },
          { severity: "low", summary: "README quickstart references the old command name", finding_type: "docs_drift" },
        ],
        invariants_verified: ["reviewer read the working tree"],
        notes: "2 docs-drift findings, both real",
      };
      const parsed = parseReviewerVerdict(raw);
      return parsed.ok ? { ok: true, verdict: parsed.verdict, findings: parsed.findings } : { ok: false, error: parsed.error };
    },
    fix: (findings) => { fixCalls.push(findings); return { ok: true, committedSha: "deadbeef" }; },
  }));

  assert.notEqual(r.stopReason, "reviewer_failed");
  assert.equal(r.rounds[0]!.verdict, "needs_fix");
  assert.equal(r.rounds[0]!.findings.length, 2);
  assert.equal(r.rounds[0]!.fixAttempted, true, "a real fail verdict with findings must dispatch the fixer");
  assert.equal(fixCalls.length, 1);
  assert.equal(fixCalls[0]!.length, 2);
});

// ── FG-457: renderReviewLoopNote disambiguates absent-verdict causes ─────────

test("#457 note: verification ok + no verdict → reviewer failed (invalid/absent result), not the skip line", () => {
  const note = renderReviewLoopNote(
    { ticketId: "457", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    { stopReason: "reviewer_failed", closeable: false, rounds: [
      { round: 1, verification: VERIFY_OK, findings: [], fixAttempted: false },
    ] },
  );
  assert.match(note, /reviewer: failed \(invalid or absent result\)/);
  assert.doesNotMatch(note, /reviewer: skipped \(verification failed\)/);
});

test("#457 note: verification failed + no verdict → still the genuine skip line", () => {
  const note = renderReviewLoopNote(
    { ticketId: "457", maxRounds: 1, range: { mode: "since", diffRange: "x..HEAD", shas: [], spansUnmatched: false } },
    { stopReason: "verification_failed", closeable: false, rounds: [
      { round: 1, verification: VERIFY_BAD, findings: [], fixAttempted: false },
    ] },
  );
  assert.match(note, /reviewer: skipped \(verification failed\)/);
});
