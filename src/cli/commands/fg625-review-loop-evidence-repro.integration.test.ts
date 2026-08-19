// FG-625 step 2 — the evidence-first reproduction of the FG-559 shape.
//
// The two historical FG-559 stops (run-review-loop-fg-559-fdc4ce and
// run-review-loop-fg-559-632048) each began at a SHA with all required CI
// checks green, entered the loop on a CLEAN tree, produced a correct in-scope
// fixer diff, and then stopped `verification_failed` — reporting ONLY the dirty
// paths. No failed step name, no command, no tier, no output. That is the exact
// shape this file reproduces end-to-end, now that step 1's instrumentation is in
// place, and pins that the PREVIOUSLY MISSING evidence is recorded through every
// hop: FixDispatch -> RoundRecord -> the rendered run note -> the durable
// review_loop.fix_verification_finished event.
//
// Why a CLEAN-tree / CI-REUSE round entry and not a dirty-tree entry: on a dirty
// entry the round-entry verifier already runs a local pass (and, post-FG-566, a
// readiness preflight), which would MASK the second FG-625 defect — the missing
// readiness preflight on the post-fixer path at review-loop.ts:924. Entering
// clean via covering CI evidence means readiness is never consulted at round
// entry, so the post-fixer event's `readiness: null` is the honest, load-bearing
// record that the post-fixer path consulted no readiness at all. That absence is
// the evidence the orchestrator uses to update the ticket's recorded root cause
// and direction before the behavioral fix (step 3) lands.
//
// This file is the reproduction ARTIFACT only. It edits no backlog/ticket/PLAN.md
// file — updating the ticket from this evidence is a backlog operation the
// orchestrator performs, not an engineer file edit.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { buildReviewLoopDeps, type ReviewLoopContext } from "./review-loop.js";
import { runReviewLoop, renderReviewLoopNote } from "../../v2/review-loop.js";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertHostVerification } from "../../store/host-verifications.js";
import { eventsForRun } from "../../store/events.js";
import type { InvokeArgs, InvokeResult } from "../../v2/invoke.js";

const FIX_VERIFICATION_FINISHED = "review_loop.fix_verification_finished";
// The failing post-fixer `test` step echoes this marker; if any hop dropped the
// step output we would see the marker survive nowhere.
const FAIL_MARKER = "FG559_REPRO_POST_FIXER_TAIL";

type FixVerificationPayload = {
  ticketId: string;
  round: number;
  ok: boolean;
  readiness: unknown;
  steps: { name: string; ok: boolean; command: string | null; tier: string | null; output: string | null }[];
};

let projectDir: string;
let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function gitExec(args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

// Fast-tier scripts (typecheck + test) — localFallbackScripts() runs exactly
// these on the post-fixer path. typecheck passes and test fails, so the failing
// step's evidence AND the passing step both have to survive, and the two must not
// be conflated.
const SCRIPTS = { typecheck: "true", test: `echo ${FAIL_MARKER} && exit 1` };

function ctx(over: Partial<ReviewLoopContext> = {}): ReviewLoopContext {
  return {
    ticketId: "FG-559", acceptance: "FG-559 — reviewer-found fix", diffProvider: () => "diff --git a/src.ts b/src.ts",
    projectDir, scripts: SCRIPTS, unrouted: true, ...over,
  };
}

const COMPLETE = (over: Partial<InvokeResult> = {}): InvokeResult =>
  ({ runId: "run-1", taskId: "t-1", status: "complete", ...over });

// The reviewer returns a single concrete, fixable finding anchored on real code;
// the fixer writes an in-scope src.ts diff that survives the scope guard and then
// fails the post-fixer verification. One invokeFn serves both roles by agentRole.
function reproInvokeFn(): (a: InvokeArgs) => Promise<InvokeResult> {
  return async (a: InvokeArgs): Promise<InvokeResult> => {
    if (a.agentRole === "engineer") {
      // The "correct in-scope diff" — a src file, nothing orchestrator-owned.
      writeFileSync(join(projectDir, "src.ts"), "// reviewer-found fix applied\n");
      return COMPLETE();
    }
    // red-wide reviewer → needs_fix with one fixable (code-anchored) finding.
    return COMPLETE({ result: { verdict: "needs_fix", findings: [{ summary: "src.ts drops the error on the retry path", file: "src.ts", line: 1 }] } });
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg625-repro-"));
  gitExec(["init", "-q"]);
  gitExec(["config", "user.email", "t@t.com"]);
  gitExec(["config", "user.name", "Test"]);
  writeFileSync(join(projectDir, "src.ts"), "// initial\n");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: SCRIPTS }, null, 2));
  gitExec(["add", "."]);
  gitExec(["commit", "-m", "initial commit"]);
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

