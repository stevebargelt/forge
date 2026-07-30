// FG-639 (evidence-led review, Change 2): the staged review coordinator.
//
// ONE VALID NEXT TRANSITION, DERIVED FROM DURABLE STATE. `nextTransition` is a pure
// function of the persisted review, its findings, and its fix batches. Nothing about
// where a review goes next lives in a variable held by the process that started it —
// which is what makes `forge review continue` after an orchestrator crash resume the
// persisted next stage instead of re-running whatever the last process happened to be
// doing. Discovery in particular is NEVER re-entered once a completed discovery record
// exists for the confirmed sha: re-sampling a repository because a process died is how a
// review acquires findings that have nothing to do with the crash.
//
// STAGE COMPLETION IS PER SHA. Every stage record carries the sha it completed against
// (see StageEvidence in src/store/reviews.ts). So the docs phase moving the candidate
// automatically re-opens final verification and recheck, and an out-of-band candidate
// change automatically invalidates candidate-bound resolution and shipping evidence —
// without a single reset flag anyone has to remember to clear.
//
// AND STAGE 1 IS A STOP, NOT A FINDING. A non-runnable candidate stops
// `blocked_environment`: no reviewer, no fixer, no cycle consumed. A verification that
// RUNS and fails stops deterministically and is never converted into a red finding — a
// failing test is not a reviewer's opinion, and laundering it into the ledger would put a
// deterministic fact through a disposition gate that exists for judgement calls.

import type { FixBatch } from "../store/fix-batches.js";
import type { Review, ReviewFinding, ReviewStage, ReviewState } from "../store/reviews.js";
import { stageCompleteAt } from "../store/reviews.js";
import { assessDiscoveryCompleteness, type LensOutcome } from "./review-discovery.js";
import { recheckIsNoOp } from "./review-recheck.js";
import { validateReviewContract, type RiskLens } from "./review-contract.js";

export type TransitionKind =
  | "verify_entry"
  | "confirm_contract"
  | "discover"
  | "await_disposition"
  | "batch_fix"
  | "docs"
  | "verify_final"
  | "recheck"
  | "shipping_review"
  | "settled"
  // There is deliberately no `blocked_environment` KIND. It is a review STATE, reached by
  // Stage 1 stopping, and the next transition out of it is Stage 1 again — see the comment
  // in resolveTransition. A kind would imply a transition that leads nowhere.
  | "failed";

export type Transition = {
  kind: TransitionKind;
  /** The review state this transition runs in. Recorded so the caller moves the row and
   *  the machine agree by construction rather than by two switch statements. */
  state: ReviewState;
  /** Which stage this transition would complete. Absent for terminal/stop kinds. */
  stage?: ReviewStage;
  reason: string;
  /** For await_disposition: exactly which findings are holding the review. */
  blockingFindings?: string[];
  /** Open architecture questions. Reported on EVERY transition, because they do not stop
   *  the mechanical remainder of the cycle but they DO stop it settling — an operator who
   *  only saw them at the shipping review would learn about them last. */
  awaitingAuthority?: string[];
  /** For discover: the lenses with no reviewer-authored outcome yet. */
  pendingLenses?: RiskLens[];
};

export type ReviewSnapshot = {
  review: Review;
  findings: readonly ReviewFinding[];
  batches: readonly FixBatch[];
};

function fixNowFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.disposition === "fix_now");
}

function selectedLenses(review: Review): RiskLens[] {
  const validated = validateReviewContract(review.contract);
  return validated.ok ? [...validated.contract.risk_lenses] : [];
}

function recordedLensOutcomes(review: Review): LensOutcome[] {
  return Array.isArray(review.lensOutcomes) ? (review.lensOutcomes as LensOutcome[]) : [];
}

