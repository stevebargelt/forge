import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  getCampaign,
  addCampaignItem,
  approveCampaign,
  tryTransitionCampaignToRunning,
  updateCampaignStatus,
  updateCampaignItem,
} from "../store/campaigns.js";
import { planCampaign } from "./planner.js";
import { writeTicket } from "../backlog/structured.js";
import { assembleCampaignShow, assembleCampaignReport, setDoneAuditMapForTest } from "./report.js";
import type { DoneAuditResult } from "../done-audit/done-audit.js";
import { campaignBlocker } from "./executor.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "report-unit-"));

  writeTicket(projectDir, {
    id: "FG-100",
    type: "epic",
    status: "active",
    title: "Test Epic",
    related: ["FG-101", "FG-102"],
    body: "",
  });
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    epic: "FG-100",
    created: "2024-01-01",
    body: "## Problem\nStory One needs implementation.\n\n## Goal\nComplete story one.\n\n## Acceptance Criteria\n- Story one is complete\n",
  });
  writeTicket(projectDir, {
    id: "FG-102",
    type: "story",
    status: "active",
    title: "Story Two",
    epic: "FG-100",
    created: "2024-01-02",
    body: "## Problem\nStory Two needs implementation.\n\n## Goal\nComplete story two.\n\n## Acceptance Criteria\n- Story two is complete\n",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// Snapshot all files in a directory tree
function snapshotDir(dir: string): Set<string> {
  const result = new Set<string>();
  function walk(d: string) {
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else result.add(full);
      }
    } catch { /* ignore */ }
  }
  walk(dir);
  return result;
}

// ── show: human output ────────────────────────────────────────────────────────

test("assembleCampaignShow: returns null for unknown campaign", () => {
  const result = assembleCampaignShow("campaign-does-not-exist");
  assert.equal(result, null);
});

test("assembleCampaignShow: human output has key fields — planned campaign", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );

  const result = assembleCampaignShow(campaign.id);
  assert.ok(result, "must return a result");
  assert.equal(result.campaignId, campaign.id);
  assert.equal(result.status, "planned");
  assert.equal(result.mode, "sequential");
  assert.equal(result.projectDir, projectDir);
  assert.equal(result.approvedPlanHash, null);
  assert.equal(result.activeItem, null);
  assert.equal(result.items.length, 2);
  assert.equal(result.nextAction, "approve");
});

test("assembleCampaignShow: nextAction=start for approved non-stale planned campaign", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "start");
  assert.ok(result.approvedPlanHash, "approvedPlanHash must be set");
  assert.equal(result.planStale, false);
});

test("assembleCampaignShow: nextAction=resume for paused campaign", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "resume");
  assert.equal(result.status, "paused");
});

test("assembleCampaignShow: nextAction='complete — none' for complete campaign", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "complete — none");
});

// ── show: JSON shape stability ────────────────────────────────────────────────

test("assembleCampaignShow: JSON shape has all required top-level fields", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const result = assembleCampaignShow(campaign.id)!;
  const json = JSON.stringify(result);
  const parsed = JSON.parse(json) as Record<string, unknown>;

  assert.ok("campaignId" in parsed);
  assert.ok("status" in parsed);
  assert.ok("mode" in parsed);
  assert.ok("approvedPlanHash" in parsed);
  assert.ok("currentPlanHash" in parsed);
  assert.ok("planStale" in parsed);
  assert.ok("projectDir" in parsed);
  assert.ok("activeItem" in parsed);
  assert.ok("items" in parsed);
  assert.ok("nextAction" in parsed);
});

test("assembleCampaignShow: item rows have all required fields", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;

  assert.ok("ticketId" in item);
  assert.ok("title" in item);
  assert.ok("lifecycleStatus" in item);
  assert.ok("outcome" in item);
  assert.ok("blockerKind" in item);
  assert.ok("continuePolicy" in item);
  assert.ok("runId" in item);
  assert.ok("reason" in item);
  assert.ok("requestedHumanAction" in item);

  assert.equal(item.ticketId, "FG-101");
  assert.equal(item.title, "Story One");
  assert.equal(item.lifecycleStatus, "pending");
});

// ── show: activeItem detection ────────────────────────────────────────────────

test("assembleCampaignShow: activeItem set for running item", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );

  // Mark item1 as running with a run_id
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-active-123' WHERE id = ?").run(items[0]!.id);

  const result = assembleCampaignShow(campaign.id)!;
  assert.ok(result.activeItem, "activeItem must be set");
  assert.equal(result.activeItem!.ticketId, "FG-101");
  assert.equal(result.activeItem!.runId, "run-active-123");
});

// ── report: JSON shape ────────────────────────────────────────────────────────

test("assembleCampaignReport: returns null for unknown campaign", () => {
  const result = assembleCampaignReport("campaign-does-not-exist");
  assert.equal(result, null);
});

test("assembleCampaignReport: JSON has all required top-level fields", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const result = assembleCampaignReport(campaign.id)!;
  const json = JSON.stringify(result);
  const parsed = JSON.parse(json) as Record<string, unknown>;

  // All required top-level fields
  assert.ok("campaignId" in parsed);
  assert.ok("sourceInput" in parsed);
  assert.ok("goal" in parsed);
  assert.ok("mode" in parsed);
  assert.ok("status" in parsed);
  assert.ok("approvedPlanHash" in parsed);
  assert.ok("currentPlanHash" in parsed);
  assert.ok("safetyToContinue" in parsed);
  assert.ok("verdict" in parsed);
  assert.ok("items" in parsed);
  assert.ok("groupings" in parsed);
  assert.ok("dirtyGitState" in parsed);
  assert.ok("deferredScope" in parsed);
  assert.ok("followUpTickets" in parsed);
  assert.ok("nextOperatorAction" in parsed);
});

test("assembleCampaignReport: item rows have all required fields including forward-compat nulls", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;

  // Forward-compat fields must be present
  assert.ok("branch" in item);
  assert.ok("worktreePath" in item);
  assert.ok("prUrl" in item);
  assert.ok("commit" in item);
  assert.ok("verificationState" in item);
  assert.ok("doneAuditState" in item);
  assert.ok("reviewerResult" in item);

  assert.equal(item.branch, null);
  assert.equal(item.worktreePath, null);
  assert.equal(item.prUrl, null);
  assert.equal(item.verificationState, null);
  // doneAuditState is now populated by FG-383 (non-null when ticket is readable)
  assert.equal(item.reviewerResult, null);
});

// ── report: groupings ─────────────────────────────────────────────────────────

test("assembleCampaignReport: groupings have all five keys", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );

  const result = assembleCampaignReport(campaign.id)!;
  assert.ok("shipped" in result.groupings);
  assert.ok("blocked" in result.groupings);
  assert.ok("held" in result.groupings);
  assert.ok("skipped" in result.groupings);
  assert.ok("failed" in result.groupings);

  // All pending — nothing grouped
  assert.equal(result.groupings.shipped.length, 0);
  assert.equal(result.groupings.blocked.length, 0);
});

