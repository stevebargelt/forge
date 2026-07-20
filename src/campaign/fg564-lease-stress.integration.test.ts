// FG-564 (Slice 5b, AC7): campaign-controller lease host-stress — the no-double-driver
// invariant proven across MANY interleavings of renew / clock-advance / takeover, not a
// single run. better-sqlite3 serializes writers on BEGIN IMMEDIATE, so each iteration
// exercises a distinct ordering of the owner/generation-scoped CAS against the store clock.
//
// The load-bearing invariant: at every observed instant AT MOST ONE (owner, generation) holds
// the live lease and may drive — a renewing incumbent and a would-be replacement can never
// BOTH be authorized. Tests run REAL store code against a real in-memory SQLite DB.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  createCampaign,
  addCampaignItem,
  updateCampaignItem,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import {
  acquireCampaignLease,
  renewCampaignLease,
  campaignLeaseHeldBy,
  getCampaignLease,
} from "../store/campaign-controller.js";
import { driveRemainingItems, type DriveItemLaunchFn } from "./executor.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

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

const TTL = 1000;

function seedCampaign(): string {
  return createCampaign({ sourceKind: "list", sourceInput: { kind: "list", ticketIds: ["A"] }, mode: "dry_run" }).id;
}

/** How many (owner, generation) pairs currently hold the live lease. Must NEVER exceed 1. */
function liveHolders(campaignId: string, candidates: { owner: string; generation: number }[]): number {
  return candidates.filter((c) => campaignLeaseHeldBy(campaignId, c.owner, c.generation)).length;
}

describe("AC7 lease host-stress: no double-driver across many interleavings", () => {
  test("renew vs takeover races never authorize two drivers at once", () => {
    const cid = seedCampaign();
    const A = `campaign@${cid}@A`;
    const B = `campaign@${cid}@B`;
    acquireCampaignLease({ campaignId: cid, owner: A, ttlMs: TTL });

    let offset = 0;
    // Track the candidate identities that could plausibly hold the lease at any point.
    const candidates: { owner: string; generation: number }[] = [
      { owner: A, generation: 1 },
      { owner: A, generation: 2 },
      { owner: B, generation: 2 },
      { owner: B, generation: 3 },
    ];

    for (let i = 0; i < 800; i++) {
      // Vary the interleaving deterministically by iteration index (no Math.random — keep it
      // reproducible): sometimes the incumbent renews first, sometimes the clock jumps past
      // expiry first, sometimes a takeover is attempted before a renew.
      const mode = i % 4;
      const jump = (i % 3) * 400; // 0, 400, or 800ms of aging per iteration
      const holder = getCampaignLease(cid)!;

      if (mode === 0) {
        // Incumbent renews, THEN the clock advances a little.
        renewCampaignLease(cid, holder.owner, holder.generation, TTL);
        offset += jump;
        setPublicationClockOffsetForTest(offset);
      } else if (mode === 1) {
        // Clock advances first, THEN incumbent tries to renew (may fail if it lapsed).
        offset += jump;
        setPublicationClockOffsetForTest(offset);
        renewCampaignLease(cid, holder.owner, holder.generation, TTL);
      } else if (mode === 2) {
        // Clock advances, then a replacement attempts takeover (succeeds only after expiry).
        offset += jump;
        setPublicationClockOffsetForTest(offset);
        acquireCampaignLease({ campaignId: cid, owner: B, ttlMs: TTL });
      } else {
        // A replacement attempts takeover WITHOUT aging (should be denied while live).
        acquireCampaignLease({ campaignId: cid, owner: A === holder.owner ? B : A, ttlMs: TTL });
      }

      // THE INVARIANT: at this instant, at most one candidate holds the live lease.
      assert.ok(
        liveHolders(cid, candidates) <= 1,
        `iteration ${i}: more than one live lease holder — double-driver window`,
      );
    }
  });

  test("across many post-expiry takeover races exactly one generation ever wins each round", () => {
    const cid = seedCampaign();
    let generation = 1;
    acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@seed`, ttlMs: TTL });

    let offset = 0;
    for (let round = 0; round < 200; round++) {
      // Age past expiry, then race many fresh controllers to take over this round.
      offset += TTL + 1;
      setPublicationClockOffsetForTest(offset);
      let winners = 0;
      for (let r = 0; r < 20; r++) {
        const g = acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@r${round}-${r}`, ttlMs: TTL });
        if (g.granted && g.mode === "took_over") winners++;
      }
      assert.equal(winners, 1, `round ${round}: exactly one takeover wins`);
      generation += 1;
      assert.equal(getCampaignLease(cid)?.generation, generation, `round ${round}: generation advanced by exactly one`);
    }
  });
});

