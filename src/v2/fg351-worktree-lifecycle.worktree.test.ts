// FG-351 integration tests: worktree lifecycle foundation.
//
// Covers:
//   (a) macOS happy path — gate passes on darwin, worktree created under WORKTREES_DIR,
//       DB row has worktreePath, worktreeDir path under FORGE_HOME.
//   (b) Linux gate — preflightWorktreeGate throws on linux without FORGE_NO_WORKTREES;
//       FORGE_NO_WORKTREES=1 makes isWorktreeModeEnabled() return false (kill switch).
//   (c) Non-git gate — preflightWorktreeGate throws for a dir with no .git ancestor;
//       FORGE_NO_WORKTREES=1 disables mode at isWorktreeModeEnabled() level.
//   (d) Dirty-state gate — throws on dirty tracked tree; FORGE_WORKTREE_IGNORE_DIRTY bypasses.
//   (e) Repo-root resolution — createWorktree uses the repo root as cwd, not a subdir.
//   (f) Persisted task state — setTaskWorktreePath + getTask round-trip across restart.
//   (g) Cleanup safety — removeWorktreeIfSafe no-ops without EPHEMERAL; removes with EPHEMERAL.
//   (h) worktreeBranchName returns 'forge/<runId>/<taskId>'.
//   (FG-345) isWorktreeModeEnabled resolution table — kill switch, explicit on,
//       explicit off, and the platform default in BOTH directions.
//
// Strategy: real temp git repos for git-path tests (NOT the project repo). Object.defineProperty
// for process.platform overrides. removeWorktreeIfSafe receives explicit projectDir — no
// process.chdir needed. Mock process.platform for platform-gate tests.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask, setTaskWorktreePath } from "../store/tasks.js";
import {
  worktreeBranchName,
  isWorktreeModeEnabled,
  preflightWorktreeGate,
  createWorktree,
  removeWorktreeIfSafe,
} from "./worktree-lifecycle.js";
import { applyMigrations } from "../store/db.js";
import { worktreeDir, WORKTREES_DIR } from "../util/paths.js";
import type { Run, Task } from "../types/index.js";

// ─── Shared harness ───────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

// Env vars restored around each test
const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

// ─── Test fixture data ────────────────────────────────────────────────────────

const RUN_ID = "run-fg351";
const TASK_ID = "task-fg351-1";

const TEST_RUN: Run = {
  id: RUN_ID,
  workflow: "feature",
  title: "FG-351 integration test run",
  status: "active",
  createdAt: "2026-06-23T00:00:00Z",
};

function makeTask(id = TASK_ID, runId = RUN_ID): Task {
  return {
    id,
    runId,
    phase: "build",
    agentRole: "backend-specialist",
    status: "pending",
    taskPackage: {
      taskId: id,
      runId,
      phase: "build",
      role: "backend-specialist",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-06-23T00:00:00Z",
  };
}

// ─── Per-test lifecycle ───────────────────────────────────────────────────────

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(TEST_RUN);

  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();

  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }

  // Restore process.platform. REAL_PLATFORM, not process.platform: by the time
  // this runs the value has already been overridden, so re-reading it here
  // restores the spoof and leaks it into every later test in the file.
  setPlatform(REAL_PLATFORM);

  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg351-"));
  tmpDirs.push(dir);
  return dir;
}

/** Captured before any test can spoof it. */
const REAL_PLATFORM = process.platform;

/** Override process.platform for the duration of this test. */
function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

/** Create a real git repo in `dir` with one initial commit. */
function initGitRepo(dir: string, options: { dirty?: boolean } = {}): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Forge Test"], {
    cwd: dir,
    stdio: "ignore",
  });
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  if (options.dirty) {
    // Modify a tracked file so the tree is dirty.
    writeFileSync(join(dir, "README.md"), "# modified — dirty\n");
  }
}

// ─── (h) Branch naming — deterministic derivation ────────────────────────────

