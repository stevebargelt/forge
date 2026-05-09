import { test } from "node:test";
import assert from "node:assert/strict";
import type { Workflow, Task } from "../types/index.js";
import { buildPhaseShape, buildPhaseShapeForPhase } from "./phaseShape.js";

function task(id: string, phase: string, role: string, status: Task["status"], createdAt = "2026-05-09T00:00:00Z"): Task {
  return {
    id,
    runId: "run-1",
    phase,
    agentRole: role,
    status,
    taskPackage: { taskId: id, runId: "run-1", phase, role, inputs: {}, composedSystemPrompt: "" },
    createdAt,
  };
}

const SIMPLE_WORKFLOW: Workflow = {
  name: "investigation",
  description: "test",
  phases: [
    {
      name: "frame-question",
      agents: [{ role: "framer", agentDir: "/x", alias: "spec-writer", model: "sonnet" }],
      gate: "human",
    },
    {
      name: "investigate",
      agents: [{ role: "investigator", agentDir: "/x", alias: "spec-writer", model: "sonnet" }],
      reds: {
        wide: { role: "red-wide", agentDir: "/x", alias: "fast-orchestrator", model: "haiku" },
        parallel: true,
        authority: "specialist",
        gateOnVerdict: false,
      },
      fanout: { maxConcurrency: 4, failureMode: "continue" },
      fanoutFromUpstream: { arrayKey: "claims", inputKey: "claim" },
      gate: "human",
    },
    {
      name: "synthesize",
      agents: [{ role: "synthesizer", agentDir: "/x", alias: "spec-writer", model: "sonnet" }],
      gate: "auto",
    },
  ],
};

test("buildPhaseShape produces one entry per phase", () => {
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, []);
  assert.equal(shape.length, 3);
  assert.deepEqual(shape.map((p) => p.name), ["frame-question", "investigate", "synthesize"]);
});

test("phase with no tasks → status pending, taskCounts.total=0", () => {
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, []);
  assert.equal(shape[0]!.status, "pending");
  assert.equal(shape[0]!.taskCounts.total, 0);
});

test("phase with all-complete tasks → status done", () => {
  const tasks = [task("t1", "frame-question", "framer", "complete")];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  assert.equal(shape[0]!.status, "done");
  assert.equal(shape[0]!.taskCounts.complete, 1);
});

test("phase with running task → status running", () => {
  const tasks = [
    task("t1", "frame-question", "framer", "complete"),
    task("t2", "investigate", "investigator", "running"),
  ];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  assert.equal(shape[1]!.status, "running");
});

test("blocked_by_red beats running in attention order", () => {
  const tasks = [
    task("t1", "investigate", "investigator", "running"),
    task("t2", "investigate", "investigator", "blocked_by_red"),
  ];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  assert.equal(shape[1]!.status, "blocked_by_red");
});

test("hasFanout reflects phase.fanout or fanoutFromUpstream", () => {
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, []);
  assert.equal(shape[0]!.hasFanout, false); // frame-question
  assert.equal(shape[1]!.hasFanout, true);  // investigate
  assert.equal(shape[2]!.hasFanout, false); // synthesize
});

test("fanout phase exposes fanoutConcurrency + fanoutFromUpstream config", () => {
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, []);
  assert.equal(shape[1]!.fanoutConcurrency, 4);
  assert.deepEqual(shape[1]!.fanoutFromUpstream, { arrayKey: "claims", inputKey: "claim" });
});

test("hasReds + redsAuthority reflect phase.reds", () => {
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, []);
  assert.equal(shape[0]!.hasReds, false);
  assert.equal(shape[1]!.hasReds, true);
  assert.equal(shape[1]!.redsAuthority, "specialist");
  assert.equal(shape[1]!.redsGateOnVerdict, false);
});

test("manual phase (agents=[]) → isManual=true, agentRoles=[]", () => {
  const wf: Workflow = {
    name: "ui-design",
    description: "test",
    phases: [
      { name: "brief", agents: [{ role: "prompt-author", agentDir: "/x", alias: "spec-writer", model: "sonnet" }], gate: "human" },
      { name: "ui-review", agents: [], gate: "human", onReject: "brief" },
    ],
  };
  const shape = buildPhaseShape(wf, []);
  assert.equal(shape[1]!.isManual, true);
  assert.deepEqual(shape[1]!.agentRoles, []);
  assert.equal(shape[1]!.onReject, "brief");
});

