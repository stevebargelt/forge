// FG-640 (evidence-led review, Change 3): the `review_disposition` gate.
//
// THE AUTHORITY MOVES HERE. Under `review_mode: evidence_led` a reviewed step no longer
// advances on verdict aggregation — it advances on SETTLED LEDGER STATE. Every condition
// below is derived from durable rows (the review, its findings, its recorded lens outcomes
// and stage evidence); nothing is read from a variable held by whatever process last
// touched the review, and nothing is inferred from a red's raw pass/fail.
//
// TWO HALVES, AND THE SECOND IS THE ONE THAT USUALLY ROTS. The blocking list is what the
// gate refuses on. The NON-BLOCKING list is what it must NOT refuse on, and it is reported
// explicitly (`nonBlocking`) rather than being an absence — a raw advisory red `fail` whose
// findings are all dispositioned, a settled accepted_risk/deferred/rejected_premise/
// duplicate, and a historical verdict against a superseded sha are all things the legacy
// gate WOULD have blocked on, so "we no longer block on this" is a claim that deserves to
// be visible and tested rather than implied.
//
// NO NEW TASK STATUS (FG-585 vocabulary discipline). An evidence-led step parks at
// `awaiting_gate` exactly as a verdict step does; what changes is the GATE KIND that
// decides it, which every refusal names. `--force` still exists and is still the human's
// override — it is not the ordinary settlement path, and the refusal says so.

import { lensAcceptancesOf, lensOutcomeRecordsOf, type Review, type ReviewFinding } from "../store/reviews.js";
import type { VerdictRow } from "../types/index.js";
import { tasksForRun } from "../store/tasks.js";
import { gatesForTask } from "../store/gates.js";
import { logEvent } from "../store/events.js";
import type { Workflow } from "./schema.js";
import { assessDiscoveryCompleteness, type LensOutcome, type Reachability } from "./review-discovery.js";
import { validateReviewContract, type RiskLens } from "./review-contract.js";
import { evidenceKindSufficientFor, sufficientEvidenceKinds } from "./review-evidence.js";
import { verdictBlocksGate } from "./gate.js";

export const REVIEW_DISPOSITION_GATE = "review_disposition";

/** Every blocking condition the ticket enumerates, plus the migration-safety one.
 *  Named rather than numbered: a refusal an operator can grep for is worth more than a
 *  count of how many things are wrong. */
export const DISPOSITION_GATE_CONDITIONS = [
  "lens_outcome_missing",
  "contract_unreadable",
  "finding_untriaged",
  "architecture_question_open",
  "rejected_premise_unproven",
  "fix_now_unresolved",
  "fix_now_evidence_insufficient",
  "verification_absent_or_red",
  "acceptance_unmet",
  "tip_not_trusted",
  "review_absent",
  "mixed_authority_model",
  "review_mode_drift",
] as const;
export type DispositionGateConditionId = (typeof DISPOSITION_GATE_CONDITIONS)[number];

export type DispositionGateCondition = {
  id: DispositionGateConditionId;
  detail: string;
  /** The finding refs this condition names, when it is about findings. */
  findings?: string[];
};

/** What the gate explicitly did NOT block on. Reported so the widened-authority half of
 *  Change 3 is visible in the same place the narrowed half is. */
export type DispositionGateAllowance = {
  id: "advisory_red_fail_dispositioned" | "settled_disposition" | "superseded_verdict";
  detail: string;
};

export type ReviewDispositionAssessment = {
  gateKind: typeof REVIEW_DISPOSITION_GATE;
  blocked: boolean;
  conditions: DispositionGateCondition[];
  nonBlocking: DispositionGateAllowance[];
};

export type ReviewDispositionInput = {
  review: Review;
  findings: readonly ReviewFinding[];
  /** Raw verdicts on the gated task. Read ONLY to prove the two non-blocking rules and to
   *  refuse a run that combines authority models — never to derive a pass. */
  verdicts?: readonly VerdictRow[];
};

const SETTLED_DISPOSITIONS = new Set(["accepted_risk", "deferred", "rejected_premise", "duplicate"]);

function recordedLensOutcomes(review: Review): LensOutcome[] {
  return lensOutcomeRecordsOf(review) as LensOutcome[];
}

