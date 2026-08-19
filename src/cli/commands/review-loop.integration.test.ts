// #301 slice 6: buildReviewLoopDeps wires the engine to invoke(). Tests use an
// injected invokeFn (no containers) — assert verdict mapping, dispatch-failure
// handling, runId threading, and the reviewer/fixer dispatch shape.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { invoke, type InvokeArgs, type InvokeResult, type DockerExecFn } from "../../v2/invoke.js";
import {
  buildReviewLoopDeps, assertCleanWorkingTree, registerReviewLoop, computeInRangeDocsPaths,
  resolveReviewedTipTrust, resolveReviewerProfilePlan, type ReviewLoopContext,
} from "./review-loop.js";
import { runReviewLoop, renderReviewLoopNote, resolveCommitRange, type VerificationResult, type GitRunner } from "../../v2/review-loop.js";
import { runDir } from "../../util/paths.js";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertHostVerification, REQUIRED_CI_CHECK_CONTEXT } from "../../store/host-verifications.js";
import { eventsForRun } from "../../store/events.js";
import { listRuns } from "../../store/runs.js";
import { publishFlatAsGeneration } from "../../v2/seed-generation.testkit.js";

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

// All tests use a real git repo (beforeEach sets projectDir). The new fix dep
// calls `git status --porcelain` after any completed engineer dispatch, so
// /tmp/proj (not a git repo) would crash the old tests.
let projectDir = "/tmp/proj";
let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-rl-"));
  gitExec(["init", "-q"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  writeFileSync(join(projectDir, "src.ts"), "// initial\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "initial commit"], projectDir);
  // FG-474: buildReviewLoopDeps.verify consults findCoveringGateEvidence, which
  // reads host_verifications from the store — give it a real in-memory DB.
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  // FG-514: bare-origin / clone scratch dirs created by the trust tests.
  for (const dir of extraTempDirs) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  extraTempDirs = [];
});

// FG-474 red-review fix (task-red-wide-16933b): findCoveringGateEvidence's CI
// branch now content-verifies the pairing against THIS projectDir's own
// ci.yml (projectCiRunsCommand) instead of a hardcoded constant — a stubbed
// green check only reaches (or is correctly rejected before reaching) the
// provider when projectDir actually has a workflow named "CI" whose "test"
// job runs the configured required gate command.
function writeMatchingCiWorkflow(command = "npm run test:all"): void {
  mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(projectDir, ".github", "workflows", "ci.yml"),
    `name: CI\njobs:\n  test:\n    steps:\n      - run: ${command}\n`
  );
}

function ctx(over: Partial<ReviewLoopContext> = {}): ReviewLoopContext {
  return {
    ticketId: "301", acceptance: "#301 — do the thing", diffProvider: () => "diff --git ...",
    projectDir, scripts: {}, unrouted: true, ...over,
  };
}
const RESULT = (over: Partial<InvokeResult>): InvokeResult => ({ runId: "run-1", taskId: "t-1", status: "complete", ...over });

test("#301 deps.review: complete + valid result.json → parsed verdict", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ result: { verdict: "needs_fix", findings: [{ summary: "x", file: "a.ts", line: 1 }] } }));
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "needs_fix");
});

test("#301 deps.review: dispatches red-wide read-only", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  assert.equal(seen!.agentRole, "red-wide");
  assert.equal(seen!.readOnlyProject, true);
  assert.match(seen!.task, /REVIEWER/);
});

test("reviewer brief carries the hardening rubric (docs-vs-impl, per-path semantics, coverage gaps)", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  assert.match(seen!.task, /behavioral claim/i);        // docs/ADRs verified against impl
  assert.match(seen!.task, /multiple execution paths/i); // each path asserts the semantic
  assert.match(seen!.task, /lacks direct test coverage/i); // coverage-gap callout
  assert.match(seen!.task, /full operator path/i);      // config->resolver->dispatch->auth->doctor
  assert.match(seen!.task, /runnable contract/i);       // example config traced end-to-end
  assert.match(seen!.task, /accepted PRDs/i);           // reconcile design records, not just how-tos
});

test("#305 reviewer brief carries the adjacent-surface regression matrix", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  const t = seen!.task;
  // 1. stale closeout status language
  assert.match(t, /stale closeout/i);
  assert.match(t, /Deferred/);
  // 2. all supported log_format / runtime_kind, not just the named one
  assert.match(t, /every currently supported log_format/i);
  assert.match(t, /runtime_kind/i);
  // 3. recently-activated paths + the active codex path named
  assert.match(t, /recently-activated paths/i);
  assert.match(t, /codex-jsonl/i);
  // 4. stale non-prose: comments, seed text, fixtures, ADR/backlog
  assert.match(t, /fixtures/i);
  assert.match(t, /seed text/i);
  // 5. name the matrix + 6. explicit out-of-scope
  assert.match(t, /name the .*matrix/i);
  assert.match(t, /runtime kinds/i);
  assert.match(t, /auth modes/i);
  assert.match(t, /CLI modes/i);
  assert.match(t, /out of scope/i);
});

test("FG-417 reviewer brief carries the production-path consistency trace", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  const t = seen!.task;
  assert.match(t, /production-path consistency trace/i);
  assert.match(t, /surface, report, distinguish, gate, block, resume, continue, approve, review/i);
  assert.match(t, /supported-but-inert|inert for real inputs/i);
  assert.match(t, /collector \/ gatherer/i);
  assert.match(t, /stale-state-after-mutation/i);
  assert.match(t, /operator surface and machine output/i);
  assert.match(t, /real-input test/i);
});

test("FG-457 reviewer brief accepts the RED vocabulary and states its mapping", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  assert.match(seen!.task, /"fail" is mapped to needs_fix/i);
  assert.match(seen!.task, /"inconclusive" is mapped to blocked/i);
});

test("FG-462 reviewer brief scopes stale-closeout to already-closed tickets and protects the ticket under review", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  const t = seen!.task;
  // stale-closeout narrowed to already-closed (backlog/done/) tickets
  assert.match(t, /already-closed tickets only/i);
  assert.match(t, /backlog\/done\//);
  // ticket-under-review is expected to remain open; don't recommend close/move
  assert.match(t, /TICKET UNDER REVIEW IS EXPECTED TO BE OPEN/i);
  assert.match(t, /do NOT recommend `forge backlog close`/i);
  assert.match(t, /closeout guidance/i);
});

test("FG-462 fixer brief forbids editing backlog / running forge backlog close-move", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({}); });
  await deps.fix([{ summary: "off-by-one", file: "a.ts", line: 7 }]);
  assert.match(seen!.task, /Never edit `backlog\/` ticket files/i);
  assert.match(seen!.task, /forge backlog close.*move/i);
});

test("#301 deps.review: invoke status failed → ok false", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ status: "failed", error: "boom" }));
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /boom/);
});

test("#301 deps.review: complete but invalid result.json → ok false (never a silent pass)", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ result: { verdict: "lgtm" } }));
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /result\.json invalid/);
});

test("#301 deps.fix: dispatches engineer with the findings; complete → ok", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({}); });
  const r = await deps.fix([{ summary: "off-by-one", file: "a.ts", line: 7 }]);
  assert.equal(r.ok, true);
  assert.equal(seen!.agentRole, "engineer");
  assert.match(seen!.task, /FIXER/);
  assert.match(seen!.task, /a\.ts:7 — off-by-one/);
});

test("#301 deps.fix: invoke failed → ok false", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ status: "failed", error: "engineer crashed" }));
  const r = await deps.fix([{ summary: "x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.match((r as { error?: string }).error ?? "", /engineer crashed/);
});

test("#301 deps: threads one runId across dispatches (review creates it, fix reuses it)", async () => {
  const seen: (string | undefined)[] = [];
  const { deps, getRunId } = buildReviewLoopDeps(ctx(), async (a) => {
    seen.push(a.runId);
    return RESULT({ runId: "run-shared", result: { verdict: "needs_fix", findings: [{ summary: "x", unanchored: true }] } });
  });
  await deps.review({ ok: true, steps: [] }); // no runId yet → creates run-shared
  await deps.fix([{ summary: "x", unanchored: true }]); // reuses run-shared
  assert.deepEqual(seen, [undefined, "run-shared"]);
  assert.equal(getRunId(), "run-shared");
});

// ── FG-415: real git repo wiring tests ───────────────────────────────────────

function gitCtx(over: Partial<ReviewLoopContext> = {}): ReviewLoopContext {
  return {
    ticketId: "FG-415", acceptance: "FG-415 — test", diffProvider: () => "diff",
    projectDir, scripts: {}, unrouted: true, ...over,
  };
}

const COMPLETE = (over: Partial<InvokeResult> = {}): InvokeResult =>
  ({ runId: "run-1", taskId: "t-1", status: "complete", ...over });

test("#415 fix dep: fixer writes disallowed file → outOfScope returned, tree reverted clean", async () => {
  // The "fixer" writes a docs/ file into projectDir.
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    writeFileSync(join(projectDir, "docs", "foo.md"), "# bad\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const offending = (r as { offendingPaths?: string[] }).offendingPaths ?? [];
  assert.ok(offending.some((p) => p.startsWith("docs/")), `expected docs/ in offending: ${JSON.stringify(offending)}`);
  // Working tree must be clean after revert.
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `expected clean tree but got: ${status}`);
  // HEAD must be unchanged (initial commit).
  const log = gitExec(["log", "--oneline"], projectDir).trim();
  assert.ok(log.includes("initial commit"), `expected HEAD = initial commit but got: ${log}`);
});

test("#415 fix dep: fixer writes backlog/ file → outOfScope returned, tree reverted clean", async () => {
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    mkdirSync(join(projectDir, "backlog"), { recursive: true });
    writeFileSync(join(projectDir, "backlog", "story.md"), "story\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be clean after revert`);
});

test("#415 fix dep: fixer writes in-scope file, verification passes → committedSha returned, tree clean, commit in log", async () => {
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };
  // No scripts → verification ok:false (no steps) → ok:false with verificationFailed.
  // We need scripts to be green; inject a fake runner via scripts containing 'test'.
  // The easiest way: pass scripts:{} (no typecheck/test) which yields ok:false.
  // Actually we want verification to PASS — provide scripts with typecheck pointing to a passing cmd.
  // Instead, provide scripts: {} (no discoverable checks → ok:false). That would cause verificationFailed.
  // To get a pass, provide scripts that reference commands — but we can't easily inject the runner here.
  // Use scripts: {} on a project with no package.json → ok:false (no steps) → ok:false → verificationFailed path.
  // To exercise the happy path (verification passes), we need scripts to be empty so no checks run... wait,
  // runVerification({}) → ok:false (steps.length === 0). We need ok:true.
  // Pass a package.json with no typecheck/test scripts → same result.
  // The only way to pass is to have at least one script and have the runner return ok.
  // We can't inject the runner through buildReviewLoopDeps.
  // Instead, write a real passing shell script as the 'test' script in package.json.
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  const invokeFn2 = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" } }), invokeFn2);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, true);
  const sha = (r as { committedSha?: string }).committedSha;
  assert.ok(sha && sha.length > 0, "committedSha must be present");
  // Tree must be clean.
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be clean after commit`);
  // Commit must include FG-415 and round number.
  const log = gitExec(["log", "--oneline"], projectDir);
  assert.match(log, /FG-415/);
  assert.match(log, /round 1/);
});

test("#415 fix dep: fixer writes in-scope file, verification FAILS → verificationFailed returned, nothing committed, diff present", async () => {
  // No scripts → runVerification → ok:false, no steps → no steps means no findings.
  // We need scripts with a failing command.
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "false" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);
  const headBefore = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// unfixed\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "false" } }), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { verificationFailed?: boolean }).verificationFailed, true);
  // HEAD must not have moved.
  const headAfter = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(headAfter, headBefore, "HEAD must not change when verification fails");
  // Diff must still be present (not reverted).
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.ok(status.length > 0, "dirty diff must remain for inspection");
});

// ── FG-625: post-fixer verification evidence preservation + durable event ─────

type FixVerificationPayload = {
  ticketId: string;
  round: number;
  ok: boolean;
  readiness: unknown;
  steps: { name: string; ok: boolean; command: string | null; tier: string | null; output: string | null }[];
};

test("FG-625 fix dep: a failing post-fixer verification carries the WHOLE VerificationResult on the FixDispatch (not just dirty paths)", async () => {
  // typecheck passes, test fails — proves BOTH the failing step's evidence and
  // the passing step survive, and that the two are not conflated.
  writeFileSync(join(projectDir, "package.json"),
    JSON.stringify({ scripts: { typecheck: "true", test: "echo FG625_TAIL_MARKER && exit 1" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// unfixed\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(
    gitCtx({ scripts: { typecheck: "true", test: "echo FG625_TAIL_MARKER && exit 1" } }), invokeFn);
  const r = await deps.fix([{ summary: "x", unanchored: true }]);

  assert.equal(r.ok, false);
  assert.equal((r as { verificationFailed?: boolean }).verificationFailed, true);
  const verification = (r as { verification?: VerificationResult }).verification;
  assert.ok(verification, "the FixDispatch must carry the full post-fixer VerificationResult");
  const failed = verification!.steps.find((s) => !s.ok)!;
  assert.equal(failed.name, "test");
  assert.equal(failed.command, "npm run --silent test");
  assert.equal(failed.tier, "fast");
  assert.match(failed.output, /FG625_TAIL_MARKER/);
  // The passing step is present and marked ok — the two paths are distinguishable.
  assert.ok(verification!.steps.some((s) => s.name === "typecheck" && s.ok));
});

test("FG-625 event: a failing post-fixer verification emits review_loop.fix_verification_finished naming the failed step's command/tier/output + readiness", async () => {
  writeFileSync(join(projectDir, "package.json"),
    JSON.stringify({ scripts: { typecheck: "true", test: "echo FG625_EVENT_TAIL && exit 1" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// unfixed\n");
    return COMPLETE({ runId: "run-fg625-evt" });
  };
  const { deps } = buildReviewLoopDeps(
    gitCtx({ scripts: { typecheck: "true", test: "echo FG625_EVENT_TAIL && exit 1" } }), invokeFn);
  await deps.fix([{ summary: "x", unanchored: true }]);

  const events = eventsForRun("run-fg625-evt");
  const evt = events.find((e) => e.eventType === "review_loop.fix_verification_finished");
  assert.ok(evt, "the post-fixer path must emit its own durable, queryable verification event");
  const payload = evt!.payload as FixVerificationPayload;
  assert.equal(payload.ok, false);
  assert.equal(payload.ticketId, "FG-415");
  // readiness is the CONSULTED post-fixer preflight result (FG-625 Defect B landed
  // it). This project has no lockfile / dependency graph, so preparation is
  // `not_required` — a real readiness outcome, never simply null/absent from the
  // shape. (A refusal would return BEFORE runVerify, so no event fires at all;
  // that path is covered in fg566-review-loop-readiness.integration.test.ts.)
  assert.deepEqual(payload.readiness, { outcome: "not_required" });
  const failStep = payload.steps.find((s) => s.name === "test")!;
  assert.equal(failStep.ok, false);
  assert.equal(failStep.command, "npm run --silent test");
  assert.equal(failStep.tier, "fast");
  assert.match(failStep.output ?? "", /FG625_EVENT_TAIL/);
  // The passing step rides along but carries no output tail — event rows stay bounded.
  const passStep = payload.steps.find((s) => s.name === "typecheck")!;
  assert.equal(passStep.ok, true);
  assert.equal(passStep.output, null);
});

test("FG-625 e2e: a correct fixer diff verifies and commits with NO hand intervention; the post-fixer event records ok:true", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { typecheck: "true", test: "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE({ runId: "run-fg625-ok" });
  };
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { typecheck: "true", test: "true" } }), invokeFn);
  const r = await deps.fix([{ summary: "x", unanchored: true }]);

  assert.equal(r.ok, true);
  assert.ok((r as { committedSha?: string }).committedSha, "a correct diff commits without hand intervention");
  assert.equal(gitExec(["status", "--porcelain"], projectDir).trim(), "", "tree clean after commit");
  const evt = eventsForRun("run-fg625-ok").find((e) => e.eventType === "review_loop.fix_verification_finished");
  assert.ok(evt, "the post-fixer verification event fires on the happy path too");
  assert.equal((evt!.payload as FixVerificationPayload).ok, true);
});

test("FG-625 e2e: a deliberately BAD fixer diff fails verification, stays uncommitted, and reports the exact failing evidence", async () => {
  writeFileSync(join(projectDir, "package.json"),
    JSON.stringify({ scripts: { typecheck: "true", test: "echo FG625_BAD_DIFF_TAIL && exit 1" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);
  const headBefore = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// deliberately broken\n");
    return COMPLETE({ runId: "run-fg625-bad" });
  };
  const { deps } = buildReviewLoopDeps(
    gitCtx({ scripts: { typecheck: "true", test: "echo FG625_BAD_DIFF_TAIL && exit 1" } }), invokeFn);
  const r = await deps.fix([{ summary: "x", unanchored: true }]);

  assert.equal(r.ok, false);
  assert.equal((r as { verificationFailed?: boolean }).verificationFailed, true);
  // Uncommitted: HEAD did not move, the diff is left for inspection.
  assert.equal(gitExec(["rev-parse", "HEAD"], projectDir).trim(), headBefore, "HEAD must not move on a failed verification");
  assert.ok(gitExec(["status", "--porcelain"], projectDir).trim().length > 0, "the bad diff is left dirty for inspection");
  // The EXACT failing evidence is recorded — never just dirty paths.
  const failStep = (eventsForRun("run-fg625-bad")
    .find((e) => e.eventType === "review_loop.fix_verification_finished")!.payload as FixVerificationPayload)
    .steps.find((s) => s.name === "test")!;
  assert.equal(failStep.ok, false);
  assert.match(failStep.output ?? "", /FG625_BAD_DIFF_TAIL/);
});

test("FG-625 tier (round-entry): a dirty tree runs the EXTENDED tier — scriptsForVerification retains test:extended", async () => {
  // Default requiredHostGate + a test:extended script → deriveRequiredGateList
  // has >1 entry → extendedIsRequired, so scriptsForVerification KEEPS it.
  writeFileSync(join(projectDir, "package.json"),
    JSON.stringify({ scripts: { typecheck: "true", test: "true", "test:extended": "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);
  writeFileSync(join(projectDir, "dirty.txt"), "wip"); // dirty tree → round-entry local verification

  let seen: string[] = [];
  const spy = (scripts: Record<string, unknown>): VerificationResult => {
    seen = Object.keys(scripts);
    return { ok: true, steps: Object.keys(scripts).map((name) => ({ name, ok: true, output: "" })) };
  };
  const scripts = { typecheck: "true", test: "true", "test:extended": "true" };
  const { deps } = buildReviewLoopDeps(ctx({
    scripts, runVerification: spy,
    checkStatusProvider: () => { throw new Error("a dirty tree must not consult CI"); },
  }));
  await deps.verify();
  assert.ok(seen.includes("test:extended"),
    `round-entry dirty-tree tier must retain test:extended, got: ${JSON.stringify(seen)}`);
});

test("FG-625 tier (post-fixer): the post-fixer verification runs the FAST tier only — localFallbackScripts drops test:extended", async () => {
  writeFileSync(join(projectDir, "package.json"),
    JSON.stringify({ scripts: { typecheck: "true", test: "true", "test:extended": "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  let seen: string[] = [];
  const spy = (scripts: Record<string, unknown>): VerificationResult => {
    seen = Object.keys(scripts);
    return { ok: true, steps: Object.keys(scripts).map((name) => ({ name, ok: true, output: "" })) };
  };
  const scripts = { typecheck: "true", test: "true", "test:extended": "true" };
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts, runVerification: spy }), invokeFn);
  await deps.fix([{ summary: "x", unanchored: true }]);
  assert.ok(!seen.includes("test:extended"),
    `post-fixer tier must DROP test:extended (delegated to CI), got: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes("typecheck") && seen.includes("test"),
    `post-fixer path must still run the fast tier, got: ${JSON.stringify(seen)}`);
});

