import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCampaign, listCampaignItems } from "../store/campaigns.js";
import { listTickets, readTicket } from "../backlog/structured.js";
import { resolvePlan } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import type { Campaign, CampaignItem } from "../types/index.js";
import { campaignBlocker } from "./executor.js";

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

function computeCurrentPlanHash(campaign: Campaign): string | null {
  if (!campaign.projectDir) return null;
  if (!existsSync(campaign.projectDir) || !existsSync(join(campaign.projectDir, "backlog"))) return null;
  try {
    const plannerInput = sourceInputToPlannerInput(campaign.sourceInput);
    const { planHash } = resolvePlan(plannerInput, {
      projectDir: campaign.projectDir,
      mode: campaign.mode as PlanMode,
    });
    return planHash;
  } catch {
    return null;
  }
}

function computeDirtyGitState(projectDir: string): string | null {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 5000,
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function findInFlightItem(items: CampaignItem[]): CampaignItem | undefined {
  return items.find(
    (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
  );
}

function recoveryNeededAction(item: CampaignItem): string {
  const runPart = item.runId ? ` (run ${item.runId})` : "";
  return `recovery needed: item ${item.ticketId} is ${item.lifecycleStatus}${runPart} — inspect the run; reset the item to pending or mark it failed before continuing`;
}

function computeNextShowAction(campaign: Campaign, items: CampaignItem[]): string {
  if (campaign.status === "running") {
    const inf = findInFlightItem(items);
    if (inf && inf.lifecycleStatus !== "running") return recoveryNeededAction(inf);
    return "running";
  }
  if (campaign.status === "complete") return "complete — none";
  if (campaign.status === "failed") return "failed — investigate";
  if (campaign.status === "abandoned") return "abandoned — none";

  const intent = campaign.status === "planned" ? "start" : "resume";
  const blocker = campaignBlocker(campaign, items, intent);
  if (blocker === "recovery_needed") return recoveryNeededAction(findInFlightItem(items)!);
  if (blocker === "not_approved") return "approve";
  if (blocker === "dry_run_not_executable") return "dry_run: re-plan with --mode pilot or --mode sequential to execute";
  if (blocker === "stale_plan") return "stale: re-plan";
  return intent === "start" ? "start" : "resume";
}

export type SafetyToContinue =
  | "can_resume"
  | "can_start"
  | "terminal"
  | "running"
  | "needs_approval"
  | "stale"
  | "recovery_needed"
  | "dry_run_not_executable";

export type CampaignVerdict = "all_shipped" | "complete_with_issues" | "not_complete";

function computeSafety(campaign: Campaign, items: CampaignItem[]): SafetyToContinue {
  if (campaign.status === "running") {
    const inf = findInFlightItem(items);
    if (inf && inf.lifecycleStatus !== "running") return "recovery_needed";
    return "running";
  }
  if (campaign.status === "complete" || campaign.status === "failed" || campaign.status === "abandoned") {
    return "terminal";
  }

  const intent = campaign.status === "planned" ? "start" : "resume";
  const blocker = campaignBlocker(campaign, items, intent);
  if (blocker === "recovery_needed") return "recovery_needed";
  if (blocker === "not_approved") return "needs_approval";
  if (blocker === "dry_run_not_executable") return "dry_run_not_executable";
  if (blocker === "stale_plan") return "stale";
  if (blocker === null) return intent === "start" ? "can_start" : "can_resume";
  // not_planned / not_paused / no_project_dir / invalid_project_dir: treat as non-continuable
  return "terminal";
}

function computeVerdict(campaign: Campaign, items: CampaignItem[]): CampaignVerdict {
  if (campaign.status !== "complete") return "not_complete";
  const allShipped = items.length > 0 && items.every((i) => i.outcome === "shipped");
  return allShipped ? "all_shipped" : "complete_with_issues";
}

function computeNextOperatorAction(
  campaign: Campaign,
  verdict: CampaignVerdict,
  items: CampaignItem[]
): string {
  if (campaign.status === "running") {
    const inf = findInFlightItem(items);
    if (inf && inf.lifecycleStatus !== "running") return recoveryNeededAction(inf);
    return "campaign is running — monitor progress";
  }
  if (campaign.status === "complete") {
    if (verdict === "all_shipped") return "none — campaign complete (all items shipped)";
    return "review blocked/failed/skipped items";
  }
  if (campaign.status === "failed") return "investigate failure and re-plan or abandon";
  if (campaign.status === "abandoned") return "none — campaign abandoned";

  const intent = campaign.status === "planned" ? "start" : "resume";
  const blocker = campaignBlocker(campaign, items, intent);
  if (blocker === "recovery_needed") return recoveryNeededAction(findInFlightItem(items)!);
  if (blocker === "not_approved") return "approve the campaign, then start";
  if (blocker === "dry_run_not_executable") return "dry_run: re-plan with --mode pilot or --mode sequential to execute";
  if (blocker === "stale_plan") return "stale: re-plan and re-approve";
  if (blocker === null) return intent === "start" ? "start the campaign" : "resume the campaign when ready";
  return `campaign is ${campaign.status} — check status`;
}

export type ShowItemRow = {
  ticketId: string;
  title: string | null;
  lifecycleStatus: string;
  outcome: string | null;
  blockerKind: string | null;
  continuePolicy: string | null;
  runId: string | null;
  reason: string | null;
  requestedHumanAction: string | null;
};

export type ShowResult = {
  campaignId: string;
  status: string;
  mode: string;
  approvedPlanHash: string | null;
  currentPlanHash: string | null;
  planStale: boolean | null;
  projectDir: string | null;
  activeItem: { ticketId: string; runId: string } | null;
  items: ShowItemRow[];
  nextAction: string;
};

export function assembleCampaignShow(id: string): ShowResult | null {
  const campaign = getCampaign(id);
  if (!campaign) return null;

  const items = listCampaignItems(id);
  const currentPlanHash = computeCurrentPlanHash(campaign);

  const planStale =
    campaign.approvedPlanHash && currentPlanHash
      ? currentPlanHash !== campaign.approvedPlanHash
      : null;

  // Build title map (best-effort)
  const titleMap = new Map<string, string>();
  if (campaign.projectDir && existsSync(campaign.projectDir)) {
    try {
      const tickets = listTickets(campaign.projectDir);
      for (const t of tickets) titleMap.set(t.id, t.title);
    } catch {
      // ignore
    }
  }

  const activeItem = items.find((i) => i.lifecycleStatus === "running") ?? null;

  const itemRows: ShowItemRow[] = items.map((i) => ({
    ticketId: i.ticketId,
    title: titleMap.get(i.ticketId) ?? null,
    lifecycleStatus: i.lifecycleStatus,
    outcome: i.outcome ?? null,
    blockerKind: i.blockerKind ?? null,
    continuePolicy: i.continuePolicy ?? null,
    runId: i.runId ?? null,
    reason: i.reason ?? null,
    requestedHumanAction: i.requestedHumanAction ?? null,
  }));

  const nextAction = computeNextShowAction(campaign, items);

  return {
    campaignId: campaign.id,
    status: campaign.status,
    mode: campaign.mode,
    approvedPlanHash: campaign.approvedPlanHash ?? null,
    currentPlanHash,
    planStale,
    projectDir: campaign.projectDir ?? null,
    activeItem: activeItem
      ? { ticketId: activeItem.ticketId, runId: activeItem.runId ?? "" }
      : null,
    items: itemRows,
    nextAction,
  };
}

export type ReportItemRow = ShowItemRow & {
  branch: null;
  worktreePath: null;
  prUrl: null;
  commit: string | null;
  verificationState: null;
  doneAuditState: null;
  reviewerResult: null;
};

export type ReportGroupings = {
  shipped: string[];
  blocked: string[];
  held: string[];
  skipped: string[];
  failed: string[];
};

export type ReportResult = {
  campaignId: string;
  sourceInput: Record<string, unknown>;
  goal: string | null;
  mode: string;
  status: string;
  approvedPlanHash: string | null;
  currentPlanHash: string | null;
  safetyToContinue: SafetyToContinue;
  verdict: CampaignVerdict;
  items: ReportItemRow[];
  groupings: ReportGroupings;
  dirtyGitState: string | null;
  deferredScope: unknown[];
  followUpTickets: unknown[];
  nextOperatorAction: string;
};

export function assembleCampaignReport(id: string): ReportResult | null {
  const campaign = getCampaign(id);
  if (!campaign) return null;

  const items = listCampaignItems(id);
  const currentPlanHash = computeCurrentPlanHash(campaign);

  // Build title + commit map (best-effort)
  const titleMap = new Map<string, string>();
  const commitMap = new Map<string, string>();
  if (campaign.projectDir && existsSync(campaign.projectDir)) {
    try {
      const tickets = listTickets(campaign.projectDir);
      for (const t of tickets) {
        titleMap.set(t.id, t.title);
        if (t.closedCommit) commitMap.set(t.id, t.closedCommit);
      }
    } catch {
      // ignore
    }
    // Also try readTicket for items with outcome=shipped that might be in done/
    for (const item of items) {
      if (item.outcome === "shipped" && !commitMap.has(item.ticketId)) {
        try {
          const t = readTicket(campaign.projectDir, item.ticketId);
          if (t.closedCommit) commitMap.set(t.id, t.closedCommit);
          if (t.title) titleMap.set(t.id, t.title);
        } catch {
          // ignore
        }
      }
    }
  }

  const safetyToContinue = computeSafety(campaign, items);
  const verdict = computeVerdict(campaign, items);
  const nextOperatorAction = computeNextOperatorAction(campaign, verdict, items);

  const goal =
    campaign.metadata?.["goal"] !== undefined
      ? String(campaign.metadata["goal"])
      : null;

  const itemRows: ReportItemRow[] = items.map((i) => ({
    ticketId: i.ticketId,
    title: titleMap.get(i.ticketId) ?? null,
    lifecycleStatus: i.lifecycleStatus,
    outcome: i.outcome ?? null,
    blockerKind: i.blockerKind ?? null,
    continuePolicy: i.continuePolicy ?? null,
    runId: i.runId ?? null,
    reason: i.reason ?? null,
    requestedHumanAction: i.requestedHumanAction ?? null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    commit: commitMap.get(i.ticketId) ?? null,
    verificationState: null,
    doneAuditState: null,
    reviewerResult: null,
  }));

  const groupings: ReportGroupings = {
    shipped: items.filter((i) => i.outcome === "shipped").map((i) => i.ticketId),
    blocked: items.filter((i) => i.outcome === "blocked").map((i) => i.ticketId),
    held: items.filter((i) => i.outcome === "held").map((i) => i.ticketId),
    skipped: items.filter((i) => i.outcome === "skipped").map((i) => i.ticketId),
    failed: items.filter((i) => i.outcome === "failed" || i.outcome === "needs_refinement").map((i) => i.ticketId),
  };

  const dirtyGitState =
    campaign.projectDir && existsSync(campaign.projectDir)
      ? computeDirtyGitState(campaign.projectDir)
      : null;

  return {
    campaignId: campaign.id,
    sourceInput: campaign.sourceInput,
    goal,
    mode: campaign.mode,
    status: campaign.status,
    approvedPlanHash: campaign.approvedPlanHash ?? null,
    currentPlanHash,
    safetyToContinue,
    verdict,
    items: itemRows,
    groupings,
    dirtyGitState,
    deferredScope: [],
    followUpTickets: [],
    nextOperatorAction,
  };
}
