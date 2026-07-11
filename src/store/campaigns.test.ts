import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaignStatus,
  addCampaignItem,
  getCampaignItem,
  listCampaignItems,
  updateCampaignItem,
  updateCampaignItemIfCampaignPaused,
  updateCampaignItemIfCampaignRunning,
  approveCampaign,
  setPlanHash,
} from "./campaigns.js";
import type { CampaignItemUpdate } from "./campaigns.js";
import {
  isCampaignTransitionAllowed,
} from "../types/index.js";
import type {
  CampaignStatus,
  BlockerKind,
  ContinuePolicy,
  CampaignItemOutcome,
} from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("createCampaign: persists and retrieves a campaign", () => {
  const campaign = createCampaign({
    sourceKind: "list",
    sourceInput: { tickets: ["FG-001"] },
    mode: "serial",
  });

  assert.ok(campaign.id.startsWith("campaign-"));
  assert.equal(campaign.status, "planned");
  assert.equal(campaign.sourceKind, "list");
  assert.deepEqual(campaign.sourceInput, { tickets: ["FG-001"] });

  const loaded = getCampaign(campaign.id);
  assert.ok(loaded);
  assert.equal(loaded.id, campaign.id);
  assert.equal(loaded.status, "planned");
  assert.equal(loaded.mode, "serial");
});

test("getCampaign: returns undefined for unknown id", () => {
  assert.equal(getCampaign("campaign-notexist"), undefined);
});

test("createCampaign: persists metadata", () => {
  const campaign = createCampaign({
    sourceKind: "epic",
    sourceInput: { epicId: "FG-100" },
    mode: "parallel",
    metadata: { priority: "high" },
  });

  const loaded = getCampaign(campaign.id);
  assert.deepEqual(loaded?.metadata, { priority: "high" });
});

test("createCampaign: metadata is undefined when not provided", () => {
  const campaign = createCampaign({
    sourceKind: "mixed",
    sourceInput: { items: [] },
    mode: "serial",
  });

  const loaded = getCampaign(campaign.id);
  assert.equal(loaded?.metadata, undefined);
});

test("source_kind round-trips: list, epic, mixed", () => {
  for (const kind of ["list", "epic", "mixed"] as const) {
    const campaign = createCampaign({ sourceKind: kind, sourceInput: {}, mode: "serial" });
    const loaded = getCampaign(campaign.id);
    assert.equal(loaded?.sourceKind, kind, `source_kind ${kind} must round-trip`);
  }
});

test("all six campaign statuses round-trip", () => {
  const statuses: CampaignStatus[] = [
    "planned",
    "running",
    "paused",
    "complete",
    "failed",
    "abandoned",
  ];
  for (const status of statuses) {
    const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
    // Write directly via SQL to test rowToCampaign mapping for all values
    // without going through the state-machine guard in updateCampaignStatus.
    db.prepare("UPDATE campaigns SET status = ? WHERE id = ?").run(status, campaign.id);
    const loaded = getCampaign(campaign.id);
    assert.equal(loaded?.status, status, `status "${status}" must round-trip`);
  }
});

test("listCampaigns: returns all campaigns", () => {
  const c1 = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const c2 = createCampaign({ sourceKind: "epic", sourceInput: {}, mode: "serial" });

  const all = listCampaigns();
  assert.equal(all.length, 2);
  const ids = all.map((c) => c.id).sort();
  assert.deepEqual(ids, [c1.id, c2.id].sort());
});

test("listCampaigns: optional status filter", () => {
  const c1 = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const c2 = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(c2.id, "running");

  const planned = listCampaigns("planned");
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.id, c1.id);

  const running = listCampaigns("running");
  assert.equal(running.length, 1);
  assert.equal(running[0]?.id, c2.id);

  const all = listCampaigns();
  assert.equal(all.length, 2);
});

test("addCampaignItem: creates item with pending status", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  assert.ok(item.id.startsWith("citem-"));
  assert.equal(item.campaignId, campaign.id);
  assert.equal(item.ticketId, "FG-001");
  assert.equal(item.itemOrder, 0);
  assert.equal(item.lifecycleStatus, "pending");
  assert.equal(item.outcome, undefined);

  const loaded = getCampaignItem(item.id);
  assert.ok(loaded);
  assert.equal(loaded.ticketId, "FG-001");
  assert.equal(loaded.lifecycleStatus, "pending");
});

