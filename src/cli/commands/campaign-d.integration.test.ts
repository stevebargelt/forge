// FG-728 step 3 — campaign segment D: FG-442 lanes/retry.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { writeTicket, closeTicket } from "../../backlog/structured.js";
import {
  setup,
  teardown,
  runForge,
  insertFixtureHostVerification,
  gitExec,
  makeCommitIn,
  commitFileIn,
  commitGateScriptIn,
  commitPendingChangesIn,
  setupOutOfBandCliCampaign,
  forgeHome,
  projectDir,
} from "./campaign.support.js";

beforeEach(setup);
afterEach(teardown);


// ── FG-442: execution lanes ───────────────────────────────────────────────────

function writeProjectRoutingPolicy(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const policy = {
    version: 1,
    governance: { accountable: "human" },
    routes: {
      implementation_full: {
        responsible: "engineer", path: "workflow",
        consulted: [], required_followups: [], informed: [], force_rules: [],
      },
      implementation_quick: {
        responsible: "engineer", path: "invoke_chain",
        consulted: [], required_followups: [], informed: [], force_rules: [],
      },
      documentation_durable: {
        responsible: "documentation-maintainer", path: "invoke",
        consulted: [], required_followups: [], informed: [], force_rules: [],
      },
    },
  };
  // Hand-rolled YAML — avoids adding a yaml-package dependency to a CLI-only test.
  const yaml =
    "version: 1\n" +
    "governance:\n  accountable: human\n" +
    "routes:\n" +
    Object.entries(policy.routes)
      .map(
        ([key, route]) =>
          `  ${key}:\n` +
          `    responsible: ${route.responsible}\n` +
          `    path: ${route.path}\n` +
          `    consulted: []\n` +
          `    required_followups: []\n` +
          `    informed: []\n` +
          `    force_rules: []\n`
      )
      .join("");
  writeFileSync(join(projectDir, ".forge", "routing-policy.yml"), yaml);
}

test("integ campaign plan --routes: classifies each item's lane and prints lane + rationale (human + --json)", () => {
  writeProjectRoutingPolicy();

  const routes = JSON.stringify({ "FG-101": "implementation_quick", "FG-102": "documentation_durable" });
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--routes", routes,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout) as {
    orderedItems: { ticketId: string; lane: string; laneRationale: string }[];
    canonicalContent: { orderedItems: { ticketId: string; lane: string; agentRole?: string }[] };
  };
  const fg101 = output.orderedItems.find((i) => i.ticketId === "FG-101")!;
  const fg102 = output.orderedItems.find((i) => i.ticketId === "FG-102")!;
  assert.equal(fg101.lane, "quick_implementation");
  assert.ok(fg101.laneRationale.length > 0);
  assert.equal(fg102.lane, "docs_only");

  const canonicalFg102 = output.canonicalContent.orderedItems.find((i) => i.ticketId === "FG-102")!;
  assert.equal(canonicalFg102.agentRole, "documentation-maintainer");

  const humanResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--routes", routes,
    "--project", projectDir,
  ]);
  assert.equal(humanResult.status, 0);
  assert.match(humanResult.stdout, /lane=quick_implementation/);
  assert.match(humanResult.stdout, /lane=docs_only/);
});

test("integ campaign plan without --routes and without --default-lane: refuses non-zero, plans nothing (FG-442 finding 3)", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
  ], { rawPlan: true });

  assert.notEqual(result.status, 0, `expected non-zero exit\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /no lane judgment supplied for 2 item\(s\) \(FG-442\)/);
  assert.match(result.stderr, /--routes/);
  assert.match(result.stderr, /--default-lane/);

  const dbPath = join(forgeHome, "forge.db");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    const campaigns = db.prepare("SELECT * FROM campaigns").all();
    assert.equal(campaigns.length, 0, "no campaign should be persisted when the refusal fires");
    db.close();
  }
});

test("integ campaign plan --default-lane full_feature --default-lane-rationale: succeeds, every item gets the operator lane + rationale, folded into plan_hash", () => {
  const rationale = "operator reviewed backlog manually — everything here is a full feature build";
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--default-lane", "full_feature",
    "--default-lane-rationale", rationale,
    "--json",
  ], { rawPlan: true });

  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    planHash: string;
    orderedItems: { ticketId: string; lane: string; laneRationale: string }[];
    canonicalContent: { orderedItems: { ticketId: string; lane: string; laneRationale: string }[] };
  };

  for (const item of output.orderedItems) {
    assert.equal(item.lane, "full_feature");
    assert.equal(item.laneRationale, rationale);
  }
  for (const entry of output.canonicalContent.orderedItems) {
    assert.equal(entry.lane, "full_feature");
    assert.equal(entry.laneRationale, rationale);
    assert.notEqual(entry.laneRationale, "no lane override supplied — defaulting to full_feature");
  }

  // The operator rationale is part of canonicalContent, which the plan_hash
  // is derived from — re-planning with a different rationale must change it.
  const differentRationaleResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--default-lane", "full_feature",
    "--default-lane-rationale", "a completely different rationale",
    "--json",
  ], { rawPlan: true });
  assert.equal(differentRationaleResult.status, 0);
  const differentOutput = JSON.parse(differentRationaleResult.stdout) as { planHash: string };
  assert.notEqual(differentOutput.planHash, output.planHash, "plan_hash must reflect the operator-supplied rationale");
});

test("integ campaign plan --default-lane <bad-lane>: rejected", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--default-lane", "not_a_real_lane",
    "--default-lane-rationale", "text",
  ], { rawPlan: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid --default-lane/);
});

test("integ campaign plan --default-lane docs_only (agentRole-bearing lane): rejected as a blanket default", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--default-lane", "docs_only",
    "--default-lane-rationale", "text",
  ], { rawPlan: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid --default-lane/);
});

test("integ campaign plan --default-lane without --default-lane-rationale: rejected", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--default-lane", "full_feature",
  ], { rawPlan: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--default-lane-rationale/);
});

test("integ campaign approve: restates the lane basis being recorded (human + --json)", () => {
  writeProjectRoutingPolicy();

  const routes = JSON.stringify({ "FG-101": "implementation_quick" });
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--routes", routes,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);
  assert.match(approveResult.stdout, /Lane basis being recorded:/);
  assert.match(approveResult.stdout, /FG-101: lane=quick_implementation/);

  const approveJsonResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "already approved, re-check json shape",
    "--json",
  ]);
  // Second approve call: campaign is now 'planned' still (approve doesn't transition status),
  // so this remains a valid re-approval — asserts the JSON laneBasis shape independent of the
  // human-output assertions above.
  assert.equal(approveJsonResult.status, 0, `stdout: ${approveJsonResult.stdout}\nstderr: ${approveJsonResult.stderr}`);
  const approveJson = JSON.parse(approveJsonResult.stdout) as {
    laneBasis: { ticketId: string; lane: string; laneRationale: string }[];
  };
  const laneEntry = approveJson.laneBasis.find((e) => e.ticketId === "FG-101")!;
  assert.equal(laneEntry.lane, "quick_implementation");
});

// ── RED-WIDE FG-442 follow-on fixes: escalation lifecycle integrity ──────────

test("integ RED-WIDE fix 1: campaign resume after a lane_escalation pause (no escalate) refuses, item2 never dispatched", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Simulate the campaign having already paused on a lane_escalation blocker for
  // item1 — the state escalateCampaignItemLane/finalizeInvokeDispatch produce,
  // without needing a real dispatch to outgrow a lane.
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation', requested_human_action = 'escalate the lane and re-approve before resuming' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, "resume after an unresolved lane_escalation pause must exit non-zero");
  const combined = (resumeResult.stderr + resumeResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("lane") && combined.includes("escalat"),
    `expected a lane-escalation-specific refusal message\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );

  const db2 = new Database(dbPath);
  const item2After = db2.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[1]!.id) as {
    lifecycle_status: string;
  };
  const campaignAfter = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(planOutput.campaignId) as { status: string };
  db2.close();
  assert.equal(item2After.lifecycle_status, "pending", "item2 must never be dispatched past the unresolved lane_escalation item");
  assert.equal(campaignAfter.status, "paused", "a refused resume must not silently transition the campaign");
});

