// FG-639 (evidence-led review, Change 2): executing ONE transition.
//
// `nextTransition` (review-coordinator.ts) decides WHAT is next from durable state; this
// module DOES it and writes the result down. Every side effect goes through `deps`, which
// is the same seam pattern review-loop and runNext already use: the container dispatches,
// git reads, and verification runs are injected, so the stage sequencing is testable
// without a docker daemon and the wiring is the only part that needs a live host.
//
// Two invariants this module is responsible for and the store cannot enforce alone:
//
//   - THE CANDIDATE MOVES, AND MOVING IT INVALIDATES CANDIDATE-BOUND EVIDENCE. A fixer or
//     a docs phase commits, the head changes, and every resolution proven at the old sha
//     stops being evidence about the new one. `advanceCandidate` is the single place that
//     happens, so no stage can move the candidate and forget.
//
//   - A STAGE RECORDS ITSELF ONLY ON SUCCESS. A refused ingestion, a crashed lens, a
//     failed verification — none of them write a stage record, so `continue` re-enters
//     that same stage rather than stepping over it. That is what makes "never repeat a
//     completed stage" safe: only completion is recorded, so re-entry after a crash is
//     re-entry into the stage that did not finish.

import {
  findingsForReview,
  getReview,
  ingestFindings,
  invalidateResolutionsForCandidate,
  invalidateResolutionsForFixCycle,
  recordDisposition,
  recordResolution,
  recordStageEvidence,
  setReviewState,
  updateReview,
  type Review,
  type ReviewFinding,
} from "../store/reviews.js";
import {
  ensureFixBatch,
  ingestFixBatchResults,
  markFixBatchDispatched,
  serializeFixBatchPayload,
  verifyMaterializedPayload,
  fixBatchesForReview,
  fixBatchResults,
  type FixBatch,
} from "../store/fix-batches.js";
import {
  classifyVerification,
  fixCycleKey,
  nextTransition,
  type Transition,
  type VerificationEntry,
} from "./review-coordinator.js";
import {
  assessDiscoveryCompleteness,
  assessLens,
  collectObservations,
  normalizeObservations,
  type LensDispatch,
  type LensOutcome,
} from "./review-discovery.js";
import {
  confirmContract,
  lensRole,
  validateReviewContract,
  type ContractProposal,
  type RiskLens,
} from "./review-contract.js";
import { parseFixerResult } from "./review-fixer.js";
import { ingestRecheck } from "./review-recheck.js";
import { assessShippingReview, type ShippingAssessment, type ShippingInput } from "./review-shipping.js";

type Awaitable<T> = T | Promise<T>;

export type LensContext = {
  review: Review;
  lens: RiskLens;
  role: string;
  candidateSha: string;
  contract: unknown;
};

// No envelope field: the envelope is rendered from the batch ROW at materialization and
// re-derived from the row to verify the delivered bytes (renderFixBatchEnvelope). Carrying a
// pre-rendered copy here would be a second envelope truth for a caller to deliver instead.
export type FixerContext = {
  review: Review;
  batch: FixBatch;
  payload: string;
};

export type RecheckContextIn = {
  review: Review;
  candidateSha: string;
  confirmedSha: string;
  expected: readonly ReviewFinding[];
  /** The fixer's per-finding evidence, keyed by finding id — the rechecker VERIFIES it. */
  fixerEvidence: Record<string, string>;
  delta: string;
  contract: unknown;
  lensInstructions: Record<string, string>;
};

