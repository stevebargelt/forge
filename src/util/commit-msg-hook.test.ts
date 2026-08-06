// FG-685 — the WORKSPACE commit-msg hook installer, without git.
//
// The properties here are the ones a real commit cannot show you: that the
// artifact is a self-contained regular file rather than a link out to a host
// path (which dangles inside the agent container and degrades to "no hook" with
// no diagnostic), that a second install is a byte-identical no-op, and that a
// hook Forge does not own is never clobbered. Refusal itself is proven by real
// commits in src/v2/fg685-commit-hook-enforcement.worktree.test.ts.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  CommitMsgHookUnenforceableError,
  assertWorkspaceHookEnforceable,
  executeWorkspaceCommitMsgHook,
  planWorkspaceCommitMsgHook,
} from "./commit-msg-hook.js";

/** The bundled hook located INDEPENDENTLY of the module under test — comparing
 *  the installed bytes against resolveHookSource() alone would pass even if the
 *  resolver walked to the wrong file. */
const BUNDLED = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "git-hooks",
  "commit-msg-no-ai-attribution"
);

const tmpDirs: string[] = [];

/** A directory shaped like a workspace with its OWN repository: a real `.git`
 *  DIRECTORY. The installer only ever writes through one of these. */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg685-ws-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

function hookPath(workspace: string): string {
  return join(workspace, ".git", "hooks", "commit-msg");
}

function install(workspace: string): string {
  return executeWorkspaceCommitMsgHook(planWorkspaceCommitMsgHook(workspace));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("fg685: a fresh workspace gets the bundled hook as an executable regular file", () => {
  const ws = makeWorkspace();

  const plan = planWorkspaceCommitMsgHook(ws);
  assert.equal(plan.action, "install");
  assert.match(install(ws), /^installed /);

  const st = lstatSync(hookPath(ws));
  assert.equal(st.isSymbolicLink(), false, "a symlink dangles inside the agent container — never a link");
  assert.equal(st.isFile(), true);
  assert.ok(st.mode & 0o111, `hook must be executable, got mode ${(st.mode & 0o777).toString(8)}`);
  assert.ok(readFileSync(hookPath(ws)).equals(readFileSync(BUNDLED)), "byte-identical to the bundled hook");
});

test("fg685: the materialized hook is SELF-CONTAINED — no host path, no FORGE_HOME", () => {
  const ws = makeWorkspace();
  install(ws);

  const bytes = readFileSync(hookPath(ws), "utf8");
  assert.equal(bytes.includes("FORGE_HOME"), false, "the agent container has no $FORGE_HOME");
  assert.equal(bytes.includes(tmpdir()), false);
  assert.equal(bytes.includes("/Users/"), false, "no operator host path may reach the container");
  assert.equal(
    bytes.includes(dirname(BUNDLED)),
    false,
    "no absolute path back into the checkout the hook was copied from"
  );
});

test("fg685 (AC3): a second install is an idempotent, byte-identical no-op", () => {
  const ws = makeWorkspace();
  install(ws);
  const first = readFileSync(hookPath(ws));
  const firstMode = statSync(hookPath(ws)).mode;

  const plan = planWorkspaceCommitMsgHook(ws);
  assert.equal(plan.action, "already-installed");
  assert.equal(executeWorkspaceCommitMsgHook(plan), "already installed (no change)");

  assert.ok(readFileSync(hookPath(ws)).equals(first));
  assert.equal(statSync(hookPath(ws)).mode, firstMode);
});

test("fg685 (AC3): a foreign regular-file hook is refused, never overwritten", () => {
  const ws = makeWorkspace();
  const foreign = "#!/bin/sh\necho someone-elses-hook\n";
  writeFileSync(hookPath(ws), foreign);

  const plan = planWorkspaceCommitMsgHook(ws);
  assert.equal(plan.action, "exists-other");
  assert.match(executeWorkspaceCommitMsgHook(plan), /SKIPPED/);
  assert.equal(readFileSync(hookPath(ws), "utf8"), foreign);
});

test("fg685 (AC3): a symlink at the target is refused — including one pointing AT the bundled hook", () => {
  const ws = makeWorkspace();
  // The operator's own installer (init.ts) installs exactly this shape. Content
  // ownership cannot classify it, and clobbering it would violate AC4, so it is
  // left alone even though its bytes resolve to the same script.
  symlinkSync(BUNDLED, hookPath(ws));

  const plan = planWorkspaceCommitMsgHook(ws);
  assert.equal(plan.action, "exists-other");
  assert.match(executeWorkspaceCommitMsgHook(plan), /SKIPPED/);
  assert.equal(lstatSync(hookPath(ws)).isSymbolicLink(), true, "the operator's link survives untouched");
});

test("fg685: a target that CHANGES between plan and execute is skipped, not overwritten", () => {
  const ws = makeWorkspace();
  const plan = planWorkspaceCommitMsgHook(ws);
  assert.equal(plan.action, "install");

  const foreign = "#!/bin/sh\necho landed-after-the-plan\n";
  writeFileSync(hookPath(ws), foreign);

  assert.equal(executeWorkspaceCommitMsgHook(plan), "skipped — changed since plan");
  assert.equal(readFileSync(hookPath(ws), "utf8"), foreign);
});

test("fg685: a stripped executable bit is REPAIRED — content ownership makes it ours to fix", () => {
  const ws = makeWorkspace();
  install(ws);
  chmodSync(hookPath(ws), 0o644);

  const plan = planWorkspaceCommitMsgHook(ws);
  assert.equal(plan.action, "install", "a mode-0644 commit-msg is a hook git silently never runs");
  install(ws);
  assert.ok(statSync(hookPath(ws)).mode & 0o111);
});

test("fg685 (AC4/D1): a workspace whose .git is a FILE is never written through — that is the parent's shared hooks dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg685-linked-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, ".git"), "gitdir: /somewhere/else/.git/worktrees/w\n");

  const plan = planWorkspaceCommitMsgHook(dir);
  assert.equal(plan.action, "not-a-git-repo");
  assert.match(executeWorkspaceCommitMsgHook(plan), /skipped/);
});

test("fg685: assertWorkspaceHookEnforceable REFUSES a workspace whose hook is absent, a symlink, or non-executable", () => {
  const absent = makeWorkspace();
  assert.throws(
    () => assertWorkspaceHookEnforceable(absent),
    (e: unknown) =>
      e instanceof CommitMsgHookUnenforceableError && e.reason === "commit_msg_hook_unenforceable"
  );

  const linked = makeWorkspace();
  symlinkSync(BUNDLED, hookPath(linked));
  assert.throws(() => assertWorkspaceHookEnforceable(linked), /symlink/);

  const unarmed = makeWorkspace();
  install(unarmed);
  chmodSync(hookPath(unarmed), 0o644);
  assert.throws(() => assertWorkspaceHookEnforceable(unarmed), /not executable/);

  const foreign = makeWorkspace();
  writeFileSync(hookPath(foreign), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.throws(() => assertWorkspaceHookEnforceable(foreign), /not the bundled no-AI-attribution hook/);
});
