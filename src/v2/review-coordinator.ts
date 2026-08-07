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
import { lensAcceptancesOf, lensOutcomeRecordsOf, lensSkipRecordsOf, stageCompleteAt } from "../store/reviews.js";
import { assessShardCompleteness, planCoversLenses, type LensOutcome } from "./review-discovery.js";
import { recheckIsNoOp } from "./review-recheck.js";
import { RISK_LENSES, validateReviewContract, type RiskLens } from "./review-contract.js";

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
  return lensOutcomeRecordsOf(review) as LensOutcome[];
}

/** A plan is read back off a durable row, so the lens names it carries are strings. A name
 *  outside the vocabulary is REPORTED by the assessor and simply not offered here as a lens to
 *  retry — narrowing it away with a cast would make it disappear from both. */
function isRiskLens(lens: string): lens is RiskLens {
  return (RISK_LENSES as readonly string[]).includes(lens);
}

/** Did this batch's payload carry this finding under the decision it carries NOW?
 *
 *  Per finding rather than per set, and that is the load-bearing choice. Scenario #5 removes
 *  a finding from the fix_now set mid-cycle (the fixer reports it scope-changing, so it
 *  becomes an architecture question): the remaining four were still fixed, and a whole-set
 *  comparison would read the shrunken set as "never fixed" and dispatch a second fixer over
 *  work already done. Containment says the right thing in both directions — a finding ADDED
 *  to fix_now, or RE-DECIDED (a new decidedAt or a new rationale), is not covered. Before
 *  Stage 5 completes that may require a replacement revision; afterwards the review-wide
 *  cardinality guard stops it at disposition. */
function batchCarriesDecision(b: FixBatch, f: ReviewFinding): boolean {
  return b.payload.findings.some(
    (m) =>
      m.finding_id === f.id &&
      m.decided_at === (f.decidedAt ?? undefined) &&
      m.disposition_rationale === (f.dispositionRationale ?? ""),
  );
}

/** Has an INGESTED batch already carried this finding, under the decision it carries now?
 *  Stage 5's question: is there anything left for a fixer to do. */
function decisionCoveredByIngestedBatch(batches: readonly FixBatch[], f: ReviewFinding): boolean {
  return batches.some((b) => b.state === "ingested" && batchCarriesDecision(b, f));
}

/** Was this finding's CURRENT decision carried by the remediation cycle the latest recheck
 *  covered? An unresolved verdict only blocks under the decision it adjudicated. A later
 *  re-decision falls through to Stage 5, where the completed-cycle guard produces the
 *  explicit follow-up stop instead of dispatching another fixer. The cycle-key lookup also
 *  preserves correct reads for reviews written before the one-cycle boundary existed. */
function decisionCoveredByRecheckedCycle(review: Review, batches: readonly FixBatch[], f: ReviewFinding): boolean {
  const covered = new Set(cycleTerms(recheckedFixCycleKey(review)));
  return batches.some((b) => covered.has(`${b.id}@${b.revision}`) && batchCarriesDecision(b, f));
}

/** FG-649 (change 3 / RF-8): THE UNRESOLVED fix_now SET — the ONE definition of what a fix
 *  batch is for, shared by the predicate that SELECTS Stage 5 and the filter that BUILDS its
 *  payload. Two separate definitions is how a finding that was already proven fixed got
 *  re-dispatched to a fixer, and how the same batch could then clear the very resolution that
 *  proved it (the fix-cycle invalidation is scoped to batch membership, so non-membership is
 *  what preserves it — there is deliberately no third invalidation authority and no
 *  per-finding preserve flag).
 *
 *  EVALUATED AGAINST A NAMED SHA, never "now". A resolution is candidate-BOUND, and the fix
 *  stage itself advances the candidate, so "resolved" has to mean "resolved at the sha this
 *  batch is being built for". A resolution proven at an earlier candidate is not evidence
 *  about this one — `invalidateResolutionsForCandidate` already clears it when the candidate
 *  moves, and this predicate agrees with that rule rather than restating it loosely. */
export function unresolvedFixNow(
  findings: readonly ReviewFinding[],
  candidateSha: string | undefined,
): ReviewFinding[] {
  return fixNowFindings(findings).filter(
    (f) =>
      !(
        f.resolution === "resolved" &&
        f.resolvedSha !== undefined &&
        candidateSha !== undefined &&
        f.resolvedSha === candidateSha
      ),
  );
}

