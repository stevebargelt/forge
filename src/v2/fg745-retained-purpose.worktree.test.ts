// FG-745 (AC6): a workspace RECONCILE retains carries its FG-677 retention reason
// onto the durable workspace-purpose row — so "unique work / active process /
// ownership ambiguity" is representable WITHOUT the retained workspace becoming a
// top-level project. The reaper's removed-vs-retained decision is UNCHANGED; this
// only records why a retained workspace stayed.
//
// Real git repos + real `git worktree`, an in-memory store. Mirrors the FG-677
// git-workspace disposition harness.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, updateRunStatus } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import type { Run, Task } from "../types/index.js";
import { disposeRunGitWorkspaces } from "./reconcile.js";
import { worktreeBranchName, createWorktree } from "./worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir } from "../util/paths.js";
import { getWorkspacePurpose } from "../store/workspace-purpose.js";
import { retainedWorkspacePurposeUpdate, retainedDisposition, removedDisposition } from "./run-cleanup-report.js";
import type { CwdHolderResult } from "./launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const RUN_ID = "run-fg745rp";

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

/** A terminal run + terminal task with a linked worktree. When `viaCreate`, the
 *  worktree is made through createWorktree so a 'worktree' purpose is recorded at
 *  creation; otherwise a bare `git worktree add` leaves nothing recorded. */
function setupWorktreeTask(projectDir: string, taskId: string, viaCreate: boolean): string {
  const run: Run = { id: RUN_ID, workflow: "invoke", title: "fg745", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run;
  insertRun(run);
  updateRunStatus(RUN_ID, "complete");
  let wtPath: string;
  if (viaCreate) {
    wtPath = createWorktree(projectDir, RUN_ID, taskId).worktreePath;
  } else {
    wtPath = worktreeDir(RUN_ID, taskId);
    mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });
    git(projectDir, "worktree", "add", wtPath, "-b", worktreeBranchName(RUN_ID, taskId));
  }
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

describe("FG-745 retention reason bridge (pure)", () => {
  test("only a RETAINED git_workspace with a reason produces an update", () => {
    assert.deepEqual(
      retainedWorkspacePurposeUpdate(retainedDisposition("git_workspace", "/w", "active_process_cwd")),
      { path: "/w", reason: "active_process_cwd" },
    );
    assert.equal(retainedWorkspacePurposeUpdate(removedDisposition("git_workspace", "/w")), undefined);
    assert.equal(
      retainedWorkspacePurposeUpdate(retainedDisposition("generated_branch", "forge/x", "branch_uncaptured")),
      undefined,
      "a non-git-workspace resource is not a workspace-purpose row",
    );
  });
});

describe("FG-745 reconcile persists the retention reason (AC6)", () => {
  test("a live-process-held workspace records active_process_cwd without becoming classified", () => {
    const projectDir = makeTmpDir("fg745rp-proj-");
    initRepo(projectDir);
    const wtPath = setupWorktreeTask(projectDir, "task-held", false);
    const heldGuard = (): CwdHolderResult => ({ held: true, holders: [{ pid: 4242, description: "tmux server pid 4242", cwd: wtPath }] });

    const res = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: heldGuard, containerAlive: NO_CONTAINER });

    assert.ok(existsSync(wtPath), "a held workspace is never deleted — the decision is unchanged");
    assert.equal(res.gitWorkspaces.find((d) => d.action === "retained")?.reason, "active_process_cwd");
    const purpose = getWorkspacePurpose(wtPath);
    assert.ok(purpose, "a purpose row now carries the retention reason");
    assert.equal(purpose.reason, "active_process_cwd");
    assert.equal(purpose.kind, "unclassified", "a workspace nothing declared stays unclassified/visible, + a reason");
  });

  test("a retained worktree recorded at creation keeps its 'worktree' kind while gaining the reason", () => {
    const projectDir = makeTmpDir("fg745rp-proj-");
    initRepo(projectDir);
    const wtPath = setupWorktreeTask(projectDir, "task-created", true);
    assert.equal(getWorkspacePurpose(wtPath)?.kind, "worktree", "createWorktree recorded the kind");
    // Make it dirty so the reaper retains it (uncommitted_work).
    writeFileSync(join(wtPath, "scratch.txt"), "uncommitted");

    disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });

    const purpose = getWorkspacePurpose(wtPath);
    assert.equal(purpose?.kind, "worktree", "the recorded artifact kind is never clobbered by retention");
    assert.equal(purpose?.reason, "uncommitted_work");
  });

  test("a DRY RUN persists no retention reason", () => {
    const projectDir = makeTmpDir("fg745rp-proj-");
    initRepo(projectDir);
    const wtPath = setupWorktreeTask(projectDir, "task-dry", false);
    writeFileSync(join(wtPath, "scratch.txt"), "uncommitted");

    disposeRunGitWorkspaces(RUN_ID, { dryRun: true, cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });

    assert.equal(getWorkspacePurpose(wtPath), undefined, "a dry run proposes, it does not mutate");
  });
});
