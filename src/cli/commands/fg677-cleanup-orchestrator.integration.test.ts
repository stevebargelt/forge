// FG-677 (f): the closeout orchestrator. ONE performAutomaticCleanup invocation composes
// the OWNED sections (git workspaces, generated branches, publication worktrees, readiness
// records) alongside — and REPORTING, never re-running — the FG-590 launch/container
// sections. Sections error independently; dry-run is a mutation-free proposal that matches
// the real pass; the readiness prune fires only for workspaces the closeout retired.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, updateRunStatus } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { recordPublicationIntent, updatePublicationAttempt } from "../../store/publications.js";
import { writeReadinessRecord, readinessRecordPath, type HostReadinessRecord } from "../../v2/host-readiness-store.js";
import { worktreeBranchName } from "../../v2/worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir, PUBLICATIONS_DIR, publicationWorktreeDir, hostReadinessDir } from "../../util/paths.js";
import { performAutomaticCleanup } from "./ops.js";
import type { Run, Task } from "../../types/index.js";
import type { CwdHolderResult } from "../../v2/launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const RUN_ID = "run-fg677orch";

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function tmpDir(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }

function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
}

function readinessRecord(workspace: string): HostReadinessRecord {
  return { workspace, treeSha: "abc", lockfileDigest: "sha256:x", nodeVersion: "24", abi: "137", state: "ready", setupCommand: "npm ci", coveredCommandSet: ["test"], assertedAt: new Date().toISOString() };
}

const NEVER_HELD = (): CwdHolderResult => ({ held: false });
const NO_CONTAINER = (): boolean => false;
const NO_LAUNCH_TMUX = () => { const e = new Error("no server running") as Error & { stderr: string }; e.stderr = "no server running"; throw e; };
const DOCKER_DOWN = () => undefined; // listContainers -> dockerUnavailable

/** A complete run with a clean linked worktree, a published publication worktree, and two
 *  readiness records — one bound to the reclaimed publication worktree, one to an unrelated
 *  workspace that this pass does not retire. Returns the notable paths. */
