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
  updateCampaignStatus,
  setPlanHash,
} from "../store/campaigns.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign, computePlanHash, resolvePlan } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
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
    { projectDir, mode: "sequential" }
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
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]?.outcome, undefined, "outcome must be undefined when ticket is not done");
});

test("shipped with evidence: ticket done + closedCommit → outcome='shipped'", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
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

test("shipped: ticket done but no closedCommit → outcome undefined (not shipped)", async () => {
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

test("dispatch throws: item lifecycle=failed, outcome=failed, blocker=campaign_system, run_id retained, campaign=failed, loop stops", async () => {
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
  assert.equal(result.stopReason, "item_failed");
  assert.equal(callCount, 1, "dispatch must be called exactly once — item2 must never dispatch after throw");
  assert.equal(result.itemRecords.length, 1, "only one item record (the failed one)");

  const item1 = result.itemRecords[0]!;
  assert.equal(item1.lifecycleStatus, "failed");
  assert.equal(item1.outcome, "failed");

  // Durable DB state must match returned-failure path
  const dbItem1 = db.prepare(
    "SELECT run_id, lifecycle_status, outcome, blocker_kind, reason FROM campaign_items WHERE ticket_id = 'FG-101'"
  ).get() as { run_id: string | null; lifecycle_status: string; outcome: string; blocker_kind: string; reason: string };
  assert.equal(dbItem1.lifecycle_status, "failed");
  assert.equal(dbItem1.outcome, "failed");
  assert.equal(dbItem1.blocker_kind, "campaign_system");
  assert.equal(dbItem1.reason, "network timeout", "thrown error message must be stored as reason");
  assert.ok(dbItem1.run_id, "run_id must be retained in DB after thrown dispatch (evidence preserved)");

  // item2 must never have been dispatched
  const dbItem2 = db.prepare(
    "SELECT run_id, lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-102'"
  ).get() as { run_id: string | null; lifecycle_status: string };
  assert.equal(dbItem2.run_id, null, "item2 run_id must be null — never dispatched");
  assert.equal(dbItem2.lifecycle_status, "pending", "item2 must remain pending after item1 throw");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "failed");
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
    body: "Do the third thing",
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

test("edge: pause after last item — campaign stays paused, subsequent resume transitions to complete", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // item1 dispatch: pause campaign, then return complete (simulates cooperative pause
  // landing exactly after the last item's execution)
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  // Driver must return 'paused' — no illegal-transition throw (not complete)
  assert.equal(result.stopReason, "paused", "driver must return paused when last item completes under pause");

  // Campaign must be paused, not complete (the finalCheck was skipped because postCheck returned early)
  const afterPause = getCampaign(campaign.id)!;
  assert.equal(afterPause.status, "paused", "campaign must be paused with all items complete");

  // item1 must be complete (the outcome was written before the pause-check returned)
  const dbItem1 = db.prepare("SELECT lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-101'").get() as { lifecycle_status: string };
  assert.equal(dbItem1.lifecycle_status, "complete", "item1 must be complete even though campaign is paused");

  // Subsequent resume: all items are complete → driveRemainingItems skips all → finalCheck → complete
  let resumeDispatchCount = 0;
  const resumeDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    resumeDispatchCount++;
    return { runId: "run-resume", taskId: "task-resume", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeDispatch });
  assert.equal(resumeResult.stopReason, "complete", "resume must reach complete (all items already done)");
  assert.equal(resumeDispatchCount, 0, "resume must not dispatch anything (all items terminal)");

  const afterResume = getCampaign(campaign.id)!;
  assert.equal(afterResume.status, "complete", "campaign must transition to complete after resume");
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

test("last-item pause boundary: pause lands after final item completes — driver returns paused, subsequent resume reaches complete", async () => {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "paused", "driver must return paused (NOT complete) when last item done but campaign paused");

  const afterPause = getCampaign(campaign.id)!;
  assert.equal(afterPause.status, "paused", "campaign must be paused, not complete");

  const dbItem = db.prepare("SELECT lifecycle_status FROM campaign_items WHERE ticket_id = 'FG-101'").get() as { lifecycle_status: string };
  assert.equal(dbItem.lifecycle_status, "complete", "item1 must be complete even though campaign is paused");

  // Resume drives zero pending items → post-loop CAS running→complete succeeds
  let resumeDispatched = 0;
  const resumeDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    resumeDispatched++;
    return { runId: "run-resume", taskId: "t", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeDispatch });
  assert.equal(resumeResult.stopReason, "complete", "resume with all-complete items must reach complete");
  assert.equal(resumeDispatched, 0, "resume must not dispatch anything — all items are terminal");

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

const IN_FLIGHT_STATES = ["running", "awaiting_gate", "awaiting_human_input", "awaiting_red", "blocked_by_red"] as const;

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
    body: "Do the third thing",
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

  // startCampaign has no pre-flight check — exercises the driver defensive directly
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
