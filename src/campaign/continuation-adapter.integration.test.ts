// FG-564 (Slice 5b): the CAMPAIGN adapter falsification suite — AC5, AC-ADOPT-DRIVE, and
// the C2/C4/C5 crash windows — driven through the PRODUCTION consumer
// (consumeCampaignContinuation -> consumeCore) + the REAL FG-562 store + the REAL FG-596
// reservation. Fault injection is focused at the production seams only (the launch reader,
// the createRun/driveItem seams, the lease clock).
//
// Tests run REAL store code against a real in-memory SQLite DB (makeInMemoryDb).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  createCampaign,
  addCampaignItem,
  getCampaignItem,
  tryTransitionCampaignToRunning,
  deriveCampaignItemDispatchKey,
} from "../store/campaigns.js";
import { insertRun, resolveRunProjectIdentity, runByDispatchKey } from "../store/runs.js";
import { recordContinuation, getContinuation } from "../store/continuations.js";
import { acquireCampaignLease } from "../store/campaign-controller.js";
import {
  consumeCampaignContinuation,
  campaignContinuationId,
  campaignItemPhase,
  driveCampaignItemAction,
  type CampaignDispatchDeps,
} from "./continuation-adapter.js";
import type { LaunchStatus, LaunchView } from "../v2/launch.js";

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

const TERMINAL: LaunchStatus = { state: "exited_ok", code: 0 };
const TTL = 5 * 60 * 1000;

function reader(status: LaunchStatus | undefined) {
  return (id: string): LaunchView | undefined =>
    status === undefined ? undefined : ({ id, status } as unknown as LaunchView);
}

/** A prepareItemDispatch seam whose createRun inserts a real run stamped with the FG-596
 *  dispatch key + gen. Driver "pipeline" — these tests exercise the reservation/lease/fence
 *  mechanics, not lane routing. */
function makePrepare(runIdBox: { id?: string }): CampaignDispatchDeps["prepareItemDispatch"] {
  return ({ campaignId, itemId }) => ({
    driver: "pipeline",
    createRun: ({ dispatchKey, attemptGeneration }) => {
      const runId = `run-${itemId}-${attemptGeneration}`;
      runIdBox.id = runId;
      insertRun(
        {
          id: runId,
          workflow: "campaign-drive",
          title: `${campaignId}/${itemId}`,
          status: "active",
          createdAt: "2026-07-20T00:00:00Z",
          metadata: { dispatchKey },
          projectDir: "/tmp/p",
        },
        // FG-663: identity resolved and handed in — this createRun runs inside the
        // reservation's write lock, where a git subprocess must never be held.
        resolveRunProjectIdentity("/tmp/p"),
      );
      return runId;
    },
  });
}

/** A driveItem spy that records launch/re-drive requests without any docker/tmux. */
function driveSpy() {
  const calls: { itemId: string; runId: string; mode: string; controllerOwner: string }[] = [];
  const fn: CampaignDispatchDeps["driveItem"] = ({ itemId, runId, mode, controllerOwner }) => {
    calls.push({ itemId, runId, mode, controllerOwner });
  };
  return { fn, calls };
}

/** Seed a running campaign with ONE pending next-item and a recorded, terminal-awaiting
 *  continuation for the completed item N whose nextAction names the pending item. */
function seed(opts: { ownerHeld: boolean }): {
  campaignId: string;
  nextItemId: string;
  continuationId: string;
  sourceLaunchId: string;
  lease: { owner: string; generation: number };
} {
  const c = createCampaign({ sourceKind: "list", sourceInput: { kind: "list", ticketIds: ["FG-1", "FG-2"] }, mode: "dry_run" });
  tryTransitionCampaignToRunning(c.id);
  const nextItem = addCampaignItem({ campaignId: c.id, itemOrder: 1, ticketId: "FG-2" });

  const owner = `campaign@${c.id}@instance-A`;
  const grant = acquireCampaignLease({ campaignId: c.id, owner, ttlMs: TTL });
  assert.ok(grant.granted);
  const lease = { owner, generation: grant.lease.generation };

  const continuationId = campaignContinuationId(c.id, "item-N");
  const sourceLaunchId = "launch-item-N";
  recordContinuation({
    continuationId,
    consumerKind: "campaign",
    sourceLaunchId,
    currentPhase: campaignItemPhase("item-N", 1),
    nextAction: driveCampaignItemAction(c.id, nextItem.id),
  });
  return { campaignId: c.id, nextItemId: nextItem.id, continuationId, sourceLaunchId, lease };
}

