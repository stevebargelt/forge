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
  lensOutcomeRecordsOf,
  lensSkipRecordsOf,
  mergeLensOutcomesByShard,
  recordLensSkipped,
  recordShardPlan,
  invalidateResolutionsForCandidate,
  recordAgentProtocol,
  pendingDocsDispatch,
  recordDisposition,
  recordResolution,
  recordStageEvidence,
  retireDocsDispatch,
  setReviewState,
  updateReview,
  type DocsDispatch,
  type PlannedShard,
  type Review,
  type ReviewFinding,
  type ShardDerivation,
  type ShardPlan,
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
  assessLens,
  assessShardCompleteness,
  collectObservations,
  normalizeObservations,
  type LensDispatch,
  type LensOutcome,
  type ShardIdentity,
} from "./review-discovery.js";
import {
  confirmContract,
  lensRole,
  validateReviewContract,
  type ContractProposal,
  type RiskLens,
} from "./review-contract.js";
import {
  DEFAULT_SHARD_BUDGET,
  SHARD_BUDGET_UNIT,
  UNVALIDATED_BUDGET_RUNTIME,
  planShards,
  resolveScopes,
  scopesDigestOf,
} from "./review-shards.js";
import type { ReviewDiffFile, ReviewDiffRendering, ReviewDiffResult } from "./review-diff.js";
import type { DependencyEnvironmentReceipt } from "./dependency-provisioning.js";
import { parseFixerResult } from "./review-fixer.js";
import { ingestRecheck } from "./review-recheck.js";
import { assessShippingReview, type ShippingAssessment, type ShippingInput } from "./review-shipping.js";

type Awaitable<T> = T | Promise<T>;

/** FG-689: ONE DISPATCH'S WORTH of a lens's scope — never the whole change.
 *
 *  The three new fields are what stop a reviewer mistaking a shard for the change. `diff` is
 *  the shard's ALREADY-RENDERED bytes, sliced out of the one pinned rendering the plan was cut
 *  from: the dispatch seam no longer computes a diff at all, which is what removes the second
 *  unpinned `git diff` and the `catch`-and-substitute placeholder that stood in for it (D15).
 *  `shard` and `derivationDigest` are the coordinator's, not the seam's — see runDiscovery. */
