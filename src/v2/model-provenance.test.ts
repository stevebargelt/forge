// FG-560 (step 9): the SHARED operator-surface provenance helpers. These are the
// one place every surface (forge model resolve / forge show / the dashboard string)
// turns the mapping-path axis into text, so if they drift, every surface drifts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mappingPathSummary,
  isActivityUnmappedProvenance,
  buildActivityUnmappedDetail,
  renderActivityUnmapped,
} from "./model-provenance.js";

test("mappingPathSummary: legacy (no mappingPath) → undefined (nothing rendered)", () => {
  assert.equal(mappingPathSummary(undefined, undefined), undefined);
  assert.equal(mappingPathSummary(undefined, "role-derived"), undefined);
});

test("mappingPathSummary: an exact hit reads plainly; explicit is noted", () => {
  assert.match(mappingPathSummary("exact", "role-derived")!, /^exact —/);
  assert.match(mappingPathSummary("exact", "explicit")!, /exact — the explicit activity is mapped directly/);
});

test("mappingPathSummary: a default fallback ALWAYS reads distinctly and never as an explicit hit", () => {
  const roleDerived = mappingPathSummary("default-fallback", "role-derived")!;
  assert.match(roleDerived, /default-fallback/);
  assert.match(roleDerived, /map\.default/);

  const explicit = mappingPathSummary("default-fallback", "explicit")!;
  assert.match(explicit, /default-fallback/);
  // The load-bearing invariant: an explicit default fallback names that the activity
  // is NOT mapped — it must never read as though it satisfied the explicit activity.
  assert.match(explicit, /EXPLICIT activity is NOT mapped/);
});

test("isActivityUnmappedProvenance: only explicit + default-fallback is the refusal shape", () => {
  assert.equal(isActivityUnmappedProvenance("default-fallback", "explicit"), true);
  assert.equal(isActivityUnmappedProvenance("default-fallback", "role-derived"), false);
  assert.equal(isActivityUnmappedProvenance("exact", "explicit"), false);
  assert.equal(isActivityUnmappedProvenance(undefined, undefined), false);
});

test("buildActivityUnmappedDetail carries every field a script needs, with the default labelled diagnostic-only", () => {
  const d = buildActivityUnmappedDetail({
    agent: "engineer",
    activity: "reasoning",
    profile: "claude-bedrock",
    resolutionSource: "overrides.agents.engineer",
    availableMappings: ["review", "default"],
    diagnosticDefaultModel: "us.anthropic.claude-sonnet-4-6",
    policyPath: "/home/x/.forge/model-policy.yml",
    message: "activity_unmapped: explicit activity 'reasoning' ...",
  });
  assert.equal(d.reason, "activity_unmapped");
  assert.equal(d.agent, "engineer");
  assert.equal(d.activity, "reasoning");
  assert.equal(d.profile, "claude-bedrock");
  assert.equal(d.resolutionSource, "overrides.agents.engineer");
  assert.deepEqual(d.availableMappings, ["review", "default"]);
  assert.equal(d.diagnosticDefaultModel, "us.anthropic.claude-sonnet-4-6");
  assert.equal(d.diagnosticOnly, true);
  assert.equal(d.policyPath, "/home/x/.forge/model-policy.yml");
});

test("renderActivityUnmapped: the human block names every field including diagnostic-only + policy path", () => {
  const lines = renderActivityUnmapped(
    buildActivityUnmappedDetail({
      agent: "engineer",
      activity: "reasoning",
      profile: "claude-bedrock",
      resolutionSource: "overrides.agents.engineer",
      availableMappings: ["review", "default"],
      diagnosticDefaultModel: "us.anthropic.claude-sonnet-4-6",
      policyPath: "/home/x/.forge/model-policy.yml",
      message: "activity_unmapped ...",
    }),
  );
  const text = lines.join("\n");
  assert.match(text, /activity_unmapped/);
  assert.match(text, /agent:\s+engineer/);
  assert.match(text, /activity:\s+reasoning \(explicit\)/);
  assert.match(text, /selected profile:\s+claude-bedrock/);
  assert.match(text, /resolution source:\s+overrides\.agents\.engineer/);
  assert.match(text, /available mappings:\s+review, default/);
  assert.match(text, /DIAGNOSTIC ONLY/);
  assert.match(text, /policy path:\s+\/home\/x\/\.forge\/model-policy\.yml/);
});