// ── FG-564 (D1, item 2): the lease-renewal HEARTBEAT must cover the WHOLE blocking drive ──
// A single pre-launch renewal cannot fence a drive longer than the TTL: the lease lapses
// mid-drive and a second controller takes over the item still being physically driven. These
// prove the heartbeat (which fires DURING the blocking wait, since the wait yields the event
// loop) keeps the ORIGINAL owner holding the lease continuously — and prove it is load-bearing
// by showing that WITHOUT a firing heartbeat the exact double-driver hazard reappears.
const dispatchUnused = async (_a: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("dispatch must not be called — the drive is injected");
};

function runningCampaignWithOneItem(): { cid: string; itemId: string } {
  const c = createCampaign({ sourceKind: "list", sourceInput: { kind: "list", ticketIds: ["A"] }, mode: "sequential", projectDir: "/tmp/proj" });
  tryTransitionCampaignToRunning(c.id);
  const item = addCampaignItem({ campaignId: c.id, itemOrder: 0, ticketId: "A" });
  return { cid: c.id, itemId: item.id };
}

describe("D1 (item 2): lease-renewal heartbeat covers a blocking drive that outlives the TTL", () => {
  test("a drive LONGER than the TTL keeps the lease continuously held by the original owner — a second controller can NEVER take over mid-drive", async () => {
    const { cid, itemId } = runningCampaignWithOneItem();
    const A = `campaign@${cid}@A`;
    const B = `campaign@${cid}@B`;
    const HB_TTL = 300; // store-clock ms — the nominal lease TTL
    const renewIntervalMs = 2; // real ms — the heartbeat cadence

    let offset = 0;
    let takeoverGrants = 0;
    let takeoverDenials = 0;
    let aHeldObservations = 0;

    // A long per-item drive that OUTLIVES the TTL many times over. It yields the event loop
    // (real setTimeout) so the parent's heartbeat interval can fire, and advances the store
    // clock well past a single lease's expiry — the exact D1 hazard window.
    const longDrive: DriveItemLaunchFn = async (_c, id) => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 6));
        offset += HB_TTL / 5; // age the store clock ~12x the TTL across the whole drive
        setPublicationClockOffsetForTest(offset);
        // A second controller B relentlessly tries to take over while A physically drives.
        const b = acquireCampaignLease({ campaignId: cid, owner: B, ttlMs: HB_TTL });
        if (b.granted && b.mode === "took_over") takeoverGrants++;
        else takeoverDenials++;
        // The original owner A#1 still holds the live lease at every observed instant.
        if (campaignLeaseHeldBy(cid, A, 1)) aHeldObservations++;
      }
      updateCampaignItem(id, { lifecycleStatus: "complete", outcome: "shipped" });
      return { itemRecords: [{ itemId: id, ticketId: "A", lifecycleStatus: "complete", outcome: "shipped" }] };
    };

    await driveRemainingItems(cid, {
      dispatch: dispatchUnused,
      projectDir: "/tmp/proj",
      mode: "sequential",
      launchDriveItem: longDrive,
      controllerOwner: A,
      controllerLeaseTtlMs: HB_TTL,
      controllerRenewIntervalMs: renewIntervalMs,
    });

    assert.equal(takeoverGrants, 0, "NO second controller may take over while the heartbeat keeps the lease live");
    assert.ok(takeoverDenials >= 60, `B was denied at every attempt (got ${takeoverDenials} denials)`);
    assert.equal(aHeldObservations, 60, "the original owner A#1 held the live lease at EVERY observed instant across the whole drive");
  });

  test("load-bearing: WITHOUT a firing heartbeat, the SAME over-TTL drive lets a second controller take over mid-drive (the exact hazard the heartbeat fences)", async () => {
    const { cid, itemId } = runningCampaignWithOneItem();
    const A = `campaign@${cid}@A`;
    const B = `campaign@${cid}@B`;
    const HB_TTL = 300;

    let offset = 0;
    let takeoverGrants = 0;
    const longDrive: DriveItemLaunchFn = async (_c, id) => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 6));
        offset += HB_TTL / 5;
        setPublicationClockOffsetForTest(offset);
        const b = acquireCampaignLease({ campaignId: cid, owner: B, ttlMs: HB_TTL });
        if (b.granted && b.mode === "took_over") takeoverGrants++;
      }
      updateCampaignItem(id, { lifecycleStatus: "complete", outcome: "shipped" });
      return { itemRecords: [{ itemId: id, ticketId: "A", lifecycleStatus: "complete", outcome: "shipped" }] };
    };

    // A renew interval far LONGER than the whole drive → the heartbeat never fires mid-drive, so
    // only the single up-front renewal fences the drive (the pre-fix behavior).
    await driveRemainingItems(cid, {
      dispatch: dispatchUnused,
      projectDir: "/tmp/proj",
      mode: "sequential",
      launchDriveItem: longDrive,
      controllerOwner: A,
      controllerLeaseTtlMs: HB_TTL,
      controllerRenewIntervalMs: 60 * 60 * 1000,
    });

    assert.ok(takeoverGrants >= 1, "a single renewal cannot fence an over-TTL drive — B takes over mid-drive (this is what the heartbeat fixes)");
    void itemId;
  });
});
