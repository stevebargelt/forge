// FG-516 (the two named review findings): the invoke-lane eligibility parks
// (executor.ts's quick_implementation finalize site, and the
// docs_only/test_only/review_only/research_only escape-hatch finalize site) used
// to call parkCampaign with NO blocker context, so the pushed milestone body
// carried only the requestedHumanAction — no leading `blocker: <kind>`. These
// regressions drive BOTH sites through the REAL invoke-lane paths (startCampaign →
// driveRemainingItems finalize) and assert the pushed body now leads with a
// composed `blocker: <kind>` AND the composed action — not action-only, not
// notifyCampaignPause's generic "campaign … parked <ticket>" fallback.
//
// Harness mirrors fg483 (git repo + invoke-lane dispatch seam); the milestone is
// captured via setCampaignNotifyEmitterForTest so the composed body is inspectable
// without a network provider.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, listCampaignItems } from "../store/campaigns.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, setCampaignNotifyEmitterForTest } from "./executor.js";
import type { EmitMilestoneArgs, EmitMilestoneResult } from "../notify/milestone.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let captured: EmitMilestoneArgs[];

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function makeBaseCommit(label: string): void {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
}

function readyBody(ticketId: string): string {
  return `## Problem\n${ticketId} needs implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n`;
}

function planQuickItem(ticketId: string) {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: readyBody(ticketId) });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [ticketId]: { lane: "quick_implementation", laneRationale: "test" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  return campaign;
}

function planDocsOnlyItem(ticketId: string) {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: readyBody(ticketId) });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [ticketId]: { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  return campaign;
}

function pauseBodyFor(campaignId: string, ticketId: string): string {
  const m = captured.find((a) => a.dedupeKey === `campaign-pause:${campaignId}:${ticketId}`);
  assert.ok(m, `a campaign-pause milestone was emitted for ${ticketId}`);
  return String(m!.body);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg516-lane-park-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  makeBaseCommit("init");
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  captured = [];
  setCampaignNotifyEmitterForTest(async (args: EmitMilestoneArgs): Promise<EmitMilestoneResult> => {
    captured.push(args);
    return { dispatched: true, decision: { send: true, reason: "test" }, importance: "high" };
  });
});

afterEach(() => {
  setCampaignNotifyEmitterForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// ── Finding 1: the quick_implementation eligibility park ──
test("FG-516 (finding 1): an eligibility-parked quick_implementation item pushes a body carrying `blocker: <kind>` + the composed action, not action-only", async () => {
  const ticketId = "FG-810";
  const campaign = planQuickItem(ticketId);

  // Fabricated/unreachable closedCommit (the FG-483 spoof shape): the item finishes
  // but fails the drive-time evidence gate → finalizeInvokeLaneOutcome parks it.
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    if (args.agentRole === "test-engineer") {
      closeTicket(projectDir, ticketId, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    }
    return { runId: args.runId ?? "run-fake", taskId: `task-${args.agentRole}`, status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.notEqual(result.stopReason, "complete", "a fabricated closedCommit must not ship");

  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "the item parked awaiting_gate");
  assert.equal(item.blockerKind, undefined, "no blockerKind persisted — the out-of-band reconcile marker is preserved");
  assert.equal(getCampaign(campaign.id)?.status, "paused");

  const body = pauseBodyFor(campaign.id, ticketId);
  assert.match(body, /blocker: human_decision/, "body leads with the composed blocker kind (was missing before the fix)");
  assert.match(body, /agent finished but evidence is incomplete/, "body carries the composed eligibility action");
  assert.doesNotMatch(body, /^campaign .* parked/, "body is NOT notifyCampaignPause's generic fallback");
  // The regression proper: the blocker label precedes the action (not action-only).
  assert.match(body, /^blocker: human_decision — /, "body is `blocker: <kind> — <action>`, not action-only");
});

// ── Finding 2: the docs_only/test_only/... escape-hatch eligibility park ──
test("FG-516 (finding 2): an eligibility-parked docs_only lane item pushes a body carrying `blocker: <kind>` + the composed action, not action-only", async () => {
  const ticketId = "FG-811";
  const campaign = planDocsOnlyItem(ticketId);

  // The docs lane dispatch completes but produces NO reachable evidence (no commit,
  // ticket never closed) → the invoke-lane finalize parks it at awaiting_gate.
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    return { runId: args.runId ?? "run-docs", taskId: `task-${args.agentRole}`, status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.notEqual(result.stopReason, "complete", "a docs item with no evidence must not ship");

  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "the item parked awaiting_gate");
  assert.equal(item.blockerKind, undefined, "no blockerKind persisted — the out-of-band reconcile marker is preserved");
  assert.equal(getCampaign(campaign.id)?.status, "paused");

  const body = pauseBodyFor(campaign.id, ticketId);
  assert.match(body, /blocker: human_decision/, "body leads with the composed blocker kind (was missing before the fix)");
  assert.match(body, /agent finished but evidence is incomplete/, "body carries the composed eligibility action");
  assert.doesNotMatch(body, /^campaign .* parked/, "body is NOT notifyCampaignPause's generic fallback");
  assert.match(body, /^blocker: human_decision — /, "body is `blocker: <kind> — <action>`, not action-only");
});