/** Has an INGESTED batch already carried this finding, under the decision it carries now?
 *
 *  Per finding rather than per set, and that is the load-bearing choice. Scenario #5 removes
 *  a finding from the fix_now set mid-cycle (the fixer reports it scope-changing, so it
 *  becomes an architecture question): the remaining four were still fixed, and a whole-set
 *  comparison would read the shrunken set as "never fixed" and dispatch a second fixer over
 *  work already done. Containment says the right thing in both directions — a finding ADDED
 *  to fix_now, or RE-DECIDED (a new decidedAt or a new rationale), is not covered and does
 *  get a new batch revision. */
function decisionCoveredByIngestedBatch(batches: readonly FixBatch[], f: ReviewFinding): boolean {
  return batches.some(
    (b) =>
      b.state === "ingested" &&
      b.payload.findings.some(
        (m) =>
          m.finding_id === f.id &&
          m.decided_at === (f.decidedAt ?? undefined) &&
          m.disposition_rationale === (f.dispositionRationale ?? ""),
      ),
  );
}

/** Stage 5 is satisfied when every CURRENT fix_now finding was carried by an ingested batch
 *  under its current decision. The fix stage's own record cannot be checked with
 *  `stageCompleteAt` — the fixer's commits move the candidate, so its sha is deliberately
 *  the PRE-fix one. */
function fixStageSatisfied(snapshot: ReviewSnapshot): boolean {
  return fixNowFindings(snapshot.findings).every((f) => decisionCoveredByIngestedBatch(snapshot.batches, f));
}

/** Findings that hold the review at Stage 4.
 *
 *  TWO shapes, and the second is scenario #6: a `fix_now` whose recheck came back
 *  `still_present` or `inconclusive` AND whose decision the fixer already consumed. The
 *  review returns to disposition and no fixer is dispatched automatically — re-running the
 *  fixer on a decision that demonstrably did not resolve it is exactly the loop this
 *  lifecycle replaced. A NEW decision (a new rationale) changes the decision fingerprint
 *  and lets the fix stage run again.
 *
 *  AN ARCHITECTURE QUESTION IS DELIBERATELY NOT ONE OF THESE. It leaves the review
 *  UNSETTLED — Stage 9's findings_settled check refuses it, and `awaitingAuthority` reports
 *  it on every transition — but it does not stop the mechanical remainder of the cycle.
 *  Scenario #5 is why: when a fixer resolves four findings and reports the fifth as
 *  scope-changing, the FOUR proceed to recheck and the fifth goes to the operator. Blocking
 *  the whole cycle on the fifth would throw away the evidence the other four are entitled
 *  to, and would do it while the review still could not settle either way. */
function dispositionBlockers(snapshot: ReviewSnapshot): ReviewFinding[] {
  const { findings, batches } = snapshot;
  const out: ReviewFinding[] = [];
  for (const f of findings) {
    if (f.disposition === "untriaged") {
      out.push(f);
      continue;
    }
    if (f.disposition !== "fix_now") continue;
    if (f.resolution !== "still_present" && f.resolution !== "inconclusive") continue;
    if (decisionCoveredByIngestedBatch(batches, f)) out.push(f);
  }
  return out;
}

function openArchitectureQuestions(findings: readonly ReviewFinding[]): string[] {
  return findings.filter((f) => f.disposition === "architecture_question").map((f) => f.findingRef);
}

/** The ONE valid next transition. */
export function nextTransition(snapshot: ReviewSnapshot): Transition {
  return { ...resolveTransition(snapshot), ...withAuthority(snapshot) };
}

function withAuthority(snapshot: ReviewSnapshot): { awaitingAuthority?: string[] } {
  const open = openArchitectureQuestions(snapshot.findings);
  return open.length > 0 ? { awaitingAuthority: open } : {};
}

