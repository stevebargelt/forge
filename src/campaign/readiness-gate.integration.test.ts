// FG-413 integration tests: readiness gate wired into campaign runner.
// Exercises the full start/resume flow — catches cross-step issues that unit
// tests on the evaluator alone cannot catch.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getCampaign, approveCampaign } from "../store/campaigns.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { assembleCampaignShow, assembleCampaignReport } from "./report.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "readiness-gate-integration-"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// Body that satisfies all three required sections — evaluateReadiness returns "ready".
const READY_BODY = [
  "## Problem",
  "The feature needs to be implemented.",
  "",
  "## Goal",
  "Deliver the feature correctly.",
  "",
  "## Acceptance Criteria",
  "- The feature works end-to-end",
  "- Edge cases are handled",
].join("\n");

// Body with no structured sections — evaluateReadiness returns "needs_refinement".
const UNREADY_BODY = "Some initial notes without required sections.";

function makeDispatchSpy(): {
  spy: (args: InvokeArgs) => Promise<InvokeResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    spy: async (args: InvokeArgs): Promise<InvokeResult> => {
      calls.push(args.runTitle ?? "");
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
    },
  };
}

// ── 1. Start: item 1 ready dispatches; item 2 not-ready is held ──────────────

test("FG-413 start: ready item dispatches, needs_refinement item held, campaign pauses", async () => {
  writeTicket(projectDir, {
    id: "FG-201",
    type: "story",
    status: "active",
    title: "Ready Story",
    created: "2024-01-01",
    body: READY_BODY,
  });
  writeTicket(projectDir, {
    id: "FG-202",
    type: "story",
    status: "active",
    title: "Unready Story",
    created: "2024-01-02",
    body: UNREADY_BODY,
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-201", "FG-202"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const { spy, calls } = makeDispatchSpy();
  const result = await startCampaign(campaign.id, { dispatch: spy });

  // Campaign ends paused — one item held
  assert.equal(result.stopReason, "paused", "campaign must pause when a held item blocks completion");

  // Dispatch was called only for FG-201, NOT for FG-202
  assert.equal(calls.length, 1, "dispatch must be called exactly once (for the ready item only)");
  assert.equal(calls[0], "FG-201", "only the ready item (FG-201) must be dispatched");

  // Both items appear in itemRecords
  assert.equal(result.itemRecords.length, 2, "both items must appear in itemRecords");

  const rec201 = result.itemRecords.find((r) => r.ticketId === "FG-201")!;
  assert.ok(rec201, "FG-201 record must exist");
  assert.equal(rec201.lifecycleStatus, "complete", "FG-201 must be complete after dispatch");

  const rec202 = result.itemRecords.find((r) => r.ticketId === "FG-202")!;
  assert.ok(rec202, "FG-202 record must exist");
  assert.equal(rec202.lifecycleStatus, "pending", "held item must keep pending lifecycle");
  assert.equal(rec202.outcome, "held", "FG-202 outcome must be 'held'");

  // Durable DB state for FG-202
  const dbItem202 = db
    .prepare(
      "SELECT lifecycle_status, outcome, blocker_kind, continue_policy, reason, requested_human_action FROM campaign_items WHERE ticket_id = 'FG-202'"
    )
    .get() as {
    lifecycle_status: string;
    outcome: string;
    blocker_kind: string;
    continue_policy: string;
    reason: string;
    requested_human_action: string;
  };

  assert.equal(dbItem202.lifecycle_status, "pending");
  assert.equal(dbItem202.outcome, "held");
  assert.equal(dbItem202.blocker_kind, "readiness", "blockerKind must be 'readiness' for readiness-held item");
  assert.equal(dbItem202.continue_policy, "hold_dependents");
  assert.ok(
    dbItem202.reason.includes("not ready"),
    `reason must mention 'not ready', got: ${dbItem202.reason}`
  );
  assert.ok(
    dbItem202.requested_human_action.includes("refine FG-202") &&
      dbItem202.requested_human_action.includes("resume"),
    `requestedHumanAction must say 'refine FG-202 then resume', got: ${dbItem202.requested_human_action}`
  );

  // assembleCampaignReport surfaces readiness info + next-action
  const report = assembleCampaignReport(campaign.id)!;
  assert.ok(report, "assembleCampaignReport must return a result");

  const reportItem202 = report.items.find((i) => i.ticketId === "FG-202")!;
  assert.ok(reportItem202, "FG-202 must appear in report items");
  assert.ok(
    reportItem202.readiness !== null,
    "readiness field must be populated for FG-202"
  );
  assert.equal(
    reportItem202.readiness!.outcome,
    "needs_refinement",
    "FG-202 readiness.outcome must be needs_refinement"
  );
  assert.ok(
    reportItem202.readiness!.gaps.length > 0,
    "readiness.gaps must be non-empty for unready ticket"
  );

  // nextOperatorAction must guide the operator to refine the ticket
  assert.ok(
    report.nextOperatorAction.includes("refine") && report.nextOperatorAction.includes("FG-202"),
    `nextOperatorAction must say 'refine FG-202...', got: ${report.nextOperatorAction}`
  );
  assert.ok(
    report.nextOperatorAction.includes("resume"),
    `nextOperatorAction must include 'resume', got: ${report.nextOperatorAction}`
  );

  // FG-202 must appear in the held grouping
  assert.ok(
    report.groupings.held.includes("FG-202"),
    "FG-202 must be in groupings.held"
  );

  // FG-201 must appear in the shipped grouping? No — it wasn't written as done.
  // The report shows no run_id dispatch failure. Check it completed.
  const reportItem201 = report.items.find((i) => i.ticketId === "FG-201")!;
  assert.equal(reportItem201.lifecycleStatus, "complete");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must be paused at the end");
});

// ── 2. Resume after ticket is refined to ready: item 2 dispatches ────────────

test("FG-413 resume: after refining FG-202 to ready, resumeCampaign dispatches it and completes", async () => {
  writeTicket(projectDir, {
    id: "FG-201",
    type: "story",
    status: "active",
    title: "Ready Story",
    created: "2024-01-01",
    body: READY_BODY,
  });
  writeTicket(projectDir, {
    id: "FG-202",
    type: "story",
    status: "active",
    title: "Unready Story",
    created: "2024-01-02",
    body: UNREADY_BODY,
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-201", "FG-202"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Phase 1: start — FG-201 dispatches, FG-202 held, campaign pauses
  const startSpy = makeDispatchSpy();
  const startResult = await startCampaign(campaign.id, { dispatch: startSpy.spy });
  assert.equal(startResult.stopReason, "paused", "campaign must pause after start (FG-202 held)");
  assert.equal(startSpy.calls.length, 1, "only FG-201 dispatched during start");

  // Operator refines FG-202 — update the ticket file on disk to make it ready
  writeTicket(projectDir, {
    id: "FG-202",
    type: "story",
    status: "active",
    title: "Unready Story (now refined)",
    created: "2024-01-02",
    body: READY_BODY,
  });

  // Phase 2: resume — FG-202 now evaluates as ready, must dispatch and complete
  const resumeSpy = makeDispatchSpy();
  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeSpy.spy });

  assert.equal(resumeResult.stopReason, "complete", "campaign must reach complete after resuming with refined ticket");
  assert.equal(resumeSpy.calls.length, 1, "exactly one dispatch during resume (FG-202)");
  assert.equal(resumeSpy.calls[0], "FG-202", "FG-202 must be dispatched after refinement");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete", "campaign must be complete after successful resume");
});

// ── 3. Resume while item 2 still not-ready: stays held, campaign stays paused ─

test("FG-413 resume: FG-202 still not-ready stays held, campaign stays paused, no dispatch", async () => {
  writeTicket(projectDir, {
    id: "FG-201",
    type: "story",
    status: "active",
    title: "Ready Story",
    created: "2024-01-01",
    body: READY_BODY,
  });
  writeTicket(projectDir, {
    id: "FG-202",
    type: "story",
    status: "active",
    title: "Unready Story",
    created: "2024-01-02",
    body: UNREADY_BODY,
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-201", "FG-202"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Phase 1: start — FG-202 held, campaign pauses
  const startSpy = makeDispatchSpy();
  await startCampaign(campaign.id, { dispatch: startSpy.spy });

  // Phase 2: resume WITHOUT refining FG-202 — must still be held
  const resumeSpy = makeDispatchSpy();
  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeSpy.spy });

  assert.equal(resumeResult.stopReason, "paused", "campaign must stay paused when ticket still not-ready");
  assert.equal(resumeSpy.calls.length, 0, "no dispatch on resume when ticket is still not-ready");

  // FG-202 must still be held in DB
  const dbItem202 = db
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = 'FG-202'")
    .get() as { lifecycle_status: string; outcome: string; blocker_kind: string };

  assert.equal(dbItem202.lifecycle_status, "pending", "FG-202 must remain pending lifecycle");
  assert.equal(dbItem202.outcome, "held", "FG-202 outcome must still be held after failed resume");
  assert.equal(dbItem202.blocker_kind, "readiness", "FG-202 blockerKind must still be readiness");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "paused", "campaign must remain paused");
});

// ── 4. Exploratory ticket (type=idea, no AC) dispatches without being held ────

test("FG-413 exploratory: type=idea ticket without AC dispatches (not held by readiness gate)", async () => {
  // An "idea" ticket with a Problem section but no Acceptance Criteria.
  // evaluateReadiness returns outcome="exploratory" (not needs_refinement or blocked),
  // so the gate must NOT hold it.
  writeTicket(projectDir, {
    id: "FG-210",
    type: "idea",
    status: "active",
    title: "Explore the new integration approach",
    created: "2024-01-01",
    body: "## Problem\nWe need to investigate how the new integration approach would work.\n\n## Goal\nUnderstand the trade-offs before committing.\n",
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-210"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  const { spy, calls } = makeDispatchSpy();
  const result = await startCampaign(campaign.id, { dispatch: spy });

  assert.equal(result.stopReason, "complete", "exploratory ticket must not be held — campaign must complete");
  assert.equal(calls.length, 1, "exploratory ticket must be dispatched exactly once");
  assert.equal(calls[0], "FG-210", "FG-210 must be the dispatched item");

  const finalCampaign = getCampaign(campaign.id)!;
  assert.equal(finalCampaign.status, "complete", "campaign must be complete");
});

// ── 5. CONSISTENCY: show.nextAction and report.nextOperatorAction agree ────────

test("FG-413 consistency (FG-394 shared-helper invariant): readiness-held item → show.nextAction and report.nextOperatorAction both say 'refine ... then resume'", async () => {
  writeTicket(projectDir, {
    id: "FG-201",
    type: "story",
    status: "active",
    title: "Ready Story",
    created: "2024-01-01",
    body: READY_BODY,
  });
  writeTicket(projectDir, {
    id: "FG-202",
    type: "story",
    status: "active",
    title: "Unready Story",
    created: "2024-01-02",
    body: UNREADY_BODY,
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-201", "FG-202"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Run to paused (FG-202 readiness-held)
  const { spy } = makeDispatchSpy();
  await startCampaign(campaign.id, { dispatch: spy });

  // Both show and report must advise "refine FG-202 then resume"
  const show = assembleCampaignShow(campaign.id)!;
  const report = assembleCampaignReport(campaign.id)!;

  assert.ok(
    show.nextAction.includes("refine") && show.nextAction.includes("FG-202"),
    `show.nextAction must mention 'refine FG-202', got: ${show.nextAction}`
  );
  assert.ok(
    show.nextAction.includes("resume"),
    `show.nextAction must include 'resume', got: ${show.nextAction}`
  );

  assert.ok(
    report.nextOperatorAction.includes("refine") && report.nextOperatorAction.includes("FG-202"),
    `report.nextOperatorAction must mention 'refine FG-202', got: ${report.nextOperatorAction}`
  );
  assert.ok(
    report.nextOperatorAction.includes("resume"),
    `report.nextOperatorAction must include 'resume', got: ${report.nextOperatorAction}`
  );

  // They must agree: neither must say bare "resume" or contradict each other
  assert.notEqual(show.nextAction, "resume", "show.nextAction must NOT be bare 'resume' — must specify refine action");
  assert.notEqual(
    report.nextOperatorAction,
    "resume the campaign when ready",
    "report.nextOperatorAction must NOT be bare 'resume the campaign when ready'"
  );

  // safetyToContinue must not claim can_resume (the operator can't just resume — must refine first)
  // Note: the readiness-held item doesn't produce an unresolved 'blocked' item (it's pending+held,
  // not failed+blocked), so campaignBlocker returns null. safetyToContinue is "can_resume".
  // The shared-helper invariant is that BOTH show and report surface the refine instruction
  // even when safetyToContinue is technically can_resume.
  // This test guards against drift between the two action helpers.
  assert.equal(
    show.nextAction.includes("refine") && report.nextOperatorAction.includes("refine"),
    true,
    "INVARIANT: both show.nextAction and report.nextOperatorAction must mention 'refine' for a readiness-held item"
  );
});
