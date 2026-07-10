// #301 slice 6: `forge review-loop <ticket-id>` — wire the pure engine
// (src/v2/review-loop.ts) to real dispatch. Reviewer = red-wide (read-only),
// fixer = engineer, host verification. #297 route preflight runs before EVERY
// dispatch. Never auto-closes the ticket (reports `closeable`); never runs spend/
// migration/destructive surface — it only invokes reviewer/fixer agents.

import type { Command } from "commander";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ensureForgeDirs, runDir } from "../../util/paths.js";
import { invoke, createInvokeRun, type InvokeArgs, type InvokeResult } from "../../v2/invoke.js";
import { finalizeRunIfSettled } from "../../v2/run-finalize.js";
import { tasksForRun } from "../../store/tasks.js";
import { readTicket } from "../../backlog/structured.js";
import { applyRoutePreflight, preflightEnforceFromEnv } from "../route-preflight.js";
import {
  resolveCommitRange, runVerification, runReviewLoop, renderReviewLoopNote, parseReviewerVerdict,
  type CommitRange, type ReviewLoopDeps, type VerificationResult, type Finding,
  type ReviewedTipTrust, type RevertedPathGuidance, type GitRunner,
} from "../../v2/review-loop.js";
import { getRequiredHostGate } from "../../campaign/reconcile-collect.js";
import {
  findCoveringGateEvidence, describeGateEvidence, deriveRequiredGateList, probeCiGateStatus,
  type CheckStatusProvider, type CiGateStatus,
} from "../../store/host-verifications.js";
import { logEvent } from "../../store/events.js";
import { newAttemptId } from "../../util/ids.js";

type InvokeFn = (args: InvokeArgs) => Promise<InvokeResult>;
type RunVerificationFn = typeof runVerification;
type SleepFn = (ms: number) => Promise<void>;

// FG-501: review-loop must consume in-flight CI as the verification authority
// rather than starting duplicate local work. Defaults chosen for an unattended
// review pass: check every 30s, give up after 20 minutes (a project's CI is
// expected to complete well inside that window; a genuinely stuck/misconfigured
// CI run should fall back to local rather than hang the loop indefinitely).
// Both are operator-overridable per invocation via env vars.
const CI_POLL_SECONDS_ENV = "FORGE_CI_POLL_SECONDS";
const CI_WAIT_TIMEOUT_SECONDS_ENV = "FORGE_CI_WAIT_TIMEOUT_SECONDS";
const DEFAULT_CI_POLL_SECONDS = 30;
const DEFAULT_CI_WAIT_TIMEOUT_SECONDS = 20 * 60;

function positiveIntEnvSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const defaultSleep: SleepFn = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function describeCiChecks(checks: { context: string; url?: string }[]): string {
  return checks.map((c) => (c.url ? `${c.context} (${c.url})` : c.context)).join(", ");
}

// FG-487 AC2: the verification_finished event must carry the required CI check
// contexts (ci_wait) or the command/tier actually run (local) — not just
// ok/ciOutcome — so the dashboard can render what was actually verified.
// Kept as a local extension of VerificationResult (not a change to the shared
// v2/review-loop.ts contract) since these fields are event/telemetry detail,
// not part of the engine's own pass/fail decision.
type VerificationResultWithDetail = VerificationResult & {
  checkContexts?: string[];
  command?: string;
  tier?: "fast" | "extended";
};

function tierFromSteps(steps: { name: string }[]): "fast" | "extended" | undefined {
  if (steps.length === 0) return undefined;
  return steps.some((s) => s.name === "test:extended") ? "extended" : "fast";
}
function commandFromSteps(steps: { name: string }[]): string | undefined {
  return steps.length === 0 ? undefined : steps.map((s) => `npm run ${s.name}`).join(" && ");
}

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
    "- STALE CLOSEOUT TEXT (already-closed tickets only): when the diff CLOSES a ticket — moves it to `backlog/done/` — its committed closeout text must not retain open-ticket status language: `Deferred`, `not urgent`, `TODO`, `not in scope yet`, or future-tense plans. Stale closeout wording on an ALREADY-CLOSED ticket (a file under `backlog/done/`) is a finding.",
    "- THE TICKET UNDER REVIEW IS EXPECTED TO BE OPEN: the ticket whose work you are reviewing is EXPECTED to still live in `backlog/stories/` with `status: active` until the orchestrator closes it AFTER merge + verification. Do NOT raise its still-active / still-in-stories state as a finding, and do NOT recommend `forge backlog close`, moving it to `backlog/done/`, or setting its status to `done` — that closeout is the orchestrator's post-merge job, not fixer work. The loop withholds any such finding from the fixer and surfaces it to the orchestrator as closeout guidance, so raising it as a fix only adds noise.",
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
    "Never edit `backlog/` ticket files and never run `forge backlog close`/`move` or mark this ticket done/closed — ticket closeout is the orchestrator's job after merge, and such changes are rejected as out-of-scope.",
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
  /** FG-474: injectable for tests — see buildReviewLoopDeps.verify. Defaults to
   *  the real gh-backed provider when omitted. */
  checkStatusProvider?: CheckStatusProvider;
  /** FG-501: injectable for tests — the local verification runner
   *  verifyWithReuse falls back to. Defaults to the real runVerification, so
   *  tests can assert it was (or wasn't) invoked without spawning real
   *  subprocesses. */
  runVerification?: RunVerificationFn;
  /** FG-501: injectable for tests — the delay between CI polls while waiting on
   *  pending checks. Defaults to a real setTimeout-based sleep. */
  sleep?: SleepFn;
  /** FG-501: injectable for tests — wall-clock source for the CI wait's elapsed/
   *  timeout accounting. Defaults to Date.now. */
  now?: () => number;
  /** FG-501: injectable for tests — overrides FORGE_CI_POLL_SECONDS. */
  ciPollMs?: number;
  /** FG-501: injectable for tests — overrides FORGE_CI_WAIT_TIMEOUT_SECONDS. */
  ciWaitTimeoutMs?: number;
  /** FG-501 (AC5): --local-extended opt-in. The review-loop's local CI-
   *  unavailable/failed-precondition/timeout fallback AND the fixer's
   *  post-change pre-commit verification run the FAST gate only (typecheck +
   *  test, no test:extended) by default — extended coverage is delegated to
   *  CI. This restores the full local tier (equivalent to today's
   *  scriptsForVerification()) for operators who explicitly want it. Does NOT
   *  affect the dirty-tree fallback (unchanged) or scriptsForVerification's
   *  FG-500 derived-gate semantics for other callers. */
  localExtended?: boolean;
  /** FG-502: docs/learnings/README paths already touched by the reviewed
   *  commit range — computed ONCE at loop start (see computeInRangeDocsPaths)
   *  and fixed for the whole loop, never recomputed per round or against a
   *  moving HEAD. Paths in this set are treated as in-scope for the fixer;
   *  paths matching the docs/learnings/README class but absent from this set
   *  are reverted. Defaults to an empty set (nothing in range) when omitted —
   *  matches the pre-FG-502 always-disallowed behavior. Backlog/ticket-closeout
   *  paths are NEVER in this set's concern — they stay unconditionally
   *  disallowed regardless of range membership. */
  inRangeDocsPaths?: Set<string>;
  /** FG-502: injectable for tests — the git command runner used for the fixer's
   *  scope-guard revert/verify (git status/checkout/rm/clean). Defaults to a
   *  real execFileSync("git", ...) call in ctx.projectDir. Lets a test inject a
   *  spy that fails ONE specific revert call (a git lock/permissions/disk
   *  failure) without shelling out to a real broken git. */
  gitRunner?: GitRunner;
};