// Seed the covering CI evidence so the CLEAN-tree round entry reuses it — the
// FG-559 precondition (green required checks at the reviewed SHA).
function seedCoveringCiEvidence(): void {
  const headSha = gitExec(["rev-parse", "HEAD"]).trim();
  insertHostVerification({
    ticketId: "FG-559", projectDir, commitSha: headSha,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-07-25T00:00:00Z",
  });
}

test("FG-625 repro: the FG-559 shape (CI-reuse clean entry -> failing fixer diff) records the previously MISSING evidence end-to-end", async () => {
  seedCoveringCiEvidence();
  const { deps } = buildReviewLoopDeps(
    ctx({
      runId: "run-fg559-repro",
      // A dirty tree must never reuse; a consulted CI provider here would mean the
      // clean-entry reuse precondition broke.
      checkStatusProvider: () => { throw new Error("clean-tree round entry must reuse the host row, never consult CI"); },
    }),
    reproInvokeFn(),
  );

  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-559" }, deps);

  // ── The stop: verification_failed, exactly the FG-559 shape ────────────────
  assert.equal(outcome.stopReason, "verification_failed");
  assert.equal(outcome.closeable, false);
  assert.equal(outcome.rounds.length, 1, "one round: reuse entry, reviewer needs_fix, fixer diff, post-fixer verification fails");
  const round = outcome.rounds[0]!;

  // ── Round entry was a CLEAN-tree CI reuse: readiness NEVER consulted ───────
  // This is what makes the post-fixer `readiness: null` below load-bearing — the
  // loop reached the post-fixer path having established no readiness at all.
  assert.match(round.verification.reusedEvidence ?? "", /host_verifications row/, "the clean-tree round entry reused the covering CI evidence");
  assert.equal(round.verification.readiness, undefined, "CI reuse returns before readiness is ever consulted — the round-entry readiness field is absent");

  // ── FixDispatch -> RoundRecord: the WHOLE post-fixer VerificationResult ─────
  // Pre-FG-625 this was discarded and only dirtyPaths survived.
  assert.ok(round.fixAttempted, "the fixer was dispatched this round");
  assert.ok(round.fixDirtyPaths && round.fixDirtyPaths.length > 0, "the uncommitted diff's dirty paths are recorded (the old, insufficient evidence)");
  const fixVerification = round.fixVerification;
  assert.ok(fixVerification, "FG-625: the full post-fixer VerificationResult survives onto RoundRecord.fixVerification");
  assert.equal(fixVerification!.ok, false);

  const failStep = fixVerification!.steps.find((s) => s.name === "test");
  const passStep = fixVerification!.steps.find((s) => s.name === "typecheck");
  assert.ok(failStep, "the failing step is named on the RoundRecord");
  assert.ok(passStep, "the passing step is recorded too — the two are not conflated");
  assert.equal(failStep!.ok, false);
  assert.equal(passStep!.ok, true);
  assert.equal(failStep!.command, "npm run --silent test", "the failing step's command survives");
  assert.equal(failStep!.tier, "fast", "the failing step's tier survives");
  assert.match(failStep!.output, new RegExp(FAIL_MARKER), "the failing step's OUTPUT survives — the exact byte that was missing on the FG-559 stops");

  // ── The durable run note names the failed step — never just dirty paths ────
  const note = renderReviewLoopNote(
    {
      ticketId: "FG-559", maxRounds: 2,
      range: { mode: "since", diffRange: "a..b", shas: ["a"], spansUnmatched: false },
      reviewedTipSha: gitExec(["rev-parse", "HEAD"]).trim(),
      remoteTrust: { kind: "trusted", remoteRef: "origin/main" },
    },
    outcome,
  );
  assert.match(note, /fix left uncommitted \(verification failed\)/, "the note still records the historical headline");
  assert.match(note, /post-fixer verification failed steps:/, "FG-625: the note now enumerates the failed post-fixer steps");
  assert.match(note, /deterministic verification step 'test' failed/, "the note names WHICH step failed");
  assert.match(note, /command: npm run --silent test/, "the note carries the failed step's command");
  assert.match(note, /tier: fast/, "the note carries the failed step's tier");
  assert.match(note, new RegExp(FAIL_MARKER), "the note carries the failed step's bounded output tail — `verification_failed` with only dirty paths is impossible");

  // ── The durable, queryable event carries the same evidence + readiness ─────
  const evt = eventsForRun("run-fg559-repro").find((e) => e.eventType === FIX_VERIFICATION_FINISHED);
  assert.ok(evt, "a durable post-fixer verification event fires on the failing path");
  const payload = evt!.payload as FixVerificationPayload;
  assert.equal(payload.ticketId, "FG-559");
  assert.equal(payload.round, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.readiness, null, "FG-625 Defect B evidence: the post-fixer path consulted NO readiness — recorded as null, not silently omitted");
  const evtFail = payload.steps.find((s) => s.name === "test")!;
  const evtPass = payload.steps.find((s) => s.name === "typecheck")!;
  assert.equal(evtFail.ok, false);
  assert.equal(evtFail.command, "npm run --silent test");
  assert.equal(evtFail.tier, "fast");
  assert.match(evtFail.output ?? "", new RegExp(FAIL_MARKER), "the event carries the failing step's output tail");
  assert.equal(evtPass.ok, true);
  assert.equal(evtPass.output, null, "a passing step carries no output tail on the event — only failures do");

  // ── The FG-559 stop's defining property: HEAD did not move, diff left dirty ─
  const headSubject = gitExec(["log", "-1", "--format=%s"]).trim();
  assert.equal(headSubject, "initial commit", "verify-before-commit held: no fix commit landed on a failed verification");
  assert.ok(gitExec(["status", "--porcelain"]).trim().length > 0, "the correct-but-unverified diff is left uncommitted for inspection");
});

