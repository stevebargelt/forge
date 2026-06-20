import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inferOperatorBehaviorChanged,
  docsImpactSuggestion,
  loadOperatorSurfaces,
  OPERATOR_SURFACES,
} from "./contract.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "forge-contract-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ------------------------------------------------------------------
// Docs-drift Walk (#241): operator surface inference
// ------------------------------------------------------------------

test("inferOperatorBehaviorChanged: true for behavior surfaces, false for docs-only", () => {
  assert.equal(inferOperatorBehaviorChanged(["src/cli/commands/usage.ts"]), true);
  assert.equal(inferOperatorBehaviorChanged(["seeds/workflows/feature.yml"]), true);
  assert.equal(inferOperatorBehaviorChanged(["src/notify/milestone.ts"]), true);
  // Pure-docs change is the remediation, not a behavior change — must NOT flag.
  assert.equal(inferOperatorBehaviorChanged(["docs/concepts.md", "learnings/decisions/x.md"]), false);
  // DB schema is internal, not operator vocabulary — prefix match must not bleed
  // src/v2/schema.ts onto src/store/schema.ts.
  assert.equal(inferOperatorBehaviorChanged(["src/store/schema.ts"]), false);
  assert.equal(inferOperatorBehaviorChanged([]), false);
});

test("inferOperatorBehaviorChanged: covers vocabulary/resolution/provisioning surfaces", () => {
  // Regression for the gap where schema/resolution/provider/provisioning changes
  // could silently bypass docs-impact inference.
  for (const f of [
    "src/v2/schema.ts",            // workflow/runtime/policy vocabulary
    "src/v2/model-resolution.ts",  // capability/profile -> model
    "src/v2/provider-doctor.ts",   // forge providers doctor
    "src/v2/contract.ts",          // the contract shape itself
    "scripts/install-seeds.sh",    // what forge upgrade provisions
  ]) {
    assert.equal(inferOperatorBehaviorChanged([f]), true, `${f} should be an operator surface`);
  }
});

test("docsImpactSuggestion: names the hit surfaces and the documenter, or null", () => {
  const s = docsImpactSuggestion(["src/cli/commands/usage.ts", "seeds/runtimes/codex-subscription.yml"]);
  assert.ok(s);
  assert.match(s!, /src\/cli\//);
  assert.match(s!, /seeds\/runtimes\//);
  assert.match(s!, /documentation-maintainer/);
  assert.equal(docsImpactSuggestion(["docs/concepts.md"]), null);
});

test("inferOperatorBehaviorChanged: honors an explicit project surface list", () => {
  const projectSurfaces = ["src/routes/", "src/components/"];
  // A non-forge project's surfaces — forge's own src/cli/ is NOT one of them.
  assert.equal(inferOperatorBehaviorChanged(["src/routes/api.ts"], projectSurfaces), true);
  assert.equal(inferOperatorBehaviorChanged(["src/cli/commands/usage.ts"], projectSurfaces), false);
});

// ------------------------------------------------------------------
// #246: project-configurable operator surfaces (docs-surfaces.yml)
// ------------------------------------------------------------------

function writeDocsSurfaces(projectDir: string, body: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "docs-surfaces.yml"), body);
}

test("loadOperatorSurfaces: no projectDir → forge defaults", () => {
  assert.deepEqual(loadOperatorSurfaces(), OPERATOR_SURFACES);
});

test("loadOperatorSurfaces: absent override file → forge defaults", () => {
  assert.deepEqual(loadOperatorSurfaces(dir), OPERATOR_SURFACES);
});

test("loadOperatorSurfaces: present file FULLY replaces defaults (not a merge)", () => {
  writeDocsSurfaces(dir, "surfaces:\n  - src/routes/\n  - public/\n");
  const surfaces = loadOperatorSurfaces(dir);
  assert.deepEqual(surfaces, ["src/routes/", "public/"]);
  // Replacement, not extension: forge's own surfaces must be gone.
  assert.ok(!surfaces.includes("src/cli/"));
  // And inference uses them end-to-end.
  assert.equal(inferOperatorBehaviorChanged(["src/routes/x.ts"], surfaces), true);
  assert.equal(inferOperatorBehaviorChanged(["src/cli/commands/x.ts"], surfaces), false);
});

test("loadOperatorSurfaces: malformed file → fail-soft to defaults (advisory must not crash)", () => {
  writeDocsSurfaces(dir, "surfaces: not-a-list\n");
  assert.deepEqual(loadOperatorSurfaces(dir), OPERATOR_SURFACES);
  writeDocsSurfaces(dir, "wrong_key: [a]\n"); // .strict() rejects unknown key
  assert.deepEqual(loadOperatorSurfaces(dir), OPERATOR_SURFACES);
  writeDocsSurfaces(dir, ":\n  : not yaml :\n");
  assert.deepEqual(loadOperatorSurfaces(dir), OPERATOR_SURFACES);
});