// FG-502: scope-guard classification. Two independent disallowed classes;
// the operator clarification recorded in the ticket's Non-Goals is that "the
// guard" means the CLASSIFICATION below plus the FG-462 closeout-finding
// withholding channel — NOT a whole-round blast radius for either class.
// (a) backlog/ and ticket-closeout paths — CLASSIFICATION unchanged from
//     FG-462 semantics: always out of scope, range-membership irrelevant.
//     The FG-462 closeout-finding withholding channel is untouched.
// (b) docs/, learnings/, README paths — disallowed ONLY when NOT already
//     touched by the loop-start reviewed commit range (ctx.inRangeDocsPaths).
// ENFORCEMENT is PATH-LEVEL for BOTH classes (FG-502 AC2): a violation mixed
// with a surviving in-scope change from the same round does NOT abort the
// round — only the offending path(s) are reverted (verified via the scoped
// re-verify below), the survivor is verified + committed, and the revert is
// reported as guidance (see revertedPaths). Only when NOTHING survives the
// revert does the round fall back to the full-abort outOfScope shape.
const BACKLOG_CLOSEOUT_RE = /^backlog\//;
const DOCS_LEARNINGS_README_RE = /^(docs\/|learnings\/)|^README/;

/** Non-null iff `path` is out of scope for the fixer; the string is the
 *  operator-facing reason surfaced as reverted-path guidance. */
function disallowedReason(path: string, inRangeDocsPaths: Set<string>): string | null {
  if (BACKLOG_CLOSEOUT_RE.test(path)) {
    return "backlog/ and ticket-closeout paths are always out of scope for the fixer (orchestrator post-merge job)";
  }
  if (DOCS_LEARNINGS_README_RE.test(path) && !inRangeDocsPaths.has(path)) {
    return "docs/learnings/README path not touched by the reviewed commit range";
  }
  return null;
}

// A single git-status change, grouped so a rename/copy is always classified
// and reverted as ONE unit (either side matching disallowed reverts BOTH
// sides — recreating the old path and removing the new one — never just the
// disallowed half, which would otherwise leave a duplicate/orphaned path).
type PorcelainChange =
  | { kind: "simple"; path: string; existsAtHead: boolean }
  | { kind: "rename"; newPath: string; oldPath: string };

/** Parse `git status --porcelain -z` (NUL-delimited, no C-quoting) into
 *  repo-relative changes. With default core.quotePath, --porcelain wraps
 *  non-ASCII paths in double-quotes + octal escapes, breaking prefix checks;
 *  -z emits literal UTF-8 paths. Format: "XY path\0" for normal entries;
 *  "XY newpath\0oldpath\0" for renames/copies (R/C in either status column). */
function parsePorcelainChanges(porcelain: string): PorcelainChange[] {
  const fields = porcelain.split("\0");
  const changes: PorcelainChange[] = [];
  let fi = 0;
  while (fi < fields.length) {
    const field = fields[fi]!;
    if (!field) { fi++; continue; }
    const xy = field.slice(0, 2);
    const filePath = field.slice(3);
    if (!filePath) { fi++; continue; }
    const isRenameOrCopy = xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C";
    if (isRenameOrCopy) {
      fi++;
      const oldPath = fields[fi];
      if (oldPath) changes.push({ kind: "rename", newPath: filePath, oldPath });
      fi++;
      continue;
    }
    // Only a newly-added (staged 'A') or untracked ('??') path is absent from
    // HEAD; M/D (and any other combination) mean the path existed at HEAD.
    const existsAtHead = !xy.includes("A") && !xy.includes("?");
    changes.push({ kind: "simple", path: filePath, existsAtHead });
    fi++;
  }
  return changes;
}

