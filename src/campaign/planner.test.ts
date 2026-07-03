import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { listCampaignItems } from "../store/campaigns.js";
import { writeTicket } from "../backlog/structured.js";
import { computePlanHash, planCampaign, resolvePlan, getItemPlanEntry } from "./planner.js";
import type { CanonicalPlanContent, ItemModeOverride } from "./planner.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg391-unit-"));

  // FG-100: epic with explicit related[] ordering
  writeTicket(projectDir, {
    id: "FG-100",
    type: "epic",
    status: "active",
    title: "Main Epic",
    related: ["FG-101", "FG-103", "FG-102"],
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    epic: "FG-100",
    created: "2024-01-01",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-102",
    type: "story",
    status: "active",
    title: "Story Two",
    epic: "FG-100",
    created: "2024-01-02",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    created: "2024-01-03",
    body: "",
  });

  // FG-110: epic without related[] — tests created-date fallback
  writeTicket(projectDir, {
    id: "FG-110",
    type: "epic",
    status: "active",
    title: "Date-ordered Epic",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-111",
    type: "story",
    status: "active",
    title: "Story B",
    epic: "FG-110",
    created: "2024-02-02",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-112",
    type: "story",
    status: "active",
    title: "Story A",
    epic: "FG-110",
    created: "2024-02-01",
    body: "",
  });

  // FG-120: epic without related[] and without created dates — tests id fallback
  writeTicket(projectDir, {
    id: "FG-120",
    type: "epic",
    status: "active",
    title: "No-date Epic",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-122",
    type: "story",
    status: "active",
    title: "Story Z",
    epic: "FG-120",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-121",
    type: "story",
    status: "active",
    title: "Story A",
    epic: "FG-120",
    body: "",
  });

  // FG-130: empty epic (no active children)
  writeTicket(projectDir, {
    id: "FG-130",
    type: "epic",
    status: "active",
    title: "Empty Epic",
    body: "",
  });

  // FG-200: standalone story not belonging to any epic
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "active",
    title: "Standalone Story",
    body: "",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// ── explicit-list ─────────────────────────────────────────────────────────────

test("explicit-list: plans with given ticket order", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-200", "FG-101", "FG-102"] },
    { projectDir }
  );
  assert.equal(result.campaign.status, "planned");
  assert.equal(result.campaign.sourceKind, "list");
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0]?.ticketId, "FG-200");
  assert.equal(result.items[1]?.ticketId, "FG-101");
  assert.equal(result.items[2]?.ticketId, "FG-102");
});

test("explicit-list: item_order matches proposed sequence", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-103", "FG-101"] },
    { projectDir }
  );
  assert.equal(result.items[0]?.itemOrder, 0);
  assert.equal(result.items[0]?.ticketId, "FG-103");
  assert.equal(result.items[1]?.itemOrder, 1);
  assert.equal(result.items[1]?.ticketId, "FG-101");
});

test("explicit-list: items default to pending lifecycle", () => {
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  assert.equal(result.items[0]?.lifecycleStatus, "pending");
});

test("explicit-list: fails on missing ticket", () => {
  assert.throws(
    () => planCampaign({ kind: "list", ticketIds: ["FG-999"] }, { projectDir }),
    /not found in backlog/i
  );
});

test("explicit-list: fails on empty ticket list", () => {
  assert.throws(
    () => planCampaign({ kind: "list", ticketIds: [] }, { projectDir }),
    /must not be empty/i
  );
});

// ── epic expansion ────────────────────────────────────────────────────────────

test("epic expansion: uses related[] order when available", () => {
  // FG-100 has related: ["FG-101", "FG-103", "FG-102"]
  const result = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir });
  assert.deepEqual(
    result.items.map((i) => i.ticketId),
    ["FG-101", "FG-103", "FG-102"]
  );
});

test("epic expansion: falls back to created-date order when no related[]", () => {
  // FG-110 has no related[]; FG-112 created 2024-02-01, FG-111 created 2024-02-02
  const result = planCampaign({ kind: "epic", epicId: "FG-110" }, { projectDir });
  assert.deepEqual(
    result.items.map((i) => i.ticketId),
    ["FG-112", "FG-111"]
  );
});

