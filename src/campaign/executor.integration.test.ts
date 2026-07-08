import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { insertHostVerification } from "../store/host-verifications.js";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import {
  createCampaign,
  getCampaign,
  addCampaignItem,
  getCampaignItem,
  approveCampaign,
  tryTransitionCampaignToRunning,
  updateCampaignStatus,
  setPlanHash,
} from "../store/campaigns.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { planCampaign as _planCampaign, computePlanHash, resolvePlan } from "./planner.js";
import type { PlannerInput, PlanMode, ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, escalateCampaignItemLane, retryCampaignItem } from "./executor.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { logEvent } from "../store/events.js";
import { listCampaignItems } from "../store/campaigns.js";
import { updateRunStatus, getRun, insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import type { StartRunArgs } from "../v2/startRun.js";
import { assembleReviewerContextPacket } from "../v2/reviewer-context-packet.js";

// All tests in this file use the invoke dispatch path (pre-FG-423 behavior).
// The wrapper forces executionMode:'invoke' for every list-type campaign without
// an explicit override so existing tests don't need per-call changes.
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

// FG-483: real git plumbing for the evidence eligibility executor.ts now
// requires (composeOutOfBandEligibility) — the pre-FG-483 fake "abc123"
// closedCommit string every test below used to fabricate a ship no longer
// passes checkClosedCommitReachableOnBase. Same gitExec pattern as
// reconcile.integration.test.ts.
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

// Real, reachable, non-code commit — satisfies composeOutOfBandEligibility's
// non_code_diff out-of-band lane (reconcile-outofband-collect.ts) with no
// host-verification row needed. Used everywhere a test only cares that an
// item ships, not about the code-vs-docs lane split (see
// fg483-quick-invoke-evidence-gate.integration.test.ts for that matrix).
function makeShipCommit(label: string): string {
  writeFileSync(join(projectDir, `${label.replace(/[^A-Za-z0-9_-]/g, "_")}-ship.md`), `${label} shipped`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `ship ${label}`], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

// Convenience wrapper for the common case: ship a ticket with a real,
// reachable, non-code commit in one call.
function shipTicket(ticketId: string): string {
  const commit = makeShipCommit(ticketId);
  closeTicket(projectDir, ticketId, commit);
  return commit;
}

// Real, reachable, CODE-touching commit + a covering passing host-verification
// row — satisfies composeOutOfBandEligibility's host_verification out-of-band
// lane, for lanes that touch real code (e.g. quick_implementation's
// engineer/test-engineer chain), as opposed to makeShipCommit/shipTicket's
// docs-only non_code_diff lane.
function shipTicketWithHostVerification(ticketId: string): string {
  const label = ticketId.replace(/[^A-Za-z0-9_-]/g, "_");
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", `${label}.ts`), `export const ${label} = 1;\n`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `feat: ${ticketId}`], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
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
  return commit;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "executor-unit-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

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

  // Base commit so the first makeShipCommit call has exactly one parent — a
  // root commit is ambiguous and safe-denies in commitTouchesOnlyNonCodePaths.
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function fakeDispatch(status: "complete" | "failed", error?: string) {
  return async (_args: InvokeArgs): Promise<InvokeResult> => ({
    runId: _args.runId ?? "run-fake",
    taskId: "task-fake",
    status,
    error,
  });
}

// Seeds a task.failed event with a concrete LOCAL failure kind so failureKindForTask
// returns a classifiable local kind (model_error → scope). Required by FG-412: without
// this seed, a returned-failed with no events → undefined → campaign_system (SHARED),
// which would hold the campaign rather than exercising the LOCAL-blocker policy.
function seedLocalFailure(taskId: string): void {
  logEvent("task.failed", { taskId, payload: { failure_kind: "model_error", error: "agent error" } });
}

// ── approveCampaign ───────────────────────────────────────────────────────────

test("approveCampaign records all four columns including approved_plan_hash", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });

  const ok = approveCampaign(campaign.id, { approvedBy: "operator@example.com", rationale: "Looks good" });
  assert.ok(ok, "approveCampaign must return true for a planned campaign");

  const approved = getCampaign(campaign.id)!;
  assert.equal(approved.approvedBy, "operator@example.com");
  assert.ok(approved.approvedAt, "approvedAt must be set");
  assert.equal(approved.approvalRationale, "Looks good");
  assert.equal(approved.approvedPlanHash, campaign.planHash, "approved_plan_hash must equal the campaign plan_hash");
});

test("approveCampaign refuses non-planned campaign (returns false)", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  // Transition to running via tryTransitionCampaignToRunning
  tryTransitionCampaignToRunning(campaign.id);

  const ok = approveCampaign(campaign.id, { rationale: "Too late" });
  assert.equal(ok, false, "approveCampaign must return false when not in planned state");
});

// ── tryTransitionCampaignToRunning ────────────────────────────────────────────

test("tryTransitionCampaignToRunning: first call true, second call false (single-process CAS proof)", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });

  const first = tryTransitionCampaignToRunning(campaign.id);
  assert.equal(first, true, "first tryTransitionCampaignToRunning must return true");

  const second = tryTransitionCampaignToRunning(campaign.id);
  assert.equal(second, false, "second tryTransitionCampaignToRunning must return false (already running)");

  const loaded = getCampaign(campaign.id)!;
  assert.equal(loaded.status, "running");
});

// ── start: unapproved ─────────────────────────────────────────────────────────

test("start refuses unapproved planned campaign with stop reason not_approved", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  // Do NOT approve

  let dispatchCallCount = 0;
  const fakeDispatchCounter = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatchCounter });
  assert.equal(result.stopReason, "not_approved");
  assert.equal(dispatchCallCount, 0, "dispatch must not be called for unapproved campaign");
});

// ── start: stale plan ─────────────────────────────────────────────────────────

test("start refuses stale plan with no dispatch and no run rows", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  approveCampaign(campaign.id, { rationale: "Approved before backlog mutation" });

  // Mutate backlog: add a new child story to FG-100 epic
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    created: "2024-01-03",
    body: "New story added after plan",
  });
  // Re-resolve from FG-101 explicit list — the hash will NOT change from list input
  // Use epic input instead where adding a child changes the hash
  // Actually campaign was planned with list input ["FG-101"], so let's use epic input for the stale test
  // Replan with epic input and mutate epic

  // Reset — plan with epic input
  const { campaign: epicCampaign } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir, mode: "sequential" });
  approveCampaign(epicCampaign.id, { rationale: "Approved" });

  // Now add another story to the epic — hash will differ
  writeTicket(projectDir, {
    id: "FG-104",
    type: "story",
    status: "active",
    title: "Story Four",
    epic: "FG-100",
    created: "2024-01-04",
    body: "Added after approval",
  });

  let dispatchCallCount = 0;
  const fakeDispatchCounter = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(epicCampaign.id, { dispatch: fakeDispatchCounter });
  assert.equal(result.stopReason, "stale_plan", "stale plan must return stale_plan stop reason");
  assert.equal(dispatchCallCount, 0, "dispatch must NOT be called for stale plan");

  // Assert no run rows were created
  const runs = db.prepare("SELECT COUNT(*) as count FROM runs").get() as { count: number };
  assert.equal(runs.count, 0, "no run rows must be created for stale plan");
});

// ── start: happy path two-item ────────────────────────────────────────────────

test("happy path two-item: sequential ordering, items dispatched one at a time", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatchLog: { ticketId: string; itemSnapshotBefore: string }[] = [];

  const fakeDispatchOrdered = async (args: InvokeArgs): Promise<InvokeResult> => {
    // Record the lifecycle status of ALL items at the time this dispatch is called
    const items = db.prepare("SELECT ticket_id, lifecycle_status FROM campaign_items ORDER BY item_order ASC").all() as { ticket_id: string; lifecycle_status: string }[];
    const snapshot = JSON.stringify(items.map((i) => `${i.ticket_id}:${i.lifecycle_status}`));
    dispatchLog.push({ ticketId: args.runTitle ?? "", itemSnapshotBefore: snapshot });
    // Simulate the agent shipping the ticket as part of completing the dispatch —
    // required for the item to reach lifecycleStatus 'complete' (FG-442 review Finding 1).
    if (args.runTitle) closeTicket(projectDir, args.runTitle, makeShipCommit(args.runTitle));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatchOrdered });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords.length, 2);
  assert.equal(dispatchLog.length, 2, "must dispatch exactly twice");

  // First dispatch: item1 running, item2 still pending
  const snap1Items = JSON.parse(dispatchLog[0]!.itemSnapshotBefore) as string[];
  assert.ok(snap1Items.some((s: string) => s.startsWith("FG-101:running")), "item1 must be running when dispatched");
  assert.ok(snap1Items.some((s: string) => s.startsWith("FG-102:pending")), "item2 must be pending when item1 dispatches");

  // Second dispatch: item1 complete, item2 running
  const snap2Items = JSON.parse(dispatchLog[1]!.itemSnapshotBefore) as string[];
  assert.ok(snap2Items.some((s: string) => s.startsWith("FG-101:complete")), "item1 must be complete before item2 dispatches");
  assert.ok(snap2Items.some((s: string) => s.startsWith("FG-102:running")), "item2 must be running when dispatched");

  // run_id must be set before dispatch (since we pre-allocate)
  assert.ok(result.itemRecords[0]!.runId, "item1 runId must be set");
  assert.ok(result.itemRecords[1]!.runId, "item2 runId must be set");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete");
});

// ── start: first-item failure ─────────────────────────────────────────────────

test("first-item failure (FG-393): item2 held (unknown relation, sequential), campaign paused", async () => {
  // FG-393: LOCAL blocker → continue; FG-101 has no related field → UNKNOWN relation,
  // sequential → hold_dependents → FG-102 held. Campaign → paused (held items await resume).
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const fakeDispatchFail = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "agent exploded" };
  };

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatchFail });
  assert.equal(result.stopReason, "paused", "FG-393: LOCAL blocker → campaign paused, not item_failed");
  assert.equal(callCount, 1, "dispatch must be called exactly once — item2 was held not dispatched");
  assert.equal(result.itemRecords.length, 2, "both items in records: item1 (blocked) + item2 (held)");

  const item1 = result.itemRecords[0]!;
  assert.equal(item1.lifecycleStatus, "failed");
  assert.equal(item1.outcome, "blocked", "FG-393: blocked outcome replaces failed");

  const item2 = result.itemRecords[1]!;
  assert.equal(item2.lifecycleStatus, "pending", "held items keep pending lifecycle");
  assert.equal(item2.outcome, "held");

  // Verify durable DB state
  const dbItem1 = db.prepare("SELECT lifecycle_status, outcome, blocker_kind, reason FROM campaign_items WHERE ticket_id = 'FG-101'").get() as {
    lifecycle_status: string; outcome: string; blocker_kind: string; reason: string;
  };
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.outcome, "blocked");
  assert.equal(dbItem1.blocker_kind, "scope", "model_error (seeded concrete local kind) → scope (LOCAL)");
  assert.equal(dbItem1.reason, "agent exploded");

  const dbItem2 = db.prepare("SELECT lifecycle_status, outcome, continue_policy, reason FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    lifecycle_status: string; outcome: string; continue_policy: string; reason: string;
  };
  assert.equal(dbItem2.lifecycle_status, "pending", "held item lifecycle stays pending");
  assert.equal(dbItem2.outcome, "held");
  assert.equal(dbItem2.continue_policy, "hold_dependents");
  assert.equal(dbItem2.reason, "held because dependency relation is unknown in sequential mode");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "FG-393: campaign paused (not failed) on LOCAL blocker");
});

// ── start: shipped evidence ───────────────────────────────────────────────────

test("FG-442 review Finding 1: complete but ticket not done → outcome undefined, item parks awaiting_gate, campaign pauses (not complete)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "paused", "campaign must not report complete when the ticket was never shipped");
  assert.equal(result.itemRecords[0]?.lifecycleStatus, "awaiting_gate");
  assert.equal(result.itemRecords[0]?.outcome, undefined, "outcome must be undefined when ticket is not done");
});

test("shipped with evidence: ticket done + a real reachable closedCommit (non_code_diff lane) → outcome='shipped'", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Pre-close the ticket so it looks done after dispatch — FG-483: the
  // closedCommit must be real and reachable on base (or eligibility refuses).
  shipTicket("FG-101");

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]?.outcome, "shipped", "outcome must be 'shipped' when ticket is done with a real, reachable closedCommit");
});

test("FG-483 negative (review F4 spoof shape): ticket done with a FABRICATED closedCommit (not a real commit) → outcome stays undefined, item parks awaiting_gate — today's frontmatter-only check would have shipped this", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Simulates an agent (or anyone with backlog write access) self-closing its
  // own ticket with a fabricated commit sha that was never actually committed —
  // the exact spoof the review flagged. checkClosedCommitReachableOnBase must
  // refuse this (git has no such commit), so eligibility must be ineligible.
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "done",
    title: "Story One",
    epic: "FG-100",
    created: "2024-01-01",
    closedCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    body: "## Problem\nStory One needs implementation.\n\n## Goal\nComplete story one.\n\n## Acceptance Criteria\n- Story one is complete\n",
  });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.notEqual(result.stopReason, "complete", "a fabricated closedCommit must never let the campaign report complete");
  assert.equal(result.itemRecords[0]?.lifecycleStatus, "awaiting_gate", "item must park awaiting_gate, not ship, on a fabricated closedCommit");
  assert.equal(result.itemRecords[0]?.outcome, undefined, "outcome must not be 'shipped' for a fabricated/unreachable closedCommit");

  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.outcome, undefined, "durable DB state must also show no shipped outcome");
});

// ── FG-433: campaign run.metadata drives the shipping-reviewer ticket-aware preflight ──

test("FG-433: a campaign-driven run's metadata.ticketId drives the shipping-reviewer's ticket-aware acceptance preflight (producer → consumer)", async () => {
  // PRODUCER: drive a real campaign item through the executor. Whichever invoke
  // lane it takes, the executor records ticketId/campaignId/itemId on run.metadata.
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });
  await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });

  const item = listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-101")!;
  assert.ok(item.runId, "the campaign drove the item to a real run");
  const run = getRun(item.runId!)!;
  // Producer half: the run carries the campaign context on run.metadata (FG-464).
  assert.equal(run.metadata?.["ticketId"], "FG-101", "executor populated run.metadata.ticketId");
  assert.equal(run.metadata?.["campaignId"], campaign.id, "executor populated run.metadata.campaignId");
  assert.equal(run.metadata?.["itemId"], item.id, "executor populated run.metadata.itemId");

  // CONSUMER half: the shipping-reviewer's context packet resolves the backlog
  // ticket FROM that run.metadata.ticketId → the preflight is ticket-aware.
  const packet = assembleReviewerContextPacket(item.runId!, "task-eng-fg433", projectDir);
  assert.ok(packet.backlog, "backlog ticket resolved from run.metadata.ticketId — the preflight is ticket-aware");
  assert.equal(packet.backlog!.id, "FG-101");
  assert.ok(packet.backlog!.acceptanceCriteria.includes("Story one is complete"), "the ticket's acceptance criteria are extracted for the reviewer");
  // No required backlogTicket missing → runNext.ts would NOT pre-fail the
  // shipping-reviewer for want of ticket context.
  assert.equal(
    packet.missingContext.filter((m) => m.field === "backlogTicket" && m.required).length,
    0,
    "ticket context present → the shipping-reviewer is not pre-failed for a missing ticket",
  );
});

test("FG-433: a run with NO metadata.ticketId leaves the preflight ticket-blind (shipping-reviewer would be pre-failed) — proves the metadata is load-bearing", async () => {
  // The negative half: without the campaign metadata population, the very same
  // consumer cannot resolve the ticket, and runNext.ts pre-fails the shipping-
  // reviewer. This is exactly what the FG-464 population prevents for campaign runs.
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });
  await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  const item = listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-101")!;

  // Simulate the pre-FG-464 shape: a run whose metadata lacks ticketId.
  updateRunStatus(item.runId!, "active"); // no-op status touch to keep the row live
  getDb().prepare("UPDATE runs SET metadata = ? WHERE id = ?").run(JSON.stringify({ campaignId: campaign.id }), item.runId!);

  const packet = assembleReviewerContextPacket(item.runId!, "task-eng-fg433", projectDir);
  assert.equal(packet.backlog, null, "no ticketId → no backlog resolution");
  assert.equal(
    packet.missingContext.filter((m) => m.field === "backlogTicket" && m.required).length,
    1,
    "missing required ticket context → runNext.ts pre-fails the shipping-reviewer",
  );
});

// ── start: projectDir persistence ─────────────────────────────────────────────

test("projectDir: persisted at plan time and used by startCampaign", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir }
  );

  const loaded = getCampaign(campaign.id)!;
  assert.ok(loaded.projectDir, "projectDir must be persisted at plan time");
  assert.ok(loaded.projectDir!.includes(projectDir.replace(/\\/g, "/")) || loaded.projectDir === projectDir,
    "stored projectDir must match the planned projectDir");
});