test("integ RED-WIDE fix 2: campaign approve refuses a paused campaign with an unresolved lane_escalation blocker and unchanged plan_hash", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const rubberStampResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "rubber stamp attempt",
  ]);
  assert.notEqual(rubberStampResult.status, 0, "approve must refuse a rubber-stamp on an unresolved lane_escalation pause");
  const combined = (rubberStampResult.stderr + rubberStampResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("lane") && combined.includes("escalat"),
    `expected a lane-escalation-specific refusal message\nstdout: ${rubberStampResult.stdout}\nstderr: ${rubberStampResult.stderr}`
  );

  const db2 = new Database(dbPath);
  const campaignAfter = db2.prepare("SELECT approval_rationale FROM campaigns WHERE id = ?").get(planOutput.campaignId) as {
    approval_rationale: string | null;
  };
  db2.close();
  assert.equal(
    campaignAfter.approval_rationale,
    "LGTM",
    "the refused rubber-stamp attempt must not have overwritten the original approval record"
  );
});

test("integ RED-WIDE follow-on: real `campaign escalate-lane` + approve + resume proceeds only after the genuine escalate", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;

  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const escalateResult = runForge([
    "campaign", "escalate-lane", campaignId, "FG-101",
    "--new-lane", "quick_implementation",
    "--rationale", "agent reported outgrowing full_feature",
    "--json",
  ]);
  assert.equal(escalateResult.status, 0, `escalate-lane failed\nstdout: ${escalateResult.stdout}\nstderr: ${escalateResult.stderr}`);
  const escalateOutput = JSON.parse(escalateResult.stdout) as { planHash: string };

  const dbAfterEscalate = new Database(dbPath, { readonly: true });
  const itemAfterEscalate = dbAfterEscalate.prepare("SELECT lifecycle_status, blocker_kind FROM campaign_items WHERE id = ?").get(items[0]!.id) as {
    lifecycle_status: string;
    blocker_kind: string | null;
  };
  const campaignAfterEscalate = dbAfterEscalate.prepare("SELECT plan_hash, approved_plan_hash FROM campaigns WHERE id = ?").get(campaignId) as {
    plan_hash: string;
    approved_plan_hash: string;
  };
  dbAfterEscalate.close();
  assert.equal(itemAfterEscalate.lifecycle_status, "pending", "a genuine escalate must reset the escalated item to pending");
  assert.equal(itemAfterEscalate.blocker_kind, null, "a genuine escalate must clear the lane_escalation blocker");
  assert.equal(campaignAfterEscalate.plan_hash, escalateOutput.planHash);
  assert.notEqual(campaignAfterEscalate.plan_hash, campaignAfterEscalate.approved_plan_hash, "escalate must mint a fresh unapproved plan hash");

  const reapproveResult = runForge(["campaign", "approve", campaignId, "--rationale", "re-approved after genuine escalate"]);
  assert.equal(reapproveResult.status, 0, `re-approve after a genuine escalate must succeed\nstdout: ${reapproveResult.stdout}\nstderr: ${reapproveResult.stderr}`);

  // Simulate the re-dispatched item completing under its new lane (no real agent dispatch in this test).
  const dbComplete = new Database(dbPath);
  dbComplete.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  dbComplete.close();

  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as Record<string, unknown>;
  assert.equal(resumeOutput["stopReason"], "complete", "resume must proceed to complete only after the real escalate+approve");

  const dbFinal = new Database(dbPath, { readonly: true });
  const finalCampaign = dbFinal.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId) as { status: string };
  dbFinal.close();
  assert.equal(finalCampaign.status, "complete");
});

