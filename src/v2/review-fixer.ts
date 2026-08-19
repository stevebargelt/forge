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

/** FG-710 Shape A: the OPTIONAL, CONDITIONAL fields the fixer template prints. Forge's own
 *  template used to print these unconditionally, so an agent copying the example naturally
 *  emitted `""` for the ones its result did not use — and an empty string on a `min(1)`
 *  optional is a refusal, which discarded completed remediation work with no adoption path.
 *
 *  These are NORMALIZED to absence (an empty string means "I did not use this field"), scoped
 *  to exactly these keys. A required field — `evidence`, `remediation_summary` — is never in
 *  this set: an empty one still refuses loudly. `executed_assertion` is here so an empty one
 *  routes to the SEMANTIC Shape-B diagnostic (a demonstrated `fixed` finding names no executed
 *  assertion) rather than a bare `min(1)` parse error. */
const NORMALIZE_EMPTY_TO_ABSENT = [
  "interaction",
  "scope_change_reason",
  "evidence_path",
  "evidence_sha256",
  "executed_assertion",
] as const;

const PerFindingShape = z
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
    /** FG-710 Shape B: the candidate-bound executed-assertion identity the FG-639 recheck
     *  binds — the test NAME (or "; "-joined names) the fixer's proof executed. OPTIONAL at
     *  the schema level: the schema has no reachability, so it cannot know when this is
     *  required. The batch-aware requirement (a demonstrated `fixed` finding must name it)
     *  is enforced in ingestFixBatchResults, which has the payload's reachability. */
    executed_assertion: z.string().trim().min(1).optional(),
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

/** Delete the conditional-field keys whose value is exactly `""` BEFORE `.strict()` runs, so an
 *  empty optional string reads as absence rather than a refusal. Runs per finding object; a
 *  non-object is passed through untouched so the strict schema still produces its own error. */
const PerFindingSchema = z.preprocess((raw) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const key of NORMALIZE_EMPTY_TO_ABSENT) {
    if (obj[key] === "") {
      copy ??= { ...obj };
      delete copy[key];
    }
  }
  return copy ?? obj;
}, PerFindingShape);

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

/** Render one zod issue. AC3: an unknown-key refusal ENUMERATES EVERY offending key rather
 *  than the first — a strict-object issue carries them all in `issue.keys`, and the fixer that
 *  emitted three implementer keys should be told about all three in one pass, not made to
 *  rediscover them one refusal at a time (the FG-730 `no_validation_reason`/`docs_impact`
 *  case). `.strict()` is NOT weakened: the keys are still refused; only the message is fuller. */
function renderIssue(issue: z.ZodError["issues"][number]): string {
  const path = issue.path.join(".") || "(root)";
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((k) => `"${k}"`).join(", ");
    return `${path}: unrecognized key(s) — ${keys}. A fix-batch finding result does not carry these; remove them (they may belong to an implementer result).`;
  }
  return `${path}: ${issue.message}`;
}

/** Shape-validate a fixer's result.json. Batch identity, membership completeness, and
 *  storage are the store's job — this only turns bytes into the typed rows it expects. */
export function parseFixerResult(raw: unknown): FixerParse {
  const parsed = FixerResultSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(renderIssue).join("; ");
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
      executedAssertion: f.executed_assertion,
    })),
    scopeChanges: data.findings.filter((f) => f.result === "scope_change").map((f) => f.finding_id),
  };
}
