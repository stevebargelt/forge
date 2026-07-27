// #301: bounded review/fix loop — the pure engine (slices 1–4). No real invoke /
// CLI yet (deferred to slices 5–6, gated on review of this engine). The loop is
// host-side orchestration that codifies the manual reviewer→fixer chain; every
// side-effecting dep (verify / review / fix) is INJECTED so the round logic,
// verdict branching, and stop conditions test with zero containers.
//
// Decisions locked for the MVP (#301): reviewer = red-wide, host verification,
// fixer = engineer (wired in slice 6). Policy integration is a non-goal.

import { execFileSync } from "node:child_process";
import { z } from "zod";
import { pinnedVerificationEnv } from "./host-readiness.js";

// ── Slice 1: commit-range resolution ─────────────────────────────────────────

export type GitRunner = (args: string[]) => string;
const defaultGit: GitRunner = (args) => execFileSync("git", args, { encoding: "utf8" });

export type CommitRange = {
  /** how the range was determined */
  mode: "since" | "inferred" | "none";
  /** a `git diff`-able range, or "" when mode === "none". For inferred mode this
   *  is the oldest^..newest SPAN, which may include unrelated commits — see
   *  `spansUnmatched`; `shas` is the precise set. */
  diffRange: string;
  /** the matching commit SHAs in scope (newest first) — the PRECISE set */
  shas: string[];
  /** inferred mode only: true when the diffRange span contains commits that do
   *  NOT reference the ticket (non-contiguous ticket commits). When true, the
   *  caller (slice 6) must diff the specific `shas`, not `diffRange`, to avoid
   *  reviewing unrelated changes. */
  spansUnmatched: boolean;
};

/** The grammar for "this commit SUBJECT references ticket <id>" (FG-539):
 *  - legacy purely-numeric ids ("301") require the hash — "#301" — because a
 *    bare number matches far too much prose;
 *  - structured ids ("FG-536") match with or without it, since Forge's
 *    established subject convention is "(FG-536)". The left boundary is any
 *    non-alphanumeric or start-of-subject, so "#FG-536", "(FG-536)", and a
 *    leading "FG-536:" all match while "XFG-536" does not.
 *  The right boundary rejects a following digit — FG-536 never also catches
 *  FG-5360 (nor #301 → #3010) — and a hyphen-continuation, so FG-409 never
 *  also catches a hyphen-suffixed sibling id like FG-409-a. */
export function ticketSubjectPattern(ticketId: string): RegExp {
  const id = ticketId.replace(/^#/, "").trim();
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rightBoundary = "(?![0-9]|-[A-Za-z0-9])";
  return /^[0-9]+$/.test(id)
    ? new RegExp(`#${escaped}${rightBoundary}`)
    : new RegExp(`(^|[^A-Za-z0-9])${escaped}${rightBoundary}`);
}

/** Resolve the commits under review for a ticket: an explicit `--since <sha>`
 *  (→ <sha>..HEAD), else infer from commits whose SUBJECT references <ticket>.
 *  Pure but for `git` — injectable for tests. */
export function resolveCommitRange(
  ticketId: string,
  opts: { since?: string; git?: GitRunner } = {},
): CommitRange {
  const git = opts.git ?? defaultGit;
  const shasOf = (range: string): string[] =>
    git(["log", "--format=%H", range]).split("\n").map((s) => s.trim()).filter(Boolean);

  if (opts.since) {
    const diffRange = `${opts.since}..HEAD`;
    return { mode: "since", diffRange, shas: shasOf(diffRange), spansUnmatched: false };
  }

  const re = ticketSubjectPattern(ticketId);
  // Match the SUBJECT only, not the whole message: `git log --grep` searches
  // subject AND body, so a commit whose body merely *discusses* FG-536 (while
  // its subject says FG-539) would be pulled into FG-536's range. Read the
  // subjects and filter here instead. `%s` is newline-free, so one line per
  // commit: "<sha> <subject>".
  const matched = git(["log", "--format=%H %s"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(" ");
      return sp === -1 ? { sha: line, subject: "" } : { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
    })
    .filter(({ subject }) => re.test(subject))
    .map(({ sha }) => sha);
  if (matched.length === 0) return { mode: "none", diffRange: "", shas: [], spansUnmatched: false };

  // git log is newest-first: newest = matched[0], oldest = matched[last]. The
  // span may include UNRELATED commits between two ticket commits — detect that
  // by comparing the span's commit count to the matched set, so the caller knows
  // to diff `shas` precisely rather than the span.
  const newest = matched[0]!;
  const oldest = matched[matched.length - 1]!;
  const diffRange = `${oldest}^..${newest}`;
  const spanCount = shasOf(diffRange).length;
  return { mode: "inferred", diffRange, shas: matched, spansUnmatched: spanCount !== matched.length };
}

// ── Slice 2: reviewer verdict contract ───────────────────────────────────────

export type ReviewerVerdict = "pass" | "needs_fix" | "blocked";

// A finding is ANCHORED when it carries BOTH file AND line (so the fixer handoff
// points at an exact spot). A finding missing either is coerced to
// `unanchored: true` rather than rejected — FG-493: red-wide's own native
// contract (seeds/agents/red-wide/CLAUDE.md) tells the reviewer to "cite real
// code or omit file/line/quoted_text entirely" for a concern that isn't tied to
// one line; it never asks the reviewer to set an explicit `unanchored` flag. A
// well-formed reviewer result that follows ITS OWN contract must not fail the
// LOOP's stricter contract wholesale — that turned a real fail verdict into a
// false structural "reviewer_failed".
const FindingSchema = z.object({
  summary: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  unanchored: z.boolean().optional(),
}).transform((f) => (f.file !== undefined && f.line !== undefined ? f : { ...f, unanchored: true }));

// red-wide (the reviewer agent — see module header) writes the RED vocabulary
// verdict:"fail"|"inconclusive" rather than the native needs_fix|blocked. Both
// are accepted input; only the native pass|needs_fix|blocked is ever the
// PARSED (downstream) verdict — see `normalizeVerdict` below.
const RAW_VERDICTS = ["pass", "needs_fix", "blocked", "fail", "inconclusive"] as const;

export const ReviewerVerdictSchema = z.object({
  verdict: z.enum(RAW_VERDICTS),
  findings: z.array(FindingSchema).default([]),
}).transform((v) => ({ ...v, verdict: normalizeVerdict(v.verdict) }))
  .superRefine((v, ctx) => {
    if (v.verdict === "needs_fix" && v.findings.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: "needs_fix requires at least one finding" });
    }
  });

