// FG-722 (FG-477 child E): probeCampaignSystemRetryEvidence's failed-primary set
// now derives from the shipped evaluator projection (classifyRunTerminalState ->
// failedPhases) instead of an ad-hoc `parentId === undefined && status === 'failed'`
// row scan — the SAME migration FG-721 made in reconcileTerminalOutcome, in a
// different function. failedPhases counts only workflow steps whose OWN primaries
// terminally failed with no complete replacement, so the derivation drops two shapes
// the old scan wrongly counted:
//
//   (a) a SUPERSEDED failed primary — an earlier attempt failed but a later attempt
//       completed the same phase (request-changes shape). hasCompletePrimary marks
//       the phase complete, so it is not a failed phase.
//   (b) a failed AD-HOC invoke row — parentId === undefined but dispatchSource
//       'invoke'. It is never a workflow phase, so it never contributes.
//
// Both exclusions change what the probe reports: a superseded/ad-hoc failed row no
// longer appears in the CampaignSystemRetryEvidence, and — when the ONLY failed rows
// are of those shapes — no longer satisfies the non-empty guard (the run is refused
// as recording no failed primary). This is the discriminating test the migration
// seed requires: (a)/(b) the deliberate corrections, (c) the guard-emptying effect,
// and a PARITY case proving an all-fresh run yields the identical evidence the old
// scan produced.
//
// It exercises the REAL exported probe (report.ts's retry-hint preview and
// retryCampaignItem's write path both gate on it). loadWorkflow resolves the fixture
// workflow from the project's `.forge/workflows/` override, so no seed generation is
// published — the probe loads the same workflow the real drive path would.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems, updateCampaignItem } from "../store/campaigns.js";
import { insertRun } from "../store/runs.js";
import { insertTask, tasksForRun } from "../store/tasks.js";
import { failTask, failureKindForTask } from "../v2/failure-kind.js";
import type { FailureKind } from "../v2/failure-kind.js";
import { classifyFailureKind, isSharedBlocker } from "./policy.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput } from "./planner.js";
import { probeCampaignSystemRetryEvidence } from "./executor.js";
import type { CampaignSystemRetryEvidence } from "./executor.js";
import type { BlockerKind, Campaign, CampaignItem, Task } from "../types/index.js";

const WF_NAME = "fg722-feature";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

// Force invoke mode so planning never resolves a real dispatch — the probe keys off
// run/task evidence, not lane, exactly as FG-721's fixture does.
function planCampaign(input: PlannerInput, opts: { projectDir: string }) {
  if (input.kind === "list" && !input.itemOverrides) {
    const overrides = Object.fromEntries(
      input.ticketIds.map((id) => [id, { executionMode: "invoke" as const, agentRole: "engineer" }]),
    );
    return _planCampaign({ ...input, itemOverrides: overrides }, { ...opts, mode: "sequential" });
  }
  return _planCampaign(input, { ...opts, mode: "sequential" });
}

// Write the fixture workflow as a project override; loadWorkflow reads
// `${projectDir}/.forge/workflows/${WF_NAME}.yml` before any published generation,
// so the probe's own loadWorkflow(run.workflow, { projectDir }) resolves it.
function writeWorkflowFile(steps: Array<{ id: string; depends_on?: string[] }>): void {
  const dir = join(projectDir, ".forge", "workflows");
  mkdirSync(dir, { recursive: true });
  const stepBlocks = steps
    .map((s) =>
      [
        `  - id: ${s.id}`,
        `    agent: engineer`,
        `    gate: none`,
        `    manual: false`,
        `    depends_on: [${(s.depends_on ?? []).join(", ")}]`,
        `    runtime: claude`,
        `    reds: []`,
      ].join("\n"),
    )
    .join("\n");
  writeFileSync(join(dir, `${WF_NAME}.yml`), `name: ${WF_NAME}\ndescription: fg722 probe fixture\ninputs: []\nsteps:\n${stepBlocks}\n`);
}

// Approved single-item campaign with a non-complete run parked on campaign_system.
// The project is a plain mkdtemp (no git) and the ticket stays open, so the probe's
// ship-eligibility guard resolves not-delivered and the failed-primary scan runs.
function setupItem(ticketId: string, steps: Array<{ id: string; depends_on?: string[] }>): { campaign: Campaign; item: CampaignItem; runId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir });
  approveCampaign(campaign.id, { rationale: "approved" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  const runId = `run-${itemId}`;
  writeWorkflowFile(steps);
  insertRun({ id: runId, workflow: WF_NAME, title: runId, status: "abandoned", createdAt: "2024-01-01T00:00:00.000Z", projectDir });
  updateCampaignItem(itemId, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "campaign_system",
    runId,
    requestedHumanAction: "seeded campaign_system park",
  });
  return { campaign: getCampaign(campaign.id)!, item: getCampaignItem(itemId)!, runId };
}

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

function seedFailedAdhocInvoke(runId: string, kind: FailureKind, createdAt: string): string {
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
  return taskId;
}

// The old ad-hoc scan, replicated verbatim, for the discriminating assertions.
function legacyScanEvidence(tasks: Task[]): CampaignSystemRetryEvidence[] {
  return tasks
    .filter((t) => t.parentId === undefined && t.status === "failed")
    .map((t) => {
      const failureKind = failureKindForTask(t.id);
      return { taskId: t.id, failureKind: failureKind ?? "unknown", classified: classifyFailureKind(failureKind) };
    });
}

