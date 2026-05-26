import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findForgeProjects } from "./find-forge-projects.js";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "forge-find-test-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function mkProject(at: string, withMarker = true): void {
  mkdirSync(at, { recursive: true });
  const body = withMarker
    ? `# my project\n\n<!-- forge:orchestrator-start -->\nstub\n<!-- forge:orchestrator-end -->\n`
    : `# my project\n\nno marker here\n`;
  writeFileSync(join(at, "CLAUDE.md"), body);
}

test("findForgeProjects: returns nothing when no forge-marked CLAUDE.md anywhere", () => {
  mkdirSync(join(root, "some/sub"), { recursive: true });
  writeFileSync(join(root, "some/sub/CLAUDE.md"), "no marker");
  const out = findForgeProjects({ rootDirs: [root] });
  assert.equal(out.length, 0);
});

test("findForgeProjects: finds a project at depth 1 (under the root)", () => {
  mkProject(join(root, "alpha"));
  const out = findForgeProjects({ rootDirs: [root] });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.projectDir, join(root, "alpha"));
});

test("findForgeProjects: finds the root itself if it's a forge project", () => {
  mkProject(root);
  const out = findForgeProjects({ rootDirs: [root] });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.projectDir, root);
});

test("findForgeProjects: finds multiple sibling projects", () => {
  mkProject(join(root, "alpha"));
  mkProject(join(root, "beta"));
  mkProject(join(root, "gamma"));
  const out = findForgeProjects({ rootDirs: [root] });
  assert.equal(out.length, 3);
  const dirs = out.map((p) => p.projectDir).sort();
  assert.deepEqual(dirs, [join(root, "alpha"), join(root, "beta"), join(root, "gamma")]);
});

test("findForgeProjects: does NOT descend into a known forge project (no nested-projects)", () => {
  // forge project at depth 1, with a CLAUDE.md inside a subdir — that
  // subdir should NOT be reported because the outer project blocks descent.
  mkProject(join(root, "parent"));
  mkProject(join(root, "parent/nested"));
  const out = findForgeProjects({ rootDirs: [root] });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.projectDir, join(root, "parent"));
});

test("findForgeProjects: skips heavy dirs (node_modules, .git, dist, etc.)", () => {
  mkProject(join(root, "node_modules/some-pkg"));
  mkProject(join(root, ".git/hooks"));
  mkProject(join(root, "dist"));
  // None of these should be found.
  const out = findForgeProjects({ rootDirs: [root] });
  assert.equal(out.length, 0);
});

test("findForgeProjects: respects maxDepth", () => {
  // Depth 1: root/a
  // Depth 2: root/a/b
  // Depth 3: root/a/b/c  <- project here, should be found
  // Depth 4: root/a/b/c/d <- project here, beyond default maxDepth=3
  mkProject(join(root, "a/b/c"));
  mkProject(join(root, "a/b/c/d"));
  const out = findForgeProjects({ rootDirs: [root] });
  // 'a/b/c' is found at depth 3; 'a/b/c/d' isn't found because once a/b/c
  // is found we stop descending into it (nested-project rule).
  assert.equal(out.length, 1);
  assert.equal(out[0]?.projectDir, join(root, "a/b/c"));
});

test("findForgeProjects: dedupes across multiple root dirs that overlap", () => {
  mkProject(join(root, "shared"));
  const out = findForgeProjects({ rootDirs: [root, root] });
  assert.equal(out.length, 1);
});

test("findForgeProjects: silently skips non-existent root", () => {
  mkProject(join(root, "alpha"));
  const out = findForgeProjects({ rootDirs: [root, "/nonexistent/path"] });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.projectDir, join(root, "alpha"));
});

test("findForgeProjects: CLAUDE.md without the orchestrator marker is NOT a forge project", () => {
  mkProject(join(root, "no-marker"), false);  // CLAUDE.md exists but no marker
  const out = findForgeProjects({ rootDirs: [root] });
  assert.equal(out.length, 0);
});
