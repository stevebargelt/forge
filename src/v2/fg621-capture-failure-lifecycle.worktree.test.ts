// FG-621 — what an operator can actually DO after a capture failure, end to end
// over a real private clone.
//
// `capture_failed` is the one new failure mode this ticket introduces, and it is
// the worst-case one: Forge could not get the agent's commits out of the private
// clone and into the parent's ref namespace, so the clone holds the ONLY copy of
// the work. Everything downstream of that classification is a promise to the
// operator — the workspace is retained, the failure is not blindly re-run, and
// the advice names a way forward.
//
// Each of those promises is registered somewhere: the kind is in
// RETAIN_WORKSPACE_FAILURE_KINDS (reconcile.ts), in POLICY (retry-policy.ts), in
// BLOCKER_BY_FAILURE_KIND (campaign/policy.ts). Registry membership is covered.
// The BEHAVIOUR that membership is supposed to produce — on a real clone, through
// the real `retry()` — is not, and the registries are `Record<FailureKind, …>`
// maps that typecheck forces you to fill in, which makes a plausible-but-wrong
// entry very easy to add and very hard to notice.
//
// One specific claim is worth pinning above all: the recorded advice tells the
// operator to inspect the retained clone and then `forge retry <id> --force`.
// That is only sound if the forced retry gets a workspace identity of its OWN —
// createTaskClone is CREATE-ONLY and throws TaskCloneExistsError on an existing
// directory, so a retry that reused the failed task's clone path would refuse to
// dispatch, and the advice would be a dead end. This file proves it does not.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask, setTaskWorkspace } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { cloneDir, CLONES_DIR } from "../util/paths.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { reconcileRun } from "./reconcile.js";
import { retry, RetryNotAllowedError } from "./retry.js";
import { retryPolicy } from "./retry-policy.js";
import { classifyFailureKind } from "../campaign/policy.js";
import { createTaskClone, worktreeBranchName } from "./worktree-lifecycle.js";

const RUN_ID = "run-fg621-capture-failure";
const FAILED_TASK = "t-capture-failed";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const madeClones: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg621cf-${label}-`));
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
  writeFileSync(join(dir, "README.md"), "# fg621 capture failure\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return { dir, head: git(dir, "rev-parse", "HEAD").trim() };
}

// retry() refuses outright when the run's workflow will not load (FG-507), so
// the fixture run needs a real one. A non-shipped name on purpose: FG-579 makes
// loadWorkflow refuse a host workflow whose bytes drift from a shipped seed of
// the same name, and a name the release does not ship has no baseline to drift
// from. Mirrors retry.test.ts.
function installFixtureWorkflow(): void {
  const home = process.env["FORGE_HOME"]!;
  const path = join(home, "workflows", "fg621-capture-fixture.yml");
  if (!existsSync(path)) {
    mkdirSync(join(home, "workflows"), { recursive: true });
    writeFileSync(
      path,
      `
