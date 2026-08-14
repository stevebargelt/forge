// FG-635: a run must not settle `complete` while a guaranteed workflow phase was
// never dispatched. The live defect: `forge invoke --run <feature-run>` attaches an
// ad-hoc (phase="task") row to a pipeline run, and when that ad-hoc completes,
// invoke's closeRunIfIdle classified the run against `undefined` for the workflow —
// forcing the invoke-shape branch (top-level tasks only). So on a `feature` run
// whose `verify` had advanced but whose `docs` phase had NO task row yet, the ad-hoc
// completion false-settled the run `complete` with docs never run.
//
// These drive finalizeInvokeRunIfSettled (the exact decision closeRunIfIdle makes)
// against a real store, in both directions: an undispatched-reachable phase must keep
// the run open, and a genuine invoke run / a fully-covered pipeline run must still
// settle.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import {
  insertTask,
  markTaskComplete,
  markTaskFailed,
  tasksForRun,
} from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { finalizeInvokeRunIfSettled } from "./invoke.js";
import type { Run, Task, TaskStatus } from "../types/index.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// A feature-shaped pipeline: build → verify → docs. `docs` is the guaranteed final
// phase the incident lost. None of the ids is `task`, so the ad-hoc row's phase
// collides with no step — what keeps it out of the step projection is its provenance.
const WORKFLOW_NAME = "fg635feature";
const RUN_ID = "run-fg635";

