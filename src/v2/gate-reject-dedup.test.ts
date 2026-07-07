// Regression test for FG-476 follow-up ITEM 2 (red-backend MEDIUM):
//
// gate.ts's reject -> on_reject branch used to call insertTask()
// unconditionally, with no existing-pending check — unlike the sibling
// request-changes branch a few lines down, which dedups against a pending
// replacement primary. Repeated rejects targeting the same on_reject step
// (e.g. two separate primaries in the rejecting phase, both rejected before
// the first recovery task resolves) would mint a second pending recovery row
// in the target phase, breaking FG-476's one-marker-row-per-phase assumption:
// computeReadyQueue's admission exception and dispatchSingleStep's reuse
// lookup both assume at most one pending recovery row per phase.
//
// This exercises gate.ts's reject branch directly (not runNext/dispatch) —
// two rejects targeting the same on_reject phase must collapse into ONE
// pending recovery row, carrying the latest rationale/lineage.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, tasksForRun } from "../store/tasks.js";
import { gate } from "./gate.js";
import { isOnRejectRecoveryTask } from "./ready-queue.js";
import type { Run, Task } from "../types/index.js";

const WORKFLOW_NAME = "gate-dedup-test";
const RUN: Run = {
  id: "run-gate-dedup",
  workflow: WORKFLOW_NAME,
  title: "gate reject dedup test",
  status: "active",
  createdAt: "2026-07-01T00:00:00Z",
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
}

function auditPrimary(id: string): Task {
  const t: Task = {
    id,
    runId: RUN.id,
    phase: "audit",
    agentRole: "security-advisor",
    status: "awaiting_gate",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: "audit",
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
  homeDir = mkdtempSync(join(tmpdir(), "forge-v2-gate-dedup-"));
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

test("gate reject->on_reject dedups: two rejects targeting the same phase produce exactly one pending recovery row, with the latest rationale", async () => {
  const auditV1 = auditPrimary("task-audit-1");
  const auditV2 = auditPrimary("task-audit-2");

  const first = await gate(auditV1.id, "reject", "first rationale", {});
  assert.equal(first.nextTasks.length, 1, "first reject must insert exactly one recovery task");
  const recoveryId = first.nextTasks[0]!.id;

  const second = await gate(auditV2.id, "reject", "second rationale", {});
  assert.equal(second.nextTasks.length, 1, "second reject must report exactly one (reused) recovery task");
  assert.equal(second.nextTasks[0]!.id, recoveryId, "second reject must reuse the SAME recovery task id, not mint a new one");

  const recoveryTasks = tasksForRun(RUN.id).filter(
    (t) => t.phase === "investigate" && t.status === "pending" && isOnRejectRecoveryTask(t),
  );
  assert.equal(recoveryTasks.length, 1, "exactly one pending recovery row must exist in the target phase — no duplicate");
  assert.equal(recoveryTasks[0]!.id, recoveryId);
  assert.equal(
    (recoveryTasks[0]!.taskPackage.inputs as Record<string, unknown>)["rejectedRationale"],
    "second rationale",
    "the latest rationale must win — the first reject's rationale must not be silently orphaned",
  );
  assert.equal(
    (recoveryTasks[0]!.taskPackage.inputs as Record<string, unknown>)["rejectedTaskId"],
    auditV2.id,
    "lineage must point at the LATEST rejecting task",
  );
  assert.equal(
    recoveryTasks[0]!.parentId,
    auditV2.id,
    "parentId must follow the LATEST rejecting task too, not stay pinned to the first rejector",
  );
});

test("gate reject->on_reject: a single reject still creates a fresh pending recovery task when none exists", async () => {
  const auditV1 = auditPrimary("task-audit-solo");
  const result = await gate(auditV1.id, "reject", "only rationale", {});
  assert.equal(result.nextTasks.length, 1);
  const recovery = result.nextTasks[0]!;
  assert.equal(recovery.phase, "investigate");
  assert.equal(recovery.status, "pending");
  assert.equal(recovery.parentId, auditV1.id);
  assert.equal((recovery.taskPackage.inputs as Record<string, unknown>)["rejectedRationale"], "only rationale");
});
