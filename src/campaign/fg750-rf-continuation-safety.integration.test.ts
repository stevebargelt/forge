// FG-750 review remediation (fix-batch-0823e18b6126):
//
// RF-1 (crash-safe resume, AC6): a crash after reopening an item-scoped park must not
//   leave the campaign reported healthy-running with no item dispatched. The controller
//   records the item-boundary continuation BEFORE flipping the campaign back to running,
//   so the durable "running" state is always backed by a continuation recovery can adopt;
//   and the report surfaces a running campaign whose controller lease has lapsed (nothing
//   in flight) as recovery-needed rather than "running".
//
// RF-2 (operator pause is campaign-scoped, AC3): a cross-process item-scoped-park
//   continuation must NOT resume over an operator's campaign-wide pause. The operator pause
//   sets a durable marker in the same transaction as the running→paused CAS; the dispatch
//   decision point refuses to continue while that marker is set.
//
// RF-3 (fail closed when the continuation write fails, crash-safe-resume invariant): the RF-1
//   ordering only protects AC6 if the reopen-to-running is GATED on the continuation write
//   succeeding. If recordItemBoundaryContinuation throws, the controller must NOT flip the
//   campaign back to running (that reopens the RF-1 hole — a subsequent crash leaves it
//   'running' with nothing in flight and nothing to adopt). It leaves the campaign PAUSED with
//   the park intact so resume/recover re-drives it (the reservation stays authoritative).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  createCampaign,
  addCampaignItem,
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  tryTransitionCampaignToRunning,
  updateCampaignItem,
  tryOperatorPauseCampaign,
  isCampaignOperatorPaused,
} from "../store/campaigns.js";
import { acquireCampaignLease, recordItemLaunch } from "../store/campaign-controller.js";
import { parkCampaign } from "./park.js";
import { getContinuation, recordContinuation } from "../store/continuations.js";
import { writeTicket } from "../backlog/structured.js";
import { driveRemainingItems, DEFAULT_CONTROLLER_LEASE_MS, type DriveOneItemResult } from "./executor.js";
import { campaignContinuationId } from "./continuation-adapter.js";
import { assembleCampaignShow, assembleCampaignReport, setDoneAuditMapForTest } from "./report.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

