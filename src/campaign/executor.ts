import { existsSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "../v2/invoke.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import {
  getCampaign,
  listCampaignItems,
  updateCampaignItem,
  tryTransitionCampaign,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import type { CampaignItemLifecycleStatus, CampaignItemOutcome, Run } from "../types/index.js";
import { resolvePlan } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { listTickets, readTicket } from "../backlog/structured.js";
import { insertRun } from "../store/runs.js";
import { newRunId, nowIso } from "../util/ids.js";

export type CampaignStopReason =
  | "not_planned"
  | "no_project_dir"
  | "invalid_project_dir"
  | "dry_run_not_executable"
  | "not_approved"
  | "stale_plan"
  | "already_running"
  | "not_paused"
  | "paused"
  | "abandoned"
  | "item_failed"
  | "complete"
  | "recovery_needed";

export type CampaignItemRecord = {
  itemId: string;
  ticketId: string;
  runId?: string;
  lifecycleStatus: CampaignItemLifecycleStatus;
  outcome?: CampaignItemOutcome;
};

export type CampaignRunResult = {
  stopReason: CampaignStopReason;
  itemRecords: CampaignItemRecord[];
};

function hasBacklog(dir: string): boolean {
  return existsSync(join(dir, "backlog"));
}

export function sourceInputToPlannerInput(sourceInput: Record<string, unknown>): PlannerInput {
  const kind = sourceInput["kind"] as string;
  if (kind === "list") {
    return { kind: "list", ticketIds: (sourceInput["ticketIds"] as string[]) ?? [] };
  }
  if (kind === "epic") {
    return { kind: "epic", epicId: sourceInput["epicId"] as string };
  }
  return {
    kind: "mixed",
    epicId: sourceInput["epicId"] as string,
    additions: sourceInput["additions"] as string[] | undefined,
    exclusions: sourceInput["exclusions"] as string[] | undefined,
  };
}

// Shared item-dispatch loop used by startCampaign and resumeCampaign.
// Requires the campaign to already be in 'running' state.
// Skips terminal items (complete/failed); dispatches only pending items.
// Cooperative pause: re-reads campaign status before each dispatch and after
// each item completes, stopping without transition if status != 'running'.
async function driveRemainingItems(
  campaignId: string,
  opts: {
    dispatch: (args: InvokeArgs) => Promise<InvokeResult>;
    projectDir: string;
  }
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];
  const items = listCampaignItems(campaignId);
  const ticketCache = listTickets(opts.projectDir);
  const ticketMap = new Map(ticketCache.map((t) => [t.id, t]));

  for (const item of items) {
    // Safe-terminal: skip idempotently on re-drive
    if (item.lifecycleStatus === "complete" || item.lifecycleStatus === "failed") {
      continue;
    }
    // In-flight/indeterminate: stop without dispatch or campaign status transition
    if (item.lifecycleStatus !== "pending") {
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId: item.runId,
        lifecycleStatus: item.lifecycleStatus,
      });
      return { stopReason: "recovery_needed", itemRecords };
    }

    // Cooperative pause: check campaign status before each dispatch
    const preCheck = getCampaign(campaignId);
    if (!preCheck || preCheck.status !== "running") {
      return {
        stopReason: preCheck?.status === "abandoned" ? "abandoned" : "paused",
        itemRecords,
      };
    }

    const runId = newRunId(item.ticketId);
    const run: Run = {
      id: runId,
      workflow: "invoke",
      title: item.ticketId,
      status: "active",
      createdAt: nowIso(),
      metadata: { invokeAgent: "engineer" },
      projectDir: opts.projectDir,
    };
    insertRun(run);
    updateCampaignItem(item.id, { runId, lifecycleStatus: "running" });

    const cachedTicket = ticketMap.get(item.ticketId);
    const taskText = cachedTicket
      ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
      : item.ticketId;

    let dispatchResult: InvokeResult;
    try {
      dispatchResult = await opts.dispatch({
        agentRole: "engineer",
        task: taskText,
        projectDir: opts.projectDir,
        runId,
        runTitle: item.ticketId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      updateCampaignItem(item.id, {
        lifecycleStatus: "failed",
        outcome: "failed",
        blockerKind: "campaign_system",
        reason,
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId,
        lifecycleStatus: "failed",
        outcome: "failed",
      });
      if (tryTransitionCampaign(campaignId, "running", "failed")) {
        return { stopReason: "item_failed", itemRecords };
      }
      const throwPostFail = getCampaign(campaignId);
      return {
        stopReason: throwPostFail?.status === "abandoned" ? "abandoned" : "paused",
        itemRecords,
      };
    }

    // Re-read campaign status after item completes
    const postCheck = getCampaign(campaignId);

    if (dispatchResult.status === "complete") {
      let outcome: CampaignItemOutcome | undefined;
      try {
        const freshTicket = readTicket(opts.projectDir, item.ticketId);
        if (freshTicket.status === "done" && !!freshTicket.closedCommit) {
          outcome = "shipped";
        }
      } catch {
        // ticket not found after run — leave outcome undefined
      }
      updateCampaignItem(item.id, { lifecycleStatus: "complete", outcome });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId,
        lifecycleStatus: "complete",
        outcome,
      });

      // Cooperative pause: if campaign was paused during this item, stop without transition
      if (!postCheck || postCheck.status !== "running") {
        return {
          stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }
    } else {
      const reason = dispatchResult.error ?? "invoke failed";
      updateCampaignItem(item.id, {
        lifecycleStatus: "failed",
        outcome: "failed",
        blockerKind: "campaign_system",
        reason,
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId,
        lifecycleStatus: "failed",
        outcome: "failed",
      });
      if (tryTransitionCampaign(campaignId, "running", "failed")) {
        return { stopReason: "item_failed", itemRecords };
      }
      const resultPostFail = getCampaign(campaignId);
      return {
        stopReason: resultPostFail?.status === "abandoned" ? "abandoned" : "paused",
        itemRecords,
      };
    }
  }

  // All pending items processed — atomically transition to complete if still running
  if (tryTransitionCampaign(campaignId, "running", "complete")) {
    return { stopReason: "complete", itemRecords };
  }
  const finalCheck = getCampaign(campaignId);
  return {
    stopReason: finalCheck?.status === "abandoned" ? "abandoned" : "paused",
    itemRecords,
  };
}

