// FG-402 (b): the WAIT mapper.
//
// FG-734 already derives the durable operator/CI waits — human gates and campaign
// hard-stops (OperatorWaitActivity) and live registered CI waits (CiWaitActivity) —
// as part of `deriveCurrentActivity`. This mapper consumes THAT output and maps it
// into inbox items. It does NOT re-query tasks or campaign_items: the whole point is
// that the inbox cannot drift from `forge status` / Current activity, because both
// render the SAME derived records (protected_invariant #4).

import type { OperatorWaitActivity, CiWaitActivity } from "@forge/current-activity";
import type { AttentionItem, AttentionSeverity } from "./attention-inbox.js";

export type WaitSources = {
  operatorWaits: readonly OperatorWaitActivity[];
  ciWaits: readonly CiWaitActivity[];
};

/** A campaign hard-stop is a run that stopped ITSELF and named the authority it needs —
 *  higher priority than a routine pipeline gate awaiting a decision. */
function operatorWaitSeverity(wait: OperatorWaitActivity): AttentionSeverity {
  return wait.source === "campaign_hard_stop" ? "high" : "medium";
}

function operatorWaitItem(wait: OperatorWaitActivity): AttentionItem {
  const isCampaign = wait.source === "campaign_hard_stop";
  return {
    id: `wait:${wait.waitKey}`,
    kind: isCampaign ? "campaign_paused" : "waiting_gate",
    severity: operatorWaitSeverity(wait),
    startedAt: wait.startedAt,
    reason: wait.reason,
    requestedAction: wait.requestedAction,
    openState: "open",
    source: isCampaign ? "campaign_item" : "gate",
    links: {
      runId: wait.runId,
      taskId: wait.taskId,
      ticketId: wait.ticketId,
      campaignId: wait.campaignId,
      itemId: wait.itemId,
      projectDir: wait.projectDir,
      projectLabel: wait.projectLabel,
    },
  };
}

/** A live CI wait is machine-waiting, not human-action — EXCEPT `completed_awaiting_advance`,
 *  where the run finished and the operator/orchestrator still owes an advance. Only that
 *  one state is a human-attention item; the running/no-runs/unavailable states are not
 *  surfaced (there is no human action to take on a CI run still in progress). */
function ciWaitItem(wait: CiWaitActivity): AttentionItem | null {
  if (wait.displayState !== "completed_awaiting_advance") return null;
  return {
    id: `ci-wait:${wait.waitId}`,
    kind: "waiting_gate",
    severity: "medium",
    startedAt: wait.startedAt,
    reason: wait.statusLabel,
    requestedAction: "advance the run — its required CI checks have completed",
    openState: "open",
    source: "ci_wait",
    links: {
      runId: wait.runId,
      taskId: null,
      ticketId: wait.ticketId,
      campaignId: null,
      itemId: null,
      projectDir: wait.projectDir,
      projectLabel: wait.projectLabel,
    },
  };
}

/** Map FG-734's derived waits into inbox items. Pure — no DB access. */
export function waitAttentionItems(sources: WaitSources): AttentionItem[] {
  const items: AttentionItem[] = sources.operatorWaits.map(operatorWaitItem);
  for (const wait of sources.ciWaits) {
    const item = ciWaitItem(wait);
    if (item !== null) items.push(item);
  }
  return items;
}
