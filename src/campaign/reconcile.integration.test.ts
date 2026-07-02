// FG-428: integration coverage for reconcileCampaign against a real store DB.
// Covers: each of the 5 missing-evidence facts refuses with zero mutation, the
// all-evidence-present positive case (both starting lifecycle shapes), the
// spoofing guard, the not-paused guard, and an end-to-end unhold+resume proving
// the existing executor blockedItems rebuild picks up reconciled state for free.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { logEvent } from "../store/events.js";
import {
  approveCampaign,
  getCampaign,
  getCampaignItem,
  listCampaignItems,
} from "../store/campaigns.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { resumeCampaign } from "./executor.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { reconcileCampaign } from "./reconcile.js";
import { collectReconcileEvidence } from "./reconcile-collect.js";

// Same wrapper as executor.test.ts: forces executionMode:'invoke' for list-type
// campaigns so resumeCampaign's dispatch path is trivially mockable.
function planCampaign(input: PlannerInput, opts: { projectDir: string; mode?: PlanMode }) {
  if (input.kind === "list" && !input.itemOverrides) {
    const overrides = Object.fromEntries(
      input.ticketIds.map((id) => [id, { executionMode: "invoke" as const, agentRole: "engineer" }])
    );
    return _planCampaign({ ...input, itemOverrides: overrides }, opts);
  }
  return _planCampaign(input, opts);
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

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

function makeCommit(label: string): string {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "reconcile-integ-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function countEvents(): number {
  return (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
}

// Builds a single-item paused campaign whose item is scope-blocked (lifecycleStatus
// defaults to 'failed'). Returns the campaign id, item id and run id so tests can
// layer evidence (or deliberately withhold one fact) on top.
function setupBlockedCampaign(
  ticketId: string,
  opts: { lifecycleStatus?: "failed" | "blocked_by_red" } = {}
): { campaignId: string; itemId: string; runId: string } {
  // Stub ticket so the planner can resolve it — tests overwrite it with real
  // evidence (or deliberately withhold a fact) afterward.
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  const itemId = items[0]!.id;
  const runId = `run-${itemId}`;
  const lifecycleStatus = opts.lifecycleStatus ?? "failed";
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = ?, outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail', requested_human_action = 'inspect and resolve' WHERE id = ?"
  ).run(lifecycleStatus, runId, itemId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  return { campaignId: campaign.id, itemId, runId };
}

function seedAllEvidence(ticketId: string, runId: string): string {
  const commit = makeCommit(`impl-${ticketId}`);
  // closeTicket moves the file stories/ -> done/ atomically — writeTicket a second
  // time with status:'done' would leave the original stub behind as a duplicate.
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  return commit;
}

// ── campaign-level guard ────────────────────────────────────────────────────────

test("refuses a running (non-paused) campaign with zero items processed and zero mutation", () => {
  writeTicket(projectDir, { id: "FG-201", type: "story", status: "active", title: "t", body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-201"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id);

  const before = countEvents();
  const result = reconcileCampaign(campaign.id);

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not paused/);
  assert.deepEqual(result.items, []);
  assert.equal(countEvents(), before, "no event rows written");
});

test("concurrent flip: campaign leaves 'paused' between the up-front check and the atomic write — item is NOT mutated", () => {
  // reconcileCampaign checks campaign.status !== 'paused' once, up front. Real
  // concurrency (a second `forge` process running `campaign resume`) can flip that
  // status any time after. collectReconcileEvidence is a real per-item seam called
  // strictly after the up-front check and strictly before the guarded write, so
  // mutating the DB from inside it deterministically lands "another process's"
  // write in that exact gap — the same technique executor.test.ts's TOCTOU tests
  // use with `dispatch`.
  const ticketId = "FG-260";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);
  seedAllEvidence(ticketId, runId);

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const collectEvidence: typeof collectReconcileEvidence = (dir, item) => {
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
    return collectReconcileEvidence(dir, item);
  };

  const result = reconcileCampaign(campaignId, { collectEvidence });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /left 'paused'/);
  assert.deepEqual(result.items, [], "the item that lost the race must not be reported as shipped");
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical — zero mutation");
  assert.equal(countEvents(), beforeEvents, "no audit event logged for a write that never landed");
});

test("refuses an unknown campaign id", () => {
  const result = reconcileCampaign("campaign-does-not-exist");
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not found/);
  assert.deepEqual(result.items, []);
});

// ── 5 negative-evidence cases, each in isolation ────────────────────────────────

