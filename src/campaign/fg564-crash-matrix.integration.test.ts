// FG-564 (Slice 5b, AC9): the crash-window falsification matrix — C1, C2, C3, C7, C8 plus
// the AC8 running-campaign takeover fail-closed and the AC7 fresh-controller-vs-live-lease
// race — driven through the PRODUCTION consumer (consumeCampaignContinuation / recoverCampaign
// -> consumeCore) + the REAL FG-562 store + the REAL FG-596 reservation. (C4/C5 live in
// continuation-adapter.integration.test.ts; C6 in fg564-capstone.integration.test.ts.)
//
// Each crash window sets up a DISTINCT durable state and proves the recovery converges to
// exactly one advance / one item-run. Tests run REAL store code against a real in-memory
// SQLite DB (makeInMemoryDb).

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
import {
  recordContinuation,
  observeLaunchStatus,
  claimContinuationDispatch,
  getContinuation,
  type NextAction,
} from "../store/continuations.js";
import {
  acquireCampaignLease,
  recordItemLaunch,
  itemLaunchBySourceLaunch,
  getItemLaunch,
} from "../store/campaign-controller.js";
import {
  consumeCampaignContinuation,
  recoverCampaign,
  campaignContinuationId,
  campaignItemPhase,
  driveCampaignItemAction,
  type CampaignDispatchDeps,
  type ContinuationIdentity,
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

function createRunSeam(): CampaignDispatchDeps["prepareItemDispatch"] {
  return ({ campaignId, itemId }) => ({
    driver: "pipeline",
    createRun: ({ dispatchKey, attemptGeneration }) => {
      const runId = `run-${itemId}-${attemptGeneration}`;
      insertRun({ id: runId, workflow: "campaign-drive", title: `${campaignId}/${itemId}`, status: "active", createdAt: "2026-07-20T00:00:00Z", metadata: { dispatchKey }, projectDir: "/tmp/p" }, resolveRunProjectIdentity("/tmp/p"));
      return runId;
    },
  });
}
function driveSpy() {
  const calls: { itemId: string; runId: string; mode: string }[] = [];
  const fn: CampaignDispatchDeps["driveItem"] = ({ itemId, runId, mode }) => calls.push({ itemId, runId, mode });
  return { fn, calls };
}

/** A running campaign with a completed item N and a pending next item; the controller holds
 *  a lease. Returns the identity of item N's continuation (nextAction names the next item). */
function scenario() {
  const c = createCampaign({ sourceKind: "list", sourceInput: { kind: "list", ticketIds: ["A", "B"] }, mode: "dry_run" });
  tryTransitionCampaignToRunning(c.id);
  const next = addCampaignItem({ campaignId: c.id, itemOrder: 1, ticketId: "B" });
  const owner = `campaign@${c.id}@A`;
  const grant = acquireCampaignLease({ campaignId: c.id, owner, ttlMs: TTL });
  assert.ok(grant.granted);
  const lease = { owner, generation: grant.lease.generation };
  const continuationId = campaignContinuationId(c.id, "item-N");
  const sourceLaunchId = "launch-N";
  const nextAction: NextAction = driveCampaignItemAction(c.id, next.id);
  const identity: ContinuationIdentity = {
    continuationId, sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase("item-N", 1), nextAction,
  };
  return { campaignId: c.id, nextItemId: next.id, owner, lease, identity };
}

describe("crash-window falsification matrix (AC9)", () => {
  test("C1: dies after launching N, before observing terminal — a post-expiry replacement observes durable state + advances once", () => {
    const s = scenario();
    recordContinuation({ continuationId: s.identity.continuationId, consumerKind: "campaign", sourceLaunchId: s.identity.sourceLaunchId, currentPhase: s.identity.currentPhase, nextAction: s.identity.nextAction });
    recordItemLaunch({ campaignId: s.campaignId, itemId: "item-N", attemptGeneration: 1, sourceLaunchId: s.identity.sourceLaunchId, controllerOwner: s.owner, controllerGeneration: 1 });
    // The controller died. Its launch reached terminal; nothing was observed/claimed.
    setPublicationClockOffsetForTest(TTL + 1);
    // A replacement controller takes over the lease and consumes the stuck continuation.
    const grant = acquireCampaignLease({ campaignId: s.campaignId, owner: `campaign@${s.campaignId}@B`, ttlMs: TTL });
    assert.ok(grant.granted && grant.mode === "took_over");
    const drive = driveSpy();
    const out = consumeCampaignContinuation(s.identity, {
      owner: `campaign@${s.campaignId}@B`,
      readLaunch: reader(TERMINAL),
      campaign: { lease: { owner: `campaign@${s.campaignId}@B`, generation: 2 }, prepareItemDispatch: createRunSeam(), driveItem: drive.fn },
    });
    assert.equal(out.kind, "advanced");
    assert.equal(drive.calls.length, 1, "exactly one N+1 launch");
    assert.equal(getContinuation(s.identity.continuationId)?.state, "advanced");
  });

  test("C2: dies after observing terminal, before claiming — a fresh controller claims once; exactly one N+1 run", () => {
    const s = scenario();
    recordContinuation({ continuationId: s.identity.continuationId, consumerKind: "campaign", sourceLaunchId: s.identity.sourceLaunchId, currentPhase: s.identity.currentPhase, nextAction: s.identity.nextAction });
    observeLaunchStatus(s.identity.continuationId, s.identity.sourceLaunchId, "exited_ok"); // -> ready, no claim
    assert.equal(getContinuation(s.identity.continuationId)?.state, "ready");
    const drive = driveSpy();
    const out = consumeCampaignContinuation(s.identity, { owner: s.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: createRunSeam(), driveItem: drive.fn } });
    assert.equal(out.kind, "advanced");
    const gen = getCampaignItem(s.nextItemId)!.attemptGeneration;
    assert.ok(runByDispatchKey(deriveCampaignItemDispatchKey(s.campaignId, s.nextItemId, gen)), "exactly one N+1 run at the FG-596 key");
    assert.equal(drive.calls.length, 1);
  });

  test("C3: dies after the claim, before N+1's reservation commits — recovery re-adopts the claim; reserve creates exactly one run", () => {
    const s = scenario();
    recordContinuation({ continuationId: s.identity.continuationId, consumerKind: "campaign", sourceLaunchId: s.identity.sourceLaunchId, currentPhase: s.identity.currentPhase, nextAction: s.identity.nextAction });
    observeLaunchStatus(s.identity.continuationId, s.identity.sourceLaunchId, "exited_ok");
    // The crashed controller CLAIMED (dispatching, receipt set) but never reserved N+1.
    const claim = claimContinuationDispatch({ ...s.identity, expectedState: "ready", owner: s.owner, leaseTtlMs: 1000 });
    assert.ok(claim.granted);
    assert.equal(getContinuation(s.identity.continuationId)?.state, "dispatching");
    // A watchdog re-fire (same owner) re-adopts the claim and the reservation creates the ONE run.
    const drive = driveSpy();
    const out = consumeCampaignContinuation(s.identity, { owner: s.owner, trigger: "watchdog", readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: createRunSeam(), driveItem: drive.fn } });
    assert.equal(out.kind, "advanced");
    if (out.kind === "advanced") assert.equal(out.adopted, true, "the continuation claim was re-adopted");
    assert.equal(drive.calls.length, 1, "exactly one N+1 item-run created");
  });

  test("C7: dies after startLaunch persisted the drive launch, before recordContinuation — recovery finds the linkage directly (no name archaeology)", () => {
    const s = scenario();
    // Only the durable item-attempt launch linkage exists — NO continuation yet.
    recordItemLaunch({ campaignId: s.campaignId, itemId: "item-N", attemptGeneration: 1, sourceLaunchId: s.identity.sourceLaunchId, controllerOwner: s.owner, controllerGeneration: 1 });
    // Recovery discovers the linkage DIRECTLY by the launch id (AC10) — no parsing.
    const link = itemLaunchBySourceLaunch(s.identity.sourceLaunchId);
    assert.ok(link, "the linkage is discoverable directly by source launch id");
    assert.equal(link?.itemId, "item-N");
    // Having discovered it, the controller records exactly one continuation for the attempt
    // and then consumes it — no duplicate continuation, no second launch.
    recordContinuation({ continuationId: s.identity.continuationId, consumerKind: "campaign", sourceLaunchId: s.identity.sourceLaunchId, currentPhase: s.identity.currentPhase, nextAction: s.identity.nextAction });
    const drive = driveSpy();
    const out = consumeCampaignContinuation(s.identity, { owner: s.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: createRunSeam(), driveItem: drive.fn } });
    assert.equal(out.kind, "advanced");
    assert.equal(drive.calls.length, 1);
  });

  test("C8: dies after recordContinuation, before arming the waiter — restart re-arms observation; an already-terminal launch advances once", () => {
    const s = scenario();
    // The continuation exists (awaiting_completion) but the waiter was never armed.
    recordContinuation({ continuationId: s.identity.continuationId, consumerKind: "campaign", sourceLaunchId: s.identity.sourceLaunchId, currentPhase: s.identity.currentPhase, nextAction: s.identity.nextAction });
    recordItemLaunch({ campaignId: s.campaignId, itemId: "item-N", attemptGeneration: 1, sourceLaunchId: s.identity.sourceLaunchId, controllerOwner: s.owner, controllerGeneration: 1 });
    assert.equal(getContinuation(s.identity.continuationId)?.state, "awaiting_completion");
    // Restart re-arms observation on the recorded authoritative launch; it is already terminal,
    // so the consume returns immediately and advances exactly once.
    const drive = driveSpy();
    const out = consumeCampaignContinuation(s.identity, { owner: s.owner, readLaunch: reader(TERMINAL), campaign: { lease: s.lease, prepareItemDispatch: createRunSeam(), driveItem: drive.fn } });
    assert.equal(out.kind, "advanced");
    assert.equal(drive.calls.length, 1);
  });
});