test("integ RED-WIDE follow-on: `campaign escalate-lane` with an unrelated/unknown ticket id is rejected and mints no approvable plan hash", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;

  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaignId) as { id: string; ticket_id: string }[];
  // FG-101 (items[0]) is the REAL item blocked on lane_escalation; FG-102 (items[1]) is unrelated and still pending.
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  const planHashBefore = (db.prepare("SELECT plan_hash FROM campaigns WHERE id = ?").get(campaignId) as { plan_hash: string }).plan_hash;
  db.close();

  // Escalate the WRONG ticket: FG-102 is not the item blocked on lane_escalation.
  const wrongTicketResult = runForge([
    "campaign", "escalate-lane", campaignId, "FG-102",
    "--new-lane", "quick_implementation",
    "--rationale", "attempted escalate of an unrelated ticket",
  ]);
  assert.notEqual(wrongTicketResult.status, 0, "escalate-lane on a ticket not blocked on lane_escalation must be rejected");
  const wrongTicketCombined = (wrongTicketResult.stderr + wrongTicketResult.stdout).toLowerCase();
  assert.ok(
    wrongTicketCombined.includes("lane_escalation") || wrongTicketCombined.includes("lane escalation") || wrongTicketCombined.includes("blocked"),
    `expected a lane_escalation-specific refusal\nstdout: ${wrongTicketResult.stdout}\nstderr: ${wrongTicketResult.stderr}`
  );

  // Escalate an UNKNOWN ticket id entirely.
  const unknownTicketResult = runForge([
    "campaign", "escalate-lane", campaignId, "FG-999-does-not-exist",
    "--new-lane", "quick_implementation",
    "--rationale", "attempted escalate of a nonexistent ticket",
  ]);
  assert.notEqual(unknownTicketResult.status, 0, "escalate-lane on an unknown ticket id must be rejected");

  const dbAfter = new Database(dbPath, { readonly: true });
  const campaignAfter = dbAfter.prepare("SELECT plan_hash, approved_plan_hash FROM campaigns WHERE id = ?").get(campaignId) as {
    plan_hash: string;
    approved_plan_hash: string;
  };
  const item2After = dbAfter.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[1]!.id) as { lifecycle_status: string };
  dbAfter.close();
  assert.equal(campaignAfter.plan_hash, planHashBefore, "a rejected escalate must not mint any new plan hash");
  assert.equal(item2After.lifecycle_status, "pending", "the unrelated ticket must not be reset/touched by the rejected escalate");

  // A subsequent approve must still be refused: the REAL escalated item (FG-101) is still unresolved.
  const approveAfterResult = runForge(["campaign", "approve", campaignId, "--rationale", "attempted rubber stamp"]);
  assert.notEqual(approveAfterResult.status, 0, "approve must still refuse while the real lane_escalation item remains unresolved");
  const approveCombined = (approveAfterResult.stderr + approveAfterResult.stdout).toLowerCase();
  assert.ok(
    approveCombined.includes("lane") && approveCombined.includes("escalat"),
    `expected a lane-escalation-specific refusal\nstdout: ${approveAfterResult.stdout}\nstderr: ${approveAfterResult.stderr}`
  );
  assert.equal(campaignAfter.approved_plan_hash, planHashBefore, "approved_plan_hash must be unchanged since the rejected escalate never re-approved anything");
});

// ── FG-489: `campaign retry` — supported reset-to-pending for transiently-failed items ──

test("integ FG-489: real `campaign retry` resets an auth-blocked item to pending; a subsequent `campaign resume` re-dispatches it to complete", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;

  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'auth', run_id = 'run-auth-dead', reason = 'auth token expired' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101", "--json"]);
  assert.equal(retryResult.status, 0, `retry failed\nstdout: ${retryResult.stdout}\nstderr: ${retryResult.stderr}`);
  const retryOutput = JSON.parse(retryResult.stdout) as { lifecycleStatus: string };
  assert.equal(retryOutput.lifecycleStatus, "pending");

  const dbAfterRetry = new Database(dbPath, { readonly: true });
  const itemAfterRetry = dbAfterRetry.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind, run_id FROM campaign_items WHERE id = ?"
  ).get(items[0]!.id) as { lifecycle_status: string; outcome: string | null; blocker_kind: string | null; run_id: string | null };
  dbAfterRetry.close();
  assert.equal(itemAfterRetry.lifecycle_status, "pending", "retry must reset the item to pending");
  assert.equal(itemAfterRetry.outcome, null, "retry must clear the blocked outcome");
  assert.equal(itemAfterRetry.blocker_kind, null, "retry must clear the auth blockerKind");
  assert.equal(itemAfterRetry.run_id, null, "retry must clear the dead run's linkage for a clean re-dispatch");

  // Simulate the re-dispatched item completing under a fresh run (no real agent dispatch in this test).
  const dbComplete = new Database(dbPath);
  dbComplete.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  dbComplete.close();

  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as Record<string, unknown>;
  assert.equal(resumeOutput["stopReason"], "complete", "resume must proceed to complete once the retried item is re-dispatched");
});

test("integ FG-489: `campaign retry` refuses a running campaign", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;
  runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaignId) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'auth' WHERE id = ?").run(items[0]!.id);
  db.close();

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(retryResult.status, 0, "retry must refuse a running campaign");
  assert.match(retryResult.stderr.toLowerCase(), /paused/);

  const dbAfter = new Database(dbPath, { readonly: true });
  const itemAfter = dbAfter.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[0]!.id) as { lifecycle_status: string };
  dbAfter.close();
  assert.equal(itemAfter.lifecycle_status, "failed", "a refused retry must not mutate the item");
});

test("integ FG-489: `campaign retry` refuses a scope-blocked item and names the escalate-lane path for a lane_escalation blocker", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;
  runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaignId) as {
    id: string;
    ticket_id: string;
  }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?").run(items[1]!.id);
  db.close();

  const scopeRetryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(scopeRetryResult.status, 0, "retry must refuse a scope-blocked item");
  assert.match(scopeRetryResult.stderr.toLowerCase(), /scope/);

  const laneRetryResult = runForge(["campaign", "retry", campaignId, "FG-102"]);
  assert.notEqual(laneRetryResult.status, 0, "retry must refuse a lane_escalation-blocked item");
  assert.match(laneRetryResult.stderr.toLowerCase(), /escalate-lane/);

  const dbAfter = new Database(dbPath, { readonly: true });
  const item1After = dbAfter.prepare("SELECT lifecycle_status, blocker_kind FROM campaign_items WHERE id = ?").get(items[0]!.id) as {
    lifecycle_status: string;
    blocker_kind: string;
  };
  const item2After = dbAfter.prepare("SELECT lifecycle_status, blocker_kind FROM campaign_items WHERE id = ?").get(items[1]!.id) as {
    lifecycle_status: string;
    blocker_kind: string;
  };
  dbAfter.close();
  assert.equal(item1After.lifecycle_status, "failed");
  assert.equal(item1After.blocker_kind, "scope");
  assert.equal(item2After.lifecycle_status, "failed");
  assert.equal(item2After.blocker_kind, "lane_escalation");
});