/** Map the accepted raw verdict vocabulary (native + red) onto the canonical
 *  ReviewerVerdict: red's `fail` carries concrete fixable findings, so it's a
 *  needs_fix; red's `inconclusive` means the reviewer couldn't determine, so it
 *  surfaces to a human like `blocked` rather than auto-driving a fixer. */
function normalizeVerdict(v: (typeof RAW_VERDICTS)[number]): ReviewerVerdict {
  if (v === "fail") return "needs_fix";
  if (v === "inconclusive") return "blocked";
  return v;
}

export type Finding = z.infer<typeof FindingSchema>;
export type ReviewerOutput = z.infer<typeof ReviewerVerdictSchema>;

// ── FG-462: closeout-finding partition ───────────────────────────────────────
// Ticket close/move ("forge backlog close", move-to-`backlog/done/`, status:done)
// is the ORCHESTRATOR's post-merge closeout, never the engineer fixer's work. A
// reviewer that anchors a finding on the current ticket's active backlog file (as
// in the FG-459 incident) would otherwise be handed to the fixer, which cannot
// commit a backlog change at all (the CLI's DISALLOWED_RE reverts it) — poisoning
// every round with `fixer_out_of_scope`. We classify such findings as CLOSEOUT and
// surface them to the orchestrator as guidance instead of dispatching them.

// Matches an explicit backlog close/move/mark-done ACTION in a finding summary.
// Consulted for BOTH branches of isCloseoutFinding below — a finding anchored on
// a real code file (e.g. "remove the stale 'close after merge' comment") never
// reaches this check at all (it's fixer work regardless of phrasing); a finding
// anchored on the ticket's own backlog file, or truly unanchored, must still
// read as an actual close/move/done recommendation, not merely sit on/near the
// backlog, or a content-unrelated finding gets mislabeled as closeout guidance.
//
// Split in two: STRONG phrases name the backlog/ticket mechanism outright, so
// they're unambiguous on their own. WEAK phrases are generic close/done/mark
// vocabulary that application-domain findings also use (e.g. "marking the
// request done before the callback runs" or "this stream should be closed") —
// those only count as closeout when a `ticket`/`backlog` mention sits within
// CLOSEOUT_CONTEXT_WINDOW characters of the matched phrase, so an unrelated
// bug report elsewhere in the same (possibly multi-sentence) summary isn't
// silently dropped from the fixer just because the words appear somewhere in it.
const CLOSEOUT_STRONG_RE =
  /forge\s+backlog\s+(?:close|move)|backlog\/done|clos(?:e|ed|ing)\s+(?:the\s+|this\s+)?ticket/i;
const CLOSEOUT_WEAK_RE =
  /move[- ]?to[- ]?done|mov(?:e|ed|ing)\b[^.\n]*\bdone\b|status\s*[:=]?\s*done\b|status\s+to\s+done\b|mark(?:ed|s)?\b[^.\n]*\bdone\b|should\s+be\s+(?:closed|moved\s+to\s+done)/i;
const TICKET_CONTEXT_RE = /\b(?:ticket|backlog)\b/i;
const CLOSEOUT_CONTEXT_WINDOW = 40;

function isCloseoutActionPhrase(summary: string): boolean {
  if (CLOSEOUT_STRONG_RE.test(summary)) return true;
  const weak = CLOSEOUT_WEAK_RE.exec(summary);
  if (!weak) return false;
  const start = Math.max(0, weak.index - CLOSEOUT_CONTEXT_WINDOW);
  const end = weak.index + weak[0].length + CLOSEOUT_CONTEXT_WINDOW;
  return TICKET_CONTEXT_RE.test(summary.slice(start, end));
}

/** True when `path` names the CURRENT ticket (`ticketId` appears, not followed by
 *  another digit so FG-462 doesn't match FG-4620) — same #<num> boundary rule as
 *  resolveCommitRange. Empty ticketId matches nothing. */
