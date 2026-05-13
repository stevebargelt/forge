// Tests for systemMap.ts data transformer. Pure functions over Task[] +
// PhaseShape[] — no DOM, no rendering.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskGraph, computeElkLayers } from "./systemMap.js";
import type { Task, TaskStatus } from "../types/index.js";
import type { PhaseShape } from "./phaseShape.js";

function phase(
  name: string,
  status: PhaseShape["status"],
  overrides: Partial<PhaseShape> = {}
): PhaseShape {
  return {
    name,
    agentRoles: [],
    gate: "human",
    isManual: false,
    hasFanout: false,
    hasReds: false,
    status,
    taskCounts: { total: 0, running: 0, complete: 0, failed: 0, pending: 0, awaitingGate: 0, awaitingRed: 0, awaitingHuman: 0, blockedByRed: 0 },
    ...overrides,
  };
}

let _seq = 0;
function task(
  id: string,
  phase: string,
  agentRole: string,
  status: TaskStatus,
  overrides: Partial<Task> = {}
): Task {
  _seq++;
  return {
    id,
    runId: "run-1",
    phase,
    agentRole,
    status,
    taskPackage: { taskId: id, runId: "run-1", phase, role: agentRole, inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date(_seq * 1000).toISOString(),
    ...overrides,
  };
}

// (a) one node per task
test("buildTaskGraph produces one node per task", () => {
  const tasks = [
    task("t1", "brief", "planner", "complete"),
    task("t2", "build", "implementer", "running"),
    task("t3", "build", "red-reviewer", "pending"),
  ];
  const g = buildTaskGraph(tasks, []);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.nodes.map(n => n.data.taskId).sort(), ["t1", "t2", "t3"]);
});

// (b) retry edge only when parent has same phase+role and status=failed
test("buildTaskGraph emits retry edge only when parent has same phase+role and status=failed", () => {
  const parent = task("p1", "build", "implementer", "failed");
  const retry = task("r1", "build", "implementer", "running", { parentId: "p1" });
  const unrelated = task("u1", "build", "implementer", "running", { parentId: "p1" });
  // unrelated parent is not failed — no retry edge
  const parentNotFailed = task("p2", "build", "reviewer", "complete");
  const child = task("c1", "build", "reviewer", "running", { parentId: "p2" });

  const g = buildTaskGraph([parent, retry, parentNotFailed, child, unrelated], []);
  const retryEdges = g.edges.filter(e => e.data.kind === "retry");
  // Only p1→r1 qualifies (parent failed, same phase+role). u1 has same parentId but
  // unrelated.parentId = p1 which is failed+same role+same phase, so it also qualifies.
  assert.ok(retryEdges.some(e => e.data.source === "t:p1" && e.data.target === "t:r1"));
  // c1's parent p2 is not failed → no retry
  assert.ok(!retryEdges.some(e => e.data.source === "t:p2" && e.data.target === "t:c1"));
});

// (c) red nodes have isRed=true and incoming red edge from parent
test("buildTaskGraph emits red edge for red-role tasks with parentId", () => {
  const blue = task("b1", "build", "implementer", "running");
  const red = task("r1", "build", "red-reviewer", "running", { parentId: "b1" });
  const g = buildTaskGraph([blue, red], []);
  const redNode = g.nodes.find(n => n.data.taskId === "r1");
  assert.ok(redNode, "red node exists");
  assert.equal(redNode!.data.isRed, true);
  const redEdge = g.edges.find(e => e.data.kind === "red");
  assert.ok(redEdge, "red edge exists");
  assert.equal(redEdge!.data.source, "t:b1");
  assert.equal(redEdge!.data.target, "t:r1");
});

