// #301 slice 6: `forge review-loop <ticket-id>` — wire the pure engine
// (src/v2/review-loop.ts) to real dispatch. Reviewer = red-wide (read-only),
// fixer = engineer, host verification. #297 route preflight runs before EVERY
// dispatch. Never auto-closes the ticket (reports `closeable`); never runs spend/
// migration/destructive surface — it only invokes reviewer/fixer agents.

import type { Command } from "commander";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ensureForgeDirs, runDir } from "../../util/paths.js";
import { invoke, type InvokeArgs, type InvokeResult } from "../../v2/invoke.js";
import { readTicket } from "../../backlog/structured.js";
import { applyRoutePreflight, preflightEnforceFromEnv } from "../route-preflight.js";
import {
  resolveCommitRange, runVerification, runReviewLoop, renderReviewLoopNote, parseReviewerVerdict,
  type CommitRange, type ReviewLoopDeps, type VerificationResult, type Finding,
} from "../../v2/review-loop.js";

type InvokeFn = (args: InvokeArgs) => Promise<InvokeResult>;

// ── task templates ───────────────────────────────────────────────────────────

function reviewTask(acceptance: string, diff: string, v: VerificationResult): string {
  const checks = v.steps.map((s) => `- ${s.name}: ${s.ok ? "passed" : "FAILED"}`).join("\n") || "(none discoverable)";
  return [
    "You are the REVIEWER in a bounded review loop. Judge whether the diff satisfies the ticket's acceptance. Make NO changes.",
    "", "## Ticket", acceptance,
    "", "## Deterministic verification (already run on the host — green is a precondition for pass)", checks,
    "", "## Diff under review", "```diff", diff || "(empty)", "```",
    "", "## Review rubric (apply beyond a literal acceptance read)",
    "- Docs/ADRs/comments in the diff: verify every behavioral claim against the changed implementation and tests. A doc that contradicts the code it describes is a finding even when the code is correct.",
    "- Same behavior on multiple execution paths (e.g. a direct path and a workflow/orchestration path): each path needs its own assertion of the acceptance SEMANTIC, not just adjacent output/log/error text. A path whose behavior changed but is only covered by incidental output assertions is a finding.",
    "- Call out (as a finding, or an unanchored note when you still pass) any changed code path that lacks direct test coverage of the NEW behavior.",
    "- Policy/config/runtime changes: trace the FULL operator path, not just field threading — config -> resolver -> dispatch args -> auth/env/mounts -> doctor/diagnostic surface. A change that wires a value into dispatch but leaves the matching credential un-injected or unverifiable by diagnostics is a finding (e.g. a profile routes to --provider X but no X key is injected and `providers doctor` can't probe it).",
    "- Treat any shipped example profile/config (committed example YAML, sample policy, quickstart snippet) as a RUNNABLE CONTRACT: trace it end-to-end and flag it if it cannot actually run, UNLESS the diff explicitly marks it non-runnable/illustrative. A plausible-but-dead example is a finding.",
    "- When implementation changes a name/shape/vocabulary, reconcile ALL design records — accepted PRDs and ADRs, not only how-to docs. An accepted PRD still describing the pre-implementation vocabulary is a finding.",
    "", "## Adjacent-surface regression matrix (the recurring miss pattern — apply rigorously)",
    "Literal acceptance is necessary but NOT sufficient. The misses that slip through are in adjacent surfaces:",
    "- STALE CLOSEOUT TEXT: when the diff closes a ticket, its committed backlog/docs closeout text must not retain open-ticket status language — `Deferred`, `not urgent`, `TODO`, `not in scope yet`, or future-tense plans. Stale closeout wording on a closed ticket is a finding.",
    "- ALL SUPPORTED FORMATS, not just the named one: when a helper is applied GENERICALLY (not gated to one format), inspect EVERY currently supported log_format / runtime_kind, not only the one named in the ticket. A helper that handles one agent log shape (e.g. claude-stream-json) but silently no-ops on another supported one (e.g. codex-jsonl) is a finding.",
    "- RECENTLY-ACTIVATED PATHS: include recently-activated paths in the regression matrix even when the ticket doesn't mention them. The Codex reviewer path (codex-subscription / codex-jsonl) is CURRENTLY ACTIVE, so any show / log / usage / runtime / dispatch change must consider codex-jsonl where applicable.",
    "- STALE NON-PROSE TEXT: flag stale claims in code comments, seed text/templates, test fixtures, and ADR/backlog wording — not only formal docs.",
    "- NAME THE MATRIX: in your review you MUST explicitly name the adjacent-surface matrix you considered — affected runtime kinds, log formats, auth modes, CLI modes, and docs/backlog surfaces (whichever apply to the diff). For any adjacent surface you did NOT inspect, state explicitly why it is out of scope. Record this as an unanchored note when you pass (it does not block a pass, but a pass with no matrix stated is incomplete).",
    "", "## Production-path consistency trace (REQUIRED when the acceptance criterion uses any of: surface, report, distinguish, gate, block, resume, continue, approve, review)",
    "For such an AC, do NOT judge it by reading only the changed function or a pure evaluator/schema. Trace the canonical PRODUCTION path end-to-end and require concrete evidence (in the diff AND tests) at each link:",
    "1. SOURCE OF TRUTH — where the real value originates (DB row, ticket file, run/task result, git state, config).",
    "2. COLLECTOR / GATHERER — the code that reads the source into the evaluator/policy input. FINDING if the collector hardcodes null / a fixture / a placeholder so the capability is inert for REAL inputs — the 'supported-but-inert' miss: the schema/evaluator supports it but the real-data path never populates it.",
    "3. EVALUATOR / POLICY — the pure logic. Correct logic over data that never arrives is NOT a satisfied AC.",
    "4. STATE TRANSITION / RE-RUN behavior — if the work mutates state inside a loop or across resume/retry/recheck, later steps must observe the NEW state, not a precomputed snapshot. STALE-STATE-AFTER-MUTATION is a finding: a value computed once and reused after the state it described has changed.",
    "5. OPERATOR SURFACE AND MACHINE OUTPUT — BOTH the human CLI/text rendering AND the JSON/structured output must reflect it. JSON carrying the field while the human surface omits it (or vice versa) is a finding.",
    "6. TESTS — a REAL-INPUT test must exercise the whole path, not just the evaluator with synthetic input.",
    "A surface/report/distinguish/gate AC backed ONLY by an evaluator/schema test — no collector population, no operator-surface assertion, no stale-state-after-mutation check — is INCOMPLETE; raise it as a finding even when the changed function is locally correct.",
    "", "## Output contract — write EXACTLY this JSON to /task/result.json:",
    '{ "verdict": "pass" | "needs_fix" | "blocked", "findings": [ { "summary": "...", "file": "<path>", "line": <n> } | { "summary": "...", "unanchored": true } ] }',
    "- pass: the diff meets the acceptance (verification is already green).",
    "- needs_fix: concrete, fixable problems. List each as a finding, file+line anchored where possible (else \"unanchored\": true). needs_fix REQUIRES >= 1 finding.",
    "- blocked: cannot proceed (ambiguous requirement / missing context); explain in findings.",
    "- Your standard RED vocabulary is also accepted: \"fail\" is mapped to needs_fix (list the findings same as above), \"inconclusive\" is mapped to blocked.",
  ].join("\n");
}

