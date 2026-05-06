import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";
import { insertGate, gatesForTask } from "./gates.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-g",
  workflow: "investigation",
  title: "gates test run",
  status: "active",
  createdAt: "2026-05-06T00:00:00Z",
};

function task(id: string): Task {
  return {
    id,
    runId: RUN.id,
    phase: "frame",
    agentRole: "framer",
    status: "awaiting_gate",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: "frame",
      role: "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-06T00:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(task("task-gate-1"));
  insertTask(task("task-gate-2"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("gatesForTask returns inserted gate with all fields mapped correctly", () => {
  insertGate({
    id: "gate-a",
    taskId: "task-gate-1",
    decision: "advance",
    rationale: "looks good",
    decidedAt: "2026-05-06T01:00:00Z",
    decidedBy: "human",
  });
  const gates = gatesForTask("task-gate-1");
  assert.equal(gates.length, 1);
  const g = gates[0]!;
  assert.equal(g.id, "gate-a");
  assert.equal(g.taskId, "task-gate-1");
  assert.equal(g.decision, "advance");
  assert.equal(g.rationale, "looks good");
  assert.equal(g.decidedAt, "2026-05-06T01:00:00Z");
  assert.equal(g.decidedBy, "human");
});

test("gatesForTask returns [] for unknown taskId", () => {
  const gates = gatesForTask("nonexistent-task");
  assert.deepEqual(gates, []);
});

test("gatesForTask maps null rationale to undefined", () => {
  insertGate({
    id: "gate-b",
    taskId: "task-gate-1",
    decision: "reject",
    decidedAt: "2026-05-06T02:00:00Z",
    decidedBy: "auto",
  });
  const gates = gatesForTask("task-gate-1");
  assert.equal(gates.length, 1);
  assert.equal(gates[0]!.rationale, undefined);
});

test("gatesForTask returns rows ordered by decided_at ASC", () => {
  insertGate({
    id: "gate-c1",
    taskId: "task-gate-2",
    decision: "request-changes",
    decidedAt: "2026-05-06T03:00:00Z",
    decidedBy: "human",
  });
  insertGate({
    id: "gate-c2",
    taskId: "task-gate-2",
    decision: "advance",
    decidedAt: "2026-05-06T01:00:00Z",
    decidedBy: "human",
  });
  const gates = gatesForTask("task-gate-2");
  assert.equal(gates.length, 2);
  assert.equal(gates[0]!.id, "gate-c2");
  assert.equal(gates[1]!.id, "gate-c1");
});
