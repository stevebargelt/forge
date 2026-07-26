// FG-376 review FIX3: individual worktree/task disposal must NOT remove a
// shared dependency-cache volume (dependency-provisioning.ts) — a volume this
// task's install populated may still be the one another concurrent/later task
// reuses (cache key = lockfile hash, FIX2). These tests confirm disposal still
// removes the worktree + branch as before, and that it never shells out to
// `docker volume rm` — proven via a PATH-shadowing `docker` stub rather than a
// real docker daemon, so it runs the same on Linux CI as on macOS.
//
// Real git repos + real `git worktree` commands (not gated by
// preflightWorktreeGate/platform — these disposal functions never call it),
// so this runs on Linux CI same as macOS.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  worktreeBranchName,
  integrationBranchName,
  removeWorktreeIfSafe,
  cleanupFailedWorktreeSetup,
  cleanupIntegrationWorktree,
} from "./worktree-lifecycle.js";
import { worktreeDir, integrationWorktreeDir, WORKTREES_DIR } from "../util/paths.js";

const tmpDirs: string[] = [];

beforeEach(() => {
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";
});

afterEach(() => {
  delete process.env.FORGE_WORKTREES_EPHEMERAL;
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

test("removeWorktreeIfSafe (EPHEMERAL): still removes the worktree + branch when the worktree has a package-lock.json", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg376-a";
  const taskId = "task-fg376-a";
  const wtPath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });
  assert.ok(existsSync(wtPath));

  assert.doesNotThrow(() => removeWorktreeIfSafe(wtPath, runId, taskId, projectDir));

  assert.ok(!existsSync(wtPath), "worktree directory must still be removed");
  const branches = execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" });
  assert.equal(branches.trim(), "", "task branch must still be force-deleted");
});

test("removeWorktreeIfSafe (EPHEMERAL): no-ops safely (no throw) when the worktree has NO lockfile", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: projectDir, stdio: "ignore" });
  writeFileSync(join(projectDir, "README.md"), "# no lockfile\n");
  execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: projectDir, stdio: "ignore" });

  const runId = "run-fg376-b";
  const taskId = "task-fg376-b";
  const wtPath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

  assert.doesNotThrow(() => removeWorktreeIfSafe(wtPath, runId, taskId, projectDir));
  assert.ok(!existsSync(wtPath));
});

test("cleanupFailedWorktreeSetup: removes a partially-created worktree (with lockfile)", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg376-c";
  const taskId = "task-fg376-c";
  const wtPath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

  assert.doesNotThrow(() => cleanupFailedWorktreeSetup(projectDir, runId, taskId));
  assert.ok(!existsSync(wtPath));
});