function fixTask(ticketId: string, findings: Finding[]): string {
  const list = findings
    .map((f, i) => `${i + 1}. ${f.unanchored ? "[unanchored]" : `${f.file}:${f.line}`} — ${f.summary}`)
    .join("\n\n");
  return [
    `You are the FIXER in a bounded review loop for ticket #${ticketId.replace(/^#/, "")}. Address ONLY the findings below`,
    "with the minimal change that resolves each. Do not refactor beyond them. Self-validate per your seed and write /task/result.json.",
    "", "## Findings to fix", list,
  ].join("\n");
}

// ── real deps (invoke wiring + per-dispatch preflight) ───────────────────────

export type ReviewLoopContext = {
  ticketId: string;
  acceptance: string;
  diffProvider: () => string;
  projectDir: string;
  scripts: Record<string, unknown>;
  route?: string;
  unrouted?: boolean;
  reviewProfile?: string;
  implementProfile?: string;
  runId?: string;
};

/** Build the engine's deps from real invoke + host verification. `invokeFn` is
 *  injectable for tests. Threads a single runId across reviewer+fixer dispatches.
 *  Returns getRunId so the caller can locate the run dir for the note. */
export function buildReviewLoopDeps(
  ctx: ReviewLoopContext,
  invokeFn: InvokeFn = invoke,
): { deps: ReviewLoopDeps; getRunId: () => string | undefined } {
  let runId = ctx.runId;
  let round = 0;

  // gitInDir runs git commands in ctx.projectDir (the project being reviewed).
  const gitInDir = (args: string[]): string => {
    const opts: ExecFileSyncOptions = { cwd: ctx.projectDir, encoding: "utf8" };
    return execFileSync("git", args, opts).toString();
  };

  const preflight = (): void => {
    applyRoutePreflight({
      command: "forge review-loop", route: ctx.route, unrouted: ctx.unrouted,
      projectDir: ctx.projectDir, enforce: preflightEnforceFromEnv(),
    });
  };

  const DISALLOWED_RE = /^(backlog\/|docs\/|learnings\/)|^README/;

  const deps: ReviewLoopDeps = {
    verify: () => runVerification(ctx.scripts, { cwd: ctx.projectDir }),
    review: async (verification) => {
      preflight();
      const res = await invokeFn({
        agentRole: "red-wide", task: reviewTask(ctx.acceptance, ctx.diffProvider(), verification),
        projectDir: ctx.projectDir, readOnlyProject: true, runId,
        runTitle: `review-loop #${ctx.ticketId.replace(/^#/, "")}`, modelProfile: ctx.reviewProfile,
      });
      runId ??= res.runId;
      if (res.status !== "complete") return { ok: false, error: res.error ?? "reviewer dispatch failed" };
      const parsed = parseReviewerVerdict(res.result);
      return parsed.ok ? { ok: true, verdict: parsed.verdict, findings: parsed.findings } : { ok: false, error: `reviewer result.json invalid: ${parsed.error}` };
    },
    fix: async (findings) => {
      round++;
      preflight();
      const res = await invokeFn({
        agentRole: "engineer", task: fixTask(ctx.ticketId, findings),
        projectDir: ctx.projectDir, runId, modelProfile: ctx.implementProfile,
      });
      runId ??= res.runId;

      if (res.status !== "complete") {
        return { ok: false, error: res.error ?? "fixer dispatch failed" };
      }

      // Parse git status --porcelain -z (NUL-delimited, no C-quoting) to get changed
      // repo-relative paths. With default core.quotePath, --porcelain wraps non-ASCII
      // paths in double-quotes + octal escapes, breaking the DISALLOWED_RE prefix check.
      // -z emits literal UTF-8 paths. Format: "XY path\0" for normal entries;
      // "XY newpath\0oldpath\0" for renames/copies (R/C in either status column).
      const porcelain = gitInDir(["status", "--porcelain", "-z"]);
      const fields = porcelain.split("\0");
      const changed: string[] = [];
      let fi = 0;
      while (fi < fields.length) {
        const field = fields[fi]!;
        if (!field) { fi++; continue; }
        const xy = field.slice(0, 2);
        const filePath = field.slice(3);
        if (!filePath) { fi++; continue; }
        changed.push(filePath);
        // Rename/copy: next NUL-field is the old path (no XY prefix). Collect both
        // so a rename FROM a disallowed dir is also caught by the guard.
        if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
          fi++;
          const oldPath = fields[fi];
          if (oldPath) changed.push(oldPath);
        }
        fi++;
      }

      if (changed.length === 0) {
        return { ok: true };
      }

      const disallowed = changed.filter((p) => DISALLOWED_RE.test(p));
      if (disallowed.length > 0) {
        // The clean-tree precondition + per-round commits mean HEAD is the pre-round
        // state; resetting to it reverts only this round's changes safely.
        // Safe: loop entry requires resolveCommitRange to succeed (needs existing commits), so HEAD is born.
        gitInDir(["reset", "--hard", "HEAD"]);
        gitInDir(["clean", "-fd"]);
        return { ok: false, outOfScope: true, offendingPaths: disallowed };
      }

      // All changed paths are in scope — run verification before committing.
      const verification = runVerification(ctx.scripts, { cwd: ctx.projectDir });
      if (!verification.ok) {
        // Leave the diff for inspection; do NOT commit or revert.
        return { ok: false, verificationFailed: true, dirtyPaths: changed };
      }

      gitInDir(["add", "-A"]);
      gitInDir(["commit", "-m", `fix(review-loop): address ${ctx.ticketId} review findings (round ${round})`]);
      const sha = gitInDir(["rev-parse", "HEAD"]).trim();
      return { ok: true, committedSha: sha };
    },
  };
  return { deps, getRunId: () => runId };
}

