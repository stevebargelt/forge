// FG-356 — the orphan workspace reaper AS reconcileRun DRIVES IT.
//
// The unit-level companion (fg356-workspace-reaper.worktree.test.ts) proves the
// reaper's own decisions. This lane proves the decisions forge actually makes:
// real runs, real task rows, real repositories, real linked worktrees, and
// reconcileRun as the only entry point — never reapTaskWorkspace called directly.
//
// The risk this file is built around is the WIDENED REMOVAL SANCTION. Before
// FG-356 the only workspace forge ever removed was a proven-merged one, on the
// dispatch path, inline; the FG-530 shared invariant checker could therefore
// EXEMPT a removal whenever the task had reached `complete`. FG-356 widened the
// sanction to every terminal task whose workspace holds nothing unrecovered, and
// the exemption was replaced by a CLAIM CHECK — a reaped tree's files must be
// findable in projectDir. Five FG-530 worktree cells flipped retained -> reaped
// on the strength of that. So the failure mode that matters here is not a leak;
// it is a REAP THAT DESTROYS UNRECOVERED WORK. Most tests below construct work
// that exists nowhere but the workspace and demand that reconcileRun retain it,
// and every disposition is additionally held to one blunt invariant
// (assertNoWorkDestroyed): if the workspace is gone, every file it held must be
// in projectDir, byte for byte.
//
// Every fixture builds its own repo/worktree/clone under its own temp dir; the
// DB is in-memory. Nothing touches ~/.forge/forge.db and no workspace this suite
// did not create is ever operated on.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { reconcileRun } from "./reconcile.js";
import { worktreeBranchName } from "./worktree-lifecycle.js";
import type { Run, Task, TaskStatus } from "../types/index.js";

const RUN_ID = "run-fg356-drive";
/** A second run, for the blast-radius test: reconciling one run must not reach
 *  into another run's workspaces. */
const OTHER_RUN_ID = "run-fg356-other";

