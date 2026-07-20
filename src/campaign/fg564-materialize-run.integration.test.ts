// FG-564 (Slice 5b, FIX round 5): the ONE lane-aware dispatch-preparation/materialization
// authority (prepareCampaignItemDispatch) is used by BOTH the normal drive and continuation
// recovery. This suite proves, at the authority level:
//   * per-lane run SHAPE parity — full_feature mints a real startRun pipeline run; the
//     invoke-family lanes (docs_only single-invoke, quick_implementation invoke-chain) mint
//     their real invoke / invoke_chain run shape — NOT a lane-blind pipeline mis-materialization;
//   * FAIL CLOSED — a missing ticket refuses BEFORE the reservation (throws), and through the
//     recover composition the reservation rolls back, the item stays pending, no run is minted,
//     and the continuation stays recoverable (not falsely advanced);
//   * filesystem reads (loadWorkflow / ticket resolution) happen in the prepare call, OUTSIDE
//     the reservation — the returned createRun does NO filesystem read (proven by deleting the
//     workflow file AFTER prepare and still minting the run).
//
// The end-to-end mixed-lane drive parity (each lane driven through its REAL physical path on the
// recover/adopt path) lives in fg564-lane-parity.integration.test.ts.

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
  updateCampaignItem,
  deriveCampaignItemDispatchKey,
  reserveCampaignDriveDispatch,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { getRun, runByDispatchKey } from "../store/runs.js";
import { acquireCampaignLease } from "../store/campaign-controller.js";
import { recordContinuation, observeLaunchStatus, getContinuation } from "../store/continuations.js";
import {
  consumeCampaignContinuation,
  campaignContinuationId,
  campaignItemPhase,
  driveCampaignItemAction,
  type CampaignDispatchDeps,
} from "./continuation-adapter.js";
import { prepareCampaignItemDispatch } from "./executor.js";
import { loadWorkflow } from "../v2/loader.js";
import type { LaunchStatus, LaunchView } from "../v2/launch.js";

const RUNTIME_NAME = "fg564-materialize-runtime";
const WORKFLOW_NAME = "fg564-materialize-feature";
const TICKET_IDS = ["FG-950", "FG-951"] as const;
const TTL = 5 * 60 * 1000;
const TICKET_BODY_MARKER = "A distinctive ticket body";

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
description: "FG-564 materialization regression: a single build step"
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

const TERMINAL: LaunchStatus = { state: "exited_ok", code: 0 };
function reader(status: LaunchStatus) {
  return (id: string): LaunchView => ({ id, status } as unknown as LaunchView);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg564-materialize-"));
  savedForgeHome = process.env.FORGE_HOME;
  forgeHome = mkdtempSync(join(tmpdir(), "fg564-materialize-home-"));
  process.env.FORGE_HOME = forgeHome;
  for (const id of TICKET_IDS) {
    writeTicket(projectDir, {
      id,
      type: "story",
      status: "active",
      title: `${id}: a campaign item`,
      body: `## Problem\n${TICKET_BODY_MARKER} only a REAL materialization carries into the run inputs.\n\n## Acceptance Criteria\n- The run is drivable\n`,
    });
  }
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

/** Plan an approved, running campaign whose two items carry the given per-item overrides. */
function planRunningCampaign(overrides: Record<string, ItemModeOverride>) {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: [...TICKET_IDS], itemOverrides: overrides },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "approved" });
  assert.ok(tryTransitionCampaignToRunning(campaign.id));
  return campaign;
}

function fullFeatureOverrides(): Record<string, ItemModeOverride> {
  const o: Record<string, ItemModeOverride> = {};
  for (const id of TICKET_IDS) o[id] = { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "materialization regression" };
  return o;
}

/** Reserve item's run via the reservation, using a lane-aware plan's createRun (the exact
 *  normal-drive path). Returns the created runId. */
function reserveViaPlan(campaignId: string, itemId: string): string {
  const plan = prepareCampaignItemDispatch({ campaignId, itemId }, { projectDir });
  const res = reserveCampaignDriveDispatch({ campaignId, itemId, createRun: plan.createRun });
  assert.equal(res.status, "created");
  return (res as { runId: string }).runId;
}