name: fg621-capture-fixture
description: fg621 capture-failure fixture
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
`,
    );
  }
  publishFlatAsGeneration(home);
}

/** The state a capture failure leaves behind: a real private clone at the
 *  recorded base, holding the agent's commit, and a task row failed with
 *  `capture_failed`. Nothing was fetched into the parent — that IS the failure. */
function stageCaptureFailure(projectDir: string, base: string): { clonePath: string; agentFile: string } {
  const created = createTaskClone(projectDir, RUN_ID, FAILED_TASK, base);
  madeClones.push(created.clonePath);

  const agentFile = "only-copy.ts";
  writeFileSync(join(created.clonePath, agentFile), "export const irreplaceable = true;\n");
  git(created.clonePath, "add", ".");
  git(created.clonePath, "commit", "-q", "-m", "agent output nothing else has");

  insertTask({
    id: FAILED_TASK,
    runId: RUN_ID,
    phase: "build",
    agentRole: "engineer",
    status: "failed",
    error: "private clone fetch was rejected by the parent [fetch_rejected]",
    taskPackage: {
      taskId: FAILED_TASK,
      runId: RUN_ID,
      phase: "build",
      role: "engineer",
      inputs: { brief: "do the thing" },
      composedSystemPrompt: "PROMPT",
    },
    createdAt: "2026-07-27T00:00:00Z",
  });
  // The production writer, deliberately: `insertTask` carries worktree_path but
  // NOT base_sha, and dispatch records both together through setTaskWorkspace
  // BEFORE the container starts. Staging it any other way would test a row shape
  // forge never actually writes.
  setTaskWorkspace(FAILED_TASK, created.clonePath, base);
  logEvent("task.failed", {
    runId: RUN_ID,
    taskId: FAILED_TASK,
    payload: {
      failure_kind: "capture_failed",
      error: "private clone fetch was rejected by the parent [fetch_rejected]",
    },
  });
  return { clonePath: created.clonePath, agentFile };
}

function seedRun(projectDir: string): void {
  insertRun({
    id: RUN_ID,
    workflow: "fg621-capture-fixture",
    title: "fg621 capture failure lifecycle",
    status: "active",
    createdAt: "2026-07-27T00:00:00Z",
    projectDir,
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  installFixtureWorkflow();
});

afterEach(() => {
  if (prev) setDbForTest(prev);
  try {
    db.close();
  } catch {
    // already closed
  }
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

// ── The classification's promises, on the substrate that actually produces it ──

test("fg621: a capture failure retains the PRIVATE CLONE by kind — the git probe is never even asked", () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath, agentFile } = stageCaptureFailure(repo.dir, repo.head);

  reconcileRun(RUN_ID, () => true);

  assert.ok(existsSync(clonePath), "the clone holds the only copy of the work — reconcile must not dispose of it");
  assert.ok(existsSync(join(clonePath, agentFile)), "…with the agent's file intact");

  const workspaceEvents = eventsForTask(FAILED_TASK).filter((e) => e.eventType.startsWith("task.workspace_"));
  assert.equal(workspaceEvents.length, 1, "retained, and recorded exactly once");
  const payload = (workspaceEvents[0]!.payload ?? {}) as Record<string, unknown>;
  assert.equal(workspaceEvents[0]!.eventType, "task.workspace_retained");
  assert.equal(payload["reason"], "retained_failure_kind", "the kind decides, without probing git");
  assert.deepEqual(payload["details"], ["capture_failed"], "and the evidence names which kind decided it");
  assert.equal(
    payload["substrate"],
    "private_clone",
    "the retain-by-kind guard classifies FG-621's substrate correctly — the existing drive table only covers linked worktrees",
  );
  assert.equal(payload["workspacePath"], clonePath);
  assert.equal(payload["branch"], worktreeBranchName(RUN_ID, FAILED_TASK));
});

test("fg621: capture_failed is scoped to the ITEM, not to the host or a shared target", () => {
  // A campaign blocker of `infrastructure` or `publication` would pause work that
  // has nothing to do with this clone. A capture failure is about ONE task's own
  // workspace — its git status, its safety commit, its fetch.
  assert.equal(classifyFailureKind("capture_failed"), "scope");
});

// ── The remediation path the advice actually names ────────────────────────────

test("fg621: a plain retry of a capture failure is REFUSED, and the refusal points at the retained clone", async () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath } = stageCaptureFailure(repo.dir, repo.head);

  await assert.rejects(
    () => retry(FAILED_TASK),
    (err: unknown) => {
      assert.ok(err instanceof RetryNotAllowedError, `expected RetryNotAllowedError, got ${String(err)}`);
      const msg = (err as Error).message;
      // The operator has to be told the work is still somewhere, or the natural
      // reading of "not retryable" is "that work is gone".
      assert.match(msg, /still in the clone/i, "the refusal must say the work survives");
      assert.match(msg, /forge show/, "…and where to look at it");
      assert.match(msg, /--force/, "…and how to proceed once it is resolved");
      // Nothing was merged and nothing was published — a message that talked
      // about a publish target would send the operator to reset one.
      assert.doesNotMatch(msg, /reset/i, "never advise resetting a target that was never involved");
      return true;
    },
  );

  const disposition = retryPolicy("capture_failed");
  assert.equal(disposition.retryable, false, "re-running the agent would not fix a fetch that was refused");

  assert.ok(existsSync(clonePath), "and the refusal disposed of nothing");
  assert.equal(getTask(FAILED_TASK)?.status, "failed", "the task is untouched by a refused retry");
});

test("fg621: a FORCED retry mints a workspace identity of its own — the advice is not a dead end", async () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath, agentFile } = stageCaptureFailure(repo.dir, repo.head);

  const outcome = await retry(FAILED_TASK, { force: true });

  assert.notEqual(outcome.newTask.id, FAILED_TASK, "a retry mints a NEW task id");
  const freshWorkspace = cloneDir(RUN_ID, outcome.newTask.id);
  assert.notEqual(
    freshWorkspace,
    clonePath,
    "…and therefore a DIFFERENT clone path — createTaskClone is create-only, so a reused path would refuse to dispatch",
  );
  assert.equal(existsSync(freshWorkspace), false, "the fresh identity names nothing yet: the next dispatch can create it");

  // The forced retry is a re-dispatch, not a cleanup. The failed attempt's clone
  // is the only copy of work Forge could not capture; discarding it here would
  // be the exact loss the whole no-discard contract exists to prevent.
  assert.ok(existsSync(clonePath), "the failed attempt's clone still stands");
  assert.ok(existsSync(join(clonePath, agentFile)), "…with the agent's uncaptured work still in it");
  assert.equal(
    getTask(FAILED_TASK)?.worktreePath,
    clonePath,
    "and the failed row still NAMES it — the recorded path is the only thing that will ever find it again",
  );
  assert.equal(getTask(FAILED_TASK)?.baseSha, repo.head, "…along with the base it was created at");

  // The new row starts with no workspace at all: it is recorded at dispatch,
  // before the container starts, not inherited from the attempt that failed.
  const fresh = getTask(outcome.newTask.id);
  assert.equal(fresh?.worktreePath, undefined, "a retried row inherits no workspace path");
  assert.equal(fresh?.baseSha, undefined, "…and no base — it will clone from whatever the CURRENT base resolves to");
});

test("fg621: after a forced retry, reconcile still retains the failed attempt's clone", async () => {
  const repo = makeRepo();
  seedRun(repo.dir);
  const { clonePath } = stageCaptureFailure(repo.dir, repo.head);

  await retry(FAILED_TASK, { force: true });
  reconcileRun(RUN_ID, () => true);

  assert.ok(
    existsSync(clonePath),
    "retrying is not the same as resolving — until an operator settles it, the evidence stays",
  );
  const retained = eventsForTask(FAILED_TASK).filter((e) => e.eventType === "task.workspace_retained");
  assert.equal(retained.length, 1);
  assert.deepEqual((retained[0]!.payload as Record<string, unknown>)["details"], ["capture_failed"]);
});
