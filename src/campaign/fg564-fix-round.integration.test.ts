// FG-564 (Slice 5b, FIX round): the production-wiring + fence corrections the review round
// demanded, each proven RED-before-fix on the real store:
//   P0-B — the C7 double-driver fence actually COMPARES the immutable born-under token: an
//          orphaned drive-item child (expired owner) is denied while a fresh controller holds
//          the lease; and the adapter fences a token mismatch BEFORE any durable write.
//   P1-E — the adapter authorizes (lease held AND token matches) BEFORE reserveCampaignDriveDispatch
//          mutates any durable state — a fenced controller performs NO durable write.
//   P0-A — the normal drive path acquires + owns the campaign-controller lease; a second
//          NORMAL-start controller FAILS CLOSED while the first's lease is live (AC8
//          non-vacuous), and renew/release have real callers.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  createCampaign,
  addCampaignItem,
  getCampaignItem,
  updateCampaignItem,
  tryTransitionCampaignToRunning,
  type CampaignDriveReservation,
} from "../store/campaigns.js";
import {
  acquireCampaignLease,
  getCampaignLease,
  recordItemLaunch,
} from "../store/campaign-controller.js";
import { driveOneCampaignItem, driveRemainingItems, driveWorkflowItem, type DriveOneItemResult } from "./executor.js";
import { makeCampaignDispatch, driveCampaignItemAction } from "./continuation-adapter.js";
import { insertRun } from "../store/runs.js";
import { nowIso } from "../util/ids.js";
import type { Workflow } from "../v2/schema.js";
import type { RunNextResult } from "../v2/runNext.js";

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

function runningCampaignWithItem(): { cid: string; itemId: string } {
  const c = createCampaign({ sourceKind: "list", sourceInput: { kind: "list", ticketIds: ["A"] }, mode: "sequential", projectDir: "/tmp/proj" });
  tryTransitionCampaignToRunning(c.id);
  const item = addCampaignItem({ campaignId: c.id, itemOrder: 0, ticketId: "A" });
  return { cid: c.id, itemId: item.id };
}

describe("FG-564 fix round: C7 child fence resolves the born-under token from the DURABLE linkage (item 3/4)", () => {
  test("RED-before-fix: an orphaned child whose born-under LINKAGE no longer owns the live lease is FENCED — it drives nothing, mutates nothing, and writes NO durable audit", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    // Original controller A holds the lease at generation 1 and its launch recorded the durable
    // born-under linkage (A#1). A takeover after expiry bumped the live lease to a FRESH
    // controller B at generation 2.
    const a = acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@A`, ttlMs: TTL });
    assert.ok(a.granted && a.mode === "created");
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-A", controllerOwner: `campaign@${cid}@A`, controllerGeneration: 1, state: "launched" });
    setPublicationClockOffsetForTest(TTL + 1000);
    const b = acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@B`, ttlMs: TTL });
    assert.ok(b.granted && b.mode === "took_over", `expected B to take over, got ${JSON.stringify(b)}`);

    // The orphaned A child wakes and enforces the fence. It reads its OWN born-under authority
    // from the durable linkage (A#1) — not from any env/caller token — and finds it no longer
    // holds the live lease (B#2 does). It must STOP with no write.
    const eventsBefore = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    let dispatched = false;
    const result = await driveOneCampaignItem(cid, itemId, {
      dispatch: async () => { dispatched = true; return { status: "complete", taskId: "t" } as never; },
      projectDir: "/tmp/proj",
      mode: "sequential",
      enforceFence: true,
    });

    assert.equal(result.stopReason, "recovery_needed", "the fenced child must STOP, not drive");
    assert.equal(dispatched, false, "the fenced child must not dispatch any work");
    const item = getCampaignItem(itemId)!;
    assert.equal(item.lifecycleStatus, "pending", "the fenced child must not mutate the item");
    assert.equal(item.runId, undefined, "the fenced child must not create/link a run");
    // item 4: a fenced/expired child performs NO durable write — not even an audit event.
    const eventsAfter = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    assert.equal(eventsAfter.n, eventsBefore.n, "a fenced child must write NO durable audit event");
  });

  test("RED-before-fix: a raw drive-item invocation with NO durable linkage FAILS CLOSED (absent = denied)", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    // A controller holds the live lease, but the raw child has NO durable launch linkage for its
    // own attempt — there is no born-under authority to resolve, so it must be denied.
    acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@A`, ttlMs: TTL });
    let dispatched = false;
    const result = await driveOneCampaignItem(cid, itemId, {
      dispatch: async () => { dispatched = true; return { status: "complete", taskId: "t" } as never; },
      projectDir: "/tmp/proj",
      mode: "sequential",
      enforceFence: true,
    });
    assert.equal(result.stopReason, "recovery_needed", "a raw invocation with no durable linkage is denied");
    assert.equal(dispatched, false, "no physical work for an unlinked raw invocation");
    assert.equal(getCampaignItem(itemId)!.lifecycleStatus, "pending", "no mutation for an unlinked raw invocation");
  });

  test("GREEN: the child whose durable linkage still holds the live lease is authorized — the fence lets it through", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    const a = acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@A`, ttlMs: TTL });
    assert.ok(a.granted);
    // The durable linkage born under A#1 exists and A still holds the live lease — authorized.
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-A", controllerOwner: `campaign@${cid}@A`, controllerGeneration: a.lease.generation, state: "launched" });
    let reached = false;
    // An authorized child proceeds PAST the fence into the dispatch lane. Post-round-6 that lane
    // resolves its inputs through the shared prepareCampaignItemDispatch authority, which FAILS
    // CLOSED (throws) here — the fixture has no ticket/workflow — so the drive REJECTS. A FENCED
    // child, by contrast, short-circuits at the fence and returns recovery_needed WITHOUT throwing.
    // The rejection is the proof the fence did NOT short-circuit.
    await assert.rejects(
      () =>
        driveOneCampaignItem(cid, itemId, {
          dispatch: async () => { reached = true; return { status: "complete", taskId: "t" } as never; },
          projectDir: "/tmp/proj",
          mode: "sequential",
          enforceFence: true,
          loadWorkflowFn: () => { throw new Error("stop after the fence"); },
        }),
      /ticket .* not found|workflow|fail closed|stop after the fence/,
      "an authorized child proceeds past the fence into the (fail-closed) lane — it does NOT short-circuit at the fence",
    );
    // The fail-closed lane minted no run and left the item pending — but the child DID pass the
    // fence: it entered the lane and threw, rather than returning recovery_needed at the fence.
    assert.equal(getCampaignItem(itemId)!.lifecycleStatus, "pending", "no run minted; the item stays pending");
    void reached;
  });
});