const ALIVE = () => true;
const GONE = () => false;

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg356d-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A real repo with one commit — the projectDir every workspace below hangs off. */
function makeRepo(label = "repo"): string {
  const dir = tmpRoot(label);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg356 drive\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/** A real linked worktree on the deterministic task branch, as createWorktree
 *  makes one. (createWorktree itself refuses to run on Linux per the FG-358
 *  platform gate; the reaper has no such gate and what it operates on is the
 *  worktree, not the code path that produced it.) */
function addWorktree(repo: string, taskId: string, runId = RUN_ID): string {
  const path = join(tmpRoot("wt"), taskId);
  git(repo, "worktree", "add", "-q", path, "-b", worktreeBranchName(runId, taskId));
  return path;
}

/** The agent commits on its task branch. Returns the commit sha. */
function commitInWorkspace(workspace: string, file: string, body = `export const work = "${file}";\n`): string {
  writeFileSync(join(workspace, file), body);
  git(workspace, "add", ".");
  git(workspace, "-c", "user.email=a@b.c", "-c", "user.name=Agent", "commit", "-q", "-m", `agent output ${file}`);
  return git(workspace, "rev-parse", "HEAD").trim();
}

/** Forge's merge-back: the work is now in projectDir, which is what "captured"
 *  means to the reaper. */
function mergeBack(repo: string, taskId: string, runId = RUN_ID): void {
  git(repo, "merge", "--ff-only", worktreeBranchName(runId, taskId));
}

function branchExists(repo: string, taskId: string, runId = RUN_ID): boolean {
  try {
    git(repo, "rev-parse", "--verify", worktreeBranchName(runId, taskId));
    return true;
  } catch {
    return false;
  }
}

function startRunFor(projectDir: string, runId = RUN_ID): void {
  const run: Run = {
    id: runId,
    workflow: "invoke",
    title: "fg356 reaper drive",
    status: "active",
    createdAt: "2026-07-26T00:00:00Z",
    projectDir,
  };
  insertRun(run);
}

function insertTaskRow(
  id: string,
  opts: { status: TaskStatus; workspace?: string; failureKind?: string; runId?: string; containerized?: boolean },
): Task {
  const runId = opts.runId ?? RUN_ID;
  const t: Task = {
    id,
    runId,
    phase: "build",
    agentRole: "engineer",
    status: opts.status,
    taskPackage: { taskId: id, runId, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-26T00:00:00Z",
    startedAt: "2026-07-26T00:00:01Z",
    ...(opts.workspace ? { worktreePath: opts.workspace } : {}),
  };
  insertTask(t);
  if (opts.containerized) {
    logEvent("container.started", { runId, taskId: id, payload: { containerName: `forge-${id}` } });
  }
  if (opts.status === "failed") {
    logEvent("task.failed", {
      runId,
      taskId: id,
      payload: { failure_kind: opts.failureKind ?? "orphaned", error: "reconciled after crash" },
    });
  }
  if (opts.status === "complete") logEvent("task.completed", { runId, taskId: id });
  return t;
}

type WorkspaceEvent = { type: string; payload: Record<string, unknown> };

function workspaceEvents(taskId: string): WorkspaceEvent[] {
  return eventsForTask(taskId)
    .filter((e) => e.eventType === "task.workspace_reaped" || e.eventType === "task.workspace_retained")
    .map((e) => ({ type: e.eventType, payload: (e.payload ?? {}) as Record<string, unknown> }));
}

function onlyEvent(taskId: string): WorkspaceEvent {
  const evs = workspaceEvents(taskId);
  assert.equal(evs.length, 1, `expected exactly one workspace disposition event, got ${JSON.stringify(evs)}`);
  return evs[0]!;
}

/** Every file the workspace holds (tracked, untracked, ignored alike), relative
 *  to its root, with contents. `.git` is workspace plumbing, not work. */
function snapshotFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(relative(root, full), readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return out;
}

/** The one invariant every disposition in this file is held to, whatever it was
 *  supposed to do: work is never destroyed. If the workspace survived, nothing
 *  was lost by construction. If it is gone, reconcileRun claimed the work was
 *  captured — so every file it held must be in projectDir, byte for byte. This is
 *  the integration-level form of FG-530's invariant 4 as FG-356 rewrote it. */
function assertNoWorkDestroyed(workspace: string, before: Map<string, string>, projectDir: string): void {
  if (existsSync(workspace)) return;
  for (const [rel, content] of before) {
    const landed = join(projectDir, rel);
    assert.ok(
      existsSync(landed),
      `the workspace was reaped but ${rel} is not in projectDir — the reap destroyed the only copy of this work`,
    );
    assert.equal(readFileSync(landed, "utf8"), content, `${rel} survived the reap in name only — its contents differ`);
  }
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

// ── 1. The widened removal sanction, driven adversarially ─────────────────────
//
// Each of these tasks is COMPLETE — the status whose removal FG-530's invariant
// used to wave through unchecked — and each workspace holds work that is NOT in
// projectDir. A reap here is the destructive failure this ticket's retain half
// exists to prevent.

test("fg356 drive: a COMPLETE task whose commits never reached projectDir is RETAINED — terminal status is not proof of capture", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-complete-unmerged");
  commitInWorkspace(wt, "only-copy.ts");
  // No merge-back: the crash landed between the merge and the status write, or
  // the merge never happened at all. Either way these commits exist here only.
  insertTaskRow("t-complete-unmerged", { status: "complete", workspace: wt });
  const before = snapshotFiles(wt);
  assert.equal(existsSync(join(repo, "only-copy.ts")), false, "fixture: projectDir must NOT already have the work");

  reconcileRun(RUN_ID, ALIVE);

  assertNoWorkDestroyed(wt, before, repo);
  assert.ok(existsSync(wt), "a completed task's workspace is not reapable merely because the task completed");
  assert.equal(readFileSync(join(wt, "only-copy.ts"), "utf8"), before.get("only-copy.ts"));
  assert.ok(branchExists(repo, "t-complete-unmerged"), "and the branch that carries the commits survives with it");

  const ev = onlyEvent("t-complete-unmerged");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "unmerged_commits");
  assert.equal(ev.payload["workspacePath"], wt);
  assert.equal(ev.payload["branch"], worktreeBranchName(RUN_ID, "t-complete-unmerged"));
  assert.equal(ev.payload["substrate"], "linked_worktree");
  assert.equal(ev.payload["taskStatus"], "complete", "the evidence records the status the reaper decided against");
});

test("fg356 drive: a COMPLETE task with UNCOMMITTED work is RETAINED — a merged branch does not vouch for the working tree", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-complete-dirty");
  commitInWorkspace(wt, "committed.ts");
  mergeBack(repo, "t-complete-dirty");
  // The branch IS captured; the file the agent never committed is not. Reaping
  // on the strength of the branch alone would delete it.
  writeFileSync(join(wt, "never-committed.txt"), "the only copy of this work\n");
  insertTaskRow("t-complete-dirty", { status: "complete", workspace: wt });
  const before = snapshotFiles(wt);

  reconcileRun(RUN_ID, ALIVE);

  assertNoWorkDestroyed(wt, before, repo);
  assert.ok(existsSync(join(wt, "never-committed.txt")), "the uncommitted file is what makes this workspace unsafe to reap");
  assert.equal(readFileSync(join(wt, "never-committed.txt"), "utf8"), "the only copy of this work\n");

  const ev = onlyEvent("t-complete-dirty");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "uncommitted_work");
  assert.deepEqual(ev.payload["details"], ["?? never-committed.txt"], "the evidence names WHAT is unrecovered");
  assert.equal(ev.payload["workspacePath"], wt);
});

