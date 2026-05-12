import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import { reconcileRun } from "./reconcile.js";
import { taskDir, RUNS_DIR } from "../util/paths.js";
import type { Run, Task, Workflow, Phase, AgentRef } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-rec",
  workflow: "investigation",
  title: "test",
  status: "active",
  createdAt: "2026-05-06T00:00:00Z",
};

const RED_AGENT: AgentRef = {
  role: "red-wide",
  agentDir: "/tmp/notreal",
  alias: "fast-orchestrator",
  model: "x",
};

const BLUE_AGENT: AgentRef = {
  role: "framer",
  agentDir: "/tmp/notreal",
  alias: "spec-writer",
  model: "x",
};

function makePhaseWithReds(): Phase {
  return {
    name: "frame-question",
    agents: [BLUE_AGENT],
    reds: {
      wide: RED_AGENT,
      parallel: true,
      authority: "specialist",
      gateOnVerdict: false,
    },
    gate: "human",
  };
}

function makePhaseAuthoritativeReds(): Phase {
  return {
    name: "build",
    agents: [BLUE_AGENT],
    reds: {
      wide: RED_AGENT,
      parallel: true,
      authority: "authoritative",
      gateOnVerdict: true,
    },
    gate: "verdict",
  };
}

function workflowWithPhase(phase: Phase): Workflow {
  return { name: "investigation", description: "", phases: [phase] };
}

function makeTask(overrides: Partial<Task>): Task {
  const id = overrides.id!;
  return {
    id,
    runId: overrides.runId ?? RUN.id,
    parentId: overrides.parentId,
    phase: overrides.phase ?? "frame-question",
    agentRole: overrides.agentRole ?? "framer",
    status: overrides.status ?? "running",
    taskPackage: {
      taskId: id,
      runId: overrides.runId ?? RUN.id,
      phase: overrides.phase ?? "frame-question",
      role: overrides.agentRole ?? "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-06T00:00:00Z",
  };
}

function writeResultJson(taskId: string, payload: unknown): void {
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(payload));
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  // Clean up any task dirs we wrote to RUNS_DIR/<run-id>
  rmSync(join(RUNS_DIR, RUN.id), { recursive: true, force: true });
});

test("reconcile: running task with no result.json stays still_running", () => {
  insertTask(makeTask({ id: "task-1", status: "running" }));
  const wf = workflowWithPhase(makePhaseWithReds());
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.resolution, "still_running");
  assert.equal(getTask("task-1")!.status, "running");
});

test("reconcile: running task with empty result.json stays still_running", () => {
  insertTask(makeTask({ id: "task-2", status: "running" }));
  const dir = taskDir(RUN.id, "task-2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), "");
  const wf = workflowWithPhase(makePhaseWithReds());
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out[0]!.resolution, "still_running");
});

test("reconcile: running task with valid result.json transitions to complete", () => {
  insertTask(makeTask({ id: "task-3", status: "running" }));
  writeResultJson("task-3", { status: "complete", payload: 42 });
  const phase: Phase = { name: "frame-question", agents: [BLUE_AGENT], gate: "auto" };
  const wf = workflowWithPhase(phase);
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out[0]!.resolution, "complete");
  const t = getTask("task-3")!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { status: "complete", payload: 42 });
});

test("reconcile: agent-reported failed status transitions to failed", () => {
  insertTask(makeTask({ id: "task-4", status: "running" }));
  writeResultJson("task-4", { status: "failed", error: "agent gave up" });
  const wf = workflowWithPhase(makePhaseWithReds());
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out[0]!.resolution, "failed");
  const t = getTask("task-4")!;
  assert.equal(t.status, "failed");
  assert.equal(t.error, "agent gave up");
});

test("reconcile: unparseable result.json marks task failed", () => {
  insertTask(makeTask({ id: "task-5", status: "running" }));
  const dir = taskDir(RUN.id, "task-5");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), "not json at all {");
  const wf = workflowWithPhase(makePhaseWithReds());
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out[0]!.resolution, "failed");
  assert.match(getTask("task-5")!.error!, /unparseable/);
});

test("reconcile: red task writes verdict and transitions parent to awaiting_gate", () => {
  // Set up: blue task already complete (no verdict yet); red task running with result on disk.
  insertTask(makeTask({ id: "blue-1", status: "complete" }));
  insertTask(
    makeTask({
      id: "red-1",
      parentId: "blue-1",
      agentRole: "red-wide",
      status: "running",
    })
  );
  writeResultJson("red-1", {
    status: "complete",
    verdict: "pass",
    confidence: 0.85,
    findings: [
      { severity: "low", summary: "fine", evidence: "x:1", hypothesis: "noop" },
    ],
  });
  const wf = workflowWithPhase(makePhaseWithReds());
  reconcileRun(RUN.id, wf);

  // Verdict row exists for the blue task
  const verdicts = verdictsForTask("blue-1");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.verdict, "pass");
  assert.equal(verdicts[0]!.confidence, 0.85);
  assert.equal(verdicts[0]!.authority, "specialist");

  // Blue parent transitioned to awaiting_gate (since the parent was `complete` pre-reconcile,
  // which is the brief intermediate state spawn() leaves it in before spawnRed sets the gate)
  assert.equal(getTask("blue-1")!.status, "awaiting_gate");
});

