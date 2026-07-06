import type { BlockerKind, ContinuePolicy } from "../types/index.js";

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

// Maps a FailureKind string (from task events) to a BlockerKind.
// Throws are classified as infrastructure (callers handle undefined/null via this function too).
export function classifyFailureKind(failureKind: string | undefined): BlockerKind {
  switch (failureKind) {
    case "auth_missing":
    case "auth_expired":
    case "auth_injection_failed":
      return "auth";
    case "container_crash":
    case "orphaned":
    case "idle_timeout":
    case "result_missing":
    case "result_malformed":
    case "work_not_persisted":
    // FG-424: unlike a clean-merge-but-broken-code failure (integration_failed,
    // below), a gate run that timed out or was killed by signal reflects
    // host/environment state, not this item's changes — it must pause the
    // whole campaign (SHARED) rather than being scoped to one item. Deliberate
    // divergence from the adjacent integration_failed case, not an oversight.
    case "integration_gate_timeout":
    case "integration_gate_crashed":
      return "infrastructure";
    case "merge_conflict":
      return "merge_conflict";
    case "cancelled":
    case "unknown":
      return "campaign_system";
    // FG-455 p4: mirrors orphaned_work_may_persist's may-hold-work SHARED
    // treatment — a blind campaign-retry could clobber persisted work, so
    // pause the campaign for human inspection instead of continuing blind.
    case "oom_killed":
      return "campaign_system";
    case "model_error":
    case "tool_error":
    case "red_blocked":
    case "gate_rejected":
      return "scope";
    // FG-426: the merge itself was clean — the post-merge integration gate
    // (FG-357) caught a broken merged tree. That's a scoped, operator-fixable
    // build/test failure on this item, not a campaign-wide system fault, so it
    // gets the same LOCAL "scope" treatment as gate_rejected rather than
    // falling through to the conservative campaign_system default.
    case "integration_failed":
      return "scope";
    case undefined:
      // No terminal event recorded — anomalous when the campaign saw status:failed.
      // Cannot positively identify as a LOCAL agent failure; must HOLD the campaign.
      return "campaign_system";
    default:
      // Future/unknown failure kind → conservative SHARED
      return "campaign_system";
  }
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