/** FG-502: paths under docs/, learnings/, README* already touched by the
 *  reviewed commit range — computed ONCE at loop start (before
 *  buildReviewLoopDeps is constructed) and threaded in as
 *  ctx.inRangeDocsPaths; never recomputed per round or against a moving HEAD. */
export function computeInRangeDocsPaths(range: CommitRange, projectDir: string): Set<string> {
  if (range.mode === "none") return new Set();
  const nameOnly = (args: string[]): string[] =>
    git(args, projectDir).split("\n").map((s) => s.trim()).filter(Boolean);
  const paths = range.spansUnmatched
    ? range.shas.flatMap((sha) => nameOnly(["show", "--name-only", "--format=", sha]))
    : nameOnly(["diff", "--name-only", range.diffRange]);
  return new Set(paths.filter((p) => DOCS_LEARNINGS_README_RE.test(p)));
}

// ── FG-502: reviewed-tip-vs-remote trust check, tightened by FG-514 ──────────
//
// Two invariants, both feeding the closeable verdict (and therefore merge
// authorization), both fail-closed:
//
// 1. EQUALITY, not ancestry. The reviewed tip must BE the remote head: no
//    commits in `<remoteRef>..<tip>` (local-only work the remote never saw)
//    AND none in `<tip>..<remoteRef>` (commits the reviewer never saw). The
//    original FG-502 check was one-directional (`merge-base --is-ancestor
//    <tip> <remoteRef>`), so a remote strictly AHEAD of the reviewed tip still
//    passed — closeable would authorize merging never-reviewed commits.
//    An ahead-count is never a substitute for either direction: it can't
//    distinguish "pushed to a different remote branch" from "local only".
//
// 2. The REAL remote head, not a stale cache. Before comparing, the single
//    remote-tracking ref is refreshed with a bounded, quiet fetch of ONLY that
//    ref (never `fetch --all`, never tags). A cached `@{u}` can lag reality
//    arbitrarily, and comparing against it would trust a tip the remote has
//    long since moved past. If that fetch fails (offline, no remote, auth),
//    the outcome is remote_unavailable — never a silent comparison against the
//    stale cache.
//
// The candidate order (`@{u}` before `origin/HEAD`) deliberately differs from
// claude.ts's statusBanner ahead-of-origin helper, which checks the opposite
// order for an unrelated purpose (an ahead-count against the default branch,
// not a PR-head equality check).

/** Bounded so a hung/prompting remote can never wedge the loop's final report. */
const FETCH_TIMEOUT_MS = 20_000;

/** Resolve the remote-tracking ref for the current branch: the branch's
 *  configured upstream (`@{u}`) first, falling back to `origin/HEAD` only when
 *  no upstream is configured. `origin/HEAD` virtually always resolves (it
 *  tracks the default branch, e.g. `origin/main`), so checking it first would
 *  compare a pre-merge feature-branch tip against main, where it can never be
 *  equal — permanently untrusted even after pushing. `@{u}` names the actual
 *  ref the branch is (or will be) merged via, so it must be tried first.
 *  Resolution is against the local ref store; fetchRemoteRef then refreshes
 *  whichever candidate won. A ref with no local entry at all resolves to
 *  undefined (there is nothing to name as a fetch target). */
