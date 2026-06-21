import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConstraintFile, filterConstraints, type Constraint } from "./constraints.js";

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
