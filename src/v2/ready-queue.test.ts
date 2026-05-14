import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReadyQueue } from "./ready-queue.js";
import type { Workflow } from "./schema.js";
import type { Task, TaskPackage } from "../types/index.js";

// Test fixtures. Minimal but valid shapes.

function mkWorkflow(steps: Workflow["steps"]): Workflow {
  return {
    name: "test",
    description: "test",
    inputs: [],
    steps,
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
}): Task {
  return {
    id: opts.id,
    runId: "r1",
    parentId: opts.parentId,
    phase: opts.phase,
    agentRole: opts.agentRole ?? "test-agent",
    status: opts.status,
    taskPackage: STUB_TP,
    createdAt: opts.createdAt ?? "2026-05-13T00:00:00.000Z",
  };
}

test("computeReadyQueue: step with no deps and no existing task is ready", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const ready = computeReadyQueue(wf, []);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "a");
});

test("computeReadyQueue: step with deps satisfied is ready", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b-agent", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-a", phase: "a", status: "complete" })];
  const ready = computeReadyQueue(wf, tasks);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "b");
});

test("computeReadyQueue: step with unmet deps is NOT ready", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b-agent", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-a", phase: "a", status: "running" })];
  const ready = computeReadyQueue(wf, tasks);
  // 'a' has a task (running, not pending), 'b' depends on 'a' but 'a' isn't complete.
  assert.deepEqual(ready.map((s) => s.id), []);
});

test("computeReadyQueue: step with existing complete task is NOT in ready queue", () => {
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-a", phase: "a", status: "complete" })];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), []);
});

test("computeReadyQueue: step with pending replacement task IS ready (re-dispatch case)", () => {
  // gate.ts pattern: after request-changes, a fresh `pending` task is inserted
  // alongside the previous `failed` one. Ready-queue should pick this up.
  const wf = mkWorkflow([
    { id: "a", agent: "a-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-a-1", phase: "a", status: "failed", createdAt: "2026-05-13T00:00:00.000Z" }),
    mkTask({ id: "t-a-2", phase: "a", status: "pending", createdAt: "2026-05-13T01:00:00.000Z" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "a");
});

test("computeReadyQueue: parallel-within-wave — multiple steps with deps met return together", () => {
  const wf = mkWorkflow([
    { id: "root", agent: "r", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "l", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "rt", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
  ]);
  const tasks = [mkTask({ id: "t-root", phase: "root", status: "complete" })];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id).sort(), ["left", "right"]);
});

test("computeReadyQueue: complete step that's a dep for multiple downstream", () => {
  // Diamond: root → (left, right) → merge
  const wf = mkWorkflow([
    { id: "root", agent: "r", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "l", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "rt", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "merge", agent: "m", gate: "auto", manual: false, depends_on: ["left", "right"], runtime: "claude", reds: [] },
  ]);
  // root complete, left complete, right still running → merge not ready
  const tasks = [
    mkTask({ id: "t-root", phase: "root", status: "complete" }),
    mkTask({ id: "t-left", phase: "left", status: "complete" }),
    mkTask({ id: "t-right", phase: "right", status: "running" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), []);
});

test("computeReadyQueue: diamond merge becomes ready when both legs complete", () => {
  const wf = mkWorkflow([
    { id: "root", agent: "r", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "l", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "rt", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "merge", agent: "m", gate: "auto", manual: false, depends_on: ["left", "right"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-root", phase: "root", status: "complete" }),
    mkTask({ id: "t-left", phase: "left", status: "complete" }),
    mkTask({ id: "t-right", phase: "right", status: "complete" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), ["merge"]);
});

test("computeReadyQueue: child (red) tasks don't affect dep satisfaction", () => {
  // A primary task with several red children. Reds spawn AFTER primary completes.
  // The primary's status is what matters for downstream dep satisfaction.
  const wf = mkWorkflow([
    { id: "a", agent: "a", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "b", agent: "b", gate: "auto", manual: false, depends_on: ["a"], runtime: "claude", reds: [] },
  ]);
  const tasks = [
    mkTask({ id: "t-a", phase: "a", status: "complete" }),
    mkTask({ id: "t-a-red1", phase: "a", parentId: "t-a", status: "complete" }),
    mkTask({ id: "t-a-red2", phase: "a", parentId: "t-a", status: "running" }),
  ];
  const ready = computeReadyQueue(wf, tasks);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, "b");
});
