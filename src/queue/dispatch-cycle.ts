// FG-591 (step 6): ONE EVALUATION PASS, AND THE REFILL LOOP OVER IT.
//
// This module DECIDES. It does not launch, does not heartbeat, does not own a
// process and does not sleep. Composing the pieces steps 2, 3 and 4 shipped:
//
//   dispatcher-policy    — is dispatch armed, what is the ceiling, in which scope,
//                          on what lease TTL. An ADMISSION test consulted BEFORE any
//                          claim, never process lifecycle (D5).
//   compatibility        — the READ (hydrateActiveRunFacts) and the PURE predicate
//                          closed over it (makeCompatibilityPredicate).
//   queue-claims         — the shipped atomic claimNextEligible. Not reimplemented,
//                          not wrapped in an alternative, not second-guessed.
//   dispatcher-evidence  — recordEvaluation, called on EVERY outcome.
//
// ─── WHY EVERY PASS WRITES A ROW ─────────────────────────────────────────────
// claimNextEligible persists its scan evidence only on a GRANT — queue-claims says
// so in its own header, and the three refusals leave that table byte-identical.
// That is the operator blindness FG-591 exists to close: an idle queue with no
// durable answer to "why did nothing start" is indistinguishable from a dispatcher
// that never ran. So every pass through this module — grant, disabled, no_capacity,
// no_eligible_work, incompatible_only and each bounded `lost` re-scan — persists
// exactly one dispatcher_evaluations row carrying the top-level reason AND the full
// per-candidate ScanEntry list the primitive returned. The per-candidate reasons are
// queue-claims' vocabulary verbatim; no second vocabulary is introduced here.
//
// ─── WHAT THIS MODULE NEVER DOES ─────────────────────────────────────────────
//  * It never mutates a rank. Bypassing an incompatible or ineligible candidate
//    leaves its priority_rank exactly as the operator set it — enforced by this
//    module importing no rank writer at all, and asserted byte-for-byte by the test.
//  * It never writes blocker_evidence. A temporary scheduling incompatibility is
//    per-evaluation evidence that evaporates when the active set moves;
//    blocker_evidence is durable, per-ticket and partly CONTAINER-VISIBLE through
//    blocked-source.ts, and it drives the Blocked projection. A scheduling wait
//    written there would silently reinterpret the ticket's status for every agent
//    container on the next publish. The two are kept apart by this module having no
//    import that could reach that table.
//  * It never re-runs the predicate under the write lock. The predicate is built
//    once per pass in the READ phase and handed to claimNextEligible, which is
//    documented and tested to evaluate it in phase 1 only.
//  * It never launches. A granted claim is RETURNED, and step 7 stamps and launches
//    it. Deciding and launching are separated so a decision pass holds no container
//    lifetime.
//
// ─── THE CEILING IS COUNTED IN EXACTLY ONE PLACE ─────────────────────────────
// Inside claimNextEligible's write transaction. Nothing here subtracts headroom,
// pre-checks the count or refuses on capacity of its own accord: a ceiling enforced
// anywhere but inside that transaction is advisory, and SQLite cannot detect the
// resulting over-admission after the fact. The capacity_* columns this module writes
// are a REPORT of what the pass saw, and nothing reads them back to admit anything.
//
// ─── HOW FAR THE REFILL LOOP ACTUALLY REACHES, STATED RATHER THAN DISCOVERED ─
// A cycle refills until the ceiling or compatibility stops it — and in practice, on a
// project whose slots are empty, compatibility stops it after the FIRST grant. The
// claim it just granted has recorded no launch and no run yet, so compatibility.ts
// reports its workspace lane as `unknown` and refuses every later candidate in the
// same repository. That refusal is correct (a bypass costs a cycle; two containers in
// one checkout costs a worktree) and it is TEMPORARY: it clears as soon as step 7
// stamps the launch and the run records its first task.
//
// Two consequences the caller must design for rather than be surprised by:
//   * the pass after a grant costs one extra evaluation row, whose reason is
//     `incompatible_only` and whose detail names the unknown workspace. That is the
//     honest current state — "I took FG-1 and cannot yet take a second" — and it is
//     the answer an operator would otherwise have to reconstruct from an idle ceiling.
//   * a TASK SPAWN is therefore a real wake source for step 8's loop, not an
//     optimisation. Without it the watchdog is what eventually refills the ceiling,
//     which is the health bound doing a signal's job.
// A cycle that starts with every active claim already bound to a run refills normally,
// one grant per pass, up to the ceiling. fg591-dispatch-cycle.test.ts proves both.
//
// ─── THE SCOPE COMES FROM THE POLICY ROW, WHICH IS HOST ──────────────────────
// FG-591's recorded decision is a HOST-scoped ceiling, and dispatcher_policy ships
// with capacity_scope defaulting to 'host'. This module reads it from that one row
// rather than hardcoding the literal, because the CLI writes that column and the
// board reads it: a constant here would be a second source of truth that disagrees
// with the operator's own surface the first time anyone touches it. The host default
// is enforced where it belongs — in the policy module (DEFAULT_CAPACITY_SCOPE).
//
// ─── WHAT IS DELIBERATELY NOT FENCED HERE ────────────────────────────────────
// The dispatcher LEASE. A caller passes its generation so the evaluation row records
// which fenced identity decided, but this module does not check that the lease is
// still held: acquiring, renewing, adopting and failing closed on a lost lease is the
// long-lived loop's job (step 8), and duplicating the check here would put half a
// lease protocol in a module with no process to fail closed in. Duplicate EXECUTION
// is prevented where it must be — idx_queue_claims_live and claimNextEligible's
// phase-2 re-validation — not by this fence.
//
// ─── AN UNRESOLVABLE PROJECT PROPAGATES ──────────────────────────────────────
// A markdown-mode or unregistered project makes queue-claims refuse BY NAME (FG-609
// D6). That QueueRefusal is allowed to propagate rather than being caught and
// recorded: DISPATCH_REASONS is a closed vocabulary step 3 owns, none of its six
// values means "this project cannot be dispatched at all", and inventing one here
// would be the second vocabulary FG-591's non-goals forbid. Recording the nearest
// wrong value would be worse than propagating — "no eligible work" for a project the
// store cannot even resolve is a false answer, not a missing one.

