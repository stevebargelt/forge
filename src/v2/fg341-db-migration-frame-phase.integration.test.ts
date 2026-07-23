// FG-341 integration tests: frame-phase task rows survive applyMigrations.
//
// What these tests verify:
//   1. A frame-phase task inserted for a research-synthesis run survives an
//      applyMigrations / DB-reopen cycle with phase still 'frame' (not renamed
//      to 'frame-question' by a stale migration).
//   2. After the reopen, the frame step is still resolvable against the
//      research-synthesis workflow — confirming the condition whose failure
//      produced "Step 'frame-question' not in workflow".
//   3. No OTHER live workflow phase is clobbered by a remaining migration:
//      the ui-review line (UPDATE tasks SET phase = 'ui-review' WHERE phase = 'review')
//      only fires on tasks whose phase is literally 'review'; phases like 'frame',
//      'research-primary', 'synthesize', 'docs', 'investigate', and 'build'
//      are all left untouched.
//
// The gap closed here: the FG-251 integration tests exercised loadWorkflow in
// isolation, never a live task row through the real migrating DB. These tests
// drive the full path — insert task → applyMigrations re-run → read back.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, applyMigrations } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { loadWorkflow } from "./loader.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task } from "../types/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedWorkflowPath = join(repoRoot, "seeds", "workflows", "research-synthesis.yml");

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RS_RUN: Run = {
  id: "run-fg341",
  workflow: "research-synthesis",
  title: "FG-341 integration test run",
  status: "active",
  createdAt: "2026-06-21T00:00:00Z",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? "task-fg341-1";
  const phase = overrides.phase ?? "frame";
  return {
    id,
    runId: overrides.runId ?? RS_RUN.id,
    parentId: overrides.parentId,
    phase,
    agentRole: overrides.agentRole ?? "research-framer",
    agentAlias: overrides.agentAlias,
    agentModel: overrides.agentModel,
    resolvedProfile: overrides.resolvedProfile,
    resolvedProvider: overrides.resolvedProvider,
    resolvedAuth: overrides.resolvedAuth,
    resolvedBy: overrides.resolvedBy,
    status: overrides.status ?? "pending",
    taskPackage: overrides.taskPackage ?? {
      taskId: id,
      runId: overrides.runId ?? RS_RUN.id,
      phase,
      role: overrides.agentRole ?? "research-framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-06-21T00:00:00Z",
    error: overrides.error,
    result: overrides.result,
  };
}

// ---------------------------------------------------------------------------
// Per-test DB setup — fresh in-memory DB wired into the singleton.
// ---------------------------------------------------------------------------

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RS_RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installResearchSynthesisWorkflow(): void {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));
  // FG-583: publish the flat workflow as a complete generation so loadWorkflow resolves it.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// ---------------------------------------------------------------------------
// Test 1: frame task row survives applyMigrations re-run (DB-reopen simulation)
// ---------------------------------------------------------------------------

test("FG-341: research-synthesis 'frame' task phase survives applyMigrations re-run", () => {
  // Insert a task that represents the frame step of a research-synthesis run.
  insertTask(makeTask({ id: "task-rs-frame", phase: "frame" }));

  // Confirm the task was inserted with phase 'frame'.
  const before = getTask("task-rs-frame");
  assert.ok(before, "task must exist after insert");
  assert.equal(before!.phase, "frame", "pre-migration: phase must be 'frame'");

  // Simulate a DB reopen: call applyMigrations a second time on the same DB.
  // This is exactly what happens when forge opens the on-disk DB on the next
  // invocation. Before the FG-341 fix, the stale migration renamed 'frame' to
  // 'frame-question' here, corrupting the row.
  applyMigrations(db);

  const after = getTask("task-rs-frame");
  assert.ok(after, "task must still exist after re-migration");
  assert.equal(
    after!.phase,
    "frame",
    "phase must remain 'frame' after applyMigrations — not silently renamed to 'frame-question'"
  );
});

// ---------------------------------------------------------------------------
// Test 2: after migration cycle, task.phase resolves against workflow step
// ---------------------------------------------------------------------------

test("FG-341: after applyMigrations, frame task phase matches research-synthesis workflow step", () => {
  installResearchSynthesisWorkflow();

  insertTask(makeTask({ id: "task-rs-frame-resolvable", phase: "frame" }));

  // Simulate DB reopen via second applyMigrations call.
  applyMigrations(db);

  const task = getTask("task-rs-frame-resolvable");
  assert.ok(task, "task must exist after migration cycle");
  assert.equal(task!.phase, "frame");

  // Load the workflow (mirrors what gate.ts does before findStep).
  const wf = loadWorkflow("research-synthesis");

  // findStep logic from gate.ts: find a step whose id === task.phase.
  const step = wf.steps.find((s) => s.id === task!.phase);
  assert.ok(
    step,
    `Step '${task!.phase}' not found in workflow '${wf.name}' — this is the exact error ` +
      "gate.ts would throw. The frame task must remain resolvable after a migration cycle."
  );
  assert.equal(step!.id, "frame", "resolved step must be the 'frame' step");
});

// ---------------------------------------------------------------------------
// Test 3: migration sanity-check — other live phases are not clobbered
// ---------------------------------------------------------------------------

test("FG-341: applyMigrations does not clobber research-synthesis phases other than 'review'→'ui-review'", () => {
  // Phases that must survive applyMigrations unchanged.
  // These span all live workflows to confirm no stray UPDATE touches them.
  const survivingPhases = [
    "frame",              // research-synthesis: frame step
    "research-primary",   // research-synthesis: primary research branch
    "research-skeptic",   // research-synthesis: skeptic research branch
    "synthesize",         // research-synthesis: synthesis step
    "docs",               // research-synthesis / feature: docs step
    "investigate",        // investigation workflow
    "build",              // feature workflow
    "spec",               // feature workflow
  ];

  for (const phase of survivingPhases) {
    const id = `task-sanity-${phase}`;
    insertTask(makeTask({ id, phase, agentRole: "framer" }));
  }

  // Insert one task with phase 'review' — this IS expected to be renamed to 'ui-review'.
  insertTask(makeTask({ id: "task-sanity-review", phase: "review", agentRole: "red-ui-reviewer" }));

  // Run migrations twice to confirm idempotency and no accidental revert.
  applyMigrations(db);
  applyMigrations(db);

  // All surviving phases must be unchanged.
  for (const phase of survivingPhases) {
    const id = `task-sanity-${phase}`;
    const t = getTask(id);
    assert.ok(t, `task with phase '${phase}' must exist after migrations`);
    assert.equal(
      t!.phase,
      phase,
      `phase '${phase}' must not be renamed by applyMigrations`
    );
  }

  // The 'review' task IS legitimately renamed to 'ui-review' (existing migration).
  const reviewTask = getTask("task-sanity-review");
  assert.ok(reviewTask, "review task must exist");
  assert.equal(
    reviewTask!.phase,
    "ui-review",
    "phase 'review' must be renamed to 'ui-review' by the existing ui-design migration"
  );
});