test("epic expansion: falls back to id order when no dates", () => {
  // FG-120 has no related[], stories have no created date; FG-121 < FG-122
  const result = planCampaign({ kind: "epic", epicId: "FG-120" }, { projectDir });
  assert.deepEqual(
    result.items.map((i) => i.ticketId),
    ["FG-121", "FG-122"]
  );
});

test("epic expansion: fails when epic not found", () => {
  assert.throws(
    () => planCampaign({ kind: "epic", epicId: "FG-999" }, { projectDir }),
    /not found/i
  );
});

test("epic expansion: fails when epic has no active children", () => {
  assert.throws(
    () => planCampaign({ kind: "epic", epicId: "FG-130" }, { projectDir }),
    /no active child stories/i
  );
});

test("epic expansion: only active stories are included", () => {
  // Add a done story to FG-100
  writeTicket(projectDir, {
    id: "FG-104",
    type: "story",
    status: "done",
    title: "Done Story",
    epic: "FG-100",
    created: "2024-01-04",
    body: "",
  });
  const result = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir });
  const ids = result.items.map((i) => i.ticketId);
  assert.ok(!ids.includes("FG-104"), "done stories must not be included");
});

// ── mixed input ───────────────────────────────────────────────────────────────

test("mixed: exclusions remove from epic expansion", () => {
  // related[] order: FG-101, FG-103, FG-102; exclude FG-103
  const result = planCampaign(
    { kind: "mixed", epicId: "FG-100", exclusions: ["FG-103"] },
    { projectDir }
  );
  assert.deepEqual(
    result.items.map((i) => i.ticketId),
    ["FG-101", "FG-102"]
  );
});

test("mixed: additions appended in given order if not already present", () => {
  const result = planCampaign(
    {
      kind: "mixed",
      epicId: "FG-100",
      exclusions: ["FG-103"],
      additions: ["FG-200"],
    },
    { projectDir }
  );
  assert.deepEqual(
    result.items.map((i) => i.ticketId),
    ["FG-101", "FG-102", "FG-200"]
  );
});

test("mixed: adding id already in epic expansion is rejected", () => {
  assert.throws(
    () =>
      planCampaign(
        { kind: "mixed", epicId: "FG-100", additions: ["FG-101"] },
        { projectDir }
      ),
    /re-adds ids already in epic expansion/i
  );
});

test("mixed: fails on missing addition ticket", () => {
  assert.throws(
    () =>
      planCampaign(
        { kind: "mixed", epicId: "FG-100", additions: ["FG-999"] },
        { projectDir }
      ),
    /not found in backlog/i
  );
});

// ── plan_hash ─────────────────────────────────────────────────────────────────

test("plan_hash stability: equivalent content produces same hash", () => {
  const content: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential", "FG-102": "sequential" },
    mode: "dry_run",
    plannerAssumptions: ["a", "b"],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101", "FG-102"],
    sourceInput: { kind: "list", ticketIds: ["FG-101", "FG-102"] },
  };
  const copy: CanonicalPlanContent = { ...content };
  assert.equal(computePlanHash(content), computePlanHash(copy));
});

test("plan_hash stability: key insertion order does not matter", () => {
  const a: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101"],
    sourceInput: { kind: "list" },
  };
  // Build same object with reversed key insertion order
  const b = {
    sourceInput: { kind: "list" },
    resolvedItemIds: ["FG-101"],
    readinessGateAvailability: "unavailable",
    plannerAssumptions: [],
    mode: "dry_run",
    itemRecommendations: { "FG-101": "sequential" },
    dependencyDecisions: {},
    branchPrStrategy: "one-branch-per-item",
    advisoryRecommendationSummary: null,
    advisoryAgentsUsed: false,
  } as CanonicalPlanContent;
  assert.equal(computePlanHash(a), computePlanHash(b));
});

test("plan_hash sensitivity: different item order changes hash", () => {
  const base: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential", "FG-102": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101", "FG-102"],
    sourceInput: { kind: "list" },
  };
  const reordered: CanonicalPlanContent = { ...base, resolvedItemIds: ["FG-102", "FG-101"] };
  assert.notEqual(computePlanHash(base), computePlanHash(reordered));
});