/** FG-649 (change 1): A FIX CYCLE THAT INGESTED BUT WAS NEVER RECORDED IS NOT COMPLETE.
 *
 *  Stage 5 now owns the fix-cycle COMMIT (the coordinator authors it; see runBatchFix), and a
 *  stage records itself only on success — so a crash, or a refused commit, can leave a batch
 *  `ingested` with no fix stage record naming it. Coverage alone would read that as satisfied
 *  and walk on to docs at the PRE-fix candidate, which is the FG-649 loop with extra steps:
 *  the fixes exist in the worktree, the candidate never moves, and the rechecker examines a
 *  tree without them.
 *
 *  Keyed per CYCLE (batch id AND revision) rather than per sha, because the fix record's own
 *  sha is deliberately the pre-fix candidate and a second cycle at an unmoved candidate must
 *  earn its own commit+record. At most one batch is ever in `ingested` — `ensureFixBatch`
 *  supersedes the previous one — so the LATEST batch is the only one that can be outstanding. */
export function fixCycleAwaitingRecord(snapshot: ReviewSnapshot): FixBatch | undefined {
  const latest = snapshot.batches[snapshot.batches.length - 1];
  if (latest === undefined || latest.state !== "ingested") return undefined;
  const meta = snapshot.review.stageEvidence?.fix?.meta;
  const recorded = meta?.["fixBatchId"] === latest.id && meta?.["revision"] === latest.revision;
  return recorded ? undefined : latest;
}

/** Stage 5 is satisfied when every UNRESOLVED fix_now finding was carried by an ingested batch
 *  under its current decision, AND no ingested cycle is still waiting to be committed and
 *  recorded. The fix stage's own record cannot be checked with `stageCompleteAt` — the fix
 *  cycle's commit moves the candidate, so its sha is deliberately the PRE-fix one. */
function fixStageSatisfied(snapshot: ReviewSnapshot): boolean {
  if (fixCycleAwaitingRecord(snapshot) !== undefined) return false;
  return unresolvedFixNow(snapshot.findings, snapshot.review.candidateSha).every((f) =>
    decisionCoveredByIngestedBatch(snapshot.batches, f),
  );
}

/** Has this review's single remediation window closed?
 *
 *  A fix stage record is the normal durable cardinality boundary. Batch rows alone cannot be
 *  that boundary: an `open` or `dispatched` row may be retried after an infrastructure
 *  failure, and an `ingested` row may still need the coordinator to recover its commit and
 *  record the SAME cycle. Once Stage 5 records success, however, this review has consumed
 *  its one batch. A changed rationale, a still-present finding, or a finding discovered by
 *  the bounded delta recheck belongs to explicit follow-up work, not revision n+1 inside
 *  the review.
 *
 *  Recheck is the other boundary. A review with no initial fix_now findings legitimately
 *  skips Stage 5, but once Stage 8 has run it must not turn a late finding into a first batch
 *  and thereby create a second docs / verification / recheck pass.
 */
function closedRemediationWindow(
  review: Review,
): { kind: "fix"; id?: string; revision?: number } | { kind: "recheck_without_fix" } | undefined {
  const record = review.stageEvidence?.fix;
  if (record !== undefined) {
    const id = typeof record.meta?.["fixBatchId"] === "string" ? record.meta["fixBatchId"] : undefined;
    const revision = typeof record.meta?.["revision"] === "number" ? record.meta["revision"] : undefined;
    return { kind: "fix", id, revision };
  }
  if (review.stageEvidence?.recheck !== undefined) return { kind: "recheck_without_fix" };
  return undefined;
}