test("#415 CLI precondition: dirty tree → assertCleanWorkingTree refuses (exit 1, clean-tree message), dispatch never called", async () => {
  writeFileSync(join(projectDir, "dirty.ts"), "// dirty\n");

  let invokeCalled = false;
  const fakeInvoke = async (): Promise<InvokeResult> => { invokeCalled = true; return COMPLETE(); };

  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(String(args[0]));

  // assertCleanWorkingTree is the real code path registerReviewLoop calls.
  // Simulate the guard exactly as the CLI action does: if not clean, do not dispatch.
  const clean = assertCleanWorkingTree(projectDir);
  if (clean) {
    // Would only reach here on a clean tree; invoke the fixer to prove dispatch runs.
    const { deps } = buildReviewLoopDeps(gitCtx(), fakeInvoke);
    await deps.fix([{ summary: "x", unanchored: true }]);
  }

  console.error = origError;

  assert.equal(clean, false, "must refuse on dirty tree");
  assert.equal(process.exitCode, 1, "must set exitCode 1");
  assert.ok(
    errors.some((msg) => /clean working tree/i.test(msg)),
    `expected clean-tree message in console.error: ${JSON.stringify(errors)}`,
  );
  assert.equal(invokeCalled, false, "dispatch must NOT run on dirty tree");

  process.exitCode = prevExitCode;
});

// ── FG-415: additional disallowed-path coverage (finding 4) ──────────────────

test("#415 fix dep: fixer writes learnings/ file → outOfScope returned, tree reverted clean", async () => {
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    mkdirSync(join(projectDir, "learnings"), { recursive: true });
    writeFileSync(join(projectDir, "learnings", "note.md"), "# note\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const offending = (r as { offendingPaths?: string[] }).offendingPaths ?? [];
  assert.ok(offending.some((p) => p.startsWith("learnings/")), `expected learnings/ in offending: ${JSON.stringify(offending)}`);
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be clean after revert`);
  const log = gitExec(["log", "--oneline"], projectDir).trim();
  assert.ok(log.includes("initial commit"), `HEAD must be unchanged: ${log}`);
});

test("#415 fix dep: fixer writes top-level README* file → outOfScope returned, tree reverted clean", async () => {
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "README.md"), "# bad\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const offending = (r as { offendingPaths?: string[] }).offendingPaths ?? [];
  assert.ok(offending.some((p) => /^README/.test(p)), `expected README* in offending: ${JSON.stringify(offending)}`);
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be clean after revert`);
});

test("#415 fix dep: fixer writes non-ASCII path in docs/ → outOfScope (finding 1 non-ASCII bypass closed)", async () => {
  // Commit a file in docs/ so git reports the specific non-ASCII filename (not just ?? docs/).
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", ".gitkeep"), "");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add docs dir"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "docs", "café.md"), "# bad\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const offending = (r as { offendingPaths?: string[] }).offendingPaths ?? [];
  assert.ok(
    offending.some((p) => p.startsWith("docs/")),
    `expected docs/ in offending (non-ASCII path): ${JSON.stringify(offending)}`,
  );
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be clean after revert`);
});

test("#415-p2 fix dep: fixer writes top-level README-notes.md (not README.md) → outOfScope returned, tree reverted clean", async () => {
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "README-notes.md"), "# notes\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const offending = (r as { offendingPaths?: string[] }).offendingPaths ?? [];
  assert.ok(offending.some((p) => /^README/.test(p)), `expected README* in offending: ${JSON.stringify(offending)}`);
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be clean after revert`);
});

test("#415-p1 review dep calls diffProvider() each round rather than caching stale diff", async () => {
  let callCount = 0;
  const diffProvider = (): string => { callCount++; return `diff-call-${callCount}`; };
  const seenTasks: string[] = [];
  const { deps } = buildReviewLoopDeps(
    { ...ctx(), diffProvider },
    async (a) => { seenTasks.push(a.task); return RESULT({ result: { verdict: "pass" } }); },
  );
  await deps.review({ ok: true, steps: [] });
  await deps.review({ ok: true, steps: [] });
  assert.equal(callCount, 2, "diffProvider must be called once per review round");
  assert.match(seenTasks[0]!, /diff-call-1/, "round 1 task must contain round-1 diff");
  assert.match(seenTasks[1]!, /diff-call-2/, "round 2 task must contain round-2 diff, not the stale round-1 value");
});