test("plan_hash sensitivity: adding a ticket changes hash", () => {
  const base: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential", "FG-102": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101", "FG-102"],
    sourceInput: { kind: "list" },
  };
  const withExtra: CanonicalPlanContent = {
    ...base,
    itemRecommendations: { "FG-101": "sequential", "FG-102": "sequential", "FG-103": "sequential" },
    resolvedItemIds: ["FG-101", "FG-102", "FG-103"],
  };
  assert.notEqual(computePlanHash(base), computePlanHash(withExtra));
});

test("plan_hash sensitivity: different mode changes hash", () => {
  const base: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101"],
    sourceInput: { kind: "list" },
  };
  const pilot: CanonicalPlanContent = { ...base, mode: "pilot" };
  assert.notEqual(computePlanHash(base), computePlanHash(pilot));
});

test("planCampaign: plan_hash stored on campaign and matches result", () => {
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  assert.ok(result.planHash, "planHash must be set");
  assert.equal(result.campaign.planHash, result.planHash);
});

test("planCampaign: two equivalent plans produce the same hash", () => {
  const r1 = planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"] }, { projectDir });
  const r2 = planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"] }, { projectDir });
  assert.equal(r1.planHash, r2.planHash, "equivalent plans must produce the same hash");
  assert.notEqual(r1.campaign.id, r2.campaign.id, "but they are distinct campaigns");
});

// ── mode ─────────────────────────────────────────────────────────────────────

test("planCampaign: default mode is dry_run", () => {
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  assert.equal(result.campaign.mode, "dry_run");
  assert.equal(result.canonicalContent.mode, "dry_run");
});

test("planCampaign: mode override is stored", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  assert.equal(result.campaign.mode, "sequential");
  assert.equal(result.canonicalContent.mode, "sequential");
});

// ── no-execution guarantee ────────────────────────────────────────────────────

test("no execution: planning never creates rows in runs or tasks", () => {
  planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"] }, { projectDir });
  const { count: runsCount } = db
    .prepare("SELECT COUNT(*) as count FROM runs")
    .get() as { count: number };
  const { count: tasksCount } = db
    .prepare("SELECT COUNT(*) as count FROM tasks")
    .get() as { count: number };
  assert.equal(runsCount, 0, "no run rows must be created during planning");
  assert.equal(tasksCount, 0, "no task rows must be created during planning");
});

// ── persistence ───────────────────────────────────────────────────────────────

test("planCampaign: metadata contains canonical plan content", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir }
  );
  assert.ok(result.campaign.metadata?.planContent, "metadata.planContent must be set");
});

test("listCampaignItems: returns items in proposed order", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-102", "FG-101"] },
    { projectDir }
  );
  const items = listCampaignItems(result.campaign.id);
  assert.equal(items[0]?.ticketId, "FG-102");
  assert.equal(items[1]?.ticketId, "FG-101");
});

test("planCampaign: campaign starts with planned status", () => {
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  assert.equal(result.campaign.status, "planned");
});

test("readiness gate recorded as unavailable", () => {
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  assert.ok(
    result.canonicalContent.readinessGateAvailability.includes("unavailable"),
    "readiness gate must be marked unavailable"
  );
});

// ── plan_hash additional sensitivity / key-order ──────────────────────────────

test("plan_hash sensitivity: removing a ticket changes hash", () => {
  const base: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential", "FG-102": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101", "FG-102"],
    sourceInput: { kind: "list" },
  };
  const withRemoved: CanonicalPlanContent = {
    ...base,
    itemRecommendations: { "FG-101": "sequential" },
    resolvedItemIds: ["FG-101"],
  };
  assert.notEqual(computePlanHash(base), computePlanHash(withRemoved));
});

test("plan_hash key order: nested sourceInput and dependencyDecisions key insertion order does not affect hash", () => {
  // Exercises sortKeysDeep recursion on nested objects — top-level key order
  // is already covered by the "key insertion order" test above; this one
  // verifies recursion into sourceInput and dependencyDecisions specifically.
  const a: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: { dep_z: "first", dep_a: "second" },
    itemRecommendations: { "FG-101": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101"],
    sourceInput: { zKey: "z-value", aKey: "a-value", kind: "list" },
  };
  const b: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: { dep_a: "second", dep_z: "first" },
    itemRecommendations: { "FG-101": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101"],
    sourceInput: { aKey: "a-value", kind: "list", zKey: "z-value" },
  };
  assert.equal(computePlanHash(a), computePlanHash(b));
});

