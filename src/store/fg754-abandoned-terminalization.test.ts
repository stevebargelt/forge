// FG-754: abandoning a campaign must terminalize its non-terminal items AND flip
// their PARKED linked runs to 'abandoned' — atomically — so they stop rendering as
// live "Waiting on operator" work forever. These unit tests pin the store primitives:
//
//   Step 1 — terminalizeCampaignItemIfCampaignAbandoned (guarded item CAS) and
//            terminalizeAbandonedCampaignItems (the batch): no-op unless the campaign
//            is 'abandoned'; rows PRESERVED (UPDATE, never DELETE); a PARKED item's
//            active run flips to 'abandoned'; a genuinely-RUNNING item's run is left
//            untouched (risk #1 — never kill a live container from this path).
//   Step 2 — abandonCampaignAndTerminalizeItems: the transition + item + run
//            terminalize commit together.
//   Step 5 — listAbandonedReapCandidates + the batch, reused by the reaper: only
//            abandoned-campaign non-terminal items are candidates (a paused campaign's
//            items are structurally unreachable), and the terminalize is idempotent.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import {
  createCampaign,
  addCampaignItem,
  getCampaignItem,
  updateCampaignStatus,
  updateCampaignItem,
  terminalizeCampaignItemIfCampaignAbandoned,
  terminalizeAbandonedCampaignItems,
  abandonCampaignAndTerminalizeItems,
  listAbandonedReapCandidates,
  CAMPAIGN_ABANDONED_ITEM_REASON_PREFIX,
} from "./campaigns.js";
import { getRun } from "./runs.js";
import { nowIso } from "../util/ids.js";
import type { CampaignItemLifecycleStatus } from "../types/index.js";

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

