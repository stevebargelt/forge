// FG-737 (Option X): a campaign item HELD on the first controller never recovered on a detached
// `forge campaign resume` because the drive-item born-under fence pinned to a stale `cli-<pid>`
// launch-linkage owner. A detached `forge launch run -- forge campaign resume …` forwards no
// stable FORGE_CONTROLLER_ID, so every resume ran under a DIFFERENT instance-unique owner and the
// item's born-under linkage — recorded under the FIRST controller's owner/generation — never
// authorized under any later controller. The item fenced forever, never reaching the
// held-readiness re-eval that would clear it.
//
// Option X fixes the wedge with the REFRESH, NOT by collapsing owner-uniqueness with a stable
// `@auto` owner (which would reopen the FG-564 double-driver hazard: two concurrent controllers
// both lacking FORGE_CONTROLLER_ID would share `@auto`, both renew at the SAME generation, and
// both pass the born-under fence). The controller-owner fallback STAYS instance-unique
// (`cli-<pid>`); recovery comes from expiry-based takeover + a settled-linkage refresh:
//   1. A detached resume comes up as a NEW instance-unique owner and, once the dead first
//      controller's lease has EXPIRED, TAKES OVER the lease (bumping the generation).
//   2. recordDriveItemLaunchLinkage → refreshItemLaunchBornUnder REFRESHES a SETTLED linkage's
//      born-under token (guarded on run_id IS NULL) to the new (owner, generation), so the
//      born-under fence authorizes and the held item is re-driven. Bounded TTL latency is the
//      accepted cost (ticket AC2); a resume while the first lease is still LIVE is correctly
//      denied and recovers on the next post-expiry resume.
//
// This regression proves the directions the ticket demands, all against REAL store code + a real
// in-memory DB:
//   (a) a previously-held item with a SETTLED linkage (run_id NULL) whose born-under owner no
//       longer holds the lease IS re-driven by a legitimate new instance-unique controller AFTER
//       expiry-based takeover;
//   (b) a genuinely in-flight item (run_id present, live FOREIGN lease) STILL fences — FG-564's
//       double-driver prevention is NOT weakened;
//   (AC3) two concurrent same-campaign controllers, NEITHER with an operator FORGE_CONTROLLER_ID,
//       do NOT both drive the same settled item — the second is fenced (owner-uniqueness intact).
//       This is the case a stable `@auto` fallback would have broken.

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
} from "../store/campaigns.js";
import {
  acquireCampaignLease,
  getCampaignLease,
  getItemLaunch,
  recordItemLaunch,
  refreshItemLaunchBornUnder,
} from "../store/campaign-controller.js";
import { driveOneCampaignItem, driveRemainingItems, recordDriveItemLaunchLinkage } from "./executor.js";

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