test("fg351 (h): worktreeBranchName returns forge/<runId>/<taskId>", () => {
  assert.equal(
    worktreeBranchName("run-abc", "task-xyz"),
    "forge/run-abc/task-xyz",
    "branch name must follow the forge/<runId>/<taskId> convention"
  );
  assert.equal(
    worktreeBranchName(RUN_ID, TASK_ID),
    `forge/${RUN_ID}/${TASK_ID}`,
    "branch name must incorporate the supplied IDs verbatim"
  );
});

// ─── (FG-345) isWorktreeModeEnabled resolution table ─────────────────────────
//
// Isolation is default-ON as of the FG-345 operator decision, and the default is
// PLATFORM-AWARE: darwin on, everything else off. It has to be, because
// preflightWorktreeGate's Linux hard-fail is permanent — a bare `true` would arm
// worktree mode on a Linux host and then throw on every dispatch.
//
// Every case below pins process.platform explicitly. That is the point: this
// table is the one piece of production logic whose answer depends on the host,
// so a test of it that reads the real host proves nothing on one of the two.

test("fg351 (FG-345): the platform default is ON for darwin and OFF elsewhere", () => {
  // Neither switch set (beforeEach clears both) — this is rule 3.
  for (const [platform, expected] of [
    ["darwin", true],
    ["linux", false],
    ["win32", false],
  ] as const) {
    setPlatform(platform);
    assert.equal(
      isWorktreeModeEnabled(),
      expected,
      `with neither switch set, ${platform} must resolve worktree mode ${expected ? "ON" : "OFF"}`
    );
  }
});

test("fg351 (FG-345): FORGE_WORKTREES=1 forces mode ON regardless of platform", () => {
  process.env.FORGE_WORKTREES = "1";
  for (const platform of ["darwin", "linux", "win32"] as const) {
    setPlatform(platform);
    assert.equal(
      isWorktreeModeEnabled(),
      true,
      `explicit FORGE_WORKTREES=1 must force-enable on ${platform} (the Linux GATE, not this gate, is what refuses)`
    );
  }
});

test("fg351 (FG-345): an explicit-off FORGE_WORKTREES beats the platform default", () => {
  // The explicit-off spelling is what src/test-setup.ts pins the suite to, so a
  // test's own FORGE_WORKTREES="1" still wins by overwriting the same variable.
  setPlatform("darwin");
  for (const value of ["0", "false", ""]) {
    process.env.FORGE_WORKTREES = value;
    assert.equal(
      isWorktreeModeEnabled(),
      false,
      `FORGE_WORKTREES=${JSON.stringify(value)} must disable mode even on darwin, where the default is ON`
    );
  }
});

test("fg351 (FG-345): FORGE_NO_WORKTREES=1 outranks everything, including the darwin default", () => {
  setPlatform("darwin");
  process.env.FORGE_NO_WORKTREES = "1";
  assert.equal(isWorktreeModeEnabled(), false, "the kill switch must beat the platform default");

  process.env.FORGE_WORKTREES = "1";
  assert.equal(
    isWorktreeModeEnabled(),
    false,
    "FORGE_NO_WORKTREES=1 is a kill switch — disables mode regardless of FORGE_WORKTREES"
  );
});

test("fg351 (FG-345): task worktreePath is undefined when mode is disabled (bind-mount path)", () => {
  // runNext.ts skips setTaskWorktreePath entirely when mode is disabled.
  // This proves the DB path is clean: tasks created without worktree mode
  // have worktreePath undefined, preserving the pre-FG-351 bind-mount behavior.
  process.env.FORGE_WORKTREES = "0";
  assert.equal(isWorktreeModeEnabled(), false);
  insertTask(makeTask());
  const task = getTask(TASK_ID);
  assert.ok(task, "task must exist after insert");
  assert.equal(
    task!.worktreePath,
    undefined,
    "worktreePath must be undefined — worktree mode is off, existing bind-mount behavior preserved"
  );
});

// ─── (b) Linux gate ───────────────────────────────────────────────────────────