function setupFixture(projectDir: string): { wtPath: string; pubDir: string; boundRec: string; unrelatedRec: string } {
  insertRun({ id: RUN_ID, workflow: "invoke", title: "orch", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
  updateRunStatus(RUN_ID, "complete");

  const wtPath = worktreeDir(RUN_ID, "task-a");
  mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });
  git(projectDir, "worktree", "add", wtPath, "-b", worktreeBranchName(RUN_ID, "task-a"));
  const task: Task = { id: "task-a", runId: RUN_ID, phase: "task", agentRole: "engineer", status: "complete", taskPackage: { taskId: "task-a", runId: RUN_ID, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" }, createdAt: "2026-08-01T00:00:00Z", worktreePath: wtPath };
  insertTask(task);

  mkdirSync(PUBLICATIONS_DIR, { recursive: true });
  recordPublicationIntent({ attemptId: "att-1", projectKey: "proj", canonicalDir: projectDir, runId: RUN_ID, taskId: "task-a", target: "local", leaseTtlMs: 60_000 });
  updatePublicationAttempt("att-1", { state: "published", worktreePath: publicationWorktreeDir("att-1", 0), rebuildCount: 0 });
  const pubDir = publicationWorktreeDir("att-1", 0);
  mkdirSync(join(pubDir, "node_modules"), { recursive: true });

  mkdirSync(hostReadinessDir(), { recursive: true });
  writeReadinessRecord(readinessRecord(pubDir));
  const boundRec = readinessRecordPath(pubDir);
  const unrelatedWs = "/w/some/other/live-workspace";
  writeReadinessRecord(readinessRecord(unrelatedWs));
  const unrelatedRec = readinessRecordPath(unrelatedWs);

  return { wtPath, pubDir, boundRec, unrelatedRec };
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

test("FG-677 orchestrator: one cleanup composes all owned sections AND reports FG-590 without re-running it", () => {
  const projectDir = tmpDir("fg677-orch-proj-");
  initRepo(projectDir);
  const { wtPath, pubDir, boundRec, unrelatedRec } = setupFixture(projectDir);

  const result = performAutomaticCleanup({
    projectDir, runId: RUN_ID,
    containerAlive: NO_CONTAINER, cwdGuard: NEVER_HELD,
    listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX,
  });

  // Owned sections acted.
  assert.ok(!existsSync(wtPath), "git workspace removed");
  assert.equal(result.report.gitWorkspaces.filter((d) => d.action === "removed").length, 1);
  assert.equal(result.report.generatedBranches.filter((d) => d.action === "removed").length, 1);
  assert.ok(!existsSync(pubDir), "publication worktree reclaimed");
  assert.equal(result.report.publicationWorktrees.filter((d) => d.action === "removed").length, 1);

  // Readiness prune fired ONLY for the workspace the closeout retired (the publication dir);
  // the unrelated record is retained.
  assert.ok(!existsSync(boundRec), "readiness record bound to the reclaimed publication dir is pruned");
  assert.ok(existsSync(unrelatedRec), "readiness record for a non-retired workspace is retained");
  assert.ok(result.report.readinessRecords.some((r) => r.path === boundRec && r.action === "removed"));
  assert.ok(result.report.readinessRecords.some((r) => r.path === unrelatedRec && r.action === "retained"));

  // FG-590 disposition is REPORTED, not re-run.
  assert.ok(typeof result.report.reportedElsewhere.launches === "string");
  assert.ok(typeof result.report.reportedElsewhere.containers === "string");
  assert.match(result.report.reportedElsewhere.containers!, /docker unavailable/);

  // No section errored.
  assert.deepEqual(result.report.sectionErrors, {});
});

test("FG-677 orchestrator: DRY-RUN performs no mutation and its dispositions match the subsequent real pass", () => {
  const projectDir = tmpDir("fg677-orch-proj-");
  initRepo(projectDir);
  const { wtPath, pubDir, boundRec } = setupFixture(projectDir);

  const dry = performAutomaticCleanup({ dryRun: true, projectDir, runId: RUN_ID, containerAlive: NO_CONTAINER, cwdGuard: NEVER_HELD, listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX });
  assert.ok(existsSync(wtPath) && existsSync(pubDir) && existsSync(boundRec), "dry-run mutates nothing");
  const dryRemoved = new Set([...dry.report.gitWorkspaces, ...dry.report.publicationWorktrees, ...dry.report.readinessRecords].filter((d) => d.action === "removed").map((d) => d.path));

  const real = performAutomaticCleanup({ projectDir, runId: RUN_ID, containerAlive: NO_CONTAINER, cwdGuard: NEVER_HELD, listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX });
  const realRemoved = new Set([...real.report.gitWorkspaces, ...real.report.publicationWorktrees, ...real.report.readinessRecords].filter((d) => d.action === "removed").map((d) => d.path));

  assert.deepEqual([...dryRemoved].sort(), [...realRemoved].sort(), "the dry-run proposal matches the real pass exactly");
  assert.ok(!existsSync(wtPath) && !existsSync(pubDir) && !existsSync(boundRec), "the real pass removed them");
});

test("FG-677 orchestrator: a NON-TERMINAL run is not closed out (run_not_terminal), artifacts preserved", () => {
  const projectDir = tmpDir("fg677-orch-proj-");
  initRepo(projectDir);
  // A genuinely non-terminal run: active run with a live (running) task — the shared
  // classifier reports it as not settled, so the closeout must not act.
  insertRun({ id: RUN_ID, workflow: "invoke", title: "orch-live", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
  const wtPath = worktreeDir(RUN_ID, "task-live");
  mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });
  git(projectDir, "worktree", "add", wtPath, "-b", worktreeBranchName(RUN_ID, "task-live"));
  insertTask({ id: "task-live", runId: RUN_ID, phase: "task", agentRole: "engineer", status: "running", taskPackage: { taskId: "task-live", runId: RUN_ID, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" }, createdAt: "2026-08-01T00:00:00Z", worktreePath: wtPath } as Task);

  const result = performAutomaticCleanup({ projectDir, runId: RUN_ID, containerAlive: NO_CONTAINER, cwdGuard: NEVER_HELD, listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX });

  assert.ok(existsSync(wtPath), "a non-terminal run's workspace is never touched");
  assert.ok(result.report.gitWorkspaces.some((d) => d.reason === "run_not_terminal"));
});

test("FG-677 orchestrator: a race making the container LIVE before deletion fails closed (active_mount)", () => {
  const projectDir = tmpDir("fg677-orch-proj-");
  initRepo(projectDir);
  const { wtPath } = setupFixture(projectDir);
  // The container-alive probe, re-derived at the chokepoint, now reports the container as
  // live (it came back after inventory) — the workspace must be preserved.
  const raceAlive = (name: string): boolean => name === "forge-task-a";

  const result = performAutomaticCleanup({ projectDir, runId: RUN_ID, containerAlive: raceAlive, cwdGuard: NEVER_HELD, listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX });

  assert.ok(existsSync(wtPath), "a workspace whose container raced back to live is preserved");
  assert.ok(result.report.gitWorkspaces.some((d) => d.reason === "active_mount"));
});
