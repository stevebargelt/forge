// FG-376 dispatch-level integration tests: agent worktree dependency parity.
//
// Covers the END-TO-END wiring (not exercised by the module-level unit tests
// in dependency-provisioning.test.ts / spawn.test.ts) for the TWO-PHASE
// provisioning model:
//   (a) A missing marker triggers exactly one short-lived PROVISIONER
//       container (rw named volumes, FORGE_NM_INSTALL_ROOT set, a distinct
//       `forge-provision-<taskId>` name, no agent invocation) that writes the
//       marker, followed by the real agent container mounted read-only.
//   (b) A container that exits with DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE
//       (123) is classified failure_kind=verification_environment_unavailable
//       — not container_crash — ahead of runNext's generic crash handling.
//   (c) Two dispatches sharing the same lockfile: only the first provisions;
//       the second skips straight to the read-only agent mount, no lock wait
//       observable at this level (the lock cost is entirely inside the first
//       dispatch's provisioning step).
//   (d) A failed provisioner writes no marker, fails the task as
//       verification_environment_unavailable BEFORE the agent container is
//       ever spawned, and a later dispatch for the same lockfile re-provisions.
//   (e) No agent/reviewer/red container — worktree-rw primary or ro red —
//       ever mounts a shared dependency-cache volume read-write; only the
//       dedicated provisioner container does.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { failureKindForTask } from "./failure-kind.js";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE, lockfileHash } from "./dependency-provisioning.js";
import type { Workflow } from "./schema.js";

const DISPATCH_TEST_WORKFLOW: Workflow = {
  name: "fg376-dispatch-test",
  description: "FG-376 dispatch-level integration test: single step",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "fg376-dispatch-test", reds: [] },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "FORGE_NO_NM_SHADOW",
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
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg376-disp-"));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepoWithWorkspace(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", workspaces: ["dashboard"] }));
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
  mkdirSync(join(dir, "dashboard"), { recursive: true });
  writeFileSync(join(dir, "dashboard", "package.json"), JSON.stringify({ name: "dashboard" }));
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

// Two independently-created repos that share the SAME package-lock.json bytes
// have the same dependency-cache key even though they're different
// worktrees/runs — that's the whole point of keying by lockfile hash instead
// of run/task id.
function makeRepoWithLockContent(lockContent: string): string {
  const dir = makeTmpDir();
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "package-lock.json"), lockContent);
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

// Dispatch test with a non-blocking red so the primary (rw, provisioner+agent)
// and the red (ro, reviewer) both dispatch in one runNext() wave.
const DISPATCH_TEST_WORKFLOW_WITH_RED: Workflow = {
  name: "fg376-dispatch-test-red",
  description: "FG-376 dispatch-level integration test: single step with a red",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg376-dispatch-test",
      reds: [{ agent: "red-narrow", authority: "specialist", gate_on_verdict: false }],
    },
  ],
};

function ensureDispatchTestRuntime(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", "fg376-dispatch-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg376-dispatch-test
description: FG-376 dispatch test runtime stub
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
}

// The provisioner is a DISTINCT, identifiable container: buildProvisionerDockerArgs
// names it `forge-provision-<taskId>`, never the agent's `forge-<taskId>` name,
// and it never carries the runtime's own invocation command ("echo stub" here).
function isProvisionerCall(args: string[]): boolean {
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  return typeof name === "string" && name.startsWith("forge-provision-");
}

type Call = { args: string[]; kind: "provisioner" | "agent" };

// Records EVERY dockerExec call (provisioner and agent alike — both go
// through the same injected DockerExecFn) into `calls`. Provisioner calls
// write nothing to TASK_DIR (the real provisioner has no /task mount and
// never produces a result.json) and exit 0. Agent calls write a result.json
// and exit 0, exactly like a real successful agent run.
function makeTwoPhaseExec(calls: Call[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const kind = isProvisionerCall(args) ? "provisioner" : "agent";
    calls.push({ args: [...args], kind });
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, kind === "provisioner" ? "" : "stub stdout");
    writeFileSync(stderrPath, "");
    if (kind === "agent") {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    }
    return 0;
  };
}

// Every provisioner call fails with the install-failure sentinel; the agent
// must never be reached (provisioning fails before the agent container is
// ever built), so a non-provisioner call here is a test bug, not a real path.
function makeProvisionerFailingExec(stderrText: string, calls: Call[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const kind = isProvisionerCall(args) ? "provisioner" : "agent";
    calls.push({ args: [...args], kind });
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, stderrText);
    return DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE;
  };
}

