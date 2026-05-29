import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot } from "./git-root.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "forge-git-root-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("findGitRoot: returns the repo root for the root itself", () => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  assert.equal(findGitRoot(dir), dir);
});

test("findGitRoot: rolls a nested subdir up to the repo root", () => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  const sub = join(dir, "web-admin", "src");
  mkdirSync(sub, { recursive: true });
  assert.equal(findGitRoot(sub), dir);
});

test("findGitRoot: detects a .git FILE (worktree/submodule)", () => {
  writeFileSync(join(dir, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
  const sub = join(dir, "pkg");
  mkdirSync(sub, { recursive: true });
  assert.equal(findGitRoot(sub), dir);
});

test("findGitRoot: returns startDir unchanged when no .git ancestor exists", () => {
  // temp dirs live under /tmp with no .git up the tree
  assert.equal(findGitRoot(dir), dir);
});
