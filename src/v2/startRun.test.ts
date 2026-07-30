import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun, CONTROL_PLANE_METADATA_KEYS } from "./startRun.js";
import { getRun } from "../store/runs.js";
import type { Workflow } from "./schema.js";

const HELLO_WORKFLOW: Workflow = {
  name: "test-startup",
  description: "stub for startRun tests",
  review_mode: "legacy_verdict",
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

test("startRun: modelProfile lands in metadata when provided (AWN-7 --profile)", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "with profile",
    inputs: { brief: "x" },
    projectDir: "/tmp",
    modelProfile: "claude-bedrock",
  });
  const run = getRun(result.runId);
  assert.equal((run!.metadata as Record<string, unknown>)["modelProfile"], "claude-bedrock");
});

test("startRun: no modelProfile key when --profile omitted", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "no profile",
    inputs: { brief: "x" },
    projectDir: "/tmp",
  });
  const run = getRun(result.runId);
  assert.ok(!("modelProfile" in (run!.metadata as Record<string, unknown>)));
});

// FG-28: --tag stores tags in run metadata
test("startRun: tags land in metadata when provided", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "with tags",
    inputs: { brief: "x" },
    projectDir: "/tmp",
    tags: ["ios", "mobile"],
  });
  const run = getRun(result.runId);
  assert.deepEqual((run!.metadata as Record<string, unknown>)["tags"], ["ios", "mobile"]);
});

test("startRun: no tags key when tags omitted", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "no tags",
    inputs: { brief: "x" },
    projectDir: "/tmp",
  });
  const run = getRun(result.runId);
  assert.ok(!("tags" in (run!.metadata as Record<string, unknown>)));
});

// FG-350: routeKey and workflowSource receipt tests

const MINIMAL_POLICY_YAML = `
version: 1
governance:
  accountable: human
routes:
  backend:
    responsible: backend-agent
    path: invoke
    consulted: []
    required_followups: [review-agent]
    informed: []
    force_rules: []
`.trim();

test("startRun: routeKey stores routeReceipt in metadata when policy resolves", () => {
  const dir = mkdtempSync(join(tmpdir(), "startRun-route-"));
  try {
    mkdirSync(join(dir, ".forge"), { recursive: true });
    writeFileSync(join(dir, ".forge", "routing-policy.yml"), MINIMAL_POLICY_YAML);
    const result = startRun({
      workflow: HELLO_WORKFLOW,
      title: "with route",
      inputs: { brief: "x" },
      projectDir: dir,
      routeKey: "backend",
    });
    const run = getRun(result.runId);
    const meta = run!.metadata as Record<string, unknown>;
    const receipt = meta["routeReceipt"] as Record<string, unknown>;
    assert.ok(receipt, "routeReceipt should be present");
    assert.equal(receipt["routeKey"], "backend");
    assert.equal(receipt["source"], "project");
    assert.equal(receipt["responsible"], "backend-agent");
    assert.equal(receipt["pathType"], "invoke");
    assert.deepEqual(receipt["requiredFollowups"], ["review-agent"]);
    assert.ok(typeof receipt["policyPath"] === "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startRun: routeReceipt has warnings when routeKey not in policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "startRun-route-bad-"));
  try {
    mkdirSync(join(dir, ".forge"), { recursive: true });
    writeFileSync(join(dir, ".forge", "routing-policy.yml"), MINIMAL_POLICY_YAML);
    const result = startRun({
      workflow: HELLO_WORKFLOW,
      title: "with bad route",
      inputs: { brief: "x" },
      projectDir: dir,
      routeKey: "nonexistent-route",
    });
    const run = getRun(result.runId);
    const meta = run!.metadata as Record<string, unknown>;
    const receipt = meta["routeReceipt"] as Record<string, unknown>;
    assert.ok(receipt, "routeReceipt should be present even on failure");
    assert.equal(receipt["routeKey"], "nonexistent-route");
    assert.ok(Array.isArray(receipt["warnings"]), "warnings should be an array");
    assert.ok((receipt["warnings"] as string[]).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startRun: no routeReceipt when routeKey omitted", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "no route",
    inputs: { brief: "x" },
    projectDir: "/tmp",
  });
  const run = getRun(result.runId);
  assert.ok(!("routeReceipt" in (run!.metadata as Record<string, unknown>)));
});

test("startRun: workflowSource stores workflowReceipt in metadata", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "with workflow source",
    inputs: { brief: "x" },
    projectDir: "/tmp",
    workflowSource: { source: "project", path: "/tmp/.forge/workflows/test-startup.yml" },
  });
  const run = getRun(result.runId);
  const meta = run!.metadata as Record<string, unknown>;
  const receipt = meta["workflowReceipt"] as Record<string, unknown>;
  assert.ok(receipt, "workflowReceipt should be present");
  assert.equal(receipt["source"], "project");
  assert.equal(receipt["path"], "/tmp/.forge/workflows/test-startup.yml");
});

test("startRun: no workflowReceipt when workflowSource omitted", () => {
  const result = startRun({
    workflow: HELLO_WORKFLOW,
    title: "no workflow source",
    inputs: { brief: "x" },
    projectDir: "/tmp",
  });
  const run = getRun(result.runId);
  assert.ok(!("workflowReceipt" in (run!.metadata as Record<string, unknown>)));
});

test("CONTROL_PLANE_METADATA_KEYS includes routeReceipt and workflowReceipt", () => {
  assert.ok(CONTROL_PLANE_METADATA_KEYS.includes("routeReceipt" as never));
  assert.ok(CONTROL_PLANE_METADATA_KEYS.includes("workflowReceipt" as never));
});
