// FG-357 dispatch-level integration tests.
//
// Worktrees (FG-351/352/353) convert same-file TEXTUAL races into detectable
// git conflicts, but semantic cross-file breakage merges CLEAN: agent A
// changes a signature in foo.ts, agent B (own worktree) still calls the old
// signature in bar.ts — `git merge` sees no overlapping lines and succeeds.
// This suite exercises the post-merge integration gate added to
// dispatchSingleStep: after mergeWorktreeBranch succeeds, forge runs the
// project's own `npm run test:unit` against the merged tree (run.projectDir)
// and fails the task with failure_kind=integration_failed if it doesn't pass.
//
// Covers:
//   (1) Clean merge whose merged result fails build/test → task fails with
//       failure_kind integration_failed (not completed green).
//   (2) integration_failed is non-retryable (retry-policy).
//   (3) Worktree directory and task branch are retained for inspection when
//       the integration gate fails (no-discard, same contract as merge_conflict).
//   (4) Clean merge whose merged result PASSES build/test completes green.
//
// Fanout seams (the primary FG-357 scenario: agent A and agent B in separate
// worktrees, clean merge, broken cross-file integration):
//   (5) Fanout post-reds seam (runNext.ts ~1511): reds pass, integration merges
//       to HEAD, merged tree fails test:unit → integration_failed, all state retained.
//   (6) Fanout no-reds seam (runNext.ts ~1557): integration merges to HEAD,
//       merged tree fails test:unit → integration_failed, all state retained.
//   (7) Fanout re-entry seam (runNext.ts ~1193): forced gate advance after
//       blocked_by_red, integration merges to HEAD, merged tree fails test:unit
//       → integration_failed, all state retained.
//   (8) Fanout pass case: merged tree passes test:unit → parent completes,
//       integration + child worktrees cleaned up.
//   (9) FG-424 negative test: an injected infra-style (signal-killed, not a
//       timeout, not an ordinary test failure) test:unit run must NOT produce
//       failure_kind integration_failed / the "fix the code" non-retryable
//       path — it must classify as integration_gate_crashed instead, while
//       preserving the same no-discard worktree/branch retention contract.
//   (10) FG-424 fanout no-reds seam (runNext.ts ~1578): the same negative test
//       as (9), but through the fanout dispatch path (a distinct classify()
//       call site from the one (9) exercises) — proves FG-424's evidence
//       plumbing isn't seam-specific.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
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
import { retryPolicy } from "./retry-policy.js";
import { worktreeBranchName, integrationBranchName } from "./worktree-lifecycle.js";
import { integrationWorktreeDir } from "../util/paths.js";
import { gate } from "./gate.js";

// ─── Workflow fixture ──────────────────────────────────────────────────────────

const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "fg357-dispatch-test",
  description: "FG-357 dispatch-level integration test: single step",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg357-dispatch-test",
      reds: [],
    },
  ],
};

// Two-step fanout, no reds: source (planner) provides an items array; build
// (engineer) fans out over it with max_concurrency: 2. Exercises the fanout
// no-reds integration gate seam (runNext.ts ~1557).
const FANOUT_WORKFLOW: Workflow = {
  name: "fg357-fanout-test",
  description: "FG-357 dispatch-level integration test: fanout, no reds",
  inputs: [],
  steps: [
    {
      id: "source",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg357-dispatch-test",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg357-dispatch-test",
      reds: [],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
  ],
};

// Same as FANOUT_WORKFLOW but the build step has one authoritative red.
// Exercises the fanout post-reds integration gate seam (runNext.ts ~1511) and,
// via a forced gate advance after an authoritative red failure, the fanout
// re-entry seam (runNext.ts ~1193).
const FANOUT_WITH_RED_WORKFLOW: Workflow = {
  name: "fg357-fanout-red-test",
  description: "FG-357 dispatch-level integration test: fanout with authoritative red",
  inputs: [],
  steps: [
    {
      id: "source",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg357-dispatch-test",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg357-dispatch-test",
      reds: [
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
  ],
};

// ─── Shared harness (mirrors fg352-dispatch.worktree.test.ts) ─────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "FORGE_INTEGRATION_GATE_TIMEOUT_MS",
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg357-disp-"));
  tmpDirs.push(dir);
  return dir;
}

/** Init a git repo whose committed package.json exposes a `test:unit` script
 *  that deterministically passes or fails — standing in for "the merged tree
 *  builds+tests cleanly" vs. "clean merge, broken integration". */
function initGitRepo(dir: string, testUnitPasses: boolean): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fg357-fake-project",
      private: true,
      scripts: { "test:unit": testUnitPasses ? "true" : "false" },
    }),
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

