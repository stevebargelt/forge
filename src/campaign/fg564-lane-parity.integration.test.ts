// FG-564 (Slice 5b, FIX round 5): LANE PARITY on the recover/adopt physical-drive path. The
// prior unify materialized every recover-driven item as a full_feature pipeline run; this suite
// proves the closed class — an ADOPTED item-run (the shape the recover advance's reservation
// minted) re-enters the CORRECT physical driver for its RECORDED lane when the launched,
// fence-authorized drive-item child (`driveOneCampaignItem` with enforceFence) picks it up:
//   * docs_only  -> the REAL single-invoke path (opts.dispatch is called with the item's agentRole)
//   * quick_implementation -> the REAL invoke chain (engineer THEN test-engineer)
//   * full_feature -> the pipeline reattach (driveWorkflowItem), NEVER the invoke path
// and a MIXED-LANE campaign drives EACH item through the SAME real path the normal drive uses.
//
// Real runNext end-to-end for a full_feature recover/adopt drive is proven in
// fg564-capstone.worktree.test.ts (the docker/worktree tier); here full_feature is proven to take
// the pipeline reattach and NOT be mis-routed to the invoke path.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign, type ItemModeOverride } from "./planner.js";
import {
  approveCampaign,
  listCampaignItems,
  getCampaignItem,
  reserveCampaignDriveDispatch,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { acquireCampaignLease, recordItemLaunch } from "../store/campaign-controller.js";
import { recordContinuation } from "../store/continuations.js";
import { driveOneCampaignItem, prepareCampaignItemDispatch } from "./executor.js";
import {
  consumeCampaignContinuation,
  campaignContinuationId,
  campaignItemPhase,
  driveCampaignItemAction,
  type CampaignDispatchDeps,
} from "./continuation-adapter.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import type { RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { LaunchStatus, LaunchView } from "../v2/launch.js";

const RUNTIME_NAME = "fg564-parity-runtime";
const WORKFLOW_NAME = "fg564-parity-feature";
const TTL = 5 * 60 * 1000;
const TERMINAL: LaunchStatus = { state: "exited_ok", code: 0 };

/** A launch reader that reports the given terminal status for any source launch id — the
 *  seam consumeCore reads the completed prior-item launch through. */
function reader(status: LaunchStatus): (id: string) => LaunchView | undefined {
  return (id: string) => ({ id, status }) as unknown as LaunchView;
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let savedForgeHome: string | undefined;
let forgeHome: string;

function installWorkflow(): void {
  const wf = join(projectDir, ".forge", "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wf), { recursive: true });
  writeFileSync(
    wf,
    `name: ${WORKFLOW_NAME}
description: "FG-564 lane parity: a single build step"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${RUNTIME_NAME}
`,
  );
  const rt = join(projectDir, ".forge", "runtimes", `${RUNTIME_NAME}.yml`);
  mkdirSync(dirname(rt), { recursive: true });
  writeFileSync(
    rt,
    `name: ${RUNTIME_NAME}
description: stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
env: {}
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
  remove_on_exit: true
result:
  file: /task/result.json
`,
  );
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg564-parity-"));
  savedForgeHome = process.env.FORGE_HOME;
  forgeHome = mkdtempSync(join(tmpdir(), "fg564-parity-home-"));
  process.env.FORGE_HOME = forgeHome;
  installWorkflow();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(forgeHome, { recursive: true, force: true });
  if (savedForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedForgeHome;
});

/** A dispatch spy: records every invoke's agentRole and returns a completed result. */
function dispatchSpy() {
  const roles: string[] = [];
  const fn = async (args: InvokeArgs): Promise<InvokeResult> => {
    roles.push(args.agentRole);
    return { runId: args.runId ?? "r", taskId: `task-${args.agentRole}`, status: "complete", result: {} };
  };
  return { fn, roles };
}

/** A runNext spy: records calls and immediately drives the run to complete so the pipeline
 *  drive loop terminates on its next re-read. */
function runNextSpy() {
  const calls: string[] = [];
  const fn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    calls.push(runId);
    // Drive the run to terminal so the pipeline drive loop exits on its next re-read.
    updateRunStatus(runId, "complete");
    return {
      dispatchedSteps: [],
      completedSteps: [],
      awaitingGate: [],
      failedSteps: [],
      runStatus: "complete",
    } as unknown as RunNextResult;
  };
  return { fn, calls };
}

/** Plan an approved, running campaign with the given per-ticket lane overrides; write each ticket. */
function runningCampaign(tickets: { id: string; override: ItemModeOverride }[]) {
  for (const t of tickets) {
    writeTicket(projectDir, {
      id: t.id,
      type: "story",
      status: "active",
      title: `${t.id}: a campaign item`,
      body: "## Problem\nLane parity fixture.\n\n## Acceptance Criteria\n- driven through the right path\n",
    });
  }
  const itemOverrides: Record<string, ItemModeOverride> = {};
  for (const t of tickets) itemOverrides[t.id] = t.override;
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: tickets.map((t) => t.id), itemOverrides },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "ok" });
  assert.ok(tryTransitionCampaignToRunning(campaign.id));
  return campaign;
}