function ensureWorkflowYaml(): void {
  const dir = join(process.env["FORGE_HOME"]!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${WORKFLOW_NAME}.yml`),
    `name: ${WORKFLOW_NAME}
description: fg635 phase-coverage fixture
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
  - id: verify
    agent: test-engineer
    gate: human
    depends_on: [build]
  - id: docs
    agent: documentation-maintainer
    gate: auto
    depends_on: [verify]
`,
  );
  publishFlatAsGeneration(process.env["FORGE_HOME"]!);
}

// A per-test project dir (unique, mkdtemp) rather than the shared, hardcoded
// /tmp/test-project. The invalid-workflow cases write a `.forge/workflows` override
// here and the teardown removes the whole dir — nuking the shared /tmp/test-project
// would race the OTHER integration files that run concurrently in their own processes
// (their preflightProjectMount("/tmp/test-project") would fail mid-run).
let projectDir: string;

function activeRun(workflow: string): Run {
  const run: Run = {
    id: RUN_ID,
    workflow,
    title: "fg635 phase coverage",
    status: "active",
    createdAt: "2026-07-27T00:00:00Z",
    projectDir,
  };
  insertRun(run);
  return run;
}

function mkTask(
  id: string,
  phase: string,
  status: TaskStatus,
  adHoc = false,
): Task {
  const t: Task = {
    id,
    runId: RUN_ID,
    phase,
    agentRole: adHoc ? "engineer" : phase,
    status,
    taskPackage: {
      taskId: id,
      runId: RUN_ID,
      phase,
      role: adHoc ? "engineer" : phase,
      inputs: {},
      ...(adHoc ? { dispatchSource: "invoke" as const } : {}),
      composedSystemPrompt: "PROMPT",
    },
    createdAt: "2026-07-27T00:00:00Z",
  };
  insertTask(t);
  return t;
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg635-proj-"));
  ensureWorkflowYaml();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ── the defect ───────────────────────────────────────────────────────────────

test("FG-635 an ad-hoc task completing must not settle a feature run whose docs phase never dispatched", () => {
  activeRun(WORKFLOW_NAME);
  // The recorded shape: verify advanced, build done, docs has NO task row, and the
  // ad-hoc `forge invoke --run` task completes last.
  mkTask("task-build", "build", "complete");
  mkTask("task-verify", "verify", "complete");
  const adHoc = mkTask("task-adhoc", "task", "complete", true);

  const finalized = finalizeInvokeRunIfSettled(RUN_ID, {
    succeeded: true,
    owned: false,
  });

  assert.equal(
    finalized,
    false,
    "docs is undispatched and still reachable ⇒ the run is not settled",
  );
  assert.equal(
    getRun(RUN_ID)!.status,
    "active",
    "the run must NOT be marked complete with docs never run",
  );
  // The ad-hoc row itself is untouched terminal work — it settles nothing on its own.
  assert.equal(
    tasksForRun(RUN_ID).find((t) => t.id === adHoc.id)!.status,
    "complete",
  );
});

test("FG-635 the run completes once every phase — including docs — has reached a terminal state", () => {
  activeRun(WORKFLOW_NAME);
  mkTask("task-build", "build", "complete");
  mkTask("task-verify", "verify", "complete");
  mkTask("task-docs", "docs", "complete");
  mkTask("task-adhoc", "task", "complete", true);

  const finalized = finalizeInvokeRunIfSettled(RUN_ID, {
    succeeded: true,
    owned: false,
  });

  assert.equal(finalized, true, "every phase terminal ⇒ the run settles");
  assert.equal(getRun(RUN_ID)!.status, "complete");
});

// ── AC5: inverse cases are not wedged ─────────────────────────────────────────

test("FG-635 a genuine invoke run (workflow=invoke sentinel) still completes on its ad-hoc task alone", () => {
  activeRun("invoke");
  mkTask("task-adhoc", "task", "complete", true);

  const finalized = finalizeInvokeRunIfSettled(RUN_ID, {
    succeeded: true,
    owned: true,
  });

  assert.equal(
    finalized,
    true,
    "an invoke run has no phases to cover — top-level tasks decide",
  );
  assert.equal(getRun(RUN_ID)!.status, "complete");
});

test("FG-635 an external run with no registered workflow still completes on its terminal ad-hoc task", () => {
  // #201 compatibility: forge may attach an invoke to an externally-owned run
  // whose workflow name has no local definition. This is the one intended
  // load-failure fallback, so it must remain invoke-shaped rather than wedging.
  activeRun("external-unregistered-workflow");
  mkTask("task-adhoc", "task", "complete", true);

  const finalized = finalizeInvokeRunIfSettled(RUN_ID, {
    succeeded: true,
    owned: false,
  });

  assert.equal(finalized, true);
  assert.equal(getRun(RUN_ID)!.status, "complete");
});

test("FG-635 an invalid pipeline workflow that fails to load keeps the run open and records why", () => {
  // The workflow EXISTS but fails schema validation, unlike the external
  // unregistered-workflow compatibility case above. Forge cannot enumerate its phases,
  // so it cannot prove docs (still reachable) is terminal — it must NOT claim complete.
  // The old broad catch silently downgraded to invoke-shape and false-settled here; the
  // fix fails CLOSED and records the load error on a readable event.
  const workflowDir = join(projectDir, ".forge", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(workflowDir, `${WORKFLOW_NAME}.yml`),
    "name: [not-a-string]\n",
  );
  activeRun(WORKFLOW_NAME);
  mkTask("task-build", "build", "complete");
  mkTask("task-verify", "verify", "complete");
  mkTask("task-adhoc", "task", "complete", true);

  const finalized = finalizeInvokeRunIfSettled(RUN_ID, {
    succeeded: true,
    owned: false,
  });

  assert.equal(
    finalized,
    false,
    "an unloadable workflow means unknowable phase coverage ⇒ the run is not settled",
  );
  assert.equal(
    getRun(RUN_ID)!.status,
    "active",
    "the run stays open rather than false-settling complete phase-blind",
  );
  assert.ok(
    !eventsForRun(RUN_ID).some((e) => e.eventType === "run.completed"),
    "no completion event — the run did not complete",
  );
  // AC4: the reason a run is not closing is recorded and readable, not a mystery.
  const blockedEvent = eventsForRun(RUN_ID).find(
    (e) => e.eventType === "run.finalize_blocked",
  );
  assert.ok(
    blockedEvent,
    "the non-settling reason is recorded on a durable, operator-readable event",
  );
  const payload = blockedEvent!.payload as Record<string, unknown>;
  assert.equal(
    payload["workflow"],
    WORKFLOW_NAME,
    "the event names the workflow that failed to load",
  );
  assert.match(
    String(payload["workflowLoadError"]),
    /schema validation failed/,
    "the event carries the loader error so an operator can see WHY",
  );
  // FG-640/RF-1: the loader's message is bounded before it becomes a durable field —
  // FIRST LINE only, length-capped — so a YAML diagnostic's echoed source line and its
  // surrounding context cannot flow file-controlled into the shared host DB / dashboard.
  // The raw zod message is multi-line; the stored value must be the first line alone.
  const stored = String(payload["workflowLoadError"]);
  assert.ok(!stored.includes("\n"), "the stored error is a single line, not the raw multi-line diagnostic");
  assert.ok(stored.length <= 501, "the stored error is length-capped, not unbounded");
});

test("FG-635 a not-found workflow and a present-but-unloadable workflow settle differently", () => {
  // The case-1-vs-case-2 distinction, asserted directly so a future change that collapses
  // them back into one broad catch fails here. Same undispatched-docs shape, same ad-hoc
  // completion — only the loader outcome differs:
  //   case 1 (not found / external) → invoke-shaped → SETTLES;
  //   case 2 (present but unloadable) → phase coverage unknowable → STAYS OPEN.

  // Case 1: no registered definition anywhere (no project override, absent from the
  // published generation) — loadWorkflow throws WorkflowNotFoundError.
  activeRun("external-unregistered-workflow");
  mkTask("task-adhoc", "task", "complete", true);
  const case1 = finalizeInvokeRunIfSettled(RUN_ID, { succeeded: true, owned: false });
  assert.equal(case1, true, "case 1 (not found) stays invoke-shaped and settles");
  assert.equal(getRun(RUN_ID)!.status, "complete");
  assert.ok(
    !eventsForRun(RUN_ID).some((e) => e.eventType === "run.finalize_blocked"),
    "case 1 records no finalize-blocked reason — nothing is blocked",
  );

  // Reset to a fresh store for case 2 (the two must not share run/event state).
  setDbForTest(prev as DatabaseInstance);
  db.close();
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  ensureWorkflowYaml();

  // Case 2: the workflow is PRESENT (a project override) but fails schema validation.
  const workflowDir = join(projectDir, ".forge", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, `${WORKFLOW_NAME}.yml`), "name: [not-a-string]\n");
  activeRun(WORKFLOW_NAME);
  mkTask("task-adhoc", "task", "complete", true);
  const case2 = finalizeInvokeRunIfSettled(RUN_ID, { succeeded: true, owned: false });
  assert.equal(case2, false, "case 2 (present but unloadable) refuses to settle");
  assert.equal(getRun(RUN_ID)!.status, "active");
  assert.ok(
    eventsForRun(RUN_ID).some((e) => e.eventType === "run.finalize_blocked"),
    "case 2 records the finalize-blocked reason",
  );
});

test("FG-635 a phase failure that makes docs unreachable settles the run FAILED (not wedged), and the event names the undispatched phase", () => {
  activeRun(WORKFLOW_NAME);
  mkTask("task-build", "build", "complete");
  markTaskFailed(
    mkTask("task-verify", "verify", "running").id,
    "verify crashed",
  );
  // docs has no task row and can never dispatch — verify (its dep) is terminally failed.
  mkTask("task-adhoc", "task", "complete", true);

  const finalized = finalizeInvokeRunIfSettled(RUN_ID, {
    succeeded: false,
    owned: false,
  });

  assert.equal(
    finalized,
    true,
    "an unreachable phase is terminal — the run settles rather than wedging open",
  );
  assert.equal(getRun(RUN_ID)!.status, "failed");
  const failedEvent = eventsForRun(RUN_ID).find(
    (e) => e.eventType === "run.failed",
  );
  assert.ok(failedEvent, "run.failed was logged");
  assert.equal(
    (failedEvent!.payload as Record<string, unknown>)["unreachablePhases"],
    "docs",
    "AC4 — the never-dispatched phase is recorded on the finalize event, not inferable only by a task-vs-workflow diff",
  );
  assert.equal(
    (failedEvent!.payload as Record<string, unknown>)["failedPhases"],
    "verify",
  );
});

// ── concurrency guard is preserved ────────────────────────────────────────────

test("FG-635 a run a concurrent cancel already abandoned is never flipped back by an ad-hoc completion", () => {
  activeRun(WORKFLOW_NAME);
  mkTask("task-build", "build", "complete");
  mkTask("task-verify", "verify", "complete");
  mkTask("task-docs", "docs", "complete");
  mkTask("task-adhoc", "task", "complete", true);
  // A concurrent `forge cancel` won the race: the run is no longer active.
  updateRunStatus(RUN_ID, "abandoned");

  const finalized = finalizeInvokeRunIfSettled(RUN_ID, {
    succeeded: true,
    owned: false,
  });

  assert.equal(
    finalized,
    false,
    "finalizeRunIfSettled's re-read guard refuses a non-active run",
  );
  assert.equal(
    getRun(RUN_ID)!.status,
    "abandoned",
    "the cancellation stays authoritative",
  );
});