/** Findings that hold the review at Stage 4.
 *
 *  TWO shapes, and the second is scenario #6: a `fix_now` whose recheck came back
 *  `still_present` or `inconclusive` AND whose decision that RECHECKED cycle already
 *  consumed. The review returns to disposition and no fixer is dispatched automatically —
 *  re-running the fixer on a decision that demonstrably did not resolve it is exactly the
 *  loop this lifecycle replaced. Re-dispositioning the finding does not create another fix
 *  cycle: Stage 5's review-wide remediation-window guard below stops after one completed
 *  batch, or after recheck when no batch was needed.
 *
 *  AN ARCHITECTURE QUESTION IS DELIBERATELY NOT ONE OF THESE. It leaves the review
 *  UNSETTLED — Stage 9's findings_settled check refuses it, and `awaitingAuthority` reports
 *  it on every transition — but it does not stop the mechanical remainder of the cycle.
 *  Scenario #5 is why: when a fixer resolves four findings and reports the fifth as
 *  scope-changing, the FOUR proceed to recheck and the fifth goes to the operator. Blocking
 *  the whole cycle on the fifth would throw away the evidence the other four are entitled
 *  to, and would do it while the review still could not settle either way. */
function dispositionBlockers(snapshot: ReviewSnapshot): ReviewFinding[] {
  const { review, findings, batches } = snapshot;
  const out: ReviewFinding[] = [];
  for (const f of findings) {
    if (f.disposition === "untriaged") {
      out.push(f);
      continue;
    }
    if (f.disposition !== "fix_now") continue;
    if (f.resolution !== "still_present" && f.resolution !== "inconclusive") continue;
    if (decisionCoveredByRecheckedCycle(review, batches, f)) out.push(f);
  }
  return out;
}

/** THE FIX-BATCH REVISIONS A RECHECK COVERED — the second half of Stage 8's completion key.
 *
 *  The review now completes at most one remediation cycle, but that cycle can still have
 *  replacement revisions before Stage 5 completes, and older persisted reviews may already
 *  contain multiple completed revisions. Counting `superseded` alongside `ingested` keeps
 *  the key monotone across both cases: superseding a revision cannot shrink the recorded
 *  scope and accidentally re-open a completed recheck. The key supports recovery and legacy
 *  compatibility; it is not authority to start another cycle after the fix stage record
 *  exists. */
export function fixCycleKey(batches: readonly FixBatch[]): string {
  return batches
    .filter((b) => b.state === "ingested" || b.state === "superseded")
    .map((b) => `${b.id}@${b.revision}`)
    .join(",");
}

function cycleTerms(key: string): string[] {
  return key.split(",").filter((t) => t !== "");
}