// ── FG-511: `campaign retry` on a campaign_system item, through the real CLI ──
//
// The executor-level tests cover retryCampaignItem's evidence probe directly.
// These pin the CLI contract the operator actually touches: exit code, the human
// and --json stdout on acceptance, and the stderr refusal naming the
// non-transient evidence — for the campaign_system shape specifically, whose
// verdict depends on run/task rows the CLI process must read for itself.

// Seeds the durable evidence the probe reads back: a paused campaign whose single
// item is parked on the campaign_system placeholder, pointing at an abandoned run
// with one failed primary task per kind (each with the task.failed event that
// carries its failure_kind).
function seedCampaignSystemItem(dbPath: string, campaignId: string, failureKinds: string[]): { itemId: string; runId: string } {
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const itemId = (db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").get(campaignId) as { id: string }).id;
  const runId = `run-${itemId}`;
  const now = new Date().toISOString();

  // FG-722: the campaign_system retry probe now selects failed primaries via the
  // evaluator (classifyRunTerminalState), so it loads the run's workflow. A project
  // override makes "feature" loadable in the real CLI subprocess without publishing a
  // seed generation; its "implement" step matches the seeded task phase below.
  const wfDir = join(projectDir, ".forge", "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, "feature.yml"),
    "name: feature\ndescription: fg722 cli parity fixture\ninputs: []\nsteps:\n  - id: implement\n    agent: engineer\n    gate: none\n    manual: false\n    depends_on: []\n    runtime: claude\n    reds: []\n",
  );

  db.prepare("INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, 'abandoned', ?, ?)").run(runId, "FG-101", now, projectDir);
  failureKinds.forEach((kind, i) => {
    const taskId = `${runId}-task-${i}`;
    db.prepare(
      "INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, error) VALUES (?, ?, 'implement', 'engineer', 'failed', '{}', ?, ?)"
    ).run(taskId, runId, now, `seeded ${kind}`);
    db.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, 'task.failed', ?, ?)").run(
      runId,
      taskId,
      JSON.stringify({ failure_kind: kind, error: `seeded ${kind}` }),
      now
    );
  });
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'campaign_system', run_id = ?, requested_human_action = 'run ended without a terminal outcome' WHERE id = ?"
  ).run(runId, itemId);
  db.close();
  return { itemId, runId };
}

// FG-722: a deliberately configurable durable fixture for the retry command's
// evaluator seam.  Unlike seedCampaignSystemItem's FG-511 compatibility shape,
// this can describe the two run kinds that the probe must distinguish: a pipeline
// workflow (which must load YAML) and an invoke-family run (which must not try to
// load YAML at all).  Rows are inserted in the same runs/tasks/events tables the
// independently spawned `forge campaign retry` process reads.
type Fg722RetryRow = {
  id: string;
  phase: string;
  status: "failed" | "complete";
  failureKind?: string;
  dispatchSource: "workflow" | "invoke";
  createdAt: string;
};

function seedFg722CampaignSystemItem(
  dbPath: string,
  campaignId: string,
  options: {
    workflow: string;
    workflowSteps?: string[];
    rows: Fg722RetryRow[];
  },
): { itemId: string; runId: string } {
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const itemId = (db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").get(campaignId) as { id: string }).id;
  const runId = `run-${itemId}`;

  if (options.workflowSteps) {
    const wfDir = join(projectDir, ".forge", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const steps = options.workflowSteps
      .map((id) => `  - id: ${id}\n    agent: engineer\n    gate: none\n    manual: false\n    depends_on: []\n    runtime: claude\n    reds: []`)
      .join("\n");
    writeFileSync(join(wfDir, `${options.workflow}.yml`), `name: ${options.workflow}\ndescription: fg722 cli retry fixture\ninputs: []\nsteps:\n${steps}\n`);
  }

  db.prepare("INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, 'abandoned', ?, ?)")
    .run(runId, options.workflow, "FG-101", "2024-01-01T00:00:00.000Z", projectDir);
  for (const row of options.rows) {
    const taskId = `${runId}-${row.id}`;
    db.prepare(
      "INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, error) VALUES (?, ?, ?, 'engineer', ?, ?, ?, ?)",
    ).run(
      taskId,
      runId,
      row.phase,
      row.status,
      JSON.stringify({ dispatchSource: row.dispatchSource }),
      row.createdAt,
      row.failureKind ? `seeded ${row.failureKind}` : null,
    );
    if (row.failureKind) {
      db.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, 'task.failed', ?, ?)").run(
        runId,
        taskId,
        JSON.stringify({ failure_kind: row.failureKind, error: `seeded ${row.failureKind}` }),
        row.createdAt,
      );
    }
  }
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'campaign_system', run_id = ?, requested_human_action = 'run ended without a terminal outcome' WHERE id = ?",
  ).run(runId, itemId);
  db.close();
  return { itemId, runId };
}

function retryAuditEvidence(dbPath: string, runId: string): Array<{ taskId: string; failureKind: string; classified: string }> {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT payload FROM events WHERE run_id = ? AND event_type = 'campaign_item.campaign_system_retried'")
    .get(runId) as { payload: string } | undefined;
  db.close();
  assert.ok(row, "a successful campaign retry must record its evidence audit event");
  return (JSON.parse(row.payload) as { evidence: Array<{ taskId: string; failureKind: string; classified: string }> }).evidence;
}

function planAndApprove(): string {
  const planResult = runForge(["campaign", "plan", "--tickets", "FG-101", "--project", projectDir, "--mode", "sequential", "--json"]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const campaignId = (JSON.parse(planResult.stdout) as { campaignId: string }).campaignId;
  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);
  return campaignId;
}