function gitExec(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

function story(id: string): void {
  writeTicket(projectDir, {
    id,
    type: "story",
    status: "active",
    title: `${id} story`,
    body: `## Problem\n${id}.\n\n## Goal\nDo ${id}.\n\n## Acceptance Criteria\n- ${id} done\n`,
  });
}

// A two-item campaign (A then B) transitioned to running, with the controller lease held.
function runningCampaign(owner: string) {
  const c = createCampaign({
    sourceKind: "list",
    sourceInput: { kind: "list", ticketIds: ["FG-A", "FG-B"] },
    mode: "sequential",
    projectDir,
  });
  const a = addCampaignItem({ campaignId: c.id, itemOrder: 0, ticketId: "FG-A" });
  const b = addCampaignItem({ campaignId: c.id, itemOrder: 1, ticketId: "FG-B" });
  assert.ok(tryTransitionCampaignToRunning(c.id));
  const grant = acquireCampaignLease({ campaignId: c.id, owner, ttlMs: DEFAULT_CONTROLLER_LEASE_MS });
  assert.ok(grant.granted);
  return { campaignId: c.id, aId: a.id, bId: b.id };
}

// Mark an item as an ITEM-SCOPED operator park (awaiting_gate, no shared blocker) and
// record its durable launch linkage so a continuation can be bound to it — the durable
// shape a drive-item child leaves after parking on a human gate.
function parkItemScoped(campaignId: string, itemId: string, owner: string): void {
  updateCampaignItem(itemId, {
    lifecycleStatus: "awaiting_gate",
    runId: `run-${itemId}`,
    requestedHumanAction: "operator decision needed",
  });
  recordItemLaunch({
    campaignId,
    itemId,
    attemptGeneration: 1,
    sourceLaunchId: `launch-${itemId}`,
    controllerOwner: owner,
    controllerGeneration: 1,
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  setPublicationClockOffsetForTest(0);
  setDoneAuditMapForTest(new Map());
  projectDir = mkdtempSync(join(tmpdir(), "fg750-rf-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "T"], projectDir);
  story("FG-A");
  story("FG-B");
});

afterEach(() => {
  setDoneAuditMapForTest(null);
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// ── RF-1: no phantom-running ──────────────────────────────────────────────────

test("RF-1: a running campaign whose controller lease lapsed with an item parked and nothing in flight reports recovery-needed", () => {
  const owner = "ctrl-1";
  const { campaignId, aId } = runningCampaign(owner);
  // Crash-after-reopen shape: A parked item-scoped, B still pending, NO item running.
  parkItemScoped(campaignId, aId, owner);

  // Controller alive (lease live): this transient shape must still read as running — a live
  // controller is about to dispatch B; it is not a phantom.
  assert.equal(getCampaign(campaignId)!.status, "running");
  assert.equal(assembleCampaignShow(campaignId)!.nextAction, "running");
  assert.equal(assembleCampaignReport(campaignId)!.safetyToContinue, "running");

  // Controller died: its lease lapses without a clean release. Now the same shape is a
  // phantom — running with nothing in flight — and must surface as recovery-needed.
  setPublicationClockOffsetForTest(DEFAULT_CONTROLLER_LEASE_MS + 1000);
  assert.match(assembleCampaignShow(campaignId)!.nextAction, /recovery needed/);
  assert.equal(assembleCampaignReport(campaignId)!.safetyToContinue, "recovery_needed");
});

test("RF-1: an in-process (never-leased) running campaign is never mislabelled recovery-needed", () => {
  // No lease acquired at all — the in-process/programmatic drive shape.
  const c = createCampaign({ sourceKind: "list", sourceInput: { kind: "list", ticketIds: ["FG-A", "FG-B"] }, mode: "sequential", projectDir });
  const a = addCampaignItem({ campaignId: c.id, itemOrder: 0, ticketId: "FG-A" });
  addCampaignItem({ campaignId: c.id, itemOrder: 1, ticketId: "FG-B" });
  assert.ok(tryTransitionCampaignToRunning(c.id));
  updateCampaignItem(a.id, { lifecycleStatus: "awaiting_gate", requestedHumanAction: "gate" });

  setPublicationClockOffsetForTest(DEFAULT_CONTROLLER_LEASE_MS + 1000);
  assert.equal(assembleCampaignShow(c.id)!.nextAction, "running");
  assert.equal(assembleCampaignReport(c.id)!.safetyToContinue, "running");
});

test("RF-1: the item-boundary continuation is recorded BEFORE the next item is dispatched", async () => {
  const owner = "ctrl-1";
  const { campaignId, aId, bId } = runningCampaign(owner);
  const launched: string[] = [];

  const launch = async (cid: string, itemId: string): Promise<DriveOneItemResult> => {
    launched.push(itemId);
    if (itemId === aId) {
      // A parks item-scoped and commits the campaign pause (the controller's OWN park).
      parkItemScoped(cid, itemId, owner);
      await parkCampaign(cid, itemId, "decision_needed", { exemption: "item-carries-context" });
      return { itemRecords: [], stopReason: "paused", stopScope: "item" };
    }
    // When B is dispatched, A's continuation must already be durable — the crash-safe
    // ordering guarantee (recorded before the reopen-to-running that leads here).
    assert.ok(
      getContinuation(campaignContinuationId(cid, aId)) !== undefined,
      "A's item-boundary continuation is durable before B is dispatched",
    );
    updateCampaignItem(bId, { lifecycleStatus: "complete", outcome: "shipped" });
    return { itemRecords: [] };
  };

  const result = await driveRemainingItems(campaignId, {
    dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }),
    projectDir,
    mode: "sequential",
    launchDriveItem: launch,
    controllerOwner: owner,
    controllerLeaseTtlMs: DEFAULT_CONTROLLER_LEASE_MS,
  });

  assert.deepEqual(launched, [aId, bId], "controller parked A then continued to dispatch B");
  assert.ok(getContinuation(campaignContinuationId(campaignId, aId)) !== undefined, "A's continuation persisted");
  // A is still parked awaiting the operator, so after B drains the campaign parks (not
  // completes) — the point of this test is the [A, B] dispatch order with A's continuation
  // durable before B, not the terminal reason.
  assert.equal(result.stopReason, "paused");
});

// ── RF-2: operator pause is campaign-scoped ───────────────────────────────────

test("RF-2: an operator pause during an item park halts dispatch — the next item is NOT driven", async () => {
  const owner = "ctrl-1";
  const { campaignId, aId, bId } = runningCampaign(owner);
  const launched: string[] = [];

  const launch = async (cid: string, itemId: string): Promise<DriveOneItemResult> => {
    launched.push(itemId);
    if (itemId === aId) {
      // A parks item-scoped, but the operator's `forge campaign pause` WON the running→paused
      // race — modeled by the operator-scoped CAS (which sets the durable marker). The
      // cross-process launch path still reconstructs stopScope "item" from the park shape.
      parkItemScoped(cid, itemId, owner);
      assert.ok(tryOperatorPauseCampaign(cid), "operator pause won the CAS");
      return { itemRecords: [], stopReason: "paused", stopScope: "item" };
    }
    return { itemRecords: [] };
  };

  const result = await driveRemainingItems(campaignId, {
    dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }),
    projectDir,
    mode: "sequential",
    launchDriveItem: launch,
    controllerOwner: owner,
    controllerLeaseTtlMs: DEFAULT_CONTROLLER_LEASE_MS,
  });

  assert.deepEqual(launched, [aId], "the operator pause halted dispatch — B was never driven");
  assert.equal(result.stopReason, "paused");
  assert.equal(getCampaign(campaignId)!.status, "paused", "campaign stays paused under the operator pause");
  assert.ok(isCampaignOperatorPaused(campaignId), "the operator-pause marker is retained");
  assert.equal(getCampaignItem(bId)!.lifecycleStatus, "pending", "B stays pending");
});

test("RF-2 control: without an operator pause, the controller's own item park continues to the next item", async () => {
  const owner = "ctrl-1";
  const { campaignId, aId, bId } = runningCampaign(owner);
  const launched: string[] = [];

  const launch = async (cid: string, itemId: string): Promise<DriveOneItemResult> => {
    launched.push(itemId);
    if (itemId === aId) {
      parkItemScoped(cid, itemId, owner);
      await parkCampaign(cid, itemId, "decision_needed", { exemption: "item-carries-context" });
      return { itemRecords: [], stopReason: "paused", stopScope: "item" };
    }
    updateCampaignItem(bId, { lifecycleStatus: "complete", outcome: "shipped" });
    return { itemRecords: [] };
  };

  await driveRemainingItems(campaignId, {
    dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }),
    projectDir,
    mode: "sequential",
    launchDriveItem: launch,
    controllerOwner: owner,
    controllerLeaseTtlMs: DEFAULT_CONTROLLER_LEASE_MS,
  });

  assert.deepEqual(launched, [aId, bId], "no operator pause → B is dispatched after A parks");
  assert.equal(isCampaignOperatorPaused(campaignId), false, "no operator-pause marker was ever set");
});

