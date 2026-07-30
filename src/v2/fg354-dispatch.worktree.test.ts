// FG-354 dispatch-level integration tests.
//
// The engineer's tests in fg354-persistence-worktree.test.ts exercise the
// invoke() call site (invoke.ts:564). These tests exercise the DISPATCH SEAM —
// dispatchSingleStep in runNext.ts — which has a SEPARATE call site at
// runNext.ts:474 using the in-scope primaryWorktreePath.
//
// Covers:
//   (dispatch-1) FORGE_WORKTREES=1: a result whose files_modified land under
//       primaryWorktreePath PASSES the persistence check → task completes.
//   (dispatch-2) FORGE_WORKTREES=1: a result whose files only exist under
//       run.projectDir (not the worktree) FAILS with work_not_persisted.
//       This is the falsification case that would pass under a naive
//       "always use projectDir" implementation.
//   (dispatch-3) Non-worktree path: FORGE_WORKTREES unset → persistence check
//       still validates against run.projectDir → regression guard.

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
import { failureKindForTask } from "./failure-kind.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixture ─────────────────────────────────────────────────────────

const DISPATCH_TEST_WORKFLOW: Workflow = {
  name: "fg354-dispatch-test",
  description: "FG-354 dispatch-level integration test: single step",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg354-dispatch-test",
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
  // FG-345: isolation is default-ON and the default follows process.platform, so
  // clearing the switch above no longer means "off". Pin it; the cases that want
  // worktree mode set "1" themselves and still win.
  process.env.FORGE_WORKTREES = "0";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg354-disp-"));
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
  const runtimePath = join(forgeHome, "runtimes", "fg354-dispatch-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg354-dispatch-test
description: FG-354 dispatch test runtime stub
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

/** Extract the host-side path from a -v <host>:<container>:<mode> docker arg. */
function findProjectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

// ─── (dispatch-1) Worktree persistence pass ──────────────────────────────────
//
// FORGE_WORKTREES=1 → dispatchSingleStep creates a worktree and uses
// primaryWorktreePath as the persistence check root. A result that reports
// files_modified with a file that exists under the WORKTREE (not projectDir)
// must PASS the check and let the task complete.

test("fg354 (dispatch-1): FORGE_WORKTREES=1 → file in worktree satisfies persistence check → task completes", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg354 dispatch worktree persistence pass",
    inputs: {},
    projectDir: repo,
  });

  // The stub creates changed.ts under the worktree path (the /project docker
  // mount, which is the worktree when FORGE_WORKTREES=1) then claims it in
  // files_modified. checkResultPersistence(primaryWorktreePath, result) must
  // find the file and return ok: true.
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    // File lands under the worktree — this is what a real agent would do.
    writeFileSync(join(worktreePath, "changed.ts"), "x");

    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({ status: "complete", tests_run: 1, files_modified: ["changed.ts"] }),
    );
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    "build step must complete: file in worktree satisfies persistence check",
  );
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  // Confirm the /project mount pointed at the worktree, not the repo root.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.ok(primary!.worktreePath, "task.worktreePath must be set (FORGE_WORKTREES=1)");
  assert.notEqual(
    primary!.worktreePath,
    repo,
    "/project mount must be the worktree, not run.projectDir",
  );
  // FG-352: after a successful merge-back, the worktree is removed (provenMerged=true).
  // The file that was written to the worktree is now in run.projectDir (merged).
  assert.equal(
    existsSync(primary!.worktreePath!),
    false,
    "worktree must be removed by FG-352 proven-merged cleanup after task completes",
  );
  // The file must exist in the original repo (merged from the worktree branch by FG-352).
  assert.ok(
    existsSync(join(repo, "changed.ts")),
    "changed.ts must exist in projectDir after FG-352 merge-back",
  );
});

// ─── (dispatch-2) Worktree persistence FAIL — key falsification case ──────────
//
// FORGE_WORKTREES=1 → checkResultPersistence uses primaryWorktreePath. A file
// present in run.projectDir but NOT in the worktree must FAIL the check with
// work_not_persisted. This is the case that would silently pass under a naive
// implementation that always checks projectDir.

test("fg354 (dispatch-2): FORGE_WORKTREES=1 → file only in projectDir (not worktree) fails persistence check → work_not_persisted", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  // Place changed.ts in projectDir (untracked, so it won't appear in the worktree).
  writeFileSync(join(repo, "changed.ts"), "x");

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg354 dispatch worktree persistence fail",
    inputs: {},
    projectDir: repo,
  });

  // The stub claims changed.ts in files_modified but does NOT create it in the
  // worktree. The file only exists in projectDir (repo). With the FG-354 fix,
  // checkResultPersistence uses primaryWorktreePath — so it won't find the file
  // in the worktree and must reject with work_not_persisted.
  let capturedProjectMount: string | undefined;
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    capturedProjectMount = findProjectMountHost(args);

    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({ status: "complete", tests_run: 1, files_modified: ["changed.ts"] }),
    );
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(
    wave.failedSteps,
    ["build"],
    "build step must fail: file only in projectDir, not in worktree",
  );
  assert.deepEqual(wave.completedSteps, [], "no steps must complete");

  // The /project mount must have been the WORKTREE, not projectDir.
  assert.ok(capturedProjectMount, "stub: /project mount must appear in docker args");
  assert.notEqual(
    capturedProjectMount,
    repo,
    "/project mount must be the worktree (not projectDir) when FORGE_WORKTREES=1",
  );
  // File must NOT exist in worktree (only in projectDir) — confirming the stub
  // setup is correct before asserting the failure kind.
  assert.equal(
    existsSync(join(capturedProjectMount!, "changed.ts")),
    false,
    "changed.ts must NOT be in the worktree — this is the test's core precondition",
  );
  // changed.ts DOES exist in projectDir — confirming a naive always-projectDir
  // check would have passed (and therefore this test would fail).
  assert.ok(
    existsSync(join(repo, "changed.ts")),
    "changed.ts must exist in projectDir (naive check would pass; FG-354 fix must catch it)",
  );

  // Task must have been failed with the correct kind.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "failed", "task status must be failed");
  assert.equal(
    failureKindForTask(primary!.id),
    "work_not_persisted",
    "failure kind must be work_not_persisted (not a generic failure)",
  );
});

