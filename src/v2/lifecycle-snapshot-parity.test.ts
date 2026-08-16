// FG-718 (FG-477 child C) PARITY test.
//
// The consolidation moved ready-queue.ts's private lifecycle logic behind ONE
// pure provider (evaluateLifecycle) and reduced computeReadyQueue / isRunSettled
// / classifyRunTerminalState to thin projections of its snapshot. This test pins
// that the migration is BYTE-FOR-BYTE behavior-preserving: over a representative
// matrix of task shapes, each public decision equals a FROZEN reference copy of
// the pre-refactor implementation (embedded below, verbatim). If a future edit to
// the provider changes a public decision, this test fails.
//
// The reference reuses the classifier primitives (classifyTaskLineage,
// isWorkflowPrimaryRow, isAdHocInvokeRow, isOnRejectRecoveryRow,
// resolveCompletedPhasePrimary) — those are UNCHANGED by this slice, so cloning
// them would test nothing. Only the lifecycle derivations that moved are frozen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReadyQueue, isRunSettled, classifyRunTerminalState } from "./ready-queue.js";
import {
  classifyTaskLineage,
  isAdHocInvokeRow,
  isOnRejectRecoveryRow,
  isWorkflowPrimaryRow,
  resolveCompletedPhasePrimary,
  type LineageKind,
} from "./lifecycle-evaluator.js";
import type { Workflow, Step } from "./schema.js";
import type { Task, TaskPackage } from "../types/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkWorkflow(steps: Workflow["steps"]): Workflow {
  return { name: "test", description: "test", review_mode: "legacy_verdict", inputs: [], steps };
}

function mkStep(id: string, depends_on: string[] = [], redAgents: string[] = []): Step {
  return {
    id,
    agent: "test-agent",
    gate: "auto",
    manual: false,
    depends_on,
    runtime: "claude",
    reds: redAgents.map((agent) => ({ agent, authority: "specialist", gate_on_verdict: true })),
  };
}

const STUB_TP: TaskPackage = {
  taskId: "t-stub",
  runId: "r-stub",
  phase: "p",
  role: "r",
  inputs: {},
  composedSystemPrompt: "",
};

function mkTask(opts: {
  id: string;
  phase: string;
  status: Task["status"];
  parentId?: string;
  createdAt?: string;
  agentRole?: string;
  inputs?: TaskPackage["inputs"];
  dispatchSource?: TaskPackage["dispatchSource"];
}): Task {
  const taskPackage: TaskPackage = {
    ...STUB_TP,
    ...(opts.inputs ? { inputs: opts.inputs } : {}),
    ...(opts.dispatchSource ? { dispatchSource: opts.dispatchSource } : {}),
  };
  return {
    id: opts.id,
    runId: "r1",
    parentId: opts.parentId,
    phase: opts.phase,
    agentRole: opts.agentRole ?? "test-agent",
    status: opts.status,
    taskPackage,
    createdAt: opts.createdAt ?? "2026-05-13T00:00:00.000Z",
  };
}

function mkAdHocTask(id: string, status: Task["status"], parentId?: string): Task {
  return mkTask({ id, phase: "task", status, dispatchSource: "invoke", ...(parentId ? { parentId } : {}) });
}

function mkRecovery(id: string, phase: string, status: Task["status"], parentId: string, createdAt?: string): Task {
  return mkTask({ id, phase, status, parentId, createdAt, inputs: { rejectedTaskId: parentId } });
}

// ---------------------------------------------------------------------------
// FROZEN reference implementation — verbatim copy of ready-queue.ts BEFORE FG-718.
// ---------------------------------------------------------------------------

const COMPLETE_LIKE: ReadonlySet<string> = new Set(["complete"]);
type StepSettleState = "complete" | "active" | "blocked";

function refHasCompletePrimary(tasks: Task[]): boolean {
  return tasks.some((t) => COMPLETE_LIKE.has(t.status));
}

function refHasLiveAdHocInvokeTask(tasks: Task[]): boolean {
  return tasks.some(
    (t) =>
      t.parentId === undefined &&
      isAdHocInvokeRow(t) &&
      t.status !== "complete" &&
      t.status !== "failed",
  );
}

