// FG-352 dispatch-level integration tests.
//
// Exercises the merge-back primitive in dispatchSingleStep: after a task passes
// checkResultPersistence, forge runs `git merge --ff-only <branch>` into
// run.projectDir. This wires up sequential worktree output so downstream steps
// see the previous step's merged changes.
//
// Covers:
//   (1) Default non-worktree path: FORGE_WORKTREES unset → no merge attempted,
//       task completes normally (byte-for-byte unchanged from pre-FG-352 behaviour).
//   (2) Successful merge: worktree task commits output → merge fast-forwards
//       changes into run.projectDir → task completes.
//   (3) Downstream sequential step sees previous step's merged changes in
//       run.projectDir (via its own new worktree created from the updated HEAD).
//   (4) Merge failure: non-fast-forward divergence → task fails with
//       failure_kind merge_conflict.
//   (5) Merge failure retains branch AND worktree for inspection.
//   (6) Successful merge cleans up worktree directory and branch.
//   (7) No downstream dispatch after merge failure.
//  (11) Auto-commit fails with changes present → ok:false, task fails, worktree
//       and branch retained (regression guard for the no-discard invariant).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { failureKindForTask } from "./failure-kind.js";
import { worktreeBranchName } from "./worktree-lifecycle.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "fg352-dispatch-test",
  description: "FG-352 dispatch-level integration test: single step",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg352-dispatch-test",
      reds: [],
    },
  ],
};

const TWO_STEP_WORKFLOW: Workflow = {
  name: "fg352-sequential-test",
  description: "FG-352 dispatch-level integration test: two sequential steps",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg352-dispatch-test",
      reds: [],
    },
    {
      id: "verify",
      agent: "test-engineer",
      gate: "auto",
      manual: false,
      depends_on: ["build"],
      runtime: "fg352-dispatch-test",
      reds: [],
    },
  ],
};

// ─── Shared harness ───────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);

  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  process.env.ANTHROPIC_API_KEY = "sk-stub";

  ensureDispatchTestRuntime();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();

  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }

  setPlatform(process.platform);

  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg352-disp-"));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

function ensureDispatchTestRuntime(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", "fg352-dispatch-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg352-dispatch-test
description: FG-352 dispatch test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
env: {}
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
  - host: "\${PROJECT_DIR}"
    container: /project
    mode: "\${PROJECT_MODE:-rw}"
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
  remove_on_exit: true
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

/** Extract the host-side path from -v <host>:<container>:<mode> docker args. */
function findProjectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

/** Write a successful result.json and logs into the task dir. */
function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

// ─── (1) Default non-worktree path unchanged ─────────────────────────────────
//
// FORGE_WORKTREES unset → dispatchSingleStep never creates a worktree and never
// attempts a merge. Task completes normally, identical to pre-FG-352 behaviour.

test("fg352 (1): FORGE_WORKTREES unset → no merge attempted, task completes normally", async () => {
  // FORGE_WORKTREES cleared in beforeEach — default production state.
  const projectDir = "/tmp/test-project";

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 default-off test",
    inputs: {},
    projectDir,
  });

  let execCalled = false;
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    execCalled = true;
    // No git or merge operations — standard stub.
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(wave.completedSteps, ["build"], "build must complete normally");
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");
  assert.ok(execCalled, "docker exec must be called");

  // Confirm no worktree was created.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(
    primary!.worktreePath,
    undefined,
    "task.worktreePath must be undefined when FORGE_WORKTREES is unset",
  );
});

// ─── (2) Successful merge fast-forwards into run.projectDir ──────────────────
//
// FORGE_WORKTREES=1 → stub commits a file on the worktree branch → forge runs
// `git merge --ff-only` → the file appears in run.projectDir → task completes.

test("fg352 (2): successful worktree task fast-forwards changes into run.projectDir", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 successful merge",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");

    // Write a file and commit it on the worktree branch (simulating agent work).
    writeFileSync(join(worktreePath!, "output.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "task output"], { cwd: worktreePath!, stdio: "ignore" });

    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["output.ts"] });
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(wave.completedSteps, ["build"], "build must complete after successful merge");
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  // The merged file must be present in run.projectDir.
  assert.ok(
    existsSync(join(repo, "output.ts")),
    "output.ts must exist in run.projectDir after merge-back",
  );
});

// ─── (3) Downstream sequential step sees merged changes ───────────────────────
//
// Step 1 commits output.ts → merge into projectDir. Step 2's new worktree is
// created from the updated projectDir HEAD → step 2 can see output.ts.

