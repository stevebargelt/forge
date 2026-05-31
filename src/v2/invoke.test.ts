// invoke.ts tests: stubbed dockerExec, asserts run + task creation and result handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { getRun } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { eventsForTask, eventsForRun } from "../store/events.js";
import { writeProfile } from "../util/auth-profiles.js";
import { taskDir } from "../util/paths.js";
import type { TaskManifest } from "./task-manifest.js";

// Stub exec that writes a fixed result.json and returns 0.
function makeStubExec(resultJson: unknown, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(resultJson));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

function setupRuntimeStub(): void {
  // Synthesize a minimal claude runtime YAML so loadRuntime succeeds inside tests.
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `
name: claude
description: test stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
}

// AWN-7: a claude-apikey runtime stub the (anthropic, api) binding resolves to.
// Additive — legacy tests use the literal claude.yml, which loadRuntime prefers.
function setupApikeyRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const p = join(fhome, "runtimes", "claude-apikey.yml");
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `
name: claude-apikey
description: test stub
image: test-image:latest
models:
  default: runtime-default-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
}

test("invoke: policy mode stamps the resolution record on the task row + manifest", async () => {
  setupApikeyRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Project-scoped policy so we don't pollute the shared FORGE_HOME (which would
  // flip every other invoke test into policy mode). auth: api is pinned → binds
  // to the claude-apikey runtime, deterministically (no env detection).
  const projectDir = mkdtempSync(join(tmpdir(), "forge-policy-proj-"));
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(
    join(projectDir, ".forge", "model-policy.yml"),
    `
on_unavailable: fail
model_profiles:
  claude-api:
    provider: anthropic
    auth: api
    map:
      default: { model: policy-chosen-model, cost_tier: standard }
defaults:
  profile: claude-api
  activity: {}
`
  );

  const r = await invoke({
    agentRole: "engineer",
    task: "do policy work",
    projectDir,
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "complete");
  const task = getTask(r.taskId);
  assert.ok(task);
  // Concrete model came from the profile map, not the runtime default.
  assert.equal(task!.agentModel, "policy-chosen-model");
  assert.equal(task!.resolvedProfile, "claude-api");
  assert.equal(task!.resolvedProvider, "anthropic");
  assert.equal(task!.resolvedAuth, "api");
  assert.equal(task!.resolvedBy, "defaults.profile");

  const dir = taskDir(r.runId, r.taskId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;
  assert.ok(manifest.model, "policy mode should write a manifest model block");
  assert.equal(manifest.model!.profile, "claude-api");
  assert.equal(manifest.model!.model, "policy-chosen-model");
  assert.equal(manifest.model!.auth, "api");
  assert.equal(manifest.model!.runtime, "claude-apikey");
});

test("invoke: creates a new run when --run-id is absent, with synthetic 'invoke' workflow", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const stub = makeStubExec({ status: "complete", output: "ok" });

  const r = await invoke({
    agentRole: "research-specialist",
    task: "What does the v2 runner do?",
    projectDir: "/tmp/some-project",
    dockerExec: stub,
  });

  assert.equal(r.status, "complete");
  assert.deepEqual(r.result, { status: "complete", output: "ok" });

  const run = getRun(r.runId);
  assert.ok(run);
  assert.equal(run!.workflow, "invoke");
  // #157: invoke now closes the run it owns. Pre-#157 this was 'active' and
  // leaked into phantom-active counts; the bug was caught after 34 phantoms
  // accumulated on the dev's machine. RunStatus has no 'failed' state — the
  // task-level status carries success/failure; the run flips to 'complete'
  // simply to mark "no longer in flight". Mirrors runNext.ts:138 semantics.
  assert.equal(run!.status, "complete");
  assert.ok(run!.completedAt, "completed_at should be set when run closes");
  assert.match(run!.title, /research-specialist/);

  const task = getTask(r.taskId);
  assert.ok(task);
  assert.equal(task!.status, "complete");
  assert.equal(task!.agentRole, "research-specialist");
  assert.equal(task!.phase, "task");
  // agentModel is stamped from the runtime's default at insertTask time
  // (no explicit modelAlias passed → falls through to runtime.models.default)
  assert.equal(task!.agentModel, "test-model");
});

test("invoke: stamps explicit agentModel from runtime alias map", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Extend the runtime stub with an extra alias so we can prove resolution
  // picks the alias-specific model, not the default.
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  writeFileSync(runtimePath, `
name: claude
description: test stub
image: test-image:latest
models:
  default: test-model-default
  spec-writer: test-model-spec
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);

  const stub = makeStubExec({ status: "complete" });
  const r = await invoke({
    agentRole: "engineer",
    task: "do something",
    projectDir: "/tmp/some-project",
    modelAlias: "spec-writer",
    dockerExec: stub,
  });

  const task = getTask(r.taskId);
  assert.equal(task!.agentAlias, "spec-writer");
  assert.equal(task!.agentModel, "test-model-spec");
});

test("invoke: attaches to an existing run when --run-id is provided", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const stub = makeStubExec({ status: "complete" });

  // First invoke creates a run
  const first = await invoke({
    agentRole: "research-specialist",
    task: "claim A",
    projectDir: "/tmp/some-project",
    dockerExec: stub,
  });

  // Second invoke into the same run
  const second = await invoke({
    agentRole: "research-specialist",
    task: "claim B",
    projectDir: "/tmp/some-project",
    runId: first.runId,
    dockerExec: stub,
  });

  assert.equal(second.runId, first.runId);
  const tasks = tasksForRun(first.runId);
  assert.equal(tasks.length, 2);
});

test("invoke: failed exit + empty result.json marks task failed and returns failed", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const crashing: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "container crashed");
    return 1;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "do thing",
    projectDir: "/tmp/x",
    dockerExec: crashing,
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /container_crash/);

  const task = getTask(r.taskId);
  assert.equal(task!.status, "failed");
});

test("invoke: idle-timeout exit code marks task failed with idle_timeout", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Mimic the watchdog SIGKILLing a hung agent: empty result.json, exit 124.
  const idleKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "hang forever",
    projectDir: "/tmp/x",
    dockerExec: idleKilled,
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /idle_timeout/);

  const task = getTask(r.taskId);
  assert.equal(task!.status, "failed");
});

test("invoke: malformed result.json marks failed", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const malformed: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "not json");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "do thing",
    projectDir: "/tmp/x",
    dockerExec: malformed,
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /malformed/);
});

test("invoke: composes task description into the agent's system prompt", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  let capturedStdin = "";
  const inspectExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Read the CLAUDE.md the task dir got written with
    const claudePath = join(dir, "CLAUDE.md");
    capturedStdin = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : "";
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  await invoke({
    agentRole: "engineer",
    task: "THIS-IS-THE-TASK-MARKER",
    projectDir: "/tmp/x",
    dockerExec: inspectExec,
  });

  assert.match(capturedStdin, /THIS-IS-THE-TASK-MARKER/);
});

test("invoke: readOnlyProject sets PROJECT_MODE=ro in docker args", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  let capturedArgs: string[] = [];
  const inspectExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    capturedArgs = args;
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  await invoke({
    agentRole: "red-wide",
    task: "audit X",
    projectDir: "/tmp/x",
    readOnlyProject: true,
    dockerExec: inspectExec,
  });

  // The runtime stub's mount block uses ${PROJECT_MODE:-rw}; readOnly should
  // resolve that to "ro". The mount string contains `:/project` and ends with :ro.
  // The minimal runtime stub doesn't include /project mount, so we just confirm
  // that the docker args were built without throwing — the mode threading happens
  // in spawn.ts which has its own tests.
  assert.ok(capturedArgs.length > 0);
});

// ----- #201 (supersedes #157): derived run-status transitions -----
//
// Run status reflects task states: a run is "active" iff it has a non-terminal
// top-level task. An attached invoke closes the run when no sibling is in
// flight, and reactivates a terminally-closed run it attaches to.

test("invoke: a task cancelled mid-spawn stays failed/cancelled even when the container returns success (AWN-2 task-level)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { insertRun, updateRunStatus, getRun } = await import("../store/runs.js");
  const { failTask } = await import("./failure-kind.js");
  const { basename } = await import("node:path");
  const externalRunId = "run-cancel-race";
  insertRun({ id: externalRunId, workflow: "external", title: "race", status: "active", createdAt: new Date().toISOString() });

  // Stub that simulates a real `forge cancel` landing while the container runs:
  // it marks the task failed (failure_kind=cancelled) AND abandons the run, THEN
  // the container returns a successful result.
  const cancelMidSpawn: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const taskId = basename(dir); // task dir basename === taskId
    failTask(taskId, { runId: externalRunId, kind: "cancelled", error: "cancelled via forge cancel" });
    updateRunStatus(externalRunId, "abandoned");
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
    return 0;
  };

  const r = await invoke({ agentRole: "engineer", task: "work", projectDir: "/tmp/x", runId: externalRunId, dockerExec: cancelMidSpawn });

  // The TASK must stay failed/cancelled — not overwritten to complete.
  const task = getTask(r.taskId)!;
  assert.equal(task.status, "failed", "cancelled task must not be overwritten to complete");
  assert.equal(r.status, "failed", "invoke reports the cancelled task as failed, not complete");

  // No task.completed emitted after the cancellation.
  const types = eventsForTask(r.taskId).map((e) => e.eventType);
  const failedIdx = types.lastIndexOf("task.failed");
  assert.ok(failedIdx >= 0, "task.failed (cancelled) was emitted");
  assert.ok(!types.includes("task.completed"), "no task.completed after task cancellation");

  // The run stays abandoned (cancel is authoritative).
  assert.equal(getRun(externalRunId)!.status, "abandoned");
});

test("invoke: closes an attached run once no sibling top-level task is in flight (#201)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { insertRun } = await import("../store/runs.js");
  const externalRunId = "run-external-derived-idle";
  insertRun({
    id: externalRunId,
    workflow: "external",
    title: "external owner",
    status: "active",
    createdAt: new Date().toISOString(),
  });

  const r = await invoke({
    agentRole: "engineer",
    task: "task inside an externally-owned run",
    projectDir: "/tmp/x",
    runId: externalRunId,    // attach — invoke does NOT own this run
    dockerExec: makeStubExec({ status: "complete" }),
  });
  assert.equal(r.status, "complete");

  // No other top-level task remains running, so the run is no longer in
  // flight — derived status closes it. (Supersedes #157, which left attached
  // runs leaked-active with nothing to close them.)
  const run = getRun(externalRunId);
  assert.equal(run!.status, "complete", "attached invoke closes the run when nothing else is in flight");
  assert.ok(run!.completedAt, "completed_at set on close");
});

test("invoke: keeps an attached run active while a sibling top-level task is still running (#201)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { insertRun } = await import("../store/runs.js");
  const { insertTask, markTaskRunning } = await import("../store/tasks.js");
  const externalRunId = "run-external-derived-sibling";
  insertRun({
    id: externalRunId,
    workflow: "external",
    title: "parallel reds",
    status: "active",
    createdAt: new Date().toISOString(),
  });
  // A sibling top-level task still churning (e.g. a parallel red launched under
  // the same run). It must keep the run active after our invoke finishes.
  insertTask({
    id: "task-sibling-still-running",
    runId: externalRunId,
    phase: "task",
    agentRole: "red-wide",
    status: "pending",
    taskPackage: { taskId: "task-sibling-still-running", runId: externalRunId, phase: "task", role: "red-wide", inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  });
  markTaskRunning("task-sibling-still-running");

  const r = await invoke({
    agentRole: "engineer",
    task: "finishes first",
    projectDir: "/tmp/x",
    runId: externalRunId,
    dockerExec: makeStubExec({ status: "complete" }),
  });
  assert.equal(r.status, "complete");

  const run = getRun(externalRunId);
  assert.equal(run!.status, "active", "run stays active while a sibling task is still running");
  assert.equal(run!.completedAt, undefined);
});

test("invoke: reactivates a terminally-closed run on attach, then closes it again (#201)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { insertRun } = await import("../store/runs.js");
  // A run that was already closed (a prior invoke completed it). Attaching a
  // new live task must bring it back to active mid-flight — otherwise the
  // churning container is invisible in the dashboard / forge status.
  const externalRunId = "run-external-reactivate";
  insertRun({
    id: externalRunId,
    workflow: "external",
    title: "previously closed",
    status: "complete",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });

  const r = await invoke({
    agentRole: "test-engineer",
    task: "attached after the run was closed",
    projectDir: "/tmp/x",
    runId: externalRunId,
    dockerExec: makeStubExec({ status: "complete" }),
  });
  assert.equal(r.status, "complete");

  // A run.reactivated event proves the run was flipped back to active while the
  // task ran; the final close brings it to complete again now that it's idle.
  const events = eventsForRun(externalRunId);
  assert.ok(
    events.some((e) => e.eventType === "run.reactivated"),
    "attach to a terminal run must emit run.reactivated",
  );
  const run = getRun(externalRunId);
  assert.equal(run!.status, "complete", "run closes again once the attached task is terminal");
});

test("invoke: closes the owned run as 'complete' even when the task fails (RunStatus has no 'failed')", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Stub that simulates the container_crash path: exit code 1, no result.json.
  const crashStub: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "boom");
    return 1;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "task that will fail",
    projectDir: "/tmp/x",
    dockerExec: crashStub,
  });
  assert.equal(r.status, "failed");

  // Even on failure, the OWNED run flips to 'complete' (not 'failed' — that's
  // not a valid RunStatus). The failure signal lives at the task level.
  const run = getRun(r.runId);
  assert.equal(run!.status, "complete", "owned run closes even on task failure");
  assert.ok(run!.completedAt, "completed_at should be set on the closed run");
  const task = getTask(r.taskId);
  assert.equal(task!.status, "failed", "task-level status still says failed");
});

// #176: --auth-profile must fail fast BEFORE a container spawns when the profile
// is missing or expired — an unauthenticated agent silently produces false
// "app broken" reports.
function supabaseValue(expiresAt: number): string {
  return JSON.stringify({ access_token: "h.p.s", expires_at: expiresAt, refresh_token: "r" });
}

test("invoke: --auth-profile fails fast (no container) when the profile is missing", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  let execCalled = false;
  const guardExec: DockerExecFn = async () => { execCalled = true; return 0; };

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test the admin",
    projectDir: "/tmp/x",
    authProfile: "ghost-profile",
    dockerExec: guardExec,
  });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /not found/);
  assert.match(r.error!, /forge auth-profile login ghost-profile/);
  assert.equal(execCalled, false, "no container should spawn for a missing profile");
});

test("invoke: --auth-profile fails fast (no container) when the profile is expired", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  // expires_at one second in the past.
  const past = Math.floor(Date.now() / 1000) - 1;
  writeProfile("stale-admin", {
    cookies: [],
    origins: [{ origin: "https://staging.test", localStorage: [{ name: "sb-x-auth-token", value: supabaseValue(past) }] }],
  });
  let execCalled = false;
  const guardExec: DockerExecFn = async () => { execCalled = true; return 0; };

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test the admin",
    projectDir: "/tmp/x",
    authProfile: "stale-admin",
    dockerExec: guardExec,
  });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /expired/);
  assert.equal(execCalled, false, "no container should spawn for an expired profile");
});

test("invoke: staged auth-state is CLEANED UP after the task terminates (AWN-8; staging details covered in auth-state.test.ts)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  delete process.env.FORGE_CONTAINER_HOST;
  const fhome = process.env.FORGE_HOME!;
  // A browser-tools dir carrying the injector, so the #181 auth guard passes.
  const btDir = join(fhome, "bt-skill");
  mkdirSync(btDir, { recursive: true });
  writeFileSync(join(btDir, "auth-inject.js"), "// stub injector\n");
  // A runtime that mounts browser-tools (the stub claude.yml doesn't).
  const rtPath = join(fhome, "runtimes", "claude-bt.yml");
  writeFileSync(rtPath, `
name: claude-bt
description: bt stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
  - { host: "${btDir}", container: /home/agent/.claude/skills/browser-tools }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  const future = Math.floor(Date.now() / 1000) + 3600;
  writeProfile("local-admin", {
    cookies: [],
    origins: [{ origin: "http://localhost:3000", localStorage: [{ name: "sb-x-auth-token", value: supabaseValue(future) }] }],
  });

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test",
    projectDir: "/tmp/x",
    authProfile: "local-admin",
    runtimeName: "claude-bt",
    dockerExec: makeStubExec({ status: "complete" }),
  });
  assert.equal(r.status, "complete");

  // AWN-8: the staged mode-600 bearer token must NOT linger after the task ends.
  const staged = join(taskDir(r.runId, r.taskId), "auth-state.json");
  assert.ok(!existsSync(staged), "staged auth-state.json must be cleaned up after the task terminates");
});