test("fg356 drive: work merged and then ROLLED BACK out of projectDir HEAD is retained — capture is checked at reconcile time, not remembered", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-rolledback");
  commitInWorkspace(wt, "rolled-back.ts");
  mergeBack(repo, "t-rolledback");
  assert.ok(existsSync(join(repo, "rolled-back.ts")), "fixture: the merge really did land");
  // The operator (or a failed publication) reset projectDir past the merge. The
  // task branch is now the only place this work exists again.
  git(repo, "reset", "--hard", "-q", "HEAD~1");
  assert.equal(existsSync(join(repo, "rolled-back.ts")), false, "fixture: and was really rolled back out");
  insertTaskRow("t-rolledback", { status: "complete", workspace: wt });
  const before = snapshotFiles(wt);

  reconcileRun(RUN_ID, ALIVE);

  assertNoWorkDestroyed(wt, before, repo);
  assert.ok(existsSync(wt), "the reaper must re-derive capture from the CURRENT HEAD, not from the fact a merge once happened");
  assert.ok(branchExists(repo, "t-rolledback"));
  assert.equal(onlyEvent("t-rolledback").payload["reason"], "unmerged_commits");
});

test("fg356 drive: a workspace whose HEAD advanced past the merged branch tip is retained — the branch is not the whole workspace", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-detached");
  commitInWorkspace(wt, "merged-part.ts");
  mergeBack(repo, "t-detached"); // the BRANCH tip is captured...
  git(wt, "checkout", "-q", "--detach");
  const strandedSha = commitInWorkspace(wt, "detached-part.ts"); // ...this commit is not on it
  insertTaskRow("t-detached", { status: "complete", workspace: wt });
  const before = snapshotFiles(wt);

  reconcileRun(RUN_ID, ALIVE);

  assertNoWorkDestroyed(wt, before, repo);
  assert.ok(existsSync(join(wt, "detached-part.ts")), "the workspace HEAD is probed alongside the branch, so this is not lost");
  const ev = onlyEvent("t-detached");
  assert.equal(ev.payload["reason"], "unmerged_commits");
  assert.deepEqual(ev.payload["details"], [strandedSha], "the evidence names the exact uncaptured commit");
});

test("fg356 drive: the sanction is real — a COMPLETE task whose work IS in projectDir is reaped, file for file", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-captured");
  commitInWorkspace(wt, "captured.ts");
  mergeBack(repo, "t-captured");
  insertTaskRow("t-captured", { status: "complete", workspace: wt });
  const before = snapshotFiles(wt);
  assert.ok(before.size >= 2, "fixture: the workspace holds real content (README + the agent's file)");

  reconcileRun(RUN_ID, ALIVE);

  assert.equal(existsSync(wt), false, "a redundant tree is a leak — nothing else in forge ever revisits it");
  assert.equal(branchExists(repo, "t-captured"), false, "and its branch goes with it");
  // The claim check, not the status exemption: every byte the tree held is in projectDir.
  assertNoWorkDestroyed(wt, before, repo);

  const ev = onlyEvent("t-captured");
  assert.equal(ev.type, "task.workspace_reaped");
  assert.equal(ev.payload["reason"], "work_captured");
  assert.equal(ev.payload["substrate"], "linked_worktree");
  assert.equal(ev.payload["branchRemoved"], true);
  assert.equal(ev.payload["taskStatus"], "complete");
  assert.equal(ev.payload["workspacePath"], wt);
  assert.equal(ev.payload["branch"], worktreeBranchName(RUN_ID, "t-captured"));
});

// ── 2. The retain-by-design failure kinds, as an enforcement contract ─────────
//
// RETAIN_WORKSPACE_FAILURE_KINDS (src/v2/reconcile.ts) short-circuits the git
// probe entirely: these kinds keep their workspace because the KIND says so, not
// because git happened to disagree with removal. So every fixture here is clean
// AND fully merged — i.e. it would be reaped if the kind guard were removed, which
// the control below proves against the identical fixture. A fixture that would
// have been retained anyway would prove nothing.
//
// fg356-reaper-parity.integration.test.ts fails if a kind is added to that set in
// production without being added to this table.

const RETAIN_BY_DESIGN_KINDS = [
  "merge_conflict", // FG-352
  "integration_failed", // FG-357
  "integration_gate_timeout",
  "integration_gate_crashed",
  "publish_base_churn", // FG-425
  "publication_refused",
  "dirty_publish_target",
] as const;