export type CoordinatorDeps = {
  headSha: () => Awaitable<string>;
  verify: (sha: string) => Awaitable<VerificationEntry>;
  changedPaths: (fromSha: string, toSha: string) => Awaitable<string[]>;
  diff: (fromSha: string, toSha: string) => Awaitable<string>;
  /** The contract confirmation proposal. The default wiring confirms unchanged; a
   *  coordinator that observed drift supplies a widening claim or names the drift. */
  proposeContract: (ctx: { review: Review; candidateSha: string; changedPaths: string[] }) => Awaitable<ContractProposal>;
  dispatchLens: (ctx: LensContext) => Awaitable<LensDispatch>;
  materializeFixBatch: (ctx: FixerContext) => Awaitable<string>;
  /** LOAD-BEARING CONTRACT on taskId: the empty string means "refused BEFORE any container
   *  started". Stage 5 marks the batch dispatched only for a non-empty taskId, so an empty
   *  one leaves the batch OPEN at this revision — the same revision and payload hash are
   *  re-entered on retry, rather than a delivery that never happened being recorded against
   *  a task id that does not exist. Any implementation that reaches a container MUST return
   *  the real task id, including when that container then fails (ok: false, taskId set): a
   *  fixer that ran and crashed is a dispatch, and its task is the audit trail. */
  dispatchFixer: (ctx: FixerContext) => Awaitable<{ ok: boolean; taskId: string; result?: unknown; error?: string }>;
  dispatchDocs: (ctx: { review: Review; candidateSha: string }) => Awaitable<{ ok: boolean; error?: string }>;
  dispatchRechecker: (ctx: RecheckContextIn) => Awaitable<{ ok: boolean; taskId?: string; result?: unknown; error?: string }>;
  shippingInput: (ctx: {
    review: Review;
    candidateSha: string;
  }) => Awaitable<Omit<ShippingInput, "candidateSha" | "findings">>;
};

export type StageOutcome = {
  transition: Transition;
  /** advanced — the stage completed and was recorded.
   *  stopped   — a deliberate lifecycle stop (disposition, blocked environment, settled).
   *  refused   — the stage did not complete; it will be re-entered, nothing was recorded. */
  status: "advanced" | "stopped" | "refused";
  message: string;
  /** Set by the shipping-review stage so the caller can render the seven checks. */
  shipping?: ShippingAssessment;
};

function snapshot(reviewId: string) {
  const review = getReview(reviewId);
  if (!review) throw new Error(`forge: no review ${reviewId}`);
  return { review, findings: findingsForReview(reviewId), batches: fixBatchesForReview(reviewId) };
}

/** The ONE place the candidate moves. Invalidates every resolution bound to the sha the
 *  review is leaving, so nothing downstream can read a stale proof as current. */
function advanceCandidate(reviewId: string, toSha: string): Review {
  const before = getReview(reviewId);
  if (before?.candidateSha === toSha) return before;
  invalidateResolutionsForCandidate(reviewId, toSha);
  return updateReview(reviewId, { candidateSha: toSha });
}

export async function runNextStage(reviewId: string, deps: CoordinatorDeps): Promise<StageOutcome> {
  const snap = snapshot(reviewId);
  const transition = nextTransition(snap);

  switch (transition.kind) {
    case "settled":
    case "failed":
      if (transition.kind === "settled" && snap.review.state !== "settled") {
        setReviewState(reviewId, "settled", { reason: transition.reason });
      }
      return { transition, status: "stopped", message: transition.reason };

    case "await_disposition":
      if (snap.review.state !== "awaiting_disposition") {
        setReviewState(reviewId, "awaiting_disposition", { reason: transition.reason });
      }
      return { transition, status: "stopped", message: transition.reason };

    case "verify_entry":
    case "verify_final":
      return runVerificationStage(reviewId, transition, deps);

    case "confirm_contract":
      return runContractConfirmation(reviewId, transition, deps);

    case "discover":
      return runDiscovery(reviewId, transition, deps);

    case "batch_fix":
      return runBatchFix(reviewId, transition, deps);

    case "docs":
      return runDocs(reviewId, transition, deps);

    case "recheck":
      return runRecheck(reviewId, transition, deps);

    case "shipping_review":
      return runShippingReview(reviewId, transition, deps);
  }
}

// ─── stage 1 / stage 7 ──────────────────────────────────────────────────────