test("refuses when ticket.status !== 'done' — no state mutated", () => {
  const ticketId = "FG-210";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit("impl-210");
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", closedCommit: commit, title: ticketId, body: "" });
  insertHostVerification({ ticketId, projectDir, commitSha: commit, gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z" });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["ticket_status_not_done"]);

  const afterItem = getCampaignItem(itemId)!;
  assert.deepEqual(afterItem, beforeItem, "campaign_items row must be byte-identical after a refusal");
  assert.equal(countEvents(), beforeEvents, "no new event row written on refusal");
});

test("refuses when ticket.closedCommit is missing — no state mutated", () => {
  const ticketId = "FG-211";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  closeTicket(projectDir, ticketId);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.ok(result.items[0]!.missing!.includes("ticket_closed_commit_missing"));

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("refuses when closedCommit is not reachable on the base branch — no state mutated", () => {
  const ticketId = "FG-212";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  makeCommit("main-base-212");
  gitExec(["checkout", "-b", "feature/off-main-212"], projectDir);
  const offMainCommit = makeCommit("off-main-212");
  gitExec(["checkout", "main"], projectDir);

  closeTicket(projectDir, ticketId, offMainCommit);
  insertHostVerification({ ticketId, projectDir, commitSha: offMainCommit, gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z" });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["closed_commit_not_reachable_on_base_branch"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("refuses when host-verification is missing — no state mutated", () => {
  const ticketId = "FG-213";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit("impl-213");
  closeTicket(projectDir, ticketId, commit);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["host_verification_missing_or_not_all_exit_zero"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("refuses when there is no superseding pass or qualifying force-advance — no state mutated", () => {
  const ticketId = "FG-214";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit("impl-214");
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({ ticketId, projectDir, commitSha: commit, gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z" });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  // No later pass or qualifying force-advance.

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

// ── spoofing guard ───────────────────────────────────────────────────────────────

test("spoofing guard: a host_verifications row for the WRONG commit sha does not satisfy evidence", () => {
  const ticketId = "FG-215";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const realCommit = makeCommit("impl-215-real");
  closeTicket(projectDir, ticketId, realCommit);
  // Operator attempts to plant fake evidence under a sha that is NOT the ticket's actual closedCommit.
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "refused", "the query is keyed on the ticket's actual closedCommit, not any planted row");
  assert.deepEqual(result.items[0]!.missing, ["host_verification_missing_or_not_all_exit_zero"]);
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
});

// ── positive case: both starting lifecycle shapes ────────────────────────────────

for (const lifecycleStatus of ["failed", "blocked_by_red"] as const) {
  test(`all-evidence-present ships + logs exactly one event, from the '${lifecycleStatus}' starting shape`, () => {
    const ticketId = `FG-22${lifecycleStatus === "failed" ? "0" : "1"}`;
    const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId, { lifecycleStatus });
    seedAllEvidence(ticketId, runId);

    const beforeEvents = countEvents();
    const result = reconcileCampaign(campaignId, { decidedBy: "steve" });

    assert.equal(result.ok, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.status, "shipped");
    assert.equal(result.items[0]!.missing, undefined);

    const item = getCampaignItem(itemId)!;
    assert.equal(item.lifecycleStatus, "complete");
    assert.equal(item.outcome, "shipped");
    assert.equal(item.blockerKind, undefined);
    assert.equal(item.reason, undefined);
    assert.equal(item.requestedHumanAction, undefined);

    assert.equal(countEvents(), beforeEvents + 1, "exactly one new event row");
    const evRow = db
      .prepare("SELECT event_type, payload FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as { event_type: string; payload: string };
    assert.equal(evRow.event_type, "campaign_item.evidence_reconciled");
    const payload = JSON.parse(evRow.payload) as { ticketId: string; decidedBy: string; evidence: unknown };
    assert.equal(payload.ticketId, ticketId);
    assert.equal(payload.decidedBy, "steve");
    assert.ok(payload.evidence, "evidence must be embedded in the audit payload");
  });
}

// ── not_applicable items are reported and untouched ───────────────────────────────

test("items not blockerKind='scope' are reported not_applicable and untouched", () => {
  writeTicket(projectDir, { id: "FG-230", type: "story", status: "active", title: "t", body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-230"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'infrastructure' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  const beforeItem = getCampaignItem(items[0]!.id)!;
  const result = reconcileCampaign(campaign.id);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "not_applicable");
  assert.deepEqual(getCampaignItem(items[0]!.id)!, beforeItem);
});

// ── end-to-end: reconcile unblocks a downstream held item, resume proceeds ────────

test("end-to-end: reconciling a scope-blocked item unholds a downstream item and resumeCampaign proceeds to complete", async () => {
  const readyBody = "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n";
  writeTicket(projectDir, { id: "FG-240", type: "story", status: "active", title: "t1", body: readyBody });
  writeTicket(projectDir, { id: "FG-241", type: "story", status: "active", title: "t2", body: readyBody });
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-240", "FG-241"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved" });

  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string; ticket_id: string }[];
  const item1 = items.find((i) => i.ticket_id === "FG-240")!;
  const item2 = items.find((i) => i.ticket_id === "FG-241")!;
  const runId = `run-${item1.id}`;

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail' WHERE id = ?"
  ).run(runId, item1.id);
  // FG-241 held solely because of FG-240's failure (dependency-held, not readiness).
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = NULL, reason = 'held because dependency relation is unknown in sequential mode' WHERE id = ?"
  ).run(item2.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  seedAllEvidence("FG-240", runId);

  const reconcileResult = reconcileCampaign(campaign.id);
  assert.equal(reconcileResult.items.find((i) => i.ticketId === "FG-240")?.status, "shipped");

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch });

  assert.equal(resumeResult.stopReason, "complete", "campaign proceeds to complete once the blocker is reconciled");
  assert.deepEqual(dispatchLog, ["FG-241"], "FG-241 is dispatched — no longer held");

  const finalItem2 = getCampaignItem(item2.id)!;
  assert.notEqual(finalItem2.outcome, "held", "downstream item must no longer be held");
});
