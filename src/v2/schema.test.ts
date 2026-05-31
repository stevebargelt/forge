// Schema validation tests for v2 Workflow + Runtime YAML.
// Each test exercises one rule from SCHEMA.md / the schema.ts refinements.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowSchema, RuntimeSchema, ModelPolicySchema } from "./schema.js";

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

test("Workflow: fanout with agent_map and discipline_key parses cleanly", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "plan", agent: "tech-lead", gate: "human" },
      {
        id: "build",
        agent: "engineer",
        depends_on: ["plan"],
        gate: "verdict",
        reds: [{ agent: "red-wide", authority: "authoritative" }],
        fanout: {
          from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
          agent_map: { frontend: "frontend-specialist", backend: "backend-specialist" },
          discipline_key: "discipline",
        },
      },
    ],
  });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  const buildStep = r.data!.steps[1]!;
  assert.deepEqual(buildStep.fanout?.agent_map, { frontend: "frontend-specialist", backend: "backend-specialist" });
  assert.equal(buildStep.fanout?.discipline_key, "discipline");
});

test("Workflow: fanout without agent_map still validates (backwards compat); both new fields are optional", () => {
  const r = WorkflowSchema.safeParse({
    ...minimalWorkflow,
    steps: [
      { id: "plan", agent: "tech-lead", gate: "human" },
      {
        id: "build",
        agent: "engineer",
        depends_on: ["plan"],
        gate: "human",
        fanout: {
          from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
        },
      },
    ],
  });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  const buildStep = r.data!.steps[1]!;
  assert.equal(buildStep.fanout?.agent_map, undefined);
  assert.equal(buildStep.fanout?.discipline_key, undefined);
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

// ------------------------------------------------------------------
// ModelPolicy (AWN-7) — opt-in policy YAML
// ------------------------------------------------------------------

const minimalPolicy = {
  model_profiles: {
    "claude-subscription": {
      provider: "anthropic",
      auth: "subscription",
      map: {
        reasoning: { model: "claude-opus-4-8", cost_tier: "premium" },
        review: { model: "claude-sonnet-4-6", cost_tier: "standard" },
      },
    },
    "claude-bedrock": {
      provider: "anthropic",
      auth: "bedrock",
      on_unavailable: "fail",
      map: { review: { model: "us.anthropic.claude-sonnet-4-6", cost_tier: "standard" } },
    },
  },
  defaults: {
    profile: "claude-subscription",
    activity: { review: "claude-subscription" },
  },
  overrides: { agents: { "red-security": "claude-bedrock" } },
  allowed_profiles: ["claude-subscription", "claude-bedrock"],
};

test("ModelPolicy accepts a minimal valid policy", () => {
  const r = ModelPolicySchema.safeParse(minimalPolicy);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
});

test("ModelPolicy: on_unavailable defaults to fail; overrides default", () => {
  const r = ModelPolicySchema.parse(minimalPolicy);
  assert.equal(r.on_unavailable, "fail");
  assert.equal(r.model_profiles["claude-subscription"]!.on_unavailable, undefined);
  assert.equal(r.model_profiles["claude-bedrock"]!.on_unavailable, "fail");
  // optional sections default to empty rather than undefined
  assert.deepEqual(r.overrides.agents, { "red-security": "claude-bedrock" });
});

test("ModelPolicy: defaults.profile must reference an existing profile", () => {
  const bad = { ...minimalPolicy, defaults: { ...minimalPolicy.defaults, profile: "ghost" } };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /unknown profile 'ghost'/);
});

test("ModelPolicy: defaults.activity.* must reference an existing profile", () => {
  const bad = {
    ...minimalPolicy,
    defaults: { profile: "claude-subscription", activity: { review: "ghost" } },
  };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /unknown profile 'ghost'/);
});

test("ModelPolicy: overrides.agents.* must reference an existing profile", () => {
  const bad = { ...minimalPolicy, overrides: { agents: { "red-security": "ghost" } } };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /unknown profile 'ghost'/);
});

test("ModelPolicy: allowed_profiles entries must reference existing profiles", () => {
  const bad = { ...minimalPolicy, allowed_profiles: ["claude-subscription", "ghost"] };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /unknown profile 'ghost'/);
});

test("ModelPolicy: a profile map must contain at least one capability alias", () => {
  const bad = {
    ...minimalPolicy,
    model_profiles: {
      ...minimalPolicy.model_profiles,
      "claude-subscription": { provider: "anthropic", auth: "subscription", map: {} },
    },
  };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
  assert.match(JSON.stringify(r.error!.issues), /at least one capability alias/);
});

test("ModelPolicy: at least one profile must be defined", () => {
  const bad = {
    model_profiles: {},
    defaults: { profile: "x", activity: {} },
  };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
});

test("ModelPolicy: auth enum rejects unknown modes", () => {
  const bad = {
    ...minimalPolicy,
    model_profiles: {
      ...minimalPolicy.model_profiles,
      "claude-subscription": {
        provider: "anthropic",
        auth: "magic",
        map: { review: { model: "claude-sonnet-4-6", cost_tier: "standard" } },
      },
    },
  };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
});

test("ModelPolicy: cost_tier enum rejects unknown tiers", () => {
  const bad = {
    ...minimalPolicy,
    model_profiles: {
      "claude-subscription": {
        provider: "anthropic",
        auth: "subscription",
        map: { review: { model: "claude-sonnet-4-6", cost_tier: "luxury" } },
      },
    },
    defaults: { profile: "claude-subscription", activity: {} },
  };
  const r = ModelPolicySchema.safeParse(bad);
  assert.ok(!r.success);
});
