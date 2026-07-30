// FG-645 (mechanism half): docker/commit-scratch-tree.sh — the step that makes a
// COPIED working tree a clean release candidate.
//
// verify-launch-tier-in-image.sh runs this inside a container, which this suite
// cannot do. What it CAN do is drive the script itself, against real temp
// directories and a real git — which is the whole reason the step was factored out
// of that script instead of being written inline again. The container-level evidence
// (the launch tier completing from a dirty checkout) is the operator's to record;
// what is asserted here is the mechanism it depends on.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "..", "..", "docker", "commit-scratch-tree.sh");
const VERIFY_SCRIPT = resolve(here, "..", "..", "docker", "verify-launch-tier-in-image.sh");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg645-scratch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** A copy of a working tree, as the harness's tar produces it: source files plus
 *  whatever `.git` the operator's checkout had. */
function copiedTree(name = "copy"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `{"name":"x"}\n`);
  writeFileSync(join(dir, "edited.ts"), "// in-flight edit\n");
  return dir;
}

test("integ FG-645: a copied tree with uncommitted work becomes a CLEAN release candidate", () => {
  const dir = copiedTree();
  const res = run([dir, "--branch", "fg645-branch"]);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), "", "the release builder must see a clean tree");
  assert.equal(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "fg645-branch", "the branch is mirrored");
  assert.match(
    git(dir, ["show", "--name-only", "--format=", "HEAD"]),
    /edited\.ts/,
    "HEAD must describe the IN-FLIGHT bytes, not some earlier commit",
  );
});

test("integ FG-645: a copied `.git` POINTER is replaced, never committed through (FG-575)", () => {
  // What tarring a linked worktree actually produces: `.git` is a FILE pointing at
  // the operator's real admin dir. Committing through it would write into the
  // operator's repository.
  const operatorRepo = join(root, "operator");
  mkdirSync(operatorRepo, { recursive: true });
  git(operatorRepo, ["init", "-q"]);
  git(operatorRepo, ["config", "user.email", "op@example.com"]);
  git(operatorRepo, ["config", "user.name", "Operator"]);
  writeFileSync(join(operatorRepo, "README.md"), "seed\n");
  git(operatorRepo, ["add", "-A"]);
  git(operatorRepo, ["commit", "-qm", "operator's own commit"]);
  const before = git(operatorRepo, ["rev-parse", "HEAD"]).trim();

  const dir = copiedTree();
  writeFileSync(join(dir, ".git"), `gitdir: ${join(operatorRepo, ".git")}\n`);

  const res = run([dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(
    git(operatorRepo, ["rev-parse", "HEAD"]).trim(),
    before,
    "the operator's repository must be untouched",
  );
  assert.equal(git(operatorRepo, ["status", "--porcelain"]).trim(), "", "and left clean");
  assert.ok(existsSync(join(dir, ".git", ".forge-scratch-repo")), "the copy got a repo this script created");
});

test("integ FG-645: the scratch repo is reused, not rebuilt, and re-running is a no-op", () => {
  const dir = copiedTree();
  assert.equal(run([dir]).status, 0);
  const first = git(dir, ["rev-parse", "HEAD"]).trim();

  const again = run([dir]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /already describes the copied source/);
  assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), first, "an unchanged tree must not grow commits");

  // A further edit is picked up rather than ignored — the failure mode that makes a
  // harness test stale bytes forever.
  writeFileSync(join(dir, "edited.ts"), "// second edit\n");
  assert.equal(run([dir]).status, 0);
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
  assert.notEqual(git(dir, ["rev-parse", "HEAD"]).trim(), first);
});

test("integ FG-645: node_modules is excluded — it is install output, not source identity", () => {
  const dir = copiedTree();
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

  assert.equal(run([dir]).status, 0);
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), "", "node_modules must not leave the tree dirty");
  assert.doesNotMatch(git(dir, ["ls-files"]), /node_modules/, "and must not be committed");
});

test("integ FG-645: a missing directory is a loud usage error, not a silent success", () => {
  const res = run([join(root, "does-not-exist")]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /usage/);
});

test("integ FG-645: verify-launch-tier-in-image.sh runs this step on its copied tree", () => {
  const script = readFileSync(VERIFY_SCRIPT, "utf8");
  assert.match(
    script,
    /docker exec .*commit-scratch-tree\.sh/,
    "the image harness must commit its copy — otherwise it inherits the host's dirtiness",
  );
  assert.doesNotMatch(
    script,
    /run it from a committed checkout/,
    "the constraint this fix removes must not still be documented as live",
  );
});