function resolveTransition(snapshot: ReviewSnapshot): Transition {
  const { review, findings } = snapshot;

  if (review.state === "settled") {
    return { kind: "settled", state: "settled", reason: "the review is settled" };
  }
  if (review.state === "failed") {
    return { kind: "failed", state: "failed", reason: "the review failed and was not resumed" };
  }
  // `blocked_environment` is deliberately NOT short-circuited. It is a stop, not a
  // gravestone: no reviewer ran, no fixer ran, and no review cycle was consumed, so once
  // the environment can execute the required verification the SAME review continues from
  // Stage 1. Falling through to the stage checks below is what makes that true without a
  // second entry point — and if the environment is still broken, Stage 1 stops again and
  // still dispatches nothing. (The row keeps saying blocked_environment until it clears, so
  // `forge review show` reports the stop even between attempts.)
  //
  // A deterministic verification FAILURE resumes the same way and for the same reason: the
  // work is to fix the code, and re-entering Stage 1 afterwards is the whole remedy. Only a
  // review someone explicitly marks `failed` stays terminal here.

  const candidate = review.candidateSha;

  // WHICH STAGES ARE ANCHORED TO WHAT. Three of the nine anchor to a FROZEN sha and the
  // rest to the moving candidate, and getting this wrong is how a coordinator re-runs
  // discovery every time the fixer commits:
  //
  //   verified_entry     — the ENTRY gate. It ran once, on the candidate the review opened
  //                        on. Remediation moving the candidate does not un-verify the
  //                        entry; the candidate that exists now is Stage 7's job.
  //   contract_confirmed — anchored to contract_confirmed_sha, which is frozen at
  //                        confirmation and never advanced.
  //   discovery          — anchored to that same frozen sha, which is exactly why a fixer
  //                        or docs commit can never re-open it (PRD #15).
  //
  //   docs / verified_final / recheck / shipping — anchored to the CURRENT candidate, so a
  //                        commit from any stage re-opens the ones after it, and an
  //                        out-of-band candidate change returns to deterministic
  //                        verification without any flag anyone has to reset.

  // Stage 1 — deterministic verification entry.
  if (review.stageEvidence?.verified_entry === undefined) {
    return {
      kind: "verify_entry",
      state: "verifying",
      stage: "verified_entry",
      reason: `deterministic verification has not run at candidate ${candidate ?? "(unset)"}`,
    };
  }

  // Stage 2a — contract confirmation against the final implementation diff.
  if (
    review.contractConfirmedSha === undefined ||
    !stageCompleteAt(review, "contract_confirmed", review.contractConfirmedSha)
  ) {
    return {
      kind: "confirm_contract",
      state: "confirming_contract",
      stage: "contract_confirmed",
      reason: `the review contract is not confirmed against candidate ${candidate ?? "(unset)"}`,
    };
  }

  // Stage 2b/3 — discovery. NEVER re-entered once complete for the confirmed sha.
  const lenses = selectedLenses(review);
  const completeness = assessDiscoveryCompleteness(lenses, recordedLensOutcomes(review));
  const discoveryRecorded = stageCompleteAt(review, "discovery", review.contractConfirmedSha);
  if (!discoveryRecorded || !completeness.complete) {
    return {
      kind: "discover",
      state: "discovering",
      stage: "discovery",
      pendingLenses: completeness.missing.map((m) => m.lens),
      reason: !completeness.complete
        ? `discovery is incomplete: ${completeness.missing.map((m) => `${m.lens} (${m.reason})`).join(", ")}`
        : `discovery has no completed record for the confirmed sha ${review.contractConfirmedSha}`,
    };
  }

  // Stage 4 — disposition stop.
  const blockers = dispositionBlockers(snapshot);
  if (blockers.length > 0) {
    return {
      kind: "await_disposition",
      state: "awaiting_disposition",
      blockingFindings: blockers.map((f) => f.findingRef),
      reason:
        `${blockers.length} finding(s) need a disposition decision: ` +
        blockers.map((f) => `${f.findingRef} (${f.disposition}${f.resolution !== undefined ? `/${f.resolution}` : ""})`).join(", "),
    };
  }

  // Stage 5 — one batch fix.
  const fixNow = fixNowFindings(findings);
  if (!fixStageSatisfied(snapshot)) {
    return {
      kind: "batch_fix",
      state: "fixing",
      stage: "fix",
      reason: `${fixNow.length} fix_now finding(s) go to ONE fixer in one batch`,
      blockingFindings: fixNow.map((f) => f.findingRef),
    };
  }

  // Stage 6 — docs reconciliation, BEFORE final verification. Guaranteed: it runs whether
  // or not the fixer changed anything, because it may itself change the candidate and
  // recheck evidence must not bind to a pre-docs sha.
  if (!stageCompleteAt(review, "docs", candidate)) {
    return {
      kind: "docs",
      state: "documenting",
      stage: "docs",
      reason: `docs reconciliation has not run at candidate ${candidate ?? "(unset)"}`,
    };
  }

  // Stage 7 — final deterministic verification at the final candidate.
  if (!stageCompleteAt(review, "verified_final", candidate)) {
    return {
      kind: "verify_final",
      state: "verifying",
      stage: "verified_final",
      reason: `final deterministic verification has not run at candidate ${candidate ?? "(unset)"}`,
    };
  }

  // Stage 8 — exact recheck + bounded remediation-delta review.
  if (!stageCompleteAt(review, "recheck", candidate)) {
    const noop = recheckIsNoOp({
      fixNowCount: fixNow.length,
      contractConfirmedSha: review.contractConfirmedSha,
      candidateSha: candidate,
    });
    return {
      kind: "recheck",
      state: "rechecking",
      stage: "recheck",
      reason: noop
        ? `no fix_now findings and the candidate never moved from ${review.contractConfirmedSha} — recheck is a no-op`
        : `${fixNow.length} known finding id(s) to recheck exactly, plus bounded review of the delta to ${candidate ?? "(unset)"}`,
    };
  }

  // Stage 9 — shipping review.
  if (!stageCompleteAt(review, "shipping", candidate)) {
    return {
      kind: "shipping_review",
      state: "shipping_review",
      stage: "shipping",
      reason: `the shipping review's seven checks have not run at candidate ${candidate ?? "(unset)"}`,
    };
  }

  return { kind: "settled", state: "settled", reason: "every stage is complete at the current candidate" };
}