describe("FG-737 (a): a SETTLED linkage from a stale controller is re-adopted by a legitimate new controller", () => {
  test("RED-before-fix repro: without the refresh the item fences forever — with it, the new controller re-drives", async () => {
    const { cid, itemId } = runningCampaignWithItem();

    // First (detached) controller: the old `cli-<pid>` shape. It holds the lease at generation 1
    // and its launch recorded the durable born-under linkage under that owner. The item is HELD
    // (SETTLED — no run, run_id NULL), so there is no in-flight authority to protect.
    const staleOwner = `campaign@${cid}@cli-90154`;
    const a = acquireCampaignLease({ campaignId: cid, owner: staleOwner, ttlMs: TTL });
    assert.ok(a.granted && a.mode === "created");
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-stale", controllerOwner: staleOwner, controllerGeneration: 1, state: "launched" });
    assert.equal(getItemLaunch(cid, itemId, 1)?.runId, undefined, "held item's linkage carries NO run id (settled)");

    // The first controller's lease lapses. A legitimate NEW controller (a fresh instance-unique
    // `cli-<pid>` owner a later detached resume derives) takes over AFTER expiry — a new generation.
    setPublicationClockOffsetForTest(TTL + 1000);
    const resumeOwner = `campaign@${cid}@cli-90233`;
    const b = acquireCampaignLease({ campaignId: cid, owner: resumeOwner, ttlMs: TTL });
    assert.ok(b.granted && b.mode === "took_over", `expected the new controller to take over, got ${JSON.stringify(b)}`);

    // THE BUG: before the refresh, the drive-item child resolves its born-under authority from the
    // linkage (staleOwner#1), which no longer holds the live lease (resumeOwner#2 does). It FENCES
    // — recovery_needed — and the held item is stranded forever.
    let dispatchedBefore = false;
    const fencedResult = await driveOneCampaignItem(cid, itemId, {
      dispatch: async () => { dispatchedBefore = true; return { status: "complete", taskId: "t" } as never; },
      projectDir: "/tmp/proj",
      mode: "sequential",
      enforceFence: true,
    });
    assert.equal(fencedResult.stopReason, "recovery_needed", "pre-refresh: the stale-linkage child is fenced (the FG-737 bug)");
    assert.equal(dispatchedBefore, false, "pre-refresh: fenced child drives nothing");

    // THE FIX: the new controller's launch re-records the linkage. Because the row is SETTLED
    // (run_id NULL), recordDriveItemLaunchLinkage REFRESHES the born-under token to the current
    // controller (resumeOwner#2). getCampaignLease resolves the current holder as the token.
    assert.equal(getCampaignLease(cid)?.owner, resumeOwner);
    recordDriveItemLaunchLinkage(cid, itemId, "launch-resume");
    const refreshed = getItemLaunch(cid, itemId, 1)!;
    assert.equal(refreshed.controllerOwner, resumeOwner, "settled linkage's born-under owner refreshed to the new controller");
    assert.equal(refreshed.controllerGeneration, b.lease.generation, "settled linkage's born-under generation refreshed");

    // Now the born-under fence AUTHORIZES: the child proceeds PAST the fence into the dispatch
    // lane (a fenced child would short-circuit at the fence with recovery_needed WITHOUT throwing).
    // The lane fails closed here — the fixture has no real workflow — so the authorized drive
    // REJECTS. The rejection is the proof the fence let it through: the held item is re-driven.
    let reached = false;
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
      "post-refresh: the authorized child passes the fence into the lane — it is NOT fenced",
    );
    void reached;
    assert.equal(getCampaignItem(itemId)!.lifecycleStatus, "pending", "no run minted by the fail-closed lane");
  });
});

describe("FG-737 (b): a genuinely IN-FLIGHT item (run_id present, live FOREIGN lease) STILL fences — FG-564 preserved", () => {
  test("recordDriveItemLaunchLinkage does NOT rewrite a run-carrying linkage, and the foreign child stays fenced", async () => {
    const { cid, itemId } = runningCampaignWithItem();

    // Controller A holds the lease at generation 1 and its launch is genuinely IN-FLIGHT: the
    // linkage carries a run id. This is the authority FG-564's born-under fence must protect.
    const ownerA = `campaign@${cid}@A`;
    const a = acquireCampaignLease({ campaignId: cid, owner: ownerA, ttlMs: TTL });
    assert.ok(a.granted);
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-A", controllerOwner: ownerA, controllerGeneration: 1, runId: "run-inflight", state: "observed" });
    updateCampaignItem(itemId, { runId: "run-inflight" });
    assert.equal(getItemLaunch(cid, itemId, 1)?.runId, "run-inflight", "the linkage is genuinely in-flight");

    // A different controller B holds the live lease (a concurrent/foreign controller). A drive
    // under B must NOT be allowed to rewrite the in-flight born-under token.
    setPublicationClockOffsetForTest(TTL + 1000);
    const ownerB = `campaign@${cid}@B`;
    const b = acquireCampaignLease({ campaignId: cid, owner: ownerB, ttlMs: TTL });
    assert.ok(b.granted && b.mode === "took_over");

    // A launch re-record under B must leave the in-flight born-under token IMMUTABLE (guarded on
    // run_id IS NULL). The direct primitive refuses it too.
    recordDriveItemLaunchLinkage(cid, itemId, "launch-B");
    const afterRecord = getItemLaunch(cid, itemId, 1)!;
    assert.equal(afterRecord.controllerOwner, ownerA, "in-flight linkage's born-under owner is NOT rewritten (FG-564)");
    assert.equal(afterRecord.controllerGeneration, 1, "in-flight linkage's born-under generation is NOT rewritten (FG-564)");
    assert.equal(refreshItemLaunchBornUnder(cid, itemId, 1, { owner: ownerB, generation: b.lease.generation }), false, "the refresh primitive itself refuses a run-carrying (in-flight) row");
    assert.equal(getItemLaunch(cid, itemId, 1)?.controllerOwner, ownerA, "still A after a direct refresh attempt");

    // And the double-driver fence STILL holds: a child whose born-under authority is A#1 finds the
    // live lease held by the FOREIGN B#2 and is fenced. No second driver for the in-flight item.
    let dispatched = false;
    const result = await driveOneCampaignItem(cid, itemId, {
      dispatch: async () => { dispatched = true; return { status: "complete", taskId: "t" } as never; },
      projectDir: "/tmp/proj",
      mode: "sequential",
      enforceFence: true,
    });
    assert.equal(result.stopReason, "recovery_needed", "the genuinely in-flight item STILL fences against a foreign live controller (FG-564)");
    assert.equal(dispatched, false, "no second driver for the in-flight item");
  });
});