test("integ FG-722: real `campaign retry` loads a pipeline workflow and audits the failed workflow phase evidence", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { runId } = seedFg722CampaignSystemItem(dbPath, campaignId, {
    workflow: "fg722-pipeline",
    workflowSteps: ["implement"],
    rows: [
      { id: "pipeline-failure", phase: "implement", status: "failed", failureKind: "idle_timeout", dispatchSource: "workflow", createdAt: "2024-01-01T00:00:01.000Z" },
    ],
  });

  const retry = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.equal(retry.status, 0, `pipeline retry failed\nstdout: ${retry.stdout}\nstderr: ${retry.stderr}`);
  assert.deepEqual(
    retryAuditEvidence(dbPath, runId).map(({ taskId, failureKind, classified }) => [taskId, failureKind, classified]),
    [[`${runId}-pipeline-failure`, "idle_timeout", "infrastructure"]],
    "the pipeline lane must classify the failed workflow phase through its loaded YAML",
  );
});

test("integ FG-722: real `campaign retry` accepts an invoke-family failure without a workflow file", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { runId } = seedFg722CampaignSystemItem(dbPath, campaignId, {
    workflow: "invoke_chain",
    // Deliberately no workflowSteps: invoke-family runs do not own workflow YAML.
    rows: [
      { id: "invoke-failure", phase: "task", status: "failed", failureKind: "idle_timeout", dispatchSource: "invoke", createdAt: "2024-01-01T00:00:01.000Z" },
    ],
  });

  const retry = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.equal(retry.status, 0, `invoke-family retry must not refuse for no failed primary\nstdout: ${retry.stdout}\nstderr: ${retry.stderr}`);
  assert.deepEqual(
    retryAuditEvidence(dbPath, runId).map(({ taskId, failureKind, classified }) => [taskId, failureKind, classified]),
    [[`${runId}-invoke-failure`, "idle_timeout", "infrastructure"]],
    "the invoke terminal shape treats its failed single task as the terminal phase",
  );
});

test("integ FG-722: real pipeline retry excludes a superseded primary and ad-hoc invoke failure from its audit evidence", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { runId } = seedFg722CampaignSystemItem(dbPath, campaignId, {
    workflow: "fg722-correction",
    workflowSteps: ["implement", "verify"],
    rows: [
      // A request-changes replacement completed implement, superseding this failed
      // primary.  The old parent-less failed-row scan would have reported it.
      { id: "superseded-failure", phase: "implement", status: "failed", failureKind: "gate_rejected", dispatchSource: "workflow", createdAt: "2024-01-01T00:00:01.000Z" },
      { id: "replacement-complete", phase: "implement", status: "complete", dispatchSource: "workflow", createdAt: "2024-01-01T00:00:02.000Z" },
      // This is an attached ad-hoc invoke row, not a pipeline phase.
      { id: "adhoc-failure", phase: "task", status: "failed", failureKind: "gate_rejected", dispatchSource: "invoke", createdAt: "2024-01-01T00:00:03.000Z" },
      { id: "genuine-failure", phase: "verify", status: "failed", failureKind: "idle_timeout", dispatchSource: "workflow", createdAt: "2024-01-01T00:00:04.000Z" },
    ],
  });

  const retry = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.equal(retry.status, 0, `only the genuine transient pipeline phase should control retry\nstdout: ${retry.stdout}\nstderr: ${retry.stderr}`);
  assert.deepEqual(
    retryAuditEvidence(dbPath, runId).map(({ taskId, failureKind, classified }) => [taskId, failureKind, classified]),
    [[`${runId}-genuine-failure`, "idle_timeout", "infrastructure"]],
    "superseded and ad-hoc failed rows must be absent from pipeline-lane retry evidence",
  );
});

test("integ FG-722: real pipeline retry fails closed when its workflow YAML cannot be loaded", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { itemId, runId } = seedFg722CampaignSystemItem(dbPath, campaignId, {
    workflow: "fg722-missing-workflow",
    // No matching file: a pipeline workflow load failure must be a refusal, not a crash.
    rows: [
      { id: "failed-before-load", phase: "implement", status: "failed", failureKind: "idle_timeout", dispatchSource: "workflow", createdAt: "2024-01-01T00:00:01.000Z" },
    ],
  });

  const retry = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(retry.status, 0, "an unloadable pipeline workflow must refuse retry");
  assert.match(retry.stderr, /workflow 'fg722-missing-workflow' could not be loaded/i, `refusal must name the workflow-load failure\nstderr: ${retry.stderr}`);

  const db = new Database(dbPath, { readonly: true });
  const item = db.prepare("SELECT lifecycle_status, run_id FROM campaign_items WHERE id = ?").get(itemId) as { lifecycle_status: string; run_id: string | null };
  const auditCount = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND event_type = 'campaign_item.campaign_system_retried'").get(runId) as { n: number }).n;
  db.close();
  assert.equal(item.lifecycle_status, "failed", "a fail-safe refusal must not reset the campaign item");
  assert.equal(item.run_id, runId, "a fail-safe refusal must retain the evidence linkage");
  assert.equal(auditCount, 0, "a refused retry must not write an acceptance audit event");
});

