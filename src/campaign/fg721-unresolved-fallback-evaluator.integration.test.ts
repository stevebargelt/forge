// FG-721 (FG-477 child D2): reconcileTerminalOutcome's unresolved-outcome fallback
// now derives its failed-primary set from the shipped evaluator projection
// (classifyRunTerminalState -> failedPhases) instead of an ad-hoc
// `parentId === undefined && status === 'failed'` row scan. failedPhases counts only
// workflow steps whose OWN primaries terminally failed with no complete replacement,
// so the derivation drops two shapes the old scan wrongly counted:
//
//   (a) a SUPERSEDED failed primary — an earlier attempt failed but a later attempt
//       completed the same phase (request-changes shape). hasCompletePrimary marks
//       the phase complete, so it is not a failed phase.
//   (b) a failed AD-HOC invoke row — parentId === undefined but dispatchSource
//       'invoke'. It is never a workflow phase, so it never contributes.
//
// Both exclusions change the SHARED-WINS whole-campaign-pause vs LOCAL item-block
// decision: a shared-kind failure hidden in a superseded/ad-hoc row no longer
// escalates the item to campaign_system. This file is the discriminating test the
// migration seed requires — (a)/(b) the deliberate corrections, (c)/(d) the retained
// behavior, and a PARITY case proving a run of only fresh failed primaries yields the
// identical BlockerKind the old scan produced.
//
// It exercises the REAL driveWorkflowItem terminal-reconcile branch (the sole caller
// of reconcileTerminalOutcome). Each run has no authoritative verdict, so
// evaluateAuthoritativeOutcome returns unresolved and the fallback under test runs.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { insertRun } from "../store/runs.js";
import { insertTask, tasksForRun } from "../store/tasks.js";
import { failTask, failureKindForTask } from "../v2/failure-kind.js";
import type { FailureKind } from "../v2/failure-kind.js";
import { classifyFailureKind, isSharedBlocker } from "./policy.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput } from "./planner.js";
import { driveWorkflowItem } from "./executor.js";
import type { Workflow } from "../v2/schema.js";
import type { BlockerKind, CampaignItem, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

// Same wrapper the reconcile parity suites use: force invoke mode for list
// campaigns so planning never resolves a real dispatch. The item's lane is
// irrelevant here — driveWorkflowItem's terminal-reconcile branch keys off run
// status, not lane.
function planCampaign(input: PlannerInput, opts: { projectDir: string }) {
  if (input.kind === "list" && !input.itemOverrides) {
    const overrides = Object.fromEntries(
      input.ticketIds.map((id) => [id, { executionMode: "invoke" as const, agentRole: "engineer" }]),
    );
    return _planCampaign({ ...input, itemOverrides: overrides }, { ...opts, mode: "sequential" });
  }
  return _planCampaign(input, { ...opts, mode: "sequential" });
}

// A minimal workflow whose steps carry the phases the seeded tasks live in.
function makeWorkflow(steps: Array<{ id: string; depends_on?: string[] }>): Workflow {
  return {
    name: "feature",
    description: "fg721 fixture",
    review_mode: "legacy_verdict" as const,
    inputs: [],
    steps: steps.map((s) => ({
      id: s.id,
      agent: "engineer",
      gate: "none" as const,
      depends_on: s.depends_on ?? [],
      reds: [],
      runtime: "claude",
      manual: false,
    })),
  } as unknown as Workflow;
}

// Set up an approved single-item campaign and attach a terminal run to its item.
function setupItem(ticketId: string, runStatus: "failed" | "complete"): { campaignId: string; item: CampaignItem; runId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir });
  approveCampaign(campaign.id, { rationale: "approved" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  const runId = `run-${itemId}`;
  insertRun({ id: runId, workflow: "feature", title: runId, status: runStatus, createdAt: "2024-01-01T00:00:00.000Z", projectDir });
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = ? WHERE id = ?").run(runId, itemId);
  return { campaignId: campaign.id, item: getCampaignItem(itemId)!, runId };
}

// Insert a parent-less workflow-primary row for `phase`, then fail it with `kind`.
function seedFailedPrimary(runId: string, phase: string, kind: FailureKind, createdAt: string): string {
  const taskId = `${runId}-${phase}-${createdAt}`;
  insertTask({
    id: taskId,
    runId,
    phase,
    agentRole: "engineer",
    status: "pending",
    taskPackage: { taskId, runId, phase, role: "engineer", inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow" },
    createdAt,
  });
  failTask(taskId, { runId, kind, error: `seeded ${kind}` });
  return taskId;
}

function seedCompletePrimary(runId: string, phase: string, createdAt: string): void {
  const taskId = `${runId}-${phase}-complete-${createdAt}`;
  insertTask({
    id: taskId,
    runId,
    phase,
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId, runId, phase, role: "engineer", inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow" },
    createdAt,
  });
}

// A parent-less AD-HOC invoke row (dispatchSource 'invoke'), failed with `kind`.
function seedFailedAdhocInvoke(runId: string, kind: FailureKind, createdAt: string): void {
  const taskId = `${runId}-adhoc-${createdAt}`;
  insertTask({
    id: taskId,
    runId,
    phase: "adhoc-invoke",
    agentRole: "engineer",
    status: "pending",
    taskPackage: { taskId, runId, phase: "adhoc-invoke", role: "engineer", inputs: {}, composedSystemPrompt: "", dispatchSource: "invoke" },
    createdAt,
  });
  failTask(taskId, { runId, kind, error: `seeded adhoc ${kind}` });
}

const runNextMustNotBeCalled = async (): Promise<never> => {
  throw new Error("runNextFn must not be called — the run is already terminal at drive entry");
};

async function driveAndReadBlockerKind(campaignId: string, item: CampaignItem, runId: string, workflow: Workflow): Promise<BlockerKind | undefined> {
  await driveWorkflowItem(campaignId, item, runId, workflow, { runNextFn: runNextMustNotBeCalled, projectDir });
  return getCampaignItem(item.id)!.blockerKind;
}

// The old ad-hoc scan, replicated verbatim, for the parity assertion.
function legacyScanBlockerKind(tasks: Task[]): BlockerKind {
  const failedPrimaries = tasks.filter((t) => t.parentId === undefined && t.status === "failed");
  const kinds = failedPrimaries.map((t) => classifyFailureKind(failureKindForTask(t.id)));
  const anyShared = kinds.some((k) => isSharedBlocker(k));
  return failedPrimaries.length === 0 || anyShared ? "campaign_system" : kinds[kinds.length - 1]!;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg721-fallback-"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

test("(a) a SUPERSEDED shared-kind failed primary no longer escalates the item — only the genuine local phase failure counts", async () => {
  // stepX: failed primary (idle_timeout -> infrastructure, SHARED) THEN a later
  // complete primary — the request-changes supersession shape. stepY (depends on
  // stepX): a genuine unsuperseded gate_rejected -> scope (LOCAL) failure.
  const { campaignId, item, runId } = setupItem("FG-721A", "failed");
  seedFailedPrimary(runId, "stepX", "idle_timeout", "2024-01-01T00:00:01.000Z");
  seedCompletePrimary(runId, "stepX", "2024-01-01T00:00:02.000Z");
  seedFailedPrimary(runId, "stepY", "gate_rejected", "2024-01-01T00:00:03.000Z");

  const workflow = makeWorkflow([{ id: "stepX" }, { id: "stepY", depends_on: ["stepX"] }]);

  // Old scan would count stepX's failed idle_timeout row -> SHARED -> campaign_system.
  assert.equal(legacyScanBlockerKind(tasksForRun(runId)), "campaign_system", "precondition: the old scan escalates via the superseded row");

  assert.equal(await driveAndReadBlockerKind(campaignId, item, runId, workflow), "scope", "superseded failed primary must not contribute its SHARED kind");
});

test("(b) a failed AD-HOC invoke row does not make the item a workflow-phase failure", async () => {
  // stepY genuinely failed LOCAL (gate_rejected -> scope). A failed ad-hoc invoke
  // row carries a SHARED kind (idle_timeout -> infrastructure) but is not a workflow
  // phase, so it must not escalate.
  const { campaignId, item, runId } = setupItem("FG-721B", "failed");
  seedFailedPrimary(runId, "stepY", "gate_rejected", "2024-01-01T00:00:01.000Z");
  seedFailedAdhocInvoke(runId, "idle_timeout", "2024-01-01T00:00:02.000Z");

  const workflow = makeWorkflow([{ id: "stepY" }]);

  assert.equal(legacyScanBlockerKind(tasksForRun(runId)), "campaign_system", "precondition: the old scan escalates via the ad-hoc row");

  assert.equal(await driveAndReadBlockerKind(campaignId, item, runId, workflow), "scope", "a failed ad-hoc invoke row is not a workflow-phase failure");
});

test("(c) SHARED-WINS still fires for a genuine unsuperseded failed workflow phase with a shared kind", async () => {
  const { campaignId, item, runId } = setupItem("FG-721C", "failed");
  seedFailedPrimary(runId, "stepZ", "idle_timeout", "2024-01-01T00:00:01.000Z");

  const workflow = makeWorkflow([{ id: "stepZ" }]);

  assert.equal(await driveAndReadBlockerKind(campaignId, item, runId, workflow), "campaign_system", "a genuine shared-kind workflow-phase failure keeps the whole run campaign_system");
});

test("(c2) within ONE failed phase, an earlier SHARED attempt is not downgraded by a later LOCAL retry", async () => {
  // Both attempts failed in the same phase with NO complete replacement — so the
  // phase IS a genuine failed phase (not superseded). Every attempt is classified,
  // so the earlier container_crash (infrastructure, SHARED) keeps the run at
  // campaign_system despite the later gate_rejected (scope, LOCAL) retry.
  const { campaignId, item, runId } = setupItem("FG-721C2", "failed");
  seedFailedPrimary(runId, "stepZ", "container_crash", "2024-01-01T00:00:01.000Z");
  seedFailedPrimary(runId, "stepZ", "gate_rejected", "2024-01-01T00:00:02.000Z");

  const workflow = makeWorkflow([{ id: "stepZ" }]);

  assert.equal(await driveAndReadBlockerKind(campaignId, item, runId, workflow), "campaign_system", "shared-wins holds across every failed attempt of a phase, not just the latest");
});

test("(d) a run with no genuine failed phase still lands campaign_system", async () => {
  // Every phase complete, but no authoritative verdict -> unresolved fallback with
  // an empty failedPhases set. Preserves today's behavior for the no-failure case.
  const { campaignId, item, runId } = setupItem("FG-721D", "complete");
  seedCompletePrimary(runId, "stepW", "2024-01-01T00:00:01.000Z");

  const workflow = makeWorkflow([{ id: "stepW" }]);

  assert.equal(await driveAndReadBlockerKind(campaignId, item, runId, workflow), "campaign_system", "no failed phase falls back to campaign_system");
});

test("PARITY: a run whose failed primaries are all fresh (non-superseded, non-adhoc) yields the SAME BlockerKind as the old scan", async () => {
  const { campaignId, item, runId } = setupItem("FG-721P", "failed");
  seedFailedPrimary(runId, "stepP", "gate_rejected", "2024-01-01T00:00:01.000Z");

  const workflow = makeWorkflow([{ id: "stepP" }]);

  const legacy = legacyScanBlockerKind(tasksForRun(runId));
  const actual = await driveAndReadBlockerKind(campaignId, item, runId, workflow);
  assert.equal(actual, "scope", "a single fresh gate_rejected phase is a LOCAL scope block");
  assert.equal(actual, legacy, "the evaluator-derived kind matches the old ad-hoc scan for an all-fresh run");
});

test("PARITY: a fresh shared failure still wins over a later fresh local failure exactly as the old scan did", async () => {
  const { campaignId, item, runId } = setupItem("FG-721PS", "failed");
  seedFailedPrimary(runId, "stepShared", "container_crash", "2024-01-01T00:00:01.000Z");
  seedFailedPrimary(runId, "stepLocal", "gate_rejected", "2024-01-01T00:00:02.000Z");

  const workflow = makeWorkflow([{ id: "stepShared" }, { id: "stepLocal" }]);

  const legacy = legacyScanBlockerKind(tasksForRun(runId));
  const actual = await driveAndReadBlockerKind(campaignId, item, runId, workflow);
  assert.equal(legacy, "campaign_system", "precondition: the old scan applies SHARED-WINS to a fresh shared failure");
  assert.equal(actual, legacy, "the evaluator-derived fallback preserves SHARED-WINS for fresh workflow primaries");
});