test("getCampaignItem: returns undefined for unknown id", () => {
  assert.equal(getCampaignItem("citem-notexist"), undefined);
});

test("listCampaignItems: ordered by item_order ascending", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  addCampaignItem({ campaignId: campaign.id, itemOrder: 2, ticketId: "FG-003" });
  addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  addCampaignItem({ campaignId: campaign.id, itemOrder: 1, ticketId: "FG-002" });

  const items = listCampaignItems(campaign.id);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.ticketId, "FG-001");
  assert.equal(items[1]?.ticketId, "FG-002");
  assert.equal(items[2]?.ticketId, "FG-003");
});

test("listCampaignItems: returns empty for campaign with no items", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  assert.deepEqual(listCampaignItems(campaign.id), []);
});

test("updateCampaignItem: updates lifecycle status", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  updateCampaignItem(item.id, { lifecycleStatus: "running" });

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.lifecycleStatus, "running");
});

test("updateCampaignItem: persists outcome, blockerKind, continuePolicy, reason", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  updateCampaignItem(item.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "tests",
    continuePolicy: "hold_campaign",
    reason: "Tests are failing",
  });

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.lifecycleStatus, "failed");
  assert.equal(loaded?.outcome, "blocked");
  assert.equal(loaded?.blockerKind, "tests");
  assert.equal(loaded?.continuePolicy, "hold_campaign");
  assert.equal(loaded?.reason, "Tests are failing");
});

test("updateCampaignItem: persists runId, branch, worktreePath, prUrl", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  updateCampaignItem(item.id, {
    runId: "run-test-abc123",
    branch: "forge/run-test/citem-test",
    worktreePath: "/tmp/worktrees/test",
    prUrl: "https://github.com/example/repo/pull/42",
  });

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.runId, "run-test-abc123");
  assert.equal(loaded?.branch, "forge/run-test/citem-test");
  assert.equal(loaded?.worktreePath, "/tmp/worktrees/test");
  assert.equal(loaded?.prUrl, "https://github.com/example/repo/pull/42");
});

test("updateCampaignItem: persists requestedHumanAction", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  updateCampaignItem(item.id, { requestedHumanAction: "Please review the PR and approve" });

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.requestedHumanAction, "Please review the PR and approve");
});

test("updateCampaignItem: partial update preserves unset fields", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  updateCampaignItem(item.id, { runId: "run-abc", outcome: "shipped" });
  updateCampaignItem(item.id, { lifecycleStatus: "complete" });

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.lifecycleStatus, "complete");
  assert.equal(loaded?.runId, "run-abc");
  assert.equal(loaded?.outcome, "shipped");
});

// ── FG-410: column-targeted updates (lost-update safety) ───────────────────

test("updateCampaignItem: concurrent writers on disjoint fields both persist", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  // Both writers construct their update from the SAME starting snapshot — the
  // interleaving that read-merge-write loses. Writer B's write must not restore
  // the branch it saw before writer A set it.
  const writerA: CampaignItemUpdate = { branch: "forge/lane-a" };
  const writerB: CampaignItemUpdate = { prUrl: "https://github.com/example/repo/pull/7" };

  updateCampaignItem(item.id, writerA);
  updateCampaignItem(item.id, writerB);

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.branch, "forge/lane-a", "writer A's field was clobbered by writer B's stale snapshot");
  assert.equal(loaded?.prUrl, "https://github.com/example/repo/pull/7");
});

// The lost update is a cross-connection interleaving (read A, read B, write A,
// write B), and better-sqlite3 is synchronous — a single connection cannot
// interleave a read-merge-write's read with another writer's write from the
// outside. So the load-bearing proof is the emitted statement itself: a writer
// that never names a column it wasn't asked to change cannot clobber a concurrent
// writer's disjoint field, whatever the interleaving. Under read-merge-write this
// assertion fails — every write named all ten mutable columns.
test("updateCampaignItem: the emitted UPDATE names only the columns the caller passed", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  const statements: string[] = [];
  const realPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    statements.push(sql);
    return realPrepare(sql);
  }) as typeof db.prepare;

  updateCampaignItem(item.id, { branch: "forge/lane-a" });

  db.prepare = realPrepare;
  const update = statements.find((sql) => sql.includes("UPDATE campaign_items"));
  assert.ok(update, "expected an UPDATE against campaign_items");
  assert.match(update, /SET branch = \?, updated_at = \?/);
  for (const column of ["run_id", "pr_url", "worktree_path", "outcome", "blocker_kind", "reason"]) {
    assert.ok(!update.includes(`${column} = ?`), `write must not name ${column} — the caller never asked to change it`);
  }
});

