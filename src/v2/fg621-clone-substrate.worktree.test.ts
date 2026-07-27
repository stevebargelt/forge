// FG-621 — the private clone SUBSTRATE, over real git repositories.
//
// createTaskClone is what a mutating agent is handed instead of a linked
// worktree: its own repository at the recorded base SHA, on the deterministic
// private task branch, with the parent's objects reachable only through
// alternates. This file proves the properties the ticket buys with it —
// independent commit authority (AC 1), a create-only posture, and a base that is
// an ASSERTED recorded fact rather than wherever HEAD happened to be (AC 4).
//
// Nothing here goes through preflightWorktreeGate: that gate hard-fails on Linux
// by decision (FG-358 owns Linux worktrees, and FG-621 explicitly does not smuggle
// it in). What the gate refuses is the DISPATCH path; the constructor itself is
// platform-agnostic, and it is the constructor under test.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask, setTaskWorkspace } from "../store/tasks.js";
import { cloneDir, WORKTREES_DIR } from "../util/paths.js";
import {
  createTaskClone,
  cleanupFailedCloneSetup,
  classifyWorkspace,
  worktreeBranchName,
  TaskCloneExistsError,
  TaskCloneAnchorExistsError,
} from "./worktree-lifecycle.js";
import type { Run, Task } from "../types/index.js";

const RUN_ID = "run-fg621-substrate";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let forgeHomeBefore: string | undefined;

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg621-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A real repo with a two-commit history, so a test can name a base that is NOT
 *  HEAD and tell the difference. */
function makeRepo(): { dir: string; first: string; head: string } {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg621\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  const first = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "second.ts"), "export const second = true;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "second");
  return { dir, first, head: git(dir, "rev-parse", "HEAD").trim() };
}

function agentCommit(clonePath: string, file: string, body: string): string {
  writeFileSync(join(clonePath, file), body);
  git(clonePath, "add", ".");
  git(clonePath, "-c", "user.email=a@b.c", "-c", "user.name=Agent", "commit", "-q", "-m", `agent output ${file}`);
  return git(clonePath, "rev-parse", "HEAD").trim();
}

