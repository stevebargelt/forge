// FG-677 (g): scale + fixpoint. At least 50 workspaces/branches and at least 36 publication
// attempts complete with bounded work and reach a fixpoint on the second pass.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, updateRunStatus } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { recordPublicationIntent, updatePublicationAttempt } from "../store/publications.js";
import { disposeRunGitWorkspaces } from "./reconcile.js";
import { sweepPublicationWorktrees } from "./integration-publisher.js";
import { worktreeBranchName } from "./worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir, PUBLICATIONS_DIR, publicationWorktreeDir } from "../util/paths.js";
import type { Run, Task } from "../types/index.js";
import type { CwdHolderResult } from "./launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const RUN_ID = "run-fg677scale";
const NEVER_HELD = (): CwdHolderResult => ({ held: false });
const NO_CONTAINER = (): boolean => false;

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function tmpDir(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }
function initRepo(dir: string): void {
  git(dir, "init", "-b", "main"); git(dir, "config", "user.email", "t@forge.test"); git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# repo\n"); git(dir, "add", "."); git(dir, "commit", "-m", "initial");
}

beforeEach(() => {
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  delete process.env.FORGE_WORKTREES_EPHEMERAL;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  try { rmSync(join(WORKTREES_DIR, RUN_ID), { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(PUBLICATIONS_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  for (const d of tmpDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

test("FG-677 scale: 50 clean workspaces/branches + 40 published worktrees reclaim and reach a 2nd-pass fixpoint", () => {
  const projectDir = tmpDir("fg677-scale-proj-");
  initRepo(projectDir);
  insertRun({ id: RUN_ID, workflow: "invoke", title: "scale", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
  updateRunStatus(RUN_ID, "complete");
  mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });

  const N_WS = 50;
  const wtPaths: string[] = [];
  for (let i = 0; i < N_WS; i++) {
    const taskId = `task-${i}`;
    const wtPath = worktreeDir(RUN_ID, taskId);
    git(projectDir, "worktree", "add", wtPath, "-b", worktreeBranchName(RUN_ID, taskId));
    insertTask({ id: taskId, runId: RUN_ID, phase: "task", agentRole: "engineer", status: "complete", taskPackage: { taskId, runId: RUN_ID, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" }, createdAt: "2026-08-01T00:00:00Z", worktreePath: wtPath } as Task);
    wtPaths.push(wtPath);
  }

  mkdirSync(PUBLICATIONS_DIR, { recursive: true });
  const N_PUB = 40;
  const pubDirs: string[] = [];
  for (let i = 0; i < N_PUB; i++) {
    const id = `att-${i}`;
    recordPublicationIntent({ attemptId: id, projectKey: "proj", canonicalDir: projectDir, runId: RUN_ID, taskId: `task-${i}`, target: "local", leaseTtlMs: 60_000 });
    updatePublicationAttempt(id, { state: "published", worktreePath: publicationWorktreeDir(id, 0), rebuildCount: 0 });
    const dir = publicationWorktreeDir(id, 0);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    pubDirs.push(dir);
  }

  // ── First pass: everything disposable is reclaimed.
  const g1 = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  const p1 = sweepPublicationWorktrees({ cwdGuard: NEVER_HELD });

  assert.equal(g1.gitWorkspaces.filter((d) => d.action === "removed").length, N_WS, "all 50 workspaces removed");
  assert.equal(g1.generatedBranches.filter((d) => d.action === "removed").length, N_WS, "all 50 branches removed");
  assert.equal(p1.publicationWorktrees.filter((d) => d.action === "removed").length, N_PUB, "all 40 publication worktrees reclaimed");
  for (const w of wtPaths) assert.ok(!existsSync(w));
  for (const d of pubDirs) assert.ok(!existsSync(d));
  // No branches linger.
  const branches = execFileSync("git", ["branch", "--list", "forge/*"], { cwd: projectDir, encoding: "utf8" }).trim();
  assert.equal(branches, "", "no forge/* branches remain");

  // ── Second pass: a no-op fixpoint with bounded work.
  const g2 = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  const p2 = sweepPublicationWorktrees({ cwdGuard: NEVER_HELD });
  assert.equal(g2.gitWorkspaces.filter((d) => d.action === "removed").length, 0, "git fixpoint: nothing more to remove");
  assert.equal(p2.publicationWorktrees.length, 0, "publication fixpoint: no dirs left to reconcile");
  // The publications keyspace is empty on disk.
  assert.equal(readdirSync(PUBLICATIONS_DIR).length, 0);
});
