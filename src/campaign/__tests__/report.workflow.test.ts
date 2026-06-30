// Integration tests for ReportItemRow workflow-traceability fields (FG-423).
// Verifies that assembleCampaignReport populates executionMode, workflowName,
// agentRole, taskSummaries, and verdictSummaries correctly for both workflow-mode
// and invoke-mode (escape hatch) items.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { planCampaign } from "../planner.js";
import { approveCampaign, getCampaign, listCampaignItems, updateCampaignItem } from "../../store/campaigns.js";
import { assembleCampaignReport, setDoneAuditMapForTest } from "../report.js";
import { insertTask } from "../../store/tasks.js";
import { insertVerdict } from "../../store/verdicts.js";
import { insertRun } from "../../store/runs.js";
import { nowIso } from "../../util/ids.js";
import { writeTicket } from "../../backlog/structured.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "report-workflow-"));
  // Avoid real git/filesystem side effects from done-audit evaluation
  setDoneAuditMapForTest(new Map());

  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    created: "2024-01-01",
    body: "## Problem\nStory needs implementation.\n\n## Goal\nComplete the story.\n\n## Acceptance Criteria\n- Story is complete\n",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  setDoneAuditMapForTest(null);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// ── Test R1: workflow mode populates task and verdict summaries ────────────────

test("report populates taskSummaries and verdictSummaries for workflow-mode item", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "pilot" }
  );
  const items = listCampaignItems(campaign.id);
  const item = items[0]!;

  // Set up: run with two tasks (primary blocked, red task complete) and a failing verdict
  const runId = "run-report-r1";
  insertRun({ id: runId, workflow: "feature", title: "FG-101", status: "active", createdAt: nowIso(), projectDir });

  const taskId = "task-report-r1-eng";
  const redTaskId = "task-report-r1-red";
  insertTask({
    id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "blocked_by_red",
    taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: nowIso(),
  });
  insertTask({
    id: redTaskId, runId, phase: "engineer", agentRole: "shipping-reviewer",
    parentId: taskId, status: "complete",
    taskPackage: { taskId: redTaskId, runId, phase: "engineer", role: "shipping-reviewer", inputs: {}, composedSystemPrompt: "" },
    createdAt: nowIso(),
  });
  insertVerdict({
    id: "verdict-report-r1", taskId, redTaskId, redRole: "shipping-reviewer",
    verdict: "fail", confidence: 0.8, authority: "authoritative",
    findings: [], createdAt: nowIso(),
  });

  updateCampaignItem(item.id, {
    runId, lifecycleStatus: "blocked_by_red", outcome: "blocked", blockerKind: "scope",
  });

  const report = assembleCampaignReport(campaign.id);
  assert.ok(report, "report must be returned");

  const row = report.items[0]!;

  // executionMode defaults to 'workflow' (planCampaign sets workflow mode)
  assert.equal(row.executionMode, "workflow");
  // workflowName comes from the run record (authoritative over canonical content)
  assert.equal(row.workflowName, "feature", "workflowName should match run.workflow");
  // agentRole is null for workflow mode (only set for invoke escape hatch)
  assert.equal(row.agentRole, null, "agentRole must be null for workflow-mode items");

  // taskSummaries: both primary and red tasks appear
  assert.equal(row.taskSummaries.length, 2, "both tasks should appear in summaries");
  const primarySummary = row.taskSummaries.find((t) => t.agentRole === "engineer");
  assert.ok(primarySummary, "primary engineer task must appear");
  assert.equal(primarySummary.status, "blocked_by_red");
  assert.equal(primarySummary.phase, "engineer");

  const redSummary = row.taskSummaries.find((t) => t.agentRole === "shipping-reviewer");
  assert.ok(redSummary, "red shipping-reviewer task must appear");
  assert.equal(redSummary.status, "complete");

  // verdictSummaries: the failing authoritative verdict must appear
  assert.equal(row.verdictSummaries.length, 1, "one verdict summary expected");
  const vs = row.verdictSummaries[0]!;
  assert.equal(vs.verdict, "fail");
  assert.equal(vs.authority, "authoritative");
  assert.equal(vs.phase, "engineer", "verdict phase resolves via task→phase map");
  assert.equal(vs.findingsCount, 0);
  assert.equal(vs.taskId, taskId, "verdictSummary.taskId must be the primary task");
});

// ── Test R2: invoke escape hatch sets correct label, agentRole, no summaries ──