test("assembleCampaignReport: groupings correctly classify items by outcome", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );

  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];

  // item1: shipped, item2: failed
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'failed', blocker_kind = 'campaign_system' WHERE id = ?").run(items[1]!.id);

  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const result = assembleCampaignReport(campaign.id)!;
  assert.deepEqual(result.groupings.shipped, ["FG-101"]);
  assert.deepEqual(result.groupings.failed, ["FG-102"]);
  assert.equal(result.groupings.blocked.length, 0);
});

// ── report: verdict distinguishes all-shipped vs complete-with-issues ─────────

test("assembleCampaignReport: verdict='all_shipped' when complete, all items shipped, and done-audit passes", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  for (const item of items) {
    db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(item.id);
  }
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  // Inject a passing done-audit map — required because the host verification recorder is
  // out of scope for FG-383, so collectDoneAuditInput always returns hostVerified=null.
  const passingAudit: DoneAuditResult = { outcome: "pass", checks: [], gaps: [], requestedAction: null };
  const prev = setDoneAuditMapForTest(new Map([["FG-101", passingAudit], ["FG-102", passingAudit]]));
  try {
    const result = assembleCampaignReport(campaign.id)!;
    assert.equal(result.verdict, "all_shipped");
  } finally {
    setDoneAuditMapForTest(prev);
  }
});

test("assembleCampaignReport: verdict='complete_with_issues' when complete but not all shipped", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  // item1: shipped, item2: failed
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'failed' WHERE id = ?").run(items[1]!.id);
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.verdict, "complete_with_issues");
});

test("assembleCampaignReport: verdict='not_complete' for non-complete campaigns", () => {
  const { campaign: c1 } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  assert.equal(assembleCampaignReport(c1.id)!.verdict, "not_complete");

  const { campaign: c2 } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  tryTransitionCampaignToRunning(c2.id);
  updateCampaignStatus(c2.id, "paused");
  assert.equal(assembleCampaignReport(c2.id)!.verdict, "not_complete");
});

// ── no file writes: show/report do not write to projectDir ────────────────────

test("assembleCampaignShow: does not create or modify any file in projectDir", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const before = snapshotDir(projectDir);
  assembleCampaignShow(campaign.id);
  const after = snapshotDir(projectDir);

  assert.deepEqual(
    new Set([...after]),
    new Set([...before]),
    "assembleCampaignShow must not write any files to projectDir"
  );
});

test("assembleCampaignReport: does not create or modify any file in projectDir", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const before = snapshotDir(projectDir);
  assembleCampaignReport(campaign.id);
  const after = snapshotDir(projectDir);

  assert.deepEqual(
    new Set([...after]),
    new Set([...before]),
    "assembleCampaignReport must not write any files to projectDir"
  );
});

// ── report: safetyToContinue ──────────────────────────────────────────────────

test("assembleCampaignReport: safetyToContinue='can_resume' for paused+approved+non-stale", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "can_resume");
});

test("assembleCampaignReport: safetyToContinue='terminal' for complete/failed/abandoned", () => {
  const { campaign: c1 } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(c1.id);
  updateCampaignStatus(c1.id, "complete");
  assert.equal(assembleCampaignReport(c1.id)!.safetyToContinue, "terminal");

  const { campaign: c2 } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  updateCampaignStatus(c2.id, "abandoned");
  assert.equal(assembleCampaignReport(c2.id)!.safetyToContinue, "terminal");
});

// ── show: nextAction for remaining states ─────────────────────────────────────

test("assembleCampaignShow: nextAction='running' for running campaign", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "running");
  assert.equal(result.status, "running");
});

test("assembleCampaignShow: nextAction='failed — investigate' for failed campaign", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "failed");

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "failed — investigate");
  assert.equal(result.status, "failed");
});

test("assembleCampaignShow: nextAction='abandoned — none' for abandoned campaign", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  updateCampaignStatus(campaign.id, "abandoned");

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "abandoned — none");
  assert.equal(result.status, "abandoned");
});

test("assembleCampaignShow: nextAction='stale: re-plan' for approved planned campaign with stale hash", () => {
  const { campaign } = planCampaign(
    { kind: "epic", epicId: "FG-100" },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Add a story to make the plan stale
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    created: "2024-01-03",
    body: "Added after approval",
  });

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "stale: re-plan");
  assert.equal(result.planStale, true, "planStale must be true when plan has changed");
});

// ── report: goal from metadata ────────────────────────────────────────────────

test("assembleCampaignReport: goal=null when metadata has no goal field", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.goal, null);
});

test("assembleCampaignReport: goal extracted from metadata when present", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  db.prepare("UPDATE campaigns SET metadata = ? WHERE id = ?").run(
    JSON.stringify({ goal: "Ship feature X" }),
    campaign.id
  );

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.goal, "Ship feature X");
});

// ── report: commit surfaced for shipped items ─────────────────────────────────

test("assembleCampaignReport: commit=null for non-shipped item, commit set for shipped item", () => {
  // Write FG-101 as done with a commit
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "done",
    title: "Story One",
    epic: "FG-100",
    created: "2024-01-01",
    closedCommit: "deadbeef123",
    body: "Done",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );

  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'failed' WHERE id = ?").run(items[1]!.id);
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const result = assembleCampaignReport(campaign.id)!;
  const item1 = result.items.find((i) => i.ticketId === "FG-101")!;
  const item2 = result.items.find((i) => i.ticketId === "FG-102")!;

  assert.equal(item1.commit, "deadbeef123", "shipped item must have commit from ticket");
  assert.equal(item2.commit, null, "non-shipped item must have null commit");
});

// ── FG-394-fix: show/report surface recovery-needed condition ─────────────────

test("assembleCampaignShow: paused campaign with in-flight item → nextAction has recovery message with ticketId and run_id", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  // Simulate stuck in-flight item
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-show-123' WHERE id = ?").run(items[0]!.id);

  const result = assembleCampaignShow(campaign.id)!;
  assert.ok(result.nextAction.includes("recovery needed"), `nextAction must mention recovery, got: ${result.nextAction}`);
  assert.ok(result.nextAction.includes("FG-101"), `nextAction must mention ticket id, got: ${result.nextAction}`);
  assert.ok(result.nextAction.includes("run-stuck-show-123"), `nextAction must include run_id, got: ${result.nextAction}`);
  assert.ok(result.nextAction.includes("running"), `nextAction must mention the in-flight status, got: ${result.nextAction}`);
  // Must NOT say just "resume" (which would ignore the recovery state)
  assert.notEqual(result.nextAction, "resume");
});

test("assembleCampaignReport: paused campaign with in-flight item → nextOperatorAction has recovery message + run_id, safetyToContinue=recovery_needed", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  // Simulate stuck in-flight item with known run_id
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-report-456' WHERE id = ?").run(items[0]!.id);

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "recovery_needed", "safetyToContinue must be recovery_needed");
  assert.ok(result.nextOperatorAction.includes("recovery needed"), `nextOperatorAction must mention recovery, got: ${result.nextOperatorAction}`);
  assert.ok(result.nextOperatorAction.includes("FG-101"), `nextOperatorAction must mention ticket id, got: ${result.nextOperatorAction}`);
  assert.ok(result.nextOperatorAction.includes("run-stuck-report-456"), `nextOperatorAction must include run_id, got: ${result.nextOperatorAction}`);
  // Verdict must NOT claim all_shipped (campaign is paused, not complete)
  assert.notEqual(result.verdict, "all_shipped");
});

