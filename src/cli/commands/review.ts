// FG-638 (evidence-led review, Change 1): the operator surfaces over the review
// ledger — one read verb and one write verb.
//
// `forge review start` / `continue` (the coordinator) are FG-639. What exists here
// is deliberately the half that has no behavior to drive: reading a review, and
// recording a disposition with its authority and preconditions enforced.

import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import { assertStoreForLookup } from "../no-store.js";
import {
  DISPOSITIONS,
  DISPROVING_EVIDENCE_KINDS,
  recordDisposition,
  lookupFinding,
  summarizeReview,
  type Disposition,
  type ReviewFinding,
  type ReviewSummary,
} from "../../store/reviews.js";

const DASH = "—";

function anchorOf(f: ReviewFinding): string | undefined {
  if (f.file === undefined) return undefined;
  const at = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  return f.quotedText !== undefined ? `${at} "${f.quotedText}"` : at;
}

function sourceLabel(s: { redRole?: string; redTaskId?: string; verdictId?: string; modelFindingId?: string }): string {
  const who = s.redRole ?? s.redTaskId ?? s.verdictId ?? (s.modelFindingId !== undefined ? "model-supplied id" : "unattributed");
  const via = s.verdictId !== undefined && s.redRole !== undefined ? ` (${s.verdictId})` : "";
  return `${who}${via}`;
}

function counts(record: Record<string, number>): string {
  const parts = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return parts.length === 0 ? DASH : parts.map(([k, n]) => `${k} ${n}`).join(", ");
}

/** The human render, exported so the operator surface is asserted directly rather
 *  than inferred from the JSON one. */
export function renderReview(s: ReviewSummary): string {
  const r = s.review;
  const lines: string[] = [];
  lines.push(`Review ${r.id}`);
  lines.push(`  state:              ${r.state}`);
  lines.push(`  review mode:        ${r.reviewMode}`);
  lines.push(`  ticket:             ${r.ticketId ?? DASH}`);
  lines.push(`  run:                ${r.runId ?? DASH}`);
  lines.push(`  subject task:       ${r.subjectTaskId ?? DASH}`);
  lines.push(`  base sha:           ${r.baseSha ?? DASH}`);
  lines.push(`  contract confirmed: ${r.contractConfirmedSha ?? DASH}`);
  lines.push(`  candidate sha:      ${r.candidateSha ?? DASH}`);
  lines.push(`  trusted remote sha: ${r.trustedRemoteSha ?? DASH}`);
  lines.push(`  risk lenses:        ${s.riskLenses.length > 0 ? s.riskLenses.join(", ") : DASH}`);
  lines.push(`  dispositions:       ${counts(s.countsByDisposition)}`);
  lines.push(`  resolutions:        ${counts(s.countsByResolution)}`);
  lines.push(`  unsettled findings: ${s.unsettledCount}`);
  if (r.settledAt !== undefined) lines.push(`  settled at:         ${r.settledAt}`);

  lines.push("");
  if (s.findings.length === 0) {
    lines.push("Findings: none ingested yet");
    return lines.join("\n");
  }
  lines.push("Findings:");
  for (const f of s.findings) {
    const facets = [f.severity, f.riskLens, f.reachability].filter((x) => x !== undefined).join("/");
    lines.push(`  ${f.findingRef} [${facets === "" ? DASH : facets}] ${f.summary}`);
    lines.push(`      id: ${f.id}`);
    const anchor = anchorOf(f);
    if (anchor !== undefined) lines.push(`      anchor: ${anchor}`);
    if (f.acceptanceRef !== undefined) lines.push(`      acceptance: ${f.acceptanceRef}`);
    if (f.invariantRef !== undefined) lines.push(`      invariant: ${f.invariantRef}`);
    lines.push(`      sources: ${f.sources.length === 0 ? DASH : f.sources.map(sourceLabel).join(", ")}`);
    const by = f.decidedBy !== undefined ? ` (by ${f.decidedBy}${f.decidedAt !== undefined ? ` at ${f.decidedAt}` : ""})` : "";
    lines.push(`      disposition: ${f.disposition}${by}`);
    if (f.dispositionRationale !== undefined) lines.push(`      rationale: ${f.dispositionRationale}`);
    if (f.dispositionEvidence !== undefined) lines.push(`      evidence: ${f.dispositionEvidence}`);
    if (f.duplicateOf !== undefined) lines.push(`      duplicate of: ${f.duplicateOf}`);
    if (f.followupTicketId !== undefined) lines.push(`      follow-up: ${f.followupTicketId}`);
    lines.push(`      resolution: ${f.resolution ?? DASH}${f.resolvedSha !== undefined ? ` at ${f.resolvedSha}` : ""}`);
    if (f.resolutionEvidence !== undefined) {
      lines.push(`      resolution evidence: [${f.resolutionEvidenceKind ?? DASH}] ${f.resolutionEvidence}`);
    }
  }
  return lines.join("\n");
}

