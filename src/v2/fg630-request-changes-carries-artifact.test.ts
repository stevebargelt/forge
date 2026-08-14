// Regression test for FG-630:
//
// `forge gate <id> request-changes` mints a follow-up primary for the SAME
// step, but its inputs carried ONLY `requestedChanges` (the rationale). It did
// NOT carry the rejected artifact (the prior task's result.json) nor the
// rejectedTaskId / rejectedRationale lineage, so the retrying agent revised a
// plan it could not see and silently re-derived it, and the shipped payload
// disagreed with the seeds that document `inputs.rejectedTaskId` /
// `inputs.rejectedRationale` as retry signals.
//
// The fix mirrors the reject → on_reject lineage (rejectedRationale /
// rejectedTaskId) and additionally carries the rejected artifact under a NEW
// named input `rejectedArtifact`. AC5 is "enabled, not enforced": the artifact
// is PRESENT for the agent to diff against; no required delta-statement field.
//
// These assertions would FAIL against the old code (which set none of the three
// new fields). They cover BOTH the fresh-mint path and the dedup path (a second
// request-changes on an already-pending replacement), on a plan step AND a
// non-plan step.

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

const WORKFLOW_NAME = "gate-request-changes-artifact-test";
const RUN: Run = {
  id: "run-fg630",
  workflow: WORKFLOW_NAME,
  title: "request-changes carries rejected artifact test",
  status: "active",
  createdAt: "2026-07-01T00:00:00Z",
};