test("#415-p1 diffProvider closure: startHead==HEAD → originalDiff; after fixer commit → originalDiff + fixer diff", () => {
  const originalDiff = "original-diff-content";
  const startHead = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // Build the same closure logic that registerReviewLoop creates.
  const diffProvider = (): string => {
    const head = gitExec(["rev-parse", "HEAD"], projectDir).trim();
    if (head === startHead) return originalDiff;
    const fixerCommits = gitExec(["diff", `${startHead}..${head}`], projectDir);
    return `${originalDiff}\n\n## Fixer commits since review start (${startHead.slice(0, 9)}..${head.slice(0, 9)})\n${fixerCommits}`;
  };

  // Before any fixer commit: must return the original diff unchanged.
  assert.equal(diffProvider(), originalDiff, "no fixer commits → must return originalDiff");

  // Simulate a fixer commit with a unique marker.
  writeFileSync(join(projectDir, "fix.ts"), "// UNIQUE_FIXER_MARKER_XYZ\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "fix(review-loop): address FG-415 review findings (round 1)"], projectDir);

  // After fixer commit: must contain originalDiff AND the fixer's change.
  const updated = diffProvider();
  assert.match(updated, /original-diff-content/, "updated diff must still contain originalDiff");
  assert.match(updated, /UNIQUE_FIXER_MARKER_XYZ/, "updated diff must contain the fixer's committed change");
  assert.match(updated, /Fixer commits since review start/, "must include the section header");
});

test("#415 fix dep: fixer renames disallowed→allowed path → outOfScope, old path caught (finding 2)", async () => {
  // Commit docs/old.md so it exists and can be renamed.
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "old.md"), "# old\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add docs/old.md"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    gitExec(["mv", "docs/old.md", "old.md"], projectDir);
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "rename", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const offending = (r as { offendingPaths?: string[] }).offendingPaths ?? [];
  assert.ok(
    offending.some((p) => p.startsWith("docs/")),
    `expected docs/ old-path in offending: ${JSON.stringify(offending)}`,
  );
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be clean after revert: ${status}`);
  // HEAD must still have docs/old.md — the rename was reverted.
  const log = gitExec(["log", "--oneline"], projectDir).trim();
  assert.ok(log.includes("add docs/old.md"), `HEAD must be unchanged: ${log}`);
});

// ── FG-474: deps.verify — evidence reuse ────────────────────────────────────
//
// buildReviewLoopDeps.verify consults findCoveringGateEvidence for HEAD before
// running typecheck+test. ctx().scripts is {} in these tests, so the FALLBACK
// path (real runVerification) is cheap and distinguishable: it always returns
// { ok: false, steps: [] } (no discoverable scripts) with no reusedEvidence —
// versus a reuse hit, which returns ok:true with reusedEvidence set and exactly
// one "reused" step. That contrast is the assertion.

test("FG-474 deps.verify: a passing host_verifications row at HEAD's exact sha+command reuses — ok:true, reusedEvidence set", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  insertHostVerification({
    ticketId: "301", projectDir, commitSha: headSha,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  const { deps } = buildReviewLoopDeps(ctx({ checkStatusProvider: () => { throw new Error("must not be called — host row already covers"); } }));
  const result = await deps.verify();
  assert.equal(result.ok, true);
  assert.match(result.reusedEvidence ?? "", /host_verifications row/);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.name, "reused");
  assert.equal(result.steps[0]!.ok, true);
});

test("FG-474 deps.verify: CI reuse — a stubbed green required CI check at HEAD's exact sha reuses — ok:true, reusedEvidence set", async () => {
  writeMatchingCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  const { deps } = buildReviewLoopDeps(ctx({
    checkStatusProvider: (opts) => (opts.sha === headSha ? { sha: headSha, state: "success", detailsUrl: "https://example.com/run/7" } : null),
  }));
  const result = await deps.verify();
  assert.equal(result.ok, true);
  assert.match(result.reusedEvidence ?? "", /CI check/);
  assert.match(result.reusedEvidence ?? "", /https:\/\/example\.com\/run\/7/);
});

test("FG-474 deps.verify: dirty worktree NEVER reuses, even with covering evidence for HEAD — falls back to a real run", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  insertHostVerification({
    ticketId: "301", projectDir, commitSha: headSha,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  writeFileSync(join(projectDir, "uncommitted.txt"), "wip");

  const { deps } = buildReviewLoopDeps(ctx({ checkStatusProvider: () => { throw new Error("must not be consulted on a dirty tree"); } }));
  const result = await deps.verify();
  assert.equal(result.reusedEvidence, undefined, "a dirty tree must never reuse, regardless of covering evidence");
  assert.equal(result.ok, false, "falls back to the real (no-discoverable-scripts) verification result");
  assert.equal(result.steps.length, 0);
});

test("FG-474 deps.verify: no covering evidence (no row, provider returns null) → falls back to runVerification unchanged", async () => {
  writeMatchingCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  let providerCalled = false;
  const { deps } = buildReviewLoopDeps(ctx({ checkStatusProvider: () => { providerCalled = true; return null; } }));
  const result = await deps.verify();
  assert.equal(providerCalled, true, "the provider must be consulted when no host row covers");
  assert.equal(result.reusedEvidence, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 0);
});

test("FG-474 deps.verify: a host_verifications row at a DIFFERENT sha does not reuse — falls back to a real run", async () => {
  writeMatchingCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  insertHostVerification({
    ticketId: "301", projectDir, commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  const { deps } = buildReviewLoopDeps(ctx({ checkStatusProvider: () => null }));
  const result = await deps.verify();
  assert.equal(result.reusedEvidence, undefined);
  assert.equal(result.ok, false);
});

// ── FG-500: deps.verify's reuse consults findCoveringGateEvidence, which is now
// derived-gate-list-aware — a project whose package.json defines test:extended
// needs a covering row for BOTH gates before reuse fires (unchanged for
// projects without that script — see the plain FG-474 reuse test above, whose
// ctx().scripts/projectDir carry no test:extended script).

test("FG-500 deps.verify: a project with test:extended — a fast-tier-only covering row does NOT reuse, falls back to a real run", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { "test:all": "exit 0", "test:extended": "exit 0" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json with test:extended"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  insertHostVerification({
    ticketId: "301", projectDir, commitSha: headSha,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  const { deps } = buildReviewLoopDeps(ctx({ checkStatusProvider: () => null }));
  const result = await deps.verify();
  assert.equal(result.reusedEvidence, undefined, "a fast-tier-only row must not reuse — the extended tier is also required");
});

test("FG-500 deps.verify: a project with test:extended — covering rows for BOTH gates reuse — ok:true, reusedEvidence set", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { "test:all": "exit 0", "test:extended": "exit 0" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json with test:extended"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  insertHostVerification({
    ticketId: "301", projectDir, commitSha: headSha,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  insertHostVerification({
    ticketId: "301", projectDir, commitSha: headSha,
    gateName: "npm run test:extended", command: "npm run test:extended", exitCode: 0, recordedAt: "2026-01-01T00:00:01Z",
  });
  const { deps } = buildReviewLoopDeps(ctx({ checkStatusProvider: () => { throw new Error("must not be called — both host rows already cover"); } }));
  const result = await deps.verify();
  assert.equal(result.ok, true);
  assert.match(result.reusedEvidence ?? "", /host_verifications row/);
});

test("FG-500 regression: deps.verify's no-reuse fallback never runs test:extended for a CUSTOM requiredHostGate project, even when the script exists — behaves exactly as before FG-500", async () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ requiredHostGate: "npm run verify" }));
  const scripts = { typecheck: "true", test: "true", "test:extended": "false" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add custom requiredHostGate + an (irrelevant) test:extended script"], projectDir);

  const { deps } = buildReviewLoopDeps(ctx({ scripts, checkStatusProvider: () => null }));
  const result = await deps.verify();
  assert.deepEqual(
    result.steps.map((s) => s.name), ["typecheck", "test"],
    "test:extended must be dropped from the fallback list — requiredHostGate is custom, not the project default"
  );
  assert.equal(result.ok, true, "a failing test:extended must not affect the result since it must never have run");
});

// ── FG-487: deps.verify emits review_loop.verification_started/_finished per
// round — previously the loop's verification phase (a local run, or the
// FG-501 CI-wait poll) left no durable trace between reviewer/fixer task rows.
// ctx({ runId: ... }) mirrors what the real CLI now sets eagerly (see
// registerReviewLoop's action) so deps.verify() has somewhere to log events.

test("FG-487 deps.verify: emits a start/finish pair sharing one attemptId, carrying round + ticketId", async () => {
  const { deps } = buildReviewLoopDeps(ctx({ runId: "run-487-a" }));
  await deps.verify();

  const events = eventsForRun("run-487-a");
  const started = events.filter((e) => e.eventType === "review_loop.verification_started");
  const finished = events.filter((e) => e.eventType === "review_loop.verification_finished");
  assert.equal(started.length, 1);
  assert.equal(finished.length, 1);

  const startPayload = started[0]!.payload as { attemptId: string; round: number; ticketId: string; mode: string };
  const finishPayload = finished[0]!.payload as { attemptId: string; round: number; ok: boolean };
  assert.equal(startPayload.attemptId, finishPayload.attemptId, "start and finish must share the same attemptId");
  assert.ok(startPayload.attemptId.length > 0);
  assert.equal(startPayload.round, 1);
  assert.equal(startPayload.ticketId, "301");
});

test("FG-487 deps.verify: EVERY round gets its own fresh attemptId — no reuse across rounds", async () => {
  const { deps } = buildReviewLoopDeps(ctx({ runId: "run-487-b" }));
  await deps.verify();
  await deps.verify();

  const events = eventsForRun("run-487-b");
  const started = events.filter((e) => e.eventType === "review_loop.verification_started");
  assert.equal(started.length, 2);
  const attemptIds = started.map((e) => (e.payload as { attemptId: string }).attemptId);
  assert.notEqual(attemptIds[0], attemptIds[1]);
  const rounds = started.map((e) => (e.payload as { round: number }).round);
  assert.deepEqual(rounds, [1, 2]);
});

test("FG-487 deps.verify: the start event fires without ever dispatching a reviewer/fixer — verification never invokes the agent dispatch fn", async () => {
  let invokeCalled = false;
  const { deps } = buildReviewLoopDeps(ctx({ runId: "run-487-c" }), async (a) => { invokeCalled = true; return RESULT({}); });
  await deps.verify();
  assert.equal(invokeCalled, false, "verify() must not dispatch a reviewer/fixer task — the run row + verification event exist independent of any task");
  const events = eventsForRun("run-487-c");
  assert.ok(events.some((e) => e.eventType === "review_loop.verification_started"));
});

test("FG-487 deps.verify: a dirty tree — mode 'local' (verifyWithReuse never consults CI on a dirty tree)", async () => {
  writeFileSync(join(projectDir, "dirty.txt"), "wip");
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-487-d",
    checkStatusProvider: () => { throw new Error("must not be consulted on a dirty tree"); },
  }));
  await deps.verify();
  const events = eventsForRun("run-487-d");
  const started = events.find((e) => e.eventType === "review_loop.verification_started")!;
  assert.equal((started.payload as { mode: string }).mode, "local");
});

test("FG-487 deps.verify: a dirty tree's finish event carries AC2's command + tier (what actually ran locally)", async () => {
  writeFileSync(join(projectDir, "dirty.txt"), "wip");
  const { deps } = buildReviewLoopDeps(ctx({
    runId: "run-487-d2",
    scripts: { typecheck: "true", test: "true" },
    runVerification: (scripts) => ({ ok: true, steps: Object.keys(scripts).map((name) => ({ name, ok: true, output: "" })) }),
  }));
  await deps.verify();
  const events = eventsForRun("run-487-d2");
  const finished = events.find((e) => e.eventType === "review_loop.verification_finished")!;
  const payload = finished.payload as { command: string | null; tier: string | null };
  assert.equal(payload.command, "npm run typecheck && npm run test");
  assert.equal(payload.tier, "fast");
});

test("FG-487 deps.verify: a clean tree — mode 'ci_wait' (the CI-consuming path), even when it resolves via instant reuse", async () => {
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  insertHostVerification({
    ticketId: "301", projectDir, commitSha: headSha,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  const { deps } = buildReviewLoopDeps(ctx({ runId: "run-487-e" }));
  await deps.verify();

  const events = eventsForRun("run-487-e");
  const started = events.find((e) => e.eventType === "review_loop.verification_started")!;
  assert.equal((started.payload as { mode: string }).mode, "ci_wait");
  const finished = events.find((e) => e.eventType === "review_loop.verification_finished")!;
  assert.ok((finished.payload as { reusedEvidence?: string }).reusedEvidence, "finish event carries the reuse outcome");
  assert.equal(
    (finished.payload as { checkContexts: string[] | null }).checkContexts, null,
    "a host_verifications-row reuse has no CI check contexts to report — never invented",
  );
});

test("FG-487 deps.verify: CI unavailable → local fallback — finish event's ciOutcome.kind is 'local_fallback'", async () => {
  const { deps } = buildReviewLoopDeps(ctx({ runId: "run-487-f", checkStatusProvider: () => null }));
  const result = await deps.verify();
  assert.equal(result.ciOutcome?.kind, "local_fallback");

  const events = eventsForRun("run-487-f");
  const finished = events.find((e) => e.eventType === "review_loop.verification_finished")!;
  const payload = finished.payload as { ciOutcome: { kind: string } | null };
  assert.equal(payload.ciOutcome?.kind, "local_fallback");
});

// ── FG-487: the CLI's eager run creation, end-to-end through registerReviewLoop
// itself — a run row (and run.created) must exist BEFORE round 1's
// verification, not lazily on first reviewer/fixer dispatch. projectDir has no
// package.json, so verification fails with zero discoverable checks (zero
// findings) and the loop stops on round 1 WITHOUT EVER dispatching a task —
// the exact edge case where the eagerly-created run would otherwise be left
// dangling "active" forever (reconcile.ts's crash-recovery sweep requires at
// least one task row before it will complete a run).

test("FG-487: forge review-loop creates its run row eagerly at loop entry — before any task exists — and closes it out even when the loop stops with zero task dispatches", async () => {
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-487-review-loop-eager-run.md"),
    "---\nid: FG-487\ntype: story\nstatus: active\ntitle: eager run creation\n---\n\nBody.\n",
  );
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add FG-487 ticket"], projectDir);

  const program = new Command();
  let dispatched = false;
  registerReviewLoop(program, async () => { dispatched = true; return RESULT({}); });
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  await program.parseAsync(
    ["review-loop", "FG-487", "--since", sinceSha, "--project", projectDir, "--unrouted"],
    { from: "user" },
  );

  assert.equal(dispatched, false, "no package.json in projectDir means zero discoverable checks — the loop stops on round 1 before any dispatch");
  assert.equal(process.exitCode, 1, "a loop stopping on verification_failed must set exitCode 1");
  process.exitCode = prevExitCode;

  const runs = listRuns();
  assert.equal(runs.length, 1, "the run row must exist even though no task was ever dispatched");
  const run = runs[0]!;
  assert.equal(run.status, "complete", "an eagerly-created run with zero task dispatches must still be closed out, not left dangling active");

  const events = eventsForRun(run.id);
  const types = events.map((e) => e.eventType);
  // FG-679 interleaves review_loop.ci_observed between the start and finish
  // events (this projectDir has no CI workflow at all, so the observer durably
  // records the `unavailable` observation it actually made). The invariant this
  // test guards is unchanged and asserted directly instead of positionally:
  // run.created first, the verification pair in order, and no task-shaped event
  // in a run that never dispatched a task.
  assert.equal(types[0], "run.created");
  const startedAt = types.indexOf("review_loop.verification_started");
  const finishedAt = types.indexOf("review_loop.verification_finished");
  assert.equal(startedAt, 1, "the verification start event must immediately follow run.created");
  assert.ok(finishedAt > startedAt, "the verification finish event must follow its start");
  assert.deepEqual(types.filter((t) => t.startsWith("task.")), [], "no task-shaped event may appear in a run that dispatched no task");
});

test("FG-487: an exception escaping the loop finalizes the eager run — no permanent zero-task active run", async () => {
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-487-review-loop-throw.md"),
    "---\nid: FG-487\ntype: story\nstatus: active\ntitle: eager run finalize on throw\n---\n\nBody.\n",
  );
  // A passing test script so verification succeeds and the loop reaches the
  // reviewer dispatch — whose injected invokeFn THROWS (not a clean !complete
  // return), the exception path the clean zero-dispatch test above cannot reach.
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add FG-487 ticket + scripts"], projectDir);

  const program = new Command();
  registerReviewLoop(program, async () => { throw new Error("boom: reviewer dispatch exploded"); });
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  await assert.rejects(
    () => program.parseAsync(
      ["review-loop", "FG-487", "--since", sinceSha, "--project", projectDir, "--unrouted"],
      { from: "user" },
    ),
    /boom: reviewer dispatch exploded/,
  );
  process.exitCode = prevExitCode;

  const runs = listRuns();
  assert.equal(runs.length, 1, "the eagerly-created run must exist");
  assert.equal(
    runs[0]!.status,
    "complete",
    "an escaped exception must finalize the eager run, not leak a zero-task 'active' row invisible to every sweep",
  );
  const completed = eventsForRun(runs[0]!.id).find((e) => e.eventType === "run.completed");
  assert.ok(completed, "run.completed must be logged on the exception path");
});

// ── FG-497: the REAL invoke() dispatch, through the review-loop reviewer path ──
//
// Every test above injects a FAKE invokeFn that returns a canned InvokeResult —
// it never calls invoke() at all. That approximates the wiring (task text
// shape, runId threading) but never exercises reviewTask()'s packet
// construction feeding the REAL composeSystemPrompt / buildDockerArgs (incl.
// the MAX_SINGLE_ARG_BYTES guard) / stdin+package.md payload — i.e. never
// exercises the actual FG-497 acceptance path (an oversized review-loop
// packet dispatched through `forge review-loop`'s reviewer). These tests wrap
// the REAL invoke() — only its docker-exec boundary is stubbed — so the full
// reviewTask() -> invoke() -> buildDockerArgs() chain runs end-to-end.

// A runtime stub mirroring claude-oauth's real prompt-delivery shape (system
// prompt via an argv flag, task package via stdin) — the same split
// invoke.integration.test.ts's FG-497 test uses, reproduced here so this file
// doesn't depend on that file's private helper.
function setupArgvBoundedReviewRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const p = join(fhome, "runtimes", "claude-argv-bounded-rl.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `
name: claude-argv-bounded-rl
description: test stub mirroring claude-oauth's argv+stdin prompt delivery (review-loop FG-497 tests)
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["--append-system-prompt", "\${SYSTEM_PROMPT}"]
  stdin: "\${TASK_PACKAGE_MARKDOWN}"
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Wraps the REAL invoke() (not a fake) so buildReviewLoopDeps's `review` dep
// drives the actual dispatch path; only the docker-exec boundary is stubbed.
function realInvokeThroughDocker(dockerExec: DockerExecFn): (a: InvokeArgs) => Promise<InvokeResult> {
  return (a) => invoke({ ...a, runtimeName: "claude-argv-bounded-rl", dockerExec });
}

test("FG-497 review-loop integration: reviewer dispatch with a >131072-byte diff survives the REAL invoke()+reviewTask() path — argv/env stay bounded, full packet rides stdin/package.md", async () => {
  setupArgvBoundedReviewRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // A synthetic diff comfortably larger than Linux's MAX_ARG_STRLEN
  // (131072 bytes) on its own — mirrors a real oversized review-loop packet.
  // Pre-FG-497, embedding this into the composed system prompt (argv) would
  // have breached MAX_ARG_STRLEN and died with E2BIG before the agent started.
  const bigDiff = "+// line of synthetic diff content\n".repeat(6000) + "\nFG-497-RL-BIG-DIFF-MARKER\n";
  assert.ok(Buffer.byteLength(bigDiff, "utf8") > 131_072, "fixture diff must itself exceed MAX_ARG_STRLEN");

  let capturedArgs: string[] = [];
  let capturedStdin: string | undefined;
  let capturedDir = "";
  const inspectExec: DockerExecFn = async ({ args, stdin, stdoutPath, stderrPath }) => {
    capturedArgs = args;
    capturedStdin = stdin;
    capturedDir = dirname(stdoutPath);
    if (!existsSync(capturedDir)) mkdirSync(capturedDir, { recursive: true });
    writeFileSync(join(capturedDir, "result.json"), JSON.stringify({ verdict: "pass", findings: [] }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const { deps } = buildReviewLoopDeps(
    ctx({ ticketId: "FG-497", acceptance: "FG-497 — bound argv/env for review-loop packets", diffProvider: () => bigDiff }),
    realInvokeThroughDocker(inspectExec),
  );

  const r = await deps.review({ ok: true, steps: [{ name: "typecheck", ok: true, output: "" }] });

  assert.equal(r.ok, true, `expected the oversized reviewer dispatch to succeed, got: ${JSON.stringify(r)}`);
  assert.equal((r as { verdict: string }).verdict, "pass");

  // Every docker argv string buildDockerArgs produced (incl. every "-e"
  // env pair) must stay under Linux's real MAX_ARG_STRLEN. The guard's own
  // threshold (MAX_SINGLE_ARG_BYTES=120000) is tighter still, so this also
  // confirms the fail-fast guard never tripped on a legitimate dispatch.
  const MAX_ARG_STRLEN = 131_072;
  for (const [i, a] of capturedArgs.entries()) {
    assert.ok(
      Buffer.byteLength(a, "utf8") < MAX_ARG_STRLEN,
      `argv[${i}] is ${Buffer.byteLength(a, "utf8")} bytes — must stay under MAX_ARG_STRLEN`,
    );
  }

  // The FULL reviewer packet — acceptance, the oversized diff, and the
  // rubric — must reach the agent via stdin (unbounded) and land on disk in
  // package.md, verbatim, not truncated or dropped.
  assert.ok(capturedStdin, "stdin payload must be present");
  assert.match(capturedStdin!, /FG-497-RL-BIG-DIFF-MARKER/);
  assert.ok(capturedStdin!.includes(bigDiff), "stdin must carry the full diff verbatim");
  assert.match(capturedStdin!, /REVIEWER/);
  assert.match(capturedStdin!, /FG-497 — bound argv\/env for review-loop packets/);

  const packageMd = readFileSync(join(capturedDir, "package.md"), "utf8");
  assert.ok(packageMd.includes(bigDiff), "package.md on disk must carry the full diff verbatim");
});

test("FG-497 review-loop integration: normal-size reviewer packet is unchanged through the REAL invoke() path — acceptance + diff + verification block all reach the reviewer", async () => {
  setupArgvBoundedReviewRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const smallDiff = "diff --git a/src.ts b/src.ts\n+// small fixture diff\n";
  let capturedStdin: string | undefined;
  let capturedDir = "";
  const inspectExec: DockerExecFn = async ({ stdin, stdoutPath, stderrPath }) => {
    capturedStdin = stdin;
    capturedDir = dirname(stdoutPath);
    if (!existsSync(capturedDir)) mkdirSync(capturedDir, { recursive: true });
    writeFileSync(join(capturedDir, "result.json"), JSON.stringify({ verdict: "needs_fix", findings: [{ summary: "x", file: "a.ts", line: 1 }] }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const { deps } = buildReviewLoopDeps(
    ctx({ ticketId: "FG-497-small", acceptance: "FG-497-small — normal-size packet", diffProvider: () => smallDiff }),
    realInvokeThroughDocker(inspectExec),
  );

  const verification: VerificationResult = { ok: true, steps: [{ name: "test", ok: true, output: "5 passed" }] };
  const r = await deps.review(verification);

  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "needs_fix");

  assert.ok(capturedStdin, "stdin payload must be present");
  assert.match(capturedStdin!, /FG-497-small — normal-size packet/, "acceptance must reach the packet");
  assert.ok(capturedStdin!.includes(smallDiff), "diff must reach the packet verbatim");
  assert.match(capturedStdin!, /- test: passed/, "the deterministic-verification block must reach the packet");

  const packageMd = readFileSync(join(capturedDir, "package.md"), "utf8");
  assert.ok(packageMd.includes(smallDiff), "package.md on disk must carry the diff");
  assert.match(packageMd, /- test: passed/, "package.md on disk must carry the verification block");
});

// ── FG-493 fence, exercised against the REAL dispatch (not a canned result) ──
//
// review-loop.test.ts's FG-493 tests pin the ENGINE's tolerance for red-wide's
// OWN well-formed vocabulary (a schema-valid "fail" with native findings) —
// that a well-formed-but-red-flavored verdict is NOT misread as
// reviewer_failed. These tests pin the opposite edge: a genuinely broken
// reviewer dispatch (no result.json at all, or unparseable JSON) — produced by
// the REAL invoke() docker-exec path, not a hand-built ParsedVerdict — must
// still surface as reviewer_failed, never a silent pass or skip.

test("FG-493 fence (real dispatch): an ABSENT result.json from the REAL invoke() path fails deps.review and stops runReviewLoop as reviewer_failed", async () => {
  setupArgvBoundedReviewRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Agent process exits 0 but never wrote result.json at all — a genuinely
  // absent reviewer output.
  const noResultExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0; // no result.json written
  };

  const { deps } = buildReviewLoopDeps(ctx({ ticketId: "FG-493-absent" }), realInvokeThroughDocker(noResultExec));
  const r = await deps.review({ ok: true, steps: [] });

  assert.equal(r.ok, false, "an absent result.json must never be treated as a valid/passing verdict");
  assert.match((r as { error: string }).error, /reviewer dispatch failed|no_result_json/);

  // Drive the real (failing) review dep through the actual loop engine to pin
  // the FG-493 fence end-to-end: a genuine dispatch failure stops the loop as
  // reviewer_failed — never advances as if the reviewer passed or was skipped,
  // and never reaches the fixer.
  const outcome = await runReviewLoop(
    { maxRounds: 1, ticketId: "FG-493-absent" },
    {
      verify: () => ({ ok: true, steps: [] }),
      review: deps.review,
      fix: () => { throw new Error("fix must never be dispatched on reviewer_failed"); },
    },
  );
  assert.equal(outcome.stopReason, "reviewer_failed");
  assert.equal(outcome.closeable, false);
});

test("FG-493 fence (real dispatch): an UNPARSEABLE result.json from the REAL invoke() path fails deps.review and stops runReviewLoop as reviewer_failed", async () => {
  setupArgvBoundedReviewRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const malformedExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "not json at all");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const { deps } = buildReviewLoopDeps(ctx({ ticketId: "FG-493-malformed" }), realInvokeThroughDocker(malformedExec));
  const r = await deps.review({ ok: true, steps: [] });

  assert.equal(r.ok, false, "an unparseable result.json must never be treated as a valid/passing verdict");
  assert.match((r as { error: string }).error, /reviewer dispatch failed|malformed/);

  const outcome = await runReviewLoop(
    { maxRounds: 1, ticketId: "FG-493-malformed" },
    {
      verify: () => ({ ok: true, steps: [] }),
      review: deps.review,
      fix: () => { throw new Error("fix must never be dispatched on reviewer_failed"); },
    },
  );
  assert.equal(outcome.stopReason, "reviewer_failed");
  assert.equal(outcome.closeable, false);
});

// ── FG-501 AC7: verifyWithReuse — the CI-consuming path end-to-end ──────────
//
// buildReviewLoopDeps.verify (verifyWithReuse) probes the required CI gate's
// STATUS via probeCiGateStatus/findCoveringGateEvidence before ever running
// local verification. These tests drive it through its injectable knobs
// (checkStatusProvider, sleep, ciPollMs/ciWaitTimeoutMs, runVerification) —
// no real CI, subprocess, or wall-clock delay — asserting: pending CI is
// waited on and reused once green; a failing check stops the loop directly;
// an unavailable/unqueryable CI setup (or a timed-out wait) falls back to a
// local run whose command set excludes test:extended unless --local-extended
// asks for it; already-green CI reuses immediately with no wait.

function verifyCtx(over: Partial<ReviewLoopContext> = {}): ReviewLoopContext {
  return {
    ticketId: "FG-501", acceptance: "FG-501 — review-loop waits for in-flight CI",
    diffProvider: () => "diff --git a/x b/x", projectDir, scripts: {}, unrouted: true, ...over,
  };
}

function makeRunnerSpy(): { calls: string[][]; fn: NonNullable<ReviewLoopContext["runVerification"]> } {
  const calls: string[][] = [];
  const fn: NonNullable<ReviewLoopContext["runVerification"]> = (scripts) => {
    calls.push(Object.keys(scripts));
    return { ok: true, steps: Object.keys(scripts).map((name) => ({ name, ok: true, output: "" })) };
  };
  return { calls, fn };
}

function noopSleep(): { calls: number[]; fn: NonNullable<ReviewLoopContext["sleep"]> } {
  const calls: number[] = [];
  const fn: NonNullable<ReviewLoopContext["sleep"]> = async (ms) => { calls.push(ms); };
  return { calls, fn };
}

// AC2 fields (checkContexts / command / tier) are event/telemetry detail, not
// part of VerificationResult's declared contract (see review-loop.ts's local
// VerificationResultWithDetail) — cast to read them off deps.verify()'s result.
type ResultDetail = { checkContexts?: string[] | null; command?: string | null; tier?: string | null };
function detail(result: unknown): ResultDetail {
  return result as ResultDetail;
}

test("FG-501 verifyWithReuse: CI pending then pending then success -> waits, reuses, no local run, reusedEvidence names check+url, renders in the report", async () => {
  writeMatchingCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  let calls = 0;
  const checkStatusProvider = () => {
    calls++;
    if (calls <= 3) return { sha: headSha, state: "pending" as const };
    return { sha: headSha, state: "success" as const, detailsUrl: "https://example.com/ci/run-9" };
  };
  const runner = makeRunnerSpy();
  const sleep = noopSleep();

  const { deps } = buildReviewLoopDeps(verifyCtx({
    checkStatusProvider, runVerification: runner.fn, sleep: sleep.fn,
    ciPollMs: 1000, ciWaitTimeoutMs: 60_000,
  }));

  const result = await deps.verify();
  assert.equal(result.ok, true);
  assert.equal(runner.calls.length, 0, "local verification must never run when CI eventually reuses");
  assert.ok(sleep.calls.length >= 1, "must have polled at least once while pending");
  assert.match(result.reusedEvidence ?? "", new RegExp(REQUIRED_CI_CHECK_CONTEXT.replace(/\//g, "\\/")));
  assert.match(result.reusedEvidence ?? "", /https:\/\/example\.com\/ci\/run-9/);
  assert.equal(result.ciOutcome?.kind, "reused_after_wait");
  assert.deepEqual(detail(result).checkContexts, [REQUIRED_CI_CHECK_CONTEXT], "AC2: the finish event must carry the required CI check contexts consulted for reuse");

  // Renders in the report: drive a canned round through the real loop + note renderer.
  const outcome = await runReviewLoop(
    { maxRounds: 1, ticketId: "FG-501" },
    { verify: () => result, review: async () => ({ ok: true, verdict: "pass", findings: [] }), fix: () => { throw new Error("must not fix"); } },
  );
  const note = renderReviewLoopNote(
    {
      ticketId: "FG-501", maxRounds: 1, range: { mode: "since", diffRange: "a..b", shas: ["a"], spansUnmatched: false },
      reviewedTipSha: "deadbeef", remoteTrust: { kind: "trusted", remoteRef: "origin/main" },
    },
    outcome,
  );
  assert.match(note, /waited for in-flight CI, then reused it \(no local run\)/);
  assert.match(note, /https:\/\/example\.com\/ci\/run-9/);
});

test("FG-501 verifyWithReuse: CI pending then failed -> verification fails citing the failing check context+url, no local run", async () => {
  writeMatchingCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  let calls = 0;
  const checkStatusProvider = () => {
    calls++;
    if (calls <= 2) return { sha: headSha, state: "pending" as const };
    return { sha: headSha, state: "failure" as const, detailsUrl: "https://example.com/ci/run-fail" };
  };
  const runner = makeRunnerSpy();
  const sleep = noopSleep();

  const { deps } = buildReviewLoopDeps(verifyCtx({
    checkStatusProvider, runVerification: runner.fn, sleep: sleep.fn,
    ciPollMs: 1000, ciWaitTimeoutMs: 60_000,
  }));

  const result = await deps.verify();
  assert.equal(result.ok, false);
  assert.equal(runner.calls.length, 0, "a failing required CI check must never trigger a local run");
  assert.equal(result.ciOutcome?.kind, "ci_failed");
  assert.equal((result.ciOutcome as { context: string }).context, REQUIRED_CI_CHECK_CONTEXT);
  assert.equal((result.ciOutcome as { url?: string }).url, "https://example.com/ci/run-fail");
  assert.deepEqual(detail(result).checkContexts, [REQUIRED_CI_CHECK_CONTEXT], "AC2: the finish event must carry the failing check's context");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.ok, false);
  assert.match(result.steps[0]!.output, /https:\/\/example\.com\/ci\/run-fail/);
});

test("FG-501 verifyWithReuse: CI unavailable -> local fallback runs, citing the reason, and EXCLUDES test:extended by default", async () => {
  writeMatchingCiWorkflow();
  const scripts = { typecheck: "true", test: "true", "test:extended": "false" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml + test:extended script"], projectDir);

  const runner = makeRunnerSpy();
  const { deps } = buildReviewLoopDeps(verifyCtx({
    scripts, checkStatusProvider: () => null, runVerification: runner.fn,
  }));

  const result = await deps.verify();
  assert.equal(runner.calls.length, 1, "must fall back to exactly one local run");
  assert.ok(!runner.calls[0]!.includes("test:extended"), `default local fallback must exclude test:extended, got: ${JSON.stringify(runner.calls[0])}`);
  assert.ok(runner.calls[0]!.includes("typecheck") && runner.calls[0]!.includes("test"));
  assert.equal(result.ciOutcome?.kind, "local_fallback");
  const outcome = result.ciOutcome as { reason: string; extendedDelegatedToCi: boolean };
  assert.match(outcome.reason, /no CI status available/);
  assert.equal(outcome.extendedDelegatedToCi, true);
  assert.equal(detail(result).command, "npm run typecheck && npm run test", "AC2: the finish event must carry the local fallback's command");
  assert.equal(detail(result).tier, "fast", "AC2: the finish event must carry the local fallback's tier");
});

test("FG-501 verifyWithReuse: --local-extended restores test:extended in the CI-unavailable local fallback", async () => {
  writeMatchingCiWorkflow();
  const scripts = { typecheck: "true", test: "true", "test:extended": "false" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml + test:extended script"], projectDir);

  const runner = makeRunnerSpy();
  const { deps } = buildReviewLoopDeps(verifyCtx({
    scripts, checkStatusProvider: () => null, runVerification: runner.fn, localExtended: true,
  }));

  const result = await deps.verify();
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0]!.includes("test:extended"), `--local-extended must restore test:extended, got: ${JSON.stringify(runner.calls[0])}`);
  const outcome = result.ciOutcome as { extendedDelegatedToCi: boolean };
  assert.equal(outcome.extendedDelegatedToCi, false);
  assert.equal(detail(result).tier, "extended", "AC2: --local-extended's finish event must report tier 'extended'");
});

test("FG-501 verifyWithReuse: CI wait times out -> local fallback, citing the timeout reason", async () => {
  writeMatchingCiWorkflow();
  const scripts = { typecheck: "true", test: "true" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const checkStatusProvider = () => ({ sha: headSha, state: "pending" as const });
  const runner = makeRunnerSpy();
  const sleep = noopSleep();

  const { deps } = buildReviewLoopDeps(verifyCtx({
    scripts, checkStatusProvider, runVerification: runner.fn, sleep: sleep.fn,
    ciPollMs: 1000, ciWaitTimeoutMs: 0,
  }));

  const result = await deps.verify();
  assert.equal(runner.calls.length, 1, "a timed-out wait must fall back to exactly one local run");
  assert.equal(sleep.calls.length, 0, "must time out on the first pending check, before ever sleeping");
  assert.equal(result.ciOutcome?.kind, "local_fallback");
  assert.match((result.ciOutcome as { reason: string }).reason, /CI wait timed out/);
});

test("FG-501 verifyWithReuse: CI already green -> immediate reuse, no waiting, no local run", async () => {
  writeMatchingCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const checkStatusProvider = () => ({ sha: headSha, state: "success" as const, detailsUrl: "https://example.com/ci/run-immediate" });
  const runner = makeRunnerSpy();
  const sleep = noopSleep();

  const { deps } = buildReviewLoopDeps(verifyCtx({ checkStatusProvider, runVerification: runner.fn, sleep: sleep.fn }));

  const result = await deps.verify();
  assert.equal(result.ok, true);
  assert.equal(runner.calls.length, 0, "already-green CI must never trigger a local run");
  assert.equal(sleep.calls.length, 0, "already-green CI must never wait");
  assert.equal(result.ciOutcome, undefined, "immediate reuse carries no ciOutcome — that's reserved for the wait/fallback paths");
  assert.match(result.reusedEvidence ?? "", /https:\/\/example\.com\/ci\/run-immediate/);
  assert.deepEqual(detail(result).checkContexts, [REQUIRED_CI_CHECK_CONTEXT], "AC2: an immediate CI-sourced reuse must still report the required check contexts");
});

test("FG-501 verifyWithReuse: CI reports all-green but the covering-evidence re-check still misses (race) -> local fallback citing the race-condition reason, never invents evidence", async () => {
  writeMatchingCiWorkflow();
  const scripts = { typecheck: "true", test: "true" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // tryReuse() (findCoveringGateEvidence) and probe() (probeCiGateStatus) share
  // the identical preconditions and consult the SAME provider — the only honest
  // way to force "probe says green, tryReuse still misses" is a provider whose
  // answer itself changes between calls (e.g. the check-runs API lagging behind
  // the status rollup it's read from). Call 1 is the initial tryReuse() (must
  // miss so we reach probe()), call 2 is probe() (must be green), call 3 is the
  // post-success tryReuse() re-check (must miss again to trigger the race path).
  let calls = 0;
  const checkStatusProvider = () => {
    calls++;
    if (calls === 2) return { sha: headSha, state: "success" as const };
    return { sha: headSha, state: "pending" as const };
  };

  const runner = makeRunnerSpy();
  const { deps } = buildReviewLoopDeps(verifyCtx({ scripts, checkStatusProvider, runVerification: runner.fn }));

  const result = await deps.verify();
  assert.equal(calls, 3, "expects the initial tryReuse, one probe, and the post-success tryReuse re-check");
  assert.equal(result.ciOutcome?.kind, "local_fallback");
  const outcome = result.ciOutcome as { reason: string };
  assert.equal(outcome.reason, "CI reported all required checks green but covering evidence could not be confirmed");
  assert.equal(runner.calls.length, 1, "the race must still fall back to exactly one local run, never invent evidence");
});

// ── FG-501 AC6: operator-facing surface ─────────────────────────────────────
//
// The AC7 block above pins verifyWithReuse's RETURNED data (ok/steps/
// ciOutcome/reusedEvidence). None of it pins what an operator actually SEES
// while the loop runs: the console.log progress line printed on every pending
// poll, the explicit reason line printed when CI is unavailable (distinguishing
// "the provider has no status" from "we waited and timed out"), the failing-
// check line, and the --dry-run header's description of the wait behavior.
// These tests capture console.log and assert on the printed operator text.

function writeTwoJobCiWorkflow(command = "npm run test:all"): void {
  mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(projectDir, ".github", "workflows", "ci.yml"),
    `name: CI\njobs:\n  test:\n    steps:\n      - run: ${command}\n  test-extended:\n    steps:\n      - run: echo extended\n`,
  );
}

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

test("FG-501 AC6: pending progress line names the short sha, each pending check's context (+url when present), and elapsed/poll/timeout", async () => {
  writeTwoJobCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add two-job ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // "pending" until the one poll (sleep) happens, then flips to "success" —
  // NOT a call-count-based round: tryReuse() (findCoveringGateEvidence) shares
  // this same provider and short-circuits after the FIRST job it sees is
  // non-success, so it consumes a call before the wait loop's own probe() ever
  // runs. A call-count/2 "round" scheme drifts out of sync with that extra
  // call; flipping on the sleep callback instead survives it. "CI / test"
  // carries a details URL, "CI / test-extended" does not, so the line must
  // render both shapes.
  let phase: "pending" | "success" = "pending";
  const checkStatusProvider = ({ checkContext }: { checkContext: string }) => {
    if (phase === "pending") {
      return checkContext === "CI / test"
        ? { sha: headSha, state: "pending" as const, detailsUrl: "https://example.com/ci/run-test" }
        : { sha: headSha, state: "pending" as const };
    }
    return { sha: headSha, state: "success" as const, detailsUrl: "https://example.com/ci/final" };
  };

  // A deterministic `now`: startedAt=0, then +5000ms per subsequent call, so
  // the single pending iteration reports a fixed elapsed=5s with no real delay.
  let tick = 0;
  const now = () => { const v = tick; tick += 5000; return v; };
  const sleepCalls: number[] = [];
  const sleep = { fn: async (ms: number) => { sleepCalls.push(ms); phase = "success"; } };
  const lines = captureConsoleLog();

  try {
    const { deps } = buildReviewLoopDeps(verifyCtx({
      checkStatusProvider, sleep: sleep.fn, now,
      ciPollMs: 30_000, ciWaitTimeoutMs: 600_000,
    }));

    const result = await deps.verify();
    assert.equal(result.ok, true);
    assert.equal(result.ciOutcome?.kind, "reused_after_wait");
    assert.equal(sleepCalls.length, 1, "expected exactly one poll before the check went green");

    const pendingLine = lines.find((l) => l.includes("CI pending for"));
    assert.ok(pendingLine, `expected a CI-pending progress line, got: ${JSON.stringify(lines)}`);
    assert.equal(
      pendingLine,
      `review-loop: CI pending for ${headSha.slice(0, 9)} — waiting on: CI / test (https://example.com/ci/run-test), ` +
      `CI / test-extended (elapsed 5s, polling every 30s, timeout 600s)`,
    );
  } finally {
    mock.restoreAll();
  }
});

test("FG-501 AC6: CI-unavailable fallback prints an explicit reason line — provider has no status for the check", async () => {
  writeMatchingCiWorkflow();
  const scripts = { typecheck: "true", test: "true" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add ci.yml + scripts"], projectDir);

  const runner = makeRunnerSpy();
  const lines = captureConsoleLog();

  try {
    const { deps } = buildReviewLoopDeps(verifyCtx({
      scripts, checkStatusProvider: () => null, runVerification: runner.fn,
    }));

    const result = await deps.verify();
    assert.equal(result.ciOutcome?.kind, "local_fallback");

    const line = lines.find((l) => l.startsWith("review-loop: CI unavailable:"));
    assert.ok(line, `expected a CI-unavailable fallback line, got: ${JSON.stringify(lines)}`);
    assert.match(line!, /no CI status available for check "CI \/ test" at sha/);
    assert.match(line!, /falling back to local verification\.$/);
  } finally {
    mock.restoreAll();
  }
});

test("FG-501 AC6: CI-unavailable fallback prints an explicit reason line — wait timed out (distinct wording from provider-unavailable)", async () => {
  writeMatchingCiWorkflow();
  const scripts = { typecheck: "true", test: "true" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add ci.yml + scripts"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const checkStatusProvider = () => ({ sha: headSha, state: "pending" as const });
  const runner = makeRunnerSpy();
  const sleep = noopSleep();
  const lines = captureConsoleLog();

  try {
    const { deps } = buildReviewLoopDeps(verifyCtx({
      scripts, checkStatusProvider, runVerification: runner.fn, sleep: sleep.fn,
      ciPollMs: 1000, ciWaitTimeoutMs: 0,
    }));

    const result = await deps.verify();
    assert.equal(result.ciOutcome?.kind, "local_fallback");

    const line = lines.find((l) => l.startsWith("review-loop: CI unavailable:"));
    assert.ok(line, `expected a CI-unavailable fallback line, got: ${JSON.stringify(lines)}`);
    assert.match(line!, /CI wait timed out after 0s — still pending: CI \/ test/);
    assert.match(line!, /falling back to local verification\.$/);
  } finally {
    mock.restoreAll();
  }
});

test("FG-501 AC6: a failing required CI check prints the context+sha+url with '(no local run)'", async () => {
  writeMatchingCiWorkflow();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add matching ci.yml"], projectDir);
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const checkStatusProvider = () => ({ sha: headSha, state: "failure" as const, detailsUrl: "https://example.com/ci/run-fail" });
  const lines = captureConsoleLog();

  try {
    const { deps } = buildReviewLoopDeps(verifyCtx({ checkStatusProvider }));

    const result = await deps.verify();
    assert.equal(result.ok, false);
    assert.equal(result.ciOutcome?.kind, "ci_failed");

    const line = lines.find((l) => l.includes("failed for"));
    assert.ok(line, `expected the failing-check line, got: ${JSON.stringify(lines)}`);
    assert.equal(
      line,
      `review-loop: required CI check "${REQUIRED_CI_CHECK_CONTEXT}" failed for ${headSha.slice(0, 9)} — https://example.com/ci/run-fail (no local run)`,
    );
  } finally {
    mock.restoreAll();
  }
});

test("FG-501 AC6: --dry-run header describes the CI-wait behavior (reuse-first, wait/poll/timeout, failing-check stop, local-fallback tier)", async () => {
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-501-review-loop-waits-for-ci.md"),
    "---\nid: FG-501\ntype: story\nstatus: active\ntitle: review-loop waits for in-flight CI\n---\n\nBody.\n",
  );
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const lines = captureConsoleLog();
  try {
    const program = new Command();
    registerReviewLoop(program, async () => { throw new Error("must not dispatch on --dry-run"); });
    await program.parseAsync(
      ["review-loop", "FG-501", "--since", headSha, "--project", projectDir, "--unrouted", "--dry-run"],
      { from: "user" },
    );

    const printed = lines.join("\n");
    assert.match(printed, /reuse a passing host row or green CI first/);
    assert.match(printed, /wait\/poll for them/);
    assert.match(printed, /FORGE_CI_WAIT_TIMEOUT_SECONDS\/FORGE_CI_POLL_SECONDS/);
    assert.match(printed, /a failing CI check stops the loop directly/);
    assert.match(printed, /unavailable\/unqueryable CI setup falls back to a local run/);
    assert.match(printed, /--local-extended/);
    assert.match(printed, /\(dry run — no dispatch\)/);
  } finally {
    mock.restoreAll();
  }
});

// ── FG-501 AC5 (reopen): the fixer's post-change pre-commit verification ─────
//
// A needs_fix round is part of the normal review-loop path, so it must follow
// the same tier policy as the CI-unavailable fallback: fast tier (typecheck +
// test) by default with test:extended delegated to CI (the fixer's commit gets
// pushed and CI runs it as a required check), --local-extended restoring the
// full tier — and it must honor the runVerification injection seam.

test("FG-501 fix dep: in-scope fixer change verifies via the injected runner, fast tier by default — test:extended excluded", async () => {
  const scripts = { typecheck: "true", test: "true", "test:extended": "false" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add tiered package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };
  const runner = makeRunnerSpy();
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts, runVerification: runner.fn }), invokeFn);

  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, true);
  assert.ok((r as { committedSha?: string }).committedSha, "verified fix must be committed");
  assert.equal(runner.calls.length, 1, "fixer verification must go through the injected runner");
  assert.ok(!runner.calls[0]!.includes("test:extended"), `fixer verification must exclude test:extended by default, got: ${JSON.stringify(runner.calls[0])}`);
  assert.ok(runner.calls[0]!.includes("typecheck") && runner.calls[0]!.includes("test"));
});

test("FG-501 fix dep: --local-extended restores test:extended in the fixer's pre-commit verification", async () => {
  const scripts = { typecheck: "true", test: "true", "test:extended": "false" };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add tiered package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };
  const runner = makeRunnerSpy();
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts, runVerification: runner.fn, localExtended: true }), invokeFn);

  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, true);
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0]!.includes("test:extended"), `--local-extended must restore test:extended in fixer verification, got: ${JSON.stringify(runner.calls[0])}`);
});

