// FG-630 integration regression: request-changes lineage must survive the real
// SQLite store and reach the retrying agent's mounted package.md. The unit test
// covers gate()'s returned task objects; this test deliberately re-reads the
// replacement row after each write and dispatches it through runNext.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gate } from "./gate.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { getDb } from "../store/db.js";
import { getTask, insertTask, tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import type { Task } from "../types/index.js";
import type { Workflow } from "./schema.js";

const WORKFLOW_NAME = "fg630-request-changes-artifact-integration";
const ARTIFACT_ONE = {
  status: "complete",
  artifact: "implementation plan",
  goal: "preserve the rejected plan for its revision",
  decisions: { persistence: "SQLite", retry: "same primary phase" },
  steps: [
    { id: "inspect", owner: "engineer", acceptance: "read previous artifact" },
    { id: "revise", owner: "engineer", acceptance: "address reviewer rationale" },
  ],
};
const ARTIFACT_TWO = {
  ...ARTIFACT_ONE,
  artifact: "revised implementation plan",
  decisions: { ...ARTIFACT_ONE.decisions, retry: "deduplicated pending replacement" },
};

const WORKFLOW: Workflow = {
  name: WORKFLOW_NAME,
  description: "FG-630 SQLite request-changes lineage fixture",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "plan", agent: "tech-lead", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ],
};

function ensureDispatchFixtures(): void {
  const home = process.env["FORGE_HOME"]!;
  const workflowPath = join(home, "workflows", `${WORKFLOW_NAME}.yml`);
  const runtimePath = join(home, "runtimes", "claude.yml");
  mkdirSync(dirname(workflowPath), { recursive: true });
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    workflowPath,
    `name: ${WORKFLOW_NAME}
description: test
inputs: []
steps:
  - id: plan
    agent: tech-lead
    gate: human
    runtime: claude
`,
  );
  writeFileSync(
    runtimePath,
    `name: claude
description: test runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(home);
}

function awaitingGateTask(id: string, runId: string, result: unknown, inputs: Record<string, unknown>): Task {
  return {
    id,
    runId,
    phase: "plan",
    agentRole: "tech-lead",
    status: "awaiting_gate",
    taskPackage: {
      taskId: id,
      runId,
      phase: "plan",
      role: "tech-lead",
      inputs,
      composedSystemPrompt: "fixture prompt",
    },
    result,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

const successfulContainer: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(stderrPath, "");
  writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify({ status: "complete" }));
  return 0;
};

test("FG-630: request-changes lineage round-trips through SQLite, dedup merge, and the retry agent package", async () => {
  ensureDispatchFixtures();
  const { runId } = startRun({
    workflow: WORKFLOW,
    title: "FG-630 request-changes SQLite round trip",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const first = awaitingGateTask("task-fg630-artifact-first", runId, ARTIFACT_ONE, {
    preservedFromOriginal: { ticket: "FG-630", reviewer: "human" },
  });
  insertTask(first);
  assert.notEqual(getDb().name, ":memory:", "fixture must exercise the integration harness's on-disk SQLite store");

  const firstGate = await gate(first.id, "request-changes", "add the missing revision details", {});
  const replacementId = firstGate.nextTasks[0]!.id;
  const freshRead = getTask(replacementId)!;
  const freshInputs = freshRead.taskPackage.inputs as Record<string, unknown>;

  // Fresh-mint proof: JSON was written to tasks.task_package and parsed back,
  // rather than merely observed on gate()'s in-memory return object.
  assert.deepEqual(freshInputs["rejectedArtifact"], ARTIFACT_ONE);
  assert.equal(freshInputs["rejectedTaskId"], first.id);
  assert.equal(freshInputs["rejectedRationale"], "add the missing revision details");
  assert.equal(freshInputs["requestedChanges"], "add the missing revision details");
  assert.deepEqual(freshInputs["preservedFromOriginal"], { ticket: "FG-630", reviewer: "human" });

  // A later rejected primary hits the pending replacement dedup path. Its
  // lineage overwrites only retry fields; unrelated original inputs must survive
  // updateTaskPackageInputs' SQLite read/merge/write cycle.
  const second = awaitingGateTask("task-fg630-artifact-second", runId, ARTIFACT_TWO, {
    unrelatedSecondPrimaryInput: "must not replace the pending row's original inputs",
  });
  insertTask(second);
  const dedup = await gate(second.id, "request-changes", "make the revised plan concrete", {});
  assert.equal(dedup.nextTasks[0]!.id, replacementId, "dedup updates the existing pending primary");

  const persisted = getTask(replacementId)!;
  const persistedFromRun = tasksForRun(runId).find((task) => task.id === replacementId)!;
  assert.deepEqual(persistedFromRun.taskPackage, persisted.taskPackage, "tasksForRun observes the same stored task package as getTask");
  const inputs = persisted.taskPackage.inputs as Record<string, unknown>;
  assert.deepEqual(inputs["rejectedArtifact"], ARTIFACT_TWO, "dedup persists the newest rejected artifact verbatim");
  assert.equal(inputs["rejectedTaskId"], second.id);
  assert.equal(inputs["rejectedRationale"], "make the revised plan concrete");
  assert.equal(inputs["requestedChanges"], "make the revised plan concrete");
  assert.deepEqual(inputs["preservedFromOriginal"], { ticket: "FG-630", reviewer: "human" }, "unrelated pending-row inputs survive the merge");
  assert.equal(inputs["unrelatedSecondPrimaryInput"], undefined, "dedup does not clobber the pending row with a different primary's inputs");

  // Established runNext delivery path: this writes the exact package.md mounted
  // at /task for the retrying agent. The JSON marker proves rejectedArtifact is
  // rendered from the persisted package, not only present in the database row.
  await runNext({ runId, workflow: WORKFLOW, dockerExec: successfulContainer });
  const packagePath = join(taskDir(runId, replacementId), "package.md");
  assert.ok(existsSync(packagePath), "the re-dispatched task writes its agent-facing package.md");
  const packageMarkdown = readFileSync(packagePath, "utf8");
  const renderedInputs = JSON.parse(packageMarkdown.match(/## Inputs\n\n```json\n([\s\S]*?)\n```/)![1]!) as Record<string, unknown>;
  assert.deepEqual(renderedInputs["rejectedArtifact"], ARTIFACT_TWO, "package.md carries the rejected artifact the agent must revise");
  assert.equal(renderedInputs["rejectedTaskId"], second.id, "package.md carries rejectedTaskId lineage");
  assert.equal(renderedInputs["requestedChanges"], "make the revised plan concrete", "package.md carries the retry rationale");
});
