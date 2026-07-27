// FG-621 AC 8: dependency provisioning resolves the same lockfile hash and the
// same populated volume set for a private `git clone --shared` as for the
// linked-worktree path that ships today.
//
// This is a CONFIRMATION, not a change. planDependencyVolumes
// (dependency-provisioning.ts:134) is substrate-blind by construction: it
// hashes `<repoRoot>/package-lock.json` and enumerates `workspaces` out of
// `<repoRoot>/package.json`. Neither read looks at `.git` at all, so a clone
// of a commit and a linked worktree of that same commit — which have
// byte-identical working trees — MUST land on one cache key. AC 8 is the claim
// that FG-621's new clone substrate does not silently fork the dependency
// cache and pay for a fresh `npm ci` per task; this file proves it on real git
// fixtures rather than asserting it in a comment.
//
// Scope fence: nothing here modifies production code. The fixtures are built
// with plain `git clone --shared` / `git worktree add`, NOT with FG-621's new
// clone constructor, so this file has zero compile dependency on the core
// substrate step and can be validated independently.
//
// What this proves and what it does not: the named lockfile-keyed volume mount
// in buildDockerArgs is darwin-gated (`process.platform === "darwin"`,
// spawn.ts:431), so end-to-end volume REUSE inside a container is a macOS
// property. What AC 8 actually claims — that the two substrates resolve to the
// SAME plan, and therefore to the same already-populated volumes — is a
// plan-level identity, and that is what is asserted below, on every platform.
//
// Tier: worktree (`npm run test:worktree`) — chosen by the slowest operation,
// `git clone` / `git worktree add`. Precedent: fg559-worktree-git-mount and
// fg376-dependency-provisioning.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planDependencyVolumes, type DependencyVolumePlan } from "./dependency-provisioning.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

const CONTAINER_PATH = "/project";
const WORKSPACE_MEMBER = "packages/lib";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeLockfile(root: string, marker: string): void {
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ name: "fg621-parity", lockfileVersion: 3, marker, packages: {} }, null, 2) + "\n",
  );
}

type Fixture = {
  /** The source repo — stands in for the operator's project checkout. */
  parent: string;
  /** `git clone --shared` of parent at `sha` — FG-621's new substrate. */
  clone: string;
  /** `git worktree add` of parent at `sha` — FG-559's shipped substrate. */
  worktree: string;
  sha: string;
};

/** A real repo carrying a package-lock.json AND a workspace member, so the
 *  plan under comparison has more than one volume in it — a single-element
 *  comparison would pass even if member enumeration were substrate-sensitive. */
function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg621-parity-")));
  tmpDirs.push(base);

  const parent = join(base, "parent");
  mkdirSync(join(parent, WORKSPACE_MEMBER), { recursive: true });
  git(parent, "init", "-b", "main");
  git(parent, "config", "user.email", "test@forge.test");
  git(parent, "config", "user.name", "Forge Test");

  writeFileSync(
    join(parent, "package.json"),
    JSON.stringify({ name: "fg621-parity", private: true, workspaces: [WORKSPACE_MEMBER] }, null, 2) + "\n",
  );
  writeFileSync(
    join(parent, WORKSPACE_MEMBER, "package.json"),
    JSON.stringify({ name: "@fg621/lib", version: "1.0.0" }, null, 2) + "\n",
  );
  writeLockfile(parent, "base");
  git(parent, "add", ".");
  git(parent, "commit", "-m", "base");
  const sha = gitOut(parent, "rev-parse", "HEAD");

  const clone = join(base, "clone");
  execFileSync("git", ["clone", "--shared", parent, clone], { stdio: "ignore" });
  git(clone, "checkout", "--detach", sha);

  const worktree = join(base, "wt");
  git(parent, "worktree", "add", "--detach", worktree, sha);

  // Guards against the vacuous-fixture mode: if a refactor turns either
  // workspace into something other than what it claims to be, every parity
  // assertion below still "passes" and proves nothing about AC 8.
  assert.equal(
    statSync(join(clone, ".git")).isDirectory(),
    true,
    "fixture must be a real CLONE — <clone>/.git must be a directory, not a gitdir: pointer file",
  );
  assert.equal(
    statSync(join(clone, ".git", "objects", "info", "alternates")).isFile(),
    true,
    "fixture must be a --shared clone — objects/info/alternates must name the parent object store",
  );
  assert.equal(
    statSync(join(worktree, ".git")).isFile(),
    true,
    "fixture must be a LINKED WORKTREE — <wt>/.git must be a gitdir: pointer FILE, not a directory",
  );
  assert.equal(gitOut(clone, "rev-parse", "HEAD"), sha, "clone must be checked out at the parent commit");
  assert.equal(gitOut(worktree, "rev-parse", "HEAD"), sha, "worktree must be checked out at the parent commit");

  return { parent, clone, worktree, sha };
}