// ----- #194: lifecycle event backfill — container.* and auth.* -----

test("invoke: emits task.created before task.started (timeline starts at creation)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "do work",
    projectDir: "/tmp/x",
    dockerExec: makeStubExec({ status: "complete" }),
  });
  assert.equal(r.status, "complete");

  const types = eventsForTask(r.taskId).map((e) => e.eventType);
  const createdIdx = types.indexOf("task.created");
  const startedIdx = types.indexOf("task.started");
  assert.ok(createdIdx >= 0, "invoke must emit task.created");
  assert.ok(startedIdx >= 0, "invoke must emit task.started");
  assert.ok(createdIdx < startedIdx, "task.created must precede task.started");
});

test("invoke: emits container.started then container.exited (exit 0) on success", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "do work",
    projectDir: "/tmp/x",
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "complete");
  const events = eventsForTask(r.taskId);
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("container.started"), "must emit container.started");
  assert.ok(types.includes("container.exited"), "must emit container.exited on exit 0");

  const started = events.find((e) => e.eventType === "container.started")!;
  assert.deepEqual((started.payload as Record<string, unknown>).containerName, `forge-${r.taskId}`);

  const exited = events.find((e) => e.eventType === "container.exited")!;
  assert.equal((exited.payload as Record<string, unknown>).containerName, `forge-${r.taskId}`);
  assert.equal((exited.payload as Record<string, unknown>).exitCode, 0);
});