test("fanout phase exports per-task fanoutDots in creation order", () => {
  const tasks = [
    task("t1", "investigate", "investigator", "complete", "2026-05-09T00:00:01Z"),
    task("t2", "investigate", "investigator", "complete", "2026-05-09T00:00:02Z"),
    task("t3", "investigate", "investigator", "running", "2026-05-09T00:00:03Z"),
    task("t4", "investigate", "investigator", "pending", "2026-05-09T00:00:04Z"),
  ];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  const investigate = shape[1]!;
  assert.deepEqual(investigate.fanoutDots, ["done", "done", "running", "pending"]);
});

test("non-fanout phase has no fanoutDots", () => {
  const tasks = [task("t1", "frame-question", "framer", "complete")];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  assert.equal(shape[0]!.fanoutDots, undefined);
});

test("red-prefixed agentRole tasks excluded from phase aggregate", () => {
  // Red tasks share the phase name with their blue but live as agentRole=red-*.
  // They should not influence phase status or count toward taskCounts.
  const tasks = [
    task("t1", "investigate", "investigator", "complete"),
    task("r1", "investigate", "red-wide", "running"),
    task("r2", "investigate", "red-narrow", "running"),
  ];
  const shape = buildPhaseShapeForPhase(SIMPLE_WORKFLOW.phases[1]!, tasks);
  assert.equal(shape.taskCounts.total, 1);
  assert.equal(shape.status, "done"); // running reds don't pull phase back to running
});

test("retry chain collapses to terminal task in phase aggregate", () => {
  // Original failed (t1), then retry succeeded (t2 → parentId=t1). Phase
  // aggregate should report 1/1 done, not 2 tasks with 1 failed.
  const tasks = [
    {
      id: "t1",
      runId: "run-1",
      phase: "investigate",
      agentRole: "investigator",
      status: "failed" as const,
      taskPackage: { taskId: "t1", runId: "run-1", phase: "investigate", role: "investigator", inputs: {}, composedSystemPrompt: "" },
      createdAt: "2026-05-09T00:00:01Z",
    },
    {
      id: "t2",
      runId: "run-1",
      parentId: "t1",
      phase: "investigate",
      agentRole: "investigator",
      status: "complete" as const,
      taskPackage: { taskId: "t2", runId: "run-1", phase: "investigate", role: "investigator", inputs: {}, composedSystemPrompt: "" },
      createdAt: "2026-05-09T00:00:02Z",
    },
  ];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  const investigate = shape[1]!;
  assert.equal(investigate.taskCounts.total, 1);
  assert.equal(investigate.taskCounts.complete, 1);
  assert.equal(investigate.taskCounts.failed, 0);
  assert.equal(investigate.status, "done");
  assert.deepEqual(investigate.fanoutDots, ["done"]);
});

test("retry chain that ends in failed reports failed (terminal status)", () => {
  // Original failed, retry failed too.
  const tasks = [
    {
      id: "t1", runId: "run-1", phase: "investigate", agentRole: "investigator",
      status: "failed" as const,
      taskPackage: { taskId: "t1", runId: "run-1", phase: "investigate", role: "investigator", inputs: {}, composedSystemPrompt: "" },
      createdAt: "2026-05-09T00:00:01Z",
    },
    {
      id: "t2", runId: "run-1", parentId: "t1", phase: "investigate", agentRole: "investigator",
      status: "failed" as const,
      taskPackage: { taskId: "t2", runId: "run-1", phase: "investigate", role: "investigator", inputs: {}, composedSystemPrompt: "" },
      createdAt: "2026-05-09T00:00:02Z",
    },
  ];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  const investigate = shape[1]!;
  assert.equal(investigate.taskCounts.total, 1);
  assert.equal(investigate.taskCounts.failed, 1);
  assert.equal(investigate.status, "failed");
});

test("partial-failed phase that has some complete + some failed → failed", () => {
  const tasks = [
    task("t1", "investigate", "investigator", "complete"),
    task("t2", "investigate", "investigator", "failed"),
  ];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  assert.equal(shape[1]!.status, "failed");
});

test("awaiting_gate beats pending; awaiting_human_input present", () => {
  const tasks = [
    task("t1", "frame-question", "framer", "awaiting_gate"),
  ];
  const shape = buildPhaseShape(SIMPLE_WORKFLOW, tasks);
  assert.equal(shape[0]!.status, "awaiting_gate");
});