import {
  claimNextEligible,
  liveClaimsInScope,
  type QueueClaim,
  type ScanEntry,
} from "../store/queue-claims.js";
import {
  capacityHoldersFrom,
  recordEvaluation,
  type CapacityHolder,
  type DispatchReason,
  type DispatcherEvaluation,
} from "../store/dispatcher-evidence.js";
import { getDispatcherPolicy, type DispatcherPolicy } from "../store/dispatcher-policy.js";
import { hydrateActiveRunFacts, makeCompatibilityPredicate, type ActiveRunFacts } from "./compatibility.js";

// ─── bounds ──────────────────────────────────────────────────────────────────

/** How many times a cycle RE-SCANS after a `lost` refusal.
 *
 *  `lost` is queue-claims' documented busy-host cost: the scan ran unlocked, a
 *  durable fact it depended on moved, and the primitive refused rather than admitting
 *  against a snapshot that no longer holds. Re-scanning is the correct response — the
 *  work may well still be claimable — but retrying without a bound turns a contended
 *  host into a spin loop against the machine-wide write lock, which is the contention
 *  that caused the refusal in the first place. Three re-scans, then the cycle stops
 *  and says so; the next wake looks again. */
export const DEFAULT_LOST_RETRY_LIMIT = 3;

/** A STRUCTURAL BACKSTOP on passes per cycle, not a policy. The refill loop already
 *  terminates on its own: every grant either consumes a capacity slot (so the ceiling
 *  eventually refuses) or is a capacity-neutral takeover of a ticket that is then held
 *  under a live lease (so the next scan names it already_claimed). This bound exists so
 *  that a future change which breaks that argument fails as a bounded stop with a full
 *  durable trail — every pass has already written its own evaluation row — rather than
 *  as an unbounded writer on a shared store. */
const MAX_PASSES_PER_CYCLE = 64;

/** How many bypassed candidates the prose `detail` names before it defers to the
 *  structured column. NOT a silent cap: scan_evidence in the SAME row carries every
 *  scanned candidate, and the detail string says so when it elides. */
const DETAIL_BYPASS_LIMIT = 5;

// ─── types ───────────────────────────────────────────────────────────────────

