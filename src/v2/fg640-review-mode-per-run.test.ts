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
import { eventsForRun } from "../store/events.js";
import { approvedReviewContract, contractApprovingSteps } from "./review-gate.js";
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
  lens_scopes: { backend: ["src/"] },
};

/** architect (human) → plan (human) → build (the reviewed step, declaring plan as its upstream).
 *  `architect` is deliberately human-gated too: it is the step F1's negative case comes from. */
function reviewedWorkflow(): Workflow {
  const parsed = WorkflowSchema.safeParse({
    name: "wf-plan",
    description: "plan-gate-approved contract",
    review_mode: "evidence_led",
    steps: [
      { id: "architect", agent: "architecture-advisor", gate: "human" },
      { id: "plan", agent: "tech-lead", gate: "human", depends_on: ["architect"] },
      {
        id: "build",
        agent: "engineer",
        gate: "verdict",
        depends_on: ["plan"],
        reds: [{ agent: "red-backend", authority: "specialist", gate_on_verdict: false }],
      },
    ],
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  return parsed.data;
}

function seedTask(runId: string, phase: string, role: string, result: unknown, gateDecision?: "advance" | "reject"): void {
  const id = `task-${phase}`;
  const task: Task = {
    id,
    runId,
    phase,
    agentRole: role,
    status: "running",
    taskPackage: { taskId: id, runId, phase, role, inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  insertTask(task);
  markTaskComplete(id, result);
  if (gateDecision) {
    insertGate({
      id: `gate-${phase}`,
      taskId: id,
      decision: gateDecision,
      rationale: "human",
      decidedAt: "2026-07-30T00:00:01Z",
      decidedBy: "steven",
    });
  }
}

function seedRunWithPlan(result: unknown, gateDecision?: "advance" | "reject"): string {
  const run: Run = { id: "run-plan", workflow: "wf", title: "t", status: "active", createdAt: "2026-07-30T00:00:00Z" };
  insertRun(run);
  seedTask(run.id, "plan", "tech-lead", result, gateDecision);
  return run.id;
}

function contractFor(runId: string): { contract: unknown; taskId: string } | undefined {
  return approvedReviewContract(runId, reviewedWorkflow(), "build");
}

test("FG-640: an APPROVED plan's review_contract is the one selection reads", () => {
  const runId = seedRunWithPlan({ steps: [], review_contract: CONTRACT }, "advance");
  assert.deepEqual(contractFor(runId)?.contract, CONTRACT);
});

test("FG-640: an UNGATED plan's contract is a proposal, not authority — selection never sees it", () => {
  const runId = seedRunWithPlan({ steps: [], review_contract: CONTRACT });
  assert.equal(contractFor(runId), undefined);
});

test("FG-640: a REJECTED plan's contract is not approved either", () => {
  const runId = seedRunWithPlan({ steps: [], review_contract: CONTRACT }, "reject");
  assert.equal(contractFor(runId), undefined);
});

test("FG-640: a run whose plan declared no contract has none — selection falls closed to the wide panel", () => {
  const runId = seedRunWithPlan({ steps: [] }, "advance");
  assert.equal(contractFor(runId), undefined);
});

// ── the contract is bound to THE PLAN STEP, not to whoever wrote one ─────────

test("FG-640: a NON-PLAN advanced task's contract is ignored — an approved architect cannot select build's panel", () => {
  const runId = seedRunWithPlan({ steps: [] }, "advance");
  // A real human `advance` on a real step of this run. Everything about it is legitimate
  // except that `build` does not declare `architect` as the step it was planned by.
  seedTask(runId, "architect", "architecture-advisor", { review_contract: CONTRACT }, "advance");

  assert.equal(contractFor(runId), undefined, "a contract from another human-gated step narrowed the panel");
  const ev = eventsForRun(runId).find((e) => e.eventType === "review.contract_ignored");
  assert.ok(ev, "the refusal must be readable — a wide panel with no event looks like nobody wrote a contract");
  const payload = ev!.payload as { step: string; reviewedStep: string; approvingSteps: string[]; reason: string };
  assert.equal(payload.step, "architect");
  assert.equal(payload.reviewedStep, "build");
  assert.deepEqual(payload.approvingSteps, ["plan"]);
});

test("FG-640: the plan step's contract still wins when a non-plan task also carries one", () => {
  const runId = seedRunWithPlan({ steps: [], review_contract: CONTRACT }, "advance");
  seedTask(
    runId,
    "architect",
    "architecture-advisor",
    { review_contract: { ...CONTRACT, risk_lenses: ["frontend"], lens_scopes: { frontend: ["dashboard/"] } } },
    "advance",
  );

  assert.deepEqual(contractFor(runId)?.contract, CONTRACT, "a later task's contract superseded the approved plan's");
  assert.equal(contractFor(runId)?.taskId, "task-plan");
});

test("FG-640: the approving step is the reviewed step's DECLARED upstream — read from the workflow", () => {
  const wf = reviewedWorkflow();
  assert.deepEqual(contractApprovingSteps(wf, "build"), ["plan"], "architect is human-gated but is not build's upstream");
  assert.deepEqual(contractApprovingSteps(wf, "plan"), ["architect"]);
  assert.deepEqual(contractApprovingSteps(wf, "no-such-step"), []);
});
