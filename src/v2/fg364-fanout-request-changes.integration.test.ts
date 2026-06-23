// FG-364 regression: fanout request-changes lineage deadlock.
//
// When a fan-out build phase parent is blocked_by_red and the orchestrator
// issues gate(parent, "request-changes", ..., { force: true }), a new pending
// primary is created. The bug: dispatchFanoutStep selected the FIRST primary
// for the phase (the old failed/blocked one) instead of the new pending one,
// attaching retry children to the dead parent and wedging the run.
//
// Acceptance criteria tested:
//   AC-2: gate request-changes creates exactly ONE new pending primary
//   AC-3: next runNext dispatches children under the NEW parent, not the old
//   AC-4: old parent receives no new child/red tasks after request-changes
//   AC-5: if retry reds pass, the new parent completes and the workflow advances
//   AC-6: the request-changes rationale is visible on the new parent's inputs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { gate } from "./gate.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask, insertTask, setTaskStatus } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { nowIso } from "../util/ids.js";
import type { Workflow } from "./schema.js";

// ---------------------------------------------------------------------------
// Workflow: plan → build (fanout, authoritative red) → docs
// gate: auto so reds-pass → complete without a human gate advance.
// ---------------------------------------------------------------------------

const FG364_WORKFLOW: Workflow = {
  name: "fg364-fanout-request-changes",
  description: "FG-364 regression: fanout request-changes lineage fix",
  inputs: [],
  steps: [
    {
      id: "plan",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
      ],
      fanout: {
        from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
        max_concurrency: 4,
        failure_mode: "continue",
      },
    },
    {
      id: "docs",
      agent: "docs-agent",
      gate: "auto",
      manual: false,
      depends_on: ["build"],
      runtime: "claude",
      reds: [],
    },
  ],
};

// Write the workflow YAML to FORGE_HOME so gate() can load it by name.
function ensureFg364WorkflowYaml(): void {
  const fhome = process.env.FORGE_HOME!;
  const wfPath = join(fhome, "workflows", "fg364-fanout-request-changes.yml");
  if (existsSync(wfPath)) return;
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg364-fanout-request-changes
description: "FG-364 regression: fanout request-changes lineage fix"
inputs: []
steps:
  - id: plan
    agent: planner
    gate: auto
    manual: false
    depends_on: []
    runtime: claude
    reds: []
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: [plan]
    runtime: claude
    reds:
      - agent: red-wide
        authority: authoritative
        gate_on_verdict: true
    fanout:
      from_upstream:
        step: plan
        array_key: steps
        input_key: step
      max_concurrency: 4
      failure_mode: continue
  - id: docs
    agent: docs-agent
    gate: auto
    manual: false
    depends_on: [build]
    runtime: claude
    reds: []
`,
  );
}

function ensureClaudeRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: claude
description: test stub runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`,
  );
}