test("updateCampaignItem: a key present with undefined clears the column; an absent key is untouched", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  updateCampaignItem(item.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "tests",
    reason: "Tests are failing",
    branch: "forge/lane-a",
  });

  updateCampaignItem(item.id, { outcome: undefined, blockerKind: undefined, reason: undefined });

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.outcome, undefined, "explicit undefined must clear the column");
  assert.equal(loaded?.blockerKind, undefined);
  assert.equal(loaded?.reason, undefined);
  assert.equal(loaded?.branch, "forge/lane-a", "an absent key must leave its column untouched");
  assert.equal(loaded?.lifecycleStatus, "failed");
});

test("updateCampaignItem: missing id is a silent no-op", () => {
  assert.doesNotThrow(() => updateCampaignItem("citem-nonexistent", { lifecycleStatus: "running" }));
});

test("updateCampaignItem: an empty update touches updated_at and nothing else", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  updateCampaignItem(item.id, { lifecycleStatus: "running", branch: "forge/lane-a" });
  const before = getCampaignItem(item.id);

  updateCampaignItem(item.id, {});

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.lifecycleStatus, before?.lifecycleStatus);
  assert.equal(loaded?.branch, before?.branch);
});

test("campaign items are scoped by campaign_id", () => {
  const c1 = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const c2 = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  addCampaignItem({ campaignId: c1.id, itemOrder: 0, ticketId: "FG-001" });
  addCampaignItem({ campaignId: c2.id, itemOrder: 0, ticketId: "FG-002" });

  assert.equal(listCampaignItems(c1.id).length, 1);
  assert.equal(listCampaignItems(c1.id)[0]?.ticketId, "FG-001");
  assert.equal(listCampaignItems(c2.id).length, 1);
  assert.equal(listCampaignItems(c2.id)[0]?.ticketId, "FG-002");
});

// ── updateCampaignItemIfCampaignPaused: CAS ownership + pause guard ────────

test("updateCampaignItemIfCampaignPaused: applies the write when the item belongs to the paused campaign", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  updateCampaignStatus(campaign.id, "paused");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  const applied = updateCampaignItemIfCampaignPaused(item.id, campaign.id, {
    lifecycleStatus: "complete",
    outcome: "shipped",
  });

  assert.equal(applied, true);
  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.lifecycleStatus, "complete");
  assert.equal(loaded?.outcome, "shipped");
});

test("updateCampaignItemIfCampaignPaused: refuses and mutates nothing when campaignId names a different (even paused) campaign", () => {
  const campaignA = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const campaignB = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaignA.id, "running");
  updateCampaignStatus(campaignA.id, "paused");
  updateCampaignStatus(campaignB.id, "running");
  updateCampaignStatus(campaignB.id, "paused");
  const item = addCampaignItem({ campaignId: campaignA.id, itemOrder: 0, ticketId: "FG-001" });
  const before = getCampaignItem(item.id);

  const applied = updateCampaignItemIfCampaignPaused(item.id, campaignB.id, {
    lifecycleStatus: "complete",
    outcome: "shipped",
  });

  assert.equal(applied, false, "campaignB being paused must not authorize a write to campaignA's item");
  assert.deepEqual(getCampaignItem(item.id), before, "item row must be byte-identical — zero mutation");
});

test("updateCampaignItemIfCampaignPaused: refuses when the campaign is not paused", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  const before = getCampaignItem(item.id);

  const applied = updateCampaignItemIfCampaignPaused(item.id, campaign.id, { lifecycleStatus: "complete" });

  assert.equal(applied, false);
  assert.deepEqual(getCampaignItem(item.id), before);
});

test("updateCampaignItemIfCampaignPaused: returns false for a missing item", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  updateCampaignStatus(campaign.id, "paused");

  const applied = updateCampaignItemIfCampaignPaused("citem-nonexistent", campaign.id, {
    lifecycleStatus: "complete",
  });

  assert.equal(applied, false);
});