/** Init a git repo with an arbitrary `test:unit` shell script — used by the
 *  fanout seams, where the source (planner) step ALSO passes through the
 *  single-task integration gate (seam ~502) before the fanout build step ever
 *  runs. A static pass/fail script would fail source too; instead the script
 *  only fails once the fanout children's merged files are present, mirroring
 *  "clean merge, broken cross-file integration" — source touches no files, so
 *  it's unaffected, while the fanout build step's post-merge state is gated. */
function initGitRepoWithTestUnitScript(dir: string, testUnitScript: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fg357-fanout-fake-project",
      private: true,
      scripts: { "test:unit": testUnitScript },
    }),
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

function ensureDispatchTestRuntime(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", "fg357-dispatch-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg357-dispatch-test
description: FG-357 dispatch test runtime stub
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

// Write the FANOUT_WITH_RED_WORKFLOW YAML so gate() can load it by name —
// needed for the forced re-entry test (gate.ts loads the run's workflow from
// disk when resolving a force-advance).
function ensureFanoutRedWorkflowYaml(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const wfPath = join(forgeHome, "workflows", "fg357-fanout-red-test.yml");
  if (existsSync(wfPath)) return;
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg357-fanout-red-test
description: FG-357 fanout with authoritative red
inputs: []
steps:
  - id: source
    agent: planner
    gate: auto
    manual: false
    depends_on: []
    runtime: fg357-dispatch-test
    reds: []
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: [source]
    runtime: fg357-dispatch-test
    reds:
      - agent: red-narrow
        authority: authoritative
        gate_on_verdict: true
    fanout:
      from_upstream:
        step: source
        array_key: items
        input_key: item
      max_concurrency: 2
      failure_mode: continue
`,
  );
}

/** Extract the task ID from the --name forge-<taskId> docker arg. */
function extractTaskId(args: string[]): string {
  const nameIdx = args.indexOf("--name");
  return nameIdx >= 0 ? (args[nameIdx + 1] ?? "").replace(/^forge-/, "") : "";
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

/** A dockerExec stub that commits a file on the worktree branch (clean merge
 *  guaranteed — no divergence on main) and writes a completed result.json. */
function makeCleanMergeExec(fileName: string): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");

    writeFileSync(join(worktreePath!, fileName), "export const x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "task output"], { cwd: worktreePath!, stdio: "ignore" });

    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [fileName] });
    return 0;
  };
}

// ─── (1) Clean merge, broken integration → integration_failed ────────────────

test("fg357 (1): clean merge whose merged tree fails build/test → task fails with failure_kind integration_failed", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo, /* testUnitPasses */ false);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg357 broken integration",
    inputs: {},
    projectDir: repo,
  });

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeCleanMergeExec("output.ts"),
  });

  assert.deepEqual(wave.failedSteps, ["build"], "build must fail when the merged tree fails test:unit");
  assert.deepEqual(wave.completedSteps, [], "no steps must complete");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "failed", "task status must be failed");
  assert.equal(
    failureKindForTask(primary!.id),
    "integration_failed",
    "failure kind must be integration_failed, distinct from merge_conflict",
  );

  // The merge itself succeeded (ff-only, no divergence) — the file must be in
  // run.projectDir even though the task failed the integration gate.
  assert.ok(
    existsSync(join(repo, "output.ts")),
    "output.ts must be present in run.projectDir — the merge itself was clean",
  );
});

// ─── (2) integration_failed is non-retryable ──────────────────────────────────

test("fg357 (2): integration_failed is non-retryable with advice", () => {
  const disposition = retryPolicy("integration_failed");
  assert.equal(disposition.retryable, false, "integration_failed must not be retryable");
  assert.ok(disposition.advice, "integration_failed must carry remediation advice");
});

// ─── (3) Worktree and branch retained on integration_failed ──────────────────

test("fg357 (3): integration gate failure retains worktree directory and task branch", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo, /* testUnitPasses */ false);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg357 retain on integration failure",
    inputs: {},
    projectDir: repo,
  });

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeCleanMergeExec("retained.ts"),
  });

  assert.deepEqual(wave.failedSteps, ["build"], "build must fail on integration gate failure");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");

  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must be set");
  assert.ok(existsSync(worktreePath), "worktree directory must be retained after integration gate failure");

  const branch = worktreeBranchName(runId, primary!.id);
  let branchExists: boolean;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  assert.ok(branchExists, `task branch ${branch} must be retained after integration gate failure`);
});

// ─── (4) Clean merge, passing integration → completes green ──────────────────

test("fg357 (4): clean merge whose merged tree passes build/test completes green", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo, /* testUnitPasses */ true);

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg357 passing integration",
    inputs: {},
    projectDir: repo,
  });

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeCleanMergeExec("passing.ts"),
  });

  assert.deepEqual(wave.completedSteps, ["build"], "build must complete when the merged tree passes test:unit");
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "complete", "task status must be complete");
  assert.equal(
    failureKindForTask(primary!.id),
    undefined,
    "a completed task must have no recorded failure_kind",
  );

  assert.ok(
    existsSync(join(repo, "passing.ts")),
    "merged file must be present in run.projectDir after a green integration gate",
  );

  // Successful merge + passing gate → worktree cleaned up (provenMerged=true).
  assert.equal(
    existsSync(worktreePathFor(tasks, "build")),
    false,
    "worktree directory must be removed after a successful merge + passing integration gate",
  );
});

// ─── (9) FG-424 negative test: signal-killed test:unit → integration_gate_crashed ─
//
// The ticket's required negative test: an injected infra-style failure (the
// test:unit script killed by signal, not a timeout, not an ordinary non-zero
// test exit) must NOT be classified as the non-retryable integration_failed
// "fix the code" path.

test("fg424 (9): test:unit killed by signal → failure_kind integration_gate_crashed, not integration_failed; no fix-the-code advice; worktree/branch retained", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepoWithTestUnitScript(repo, "kill -9 $$");

  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "fg424 signal-killed integration gate",
    inputs: {},
    projectDir: repo,
  });

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeCleanMergeExec("crashed.ts"),
  });

  assert.deepEqual(wave.failedSteps, ["build"], "build must fail when the integration gate is killed by signal");
  assert.deepEqual(wave.completedSteps, [], "no steps must complete");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "failed", "task status must be failed");
  assert.equal(
    failureKindForTask(primary!.id),
    "integration_gate_crashed",
    "a signal-killed gate run must classify as integration_gate_crashed, not integration_failed",
  );

  const disposition = retryPolicy("integration_gate_crashed");
  assert.equal(disposition.retryable, false, "integration_gate_crashed must not be retryable");
  assert.doesNotMatch(disposition.advice ?? "", /fix the code/i, "advice must not misdirect toward a code fix");
  assert.doesNotMatch(disposition.advice ?? "", /git reset/i, "advice must not offer the integration_failed git-reset remedy");

  // Same no-discard contract as integration_failed: worktree and branch retained.
  const worktreePath = primary!.worktreePath!;
  assert.ok(worktreePath, "task.worktreePath must be set");
  assert.ok(existsSync(worktreePath), "worktree directory must be retained after a signal-killed integration gate");
  assertBranchRetained(repo, runId, primary!.id);
});

function worktreePathFor(tasks: ReturnType<typeof tasksForRun>, phase: string): string {
  const t = tasks.find((task) => task.phase === phase && task.parentId === undefined);
  return t?.worktreePath as string;
}

/** Assert a task's branch (worktreeBranchName) exists in `repo`. */
function assertBranchRetained(repo: string, runId: string, taskId: string): void {
  const branch = worktreeBranchName(runId, taskId);
  let branchExists = false;
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { cwd: repo, stdio: "ignore" });
    branchExists = true;
  } catch { /* not found */ }
  assert.ok(branchExists, `branch ${branch} (task ${taskId}) must be retained`);
}

// ─── (5) Fanout post-reds: clean merge to HEAD, broken integration ───────────
//
// FANOUT_WITH_RED_WORKFLOW: two children, one authoritative red that passes.
// After the red passes, the integration branch is merged to HEAD (clean —
// children touch disjoint files), but the merged tree fails test:unit. This
// exercises the post-reds integration gate seam (runNext.ts ~1511): the gate
// failure must return BEFORE removeWorktreeIfSafe/cleanupIntegrationWorktree,
// so the integration worktree and both completed children's worktrees/branches
// stay on disk for inspection — same no-discard contract as merge_conflict.

test("fg357 (5): fanout post-reds seam — red passes, merge to HEAD clean, merged tree fails test:unit → integration_failed, all state retained", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  // Fails once BOTH fanout children's files have merged in — passes for the
  // earlier "source" step, which touches no files.
  initGitRepoWithTestUnitScript(repo, "test ! -f child1.ts");

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg357 fanout post-reds broken integration",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Authoritative red passes — the post-reds merge-to-HEAD path runs next.
      writeTaskResult(stdoutPath, { status: "complete", verdict: "pass", confidence: 1.0, findings: [] });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.failedSteps, ["build"], "build must fail when the merged tree fails test:unit after red passes");
  assert.deepEqual(wave2.completedSteps, [], "no steps must complete");
  assert.equal(
    wave2.awaitingGate.includes("build"),
    false,
    "build must not be awaiting_gate — integration gate failure returns before finalizePrimary runs",
  );

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "failed", "parent status must be failed");
  assert.equal(
    failureKindForTask(parentTask!.id),
    "integration_failed",
    "failure kind must be integration_failed, distinct from merge_conflict",
  );

  // The integration→HEAD merge itself succeeded (children touch disjoint files)
  // before the gate ran — both child files must be in run.projectDir.
  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must be present — integration merged to HEAD before the gate ran");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must be present — integration merged to HEAD before the gate ran");

  // Integration worktree directory retained — cleanupIntegrationWorktree is
  // only reached after a passing gate.
  const integPath = integrationWorktreeDir(runId, parentTask!.id);
  assert.ok(existsSync(integPath), "integration worktree must be retained after integration gate failure");

  // Both completed children's worktrees and branches retained — removeWorktreeIfSafe
  // is only reached after a passing gate.
  const children = allTasks.filter((t) => t.parentId === parentTask!.id && !t.agentRole.startsWith("red-"));
  assert.equal(children.length, 2, "two fanout children must exist");
  for (const child of children) {
    assert.ok(child.worktreePath, `child ${child.id} must have worktreePath recorded`);
    assert.ok(existsSync(child.worktreePath!), `child ${child.id} worktree must be retained after integration gate failure`);
    assertBranchRetained(repo, runId, child.id);
  }
});

// ─── (6) Fanout no-reds: clean merge to HEAD, broken integration ─────────────
//
// FANOUT_WORKFLOW: two children, no reds. Integration merges to HEAD cleanly
// (children touch disjoint files), but the merged tree fails test:unit. This
// exercises the no-reds integration gate seam (runNext.ts ~1557) — the same
// no-discard contract as (5), reached via the branch that skips red dispatch
// entirely.

test("fg357 (6): fanout no-reds seam — merge to HEAD clean, merged tree fails test:unit → integration_failed, all state retained", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  // Fails once BOTH fanout children's files have merged in — passes for the
  // earlier "source" step, which touches no files.
  initGitRepoWithTestUnitScript(repo, "test ! -f child1.ts");

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg357 fanout no-reds broken integration",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.failedSteps, ["build"], "build must fail when the merged tree fails test:unit");
  assert.deepEqual(wave2.completedSteps, [], "no steps must complete");

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "failed", "parent status must be failed");
  assert.equal(
    failureKindForTask(parentTask!.id),
    "integration_failed",
    "failure kind must be integration_failed, distinct from merge_conflict",
  );

  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must be present — integration merged to HEAD before the gate ran");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must be present — integration merged to HEAD before the gate ran");

  const integPath = integrationWorktreeDir(runId, parentTask!.id);
  assert.ok(existsSync(integPath), "integration worktree must be retained after integration gate failure");

  const children = allTasks.filter((t) => t.parentId === parentTask!.id && !t.agentRole.startsWith("red-"));
  assert.equal(children.length, 2, "two fanout children must exist");
  for (const child of children) {
    assert.ok(child.worktreePath, `child ${child.id} must have worktreePath recorded`);
    assert.ok(existsSync(child.worktreePath!), `child ${child.id} worktree must be retained after integration gate failure`);
    assertBranchRetained(repo, runId, child.id);
  }
});

// ─── (7) Fanout re-entry: forced gate advance, broken integration ────────────
//
// FANOUT_WITH_RED_WORKFLOW. Wave 2: children complete, integration built, the
// authoritative red FAILS → parent blocked_by_red (integration branch/worktree
// retained, HEAD not yet touched). gate(parentId, 'advance', { force: true })
// force-advances the parent to pending with gateForced=true. Wave 3 re-entry
// (runNext.ts ~1193) detects redsAlreadyRan + an existing integration branch,
// skips child/red dispatch, and merges integration to HEAD — but the merged
// tree fails test:unit, so the re-entry gate check must fail the parent with
// integration_failed and retain all worktree/branch state (no silent completion).

test("fg357 (7): fanout re-entry seam — forced gate advance, merge to HEAD clean, merged tree fails test:unit → integration_failed, all state retained", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  // Fails once BOTH fanout children's files have merged in — passes for the
  // earlier "source" step, which touches no files.
  initGitRepoWithTestUnitScript(repo, "test ! -f child1.ts");
  ensureFanoutRedWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg357 fanout re-entry broken integration",
    inputs: {},
    projectDir: repo,
  });

  const FAIL_VERDICT = {
    status: "complete", tests_run: 1,
    verdict: "fail",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "fg357 re-entry test finding",
        evidence: "test evidence",
        hypothesis: "test hypothesis",
      },
    ],
  };

  let wave3ExecCount = 0;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Authoritative fail → parent blocked_by_red after wave 2.
      writeTaskResult(stdoutPath, FAIL_VERDICT);
    } else {
      wave3ExecCount++;
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source step ────────────────────────────────────────────────────
  const wave1 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  // ── Wave 2: fanout (children + integration built + red fails) ─────────────
  const wave2 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.ok(
    wave2.awaitingGate.includes("build") || wave2.failedSteps.includes("build"),
    "build must be blocked or awaiting gate after authoritative red fail",
  );

  const tasksAfterWave2 = tasksForRun(runId);
  const parentTask = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  const parentId = parentTask!.id;
  assert.equal(parentTask!.status, "blocked_by_red", "parent must be blocked_by_red after authoritative fail");

  const integPath = integrationWorktreeDir(runId, parentId);
  assert.ok(existsSync(integPath), "integration worktree must be retained when parent is blocked_by_red");

  // ── Force-advance via gate ────────────────────────────────────────────────
  await gate(parentId, "advance", "forced: fg357 re-entry test", { force: true });

  const tasksAfterGate = tasksForRun(runId);
  const parentAfterGate = tasksAfterGate.find((t) => t.id === parentId);
  assert.equal(parentAfterGate!.status, "pending", "parent must be pending after gate force-advance");
  assert.strictEqual(
    parentAfterGate!.taskPackage?.inputs?.["gateForced"],
    true,
    "gateForced flag must be set on parent inputs",
  );

  // ── Wave 3: re-entry — integration merges to HEAD, then the gate fails ────
  const wave3ExecsBefore = wave3ExecCount;
  const wave3 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave3.failedSteps, ["build"], "build must FAIL in wave 3 re-entry when the merged tree fails test:unit");
  assert.deepEqual(wave3.completedSteps, [], "no steps must complete in wave 3");

  // No new containers must have been dispatched in wave 3 re-entry — child/red
  // dispatch is skipped once redsAlreadyRan + the integration branch exists.
  assert.equal(wave3ExecCount, wave3ExecsBefore, "no new docker execs must be triggered in wave 3 re-entry");

  const finalTasks = tasksForRun(runId);
  const finalParent = finalTasks.find((t) => t.id === parentId);
  assert.equal(finalParent!.status, "failed", "parent must be failed after wave 3 re-entry gate failure");
  assert.equal(
    failureKindForTask(finalParent!.id),
    "integration_failed",
    "failure kind must be integration_failed for the re-entry gate failure",
  );

  // Integration→HEAD merge succeeded before the gate ran — both child files present.
  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must be present — re-entry integration merged to HEAD before the gate ran");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must be present — re-entry integration merged to HEAD before the gate ran");

  // Integration worktree retained — cleanupIntegrationWorktree is only reached
  // after a passing gate in the re-entry branch too.
  assert.ok(existsSync(integPath), "integration worktree must be retained after re-entry integration gate failure");

  // Integration branch itself retained.
  const intBranch = integrationBranchName(runId, parentId);
  let intBranchExists = false;
  try {
    execFileSync("git", ["rev-parse", "--verify", intBranch], { cwd: repo, stdio: "ignore" });
    intBranchExists = true;
  } catch { /* branch gone */ }
  assert.ok(intBranchExists, "integration branch must be retained after re-entry integration gate failure");

  // Completed children's worktrees and branches retained.
  const children = finalTasks.filter((t) => t.parentId === parentId && !t.agentRole.startsWith("red-"));
  assert.equal(children.length, 2, "two fanout children must exist");
  for (const child of children) {
    assert.ok(child.worktreePath, `child ${child.id} must have worktreePath recorded`);
    assert.ok(existsSync(child.worktreePath!), `child ${child.id} worktree must be retained after re-entry integration gate failure`);
    assertBranchRetained(repo, runId, child.id);
  }
});

// ─── (8) Fanout pass case: clean merge to HEAD, integration passes ───────────
//
// FANOUT_WORKFLOW, no reds. Proves the fanout integration gate is not falsely
// failing: when the merged tree passes test:unit, the parent completes and the
// integration + child worktrees are cleaned up (provenMerged cleanup), same as
// the sequential-seam passing case (test 4).

test("fg357 (8): fanout pass case — merge to HEAD clean, merged tree passes test:unit → parent completes, worktrees cleaned up", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo, /* testUnitPasses */ true);

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg357 fanout passing integration",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "build must complete when the merged tree passes test:unit");
  assert.deepEqual(wave2.failedSteps, [], "no steps must fail");

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "complete", "parent must be complete");
  assert.equal(
    failureKindForTask(parentTask!.id),
    undefined,
    "a completed parent must have no recorded failure_kind",
  );

  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must be present after a green integration gate");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must be present after a green integration gate");

  const integPath = integrationWorktreeDir(runId, parentTask!.id);
  assert.equal(
    existsSync(integPath),
    false,
    "integration worktree must be removed after a successful merge + passing integration gate",
  );

  const children = allTasks.filter((t) => t.parentId === parentTask!.id && !t.agentRole.startsWith("red-"));
  assert.equal(children.length, 2, "two fanout children must exist");
  for (const child of children) {
    if (child.worktreePath) {
      assert.equal(
        existsSync(child.worktreePath),
        false,
        `child ${child.id} worktree must be removed after a successful merge + passing integration gate`,
      );
    }
  }
});

// ─── (10) FG-424 fanout no-reds seam: signal-killed test:unit → integration_gate_crashed ─
//
// Test (9) exercises FG-424's classify({ integrationGate }) evidence only
// through the single-step dispatch seam (runNext.ts ~524). The fanout no-reds
// seam (runNext.ts ~1578, exercised for integration_failed by test (6)) is a
// distinct call site with its own gate.status/signal/timedOut wiring — this
// proves the same infra-vs-real-failure distinction holds there too, not just
// in the seam that happens to run first.

test("fg424 (10): fanout no-reds seam — test:unit killed by signal → failure_kind integration_gate_crashed, not integration_failed, all state retained", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  // Mirrors test (6)'s "test ! -f child1.ts" gating: the source step (which
  // also passes through the integration gate) must stay green, and only the
  // fanout build step's post-merge run.projectDir — once both children's
  // files are present — hits the signal-kill.
  initGitRepoWithTestUnitScript(repo, "test ! -f child1.ts || kill -9 $$");

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg424 fanout no-reds signal-killed integration gate",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"], "source must stay green — it touches no files, so the gated kill never fires for it");

  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.failedSteps, ["build"], "build must fail when the integration gate is killed by signal");
  assert.deepEqual(wave2.completedSteps, [], "no steps must complete");

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "failed", "parent status must be failed");
  assert.equal(
    failureKindForTask(parentTask!.id),
    "integration_gate_crashed",
    "a signal-killed gate run must classify as integration_gate_crashed, not integration_failed, in the fanout no-reds seam too",
  );

  const disposition = retryPolicy("integration_gate_crashed");
  assert.equal(disposition.retryable, false, "integration_gate_crashed must not be retryable");
  assert.doesNotMatch(disposition.advice ?? "", /fix the code/i, "advice must not misdirect toward a code fix");
  assert.doesNotMatch(disposition.advice ?? "", /git reset/i, "advice must not offer the integration_failed git-reset remedy");

  // Same no-discard contract as (6)'s integration_failed case: integration
  // worktree and both children's worktrees/branches retained.
  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must be present — integration merged to HEAD before the gate ran");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must be present — integration merged to HEAD before the gate ran");

  const integPath = integrationWorktreeDir(runId, parentTask!.id);
  assert.ok(existsSync(integPath), "integration worktree must be retained after a signal-killed integration gate");

  const children = allTasks.filter((t) => t.parentId === parentTask!.id && !t.agentRole.startsWith("red-"));
  assert.equal(children.length, 2, "two fanout children must exist");
  for (const child of children) {
    assert.ok(child.worktreePath, `child ${child.id} must have worktreePath recorded`);
    assert.ok(existsSync(child.worktreePath!), `child ${child.id} worktree must be retained after a signal-killed integration gate`);
    assertBranchRetained(repo, runId, child.id);
  }
});