// ── FG-502: fixer scope guard — selective revert of disallowed-path changes ──
//
// Replaces the old whole-round `git reset --hard HEAD && git clean -fd`: a
// disallowed path (backlog/ticket-closeout — always; docs/learnings/README —
// only when NOT already touched by the loop-start reviewed range) is reverted
// on its own, while in-scope changes from the SAME round survive and commit
// normally. Only when NOTHING survives the revert does the round still fall
// back to the pre-FG-502 full-abort outOfScope shape.

test("FG-502 fix dep: fixer touches ONE disallowed docs/ path (not in range) + one in-scope file — disallowed reverted, in-scope committed, revertedPaths surfaced, NOT a full outOfScope abort", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    writeFileSync(join(projectDir, "docs", "out-of-range.md"), "# not in range\n");
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" } }), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);

  assert.equal(r.ok, true, `expected the round to succeed with the in-scope change committed, got: ${JSON.stringify(r)}`);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, undefined, "must NOT be a full-abort outOfScope — an in-scope change survives the revert");
  const committedSha = (r as { committedSha?: string }).committedSha;
  assert.ok(committedSha, "the in-scope change must be committed");

  const reverted = (r as { revertedPaths?: { path: string; reason: string }[] }).revertedPaths ?? [];
  assert.ok(reverted.some((p) => p.path === "docs/out-of-range.md"), `expected docs/out-of-range.md in revertedPaths: ${JSON.stringify(reverted)}`);

  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", "tree must be clean after commit");
  assert.equal(existsSync(join(projectDir, "docs", "out-of-range.md")), false, "the disallowed doc must have been reverted, not committed");

  const committedFiles = gitExec(["show", "--name-only", "--format=", committedSha!], projectDir).trim().split("\n");
  assert.ok(committedFiles.includes("src.ts"), `expected src.ts in the commit, got: ${JSON.stringify(committedFiles)}`);
  assert.ok(!committedFiles.includes("docs/out-of-range.md"), "the reverted doc must not appear in the commit");
});