test("fg352 (3): downstream sequential step sees previous step's merged changes", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: TWO_STEP_WORKFLOW,
    title: "fg352 sequential visibility",
    inputs: {},
    projectDir: repo,
  });

  let step2SawOutputTs = false;
  let stepCount = 0;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    stepCount++;
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    if (stepCount === 1) {
      // Step 1 (build): write and commit output.ts on the worktree branch.
      writeFileSync(join(worktreePath!, "output.ts"), "export const x = 1;\n");
      execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "step1 output"], { cwd: worktreePath!, stdio: "ignore" });
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["output.ts"] });
    } else {
      // Step 2 (verify): check that output.ts from step 1 is visible in the worktree.
      // Step 2's worktree was created from projectDir HEAD, which has step 1's merged commit.
      step2SawOutputTs = existsSync(join(worktreePath!, "output.ts"));
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // Wave 1: step 1 (build) runs and merges.
  const wave1 = await runNext({ runId, workflow: TWO_STEP_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["build"], "build must complete in wave 1");

  // output.ts must now be in projectDir (confirmed before wave 2 so the assertion
  // is isolated from step 2's worktree behaviour).
  assert.ok(
    existsSync(join(repo, "output.ts")),
    "output.ts must be in run.projectDir before step 2 dispatches",
  );

  // Wave 2: step 2 (verify) runs. Its worktree branches from updated projectDir HEAD.
  const wave2 = await runNext({ runId, workflow: TWO_STEP_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["verify"], "verify must complete in wave 2");

  assert.ok(
    step2SawOutputTs,
    "step 2 must see output.ts in its worktree (branched from merged projectDir HEAD)",
  );
});

// ─── (4) Merge failure → task failed, failure_kind merge_conflict ─────────────
//
// The stub commits on the worktree branch AND makes a diverging commit on main.
// This makes the histories non-fast-forwardable → merge_conflict failure.

test("fg352 (4): merge failure leaves task failed with failure_kind merge_conflict", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 merge conflict",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    // Commit on the worktree branch (task output).
    writeFileSync(join(worktreePath!, "task.ts"), "export const y = 2;\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "worktree commit"], { cwd: worktreePath!, stdio: "ignore" });

    // Land a CONFLICTING commit on the target: the same file, different content.
    //
    // FG-425 changed what "merge failure" means here. This used to write an
    // INDEPENDENT file, which made the target diverge and defeated the old
    // `git merge --ff-only <branch>` publish — a failure of the mechanism, not of
    // the merge. The publisher builds its candidate on the target's CURRENT base,
    // so a non-conflicting divergence now merges, gates, and publishes (that path
    // is covered in fg353 (13)). A real CONTENT conflict is what must still fail —
    // and it must fail the same way: merge_conflict, evidence retained, nothing
    // published.
    writeFileSync(join(repo, "task.ts"), "export const y = 999; // the operator's conflicting edit\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "conflicting commit on the target"], { cwd: repo, stdio: "ignore" });

    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["task.ts"] });
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(wave.failedSteps, ["build"], "build must fail on merge conflict");
  assert.deepEqual(wave.completedSteps, [], "no steps must complete");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "failed", "task status must be failed");
  assert.equal(
    failureKindForTask(primary!.id),
    "merge_conflict",
    "failure kind must be merge_conflict",
  );
});

// ─── (5) Merge failure retains branch AND worktree ───────────────────────────
//
// After a merge_conflict failure, both the worktree directory and the task
// branch must be retained (for operator inspection / manual resolution).

test("fg352 (5): merge failure retains worktree directory and task branch", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 retain on failure",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    // Commit on worktree branch.
    writeFileSync(join(worktreePath!, "task.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "worktree commit"], { cwd: worktreePath!, stdio: "ignore" });

    // A CONFLICTING commit on the target — same file, different content. See the
    // note in fg352 (4): under FG-425 a merely-diverged target is rebuilt onto and
    // published, so a real content conflict is what exercises the failure path.
    writeFileSync(join(repo, "task.ts"), "export const a = 999; // the operator's conflicting edit\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "conflicting commit on the target"], { cwd: repo, stdio: "ignore" });

    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["task.ts"] });
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(wave.failedSteps, ["build"], "build must fail on merge conflict");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");

  // Worktree directory must still exist.
  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must be set");
  assert.ok(existsSync(worktreePath), "worktree directory must be retained after merge failure");

  // Task branch must still exist.
  const branch = worktreeBranchName(runId, primary!.id);
  let branchExists: boolean;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  assert.ok(branchExists, `task branch ${branch} must be retained after merge failure`);
});

// ─── (6) Successful merge cleans up worktree and branch ──────────────────────
//
// After a successful merge-back, removeWorktreeIfSafe is called with
// provenMerged=true, which removes the worktree directory and the task branch.
// FORGE_WORKTREES_EPHEMERAL is intentionally NOT set — we're testing the
// provenMerged path, not the ephemeral path.

test("fg352 (6): successful merge removes worktree directory and task branch", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  // No FORGE_WORKTREES_EPHEMERAL — provenMerged path must drive the cleanup.

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 cleanup after merge",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    // Commit agent output on the worktree branch.
    writeFileSync(join(worktreePath!, "cleanup-test.ts"), "export const x = 42;\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "task output"], { cwd: worktreePath!, stdio: "ignore" });

    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["cleanup-test.ts"] });
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(wave.completedSteps, ["build"], "build must complete");
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");

  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must have been set");

  // Worktree directory must be removed after successful merge.
  assert.equal(
    existsSync(worktreePath),
    false,
    "worktree directory must be removed after proven-merged cleanup",
  );

  // Task branch must be removed after successful merge.
  const branch = worktreeBranchName(runId, primary!.id);
  let branchExists: boolean;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  assert.equal(branchExists, false, `task branch ${branch} must be removed after proven-merged cleanup`);

  // The merged file must still be in run.projectDir (cleanup removed the worktree,
  // not the merged commit).
  assert.ok(
    existsSync(join(repo, "cleanup-test.ts")),
    "merged file must remain in run.projectDir after worktree cleanup",
  );
});

