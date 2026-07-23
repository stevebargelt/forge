// FG-351 dispatch-level integration tests.
//
// The module-only tests in fg351-worktree-lifecycle.integration.test.ts exercise
// isWorktreeModeEnabled, preflightWorktreeGate, createWorktree, etc. in isolation.
// These tests exercise the DISPATCH WIRING — the seam between dispatchSingleStep
// and runContainer — using a stubbed DockerExecFn to observe what actually reaches
// the container spawn layer.
//
// Covers:
//   (dispatch-1) Worktree mount substitution E2E: FORGE_WORKTREES=1 → the
//       container /project mount (SpawnContext.PROJECT_DIR) uses the task-scoped
//       worktree path, not run.projectDir.
//   (dispatch-2) Failure path: a worktree preflight/create failure transitions
//       the task to FAILED, does NOT dispatch a container, and does not leave
//       the task stuck in pending/running.
//   (dispatch-3) Default-off dispatch: FORGE_WORKTREES unset → no worktree path
//       is set, /project mount remains run.projectDir, task completes normally.

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
import { WORKTREES_DIR } from "../util/paths.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixture ─────────────────────────────────────────────────────────
//
// Single engineer step, no reds, auto gate — the simplest shape that exercises
// the full dispatchSingleStep → runContainer path.

const DISPATCH_TEST_WORKFLOW: Workflow = {
  name: "fg351-dispatch-test",
  description: "FG-351 dispatch-level integration test: single step",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg351-dispatch-test",
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg351-disp-"));
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

/** Write a runtime stub with a ${PROJECT_DIR} → /project mount so tests can
 *  observe the resolved host path in docker args. Written fresh each test to
 *  survive FORGE_HOME rotation between test runs. */
function ensureDispatchTestRuntime(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", "fg351-dispatch-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg351-dispatch-test
description: FG-351 dispatch test runtime stub
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
`
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

type ExecCapture = { called: boolean; args: string[] };

/** Stub exec that records call state + docker args, writes a successful result. */
function makeCapturingExec(capture: ExecCapture): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    capture.called = true;
    capture.args = [...args];
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

/** Extract the host-side path from a -v <host>:<container>:<mode> docker arg. */
function findProjectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      const mountArg = dockerArgs[i + 1]!;
      return mountArg.split(":")[0];
    }
  }
  return undefined;
}

// ─── (dispatch-1) Worktree mount substitution ─────────────────────────────────

test("fg351 (dispatch-1): FORGE_WORKTREES=1 → docker /project mount uses worktree path, not run.projectDir", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg351 dispatch worktree mount test",
    inputs: {},
    projectDir: repo,
  });

  const capture: ExecCapture = { called: false, args: [] };
  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: makeCapturingExec(capture),
  });

  // Step must complete — worktree mode is wired end-to-end.
  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    "build step must complete when FORGE_WORKTREES=1 and dispatch wiring is correct"
  );
  assert.ok(capture.called, "docker exec must have been called (step completed)");

  // Task row must have worktreePath durably written before container was called.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.ok(
    primary!.worktreePath,
    "task.worktreePath must be set when FORGE_WORKTREES=1"
  );
  assert.ok(
    primary!.worktreePath!.startsWith(WORKTREES_DIR),
    `task.worktreePath must be under WORKTREES_DIR, got: ${primary!.worktreePath}`
  );

  // FG-352: after a successful merge-back, the worktree is cleaned up
  // (removeWorktreeIfSafe is called with provenMerged=true). The path is still
  // recorded in task.worktreePath (DB record), but the directory is gone.
  assert.equal(
    existsSync(primary!.worktreePath!),
    false,
    "worktree directory must be removed by FG-352 proven-merged cleanup after task completes"
  );

  // Critical assertion: the docker /project mount must be the WORKTREE path.
  const worktreePath = primary!.worktreePath!;
  const projectMountHost = findProjectMountHost(capture.args);

  assert.ok(
    projectMountHost !== undefined,
    "docker args must include a -v arg with /project container path"
  );
  assert.equal(
    projectMountHost,
    worktreePath,
    `docker /project mount host path must be the worktree (${worktreePath}), got: ${projectMountHost}`
  );
  assert.notEqual(
    projectMountHost,
    repo,
    "docker /project mount must NOT use run.projectDir directly when worktree mode is on"
  );
});

// ─── (dispatch-2) Worktree failure path ──────────────────────────────────────

test("fg351 (dispatch-2): worktree preflight failure → task transitions to FAILED, container NOT dispatched", async () => {
  setPlatform("linux"); // Linux gate: preflightWorktreeGate always throws
  process.env.FORGE_WORKTREES = "1";

  // A bare temp dir satisfies preflightProjectMount (empty dir → warning only,
  // no throw), but preflightWorktreeGate's Linux check fires before any git ops.
  const projectDir = makeTmpDir();

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg351 dispatch failure path test",
    inputs: {},
    projectDir,
  });

  const capture: ExecCapture = { called: false, args: [] };
  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: makeCapturingExec(capture),
  });

  // The step must appear in failedSteps, never completedSteps/awaitingGate.
  assert.deepEqual(
    wave.failedSteps,
    ["build"],
    "build step must be in failedSteps when worktree preflight throws"
  );
  assert.deepEqual(wave.completedSteps, [], "no steps must complete on worktree failure");
  assert.deepEqual(wave.awaitingGate, [], "no steps must await gate on worktree failure");

  // Container must NOT have been dispatched.
  assert.equal(
    capture.called,
    false,
    "docker exec must NOT be called when worktree setup fails (gate blocks dispatch)"
  );

  // Task status in DB must be 'failed' — not stuck in pending or running.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(
    primary!.status,
    "failed",
    "task status must be 'failed' after worktree preflight throws — must not be stuck pending/running"
  );

  // worktreePath must NOT be set: setTaskWorktreePath only runs after a
  // successful createWorktree, which is never reached when the gate throws.
  assert.equal(
    primary!.worktreePath,
    undefined,
    "task.worktreePath must be undefined when worktree setup failed (no partial DB state)"
  );
});

// ─── (dispatch-3) Default-off dispatch ───────────────────────────────────────

test("fg351 (dispatch-3): FORGE_WORKTREES unset → /project mount uses run.projectDir, no worktreePath in DB", async () => {
  // FORGE_WORKTREES is cleared in beforeEach — default production state.
  // /tmp/test-project is created by test-setup.ts for preflightProjectMount.
  const projectDir = "/tmp/test-project";

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg351 dispatch default-off test",
    inputs: {},
    projectDir,
  });

  const capture: ExecCapture = { called: false, args: [] };
  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: makeCapturingExec(capture),
  });

  // Step must complete normally — no worktree overhead, existing path preserved.
  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    "build step must complete normally when FORGE_WORKTREES is unset"
  );
  assert.ok(capture.called, "docker exec must be called in default-off mode");

  // Task must have NO worktreePath — worktree code never runs.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(
    primary!.worktreePath,
    undefined,
    "task.worktreePath must be undefined in default-off mode (FORGE_WORKTREES unset)"
  );

  // The docker /project mount must use the original projectDir (not a worktree).
  const projectMountHost = findProjectMountHost(capture.args);
  assert.ok(
    projectMountHost !== undefined,
    "docker args must include a -v arg with /project container path"
  );
  assert.equal(
    projectMountHost,
    projectDir,
    `docker /project mount must use run.projectDir (${projectDir}) when worktree mode is off, got: ${projectMountHost}`
  );
  assert.ok(
    !projectMountHost.includes(WORKTREES_DIR),
    "docker /project mount must NOT use any worktree path in default-off mode"
  );
});