test("fg351 (b): preflightWorktreeGate throws on Linux without FORGE_NO_WORKTREES", () => {
  setPlatform("linux");

  const dir = makeTmpDir();
  mkdirSync(join(dir, ".git")); // looks like a git repo

  assert.throws(
    () => preflightWorktreeGate(dir),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        (err as Error).message,
        /not supported on Linux/i,
        "error must mention Linux unsupported"
      );
      return true;
    },
    "preflightWorktreeGate must throw on Linux without bypass flag"
  );
});

test("fg351 (b): FORGE_NO_WORKTREES=1 is a kill switch — disables mode via isWorktreeModeEnabled, not gate bypass", () => {
  // FORGE_NO_WORKTREES=1 must make isWorktreeModeEnabled() return false so
  // callers never reach preflightWorktreeGate. The gate itself is unconditional
  // and still throws on Linux — confirming it is NOT weakened by the kill switch.
  setPlatform("linux");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_NO_WORKTREES = "1";

  assert.equal(
    isWorktreeModeEnabled(),
    false,
    "FORGE_NO_WORKTREES=1 must disable worktree mode (kill switch at isWorktreeModeEnabled level)"
  );

  // preflightWorktreeGate itself still throws on Linux — the kill switch works
  // because callers check isWorktreeModeEnabled() first and never call this.
  const dir = makeTmpDir();
  mkdirSync(join(dir, ".git"));
  assert.throws(
    () => preflightWorktreeGate(dir),
    /not supported on Linux/i,
    "preflightWorktreeGate is unconditional — FORGE_NO_WORKTREES does not bypass it"
  );
});

// ─── (c) Non-git gate ─────────────────────────────────────────────────────────

test("fg351 (c): preflightWorktreeGate throws for a non-git dir (platform=darwin)", () => {
  setPlatform("darwin");

  const dir = makeTmpDir(); // plain temp dir, no .git

  assert.throws(
    () => preflightWorktreeGate(dir),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        (err as Error).message,
        /git repository/i,
        "error must mention git repository requirement"
      );
      return true;
    },
    "preflightWorktreeGate must throw when no .git ancestor is found"
  );
});

test("fg351 (c): FORGE_NO_WORKTREES=1 disables mode at isWorktreeModeEnabled level — non-git gate still unconditional", () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_NO_WORKTREES = "1";

  assert.equal(
    isWorktreeModeEnabled(),
    false,
    "FORGE_NO_WORKTREES=1 must disable mode on darwin too"
  );

  // The non-git gate in preflightWorktreeGate is also unconditional.
  // Well-written callers (runNext.ts) check isWorktreeModeEnabled() first
  // and skip preflightWorktreeGate entirely when it returns false.
  const dir = makeTmpDir();
  assert.throws(
    () => preflightWorktreeGate(dir),
    /git repository/i,
    "preflightWorktreeGate non-git gate is unconditional — not bypassed by FORGE_NO_WORKTREES"
  );
});

// ─── (d) Dirty-state gate ─────────────────────────────────────────────────────

test("fg351 (d): preflightWorktreeGate throws on dirty tracked tree (platform=darwin)", () => {
  setPlatform("darwin");

  const repo = makeTmpDir();
  initGitRepo(repo, { dirty: true });

  assert.throws(
    () => preflightWorktreeGate(repo),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        (err as Error).message,
        /clean tracked tree/i,
        "error must mention clean tracked tree requirement"
      );
      return true;
    },
    "preflightWorktreeGate must throw when the tracked tree has uncommitted changes"
  );
});

test("fg351 (d): FORGE_WORKTREE_IGNORE_DIRTY=1 bypasses dirty-state gate", () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo, { dirty: true });

  assert.doesNotThrow(
    () => preflightWorktreeGate(repo),
    "FORGE_WORKTREE_IGNORE_DIRTY=1 must bypass the dirty-state check"
  );
});

// ─── (a) macOS happy path ─────────────────────────────────────────────────────