test("integ FG-511: real `campaign retry` accepts a campaign_system item on transient run evidence — human and --json stdout, audit event, item reset", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { itemId, runId } = seedCampaignSystemItem(dbPath, campaignId, ["idle_timeout"]);

  // `campaign show` must point the operator at retry BEFORE they run it — the
  // human line and the --json field both.
  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `show failed\nstderr: ${showResult.stderr}`);
  assert.ok(
    showResult.stdout.includes(`forge campaign retry ${campaignId} FG-101`),
    `show must name the evidence-gated retry\nstdout: ${showResult.stdout}`
  );
  const showJson = JSON.parse(runForge(["campaign", "show", campaignId, "--json"]).stdout) as {
    items: { campaignSystemRetryEligible: boolean }[];
  };
  assert.equal(showJson.items[0]!.campaignSystemRetryEligible, true, "the JSON surface must expose retry eligibility");

  const humanResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.equal(humanResult.status, 0, `retry failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.match(humanResult.stdout, /Reset FG-101 in campaign .* to pending\./);
  assert.match(humanResult.stdout, new RegExp(`forge campaign resume ${campaignId}`));

  const dbAfter = new Database(dbPath, { readonly: true });
  const item = dbAfter.prepare("SELECT lifecycle_status, outcome, blocker_kind, run_id FROM campaign_items WHERE id = ?").get(itemId) as {
    lifecycle_status: string;
    outcome: string | null;
    blocker_kind: string | null;
    run_id: string | null;
  };
  const auditEvents = dbAfter
    .prepare("SELECT payload FROM events WHERE run_id = ? AND event_type = 'campaign_item.campaign_system_retried'")
    .all(runId) as { payload: string }[];
  dbAfter.close();

  assert.equal(item.lifecycle_status, "pending", "retry must reset the item to pending");
  assert.equal(item.blocker_kind, null, "retry must clear the campaign_system blockerKind");
  assert.equal(item.run_id, null, "retry must clear the abandoned run's linkage");
  assert.equal(auditEvents.length, 1, "acceptance must record exactly one campaign_system_retried audit event");
  const evidence = (JSON.parse(auditEvents[0]!.payload) as { evidence: { failureKind: string; classified: string }[] }).evidence;
  assert.deepEqual(evidence.map((e) => [e.failureKind, e.classified]), [["idle_timeout", "infrastructure"]]);

  // The --json surface of a second, independent acceptance.
  const campaignId2 = planAndApprove();
  seedCampaignSystemItem(dbPath, campaignId2, ["idle_timeout"]);
  const jsonResult = runForge(["campaign", "retry", campaignId2, "FG-101", "--json"]);
  assert.equal(jsonResult.status, 0, `retry --json failed\nstderr: ${jsonResult.stderr}`);
  assert.deepEqual(JSON.parse(jsonResult.stdout), { campaignId: campaignId2, ticketId: "FG-101", lifecycleStatus: "pending" });
});

test("integ FG-511: real `campaign retry` refuses a campaign_system item on non-transient run evidence, naming it — item unchanged, no audit event", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { itemId, runId } = seedCampaignSystemItem(dbPath, campaignId, ["idle_timeout", "gate_rejected"]);

  // The mirror surface must refuse too: no retry pointer for evidence retry rejects.
  const showResult = runForge(["campaign", "show", campaignId]);
  assert.ok(!showResult.stdout.includes("forge campaign retry"), `show must not name retry for mixed evidence\nstdout: ${showResult.stdout}`);
  const showJson = JSON.parse(runForge(["campaign", "show", campaignId, "--json"]).stdout) as {
    items: { campaignSystemRetryEligible: boolean }[];
  };
  assert.equal(showJson.items[0]!.campaignSystemRetryEligible, false);

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(retryResult.status, 0, "mixed transient+scope evidence must refuse fail-closed");
  assert.match(retryResult.stderr, new RegExp(`${runId}-task-1`), `refusal must name the non-transient task\nstderr: ${retryResult.stderr}`);
  assert.match(retryResult.stderr, /gate_rejected/, "refusal must name the failure kind");
  assert.match(retryResult.stderr, /'scope'/, "refusal must name the classification");

  const dbAfter = new Database(dbPath, { readonly: true });
  const item = dbAfter.prepare("SELECT lifecycle_status, blocker_kind, run_id FROM campaign_items WHERE id = ?").get(itemId) as {
    lifecycle_status: string;
    blocker_kind: string | null;
    run_id: string | null;
  };
  const auditCount = (
    dbAfter.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.campaign_system_retried'").get() as { n: number }
  ).n;
  dbAfter.close();
  assert.equal(item.lifecycle_status, "failed", "a refused retry must not mutate the item");
  assert.equal(item.blocker_kind, "campaign_system");
  assert.equal(item.run_id, runId, "a refused retry must not clear the run linkage");
  assert.equal(auditCount, 0, "a refused retry must record no audit event");
});

// FG-511 round 2: the same transient run evidence, but the ticket was delivered
// out-of-band anyway. Through the real CLI: `show` must point at reconcile and
// never print the retry hint, and `retry` must refuse rather than re-dispatch
// work already on main.
test("integ FG-511: real `campaign retry` refuses a campaign_system item whose ticket is provably delivered, naming reconcile — show points there too", () => {
  gitExec(["init", "-b", "main"], projectDir);
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");

  makeCommitIn(projectDir, "base");
  const shipCommit = makeCommitIn(projectDir, "ship-FG-101");
  closeTicket(projectDir, "FG-101", shipCommit);
  const { itemId, runId } = seedCampaignSystemItem(dbPath, campaignId, ["idle_timeout"]);

  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `show failed\nstderr: ${showResult.stderr}`);
  assert.ok(showResult.stdout.includes("forge campaign reconcile"), `show must point at reconcile\nstdout: ${showResult.stdout}`);
  assert.ok(
    !showResult.stdout.includes("campaign-system-retryable"),
    `show must not print a retry hint for delivered work\nstdout: ${showResult.stdout}`
  );
  assert.ok(!showResult.stdout.includes("forge campaign retry"), `show must not name retry at all\nstdout: ${showResult.stdout}`);

  const showJson = JSON.parse(runForge(["campaign", "show", campaignId, "--json"]).stdout) as {
    items: { campaignSystemEligible: boolean; campaignSystemRetryEligible: boolean }[];
  };
  assert.equal(showJson.items[0]!.campaignSystemEligible, true, "the JSON surface must expose reconcile eligibility");
  assert.equal(showJson.items[0]!.campaignSystemRetryEligible, false, "the JSON surface must not claim retry eligibility");

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(retryResult.status, 0, "delivered work must never be reset for re-dispatch");
  assert.match(retryResult.stderr, /provably delivered/i, `refusal must say the work already landed\nstderr: ${retryResult.stderr}`);
  assert.match(retryResult.stderr, new RegExp(`forge campaign reconcile ${campaignId}`), `refusal must name reconcile\nstderr: ${retryResult.stderr}`);

  const dbAfter = new Database(dbPath, { readonly: true });
  const item = dbAfter.prepare("SELECT lifecycle_status, blocker_kind, run_id FROM campaign_items WHERE id = ?").get(itemId) as {
    lifecycle_status: string;
    blocker_kind: string | null;
    run_id: string | null;
  };
  const auditCount = (
    dbAfter.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.campaign_system_retried'").get() as { n: number }
  ).n;
  dbAfter.close();
  assert.equal(item.lifecycle_status, "failed", "a refused retry must not mutate the item");
  assert.equal(item.blocker_kind, "campaign_system");
  assert.equal(item.run_id, runId, "a refused retry must not clear the run linkage");
  assert.equal(auditCount, 0, "a refused retry must record no audit event");
});

// ── FG-442 review (PR #11 follow-up), Finding 2: paused-approve plan-hash scoping ──

test("integ FG-442 Finding 2: campaign approve refuses a paused campaign parked at awaiting_gate with an unchanged plan_hash (campaign-922 shape)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  // The out-of-band shape: awaiting_gate with NO blocker_kind — e.g. an invoke-lane
  // item that finished without shipping (Finding 1) or a gate:human pause. No plan change.
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'agent finished but ticket FG-101 is not closed with a closedCommit — close the ticket and run `forge campaign reconcile`, or resolve manually' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const rubberStampResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "rubber stamp attempt",
  ]);
  assert.notEqual(rubberStampResult.status, 0, "approve must refuse a paused campaign whose plan_hash is unchanged since approval");
  const combined = (rubberStampResult.stderr + rubberStampResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("plan hash") || combined.includes("plan_hash"),
    `expected a plan-hash-scoping refusal message\nstdout: ${rubberStampResult.stdout}\nstderr: ${rubberStampResult.stderr}`
  );

  const db2 = new Database(dbPath);
  const campaignAfter = db2.prepare("SELECT approval_rationale FROM campaigns WHERE id = ?").get(planOutput.campaignId) as {
    approval_rationale: string | null;
  };
  const itemAfter = db2.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[0]!.id) as {
    lifecycle_status: string;
  };
  db2.close();
  assert.equal(
    campaignAfter.approval_rationale,
    "LGTM",
    "the refused rubber-stamp attempt must not have overwritten the original approval record"
  );
  assert.equal(itemAfter.lifecycle_status, "awaiting_gate", "the preserved item must not be mutated by the refused approve");
});

test("integ FG-442 Finding 2: a genuine escalate->approve re-approval (fresh plan_hash) still proceeds", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const escalateResult = runForge([
    "campaign", "escalate-lane", planOutput.campaignId, "FG-101",
    "--new-lane", "quick_implementation",
    "--rationale", "genuinely outgrew the assigned lane",
  ]);
  assert.equal(escalateResult.status, 0, `escalate-lane failed\nstdout: ${escalateResult.stdout}\nstderr: ${escalateResult.stderr}`);

  const reapproveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "re-approved after genuine escalate",
  ]);
  assert.equal(
    reapproveResult.status,
    0,
    `genuine post-escalate re-approve must succeed\nstdout: ${reapproveResult.stdout}\nstderr: ${reapproveResult.stderr}`
  );

  const db2 = new Database(dbPath, { readonly: true });
  const campaignAfter = db2.prepare("SELECT plan_hash, approved_plan_hash FROM campaigns WHERE id = ?").get(planOutput.campaignId) as {
    plan_hash: string;
    approved_plan_hash: string;
  };
  db2.close();
  assert.equal(campaignAfter.plan_hash, campaignAfter.approved_plan_hash, "the genuine re-approve must record the fresh plan hash as approved");
});

// ── FG-490 review: drive-error rethrow renders through the CLI's stop-reason
// output paths instead of escaping as a bare uncaught exception ────────────
//
// A project-override `feature.yml` that declares a required input the
// executor never supplies forces the real (non-mocked) startRun to throw
// synchronously the moment the item dispatches — the same drive-path throw
// parkCampaignOnDriveThrow wraps and rethrows in production.
function writeDriveErrorForcingWorkflow(): void {
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  const yaml = [
    "name: feature",
    "description: FG-490 fixture — forces startRun's required-input check to throw.",
    "inputs:",
    "  - name: brief",
    "    required: true",
    "    type: text",
    "  - name: drive-error-fixture-field",
    "    required: true",
    "    type: text",
    "    help: never supplied by the campaign executor — forces the drive-time throw",
    "steps:",
    "  - id: architect",
    "    agent: architecture-advisor",
    "",
  ].join("\n");
  writeFileSync(join(projectDir, ".forge", "workflows", "feature.yml"), yaml);
}

// The shared beforeEach's FG-101 has an empty body, so it never clears the
// readiness gate (evaluateReadiness) and the item parks on outcome=held
// before it ever reaches dispatch. Rewrite it with Problem/Goal/Acceptance
// Criteria sections — same shape executor.integration.test.ts's real-dispatch fixtures
// use — so the item actually dispatches and hits the drive-error fixture.
function writeReadyTicket(): void {
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    created: "2024-01-01",
    body: "## Problem\nStory One needs implementation.\n\n## Goal\nComplete story one.\n\n## Acceptance Criteria\n- Story one is complete\n",
  });
}

test("integ FG-490 review: campaign start --json renders a drive-error as structured JSON, not a bare non-JSON exception", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const startResult = runForge(["campaign", "start", planOutput.campaignId, "--json"]);
  assert.notEqual(startResult.status, 0, "a drive-error must still exit non-zero");

  let parsed: { stopReason: string; ticketId?: string; runId?: string; error: string; guidance: string };
  assert.doesNotThrow(
    () => { parsed = JSON.parse(startResult.stdout); },
    `--json output must be parseable JSON, not a bare 'forge: ...' line\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  parsed = JSON.parse(startResult.stdout);
  assert.equal(parsed.stopReason, "drive_error");
  assert.equal(parsed.ticketId, "FG-101");
  assert.ok(parsed.runId, "runId must be derivable from the parked campaign item");
  assert.match(parsed.error, /required input 'drive-error-fixture-field' missing/, "error must carry the ORIGINAL drive-path error, not the wrapped guidance text");
  // FG-490 reopen: this fixture parks failed/blocked/infrastructure (the
  // startRun-throw shape) — bare resume SKIPS failed items, so the guidance
  // must lead with retry (targeting this exact campaign+ticket) before resume,
  // never recommend bare resume alone.
  assert.ok(
    parsed.guidance.includes(`forge campaign retry ${planOutput.campaignId} FG-101`),
    `guidance must recommend retry for the parked ticket, got: ${parsed.guidance}`
  );
  assert.ok(
    parsed.guidance.includes(`forge campaign resume ${planOutput.campaignId}`),
    `guidance must still chain into resume, got: ${parsed.guidance}`
  );
  assert.notEqual(
    parsed.guidance,
    `forge campaign resume ${planOutput.campaignId}`,
    "guidance must not be bare resume alone — that silently skips the failed item"
  );
});