test("projectDir: legacy null → refuse with no_project_dir", async () => {
  // Create campaign directly (bypass planCampaign) with no projectDir
  const campaign = createCampaign({
    sourceKind: "list",
    sourceInput: { kind: "list", ticketIds: ["FG-101"] },
    mode: "dry_run",
  });
  // Give it a plan hash and approval so the only refusal is no_project_dir
  setPlanHash(campaign.id, "abc123");
  const ok = db.prepare("UPDATE campaigns SET approved_plan_hash = ? WHERE id = ?").run("abc123", campaign.id);
  assert.ok(ok);

  const result = await startCampaign(campaign.id);
  assert.equal(result.stopReason, "no_project_dir");
});

test("projectDir: non-existent dir → refuse with invalid_project_dir", async () => {
  const campaign = createCampaign({
    sourceKind: "list",
    sourceInput: { kind: "list", ticketIds: ["FG-101"] },
    mode: "dry_run",
    projectDir: "/nonexistent/path/that/does/not/exist",
  });
  setPlanHash(campaign.id, "abc123");
  db.prepare("UPDATE campaigns SET approved_plan_hash = ? WHERE id = ?").run("abc123", campaign.id);

  const result = await startCampaign(campaign.id);
  assert.equal(result.stopReason, "invalid_project_dir");
});

// ── approveCampaign: re-approval overwrites ───────────────────────────────────

test("approveCampaign: re-approval on planned campaign overwrites prior approval fields", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });

  const ok1 = approveCampaign(campaign.id, { approvedBy: "first@example.com", rationale: "First pass" });
  assert.ok(ok1, "first approval must return true");

  const ok2 = approveCampaign(campaign.id, { approvedBy: "second@example.com", rationale: "Second review" });
  assert.ok(ok2, "re-approval of planned campaign must return true");

  const after = getCampaign(campaign.id)!;
  assert.equal(after.approvedBy, "second@example.com", "re-approval must overwrite approvedBy");
  assert.equal(after.approvalRationale, "Second review", "re-approval must overwrite rationale");
  assert.equal(after.approvedPlanHash, campaign.planHash,
    "approvedPlanHash must still equal plan_hash after re-approval");
});

// ── precondition order ────────────────────────────────────────────────────────

test("precondition order: unapproved + stale campaign stops at not_approved (before stale_plan check)", async () => {
  // Plan with epic input so staleness can be induced by adding a child story.
  // Campaign is deliberately NOT approved — proving not_approved (pos 4) fires
  // before stale_plan (pos 5) when both conditions are true simultaneously.
  const { campaign } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir, mode: "sequential" });

  // Mutate backlog: add an active child under FG-100 to change the plan hash
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Staleness trigger",
    epic: "FG-100",
    created: "2024-01-03",
    body: "Added post-plan",
  });

  let dispatchCalled = 0;
  const countingDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCalled++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch: countingDispatch });
  assert.equal(result.stopReason, "not_approved",
    "must stop at not_approved, not stale_plan, even when plan is also stale");
  assert.equal(dispatchCalled, 0, "dispatch must not be called");
});

test("precondition order: existing dir with no backlog subdir → invalid_project_dir (before hash work)", async () => {
  // Dir exists but has no backlog/ subdir — invalid_project_dir (pos 3) must fire
  // before not_approved (pos 4) or stale_plan (pos 5).
  const noBacklogDir = mkdtempSync(join(tmpdir(), "executor-no-backlog-"));
  try {
    const campaign = createCampaign({
      sourceKind: "list",
      sourceInput: { kind: "list", ticketIds: ["FG-101"] },
      mode: "dry_run",
      projectDir: noBacklogDir,
    });
    // Set approved_plan_hash so not_approved is not the stop reason; we want invalid_project_dir.
    setPlanHash(campaign.id, "hash-nobacklog");
    db.prepare("UPDATE campaigns SET approved_plan_hash = 'hash-nobacklog' WHERE id = ?").run(campaign.id);

    const result = await startCampaign(campaign.id);
    assert.equal(result.stopReason, "invalid_project_dir",
      "dir with no backlog/ must return invalid_project_dir before any hash computation");
  } finally {
    rmSync(noBacklogDir, { recursive: true, force: true });
  }
});

// ── stale_plan: no state mutation ────────────────────────────────────────────

test("stale_plan: campaign status remains planned (not running) after stale stop", async () => {
  const { campaign } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Add a child story to make the plan stale after approval
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Stale trigger",
    epic: "FG-100",
    created: "2024-01-03",
    body: "Causes hash mismatch",
  });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "stale_plan");

  const after = getCampaign(campaign.id)!;
  assert.equal(after.status, "planned",
    "campaign must remain 'planned' after stale_plan stop — tryTransitionToRunning must NOT be called");
});

// ── no double-dispatch ────────────────────────────────────────────────────────

test("no double-dispatch: concurrent startCampaign calls, only one dispatch fn invoked", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });

  let firstDispatchCount = 0;
  let secondDispatchCount = 0;

  // Promise.all evaluates args left-to-right. First call runs all sync code (including
  // CAS which transitions campaign to 'running') before yielding at await dispatch.
  // Second call's sync section then reads campaign as 'running' → not_planned, no dispatch.
  const [result1, result2] = await Promise.all([
    startCampaign(campaign.id, {
      dispatch: async (args: InvokeArgs): Promise<InvokeResult> => {
        firstDispatchCount++;
        await Promise.resolve(); // yield so second call's sync section can run
        closeTicket(projectDir, "FG-101", makeShipCommit("FG-101"));
        return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
      },
    }),
    startCampaign(campaign.id, {
      dispatch: async (_args: InvokeArgs): Promise<InvokeResult> => {
        secondDispatchCount++;
        return { runId: "run-fake-2", taskId: "task-fake-2", status: "complete" };
      },
    }),
  ]);

  assert.equal(firstDispatchCount, 1, "first call must dispatch exactly once");
  assert.equal(secondDispatchCount, 0, "second call must never invoke its dispatch fn");
  assert.equal(result1.stopReason, "complete", "first call must complete");
  // In single-process JS, the second call's sync section runs after the first call's CAS and
  // the first item is set to lifecycleStatus='running' before the first dispatch awaits.
  // campaignBlocker checks in-flight items first (status-agnostic), so the second call
  // returns 'recovery_needed' rather than 'not_planned'. No dispatch is ever invoked.
  assert.equal(result2.stopReason, "recovery_needed",
    "second call blocked without dispatching (recovery_needed: in-flight item found before status check)");
});

// ── crash-recovery durability ─────────────────────────────────────────────────

test("crash-recovery: run_id + lifecycle=running in DB BEFORE dispatch returns; run_id retained after failure", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let midFlightRunId: string | null = null;
  let midFlightLifecycle: string | null = null;

  const fakeDispatchCrash = async (args: InvokeArgs): Promise<InvokeResult> => {
    // While dispatch is "executing", read the item row — run_id and lifecycle must already be set
    const row = db.prepare(
      "SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-101'"
    ).get() as { run_id: string | null; lifecycle_status: string } | undefined;
    if (row) {
      midFlightRunId = row.run_id;
      midFlightLifecycle = row.lifecycle_status;
    }
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "crash" };
  };

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatchCrash });
  // FG-393: returned-failed → LOCAL (scope); item2 is HELD → campaign paused
  assert.equal(result.stopReason, "paused", "FG-393: LOCAL failure → campaign paused");

  // Mid-flight durability: both must be written BEFORE dispatch resolves
  assert.ok(midFlightRunId, "run_id must be written to DB BEFORE dispatch resolves");
  assert.equal(midFlightLifecycle, "running",
    "lifecycle_status must be 'running' in DB BEFORE dispatch resolves");

  // Post-failure evidence: run_id retained so a human/tool can trace the failed run
  const dbItem1 = db.prepare(
    "SELECT run_id, lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { run_id: string | null; lifecycle_status: string; outcome: string; blocker_kind: string };
  assert.ok(dbItem1.run_id, "run_id must be retained in DB after item failure (crash-recovery evidence)");
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.outcome, "blocked", "FG-393: outcome=blocked for failed items");
  assert.equal(dbItem1.blocker_kind, "scope", "model_error (seeded concrete local kind) → scope (LOCAL)");

  // item2 was held (pending, not dispatched)
  const dbItem2 = db.prepare(
    "SELECT run_id, lifecycle_status, outcome FROM campaign_items WHERE ticket_id = 'FG-102'"
  ).get() as { run_id: string | null; lifecycle_status: string; outcome: string };
  assert.equal(dbItem2.run_id, null, "item2 run_id must be null — never dispatched (held)");
  assert.equal(dbItem2.lifecycle_status, "pending", "item2 must remain pending (held lifecycle stays pending)");
  assert.equal(dbItem2.outcome, "held", "FG-393: item2 held due to unknown dependency relation in sequential mode");
});

// ── projectDir: stale-plan check always uses campaign.projectDir ──────────────

test("stale-plan check: mutating a DIFFERENT directory does not affect the hash check", async () => {
  // Plan and approve against projectDir
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Create a separate dir with its own tickets — mutating this must NOT affect hash for projectDir
  const otherDir = mkdtempSync(join(tmpdir(), "executor-other-"));
  try {
    writeTicket(otherDir, {
      id: "FG-999",
      type: "story",
      status: "active",
      title: "Story in other dir",
      body: "should not affect the hash check for projectDir",
      created: "2024-01-01",
    });

    // startCampaign has no projectDirOverride — it always uses campaign.projectDir.
    // Mutating otherDir does NOT make the plan stale for the original projectDir.
    closeTicket(projectDir, "FG-101", makeShipCommit("FG-101"));
    const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
    assert.equal(
      result.stopReason,
      "complete",
      "plan must NOT be considered stale — only campaign.projectDir is used for hash recomputation"
    );
  } finally {
    rmSync(otherDir, { recursive: true, force: true });
  }
});

// ── shipped: done ticket without closedCommit ─────────────────────────────────

test("FG-442 review Finding 1: ticket done but no closedCommit → outcome undefined, item parks awaiting_gate, campaign pauses (not complete)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Write ticket as done WITHOUT a closedCommit — must not produce 'shipped' outcome
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "done",
    title: "Story One",
    epic: "FG-100",
    created: "2024-01-01",
    body: "## Problem\nStory One needs implementation.\n\n## Goal\nComplete story one.\n\n## Acceptance Criteria\n- Story one is complete\n",
    // closedCommit deliberately absent
  });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "paused", "campaign must not report complete when the ticket has no closedCommit");
  assert.equal(result.itemRecords[0]?.lifecycleStatus, "awaiting_gate");
  assert.equal(
    result.itemRecords[0]?.outcome,
    undefined,
    "outcome must be undefined when ticket is done but has no closedCommit"
  );
});

// ── Fix A: dry_run mode refusal ───────────────────────────────────────────────

test("dry_run mode: startCampaign returns dry_run_not_executable, no dispatch, campaign stays planned", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "dry_run" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCallCount = 0;
  const countingDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch: countingDispatch });
  assert.equal(result.stopReason, "dry_run_not_executable");
  assert.equal(dispatchCallCount, 0, "dispatch must not be called for dry_run campaign");

  const after = getCampaign(campaign.id)!;
  assert.equal(after.status, "planned", "campaign must remain planned after dry_run refusal (no CAS transition)");
});

test("pilot mode: startCampaign proceeds to dispatch (mode gate only blocks dry_run)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "pilot" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCallCount = 0;
  const countingDispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch: countingDispatch });
  assert.notEqual(result.stopReason, "dry_run_not_executable");
  assert.equal(dispatchCallCount, 1, "dispatch must be called for pilot campaign");
});

test("sequential mode: startCampaign proceeds to dispatch (mode gate only blocks dry_run)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCallCount = 0;
  const countingDispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch: countingDispatch });
  assert.notEqual(result.stopReason, "dry_run_not_executable");
  assert.equal(dispatchCallCount, 1, "dispatch must be called for sequential campaign");
});

// ── Fix B: dispatch throws → same failure path as returned failure ────────────

test("dispatch throws (FG-393): SHARED infrastructure blocker, campaign paused, item2 pending (not held)", async () => {
  // FG-393: throw → infrastructure (SHARED) → hold_campaign → campaign paused.
  // Remaining items stay pending (loop stops immediately for SHARED blockers).
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const throwingDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    throw new Error("network timeout");
  };

  const result = await startCampaign(campaign.id, { dispatch: throwingDispatch });
  assert.equal(result.stopReason, "paused", "FG-393: throw (SHARED) → campaign paused");
  assert.equal(callCount, 1, "dispatch must be called exactly once — item2 must never dispatch after throw");
  assert.equal(result.itemRecords.length, 1, "only item1 in records — SHARED stops loop immediately");

  const item1 = result.itemRecords[0]!;
  assert.equal(item1.lifecycleStatus, "failed");
  assert.equal(item1.outcome, "blocked", "FG-393: outcome=blocked for SHARED failed items");

  // Durable DB state
  const dbItem1 = db.prepare(
    "SELECT run_id, lifecycle_status, outcome, blocker_kind, reason FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { run_id: string | null; lifecycle_status: string; outcome: string; blocker_kind: string; reason: string };
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.outcome, "blocked");
  assert.equal(dbItem1.blocker_kind, "infrastructure", "throw → infrastructure (SHARED)");
  assert.equal(dbItem1.reason, "network timeout", "thrown error message must be stored as reason");
  assert.ok(dbItem1.run_id, "run_id must be retained in DB after thrown dispatch (evidence preserved)");

  // item2 not dispatched, not held (SHARED stops loop before evaluating item2)
  const dbItem2 = db.prepare(
    "SELECT run_id, lifecycle_status, outcome FROM campaign_items WHERE ticket_id = 'FG-102'"
  ).get() as { run_id: string | null; lifecycle_status: string; outcome: string | null };
  assert.equal(dbItem2.run_id, null, "item2 run_id must be null — never dispatched");
  assert.equal(dbItem2.lifecycle_status, "pending", "item2 must remain pending (SHARED stops before hold evaluation)");
  assert.equal(dbItem2.outcome, null, "item2 outcome must be null — untouched by SHARED stop");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "FG-393: campaign paused (not failed) on SHARED blocker");
});

// ── Fix 2: pre-allocated run closed on thrown dispatch ─────────────────────────

test("Fix 2: dispatch throws → pre-allocated Run row is not left 'active'", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const throwingDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    throw new Error("infrastructure failure");
  };

  await startCampaign(campaign.id, { dispatch: throwingDispatch });

  const runRow = db.prepare("SELECT status FROM runs WHERE title = 'FG-101'").get() as { status: string } | undefined;
  assert.ok(runRow, "a run row must exist for the dispatched item");
  assert.notEqual(runRow!.status, "active", "run must not be left 'active' after thrown dispatch");
});

// ── FG-394: driver skips terminal items ────────────────────────────────────────

test("driver skips terminal items: item1 complete, item2 pending — only item2 dispatched", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Manually mark item1 as complete before start (simulating a previous run)
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    if (args.runTitle) closeTicket(projectDir, args.runTitle, makeShipCommit(args.runTitle));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete");
  assert.equal(dispatchLog.length, 1, "only one dispatch (item2)");
  assert.equal(dispatchLog[0], "FG-102", "only item2 (FG-102) was dispatched");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete");
});

// ── FG-394: cooperative pause ─────────────────────────────────────────────────

test("cooperative pause: external pause after item1 — driver stops, does NOT dispatch item2, does NOT attempt complete", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // After item1 dispatches, simulate an external pause
    if (callCount === 1) {
      db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    }
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "driver must return 'paused' when campaign was paused mid-run");
  assert.equal(callCount, 1, "only item1 dispatched — item2 never dispatched");

  // Campaign must remain paused (not complete)
  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must stay paused — no illegal paused->complete transition");

  // item2 must never have been dispatched
  const item2 = db.prepare("SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    run_id: string | null; lifecycle_status: string;
  };
  assert.equal(item2.run_id, null, "item2 must not have a run_id");
  assert.equal(item2.lifecycle_status, "pending", "item2 must remain pending");
});

// ── FG-394: resume ────────────────────────────────────────────────────────────

test("resumeCampaign: transitions paused->running, skips completed item1, dispatches item2, completes", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Simulate: item1 completed in a previous run, campaign was then paused
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    if (args.runTitle) closeTicket(projectDir, args.runTitle, makeShipCommit(args.runTitle));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await resumeCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete");
  assert.equal(dispatchLog.length, 1, "only item2 dispatched (item1 was already complete)");
  assert.equal(dispatchLog[0], "FG-102", "item2 (FG-102) dispatched by resume");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete");
});

test("resumeCampaign: refuses non-paused campaign with 'not_paused'", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCalled = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCalled++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  // Campaign is still 'planned' — not paused
  const result = await resumeCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "not_paused");
  assert.equal(dispatchCalled, 0, "dispatch must not be called for non-paused campaign");
});

