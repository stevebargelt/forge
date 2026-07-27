// FG-621 — reaping a PRIVATE CLONE (AC 9, AC 10), over real repositories.
//
// The clone branch of reapTaskWorkspace is where "provably safe or it does not
// happen" is hardest, because classification cannot help: a private clone and the
// operator's live source checkout both have a `.git` DIRECTORY, so both classify
// as `private_clone`. Before FG-621 that ambiguity was resolved by refusing to
// reap the substrate at all. It is now resolved by an OWNERSHIP PROOF a main
// checkout cannot forge — a `--shared` clone's `objects/info/alternates` resolves
// to the parent's object store, and no repository is ever its own alternate.
//
// Every proof gets its own test, positive and negative, because a reaper whose
// gates are only tested in aggregate is a reaper whose gates can silently stop
// firing one at a time.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { reconcileRun } from "./reconcile.js";
import { classifyWorkspace, reapTaskWorkspace, worktreeBranchName } from "./worktree-lifecycle.js";

const RUN_ID = "run-fg621-reaper";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg621r-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(label = "repo"): string {
  const dir = tmpRoot(label);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg621 reaper\n");
  writeFileSync(join(dir, ".gitignore"), "build/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/** A private `--shared` clone on the task's deterministic branch, exactly the
 *  shape createTaskClone produces (built with plain git so this suite tests the
 *  REAPER, not the constructor). */
function makeClone(parent: string, taskId: string, label = "clone"): string {
  const path = join(tmpRoot(label), taskId);
  execFileSync("git", ["clone", "--quiet", "--shared", parent, path], { stdio: ["ignore", "ignore", "pipe"] });
  git(path, "config", "user.email", "agent@forge.test");
  git(path, "config", "user.name", "Agent");
  git(path, "checkout", "-q", "-b", worktreeBranchName(RUN_ID, taskId));
  return path;
}

function agentCommit(clonePath: string, file: string): string {
  writeFileSync(join(clonePath, file), `export const work = "${file}";\n`);
  git(clonePath, "add", ".");
  git(clonePath, "commit", "-q", "-m", `agent output ${file}`);
  return git(clonePath, "rev-parse", "HEAD").trim();
}

/** Forge's capture: the clone's branch is fetched into the parent's ref namespace
 *  under the same deterministic name. */
function capture(parent: string, clonePath: string, taskId: string): void {
  const branch = worktreeBranchName(RUN_ID, taskId);
  git(parent, "fetch", "--quiet", clonePath, `${branch}:refs/heads/${branch}`);
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
    } catch { /* best-effort */ }
  }
});

// ── AC 9: the full proof, positively ──────────────────────────────────────────

test("fg621 (AC 9): a clone that is owned, clean and fully reachable is REAPED — directory, private refs and all", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-ok");
  agentCommit(clone, "captured.ts");
  capture(repo, clone, "t-ok");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-ok"));

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-ok", repo);

  assert.equal(outcome.action, "reaped");
  assert.equal(outcome.action === "reaped" ? outcome.substrate : "", "private_clone");
  assert.equal(existsSync(clone), false, "the directory IS the repository — removing it disposes of both");
  assert.ok(existsSync(join(repo, "captured.ts")), "and the work is where the proof said it was");
});

test("fg621 (AC 9): the capture set reads the CLONE's own tips, not just the parent's ref — a partial capture still blocks the reap", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-partial");
  const branch = worktreeBranchName(RUN_ID, "t-partial");

  // One capture happened, and its commit is genuinely in the parent. Then the
  // agent committed again. The parent-side ref alone says "all captured"; the
  // clone is a FULL repository and its own tips say otherwise.
  agentCommit(clone, "captured.ts");
  capture(repo, clone, "t-partial");
  git(repo, "merge", "--ff-only", branch);
  const uncaptured = agentCommit(clone, "never-fetched.ts");

  assert.notEqual(git(repo, "rev-parse", branch).trim(), uncaptured, "fixture: the parent's ref is behind the clone");

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-partial", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "unmerged_commits");
  assert.deepEqual(
    outcome.action === "retained" ? outcome.details : [],
    [uncaptured],
    "the evidence names the commit at stake, de-duplicated — HEAD and the clone's branch are the same tip here",
  );
  assert.ok(existsSync(join(clone, "never-fetched.ts")));
});

// ── AC 10: every proof that fails RETAINS, with a named reason ────────────────