function recheckedFixCycleKey(review: Review): string {
  const recorded = review.stageEvidence?.recheck?.meta?.fixCycleKey;
  return typeof recorded === "string" ? recorded : "";
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
  //
  // FG-689: NO RECORDED SHARD PLAN IS NOT COMPLETENESS, it is discovery that has not planned
  // yet. The plan is written before the first container starts, so its absence means either
  // nothing has been dispatched or the pass that would have dispatched refused — and both of
  // those re-enter this stage. There is deliberately no arm that assesses completeness without
  // a plan: with nothing recorded as owed, an empty ledger is trivially complete, which is the
  // fail-open per-shard completeness exists to close.
  const lenses = selectedLenses(review);
  const plan = review.shardPlan;
  // A plan that does not name every selected lens is not a plan for THIS panel — the assessor
  // iterates the plan, so a lens it never named is owed nothing and would read complete. Both
  // it and an absent plan re-enter discovery, which re-plans from the contract in force.
  const planned = plan !== undefined && planCoversLenses(plan, lenses).ok ? plan : undefined;
  const completeness =
    planned === undefined
      ? undefined
      : assessShardCompleteness(planned, recordedLensOutcomes(review), {
          acceptances: lensAcceptancesOf(review),
          skips: lensSkipRecordsOf(review),
          candidateSha: review.contractConfirmedSha,
        });
  const discoveryRecorded = stageCompleteAt(review, "discovery", review.contractConfirmedSha);
  if (completeness === undefined || !discoveryRecorded || !completeness.complete) {
    const pending = (completeness?.missing ?? []).map((m) => m.lens).filter(isRiskLens);
    return {
      kind: "discover",
      state: "discovering",
      stage: "discovery",
      pendingLenses: [...new Set(completeness === undefined ? lenses : pending)],
      reason:
        completeness === undefined
          ? plan === undefined
            ? `discovery has recorded no shard plan for the confirmed sha ${review.contractConfirmedSha}, so nothing ` +
              `is yet recorded as owed${lenses.length > 0 ? ` for ${lenses.join(", ")}` : ""}`
            : `the recorded shard plan does not describe the panel this contract selects ` +
              `(${lenses.join(", ") || "none"}), so what discovery owes has to be re-derived`
          : !completeness.complete
            ? `discovery is incomplete: ${completeness.missing
                .map((m) => `${m.lens}${m.shard !== undefined ? ` shard ${m.shard} of ${m.of}` : ""} (${m.reason})`)
                .join(", ")}`
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
    // The UNRESOLVED ones — the set a fixer would actually be handed (FG-649 change 3).
    const unresolved = unresolvedFixNow(findings, candidate);
    const outstanding = fixCycleAwaitingRecord(snapshot);
    const closed = closedRemediationWindow(review);

    // ONE REVIEW, ONE REMEDIATION BATCH. Recovery of an ingested-but-unrecorded cycle is
    // allowed above this boundary because it resumes the SAME work and dispatches no fixer.
    // Once a fix stage has completed, a changed decision or a late finding must not mint a
    // second batch revision. That was the semantic loophole behind the review loop: Stage 8
    // said "return to disposition, no automatic fixer", but a fresh disposition made Stage 5
    // automatically dispatch revision n+1 anyway.
    if (outstanding === undefined && closed !== undefined) {
      const boundary =
        closed.kind === "fix"
          ? `the review has already completed its single remediation cycle (` +
            (closed.id !== undefined
              ? `fix batch ${closed.id}${closed.revision !== undefined ? ` revision ${closed.revision}` : ""}`
              : "its fix batch") +
            ")"
          : "the review has already completed recheck without needing a remediation batch, closing its single remediation window";
      const scope =
        closed.kind === "fix" ? "are outside that immutable batch" : "arrived after that remediation boundary";
      return {
        kind: "await_disposition",
        state: "awaiting_disposition",
        blockingFindings: unresolved.map((f) => f.findingRef),
        reason:
          `${boundary}; ` +
          `${unresolved.length} unresolved fix_now finding(s) ${scope}: ` +
          `${unresolved.map((f) => f.findingRef).join(", ")}. This review will not dispatch another fixer or ` +
          `recheck cycle. Disposition the remaining finding(s) without fix_now and open follow-up work for ` +
          `any remediation still required.`,
      };
    }

    return {
      kind: "batch_fix",
      state: "fixing",
      stage: "fix",
      reason:
        outstanding !== undefined
          ? `fix batch ${outstanding.id} revision ${outstanding.revision} has ingested results that are not ` +
            `committed and recorded yet — the fix cycle completes by recording the post-fix candidate`
          : `${unresolved.length} unresolved fix_now finding(s) go to ONE fixer in one batch` +
            (unresolved.length < fixNow.length
              ? ` (${fixNow.length - unresolved.length} already resolved at ${candidate ?? "(unset)"} and not re-dispatched)`
              : ""),
      blockingFindings: unresolved.map((f) => f.findingRef),
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

  // Stage 8 — exact recheck + bounded remediation-delta review. Complete for the candidate
  // AND for the fix cycles that have run at it (see fixCycleKey).
  const cycleKey = fixCycleKey(snapshot.batches);
  const recheckedKey = recheckedFixCycleKey(review);
  const recheckedAtCandidate = stageCompleteAt(review, "recheck", candidate);
  if (!recheckedAtCandidate || recheckedKey !== cycleKey) {
    const noop = recheckIsNoOp({
      fixNowCount: fixNow.length,
      contractConfirmedSha: review.contractConfirmedSha,
      candidateSha: candidate,
    });
    // The cycles ADDED since the recorded recheck, not "now <whole key>". The key is monotone
    // (see fixCycleKey) so there is always at least one, and the old phrasing rendered the
    // shrink case as "now no batch" — reporting a WITHDRAWN cycle as a further one that ran.
    const newCycles = cycleTerms(cycleKey).filter((t) => !cycleTerms(recheckedKey).includes(t));
    return {
      kind: "recheck",
      state: "rechecking",
      stage: "recheck",
      reason: recheckedAtCandidate
        ? `a further fix cycle ran at candidate ${candidate ?? "(unset)"} since the last recheck ` +
          `(rechecked ${recheckedKey || "no batch"}; new cycle(s) ${newCycles.join(", ")}) — a new fix cycle ` +
          `needs its own recheck even though the candidate did not move`
        : noop
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
      reason: `the shipping review's eight checks have not run at candidate ${candidate ?? "(unset)"}`,
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