// ── epic expansion additional branches ────────────────────────────────────────

test("epic expansion: related[] entry pointing to a done ticket is excluded from expansion", () => {
  // FG-140 related includes FG-142 which is done — the childMap only contains
  // active stories, so FG-142 is silently dropped from relatedInOrder.
  writeTicket(projectDir, {
    id: "FG-140",
    type: "epic",
    status: "active",
    title: "Partial Done Epic",
    related: ["FG-141", "FG-142"],
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-141",
    type: "story",
    status: "active",
    title: "Active Child",
    epic: "FG-140",
    created: "2024-04-01",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-142",
    type: "story",
    status: "done",
    title: "Done Child",
    epic: "FG-140",
    created: "2024-04-02",
    body: "",
  });
  const result = planCampaign({ kind: "epic", epicId: "FG-140" }, { projectDir });
  assert.deepEqual(result.items.map((i) => i.ticketId), ["FG-141"]);
});

test("epic expansion: related[] entry pointing to a non-child ticket is ignored", () => {
  // FG-150 related includes FG-200 which belongs to a different epic.
  // childMap only has children of FG-150, so FG-200 is filtered out.
  writeTicket(projectDir, {
    id: "FG-150",
    type: "epic",
    status: "active",
    title: "Non-child Related Epic",
    related: ["FG-151", "FG-200"],
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-151",
    type: "story",
    status: "active",
    title: "Real Child",
    epic: "FG-150",
    created: "2024-05-01",
    body: "",
  });
  const result = planCampaign({ kind: "epic", epicId: "FG-150" }, { projectDir });
  assert.deepEqual(result.items.map((i) => i.ticketId), ["FG-151"]);
});

test("epic expansion: children not in related[] are appended sorted by created-date then id", () => {
  // FG-160 has related: ["FG-161"] — only one of three active children.
  // FG-162 (earlier date) and FG-163 (later date) are not in related[].
  // Expected: FG-161 (from related[]) then FG-162, FG-163 (sorted by date).
  writeTicket(projectDir, {
    id: "FG-160",
    type: "epic",
    status: "active",
    title: "Partial Related Epic",
    related: ["FG-161"],
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-161",
    type: "story",
    status: "active",
    title: "Related Child",
    epic: "FG-160",
    created: "2024-06-01",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-162",
    type: "story",
    status: "active",
    title: "Unrelated Child A",
    epic: "FG-160",
    created: "2024-06-02",
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-163",
    type: "story",
    status: "active",
    title: "Unrelated Child B",
    epic: "FG-160",
    created: "2024-06-03",
    body: "",
  });
  const result = planCampaign({ kind: "epic", epicId: "FG-160" }, { projectDir });
  assert.deepEqual(result.items.map((i) => i.ticketId), ["FG-161", "FG-162", "FG-163"]);
});

// ── mixed additional ──────────────────────────────────────────────────────────

test("mixed: excluding all epic children resolves to empty set and throws", () => {
  // FG-110 has exactly two active children: FG-111 and FG-112.
  // Excluding both leaves an empty resolved set.
  assert.throws(
    () =>
      planCampaign(
        { kind: "mixed", epicId: "FG-110", exclusions: ["FG-111", "FG-112"] },
        { projectDir }
      ),
    /mixed plan resolved to empty set/i
  );
});

// ── duplicate rejection ────────────────────────────────────────────────────────

test("explicit-list: duplicate ticket ids are rejected with clear error", () => {
  assert.throws(
    () =>
      planCampaign(
        { kind: "list", ticketIds: ["FG-101", "FG-102", "FG-101"] },
        { projectDir }
      ),
    /duplicate ticket ids in explicit list/i
  );
});

test("mixed: internal duplicate in --add is rejected with clear error", () => {
  assert.throws(
    () =>
      planCampaign(
        { kind: "mixed", epicId: "FG-100", additions: ["FG-200", "FG-200"] },
        { projectDir }
      ),
    /duplicate ids in --add/i
  );
});

// ── item recommendations ──────────────────────────────────────────────────────

test("item recommendations: all items get sequential recommendation in canonical content", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir }
  );
  assert.equal(result.canonicalContent.itemRecommendations["FG-101"], "sequential");
  assert.equal(result.canonicalContent.itemRecommendations["FG-102"], "sequential");
});