test("fg621 (AC 10): a clone whose ALTERNATES point at another repository is retained as not-owned", () => {
  const repo = makeRepo();
  const stranger = makeRepo("stranger");
  const foreign = makeClone(stranger, "t-foreign");

  const outcome = reapTaskWorkspace(foreign, RUN_ID, "t-foreign", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "workspace_not_owned");
  assert.ok(
    outcome.action === "retained" && outcome.details.some((d) => d.includes("alternates")),
    "and the evidence names the proof that failed",
  );
  assert.ok(existsSync(foreign), "somebody else's clone is not forge's to delete");
});

test("fg621 (AC 10): an ORDINARY (non-shared) clone of the SAME repository is retained — it borrows nothing, so it owns everything in it", () => {
  const repo = makeRepo();
  const path = join(tmpRoot("plain"), "t-plain");
  execFileSync("git", ["clone", "--quiet", repo, path], { stdio: ["ignore", "ignore", "pipe"] });
  git(path, "checkout", "-q", "-b", worktreeBranchName(RUN_ID, "t-plain"));
  assert.equal(classifyWorkspace(path), "private_clone", "it classifies identically — only the alternates differ");

  const outcome = reapTaskWorkspace(path, RUN_ID, "t-plain", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "workspace_not_owned");
  assert.ok(existsSync(path));
});

test("fg621 (AC 10): the LIVE SOURCE checkout can never be reaped — it is its own repository, and no repository is its own alternate", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "operator-uncommitted.txt"), "the operator's live edit\n");

  const outcome = reapTaskWorkspace(repo, RUN_ID, "t-livesource", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "workspace_not_owned");
  assert.ok(existsSync(join(repo, "README.md")), "the operator's source survives verbatim");
  assert.ok(existsSync(join(repo, "operator-uncommitted.txt")));
});

test("fg621 (AC 10): ANOTHER task's clone is retained — the ownership proof is about the repository, the branch check about the task", () => {
  const repo = makeRepo();
  const theirs = makeClone(repo, "t-theirs");
  agentCommit(theirs, "their-work.ts");

  // The recorded path names a workspace belonging to a DIFFERENT task. It is a
  // legitimate clone of this very repository, so the ALTERNATES half of the proof
  // passes — what refuses it is the branch half: the workspace is not checked out
  // on this task's deterministic branch.
  const outcome = reapTaskWorkspace(theirs, RUN_ID, "t-ours", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "workspace_not_owned");
  assert.ok(
    outcome.action === "retained" && outcome.details.some((d) => d.includes("t-ours")),
    "and the evidence names the branch it was expected to be on",
  );
  assert.ok(existsSync(theirs), "a misassigned workspace_path must never dispose of another task's work");
  assert.ok(existsSync(join(theirs, "their-work.ts")));
});

test("fg621 (AC 10): another task's clone is refused even when its work IS captured and its tree clean — every capture check would sanction it", () => {
  const repo = makeRepo();
  const theirs = makeClone(repo, "t-sibling");
  agentCommit(theirs, "sibling-work.ts");
  capture(repo, theirs, "t-sibling");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-sibling"));

  // Clean, and holding nothing the parent cannot reach: `uncommitted_work` and
  // `unmerged_commits` both pass trivially. Ownership is the only thing standing
  // between a stale workspace_path and a tree the reaper was never asked about.
  const outcome = reapTaskWorkspace(theirs, RUN_ID, "t-someone-else", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "workspace_not_owned");
  assert.ok(existsSync(theirs));
});

test("fg621 (AC 10): a DIRTY clone is retained — including when the only output is on a git-IGNORED path", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-dirty");
  agentCommit(clone, "committed.ts");
  capture(repo, clone, "t-dirty");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-dirty"));

  // Tracked-clean, but holding build output on an ignored path — work that
  // exists nowhere but here.
  execFileSync("mkdir", ["-p", join(clone, "build")]);
  writeFileSync(join(clone, "build", "artifact.js"), "// the only copy\n");
  assert.equal(git(clone, "status", "--porcelain").trim(), "", "fixture: tracked-clean, so only --ignored can see it");

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-dirty", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "uncommitted_work");
  assert.ok(existsSync(join(clone, "build", "artifact.js")));
});