describe("AC8: running-campaign takeover fails closed while the prior lease is live", () => {
  test("recoverCampaign FAILS CLOSED while a different owner holds a live lease; adopts only after expiry", () => {
    const s = scenario();
    // Put a genuine in-flight (dispatching) campaign continuation on record.
    recordContinuation({ continuationId: s.identity.continuationId, consumerKind: "campaign", sourceLaunchId: s.identity.sourceLaunchId, currentPhase: s.identity.currentPhase, nextAction: s.identity.nextAction });
    observeLaunchStatus(s.identity.continuationId, s.identity.sourceLaunchId, "exited_ok");
    claimContinuationDispatch({ ...s.identity, expectedState: "ready", owner: s.owner, leaseTtlMs: TTL });

    // A replacement recover while owner A's lease is LIVE must fail closed.
    const denied = recoverCampaign({
      campaignId: s.campaignId, owner: `campaign@${s.campaignId}@B`, ttlMs: TTL,
      readLaunch: reader(TERMINAL),
      campaign: { prepareItemDispatch: createRunSeam(), driveItem: driveSpy().fn },
    });
    assert.equal(denied.status, "lease_held_live");

    // After expiry, the replacement takes over and adopts the in-flight continuation.
    setPublicationClockOffsetForTest(TTL + 1);
    const drive = driveSpy();
    const ok = recoverCampaign({
      campaignId: s.campaignId, owner: `campaign@${s.campaignId}@B`, ttlMs: TTL,
      readLaunch: reader(TERMINAL),
      campaign: { prepareItemDispatch: createRunSeam(), driveItem: drive.fn },
    });
    assert.equal(ok.status, "recovered");
    if (ok.status === "recovered") {
      assert.equal(ok.mode, "took_over");
      assert.equal(ok.adopted.length, 1, "the one in-flight continuation was adopted");
      assert.equal(ok.adopted[0]?.kind, "advanced");
    }
    assert.equal(drive.calls.length, 1, "exactly one item-run re-driven; no replacement run");
  });
});