// (d) computeElkLayers assigns red nodes same layer as parent, non-red = phase index
test("computeElkLayers assigns correct layers", () => {
  const phases = [phase("brief", "done"), phase("build", "running"), phase("review", "pending")];
  const tasks2 = [
    task("t1", "brief", "planner", "complete"),
    task("t2", "build", "implementer", "running"),
    task("t3", "build", "red-reviewer", "running", { parentId: "t2" }),
    task("t4", "review", "reviewer", "pending"),
  ];
  const { nodes } = buildTaskGraph(tasks2, phases);
  const layerMap = computeElkLayers(nodes, phases);
  assert.equal(layerMap.get("t:t1"), 0); // brief = index 0
  assert.equal(layerMap.get("t:t2"), 1); // build = index 1
  assert.equal(layerMap.get("t:t3"), 1); // red gets same layer as t2 (build = 1)
  assert.equal(layerMap.get("t:t4"), 2); // review = index 2
});

// (e) elapsed is '' for pending, non-empty for running/complete
test("buildTaskGraph elapsed is '' for pending, non-empty for running/done", () => {
  const pending = task("p", "brief", "planner", "pending");
  const running = task("r", "brief", "planner", "running", {
    startedAt: new Date(Date.now() - 5000).toISOString(),
  });
  const done = task("d", "brief", "planner", "complete", {
    startedAt: new Date(Date.now() - 10000).toISOString(),
    completedAt: new Date(Date.now() - 2000).toISOString(),
  });
  const g = buildTaskGraph([pending, running, done], []);
  const pNode = g.nodes.find(n => n.data.taskId === "p")!;
  const rNode = g.nodes.find(n => n.data.taskId === "r")!;
  const dNode = g.nodes.find(n => n.data.taskId === "d")!;
  assert.equal(pNode.data.elapsed, "");
  assert.ok(rNode.data.elapsed.length > 0, "running node has elapsed");
  assert.ok(dNode.data.elapsed.length > 0, "done node has elapsed");
});

// (f) linear edges connect adjacent non-empty phases, skipped when phase has no tasks
test("buildTaskGraph linear edges connect adjacent non-empty phases", () => {
  const phases = [phase("brief", "done"), phase("build", "running"), phase("review", "pending")];
  const tasks3 = [
    task("t1", "brief", "planner", "complete"),
    // build has no tasks — linear edge between brief and review skipped
    task("t2", "review", "reviewer", "pending"),
  ];
  const g = buildTaskGraph(tasks3, phases);
  const linear = g.edges.filter(e => e.data.kind === "linear");
  // brief→build: build has no tasks → skip
  // build→review: build has no tasks → skip
  // Neither edge should be present
  assert.equal(linear.length, 0);
});

test("buildTaskGraph linear edges emitted when both adjacent phases have tasks", () => {
  const phases = [phase("brief", "done"), phase("build", "running"), phase("review", "pending")];
  const t1 = task("t1", "brief", "planner", "complete");
  const t2 = task("t2", "build", "implementer", "running");
  const t3 = task("t3", "review", "reviewer", "pending");
  const g = buildTaskGraph([t1, t2, t3], phases);
  const linear = g.edges.filter(e => e.data.kind === "linear");
  assert.equal(linear.length, 2);
  assert.ok(linear.some(e => e.data.source === "t:t1" && e.data.target === "t:t2"));
  assert.ok(linear.some(e => e.data.source === "t:t2" && e.data.target === "t:t3"));
});

// (g) empty task list produces empty graph
test("buildTaskGraph with empty task list produces empty graph", () => {
  const g = buildTaskGraph([], []);
  assert.equal(g.nodes.length, 0);
  assert.equal(g.edges.length, 0);
});

// label is agentAlias when present, else agentRole
test("buildTaskGraph node label uses agentAlias when present", () => {
  const t = task("t1", "build", "implementer", "running", { agentAlias: "fast-implementer" });
  const g = buildTaskGraph([t], []);
  assert.equal(g.nodes[0]!.data.label, "fast-implementer");
});

test("buildTaskGraph node label falls back to agentRole when agentAlias absent", () => {
  const t = task("t1", "build", "implementer", "running");
  const g = buildTaskGraph([t], []);
  assert.equal(g.nodes[0]!.data.label, "implementer");
});