for (const kind of RETAIN_BY_DESIGN_KINDS) {
  test(`fg356 drive: a task failed with ${kind} keeps its workspace AND branch even when the tree is clean and fully merged`, () => {
    const repo = makeRepo();
    startRunFor(repo);
    const taskId = `t-kind-${kind}`;
    const wt = addWorktree(repo, taskId);
    commitInWorkspace(wt, "work.ts");
    mergeBack(repo, taskId); // reapable on the git probe alone — the kind is the only thing retaining it
    insertTaskRow(taskId, { status: "failed", workspace: wt, failureKind: kind });

    reconcileRun(RUN_ID, ALIVE);

    assert.ok(existsSync(wt), `${kind} retains its workspace by design — it IS the evidence the operator inspects`);
    assert.ok(branchExists(repo, taskId), `${kind} retains its branch too — the operator rebases/republishes from it`);

    const ev = onlyEvent(taskId);
    assert.equal(ev.type, "task.workspace_retained");
    assert.equal(ev.payload["reason"], "retained_failure_kind", "the kind guard answers without probing git at all");
    assert.deepEqual(ev.payload["details"], [kind], "and the evidence names which kind decided it");
    assert.equal(ev.payload["workspacePath"], wt);
    assert.equal(ev.payload["branch"], worktreeBranchName(RUN_ID, taskId));
    assert.equal(ev.payload["substrate"], "linked_worktree");
    assert.equal(ev.payload["taskStatus"], "failed");
  });
}

for (const kind of ["orphaned", "orphaned_work_may_persist", "oom_killed", "container_crash"]) {
  test(`fg356 drive: control — the SAME clean, merged fixture failing with ${kind} IS reaped, so the kind is what retains, not the git probe`, () => {
    const repo = makeRepo();
    startRunFor(repo);
    const taskId = `t-control-${kind}`;
    const wt = addWorktree(repo, taskId);
    commitInWorkspace(wt, "work.ts");
    mergeBack(repo, taskId);
    insertTaskRow(taskId, { status: "failed", workspace: wt, failureKind: kind });
    const before = snapshotFiles(wt);

    reconcileRun(RUN_ID, ALIVE);

    assert.equal(existsSync(wt), false, `${kind} carries no retention contract — the redundant tree is swept`);
    assert.equal(branchExists(repo, taskId), false);
    assertNoWorkDestroyed(wt, before, repo);
    assert.equal(onlyEvent(taskId).type, "task.workspace_reaped");
  });
}

// ── 3. Removal that git refuses, and the blast radius ─────────────────────────

test("fg356 drive: a worktree of ANOTHER repository is never removed — ownership is checked before the removal is attempted", () => {
  const repo = makeRepo();
  startRunFor(repo);
  // A different repository's worktree that happens to sit at a commit projectDir
  // also has (a clone shares SHAs), on a branch named exactly like this run's —
  // so every capture check passes and only ownership stands between the reaper
  // and someone else's tree.
  const foreignRepo = join(tmpRoot("foreign"), "clone");
  execFileSync("git", ["clone", "--quiet", repo, foreignRepo], { stdio: ["ignore", "ignore", "pipe"] });
  const foreignWt = join(tmpRoot("foreign-wt"), "t-foreign");
  git(foreignRepo, "worktree", "add", "-q", foreignWt, "-b", worktreeBranchName(RUN_ID, "t-foreign"));

  // The fixture is deliberately NOT vacuous: this tree is a linked worktree, it
  // is clean, and its HEAD is a commit projectDir already has — so every capture
  // check passes and the reaper really does reach the removal. Ownership is the
  // only thing left between it and someone else's tree.
  insertTaskRow("t-foreign", { status: "failed", workspace: foreignWt, failureKind: "orphaned" });
  git(repo, "merge-base", "--is-ancestor", git(foreignWt, "rev-parse", "HEAD").trim(), "HEAD");
  assert.equal(git(foreignWt, "status", "--porcelain").trim(), "", "fixture: the foreign tree is clean");

  reconcileRun(RUN_ID, ALIVE);

  assert.ok(existsSync(foreignWt), "the tree reports a different repository as its own, so it is not this run's to dispose of");
  assert.ok(existsSync(join(foreignWt, "README.md")), "with its checkout intact");
  assert.ok(
    branchExists(foreignRepo, "t-foreign"),
    "and the branch it is checked out on — deleting that would strand the foreign worktree",
  );
  assert.ok(
    git(foreignRepo, "worktree", "list").includes(foreignWt),
    "and the foreign repo's worktree registration is intact — nothing was pruned out from under it",
  );

  const ev = onlyEvent("t-foreign");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "workspace_not_owned", "and the refusal names ownership, not a failed removal");
  assert.equal(ev.payload["workspacePath"], foreignWt);
  assert.equal(ev.payload["substrate"], "linked_worktree");
  assert.ok(
    (ev.payload["details"] as string[]).some((d) => d.includes("belongs to")),
    "the evidence names the repository the tree actually belongs to",
  );
});

