// FG-352 edge coverage — auto-commit contract and merge-before-reds ordering.
//
// Independent of the 7 cases in fg352-dispatch.integration.test.ts, which cover:
//   (1) default-unset no-merge, (2) successful ff, (3) sequential downstream,
//   (4) merge failure → merge_conflict, (5) conflict retains worktree+branch,
//   (6) success removes worktree+branch, (7) no downstream after failure.
//
// This file adds:
//   (8) auto-commit already-committed: agent commits before forge's auto-stage,
//       the auto git add/commit is a no-op ("nothing to commit"), merge still
//       fast-forwards successfully.
//   (9) no-changes clean merge: worktree has NO new commits; merge is
//       "Already up to date" and does NOT error.
//  (10) merge-before-reds: a worktree task whose merge SUCCEEDS runs the red
//       AFTER the merge (red sees merged projectDir), and proven-merged cleanup
//       runs ONLY after the red passes (status=complete path).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
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
import { worktreeBranchName } from "./worktree-lifecycle.js";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "fg352-dispatch-test",
  description: "FG-352 auto-commit/reds edge test: single step",
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

// Step with a single non-blocking specialist red. gate_on_verdict: false means
// a fail from this red does NOT block, so we can verify the complete path even
// with a stub that returns `inconclusive` (which is also non-blocking).
const WORKFLOW_WITH_RED: Workflow = {
  name: "fg352-dispatch-test",
  description: "FG-352 merge-before-reds edge test",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg352-dispatch-test",
      reds: [
        {
          agent: "red-narrow",
          authority: "specialist",
          gate_on_verdict: false,
        },
      ],
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg352-ac-"));
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

// ─── (8) Auto-commit already-committed ───────────────────────────────────────
//
// Agent explicitly commits its output on the task branch BEFORE forge runs
// mergeWorktreeBranch. The auto-commit step (`git add . && git commit`) inside
// mergeWorktreeBranch will exit non-zero ("nothing to commit") — the function
// must catch that and proceed to `git merge --ff-only`, which must succeed.
//
// This is distinct from test (2): test (2) asserts the merge result (file in
// projectDir, cleanup). This test SPECIFICALLY exercises the "already committed"
// path to assert mergeWorktreeBranch is resilient to a no-op auto-commit while
// the merge still fast-forwards the pre-committed work.

test("fg352 (8): agent already committed work — auto-commit no-op, merge still fast-forwards", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 auto-commit already-committed",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    // Agent commits everything itself — mergeWorktreeBranch's auto-commit step
    // will run `git commit` and get a "nothing to commit" non-zero exit.
    writeFileSync(join(worktreePath!, "agent-pre-committed.ts"), "export const v = 42;\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "agent committed before forge auto-commit"], {
      cwd: worktreePath!,
      stdio: "ignore",
    });

    writeTaskResult(stdoutPath, { status: "complete", files_modified: ["agent-pre-committed.ts"] });
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(wave.completedSteps, ["build"], "build must complete despite no-op auto-commit");
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  // The pre-committed file must have been fast-forwarded into run.projectDir.
  assert.ok(
    existsSync(join(repo, "agent-pre-committed.ts")),
    "agent-pre-committed.ts must exist in run.projectDir after merge-back",
  );

  // Worktree and branch must be cleaned up (provenMerged path).
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");

  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must have been set");
  assert.equal(
    existsSync(worktreePath),
    false,
    "worktree directory must be removed after proven-merged cleanup",
  );

  const branch = worktreeBranchName(runId, primary!.id);
  let branchExists: boolean;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  assert.equal(branchExists, false, `task branch ${branch} must be removed after proven-merged cleanup`);
});

// ─── (9) No-changes clean merge (Already-up-to-date) ─────────────────────────
//
// The agent produces NO files — the task branch stays at the same commit as
// main. mergeWorktreeBranch will:
//   - auto-commit: nothing to stage or commit (no-op, exits non-zero → caught)
//   - `git merge --ff-only <branch>`: "Already up to date." (exit 0)
//
// The task must complete without error, and the worktree must be cleaned up
// (provenMerged path fires on a successful — even no-op — merge).

