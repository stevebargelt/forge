// FG-693 step 12 — the commit-msg-hook half of "one canonicalizer, and the
// migrated modules still behave".
//
// INTEGRATION TIER, and not by preference. assertWorkspaceHookEnforceable asks
// git where it will look for hooks; there is no injection seam for that, and the
// property FG-693 has to preserve here is precisely about the answer git gives
// versus the directory forge wrote into. src/test-tiers.test.ts forbids a
// unit-tier file from spawning a subprocess (FG-495), so the git-backed cases
// live here and the pure ones stay in fg693-single-canonicalizer.test.ts.
//
// PORTABLE BY CONSTRUCTION: every alias below is one this file CREATES — a
// symlinked parent, and a symlinked spelling of the hooks directory itself. No
// case depends on an alias a particular operating system happens to provide.
// The native `/var` vs `/private/var` spellings are exercised by running this
// same file on the darwin host, where it must behave IDENTICALLY.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommitMsgHookUnenforceableError,
  assertWorkspaceHookEnforceable,
  provisionWorkspaceCommitMsgHook,
} from "./commit-msg-hook.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A real git repository at a PHYSICAL path, plus a symlinked spelling of it.
 *  Both name one workspace; only one of them is the realpath. */
function gitRepoWorkspace(prefix: string): { workspace: string; physical: string } {
  // realpath the fixture root itself, so `physical` really is physical even when
  // the OS puts temp dirs under a link of its own.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(root);
  const physical = join(root, "real", "ws");
  mkdirSync(physical, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: physical, stdio: ["ignore", "ignore", "pipe"] });
  symlinkSync(join(root, "real"), join(root, "link"), "dir");
  return { workspace: join(root, "link", "ws"), physical };
}

test("FG-693: the workspace hook assertion still passes for a workspace addressed through a symlinked parent", () => {
  const { workspace } = gitRepoWorkspace("forge-fg693-hook-");
  // plan → execute → pin → assert, the one production entry point.
  assert.doesNotThrow(() => provisionWorkspaceCommitMsgHook(workspace));
  assert.doesNotThrow(() => assertWorkspaceHookEnforceable(workspace));
});

test("FG-693: the hooks directory git names and the one forge installed are ONE directory, spelled differently", () => {
  const { workspace } = gitRepoWorkspace("forge-fg693-hook-alias-");

  // A core.hooksPath that ALREADY names the installed hooks directory by a
  // different spelling — a symlink beside it, pinned relative. forge leaves an
  // existing pin alone, so this is the operator configuration the guard has to
  // read correctly: git consults exactly the directory forge wrote into, under
  // another name.
  symlinkSync(join(".git", "hooks"), join(workspace, "hooks-alias"), "dir");
  execFileSync("git", ["config", "--local", "core.hooksPath", "hooks-alias"], {
    cwd: workspace,
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Raw string equality of the two spellings is FALSE. They are one directory.
  assert.notEqual(join(workspace, "hooks-alias"), join(workspace, ".git", "hooks"));

  // Driven through the production entry points, not by calling the identity
  // helper. Replace either comparison in assertWorkspaceHookEnforceable with raw
  // string equality and this goes red — that is the AC8 property for this
  // consumer's seam.
  assert.doesNotThrow(() => provisionWorkspaceCommitMsgHook(workspace));
  assert.doesNotThrow(() => assertWorkspaceHookEnforceable(workspace));
});

test("FG-693 negative control: an effective hooks directory that is a genuinely DIFFERENT tree is still refused", () => {
  const { workspace } = gitRepoWorkspace("forge-fg693-hook-override-");
  provisionWorkspaceCommitMsgHook(workspace);

  // A real override: git is pointed at ANOTHER repository's hooks dir. Nothing
  // about it is an alias of the workspace's, and the guard must still fire — the
  // contract collapses spellings, never separate trees.
  const other = gitRepoWorkspace("forge-fg693-hook-other-");
  const saved = process.env["GIT_DIR"];
  process.env["GIT_DIR"] = join(other.physical, ".git");
  try {
    assert.throws(
      () => assertWorkspaceHookEnforceable(workspace),
      (e: unknown) => e instanceof CommitMsgHookUnenforceableError && /git consults/.test(e.message),
      "the refusal must be the hooks-directory comparison, not an incidental failure"
    );
  } finally {
    if (saved === undefined) delete process.env["GIT_DIR"];
    else process.env["GIT_DIR"] = saved;
  }
});
