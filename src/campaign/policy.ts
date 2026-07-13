import type { BlockerKind, ContinuePolicy } from "../types/index.js";
import type { FailureKind } from "../v2/failure-kind.js";

export const SHARED_BLOCKER_KINDS = new Set<BlockerKind>([
  "auth",
  "infrastructure",
  "git_state",
  "dependency",
  "merge_conflict",
  "campaign_system",
  // FG-442: an item outgrowing its approved lane invalidates the approved plan
  // basis (the item can no longer be trusted to finish in the lane the operator
  // approved) — scoping this hold-dependents-only would under-pause, so it must
  // pause the WHOLE campaign like the other SHARED kinds.
  "lane_escalation",
]);

export function isSharedBlocker(kind: BlockerKind): boolean {
  return SHARED_BLOCKER_KINDS.has(kind);
}

// Maps a FailureKind to a BlockerKind.
//
// Typed Record<FailureKind, BlockerKind>, NOT a switch with a `default`: a kind
// added to FailureKind without an entry here is a COMPILE ERROR. The old switch
// silently routed anything unlisted to the conservative campaign_system SHARED
// default, which is how the four FG-425 publication kinds ended up pausing whole
// campaigns by fallthrough rather than by decision. classifyFailureKind() below
// still applies that conservative default at RUNTIME — for a kind read off an
// event this build doesn't know about — but no longer at BUILD time.
const BLOCKER_BY_FAILURE_KIND: Record<FailureKind, BlockerKind> = {
  auth_missing: "auth",
  auth_expired: "auth",
  auth_injection_failed: "auth",

  container_crash: "infrastructure",
  orphaned: "infrastructure",
  idle_timeout: "infrastructure",
  result_missing: "infrastructure",
  result_malformed: "infrastructure",
  work_not_persisted: "infrastructure",
  // FG-424: unlike a clean-merge-but-broken-code failure (integration_failed,
  // below), a gate run that timed out or was killed by signal reflects
  // host/environment state, not this item's changes — it must pause the
  // whole campaign (SHARED) rather than being scoped to one item. Deliberate
  // divergence from the adjacent integration_failed case, not an oversight.
  integration_gate_timeout: "infrastructure",
  integration_gate_crashed: "infrastructure",

  merge_conflict: "merge_conflict",

  cancelled: "campaign_system",
  unknown: "campaign_system",
  // FG-455 p4: mirrors orphaned_work_may_persist's may-hold-work SHARED
  // treatment — a blind campaign-retry could clobber persisted work, so
  // pause the campaign for human inspection instead of continuing blind.
  oom_killed: "campaign_system",
  orphaned_work_may_persist: "campaign_system",
  orphaned_needs_finalize: "campaign_system",
  fanout_wave_orphaned: "campaign_system",
  pre_container_crash: "campaign_system",
  verification_environment_unavailable: "campaign_system",

  model_error: "scope",
  tool_error: "scope",
  red_blocked: "scope",
  gate_rejected: "scope",
  // FG-426: the merge itself was clean — the integration gate (FG-357) caught a
  // broken candidate. That's a scoped, operator-fixable build/test failure on
  // this item, not a campaign-wide system fault, so it gets the same LOCAL
  // "scope" treatment as gate_rejected.
  integration_failed: "scope",

  // ── FG-425 publication blockers: classified deliberately, per kind. ──
  //
  // The publish TARGET is shared by every item in a campaign (they all publish
  // into the campaign's projectDir), so a blocker that is a property of the
  // TARGET is a property of every remaining item — not of the one that happened
  // to hit it first.
  //
  // dirty_publish_target: SHARED, despite being operator-fixable and cheap to
  // fix. It is tempting to scope this to the one item, but the dirt is in the
  // shared target's working tree: every remaining item would validate a full
  // candidate and then be refused at exactly the same place (AD-3 refuses BEFORE
  // any mutation, and forge never touches operator-owned state). Continuing
  // would burn N item runs to produce N copies of one blocker. git_state is the
  // precise existing kind — "the git working state is not what forge requires" —
  // and it is SHARED. One operator action (commit/stash/move) clears it and the
  // campaign resumes.
  dirty_publish_target: "git_state",
  // publish_base_churn: SHARED. AD-1's bound was hit because an EXTERNAL writer
  // is pushing to the target mid-run (forge-owned attempts are FIFO-ordered and
  // cannot move each other's base). That contention hits every subsequent item's
  // publication too; pausing is right, and the fix is to find the other writer,
  // never to keep looping.
  publish_base_churn: "git_state",
  // publication_refused: SHARED. A failed CAS/ancestry check means the target's
  // history moved or was rewritten under a validated candidate. Forge cannot
  // reason about the target until a human explains it — hold.
  publication_refused: "git_state",
  // lane_taken_over: LOCAL ("scope", the bucket the other item-scoped kinds use).
  // This is the publication lane WORKING, not a fault: a stalled attempt's lease
  // lapsed and a successor stepped past it. Nothing was published, the target is
  // untouched, and no other item is impaired — the item just needs re-dispatch
  // (a retry enqueues a fresh attempt, AD-7). Pausing the campaign for it would
  // be a self-inflicted stall.
  lane_taken_over: "scope",
};

// Throws are classified as infrastructure (callers handle undefined/null via this function too).
export function classifyFailureKind(failureKind: string | undefined): BlockerKind {
  // No terminal event recorded — anomalous when the campaign saw status:failed.
  // Cannot positively identify as a LOCAL agent failure; must HOLD the campaign.
  // Same for a kind this build doesn't recognize: conservative SHARED.
  if (failureKind === undefined) return "campaign_system";
  return BLOCKER_BY_FAILURE_KIND[failureKind as FailureKind] ?? "campaign_system";
}

export type DependencyRelation = "dependent" | "independent" | "unknown";

export function relationToBlocked(
  blockedTicket: { id: string; related?: string[] },
  laterTicket: { id: string; related?: string[] }
): DependencyRelation {
  const blockedId = blockedTicket.id;
  const laterId = laterTicket.id;

  if (blockedTicket.related?.includes(laterId) || laterTicket.related?.includes(blockedId)) {
    return "dependent";
  }

  if (blockedTicket.related && blockedTicket.related.length > 0) {
    return "independent";
  }

  return "unknown";
}

export function evaluateContinuePolicy(
  blockerKind: BlockerKind,
  relation: DependencyRelation,
  mode: string
): ContinuePolicy {
  if (isSharedBlocker(blockerKind)) return "hold_campaign";

  if (relation === "dependent") return "hold_dependents";
  if (relation === "unknown") return mode === "pilot" ? "continue_allowed" : "hold_dependents";
  return "continue_allowed";
}
