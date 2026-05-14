// Validation + argv-building for the new-run modal.
// v2: only the three feature* workflows are pipelines; investigate/audit/design
// are orchestrator-driven via `forge invoke` and don't appear in the modal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNewRunBody, buildForgeNewArgv, WORKFLOW_SPECS, WORKFLOW_ORDER, UNIVERSAL_FIELDS } from "./workflowSchema.js";

test("validateNewRunBody: unknown workflow → workflow error", () => {
  const r = validateNewRunBody("not-a-workflow", { title: "x", project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.field, "workflow");
  }
});

test("validateNewRunBody: feature with universals + brief → ok", () => {
  const r = validateNewRunBody("feature", {
    title: "version-flag",
    project: "/code/forge",
    brief: "Add a --version flag",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.values.title, "version-flag");
    assert.equal(r.values.project, "/code/forge");
    assert.equal(r.values.brief, "Add a --version flag");
  }
});

test("validateNewRunBody: missing title → required error", () => {
  const r = validateNewRunBody("feature", { project: "/x", brief: "x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "title"));
  }
});

test("validateNewRunBody: missing project → required error", () => {
  const r = validateNewRunBody("feature", { title: "x", brief: "x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "project"));
  }
});

test("validateNewRunBody: feature requires --brief", () => {
  const r = validateNewRunBody("feature", { title: "x", project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "brief"));
  }
});

test("validateNewRunBody: feature-ui-design-needed requires brief + designDir + the universals", () => {
  const r = validateNewRunBody("feature-ui-design-needed", { title: "widget", project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "brief"));
    assert.ok(r.errors.find((e) => e.field === "designDir"));
  }
});

test("validateNewRunBody: feature-ui-design-needed with all required fields → ok", () => {
  const r = validateNewRunBody("feature-ui-design-needed", {
    title: "widget",
    project: "/code/forge",
    brief: "a thing",
    designDir: "/code/widget-design",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.values.title, "widget");
    assert.equal(r.values.brief, "a thing");
    assert.equal(r.values.designDir, "/code/widget-design");
  }
});

test("validateNewRunBody: feature-ui-design-provided requires --prd", () => {
  const r = validateNewRunBody("feature-ui-design-provided", { title: "f", project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "prd"));
  }
});

test("validateNewRunBody: relative path on a path field → error", () => {
  const r = validateNewRunBody("feature", { title: "x", project: "code/x", brief: "x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    const err = r.errors.find((e) => e.field === "project")!;
    assert.match(err.message, /absolute path/);
  }
});

test("validateNewRunBody: tilde-prefixed path is accepted (loose mode)", () => {
  const r = validateNewRunBody("feature", { title: "x", project: "~/code/x", brief: "x" });
  assert.equal(r.ok, true);
});

test("validateNewRunBody: shell-meta in path → rejected", () => {
  const r = validateNewRunBody("feature", { title: "x", project: "/x; rm -rf /", brief: "x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    const err = r.errors.find((e) => e.field === "project")!;
    assert.match(err.message, /not allowed in paths/);
  }
});

test("validateNewRunBody: whitespace-only required field → required error", () => {
  const r = validateNewRunBody("feature", { title: "   ", project: "/x", brief: "x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "title"));
  }
});

test("validateNewRunBody: trims whitespace on accepted values", () => {
  const r = validateNewRunBody("feature", { title: "  audit  ", project: "  /x  ", brief: "  x  " });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.values.title, "audit");
    assert.equal(r.values.project, "/x");
    assert.equal(r.values.brief, "x");
  }
});

test("buildForgeNewArgv: feature-ui-design-needed produces full argv in expected order", () => {
  const argv = buildForgeNewArgv("feature-ui-design-needed", {
    title: "widget",
    project: "/code/forge",
    brief: "a thing",
    designDir: "/code/widget-design",
  });
  assert.deepEqual(argv, [
    "new",
    "feature-ui-design-needed",
    "widget",
    "--project", "/code/forge",
    "--brief", "a thing",
    "--design-dir", "/code/widget-design",
  ]);
});

test("buildForgeNewArgv: feature produces minimal argv (brief required)", () => {
  const argv = buildForgeNewArgv("feature", { title: "x", project: "/code/x", brief: "do thing" });
  assert.deepEqual(argv, [
    "new", "feature", "x",
    "--project", "/code/x",
    "--brief", "do thing",
  ]);
});

test("buildForgeNewArgv: feature-ui-design-provided includes --prd", () => {
  const argv = buildForgeNewArgv("feature-ui-design-provided", {
    title: "f",
    project: "/x",
    prd: "/x/docs/feature.md",
  });
  assert.deepEqual(argv, [
    "new",
    "feature-ui-design-provided",
    "f",
    "--project", "/x",
    "--prd", "/x/docs/feature.md",
  ]);
});

test("WORKFLOW_ORDER covers every workflow in WORKFLOW_SPECS", () => {
  const specKeys = Object.keys(WORKFLOW_SPECS).sort();
  const orderKeys = WORKFLOW_ORDER.slice().sort();
  assert.deepEqual(orderKeys, specKeys);
});

test("UNIVERSAL_FIELDS contains title and project, both required", () => {
  const names = UNIVERSAL_FIELDS.map((f) => f.name);
  assert.ok(names.includes("title"));
  assert.ok(names.includes("project"));
  for (const f of UNIVERSAL_FIELDS) assert.equal(f.required, true);
});