// ─── (dispatch-3) Non-worktree regression guard ───────────────────────────────
//
// FORGE_WORKTREES unset → dispatchSingleStep never creates a worktree;
// primaryWorktreePath stays undefined; checkResultPersistence receives
// args.projectDir. A file present in projectDir must still pass.
// This guards against a naive "always use worktreePath" regression.

test("fg354 (dispatch-3): FORGE_WORKTREES unset → file in projectDir satisfies persistence check → task completes", async () => {
  // FORGE_WORKTREES is pinned off in beforeEach — the bind-mount lane.
  const projectDir = makeTmpDir();
  // Create changed.ts in projectDir (no git repo needed — not in worktree mode).
  writeFileSync(join(projectDir, "changed.ts"), "x");

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg354 dispatch default-off persistence regression",
    inputs: {},
    projectDir,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    // Confirm /project mount is projectDir (not a worktree) in this mode.
    const projectMount = findProjectMountHost(args);
    assert.ok(projectMount, "stub: /project mount must be in docker args");
    assert.equal(
      projectMount,
      projectDir,
      "/project mount must be projectDir when FORGE_WORKTREES is unset",
    );

    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({ status: "complete", tests_run: 1, files_modified: ["changed.ts"] }),
    );
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    "build step must complete: file in projectDir satisfies persistence check when no worktree",
  );
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  // No worktreePath must be set on the task in default-off mode.
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(
    primary!.worktreePath,
    undefined,
    "task.worktreePath must be undefined when FORGE_WORKTREES is unset",
  );
});

// ─── (dispatch-4/5) FG-491 annotation-shape acceptance through the dispatch seam ──
//
// fg491-persistence-annotated-invoke.integration.test.ts pins the annotated-claim
// fix (and the reopened prose-rejection) through invoke.ts's call site only.
// dispatchSingleStep in runNext.ts (this file's seam) calls checkResultPersistence
// at its own call site (runNext.ts:537) with the same primaryWorktreePath ??
// args.projectDir signature — that wiring needs its own proof, since it's the
// path FG-497's chain evidence actually hit.

test("fg491 (dispatch-4): FORGE_WORKTREES=1 → annotated files_modified referencing a real file in the worktree → task completes (no work_not_persisted downgrade)", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg491 dispatch worktree annotated-claim pass",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(join(worktreePath, "changed.ts"), "x");

    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        status: "complete", tests_run: 1,
        files_modified: ["changed.ts:1-5 — annotated claim, PR-review style"],
      }),
    );
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    "build step must complete: annotated claim resolving to a real file in the worktree must not trip work_not_persisted",
  );
  assert.deepEqual(wave.failedSteps, [], "no steps must fail");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.notEqual(
    failureKindForTask(primary!.id),
    "work_not_persisted",
    "no persistence downgrade for a real annotated claim through the dispatch seam",
  );
});

test("fg491 (reopened, dispatch-5): FORGE_WORKTREES=1 → prose-only claim whose first word names a real file in the worktree → task fails work_not_persisted, error reports it unparseable", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg491 dispatch worktree prose-rejection fail",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    // The real file exists under the worktree — a naive "first token names a
    // real file" check would wrongly treat this prose as proof of persistence.
    writeFileSync(join(worktreePath, "README.md"), "# test\n");

    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        status: "complete", tests_run: 1,
        files_modified: ["README.md updated the real file elsewhere"],
      }),
    );
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: stubExec,
  });

  assert.deepEqual(
    wave.failedSteps,
    ["build"],
    "build step must fail: prose claim must never count as proof of persistence just because its first word names a real file",
  );
  assert.deepEqual(wave.completedSteps, [], "no steps must complete");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  assert.equal(primary!.status, "failed", "task status must be failed");
  assert.equal(
    failureKindForTask(primary!.id),
    "work_not_persisted",
    "failure kind must be work_not_persisted (not a generic failure)",
  );
  assert.match(primary!.error ?? "", /work not persisted/);
  assert.match(
    primary!.error ?? "",
    /README\.md updated the real file elsewhere/,
    "error must name the raw prose claim",
  );
  assert.match(
    primary!.error ?? "",
    /unparseable|no parseable path token/i,
    "error must call out the claim as unparseable through the dispatch seam, same as the invoke seam",
  );
});
