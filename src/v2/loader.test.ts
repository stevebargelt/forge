// Loader tests: workspace fallback, project override, error surfacing.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow, loadRuntime, loadModelPolicy } from "./loader.js";

const VALID_WORKFLOW = `
name: feature
description: test
inputs:
  - { name: brief, required: true, type: text }
steps:
  - { id: architect, agent: architect, gate: human }
`;

const VALID_RUNTIME = `
name: claude-bedrock
description: test
image: agent-dev-worker:latest
models:
  default: claude-sonnet-4-6
auth:
  mode: env-snapshot
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: claude
  args: ["--model", "{{MODEL}}"]
container:
  name: forge-{{TASK_ID}}
result:
  file: /task/result.json
`;

let originalForgeHome: string | undefined;
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-v2-loader-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-v2-proj-"));
  process.env.FORGE_HOME = homeDir;
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

test("loadWorkflow: reads from workspace FORGE_HOME by default", () => {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(join(homeDir, "workflows", "feature.yml"), VALID_WORKFLOW);

  const wf = loadWorkflow("feature");
  assert.equal(wf.name, "feature");
  assert.equal(wf.steps[0]?.id, "architect");
});

test("loadWorkflow: project override replaces workspace YAML", () => {
  // Workspace has 1 step, project has 2 steps. Project wins.
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(join(homeDir, "workflows", "feature.yml"), VALID_WORKFLOW);

  const projectYaml = `
name: feature
description: project override
inputs: []
steps:
  - { id: a, agent: a, gate: human }
  - { id: b, agent: b, gate: human, depends_on: [a] }
`;
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "workflows", "feature.yml"), projectYaml);

  const wf = loadWorkflow("feature", { projectDir });
  assert.equal(wf.steps.length, 2);
  assert.equal(wf.description, "project override");
});

test("loadWorkflow: falls back to workspace if project override doesn't exist", () => {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(join(homeDir, "workflows", "feature.yml"), VALID_WORKFLOW);
  // No project file written.

  const wf = loadWorkflow("feature", { projectDir });
  assert.equal(wf.steps.length, 1);
});

test("loadWorkflow: missing file throws with the resolved path", () => {
  // Don't write anything.
  assert.throws(() => loadWorkflow("not-real"), /not-real/);
});

test("loadWorkflow: name mismatch between filename and YAML body is rejected", () => {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    join(homeDir, "workflows", "feature.yml"),
    VALID_WORKFLOW.replace("name: feature", "name: something-else")
  );
  assert.throws(() => loadWorkflow("feature"), /declares name='something-else'/);
});

test("loadWorkflow: invalid YAML throws with parse error", () => {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  // ': :' is a YAML syntax error
  writeFileSync(join(homeDir, "workflows", "feature.yml"), "name: feature\nsteps: :\n");
  assert.throws(() => loadWorkflow("feature"), /YAML parse error/);
});

test("loadWorkflow: schema violation throws with field path", () => {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  // gate: bogus is not in the enum
  writeFileSync(
    join(homeDir, "workflows", "feature.yml"),
    `
name: feature
description: test
inputs: []
steps:
  - { id: a, agent: a, gate: bogus }
`
  );
  let err: unknown;
  try {
    loadWorkflow("feature");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  const msg = (err as Error).message;
  assert.match(msg, /schema validation failed/);
  assert.match(msg, /steps/);
});

test("loadRuntime: reads from workspace FORGE_HOME by default", () => {
  mkdirSync(join(homeDir, "runtimes"), { recursive: true });
  writeFileSync(join(homeDir, "runtimes", "claude-bedrock.yml"), VALID_RUNTIME);

  const rt = loadRuntime("claude-bedrock");
  assert.equal(rt.name, "claude-bedrock");
  assert.equal(rt.image, "agent-dev-worker:latest");
  assert.equal(rt.models.default, "claude-sonnet-4-6");
});

test("loadRuntime: rejects missing 'default' model alias with field-pathed error", () => {
  mkdirSync(join(homeDir, "runtimes"), { recursive: true });
  writeFileSync(
    join(homeDir, "runtimes", "claude-bedrock.yml"),
    VALID_RUNTIME.replace("default: claude-sonnet-4-6", "spec-writer: claude-sonnet-4-6")
  );
  let err: unknown;
  try {
    loadRuntime("claude-bedrock");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.match((err as Error).message, /models/);
  assert.match((err as Error).message, /'default' alias/);
});

test("loadRuntime: project override replaces workspace YAML", () => {
  mkdirSync(join(homeDir, "runtimes"), { recursive: true });
  writeFileSync(join(homeDir, "runtimes", "claude-bedrock.yml"), VALID_RUNTIME);

  const override = VALID_RUNTIME.replace("agent-dev-worker:latest", "custom-image:v2");
  mkdirSync(join(projectDir, ".forge", "runtimes"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "runtimes", "claude-bedrock.yml"), override);

  const rt = loadRuntime("claude-bedrock", { projectDir });
  assert.equal(rt.image, "custom-image:v2");
});

const VALID_POLICY = `
on_unavailable: fail
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      review: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: { review: claude-subscription }
`;

test("loadModelPolicy: returns undefined when no policy file exists (legacy mode)", () => {
  // Neither workspace nor project has model-policy.yml — must not throw.
  assert.equal(loadModelPolicy(), undefined);
  assert.equal(loadModelPolicy({ projectDir }), undefined);
});

test("loadModelPolicy: reads + validates the workspace policy", () => {
  writeFileSync(join(homeDir, "model-policy.yml"), VALID_POLICY);
  const policy = loadModelPolicy();
  assert.ok(policy);
  assert.equal(policy.defaults.profile, "claude-subscription");
  assert.equal(policy.model_profiles["claude-subscription"]?.map["review"]?.model, "claude-sonnet-4-6");
});

test("loadModelPolicy: project policy replaces workspace policy", () => {
  writeFileSync(join(homeDir, "model-policy.yml"), VALID_POLICY);
  const override = VALID_POLICY.replace("claude-sonnet-4-6", "claude-opus-4-8");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), override);

  const policy = loadModelPolicy({ projectDir });
  assert.equal(policy?.model_profiles["claude-subscription"]?.map["review"]?.model, "claude-opus-4-8");
});

test("loadModelPolicy: validation error names the file path", () => {
  // defaults.profile references a profile that isn't defined.
  writeFileSync(
    join(homeDir, "model-policy.yml"),
    VALID_POLICY.replace("profile: claude-subscription", "profile: ghost")
  );
  let err: unknown;
  try {
    loadModelPolicy();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.match((err as Error).message, /model-policy/);
  assert.match((err as Error).message, /unknown profile 'ghost'/);
});