function makeProvisioningFailedExec(stderrText: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, stderrText);
    // No result.json — the entrypoint never reached exec.
    return DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE;
  };
}

// FIX4-style test with a red: records every container's argv (primary AND
// red) instead of just the last one, and writes a result.json shaped to
// satisfy both a primary result ({status}) and a red verdict
// ({verdict, confidence, findings}). Provisioner calls write nothing.
function makeMultiCapturingExec(calls: Call[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const kind = isProvisionerCall(args) ? "provisioner" : "agent";
    calls.push({ args: [...args], kind });
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, kind === "provisioner" ? "" : "stub stdout");
    writeFileSync(stderrPath, "");
    if (kind === "agent") {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", verdict: "pass", confidence: 0.9, findings: [] }));
    }
    return 0;
  };
}

function pickEnvValues(args: string[], key: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e" && args[i + 1]!.startsWith(`${key}=`)) out.push(args[i + 1]!.slice(key.length + 1));
  }
  return out;
}

function pickVolumeArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-v") out.push(args[i + 1]!);
  }
  return out;
}

test("fg376 (a): darwin + worktree mode + workspaces repo → one provisioner container (rw) writes the marker, then the agent container starts read-only", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepoWithWorkspace(repo);

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg376 two-phase provisioning test",
    inputs: {},
    projectDir: repo,
  });

  const calls: Call[] = [];
  const wave = await runNext({ runId, workflow: DISPATCH_TEST_WORKFLOW, dockerExec: makeTwoPhaseExec(calls) });

  assert.deepEqual(wave.completedSteps, ["build"]);
  assert.equal(calls.length, 2, `expected exactly one provisioner call + one agent call, got ${calls.length}: ${JSON.stringify(calls.map((c) => c.kind))}`);
  assert.deepEqual(calls.map((c) => c.kind), ["provisioner", "agent"], "provisioner must run to completion BEFORE the agent container is built");

  const provisionerArgs = calls[0]!.args;
  const agentArgs = calls[1]!.args;

  // Provisioner: named volumes mounted READ-WRITE, install root set, no agent invocation.
  const provisionerVolumes = pickVolumeArgs(provisionerArgs).filter((v) => v.includes("node_modules"));
  assert.equal(provisionerVolumes.length, 2, `expected 2 rw node_modules volumes on the provisioner, got: ${JSON.stringify(provisionerVolumes)}`);
  assert.ok(provisionerVolumes.every((v) => !v.endsWith(":ro")), `the provisioner is the ONLY container allowed to mount these read-write, got: ${JSON.stringify(provisionerVolumes)}`);
  assert.deepEqual(pickEnvValues(provisionerArgs, "FORGE_NM_INSTALL_ROOT"), ["/project"]);
  assert.ok(!provisionerArgs.includes("stub"), "the provisioner must never carry the agent's own invocation args");

  // Agent: SAME named volumes mounted READ-ONLY, no install root at all.
  const agentVolumes = pickVolumeArgs(agentArgs).filter((v) => v.includes("node_modules"));
  assert.equal(agentVolumes.length, 2, `expected 2 ro node_modules volumes on the agent, got: ${JSON.stringify(agentVolumes)}`);
  assert.ok(agentVolumes.every((v) => v.endsWith(":ro")), `the agent must never mount the shared cache read-write, got: ${JSON.stringify(agentVolumes)}`);
  assert.deepEqual(pickEnvValues(agentArgs, "FORGE_NM_INSTALL_ROOT"), [], "the agent container must never install");

  const lockHashes = pickEnvValues(agentArgs, "FORGE_NM_LOCKFILE_HASH");
  assert.equal(lockHashes.length, 1);
  assert.equal(lockHashes[0], lockfileHash(repo), "emitted hash must match the repo's actual lockfile hash");
});

test("fg376 (b): container exit 123 → task fails with failure_kind=verification_environment_unavailable, not container_crash", async () => {
  const projectDir = "/tmp/test-project";
  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg376 provisioning-failure classification test",
    inputs: {},
    projectDir,
  });

  const wave = await runNext({
    runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: makeProvisioningFailedExec("npm ci failed: EACCES"),
  });

  assert.deepEqual(wave.failedSteps, ["build"]);

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary);
  const task = getTask(primary!.id);
  assert.equal(task!.status, "failed");
  assert.equal(
    failureKindForTask(primary!.id),
    "verification_environment_unavailable",
    "exit code 123 must classify as verification_environment_unavailable, not container_crash"
  );
  assert.match(task!.error ?? "", /verification_environment_unavailable/);
  assert.match(task!.error ?? "", /npm ci failed: EACCES/, "captured stderr must be surfaced in the failure message");
});