/** Reserve an item's run through the shared authority (exactly as the recover advance does),
 *  leaving the item 'running' + linked, then arm the born-under lease + launch linkage so a
 *  launched fence-authorized child may adopt-and-drive it. Returns { runId, lease }. */
function reserveAndArm(campaignId: string, itemId: string): { runId: string; owner: string } {
  const plan = prepareCampaignItemDispatch({ campaignId, itemId }, { projectDir });
  const res = reserveCampaignDriveDispatch({ campaignId, itemId, createRun: plan.createRun });
  assert.equal(res.status, "created");
  const runId = (res as { runId: string }).runId;

  const owner = `campaign@${campaignId}@ctrl`;
  const grant = acquireCampaignLease({ campaignId, owner, ttlMs: TTL });
  assert.ok(grant.granted);
  const gen = getCampaignItem(itemId)!.attemptGeneration;
  recordItemLaunch({
    campaignId,
    itemId,
    attemptGeneration: gen > 0 ? gen : 1,
    sourceLaunchId: `launch-${itemId}`,
    controllerOwner: owner,
    controllerGeneration: grant.lease.generation,
    runId,
    state: "launched",
  });
  return { runId, owner };
}

describe("FG-564 lane parity: an adopted item-run re-enters the driver for its RECORDED lane", () => {
  test("docs_only adopted run -> the REAL single-invoke path (dispatch called with the item's agentRole)", async () => {
    const campaign = runningCampaign([{ id: "FG-970", override: { lane: "docs_only", agentRole: "documentation-maintainer", laneRationale: "docs" } }]);
    const item = listCampaignItems(campaign.id)[0]!;
    const { runId } = reserveAndArm(campaign.id, item.id);
    assert.equal(getRun(runId)!.workflow, "invoke", "the adopted run is a real invoke run");

    const dispatch = dispatchSpy();
    const runNext = runNextSpy();
    await driveOneCampaignItem(campaign.id, item.id, {
      dispatch: dispatch.fn,
      projectDir,
      mode: "sequential",
      runNextFn: runNext.fn,
      enforceFence: true,
    });

    assert.deepEqual(dispatch.roles, ["documentation-maintainer"], "re-entered the REAL invoke path with the recorded agentRole");
    assert.equal(runNext.calls.length, 0, "an invoke-lane adopted run is NEVER driven through runNext");
  });

  test("quick_implementation adopted run -> the REAL invoke chain (engineer THEN test-engineer)", async () => {
    const campaign = runningCampaign([{ id: "FG-971", override: { lane: "quick_implementation", laneRationale: "quick" } }]);
    const item = listCampaignItems(campaign.id)[0]!;
    const { runId } = reserveAndArm(campaign.id, item.id);
    assert.equal(getRun(runId)!.workflow, "invoke_chain");

    const dispatch = dispatchSpy();
    const runNext = runNextSpy();
    await driveOneCampaignItem(campaign.id, item.id, {
      dispatch: dispatch.fn,
      projectDir,
      mode: "sequential",
      runNextFn: runNext.fn,
      enforceFence: true,
    });

    assert.deepEqual(dispatch.roles, ["engineer", "test-engineer"], "re-entered the REAL invoke chain in order");
    assert.equal(runNext.calls.length, 0, "the invoke-chain adopted run is NEVER driven through runNext");
  });

  test("full_feature adopted run -> the pipeline reattach (driveWorkflowItem/runNext), NEVER the invoke path", async () => {
    const campaign = runningCampaign([{ id: "FG-972", override: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "feature" } }]);
    const item = listCampaignItems(campaign.id)[0]!;
    const { runId } = reserveAndArm(campaign.id, item.id);
    assert.equal(getRun(runId)!.workflow, WORKFLOW_NAME, "the adopted run is a real pipeline run");

    const dispatch = dispatchSpy();
    const runNext = runNextSpy();
    await driveOneCampaignItem(campaign.id, item.id, {
      dispatch: dispatch.fn,
      projectDir,
      mode: "sequential",
      runNextFn: runNext.fn,
      enforceFence: true,
    });

    assert.equal(dispatch.roles.length, 0, "a full_feature adopted run is NEVER routed to the invoke path");
    assert.deepEqual(runNext.calls, [runId], "the pipeline reattach drove the adopted run through the REAL runNext");
  });

  // FG-564 (FIX round 6, gap 2): the MIXED-LANE parity proof driven through the REAL recovery
  // dispatch composition — NO manual run-arming, NO bypass. For BOTH a full_feature item AND an
  // invoke-family item in ONE campaign, the full chain runs:
  //   consumeCampaignContinuation -> makeCampaignDispatch -> the SHARED prepareCampaignItemDispatch
  //   authority -> reserveCampaignDriveDispatch -> the driveItem seam -> the launched drive-item
  //   child's real driveOneCampaignItem (enforceFence) -> the correct per-lane REAL driver
  //   (runNext for full_feature, driveInvokeLaneItem for the invoke lane).
  // ONLY the subprocess boundary is harnessed: the driveItem seam records the born-under launch
  // linkage exactly as the executor does at real launch time, then runs driveOneCampaignItem
  // in-process (fire-and-forget, as production launches it) instead of spawning tmux/docker. Each
  // recover-driven item materializes a real run shape (read back from durable rows) AND drives
  // through the SAME physical path its lane's normal drive uses.
  test("MIXED-LANE campaign through the REAL recovery dispatch: each item materializes + drives its lane's real physical path (full_feature -> runNext, invoke lane -> driveInvokeLaneItem)", async () => {
    const campaign = runningCampaign([
      { id: "FG-973", override: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "feature" } },
      { id: "FG-974", override: { lane: "docs_only", agentRole: "documentation-maintainer", laneRationale: "docs" } },
    ]);
    const items = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder);
    const featureItem = items[0]!;
    const docsItem = items[1]!;

    const owner = `campaign@${campaign.id}@ctrl`;
    const grant = acquireCampaignLease({ campaignId: campaign.id, owner, ttlMs: TTL });
    assert.ok(grant.granted);
    const lease = { owner, generation: grant.lease.generation };

    // The REAL shared authority — the SAME prepareCampaignItemDispatch the normal drive and
    // `forge campaign recover` use (campaign.ts wires it identically).
    const prepareItemDispatch: CampaignDispatchDeps["prepareItemDispatch"] = ({ campaignId, itemId }) =>
      prepareCampaignItemDispatch({ campaignId, itemId }, { projectDir });

    // One per-item recover consumer: a driveItem seam that harnesses ONLY the subprocess boundary.
    function makeConsumer() {
      const dispatch = dispatchSpy();
      const runNext = runNextSpy();
      const drives: Promise<unknown>[] = [];
      const driveItem: CampaignDispatchDeps["driveItem"] = ({
        campaignId,
        itemId,
        runId,
        attemptGeneration,
        controllerOwner,
        controllerGeneration,
      }) => {
        // What the executor's launch path does at real launch time: record the DURABLE born-under
        // launch linkage the child re-reads to authorize its fenced physical drive.
        recordItemLaunch({
          campaignId,
          itemId,
          attemptGeneration,
          sourceLaunchId: `launch-${itemId}`,
          controllerOwner,
          controllerGeneration,
          runId,
          state: "launched",
        });
        // The subprocess boundary, harnessed: run the SAME driveOneCampaignItem the launched
        // `forge campaign drive-item` child runs — enforceFence + the per-lane real driver.
        drives.push(
          driveOneCampaignItem(campaignId, itemId, {
            dispatch: dispatch.fn,
            projectDir,
            mode: "sequential",
            runNextFn: runNext.fn,
            enforceFence: true,
          }),
        );
      };
      return { dispatch, runNext, drives, driveItem };
    }

    // Drive ONE item through the real recovery dispatch: record its boundary continuation, then
    // wake the production consumer with the completed prior-item launch reported terminal.
    async function recoverDrive(item: { id: string }, boundaryTag: string) {
      const continuationId = campaignContinuationId(campaign.id, boundaryTag);
      const sourceLaunchId = `src-${boundaryTag}`;
      const currentPhase = campaignItemPhase(boundaryTag, 1);
      const nextAction = driveCampaignItemAction(campaign.id, item.id);
      recordContinuation({ continuationId, consumerKind: "campaign", sourceLaunchId, currentPhase, nextAction });
      const consumer = makeConsumer();
      const out = consumeCampaignContinuation(
        { continuationId, sourceLaunchId, consumerKind: "campaign", currentPhase, nextAction },
        { owner, readLaunch: reader(TERMINAL), campaign: { lease, prepareItemDispatch, driveItem: consumer.driveItem } },
      );
      await Promise.all(consumer.drives);
      return { out, consumer };
    }

    // ── full_feature item, recover-driven ──
    const feature = await recoverDrive(featureItem, "boundary-before-feature");
    assert.equal(feature.out.kind, "advanced", "the recover advance materialized the full_feature item-run");
    const featureRunId = getCampaignItem(featureItem.id)!.runId!;
    assert.equal(getRun(featureRunId)!.workflow, WORKFLOW_NAME, "the recover advance reserved a REAL pipeline run (read back from the durable row)");
    assert.deepEqual(feature.consumer.runNext.calls, [featureRunId], "the full_feature item drove through the REAL runNext (pipeline reattach) — the SAME path as its normal drive");
    assert.equal(feature.consumer.dispatch.roles.length, 0, "the full_feature item was NOT mis-routed to the invoke path");

    // Re-arm to running for the second independent recover-driven item (the first drive parks it).
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id);

    // ── docs_only (invoke lane) item, recover-driven ──
    const docs = await recoverDrive(docsItem, "boundary-before-docs");
    assert.equal(docs.out.kind, "advanced", "the recover advance materialized the docs_only item-run");
    const docsRunId = getCampaignItem(docsItem.id)!.runId!;
    assert.equal(getRun(docsRunId)!.workflow, "invoke", "the recover advance reserved a REAL invoke run (read back from the durable row)");
    assert.deepEqual(docs.consumer.dispatch.roles, ["documentation-maintainer"], "the docs_only item drove through the REAL invoke path with the recorded agentRole — the SAME path as its normal drive");
    assert.equal(docs.consumer.runNext.calls.length, 0, "the docs_only item was NOT mis-materialized/driven as a pipeline");
  });
});