// ─── (7) No downstream dispatch after merge failure ───────────────────────────
//
// Step 1 (build) fails with merge_conflict. Calling runNext again must NOT
// dispatch step 2 (verify), which depends on step 1.

test("fg352 (7): no downstream step dispatched after merge failure", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: TWO_STEP_WORKFLOW,
    title: "fg352 no downstream after failure",
    inputs: {},
    projectDir: repo,
  });

  let step2Dispatched = false;
  let stepCount = 0;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    stepCount++;
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    if (stepCount === 1) {
      // Step 1: commit on the worktree + a CONFLICTING commit on the target →
      // the merge into the candidate genuinely fails. (See fg352 (4): under FG-425
      // a merely-diverged target is rebuilt onto, so it takes a real content
      // conflict to exercise the merge-failure path.)
      writeFileSync(join(worktreePath!, "task.ts"), "x");
      execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "worktree commit"], { cwd: worktreePath!, stdio: "ignore" });

      writeFileSync(join(repo, "task.ts"), "conflicting content on the target");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "conflicting commit on the target"], { cwd: repo, stdio: "ignore" });

      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["task.ts"] });
    } else {
      // Should never reach here.
      step2Dispatched = true;
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // Wave 1: step 1 runs, merge fails.
  const wave1 = await runNext({ runId, workflow: TWO_STEP_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.failedSteps, ["build"], "build must fail with merge conflict");
  assert.deepEqual(wave1.completedSteps, [], "no steps must complete in wave 1");

  // Wave 2: ready queue is empty (step 2 depends on failed step 1).
  const wave2 = await runNext({ runId, workflow: TWO_STEP_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.dispatchedSteps, [], "no steps must be dispatched in wave 2");
  assert.deepEqual(wave2.completedSteps, [], "no steps must complete in wave 2");

  assert.equal(step2Dispatched, false, "step 2 must never be dispatched after step 1 merge failure");

  // Confirm no task row for step 2 was created.
  const tasks = tasksForRun(runId);
  const verifyTasks = tasks.filter((t) => t.phase === "verify");
  assert.equal(verifyTasks.length, 0, "no verify task must be created after step 1 merge failure");
});

// ─── (11) Auto-commit fails with changes present → no-discard invariant ──────
//
// Regression guard: a worktree that HAS uncommitted output but where git commit
// FAILS must NOT be reported as a proven-merged success. Before this fix, the
// catch block swallowed the commit failure and proceeded to `git merge --ff-only`,
// which returned "Already up to date." — the caller then called
// removeWorktreeIfSafe(provenMerged=true), discarding the agent's uncommitted work.
//
// The pre-commit hook approach induces a deterministic commit failure. Hooks are
// stored in the main repo's .git/hooks/ and shared across all worktrees.

test("fg352 (11): auto-commit fails with changes present — ok:false, task fails, worktree and branch retained", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 commit failure retains worktree",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    // Install a pre-commit hook that always exits 1. Hooks are shared across all
    // worktrees of this repo, so this deterministically fails the auto-commit in
    // mergeWorktreeBranch.
    const hookPath = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    chmodSync(hookPath, 0o755);

    // Write agent output but do NOT commit — leaves uncommitted changes in the
    // worktree for mergeWorktreeBranch's auto-commit to discover and attempt.
    writeFileSync(join(worktreePath!, "agent-output.ts"), "export const result = 42;\n");

    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["agent-output.ts"] });
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  // Task must FAIL — not complete. The auto-commit failed with changes present.
  assert.deepEqual(wave.failedSteps, ["build"], "build must fail when auto-commit fails with changes present");
  assert.deepEqual(wave.completedSteps, [], "no steps must complete");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "failed", "task status must be failed");
  assert.equal(
    failureKindForTask(primary!.id),
    "merge_conflict",
    "failure kind must be merge_conflict",
  );

  // Worktree directory must be RETAINED — removeWorktreeIfSafe must NOT have
  // been called with provenMerged=true.
  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must be set");
  assert.ok(existsSync(worktreePath), "worktree directory must be retained when auto-commit fails");

  // Uncommitted agent output must still be accessible in the retained worktree.
  assert.ok(
    existsSync(join(worktreePath, "agent-output.ts")),
    "agent output must be present in the retained worktree",
  );

  // Task branch must be RETAINED for operator inspection.
  const branch = worktreeBranchName(runId, primary!.id);
  let branchExists: boolean;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  assert.ok(branchExists, `task branch ${branch} must be retained when auto-commit fails`);
});