describe("AC5: reserveCampaignDriveDispatch is the sole item-run authority; two receipts stay distinct", () => {
  test("created: exactly one item-run keyed on the FG-596 dispatch key (NOT the continuation receipt)", () => {
    const s = seed({ ownerHeld: true });
    const runBox: { id?: string } = {};
    const drive = driveSpy();
    const out = consumeCampaignContinuation(
      { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) },
      { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: makePrepare(runBox), driveItem: drive.fn } },
    );
    assert.equal(out.kind, "advanced");
    assert.equal(drive.calls.length, 1);
    assert.equal(drive.calls[0]?.mode, "created");
    // The item-run resolves by the FG-596 item-attempt key — a "ci-" key, NOT the sha256
    // continuation receipt. This is the two-distinct-identity-spaces guarantee.
    const item = getCampaignItem(s.nextItemId)!;
    const fgKey = deriveCampaignItemDispatchKey(s.campaignId, s.nextItemId, item.attemptGeneration);
    assert.ok(fgKey.startsWith("ci-"));
    assert.equal(runByDispatchKey(fgKey)?.id, runBox.id, "the one item-run is keyed on the FG-596 reservation key");
    if (out.kind === "advanced") {
      assert.notEqual(out.dispatchKey, fgKey, "the continuation receipt and the item-attempt key are DIFFERENT keys");
    }
    // The continuation records the resulting immutable run id.
    assert.equal(getContinuation(s.continuationId)?.dispatchedRunId, runBox.id);
    // The driveItem seam carried the current lease as the born-under fencing token (the
    // executor records the durable linkage at real launch time — see the executor recorder).
    assert.equal(drive.calls[0]?.controllerOwner, s.lease.owner);
  });

  test("lost: a non-drivable reservation launches nothing and is NEVER marked advanced (RED)", () => {
    const s = seed({ ownerHeld: true });
    // Park the next item out from under the reservation so reserve returns `lost`.
    db.prepare(`UPDATE campaign_items SET lifecycle_status = 'complete' WHERE id = ?`).run(s.nextItemId);
    const drive = driveSpy();
    const out = consumeCampaignContinuation(
      { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) },
      { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: makePrepare({}), driveItem: drive.fn } },
    );
    assert.equal(out.kind, "blocked", "a lost reservation is recoverable, not advanced");
    assert.equal(drive.calls.length, 0, "nothing launched");
    assert.notEqual(getContinuation(s.continuationId)?.state, "advanced");
  });
});

