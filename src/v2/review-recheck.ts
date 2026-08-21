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
import { REACHABILITY, toleratedRootKeys, type DiscoveryFinding } from "./review-discovery.js";
import { RISK_LENSES } from "./review-contract.js";
import {
  classifyRecheckCoverage,
  executedIdentityOf,
  ranTestNames,
  resolveTestExecution,
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

/** FG-650: the ROOT tolerates unknown keys — the harness output contract mandates `status`
 *  on every result.json — but they are STRIPPED and their names recorded, not passed
 *  through unnamed. Every required root field stays required and strictly typed, and the
 *  per-ID entries above stay `.strict()`. */
const RECHECK_ROOT_KEYS = ["review_id", "candidate_sha", "rechecked", "new_findings"] as const;

export const RecheckOutputSchema = z.object({
  review_id: z.string().trim().min(1),
  candidate_sha: z.string().trim().min(1),
  rechecked: z.array(PerFindingSchema).default([]),
  new_findings: z.array(NewFindingSchema).default([]),
});

export type RecheckOutput = z.infer<typeof RecheckOutputSchema>;

export type RecheckApplication = {
  findingId: string;
  findingRef: string;
  resolution: Resolution;
  evidenceKind?: ResolutionEvidenceKind;
  evidence?: string;
  /** What the entry's evidence establishes about EXECUTION, on every arm: the resolution
   *  arm's own coverage outcome, and — since FG-664 — the classified coverage of a
   *  `still_present`/`inconclusive` entry rather than an assumed `executed`. */
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
      /** Unknown ROOT keys the rechecker carried, stripped from the validated value and
       *  recorded so the tolerance lands in the stage evidence. Empty when there were none. */
      toleratedRootKeys: string[];
    }
  | { ok: false; refusal: string };

/** FG-744 (fork C): forge's OWN execution of the tier that actually contains a fixer's cited
 *  assertion — an integration (`*.integration.test.ts`) or worktree (`*.worktree.test.ts`) tier
 *  the review's fast gate does not run. The fast gate the rechecker runs structurally cannot
 *  contain such an assertion, so binding a resolution from its output records `not_executed`
 *  even though the assertion exists and passes at its own tier. This is the trusted LOCAL
 *  execution that replaces that fast-gate output for the finding it covers. The only trusted
 *  proof is forge running the tier itself; no operator-supplied output is ever admitted here
 *  (authenticated per-test CI evidence is FG-751, a separate ticket). */
export type TrustedTierRun = {
  /** The tier(s) forge executed for this finding (integration/worktree). */
  tiers: string[];
  /** The higher-tier test file(s) the run considered — the fixer's listed higher-tier set. */
  testFiles: string[];
  /** RF-3: the candidate SHA forge executed this tier AT. Resolution is refused unless it equals
   *  the recheck's current candidate — a run bound to a different sha is not evidence about this
   *  one, and nothing carries across a candidate move. */
  candidateSha: string;
  /** RF-2/RF-4: the ONE fixer-listed higher-tier file proven (by its own isolated run) to contain
   *  the cited assertion. `runnerOutput` is THAT file's isolated output, so resolution binds to the
   *  assertion's OWN test file — a same-named assertion in another listed file cannot resolve it.
   *  Undefined when NO listed file contained the assertion (nothing to bind to). */
  assertionFile?: string;
  /** RF-4: set when the cited assertion appeared in MORE THAN ONE listed file — an ambiguous
   *  binding that must refuse rather than pick one. Carries the colliding files for the detail. */
  ambiguousFiles?: string[];
  /** The isolated runner output of `assertionFile`. Undefined when `blocked` is set, when the
   *  binding was ambiguous, or when no listed file contained the assertion. */
  runnerOutput?: string;
  /** Set when forge could not execute the tier at all — an environment fault. Routes the
   *  finding to `blocked_environment` coverage, exactly as a rechecker-declared block does,
   *  so the stage stops with nothing written rather than recording a false verdict. */
  blocked?: string;
};

export type RecheckContext = {
  reviewId: string;
  candidateSha: string;
  /** Every finding whose id the rechecker was asked about — the current `fix_now` set. */
  expected: readonly ReviewFinding[];
  /** RF-5: the executed-assertion identity the FIXER named per finding id, from the ingested fix
   *  results. When present for a finding, a `resolved` verdict must have EXECUTED that same named
   *  assertion — the rechecker's own evidence identity must cover it, or the finding is recorded
   *  `inconclusive`/`not_executed`, never resolved on a DIFFERENT test than the one remediation
   *  identified. Absent for a finding the fixer named no assertion for (a non-demonstrated one). */
  fixerAssertions?: Record<string, string>;
  /** FG-744 (fork C): forge's OWN trusted tier execution, keyed by finding id, for a finding
   *  whose fixer-cited assertion lives in a tier the fast gate does not run. When present for a
   *  finding, THIS local execution — not the rechecker's self-reported runner_output — is the
   *  authority for that finding's resolution: it resolves ONLY on proof the fixer's exact cited
   *  assertion EXECUTED and PASSED here, at this candidate. See TrustedTierRun. */
  trustedTierRuns?: Record<string, TrustedTierRun>;
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
    // FG-744 (fork C): forge ran the tier that actually contains this finding's cited
    // assertion. That LOCAL execution is the authority — not the rechecker's self-reported
    // runner_output, which comes from the fast gate that structurally cannot contain an
    // integration/worktree assertion (so it would record `not_executed` for one that exists
    // and passes). The finding resolves ONLY on proof the fixer's EXACT cited assertion
    // executed and passed here, bound to this candidate; a skipped, red, absent or unnamed
    // assertion never resolves. The rechecker's own verdict for this id is superseded by
    // forge's execution, exactly because the only trusted proof is forge running the tier.
    const trusted = ctx.trustedTierRuns?.[finding.id];
    if (trusted !== undefined) {
      applications.push(applyTrustedTierRun(finding, trusted, ctx.fixerAssertions?.[finding.id], ctx.candidateSha));
      continue;
    }

    if (entry.result !== "resolved") {
      // FG-664: THE COVERAGE RECORDED HERE IS CLASSIFIED, NEVER ASSUMED. This arm used to
      // push `coverage: "executed"` as a constant, so a lane that could not run a single
      // test still wrote executed coverage into the ledger for every finding it reported —
      // which is exactly how three `still_present` verdicts from a rechecker running against
      // a SUBSTITUTED database engine were recorded as though tests had run (FG-662,
      // review-6b9e07e48cc6). Every mechanical primitive in this stage sat on the `resolved`
      // arm; this arm was accepted on a free-text note.
      //
      // THE VERDICT IS UNTOUCHED. `entry.result` is recorded exactly as the rechecker
      // reported it, and the note stays the detail. Only the coverage FACT is now derived
      // from what the entry actually carries.
      //
      // THE CEILING, HONESTLY: this closes the case where the lane DECLARES it could not
      // run. A substituted engine that emits plausible `not ok` lines is textually
      // indistinguishable from a real regression, so no ingestion-side rule can catch it —
      // that is the host-side, pre-dispatch half of FG-664, and this is not it.
      applications.push({
        findingId: finding.id,
        findingRef: finding.findingRef,
        resolution: entry.result,
        coverage: classifyRecheckCoverage(entry.evidence),
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
      // RF-5: the recheck must have executed the SAME assertion the FIXER named for this finding.
      // Stage 8 is the sole candidate-bound executor (FG-639); binding it to the fixer's
      // `executed_assertion` is what stops a demonstrated finding from being recorded resolved on a
      // DIFFERENT passing test than the remediation identified — which would make executed_assertion
      // decorative and rest resolution on an assertion nobody tied to the fix. A mismatch is
      // inconclusive/not_executed, never resolved. Only bound when the fixer named an assertion.
      const named = ctx.fixerAssertions?.[finding.id];
      if (named !== undefined && named.trim() !== "") {
        const required = ranTestNames(named);
        const executed = new Set(executedIdentityOf(check.evidence));
        const uncovered = required.filter((n) => n === "" || !executed.has(n));
        if (uncovered.length > 0) {
          applications.push({
            findingId: finding.id,
            findingRef: finding.findingRef,
            resolution: "inconclusive",
            coverage: "not_executed",
            detail:
              `${finding.findingRef}: the recheck resolved on '${check.kind}' evidence that executed ` +
              `[${[...executed].join(", ") || "no named test"}], which does not include the executed assertion the ` +
              `fixer named ('${named}'). Stage 8 must execute THIS named assertion — recorded inconclusive, not ` +
              `resolved on a different test than the remediation identified.`,
          });
          continue;
        }
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
    toleratedRootKeys: toleratedRootKeys(raw, RECHECK_ROOT_KEYS),
  };
}

/** FG-744 (fork C): decide a finding from forge's OWN trusted tier run. The evidence-sufficiency
 *  bar is UNCHANGED — only a proven execution of the exact cited assertion resolves; a blocked
 *  environment, a skipped test, a red (failed) test, an absent one, or a run with no fixer-named
 *  assertion to bind resolves NOTHING. A regression_test that executed and passed satisfies every
 *  reachability, so no proportionality arm is needed here. */
function applyTrustedTierRun(
  finding: ReviewFinding,
  trusted: TrustedTierRun,
  named: string | undefined,
  currentCandidateSha: string,
): RecheckApplication {
  const where = `${trusted.tiers.join("+")} tier (${trusted.assertionFile ?? trusted.testFiles.join(", ")})`;

  if (trusted.blocked !== undefined) {
    // The environment could not run the tier. `blocked_environment` coverage is never green
    // and never resolved — the coordinator STOPS the stage on it, so nothing is recorded as
    // present or absent from a lane that could not run.
    return {
      findingId: finding.id,
      findingRef: finding.findingRef,
      resolution: "inconclusive",
      coverage: "blocked_environment",
      detail:
        `${finding.findingRef}: forge could not execute the ${where} at the candidate (${trusted.blocked}) — ` +
        `coverage is blocked_environment, never green and never resolved.`,
    };
  }

  // RF-3: a trusted run is evidence about the candidate it EXECUTED AT and no other. A run stamped
  // with a different sha (a stale run carried across a candidate move) resolves nothing — the
  // invariant is that a candidate move invalidates a resolution and nothing carries across it.
  if (trusted.candidateSha !== currentCandidateSha) {
    return {
      findingId: finding.id,
      findingRef: finding.findingRef,
      resolution: "inconclusive",
      coverage: "not_executed",
      detail:
        `${finding.findingRef}: the trusted ${where} run is bound to candidate ${trusted.candidateSha}, not the ` +
        `current ${currentCandidateSha} — a run at another candidate is not evidence about this one, never resolved.`,
    };
  }

  // The fast gate cannot contain this assertion, so a tier run with no fixer-named assertion to
  // bind proves nothing about THIS finding — there is no identity to check executed.
  if (named === undefined || named.trim() === "") {
    return {
      findingId: finding.id,
      findingRef: finding.findingRef,
      resolution: "inconclusive",
      coverage: "not_executed",
      detail:
        `${finding.findingRef}: forge executed the ${where} but the fixer named no executed assertion to bind the ` +
        `resolution to — recorded inconclusive, not resolved on an unnamed test.`,
    };
  }

  // RF-4: the cited assertion label appeared in MORE THAN ONE fixer-listed higher-tier file. A
  // same-named assertion in an unrelated file must not stand in for the one the finding names, and
  // forge cannot know which was meant — so it refuses the binding rather than pick one.
  if (trusted.ambiguousFiles !== undefined && trusted.ambiguousFiles.length > 1) {
    return {
      findingId: finding.id,
      findingRef: finding.findingRef,
      resolution: "inconclusive",
      coverage: "not_executed",
      detail:
        `${finding.findingRef}: the cited assertion '${named}' appears in more than one fixer-listed higher-tier ` +
        `file (${trusted.ambiguousFiles.join(", ")}) — an ambiguous binding is refused, never resolved on a ` +
        `same-named assertion in a file that may not be its own.`,
    };
  }

  // RF-2/RF-4: no fixer-listed higher-tier file was proven to CONTAIN the cited assertion. Without
  // an assertion-to-file binding there is nothing this run's output proves about THIS finding — the
  // resolution is not bound to the assertion's own test file, so it does not resolve.
  if (trusted.assertionFile === undefined) {
    return {
      findingId: finding.id,
      findingRef: finding.findingRef,
      resolution: "inconclusive",
      coverage: "not_executed",
      detail:
        `${finding.findingRef}: no fixer-listed higher-tier file (${trusted.testFiles.join(", ")}) contained the ` +
        `cited assertion '${named}' — with no file that contains it, resolution has nothing to bind to.`,
    };
  }

  const { execution, test } = resolveTestExecution(trusted.runnerOutput ?? "", named);
  if (execution === "executed") {
    const detail = `'${named}' executed and passed in forge's ${where} run at the candidate`;
    return {
      findingId: finding.id,
      findingRef: finding.findingRef,
      resolution: "resolved",
      evidenceKind: "regression_test",
      evidence: detail,
      coverage: "executed",
      detail,
    };
  }

  // A RED assertion is the finding still being present — it RAN, so its coverage is `executed`,
  // but it never resolves. A skipped or absent one never ran at all.
  return {
    findingId: finding.id,
    findingRef: finding.findingRef,
    resolution: execution === "failed" ? "still_present" : "inconclusive",
    coverage: execution === "failed" ? "executed" : "not_executed",
    detail:
      execution === "failed"
        ? `${finding.findingRef}: '${test}' FAILED in forge's ${where} run at the candidate — a red assertion is ` +
          `the finding still being present, never a resolution.`
        : `${finding.findingRef}: the fixer's cited assertion '${named}' ` +
          `${execution === "skipped" ? "SKIPPED" : "did not appear"} in forge's ${where} run at the candidate — ` +
          `a ${execution === "skipped" ? "skipped test" : "test that never ran"} never resolves a finding.`,
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
