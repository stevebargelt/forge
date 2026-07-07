// Integration tests for campaign workflow execution machinery (FG-423).
// Verifies driveWorkflowItem's drive loop, gate-type branching, and
// reconcileTerminalOutcome via injectable runNextFn / gateFn / loadWorkflowFn.
// No real Docker or workflow YAML files are needed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { planCampaign } from "../planner.js";
import { approveCampaign, getCampaign, listCampaignItems } from "../../store/campaigns.js";
import { startCampaign, setExecutorDoneAuditMapForTest } from "../executor.js";
import { insertTask, getTask, markTaskComplete } from "../../store/tasks.js";
import { insertVerdict } from "../../store/verdicts.js";
import { logEvent } from "../../store/events.js";
import { updateRunStatus } from "../../store/runs.js";
import { nowIso } from "../../util/ids.js";
import { writeTicket } from "../../backlog/structured.js";
import type { RunNextResult } from "../../v2/runNext.js";
import type { Workflow } from "../../v2/schema.js";
import type { GateDecision } from "../../types/index.js";
import type { GateOptions, GateResult } from "../../v2/gate.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "executor-workflow-"));

  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    created: "2024-01-01",
    body: "## Problem\nStory needs implementation.\n\n## Goal\nComplete the story.\n\n## Acceptance Criteria\n- Story is complete\n",
  });

  // Default: inject a passing done-audit for FG-101 so happy-path shipped assertions work
  // without real git/filesystem access. Override per-test when testing done-audit failure.
  setExecutorDoneAuditMapForTest(new Map([
    ["FG-101", { outcome: "pass", checks: [], gaps: [], requestedAction: null }],
  ]));
});