test("fg356 drive: a row pointing at ANOTHER task's worktree of the SAME repo retains — every capture check passes on a tree that is not ours", () => {
  const repo = makeRepo();
  startRunFor(repo);

  // The neighbour: same repository, same parent object store, its own
  // deterministic branch, clean, and already merged back — so the clean-tree and
  // reachable-commits checks both pass on it. It belongs to a task that is still
  // running, and reconciling this run must leave it exactly where it is.
  const neighbour = addWorktree(repo, "t-neighbour");
  commitInWorkspace(neighbour, "neighbour.ts");
  mergeBack(repo, "t-neighbour");
  insertTaskRow("t-neighbour", { status: "running", workspace: neighbour, containerized: true });

  // The orphan: a stale/misassigned worktree_path naming the NEIGHBOUR's tree.
  // Its real workspace sits elsewhere and is still registered on its own branch.
  const own = addWorktree(repo, "t-misassigned");
  commitInWorkspace(own, "own.ts");
  mergeBack(repo, "t-misassigned");
  insertTaskRow("t-misassigned", { status: "failed", workspace: neighbour, failureKind: "orphaned" });

  // The fixture is deliberately NOT vacuous: the neighbour's tree is clean and
  // its history is captured, so every capture check passes on it and nothing but
  // ownership stands between the reaper and someone else's workspace.
  assert.equal(git(neighbour, "status", "--porcelain", "--ignored").trim(), "", "fixture: the neighbour is clean");
  git(repo, "merge-base", "--is-ancestor", git(neighbour, "rev-parse", "HEAD").trim(), "HEAD");
  git(repo, "merge-base", "--is-ancestor", git(repo, "rev-parse", worktreeBranchName(RUN_ID, "t-misassigned")).trim(), "HEAD");

  const before = snapshotFiles(neighbour);

  reconcileRun(RUN_ID, ALIVE);

  assert.ok(existsSync(neighbour), "the neighbour's workspace is not this task's to dispose of");
  assert.ok(existsSync(join(neighbour, "neighbour.ts")), "with its checkout intact");
  assert.ok(
    git(repo, "worktree", "list").includes(neighbour),
    "and its worktree registration intact — nothing was pruned out from under a live task",
  );
  assert.ok(branchExists(repo, "t-neighbour"), "and the branch it is checked out on");
  assert.ok(
    branchExists(repo, "t-misassigned"),
    "and the orphan's OWN branch survives — a reap of the wrong tree would have deleted it out from under the right one",
  );
  assert.ok(existsSync(join(own, "own.ts")), "whose workspace the reaper never looked at either");
  assertNoWorkDestroyed(neighbour, before, repo);
  assert.deepEqual(workspaceEvents("t-neighbour"), [], "and nothing is recorded against the neighbour's own task");

  const ev = onlyEvent("t-misassigned");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "workspace_not_owned");
  assert.equal(ev.payload["workspacePath"], neighbour);
  assert.equal(ev.payload["branch"], worktreeBranchName(RUN_ID, "t-misassigned"));
  assert.equal(ev.payload["substrate"], "linked_worktree");
  assert.ok(
    (ev.payload["details"] as string[]).some((d) =>
      d.includes(worktreeBranchName(RUN_ID, "t-neighbour")) && d.includes(worktreeBranchName(RUN_ID, "t-misassigned")),
    ),
    "the evidence names the branch the tree is on and the branch it should have been on",
  );
});

test("fg356 drive: a removal git cannot complete is recorded as removal_failed, not assumed successful", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-undeletable");
  commitInWorkspace(wt, "work.ts");
  mergeBack(repo, "t-undeletable");
  insertTaskRow("t-undeletable", { status: "failed", workspace: wt, failureKind: "orphaned" });
  const before = snapshotFiles(wt);

  // Owned, clean, captured — the reaper reaches the removal, and git cannot
  // unlink the tree's contents because the tree itself is not writable.
  chmodSync(wt, 0o500);
  try {
    reconcileRun(RUN_ID, ALIVE);
  } finally {
    chmodSync(wt, 0o700);
  }

  assert.ok(existsSync(wt), "a removal that did not happen leaves the tree");
  assertNoWorkDestroyed(wt, before, repo);
  const ev = onlyEvent("t-undeletable");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "removal_failed", "a removal git declined is recorded, not assumed successful");
  assert.equal(ev.payload["workspacePath"], wt);
});