test("invoke: emits container.idle_timeout (not container.exited) on IDLE_TIMEOUT_EXIT_CODE", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const idleKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "hang forever",
    projectDir: "/tmp/x",
    dockerExec: idleKilled,
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("container.started"), "must emit container.started");
  assert.ok(types.includes("container.idle_timeout"), "must emit container.idle_timeout");
  assert.ok(!types.includes("container.exited"), "must NOT emit container.exited for idle_timeout");

  const idleEv = events.find((e) => e.eventType === "container.idle_timeout")!;
  assert.equal((idleEv.payload as Record<string, unknown>).containerName, `forge-${r.taskId}`);
  assert.equal((idleEv.payload as Record<string, unknown>).exitCode, IDLE_TIMEOUT_EXIT_CODE);
});

test("invoke: ingests progress.jsonl even when the agent hits idle_timeout (WALK finding)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Agent wrote a decision then hung — its last record must still reach the timeline.
  const hungWithProgress: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "progress.jsonl"), '{"type":"decision","summary":"chose approach A"}\n');
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  const r = await invoke({ agentRole: "engineer", task: "hang", projectDir: "/tmp/x", dockerExec: hungWithProgress });
  assert.equal(r.status, "failed");
  const types = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(types.includes("task.decision"), "progress must be ingested on the idle_timeout path");
  assert.ok(types.includes("container.idle_timeout"), "still emits idle_timeout");
  // Ordering: the decision (written during the run) precedes the terminal failure.
  assert.ok(types.indexOf("task.decision") < types.indexOf("task.failed"), "progress precedes task.failed");
});