type DispositionOpts = {
  rationale?: string;
  evidence?: string;
  evidenceKind?: string;
  duplicateOf?: string;
  ticket?: string;
  operator?: boolean;
  review?: string;
  json?: boolean;
};

export function registerReview(program: Command): void {
  const review = program
    .command("review")
    .description("Read and disposition the durable review ledger (evidence-led review lifecycle)");

  review
    .command("show")
    .argument("<review-id>", "review id")
    .option("--json", "emit the review summary and findings as JSON")
    .description("Render a review's summary and findings, read-only")
    .action((reviewId: string, opts: { json?: boolean }) => {
      ensureForgeDirs();
      assertStoreForLookup(`review ${reviewId}`);
      const summary = summarizeReview(reviewId);
      if (!summary) throw new Error(`Not found: ${reviewId}`);
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log(renderReview(summary));
    });

  review
    .command("disposition")
    .argument("<finding-id>", "finding id (review-x/RF-2) or bare ref (RF-2, with --review when ambiguous)")
    .argument("<decision>", DISPOSITIONS.join(" | "))
    .option("--rationale <text>", "why this decision was made — required")
    .option("--evidence <text>", "disproving evidence for rejected_premise (candidate-bound)")
    .option("--evidence-kind <kind>", DISPROVING_EVIDENCE_KINDS.join(" | "))
    .option("--duplicate-of <finding-id>", "the canonical finding this one duplicates")
    .option("--ticket <ticket-id>", "the durable destination for a deferred finding")
    .option(
      "--operator",
      "record this as the operator's decision — required for an authority-changing accepted_risk " +
        "and for authorizing a new deferral destination",
    )
    .option("--review <review-id>", "scope a bare RF-n ref to one review")
    .option("--json", "emit the recorded disposition as JSON")
    .description("Record a disposition on a ledger finding, enforcing its per-value preconditions")
    .action((findingRef: string, decision: string, opts: DispositionOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`finding ${findingRef}`);

      if (!(DISPOSITIONS as readonly string[]).includes(decision)) {
        console.error(
          `forge review disposition: decision must be one of ${DISPOSITIONS.join(", ")} (got '${decision}'). Nothing was written.`,
        );
        process.exitCode = 1;
        return;
      }

      const found = lookupFinding(findingRef, { reviewId: opts.review });
      if (found.kind === "not_found") {
        console.error(`forge review disposition: no finding ${findingRef}. Nothing was written.`);
        process.exitCode = 1;
        return;
      }
      if (found.kind === "ambiguous") {
        console.error(
          `forge review disposition: '${findingRef}' matches ${found.candidates.length} findings ` +
            `(${found.candidates.map((c) => c.id).join(", ")}) — pass the full id or --review <review-id>. Nothing was written.`,
        );
        process.exitCode = 1;
        return;
      }

      const outcome = recordDisposition(found.finding.id, {
        decision: decision as Disposition,
        rationale: opts.rationale ?? "",
        operator: opts.operator === true,
        evidence: opts.evidence,
        evidenceKind: opts.evidenceKind,
        duplicateOf: opts.duplicateOf,
        followupTicketId: opts.ticket,
      });

      if (!outcome.ok) {
        console.error(`forge review disposition: ${outcome.refusal}`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      const f = outcome.finding;
      console.log(`${f.findingRef} (${f.id}): ${f.disposition} — decided by ${f.decidedBy} at ${f.decidedAt}`);
      console.log(`  candidate sha: ${f.decidedCandidateSha ?? DASH}`);
      console.log(`  rationale: ${f.dispositionRationale}`);
      if (f.dispositionEvidence !== undefined) console.log(`  evidence: ${f.dispositionEvidence}`);
      if (f.followupTicketId !== undefined) console.log(`  durable destination: ${f.followupTicketId}`);
      if (outcome.absorbedInto) {
        console.log(
          `  canonical ${outcome.absorbedInto.findingRef} now carries ${outcome.absorbedInto.sources.length} source(s) ` +
            `after absorbing this finding's provenance`,
        );
      }
    });
}