test("reconcile: authoritative red fail + gateOnVerdict sets parent to blocked_by_red", () => {
  insertTask(makeTask({ id: "blue-2", phase: "build", status: "complete" }));
  insertTask(
    makeTask({
      id: "red-2",
      phase: "build",
      parentId: "blue-2",
      agentRole: "red-wide",
      status: "running",
    })
  );
  writeResultJson("red-2", {
    status: "complete",
    verdict: "fail",
    confidence: 0.95,
    findings: [],
  });
  const wf = workflowWithPhase(makePhaseAuthoritativeReds());
  reconcileRun(RUN.id, wf);

  assert.equal(getTask("blue-2")!.status, "blocked_by_red");
});

test("reconcile: parent already gated (status=failed) is left alone", () => {
  insertTask(makeTask({ id: "blue-3", status: "failed" }));
  insertTask(
    makeTask({
      id: "red-3",
      parentId: "blue-3",
      agentRole: "red-wide",
      status: "running",
    })
  );
  writeResultJson("red-3", {
    status: "complete",
    verdict: "pass",
    confidence: 0.9,
    findings: [],
  });
  const wf = workflowWithPhase(makePhaseWithReds());
  reconcileRun(RUN.id, wf);

  // Verdict still recorded (audit trail honest)
  assert.equal(verdictsForTask("blue-3").length, 1);
  // But parent status untouched
  assert.equal(getTask("blue-3")!.status, "failed");
});

test("reconcile: idempotent — running it twice produces the same end state", () => {
  insertTask(makeTask({ id: "task-idem", status: "running" }));
  writeResultJson("task-idem", { status: "complete", x: 1 });
  const phase: Phase = {
    name: "frame-question",
    agents: [BLUE_AGENT],
    gate: "auto",
  };
  const wf = workflowWithPhase(phase);

  reconcileRun(RUN.id, wf);
  const first = getTask("task-idem");
  reconcileRun(RUN.id, wf);
  const second = getTask("task-idem");
  assert.equal(second!.status, "complete");
  assert.deepEqual(second!.result, first!.result);
});

test("reconcile: skips tasks that are not in running status", () => {
  insertTask(makeTask({ id: "task-pending", status: "pending" }));
  insertTask(makeTask({ id: "task-complete", status: "complete" }));
  // No result.json written — proves these are skipped (no error from missing files)
  const wf = workflowWithPhase(makePhaseWithReds());
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out.length, 0);
});

test("reconcile: orphan blue with gate: 'auto' reconciles to status=complete", () => {
  insertTask(makeTask({ id: "task-auto", status: "running" }));
  writeResultJson("task-auto", { status: "complete", answer: "yes" });
  const phase: Phase = {
    name: "frame-question",
    agents: [BLUE_AGENT],
    gate: "auto",
  };
  const wf = workflowWithPhase(phase);
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out[0]!.resolution, "complete");
  const t = getTask("task-auto")!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { status: "complete", answer: "yes" });
});

test("reconcile: orphan blue with gate: 'human' reconciles to status=awaiting_gate with result stored", () => {
  insertTask(makeTask({ id: "task-human", status: "running" }));
  writeResultJson("task-human", { status: "complete", answer: "done" });
  const phase: Phase = {
    name: "frame-question",
    agents: [BLUE_AGENT],
    gate: "human",
  };
  const wf = workflowWithPhase(phase);
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out[0]!.resolution, "complete");
  const t = getTask("task-human")!;
  assert.equal(t.status, "awaiting_gate");
  assert.deepEqual(t.result, { status: "complete", answer: "done" });
});

test("reconcile: orphan blue with gate: 'verdict' reconciles to status=awaiting_gate with result stored", () => {
  insertTask(makeTask({ id: "task-verdict", status: "running" }));
  writeResultJson("task-verdict", { status: "complete", answer: "done" });
  const phase: Phase = {
    name: "frame-question",
    agents: [BLUE_AGENT],
    gate: "verdict",
  };
  const wf = workflowWithPhase(phase);
  const out = reconcileRun(RUN.id, wf);
  assert.equal(out[0]!.resolution, "complete");
  const t = getTask("task-verdict")!;
  assert.equal(t.status, "awaiting_gate");
  assert.deepEqual(t.result, { status: "complete", answer: "done" });
});
