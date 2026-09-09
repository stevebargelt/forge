// FG-786 AC4 + AC5 (honesty + regression gate): `forge ops cleanup --dry-run` on a host whose
// tmux server carries a pile of DEAD panes (the #{pane_dead}==1 leftovers of remain-on-exit)
// must report every terminal workspace's gate outcome HONESTLY. Before this ticket a single
// dead pane poisoned the whole cwd-holder probe to `unprobed` — its pid is gone, so lsof/ps
// return nothing, readProcCwd returns undefined, and the FG-677 workspace liveness gate then
// retained EVERY terminal workspace as `active_process_cwd` (fail closed on unprobed). The host
// carried 1306 dead panes vs 2 live, so nothing ever converged.
//
// The fix (AC1) excludes dead panes at enumeration: a dead pane is a PROVEN negative (no live
// process can hold a cwd on its behalf), never an unprobed candidate. This test drives the
// real closeout (performAutomaticCleanup -> performRunCloseout, all three chokepoints) through
// an injected per-pass guard built over a fake tmux carrying many dead panes, and proves:
//   A. dead panes + ZERO live holders  -> every workspace reports held:false and is reapable
//      (removed under dry-run); no dead-pane-induced `unprobed` anywhere; no dead pid ever
//      probed.
//   B. a genuinely UNREADABLE LIVE pid  -> STILL honestly `unprobed` -> retain (the honesty
//      boundary is preserved; only the dead-pane false positive is removed). No workspace is
//      reapable, and the retained-holder line names the LIVE pid, not a dead pane.
//   C. a LIVE pane holding a workspace  -> that workspace is held:true and retained
//      (active_process_cwd), never reapable, while the OTHER workspaces still converge —
//      dead panes neither mask a real holder nor block the rest.
//
// AC5 (the FG-614/FG-677/FG-590 green gate) is validated by RUNNING those suites alongside
// this file; this file adds the AC4 honesty proof and the "no live-held workspace becomes
// reapable" assertions.

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
import { writeReadinessRecord, type HostReadinessRecord } from "../../v2/host-readiness-store.js";
import { worktreeBranchName } from "../../v2/worktree-lifecycle.js";
import { WORKTREES_DIR, worktreeDir, PUBLICATIONS_DIR, publicationWorktreeDir, hostReadinessDir } from "../../util/paths.js";
import { performAutomaticCleanup, buildCloseoutCwdGuard } from "./ops.js";
import { createPassCwdGuard, type CwdHolderResult, type TmuxRunner } from "../../v2/launch.js";
import type { CleanupDisposition } from "../../v2/run-cleanup-report.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const RUN_ID = "run-fg786honesty";

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

const SERVER_PID = 1000;
const LIVE_PANE_PID = 2001;
const DEAD_PID_BASE = 9001;
const DEAD_PANE_COUNT = 300; // a pile of remain-on-exit leftovers, as the host carried

/** A fake tmux carrying `SERVER_PID` + `livePanePids` LIVE panes + DEAD_PANE_COUNT DEAD panes.
 *  It emits the EXACT list-panes format enumerateTmuxPids requests (`#{pane_pid} #{pane_dead}
 *  #{session_name}`) so the AC1 dead-pane filter is genuinely exercised — a dead pane
 *  (#{pane_dead}==1) must be dropped at enumeration and never reach the probe. */
function fakeTmux(livePanePids: number[]): TmuxRunner {
  return (args: string[]): string => {
    if (args[0] === "display-message") return `${SERVER_PID}\n`;
    if (args[0] === "list-panes") {
      const lines: string[] = [];
      livePanePids.forEach((pid, i) => lines.push(`${pid} 0 live-${i}`));
      for (let i = 0; i < DEAD_PANE_COUNT; i++) lines.push(`${DEAD_PID_BASE + i} 1 dead-${i}`);
      return lines.join("\n") + "\n";
    }
    return "";
  };
}

/** Build a real per-pass guard over the fake tmux with a COUNTING readCwd. `cwdByPid` maps a
 *  candidate pid to the cwd its probe returns; a pid absent from the map (or mapped to
 *  undefined) is a genuinely-UNREADABLE process — readProcCwd's undefined, which is the ONLY
 *  honest source of `unprobed`. Every probe is recorded so the test can prove a dead pane's
 *  pid is NEVER probed (it was excluded at enumeration, AC1). */
