// Tests for discipline-specific red wiring (#96 sub-shift 1, gating semantics
// promoted in #113). Confirms each `feature*` workflow's build phase carries
// three discipline reds (frontend, backend, security) in RedConfig.additional,
// and that the specialist agent constructor stamps the discipline tag
// correctly. The "specialist" function/test names are kept for historical
// continuity; the gating behavior matches wide/narrow now.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, specialistAgent } from "./_agentRefs.js";
import { loadWorkflow, findPhase } from "../spine/workflows.js";

test("specialistAgent stamps discipline on the resulting AgentRef", () => {
  const a = specialistAgent("frontend-specialist", "spec-writer", "frontend");
  assert.equal(a.role, "frontend-specialist");
  assert.equal(a.alias, "spec-writer");
  assert.equal(a.discipline, "frontend");
});

test("agent() does not stamp discipline (existing behavior)", () => {
  const a = agent("engineer", "spec-writer");
  assert.equal(a.discipline, undefined);
});

test("feature workflow build phase has three specialist reds in additional", async () => {
  const wf = await loadWorkflow("feature");
  const build = findPhase(wf, "build");
  assert.ok(build, "build phase missing");
  assert.ok(build.reds, "build phase reds missing");
  assert.ok(Array.isArray(build.reds.additional), "additional must be an array");
  assert.equal(build.reds.additional.length, 3);
  const roles = build.reds.additional.map((r) => r.role).sort();
  assert.deepEqual(roles, ["red-backend", "red-frontend", "red-security"]);
});

test("feature-ui-design-needed workflow build phase has three specialist reds", async () => {
  const wf = await loadWorkflow("feature-ui-design-needed");
  const build = findPhase(wf, "build");
  assert.ok(build && build.reds && build.reds.additional);
  assert.equal(build.reds.additional.length, 3);
});

test("feature-ui-design-provided workflow build phase has three specialist reds", async () => {
  const wf = await loadWorkflow("feature-ui-design-provided");
  const build = findPhase(wf, "build");
  assert.ok(build && build.reds && build.reds.additional);
  assert.equal(build.reds.additional.length, 3);
});

test("specialist reds keep authoritative wide/narrow alongside (not replaced)", async () => {
  const wf = await loadWorkflow("feature");
  const build = findPhase(wf, "build");
  assert.ok(build && build.reds);
  // Authoritative wide/narrow still present
  assert.ok(build.reds.wide, "wide red removed by specialist wiring (regression)");
  assert.ok(build.reds.narrow, "narrow red removed by specialist wiring (regression)");
  assert.equal(build.reds.authority, "authoritative");
  assert.equal(build.reds.gateOnVerdict, true);
});

test("workflows that don't have a build phase don't get specialist reds", async () => {
  // ui-design has no build phase — confirm we didn't accidentally attach
  // specialists to its phases.
  const wf = await loadWorkflow("ui-design");
  for (const phase of wf.phases) {
    if (phase.reds) {
      assert.equal(
        phase.reds.additional ?? undefined,
        undefined,
        `phase ${phase.name} has unexpected additional reds`
      );
    }
  }
});

test("investigation workflow's specialist reds remain via the existing reds field, not additional", async () => {
  // investigation.investigate has authority: "specialist" already (not via
  // additional). The new `additional` field is for ADDING specialist coverage
  // to phases that already have authoritative reds. Confirm we didn't migrate
  // investigation's existing specialist reds into additional.
  const wf = await loadWorkflow("investigation");
  const investigate = findPhase(wf, "investigate");
  assert.ok(investigate && investigate.reds);
  assert.equal(investigate.reds.authority, "specialist");
  assert.equal(investigate.reds.additional ?? undefined, undefined);
});