test("fg621 (AC 10): a clone holding commits no Forge-owned ref reaches is retained as unmerged", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-unmerged");
  const sha = agentCommit(clone, "never-captured.ts");

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-unmerged", repo);

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "unmerged_commits");
  assert.ok(outcome.action === "retained" && outcome.details.includes(sha), "and the evidence names the commit");
  assert.ok(existsSync(join(clone, "never-captured.ts")));
});

// ── The reachability AUTHORITY: receipts, not the HEAD proxy ──────────────────

test("fg621: a PUBLISHED receipt proves capture even though projectDir's HEAD never moved — the remote-target case", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-remote");
  const tip = agentCommit(clone, "published-to-a-remote.ts");
  capture(repo, clone, "t-remote");

  // A `remote:` target never advances local HEAD, so the HEAD proxy alone would
  // retain this clone forever. Forge's own receipt is the authority: the
  // candidate that CARRIES this commit was published.
  const candidate = git(repo, "rev-parse", worktreeBranchName(RUN_ID, "t-remote")).trim();
  assert.equal(candidate, tip);
  assert.notEqual(git(repo, "rev-parse", "HEAD").trim(), tip, "fixture: HEAD genuinely did not move");

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-remote", repo, {
    anchors: [candidate],
    target: "remote:origin#main",
  });

  assert.equal(outcome.action, "reaped", "the receipt is Forge-owned state, and it reaches the work");
  assert.equal(existsSync(clone), false);
  // FG-356 fixed ref-stranding; a receipt-proven reap must not reintroduce it.
  // `git branch -d` only knows about HEAD, which a `remote:` target never
  // advances — so the tree would go and the parent-side ref would be left
  // behind, with nothing to retry it.
  assert.equal(outcome.action === "reaped" ? outcome.branchRemoved : false, true, "the ref went with the tree");
  assert.throws(
    () => git(repo, "rev-parse", "--verify", worktreeBranchName(RUN_ID, "t-remote")),
    "the parent-side ref is gone — disposed of on the same proof that authorized the reap",
  );
});

test("fg621: the RETRY lane disposes of a stranded ref on the receipt that authorized the reap, not on `git branch -d`", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-retry");
  const tip = agentCommit(clone, "published-to-a-remote.ts");
  capture(repo, clone, "t-retry");
  const branch = worktreeBranchName(RUN_ID, "t-retry");
  const authority = { anchors: [tip], target: "remote:origin#main" };

  // The window this covers: the tree went, the `git branch -d` that should have
  // followed it did not (a transient failure, a crash between the two steps).
  // Every later pass now arrives here with the workspace ABSENT and the ref still
  // standing — which is the FG-356 ref-stranding class, so the retry has to run on
  // the same warrant the first pass did.
  rmSync(clone, { recursive: true, force: true });
  assert.equal(classifyWorkspace(clone), "absent", "fixture: the tree really is gone");
  assert.equal(git(repo, "rev-parse", branch).trim(), tip, "fixture: and the ref really did outlive it");
  assert.notEqual(git(repo, "rev-parse", "HEAD").trim(), tip, "fixture: a remote target never advanced HEAD");

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-retry", repo, authority);

  // A merged-only retry refuses this ref on THIS pass and on every pass after it:
  // the tip is proven captured by a receipt, and receipts have nothing to do with
  // reachability from HEAD. Retrying under a predicate that can never succeed
  // strands the ref exactly as permanently as never retrying at all.
  assert.equal(outcome.action, "branch_reaped", `the stranded ref must be retried and disposed of; got ${outcome.action}`);
  assert.throws(
    () => git(repo, "rev-parse", "--verify", branch),
    "the ref is gone — same proof, same warrant, on the retry lane too",
  );
  assert.equal(
    reapTaskWorkspace(clone, RUN_ID, "t-retry", repo, authority).action,
    "absent",
    "and the pass after that has nothing left to do",
  );
});

test("fg621: the retry lane still refuses a stranded ref NOTHING proves captured", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-retry-unproven");
  const tip = agentCommit(clone, "only-copy.ts");
  capture(repo, clone, "t-retry-unproven");
  const branch = worktreeBranchName(RUN_ID, "t-retry-unproven");

  // The other half of the same rule. Widening the retry past `git branch -d` must
  // not widen it to "delete whatever is left": with the tree gone, this ref is the
  // ONLY copy of the work, and no receipt and no HEAD reaches it.
  rmSync(clone, { recursive: true, force: true });
  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-retry-unproven", repo, { anchors: [] });

  assert.equal(outcome.action, "absent", "nothing was disposed of, and nothing is recorded");
  assert.equal(git(repo, "rev-parse", branch).trim(), tip, "the ref — the last copy of the work — still stands");
});

