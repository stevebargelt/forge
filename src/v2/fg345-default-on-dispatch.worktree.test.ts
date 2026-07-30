// FG-345 — isolation is DEFAULT-ON, proven at the DISPATCH seam.
//
// The resolution table in fg351-worktree-lifecycle.worktree.test.ts proves the
// PREDICATE. It cannot prove that a real dispatch behaves differently, and the
// predicate is not what shipped — the behavior change is. Every test here drives
// the real runNext over a real git repo with a stub docker exec standing in for
// the agent container, and asserts what the container was actually handed.
//
// Covers:
//   (default-on)  NO worktree switch set + darwin → the isolated path: a private
//       workspace is created, tasks.worktree_path + base_sha are recorded, and
//       /project is mounted from the workspace. Before FG-345 this same env
//       bind-mounted the operator's checkout.
//   (escape-1)    FORGE_NO_WORKTREES=1 on darwin → the legacy bind-mount dispatch:
//       no workspace on disk, no worktree_path, /project is run.projectDir. This
//       is the operator's documented way out and nothing proved it at dispatch.
//   (escape-2)    The kill switch still outranks an explicit FORGE_WORKTREES=1 at
//       the dispatch level, not just in the predicate.
//   (non-darwin)  NO switch set + a non-darwin host → bind-mount dispatch that
//       COMPLETES. It must not throw: preflightWorktreeGate hard-fails on Linux
//       permanently, so a bare `return true` default would have failed every
//       dispatch on every Linux host. That is the regression this file pins.
//   (invoke-scope) The default-on claim is scoped to WORKFLOW dispatch. `forge
//       invoke` provisions no workspace, so the same darwin/no-switch env that
//       isolates the case above hands an invoke-dispatched agent — including
//       review-loop's reviewer and fixer — the live checkout. Pinned so the docs
//       claim stays checkable and so extending isolation to that surface has to
//       update the contract deliberately.
//
// The env is read as the PRODUCTION default, so beforeEach deletes both switches
// (undoing src/test-setup.ts's suite pin) rather than pinning them — a test of a
// default that sets the thing being defaulted proves nothing.
//
// process.platform is spoofed the way FG-376/FG-425 do it, and restored from
// REAL_PLATFORM captured at module load — NEVER from process.platform inside
// afterEach, which by then reads the spoof and leaks it into every later test.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { CLONES_DIR, WORKTREES_DIR } from "../util/paths.js";
import { startRun } from "./startRun.js";
import { invoke } from "./invoke.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const RUNTIME = "fg345-default-on-test";

// ─── Workflow fixture ─────────────────────────────────────────────────────────
//
// One mutating step, no reds, auto gate — the smallest shape that walks the whole
// dispatchSingleStep → runContainer path.

const SINGLE: Workflow = {
  name: "fg345-default-on",
  description: "FG-345 default-on: one mutating step",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] },
  ],
};

// ─── Harness ──────────────────────────────────────────────────────────────────

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

/** Captured before any test can spoof it. */
const REAL_PLATFORM = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);

  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  ensureRuntime();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();

  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }

  setPlatform(REAL_PLATFORM);

  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg345-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A clean committed repo — the state the workspace contract is defined over. */