function countingGuard(cwdByPid: Map<number, string | undefined>, extraCwds: Array<{ cwd: string; description: string }> = []): { guard: (p: string) => CwdHolderResult; probed: () => number[] } {
  const probedPids: number[] = [];
  const readCwd = (pid: number): string | undefined => { probedPids.push(pid); return cwdByPid.get(pid); };
  const inner = createPassCwdGuard({ tmux: fakeTmux([...cwdByPid.keys()].filter((p) => p !== SERVER_PID)), readCwd, extraCwds });
  return { guard: (p: string): CwdHolderResult => inner(p), probed: () => probedPids };
}

/** A complete run with N linked task worktrees, N publication worktrees, and one readiness
 *  record bound to each publication worktree — so a single closeout pass gates workspaces
 *  across ALL THREE chokepoints (git workspaces, publication worktrees, readiness records). */
function setupFixture(projectDir: string, n: number): { taskWs: string[]; pubDirs: string[] } {
  insertRun({ id: RUN_ID, workflow: "invoke", title: "honesty", status: "active", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
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
    writeReadinessRecord(readinessRecord(pubDir));
    pubDirs.push(pubDir);
  }
  return { taskWs, pubDirs };
}

function runDryCleanup(projectDir: string, guard: (p: string) => CwdHolderResult) {
  return performAutomaticCleanup({
    dryRun: true, projectDir, runId: RUN_ID,
    containerAlive: NO_CONTAINER, cwdGuard: guard,
    listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX,
  });
}

/** Every disposition across the three workspace-gated sections. */
function gatedDispositions(report: ReturnType<typeof runDryCleanup>["report"]): CleanupDisposition[] {
  return [...report.gitWorkspaces, ...report.publicationWorktrees, ...report.readinessRecords];
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

test("FG-786 AC4: dead panes + ZERO live holders -> every terminal workspace is honestly reapable; no dead-pane-induced unprobed; no dead pid probed", () => {
  const projectDir = tmpDir("fg786-honesty-proj-");
  initRepo(projectDir);
  const K = 4;
  const { taskWs } = setupFixture(projectDir, K);

  // Only the tmux server pid is a real live process; its cwd is somewhere that is NOT any
  // workspace. The 300 dead panes are the ONLY other "candidates" a naive enumeration would
  // include — and each of their pids is gone (mapped to no cwd). If AC1 did not exclude them
  // they would each probe undefined -> unprobed -> every workspace retained.
  const cwdByPid = new Map<number, string | undefined>([[SERVER_PID, "/tmp/tmux-server-home"]]);
  const { guard, probed } = countingGuard(cwdByPid);

  // Direct honesty check at the guard: a dead-pane-only host is a PROVEN NEGATIVE, not unprobed.
  const direct = guard(taskWs[0]!);
  assert.equal(direct.held, false, "a workspace on a dead-pane-only host is held:false (proven negative), NOT unprobed");

  const result = runDryCleanup(projectDir, guard);
  assert.deepEqual(result.report.sectionErrors, {}, "no section threw");

  // Every terminal workspace across all three chokepoints is reapable (removed under dry-run).
  assert.equal(result.report.gitWorkspaces.filter((d) => d.action === "removed").length, K, "K git workspaces reapable");
  assert.equal(result.report.publicationWorktrees.filter((d) => d.action === "removed").length, K, "K publication worktrees reapable");
  assert.equal(result.report.readinessRecords.filter((d) => d.action === "removed").length, K, "K readiness records prunable");

  // The honesty claim: NOTHING is retained for a cwd-holder reason, because a dead pane is a
  // proven negative — it can never manufacture an `active_process_cwd` retention.
  const cwdRetained = gatedDispositions(result.report).filter((d) => d.action === "retained" && d.reason === "active_process_cwd");
  assert.equal(cwdRetained.length, 0, "no workspace retained as active_process_cwd from dead panes");
  const unprobedHolders = gatedDispositions(result.report).filter((d) => (d.holder ?? "").startsWith("unprobed:"));
  assert.equal(unprobedHolders.length, 0, "zero dead-pane-induced `unprobed` holders anywhere in the report");

  // A dead pane's pid is NEVER probed — it was excluded at enumeration (AC1), not read-then-
  // discarded. Only the live server pid was probed.
  const probedPids = probed();
  assert.ok(probedPids.every((p) => p < DEAD_PID_BASE), "no dead-pane pid was ever probed");
  assert.deepEqual([...new Set(probedPids)], [SERVER_PID], "only the live tmux server pid was probed");
});

test("FG-786 AC4/AC5 honesty boundary: a genuinely-UNREADABLE LIVE pid STILL reports unprobed -> retain; nothing reapable; the holder names the live pid, not a dead pane", () => {
  const projectDir = tmpDir("fg786-honesty-proj-");
  initRepo(projectDir);
  const K = 3;
  const { taskWs } = setupFixture(projectDir, K);

  // The tmux server reads fine and points elsewhere; but a LIVE pane (dead==0) exists whose
  // pid is genuinely unreadable (mapped to undefined) — the ONE honest source of `unprobed`.
  // Dead panes are present too, but they must NOT be the cause.
  const cwdByPid = new Map<number, string | undefined>([
    [SERVER_PID, "/tmp/tmux-server-home"],
    [LIVE_PANE_PID, undefined], // live process, cwd unreadable -> honestly unprobed
  ]);
  const { guard, probed } = countingGuard(cwdByPid);

  // Direct check: the guard is honestly `unprobed`, and the reason names the LIVE pane.
  const direct = guard(taskWs[0]!);
  assert.equal(direct.held, "unprobed", "an unreadable LIVE pid keeps the gate honestly unprobed");
  assert.ok(direct.held === "unprobed" && /2001/.test(direct.reason), "the unprobed reason names the live pid, not a dead pane");

  const result = runDryCleanup(projectDir, guard);
  assert.deepEqual(result.report.sectionErrors, {}, "no section threw");

  // Fail-closed: an unprobed workspace is retained as active_process_cwd — NOTHING reapable.
  assert.equal(result.report.gitWorkspaces.filter((d) => d.action === "removed").length, 0, "no git workspace reapable while a live pid is unprobed");
  assert.equal(result.report.publicationWorktrees.filter((d) => d.action === "removed").length, 0, "no publication worktree reapable");
  assert.equal(result.report.readinessRecords.filter((d) => d.action === "removed").length, 0, "no readiness record pruned");

  const gitRetained = result.report.gitWorkspaces.filter((d) => d.action === "retained");
  assert.equal(gitRetained.length, K, "every git workspace retained");
  for (const d of gitRetained) {
    assert.equal(d.reason, "active_process_cwd", "retained for the honest liveness reason");
    assert.ok((d.holder ?? "").startsWith("unprobed:"), "the retention is honestly labelled unprobed");
    assert.ok(/2001/.test(d.holder ?? ""), "the unprobed retention names the LIVE pid (2001), proving it is not a dead-pane artifact");
  }

  // The live pane's pid WAS probed (that is the honest read that failed); no dead pid was.
  const probedPids = probed();
  assert.ok(probedPids.includes(LIVE_PANE_PID), "the live pane pid was probed (the honest read that came back unreadable)");
  assert.ok(probedPids.every((p) => p < DEAD_PID_BASE), "no dead-pane pid was ever probed");
});

test("FG-786 AC5: a LIVE pane holding a workspace keeps it retained (held:true, never reapable) while the OTHER workspaces still converge; dead panes neither mask it nor block them", () => {
  const projectDir = tmpDir("fg786-honesty-proj-");
  initRepo(projectDir);
  const K = 4;
  const { taskWs } = setupFixture(projectDir, K);
  const heldWs = taskWs[0]!;

  // A LIVE pane's cwd IS the first task workspace — a genuine holder. The server points
  // elsewhere. 300 dead panes are present; none can hold anything.
  const cwdByPid = new Map<number, string | undefined>([
    [SERVER_PID, "/tmp/tmux-server-home"],
    [LIVE_PANE_PID, heldWs], // live process holds workspace 0
  ]);
  const { guard, probed } = countingGuard(cwdByPid);

  const direct = guard(heldWs);
  assert.equal(direct.held, true, "the live-held workspace is held:true (a proven live holder)");

  const result = runDryCleanup(projectDir, guard);
  assert.deepEqual(result.report.sectionErrors, {}, "no section threw");

  // The held workspace is retained and NEVER reapable; it names the live pid as the holder.
  const heldDisp = result.report.gitWorkspaces.find((d) => d.path === heldWs);
  assert.ok(heldDisp, "the held workspace has a disposition");
  assert.equal(heldDisp!.action, "retained", "a live-process-held workspace is never reapable");
  assert.equal(heldDisp!.reason, "active_process_cwd", "retained for the live-holder reason");
  assert.ok(/2001/.test(heldDisp!.holder ?? ""), "the holder line names the live pid");
  assert.ok(!(heldDisp!.holder ?? "").startsWith("unprobed:"), "a PROVEN holder is not reported as unprobed");
  assert.ok(existsSync(heldWs), "the held workspace is still on disk (dry-run proposes nothing destructive, and it would be retained regardless)");

  // The OTHER three git workspaces still converge — dead panes did not poison the pass, and a
  // single genuine holder does not block unrelated workspaces.
  const removedGit = result.report.gitWorkspaces.filter((d) => d.action === "removed").map((d) => d.path);
  assert.equal(removedGit.length, K - 1, "the three unheld git workspaces are reapable");
  assert.ok(!removedGit.includes(heldWs), "the held workspace is not among the reapable ones");

  // No dead pid probed; the live holder was.
  const probedPids = probed();
  assert.ok(probedPids.includes(LIVE_PANE_PID), "the live holder pid was probed");
  assert.ok(probedPids.every((p) => p < DEAD_PID_BASE), "no dead-pane pid was ever probed");
});

// FG-786 RF-6: a store read failure for the OPEN launch cwds is a liveness input we could not
// read. Flattening it to an empty holder list is FAIL-OPEN — with no tmux process holding a
// workspace, every workspace would then be reaped. buildCloseoutCwdGuard must instead force
// every workspace to held:'unprobed' (retain), matching the fail-closed direction.

test("FG-786 RF-6: buildCloseoutCwdGuard forces every workspace to held:'unprobed' when the open-launch read failed", () => {
  const guard = buildCloseoutCwdGuard({ ok: false, reason: "launch store SELECT threw" });
  for (const w of ["/ws/a", "/ws/b", "/ws/c"]) {
    const res = guard(w);
    assert.equal(res.held, "unprobed", "a workspace is retained (unprobed) when the holder read failed");
    if (res.held === "unprobed") assert.match(res.reason, /launch store SELECT threw/);
  }
  // A test-injected guard still wins over the fail-closed path (production-injection contract).
  const injected = buildCloseoutCwdGuard({ ok: false, reason: "x" }, () => ({ held: false }));
  assert.deepEqual(injected("/ws"), { held: false });
});

test("FG-786 RF-6: a throwing open-launch reader retains EVERY workspace through the real closeout — nothing reaped on a missed process probe", () => {
  const projectDir = tmpDir("fg786-rf6-proj-");
  initRepo(projectDir);
  const K = 3;
  const { taskWs, pubDirs } = setupFixture(projectDir, K);

  // A REAL (non-dry) closeout with NO cwdGuard injected — so the actual fail-closed guard
  // buildCloseoutCwdGuard constructs is exercised — and an open-launch reader that THROWS.
  // Before RF-6 the throw was swallowed to an empty holder list and, with no tmux holder,
  // every workspace would be reaped; now the whole pass is 'unprobed' → retain everything.
  const result = performAutomaticCleanup({
    projectDir, runId: RUN_ID,
    containerAlive: NO_CONTAINER,
    listContainers: DOCKER_DOWN, tmux: NO_LAUNCH_TMUX,
    openLaunchCwdsReader: () => { throw new Error("launch store read failed"); },
  });

  assert.deepEqual(result.report.sectionErrors, {}, "the read failure is handled inside the guard, not propagated as a section error");

  // Not one workspace was reaped, and every one is still on disk (fail closed).
  assert.equal(result.report.gitWorkspaces.filter((d) => d.action === "removed").length, 0, "no git workspace reaped when the holder read failed");
  const gitRetained = result.report.gitWorkspaces.filter((d) => d.action === "retained");
  assert.equal(gitRetained.length, K, "every git workspace retained");
  for (const d of gitRetained) {
    assert.equal(d.reason, "active_process_cwd", "retained for the liveness reason");
    assert.ok((d.holder ?? "").startsWith("unprobed:"), "labelled honestly as unprobed");
    assert.match(d.holder ?? "", /open launch holders unreadable/);
  }
  for (const ws of taskWs) assert.ok(existsSync(ws), "the git workspace remains on disk (fail closed)");
  for (const pub of pubDirs) assert.ok(existsSync(pub), "the publication worktree remains on disk (fail closed)");
  assert.equal(result.report.readinessRecords.filter((d) => d.action === "removed").length, 0, "no readiness record pruned (no workspace was retired)");
});
