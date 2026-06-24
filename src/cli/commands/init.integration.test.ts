/**
 * Integration tests for FG-332: forge init scaffold additions.
 *
 * Exercises the full CLI pipeline end-to-end:
 *   forge init --prefix MYPREFIX  →  forge backlog file "ticket"  →  MYPREFIX-NNN
 *
 * Also verifies idempotency: a second `forge init` run must not clobber
 * backlog/notes.md or .forge/model-policy.yml written by the first run.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planCommitMsgHook } from "./init.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;

function runForge(args: string[], cwd?: string) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: cwd ?? projectDir,
    encoding: "utf8",
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-init-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── FG-332: --prefix → forge backlog file uses the configured prefix ─────────

test("integ FG-332: forge init --prefix MYPREFIX → forge backlog file creates MYPREFIX-NNN ticket", () => {
  // 1. Run forge init with the prefix flag.
  const initResult = runForge(["init", "--project", projectDir, "--no-install-hooks", "--prefix", "MYPREFIX"]);
  assert.equal(initResult.status, 0, `forge init failed: ${initResult.stderr}`);

  // 2. Verify .forge/config.yml was written with the prefix.
  const configPath = join(projectDir, ".forge", "config.yml");
  assert.ok(existsSync(configPath), ".forge/config.yml should exist after init");
  const configContent = readFileSync(configPath, "utf8");
  assert.match(configContent, /MYPREFIX/, "config.yml should contain the prefix MYPREFIX");

  // 3. Verify the backlog scaffold was created.
  assert.ok(existsSync(join(projectDir, "backlog", "stories")), "backlog/stories/ should exist");
  assert.ok(existsSync(join(projectDir, "backlog", "notes.md")), "backlog/notes.md should exist");

  // 4. Run forge backlog file from within the project dir.
  const fileResult = runForge(["backlog", "file", "test ticket"], projectDir);
  assert.equal(fileResult.status, 0, `forge backlog file failed: ${fileResult.stderr}`);

  // 5. The created ticket file should use the MYPREFIX prefix.
  const storiesDir = join(projectDir, "backlog", "stories");
  const ticketFiles = existsSync(storiesDir) ? readdirSync(storiesDir) : [];
  const ticket = ticketFiles.find((f) => f.startsWith("MYPREFIX-"));
  assert.ok(ticket !== undefined, `Expected a ticket file starting with 'MYPREFIX-' in backlog/stories/, found: ${ticketFiles.join(", ")}`);
  assert.match(ticket, /^MYPREFIX-\d+/, "ticket filename should match MYPREFIX-NNN format");
});

// ─── FG-332: forge init idempotency — second run must not clobber existing files ─

test("integ FG-332: running forge init twice does not clobber backlog/notes.md", () => {
  // First run: scaffold everything.
  const first = runForge(["init", "--project", projectDir, "--no-install-hooks", "--prefix", "FG"]);
  assert.equal(first.status, 0, `first forge init failed: ${first.stderr}`);

  // Write real content into notes.md so a clobber would be detectable.
  const notesPath = join(projectDir, "backlog", "notes.md");
  assert.ok(existsSync(notesPath), "backlog/notes.md should exist after first init");
  const customNotes = "# My session notes\n\nDo not clobber me.\n";
  writeFileSync(notesPath, customNotes);

  // Second run: should be idempotent.
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);

  // notes.md must not have been overwritten.
  const notesAfter = readFileSync(notesPath, "utf8");
  assert.equal(notesAfter, customNotes, "backlog/notes.md must not be clobbered by second forge init");
});

test("integ FG-332: running forge init twice does not clobber .forge/model-policy.yml", () => {
  // First run.
  const first = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(first.status, 0, `first forge init failed: ${first.stderr}`);

  const modelPolicyPath = join(projectDir, ".forge", "model-policy.yml");
  assert.ok(existsSync(modelPolicyPath), ".forge/model-policy.yml should exist after first init");

  // Simulate operator customization.
  const customPolicy = "# custom operator policy\nmodel_profiles: []\n";
  writeFileSync(modelPolicyPath, customPolicy);

  // Second run.
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);

  // model-policy.yml must not have been overwritten.
  const policyAfter = readFileSync(modelPolicyPath, "utf8");
  assert.equal(policyAfter, customPolicy, ".forge/model-policy.yml must not be clobbered by second forge init");
});

test("integ FG-332: running forge init twice does not clobber .forge/docs-surfaces.yml", () => {
  // First run.
  const first = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(first.status, 0, `first forge init failed: ${first.stderr}`);

  const docsSurfacesPath = join(projectDir, ".forge", "docs-surfaces.yml");
  assert.ok(existsSync(docsSurfacesPath), ".forge/docs-surfaces.yml should exist after first init");

  // Simulate operator customization.
  const customSurfaces = "# custom docs surfaces\nsurfaces: []\n";
  writeFileSync(docsSurfacesPath, customSurfaces);

  // Second run.
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);

  // docs-surfaces.yml must not have been overwritten.
  const surfacesAfter = readFileSync(docsSurfacesPath, "utf8");
  assert.equal(surfacesAfter, customSurfaces, ".forge/docs-surfaces.yml must not be clobbered by second forge init");
});

// ─── FG-332: second run output should confirm no-op for already-created items ─

test("integ FG-332: second forge init run reports already-exists for backlog/ and seed files", () => {
  runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);
  const out = second.stdout;
  assert.match(out, /backlog\/.*no-op|already exists/, "second init should report no-op for backlog/");
  assert.match(out, /model-policy\.yml.*no-op|already exists/, "second init should report no-op for model-policy.yml");
});

// ----- planCommitMsgHook — git-dependent cases (FG-408: moved from unit tier) -----

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

// ----- forge init CLI end-to-end via execSync (FG-408: moved from unit tier) -----

test("forge init --prefix: writes prefix into .forge/config.yml", () => {
  execSync(`npm run forge -- init --project ${projectDir} --no-install-hooks --prefix FG`, {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  const configPath = join(projectDir, ".forge", "config.yml");
  assert.ok(existsSync(configPath), ".forge/config.yml should be created");
  const content = readFileSync(configPath, "utf8");
  assert.match(content, /prefix.*FG|FG.*prefix/, "config.yml should contain the prefix");
});

test("forge init --dry-run: reports backlog scaffold, config, model-policy, docs-surfaces without writing", () => {
  const out = execSync(`npm run forge -- init --project ${projectDir} --no-install-hooks --prefix TEST --dry-run`, {
    cwd: process.cwd(),
    stdio: "pipe",
  }).toString();
  assert.match(out, /backlog\//i, "dry-run should mention backlog/ scaffold");
  assert.match(out, /prefix.*TEST|config\.yml/i, "dry-run should mention config.yml prefix");
  assert.match(out, /model-policy\.yml/i, "dry-run should mention model-policy.yml");
  assert.match(out, /docs-surfaces\.yml/i, "dry-run should mention docs-surfaces.yml");
  assert.ok(!existsSync(join(projectDir, ".forge")), ".forge/ should not be created in dry-run");
  assert.ok(!existsSync(join(projectDir, "backlog")), "backlog/ should not be created in dry-run");
});