test("fg376 FIX1: darwin + non-worktree mode (FORGE_WORKTREES unset) → legacy anonymous shadow volume only, one container call, no provisioner", async () => {
  setPlatform("darwin");
  // FORGE_WORKTREES intentionally left unset — beforeEach already deletes it.

  const repo = makeTmpDir();
  initGitRepoWithWorkspace(repo);

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW,
    title: "fg376 FIX1 non-worktree dispatch test",
    inputs: {},
    projectDir: repo,
  });

  const calls: Call[] = [];
  const wave = await runNext({ runId, workflow: DISPATCH_TEST_WORKFLOW, dockerExec: makeTwoPhaseExec(calls) });

  assert.deepEqual(wave.completedSteps, ["build"]);
  assert.equal(calls.length, 1, "no lockfile-keyed cache in play → no provisioner call, just the agent");
  assert.equal(calls[0]!.kind, "agent");

  const volumeArgs = pickVolumeArgs(calls[0]!.args);
  assert.ok(volumeArgs.includes("/project/node_modules"), "non-worktree rw dispatch must still shadow via the legacy anonymous volume");
  assert.equal(volumeArgs.filter((v) => v.includes("forge-deps-")).length, 0, "non-worktree dispatch must mount no named dependency-cache volumes");

  assert.deepEqual(pickEnvValues(calls[0]!.args, "FORGE_NM_INSTALL_ROOT"), [], "non-worktree dispatch must never emit FORGE_NM_INSTALL_ROOT");
  assert.deepEqual(pickEnvValues(calls[0]!.args, "FORGE_NM_SHADOW_PATHS"), [], "non-worktree dispatch must never emit FORGE_NM_SHADOW_PATHS");
  assert.deepEqual(pickEnvValues(calls[0]!.args, "FORGE_NM_LOCKFILE_HASH"), [], "non-worktree dispatch must never emit FORGE_NM_LOCKFILE_HASH");
  assert.deepEqual(pickEnvValues(calls[0]!.args, "FORGE_NM_SHADOW"), ["/project/node_modules"], "legacy FORGE_NM_SHADOW is still emitted — byte-for-byte pre-FG-376 behavior");
});

test("fg376 (c): two worktree-mode dispatches sharing the same lockfile — only the first provisions, the second skips straight to the read-only agent mount", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const lockContent = '{"lockfileVersion":3,"fix2-serialize":true}';
  const repo1 = makeRepoWithLockContent(lockContent);
  const repo2 = makeRepoWithLockContent(lockContent);
  assert.equal(lockfileHash(repo1), lockfileHash(repo2), "test setup: both repos must share the same cache key");

  const run1 = startRun({ workflow: DISPATCH_TEST_WORKFLOW, title: "fix2 serialize dispatch 1", inputs: {}, projectDir: repo1 });
  const calls1: Call[] = [];
  const wave1 = await runNext({ runId: run1.runId, workflow: DISPATCH_TEST_WORKFLOW, dockerExec: makeTwoPhaseExec(calls1) });
  assert.deepEqual(wave1.completedSteps, ["build"]);
  assert.deepEqual(calls1.map((c) => c.kind), ["provisioner", "agent"], "first dispatch is the sole provisioner");

  const run2 = startRun({ workflow: DISPATCH_TEST_WORKFLOW, title: "fix2 serialize dispatch 2", inputs: {}, projectDir: repo2 });
  const calls2: Call[] = [];
  const wave2 = await runNext({ runId: run2.runId, workflow: DISPATCH_TEST_WORKFLOW, dockerExec: makeTwoPhaseExec(calls2) });
  assert.deepEqual(wave2.completedSteps, ["build"]);
  assert.deepEqual(calls2.map((c) => c.kind), ["agent"], "second dispatch reuses the ready marker — no provisioner, straight to the agent");
  const agentVolumes = pickVolumeArgs(calls2[0]!.args).filter((v) => v.includes("forge-deps-"));
  assert.ok(agentVolumes.length > 0 && agentVolumes.every((v) => v.endsWith(":ro")), "second dispatch mounts the (shared) named volume read-only for reuse");
});