/** Stable, order-independent shape of a plan's volumes — what "the same
 *  populated volume set" means when AC 8 says it. */
function volumeShape(plan: DependencyVolumePlan): { name: string; relPath: string; containerPath: string }[] {
  return [...plan.volumes]
    .map((v) => ({ name: v.name, relPath: v.relPath, containerPath: v.containerPath }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ─── AC 8 ────────────────────────────────────────────────────────────────────

test("FG-621 AC 8: a --shared clone resolves the same lockfile hash as its parent checkout", () => {
  const { parent, clone } = makeFixture();

  const parentPlan = planDependencyVolumes(parent, CONTAINER_PATH);
  const clonePlan = planDependencyVolumes(clone, CONTAINER_PATH);

  assert.equal(
    clonePlan.lockfileHash,
    parentPlan.lockfileHash,
    "a clone of a commit must hash to the same cache key as the checkout of that commit",
  );
  assert.equal(clonePlan.installRoot, parentPlan.installRoot);
});

test("FG-621 AC 8: clone, linked worktree and parent all resolve one identical volume set", () => {
  const { parent, clone, worktree } = makeFixture();

  const parentPlan = planDependencyVolumes(parent, CONTAINER_PATH);
  const clonePlan = planDependencyVolumes(clone, CONTAINER_PATH);
  const worktreePlan = planDependencyVolumes(worktree, CONTAINER_PATH);

  // Non-vacuity: the plan must actually contain the root member AND the
  // workspace member, or "identical" below is a comparison of one element.
  assert.deepEqual(
    volumeShape(parentPlan).map((v) => v.relPath),
    ["", WORKSPACE_MEMBER],
    "fixture plan must enumerate the repo root plus the workspace member",
  );

  assert.deepEqual(
    volumeShape(clonePlan),
    volumeShape(parentPlan),
    "the clone substrate must resolve the same volume names and container paths as the parent",
  );
  assert.deepEqual(
    volumeShape(worktreePlan),
    volumeShape(parentPlan),
    "the linked-worktree substrate must resolve the same volume names and container paths as the parent",
  );
  assert.equal(worktreePlan.lockfileHash, clonePlan.lockfileHash);

  // The AC-8 claim restated as one assertion: all three substrates key into a
  // single already-populated cache, so no substrate pays for its own install.
  assert.equal(
    new Set([parentPlan, clonePlan, worktreePlan].map((p) => JSON.stringify(volumeShape(p)))).size,
    1,
    "all three substrates must land on exactly one dependency-volume plan",
  );
});

test("FG-621 AC 8 negative control: editing the clone's lockfile changes the cache key", () => {
  const { parent, clone } = makeFixture();

  const before = planDependencyVolumes(clone, CONTAINER_PATH);
  assert.equal(before.lockfileHash, planDependencyVolumes(parent, CONTAINER_PATH).lockfileHash);

  writeLockfile(clone, "diverged");
  const after = planDependencyVolumes(clone, CONTAINER_PATH);

  assert.notEqual(
    after.lockfileHash,
    before.lockfileHash,
    "the parity assertions above are only meaningful if the hash is content-sensitive — it must move when the lockfile does",
  );
  const beforeNames = new Set(volumeShape(before).map((v) => v.name));
  assert.deepEqual(
    volumeShape(after)
      .map((v) => v.name)
      .filter((n) => beforeNames.has(n)),
    [],
    "every volume name must change with the cache key — a stale install must never be silently reused",
  );
  // Only the hash-derived NAME moves; the member set and mount destinations are
  // structural and stay put.
  assert.deepEqual(
    volumeShape(after).map((v) => ({ relPath: v.relPath, containerPath: v.containerPath })),
    volumeShape(before).map((v) => ({ relPath: v.relPath, containerPath: v.containerPath })),
  );
});
