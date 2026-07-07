// Regression test for FG-482 step 2 (independent engineering review
// 2026-07-06, finding F3):
//
// gate.ts's non-force verdict re-check used to throw on an authoritative red
// fail ONLY when `step.gate === "verdict"`. For a `gate: auto` or `gate:
// human` step, an authoritative-fail verdict row sitting in the verdicts
// table was never re-checked at gate time — a task observed as
// `awaiting_gate` with an authoritative fail already recorded (whether via
// the FG-482 crash window this ticket also closes, or any other path that
// leaves fail verdicts alongside an awaiting_gate status) could be advanced
// straight past the block without --force, so long as its step wasn't
// gate: verdict.
//
// Fix: the authoritative-fail throw at gate.ts now fires regardless of
// step.gate. This file locks that in and checks the two carve-outs the fix
// must not touch: the specialist-fail/--rationale path, and gate: verdict's
// pre-existing (correct) behavior.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { gate } from "./gate.js";
import type { Run, Task } from "../types/index.js";

const WORKFLOW_NAME = "gate-auth-recheck-test";
const RUN: Run = {
  id: "run-gate-auth-recheck",
  workflow: WORKFLOW_NAME,
  title: "gate authoritative re-check test",
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
  - id: step-auto
    agent: security-advisor
    gate: auto
  - id: step-human
    agent: security-advisor
    gate: human
  - id: step-verdict
    agent: security-advisor
    gate: verdict
    reds:
      - agent: red-1
        authority: authoritative
`,
  );
}

function primaryTask(id: string, phase: string, status: Task["status"]): Task {
  const t: Task = {
    id,
    runId: RUN.id,
    phase,
    agentRole: "security-advisor",
    status,
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

// verdicts.red_task_id is a FK into tasks(id) — every verdict needs a real
// (stub) red task row behind it, not just a dangling string.
function redStubTask(id: string): void {
  insertTask({
    id,
    runId: RUN.id,
    phase: "red",
    agentRole: "red-1",
    status: "complete",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: "red",
      role: "red-1",
      inputs: {},
      composedSystemPrompt: "PROMPT",
    },
    createdAt: "2026-07-01T00:00:00Z",
  });
}

function insertAuthoritativeFailVerdict(taskId: string, id: string): void {
  redStubTask(`${id}-red-task`);
  insertVerdict({
    id,
    taskId,
    redTaskId: `${id}-red-task`,
    redRole: "red-1",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [
      {
        severity: "high",
        summary: "authoritative fail for FG-482 regression test",
        evidence: "n/a",
        hypothesis: "n/a",
      },
    ],
    createdAt: "2026-07-01T00:00:01Z",
  });
}

function insertPassVerdict(taskId: string, id: string): void {
  redStubTask(`${id}-red-task`);
  insertVerdict({
    id,
    taskId,
    redTaskId: `${id}-red-task`,
    redRole: "red-1",
    verdict: "pass",
    confidence: 0.9,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-01T00:00:01Z",
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-v2-gate-auth-recheck-"));
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

test("FG-482: awaiting_gate task under gate:auto with an authoritative-fail verdict throws on advance without --force", async () => {
  // This is the actual vulnerability: a task that never went blocked_by_red
  // (e.g. it's just sitting awaiting_gate) but has an authoritative fail
  // verdict recorded against it. Before the fix, step.gate !== "verdict"
  // meant this fail verdict was never re-checked.
  const t = primaryTask("task-auto-1", "step-auto", "awaiting_gate");
  insertAuthoritativeFailVerdict(t.id, "verdict-auto-1");

  await assert.rejects(
    () => gate(t.id, "advance", undefined, {}),
    /verdict aggregation = fail/,
    "gate: auto must now re-check authoritative fails just like gate: verdict",
  );
  assert.equal(getTask(t.id)!.status, "awaiting_gate", "a rejected advance must not change task status");
});

test("FG-482: awaiting_gate task under gate:auto with an authoritative-fail verdict advances with --force + rationale", async () => {
  const t = primaryTask("task-auto-2", "step-auto", "awaiting_gate");
  insertAuthoritativeFailVerdict(t.id, "verdict-auto-2");

  const result = await gate(t.id, "advance", "overriding the authoritative fail", { force: true });
  assert.equal(result.task.status, "complete");
});

test("FG-482 regression: blocked_by_red task under gate:auto still throws on non-force advance", async () => {
  const t = primaryTask("task-auto-blocked", "step-auto", "blocked_by_red");
  insertAuthoritativeFailVerdict(t.id, "verdict-auto-blocked");

  await assert.rejects(
    () => gate(t.id, "advance", undefined, {}),
    /blocked_by_red.*--force/,
  );
  assert.equal(getTask(t.id)!.status, "blocked_by_red");
});

test("FG-482 regression: blocked_by_red task under gate:auto advances with --force + rationale", async () => {
  const t = primaryTask("task-auto-blocked-2", "step-auto", "blocked_by_red");
  insertAuthoritativeFailVerdict(t.id, "verdict-auto-blocked-2");

  const result = await gate(t.id, "advance", "human override rationale", { force: true });
  assert.equal(result.task.status, "complete");
});

test("FG-482 no-regression: gate:verdict step keeps blocking authoritative fails without --force", async () => {
  const t = primaryTask("task-verdict-1", "step-verdict", "awaiting_gate");
  insertAuthoritativeFailVerdict(t.id, "verdict-verdict-1");

  await assert.rejects(
    () => gate(t.id, "advance", undefined, {}),
    /verdict aggregation = fail/,
  );
  assert.equal(getTask(t.id)!.status, "awaiting_gate");
});

test("FG-482 no-regression: gate:verdict step still advances with --force + rationale", async () => {
  const t = primaryTask("task-verdict-2", "step-verdict", "awaiting_gate");
  insertAuthoritativeFailVerdict(t.id, "verdict-verdict-2");

  const result = await gate(t.id, "advance", "overriding the authoritative fail", { force: true });
  assert.equal(result.task.status, "complete");
});

test("FG-482: gate:human step also re-checks authoritative fails without --force (widened condition covers human too)", async () => {
  const t = primaryTask("task-human-1", "step-human", "awaiting_gate");
  insertAuthoritativeFailVerdict(t.id, "verdict-human-1");

  await assert.rejects(
    () => gate(t.id, "advance", undefined, {}),
    /verdict aggregation = fail/,
  );
  assert.equal(getTask(t.id)!.status, "awaiting_gate");
});

test("FG-482: non-blocked awaiting_gate task with no verdicts is unaffected by the widened condition (advances normally)", async () => {
  const t = primaryTask("task-auto-no-verdicts", "step-auto", "awaiting_gate");
  const result = await gate(t.id, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-482: non-blocked awaiting_gate task with an all-pass verdict aggregation is unaffected by the widened condition (advances normally)", async () => {
  const t = primaryTask("task-auto-pass", "step-auto", "awaiting_gate");
  insertPassVerdict(t.id, "verdict-auto-pass");
  const result = await gate(t.id, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-482: specialist-fail/--rationale path is untouched by the widened authoritative check", async () => {
  const t = primaryTask("task-auto-specialist", "step-auto", "awaiting_gate");
  redStubTask("verdict-auto-specialist-red-task");
  insertVerdict({
    id: "verdict-auto-specialist",
    taskId: t.id,
    redTaskId: "verdict-auto-specialist-red-task",
    redRole: "red-1",
    verdict: "fail",
    confidence: 0.7,
    authority: "specialist",
    findings: [],
    createdAt: "2026-07-01T00:00:01Z",
  });

  await assert.rejects(
    () => gate(t.id, "advance", undefined, {}),
    /Specialist red\(s\) failed/,
    "a specialist (non-authoritative) fail must still require --rationale, not --force",
  );

  const result = await gate(t.id, "advance", "specialist objection noted", {});
  assert.equal(result.task.status, "complete", "rationale alone (no --force) must be enough for a specialist fail");
});
