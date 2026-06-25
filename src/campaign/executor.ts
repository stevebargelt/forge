import { existsSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "../v2/invoke.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import {
  getCampaign,
  listCampaignItems,
  updateCampaignItem,
  updateCampaignStatus,
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
  | "not_approved"
  | "stale_plan"
  | "already_running"
  | "item_failed"
  | "complete";

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

function sourceInputToPlannerInput(sourceInput: Record<string, unknown>): PlannerInput {
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

  const items = listCampaignItems(id);
  const ticketCache = listTickets(effectiveProjectDir);
  const ticketMap = new Map(ticketCache.map((t) => [t.id, t]));
  const dispatchFn = opts.dispatch ?? invoke;

  for (const item of items) {
    const runId = newRunId(item.ticketId);
    const run: Run = {
      id: runId,
      workflow: "invoke",
      title: item.ticketId,
      status: "active",
      createdAt: nowIso(),
      metadata: { invokeAgent: "engineer" },
      projectDir: effectiveProjectDir,
    };
    insertRun(run);
    updateCampaignItem(item.id, { runId, lifecycleStatus: "running" });

    const cachedTicket = ticketMap.get(item.ticketId);
    const taskText = cachedTicket
      ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
      : item.ticketId;

    const result = await dispatchFn({
      agentRole: "engineer",
      task: taskText,
      projectDir: effectiveProjectDir,
      runId,
      runTitle: item.ticketId,
    });

    if (result.status === "complete") {
      let outcome: CampaignItemOutcome | undefined;
      try {
        const freshTicket = readTicket(effectiveProjectDir, item.ticketId);
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
    } else {
      const reason = result.error ?? "invoke failed";
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
      updateCampaignStatus(id, "failed");
      return { stopReason: "item_failed", itemRecords };
    }
  }

  updateCampaignStatus(id, "complete");
  return { stopReason: "complete", itemRecords };
}
