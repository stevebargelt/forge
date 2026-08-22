// FG-349: the config-graph contract vocabulary and the projection helper. These
// are the invariants every consumer (dashboard, CLI, campaign reports) relies
// on, tested away from any resolver.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_GRAPH_VERSION,
  ROW_STATUSES,
  OVERRIDE_SEMANTICS,
  TRUTH_AXES,
  CAPABILITY_PROVENANCE,
  READINESS_STATES,
  project,
} from "./config-graph-types.js";

test("the vocabulary enums are exported and complete", () => {
  assert.deepEqual([...TRUTH_AXES], ["SOURCE", "DERIVED", "EFFECTIVE", "RECORDED"]);
  assert.deepEqual(
    [...ROW_STATUSES].sort(),
    ["absent", "active", "derived", "missing", "overridden", "stale", "template-only", "warning"],
  );
  assert.ok(OVERRIDE_SEMANTICS.includes("full-replacement"));
  assert.ok(OVERRIDE_SEMANTICS.includes("merge"));
  assert.ok(OVERRIDE_SEMANTICS.includes("none"));
  assert.deepEqual([...CAPABILITY_PROVENANCE], ["configured", "detected", "inferred", "unavailable", "unknown"]);
  assert.deepEqual([...READINESS_STATES], ["available", "unavailable", "deferred", "unknown"]);
});

test("ConfigGraph carries a version constant", () => {
  assert.equal(typeof CONFIG_GRAPH_VERSION, "number");
  assert.equal(CONFIG_GRAPH_VERSION, 1);
});

test("project() maps a native verdict into the vocabulary WITHOUT discarding it", () => {
  const native = { source: "project", path: "/p/.forge/x.yml", quirky: true };
  const row = project(native, { status: "overridden", overrideSemantics: "full-replacement" });
  // projected fields present
  assert.equal(row.status, "overridden");
  assert.equal(row.overrideSemantics, "full-replacement");
  // native verdict round-trips verbatim (same reference, unmodified)
  assert.equal(row.native, native);
  assert.deepEqual(row.native, { source: "project", path: "/p/.forge/x.yml", quirky: true });
});

test("the types module imports NO resolver (contract stays independent)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config-graph-types.ts"), "utf8");
  const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
  assert.equal(importLines.length, 0, `expected zero imports, found: ${importLines.join(" | ")}`);
});
