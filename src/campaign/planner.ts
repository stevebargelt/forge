import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Campaign, CampaignItem, SourceKind } from "../types/index.js";
import {
  addCampaignItem,
  createCampaign,
  getCampaign,
  setPlanHash,
} from "../store/campaigns.js";
import { listTickets } from "../backlog/structured.js";
import type { StructuredTicket } from "../backlog/structured.js";

export type PlanMode = "dry_run" | "pilot" | "sequential";
export type PlannerRecommendation = "sequential" | "held" | "needs_refinement" | "later_parallel_candidate";

// Local alias — NOT exported; consumers read executionMode as a string from canonicalContent JSON.
type ItemExecutionMode = "workflow" | "invoke";

// Local type — NOT exported.
type CanonicalItemEntry = {
  ticketId: string;
  executionMode: ItemExecutionMode;
  workflowName?: string;
  agentRole?: string;
};

// Per-item override for the execution mode escape hatch. Use executionMode:'invoke' only
// with an explicit agentRole; omitting it is a validation error in resolvePlan.
export type ItemModeOverride =
  | { executionMode: "workflow"; workflowName?: string }
  | { executionMode: "invoke"; agentRole: string };

export type ExplicitListInput = { kind: "list"; ticketIds: string[]; itemOverrides?: Record<string, ItemModeOverride> };
export type EpicInput = { kind: "epic"; epicId: string; itemOverrides?: Record<string, ItemModeOverride> };
export type MixedInput = {
  kind: "mixed";
  epicId: string;
  additions?: string[];
  exclusions?: string[];
  itemOverrides?: Record<string, ItemModeOverride>;
};

export type PlannerInput = ExplicitListInput | EpicInput | MixedInput;

export type CanonicalPlanContent = {
  advisoryAgentsUsed: boolean;
  advisoryRecommendationSummary: string | null;
  branchPrStrategy: string;
  dependencyDecisions: Record<string, unknown>;
  itemRecommendations: Record<string, PlannerRecommendation>;
  mode: string;
  orderedItems?: CanonicalItemEntry[];
  plannerAssumptions: string[];
  readinessGateAvailability: string;
  resolvedItemIds: string[];
  sourceInput: Record<string, unknown>;
};

export type PlanResult = {
  campaign: Campaign;
  canonicalContent: CanonicalPlanContent;
  items: CampaignItem[];
  planHash: string;
};

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function computePlanHash(content: CanonicalPlanContent): string {
  const canonical = sortKeysDeep(content);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sortByCreatedThenId(tickets: StructuredTicket[]): StructuredTicket[] {
  return [...tickets].sort((a, b) => {
    if (a.created && b.created) {
      const cmp = a.created.localeCompare(b.created);
      if (cmp !== 0) return cmp;
    } else if (a.created) {
      return -1;
    } else if (b.created) {
      return 1;
    }
    return a.id.localeCompare(b.id);
  });
}

function expandEpic(projectDir: string, epicId: string): string[] {
  const epics = listTickets(projectDir, { type: "epic" });
  const epicTicket = epics.find((t) => t.id === epicId);
  if (!epicTicket) throw new Error(`Epic ${epicId} not found in backlog`);

  const allStories = listTickets(projectDir, { type: "story" });
  const children = allStories.filter((t) => t.status === "active" && t.epic === epicId);

  if (children.length === 0) {
    throw new Error(`Epic ${epicId} has no active child stories`);
  }

  const childMap = new Map<string, StructuredTicket>(children.map((s) => [s.id, s]));
  const relatedInOrder = (epicTicket.related ?? []).filter((id) => childMap.has(id));

  if (relatedInOrder.length > 0) {
    const relatedSet = new Set(relatedInOrder);
    const remaining = sortByCreatedThenId(children.filter((s) => !relatedSet.has(s.id)));
    return [...relatedInOrder, ...remaining.map((s) => s.id)];
  }

  return sortByCreatedThenId(children).map((s) => s.id);
}

function resolveExplicitList(projectDir: string, ticketIds: string[]): string[] {
  if (ticketIds.length === 0) throw new Error("Ticket list must not be empty");
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const id of ticketIds) {
    if (seen.has(id)) dupes.push(id);
    else seen.add(id);
  }
  if (dupes.length > 0) {
    throw new Error(`Duplicate ticket ids in explicit list: ${[...new Set(dupes)].join(", ")}`);
  }
  const all = listTickets(projectDir);
  const allIds = new Set(all.map((t) => t.id));
  const missing = ticketIds.filter((id) => !allIds.has(id));
  if (missing.length > 0) throw new Error(`Tickets not found in backlog: ${missing.join(", ")}`);
  return [...ticketIds];
}