describe("FG-737 (AC3): two concurrent same-campaign controllers WITHOUT an operator FORGE_CONTROLLER_ID do NOT both drive a settled item", () => {
  test("the instance-unique fallback fences the second controller — the `@auto` owner-collapse is NOT reintroduced", async () => {
    const { cid, itemId } = runningCampaignWithItem();

    // Two concurrent `forge campaign start/resume` invocations, NEITHER carrying an operator
    // FORGE_CONTROLLER_ID. Under the Option X instance-unique fallback each derives a DISTINCT
    // owner `campaign@<id>@cli-<pid>` — NOT a shared `@auto`.
    const owner1 = `campaign@${cid}@cli-1001`;
    const owner2 = `campaign@${cid}@cli-2002`;
    assert.notEqual(owner1, owner2, "the instance-unique fallback yields DISTINCT owners for two pid-different controllers");

    // Controller 1 wins the lease at generation 1 and records a SETTLED launch (held item, run_id
    // NULL) — exactly the row the born-under refresh is allowed to touch.
    const a = acquireCampaignLease({ campaignId: cid, owner: owner1, ttlMs: TTL });
    assert.ok(a.granted && a.mode === "created");
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-1", controllerOwner: owner1, controllerGeneration: 1, state: "launched" });

    // Controller 2 comes up WHILE controller 1's lease is still LIVE. Because its owner is
    // DISTINCT, it is DENIED (held_by_live_owner) — it does NOT renew, and the generation does not
    // move. (A shared `@auto` owner would instead take the same-owner `renewed` branch at the SAME
    // generation — the collapse Option X refuses; see the contrast assertion below.)
    const b = acquireCampaignLease({ campaignId: cid, owner: owner2, ttlMs: TTL });
    assert.ok(!b.granted && b.reason === "held_by_live_owner", `second controller must be fenced against a live lease, got ${JSON.stringify(b)}`);
    assert.equal(getCampaignLease(cid)?.owner, owner1, "the live lease is still controller 1's");
    assert.equal(getCampaignLease(cid)?.generation, 1, "no generation collision — controller 2 did not renew");

    // Controller 2 holds no lease, so its drive is fenced: the settled-linkage refresh only fires
    // for the lease HOLDER, and the born-under token stays owner1#1 (== the live lease). The item
    // has exactly ONE legitimate driver (controller 1). A launch re-record attributed to owner2
    // does NOT move the born-under token to owner2 (owner2 is not the lease holder).
    assert.equal(getCampaignLease(cid)?.owner, owner1);
    recordDriveItemLaunchLinkage(cid, itemId, "launch-2");
    assert.equal(getItemLaunch(cid, itemId, 1)?.controllerOwner, owner1, "born-under stays with the sole lease holder — owner2 cannot steal a second drive");
    assert.equal(getItemLaunch(cid, itemId, 1)?.controllerGeneration, 1);

    // Contrast — the exact collapse Option X avoids: had BOTH controllers shared one `@auto`
    // owner, the second acquire would take the SAME-OWNER `renewed` branch at the SAME generation,
    // so its born-under fence would authorize too → two drivers. Prove that same-owner renew keeps
    // the generation, which is why a stable fallback is unsafe.
    const renew = acquireCampaignLease({ campaignId: cid, owner: owner1, ttlMs: TTL });
    assert.ok(renew.granted && renew.mode === "renewed", "same-owner reacquire renews (the @auto collapse mechanism)");
    assert.equal(renew.lease.generation, 1, "same-owner renew stays at the SAME generation — why a shared owner defeats the fence");
  });
});