// DockerExec that routes by task-id prefix. redRound controls whether the
// red-wide agent passes (round 2) or fails (round 1).
function makeFg364Exec(state: { redRound: number }): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let result: unknown;
    if (taskId.startsWith("task-plan-")) {
      result = { status: "complete", steps: ["step-a", "step-b"] };
    } else if (taskId.startsWith("task-red-build-")) {
      result =
        state.redRound === 1
          ? {
              status: "complete",
              verdict: "fail",
              confidence: 0.9,
              findings: [{ severity: "high", summary: "broken", evidence: "x", hypothesis: "y" }],
            }
          : { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };
    } else if (taskId.startsWith("task-build-")) {
      result = { status: "complete", diff_summary: "implemented", files_modified: [] };
    } else if (taskId.startsWith("task-docs-")) {
      result = { status: "complete" };
    } else {
      result = { status: "complete" };
    }

    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-364: fanout request-changes — new pending primary is the live parent (not the old blocked one)", async () => {
  ensureFg364WorkflowYaml();
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: FG364_WORKFLOW,
    title: "fg364 regression test",
    inputs: {},
    projectDir: "/tmp/fg364-test-project",
  });

  const state = { redRound: 1 };
  const exec = makeFg364Exec(state);

  // Wave 1: plan dispatches and completes.
  const wave1 = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave1.completedSteps, ["plan"], "plan must complete in wave 1");

  // Wave 2: build fanout dispatches, children complete, red FAILS → parent blocked_by_red.
  const wave2 = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave2.dispatchedSteps, ["build"], "build must dispatch in wave 2");

  const tasksAfterWave2 = tasksForRun(runId);
  const buildPrimariesAfterWave2 = tasksAfterWave2.filter(
    (t) => t.phase === "build" && t.parentId === undefined,
  );
  assert.equal(buildPrimariesAfterWave2.length, 1, "exactly one build primary after wave 2");
  const oldParent = buildPrimariesAfterWave2[0]!;
  const oldParentId = oldParent.id;
  assert.equal(oldParent.status, "blocked_by_red", "old parent must be blocked_by_red after red fails");

  const childrenBeforeRC = tasksAfterWave2.filter((t) => t.parentId === oldParentId);
  const childrenBeforeRCIds = childrenBeforeRC.map((t) => t.id).sort();
  assert.ok(childrenBeforeRC.length > 0, "old parent must have children from round 1");

  // AC-2: gate request-changes must create exactly ONE new pending primary.
  const rationale = "add comprehensive error handling per red feedback";
  await gate(oldParentId, "request-changes", rationale, { force: true });

  // Old parent's aggregate result must be preserved as an audit record.
  const failedOldParent = getTask(oldParentId)!;
  assert.ok(
    failedOldParent.result !== undefined && failedOldParent.result !== null,
    "old parent must retain its aggregate result after request-changes (audit record preserved)",
  );

  const tasksAfterRC = tasksForRun(runId);
  const pendingBuildPrimaries = tasksAfterRC.filter(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "pending",
  );
  assert.equal(
    pendingBuildPrimaries.length,
    1,
    "AC-2: gate request-changes must create exactly ONE new pending build primary",
  );

  const newParent = pendingBuildPrimaries[0]!;
  const newParentId = newParent.id;
  assert.notEqual(newParentId, oldParentId, "new parent must be a different task from the old parent");

  // Old parent must be failed (superseded by gate).
  assert.equal(getTask(oldParentId)!.status, "failed", "old parent must be failed after request-changes");

  // AC-6: request-changes rationale is visible on the new parent's taskPackage.inputs.
  assert.equal(
    (newParent.taskPackage.inputs as Record<string, unknown>)["requestedChanges"],
    rationale,
    "AC-6: requestedChanges rationale must be in new parent's taskPackage.inputs",
  );

  // Wave 3: retry build with PASSING reds. The new pending parent must be the
  // live fan-out parent (FG-364 fix). Old blocked parent must not receive new work.
  state.redRound = 2;
  const wave3 = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave3.dispatchedSteps, ["build"], "build must dispatch again in wave 3");

  const tasksAfterWave3 = tasksForRun(runId);

  // AC-3: new children must attach to the NEW parent (not the old one).
  const newParentChildren = tasksAfterWave3.filter(
    (t) => t.parentId === newParentId && !t.agentRole.startsWith("red-"),
  );
  assert.ok(
    newParentChildren.length > 0,
    "AC-3: new children must be dispatched and parented to the NEW primary",
  );
  assert.ok(
    newParentChildren.every((t) => t.status === "complete"),
    "AC-3: new children must complete",
  );
  assert.ok(
    newParentChildren.every((t) => t.phase === "build"),
    "AC-3: new children must be in the build phase",
  );

  // AC-4: old parent must have the SAME children by id — no new distinct children.
  const allOldParentChildren = tasksAfterWave3.filter((t) => t.parentId === oldParentId);
  assert.deepEqual(
    allOldParentChildren.map((t) => t.id).sort(),
    childrenBeforeRCIds,
    "AC-4: old parent must have the SAME children by id — no new distinct children after request-changes",
  );

  // AC-5: new parent completes when reds pass (gate: auto + authoritative pass → complete).
  const newParentFinal = getTask(newParentId)!;
  assert.equal(
    newParentFinal.status,
    "complete",
    "AC-5: new parent must be complete when retry reds pass",
  );

  // AC-5: workflow advances — docs step dispatches after build completes.
  const wave4 = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  assert.ok(
    wave4.dispatchedSteps.includes("docs"),
    "AC-5: docs step must dispatch after build completes",
  );
  assert.equal(wave4.runStatus, "complete", "AC-5: run must reach complete after docs");

  // FG-368: superseded audit-record task must NOT inflate anyFailed.
  const completedEvent = eventsForRun(runId).find((e) => e.eventType === "run.completed");
  assert.ok(completedEvent, "FG-368: run.completed event must be emitted");
  assert.equal(
    (completedEvent!.payload as Record<string, unknown>)["anyFailed"],
    false,
    "FG-368: anyFailed must be false — superseded failed task must not count",
  );
});

