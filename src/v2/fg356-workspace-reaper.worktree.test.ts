// FG-356 — the orphan workspace reaper, over REAL git worktrees and REAL clones.
//
// reconcileRun finalizes orphaned tasks; until this ticket it left their workspace
// on disk forever. Every cleanup call in the dispatch path is attached to the
// transition it follows, so the crash that stranded the task is the same crash
// that skipped its cleanup — one leaked ~12MB tree per crash, accumulating until
// git worktree ops on the parent start to hurt.
//
// The reaper is the state-keyed sweep for that. What it must NOT do is the harder
// half: a crashed task whose work was never captured has to be RETAINED, with
// durable evidence naming where the work lives. Every test here builds its own
// repo, worktrees and clones under a temp dir — nothing touches the real
// ~/.forge/forge.db, and no workspace this suite did not create is ever operated
// on.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { reconcileRun } from "./reconcile.js";
import { classifyWorkspace, worktreeBranchName } from "./worktree-lifecycle.js";
import type { Run, Task, TaskStatus } from "../types/index.js";

const RUN_ID = "run-fg356";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg356-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A real repo with one commit — the parent every workspace below hangs off. */
function makeRepo(): string {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg356\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/** A real linked worktree on the deterministic task branch, exactly as
 *  createWorktree makes one (this suite runs on Linux, where the FG-358 platform
 *  gate refuses createWorktree itself — the reaper has no such gate, and what it
 *  operates on is a worktree, not the code path that made it). */
function addWorktree(repo: string, taskId: string): string {
  const path = join(tmpRoot("wt"), taskId);
  git(repo, "worktree", "add", "-q", path, "-b", worktreeBranchName(RUN_ID, taskId));
  return path;
}

/** The agent commits on its task branch. */
function commitInWorktree(worktreePath: string, file: string): void {
  writeFileSync(join(worktreePath, file), `export const work = "${file}";\n`);
  git(worktreePath, "add", ".");
  git(worktreePath, "-c", "user.email=a@b.c", "-c", "user.name=Agent", "commit", "-q", "-m", `agent output ${file}`);
}

/** Forge's merge-back: the work is now in the parent, so the worktree is
 *  redundant — this is what "captured" means to the reaper. */
function mergeBack(repo: string, taskId: string): void {
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, taskId));
}

function branchExists(repo: string, taskId: string): boolean {
  try {
    git(repo, "rev-parse", "--verify", worktreeBranchName(RUN_ID, taskId));
    return true;
  } catch {
    return false;
  }
}

function insertTerminalTask(
  id: string,
  opts: { status: TaskStatus; worktreePath?: string; failureKind?: string },
): Task {
  const t: Task = {
    id,
    runId: RUN_ID,
    phase: "build",
    agentRole: "engineer",
    status: opts.status,
    taskPackage: { taskId: id, runId: RUN_ID, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-26T00:00:00Z",
    startedAt: "2026-07-26T00:00:01Z",
    ...(opts.worktreePath ? { worktreePath: opts.worktreePath } : {}),
  };
  insertTask(t);
  if (opts.status === "failed") {
    logEvent("task.failed", {
      runId: RUN_ID,
      taskId: id,
      payload: { failure_kind: opts.failureKind ?? "orphaned", error: "reconciled after crash" },
    });
  }
  if (opts.status === "complete") logEvent("task.completed", { runId: RUN_ID, taskId: id });
  return t;
}

function workspaceEvents(taskId: string): { type: string; payload: Record<string, unknown> }[] {
  return eventsForTask(taskId)
    .filter((e) => e.eventType === "task.workspace_reaped" || e.eventType === "task.workspace_retained")
    .map((e) => ({ type: e.eventType, payload: (e.payload ?? {}) as Record<string, unknown> }));
}

function startRunFor(projectDir: string): void {
  const run: Run = {
    id: RUN_ID,
    workflow: "invoke",
    title: "fg356 reaper",
    status: "active",
    createdAt: "2026-07-26T00:00:00Z",
    projectDir,
  };
  insertRun(run);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── the reap path ─────────────────────────────────────────────────────────────

test("fg356: an ORPHANED task's worktree and branch are gone after the next reconcileRun", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-orphan");
  commitInWorktree(wt, "agent-work.ts");
  mergeBack(repo, "t-orphan"); // the work is captured — nothing in the tree is unique
  insertTerminalTask("t-orphan", { status: "failed", worktreePath: wt, failureKind: "orphaned" });

  reconcileRun(RUN_ID, () => false);

  assert.equal(existsSync(wt), false, "the orphaned task's worktree must be removed");
  assert.equal(branchExists(repo, "t-orphan"), false, "and its task branch with it");
  assert.ok(
    existsSync(join(repo, "agent-work.ts")),
    "the work itself must still be in the project — reaping disposes of the redundant copy, never the work",
  );

  const evs = workspaceEvents("t-orphan");
  assert.equal(evs.length, 1, "exactly one durable workspace event");
  assert.equal(evs[0]!.type, "task.workspace_reaped");
  assert.equal(evs[0]!.payload["workspacePath"], wt);
  assert.equal(evs[0]!.payload["branch"], worktreeBranchName(RUN_ID, "t-orphan"));
  assert.equal(evs[0]!.payload["substrate"], "linked_worktree");
  assert.equal(evs[0]!.payload["branchRemoved"], true);
});

test("fg356: a crashed task whose worktree holds NO work at all (pre-container crash) is reaped — an empty tree is a leak, not evidence", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-precontainer"); // the agent never ran: tree clean, branch == HEAD
  insertTerminalTask("t-precontainer", { status: "failed", worktreePath: wt, failureKind: "pre_container_crash" });

  reconcileRun(RUN_ID, () => false);

  assert.equal(existsSync(wt), false);
  assert.equal(branchExists(repo, "t-precontainer"), false);
});

