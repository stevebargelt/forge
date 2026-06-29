// #301 slice 6: buildReviewLoopDeps wires the engine to invoke(). Tests use an
// injected invokeFn (no containers) — assert verdict mapping, dispatch-failure
// handling, runId threading, and the reviewer/fixer dispatch shape.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { InvokeArgs, InvokeResult } from "../../v2/invoke.js";
import { buildReviewLoopDeps, assertCleanWorkingTree, type ReviewLoopContext } from "./review-loop.js";

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

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-rl-"));
  gitExec(["init", "-q"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  writeFileSync(join(projectDir, "src.ts"), "// initial\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "initial commit"], projectDir);
});

afterEach(() => {
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

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