function makeRepo(): string {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg345 default-on\n");
  writeFileSync(join(dir, "tracked.ts"), "export const version = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function headSha(repo: string): string {
  return git(repo, "rev-parse", "HEAD^{commit}").trim();
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-345 default-on test runtime stub
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

/** The host path docker was told to mount at /project. */
function projectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

type Observed = {
  called: boolean;
  args: string[];
  /** What /project actually WAS at container-start time — sampled inside the exec
   *  stub, because a workspace the reaper later disposes of still has to have
   *  existed when the agent ran. Post-run existence is a different question. */
  mount?: string;
  mountExisted?: boolean;
  mountIsGitRepo?: boolean;
  mountHasCommittedContent?: boolean;
};

/** Stub exec that samples the mounted workspace, then writes a success result. */
function makeObservingExec(seen: Observed): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    seen.called = true;
    seen.args = [...args];
    const mount = projectMountHost(args);
    seen.mount = mount;
    seen.mountExisted = mount !== undefined && existsSync(mount);
    seen.mountIsGitRepo = mount !== undefined && existsSync(join(mount, ".git"));
    seen.mountHasCommittedContent = mount !== undefined && existsSync(join(mount, "tracked.ts"));

    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

async function dispatch(repo: string, title: string): Promise<{ runId: string; wave: Awaited<ReturnType<typeof runNext>>; seen: Observed }> {
  const { runId } = startRun({ workflow: SINGLE, title, inputs: {}, projectDir: repo });
  const seen: Observed = { called: false, args: [] };
  const wave = await runNext({ runId, workflow: SINGLE, dockerExec: makeObservingExec(seen) });
  return { runId, wave, seen };
}

function primaryTask(runId: string) {
  const primary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "primary build task must exist");
  return primary!;
}

// ─── (default-on) The default actually takes effect, end to end ───────────────

test("fg345 (default-on): NO worktree switch set on darwin → dispatch takes the ISOLATED path", async () => {
  // Neither switch is set (beforeEach deleted both, including test-setup's pin).
  // This is the production default as an operator meets it after FG-345.
  setPlatform("darwin");
  assert.equal(process.env.FORGE_WORKTREES, undefined, "the default must be exercised, not configured");
  assert.equal(process.env.FORGE_NO_WORKTREES, undefined, "the default must be exercised, not configured");

  const repo = makeRepo();
  const base = headSha(repo);

  const { runId, wave, seen } = await dispatch(repo, "fg345 default-on isolated dispatch");

  assert.deepEqual(wave.completedSteps, ["build"], "the default path must dispatch and complete");
  assert.deepEqual(wave.failedSteps, [], "the default path must not fail");
  assert.ok(seen.called, "docker exec must have been called");

  // The workspace was RECORDED — this is the row reconcile and the reaper key on.
  const primary = primaryTask(runId);
  assert.ok(
    primary.worktreePath,
    "tasks.worktree_path must be recorded on the default path — before FG-345 this dispatch bind-mounted and left it NULL"
  );
  assert.ok(
    primary.worktreePath!.startsWith(CLONES_DIR),
    `the recorded workspace must live under the managed clones root, got: ${primary.worktreePath}`
  );
  assert.equal(
    primary.worktreePath,
    join(CLONES_DIR, runId, primary.id),
    "the workspace path must be the deterministic per-(run, task) path"
  );
  assert.equal(primary.baseSha, base, "the recorded base SHA must be the repo HEAD the workspace was cut from");

  // The workspace EXISTED, was a real repository, and carried committed content
  // at the moment the container was started.
  assert.equal(seen.mount, primary.worktreePath, "/project must be mounted from the task workspace, not the checkout");
  assert.notEqual(seen.mount, repo, "the operator's checkout must NOT be what the agent got");
  assert.equal(seen.mountExisted, true, "the workspace directory must exist when the container starts");
  assert.equal(seen.mountIsGitRepo, true, "the workspace must be a real git repository");
  assert.equal(
    seen.mountHasCommittedContent,
    true,
    "the workspace must carry the committed tracked content at the base SHA (the FG-345 workspace contract)"
  );
});

// ─── (escape-1) The escape hatch works, end to end ────────────────────────────

test("fg345 (escape-1): FORGE_NO_WORKTREES=1 on darwin → legacy BIND-MOUNT dispatch, no workspace at all", async () => {
  setPlatform("darwin"); // where the default would otherwise resolve ON
  process.env.FORGE_NO_WORKTREES = "1";

  const repo = makeRepo();
  const { runId, wave, seen } = await dispatch(repo, "fg345 escape hatch bind-mount dispatch");

  assert.deepEqual(wave.completedSteps, ["build"], "the escape hatch must still dispatch and complete");
  assert.deepEqual(wave.failedSteps, [], "the escape hatch must not fail");
  assert.ok(seen.called, "docker exec must have been called");

  const primary = primaryTask(runId);
  assert.equal(
    primary.worktreePath,
    undefined,
    "no workspace path may be recorded under the kill switch — the DB row must look exactly as it did pre-isolation"
  );
  assert.equal(primary.baseSha, undefined, "no base SHA may be recorded under the kill switch");

  assert.equal(seen.mount, repo, "/project must be the operator's checkout, bind-mounted as before");
  assert.ok(
    !seen.mount!.startsWith(WORKTREES_DIR),
    "the container must not be handed any forge-managed workspace path"
  );
  assert.equal(
    existsSync(join(CLONES_DIR, runId)),
    false,
    "no workspace may be created on disk under the kill switch"
  );
});

test("fg345 (escape-2): FORGE_NO_WORKTREES=1 outranks an explicit FORGE_WORKTREES=1 at the DISPATCH level", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_NO_WORKTREES = "1";

  const repo = makeRepo();
  const { runId, wave, seen } = await dispatch(repo, "fg345 kill switch beats explicit opt-in");

  assert.deepEqual(wave.completedSteps, ["build"], "the kill switch must produce a normal bind-mount dispatch");
  assert.equal(seen.mount, repo, "/project must be the checkout even with FORGE_WORKTREES=1 also set");
  assert.equal(
    primaryTask(runId).worktreePath,
    undefined,
    "the kill switch must win over an explicit opt-in at dispatch, not only in the predicate"
  );
  assert.equal(existsSync(join(CLONES_DIR, runId)), false, "no workspace may be created");
});