test("fg356 drive: reconciling one run never touches another run's workspaces", () => {
  const repo = makeRepo();
  startRunFor(repo);
  startRunFor(repo, OTHER_RUN_ID);

  const mine = addWorktree(repo, "t-mine");
  commitInWorkspace(mine, "mine.ts");
  mergeBack(repo, "t-mine");
  insertTaskRow("t-mine", { status: "failed", workspace: mine, failureKind: "orphaned" });

  // Same repo, same reapable shape, different run — and a live one at that.
  const theirs = addWorktree(repo, "t-theirs", OTHER_RUN_ID);
  commitInWorkspace(theirs, "theirs.ts");
  mergeBack(repo, "t-theirs", OTHER_RUN_ID);
  insertTaskRow("t-theirs", { status: "failed", workspace: theirs, failureKind: "orphaned", runId: OTHER_RUN_ID });

  reconcileRun(RUN_ID, ALIVE);

  assert.equal(existsSync(mine), false, "this run's redundant tree is swept");
  assert.ok(existsSync(theirs), "the other run's is not — reconcile is scoped to the run it was asked about");
  assert.ok(branchExists(repo, "t-theirs", OTHER_RUN_ID));
  assert.deepEqual(workspaceEvents("t-theirs"), [], "and nothing is recorded against a task of another run");
});

// ── 4. Non-terminal tasks ─────────────────────────────────────────────────────

for (const status of ["running", "awaiting_gate", "blocked_by_red"] as const) {
  test(`fg356 drive: a ${status} task's workspace is untouched — reconcile must not reap out from under live/held work`, () => {
    const repo = makeRepo();
    startRunFor(repo);
    const taskId = `t-live-${status}`;
    const wt = addWorktree(repo, taskId);
    commitInWorkspace(wt, "in-progress.ts");
    mergeBack(repo, taskId); // reapable in every respect EXCEPT the status
    insertTaskRow(taskId, { status, workspace: wt, containerized: status === "running" });

    reconcileRun(RUN_ID, ALIVE); // container alive: a running task stays running

    assert.equal(getTask(taskId)!.status, status, "fixture: the status under test survived the pass");
    assert.ok(existsSync(wt), `a ${status} task still has a claim on its workspace`);
    assert.ok(branchExists(repo, taskId));
    assert.deepEqual(workspaceEvents(taskId), [], "and there is no disposition to record yet, so nothing is recorded");
  });
}

test("fg356 drive: the non-terminal fixtures really were reapable — the same workspace is swept once the task goes terminal", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-held-then-terminal");
  commitInWorkspace(wt, "in-progress.ts");
  mergeBack(repo, "t-held-then-terminal");
  const t = insertTaskRow("t-held-then-terminal", { status: "blocked_by_red", workspace: wt });

  reconcileRun(RUN_ID, ALIVE);
  assert.ok(existsSync(wt), "held while blocked_by_red");

  // The red cleared; the task lands terminal. Nothing else about the fixture changed.
  db.prepare(`UPDATE tasks SET status = 'complete' WHERE id = ?`).run(t.id);
  logEvent("task.completed", { runId: RUN_ID, taskId: t.id });

  reconcileRun(RUN_ID, ALIVE);
  assert.equal(existsSync(wt), false, "so the status was the ONLY thing retaining it — the guard is load-bearing");
  assert.equal(onlyEvent("t-held-then-terminal").type, "task.workspace_reaped");
});

// ── 5. The real orphan path: finalize and reap in ONE reconcile ───────────────
//
// The leak FG-356 exists for: the crash that stranded the task is the crash that
// skipped its cleanup. These two drive the actual crash shape — a `running` task
// whose container is gone — and assert that the SAME pass that finalizes it also
// disposes of its workspace correctly.

test("fg356 drive: a crashed running task is finalized AND its captured workspace reaped in the same reconcile pass", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-crash-captured");
  commitInWorkspace(wt, "captured.ts");
  mergeBack(repo, "t-crash-captured"); // the merge landed; the process died before cleanup
  insertTaskRow("t-crash-captured", { status: "running", workspace: wt, containerized: true });
  const before = snapshotFiles(wt);

  const result = reconcileRun(RUN_ID, GONE);

  assert.equal(getTask("t-crash-captured")!.status, "failed", "fixture: reconcile really did finalize the orphan");
  assert.ok(result.taskChanges.some((c) => c.taskId === "t-crash-captured" && c.to === "failed"));
  assert.equal(existsSync(wt), false, "and the same pass swept the tree the crash left behind — no second command needed");
  assert.equal(branchExists(repo, "t-crash-captured"), false);
  assertNoWorkDestroyed(wt, before, repo);
  assert.equal(onlyEvent("t-crash-captured").type, "task.workspace_reaped");
});