describe("FG-737 (AC1/AC2): the real resume controller loop recovers only after the prior lease expires", () => {
  test("a live foreign lease denies the new instance-unique controller without launching; its post-expiry takeover re-records and reaches the child drive lane", async () => {
    const { cid, itemId } = runningCampaignWithItem();
    const staleOwner = `campaign@${cid}@cli-90154`;
    const resumeOwner = `campaign@${cid}@cli-90233`;
    const stale = acquireCampaignLease({ campaignId: cid, owner: staleOwner, ttlMs: TTL });
    assert.ok(stale.granted && stale.mode === "created");
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-stale", controllerOwner: staleOwner, controllerGeneration: stale.lease.generation, state: "launched" });

    let launches = 0;
    const launchUnderResumeController = async (campaignId: string, launchedItemId: string) => {
      launches++;
      // This is the production launcher ordering: persist/re-record the linkage before the
      // launchable child resolves its durable born-under fence.
      recordDriveItemLaunchLinkage(campaignId, launchedItemId, `launch-resume-${launches}`);
      return driveOneCampaignItem(campaignId, launchedItemId, {
        dispatch: async () => ({ status: "complete", taskId: "t" }) as never,
        projectDir: "/tmp/proj",
        mode: "sequential",
        enforceFence: true,
      });
    };

    // AC2: a detached resume has no supplied stable id, hence a distinct cli-<pid> owner.
    // While the original controller is still live, the controller loop itself fails closed
    // before it can launch/re-record/drive the held item.
    const liveAttempt = await driveRemainingItems(cid, {
      dispatch: async () => ({ status: "complete", taskId: "t" }) as never,
      projectDir: "/tmp/proj",
      mode: "sequential",
      controllerOwner: resumeOwner,
      controllerLeaseTtlMs: TTL,
      launchDriveItem: launchUnderResumeController,
    });
    assert.equal(liveAttempt.stopReason, "recovery_needed", "live prior owner denies the resume controller");
    assert.equal(launches, 0, "denied controller does not launch or re-record the held item");
    assert.equal(getItemLaunch(cid, itemId, 1)?.controllerOwner, staleOwner, "live-lease denial leaves the stale linkage untouched");

    // AC1: after strict TTL expiry, the same new instance-unique controller takes over. Its
    // real loop invokes the launch recorder, refreshes the SETTLED linkage, and the child gets
    // beyond the born-under fence into its drive lane.
    setPublicationClockOffsetForTest(TTL + 1000);
    await assert.rejects(
      () => driveRemainingItems(cid, {
        dispatch: async () => ({ status: "complete", taskId: "t" }) as never,
        projectDir: "/tmp/proj",
        mode: "sequential",
        controllerOwner: resumeOwner,
        controllerLeaseTtlMs: TTL,
        launchDriveItem: launchUnderResumeController,
      }),
      /ticket A not found.*refusing to materialize a run/,
    );
    assert.equal(launches, 1, "post-expiry takeover launches exactly one re-drive");
    const refreshed = getItemLaunch(cid, itemId, 1)!;
    assert.equal(refreshed.controllerOwner, resumeOwner, "the takeover re-record refreshes the settled linkage owner");
    assert.equal(refreshed.controllerGeneration, 2, "the takeover re-record refreshes the settled linkage generation");
  });
});

describe("FG-737: refreshItemLaunchBornUnder store primitive — guard semantics", () => {
  test("refreshes a SETTLED row (run_id NULL); refuses an IN-FLIGHT row (run_id present); no-op on a missing row", () => {
    const { cid, itemId } = runningCampaignWithItem();
    const ownerA = `campaign@${cid}@A`;
    const ownerNew = `campaign@${cid}@auto`;

    // Missing row → false, no-op.
    assert.equal(refreshItemLaunchBornUnder(cid, itemId, 1, { owner: ownerNew, generation: 9 }), false, "no row → no refresh");

    // Settled row (run_id NULL) → refreshed.
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 1, sourceLaunchId: "launch-settled", controllerOwner: ownerA, controllerGeneration: 1, state: "launched" });
    assert.equal(refreshItemLaunchBornUnder(cid, itemId, 1, { owner: ownerNew, generation: 2 }), true, "settled row → refreshed");
    assert.equal(getItemLaunch(cid, itemId, 1)?.controllerOwner, ownerNew);
    assert.equal(getItemLaunch(cid, itemId, 1)?.controllerGeneration, 2);

    // Once a run id is present the row is in-flight → refuse.
    recordItemLaunch({ campaignId: cid, itemId, attemptGeneration: 2, sourceLaunchId: "launch-inflight", controllerOwner: ownerA, controllerGeneration: 1, runId: "run-x", state: "observed" });
    assert.equal(refreshItemLaunchBornUnder(cid, itemId, 2, { owner: ownerNew, generation: 5 }), false, "in-flight row → refused");
    assert.equal(getItemLaunch(cid, itemId, 2)?.controllerOwner, ownerA, "in-flight born-under owner unchanged");
  });
});