describe("FG-564 fix round: adapter authorizes BEFORE reserving (P1-E) + born-under token fence (P0-B)", () => {
  function spyReserve(): { fn: (o: { campaignId: string; itemId: string; createRun: (c: { dispatchKey: string; attemptGeneration: number }) => string }) => CampaignDriveReservation; called: () => boolean } {
    let called = false;
    return {
      called: () => called,
      fn: (o) => {
        called = true;
        const runId = o.createRun({ dispatchKey: "k", attemptGeneration: 1 });
        return { status: "created", runId, attemptGeneration: 1, dispatchKey: "k" };
      },
    };
  }

  test("RED-before-fix: a controller WITHOUT the live lease throws BEFORE the reservation mutates anything", () => {
    const { cid, itemId } = runningCampaignWithItem();
    const reserve = spyReserve();
    let createRunCalled = false;
    const dispatch = makeCampaignDispatch({
      lease: { owner: `campaign@${cid}@X`, generation: 9 },
      prepareItemDispatch: () => ({ driver: "pipeline", createRun: () => { createRunCalled = true; return "run-x"; } }),
      driveItem: () => {},
      reserve: reserve.fn,
      leaseHeldBy: () => false, // we do NOT hold the live lease
    });
    assert.throws(
      () => dispatch({ nextAction: driveCampaignItemAction(cid, itemId), dispatchKey: "d", continuationId: "c", sourceLaunchId: "l", currentPhase: "p", adopting: false, recorded: {} }),
      /AC-ADOPT-DRIVE|FENCED/,
    );
    assert.equal(reserve.called(), false, "no reservation may run for a fenced controller (P1-E)");
    assert.equal(createRunCalled, false, "no run may be created for a fenced controller");
  });

  test("RED-before-fix: an adopted re-drive is FENCED when the born-under token != the live lease — before any write", () => {
    const { cid, itemId } = runningCampaignWithItem();
    // A prior launch linkage born under A#1 exists; the current controller holds a DIFFERENT
    // generation (B#2 after a takeover).
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-A", controllerOwner: `campaign@${cid}@A`, controllerGeneration: 1, state: "launched" });
    const reserve = spyReserve();
    const dispatch = makeCampaignDispatch({
      lease: { owner: `campaign@${cid}@B`, generation: 2 },
      prepareItemDispatch: () => ({ driver: "pipeline", createRun: () => "run-b" }),
      driveItem: () => {},
      reserve: reserve.fn,
      leaseHeldBy: () => true, // B genuinely holds the live lease...
    });
    assert.throws(
      () => dispatch({ nextAction: driveCampaignItemAction(cid, itemId), dispatchKey: "d", continuationId: "c", sourceLaunchId: "l", currentPhase: "p", adopting: true, recorded: {} }),
      /C7 fence|born under/,
    );
    assert.equal(reserve.called(), false, "the born-under fence runs BEFORE the reservation (P1-E)");
  });

  test("GREEN: a controller holding the live lease with a matching born-under token reserves and drives", () => {
    const { cid, itemId } = runningCampaignWithItem();
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-A", controllerOwner: `campaign@${cid}@A`, controllerGeneration: 1, state: "launched" });
    const reserve = spyReserve();
    let drove = false;
    const dispatch = makeCampaignDispatch({
      lease: { owner: `campaign@${cid}@A`, generation: 1 },
      prepareItemDispatch: ({ itemId: iid }) => ({ driver: "pipeline", createRun: () => `run-${iid}` }),
      driveItem: () => { drove = true; },
      reserve: reserve.fn,
      leaseHeldBy: () => true,
    });
    const out = dispatch({ nextAction: driveCampaignItemAction(cid, itemId), dispatchKey: "d", continuationId: "c", sourceLaunchId: "l", currentPhase: "p", adopting: true, recorded: {} });
    assert.equal(reserve.called(), true);
    assert.equal(drove, true);
    assert.ok(out.runId);
  });
});

