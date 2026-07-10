// FG-507: a LIVE ad-hoc (`forge invoke` / `forge retry`) row keeps the run
// unsettled, so no concurrent actor finalizes the run while the direct invoke
// container is still writing its result.
//
// The row is invisible to the ready queue and to step classification — it is
// run-level work, not workflow-step work. Only isRunSettled widens. These tests
// drive the two actors that consume isRunSettled against a real store:
// runNext.ts's "no ready work, is the run done" branch, and gate.ts's
// finalizeRunIfDone on the last gate.
//
// Both raced live before the fix: `forge retry` releases the run lock before it
// dispatches the ad-hoc container (matching `forge invoke`'s own concurrency
// profile), so a `forge next` or `forge gate` landing in that window saw every
// workflow step terminal and closed the run.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun } from "../store/runs.js";
import { insertTask, getTask, markTaskComplete, markTaskFailed, tasksForRun } from "../store/tasks.js";
import { runNext } from "./runNext.js";
import { gate } from "./gate.js";
import { computeReadyQueue } from "./ready-queue.js";
import type { Run, Task, TaskStatus } from "../types/index.js";
import type { Workflow } from "./schema.js";

const WORKFLOW_NAME = "fg507settle";
const RUN_ID = "run-fg507-settle";

// `build` auto-gates to complete; `review` parks on a human gate. Advancing
// `review` is the last decision in the run — exactly where finalizeRunIfDone
// fires. Neither step is named `task`, so the ad-hoc row's phase collides with
// nothing here: what keeps it out of the projection is its recorded provenance.
const WORKFLOW: Workflow = {
  name: WORKFLOW_NAME,
  description: "fg507 settledness fixture",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "review", agent: "engineer", gate: "human", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

/** gate.ts loads the workflow by name off FORGE_HOME; runNext takes it as an arg. */
function ensureWorkflowYaml(): void {
  const dir = join(process.env["FORGE_HOME"]!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${WORKFLOW_NAME}.yml`),
    `name: ${WORKFLOW_NAME}
description: fg507 settledness fixture
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
  - id: review
    agent: engineer
    gate: human
    depends_on: [build]
`,
  );
}

function activeRun(): Run {
  const run: Run = {
    id: RUN_ID,
    workflow: WORKFLOW_NAME,
    title: "fg507 settledness",
    status: "active",
    createdAt: "2026-07-10T00:00:00Z",
  };
  insertRun(run);
  return run;
}

function mkTask(id: string, phase: string, status: TaskStatus, adHoc = false): Task {
  const t: Task = {
    id,
    runId: RUN_ID,
    phase,
    agentRole: "engineer",
    status,
    taskPackage: {
      taskId: id,
      runId: RUN_ID,
      phase,
      role: "engineer",
      inputs: {},
      ...(adHoc ? { dispatchSource: "invoke" as const } : {}),
      composedSystemPrompt: "PROMPT",
    },
    createdAt: "2026-07-10T00:00:00Z",
  };
  insertTask(t);
  return t;
}

/** The row `forge retry` mints and dispatches directly, mid-flight. */
function liveAdHocTask(id: string, status: "pending" | "running"): Task {
  return mkTask(id, "task", status, true);
}

/** A run whose every workflow step is terminal — the shape that finalizes. */
function allStepsComplete(): void {
  mkTask("task-build", "build", "complete");
  mkTask("task-review", "review", "complete");
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  ensureWorkflowYaml();
  activeRun();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ── runNext race ─────────────────────────────────────────────────────────────

for (const status of ["running", "pending"] as const) {
  test(`FG-507 runNext race: a ${status} ad-hoc row + all workflow steps terminal ⇒ forge next neither finalizes nor dispatches it`, async () => {
    allStepsComplete();
    const adHoc = liveAdHocTask("task-adhoc", status);

    // The projection exclusion holds: the queue sees no work, so runNext takes
    // the "nothing ready — is the run done?" branch. Pre-fix it answered yes.
    assert.deepEqual(computeReadyQueue(WORKFLOW, tasksForRun(RUN_ID)), []);

    const result = await runNext({
      runId: RUN_ID,
      workflow: WORKFLOW,
      dockerExec: async () => assert.fail("runNext must never dispatch an ad-hoc row"),
    });

    assert.deepEqual(result.dispatchedSteps, [], "no step is ready — nothing may dispatch");
    assert.equal(result.runStatus, "active", "the ad-hoc container is still live ⇒ the run is not done");
    assert.equal(getRun(RUN_ID)!.status, "active", "runNext must not have written run.status=complete");
    assert.equal(getTask(adHoc.id)!.status, status, "the ad-hoc row is untouched — retry owns its dispatch");
  });
}

test("FG-507 runNext race: once the ad-hoc row completes, the ordinary finalize path closes the run", async () => {
  allStepsComplete();
  const adHoc = liveAdHocTask("task-adhoc", "running");

  await runNext({ runId: RUN_ID, workflow: WORKFLOW });
  assert.equal(getRun(RUN_ID)!.status, "active");

  markTaskComplete(adHoc.id, { status: "complete" });

  const result = await runNext({ runId: RUN_ID, workflow: WORKFLOW });
  assert.equal(result.runStatus, "complete");
  assert.equal(getRun(RUN_ID)!.status, "complete", "a terminal ad-hoc row blocks nothing");
});

test("FG-507 runNext race: a FAILED ad-hoc row is terminal too — it must not wedge the run open", async () => {
  allStepsComplete();
  const adHoc = liveAdHocTask("task-adhoc", "running");
  markTaskFailed(adHoc.id, "container crashed");

  const result = await runNext({ runId: RUN_ID, workflow: WORKFLOW });
  assert.equal(result.runStatus, "complete", "settledness widened for LIVE rows only, not terminal ones");
});

// ── gate race ────────────────────────────────────────────────────────────────

test("FG-507 gate race: advancing the last gate while an ad-hoc row runs leaves the run active", async () => {
  mkTask("task-build", "build", "complete");
  const review = mkTask("task-review", "review", "awaiting_gate");
  const adHoc = liveAdHocTask("task-adhoc", "running");

  const result = await gate(review.id, "advance", undefined);

  assert.equal(result.task.status, "complete", "the gate decision itself still lands");
  assert.deepEqual(result.nextTasks, [], "no downstream step to dispatch");
  assert.equal(
    getRun(RUN_ID)!.status,
    "active",
    "finalizeRunIfDone must not close the run out from under the live ad-hoc container",
  );

  // The ad-hoc container finishes; the ordinary finalize path then works.
  markTaskComplete(adHoc.id, { status: "complete" });
  const after = await runNext({ runId: RUN_ID, workflow: WORKFLOW });
  assert.equal(after.runStatus, "complete");
  assert.equal(getRun(RUN_ID)!.status, "complete");
});

test("FG-507 gate race: with no ad-hoc row in flight the last gate finalizes exactly as before", async () => {
  mkTask("task-build", "build", "complete");
  const review = mkTask("task-review", "review", "awaiting_gate");

  await gate(review.id, "advance", undefined);
  assert.equal(getRun(RUN_ID)!.status, "complete", "no behavior change when no ad-hoc row exists");
});

test("FG-507 gate race: a COMPLETE ad-hoc row does not block the last gate's finalize", async () => {
  mkTask("task-build", "build", "complete");
  const review = mkTask("task-review", "review", "awaiting_gate");
  const adHoc = liveAdHocTask("task-adhoc", "running");
  markTaskComplete(adHoc.id, { status: "complete" });

  await gate(review.id, "advance", undefined);
  assert.equal(getRun(RUN_ID)!.status, "complete");
});
