// FG-621 — the reconcile → reaper CAPTURE-AUTHORITY seam, over real repositories
// and real publication receipts.
//
// WHY THIS FILE EXISTS. The reaper (worktree-lifecycle.ts) is deliberately free
// of the store: it takes a `CaptureAuthority` as a parameter. reconcile.ts builds
// that authority from `publication_attempts` in `captureAuthorityFor`, and the
// rule it encodes is narrow and load-bearing:
//
//     ONLY `published` attempts contribute an anchor, and only their
//     `published_sha`. A candidate that was merely BUILT proves nothing — its
//     worktree is torn down and its branch deleted, so a task commit reachable
//     from an unpublished candidate can still exist nowhere durable.
//
// Every existing FG-621 reaper test hands `reapTaskWorkspace` an authority
// literal. That covers the reaper's half. It does NOT cover the half that reads
// the store — so a `captureAuthorityFor` that anchored on `candidate_sha`
// regardless of state, or dropped the target, would leave the whole suite green
// while reaping clones whose work was never published. That is not hypothetical:
// it is the defect the implementer hit mid-build, caught by a neighbouring
// crash-lane assertion rather than by anything aimed at it.
//
// So every test here drives the PRODUCTION path end to end: createTaskClone →
// the agent commits → captureTaskClone → real publication_attempts rows →
// reconcileRun. No authority literal appears in this file, by design; if one ever
// does, the seam has stopped being under test.
//
// The parent's HEAD is never advanced in any of these tests. That is deliberate:
// HEAD is the OTHER capture proof, and leaving it still is what forces the
// receipts to be the thing that decides.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, setTaskWorkspace } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { recordPublicationIntent, updatePublicationAttempt, type PublicationState } from "../store/publications.js";
import { CLONES_DIR } from "../util/paths.js";
import { reconcileRun } from "./reconcile.js";
import { createTaskClone, captureTaskClone, worktreeBranchName } from "./worktree-lifecycle.js";

const RUN_ID = "run-fg621-authority";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const madeClones: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg621a-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): { dir: string; head: string } {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg621 authority\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return { dir, head: git(dir, "rev-parse", "HEAD").trim() };
}

/** Provision a mutating task's workspace the way dispatch does, let the agent
 *  commit in it, and capture it — all through the production functions. Returns
 *  the clone path and the CAPTURED tip (verified equal in the clone and in the
 *  parent's ref namespace by captureTaskClone itself). */
function provisionCommitAndCapture(projectDir: string, base: string, taskId: string, file: string): {
  clonePath: string;
  tip: string;
} {
  const created = createTaskClone(projectDir, RUN_ID, taskId, base);
  madeClones.push(created.clonePath);

  // The agent's own commit, in its own repository. No `-c user.email` here: the
  // clone carries the AGENT_IDENTITY createTaskClone wrote into its local config,
  // which is the whole point of handing it a repository of its own.
  writeFileSync(join(created.clonePath, file), `export const work = "${file}";\n`);
  git(created.clonePath, "add", ".");
  git(created.clonePath, "commit", "-q", "-m", `agent output ${file}`);

  const captured = captureTaskClone(projectDir, created.clonePath, RUN_ID, taskId);
  assert.equal(captured.ok, true, `capture must succeed for this fixture: ${JSON.stringify(captured)}`);
  assert.ok(captured.ok);
  return { clonePath: created.clonePath, tip: captured.commit };
}

/** A real publication_attempts row for a task, driven through the production
 *  writers (intent → patch), so the reconcile-side read sees exactly the row
 *  shape the publisher leaves behind. */
function recordAttempt(rec: {
  attemptId: string;
  taskId: string;
  projectDir: string;
  target: string;
  state: PublicationState;
  candidateSha?: string;
  publishedSha?: string;
}): void {
  recordPublicationIntent({
    attemptId: rec.attemptId,
    projectKey: `pk-${RUN_ID}`,
    canonicalDir: rec.projectDir,
    runId: RUN_ID,
    taskId: rec.taskId,
    target: rec.target,
    leaseTtlMs: 60_000,
  });
  updatePublicationAttempt(rec.attemptId, {
    state: rec.state,
    ...(rec.candidateSha ? { candidateSha: rec.candidateSha } : {}),
    ...(rec.publishedSha ? { publishedSha: rec.publishedSha } : {}),
  });
}

function seedRun(projectDir: string): void {
  insertRun({
    id: RUN_ID,
    workflow: "invoke",
    title: "fg621 capture-authority seam",
    status: "active",
    createdAt: "2026-07-27T00:00:00Z",
    projectDir,
  });
}

