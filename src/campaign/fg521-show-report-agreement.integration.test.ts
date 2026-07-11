// FG-521 (c): `campaign show` and `campaign report` must not contradict each
// other about done-audit gaps on a COMPLETED campaign. show's next-action used
// to be a second, parallel machine that returned "complete — none"
// unconditionally while report consulted the doneAuditMap and flagged
// "shipped items have unresolved done-audit gaps — ...". These tests drive the
// REAL CLI actions (commander + the human renderers operators actually read),
// not just the assembled objects, and assert the two surfaces AGREE.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { approveCampaign, tryTransitionCampaignToRunning, updateCampaignStatus } from "../store/campaigns.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign } from "./planner.js";
import { assembleCampaignShow, assembleCampaignReport, setDoneAuditMapForTest } from "./report.js";
import { registerCampaign } from "../cli/commands/campaign.js";
import type { DoneAuditResult } from "../done-audit/done-audit.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg521-"));

  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    created: "2024-01-01",
    body: "## Problem\nOne.\n\n## Goal\nDo it.\n\n## Acceptance Criteria\n- done\n",
  });
  writeTicket(projectDir, {
    id: "FG-102",
    type: "story",
    status: "active",
    title: "Story Two",
    created: "2024-01-02",
    body: "## Problem\nTwo.\n\n## Goal\nDo it.\n\n## Acceptance Criteria\n- done\n",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

async function renderCampaignCli(args: string[]): Promise<string> {
  const lines = captureConsoleLog();
  try {
    const program = new Command();
    registerCampaign(program);
    await program.parseAsync(args, { from: "user" });
    return lines.join("\n");
  } finally {
    mock.restoreAll();
  }
}

/** A completed campaign whose items all shipped. */
function completedCampaignWithShippedItems(): string {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string }[];
  for (const item of items) {
    db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(item.id);
  }
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");
  return campaign.id;
}

const PASS_AUDIT: DoneAuditResult = { outcome: "pass", checks: [], gaps: [], requestedAction: null };
const GAP_AUDIT: DoneAuditResult = {
  outcome: "fail",
  checks: [],
  gaps: ["no covering passing host-verification row"],
  requestedAction: "record a passing host verification for FG-102",
};

test("FG-521: completed campaign with a done-audit gap — campaign show's next-action AGREES with campaign report's", async () => {
  const campaignId = completedCampaignWithShippedItems();

  const prevMap = setDoneAuditMapForTest(new Map([["FG-101", PASS_AUDIT], ["FG-102", GAP_AUDIT]]));
  try {
    const show = assembleCampaignShow(campaignId)!;
    const report = assembleCampaignReport(campaignId)!;

    // The whole defect: show said "complete — none" while report flagged the gap.
    assert.notEqual(show.nextAction, "complete — none");
    assert.equal(show.nextAction, report.nextOperatorAction);
    assert.match(show.nextAction, /shipped items have unresolved done-audit gaps/);
    assert.match(show.nextAction, /record a passing host verification for FG-102/);
  } finally {
    setDoneAuditMapForTest(prevMap);
  }
});

test("FG-521: the HUMAN-rendered `campaign show` and `campaign report` carry the same done-audit-gap next-action", async () => {
  const campaignId = completedCampaignWithShippedItems();

  const prevMap = setDoneAuditMapForTest(new Map([["FG-101", PASS_AUDIT], ["FG-102", GAP_AUDIT]]));
  try {
    const showOut = await renderCampaignCli(["campaign", "show", campaignId]);
    const reportOut = await renderCampaignCli(["campaign", "report", campaignId]);

    const gapText = "shipped items have unresolved done-audit gaps — record a passing host verification for FG-102";
    assert.match(showOut, new RegExp(`Next action: ${gapText}`));
    assert.match(reportOut, new RegExp(`Next operator action: ${gapText}`));
    assert.doesNotMatch(showOut, /Next action: complete — none/);
  } finally {
    setDoneAuditMapForTest(prevMap);
  }
});

test("FG-521: a completed campaign whose shipped items ALL pass their done-audit still reads 'complete — none' in show", async () => {
  const campaignId = completedCampaignWithShippedItems();

  const prevMap = setDoneAuditMapForTest(new Map([["FG-101", PASS_AUDIT], ["FG-102", PASS_AUDIT]]));
  try {
    const show = assembleCampaignShow(campaignId)!;
    const report = assembleCampaignReport(campaignId)!;

    assert.equal(show.nextAction, "complete — none");
    // report keeps its own no-gap wording; neither surface claims a gap.
    assert.equal(report.nextOperatorAction, "none — campaign complete (all items shipped)");
    assert.doesNotMatch(show.nextAction, /done-audit gaps/);

    const showOut = await renderCampaignCli(["campaign", "show", campaignId]);
    assert.match(showOut, /Next action: complete — none/);
  } finally {
    setDoneAuditMapForTest(prevMap);
  }
});

test("FG-521: every gapped shipped item is named — the gap action lists them all, identically on both surfaces", async () => {
  const campaignId = completedCampaignWithShippedItems();

  const secondGap: DoneAuditResult = {
    outcome: "fail",
    checks: [],
    gaps: ["ticket not closed"],
    requestedAction: "close FG-101",
  };
  const prevMap = setDoneAuditMapForTest(new Map([["FG-101", secondGap], ["FG-102", GAP_AUDIT]]));
  try {
    const show = assembleCampaignShow(campaignId)!;
    const report = assembleCampaignReport(campaignId)!;

    assert.equal(show.nextAction, report.nextOperatorAction);
    assert.match(show.nextAction, /close FG-101; record a passing host verification for FG-102/);
  } finally {
    setDoneAuditMapForTest(prevMap);
  }
});

test("FG-521: a shipped item with NO done-audit entry at all is a gap, not a pass — show and report agree", async () => {
  const campaignId = completedCampaignWithShippedItems();

  // FG-102 absent from the map entirely (collectDoneAuditInput threw / never ran).
  const prevMap = setDoneAuditMapForTest(new Map([["FG-101", PASS_AUDIT]]));
  try {
    const show = assembleCampaignShow(campaignId)!;
    const report = assembleCampaignReport(campaignId)!;

    assert.equal(show.nextAction, report.nextOperatorAction);
    assert.match(show.nextAction, /shipped items have unresolved done-audit gaps — re-audit FG-102/);
  } finally {
    setDoneAuditMapForTest(prevMap);
  }
});