function resolveMixed(
  projectDir: string,
  epicId: string,
  additions: string[],
  exclusions: string[]
): string[] {
  const addSeen = new Set<string>();
  const addDupes: string[] = [];
  for (const id of additions) {
    if (addSeen.has(id)) addDupes.push(id);
    else addSeen.add(id);
  }
  if (addDupes.length > 0) {
    throw new Error(`Duplicate ids in --add: ${[...new Set(addDupes)].join(", ")}`);
  }

  const epicIds = expandEpic(projectDir, epicId);
  const exclusionSet = new Set(exclusions);
  const afterExclusions = epicIds.filter((id) => !exclusionSet.has(id));

  if (additions.length > 0) {
    const all = listTickets(projectDir);
    const allIds = new Set(all.map((t) => t.id));
    const missing = additions.filter((id) => !allIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Added tickets not found in backlog: ${missing.join(", ")}`);
    }
  }

  const postExclusionSet = new Set(afterExclusions);
  const alreadyPresent = additions.filter((id) => postExclusionSet.has(id));
  if (alreadyPresent.length > 0) {
    throw new Error(
      `--add re-adds ids already in epic expansion (after exclusions): ${alreadyPresent.join(", ")}`
    );
  }

  const result = [...afterExclusions, ...additions];

  if (result.length === 0) {
    throw new Error(
      `Mixed plan resolved to empty set for epic ${epicId} with the given exclusions/additions`
    );
  }

  return result;
}

function buildNormalizedSourceInput(input: PlannerInput): Record<string, unknown> {
  const overrides = input.itemOverrides && Object.keys(input.itemOverrides).length > 0
    ? { itemOverrides: input.itemOverrides }
    : {};
  if (input.kind === "list") return { kind: "list", ticketIds: [...input.ticketIds], ...overrides };
  if (input.kind === "epic") return { kind: "epic", epicId: input.epicId, ...overrides };
  return {
    kind: "mixed",
    epicId: input.epicId,
    additions: [...(input.additions ?? [])],
    exclusions: [...(input.exclusions ?? [])],
    ...overrides,
  };
}

export type ResolvePlanResult = {
  resolvedIds: string[];
  sourceKind: SourceKind;
  normalizedSourceInput: Record<string, unknown>;
  canonicalContent: CanonicalPlanContent;
  planHash: string;
};

export function resolvePlan(
  input: PlannerInput,
  opts: { projectDir: string; mode?: PlanMode }
): ResolvePlanResult {
  const { projectDir, mode = "dry_run" } = opts;

  let resolvedIds: string[];
  let sourceKind: SourceKind;

  if (input.kind === "list") {
    resolvedIds = resolveExplicitList(projectDir, input.ticketIds);
    sourceKind = "list";
  } else if (input.kind === "epic") {
    resolvedIds = expandEpic(projectDir, input.epicId);
    sourceKind = "epic";
  } else {
    resolvedIds = resolveMixed(
      projectDir,
      input.epicId,
      input.additions ?? [],
      input.exclusions ?? []
    );
    sourceKind = "mixed";
  }

  const idSet = new Set<string>();
  const finalDupes: string[] = [];
  for (const id of resolvedIds) {
    if (idSet.has(id)) finalDupes.push(id);
    else idSet.add(id);
  }
  if (finalDupes.length > 0) {
    throw new Error(`Planner resolved duplicate ids: ${[...new Set(finalDupes)].join(", ")}`);
  }

  const normalizedSourceInput = buildNormalizedSourceInput(input);

  const itemRecommendations: Record<string, PlannerRecommendation> = {};
  for (const id of resolvedIds) {
    itemRecommendations[id] = "sequential";
  }

  // Build per-item execution mode entries. Default is workflow/feature; per-item overrides
  // require an explicit opt-in. Invoke mode is an escape hatch and must name an agentRole.
  const overrides = input.itemOverrides ?? {};
  const invokeWithoutRole = Object.entries(overrides).filter(
    ([, ov]) => ov.executionMode === "invoke" && !("agentRole" in ov && (ov as { agentRole?: string }).agentRole)
  );
  if (invokeWithoutRole.length > 0) {
    throw new Error(
      `executionMode='invoke' requires an explicit agentRole for: ${invokeWithoutRole.map(([id]) => id).join(", ")}`
    );
  }

  const orderedItems: CanonicalItemEntry[] = resolvedIds.map((ticketId) => {
    const ov = overrides[ticketId];
    if (ov && ov.executionMode === "invoke") {
      return { ticketId, executionMode: "invoke", agentRole: ov.agentRole };
    }
    const workflowName =
      ov && ov.executionMode === "workflow" && ov.workflowName ? ov.workflowName : "feature";
    return { ticketId, executionMode: "workflow", workflowName };
  });

  const canonicalContent: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations,
    mode,
    orderedItems,
    plannerAssumptions: [
      "items executed sequentially unless mode overridden",
      "readiness preflight skipped (FG-382 unavailable)",
    ],
    readinessGateAvailability: "unavailable: FG-382 not built",
    resolvedItemIds: resolvedIds,
    sourceInput: normalizedSourceInput,
  };

  const planHash = computePlanHash(canonicalContent);

  return { resolvedIds, sourceKind, normalizedSourceInput, canonicalContent, planHash };
}

export function planCampaign(
  input: PlannerInput,
  opts: { projectDir: string; mode?: PlanMode }
): PlanResult {
  const { projectDir, mode = "dry_run" } = opts;
  const absoluteProjectDir = resolve(projectDir);

  const { resolvedIds, sourceKind, normalizedSourceInput, canonicalContent, planHash } = resolvePlan(
    input,
    { projectDir: absoluteProjectDir, mode }
  );

  const campaign = createCampaign({
    sourceKind,
    sourceInput: normalizedSourceInput,
    mode,
    metadata: { planContent: canonicalContent },
    projectDir: absoluteProjectDir,
  });

  setPlanHash(campaign.id, planHash);

  const items: CampaignItem[] = [];
  for (let i = 0; i < resolvedIds.length; i++) {
    items.push(
      addCampaignItem({
        campaignId: campaign.id,
        itemOrder: i,
        ticketId: resolvedIds[i]!,
      })
    );
  }

  const updatedCampaign = getCampaign(campaign.id)!;

  return { campaign: updatedCampaign, canonicalContent, items, planHash };
}