test("updateCampaignItemIfCampaignPaused: writes only the columns the caller named", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  updateCampaignStatus(campaign.id, "paused");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  updateCampaignItem(item.id, { branch: "forge/lane-a" });

  const applied = updateCampaignItemIfCampaignPaused(item.id, campaign.id, { lifecycleStatus: "complete" });

  assert.equal(applied, true);
  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.lifecycleStatus, "complete");
  assert.equal(loaded?.branch, "forge/lane-a");
});

// ── updateCampaignItemIfCampaignRunning: CAS ownership + running guard ─────

test("updateCampaignItemIfCampaignRunning: applies the write when the item belongs to the running campaign", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  updateCampaignItem(item.id, { branch: "forge/lane-a" });

  const applied = updateCampaignItemIfCampaignRunning(item.id, campaign.id, {
    lifecycleStatus: "complete",
    outcome: "shipped",
  });

  assert.equal(applied, true);
  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.lifecycleStatus, "complete");
  assert.equal(loaded?.outcome, "shipped");
  assert.equal(loaded?.branch, "forge/lane-a", "a column the caller never named must survive");
});

test("updateCampaignItemIfCampaignRunning: refuses when the campaign is paused, or when campaignId names another campaign", () => {
  const campaignA = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  const campaignB = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaignA.id, "running");
  updateCampaignStatus(campaignB.id, "running");
  const item = addCampaignItem({ campaignId: campaignA.id, itemOrder: 0, ticketId: "FG-001" });

  assert.equal(
    updateCampaignItemIfCampaignRunning(item.id, campaignB.id, { lifecycleStatus: "complete" }),
    false,
    "campaignB being running must not authorize a write to campaignA's item"
  );

  updateCampaignStatus(campaignA.id, "paused");
  const before = getCampaignItem(item.id);
  assert.equal(
    updateCampaignItemIfCampaignRunning(item.id, campaignA.id, { lifecycleStatus: "complete" }),
    false
  );
  assert.deepEqual(getCampaignItem(item.id), before, "item row must be byte-identical — zero mutation");
});

test("updateCampaignItemIfCampaignRunning: returns false for a missing item", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");

  assert.equal(
    updateCampaignItemIfCampaignRunning("citem-nonexistent", campaign.id, { lifecycleStatus: "complete" }),
    false
  );
});

test("updateCampaignItemIfCampaignRunning: an explicit undefined clears the column under the guard", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  updateCampaignItem(item.id, { outcome: "blocked", blockerKind: "tests", branch: "forge/lane-a" });

  const applied = updateCampaignItemIfCampaignRunning(item.id, campaign.id, {
    outcome: undefined,
    blockerKind: undefined,
  });

  assert.equal(applied, true);
  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.outcome, undefined);
  assert.equal(loaded?.blockerKind, undefined);
  assert.equal(loaded?.branch, "forge/lane-a");
});

test("updateCampaignItemIfCampaignRunning: guarded writers on disjoint fields both persist", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  const writerA: CampaignItemUpdate = { runId: "run-lane-a" };
  const writerB: CampaignItemUpdate = { worktreePath: "/tmp/worktrees/lane-b" };

  assert.equal(updateCampaignItemIfCampaignRunning(item.id, campaign.id, writerA), true);
  assert.equal(updateCampaignItemIfCampaignRunning(item.id, campaign.id, writerB), true);

  const loaded = getCampaignItem(item.id);
  assert.equal(loaded?.runId, "run-lane-a", "writer A's field was clobbered by writer B's stale snapshot");
  assert.equal(loaded?.worktreePath, "/tmp/worktrees/lane-b");
});

test("updateCampaignItemIfCampaignRunning: an empty update reports whether the guard passed", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });

  assert.equal(updateCampaignItemIfCampaignRunning(item.id, campaign.id, {}), true);

  updateCampaignStatus(campaign.id, "paused");
  assert.equal(updateCampaignItemIfCampaignRunning(item.id, campaign.id, {}), false);
});

// ── Transition legality ────────────────────────────────────────────────────