async function runVerificationStage(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const review = getReview(reviewId) as Review;
  const candidate = review.candidateSha ?? (await deps.headSha());
  if (review.candidateSha === undefined) updateReview(reviewId, { candidateSha: candidate });
  setReviewState(reviewId, "verifying", { reason: transition.reason });

  const verdict = classifyVerification(await deps.verify(candidate));

  if (verdict.kind === "blocked_environment") {
    // No reviewer, no fixer, NO review cycle consumed. The stop is the whole outcome.
    setReviewState(reviewId, "blocked_environment", { reason: `${verdict.reason}: ${verdict.message}` });
    return {
      transition,
      status: "stopped",
      message:
        `blocked_environment (${verdict.reason}): ${verdict.message}. No reviewer or fixer was dispatched and ` +
        `no review cycle was consumed.`,
    };
  }

  if (verdict.kind === "failed") {
    // A deterministic failure is NOT a red finding. Nothing is ingested; the lifecycle stops
    // on the failure itself, so the code — not a reviewer's opinion — is what has to move.
    //
    // The review stays in `verifying` rather than being marked `failed`. Marking it failed
    // would be a gravestone for something that is ordinarily fixed in a minute: the next
    // `forge review continue` after the code is fixed must re-enter THIS stage, and a
    // terminal state would force a second review over the same candidate and lose the
    // dispositions this one already carries.
    setReviewState(reviewId, "verifying", {
      reason: `deterministic verification failed at ${verdict.sha}: ${verdict.detail}`,
    });
    return {
      transition,
      status: "refused",
      message:
        `deterministic verification failed at ${verdict.sha}: ${verdict.detail}. ` +
        `It is a deterministic outcome, not a review finding — nothing was ingested into the ledger.`,
    };
  }

  recordStageEvidence(reviewId, transition.stage as "verified_entry" | "verified_final", {
    sha: verdict.sha,
    detail: verdict.detail,
  });
  return { transition, status: "advanced", message: `deterministic verification green at ${verdict.sha}` };
}

// ─── stage 2a ───────────────────────────────────────────────────────────────

async function runContractConfirmation(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const review = getReview(reviewId) as Review;
  setReviewState(reviewId, "confirming_contract", { reason: transition.reason });

  const approved = validateReviewContract(review.contract);
  if (!approved.ok) {
    return { transition, status: "refused", message: approved.refusal };
  }
  const candidate = review.candidateSha as string;
  // NO BASE, NO CONFIRMATION. Defaulting the changed paths to [] here is not a neutral
  // fallback: it hands the fail-closed guard an empty diff, so the unevaluated-diff refusal
  // cannot fire and every candidate auto-confirms over a diff nobody computed, let alone
  // evaluated. A review that cannot name its base cannot confirm a contract against the
  // final implementation diff, so the missing base is itself the refusal.
  if (review.baseSha === undefined) {
    return {
      transition,
      status: "refused",
      message:
        `this review records no base sha, so the final implementation diff cannot be computed and the contract ` +
        `confirmation has nothing to evaluate. A review that cannot name its base cannot confirm a contract — ` +
        `an empty diff here would auto-confirm the approved contract over a change nobody looked at. Re-open the ` +
        `review naming its comparison base (forge review start --since <sha>). Nothing was written.`,
    };
  }
  const paths = await deps.changedPaths(review.baseSha, candidate);
  const proposal = await deps.proposeContract({ review, candidateSha: candidate, changedPaths: paths });
  const confirmation = confirmContract(approved.contract, { ...proposal, candidateSha: candidate, changedPaths: paths });

  if (confirmation.kind !== "confirmed") {
    return { transition, status: "refused", message: confirmation.refusal };
  }

  const noDrift = confirmation.noDrift;
  updateReview(reviewId, {
    contract: confirmation.contract,
    contractConfirmedSha: confirmation.confirmedSha,
  });
  recordStageEvidence(reviewId, "contract_confirmed", {
    sha: confirmation.confirmedSha,
    detail:
      confirmation.addedLenses.length > 0
        ? `contract widened with recorded evidence: added ${confirmation.addedLenses.join(", ")}`
        : noDrift !== undefined
          ? `contract confirmed unchanged on a recorded no_drift evaluation: ${noDrift.statement}`
          : `contract confirmed unchanged; lenses ${confirmation.contract.risk_lenses.join(", ")}`,
    meta: {
      addedLenses: confirmation.addedLenses,
      widening: confirmation.widening,
      changedPaths: paths,
      // The evaluation itself is the durable record — the stage evidence is where an
      // "evaluated, nothing to widen" outcome stops being indistinguishable from silence.
      ...(noDrift !== undefined ? { evaluation: "no_drift", noDrift } : {}),
    },
  });

  return {
    transition,
    status: "advanced",
    message:
      confirmation.addedLenses.length > 0
        ? `contract confirmed at ${confirmation.confirmedSha}, widened with ${confirmation.addedLenses.join(", ")}`
        : noDrift !== undefined
          ? `contract confirmed at ${confirmation.confirmedSha} on a recorded no_drift evaluation`
          : `contract confirmed at ${confirmation.confirmedSha}`,
  };
}

