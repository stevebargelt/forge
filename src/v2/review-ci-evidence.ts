// FG-744: ingest exact-candidate required-CI evidence for a stranded fix_now finding.
//
// THE GAP THIS CLOSES. The evidence-led recheck (Stage 8) is the sole candidate-bound
// executor, and it runs the review's own verification lane — the FAST tier (typecheck +
// unit `test`). When a fixer's cited `executed_assertion` lives in an INTEGRATION or
// WORKTREE tier (`*.integration.test.ts` / `*.worktree.test.ts`), the fast-gate runner
// output STRUCTURALLY cannot contain it, so the recheck records the finding
// `inconclusive / not_executed` even though the assertion exists, is correct, and passes
// when its tier runs. Once the recheck has finalized at a candidate sha it does not re-run
// at an unchanged candidate, so a later green EXACT-CANDIDATE CI run that executed the
// tier had no channel to flip the finding to `resolved`. This module is that channel.
//
// IT ADMITS NOTHING THE RECHECK WOULD NOT. Evidence sufficiency is UNCHANGED: the CI run
// is modelled as exactly the `alternate_lane` the recheck already accepts — a mandatory
// lane that executed the SAME assertion against the SAME candidate, carrying that lane's
// OWN runner output — and validated through the identical `validateResolutionEvidence`
// path. A skipped test, a red executed test, absence from the CI output, or a lane at a
// different candidate never counts; only a proven exact-candidate execution of the cited
// assertion resolves it. And it never opens a new fixer/recheck cycle: it records a
// `resolved` resolution on an EXISTING finding and nothing else — no batch, no candidate
// move, no stage repeated. The one-fix-batch cap is untouched.
//
// THREE THINGS BIND IT (fix directions 1–3):
//   1. The cited assertion must live in a tier the fast recheck gate does not run — a
//      fast-tier assertion is the normal recheck's job, not this channel's.
//   2. Green REQUIRED CI at the EXACT current candidate sha must exist and cover that tier
//      (the caller supplies the verified GateEvidence; the whole derived gate list —
//      test:all + test:extended — being green is what proves the integration/worktree
//      tier ran off-host).
//   3. The evidence is bound to the EXACT candidate sha and to the fixer's OWN named
//      `executed_assertion` (RF-5), so CI at another candidate, or CI of a different test
//      than the remediation identified, resolves nothing.

import { z } from "zod";
import { REACHABILITY } from "./review-discovery.js";
import { validateResolutionEvidence, type ResolutionEvidenceKind } from "./review-evidence.js";
import type { ReviewFinding } from "../store/reviews.js";
import type { GateEvidence } from "../store/host-verifications.js";

export type TestTier = "fast" | "integration" | "worktree";

/** The tier a test FILE belongs to, decided by the same `*.integration.test.` /
 *  `*.worktree.test.` infixes the tier partition is cut on (see test-tiers.test.ts). A
 *  file with neither infix is fast-tier — the tier the recheck's own gate already runs. */
export function tierOfTestFile(testFile: string): TestTier {
  const path = testFile.trim().replace(/\\/g, "/");
  if (/\.worktree\.test\.[cm]?[jt]sx?$/i.test(path)) return "worktree";
  if (/\.integration\.test\.[cm]?[jt]sx?$/i.test(path)) return "integration";
  return "fast";
}

/** One finding an operator is rescuing with exact-candidate CI evidence. The operator
 *  names WHERE the cited assertion lives (`test_file`, for the tier check), WHICH required
 *  CI lane executed it (`ci_lane`), and attaches THAT lane's own runner output showing the
 *  assertion execute. The assertion identity itself is NOT taken from here — it is the
 *  fixer's own `executed_assertion`, so the operator cannot substitute a different test. */
const CiEvidenceFindingSchema = z
  .object({
    finding_id: z.string().trim().min(1),
    test_file: z.string().trim().min(1),
    ci_lane: z.string().trim().min(1),
    ci_runner_output: z.string().trim().min(1),
  })
  .strict();