function seedCompleteTask(taskId: string, workspacePath: string, baseSha: string): void {
  insertTask({
    id: taskId,
    runId: RUN_ID,
    phase: "build",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId, runId: RUN_ID, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-27T00:00:00Z",
  });
  // setTaskWorkspace is the production writer for a private clone: it records the
  // path AND the base in one statement, before the container starts.
  setTaskWorkspace(taskId, workspacePath, baseSha);
  logEvent("task.completed", { runId: RUN_ID, taskId });
}

function workspaceEvents(taskId: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return eventsForTask(taskId)
    .filter((e) => e.eventType.startsWith("task.workspace_"))
    .map((e) => ({ type: e.eventType, payload: (e.payload ?? {}) as Record<string, unknown> }));
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  if (prev) setDbForTest(prev);
  try {
    db.close();
  } catch {
    // already closed
  }
  // Clones land under the harness's temp FORGE_HOME (CLONES_DIR), not under the
  // per-test temp roots, so they are removed explicitly.
  for (const p of madeClones.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
  try {
    rmSync(join(CLONES_DIR, RUN_ID), { recursive: true, force: true });
  } catch { /* best-effort */ }
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

// ── The rule: only `published` contributes ────────────────────────────────────

test("fg621 (AC 10, reconcile seam): a candidate SHA on a NON-published attempt authorizes nothing — the clone is retained with the agent's work", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath, tip } = provisionCommitAndCapture(repo.dir, repo.head, "t-candidate-only", "agent-work.ts");
  seedCompleteTask("t-candidate-only", clonePath, repo.head);

  // The publisher built a candidate holding exactly this task's tip and then
  // LOST THE LANE (AD-7). Nothing landed on the target; the candidate worktree
  // and its branch are gone. `candidate_sha` still names the tip — which is
  // precisely why reading it as an anchor would be wrong.
  recordAttempt({
    attemptId: "att-candidate-only",
    taskId: "t-candidate-only",
    projectDir: repo.dir,
    target: "remote:origin#main",
    state: "abandoned",
    candidateSha: tip,
  });

  reconcileRun(RUN_ID, () => true);

  assert.ok(existsSync(clonePath), "the clone holds the only durable copy of the work and must stand");
  assert.ok(existsSync(join(clonePath, "agent-work.ts")), "…with the agent's output still in it");
  const events = workspaceEvents("t-candidate-only");
  assert.deepEqual(
    events.map((e) => e.type),
    ["task.workspace_retained"],
    "retained, and RECORDED — an un-reaped workspace nobody was told about is the leak FG-356 closed",
  );
  assert.equal(
    events[0]?.payload["reason"],
    "remote_target_uncaptured",
    "and the reason names the receipts, not a HEAD the remote target was never going to advance",
  );
});

test("fg621 (AC 9, reconcile seam): a PUBLISHED receipt read from the store authorizes the reap where HEAD proves nothing", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath, tip } = provisionCommitAndCapture(repo.dir, repo.head, "t-published", "agent-work.ts");
  seedCompleteTask("t-published", clonePath, repo.head);

  recordAttempt({
    attemptId: "att-published",
    taskId: "t-published",
    projectDir: repo.dir,
    target: "remote:origin#main",
    state: "published",
    candidateSha: tip,
    publishedSha: tip,
  });

  reconcileRun(RUN_ID, () => true);

  assert.equal(existsSync(clonePath), false, "a published receipt IS the capture proof, and the clone is disposed of");
  assert.deepEqual(workspaceEvents("t-published").map((e) => e.type), ["task.workspace_reaped"]);
  assert.equal(
    git(repo.dir, "rev-parse", "HEAD").trim(),
    repo.head,
    "and the parent's HEAD never moved — without the receipts this clone would be retained forever",
  );
});

test("fg621 (AC 10, reconcile seam): a published receipt that does NOT reach the clone's tip authorizes nothing", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath, tip } = provisionCommitAndCapture(repo.dir, repo.head, "t-stale-receipt", "agent-work.ts");
  seedCompleteTask("t-stale-receipt", clonePath, repo.head);

  // A genuine `published` receipt — for an EARLIER publication, one that predates
  // this task's work. The state filter passes; the reachability proof must not.
  // "Has a published receipt" is not the question; "does that SHA reach this
  // commit" is.
  recordAttempt({
    attemptId: "att-stale-receipt",
    taskId: "t-stale-receipt",
    projectDir: repo.dir,
    target: "remote:origin#main",
    state: "published",
    publishedSha: repo.head,
  });
  assert.notEqual(tip, repo.head, "precondition: the agent's tip is not the base");

  reconcileRun(RUN_ID, () => true);

  assert.ok(existsSync(clonePath), "an unrelated receipt is not this work's capture proof");
  const events = workspaceEvents("t-stale-receipt");
  assert.equal(events[0]?.type, "task.workspace_retained");
  assert.equal(events[0]?.payload["reason"], "remote_target_uncaptured");
});

