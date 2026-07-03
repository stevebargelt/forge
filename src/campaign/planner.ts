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

// FG-442: the policy-derived execution lane for a campaign item. A projection of
// the compiled routing-policy ROUTE_PATHS (src/raci/governance.ts / project.ts) —
// see lane-classifier.ts for the routeKey->lane mapping. NOT a second hardcoded
// classification table: the mapping only decides which lane a given routing
// decision falls into, never which route a ticket falls into (that judgment is
// injected, never keyword-matched, per the RACI invariant).
export type ExecutionLane =
  | "full_feature"
  | "quick_implementation"
  | "docs_only"
  | "test_only"
  | "review_only"
  | "research_only"
  | "ticketing_only"
  | "manual";

const LANES_REQUIRING_AGENT_ROLE = new Set<ExecutionLane>(["docs_only", "test_only", "review_only", "research_only"]);
const LANES_FORBIDDING_AGENT_ROLE = new Set<ExecutionLane>(["full_feature", "quick_implementation", "ticketing_only", "manual"]);

// Local alias — NOT exported; consumers read executionMode as a string from canonicalContent JSON.
// 'invoke_chain' (quick_implementation's engineer->test-engineer chain) and 'none'
// (ticketing_only/manual — no dispatch) extend the original two values so every
// lane's underlying dispatch mechanism stays visible in the canonical entry.
type ItemExecutionMode = "workflow" | "invoke" | "invoke_chain" | "none";

// Local type — NOT exported.
type CanonicalItemEntry = {
  ticketId: string;
  executionMode: ItemExecutionMode;
  workflowName?: string;
  agentRole?: string;
  lane: ExecutionLane;
  laneRationale: string;
  materialLaneAssumptions: string[];
};

// Per-item override. executionMode/workflowName/agentRole are the pre-FG-442
// execution-mode escape hatch (still supported byte-for-byte — see foldItemEntry).
// lane/laneRationale/materialLaneAssumptions are the FG-442 policy-derived
// classification, assembled OUTSIDE resolvePlan (lane-classifier.ts + the CLI
// caller) and folded in here. lane is optional: when absent, resolvePlan derives
// a default that preserves pre-FG-442 behavior (see foldItemEntry).
export type ItemModeOverride = {
  executionMode?: "workflow" | "invoke";
  workflowName?: string;
  agentRole?: string;
  lane?: ExecutionLane;
  laneRationale?: string;
  materialLaneAssumptions?: string[];
};

// Validates the lane+agentRole combination an override supplies (or that
// foldItemEntry derives). Thrown errors surface at plan time, before anything
// is persisted.
function validateLaneAgentRole(ticketId: string, lane: ExecutionLane, agentRole: string | undefined): void {
  if (LANES_REQUIRING_AGENT_ROLE.has(lane) && !agentRole) {
    throw new Error(`lane '${lane}' requires an explicit agentRole for: ${ticketId}`);
  }
  if (LANES_FORBIDDING_AGENT_ROLE.has(lane) && agentRole) {
    throw new Error(`lane '${lane}' does not take an agentRole (got '${agentRole}') for: ${ticketId}`);
  }
}

// The underlying dispatch mechanism for a given lane — what executor.ts and
// report.ts surface as executionMode/workflowName/agentRole alongside the lane.
function executionShapeForLane(
  lane: ExecutionLane,
  agentRole: string | undefined,
  workflowName: string | undefined
): { executionMode: ItemExecutionMode; workflowName?: string; agentRole?: string } {
  switch (lane) {
    case "full_feature":
      return { executionMode: "workflow", workflowName: workflowName ?? "feature" };
    case "quick_implementation":
      return { executionMode: "invoke_chain" };
    case "docs_only":
    case "test_only":
    case "review_only":
    case "research_only":
      return { executionMode: "invoke", agentRole: agentRole! };
    case "ticketing_only":
    case "manual":
      return { executionMode: "none" };
  }
}