test("FG-364: idempotency — repeated runNext after retry completes does not create duplicate build children", async () => {
  ensureFg364WorkflowYaml();
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: FG364_WORKFLOW,
    title: "fg364 idempotency test",
    inputs: {},
    projectDir: "/tmp/fg364-test-project",
  });

  const state = { redRound: 1 };
  const exec = makeFg364Exec(state);

  // Run to blocked_by_red state.
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // plan
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // build → blocked_by_red

  const oldParent = tasksForRun(runId).find(
    (t) => t.phase === "build" && t.parentId === undefined,
  )!;

  await gate(oldParent.id, "request-changes", "fix", { force: true });

  // Retry with passing reds.
  state.redRound = 2;
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // build retry → complete
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // docs → complete

  const buildTaskCountAfterComplete = tasksForRun(runId).filter((t) => t.phase === "build").length;

  // A second runNext on the complete run must not spawn new build tasks.
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  const buildTaskCountAfterSecond = tasksForRun(runId).filter((t) => t.phase === "build").length;

  assert.equal(
    buildTaskCountAfterSecond,
    buildTaskCountAfterComplete,
    "idempotent: no new build tasks created when runNext is called on a complete run",
  );
});

test("FG-364: single-step (non-fanout) request-changes path is not regressed", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // A simple one-step human-gate workflow to test the non-fanout request-changes path.
  const wfName = "fg364-single-step-rc";
  const fhome = process.env.FORGE_HOME!;
  const wfPath = join(fhome, "workflows", `${wfName}.yml`);
  if (!existsSync(wfPath)) {
    mkdirSync(dirname(wfPath), { recursive: true });
    writeFileSync(
      wfPath,
      `name: ${wfName}
description: single-step human-gate for request-changes regression
inputs: []
steps:
  - id: work
    agent: engineer
    gate: human
    manual: false
    depends_on: []
    runtime: claude
    reds: []
`,
    );
  }

  const singleStepWf: Workflow = {
    name: wfName,
    description: "single-step human-gate for request-changes regression",
    inputs: [],
    steps: [
      { id: "work", agent: "engineer", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
    ],
  };

  const { runId } = startRun({
    workflow: singleStepWf,
    title: "fg364 single-step regression",
    inputs: {},
    projectDir: "/tmp/fg364-test-project",
  });

  const exec = makeFg364Exec({ redRound: 1 });

  // Dispatch the single step → awaiting_gate.
  await runNext({ runId, workflow: singleStepWf, dockerExec: exec });

  const tasks1 = tasksForRun(runId);
  const work1 = tasks1.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.equal(work1.status, "awaiting_gate", "single step must reach awaiting_gate");

  // gate request-changes on the non-fanout step — must create a new pending task.
  await gate(work1.id, "request-changes", "improve the output", {});

  const tasks2 = tasksForRun(runId);
  const pendingWork = tasks2.filter(
    (t) => t.phase === "work" && t.parentId === undefined && t.status === "pending",
  );
  assert.equal(pendingWork.length, 1, "single-step request-changes must create exactly one new pending task");
  assert.equal(
    (pendingWork[0]!.taskPackage.inputs as Record<string, unknown>)["requestedChanges"],
    "improve the output",
    "single-step: requestedChanges must be in new task's inputs",
  );

  // Re-dispatch the single step — must run and complete.
  const wave2 = await runNext({ runId, workflow: singleStepWf, dockerExec: exec });
  assert.ok(
    wave2.completedSteps.includes("work") || wave2.awaitingGate.includes("work"),
    "single-step: re-dispatched task must run (not be left pending)",
  );
});

