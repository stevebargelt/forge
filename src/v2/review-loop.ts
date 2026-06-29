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

// A finding must be ANCHORED (BOTH file AND line — so the fixer handoff points at
// an exact spot) or explicitly flagged `unanchored: true`. A bare `file` with no
// `line` is rejected: either give the line or mark it unanchored.
const FindingSchema = z.object({
  summary: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  unanchored: z.boolean().optional(),
}).superRefine((f, ctx) => {
  const anchored = f.file !== undefined && f.line !== undefined;
  if (!anchored && f.unanchored !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "finding must be anchored (both `file` and `line`) or `unanchored: true`" });
  }
});

export const ReviewerVerdictSchema = z.object({
  verdict: z.enum(["pass", "needs_fix", "blocked"]),
  findings: z.array(FindingSchema).default([]),
}).superRefine((v, ctx) => {
  if (v.verdict === "needs_fix" && v.findings.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: "needs_fix requires at least one finding" });
  }
});

export type Finding = z.infer<typeof FindingSchema>;
export type ReviewerOutput = z.infer<typeof ReviewerVerdictSchema>;

export type ParsedVerdict =
  | { ok: true; verdict: ReviewerVerdict; findings: Finding[] }
  | { ok: false; error: string };

/** Parse + validate a reviewer agent's result.json into a structured verdict.
 *  An unparseable / contract-violating reviewer output is an error (slice 4 maps
 *  it to stop_reason "reviewer_failed"), never silently treated as a pass. */
export function parseReviewerVerdict(raw: unknown): ParsedVerdict {
  const r = ReviewerVerdictSchema.safeParse(raw);
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  return { ok: true, verdict: r.data.verdict, findings: r.data.findings };
}

// ── Slice 3: deterministic verification ──────────────────────────────────────

export type VerificationStep = { name: string; ok: boolean; output: string };
export type VerificationResult = { ok: boolean; steps: VerificationStep[] };

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
 *  package.json scripts present; we run typecheck then test when each exists, IN
 *  `cwd` (the project dir — not the launch dir). Runner injectable for tests.
 *  `ok` is true only if every run step passed. */
export function runVerification(
  scripts: Record<string, unknown>,
  opts: { run?: CommandRunner; cwd?: string } = {},
): VerificationResult {
  const run = opts.run ?? makeDefaultRunner(opts.cwd);
  const steps: VerificationStep[] = [];
  for (const name of ["typecheck", "test"]) {
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
  | "reviewer_failed";      // the reviewer dispatch failed or returned an invalid verdict

export type RoundRecord = {
  round: number;
  verification: VerificationResult;
  /** undefined when verification failed — the reviewer is short-circuited that round */
  verdict?: ReviewerVerdict;
  findings: Finding[];
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
export async function runReviewLoop(opts: { maxRounds?: number }, deps: ReviewLoopDeps): Promise<ReviewLoopOutcome> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 2);
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

    // needs_fix
    if (round === maxRounds) {
      rounds.push(rec);
      return { stopReason: "needs_fix_max_rounds", closeable: false, rounds };
    }
    const fix = await deps.fix(review.findings);
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
    L.push(r.verdict ? `- reviewer verdict: ${r.verdict}` : `- reviewer: skipped (verification failed)`);
    if (r.findings.length > 0) {
      L.push(`- findings:`);
      for (const f of r.findings) {
        const where = f.unanchored ? "[unanchored]" : `${f.file}:${f.line}`;
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
