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
//   - THE CANDIDATE MOVES, AND MOVING IT INVALIDATES CANDIDATE-BOUND EVIDENCE. A fix cycle
//     or a docs phase commits, the head changes, and every resolution proven at the old sha
//     stops being evidence about the new one. `advanceCandidate` is the single place that
//     happens, so no stage can move the candidate and forget.
//
//     FG-649: the fix cycle's commit is the COORDINATOR'S (deps.commitFixCycle), so Stage 5
//     advances to a sha it AUTHORED. It used to read `headSha()` right after ingestion and
//     hope the committer had already acted; when the orchestrator was the committer that read
//     was a guaranteed no-op, the fix stage recorded the PRE-fix candidate, and the rechecker
//     was then handed a tree without the fixes it was rechecking — an unresolvable loop.
//
//   - A STAGE RECORDS ITSELF ONLY ON SUCCESS. A refused ingestion, a crashed lens, a
//     failed verification — none of them write a stage record, so `continue` re-enters
//     that same stage rather than stepping over it. That is what makes "never repeat a
//     completed stage" safe: only completion is recorded, so re-entry after a crash is
//     re-entry into the stage that did not finish.
//
//     "NOTHING RECORDED" INCLUDES THE STATE MARKER AND ANY DISPOSITION (FG-649 RF-1). Stage 5
//     used to move the row to `fixing` and record a scope-changing finding's disposition
//     BEFORE the commit that its own contract says must succeed first, so a refused commit
//     left a review parked mid-fix with a disposition it had not earned. Every Stage 5
//     refusal now goes through one `refuse` helper that puts the state back, and the
//     dispositions are written after the commit returns.