/** The selected lenses, or the reason there is no readable answer.
 *
 *  FAILING OPEN HERE WOULD BE THE WHOLE GATE. `assessDiscoveryCompleteness` iterates the
 *  selected lenses, so an empty list is trivially "complete" — an unreadable contract would
 *  mean no lens is owed an outcome, which is exactly backwards: the review whose contract
 *  cannot be parsed is the one whose discovery coverage is least established. It gets its own
 *  blocking condition instead, matching `selectRedsForContract`, which treats the same input
 *  as fail-closed-WIDER rather than as "nothing to review". */
function selectedLenses(review: Review): { ok: true; lenses: RiskLens[] } | { ok: false; refusal: string } {
  const validated = validateReviewContract(review.contract);
  return validated.ok ? { ok: true, lenses: [...validated.contract.risk_lenses] } : { ok: false, refusal: validated.refusal };
}

/** Is this finding's `rejected_premise` backed by candidate-bound disproving evidence?
 *
 *  `recordDisposition` stores the structured blob (kind + detail + candidateSha) and refuses
 *  to write the decision at all without it — so a row that fails this check either predates
 *  the ledger's structure or was written through some other path. The gate re-derives it
 *  rather than trusting that history, and binds it to the sha the review is on NOW: evidence
 *  that disproved a premise against a superseded candidate is not evidence about this one. */
