// FG-564 (Slice 5b, D1/AC7/AC10): the campaign-controller store — REAL store code
// against a real in-memory SQLite DB (makeInMemoryDb), never ~/.forge/forge.db.
//
// The lease is the fence for the ONE live physical driver; the item-attempt launch
// linkage is the durable record recovery discovers directly. Both are proven against
// the store's own clock (setPublicationClockOffsetForTest ages a lease past expiry),
// with owner/generation-scoped CAS falsified: a replacement CANNOT renew or drive under
// a still-live prior lease; an expired original owner is fenced after a takeover.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { createCampaign } from "./campaigns.js";
import {
  acquireCampaignLease,
  renewCampaignLease,
  campaignLeaseHeldBy,
  releaseCampaignLease,
  getCampaignLease,
  recordItemLaunch,
  getItemLaunch,
  itemLaunchBySourceLaunch,
  inFlightItemLaunches,
  updateItemLaunch,
} from "./campaign-controller.js";

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

function seedCampaign(): string {
  const c = createCampaign({
    sourceKind: "list",
    sourceInput: { kind: "list", ticketIds: ["FG-101"] },
    mode: "dry_run",
  });
  return c.id;
}

const ownerA = "campaign@cmp@instance-A";
const ownerB = "campaign@cmp@instance-B";

describe("campaign-controller lease (AC7/D1)", () => {
  test("fresh acquire creates generation 1", () => {
    const cid = seedCampaign();
    const g = acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    assert.ok(g.granted);
    assert.equal(g.mode, "created");
    assert.equal(g.lease.generation, 1);
    assert.equal(g.lease.owner, ownerA);
  });

  test("same owner re-acquire renews at the SAME generation (same-instance restart)", () => {
    const cid = seedCampaign();
    acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    const g2 = acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    assert.ok(g2.granted);
    assert.equal(g2.mode, "renewed");
    assert.equal(g2.lease.generation, 1);
  });

  test("RED: a replacement owner CANNOT take over while the prior lease is LIVE", () => {
    const cid = seedCampaign();
    acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    const g = acquireCampaignLease({ campaignId: cid, owner: ownerB, ttlMs: TTL });
    assert.equal(g.granted, false);
    if (!g.granted) {
      assert.equal(g.reason, "held_by_live_owner");
      assert.equal(g.lease.owner, ownerA);
      assert.equal(g.lease.generation, 1);
    }
  });

  test("GREEN: a replacement takes over ONLY after strict expiry, bumping the generation", () => {
    const cid = seedCampaign();
    acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    // Age the store clock past the lease.
    setPublicationClockOffsetForTest(TTL + 1);
    const g = acquireCampaignLease({ campaignId: cid, owner: ownerB, ttlMs: TTL });
    assert.ok(g.granted);
    assert.equal(g.mode, "took_over");
    assert.equal(g.lease.owner, ownerB);
    assert.equal(g.lease.generation, 2);
  });

  test("an EXPIRED original owner cannot renew after a takeover bumped the generation", () => {
    const cid = seedCampaign();
    acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    setPublicationClockOffsetForTest(TTL + 1);
    acquireCampaignLease({ campaignId: cid, owner: ownerB, ttlMs: TTL }); // gen 2, ownerB
    // The expired original owner A (still holding generation 1) cannot renew.
    assert.equal(renewCampaignLease(cid, ownerA, 1, TTL), false);
    // And is no longer authorized for any physical work.
    assert.equal(campaignLeaseHeldBy(cid, ownerA, 1), false);
    // The new owner holds it.
    assert.equal(campaignLeaseHeldBy(cid, ownerB, 2), true);
  });

  test("campaignLeaseHeldBy is false once the lease expires, true while live", () => {
    const cid = seedCampaign();
    acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    assert.equal(campaignLeaseHeldBy(cid, ownerA, 1), true);
    setPublicationClockOffsetForTest(TTL + 1);
    assert.equal(campaignLeaseHeldBy(cid, ownerA, 1), false, "expired lease is not held");
  });

  test("renewCampaignLease extends a live lease across a long drive; wrong generation is fenced", () => {
    const cid = seedCampaign();
    acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    // Renew mid-drive, with real headroom to spare: the store clock is a LIVE ticking
    // clock plus this offset, so renewing at TTL-1 would assert "a lease with 1ms left
    // renews within 1ms of wall clock" rather than "a live lease renews" (FG-623).
    setPublicationClockOffsetForTest(TTL / 2);
    assert.equal(renewCampaignLease(cid, ownerA, 1, TTL), true);
    setPublicationClockOffsetForTest(TTL + 1);
    assert.equal(campaignLeaseHeldBy(cid, ownerA, 1), true, "renewal kept it live");
    // A stale generation cannot renew.
    assert.equal(renewCampaignLease(cid, ownerA, 99, TTL), false);
  });

  test("releaseCampaignLease is owner/generation-scoped", () => {
    const cid = seedCampaign();
    acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    assert.equal(releaseCampaignLease(cid, ownerB, 1), false, "wrong owner cannot release");
    assert.equal(releaseCampaignLease(cid, ownerA, 1), true);
    assert.equal(getCampaignLease(cid), undefined);
  });

  test("host-stress: exactly one winner acquires a fresh lease across many racing takeovers", () => {
    const cid = seedCampaign();
    // Prime an expired lease, then race N fresh controllers to take it over. Because
    // each transaction is BEGIN IMMEDIATE and the takeover is generation-scoped, exactly
    // one bumps to generation 2 and the rest observe held_by_live_owner.
    acquireCampaignLease({ campaignId: cid, owner: "campaign@cmp@seed", ttlMs: TTL });
    setPublicationClockOffsetForTest(TTL + 1);
    let winners = 0;
    for (let i = 0; i < 500; i++) {
      const g = acquireCampaignLease({ campaignId: cid, owner: `campaign@cmp@racer-${i}`, ttlMs: TTL });
      if (g.granted && g.mode === "took_over") winners++;
    }
    assert.equal(winners, 1, "exactly one takeover wins; the rest see a live lease");
    assert.equal(getCampaignLease(cid)?.generation, 2);
  });
});

