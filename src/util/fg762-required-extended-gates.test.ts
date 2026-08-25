// FG-762 regression guard: `dashboard_browser` is the only real-browser tier.
// It must remain a dependency of the required test-extended aggregate alongside
// every other extended tier, and that aggregate must reject every non-success.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type WorkflowJob = {
  needs?: unknown;
  steps?: unknown;
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

type YamlParser = {
  load(source: string): unknown;
};

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlParser;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = yaml.load(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as Workflow;
const jobs = workflow.jobs ?? {};

const REQUIRED_EXTENDED_TIERS = [
  "integration_1",
  "integration_2",
  "integration_3",
  "integration_4",
  "integration_5",
  "integration_6",
  "integration_7",
  "integration_8",
  "integration_serial",
  "worktree",
  "dashboard_integration",
  "fg693_alias_identity",
  "dashboard_browser",
] as const;

test("FG-762: test-extended needs every required extended tier", () => {
  const needs = jobs["test-extended"]?.needs;
  assert.ok(Array.isArray(needs), "test-extended must declare its required tiers in needs");

  for (const tier of REQUIRED_EXTENDED_TIERS) {
    assert.ok(needs.includes(tier), `test-extended must need ${tier}`);
  }
});

test("FG-762: dashboard_browser remains a required, not advisory, merge gate", () => {
  const needs = jobs["test-extended"]?.needs;
  assert.ok(Array.isArray(needs), "test-extended must declare its required tiers in needs");
  assert.ok(
    needs.includes("dashboard_browser"),
    "FG-762: dashboard_browser must remain in test-extended needs; dropping it re-downgrades the only real-browser gate to advisory",
  );
});

test("FG-762: test-extended fails closed for every non-success dependency", () => {
  const steps = jobs["test-extended"]?.steps;
  assert.ok(Array.isArray(steps), "test-extended must contain an aggregate step");

  const aggregateStep = steps.find(
    (step): step is Record<string, unknown> => typeof step === "object" && step !== null && "run" in step,
  );
  assert.ok(aggregateStep, "test-extended must contain a run step that aggregates dependency results");

  const run = aggregateStep.run;
  assert.ok(typeof run === "string", "the aggregate step must have a shell script");
  const env = aggregateStep.env;
  assert.ok(typeof env === "object" && env !== null, "the aggregate step must define its needs JSON environment");
  const needsJson = (env as Record<string, unknown>).NEEDS_JSON;
  assert.ok(typeof needsJson === "string", "the aggregate step must pass needs JSON to its shell script");
  assert.match(needsJson, /toJSON\(needs\)/, "the aggregate must derive its inputs from all test-extended needs");
  assert.match(
    run,
    /Object\.entries\(needs\)\.filter\(\s*\(\s*\[\s*,\s*v\s*\]\s*\)\s*=>\s*v\.result\s*!==\s*["']success["']\s*\)/,
    "the aggregate must reject every dependency whose result is not success",
  );
});

test("FG-762: both required branch-protection job contexts remain defined", () => {
  assert.ok(jobs.test, "the required fast merge-gate job 'test' must exist");
  assert.ok(jobs["test-extended"], "the required extended merge-gate job 'test-extended' must exist");
});
