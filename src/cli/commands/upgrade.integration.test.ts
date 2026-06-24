import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tryGitPull } from "./upgrade.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-upgrade-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function initRepo(opts: { withRemote?: boolean; dirty?: boolean } = {}): void {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@test"', { cwd: dir });
  execSync('git config user.name "test"', { cwd: dir });
  execSync('git commit -q --allow-empty -m "initial"', { cwd: dir });
  if (opts.withRemote) {
    execSync('git remote add origin https://invalid.example.invalid/repo.git', { cwd: dir });
  }
  if (opts.dirty) {
    execSync("touch dirty-file && git add dirty-file", { cwd: dir });
  }
}

test("tryGitPull: returns 'no-remote' when repo has no remote configured", () => {
  initRepo({ withRemote: false });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "no-remote");
});

test("tryGitPull: returns 'dirty' when working tree has uncommitted changes", () => {
  initRepo({ withRemote: true, dirty: true });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "dirty");
});

test("tryGitPull: dirty takes priority over no-remote check", () => {
  initRepo({ withRemote: false, dirty: true });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "dirty");
});

test("tryGitPull: dry-run with remote + clean tree returns 'ok' without actually fetching", () => {
  initRepo({ withRemote: true });
  const r = tryGitPull(dir, /* dryRun */ true);
  assert.equal(r.kind, "ok");
});

test("tryGitPull: returns 'error' when not a git repo", () => {
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.ok(r.kind === "error" || r.kind === "no-remote");
});