test("cleanupIntegrationWorktree: removes the integration worktree + branch (with lockfile)", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg376-d";
  const parentTaskId = "task-fg376-parent";
  const integPath = integrationWorktreeDir(runId, parentTaskId);
  const branch = integrationBranchName(runId, parentTaskId);
  mkdirSync(join(WORKTREES_DIR, runId, parentTaskId), { recursive: true });
  execFileSync("git", ["worktree", "add", integPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

  assert.doesNotThrow(() => cleanupIntegrationWorktree(projectDir, runId, parentTaskId));
  assert.ok(!existsSync(integPath));
  const branches = execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" });
  assert.equal(branches.trim(), "");
});

// ── FIX3: individual disposal must never remove a SHARED dependency-cache volume ──

// Shadows `docker` on PATH with a stub that just logs its argv — proves (or
// disproves) "disposal shells out to `docker volume rm`" without needing a
// real docker daemon, so this assertion holds the same on a docker-less CI
// box as it would against real docker.
function makeDockerStub(): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-docker-stub-"));
  const logPath = join(binDir, "docker-calls.log");
  writeFileSync(join(binDir, "docker"), `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

test("removeWorktreeIfSafe (EPHEMERAL): does not remove a shared dependency-cache volume at individual disposal, even while another task references the same cache key", () => {
  const { binDir, logPath } = makeDockerStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    const projectDir = makeTmpDir("forge-fg376-repo-");
    initGitRepo(projectDir); // writes package-lock.json with content "{}"

    const runId = "run-fg376-fix3";
    const taskId = "task-fg376-fix3-a";
    const wtPath = worktreeDir(runId, taskId);
    const branch = worktreeBranchName(runId, taskId);
    mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
    execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

    // A second, still-active task's worktree shares the SAME lockfile content
    // (same cache key) — simulates "another task references the same key"
    // while the first task's worktree is disposed.
    const otherTaskId = "task-fg376-fix3-b";
    const otherWtPath = worktreeDir(runId, otherTaskId);
    const otherBranch = worktreeBranchName(runId, otherTaskId);
    execFileSync("git", ["worktree", "add", otherWtPath, "-b", otherBranch], { cwd: projectDir, stdio: "ignore" });

    assert.doesNotThrow(() => removeWorktreeIfSafe(wtPath, runId, taskId, projectDir));
    assert.ok(!existsSync(wtPath), "the disposed worktree directory is still removed");

    const dockerCalls = readFileSync(logPath, "utf8").trim();
    assert.equal(dockerCalls, "", `individual worktree disposal must never invoke docker (shared cache volume) — got: ${JSON.stringify(dockerCalls)}`);

    // The other task's worktree (and by extension, its claim on the shared
    // cache key) is completely untouched.
    assert.ok(existsSync(otherWtPath), "another task's worktree referencing the same cache key must be unaffected");
  } finally {
    process.env.PATH = origPath;
  }
});

test("cleanupFailedWorktreeSetup / cleanupIntegrationWorktree: neither invokes docker (no shared-volume removal at disposal)", () => {
  const { binDir, logPath } = makeDockerStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    const projectDir = makeTmpDir("forge-fg376-repo-");
    initGitRepo(projectDir);

    const runId = "run-fg376-fix3b";
    const taskId = "task-fg376-fix3b-a";
    const wtPath = worktreeDir(runId, taskId);
    const branch = worktreeBranchName(runId, taskId);
    mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
    execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });
    cleanupFailedWorktreeSetup(projectDir, runId, taskId);

    const parentTaskId = "task-fg376-fix3b-parent";
    const integPath = integrationWorktreeDir(runId, parentTaskId);
    const integBranch = integrationBranchName(runId, parentTaskId);
    mkdirSync(join(WORKTREES_DIR, runId, parentTaskId), { recursive: true });
    execFileSync("git", ["worktree", "add", integPath, "-b", integBranch], { cwd: projectDir, stdio: "ignore" });
    cleanupIntegrationWorktree(projectDir, runId, parentTaskId);

    const dockerCalls = readFileSync(logPath, "utf8").trim();
    assert.equal(dockerCalls, "", `no disposal path should invoke docker — got: ${JSON.stringify(dockerCalls)}`);
  } finally {
    process.env.PATH = origPath;
  }
});

// Shadows `git` with a stub whose `worktree remove` deletes the directory and
// THEN fails — the shape that makes path-absence a lie about removal success.
function makeFailingRemoveGitStub(): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-git-stub-"));
  const logPath = join(binDir, "git-calls.log");
  writeFileSync(
    join(binDir, "git"),
    `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then\n  for a in "$@"; do last="$a"; done\n  rm -rf "$last"\n  exit 1\nfi\nexit 0\n`
  );
  chmodSync(join(binDir, "git"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

test("cleanupFailedWorktreeSetup: prunes stale registrations when `git worktree remove` fails but the directory is gone anyway", () => {
  const projectDir = makeTmpDir("forge-fg356-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg356-prune";
  const taskId = "task-fg356-prune";
  const wtPath = worktreeDir(runId, taskId);
  mkdirSync(wtPath, { recursive: true });

  const { binDir, logPath } = makeFailingRemoveGitStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    assert.doesNotThrow(() => cleanupFailedWorktreeSetup(projectDir, runId, taskId));
  } finally {
    process.env.PATH = origPath;
  }

  assert.ok(!existsSync(wtPath), "the stub removed the directory before failing");
  const gitCalls = readFileSync(logPath, "utf8");
  assert.match(
    gitCalls,
    /worktree prune/,
    `a failed remove must still prune the parent repo's stale registrations — git calls were: ${JSON.stringify(gitCalls)}`
  );
});
