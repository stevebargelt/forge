// FG-685 — a commit carrying AI attribution is REFUSED AT WRITE TIME in a
// Forge-provisioned workspace, proven by real `git commit` attempts.
//
// The FG-610 failure this closes: an agent commit landed carrying a
// Co-Authored-By trailer, reached the publish HEAD, and the only remedy — a
// history rewrite — orphaned the pipeline's task-branch lineage and failed the
// run tail. Enforcement existed, but only in the operator's primary checkout,
// which is the one place almost nothing commits.
//
// Every assertion here is BEHAVIORAL. Inspecting the provisioning code proves
// nothing about this: a hook can be present on the host and still never run
// (a symlink into an unmounted path, a stripped mode bit, a core.hooksPath
// override), and every one of those degrades to "no hook" with no diagnostic.
//
// Nothing here goes through isWorktreeModeEnabled/preflightWorktreeGate: that
// gate hard-fails on Linux by decision, and this tier runs on ubuntu-latest, so
// routing through it would mean these proofs never execute where they are
// checked. The provisioning primitives themselves are platform-agnostic and they
// are what is under test.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  executeWorkspaceCommitMsgHook,
  planWorkspaceCommitMsgHook,
} from "../util/commit-msg-hook.js";
import { captureTaskClone, createTaskClone, createWorktree } from "./worktree-lifecycle.js";

const RUN_ID = "run-fg685-hook";

/** The bundled hook located independently of the module under test. */
const BUNDLED = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "git-hooks",
  "commit-msg-no-ai-attribution"
);

/** The three variants the hook claims to refuse. Every one of them is exercised
 *  in every workspace kind — a single representative would leave two thirds of
 *  the policy unproven, and a GNU-vs-BSD regex divergence degrades to a false
 *  NEGATIVE, silently. */
const REFUSED_MESSAGES: ReadonlyArray<readonly [string, string]> = [
  [
    "co-authored-by trailer",
    "feat: add the widget\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n",
  ],
  ["generated-with boilerplate", "feat: add the widget\n\n🤖 Generated with Claude Code\n"],
  ["bare prose mention", "feat: add the widget\n\nThis change was pair-written with Claude.\n"],
];

/** The false-positive guard. Every one of these identifiers appears in ordinary
 *  forge commits and every one is whitelisted by the hook; a refusal here would
 *  block every agent commit, which is a worse failure than the one being fixed. */
const CLEAN_MESSAGE =
  "feat: wire the release pin through CLAUDE.md and the .claude/ config dir\n\n" +
  "Reads claude-opus-5 from @anthropic-ai/sdk and honors CLAUDE_CODE_USE_BEDROCK.\n" +
  "Run `claude` or --claude to check, or forge claude.\n";

const tmpDirs: string[] = [];
const workspaces: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg685-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): { dir: string; head: string } {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg685\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return { dir, head: git(dir, "rev-parse", "HEAD").trim() };
}

/** Git the way the AGENT's container runs it: no identity in the environment, no
 *  global file, no system file. A fixture that supplies its own identity proves
 *  only that the fixture can commit. */
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const k of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EMAIL",
    "GIT_CONFIG_COUNT",
  ]) {
    delete env[k];
  }
  return env;
}

/** Stage a change and ATTEMPT a real commit. Returns the exit status and the
 *  HEAD before/after, so a refusal is asserted on git's own behavior rather than
 *  on anything this test controls. */
function attemptCommit(
  workspace: string,
  file: string,
  message: string
): { status: number | null; stderr: string; headBefore: string; headAfter: string } {
  const headBefore = git(workspace, "rev-parse", "HEAD").trim();
  writeFileSync(join(workspace, file), `touched by ${file}\n`);
  spawnSync("git", ["add", "-A"], { cwd: workspace, env: agentEnv() });
  const r = spawnSync("git", ["commit", "-m", message], {
    cwd: workspace,
    env: agentEnv(),
    encoding: "utf8",
  });
  return {
    status: r.status,
    stderr: r.stderr ?? "",
    headBefore,
    headAfter: git(workspace, "rev-parse", "HEAD").trim(),
  };
}

/** Undo whatever a refused attempt staged, so the next variant starts clean. */
function resetWorkspace(workspace: string): void {
  git(workspace, "reset", "-q", "--hard", "HEAD");
  git(workspace, "clean", "-qfd");
}

function assertRefusesEveryVariant(workspace: string, label: string): void {
  for (const [variant, message] of REFUSED_MESSAGES) {
    const attempt = attemptCommit(workspace, `${variant.replace(/[^a-z]+/g, "-")}.txt`, message);
    assert.notEqual(attempt.status, 0, `${label}: "${variant}" must be REFUSED at write time, not flagged later`);
    assert.equal(
      attempt.headAfter,
      attempt.headBefore,
      `${label}: "${variant}" moved HEAD — the commit was written despite the hook`
    );
    resetWorkspace(workspace);
  }
}

function assertCleanMessageCommits(workspace: string, label: string): void {
  const attempt = attemptCommit(workspace, "clean-control.txt", CLEAN_MESSAGE);
  assert.equal(
    attempt.status,
    0,
    `${label}: the whitelisted-identifier control must COMMIT — a false positive blocks every agent commit.\n${attempt.stderr}`
  );
  assert.notEqual(attempt.headAfter, attempt.headBefore, `${label}: the control commit must move HEAD`);
}

/** The parent's shared state AC4 forbids this change from touching. A linked
 *  worktree's --local config IS the parent's shared config, so both halves
 *  matter. */
function parentSnapshot(repoDir: string): { hooks: string[]; config: string } {
  return {
    hooks: readdirSync(join(repoDir, ".git", "hooks")).sort(),
    config: readFileSync(join(repoDir, ".git", "config"), "utf8"),
  };
}

