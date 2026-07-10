// FG-516 (structural close of the park-payload class): unit coverage for the
// parkCampaign boundary's body composition and the { blockerKind, ... } ParkContext
// arm. These pin, at the boundary itself (not through the whole executor), that:
//   (1) an item carrying a persisted blockerKind still renders `blocker: <kind>`
//       in the pushed body — the item-carries-context path, unchanged behavior;
//   (2) the composed arm renders `blocker: <kind> — <action>` for a BARE item
//       (no blockerKind, no requestedHumanAction) and persists the action onto the
//       item — while deliberately NOT persisting blockerKind, so the item stays the
//       out-of-band awaiting_gate reconcile shape reconcile.ts / report.ts key off.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  createCampaign,
  addCampaignItem,
  updateCampaignItem,
  getCampaignItem,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { insertRun } from "../store/runs.js";
import { parkCampaign, setCampaignNotifyEmitterForTest } from "./park.js";
import type { EmitMilestoneArgs, EmitMilestoneResult } from "../notify/milestone.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let captured: EmitMilestoneArgs[];

function captureEmitter(): void {
  captured = [];
  setCampaignNotifyEmitterForTest(async (args: EmitMilestoneArgs): Promise<EmitMilestoneResult> => {
    captured.push(args);
    return { dispatched: true, decision: { send: true, reason: "test" }, importance: "high" };
  });
}

// A running campaign with one item wired to a real, resolvable run — the anchor
// notifyCampaignPause scopes its (run-scoped) milestone to.
function runningCampaignWithItem(ticketId: string): { itemId: string; runId: string } {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "sequential" });
  assert.ok(tryTransitionCampaignToRunning(campaign.id), "campaign moved planned→running");
  const runId = `run-${ticketId}`;
  insertRun({
    id: runId,
    workflow: "invoke",
    title: ticketId,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    metadata: { campaignId: campaign.id, ticketId },
  });
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId });
  updateCampaignItem(item.id, { runId });
  return { itemId: item.id, runId };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  captureEmitter();
});

afterEach(() => {
  setCampaignNotifyEmitterForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-516: item-carries-context renders `blocker: <kind>` whenever the item has a persisted blockerKind", async () => {
  const { itemId } = runningCampaignWithItem("FG-800");
  updateCampaignItem(itemId, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "campaign_system",
    requestedHumanAction: "resolve the wedge then resume",
  });

  const campaignId = getCampaignItem(itemId)!.campaignId;
  const committed = await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
  assert.equal(committed, true, "the CAS committed the running→paused pause");

  assert.equal(captured.length, 1, "exactly one milestone emitted");
  const body = String(captured[0]!.body);
  assert.match(body, /blocker: campaign_system/, "body leads with the persisted blockerKind");
  assert.match(body, /resolve the wedge then resume/, "body carries the persisted requestedHumanAction");
});

test("FG-516: the { blockerKind, requestedHumanAction } arm persists context onto a BARE item before emitting, feeding the kind to the body label without persisting blockerKind", async () => {
  const { itemId } = runningCampaignWithItem("FG-801");
  // A bare out-of-band awaiting_gate item — no blockerKind, no requestedHumanAction.
  updateCampaignItem(itemId, { lifecycleStatus: "awaiting_gate" });
  const bare = getCampaignItem(itemId)!;
  assert.equal(bare.blockerKind, undefined, "the item arrives WITHOUT a blockerKind");
  assert.equal(bare.requestedHumanAction, undefined, "the item arrives WITHOUT a requestedHumanAction");

  const committed = await parkCampaign(bare.campaignId, itemId, "decision_needed", {
    blockerKind: "human_decision",
    requestedHumanAction: "review FG-801 and run `forge campaign reconcile`",
  });
  assert.equal(committed, true, "the CAS committed the pause");

  // The arm persisted the action onto the item BEFORE emitting...
  const after = getCampaignItem(itemId)!;
  assert.equal(after.requestedHumanAction, "review FG-801 and run `forge campaign reconcile`", "the arm persisted requestedHumanAction onto the bare item");
  // ...but NOT the blockerKind — the item stays the out-of-band reconcile shape.
  assert.equal(after.blockerKind, undefined, "the arm did NOT persist blockerKind (out-of-band awaiting_gate marker preserved)");

  assert.equal(captured.length, 1, "exactly one milestone emitted");
  const body = String(captured[0]!.body);
  assert.match(body, /blocker: human_decision/, "body leads with the composed blockerKind label");
  assert.match(body, /review FG-801 and run `forge campaign reconcile`/, "body carries the composed action");
});

test("FG-516: a stale driver whose CAS loses (campaign already paused) emits nothing", async () => {
  const { itemId } = runningCampaignWithItem("FG-802");
  const campaignId = getCampaignItem(itemId)!.campaignId;
  // Someone else already parked the campaign — the running→paused CAS finds no
  // 'running' row, so this park commits nothing and must not notify.
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);

  const committed = await parkCampaign(campaignId, itemId, "blocked", {
    blockerKind: "human_decision",
    requestedHumanAction: "should never emit",
  });
  assert.equal(committed, false, "the CAS did not commit — the campaign was already paused");
  assert.equal(captured.length, 0, "no milestone emitted for a pause this driver did not cause");
  // And the arm did not persist onto the item either (persist happens only on commit).
  assert.equal(getCampaignItem(itemId)!.requestedHumanAction, undefined, "no context persisted when the CAS lost");
});