test("item recommendations: changing recommendation changes plan_hash", () => {
  const base: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101"],
    sourceInput: { kind: "list" },
  };
  const withHeld: CanonicalPlanContent = {
    ...base,
    itemRecommendations: { "FG-101": "held" },
  };
  assert.notEqual(computePlanHash(base), computePlanHash(withHeld));
});

test("item recommendations: stored in metadata.planContent", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir }
  );
  const stored = result.campaign.metadata?.planContent as CanonicalPlanContent;
  assert.ok(stored?.itemRecommendations, "itemRecommendations must be in metadata.planContent");
  assert.equal(stored.itemRecommendations["FG-101"], "sequential");
});

test("item recommendations: lifecycle status stays pending (not mutated by recommendations)", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir }
  );
  for (const item of result.items) {
    assert.equal(item.lifecycleStatus, "pending");
  }
});

test("item recommendations: map keys exactly match resolvedItemIds — no extras, no omissions", () => {
  const result = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102", "FG-103"] },
    { projectDir }
  );
  const recKeys = Object.keys(result.canonicalContent.itemRecommendations).sort();
  const resolvedIds = [...result.canonicalContent.resolvedItemIds].sort();
  assert.deepEqual(
    recKeys,
    resolvedIds,
    "itemRecommendations must have exactly one entry per resolved item"
  );
});

test("plan_hash sensitivity: itemRecommendations populated vs empty changes hash", () => {
  const withRecs: CanonicalPlanContent = {
    advisoryAgentsUsed: false,
    advisoryRecommendationSummary: null,
    branchPrStrategy: "one-branch-per-item",
    dependencyDecisions: {},
    itemRecommendations: { "FG-101": "sequential" },
    mode: "dry_run",
    plannerAssumptions: [],
    readinessGateAvailability: "unavailable",
    resolvedItemIds: ["FG-101"],
    sourceInput: { kind: "list" },
  };
  const withoutRecs: CanonicalPlanContent = {
    ...withRecs,
    itemRecommendations: {},
  };
  assert.notEqual(
    computePlanHash(withRecs),
    computePlanHash(withoutRecs),
    "including itemRecommendations must change the plan_hash"
  );
});

// ── FG-442: execution lanes ─────────────────────────────────────────────────

test("lane: defaults to full_feature with the default rationale when no override is supplied", () => {
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  const entry = result.canonicalContent.orderedItems!.find((i) => i.ticketId === "FG-101")!;
  assert.equal(entry.lane, "full_feature");
  assert.equal(entry.laneRationale, "no lane override supplied — defaulting to full_feature");
  assert.deepEqual(entry.materialLaneAssumptions, []);
  assert.equal(entry.executionMode, "workflow");
  assert.equal(entry.workflowName, "feature");
  assert.equal(entry.agentRole, undefined);
});

test("lane: an explicit lane override folds lane/laneRationale/materialLaneAssumptions/agentRole into canonicalContent", () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": {
      lane: "docs_only",
      laneRationale: "policy route 'documentation_durable' -> lane 'docs_only'",
      materialLaneAssumptions: ["routing policy source: host"],
      agentRole: "documentation-maintainer",
    },
  };
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir });
  const entry = result.canonicalContent.orderedItems!.find((i) => i.ticketId === "FG-101")!;
  assert.equal(entry.lane, "docs_only");
  assert.equal(entry.laneRationale, "policy route 'documentation_durable' -> lane 'docs_only'");
  assert.deepEqual(entry.materialLaneAssumptions, ["routing policy source: host"]);
  assert.equal(entry.executionMode, "invoke");
  assert.equal(entry.agentRole, "documentation-maintainer");
});

test("lane: quick_implementation folds to executionMode invoke_chain with no agentRole/workflowName", () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "quick_implementation", laneRationale: "test" },
  };
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir });
  const entry = result.canonicalContent.orderedItems!.find((i) => i.ticketId === "FG-101")!;
  assert.equal(entry.executionMode, "invoke_chain");
  assert.equal(entry.agentRole, undefined);
  assert.equal(entry.workflowName, undefined);
});