describe("AC-ADOPT-DRIVE: converting an adopted reservation to a physical re-drive is lease-gated", () => {
  function seedAdopted(): ReturnType<typeof seed> & { attemptGeneration: number; existingRunId: string } {
    const s = seed({ ownerHeld: true });
    // Pre-create the item-run at the FG-596 key for the first attempt generation (1), so the
    // reservation returns `adopted` rather than `created`.
    const attemptGeneration = 1;
    const key = deriveCampaignItemDispatchKey(s.campaignId, s.nextItemId, attemptGeneration);
    const existingRunId = "run-preexisting";
    insertRun({
      id: existingRunId, workflow: "campaign-drive", title: "adopted", status: "active",
      createdAt: "2026-07-20T00:00:00Z", metadata: { dispatchKey: key }, projectDir: "/tmp/p",
    });
    return { ...s, attemptGeneration, existingRunId };
  }

  test("RED: a controller WITHOUT the live lease is FENCED from re-driving an adopted reservation", () => {
    const s = seedAdopted();
    const drive = driveSpy();
    // A second controller presents a STALE lease identity (generation it never held).
    const staleLease = { owner: `campaign@${s.campaignId}@instance-B`, generation: 99 };
    const out = consumeCampaignContinuation(
      { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) },
      { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: staleLease, prepareItemDispatch: makePrepare({}), driveItem: drive.fn } },
    );
    assert.equal(out.kind, "blocked");
    if (out.kind === "blocked") assert.match(out.error, /AC-ADOPT-DRIVE/);
    assert.equal(drive.calls.length, 0, "a non-lease-holder launches NO physical re-drive");
    assert.notEqual(getContinuation(s.continuationId)?.state, "advanced");
  });

  test("GREEN: the live lease holder re-drives the ONE existing run (no duplicate)", () => {
    const s = seedAdopted();
    const drive = driveSpy();
    const out = consumeCampaignContinuation(
      { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) },
      { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: makePrepare({}), driveItem: drive.fn } },
    );
    assert.equal(out.kind, "advanced");
    assert.equal(drive.calls.length, 1);
    assert.equal(drive.calls[0]?.mode, "adopted");
    assert.equal(drive.calls[0]?.runId, s.existingRunId, "the ONE existing item-run is re-driven, not a duplicate");
    assert.equal(getContinuation(s.continuationId)?.dispatchedRunId, s.existingRunId);
  });

  test("takeover only after expiry: the expired former owner stays fenced; the new owner drives", () => {
    const s = seedAdopted();
    // Age the clock past the original lease so a fresh controller can take over.
    setPublicationClockOffsetForTest(TTL + 1);
    // The expired former owner is fenced (its lease lapsed).
    const driveExpired = driveSpy();
    const outExpired = consumeCampaignContinuation(
      { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) },
      { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: makePrepare({}), driveItem: driveExpired.fn } },
    );
    assert.equal(outExpired.kind, "blocked", "the expired former owner remains fenced");
    assert.equal(driveExpired.calls.length, 0);

    // A fresh controller takes over the lease AFTER expiry, then drives.
    const newOwner = `campaign@${s.campaignId}@instance-B`;
    const grant = acquireCampaignLease({ campaignId: s.campaignId, owner: newOwner, ttlMs: TTL });
    assert.ok(grant.granted && grant.mode === "took_over");
    const newLease = { owner: newOwner, generation: grant.lease.generation };
    const driveNew = driveSpy();
    const outNew = consumeCampaignContinuation(
      { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) },
      { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: newLease, prepareItemDispatch: makePrepare({}), driveItem: driveNew.fn } },
    );
    assert.equal(outNew.kind, "advanced");
    assert.equal(driveNew.calls.length, 1);
    assert.equal(driveNew.calls[0]?.runId, s.existingRunId, "still the ONE existing run — no duplicate after takeover");
  });
});

describe("crash windows through the production consumer", () => {
  test("C4: dies after the reservation commits, before the continuation records the run id — recovery adopts the ONE run", () => {
    const s = seed({ ownerHeld: true });
    // Simulate the reservation having ALREADY committed (item-attempt key stamped) by a
    // crashed prior attempt: create the item-run at the FG-596 key and mark the item running.
    const key = deriveCampaignItemDispatchKey(s.campaignId, s.nextItemId, 1);
    insertRun({ id: "run-crashed", workflow: "campaign-drive", title: "c4", status: "active", createdAt: "2026-07-20T00:00:00Z", metadata: { dispatchKey: key }, projectDir: "/tmp/p" });
    const drive = driveSpy();
    const out = consumeCampaignContinuation(
      { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) },
      { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: makePrepare({}), driveItem: drive.fn } },
    );
    assert.equal(out.kind, "advanced");
    assert.equal(drive.calls[0]?.mode, "adopted", "the FG-596 reservation returned adopted");
    assert.equal(drive.calls[0]?.runId, "run-crashed", "the one existing run is used at all levels");
    // No duplicate run at the key.
    assert.equal(runByDispatchKey(key)?.id, "run-crashed");
  });

  test("C5: a completion delivered twice yields exactly one advance and one item-run", () => {
    const s = seed({ ownerHeld: true });
    const runBox: { id?: string } = {};
    const drive = driveSpy();
    const deps = { owner: s.lease.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: makePrepare(runBox), driveItem: drive.fn } };
    const id = { continuationId: s.continuationId, sourceLaunchId: s.sourceLaunchId, consumerKind: "campaign" as const, currentPhase: campaignItemPhase("item-N", 1), nextAction: driveCampaignItemAction(s.campaignId, s.nextItemId) };
    const first = consumeCampaignContinuation(id, deps);
    const second = consumeCampaignContinuation(id, deps);
    assert.equal(first.kind, "advanced");
    assert.equal(second.kind, "already_advanced");
    assert.equal(drive.calls.length, 1, "exactly one launch across a duplicate delivery");
  });
});