// Exec variant that returns 5 items from plan (for multi-batch tests).
function makeFg364ExecMultiBatch(state: { redRound: number }): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let result: unknown;
    if (taskId.startsWith("task-plan-")) {
      result = { status: "complete", steps: ["a", "b", "c", "d", "e"] };
    } else if (taskId.startsWith("task-red-build-")) {
      result =
        state.redRound === 1
          ? {
              status: "complete",
              verdict: "fail",
              confidence: 0.9,
              findings: [{ severity: "high", summary: "broken", evidence: "x", hypothesis: "y" }],
            }
          : { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };
    } else if (taskId.startsWith("task-build-")) {
      result = { status: "complete", diff_summary: "implemented", files_modified: [] };
    } else if (taskId.startsWith("task-docs-")) {
      result = { status: "complete" };
    } else {
      result = { status: "complete" };
    }

    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-364: re-entrancy guard — runNext with active running primary does not create duplicate wave", async () => {
  ensureFg364WorkflowYaml();
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: FG364_WORKFLOW,
    title: "fg364 reentrant guard",
    inputs: {},
    projectDir: "/tmp/fg364-test-project",
  });

  const state = { redRound: 1 };
  const exec = makeFg364Exec(state);

  // Run to blocked_by_red.
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // plan
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // build → blocked_by_red

  const blockedParent = tasksForRun(runId).find(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "blocked_by_red",
  )!;

  // Request-changes creates a new pending primary.
  await gate(blockedParent.id, "request-changes", "fix for reentrant test", { force: true });

  const newPending = tasksForRun(runId).find(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "pending",
  )!;

  // Simulate re-entrancy: the pending parent has transitioned to running and
  // a child is pending. computeReadyQueue would see the pending child and put
  // the build step back in the ready queue even though a dispatch is in flight.
  setTaskStatus(newPending.id, "running");
  const fakeChildId = "task-build-reentrant-fake-child";
  insertTask({
    id: fakeChildId,
    runId,
    parentId: newPending.id,
    phase: "build",
    agentRole: "engineer",
    status: "pending",
    taskPackage: {
      taskId: fakeChildId,
      runId,
      phase: "build",
      role: "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: nowIso(),
  });

  const buildTasksBefore = tasksForRun(runId).filter((t) => t.phase === "build");

  // runNext: computeReadyQueue sees the pending fakeChild and includes build.
  // The internal guard must detect the running parent with children and return
  // without spawning a new wave.
  const result = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });

  assert.ok(
    !result.completedSteps.includes("build"),
    "re-entrancy guard: build must not appear in completedSteps",
  );
  const buildTasksAfter = tasksForRun(runId).filter((t) => t.phase === "build");
  assert.equal(
    buildTasksAfter.length,
    buildTasksBefore.length,
    "re-entrancy guard: no new build tasks must be created",
  );
});

test("FG-364: double request-changes dedup — exactly ONE pending primary with latest rationale", async () => {
  ensureFg364WorkflowYaml();
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: FG364_WORKFLOW,
    title: "fg364 dedup test",
    inputs: {},
    projectDir: "/tmp/fg364-test-project",
  });

  const state = { redRound: 1 };
  const exec = makeFg364Exec(state);

  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // plan
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // build → blocked_by_red

  const blockedParent = tasksForRun(runId).find(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "blocked_by_red",
  )!;

  // Simulate a prior RC having already created a pending primary (e.g., a
  // concurrent or duplicate call that ran before this one). We insert it directly.
  const priorPendingId = "task-build-prior-pending-dedup";
  insertTask({
    id: priorPendingId,
    runId,
    phase: "build",
    agentRole: "engineer",
    status: "pending",
    taskPackage: {
      taskId: priorPendingId,
      runId,
      phase: "build",
      role: "engineer",
      inputs: { requestedChanges: "old rationale" },
      composedSystemPrompt: "",
    },
    createdAt: nowIso(),
  });

  // Now call gate request-changes with a new rationale. The dedup guard must
  // detect the existing pending and update it instead of creating a second one.
  await gate(blockedParent.id, "request-changes", "latest rationale", { force: true });

  const pendingPrimaries = tasksForRun(runId).filter(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "pending",
  );
  assert.equal(pendingPrimaries.length, 1, "dedup: exactly ONE pending primary must exist");
  assert.equal(
    (pendingPrimaries[0]!.taskPackage.inputs as Record<string, unknown>)["requestedChanges"],
    "latest rationale",
    "dedup: the pending primary must carry the LATEST rationale",
  );
});