test("isCampaignTransitionAllowed: all legal transitions are accepted", () => {
  const legal: [CampaignStatus, CampaignStatus][] = [
    ["planned",  "running"],
    ["planned",  "abandoned"],
    ["running",  "paused"],
    ["running",  "complete"],
    ["running",  "failed"],
    ["running",  "abandoned"],
    ["paused",   "running"],
    ["paused",   "abandoned"],
  ];
  for (const [from, to] of legal) {
    assert.ok(isCampaignTransitionAllowed(from, to), `${from} -> ${to} must be allowed`);
  }
});

test("isCampaignTransitionAllowed: terminal states reject all outbound transitions", () => {
  const terminals: CampaignStatus[] = ["complete", "failed", "abandoned"];
  const all: CampaignStatus[] = ["planned", "running", "paused", "complete", "failed", "abandoned"];
  for (const from of terminals) {
    for (const to of all) {
      assert.ok(!isCampaignTransitionAllowed(from, to), `${from} -> ${to} must be rejected`);
    }
  }
});

test("isCampaignTransitionAllowed: illegal non-terminal transitions are rejected", () => {
  const illegal: [CampaignStatus, CampaignStatus][] = [
    ["planned", "paused"],
    ["planned", "complete"],
    ["planned", "failed"],
    ["running", "planned"],
    ["paused",  "planned"],
    ["paused",  "complete"],
    ["paused",  "failed"],
  ];
  for (const [from, to] of illegal) {
    assert.ok(!isCampaignTransitionAllowed(from, to), `${from} -> ${to} must be rejected`);
  }
});

test("isCampaignTransitionAllowed: full lifecycle path planned->running->paused->running->complete", () => {
  const path: CampaignStatus[] = ["planned", "running", "paused", "running", "complete"];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(
      isCampaignTransitionAllowed(path[i]!, path[i + 1]!),
      `step ${path[i]} -> ${path[i + 1]} must be allowed`,
    );
  }
});

test("isCampaignTransitionAllowed: failed and abandoned are reachable terminals", () => {
  assert.ok(isCampaignTransitionAllowed("running", "failed"));
  assert.ok(isCampaignTransitionAllowed("running", "abandoned"));
  // once there, nothing is allowed out
  assert.ok(!isCampaignTransitionAllowed("failed",    "running"));
  assert.ok(!isCampaignTransitionAllowed("abandoned", "planned"));
});

// ── listCampaigns distinguishability ──────────────────────────────────────

test("listCampaigns: each of the six statuses returns exactly the matching rows", () => {
  const statuses: CampaignStatus[] = ["planned", "running", "paused", "complete", "failed", "abandoned"];
  const ids = new Map<CampaignStatus, string>();
  for (const status of statuses) {
    const c = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
    // Write directly via SQL to avoid state-machine guard; this tests listCampaigns filtering.
    db.prepare("UPDATE campaigns SET status = ? WHERE id = ?").run(status, c.id);
    ids.set(status, c.id);
  }
  for (const status of statuses) {
    const rows = listCampaigns(status);
    assert.equal(rows.length, 1, `listCampaigns("${status}") must return exactly 1 row`);
    assert.equal(rows[0]?.status, status);
    assert.equal(rows[0]?.id, ids.get(status));
  }
});

// ── Non-contiguous item_order stability ───────────────────────────────────

test("listCampaignItems: stable ordering with non-contiguous item_order values", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  addCampaignItem({ campaignId: campaign.id, itemOrder: 100, ticketId: "FG-C" });
  addCampaignItem({ campaignId: campaign.id, itemOrder: 5,   ticketId: "FG-A" });
  addCampaignItem({ campaignId: campaign.id, itemOrder: 50,  ticketId: "FG-B" });

  const items = listCampaignItems(campaign.id);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.ticketId, "FG-A");
  assert.equal(items[0]?.itemOrder, 5);
  assert.equal(items[1]?.ticketId, "FG-B");
  assert.equal(items[1]?.itemOrder, 50);
  assert.equal(items[2]?.ticketId, "FG-C");
  assert.equal(items[2]?.itemOrder, 100);
});

// ── Enum exhaustiveness round-trips ───────────────────────────────────────

test("updateCampaignItem: every BlockerKind value round-trips", () => {
  const allKinds: BlockerKind[] = [
    "scope", "readiness", "tests", "merge_conflict", "auth",
    "dependency", "git_state", "infrastructure", "campaign_system", "human_decision",
  ];
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  for (const kind of allKinds) {
    const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-X" });
    updateCampaignItem(item.id, { blockerKind: kind });
    const loaded = getCampaignItem(item.id);
    assert.equal(loaded?.blockerKind, kind, `blockerKind "${kind}" must round-trip`);
  }
});

