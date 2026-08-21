// FG-677 (g): the mixed fixture. In ONE pass, disposable artifacts are removed while
// unique / dirty / active-cwd / active-mount / ownership-ambiguous artifacts are preserved,
// each with the exact named reason.

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
import { recordPublicationIntent, updatePublicationAttempt } from "../store/publications.js";
import { writeReadinessRecord, pruneReadinessRecords, readinessRecordPath, type HostReadinessRecord } from "./host-readiness-store.js";
import { disposeRunGitWorkspaces } from "./reconcile.js";
import { sweepPublicationWorktrees } from "./integration-publisher.js";
import { worktreeBranchName } from "./worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir, PUBLICATIONS_DIR, publicationWorktreeDir, hostReadinessDir } from "../util/paths.js";
import type { Run, Task } from "../types/index.js";
import type { CwdHolderResult } from "./launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const RUN_ID = "run-fg677mixed";
const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function tmpDir(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }
function initRepo(dir: string): void {
  git(dir, "init", "-b", "main"); git(dir, "config", "user.email", "t@forge.test"); git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# repo\n"); git(dir, "add", "."); git(dir, "commit", "-m", "initial");
}
function readinessRecord(workspace: string): HostReadinessRecord {
  return { workspace, treeSha: "abc", lockfileDigest: "sha256:x", nodeVersion: "24", abi: "137", state: "ready", setupCommand: "npm ci", coveredCommandSet: ["test"], assertedAt: new Date().toISOString() };
}
function mkTask(projectDir: string, taskId: string, mutate?: (wtPath: string) => void): string {
  const wtPath = worktreeDir(RUN_ID, taskId);
  git(projectDir, "worktree", "add", wtPath, "-b", worktreeBranchName(RUN_ID, taskId));
  insertTask({ id: taskId, runId: RUN_ID, phase: "task", agentRole: "engineer", status: "complete", taskPackage: { taskId, runId: RUN_ID, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" }, createdAt: "2026-08-01T00:00:00Z", worktreePath: wtPath } as Task);
  mutate?.(wtPath);
  return wtPath;
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

test("FG-677 mixed: disposable artifacts removed while unique/dirty/active/ambiguous preserved — same pass, exact reasons", () => {
  const projectDir = tmpDir("fg677-mixed-proj-");
  initRepo(projectDir);
  insertRun({ id: RUN_ID, workflow: "invoke", title: "mixed", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
  updateRunStatus(RUN_ID, "complete");
  mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });

  // ── git workspaces ──
  const clean = mkTask(projectDir, "task-clean"); // disposable → removed
  const dirty = mkTask(projectDir, "task-dirty", (wt) => writeFileSync(join(wt, "scratch.txt"), "unique work")); // retained uncommitted_work
  const unique = mkTask(projectDir, "task-unique", (wt) => {
    // a committed-but-uncaptured commit on the task branch (HEAD advanced past projectDir)
    writeFileSync(join(wt, "feature.txt"), "unique feature\n");
    git(wt, "add", "."); git(wt, "-c", "user.email=a@b.c", "-c", "user.name=A", "commit", "-m", "unique work");
  }); // retained unmerged_commits
  const held = mkTask(projectDir, "task-held"); // retained active_process_cwd
  const mounted = mkTask(projectDir, "task-mounted"); // retained active_mount

  // ── publications ──
  mkdirSync(PUBLICATIONS_DIR, { recursive: true });
  const mkPub = (id: string, state: "published" | "failed", ageDays = 0): string => {
    recordPublicationIntent({ attemptId: id, projectKey: "proj", canonicalDir: projectDir, runId: RUN_ID, taskId: "t", target: "local", leaseTtlMs: 60_000 });
    updatePublicationAttempt(id, { state, worktreePath: publicationWorktreeDir(id, 0), rebuildCount: 0 });
    if (ageDays > 0) db.prepare("UPDATE publication_attempts SET updated_at = ? WHERE attempt_id = ?").run(new Date(Date.now() - ageDays * DAY_MS).toISOString(), id);
    const dir = publicationWorktreeDir(id, 0);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    return dir;
  };
  const pubPublished = mkPub("pub-ok", "published"); // removed
  const pubFreshFail = mkPub("pub-fresh", "failed"); // retained within_retention_for_investigation
  const pubOrphan = join(PUBLICATIONS_DIR, "orphan-x-r0"); mkdirSync(join(pubOrphan, "node_modules"), { recursive: true }); // ownership_ambiguous

  // ── readiness records ──
  mkdirSync(hostReadinessDir(), { recursive: true });
  writeReadinessRecord(readinessRecord(pubPublished)); // bound to reclaimed pub → pruned
  writeReadinessRecord(readinessRecord("/w/live/unrelated")); // retained ownership_ambiguous

  // Injected guards: held path is cwd-held; mounted task's container is alive.
  const cwdGuard = (p: string): CwdHolderResult => (p === held ? { held: true, holders: [{ pid: 99, description: "tmux server pid 99", cwd: held }] } : { held: false });
  const containerAlive = (name: string): boolean => name === "forge-task-mounted";

  // ── ONE pass ──
  const g = disposeRunGitWorkspaces(RUN_ID, { cwdGuard: (p) => cwdGuard(p), containerAlive });
  const p = sweepPublicationWorktrees({ cwdGuard: (dir) => cwdGuard(dir) });
  const retired = new Set<string>([...g.retiredWorkspaces, ...p.publicationWorktrees.filter((d) => d.action === "removed").map((d) => d.path)]);
  const r = pruneReadinessRecords({ workspaceRetired: (w) => retired.has(w) });

  const gitReason = (path: string) => g.gitWorkspaces.find((d) => d.path === path);

  // Disposable removed.
  assert.ok(!existsSync(clean), "clean workspace removed");
  assert.equal(gitReason(clean)!.action, "removed");
  assert.ok(!existsSync(pubPublished), "published worktree reclaimed");

  // Unique/dirty/active/ambiguous preserved, exact reasons.
  assert.ok(existsSync(dirty)); assert.equal(gitReason(dirty)!.reason, "uncommitted_work");
  assert.ok(existsSync(unique)); assert.equal(gitReason(unique)!.reason, "unmerged_commits");
  assert.ok(existsSync(held)); assert.equal(gitReason(held)!.reason, "active_process_cwd");
  assert.match(gitReason(held)!.holder ?? "", /tmux server pid 99/);
  assert.ok(existsSync(mounted)); assert.equal(gitReason(mounted)!.reason, "active_mount");

  const pubReason = (path: string) => p.publicationWorktrees.find((d) => d.path === path);
  assert.ok(existsSync(pubFreshFail)); assert.equal(pubReason(pubFreshFail)!.reason, "within_retention_for_investigation");
  assert.ok(existsSync(pubOrphan)); assert.equal(pubReason(pubOrphan)!.reason, "ownership_ambiguous");

  // Readiness: bound record pruned, unrelated retained — in the same pass.
  assert.ok(!existsSync(readinessRecordPath(pubPublished)), "readiness record bound to reclaimed pub is pruned");
  assert.ok(existsSync(readinessRecordPath("/w/live/unrelated")), "unrelated readiness record retained");
  assert.ok(r.readinessRecords.some((d) => d.path === readinessRecordPath("/w/live/unrelated") && d.reason === "ownership_ambiguous"));
});