export type DispatchCycleRequest = {
  projectKey: string;
  /** The dispatcher identity. Becomes the CLAIM's owner (so the claim is fenced to
   *  it) and the evaluation row's dispatcher_owner. */
  owner: string;
  /** The dispatcher lease generation this pass ran under, recorded so a decision made
   *  by a since-superseded dispatcher is identifiable after the fact. Not checked
   *  here — see the header. */
  generation?: number | null;
  /** Which wake drove this cycle, or null when the watchdog / refill loop did. Lets
   *  the operator see whether the event path is delivering at all. */
  wakeKind?: string | null;
  /** The watchdog deadline the caller has armed, recorded on every row this cycle
   *  writes so the operator surface can show it without recomputing it. */
  nextWatchdogAtMs?: number | null;
  /** Stop after this many grants even if capacity remains. Default: unbounded, which
   *  means "refill until the ceiling or compatibility says stop". */
  maxGrants?: number;
  /** Override DEFAULT_LOST_RETRY_LIMIT. */
  lostRetryLimit?: number;
};

/** ONE evaluation pass and the row it wrote. */
export type DispatchPass = {
  reason: DispatchReason;
  evaluation: DispatcherEvaluation;
  /** The granted claim, or null on every refusal. */
  claim: QueueClaim | null;
  /** The RETIRED predecessor when this grant recovered an expired lease, carrying its
   *  launch identity. Step 7's adoption path reads it: a successor that finds a prior
   *  launchId adopts that container rather than starting a second one. */
  takenOverFrom: QueueClaim | null;
  scanned: readonly ScanEntry[];
  /** The snapshot the predicate was closed over. Returned rather than discarded so a
   *  caller can act on the same facts the decision was made against, without
   *  re-reading (and possibly re-deciding against a different world). */
  facts: ActiveRunFacts | null;
};

/** A grant, in the shape step 7 consumes. */
export type DispatchGrant = {
  claim: QueueClaim;
  takenOverFrom: QueueClaim | null;
  evaluationId: number;
  facts: ActiveRunFacts;
};

export type DispatchCycleResult = {
  projectKey: string;
  owner: string;
  /** The policy as this cycle read it. A caller that needs the lease TTL or the
   *  workflow to launch under gets the SAME read the decision used. */
  policy: DispatcherPolicy;
  /** Every pass, in order. Always non-empty: a cycle that does nothing still records
   *  why it did nothing. */
  passes: DispatchPass[];
  grants: DispatchGrant[];
  /** The reason of the LAST pass — why the cycle stopped. */
  finalReason: DispatchReason;
  /** How many `lost` re-scans this cycle spent. */
  lostRetries: number;
};

// ─── prose ───────────────────────────────────────────────────────────────────

function describeEntry(e: ScanEntry): string {
  const rank = e.rank === null ? "unranked" : `rank ${e.rank}`;
  return e.detail === null ? `${e.ticketId} (${rank}, ${e.reason})` : `${e.ticketId} (${rank}, ${e.reason}: ${e.detail})`;
}

/** The candidates this pass passed over, in the order the scan walked them — which is
 *  the operator's own canonical rank order. */
function describeBypasses(scanned: readonly ScanEntry[]): string {
  const bypassed = scanned.filter((e) => e.reason !== "eligible");
  if (bypassed.length === 0) return "no candidate was passed over";
  const shown = bypassed.slice(0, DETAIL_BYPASS_LIMIT).map(describeEntry).join("; ");
  return bypassed.length <= DETAIL_BYPASS_LIMIT
    ? `passed over ${shown}`
    : `passed over ${shown}; and ${bypassed.length - DETAIL_BYPASS_LIMIT} more — all ` +
        `${scanned.length} scanned candidates are in this row's scan_evidence`;
}

function firstIncompatible(scanned: readonly ScanEntry[]): ScanEntry | undefined {
  return scanned.find((e) => e.reason === "incompatible");
}

// ─── one pass ────────────────────────────────────────────────────────────────

/**
 * EXACTLY ONE evaluation pass: read the policy, hydrate, scan, and persist one
 * evaluation row whatever the outcome. No loop, no retry, no launch.
 *
 * Exported because it is the honest unit — a caller that wants a single decision (a
 * CLI dry-run, a test, a step that wants to look once) should not have to reason about
 * a refill loop's termination to get one.
 */
