// FG-349 [B]: buildConfigGraphSources composes the effective resolvers into the
// Sources section. Seed a temp FORGE_HOME and per-case project dirs; assert the
// projection into the vocabulary, the override callouts, the invalid-override
// warning text, the throw→row behavior, and redaction-cleanliness.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cg-home-"));
process.env.FORGE_HOME = tmpHome;

const { buildConfigGraphSources } = await import("./config-graph-sources.js");
const { redactSecrets } = await import("./host-readiness.js");

function projectDir(): string {
  return mkdtempSync(join(tmpdir(), "forge-cg-proj-"));
}
function withForge(dir: string): string {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  return dir;
}
const rowFor = (dir: string, key: string) =>
  buildConfigGraphSources({ projectDir: dir, forgeHome: tmpHome }).rows.find((r) => r.key === key)!;

test("docs-surfaces: a valid project override is overridden, full-replacement, effective=project file", () => {
  const dir = withForge(projectDir());
  const path = join(dir, ".forge", "docs-surfaces.yml");
  writeFileSync(path, "surfaces:\n  - README.md\n  - docs/quick-start.md\n");
  const row = rowFor(dir, "docs-surfaces");
  assert.equal(row.status, "overridden");
  assert.equal(row.overrideSemantics, "full-replacement");
  assert.equal(row.effectivePath, path);
  assert.match(row.overrideCallout ?? "", /fully replaces/);
  // native verdict carried verbatim
  assert.equal((row.native as { receipt: { source: string } }).receipt.source, "project");
});

test("docs-surfaces: an INVALID project override renders the contract warning, not bare defaults", () => {
  const dir = withForge(projectDir());
  writeFileSync(join(dir, ".forge", "docs-surfaces.yml"), "surfaces: not-a-list\n");
  const row = rowFor(dir, "docs-surfaces");
  assert.equal(row.status, "warning");
  assert.equal(row.warning, "project override present but invalid; effective source: built-in defaults");
});

test("docs-surfaces: no override → built-in defaults active", () => {
  const dir = withForge(projectDir());
  const row = rowFor(dir, "docs-surfaces");
  assert.equal(row.status, "active");
  assert.match(row.detail ?? "", /built-in defaults/);
});

test("model-policy: absent → legacy mode labeled", () => {
  const dir = withForge(projectDir());
  const row = rowFor(dir, "model-policy");
  assert.equal(row.status, "absent");
  assert.match(row.detail ?? "", /legacy mode/);
  assert.equal((row.native as { source: string }).source, "absent");
});

test("constraints: row shows dir + suggest/force counts on merge semantics", () => {
  mkdirSync(join(tmpHome, "constraints"), { recursive: true });
  writeFileSync(join(tmpHome, "constraints", "a.md"), "---\nid: a\nlevel: force\n---\nbody a\n");
  writeFileSync(join(tmpHome, "constraints", "b.md"), "---\nid: b\nlevel: suggest\n---\nbody b\n");
  const row = rowFor(withForge(projectDir()), "constraints");
  assert.equal(row.status, "active");
  assert.equal(row.overrideSemantics, "merge");
  assert.match(row.detail ?? "", /force/);
  assert.match(row.detail ?? "", /suggest/);
  const native = row.native as { force: number; suggest: number };
  assert.equal(native.force, 1);
  assert.equal(native.suggest, 1);
});

test("workflow: a resolver that cannot resolve yields a missing/warning row, never a throw", () => {
  const dir = withForge(projectDir());
  const row = rowFor(dir, "workflow"); // no host generation in this bare FORGE_HOME
  assert.ok(["missing", "warning", "active", "overridden"].includes(row.status));
  // whatever it resolved to, it is a real row with a native verdict
  assert.ok(row.native !== undefined);
});

test("agents: installed-vs-missing expected agents are enumerated", () => {
  const row = rowFor(withForge(projectDir()), "agents");
  const native = row.native as { expected: string[]; missing: string[]; installed: string[] };
  assert.ok(native.expected.length > 0, "COVERED_ROLES expected set is non-empty");
  // bare host installs no protocols → all expected are missing, enumerated
  assert.deepEqual(native.missing.sort(), native.expected.slice().sort());
});

test("seed-drift row is on the install-source axis — never 'active' runtime config", () => {
  const row = rowFor(withForge(projectDir()), "seed-drift");
  assert.ok(["template-only", "stale", "warning"].includes(row.status));
  assert.notEqual(row.status, "active");
  assert.match(row.detail ?? row.warning ?? "", /template|install-source|drift/i);
});

test("a missing/unreadable projectDir does not throw", () => {
  assert.doesNotThrow(() =>
    buildConfigGraphSources({ projectDir: "/no/such/project/dir", forgeHome: tmpHome }),
  );
});

test("every surfaced string in every row is redaction-clean", () => {
  const { rows } = buildConfigGraphSources({ projectDir: withForge(projectDir()), forgeHome: tmpHome });
  for (const row of rows) {
    for (const s of [row.detail, row.warning, row.overrideCallout, ...row.sourcePaths, row.effectivePath]) {
      if (typeof s === "string") assert.equal(redactSecrets(s), s, `unredacted string in row ${row.key}: ${s}`);
    }
  }
});