test("fg356 drive: a crashed running task whose work was never captured is finalized and its workspace RETAINED with evidence", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-crash-uncaptured");
  writeFileSync(join(wt, "agent-was-mid-edit.ts"), "half-written work\n");
  insertTaskRow("t-crash-uncaptured", { status: "running", workspace: wt, containerized: true });
  const before = snapshotFiles(wt);

  reconcileRun(RUN_ID, GONE);

  assert.equal(getTask("t-crash-uncaptured")!.status, "failed");
  assertNoWorkDestroyed(wt, before, repo);
  assert.ok(existsSync(join(wt, "agent-was-mid-edit.ts")), "finalizing a crashed task must never discard what it was writing");
  const ev = onlyEvent("t-crash-uncaptured");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "uncommitted_work");
  assert.equal(ev.payload["workspacePath"], wt, "the operator is told where the surviving work is");
  assert.equal(ev.payload["branch"], worktreeBranchName(RUN_ID, "t-crash-uncaptured"));
  assert.equal(getTask("t-crash-uncaptured")!.worktreePath, wt, "and the row still points at it");
});

// ── 6. Idempotence and re-entry over repeated reconciles ──────────────────────

test("fg356 drive: a retained workspace is recorded once per reason, and recovering the work lets a later pass reap it", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-reentry");
  writeFileSync(join(wt, "recovered.ts"), "work the agent never committed\n");
  insertTaskRow("t-reentry", { status: "failed", workspace: wt, failureKind: "orphaned" });

  // Pass 1-2: uncommitted work. The retention is recorded ONCE, not once per pass.
  reconcileRun(RUN_ID, ALIVE);
  reconcileRun(RUN_ID, ALIVE);
  let evs = workspaceEvents("t-reentry");
  assert.equal(evs.length, 1, "reconcile runs on every lifecycle command — a per-pass re-log would flood the timeline");
  assert.equal(evs[0]!.payload["reason"], "uncommitted_work");
  assert.ok(existsSync(wt));

  // The operator commits it. The reason CHANGES, so a new disposition is recorded —
  // the dedupe is per (task, reason), which is what keeps the timeline truthful.
  commitInWorkspace(wt, "recovered.ts", "work the agent never committed\n");
  reconcileRun(RUN_ID, ALIVE);
  reconcileRun(RUN_ID, ALIVE);
  evs = workspaceEvents("t-reentry");
  assert.equal(evs.length, 2, "a different reason is a different fact about the workspace");
  assert.equal(evs[1]!.payload["reason"], "unmerged_commits");
  assert.ok(existsSync(wt), "still unmerged, so still retained");

  // The operator merges it back. The work is now captured and the next pass reaps.
  const before = snapshotFiles(wt);
  mergeBack(repo, "t-reentry");
  reconcileRun(RUN_ID, ALIVE);

  assert.equal(existsSync(wt), false, "the reaper is re-entrant: a workspace it declined once is reconsidered, not written off");
  assertNoWorkDestroyed(wt, before, repo);
  evs = workspaceEvents("t-reentry");
  assert.equal(evs.length, 3);
  assert.equal(evs[2]!.type, "task.workspace_reaped");

  // And it settles: further passes over a reaped workspace change nothing.
  for (let pass = 0; pass < 3; pass++) reconcileRun(RUN_ID, ALIVE);
  assert.equal(workspaceEvents("t-reentry").length, 3, "an absent workspace records nothing, forever");
  assert.equal(existsSync(wt), false);
});

test("fg356 drive: one pass over a run of mixed dispositions settles all of them, and the second pass is a fixpoint", () => {
  const repo = makeRepo();
  startRunFor(repo);

  const reaped = addWorktree(repo, "t-mix-reap");
  commitInWorkspace(reaped, "captured.ts");
  mergeBack(repo, "t-mix-reap");
  insertTaskRow("t-mix-reap", { status: "complete", workspace: reaped });

  const dirty = addWorktree(repo, "t-mix-dirty");
  writeFileSync(join(dirty, "uncommitted.txt"), "unrecovered\n");
  insertTaskRow("t-mix-dirty", { status: "failed", workspace: dirty, failureKind: "orphaned" });

  const conflicted = addWorktree(repo, "t-mix-conflict");
  commitInWorkspace(conflicted, "conflict.ts");
  mergeBack(repo, "t-mix-conflict");
  insertTaskRow("t-mix-conflict", { status: "failed", workspace: conflicted, failureKind: "merge_conflict" });

  const held = addWorktree(repo, "t-mix-held");
  commitInWorkspace(held, "held.ts");
  mergeBack(repo, "t-mix-held");
  insertTaskRow("t-mix-held", { status: "awaiting_gate", workspace: held });

  insertTaskRow("t-mix-absent", { status: "failed", workspace: join(repo, "never-existed"), failureKind: "orphaned" });

  for (let pass = 1; pass <= 3; pass++) {
    reconcileRun(RUN_ID, ALIVE);
    assert.equal(existsSync(reaped), false, `pass ${pass}: the captured tree stays reaped`);
    assert.ok(existsSync(dirty), `pass ${pass}: the dirty tree stays retained`);
    assert.ok(existsSync(conflicted), `pass ${pass}: the merge_conflict tree stays retained`);
    assert.ok(existsSync(held), `pass ${pass}: the held tree is never considered`);
    assert.equal(workspaceEvents("t-mix-reap").length, 1, `pass ${pass}: one reap event`);
    assert.equal(workspaceEvents("t-mix-dirty").length, 1, `pass ${pass}: one retain event`);
    assert.equal(workspaceEvents("t-mix-conflict").length, 1, `pass ${pass}: one retain event`);
    assert.deepEqual(workspaceEvents("t-mix-held"), [], `pass ${pass}: nothing for the held task`);
    assert.deepEqual(workspaceEvents("t-mix-absent"), [], `pass ${pass}: nothing for an absent workspace`);
  }
});

