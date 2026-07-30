// FG-639 (evidence-led review, Change 2): what counts as evidence.
//
// A SKIPPED TEST IS NEVER EVIDENCE (operator, 2026-07-29). That is the rule this module
// exists to make mechanical, and it is stricter than it first sounds:
//
//   - Execution is established PER TEST, from the runner's own output. A suite that
//     exited green while the cited test printed `# SKIP` proves nothing about the cited
//     assertion, and "the suite passed" is exactly the shape of that mistake.
//   - A cited test that does not APPEAR in the runner output is not evidence either.
//     Absence is unproven, not passing.
//   - When no mandatory lane executed a required assertion, the coverage is recorded
//     `not_executed` — or `blocked_environment` when the environment itself could not
//     run it — and the finding stays `inconclusive`. Never green. Never resolved.
//   - Alternate-lane coverage must NAME the lane, the candidate SHA, and the executed
//     assertion. Unnamed "covered elsewhere" is refused at ingestion, and a lane whose
//     sha is not this candidate's is refused by name.
//
// AND RESOLUTION EVIDENCE IS PROPORTIONAL TO THE FINDING'S ORIGINAL REACHABILITY:
//
//   demonstrated ⇒ a named regression test, a replayed reproduction, or an equivalent
//                  deterministic proof. Model re-inspection can never close it.
//   supported    ⇒ anchored contradictory evidence PLUS a relevant verification step.
//   speculative  ⇒ bounded inspection, with its limitation stated explicitly.
//
// "Named regression test" names a BEHAVIOR/INVARIANT in the canonical subsystem suite.
// It does not mean, and must not become, one new finding- or ticket-named test file per
// finding (FG-641 owns consolidating the existing ticket-named suite; this lifecycle's
// job is to stop adding to it).

import { z } from "zod";
import type { Reachability } from "./review-discovery.js";

export const RESOLUTION_EVIDENCE_KINDS = [
  "regression_test",
  "replayed_reproduction",
  "anchored_verification",
  "bounded_inspection",
] as const;
export type ResolutionEvidenceKind = (typeof RESOLUTION_EVIDENCE_KINDS)[number];

/** A claim that another mandatory lane executed the same assertion. All three fields are
 *  required because each one is a thing an unnamed claim leaves out: WHICH lane ran it,
 *  at WHICH candidate, and WHICH assertion actually executed. */
const AlternateLaneSchema = z
  .object({
    lane: z.string().trim().min(1),
    candidate_sha: z.string().trim().min(1),
    executed_assertion: z.string().trim().min(1),
    /** The lane's own runner output, so the named assertion is verified rather than
     *  asserted. Optional: a lane may be evidenced by its recorded transcript instead. */
    runner_output: z.string().optional(),
  })
  .strict();

export type AlternateLaneClaim = z.infer<typeof AlternateLaneSchema>;

const RegressionTestSchema = z
  .object({
    kind: z.literal("regression_test"),
    /** The test's name as the runner prints it. This is what per-test identity is
     *  matched against — a file path alone cannot establish that one test executed. */
    test_name: z.string().trim().min(1),
    /** Where it lives, for a reader. Not what execution is established from. */
    test_file: z.string().trim().min(1).optional(),
    runner_output: z.string().optional(),
    /** Set when the environment could not run the check at all. */
    environment_blocked: z.string().trim().min(1).optional(),
    alternate_lane: AlternateLaneSchema.optional(),
  })
  .strict();

const ReplayedReproductionSchema = z
  .object({
    kind: z.literal("replayed_reproduction"),
    command: z.string().trim().min(1),
    output: z.string().trim().min(1),
  })
  .strict();

const AnchoredVerificationSchema = z
  .object({
    kind: z.literal("anchored_verification"),
    file: z.string().trim().min(1),
    line: z.number().int().positive(),
    fact: z.string().trim().min(1),
    /** The "plus a relevant verification step" half. Anchored code reading alone is an
     *  argument about the source, not a verification of behavior. */
    verification_step: z.string().trim().min(1),
  })
  .strict();

