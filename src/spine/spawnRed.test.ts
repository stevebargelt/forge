// Unit test for spawnRed's pure launch-plan builder. The plan describes how
// each red in a RedConfig is recorded (authority + countsTowardGate). #113
// promoted `additional[]` reds from informational-specialist to first-class
// gating; this test pins the inheritance.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRef, RedConfig } from "../types/index.js";
import { buildLaunchPlan } from "./spawnRed.js";

const REF = (role: string): AgentRef => ({
  role,
  agentDir: `/tmp/${role}`,
  alias: "fast-orchestrator",
  model: "claude-haiku-4-5-20251001",
});

test("buildLaunchPlan: wide + narrow inherit RedConfig.authority + counts-toward-gate", () => {
  const cfg: RedConfig = {
    wide: REF("red-wide"),
    narrow: REF("red-narrow"),
    parallel: true,
    authority: "authoritative",
    gateOnVerdict: true,
  };
  const plan = buildLaunchPlan(cfg);
  assert.equal(plan.length, 2);
  for (const entry of plan) {
    assert.equal(entry.authority, "authoritative");
    assert.equal(entry.countsTowardGate, true);
  }
});

test("buildLaunchPlan: additional reds inherit authority + countsTowardGate (#113)", () => {
  // Pre-#113, additional[] was hardcoded specialist + countsTowardGate: false.
  // After #113 they inherit from the RedConfig.
  const cfg: RedConfig = {
    wide: REF("red-wide"),
    narrow: REF("red-narrow"),
    additional: [REF("red-frontend"), REF("red-backend"), REF("red-security")],
    parallel: true,
    authority: "authoritative",
    gateOnVerdict: true,
  };
  const plan = buildLaunchPlan(cfg);
  assert.equal(plan.length, 5);
  const additionals = plan.filter((e) =>
    ["red-frontend", "red-backend", "red-security"].includes(e.ref.role)
  );
  assert.equal(additionals.length, 3);
  for (const entry of additionals) {
    assert.equal(
      entry.authority,
      "authoritative",
      `${entry.ref.role} should inherit authoritative from RedConfig`
    );
    assert.equal(
      entry.countsTowardGate,
      true,
      `${entry.ref.role} should count toward gate (#113)`
    );
  }
});

test("buildLaunchPlan: a specialist-authority RedConfig propagates specialist to all reds", () => {
  // Investigation workflows still use authority: "specialist" at the RedConfig
  // level for their investigate-phase reds. Confirm that's what the plan emits
  // — #113 didn't promote investigation-phase reds, only build-phase ones via
  // the workflow config.
  const cfg: RedConfig = {
    wide: REF("red-wide"),
    parallel: true,
    authority: "specialist",
    gateOnVerdict: false,
  };
  const plan = buildLaunchPlan(cfg);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.authority, "specialist");
});

test("buildLaunchPlan: empty additional[] is equivalent to undefined", () => {
  const cfg: RedConfig = {
    wide: REF("red-wide"),
    additional: [],
    parallel: true,
    authority: "authoritative",
    gateOnVerdict: true,
  };
  const plan = buildLaunchPlan(cfg);
  assert.equal(plan.length, 1);
});

test("buildLaunchPlan: wide/narrow optional — only those provided land in the plan", () => {
  const cfg: RedConfig = {
    additional: [REF("red-frontend")],
    parallel: true,
    authority: "authoritative",
    gateOnVerdict: true,
  };
  const plan = buildLaunchPlan(cfg);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.ref.role, "red-frontend");
  assert.equal(plan[0]!.authority, "authoritative");
});