test("resumeCampaign: refuses stale plan (same protection as startCampaign)", async () => {
  const { campaign } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  // Add a new story to make the plan stale
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    created: "2024-01-03",
    body: "Added after approval",
  });

  const result = await resumeCampaign(campaign.id, { dispatch: async (_args: InvokeArgs) => ({ runId: "r", taskId: "t", status: "complete" as const }) });
  assert.equal(result.stopReason, "stale_plan");
});

// ── FG-394: pause/resume/abandon legal and illegal transitions ─────────────────

test("updateCampaignStatus pause: running->paused is legal", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(campaign.id);
  assert.doesNotThrow(() => updateCampaignStatus(campaign.id, "paused"));
  assert.equal(getCampaign(campaign.id)!.status, "paused");
});

test("updateCampaignStatus pause: planned->paused is ILLEGAL — clean Error, not a crash", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  assert.throws(
    () => updateCampaignStatus(campaign.id, "paused"),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw an Error instance");
      assert.ok(err.message.includes("Illegal") || err.message.includes("transition"),
        `error message must reference transition: ${err.message}`);
      return true;
    }
  );
  // Campaign must remain planned
  assert.equal(getCampaign(campaign.id)!.status, "planned");
});

test("updateCampaignStatus abandon: planned/running/paused->abandoned is legal", () => {
  // planned -> abandoned
  const { campaign: c1 } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  assert.doesNotThrow(() => updateCampaignStatus(c1.id, "abandoned"));
  assert.equal(getCampaign(c1.id)!.status, "abandoned");

  // running -> abandoned
  const { campaign: c2 } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(c2.id);
  assert.doesNotThrow(() => updateCampaignStatus(c2.id, "abandoned"));
  assert.equal(getCampaign(c2.id)!.status, "abandoned");

  // paused -> abandoned
  const { campaign: c3 } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(c3.id);
  updateCampaignStatus(c3.id, "paused");
  assert.doesNotThrow(() => updateCampaignStatus(c3.id, "abandoned"));
  assert.equal(getCampaign(c3.id)!.status, "abandoned");
});

test("updateCampaignStatus abandon: complete->abandoned is ILLEGAL", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");
  assert.throws(() => updateCampaignStatus(campaign.id, "abandoned"), /Illegal|transition/i);
  assert.equal(getCampaign(campaign.id)!.status, "complete");
});

test("updateCampaignStatus abandon: failed->abandoned is ILLEGAL", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "failed");
  assert.throws(() => updateCampaignStatus(campaign.id, "abandoned"), /Illegal|transition/i);
  assert.equal(getCampaign(campaign.id)!.status, "failed");
});

test("updateCampaignStatus abandon: abandoned->abandoned is ILLEGAL (double-abandon)", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  updateCampaignStatus(campaign.id, "abandoned");
  assert.throws(() => updateCampaignStatus(campaign.id, "abandoned"), /Illegal|transition/i);
});

// ── FG-394: pause-during-failing-item (transition-safety failing path) ──────────

test("pause-during-failing-item: driver returns 'paused', NOT 'item_failed', campaign stays paused, item2 not dispatched", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // External pause happens DURING item1's execution; item1 still fails
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "agent failed under pause" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  // Must return 'paused', NOT 'item_failed' — campaign was paused before the failed transition
  assert.equal(result.stopReason, "paused", "driver must return paused, not item_failed, when campaign paused during failing item");
  assert.equal(callCount, 1, "only item1 dispatched");

  // Campaign must stay paused — the running->failed transition must NOT have been attempted
  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must stay paused — no running->failed when already paused");

  // item2 must never have been dispatched
  const item2 = db.prepare("SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    run_id: string | null; lifecycle_status: string;
  };
  assert.equal(item2.run_id, null, "item2 must not have a run_id — never dispatched");
  assert.equal(item2.lifecycle_status, "pending", "item2 must remain pending");
});

test("pause-during-failing-item: dispatch throws AND campaign paused → returns paused, not item_failed", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // Pause the campaign and then throw — tests the throw handler under paused state
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    throw new Error("dispatch threw under pause");
  };

  const result = await startCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "paused", "dispatch throw under paused → driver returns paused, not item_failed");
  assert.equal(callCount, 1, "only item1 dispatched");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must stay paused — no running->failed on throw when paused");

  const item2 = db.prepare("SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    run_id: string | null; lifecycle_status: string;
  };
  assert.equal(item2.run_id, null, "item2 not dispatched after throw under pause");
  assert.equal(item2.lifecycle_status, "pending", "item2 remains pending");
});

// ── FG-394: pre-dispatch pause (preCheck fires, zero dispatches for item) ────────

test("pre-dispatch pause: item2 precheck sees paused after item1 completes → item2 not dispatched", async () => {
  // Tests the pre-dispatch check (line 95 in executor.ts): when a 3-item campaign has
  // item1=complete (skipped), item2=pending, item3=pending, and campaign is paused during
  // item2's dispatch (returning complete), item2's postCheck fires, returns 'paused',
  // item3's preCheck NEVER fires (zero additional dispatches).
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Pre-mark item1 as complete — skipped by driver
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // item2 dispatch: pause campaign, return complete
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "paused");
  assert.equal(callCount, 1, "only item2 dispatched — item1 skipped (complete), preCheck for item3 never fires");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign stays paused");
});

// ── FG-394: skip terminal 3-item (item1=complete, item2=failed, item3=pending) ────

test("skip terminal 3-item: item1=complete, item2=failed, item3=pending → ONLY item3 dispatched", async () => {
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    created: "2024-01-03",
    body: "## Problem\nStory Three needs implementation.\n\n## Goal\nComplete story three.\n\n## Acceptance Criteria\n- Story three is complete\n",
  });
  writeTicket(projectDir, {
    id: "FG-100",
    type: "epic",
    status: "active",
    title: "Test Epic",
    related: ["FG-101", "FG-102", "FG-103"],
    body: "",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102", "FG-103"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Pre-mark item1=complete, item2=failed
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'failed', blocker_kind = 'campaign_system' WHERE id = ?").run(items[1]!.id);

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    if (args.runTitle) closeTicket(projectDir, args.runTitle, makeShipCommit(args.runTitle));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete");
  assert.equal(dispatchLog.length, 1, "only one dispatch (item3)");
  assert.equal(dispatchLog[0], "FG-103", "only item3 (FG-103) was dispatched");

  // item1 and item2 must not have been re-processed
  const dbItem1 = db.prepare("SELECT lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-101'").get() as { lifecycle_status: string };
  assert.equal(dbItem1.lifecycle_status, "complete", "item1 must remain complete (not re-run)");

  const dbItem2 = db.prepare("SELECT lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'").get() as { lifecycle_status: string };
  assert.equal(dbItem2.lifecycle_status, "failed", "item2 must remain failed (not re-run)");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete");
});

// ── FG-394: edge — pause landing exactly after the LAST item ─────────────────────

test("edge: pause after last item — campaign stays paused, item parks awaiting_gate (CAS lost the race), subsequent resume ships it via the FG-441 reattach path and transitions to complete", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // item1 dispatch: pause campaign, then return complete (simulates cooperative pause
  // landing exactly after the last item's execution, racing the evidence-eligibility
  // check finalizeInvokeLaneOutcome performs immediately after dispatch returns)
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    closeTicket(projectDir, "FG-101", makeShipCommit("FG-101"));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  // Driver must return 'paused' — no illegal-transition throw (not complete)
  assert.equal(result.stopReason, "paused", "driver must return paused when last item completes under pause");

  // Campaign must be paused, not complete (the finalCheck was skipped because postCheck returned early)
  const afterPause = getCampaign(campaign.id)!;
  assert.equal(afterPause.status, "paused", "campaign must be paused with all items complete");

  // FG-483: the evidence eligibility check found real evidence (the ticket really is
  // done with a reachable closedCommit), but the campaign-running-gated CAS
  // (updateCampaignItemIfCampaignRunning) lost the race — the pause landed between
  // the check and the write — so this must be a no-op, never an optimistic ship.
  // The item parks at awaiting_gate (the SAME shape the FG-441 reattach branch
  // recognizes), never silently left at 'running'.
  const dbItem1 = db.prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-101'").get() as {
    lifecycle_status: string; outcome: string | null; blocker_kind: string | null;
  };
  assert.equal(dbItem1.lifecycle_status, "awaiting_gate", "item must park awaiting_gate — CAS loss must never leave an optimistic 'complete'");
  assert.notEqual(dbItem1.outcome, "shipped", "outcome must not be 'shipped' when the campaign-running CAS was lost");
  assert.equal(dbItem1.blocker_kind, null, "no blockerKind — this is the out-of-band shape the FG-441 reattach branch expects");

  // Subsequent resume: item1 is awaiting_gate with a runId and no blockerKind — the
  // FG-441 reattach branch re-evaluates the SAME evidence (now genuinely eligible,
  // no race) and ships it directly, without calling dispatch again.
  let resumeDispatchCount = 0;
  const resumeDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    resumeDispatchCount++;
    return { runId: "run-resume", taskId: "task-resume", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeDispatch });
  assert.equal(resumeResult.stopReason, "complete", "resume must reach complete via the FG-441 reattach evidence path");
  assert.equal(resumeDispatchCount, 0, "resume must not dispatch anything — the reattach path ships directly from evidence");

  const afterResume = getCampaign(campaign.id)!;
  assert.equal(afterResume.status, "complete", "campaign must transition to complete after resume");

  const finalItem1 = listCampaignItems(campaign.id)[0]!;
  assert.equal(finalItem1.lifecycleStatus, "complete", "item1 must be complete after the reattach-path ship");
  assert.equal(finalItem1.outcome, "shipped", "item1 outcome must be 'shipped' after the reattach-path ship");
});

// ── FG-394: illegal pause transitions ────────────────────────────────────────────

test("updateCampaignStatus pause: paused->paused is ILLEGAL (double-pause)", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");
  assert.throws(
    () => updateCampaignStatus(campaign.id, "paused"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(/Illegal|transition/i.test(err.message));
      return true;
    }
  );
  assert.equal(getCampaign(campaign.id)!.status, "paused", "campaign must remain paused after illegal double-pause attempt");
});

test("updateCampaignStatus pause: complete->paused is ILLEGAL", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "complete");
  assert.throws(() => updateCampaignStatus(campaign.id, "paused"), /Illegal|transition/i);
  assert.equal(getCampaign(campaign.id)!.status, "complete");
});

test("updateCampaignStatus pause: failed->paused is ILLEGAL", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "failed");
  assert.throws(() => updateCampaignStatus(campaign.id, "paused"), /Illegal|transition/i);
  assert.equal(getCampaign(campaign.id)!.status, "failed");
});

test("updateCampaignStatus pause: abandoned->paused is ILLEGAL", () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
  updateCampaignStatus(campaign.id, "abandoned");
  assert.throws(() => updateCampaignStatus(campaign.id, "paused"), /Illegal|transition/i);
  assert.equal(getCampaign(campaign.id)!.status, "abandoned");
});

// ── FG-394: abandoned-during-dispatch ────────────────────────────────────────────

test("abandoned-during-succeeding-item: driver returns 'abandoned', item2 not dispatched, campaign stays abandoned", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // External abandon during item1's execution
    db.prepare("UPDATE campaigns SET status = 'abandoned' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "abandoned", "driver must return abandoned when campaign abandoned during item");
  assert.equal(callCount, 1, "only item1 dispatched");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "abandoned", "campaign must stay abandoned");

  const item2 = db.prepare("SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    run_id: string | null; lifecycle_status: string;
  };
  assert.equal(item2.run_id, null, "item2 not dispatched after abandon");
  assert.equal(item2.lifecycle_status, "pending", "item2 remains pending");
});

// ── TOCTOU: atomic CAS prevents illegal transitions when concurrent pause races the terminal write ──

test("TOCTOU success/complete path: dispatch pauses right before terminal transition — returns paused, no illegal complete written", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Dispatch pauses campaign right before returning complete — simulates concurrent pause
  // landing at the moment the driver would write the terminal 'complete' transition.
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  let threw = false;
  let result: Awaited<ReturnType<typeof startCampaign>>;
  try {
    result = await startCampaign(campaign.id, { dispatch });
  } catch {
    threw = true;
    result = { stopReason: "complete", itemRecords: [] }; // dummy to satisfy TS
  }

  assert.equal(threw, false, "driver must NOT throw even when concurrent pause races the complete transition");
  assert.equal(result.stopReason, "paused", "driver must return paused, not complete, when campaign was paused concurrently");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must stay paused — no illegal paused->complete written");
});

test("TOCTOU failure path: dispatch pauses right before terminal transition — returns paused, no illegal failed written", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // Pause right before returning the failure — simulates concurrent pause racing the failed transition
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "agent error" };
  };

  let threw = false;
  let result: Awaited<ReturnType<typeof startCampaign>>;
  try {
    result = await startCampaign(campaign.id, { dispatch });
  } catch {
    threw = true;
    result = { stopReason: "item_failed", itemRecords: [] };
  }

  assert.equal(threw, false, "driver must NOT throw even when concurrent pause races the failed transition");
  assert.equal(result.stopReason, "paused", "driver must return paused, not item_failed, when campaign paused concurrently");
  assert.equal(callCount, 1, "only item1 dispatched — item2 never reached");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must stay paused — no illegal paused->failed written");

  const item2 = db.prepare("SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    run_id: string | null; lifecycle_status: string;
  };
  assert.equal(item2.run_id, null, "item2 must not have been dispatched");
  assert.equal(item2.lifecycle_status, "pending", "item2 must remain pending");
});

test("TOCTOU failure path via throw: dispatch pauses AND throws — returns paused, no illegal failed written", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    throw new Error("thrown under pause");
  };

  let threw = false;
  let result: Awaited<ReturnType<typeof startCampaign>>;
  try {
    result = await startCampaign(campaign.id, { dispatch });
  } catch {
    threw = true;
    result = { stopReason: "item_failed", itemRecords: [] };
  }

  assert.equal(threw, false, "driver must NOT throw even when dispatch throws under concurrent pause");
  assert.equal(result.stopReason, "paused", "throw under concurrent pause → paused, not item_failed");
  assert.equal(callCount, 1, "only item1 dispatched");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must stay paused — no illegal transition written");
});

// ── last-item pause boundary ──────────────────────────────────────────────────────────────────────

test("last-item pause boundary: pause lands after final item completes — driver returns paused, item parks awaiting_gate (CAS lost the race), subsequent resume ships it via the FG-441 reattach path and reaches complete", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    closeTicket(projectDir, "FG-101", makeShipCommit("FG-101"));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "driver must return paused (NOT complete) when last item done but campaign paused");

  const afterPause = getCampaign(campaign.id)!;
  assert.equal(afterPause.status, "paused", "campaign must be paused, not complete");

  // FG-483: real evidence existed, but the campaign-running-gated CAS lost the
  // race (pause landed between the evidence check and the write) — must be a
  // no-op, never an optimistic ship. Parks awaiting_gate for the FG-441
  // reattach branch to finish, never silently left at 'running'.
  const dbItem = db.prepare("SELECT lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-101'").get() as { lifecycle_status: string };
  assert.equal(dbItem.lifecycle_status, "awaiting_gate", "item must park awaiting_gate — CAS loss must never leave an optimistic 'complete'");

  // Resume: item1 is awaiting_gate/no blockerKind/runId set — the FG-441 reattach
  // branch re-evaluates the SAME evidence (now genuinely eligible) and ships it.
  let resumeDispatched = 0;
  const resumeDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    resumeDispatched++;
    return { runId: "run-resume", taskId: "t", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeDispatch });
  assert.equal(resumeResult.stopReason, "complete", "resume must reach complete via the FG-441 reattach evidence path");
  assert.equal(resumeDispatched, 0, "resume must not dispatch anything — the reattach path ships directly from evidence");

  const afterResume = getCampaign(campaign.id)!;
  assert.equal(afterResume.status, "complete", "campaign must be complete after resume");
});

// ── FG-394-fix: recovery_needed — EXACT repro ─────────────────────────────────

test("FG-394-fix EXACT repro: paused campaign with running item — resumeCampaign returns recovery_needed, campaign stays paused, no dispatch", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Simulate: item1 stuck in 'running' (driver died mid-item), campaign paused
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-123' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  let dispatchCallCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await resumeCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "recovery_needed", "must return recovery_needed for in-flight item");
  assert.equal(dispatchCallCount, 0, "must NOT dispatch any item");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must STAY paused (not become complete)");

  // The stuck item must remain unchanged
  const stuckItem = db.prepare("SELECT lifecycle_status, run_id FROM campaign_items WHERE ticket_id = 'FG-101'").get() as { lifecycle_status: string; run_id: string };
  assert.equal(stuckItem.lifecycle_status, "running", "stuck item must remain running — not marked complete or failed");
  assert.equal(stuckItem.run_id, "run-stuck-123", "stuck item run_id must be unchanged");

  // itemRecords must identify the in-flight item with its run_id
  assert.equal(result.itemRecords.length, 1);
  assert.equal(result.itemRecords[0]!.ticketId, "FG-101");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "running");
  assert.equal(result.itemRecords[0]!.runId, "run-stuck-123");
});