const BoundedInspectionSchema = z
  .object({
    kind: z.literal("bounded_inspection"),
    inspection: z.string().trim().min(1),
    /** Required: a bounded inspection whose bound is unstated is presented as more than
     *  it is. */
    limitation: z.string().trim().min(1),
  })
  .strict();

export const ResolutionEvidenceSchema = z.discriminatedUnion("kind", [
  RegressionTestSchema,
  ReplayedReproductionSchema,
  AnchoredVerificationSchema,
  BoundedInspectionSchema,
]);

export type ResolutionEvidence = z.infer<typeof ResolutionEvidenceSchema>;

// ─── per-test execution identity ────────────────────────────────────────────

export type TestExecution = "executed" | "skipped" | "absent";

const TAP_LINE = /^\s*(?:not\s+)?ok\s+\d+\s*-?\s*(.+?)\s*$/;
const NODE_GLYPH_LINE = /^\s*[✔✖✗﹣~-]\s+(.+?)\s*(?:\(\d+(?:\.\d+)?m?s\))?\s*$/u;
const SKIP_DIRECTIVE = /#\s*(skip|todo)\b/i;

/** Strip the reporter's decorations off a captured test name. Order matters: the skip
 *  directive comes AFTER the duration in the glyph reporter's output, so removing the
 *  duration first leaves it stranded at the end of the name and nothing matches. */
function stripTiming(name: string): string {
  return name
    .replace(/#\s*(skip|todo)\b.*$/i, "")
    .replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, "")
    .trim();
}

/** Did THIS test execute, per the runner's own output?
 *
 *  Handles both shapes node:test emits — TAP (`ok 3 - name`, `ok 4 - name # SKIP`) and
 *  the spec/glyph reporter (`✔ name (1.2ms)`, `﹣ name (0ms) # SKIP`) — plus TAP's
 *  standalone `# SKIP`/`# TODO` directives. Matching is on the test NAME, because a
 *  suite-level exit code cannot distinguish a test that ran from one that was skipped:
 *  that conflation is the entire defect this function exists to catch.
 *
 *  A name that appears both skipped and executed reads as EXECUTED — that is the
 *  parameterized-suite case where one variant skipped and another ran the assertion. A
 *  name that appears only skipped reads as SKIPPED. A name that never appears is ABSENT. */
export function testExecution(runnerOutput: string, testName: string): TestExecution {
  const wanted = testName.trim();
  if (wanted === "") return "absent";
  let sawSkipped = false;

  for (const rawLine of runnerOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const tap = TAP_LINE.exec(line);
    const glyph = tap ? null : NODE_GLYPH_LINE.exec(line);
    const captured = tap?.[1] ?? glyph?.[1];
    if (captured === undefined) continue;

    const name = stripTiming(captured);
    if (name !== wanted && !name.endsWith(` > ${wanted}`) && !name.startsWith(`${wanted} > `)) continue;

    const skipped = SKIP_DIRECTIVE.test(line) || /^\s*[﹣~]/u.test(line);
    if (skipped) {
      sawSkipped = true;
      continue;
    }
    return "executed";
  }
  return sawSkipped ? "skipped" : "absent";
}

// ─── validation ─────────────────────────────────────────────────────────────

/** How coverage is RECORDED when it was not executed. Never green, never resolved. */
export const COVERAGE_OUTCOMES = ["executed", "not_executed", "blocked_environment"] as const;
export type CoverageOutcome = (typeof COVERAGE_OUTCOMES)[number];

export type EvidenceCheck =
  | { ok: true; kind: ResolutionEvidenceKind; coverage: "executed"; detail: string; evidence: ResolutionEvidence }
  | { ok: false; refusal: string; coverage: CoverageOutcome };

/** Which evidence kinds can close a finding of each reachability. Proportional, and
 *  stated as data so the three arms cannot drift apart in prose. */