describe("FG-564 fix round: normal drive path owns the lease (P0-A / AC8 non-vacuous)", () => {
  test("a normal start acquires the campaign-controller lease and RELEASES it when the campaign parks/completes", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    const fakeLaunch = async (c: string, i: string): Promise<DriveOneItemResult> => {
      updateCampaignItem(i, { lifecycleStatus: "complete", outcome: "shipped" });
      return { itemRecords: [{ itemId: i, ticketId: "A", lifecycleStatus: "complete", outcome: "shipped" }] };
    };
    // While driving, the lease must be live (a concurrent controller would fail closed) — we
    // assert acquisition by observing the row exists mid-flight via the launch seam.
    let leaseLiveDuringDrive = false;
    const observingLaunch = async (c: string, i: string): Promise<DriveOneItemResult> => {
      leaseLiveDuringDrive = getCampaignLease(c) !== undefined;
      return fakeLaunch(c, i);
    };
    const result = await driveRemainingItems(cid, {
      dispatch: async () => ({ status: "complete", taskId: "t" } as never),
      projectDir: "/tmp/proj",
      mode: "sequential",
      launchDriveItem: observingLaunch,
      controllerOwner: `campaign@${cid}@A`,
    });
    assert.equal(leaseLiveDuringDrive, true, "the lease is acquired and live across the drive");
    assert.equal(result.stopReason, "complete");
    // D1: released when the campaign terminates.
    assert.equal(getCampaignLease(cid), undefined, "the lease is released when the campaign completes");
    void itemId;
  });

  test("AC8 non-vacuous: a second NORMAL-start controller FAILS CLOSED while the first's lease is live", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    // Controller A already holds a live lease (as if it is mid-drive).
    const a = acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@A`, ttlMs: TTL });
    assert.ok(a.granted);
    // Controller B attempts a normal drive — must fail closed, drive nothing, not touch A's lease.
    let bLaunched = false;
    const result = await driveRemainingItems(cid, {
      dispatch: async () => ({ status: "complete", taskId: "t" } as never),
      projectDir: "/tmp/proj",
      mode: "sequential",
      launchDriveItem: async (c, i) => { bLaunched = true; return { itemRecords: [] }; },
      controllerOwner: `campaign@${cid}@B`,
    });
    assert.equal(result.stopReason, "recovery_needed", "B must fail closed against A's live lease");
    assert.equal(bLaunched, false, "B must not drive any item while A's lease is live");
    // A's lease is intact — B never renewed/impersonated it.
    const lease = getCampaignLease(cid)!;
    assert.equal(lease.owner, `campaign@${cid}@A`);
    assert.equal(lease.generation, a.lease.generation);
    // The item was not touched.
    assert.equal(getCampaignItem(itemId)!.lifecycleStatus, "pending");
  });
});

describe("FG-564 fix round 3: the fence FAILS CLOSED when NO lease row exists (item 1) + a forged env cannot forge authority (NOTE)", () => {
  test("RED-before-fix (item 1): a raw drive-item with NO campaign-controller lease at all is DENIED — absence of the lease row must DENY, not authorize", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    // No lease acquired at all: a dead controller's removed/expired lease, or a legacy running
    // campaign with no lease. The pre-fix fence returned AUTHORIZED here (the fail-open hole);
    // it must now DENY — a raw/forged `campaign drive-item` cannot drive with no linkage and no
    // born-under token.
    assert.equal(getCampaignLease(cid), undefined, "precondition: no controller lease exists");
    const eventsBefore = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    let dispatched = false;
    const result = await driveOneCampaignItem(cid, itemId, {
      dispatch: async () => { dispatched = true; return { status: "complete", taskId: "t" } as never; },
      projectDir: "/tmp/proj",
      mode: "sequential",
      enforceFence: true,
    });
    assert.equal(result.stopReason, "recovery_needed", "no lease → the raw drive is fenced");
    assert.equal(dispatched, false, "no physical work when no lease exists");
    assert.equal(getCampaignItem(itemId)!.lifecycleStatus, "pending", "no mutation when no lease exists");
    assert.equal(getCampaignItem(itemId)!.runId, undefined, "no run created/linked when no lease exists");
    const eventsAfter = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    assert.equal(eventsAfter.n, eventsBefore.n, "a fenced raw drive writes NO durable audit event");
  });

  test("NOTE: a forged FORGE_CONTROLLER_ID cannot forge authority — the fence resolves the born-under token from the DURABLE linkage, not the env var, and a forged owner cannot acquire the lease while a real one is live", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    // The LEGITIMATE controller A holds the live lease; its launch stamped item's born-under
    // linkage (A#1). The born-under token was written by whichever controller held the lease at
    // launch time — never from an env var.
    const a = acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@A`, ttlMs: TTL });
    assert.ok(a.granted);
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-A", controllerOwner: `campaign@${cid}@A`, controllerGeneration: a.lease.generation, state: "launched" });

    const savedEnv = process.env.FORGE_CONTROLLER_ID;
    process.env.FORGE_CONTROLLER_ID = "evil";
    try {
      // (1) The forger cannot acquire the lease under a forged identity while A's is live — so it
      //     can NEVER mint a linkage born under an identity it holds.
      const forged = acquireCampaignLease({ campaignId: cid, owner: `campaign@${cid}@evil`, ttlMs: TTL });
      assert.equal(forged.granted, false, "a forged owner cannot acquire the lease while A's is live");

      // (2) It therefore cannot produce a matching (live-lease + born-under-token) pair for an
      //     item it does not legitimately own: a second item has no linkage born under any lease
      //     the forger holds, so a forged-env drive of it is DENIED.
      const item2 = addCampaignItem({ campaignId: cid, itemOrder: 1, ticketId: "B" });
      let dispatched = false;
      const result = await driveOneCampaignItem(cid, item2.id, {
        dispatch: async () => { dispatched = true; return { status: "complete", taskId: "t" } as never; },
        projectDir: "/tmp/proj",
        mode: "sequential",
        enforceFence: true,
      });
      assert.equal(result.stopReason, "recovery_needed", "the forged env grants no authority — an un-owned item is fenced");
      assert.equal(dispatched, false, "no physical work for a forged-env drive of an un-owned item");
      assert.equal(getCampaignItem(item2.id)!.lifecycleStatus, "pending", "no mutation for a forged-env drive");
    } finally {
      if (savedEnv === undefined) delete process.env.FORGE_CONTROLLER_ID;
      else process.env.FORGE_CONTROLLER_ID = savedEnv;
    }
  });
});

