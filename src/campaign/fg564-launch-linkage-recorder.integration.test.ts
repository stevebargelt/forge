// FG-564 (Slice 5b, AC10 / step 5): the executor's durable item-attempt launch-linkage
// RECORDER — recordDriveItemLaunchLinkage — exercised directly against REAL store code and a
// real in-memory SQLite DB (makeInMemoryDb). This is the record-FIRST seam that makes the
// (campaignId, itemId, attemptGeneration) -> sourceLaunchId binding durable at launch time so
// a replacement controller discovers it DIRECTLY (no launch-name/argv/timestamp archaeology).
//
// The store-level campaign-controller.test.ts covers the recordItemLaunch primitive with an
// explicitly-supplied generation + token. This file covers the EXECUTOR wrapper's own
// production responsibilities the primitive test cannot: the deterministic attempt-generation
// formula (matching reserveCampaignDriveDispatch), the born-under fencing-token derivation
// (explicit token > held lease > launcher fallback), carrying the item's run id, the P1-F
// fail-closed throw on a missing item, and direct discovery by source launch id (AC10).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  createCampaign,
  addCampaignItem,
  updateCampaignItem,
  deriveCampaignItemDispatchKey,
} from "../store/campaigns.js";
import {
  acquireCampaignLease,
  getItemLaunch,
  itemLaunchBySourceLaunch,
} from "../store/campaign-controller.js";
import { recordDriveItemLaunchLinkage } from "./executor.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  setPublicationClockOffsetForTest(0);
});
afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const TTL = 5 * 60 * 1000;

/** A campaign with one item; returns the ids. The item starts at attemptGeneration 0 (the
 *  never-dispatched marker addCampaignItem stamps). */
function seedItem(): { campaignId: string; itemId: string } {
  const c = createCampaign({
    sourceKind: "list",
    sourceInput: { kind: "list", ticketIds: ["FG-1"] },
    mode: "dry_run",
  });
  const item = addCampaignItem({ campaignId: c.id, itemOrder: 0, ticketId: "FG-1" });
  return { campaignId: c.id, itemId: item.id };
}

describe("recordDriveItemLaunchLinkage — deterministic generation formula (AC10)", () => {
  test("a never-dispatched item (attemptGeneration 0) records the linkage at generation 1", () => {
    const { campaignId, itemId } = seedItem();
    recordDriveItemLaunchLinkage(campaignId, itemId, "launch-1");
    // The recorder must use the SAME formula reserveCampaignDriveDispatch applies: gen 0 -> 1.
    const link = getItemLaunch(campaignId, itemId, 1);
    assert.ok(link, "linkage recorded under attempt generation 1");
    assert.equal(link?.sourceLaunchId, "launch-1");
    assert.equal(link?.state, "launched");
    // The row must be keyed at the SAME generation the FG-596 reservation will derive its
    // dispatch key from — otherwise recovery and the reservation would disagree.
    const key = deriveCampaignItemDispatchKey(campaignId, itemId, 1);
    assert.ok(key.startsWith("ci-"));
  });

  test("a re-dispatched item reuses its persisted non-zero attempt generation", () => {
    const { campaignId, itemId } = seedItem();
    updateCampaignItem(itemId, { attemptGeneration: 3 });
    recordDriveItemLaunchLinkage(campaignId, itemId, "launch-retry");
    assert.equal(getItemLaunch(campaignId, itemId, 3)?.sourceLaunchId, "launch-retry");
    assert.equal(getItemLaunch(campaignId, itemId, 1), undefined, "not recorded under the wrong generation");
  });
});

describe("recordDriveItemLaunchLinkage — born-under fencing token derivation (AC7/AC10)", () => {
  test("with a held campaign-controller lease, the born-under token is the live lease owner/generation", () => {
    const { campaignId, itemId } = seedItem();
    const owner = `campaign@${campaignId}@instance-A`;
    const grant = acquireCampaignLease({ campaignId, owner, ttlMs: TTL });
    assert.ok(grant.granted);
    recordDriveItemLaunchLinkage(campaignId, itemId, "launch-leased");
    const link = getItemLaunch(campaignId, itemId, 1);
    assert.equal(link?.controllerOwner, owner, "born-under owner is the held lease owner");
    assert.equal(link?.controllerGeneration, grant.lease.generation);
  });

  test("an explicit token overrides the held lease (the executor passes the drive's held lease)", () => {
    const { campaignId, itemId } = seedItem();
    acquireCampaignLease({ campaignId, owner: `campaign@${campaignId}@instance-A`, ttlMs: TTL });
    recordDriveItemLaunchLinkage(campaignId, itemId, "launch-tok", {
      owner: `campaign@${campaignId}@explicit`,
      generation: 7,
    });
    const link = getItemLaunch(campaignId, itemId, 1);
    assert.equal(link?.controllerOwner, `campaign@${campaignId}@explicit`);
    assert.equal(link?.controllerGeneration, 7);
  });

  test("with NO lease and NO token, the born-under token falls back to a stable launcher label", () => {
    const { campaignId, itemId } = seedItem();
    recordDriveItemLaunchLinkage(campaignId, itemId, "launch-unleased");
    const link = getItemLaunch(campaignId, itemId, 1);
    assert.equal(link?.controllerOwner, `campaign@${campaignId}@launcher`);
    assert.equal(link?.controllerGeneration, 0, "generation 0 is the unleased-launcher marker");
  });
});

describe("recordDriveItemLaunchLinkage — run id carry + direct discovery (AC10)", () => {
  test("an item that already carries a run id records it into the linkage", () => {
    const { campaignId, itemId } = seedItem();
    updateCampaignItem(itemId, { runId: "run-existing" });
    recordDriveItemLaunchLinkage(campaignId, itemId, "launch-withrun");
    assert.equal(getItemLaunch(campaignId, itemId, 1)?.runId, "run-existing");
  });

  test("the linkage is discoverable DIRECTLY by source launch id — no name/argv archaeology", () => {
    const { campaignId, itemId } = seedItem();
    recordDriveItemLaunchLinkage(campaignId, itemId, "launch-discoverme");
    const byLaunch = itemLaunchBySourceLaunch("launch-discoverme");
    assert.ok(byLaunch, "recovery resolves the item-attempt identity straight from the launch id");
    assert.equal(byLaunch?.campaignId, campaignId);
    assert.equal(byLaunch?.itemId, itemId);
  });
});

describe("recordDriveItemLaunchLinkage — P1-F fail-closed", () => {
  test("throws (does NOT silently record) when the item does not exist", () => {
    const c = createCampaign({
      sourceKind: "list",
      sourceInput: { kind: "list", ticketIds: ["FG-1"] },
      mode: "dry_run",
    });
    assert.throws(
      () => recordDriveItemLaunchLinkage(c.id, "no-such-item", "launch-x"),
      /not found/,
      "an unlinked launch must fail closed, not proceed",
    );
  });

  test("throws when the item belongs to a DIFFERENT campaign (mismatched linkage refused)", () => {
    const { itemId } = seedItem();
    const other = createCampaign({
      sourceKind: "list",
      sourceInput: { kind: "list", ticketIds: ["FG-9"] },
      mode: "dry_run",
    });
    assert.throws(
      () => recordDriveItemLaunchLinkage(other.id, itemId, "launch-x"),
      /not found/,
    );
  });
});