// ── FG-394-fix2: planned campaign with in-flight item ─────────────────────────

test("assembleCampaignShow: planned+approved campaign WITH in-flight item → nextAction is recovery (NOT 'start')", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  // Campaign is still 'planned' — no CAS to running

  // Simulate stuck in-flight item (e.g. prior driver died mid-item)
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-planned-show' WHERE id = ?").run(items[0]!.id);

  const result = assembleCampaignShow(campaign.id)!;
  assert.ok(result.nextAction.includes("recovery needed"), `nextAction must mention recovery, got: ${result.nextAction}`);
  assert.ok(result.nextAction.includes("FG-101"), `nextAction must mention ticket id, got: ${result.nextAction}`);
  assert.ok(result.nextAction.includes("run-stuck-planned-show"), `nextAction must include run_id, got: ${result.nextAction}`);
  assert.notEqual(result.nextAction, "start", "nextAction must NOT be 'start' when in-flight item exists");
  assert.notEqual(result.nextAction, "approve", "nextAction must NOT be 'approve' when in-flight item exists");
});

test("assembleCampaignReport: planned+approved campaign WITH in-flight item → safetyToContinue=recovery_needed, nextOperatorAction is recovery (NOT 'start the campaign')", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-planned-report' WHERE id = ?").run(items[0]!.id);

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "recovery_needed", "safetyToContinue must be recovery_needed for planned+in-flight");
  assert.ok(result.nextOperatorAction.includes("recovery needed"), `nextOperatorAction must mention recovery, got: ${result.nextOperatorAction}`);
  assert.ok(result.nextOperatorAction.includes("FG-101"), `nextOperatorAction must mention ticket id, got: ${result.nextOperatorAction}`);
  assert.ok(result.nextOperatorAction.includes("run-stuck-planned-report"), `nextOperatorAction must include run_id, got: ${result.nextOperatorAction}`);
  assert.notEqual(result.nextOperatorAction, "start the campaign", "nextOperatorAction must NOT be 'start the campaign'");
  assert.notEqual(result.safetyToContinue, "can_start", "safetyToContinue must NOT be 'can_start'");
});

test("assembleCampaignShow: clean planned+approved campaign (no in-flight) → nextAction='start' unchanged", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  // No in-flight item

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.nextAction, "start", "clean planned+approved campaign must still show nextAction='start'");
});

test("assembleCampaignReport: clean planned+approved campaign (no in-flight) → safetyToContinue=can_start unchanged", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "can_start", "clean planned+approved campaign must still report safetyToContinue=can_start");
  assert.equal(result.nextOperatorAction, "start the campaign", "clean planned+approved campaign must still say 'start the campaign'");
});

test("assembleCampaignReport: clean paused campaign (no in-flight) → safetyToContinue=can_resume unchanged", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");
  // All items remain pending (no in-flight)

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "can_resume", "clean paused campaign must still be can_resume");
  assert.equal(result.nextOperatorAction, "resume the campaign when ready");
});

// ── Fix 4: next-action when blockers resolved but held items remain ────────────

test("Fix 4: paused campaign — blocker resolved, held items remain → nextOperatorAction mentions held items", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Simulate: FG-101 was blocked (LOCAL) and FG-102 was held; operator then resolved FG-101
  const items = db.prepare(
    "SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string; ticket_id: string }[];

  // FG-101: resolved (operator marked complete — no longer outcome=blocked)
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?"
  ).run(items[0]!.id);

  // FG-102: still held (pending but outcome=held)
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', continue_policy = 'hold_dependents' WHERE id = ?"
  ).run(items[1]!.id);

  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "can_resume", "campaign is can_resume — blocker resolved");
  assert.ok(
    result.nextOperatorAction.includes("held") || result.nextOperatorAction.includes("reconsider"),
    `nextOperatorAction must mention held items; got: ${result.nextOperatorAction}`
  );
  assert.notEqual(
    result.nextOperatorAction,
    "resume the campaign when ready",
    "nextOperatorAction must not be bare 'resume' when held items await reconsidering"
  );
});

// ── FG-394 CONSISTENCY INVARIANT: show/report/campaignBlocker must agree ──────

// Helper: assert that show.nextAction, report.safetyToContinue, and report.nextOperatorAction
// all agree with campaignBlocker — if the blocker is non-null, none advise the blocked action.
function assertConsistency(
  campaignId: string,
  expectBlocker: string | null,
  label: string
) {
  const show = assembleCampaignShow(campaignId)!;
  const report = assembleCampaignReport(campaignId)!;

  if (expectBlocker !== null) {
    // None of the three should advise the blocked action
    assert.notEqual(show.nextAction, "start", `${label}: show.nextAction must not say 'start' when blocked (${expectBlocker})`);
    assert.notEqual(show.nextAction, "resume", `${label}: show.nextAction must not say 'resume' when blocked (${expectBlocker})`);
    assert.notEqual(report.safetyToContinue, "can_start", `${label}: safetyToContinue must not be can_start when blocked (${expectBlocker})`);
    assert.notEqual(report.safetyToContinue, "can_resume", `${label}: safetyToContinue must not be can_resume when blocked (${expectBlocker})`);
    assert.notEqual(report.nextOperatorAction, "start the campaign", `${label}: nextOperatorAction must not say start when blocked (${expectBlocker})`);
    assert.notEqual(report.nextOperatorAction, "resume the campaign when ready", `${label}: nextOperatorAction must not say resume when blocked (${expectBlocker})`);
  }
}

// ── Known instance 1 (HIGH): planned + in-flight → recovery, NOT start ──────

test("CONSISTENCY: planned+approved campaign with in-flight item → recovery (not start)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-consistency-1' WHERE id = ?").run(items[0]!.id);

  const blockerResult = campaignBlocker(
    getCampaign(campaign.id)!,
    db.prepare("SELECT id, ticket_id as ticketId, lifecycle_status as lifecycleStatus, run_id as runId FROM campaign_items WHERE campaign_id = ?").all(campaign.id) as Parameters<typeof campaignBlocker>[1],
    "start"
  );
  assert.equal(blockerResult, "recovery_needed", "campaignBlocker must return recovery_needed");

  assertConsistency(campaign.id, "recovery_needed", "planned+in-flight");

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show.nextAction.includes("recovery needed"), `show.nextAction must mention recovery, got: ${show.nextAction}`);
  assert.ok(show.nextAction.includes("FG-101"), `show.nextAction must name ticket, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "recovery_needed");
  assert.ok(report.nextOperatorAction.includes("recovery needed"), `nextOperatorAction must mention recovery, got: ${report.nextOperatorAction}`);
});

// ── Known instance 2 (HIGH): paused + stale-plan → stale message, NOT resume ──

test("CONSISTENCY: paused+approved+stale campaign → stale message, NOT resume", () => {
  const { campaign } = planCampaign(
    { kind: "epic", epicId: "FG-100" },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  // Make plan stale
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Stale trigger",
    epic: "FG-100",
    created: "2024-01-03",
    body: "Added post-approval",
  });

  assertConsistency(campaign.id, "stale_plan", "paused+stale");

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show.nextAction.includes("stale"), `show.nextAction must mention stale, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "stale");
  assert.ok(
    report.nextOperatorAction.includes("stale") || report.nextOperatorAction.includes("re-plan"),
    `nextOperatorAction must mention stale/re-plan, got: ${report.nextOperatorAction}`
  );
});