function resolveRemoteRef(projectDir: string): string | undefined {
  for (const ref of ["@{u}", "origin/HEAD"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
        cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      return ref;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

/** The (remote, single refspec) pair that refreshes exactly `remoteRef`. For
 *  `@{u}` that's the branch's configured remote + merge ref; for the
 *  `origin/HEAD` fallback it's origin's default branch. Throws if any of the
 *  config/symbolic-ref lookups are missing — the caller treats that as a fetch
 *  failure (fail closed), which is also what a non-symbolic `origin/HEAD`
 *  lands on: there is no branch name to fetch, so the head can't be verified. */
function fetchTarget(remoteRef: string, projectDir: string): { remote: string; refspec: string } {
  if (remoteRef === "@{u}") {
    const branch = git(["symbolic-ref", "--short", "HEAD"], projectDir).trim();
    const remote = git(["config", `branch.${branch}.remote`], projectDir).trim();
    const merge = git(["config", `branch.${branch}.merge`], projectDir).trim();
    const dst = git(["rev-parse", "--symbolic-full-name", "@{u}"], projectDir).trim();
    return { remote, refspec: `+${merge}:${dst}` };
  }
  const dst = git(["symbolic-ref", "refs/remotes/origin/HEAD"], projectDir).trim();
  const branch = dst.replace(/^refs\/remotes\/origin\//, "");
  return { remote: "origin", refspec: `+refs/heads/${branch}:${dst}` };
}

function fetchErrorText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e.stderr ? e.stderr.toString().trim() : "";
  const first = (stderr || e.message || "git fetch failed").split("\n")[0] ?? "git fetch failed";
  return first.slice(0, 200);
}

/** Refresh exactly `remoteRef` from its remote. Returns undefined on success,
 *  or a one-line failure reason. `GIT_TERMINAL_PROMPT=0` keeps an auth-gated
 *  remote from blocking on a credential prompt instead of failing. */
function fetchRemoteRef(remoteRef: string, projectDir: string): string | undefined {
  let target: { remote: string; refspec: string };
  try {
    target = fetchTarget(remoteRef, projectDir);
  } catch (err) {
    return fetchErrorText(err);
  }
  try {
    execFileSync("git", ["fetch", "--quiet", "--no-tags", target.remote, target.refspec], {
      cwd: projectDir, encoding: "utf8", timeout: FETCH_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return undefined;
  } catch (err) {
    return fetchErrorText(err);
  }
}

function commitsIn(range: string, projectDir: string): { sha: string; subject: string }[] {
  return git(["log", "--format=%h %s", range], projectDir)
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(" ");
      return idx === -1 ? { sha: line, subject: "" } : { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
    });
}

/** Resolve the reviewed-tip trust fact for the final report/closeable verdict.
 *  Five outcomes: trusted (the tip IS the freshly-fetched remote head — both
 *  directions empty); local_only (the tip carries commits the remote lacks);
 *  remote_ahead (the remote head carries commits the reviewer never saw);
 *  diverged (both directions non-empty); remote_unavailable (no resolvable
 *  remote-tracking ref, or the bounded fetch failed so the real remote head is
 *  unknown). Only "trusted" permits closeable — every other outcome, including
 *  a failed fetch over a cached ref, withholds it. */
export function resolveReviewedTipTrust(projectDir: string, reviewedTipSha: string): ReviewedTipTrust {
  const remoteRef = resolveRemoteRef(projectDir);
  if (!remoteRef) return { kind: "remote_unavailable" };
  const fetchError = fetchRemoteRef(remoteRef, projectDir);
  if (fetchError) return { kind: "remote_unavailable", remoteRef, fetchError };

  const localCommits = commitsIn(`${remoteRef}..${reviewedTipSha}`, projectDir);
  const unreviewedCommits = commitsIn(`${reviewedTipSha}..${remoteRef}`, projectDir);
  if (localCommits.length > 0 && unreviewedCommits.length > 0) {
    return { kind: "diverged", remoteRef, localCommits, unreviewedCommits };
  }
  if (localCommits.length > 0) return { kind: "local_only", remoteRef, localCommits };
  if (unreviewedCommits.length > 0) return { kind: "remote_ahead", remoteRef, unreviewedCommits };
  return { kind: "trusted", remoteRef };
}

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
  // ctx.gitRunner is injectable for tests (see ReviewLoopContext.gitRunner) —
  // defaults to a real execFileSync("git", ...) call.
  const gitInDir: GitRunner = ctx.gitRunner ?? ((args: string[]): string => {
    const opts: ExecFileSyncOptions = { cwd: ctx.projectDir, encoding: "utf8" };
    return execFileSync("git", args, opts).toString();
  });

  const preflight = (): void => {
    applyRoutePreflight({
      command: "forge review-loop", route: ctx.route, unrouted: ctx.unrouted,
      projectDir: ctx.projectDir, enforce: preflightEnforceFromEnv(),
    });
  };

  const inRangeDocsPaths = ctx.inRangeDocsPaths ?? new Set<string>();

  // FG-500 regression fix: runVerification adds test:extended whenever the
  // script is present in `scripts`, with no notion of "is this project's
  // required gate still the default". Gate it here — the same way
  // findCoveringGateEvidence / reconcile's real-exec fallback / done-audit do
  // via deriveRequiredGateList — so a CUSTOM requiredHostGate project that
  // happens to define an unrelated test:extended script still gets
  // single-gate (typecheck+test) fallback verification, unchanged.
  const scriptsForVerification = (): Record<string, unknown> => {
    const requiredGate = getRequiredHostGate(ctx.projectDir);
    const extendedIsRequired = deriveRequiredGateList(ctx.projectDir, requiredGate).length > 1;
    if (extendedIsRequired) return ctx.scripts;
    const { "test:extended": _dropped, ...rest } = ctx.scripts;
    return rest;
  };

  const runVerify = ctx.runVerification ?? runVerification;
  const sleep = ctx.sleep ?? defaultSleep;
  const now = ctx.now ?? Date.now;
  const pollMs = ctx.ciPollMs ?? positiveIntEnvSeconds(CI_POLL_SECONDS_ENV, DEFAULT_CI_POLL_SECONDS) * 1000;
  const waitTimeoutMs = ctx.ciWaitTimeoutMs ?? positiveIntEnvSeconds(CI_WAIT_TIMEOUT_SECONDS_ENV, DEFAULT_CI_WAIT_TIMEOUT_SECONDS) * 1000;

  // FG-501: the local fallback the review-loop CI-consuming path runs when CI is
  // unavailable/failed-precondition/timed out. Fast-tier only (typecheck+test) by
  // default — test:extended belongs to CI (AC5) — UNLESS --local-extended asks for
  // the full tier scriptsForVerification() would otherwise produce.
  const localFallbackScripts = (): Record<string, unknown> => {
    const scripts = scriptsForVerification();
    if (ctx.localExtended) return scripts;
    const { "test:extended": _dropped, ...rest } = scripts;
    return rest;
  };

  // FG-474: one canonical deterministic gate per commit — before actually running
  // typecheck+test, check whether covering evidence for HEAD already exists (a
  // passing host_verifications row, or a green required CI check) and reuse it.
  // Reuse REQUIRES a clean working tree (a dirty tree never reuses — the diff under
  // review wouldn't match what any recorded/CI evidence actually covers).
  //
  // FG-501: when no covering evidence exists yet, don't immediately duplicate CI
  // by running locally — probe the required CI gate's STATUS first. Pending →
  // wait/poll (bounded) and reuse once green. Failed → report the deterministic
  // failure directly from CI evidence, no local run. Only a genuinely unavailable
  // CI setup (or a wait that times out) falls back to a real local run.
  const verifyWithReuse = async (): Promise<VerificationResultWithDetail> => {
    const dirty = gitInDir(["status", "--porcelain"]).trim().length > 0;
    if (dirty) {
      console.log("review-loop: dirty tree — local verification");
      const result = runVerify(scriptsForVerification(), { cwd: ctx.projectDir });
      return { ...result, command: commandFromSteps(result.steps), tier: tierFromSteps(result.steps) };
    }

    const headSha = gitInDir(["rev-parse", "HEAD"]).trim();
    const requiredGate = getRequiredHostGate(ctx.projectDir);

    // Populated whenever a CI check context becomes known (pending poll, a
    // failing check, or CI-sourced covering evidence) so the finish event can
    // report what was actually required — never invented for the host_row /
    // local-only paths, where no CI check context exists.
    let checkContexts: string[] | undefined;

    const tryReuse = (): VerificationResultWithDetail | null => {
      const evidence = findCoveringGateEvidence({
        ticketId: ctx.ticketId, projectDir: ctx.projectDir, sha: headSha,
        command: requiredGate, checkStatusProvider: ctx.checkStatusProvider,
      });
      if (!evidence) return null;
      if (evidence.source === "ci") checkContexts = evidence.checks.map((c) => c.context);
      const description = describeGateEvidence(evidence);
      return { ok: true, steps: [{ name: "reused", ok: true, output: description }], reusedEvidence: description };
    };

    const immediate = tryReuse();
    if (immediate) return checkContexts ? { ...immediate, checkContexts } : immediate;

    const probe = (): CiGateStatus => probeCiGateStatus({
      projectDir: ctx.projectDir, sha: headSha, command: requiredGate, checkStatusProvider: ctx.checkStatusProvider,
    });

    const shortSha = headSha.slice(0, 9);
    const startedAt = now();
    let status = probe();
    let waited = false;

    while (status.kind === "pending") {
      checkContexts = status.checks.map((c) => c.context);
      const elapsedSeconds = Math.round((now() - startedAt) / 1000);
      console.log(
        `review-loop: CI pending for ${shortSha} — waiting on: ${describeCiChecks(status.checks)} ` +
        `(elapsed ${elapsedSeconds}s, polling every ${Math.round(pollMs / 1000)}s, timeout ${Math.round(waitTimeoutMs / 1000)}s)`,
      );
      if (now() - startedAt >= waitTimeoutMs) {
        status = { kind: "unavailable", reason: `CI wait timed out after ${Math.round(waitTimeoutMs / 1000)}s — still pending: ${describeCiChecks(status.checks)}` };
        break;
      }
      waited = true;
      await sleep(pollMs);
      status = probe();
    }

    if (status.kind === "success") {
      const reused = tryReuse();
      if (reused) {
        return waited ? { ...reused, ciOutcome: { kind: "reused_after_wait" }, checkContexts } : { ...reused, checkContexts };
      }
      // CI reports every job green but the covering-evidence lookup still fails
      // closed (e.g. a race between the check going green and the row landing) —
      // never invent evidence; fall back to a local run like any other unavailable case.
      status = { kind: "unavailable", reason: "CI reported all required checks green but covering evidence could not be confirmed" };
    }

    if (status.kind === "failed") {
      checkContexts = [status.failing.context];
      const urlSuffix = status.failing.url ? ` — ${status.failing.url}` : "";
      const message = `required CI check "${status.failing.context}" failed for ${shortSha}${urlSuffix}`;
      console.log(`review-loop: ${message} (no local run)`);
      return {
        ok: false,
        steps: [{ name: status.failing.context, ok: false, output: message }],
        ciOutcome: { kind: "ci_failed", context: status.failing.context, url: status.failing.url },
        checkContexts,
      };
    }

    console.log(`review-loop: CI unavailable: ${status.reason} — falling back to local verification.`);
    const extendedDelegatedToCi = !ctx.localExtended;
    const result = runVerify(localFallbackScripts(), { cwd: ctx.projectDir });
    return {
      ...result, ciOutcome: { kind: "local_fallback", reason: status.reason, extendedDelegatedToCi },
      command: commandFromSteps(result.steps), tier: tierFromSteps(result.steps),
    };
  };

  // FG-487: every round's verification (the FG-501 CI-wait poll, or the local
  // typecheck+test fallback) previously left no durable trace between rounds —
  // only the reviewer/fixer task rows around it were ever visible. Wrap
  // verifyWithReuse in a start/finish event pair per round, keyed by a fresh
  // attemptId so a crashed-and-restarted round at the same round/ticket/sha
  // identity is never mispaired with the wrong finish (see newAttemptId).
  // `mode` is coarse (known before verifyWithReuse resolves any of its
  // sub-branches): "local" for a dirty tree (verifyWithReuse never consults CI
  // for a dirty tree — see its own dirty check), "ci_wait" for a clean tree
  // (which always consults covering evidence / CI status first, whether it
  // resolves instantly via reuse, waits on pending CI, or falls back to a real
  // local run) — the finish event's ciOutcome/reusedEvidence carry the actual
  // sub-branch taken.
  let verificationRound = 0;
  const verifyWithEvents = async (): Promise<VerificationResult> => {
    verificationRound++;
    const attemptId = newAttemptId();
    const dirty = gitInDir(["status", "--porcelain"]).trim().length > 0;
    let sha: string | undefined;
    try {
      sha = gitInDir(["rev-parse", "HEAD"]).trim();
    } catch {
      sha = undefined;
    }
    const mode: "local" | "ci_wait" = dirty ? "local" : "ci_wait";
    logEvent("review_loop.verification_started", {
      runId,
      payload: { attemptId, round: verificationRound, ticketId: ctx.ticketId, sha, mode },
    });
    const result = await verifyWithReuse();
    logEvent("review_loop.verification_finished", {
      runId,
      payload: {
        attemptId, round: verificationRound, ticketId: ctx.ticketId, sha, mode,
        ok: result.ok,
        reusedEvidence: result.reusedEvidence ?? null,
        ciOutcome: result.ciOutcome ?? null,
        // AC2: ci_wait's required check contexts, local's command/tier — the
        // dashboard detail line these fields exist for (see main.js's
        // reviewLoopVerificationDetail).
        checkContexts: result.checkContexts ?? null,
        command: result.command ?? null,
        tier: result.tier ?? null,
        steps: result.steps.map((s) => ({ name: s.name, ok: s.ok })),
      },
    });
    return result;
  };

  const deps: ReviewLoopDeps = {
    verify: () => verifyWithEvents(),
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

      // FG-502 round 2: every git call from here through the final commit is
      // CONTAINED in one try — a throw from ANY of them (the scope-guard status
      // scans, the scoped revert re-verify, the final 'remaining' check, or the
      // add/commit/rev-parse sequence) must never escape fix() uncaught (that
      // crashed the loop with a generic 'exception' stopReason and no recorded
      // round state). `stage` names the call in flight so a catch records WHICH
      // one failed; `toRevert` is declared outside the try so a catch can still
      // report the affected/unverified paths even if the throw happened before
      // the scoped re-verify ran. Any throw here becomes a recorded, fail-safe
      // round failure via the same scope_guard_revert_failed shape the verified
      // -failed-revert case already uses — never a false commit claim.
      const toRevert: { path: string; existsAtHead: boolean; reason: string }[] = [];
      let stage = "scope-guard status scan";
      try {
        // --untracked-files=all: without it, a wholly-new untracked directory
        // collapses to a single "?? dir/" entry instead of listing its files
        // individually — the scope guard needs per-file granularity so a
        // disallowed file's specific path (not just its parent dir) is what
        // gets classified, reverted, and named in operator-facing guidance.
        const changes = parsePorcelainChanges(gitInDir(["status", "--porcelain", "--untracked-files=all", "-z"]));
        if (changes.length === 0) {
          return { ok: true };
        }

        // FG-502: classify each change; a rename/copy is reverted as ONE unit if
        // EITHER side is disallowed (recreate the old path, remove the new one) —
        // never just the disallowed half, which would otherwise leave a
        // duplicate/orphaned path behind.
        for (const c of changes) {
          if (c.kind === "simple") {
            const reason = disallowedReason(c.path, inRangeDocsPaths);
            if (reason) toRevert.push({ path: c.path, existsAtHead: c.existsAtHead, reason });
          } else {
            const reason = disallowedReason(c.newPath, inRangeDocsPaths) ?? disallowedReason(c.oldPath, inRangeDocsPaths);
            if (reason) {
              toRevert.push({ path: c.oldPath, existsAtHead: true, reason });
              toRevert.push({ path: c.newPath, existsAtHead: false, reason });
            }
          }
        }

        // The clean-tree precondition + per-round commits mean HEAD is the
        // pre-round state, so a per-path revert against HEAD is safe: `checkout
        // HEAD -- <path>` restores a path that existed at HEAD (index + worktree);
        // a path absent from HEAD (newly added/untracked, or a rename's new half)
        // is removed instead — `git rm` unstages it if indexed, `git clean -f`
        // removes any untracked leftover either way.
        //
        // Each path's revert is CONTAINED: a thrown exception here never escapes
        // the per-path loop (finding 2 — a mid-loop throw must not stop other
        // paths from being attempted). It is NOT silently swallowed either
        // (finding 1) — `git rm --ignore-unmatch`/`git clean -fd` already exit 0
        // on their benign no-op cases, so nothing legitimate is ever caught here;
        // the scoped verify step below is the sole source of truth for whether a
        // path actually reverted, regardless of whether the attempt threw.
        stage = "per-path revert attempts";
        for (const r of toRevert) {
          try {
            if (r.existsAtHead) {
              gitInDir(["checkout", "HEAD", "--", r.path]);
            } else {
              gitInDir(["rm", "-f", "--ignore-unmatch", "--", r.path]);
              gitInDir(["clean", "-fd", "--", r.path]);
            }
          } catch {
            // Verified below.
          }
        }

        // Never trust the attempted revert on its own — VERIFY each to-revert
        // path is actually clean/absent before it's allowed into revertedPaths
        // or a commit. Scoped to just these paths so an unrelated in-scope
        // change elsewhere in the tree doesn't mask a failed revert.
        stage = "scoped revert re-verification";
        const failedRevertPaths = toRevert.length === 0 ? [] : [
          ...new Set(
            parsePorcelainChanges(
              gitInDir(["status", "--porcelain", "--untracked-files=all", "-z", "--", ...toRevert.map((r) => r.path)]),
            ).flatMap((c) => (c.kind === "simple" ? [c.path] : [c.oldPath, c.newPath])),
          ),
        ];

        if (failedRevertPaths.length > 0) {
          // FAIL SAFE: at least one disallowed path could not be verified
          // reverted — never stage/commit over an unverified tree (that would
          // silently ship a disallowed path via the blanket `git add -A` below).
          // Stop the round; the tree is left as-is for inspection.
          return { ok: false, scopeGuardRevertFailed: true, failedRevertPaths };
        }

        const revertedPaths: RevertedPathGuidance[] = toRevert.map((r) => ({ path: r.path, reason: r.reason }));

        stage = "remaining-changes check";
        const remaining = gitInDir(["status", "--porcelain", "--untracked-files=all", "-z"]).trim();

        if (!remaining) {
          // Nothing survived the revert — same full-abort shape as before FG-502
          // (distinct from revertedPaths' partial-survival shape below).
          if (revertedPaths.length > 0) {
            return { ok: false, outOfScope: true, offendingPaths: revertedPaths.map((r) => r.path) };
          }
          return { ok: true };
        }

        // In-scope changes from this round survive the revert — verify + commit
        // them normally rather than aborting the whole round. Fast tier by
        // default (FG-501 AC5): the fixer's commit gets pushed and CI runs
        // test:extended as a required check; --local-extended restores the full tier.
        stage = "post-revert verification";
        const verification = runVerify(localFallbackScripts(), { cwd: ctx.projectDir });
        if (!verification.ok) {
          const dirtyPaths = parsePorcelainChanges(gitInDir(["status", "--porcelain", "--untracked-files=all", "-z"]))
            .flatMap((c) => (c.kind === "simple" ? [c.path] : [c.oldPath, c.newPath]));
          // Leave the diff for inspection; do NOT commit or revert further.
          return { ok: false, verificationFailed: true, dirtyPaths };
        }

        stage = "add/commit/rev-parse";
        gitInDir(["add", "-A"]);
        gitInDir(["commit", "-m", `fix(review-loop): address ${ctx.ticketId} review findings (round ${round})`]);
        const sha = gitInDir(["rev-parse", "HEAD"]).trim();
        return revertedPaths.length > 0
          ? { ok: true, committedSha: sha, revertedPaths }
          : { ok: true, committedSha: sha };
      } catch (err) {
        // No commit is ever claimed here — the throw happened somewhere between
        // the first status scan and (at worst) the final rev-parse, so any
        // partial state is reported, never staged/committed over.
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `fix() aborted: uncaught git failure during ${stage}: ${message}`,
          scopeGuardRevertFailed: true,
          failedRevertPaths: toRevert.map((r) => r.path),
        };
      }
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

// FG-487: mirrors invoke.ts's closeRunIfIdle — a run is "active" iff it has a
// non-terminal top-level task, so finalize only when none remains. Without
// this guard, an exception racing a still-running dispatched task (thrown
// between markTaskRunning and that task's terminal write) would finalize the
// run as complete while the task is genuinely in flight.
function finalizeRunIfIdle(runId: string, logSource: string, extraPayload?: Record<string, unknown>): void {
  const inFlight = tasksForRun(runId).some(
    (t) => t.parentId === undefined && t.status !== "complete" && t.status !== "failed",
  );
  if (inFlight) return;
  finalizeRunIfSettled(runId, logSource, extraPayload);
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
    .option("--local-extended", "FG-501: restore the full local verification tier (incl. test:extended) for the CI-unavailable fallback; by default that fallback runs typecheck+test only and delegates extended coverage to CI")
    .description("Bounded reviewer→fixer loop for a ticket's committed work (#301). Never auto-closes the ticket.")
    .action(async (ticketIdArg: string, opts: {
      maxRounds: number; since?: string; project?: string; route?: string;
      unrouted?: boolean; reviewProfile?: string; implementProfile?: string; dryRun?: boolean;
      localExtended?: boolean;
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
      // FG-502: computed ONCE from the loop-start reviewed range, fixed for the
      // whole loop — never recomputed per round or against a moving HEAD.
      const inRangeDocsPaths = computeInRangeDocsPaths(range, projectDir);

      // Present (guardrail): ticket, route, range, rounds, stop conditions.
      const spanNote = range.spansUnmatched ? `, spans unrelated commits → diffing the ${range.shas.length} ticket shas` : "";
      console.log(`review-loop: ${ticket.id} — ${ticket.title}`);
      console.log(`  route:        ${opts.route ?? "(none — unrouted)"}`);
      console.log(`  commit range: ${range.diffRange} (${range.mode}${spanNote})`);
      console.log(`  max rounds:   ${opts.maxRounds}`);
      console.log(`  reviewer:     red-wide (read-only)   fixer: engineer`);
      console.log(`  stops on:     passed | blocked_by_reviewer | needs_fix_max_rounds | verification_failed | fixer_failed | fixer_out_of_scope | closeout_guidance_only | reviewer_failed`);
      console.log(
        `  verification: reuse a passing host row or green CI first; if the required CI checks are in flight, ` +
        `wait/poll for them (default up to 20m, 30s interval — FORGE_CI_WAIT_TIMEOUT_SECONDS/FORGE_CI_POLL_SECONDS) ` +
        `instead of running local verification twice; a failing CI check stops the loop directly; only an ` +
        `unavailable/unqueryable CI setup falls back to a local run (fast gate only unless --local-extended)`,
      );
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

      // FG-487: create the run row (and emit run.created) at loop entry — BEFORE
      // round 1's verification, not lazily on the first reviewer/fixer dispatch as
      // before. Without this the dashboard showed nothing for the whole
      // verification/CI-wait window, which is often the loop's longest phase.
      const eagerRunId = createInvokeRun("review-loop", projectDir, undefined, `review-loop #${ticketId}`, undefined);

      const { deps, getRunId } = buildReviewLoopDeps({
        ticketId,
        acceptance: `${ticket.id} — ${ticket.title}\n\n${ticket.body}`,
        diffProvider, projectDir, scripts: readScripts(projectDir),
        route: opts.route, unrouted: opts.unrouted,
        reviewProfile: opts.reviewProfile, implementProfile: opts.implementProfile,
        localExtended: opts.localExtended, inRangeDocsPaths,
        runId: eagerRunId,
      }, invokeFn ?? invoke);

      let outcome: Awaited<ReturnType<typeof runReviewLoop>>;
      try {
        outcome = await runReviewLoop({ maxRounds: opts.maxRounds, ticketId }, deps);
      } catch (err) {
        // FG-487: an exception escaping the loop (e.g. deps.verify() throwing
        // before any task exists) must not leak the eagerly-created run as a
        // permanent zero-task 'active' row — every sweep (findPhantomRuns,
        // reconcile completion, ops detectors) INNER JOINs tasks and is
        // structurally blind to it. Finalize with the error recorded, then rethrow.
        finalizeRunIfIdle(eagerRunId, "review-loop", {
          stopReason: "exception",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      // FG-502: the actual tip under review at loop end (accounts for any
      // fixer-committed rounds — HEAD may have moved past startHead).
      const reviewedTipSha = git(["rev-parse", "HEAD"], projectDir).trim();
      const remoteTrust = resolveReviewedTipTrust(projectDir, reviewedTipSha);
      const note = renderReviewLoopNote(
        { ticketId, route: opts.route, maxRounds: opts.maxRounds, range, reviewedTipSha, remoteTrust },
        outcome,
      );

      const runId = getRunId();
      if (runId) {
        // FG-487: normally the last reviewer/fixer task's own completion closes the
        // run (invoke.ts's closeRunIfIdle). But a loop that stops before ANY task is
        // ever dispatched (e.g. verification_failed with zero actionable findings on
        // round 1 — no discoverable checks at all) now leaves an eagerly-created run
        // with no task ever attached to it; reconcile.ts's crash-recovery sweep
        // requires at least one task row before it will complete a run, so that path
        // would never close it. Finalize here too — idempotent (a no-op once the run
        // is already complete via the normal per-task path).
        finalizeRunIfIdle(runId, "review-loop", { stopReason: outcome.stopReason });
        const notePath = join(runDir(runId), "review-loop.md");
        // FG-514: the run dir is otherwise created by the first task dispatch, so a
        // loop that exits before ANY dispatch (verification_failed with no
        // discoverable checks) used to print the trust fact and persist nothing.
        mkdirSync(runDir(runId), { recursive: true });
        writeFileSync(notePath, note);
        console.log(`\n${note}\nnote: ${notePath}`);
      } else {
        console.log(`\n${note}`);
      }

      // FG-502: a closeable verdict must never print/emit for a local-only
      // tip — compose outcome.closeable (unchanged: reviewer pass AND
      // verification green) with the remote-trust fact ONLY here. FG-514: the
      // trust fact is now equality against the freshly-fetched remote head, so
      // remote_ahead and a failed fetch withhold closeable the same way.
      if (outcome.closeable && remoteTrust.kind === "trusted") {
        console.log(
          `\n✓ closeable — reviewer passed AND verification is green. Reviewed tip ${reviewedTipSha} ` +
          `is the head of ${remoteTrust.remoteRef}. Close with:  forge backlog close ${ticketId}`,
        );
      } else if (outcome.closeable && remoteTrust.kind === "local_only") {
        console.log(
          `\n✗ not closeable — reviewed tip ${reviewedTipSha} has local-only commit(s) not present on ` +
          `${remoteTrust.remoteRef}: ${remoteTrust.localCommits.map((c) => c.sha).join(", ")}. ` +
          `Push the branch and re-run \`forge review-loop\`, or re-evaluate before closing.`,
        );
        process.exitCode = 1;
      } else if (outcome.closeable && remoteTrust.kind === "remote_ahead") {
        console.log(
          `\n✗ not closeable — remote-ahead: ${remoteTrust.remoteRef} carries commit(s) beyond reviewed tip ` +
          `${reviewedTipSha}: ${remoteTrust.unreviewedCommits.map((c) => c.sha).join(", ")}. ` +
          `The remote head was never reviewed. Pull/rebase onto ${remoteTrust.remoteRef} and re-run ` +
          `\`forge review-loop\`, or re-evaluate before closing.`,
        );
        process.exitCode = 1;
      } else if (outcome.closeable && remoteTrust.kind === "diverged") {
        console.log(
          `\n✗ not closeable — diverged: reviewed tip ${reviewedTipSha} has local-only commit(s) ` +
          `${remoteTrust.localCommits.map((c) => c.sha).join(", ")} AND ${remoteTrust.remoteRef} carries ` +
          `commit(s) the reviewer never saw: ${remoteTrust.unreviewedCommits.map((c) => c.sha).join(", ")}. ` +
          `A plain push is non-fast-forward. Rebase onto ${remoteTrust.remoteRef}, push, and re-run ` +
          `\`forge review-loop\`, or re-evaluate before closing.`,
        );
        process.exitCode = 1;
      } else if (outcome.closeable && remoteTrust.kind === "remote_unavailable" && remoteTrust.remoteRef) {
        console.log(
          `\n✗ not closeable — remote-unavailable: the remote head could not be verified (bounded fetch of ` +
          `${remoteTrust.remoteRef} failed: ${remoteTrust.fetchError ?? "unknown error"}), and a stale cached ref ` +
          `is never trusted, so reviewed tip ${reviewedTipSha} cannot be confirmed. Restore remote access and ` +
          `re-run, or re-evaluate before closing.`,
        );
        process.exitCode = 1;
      } else if (outcome.closeable && remoteTrust.kind === "remote_unavailable") {
        console.log(
          `\n✗ not closeable — remote-unavailable: no resolvable remote-tracking ref, so reviewed tip ` +
          `${reviewedTipSha} cannot be confirmed reachable (not local-only). Push and re-run, or re-evaluate before closing.`,
        );
        process.exitCode = 1;
      } else if (outcome.stopReason === "closeout_guidance_only") {
        // FG-462: the reviewer's only remaining asks were backlog closeout (the
        // orchestrator's post-merge job); the code review is otherwise clean. Not
        // auto-closeable — the orchestrator decides after merge + verification.
        console.log(`\n✗ not closeable — stop reason: closeout_guidance_only. The reviewer's only remaining findings are backlog closeout guidance (orchestrator post-merge work), which the fixer is not asked to perform. Review the closeout guidance in the note, then close after merge + verification if appropriate.`);
        process.exitCode = 1;
      } else {
        console.log(`\n✗ not closeable — stop reason: ${outcome.stopReason}. The ticket is left open.`);
        process.exitCode = 1;
      }
    });
}
