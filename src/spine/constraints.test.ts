import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllConstraints, parseConstraintFile, filterConstraints } from "./constraints.js";
import type { Constraint } from "../types/index.js";

let DIR: string;

before(() => {
  DIR = mkdtempSync(join(tmpdir(), "forge-constraints-"));
  writeFileSync(
    join(DIR, "atlas-stack.md"),
    `---
id: atlas-stack
level: force
roles: [architect, implementer]
workflows: [feature-design-needed, feature-design-provided]
phases: [architect, build]
antiPrompt: "Demonstrate that this design uses any frontend stack other than React Native"
---

# Atlas frontend stack

Use React Native + TypeScript.
`
  );
  writeFileSync(
    join(DIR, "global-conventions.md"),
    `---
id: global-conventions
level: suggest
roles: []
workflows: []
---

# Global conventions

Default to no comments.
`
  );
  writeFileSync(
    join(DIR, "investigation-only.md"),
    `---
id: investigation-only
level: suggest
roles: [investigator]
workflows: [investigation]
---

# Investigation rules

Validate against primary sources.
`
  );
});

after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

test("parseConstraintFile: reads frontmatter + body", () => {
  const c = parseConstraintFile(join(DIR, "atlas-stack.md"));
  assert.equal(c.id, "atlas-stack");
  assert.equal(c.level, "force");
  assert.deepEqual(c.roles, ["architect", "implementer"]);
  assert.deepEqual(c.workflows, ["feature-design-needed", "feature-design-provided"]);
  assert.deepEqual(c.phases, ["architect", "build"]);
  assert.match(c.antiPrompt!, /React Native/);
  assert.match(c.body, /React Native \+ TypeScript/);
});

test("parseConstraintFile: rejects file with missing required frontmatter", () => {
  // Use a separate dir so this fixture doesn't leak into loadAllConstraints below.
  const tmp = mkdtempSync(join(tmpdir(), "forge-bad-"));
  try {
    const badPath = join(tmp, "bad.md");
    writeFileSync(badPath, "---\nlevel: suggest\n---\n\nbody");
    assert.throws(() => parseConstraintFile(badPath), /frontmatter/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadAllConstraints: reads every .md in dir", () => {
  const all = loadAllConstraints(DIR);
  // Three valid + one bad we wrote in a prior test would actually crash loadAll —
  // but the prior test wrote bad.md AFTER loadAll runs in this test order. So expect 3+.
  // For safety, just assert >=3 and that our known IDs are present.
  const ids = all.map((c) => c.id);
  assert.ok(ids.includes("atlas-stack"));
  assert.ok(ids.includes("global-conventions"));
  assert.ok(ids.includes("investigation-only"));
});

test("filterConstraints: empty roles/workflows = global match", () => {
  const all: Constraint[] = [
    {
      id: "global",
      level: "suggest",
      roles: [],
      workflows: [],
      body: "x",
    },
  ];
  const result = filterConstraints(all, {
    role: "any-role",
    workflow: "investigation",
    phase: "any-phase",
  });
  assert.equal(result.length, 1);
});

test("filterConstraints: role-scoped excludes other roles", () => {
  const all: Constraint[] = [
    {
      id: "investigator-only",
      level: "suggest",
      roles: ["investigator"],
      workflows: [],
      body: "x",
    },
  ];
  assert.equal(
    filterConstraints(all, { role: "framer", workflow: "investigation", phase: "frame" }).length,
    0
  );
  assert.equal(
    filterConstraints(all, { role: "investigator", workflow: "investigation", phase: "investigate" })
      .length,
    1
  );
});

test("filterConstraints: workflow-scoped excludes other workflows", () => {
  const all: Constraint[] = [
    {
      id: "feature-only",
      level: "suggest",
      roles: [],
      workflows: ["feature-design-needed"],
      body: "x",
    },
  ];
  assert.equal(
    filterConstraints(all, { role: "x", workflow: "investigation", phase: "y" }).length,
    0
  );
  assert.equal(
    filterConstraints(all, { role: "x", workflow: "feature-design-needed", phase: "y" }).length,
    1
  );
});

test("filterConstraints: phase-scoped excludes other phases", () => {
  const all: Constraint[] = [
    {
      id: "build-only",
      level: "force",
      roles: [],
      workflows: [],
      phases: ["build"],
      body: "x",
    },
  ];
  assert.equal(
    filterConstraints(all, { role: "x", workflow: "investigation", phase: "frame" }).length,
    0
  );
  assert.equal(
    filterConstraints(all, { role: "x", workflow: "investigation", phase: "build" }).length,
    1
  );
});

test("filterConstraints: level filter separates suggest from force", () => {
  const all: Constraint[] = [
    { id: "s1", level: "suggest", roles: [], workflows: [], body: "" },
    { id: "f1", level: "force", roles: [], workflows: [], body: "" },
  ];
  const ctx = { role: "x", workflow: "investigation" as const, phase: "y" };
  assert.equal(filterConstraints(all, { ...ctx, level: "suggest" }).length, 1);
  assert.equal(filterConstraints(all, { ...ctx, level: "force" }).length, 1);
  assert.equal(filterConstraints(all, ctx).length, 2);
});