function referencesTicket(path: string, ticketId: string): boolean {
  if (!ticketId) return false;
  const esc = ticketId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc}(?![0-9])`, "i").test(path);
}

/** True when a finding is orchestrator closeout guidance for the CURRENT ticket,
 *  not fixer work:
 *  (a) it is anchored on the current ticket's ACTIVE backlog file (a `backlog/`
 *      file naming `ticketId`, excluding `backlog/done/`) — withheld regardless
 *      of its wording, or
 *  (b) it is truly unanchored AND its summary proposes a backlog close/move/
 *      mark-done action (about the ticket under review, by loop context).
 *  Branch (a) is LOCATION-decided, NOT content-gated: the fixer cannot commit ANY
 *  backlog change (DISALLOWED_RE reverts it), so a finding anchored on the ticket's
 *  own active file is never fixer-actionable regardless of phrasing. Content-gating
 *  it (requiring an explicit close/move verb) reintroduced the exact FG-459 AC1
 *  violation — the incident's own phrasing ("still active despite implemented")
 *  names no close/move verb, so it would slip through to the fixer and poison the
 *  loop. A non-close/move content finding on the ticket's own file (e.g. an
 *  ambiguous-AC note) is still the orchestrator's to act on; it is surfaced in the
 *  note as closeout guidance, never silently dropped. Branch (b) IS content-gated —
 *  content is the only signal when there's no anchor.
 *  Scoped to `ticketId` (FG-462 AC: "the current implementation ticket"): a
 *  finding on an UNRELATED backlog file — another ticket's story, backlog/notes.md,
 *  an epic/idea — is NOT closeout. It stays fixable so it is not silently relabeled
 *  as routine post-merge closeout; if the fixer then can't touch it, DISALLOWED_RE
 *  yields a clean `fixer_out_of_scope` stop for the orchestrator to inspect.
 *  `backlog/done/` (an already-closed ticket) is likewise excluded from (a): a
 *  finding there is stale closeout text on a past close — the genuine backlog-drift
 *  catch the ticket's Non-Goal preserves — not a close/move to withhold. */
export function isCloseoutFinding(f: Finding, ticketId: string): boolean {
  if (f.file && /^backlog\//.test(f.file) && !/^backlog\/done\//.test(f.file) && referencesTicket(f.file, ticketId)) return true;
  if (!f.file && isCloseoutActionPhrase(f.summary)) return true;
  return false;
}

export type FindingPartition = { fixable: Finding[]; closeout: Finding[] };

/** Split reviewer findings into those the fixer should address (`fixable`) and
 *  those that are orchestrator closeout guidance for the current ticket
 *  (`closeout`) — see isCloseoutFinding. Pure; order-preserving within each
 *  bucket. */
export function partitionCloseoutFindings(findings: Finding[], ticketId: string): FindingPartition {
  const fixable: Finding[] = [];
  const closeout: Finding[] = [];
  for (const f of findings) (isCloseoutFinding(f, ticketId) ? closeout : fixable).push(f);
  return { fixable, closeout };
}

export type ParsedVerdict =
  | { ok: true; verdict: ReviewerVerdict; findings: Finding[] }
  | { ok: false; error: string };

/** Parse + validate a reviewer agent's result.json into a structured verdict.
 *  Accepts both the native vocabulary (pass|needs_fix|blocked) and the RED
 *  vocabulary (pass|fail|inconclusive) that red-wide (the reviewer) actually
 *  writes, normalizing to the canonical ReviewerVerdict. An unparseable /
 *  contract-violating reviewer output is an error (slice 4 maps it to
 *  stop_reason "reviewer_failed"), never silently treated as a pass. */
export function parseReviewerVerdict(raw: unknown): ParsedVerdict {
  const r = ReviewerVerdictSchema.safeParse(raw);
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  return { ok: true, verdict: r.data.verdict, findings: r.data.findings };
}

// ── Slice 3: deterministic verification ──────────────────────────────────────

// FG-566: `command` and `tier` are STEP-LEVEL PROVENANCE, and they are load-bearing.
// The FG-356 incident reported `deterministic verification step 'typecheck' failed:`
// with nothing after the colon — no command, no tier, no stderr — and diagnosis took
// a manual `ls node_modules`. FG-625 owns the POST-FIXER path; this is the
// ROUND-ENTRY verifier, so fixing FG-625 alone would never have surfaced it. Both
// fields are optional so a caller that synthesizes a step from CI evidence (rather
// than running anything locally) is not forced to invent a command it never ran.
export type VerificationStep = {
  name: string;
  ok: boolean;
  output: string;
  /** The command actually run for this step, verbatim. */
  command?: string;
  /** Which gate tier the step belongs to. */
  tier?: "fast" | "extended";
};
// FG-474: reusedEvidence is set ONLY when verification was satisfied by covering
// evidence (a host_verifications row or green CI check) instead of actually
// running typecheck/test — see buildReviewLoopDeps.verify in
// cli/commands/review-loop.ts. Human-readable description of WHAT covered it,
// surfaced in the loop report in place of run output.
//
// FG-501: ciOutcome is set ONLY on the CI-consuming path in
// cli/commands/review-loop.ts's verifyWithReuse, to make a run diagnosable
// without re-deriving why local verification did or didn't run:
//  - "reused_after_wait": pending CI was polled until it went green, then
//    reused (reusedEvidence is also set on this result, same as an immediate
//    reuse — this just records that a wait happened first).
//  - "ci_failed": a required CI check failed at the reviewed sha; verification
//    is reported failed directly from that CI evidence, with no local run.
//  - "local_fallback": CI was unavailable, unqueryable, or the wait timed out
//    (or the tree was dirty), so verification fell back to a real local run;
//    `reason` is the operator-facing explanation and `extendedDelegatedToCi`
//    records whether test:extended was skipped locally (the review-loop
//    default — see --local-extended) or actually run.
// FG-566: the DISTINCT THIRD verification state, carried as its own field rather
// than folded into `ok`. An unrunnable ENVIRONMENT is neither a pass nor a fail,
// and the loop branches on THIS field BEFORE it ever consults `ok`/`steps` — which
// is the whole fix: modelling an environment fault as ok:false is what made the
// loop convert it into fixer findings, short-circuit the reviewer and burn a
// round against a failure no code change could fix.
//
// The vocabulary is the readiness contract's own (src/v2/host-readiness.ts); the
// loop never re-derives or re-classifies it.
//   prepared     — readiness ran a setup and the workspace is now execution-ready
//   reused       — a prior assertion for this exact binding still holds
//   not_required — nothing to establish (no commands to cover, no dependency graph,
//                  or a workspace forge did not provision and must not touch)
//   refused      — one classified refusal; NO verification ran
// The field being ABSENT means readiness was never consulted at all — the CI-reuse
// path returns before any local provisioning is considered, and that absence is
// how "CI reuse stays first-class" is observable.
export type VerificationReadiness = {
  outcome: "prepared" | "reused" | "refused" | "not_required";
  /** The refusal reason from the shared vocabulary. Refusals only. */
  reason?: string;
  workspace?: string;
  /** The setup command that was run (or would have been). */
  command?: string;
  exitStatus?: number | null;
  stderrTail?: string;
  message?: string;
};

export type VerificationResult = {
  ok: boolean;
  steps: VerificationStep[];
  /** FG-566: see VerificationReadiness. */
  readiness?: VerificationReadiness;
  reusedEvidence?: string;
  ciOutcome?:
    | { kind: "reused_after_wait" }
    | { kind: "ci_failed"; context: string; url?: string }
    | { kind: "local_fallback"; reason: string; extendedDelegatedToCi: boolean };
};

/** FG-566: the ONE predicate every consumer branches on. Never `!v.ok` — an
 *  environment refusal and a code failure are different facts. */
export function isEnvironmentUnavailable(v: VerificationResult): boolean {
  return v.readiness?.outcome === "refused";
}

export type CommandRunner = (cmd: string, args: string[]) => { ok: boolean; output: string };
function makeDefaultRunner(cwd?: string): CommandRunner {
  return (cmd, args) => {
    try {
      // FG-566: the same pinned PATH/interpreter the readiness preflight certified
      // this workspace under — the assertion covers THIS process or it covers
      // nothing.
      const env = pinnedVerificationEnv("review-loop");
      const output = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd, env });
      return { ok: true, output };
    } catch (e) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
      return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` || (e as Error).message };
    }
  };
}