export const CandidateCiEvidenceSchema = z
  .object({
    review_id: z.string().trim().min(1),
    candidate_sha: z.string().trim().min(1),
    findings: z.array(CiEvidenceFindingSchema).min(1),
  })
  .strict();

export type CandidateCiEvidence = z.infer<typeof CandidateCiEvidenceSchema>;

export type CiEvidenceApplication = {
  findingId: string;
  findingRef: string;
  evidenceKind: ResolutionEvidenceKind;
  evidence: string;
  detail: string;
};

export type CiEvidenceIngestion =
  | { ok: true; applications: CiEvidenceApplication[] }
  | { ok: false; refusal: string };

export type CiEvidenceContext = {
  reviewId: string;
  candidateSha: string;
  /** The current `fix_now` set — the only findings this channel can rescue. */
  expected: readonly ReviewFinding[];
  /** The executed-assertion identity the FIXER named per finding id, from the ingested fix
   *  results. Required per finding: with no cited assertion there is nothing to bind CI
   *  evidence to (RF-5). */
  fixerAssertions: Record<string, string>;
  /** The host's verified covering-gate evidence at the candidate sha — `null` when no green
   *  required CI (or covering host row) exists at the EXACT candidate. */
  gateEvidence: GateEvidence | null;
};

function gateEvidenceSha(ge: GateEvidence): string {
  return ge.source === "ci" ? ge.sha : ge.row.commitSha;
}

/** Ingest exact-candidate CI evidence for one or more stranded `fix_now` findings.
 *
 *  Refusal order mirrors the recheck's: identity first (a result about another review or
 *  another candidate is not about this one), then the exact-candidate CI precondition, then
 *  per-finding eligibility and evidence. Nothing is applied unless the WHOLE result
 *  survives — a partially-applied ingestion would resolve some findings on the strength of
 *  a result the host rejected. */