// ─── stage 2b + 3 ───────────────────────────────────────────────────────────

async function runDiscovery(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const review = getReview(reviewId) as Review;
  setReviewState(reviewId, "discovering", { reason: transition.reason });

  const approved = validateReviewContract(review.contract);
  if (!approved.ok) return { transition, status: "refused", message: approved.refusal };
  const confirmedSha = review.contractConfirmedSha as string;
  const lenses = approved.contract.risk_lenses;

  // Parallel, read-only, against ONE recorded sha.
  const dispatches = await Promise.all(
    lenses.map((lens) =>
      Promise.resolve(
        deps.dispatchLens({
          review,
          lens,
          role: lensRole(lens),
          candidateSha: confirmedSha,
          contract: approved.contract,
        }),
      ),
    ),
  );
  const outcomes: LensOutcome[] = dispatches.map(assessLens);
  updateReview(reviewId, { lensOutcomes: outcomes });

  const completeness = assessDiscoveryCompleteness(lenses, outcomes);
  if (!completeness.complete) {
    // NOT completion. No stage record, no synthesized pass, no empty finding set — the
    // panel is incomplete and stays incomplete until the lens is retried, the contract is
    // amended by its approving authority, or the missing evidence is explicitly accepted
    // against the NAMED lens.
    setReviewState(reviewId, "discovering", {
      reason: `discovery incomplete: ${completeness.missing.map((m) => `${m.lens} (${m.reason})`).join(", ")}`,
    });
    return {
      transition,
      status: "refused",
      message:
        `discovery is INCOMPLETE — no reviewer-authored outcome for ` +
        `${completeness.missing.map((m) => `${m.lens} (${m.reason}: ${m.detail})`).join("; ")}. ` +
        `No pass and no empty finding set was synthesized. Retry the lens, amend the contract through its ` +
        `approving authority, or record an authorized acceptance naming that lens.`,
    };
  }

  const normalized = normalizeObservations(collectObservations(outcomes), { discoveredSha: confirmedSha });
  const ingested = ingestFindings(reviewId, normalized.observations);

  recordStageEvidence(reviewId, "discovery", {
    sha: confirmedSha,
    detail: `${lenses.length} lens(es) authored an outcome; ${ingested.length} finding(s) ingested`,
    meta: {
      lenses: [...lenses],
      outcomes: outcomes.map((o) => ({ lens: o.lens, outcome: o.complete ? o.outcome : "incomplete" })),
      merges: normalized.merges,
      findingRefs: ingested.map((f) => f.findingRef),
    },
  });

  return {
    transition,
    status: "advanced",
    message:
      `discovery complete at ${confirmedSha}: ${ingested.length} finding(s) ingested from ${lenses.length} lens(es)` +
      (normalized.merges.length > 0 ? `, ${normalized.merges.length} deduplicated` : ""),
  };
}

