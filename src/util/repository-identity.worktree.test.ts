import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { repositoryCheckoutIdentity } from "./repository-identity.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(name: string, branch = "main"): string {
  const parent = mkdtempSync(join(tmpdir(), "forge-repo-ident-"));
  cleanup.push(parent);
  const dir = join(parent, name);
  mkdirSync(dir);
  git(dir, ["init", "-b", branch]);
  return dir;
}

function commit(dir: string): void {
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
}

test("standalone clones with SSH and HTTPS spellings of one origin share repository identity", () => {
  const a = repo("forge-a", "main");
  const b = repo("forge-b", "dashboard-home");
  git(a, ["remote", "add", "origin", "git@github.com:stevebargelt/forge.git"]);
  git(b, ["remote", "add", "origin", "https://github.com/stevebargelt/forge"]);
  assert.equal(repositoryCheckoutIdentity(a).key, repositoryCheckoutIdentity(b).key);
  assert.equal(repositoryCheckoutIdentity(a).branch, "main");
  assert.equal(repositoryCheckoutIdentity(b).branch, "dashboard-home");
});

test("a linked worktree and main checkout share git-common-dir identity without a remote", () => {
  const main = repo("local-main", "main");
  commit(main);
  const worktree = join(dirname(main), "local-worktree");
  git(main, ["worktree", "add", "-b", "feature", worktree]);
  const a = repositoryCheckoutIdentity(main);
  const b = repositoryCheckoutIdentity(worktree);
  assert.equal(a.source, "git-common-dir");
  assert.equal(b.source, "git-common-dir");
  assert.equal(a.key, b.key);
});

test("same-basename repositories with different remotes remain separate", () => {
  const a = repo("same");
  const bParent = mkdtempSync(join(tmpdir(), "forge-repo-ident-other-"));
  cleanup.push(bParent);
  const b = join(bParent, basename(a));
  mkdirSync(b);
  git(b, ["init", "-b", "main"]);
  git(a, ["remote", "add", "origin", "git@github.com:one/same.git"]);
  git(b, ["remote", "add", "origin", "git@github.com:two/same.git"]);
  assert.notEqual(repositoryCheckoutIdentity(a).key, repositoryCheckoutIdentity(b).key);
});

test("repository without a remote has deterministic git-common-dir fallback identity", () => {
  const dir = repo("local");
  const first = repositoryCheckoutIdentity(dir);
  const second = repositoryCheckoutIdentity(join(dir, "."));
  assert.equal(first.key, second.key);
  assert.equal(first.source, "git-common-dir");
});

test("missing checkout never claims a current branch", () => {
  const parent = mkdtempSync(join(tmpdir(), "forge-repo-ident-missing-"));
  cleanup.push(parent);
  const missing = join(parent, "deleted-checkout");
  const identity = repositoryCheckoutIdentity(missing);
  assert.equal(identity.exists, false);
  assert.equal(identity.branch, undefined);
  assert.equal(identity.source, "path");
});