function refComputeReadyQueue(workflow: Workflow, tasks: Task[]): Step[] {
  const kinds = classifyTaskLineage(workflow, tasks);
  const kindOf = (t: Task): LineageKind => kinds.get(t.id)!;

  const tasksByPhase = new Map<string, Task[]>();
  for (const t of tasks) {
    if (kindOf(t) === "adhoc_invoke") continue;
    const arr = tasksByPhase.get(t.phase) ?? [];
    arr.push(t);
    tasksByPhase.set(t.phase, arr);
  }

  const ready: Step[] = [];
  for (const step of workflow.steps) {
    const existing = tasksByPhase.get(step.id) ?? [];
    const hasLiveRecovery = existing.some(
      (t) => t.status === "pending" && kindOf(t) === "on_reject_recovery",
    );
    if (resolveCompletedPhasePrimary(existing, step.id) !== undefined && !hasLiveRecovery) continue;

    const attempts = existing.filter(
      (t) => isWorkflowPrimaryRow(kindOf(t)) || kindOf(t) === "on_reject_recovery",
    );
    if (attempts.length > 0 && !attempts.some((t) => t.status === "pending")) continue;

    const depsMet = step.depends_on.every(
      (depId) => resolveCompletedPhasePrimary(tasksByPhase.get(depId) ?? [], depId) !== undefined,
    );

    if (depsMet) ready.push(step);
  }

  return ready;
}

function refComputeStepSettleStates(workflow: Workflow, tasks: Task[]): Map<string, StepSettleState> {
  const tasksByPhase = new Map<string, Task[]>();
  const recoveryTasksByPhase = new Map<string, Task[]>();
  const kinds = classifyTaskLineage(workflow, tasks);
  for (const t of tasks) {
    const kind = kinds.get(t.id)!;
    if (kind === "adhoc_invoke") continue;
    if (kind === "on_reject_recovery") {
      const arr = recoveryTasksByPhase.get(t.phase) ?? [];
      arr.push(t);
      recoveryTasksByPhase.set(t.phase, arr);
      continue;
    }
    if (!isWorkflowPrimaryRow(kind)) continue;
    const arr = tasksByPhase.get(t.phase) ?? [];
    arr.push(t);
    tasksByPhase.set(t.phase, arr);
  }
  const stepsById = new Map(workflow.steps.map((s) => [s.id, s]));
  const states = new Map<string, StepSettleState>();

  function resolve(stepId: string): StepSettleState {
    const cached = states.get(stepId);
    if (cached) return cached;
    states.set(stepId, "active");

    const step = stepsById.get(stepId);
    const primaries = tasksByPhase.get(stepId) ?? [];
    const recoveryTasks = recoveryTasksByPhase.get(stepId) ?? [];

    let state: StepSettleState;
    if (recoveryTasks.some((t) => t.status !== "failed" && !COMPLETE_LIKE.has(t.status))) {
      state = "active";
    } else if (refHasCompletePrimary(primaries)) {
      state = "complete";
    } else if (primaries.some((t) => t.status !== "failed")) {
      state = "active";
    } else if (!step) {
      state = "active";
    } else {
      const depStates = step.depends_on.map((depId) => resolve(depId));
      if (depStates.some((s) => s === "blocked")) {
        state = "blocked";
      } else if (depStates.every((s) => s === "complete")) {
        state = primaries.length === 0 ? "active" : "blocked";
      } else {
        state = "active";
      }
    }

    states.set(stepId, state);
    return state;
  }

  for (const step of workflow.steps) resolve(step.id);
  return states;
}

function refIsRunSettled(workflow: Workflow, tasks: Task[]): boolean {
  if (refHasLiveAdHocInvokeTask(tasks)) return false;
  const states = refComputeStepSettleStates(workflow, tasks);
  for (const state of states.values()) {
    if (state === "active") return false;
  }
  return true;
}

type RunTerminalClassification = {
  status: "complete" | "failed";
  failedPhases: string[];
  unreachablePhases: string[];
};

function refClassifyRunTerminalState(
  workflow: Workflow | undefined,
  tasks: Task[],
): RunTerminalClassification | null {
  if (!workflow || workflow.steps.length === 0) {
    return refClassifyInvokeTerminalState(tasks);
  }
  if (!refIsRunSettled(workflow, tasks)) return null;
  const states = refComputeStepSettleStates(workflow, tasks);
  const failedPhases: string[] = [];
  const unreachablePhases: string[] = [];
  for (const step of workflow.steps) {
    if (states.get(step.id) !== "blocked") continue;
    if (step.depends_on.some((depId) => states.get(depId) === "blocked")) {
      unreachablePhases.push(step.id);
    } else {
      failedPhases.push(step.id);
    }
  }
  const failed = failedPhases.length > 0 || unreachablePhases.length > 0;
  return { status: failed ? "failed" : "complete", failedPhases, unreachablePhases };
}