test("fg351 (a): gate passes + worktree created under WORKTREES_DIR on darwin", () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1"; // skip dirty check; repo is fresh

  const repo = makeTmpDir();
  initGitRepo(repo);

  // preflightWorktreeGate must not throw
  assert.doesNotThrow(
    () => preflightWorktreeGate(repo),
    "preflightWorktreeGate must pass for a clean git repo on darwin"
  );

  const taskId = "task-fg351-happy";
  const runId = "run-fg351-happy";

  const { worktreePath, untrackedFiles } = createWorktree(repo, runId, taskId);

  // Worktree path must be under WORKTREES_DIR/<runId>/<taskId>.
  const expectedPath = worktreeDir(runId, taskId);
  assert.equal(
    worktreePath,
    expectedPath,
    "worktreePath must equal worktreeDir(runId, taskId)"
  );
  assert.ok(
    worktreePath.startsWith(WORKTREES_DIR),
    "worktreePath must be under WORKTREES_DIR (inside FORGE_HOME)"
  );

  // The worktree directory must exist on disk.
  assert.ok(
    existsSync(worktreePath),
    "git worktree add must have created the worktree directory"
  );

  // The worktree must have content from the repo (e.g. README.md).
  assert.ok(
    existsSync(join(worktreePath, "README.md")),
    "worktree must contain tracked files from the source repo"
  );

  // untrackedFiles is a best-effort diagnostic list (may be empty for a clean repo).
  assert.ok(
    Array.isArray(untrackedFiles),
    "createWorktree must return untrackedFiles as an array"
  );

  // Verify the branch was created with the correct naming convention.
  const branchOut = execFileSync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: repo, encoding: "utf8" }
  );
  const expectedBranch = worktreeBranchName(runId, taskId);
  assert.ok(
    branchOut.includes(expectedBranch),
    `git worktree list must include branch ${expectedBranch}`
  );

  // Clean up: remove the worktree and branch so the temp dir cleanup doesn't
  // leave dangling git metadata. Best-effort.
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync("git", ["branch", "-D", expectedBranch], {
      cwd: repo,
      stdio: "ignore",
    });
  } catch { /* best-effort */ }
});

test("fg351 (a): task row has worktreePath set via setTaskWorktreePath", () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  insertTask(makeTask());

  const { worktreePath } = createWorktree(repo, RUN_ID, TASK_ID);

  // Simulate what runNext.ts does: write the worktreePath to the DB BEFORE
  // the container starts.
  setTaskWorktreePath(TASK_ID, worktreePath);

  const task = getTask(TASK_ID);
  assert.ok(task, "task must exist after insert");
  assert.equal(
    task!.worktreePath,
    worktreePath,
    "task.worktreePath must equal the path written by setTaskWorktreePath"
  );

  // Clean up worktree.
  try {
    const branch = worktreeBranchName(RUN_ID, TASK_ID);
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync("git", ["branch", "-D", branch], {
      cwd: repo,
      stdio: "ignore",
    });
  } catch { /* best-effort */ }
});

// ─── (e) Repo-root resolution ─────────────────────────────────────────────────

test("fg351 (e): createWorktree cwd is the repo root, not a subdir", () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  // Create a subdirectory inside the repo.
  const sub = join(repo, "packages", "api");
  mkdirSync(sub, { recursive: true });

  // createWorktree must be called with the REPO ROOT (not the subdir).
  // The git worktree add call uses cwd: projectDir — if we pass the root, it works.
  const runId = "run-fg351-root";
  const taskId = "task-fg351-root";
  const { worktreePath } = createWorktree(repo, runId, taskId);

  // The worktree exists: confirms git ran with the correct cwd (the root).
  assert.ok(
    existsSync(worktreePath),
    "worktree must be created when createWorktree receives the git root as projectDir"
  );

  // The worktree path is under FORGE_HOME (not under the project or a subdir).
  assert.ok(
    worktreePath.startsWith(WORKTREES_DIR),
    "worktreePath must be under WORKTREES_DIR regardless of which subdir was the invocation cwd"
  );

  // Clean up.
  try {
    const branch = worktreeBranchName(runId, taskId);
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync("git", ["branch", "-D", branch], {
      cwd: repo,
      stdio: "ignore",
    });
  } catch { /* best-effort */ }
});