export async function startCampaign(
  id: string,
  opts: {
    dispatch?: (args: InvokeArgs) => Promise<InvokeResult>;
  } = {}
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];

  const campaign = getCampaign(id);
  if (!campaign || campaign.status !== "planned") {
    return { stopReason: "not_planned", itemRecords };
  }

  const effectiveProjectDir = campaign.projectDir;
  if (!effectiveProjectDir) {
    return { stopReason: "no_project_dir", itemRecords };
  }
  if (!existsSync(effectiveProjectDir) || !hasBacklog(effectiveProjectDir)) {
    return { stopReason: "invalid_project_dir", itemRecords };
  }

  if (campaign.mode !== "pilot" && campaign.mode !== "sequential") {
    return { stopReason: "dry_run_not_executable", itemRecords };
  }

  if (!campaign.approvedPlanHash) {
    return { stopReason: "not_approved", itemRecords };
  }

  const plannerInput = sourceInputToPlannerInput(campaign.sourceInput);
  const { planHash: currentHash } = resolvePlan(plannerInput, {
    projectDir: effectiveProjectDir,
    mode: campaign.mode as PlanMode,
  });
  if (currentHash !== campaign.approvedPlanHash) {
    return { stopReason: "stale_plan", itemRecords };
  }

  if (!tryTransitionCampaignToRunning(id)) {
    return { stopReason: "already_running", itemRecords };
  }

  return driveRemainingItems(id, {
    dispatch: opts.dispatch ?? invoke,
    projectDir: effectiveProjectDir,
  });
}

export async function resumeCampaign(
  id: string,
  opts: {
    dispatch?: (args: InvokeArgs) => Promise<InvokeResult>;
  } = {}
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];

  const campaign = getCampaign(id);
  if (!campaign || campaign.status !== "paused") {
    return { stopReason: "not_paused", itemRecords };
  }

  const effectiveProjectDir = campaign.projectDir;
  if (!effectiveProjectDir) {
    return { stopReason: "no_project_dir", itemRecords };
  }
  if (!existsSync(effectiveProjectDir) || !hasBacklog(effectiveProjectDir)) {
    return { stopReason: "invalid_project_dir", itemRecords };
  }

  if (!campaign.approvedPlanHash) {
    return { stopReason: "not_approved", itemRecords };
  }

  const plannerInput = sourceInputToPlannerInput(campaign.sourceInput);
  const { planHash: currentHash } = resolvePlan(plannerInput, {
    projectDir: effectiveProjectDir,
    mode: campaign.mode as PlanMode,
  });
  if (currentHash !== campaign.approvedPlanHash) {
    return { stopReason: "stale_plan", itemRecords };
  }

  // Pre-flight: refuse if any item is in-flight — leaves campaign paused and inspectable
  const preflightItems = listCampaignItems(id);
  const inFlightItem = preflightItems.find(
    (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
  );
  if (inFlightItem) {
    return {
      stopReason: "recovery_needed",
      itemRecords: [{
        itemId: inFlightItem.id,
        ticketId: inFlightItem.ticketId,
        runId: inFlightItem.runId,
        lifecycleStatus: inFlightItem.lifecycleStatus,
      }],
    };
  }

  if (!tryTransitionCampaign(id, "paused", "running")) {
    const current = getCampaign(id);
    return {
      stopReason: current?.status === "abandoned" ? "abandoned" : "already_running",
      itemRecords,
    };
  }

  return driveRemainingItems(id, {
    dispatch: opts.dispatch ?? invoke,
    projectDir: effectiveProjectDir,
  });
}