test("integ FG-490 review: campaign start (human) still prints the wrapped drive-error message with resume guidance", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const startResult = runForge(["campaign", "start", planOutput.campaignId]);
  assert.notEqual(startResult.status, 0, "a drive-error must still exit non-zero");

  const combined = startResult.stderr + startResult.stdout;
  assert.ok(
    combined.includes(`campaign ${planOutput.campaignId} paused after a drive error on FG-101`),
    `human output must keep the executor's wrapped message text\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes(`forge campaign resume ${planOutput.campaignId}`),
    `human output must keep the resume guidance\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

test("integ FG-490 review: campaign resume --json renders a fresh drive-error as structured JSON", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Drive resume straight into dispatch (skipping a real `start`): flip the
  // campaign to paused with its item still pending, exactly as the other
  // in-flight/held resume tests in this file seed state directly via DB.
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId, "--json"]);
  assert.notEqual(resumeResult.status, 0, "a drive-error must still exit non-zero");

  let parsed: { stopReason: string; ticketId?: string; runId?: string; error: string; guidance: string };
  assert.doesNotThrow(
    () => { parsed = JSON.parse(resumeResult.stdout); },
    `--json output must be parseable JSON, not a bare 'forge: ...' line\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  parsed = JSON.parse(resumeResult.stdout);
  assert.equal(parsed.stopReason, "drive_error");
  assert.equal(parsed.ticketId, "FG-101");
  assert.ok(parsed.runId, "runId must be derivable from the parked campaign item");
  assert.match(parsed.error, /required input 'drive-error-fixture-field' missing/);
  // FG-490 reopen: same startRun-throw shape as the `start` case above — resume
  // must also lead with retry, not bare resume.
  assert.ok(
    parsed.guidance.includes(`forge campaign retry ${planOutput.campaignId} FG-101`),
    `guidance must recommend retry for the parked ticket, got: ${parsed.guidance}`
  );
  assert.notEqual(
    parsed.guidance,
    `forge campaign resume ${planOutput.campaignId}`,
    "guidance must not be bare resume alone — that silently skips the failed item"
  );
});

test("integ FG-490 review: campaign resume (human) still prints the wrapped drive-error message with resume guidance", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, "a drive-error must still exit non-zero");

  const combined = resumeResult.stderr + resumeResult.stdout;
  assert.ok(
    combined.includes(`campaign ${planOutput.campaignId} paused after a drive error on FG-101`),
    `human output must keep the executor's wrapped message text\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes(`forge campaign resume ${planOutput.campaignId}`),
    `human output must keep the resume guidance\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

// ── FG-490 reopen: the runNext-throw (awaiting_gate) shape, exercised at the
// CLI layer ──────────────────────────────────────────────────────────────
//
// startRun succeeds (only `brief` is required, and the executor always
// supplies it) but runNext throws while resolving the model for the
// `architect` step's role: the model-policy fixture below defines a profile
// whose `map` covers `review` but not `reasoning` (architecture-advisor's
// default capability, per DEFAULT_ACTIVITY_BY_ROLE) and has no `default`
// fallback — resolveModel (src/v2/model-resolution.ts) throws synchronously,
// uncaught inside runNext, which driveWorkflowItem's runNextFn try/catch
// (src/campaign/executor.ts) hands to parkCampaignOnDriveThrow. That parks
// the item at 'awaiting_gate' (not failed/blocked/infrastructure) — the
// shape a real `forge campaign resume` reattaches to and re-drives, so the
// bare resume guidance is correct here (unlike the startRun-throw shape
// above, which needs retry first).
function writeRunNextThrowWorkflow(): void {
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  const yaml = [
    "name: feature",
    "description: FG-490 reopen fixture — startRun succeeds; runNext throws resolving the model for `architect`.",
    "inputs:",
    "  - name: brief",
    "    required: true",
    "    type: text",
    "steps:",
    "  - id: architect",
    "    agent: architecture-advisor",
    "",
  ].join("\n");
  writeFileSync(join(projectDir, ".forge", "workflows", "feature.yml"), yaml);

  const policyYaml = [
    "schema_version: 2",
    "model_profiles:",
    "  main:",
    "    provider: anthropic",
    "    auth: subscription",
    "    map:",
    "      review:",
    "        model: claude-sonnet-4",
    "        cost_tier: standard",
    "defaults:",
    "  profile: main",
    "",
  ].join("\n");
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), policyYaml);
}

test("FG-490 reopen integ: campaign start --json (runNext-throw / awaiting_gate shape) guidance stays bare resume, not retry", () => {
  writeRunNextThrowWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const startResult = runForge(["campaign", "start", planOutput.campaignId, "--json"]);
  assert.notEqual(startResult.status, 0, "a drive-error must still exit non-zero");

  let parsed: { stopReason: string; ticketId?: string; runId?: string; error: string; guidance: string };
  assert.doesNotThrow(
    () => { parsed = JSON.parse(startResult.stdout); },
    `--json output must be parseable JSON, not a bare 'forge: ...' line\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  parsed = JSON.parse(startResult.stdout);
  assert.equal(parsed.stopReason, "drive_error");
  assert.equal(parsed.ticketId, "FG-101");
  assert.ok(parsed.runId, "runId must be derivable from the parked campaign item");
  assert.match(parsed.error, /has no mapping for capability 'reasoning'/, "error must carry the ORIGINAL runNext-path error");

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = ? AND campaign_id = ?")
    .get("FG-101", planOutput.campaignId) as { lifecycle_status: string; outcome: string | null; blocker_kind: string | null };
  db.close();
  assert.equal(item.lifecycle_status, "awaiting_gate", "runNext-throw must park at awaiting_gate, not the failed/blocked/infrastructure shape");

  assert.equal(
    parsed.guidance,
    `forge campaign resume ${planOutput.campaignId}`,
    "awaiting_gate parks reattach cleanly on resume — guidance must stay the bare resume command, not retry"
  );
});