// ── Known instance 3 (MEDIUM): planned + dry_run + approved → dry_run message, NOT start ──

test("CONSISTENCY: planned+dry_run+approved → dry_run re-plan message, NOT start/can_start", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "dry_run" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  assertConsistency(campaign.id, "dry_run_not_executable", "planned+dry_run+approved");

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(
    show.nextAction.includes("dry_run") || show.nextAction.includes("re-plan"),
    `show.nextAction must mention dry_run/re-plan, got: ${show.nextAction}`
  );
  assert.notEqual(show.nextAction, "start");

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "dry_run_not_executable");
  assert.notEqual(report.nextOperatorAction, "start the campaign");
  assert.ok(
    report.nextOperatorAction.includes("dry_run") || report.nextOperatorAction.includes("re-plan"),
    `nextOperatorAction must mention dry_run/re-plan, got: ${report.nextOperatorAction}`
  );
});

// ── Known instance 4 (MEDIUM): running + anomalous in-flight → safety AND actions both recovery ──

test("CONSISTENCY: running campaign with anomalous in-flight item (awaiting_gate) → safety AND actions both recovery", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);

  // Force item into anomalous state (awaiting_gate) while campaign is running
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', run_id = 'run-anomalous-123' WHERE id = ?").run(items[0]!.id);

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(
    show.nextAction.includes("recovery needed"),
    `show.nextAction must mention recovery for anomalous item, got: ${show.nextAction}`
  );

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(
    report.safetyToContinue,
    "recovery_needed",
    "safetyToContinue must be recovery_needed for anomalous in-flight item (not 'running')"
  );
  assert.ok(
    report.nextOperatorAction.includes("recovery needed"),
    `nextOperatorAction must mention recovery for anomalous item, got: ${report.nextOperatorAction}`
  );
  // Verify they AGREE — both say recovery, not a disagreement like safety=running, action=recovery
  assert.notEqual(report.safetyToContinue, "running", "safety must NOT say 'running' when action says recovery");
});

// ── Matrix: general consistency across status × condition ────────────────────

test("CONSISTENCY matrix: planned+unapproved → all three agree on needs_approval", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  // Not approved

  assertConsistency(campaign.id, "not_approved", "planned+unapproved");

  const show = assembleCampaignShow(campaign.id)!;
  assert.equal(show.nextAction, "approve");

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "needs_approval");
});

test("CONSISTENCY matrix: paused+unapproved → all three agree on needs_approval, NOT resume", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  // Do NOT approve; manually set to paused (bypassing approval)
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  assertConsistency(campaign.id, "not_approved", "paused+unapproved");

  const show = assembleCampaignShow(campaign.id)!;
  assert.notEqual(show.nextAction, "resume", "show must NOT say resume for unapproved paused campaign");

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "needs_approval");
  assert.notEqual(report.nextOperatorAction, "resume the campaign when ready");
});

test("CONSISTENCY matrix: paused+in-flight → recovery (not resume)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-paused-matrix' WHERE id = ?").run(items[0]!.id);

  assertConsistency(campaign.id, "recovery_needed", "paused+in-flight");

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show.nextAction.includes("recovery needed"));
  assert.notEqual(show.nextAction, "resume");

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "recovery_needed");
  assert.notEqual(report.nextOperatorAction, "resume the campaign when ready");
});

// ── FG-394 LAST INSTANCE: no_project_dir / invalid_project_dir ────────────────