// ── FG-394-fix: recovery_needed — all in-flight states ────────────────────────

const IN_FLIGHT_STATES = ["running", "awaiting_gate", "awaiting_red", "blocked_by_red"] as const;

for (const inflightStatus of IN_FLIGHT_STATES) {
  test(`FG-394-fix: paused campaign with item lifecycleStatus='${inflightStatus}' → recovery_needed, campaign stays paused`, async () => {
    const { campaign } = planCampaign(
      { kind: "list", ticketIds: ["FG-101"] },
      { projectDir, mode: "sequential" }
    );
    approveCampaign(campaign.id, { rationale: "Approved" });

    const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
    db.prepare("UPDATE campaign_items SET lifecycle_status = ?, run_id = 'run-inflight-test' WHERE id = ?").run(inflightStatus, items[0]!.id);
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

    let dispatched = 0;
    const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
      dispatched++;
      return { runId: "r", taskId: "t", status: "complete" };
    };

    const result = await resumeCampaign(campaign.id, { dispatch });
    assert.equal(result.stopReason, "recovery_needed", `in-flight status '${inflightStatus}' must trigger recovery_needed`);
    assert.equal(dispatched, 0, `must not dispatch when item is '${inflightStatus}'`);

    const after = getCampaign(campaign.id)!;
    assert.equal(after.status, "paused", `campaign must stay paused for in-flight status '${inflightStatus}'`);

    assert.equal(result.itemRecords[0]!.runId, "run-inflight-test", "itemRecords must expose run_id");
    assert.equal(result.itemRecords[0]!.lifecycleStatus, inflightStatus);
  });
}

// ── FG-394-fix: unknown/future status value — pre-flight must still catch it ──

test("FG-394-fix: paused campaign with item lifecycleStatus='unknown_future_value' (not in TaskStatus) → recovery_needed, campaign stays paused", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  // Force a value that is not in the TaskStatus union — bypasses TS type system via raw SQL
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'unknown_future_value', run_id = 'run-unknown-test' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  let dispatched = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatched++;
    return { runId: "r", taskId: "t", status: "complete" };
  };

  const result = await resumeCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "recovery_needed", "unknown/future status must trigger recovery_needed");
  assert.equal(dispatched, 0, "must not dispatch for unknown status");

  const after = getCampaign(campaign.id)!;
  assert.equal(after.status, "paused", "campaign must stay paused for unknown status");
  assert.equal(result.itemRecords[0]!.runId, "run-unknown-test", "itemRecords must expose run_id");
});

// ── FG-394-fix: clean resume — complete+pending, no in-flight ─────────────────

test("FG-394-fix: clean paused campaign (some complete, rest pending, no in-flight) resumes normally to complete", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // item1: safe-terminal (complete); item2: pending (dispatchable)
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    if (args.runTitle) closeTicket(projectDir, args.runTitle, makeShipCommit(args.runTitle));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await resumeCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete", "clean resume must reach complete");
  assert.equal(dispatchLog.length, 1, "only pending item dispatched (complete item skipped)");
  assert.equal(dispatchLog[0], "FG-102", "only FG-102 (pending) dispatched");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete");
});

// ── FG-394-fix: driver defensive — in-flight item mid-list ────────────────────

test("FG-394-fix driver defensive: in-flight item mid-list — driver stops recovery_needed, campaign does NOT become complete", async () => {
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    created: "2024-01-03",
    body: "## Problem\nStory Three needs implementation.\n\n## Goal\nComplete story three.\n\n## Acceptance Criteria\n- Story three is complete\n",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102", "FG-103"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Pre-set: item1=complete (safe-terminal), item2=running (in-flight), item3=pending
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-mid' WHERE id = ?").run(items[1]!.id);
  // item3 remains pending

  let dispatchCallCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "recovery_needed", "driver must return recovery_needed for in-flight mid-list item");
  assert.equal(dispatchCallCount, 0, "dispatch must NOT be called — item3 never reached");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.notEqual(finalCampaign.status, "complete", "campaign must NOT be complete after recovery_needed stop");
  assert.notEqual(finalCampaign.status, "failed", "campaign must NOT be failed after recovery_needed stop");

  // item3 must remain pending (never dispatched)
  const dbItem3 = db.prepare("SELECT lifecycle_status, run_id FROM campaign_items WHERE ticket_id = 'FG-103'").get() as { lifecycle_status: string; run_id: string | null };
  assert.equal(dbItem3.lifecycle_status, "pending", "item3 must remain pending");
  assert.equal(dbItem3.run_id, null, "item3 must have no run_id");

  // item2 must be unchanged
  const dbItem2 = db.prepare("SELECT lifecycle_status, run_id FROM campaign_items WHERE ticket_id = 'FG-102'").get() as { lifecycle_status: string; run_id: string };
  assert.equal(dbItem2.lifecycle_status, "running", "item2 must remain running (driver must not modify it)");
  assert.equal(dbItem2.run_id, "run-stuck-mid", "item2 run_id must be unchanged");

  // itemRecords must identify the in-flight item
  assert.equal(result.itemRecords.length, 1);
  assert.equal(result.itemRecords[0]!.ticketId, "FG-102");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "running");
  assert.equal(result.itemRecords[0]!.runId, "run-stuck-mid");
});

// ── FG-394-fix: startCampaign pre-flight — planned campaign with in-flight item ─

test("FG-394-fix: startCampaign pre-flight — planned campaign with in-flight item → recovery_needed, campaign stays planned (not running)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Corrupt the planned campaign: force item1 into 'running' (e.g. prior driver died mid-item)
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-planned' WHERE id = ?").run(items[0]!.id);
  // Campaign remains 'planned' — no CAS has happened

  let dispatchCallCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "recovery_needed", "pre-flight must return recovery_needed for in-flight item");
  assert.equal(dispatchCallCount, 0, "must not dispatch when in-flight item exists");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "planned", "campaign must stay planned — pre-flight fires before CAS to running");

  assert.equal(result.itemRecords.length, 1);
  assert.equal(result.itemRecords[0]!.ticketId, "FG-101");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "running");
  assert.equal(result.itemRecords[0]!.runId, "run-stuck-planned");
});

// ════════════════════════════════════════════════════════════════════════════════
// FG-393: conservative campaign blocker & continue semantics
// ════════════════════════════════════════════════════════════════════════════════

// Helper: write a ticket with explicit related field (body is ready: has Problem/Goal/AC sections)
function writeLinkedTicket(dir: string, id: string, related: string[]) {
  writeTicket(dir, {
    id,
    type: "story",
    status: "active",
    title: `Ticket ${id}`,
    related,
    body: `## Problem\n${id} needs implementation.\n\n## Goal\nComplete ${id}.\n\n## Acceptance Criteria\n- ${id} is done\n`,
    created: "2024-01-10",
  });
}

// FG-412: uncategorized failure → SHARED (conservative direction)
test("FG-412: uncategorized failure (no task events → undefined kind) → campaign_system (SHARED), campaign paused, item2 pending", async () => {
  // An uncategorized/unrecorded failure must HOLD the campaign, never continue past it.
  // The fix: undefined (no terminal event) → campaign_system (SHARED) in classifyFailureKind.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // Deliberately NO seedLocalFailure call — no task events seeded for this task ID.
    // failureKindForTask("task-uncategorized") → undefined → campaign_system (SHARED).
    return { runId: args.runId ?? "run-fake", taskId: "task-uncategorized", status: "failed", error: "uncategorized failure" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "FG-412: uncategorized failure → SHARED → campaign paused");
  assert.equal(callCount, 1, "only item1 dispatched — SHARED stops loop immediately");
  assert.equal(result.itemRecords.length, 1, "only item1 in records (SHARED stops before evaluating item2)");

  const dbItem1 = db.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind, continue_policy FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { lifecycle_status: string; outcome: string; blocker_kind: string; continue_policy: string };
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.outcome, "blocked");
  assert.equal(dbItem1.blocker_kind, "campaign_system", "FG-412: uncategorized failure → campaign_system (SHARED), not scope");
  assert.equal(dbItem1.continue_policy, "hold_campaign");

  const dbItem2 = db.prepare(
    "SELECT lifecycle_status, outcome FROM campaign_items WHERE ticket_id = 'FG-102'"
  ).get() as { lifecycle_status: string; outcome: string | null };
  assert.equal(dbItem2.lifecycle_status, "pending", "item2 must remain pending (SHARED stops loop immediately)");
  assert.equal(dbItem2.outcome, null, "item2 must have no outcome (untouched by SHARED stop)");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign paused on uncategorized failure");
});