// ─── (f) Persisted task state ─────────────────────────────────────────────────

test("fg351 (f): setTaskWorktreePath then getTask returns matching worktreePath", () => {
  insertTask(makeTask());

  const fakePath = "/tmp/fake-worktree/run-123/task-456";
  setTaskWorktreePath(TASK_ID, fakePath);

  const task = getTask(TASK_ID);
  assert.ok(task, "task must exist after insert");
  assert.equal(
    task!.worktreePath,
    fakePath,
    "task.worktreePath must equal the value written by setTaskWorktreePath"
  );
});

test("fg351 (f): worktreePath survives a DB open/close cycle (applyMigrations idempotent)", () => {
  // Simulate process restart: insert → write → reopen → read back.
  insertTask(makeTask());
  const path = "/tmp/forge-worktrees/run-fg351/task-fg351-1";
  setTaskWorktreePath(TASK_ID, path);

  // Re-run migrations (simulates a DB reopen on next forge invocation).
  applyMigrations(db);

  const task = getTask(TASK_ID);
  assert.ok(task, "task must still exist after re-migration");
  assert.equal(
    task!.worktreePath,
    path,
    "worktreePath must survive applyMigrations re-run (no clobber)"
  );
});

test("fg351 (f): task inserted without worktreePath has worktreePath undefined", () => {
  insertTask(makeTask());
  const task = getTask(TASK_ID);
  assert.ok(task, "task must exist");
  assert.equal(
    task!.worktreePath,
    undefined,
    "worktreePath must be undefined for tasks that predate worktree mode"
  );
});

// ─── (g) Cleanup safety ───────────────────────────────────────────────────────

test("fg351 (g): removeWorktreeIfSafe is a no-op without FORGE_WORKTREES_EPHEMERAL", () => {
  // Create a fake directory at the worktree path to verify it is NOT removed.
  const fakePath = join(makeTmpDir(), "fake-worktree");
  mkdirSync(fakePath, { recursive: true });

  // Without FORGE_WORKTREES_EPHEMERAL, the function must return immediately.
  // projectDir is irrelevant here (function exits before git calls).
  assert.doesNotThrow(
    () => removeWorktreeIfSafe(fakePath, RUN_ID, TASK_ID, "/not-a-real-dir"),
    "removeWorktreeIfSafe must not throw without FORGE_WORKTREES_EPHEMERAL"
  );

  // The directory must still exist — no removal was attempted.
  assert.ok(
    existsSync(fakePath),
    "worktree path must remain intact when FORGE_WORKTREES_EPHEMERAL is not set (no-op)"
  );
});

test("fg351 (g): removeWorktreeIfSafe silently skips absent path even with FORGE_WORKTREES_EPHEMERAL", () => {
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";
  const absent = "/tmp/forge-fg351-nonexistent-" + RUN_ID;

  // existsSync returns false → function exits before git commands, so projectDir is unused.
  assert.doesNotThrow(
    () => removeWorktreeIfSafe(absent, RUN_ID, TASK_ID, "/some-dir"),
    "removeWorktreeIfSafe must not throw when the worktree path is absent"
  );
});

test("fg351 (g): removeWorktreeIfSafe removes a real worktree with FORGE_WORKTREES_EPHEMERAL=1", () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const runId = "run-fg351-cleanup";
  const taskId = "task-fg351-cleanup";

  // Create a real worktree of our test repo (under WORKTREES_DIR).
  const { worktreePath } = createWorktree(repo, runId, taskId);
  assert.ok(existsSync(worktreePath), "worktree must exist before cleanup");

  // Pass `repo` as projectDir — git commands run with this as cwd, never process.cwd().
  // No process.chdir() needed.
  removeWorktreeIfSafe(worktreePath, runId, taskId, repo);

  // The worktree directory must have been removed.
  assert.ok(
    !existsSync(worktreePath),
    "worktree path must be removed by removeWorktreeIfSafe when FORGE_WORKTREES_EPHEMERAL=1"
  );
});