test("fg356: the FG-530 leak shape — a task left COMPLETE with a merged tree the crash never cleaned up — is swept", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-complete");
  commitInWorktree(wt, "agent-work.ts");
  mergeBack(repo, "t-complete");
  // The status write landed; the process died before removeWorktreeIfSafe.
  insertTerminalTask("t-complete", { status: "complete", worktreePath: wt });

  reconcileRun(RUN_ID, () => false);

  assert.equal(existsSync(wt), false, "nothing else in forge ever revisits a terminal task's tree");
  assert.equal(branchExists(repo, "t-complete"), false);
});

test("fg356: a LOCKED worktree is unlocked and removed rather than wedging the reaper", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-locked");
  commitInWorktree(wt, "agent-work.ts");
  mergeBack(repo, "t-locked");
  git(repo, "worktree", "lock", wt);

  // The fixture is not vacuous: a SINGLE --force — what removeWorktree ran before
  // this ticket — still refuses a locked worktree. Any tool that adopts and locks
  // a tree (Supacode does, under its tracked repo roots) would wedge cleanup here
  // permanently.
  assert.throws(
    () => execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] }),
    "a locked worktree must genuinely refuse single-force removal, or this test proves nothing",
  );

  insertTerminalTask("t-locked", { status: "failed", worktreePath: wt, failureKind: "orphaned" });
  reconcileRun(RUN_ID, () => false);

  assert.equal(existsSync(wt), false, "the reaper must unlock (or double-force) rather than give up");
  assert.equal(branchExists(repo, "t-locked"), false);
});

// ── the retain contract ───────────────────────────────────────────────────────

test("fg356: a merge_conflict-failed task's worktree and branch are PRESERVED (FG-352 retain-on-conflict)", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-conflict");
  commitInWorktree(wt, "agent-work.ts");
  // Deliberately merged and clean: the capture proof ALONE would reap this tree.
  // The failure kind is what retains it, so this test pins the kind guard rather
  // than accidentally passing on the git probe.
  mergeBack(repo, "t-conflict");
  insertTerminalTask("t-conflict", { status: "failed", worktreePath: wt, failureKind: "merge_conflict" });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(wt), "a merge_conflict worktree is retained for inspection by design");
  assert.ok(branchExists(repo, "t-conflict"), "and so is its branch — the operator rebases it");

  const evs = workspaceEvents("t-conflict");
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "task.workspace_retained");
  assert.equal(evs[0]!.payload["reason"], "retained_failure_kind");
  assert.deepEqual(evs[0]!.payload["details"], ["merge_conflict"]);
  assert.equal(evs[0]!.payload["workspacePath"], wt);
  assert.equal(evs[0]!.payload["branch"], worktreeBranchName(RUN_ID, "t-conflict"));
});