test("lane: ticketing_only and manual fold to executionMode 'none' — no dispatch mechanism recorded", () => {
  for (const lane of ["ticketing_only", "manual"] as const) {
    const itemOverrides: Record<string, ItemModeOverride> = { "FG-101": { lane, laneRationale: "test" } };
    const result = planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir });
    const entry = result.canonicalContent.orderedItems!.find((i) => i.ticketId === "FG-101")!;
    assert.equal(entry.executionMode, "none", `${lane} must fold to executionMode 'none'`);
  }
});

test("lane validation: full_feature and quick_implementation reject an agentRole", () => {
  for (const lane of ["full_feature", "quick_implementation"] as const) {
    const itemOverrides: Record<string, ItemModeOverride> = {
      "FG-101": { lane, laneRationale: "test", agentRole: "engineer" },
    };
    assert.throws(
      () => planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir }),
      /does not take an agentRole/,
      `${lane} must reject an agentRole`
    );
  }
});

test("lane validation: ticketing_only and manual reject an agentRole", () => {
  for (const lane of ["ticketing_only", "manual"] as const) {
    const itemOverrides: Record<string, ItemModeOverride> = {
      "FG-101": { lane, laneRationale: "test", agentRole: "engineer" },
    };
    assert.throws(
      () => planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir }),
      /does not take an agentRole/,
      `${lane} must reject an agentRole`
    );
  }
});

test("lane validation: docs_only/test_only/research_only/review_only require an agentRole", () => {
  for (const lane of ["docs_only", "test_only", "research_only", "review_only"] as const) {
    const itemOverrides: Record<string, ItemModeOverride> = { "FG-101": { lane, laneRationale: "test" } };
    assert.throws(
      () => planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir }),
      /requires an explicit agentRole/,
      `${lane} must require an agentRole`
    );
  }
});

test("lane: legacy executionMode:'invoke' override with no lane maps to review_only (preserves the pre-FG-442 escape hatch)", () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { executionMode: "invoke", agentRole: "engineer" },
  };
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir });
  const entry = result.canonicalContent.orderedItems!.find((i) => i.ticketId === "FG-101")!;
  assert.equal(entry.lane, "review_only");
  assert.equal(entry.executionMode, "invoke");
  assert.equal(entry.agentRole, "engineer");
});

test("lane: plan_hash CHANGES when an item's lane is swapped post-approval (quick_implementation <-> full_feature)", () => {
  const quickOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "quick_implementation", laneRationale: "test" },
  };
  const fullOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "full_feature", laneRationale: "test" },
  };
  const { planHash: quickHash } = resolvePlan(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides: quickOverrides },
    { projectDir }
  );
  const { planHash: fullHash } = resolvePlan(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides: fullOverrides },
    { projectDir }
  );
  assert.notEqual(quickHash, fullHash, "swapping lane quick_implementation <-> full_feature must change plan_hash");
});

test("lane: advisoryAgentsUsed/advisoryRecommendationSummary stay false/null when no item carries an explicit lane", () => {
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"] }, { projectDir });
  assert.equal(result.canonicalContent.advisoryAgentsUsed, false);
  assert.equal(result.canonicalContent.advisoryRecommendationSummary, null);
});

test("lane: advisoryAgentsUsed/advisoryRecommendationSummary summarize lane distribution when the classifier was used", () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
    "FG-102": { lane: "full_feature", laneRationale: "test" },
  };
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"], itemOverrides }, { projectDir });
  assert.equal(result.canonicalContent.advisoryAgentsUsed, true);
  assert.match(result.canonicalContent.advisoryRecommendationSummary ?? "", /docs_only=1/);
  assert.match(result.canonicalContent.advisoryRecommendationSummary ?? "", /full_feature=1/);
});

test("getItemPlanEntry: reads lane fields for a known ticket, defaults full_feature for an unknown one", () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "test_only", laneRationale: "test", agentRole: "test-engineer" },
  };
  const result = planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides }, { projectDir });

  const known = getItemPlanEntry(result.canonicalContent, "FG-101");
  assert.equal(known.lane, "test_only");
  assert.equal(known.agentRole, "test-engineer");

  const unknown = getItemPlanEntry(result.canonicalContent, "FG-999");
  assert.equal(unknown.lane, "full_feature");
  assert.equal(unknown.executionMode, "workflow");
});