/** Run the project's discoverable deterministic checks. `scripts` are the
 *  package.json scripts present; we run typecheck, test, then test:extended
 *  (FG-500 — the extended tier joins the fallback whenever the project defines
 *  it) when each exists, IN `cwd` (the project dir — not the launch dir).
 *  Runner injectable for tests. `ok` is true only if every run step passed. */
export function runVerification(
  scripts: Record<string, unknown>,
  opts: { run?: CommandRunner; cwd?: string } = {},
): VerificationResult {
  const run = opts.run ?? makeDefaultRunner(opts.cwd);
  const steps: VerificationStep[] = [];
  for (const name of ["typecheck", "test", "test:extended"]) {
    if (typeof scripts[name] !== "string") continue;
    const args = ["run", "--silent", name];
    const { ok, output } = run("npm", args);
    // FG-566: record the command and tier ON THE STEP, at the only place that
    // knows them for certain — the site that ran it.
    steps.push({ name, ok, output, command: `npm ${args.join(" ")}`, tier: name === "test:extended" ? "extended" : "fast" });
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
}

/** The verification commands a `runVerification(scripts)` call will actually run.
 *  Shared with the readiness preflight so the covered command set recorded in
 *  readiness evidence can never drift from what the verification runs. */
export function verificationCommandSet(scripts: Record<string, unknown>): string[] {
  return ["typecheck", "test", "test:extended"]
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => `npm run --silent ${name}`);
}

// ── Slice 4: the bounded loop engine ─────────────────────────────────────────

// FG-513: record of a same-round reviewer retry after a provider/model
// infrastructure failure (failure_kind=model_error). Populated by the CLI's
// review dep on BOTH arms — ok:true when the retry produced a usable verdict
// (the run survived the infra failure), ok:false when the retry also failed.
// Profiles are undefined in legacy (no-model-policy) resolution.
export type ReviewerModelErrorRetry = {
  failedProfile?: string;
  retryProfile?: string;
  cause: string;
};

export type ReviewDispatch =
  | { ok: true; verdict: ReviewerVerdict; findings: Finding[]; modelErrorRetry?: ReviewerModelErrorRetry }
  | { ok: false; error: string; modelErrorRetry?: ReviewerModelErrorRetry };

// FG-502: a path the fixer touched but that fell outside the scope guard
// (backlog/ticket-closeout — always; docs/learnings/README — only when not
// already touched by the loop-start reviewed range) and was therefore
// selectively reverted rather than committed. Distinct from the full-abort
// outOfScope/offendingPaths shape below: a round with revertedPaths still
// SUCCEEDS (ok:true) when in-scope changes from the same round remain and get
// committed normally — only a round where NOTHING survives the revert falls
// back to the full-abort outOfScope shape.
export type RevertedPathGuidance = { path: string; reason: string };

export type FixDispatch =
  | { ok: true; committedSha?: string; revertedPaths?: RevertedPathGuidance[] }
  | { ok: false; error?: string; outOfScope?: boolean; offendingPaths?: string[];
      verificationFailed?: boolean; dirtyPaths?: string[];
      // FG-502 finding 1/2: at least one disallowed path failed to verifiably
      // revert (still dirty/present after the attempt, or the revert command
      // itself threw). Distinct from `outOfScope` (a clean full revert that
      // left nothing in-scope to commit) — this is a REVERT FAILURE: the tree
      // is left in an unverified state and must never be staged/committed.
      scopeGuardRevertFailed?: boolean; failedRevertPaths?: string[] };

/** Explicit terminal states — the only ways the loop stops. */
export type StopReason =
  | "passed"                // verification ok AND reviewer pass → closeable
  | "blocked_by_reviewer"   // reviewer returned blocked
  | "needs_fix_max_rounds"  // reviewer still needs_fix after max rounds
  | "verification_failed"   // deterministic verification still failing at max rounds
  | "fixer_failed"          // the fixer dispatch failed
  | "fixer_out_of_scope"    // the fixer mutated orchestrator-owned paths (backlog/, docs/, etc.)
  | "scope_guard_revert_failed" // FG-502: a disallowed path's revert could not be verified clean — round aborted, nothing staged/committed
  | "closeout_guidance_only" // FG-462: reviewer's ONLY remaining asks are backlog closeout (orchestrator post-merge work); nothing for the fixer
  | "reviewer_failed"       // the reviewer dispatch failed or returned an invalid verdict
  /** FG-566: the verification ENVIRONMENT could not be established, so no
   *  verification ever ran. Consumes ZERO review rounds and dispatches NEITHER
   *  reviewer NOR fixer — environment preparation is not a review round, a
   *  reviewer verdict, or a fixer attempt. Never conflated with
   *  `verification_failed`, which is a verdict on the code. */
  | "verification_environment_unavailable";