describe("FG-564 FIX round 5: prepareCampaignItemDispatch — per-lane run-shape parity", () => {
  test("full_feature -> a real, drivable, ticket-derived startRun pipeline run", () => {
    const campaign = planRunningCampaign(fullFeatureOverrides());
    const itemNext = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder)[1]!;

    const plan = prepareCampaignItemDispatch({ campaignId: campaign.id, itemId: itemNext.id }, { projectDir });
    assert.equal(plan.driver, "pipeline", "full_feature selects the pipeline (runNext) driver");
    assert.ok(plan.workflow, "the resolved workflow is carried on the plan for the pipeline drive");

    const runId = reserveViaPlan(campaign.id, itemNext.id);
    const run = getRun(runId)!;
    assert.equal(run.workflow, WORKFLOW_NAME, "the run carries the item's REAL workflow");
    assert.doesNotThrow(() => loadWorkflow(run.workflow, { projectDir }), "the run's workflow is loadable — the child can reattach and drive it via runNext");
    const brief = (run.metadata as Record<string, unknown>)["brief"];
    assert.ok(typeof brief === "string" && (brief as string).includes(TICKET_BODY_MARKER), "the brief is the REAL ticket content");
  });

  test("docs_only -> a real single-invoke run (workflow 'invoke', metadata.invokeAgent), NOT a pipeline", () => {
    const campaign = planRunningCampaign({
      [TICKET_IDS[0]]: { lane: "docs_only", agentRole: "documentation-maintainer", laneRationale: "docs" },
      [TICKET_IDS[1]]: { lane: "docs_only", agentRole: "documentation-maintainer", laneRationale: "docs" },
    });
    const itemNext = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder)[1]!;

    const plan = prepareCampaignItemDispatch({ campaignId: campaign.id, itemId: itemNext.id }, { projectDir });
    assert.equal(plan.driver, "invoke", "docs_only selects the single-invoke driver — NOT pipeline");
    assert.equal(plan.agentRole, "documentation-maintainer");

    const runId = reserveViaPlan(campaign.id, itemNext.id);
    const run = getRun(runId)!;
    assert.equal(run.workflow, "invoke", "the run is a real invoke run — NOT the 'feature' pipeline the lane-blind materialize would mint");
    assert.notEqual(run.workflow, WORKFLOW_NAME);
    assert.equal((run.metadata as Record<string, unknown>)["invokeAgent"], "documentation-maintainer");
  });

  test("quick_implementation -> a real invoke_chain run (engineer -> test-engineer), NOT a pipeline", () => {
    const campaign = planRunningCampaign({
      [TICKET_IDS[0]]: { lane: "quick_implementation", laneRationale: "quick" },
      [TICKET_IDS[1]]: { lane: "quick_implementation", laneRationale: "quick" },
    });
    const itemNext = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder)[1]!;

    const plan = prepareCampaignItemDispatch({ campaignId: campaign.id, itemId: itemNext.id }, { projectDir });
    assert.equal(plan.driver, "invoke_chain", "quick_implementation selects the invoke-chain driver — NOT pipeline");
    assert.deepEqual(plan.invokeChain, ["engineer", "test-engineer"]);

    const runId = reserveViaPlan(campaign.id, itemNext.id);
    const run = getRun(runId)!;
    assert.equal(run.workflow, "invoke_chain");
    assert.deepEqual((run.metadata as Record<string, unknown>)["invokeChain"], ["engineer", "test-engineer"]);
  });
});