test("CONSISTENCY: planned+approved campaign with no projectDir → not start, blocker-specific message, terminal safety", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  db.prepare("UPDATE campaigns SET project_dir = NULL WHERE id = ?").run(campaign.id);

  assertConsistency(campaign.id, "no_project_dir", "planned+no_project_dir");

  const show = assembleCampaignShow(campaign.id)!;
  assert.notEqual(show.nextAction, "start", "show.nextAction must not be start");
  assert.ok(show.nextAction.includes("re-plan"), `show.nextAction must say re-plan, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "terminal", "safetyToContinue must be terminal for no_project_dir");
  assert.notEqual(report.nextOperatorAction, "start the campaign", "nextOperatorAction must not say start");
  assert.ok(report.nextOperatorAction.includes("re-plan"), `nextOperatorAction must say re-plan, got: ${report.nextOperatorAction}`);
});

test("CONSISTENCY: planned+approved campaign with invalid projectDir → not start, blocker-specific message, terminal safety", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  db.prepare("UPDATE campaigns SET project_dir = '/nonexistent/path/fg394' WHERE id = ?").run(campaign.id);

  assertConsistency(campaign.id, "invalid_project_dir", "planned+invalid_project_dir");

  const show = assembleCampaignShow(campaign.id)!;
  assert.notEqual(show.nextAction, "start", "show.nextAction must not be start");
  assert.ok(
    show.nextAction.includes("fix the path") || show.nextAction.includes("re-plan"),
    `show.nextAction must say fix the path / re-plan, got: ${show.nextAction}`
  );

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "terminal", "safetyToContinue must be terminal for invalid_project_dir");
  assert.notEqual(report.nextOperatorAction, "start the campaign", "nextOperatorAction must not say start");
  assert.ok(
    report.nextOperatorAction.includes("fix the path") || report.nextOperatorAction.includes("re-plan"),
    `nextOperatorAction must say fix the path / re-plan, got: ${report.nextOperatorAction}`
  );
});

// ── GUARD: no CampaignStopReason maps action functions to bare start/resume ───
//
// Enumerate every reachable blocker from show/report (called with intent start/resume
// on planned/paused campaigns after status-checks eliminate terminal states):
//   null            → start/resume (correct — only null should produce the action)
//   recovery_needed → recovery message
//   not_approved    → approve message
//   dry_run_not_executable → re-plan message
//   stale_plan      → stale message
//   no_project_dir  → re-plan message (NEW)
//   invalid_project_dir → fix path message (NEW)
//   not_planned / not_paused → unreachable: status-checks on planned/paused prevent reaching
//     campaignBlocker with these values inside computeNextShowAction/computeNextOperatorAction
//   already_running / paused / abandoned / item_failed / complete → execution-time only;
//     campaignBlocker never returns these during pre-flight start/resume checks
//
// The explicit default `blocked: ${blocker} — resolve before ${intent}` in both functions
// ensures any future CampaignStopReason added to the union cannot silently fall through.

test("GUARD: every reachable CampaignStopReason → show and report do NOT return bare start/resume (only null does)", () => {
  // ── null → start (the one correct case) ─────────────────────────────────────
  {
    const { campaign: c } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
    approveCampaign(c.id, { rationale: "LGTM" });
    const show = assembleCampaignShow(c.id)!;
    const report = assembleCampaignReport(c.id)!;
    assert.equal(show.nextAction, "start", "null blocker: show.nextAction must be start");
    assert.equal(report.nextOperatorAction, "start the campaign", "null blocker: nextOperatorAction must be 'start the campaign'");
    assert.equal(report.safetyToContinue, "can_start", "null blocker: safetyToContinue must be can_start");
  }

  // ── not_approved ─────────────────────────────────────────────────────────────
  {
    const { campaign: c } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
    const show = assembleCampaignShow(c.id)!;
    const report = assembleCampaignReport(c.id)!;
    assert.notEqual(show.nextAction, "start", "not_approved: show must not say start");
    assert.notEqual(show.nextAction, "resume", "not_approved: show must not say resume");
    assert.notEqual(report.nextOperatorAction, "start the campaign", "not_approved: report must not say start the campaign");
    assert.notEqual(report.safetyToContinue, "can_start", "not_approved: safety must not be can_start");
  }

  // ── recovery_needed ──────────────────────────────────────────────────────────
  {
    const { campaign: c } = planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"] }, { projectDir, mode: "sequential" });
    approveCampaign(c.id, { rationale: "LGTM" });
    const citems = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(c.id) as { id: string }[];
    db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-guard-rn' WHERE id = ?").run(citems[0]!.id);
    const show = assembleCampaignShow(c.id)!;
    const report = assembleCampaignReport(c.id)!;
    assert.notEqual(show.nextAction, "start", "recovery_needed: show must not say start");
    assert.notEqual(report.nextOperatorAction, "start the campaign", "recovery_needed: report must not say start the campaign");
    assert.notEqual(report.safetyToContinue, "can_start", "recovery_needed: safety must not be can_start");
  }

  // ── dry_run_not_executable ───────────────────────────────────────────────────
  {
    const { campaign: c } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "dry_run" });
    approveCampaign(c.id, { rationale: "LGTM" });
    const show = assembleCampaignShow(c.id)!;
    const report = assembleCampaignReport(c.id)!;
    assert.notEqual(show.nextAction, "start", "dry_run: show must not say start");
    assert.notEqual(report.nextOperatorAction, "start the campaign", "dry_run: report must not say start the campaign");
    assert.notEqual(report.safetyToContinue, "can_start", "dry_run: safety must not be can_start");
  }

  // ── no_project_dir ───────────────────────────────────────────────────────────
  {
    const { campaign: c } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
    approveCampaign(c.id, { rationale: "LGTM" });
    db.prepare("UPDATE campaigns SET project_dir = NULL WHERE id = ?").run(c.id);
    const show = assembleCampaignShow(c.id)!;
    const report = assembleCampaignReport(c.id)!;
    assert.notEqual(show.nextAction, "start", "no_project_dir: show must not say start");
    assert.notEqual(report.nextOperatorAction, "start the campaign", "no_project_dir: report must not say start the campaign");
    assert.notEqual(report.safetyToContinue, "can_start", "no_project_dir: safety must not be can_start");
  }

  // ── invalid_project_dir ──────────────────────────────────────────────────────
  {
    const { campaign: c } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
    approveCampaign(c.id, { rationale: "LGTM" });
    db.prepare("UPDATE campaigns SET project_dir = '/nonexistent/path/guard' WHERE id = ?").run(c.id);
    const show = assembleCampaignShow(c.id)!;
    const report = assembleCampaignReport(c.id)!;
    assert.notEqual(show.nextAction, "start", "invalid_project_dir: show must not say start");
    assert.notEqual(report.nextOperatorAction, "start the campaign", "invalid_project_dir: report must not say start the campaign");
    assert.notEqual(report.safetyToContinue, "can_start", "invalid_project_dir: safety must not be can_start");
  }

  // ── stale_plan (last — adds a ticket to projectDir, affecting plan hash) ─────
  {
    const { campaign: c } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir, mode: "sequential" });
    approveCampaign(c.id, { rationale: "LGTM" });
    writeTicket(projectDir, {
      id: "FG-199",
      type: "story",
      status: "active",
      title: "Guard stale trigger",
      epic: "FG-100",
      created: "2024-01-09",
      body: "Added post-approval to make plan stale",
    });
    const show = assembleCampaignShow(c.id)!;
    const report = assembleCampaignReport(c.id)!;
    assert.notEqual(show.nextAction, "start", "stale_plan: show must not say start");
    assert.notEqual(report.nextOperatorAction, "start the campaign", "stale_plan: report must not say start the campaign");
    assert.notEqual(report.safetyToContinue, "can_start", "stale_plan: safety must not be can_start");
  }
});

// ── FG-393 fix: unresolved blocked item → needs_resolution, NOT can_resume ────

test("FG-393 exact repro: paused campaign — FG-101 failed+blocked, FG-102 held → safetyToContinue=needs_resolution", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const items = db.prepare(
    "SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string; ticket_id: string }[];

  // FG-101: local-blocked (the unresolved blocker)
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope' WHERE id = ?"
  ).run(items[0]!.id);
  // FG-102: held downstream
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', continue_policy = 'hold_dependents' WHERE id = ?"
  ).run(items[1]!.id);

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "needs_resolution", "safetyToContinue must be needs_resolution (NOT can_resume) when unresolved blocked item exists");
  assert.notEqual(report.safetyToContinue, "can_resume", "safetyToContinue must NOT be can_resume with an unresolved blocked item");
  assert.ok(report.nextOperatorAction.includes("resolve blocker"), `nextOperatorAction must say resolve blocker, got: ${report.nextOperatorAction}`);
  assert.ok(report.nextOperatorAction.includes("FG-101"), `nextOperatorAction must name the blocker ticket, got: ${report.nextOperatorAction}`);
  assert.ok(report.nextOperatorAction.includes("resume"), `nextOperatorAction must mention resume, got: ${report.nextOperatorAction}`);
  assert.equal(report.groupings.blocked[0], "FG-101");
  assert.equal(report.groupings.held[0], "FG-102");
});

test("FG-393 exact repro: show.nextAction for blocked-paused campaign says resolve blocker", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const items = db.prepare(
    "SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string }[];

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope' WHERE id = ?"
  ).run(items[0]!.id);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', continue_policy = 'hold_dependents' WHERE id = ?"
  ).run(items[1]!.id);

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show.nextAction.includes("resolve blocker"), `show.nextAction must say resolve blocker, got: ${show.nextAction}`);
  assert.ok(show.nextAction.includes("FG-101"), `show.nextAction must name the blocker ticket, got: ${show.nextAction}`);
  assert.notEqual(show.nextAction, "resume", "show.nextAction must NOT be bare 'resume' when unresolved blocked item exists");
});

test("FG-393 resolved-blocker case: blocked item resolved but held item remains → can_resume", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const items = db.prepare(
    "SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string }[];

  // FG-101: was blocked but operator resolved it (now shipped)
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?"
  ).run(items[0]!.id);
  // FG-102: still held — resume will reconsider it
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', continue_policy = 'hold_dependents' WHERE id = ?"
  ).run(items[1]!.id);

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "can_resume", "can_resume when no unresolved blocked item even if held items remain");
  assert.notEqual(report.safetyToContinue, "needs_resolution");
});

test("FG-393 clean paused campaign (no blocked, no held) → can_resume", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");
  // All items remain pending — cooperative pause mid-run

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "can_resume");
});

test("FG-393 consistency: blocked-paused campaign — all three surfaces agree, none advise plain resume", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const items = db.prepare(
    "SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string }[];

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope' WHERE id = ?"
  ).run(items[0]!.id);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', continue_policy = 'hold_dependents' WHERE id = ?"
  ).run(items[1]!.id);

  const show = assembleCampaignShow(campaign.id)!;
  const report = assembleCampaignReport(campaign.id)!;

  // Safety is non-continuable
  assert.notEqual(report.safetyToContinue, "can_resume", "safety must not be can_resume for blocked-paused campaign");
  assert.notEqual(report.safetyToContinue, "can_start", "safety must not be can_start for blocked-paused campaign");
  assert.equal(report.safetyToContinue, "needs_resolution");

  // Show action must not be bare resume
  assert.notEqual(show.nextAction, "resume", "show.nextAction must not be bare 'resume' for blocked-paused campaign");

  // All three surfaces mention resolving the blocker before resuming
  assert.ok(show.nextAction.includes("resolve blocker"), `show.nextAction must mention blocker resolution, got: ${show.nextAction}`);
  assert.ok(report.nextOperatorAction.includes("resolve blocker"), `nextOperatorAction must mention blocker resolution, got: ${report.nextOperatorAction}`);

  // None advise plain resume without blocker resolution
  assert.notEqual(report.nextOperatorAction, "resume the campaign when ready", "nextOperatorAction must not be bare resume for blocked-paused campaign");
});

// ── FG-411: plan_unresolvable — deleted source ticket ─────────────────────────

function deleteTicketFile(dir: string, ticketId: string): void {
  const storiesDir = join(dir, "backlog", "stories");
  const files = readdirSync(storiesDir);
  const file = files.find((f) => f.startsWith(`${ticketId}-`) || f === `${ticketId}.md`);
  if (file) unlinkSync(join(storiesDir, file));
}

test("FG-411: campaignBlocker returns 'plan_unresolvable' (not throw) for start intent when source ticket deleted", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Delete the source ticket file from the backlog
  deleteTicketFile(projectDir, "FG-101");

  const items = db.prepare(
    "SELECT id, ticket_id as ticketId, lifecycle_status as lifecycleStatus, run_id as runId FROM campaign_items WHERE campaign_id = ?"
  ).all(campaign.id) as Parameters<typeof campaignBlocker>[1];

  let result: ReturnType<typeof campaignBlocker>;
  assert.doesNotThrow(() => {
    result = campaignBlocker(getCampaign(campaign.id)!, items, "start");
  }, "campaignBlocker must not throw when source ticket is deleted");
  assert.equal(result!, "plan_unresolvable", "campaignBlocker must return plan_unresolvable for deleted source ticket");
});

test("FG-411: campaignBlocker returns 'plan_unresolvable' (not throw) for resume intent when source ticket deleted", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  // Delete the source ticket file from the backlog
  deleteTicketFile(projectDir, "FG-101");

  const items = db.prepare(
    "SELECT id, ticket_id as ticketId, lifecycle_status as lifecycleStatus, run_id as runId FROM campaign_items WHERE campaign_id = ?"
  ).all(campaign.id) as Parameters<typeof campaignBlocker>[1];

  let result: ReturnType<typeof campaignBlocker>;
  assert.doesNotThrow(() => {
    result = campaignBlocker(getCampaign(campaign.id)!, items, "resume");
  }, "campaignBlocker must not throw when source ticket is deleted");
  assert.equal(result!, "plan_unresolvable", "campaignBlocker must return plan_unresolvable for deleted source ticket (resume)");
});

test("FG-411: assembleCampaignShow succeeds and advises re-plan when source ticket deleted (planned)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Delete the source ticket file
  deleteTicketFile(projectDir, "FG-101");

  let result: ReturnType<typeof assembleCampaignShow>;
  assert.doesNotThrow(() => {
    result = assembleCampaignShow(campaign.id);
  }, "assembleCampaignShow must not throw when source ticket is deleted");
  assert.ok(result!, "assembleCampaignShow must return a result");
  assert.equal(result!.status, "planned", "campaign status must still be 'planned'");
  assert.ok(
    result!.nextAction.includes("re-plan") || result!.nextAction.includes("re-plan"),
    `nextAction must advise re-plan, got: ${result!.nextAction}`
  );
  assert.ok(
    result!.nextAction !== "start",
    "nextAction must NOT be 'start' when plan is unresolvable"
  );
});

test("FG-411: assembleCampaignReport succeeds — safetyToContinue non-continuable, advises re-plan when source ticket deleted", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Delete the source ticket file
  deleteTicketFile(projectDir, "FG-101");

  let result: ReturnType<typeof assembleCampaignReport>;
  assert.doesNotThrow(() => {
    result = assembleCampaignReport(campaign.id);
  }, "assembleCampaignReport must not throw when source ticket is deleted");
  assert.ok(result!, "assembleCampaignReport must return a result");
  assert.notEqual(result!.safetyToContinue, "can_start", "safetyToContinue must NOT be can_start when plan is unresolvable");
  assert.notEqual(result!.safetyToContinue, "can_resume", "safetyToContinue must NOT be can_resume when plan is unresolvable");
  assert.equal(result!.safetyToContinue, "stale", "safetyToContinue must be 'stale' for plan_unresolvable");
  assert.ok(
    result!.nextOperatorAction.includes("re-plan"),
    `nextOperatorAction must advise re-plan, got: ${result!.nextOperatorAction}`
  );
  assert.notEqual(result!.nextOperatorAction, "start the campaign");
  assert.notEqual(result!.nextOperatorAction, "resume the campaign when ready");
});

test("FG-411: assembleCampaignShow and assembleCampaignReport render persisted items even when source ticket deleted", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Delete the source ticket file
  deleteTicketFile(projectDir, "FG-101");

  const show = assembleCampaignShow(campaign.id)!;
  assert.equal(show.items.length, 1, "show must render the persisted item");
  assert.equal(show.items[0]!.ticketId, "FG-101");

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.items.length, 1, "report must render the persisted item");
  assert.equal(report.items[0]!.ticketId, "FG-101");
  assert.equal(report.status, "planned");
});

test("FG-411: CONSISTENCY — show/report/campaignBlocker all agree for plan_unresolvable", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Delete the source ticket file
  deleteTicketFile(projectDir, "FG-101");

  assertConsistency(campaign.id, "plan_unresolvable", "planned+deleted_ticket");

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show.nextAction.includes("re-plan"), `show.nextAction must mention re-plan, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "stale");
  assert.ok(report.nextOperatorAction.includes("re-plan"), `nextOperatorAction must mention re-plan, got: ${report.nextOperatorAction}`);
});