// ── RF-3: fail closed when the continuation write fails ───────────────────────

test("RF-3: a failed item-boundary continuation write keeps the campaign PAUSED — it is NOT reopened to running with nothing in flight", async () => {
  const owner = "ctrl-1";
  const { campaignId, aId, bId } = runningCampaign(owner);
  const launched: string[] = [];

  const launch = async (cid: string, itemId: string): Promise<DriveOneItemResult> => {
    launched.push(itemId);
    if (itemId === aId) {
      // A parks item-scoped and commits the campaign pause (the controller's OWN park).
      parkItemScoped(cid, itemId, owner);
      await parkCampaign(cid, itemId, "decision_needed", { exemption: "item-carries-context" });
      // Force the reopen-path continuation write to THROW: a row already occupies A's
      // continuation id, so the re-record hits the PRIMARY KEY and raises. (Models any
      // failure of the boundary write — an IO error, a lost DB, a constraint clash.)
      recordContinuation({
        continuationId: campaignContinuationId(cid, aId),
        consumerKind: "campaign",
        sourceLaunchId: `launch-${aId}`,
        currentPhase: "pre",
        nextAction: { kind: "noop" },
      });
      return { itemRecords: [], stopReason: "paused", stopScope: "item" };
    }
    // Fail closed means we never got here — B must NOT be dispatched.
    throw new Error("B must not be dispatched after a failed continuation write");
  };

  const result = await driveRemainingItems(campaignId, {
    dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }),
    projectDir,
    mode: "sequential",
    launchDriveItem: launch,
    controllerOwner: owner,
    controllerLeaseTtlMs: DEFAULT_CONTROLLER_LEASE_MS,
  });

  assert.deepEqual(launched, [aId], "the failed continuation write halted dispatch — B was never driven");
  assert.equal(result.stopReason, "paused");
  assert.equal(getCampaign(campaignId)!.status, "paused", "campaign stays PAUSED — not flipped to running with nothing in flight");
  assert.equal(getCampaignItem(aId)!.lifecycleStatus, "awaiting_gate", "A's item-scoped park stays intact for resume/recover to re-drive");
  assert.equal(getCampaignItem(bId)!.lifecycleStatus, "pending", "B stays pending");
  // The durable continuation resolves exactly once — resume/recover adopts it without duplication.
  assert.ok(getContinuation(campaignContinuationId(campaignId, aId)) !== undefined, "A's continuation is durable and adoptable");
});

