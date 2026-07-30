// FG-639 (evidence-led review, Change 2): Stage 5's host-side result schema.
//
// The fixer reports PER FINDING — files changed, what it did, the test or existing
// evidence it used, any interaction with another finding, and whether it believes the
// finding cannot be resolved without changing scope. A scope-changing conflict is a
// FIRST-CLASS outcome, not an error: it returns that finding to disposition as an
// architecture question and lets the rest of the batch proceed. Guessing through a scope
// conflict is how a remediation batch quietly redesigns the change.
//
// Identity and storage live in src/store/fix-batches.ts; this module owns the shape.

import { z } from "zod";
import { FIX_RESULTS, type IncomingFixResult } from "../store/fix-batches.js";

const PerFindingSchema = z
  .object({
    finding_id: z.string().trim().min(1),
    result: z.enum(FIX_RESULTS),
    remediation_summary: z.string().trim().min(1),
    files_changed: z.array(z.string().trim().min(1)).default([]),
    /** The test added or the existing evidence used. Required — a remediation with no
     *  named evidence gives the rechecker nothing to verify. */
    evidence: z.string().trim().min(1),
    interaction: z.string().trim().min(1).optional(),
    /** Required when result is `scope_change`: what scope would have to move. */
    scope_change_reason: z.string().trim().min(1).optional(),
    evidence_path: z.string().trim().min(1).optional(),
    evidence_sha256: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.result === "scope_change" && v.scope_change_reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope_change_reason"],
        message: "a scope_change result must say what scope would have to move",
      });
    }
  });

export const FixerResultSchema = z
  .object({
    fix_batch_id: z.string().trim().min(1),
    revision: z.number().int().positive(),
    findings: z.array(PerFindingSchema).min(1),
  })
  .passthrough();

export type FixerResult = z.infer<typeof FixerResultSchema>;

export type FixerParse =
  | { ok: true; claimedBatchId: string; claimedRevision: number; results: IncomingFixResult[]; scopeChanges: string[] }
  | { ok: false; refusal: string };

/** Shape-validate a fixer's result.json. Batch identity, membership completeness, and
 *  storage are the store's job — this only turns bytes into the typed rows it expects. */
export function parseFixerResult(raw: unknown): FixerParse {
  const parsed = FixerResultSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, refusal: `fixer result.json invalid: ${detail}. Nothing was written.` };
  }
  const data = parsed.data;
  return {
    ok: true,
    claimedBatchId: data.fix_batch_id,
    claimedRevision: data.revision,
    results: data.findings.map((f) => ({
      findingId: f.finding_id,
      result: f.result,
      summary: f.remediation_summary,
      filesChanged: f.files_changed,
      evidence:
        f.result === "scope_change" && f.scope_change_reason !== undefined
          ? `${f.evidence}\n\nscope change: ${f.scope_change_reason}`
          : f.evidence,
      interaction: f.interaction,
      evidencePath: f.evidence_path,
      evidenceSha256: f.evidence_sha256,
    })),
    scopeChanges: data.findings.filter((f) => f.result === "scope_change").map((f) => f.finding_id),
  };
}