// ── FG-411: epic/mixed source with empty epic → plan_unresolvable ─────────────

test("FG-411: epic source with all active children deleted → campaignBlocker returns plan_unresolvable (start intent)", () => {
  // Plan with epic input — FG-100 has FG-101 and FG-102 as active children
  const { campaign } = planCampaign(
    { kind: "epic", epicId: "FG-100" },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Remove all active children of FG-100 — resolvePlan will throw "no active child stories"
  deleteTicketFile(projectDir, "FG-101");
  deleteTicketFile(projectDir, "FG-102");

  const items = db.prepare(
    "SELECT id, ticket_id as ticketId, lifecycle_status as lifecycleStatus, run_id as runId FROM campaign_items WHERE campaign_id = ?"
  ).all(campaign.id) as Parameters<typeof campaignBlocker>[1];

  let result: ReturnType<typeof campaignBlocker>;
  assert.doesNotThrow(() => {
    result = campaignBlocker(getCampaign(campaign.id)!, items, "start");
  }, "campaignBlocker must not throw when epic has no active children");
  assert.equal(result!, "plan_unresolvable", "any resolvePlan failure → plan_unresolvable, not only deleted list ticket");
});

test("FG-411: epic source with all active children deleted → campaignBlocker returns plan_unresolvable (resume intent)", () => {
  const { campaign } = planCampaign(
    { kind: "epic", epicId: "FG-100" },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  deleteTicketFile(projectDir, "FG-101");
  deleteTicketFile(projectDir, "FG-102");

  const items = db.prepare(
    "SELECT id, ticket_id as ticketId, lifecycle_status as lifecycleStatus, run_id as runId FROM campaign_items WHERE campaign_id = ?"
  ).all(campaign.id) as Parameters<typeof campaignBlocker>[1];

  let result: ReturnType<typeof campaignBlocker>;
  assert.doesNotThrow(() => {
    result = campaignBlocker(getCampaign(campaign.id)!, items, "resume");
  }, "campaignBlocker must not throw for resume intent when epic has no active children");
  assert.equal(result!, "plan_unresolvable", "epic with no active children → plan_unresolvable for resume intent");
});

// ── FG-411: regression guard — resolvable campaign never returns plan_unresolvable ───

test("FG-411: resolvable campaign still computes null normally (plan_unresolvable only on actual failure)", () => {
  // Plan + approve without touching backlog — plan remains resolvable
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const items = db.prepare(
    "SELECT id, ticket_id as ticketId, lifecycle_status as lifecycleStatus, run_id as runId FROM campaign_items WHERE campaign_id = ?"
  ).all(campaign.id) as Parameters<typeof campaignBlocker>[1];

  const result = campaignBlocker(getCampaign(campaign.id)!, items, "start");
  assert.equal(result, null, "resolvable campaign must NOT return plan_unresolvable — null means proceed");
  assert.notEqual(result, "plan_unresolvable", "plan_unresolvable must not appear when plan is resolvable");
});

test("FG-411: resolvable epic campaign still computes stale_plan when hash changed (plan_unresolvable only on resolve failure)", () => {
  // Plan with epic input, approve, then ADD a new story → hash changes → stale_plan (not plan_unresolvable)
  const { campaign } = planCampaign(
    { kind: "epic", epicId: "FG-100" },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  // Add a new active child — this changes the plan hash but does NOT remove FG-101/FG-102
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three added after approval",
    epic: "FG-100",
    created: "2024-01-03",
    body: "Added after approval to induce stale_plan",
  });

  const items = db.prepare(
    "SELECT id, ticket_id as ticketId, lifecycle_status as lifecycleStatus, run_id as runId FROM campaign_items WHERE campaign_id = ?"
  ).all(campaign.id) as Parameters<typeof campaignBlocker>[1];

  const result = campaignBlocker(getCampaign(campaign.id)!, items, "start");
  assert.equal(result, "stale_plan", "resolvable campaign with changed hash must get stale_plan, not plan_unresolvable");
  assert.notEqual(result, "plan_unresolvable", "plan_unresolvable must NOT be returned when resolvePlan succeeds");
});

// ── FG-411: paused campaign + deleted ticket → show/report for resume intent ───────

test("FG-411: paused campaign + deleted source ticket → assembleCampaignShow advises re-plan (not resume)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  deleteTicketFile(projectDir, "FG-101");

  let result: ReturnType<typeof assembleCampaignShow>;
  assert.doesNotThrow(() => {
    result = assembleCampaignShow(campaign.id);
  }, "assembleCampaignShow must not throw when source ticket deleted (paused campaign)");
  assert.ok(result!, "assembleCampaignShow must return a result");
  assert.equal(result!.status, "paused", "campaign status must still be paused");
  assert.ok(
    result!.nextAction.includes("re-plan"),
    `nextAction must advise re-plan for paused campaign with deleted ticket, got: ${result!.nextAction}`
  );
  assert.notEqual(result!.nextAction, "resume", "nextAction must NOT be bare 'resume' when plan is unresolvable");
  assert.equal(result!.items.length, 1, "persisted items must still render");
  assert.equal(result!.items[0]!.ticketId, "FG-101");
});

