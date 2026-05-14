import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun } from "./startRun.js";
import { getRun } from "../store/runs.js";
import type { Workflow } from "./schema.js";

const HELLO_WORKFLOW: Workflow = {
  name: "test-startup",
  description: "stub for startRun tests",
  inputs: [
    { name: "brief", required: true, type: "text" },
    { name: "optional-thing", required: false, type: "text" },
  ],
  steps: [
    {
      id: "first",
      agent: "test-agent",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
  ],
};

test("startRun: creates a run row with provided inputs in metadata", () => {
  // FORGE_HOME is already mocked by the test runner's mktemp dance (npm test
  // sets FORGE_HOME=$(mktemp -d ...) per the package.json test script). Each
  // test run gets a fresh DB.
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "kickoff test",
    inputs: { brief: "ship the thing" },
    projectDir: "/tmp/some-project",
  });

  assert.ok(result.runId.startsWith("run-"));
  const run = getRun(result.runId);
  assert.ok(run);
  assert.equal(run!.title, "kickoff test");
  assert.equal(run!.workflow, "test-startup");
  assert.equal(run!.status, "active");
  assert.equal(run!.projectDir, "/tmp/some-project");
  assert.equal((run!.metadata as Record<string, unknown>)["brief"], "ship the thing");
});

test("startRun: missing required input throws with the input name", () => {
  assert.throws(
    () => startRun({
      workflow: HELLO_WORKFLOW,
      title: "missing input",
      inputs: {}, // no 'brief'
      projectDir: "/tmp",
    }),
    /required input 'brief' missing/
  );
});

test("startRun: optional inputs may be absent", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "optional absent",
    inputs: { brief: "x" },  // no 'optional-thing'
    projectDir: "/tmp",
  });
  assert.ok(result.runId);
});

test("startRun: designDir lands in metadata when provided", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "with design",
    inputs: { brief: "x" },
    projectDir: "/tmp",
    designDir: "/tmp/some-design-corpus",
  });
  const run = getRun(result.runId);
  assert.equal((run!.metadata as Record<string, unknown>)["designDir"], "/tmp/some-design-corpus");
});