// A focused negative pinning the acceptance criterion directly: the historical
// failure — a verification_failed report that is ONLY a list of dirty paths — is
// no longer producible from this reproduction.
test("FG-625 repro: verification_failed is NEVER just dirty paths — the note enumerates the failed step's command/tier/output", async () => {
  seedCoveringCiEvidence();
  const { deps } = buildReviewLoopDeps(
    ctx({ runId: "run-fg559-repro-2", checkStatusProvider: () => { throw new Error("clean entry must reuse, not consult CI"); } }),
    reproInvokeFn(),
  );
  const outcome = await runReviewLoop({ maxRounds: 2, ticketId: "FG-559" }, deps);
  assert.equal(outcome.stopReason, "verification_failed");

  const note = renderReviewLoopNote(
    {
      ticketId: "FG-559", maxRounds: 2,
      range: { mode: "since", diffRange: "a..b", shas: ["a"], spansUnmatched: false },
      reviewedTipSha: gitExec(["rev-parse", "HEAD"]).trim(),
      remoteTrust: { kind: "trusted", remoteRef: "origin/main" },
    },
    outcome,
  );

  // The dirty-path line alone (the whole of the FG-559 durable report) must now
  // ALWAYS be accompanied by the named failing step and its evidence.
  const dirtyLineOnly = /fix left uncommitted \(verification failed\): [^\n]+\n(?![\s\S]*post-fixer verification failed steps:)/;
  assert.doesNotMatch(note, dirtyLineOnly, "a verification-failed round that lists dirty paths must ALSO enumerate the failed steps");
  assert.match(note, /post-fixer verification failed steps:[\s\S]*command: npm run --silent test[\s\S]*FG559_REPRO_POST_FIXER_TAIL/);
});
