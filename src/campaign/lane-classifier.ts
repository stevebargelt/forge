// FG-442 — deterministic routeKey->lane projection for campaign planning.
//
// Classification is HYBRID: an agent/orchestrator judges which routing-policy
// route a ticket falls under (classifyTicket, injected by the CLI caller — real
// LLM/agent classification lives there, never here). This module only PROJECTS
// that already-decided route key onto one of the 8 execution lanes, using the
// compiled routing policy (loadPolicy/resolvePolicyPath) as the taxonomy source
// — never a second hardcoded route table, and never a keyword/heuristic match
// over ticket content (the RACI invariant: forge code never keyword-matches
// prompts into routes).
//
// Synchronous and side-effect-free beyond the policy file read, so it unit-tests
// cleanly and stays clearly separate from resolvePlan (which must never call an
// agent and must stay a pure function of (input, on-disk backlog)). The CLI
// caller runs this BEFORE planCampaign/resolvePlan and folds the result into
// itemOverrides.

import { loadPolicy } from "../raci/governance.js";
import { resolvePolicyPath } from "../raci/project.js";
import type { SeedGeneration } from "../v2/seed-generation.js";
import type { RoutingPolicy } from "../raci/policy-schema.js";
import type { StructuredTicket } from "../backlog/structured.js";
import type { ExecutionLane, ItemModeOverride } from "./planner.js";

/** Injected judgment: which compiled-policy route key does this ticket fall
 *  under? Real callers back this with an agent/orchestrator decision; forge
 *  code itself never infers a route from ticket content. */
export type ClassifyTicketFn = (ticket: StructuredTicket, policy: RoutingPolicy) => string;

export type LaneClassification = {
  ticketId: string;
  routeKey: string;
  lane: ExecutionLane;
  laneRationale: string;
  materialLaneAssumptions: string[];
  agentRole?: string;
};

// The lane taxonomy as a projection of ROUTE_PATHS-derived route keys — architect
// decision FG-442 #2. review_* routes all collapse to review_only, carrying the
// route's responsible role as the item's agentRole.
const ROUTE_KEY_TO_LANE: Record<string, ExecutionLane> = {
  implementation_full: "full_feature",
  implementation_quick: "quick_implementation",
  documentation_durable: "docs_only",
  testing_automation: "test_only",
  research: "research_only",
  review_wide: "review_only",
  review_narrow: "review_only",
  review_frontend: "review_only",
  review_backend: "review_only",
  review_security: "review_only",
  ticketing: "ticketing_only",
};

const LANES_CARRYING_AGENT_ROLE = new Set<ExecutionLane>(["docs_only", "test_only", "review_only", "research_only"]);

/** Projects one already-decided route key onto a lane + (when applicable) the
 *  route's responsible role. Unmatched route keys, and routes whose compiled
 *  `path` is 'manual', fall to lane 'manual' — never guessed. */
export function projectRouteToLane(
  routeKey: string,
  policy: RoutingPolicy
): { lane: ExecutionLane; agentRole?: string; laneRationale: string } {
  const mappedLane = ROUTE_KEY_TO_LANE[routeKey];
  const route = policy.routes[routeKey];

  if (mappedLane) {
    if (!LANES_CARRYING_AGENT_ROLE.has(mappedLane)) {
      return { lane: mappedLane, laneRationale: `policy route '${routeKey}' -> lane '${mappedLane}'` };
    }
    const agentRole = route?.responsible;
    return {
      lane: mappedLane,
      ...(agentRole ? { agentRole } : {}),
      laneRationale: `policy route '${routeKey}' -> lane '${mappedLane}'${agentRole ? ` (responsible: ${agentRole})` : ""}`,
    };
  }

  if (!route) {
    return { lane: "manual", laneRationale: `policy route '${routeKey}' not found in compiled policy -> lane 'manual'` };
  }
  return { lane: "manual", laneRationale: `policy route '${routeKey}' has path '${route.path}' -> lane 'manual'` };
}

export type ClassifyForPlanOpts = {
  projectDir: string;
  classifyTicket: ClassifyTicketFn;
  /** FG-583: the anchored seed generation whose compiled routing policy is the
   *  host taxonomy source. `undefined` → resolve the live pointer; a resolved
   *  generation pins the read. Never the flat ~/.forge/routing-policy.yml. */
  seedGeneration?: SeedGeneration | null;
};

export type ClassifyForPlanResult = {
  itemOverrides: Record<string, ItemModeOverride>;
  classifications: LaneClassification[];
  policySource: "host" | "project";
  policyPath: string;
};

/** Classifies every ticket into a lane and assembles an itemOverrides-shaped
 *  proposal ready to fold into planCampaign/resolvePlan. When the routing
 *  policy can't be loaded (uncompiled/missing), every ticket falls to 'manual'
 *  — deterministic, no guessing, no agent call from here. */
export function classifyItemsForPlan(
  tickets: StructuredTicket[],
  opts: ClassifyForPlanOpts
): ClassifyForPlanResult {
  const resolved = resolvePolicyPath(opts.projectDir, opts.seedGeneration);
  const policy = resolved.exists ? loadPolicy(resolved.path) : undefined;

  const itemOverrides: Record<string, ItemModeOverride> = {};
  const classifications: LaneClassification[] = [];
  const policyProvenance = resolved.noGeneration
    ? `routing policy source: host (no seed generation published — run: forge upgrade)`
    : `routing policy source: ${resolved.source} (${resolved.path})`;

  for (const ticket of tickets) {
    if (!policy) {
      const laneRationale = resolved.noGeneration
        ? `no seed generation is published (the effective host routing policy lives in the generation) -> lane 'manual'`
        : `routing policy not compiled or missing at ${resolved.path} -> lane 'manual'`;
      const materialLaneAssumptions = [policyProvenance];
      itemOverrides[ticket.id] = { lane: "manual", laneRationale, materialLaneAssumptions };
      classifications.push({ ticketId: ticket.id, routeKey: "(policy unavailable)", lane: "manual", laneRationale, materialLaneAssumptions });
      continue;
    }

    const routeKey = opts.classifyTicket(ticket, policy);
    const { lane, agentRole, laneRationale } = projectRouteToLane(routeKey, policy);
    const materialLaneAssumptions = [policyProvenance];

    itemOverrides[ticket.id] = {
      lane,
      laneRationale,
      materialLaneAssumptions,
      ...(agentRole ? { agentRole } : {}),
    };
    classifications.push({
      ticketId: ticket.id,
      routeKey,
      lane,
      laneRationale,
      materialLaneAssumptions,
      ...(agentRole ? { agentRole } : {}),
    });
  }

  return { itemOverrides, classifications, policySource: resolved.source, policyPath: resolved.path };
}