test("fg356: a crashed task with UNCOMMITTED work is retained, and the evidence names the workspace path and branch", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-dirty");
  writeFileSync(join(wt, "uncommitted-sentinel.txt"), "work the agent never committed\n");
  insertTerminalTask("t-dirty", { status: "failed", worktreePath: wt, failureKind: "orphaned_work_may_persist" });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(wt), "uncaptured work is never discarded by cleanup");
  assert.ok(existsSync(join(wt, "uncommitted-sentinel.txt")), "and the work inside it survives, not just the directory");
  assert.ok(branchExists(repo, "t-dirty"));

  const evs = workspaceEvents("t-dirty");
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "task.workspace_retained");
  assert.equal(evs[0]!.payload["reason"], "uncommitted_work");
  assert.equal(evs[0]!.payload["workspacePath"], wt, "durable evidence must name WHERE the work is");
  assert.equal(evs[0]!.payload["branch"], worktreeBranchName(RUN_ID, "t-dirty"), "and on which branch");
  assert.deepEqual(evs[0]!.payload["details"], ["?? uncommitted-sentinel.txt"]);
});

test("fg356: a crashed task whose only output is GIT-IGNORED is retained — ignored files are unrecovered work, not noise", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, ".gitignore"), "out/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore agent output dir");
  startRunFor(repo);

  const wt = addWorktree(repo, "t-ignored");
  mkdirSync(join(wt, "out"));
  writeFileSync(join(wt, "out", "report.json"), '{"finding":"only copy of this"}\n');
  // Tracked-clean and fully merged: every other capture check PASSES, so the
  // ignored probe is the only thing standing between this output and removal.
  assert.equal(git(wt, "status", "--porcelain").trim(), "");
  insertTerminalTask("t-ignored", { status: "failed", worktreePath: wt, failureKind: "orphaned" });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(wt), "a workspace holding ignored agent output is not provably captured");
  assert.ok(existsSync(join(wt, "out", "report.json")), "and the output itself survives");

  const evs = workspaceEvents("t-ignored");
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, "task.workspace_retained");
  assert.equal(evs[0]!.payload["reason"], "uncommitted_work");
  assert.deepEqual(evs[0]!.payload["details"], ["!! out/"]);
});

test("fg356: a crashed task whose COMMITS were never captured is retained — a clean tree is not proof the work landed", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-unmerged");
  commitInWorktree(wt, "agent-work.ts"); // committed on the task branch, never merged back
  insertTerminalTask("t-unmerged", { status: "failed", worktreePath: wt, failureKind: "orphaned" });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(wt), "the branch is the only place these commits exist");
  assert.ok(branchExists(repo, "t-unmerged"));
  const evs = workspaceEvents("t-unmerged");
  assert.equal(evs[0]!.type, "task.workspace_retained");
  assert.equal(evs[0]!.payload["reason"], "unmerged_commits");
  assert.equal(evs[0]!.payload["workspacePath"], wt);
  assert.equal(evs[0]!.payload["branch"], worktreeBranchName(RUN_ID, "t-unmerged"));
});

test("fg356: a NON-terminal task's workspace is never touched — blocked_by_red is the operator being asked to look at it", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-blocked");
  commitInWorktree(wt, "agent-work.ts");
  mergeBack(repo, "t-blocked"); // captured, so only the non-terminal status retains it
  insertTerminalTask("t-blocked", { status: "blocked_by_red", worktreePath: wt });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(wt));
  assert.ok(branchExists(repo, "t-blocked"));
  assert.deepEqual(workspaceEvents("t-blocked"), [], "and nothing is recorded — there is no disposition to record yet");
});

// ── the second substrate (FG-621) ─────────────────────────────────────────────