const SUFFICIENT: Record<Reachability, readonly ResolutionEvidenceKind[]> = {
  demonstrated: ["regression_test", "replayed_reproduction"],
  supported: ["regression_test", "replayed_reproduction", "anchored_verification"],
  speculative: ["regression_test", "replayed_reproduction", "anchored_verification", "bounded_inspection"],
};

export type EvidenceContext = {
  /** The candidate the resolution is claimed against. An alternate lane must name THIS
   *  sha — coverage at some other candidate is coverage of some other code. */
  candidateSha: string;
  reachability: Reachability;
  findingRef: string;
};

/** Validate one resolution-evidence claim. Returns the evidence to store, or a refusal
 *  plus the coverage outcome to RECORD (`not_executed` / `blocked_environment`) so the
 *  caller writes the honest thing rather than nothing. */
export function validateResolutionEvidence(raw: unknown, ctx: EvidenceContext): EvidenceCheck {
  const parsed = ResolutionEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return {
      ok: false,
      coverage: "not_executed",
      refusal: `${ctx.findingRef}: resolution evidence did not validate: ${detail}`,
    };
  }
  const ev = parsed.data;

  const sufficient = SUFFICIENT[ctx.reachability];
  if (!sufficient.includes(ev.kind)) {
    return {
      ok: false,
      coverage: "not_executed",
      refusal:
        `${ctx.findingRef}: reachability '${ctx.reachability}' cannot be resolved by ${ev.kind} — ` +
        `it requires ${sufficient.join(" or ")}. ` +
        (ctx.reachability === "demonstrated"
          ? `A demonstrated finding is never closed by model re-inspection; it needs a named regression test, ` +
            `a replayed reproduction, or an equivalent deterministic proof (or an explicitly authorized ` +
            `limitation recorded as a disposition).`
          : `Nothing was resolved.`),
    };
  }

  if (ev.kind !== "regression_test") {
    return { ok: true, kind: ev.kind, coverage: "executed", detail: describeEvidence(ev), evidence: ev };
  }

  // A cited test. Everything below is the skip-evidence rule.
  if (ev.environment_blocked !== undefined) {
    const lane = checkAlternateLane(ev.alternate_lane, ctx);
    if (lane.ok) {
      return {
        ok: true,
        kind: ev.kind,
        coverage: "executed",
        detail:
          `${ev.test_name} could not run here (${ev.environment_blocked}) but ${lane.detail}`,
        evidence: ev,
      };
    }
    return {
      ok: false,
      coverage: "blocked_environment",
      refusal:
        `${ctx.findingRef}: the environment could not execute ${ev.test_name} (${ev.environment_blocked}) — ` +
        `coverage is recorded blocked_environment, never green and never resolved. ${lane.refusal}`,
    };
  }

  if (ev.runner_output === undefined || ev.runner_output.trim() === "") {
    return {
      ok: false,
      coverage: "not_executed",
      refusal:
        `${ctx.findingRef}: ${ev.test_name} is cited with no runner output, so nothing establishes that it ` +
        `EXECUTED against ${ctx.candidateSha}. A green suite is not per-test execution. Nothing was resolved.`,
    };
  }

  const execution = testExecution(ev.runner_output, ev.test_name);
  if (execution === "executed") {
    return {
      ok: true,
      kind: ev.kind,
      coverage: "executed",
      detail: `${ev.test_name} executed against ${ctx.candidateSha}`,
      evidence: ev,
    };
  }

  const lane = checkAlternateLane(ev.alternate_lane, ctx);
  if (lane.ok) {
    return {
      ok: true,
      kind: ev.kind,
      coverage: "executed",
      detail: `${ev.test_name} ${execution} here, but ${lane.detail}`,
      evidence: ev,
    };
  }

  const why =
    execution === "skipped"
      ? `${ev.test_name} SKIPPED in the cited runner output — a skipped test is never evidence, even when the ` +
        `enclosing suite exited green and the skip was named`
      : `${ev.test_name} does not appear in the cited runner output at all, so it was never established to run`;

  return {
    ok: false,
    coverage: "not_executed",
    refusal: `${ctx.findingRef}: ${why}. Coverage is recorded not_executed. ${lane.refusal}`,
  };
}