test("FG-502 fix dep: a docs/ path already touched by the loop-start reviewed range is in-scope — NOT reverted, committed normally", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    writeFileSync(join(projectDir, "docs", "in-range.md"), "# in range\n");
    return COMPLETE();
  };
  const inRangeDocsPaths = new Set(["docs/in-range.md"]);
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" }, inRangeDocsPaths }), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);

  assert.equal(r.ok, true);
  assert.equal((r as { revertedPaths?: unknown[] }).revertedPaths, undefined, "an in-range docs path must not be reverted");
  const committedSha = (r as { committedSha?: string }).committedSha;
  assert.ok(committedSha);
  assert.equal(existsSync(join(projectDir, "docs", "in-range.md")), true, "the in-range docs change must survive, committed");
  const committedFiles = gitExec(["show", "--name-only", "--format=", committedSha!], projectDir).trim().split("\n");
  assert.ok(committedFiles.includes("docs/in-range.md"));
});

test("FG-502 fix dep: backlog/ path is unconditionally disallowed even if (erroneously) present in inRangeDocsPaths — the two classes are never merged", async () => {
  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    mkdirSync(join(projectDir, "backlog"), { recursive: true });
    writeFileSync(join(projectDir, "backlog", "story.md"), "story\n");
    return COMPLETE();
  };
  const inRangeDocsPaths = new Set(["backlog/story.md"]); // malformed input — must never matter
  const { deps } = buildReviewLoopDeps(gitCtx({ inRangeDocsPaths }), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const offending = (r as { offendingPaths?: string[] }).offendingPaths ?? [];
  assert.ok(offending.includes("backlog/story.md"));
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", "tree must be clean after the full-abort revert");
});

test("FG-502 fix dep: backlog/ violation MIXED with a surviving in-scope change is reverted PATH-LEVEL — the backlog path is removed, the in-scope change survives and commits, and the round record surfaces the reverted path as guidance (operator-decided, ticket Non-Goals)", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    mkdirSync(join(projectDir, "backlog"), { recursive: true });
    writeFileSync(join(projectDir, "backlog", "story.md"), "story\n");
    // A NEW untracked in-scope file, distinct from the beforeEach-committed
    // src.ts — proves the guard reverts only the disallowed path, not the
    // whole round, when a genuinely novel legitimate change co-occurs.
    writeFileSync(join(projectDir, "in-scope.ts"), "// fixed\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" } }), invokeFn);
  const r = await deps.fix([{ summary: "fix x", unanchored: true }]);

  assert.equal(r.ok, true, `the in-scope change must survive and commit despite the mixed backlog violation, got: ${JSON.stringify(r)}`);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, undefined, "must NOT be a full-abort outOfScope — an in-scope change survives the revert");
  const committedSha = (r as { committedSha?: string }).committedSha;
  assert.ok(committedSha, "the in-scope change must be committed");

  const reverted = (r as { revertedPaths?: { path: string; reason: string }[] }).revertedPaths ?? [];
  assert.ok(reverted.some((p) => p.path === "backlog/story.md"), `expected backlog/story.md in revertedPaths: ${JSON.stringify(reverted)}`);

  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", "tree must be clean after commit");
  assert.equal(existsSync(join(projectDir, "backlog", "story.md")), false, "the backlog path must have been reverted, not committed");
  assert.equal(existsSync(join(projectDir, "in-scope.ts")), true, "the in-scope change survives — path-level enforcement, not a whole-round abort");

  const committedFiles = gitExec(["show", "--name-only", "--format=", committedSha!], projectDir).trim().split("\n");
  assert.ok(committedFiles.includes("in-scope.ts"), `expected in-scope.ts in the commit, got: ${JSON.stringify(committedFiles)}`);
  assert.ok(!committedFiles.includes("backlog/story.md"), "the reverted backlog path must not appear in the commit");
});

test("FG-502 fix dep: fixer renames a docs/ path OUT to an in-scope path — the whole rename is reverted as one unit (old path restored, new path removed), never left half-applied", async () => {
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "old.md"), "# old\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add docs/old.md"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    gitExec(["mv", "docs/old.md", "old.md"], projectDir);
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx(), invokeFn);
  const r = await deps.fix([{ summary: "rename", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.equal((r as { outOfScope?: boolean }).outOfScope, true);
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", `tree must be fully clean — neither the old nor the new path left behind: ${status}`);
  assert.equal(existsSync(join(projectDir, "docs", "old.md")), true, "old path must be restored");
  assert.equal(existsSync(join(projectDir, "old.md")), false, "new path must be removed, not left as an orphan");
});

test("FG-502 fix dep: fixer DELETES a tracked disallowed docs/ path (status D, out-of-range) — reverted via checkout HEAD, in-scope change survives and commits, round record surfaces the reverted path", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "deleteme.md"), "# will be deleted\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json + docs/deleteme.md"], projectDir);

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    rmSync(join(projectDir, "docs", "deleteme.md"));
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };
  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" } }), invokeFn);

  // Drive through the full loop engine (not just deps.fix directly) so the
  // assertion also pins that the RoundRecord surfaces the reverted D-status
  // path — the plan's per-status-letter coverage requirement (M/A/D/R/C).
  let round = 0;
  const outcome = await runReviewLoop(
    { maxRounds: 2, ticketId: "FG-502" },
    {
      verify: () => ({ ok: true, steps: [] }),
      review: async () => {
        round++;
        return round === 1
          ? { ok: true, verdict: "needs_fix" as const, findings: [{ summary: "fix x", unanchored: true }] }
          : { ok: true, verdict: "pass" as const, findings: [] };
      },
      fix: deps.fix,
    },
  );

  assert.equal(outcome.stopReason, "passed");
  assert.equal(outcome.closeable, true);
  const round1 = outcome.rounds[0]!;
  assert.ok(round1.committedSha, "round 1 must have committed the in-scope src.ts change");

  const reverted = round1.revertedPaths ?? [];
  assert.ok(
    reverted.some((p) => p.path === "docs/deleteme.md"),
    `round record must surface the reverted D-status path: ${JSON.stringify(reverted)}`,
  );

  assert.equal(existsSync(join(projectDir, "docs", "deleteme.md")), true, "the deleted disallowed doc must have been restored via checkout HEAD, not left deleted");
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.equal(status, "", "tree must be clean after commit");

  const committedFiles = gitExec(["show", "--name-only", "--format=", round1.committedSha!], projectDir).trim().split("\n");
  assert.ok(committedFiles.includes("src.ts"), `expected src.ts in the commit, got: ${JSON.stringify(committedFiles)}`);
  assert.ok(!committedFiles.includes("docs/deleteme.md"), "the restored doc must not appear as a change in the fixer's commit");
});

// ── FG-502 finding 2: FAILURE-INJECTION — the per-path revert loop must never
// let a mid-loop throw (a git lock/permissions/disk failure) escape fix() or
// leave the round in a mixed reverted/not-reverted state with no record. An
// injected GitRunner spy (ctx.gitRunner) fails ONE specific revert call —
// never shells out to a real broken git — and the round must fail SAFE: no
// commit is created, the disallowed path never lands in any commit, and the
// round record names the failed path.

test("FG-502 fix dep FAILURE INJECTION: injected gitRunner fails the revert of ONE tracked disallowed path — round fails safe: no commit is created, the disallowed path never lands in any commit, and the round record names the failed path", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "protected.md"), "# protected\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json + docs/protected.md"], projectDir);
  const headBefore = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    // Disallowed path modified (tracked at HEAD -> the `checkout HEAD --` revert branch).
    writeFileSync(join(projectDir, "docs", "protected.md"), "# tampered\n");
    // In-scope change from the same round.
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };

  const gitRunner: GitRunner = (args) => {
    if (args[0] === "checkout" && args.includes("docs/protected.md")) {
      throw new Error("simulated git failure (disk full)");
    }
    return gitExec(args, projectDir);
  };

  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" }, gitRunner }), invokeFn);

  const outcome = await runReviewLoop(
    { maxRounds: 2, ticketId: "FG-502" },
    {
      verify: () => ({ ok: true, steps: [] }),
      review: async () => ({ ok: true, verdict: "needs_fix", findings: [{ summary: "fix x", unanchored: true }] }),
      fix: deps.fix,
    },
  );

  // (c) the round record names the failed path.
  assert.equal(outcome.stopReason, "scope_guard_revert_failed");
  assert.equal(outcome.closeable, false);
  const round1 = outcome.rounds[0]!;
  assert.ok(
    round1.scopeGuardFailedPaths?.includes("docs/protected.md"),
    `round record must name the failed path: ${JSON.stringify(round1.scopeGuardFailedPaths)}`,
  );

  // (a) no commit created for this round.
  const headAfter = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(headAfter, headBefore, "no commit must be created when a revert cannot be verified clean");

  // (b) the disallowed path never lands in any commit — it's left visibly
  // dirty in the working tree, never silently swept up by the blanket
  // `git add -A` that follows a (falsely) trusted revert.
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.match(status, /docs\/protected\.md/, `the failed-revert path must remain visibly dirty: ${status}`);
});

// ── FG-502 round 2 red-backend re-check: exception containment must cover
// EVERY git call in the fix() closure, not just the per-path revert loop —
// a throw from the scoped verification re-check, the final 'remaining' check,
// or add/commit/rev-parse must never escape fix() uncaught (that crashes the
// loop with a generic 'exception' stopReason and no recorded round state).

