// Validation + argv-building for the new-run modal (#66).

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

test("validateNewRunBody: codebase-assessment with universals only → ok", () => {
  const r = validateNewRunBody("codebase-assessment", { title: "audit", project: "/code/x" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.values.title, "audit");
    assert.equal(r.values.project, "/code/x");
  }
});

test("validateNewRunBody: missing title → required error", () => {
  const r = validateNewRunBody("codebase-assessment", { project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "title"));
  }
});

test("validateNewRunBody: missing project → required error", () => {
  const r = validateNewRunBody("codebase-assessment", { title: "x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "project"));
  }
});

test("validateNewRunBody: ui-design requires brief + designDir + the universals", () => {
  const r = validateNewRunBody("ui-design", { title: "widget", project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "brief"));
    assert.ok(r.errors.find((e) => e.field === "designDir"));
  }
});

test("validateNewRunBody: ui-design with all required fields → ok", () => {
  const r = validateNewRunBody("ui-design", {
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

test("validateNewRunBody: investigation requires --question", () => {
  const r = validateNewRunBody("investigation", { title: "q", project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "question"));
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
  const r = validateNewRunBody("codebase-assessment", { title: "x", project: "code/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    const err = r.errors.find((e) => e.field === "project")!;
    assert.match(err.message, /absolute path/);
  }
});

test("validateNewRunBody: tilde-prefixed path is accepted (loose mode)", () => {
  const r = validateNewRunBody("codebase-assessment", { title: "x", project: "~/code/x" });
  assert.equal(r.ok, true);
});

test("validateNewRunBody: shell-meta in path → rejected", () => {
  const r = validateNewRunBody("codebase-assessment", { title: "x", project: "/x; rm -rf /" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    const err = r.errors.find((e) => e.field === "project")!;
    assert.match(err.message, /not allowed in paths/);
  }
});

test("validateNewRunBody: whitespace-only required field → required error", () => {
  const r = validateNewRunBody("codebase-assessment", { title: "   ", project: "/x" });
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.errors.find((e) => e.field === "title"));
  }
});

test("validateNewRunBody: trims whitespace on accepted values", () => {
  const r = validateNewRunBody("codebase-assessment", { title: "  audit  ", project: "  /x  " });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.values.title, "audit");
    assert.equal(r.values.project, "/x");
  }
});

test("buildForgeNewArgv: ui-design produces full argv in expected order", () => {
  const argv = buildForgeNewArgv("ui-design", {
    title: "widget",
    project: "/code/forge",
    brief: "a thing",
    designDir: "/code/widget-design",
  });
  assert.deepEqual(argv, [
    "new",
    "ui-design",
    "widget",
    "--project", "/code/forge",
    "--brief", "a thing",
    "--design-dir", "/code/widget-design",
  ]);
});

test("buildForgeNewArgv: codebase-assessment produces minimal argv", () => {
  const argv = buildForgeNewArgv("codebase-assessment", { title: "audit", project: "/code/x" });
  assert.deepEqual(argv, ["new", "codebase-assessment", "audit", "--project", "/code/x"]);
});

test("buildForgeNewArgv: investigation includes --question", () => {
  const argv = buildForgeNewArgv("investigation", {
    title: "q",
    project: "/x",
    question: "why is the build slow?",
  });
  assert.deepEqual(argv, [
    "new",
    "investigation",
    "q",
    "--project", "/x",
    "--question", "why is the build slow?",
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
