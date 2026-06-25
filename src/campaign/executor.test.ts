import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  createCampaign,
  getCampaign,
  addCampaignItem,
  getCampaignItem,
  approveCampaign,
  tryTransitionCampaignToRunning,
  setPlanHash,
} from "../store/campaigns.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign, computePlanHash, resolvePlan } from "./planner.js";
import { startCampaign } from "./executor.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "executor-unit-"));

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

function fakeDispatch(status: "complete" | "failed", error?: string) {
  return async (_args: InvokeArgs): Promise<InvokeResult> => ({
    runId: _args.runId ?? "run-fake",
    taskId: "task-fake",
    status,
    error,
  });
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
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
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
  const { campaign: epicCampaign } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir });
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
    { projectDir }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatchLog: { ticketId: string; itemSnapshotBefore: string }[] = [];

  const fakeDispatchOrdered = async (args: InvokeArgs): Promise<InvokeResult> => {
    // Record the lifecycle status of ALL items at the time this dispatch is called
    const items = db.prepare("SELECT ticket_id, lifecycle_status FROM campaign_items ORDER BY item_order ASC").all() as { ticket_id: string; lifecycle_status: string }[];
    const snapshot = JSON.stringify(items.map((i) => `${i.ticket_id}:${i.lifecycle_status}`));
    dispatchLog.push({ ticketId: args.runTitle ?? "", itemSnapshotBefore: snapshot });
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

test("first-item failure: item2 never dispatched, campaign status failed", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  let callCount = 0;
  const fakeDispatchFail = async (args: InvokeArgs): Promise<InvokeResult> => {
    callCount++;
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "agent exploded" };
  };

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatchFail });
  assert.equal(result.stopReason, "item_failed");
  assert.equal(callCount, 1, "dispatch must be called exactly once — item2 must never dispatch");
  assert.equal(result.itemRecords.length, 1, "only one item record (the failed one)");

  const item1 = result.itemRecords[0]!;
  assert.equal(item1.lifecycleStatus, "failed");
  assert.equal(item1.outcome, "failed");

  // Verify durable DB state
  const dbItem1 = db.prepare("SELECT lifecycle_status, outcome, blocker_kind, reason FROM campaign_items WHERE ticket_id = 'FG-101'").get() as {
    lifecycle_status: string; outcome: string; blocker_kind: string; reason: string;
  };
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.outcome, "failed");
  assert.equal(dbItem1.blocker_kind, "campaign_system");
  assert.equal(dbItem1.reason, "agent exploded");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "failed");
});

// ── start: shipped evidence ───────────────────────────────────────────────────

test("shipped only with evidence: complete but ticket not done → outcome undefined", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]?.outcome, undefined, "outcome must be undefined when ticket is not done");
});

test("shipped with evidence: ticket done + closedCommit → outcome='shipped'", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Pre-close the ticket so it looks done after dispatch
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "done",
    title: "Story One",
    epic: "FG-100",
    created: "2024-01-01",
    closedCommit: "abc123",
    body: "Do the first thing",
  });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]?.outcome, "shipped", "outcome must be 'shipped' when ticket is done with closedCommit");
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
  const { campaign } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir });

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
  const { campaign } = planCampaign({ kind: "epic", epicId: "FG-100" }, { projectDir });
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
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir });
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
  // In single-process JS, the second call's sync section runs after the first call's CAS,
  // so the campaign is already 'running' → not_planned (not 'already_running', which would
  // require both calls to read 'planned' before either does the CAS — only possible multi-process).
  assert.equal(result2.stopReason, "not_planned",
    "second call blocked without dispatching (not_planned in single-process serialization)");
});

// ── crash-recovery durability ─────────────────────────────────────────────────

test("crash-recovery: run_id + lifecycle=running in DB BEFORE dispatch returns; run_id retained after failure", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir }
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
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "failed", error: "crash" };
  };

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatchCrash });
  assert.equal(result.stopReason, "item_failed");

  // Mid-flight durability: both must be written BEFORE dispatch resolves
  assert.ok(midFlightRunId, "run_id must be written to DB BEFORE dispatch resolves");
  assert.equal(midFlightLifecycle, "running",
    "lifecycle_status must be 'running' in DB BEFORE dispatch resolves");

  // Post-failure evidence: run_id retained so a human/tool can trace the failed run
  const dbItem1 = db.prepare(
    "SELECT run_id, lifecycle_status, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { run_id: string | null; lifecycle_status: string; blocker_kind: string };
  assert.ok(dbItem1.run_id, "run_id must be retained in DB after item failure (crash-recovery evidence)");
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.blocker_kind, "campaign_system");

  // item2 must never have been dispatched
  const dbItem2 = db.prepare(
    "SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'"
  ).get() as { run_id: string | null; lifecycle_status: string };
  assert.equal(dbItem2.run_id, null, "item2 run_id must be null — never dispatched");
  assert.equal(dbItem2.lifecycle_status, "pending", "item2 must remain pending after item1 failure");
});

// ── shipped: done ticket without closedCommit ─────────────────────────────────

test("shipped: ticket done but no closedCommit → outcome undefined (not shipped)", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir }
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
    body: "Do the first thing",
    // closedCommit deliberately absent
  });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "complete");
  assert.equal(
    result.itemRecords[0]?.outcome,
    undefined,
    "outcome must be undefined when ticket is done but has no closedCommit"
  );
});
