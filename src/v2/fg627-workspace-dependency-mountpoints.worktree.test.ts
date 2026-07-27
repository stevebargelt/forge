// FG-627: dependency provisioning could not mount into ANY isolated workspace.
//
// The provisioner mounts the project READ-ONLY and mounts each lockfile-keyed
// dependency volume at a path INSIDE that mount (spawn.ts's
// buildProvisionerDockerArgs). Docker must create the mountpoint before it can
// bind there and cannot mkdir on a read-only rootfs, so a workspace missing
// `<member>/node_modules` kills the provisioner with exit 125 before any
// install runs. A main checkout has those directories lying around from a
// previous `npm install`; a fresh workspace never does — `node_modules` is
// gitignored, so neither `git clone --shared` nor `git worktree add` carries
// it. Both substrates were affected, not just FG-621's clone.
//
// What this file proves: after the real constructors run, the mountpoints
// exist, member-for-member with what the planner the spawn path uses will
// mount; the workspace is still clean by the probe capture and the reaper
// read; and a project with no lockfile is left untouched. What it does NOT
// prove — deliberately, because assuming it is the exact defect FG-627 exists
// to close — is that the mount then succeeds. That needs a Docker daemon and
// the real dispatch; a plan-level assertion is not a mount.
//
// Tier: worktree (`npm run test:worktree`) — chosen by the slowest operation,
// real `git clone --shared` / `git worktree add` through the constructors.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cloneDir, worktreeDir, WORKTREES_DIR } from "../util/paths.js";
import { planDependencyVolumes } from "./dependency-provisioning.js";
import { createTaskClone, createWorktree } from "./worktree-lifecycle.js";

const RUN_ID = "run-fg627-mountpoints";
const CONTAINER_PATH = "/project";
const WORKSPACE_MEMBER = "packages/lib";

const tmpDirs: string[] = [];
const workspaces: string[] = [];
let forgeHomeBefore: string | undefined;

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg627-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repo shaped like the projects that hit this: a root lockfile, a workspace
 *  member with its own package.json, and `node_modules` gitignored — so the
 *  member enumeration has more than one entry and the cleanliness assertions
 *  are made against a real ignore rule rather than an accident. */
function makeRepo(opts?: { lockfile?: boolean }): { dir: string; head: string } {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  mkdirSync(join(dir, WORKSPACE_MEMBER), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg627", private: true, workspaces: [WORKSPACE_MEMBER] }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, WORKSPACE_MEMBER, "package.json"),
    JSON.stringify({ name: "@fg627/lib", version: "1.0.0" }, null, 2) + "\n",
  );
  if (opts?.lockfile !== false) {
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ name: "fg627", lockfileVersion: 3, packages: {} }, null, 2) + "\n",
    );
  }
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, head: git(dir, "rev-parse", "HEAD").trim() };
}

/** The host paths the SPAWN path's plan will mount into, derived from the same
 *  planner against the same container path the runtime uses — so a drift
 *  between what is created and what is mounted shows up as a failure here. */
function plannedMountpoints(workspacePath: string): string[] {
  const plan = planDependencyVolumes(workspacePath, CONTAINER_PATH);
  return plan.volumes.map((v) => join(workspacePath, v.containerPath.slice(CONTAINER_PATH.length + 1)));
}

function statusPorcelain(treePath: string, ...extra: string[]): string {
  return git(treePath, "status", "--porcelain", ...extra).trim();
}

beforeEach(() => {
  forgeHomeBefore = process.env.FORGE_HOME;
  process.env.FORGE_HOME = tmpRoot("home");
});

afterEach(() => {
  if (forgeHomeBefore === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = forgeHomeBefore;
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
  rmSync(join(WORKTREES_DIR, RUN_ID), { recursive: true, force: true });
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("fg627: a fresh linked worktree carries a mountpoint for every planned dependency volume", () => {
  const repo = makeRepo();
  const { worktreePath } = createWorktree(repo.dir, RUN_ID, "t-wt");
  workspaces.push(worktreePath);
  assert.equal(worktreePath, worktreeDir(RUN_ID, "t-wt"));

  const planned = plannedMountpoints(worktreePath);
  assert.deepEqual(
    planned,
    [join(worktreePath, "node_modules"), join(worktreePath, WORKSPACE_MEMBER, "node_modules")],
    "non-vacuity: the plan must cover the repo root AND the workspace member, or one existing dir passes this",
  );
  for (const path of planned) {
    assert.equal(statSync(path, { throwIfNoEntry: false })?.isDirectory(), true, `missing mountpoint ${path}`);
  }
});

test("fg627: a fresh private clone carries a mountpoint for every planned dependency volume", () => {
  const repo = makeRepo();
  const { clonePath } = createTaskClone(repo.dir, RUN_ID, "t-clone", repo.head);
  workspaces.push(clonePath);
  assert.equal(clonePath, cloneDir(RUN_ID, "t-clone"));

  const planned = plannedMountpoints(clonePath);
  assert.deepEqual(planned, [join(clonePath, "node_modules"), join(clonePath, WORKSPACE_MEMBER, "node_modules")]);
  for (const path of planned) {
    assert.equal(statSync(path, { throwIfNoEntry: false })?.isDirectory(), true, `missing mountpoint ${path}`);
  }
});

test("fg627: the mountpoints leave both substrates CLEAN — capture and the reaper see nothing", () => {
  const repo = makeRepo();
  const { worktreePath } = createWorktree(repo.dir, RUN_ID, "t-wt-clean");
  workspaces.push(worktreePath);
  const { clonePath } = createTaskClone(repo.dir, RUN_ID, "t-clone-clean", repo.head);
  workspaces.push(clonePath);

  for (const workspace of [worktreePath, clonePath]) {
    assert.equal(statusPorcelain(workspace), "", `${workspace} must be tracked-clean for capture`);
    // `--ignored` is the reaper's own probe (worktree-lifecycle.ts's
    // statusPorcelainIgnored): it treats ignored output as unrecovered work, so
    // a mountpoint it could see would retain every workspace forever.
    assert.equal(statusPorcelain(workspace, "--ignored"), "", `${workspace} must be clean under the reaper's probe`);
    assert.equal(git(workspace, "ls-files", "--others", "--exclude-standard").trim(), "");
  }
});

test("fg627: a project with no lockfile has no plan, so neither substrate creates anything", () => {
  const repo = makeRepo({ lockfile: false });
  const { worktreePath } = createWorktree(repo.dir, RUN_ID, "t-wt-nolock");
  workspaces.push(worktreePath);
  const { clonePath } = createTaskClone(repo.dir, RUN_ID, "t-clone-nolock", repo.head);
  workspaces.push(clonePath);

  for (const workspace of [worktreePath, clonePath]) {
    assert.throws(() => planDependencyVolumes(workspace, CONTAINER_PATH), /no package-lock.json/);
    assert.equal(existsSync(join(workspace, "node_modules")), false);
    assert.equal(existsSync(join(workspace, WORKSPACE_MEMBER, "node_modules")), false);
    assert.equal(statusPorcelain(workspace, "--ignored"), "");
  }
});