beforeEach(() => {
  forgeHomeBefore = process.env.FORGE_HOME;
  process.env.FORGE_HOME = tmpRoot("home");
  prev = null;
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  if (prev) setDbForTest(prev);
  if (forgeHomeBefore === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = forgeHomeBefore;
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── The substrate itself ──────────────────────────────────────────────────────

test("fg621: createTaskClone hands the agent its OWN repository at the recorded base, on the deterministic task branch", () => {
  const repo = makeRepo();
  const created = createTaskClone(repo.dir, RUN_ID, "t-one", repo.head);

  assert.equal(created.clonePath, cloneDir(RUN_ID, "t-one"));
  assert.ok(
    created.clonePath.startsWith(WORKTREES_DIR),
    "every forge workspace stays under one managed root (and inside Docker Desktop's macOS file-sharing allowlist)",
  );
  assert.notEqual(created.clonePath, join(WORKTREES_DIR, RUN_ID, "t-one"), "and never on a linked worktree's path");

  assert.equal(classifyWorkspace(created.clonePath), "private_clone");
  assert.equal(created.branch, worktreeBranchName(RUN_ID, "t-one"));
  assert.equal(created.baseSha, repo.head);
  assert.equal(git(created.clonePath, "rev-parse", "HEAD").trim(), repo.head, "checked out AT the base, asserted not assumed");
  assert.equal(
    git(created.clonePath, "symbolic-ref", "HEAD").trim(),
    `refs/heads/${worktreeBranchName(RUN_ID, "t-one")}`,
    "on the deterministic private task branch, never a detached HEAD",
  );

  // The parent's objects are reachable, and reachable ONLY through alternates —
  // that is what makes the parent's unwritability a property of the mount rather
  // than of git, and what the reaper's ownership proof reads.
  const alternates = readFileSync(join(created.clonePath, ".git", "objects", "info", "alternates"), "utf8").trim();
  assert.equal(realpathSync(alternates), realpathSync(join(repo.dir, ".git", "objects")));
  assert.match(git(created.clonePath, "log", "--oneline"), /initial/, "the full parent history reads through the alternate");
});

test("fg621 (AC 4): the base is the one PASSED IN, not wherever the parent's HEAD happens to be", () => {
  const repo = makeRepo();
  const created = createTaskClone(repo.dir, RUN_ID, "t-base", repo.first);

  assert.equal(created.baseSha, repo.first);
  assert.equal(git(created.clonePath, "rev-parse", "HEAD").trim(), repo.first);
  assert.equal(
    existsSync(join(created.clonePath, "second.ts")),
    false,
    "the agent sees the tree at the RECORDED base — a clone that silently used HEAD would carry this file",
  );
});

test("fg621 (AC 4): the recorded row carries BOTH the workspace path and the base, and survives a re-read", () => {
  const repo = makeRepo();
  const created = createTaskClone(repo.dir, RUN_ID, "t-record", repo.head);

  const run: Run = {
    id: RUN_ID,
    workflow: "invoke",
    title: "fg621 substrate",
    status: "active",
    createdAt: "2026-07-27T00:00:00Z",
    projectDir: repo.dir,
  };
  insertRun(run);
  const task: Task = {
    id: "t-record",
    runId: RUN_ID,
    phase: "build",
    agentRole: "engineer",
    status: "running",
    taskPackage: { taskId: "t-record", runId: RUN_ID, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-27T00:00:00Z",
  };
  insertTask(task);
  setTaskWorkspace("t-record", created.clonePath, created.baseSha);

  const read = getTask("t-record");
  assert.equal(read?.worktreePath, created.clonePath, "the path is recorded");
  assert.equal(read?.baseSha, repo.head, "and so is the base — AC 4 is asserted on RECORDED state, never inferred");
});

test("fg621: the parent gets an anchor ref at the base — the clone's alternates borrow an object store gc must not collect from", () => {
  const repo = makeRepo();
  createTaskClone(repo.dir, RUN_ID, "t-anchor", repo.first);

  assert.equal(
    git(repo.dir, "rev-parse", "--verify", worktreeBranchName(RUN_ID, "t-anchor")).trim(),
    repo.first,
    "the parent-side branch exists at the BASE from dispatch — the agent's commits are not in it yet",
  );
});

// ── AC 1: two mutating agents commit concurrently, in independent repositories ─

test("fg621 (AC 1): two clones of one parent commit independently — neither sees the other's work, and both sets survive", () => {
  const repo = makeRepo();
  const a = createTaskClone(repo.dir, RUN_ID, "t-a", repo.head);
  const b = createTaskClone(repo.dir, RUN_ID, "t-b", repo.head);

  const aSha = agentCommit(a.clonePath, "a-work.ts", "export const a = 1;\n");
  const bSha = agentCommit(b.clonePath, "b-work.ts", "export const b = 2;\n");

  assert.notEqual(aSha, bSha);
  assert.ok(existsSync(join(a.clonePath, "a-work.ts")));
  assert.equal(existsSync(join(a.clonePath, "b-work.ts")), false, "private means private — B's work is not in A's repository");
  assert.ok(existsSync(join(b.clonePath, "b-work.ts")));
  assert.equal(existsSync(join(b.clonePath, "a-work.ts")), false);

  // Each holds its own branch at its own tip — two ref namespaces, not one.
  assert.equal(git(a.clonePath, "rev-parse", worktreeBranchName(RUN_ID, "t-a")).trim(), aSha);
  assert.equal(git(b.clonePath, "rev-parse", worktreeBranchName(RUN_ID, "t-b")).trim(), bSha);

  // And neither commit reached the parent: publication authority is Forge's, and
  // an agent commit is an untrusted checkpoint until Forge captures it.
  assert.equal(git(repo.dir, "rev-parse", "HEAD").trim(), repo.head, "the parent's HEAD did not move");
  assert.equal(
    git(repo.dir, "rev-parse", worktreeBranchName(RUN_ID, "t-a")).trim(),
    repo.head,
    "and the parent's anchor ref still sits at the base until capture fetches the tip",
  );
});

// ── Create-only posture ───────────────────────────────────────────────────────

test("fg621: a re-dispatch into an EXISTING clone directory is REFUSED, and the refusal never deletes what it refused", () => {
  const repo = makeRepo();
  const first = createTaskClone(repo.dir, RUN_ID, "t-retry", repo.head);
  agentCommit(first.clonePath, "half-finished.ts", "export const wip = true;\n");
  writeFileSync(join(first.clonePath, "uncommitted.txt"), "the agent was mid-flight\n");

  assert.throws(
    () => createTaskClone(repo.dir, RUN_ID, "t-retry", repo.head),
    (e: unknown) => e instanceof TaskCloneExistsError && /already exists/.test((e as Error).message),
    "a workspace an agent may already have written to is never silently reused",
  );

  assert.ok(existsSync(join(first.clonePath, "half-finished.ts")), "the refusal is not a disposal");
  assert.ok(existsSync(join(first.clonePath, "uncommitted.txt")));
});

test("fg621: cleanupFailedCloneSetup removes a partially-created clone AND its parent anchor — the agent never ran", () => {
  const repo = makeRepo();
  const created = createTaskClone(repo.dir, RUN_ID, "t-setup-fail", repo.head);
  assert.ok(existsSync(created.clonePath));

  cleanupFailedCloneSetup(repo.dir, RUN_ID, "t-setup-fail");

  assert.equal(existsSync(created.clonePath), false);
  assert.throws(
    () => git(repo.dir, "rev-parse", "--verify", worktreeBranchName(RUN_ID, "t-setup-fail")),
    "the anchor goes with it — a ref pointing at nothing forge is working on is a leak",
  );
  assert.doesNotThrow(() => cleanupFailedCloneSetup(repo.dir, RUN_ID, "t-setup-fail"), "and it is idempotent");
});

test("fg621: an EXISTING parent-side ref is REFUSED, and neither the refusal nor the setup cleanup disposes of it", () => {
  const repo = makeRepo();
  const branch = worktreeBranchName(RUN_ID, "t-anchor-exists");

  // The shape a retry actually meets: a prior attempt captured work onto the
  // task's parent-side ref and its clone directory is gone (reaped, or removed by
  // hand). The ref is the ONLY durable record of that work left.
  createTaskClone(repo.dir, RUN_ID, "t-anchor-exists", repo.head);
  const captured = agentCommit(cloneDir(RUN_ID, "t-anchor-exists"), "prior-attempt.ts", "export const prior = true;\n");
  git(repo.dir, "fetch", "--quiet", cloneDir(RUN_ID, "t-anchor-exists"), `${branch}:refs/heads/${branch}`);
  rmSync(cloneDir(RUN_ID, "t-anchor-exists"), { recursive: true, force: true });
  assert.equal(git(repo.dir, "rev-parse", branch).trim(), captured, "fixture: the ref holds the prior attempt's work");

  assert.throws(
    () => createTaskClone(repo.dir, RUN_ID, "t-anchor-exists", repo.head),
    (e: unknown) => e instanceof TaskCloneAnchorExistsError,
    "a ref this attempt did not create is never reused and never overwritten",
  );
  assert.equal(
    git(repo.dir, "rev-parse", branch).trim(),
    captured,
    "and the refusal is not a disposal — the prior attempt's captured tip is still there",
  );
  assert.equal(existsSync(cloneDir(RUN_ID, "t-anchor-exists")), false, "nor did the refused attempt leave a workspace");
});

test("fg621: cleanupFailedCloneSetup disposes only of the anchor THIS attempt created", () => {
  const repo = makeRepo();
  const branch = worktreeBranchName(RUN_ID, "t-anchor-owned");

  // Nothing pre-exists: the anchor this attempt creates is this attempt's, so
  // cleanup may dispose of it.
  createTaskClone(repo.dir, RUN_ID, "t-anchor-owned", repo.head);
  cleanupFailedCloneSetup(repo.dir, RUN_ID, "t-anchor-owned");
  assert.throws(() => git(repo.dir, "rev-parse", "--verify", branch), "its own anchor goes with it");

  // And a ref that was never this attempt's is unreachable from that path at all:
  // createTaskClone refuses BEFORE creating anything, so the failure never routes
  // through cleanup. That ordering is what makes the `-D` above safe.
  git(repo.dir, "branch", branch, repo.first);
  assert.throws(
    () => createTaskClone(repo.dir, RUN_ID, "t-anchor-owned", repo.head),
    (e: unknown) => e instanceof TaskCloneAnchorExistsError,
  );
  assert.equal(git(repo.dir, "rev-parse", branch).trim(), repo.first, "the pre-existing ref is untouched");
});

test("fg621: an unresolvable base is refused at construction rather than producing a workspace on the wrong commit", () => {
  const repo = makeRepo();
  assert.throws(() => createTaskClone(repo.dir, RUN_ID, "t-bad-base", "0".repeat(40)));
  // Whatever partial state that left, the setup cleanup reclaims it.
  cleanupFailedCloneSetup(repo.dir, RUN_ID, "t-bad-base");
  assert.equal(existsSync(cloneDir(RUN_ID, "t-bad-base")), false);
});