export type RoundRecord = {
  round: number;
  verification: VerificationResult;
  /** undefined when verification failed — the reviewer is short-circuited that round */
  verdict?: ReviewerVerdict;
  findings: Finding[];
  /** FG-462: the subset of `findings` reclassified as orchestrator closeout
   *  guidance and withheld from the fixer (backlog close/move). */
  closeoutFindings?: Finding[];
  fixAttempted: boolean;
  fixError?: string;
  committedSha?: string;
  outOfScopePaths?: string[];
  fixDirtyPaths?: string[];
  /** FG-502: paths the fixer touched but that were selectively reverted by the
   *  scope guard (see RevertedPathGuidance) while in-scope changes from the
   *  same round survived and were committed. */
  revertedPaths?: RevertedPathGuidance[];
  /** FG-502: disallowed paths whose revert could not be verified clean/absent —
   *  the round aborted fail-safe with nothing staged/committed. */
  scopeGuardFailedPaths?: string[];
  /** FG-513: the reviewer hit a provider/model_error this round and was retried
   *  same-round on the fallback profile (see ReviewerModelErrorRetry). Present
   *  whether the retry succeeded (round continued) or failed (reviewer_failed). */
  reviewerModelErrorRetry?: ReviewerModelErrorRetry;
};

/** The LAST bytes of a step's output. FG-566: the failure's own words live at the
 *  END of a failed npm run (`ERR_MODULE_NOT_FOUND`, the tsc error list's tail, npm's
 *  error summary); a head slice of a long log is what left the FG-356 findings
 *  reporting a step name and a bare colon. */
function stepOutputTail(output: string, chars = 2000): string {
  const trimmed = output.trim();
  if (trimmed.length === 0) return "(no output captured)";
  return trimmed.length <= chars ? trimmed : `…${trimmed.slice(trimmed.length - chars)}`;
}

/** Turn failed verification steps into fixer findings (unanchored — typecheck/test
 *  output isn't generically file/line addressable; the fixer reads the output).
 *  FG-566: each finding NAMES the command and the tier and carries a stderr tail.
 *  A finding that reports only a step name is not diagnosable — that is the
 *  round-entry half of the discarded-step-detail defect (FG-625 owns the
 *  post-fixer half). */
function verificationFindings(v: VerificationResult): Finding[] {
  return v.steps
    .filter((s) => !s.ok)
    .map((s) => ({
      summary:
        `deterministic verification step '${s.name}' failed ` +
        `(command: ${s.command ?? "(not recorded)"}, tier: ${s.tier ?? "(not recorded)"}):\n` +
        stepOutputTail(s.output),
      unanchored: true,
    }));
}

export type ReviewLoopOutcome = {
  stopReason: StopReason;
  /** true ONLY when stopReason === "passed" — the close guardrail (#301). */
  closeable: boolean;
  rounds: RoundRecord[];
  /** FG-566: set ONLY with stopReason "verification_environment_unavailable" —
   *  the classified refusal, verbatim. No RoundRecord is ever pushed for it. */
  environment?: VerificationReadiness;
};

type Awaitable<T> = T | Promise<T>;

// Deps are Awaitable so the real wiring (slice 6) can use async invoke() while the
// pure unit tests keep returning plain values. The loop control flow is unchanged
// from the reviewed sync version — only `await`ed.
export type ReviewLoopDeps = {
  /** FG-566: may report the DISTINCT THIRD state via `readiness.outcome ===
   *  "refused"`. The loop reads THAT before it reads `ok`. */
  verify: () => Awaitable<VerificationResult>;
  review: (verification: VerificationResult) => Awaitable<ReviewDispatch>;
  fix: (findings: Finding[]) => Awaitable<FixDispatch>;
};

/** Run the bounded review/fix loop. Each round: run deterministic verification;
 *  if it FAILS, short-circuit the reviewer and send the failure straight to the
 *  fixer (no point spending a review on code that doesn't typecheck/test). If it
 *  passes, review; on needs_fix (and rounds remain) → fix → next round. Stops on
 *  pass, blocked, max rounds, or verification/fixer/reviewer failure. Pure: all
 *  effects via `deps`. */
