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
import type { Campaign, CampaignItem, CampaignItemLifecycleStatus, CampaignItemOutcome, BlockerKind, Run } from "../types/index.js";
import { resolvePlan } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { listTickets, readTicket } from "../backlog/structured.js";
import type { StructuredTicket } from "../backlog/structured.js";
import { insertRun, updateRunStatus } from "../store/runs.js";
import { newRunId, nowIso } from "../util/ids.js";
import { failureKindForTask } from "../v2/failure-kind.js";
import {
  classifyFailureKind,
  isSharedBlocker,
  relationToBlocked,
  evaluateContinuePolicy,
} from "./policy.js";

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

// Pure precondition evaluator — no DB writes. Returns the first blocking stop reason or null.
// In-flight check is status-agnostic and always runs first.
export function campaignBlocker(
  campaign: Campaign,
  items: CampaignItem[],
  intent: "start" | "resume"
): CampaignStopReason | null {
  const inFlight = items.find(
    (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
  );
  if (inFlight) return "recovery_needed";

  if (intent === "start") {
    if (campaign.status !== "planned") return "not_planned";
    const dir = campaign.projectDir;
    if (!dir) return "no_project_dir";
    if (!existsSync(dir) || !hasBacklog(dir)) return "invalid_project_dir";
    if (campaign.mode !== "pilot" && campaign.mode !== "sequential") return "dry_run_not_executable";
    if (!campaign.approvedPlanHash) return "not_approved";
    const { planHash: currentHash } = resolvePlan(sourceInputToPlannerInput(campaign.sourceInput), {
      projectDir: dir,
      mode: campaign.mode as PlanMode,
    });
    if (currentHash !== campaign.approvedPlanHash) return "stale_plan";
    return null;
  } else {
    if (campaign.status !== "paused") return "not_paused";
    const dir = campaign.projectDir;
    if (!dir) return "no_project_dir";
    if (!existsSync(dir) || !hasBacklog(dir)) return "invalid_project_dir";
    if (!campaign.approvedPlanHash) return "not_approved";
    const { planHash: currentHash } = resolvePlan(sourceInputToPlannerInput(campaign.sourceInput), {
      projectDir: dir,
      mode: campaign.mode as PlanMode,
    });
    if (currentHash !== campaign.approvedPlanHash) return "stale_plan";
    return null;
  }
}

type BlockedItemEntry = {
  id: string;
  ticket: StructuredTicket;
  blockerKind: BlockerKind;
};

// Evaluate whether a later item should be held given the current set of blocked items.
// Returns { hold: true, reason, holderId } or { hold: false }.
function evaluateForHold(
  laterTicket: StructuredTicket | undefined,
  blockedItems: BlockedItemEntry[],
  mode: string
): { hold: true; reason: string; holderId: string } | { hold: false } {
  if (!blockedItems.length) return { hold: false };

  for (const blocker of blockedItems) {
    const rel = laterTicket
      ? relationToBlocked({ id: blocker.id, related: blocker.ticket.related }, { id: laterTicket.id, related: laterTicket.related })
      : "unknown";
    const policy = evaluateContinuePolicy(blocker.blockerKind, rel, mode);

    if (policy === "hold_dependents" || policy === "hold_campaign") {
      const reason =
        rel === "dependent"
          ? `held because related to blocked item ${blocker.id}`
          : `held because dependency relation is unknown in sequential mode`;
      return { hold: true, reason, holderId: blocker.id };
    }
  }
  return { hold: false };
}

// Reason string for a continued (not held) item, for informational recording.
function continueReason(
  laterTicket: StructuredTicket | undefined,
  blockedItems: BlockedItemEntry[],
  mode: string
): string {
  if (blockedItems.length === 1) {
    const blockedItem = blockedItems[0]!;
    const rel = laterTicket
      ? relationToBlocked({ id: blockedItem.id, related: blockedItem.ticket.related }, { id: laterTicket.id, related: laterTicket.related })
      : "unknown";
    if (rel === "unknown" && mode === "pilot") return "continued because relation unknown and mode=pilot";
    return "continued because related metadata does not link to blocked item";
  }
  // Multiple blockers: don't falsely name only the last one — check if pilot+unknown applies
  if (mode === "pilot") {
    for (const b of blockedItems) {
      const rel = laterTicket
        ? relationToBlocked({ id: b.id, related: b.ticket.related }, { id: laterTicket.id, related: laterTicket.related })
        : "unknown";
      if (rel === "unknown") return "continued because relation unknown and mode=pilot";
    }
  }
  return "continued because item is independent of all blocked items";
}

export type CampaignRunResult = {
  stopReason: CampaignStopReason;
  itemRecords: CampaignItemRecord[];
};

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
    mode: string;
  }
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];
  const items = listCampaignItems(campaignId);
  const ticketCache = listTickets(opts.projectDir);
  const ticketMap = new Map(ticketCache.map((t) => [t.id, t]));

  // Track LOCAL blocked items for dependency-based hold evaluation.
  // Rebuilt from terminal failed+blocked items at the start of the loop (for resume),
  // then extended as new failures occur.
  const blockedItems: BlockedItemEntry[] = [];
  let anyHeld = false;

  for (const item of items) {
    // Safe-terminal: skip idempotently on re-drive
    if (item.lifecycleStatus === "complete" || item.lifecycleStatus === "failed") {
      // Rebuild blockedItems from previously-failed LOCAL blocked items for resume re-evaluation.
      if (
        item.lifecycleStatus === "failed" &&
        item.outcome === "blocked" &&
        item.blockerKind &&
        !isSharedBlocker(item.blockerKind)
      ) {
        const t = ticketMap.get(item.ticketId);
        if (t) blockedItems.push({ id: item.ticketId, ticket: t, blockerKind: item.blockerKind });
      }
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

    const laterTicket = ticketMap.get(item.ticketId);

    // Re-evaluate HELD items (resume: items already marked held from a prior run).
    if (item.outcome === "held") {
      const holdResult = evaluateForHold(laterTicket, blockedItems, opts.mode);
      if (holdResult.hold) {
        // Still held — refresh reason
        updateCampaignItem(item.id, { outcome: "held", continuePolicy: "hold_dependents", reason: holdResult.reason });
        anyHeld = true;
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, lifecycleStatus: "pending", outcome: "held" });
        continue;
      }
      // No longer held — clear and fall through to dispatch
      updateCampaignItem(item.id, { outcome: undefined, continuePolicy: undefined, reason: undefined, requestedHumanAction: undefined });
    }

    // Check if this pending item should be newly HELD based on current blockedItems.
    if (blockedItems.length > 0) {
      const holdResult = evaluateForHold(laterTicket, blockedItems, opts.mode);
      if (holdResult.hold) {
        updateCampaignItem(item.id, { outcome: "held", continuePolicy: "hold_dependents", reason: holdResult.reason });
        anyHeld = true;
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, lifecycleStatus: "pending", outcome: "held" });
        continue;
      }
      // continue_allowed — record reason before dispatch (informational)
      if (laterTicket) {
        const reason = continueReason(laterTicket, blockedItems, opts.mode);
        updateCampaignItem(item.id, { reason });
      }
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
      // Throws are infrastructure-level failures (SHARED).
      const blockerKind: BlockerKind = "infrastructure";
      updateRunStatus(runId, "abandoned");
      updateCampaignItem(item.id, {
        lifecycleStatus: "failed",
        outcome: "blocked",
        blockerKind,
        reason,
        requestedHumanAction: `resolve ${blockerKind} for ${item.ticketId} then resume`,
        continuePolicy: "hold_campaign",
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId,
        lifecycleStatus: "failed",
        outcome: "blocked",
      });
      if (tryTransitionCampaign(campaignId, "running", "paused")) {
        return { stopReason: "paused", itemRecords };
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
      // Dispatch returned failed — classify and apply FG-393 policy.
      const reason = dispatchResult.error ?? "invoke failed";
      const failureKind = failureKindForTask(dispatchResult.taskId);
      const blockerKind = classifyFailureKind(failureKind);
      const shared = isSharedBlocker(blockerKind);

      updateCampaignItem(item.id, {
        lifecycleStatus: "failed",
        outcome: "blocked",
        blockerKind,
        reason,
        requestedHumanAction: `resolve ${blockerKind} for ${item.ticketId} then resume`,
        continuePolicy: shared ? "hold_campaign" : "hold_dependents",
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId,
        lifecycleStatus: "failed",
        outcome: "blocked",
      });

      if (shared) {
        // Hold the whole campaign — remaining pending items stay pending.
        if (tryTransitionCampaign(campaignId, "running", "paused")) {
          return { stopReason: "paused", itemRecords };
        }
        const resultPostFail = getCampaign(campaignId);
        return {
          stopReason: resultPostFail?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }

      // LOCAL blocker — continue. Add to blockedItems so subsequent items can be evaluated.
      if (laterTicket) {
        blockedItems.push({ id: item.ticketId, ticket: laterTicket, blockerKind });
      } else {
        // Ticket not in ticketMap (deleted?). Use a synthetic entry with no related field
        // so downstream items get "unknown" relation and are conservatively held.
        blockedItems.push({
          id: item.ticketId,
          ticket: { id: item.ticketId, type: "story", status: "active", title: item.ticketId, body: "" } as StructuredTicket,
          blockerKind,
        });
      }

      // Cooperative pause check after failure: if already paused, stop the loop.
      if (!postCheck || postCheck.status !== "running") {
        return {
          stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }
    }
  }

  // All items processed. If any held items remain, campaign → paused (awaiting resume).
  // If no held items, campaign → complete (may be complete_with_issues per report verdict).
  if (anyHeld) {
    if (tryTransitionCampaign(campaignId, "running", "paused")) {
      return { stopReason: "paused", itemRecords };
    }
    const finalCheck = getCampaign(campaignId);
    return {
      stopReason: finalCheck?.status === "abandoned" ? "abandoned" : "paused",
      itemRecords,
    };
  }

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
  if (!campaign) {
    return { stopReason: "not_planned", itemRecords };
  }

  const items = listCampaignItems(id);
  const blocker = campaignBlocker(campaign, items, "start");
  if (blocker !== null) {
    if (blocker === "recovery_needed") {
      const inf = items.find(
        (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
      );
      return {
        stopReason: "recovery_needed",
        itemRecords: inf
          ? [{ itemId: inf.id, ticketId: inf.ticketId, runId: inf.runId, lifecycleStatus: inf.lifecycleStatus }]
          : [],
      };
    }
    return { stopReason: blocker, itemRecords };
  }

  if (!tryTransitionCampaignToRunning(id)) {
    return { stopReason: "already_running", itemRecords };
  }

  return driveRemainingItems(id, {
    dispatch: opts.dispatch ?? invoke,
    projectDir: campaign.projectDir!,
    mode: campaign.mode,
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
  if (!campaign) {
    return { stopReason: "not_paused", itemRecords };
  }

  const items = listCampaignItems(id);
  const blocker = campaignBlocker(campaign, items, "resume");
  if (blocker !== null) {
    if (blocker === "recovery_needed") {
      const inf = items.find(
        (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
      );
      return {
        stopReason: "recovery_needed",
        itemRecords: inf
          ? [{ itemId: inf.id, ticketId: inf.ticketId, runId: inf.runId, lifecycleStatus: inf.lifecycleStatus }]
          : [],
      };
    }
    return { stopReason: blocker, itemRecords };
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
    projectDir: campaign.projectDir!,
    mode: campaign.mode,
  });
}
