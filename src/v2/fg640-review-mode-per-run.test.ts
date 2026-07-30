// FG-640 migration safety: EXACTLY ONE review_mode per run, and no run that combines
// authority models.
//
// FG-638 built the reconciliation (a review's mode must equal its run's). What Change 3 adds
// is the SOURCE of that value: the workflow's declared cutover, stamped onto the run at
// creation. Both halves are proven here, because either alone is defeatable — a stamp with no
// reconciliation lets a review disagree with the run it names, and a reconciliation with no
// stamp lets whichever review is created first decide the whole run's authority model.
//
// Also here: `approvedReviewContract`, because "plan-gate-approved" is the load-bearing word
// in "risk-targeted lens selection from the plan-gate-approved contract".

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getRun, insertRun } from "../store/runs.js";
import { insertTask, markTaskComplete } from "../store/tasks.js";
import { insertGate } from "../store/gates.js";
import { insertReview } from "../store/reviews.js";
import { startRun } from "./startRun.js";
import { approvedReviewContract } from "./review-gate.js";
import { WorkflowSchema, type Workflow } from "./schema.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function workflow(reviewMode?: string): Workflow {
  const parsed = WorkflowSchema.safeParse({
    name: "wf-mode",
    description: "review-mode stamping",
    ...(reviewMode !== undefined ? { review_mode: reviewMode } : {}),
    steps: [{ id: "plan", agent: "tech-lead", gate: "human" }],
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  return parsed.data;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-640: the run is stamped with the WORKFLOW's declared review_mode at creation", () => {
  const { runId } = startRun({ workflow: workflow("evidence_led"), title: "t", inputs: {}, projectDir: "/tmp/fg640" });
  assert.equal(getRun(runId)!.reviewMode, "evidence_led");
});

test("FG-640: a workflow that declares nothing stamps legacy_verdict — silence is not migration", () => {
  const { runId } = startRun({ workflow: workflow(), title: "t", inputs: {}, projectDir: "/tmp/fg640" });
  assert.equal(getRun(runId)!.reviewMode, "legacy_verdict");
});

test("FG-640: a review cannot disagree with the run's stamped mode (FG-638 reconciliation, on a stamped run)", () => {
  const { runId } = startRun({ workflow: workflow("evidence_led"), title: "t", inputs: {}, projectDir: "/tmp/fg640" });
  assert.throws(
    () =>
      insertReview({
        id: "review-conflict",
        runId,
        reviewMode: "legacy_review_loop",
        state: "confirming_contract",
      }),
    /exactly one review_mode per run/,
  );
  // And nothing was written.
  assert.equal(getRun(runId)!.reviewMode, "evidence_led");
});

test("FG-640: a legacy_verdict run stamped by an unmigrated workflow still ADOPTS a first evidence-led review", () => {
  // FG-638's adoption path survives the stamp: a run created before anyone chose (or by a
  // workflow that declares nothing) is not a refusal for the pilot's `forge review start`.
  const { runId } = startRun({ workflow: workflow(), title: "t", inputs: {}, projectDir: "/tmp/fg640" });
  insertReview({ id: "review-adopt", runId, reviewMode: "evidence_led", state: "confirming_contract" });
  assert.equal(getRun(runId)!.reviewMode, "evidence_led");
});

// ── the plan-gate-approved contract ──────────────────────────────────────────

const CONTRACT = {
  threat_model: "t",
  protected_invariants: [],
  acceptance_refs: [],
  risk_lenses: ["backend"],
  non_goals: [],
};

function seedRunWithPlan(result: unknown, gateDecision?: "advance" | "reject"): string {
  const run: Run = { id: "run-plan", workflow: "wf", title: "t", status: "active", createdAt: "2026-07-30T00:00:00Z" };
  insertRun(run);
  const task: Task = {
    id: "task-plan",
    runId: run.id,
    phase: "plan",
    agentRole: "tech-lead",
    status: "running",
    taskPackage: { taskId: "task-plan", runId: run.id, phase: "plan", role: "tech-lead", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  insertTask(task);
  markTaskComplete("task-plan", result);
  if (gateDecision) {
    insertGate({
      id: "gate-plan",
      taskId: "task-plan",
      decision: gateDecision,
      rationale: "human",
      decidedAt: "2026-07-30T00:00:01Z",
      decidedBy: "steven",
    });
  }
  return run.id;
}

test("FG-640: an APPROVED plan's review_contract is the one selection reads", () => {
  const runId = seedRunWithPlan({ steps: [], review_contract: CONTRACT }, "advance");
  assert.deepEqual(approvedReviewContract(runId)?.contract, CONTRACT);
});

test("FG-640: an UNGATED plan's contract is a proposal, not authority — selection never sees it", () => {
  const runId = seedRunWithPlan({ steps: [], review_contract: CONTRACT });
  assert.equal(approvedReviewContract(runId), undefined);
});

test("FG-640: a REJECTED plan's contract is not approved either", () => {
  const runId = seedRunWithPlan({ steps: [], review_contract: CONTRACT }, "reject");
  assert.equal(approvedReviewContract(runId), undefined);
});

test("FG-640: a run whose plan declared no contract has none — selection falls closed to the wide panel", () => {
  const runId = seedRunWithPlan({ steps: [] }, "advance");
  assert.equal(approvedReviewContract(runId), undefined);
});