test("fg621: a ref whose tip NOTHING proves captured is never forced, even when the workspace is already gone", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-unproven-ref");
  const tip = agentCommit(clone, "only-copy.ts");
  capture(repo, clone, "t-unproven-ref");
  const branch = worktreeBranchName(RUN_ID, "t-unproven-ref");

  // The clone's tip is on the parent's ref and NOWHERE else: no HEAD merge, no
  // publication receipt. The reap is refused, so the ref is never even
  // considered for disposal — forcing it here would discard the only copy.
  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-unproven-ref", repo, { anchors: [] });
  assert.equal(outcome.action, "retained");
  assert.equal(git(repo, "rev-parse", branch).trim(), tip, "the ref still holds the work");
  assert.ok(existsSync(clone));
});

test("fg621: an unproven clone on a REMOTE target retains under its OWN name — never a silent forever-retain", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-remote-unproven");
  agentCommit(clone, "nobody-published-this.ts");

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-remote-unproven", repo, {
    anchors: [],
    target: "remote:origin#main",
  });

  assert.equal(outcome.action, "retained");
  assert.equal(
    outcome.action === "retained" ? outcome.reason : "",
    "remote_target_uncaptured",
    "a HEAD-relative 'unmerged' verdict about a branch that was never going to reach HEAD is not an explanation",
  );
  assert.ok(
    outcome.action === "retained" && outcome.details.some((d) => d.includes("remote:origin#main")),
    "and the target is named in the evidence",
  );
  assert.ok(existsSync(clone));
});

// ── The parent's gc: a DEFERRAL, not a disposition ────────────────────────────

test("fg621 (AC 9): `gc.pid` in the parent defers disposal — nothing is reaped or retained, and the next pass asks again", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-gc");
  agentCommit(clone, "captured.ts");
  capture(repo, clone, "t-gc");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-gc"));

  // git writes gc.pid for the duration of a repack and checks it to refuse a
  // concurrent one. The clone's alternates point into the very object store being
  // rewritten, so disposal waits rather than racing it.
  writeFileSync(join(repo, ".git", "gc.pid"), "12345 forge-test\n");
  const deferred = reapTaskWorkspace(clone, RUN_ID, "t-gc", repo);

  assert.equal(deferred.action, "deferred");
  assert.equal(deferred.action === "deferred" ? deferred.reason : "", "parent_repacking");
  assert.ok(existsSync(clone), "and the clone is untouched while the parent repacks");

  // The gc finishes. The very next pass disposes of it — a deferral is not a
  // verdict, so nothing about it is sticky. (Reconcile does record the deferral
  // itself under its own event type; the reaper's OUTCOME is what carries no
  // disposition — see fg621-clone-reaper's persisting-deferral test below.)
  rmSync(join(repo, ".git", "gc.pid"));
  assert.equal(reapTaskWorkspace(clone, RUN_ID, "t-gc", repo).action, "reaped");
  assert.equal(existsSync(clone), false);
});

test("fg621 (AC 9): a STALE `gc.pid` is not a repack — a dead lock must not defer a clone forever", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-gc-stale");
  agentCommit(clone, "captured.ts");
  capture(repo, clone, "t-gc-stale");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-gc-stale"));

  // git leaves gc.pid behind when a gc is killed, and it names the host that
  // wrote it. A lock naming THIS host whose process is gone is exactly what git
  // itself treats as stale — and testing only for the file's EXISTENCE turns one
  // abandoned lock into a permanent, silent forever-deferral for every clone in
  // the project: never reaped, and (a deferral being no disposition) never
  // reported either.
  const deadPid = execFileSync("sh", ["-c", "sh -c 'echo $$'"], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, ".git", "gc.pid"), `${deadPid} ${hostname()}\n`);

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-gc-stale", repo);
  assert.equal(outcome.action, "reaped", "a stale lock is not an in-progress repack");
  assert.equal(existsSync(clone), false);
});

