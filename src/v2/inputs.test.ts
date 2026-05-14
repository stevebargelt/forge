import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveUpstream } from "./inputs.js";
import type { Step } from "./schema.js";
import type { Task, TaskPackage } from "../types/index.js";

const STUB_TP: TaskPackage = {
  taskId: "t",
  runId: "r",
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
  agentRole?: string;
  createdAt?: string;
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

function mkStep(id: string, depends_on: string[] = []): Step {
  return {
    id,
    agent: `${id}-agent`,
    gate: "auto",
    manual: false,
    depends_on,
    runtime: "claude",
    reds: [],
  };
}

function setupRunDir(): { runDir: string; cleanup: () => void } {
  const runDir = mkdtempSync(join(tmpdir(), "forge-v2-inputs-"));
  return { runDir, cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}

function writeResult(runDir: string, taskId: string, body: unknown): void {
  const dir = join(runDir, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(body));
}

test("deriveUpstream: returns empty for step with no depends_on", () => {
  const { runDir, cleanup } = setupRunDir();
  try {
    const out = deriveUpstream({ step: mkStep("a"), allTasks: [], runDir });
    assert.deepEqual(out, []);
  } finally { cleanup(); }
});

test("deriveUpstream: returns one entry per direct depends_on", () => {
  const { runDir, cleanup } = setupRunDir();
  try {
    writeResult(runDir, "t-a", { status: "complete", risks: [] });
    writeResult(runDir, "t-b", { status: "complete", steps: [{ id: "1" }] });
    const tasks = [
      mkTask({ id: "t-a", phase: "a", status: "complete", agentRole: "architect" }),
      mkTask({ id: "t-b", phase: "b", status: "complete", agentRole: "tech-lead" }),
    ];
    const out = deriveUpstream({ step: mkStep("c", ["a", "b"]), allTasks: tasks, runDir });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.phase, "a");
    assert.equal(out[0]!.agentRole, "architect");
    assert.deepEqual(out[0]!.result, { status: "complete", risks: [] });
    assert.equal(out[1]!.phase, "b");
    assert.equal(out[1]!.agentRole, "tech-lead");
  } finally { cleanup(); }
});

test("deriveUpstream: picks the latest primary task in a phase (handles retries)", () => {
  const { runDir, cleanup } = setupRunDir();
  try {
    writeResult(runDir, "t-a-old", { status: "complete", v: "old" });
    writeResult(runDir, "t-a-new", { status: "complete", v: "new" });
    const tasks = [
      mkTask({ id: "t-a-old", phase: "a", status: "failed", createdAt: "2026-05-13T00:00:00Z" }),
      mkTask({ id: "t-a-new", phase: "a", status: "complete", createdAt: "2026-05-13T01:00:00Z" }),
    ];
    const out = deriveUpstream({ step: mkStep("b", ["a"]), allTasks: tasks, runDir });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.result, { status: "complete", v: "new" });
    assert.equal(out[0]!.taskId, "t-a-new");
  } finally { cleanup(); }
});

test("deriveUpstream: ignores child tasks (reds) when finding the primary", () => {
  const { runDir, cleanup } = setupRunDir();
  try {
    writeResult(runDir, "t-a", { status: "complete" });
    const tasks = [
      mkTask({ id: "t-a", phase: "a", status: "complete" }),
      mkTask({ id: "t-a-red", phase: "a", parentId: "t-a", status: "complete", agentRole: "red-wide" }),
    ];
    const out = deriveUpstream({ step: mkStep("b", ["a"]), allTasks: tasks, runDir });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.taskId, "t-a");
  } finally { cleanup(); }
});

test("deriveUpstream: missing result.json yields undefined result, not throw", () => {
  const { runDir, cleanup } = setupRunDir();
  try {
    // Don't write result.json.
    const tasks = [mkTask({ id: "t-a", phase: "a", status: "complete" })];
    const out = deriveUpstream({ step: mkStep("b", ["a"]), allTasks: tasks, runDir });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.result, undefined);
  } finally { cleanup(); }
});

test("deriveUpstream: malformed result.json yields undefined, not throw", () => {
  const { runDir, cleanup } = setupRunDir();
  try {
    const dir = join(runDir, "t-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "not json {}");
    const tasks = [mkTask({ id: "t-a", phase: "a", status: "complete" })];
    const out = deriveUpstream({ step: mkStep("b", ["a"]), allTasks: tasks, runDir });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.result, undefined);
  } finally { cleanup(); }
});

test("deriveUpstream: dep without a task is skipped, not a hard error", () => {
  // Caller's responsibility to call this only when deps are met. But if it
  // gets called early, it just returns an empty slice for the missing dep.
  const { runDir, cleanup } = setupRunDir();
  try {
    const out = deriveUpstream({ step: mkStep("b", ["a"]), allTasks: [], runDir });
    assert.deepEqual(out, []);
  } finally { cleanup(); }
});