// FG-412: explicit 'unknown' failure_kind is also SHARED — same conservative hold as undefined
test("FG-412: explicit failure_kind='unknown' → campaign_system (SHARED), campaign paused, item2 NOT dispatched", async () => {
  // task.failed with failure_kind='unknown' is an old/generic failure record that can't be positively
  // identified as a LOCAL agent failure. Must HOLD the campaign (SHARED), not continue past it.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    // Explicitly seed failure_kind='unknown' — classifyFailureKind("unknown") must return campaign_system (SHARED).
    logEvent("task.failed", { taskId: "task-explicit-unknown", payload: { failure_kind: "unknown", error: "unclassified" } });
    return { runId: args.runId ?? "run-fake", taskId: "task-explicit-unknown", status: "failed", error: "unclassified" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "FG-412: failure_kind='unknown' → SHARED → campaign paused (conservative hold)");
  assert.equal(callCount, 1, "item2 must NOT be dispatched — 'unknown' is SHARED, stops loop immediately");
  assert.equal(result.itemRecords.length, 1, "only item1 in records (SHARED stops before evaluating item2)");

  const dbItem1 = db.prepare(
    "SELECT blocker_kind, continue_policy, outcome FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { blocker_kind: string; continue_policy: string; outcome: string };
  assert.equal(dbItem1.blocker_kind, "campaign_system", "FG-412: 'unknown' → campaign_system (SHARED), must NOT be scope");
  assert.equal(dbItem1.continue_policy, "hold_campaign");
  assert.equal(dbItem1.outcome, "blocked");

  const dbItem2 = db.prepare(
    "SELECT lifecycle_status, outcome FROM campaign_items WHERE ticket_id = 'FG-102'"
  ).get() as { lifecycle_status: string; outcome: string | null };
  assert.equal(dbItem2.lifecycle_status, "pending", "item2 stays pending — SHARED stops loop before evaluating item2");
  assert.equal(dbItem2.outcome, null, "item2 has no outcome — never reached");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign paused on 'unknown' failure (conservative SHARED hold)");
});

// FG-475: a full_feature item's run reached terminal 'complete' with no authoritative
// verdict ever recorded (reconcileTerminalOutcome's 'unresolved' branch) because its
// only task was gate-rejected — mirrors campaign-e89beee993ec (FG-425's architect gate
// rejected). Before the fix this unconditionally defaulted to blockerKind:'campaign_system'
// (SHARED), pausing the whole campaign for what is actually a LOCAL, per-item failure.
const FEATURE_WORKFLOW_STUB = () => ({
  name: "feature",
  description: "",
  inputs: [],
  steps: [{ id: "architect", agent: "architect", runtime: "claude" as const, depends_on: [], gate: "human" as const, reds: [], manual: false }],
});

test("FG-475: gate-rejected terminal run resolves via classifyFailureKind('gate_rejected') -> blockerKind 'scope' (LOCAL), not campaign_system (SHARED)", async () => {
  const { campaign } = _planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const runId = "run-fg475-gate-reject";
  insertRun({ id: runId, workflow: "feature", title: "FG-101", status: "complete", createdAt: "2026-01-01T00:00:00Z" });
  insertTask({
    id: "task-fg475-architect",
    runId,
    phase: "architect",
    agentRole: "architect",
    status: "failed",
    taskPackage: { taskId: "task-fg475-architect", runId, phase: "architect", role: "architect", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-01-01T00:00:01Z",
  });
  // Mirrors evidence: the campaign item's lifecycle_status stayed 'awaiting_gate' —
  // the run went terminal without the item ever being reconciled.
  const items = listCampaignItems(campaign.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', run_id = ? WHERE id = ?").run(runId, items[0]!.id);

  // A gate-reject event (no on_reject) — this is what the operator's manual reject produced.
  logEvent("task.failed", { runId, taskId: "task-fg475-architect", payload: { failure_kind: "gate_rejected", error: "gate rejected by operator" } });

  const result = await resumeCampaign(campaign.id, {
    loadWorkflowFn: FEATURE_WORKFLOW_STUB,
    runNextFn: async () => {
      throw new Error("runNextFn must not be called — the run is already terminal");
    },
  });

  const dbItem = db.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { lifecycle_status: string; outcome: string; blocker_kind: string };
  assert.equal(dbItem.lifecycle_status, "failed");
  assert.equal(dbItem.outcome, "blocked");
  assert.equal(dbItem.blocker_kind, "scope", "FG-475: gate_rejected -> scope (LOCAL), never campaign_system");

  // scope is a LOCAL blocker — must not pause the whole campaign for this single item.
  assert.notEqual(result.stopReason, "paused", "FG-475: a LOCAL blocker must not pause the whole campaign like SHARED does");
});

test("FG-475: terminal run with NO failed primary task (unclassifiable) still falls back to campaign_system (SHARED) — regression guard", async () => {
  const { campaign } = _planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const runId = "run-fg475-no-primary";
  insertRun({ id: runId, workflow: "feature", title: "FG-101", status: "complete", createdAt: "2026-01-01T00:00:00Z" });
  // Deliberately NO task rows for this run — tasksForRun(runId) is empty, so there is
  // no failed primary task to classify. Must fall back to the conservative default.
  const items = listCampaignItems(campaign.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', run_id = ? WHERE id = ?").run(runId, items[0]!.id);

  const result = await resumeCampaign(campaign.id, {
    loadWorkflowFn: FEATURE_WORKFLOW_STUB,
    runNextFn: async () => {
      throw new Error("runNextFn must not be called — the run is already terminal");
    },
  });

  const dbItem = db.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { lifecycle_status: string; outcome: string; blocker_kind: string };
  assert.equal(dbItem.lifecycle_status, "failed");
  assert.equal(dbItem.outcome, "blocked");
  assert.equal(dbItem.blocker_kind, "campaign_system", "FG-475: no failed primary task found -> conservative campaign_system fallback preserved");
  assert.equal(result.stopReason, "paused", "FG-475: campaign_system is SHARED — must still pause the whole campaign");
});

test("FG-475: mixed failed primaries (earlier SHARED + later gate_rejected LOCAL) -> SHARED wins, never downgrades to scope", async () => {
  const { campaign } = _planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "Approved" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const runId = "run-fg475-mixed-primaries";
  insertRun({ id: runId, workflow: "feature", title: "FG-101", status: "complete", createdAt: "2026-01-01T00:00:00Z" });
  // Earlier failed primary: a container_crash -> classifies to infrastructure (SHARED).
  insertTask({
    id: "task-fg475-mixed-earlier",
    runId,
    phase: "architect",
    agentRole: "architect",
    status: "failed",
    taskPackage: { taskId: "task-fg475-mixed-earlier", runId, phase: "architect", role: "architect", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-01-01T00:00:01Z",
  });
  logEvent("task.failed", { runId, taskId: "task-fg475-mixed-earlier", payload: { failure_kind: "container_crash", error: "container crashed" } });

  // Later failed primary (retry): gate_rejected -> classifies to scope (LOCAL).
  insertTask({
    id: "task-fg475-mixed-later",
    runId,
    phase: "architect",
    agentRole: "architect",
    status: "failed",
    taskPackage: { taskId: "task-fg475-mixed-later", runId, phase: "architect", role: "architect", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-01-01T00:00:02Z",
  });
  logEvent("task.failed", { runId, taskId: "task-fg475-mixed-later", payload: { failure_kind: "gate_rejected", error: "gate rejected by operator" } });

  const items = listCampaignItems(campaign.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', run_id = ? WHERE id = ?").run(runId, items[0]!.id);

  const result = await resumeCampaign(campaign.id, {
    loadWorkflowFn: FEATURE_WORKFLOW_STUB,
    runNextFn: async () => {
      throw new Error("runNextFn must not be called — the run is already terminal");
    },
  });

  const dbItem = db.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { lifecycle_status: string; outcome: string; blocker_kind: string };
  assert.equal(dbItem.lifecycle_status, "failed");
  assert.equal(dbItem.outcome, "blocked");
  assert.equal(
    dbItem.blocker_kind,
    "campaign_system",
    "FG-475: an earlier SHARED failed primary must not be downgraded to scope by a later LOCAL gate_rejected"
  );
  assert.equal(result.stopReason, "paused", "FG-475: SHARED-wins must still pause the whole campaign");
});

// Test 1: dependent relation holds later item in SEQUENTIAL
test("FG-393 T1: dependent relation holds later item in SEQUENTIAL (outcome=held, correct reason)", async () => {
  writeLinkedTicket(projectDir, "FG-201", ["FG-202"]);
  writeLinkedTicket(projectDir, "FG-202", []);

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-201", "FG-202"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");
  assert.equal(callCount, 1, "only FG-201 dispatched");

  const dbItem2 = db.prepare("SELECT outcome, continue_policy, reason FROM campaign_items WHERE ticket_id = 'FG-202'").get() as {
    outcome: string; continue_policy: string; reason: string;
  };
  assert.equal(dbItem2.outcome, "held");
  assert.equal(dbItem2.continue_policy, "hold_dependents");
  assert.equal(dbItem2.reason, "held because related to blocked item FG-201", "exact reason string required");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused");
});

// Test 2: dependent relation ALSO holds in PILOT
test("FG-393 T2: dependent relation holds later item in PILOT (pilot must NOT override known dependency)", async () => {
  writeLinkedTicket(projectDir, "FG-211", ["FG-212"]);
  writeLinkedTicket(projectDir, "FG-212", []);

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-211", "FG-212"] },
    { projectDir, mode: "pilot" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");
  assert.equal(callCount, 1, "only FG-211 dispatched — known dependency still holds in pilot");

  const dbItem2 = db.prepare("SELECT outcome, reason FROM campaign_items WHERE ticket_id = 'FG-212'").get() as {
    outcome: string; reason: string;
  };
  assert.equal(dbItem2.outcome, "held", "pilot must NOT override known dependency");
  assert.equal(dbItem2.reason, "held because related to blocked item FG-211");
});

// Test 3: unknown relation holds in SEQUENTIAL
test("FG-393 T3: unknown relation holds in SEQUENTIAL (reason is exact string)", async () => {
  // FG-101 and FG-102 from beforeEach have no related field → unknown relation
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");
  assert.equal(callCount, 1, "only FG-101 dispatched");

  const dbItem2 = db.prepare("SELECT outcome, reason FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    outcome: string; reason: string;
  };
  assert.equal(dbItem2.outcome, "held");
  assert.equal(dbItem2.reason, "held because dependency relation is unknown in sequential mode");
});

// Test 4: unknown relation CONTINUES in PILOT
test("FG-393 T4: unknown relation CONTINUES in PILOT (later item dispatches)", async () => {
  // FG-101 and FG-102 have no related field → unknown; pilot → continue_allowed
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "pilot" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const ticketId = args.runTitle ?? "";
    dispatchLog.push(ticketId);
    // FG-101 fails (LOCAL → model_error → scope); FG-102 should still be dispatched
    if (ticketId === "FG-101") {
      seedLocalFailure("task-fake");
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
    }
    closeTicket(projectDir, ticketId, makeShipCommit(ticketId));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  // FG-102 dispatched and completed → no held items → campaign complete
  assert.equal(result.stopReason, "complete", "pilot + unknown → continue_allowed → campaign completes");
  assert.deepEqual(dispatchLog, ["FG-101", "FG-102"], "both items dispatched in pilot mode");

  const dbItem2 = db.prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    lifecycle_status: string; outcome: string | null;
  };
  assert.equal(dbItem2.lifecycle_status, "complete", "FG-102 completed (continued in pilot)");
  assert.notEqual(dbItem2.outcome, "held", "FG-102 must NOT be held in pilot with unknown relation");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete");
});

// Test 5: explicit INDEPENDENT relation continues
test("FG-393 T5: explicit INDEPENDENT relation continues (reason is exact string)", async () => {
  // FG-301 has related=[FG-399] (not FG-302), so FG-301 is INDEPENDENT of FG-302
  writeLinkedTicket(projectDir, "FG-301", ["FG-399"]);
  writeLinkedTicket(projectDir, "FG-302", []);
  writeTicket(projectDir, { id: "FG-399", type: "story", status: "active", title: "Unrelated", body: "", created: "2024-01-10" });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-301", "FG-302"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const ticketId = args.runTitle ?? "";
    dispatchLog.push(ticketId);
    if (ticketId === "FG-301") {
      seedLocalFailure("task-fake");
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
    }
    closeTicket(projectDir, ticketId, makeShipCommit(ticketId));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete", "independent → continue_allowed → campaign completes");
  assert.deepEqual(dispatchLog, ["FG-301", "FG-302"], "both items dispatched");

  const dbItem2 = db.prepare("SELECT lifecycle_status, outcome, reason FROM campaign_items WHERE ticket_id = 'FG-302'").get() as {
    lifecycle_status: string; outcome: string | null; reason: string | null;
  };
  assert.equal(dbItem2.lifecycle_status, "complete");
  assert.notEqual(dbItem2.outcome, "held");
  // exact reason string required (set before dispatch, preserved after complete)
  assert.equal(dbItem2.reason, "continued because related metadata does not link to blocked item", "exact reason string for independent-continued item");
});

// Test 6: SHARED/system blocker holds the whole campaign
test("FG-393 T6: SHARED system blocker (throw) pauses campaign, remaining pending untouched", async () => {
  // Throw → infrastructure (SHARED) → hold_campaign → campaign paused, item2 stays pending
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    throw new Error("container crash");
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "SHARED blocker → campaign paused");
  assert.equal(callCount, 1, "only item1 dispatched");
  assert.equal(result.itemRecords.length, 1, "only blocked item in records (item2 untouched)");

  const dbItem1 = db.prepare("SELECT lifecycle_status, outcome, blocker_kind, continue_policy FROM campaign_items WHERE ticket_id = 'FG-101'").get() as {
    lifecycle_status: string; outcome: string; blocker_kind: string; continue_policy: string;
  };
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.outcome, "blocked");
  assert.equal(dbItem1.blocker_kind, "infrastructure");
  assert.equal(dbItem1.continue_policy, "hold_campaign");

  const dbItem2 = db.prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    lifecycle_status: string; outcome: string | null;
  };
  assert.equal(dbItem2.lifecycle_status, "pending", "item2 must remain pending (untouched by SHARED stop)");
  assert.equal(dbItem2.outcome, null, "item2 must have no outcome (untouched)");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused");
});

// Test 7: held item preserved with clear reason AND report/show surfaces it
test("FG-393 T7: held item preserved with clear reason; report/show surfaces grouping + reason + next action", async () => {
  const { assembleCampaignShow, assembleCampaignReport } = await import("./report.js");

  // FG-101 (no related) fails → FG-102 held (unknown, sequential)
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  await startCampaign(campaign.id, { dispatch });

  // Verify show
  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show.nextAction.includes("resolve") || show.nextAction.includes("resume"), `nextAction should guide operator, got: ${show.nextAction}`);
  const heldInShow = show.items.find((i) => i.ticketId === "FG-102");
  assert.ok(heldInShow, "FG-102 must appear in show items");
  assert.equal(heldInShow!.outcome, "held");
  assert.ok(heldInShow!.reason, "held item must have a reason");

  // Verify report
  const report = assembleCampaignReport(campaign.id)!;
  assert.ok(report.groupings.held.includes("FG-102"), "FG-102 must appear in held grouping");
  assert.ok(report.groupings.blocked.includes("FG-101"), "FG-101 must appear in blocked grouping");
  assert.notEqual(report.verdict, "all_shipped", "campaign with held/blocked items must not be all_shipped");
  assert.ok(report.nextOperatorAction.includes("resolve") || report.nextOperatorAction.includes("resume"), `nextOperatorAction must guide operator, got: ${report.nextOperatorAction}`);
});

// Test 8: manual resume after blocker resolution reconsiders held items
test("FG-393 T8: resume after blocker resolution reconsiders held items, dispatches them, reaches complete", async () => {
  // Setup: campaign with FG-101 (blocked → no related, sequential → FG-102 held)
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Phase 1: run until FG-101 fails and FG-102 is held
  const phase1Dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };
  const runResult = await startCampaign(campaign.id, { dispatch: phase1Dispatch });
  assert.equal(runResult.stopReason, "paused", "Phase 1: campaign should be paused");

  // Verify FG-102 is held
  const itemsBefore = db.prepare("SELECT id, ticket_id, lifecycle_status, outcome FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string; ticket_id: string; lifecycle_status: string; outcome: string | null }[];
  const item1Before = itemsBefore.find((i) => i.ticket_id === "FG-101")!;
  const item2Before = itemsBefore.find((i) => i.ticket_id === "FG-102")!;
  assert.equal(item1Before.lifecycle_status, "failed");
  assert.equal(item2Before.outcome, "held", "FG-102 must be held before resolution");

  // Phase 2: "Resolve" the blocker — operator marks FG-101 as complete (no longer outcome=blocked)
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(item1Before.id);

  // Phase 3: resume — FG-101 is now complete (not in blockedItems) → FG-102 reconsidered
  const dispatchLog: string[] = [];
  const phase3Dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    if (args.runTitle) closeTicket(projectDir, args.runTitle, makeShipCommit(args.runTitle));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch: phase3Dispatch });
  assert.equal(resumeResult.stopReason, "complete", "Resume must reach complete after blocker resolved");
  assert.deepEqual(dispatchLog, ["FG-102"], "Only FG-102 dispatched on resume (FG-101 already terminal)");

  const dbItem2After = db.prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE ticket_id = 'FG-102'").get() as {
    lifecycle_status: string; outcome: string | null;
  };
  assert.equal(dbItem2After.lifecycle_status, "complete", "FG-102 must be complete after resume");
  assert.notEqual(dbItem2After.outcome, "held", "FG-102 must no longer be held after resume");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete");
});

// Test 9a: FG-393 does not regress FG-394 — recovery_needed still refuses
test("FG-393/FG-394 no-regression: recovery_needed still refuses (in-flight item)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaign.id) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-393' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  let dispatched = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatched++;
    return { runId: "r", taskId: "t", status: "complete" };
  };

  const result = await resumeCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "recovery_needed", "recovery_needed must still fire for in-flight items");
  assert.equal(dispatched, 0, "must not dispatch when in-flight item exists");
  assert.equal(getCampaign(campaign.id)!.status, "paused", "campaign must stay paused");
});

// Test 9b: FG-393 — held item with multiple blockers: any hold → stays held
test("FG-393: item M stays held if ANY prior blocker still holds it", async () => {
  // FG-401 (no related) fails first → FG-402 held (unknown, sequential)
  // FG-403 (independent of FG-401 via related) dispatches and also fails
  // FG-402 should still be held (FG-401 still blocking)
  writeLinkedTicket(projectDir, "FG-401", ["FG-999"]);  // FG-401 has related=[FG-999], independent of FG-402/FG-403
  writeLinkedTicket(projectDir, "FG-402", []);            // no related → unknown vs any blocker
  writeLinkedTicket(projectDir, "FG-403", ["FG-999"]);   // independent of FG-401 (both have related but no link)
  writeTicket(projectDir, { id: "FG-999", type: "story", status: "active", title: "Other", body: "", created: "2024-01-10" });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-401", "FG-402", "FG-403"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const ticketId = args.runTitle ?? "";
    dispatchLog.push(ticketId);
    // FG-401: independent of FG-402 (FG-401.related=[FG-999], no link to FG-402) → FG-402 should be UNKNOWN (FG-401 has non-empty related, no link to FG-402 → independent → continue)
    // Wait, actually: FG-401 has related=[FG-999]. FG-402 has no related.
    // relationToBlocked(FG-401, FG-402): FG-401.related includes FG-402? No. FG-402.related includes FG-401? No.
    // FG-401.related is non-empty → INDEPENDENT.
    // So FG-402 is independent → continue_allowed → dispatch FG-402.
    // Then FG-402 dispatches... Let's have FG-402 also fail.
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  await startCampaign(campaign.id, { dispatch });

  // FG-401 and FG-402 both failed (LOCAL), FG-403 evaluated against both blockers
  // FG-403 has related=[FG-999]: independent of FG-401 → continue_allowed from FG-401
  // FG-403 has related=[FG-999]: independent of FG-402 (FG-402 has no related → unknown → sequential → hold_dependents from FG-402)
  // ANY hold → FG-403 held
  const dbItem3 = db.prepare("SELECT outcome, reason FROM campaign_items WHERE ticket_id = 'FG-403'").get() as {
    outcome: string; reason: string;
  };
  assert.equal(dbItem3.outcome, "held", "FG-403 must be held because FG-402 (unknown relation, sequential) holds it");
});

// ── FG-393 AC-completeness: blocked item continuePolicy ───────────────────────

test("FG-393 AC: LOCAL blocked item records continuePolicy='hold_dependents'; SHARED records 'hold_campaign'", async () => {
  // LOCAL blocker must record continuePolicy='hold_dependents' (Fix 1).
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  await startCampaign(campaign.id, { dispatch });

  const dbItem = db.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind, continue_policy FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { lifecycle_status: string; outcome: string; blocker_kind: string; continue_policy: string | null };

  assert.equal(dbItem.lifecycle_status, "failed");
  assert.equal(dbItem.outcome, "blocked");
  assert.equal(dbItem.blocker_kind, "scope");
  assert.equal(dbItem.continue_policy, "hold_dependents", "LOCAL blocked item must record continuePolicy='hold_dependents'");
});

// ── FG-393 extended reason strings ───────────────────────────────────────────

test("FG-393 T4-reason: pilot-continued item has exact reason string 'continued because relation unknown and mode=pilot'", async () => {
  // FG-101 and FG-102 have no related field → unknown relation; pilot mode → continue_allowed.
  // The reason set on the continued item before dispatch must be the exact string.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "pilot" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const ticketId = args.runTitle ?? "";
    if (ticketId === "FG-101") {
      seedLocalFailure("task-fake");
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
    }
    closeTicket(projectDir, ticketId, makeShipCommit(ticketId));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete", "pilot + unknown → continue_allowed → campaign completes");

  const dbItem2 = db.prepare(
    "SELECT lifecycle_status, reason FROM campaign_items WHERE ticket_id = 'FG-102'"
  ).get() as { lifecycle_status: string; reason: string | null };

  assert.equal(dbItem2.lifecycle_status, "complete");
  assert.equal(
    dbItem2.reason,
    "continued because relation unknown and mode=pilot",
    "exact reason string for pilot-continued item (unknown relation, mode=pilot)"
  );
});

// ── FG-393 multi-blocker v2: two local blocks, dependent held, independent of both continues ────

test("FG-393 multi-blocker v2: two local blocks; item dependent on first held; item independent of BOTH continues", async () => {
  // 4 items in order: FG-501 (fails), FG-502 (fails), FG-503 (held — dep on FG-501), FG-504 (continues — independent of both)
  // FG-501.related=["FG-503","FG-599"]: links FG-503 as dependent; FG-504 is unlinked → independent of FG-501.
  // FG-502.related=["FG-596"]: non-empty, no link to FG-503 or FG-504 → FG-503 is independent of FG-502; FG-504 is independent of FG-502.
  // FG-503.related=[]: no outgoing links; but FG-501.related includes FG-503 → dependent relation → HELD.
  // FG-504.related=[]: independent of both FG-501 and FG-502 (both have non-empty related that omit FG-504) → continues.
  writeTicket(projectDir, { id: "FG-599", type: "story", status: "active", title: "Dummy 599", body: "", created: "2024-01-10" });
  writeTicket(projectDir, { id: "FG-596", type: "story", status: "active", title: "Dummy 596", body: "", created: "2024-01-10" });
  writeLinkedTicket(projectDir, "FG-501", ["FG-503", "FG-599"]);
  writeLinkedTicket(projectDir, "FG-502", ["FG-596"]);
  writeLinkedTicket(projectDir, "FG-503", []);
  writeLinkedTicket(projectDir, "FG-504", []);

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-501", "FG-502", "FG-503", "FG-504"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const ticketId = args.runTitle ?? "";
    dispatchLog.push(ticketId);
    if (ticketId === "FG-501" || ticketId === "FG-502") {
      seedLocalFailure("task-fake");
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
    }
    closeTicket(projectDir, ticketId, makeShipCommit(ticketId));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  // FG-503 is held → anyHeld=true → campaign paused
  assert.equal(result.stopReason, "paused", "campaign pauses because FG-503 is held");
  assert.deepEqual(
    dispatchLog,
    ["FG-501", "FG-502", "FG-504"],
    "FG-503 held (not dispatched); FG-504 independent-of-both dispatched"
  );

  // FG-503 must be held due to FG-501 (dependent relation via FG-501.related)
  const dbItem503 = db.prepare(
    "SELECT outcome, continue_policy, reason FROM campaign_items WHERE ticket_id = 'FG-503'"
  ).get() as { outcome: string; continue_policy: string; reason: string };
  assert.equal(dbItem503.outcome, "held", "FG-503 must be held (dependent on FG-501)");
  assert.equal(dbItem503.continue_policy, "hold_dependents");
  assert.equal(
    dbItem503.reason,
    "held because related to blocked item FG-501",
    "exact reason: FG-503 held due to FG-501"
  );

  // FG-504 must have completed (independent of both blockers) and the continue reason
  // must not falsely name only the last blocker (FG-502).
  const dbItem504 = db.prepare(
    "SELECT lifecycle_status, outcome, reason FROM campaign_items WHERE ticket_id = 'FG-504'"
  ).get() as { lifecycle_status: string; outcome: string | null; reason: string | null };
  assert.equal(dbItem504.lifecycle_status, "complete", "FG-504 must complete (independent of both local blockers)");
  assert.notEqual(dbItem504.outcome, "held", "FG-504 must NOT be held");
  assert.ok(
    dbItem504.reason && !dbItem504.reason.includes("FG-501") && !dbItem504.reason.includes("FG-502"),
    `multi-blocker continue reason must not name only the last blocker (FG-502); got: ${dbItem504.reason}`
  );

  // Both FG-501 and FG-502 must be blocked
  const dbItem501 = db.prepare(
    "SELECT outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-501'"
  ).get() as { outcome: string; blocker_kind: string };
  const dbItem502 = db.prepare(
    "SELECT outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-502'"
  ).get() as { outcome: string; blocker_kind: string };
  assert.equal(dbItem501.outcome, "blocked");
  assert.equal(dbItem502.outcome, "blocked");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign paused (FG-503 held)");
});