function addRun(id: string, status: string): void {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, 'feature', ?, ?, ?)`)
    .run(id, id, status, nowIso());
}

function seedCampaignWithItem(opts: {
  campaignStatus: string;
  lifecycle: CampaignItemLifecycleStatus;
  runStatus?: string;
}): { campaignId: string; itemId: string; runId: string | null } {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: { tickets: ["FG-1"] }, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-1" });
  let runId: string | null = null;
  if (opts.runStatus) {
    runId = `run-${item.id}`;
    addRun(runId, opts.runStatus);
  }
  updateCampaignItem(item.id, { lifecycleStatus: opts.lifecycle, ...(runId ? { runId } : {}) });
  // planned -> abandoned and planned -> running -> paused are both legal; drive to target.
  if (opts.campaignStatus === "paused") {
    updateCampaignStatus(campaign.id, "running");
    updateCampaignStatus(campaign.id, "paused");
  } else if (opts.campaignStatus !== "planned") {
    updateCampaignStatus(campaign.id, opts.campaignStatus as never);
  }
  return { campaignId: campaign.id, itemId: item.id, runId };
}

// ───────────────────────── Step 1 — the guarded single-item writer ─────────────────────────

test("Step 1: terminalizeCampaignItemIfCampaignAbandoned is a no-op unless the campaign is abandoned", () => {
  const { campaignId, itemId } = seedCampaignWithItem({ campaignStatus: "paused", lifecycle: "awaiting_gate" });
  assert.equal(terminalizeCampaignItemIfCampaignAbandoned(itemId, campaignId), false);
  const item = getCampaignItem(itemId);
  assert.equal(item?.lifecycleStatus, "awaiting_gate", "a paused campaign's item is untouched");
  assert.equal(item?.reason, undefined);
});

test("Step 1: terminalize sets failed + the durable marker, and PRESERVES the row", () => {
  const { campaignId, itemId } = seedCampaignWithItem({ campaignStatus: "abandoned", lifecycle: "awaiting_gate" });
  const before = db.prepare(`SELECT COUNT(*) AS n FROM campaign_items`).get() as { n: number };

  assert.equal(terminalizeCampaignItemIfCampaignAbandoned(itemId, campaignId), true);

  const item = getCampaignItem(itemId);
  assert.equal(item?.lifecycleStatus, "failed");
  assert.equal(item?.outcome, "failed");
  assert.ok(item?.reason?.startsWith(CAMPAIGN_ABANDONED_ITEM_REASON_PREFIX), "durable abandonment marker written");

  const after = db.prepare(`SELECT COUNT(*) AS n FROM campaign_items`).get() as { n: number };
  assert.equal(after.n, before.n, "row preserved — updated in place, never deleted");
});

test("Step 1: terminalize never clobbers an already-terminal (shipped/complete) item", () => {
  const { campaignId, itemId } = seedCampaignWithItem({ campaignStatus: "abandoned", lifecycle: "complete" });
  updateCampaignItem(itemId, { outcome: "shipped" });
  assert.equal(terminalizeCampaignItemIfCampaignAbandoned(itemId, campaignId), false);
  const item = getCampaignItem(itemId);
  assert.equal(item?.lifecycleStatus, "complete");
  assert.equal(item?.outcome, "shipped");
});

// ───────────────────────── Step 1 — the batch primitive + run flip ─────────────────────────

test("Step 1: batch flips a PARKED item's still-active linked run to abandoned", () => {
  const { campaignId, itemId, runId } = seedCampaignWithItem({
    campaignStatus: "abandoned",
    lifecycle: "awaiting_gate",
    runStatus: "active",
  });
  const results = terminalizeAbandonedCampaignItems(campaignId);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.runAbandoned, true);
  assert.equal(getCampaignItem(itemId)?.lifecycleStatus, "failed");
  assert.equal(getRun(runId!)?.status, "abandoned");
});

test("Step 1 (risk #1): a genuinely-RUNNING item is NOT terminalized and its run is NOT force-abandoned", () => {
  const { campaignId, itemId, runId } = seedCampaignWithItem({
    campaignStatus: "abandoned",
    lifecycle: "running",
    runStatus: "active",
  });
  const results = terminalizeAbandonedCampaignItems(campaignId);
  assert.equal(results.length, 0, "a running item is out of the terminalizable set — left to the reaper/executor");
  assert.equal(getCampaignItem(itemId)?.lifecycleStatus, "running");
  assert.equal(getRun(runId!)?.status, "active", "the live container's run is untouched");
});

test("Step 1: a terminalized item at awaiting_red keeps its (possibly-live) run active", () => {
  const { campaignId, itemId, runId } = seedCampaignWithItem({
    campaignStatus: "abandoned",
    lifecycle: "awaiting_red",
    runStatus: "active",
  });
  const results = terminalizeAbandonedCampaignItems(campaignId);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.runAbandoned, false, "awaiting_red is not a run-flip parked state — red containers may be live");
  assert.equal(getCampaignItem(itemId)?.lifecycleStatus, "failed");
  assert.equal(getRun(runId!)?.status, "active");
});

test("RF-1/RF-2: a blocked_by_red parked item is terminalized off the live surface and its active run is flipped", () => {
  const { campaignId, itemId, runId } = seedCampaignWithItem({
    campaignStatus: "abandoned",
    lifecycle: "blocked_by_red",
    runStatus: "active",
  });
  const results = terminalizeAbandonedCampaignItems(campaignId);
  assert.equal(results.length, 1, "blocked_by_red is a parked, non-terminal state — it must be terminalized");
  assert.equal(results[0]!.previousLifecycle, "blocked_by_red");
  assert.equal(results[0]!.runAbandoned, true, "blocked_by_red is a run-flip parked state — its linked active run flips");
  assert.equal(getCampaignItem(itemId)?.lifecycleStatus, "failed", "leaves the live surface");
  assert.equal(getRun(runId!)?.status, "abandoned");
  assert.equal(listAbandonedReapCandidates().length, 0, "no blocked_by_red item still surfaces after terminalization");
});

test("Step 1: batch is a no-op on a non-abandoned campaign", () => {
  const { campaignId, itemId } = seedCampaignWithItem({ campaignStatus: "paused", lifecycle: "awaiting_gate" });
  assert.deepEqual(terminalizeAbandonedCampaignItems(campaignId), []);
  assert.equal(getCampaignItem(itemId)?.lifecycleStatus, "awaiting_gate");
});

// ───────────────────────── Step 2 — atomic abandon + terminalize ─────────────────────────

test("Step 2: abandonCampaignAndTerminalizeItems flips status, items, and parked runs together", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: { tickets: ["A", "B", "C"] }, mode: "serial" });
  updateCampaignStatus(campaign.id, "running");

  const parked = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "A" });
  addRun("run-A", "active");
  updateCampaignItem(parked.id, { lifecycleStatus: "awaiting_gate", runId: "run-A" });

  const pending = addCampaignItem({ campaignId: campaign.id, itemOrder: 1, ticketId: "B" });
  updateCampaignItem(pending.id, { lifecycleStatus: "pending" });

  const shipped = addCampaignItem({ campaignId: campaign.id, itemOrder: 2, ticketId: "C" });
  updateCampaignItem(shipped.id, { lifecycleStatus: "complete", outcome: "shipped" });

  const out = abandonCampaignAndTerminalizeItems(campaign.id, "running");
  assert.equal(out.transitioned, true);
  assert.equal(out.terminalizations.length, 2, "the parked + pending items terminalize; the shipped item is left");

  assert.equal(getCampaignItem(parked.id)?.lifecycleStatus, "failed");
  assert.equal(getCampaignItem(pending.id)?.lifecycleStatus, "failed");
  assert.equal(getCampaignItem(shipped.id)?.lifecycleStatus, "complete");
  assert.equal(getCampaignItem(shipped.id)?.outcome, "shipped");
  assert.equal(getRun("run-A")?.status, "abandoned");
});

test("Step 2: a lost CAS transitions nothing and terminalizes nothing", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: { tickets: ["A"] }, mode: "serial" });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "A" });
  updateCampaignItem(item.id, { lifecycleStatus: "awaiting_gate" });
  // The campaign is 'planned', so a CAS from 'running' must lose.
  const out = abandonCampaignAndTerminalizeItems(campaign.id, "running");
  assert.equal(out.transitioned, false);
  assert.equal(out.terminalizations.length, 0);
  assert.equal(getCampaignItem(item.id)?.lifecycleStatus, "awaiting_gate");
});

// ───────────────────────── Step 5 — the reaper store primitives ─────────────────────────

test("Step 5: listAbandonedReapCandidates returns only abandoned-campaign non-terminal items", () => {
  seedCampaignWithItem({ campaignStatus: "abandoned", lifecycle: "awaiting_gate" });
  seedCampaignWithItem({ campaignStatus: "abandoned", lifecycle: "complete" }); // terminal — excluded
  seedCampaignWithItem({ campaignStatus: "paused", lifecycle: "awaiting_gate" }); // AC4 — structurally unreachable
  seedCampaignWithItem({ campaignStatus: "abandoned", lifecycle: "running" }); // live container — excluded

  const candidates = listAbandonedReapCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.lifecycleStatus, "awaiting_gate");
});

test("Step 5 (AC4 negative): a paused campaign's items are NEVER reaped", () => {
  const { campaignId, itemId } = seedCampaignWithItem({ campaignStatus: "paused", lifecycle: "awaiting_gate" });
  assert.equal(listAbandonedReapCandidates().length, 0);
  // Even a direct batch call refuses a non-abandoned campaign.
  assert.deepEqual(terminalizeAbandonedCampaignItems(campaignId), []);
  assert.equal(getCampaignItem(itemId)?.lifecycleStatus, "awaiting_gate");
});

test("Step 5: the reaper terminalize is idempotent — a re-run finds zero", () => {
  const { campaignId } = seedCampaignWithItem({
    campaignStatus: "abandoned",
    lifecycle: "awaiting_recovery",
    runStatus: "active",
  });
  const first = terminalizeAbandonedCampaignItems(campaignId);
  assert.equal(first.length, 1);
  assert.equal(listAbandonedReapCandidates().length, 0, "nothing left to reap");
  const second = terminalizeAbandonedCampaignItems(campaignId);
  assert.equal(second.length, 0, "idempotent");
});

test("Step 5: reaping preserves every row", () => {
  seedCampaignWithItem({ campaignStatus: "abandoned", lifecycle: "awaiting_gate" });
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM campaign_items`).get() as { n: number }).n;
  for (const id of new Set(listAbandonedReapCandidates().map((c) => c.campaignId))) {
    terminalizeAbandonedCampaignItems(id);
  }
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM campaign_items`).get() as { n: number }).n;
  assert.equal(after, before);
});