export function runDispatchPass(req: DispatchCycleRequest & { policy?: DispatcherPolicy }): DispatchPass {
  const policy = req.policy ?? getDispatcherPolicy(req.projectKey);
  const common = {
    projectKey: req.projectKey,
    dispatcherOwner: req.owner,
    dispatcherGeneration: req.generation ?? null,
    wakeKind: req.wakeKind ?? null,
    nextWatchdogAtMs: req.nextWatchdogAtMs ?? null,
  };

  // ── DISARMED: an admission test, applied BEFORE anything is scanned. Nothing is
  // hydrated, nothing is claimed, and — critically — nothing is released, expired or
  // terminated. Disarm blocks NEW claims and does exactly that (D5). The row still
  // gets written, because "the operator turned it off" is the single most useful
  // answer to "why is nothing running" and the only one that is otherwise invisible.
  if (!policy.armed) {
    const evaluation = recordEvaluation({
      ...common,
      reason: "disabled",
      detail:
        `autonomous dispatch is disarmed${policy.configured ? "" : " (no policy has ever been written, and an " +
          "unconfigured store fails closed)"}, so nothing was scanned and no claim was attempted. Work ` +
        `already running is untouched and its claims keep their leases — disarm is an admission test, ` +
        `never a reaper. Arm it with \`forge queue dispatcher arm\`.`,
      capacityScope: policy.capacityScope,
      capacityLimit: policy.maxActiveRuns,
      // scan_evidence stays NULL on purpose: nothing was scanned, and an empty array
      // would read as "the queue was scanned and was empty", which is a different fact.
      scanEvidence: null,
    });
    return { reason: "disabled", evaluation, claim: null, takenOverFrom: null, scanned: [], facts: null };
  }

  // ── THE READ PHASE. One hydration per pass — a snapshot reused across passes is a
  // stale snapshot, and compatibility.ts's staleness checks would then refuse
  // everything rather than admit wrongly.
  const facts = hydrateActiveRunFacts({
    projectKey: req.projectKey,
    capacityScope: policy.capacityScope,
  });

  const result = claimNextEligible({
    projectKey: req.projectKey,
    owner: req.owner,
    capacity: policy.maxActiveRuns,
    capacityScope: policy.capacityScope,
    leaseTtlMs: policy.leaseTtlMs,
    isCompatible: makeCompatibilityPredicate(facts),
  });

  const scanned = result.scanned;
  const capacity = {
    capacityScope: policy.capacityScope,
    capacityLimit: policy.maxActiveRuns,
    capacityUsed: facts.activeRuns.length,
  };

  if (result.claimed !== null) {
    const claim = result.claimed;
    const evaluation = recordEvaluation({
      ...common,
      ...capacity,
      reason: "granted",
      claimedTicketId: claim.ticketId,
      claimId: claim.id,
      detail:
        `claimed ${claim.ticketId} for ${req.owner} at generation ${claim.generation}` +
        `${result.takenOverFrom ? ` by taking over expired claim ${result.takenOverFrom.id}` : ""}; ` +
        `${describeBypasses(scanned)}.`,
      scanEvidence: scanned,
    });
    return { reason: "granted", evaluation, claim, takenOverFrom: result.takenOverFrom, scanned, facts };
  }

  if (result.reason === "capacity") {
    // A REPORT, taken after the refusal and enforcing nothing. The holder list is what
    // a HOST-scoped refusal owes a per-project board: without it, "my queue is stalled
    // and my board shows nothing running" has no answer anywhere in the system.
    // capacityHoldersFrom is the single author of that JSON shape (step 3's rule), so
    // the live claims are read as claims and mapped there rather than reshaped here.
    const holders: CapacityHolder[] = capacityHoldersFrom(liveClaimsInScope(policy.capacityScope, req.projectKey));
    const others = [...new Set(holders.map((h) => h.projectKey).filter((k) => k !== req.projectKey))];
    // Named explicitly rather than left implicit: under a HOST-scoped ceiling the
    // project that is WAITING is often not the project that is HOLDING, and a board
    // scoped to one project cannot otherwise explain its own stall.
    const heldElsewhere = others.length === 0 ? "" : `, with slots held by ${others.join(", ")}`;
    const evaluation = recordEvaluation({
      ...common,
      capacityScope: policy.capacityScope,
      capacityLimit: policy.maxActiveRuns,
      capacityUsed: holders.length,
      capacityHolders: holders,
      reason: "no_capacity",
      detail:
        `${holders.length}/${policy.maxActiveRuns} live claims in ${policy.capacityScope} scope` +
        `${heldElsewhere}. A candidate was otherwise eligible and the ceiling turned it away; nothing was ` +
        `terminated and no rank moved. ${describeBypasses(scanned)}.`,
      scanEvidence: scanned,
    });
    return { reason: "no_capacity", evaluation, claim: null, takenOverFrom: null, scanned, facts };
  }

  if (result.reason === "lost") {
    const evaluation = recordEvaluation({
      ...common,
      ...capacity,
      reason: "lost",
      detail:
        `the claim attempt lost its re-validation: a durable fact the unlocked scan depended on moved, or ` +
        `a concurrent dispatcher won the ticket. Nothing was written — queue-claims refuses rather than ` +
        `admitting against a snapshot that no longer holds. Re-scanning. ${describeBypasses(scanned)}.`,
      scanEvidence: scanned,
    });
    return { reason: "lost", evaluation, claim: null, takenOverFrom: null, scanned, facts };
  }

  // no_eligible_candidate — split into the TWO answers the AC insists are different
  // things. An `incompatible` entry means a candidate cleared every durable
  // eligibility test and the ceiling, and was turned away ONLY by parallel-safety:
  // that is TEMPORARY and self-clearing, reads as "waiting for FG-123 to finish", and
  // must never be presented — or stored — as a blocker.
  const incompatible = firstIncompatible(scanned);
  if (incompatible !== undefined) {
    const evaluation = recordEvaluation({
      ...common,
      ...capacity,
      reason: "incompatible_only",
      detail:
        `${incompatible.detail ?? `${incompatible.ticketId} cannot safely overlap the active set`} ` +
        `This is a temporary scheduling wait, NOT a blocker: the item keeps its rank, keeps its queue ` +
        `membership, and is reconsidered as soon as capacity or the active set changes. ` +
        `${describeBypasses(scanned)}.`,
      scanEvidence: scanned,
    });
    return { reason: "incompatible_only", evaluation, claim: null, takenOverFrom: null, scanned, facts };
  }

  const evaluation = recordEvaluation({
    ...common,
    ...capacity,
    reason: "no_eligible_work",
    detail:
      `the scan walked ${scanned.length} ranked-or-queued candidate${scanned.length === 1 ? "" : "s"} in ` +
      `canonical rank order and none was selectable. ${describeBypasses(scanned)}.`,
    scanEvidence: scanned,
  });
  return { reason: "no_eligible_work", evaluation, claim: null, takenOverFrom: null, scanned, facts };
}

