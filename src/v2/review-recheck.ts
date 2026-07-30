// FG-639 (evidence-led review, Change 2): Stage 8 — exact recheck + bounded delta review.
//
// TWO BOUNDED JOBS, AND NOTHING ELSE. The `review-rechecker` role rechecks every KNOWN
// finding id exactly — does this specific mechanism still exist at the current sha — and
// discovers over the post-discovery delta plus the production paths directly adjacent to
// it. It does not resample the repository, and it never launches another discovery panel.
//
// OMISSION IS A SCHEMA FAILURE, NEVER RESOLUTION. This is the one rule the whole stage
// turns on. A finding that simply does not appear in the recheck output has NOT been
// shown to be fixed — the previous review model's central mistake was reading a later
// reviewer's silence as resolution, and the only way to keep that from recurring is for
// the host to refuse the ENTIRE result when an expected id is missing, rather than
// applying the ids that happened to be present.
//
// The rechecker VERIFIES evidence; it does not repeat the fixer's claim. When the proof
// it needs is unavailable, the result is `inconclusive` and the finding returns to
// disposition — synthesizing closure, or spawning a fresh panel to go look for a better
// answer, are both refused by construction (there is no "escalate" arm in this schema).

import { z } from "zod";
import { REACHABILITY, type DiscoveryFinding } from "./review-discovery.js";
import { RISK_LENSES } from "./review-contract.js";
import {
  validateResolutionEvidence,
  type CoverageOutcome,
  type ResolutionEvidenceKind,
} from "./review-evidence.js";
import type { Resolution, ReviewFinding } from "../store/reviews.js";

export const RECHECK_RESULTS = ["resolved", "still_present", "inconclusive"] as const;
export type RecheckResultValue = (typeof RECHECK_RESULTS)[number];

const PerFindingSchema = z
  .object({
    finding_id: z.string().trim().min(1),
    result: z.enum(RECHECK_RESULTS),
    evidence_kind: z.enum(["regression_test", "replayed_reproduction", "anchored_verification", "bounded_inspection"]),
    /** The structured evidence payload — validated against the finding's original
     *  reachability and the skip-evidence rule by src/v2/review-evidence.ts. */
    evidence: z.unknown(),
    note: z.string().trim().min(1).optional(),
  })
  .strict();

/** A finding the bounded delta review found. Same required shape as a discovery finding:
 *  a late finding is a finding, and it earns no exemption from anchoring or reachability
 *  for having arrived late. */
const NewFindingSchema = z
  .object({
    summary: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    severity: z.string().trim().min(1),
    risk_lens: z.enum(RISK_LENSES),
    reachability: z.enum(REACHABILITY),
    challenges_contract: z.boolean(),
    remediation_advice: z.string().trim().min(1),
    file: z.string().trim().min(1).optional(),
    line: z.number().int().positive().optional(),
    quoted_text: z.string().min(1).optional(),
    acceptance_ref: z.string().trim().min(1).optional(),
    invariant_ref: z.string().trim().min(1).optional(),
    finding_type: z.string().trim().min(1).optional(),
    hypothesis: z.string().trim().min(1).optional(),
    finding_id: z.string().trim().min(1).optional(),
  })
  .strict();

export const RecheckOutputSchema = z
  .object({
    review_id: z.string().trim().min(1),
    candidate_sha: z.string().trim().min(1),
    rechecked: z.array(PerFindingSchema).default([]),
    new_findings: z.array(NewFindingSchema).default([]),
  })
  .passthrough();

export type RecheckOutput = z.infer<typeof RecheckOutputSchema>;

export type RecheckApplication = {
  findingId: string;
  findingRef: string;
  resolution: Resolution;
  evidenceKind?: ResolutionEvidenceKind;
  evidence?: string;
  /** Recorded whenever resolution is NOT `resolved` because coverage did not execute. */
  coverage: CoverageOutcome;
  detail: string;
};

export type RecheckIngestion =
  | {
      ok: true;
      applications: RecheckApplication[];
      newFindings: DiscoveryFinding[];
      /** True when at least one result came back `still_present` or `inconclusive` — the
       *  review returns to disposition and NO fixer is dispatched automatically. */
      returnsToDisposition: boolean;
    }
  | { ok: false; refusal: string };

export type RecheckContext = {
  reviewId: string;
  candidateSha: string;
  /** Every finding whose id the rechecker was asked about — the current `fix_now` set. */
  expected: readonly ReviewFinding[];
};

/** Ingest a rechecker's output, host-side.
 *
 *  Refusal order matters: identity first (a result about another review or another
 *  candidate is not about this one), then membership, then completeness. Nothing is
 *  applied unless the whole result survives — a partially-applied recheck would leave
 *  some findings resolved on the strength of a result the host rejected. */
