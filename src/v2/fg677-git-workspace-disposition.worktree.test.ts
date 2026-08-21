// FG-677 (c): git-workspace + generated-branch disposition through the EXISTING
// reapTaskWorkspace proof stack, hardened with the two added fail-closed liveness gates
// (active-process cwd, active container mount). Real git worktrees + an in-memory store.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, updateRunStatus } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import type { Run, Task } from "../types/index.js";
import { disposeRunGitWorkspaces } from "./reconcile.js";
import { worktreeBranchName } from "./worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir } from "../util/paths.js";
import type { CwdHolderResult } from "./launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const RUN_ID = "run-fg677gw";

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
}

/** A terminal run + a terminal task with a real linked worktree at worktreeDir(). */
function setupWorktreeTask(projectDir: string, taskId: string): string {
  const run: Run = { id: RUN_ID, workflow: "invoke", title: "fg677", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run;
  insertRun(run);
  updateRunStatus(RUN_ID, "complete");
  const wtPath = worktreeDir(RUN_ID, taskId);
  const branch = worktreeBranchName(RUN_ID, taskId);
  mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });
  git(projectDir, "worktree", "add", wtPath, "-b", branch);
  const task: Task = {
    id: taskId, runId: RUN_ID, phase: "task", agentRole: "engineer", status: "complete",
    taskPackage: { taskId, runId: RUN_ID, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-08-01T00:00:00Z", worktreePath: wtPath,
  };
  insertTask(task);
  return wtPath;
}

const NEVER_HELD = (): CwdHolderResult => ({ held: false });
const NO_CONTAINER = (): boolean => false;

beforeEach(() => {
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  delete process.env.FORGE_WORKTREES_EPHEMERAL;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  try { rmSync(join(WORKTREES_DIR, RUN_ID), { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("FG-677 git-workspace: a clean, captured linked worktree is REMOVED with its generated branch", () => {
  const projectDir = makeTmpDir("fg677-proj-");
  initRepo(projectDir);
  const wtPath = setupWorktreeTask(projectDir, "task-clean");
  assert.ok(existsSync(wtPath));

  const res = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });

  assert.ok(!existsSync(wtPath), "the workspace directory is removed");
  assert.equal(res.gitWorkspaces.filter((d) => d.action === "removed").length, 1);
  assert.ok(res.retiredWorkspaces.includes(wtPath));
  assert.equal(res.generatedBranches.filter((d) => d.action === "removed").length, 1);
  const branches = execFileSync("git", ["branch", "--list", worktreeBranchName(RUN_ID, "task-clean")], { cwd: projectDir, encoding: "utf8" });
  assert.equal(branches.trim(), "", "the generated branch is deleted");
  // A durable reap event is recorded.
  assert.ok(eventsForTask("task-clean").some((e) => e.eventType === "task.workspace_reaped"));
});

test("FG-677 git-workspace: a DIRTY worktree is RETAINED as uncommitted_work, path named, tree untouched", () => {
  const projectDir = makeTmpDir("fg677-proj-");
  initRepo(projectDir);
  const wtPath = setupWorktreeTask(projectDir, "task-dirty");
  writeFileSync(join(wtPath, "scratch.txt"), "uncommitted work"); // untracked → dirty

  const res = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });

  assert.ok(existsSync(wtPath), "the dirty workspace is preserved");
  const retained = res.gitWorkspaces.find((d) => d.action === "retained");
  assert.ok(retained);
  assert.equal(retained!.reason, "uncommitted_work");
  assert.equal(retained!.path, wtPath);
  assert.ok(retained!.recovery && retained!.recovery.length > 0);
});

test("FG-677 git-workspace: a workspace held by a LIVE PROCESS cwd is RETAINED as active_process_cwd, holder named", () => {
  const projectDir = makeTmpDir("fg677-proj-");
  initRepo(projectDir);
  const wtPath = setupWorktreeTask(projectDir, "task-held");
  const heldGuard = (): CwdHolderResult => ({ held: true, holders: [{ pid: 4242, description: "tmux server pid 4242", cwd: wtPath }] });

  const res = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: heldGuard, containerAlive: NO_CONTAINER });

  assert.ok(existsSync(wtPath), "a live-process-held workspace is never deleted");
  const retained = res.gitWorkspaces.find((d) => d.action === "retained");
  assert.equal(retained!.reason, "active_process_cwd");
  assert.match(retained!.holder ?? "", /tmux server pid 4242/);
});

test("FG-677 git-workspace: an UNPROBED cwd guard fails closed — RETAINED active_process_cwd", () => {
  const projectDir = makeTmpDir("fg677-proj-");
  initRepo(projectDir);
  const wtPath = setupWorktreeTask(projectDir, "task-unprobed");
  const unprobed = (): CwdHolderResult => ({ held: "unprobed", reason: "tmux could not enumerate its panes/server" });

  const res = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: unprobed, containerAlive: NO_CONTAINER });

  assert.ok(existsSync(wtPath), "an unprobeable cwd retains, never deletes");
  assert.equal(res.gitWorkspaces.find((d) => d.action === "retained")!.reason, "active_process_cwd");
});

test("FG-677 git-workspace: a workspace whose container is still ALIVE is RETAINED as active_mount (never tasks.status)", () => {
  const projectDir = makeTmpDir("fg677-proj-");
  initRepo(projectDir);
  const wtPath = setupWorktreeTask(projectDir, "task-mounted");
  const alive = (name: string): boolean => name === "forge-task-mounted";

  const res = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: alive });

  assert.ok(existsSync(wtPath), "a mounted-but-terminal workspace is preserved");
  const retained = res.gitWorkspaces.find((d) => d.action === "retained");
  assert.equal(retained!.reason, "active_mount");
  assert.match(retained!.holder ?? "", /forge-task-mounted/);
});

test("FG-677 git-workspace: DRY-RUN performs no mutation and its proposal matches the real pass", () => {
  const projectDir = makeTmpDir("fg677-proj-");
  initRepo(projectDir);
  const wtPath = setupWorktreeTask(projectDir, "task-dry");

  const dry = disposeRunGitWorkspaces(RUN_ID, { dryRun: true, cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  assert.ok(existsSync(wtPath), "dry-run mutates nothing");
  assert.equal(dry.gitWorkspaces[0]!.action, "removed");
  assert.equal(dry.gitWorkspaces[0]!.dryRun, true);
  assert.equal(eventsForTask("task-dry").length, 0, "dry-run records no durable event");

  const real = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  assert.ok(!existsSync(wtPath), "the real pass removes exactly what the dry run proposed");
  assert.equal(real.gitWorkspaces[0]!.action, "removed");
  // Same disposition (removed) and same path in both passes.
  assert.equal(dry.gitWorkspaces[0]!.path, real.gitWorkspaces[0]!.path);
});

test("FG-677 git-workspace: idempotent — a second pass after removal converges to no-op", () => {
  const projectDir = makeTmpDir("fg677-proj-");
  initRepo(projectDir);
  const wtPath = setupWorktreeTask(projectDir, "task-idem");

  disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  assert.ok(!existsSync(wtPath));
  const second = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  // Nothing left to remove; the workspace is absent, so no new disposition and no new event.
  assert.equal(second.gitWorkspaces.length, 0);
  assert.equal(second.retiredWorkspaces.length, 0);
});