export async function runReviewLoop(opts: { maxRounds?: number; ticketId?: string }, deps: ReviewLoopDeps): Promise<ReviewLoopOutcome> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 2);
  const ticketId = opts.ticketId ?? "";
  const rounds: RoundRecord[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const verification = await deps.verify();

    // FG-566: the environment could not be made runnable, so NO verification ever
    // ran. Checked BEFORE `ok` and BEFORE `steps` — a refusal that also carries the
    // failed steps of a dependency-less local run must still stop here, never fall
    // through to the findings-and-fixer path. NO RoundRecord is pushed for it —
    // environment preparation is not a review round — so a refusal on round 1
    // returns with `rounds` empty and a refusal on a later round leaves only the
    // rounds that genuinely ran.
    if (isEnvironmentUnavailable(verification)) {
      return {
        stopReason: "verification_environment_unavailable",
        closeable: false,
        rounds,
        environment: verification.readiness!,
      };
    }

    // Verification first. If it fails, do NOT review — the failure is the work.
    if (!verification.ok) {
      const findings = verificationFindings(verification);
      const rec: RoundRecord = { round, verification, findings, fixAttempted: false };
      // Nothing actionable to fix — e.g. no discoverable checks (ok:false, no
      // steps), so verificationFindings is empty. Don't dispatch an empty fix;
      // stop. (Also stops at max rounds when checks keep failing.)
      if (findings.length === 0 || round === maxRounds) {
        rounds.push(rec);
        return { stopReason: "verification_failed", closeable: false, rounds };
      }
      const fix = await deps.fix(findings);
      rec.fixAttempted = true;
      if (fix.ok) {
        if (fix.committedSha) rec.committedSha = fix.committedSha;
        if (fix.revertedPaths && fix.revertedPaths.length > 0) rec.revertedPaths = fix.revertedPaths;
        rounds.push(rec); // fixed; next round re-verifies
        continue;
      }
      if (fix.scopeGuardRevertFailed) {
        rec.scopeGuardFailedPaths = fix.failedRevertPaths;
        if (fix.error) rec.fixError = fix.error;
        rounds.push(rec);
        return { stopReason: "scope_guard_revert_failed", closeable: false, rounds };
      }
      if (fix.outOfScope) {
        rec.outOfScopePaths = fix.offendingPaths;
        rounds.push(rec);
        return { stopReason: "fixer_out_of_scope", closeable: false, rounds };
      }
      if (fix.verificationFailed) {
        rec.fixDirtyPaths = fix.dirtyPaths;
        rounds.push(rec);
        return { stopReason: "verification_failed", closeable: false, rounds };
      }
      rec.fixError = fix.error;
      rounds.push(rec);
      return { stopReason: "fixer_failed", closeable: false, rounds };
    }

    // Verification green → review.
    const review = await deps.review(verification);
    if (!review.ok) {
      rounds.push({
        round, verification, findings: [], fixAttempted: false,
        ...(review.modelErrorRetry ? { reviewerModelErrorRetry: review.modelErrorRetry } : {}),
      });
      return { stopReason: "reviewer_failed", closeable: false, rounds };
    }

    const rec: RoundRecord = { round, verification, verdict: review.verdict, findings: review.findings, fixAttempted: false };
    if (review.modelErrorRetry) rec.reviewerModelErrorRetry = review.modelErrorRetry;

    if (review.verdict === "pass") {
      // verification.ok is guaranteed here, so pass ⟹ closeable.
      rounds.push(rec);
      return { stopReason: "passed", closeable: true, rounds };
    }
    if (review.verdict === "blocked") {
      rounds.push(rec);
      return { stopReason: "blocked_by_reviewer", closeable: false, rounds };
    }

    // needs_fix — FG-462: withhold backlog closeout findings from the fixer. They
    // are the orchestrator's post-merge job (and the fixer cannot commit backlog
    // changes anyway), so dispatch ONLY the fixable remainder.
    const { fixable, closeout } = partitionCloseoutFindings(review.findings, ticketId);
    if (closeout.length > 0) rec.closeoutFindings = closeout;

    if (fixable.length === 0) {
      // The reviewer's only asks are closeout guidance — nothing actionable for the
      // fixer, and close/move is the orchestrator's call after merge. Terminal, and
      // NOT closeable: the orchestrator retains final closeout authority.
      rounds.push(rec);
      return { stopReason: "closeout_guidance_only", closeable: false, rounds };
    }

    if (round === maxRounds) {
      rounds.push(rec);
      return { stopReason: "needs_fix_max_rounds", closeable: false, rounds };
    }
    const fix = await deps.fix(fixable);
    rec.fixAttempted = true;
    if (fix.ok) {
      if (fix.committedSha) rec.committedSha = fix.committedSha;
      if (fix.revertedPaths && fix.revertedPaths.length > 0) rec.revertedPaths = fix.revertedPaths;
      rounds.push(rec); // fixed; next round re-verifies + re-reviews
    } else if (fix.scopeGuardRevertFailed) {
      rec.scopeGuardFailedPaths = fix.failedRevertPaths;
      if (fix.error) rec.fixError = fix.error;
      rounds.push(rec);
      return { stopReason: "scope_guard_revert_failed", closeable: false, rounds };
    } else if (fix.outOfScope) {
      rec.outOfScopePaths = fix.offendingPaths;
      rounds.push(rec);
      return { stopReason: "fixer_out_of_scope", closeable: false, rounds };
    } else if (fix.verificationFailed) {
      rec.fixDirtyPaths = fix.dirtyPaths;
      rounds.push(rec);
      return { stopReason: "verification_failed", closeable: false, rounds };
    } else {
      rec.fixError = fix.error;
      rounds.push(rec);
      return { stopReason: "fixer_failed", closeable: false, rounds };
    }
  }

  /* istanbul ignore next — maxRounds>=1 always returns inside the loop */
  return { stopReason: "needs_fix_max_rounds", closeable: false, rounds };
}

// ── Slice 5: durable run-note ────────────────────────────────────────────────

// FG-502, tightened by FG-514: whether the reviewed tip (HEAD at loop end,
// including any fixer-committed rounds) is trustworthy for a closeable
// verdict. Computed CLI-side (git/network access lives in
// cli/commands/review-loop.ts — this pure engine only renders the resulting
// fact, data in) as EQUALITY with the freshly-fetched remote head, never a
// one-directional ancestry check and never an ahead-count heuristic:
//   - local_only    the tip carries commits the remote head does not have
//   - remote_ahead  the remote head carries commits the reviewer never saw
//   - diverged      both directions non-empty — neither is a fast-forward of the other
//   - trusted       both directions empty — the tip IS the remote head
// A closeable verdict must never print/emit when this is anything other than
// "trusted".
export type ReviewedTipTrust =
  | { kind: "trusted"; remoteRef: string }
  | { kind: "local_only"; remoteRef: string; localCommits: { sha: string; subject: string }[] }
  | { kind: "remote_ahead"; remoteRef: string; unreviewedCommits: { sha: string; subject: string }[] }
  | {
      kind: "diverged"; remoteRef: string;
      localCommits: { sha: string; subject: string }[];
      unreviewedCommits: { sha: string; subject: string }[];
    }
  /** `remoteRef`/`fetchError` are set when a ref DID resolve but the bounded
   *  fetch failed — the cached ref may be stale, so the remote head could not
   *  be verified. Absent when no remote-tracking ref resolved at all. */
  | { kind: "remote_unavailable"; remoteRef?: string; fetchError?: string };

export type ReviewLoopNoteMeta = {
  ticketId: string;
  route?: string;
  maxRounds: number;
  range: CommitRange;
  /** FG-502: the actual tip under review at loop end (accounts for
   *  fixer-committed rounds) — always named in the report. */
  reviewedTipSha: string;
  remoteTrust: ReviewedTipTrust;
};