import {
  findingsForReview,
  getReview,
  ingestFindings,
  lensAcceptancesOf,
  invalidateResolutionsForCandidate,
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
  type FixBatchResultRecord,
} from "../store/fix-batches.js";
import {
  classifyVerification,
  fixCycleAwaitingRecord,
  fixCycleKey,
  nextTransition,
  unresolvedFixNow,
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

/** FG-649: what the coordinator's own fix-cycle commit did.
 *
 *  `committed` names the sha it CREATED — that is the whole point: the candidate is a sha the
 *  coordinator authored, not one it read back out of a race with whoever else might commit.
 *  `no_change` is a legitimate cycle that moved nothing (the fixer resolved a finding without
 *  touching code), and the candidate correctly does not move; `fixCycleKey` already makes such
 *  a cycle earn its own recheck. `refused` is NAMED and records nothing.
 *
 *  FG-649 RF-2: `recognized` marks a `committed` outcome the coordinator did not author on
 *  THIS pass — it found the commit it had already authored for this batch revision and is
 *  reporting it again so the ledger writes that a crash interrupted can complete. The audit
 *  trail must be able to tell "I committed this now" from "I recovered the commit I made
 *  before the crash"; they are the same sha but not the same event.
 *
 *  FG-649 RF-5: `declaredNotMoved` names the paths the fix results DECLARED that the worktree
 *  never moved. The commit still carries only declared paths — it is a strict subset — but a
 *  declaration the tree does not support may not travel silently beside evidence that
 *  contradicts it, so it rides the outcome into the stage record and the operator's line. */
export type FixCycleCommit =
  | { kind: "committed"; sha: string; committedPaths: string[]; recognized?: boolean; declaredNotMoved?: string[] }
  | { kind: "no_change"; sha: string }
  | { kind: "refused"; reason: string; detail: string };

export type FixCycleCommitContext = {
  review: Review;
  batch: FixBatch;
  /** The ingested results, read back from the store — the fixer's own per-finding ledger. */
  results: readonly FixBatchResultRecord[];
  /** The union of `files_changed` across those results: the fixer's OWN claim about what it
   *  touched, and therefore an expected-changes set the host did not have to guess. */
  declaredFiles: readonly string[];
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
  /** FG-649 change 1: THE COORDINATOR COMMITS THE FIX CYCLE, so the post-fix sha is known
   *  rather than inferred from a later `headSha()` read the orchestrator may not have reached
   *  yet. Reading HEAD right after ingestion is a guaranteed no-op when the committer acts
   *  after this process exits — which is exactly how the live loop recorded a pre-fix candidate
   *  and had the rechecker examine a tree without the fixes it was rechecking. */
  commitFixCycle: (ctx: FixCycleCommitContext) => Awaitable<FixCycleCommit>;
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
  /** Set by the shipping-review stage so the caller can render the eight checks. */
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
  // The acceptances survive a re-dispatch: they are operator decisions about this confirmed
  // candidate, and a retry that crashes again must not silently erase one.
  const acceptances = lensAcceptancesOf(review);
  updateReview(reviewId, { lensOutcomes: [...acceptances, ...outcomes] });

  const completeness = assessDiscoveryCompleteness(lenses, outcomes, {
    acceptances,
    candidateSha: confirmedSha,
  });
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
        `approving authority, or record an authorized acceptance naming that lens ` +
        `(\`forge review accept-lens ${reviewId} <lens> --operator --missing-evidence "..." --rationale "..."\`).`,
    };
  }

  const normalized = normalizeObservations(collectObservations(outcomes), { discoveredSha: confirmedSha });
  const ingested = ingestFindings(reviewId, normalized.observations);

  recordStageEvidence(reviewId, "discovery", {
    sha: confirmedSha,
    detail:
      `${lenses.length - completeness.accepted.length} lens(es) authored an outcome` +
      (completeness.accepted.length > 0
        ? `, ${completeness.accepted.map((a) => a.lens).join(", ")} cleared by an authorized acceptance`
        : "") +
      `; ${ingested.length} finding(s) ingested`,
    meta: {
      lenses: [...lenses],
      outcomes: outcomes.map((o) => ({ lens: o.lens, outcome: o.complete ? o.outcome : "incomplete" })),
      // The stage record must not read as if an accepted lens was reviewed — the acceptance
      // and the evidence it names are part of what this stage completed on.
      acceptedLenses: completeness.accepted.map((a) => ({ lens: a.lens, missingEvidence: a.missingEvidence })),
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

  // FG-649: THE INGESTED-RESULTS SHORT-CIRCUIT, AHEAD OF EVERY DISPATCH DECISION. A cycle whose
  // results are already in the ledger but whose commit did not happen (a crash, or a named
  // commit refusal) must finish THAT cycle — not mint a new revision and run a second real
  // fixer container over already-fixed code. It is also the only path that may run with an
  // empty unresolved set, because the fixer that produced these results may have resolved
  // everything in the batch.
  const pending = fixCycleAwaitingRecord(snap);
  const fixNow = unresolvedFixNow(snap.findings, candidate);

  // THE EMPTY SET IS A NAMED REFUSAL, NOT A STACK TRACE. `ensureFixBatch` throws on an empty
  // finding list, and this refusal must land BEFORE setReviewState — a row moved to `fixing`
  // for a stage that can never be selected again is parked mid-stage with nothing an operator
  // could act on. With the selecting predicate and this guard sharing one definition of the
  // set (unresolvedFixNow) the transition is not selected here anyway; the guard is what makes
  // that true by construction rather than by agreement between two call sites.
  if (pending === undefined && fixNow.length === 0) {
    return {
      transition,
      status: "refused",
      message:
        `fix_cycle_empty_unresolved_set: review ${reviewId} has no UNRESOLVED fix_now finding at candidate ` +
        `${candidate} — every one of them is either absent or already resolved at that candidate, so there is no ` +
        `scope to hand a fixer. An already-resolved finding is never re-dispatched and its resolution is ` +
        `preserved (RF-8). Nothing was written.`,
    };
  }

  // FG-649 RF-1: EVERY REFUSAL PAST THIS POINT GOES THROUGH `refuse`. Moving the row to
  // `fixing` is a mutation like any other, and the stage contract is that a refused stage
  // leaves NOTHING behind — including a state marker that says a fixer is running when none
  // is. The state goes back where the stage found it, so an operator reading `forge review
  // show` after a refusal sees the stage it must re-enter, not a review parked mid-fix.
  const stateBefore = review.state;
  const refuse = (message: string): StageOutcome => {
    if (stateBefore !== "fixing") {
      setReviewState(reviewId, stateBefore, {
        reason: `stage 5 refused with nothing recorded; the row returns to ${stateBefore}`,
      });
    }
    return { transition, status: "refused", message };
  };

  setReviewState(reviewId, "fixing", { reason: transition.reason });

  const batch = pending ?? ensureFixBatch(reviewId, candidate, fixNow).batch;

  let taskId: string;
  let results: readonly FixBatchResultRecord[];
  let scopeChangeIds: string[];
  let repeatIngest: boolean;

  if (pending !== undefined) {
    // Re-derived from the store, never re-dispatched. `fixBatchResults` is the same read the
    // ingest returns, so the commit sees exactly the scope the ledger recorded.
    results = fixBatchResults(batch.id);
    taskId = batch.dispatchTaskId ?? results[0]?.taskId ?? "";
    scopeChangeIds = results.filter((r) => r.result === "scope_change").map((r) => r.findingId);
    // No ingestion ran on this pass at all, so this is not a repeat DELIVERY —
    // `resumedFromIngested` is the field that says what happened.
    repeatIngest = false;
  } else {
    const payload = serializeFixBatchPayload(batch.payload);
    const ctx: FixerContext = { review, batch, payload };

    // Materialize, then verify THE BYTES against the persisted hash before the container
    // starts. A mismatch is a refusal — a fixer working from an unverified snapshot is a
    // fixer whose scope nobody can reconstruct later.
    const materialized = await deps.materializeFixBatch(ctx);
    const verified = verifyMaterializedPayload(batch, materialized);
    if (!verified.ok) return refuse(verified.refusal);

    const dispatch = await deps.dispatchFixer(ctx);
    // The empty-taskId sentinel (CoordinatorDeps.dispatchFixer): a refusal from BEFORE the
    // container started names no task. Marking the batch dispatched against an empty id would
    // record a delivery that never happened; leaving it open re-enters this revision as-is.
    if (dispatch.taskId !== "") markFixBatchDispatched(batch.id, dispatch.taskId);
    if (!dispatch.ok) {
      // Fixer crash: findings stay fix_now and unresolved. Nothing is recorded.
      return refuse(
        `the fixer failed (${dispatch.error ?? "no error recorded"}) — fix batch ${batch.id} revision ` +
          `${batch.revision} stays open and its findings stay fix_now, unresolved.`,
      );
    }

    const parsed = parseFixerResult(dispatch.result);
    if (!parsed.ok) return refuse(parsed.refusal);

    const ingestion = ingestFixBatchResults(
      batch.id,
      dispatch.taskId,
      { batchId: parsed.claimedBatchId, revision: parsed.claimedRevision },
      parsed.results,
    );
    if (!ingestion.ok) return refuse(ingestion.refusal);

    taskId = dispatch.taskId;
    results = ingestion.records;
    scopeChangeIds = parsed.scopeChanges;
    repeatIngest = ingestion.alreadyIngested;
  }

  // THE FIXER'S OWN CLAIM about what it touched, read back from the ledger — an expected-changes
  // set the host did not have to infer, and strictly narrower than `git add -A` plus a denylist.
  const declaredFiles = [...new Set(results.flatMap((r) => r.filesChanged))].sort();
  const commit = await deps.commitFixCycle({ review, batch, results, declaredFiles });
  if (commit.kind === "refused") {
    // A NAMED refusal, and Stage 5 stays open with NOTHING recorded: the results stay ingested,
    // so re-entry short-circuits to this same commit attempt rather than running a second fixer.
    return refuse(
      `${commit.reason}: ${commit.detail} — fix batch ${batch.id} revision ${batch.revision} keeps its ingested ` +
        `results, the candidate stays at ${candidate}, and no fix stage record was written. Resolve the tree and ` +
        `re-run \`forge review continue ${reviewId}\`; no second fixer will be dispatched for this revision.`,
    );
  }

  // A scope-changing conflict returns THAT finding to disposition as an architecture
  // question and lets the rest of the batch proceed. Guessing through it is what the
  // existing scope guard exists to prevent. Its resolution is deliberately left alone —
  // `ingestFixBatchResults` already excluded a `scope_change` result from the fix-cycle
  // invalidation it ran in the ingest transaction.
  //
  // FG-649 RF-1: THIS RUNS AFTER THE COMMIT SUCCEEDS, not before it. Recorded ahead of the
  // commit it made a disposition durable on a stage that then refused — the row lost a
  // finding out of `fix_now` while Stage 5 was left to be re-entered with nothing recorded.
  // Re-entry re-derives `scopeChangeIds` from the same ingested results, so deferring it
  // loses nothing; the fix_now guard keeps it idempotent if a later pass gets here twice.
  const scopeChanged: string[] = [];
  for (const id of scopeChangeIds) {
    const record = results.find((r) => r.findingId === id);
    const current = snap.findings.find((f) => f.id === id);
    if (current !== undefined && current.disposition !== "fix_now") continue;
    const outcome = recordDisposition(id, {
      decision: "architecture_question",
      rationale:
        `the fixer reported this finding cannot be resolved without changing scope: ` +
        `${record?.evidence ?? "(no reason recorded)"}`,
      operator: false,
    });
    if (outcome.ok) scopeChanged.push(outcome.finding.findingRef);
  }

  // advanceCandidate is the ONE place the candidate moves, so scenario #14's invalidation fires
  // by construction and docs / verified_final / recheck / shipping re-anchor to the post-fix sha
  // through the existing per-sha stage rules — no new key.
  //
  // ONLY A `committed` OUTCOME MOVES IT, and only to the sha the coordinator itself created. A
  // no-change cycle leaves the candidate exactly where it was rather than adopting whatever the
  // worktree head happens to be — adopting it would be the bare-HEAD read this lifecycle
  // forbids, and would quietly re-anchor the whole ledger onto someone else's commit.
  const candidateAfter = commit.kind === "committed" ? commit.sha : candidate;
  if (commit.kind === "committed") advanceCandidate(reviewId, commit.sha);

  recordStageEvidence(reviewId, "fix", {
    // The fix record's OWN sha stays the PRE-fix candidate: fix coverage is decided per finding
    // under its current decision (decisionCoveredByIngestedBatch), never by stageCompleteAt.
    sha: candidate,
    detail:
      `fix batch ${batch.id} revision ${batch.revision} ingested for ${batch.payload.findings.length} finding(s)` +
      (scopeChanged.length > 0 ? `; ${scopeChanged.join(", ")} returned as architecture question(s)` : "") +
      (commit.kind === "committed"
        ? commit.recognized === true
          ? `; the fix cycle's commit ${commit.sha} (${commit.committedPaths.length} path(s)) was authored by an ` +
            `earlier pass that crashed before recording it, and was RECOVERED rather than re-authored`
          : `; the fix cycle was committed as ${commit.sha} (${commit.committedPaths.length} path(s))`
        : `; the fix cycle changed nothing, candidate stays ${candidateAfter}`) +
      (commit.kind === "committed" && commit.declaredNotMoved !== undefined
        ? `; the results DECLARED ${commit.declaredNotMoved.join(", ")}, which the worktree never moved`
        : ""),
    meta: {
      fixBatchId: batch.id,
      revision: batch.revision,
      payloadSha256: batch.payloadSha256,
      taskId,
      repeatIngest,
      resumedFromIngested: pending !== undefined,
      scopeChanged,
      candidateAfter,
      fixCommit: {
        kind: commit.kind,
        sha: commit.sha,
        committedPaths: commit.kind === "committed" ? commit.committedPaths : [],
        // RF-2: true when this pass RECOVERED a commit an earlier crashed pass authored.
        recognized: commit.kind === "committed" && commit.recognized === true,
        // RF-5: the declared paths the tree never moved. Empty is the honest ledger.
        declaredNotMoved: commit.kind === "committed" ? (commit.declaredNotMoved ?? []) : [],
        declaredFiles,
      },
    },
  });

  return {
    transition,
    status: "advanced",
    message:
      `ONE fixer handled ${batch.payload.findings.length} unresolved fix_now finding(s) as fix batch ${batch.id} ` +
      `revision ${batch.revision}` +
      (scopeChanged.length > 0
        ? `; ${scopeChanged.join(", ")} returned to disposition as architecture question(s)`
        : "") +
      (commit.kind === "committed"
        ? `; the cycle was committed as ${commit.sha} and the candidate now binds to it`
        : `; the cycle changed no file, so the candidate stays at ${candidateAfter}`) +
      // RF-5: an unsupported declaration is never silent. The commit still carries only
      // declared paths; what the tree did not support is said out loud, on the same line.
      (commit.kind === "committed" && commit.declaredNotMoved !== undefined
        ? `. NOTE: the fix results declared ${commit.declaredNotMoved.join(", ")}, which the worktree never moved — ` +
          `the commit carries only what did, and the recheck adjudicates the claim`
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

  // FG-640: PERSIST THE TRUSTED TIP. Tip trust is established live (a bounded fetch of the
  // remote head), but the `review_disposition` gate is a read of DURABLE state — it cannot
  // re-fetch, and a trusted head that lives only in this function's local would leave the gate
  // permanently unable to establish equality and permanently blocked on `tip_not_trusted`.
  // Recorded only when it IS equality, so the column never carries a head the review did not
  // actually match; a candidate that moves later stops equalling it, which is correct.
  if (input.tipTrust.kind === "trusted") {
    updateReview(reviewId, { trustedRemoteSha: input.tipTrust.remoteSha ?? candidate });
  }

  const assessment = assessShippingReview({ ...input, candidateSha: candidate, findings: snap.findings });

  if (!assessment.ok) {
    // FG-640: A LATE FINDING IS AN ORDINARY FINDING. The shipping reviewer's free-form
    // findings enter the ledger untriaged and go through the same disposition gate as anything
    // discovery raised — lateness confers no authority to settle them, and no authority to
    // block on them past a disposition either. Ingesting rather than only reporting is what
    // makes that true: reported-only, a free-form finding would hold the review at Stage 9
    // with nothing an operator could disposition by name.
    //
    // INGESTED ONCE PER SUMMARY, because Stage 9 re-runs. `newFindings` non-empty always makes
    // the assessment refuse, so a reviewer that keeps reporting the same concern would append a
    // fresh untriaged row on every `continue` — the operator dispositions N, re-enters, and
    // finds N more. Existing rows are the dedup key: the summary the shipping reviewer used.
    const seen = new Set(snap.findings.map((f) => f.summary.trim()));
    const late = (input.newFindings ?? []).filter((f) => !seen.has(f.summary.trim()));
    if (late.length > 0) {
      ingestFindings(
        reviewId,
        late.map((f) => ({
          summary: f.summary,
          severity: "unknown",
          reachability: "speculative",
          findingType: "shipping_review_late",
          discoveredSha: candidate,
          sources: [{ redRole: "shipping-reviewer", note: "raised free-form during the shipping review" }],
        })),
      );
    }
    if (assessment.returnsToDisposition) {
      setReviewState(reviewId, "awaiting_disposition", {
        reason: `shipping review returns to disposition: ${assessment.blocking.join(" | ")}`,
      });
    }
    return {
      transition,
      status: "refused",
      message:
        `shipping review blocks:\n  - ${assessment.blocking.join("\n  - ")}` +
        (late.length > 0
          ? `\n  (${late.length} free-form finding(s) ingested as untriaged ledger findings — disposition them by name)`
          : ""),
      shipping: assessment,
    };
  }

  recordStageEvidence(reviewId, "shipping", {
    sha: candidate,
    detail: `all eight shipping checks green at ${candidate}`,
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