test("FG-364: multi-batch fan-out — all children dispatch under new parent across batches", async () => {
  ensureFg364WorkflowYaml();
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: FG364_WORKFLOW,
    title: "fg364 multi-batch test",
    inputs: {},
    projectDir: "/tmp/fg364-test-project",
  });

  // 5 items, max_concurrency=4 → 2 batches (4 then 1).
  const state = { redRound: 1 };
  const exec = makeFg364ExecMultiBatch(state);

  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // plan (5 steps)
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec }); // build → blocked_by_red

  const oldParent = tasksForRun(runId).find(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "blocked_by_red",
  )!;
  const oldParentId = oldParent.id;

  const oldChildren = tasksForRun(runId).filter(
    (t) => t.parentId === oldParentId && !t.agentRole.startsWith("red-"),
  );
  assert.equal(oldChildren.length, 5, "5 children must have been dispatched across 2 batches");

  await gate(oldParentId, "request-changes", "fix multi-batch", { force: true });

  const newPendingParent = tasksForRun(runId).find(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "pending",
  )!;
  const newParentId = newPendingParent.id;

  // Retry with passing reds.
  state.redRound = 2;
  await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });

  const newChildren = tasksForRun(runId).filter(
    (t) => t.parentId === newParentId && !t.agentRole.startsWith("red-"),
  );
  assert.equal(
    newChildren.length,
    5,
    "all 5 children must dispatch under the NEW parent across batches",
  );
  assert.ok(
    newChildren.every((t) => t.status === "complete"),
    "all new children must complete",
  );

  // Old parent must not have gained new children.
  const oldChildrenAfter = tasksForRun(runId).filter(
    (t) => t.parentId === oldParentId && !t.agentRole.startsWith("red-"),
  );
  assert.deepEqual(
    oldChildrenAfter.map((t) => t.id).sort(),
    oldChildren.map((t) => t.id).sort(),
    "old parent must have the same children by id — no new distinct children after request-changes",
  );
});

// ---------------------------------------------------------------------------
// FG-368: anyFailed rollup correctness — negative case and child-exclusion
// ---------------------------------------------------------------------------

test("FG-368: anyFailed — genuinely failed phase with no replacement → anyFailed: true", async () => {
  // A 2-step workflow where the second step fails permanently (no request-changes,
  // no retry). The run must complete with anyFailed: true in run.completed.
  // This is the negative case that proves the FG-368 fix didn't blanket-suppress failures.

  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const GENUINE_FAILURE_WF: Workflow = {
    name: "fg368-genuine-failure",
    description: "FG-368: negative test — genuine failure produces anyFailed: true",
    inputs: [],
    steps: [
      {
        id: "setup",
        agent: "planner",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: "claude",
        reds: [],
      },
      {
        id: "work",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: ["setup"],
        runtime: "claude",
        reds: [],
      },
    ],
  };

  const { runId } = startRun({
    workflow: GENUINE_FAILURE_WF,
    title: "fg368 genuine failure test",
    inputs: {},
    projectDir: "/tmp/fg368-test-project",
  });

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-setup-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
      return 0;
    }
    // work step: exit code 1 without writing result.json → container_crash → task fails.
    // result.json was pre-initialized to "" by runContainer; the non-zero exit code +
    // empty resultRaw triggers the failure path in runContainer.
    return 1;
  };

  // Wave 1: setup dispatches and completes.
  const wave1 = await runNext({ runId, workflow: GENUINE_FAILURE_WF, dockerExec: exec });
  assert.deepEqual(wave1.completedSteps, ["setup"], "setup must complete in wave 1");

  // Wave 2: work dispatches and fails → run reaches complete with anyFailed: true.
  const wave2 = await runNext({ runId, workflow: GENUINE_FAILURE_WF, dockerExec: exec });
  assert.deepEqual(wave2.failedSteps, ["work"], "work must fail in wave 2");
  assert.equal(wave2.runStatus, "complete", "run must reach complete even when a step fails");

  // Verify the work task is truly failed in the DB.
  const workTask = tasksForRun(runId).find((t) => t.phase === "work" && t.parentId === undefined);
  assert.ok(workTask, "work task must exist");
  assert.equal(workTask!.status, "failed", "work task must be failed");

  // The run.completed event must carry anyFailed: true.
  const completedEvent = eventsForRun(runId).find((e) => e.eventType === "run.completed");
  assert.ok(completedEvent, "FG-368: run.completed event must be emitted");
  assert.equal(
    (completedEvent!.payload as Record<string, unknown>)["anyFailed"],
    true,
    "FG-368: anyFailed must be true — genuinely failed phase with no replacement must count",
  );
});