test("FG-411: paused campaign + deleted source ticket → assembleCampaignReport safetyToContinue=stale, advises re-plan", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  deleteTicketFile(projectDir, "FG-101");

  let result: ReturnType<typeof assembleCampaignReport>;
  assert.doesNotThrow(() => {
    result = assembleCampaignReport(campaign.id);
  }, "assembleCampaignReport must not throw when source ticket deleted (paused campaign)");
  assert.ok(result!, "assembleCampaignReport must return a result");
  assert.equal(result!.status, "paused");
  assert.equal(result!.safetyToContinue, "stale", "safetyToContinue must be 'stale' for plan_unresolvable (paused)");
  assert.notEqual(result!.safetyToContinue, "can_resume", "safetyToContinue must NOT be can_resume when plan is unresolvable");
  assert.ok(
    result!.nextOperatorAction.includes("re-plan"),
    `nextOperatorAction must advise re-plan, got: ${result!.nextOperatorAction}`
  );
  assert.notEqual(result!.nextOperatorAction, "resume the campaign when ready");
  assert.equal(result!.items.length, 1, "persisted items must still render");
});

test("FG-411: CONSISTENCY — paused campaign + deleted ticket → all three surfaces agree for resume intent", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  deleteTicketFile(projectDir, "FG-101");

  // assertConsistency checks: show.nextAction != "start"/"resume", safety != can_start/can_resume, operator != start/resume
  assertConsistency(campaign.id, "plan_unresolvable", "paused+deleted_ticket");

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show.nextAction.includes("re-plan"), `show.nextAction must mention re-plan, got: ${show.nextAction}`);
  assert.notEqual(show.nextAction, "resume", "show.nextAction must NOT be 'resume' for paused+unresolvable campaign");

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(report.safetyToContinue, "stale", "safetyToContinue must be stale for paused+plan_unresolvable");
  assert.ok(report.nextOperatorAction.includes("re-plan"), `nextOperatorAction must mention re-plan, got: ${report.nextOperatorAction}`);
  assert.notEqual(report.nextOperatorAction, "resume the campaign when ready");
});

// ── FG-413: readiness field on report/show items ──────────────────────────────

test("FG-413: assembleCampaignReport populates per-item readiness field (ready ticket → readiness.outcome=ready)", () => {
  // FG-101 from beforeEach has proper sections → evaluateReadiness → ready
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;

  assert.ok("readiness" in item, "ReportItemRow must have a 'readiness' field");
  assert.ok(item.readiness !== null, "readiness must be non-null for a ticket that exists in the backlog");
  assert.equal(item.readiness!.outcome, "ready", "readiness.outcome must be 'ready' for a properly-structured ticket");
  assert.deepEqual(item.readiness!.gaps, [], "no gaps for a ready ticket");
  assert.equal(item.readiness!.refinementProposal, null, "no refinementProposal for a ready ticket");
});