export function ingestRecheck(raw: unknown, ctx: RecheckContext): RecheckIngestion {
  const parsed = RecheckOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, refusal: `recheck result.json invalid: ${detail}. Nothing was written.` };
  }
  const out = parsed.data;

  if (out.review_id !== ctx.reviewId) {
    return {
      ok: false,
      refusal: `recheck result names review ${out.review_id}, not ${ctx.reviewId}. Nothing was written.`,
    };
  }
  if (out.candidate_sha !== ctx.candidateSha) {
    return {
      ok: false,
      refusal:
        `recheck result is bound to candidate ${out.candidate_sha}, not the current ${ctx.candidateSha} — ` +
        `a recheck at another candidate is not evidence about this one. Nothing was written.`,
    };
  }

  const byId = new Map(ctx.expected.map((f) => [f.id, f]));
  const byRef = new Map(ctx.expected.map((f) => [f.findingRef, f]));
  const seen = new Set<string>();
  const resolved: Array<{ finding: ReviewFinding; entry: z.infer<typeof PerFindingSchema> }> = [];

  for (const entry of out.rechecked) {
    const finding = byId.get(entry.finding_id) ?? byRef.get(entry.finding_id);
    if (finding === undefined) {
      return {
        ok: false,
        refusal:
          `recheck result names ${entry.finding_id}, which is not one of the findings it was asked to recheck ` +
          `(${ctx.expected.map((f) => f.findingRef).join(", ")}). Nothing was written.`,
      };
    }
    if (seen.has(finding.id)) {
      return {
        ok: false,
        refusal: `recheck result reports ${finding.findingRef} more than once — exactly one result per id. Nothing was written.`,
      };
    }
    seen.add(finding.id);
    resolved.push({ finding, entry });
  }

  const omitted = ctx.expected.filter((f) => !seen.has(f.id));
  if (omitted.length > 0) {
    return {
      ok: false,
      refusal:
        `recheck result omits ${omitted.map((f) => f.findingRef).join(", ")} — omission is a schema failure, ` +
        `never resolution. ${omitted.length === 1 ? "That finding remains" : "Those findings remain"} open. ` +
        `Nothing was written.`,
    };
  }

  const applications: RecheckApplication[] = [];
  for (const { finding, entry } of resolved) {
    if (entry.result !== "resolved") {
      applications.push({
        findingId: finding.id,
        findingRef: finding.findingRef,
        resolution: entry.result,
        coverage: "executed",
        detail: entry.note ?? `rechecker reported ${entry.result}`,
      });
      continue;
    }

    const reachability = (REACHABILITY as readonly string[]).includes(finding.reachability ?? "")
      ? (finding.reachability as (typeof REACHABILITY)[number])
      : // A finding with no recorded reachability is treated as the STRICTEST case. An
        // unknown reachability must not be the cheap path to resolution.
        "demonstrated";

    const check = validateResolutionEvidence(entry.evidence, {
      candidateSha: ctx.candidateSha,
      reachability,
      findingRef: finding.findingRef,
    });

    if (check.ok) {
      if (check.kind !== entry.evidence_kind) {
        applications.push({
          findingId: finding.id,
          findingRef: finding.findingRef,
          resolution: "inconclusive",
          coverage: "not_executed",
          detail:
            `${finding.findingRef}: declared evidence_kind '${entry.evidence_kind}' does not match the payload ` +
            `('${check.kind}') — recorded inconclusive rather than guessing which was meant.`,
        });
        continue;
      }
      applications.push({
        findingId: finding.id,
        findingRef: finding.findingRef,
        resolution: "resolved",
        evidenceKind: check.kind,
        evidence: check.detail,
        coverage: "executed",
        detail: check.detail,
      });
      continue;
    }

    // The rechecker claimed resolved; the evidence does not carry it. The honest record
    // is `inconclusive` plus the coverage outcome — never `resolved`, and never silence.
    applications.push({
      findingId: finding.id,
      findingRef: finding.findingRef,
      resolution: "inconclusive",
      coverage: check.coverage,
      detail: check.refusal,
    });
  }

  return {
    ok: true,
    applications,
    newFindings: out.new_findings,
    returnsToDisposition: applications.some((a) => a.resolution !== "resolved") || out.new_findings.length > 0,
  };
}

/** Is Stage 8 a no-op? Only when discovery produced no `fix_now` findings AND the
 *  candidate has not moved since discovery. Any post-discovery candidate change still
 *  gets the bounded delta review, even with an empty fix_now set — a docs phase that
 *  changed the candidate is a change nobody has reviewed yet. */
export function recheckIsNoOp(opts: {
  fixNowCount: number;
  contractConfirmedSha?: string;
  candidateSha?: string;
}): boolean {
  if (opts.fixNowCount > 0) return false;
  if (opts.contractConfirmedSha === undefined || opts.candidateSha === undefined) return false;
  return opts.contractConfirmedSha === opts.candidateSha;
}