test("FG-368: anyFailed — fanout child failure with parent completing doesn't inflate anyFailed", async () => {
  // With failure_mode: "continue", a fanout child can fail while the parent still
  // completes. Children (parentId !== undefined) must NOT enter the anyFailed rollup —
  // only top-level (parentId === undefined) tasks are considered.
  //
  // The fix (runNext.ts:180-185) filters to parentId === undefined before computing
  // anyFailed. This test confirms children are excluded.

  ensureFg364WorkflowYaml();
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: FG364_WORKFLOW,
    title: "fg368 fanout child failure test",
    inputs: {},
    projectDir: "/tmp/fg368-test-project",
  });

  // Track whether the first fanout child dispatch has been seen.
  // Children have synthetic phase ids "build-0", "build-1", so their task ids
  // start with "task-build-0-" or "task-build-1-".  The parent itself never runs
  // through dockerExec (it's synthetic).  We fail the very first child; the second
  // and all reds pass.  With failure_mode: "continue" the parent still completes.
  let firstChildSeen = false;

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-plan-")) {
      // Return 2 fanout items so we get 2 children.
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", steps: ["step-a", "step-b"] }));
      return 0;
    }
    if (taskId.startsWith("task-red-build-")) {
      // Red always passes — we want the parent to complete despite the child failure.
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", verdict: "pass", confidence: 0.9, findings: [] }));
      return 0;
    }
    if (taskId.startsWith("task-build-")) {
      // First child (task-build-0-<random> OR whichever is dispatched first) fails.
      if (!firstChildSeen) {
        firstChildSeen = true;
        // Exit code 1 + empty result.json (pre-initialized to "") → container_crash → child fails.
        return 1;
      }
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", diff_summary: "ok", files_modified: [] }));
      return 0;
    }
    if (taskId.startsWith("task-docs-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
      return 0;
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    return 0;
  };

  // Wave 1: plan.
  const wave1 = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave1.completedSteps, ["plan"], "plan must complete in wave 1");

  // Wave 2: build fanout — one child fails, one succeeds, red passes.
  // With failure_mode: "continue" the parent still reaches complete.
  const wave2 = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave2.dispatchedSteps, ["build"], "build must dispatch in wave 2");

  const tasksAfterWave2 = tasksForRun(runId);
  const buildParent = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(buildParent, "build parent must exist");
  assert.equal(buildParent!.status, "complete", "build parent must be complete (failure_mode: continue + red passes)");

  const failedChildren = tasksAfterWave2.filter(
    (t) => t.parentId === buildParent!.id && t.status === "failed",
  );
  assert.ok(failedChildren.length > 0, "at least one build child must be failed");

  // Wave 3: docs dispatches and completes → run.completed emitted.
  const wave3 = await runNext({ runId, workflow: FG364_WORKFLOW, dockerExec: exec });
  assert.ok(wave3.dispatchedSteps.includes("docs"), "docs must dispatch in wave 3");
  assert.equal(wave3.runStatus, "complete", "run must reach complete");

  // The run.completed event must carry anyFailed: false.
  // Even though a child failed, children (parentId !== undefined) are excluded
  // from the rollup. Only top-level tasks count, and the build parent is complete.
  const completedEvent = eventsForRun(runId).find((e) => e.eventType === "run.completed");
  assert.ok(completedEvent, "FG-368: run.completed event must be emitted");
  assert.equal(
    (completedEvent!.payload as Record<string, unknown>)["anyFailed"],
    false,
    "FG-368: anyFailed must be false — fanout children (parentId !== undefined) are excluded from the rollup",
  );

  // Confirm: if we walked all tasks naively (including children), anyFailed would be
  // non-zero — this verifies the fix is what makes it false, not the absence of failures.
  const naiveAnyFailed = tasksAfterWave2.some((t) => t.status === "failed");
  assert.ok(naiveAnyFailed, "sanity: at least one task (a child) is failed, naive check confirms the fix matters");
});