// ─── stage-1 / stage-7 verification entry ───────────────────────────────────

/** What the caller's verification wiring reports. Deliberately the SAME shape the
 *  existing covering-evidence + host-readiness machinery already produces (see
 *  `verifyWithReuse` and `prepareHostVerification`) — this lifecycle reuses that
 *  machinery rather than reimplementing a second verification model. */
export type VerificationEntry = {
  ok: boolean;
  /** Set when the ENVIRONMENT could not be made runnable — the host-readiness refusal.
   *  Read BEFORE `ok`, exactly as review-loop does. */
  environmentRefusal?: { reason: string; message: string };
  /** Every required check executed rather than skipped. */
  executedRequiredChecks?: boolean;
  sha: string;
  detail: string;
};

export type VerificationVerdict =
  | { kind: "green"; sha: string; detail: string }
  | { kind: "blocked_environment"; reason: string; message: string }
  | { kind: "failed"; sha: string; detail: string };

/** Classify a verification entry into the three outcomes Stage 1 and Stage 7 distinguish.
 *
 *  The order is the whole content of the function: an environment refusal is checked
 *  BEFORE `ok`, because a refusal that also carries the failed steps of a dependency-less
 *  local run must stop as `blocked_environment` — not as a verification failure, and
 *  certainly not as a reviewer finding. */
export function classifyVerification(entry: VerificationEntry): VerificationVerdict {
  if (entry.environmentRefusal !== undefined) {
    return {
      kind: "blocked_environment",
      reason: entry.environmentRefusal.reason,
      message: entry.environmentRefusal.message,
    };
  }
  if (!entry.ok) {
    return { kind: "failed", sha: entry.sha, detail: entry.detail };
  }
  if (entry.executedRequiredChecks === false) {
    return {
      kind: "failed",
      sha: entry.sha,
      detail:
        `required coverage was not executed — recorded not_executed, which is never green: ${entry.detail}`,
    };
  }
  return { kind: "green", sha: entry.sha, detail: entry.detail };
}