test("FG-502 round2 FAILURE INJECTION: injected gitRunner throws from the scoped verification re-check ('status') — round fails safe with recorded context, no uncaught exception", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "protected.md"), "# protected\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json + docs/protected.md"], projectDir);
  const headBefore = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    // Disallowed path modified (drives toRevert non-empty so the scoped
    // re-verify status call actually runs) + an in-scope change.
    writeFileSync(join(projectDir, "docs", "protected.md"), "# tampered\n");
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };

  // Only the SCOPED re-check (status ... -- <paths>) throws — the initial
  // scan and the final 'remaining' check (neither carries "--") run for real.
  const gitRunner: GitRunner = (args) => {
    if (args[0] === "status" && args.includes("--")) {
      throw new Error("simulated git failure (scoped status re-check)");
    }
    return gitExec(args, projectDir);
  };

  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" }, gitRunner }), invokeFn);

  const outcome = await runReviewLoop(
    { maxRounds: 2, ticketId: "FG-502" },
    {
      verify: () => ({ ok: true, steps: [] }),
      review: async () => ({ ok: true, verdict: "needs_fix", findings: [{ summary: "fix x", unanchored: true }] }),
      fix: deps.fix,
    },
  );

  // Loop stopped cleanly — no uncaught exception propagated out of runReviewLoop.
  assert.equal(outcome.stopReason, "scope_guard_revert_failed");
  assert.equal(outcome.closeable, false);
  const round1 = outcome.rounds[0]!;
  assert.match(round1.fixError ?? "", /scoped revert re-verification/, `round record must name which call failed: ${round1.fixError}`);
  assert.match(round1.fixError ?? "", /simulated git failure/);
  assert.equal(round1.committedSha, undefined, "no false commit claim");

  const headAfter = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(headAfter, headBefore, "HEAD must be unchanged — no commit was ever created");
});

test("FG-502 round2 FAILURE INJECTION: injected gitRunner throws from 'commit' — round fails safe with recorded context, no false commit claim", async () => {
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add package.json"], projectDir);
  const headBefore = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const invokeFn = async (_a: InvokeArgs): Promise<InvokeResult> => {
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };

  const gitRunner: GitRunner = (args) => {
    if (args[0] === "commit") {
      throw new Error("simulated git failure (commit)");
    }
    return gitExec(args, projectDir);
  };

  const { deps } = buildReviewLoopDeps(gitCtx({ scripts: { test: "true" }, gitRunner }), invokeFn);

  const outcome = await runReviewLoop(
    { maxRounds: 2, ticketId: "FG-502" },
    {
      verify: () => ({ ok: true, steps: [] }),
      review: async () => ({ ok: true, verdict: "needs_fix", findings: [{ summary: "fix x", unanchored: true }] }),
      fix: deps.fix,
    },
  );

  assert.equal(outcome.stopReason, "scope_guard_revert_failed");
  assert.equal(outcome.closeable, false);
  const round1 = outcome.rounds[0]!;
  assert.equal(round1.committedSha, undefined, "no commit must be claimed when 'commit' itself throws");
  assert.match(round1.fixError ?? "", /add\/commit\/rev-parse/, `round record must name which call failed: ${round1.fixError}`);
  assert.match(round1.fixError ?? "", /simulated git failure/);

  // HEAD never moved — the throw happened during commit, before any new commit existed.
  const headAfter = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(headAfter, headBefore, "HEAD must be unchanged — commit never actually landed");

  // `git add -A` ran for real before the injected throw, staging src.ts — but
  // since commit never completed, the change is left dirty/staged, never
  // silently discarded or falsely reported as committed.
  const status = gitExec(["status", "--porcelain"], projectDir).trim();
  assert.match(status, /src\.ts/, "the in-scope change is left staged/dirty, not silently discarded");
});

// ── FG-502: computeInRangeDocsPaths — the in-range docs/learnings/README set ─

test("FG-502 computeInRangeDocsPaths: only docs/learnings/README paths actually touched by the reviewed range are in-range", async () => {
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "old.md"), "old\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add docs/old.md (baseline)"], projectDir);
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  writeFileSync(join(projectDir, "docs", "new.md"), "new\n");
  writeFileSync(join(projectDir, "src.ts"), "// change\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "FG-502 add docs/new.md + src.ts"], projectDir);

  const range = resolveCommitRange("FG-502", { since: sinceSha, git: (a) => gitExec(a, projectDir) });
  const inRange = computeInRangeDocsPaths(range, projectDir);
  assert.equal(inRange.has("docs/new.md"), true);
  assert.equal(inRange.has("docs/old.md"), false, "a docs path NOT touched by the reviewed range is not in-range");
  assert.equal(inRange.has("src.ts"), false, "non-docs/learnings/README paths are never included");
});

test("FG-502 computeInRangeDocsPaths: a spansUnmatched range diffs the PRECISE shas, not the full span — an unrelated commit's docs change is excluded", async () => {
  writeFileSync(join(projectDir, "marker.txt"), "m\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-777) baseline"], projectDir);

  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "unrelated.md"), "unrelated\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "unrelated change touching docs/unrelated.md"], projectDir);

  writeFileSync(join(projectDir, "docs", "related.md"), "related\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-777) add docs/related.md"], projectDir);

  const range = resolveCommitRange("FG-777", { git: (a) => gitExec(a, projectDir) });
  assert.equal(range.spansUnmatched, true, "the span includes the unrelated middle commit");
  const inRange = computeInRangeDocsPaths(range, projectDir);
  assert.equal(inRange.has("docs/related.md"), true);
  assert.equal(inRange.has("docs/unrelated.md"), false, "the unrelated commit's docs change must be excluded — precise shas, not the full span");
});

// ── FG-502 + FG-514: reviewed-tip-vs-remote trust check ──────────────────────
//
// resolveRemoteRef's candidate order is `@{u}` (the branch's configured
// upstream) FIRST, `origin/HEAD` only as a fallback when no upstream is
// configured — `origin/HEAD` virtually always resolves (it tracks the default
// branch), so checking it first would compare a pre-merge feature-branch tip
// against main, where it can never be equal.
//
// FG-514: trust is EQUALITY with the remote head, and the winning candidate is
// refreshed by a real bounded `git fetch` before the comparison. So these
// tests need a real remote — a bare repo on a local path (never the network).
// origin's refs are then driven by pushing to that bare repo, which is exactly
// what the fetch will read back.

/** Bare repos backing `origin` for the trust tests — outside projectDir (the
 *  CLI e2e tests assert a clean working tree). Cleaned up in afterEach. */
let extraTempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  extraTempDirs.push(dir);
  return dir;
}

/** Register a real bare repo as `origin`. Returns its path. */
function addBareOrigin(dir: string): string {
  const bare = mkTempDir("forge-rl-remote-");
  gitExec(["init", "--bare", "-q"], bare);
  gitExec(["remote", "add", "origin", bare], dir);
  return bare;
}

/** Point origin's default branch (`origin/HEAD` → `origin/main`) at `sha`, for
 *  real: push it to the bare repo, then seed the local tracking ref + symbolic
 *  HEAD the way a clone would have them. No upstream is configured, so
 *  resolveRemoteRef falls through to the origin/HEAD candidate. */
function setOriginHead(dir: string, sha: string): void {
  const bare = originPath(dir) ?? addBareOrigin(dir);
  gitExec(["push", "--quiet", "--force", bare, `${sha}:refs/heads/main`], dir);
  gitExec(["update-ref", "refs/remotes/origin/main", sha], dir);
  gitExec(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], dir);
}

/** Configure the current branch's upstream (`@{u}`) and push `sha` to it —
 *  simulates "this branch has been pushed and tracks its own remote ref",
 *  independent of origin/HEAD (the default branch's tracking ref). */
function setUpstream(dir: string, sha: string): void {
  const bare = originPath(dir) ?? addBareOrigin(dir);
  const branch = gitExec(["symbolic-ref", "--short", "HEAD"], dir).trim();
  gitExec(["push", "--quiet", "--force", bare, `${sha}:refs/heads/${branch}`], dir);
  gitExec(["update-ref", `refs/remotes/origin/${branch}`, sha], dir);
  gitExec(["config", `branch.${branch}.remote`, "origin"], dir);
  gitExec(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], dir);
}

function originPath(dir: string): string | undefined {
  try {
    return gitExec(["config", "remote.origin.url"], dir).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Advance a branch in the bare origin repo BEHIND the local repo's back — the
 *  local tracking ref stays stale until resolveReviewedTipTrust's bounded fetch
 *  refreshes it. This is what "the remote moved on after review" looks like. */
function pushNewCommitToOrigin(bare: string, branch: string, subject: string): void {
  const clone = mkTempDir("forge-rl-clone-");
  gitExec(["clone", "-q", bare, clone], tmpdir());
  gitExec(["config", "user.email", "t@t.com"], clone);
  gitExec(["config", "user.name", "Test"], clone);
  gitExec(["checkout", "-q", branch], clone);
  writeFileSync(join(clone, `${subject.replace(/\W+/g, "-")}.txt`), `${subject}\n`);
  gitExec(["add", "."], clone);
  gitExec(["commit", "-q", "-m", subject], clone);
  gitExec(["push", "--quiet", "origin", branch], clone);
}

test("FG-502 resolveReviewedTipTrust: with an upstream configured, trust uses @{u} — a tip pushed to the feature branch is trusted even though it is not on origin/HEAD (main)", async () => {
  // origin/HEAD (main) is pinned at the pre-feature baseline — a pre-merge
  // feature-branch tip is never equal to it.
  const baseSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  setOriginHead(projectDir, baseSha);

  writeFileSync(join(projectDir, "feature.txt"), "feature\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "feature commit"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // The feature branch has been pushed — its upstream tracks the pushed tip.
  setUpstream(projectDir, tipSha);

  const trust = resolveReviewedTipTrust(projectDir, tipSha);
  assert.equal(trust.kind, "trusted", `expected @{u} to be preferred over origin/HEAD: ${JSON.stringify(trust)}`);
  assert.equal((trust as { remoteRef: string }).remoteRef, "@{u}");
});

test("FG-514 resolveReviewedTipTrust: reviewed tip EQUALS the remote head → trusted, closeable allowed", async () => {
  writeFileSync(join(projectDir, "a.txt"), "a\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "commit A"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  setOriginHead(projectDir, tipSha); // no upstream configured — the fallback candidate

  const trust = resolveReviewedTipTrust(projectDir, tipSha);
  assert.equal(trust.kind, "trusted", JSON.stringify(trust));
  assert.equal((trust as { remoteRef: string }).remoteRef, "origin/HEAD");
});

test("FG-514 resolveReviewedTipTrust: upstream STRICTLY AHEAD of the reviewed tip → remote_ahead, closeable withheld, unreviewed commits named", async () => {
  const bare = addBareOrigin(projectDir);
  writeFileSync(join(projectDir, "reviewed.txt"), "reviewed\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "the reviewed commit"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  setUpstream(projectDir, tipSha);
  const branch = gitExec(["symbolic-ref", "--short", "HEAD"], projectDir).trim();

  // Someone else pushes past the reviewed tip. The LOCAL tracking ref still
  // says @{u} === tipSha; only the bounded fetch inside resolveReviewedTipTrust
  // can see the truth — so this also pins AC3 (real remote head, not the cache).
  pushNewCommitToOrigin(bare, branch, "unreviewed commit the reviewer never saw");
  assert.equal(
    gitExec(["rev-parse", "@{u}"], projectDir).trim(), tipSha,
    "precondition: the cached tracking ref must still be stale before the trust call",
  );

  const trust = resolveReviewedTipTrust(projectDir, tipSha);
  assert.equal(trust.kind, "remote_ahead", `a strictly-ahead remote must never be trusted: ${JSON.stringify(trust)}`);
  const t = trust as { remoteRef: string; unreviewedCommits: { sha: string; subject: string }[] };
  assert.equal(t.remoteRef, "@{u}");
  assert.equal(t.unreviewedCommits.length, 1);
  assert.match(t.unreviewedCommits[0]!.subject, /unreviewed commit the reviewer never saw/);
});

test("FG-502 resolveReviewedTipTrust: no upstream configured, falls back to origin/HEAD — reviewed tip is ahead of the remote head → local_only, names the local-only commit(s) + next action data", async () => {
  const baseSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  setOriginHead(projectDir, baseSha); // origin is behind, at the pre-fixer sha; no upstream configured

  writeFileSync(join(projectDir, "local-only.txt"), "local\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "local-only commit not on origin"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const trust = resolveReviewedTipTrust(projectDir, tipSha);
  assert.equal(trust.kind, "local_only");
  const t = trust as { remoteRef: string; localCommits: { sha: string; subject: string }[] };
  assert.equal(t.remoteRef, "origin/HEAD");
  assert.equal(t.localCommits.length, 1);
  assert.match(t.localCommits[0]!.subject, /local-only commit not on origin/);
});

test("FG-502 resolveReviewedTipTrust: no resolvable remote-tracking ref at all → remote_unavailable, never silently trusted", async () => {
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  // projectDir (freshly init'd in beforeEach) has no origin remote and no upstream configured.
  const trust = resolveReviewedTipTrust(projectDir, tipSha);
  assert.equal(trust.kind, "remote_unavailable");
  assert.equal((trust as { remoteRef?: string }).remoteRef, undefined);
});

test("FG-514 resolveReviewedTipTrust: the bounded fetch fails but a cached ref exists → remote_unavailable carrying the failure reason, NOT trusted (fail closed)", async () => {
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  // A cached tracking ref that agrees with the tip — a stale-cache comparison
  // would say "trusted". origin points at a path that does not exist, so the
  // bounded fetch fails without touching the network.
  gitExec(["remote", "add", "origin", join(tmpdir(), "forge-rl-nonexistent-remote-9b821d")], projectDir);
  gitExec(["update-ref", "refs/remotes/origin/main", tipSha], projectDir);
  gitExec(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], projectDir);

  const trust = resolveReviewedTipTrust(projectDir, tipSha);
  assert.equal(trust.kind, "remote_unavailable", `a failed fetch must never fall back to the stale cache: ${JSON.stringify(trust)}`);
  const t = trust as { remoteRef?: string; fetchError?: string };
  assert.equal(t.remoteRef, "origin/HEAD");
  assert.ok(t.fetchError && t.fetchError.length > 0, "the fetch-failure reason must be carried for the operator message");
});

test("FG-514: the trust check's fetch is bounded to a single ref — never `fetch --all`, never tags", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "review-loop.ts"), "utf8");
  // Scoped to actual git-argv elements (quoted), not prose — this file's own
  // doc comments legitimately describe the bounded fetch.
  const argv = src.match(/"fetch",[^\]]*\]/g) ?? [];
  assert.equal(argv.length, 1, "exactly one `git fetch` invocation belongs in review-loop.ts (the trust check's)");
  assert.match(argv[0]!, /"--quiet"/);
  assert.match(argv[0]!, /"--no-tags"/);
  assert.match(argv[0]!, /target\.refspec/, "the fetch must name a single explicit refspec, not the remote's default refspec");
  assert.doesNotMatch(src, /"--all"/, "the trust check must never fetch all refs");
});

// ── FG-502: end-to-end through registerReviewLoop — the closeable print is
// gated on remote reachability, not just outcome.closeable ───────────────────

function writeFg502Ticket(): void {
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-502-reviewed-tip-trust.md"),
    "---\nid: FG-502\ntype: story\nstatus: active\ntitle: reviewed-tip trust\n---\n\nBody.\n",
  );
}

test("FG-502 CLI: an ancestor reviewed tip on a resolvable remote ref prints closeable naming the reviewed tip sha", async () => {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  setOriginHead(projectDir, tipSha);

  const program = new Command();
  registerReviewLoop(program, async () => RESULT({ result: { verdict: "pass", findings: [] } }));
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  const lines = captureConsoleLog();
  try {
    await program.parseAsync(
      ["review-loop", "FG-502", "--since", sinceSha, "--project", projectDir, "--unrouted"],
      { from: "user" },
    );
  } finally {
    mock.restoreAll();
  }
  const printed = lines.join("\n");
  assert.match(printed, /✓ closeable/);
  assert.match(printed, new RegExp(tipSha));
  assert.match(printed, /is the head of origin\/HEAD/);
  assert.notEqual(process.exitCode, 1);
  process.exitCode = prevExitCode;
});