test("fg621 (AC 9): a gc.pid older than git's own staleness bound is not a repack either", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-gc-expired");
  agentCommit(clone, "captured.ts");
  capture(repo, clone, "t-gc-expired");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-gc-expired"));

  // A lock naming ANOTHER host cannot be probed, so it is believed — but only
  // until it expires. Without the age bound, one such file is forever.
  const lock = join(repo, ".git", "gc.pid");
  writeFileSync(lock, "12345 some-other-host\n");
  assert.equal(
    reapTaskWorkspace(clone, RUN_ID, "t-gc-expired", repo).action,
    "deferred",
    "an unprobeable lock that is still fresh is believed",
  );

  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(lock, longAgo, longAgo);
  assert.equal(reapTaskWorkspace(clone, RUN_ID, "t-gc-expired", repo).action, "reaped", "but not once it has expired");
  assert.equal(existsSync(clone), false);
});

test("fg621: a clone that would be RETAINED reports its real reason even while the parent is repacking", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-gc-dirty");
  writeFileSync(join(repo, ".git", "gc.pid"), "12345 forge-test\n");
  writeFileSync(join(clone, "uncaptured.txt"), "work that exists nowhere else\n");

  const outcome = reapTaskWorkspace(clone, RUN_ID, "t-gc-dirty", repo);

  assert.equal(
    outcome.action,
    "retained",
    "the deferral is checked immediately before the irreversible step, so a real retain reason still wins",
  );
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "uncommitted_work");
});

// ── Idempotence ───────────────────────────────────────────────────────────────

test("fg621: reaping an already-gone clone is a no-op, so repeated passes are safe", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-idem");
  agentCommit(clone, "captured.ts");
  capture(repo, clone, "t-idem");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-idem"));

  assert.equal(reapTaskWorkspace(clone, RUN_ID, "t-idem", repo).action, "reaped");
  const again = reapTaskWorkspace(clone, RUN_ID, "t-idem", repo);
  assert.ok(again.action === "absent" || again.action === "branch_reaped", `got ${again.action}`);
});

// ── The deferral, through reconcile: postponed is not the same as silent ──────

function driveReconcile(projectDir: string, taskId: string, workspace: string): void {
  insertRun({
    id: RUN_ID,
    workflow: "invoke",
    title: "fg621 clone reaper drive",
    status: "active",
    createdAt: "2026-07-27T00:00:00Z",
    projectDir,
  });
  insertTask({
    id: taskId,
    runId: RUN_ID,
    phase: "build",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId, runId: RUN_ID, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-27T00:00:00Z",
    worktreePath: workspace,
  });
  logEvent("task.completed", { runId: RUN_ID, taskId });
  reconcileRun(RUN_ID, () => true);
}

function workspaceEventTypes(taskId: string): string[] {
  return eventsForTask(taskId)
    .map((e) => e.eventType)
    .filter((t) => t.startsWith("task.workspace_"));
}

test("fg621: a deferral that PERSISTS is recorded once — observable in forge show, and still a fixpoint", () => {
  const repo = makeRepo();
  const clone = makeClone(repo, "t-gc-drive");
  agentCommit(clone, "captured.ts");
  capture(repo, clone, "t-gc-drive");
  git(repo, "merge", "--ff-only", worktreeBranchName(RUN_ID, "t-gc-drive"));
  writeFileSync(join(repo, ".git", "gc.pid"), `${process.pid} ${hostname()}\n`);

  driveReconcile(repo, "t-gc-drive", clone);
  assert.ok(existsSync(clone), "the clone waits for the repack rather than racing it");
  assert.deepEqual(
    workspaceEventTypes("t-gc-drive"),
    ["task.workspace_reap_deferred"],
    "a deferral that persists must be visible — un-reaped AND un-reported is the leak this closes",
  );
  const deferred = eventsForTask("t-gc-drive").find((e) => e.eventType === "task.workspace_reap_deferred")!;
  assert.equal((deferred.payload as Record<string, unknown>)["reason"], "parent_repacking");
  assert.equal((deferred.payload as Record<string, unknown>)["workspacePath"], clone);

  // Still a fixpoint: reconcile runs on every lifecycle command, so a deferral
  // that has already been recorded logs nothing new.
  reconcileRun(RUN_ID, () => true);
  assert.deepEqual(workspaceEventTypes("t-gc-drive"), ["task.workspace_reap_deferred"], "and it is recorded ONCE");

  // The gc finishes: the deferral was never a disposition, and the next pass
  // settles it.
  rmSync(join(repo, ".git", "gc.pid"));
  reconcileRun(RUN_ID, () => true);
  assert.equal(existsSync(clone), false);
  assert.deepEqual(workspaceEventTypes("t-gc-drive"), ["task.workspace_reap_deferred", "task.workspace_reaped"]);
});
