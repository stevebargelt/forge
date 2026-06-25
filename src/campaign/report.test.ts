import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
import { assembleCampaignShow, assembleCampaignReport } from "./report.js";

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
    body: "Do the first thing",
  });
  writeTicket(projectDir, {
    id: "FG-102",
    type: "story",
    status: "active",
    title: "Story Two",
    epic: "FG-100",
    created: "2024-01-02",
    body: "Do the second thing",
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

  // Forward-compat fields must be present and null
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
  assert.equal(item.doneAuditState, null);
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

test("assembleCampaignReport: verdict='all_shipped' when complete and all items shipped", () => {
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
  assert.equal(result.verdict, "all_shipped");
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
