// FG-786 AC2 (wiring): performRunCloseout builds the per-pass cwd guard ONCE and threads the
// SAME closure into all three workspace chokepoints — disposeRunGitWorkspaces,
// sweepPublicationWorktrees, and the pruneReadinessRecords live-reader probe. A closeout pass
// over K workspaces must read each candidate pid's cwd at MOST ONCE total — O(pids), not
// O(pids × workspaces) — which is the fix for the hours-long closeout that held the run lock
// (each workspace gate used to re-enumerate every tmux pane and spawn one lsof per pid).
//
// The probe is counted by injecting a REAL createPassCwdGuard whose readCwd is a counting
// stub and whose tmux is a fake carrying both live and dead panes. If the pass rebuilt a
// guard per chokepoint (or per workspace), or a chokepoint fell back to a fresh
// findProcessesHoldingCwd, the readCwd count would scale with the workspace count. Because one
// memoizing guard is shared, it equals the unique LIVE pid set regardless of K — and a dead
// pane (AC1) is never probed at all.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, closeDb, storeExists } from "../../store/db.js";
import { insertRun, updateRunStatus } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { recordPublicationIntent, updatePublicationAttempt } from "../../store/publications.js";
import { writeReadinessRecord, readinessRecordPath, type HostReadinessRecord } from "../../v2/host-readiness-store.js";
import { worktreeBranchName } from "../../v2/worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir, PUBLICATIONS_DIR, publicationWorktreeDir, hostReadinessDir } from "../../util/paths.js";
import { performAutomaticCleanup } from "./ops.js";
import { createPassCwdGuard, type CwdHolderResult, type TmuxRunner } from "../../v2/launch.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const RUN_ID = "run-fg786scale";

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

const NO_CONTAINER = (): boolean => false;
const NO_LAUNCH_TMUX = () => { const e = new Error("no server running") as Error & { stderr: string }; e.stderr = "no server running"; throw e; };
const DOCKER_DOWN = () => undefined; // listContainers -> dockerUnavailable

// 8 LIVE panes + 1 server = 9 candidate pids; 50 DEAD panes (#{pane_dead}==1) that must never
// be probed. This is the exact list-panes format enumerateTmuxPids requests (AC1).
const LIVE_PIDS = [1000, ...Array.from({ length: 8 }, (_, i) => 2001 + i)];
const DEAD_PID_BASE = 9001;
function fakeTmux(): TmuxRunner {
  return (args: string[]): string => {
    if (args[0] === "display-message") return "1000\n"; // tmux server pid
    if (args[0] === "list-panes") {
      const lines: string[] = [];
      for (let i = 0; i < 8; i++) lines.push(`${2001 + i} 0 session-${i}`);
      for (let i = 0; i < 50; i++) lines.push(`${DEAD_PID_BASE + i} 1 dead-${i}`);
      return lines.join("\n") + "\n";
    }
    return "";
  };
}

/** A complete run with N linked task worktrees, N published publication worktrees, and one
 *  readiness record bound to each published worktree — so a single closeout pass gates
 *  workspaces across ALL THREE chokepoints (git workspaces, publication worktrees, readiness
 *  records). Returns the published dirs (retention targets for the extraCwds test). */