test("report sets invoke (escape hatch) executionMode and clears workflowName for invoke-mode item", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "pilot" }
  );
  const items = listCampaignItems(campaign.id);
  const item = items[0]!;

  // Override campaign metadata planContent to mark FG-101 as invoke mode.
  // report.ts getItemExecutionConfig uses the 'ticketId' key to find items.
  const campaignData = getCampaign(campaign.id)!;
  const updatedPlanContent = {
    ...(campaignData.metadata?.["planContent"] ?? {}),
    orderedItems: [{ ticketId: "FG-101", executionMode: "invoke", agentRole: "engineer" }],
  };
  db.prepare("UPDATE campaigns SET metadata = ? WHERE id = ?").run(
    JSON.stringify({ ...campaignData.metadata, planContent: updatedPlanContent }),
    campaign.id
  );

  // Set up a run (workflow='invoke', no tasks)
  const runId = "run-report-r2";
  insertRun({ id: runId, workflow: "invoke", title: "FG-101", status: "complete", createdAt: nowIso(), projectDir });
  updateCampaignItem(item.id, { runId, lifecycleStatus: "complete", outcome: "shipped" });

  const report = assembleCampaignReport(campaign.id);
  assert.ok(report, "report must be returned");

  const row = report.items[0]!;

  assert.equal(row.executionMode, "invoke (escape hatch)", "invoke mode must show escape hatch label");
  assert.equal(row.agentRole, "engineer", "agentRole must be set for invoke-mode items");
  assert.equal(row.workflowName, null, "workflowName must be null for invoke mode");

  // No tasks were inserted for the invoke run — summaries must be empty
  assert.deepEqual(row.taskSummaries, [], "invoke mode item has no task summaries");
  assert.deepEqual(row.verdictSummaries, [], "invoke mode item has no verdict summaries");
});

// ── Test R3: paused at human gate — nextOperatorAction surfaces gate action, not generic "resume" ──
// Regression guard for finding 3: computeNextOperatorAction must not fall through to
// "resume the campaign when ready" when an item is parked at awaiting_gate or blocked_by_red.

test("paused at human gate — nextOperatorAction surfaces gate requestedHumanAction, not generic resume", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "pilot" }
  );
  approveCampaign(campaign.id, { approvedBy: "test-operator", rationale: "ok" });

  // Manually transition campaign to paused (mimics executor parking at human gate)
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  const items = listCampaignItems(campaign.id);
  const item = items[0]!;

  const runId = "run-report-r3";
  insertRun({ id: runId, workflow: "feature", title: "FG-101", status: "active", createdAt: nowIso(), projectDir });
  updateCampaignItem(item.id, {
    runId,
    lifecycleStatus: "awaiting_gate",
    requestedHumanAction: "Human gate required at step architect in workflow feature",
  });

  const report = assembleCampaignReport(campaign.id);
  assert.ok(report, "report must be returned");

  assert.notEqual(
    report.nextOperatorAction,
    "resume the campaign when ready",
    "must NOT fall through to generic 'resume' when item is at human gate"
  );
  assert.ok(
    report.nextOperatorAction.includes("architect"),
    `nextOperatorAction must surface the gate action, got: ${report.nextOperatorAction}`
  );
});

test("paused at blocked_by_red — nextOperatorAction surfaces red-block requestedHumanAction, not generic resume", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "pilot" }
  );
  approveCampaign(campaign.id, { approvedBy: "test-operator", rationale: "ok" });

  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  const items = listCampaignItems(campaign.id);
  const item = items[0]!;

  const runId = "run-report-r4";
  insertRun({ id: runId, workflow: "feature", title: "FG-101", status: "active", createdAt: nowIso(), projectDir });
  updateCampaignItem(item.id, {
    runId,
    lifecycleStatus: "blocked_by_red",
    outcome: "blocked",
    blockerKind: "scope",
    requestedHumanAction: "workflow blocked by authoritative reviewer at step build — review and resolve",
  });

  const report = assembleCampaignReport(campaign.id);
  assert.ok(report, "report must be returned");

  assert.notEqual(
    report.nextOperatorAction,
    "resume the campaign when ready",
    "must NOT fall through to generic 'resume' when item is blocked_by_red"
  );
  assert.ok(
    report.nextOperatorAction.includes("authoritative reviewer"),
    `nextOperatorAction must surface the block action, got: ${report.nextOperatorAction}`
  );
});
