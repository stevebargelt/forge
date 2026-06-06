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
  /** a `git diff`-able range, or "" when mode === "none" */
  diffRange: string;
  /** the commit SHAs in scope (newest first) */
  shas: string[];
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
    return { mode: "since", diffRange, shas: shasOf(diffRange) };
  }

  const num = ticketId.replace(/^#/, "").trim();
  // Commits whose subject/body references the ticket, e.g. "(#301)" or "#301".
  const matched = git(["log", "--format=%H", `--grep=#${num}\\b`, "--extended-regexp"])
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (matched.length === 0) return { mode: "none", diffRange: "", shas: [] };

  // git log is newest-first: newest = matched[0], oldest = matched[last].
  const newest = matched[0]!;
  const oldest = matched[matched.length - 1]!;
  return { mode: "inferred", diffRange: `${oldest}^..${newest}`, shas: matched };
}

// ── Slice 2: reviewer verdict contract ───────────────────────────────────────

export type ReviewerVerdict = "pass" | "needs_fix" | "blocked";

// A finding must be file/line ANCHORED, or explicitly flagged unanchored.
const FindingSchema = z.object({
  summary: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  unanchored: z.boolean().optional(),
}).superRefine((f, ctx) => {
  if (!f.file && f.unanchored !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "finding must have a `file` (anchored) or `unanchored: true`" });
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
const defaultRunner: CommandRunner = (cmd, args) => {
  try {
    const output = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` || (e as Error).message };
  }
};

/** Run the project's discoverable deterministic checks (host). `scripts` are the
 *  package.json scripts present; we run typecheck then test when each exists.
 *  Runner injectable for tests. `ok` is true only if every run step passed. */
export function runVerification(
  scripts: Record<string, unknown>,
  opts: { run?: CommandRunner } = {},
): VerificationResult {
  const run = opts.run ?? defaultRunner;
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
export type FixDispatch = { ok: boolean; error?: string };

/** Explicit terminal states — the only ways the loop stops. */
export type StopReason =
  | "passed"                // reviewer pass AND deterministic verification ok → closeable
  | "blocked_by_reviewer"   // reviewer returned blocked
  | "needs_fix_max_rounds"  // still needs_fix after max rounds
  | "verification_failed"   // reviewer passed but verification did NOT (never auto-close)
  | "fixer_failed"          // the fixer dispatch failed
  | "reviewer_failed";      // the reviewer dispatch failed or returned an invalid verdict

export type RoundRecord = {
  round: number;
  verification: VerificationResult;
  verdict?: ReviewerVerdict;
  findings: Finding[];
  fixAttempted: boolean;
  fixError?: string;
};

export type ReviewLoopOutcome = {
  stopReason: StopReason;
  /** true ONLY when stopReason === "passed" — the close guardrail (#301). */
  closeable: boolean;
  rounds: RoundRecord[];
};

export type ReviewLoopDeps = {
  verify: () => VerificationResult;
  review: (verification: VerificationResult) => ReviewDispatch;
  fix: (findings: Finding[]) => FixDispatch;
};

/** Run the bounded review/fix loop. Each round: verify → review; on needs_fix
 *  (and rounds remain) → fix → next round. Stops on pass, blocked, max rounds,
 *  verification/fixer/reviewer failure. Pure: all effects via `deps`. */
export function runReviewLoop(opts: { maxRounds?: number }, deps: ReviewLoopDeps): ReviewLoopOutcome {
  const maxRounds = Math.max(1, opts.maxRounds ?? 2);
  const rounds: RoundRecord[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const verification = deps.verify();
    const review = deps.review(verification);

    if (!review.ok) {
      rounds.push({ round, verification, findings: [], fixAttempted: false });
      return { stopReason: "reviewer_failed", closeable: false, rounds };
    }

    const rec: RoundRecord = { round, verification, verdict: review.verdict, findings: review.findings, fixAttempted: false };

    if (review.verdict === "pass") {
      rounds.push(rec);
      // Close guardrail: a reviewer pass alone is not enough — verification must
      // also pass, else surface verification_failed and refuse to auto-close.
      return verification.ok
        ? { stopReason: "passed", closeable: true, rounds }
        : { stopReason: "verification_failed", closeable: false, rounds };
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
    const fix = deps.fix(review.findings);
    rec.fixAttempted = true;
    if (!fix.ok) {
      rec.fixError = fix.error;
      rounds.push(rec);
      return { stopReason: "fixer_failed", closeable: false, rounds };
    }
    rounds.push(rec); // fixed; next round re-verifies + re-reviews
  }

  /* istanbul ignore next — maxRounds>=1 always returns inside the loop */
  return { stopReason: "needs_fix_max_rounds", closeable: false, rounds };
}