// ── 7. The branch deletion is retried until it lands ──────────────────────────
//
// A reap removes the tree and THEN deletes the branch. A failure in that second
// step used to be permanent: every later pass found the workspace absent,
// returned early, and the forge/<runId>/<taskId> ref was stranded forever.

/** A `git` shim on PATH that fails the FIRST `git branch -d` and forwards
 *  everything else to the real git — a transient failure of exactly the step
 *  that runs after the point of no return. Returns the restore. */
function failFirstBranchDelete(): () => void {
  const dir = tmpRoot("gitshim");
  const marker = join(dir, "already-failed");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = join(dir, "git");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `if [ "$1" = "branch" ] && [ "$2" = "-d" ] && [ ! -f "${marker}" ]; then`,
      `  : > "${marker}"`,
      '  echo "fatal: simulated transient failure" >&2',
      "  exit 1",
      "fi",
      `exec "${realGit}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  const before = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${before}`;
  return () => {
    process.env.PATH = before;
  };
}

test("fg356 drive: a branch deletion that failed on the reaping pass is retried on a later one — a transient failure never strands the ref", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-branch-retry");
  commitInWorkspace(wt, "captured.ts");
  mergeBack(repo, "t-branch-retry");
  insertTaskRow("t-branch-retry", { status: "complete", workspace: wt });

  const restorePath = failFirstBranchDelete();
  try {
    reconcileRun(RUN_ID, ALIVE);
  } finally {
    restorePath();
  }

  assert.equal(existsSync(wt), false, "the tree was removed");
  assert.ok(branchExists(repo, "t-branch-retry"), "but `git branch -d` failed, so the ref outlived it");
  let evs = workspaceEvents("t-branch-retry");
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.payload["branchRemoved"], false, "and the disagreement is recorded rather than forced");

  // The next reconcile sees an absent workspace — exactly where the retry used
  // to be skipped.
  reconcileRun(RUN_ID, ALIVE);
  assert.equal(branchExists(repo, "t-branch-retry"), false, "the later pass retries the deletion it lost");
  evs = workspaceEvents("t-branch-retry");
  assert.equal(evs.length, 2, "and records that the ref finally went");
  assert.equal(evs[1]!.type, "task.workspace_reaped");
  assert.equal(evs[1]!.payload["reason"], "branch_deletion_retried");
  assert.equal(evs[1]!.payload["branch"], worktreeBranchName(RUN_ID, "t-branch-retry"));
  assert.equal(evs[1]!.payload["branchRemoved"], true);

  for (let pass = 0; pass < 3; pass++) reconcileRun(RUN_ID, ALIVE);
  assert.equal(workspaceEvents("t-branch-retry").length, 2, "the retry is a one-shot, not a per-pass re-log");
});

test("fg356 drive: a branch its workspace outlived but git will not delete is left alone across passes — never -D", () => {
  const repo = makeRepo();
  startRunFor(repo);
  const wt = addWorktree(repo, "t-branch-unmerged");
  const tip = commitInWorkspace(wt, "never-captured.ts");
  // The tree is gone — cleared by hand, or by a host that reclaims tmp — but its
  // commit never reached projectDir, so `-d` refuses the ref and it must stay.
  git(repo, "worktree", "remove", "--force", wt);
  insertTaskRow("t-branch-unmerged", { status: "failed", workspace: wt, failureKind: "orphaned" });

  const branch = worktreeBranchName(RUN_ID, "t-branch-unmerged");
  for (let pass = 1; pass <= 3; pass++) {
    reconcileRun(RUN_ID, ALIVE);
    assert.ok(branchExists(repo, "t-branch-unmerged"), `pass ${pass}: an unmerged branch is never forced`);
    assert.equal(git(repo, "rev-parse", branch).trim(), tip, `pass ${pass}: still pointing at the uncaptured work`);
    assert.deepEqual(workspaceEvents("t-branch-unmerged"), [], `pass ${pass}: a no-op records nothing`);
  }
});