test("FG-514 CLI: a remote strictly ahead of the reviewed tip withholds closeable, names the unreviewed commits, and exits non-zero", async () => {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const bare = addBareOrigin(projectDir);
  setUpstream(projectDir, tipSha);
  const branch = gitExec(["symbolic-ref", "--short", "HEAD"], projectDir).trim();
  pushNewCommitToOrigin(bare, branch, "commit the reviewer never saw");

  const program = new Command();
  registerReviewLoop(program, async () => RESULT({ result: { verdict: "pass", findings: [] } }));
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  const lines = captureConsoleLog();
  try {
    await program.parseAsync(
      ["review-loop", "FG-502", "--since", sinceSha, "--project", projectDir, "--unrouted"],
      { from: "user" },
    );
  } finally {
    mock.restoreAll();
  }
  const printed = lines.join("\n");
  assert.doesNotMatch(printed, /✓ closeable/);
  assert.match(printed, /not closeable — remote-ahead: @\{u\} carries commit\(s\) beyond reviewed tip/);
  assert.match(printed, /The remote head was never reviewed/);
  assert.match(printed, /REMOTE-AHEAD/, "the run note must record the same trust fact");
  assert.match(printed, /commit the reviewer never saw/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExitCode;
});

test("FG-502 CLI: an ancestor-failing (local-only) reviewed tip withholds closeable even though the reviewer passed and verification is green", async () => {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  // origin is pinned at sinceSha — behind the reviewed tip — so the reviewed
  // tip is NOT an ancestor of origin/HEAD.
  setOriginHead(projectDir, sinceSha);

  const program = new Command();
  registerReviewLoop(program, async () => RESULT({ result: { verdict: "pass", findings: [] } }));
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  const lines = captureConsoleLog();
  try {
    await program.parseAsync(
      ["review-loop", "FG-502", "--since", sinceSha, "--project", projectDir, "--unrouted"],
      { from: "user" },
    );
  } finally {
    mock.restoreAll();
  }
  const printed = lines.join("\n");
  assert.doesNotMatch(printed, /✓ closeable/);
  assert.match(printed, /not closeable — reviewed tip .* has local-only commit/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExitCode;
});

test("FG-502 CLI: an unresolvable remote ref withholds closeable with a distinct remote-unavailable message", async () => {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  // No origin remote / upstream configured at all.

  const program = new Command();
  registerReviewLoop(program, async () => RESULT({ result: { verdict: "pass", findings: [] } }));
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  const lines = captureConsoleLog();
  try {
    await program.parseAsync(
      ["review-loop", "FG-502", "--since", sinceSha, "--project", projectDir, "--unrouted"],
      { from: "user" },
    );
  } finally {
    mock.restoreAll();
  }
  const printed = lines.join("\n");
  assert.doesNotMatch(printed, /✓ closeable/);
  assert.match(printed, /not closeable — remote-unavailable/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExitCode;
});

// ── FG-514: the trust fact on the operator-facing surfaces ───────────────────
//
// The tests above pin the trust PRIMITIVE (resolveReviewedTipTrust's four
// outcomes) and stdout for the remote_ahead case. What sits between the
// primitive and the operator is untested: the note the loop leaves ON DISK
// (the artifact read after the terminal scrolls away), the closeable print
// gate as a composition (`outcome.closeable && kind === "trusted"` — the
// spoof FG-514 closes is the "Close with:" line appearing without equality),
// and the remote_unavailable branch that only fires when a ref DID resolve
// but its fetch failed. These drive the real `registerReviewLoop` path.

/** Ticket + package.json + one reviewed commit tracked by a pushed upstream,
 *  then a commit pushed to origin behind the local repo's back. The cached
 *  tracking ref stays stale — only the loop's own bounded fetch sees the real
 *  remote head. Returns what the assertions need to name shas. */
function setupRemoteAheadLoopRepo(): { sinceSha: string; tipSha: string; branch: string } {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const bare = addBareOrigin(projectDir);
  setUpstream(projectDir, tipSha);
  const branch = gitExec(["symbolic-ref", "--short", "HEAD"], projectDir).trim();
  pushNewCommitToOrigin(bare, branch, "unreviewed commit the reviewer never saw");
  return { sinceSha, tipSha, branch };
}

/** A passing reviewer that also does what a REAL dispatch does: spawn.ts
 *  creates the run dir. The note writer is guarded on `existsSync(runDir())`,
 *  so a stub that skips it silently downgrades every note assertion to a
 *  stdout assertion — the persisted artifact would never be written and the
 *  test would still pass. Records the runId so the caller can read the note. */
function passingReviewerCreatingRunDir(seen: { runId?: string }) {
  return async (a: InvokeArgs): Promise<InvokeResult> => {
    if (a.runId) {
      seen.runId = a.runId;
      mkdirSync(runDir(a.runId), { recursive: true });
      extraTempDirs.push(runDir(a.runId)); // under the suite's temp FORGE_HOME
    }
    return RESULT({ result: { verdict: "pass", findings: [] } });
  };
}

function readPersistedNote(seen: { runId?: string }, printed: string): string {
  assert.ok(seen.runId, "the reviewer must have been dispatched with the eagerly-created runId");
  const notePath = join(runDir(seen.runId), "review-loop.md");
  assert.ok(existsSync(notePath), `the run note must be PERSISTED, not merely printed. stdout:\n${printed}`);
  return readFileSync(notePath, "utf8");
}

async function runLoopCli(sinceSha: string, invokeFn: (a: InvokeArgs) => Promise<InvokeResult>): Promise<string> {
  const program = new Command();
  registerReviewLoop(program, invokeFn);
  const lines = captureConsoleLog();
  try {
    await program.parseAsync(
      ["review-loop", "FG-502", "--since", sinceSha, "--project", projectDir, "--unrouted"],
      { from: "user" },
    );
  } finally {
    mock.restoreAll();
  }
  return lines.join("\n");
}

test("FG-514 CLI: a remote-ahead loop writes the trust fact into the DURABLE run note — REMOTE-AHEAD, the unreviewed commit's sha + subject, and the pull/rebase next action", async () => {
  const { sinceSha, branch } = setupRemoteAheadLoopRepo();
  const seen: { runId?: string } = {};
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;

  const printed = await runLoopCli(sinceSha, passingReviewerCreatingRunDir(seen));
  const note = readPersistedNote(seen, printed);

  // Positive control: `passed` is the ONLY stopReason carrying closeable=true,
  // so the reviewer passed AND verification was green. What withholds closeable
  // below is the trust gate, not a failed loop — without this the doesNotMatch
  // assertions could pass vacuously.
  assert.match(note, /- \*\*stop reason:\*\* passed/);
  assert.match(note, /- \*\*closeable:\*\* no/);

  assert.match(note, /remote reachability:.*REMOTE-AHEAD/, `the persisted note must carry the trust fact:\n${note}`);
  assert.match(note, /- \*\*unreviewed commits:\*\*/);
  // The note's shas come from `git log --format=%h`; read the fetched remote
  // head back through the same producer so abbreviation length can't drift.
  const remoteHeadShortSha = gitExec(["log", "--format=%h", "-1", `refs/remotes/origin/${branch}`], projectDir).trim();
  assert.match(note, new RegExp(`- ${remoteHeadShortSha} unreviewed commit the reviewer never saw`),
    `the note must name the unreviewed commit sha the operator has to rebase onto:\n${note}`);
  assert.match(note, /next action:.*pull\/rebase onto/);
  assert.doesNotMatch(note, /a closeable verdict \(if any\) is trustworthy/, "the trusted line must never render for a remote-ahead tip");

  assert.equal(process.exitCode, 1);
  process.exitCode = prevExitCode;
});

test("FG-514 CLI: a loop that exits BEFORE any dispatch (verification_failed, no discoverable checks) still PERSISTS the run note carrying the remote-ahead trust fact", async () => {
  writeFg502Ticket();
  // No typecheck/test scripts → runVerification finds no steps → ok:false with
  // zero findings → the engine stops without ever dispatching a reviewer/fixer,
  // so nothing else creates the run dir.
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: {} }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const bare = addBareOrigin(projectDir);
  setUpstream(projectDir, tipSha);
  const branch = gitExec(["symbolic-ref", "--short", "HEAD"], projectDir).trim();
  pushNewCommitToOrigin(bare, branch, "unreviewed commit the reviewer never saw");

  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;

  const printed = await runLoopCli(sinceSha, async () => {
    throw new Error("no reviewer/fixer may be dispatched on a no-discoverable-checks exit");
  });

  assert.match(printed, /stop reason: verification_failed/);
  const notePath = /^note: (.+)$/m.exec(printed)?.[1];
  assert.ok(notePath, `the loop must print the note path even with no dispatch:\n${printed}`);
  extraTempDirs.push(dirname(notePath));
  assert.ok(existsSync(notePath),
    `the note must be PERSISTED on a no-dispatch exit, not merely printed — the run dir is otherwise only created by a dispatch:\n${printed}`);

  const note = readFileSync(notePath, "utf8");
  assert.match(note, /remote reachability:.*REMOTE-AHEAD/, `the persisted note must carry the trust fact:\n${note}`);
  const remoteHeadShortSha = gitExec(["log", "--format=%h", "-1", `refs/remotes/origin/${branch}`], projectDir).trim();
  assert.match(note, new RegExp(`- ${remoteHeadShortSha} unreviewed commit the reviewer never saw`));
  assert.match(note, /- \*\*stop reason:\*\* verification_failed/);
  assert.match(note, /- \*\*closeable:\*\* no/);

  assert.equal(process.exitCode, 1);
  process.exitCode = prevExitCode;
});

test("FG-514 CLI: remote-ahead + an otherwise-closeable outcome exits 1 and never emits the `Close with: forge backlog close` line — not on the console, not in the note", async () => {
  const { sinceSha } = setupRemoteAheadLoopRepo();
  const seen: { runId?: string } = {};
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;

  const printed = await runLoopCli(sinceSha, passingReviewerCreatingRunDir(seen));
  const note = readPersistedNote(seen, printed);
  const everything = `${printed}\n${note}`;

  // Positive control — outcome.closeable was true. The gate is the ONLY reason
  // the close instruction is absent.
  assert.match(printed, /- \*\*stop reason:\*\* passed/);

  // The exact spoof FG-514 closes: a close instruction reachable without
  // equality against the remote head. Assert the ABSENCE on every surface.
  assert.doesNotMatch(everything, /✓ closeable/);
  assert.doesNotMatch(everything, /Close with:/, `the close instruction must never render for a remote-ahead tip:\n${everything}`);
  assert.doesNotMatch(everything, /forge backlog close/);
  assert.match(printed, /✗ not closeable — remote-ahead/);
  assert.equal(process.exitCode, 1, "a withheld closeable must fail the command, not just print");
  process.exitCode = prevExitCode;
});

test("FG-514 CLI: a failed bounded fetch over an EXISTING cached tracking ref withholds closeable, surfaces the fetch error, and is distinct from the no-remote-ref message", async () => {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // The cached tracking ref AGREES with the reviewed tip — the pre-FG-514
  // stale-cache comparison would print "✓ closeable" here. origin points at a
  // path that does not exist, so the bounded fetch fails without any network.
  gitExec(["remote", "add", "origin", join(tmpdir(), "forge-rl-nonexistent-remote-3f10c4")], projectDir);
  gitExec(["update-ref", "refs/remotes/origin/main", tipSha], projectDir);
  gitExec(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], projectDir);

  const seen: { runId?: string } = {};
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;

  const printed = await runLoopCli(sinceSha, passingReviewerCreatingRunDir(seen));
  const note = readPersistedNote(seen, printed);

  assert.match(printed, /- \*\*stop reason:\*\* passed/, "positive control: the loop itself passed");
  assert.doesNotMatch(printed, /✓ closeable/, "a cached ref equal to the tip must never be trusted when its fetch failed");
  assert.doesNotMatch(printed, /forge backlog close/);
  assert.match(printed, /✗ not closeable — remote-unavailable: the remote head could not be verified \(bounded fetch of origin\/HEAD failed: .+\)/,
    `the operator must see WHY the head is unknown:\n${printed}`);
  assert.match(printed, /and a stale cached ref is never trusted/);
  assert.match(printed, new RegExp(tipSha), "the unconfirmable tip is named");
  // The two remote_unavailable branches are distinct: this ref DID resolve.
  assert.doesNotMatch(printed, /no resolvable remote-tracking ref/);
  assert.equal(process.exitCode, 1);

  assert.match(note, /remote reachability:.*UNAVAILABLE — the remote head could not be verified: the bounded fetch of `origin\/HEAD` failed \(.+\)/,
    `the persisted note must carry the fetch failure, not the no-ref wording:\n${note}`);
  assert.match(note, /next action:.*restore remote access/);
  assert.match(note, /- \*\*closeable:\*\* no/);
  process.exitCode = prevExitCode;
});

test("FG-514 CLI: a cached upstream lagging BEHIND the pushed tip is refreshed by the bounded fetch — equality holds, closeable is granted (the fetch decides, not the cache)", async () => {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  const branch = gitExec(["symbolic-ref", "--short", "HEAD"], projectDir).trim();

  // The tip IS the remote head — but the local tracking ref was never updated
  // after the push, so it still names the pre-commit baseline. Comparing
  // against that cache yields local_only and withholds closeable (a false
  // NEGATIVE); only the bounded fetch can see the tip is the remote head. This
  // is the equality happy path where the cache and the truth disagree, so it
  // also proves the fetch runs on the real CLI path, not just in the primitive.
  const bare = addBareOrigin(projectDir);
  gitExec(["push", "--quiet", "--force", bare, `${tipSha}:refs/heads/${branch}`], projectDir);
  gitExec(["update-ref", `refs/remotes/origin/${branch}`, sinceSha], projectDir);
  gitExec(["config", `branch.${branch}.remote`, "origin"], projectDir);
  gitExec(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], projectDir);
  assert.equal(gitExec(["rev-parse", "@{u}"], projectDir).trim(), sinceSha,
    "precondition: the cached upstream must lag the pushed tip before the loop runs");

  const seen: { runId?: string } = {};
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;

  const printed = await runLoopCli(sinceSha, passingReviewerCreatingRunDir(seen));
  const note = readPersistedNote(seen, printed);

  assert.match(printed, /✓ closeable/, `equality with the FETCHED head must grant closeable:\n${printed}`);
  assert.match(printed, /is the head of @\{u\}/, "@{u} wins over the origin/HEAD fallback when an upstream is configured");
  assert.match(printed, /Close with:\s+forge backlog close #?FG-502/);
  assert.notEqual(process.exitCode, 1);

  assert.equal(gitExec(["rev-parse", "@{u}"], projectDir).trim(), tipSha,
    "the bounded fetch must have refreshed the stale tracking ref — otherwise trust was decided off the cache");
  assert.match(note, /- \*\*closeable:\*\* yes/);
  assert.match(note, /the reviewed tip IS the head of `@\{u\}`/);
  process.exitCode = prevExitCode;
});

test("FG-514 resolveReviewedTipTrust: a DIVERGED branch — local commits the remote lacks AND remote commits the reviewer never saw — is never trusted", async () => {
  const bare = addBareOrigin(projectDir);
  const baseSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  setUpstream(projectDir, baseSha);
  const branch = gitExec(["symbolic-ref", "--short", "HEAD"], projectDir).trim();
  pushNewCommitToOrigin(bare, branch, "remote-only commit the reviewer never saw");

  writeFileSync(join(projectDir, "diverged.txt"), "diverged\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "local-only commit the remote never saw"], projectDir);
  const tipSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const trust = resolveReviewedTipTrust(projectDir, tipSha);

  // The invariant that actually gates merge authorization: divergence is not trust.
  assert.notEqual(trust.kind, "trusted", `a diverged branch must never authorize a close: ${JSON.stringify(trust)}`);

  // Both directions are non-empty, so neither local_only nor remote_ahead tells
  // the truth: the operator must be told to rebase (a plain push is
  // non-fast-forward) and BOTH sides must be named.
  assert.equal(trust.kind, "diverged");
  const t = trust as {
    remoteRef: string;
    localCommits: { sha: string; subject: string }[];
    unreviewedCommits: { sha: string; subject: string }[];
  };
  assert.equal(t.remoteRef, "@{u}");
  assert.equal(t.localCommits.length, 1);
  assert.match(t.localCommits[0]!.subject, /local-only commit the remote never saw/);
  assert.equal(t.unreviewedCommits.length, 1);
  assert.match(t.unreviewedCommits[0]!.subject, /remote-only commit the reviewer never saw/);

  // Pin that this really is divergence and not merely a local-ahead branch:
  // the fetch pulled in a remote commit the reviewed tip does not contain.
  const remoteHead = gitExec(["rev-parse", `refs/remotes/origin/${branch}`], projectDir).trim();
  assert.notEqual(remoteHead, baseSha, "the bounded fetch must have pulled in the remote-only commit");
  const unreviewed = gitExec(["log", "--format=%h", `${tipSha}..${remoteHead}`], projectDir).trim().split("\n").filter(Boolean);
  assert.equal(unreviewed.length, 1, "the remote genuinely carries a commit the reviewed tip lacks — divergence, not local-ahead");
});

test("FG-502 CLI end-to-end: computeInRangeDocsPaths threads through registerReviewLoop into the scope guard — a fixer edit to a docs/ path already touched by the ORIGINAL reviewed range survives commit, not reverted", async () => {
  writeFg502Ticket();
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "true" } }));
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "reviewed.md"), "# reviewed\n\noriginal.\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "(#FG-502) add package.json + ticket + docs/reviewed.md"], projectDir);
  const tipShaBeforeFix = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // Round 1: reviewer asks for a fix touching the already-in-range docs path;
  // round 2: reviewer passes once the fixer has committed.
  let redCalls = 0;
  const invokeFn = async (a: InvokeArgs): Promise<InvokeResult> => {
    if (a.agentRole === "red-wide") {
      redCalls++;
      return redCalls === 1
        ? RESULT({ result: { verdict: "fail", findings: [{ summary: "docs/reviewed.md needs a follow-up note", unanchored: true }] } })
        : RESULT({ result: { verdict: "pass", findings: [] } });
    }
    // "engineer" fixer: edits the SAME docs/ path already committed within
    // sinceSha..tip — this must be classified in-range, not reverted.
    writeFileSync(join(projectDir, "docs", "reviewed.md"), "# reviewed\n\noriginal.\n\nfixer follow-up.\n");
    writeFileSync(join(projectDir, "src.ts"), "// fixed\n");
    return COMPLETE();
  };

  const program = new Command();
  registerReviewLoop(program, invokeFn);
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  const lines = captureConsoleLog();
  try {
    await program.parseAsync(
      ["review-loop", "FG-502", "--since", sinceSha, "--project", projectDir, "--unrouted"],
      { from: "user" },
    );
  } finally {
    mock.restoreAll();
  }
  const printed = lines.join("\n");

  assert.doesNotMatch(
    printed, /fixer scope guard — reverted disallowed paths/,
    `docs/reviewed.md was part of the loop-start reviewed range (computed via the real CLI wiring, not a hand-built Set) and must not trigger a scope-guard revert:\n${printed}`,
  );

  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.notEqual(headSha, tipShaBeforeFix, "the fixer round must have committed");
  assert.match(readFileSync(join(projectDir, "docs", "reviewed.md"), "utf8"), /fixer follow-up/, "the fixer's docs/ edit must be on disk, not reverted");
  const committedFiles = gitExec(["show", "--name-only", "--format=", headSha], projectDir).trim().split("\n");
  assert.ok(committedFiles.includes("docs/reviewed.md"), `expected docs/reviewed.md in the fixer's commit, got: ${JSON.stringify(committedFiles)}`);
  process.exitCode = prevExitCode;
});

