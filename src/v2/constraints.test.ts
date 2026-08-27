import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConstraintFile,
  filterConstraints,
  loadEffectiveConstraints,
  projectConstraintsDir,
  type Constraint,
} from "./constraints.js";

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-constraints-test-"));
  mkdirSync(root, { recursive: true });
  return root;
}

function writeConstraint(dir: string, filename: string, content: string): Constraint {
  const path = join(dir, filename);
  writeFileSync(path, content);
  return parseConstraintFile(path);
}

// (a) untagged constraint is global — applies regardless of run tags (regression)
test("filterConstraints: untagged constraint applies when run has no tags", () => {
  const dir = setup();
  const c = writeConstraint(dir, "untagged.md", `---
id: untagged
level: suggest
roles: []
workflows: []
---
Body.`);
  assert.equal(c.tags.length, 0);
  const result = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build" });
  assert.deepEqual(result, [c]);
  rmSync(dir, { recursive: true, force: true });
});

test("filterConstraints: untagged constraint applies even when run carries tags", () => {
  const dir = setup();
  const c = writeConstraint(dir, "untagged.md", `---
id: untagged
level: suggest
roles: []
workflows: []
---
Body.`);
  const result = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build", runTags: ["ios"] });
  assert.deepEqual(result, [c]);
  rmSync(dir, { recursive: true, force: true });
});

// (b) tagged constraint applies when the run has a matching tag
test("filterConstraints: tagged constraint applies when run has a matching tag", () => {
  const dir = setup();
  const c = writeConstraint(dir, "tagged.md", `---
id: ios-only
level: suggest
roles: []
workflows: []
tags: [ios]
---
iOS-only guidance.`);
  assert.deepEqual(c.tags, ["ios"]);
  const result = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build", runTags: ["ios"] });
  assert.deepEqual(result, [c]);
  rmSync(dir, { recursive: true, force: true });
});