test("updateCampaignItem: every ContinuePolicy value round-trips", () => {
  const policies: ContinuePolicy[] = ["continue_allowed", "hold_dependents", "hold_campaign"];
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  for (const policy of policies) {
    const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-X" });
    updateCampaignItem(item.id, { continuePolicy: policy });
    const loaded = getCampaignItem(item.id);
    assert.equal(loaded?.continuePolicy, policy, `continuePolicy "${policy}" must round-trip`);
  }
});

test("updateCampaignItem: every CampaignItemOutcome value round-trips", () => {
  const outcomes: CampaignItemOutcome[] = [
    "shipped", "blocked", "skipped", "held", "needs_refinement", "failed",
  ];
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  for (const outcome of outcomes) {
    const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-X" });
    updateCampaignItem(item.id, { outcome });
    const loaded = getCampaignItem(item.id);
    assert.equal(loaded?.outcome, outcome, `outcome "${outcome}" must round-trip`);
  }
});

// ── source_input JSON round-trips ─────────────────────────────────────────

test("source_input JSON round-trips: list with ticket array and extra fields", () => {
  const input = { tickets: ["FG-001", "FG-002", "FG-003"], dryRun: false, priority: 1 };
  const campaign = createCampaign({ sourceKind: "list", sourceInput: input, mode: "serial" });
  const loaded = getCampaign(campaign.id);
  assert.deepEqual(loaded?.sourceInput, input);
  assert.equal(loaded?.sourceKind, "list");
});

test("source_input JSON round-trips: epic with nested config", () => {
  const input = { epicId: "FG-100", filter: { labels: ["bug", "critical"], milestone: "v2.0" } };
  const campaign = createCampaign({ sourceKind: "epic", sourceInput: input, mode: "serial" });
  const loaded = getCampaign(campaign.id);
  assert.deepEqual(loaded?.sourceInput, input);
  assert.equal(loaded?.sourceKind, "epic");
});

test("source_input JSON round-trips: mixed with heterogeneous structure", () => {
  const input = { tickets: ["FG-001"], epicId: "FG-100", merge: "union", threshold: null };
  const campaign = createCampaign({ sourceKind: "mixed", sourceInput: input, mode: "serial" });
  const loaded = getCampaign(campaign.id);
  assert.deepEqual(loaded?.sourceInput, input);
  assert.equal(loaded?.sourceKind, "mixed");
});

// ── updateCampaignStatus transition guard ─────────────────────────────────

test("updateCampaignStatus: throws on illegal transition (complete -> running)", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(campaign.id);
  assert.throws(
    () => updateCampaignStatus(campaign.id, "running"),
    /Illegal campaign transition complete -> running/
  );
});

test("updateCampaignStatus: throws on illegal transition (planned -> paused)", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  assert.throws(
    () => updateCampaignStatus(campaign.id, "paused"),
    /Illegal campaign transition planned -> paused/
  );
});

test("updateCampaignStatus: throws on illegal transition (failed -> running)", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaign.id);
  assert.throws(
    () => updateCampaignStatus(campaign.id, "running"),
    /Illegal campaign transition failed -> running/
  );
});

test("updateCampaignStatus: allows legal transitions (running -> complete, running -> failed)", () => {
  const c1 = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(c1.id);
  assert.doesNotThrow(() => updateCampaignStatus(c1.id, "complete"));
  assert.equal(getCampaign(c1.id)?.status, "complete");

  const c2 = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(c2.id);
  assert.doesNotThrow(() => updateCampaignStatus(c2.id, "failed"));
  assert.equal(getCampaign(c2.id)?.status, "failed");
});

test("updateCampaignStatus: throws if campaign does not exist", () => {
  assert.throws(
    () => updateCampaignStatus("campaign-doesnotexist", "running"),
    /not found/
  );
});

// ── FG-442 (PR #11 follow-up, Finding 2): approveCampaign paused re-approve scoping ──

test("approveCampaign: approves a 'planned' campaign (regression)", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  setPlanHash(campaign.id, "hash-1");

  const approved = approveCampaign(campaign.id, { approvedBy: "alice", rationale: "initial approval" });
  assert.equal(approved, true);

  const after = getCampaign(campaign.id)!;
  assert.equal(after.approvedBy, "alice");
  assert.equal(after.approvalRationale, "initial approval");
  assert.equal(after.approvedPlanHash, "hash-1");
});