// ── FG-513: reviewer profile pinning + same-round model_error retry ──────────
//
// The FG-502 incident (run run-review-loop-fg-502-eeba99): resolveModel re-reads
// model-policy.yml at every dispatch, so a mid-loop operator edit rotated the
// reviewer from claude-subscription (round 1, defaults.activity.review) to
// codex-subscription (round 2, overrides.agents.red-wide) — which was provider-
// broken, structurally killing an otherwise-passing run. These tests pin the two
// behaviors that prevent a recurrence: the profile is resolved ONCE per loop,
// and a reviewer model_error gets ONE same-round retry on the fallback profile.

const FG513_POLICY_WITH_OVERRIDE = `
schema_version: 2
model_profiles:
  prof-a:
    provider: anthropic
    auth: subscription
    map:
      review:  { model: model-a, cost_tier: standard }
      default: { model: model-a, cost_tier: standard }
  prof-b:
    provider: anthropic
    auth: subscription
    map:
      review:  { model: model-b, cost_tier: standard }
      default: { model: model-b, cost_tier: standard }
defaults:
  profile: prof-b
  activity:
    review: prof-b
overrides:
  agents:
    red-wide: prof-a
`;

const FG513_POLICY_NO_OVERRIDE = `
schema_version: 2
model_profiles:
  prof-b:
    provider: anthropic
    auth: subscription
    map:
      review:  { model: model-b, cost_tier: standard }
      default: { model: model-b, cost_tier: standard }
defaults:
  profile: prof-b
  activity:
    review: prof-b
`;

function fg513WritePolicy(yaml: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), yaml);
}

test("FG-513 plan: policy mode pins the agent-override profile and retries on the defaults path", () => {
  fg513WritePolicy(FG513_POLICY_WITH_OVERRIDE);
  assert.deepEqual(resolveReviewerProfilePlan(projectDir), { pinned: "prof-a", retryProfile: "prof-b" });
});

test("FG-513 plan: --review-profile (operator pin) retries on ITSELF — never silently switched away", () => {
  fg513WritePolicy(FG513_POLICY_WITH_OVERRIDE);
  assert.deepEqual(resolveReviewerProfilePlan(projectDir, "prof-b"), { pinned: "prof-b", retryProfile: "prof-b" });
});

test("FG-513 plan: legacy mode (no model-policy anywhere) has no profiles to pin", () => {
  // projectDir has no .forge/model-policy.yml and the test FORGE_HOME has none.
  assert.deepEqual(resolveReviewerProfilePlan(projectDir), {});
});

test("FG-513 pinning: the reviewer profile is resolved once at loop start — a mid-loop policy edit no longer rotates the reviewer between rounds (the FG-502 incident shape)", async () => {
  fg513WritePolicy(FG513_POLICY_WITH_OVERRIDE);
  const profiles: (string | undefined)[] = [];
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => {
    profiles.push(a.modelProfile);
    return RESULT({ result: { verdict: "pass" } });
  });
  await deps.review({ ok: true, steps: [] }); // round 1
  // the incident mechanism: the policy file changes between rounds
  fg513WritePolicy(FG513_POLICY_NO_OVERRIDE);
  await deps.review({ ok: true, steps: [] }); // round 2
  assert.deepEqual(profiles, ["prof-a", "prof-a"], "both rounds must dispatch the SAME loop-start profile");
});

test("FG-513 retry: reviewer model_error → exactly one same-round retry on the fallback profile; the run survives with the retry recorded", async () => {
  fg513WritePolicy(FG513_POLICY_WITH_OVERRIDE);
  const calls: (string | undefined)[] = [];
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => {
    calls.push(a.modelProfile);
    if (calls.length === 1) {
      return RESULT({ status: "failed", error: "codex run failed: model not found", failureKind: "model_error" });
    }
    return RESULT({ result: { verdict: "pass" } });
  });
  const r = await deps.review({ ok: true, steps: [] });
  assert.deepEqual(calls, ["prof-a", "prof-b"], "retry must land on the defaults-path profile, same round");
  assert.equal(r.ok, true, "the infra failure must not kill the round");
  assert.deepEqual(
    (r as { modelErrorRetry?: unknown }).modelErrorRetry,
    { failedProfile: "prof-a", retryProfile: "prof-b", cause: "codex run failed: model not found" },
    "the retry is part of the dispatch record",
  );
  // Durable audit trail: the retry event was logged against the loop's run.
  const retryEvents = eventsForRun("run-1").filter((e) => e.eventType === "review_loop.reviewer_model_error_retry");
  assert.equal(retryEvents.length, 1);
  assert.equal((retryEvents[0]!.payload as Record<string, unknown>)["failedProfile"], "prof-a");
  assert.equal((retryEvents[0]!.payload as Record<string, unknown>)["retryProfile"], "prof-b");
});

test("FG-513 retry is bounded: a second model_error stops the round as a reviewer failure — exactly two dispatches, never a loop", async () => {
  fg513WritePolicy(FG513_POLICY_WITH_OVERRIDE);
  let calls = 0;
  const { deps } = buildReviewLoopDeps(ctx(), async () => {
    calls++;
    return RESULT({ status: "failed", error: "provider quota exhausted", failureKind: "model_error" });
  });
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(calls, 2, "one dispatch + one bounded retry, nothing more");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /after same-round model_error retry on 'prof-b'/);
  assert.match((r as { error: string }).error, /provider quota exhausted/);
});

test("FG-513: a non-model_error reviewer failure is NOT retried (structural failures still fail structurally)", async () => {
  fg513WritePolicy(FG513_POLICY_WITH_OVERRIDE);
  let calls = 0;
  const { deps } = buildReviewLoopDeps(ctx(), async () => {
    calls++;
    return RESULT({ status: "failed", error: "container_crash (exit 1)", failureKind: "container_crash" });
  });
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(calls, 1, "no retry for a non-provider failure");
  assert.equal(r.ok, false);
});

test("FG-513 legacy mode: a model_error still gets one bounded same-resolution retry", async () => {
  // No policy file → pinned/retry undefined; the retry dispatch re-runs the
  // same legacy resolution once (bounded transient tolerance).
  const calls: (string | undefined)[] = [];
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => {
    calls.push(a.modelProfile);
    if (calls.length === 1) {
      return RESULT({ status: "failed", error: "claude run failed: overloaded", failureKind: "model_error" });
    }
    return RESULT({ result: { verdict: "pass" } });
  });
  const r = await deps.review({ ok: true, steps: [] });
  assert.deepEqual(calls, [undefined, undefined]);
  assert.equal(r.ok, true);
});

// ── FG-539: commit-range inference recognizes Forge's real subject convention ─
// Production-shaped: a real git repo whose subjects use the established
// "(FG-xxx)" form (no hash), exercised through resolveCommitRange with the
// REAL git binary and through the registered CLI command itself.

function commit(subject: string, file: string): string {
  writeFileSync(join(projectDir, file), `// ${subject}\n`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", subject], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

test("FG-539: real-git inference over the FG-533/FG-535/FG-536 subject convention → mode inferred, precise shas, exact boundaries", async () => {
  commit("fix(review-loop): stash notes handling (FG-533)", "a.ts");
  commit("feat(launch): durable exit records (FG-535)", "b.ts");
  const fg536a = commit("fix(spawn): detached agent execution (FG-536)", "c.ts");
  commit("chore: unrelated housekeeping", "d.ts");
  const fg5360 = commit("feat: adjacent ticket (FG-5360)", "e.ts");
  const fg536b = commit("docs(spawn): detached execution ADR (FG-536)", "f.ts");

  const git = (args: string[]) => gitExec(args, projectDir);
  const r = resolveCommitRange("FG-536", { git });

  assert.equal(r.mode, "inferred");
  assert.deepEqual(r.shas, [fg536b, fg536a], "precise set: both FG-536 commits, newest first, nothing else");
  assert.ok(!r.shas.includes(fg5360), "FG-5360 must not match FG-536");
  assert.equal(r.spansUnmatched, true, "unrelated + FG-5360 commits sit inside the span");
  assert.equal(r.diffRange, `${fg536a}^..${fg536b}`);
});

test("FG-539: a ticket referenced only in a commit BODY stays out of that ticket's range", async () => {
  // The real shape this guards: FG-539's own implementation commit has an FG-539
  // subject and a body that *explains itself by discussing FG-536*. `git log
  // --grep` searches subject AND body, so it would pull this commit into an
  // FG-536 review diff. Subject-only matching is what keeps the diff honest —
  // and only a real body (not a subject-only fixture) can prove it.
  const fg536 = commit("fix(spawn): detached agent execution (FG-536)", "k.ts");
  writeFileSync(join(projectDir, "l.ts"), "// range inference\n");
  gitExec(["add", "."], projectDir);
  gitExec(
    ["commit", "-m", "fix(review-loop): commit-range inference (FG-539)",
     "-m", "The reviewer for FG-536 saw an empty diff because inference missed the subject convention."],
    projectDir,
  );
  const fg539 = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const git = (args: string[]) => gitExec(args, projectDir);
  const r = resolveCommitRange("FG-536", { git });

  assert.ok(!r.shas.includes(fg539), "an FG-536 mention in FG-539's BODY must not add it to FG-536's range");
  assert.equal(r.shas[0], fg536, "the FG-536 subject commit is still the newest match");
  assert.deepEqual(resolveCommitRange("FG-539", { git }).shas, [fg539], "FG-539 resolves by its own subject");
});

test("FG-539: hash-prefixed and legacy forms still resolve against real git", async () => {
  const hashed = commit("fix: hash-prefixed reference #FG-536", "g.ts");
  const legacy = commit("fix: legacy numeric reference (#301)", "h.ts");

  const git = (args: string[]) => gitExec(args, projectDir);
  assert.deepEqual(resolveCommitRange("#FG-536", { git }).shas, [hashed]);
  assert.deepEqual(resolveCommitRange("301", { git }).shas, [legacy]);
});

test("FG-539: --since precedence is unchanged — explicit range wins over inference", async () => {
  const base = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  const tip = commit("fix: some work (FG-536)", "i.ts");

  const git = (args: string[]) => gitExec(args, projectDir);
  const r = resolveCommitRange("FG-536", { since: base, git });
  assert.equal(r.mode, "since");
  assert.equal(r.diffRange, `${base}..HEAD`);
  assert.deepEqual(r.shas, [tip]);
});

test("FG-539 AC7: `forge review-loop FG-539 --dry-run` no longer emits 'no commits reference' for standard subjects", async () => {
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-539-range-inference.md"),
    "---\nid: FG-539\ntype: story\nstatus: active\ntitle: range inference\n---\n\nBody.\n",
  );
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "add backlog fixture"], projectDir);
  commit("fix(review-loop): recognize standard ticket subjects (FG-539)", "j.ts");

  const lines = captureConsoleLog();
  try {
    const program = new Command();
    registerReviewLoop(program, async () => { throw new Error("must not dispatch on --dry-run"); });
    await program.parseAsync(
      ["review-loop", "FG-539", "--project", projectDir, "--unrouted", "--dry-run"],
      { from: "user" },
    );
    const printed = lines.join("\n");
    assert.match(printed, /\(dry run — no dispatch\)/);
    assert.doesNotMatch(printed, /no commits reference/);
  } finally {
    mock.restoreAll();
  }
});

// ── FG-540 E2E: Codex stream recovery through the PRODUCTION reviewer path ──
// The incident (run-review-loop-fg-536-eaa5be / task-red-wide-0dc174) was a
// review-loop reviewer whose valid pass lived only in the stream. These tests
// drive the real chain — buildReviewLoopDeps.review → invoke() (real dispatch,
// only the docker boundary stubbed) → stream recovery → parseReviewerVerdict →
// runReviewLoop — proving the recovered result behaves exactly like a
// file-written one at the loop's own gates (AC3), and that a recovered but
// schema-invalid object stops the loop structurally (AC6).

function ensureFg540CodexRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "codex-e2e-stub.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `name: codex-e2e-stub
description: test stub codex runtime (FG-540 E2E)
log_format: codex-jsonl
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Sanitized incident shape: clean exit 0, turn envelope, terminal JSON
// agent_message, result.json never written.
function fg540CodexStream(terminalText: string): string {
  return [
    `{"type":"thread.started","thread_id":"019f557b-3c14-7f50-92fa-d38a1675ecb6"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Auditing the diff against the acceptance path."}}`,
    `{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":${JSON.stringify(terminalText)}}}`,
    `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
  ].join("\n");
}

function fg540NoResultExec(stdoutJsonl: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-540 E2E (AC3): a reviewer pass living only in the Codex stream flows through the production review path to a passed, closeable round", async () => {
  ensureFg540CodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const passText = JSON.stringify({ status: "complete", verdict: "pass", findings: [] });
  // Real invoke(), real dispatch, real recovery, real parse — only docker and
  // the runtime name are test-controlled.
  const { deps } = buildReviewLoopDeps(
    ctx(),
    (args) => invoke({ ...args, runtimeName: "codex-e2e-stub", dockerExec: fg540NoResultExec(fg540CodexStream(passText)) }),
  );

  let fixerDispatched = 0;
  const r = await runReviewLoop(
    { maxRounds: 1 },
    {
      verify: () => ({ ok: true, steps: [{ name: "test", ok: true, output: "" }] }),
      review: deps.review,
      fix: () => { fixerDispatched++; return { ok: true }; },
    },
  );

  assert.equal(r.stopReason, "passed", "the recovered pass drives the round exactly like a file-written pass");
  assert.equal(r.rounds[0]!.verdict, "pass");
  assert.equal(r.closeable, true, "the round is closeable off the recovered result");
  assert.equal(fixerDispatched, 0);
});

test("FG-540 E2E (AC6): a recovered but schema-INVALID object stops the production review path as reviewer_failed — no fixer, never a pass", async () => {
  ensureFg540CodexRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // A well-formed JSON object (so transport-level recovery succeeds and the
  // reviewer task completes) that is NOT a valid reviewer verdict.
  const invalidText = JSON.stringify({ status: "complete", summary: "looks fine to me" });
  const { deps } = buildReviewLoopDeps(
    ctx(),
    (args) => invoke({ ...args, runtimeName: "codex-e2e-stub", dockerExec: fg540NoResultExec(fg540CodexStream(invalidText)) }),
  );

  let fixerDispatched = 0;
  const r = await runReviewLoop(
    { maxRounds: 2 },
    {
      verify: () => ({ ok: true, steps: [{ name: "test", ok: true, output: "" }] }),
      review: deps.review,
      fix: () => { fixerDispatched++; return { ok: true }; },
    },
  );

  assert.equal(r.stopReason, "reviewer_failed", "an invalid recovered object is a structural stop, not a verdict");
  assert.equal(r.closeable, false);
  assert.equal(fixerDispatched, 0, "no fixer round is driven off an invalid recovered object");
  assert.ok(r.rounds.every((round) => round.verdict !== "pass"), "never converted to a pass");
});