// (c) tagged constraint is suppressed when the run has no matching tag (or no tags at all)
test("filterConstraints: tagged constraint is suppressed when run has no tags", () => {
  const dir = setup();
  const c = writeConstraint(dir, "tagged.md", `---
id: ios-only
level: suggest
roles: []
workflows: []
tags: [ios]
---
iOS-only guidance.`);
  const result = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build" });
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

test("filterConstraints: tagged constraint is suppressed when run has non-matching tags", () => {
  const dir = setup();
  const c = writeConstraint(dir, "tagged.md", `---
id: ios-only
level: suggest
roles: []
workflows: []
tags: [ios]
---
iOS-only guidance.`);
  const result = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build", runTags: ["android"] });
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

// (d) multi-tag constraint matches on any overlapping tag
test("filterConstraints: multi-tag constraint matches on any overlapping tag", () => {
  const dir = setup();
  const c = writeConstraint(dir, "mobile.md", `---
id: mobile
level: suggest
roles: []
workflows: []
tags: [ios, android]
---
Mobile guidance.`);
  assert.deepEqual(c.tags, ["ios", "android"]);

  const matchIos = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build", runTags: ["ios"] });
  assert.deepEqual(matchIos, [c]);

  const matchAndroid = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build", runTags: ["android"] });
  assert.deepEqual(matchAndroid, [c]);

  const matchBoth = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build", runTags: ["ios", "android"] });
  assert.deepEqual(matchBoth, [c]);

  const noMatch = filterConstraints([c], { role: "engineer", workflow: "feature", phase: "build", runTags: ["web"] });
  assert.deepEqual(noMatch, []);

  rmSync(dir, { recursive: true, force: true });
});

test("parseConstraintFile: tags defaults to empty array when not in frontmatter", () => {
  const dir = setup();
  const c = writeConstraint(dir, "no-tags.md", `---
id: no-tags
level: force
roles: [engineer]
workflows: [feature]
antiPrompt: Don't do the bad thing.
---
Body.`);
  assert.deepEqual(c.tags, []);
  rmSync(dir, { recursive: true, force: true });
});

test("parseConstraintFile: tags is parsed from frontmatter array", () => {
  const dir = setup();
  const c = writeConstraint(dir, "with-tags.md", `---
id: with-tags
level: suggest
roles: []
workflows: []
tags: [alpha, beta]
---
Body.`);
  assert.deepEqual(c.tags, ["alpha", "beta"]);
  rmSync(dir, { recursive: true, force: true });
});

// ── FG-775 (FG-767 T2): loadEffectiveConstraints — HOST-UNION-PROJECT, host-wins ──

function writeRaw(dir: string, filename: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

function effectiveSetup(): { root: string; hostDir: string; projectDir: string; projConstraintsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "forge-effective-constraints-"));
  const hostDir = join(root, "host", "constraints");
  const projectDir = join(root, "project");
  mkdirSync(hostDir, { recursive: true });
  return { root, hostDir, projectDir, projConstraintsDir: projectConstraintsDir(projectDir) };
}

// no project layer → byte-identical to loading the host dir alone.
test("loadEffectiveConstraints: no project layer is identical to host-only", () => {
  const { root, hostDir, projectDir } = effectiveSetup();
  writeRaw(hostDir, "h.md", `---
id: host-one
level: force
roles: []
workflows: []
antiPrompt: host says no
---
Host body.`);

  const noProjectArg = loadEffectiveConstraints({ hostDir });
  const missingProjectDir = loadEffectiveConstraints({ hostDir, projectDir });
  assert.equal(noProjectArg.length, 1);
  assert.deepEqual(noProjectArg, missingProjectDir, "absent projectDir and a project with no .forge/constraints both yield host-only");
  assert.equal(noProjectArg[0]!.id, "host-one");
  rmSync(root, { recursive: true, force: true });
});

// Invariant 1: HOST-WINS on id collision — a project constraint sharing a host id
// cannot change the host constraint's content or level.
test("loadEffectiveConstraints: host wins on id collision (project cannot override/weaken)", () => {
  const { root, hostDir, projectDir, projConstraintsDir } = effectiveSetup();
  writeRaw(hostDir, "shared.md", `---
id: shared-id
level: force
roles: []
workflows: []
antiPrompt: HOST anti-prompt
---
HOST body.`);
  // project tries to redefine the same id as a weaker (suggest) constraint.
  writeRaw(projConstraintsDir, "shared.md", `---
id: shared-id
level: suggest
roles: []
workflows: []
antiPrompt: PROJECT anti-prompt
---
PROJECT body.`);

  const effective = loadEffectiveConstraints({ hostDir, projectDir });
  const shared = effective.filter((c) => c.id === "shared-id");
  assert.equal(shared.length, 1, "collision resolves to exactly one constraint — never both, never last-writer");
  assert.equal(shared[0]!.level, "force", "host level preserved — project cannot weaken force → suggest");
  assert.equal(shared[0]!.body, "HOST body.", "host content preserved");
  assert.equal(shared[0]!.antiPrompt, "HOST anti-prompt", "host anti-prompt preserved");
  rmSync(root, { recursive: true, force: true });
});

// Invariant 3: every HOST force constraint always fires regardless of project constraints;
// and a NON-colliding project constraint is added (additive-only).
test("loadEffectiveConstraints: host force always present + non-colliding project constraint added", () => {
  const { root, hostDir, projectDir, projConstraintsDir } = effectiveSetup();
  writeRaw(hostDir, "hforce.md", `---
id: host-force
level: force
roles: []
workflows: []
antiPrompt: host force
---
Host force body.`);
  writeRaw(projConstraintsDir, "pforce.md", `---
id: project-force
level: force
roles: []
workflows: []
antiPrompt: project force
---
Project force body.`);

  const effective = loadEffectiveConstraints({ hostDir, projectDir });
  const ids = effective.map((c) => c.id).sort();
  assert.deepEqual(ids, ["host-force", "project-force"], "host force always in the union; project force added");
  assert.ok(effective.find((c) => c.id === "host-force")!.level === "force");
  assert.ok(effective.find((c) => c.id === "project-force")!.level === "force");
  rmSync(root, { recursive: true, force: true });
});

// Invariant 4: a malformed project constraint file fails LOUD — surfaced, not silently skipped.
test("loadEffectiveConstraints: malformed project constraint throws (loud/safe, no silent skip)", () => {
  const { root, hostDir, projectDir, projConstraintsDir } = effectiveSetup();
  writeRaw(hostDir, "ok.md", `---
id: host-ok
level: force
roles: []
workflows: []
---
Host body.`);
  // missing `id` / `level` — parseConstraintFile must throw.
  writeRaw(projConstraintsDir, "bad.md", `---
roles: []
---
No id, no level.`);

  assert.throws(
    () => loadEffectiveConstraints({ hostDir, projectDir }),
    /missing required frontmatter/,
    "a malformed project constraint is surfaced as an error, never silently dropped",
  );
  rmSync(root, { recursive: true, force: true });
});

// A malformed HOST constraint is equally loud (symmetry — neither layer is silently skipped).
test("loadEffectiveConstraints: malformed host constraint throws (loud/safe)", () => {
  const { root, hostDir, projectDir } = effectiveSetup();
  writeRaw(hostDir, "bad.md", `---
level: suggest
---
No id.`);
  assert.throws(
    () => loadEffectiveConstraints({ hostDir, projectDir }),
    /missing required frontmatter/,
  );
  rmSync(root, { recursive: true, force: true });
});