test("approveCampaign: refuses a paused campaign whose plan_hash already equals approved_plan_hash (no genuine change to approve)", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  setPlanHash(campaign.id, "hash-1");
  assert.equal(approveCampaign(campaign.id, { approvedBy: "alice", rationale: "initial approval" }), true);

  // Force the campaign into 'paused' for a reason unrelated to the plan (e.g. an
  // invoke-lane item parked at awaiting_gate) — the plan itself never changed.
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  const before = getCampaign(campaign.id)!;
  assert.equal(before.planHash, before.approvedPlanHash);

  const reapproved = approveCampaign(campaign.id, { approvedBy: "bob", rationale: "re-approve attempt" });
  assert.equal(reapproved, false, "must refuse when plan_hash === approved_plan_hash on a paused campaign");

  const after = getCampaign(campaign.id)!;
  assert.equal(after.approvedBy, "alice", "approved_by must not be rewritten by the refused re-approve");
  assert.equal(after.approvedAt, before.approvedAt, "approved_at must not be rewritten by the refused re-approve");
});

test("approveCampaign: allows a genuine escalate->approve re-approval on a paused campaign with a fresh plan_hash", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  setPlanHash(campaign.id, "hash-1");
  assert.equal(approveCampaign(campaign.id, { approvedBy: "alice", rationale: "initial approval" }), true);

  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  // Simulate escalate-lane minting a fresh, as-yet-unapproved plan_hash.
  setPlanHash(campaign.id, "hash-2");

  const reapproved = approveCampaign(campaign.id, { approvedBy: "bob", rationale: "post-escalate re-approve" });
  assert.equal(reapproved, true, "must allow re-approval when plan_hash differs from approved_plan_hash");

  const after = getCampaign(campaign.id)!;
  assert.equal(after.approvedBy, "bob");
  assert.equal(after.approvedPlanHash, "hash-2");
});

test("approveCampaign: refuses a paused campaign with a fresh plan_hash but an unresolved lane_escalation item (symmetric with the CLI guard)", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  setPlanHash(campaign.id, "hash-1");
  assert.equal(approveCampaign(campaign.id, { approvedBy: "alice", rationale: "initial approval" }), true);

  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-001" });
  updateCampaignItem(item.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "lane_escalation",
  });
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  // A fresh plan_hash alone (e.g. minted for the wrong ticket) must not bypass
  // the still-unresolved escalation on this item.
  setPlanHash(campaign.id, "hash-2");
  const before = getCampaign(campaign.id)!;

  const reapproved = approveCampaign(campaign.id, { approvedBy: "bob", rationale: "re-approve attempt" });
  assert.equal(reapproved, false, "must refuse while an item is still blocked on an unresolved lane_escalation");

  const after = getCampaign(campaign.id)!;
  assert.equal(after.approvedBy, before.approvedBy);
  assert.equal(after.approvedAt, before.approvedAt);
  assert.equal(after.approvedPlanHash, before.approvedPlanHash);
});

test("approveCampaign: atomic WHERE leaves approved_* columns untouched when the guard refuses (paused, unchanged plan_hash)", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "serial" });
  setPlanHash(campaign.id, "hash-1");
  assert.equal(approveCampaign(campaign.id, { approvedBy: "alice", rationale: "initial approval" }), true);

  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  const before = getCampaign(campaign.id)!;

  const reapproved = approveCampaign(campaign.id, { approvedBy: "bob", rationale: "re-approve attempt" });
  assert.equal(reapproved, false);

  const after = getCampaign(campaign.id)!;
  assert.deepEqual(
    { approvedBy: after.approvedBy, approvedAt: after.approvedAt, approvalRationale: after.approvalRationale, approvedPlanHash: after.approvedPlanHash, updatedAt: after.updatedAt },
    { approvedBy: before.approvedBy, approvedAt: before.approvedAt, approvalRationale: before.approvalRationale, approvedPlanHash: before.approvedPlanHash, updatedAt: before.updatedAt },
    "a refused UPDATE must be a true no-op — no partial column writes from the compare-and-swap WHERE"
  );
});