/** One finding as note lines: the anchor + its first line, then every remaining
 *  line indented under it. FG-566 — a multi-line finding (a verification failure
 *  carrying command, tier and a stderr tail) must survive into the note intact. */
function renderFindingLines(where: string, summary: string): string[] {
  const [first = "", ...rest] = summary.split("\n");
  return [`  - ${where} ${first}`, ...rest.map((line) => `      ${line}`)];
}

/** Render the loop's outcome as a durable markdown artifact: commit range,
 *  per-round verdicts/verification/findings/fixes, and the stop reason. Pure. */
export function renderReviewLoopNote(meta: ReviewLoopNoteMeta, outcome: ReviewLoopOutcome): string {
  const L: string[] = [];
  // FG-502: the headline must agree with the remote-reachability line below —
  // outcome.closeable alone (reviewer pass AND verification green) doesn't
  // know about the remote-trust gate, so compose it here the same way the CLI
  // does before printing its own closeable/not-closeable message.
  const closeable = outcome.closeable && meta.remoteTrust.kind === "trusted";
  L.push(`# review-loop — ticket #${meta.ticketId.replace(/^#/, "")}`, "");
  L.push(`- **stop reason:** ${outcome.stopReason}`);
  L.push(`- **closeable:** ${closeable ? "yes — reviewer pass AND verification green" : "no"}`);
  L.push(`- **reviewed tip:** \`${meta.reviewedTipSha}\``);
  // FG-502: name the reviewed tip and flag loop-created/local commits not on
  // the remote tracking/PR branch — a closeable verdict must never silently
  // apply to a local-only tip. FG-514: nor to a tip the remote has moved past.
  if (meta.remoteTrust.kind === "trusted") {
    L.push(`- **remote reachability:** the reviewed tip IS the head of \`${meta.remoteTrust.remoteRef}\` — a closeable verdict (if any) is trustworthy`);
  } else if (meta.remoteTrust.kind === "local_only") {
    L.push(`- **remote reachability:** NOT reachable from \`${meta.remoteTrust.remoteRef}\` — local-only commit(s) present; closeable is withheld even if the reviewer/verification would otherwise pass`);
    L.push(`- **local-only commits:**`);
    for (const c of meta.remoteTrust.localCommits) L.push(`  - ${c.sha} ${c.subject}`);
    L.push(`- **next action:** push the branch and re-run \`forge review-loop\`, or re-evaluate before closing`);
  } else if (meta.remoteTrust.kind === "remote_ahead") {
    L.push(`- **remote reachability:** REMOTE-AHEAD — \`${meta.remoteTrust.remoteRef}\` carries commit(s) beyond the reviewed tip, so the remote head was never reviewed; closeable is withheld even if the reviewer/verification would otherwise pass`);
    L.push(`- **unreviewed commits:**`);
    for (const c of meta.remoteTrust.unreviewedCommits) L.push(`  - ${c.sha} ${c.subject}`);
    L.push(`- **next action:** pull/rebase onto \`${meta.remoteTrust.remoteRef}\` and re-run \`forge review-loop\`, or re-evaluate before closing`);
  } else if (meta.remoteTrust.kind === "diverged") {
    L.push(`- **remote reachability:** DIVERGED — the reviewed tip carries local-only commit(s) AND \`${meta.remoteTrust.remoteRef}\` carries commit(s) the reviewer never saw; closeable is withheld even if the reviewer/verification would otherwise pass`);
    L.push(`- **local-only commits:**`);
    for (const c of meta.remoteTrust.localCommits) L.push(`  - ${c.sha} ${c.subject}`);
    L.push(`- **unreviewed commits:**`);
    for (const c of meta.remoteTrust.unreviewedCommits) L.push(`  - ${c.sha} ${c.subject}`);
    L.push(`- **next action:** a plain push is non-fast-forward — rebase onto \`${meta.remoteTrust.remoteRef}\`, push, and re-run \`forge review-loop\`, or re-evaluate before closing`);
  } else if (meta.remoteTrust.remoteRef) {
    L.push(`- **remote reachability:** UNAVAILABLE — the remote head could not be verified: the bounded fetch of \`${meta.remoteTrust.remoteRef}\` failed (${meta.remoteTrust.fetchError ?? "unknown error"}), and a stale cached ref is never trusted; closeable is withheld even if the reviewer/verification would otherwise pass`);
    L.push(`- **next action:** restore remote access and re-run \`forge review-loop\`, or re-evaluate before closing`);
  } else {
    L.push(`- **remote reachability:** UNAVAILABLE — no resolvable remote-tracking ref; not-closeable/remote-unavailable (closeable is withheld even if the reviewer/verification would otherwise pass)`);
  }
  L.push(`- **route:** ${meta.route ?? "(none — unrouted)"}`);
  L.push(`- **max rounds:** ${meta.maxRounds}`);
  const span = meta.range.spansUnmatched ? " — span includes unrelated commits; reviewed the specific shas" : "";
  L.push(`- **commit range:** \`${meta.range.diffRange || "(none)"}\` (${meta.range.mode}${span})`);
  L.push(`- **commits:** ${meta.range.shas.join(", ") || "(none)"}`, "");

  // FG-566: the readiness section. The literal token `verification_environment_unavailable`
  // is what makes this outcome greppable and unmistakable for a code verdict on
  // every surface that renders the note.
  if (outcome.environment) {
    const env = outcome.environment;
    L.push(`## Verification environment — verification_environment_unavailable`, "");
    L.push(`- **readiness:** REFUSED (${env.reason ?? "(reason not recorded)"})`);
    L.push(`- **workspace:** \`${env.workspace ?? "(not recorded)"}\``);
    L.push(`- **setup command:** \`${env.command ?? "(not recorded)"}\``);
    if (env.exitStatus !== undefined && env.exitStatus !== null) L.push(`- **exit status:** ${env.exitStatus}`);
    L.push(`- **rounds consumed:** ${outcome.rounds.length} — the reviewer was NOT dispatched and the fixer was NOT dispatched`);
    L.push(`- **detail:** ${env.message ?? "no verification ran; this is NOT a verdict on the reviewed code"}`);
    if (env.stderrTail) {
      L.push(`- **stderr tail:**`, "```");
      for (const line of env.stderrTail.split("\n")) L.push(line);
      L.push("```");
    }
    L.push("");
  }

  for (const r of outcome.rounds) {
    L.push(`## Round ${r.round}`);
    const checks = r.verification.steps.map((s) => `${s.name}=${s.ok ? "ok" : "FAIL"}`).join(", ") || "(no checks)";
    L.push(`- verification: ${r.verification.ok ? "ok" : "FAILED"} (${checks})`);
    // FG-474: reused covering evidence instead of a real host run — record WHAT
    // covered it (row id or CI run URL + sha) in place of run output.
    if (r.verification.reusedEvidence) {
      L.push(`- verification reused evidence: ${r.verification.reusedEvidence}`);
    }
    // FG-501: how the CI-consuming path resolved — waited for pending CI, was
    // stopped by a failing CI check, or fell back to local verification.
    if (r.verification.ciOutcome) {
      const outcome = r.verification.ciOutcome;
      if (outcome.kind === "reused_after_wait") {
        L.push(`- CI: waited for in-flight CI, then reused it (no local run)`);
      } else if (outcome.kind === "ci_failed") {
        L.push(`- CI: required check "${outcome.context}" failed${outcome.url ? ` — ${outcome.url}` : ""} (no local run)`);
      } else {
        L.push(`- CI: local fallback — ${outcome.reason}`);
        L.push(`- local fallback tier: ${outcome.extendedDelegatedToCi ? "fast only (test:extended delegated to CI)" : "full (incl. test:extended)"}`);
      }
    }
    // FG-513: a same-round reviewer retry after a provider/model_error is part
    // of the round's audit record — name both profiles and the cause, so an
    // infra failure that the retry absorbed is still visible after the fact.
    if (r.reviewerModelErrorRetry) {
      const rr = r.reviewerModelErrorRetry;
      L.push(
        `- reviewer model_error retry: profile '${rr.failedProfile ?? "(legacy)"}' failed (${rr.cause}) — retried same round on '${rr.retryProfile ?? "(legacy)"}'`,
      );
    }
    L.push(r.verdict
      ? `- reviewer verdict: ${r.verdict}`
      : r.verification.ok
        ? `- reviewer: failed (invalid or absent result)`
        : `- reviewer: skipped (verification failed)`);
    // FG-462: closeout findings render ONLY under their dedicated section below,
    // never again in the general list (rec.findings holds the full unpartitioned
    // set). Dedupe by value key so it holds whether or not the two arrays share
    // object identity.
    const findingKey = (f: Finding): string => `${f.file ?? ""}:${f.line ?? ""}:${f.summary}`;
    const closeoutKeys = new Set((r.closeoutFindings ?? []).map(findingKey));
    const generalFindings = r.findings.filter((f) => !closeoutKeys.has(findingKey(f)));
    if (generalFindings.length > 0) {
      L.push(`- findings:`);
      for (const f of generalFindings) {
        const where = f.unanchored ? "[unanchored]" : `${f.file}:${f.line}`;
        // FG-566: NO first-line truncation. `summary.split("\n")[0]` is exactly what
        // reduced the FG-356 rounds to `deterministic verification step 'typecheck'
        // failed:` with nothing after the colon — the command, tier and stderr the
        // finding carries were all on the discarded lines.
        L.push(...renderFindingLines(where, f.summary));
      }
    }
    if (r.closeoutFindings && r.closeoutFindings.length > 0) {
      // FG-462: withheld from the fixer; surfaced to the orchestrator as closeout guidance.
      L.push(`- closeout guidance (orchestrator post-merge — NOT sent to fixer):`);
      for (const f of r.closeoutFindings) {
        const where = f.unanchored || !f.file ? "[unanchored]" : `${f.file}:${f.line}`;
        L.push(`  - ${where} ${f.summary.split("\n")[0]}`);
      }
    }
    if (r.revertedPaths && r.revertedPaths.length > 0) {
      // FG-502: a parallel guidance section (same closeout-guidance-style
      // channel as r.closeoutFindings above) for paths the scope guard
      // selectively reverted this round while in-scope changes survived.
      L.push(`- fixer scope guard — reverted disallowed paths (guidance; not applied):`);
      for (const rp of r.revertedPaths) {
        L.push(`  - ${rp.path} — ${rp.reason}`);
      }
    }
    if (r.fixAttempted) {
      if (r.scopeGuardFailedPaths && r.scopeGuardFailedPaths.length > 0) {
        L.push(`- fix: rejected (scope guard revert failed — could not verify a clean/absent tree, nothing staged or committed)`);
        L.push(`- scope guard revert failed for: ${r.scopeGuardFailedPaths.join(", ")}`);
        if (r.fixError) L.push(`- failure context: ${r.fixError}`);
      } else if (r.fixError) {
        L.push(`- fix: FAILED — ${r.fixError}`);
      } else if (r.outOfScopePaths && r.outOfScopePaths.length > 0) {
        L.push(`- fix: rejected (fixer out of scope)`);
        L.push(`- fixer out-of-scope paths: ${r.outOfScopePaths.join(", ")}`);
      } else if (r.fixDirtyPaths && r.fixDirtyPaths.length > 0) {
        L.push(`- fix left uncommitted (verification failed): ${r.fixDirtyPaths.join(", ")}`);
      } else if (r.committedSha) {
        L.push(`- fix: applied`);
        L.push(`- committed: ${r.committedSha}`);
      } else {
        L.push(`- fix: applied`);
      }
    }
    L.push("");
  }
  return L.join("\n");
}