export type LensContext = {
  review: Review;
  lens: RiskLens;
  role: string;
  candidateSha: string;
  contract: unknown;
  /** WHICH shard of this lens's scope, 1-based, and how many there are. */
  shard: ShardIdentity;
  /** The paths this shard covers, in the plan's order. */
  paths: string[];
  /** Those paths' rendered bodies, joined in order — the reviewer's whole input. */
  diff: string;
  /** The partition identity the shard was cut under. */
  derivationDigest: string;
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

/** FG-655: what the coordinator's own DOCS-cycle commit did.
 *
 *  Deliberately the same three outcomes and the same vocabulary as `FixCycleCommit`, for the
 *  same reasons: `committed` names the sha the coordinator CREATED (or, with `recognized`,
 *  the one it authored on a pass that crashed before the ledger writes and is now recovering
 *  rather than re-authoring); `no_change` is a docs cycle that legitimately moved nothing, at
 *  a clean tree, and the candidate correctly does not move; `refused` is NAMED and records
 *  nothing. Two similar shapes are better than one generalized one — the fix cycle's
 *  behaviour must not move because the docs stage acquired the same authority. */
export type DocsCycleCommit =
  | { kind: "committed"; sha: string; committedPaths: string[]; recognized?: boolean; declaredNotMoved?: string[] }
  | { kind: "no_change"; sha: string }
  | {
      kind: "refused";
      reason: string;
      detail: string;
      /** FG-655 RF-1: set ONLY by a refusal the committer reached with HEAD at the candidate
       *  and the worktree WHOLLY CLEAN. That is provable evidence that nothing of this
       *  delivery is present in the worktree, which is the same authorisation the dead-delivery
       *  arm already retires on — so the caller may retire the spent binding here without
       *  stranding anything. A refusal that cannot prove a clean tree never sets it, and
       *  retires nothing. */
      treeCleanAtCandidate?: boolean;
    };

export type DocsCycleCommitContext = {
  review: Review;
  /** The durable binding whose id is the stage-scoped idempotency key in the commit subject. */
  binding: DocsDispatch;
  /** The docs agent's OWN `docs_updated` declaration, read back off its durable task result.
   *  The worktree is never a source of scope — not on the authored path, and not in recovery. */
  declaredFiles: readonly string[];
};

/** FG-655: the docs agent's declaration, read off the DURABLE task record its binding names.
 *
 *  One read for both paths — the pass that just dispatched and the pass recovering after a
 *  crash — so the scope the commit carries cannot depend on which pass is asking. An
 *  `unreadable` delivery is absent or unparseable; it is a refusal, never an empty
 *  declaration, because "the agent said it changed nothing" and "nobody can tell what the
 *  agent said" are different facts and only one of them may advance a stage.
 *
 *  FG-655 RF-2: a delivery that has not reached a TERMINAL state is `in_flight` and is
 *  deliberately NOT in the `unreadable` set. The clean-tree probe that authorises retiring an
 *  unreadable delivery proves a DEAD one left nothing behind; it cannot tell a dead agent from
 *  a live one that has not written yet, so folding a `running` task into `unreadable` is how a
 *  second documentation-maintainer gets dispatched into a checkout the first is still writing. */
export type DocsDelivery =
  | { kind: "delivered"; taskId: string; docsUpdated: readonly string[] }
  | { kind: "in_flight"; taskId: string; status: string; detail: string }
  | { kind: "unreadable"; detail: string };

export type CoordinatorDeps = {
  headSha: () => Awaitable<string>;
  verify: (sha: string) => Awaitable<VerificationEntry>;
  /** FG-689 D8/D14: THE ONE PINNED RENDERING, and the only diff seam this coordinator has.
   *
   *  It replaces the two it used to carry — a `changedPaths` that ran `git diff --name-only`
   *  and a `diff` that ran a flagless `git diff`. Those were two unpinned renderings of the
   *  same range, and two renderings can disagree: "every changed path is covered by a lens"
   *  was then checkable against a path set that no reviewer's bytes were derived from.
   *  Independently pinning them would not have fixed it — only deriving both answers from ONE
   *  set of bytes does, which is what `renderReviewDiff` returns.
   *
   *  It answers with a NAMED REFUSAL rather than throwing or substituting. A stage handed a
   *  refusal refuses; it never proceeds over a placeholder, because a reviewer handed anything
   *  other than the diff can author an honest pass over it and that pass clears the gate. */
  reviewDiff: (baseSha: string, candidateSha: string) => Awaitable<ReviewDiffResult>;
  /** FG-689 D4: the shard budget this review plans under, when the operator overrode the
   *  configured default. Absent means `DEFAULT_SHARD_BUDGET`, and the unit is always
   *  `SHARD_BUDGET_UNIT` — the number travels with its unit into the recorded derivation, so
   *  a provider change cannot reinterpret it (D10). A value here changes the plan's `digest`,
   *  which is exactly what makes every shard-scoped decision recorded under the old budget
   *  detectably superseded rather than silently honored. */
  shardBudget?: number;
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
  dispatchFixer: (ctx: FixerContext) => Awaitable<{
    ok: boolean;
    taskId: string;
    result?: unknown;
    error?: string;
    /** FG-654: the protocol generation the fixer ran under, read back off its task
     *  manifest. Absent when the dispatch was refused before a manifest was written. */
    protocol?: { role: string; sha256: string };
  }>;
  /** FG-649 change 1: THE COORDINATOR COMMITS THE FIX CYCLE, so the post-fix sha is known
   *  rather than inferred from a later `headSha()` read the orchestrator may not have reached
   *  yet. Reading HEAD right after ingestion is a guaranteed no-op when the committer acts
   *  after this process exits — which is exactly how the live loop recorded a pre-fix candidate
   *  and had the rechecker examine a tree without the fixes it was rechecking. */
  commitFixCycle: (ctx: FixCycleCommitContext) => Awaitable<FixCycleCommit>;
  /** FG-654: `protocol` carries the same per-dispatch stamp the fixer's does. Both of
   *  these roles are COVERED, and the rechecker is the one that judges the fixer's
   *  evidence, so "which protocol was it told" must be answerable from the ledger rather
   *  than by hand-reading a task manifest. */
  dispatchDocs: (ctx: { review: Review; candidateSha: string }) => Awaitable<{
    ok: boolean;
    error?: string;
    protocol?: { role: string; sha256: string; taskId: string };
    /** FG-655: the durable binding this dispatch was made under, created BEFORE the call
     *  reached anything that could start a container and completed with the host-minted task
     *  identity at mint time. Returned so the pass that dispatched uses the same row the
     *  re-entry short-circuit reads, rather than a second lookup that could disagree. */
    binding: DocsDispatch;
  }>;
  /** FG-655: the docs agent's own `docs_updated` declaration, read off the durable task
   *  record the binding names. The manifest / task record stays AUTHORITATIVE and the ledger
   *  binding is an index of identity only — the declaration is never copied into the ledger,
   *  so the two can never drift into disagreeing about scope. */
  docsDelivery: (ctx: { review: Review; binding: DocsDispatch }) => Awaitable<DocsDelivery>;
  /** FG-655: THE COORDINATOR COMMITS THE DOCS CYCLE, exactly as FG-649 made it commit the fix
   *  cycle, so Stage 6 advances to a sha it AUTHORED instead of adopting whatever the worktree
   *  head happens to be. REQUIRED and not optional, for the reason `dispatchFixer`'s contract
   *  gives: an optional seam is a seam some caller silently does without, and this one is the
   *  candidate-movement write path. */
  commitDocsCycle: (ctx: DocsCycleCommitContext) => Awaitable<DocsCycleCommit>;
  dispatchRechecker: (ctx: RecheckContextIn) => Awaitable<{
    ok: boolean;
    taskId?: string;
    result?: unknown;
    error?: string;
    /** FG-664: the dispatch's CLASSIFIED failure, when the failure site determined
     *  one. `verification_environment_unavailable` is the environment fault — a lane
     *  that could not be given the project's real native dependencies — and Stage 8
     *  routes it to the `blocked_environment` STOP rather than into the verdict plane.
     *  An environment fault is not a reviewer's opinion and must never become one. */
    failureKind?: string;
    /** FG-664 / AC3: the engine identity the host attested for the rechecker's own
     *  container, read back off its task manifest. Recorded into this stage's evidence
     *  so a resolution can be tied to the engine that produced it — the SAME receipt in
     *  two places, never two independently-written facts. */
    dependencyEnvironment?: DependencyEnvironmentReceipt;
    protocol?: { role: string; sha256: string; taskId: string };
  }>;
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

/** The rendering's bytes, reassembled. `renderReviewDiff` splits the output into contiguous
 *  per-file slices, so joining them in order reproduces what git emitted exactly — no
 *  separator, no reordering, nothing dropped. A caller that wants the whole diff as text gets
 *  the diff, not a rendering of a rendering. */
function renderingText(rendering: ReviewDiffRendering): string {
  return rendering.files.map((f) => f.body).join("");
}

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
  // FG-689 D8/D14: ONE RENDERING, and the base it resolves is the base of record for the whole
  // review. The path set this confirmation checks coverage against and records is the path set
  // the shards are later cut from — the same bytes, not a second git invocation that agrees
  // today.
  //
  // A RENDERING REFUSAL IS A STAGE REFUSAL. Nothing is recorded and the stage re-enters; there
  // is deliberately no arm that confirms over a diff nobody could compute. The old seam threw,
  // and a thrown git error out of a stage is not a decision anybody made either.
  const rendered = await deps.reviewDiff(review.baseSha, candidate);
  if (!rendered.ok) {
    return {
      transition,
      status: "refused",
      message:
        `the contract cannot be confirmed because the review's implementation diff could not be rendered ` +
        `(${rendered.reason}): ${rendered.refusal} No contract confirmation was recorded and no reviewer was ` +
        `dispatched.`,
    };
  }
  const paths = rendered.rendering.paths;
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
      // FG-689 D14: WHICH rendering this path set came from, recorded beside the paths so
      // "one rendering, one set" is auditable after the fact rather than only assertable in a
      // test. The shard plan records the same three values; a later flag change moves
      // `renderingId` and the two stop matching, which is the point.
      rendering: {
        renderingId: rendered.rendering.renderingId,
        baseSha: rendered.rendering.baseSha,
        candidateSha: rendered.rendering.candidateSha,
        unit: rendered.rendering.unit,
        totalChars: rendered.rendering.totalChars,
      },
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

// FG-689: DISCOVERY IS SCOPED, SHARDED, BOUNDED AND ASSESSED PER SHARD.
//
// The old shape was one dispatch per lens over the WHOLE unscoped diff, fanned out with a bare
// `Promise.all`. On a 46-file candidate that is 1,170,885 characters into every lens at once,
// and all five crashed identically on the provider's input cap — which is the ticket.
//
// THE ORDER BELOW IS THE CORRECTNESS ARGUMENT, not a style. Each step exists because doing it
// later opens a specific hole:
//
//   (a) render ONCE, pinned, and derive everything from those bytes (D8/D14). The path set the
//       scopes are resolved against and the bodies the shards carry are the same rendering, so
//       "every path is covered" cannot be true of one git invocation and false of another.
//   (b) resolve the AUTHORED scopes. No inference, no exclusion form; an uncovered path is a
//       refusal here as it is at confirmation, because the diff can only have grown a surface
//       nobody owns if something changed between the two stages.
//   (c) MEASURE, and refuse by measurement before anything starts. A file larger than one
//       shard's budget stops the review citing the measurement, the budget and the unit. There
//       is no arm that truncates, samples or summarises to make it fit (AC5/AC6).
//   (d) RECORD THE PLAN BEFORE ANY CONTAINER STARTS. The plan is what discovery is OWED, and
//       the gate reads it. Recorded after the fan-out it would not exist at the only moment it
//       matters — a lens whose every shard crashed delivers nothing, and an absence cannot say
//       how many shards were expected. The `lens_skipped` records go down here too, for the
//       same reason: a zero-path lens leaving the panel with nothing saying so is a lens that
//       silently vanished.
//   (e) dispatch lens x shard through an EXPLICIT width limit (D9). One-per-lens was five
//       containers; lens x shard is unbounded in principle, and this fan-out does not route
//       through the runner's own limit.
//   (f) MERGE the outcomes on shard identity (D7/D12) rather than replacing the column. A
//       retry that wrote back only the shards this pass produced would erase the outcomes of
//       the shards that already succeeded — the coverage the shard-granularity retry exists to
//       preserve, destroyed by the mechanism meant to preserve it.
//   (g) assess PER SHARD (D1). Every shard the plan names owes a schema-valid reviewer-authored
//       outcome; one surviving shard never satisfies a lens whose other shards crashed.

/** Run `work` over `items` with at most `width` in flight (FG-689 D9).
 *
 *  Results come back in ITEM order regardless of completion order, so the outcomes written to
 *  the ledger do not depend on which container finished first. Nothing here rejects: `work`
 *  is the assessor, which turns every dispatch failure into a named incomplete outcome. */
async function boundedFanout<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await work(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** One planned dispatch: which lens, which shard of it, and the bytes it carries. */
type ShardTarget = { lens: RiskLens; shard: PlannedShard; diff: string };

async function runDiscovery(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const review = getReview(reviewId) as Review;
  setReviewState(reviewId, "discovering", { reason: transition.reason });

  const approved = validateReviewContract(review.contract);
  if (!approved.ok) return { transition, status: "refused", message: approved.refusal };
  const confirmedSha = review.contractConfirmedSha as string;
  const lenses = approved.contract.risk_lenses;

  // (a) ONE PINNED RENDERING, over the review's recorded base and the CONFIRMED sha — the same
  // sha the outcomes are recorded against. No `~1` fallback anywhere in this path: one recorded
  // base, or a refusal.
  if (review.baseSha === undefined) {
    return {
      transition,
      status: "refused",
      message:
        `this review records no base sha, so its implementation diff cannot be rendered and no reviewer can be ` +
        `given anything to read. There is deliberately no ${confirmedSha}~1 fallback — a synthesised base would ` +
        `let the coverage check and the shards describe two different changes. Re-open the review naming its ` +
        `comparison base (forge review start --since <sha>). Nothing was recorded and no container was started.`,
    };
  }
  const rendered = await deps.reviewDiff(review.baseSha, confirmedSha);
  if (!rendered.ok) {
    return {
      transition,
      status: "refused",
      message:
        `discovery cannot dispatch because the review's implementation diff could not be rendered ` +
        `(${rendered.reason}): ${rendered.refusal} No shard plan was recorded and NO container was started — a ` +
        `reviewer handed anything other than the diff authors an honest pass over a change nobody saw.`,
    };
  }
  const rendering = rendered.rendering;
  const bodyOf = new Map<string, ReviewDiffFile>(rendering.files.map((f) => [f.path, f]));

  // (b) THE AUTHORED SCOPES, matched against THAT rendering's path set.
  const scopes = resolveScopes(approved.contract, rendering.paths);
  if (scopes.uncovered.length > 0) {
    // Confirmation already refuses this (step 7), so reaching it here means the rendering moved
    // between the two stages. Refusing rather than assigning an owner is the same rule in both
    // places: forge does not infer a lens, or a lens's scope, from a path.
    return {
      transition,
      status: "refused",
      message:
        `${scopes.uncovered.length} changed path(s) are matched by no selected lens's authored scope: ` +
        `${scopes.uncovered.join(", ")}. Forge does not infer an owner from a filename, so there is nobody to ` +
        `dispatch them to. The contract's approving authority must widen a lens's scope to cover them. No shard ` +
        `plan was recorded and no container was started.`,
    };
  }

  // (c) THE PARTITION'S INPUTS, recorded whole — `digest` is a sha over exactly these, so any
  // change to any of them makes every shard-scoped decision detectably about a partition that
  // no longer exists (D17).
  const derivation: ShardDerivation = {
    baseSha: rendering.baseSha,
    candidateSha: rendering.candidateSha,
    renderingId: rendering.renderingId,
    budget: deps.shardBudget ?? DEFAULT_SHARD_BUDGET,
    unit: SHARD_BUDGET_UNIT,
    budgetValidatedRuntime: UNVALIDATED_BUDGET_RUNTIME,
    scopesDigest: scopesDigestOf(approved.contract.lens_scopes),
  };
  const planned = planShards({
    files: rendering.files,
    owned: scopes.owned,
    skipped: scopes.skipped,
    derivation,
  });
  if (!planned.ok) {
    // FAIL BY MEASUREMENT (AC6). `planShards` composes the refusal because it did the
    // measuring; nothing is dispatched, nothing is recorded, and no file is cut down to size.
    return {
      transition,
      status: "refused",
      message:
        `discovery cannot be dispatched (${planned.reason}): ${planned.refusal} No shard plan was recorded and ` +
        `NO container was started.`,
    };
  }

  // (d) THE PLAN, BEFORE ANY CONTAINER STARTS.
  const write = recordShardPlan(reviewId, planned.plan);
  const plan = write.review.shardPlan as ShardPlan;
  for (const s of plan.skipped) {
    recordLensSkipped(reviewId, {
      lens: s.lens,
      reason: s.reason,
      derivationDigest: plan.digest,
      candidateSha: confirmedSha,
    });
  }

  // WHICH SHARDS STILL OWE AN OUTCOME, decided by the same assessor that decides whether
  // discovery completed. A shard already authored under THIS partition is not re-dispatched and
  // its outcome is never rewritten — that is what makes a re-entry after one crash preserve the
  // coverage that already happened (D7) instead of paying for it twice and risking losing it.
  const before = write.review;
  const outstanding = assessShardCompleteness(plan, ledgerOutcomes(before), {
    acceptances: lensAcceptancesOf(before),
    skips: lensSkipRecordsOf(before),
    candidateSha: confirmedSha,
  }).missing.filter((m) => m.shard !== undefined);

  const targets: ShardTarget[] = [];
  for (const miss of outstanding) {
    const shard = plan.lenses.find((l) => l.lens === miss.lens)?.shards.find((s) => s.index === miss.shard);
    if (shard === undefined) continue;
    targets.push({
      lens: miss.lens as RiskLens,
      shard,
      diff: shard.paths.map((p) => bodyOf.get(p)?.body ?? "").join(""),
    });
  }

  // (e) LENS x SHARD, BOUNDED. Read-only, against ONE recorded sha.
  const outcomes = await boundedFanout(targets, plan.fanoutWidth, async (t): Promise<LensOutcome> => {
    const identity: ShardIdentity = { index: t.shard.index, of: t.shard.of };
    const dispatch = await deps.dispatchLens({
      review: before,
      lens: t.lens,
      role: lensRole(t.lens),
      candidateSha: confirmedSha,
      contract: approved.contract,
      shard: identity,
      paths: [...t.shard.paths],
      diff: t.diff,
      derivationDigest: plan.digest,
    });
    // THE IDENTITY IS THE COORDINATOR'S, NOT THE SEAM'S. The host knows which shard it
    // dispatched; taking that fact back off the dispatch's return would let a seam — or a
    // reviewer whose output the seam echoes — claim to have reviewed a shard it did not.
    return assessLens({
      ...dispatch,
      lens: t.lens,
      role: lensRole(t.lens),
      shard: identity,
      derivationDigest: plan.digest,
    });
  });

  // (f) MERGE, not replace. The read is inside the write lock (mergeLensOutcomesByShard), which
  // is what preserves the operator acceptances, the agent_protocol receipts and the skip
  // records another process may have committed during the minutes this fan-out was awaited.
  const updated = mergeLensOutcomesByShard(reviewId, outcomes);
  const acceptances = lensAcceptancesOf(updated);
  const skips = lensSkipRecordsOf(updated);
  const recorded = ledgerOutcomes(updated);

  // (g) PER SHARD.
  const completeness = assessShardCompleteness(plan, recorded, {
    acceptances,
    skips,
    candidateSha: confirmedSha,
  });
  if (!completeness.complete) {
    // NOT completion. No stage record, no synthesized pass, no empty finding set — the panel is
    // incomplete and stays incomplete until the SHARD is retried, the contract is amended by its
    // approving authority, or the missing evidence is explicitly accepted against the named
    // lens AND shard.
    const named = completeness.missing.map(describeMiss);
    setReviewState(reviewId, "discovering", {
      reason: `discovery incomplete: ${completeness.missing
        .map((m) => `${shardLabel(m.lens, m.shard, m.of)} (${m.reason})`)
        .join(", ")}`,
    });
    return {
      transition,
      status: "refused",
      message:
        `discovery is INCOMPLETE — no reviewer-authored outcome for ${named.join("; ")}. ` +
        `Completeness is owed PER SHARD: one shard that came back never stands in for a shard that crashed and ` +
        `was never read. No pass and no empty finding set was synthesized. Retry the shard, amend the contract ` +
        `through its approving authority, or record an authorized acceptance naming that lens and shard ` +
        `(\`forge review accept-lens ${reviewId} <lens> --shard <n> --operator --missing-evidence "..." ` +
        `--rationale "..."\`).` +
        (completeness.superseded.length > 0
          ? ` ${completeness.superseded.length} recorded decision(s) describe a partition that no longer exists ` +
            `and satisfy nothing: ${completeness.superseded.map((s) => s.detail).join("; ")}.`
          : ""),
    };
  }

  // EVERY CURRENT SHARD'S EVIDENCE, from the LEDGER — not only the shards this pass dispatched.
  // A re-entry that retried one crashed shard completes the review on the outcomes of all of
  // them, and an outcome bound to a superseded partition contributes nothing.
  const current = recorded.filter((o) => o.derivationDigest === plan.digest);
  const normalized = normalizeObservations(collectObservations(current), { discoveredSha: confirmedSha });
  const ingested = ingestFindings(reviewId, normalized.observations);

  const authored = current.filter((o) => o.complete);
  const plannedShardCount = plan.lenses.reduce((n, l) => n + l.shards.length, 0);

  recordStageEvidence(reviewId, "discovery", {
    sha: confirmedSha,
    detail:
      `${authored.length} of ${plannedShardCount} planned shard(s) across ${plan.lenses.length} lens(es) authored ` +
      `an outcome` +
      (completeness.accepted.length > 0
        ? `, ${completeness.accepted
            .map((a) => shardLabel(a.lens, a.shard))
            .join(", ")} cleared by an authorized acceptance`
        : "") +
      (completeness.skipped.length > 0
        ? `, ${completeness.skipped.map((s) => s.lens).join(", ")} intentionally skipped (no in-scope path)`
        : "") +
      `; ${ingested.length} finding(s) ingested`,
    meta: {
      lenses: [...lenses],
      // FG-689: WHAT WAS OWED AND WHAT WAS DELIVERED, side by side. The plan is the durable
      // answer to "how many dispatches did this review expect"; restating the expectation here
      // is what lets a reader of the stage record see the two agreed at completion time.
      shardPlan: {
        digest: plan.digest,
        derivation: plan.derivation,
        fanoutWidth: plan.fanoutWidth,
        expected: plan.lenses.map((l) => ({ lens: l.lens, shards: l.shards.length })),
        dispatchedThisPass: targets.map((t) => ({ lens: t.lens, shard: t.shard.index, of: t.shard.of })),
        supersededPlan: write.previous?.digest,
      },
      outcomes: current.map((o) => ({
        lens: o.lens,
        shard: o.shard?.index,
        of: o.shard?.of,
        outcome: o.complete ? o.outcome : "incomplete",
      })),
      // FG-650: which lenses carried extra root keys the validator tolerated. Recorded so
      // tolerance is visible in the durable stage record rather than silently stripped.
      toleratedRootKeys: current
        .filter((o) => o.complete && (o.toleratedRootKeys?.length ?? 0) > 0)
        .map((o) => ({ lens: o.lens, shard: o.shard?.index, keys: o.complete ? o.toleratedRootKeys : [] })),
      // The stage record must not read as if an accepted shard was reviewed — the acceptance
      // and the evidence it names are part of what this stage completed on.
      acceptedLenses: completeness.accepted.map((a) => ({
        lens: a.lens,
        shard: a.shard,
        missingEvidence: a.missingEvidence,
      })),
      // ...and a SKIPPED lens is neither reviewed nor absent. Its own key, so no reader has to
      // infer a third state out of two lists.
      skippedLenses: completeness.skipped.map((s) => ({ lens: s.lens, reason: s.reason })),
      merges: normalized.merges,
      findingRefs: ingested.map((f) => f.findingRef),
    },
  });

  return {
    transition,
    status: "advanced",
    message:
      `discovery complete at ${confirmedSha}: ${ingested.length} finding(s) ingested from ${plannedShardCount} ` +
      `shard(s) across ${plan.lenses.length} lens(es)` +
      (completeness.skipped.length > 0
        ? ` (${completeness.skipped.map((s) => s.lens).join(", ")} intentionally skipped — no in-scope path)`
        : "") +
      (normalized.merges.length > 0 ? `, ${normalized.merges.length} deduplicated` : ""),
  };
}

/** The reviewer-authored half of `lens_outcomes_json`. Acceptances, protocol receipts and skip
 *  records are filtered out by the store accessor, so nothing that is not an outcome can arrive
 *  here as one. */
function ledgerOutcomes(review: Review): LensOutcome[] {
  return lensOutcomeRecordsOf(review) as LensOutcome[];
}

/** "wide shard 2 of 3", or "wide" for a lens with no shard identity to name. */
function shardLabel(lens: string, shard: number | undefined, of?: number): string {
  if (shard === undefined) return lens;
  return of === undefined ? `${lens} shard ${shard}` : `${lens} shard ${shard} of ${of}`;
}

function describeMiss(m: { lens: string; shard?: number; of?: number; reason: string; detail: string }): string {
  return `${shardLabel(m.lens, m.shard, m.of)} (${m.reason}: ${m.detail})`;
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
    // FG-654: recorded against the REVISION that was actually delivered, and recorded
    // BEFORE the ok/parse gates below — a fixer that ran under a protocol and then crashed
    // still ran under that protocol, and that is exactly the fact a later reader needs.
    if (dispatch.protocol && dispatch.taskId !== "") {
      recordAgentProtocol(review.id, {
        role: dispatch.protocol.role,
        sha256: dispatch.protocol.sha256,
        taskId: dispatch.taskId,
        stage: "fix_batch",
      });
    }
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

// FG-655: THE DOCS STAGE COMMITS WHAT THE DOCS AGENT DECLARED, and the candidate advances
// only to the sha the coordinator itself authored.
//
// This stage used to end with `const head = await deps.headSha(); advanceCandidate(...)` —
// the bare-HEAD read the fix cycle's own comment at :665 forbids in as many words. When the
// docs agent did not commit, that read was a guaranteed no-op: the stage reported "candidate
// unchanged at <sha>" and ADVANCED, which is a true statement about HEAD and a false one
// about the work, and the work sat in the worktree. Downstream, final verification silently
// degraded to a dirty-tree local run, and committing the stranded edits by hand moved HEAD
// while the ledger candidate stayed put — so the next stage refused
// `candidate_not_checked_out` and the review could only proceed by DISCARDING the docs work.
// Documentation asserting the opposite of shipped behaviour reached the tree that way, and
// one stranded fragment was lost outright.
//
// THE ORDER BELOW IS THE CORRECTNESS ARGUMENT, not a style:
//   (a) the re-entry short-circuit consults the DURABLE BINDING before the decision to
//       dispatch — a short-circuit evaluated after dispatch has been called is a second
//       container plus an apology;
//   (b) dispatch only when no live binding exists;
//   (c) read the agent's own declaration off its durable task record;
//   (d) commit ONLY the declared paths;
//   (e) advance through `advanceCandidate` and only to a sha the commit reports the
//       coordinator authored or recognized, so the invalidation at :665 fires by construction
//       and the per-sha stage rules need no new key;
//   (f) record the stage, then retire the spent binding.
//
// THE RECORD'S SHA IS THE POST-ADVANCE ONE, unlike the fix stage's. Stage 6 selection is
// per-sha (review-coordinator.ts), so a record at the pre-docs candidate leaves the stage
// incomplete at the new one and the review loops on its own docs stage. The fix stage is
// exempt only because its completeness is decided per finding by ingested-batch membership,
// and docs has no such per-item ledger to appeal to.
async function runDocs(reviewId: string, transition: Transition, deps: CoordinatorDeps): Promise<StageOutcome> {
  const review = getReview(reviewId) as Review;
  const candidateBefore = review.candidateSha as string;

  // Every refusal past this point puts the state back, exactly as Stage 5's does (FG-649
  // RF-1): a row parked in `documenting` for a stage that recorded nothing tells an operator
  // a docs agent is running when none is.
  const stateBefore = review.state;
  const refuse = (message: string): StageOutcome => {
    if (stateBefore !== "documenting") {
      setReviewState(reviewId, stateBefore, {
        reason: `stage 6 refused with nothing recorded; the row returns to ${stateBefore}`,
      });
    }
    return { transition, status: "refused", message };
  };
  const reEnter = `Resolve the named condition and re-run \`forge review continue ${reviewId}\`; the docs dispatch stays bound, so no second documentation-maintainer is started.`;

  // FG-655 RF-2: the dispatch is STILL IN FLIGHT. Named separately from a dead delivery
  // because the two authorise opposite things: a dead one over a clean tree may be retired, a
  // live one may not be — a clean tree cannot distinguish an agent that left nothing behind
  // from one that has not written yet. The binding is never retired here, so no second
  // maintainer is dispatched while the first container may still be writing.
  const inFlight = (bindingId: string, delivery: { taskId: string; status: string; detail: string }): string =>
    `docs_dispatch_in_flight: ${delivery.detail} — the docs dispatch ${bindingId} bound task ${delivery.taskId}, ` +
    `which is ${delivery.status}, so a documentation-maintainer may still be writing into this checkout. Nothing ` +
    `was recorded, the candidate stays at ${candidateBefore}, and NO second docs agent is started. Confirm what ` +
    `that task is doing with \`forge show ${delivery.taskId}\`; if its container is gone, \`forge cancel ` +
    `${delivery.taskId}\` marks it failed, and a failed delivery over a clean tree at ${candidateBefore} is what ` +
    `lets the next pass retire the dead dispatch and run ONE more docs agent. ${reEnter}`;

  setReviewState(reviewId, "documenting", { reason: transition.reason });

  // (a) THE RE-ENTRY SHORT-CIRCUIT, BEFORE THE DISPATCH DECISION.
  let binding = pendingDocsDispatch(reviewId);
  let dispatchedNow = false;
  // The declaration this pass already read, so the re-entry probe and the commit below cannot
  // be looking at two different reads of the same durable record.
  let known: DocsDelivery | undefined;

  if (binding !== undefined) {
    const delivery = await deps.docsDelivery({ review, binding });
    known = delivery;
    if (delivery.kind === "in_flight") return refuse(inFlight(binding.id, delivery));
    if (delivery.kind === "unreadable") {
      // A DEAD delivery — absent, unparseable, or terminally failed. The remedy is NOT a new
      // operator verb: a CLEAN TREE AT THE CANDIDATE is provable evidence the dead
      // delivery's edits are gone, and that is what authorises retiring a spent binding and
      // dispatching once more. The probe is `commitDocsCycle` against an EMPTY declaration —
      // deliberately the same predicate the commit path uses rather than a second, weaker
      // clean-tree test that could disagree with it.
      const probe = await deps.commitDocsCycle({ review, binding, declaredFiles: [] });
      if (probe.kind !== "no_change") {
        const named =
          probe.kind === "refused"
            ? `${probe.reason}: ${probe.detail}`
            : `docs_cycle_commit_raced: ${probe.sha} carries this docs cycle's subject, but the delivery that ` +
              `authorised its scope cannot be read, so its paths cannot be reconciled against any declaration`;
        return refuse(
          `${named} — and the docs delivery for ${binding.id} could not be read (${delivery.detail}), so the ` +
            `stage cannot tell what that agent claims it changed. Nothing was recorded and the candidate stays ` +
            `at ${candidateBefore}. Restore the checkout to ${candidateBefore} with a clean tree (\`git stash\` ` +
            `the uncommitted work you want to keep, or \`git reset --soft ${candidateBefore}\` if the docs agent ` +
            `committed) — a clean tree at the candidate is what lets the next pass retire the dead dispatch and ` +
            `run ONE more docs agent. ${reEnter}`,
        );
      }
      retireDocsDispatch(
        binding.id,
        `the delivery could not be read (${delivery.detail}) and the checkout is clean at ${candidateBefore}, ` +
          `so the dead dispatch left nothing behind`,
      );
      binding = undefined;
      known = undefined;
    }
  }

  // (b) DISPATCH ONLY IF NO LIVE BINDING EXISTS.
  if (binding === undefined) {
    const result = await deps.dispatchDocs({ review, candidateSha: candidateBefore });
    dispatchedNow = true;
    binding = result.binding;
    // FG-654: recorded BEFORE the ok gate, for the same reason the fixer's is — an agent
    // that ran and then failed still ran under that protocol.
    if (result.protocol) recordAgentProtocol(review.id, { ...result.protocol, stage: "docs" });
    if (!result.ok) {
      return refuse(
        `docs reconciliation failed (${result.error ?? "no error recorded"}) — nothing was recorded, the candidate ` +
          `stays at ${candidateBefore}, and the dispatch stays bound as ${binding.id}. ${reEnter}`,
      );
    }
  }

  // (c) THE AGENT'S OWN DECLARATION, off the durable task record. One read for the pass that
  // dispatched and the pass recovering from a crash, so the commit's scope cannot depend on
  // which pass is asking.
  const delivery = known ?? (await deps.docsDelivery({ review, binding }));
  if (delivery.kind === "in_flight") return refuse(inFlight(binding.id, delivery));
  if (delivery.kind === "unreadable") {
    return refuse(
      `docs_cycle_declared_changes_absent: the docs dispatch ${binding.id} produced no readable declaration ` +
        `(${delivery.detail}), so the coordinator cannot know which paths it may commit — and the worktree is ` +
        `never a source of scope. Nothing was recorded and the candidate stays at ${candidateBefore}. ${reEnter}`,
    );
  }

  const declaredFiles = [...new Set(delivery.docsUpdated.map((p) => p.replace(/^\.\//, "").trim()).filter((p) => p !== ""))].sort();

  // (d) COMMIT ONLY THE DECLARED PATHS. The same reconciliation the fix cycle runs, in both
  // directions: a tree that moved beyond the declaration is a stop that NAMES the undeclared
  // paths, and a declaration that reaches beyond the tree commits what moved and names what
  // did not. An EMPTY declaration is the no-op CLAIM, and this is where it is adjudicated
  // against the tree — a clean tree is the legitimate no-op (AC2), a dirty one is the
  // stranding shape this ticket exists to name.
  const commit = await deps.commitDocsCycle({ review, binding, declaredFiles });
  if (commit.kind === "refused") {
    // FG-655 RF-1: A REFUSAL AT A CLEAN TREE MUST NOT WEDGE THE REVIEW. The declaration is
    // read off the IMMUTABLE task record every pass, so a refusal that leaves the binding
    // live reproduces itself verbatim on every subsequent `forge review continue` — no
    // operator verb can change what that agent declared. `treeCleanAtCandidate` is set only
    // where the committer proved HEAD is the candidate AND the worktree is wholly clean,
    // which is the SAME evidence the dead-delivery arm above retires on: nothing of this
    // delivery is present in the worktree, so retiring the spent binding strands nothing.
    // Every refusal that cannot prove that — a dirty tree, a foreign head — leaves the
    // binding live, so the "no second docs agent while work may be stranded" guarantee is
    // untouched.
    if (commit.treeCleanAtCandidate === true) {
      retireDocsDispatch(
        binding.id,
        `${commit.reason}: the declaration (${declaredFiles.join(", ") || "nothing"}) contradicts a clean tree at ` +
          `${candidateBefore}, so the spent dispatch left nothing behind`,
      );
      return refuse(
        `${commit.reason}: ${commit.detail} — the docs stage recorded NOTHING and the candidate stays at ` +
          `${candidateBefore}. The spent dispatch ${binding.id} is RETIRED (a clean tree at the candidate is ` +
          `provable evidence it left nothing behind), so \`forge review continue ${reviewId}\` runs exactly ONE ` +
          `more documentation-maintainer rather than reproducing this refusal.`,
      );
    }
    return refuse(
      `${commit.reason}: ${commit.detail} — the docs stage recorded NOTHING, the candidate stays at ` +
        `${candidateBefore}, and the dispatch stays bound as ${binding.id}. ${reEnter}`,
    );
  }

  // (e) THE CANDIDATE MOVES ONLY TO A SHA THE COORDINATOR AUTHORED OR RECOGNIZED, through
  // the one place it moves at all.
  const candidateAfter = commit.kind === "committed" ? commit.sha : candidateBefore;
  if (commit.kind === "committed") advanceCandidate(reviewId, commit.sha);

  // (f) The record, at the POST-advance sha, then the spent binding.
  const detail =
    commit.kind === "committed"
      ? (commit.recognized === true
          ? `the docs cycle's commit ${commit.sha} (${commit.committedPaths.length} path(s)) was authored by an ` +
            `earlier pass that crashed before recording it, and was RECOVERED rather than re-authored`
          : `docs moved the candidate ${candidateBefore} → ${commit.sha}; the coordinator committed ` +
            `${commit.committedPaths.length} declared path(s)`) +
        (commit.declaredNotMoved !== undefined
          ? `; the agent DECLARED ${commit.declaredNotMoved.join(", ")}, which the worktree never moved`
          : "")
      : `docs reconciliation changed nothing and left a clean tree — the candidate stays at ${candidateBefore}`;

  recordStageEvidence(reviewId, "docs", {
    sha: candidateAfter,
    detail,
    meta: {
      docsDispatchId: binding.id,
      taskId: delivery.taskId,
      resumedFromBinding: !dispatchedNow,
      candidateAfter,
      declaredFiles,
      docsCommit: {
        kind: commit.kind,
        sha: commit.sha,
        committedPaths: commit.kind === "committed" ? commit.committedPaths : [],
        recognized: commit.kind === "committed" && commit.recognized === true,
        declaredNotMoved: commit.kind === "committed" ? (commit.declaredNotMoved ?? []) : [],
      },
    },
  });
  retireDocsDispatch(binding.id, `stage 6 completed at ${candidateAfter}`);

  return {
    transition,
    status: "advanced",
    message:
      commit.kind === "committed"
        ? `docs reconciliation moved the candidate ${candidateBefore} → ${commit.sha}; the coordinator committed ` +
          `${commit.committedPaths.length} declared path(s) and final verification and recheck now bind to the ` +
          `post-docs candidate` +
          (commit.declaredNotMoved !== undefined
            ? `. NOTE: the docs agent declared ${commit.declaredNotMoved.join(", ")}, which the worktree never moved ` +
              `— the commit carries only what did`
            : "")
        : `docs reconciliation complete; the docs agent changed nothing, the tree is clean, and the candidate is ` +
          `unchanged at ${candidateBefore}`,
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

  // FG-689: the remediation delta comes from the SAME pinned seam, over the confirmed sha and
  // the current candidate. Not because the rechecker needs the coverage guarantee — it does
  // not — but because a second unpinned `git diff` in this module is the seam that grows back.
  //
  // A refusal REFUSES THE STAGE. The old `deps.diff` threw on a git failure and the throw
  // escaped the coordinator; the one thing that must not happen instead is a rechecker handed a
  // placeholder for the delta it is supposed to be verifying against.
  const renderedDelta = await deps.reviewDiff(confirmedSha, candidate);
  if (!renderedDelta.ok) {
    return {
      transition,
      status: "refused",
      message:
        `the remediation delta ${confirmedSha}..${candidate} could not be rendered (${renderedDelta.reason}): ` +
        `${renderedDelta.refusal} No rechecker was dispatched, no resolution was inferred and every finding stays ` +
        `exactly as it was.`,
    };
  }

  const dispatch = await deps.dispatchRechecker({
    review,
    candidateSha: candidate,
    confirmedSha,
    expected,
    fixerEvidence,
    delta: renderingText(renderedDelta.rendering),
    contract: approved.ok ? approved.contract : review.contract,
    lensInstructions,
  });

  if (dispatch.protocol) recordAgentProtocol(review.id, { ...dispatch.protocol, stage: "recheck" });
  if (!dispatch.ok) {
    // FG-664: AN ENVIRONMENT FAULT IS A STOP, NOT A VERDICT AND NOT A RETRY.
    //
    // The host refused this dispatch because it could not give the rechecker the
    // project's REAL native dependencies (spawn.ts's dependency probe, run before
    // any agent container). It is the same plane Stage 1 already uses for a
    // non-runnable candidate: no fixer is dispatched, no review cycle is consumed,
    // and NOTHING is recorded as still present or resolved. Deliberately NOT the
    // `refused` arm below — that arm re-enters and re-dispatches, which against an
    // environment fault would burn rounds on a failure no code change can fix
    // (the error FG-566 already fixed once for the host lane).
    if (dispatch.failureKind === "verification_environment_unavailable") {
      const reason = `the recheck lane could not execute the project's real dependencies: ${dispatch.error ?? "no detail recorded"}`;
      setReviewState(reviewId, "blocked_environment", { reason });
      return {
        transition,
        status: "stopped",
        message:
          `blocked_environment (verification_environment_unavailable): ${dispatch.error ?? "no detail recorded"}. ` +
          `No fixer was dispatched and no review cycle was consumed; no finding was recorded as still present and ` +
          `no resolution was written. Fix the environment and re-run \`forge review continue ${reviewId}\`.`,
      };
    }
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

  // FG-664: THE SAME STOP, ONE LAYER IN — a lane that RAN but DECLARED it could not
  // execute the cited coverage. `blocked_environment` coverage is by construction
  // never green and never resolved (review-evidence.ts's COVERAGE_OUTCOMES), so a
  // recheck carrying any of it is not evidence about the code in either direction:
  // its `still_present` entries are not findings and its `resolved` entries are not
  // proofs. The whole stage stops with NOTHING written — not the resolutions, not
  // the new findings, not the stage record — so re-entry is a clean re-dispatch once
  // the environment is repaired.
  //
  // CEILING, stated so it is not later mistaken for a guarantee: this closes the case
  // where the lane DECLARES it could not run. It cannot detect a substituted engine
  // that produces plausible `not ok` lines — those are textually indistinguishable
  // from a real regression, and no ingestion-side rule can authenticate the engine
  // that emitted them. That is the host-side probe's job, before the container starts.
  const blocked = ingestion.applications.filter((a) => a.coverage === "blocked_environment");
  if (blocked.length > 0) {
    const refs = blocked.map((a) => a.findingRef).join(", ");
    const reason = `the rechecker reported blocked_environment coverage for ${refs}`;
    setReviewState(reviewId, "blocked_environment", { reason });
    return {
      transition,
      status: "stopped",
      message:
        `blocked_environment: the rechecker declared it could not execute the coverage it cited for ${refs}. ` +
        `No resolution, no finding and no stage record was written — a lane that could not run is not evidence ` +
        `that a finding is present OR absent. No fixer was dispatched and no review cycle was consumed.`,
    };
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
      toleratedRootKeys: ingestion.toleratedRootKeys,
      // Half of this stage's completion key: the fix cycles this recheck covered. Without it
      // a later cycle at the same sha reads as already rechecked (see fixCycleKey).
      fixCycleKey: fixCycleKey(snap.batches),
      // FG-664 / AC3: WHICH ENGINE PRODUCED THESE RESOLUTIONS. The receipt is read
      // back off the rechecker's own task manifest, so the ledger INDEXES the
      // manifest rather than restating it — one fact in two places. Absent when the
      // dispatch resolved no environment (a read-write or not-applicable configuration).
      ...(dispatch.dependencyEnvironment !== undefined
        ? { dependencyEnvironment: dispatch.dependencyEnvironment }
        : {}),
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

  // FG-655 AC4: THE ENVIRONMENT FAULT IS READ FIRST, through the SAME classifier Stages
  // 1 and 7 use — Stage 9 is the lifecycle's second verification reader and the two must speak
  // one vocabulary. A workspace that could not be verified at the candidate means verification
  // COULD NOT RUN, which is the `blocked_environment` stop: no cycle consumed, nobody
  // dispatched, nothing recorded. Reading it as an ordinary not-ok verification instead says
  // the WORK failed review, and can send a fixer to remediate a dirty tree.
  const verdict = classifyVerification({ ...input.verification, sha: input.verification.sha ?? candidate });
  if (verdict.kind === "blocked_environment") {
    setReviewState(reviewId, "blocked_environment", { reason: `${verdict.reason}: ${verdict.message}` });
    return {
      transition,
      status: "stopped",
      message:
        `blocked_environment (${verdict.reason}): ${verdict.message}. The shipping review did not run: nothing was ` +
        `recorded, no reviewer or fixer was dispatched, and no review cycle was consumed.`,
    };
  }

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