test("fg376 (d): a failed provisioner (exit 123) leaves no ready marker, fails the task BEFORE any agent container is spawned, and the next dispatch for the same lockfile re-provisions", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const lockContent = '{"lockfileVersion":3,"fix2-failure":true}';
  const repo1 = makeRepoWithLockContent(lockContent);
  const run1 = startRun({ workflow: DISPATCH_TEST_WORKFLOW, title: "fix2 failure dispatch 1", inputs: {}, projectDir: repo1 });
  const calls1: Call[] = [];
  const wave1 = await runNext({
    runId: run1.runId,
    workflow: DISPATCH_TEST_WORKFLOW,
    dockerExec: makeProvisionerFailingExec("npm ci failed: disk full", calls1),
  });
  assert.deepEqual(wave1.failedSteps, ["build"]);
  assert.equal(calls1.length, 1, "the agent container must NEVER be spawned when provisioning fails");
  assert.equal(calls1[0]!.kind, "provisioner");
  assert.equal(
    failureKindForTask(tasksForRun(run1.runId).find((t) => t.phase === "build" && t.parentId === undefined)!.id),
    "verification_environment_unavailable",
  );

  const repo2 = makeRepoWithLockContent(lockContent);
  const run2 = startRun({ workflow: DISPATCH_TEST_WORKFLOW, title: "fix2 failure dispatch 2", inputs: {}, projectDir: repo2 });
  const calls2: Call[] = [];
  const wave2 = await runNext({ runId: run2.runId, workflow: DISPATCH_TEST_WORKFLOW, dockerExec: makeTwoPhaseExec(calls2) });
  assert.deepEqual(wave2.completedSteps, ["build"]);
  assert.deepEqual(
    calls2.map((c) => c.kind),
    ["provisioner", "agent"],
    "no marker was left by the failed attempt, so this dispatch must re-provision, not reuse",
  );
});

test("fg376 (e)/FIX4: a read-only red reviewing a task with a populated cache key mounts the SAME dependency volume(s) read-only, and never installs — and NO dispatch in the wave ever mounts the shared volume read-write except the one provisioner", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  // initGitRepoWithWorkspace's lockfile content is fixed, and test (a) above
  // already provisions+marks that exact cache key ready earlier in this same
  // process (shared FORGE_HOME) — use a distinct lockfile so this test gets
  // its own, unpopulated cache key and genuinely exercises the provision step.
  const repo = makeTmpDir();
  initGitRepoWithWorkspace(repo);
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3,"fix4-reviewer-reuse":true}');
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fix4: unique lockfile"], { cwd: repo, stdio: "ignore" });

  const { runId } = startRun({
    workflow: DISPATCH_TEST_WORKFLOW_WITH_RED,
    title: "fix4 reviewer reuse test",
    inputs: {},
    projectDir: repo,
  });

  const calls: Call[] = [];
  const wave = await runNext({ runId, workflow: DISPATCH_TEST_WORKFLOW_WITH_RED, dockerExec: makeMultiCapturingExec(calls) });

  assert.deepEqual(wave.completedSteps, ["build"]);
  assert.equal(calls.length, 3, `expected provisioner + primary agent + 1 red container dispatch, got ${calls.length}: ${JSON.stringify(calls.map((c) => c.kind))}`);
  assert.equal(calls.filter((c) => c.kind === "provisioner").length, 1, "exactly one provisioner call across the whole wave");

  const provisionerCall = calls.find((c) => c.kind === "provisioner");
  assert.ok(provisionerCall, "the primary must provision (rw) before either agent container runs");

  const agentCalls = calls.filter((c) => c.kind === "agent");
  assert.equal(agentCalls.length, 2, "primary agent + red agent");
  for (const call of agentCalls) {
    assert.deepEqual(pickEnvValues(call.args, "FORGE_NM_INSTALL_ROOT"), [], "no agent/reviewer container ever installs");
    const nmVolumes = pickVolumeArgs(call.args).filter((v) => v.includes("forge-deps-"));
    assert.ok(nmVolumes.length > 0, "expected the shared lockfile-keyed dependency-cache volume(s) to be mounted");
    assert.ok(nmVolumes.every((v) => v.endsWith(":ro")), `NO agent/reviewer dispatch may ever mount the shared volume read-write, got: ${JSON.stringify(nmVolumes)}`);
  }
});