afterEach(() => {
  setExecutorDoneAuditMapForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// ── Workflow fixtures ─────────────────────────────────────────────────────────

const SIMPLE_WORKFLOW: Workflow = {
  name: "feature",
  description: "simple one-step workflow for tests",
  inputs: [],
  steps: [{
    id: "engineer",
    agent: "engineer",
    runtime: "claude",
    depends_on: [],
    gate: "auto",
    reds: [],
    manual: false,
  }],
};

// Requires a 'brief' input — mirrors the real seeds/workflows/feature.yml shape.
const BRIEF_REQUIRED_WORKFLOW: Workflow = {
  name: "feature",
  description: "workflow requiring brief input for tests",
  inputs: [{ name: "brief", required: true, type: "text", help: "What you want built." }],
  steps: [{
    id: "engineer",
    agent: "engineer",
    runtime: "claude",
    depends_on: [],
    gate: "auto",
    reds: [],
    manual: false,
  }],
};

// Requires an input the executor never supplies — forces startRun to throw.
const REQUIRES_UNMET_INPUT_WORKFLOW: Workflow = {
  name: "feature",
  description: "workflow with an unsupplied required input",
  inputs: [{ name: "custom_required_input", required: true, type: "text", help: "Never supplied by executor." }],
  steps: [{
    id: "engineer",
    agent: "engineer",
    runtime: "claude",
    depends_on: [],
    gate: "auto",
    reds: [],
    manual: false,
  }],
};

const VERDICT_GATE_WORKFLOW: Workflow = {
  name: "feature",
  description: "workflow with verdict gate for tests",
  inputs: [],
  steps: [{
    id: "engineer",
    agent: "engineer",
    runtime: "claude",
    depends_on: [],
    gate: "verdict",
    reds: [{ agent: "shipping-reviewer", authority: "authoritative", gate_on_verdict: true }],
    manual: false,
  }],
};

const HUMAN_GATE_WORKFLOW: Workflow = {
  name: "feature",
  description: "workflow with human gate for tests",
  inputs: [],
  steps: [{
    id: "architect",
    agent: "architect",
    runtime: "claude",
    depends_on: [],
    gate: "human",
    reds: [],
    manual: false,
  }],
};

// ── Setup helper ──────────────────────────────────────────────────────────────

function setupCampaign() {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"] },
    { projectDir, mode: "pilot" }
  );
  approveCampaign(campaign.id, { approvedBy: "test-operator", rationale: "ok" });
  return campaign;
}

// ── Test 1: happy path — run completes with passing verdicts → shipped ────────

test("workflow item ships when run completes with passing authoritative verdict", async () => {
  const campaign = setupCampaign();

  let ranOnce = false;
  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    if (!ranOnce) {
      ranOnce = true;
      const taskId = "task-t1-eng";
      const redTaskId = "task-t1-red";
      insertTask({
        id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "complete",
        taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertTask({
        id: redTaskId, runId, phase: "engineer", agentRole: "shipping-reviewer",
        parentId: taskId, status: "complete",
        taskPackage: { taskId: redTaskId, runId, phase: "engineer", role: "shipping-reviewer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertVerdict({
        id: "verdict-t1", taskId, redTaskId, redRole: "shipping-reviewer",
        verdict: "pass", confidence: 0.95, authority: "authoritative",
        findings: [], createdAt: nowIso(),
      });
      logEvent("verdict.received", { runId, taskId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
      updateRunStatus(runId, "complete");
    }
    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: runRow?.status ?? "active" };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => SIMPLE_WORKFLOW,
    runNextFn,
  });

  assert.equal(result.stopReason, "complete", "campaign should reach complete state");
  assert.equal(result.itemRecords.length, 1);
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "complete");
});

// ── Test 2: gate:verdict pass → auto-advance, item ships ─────────────────────

test("gate:verdict auto-advance — passing verdict advances gate, item ships without human pause", async () => {
  const campaign = setupCampaign();

  let runNextCallCount = 0;
  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    runNextCallCount++;
    if (runNextCallCount === 1) {
      // First wave: produce an awaiting_gate task with a passing authoritative verdict
      const taskId = "task-t2-eng";
      const redTaskId = "task-t2-red";
      insertTask({
        id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "awaiting_gate",
        taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertTask({
        id: redTaskId, runId, phase: "engineer", agentRole: "shipping-reviewer",
        parentId: taskId, status: "complete",
        taskPackage: { taskId: redTaskId, runId, phase: "engineer", role: "shipping-reviewer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertVerdict({
        id: "verdict-t2", taskId, redTaskId, redRole: "shipping-reviewer",
        verdict: "pass", confidence: 0.9, authority: "authoritative",
        findings: [], createdAt: nowIso(),
      });
      logEvent("verdict.received", { runId, taskId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
    }
    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: runRow?.status ?? "active" };
  };

  let gateFnCallCount = 0;
  const gateFn = async (
    taskId: string,
    decision: GateDecision,
    _rationale: string | undefined,
    _opts: GateOptions = {}
  ): Promise<GateResult> => {
    gateFnCallCount++;
    if (decision === "advance") {
      markTaskComplete(taskId, null);
      const t = getTask(taskId)!;
      updateRunStatus(t.runId, "complete");
    }
    return { task: getTask(taskId)!, nextTasks: [] };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => VERDICT_GATE_WORKFLOW,
    runNextFn,
    gateFn,
  });

  assert.equal(result.stopReason, "complete", "campaign should complete — verdict gate must not pause");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");

  assert.equal(gateFnCallCount, 1, "gateFn should be called exactly once (advance)");

  // Verify the awaiting_gate task was advanced (not left in awaiting_gate)
  const engTask = db.prepare("SELECT status FROM tasks WHERE id = 'task-t2-eng'").get() as { status: string } | undefined;
  assert.equal(engTask?.status, "complete", "gate:verdict task should be advanced to complete");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "complete", "campaign must NOT be paused for a verdict:pass gate");
});

// ── Test 3: gate:human → pause, awaiting_gate item status set ────────────────

test("gate:human pause — human gate parks item and pauses campaign without calling gate()", async () => {
  const campaign = setupCampaign();

  let ranOnce = false;
  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    if (!ranOnce) {
      ranOnce = true;
      insertTask({
        id: "task-t3-arch", runId, phase: "architect", agentRole: "architect", status: "awaiting_gate",
        taskPackage: { taskId: "task-t3-arch", runId, phase: "architect", role: "architect", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
    }
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: ["architect"], failedSteps: [], runStatus: "active" };
  };

  let gateFnCallCount = 0;
  const gateFn = async (
    taskId: string,
    _decision: GateDecision,
    _rationale: string | undefined,
    _opts: GateOptions = {}
  ): Promise<GateResult> => {
    gateFnCallCount++;
    return { task: getTask(taskId)!, nextTasks: [] };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => HUMAN_GATE_WORKFLOW,
    runNextFn,
    gateFn,
  });

  assert.equal(result.stopReason, "paused", "campaign must pause at human gate");

  const items = listCampaignItems(campaign.id);
  const item = items[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "item must be in awaiting_gate state");
  assert.ok(item.requestedHumanAction?.includes("architect"), "requestedHumanAction should name the step");

  assert.equal(gateFnCallCount, 0, "gate() must NOT be called for gate:human — executor parks without advancing");

  // The awaiting_gate task must remain in awaiting_gate (not advanced)
  const archTask = db.prepare("SELECT status FROM tasks WHERE id = 'task-t3-arch'").get() as { status: string } | undefined;
  assert.equal(archTask?.status, "awaiting_gate", "task should remain awaiting_gate — human must advance manually");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused", "campaign must be paused awaiting human gate");
});

// ── Test 4: Shipping Reviewer block → blocked_by_red → paused ────────────────

test("Shipping Reviewer block — blocked_by_red task parks campaign with scope blocker", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    insertTask({
      id: "task-t4-eng", runId, phase: "engineer", agentRole: "engineer", status: "blocked_by_red",
      taskPackage: { taskId: "task-t4-eng", runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: ["engineer"], runStatus: "active" };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => SIMPLE_WORKFLOW,
    runNextFn,
  });

  assert.equal(result.stopReason, "paused");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "blocked_by_red");
  assert.equal(result.itemRecords[0]!.outcome, "blocked");
  assert.equal(result.itemRecords[0]!.blockerKind, "scope");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused");
});

// ── Test 5: abandoned run → campaign_system blocker → paused ─────────────────

test("abandoned run — campaign_system shared blocker pauses campaign with failed outcome", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    updateRunStatus(runId, "abandoned");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "abandoned" };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => SIMPLE_WORKFLOW,
    runNextFn,
  });

  assert.equal(result.stopReason, "paused", "shared blocker must pause campaign");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "failed");
  assert.equal(result.itemRecords[0]!.outcome, "blocked");
  assert.equal(result.itemRecords[0]!.blockerKind, "campaign_system");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused");
});