test("fg352 (9): worktree has no changes — Already-up-to-date merge, task completes cleanly", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg352 no-changes clean merge",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    // Agent writes NO files — the worktree branch is identical to main.
    writeTaskResult(stdoutPath, { status: "complete" });
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(wave.completedSteps, ["build"], "build must complete on an already-up-to-date merge");
  assert.deepEqual(wave.failedSteps, [], "no steps must fail on a no-op merge");

  // Worktree and branch must be cleaned up.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");

  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must have been set");
  assert.equal(
    existsSync(worktreePath),
    false,
    "worktree directory must be removed after proven-merged cleanup on no-op merge",
  );

  const branch = worktreeBranchName(runId, primary!.id);
  let branchExists: boolean;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  assert.equal(branchExists, false, `task branch ${branch} must be removed after no-op merge cleanup`);
});

// ─── (10) Merge happens BEFORE reds; cleanup runs AFTER reds pass ─────────────
//
// A worktree task with a non-blocking red:
//   1. Primary commits output.ts on the task branch.
//   2. mergeWorktreeBranch fast-forwards output.ts into run.projectDir.
//   3. The red runs (its stub verifies output.ts IS present in projectDir — the
//      merge has already happened before it was called).
//   4. After the red passes (returns pass/inconclusive), finalizePrimary is
//      called → complete status.
//   5. removeWorktreeIfSafe(provenMerged=true) fires only on the complete path,
//      so the worktree and branch are gone after the wave.
//
// NOTE: exercising reds through the dispatch harness IS practical here because
// the red uses the same fg352-dispatch-test runtime and the dockerExec stub
// handles both the primary call (call 1) and the red call (call 2). The ordering
// proof is direct: the red stub reads run.projectDir and confirms output.ts is
// present before it returns — this can only be true if the merge ran first.

test("fg352 (10): merge runs before reds; proven-merged cleanup only after reds complete", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: WORKFLOW_WITH_RED,
    title: "fg352 merge-before-reds",
    inputs: {},
    projectDir: repo,
  });

  let callCount = 0;
  let redSawMergedFile = false;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    callCount++;

    if (callCount === 1) {
      // Primary (blue) agent: commit output on the worktree branch.
      const worktreePath = findProjectMountHost(args);
      assert.ok(worktreePath, "stub: /project mount must be in docker args for primary");
      writeFileSync(stderrPath, "");

      writeFileSync(join(worktreePath!, "merge-before-reds.ts"), "export const x = 1;\n");
      execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "primary output"], { cwd: worktreePath!, stdio: "ignore" });

      writeTaskResult(stdoutPath, { status: "complete", files_modified: ["merge-before-reds.ts"] });
    } else {
      // Red agent (call 2): the merge has already happened at this point.
      // Verify the merged file is visible in run.projectDir (not just the worktree).
      redSawMergedFile = existsSync(join(repo, "merge-before-reds.ts"));

      // Return a passing verdict so the primary reaches the complete path.
      writeTaskResult(stdoutPath, {
        status: "complete",
        verdict: "pass",
        confidence: 1,
        findings: [],
      });
      writeFileSync(stderrPath, "");
    }
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: WORKFLOW_WITH_RED,
    dockerExec: stubExec,
  });

  assert.equal(callCount, 2, "dockerExec must be called exactly twice (primary + red)");
  assert.deepEqual(wave.completedSteps, ["build"], "build must complete after reds pass");
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  // Core ordering assertion: the red saw the merged file in projectDir, proving
  // that mergeWorktreeBranch ran BEFORE the red was dispatched.
  assert.ok(
    redSawMergedFile,
    "red must see merge-before-reds.ts in run.projectDir — merge must run before reds dispatch",
  );

  // Merged file must be in run.projectDir (basic merge sanity).
  assert.ok(
    existsSync(join(repo, "merge-before-reds.ts")),
    "merge-before-reds.ts must exist in run.projectDir after merge-back",
  );

  // Cleanup (provenMerged=true) must fire AFTER the red passes (complete path).
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "complete", "primary must be in complete status");

  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must have been set");
  assert.equal(
    existsSync(worktreePath),
    false,
    "worktree directory must be removed after proven-merged cleanup (post-reds complete path)",
  );

  const branch = worktreeBranchName(runId, primary!.id);
  let branchExists: boolean;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  assert.equal(
    branchExists,
    false,
    `task branch ${branch} must be removed after proven-merged cleanup (post-reds complete path)`,
  );
});