afterEach(() => {
  for (const dir of workspaces.splice(0).concat(tmpDirs.splice(0))) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── The private clone: the one Forge-PROVISIONED workspace an agent commits in ─

test("fg685 (AC1/AC2, clone): every AI-attribution variant is refused by a real commit in a createTaskClone workspace", () => {
  const repo = makeRepo();
  const clone = createTaskClone(repo.dir, RUN_ID, "t-clone-refuse", repo.head);
  workspaces.push(clone.clonePath);

  assertRefusesEveryVariant(clone.clonePath, "private clone");
  assertCleanMessageCommits(clone.clonePath, "private clone");
});

test("fg685 (D3, clone): the installed hook is SELF-CONTAINED and sits where git actually looks", () => {
  const repo = makeRepo();
  const clone = createTaskClone(repo.dir, RUN_ID, "t-clone-shape", repo.head);
  workspaces.push(clone.clonePath);

  const target = join(clone.clonePath, ".git", "hooks", "commit-msg");
  const st = lstatSync(target);
  assert.equal(st.isSymbolicLink(), false, "a symlink to a host path dangles inside the agent container");
  assert.equal(st.isFile(), true);
  assert.ok(statSync(target).mode & 0o111, "a non-executable hook is one git silently never runs");

  const bytes = readFileSync(target);
  assert.ok(bytes.equals(readFileSync(BUNDLED)), "byte-identical to scripts/git-hooks/commit-msg-no-ai-attribution");
  const text = bytes.toString("utf8");
  assert.equal(text.includes("FORGE_HOME"), false, "the container has no $FORGE_HOME");
  assert.equal(text.includes(dirname(BUNDLED)), false, "no host path may reach the container");

  // `git rev-parse --git-path hooks` honors core.hooksPath, so this is what
  // proves the file is at the directory git will CONSULT, not merely at the
  // conventional one.
  const effective = resolve(
    clone.clonePath,
    git(clone.clonePath, "rev-parse", "--git-path", "hooks").trim()
  );
  assert.equal(effective, dirname(target));
});

test("fg685 (AC3, clone): re-running the installer over a provisioned clone is a byte-identical no-op that still refuses", () => {
  const repo = makeRepo();
  const clone = createTaskClone(repo.dir, RUN_ID, "t-clone-idempotent", repo.head);
  workspaces.push(clone.clonePath);

  const target = join(clone.clonePath, ".git", "hooks", "commit-msg");
  const before = readFileSync(target);
  const modeBefore = statSync(target).mode;

  const plan = planWorkspaceCommitMsgHook(clone.clonePath);
  assert.equal(plan.action, "already-installed");
  executeWorkspaceCommitMsgHook(plan);

  assert.ok(readFileSync(target).equals(before));
  assert.equal(statSync(target).mode, modeBefore);
  assertRefusesEveryVariant(clone.clonePath, "re-provisioned clone");
});

test("fg685 (D2, clone): Forge's capture safety commit is EXEMPT — it succeeds against a hook that always fails", () => {
  const repo = makeRepo();
  const clone = createTaskClone(repo.dir, RUN_ID, "t-clone-capture", repo.head);
  workspaces.push(clone.clonePath);

  // The strongest form of the exemption: not "this message passes the hook" but
  // "no hook can fail this commit". A capture that dies on message content
  // aborts BEFORE the branch is fetched into the parent — it loses the agent's
  // work outright.
  writeFileSync(join(clone.clonePath, ".git", "hooks", "commit-msg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(clone.clonePath, "agent-output.txt"), "work the agent left behind\n");

  const captured = captureTaskClone(repo.dir, clone.clonePath, RUN_ID, "t-clone-capture");
  assert.equal(captured.ok, true, `capture must not be blockable by a commit-msg hook: ${JSON.stringify(captured)}`);
  assert.equal(captured.ok === true && captured.safetyCommitted, true);
  assert.equal(
    git(repo.dir, "rev-parse", `refs/heads/${clone.branch}`).trim(),
    captured.ok === true ? captured.commit : "",
    "the agent's work reached the parent ref"
  );
});

test("fg685 (AC4, clone): createTaskClone leaves the parent checkout's hooks dir and config untouched", () => {
  const repo = makeRepo();
  const before = parentSnapshot(repo.dir);

  const clone = createTaskClone(repo.dir, RUN_ID, "t-clone-ac4", repo.head);
  workspaces.push(clone.clonePath);

  const after = parentSnapshot(repo.dir);
  assert.deepEqual(after.hooks, before.hooks, "no hook was written into the operator's own repository");
  assert.equal(after.config, before.config, "and its shared config is byte-identical");
});

// ── The linked worktree: nothing is provisioned there, and AC1/AC2 still hold ──

test("fg685 (AC1/AC2/D1, worktree): a createWorktree workspace inherits the parent's hook and refuses every variant", () => {
  const repo = makeRepo();
  // What `forge init` does for an operator, stated as the fixture's precondition
  // rather than as something this change performs: the hook lives in the PARENT.
  executeWorkspaceCommitMsgHook(planWorkspaceCommitMsgHook(repo.dir));

  const before = parentSnapshot(repo.dir);
  const created = createWorktree(repo.dir, RUN_ID, "t-worktree-refuse");
  workspaces.push(created.worktreePath);

  assertRefusesEveryVariant(created.worktreePath, "linked worktree");
  assertCleanMessageCommits(created.worktreePath, "linked worktree");

  const after = parentSnapshot(repo.dir);
  assert.deepEqual(after.hooks, before.hooks, "createWorktree writes nothing into the parent's SHARED hooks dir");
  assert.equal(after.config, before.config, "nor into its shared config (a worktree's --local config IS this file)");
});
