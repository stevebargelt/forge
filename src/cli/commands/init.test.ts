import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOrchestratorBlock, planCommitMsgHook } from "./init.js";

const TEMPLATE = `<!-- forge:orchestrator-start -->
# forge orchestrator
You are the orchestrator.
<!-- forge:orchestrator-end -->`;

const TEMPLATE_V2 = `<!-- forge:orchestrator-start -->
# forge orchestrator (v2)
Different body.
<!-- forge:orchestrator-end -->`;

test("applyOrchestratorBlock: appends to empty CLAUDE.md", () => {
  const out = applyOrchestratorBlock("", TEMPLATE);
  assert.equal(out, TEMPLATE + "\n");
});

test("applyOrchestratorBlock: appends with separator when CLAUDE.md has content", () => {
  const existing = "# my project\n\nSome notes.\n";
  const out = applyOrchestratorBlock(existing, TEMPLATE);
  assert.ok(out.startsWith("# my project"));
  assert.ok(out.includes("Some notes."));
  assert.ok(out.includes("<!-- forge:orchestrator-start -->"));
  assert.ok(out.includes("<!-- forge:orchestrator-end -->"));
});

test("applyOrchestratorBlock: replaces existing block in place", () => {
  const before = `# my project\n\nSome notes.\n\n${TEMPLATE}\n\n## After section\n\nMore content.\n`;
  const out = applyOrchestratorBlock(before, TEMPLATE_V2);
  assert.ok(out.includes("# my project"));
  assert.ok(out.includes("Some notes."));
  assert.ok(out.includes("# forge orchestrator (v2)"));
  assert.ok(!out.includes("# forge orchestrator\n"));  // old block gone
  assert.ok(out.includes("## After section"));
  assert.ok(out.includes("More content."));
});

test("applyOrchestratorBlock: idempotent — replacing block with same content yields same text", () => {
  const once = applyOrchestratorBlock("# project\n\nbody.\n", TEMPLATE);
  const twice = applyOrchestratorBlock(once, TEMPLATE);
  assert.equal(once, twice);
});

test("applyOrchestratorBlock: unbalanced markers throws (only start marker)", () => {
  const corrupt = "<!-- forge:orchestrator-start -->\nbody";
  assert.throws(
    () => applyOrchestratorBlock(corrupt, TEMPLATE),
    /unbalanced/i
  );
});

test("applyOrchestratorBlock: unbalanced markers throws (only end marker)", () => {
  const corrupt = "body\n<!-- forge:orchestrator-end -->\n";
  assert.throws(
    () => applyOrchestratorBlock(corrupt, TEMPLATE),
    /unbalanced/i
  );
});

test("applyOrchestratorBlock: preserves content before AND after the block on update", () => {
  const before = [
    "# project",
    "",
    "## Setup",
    "Some setup notes.",
    "",
    TEMPLATE,
    "",
    "## Conventions",
    "Use ts not js.",
    "",
  ].join("\n");

  const out = applyOrchestratorBlock(before, TEMPLATE_V2);
  assert.ok(out.includes("# project"));
  assert.ok(out.includes("## Setup"));
  assert.ok(out.includes("Some setup notes."));
  assert.ok(out.includes("## Conventions"));
  assert.ok(out.includes("Use ts not js."));
  assert.ok(out.includes("# forge orchestrator (v2)"));
});

// ----- planCommitMsgHook (#147 follow-up: ban-AI-attribution hook) -----

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-init-hook-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("planCommitMsgHook: returns not-a-git-repo when .git/hooks is missing", () => {
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "not-a-git-repo");
});

test("planCommitMsgHook: returns install when .git/hooks exists and no commit-msg present", () => {
  execSync("git init -q", { cwd: projectDir });
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.match(plan.target, /\.git\/hooks\/commit-msg$/);
    assert.match(plan.source, /commit-msg-no-ai-attribution$/);
  }
});

test("planCommitMsgHook: returns already-linked when a symlink already points at our source", () => {
  execSync("git init -q", { cwd: projectDir });
  // Replicate the install: symlink to the bundled source script.
  // Use the same resolution path the prod helper would.
  const prodPlan = planCommitMsgHook(projectDir);
  assert.equal(prodPlan.action, "install");
  if (prodPlan.action !== "install") throw new Error("setup failed");
  symlinkSync(prodPlan.source, prodPlan.target);

  const replan = planCommitMsgHook(projectDir);
  assert.equal(replan.action, "already-linked");
});

test("planCommitMsgHook: returns exists-other when a non-symlink hook is already in place", () => {
  execSync("git init -q", { cwd: projectDir });
  const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
  writeFileSync(hookPath, "#!/bin/sh\necho 'some other hook'\n");
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action === "exists-other") {
    assert.match(plan.details, /regular file/);
  }
});

test("planCommitMsgHook: returns exists-other when a symlink points somewhere else", () => {
  execSync("git init -q", { cwd: projectDir });
  // Make a decoy target inside the same tmpdir.
  const decoy = join(projectDir, "decoy-hook");
  writeFileSync(decoy, "#!/bin/sh\nexit 0\n");
  const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
  symlinkSync(decoy, hookPath);
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action === "exists-other") {
    assert.match(plan.details, /symlink/);
  }
});