test("FG-413: assembleCampaignShow populates per-item readiness field", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );

  const result = assembleCampaignShow(campaign.id)!;
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;

  assert.ok("readiness" in item, "ShowItemRow must have a 'readiness' field");
  assert.ok(item.readiness !== null, "readiness must be non-null when ticket exists in backlog");
  assert.equal(item.readiness!.outcome, "ready");
});

test("FG-413: readiness field is null for ticket not in backlog", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );

  // Remove the ticket file so readiness can't be computed
  const storiesDir = `${projectDir}/backlog/stories`;
  const files = readdirSync(storiesDir);
  const file = files.find((f) => f.startsWith("FG-101-") || f === "FG-101.md");
  if (file) {
    unlinkSync(join(storiesDir, file));
  }

  const result = assembleCampaignReport(campaign.id)!;
  const item = result.items[0]!;
  assert.equal(item.readiness, null, "readiness must be null when ticket can't be read");
});

test("FG-413: readiness-held item → nextOperatorAction says refine then resume", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  // Mark FG-101 as readiness-held
  const items = db.prepare(
    "SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness', continue_policy = 'hold_dependents', reason = 'held because not ready: Missing Problem section', requested_human_action = 'refine FG-101 then resume' WHERE id = ?"
  ).run(items[0]!.id);

  const report = assembleCampaignReport(campaign.id)!;
  assert.ok(
    report.nextOperatorAction.includes("refine") && report.nextOperatorAction.includes("FG-101"),
    `nextOperatorAction must mention 'refine FG-101', got: ${report.nextOperatorAction}`
  );
  assert.ok(
    report.nextOperatorAction.includes("resume"),
    `nextOperatorAction must mention 'resume', got: ${report.nextOperatorAction}`
  );
  assert.ok(report.groupings.held.includes("FG-101"), "FG-101 must appear in held grouping");

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(
    show.nextAction.includes("refine") && show.nextAction.includes("FG-101"),
    `show.nextAction must mention 'refine FG-101', got: ${show.nextAction}`
  );
});

// ── FG-413 fix: computeSafety consistency — readiness-held → needs_resolution ──

test("FG-413 fix: readiness-held item → safetyToContinue=needs_resolution (not can_resume)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const items = db.prepare(
    "SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness' WHERE id = ?"
  ).run(items[0]!.id);

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "needs_resolution", "readiness-held item must set safetyToContinue=needs_resolution");
  assert.notEqual(result.safetyToContinue, "can_resume", "safetyToContinue must NOT be can_resume for readiness-held item");
});

test("FG-413 fix: no-issue paused → safetyToContinue=can_resume (both sides pinned)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");
  // All items remain pending with no outcome or blockerKind

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "can_resume", "genuinely-resumable paused campaign must remain can_resume");
  assert.notEqual(result.safetyToContinue, "needs_resolution");
});

test("FG-413 fix: failed+blocked item → safetyToContinue=needs_resolution (unchanged behavior pinned)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const items = db.prepare(
    "SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC"
  ).all(campaign.id) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope' WHERE id = ?"
  ).run(items[0]!.id);

  const result = assembleCampaignReport(campaign.id)!;
  assert.equal(result.safetyToContinue, "needs_resolution", "failed+blocked item must keep safetyToContinue=needs_resolution");
});

// ── FG-383: done-audit wiring ──────────────────────────────────────────────────

test("FG-383: assembleCampaignReport populates doneAuditState per item (non-null for readable ticket)", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );

  const result = assembleCampaignReport(campaign.id)!;
  const item = result.items[0]!;

  assert.ok("doneAuditState" in item, "ReportItemRow must have doneAuditState field");
  // doneAuditState is populated (non-null) because the ticket is readable
  assert.notEqual(item.doneAuditState, null, "doneAuditState must be non-null for a readable ticket");
  assert.ok(item.doneAuditState!.outcome !== undefined, "doneAuditState must have outcome");
  assert.ok(Array.isArray(item.doneAuditState!.checks), "doneAuditState must have checks array");
  assert.ok(Array.isArray(item.doneAuditState!.gaps), "doneAuditState must have gaps array");
});

test("FG-383: outcome=shipped item with done-audit outcome=unknown → verdict=complete_with_issues, NOT all_shipped", () => {
  // Write FG-101 as done but without closedCommit → closed_commit_present fails → fail/unknown
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "done",
    title: "Story One",
    epic: "FG-100",
    created: "2024-01-01",
    body: "## Problem\nDone.\n\n## Goal\nShip it.\n\n## Acceptance Criteria\n- Done\n",
    // no closedCommit — will cause closed_commit_present=fail → outcome=fail
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const result = assembleCampaignReport(campaign.id)!;
  assert.notEqual(result.verdict, "all_shipped", "shipped item with bad done-audit must NOT yield all_shipped");
  assert.equal(result.verdict, "complete_with_issues", "verdict must be complete_with_issues when done-audit not pass");
});

test("FG-383: complete campaign with shipped items having non-pass done-audit → verdict=complete_with_issues + nextOperatorAction surfaces done-audit gaps", () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  for (const item of items) {
    db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(item.id);
  }
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const requestedAction = "run host typecheck + full suite before closing";
  const auditMap = new Map<string, DoneAuditResult>([
    ["FG-101", { outcome: "pass", checks: [], gaps: [], requestedAction: null }],
    ["FG-102", { outcome: "unknown", checks: [], gaps: ["missing closedCommit"], requestedAction }],
  ]);
  const prev = setDoneAuditMapForTest(auditMap);
  try {
    const result = assembleCampaignReport(campaign.id)!;
    assert.equal(result.verdict, "complete_with_issues");
    assert.ok(result.nextOperatorAction.includes("done-audit gaps"), `expected "done-audit gaps" in nextOperatorAction, got: ${result.nextOperatorAction}`);
    assert.ok(result.nextOperatorAction.includes(requestedAction), `expected requestedAction text in nextOperatorAction, got: ${result.nextOperatorAction}`);
  } finally {
    setDoneAuditMapForTest(prev);
  }
});

test("FG-383: verdict=all_shipped gate requires done-audit outcome=pass (regression guard for old behavior change)", () => {
  // In the old code, outcome=shipped for all items was sufficient for all_shipped.
  // Now done-audit=pass is also required. This test pins that the old test
  // (which sets all items to shipped without any done-audit support) yields
  // complete_with_issues rather than all_shipped.

  // Use tickets from beforeEach — they have proper structure but no closedCommit
  // and ticket status = active (not done), so done-audit will fail.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  for (const item of items) {
    db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(item.id);
  }
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");

  const result = assembleCampaignReport(campaign.id)!;
  // Tickets are status=active (not done) → ticket_closed=fail → done-audit=fail
  // So verdict must be complete_with_issues despite all items being outcome=shipped
  assert.equal(result.verdict, "complete_with_issues", "all-shipped items with failed done-audit must not yield all_shipped");
});