type LaneCheck = { ok: true; detail: string } | { ok: false; refusal: string };

/** A skip is sound ONLY when another mandatory lane executed the same assertion against
 *  the same candidate. That claim has to be named to be checkable. */
function checkAlternateLane(claim: AlternateLaneClaim | undefined, ctx: EvidenceContext): LaneCheck {
  if (claim === undefined) {
    return {
      ok: false,
      refusal:
        `No alternate lane is named. Claiming coverage elsewhere requires --lane-style naming: the lane, the ` +
        `candidate sha, and the executed assertion; unnamed "covered elsewhere" is refused.`,
    };
  }
  if (claim.candidate_sha !== ctx.candidateSha) {
    return {
      ok: false,
      refusal:
        `Alternate lane '${claim.lane}' names candidate ${claim.candidate_sha}, not this review's candidate ` +
        `${ctx.candidateSha} — coverage at another candidate is coverage of other code.`,
    };
  }
  if (claim.runner_output !== undefined && claim.runner_output.trim() !== "") {
    const laneExecution = testExecution(claim.runner_output, claim.executed_assertion);
    if (laneExecution !== "executed") {
      return {
        ok: false,
        refusal:
          `Alternate lane '${claim.lane}' claims '${claim.executed_assertion}' but its own output shows that ` +
          `assertion ${laneExecution}.`,
      };
    }
  }
  return {
    ok: true,
    detail:
      `mandatory lane '${claim.lane}' executed '${claim.executed_assertion}' against ${claim.candidate_sha}`,
  };
}

function describeEvidence(ev: ResolutionEvidence): string {
  switch (ev.kind) {
    case "regression_test":
      return `regression test ${ev.test_name}`;
    case "replayed_reproduction":
      return `replayed ${ev.command}`;
    case "anchored_verification":
      return `${ev.file}:${ev.line} — ${ev.fact} (verified by ${ev.verification_step})`;
    case "bounded_inspection":
      return `bounded inspection: ${ev.inspection} (limitation: ${ev.limitation})`;
  }
}

// ─── acceptance-criterion evidence (Stage 9 check 2) ────────────────────────

export const AC_VERDICTS = ["met", "unmet", "unproven"] as const;
export type AcVerdict = (typeof AC_VERDICTS)[number];

export type AcClaim = {
  ref: string;
  verdict: AcVerdict;
  /** The cited evidence. When the criterion is claimed `met`, this is validated by the
   *  same executed-test rule as a resolution: a criterion whose only evidence is a
   *  skipped test is `unproven`, not met. */
  evidence?: unknown;
};

export type AcAssessment = {
  ref: string;
  verdict: AcVerdict;
  detail: string;
};

/** Map each acceptance criterion to a settled verdict. A `met` claim is DOWNGRADED to
 *  `unproven` when its evidence does not establish execution against the reviewed
 *  candidate — the mapping is verified per test, not by a suite exiting green. */
export function assessAcceptanceClaims(claims: readonly AcClaim[], candidateSha: string): AcAssessment[] {
  return claims.map((c) => {
    if (c.verdict !== "met") {
      return { ref: c.ref, verdict: c.verdict, detail: `claimed ${c.verdict}` };
    }
    if (c.evidence === undefined) {
      return { ref: c.ref, verdict: "unproven", detail: `claimed met with no cited evidence` };
    }
    // An AC mapping is a claim about observed behavior, so `speculative` is the right
    // floor here: it accepts every evidence kind and lets the skip rule do the work.
    const check = validateResolutionEvidence(c.evidence, {
      candidateSha,
      reachability: "speculative",
      findingRef: c.ref,
    });
    return check.ok
      ? { ref: c.ref, verdict: "met", detail: check.detail }
      : { ref: c.ref, verdict: "unproven", detail: check.refusal };
  });
}
