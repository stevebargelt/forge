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
  classifyDocsSurfaces,
  isKnownLegacyDocsSurfaces,
  LEGACY_DOCS_SURFACES_TEMPLATE,
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

// ------------------------------------------------------------------
// FG-546: docs-surfaces four-way classifier + legacy fingerprint
// ------------------------------------------------------------------

// The exact legacy generated template, as bytes the old seed emitted (comments
// and blank line included on purpose — detection must be comment/whitespace-insensitive).
const LEGACY_SEED_BYTES = `# forge — docs surfaces (EXAMPLE / opt-in)
#
# Copy this to <project>/.forge/docs-surfaces.yml ...

surfaces:
  - name: readme
    kind: user-facing
    path: README.md

  - name: api-reference
    kind: public-api
    path: docs/api.md
`;

test("classifyDocsSurfaces: absent file → missing", () => {
  const c = classifyDocsSurfaces(dir);
  assert.equal(c.verdict, "missing");
  assert.equal(c.detail, undefined);
});

test("classifyDocsSurfaces: valid string-list → valid-project (no detail)", () => {
  writeDocsSurfaces(dir, "surfaces:\n  - src/routes/\n  - public/\n");
  const c = classifyDocsSurfaces(dir);
  assert.equal(c.verdict, "valid-project");
  assert.equal(c.detail, undefined);
});

test("classifyDocsSurfaces: corrected generated form → valid-project (idempotent rerun)", () => {
  // A comment-rich, multi-line string list — what the corrected seed provisions.
  writeDocsSurfaces(
    dir,
    [
      "# forge — docs surfaces",
      "surfaces:",
      "  - src/cli/            # commands + flags",
      "  - seeds/workflows/    # workflow shapes",
      "  - src/v2/contract.ts  # the task-contract shape",
      "",
    ].join("\n")
  );
  assert.equal(classifyDocsSurfaces(dir).verdict, "valid-project");
});

test("classifyDocsSurfaces: exact legacy object template → known-legacy-generated", () => {
  writeDocsSurfaces(dir, LEGACY_SEED_BYTES);
  const c = classifyDocsSurfaces(dir);
  assert.equal(c.verdict, "known-legacy-generated");
  assert.equal(c.detail, undefined);
});

test("classifyDocsSurfaces: legacy template with edited comments/whitespace still recognized", () => {
  const reflowed = `surfaces:
  - {name: readme, kind: user-facing, path: README.md}   # inline flow form
  - name: api-reference
    path: docs/api.md
    kind: public-api
`; // reordered KEYS within an entry + flow style — structure is identical
  writeDocsSurfaces(dir, reflowed);
  assert.equal(classifyDocsSurfaces(dir).verdict, "known-legacy-generated");
});

test("classifyDocsSurfaces: structural deviations fall to customized-invalid, never migrate", () => {
  // Extra third entry.
  writeDocsSurfaces(
    dir,
    LEGACY_SEED_BYTES + "  - name: changelog\n    kind: user-facing\n    path: CHANGELOG.md\n"
  );
  assert.equal(classifyDocsSurfaces(dir).verdict, "customized-invalid");

  // Renamed key (title instead of name).
  writeDocsSurfaces(
    dir,
    "surfaces:\n  - title: readme\n    kind: user-facing\n    path: README.md\n  - name: api-reference\n    kind: public-api\n    path: docs/api.md\n"
  );
  assert.equal(classifyDocsSurfaces(dir).verdict, "customized-invalid");

  // Reordered ARRAY entries (order-sensitive).
  writeDocsSurfaces(
    dir,
    "surfaces:\n  - name: api-reference\n    kind: public-api\n    path: docs/api.md\n  - name: readme\n    kind: user-facing\n    path: README.md\n"
  );
  assert.equal(classifyDocsSurfaces(dir).verdict, "customized-invalid");

  // Extra key inside an entry.
  writeDocsSurfaces(
    dir,
    "surfaces:\n  - name: readme\n    kind: user-facing\n    path: README.md\n    owner: docs-team\n  - name: api-reference\n    kind: public-api\n    path: docs/api.md\n"
  );
  assert.equal(classifyDocsSurfaces(dir).verdict, "customized-invalid");

  // Changed value.
  writeDocsSurfaces(
    dir,
    "surfaces:\n  - name: readme\n    kind: user-facing\n    path: README.rst\n  - name: api-reference\n    kind: public-api\n    path: docs/api.md\n"
  );
  assert.equal(classifyDocsSurfaces(dir).verdict, "customized-invalid");

  // Only one entry.
  writeDocsSurfaces(dir, "surfaces:\n  - name: readme\n    kind: user-facing\n    path: README.md\n");
  assert.equal(classifyDocsSurfaces(dir).verdict, "customized-invalid");
});

test("classifyDocsSurfaces: hand-authored invalid → customized-invalid WITH validation detail", () => {
  writeDocsSurfaces(dir, "surfaces: not-a-list\n");
  const c = classifyDocsSurfaces(dir);
  assert.equal(c.verdict, "customized-invalid");
  assert.ok(c.detail && c.detail.length > 0, "must carry a schema validation-error detail");
  assert.match(c.detail!, /surfaces/);

  // Unknown key rejected by .strict().
  writeDocsSurfaces(dir, "wrong_key: [a]\n");
  const c2 = classifyDocsSurfaces(dir);
  assert.equal(c2.verdict, "customized-invalid");
  assert.ok(c2.detail && c2.detail.length > 0);
});

test("classifyDocsSurfaces: unparseable YAML → customized-invalid with parse detail", () => {
  writeDocsSurfaces(dir, "surfaces:\n  - [unterminated\n");
  const c = classifyDocsSurfaces(dir);
  assert.equal(c.verdict, "customized-invalid");
  assert.ok(c.detail && c.detail.length > 0);
});

test("isKnownLegacyDocsSurfaces / LEGACY_DOCS_SURFACES_TEMPLATE: frozen literal, strict match", () => {
  assert.ok(isKnownLegacyDocsSurfaces(LEGACY_DOCS_SURFACES_TEMPLATE));
  // A structural clone from independent literals still matches (structure, not identity).
  assert.ok(
    isKnownLegacyDocsSurfaces({
      surfaces: [
        { name: "readme", kind: "user-facing", path: "README.md" },
        { name: "api-reference", kind: "public-api", path: "docs/api.md" },
      ],
    })
  );
  // A valid string-list is NOT the legacy shape.
  assert.equal(isKnownLegacyDocsSurfaces({ surfaces: ["src/cli/"] }), false);
  assert.equal(isKnownLegacyDocsSurfaces(null), false);
  assert.equal(isKnownLegacyDocsSurfaces({}), false);
});
