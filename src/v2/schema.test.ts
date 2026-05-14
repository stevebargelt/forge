// Schema validation tests for v2 Workflow + Runtime YAML.
// Each test exercises one rule from SCHEMA.md / the schema.ts refinements.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowSchema, RuntimeSchema } from "./schema.js";

// ------------------------------------------------------------------
// Minimal valid fixtures
// ------------------------------------------------------------------

const minimalWorkflow = {
  name: "feature",
  description: "test",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "architect", agent: "architect", gate: "human" },
  ],
};

const minimalRuntime = {
  name: "claude-bedrock",
  description: "test",
  image: "agent-dev-worker:latest",
  models: { default: "claude-sonnet-4-6" },
  auth: { mode: "env-snapshot" },
  mounts: [{ host: "${TASK_DIR}", container: "/task" }],
  invocation: { command: "claude", args: ["--model", "{{MODEL}}"] },
  container: { name: "forge-{{TASK_ID}}" },
  result: { file: "/task/result.json" },
};

// ------------------------------------------------------------------
// Workflow happy path
// ------------------------------------------------------------------

test("WorkflowSchema accepts a minimal feature workflow", () => {
  const r = WorkflowSchema.safeParse(minimalWorkflow);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
});

test("WorkflowSchema applies defaults to omitted fields", () => {
  const r = WorkflowSchema.parse(minimalWorkflow);
  const step = r.steps[0]!;
  // gate explicitly set to 'human' in the fixture; preserved verbatim
  assert.equal(step.gate, "human");
  assert.equal(step.manual, false);
  assert.deepEqual(step.depends_on, []);
  assert.deepEqual(step.reds, []);
  assert.equal(step.runtime, "claude");
});

test("Step.gate defaults to 'auto' when omitted (v2 flip from v1 default)", () => {
  const r = WorkflowSchema.parse({
    ...minimalWorkflow,
    steps: [{ id: "architect", agent: "architect" }], // no gate field
  });
  assert.equal(r.steps[0]!.gate, "auto");
});

// ------------------------------------------------------------------
// Workflow refinements
// ------------------------------------------------------------------

test("Workflow: duplicate step id is rejected", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "architect", agent: "architect", gate: "human" },
      { id: "architect", agent: "architect", gate: "human" },
    ],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /duplicate step id: architect/);
});

test("Workflow: depends_on referencing unknown step is rejected", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "architect", agent: "architect", gate: "human" },
      { id: "plan", agent: "planner", gate: "human", depends_on: ["does-not-exist"] },
    ],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /unknown step 'does-not-exist'/);
});

test("Workflow: on_reject referencing unknown step is rejected", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "architect", agent: "architect", gate: "human", on_reject: "nope" },
    ],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /on_reject references unknown step 'nope'/);
});

test("Workflow: fanout referencing unknown step is rejected", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      {
        id: "investigate",
        agent: "investigator",
        gate: "human",
        fanout: {
          from_upstream: { step: "missing", array_key: "claims", input_key: "claim" },
        },
      },
    ],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /fanout.from_upstream references unknown step 'missing'/);
});

test("Workflow: cycle in depends_on is rejected", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "a", agent: "a", gate: "human", depends_on: ["b"] },
      { id: "b", agent: "b", gate: "human", depends_on: ["a"] },
    ],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /cycle in depends_on/);
});

// ------------------------------------------------------------------
// Manual step rules
// ------------------------------------------------------------------

test("Manual step: agent must be absent", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "ui-review", manual: true, agent: "ghost", gate: "human" },
    ],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /must not declare an agent/);
});

test("Manual step: gate must be human", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "ui-review", manual: true, gate: "verdict" },
    ],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /gate: human/);
});

test("Manual step: valid shape passes", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "brief", agent: "prompt-author", gate: "human" },
      { id: "ui-review", manual: true, depends_on: ["brief"], gate: "human", on_reject: "brief" },
    ],
  });
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
});

// ------------------------------------------------------------------
// Verdict-gate rules
// ------------------------------------------------------------------

test("gate: verdict requires at least one red", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [{ id: "build", agent: "implementer", gate: "verdict" }],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /gate: verdict requires at least one red/);
});

test("gate: verdict with reds passes", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      {
        id: "build",
        agent: "implementer",
        gate: "verdict",
        reds: [{ agent: "red-wide", authority: "authoritative" }],
      },
    ],
  });
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
});

// ------------------------------------------------------------------
// Non-manual must declare agent
// ------------------------------------------------------------------

test("Non-manual step without agent is rejected", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [{ id: "phantom", gate: "human" }],
  });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /must declare an agent/);
});

// ------------------------------------------------------------------
// Runtime happy path + refinements
// ------------------------------------------------------------------

test("RuntimeSchema accepts a minimal claude-bedrock runtime", () => {
  const r = RuntimeSchema.safeParse(minimalRuntime);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
});

test("Runtime: models.default is required", () => {
  const { models: _models, ...rest } = minimalRuntime;
  const r = RuntimeSchema.safeParse({ ...rest, models: { "spec-writer": "claude-sonnet-4-6" } });
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /'default' alias/);
});

test("Runtime: defaults are applied", () => {
  const r = RuntimeSchema.parse(minimalRuntime);
  assert.equal(r.container.remove_on_exit, true);
  assert.equal(r.container.idle_timeout_seconds, 300);
  assert.equal(r.result.stdout_log, "container.stdout.log");
});
