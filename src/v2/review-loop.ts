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

/** Resolve the commits under review for a ticket: an explicit `--since <sha>`
 *  (→ <sha>..HEAD), else infer from commits whose message references #<ticket>.
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

  const num = ticketId.replace(/^#/, "").trim();
  // Commits whose subject/body references the ticket, e.g. "(#301)" or "#301".
  // POSIX ERE (git --extended-regexp) has no `\b`; match #<num> not followed by a
  // digit (so #301 doesn't also catch #3010) — `([^0-9]|$)`.
  const matched = git(["log", "--format=%H", `--grep=#${num}([^0-9]|$)`, "--extended-regexp"])
    .split("\n").map((s) => s.trim()).filter(Boolean);
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

export type VerificationStep = { name: string; ok: boolean; output: string };
// FG-474: reusedEvidence is set ONLY when verification was satisfied by covering
// evidence (a host_verifications row or green CI check) instead of actually
// running typecheck/test — see buildReviewLoopDeps.verify in
// cli/commands/review-loop.ts. Human-readable description of WHAT covered it,
// surfaced in the loop report in place of run output.
export type VerificationResult = { ok: boolean; steps: VerificationStep[]; reusedEvidence?: string };

export type CommandRunner = (cmd: string, args: string[]) => { ok: boolean; output: string };
function makeDefaultRunner(cwd?: string): CommandRunner {
  return (cmd, args) => {
    try {
      const output = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
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
    const { ok, output } = run("npm", ["run", "--silent", name]);
    steps.push({ name, ok, output });
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
}

// ── Slice 4: the bounded loop engine ─────────────────────────────────────────

export type ReviewDispatch =
  | { ok: true; verdict: ReviewerVerdict; findings: Finding[] }
  | { ok: false; error: string };
export type FixDispatch =
  | { ok: true; committedSha?: string }
  | { ok: false; error?: string; outOfScope?: boolean; offendingPaths?: string[];
      verificationFailed?: boolean; dirtyPaths?: string[] };

/** Explicit terminal states — the only ways the loop stops. */
export type StopReason =
  | "passed"                // verification ok AND reviewer pass → closeable
  | "blocked_by_reviewer"   // reviewer returned blocked
  | "needs_fix_max_rounds"  // reviewer still needs_fix after max rounds
  | "verification_failed"   // deterministic verification still failing at max rounds
  | "fixer_failed"          // the fixer dispatch failed
  | "fixer_out_of_scope"    // the fixer mutated orchestrator-owned paths (backlog/, docs/, etc.)
  | "closeout_guidance_only" // FG-462: reviewer's ONLY remaining asks are backlog closeout (orchestrator post-merge work); nothing for the fixer
  | "reviewer_failed";      // the reviewer dispatch failed or returned an invalid verdict

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
};

/** Turn failed verification steps into fixer findings (unanchored — typecheck/test
 *  output isn't generically file/line addressable; the fixer reads the output). */
function verificationFindings(v: VerificationResult): Finding[] {
  return v.steps
    .filter((s) => !s.ok)
    .map((s) => ({ summary: `deterministic verification step '${s.name}' failed:\n${s.output.slice(0, 2000)}`, unanchored: true }));
}

export type ReviewLoopOutcome = {
  stopReason: StopReason;
  /** true ONLY when stopReason === "passed" — the close guardrail (#301). */
  closeable: boolean;
  rounds: RoundRecord[];
};

type Awaitable<T> = T | Promise<T>;

// Deps are Awaitable so the real wiring (slice 6) can use async invoke() while the
// pure unit tests keep returning plain values. The loop control flow is unchanged
// from the reviewed sync version — only `await`ed.
export type ReviewLoopDeps = {
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
        rounds.push(rec); // fixed; next round re-verifies
        continue;
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
      rounds.push({ round, verification, findings: [], fixAttempted: false });
      return { stopReason: "reviewer_failed", closeable: false, rounds };
    }

    const rec: RoundRecord = { round, verification, verdict: review.verdict, findings: review.findings, fixAttempted: false };

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
      rounds.push(rec); // fixed; next round re-verifies + re-reviews
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

export type ReviewLoopNoteMeta = {
  ticketId: string;
  route?: string;
  maxRounds: number;
  range: CommitRange;
};

/** Render the loop's outcome as a durable markdown artifact: commit range,
 *  per-round verdicts/verification/findings/fixes, and the stop reason. Pure. */
export function renderReviewLoopNote(meta: ReviewLoopNoteMeta, outcome: ReviewLoopOutcome): string {
  const L: string[] = [];
  L.push(`# review-loop — ticket #${meta.ticketId.replace(/^#/, "")}`, "");
  L.push(`- **stop reason:** ${outcome.stopReason}`);
  L.push(`- **closeable:** ${outcome.closeable ? "yes — reviewer pass AND verification green" : "no"}`);
  L.push(`- **route:** ${meta.route ?? "(none — unrouted)"}`);
  L.push(`- **max rounds:** ${meta.maxRounds}`);
  const span = meta.range.spansUnmatched ? " — span includes unrelated commits; reviewed the specific shas" : "";
  L.push(`- **commit range:** \`${meta.range.diffRange || "(none)"}\` (${meta.range.mode}${span})`);
  L.push(`- **commits:** ${meta.range.shas.join(", ") || "(none)"}`, "");

  for (const r of outcome.rounds) {
    L.push(`## Round ${r.round}`);
    const checks = r.verification.steps.map((s) => `${s.name}=${s.ok ? "ok" : "FAIL"}`).join(", ") || "(no checks)";
    L.push(`- verification: ${r.verification.ok ? "ok" : "FAILED"} (${checks})`);
    // FG-474: reused covering evidence instead of a real host run — record WHAT
    // covered it (row id or CI run URL + sha) in place of run output.
    if (r.verification.reusedEvidence) {
      L.push(`- verification reused evidence: ${r.verification.reusedEvidence}`);
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
        L.push(`  - ${where} ${f.summary.split("\n")[0]}`);
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
    if (r.fixAttempted) {
      if (r.fixError) {
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