// ── git diff + project helpers ───────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  const opts: ExecFileSyncOptions = { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  return execFileSync("git", args, opts).toString();
}

/** Build the diff under review. For an inferred span that includes unrelated
 *  commits, diff the SPECIFIC shas (git show per commit) rather than the span. */
function buildDiff(range: CommitRange, projectDir: string): string {
  if (range.mode === "none") return "";
  if (range.spansUnmatched) return range.shas.map((sha) => git(["show", sha], projectDir)).join("\n");
  return git(["diff", range.diffRange], projectDir);
}

/** Check that the working tree is clean. Returns true if clean; logs the
 *  refusal message, sets process.exitCode=1, and returns false if dirty. */
export function assertCleanWorkingTree(projectDir: string): boolean {
  const dirty = git(["status", "--porcelain"], projectDir).trim();
  if (!dirty) return true;
  console.error(
    `review-loop requires a clean working tree in ${projectDir} (commit or stash first). ` +
    `It commits each accepted fix round itself, so a dirty tree would conflate your changes with the fixer's.`,
  );
  process.exitCode = 1;
  return false;
}

function readScripts(projectDir: string): Record<string, unknown> {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function registerReviewLoop(program: Command, invokeFn?: InvokeFn): void {
  program
    .command("review-loop")
    .argument("<ticket-id>", "structured ticket id (e.g. FG-301) whose committed work to review")
    .option("--max-rounds <n>", "max review/fix rounds", (v) => parseInt(v, 10), 2)
    .option("--since <sha>", "review the commit range <sha>..HEAD instead of inferring from the ticket")
    .option("--project <dir>", "project dir (default: cwd) — holds backlog/, git repo, package.json")
    .option("--route <key>", "#297 resolved route key (preflight before every dispatch)")
    .option("--unrouted", "#297 acknowledge an intentionally unrouted loop")
    .option("--review-profile <name>", "model profile for the reviewer (red-wide)")
    .option("--implement-profile <name>", "model profile for the fixer (engineer)")
    .option("--dry-run", "present the plan (ticket, route, range, rounds, stop conditions) and exit — no dispatch")
    .description("Bounded reviewer→fixer loop for a ticket's committed work (#301). Never auto-closes the ticket.")
    .action(async (ticketIdArg: string, opts: {
      maxRounds: number; since?: string; project?: string; route?: string;
      unrouted?: boolean; reviewProfile?: string; implementProfile?: string; dryRun?: boolean;
    }) => {
      ensureForgeDirs();
      const projectDir = resolve(opts.project ?? process.cwd());
      const ticketId = ticketIdArg.replace(/^#/, "").trim();

      const ticket = readTicket(projectDir, ticketId);

      // Infer commits from the PROJECT repo, not Forge's launch dir.
      const range = resolveCommitRange(ticketId, { since: opts.since, git: (gitArgs) => git(gitArgs, projectDir) });
      if (range.mode === "none") {
        throw new Error(`no commits reference ${ticketId} (and no --since). Pass --since <sha> to set the range.`);
      }
      const originalDiff = buildDiff(range, projectDir);

      // Present (guardrail): ticket, route, range, rounds, stop conditions.
      const spanNote = range.spansUnmatched ? `, spans unrelated commits → diffing the ${range.shas.length} ticket shas` : "";
      console.log(`review-loop: ${ticket.id} — ${ticket.title}`);
      console.log(`  route:        ${opts.route ?? "(none — unrouted)"}`);
      console.log(`  commit range: ${range.diffRange} (${range.mode}${spanNote})`);
      console.log(`  max rounds:   ${opts.maxRounds}`);
      console.log(`  reviewer:     red-wide (read-only)   fixer: engineer`);
      console.log(`  stops on:     passed | blocked_by_reviewer | needs_fix_max_rounds | verification_failed | fixer_failed | fixer_out_of_scope | reviewer_failed`);
      console.log(`  never auto-closes the ticket; reports whether it's closeable.`);
      if (opts.dryRun) { console.log("\n(dry run — no dispatch)"); return; }

      // Clean-tree precondition: the fixer commits each accepted round, and an
      // out-of-scope revert resets to HEAD. Both operations are mechanically safe
      // ONLY when the tree was clean at loop start — a dirty tree would conflate
      // the user's uncommitted changes with the fixer's round changes.
      if (!assertCleanWorkingTree(projectDir)) return;

      // Fail fast on a bogus route before any dispatch (also enforced per-round).
      applyRoutePreflight({ command: "forge review-loop", route: opts.route, unrouted: opts.unrouted, projectDir, enforce: preflightEnforceFromEnv() });

      const startHead = git(["rev-parse", "HEAD"], projectDir).trim();
      const diffProvider = (): string => {
        const head = git(["rev-parse", "HEAD"], projectDir).trim();
        if (head === startHead) return originalDiff;
        const fixerCommits = git(["diff", `${startHead}..${head}`], projectDir);
        return `${originalDiff}\n\n## Fixer commits since review start (${startHead.slice(0, 9)}..${head.slice(0, 9)})\n${fixerCommits}`;
      };

      const { deps, getRunId } = buildReviewLoopDeps({
        ticketId,
        acceptance: `${ticket.id} — ${ticket.title}\n\n${ticket.body}`,
        diffProvider, projectDir, scripts: readScripts(projectDir),
        route: opts.route, unrouted: opts.unrouted,
        reviewProfile: opts.reviewProfile, implementProfile: opts.implementProfile,
      }, invokeFn ?? invoke);

      const outcome = await runReviewLoop({ maxRounds: opts.maxRounds }, deps);
      const note = renderReviewLoopNote({ ticketId, route: opts.route, maxRounds: opts.maxRounds, range }, outcome);

      const runId = getRunId();
      if (runId) {
        const notePath = join(runDir(runId), "review-loop.md");
        if (existsSync(runDir(runId))) writeFileSync(notePath, note);
        console.log(`\n${note}\nnote: ${notePath}`);
      } else {
        console.log(`\n${note}`);
      }

      if (outcome.closeable) {
        console.log(`\n✓ closeable — reviewer passed AND verification is green. Close with:  forge backlog close ${ticketId}`);
      } else {
        console.log(`\n✗ not closeable — stop reason: ${outcome.stopReason}. The ticket is left open.`);
        process.exitCode = 1;
      }
    });
}