// ─── stage 5 ────────────────────────────────────────────────────────────────

async function runBatchFix(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const snap = snapshot(reviewId);
  const review = snap.review;
  const candidate = review.candidateSha as string;
  const fixNow = snap.findings.filter((f) => f.disposition === "fix_now");
  setReviewState(reviewId, "fixing", { reason: transition.reason });

  const { batch } = ensureFixBatch(reviewId, candidate, fixNow);
  const payload = serializeFixBatchPayload(batch.payload);
  const ctx: FixerContext = { review, batch, payload };

  // Materialize, then verify THE BYTES against the persisted hash before the container
  // starts. A mismatch is a refusal — a fixer working from an unverified snapshot is a
  // fixer whose scope nobody can reconstruct later.
  const materialized = await deps.materializeFixBatch(ctx);
  const verified = verifyMaterializedPayload(batch, materialized);
  if (!verified.ok) {
    return { transition, status: "refused", message: verified.refusal };
  }

  const dispatch = await deps.dispatchFixer(ctx);
  // The empty-taskId sentinel (CoordinatorDeps.dispatchFixer): a refusal from BEFORE the
  // container started names no task. Marking the batch dispatched against an empty id would
  // record a delivery that never happened; leaving it open re-enters this revision as-is.
  if (dispatch.taskId !== "") markFixBatchDispatched(batch.id, dispatch.taskId);
  if (!dispatch.ok) {
    // Fixer crash: findings stay fix_now and unresolved. Nothing is recorded.
    return {
      transition,
      status: "refused",
      message:
        `the fixer failed (${dispatch.error ?? "no error recorded"}) — fix batch ${batch.id} revision ` +
        `${batch.revision} stays open and its findings stay fix_now, unresolved.`,
    };
  }

  const parsed = parseFixerResult(dispatch.result);
  if (!parsed.ok) return { transition, status: "refused", message: parsed.refusal };

  const ingestion = ingestFixBatchResults(
    batch.id,
    dispatch.taskId,
    { batchId: parsed.claimedBatchId, revision: parsed.claimedRevision },
    parsed.results,
  );
  if (!ingestion.ok) return { transition, status: "refused", message: ingestion.refusal };

  // A FIX CYCLE RAN, SO THE VERDICTS FROM BEFORE IT ARE STALE — including when this fixer
  // committed nothing. advanceCandidate below clears candidate-bound resolutions only when
  // the sha actually moves, and an unmoved sha is exactly the case that used to leave a
  // finding carrying the previous cycle's `still_present` at the current candidate: it holds
  // the review at the disposition stop, and re-deciding it only runs the fixer again.
  invalidateResolutionsForFixCycle(
    reviewId,
    batch.payload.findings.map((f) => f.finding_id),
    batch.id,
  );

  // A scope-changing conflict returns THAT finding to disposition as an architecture
  // question and lets the rest of the batch proceed. Guessing through it is what the
  // existing scope guard exists to prevent.
  const scopeChanged: string[] = [];
  for (const id of parsed.scopeChanges) {
    const record = ingestion.records.find((r) => r.findingId === id);
    const outcome = recordDisposition(id, {
      decision: "architecture_question",
      rationale:
        `the fixer reported this finding cannot be resolved without changing scope: ` +
        `${record?.evidence ?? "(no reason recorded)"}`,
      operator: false,
    });
    if (outcome.ok) scopeChanged.push(outcome.finding.findingRef);
  }

  const head = await deps.headSha();
  advanceCandidate(reviewId, head);

  recordStageEvidence(reviewId, "fix", {
    sha: candidate,
    detail:
      `fix batch ${batch.id} revision ${batch.revision} ingested for ${batch.payload.findings.length} finding(s)` +
      (scopeChanged.length > 0 ? `; ${scopeChanged.join(", ")} returned as architecture question(s)` : ""),
    meta: {
      fixBatchId: batch.id,
      revision: batch.revision,
      payloadSha256: batch.payloadSha256,
      taskId: dispatch.taskId,
      repeatIngest: ingestion.alreadyIngested,
      scopeChanged,
      candidateAfter: head,
    },
  });

  return {
    transition,
    status: "advanced",
    message:
      `ONE fixer handled ${batch.payload.findings.length} fix_now finding(s) as fix batch ${batch.id} ` +
      `revision ${batch.revision}` +
      (scopeChanged.length > 0
        ? `; ${scopeChanged.join(", ")} returned to disposition as architecture question(s)`
        : ""),
  };
}

