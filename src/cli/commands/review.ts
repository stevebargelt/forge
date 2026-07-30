// FG-638 (evidence-led review, Change 1): the operator surfaces over the review
// ledger — reading a review, and recording a disposition with its authority and
// preconditions enforced.
//
// FG-639 (Change 2) adds the coordinator's two verbs. `start` verifies, confirms the
// contract against the final diff, discovers, and STOPS at disposition when findings
// exist — it never fixes. `continue` drives the ONE valid next transition from durable
// state and never repeats a completed stage; both read what to do next from the ledger
// rather than from anything the process that started the review was holding.
//
// This is a PILOT surface. The `feature` workflow is not migrated and no gate authority
// changes — both are FG-640.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import { assertStoreForLookup } from "../no-store.js";
import {
  DISPOSITIONS,
  DISPROVING_EVIDENCE_KINDS,
  recordDisposition,
  lookupFinding,
  summarizeReview,
  insertReview,
  getReview,
  findingsForReview,
  updateReview,
  type Disposition,
  type ReviewFinding,
  type ReviewSummary,
} from "../../store/reviews.js";
import { fixBatchesForReview } from "../../store/fix-batches.js";
import { newReviewId } from "../../util/ids.js";
import { nextTransition } from "../../v2/review-coordinator.js";
import { runNextStage, type CoordinatorDeps, type StageOutcome } from "../../v2/review-run.js";
import { validateReviewContract } from "../../v2/review-contract.js";
import { buildCoordinatorDeps, parseLensWidening } from "./review-wiring.js";
import type { AcClaim } from "../../v2/review-evidence.js";

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

type StartOpts = {
  project?: string;
  since?: string;
  contract?: string;
  run?: string;
  route?: string;
  unrouted?: boolean;
  addLens?: string[];
  drift?: string;
  evaluatedNoDrift?: string;
  json?: boolean;
};

type ContinueOpts = {
  project?: string;
  route?: string;
  unrouted?: boolean;
  addLens?: string[];
  drift?: string;
  evaluatedNoDrift?: string;
  acceptance?: string;
  all?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

function readJsonFile(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (err) {
    throw new Error(`forge review: could not read ${what} from ${path}: ${(err as Error).message}`);
  }
}

/** Build the deps once per invocation. `--add-lens` / `--evaluated-no-drift` / `--drift`
 *  are the three recorded evaluations of the final diff: a lens is ADDED with recorded
 *  evidence, an examined diff that needs no lens change is recorded as `no_drift`, and
 *  drift the coordinator cannot classify is NAMED so the review returns to
 *  plan/architecture. There is no path classifier and there is no flag that removes a lens. */
function depsFor(
  reviewId: string,
  opts: {
    project?: string;
    route?: string;
    unrouted?: boolean;
    addLens?: string[];
    drift?: string;
    evaluatedNoDrift?: string;
    acceptance?: string;
  },
): { ok: true; deps: CoordinatorDeps } | { ok: false; refusal: string } {
  const review = getReview(reviewId);
  if (!review) return { ok: false, refusal: `no review ${reviewId}` };

  const widening = parseLensWidening(opts.addLens ?? []);
  if (!widening.ok) return { ok: false, refusal: widening.refusal };

  const acceptance =
    opts.acceptance !== undefined ? (readJsonFile(opts.acceptance, "acceptance claims") as AcClaim[]) : undefined;

  return {
    ok: true,
    deps: buildCoordinatorDeps({
      projectDir: resolve(opts.project ?? process.cwd()),
      ticketId: review.ticketId ?? review.id,
      ...(review.runId !== undefined ? { runId: review.runId } : {}),
      ...(opts.route !== undefined ? { route: opts.route } : {}),
      ...(opts.unrouted !== undefined ? { unrouted: opts.unrouted } : {}),
      ...(widening.widening.length > 0 ? { addLenses: widening.widening } : {}),
      ...(opts.drift !== undefined ? { unclassifiableDrift: opts.drift } : {}),
      ...(opts.evaluatedNoDrift !== undefined ? { evaluatedNoDrift: opts.evaluatedNoDrift } : {}),
      ...(acceptance !== undefined ? { acceptance } : {}),
    }),
  };
}

function reportStage(outcome: StageOutcome, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(outcome, null, 2));
  } else {
    const glyph = outcome.status === "advanced" ? "✓" : outcome.status === "stopped" ? "•" : "✗";
    console.log(`${glyph} ${outcome.transition.kind}: ${outcome.message}`);
    if (outcome.shipping) {
      for (const c of outcome.shipping.checks) console.log(`    ${c.ok ? "✓" : "✗"} ${c.id} — ${c.detail}`);
    }
  }
  if (outcome.status === "refused") process.exitCode = 1;
}

function snapshotFor(reviewId: string) {
  const review = getReview(reviewId);
  if (!review) throw new Error(`Not found: ${reviewId}`);
  return { review, findings: findingsForReview(reviewId), batches: fixBatchesForReview(reviewId) };
}