describe("item-attempt launch linkage (AC10)", () => {
  test("record then discover directly by (campaign,item,attempt) and by source launch", () => {
    const cid = seedCampaign();
    recordItemLaunch({
      campaignId: cid,
      itemId: "item-1",
      attemptGeneration: 1,
      sourceLaunchId: "launch-xyz",
      controllerOwner: ownerA,
      controllerGeneration: 1,
    });
    const byKey = getItemLaunch(cid, "item-1", 1);
    assert.ok(byKey);
    assert.equal(byKey?.sourceLaunchId, "launch-xyz");
    assert.equal(byKey?.state, "launched");
    const byLaunch = itemLaunchBySourceLaunch("launch-xyz");
    assert.equal(byLaunch?.itemId, "item-1");
    // The born-under token is captured immutably.
    assert.equal(byLaunch?.controllerOwner, ownerA);
    assert.equal(byLaunch?.controllerGeneration, 1);
  });

  test("re-record is idempotent and NEVER overwrites the immutable born-under token", () => {
    const cid = seedCampaign();
    recordItemLaunch({
      campaignId: cid,
      itemId: "item-1",
      attemptGeneration: 1,
      sourceLaunchId: "launch-xyz",
      controllerOwner: ownerA,
      controllerGeneration: 1,
    });
    // A recovery re-records under a DIFFERENT (current) lease owner/generation. The
    // born-under token must stay the ORIGINAL — AC-ADOPT-DRIVE compares born-vs-current.
    recordItemLaunch({
      campaignId: cid,
      itemId: "item-1",
      attemptGeneration: 1,
      sourceLaunchId: "launch-xyz",
      controllerOwner: ownerB,
      controllerGeneration: 2,
      state: "continuation_recorded",
    });
    const l = getItemLaunch(cid, "item-1", 1);
    assert.equal(l?.controllerOwner, ownerA, "born-under owner is immutable");
    assert.equal(l?.controllerGeneration, 1, "born-under generation is immutable");
    assert.equal(l?.state, "continuation_recorded", "state advances");
  });

  test("a rearmed retry (new attempt generation) gets its OWN row", () => {
    const cid = seedCampaign();
    recordItemLaunch({
      campaignId: cid, itemId: "item-1", attemptGeneration: 1,
      sourceLaunchId: "launch-a", controllerOwner: ownerA, controllerGeneration: 1,
    });
    recordItemLaunch({
      campaignId: cid, itemId: "item-1", attemptGeneration: 2,
      sourceLaunchId: "launch-b", controllerOwner: ownerA, controllerGeneration: 1,
    });
    assert.equal(getItemLaunch(cid, "item-1", 1)?.sourceLaunchId, "launch-a");
    assert.equal(getItemLaunch(cid, "item-1", 2)?.sourceLaunchId, "launch-b");
  });

  test("run_id is immutable once set; state advances; settled drops out of the in-flight set", () => {
    const cid = seedCampaign();
    recordItemLaunch({
      campaignId: cid, itemId: "item-1", attemptGeneration: 1,
      sourceLaunchId: "launch-a", controllerOwner: ownerA, controllerGeneration: 1,
    });
    assert.equal(updateItemLaunch(cid, "item-1", 1, { runId: "run-1", state: "observed" }), true);
    assert.equal(updateItemLaunch(cid, "item-1", 1, { runId: "run-2" }), true);
    assert.equal(getItemLaunch(cid, "item-1", 1)?.runId, "run-1", "run id is immutable once set");
    assert.equal(inFlightItemLaunches({ campaignId: cid }).length, 1);
    updateItemLaunch(cid, "item-1", 1, { state: "settled" });
    assert.equal(inFlightItemLaunches({ campaignId: cid }).length, 0, "settled drops out");
  });
});