describe("FG-564 fix round 3: the born-under fence holds ACROSS the whole multi-wave drive (item 3)", () => {
  const WF: Workflow = {
    name: "wf",
    description: "",
    review_mode: "legacy_verdict" as const,
    inputs: [],
    steps: [{ id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "rt", reds: [] }],
  };

  // A wave that dispatched a step and left the run active — so driveWorkflowItem wants another wave.
  function activeWave(): RunNextResult {
    return { dispatchedSteps: ["build"], completedSteps: [], awaitingGate: [], failedSteps: [], awaitingRecovery: [], runStatus: "active" };
  }

  test("RED-before-fix: a child whose lease is taken over MID-drive STOPS at the next wave — it commits no further wave", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    const item = getCampaignItem(itemId)!;
    const runId = "run-multiwave";
    insertRun({ id: runId, workflow: WF.name, title: "A", status: "active", createdAt: nowIso(), metadata: {}, projectDir: "/tmp/proj" });

    // The fence is live for the FIRST wave, then a takeover (bump/lapse) fences the child before
    // the second wave. The stub flips the fence AFTER the first runNext, mid-drive.
    let leaseLive = true;
    let waves = 0;
    const runNextFn = async (_args: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
      waves++;
      leaseLive = false; // a takeover bumped the generation / the lease lapsed after this wave
      return activeWave();
    };

    const out = await driveWorkflowItem(cid, item, runId, WF, {
      runNextFn,
      fenceAuthorizes: () => leaseLive,
    });

    assert.equal(out.outcome, "recovery_needed", "the fenced child STOPS mid-drive");
    assert.equal(waves, 1, "exactly ONE wave ran before the fence stopped it — no further wave committed");
  });
});