function legacyScanBlockerKind(tasks: Task[]): BlockerKind {
  const failed = tasks.filter((t) => t.parentId === undefined && t.status === "failed");
  const kinds = failed.map((t) => classifyFailureKind(failureKindForTask(t.id)));
  return failed.length === 0 || kinds.some((k) => isSharedBlocker(k)) ? "campaign_system" : kinds[kinds.length - 1]!;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg722-probe-"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

test("(a) a SUPERSEDED failed primary is excluded from the evidence — only the genuine unsuperseded phase failure counts", () => {
  // stepX: failed idle_timeout THEN a later complete primary (request-changes shape).
  // stepY (depends on stepX): a genuine unsuperseded idle_timeout failure.
  const { campaign, item, runId } = setupItem("FG-722A", [{ id: "step-x" }, { id: "step-y", depends_on: ["step-x"] }]);
  const stepXTask = seedFailedPrimary(runId, "step-x", "idle_timeout", "2024-01-01T00:00:01.000Z");
  seedCompletePrimary(runId, "step-x", "2024-01-01T00:00:02.000Z");
  const stepYTask = seedFailedPrimary(runId, "step-y", "idle_timeout", "2024-01-01T00:00:03.000Z");

  // The old scan reported BOTH failed rows, including the superseded stepX.
  assert.deepEqual(
    legacyScanEvidence(tasksForRun(runId)).map((e) => e.taskId).sort(),
    [stepXTask, stepYTask].sort(),
    "precondition: the old scan reports the superseded stepX row too",
  );

  const probe = probeCampaignSystemRetryEvidence(campaign, item);
  assert.ok(probe.ok, `probe must accept the all-transient evidence: ${!probe.ok ? probe.reason : ""}`);
  assert.deepEqual(
    probe.evidence,
    [{ taskId: stepYTask, failureKind: "idle_timeout", classified: "infrastructure" }],
    "the superseded stepX failed primary must not appear in the evidence",
  );
});

test("(b) a failed AD-HOC invoke row is excluded from the evidence — it is never a workflow phase", () => {
  const { campaign, item, runId } = setupItem("FG-722B", [{ id: "step-y" }]);
  const stepYTask = seedFailedPrimary(runId, "step-y", "idle_timeout", "2024-01-01T00:00:01.000Z");
  const adhocTask = seedFailedAdhocInvoke(runId, "idle_timeout", "2024-01-01T00:00:02.000Z");

  assert.deepEqual(
    legacyScanEvidence(tasksForRun(runId)).map((e) => e.taskId).sort(),
    [stepYTask, adhocTask].sort(),
    "precondition: the old scan reports the ad-hoc invoke row too",
  );

  const probe = probeCampaignSystemRetryEvidence(campaign, item);
  assert.ok(probe.ok, `probe must accept the all-transient evidence: ${!probe.ok ? probe.reason : ""}`);
  assert.deepEqual(
    probe.evidence,
    [{ taskId: stepYTask, failureKind: "idle_timeout", classified: "infrastructure" }],
    "the failed ad-hoc invoke row is not a workflow-phase primary and must not appear in the evidence",
  );
});

test("(c) when the ONLY failed rows are superseded/ad-hoc, the non-empty guard now refuses — no genuine failed phase", () => {
  // stepX failed then completed (superseded), plus a failed ad-hoc invoke. There is
  // no genuine unsuperseded workflow-phase failure, so the evaluator reports an empty
  // failedPhases set and the probe refuses — where the old scan would have found rows.
  const { campaign, item, runId } = setupItem("FG-722C", [{ id: "step-x" }]);
  seedFailedPrimary(runId, "step-x", "idle_timeout", "2024-01-01T00:00:01.000Z");
  seedCompletePrimary(runId, "step-x", "2024-01-01T00:00:02.000Z");
  seedFailedAdhocInvoke(runId, "idle_timeout", "2024-01-01T00:00:03.000Z");

  assert.equal(legacyScanEvidence(tasksForRun(runId)).length, 2, "precondition: the old scan found two failed rows");

  const probe = probeCampaignSystemRetryEvidence(campaign, item);
  assert.equal(probe.ok, false, "no genuine failed workflow phase means no classifiable failure — refuse");
  if (!probe.ok) assert.match(probe.reason, /no failed primary task/i, `reason must name the missing evidence, got: ${probe.reason}`);
});

test("PARITY: a run whose failed primaries are all fresh (non-superseded, non-adhoc) yields the SAME evidence as the old scan", () => {
  const { campaign, item, runId } = setupItem("FG-722P", [{ id: "step-p" }]);
  seedFailedPrimary(runId, "step-p", "idle_timeout", "2024-01-01T00:00:01.000Z");

  const legacy = legacyScanEvidence(tasksForRun(runId));
  const probe = probeCampaignSystemRetryEvidence(campaign, item);
  assert.ok(probe.ok, `probe must accept the fresh transient failure: ${!probe.ok ? probe.reason : ""}`);
  assert.deepEqual(probe.evidence, legacy, "the evaluator-derived evidence matches the old ad-hoc scan for an all-fresh run");
  // And the parity extends to the non-transient refusal shape the write path gates on.
  assert.equal(legacyScanBlockerKind(tasksForRun(runId)), "campaign_system", "sanity: a single transient failure is retryable under both derivations");
});

test("PARITY: a non-transient fresh failed primary is still refused naming the task and its classification", () => {
  const { campaign, item, runId } = setupItem("FG-722N", [{ id: "step-n" }]);
  const stepNTask = seedFailedPrimary(runId, "step-n", "gate_rejected", "2024-01-01T00:00:01.000Z");

  const probe = probeCampaignSystemRetryEvidence(campaign, item);
  assert.equal(probe.ok, false, "a fresh non-transient failure must still refuse the retry");
  if (!probe.ok) {
    assert.match(probe.reason, new RegExp(stepNTask), `reason must name the non-transient task, got: ${probe.reason}`);
    assert.match(probe.reason, /'scope'/, "reason must name the classification");
  }
});
