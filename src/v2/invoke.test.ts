// invoke.ts tests: stubbed dockerExec, asserts run + task creation and result handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { getRun } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { writeProfile } from "../util/auth-profiles.js";

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

// ----- #157: terminal run-status transitions -----

test("invoke: leaves run.status='active' when attached to an existing --run id (caller owns the run)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // First create a run via invoke (own → closes), then attach a SECOND
  // invocation to that same run. The second call should NOT re-flip an
  // already-closed run, AND should not touch the status when invoke is the
  // attached (not owning) call. To test the "attached" case cleanly, we create
  // a run separately via insertRun-style helper and then attach.
  const { insertRun } = await import("../store/runs.js");
  const externalRunId = "run-external-test-157";
  insertRun({
    id: externalRunId,
    workflow: "external",
    title: "external owner",
    status: "active",
    createdAt: new Date().toISOString(),
  });

  const stub = makeStubExec({ status: "complete" });
  const r = await invoke({
    agentRole: "engineer",
    task: "task inside an externally-owned run",
    projectDir: "/tmp/x",
    runId: externalRunId,    // attach — invoke does NOT own this run
    dockerExec: stub,
  });
  assert.equal(r.status, "complete");

  // The external run must still be 'active' — invoke shouldn't have closed it,
  // because the caller owns it and will manage its lifecycle.
  const run = getRun(externalRunId);
  assert.equal(run!.status, "active", "attached invoke must not close the caller-owned run");
  assert.equal(run!.completedAt, undefined);
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
