// Regression test for FG-532 (found by the FG-530 crash matrix, cell FG-530-B):
//
// gate.ts's reject branch called failTask() WITHOUT the task's persisted
// `result`, and markTaskFailed's UPDATE writes `result = ?` with null when it
// is absent — so a clean `forge gate <id> reject` NULLed the result that
// markTaskAwaitingGate had put on the row. The adjacent request-changes branch
// passes `result: task.result` deliberately ("preserving its result so it
// stays an audit record"); the rejected artifact is the audit record for WHY
// it was rejected, so reject must preserve it the same way.
//
// This exercises gate.ts's reject branch directly, both with and without
// on_reject, and pins that on_reject recovery lineage (rejectedRationale /
// rejectedTaskId / parentId) is unchanged by the fix.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { getTask, insertTask } from "../store/tasks.js";
import { gate } from "./gate.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task } from "../types/index.js";

const WORKFLOW_NAME = "gate-reject-result-test";
const RUN: Run = {
  id: "run-gate-reject-result",
  workflow: WORKFLOW_NAME,
  title: "gate reject preserves result test",
  status: "active",
  createdAt: "2026-07-01T00:00:00Z",
};

const PERSISTED_RESULT = {
  status: "complete",
  summary: "the artifact the gate is judging",
  files_modified: ["src/thing.ts"],
  tests_run: 4,
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

function ensureWorkflow(): void {
  const wfPath = join(homeDir, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: test
inputs: []
steps:
  - id: investigate
    agent: security-advisor
    gate: human
  - id: audit
    agent: security-advisor
    depends_on: [investigate]
    gate: human
    on_reject: investigate
`,
  );
  publishFlatAsGeneration(homeDir);
}

function awaitingGatePrimary(id: string, phase: "investigate" | "audit"): Task {
  const t: Task = {
    id,
    runId: RUN.id,
    phase,
    agentRole: "security-advisor",
    status: "awaiting_gate",
    result: PERSISTED_RESULT,
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase,
      role: "security-advisor",
      inputs: {},
      composedSystemPrompt: "PROMPT",
    },
    createdAt: "2026-07-01T00:00:00Z",
  };
  insertTask(t);
  return t;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-v2-gate-reject-result-"));
  process.env.FORGE_HOME = homeDir;
  ensureWorkflow();
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

test("FG-532: rejecting a task preserves its persisted result on the failed row (no on_reject)", async () => {
  const primary = awaitingGatePrimary("task-investigate-1", "investigate");
  assert.deepEqual(getTask(primary.id)!.result, PERSISTED_RESULT, "precondition: the row carries a result");

  const { nextTasks } = await gate(primary.id, "reject", "not good enough", {});
  assert.equal(nextTasks.length, 0, "no on_reject → no recovery task");

  const after = getTask(primary.id)!;
  assert.equal(after.status, "failed");
  assert.equal(after.error, "not good enough");
  assert.deepEqual(
    after.result,
    PERSISTED_RESULT,
    "the rejected artifact is the audit record for why it was rejected — reject must not NULL it",
  );
});

test("FG-532: reject with on_reject preserves the result AND recovery lineage is unchanged", async () => {
  const primary = awaitingGatePrimary("task-audit-1", "audit");

  const { nextTasks } = await gate(primary.id, "reject", "redo it", {});

  const after = getTask(primary.id)!;
  assert.equal(after.status, "failed");
  assert.deepEqual(after.result, PERSISTED_RESULT, "on_reject path preserves the result too");

  assert.equal(nextTasks.length, 1, "on_reject recovery task minted exactly as before");
  const recovery = nextTasks[0]!;
  assert.equal(recovery.phase, "investigate");
  assert.equal(recovery.status, "pending");
  assert.equal(recovery.parentId, primary.id);
  const inputs = recovery.taskPackage.inputs as Record<string, unknown>;
  assert.equal(inputs["rejectedRationale"], "redo it", "recovery still receives rejectedRationale");
  assert.equal(inputs["rejectedTaskId"], primary.id, "recovery still receives rejectedTaskId");
});

test("FG-532: rejecting a task that never had a result stays null — no fabricated result appears", async () => {
  const t: Task = {
    id: "task-investigate-noresult",
    runId: RUN.id,
    phase: "investigate",
    agentRole: "security-advisor",
    status: "awaiting_gate",
    taskPackage: {
      taskId: "task-investigate-noresult",
      runId: RUN.id,
      phase: "investigate",
      role: "security-advisor",
      inputs: {},
      composedSystemPrompt: "PROMPT",
    },
    createdAt: "2026-07-01T00:00:00Z",
  };
  insertTask(t);

  await gate(t.id, "reject", "no artifact to keep", {});

  const after = getTask(t.id)!;
  assert.equal(after.status, "failed");
  assert.equal(after.result, undefined, "a result-less reject stays result-less");
});
