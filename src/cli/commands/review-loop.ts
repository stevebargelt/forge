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
import { invoke, createInvokeRun, type InvokeArgs, type InvokeResult } from "../../v2/invoke.js";
import { finalizeRunIfSettled } from "../../v2/run-finalize.js";
import { readTicket } from "../../backlog/structured.js";
import { applyRoutePreflight, preflightEnforceFromEnv } from "../route-preflight.js";
import {
  resolveCommitRange, runVerification, runReviewLoop, renderReviewLoopNote, parseReviewerVerdict,
  type CommitRange, type ReviewLoopDeps, type VerificationResult, type Finding,
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

      // All changed paths are in scope — verify before committing. Fast tier by
      // default (FG-501 AC5): the fixer's commit gets pushed and CI runs
      // test:extended as a required check; --local-extended restores the full tier.
      const verification = runVerify(localFallbackScripts(), { cwd: ctx.projectDir });
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
        localExtended: opts.localExtended,
        runId: eagerRunId,
      }, invokeFn ?? invoke);

      const outcome = await runReviewLoop({ maxRounds: opts.maxRounds, ticketId }, deps);
      const note = renderReviewLoopNote({ ticketId, route: opts.route, maxRounds: opts.maxRounds, range }, outcome);

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
        finalizeRunIfSettled(runId, "review-loop", { stopReason: outcome.stopReason });
        const notePath = join(runDir(runId), "review-loop.md");
        if (existsSync(runDir(runId))) writeFileSync(notePath, note);
        console.log(`\n${note}\nnote: ${notePath}`);
      } else {
        console.log(`\n${note}`);
      }

      if (outcome.closeable) {
        console.log(`\n✓ closeable — reviewer passed AND verification is green. Close with:  forge backlog close ${ticketId}`);
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