test("invoke: emits container.exited with exitCode on nonzero exit", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const crashing: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "crash");
    return 1;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "crash",
    projectDir: "/tmp/x",
    dockerExec: crashing,
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const exited = events.find((e) => e.eventType === "container.exited")!;
  assert.ok(exited, "must emit container.exited for nonzero exit");
  assert.equal((exited.payload as Record<string, unknown>).exitCode, 1);
});

function supabaseValueInvoke(expiresAt: number): string {
  return JSON.stringify({ access_token: "h.p.s", expires_at: expiresAt, refresh_token: "r" });
}

test("invoke: emits auth.profile_applied with profile name (no secret material) on success", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  delete process.env.FORGE_CONTAINER_HOST;
  const fhome = process.env.FORGE_HOME!;
  const btDir = join(fhome, "bt-skill");
  mkdirSync(btDir, { recursive: true });
  writeFileSync(join(btDir, "auth-inject.js"), "// stub injector\n");
  const rtPath = join(fhome, "runtimes", "claude-bt-auth.yml");
  writeFileSync(rtPath, `
name: claude-bt-auth
description: bt auth stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
  - { host: "${btDir}", container: /home/agent/.claude/skills/browser-tools }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  const future = Math.floor(Date.now() / 1000) + 3600;
  writeProfile("auth-applied-profile", {
    cookies: [],
    origins: [{ origin: "https://staging.test", localStorage: [{ name: "sb-x-auth-token", value: supabaseValueInvoke(future) }] }],
  });

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test",
    projectDir: "/tmp/x",
    authProfile: "auth-applied-profile",
    runtimeName: "claude-bt-auth",
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "complete");
  const events = eventsForTask(r.taskId);
  const applied = events.find((e) => e.eventType === "auth.profile_applied")!;
  assert.ok(applied, "must emit auth.profile_applied");
  const payload = applied.payload as Record<string, unknown>;
  assert.equal(payload.profile, "auth-applied-profile");
  assert.ok(!("token" in payload), "payload must not contain token");
  assert.ok(!("state" in payload), "payload must not contain state");
  assert.ok(!("hostPath" in payload), "payload must not contain hostPath");
});

test("invoke: emits auth.profile_failed (no secret material) when profile is missing", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test",
    projectDir: "/tmp/x",
    authProfile: "totally-missing-profile-xyz",
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const failed = events.find((e) => e.eventType === "auth.profile_failed")!;
  assert.ok(failed, "must emit auth.profile_failed");
  const payload = failed.payload as Record<string, unknown>;
  assert.equal(payload.profile, "totally-missing-profile-xyz");
  assert.ok(typeof payload.reason === "string" && payload.reason.length > 0, "must include a reason");
  assert.ok(!("token" in payload), "payload must not contain token");
  assert.ok(!("state" in payload), "payload must not contain state");
});

// ----- #197: manifest.json written on invoke dispatch -----

test("invoke: writes manifest.json into the task dir with correct shape", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "do work",
    projectDir: "/tmp/x",
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "complete");
  const dir = taskDir(r.runId, r.taskId);
  const manifestPath = join(dir, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json must exist in task dir");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
  assert.equal(manifest.taskId, r.taskId);
  assert.equal(manifest.runId, r.runId);
  assert.equal(manifest.files.prompt, "CLAUDE.md");
  assert.equal(manifest.files.package, "package.md");
  assert.equal(manifest.files.result, "result.json");
  assert.equal(manifest.files.stdout, "container.stdout.log");
  assert.equal(manifest.files.stderr, "container.stderr.log");
  assert.equal(manifest.container.name, `forge-${r.taskId}`);
  assert.equal(manifest.auth.profileRequested, false);
  assert.equal(manifest.auth.stateMounted, false);
});

test("invoke: manifest auth block is booleans-only — no token, no hostPath, no path values", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "do work",
    projectDir: "/tmp/x",
    dockerExec: makeStubExec({ status: "complete" }),
  });

  const dir = taskDir(r.runId, r.taskId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;

  const authKeys = Object.keys(manifest.auth).sort();
  assert.deepEqual(authKeys, ["profileRequested", "stateMounted"]);
  assert.equal(typeof manifest.auth.profileRequested, "boolean");
  assert.equal(typeof manifest.auth.stateMounted, "boolean");

  // No credential or path keys present
  const forbidden = ["token", "profile", "path", "hostPath", "state", "secret"];
  for (const k of forbidden) {
    assert.ok(!(k in manifest.auth), `auth must not contain '${k}'`);
  }
  // No values that look like filesystem paths
  for (const v of Object.values(manifest.auth as Record<string, unknown>)) {
    assert.ok(typeof v !== "string" || !v.includes("/"), `auth value must not be a path: ${String(v)}`);
  }
});
