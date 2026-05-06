import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { insertGate } from "../store/gates.js";
import {
  listRunsForDashboard,
  getRunWithShouldPoll,
  getTaskDetail,
  setQueryDbForTest,
} from "./queries.js";
import type { Run, Task, VerdictRow } from "../types/index.js";
import type { GateRow } from "../store/gates.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-dash",
  workflow: "investigation",
  title: "dashboard test run",
  status: "active",
  createdAt: "2026-05-06T00:00:00Z",
};

function task(id: string, status: Task["status"] = "pending", runId = RUN.id): Task {
  return {
    id,
    runId,
    phase: "frame",
    agentRole: "framer",
    status,
    taskPackage: {
      taskId: id,
      runId,
      phase: "frame",
      role: "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-06T00:00:00Z",
  };
}

const VERDICT: VerdictRow = {
  id: "verdict-1",
  taskId: "task-d1",
  redTaskId: "task-d2",
  redRole: "red-wide",
  verdict: "pass",
  confidence: 0.9,
  authority: "triage",
  findings: [],
  createdAt: "2026-05-06T01:00:00Z",
};

const GATE: GateRow = {
  id: "gate-d1",
  taskId: "task-d1",
  decision: "advance",
  rationale: "looks good",
  decidedAt: "2026-05-06T02:00:00Z",
  decidedBy: "human",
};

beforeEach(() => {
  db = makeInMemoryDb();
  // Both the store singleton and the queries module must share the same in-memory DB.
  prev = setDbForTest(db);
  setQueryDbForTest(db);

  insertRun(RUN);
  insertTask(task("task-d1", "complete"));
  insertTask(task("task-d2", "running"));
  insertVerdict(VERDICT);
  insertGate(GATE);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("listRunsForDashboard returns inserted run", () => {
  const runs = listRunsForDashboard();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.id, RUN.id);
  assert.equal(runs[0]!.title, RUN.title);
});

test("getRunWithShouldPoll returns shouldPoll=true when at least one task is running", () => {
  const result = getRunWithShouldPoll(RUN.id);
  assert.ok(result);
  assert.equal(result.shouldPoll, true);
  assert.equal(result.run.id, RUN.id);
  assert.equal(result.tasks.length, 2);
});

test("getRunWithShouldPoll returns shouldPoll=false when no tasks are running", () => {
  const run2: Run = {
    id: "run-done",
    workflow: "investigation",
    title: "done run",
    status: "complete",
    createdAt: "2026-05-06T00:00:00Z",
  };
  insertRun(run2);
  insertTask(task("task-done", "complete", "run-done"));

  const result = getRunWithShouldPoll("run-done");
  assert.ok(result);
  assert.equal(result.shouldPoll, false);
});

test("getRunWithShouldPoll returns verdicts keyed by task id", () => {
  const result = getRunWithShouldPoll(RUN.id);
  assert.ok(result);
  assert.ok(result.verdicts["task-d1"]);
  assert.equal(result.verdicts["task-d1"]!.length, 1);
  assert.equal(result.verdicts["task-d1"]![0]!.id, VERDICT.id);
});

test("getRunWithShouldPoll returns undefined for unknown run id", () => {
  const result = getRunWithShouldPoll("nope");
  assert.equal(result, undefined);
});

test("getTaskDetail returns task with verdicts and gates", () => {
  const result = getTaskDetail("task-d1");
  assert.ok(result);
  assert.equal(result.task.id, "task-d1");
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0]!.id, VERDICT.id);
  assert.equal(result.gates.length, 1);
  assert.equal(result.gates[0]!.id, GATE.id);
});

test("getTaskDetail returns undefined for unknown task id", () => {
  const result = getTaskDetail("nope");
  assert.equal(result, undefined);
});