// ─── (non-darwin) A Linux host keeps working ──────────────────────────────────

test("fg345 (non-darwin): NO switch set on a non-darwin host → bind-mount dispatch that COMPLETES, never throws", async () => {
  // The regression a bare `return true` default would have caused: worktree mode
  // armed on a Linux host, preflightWorktreeGate's permanent hard-fail firing on
  // every dispatch. The platform-aware default is what keeps this green.
  setPlatform("linux");
  assert.equal(process.env.FORGE_WORKTREES, undefined, "the default must be exercised, not configured");
  assert.equal(process.env.FORGE_NO_WORKTREES, undefined, "the default must be exercised, not configured");

  const repo = makeRepo();
  const { runId, wave, seen } = await dispatch(repo, "fg345 non-darwin default dispatch");

  assert.deepEqual(
    wave.failedSteps,
    [],
    "a non-darwin host must not fail dispatch — the Linux worktree gate must never be reached by default"
  );
  assert.deepEqual(wave.completedSteps, ["build"], "a non-darwin host must dispatch and complete as it did before FG-345");
  assert.ok(seen.called, "docker exec must have been called — the container must actually run on a non-darwin host");

  const primary = primaryTask(runId);
  assert.equal(primary.status, "complete", "the task must complete, not fail with a worktree setup error");
  assert.ok(
    !JSON.stringify(primary.result ?? {}).includes("worktree setup failed"),
    `no worktree setup error may be recorded on the default non-darwin path, got: ${JSON.stringify(primary.result)}`
  );
  assert.equal(primary.worktreePath, undefined, "no workspace path may be recorded on a non-darwin host by default");
  assert.equal(seen.mount, repo, "/project must be the operator's checkout on a non-darwin host");
  assert.equal(existsSync(join(CLONES_DIR, runId)), false, "no workspace may be created on a non-darwin host by default");
});

// A win32 host takes the same off-by-default branch; the predicate table covers
// the third platform value, and there is no separate dispatch path to prove.

// ─── (invoke-scope) Default-on is a WORKFLOW-dispatch property ────────────────

test("fg345 (invoke-scope): darwin + NO switch set → `forge invoke` still mounts the live checkout and records no workspace", async () => {
  // Same env as the (default-on) case above, which isolates. invoke.ts has no
  // workspace lifecycle: it has no candidate/publication step to merge one back
  // through, and review-loop reads its fixer's output from the directory mounted
  // here. If isolation ever reaches this surface, this test SHOULD fail — update
  // it together with docs/concepts.md → Workspace isolation → Which dispatches
  // provision one.
  setPlatform("darwin");
  assert.equal(process.env.FORGE_WORKTREES, undefined, "the default must be exercised, not configured");
  assert.equal(process.env.FORGE_NO_WORKTREES, undefined, "the default must be exercised, not configured");

  const repo = makeRepo();
  const seen: Observed = { called: false, args: [] };

  const r = await invoke({
    agentRole: "engineer",
    task: "fg345 invoke-scope",
    projectDir: repo,
    runtimeName: RUNTIME,
    dockerExec: makeObservingExec(seen),
  });

  assert.equal(r.status, "complete", `invoke must dispatch and complete: ${r.error ?? ""}`);
  assert.ok(seen.called, "docker exec must have been called");
  assert.equal(seen.mount, repo, "/project must be the operator's checkout — invoke provisions no workspace");
  assert.equal(
    getTask(r.taskId)?.worktreePath,
    undefined,
    "an invoke-dispatched task must record no worktree_path (docs/SCHEMA-CONTRACT.md)"
  );
  assert.equal(getTask(r.taskId)?.baseSha, undefined, "an invoke-dispatched task must record no base_sha");
  assert.equal(existsSync(join(CLONES_DIR, r.runId)), false, "no private clone may be created for an invoke dispatch");
  assert.equal(existsSync(join(WORKTREES_DIR, r.runId)), false, "no linked worktree may be created for an invoke dispatch");
});