// ── FG-393 report verdict: complete campaign with blocked item → complete_with_issues ────

test("FG-393 report verdict: complete campaign with blocked item → verdict=complete_with_issues, never all_shipped", async () => {
  // FG-301 (related=[FG-399]): fails LOCAL (scope). FG-302 (no related): independent → continues and completes.
  // Campaign reaches stopReason='complete' (no held items).
  // Report verdict must be 'complete_with_issues', never 'all_shipped'.
  const { assembleCampaignReport } = await import("./report.js");

  writeLinkedTicket(projectDir, "FG-301", ["FG-399"]);
  writeLinkedTicket(projectDir, "FG-302", []);
  writeTicket(projectDir, { id: "FG-399", type: "story", status: "active", title: "Unrelated Dep", body: "", created: "2024-01-10" });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-301", "FG-302"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    if ((args.runTitle ?? "") === "FG-301") {
      seedLocalFailure("task-fake");
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
    }
    // FG-302 must actually ship (FG-442 review Finding 1) for the campaign to reach
    // 'complete' — otherwise it would park at awaiting_gate and the campaign would pause.
    closeTicket(projectDir, "FG-302", makeShipCommit("FG-302"));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const runResult = await startCampaign(campaign.id, { dispatch });
  assert.equal(runResult.stopReason, "complete", "campaign must complete (FG-302 independent, shipped; no held items)");

  const report = assembleCampaignReport(campaign.id)!;
  assert.equal(
    report.verdict,
    "complete_with_issues",
    "complete campaign with blocked item must be complete_with_issues, never all_shipped"
  );
  assert.notEqual(report.verdict, "all_shipped", "must NEVER be all_shipped when blocked items exist");
  assert.ok(
    report.groupings.blocked.includes("FG-301"),
    "FG-301 must appear in blocked grouping"
  );
  assert.equal(
    report.groupings.held.length,
    0,
    "no held items in a completed campaign"
  );
  assert.ok(
    report.groupings.shipped.includes("FG-302"),
    "FG-302 shipped (ticket done+closedCommit) must appear in the shipped grouping"
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// FG-413: readiness preflight gate
// ════════════════════════════════════════════════════════════════════════════════

test("FG-413: needs_refinement ticket → item HELD (outcome=held, blockerKind=readiness), NOT dispatched, reason mentions gaps", async () => {
  writeTicket(projectDir, {
    id: "FG-801",
    type: "story",
    status: "active",
    title: "Unrefined Story",
    epic: "FG-100",
    created: "2024-01-01",
    body: "Some work to do without proper structure",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-801"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCallCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "paused", "needs_refinement ticket → campaign paused (held item)");
  assert.equal(dispatchCallCount, 0, "dispatch must NOT be called for a needs_refinement ticket");
  assert.equal(result.itemRecords.length, 1);
  assert.equal(result.itemRecords[0]!.outcome, "held");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "pending");

  const dbItem = db.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind, continue_policy, reason, requested_human_action FROM campaign_items WHERE ticket_id = 'FG-801'"
  ).get() as { lifecycle_status: string; outcome: string; blocker_kind: string; continue_policy: string; reason: string; requested_human_action: string };
  assert.equal(dbItem.lifecycle_status, "pending", "readiness-held item lifecycle must stay pending (not dispatched)");
  assert.equal(dbItem.outcome, "held");
  assert.equal(dbItem.blocker_kind, "readiness");
  assert.equal(dbItem.continue_policy, "hold_dependents");
  assert.ok(dbItem.reason.includes("not ready"), `reason must include 'not ready', got: ${dbItem.reason}`);
  assert.ok(
    dbItem.reason.includes("Problem") || dbItem.reason.includes("Goal") || dbItem.reason.includes("Acceptance Criteria"),
    `reason must name the missing sections, got: ${dbItem.reason}`
  );
  assert.ok(dbItem.requested_human_action.includes("refine FG-801"), `requestedHumanAction must say 'refine FG-801', got: ${dbItem.requested_human_action}`);
  assert.ok(dbItem.requested_human_action.includes("resume"), `requestedHumanAction must mention 'resume', got: ${dbItem.requested_human_action}`);

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must be paused when readiness-held items exist");
});

test("FG-413: ready ticket → dispatched normally (readiness gate does not interfere)", async () => {
  // FG-101 from beforeEach has Problem/Goal/AC sections → ready
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCallCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    closeTicket(projectDir, "FG-101", makeShipCommit("FG-101"));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete", "ready ticket → campaign complete");
  assert.equal(dispatchCallCount, 1, "dispatch must be called exactly once for ready ticket");
});

test("FG-413: exploratory ticket (spike marker in title) → dispatched without readiness hold", async () => {
  writeTicket(projectDir, {
    id: "FG-802",
    type: "story",
    status: "active",
    title: "Spike: investigate approach for X",
    epic: "FG-100",
    created: "2024-01-01",
    body: "## Problem\nWe need to understand the best approach.\n",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-802"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCallCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    closeTicket(projectDir, "FG-802", makeShipCommit("FG-802"));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete", "exploratory ticket → campaign complete (not held)");
  assert.equal(dispatchCallCount, 1, "exploratory ticket must be dispatched (readiness gate: exploratory → proceed)");
});

test("FG-413: resume — readiness-held item refined to ready → re-dispatched on resume, campaign completes", async () => {
  writeTicket(projectDir, {
    id: "FG-811",
    type: "story",
    status: "active",
    title: "Needs Refinement",
    epic: "FG-100",
    created: "2024-01-01",
    body: "Some work without structure — not ready yet",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-811"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCount++;
    closeTicket(projectDir, "FG-811", makeShipCommit("FG-811"));
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  // Phase 1: start → readiness hold, no dispatch
  const phase1Result = await startCampaign(campaign.id, { dispatch });
  assert.equal(phase1Result.stopReason, "paused", "Phase 1: campaign paused (readiness hold)");
  assert.equal(dispatchCount, 0, "Phase 1: no dispatch");

  const dbItemBefore = db.prepare(
    "SELECT outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-811'"
  ).get() as { outcome: string; blocker_kind: string };
  assert.equal(dbItemBefore.outcome, "held");
  assert.equal(dbItemBefore.blocker_kind, "readiness");

  // Phase 2: refine the ticket → now ready
  writeTicket(projectDir, {
    id: "FG-811",
    type: "story",
    status: "active",
    title: "Needs Refinement",
    epic: "FG-100",
    created: "2024-01-01",
    body: "## Problem\nThis needs implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
  });

  // Phase 3: resume → item re-evaluated, now ready, dispatched
  const phase3Result = await resumeCampaign(campaign.id, { dispatch });
  assert.equal(phase3Result.stopReason, "complete", "Phase 3: campaign complete after ticket refined");
  assert.equal(dispatchCount, 1, "Phase 3: item dispatched once after refinement");

  const dbItemAfter = db.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-811'"
  ).get() as { lifecycle_status: string; outcome: string | null; blocker_kind: string | null };
  assert.equal(dbItemAfter.lifecycle_status, "complete");
  assert.notEqual(dbItemAfter.outcome, "held", "item must no longer be held after refinement + resume");
  assert.notEqual(dbItemAfter.blocker_kind, "readiness", "blockerKind must be cleared after readiness hold lifted");
});

test("FG-413: resume — readiness-held item still not-ready → stays held, not dispatched", async () => {
  writeTicket(projectDir, {
    id: "FG-812",
    type: "story",
    status: "active",
    title: "Still Unrefined",
    epic: "FG-100",
    created: "2024-01-01",
    body: "Still no structure at all",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-812"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCount = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCount++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  // Phase 1: start → readiness hold
  const phase1Result = await startCampaign(campaign.id, { dispatch });
  assert.equal(phase1Result.stopReason, "paused");
  assert.equal(dispatchCount, 0, "Phase 1: not dispatched");

  const phase1Item = db.prepare(
    "SELECT outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-812'"
  ).get() as { outcome: string; blocker_kind: string };
  assert.equal(phase1Item.outcome, "held");
  assert.equal(phase1Item.blocker_kind, "readiness");

  // Phase 2: resume WITHOUT refining → still held, not dispatched
  const resumeResult = await resumeCampaign(campaign.id, { dispatch });
  assert.equal(resumeResult.stopReason, "paused", "Phase 2: campaign still paused (still not-ready)");
  assert.equal(dispatchCount, 0, "Phase 2: still not dispatched after unrefined resume");

  const phase2Item = db.prepare(
    "SELECT outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-812'"
  ).get() as { outcome: string; blocker_kind: string };
  assert.equal(phase2Item.outcome, "held", "item must still be held after unrefined resume");
  assert.equal(phase2Item.blocker_kind, "readiness", "blockerKind must still be readiness after unrefined resume");
});

// ════════════════════════════════════════════════════════════════════════════════
// FG-416: dependency-held itemRecord shape and CLI branch ordering
// ════════════════════════════════════════════════════════════════════════════════

test("FG-416: startCampaign dependency-held itemRecord exposes reason, no blockerKind=readiness — CLI dependencyHeld filter matches", async () => {
  // FG-101 fails LOCAL; FG-102 is dependency-held (unknown relation, sequential).
  // The held itemRecord must carry reason and must NOT have blockerKind=readiness —
  // confirming the CLI start handler would pick the dependencyHeld branch, not the generic one.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");

  const heldRecord = result.itemRecords.find((r) => r.outcome === "held");
  assert.ok(heldRecord, "must have a held itemRecord for FG-102");
  assert.equal(heldRecord!.ticketId, "FG-102");
  assert.ok(heldRecord!.reason, "held itemRecord must carry reason for CLI dependency-held message");
  assert.notEqual(heldRecord!.blockerKind, "readiness", "dependency-held item must NOT have blockerKind=readiness");

  // Apply the same filter logic the CLI start/resume paused handler uses.
  const readinessHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind === "readiness");
  const dependencyHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind !== "readiness");

  assert.equal(readinessHeld.length, 0, "no readiness-held items — readiness branch must NOT fire");
  assert.ok(dependencyHeld.length > 0, "CLI dependencyHeld filter matches — start emits blocker guidance, not generic 'run resume'");
  assert.equal(dependencyHeld[0]!.ticketId, "FG-102", "held ticket named in output");
  assert.ok(dependencyHeld[0]!.reason, "reason present — CLI reasonPart populated for single held item");
});

test("FG-416: startCampaign — dependency-held AND blocked both in itemRecords — dependencyHeld branch fires before blocked (branch-order pin)", async () => {
  // FG-101 fails LOCAL → itemRecords gets outcome=blocked.
  // FG-102 is dependency-held → itemRecords gets outcome=held (no blockerKind).
  // CLI branch order: readinessHeld → dependencyHeld → blocked → generic.
  // With dependencyHeld=[FG-102] and blocked=[FG-101], dependencyHeld fires — NOT blocked.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    seedLocalFailure("task-fake");
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "scope error" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");

  const blocked = result.itemRecords.filter((r) => r.outcome === "blocked");
  const dependencyHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind !== "readiness");
  assert.ok(blocked.length > 0, "must have a blocked item in itemRecords (FG-101 newly failed)");
  assert.ok(dependencyHeld.length > 0, "must have a dependency-held item in itemRecords (FG-102)");

  const readinessHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind === "readiness");
  assert.equal(readinessHeld.length, 0, "no readiness-held items — first branch must NOT fire");
  // dependencyHeld fires before blocked: CLI emits blocker-guidance, not 'blocked; resolve and resume'
  assert.ok(dependencyHeld.length > 0, "dependencyHeld wins — CLI emits blocker-guidance, not 'blocked; resolve and resume' or 'run resume again'");
});

test("FG-416: startCampaign readiness-held — itemRecord has blockerKind=readiness — readinessHeld filter wins over dependencyHeld (start regression pin)", async () => {
  // A ticket without Problem/Goal/AC sections is held by the readiness gate.
  // readinessHeld filter must match it; CLI must emit 'refine' — not 'blocker guidance'.
  // Regression-pins that FG-416's dependencyHeld branch does NOT steal readiness-held items.
  writeTicket(projectDir, {
    id: "FG-901",
    type: "story",
    status: "active",
    title: "Unrefined Ticket",
    epic: "FG-100",
    created: "2024-01-01",
    body: "Some work but missing structure",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-901"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatched = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatched++;
    return { runId: "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");
  assert.equal(dispatched, 0, "readiness-held ticket must not be dispatched");

  const readinessHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind === "readiness");
  const dependencyHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind !== "readiness");

  assert.ok(readinessHeld.length > 0, "readinessHeld filter must match — CLI emits 'refine', not dependency message");
  assert.equal(dependencyHeld.length, 0, "dependencyHeld filter must NOT match readiness-held items");
  assert.equal(readinessHeld[0]!.ticketId, "FG-901");
  assert.equal(readinessHeld[0]!.blockerKind, "readiness");
});

test("FG-416: startCampaign cooperative-pause — itemRecords has no held/blocked — CLI generic branch fires", async () => {
  // Campaign paused after item1 completes (cooperative pause); item2 never dispatched.
  // itemRecords: only item1 (lifecycle=complete, no held/blocked outcome).
  // CLI start: readinessHeld=[], dependencyHeld=[], blocked=[] → generic branch fires
  // ('campaign paused between items — run resume to continue').
  // CLI resume generic: 'campaign paused between items — run resume again to continue'.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");
  assert.equal(callCount, 1, "only item1 dispatched before cooperative pause");

  const readinessHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind === "readiness");
  const dependencyHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind !== "readiness");
  const blocked = result.itemRecords.filter((r) => r.outcome === "blocked");

  assert.equal(readinessHeld.length, 0, "no readiness-held items after cooperative pause");
  assert.equal(dependencyHeld.length, 0, "no dependency-held items after cooperative pause");
  assert.equal(blocked.length, 0, "no blocked items after cooperative pause — generic branch fires in CLI");
});

// ── FG-442: execution lanes — dispatch, escalation, and re-approval ──────────

test("FG-442 docs_only: single invoke dispatch to the stored agentRole; ships when the ticket is closed", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  // FG-483: docs_only ships via the non_code_diff out-of-band lane — a real,
  // reachable, docs-only commit — with no host-verification row required.
  shipTicket("FG-101");

  let calledWithRole: string | undefined;
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    calledWithRole = args.agentRole;
    return { runId: args.runId ?? "run-docs", taskId: "task-docs", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(calledWithRole, "documentation-maintainer", "must dispatch to the lane's stored agentRole");
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");
});

test("FG-442 review Finding 1: docs_only agent completes but ticket is NOT closed (no closedCommit) → item parks awaiting_gate, campaign pauses, never reports complete", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  // Ticket left active (not done, no closedCommit) — the agent "finished" without shipping.
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-docs-noship",
    taskId: "task-docs-noship",
    status: "complete",
  });

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "campaign must pause, never report complete, when the item did not ship");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "awaiting_gate", "item must park at awaiting_gate, not complete");
  assert.equal(result.itemRecords[0]!.outcome, undefined, "outcome must not be 'shipped' when the ticket was never closed");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused", "campaign must be paused, not complete/complete_with_issues");

  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.lifecycleStatus, "awaiting_gate");
  assert.equal(items[0]!.blockerKind, undefined, "no blockerKind — this is the out-of-band shape `forge campaign reconcile` expects");
  assert.ok(
    items[0]!.requestedHumanAction?.includes("FG-101") && items[0]!.requestedHumanAction?.includes("reconcile"),
    `requestedHumanAction must name the ticket and point at reconcile\ngot: ${items[0]!.requestedHumanAction}`
  );
});

test("FG-442 quick_implementation: dispatches engineer then test-engineer on the SAME run; ships when both succeed", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "quick_implementation", laneRationale: "test" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  // FG-483: quick_implementation is a code-touching lane — ships via a real,
  // reachable, code-touching commit PLUS a covering passing host-verification
  // row (the host_verification out-of-band lane), not a docs-only commit.
  shipTicketWithHostVerification("FG-101");

  const rolesCalled: string[] = [];
  const runIdsSeen = new Set<string>();
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    rolesCalled.push(args.agentRole);
    if (args.runId) runIdsSeen.add(args.runId);
    return { runId: args.runId ?? "run-quick", taskId: `task-${args.agentRole}`, status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.deepEqual(rolesCalled, ["engineer", "test-engineer"], "must dispatch engineer then test-engineer, in order");
  assert.equal(runIdsSeen.size, 1, "both invokes must attach to the SAME run");
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");
});