// ─── stage 6 ────────────────────────────────────────────────────────────────

async function runDocs(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const review = getReview(reviewId) as Review;
  const candidateBefore = review.candidateSha as string;
  setReviewState(reviewId, "documenting", { reason: transition.reason });

  const result = await deps.dispatchDocs({ review, candidateSha: candidateBefore });
  if (!result.ok) {
    return {
      transition,
      status: "refused",
      message: `docs reconciliation failed (${result.error ?? "no error recorded"}) — nothing was recorded.`,
    };
  }

  // The docs phase MAY change the candidate; that is exactly why it runs before final
  // verification. The stage is recorded at the sha it PRODUCED, so verification and recheck
  // bind to the post-docs candidate and never to a pre-docs one.
  const head = await deps.headSha();
  advanceCandidate(reviewId, head);
  recordStageEvidence(reviewId, "docs", {
    sha: head,
    detail: head === candidateBefore ? `docs reconciliation left the candidate at ${head}` : `docs moved the candidate ${candidateBefore} → ${head}`,
  });

  return {
    transition,
    status: "advanced",
    message:
      head === candidateBefore
        ? `docs reconciliation complete; candidate unchanged at ${head}`
        : `docs reconciliation moved the candidate ${candidateBefore} → ${head}; final verification and recheck ` +
          `now bind to the post-docs candidate`,
  };
}

// ─── stage 8 ────────────────────────────────────────────────────────────────

