// FG-677 (g): crash-safety / idempotency. The closeout's three convergence models are
// crash-safe STRUCTURALLY — "gone on disk = done", with no separate ledger to keep
// consistent — so a kill at any write boundary (fs delete → git/branch & registry prune →
// durable record) converges truthfully on the next pass. This suite reproduces the
// post-crash state directly (a mutation applied, its record lost) and asserts the next pass
// reaches a fixpoint without error. That is exactly what a real kill at each boundary leaves.

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
import { recordPublicationIntent, updatePublicationAttempt } from "../store/publications.js";
import { writeReadinessRecord, pruneReadinessRecords, readinessRecordPath, type HostReadinessRecord } from "./host-readiness-store.js";
import { sweepPublicationWorktrees } from "./integration-publisher.js";
import { disposeRunGitWorkspaces } from "./reconcile.js";
import { worktreeBranchName } from "./worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir, PUBLICATIONS_DIR, publicationWorktreeDir, hostReadinessDir } from "../util/paths.js";
import type { Run, Task } from "../types/index.js";
import type { CwdHolderResult } from "./launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const RUN_ID = "run-fg677crash";
const NEVER_HELD = (): CwdHolderResult => ({ held: false });
const NO_CONTAINER = (): boolean => false;

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function tmpDir(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }
function initRepo(dir: string): void {
  git(dir, "init", "-b", "main"); git(dir, "config", "user.email", "t@forge.test"); git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# repo\n"); git(dir, "add", "."); git(dir, "commit", "-m", "initial");
}
function readinessRecord(workspace: string): HostReadinessRecord {
  return { workspace, treeSha: "abc", lockfileDigest: "sha256:x", nodeVersion: "24", abi: "137", state: "ready", setupCommand: "npm ci", coveredCommandSet: ["test"], assertedAt: new Date().toISOString() };
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
  try { rmSync(hostReadinessDir(), { recursive: true, force: true }); } catch { /* best-effort */ }
  for (const d of tmpDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

test("FG-677 crash: git-workspace — a kill after the fs delete before the durable record converges on the next pass", () => {
  const projectDir = tmpDir("fg677-crash-proj-");
  initRepo(projectDir);
  insertRun({ id: RUN_ID, workflow: "invoke", title: "crash", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
  updateRunStatus(RUN_ID, "complete");
  const wtPath = worktreeDir(RUN_ID, "task-c");
  const branch = worktreeBranchName(RUN_ID, "task-c");
  mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });
  git(projectDir, "worktree", "add", wtPath, "-b", branch);
  insertTask({ id: "task-c", runId: RUN_ID, phase: "task", agentRole: "engineer", status: "complete", taskPackage: { taskId: "task-c", runId: RUN_ID, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" }, createdAt: "2026-08-01T00:00:00Z", worktreePath: wtPath } as Task);

  // Reproduce the post-crash state: the fs delete (and its git registration prune) happened,
  // but the process died before recording the disposition. There is no reap event.
  git(projectDir, "worktree", "remove", "--force", wtPath);
  assert.ok(!existsSync(wtPath));
  assert.equal(eventsForTask("task-c").filter((e) => e.eventType === "task.workspace_reaped").length, 0, "no durable record survived the crash");

  // The next pass converges from disk truth (absent workspace) with no throw, and retries
  // the branch cleanup on the same capture warrant.
  const first = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  assert.ok(!existsSync(wtPath));
  const branchList = execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" }).trim();
  assert.equal(branchList, "", "the stranded branch is cleaned up on the recovering pass");

  // Fixpoint: a further pass is a no-op.
  const second = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: NEVER_HELD, containerAlive: NO_CONTAINER });
  assert.equal(first.gitWorkspaces.filter((d) => d.action === "removed").length, 0, "the tree was already gone — no double removal");
  assert.equal(second.gitWorkspaces.length, 0, "second pass is a no-op fixpoint");
});

test("FG-677 crash: publication — a kill after the worktree removal converges on the next pass (gone on disk = done)", () => {
  mkdirSync(PUBLICATIONS_DIR, { recursive: true });
  recordPublicationIntent({ attemptId: "att-c", projectKey: "proj", canonicalDir: tmpDir("fg677-crash-cd-"), runId: RUN_ID, taskId: "t", target: "local", leaseTtlMs: 60_000 });
  updatePublicationAttempt("att-c", { state: "published", worktreePath: publicationWorktreeDir("att-c", 0), rebuildCount: 0 });
  const pubDir = publicationWorktreeDir("att-c", 0);
  mkdirSync(join(pubDir, "node_modules"), { recursive: true });

  // Reproduce the post-crash state: the dir was removed, the process died before assembling
  // the report. The attempt row still says published.
  rmSync(pubDir, { recursive: true, force: true });

  const first = sweepPublicationWorktrees({ cwdGuard: NEVER_HELD });
  assert.ok(!existsSync(pubDir));
  const second = sweepPublicationWorktrees({ cwdGuard: NEVER_HELD });
  assert.equal(first.publicationWorktrees.length, 0, "the dir was already gone — nothing to reconcile");
  assert.equal(second.publicationWorktrees.length, 0, "second pass is a no-op fixpoint");
});

test("FG-677 crash: readiness — a kill after the record unlink converges on the next pass", () => {
  mkdirSync(hostReadinessDir(), { recursive: true });
  const ws = "/w/publications/att-c-r0";
  writeReadinessRecord(readinessRecord(ws));

  // Reproduce the post-crash state: the record file was unlinked before the report was built.
  rmSync(readinessRecordPath(ws), { force: true });

  const first = pruneReadinessRecords({ workspaceRetired: () => true });
  assert.ok(!existsSync(readinessRecordPath(ws)));
  const second = pruneReadinessRecords({ workspaceRetired: () => true });
  assert.equal(first.readinessRecords.length, 0, "the record was already gone — nothing to prune");
  assert.equal(second.readinessRecords.length, 0, "second pass is a no-op fixpoint");
});