// red edge not emitted when the parentId relationship is a retry (same phase+role+failed)
test("buildTaskGraph does not emit red edge for retry relationship", () => {
  const parent = task("p1", "build", "red-reviewer", "failed");
  const child = task("c1", "build", "red-reviewer", "running", { parentId: "p1" });
  const g = buildTaskGraph([parent, child], []);
  // This is a retry relationship (same phase+role, parent failed) — retry edge emitted, not red
  const redEdges = g.edges.filter(e => e.data.kind === "red");
  assert.equal(redEdges.length, 0);
  const retryEdges = g.edges.filter(e => e.data.kind === "retry");
  assert.equal(retryEdges.length, 1);
});

// Fanout progress fields — populated for non-red tasks so htmlLabelTpl can
// render the progress bar on running fanout nodes. Caught 2026-05-13 by red
// review: `htmlLabelTpl` reads `data._fanoutTotal` / `data._fanoutComplete`
// but the data layer wasn't populating them.
test("buildTaskGraph populates _fanoutTotal and _fanoutComplete for non-red tasks", () => {
  // Fanout: 4 investigate tasks, 2 complete + 1 running + 1 pending
  const tasks = [
    task("i1", "investigate", "investigator", "complete"),
    task("i2", "investigate", "investigator", "complete"),
    task("i3", "investigate", "investigator", "running"),
    task("i4", "investigate", "investigator", "pending"),
  ];
  const g = buildTaskGraph(tasks, []);
  for (const n of g.nodes) {
    assert.equal(n.data._fanoutTotal, 4, `${n.data.taskId} should see 4-task fanout`);
    assert.equal(n.data._fanoutComplete, 2, `${n.data.taskId} should see 2 complete`);
  }
});

test("buildTaskGraph singleton phase has _fanoutTotal=1", () => {
  const t = task("t1", "build", "implementer", "running");
  const g = buildTaskGraph([t], []);
  assert.equal(g.nodes[0]!.data._fanoutTotal, 1);
  assert.equal(g.nodes[0]!.data._fanoutComplete, 0);
});

test("buildTaskGraph red nodes have _fanoutTotal=0 (no progress bar)", () => {
  // Red review tasks are not fanout siblings — they're per-parent peers.
  // The progress-bar template should not render on red nodes regardless of
  // how many reds exist; _fanoutTotal=0 makes the template's `> 0` guard fail.
  const tasks = [
    task("p1", "build", "implementer", "complete"),
    task("r1", "build", "red-wide", "running", { parentId: "p1" }),
    task("r2", "build", "red-narrow", "running", { parentId: "p1" }),
  ];
  const g = buildTaskGraph(tasks, []);
  const redNodes = g.nodes.filter(n => n.data.isRed);
  assert.equal(redNodes.length, 2);
  for (const r of redNodes) {
    assert.equal(r.data._fanoutTotal, 0, `${r.data.taskId} red should have _fanoutTotal=0`);
    assert.equal(r.data._fanoutComplete, 0);
  }
});

test("buildTaskGraph counts each (phase, role) fanout independently", () => {
  // Two different roles in the same phase = two separate fanout groups.
  // Each task sees its own role's totals, not the union.
  const tasks = [
    task("a1", "build", "frontend-implementer", "complete"),
    task("a2", "build", "frontend-implementer", "running"),
    task("b1", "build", "backend-implementer", "complete"),
    task("b2", "build", "backend-implementer", "complete"),
    task("b3", "build", "backend-implementer", "running"),
  ];
  const g = buildTaskGraph(tasks, []);
  const front = g.nodes.find(n => n.data.taskId === "a2")!;
  const back = g.nodes.find(n => n.data.taskId === "b3")!;
  assert.equal(front.data._fanoutTotal, 2);
  assert.equal(front.data._fanoutComplete, 1);
  assert.equal(back.data._fanoutTotal, 3);
  assert.equal(back.data._fanoutComplete, 2);
});
