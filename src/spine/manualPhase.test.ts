// Manual-phase semantics (FORGE-DEC-016): phases with `agents: []` create a single
// task in `awaiting_human_input`, dispatch is a no-op for them, and the human
// transitions the task via `forge submit` (tested separately in submit.test.ts).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { createPhaseTasks } from "./next.js";
import { dispatch } from "./dispatch.js";
import type { Run, Workflow, AgentRef } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-manual",
  workflow: "ui-design",
  title: "test design",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
  metadata: { designDir: "/tmp/forge-test-design" },
};

const PROMPT_AUTHOR: AgentRef = {
  role: "prompt-author",
  agentDir: "/x",
  alias: "spec-writer",
  model: "m",
};

function uiDesignWorkflow(): Workflow {
  return {
    name: "ui-design",
    description: "",
    phases: [
      { name: "brief", agents: [PROMPT_AUTHOR], gate: "human" },
      { name: "review", agents: [], gate: "human", onReject: "brief" },
    ],
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// Workflow loader is async because it imports TS files at runtime; bypass it by
// stubbing only the parts of dispatch we care about. We only test the
// agents-empty short-circuit, so we don't need a full loader round-trip.
// (dispatch.ts loads workflows from disk; for unit testing we just confirm the
// shape of the no-op return when given an empty-agents phase.)

test("createPhaseTasks: empty-agents phase creates one task in awaiting_human_input", () => {
  const wf = uiDesignWorkflow();
  const created = createPhaseTasks(RUN, wf, "review");
  assert.equal(created.length, 1);
  const t = created[0]!;
  assert.equal(t.status, "awaiting_human_input");
  assert.equal(t.agentRole, "");
  assert.equal(t.phase, "review");
  assert.equal(t.taskPackage.role, "");
  assert.equal(t.taskPackage.composedSystemPrompt, ""); // no agent → no prompt
});

test("createPhaseTasks: empty-agents phase still receives commonInputs (so onReject rationale flows)", () => {
  const wf = uiDesignWorkflow();
  const created = createPhaseTasks(RUN, wf, "review", {
    commonInputs: { rejectedRationale: "the design was off-style", rejectedTaskId: "t-prior" },
  });
  assert.equal(created.length, 1);
  const inputs = created[0]!.taskPackage.inputs;
  assert.equal(inputs.rejectedRationale, "the design was off-style");
  assert.equal(inputs.rejectedTaskId, "t-prior");
});

test("dispatch: no-op for an empty-agents phase", async () => {
  // dispatch needs to load the workflow from disk; ui-design is a real workflow
  // file, so this should resolve. The phase 'review' is the manual one.
  const result = await dispatch(RUN.id, "review", { projectDir: "/tmp" });
  assert.equal(result.spawned, 0);
  assert.equal(result.taskIds.length, 0);
});