export function ingestCandidateCiEvidence(raw: unknown, ctx: CiEvidenceContext): CiEvidenceIngestion {
  const parsed = CandidateCiEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, refusal: `ci-evidence input invalid: ${detail}. Nothing was written.` };
  }
  const out = parsed.data;

  if (out.review_id !== ctx.reviewId) {
    return { ok: false, refusal: `ci-evidence names review ${out.review_id}, not ${ctx.reviewId}. Nothing was written.` };
  }
  if (out.candidate_sha !== ctx.candidateSha) {
    return {
      ok: false,
      refusal:
        `ci-evidence is bound to candidate ${out.candidate_sha}, not the current ${ctx.candidateSha} — ` +
        `CI at another candidate is evidence about other code. Nothing was written.`,
    };
  }

  // The exact-candidate CI precondition (AC2). Green required CI at the EXACT candidate sha,
  // covering the whole derived gate list (test:all + test:extended) — which is what proves
  // the integration/worktree tier ran off-host. No covering evidence, or evidence at another
  // sha, resolves nothing.
  if (ctx.gateEvidence === null) {
    return {
      ok: false,
      refusal:
        `no green required-CI covering evidence exists at candidate ${ctx.candidateSha}. Exact-candidate CI ` +
        `evidence is admissible only when the required CI gate is GREEN at this exact sha; a pending, failing, or ` +
        `absent run resolves nothing. Nothing was written.`,
    };
  }
  const geSha = gateEvidenceSha(ctx.gateEvidence);
  if (geSha !== ctx.candidateSha) {
    return {
      ok: false,
      refusal:
        `the covering-gate evidence is bound to ${geSha}, not the current candidate ${ctx.candidateSha}. ` +
        `Evidence is never carried across a candidate move. Nothing was written.`,
    };
  }

  const byId = new Map(ctx.expected.map((f) => [f.id, f]));
  const byRef = new Map(ctx.expected.map((f) => [f.findingRef, f]));
  const seen = new Set<string>();
  const applications: CiEvidenceApplication[] = [];

  for (const entry of out.findings) {
    const finding = byId.get(entry.finding_id) ?? byRef.get(entry.finding_id);
    if (finding === undefined) {
      return {
        ok: false,
        refusal:
          `ci-evidence names ${entry.finding_id}, which is not one of this review's fix_now findings ` +
          `(${ctx.expected.map((f) => f.findingRef).join(", ") || "none"}). Nothing was written.`,
      };
    }
    if (seen.has(finding.id)) {
      return {
        ok: false,
        refusal: `ci-evidence reports ${finding.findingRef} more than once — exactly one entry per finding. Nothing was written.`,
      };
    }
    seen.add(finding.id);

    // Only STRANDED findings are rescued. A finding already resolved at this candidate needs
    // no rescue, and re-ingesting over it would be relitigating a settled result.
    if (finding.resolution === "resolved" && finding.resolvedSha === ctx.candidateSha) {
      return {
        ok: false,
        refusal:
          `${finding.findingRef} is already resolved at ${ctx.candidateSha}, so there is nothing for CI evidence to ` +
          `rescue. Nothing was written.`,
      };
    }

    // RF-5: bind to the FIXER's own named assertion, never one the operator supplies. With no
    // cited assertion there is nothing to bind CI evidence to.
    const named = ctx.fixerAssertions[finding.id];
    if (named === undefined || named.trim() === "") {
      return {
        ok: false,
        refusal:
          `${finding.findingRef}: the fixer named no executed_assertion, so there is no cited assertion for CI ` +
          `evidence to bind to. This channel resolves a demonstrated fix on the exact test the remediation ` +
          `identified; there is none. Nothing was written.`,
      };
    }

    // The tier gate (AC1). A fast-tier assertion is one the recheck's own gate runs, so it
    // belongs to the normal recheck, not this channel.
    const tier = tierOfTestFile(entry.test_file);
    if (tier === "fast") {
      return {
        ok: false,
        refusal:
          `${finding.findingRef}: ${entry.test_file} is a fast-tier test, which the recheck's own gate executes. ` +
          `This CI-evidence channel is for an assertion whose tier the fast recheck gate structurally cannot run ` +
          `(*.integration.test / *.worktree.test); resolve a fast-tier assertion through the normal recheck. ` +
          `Nothing was written.`,
      };
    }

    const reachability = (REACHABILITY as readonly string[]).includes(finding.reachability ?? "")
      ? (finding.reachability as (typeof REACHABILITY)[number])
      : // An unknown reachability is treated as the STRICTEST case, exactly as the recheck does.
        "demonstrated";

    // Model the CI run as the `alternate_lane` the recheck already accepts, and validate it
    // through the IDENTICAL evidence path — so evidence sufficiency is unchanged (AC3). The
    // primary lane (the fast recheck gate) could not run this tier, which is precisely the
    // `environment_blocked` shape; the CI lane is the mandatory lane that DID.
    const evidence = {
      kind: "regression_test" as const,
      test_name: named,
      test_file: entry.test_file,
      environment_blocked:
        `the recheck lane runs the fast tier only; the ${tier} tier containing ${named} runs off-host in required CI`,
      alternate_lane: {
        lane: entry.ci_lane,
        candidate_sha: ctx.candidateSha,
        executed_assertion: named,
        runner_output: entry.ci_runner_output,
      },
    };
    const check = validateResolutionEvidence(evidence, {
      candidateSha: ctx.candidateSha,
      reachability,
      findingRef: finding.findingRef,
    });
    if (!check.ok) {
      return { ok: false, refusal: `${finding.findingRef}: CI evidence rejected: ${check.refusal} Nothing was written.` };
    }

    applications.push({
      findingId: finding.id,
      findingRef: finding.findingRef,
      evidenceKind: check.kind,
      evidence: check.detail,
      detail: check.detail,
    });
  }

  return { ok: true, applications };
}
