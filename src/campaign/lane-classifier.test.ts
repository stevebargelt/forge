// FG-442 — lane-classifier.ts: deterministic routeKey->lane projection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { projectPolicyPath } from "../raci/project.js";
import type { RoutingPolicy } from "../raci/policy-schema.js";
import { projectRouteToLane, classifyItemsForPlan } from "./lane-classifier.js";
import type { ClassifyTicketFn } from "./lane-classifier.js";
import type { StructuredTicket } from "../backlog/structured.js";

function baseRoute(overrides: Partial<RoutingPolicy["routes"][string]> = {}): RoutingPolicy["routes"][string] {
  return {
    responsible: "engineer",
    path: "invoke",
    consulted: [],
    required_followups: [],
    informed: [],
    force_rules: [],
    ...overrides,
  };
}

function fullPolicy(): RoutingPolicy {
  return {
    version: 1,
    governance: { accountable: "human" },
    routes: {
      implementation_full: baseRoute({ path: "workflow" }),
      implementation_quick: baseRoute({ path: "invoke_chain" }),
      documentation_durable: baseRoute({ responsible: "documentation-maintainer", path: "invoke" }),
      testing_automation: baseRoute({ responsible: "test-engineer", path: "invoke" }),
      research: baseRoute({ responsible: "researcher", path: "invoke" }),
      review_wide: baseRoute({ responsible: "red-wide", path: "invoke" }),
      review_narrow: baseRoute({ responsible: "red-narrow", path: "invoke" }),
      review_frontend: baseRoute({ responsible: "red-frontend", path: "invoke" }),
      review_backend: baseRoute({ responsible: "red-backend", path: "invoke" }),
      review_security: baseRoute({ responsible: "red-security", path: "invoke" }),
      ticketing: baseRoute({ responsible: "orchestrator", path: "cli", command: "forge backlog file" }),
      some_manual_route: baseRoute({ path: "manual" }),
    },
  };
}

function project(policy?: RoutingPolicy): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-lane-classifier-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  if (policy) {
    writeFileSync(projectPolicyPath(dir), yamlStringify(policy));
  }
  return dir;
}

function ticket(id: string): StructuredTicket {
  return { id, type: "story", status: "active", title: `Ticket ${id}`, body: "" };
}

// ── projectRouteToLane — the taxonomy mapping table ─────────────────────────

test("projectRouteToLane: implementation_full -> full_feature, no agentRole", () => {
  const policy = fullPolicy();
  const r = projectRouteToLane("implementation_full", policy);
  assert.equal(r.lane, "full_feature");
  assert.equal(r.agentRole, undefined);
});

test("projectRouteToLane: implementation_quick -> quick_implementation, no agentRole", () => {
  const r = projectRouteToLane("implementation_quick", fullPolicy());
  assert.equal(r.lane, "quick_implementation");
  assert.equal(r.agentRole, undefined);
});

test("projectRouteToLane: documentation_durable -> docs_only, carries responsible as agentRole", () => {
  const r = projectRouteToLane("documentation_durable", fullPolicy());
  assert.equal(r.lane, "docs_only");
  assert.equal(r.agentRole, "documentation-maintainer");
});

test("projectRouteToLane: testing_automation -> test_only, carries responsible as agentRole", () => {
  const r = projectRouteToLane("testing_automation", fullPolicy());
  assert.equal(r.lane, "test_only");
  assert.equal(r.agentRole, "test-engineer");
});

test("projectRouteToLane: research -> research_only, carries responsible as agentRole", () => {
  const r = projectRouteToLane("research", fullPolicy());
  assert.equal(r.lane, "research_only");
  assert.equal(r.agentRole, "researcher");
});

test("projectRouteToLane: all five review_* routes collapse to review_only, carrying their own responsible role", () => {
  const policy = fullPolicy();
  for (const [routeKey, expectedRole] of [
    ["review_wide", "red-wide"],
    ["review_narrow", "red-narrow"],
    ["review_frontend", "red-frontend"],
    ["review_backend", "red-backend"],
    ["review_security", "red-security"],
  ] as const) {
    const r = projectRouteToLane(routeKey, policy);
    assert.equal(r.lane, "review_only", `${routeKey} must map to review_only`);
    assert.equal(r.agentRole, expectedRole, `${routeKey} must carry responsible role ${expectedRole}`);
  }
});