test("FG-483 negative (review F4 spoof shape, quick_implementation lane): ticket done with a FABRICATED closedCommit (no real commit, no host-verification row) → item parks awaiting_gate, never ships — today's frontmatter-only check would have shipped this", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "quick_implementation", laneRationale: "test" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  // Simulates an engineer (or test-engineer) agent self-closing its own ticket
  // with a commit sha that was never actually committed — the review's exact
  // spoof shape (backlog/structured.ts's closeTicket accepts any --commit
  // string unvalidated). No git commit, no host-verification row.
  writeTicket(projectDir, {
    id: "FG-101", type: "story", status: "done", title: "Story One", epic: "FG-100",
    created: "2024-01-01", closedCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    body: "## Problem\nStory One needs implementation.\n\n## Goal\nComplete story one.\n\n## Acceptance Criteria\n- Story one is complete\n",
  });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-quick-spoof",
    taskId: `task-${args.agentRole}-spoof`,
    status: "complete",
  });

  const result = await startCampaign(campaign.id, { dispatch });
  assert.notEqual(result.stopReason, "complete", "a fabricated closedCommit must never let the campaign report complete");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "awaiting_gate", "item must park awaiting_gate on a fabricated closedCommit");
  assert.equal(result.itemRecords[0]!.outcome, undefined, "outcome must not be 'shipped' for a fabricated closedCommit");
});

test("FG-442 review Finding 1: quick_implementation both invokes complete but ticket is NOT closed (no closedCommit) → item parks awaiting_gate, campaign pauses, never reports complete", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "quick_implementation", laneRationale: "test" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  // Ticket left active (not done, no closedCommit) — both agents "finished" without shipping.
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-quick-noship",
    taskId: `task-${args.agentRole}-noship`,
    status: "complete",
  });

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "campaign must pause, never report complete, when the item did not ship");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "awaiting_gate", "item must park at awaiting_gate, not complete");
  assert.equal(result.itemRecords[0]!.outcome, undefined, "outcome must not be 'shipped' when the ticket was never closed");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused", "campaign must be paused, not complete/complete_with_issues");

  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.lifecycleStatus, "awaiting_gate");
  assert.equal(items[0]!.blockerKind, undefined, "no blockerKind — this is the out-of-band shape `forge campaign reconcile` expects");
  assert.ok(
    items[0]!.requestedHumanAction?.includes("FG-101") && items[0]!.requestedHumanAction?.includes("reconcile"),
    `requestedHumanAction must name the ticket and point at reconcile\ngot: ${items[0]!.requestedHumanAction}`
  );
});

test("FG-442 quick_implementation: test-engineer failure blocks the item, does not silently ship", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "quick_implementation", laneRationale: "test" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    if (args.agentRole === "test-engineer") {
      return { runId: args.runId ?? "run-quick-fail", taskId: "task-te", status: "failed", error: "tests failed" };
    }
    return { runId: args.runId ?? "run-quick-fail", taskId: "task-eng", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "failed");
  assert.equal(result.itemRecords[0]!.outcome, "blocked");
});

test("FG-442 ticketing_only: no run/task dispatched; item reaches a terminal 'skipped' outcome with a human action", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "ticketing_only", laneRationale: "test" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  let dispatchCalled = false;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCalled = true;
    return { runId: "should-not-happen", taskId: "should-not-happen", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(dispatchCalled, false, "ticketing_only must never call opts.dispatch");
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "skipped");
  assert.equal(result.itemRecords[0]!.runId, undefined, "no run must be created for ticketing_only");

  const items = listCampaignItems(campaign.id);
  assert.ok(items[0]!.requestedHumanAction?.includes("ticketing_only"));
});

test("FG-442 escalation: an explicit laneEscalation signal sets blockerKind lane_escalation and pauses the whole campaign", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-escalate",
    taskId: "task-escalate",
    status: "complete",
    result: { laneEscalation: { reason: "this needs a full implementation, not docs", suggestedLane: "full_feature" } },
  });

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused");
  assert.equal(result.itemRecords[0]!.blockerKind, "lane_escalation");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "failed");
  assert.equal(result.itemRecords[0]!.outcome, "blocked");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused");

  const items = listCampaignItems(campaign.id);
  assert.ok(items[0]!.requestedHumanAction?.includes("outgrew lane"));
});

test("FG-442 escalation: a generic dispatch failure (no laneEscalation field) is classified normally, NOT as an escalation", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });
  seedLocalFailure("task-generic-fail");

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-generic-fail",
    taskId: "task-generic-fail",
    status: "failed",
    error: "generic model error",
  });

  const result = await startCampaign(campaign.id, { dispatch });
  assert.notEqual(result.itemRecords[0]!.blockerKind, "lane_escalation", "a generic failure must never be inferred as an escalation");
  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.blockerKind, "scope");
});

test("FG-442 escalateCampaignItemLane: mutates plan_hash + resets the item; requires re-approval before resume dispatches under the new lane", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });
  const approvedHashBefore = getCampaign(campaign.id)!.approvedPlanHash;

  const escalatingDispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-escalate2",
    taskId: "task-escalate2",
    status: "complete",
    result: { laneEscalation: { reason: "outgrew docs_only" } },
  });

  const firstRun = await startCampaign(campaign.id, { dispatch: escalatingDispatch });
  assert.equal(firstRun.stopReason, "paused");
  assert.equal(getCampaign(campaign.id)!.status, "paused");

  // escalateCampaignItemLane refuses a non-paused campaign
  const wrongStateResult = escalateCampaignItemLane("nonexistent-campaign-id", "FG-101", {
    newLane: "full_feature",
    laneRationale: "test",
  });
  assert.equal(wrongStateResult.ok, false);

  const escalateResult = escalateCampaignItemLane(campaign.id, "FG-101", {
    newLane: "full_feature",
    laneRationale: "escalated: agent reported outgrowing docs_only",
  });
  assert.equal(escalateResult.ok, true);
  if (!escalateResult.ok) return;

  const afterEscalate = getCampaign(campaign.id)!;
  assert.equal(afterEscalate.status, "paused", "escalation must not change campaign status by itself");
  assert.notEqual(afterEscalate.planHash, approvedHashBefore, "escalation must produce a FRESH plan_hash");
  assert.equal(afterEscalate.approvedPlanHash, approvedHashBefore, "approved_plan_hash must NOT silently follow — re-approval is required");

  const resetItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(resetItem.lifecycleStatus, "pending", "the escalated item must be reset to pending for a fresh dispatch");
  assert.equal(resetItem.blockerKind, undefined);

  // No silent continue: resume without re-approving is refused as stale.
  const resumeBeforeApprove = await resumeCampaign(campaign.id, { dispatch: escalatingDispatch });
  assert.equal(resumeBeforeApprove.stopReason, "stale_plan", "resume must refuse until the fresh plan is re-approved");
  assert.equal(getCampaign(campaign.id)!.status, "paused", "refused resume must not silently transition the campaign");

  // approveCampaign now accepts re-approving a paused campaign — same confirm/override point.
  const reApproved = approveCampaign(campaign.id, { rationale: "re-approved after escalation" });
  assert.equal(reApproved, true, "approveCampaign must accept a paused campaign for re-approval");
  assert.equal(getCampaign(campaign.id)!.approvedPlanHash, afterEscalate.planHash);

  // No silent downgrade: resume now dispatches the item via the NEW lane (full_feature ->
  // loadWorkflow path), never falling back to the outgrown docs_only invoke path.
  let loadWorkflowCalled = false;
  let dispatchCalledAfterEscalation = false;
  const result = await resumeCampaign(campaign.id, {
    dispatch: async (args: InvokeArgs): Promise<InvokeResult> => {
      dispatchCalledAfterEscalation = true;
      return escalatingDispatch(args);
    },
    loadWorkflowFn: () => {
      loadWorkflowCalled = true;
      return {
        name: "feature",
        description: "",
        inputs: [],
        steps: [{ id: "engineer", agent: "engineer", runtime: "claude", depends_on: [], gate: "auto", reds: [], manual: false }],
      };
    },
    runNextFn: async ({ runId }) => {
      updateRunStatus(runId, "complete");
      return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
    },
  });

  assert.equal(loadWorkflowCalled, true, "resume must dispatch the escalated item via the full_feature workflow path");
  assert.equal(dispatchCalledAfterEscalation, false, "full_feature dispatch must never call opts.dispatch (invoke escape hatch)");
  assert.notEqual(result.stopReason, "recovery_needed");
});

test("RED-WIDE fix 1: bare resume after a lane_escalation pause (no escalate, no approve) refuses with lane_escalation_unresolved, never dispatches item2", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
    "FG-102": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  const escalatingDispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-bypass",
    taskId: "task-bypass",
    status: "complete",
    result: { laneEscalation: { reason: "outgrew docs_only" } },
  });

  const firstRun = await startCampaign(campaign.id, { dispatch: escalatingDispatch });
  assert.equal(firstRun.stopReason, "paused");
  assert.equal(getCampaign(campaign.id)!.status, "paused");

  let item2Dispatched = false;
  const resumeResult = await resumeCampaign(campaign.id, {
    dispatch: async (args: InvokeArgs): Promise<InvokeResult> => {
      item2Dispatched = true;
      return { runId: args.runId ?? "run-item2", taskId: "task-item2", status: "complete", result: {} };
    },
  });

  assert.equal(resumeResult.stopReason, "lane_escalation_unresolved");
  assert.equal(item2Dispatched, false, "resume must never dispatch past a still-unresolved lane_escalation item");
  assert.equal(getCampaign(campaign.id)!.status, "paused", "a refused resume must not silently transition the campaign");

  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.blockerKind, "lane_escalation", "the escalated item must remain unresolved");
  assert.equal(items[1]!.lifecycleStatus, "pending", "item2 must remain untouched by the refused resume");
});

test("RED-WIDE fix 4: escalateCampaignItemLane rejects a no-op lane change (rationale-only tweak, same lane)", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  const escalatingDispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-noop",
    taskId: "task-noop",
    status: "complete",
    result: { laneEscalation: { reason: "outgrew docs_only" } },
  });
  await startCampaign(campaign.id, { dispatch: escalatingDispatch });
  assert.equal(getCampaign(campaign.id)!.status, "paused");

  const planHashBefore = getCampaign(campaign.id)!.planHash;

  const result = escalateCampaignItemLane(campaign.id, "FG-101", {
    newLane: "docs_only", // same lane the item is already on
    laneRationale: "just tweaking the rationale text, no real change",
    agentRole: "documentation-maintainer",
  });

  assert.equal(result.ok, false, "a no-op lane change must be rejected");
  assert.equal(getCampaign(campaign.id)!.planHash, planHashBefore, "plan_hash must not change on a rejected no-op escalation");

  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.blockerKind, "lane_escalation", "item must remain in its escalated blocked state — no silent clear");
  assert.equal(items[0]!.lifecycleStatus, "failed");
});

// ── FG-489: retryCampaignItem — supported reset-to-pending for transiently-failed items ──

test("FG-489: pause on an auth-classified failure, retryCampaignItem resets it, resume re-dispatches through the normal drive path and reaches shipped", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let dispatchCallCount = 0;
  const authThenSucceedDispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCallCount++;
    if (dispatchCallCount === 1) {
      logEvent("task.failed", { taskId: "task-auth-1", payload: { failure_kind: "auth_expired", error: "auth token expired" } });
      return { runId: args.runId ?? "run-auth-1", taskId: "task-auth-1", status: "failed", error: "auth token expired" };
    }
    return { runId: args.runId ?? "run-auth-2", taskId: "task-auth-2", status: "complete", result: {} };
  };

  const firstRun = await startCampaign(campaign.id, { dispatch: authThenSucceedDispatch });
  assert.equal(firstRun.stopReason, "paused");
  assert.equal(dispatchCallCount, 1);

  const failedItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(failedItem.lifecycleStatus, "failed");
  assert.equal(failedItem.outcome, "blocked");
  assert.equal(failedItem.blockerKind, "auth", "task.failed auth_expired must classify to blockerKind 'auth'");
  assert.ok(failedItem.runId, "the failed attempt's run must be retained until retry clears it");

  const retryResult = retryCampaignItem(campaign.id, "FG-101");
  assert.equal(retryResult.ok, true, `retry must accept an auth-classified failure: ${!retryResult.ok ? retryResult.reason : ""}`);

  const resetItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(resetItem.lifecycleStatus, "pending", "retry must reset the item to pending");
  assert.equal(resetItem.outcome, undefined);
  assert.equal(resetItem.blockerKind, undefined);
  assert.equal(resetItem.runId, undefined, "retry must clear the failed attempt's run linkage for a clean re-dispatch");
  assert.equal(getCampaign(campaign.id)!.status, "paused", "retry must not itself change campaign status");

  // Real ship evidence (FG-483: invoke-lane completion requires it, not just a
  // 'complete' dispatch status) so the re-dispatch can actually reach shipped.
  shipTicket("FG-101");

  const resumeResult = await resumeCampaign(campaign.id, { dispatch: authThenSucceedDispatch });
  assert.equal(dispatchCallCount, 2, "resume must re-dispatch the retried item through the normal drive path");
  assert.equal(resumeResult.stopReason, "complete");

  const shippedItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(shippedItem.lifecycleStatus, "complete");
  assert.equal(shippedItem.outcome, "shipped");
});

test("FG-489: retryCampaignItem refuses when the campaign is running (only a paused campaign is eligible)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });
  tryTransitionCampaignToRunning(campaign.id);

  const result = retryCampaignItem(campaign.id, "FG-101");
  assert.equal(result.ok, false, "retry must refuse a running campaign");
  if (!result.ok) {
    assert.match(result.reason, /paused/i);
  }
});

test("FG-489: retryCampaignItem refuses a scope/verdict-blocked item — no silent retry over a red/verdict failure", async () => {
  // Two items: FG-101 fails LOCAL (scope) and FG-102 (unknown relation,
  // sequential) holds behind it — same shape as the "first-item failure
  // (FG-393)" test — so the campaign lands on 'paused' (not 'complete') and
  // there is a real failed item to attempt retry against.
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const scopeFailDispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    seedLocalFailure("task-scope-fake");
    return { runId: args.runId ?? "run-scope-fake", taskId: "task-scope-fake", status: "failed", error: "agent produced wrong scope" };
  };

  const firstRun = await startCampaign(campaign.id, { dispatch: scopeFailDispatch });
  assert.equal(firstRun.stopReason, "paused");

  const failedItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(failedItem.blockerKind, "scope", "model_error must classify to blockerKind 'scope'");

  const result = retryCampaignItem(campaign.id, "FG-101");
  assert.equal(result.ok, false, "retry must refuse a scope-blocked item");
  if (!result.ok) {
    assert.match(result.reason, /scope/i);
  }

  const untouchedItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(untouchedItem.lifecycleStatus, "failed", "a refused retry must not mutate the item");
  assert.equal(untouchedItem.blockerKind, "scope");
});

test("FG-489: retryCampaignItem refuses an unknown ticket id and a not-currently-failed item", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");

  const unknownResult = retryCampaignItem(campaign.id, "FG-999-does-not-exist");
  assert.equal(unknownResult.ok, false, "retry must refuse a ticket id that is not a campaign item");

  const pendingResult = retryCampaignItem(campaign.id, "FG-101");
  assert.equal(pendingResult.ok, false, "retry must refuse an item that is not currently failed");
});

test("RED-WIDE fix 3: legacy pre-FG-442 stored planContent entry (no lane field) dispatches via single invoke, not the full_feature workflow path", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { executionMode: "invoke", agentRole: "engineer" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "ok" });

  // Simulate a campaign whose metadata.planContent was persisted BEFORE the
  // 'lane' field existed on CanonicalItemEntry — strip it from the stored
  // display/dispatch copy without touching plan_hash/approved_plan_hash.
  // campaignBlocker's staleness check re-derives its hash from sourceInput, never
  // from this stored blob, so this does not trip stale_plan.
  const stored = getCampaign(campaign.id)!;
  const legacyPlanContent = JSON.parse(JSON.stringify(stored.metadata!["planContent"])) as {
    orderedItems: Array<Record<string, unknown>>;
  };
  for (const entry of legacyPlanContent.orderedItems) {
    delete entry["lane"];
    delete entry["laneRationale"];
    delete entry["materialLaneAssumptions"];
  }
  getDb()
    .prepare("UPDATE campaigns SET metadata = ? WHERE id = ?")
    .run(JSON.stringify({ ...stored.metadata, planContent: legacyPlanContent }), campaign.id);

  let loadWorkflowCalled = false;
  let dispatchCalled = false;
  const result = await startCampaign(campaign.id, {
    dispatch: async (args: InvokeArgs): Promise<InvokeResult> => {
      dispatchCalled = true;
      return { runId: args.runId ?? "run-legacy", taskId: "task-legacy", status: "complete", result: {} };
    },
    loadWorkflowFn: () => {
      loadWorkflowCalled = true;
      return {
        name: "feature",
        description: "",
        inputs: [],
        steps: [{ id: "engineer", agent: "engineer", runtime: "claude", depends_on: [], gate: "auto", reds: [], manual: false }],
      };
    },
  });

  assert.notEqual(result.stopReason, "stale_plan", "stripping the display-only planContent copy must not trip the staleness check");
  assert.equal(loadWorkflowCalled, false, "legacy invoke entry must NOT dispatch via the full_feature workflow path");
  assert.equal(dispatchCalled, true, "legacy invoke entry must dispatch via the single-invoke path it was actually approved for");
});