// ─── the cycle ───────────────────────────────────────────────────────────────

/**
 * ONE DISPATCH CYCLE: refill until the ceiling is reached, no compatible candidate
 * remains, or the `lost` budget is spent.
 *
 * The policy is read ONCE and used for every pass in the cycle, so a cycle enforces
 * one coherent ceiling rather than a value that moved under it mid-loop. A policy
 * change is itself a wake (`capacity_changed` / `policy_changed`), so the next cycle
 * picks it up — which is the right granularity for an ADMISSION test.
 *
 * Every pass writes its own evaluation row, so `passes` is a complete durable
 * transcript of the cycle and never a summary of one.
 */
export function runDispatchCycle(req: DispatchCycleRequest): DispatchCycleResult {
  const policy = getDispatcherPolicy(req.projectKey);
  const lostBudget = req.lostRetryLimit ?? DEFAULT_LOST_RETRY_LIMIT;
  const maxGrants = req.maxGrants;

  const passes: DispatchPass[] = [];
  const grants: DispatchGrant[] = [];
  let lostRetries = 0;

  for (let n = 0; n < MAX_PASSES_PER_CYCLE; n++) {
    const pass = runDispatchPass({ ...req, policy });
    passes.push(pass);

    if (pass.reason === "granted") {
      grants.push({
        claim: pass.claim as QueueClaim,
        takenOverFrom: pass.takenOverFrom,
        evaluationId: pass.evaluation.id,
        facts: pass.facts as ActiveRunFacts,
      });
      if (maxGrants !== undefined && grants.length >= maxGrants) break;
      continue;
    }

    if (pass.reason === "lost") {
      // The re-scan is the retry. Spending the budget is a bounded cost paid once per
      // cycle, not per candidate: `lost` says the whole SCAN went stale, so there is
      // nothing narrower to retry.
      if (lostRetries >= lostBudget) break;
      lostRetries++;
      continue;
    }

    // disabled, no_capacity, no_eligible_work, incompatible_only — all terminal for
    // this cycle. Each is self-clearing on a durable change that is itself a wake
    // source, so re-scanning now would only re-derive the same answer.
    break;
  }

  return {
    projectKey: req.projectKey,
    owner: req.owner,
    policy,
    passes,
    grants,
    // passes is never empty: MAX_PASSES_PER_CYCLE is > 0 and the first iteration
    // always records a pass, so the non-null assertion below is structural.
    finalReason: (passes[passes.length - 1] as DispatchPass).reason,
    lostRetries,
  };
}
