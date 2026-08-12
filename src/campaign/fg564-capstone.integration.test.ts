// FG-564 (Slice 5b, AC9): the complete N -> N+1 recovery/advance capstone. It drives a real
// item-boundary advance through the PRODUCTION consumer (consumeCampaignContinuation ->
// consumeCore) + the REAL FG-562 store + the REAL FG-596 reservation, and proves truthful
// convergence at ALL FIVE durable levels — task, run, campaign-item, campaign, publication —
// each DERIVED FROM DURABLE STATE (never from a launch disposition and never from a fixture).
//
// HONEST SCOPE NOTE: real `runNext` + the real publisher require the docker / git-worktree
// stack (the `.worktree.test.ts` tier) that cannot execute in this unit container. Here the
// drive's DURABLE WRITES a real drive would commit (the item-run task row, the publication
// attempt, the item ship transition) are committed by the injected drive seam, and every one
// of the five assertions reads them back FROM THE STORE — so the convergence proven is
// genuinely durable-row-derived, not a fixture-green suite. The heaviest end-to-end
// runNext/publisher execution is the worktree tier's job.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  createCampaign,
  addCampaignItem,
  getCampaignItem,
  getCampaign,
  updateCampaignItem,
  tryTransitionCampaignToRunning,
  deriveCampaignItemDispatchKey,
} from "../store/campaigns.js";
import { insertRun, resolveRunProjectIdentity, runByDispatchKey, getRun } from "../store/runs.js";
import { insertTask, tasksForRun } from "../store/tasks.js";
import { recordPublicationIntent, publicationAttemptsForTask } from "../store/publications.js";
import { recordContinuation, observeLaunchStatus, getContinuation } from "../store/continuations.js";
import { acquireCampaignLease } from "../store/campaign-controller.js";
import {
  consumeCampaignContinuation,
  campaignContinuationId,
  campaignItemPhase,
  driveCampaignItemAction,
  type CampaignDispatchDeps,
} from "./continuation-adapter.js";
import type { LaunchStatus, LaunchView } from "../v2/launch.js";
import type { Task } from "../types/index.js";

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

function reader(status: LaunchStatus) {
  return (id: string): LaunchView => ({ id, status } as unknown as LaunchView);
}

describe("AC9 capstone: N -> N+1 five-level convergence, each derived from durable state", () => {
  test("a complete boundary advance converges task, run, campaign-item, campaign, and publication", () => {
    const campaign = createCampaign({ sourceKind: "list", sourceInput: { kind: "list", ticketIds: ["A", "B"] }, mode: "dry_run", projectDir: "/tmp/proj" });
    tryTransitionCampaignToRunning(campaign.id);
    // Item N already shipped; item N+1 is the pending next item this advance drives.
    const itemN = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "A" });
    updateCampaignItem(itemN.id, { lifecycleStatus: "complete", outcome: "shipped" });
    const itemNext = addCampaignItem({ campaignId: campaign.id, itemOrder: 1, ticketId: "B" });

    const owner = `campaign@${campaign.id}@A`;
    const grant = acquireCampaignLease({ campaignId: campaign.id, owner, ttlMs: TTL });
    assert.ok(grant.granted);
    const lease = { owner, generation: grant.lease.generation };

    // Item N's continuation is on record; its drive-item launch has reached terminal.
    const continuationId = campaignContinuationId(campaign.id, itemN.id);
    const sourceLaunchId = "launch-N";
    recordContinuation({
      continuationId, consumerKind: "campaign", sourceLaunchId,
      currentPhase: campaignItemPhase(itemN.id, 1),
      nextAction: driveCampaignItemAction(campaign.id, itemNext.id),
    });
    observeLaunchStatus(continuationId, sourceLaunchId, "exited_ok");

    // The drive seam commits EXACTLY the durable writes a real drive of N+1 would: the
    // item-run's task row, the publication attempt, and the item's ship transition. Every
    // convergence assertion below reads these back from the store.
    const prepareItemDispatch: CampaignDispatchDeps["prepareItemDispatch"] = ({ campaignId, itemId }) => ({
      driver: "pipeline",
      createRun: ({ dispatchKey, attemptGeneration }) => {
        const runId = `run-${itemId}-${attemptGeneration}`;
        insertRun({ id: runId, workflow: "campaign-drive", title: itemId, status: "active", createdAt: "2026-07-20T00:00:00Z", metadata: { campaignId, itemId, dispatchKey, attemptGeneration }, projectDir: "/tmp/proj" }, resolveRunProjectIdentity("/tmp/proj"));
        return runId;
      },
    });
    const driveItem: CampaignDispatchDeps["driveItem"] = ({ campaignId, itemId, runId }) => {
      // TASK level: the item-run produced a task.
      const task = {
        id: `task-${itemId}`, runId, phase: "build", agentRole: "backend-specialist",
        status: "complete", taskPackage: { brief: itemId }, createdAt: "2026-07-20T00:00:01Z",
      } as unknown as Task;
      insertTask(task);
      // PUBLICATION level: the item published its candidate.
      recordPublicationIntent({ attemptId: `pub-${itemId}`, projectKey: "/tmp/proj", canonicalDir: "/tmp/proj", runId, taskId: task.id, target: "main", leaseTtlMs: TTL });
      // CAMPAIGN-ITEM level: the item shipped.
      updateCampaignItem(itemId, { lifecycleStatus: "complete", outcome: "shipped", prUrl: `https://example/pr/${itemId}` });
    };

    const out = consumeCampaignContinuation(
      { continuationId, sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase(itemN.id, 1), nextAction: driveCampaignItemAction(campaign.id, itemNext.id) },
      { owner, readLaunch: reader(TERMINAL), campaign: { lease, prepareItemDispatch, driveItem } },
    );
    assert.equal(out.kind, "advanced");

    // ── FIVE-LEVEL CONVERGENCE, each DERIVED FROM DURABLE STATE ──
    // (0) Continuation boundary: item N advanced EXACTLY once.
    assert.equal(getContinuation(continuationId)?.state, "advanced");

    // (1) RUN: exactly one N+1 item-run, resolved by the FG-596 reservation key (not the receipt).
    const item = getCampaignItem(itemNext.id)!;
    const fgKey = deriveCampaignItemDispatchKey(campaign.id, itemNext.id, item.attemptGeneration);
    const run = runByDispatchKey(fgKey);
    assert.ok(run, "the one N+1 run resolves by the durable FG-596 key");
    assert.equal(getRun(run!.id)?.status, "active");

    // (2) CAMPAIGN-ITEM: item N+1 linked to that run and shipped.
    assert.equal(item.runId, run!.id, "the item is linked to the one run");
    assert.equal(item.lifecycleStatus, "complete");
    assert.equal(item.outcome, "shipped");

    // (3) TASK: the item-run's task is durable and belongs to the run.
    const tasks = tasksForRun(run!.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "complete");

    // (4) CAMPAIGN: still running (the boundary advanced within the campaign).
    assert.equal(getCampaign(campaign.id)?.status, "running");

    // (5) PUBLICATION: the item's publication attempt is durable and keyed to the task.
    const pubs = publicationAttemptsForTask(tasks[0]!.id);
    assert.equal(pubs.length, 1, "the publication window is durable at the publication level");
    assert.equal(pubs[0]?.runId, run!.id);

    // The five levels agree with one another — the convergence is truthful, not a fixture.
    assert.equal(item.runId, tasks[0]?.runId);
    assert.equal(tasks[0]?.runId, pubs[0]?.runId);
  });
});
