// FG-722 (FG-477 child E) — FAST-gate pin for the invoke-lane failed-primary
// selection in probeCampaignSystemRetryEvidence.
//
// The class of regression this catches: classifyInvokeTerminalState's universe is
// EVERY top-level row (`parentId === undefined`), but the probe's re-selection was
// narrowed to isAdHocInvokeRow — which additionally requires the dispatchSource
// "invoke" marker. A top-level failed invoke row WITHOUT that marker (a driven
// cancel dispatch, or a legacy row) was therefore counted into failedPhases yet
// dropped by the re-selection, so failedPrimaries went empty and the probe refused
// with the GENERIC "no failed primary" reason instead of naming the failure's real
// classification.
//
// The integration tier caught this (fg565 F21 control) only because it drives the
// real cancel path, whose stubbed dispatch inserts a marker-less top-level row. This
// unit test pins the same selection directly, at the fast gate, so the next such
// narrowing is caught before the integration shards.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems, updateCampaignItem } from "../store/campaigns.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { failTask } from "../v2/failure-kind.js";
import type { FailureKind } from "../v2/failure-kind.js";
import { planCampaign } from "./planner.js";
import { probeCampaignSystemRetryEvidence } from "./executor.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg722-invoke-marker-"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// A campaign_system-parked invoke-lane item on an abandoned invoke run (no git, ticket
// open → the ship-eligibility guard resolves not-delivered and the failed-primary scan
// runs). The failed row is TOP-LEVEL with phase "task" and NO dispatchSource marker —
// exactly the shape a driven cancel dispatch (or a legacy row) leaves.
function setupMarkerlessInvokeItem(ticketId: string, kind: FailureKind): { campaignId: string; ticketId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const overrides = { [ticketId]: { executionMode: "invoke" as const, agentRole: "documentation-maintainer" } };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides: overrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  const runId = `run-${itemId}`;
  insertRun({ id: runId, workflow: "invoke", title: runId, status: "abandoned", createdAt: "2024-01-01T00:00:00.000Z", projectDir });

  const taskId = `${runId}-task-0`;
  insertTask({
    id: taskId,
    runId,
    phase: "task",
    agentRole: "documentation-maintainer",
    status: "pending",
    // NO dispatchSource — the marker isAdHocInvokeRow requires is deliberately absent.
    taskPackage: { taskId, runId, phase: "task", role: "documentation-maintainer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2024-01-01T00:00:01.000Z",
  });
  failTask(taskId, { runId, kind, error: `seeded ${kind}` });

  updateCampaignItem(itemId, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "campaign_system",
    runId,
    requestedHumanAction: "seeded campaign_system park",
  });
  return { campaignId: campaign.id, ticketId };
}

test("FG-722 fast: a marker-less top-level invoke failure is SELECTED — non-transient refusal names its classification, not the empty-primary fall-through", () => {
  const { campaignId, ticketId } = setupMarkerlessInvokeItem("FG-999C", "cancelled");
  const item = getCampaignItem(listCampaignItems(campaignId)[0]!.id)!;
  const probe = probeCampaignSystemRetryEvidence(getCampaign(campaignId)!, item);

  assert.equal(probe.ok, false, "a cancelled invoke failure must refuse the retry");
  if (!probe.ok) {
    assert.match(probe.reason, /cancelled/i, "the marker-less row must be selected and its cancel classification named");
    assert.doesNotMatch(
      probe.reason,
      /no failed primary task/i,
      "the marker-less top-level invoke row must be selected — not fall through to the empty-primary refusal",
    );
  }
});

test("FG-722 fast: a marker-less top-level invoke failure that is TRANSIENT produces evidence — selection does not require the invoke marker", () => {
  const { campaignId } = setupMarkerlessInvokeItem("FG-999T", "idle_timeout");
  const item = getCampaignItem(listCampaignItems(campaignId)[0]!.id)!;
  const probe = probeCampaignSystemRetryEvidence(getCampaign(campaignId)!, item);

  assert.ok(probe.ok, `a transient marker-less invoke failure must PRODUCE evidence, got: ${!probe.ok ? probe.reason : ""}`);
  assert.equal(probe.evidence.length, 1, "the one top-level failed invoke row is the invoke lane's terminal primary");
  assert.equal(probe.evidence[0]!.failureKind, "idle_timeout");
  assert.equal(probe.evidence[0]!.classified, "infrastructure");
});