test("RF-1 (revision): a SKIPPED item-boundary continuation (no launch linkage) keeps the campaign PAUSED — it is NOT reopened to running with nothing in flight", async () => {
  const owner = "ctrl-1";
  const { campaignId, aId, bId } = runningCampaign(owner);
  const launched: string[] = [];

  const launch = async (cid: string, itemId: string): Promise<DriveOneItemResult> => {
    launched.push(itemId);
    if (itemId === aId) {
      // A parks item-scoped and commits the campaign pause (the controller's OWN park) —
      // but WITHOUT a durable item-launch linkage (no recordItemLaunch). The boundary
      // recorder then has no sourceLaunchId to bind and SKIPS the write (returns false)
      // rather than throwing. A skip leaves the campaign with NO continuation just as a
      // throw does, so the reopen must be refused exactly the same way.
      updateCampaignItem(itemId, {
        lifecycleStatus: "awaiting_gate",
        runId: `run-${itemId}`,
        requestedHumanAction: "operator decision needed",
      });
      await parkCampaign(cid, itemId, "decision_needed", { exemption: "item-carries-context" });
      return { itemRecords: [], stopReason: "paused", stopScope: "item" };
    }
    // Refusing to reopen on a skip means we never got here — B must NOT be dispatched.
    throw new Error("B must not be dispatched when the continuation write was skipped");
  };

  const result = await driveRemainingItems(campaignId, {
    dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }),
    projectDir,
    mode: "sequential",
    launchDriveItem: launch,
    controllerOwner: owner,
    controllerLeaseTtlMs: DEFAULT_CONTROLLER_LEASE_MS,
  });

  assert.deepEqual(launched, [aId], "the skipped continuation write halted dispatch — B was never driven");
  assert.equal(result.stopReason, "paused");
  assert.equal(getCampaign(campaignId)!.status, "paused", "campaign stays PAUSED — not flipped to running with nothing in flight");
  assert.equal(getCampaignItem(aId)!.lifecycleStatus, "awaiting_gate", "A's item-scoped park stays intact for resume/recover to re-drive");
  assert.equal(getCampaignItem(bId)!.lifecycleStatus, "pending", "B stays pending");
  // No continuation was recorded for A — the skip left nothing to adopt, which is exactly
  // why the reopen was refused (a running flip here would be a phantom).
  assert.equal(getContinuation(campaignContinuationId(campaignId, aId)), undefined, "no continuation was recorded on the skip path");
});
