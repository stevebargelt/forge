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

test("getRunWithShouldPoll returns shouldPoll=true when at least one task is running", async () => {
  const result = await getRunWithShouldPoll(RUN.id);
  assert.ok(result);
  assert.equal(result.shouldPoll, true);
  assert.equal(result.run.id, RUN.id);
  assert.equal(result.tasks.length, 2);
});

test("getRunWithShouldPoll returns shouldPoll=false when no tasks are running", async () => {
  const run2: Run = {
    id: "run-done",
    workflow: "investigation",
    title: "done run",
    status: "complete",
    createdAt: "2026-05-06T00:00:00Z",
  };
  insertRun(run2);
  insertTask(task("task-done", "complete", "run-done"));

  const result = await getRunWithShouldPoll("run-done");
  assert.ok(result);
  assert.equal(result.shouldPoll, false);
});

test("getRunWithShouldPoll returns verdicts keyed by task id", async () => {
  const result = await getRunWithShouldPoll(RUN.id);
  assert.ok(result);
  assert.ok(result.verdicts["task-d1"]);
  assert.equal(result.verdicts["task-d1"]!.length, 1);
  assert.equal(result.verdicts["task-d1"]![0]!.id, VERDICT.id);
});

test("getRunWithShouldPoll returns undefined for unknown run id", async () => {
  const result = await getRunWithShouldPoll("nope");
  assert.equal(result, undefined);
});

test("getRunWithShouldPoll returns phaseShape from the workflow", async () => {
  const result = await getRunWithShouldPoll(RUN.id);
  assert.ok(result);
  assert.ok(Array.isArray(result.phaseShape));
  // investigation has 4 phases.
  assert.equal(result.phaseShape.length, 4);
  const frame = result.phaseShape[0]!;
  // The two tasks above are phase=frame (one complete, one running).
  // Note: investigation.ts now uses "frame-question", but the test fixture
  // inserts tasks with phase="frame" (legacy). Phase shape merges by the
  // workflow's phase names, so frame-question's tasks list will be empty.
  assert.equal(frame.name, "frame-question");
  assert.equal(frame.gate, "human");
  // No tasks land on this phase under that name → status = pending.
  assert.equal(frame.status, "pending");
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

test("getTaskDetail derives failureMode='rejected' when failed task has reject gate (#94)", () => {
  const failedRejected = task("task-reject", "failed");
  insertTask(failedRejected);
  insertGate({
    id: "gate-r1",
    taskId: "task-reject",
    decision: "reject",
    rationale: "wrong scope",
    decidedAt: "2026-05-09T01:00:00Z",
    decidedBy: "human",
  });
  const result = getTaskDetail("task-reject");
  assert.ok(result);
  assert.equal(result.failureMode, "rejected");
});

test("getTaskDetail derives failureMode='crashed_or_agent_error' when failed task has no reject gate (#94)", () => {
  const failedCrashed = task("task-crashed", "failed");
  insertTask(failedCrashed);
  const result = getTaskDetail("task-crashed");
  assert.ok(result);
  assert.equal(result.failureMode, "crashed_or_agent_error");
});

test("getTaskDetail leaves failureMode undefined for non-failed tasks (#94)", () => {
  const result = getTaskDetail("task-d1");  // status=complete from beforeEach
  assert.ok(result);
  assert.equal(result.failureMode, undefined);
});
