import type { BlockerKind, ContinuePolicy } from "../types/index.js";

export const SHARED_BLOCKER_KINDS = new Set<BlockerKind>([
  "auth",
  "infrastructure",
  "git_state",
  "dependency",
  "merge_conflict",
  "campaign_system",
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
      return "infrastructure";
    case "merge_conflict":
      return "merge_conflict";
    case "cancelled":
    case "unknown":
      return "campaign_system";
    case "model_error":
    case "tool_error":
    case "red_blocked":
    case "gate_rejected":
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