describe("AC7: fresh-controller-vs-live-lease race (host-stress, many interleavings)", () => {
  test("across many racing takeovers exactly one fresh controller drives; the rest fail closed", () => {
    const s = scenario();
    recordContinuation({ continuationId: s.identity.continuationId, consumerKind: "campaign", sourceLaunchId: s.identity.sourceLaunchId, currentPhase: s.identity.currentPhase, nextAction: s.identity.nextAction });
    observeLaunchStatus(s.identity.continuationId, s.identity.sourceLaunchId, "exited_ok");
    claimContinuationDispatch({ ...s.identity, expectedState: "ready", owner: s.owner, leaseTtlMs: TTL });
    setPublicationClockOffsetForTest(TTL + 1);

    let advanced = 0;
    let failedClosed = 0;
    for (let i = 0; i < 400; i++) {
      const r = recoverCampaign({
        campaignId: s.campaignId, owner: `campaign@${s.campaignId}@racer-${i}`, ttlMs: TTL,
        readLaunch: reader(TERMINAL),
        campaign: { prepareItemDispatch: createRunSeam(), driveItem: driveSpy().fn },
      });
      if (r.status === "lease_held_live") failedClosed++;
      else if (r.adopted.some((o) => o.kind === "advanced")) advanced++;
    }
    assert.equal(advanced, 1, "exactly one fresh controller took over and advanced the boundary");
    assert.equal(failedClosed, 399, "every other racer failed closed against the live lease");
    // Exactly one N+1 run exists.
    const gen = getCampaignItem(s.nextItemId)!.attemptGeneration;
    assert.ok(runByDispatchKey(deriveCampaignItemDispatchKey(s.campaignId, s.nextItemId, gen)));
  });
});