async function runRecheck(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const snap = snapshot(reviewId);
  const review = snap.review;
  const candidate = review.candidateSha as string;
  const confirmedSha = review.contractConfirmedSha as string;
  const expected = snap.findings.filter((f) => f.disposition === "fix_now");
  setReviewState(reviewId, "rechecking", { reason: transition.reason });

  if (expected.length === 0 && confirmedSha === candidate) {
    recordStageEvidence(reviewId, "recheck", {
      sha: candidate,
      detail: "no fix_now findings and the candidate never moved — Stage 8 is a legitimate no-op",
      meta: { noop: true, fixCycleKey: fixCycleKey(snap.batches) },
    });
    return { transition, status: "advanced", message: `recheck is a no-op at ${candidate}` };
  }

  // The FIXER'S per-finding evidence, from the ingested results — not the finding's own
  // original evidence. The rechecker's job is to VERIFY this claim, so it has to receive
  // the claim rather than a restatement of the finding.
  const fixerEvidence: Record<string, string> = {};
  for (const b of snap.batches) {
    for (const r of fixBatchResults(b.id)) {
      if (r.evidence !== undefined) fixerEvidence[r.findingId] = r.evidence;
    }
  }

  const approved = validateReviewContract(review.contract);
  const lensInstructions: Record<string, string> = {};
  for (const f of expected) {
    if (f.riskLens !== undefined) lensInstructions[f.findingRef] = `source lens: ${f.riskLens} (${lensRole(f.riskLens as RiskLens)})`;
  }

  const dispatch = await deps.dispatchRechecker({
    review,
    candidateSha: candidate,
    confirmedSha,
    expected,
    fixerEvidence,
    delta: await deps.diff(confirmedSha, candidate),
    contract: approved.ok ? approved.contract : review.contract,
    lensInstructions,
  });

  if (!dispatch.ok) {
    return {
      transition,
      status: "refused",
      message:
        `the rechecker failed (${dispatch.error ?? "no error recorded"}) — no resolution was inferred and every ` +
        `finding stays exactly as it was. A recheck that did not run is not a recheck that found nothing.`,
    };
  }

  const ingestion = ingestRecheck(dispatch.result, { reviewId, candidateSha: candidate, expected });
  if (!ingestion.ok) {
    return { transition, status: "refused", message: ingestion.refusal };
  }

  for (const a of ingestion.applications) {
    recordResolution(a.findingId, {
      resolution: a.resolution,
      evidenceKind: a.resolution === "resolved" ? a.evidenceKind : a.coverage,
      evidence: a.resolution === "resolved" ? a.evidence : a.detail,
      resolvedSha: candidate,
    });
  }

  const newIngested =
    ingestion.newFindings.length > 0
      ? ingestFindings(
          reviewId,
          normalizeObservations(
            ingestion.newFindings.map((f) => ({
              finding: f,
              source: { redRole: "review-rechecker", redTaskId: dispatch.taskId, note: "bounded remediation-delta review" },
            })),
            { discoveredSha: candidate },
          ).observations,
        )
      : [];

  recordStageEvidence(reviewId, "recheck", {
    sha: candidate,
    detail:
      `${ingestion.applications.length} known id(s) rechecked exactly; ${newIngested.length} new finding(s) from the ` +
      `bounded delta review`,
    meta: {
      results: ingestion.applications.map((a) => ({ ref: a.findingRef, resolution: a.resolution, coverage: a.coverage })),
      newFindingRefs: newIngested.map((f) => f.findingRef),
      unresolved: ingestion.applications.filter((a) => a.resolution !== "resolved").map((a) => a.findingRef),
      // Half of this stage's completion key: the fix cycles this recheck covered. Without it
      // a later cycle at the same sha reads as already rechecked (see fixCycleKey).
      fixCycleKey: fixCycleKey(snap.batches),
    },
  });

  if (ingestion.returnsToDisposition) {
    setReviewState(reviewId, "awaiting_disposition", {
      reason: "recheck left findings unresolved or raised new ones — returning to disposition, no automatic fixer",
    });
  }

  const unresolved = ingestion.applications.filter((a) => a.resolution !== "resolved");
  return {
    transition,
    status: "advanced",
    message:
      `recheck at ${candidate}: ${ingestion.applications.length - unresolved.length} resolved, ` +
      `${unresolved.length} unresolved (${unresolved.map((a) => `${a.findingRef}=${a.resolution}`).join(", ") || "none"})` +
      (newIngested.length > 0
        ? `; ${newIngested.length} new finding(s) recorded untriaged (${newIngested.map((f) => f.findingRef).join(", ")}) — no automatic fixer`
        : ""),
  };
}

// ─── stage 9 ────────────────────────────────────────────────────────────────

async function runShippingReview(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const snap = snapshot(reviewId);
  const candidate = snap.review.candidateSha as string;
  setReviewState(reviewId, "shipping_review", { reason: transition.reason });

  const input = await deps.shippingInput({ review: snap.review, candidateSha: candidate });
  const assessment = assessShippingReview({ ...input, candidateSha: candidate, findings: snap.findings });

  if (!assessment.ok) {
    if (assessment.returnsToDisposition) {
      setReviewState(reviewId, "awaiting_disposition", {
        reason: `shipping review returns to disposition: ${assessment.blocking.join(" | ")}`,
      });
    }
    return {
      transition,
      status: "refused",
      message: `shipping review blocks:\n  - ${assessment.blocking.join("\n  - ")}`,
      shipping: assessment,
    };
  }

  recordStageEvidence(reviewId, "shipping", {
    sha: candidate,
    detail: `all seven shipping checks green at ${candidate}`,
    meta: { checks: assessment.checks, acceptance: assessment.acceptance },
  });
  setReviewState(reviewId, "settled", { reason: `shipping review passed at ${candidate}` });

  return {
    transition,
    status: "advanced",
    message: `shipping review passed at ${candidate} — the review is settled`,
    shipping: assessment,
  };
}