// Folds one item's override into its canonical entry. Three cases:
//   1. Explicit lane supplied (classifier or operator) — the FG-442 path.
//   2. Legacy executionMode:'invoke' override, no lane — preserves the
//      pre-FG-442 single-invoke escape hatch exactly via lane 'review_only'
//      (the lane whose dispatch mechanism IS a single invoke to a stored role).
//   3. Neither — default to full_feature (preserves current behavior).
function foldItemEntry(ticketId: string, ov: ItemModeOverride | undefined): CanonicalItemEntry {
  if (ov?.lane) {
    validateLaneAgentRole(ticketId, ov.lane, ov.agentRole);
    const shape = executionShapeForLane(ov.lane, ov.agentRole, ov.workflowName);
    return {
      ticketId,
      ...shape,
      lane: ov.lane,
      laneRationale: ov.laneRationale ?? `classified as ${ov.lane}`,
      materialLaneAssumptions: ov.materialLaneAssumptions ?? [],
    };
  }

  if (ov?.executionMode === "invoke") {
    // Validated upfront in resolvePlan (invokeWithoutRole) — agentRole is present.
    return {
      ticketId,
      executionMode: "invoke",
      agentRole: ov.agentRole!,
      lane: "review_only",
      laneRationale:
        "executionMode='invoke' override supplied without a lane — mapped to review_only (single-role invoke escape hatch)",
      materialLaneAssumptions: [],
    };
  }

  const workflowName = ov?.executionMode === "workflow" && ov.workflowName ? ov.workflowName : "feature";
  return {
    ticketId,
    executionMode: "workflow",
    workflowName,
    lane: "full_feature",
    laneRationale: "no lane override supplied — defaulting to full_feature",
    materialLaneAssumptions: [],
  };
}

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

  const orderedItems: CanonicalItemEntry[] = resolvedIds.map((ticketId) =>
    foldItemEntry(ticketId, overrides[ticketId])
  );

  // FG-442: advisoryAgentsUsed/advisoryRecommendationSummary were dead fields
  // (always false/null) pre-FG-442. Repurposed here for the lane classifier's
  // used flag + a summary — resolvePlan stays pure/synchronous: it only reads
  // whether the caller already supplied an explicit lane per item (the
  // classification happened outside, at plan-authoring time), never classifies
  // itself.
  const laneClassified = Object.values(overrides).some((ov) => ov.lane !== undefined);
  let advisoryRecommendationSummary: string | null = null;
  if (laneClassified) {
    const laneCounts = new Map<ExecutionLane, number>();
    for (const item of orderedItems) {
      laneCounts.set(item.lane, (laneCounts.get(item.lane) ?? 0) + 1);
    }
    advisoryRecommendationSummary = `lane classification: ${[...laneCounts.entries()]
      .map(([lane, count]) => `${lane}=${count}`)
      .sort()
      .join(", ")}`;
  }

  const canonicalContent: CanonicalPlanContent = {
    advisoryAgentsUsed: laneClassified,
    advisoryRecommendationSummary,
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

// Shared by executor.ts and report.ts (previously two independently-maintained
// copies — the report.ts one silently dropped itemOverrides, which made its
// staleness check diverge from the executor's for any plan using overrides).
export function sourceInputToPlannerInput(sourceInput: Record<string, unknown>): PlannerInput {
  const kind = sourceInput["kind"] as string;
  const itemOverrides = sourceInput["itemOverrides"] as Record<string, ItemModeOverride> | undefined;
  if (kind === "list") {
    return { kind: "list", ticketIds: (sourceInput["ticketIds"] as string[]) ?? [], ...(itemOverrides ? { itemOverrides } : {}) };
  }
  if (kind === "epic") {
    return { kind: "epic", epicId: sourceInput["epicId"] as string, ...(itemOverrides ? { itemOverrides } : {}) };
  }
  return {
    kind: "mixed",
    epicId: sourceInput["epicId"] as string,
    additions: sourceInput["additions"] as string[] | undefined,
    exclusions: sourceInput["exclusions"] as string[] | undefined,
    ...(itemOverrides ? { itemOverrides } : {}),
  };
}

export type ItemPlanEntry = {
  ticketId: string;
  lane: ExecutionLane;
  laneRationale: string;
  materialLaneAssumptions: string[];
  executionMode: string;
  workflowName?: string;
  agentRole?: string;
};

const DEFAULT_ITEM_PLAN_ENTRY: Omit<ItemPlanEntry, "ticketId"> = {
  lane: "full_feature",
  laneRationale: "no lane override supplied — defaulting to full_feature",
  materialLaneAssumptions: [],
  executionMode: "workflow",
  workflowName: "feature",
};

// Shared by executor.ts (dispatch) and report.ts (display) — reads one item's
// canonical plan entry out of campaign.metadata.planContent.orderedItems. This
// used to be two independently-maintained near-duplicates; factored here so
// both consumers read the identical shape.
export function getItemPlanEntry(canonicalContent: unknown, ticketId: string): ItemPlanEntry {
  const cc = canonicalContent as Record<string, unknown> | null | undefined;
  const orderedItems = cc?.["orderedItems"];
  if (Array.isArray(orderedItems)) {
    const found = orderedItems.find(
      (it) => typeof it === "object" && it !== null && (it as Record<string, unknown>)["ticketId"] === ticketId
    ) as Record<string, unknown> | undefined;
    if (found) {
      const materialLaneAssumptions = Array.isArray(found["materialLaneAssumptions"])
        ? (found["materialLaneAssumptions"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      return {
        ticketId,
        lane: (typeof found["lane"] === "string" ? found["lane"] : "full_feature") as ExecutionLane,
        laneRationale:
          typeof found["laneRationale"] === "string"
            ? found["laneRationale"]
            : "no lane override supplied — defaulting to full_feature",
        materialLaneAssumptions,
        executionMode: typeof found["executionMode"] === "string" ? found["executionMode"] : "workflow",
        workflowName: typeof found["workflowName"] === "string" ? found["workflowName"] : undefined,
        agentRole: typeof found["agentRole"] === "string" ? found["agentRole"] : undefined,
      };
    }
  }
  return { ticketId, ...DEFAULT_ITEM_PLAN_ENTRY };
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