const PERSISTED_RESULT = {
  status: "complete",
  summary: "the plan artifact the gate is judging",
  files_modified: ["src/thing.ts"],
  steps: ["1", "2", "3"],
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
  - id: plan
    agent: tech-lead
    gate: human
  - id: implement
    agent: engineer
    depends_on: [plan]
    gate: human
`,
  );
  publishFlatAsGeneration(homeDir);
}

function awaitingGatePrimary(
  id: string,
  phase: "plan" | "implement",
  agentRole: string,
  opts: { result?: unknown; inputs?: Record<string, unknown> } = {},
): Task {
  const t: Task = {
    id,
    runId: RUN.id,
    phase,
    agentRole,
    status: "awaiting_gate",
    result: opts.result === undefined ? PERSISTED_RESULT : opts.result,
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase,
      role: agentRole,
      inputs: opts.inputs ?? { seededInput: "keep-me" },
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
  homeDir = mkdtempSync(join(tmpdir(), "forge-v2-fg630-"));
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

// AC1: fresh-mint path on a plan step.
test("FG-630: request-changes on a plan step mints a follow-up carrying the rejected artifact + lineage", async () => {
  const primary = awaitingGatePrimary("task-plan-1", "plan", "tech-lead");

  const { nextTasks } = await gate(primary.id, "request-changes", "tighten step 2", {});
  assert.equal(nextTasks.length, 1, "one replacement primary minted");

  const replacement = nextTasks[0]!;
  assert.equal(replacement.phase, "plan");
  assert.equal(replacement.status, "pending");
  const inputs = replacement.taskPackage.inputs as Record<string, unknown>;

  // The presence the old code lacked — would have FAILED before the fix.
  assert.deepEqual(
    inputs["rejectedArtifact"],
    PERSISTED_RESULT,
    "the follow-up must carry the rejected artifact so the agent can diff against it",
  );
  assert.equal(inputs["rejectedTaskId"], primary.id, "non-null rejectedTaskId lineage");
  assert.equal(inputs["rejectedRationale"], "tighten step 2");
  assert.equal(inputs["requestedChanges"], "tighten step 2", "requestedChanges still carried");
  assert.equal(inputs["seededInput"], "keep-me", "prior inputs are preserved, not clobbered");
});

// AC4: same holds on a NON-plan human-gated step.
test("FG-630: request-changes on a non-plan step also carries the rejected artifact + lineage", async () => {
  const primary = awaitingGatePrimary("task-implement-1", "implement", "engineer");

  const { nextTasks } = await gate(primary.id, "request-changes", "handle the null case", {});
  const inputs = nextTasks[0]!.taskPackage.inputs as Record<string, unknown>;

  assert.equal(nextTasks[0]!.phase, "implement");
  assert.deepEqual(inputs["rejectedArtifact"], PERSISTED_RESULT);
  assert.equal(inputs["rejectedTaskId"], primary.id);
  assert.equal(inputs["rejectedRationale"], "handle the null case");
  assert.equal(inputs["requestedChanges"], "handle the null case");
});

// Dedup path: a second request-changes on an already-pending replacement must
// thread the SAME three fields (merged, not clobbering other inputs).
test("FG-630: dedup path threads the rejected artifact + lineage onto the existing pending replacement", async () => {
  const first = awaitingGatePrimary("task-plan-A", "plan", "tech-lead");
  const { nextTasks: firstFollow } = await gate(first.id, "request-changes", "first pass", {});
  const replacementId = firstFollow[0]!.id;

  // A second primary reaches awaiting_gate (a resubmission) and is itself
  // request-changed while the first replacement is still pending — the dedup
  // branch updates the existing pending row rather than minting a second.
  const second = awaitingGatePrimary("task-plan-B", "plan", "tech-lead", {
    result: { ...PERSISTED_RESULT, summary: "second artifact" },
  });
  const { nextTasks: secondFollow } = await gate(second.id, "request-changes", "second pass", {});

  assert.equal(secondFollow.length, 1, "dedup updates the existing pending replacement");
  assert.equal(secondFollow[0]!.id, replacementId, "same pending row, not a second primary");

  const inputs = getTask(replacementId)!.taskPackage.inputs as Record<string, unknown>;
  assert.deepEqual(
    inputs["rejectedArtifact"],
    { ...PERSISTED_RESULT, summary: "second artifact" },
    "dedup carries the NEWER rejected artifact",
  );
  assert.equal(inputs["rejectedTaskId"], second.id, "dedup carries the newer rejectedTaskId");
  assert.equal(inputs["rejectedRationale"], "second pass");
  assert.equal(inputs["requestedChanges"], "second pass");
  assert.equal(inputs["seededInput"], "keep-me", "dedup merge preserves existing inputs");
});

// Safety: a result-less rejected task omits the artifact input rather than
// writing null.
test("FG-630: request-changes on a result-less task omits rejectedArtifact (no null)", async () => {
  const primary = awaitingGatePrimary("task-plan-noresult", "plan", "tech-lead", { result: null });

  const { nextTasks } = await gate(primary.id, "request-changes", "no artifact", {});
  const inputs = nextTasks[0]!.taskPackage.inputs as Record<string, unknown>;

  assert.ok(!("rejectedArtifact" in inputs), "no rejectedArtifact key when there is no result");
  assert.equal(inputs["rejectedTaskId"], primary.id, "lineage still carried");
  assert.equal(inputs["requestedChanges"], "no artifact");
});

// RF-2: a retry row already carries a rejectedArtifact (from its own minting).
// If that retry reaches the gate with NO result and is request-changed, the
// fresh replacement must CLEAR the inherited artifact, not carry it stale paired
// with the new rejectedTaskId. Would FAIL when rejectedArtifact is merely
// omitted from the merge (the inherited one survives the input spread).
test("FG-630 (RF-2): fresh mint clears an inherited rejectedArtifact when the retry has no result", async () => {
  const retry = awaitingGatePrimary("task-plan-retry-noresult", "plan", "tech-lead", {
    result: null,
    inputs: {
      seededInput: "keep-me",
      rejectedArtifact: { status: "complete", summary: "STALE artifact from prior retry" },
      rejectedTaskId: "task-plan-older",
    },
  });

  const { nextTasks } = await gate(retry.id, "request-changes", "still wrong", {});
  const inputs = nextTasks[0]!.taskPackage.inputs as Record<string, unknown>;

  assert.ok(
    !("rejectedArtifact" in inputs),
    "the inherited stale artifact must be cleared, not carried forward",
  );
  assert.equal(inputs["rejectedTaskId"], retry.id, "rejectedTaskId advances to the current retry");
  assert.equal(inputs["seededInput"], "keep-me", "unrelated inputs preserved");
});

// RF-1: dedup path. A first (result-bearing) request-changes sets rejectedArtifact
// on the pending replacement. A second, result-LESS request-changes must CLEAR
// that artifact on the same row rather than leaving it stale paired with the new
// rejectedTaskId. Would FAIL when the merge omits rejectedArtifact (the prior
// row's value persists).
test("FG-630 (RF-1): dedup clears the stale rejectedArtifact when the newer request-changes has no result", async () => {
  const first = awaitingGatePrimary("task-plan-first", "plan", "tech-lead");
  const { nextTasks: firstFollow } = await gate(first.id, "request-changes", "first pass", {});
  const replacementId = firstFollow[0]!.id;
  // Sanity: the prior result-bearing pass DID set the artifact on the pending row.
  assert.deepEqual(
    (getTask(replacementId)!.taskPackage.inputs as Record<string, unknown>)["rejectedArtifact"],
    PERSISTED_RESULT,
  );

  const secondNoResult = awaitingGatePrimary("task-plan-second-noresult", "plan", "tech-lead", {
    result: null,
  });
  const { nextTasks: secondFollow } = await gate(
    secondNoResult.id,
    "request-changes",
    "second pass",
    {},
  );

  assert.equal(secondFollow[0]!.id, replacementId, "dedup updates the same pending row");
  const inputs = getTask(replacementId)!.taskPackage.inputs as Record<string, unknown>;
  assert.ok(
    !("rejectedArtifact" in inputs),
    "the stale artifact from the prior result-bearing pass must be cleared",
  );
  assert.equal(inputs["rejectedTaskId"], secondNoResult.id, "rejectedTaskId advances to the newer task");
  assert.equal(inputs["requestedChanges"], "second pass");
  assert.equal(inputs["seededInput"], "keep-me", "dedup merge preserves existing inputs");
});