// ── Test 6: complete + empty verdicts → inconclusive → blocked (never shipped) ──

test("complete run with no verdicts — inconclusive aggregate maps to blocked, never shipped", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    // Mark run complete but insert NO tasks or verdicts — empty verdict set
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => SIMPLE_WORKFLOW,
    runNextFn,
  });

  assert.equal(result.stopReason, "paused", "inconclusive outcome is a shared blocker — must pause");

  const itemRecord = result.itemRecords[0]!;
  assert.equal(itemRecord.outcome, "blocked", "empty verdicts must NOT produce 'shipped'");
  assert.equal(itemRecord.lifecycleStatus, "failed", "item must be 'failed', not 'complete'");
  assert.equal(itemRecord.blockerKind, "campaign_system", "inconclusive maps to campaign_system blocker");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused");
});

// ── Test 7: brief required — executor supplies it from ticket, run starts ─────
// Regression guard for finding 1: the real feature.yml requires 'brief'.

test("workflow requiring 'brief' input — executor derives brief from ticket and run starts", async () => {
  const campaign = setupCampaign();

  let ranOnce = false;
  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    if (!ranOnce) {
      ranOnce = true;
      const taskId = "task-t7-eng";
      const redTaskId = "task-t7-red";
      insertTask({
        id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "complete",
        taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertTask({
        id: redTaskId, runId, phase: "engineer", agentRole: "shipping-reviewer",
        parentId: taskId, status: "complete",
        taskPackage: { taskId: redTaskId, runId, phase: "engineer", role: "shipping-reviewer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertVerdict({
        id: "verdict-t7", taskId, redTaskId, redRole: "shipping-reviewer",
        verdict: "pass", confidence: 0.95, authority: "authoritative",
        findings: [], createdAt: nowIso(),
      });
      logEvent("verdict.received", { runId, taskId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
      updateRunStatus(runId, "complete");
    }
    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: runRow?.status ?? "active" };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => BRIEF_REQUIRED_WORKFLOW,
    runNextFn,
  });

  assert.equal(result.stopReason, "complete", "campaign must reach complete — brief was supplied from ticket");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "complete");
});

// ── Test 8: startRun validation failure → failed/blocked/infrastructure, campaign paused ──
// Regression guard for finding 1: a startRun throw must NEVER leave campaign 'running'.

// FG-490 review (round 2, F1): a thrown startRun no longer leaves the campaign
// stuck 'running' with the item silently marked terminal-failed — the campaign
// parks (running->paused) with the ORIGINAL thrown error rethrown to the
// caller with next-action guidance rather than swallowed into the returned
// result. Unlike a thrown runNext (which parks the recoverable awaiting_gate
// shape, since a live run already exists), a thrown startRun never dispatched
// anything — there is no live run to reattach to, only a synthetic 'abandoned'
// row for traceability — so the item parks DIRECTLY at its true terminal
// state: failed/blocked/infrastructure, recoverable via `forge campaign
// retry` (see executor.ts's parkCampaignOnStartRunThrow).
test("startRun input validation failure — campaign paused with the item parked failed/blocked/infrastructure, original error rethrown", async () => {
  const campaign = setupCampaign();

  const runNextFn = async (): Promise<RunNextResult> => {
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "active" };
  };

  await assert.rejects(
    () =>
      startCampaign(campaign.id, {
        loadWorkflowFn: () => REQUIRES_UNMET_INPUT_WORKFLOW,
        runNextFn,
      }),
    (err: Error) => {
      assert.match(err.message, /custom_required_input/, "original startRun error must survive in the rethrown error");
      assert.match(err.message, /forge campaign retry/, "rethrown error must name the actual recovery verb (retry)");
      assert.match(err.message, /forge campaign resume/, "rethrown error must carry next-action guidance");
      return true;
    }
  );

  const campaignRow = getCampaign(campaign.id);
  assert.notEqual(campaignRow?.status, "running", "campaign_status must NOT be 'running' after startRun failure");
  assert.equal(campaignRow?.status, "paused");

  const items = listCampaignItems(campaign.id);
  const item = items[0]!;
  assert.equal(item.lifecycleStatus, "failed", "a thrown startRun never dispatched work — no live run to reattach to, so it parks directly at its true terminal state");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "infrastructure", "a dispatch-time failure is the transient host/environment blocker kind, making it retryable");
  assert.ok(item.requestedHumanAction?.includes("custom_required_input"), "requestedHumanAction must name the validation error");
});