test("fg621 (AC 10, reconcile seam): the authority is read PER TASK — a sibling's published receipt never authorizes this clone", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const mine = provisionCommitAndCapture(repo.dir, repo.head, "t-sibling-a", "a-work.ts");
  seedCompleteTask("t-sibling-a", mine.clonePath, repo.head);

  // The receipt exists in the run and its published SHA genuinely reaches task
  // A's tip — but it belongs to task B. A per-RUN or per-project authority read
  // would sanction the reap; a per-task one does not. The narrower read is the
  // correct one: what B published says nothing about whether A's work was ever
  // meant to land.
  seedCompleteTask("t-sibling-b", join(tmpRoot("absent"), "no-such-workspace"), repo.head);
  recordAttempt({
    attemptId: "att-sibling-b",
    taskId: "t-sibling-b",
    projectDir: repo.dir,
    target: "remote:origin#main",
    state: "published",
    publishedSha: mine.tip,
  });

  reconcileRun(RUN_ID, () => true);

  assert.ok(existsSync(mine.clonePath), "task A's clone is retained — nothing recorded for A proves A captured");
  assert.equal(workspaceEvents("t-sibling-a")[0]?.type, "task.workspace_retained");
});

// ── The target, carried from the store ────────────────────────────────────────

test("fg621 (reconcile seam): a LOCAL target retains under the HEAD-relative reason, a remote one does not", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath } = provisionCommitAndCapture(repo.dir, repo.head, "t-local-target", "agent-work.ts");
  seedCompleteTask("t-local-target", clonePath, repo.head);

  // Same uncaptured clone as the first test, differing ONLY in the recorded
  // target. `remote_target_uncaptured` exists to stop an operator reading a
  // HEAD-relative "unmerged" verdict about a branch that was never going to
  // reach HEAD — so on a LOCAL target, where HEAD genuinely is the answer, the
  // reason must stay `unmerged_commits`. That distinction is only real if the
  // target actually travels from the store to the reaper.
  recordAttempt({
    attemptId: "att-local-target",
    taskId: "t-local-target",
    projectDir: repo.dir,
    target: "local:main",
    state: "failed",
  });

  reconcileRun(RUN_ID, () => true);

  assert.ok(existsSync(clonePath));
  const events = workspaceEvents("t-local-target");
  assert.equal(events[0]?.type, "task.workspace_retained");
  assert.equal(
    events[0]?.payload["reason"],
    "unmerged_commits",
    "a local target's clone is unmerged, plainly — the remote-specific reason must not swallow it",
  );
});

test("fg621 (reconcile seam): a task with NO publication attempt at all still reconciles, and retains", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath } = provisionCommitAndCapture(repo.dir, repo.head, "t-no-attempt", "agent-work.ts");
  seedCompleteTask("t-no-attempt", clonePath, repo.head);

  // The empty-authority path — a task that failed before it ever reached the
  // publisher. It must fall back to the HEAD proxy (which proves nothing here)
  // rather than throwing on an absent row, and it must NOT report a remote
  // target it has no receipt for.
  reconcileRun(RUN_ID, () => true);

  assert.ok(existsSync(clonePath));
  const events = workspaceEvents("t-no-attempt");
  assert.equal(events[0]?.type, "task.workspace_retained");
  assert.equal(events[0]?.payload["reason"], "unmerged_commits");
});

// ── Idempotence across passes, with receipts in play ──────────────────────────

test("fg621 (reconcile seam): the receipt-authorized reap is a fixpoint — a second pass records nothing new", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath, tip } = provisionCommitAndCapture(repo.dir, repo.head, "t-fixpoint", "agent-work.ts");
  seedCompleteTask("t-fixpoint", clonePath, repo.head);
  recordAttempt({
    attemptId: "att-fixpoint",
    taskId: "t-fixpoint",
    projectDir: repo.dir,
    target: "remote:origin#main",
    state: "published",
    publishedSha: tip,
  });

  reconcileRun(RUN_ID, () => true);
  assert.equal(existsSync(clonePath), false);
  const afterFirst = workspaceEvents("t-fixpoint").map((e) => e.type);
  assert.deepEqual(afterFirst, ["task.workspace_reaped"]);

  // reconcile runs on every lifecycle command. A pass over an already-disposed
  // workspace must be silent, or the timeline fills with re-reports of a
  // decision already taken.
  reconcileRun(RUN_ID, () => true);
  reconcileRun(RUN_ID, () => true);
  assert.deepEqual(
    workspaceEvents("t-fixpoint").map((e) => e.type),
    afterFirst,
    "repeated passes over a reaped clone are a no-op",
  );
});