test("fg356: a mutating agent's PRIVATE CLONE is an explicit no-op, not an unhandled path (FG-621 owns clone reaping)", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const clone = join(tmpRoot("clone"), "t-clone");
  execFileSync("git", ["clone", "--quiet", "--shared", repo, clone], { stdio: ["ignore", "ignore", "pipe"] });
  git(clone, "checkout", "-q", "-b", worktreeBranchName(RUN_ID, "t-clone"));

  assert.equal(
    classifyWorkspace(clone),
    "private_clone",
    "a clone is NOT a registered worktree — git worktree remove does not apply and git worktree list never shows it",
  );
  insertTerminalTask("t-clone", { status: "failed", worktreePath: clone, failureKind: "orphaned" });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(clone), "the clone substrate is left alone until FG-621 implements its disposal");
  assert.ok(existsSync(join(clone, ".git")), "including its private object store and refs");
  const evs = workspaceEvents("t-clone");
  assert.equal(evs.length, 1, "the no-op is RECORDED — a silent skip is how an unhandled substrate hides");
  assert.equal(evs[0]!.type, "task.workspace_retained");
  assert.equal(evs[0]!.payload["reason"], "private_clone_substrate");
  assert.equal(evs[0]!.payload["substrate"], "private_clone");
  assert.equal(evs[0]!.payload["workspacePath"], clone);
});

test("fg356: a MAIN CHECKOUT can never be reaped — the operator's live source classifies as a clone, not a worktree", () => {
  const repo = makeRepo();
  startRunFor(repo);
  assert.equal(classifyWorkspace(repo), "private_clone");
  insertTerminalTask("t-livecheckout", { status: "failed", worktreePath: repo, failureKind: "orphaned" });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(repo), "the substrate classification is the catch that makes this structurally impossible");
  assert.ok(existsSync(join(repo, "README.md")));
});

// ── idempotence ───────────────────────────────────────────────────────────────

test("fg356: repeated reconciles are idempotent — reaping an already-gone workspace is a no-op, and retention is recorded once", () => {
  const repo = makeRepo();
  startRunFor(repo);

  const reaped = addWorktree(repo, "t-idem-reap");
  commitInWorktree(reaped, "agent-work.ts");
  mergeBack(repo, "t-idem-reap");
  insertTerminalTask("t-idem-reap", { status: "failed", worktreePath: reaped, failureKind: "orphaned" });

  const retained = addWorktree(repo, "t-idem-retain");
  writeFileSync(join(retained, "uncommitted-sentinel.txt"), "unrecovered\n");
  insertTerminalTask("t-idem-retain", { status: "failed", worktreePath: retained, failureKind: "orphaned" });

  // A row pointing at a workspace that is already gone — the shape every pass
  // after the first sees.
  insertTerminalTask("t-idem-absent", {
    status: "failed",
    worktreePath: join(repo, "does-not-exist"),
    failureKind: "orphaned",
  });

  for (let pass = 1; pass <= 3; pass++) {
    reconcileRun(RUN_ID, () => false);
    assert.equal(existsSync(reaped), false, `pass ${pass}: stays reaped`);
    assert.ok(existsSync(retained), `pass ${pass}: stays retained`);
    assert.equal(workspaceEvents("t-idem-reap").length, 1, `pass ${pass}: the reap is recorded exactly once`);
    assert.equal(workspaceEvents("t-idem-retain").length, 1, `pass ${pass}: the retention is recorded exactly once`);
    assert.deepEqual(workspaceEvents("t-idem-absent"), [], `pass ${pass}: an absent workspace records nothing`);
    assert.equal(getTask("t-idem-retain")!.worktreePath, retained, `pass ${pass}: a retained row keeps pointing at its work`);
  }
});

test("fg356: a run with no recorded projectDir is left alone — the reaper has no git cwd to work from", () => {
  const repo = makeRepo();
  insertRun({
    id: RUN_ID,
    workflow: "invoke",
    title: "fg356 legacy run",
    status: "active",
    createdAt: "2026-07-26T00:00:00Z",
  });
  const wt = addWorktree(repo, "t-legacy");
  commitInWorktree(wt, "agent-work.ts");
  mergeBack(repo, "t-legacy");
  insertTerminalTask("t-legacy", { status: "failed", worktreePath: wt, failureKind: "orphaned" });

  reconcileRun(RUN_ID, () => false);

  assert.ok(existsSync(wt));
  assert.deepEqual(workspaceEvents("t-legacy"), []);
});