// FG-488 (review F2b): driveWorkflowItem's drive loop is a `while (true)` with no
// iteration bound, sleep, or no-progress detection. FG-476 fixed the one known
// producer of "run active + nothing dispatchable" (an on_reject recovery task
// invisible to the ready queue), but the loop itself stayed unbounded — the next
// projection mismatch of that shape spins at 100% CPU instead of pausing (the
// live FG-475/FG-476 incident: `forge campaign resume` over a wedged run burned
// a core). This drives a full_feature item over a run seeded with a pending task
// that never becomes dispatchable, through the REAL drive path (startCampaign ->
// driveRemainingItems -> driveWorkflowItem), with only runNextFn stubbed to
// dispatch nothing — proving the loop itself now bounds and parks instead of
// relying on runNext ever changing behavior.
const FG488_WORKFLOW = () => ({
  name: "feature",
  description: "",
  inputs: [],
  steps: [{ id: "engineer", agent: "engineer", runtime: "claude" as const, depends_on: [], gate: "auto" as const, reds: [], manual: false }],
});

test("FG-488: drive loop no-progress bound — active run + zero dispatch + unchanged task state returns recovery_needed, not a spin (review F2b)", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "full_feature", workflowName: "feature", laneRationale: "test: F2b no-progress bound" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved for FG-488 repro" });

  const STUCK_RUN_ID = "run-fg488-stuck";
  // Seed the run with a single pending task that runNextFn (stubbed below) never
  // touches — the undispatchable-pending-task shape the FG-476 family produces.
  const startRunFn = (args: StartRunArgs): { runId: string } => {
    insertRun({
      id: STUCK_RUN_ID,
      workflow: args.workflow.name,
      title: args.title,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      projectDir: args.projectDir,
    });
    insertTask({
      id: "task-fg488-stuck",
      runId: STUCK_RUN_ID,
      phase: "engineer",
      agentRole: "engineer",
      status: "pending",
      taskPackage: { taskId: "task-fg488-stuck", runId: STUCK_RUN_ID, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
      createdAt: "2026-01-01T00:00:01Z",
    });
    return { runId: STUCK_RUN_ID };
  };

  let runNextCallCount = 0;
  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: FG488_WORKFLOW,
    startRunFn,
    runNextFn: async () => {
      runNextCallCount += 1;
      // Mirrors runNext.ts's real "ready.length === 0 && !isRunSettled" shape:
      // nothing dispatched, nothing parked, run stays active.
      return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "active" };
    },
  });

  assert.equal(result.stopReason, "recovery_needed", "no-progress bound must return recovery_needed, not spin forever");
  assert.ok(runNextCallCount <= 10, `drive loop must be bounded — runNextFn was called ${runNextCallCount} times`);

  const dbItem = db.prepare(
    "SELECT lifecycle_status, blocker_kind, run_id, requested_human_action FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { lifecycle_status: string; blocker_kind: string | null; run_id: string; requested_human_action: string | null };
  assert.equal(dbItem.lifecycle_status, "awaiting_gate", "item must park in a recoverable, non-terminal state");
  assert.equal(dbItem.blocker_kind, null, "no blockerKind — matches the FG-441 reattach shape so a later resume re-examines run liveness");
  assert.equal(dbItem.run_id, STUCK_RUN_ID);
  assert.ok(
    dbItem.requested_human_action?.includes(STUCK_RUN_ID),
    `pause reason must name the run so the operator can inspect it, got: ${dbItem.requested_human_action}`
  );

  assert.equal(getCampaign(campaign.id)!.status, "paused", "campaign must cooperatively pause, not stay running or get killed");

  // Resumable, not wedged: campaignBlocker's inFlight check explicitly excludes
  // awaiting_gate, so resume must not refuse outright the way it would for a
  // stuck 'running' item (compare the FG-394-fix recovery_needed tests above).
  const resumeResult = await resumeCampaign(campaign.id, {
    loadWorkflowFn: FG488_WORKFLOW,
    runNextFn: async () => ({ dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "active" }),
  });
  assert.notEqual(resumeResult.stopReason, "not_paused", "campaign must accept a resume attempt after the no-progress pause");
});

// FG-490 (review F7): the drive path awaits runNextFn/startRun uncaught after
// the campaign has already transitioned to 'running' — any dispatch-time throw
// (docker spawn error, runNext missing projectDir, startRun input validation)
// used to propagate straight out with the campaign left 'running' forever:
// resume/start both refuse 'not_paused', and the only way back was manual DB
// surgery. Same dead end as F2b/FG-488, reached via an exception instead of a
// stalled loop. These tests drive the REAL path (startCampaign ->
// driveRemainingItems -> driveWorkflowItem) with an injected throwing
// runNextFn/startRunFn and assert: campaign lands paused, item lands in a
// recoverable non-terminal state (awaiting_gate), the failure is durably
// recorded, the ORIGINAL error still reaches the caller, and resume can
// proceed afterward.

test("FG-490: thrown runNextFn parks the campaign (running->paused) with a recoverable item, durably records the failure, and rethrows the original error with next-action guidance", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "full_feature", workflowName: "feature", laneRationale: "test: F7 thrown runNextFn" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved for FG-490 repro" });

  const RUN_ID = "run-fg490-runnext-throw";
  const startRunFn = (args: StartRunArgs): { runId: string } => {
    insertRun({
      id: RUN_ID,
      workflow: args.workflow.name,
      title: args.title,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      projectDir: args.projectDir,
    });
    return { runId: RUN_ID };
  };

  await assert.rejects(
    () =>
      startCampaign(campaign.id, {
        loadWorkflowFn: FG488_WORKFLOW,
        startRunFn,
        runNextFn: async () => {
          throw new Error("docker spawn failed: no such image");
        },
      }),
    (err: Error) => {
      assert.match(err.message, /docker spawn failed: no such image/, "original error message must survive in the rethrown error");
      assert.match(err.message, /forge campaign resume/, "rethrown error must carry next-action guidance");
      assert.equal(
        (err.cause as Error | undefined)?.message,
        "docker spawn failed: no such image",
        "original error must be preserved via cause, not just paraphrased"
      );
      return true;
    }
  );

  const dbItem = db
    .prepare(
      "SELECT lifecycle_status, outcome, run_id, reason, requested_human_action FROM campaign_items WHERE ticket_id = 'FG-101'"
    )
    .get() as {
    lifecycle_status: string;
    outcome: string | null;
    run_id: string;
    reason: string | null;
    requested_human_action: string | null;
  };
  assert.equal(dbItem.lifecycle_status, "awaiting_gate", "item must land in a recoverable, non-terminal state — never stranded at 'running'");
  assert.equal(dbItem.outcome, null, "not a terminal blocked outcome — awaiting_gate is the recoverable reattach shape");
  assert.equal(dbItem.run_id, RUN_ID);
  assert.equal(dbItem.reason, "docker spawn failed: no such image", "the thrown error must be durably recorded on the item");
  assert.ok(dbItem.requested_human_action?.includes(RUN_ID), "guidance must name the run so the operator can inspect it");

  assert.equal(getCampaign(campaign.id)!.status, "paused", "campaign must transition running->paused BEFORE the error propagates");

  const driveErrorEvent = db
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.drive_error' AND run_id = ?")
    .get(RUN_ID) as { payload: string } | undefined;
  assert.ok(driveErrorEvent, "the failure must be durably recorded as an event — not swallowed, not silently retried");
  const payload = JSON.parse(driveErrorEvent!.payload);
  assert.equal(payload.error, "docker spawn failed: no such image");
  assert.equal(payload.ticketId, "FG-101");

  // campaignBlocker's inFlight check explicitly excludes awaiting_gate, so
  // resume must not refuse outright the way it would for a stuck 'running' item.
  const resumeResult = await resumeCampaign(campaign.id, {
    loadWorkflowFn: FG488_WORKFLOW,
    runNextFn: async () => {
      updateRunStatus(RUN_ID, "complete");
      return { dispatchedSteps: [], completedSteps: ["engineer"], awaitingGate: [], failedSteps: [], runStatus: "complete" };
    },
  });
  assert.notEqual(resumeResult.stopReason, "not_paused", "forge campaign resume must succeed (not refuse) after the F7 park");
});

test("FG-490 review F8: parkCampaignOnDriveThrow clears a stale outcome/blockerKind from a prior blocked attempt — a re-thrown item must not look terminally blocked while lifecycleStatus is the recoverable awaiting_gate", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "full_feature", workflowName: "feature", laneRationale: "test: F8 stale outcome/blockerKind" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved for FG-490 F8 repro" });

  const item = listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-101")!;
  // Simulate a prior blocked attempt (e.g. a resolved scope block) whose outcome/blockerKind
  // were never cleared before the item was re-dispatched and threw again.
  db.prepare("UPDATE campaign_items SET outcome = 'blocked', blocker_kind = 'scope' WHERE id = ?").run(item.id);

  const RUN_ID = "run-fg490-f8-stale-blocked";
  const startRunFn = (args: StartRunArgs): { runId: string } => {
    insertRun({
      id: RUN_ID,
      workflow: args.workflow.name,
      title: args.title,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      projectDir: args.projectDir,
    });
    return { runId: RUN_ID };
  };

  await assert.rejects(() =>
    startCampaign(campaign.id, {
      loadWorkflowFn: FG488_WORKFLOW,
      startRunFn,
      runNextFn: async () => {
        throw new Error("docker spawn failed: no such image");
      },
    })
  );

  const dbItem = db.prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE id = ?").get(item.id) as {
    lifecycle_status: string;
    outcome: string | null;
    blocker_kind: string | null;
  };
  assert.equal(dbItem.lifecycle_status, "awaiting_gate");
  assert.equal(dbItem.outcome, null, "stale 'blocked' outcome from the prior attempt must be cleared — awaiting_gate is the recoverable shape, not a terminal block");
  assert.equal(dbItem.blocker_kind, null, "stale blockerKind from the prior attempt must be cleared alongside outcome");
});

test("FG-490 review (round 2, F1): thrown startRunFn parks the item directly at failed/blocked/infrastructure (not awaiting_gate) and rethrows the original error; the item is then recoverable through forge campaign retry + resume, and the retried item actually re-dispatches", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "full_feature", workflowName: "feature", laneRationale: "test: F1 thrown startRunFn" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved for FG-490 F1 repro" });

  const startRunFn = (): { runId: string } => {
    throw new Error("startRun: required input 'brief' missing for workflow 'feature'");
  };

  await assert.rejects(
    () => startCampaign(campaign.id, { loadWorkflowFn: FG488_WORKFLOW, startRunFn }),
    (err: Error) => {
      assert.match(err.message, /required input 'brief' missing/, "original error message must survive in the rethrown error");
      assert.match(err.message, /forge campaign retry/, "rethrown error must name the actual recovery verb (retry)");
      assert.match(err.message, /forge campaign resume/, "rethrown error must carry next-action guidance");
      return true;
    }
  );

  const dbItemAfterThrow = db
    .prepare("SELECT lifecycle_status, outcome, blocker_kind, run_id, reason FROM campaign_items WHERE ticket_id = 'FG-101'")
    .get() as {
    lifecycle_status: string;
    outcome: string | null;
    blocker_kind: string | null;
    run_id: string | null;
    reason: string | null;
  };
  assert.equal(
    dbItemAfterThrow.lifecycle_status,
    "failed",
    "a thrown startRun never dispatched work — there is no live run to reattach to, so the item parks directly at its true terminal state"
  );
  assert.equal(dbItemAfterThrow.outcome, "blocked");
  assert.equal(
    dbItemAfterThrow.blocker_kind,
    "infrastructure",
    "a startRun dispatch-time failure classifies as the transient host/environment blocker kind, making it retryable"
  );
  assert.ok(dbItemAfterThrow.run_id, "a synthetic run row must still be linked for traceability");
  assert.equal(dbItemAfterThrow.reason, "startRun: required input 'brief' missing for workflow 'feature'");

  assert.equal(getCampaign(campaign.id)!.status, "paused", "campaign must transition running->paused BEFORE the error propagates");

  const driveErrorEvent = db
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.drive_error' AND run_id = ?")
    .get(dbItemAfterThrow.run_id) as { payload: string } | undefined;
  assert.ok(driveErrorEvent, "the failure must be durably recorded as an event — not swallowed, not silently retried");
  const payload = JSON.parse(driveErrorEvent!.payload);
  assert.equal(payload.error, "startRun: required input 'brief' missing for workflow 'feature'");
  assert.equal(payload.ticketId, "FG-101");

  // Recovery: forge campaign retry resets the item to pending (the ONLY
  // supported path for a transient auth/infrastructure blocker — FG-489).
  const retryResult = retryCampaignItem(campaign.id, "FG-101");
  assert.equal(retryResult.ok, true, "retry must succeed for a failed/blocked/infrastructure item");

  const dbItemAfterRetry = db
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-101'")
    .get() as { lifecycle_status: string; outcome: string | null; blocker_kind: string | null };
  assert.equal(dbItemAfterRetry.lifecycle_status, "pending", "retry must reset the item to pending for a clean re-dispatch");
  assert.equal(dbItemAfterRetry.outcome, null);
  assert.equal(dbItemAfterRetry.blocker_kind, null);

  // Then forge campaign resume with a startRun that now succeeds must actually
  // re-dispatch the item — proving recovery works end to end, not just that
  // the state machine allows it.
  let startRunInvoked = false;
  const RESUME_RUN_ID = "run-fg490-f1-retry-success";
  const resumeResult = await resumeCampaign(campaign.id, {
    loadWorkflowFn: FG488_WORKFLOW,
    startRunFn: (args: StartRunArgs) => {
      startRunInvoked = true;
      insertRun({
        id: RESUME_RUN_ID,
        workflow: args.workflow.name,
        title: args.title,
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        projectDir: args.projectDir,
      });
      return { runId: RESUME_RUN_ID };
    },
    runNextFn: async () => {
      updateRunStatus(RESUME_RUN_ID, "complete");
      return { dispatchedSteps: [], completedSteps: ["engineer"], awaitingGate: [], failedSteps: [], runStatus: "complete" };
    },
  });
  assert.notEqual(resumeResult.stopReason, "not_paused", "forge campaign resume must succeed (not refuse) after retry");
  assert.ok(startRunInvoked, "the retried item must actually re-dispatch through startRun on resume — not just sit in pending");
});

test("FG-490: if the park-transition itself fails (DB error), the original drive error still propagates — never masked by the recovery path", async () => {
  const itemOverrides: Record<string, ItemModeOverride> = {
    "FG-101": { lane: "full_feature", workflowName: "feature", laneRationale: "test: F7 park failure must not mask root cause" },
  };
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved for FG-490 repro" });

  const RUN_ID = "run-fg490-park-fail";
  const startRunFn = (args: StartRunArgs): { runId: string } => {
    insertRun({
      id: RUN_ID,
      workflow: args.workflow.name,
      title: args.title,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      projectDir: args.projectDir,
    });
    return { runId: RUN_ID };
  };

  await assert.rejects(
    () =>
      startCampaign(campaign.id, {
        loadWorkflowFn: FG488_WORKFLOW,
        startRunFn,
        runNextFn: async () => {
          // Simulate a broken DB at the moment of the drive-path throw — swap in
          // a closed database so the park write itself (updateCampaignItem,
          // logEvent, tryTransitionCampaign) throws too.
          const broken = makeInMemoryDb();
          broken.close();
          setDbForTest(broken);
          throw new Error("docker spawn failed: ECONNREFUSED");
        },
      }),
    (err: Error) => {
      assert.match(err.message, /docker spawn failed: ECONNREFUSED/, "the ORIGINAL drive error must propagate, not a DB error from the failed park");
      return true;
    }
  );

  setDbForTest(db);
  const dbItem = db.prepare("SELECT lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-101'").get() as { lifecycle_status: string };
  assert.equal(dbItem.lifecycle_status, "running", "when the park write fails, the item is left as it was — never falsely marked recovered");
  assert.equal(
    getCampaign(campaign.id)!.status,
    "running",
    "when the park write fails, the campaign is left as it was — never falsely marked paused"
  );
});