function rejectedPremiseProven(f: ReviewFinding, candidateSha: string | undefined): boolean {
  if (f.dispositionEvidence === undefined || f.dispositionEvidence.trim() === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(f.dispositionEvidence);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const blob = parsed as { kind?: unknown; detail?: unknown; candidateSha?: unknown };
  if (typeof blob.kind !== "string" || typeof blob.detail !== "object" || blob.detail === null) return false;
  return typeof blob.candidateSha === "string" && blob.candidateSha === candidateSha;
}

/** The recorded reachability, defaulted to the STRICTEST arm. A finding whose reachability
 *  never made it onto the row cannot be closed by model re-inspection just because the field
 *  is missing — an absent reachability is treated as `demonstrated`. */
function reachabilityOf(f: ReviewFinding): Reachability {
  const r = f.reachability;
  return r === "supported" || r === "speculative" ? r : "demonstrated";
}

/** Did the shipping review record an acceptance mapping that HELD, at this candidate?
 *
 *  Stage 9 records its checks under the shipping stage record, at the sha it ran against
 *  (see runShippingReview). A shipping record at another sha is history: the candidate moved,
 *  so the acceptance mapping it carries is a claim about code that is no longer the one being
 *  gated. This is the ledger half of scenario #17 — a clean finding set does not substitute
 *  for evidence that the acceptance criteria were met. */
function acceptanceState(review: Review): { ok: boolean; detail: string } {
  const rec = review.stageEvidence?.shipping;
  const candidate = review.candidateSha;
  if (rec === undefined) {
    return {
      ok: false,
      detail:
        `no shipping review has run, so no acceptance criterion has been mapped to executed evidence — ` +
        `a ledger with no open findings is not evidence that the work was done`,
    };
  }
  if (candidate === undefined || rec.sha !== candidate) {
    return {
      ok: false,
      detail:
        `the shipping review's acceptance mapping was recorded at ${rec.sha}, not the current candidate ` +
        `${candidate ?? "(unset)"} — it is history, not evidence about this candidate`,
    };
  }
  const checks = rec.meta?.["checks"];
  if (!Array.isArray(checks)) {
    return { ok: false, detail: `the shipping review at ${rec.sha} recorded no per-check result to read` };
  }
  const failed = (checks as Array<{ id?: unknown; ok?: unknown; detail?: unknown }>).filter((c) => c.ok !== true);
  if (failed.length === 0) return { ok: true, detail: `every shipping check passed at ${rec.sha}` };
  return {
    ok: false,
    detail: `the shipping review reports ${failed
      .map((c) => `${String(c.id)}: ${String(c.detail ?? "no detail")}`)
      .join("; ")}`,
  };
}

/** Deterministic verification, from the ledger. A verification that RAN and failed is never
 *  recorded (runVerificationStage refuses before recording), so "absent or red" collapses to
 *  "no `verified_final` record at the current candidate" — which is also what a candidate
 *  that moved after verification looks like, correctly. */
function verificationState(review: Review): { ok: boolean; detail: string } {
  const candidate = review.candidateSha;
  const rec = review.stageEvidence?.verified_final;
  if (rec === undefined) {
    return { ok: false, detail: `deterministic verification has not run at the final candidate` };
  }
  if (candidate === undefined || rec.sha !== candidate) {
    return {
      ok: false,
      detail:
        `deterministic verification is recorded at ${rec.sha}, not the current candidate ` +
        `${candidate ?? "(unset)"} — the candidate moved after it ran`,
    };
  }
  return { ok: true, detail: `deterministic verification green at ${rec.sha}` };
}

/** FG-514, as a ledger read: EQUALITY with the fetched remote head, not ancestry. */
function tipTrustState(review: Review): { ok: boolean; detail: string } {
  const candidate = review.candidateSha;
  const trusted = review.trustedRemoteSha;
  if (trusted === undefined) {
    return {
      ok: false,
      detail: `no fetched remote head is recorded, so reviewed-tip trust is unestablished (fail closed)`,
    };
  }
  if (candidate === undefined || trusted !== candidate) {
    return {
      ok: false,
      detail: `the reviewed tip ${candidate ?? "(unset)"} is not equal to the fetched remote head ${trusted}`,
    };
  }
  return { ok: true, detail: `reviewed tip ${candidate} equals the fetched remote head` };
}

/** The whole gate, as a pure function of durable state. */
export function assessReviewDisposition(input: ReviewDispositionInput): ReviewDispositionAssessment {
  const { review, findings } = input;
  const conditions: DispositionGateCondition[] = [];
  const candidate = review.candidateSha;

  // 1 — every selected lens has a schema-valid, reviewer-authored outcome for the confirmed
  // candidate. Cleared only by retrying the lens, amending the contract through its approving
  // authority, or an authorized acceptance that names the missing evidence (`forge review
  // accept-lens`, operator authority, bound to this candidate) — never by dispositioning some
  // other finding.
  const lenses = selectedLenses(review);
  if (!lenses.ok) {
    conditions.push({
      id: "contract_unreadable",
      detail:
        `review ${review.id} carries no readable review contract, so which lenses discovery owed an outcome ` +
        `cannot be established: ${lenses.refusal}`,
    });
  } else {
    const completeness = assessDiscoveryCompleteness(lenses.lenses, recordedLensOutcomes(review), {
      acceptances: lensAcceptancesOf(review),
      // The CONFIRMED sha discovery was assessed at, which is what an acceptance stands in
      // for — the outcomes beside it are recorded against the confirmed candidate too. No
      // fallback to the moving candidate: `recordLensAcceptance` binds an acceptance to the
      // confirmed sha and nothing else, so reading a different sha here could only resurrect
      // an acceptance whose confirmation no longer stands.
      candidateSha: review.contractConfirmedSha,
    });
    if (!completeness.complete) {
      conditions.push({
        id: "lens_outcome_missing",
        detail:
          `${completeness.missing.length} selected lens(es) have no schema-valid reviewer-authored outcome: ` +
          completeness.missing.map((m) => `${m.lens} (${m.reason}: ${m.detail})`).join("; "),
      });
    }
  }

  const untriaged = findings.filter((f) => f.disposition === "untriaged");
  if (untriaged.length > 0) {
    conditions.push({
      id: "finding_untriaged",
      findings: untriaged.map((f) => f.findingRef),
      detail: `${untriaged.length} finding(s) are untriaged: ${untriaged.map((f) => f.findingRef).join(", ")}`,
    });
  }

  const questions = findings.filter((f) => f.disposition === "architecture_question");
  if (questions.length > 0) {
    conditions.push({
      id: "architecture_question_open",
      findings: questions.map((f) => f.findingRef),
      detail:
        `${questions.length} open architecture question(s) need the operator/architecture conversation: ` +
        questions.map((f) => f.findingRef).join(", "),
    });
  }

  const unproven = findings.filter(
    (f) => f.disposition === "rejected_premise" && !rejectedPremiseProven(f, candidate),
  );
  if (unproven.length > 0) {
    conditions.push({
      id: "rejected_premise_unproven",
      findings: unproven.map((f) => f.findingRef),
      detail:
        `${unproven.length} rejected_premise disposition(s) carry no candidate-bound disproving evidence at ` +
        `${candidate ?? "(unset)"}: ${unproven.map((f) => f.findingRef).join(", ")}`,
    });
  }

  const fixNow = findings.filter((f) => f.disposition === "fix_now");
  const unresolved = fixNow.filter((f) => f.resolution !== "resolved" || f.resolvedSha !== candidate);
  if (unresolved.length > 0) {
    conditions.push({
      id: "fix_now_unresolved",
      findings: unresolved.map((f) => f.findingRef),
      detail:
        `${unresolved.length} fix_now finding(s) have no 'resolved' recheck evidence at the current candidate ` +
        `${candidate ?? "(unset)"}: ` +
        unresolved
          .map((f) => `${f.findingRef} (${f.resolution ?? "no recheck result"}${f.resolvedSha !== undefined && f.resolvedSha !== candidate ? ` at ${f.resolvedSha}` : ""})`)
          .join(", "),
    });
  }

  // 6 — the resolution's evidence is PROPORTIONAL to the finding's original reachability.
  // A demonstrated finding closed by a bounded inspection is scenario #26: the disposition is
  // recorded and the recheck said `resolved`, and it still is not proof.
  const underEvidenced = fixNow.filter(
    (f) =>
      f.resolution === "resolved" &&
      f.resolvedSha === candidate &&
      !evidenceKindSufficientFor(reachabilityOf(f), f.resolutionEvidenceKind),
  );
  if (underEvidenced.length > 0) {
    conditions.push({
      id: "fix_now_evidence_insufficient",
      findings: underEvidenced.map((f) => f.findingRef),
      detail:
        `${underEvidenced.length} fix_now resolution(s) rest on evidence weaker than the finding's original ` +
        `reachability requires: ` +
        underEvidenced
          .map(
            (f) =>
              `${f.findingRef} (${reachabilityOf(f)} resolved by ${f.resolutionEvidenceKind ?? "no recorded evidence kind"}; ` +
              `requires ${sufficientEvidenceKinds(reachabilityOf(f)).join(" or ")})`,
          )
          .join(", "),
    });
  }

  const verification = verificationState(review);
  if (!verification.ok) {
    conditions.push({ id: "verification_absent_or_red", detail: verification.detail });
  }

  const acceptance = acceptanceState(review);
  if (!acceptance.ok) {
    conditions.push({ id: "acceptance_unmet", detail: acceptance.detail });
  }

  const tip = tipTrustState(review);
  if (!tip.ok) {
    conditions.push({ id: "tip_not_trusted", detail: tip.detail });
  }

  return {
    gateKind: REVIEW_DISPOSITION_GATE,
    blocked: conditions.length > 0,
    conditions,
    nonBlocking: allowances(input),
  };
}

/** The explicit non-blocking half. Each entry is a thing the LEGACY gate would have blocked
 *  on (or that a naive ledger reading would block on) and that this gate deliberately does
 *  not. */
function allowances(input: ReviewDispositionInput): DispositionGateAllowance[] {
  const out: DispositionGateAllowance[] = [];
  const verdicts = input.verdicts ?? [];
  const candidate = input.review.candidateSha;

  const advisoryFails = verdicts.filter((v) => v.verdict === "fail" && !verdictBlocksGate(v));
  if (advisoryFails.length > 0) {
    out.push({
      id: "advisory_red_fail_dispositioned",
      detail:
        `${advisoryFails.length} raw red fail(s) (${advisoryFails.map((v) => v.redRole).join(", ")}) are advisory ` +
        `under evidence_led; their findings are settled in the ledger, so the raw verdict does not block`,
    });
  }

  const settled = input.findings.filter((f) => SETTLED_DISPOSITIONS.has(f.disposition));
  if (settled.length > 0) {
    out.push({
      id: "settled_disposition",
      detail:
        `${settled.length} finding(s) are settled by disposition and do not block: ` +
        settled.map((f) => `${f.findingRef} (${f.disposition})`).join(", "),
    });
  }

  const superseded = input.findings.filter(
    (f) => f.decidedCandidateSha !== undefined && candidate !== undefined && f.decidedCandidateSha !== candidate,
  );
  if (superseded.length > 0) {
    out.push({
      id: "superseded_verdict",
      detail:
        `${superseded.length} disposition(s) were decided against a superseded sha and remain decisions about ` +
        `the finding, not claims about the current tree: ` +
        superseded.map((f) => `${f.findingRef} @ ${f.decidedCandidateSha}`).join(", "),
    });
  }

  return out;
}

/** The refusal an operator reads. Names the gate kind, every blocking condition, and the
 *  fact that `--force` is an override rather than the way this gate is meant to clear. */
export function renderDispositionRefusal(
  taskId: string,
  reviewId: string,
  assessment: ReviewDispositionAssessment,
): string {
  return (
    `Cannot advance ${taskId}: gate kind '${REVIEW_DISPOSITION_GATE}' (review ${reviewId}) is not settled. ` +
    `${assessment.conditions.length} blocking condition(s):\n` +
    assessment.conditions.map((c) => `  - ${c.id}: ${c.detail}`).join("\n") +
    `\nSettle the ledger — that is the path. \`forge review continue ${reviewId}\` drives the next stage; ` +
    `\`forge review show ${reviewId}\` names what is open. --force --rationale "..." remains the human ` +
    `override and is NOT the ordinary settlement path.`
  );
}

/** The one review a task's gate is decided against: the newest. A task with several reviews
 *  is not a shape the coordinator creates, but picking one silently would be the gate
 *  deciding which evidence counts, so the caller reports the count alongside. */
export function gatingReview<T extends { createdAt: string }>(reviews: readonly T[]): T | undefined {
  if (reviews.length === 0) return undefined;
  return [...reviews].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

export type EvidenceLedGateInput = {
  taskId: string;
  /** Reviews whose subject is THIS TASK. Preferred when present. */
  reviews: readonly Review[];
  /** Reviews that name the task's RUN without naming a task.
   *
   *  Required, not a nicety: `forge review start` binds a review to a ticket and a run, and
   *  there is no verb that binds one to a task after the fact. A gate that only looked at
   *  `subject_task_id` would report `review_absent` on every real run — the settled ledger is
   *  right there, on the run — and `--force` would be the only way past a gate whose whole
   *  purpose is to be settled rather than forced. */
  runReviews?: readonly Review[];
  findingsFor: (reviewId: string) => readonly ReviewFinding[];
  /** The task's raw verdicts. Read for the advisory-fail allowance and for the mixed-authority
   *  refusal — never to derive a pass. */
  verdicts: readonly VerdictRow[];
  /** The reds the gated STEP declares, as the workflow declares them. A step that still
   *  declares blocking reds on an evidence_led run is half-migrated whether or not any of them
   *  happened to fail. */
  declaredReds?: readonly { agent: string; authority: string; gate_on_verdict: boolean }[];
  /** The run row's recorded mode, when it disagrees with the workflow's declared one. */
  modeDrift?: ReviewModeDrift;
};

export type EvidenceLedGateResult = {
  review?: Review;
  assessment: ReviewDispositionAssessment;
};

/** The gate as the runner asks for it: from the task, not from a review the caller found.
 *
 *  Two conditions live here rather than in `assessReviewDisposition` because neither is a
 *  fact about a review — they are facts about the RUN's authority model:
 *
 *    review_absent        — an evidence-led step whose reviewed work has no ledger at all.
 *                           Fail closed: the mode moved authority to a ledger, so no ledger
 *                           is no authority, not a free pass.
 *    mixed_authority_model — a verdict on this task still claims blocking authority while the
 *                           run is evidence_led. That is the migration-safety bullet ("never
 *                           combine gate authority from two review modes in one run") as a
 *                           refusal instead of a silently-ignored row: one of the two is a
 *                           workflow that was only half migrated, and quietly dropping the
 *                           authoritative fail is the failure mode worth refusing over. */
export function assessEvidenceLedGate(input: EvidenceLedGateInput): EvidenceLedGateResult {
  // Task-scoped first, then the run's. A review that names the task is the more specific
  // answer; a review that names the run is this run's ledger and is what `forge review start`
  // actually produces.
  const review = gatingReview(input.reviews) ?? gatingReview(input.runReviews ?? []);
  const migration = migrationConditions(input);

  if (review === undefined) {
    return {
      assessment: {
        gateKind: REVIEW_DISPOSITION_GATE,
        blocked: true,
        conditions: [
          {
            id: "review_absent",
            detail:
              `no review ledger exists for ${input.taskId} or its run, and under review_mode 'evidence_led' the ` +
              `ledger IS the gate authority — an absent ledger is unestablished evidence, not a clean one. Open ` +
              `one with \`forge review start <ticket-id> --run <run-id>\`.`,
          },
          ...migration,
        ],
        nonBlocking: [],
      },
    };
  }

  const assessment = assessReviewDisposition({
    review,
    findings: input.findingsFor(review.id),
    verdicts: input.verdicts,
  });
  if (migration.length > 0) {
    assessment.conditions.push(...migration);
    assessment.blocked = true;
  }
  return { review, assessment };
}

export type ReviewModeDrift = { runMode: string; workflowMode: string };

/** The run row and its workflow disagree about which authority model settles this run.
 *
 *  ONE text for BOTH directions, and that symmetry is the point. A run stamped legacy under a
 *  workflow that has since migrated, and a run stamped evidence_led under a workflow that was
 *  reverted, are the same defect seen from opposite sides: a step would be settled under a
 *  model its reds were never dispatched with. Neither direction gets to pick a model. */
export function reviewModeDriftCondition(drift: ReviewModeDrift): DispositionGateCondition {
  return {
    id: "review_mode_drift",
    detail:
      `the run row records review_mode '${drift.runMode}' while its workflow declares ` +
      `'${drift.workflowMode}' — a run's authority model is fixed at creation, so this run was moved ` +
      `under it (a mid-run seed change, or a review adopting the run). Refusing rather than picking one: ` +
      `settling a step under a model its reds were never dispatched with is exactly the combination that ` +
      `"one review_mode per run" exists to prevent.`,
  };
}

/** Drift as a standalone assessment, for the gate's PRE-BRANCH check.
 *
 *  It is assessed before the gate decides WHICH model to judge under, because that decision is
 *  precisely what drift makes unanswerable — reading either side would be the silent fallback
 *  the condition exists to refuse. Nothing else is assessed alongside it: under drift, the
 *  other conditions would be read out of a ledger whose authority model is in dispute. */
export function assessReviewModeDrift(drift: ReviewModeDrift): ReviewDispositionAssessment {
  return {
    gateKind: REVIEW_DISPOSITION_GATE,
    blocked: true,
    conditions: [reviewModeDriftCondition(drift)],
    nonBlocking: [],
  };
}

/** The two conditions that are facts about the RUN's authority model rather than about any
 *  review: a run that has been moved between models, and a run that carries both at once. */
function migrationConditions(input: EvidenceLedGateInput): DispositionGateCondition[] {
  const out: DispositionGateCondition[] = [];

  if (input.modeDrift !== undefined) out.push(reviewModeDriftCondition(input.modeDrift));

  // DECLARATION, not just outcome. Keying only on a failing verdict would let a half-migrated
  // step pass unnoticed for as long as its authoritative reds happen to agree — the run would
  // read settled while carrying two authority models, and only a red day would reveal it.
  const halfMigrated = (input.declaredReds ?? []).filter(
    (r) => r.authority === "authoritative" && r.gate_on_verdict !== false,
  );
  const blockingVerdicts = input.verdicts.filter(verdictBlocksGate);
  if (halfMigrated.length === 0 && blockingVerdicts.length === 0) return out;

  const parts: string[] = [];
  if (halfMigrated.length > 0) {
    parts.push(
      `the step still DECLARES blocking red(s) (${halfMigrated.map((r) => r.agent).join(", ")}: ` +
        `authority: authoritative / gate_on_verdict: true)`,
    );
  }
  if (blockingVerdicts.length > 0) {
    parts.push(
      `${blockingVerdicts.length} verdict(s) still claim blocking authority ` +
        `(${blockingVerdicts.map((v) => `${v.redRole}: ${v.authority}/gate_on_verdict=${v.gateOnVerdict !== false}`).join(", ")})`,
    );
  }
  out.push({
    id: "mixed_authority_model",
    detail:
      `${parts.join("; ")} while the run is evidence_led — exactly one review_mode settles a run, and two ` +
      `authority models must never be combined. Migrate the step's reds to authority: specialist / ` +
      `gate_on_verdict: false, or run the workflow under a legacy review_mode.`,
  });
  return out;
}

/** WHICH STEP'S APPROVAL CAN CARRY THE CONTRACT — read off the workflow's DECLARATION, never
 *  off which task happens to have written a `review_contract`.
 *
 *  A contract selects the discovery panel, so "whoever wrote one" would let any other
 *  human-gated step in the run — an architect before the plan, a docs step after it — narrow
 *  the build panel by putting two lens names in its result, with a real human `advance` behind
 *  it. The reviewed step's own declared upstream is what pins it: the step(s) it says it is
 *  built FROM (`depends_on`, plus a fanout's `from_upstream.step`) that are gated by a human.
 *  In `feature` that is exactly `plan`, and `architect` — human-gated, but not build's declared
 *  upstream — is not in the set.
 *
 *  Structural, not transitive: an ancestor two hops up is not the step this one was planned by. */
export function contractApprovingSteps(workflow: Workflow, reviewedStepId: string): string[] {
  const step = workflow.steps.find((s) => s.id === reviewedStepId);
  if (step === undefined) return [];
  const declared = new Set<string>(step.depends_on);
  if (step.fanout !== undefined) declared.add(step.fanout.from_upstream.step);
  return workflow.steps.filter((s) => declared.has(s.id) && s.gate === "human").map((s) => s.id);
}

/** THE PLAN-GATE-APPROVED CONTRACT, and every word of that is load-bearing.
 *
 *  Two things make a contract authoritative, and neither one alone is enough. The HUMAN GATE
 *  that advanced the step carrying it — the same act that approves the plan approves the risk
 *  surface it declares; a contract in the result of a task nobody advanced is a proposal, and
 *  this returns undefined for it. And the STEP it came from being the reviewed step's declared
 *  plan step (`contractApprovingSteps`) — an advanced task elsewhere in the run is not the plan
 *  this panel is selected by, however valid its contract parses.
 *
 *  A contract on any other advanced task is IGNORED with `review.contract_ignored` rather than
 *  dropped silently: a panel that stayed wide because a contract was refused should be
 *  readable as that, not as a contract nobody wrote.
 *
 *  Newest wins, so a re-planned step's re-approved contract supersedes the first. */
export function approvedReviewContract(
  runId: string,
  workflow: Workflow,
  reviewedStepId: string,
): { contract: unknown; taskId: string } | undefined {
  const approving = new Set(contractApprovingSteps(workflow, reviewedStepId));
  const approved = tasksForRun(runId)
    .filter((t) => gatesForTask(t.id).some((g) => g.decision === "advance"))
    .map((t) => ({
      taskId: t.id,
      phase: t.phase,
      contract: (t.result as { review_contract?: unknown } | undefined)?.review_contract,
    }))
    .filter((c) => c.contract !== undefined);

  for (const foreign of approved.filter((c) => !approving.has(c.phase))) {
    logEvent("review.contract_ignored", {
      runId,
      taskId: foreign.taskId,
      payload: {
        step: foreign.phase,
        reviewedStep: reviewedStepId,
        approvingSteps: [...approving],
        reason:
          `task ${foreign.taskId} (step '${foreign.phase}') carries a review_contract, but ${reviewedStepId}'s ` +
          `panel is selected only by the contract its declared plan step ` +
          `(${approving.size > 0 ? [...approving].join(", ") : "none"}) had approved at a human gate. Ignored.`,
      },
    });
  }

  const fromPlan = approved.filter((c) => approving.has(c.phase));
  const last = fromPlan[fromPlan.length - 1];
  return last ? { contract: last.contract, taskId: last.taskId } : undefined;
}
