// FG-677 / RF-5: the terminal-run closeout must run AFTER the wave that can make the run
// terminal — never before it. next.ts once called the closeout ahead of runNext, so a run
// terminalized by THAT wave had its disposable Git artifacts skipped at the wave boundary
// (and nothing re-runs `forge next` on a now-terminal run to converge them).
// runWaveThenCloseout encodes the corrected ordering; this pins it.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, getRun, updateRunStatus } from "../../store/runs.js";
import { runNext } from "../../v2/runNext.js";
import { runWaveThenCloseout } from "./next.js";
import type { Run } from "../../types/index.js";
import type { Workflow } from "../../v2/schema.js";
import type { RunNextResult } from "../../v2/runNext.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const RUN_ID = "run-fg677rf5";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-677/RF-5: the closeout runs AFTER the wave and observes the run the wave just terminalized", async () => {
  insertRun({ id: RUN_ID, workflow: "invoke", title: "rf5", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir: "/tmp/rf5" } as Run);
  const order: string[] = [];
  let statusSeenByCloseout: string | undefined;

  // The fake wave is the one that terminalizes the run.
  const fakeRunNext: typeof runNext = async (): Promise<RunNextResult> => {
    order.push("wave");
    updateRunStatus(RUN_ID, "complete");
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], awaitingRecovery: [], runStatus: "complete" };
  };
  const spyCloseout = (o: { projectDir?: string; runId: string }): void => {
    order.push("closeout");
    statusSeenByCloseout = getRun(o.runId)?.status;
  };

  const result = await runWaveThenCloseout(
    { runId: RUN_ID, projectDir: "/tmp/rf5", workflow: {} as Workflow, seedGeneration: null },
    { runNext: fakeRunNext, closeout: spyCloseout },
  );

  assert.deepEqual(order, ["wave", "closeout"], "the wave runs first, the closeout second — never before the terminal transition");
  assert.equal(statusSeenByCloseout, "complete", "the closeout observes the run this wave just terminalized (the RF-5 boundary)");
  assert.equal(result.runStatus, "complete", "the wave's result is returned unchanged for the action to render");
});