test("projectRouteToLane: ticketing -> ticketing_only, no agentRole (forbidden for this lane)", () => {
  const r = projectRouteToLane("ticketing", fullPolicy());
  assert.equal(r.lane, "ticketing_only");
  assert.equal(r.agentRole, undefined);
});

test("projectRouteToLane: a route with path='manual' -> lane manual", () => {
  const r = projectRouteToLane("some_manual_route", fullPolicy());
  assert.equal(r.lane, "manual");
  assert.match(r.laneRationale, /path 'manual'/);
});

test("projectRouteToLane: an unmatched route key (not in the compiled policy) -> lane manual, never guessed", () => {
  const r = projectRouteToLane("totally_unknown_route", fullPolicy());
  assert.equal(r.lane, "manual");
  assert.match(r.laneRationale, /not found in compiled policy/);
});

// ── classifyItemsForPlan — assembly into itemOverrides ──────────────────────

test("classifyItemsForPlan: builds one itemOverrides entry per ticket via the injected classifyTicket judgment", () => {
  const dir = project(fullPolicy());
  const tickets = [ticket("FG-1"), ticket("FG-2"), ticket("FG-3")];
  const routeFor: Record<string, string> = {
    "FG-1": "implementation_quick",
    "FG-2": "documentation_durable",
    "FG-3": "review_security",
  };
  const classifyTicket: ClassifyTicketFn = (t) => routeFor[t.id]!;

  const result = classifyItemsForPlan(tickets, { projectDir: dir, classifyTicket });

  assert.equal(result.itemOverrides["FG-1"]!.lane, "quick_implementation");
  assert.equal(result.itemOverrides["FG-2"]!.lane, "docs_only");
  assert.equal(result.itemOverrides["FG-2"]!.agentRole, "documentation-maintainer");
  assert.equal(result.itemOverrides["FG-3"]!.lane, "review_only");
  assert.equal(result.itemOverrides["FG-3"]!.agentRole, "red-security");

  assert.equal(result.classifications.length, 3);
  assert.equal(result.policySource, "project");

  rmSync(dir, { recursive: true, force: true });
});

test("classifyItemsForPlan: every proposal carries a non-empty laneRationale and a materialLaneAssumptions array", () => {
  const dir = project(fullPolicy());
  const tickets = [ticket("FG-1")];
  const result = classifyItemsForPlan(tickets, {
    projectDir: dir,
    classifyTicket: () => "implementation_full",
  });
  const entry = result.itemOverrides["FG-1"]!;
  assert.ok(entry.laneRationale && entry.laneRationale.length > 0);
  assert.ok(Array.isArray(entry.materialLaneAssumptions));
  assert.ok(entry.materialLaneAssumptions!.length > 0);

  rmSync(dir, { recursive: true, force: true });
});

test("classifyItemsForPlan: no compiled routing policy available -> every ticket falls to lane 'manual', deterministic, no throw", () => {
  const dir = project(); // no routing-policy.yml written
  const tickets = [ticket("FG-1"), ticket("FG-2")];
  const result = classifyItemsForPlan(tickets, {
    projectDir: dir,
    classifyTicket: () => "implementation_full", // must never be reached — policy is unavailable
  });

  assert.equal(result.itemOverrides["FG-1"]!.lane, "manual");
  assert.equal(result.itemOverrides["FG-2"]!.lane, "manual");
  // FG-583: with no project override and no published seed generation, the effective
  // host policy is unavailable — the classifier falls closed to 'manual' and names the
  // no-generation state (the flat routing-policy.yml is never consulted).
  assert.match(
    result.itemOverrides["FG-1"]!.laneRationale!,
    /no seed generation is published|routing policy not compiled or missing/,
  );

  rmSync(dir, { recursive: true, force: true });
});

test("classifyItemsForPlan: classifyTicket receives the ticket and the loaded policy (injectable judgment, not inferred)", () => {
  const dir = project(fullPolicy());
  const tickets = [ticket("FG-1")];
  const seen: { ticketId?: string; hasRoutes?: boolean } = {};
  classifyItemsForPlan(tickets, {
    projectDir: dir,
    classifyTicket: (t, policy) => {
      seen.ticketId = t.id;
      seen.hasRoutes = Object.keys(policy.routes).length > 0;
      return "implementation_full";
    },
  });
  assert.equal(seen.ticketId, "FG-1");
  assert.equal(seen.hasRoutes, true);

  rmSync(dir, { recursive: true, force: true });
});