describe("FG-564 FIX round 5: fail-closed + filesystem-reads-outside-tx", () => {
  test("missing ticket -> prepare FAILS CLOSED (throws) before any reservation", () => {
    const campaign = planRunningCampaign(fullFeatureOverrides());
    const itemNext = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder)[1]!;
    // Remove the item's ticket file so ticket resolution fails.
    rmSync(join(projectDir, "backlog", "stories"), { recursive: true, force: true }); // drop the item ticket so resolution fails
    assert.throws(
      () => prepareCampaignItemDispatch({ campaignId: campaign.id, itemId: itemNext.id }, { projectDir }),
      /ticket .* not found|fail closed/,
    );
  });

  test("missing ticket (recover composition) -> reservation rolls back: item stays pending, no run minted, continuation recoverable", () => {
    const campaign = planRunningCampaign(fullFeatureOverrides());
    const items = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder);
    const itemN = items[0]!;
    const itemNext = items[1]!;
    updateCampaignItem(itemN.id, { lifecycleStatus: "complete", outcome: "shipped" });
    rmSync(join(projectDir, "backlog", "stories"), { recursive: true, force: true }); // drop the item ticket so resolution fails

    const owner = `campaign@${campaign.id}@recover`;
    const grant = acquireCampaignLease({ campaignId: campaign.id, owner, ttlMs: TTL });
    assert.ok(grant.granted);
    const lease = { owner, generation: grant.lease.generation };

    const continuationId = campaignContinuationId(campaign.id, itemN.id);
    const sourceLaunchId = "launch-N";
    recordContinuation({ continuationId, consumerKind: "campaign", sourceLaunchId, currentPhase: campaignItemPhase(itemN.id, 1), nextAction: driveCampaignItemAction(campaign.id, itemNext.id) });
    observeLaunchStatus(continuationId, sourceLaunchId, "exited_ok");

    // The EXACT production wiring: prepareItemDispatch goes through the shared authority (which
    // fails closed on the missing ticket); driveItem must never fire.
    let drove = false;
    const prepareItemDispatch: CampaignDispatchDeps["prepareItemDispatch"] = ({ campaignId: cid, itemId }) =>
      prepareCampaignItemDispatch({ campaignId: cid, itemId }, { projectDir });
    const driveItem: CampaignDispatchDeps["driveItem"] = () => { drove = true; };

    const out = consumeCampaignContinuation(
      { continuationId, sourceLaunchId, consumerKind: "campaign", currentPhase: campaignItemPhase(itemN.id, 1), nextAction: driveCampaignItemAction(campaign.id, itemNext.id) },
      { owner, readLaunch: reader(TERMINAL), campaign: { lease, prepareItemDispatch, driveItem } },
    );

    assert.equal(out.kind, "blocked", "a fail-closed preparation leaves the continuation recoverable, never advanced");
    assert.notEqual(getContinuation(continuationId)?.state, "advanced");
    assert.equal(drove, false, "nothing was launched");
    const itemAfter = getCampaignItem(itemNext.id)!;
    assert.equal(itemAfter.lifecycleStatus, "pending", "the item stays pending (the reservation rolled back / never committed)");
    assert.equal(itemAfter.runId, undefined, "no run was minted for the item");
    const fgKey = deriveCampaignItemDispatchKey(campaign.id, itemNext.id, itemAfter.attemptGeneration > 0 ? itemAfter.attemptGeneration : 1);
    assert.equal(runByDispatchKey(fgKey), undefined, "no run exists at the item-attempt key");
  });

  test("filesystem reads happen in prepare, OUTSIDE the reservation — createRun does no fs read", () => {
    const campaign = planRunningCampaign(fullFeatureOverrides());
    const itemNext = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder)[1]!;

    // Resolve the plan (this is where the workflow YAML + ticket are read).
    const plan = prepareCampaignItemDispatch({ campaignId: campaign.id, itemId: itemNext.id }, { projectDir });

    // Now DELETE the workflow YAML and the ticket. If createRun (run INSIDE the reservation tx)
    // read the filesystem, it would now throw. It must not — prepare already captured everything.
    rmSync(join(projectDir, ".forge", "workflows", `${WORKFLOW_NAME}.yml`), { force: true });
    rmSync(join(projectDir, "backlog", "stories"), { recursive: true, force: true }); // drop the item ticket so resolution fails

    const res = reserveCampaignDriveDispatch({ campaignId: campaign.id, itemId: itemNext.id, createRun: plan.createRun });
    assert.equal(res.status, "created", "the reservation's createRun minted the run with NO filesystem access");
    const run = getRun((res as { runId: string }).runId)!;
    assert.equal(run.workflow, WORKFLOW_NAME);
    const brief = (run.metadata as Record<string, unknown>)["brief"];
    assert.ok(typeof brief === "string" && (brief as string).includes(TICKET_BODY_MARKER), "the ticket-derived brief was captured at prepare time");
  });
});