function refClassifyInvokeTerminalState(tasks: Task[]): RunTerminalClassification | null {
  const topLevel = tasks.filter((t) => t.parentId === undefined);
  if (topLevel.length === 0) return { status: "complete", failedPhases: [], unreachablePhases: [] };
  if (topLevel.some((t) => t.status !== "complete" && t.status !== "failed")) return null;
  const failedPhases = topLevel
    .filter(
      (t) =>
        t.status === "failed" &&
        !topLevel.some((other) => other.phase === t.phase && other.status !== "failed"),
    )
    .map((t) => t.phase);
  return failedPhases.length > 0
    ? { status: "failed", failedPhases, unreachablePhases: [] }
    : { status: "complete", failedPhases: [], unreachablePhases: [] };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

type Case = { name: string; workflow: Workflow | undefined; tasks: Task[] };

const linear = mkWorkflow([mkStep("a"), mkStep("b", ["a"]), mkStep("c", ["b"])]);
const diamond = mkWorkflow([
  mkStep("a"),
  mkStep("b", ["a"]),
  mkStep("c", ["a"]),
  mkStep("d", ["b", "c"]),
]);
const deepLinear = mkWorkflow([
  mkStep("a"),
  mkStep("b", ["a"]),
  mkStep("c", ["b"]),
  mkStep("d", ["c"]),
  mkStep("e", ["d"]),
]);
const parallelPrimaries = mkWorkflow([mkStep("a"), mkStep("b"), mkStep("join", ["a", "b"])]);
const fanoutPipeline = mkWorkflow([
  mkStep("plan"),
  {
    ...mkStep("research", ["plan"]),
    fanout: {
      from_upstream: { step: "plan", array_key: "claims", input_key: "claim" },
      max_concurrency: 2,
      failure_mode: "fail-phase",
    },
  },
  mkStep("publish", ["research"]),
]);
const withReds = mkWorkflow([mkStep("a", [], ["shipping-reviewer"])]);
const taskStep = mkWorkflow([mkStep("task"), mkStep("downstream", ["task"])]);

const cases: Case[] = [
  { name: "empty run, linear workflow", workflow: linear, tasks: [] },
  {
    name: "first wave in progress",
    workflow: linear,
    tasks: [mkTask({ id: "a1", phase: "a", status: "running" })],
  },
  {
    name: "first step complete, second ready",
    workflow: linear,
    tasks: [mkTask({ id: "a1", phase: "a", status: "complete" })],
  },
  {
    name: "all complete — run settled complete",
    workflow: linear,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "complete" }),
      mkTask({ id: "b1", phase: "b", status: "complete" }),
      mkTask({ id: "c1", phase: "c", status: "complete" }),
    ],
  },
  {
    name: "failed-vs-unreachable phase split",
    workflow: linear,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "complete" }),
      mkTask({ id: "b1", phase: "b", status: "failed" }),
    ],
  },
  {
    name: "diamond one leg failed — merge unreachable",
    workflow: diamond,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "complete" }),
      mkTask({ id: "b1", phase: "b", status: "complete" }),
      mkTask({ id: "c1", phase: "c", status: "failed" }),
    ],
  },
  {
    name: "diamond both legs ready together",
    workflow: diamond,
    tasks: [mkTask({ id: "a1", phase: "a", status: "complete" })],
  },
  {
    name: "deep dependency chain propagates unreachable through three blocked ancestors",
    workflow: deepLinear,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "complete" }),
      mkTask({ id: "b1", phase: "b", status: "failed" }),
    ],
  },
  {
    name: "multiple failed primary attempts in one phase are an own failure, not active",
    workflow: linear,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "complete" }),
      mkTask({ id: "b-old", phase: "b", status: "failed", createdAt: "2026-05-13T00:00:00.000Z" }),
      mkTask({ id: "b-new", phase: "b", status: "failed", createdAt: "2026-05-13T00:00:01.000Z" }),
    ],
  },
  {
    name: "two independently failed primaries leave their join unreachable",
    workflow: parallelPrimaries,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "failed" }),
      mkTask({ id: "b1", phase: "b", status: "failed" }),
    ],
  },
  {
    name: "failed fanout parent is the failed phase and its dependent is unreachable",
    workflow: fanoutPipeline,
    tasks: [
      mkTask({ id: "plan1", phase: "plan", status: "complete" }),
      mkTask({ id: "research-parent", phase: "research", status: "failed" }),
      mkTask({ id: "research-child", phase: "research", status: "complete", parentId: "research-parent" }),
    ],
  },
  {
    name: "healed duplicate primary [complete older, failed newer] — phase closes",
    workflow: linear,
    tasks: [
      mkTask({ id: "a-old", phase: "a", status: "complete", createdAt: "2026-05-13T00:00:00.000Z" }),
      mkTask({ id: "a-new", phase: "a", status: "failed", createdAt: "2026-05-13T00:00:01.000Z" }),
    ],
  },
  {
    name: "legit retry (old failed + new pending) — still active, blocks downstream",
    workflow: linear,
    tasks: [
      mkTask({ id: "a-old", phase: "a", status: "failed", createdAt: "2026-05-13T00:00:00.000Z" }),
      mkTask({ id: "a-new", phase: "a", status: "pending", createdAt: "2026-05-13T00:00:01.000Z" }),
    ],
  },
  {
    name: "failed primary + pending red child does NOT re-admit the phase",
    workflow: withReds,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "failed" }),
      mkTask({ id: "a-red", phase: "a", status: "pending", parentId: "a1", agentRole: "shipping-reviewer" }),
    ],
  },
  {
    name: "live ad-hoc invoke — runSettled false while steps complete",
    workflow: taskStep,
    tasks: [
      mkTask({ id: "task1", phase: "task", status: "complete" }),
      mkTask({ id: "down1", phase: "downstream", status: "complete" }),
      mkAdHocTask("adhoc1", "running"),
    ],
  },
  {
    name: "terminal ad-hoc invoke row does not block settledness",
    workflow: taskStep,
    tasks: [
      mkTask({ id: "task1", phase: "task", status: "complete" }),
      mkTask({ id: "down1", phase: "downstream", status: "complete" }),
      mkAdHocTask("adhoc1", "complete"),
    ],
  },
  {
    name: "on_reject recovery to an already-complete phase re-admits + keeps active",
    workflow: linear,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "complete", createdAt: "2026-05-13T00:00:00.000Z" }),
      mkRecovery("a-rec", "a", "pending", "a1", "2026-05-13T00:00:02.000Z"),
    ],
  },
  {
    name: "on_reject recovery already complete — phase settled",
    workflow: linear,
    tasks: [
      mkTask({ id: "a1", phase: "a", status: "complete", createdAt: "2026-05-13T00:00:00.000Z" }),
      mkRecovery("a-rec", "a", "complete", "a1", "2026-05-13T00:00:02.000Z"),
    ],
  },
  { name: "empty invoke-run (undefined workflow, no tasks)", workflow: undefined, tasks: [] },
  { name: "empty-steps workflow, no tasks", workflow: mkWorkflow([]), tasks: [] },
  {
    name: "invoke-run: single complete top-level",
    workflow: undefined,
    tasks: [mkAdHocTask("i1", "complete")],
  },
  {
    name: "invoke-run: single failed top-level — run failed",
    workflow: undefined,
    tasks: [mkAdHocTask("i1", "failed")],
  },
  {
    name: "invoke-run: failed superseded by a complete in same phase",
    workflow: undefined,
    tasks: [mkAdHocTask("i1", "failed"), mkAdHocTask("i2", "complete")],
  },
  {
    name: "invoke-run: still-running top-level — not settled",
    workflow: undefined,
    tasks: [mkAdHocTask("i1", "running")],
  },
  {
    name: "ad-hoc invoke row in a `task`-declaring workflow is invisible to the queue",
    workflow: taskStep,
    tasks: [mkAdHocTask("i1", "complete")],
  },
];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

for (const c of cases) {
  test(`PARITY computeReadyQueue — ${c.name}`, () => {
    // computeReadyQueue takes a required workflow; skip the undefined-workflow cases.
    if (c.workflow === undefined) return;
    assert.deepEqual(
      computeReadyQueue(c.workflow, c.tasks),
      refComputeReadyQueue(c.workflow, c.tasks),
    );
  });

  test(`PARITY isRunSettled — ${c.name}`, () => {
    if (c.workflow === undefined) return;
    assert.equal(isRunSettled(c.workflow, c.tasks), refIsRunSettled(c.workflow, c.tasks));
  });

  test(`PARITY classifyRunTerminalState — ${c.name}`, () => {
    assert.deepEqual(
      classifyRunTerminalState(c.workflow, c.tasks),
      refClassifyRunTerminalState(c.workflow, c.tasks),
    );
  });
}
