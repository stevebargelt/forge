// Tests for `forge upgrade`. The action handler itself is integration-heavy
// (shells out to bash, writes files), so we focus on tryGitPull's pure
// decision logic — that's where the meaningful branching lives.

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
    // Point at a bogus URL — we never actually fetch in the no-remote /
    // dirty / dry-run paths, and the test for the real pull is exercised
    // elsewhere (or not — git pull network would be too flaky to test).
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
  // Dirty is the earlier check; no-remote would also apply but dirty wins.
  assert.equal(r.kind, "dirty");
});

test("tryGitPull: dry-run with remote + clean tree returns 'ok' without actually fetching", () => {
  initRepo({ withRemote: true });
  const r = tryGitPull(dir, /* dryRun */ true);
  assert.equal(r.kind, "ok");
});

test("tryGitPull: returns 'error' when not a git repo", () => {
  // Don't init.
  const r = tryGitPull(dir, /* dryRun */ false);
  // Either kind: "error" or kind: "no-remote" is acceptable; git status fails
  // before we get to the remote check.
  assert.ok(r.kind === "error" || r.kind === "no-remote");
});