export function registerReview(program: Command): void {
  const review = program
    .command("review")
    .description("Read and disposition the durable review ledger (evidence-led review lifecycle)");

  review
    .command("start")
    .argument("<ticket-id>", "the ticket whose landed implementation is under review")
    .option("--project <dir>", "the candidate workspace (default: cwd)")
    .option("--since <sha>", "the implementation comparison base")
    .option("--contract <file>", "the approved review contract, as JSON — required to open a review")
    .option("--run <run-id>", "attach the review to an existing run")
    .option("--route <route-key>", "the resolved routing-policy key for the dispatches this drives")
    .option("--unrouted", "acknowledge a deliberately unrouted dispatch")
    .option(
      "--add-lens <lens:reason:evidence>",
      "ADD a risk lens with recorded diff evidence (repeatable). The coordinator may widen the " +
        "contract; removing a lens or changing any other boundary returns to the approving authority",
      (v: string, acc: string[] = []) => [...acc, v],
    )
    .option("--drift <text>", "name implementation drift you cannot classify — returns to plan/architecture")
    .option(
      "--evaluated-no-drift <statement>",
      "record that you EXAMINED the final diff and no lens change is needed. The statement is stored with " +
        "the diff summary it was made against; the confirmation then advances",
    )
    .option("--json", "emit each stage outcome as JSON")
    .description("Open a review: verify, confirm the contract against the final diff, discover, stop at disposition")
    .action(async (ticketId: string, opts: StartOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`review for ${ticketId}`);

      if (opts.contract === undefined) {
        console.error(
          `forge review start: --contract <file> is required. The review contract is APPROVED by the plan gate ` +
            `and persisted with the review; it is never reconstructed from prompts after the fact. Nothing was written.`,
        );
        process.exitCode = 1;
        return;
      }
      const validated = validateReviewContract(readJsonFile(opts.contract, "review contract"));
      if (!validated.ok) {
        console.error(`forge review start: ${validated.refusal} Nothing was written.`);
        process.exitCode = 1;
        return;
      }

      const reviewId = newReviewId();
      insertReview({
        id: reviewId,
        reviewMode: "evidence_led",
        ticketId,
        ...(opts.run !== undefined ? { runId: opts.run } : {}),
        ...(opts.since !== undefined ? { baseSha: opts.since } : {}),
        contract: validated.contract,
        state: "confirming_contract",
      });

      const built = depsFor(reviewId, opts);
      if (!built.ok) {
        console.error(`forge review start: ${built.refusal}`);
        process.exitCode = 1;
        return;
      }
      const candidate = await built.deps.headSha();
      updateReview(reviewId, { candidateSha: candidate });

      console.log(`Review ${reviewId} — ticket ${ticketId}, candidate ${candidate}`);
      console.log(`  lenses: ${validated.contract.risk_lenses.join(", ")}`);

      // start drives stages 1–3 ONLY. It stops at disposition; it never fixes.
      const startStages = new Set(["verify_entry", "confirm_contract", "discover"]);
      for (;;) {
        const pending = nextTransition(snapshotFor(reviewId));
        if (!startStages.has(pending.kind)) {
          console.log(`• next: ${pending.kind} — ${pending.reason}`);
          console.log(`  run \`forge review continue ${reviewId}\` to drive it.`);
          break;
        }
        const outcome = await runNextStage(reviewId, built.deps);
        reportStage(outcome, opts.json === true);
        if (outcome.status !== "advanced") break;
      }
    });

  review
    .command("continue")
    .argument("<review-id>", "review id")
    .option("--project <dir>", "the candidate workspace (default: cwd)")
    .option("--route <route-key>", "the resolved routing-policy key for the dispatches this drives")
    .option("--unrouted", "acknowledge a deliberately unrouted dispatch")
    .option(
      "--add-lens <lens:reason:evidence>",
      "ADD a risk lens with recorded diff evidence (repeatable)",
      (v: string, acc: string[] = []) => [...acc, v],
    )
    .option("--drift <text>", "name implementation drift you cannot classify — returns to plan/architecture")
    .option(
      "--evaluated-no-drift <statement>",
      "record that you EXAMINED the final diff and no lens change is needed — the confirmation then advances",
    )
    .option("--acceptance <file>", "acceptance-criterion claims for the shipping review, as JSON")
    .option("--all", "keep driving while each transition advances, instead of one transition")
    .option("--dry-run", "report the one valid next transition and exit without running it")
    .option("--json", "emit each stage outcome as JSON")
    .description("Drive the ONE valid next transition from durable state — never repeats a completed stage")
    .action(async (reviewId: string, opts: ContinueOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`review ${reviewId}`);

      // --dry-run answers "what would continue do?" without dispatching anything. It reads
      // the same nextTransition the real run does, so the answer cannot drift from the act.
      if (opts.dryRun === true) {
        const pending = nextTransition(snapshotFor(reviewId));
        console.log(opts.json === true ? JSON.stringify({ transition: pending, status: "dry_run" }, null, 2) : `• next: ${pending.kind} — ${pending.reason}`);
        return;
      }

      const built = depsFor(reviewId, opts);
      if (!built.ok) {
        console.error(`forge review continue: ${built.refusal}`);
        process.exitCode = 1;
        return;
      }

      for (;;) {
        const outcome = await runNextStage(reviewId, built.deps);
        reportStage(outcome, opts.json === true);
        if (opts.all !== true || outcome.status !== "advanced") break;
      }

      if (opts.json !== true) {
        const pending = nextTransition(snapshotFor(reviewId));
        console.log(`  next: ${pending.kind} — ${pending.reason}`);
      }
    });

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
    .option(
      "--evidence <json>",
      "candidate-bound disproving evidence for rejected_premise, as a JSON payload whose fields " +
        "are set by --evidence-kind: replayed_command {command, output}, " +
        "deterministic_reproduction {reproduction, result}, anchored_contradiction {file, line, fact}",
    )
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