// ── Test 9: done-audit fail — passing verdict with failing done-audit → blocked, not shipped ──
// Regression guard for finding 2: shipped requires BOTH verdict pass AND done-audit pass.

test("passing verdict with failing done-audit — outcome is blocked, not shipped", async () => {
  const campaign = setupCampaign();

  // Override done-audit to return failing result for FG-101
  setExecutorDoneAuditMapForTest(new Map([
    ["FG-101", { outcome: "fail", checks: [], gaps: ["ticket not closed"], requestedAction: "mark the ticket as done" }],
  ]));

  let ranOnce = false;
  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    if (!ranOnce) {
      ranOnce = true;
      const taskId = "task-t9-eng";
      const redTaskId = "task-t9-red";
      insertTask({
        id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "complete",
        taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertTask({
        id: redTaskId, runId, phase: "engineer", agentRole: "shipping-reviewer",
        parentId: taskId, status: "complete",
        taskPackage: { taskId: redTaskId, runId, phase: "engineer", role: "shipping-reviewer", inputs: {}, composedSystemPrompt: "" },
        createdAt: nowIso(),
      });
      insertVerdict({
        id: "verdict-t9", taskId, redTaskId, redRole: "shipping-reviewer",
        verdict: "pass", confidence: 0.95, authority: "authoritative",
        findings: [], createdAt: nowIso(),
      });
      logEvent("verdict.received", { runId, taskId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
      updateRunStatus(runId, "complete");
    }
    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: runRow?.status ?? "active" };
  };

  const result = await startCampaign(campaign.id, {
    loadWorkflowFn: () => SIMPLE_WORKFLOW,
    runNextFn,
  });

  assert.equal(result.stopReason, "paused", "done-audit fail is a shared blocker — must pause");

  const itemRecord = result.itemRecords[0]!;
  assert.notEqual(itemRecord.outcome, "shipped", "passing verdict with failing done-audit must NOT be 'shipped'");
  assert.equal(itemRecord.outcome, "blocked");
  assert.equal(itemRecord.lifecycleStatus, "failed");
  assert.equal(itemRecord.blockerKind, "campaign_system");

  const campaignRow = getCampaign(campaign.id);
  assert.equal(campaignRow?.status, "paused");
});

// ── FG-427: drive-path reconciliation honors per-task supersession ───────────
// reconcileTerminalOutcome now derives its outcome from evaluateAuthoritativeOutcome
// over the run's verdict.received/gate.decided events (collectAuthoritativeEvents),
// instead of a naive aggregateVerdicts(verdictsForRun(...)) over every verdict ever
// recorded — so a later authoritative pass, or a qualifying force-advance, on the
// SAME reviewing task can supersede an earlier authoritative fail.

test("FG-427: fail/authoritative then later pass/authoritative on the same task reconciles to shipped (drive path)", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    logEvent("verdict.received", { runId, taskId: "task-fg427-a", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
    logEvent("verdict.received", { runId, taskId: "task-fg427-a", payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };

  const result = await startCampaign(campaign.id, { loadWorkflowFn: () => SIMPLE_WORKFLOW, runNextFn });

  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");
});

test("FG-427: fail/authoritative then later qualifying force-advance on the same task reconciles to shipped (drive path)", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    logEvent("verdict.received", { runId, taskId: "task-fg427-b", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
    logEvent("gate.decided", { runId, taskId: "task-fg427-b", payload: { decision: "advance", rationale: "operator override: verified out of band", force: true } });
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };

  const result = await startCampaign(campaign.id, { loadWorkflowFn: () => SIMPLE_WORKFLOW, runNextFn });

  assert.equal(result.stopReason, "complete");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");
});

test("FG-427: unresolved, un-overridden authoritative fail still blocks with blockerKind scope (regression, drive path)", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    logEvent("verdict.received", { runId, taskId: "task-fg427-c", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };

  const result = await startCampaign(campaign.id, { loadWorkflowFn: () => SIMPLE_WORKFLOW, runNextFn });

  // blockerKind 'scope' is not a shared blocker (see policy.ts SHARED_BLOCKER_KINDS)
  // — with a single item and nothing depending on it, the campaign itself still
  // completes; the regression assertion is on the ITEM's outcome, not the campaign's.
  const itemRecord = result.itemRecords[0]!;
  assert.equal(itemRecord.outcome, "blocked");
  assert.equal(itemRecord.lifecycleStatus, "failed");
  assert.equal(itemRecord.blockerKind, "scope");

  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.requestedHumanAction, "workflow completed but authoritative reviewer verdict failed");
});

test("FG-427: a force-advance without rationale, or a non-force advance, does NOT supersede a prior authoritative fail — still blocks", async () => {
  const campaignNoRationale = setupCampaign();
  const runNextFnNoRationale = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    logEvent("verdict.received", { runId, taskId: "task-fg427-d1", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
    logEvent("gate.decided", { runId, taskId: "task-fg427-d1", payload: { decision: "advance", rationale: "", force: true } });
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };
  const resultNoRationale = await startCampaign(campaignNoRationale.id, { loadWorkflowFn: () => SIMPLE_WORKFLOW, runNextFn: runNextFnNoRationale });
  assert.equal(resultNoRationale.itemRecords[0]!.outcome, "blocked", "force-advance without rationale must not supersede a fail");
  assert.equal(resultNoRationale.itemRecords[0]!.blockerKind, "scope");

  const campaignNonForce = setupCampaign();
  const runNextFnNonForce = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    logEvent("verdict.received", { runId, taskId: "task-fg427-d2", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
    logEvent("gate.decided", { runId, taskId: "task-fg427-d2", payload: { decision: "advance", rationale: "human said ok, but forgot --force", force: false } });
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };
  const resultNonForce = await startCampaign(campaignNonForce.id, { loadWorkflowFn: () => SIMPLE_WORKFLOW, runNextFn: runNextFnNonForce });
  assert.equal(resultNonForce.itemRecords[0]!.outcome, "blocked", "a non-force advance must not supersede a fail");
  assert.equal(resultNonForce.itemRecords[0]!.blockerKind, "scope");
});

test("FG-427: standalone force-advance with rationale but ZERO authoritative verdicts still blocks (abuse gap closed, drive path)", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    logEvent("gate.decided", { runId, taskId: "task-fg427-e", payload: { decision: "advance", rationale: "trust me", force: true } });
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };

  const result = await startCampaign(campaign.id, { loadWorkflowFn: () => SIMPLE_WORKFLOW, runNextFn });

  assert.equal(result.stopReason, "paused");
  const itemRecord = result.itemRecords[0]!;
  assert.equal(itemRecord.outcome, "blocked");
  assert.equal(itemRecord.blockerKind, "campaign_system", "a force-advance alone can never substitute for authoritative review");

  const items = listCampaignItems(campaign.id);
  assert.ok(
    items[0]!.requestedHumanAction?.includes("no authoritative reviewer verdicts found"),
    "must read as 'no authoritative reviewer verdicts', not a scope fail"
  );
});

test("FG-427: run-wide masking regression — task A later authoritative pass, task B unresolved un-overridden authoritative fail in the SAME run -> overall blocked, never masked (drive path)", async () => {
  const campaign = setupCampaign();

  const runNextFn = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    logEvent("verdict.received", { runId, taskId: "task-fg427-f-a", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
    logEvent("verdict.received", { runId, taskId: "task-fg427-f-a", payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
    logEvent("verdict.received", { runId, taskId: "task-fg427-f-b", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
    updateRunStatus(runId, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };

  const result = await startCampaign(campaign.id, { loadWorkflowFn: () => SIMPLE_WORKFLOW, runNextFn });

  const itemRecord = result.itemRecords[0]!;
  assert.equal(itemRecord.outcome, "blocked", "task A's later pass must never mask task B's unresolved fail");
  assert.equal(itemRecord.blockerKind, "scope");
});