function setupFixture(projectDir: string, n: number): { taskWs: string[]; pubDirs: string[] } {
  insertRun({ id: RUN_ID, workflow: "invoke", title: "scale", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
  updateRunStatus(RUN_ID, "complete");
  mkdirSync(join(WORKTREES_DIR, RUN_ID), { recursive: true });
  mkdirSync(PUBLICATIONS_DIR, { recursive: true });
  mkdirSync(hostReadinessDir(), { recursive: true });

  const taskWs: string[] = [];
  const pubDirs: string[] = [];
  for (let i = 0; i < n; i++) {
    const taskId = `task-${i}`;
    const wtPath = worktreeDir(RUN_ID, taskId);
    git(projectDir, "worktree", "add", wtPath, "-b", worktreeBranchName(RUN_ID, taskId));
    insertTask({ id: taskId, runId: RUN_ID, phase: "task", agentRole: "engineer", status: "complete", taskPackage: { taskId, runId: RUN_ID, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" }, createdAt: "2026-08-01T00:00:00Z", worktreePath: wtPath } as Task);
    taskWs.push(wtPath);

    const attemptId = `att-${i}`;
    recordPublicationIntent({ attemptId, projectKey: "proj", canonicalDir: projectDir, runId: RUN_ID, taskId, target: "local", leaseTtlMs: 60_000 });
    updatePublicationAttempt(attemptId, { state: "published", worktreePath: publicationWorktreeDir(attemptId, 0), rebuildCount: 0 });
    const pubDir = publicationWorktreeDir(attemptId, 0);
    git(projectDir, "worktree", "add", pubDir, "-b", `forge/publish/${attemptId}/r0`);
    mkdirSync(join(pubDir, "node_modules"), { recursive: true });
    writeReadinessRecord(readinessRecord(pubDir)); // readiness record bound to a retired workspace
    pubDirs.push(pubDir);
  }
  return { taskWs, pubDirs };
}

/** Build a counting per-pass guard over the fake tmux. readCwd returns a path that is never
 *  physically any workspace (so nothing is held from a pid), letting every workspace retire so
 *  all three chokepoints are fully exercised. `extraCwds` is threaded through unchanged. */
function countingGuard(extraCwds: Array<{ cwd: string; description: string }> = []): { guard: (p: string) => CwdHolderResult; guardCalls: () => number; probedPids: () => number[] } {
  const probed = new Set<number>();
  let probeCalls = 0;
  const readCwd = (pid: number): string | undefined => { probeCalls += 1; probed.add(pid); return `/nonexistent/proc-cwd/${pid}`; };
  const inner = createPassCwdGuard({ tmux: fakeTmux(), readCwd, extraCwds });
  let calls = 0;
  const guard = (p: string): CwdHolderResult => { calls += 1; return inner(p); };
  // probeCalls MUST equal the distinct probed-pid set (memo reads each pid at most once).
  return { guard, guardCalls: () => calls, probedPids: () => { assert.equal(probeCalls, probed.size, "each pid read exactly once"); return [...probed]; } };
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

test("FG-786 AC2: one closeout pass probes each candidate pid at most once across all three chokepoints (O(pids), not O(pids × workspaces))", () => {
  const projectDir = tmpDir("fg786-scale-proj-");
  initRepo(projectDir);
  const K = 4;
  setupFixture(projectDir, K); // K git workspaces + K publication worktrees + K readiness records

  const { guard, guardCalls, probedPids } = countingGuard();
  const result = performAutomaticCleanup({
    projectDir, runId: RUN_ID,
    containerAlive: NO_CONTAINER, cwdGuard: guard,
    listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX,
  });

  // All three chokepoints acted (workspaces span every call site).
  assert.equal(result.report.gitWorkspaces.filter((d) => d.action === "removed").length, K, "K git workspaces retired");
  assert.equal(result.report.publicationWorktrees.filter((d) => d.action === "removed").length, K, "K publication worktrees retired");
  assert.equal(result.report.readinessRecords.filter((d) => d.action === "removed").length, K, "K readiness records pruned");
  assert.deepEqual(result.report.sectionErrors, {});

  // The guard was queried once per workspace at every chokepoint — 3*K > the candidate pid
  // count — yet each candidate pid's cwd was read at most once TOTAL. That is the O(pids)
  // guarantee: probe cost is independent of the workspace count.
  assert.ok(guardCalls() >= 3 * K, `guard queried per-workspace at all three chokepoints (got ${guardCalls()})`);
  const pids = probedPids();
  assert.equal(pids.length, LIVE_PIDS.length, "each LIVE candidate pid probed exactly once, none re-probed per workspace");
  assert.deepEqual([...pids].sort((a, b) => a - b), [...LIVE_PIDS].sort((a, b) => a - b), "exactly the live pids were probed");
  // AC1 integration: a dead pane (#{pane_dead}==1) is a proven negative and never probed.
  assert.ok(pids.every((p) => p < DEAD_PID_BASE), "no dead-pane pid was ever probed");
});

test("FG-786 AC2: total probe count is independent of K (a larger pass does not probe more pids)", () => {
  const projectDir = tmpDir("fg786-scale-proj-");
  initRepo(projectDir);
  setupFixture(projectDir, 8); // twice the workspaces of the previous test

  const { guard, guardCalls, probedPids } = countingGuard();
  const result = performAutomaticCleanup({ projectDir, runId: RUN_ID, containerAlive: NO_CONTAINER, cwdGuard: guard, listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX });

  assert.deepEqual(result.report.sectionErrors, {});
  assert.ok(guardCalls() >= 3 * 8, "more workspaces => more guard queries");
  // ...but the probe count stayed pinned to the pid set — not 2x because there are 2x workspaces.
  assert.equal(probedPids().length, LIVE_PIDS.length, "probe count tracks pids, never workspaces");
});

test("FG-786 AC2: extraCwds (open launch cwds) are still honored at the git-workspace chokepoint — a live launch-cwd holder forces retain", () => {
  const projectDir = tmpDir("fg786-scale-proj-");
  initRepo(projectDir);
  const { taskWs } = setupFixture(projectDir, 3);
  const heldWs = taskWs[0]!;

  // A live open-launch observation recorded this exact workspace as its cwd. Folded through
  // the guard as extraCwds (path-identity match, no pid), it must force the git workspace to
  // be retained even though no tmux pid holds it.
  const { guard } = countingGuard([{ cwd: heldWs, description: "open launch L-held" }]);
  const result = performAutomaticCleanup({ projectDir, runId: RUN_ID, containerAlive: NO_CONTAINER, cwdGuard: guard, listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX });

  assert.ok(existsSync(heldWs), "the workspace held by a live launch cwd is retained on disk");
  assert.ok(result.report.gitWorkspaces.some((d) => d.path === heldWs && d.action === "retained"), "held workspace reported retained");
  assert.equal(result.report.gitWorkspaces.filter((d) => d.action === "removed").length, 2, "the other two workspaces still retire");
});

test("FG-786 AC2: a store-less host still constructs the guard and runs the closeout, minting no store", () => {
  // Drop the beforeEach in-memory handle; the integration temp FORGE_HOME has no forge.db, so
  // storeExists() is false. The OWNED git-workspace + publication sections are gated on
  // storeExists and skip; the guard is STILL constructed (safeOpenLaunchCwds mints nothing on
  // a store-less host) and the readiness prune still runs. The pass must complete without
  // throwing, without a section error, and without minting a store.
  closeDb();
  assert.equal(storeExists(), false, "precondition: store-less host");
  const projectDir = tmpDir("fg786-scale-storeless-");
  initRepo(projectDir);
  const { guard } = countingGuard();
  const result = performAutomaticCleanup({ projectDir, containerAlive: NO_CONTAINER, cwdGuard: guard, listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX });
  assert.equal(result.report.gitWorkspaces.length, 0, "no git-workspace section on a store-less host");
  assert.equal(result.report.readinessRecords.length, 0, "no readiness records to prune");
  assert.deepEqual(result.report.sectionErrors, {});
  assert.equal(storeExists(), false, "the closeout minted no store");
  // Re-arm a live handle so the shared afterEach teardown (db.close()) operates on an open db.
  db = makeInMemoryDb();
  setDbForTest(db);
});
