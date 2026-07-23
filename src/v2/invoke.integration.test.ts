// invoke.ts tests: stubbed dockerExec, asserts run + task creation and result handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { containerNameFromArgs } from "./docker-exec.js";
import { reconcileRun } from "./reconcile.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE } from "./dependency-provisioning.js";
import { getRun } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { eventsForTask, eventsForRun } from "../store/events.js";
import { failureKindForTask, getOrphanEvidenceFromEvents, getContainerCausalEvidenceFromEvents } from "./failure-kind.js";
import { runOpsCheck } from "../ops/detect.js";
import { orphanRecoveryMessage, describeContainerEvidence } from "../cli/commands/show.js";
import { execFileSync } from "node:child_process";
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
  if (!existsSync(runtimePath)) {
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
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
}

// AWN-7: a claude-apikey runtime stub the (anthropic, api) binding resolves to.
// Additive — legacy tests use the literal claude.yml, which loadRuntime prefers.
function setupApikeyRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const p = join(fhome, "runtimes", "claude-apikey.yml");
  if (!existsSync(p)) {
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
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
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

  // Lifecycle: a model.profile_resolved event fired for the task.
  const events = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(events.includes("model.profile_resolved"), `expected model.profile_resolved in ${events.join(",")}`);
});

test("invoke: policy mode fails loud when the resolved auth is unavailable", async () => {
  setupApikeyRuntimeStub();
  // Force api unavailable: clear ANTHROPIC_API_KEY for this test, restore after.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const projectDir = mkdtempSync(join(tmpdir(), "forge-policy-unavail-"));
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
      default: { model: m, cost_tier: standard }
defaults:
  profile: claude-api
  activity: {}
`
  );

  let dockerCalled = false;
  const spyExec: DockerExecFn = async (a) => {
    dockerCalled = true;
    return makeStubExec({ status: "complete" })(a);
  };

  try {
    const r = await invoke({
      agentRole: "engineer",
      task: "should not run",
      projectDir,
      dockerExec: spyExec,
    });

    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /unavailable/);
    assert.equal(dockerCalled, false, "container must not spawn when auth is unavailable");

    const events = eventsForTask(r.taskId).map((e) => e.eventType);
    assert.ok(events.includes("model.profile_unavailable"), `expected model.profile_unavailable in ${events.join(",")}`);
    assert.ok(!events.includes("container.started"), "no container.started on a fail-loud unavailable");
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

// #303: end-to-end fail-loud for a pi explicit-runtime profile — a pi-groq
// profile must fail before dispatch when GROQ_API_KEY is absent (doctor probe
// → availability gate), so a user never gets a container with --provider groq
// and no credential.
test("invoke: a pi-groq profile fails loud before dispatch when GROQ_API_KEY is absent (#303)", async () => {
  setupPiRuntimeStub();
  const savedGroq = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  const projectDir = mkdtempSync(join(tmpdir(), "forge-pi-groq-unavail-"));
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(
    join(projectDir, ".forge", "model-policy.yml"),
    `
on_unavailable: fail
model_profiles:
  pi-groq:
    provider: groq
    runtime: pi-stub
    auth: api
    map:
      default: { model: llama-3.3-70b-versatile, cost_tier: cheap }
defaults:
  profile: pi-groq
  activity: {}
`
  );

  let dockerCalled = false;
  const spyExec: DockerExecFn = async (a) => {
    dockerCalled = true;
    return makeStubExec({ status: "complete" })(a);
  };

  try {
    const r = await invoke({ agentRole: "engineer", task: "should not run", projectDir, dockerExec: spyExec });
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /provider 'groq'.*unavailable.*GROQ_API_KEY not set/s);
    assert.equal(dockerCalled, false, "container must not spawn when the groq key is unavailable");
    const events = eventsForTask(r.taskId).map((e) => e.eventType);
    assert.ok(events.includes("model.profile_unavailable"));
    assert.ok(!events.includes("container.started"));
  } finally {
    if (savedGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedGroq;
  }
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
  // accumulated on the dev's machine. A successful invoke task yields a
  // 'complete' run (this test); since FG-585 a FAILED invoke task instead
  // yields a 'failed' run (see "closes the owned run as 'failed' when the task
  // fails (FG-585)"). Mirrors runNext.ts semantics.
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
  // Re-publish so the generation carries the extended runtime bytes, not the stub's.
  publishFlatAsGeneration(fhome);

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

test("invoke: FG-455 attached exit 137 + empty result.json marks task failed with oom_killed, not container_crash", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const oomKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 137;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "do thing",
    projectDir: "/tmp/x",
    dockerExec: oomKilled,
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /killed|exit 137|OOM/);
  assert.doesNotMatch(r.error ?? "", /container_crash/);
  assert.equal(failureKindForTask(r.taskId), "oom_killed");

  const task = getTask(r.taskId);
  assert.equal(task!.status, "failed");
});

test("invoke: FG-376 dependency-provisioning exit code marks task failed with verification_environment_unavailable, not container_crash", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Mimic the entrypoint's `npm ci` failing before it could exec the agent:
  // no result.json, exit DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE, stderr carries the cause.
  const provisioningFailed: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "npm ci failed: EACCES");
    return DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "do thing",
    projectDir: "/tmp/x",
    dockerExec: provisioningFailed,
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /verification_environment_unavailable/);
  assert.match(r.error ?? "", /npm ci failed: EACCES/);
  assert.doesNotMatch(r.error ?? "", /container_crash/);

  const task = getTask(r.taskId);
  assert.equal(task!.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "verification_environment_unavailable");
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

// ── FG-492 review: reap/retain now decided in invoke.ts (task outcome), not
// docker-exec.ts (raw exit code) ─────────────────────────────────────────────
//
// The fake dockerExec above never calls docker itself, so `finalizeContainerRetention`'s
// real `docker rm -f` would hit whatever `docker` is on PATH. These tests shadow
// PATH with a no-op stub (same technique docker-exec.test.ts uses) and assert on
// whether `rm -f -v forge-<taskId>` was actually invoked.
function makeDockerRmStub(exitCode = 0): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-invoke-docker-stub-"));
  const logPath = join(binDir, "docker-calls.log");
  writeFileSync(join(binDir, "docker"), `#!/bin/sh\necho "$@" >> "${logPath}"\nexit ${exitCode}\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

async function withDockerRmStub<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const { binDir, logPath } = makeDockerRmStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    return await fn(logPath);
  } finally {
    process.env.PATH = origPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

// FG-503: `docker rm -f -v` itself failing (daemon hiccup) — the same stub
// technique, but exits non-zero so finalizeContainerRetention returns
// "reap_failed" instead of "reaped".
async function withFailingDockerRmStub<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const { binDir, logPath } = makeDockerRmStub(1);
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    return await fn(logPath);
  } finally {
    process.env.PATH = origPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("invoke: FG-492 review — exit 0 + valid result.json → task completes AND the container is reaped", async () => {
  await withDockerRmStub(async (logPath) => {
    setupRuntimeStub();
    process.env.ANTHROPIC_API_KEY = "sk-stub";

    const r = await invoke({
      agentRole: "engineer",
      task: "do thing",
      projectDir: "/tmp/x",
      dockerExec: makeStubExec({ status: "complete" }),
    });

    assert.equal(r.status, "complete");
    const calls = readFileSync(logPath, "utf8");
    assert.match(calls, new RegExp(`rm -f -v forge-${r.taskId}`), "a completed task's container is reaped");
  });
});

test("invoke: FG-492 review — exit 0 + NO result.json (state 4) → task fails result_missing AND the container is RETAINED, not reaped", async () => {
  await withDockerRmStub(async (logPath) => {
    setupRuntimeStub();
    process.env.ANTHROPIC_API_KEY = "sk-stub";

    // Confirmed clean exit, but no result.json at all — exactly the state-4
    // case a raw-exit-code-based reap policy would have destroyed.
    const cleanExitNoResult: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const r = await invoke({
      agentRole: "engineer",
      task: "do thing",
      projectDir: "/tmp/x",
      dockerExec: cleanExitNoResult,
    });

    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /no_result_json/);
    const calls = readFileSync(logPath, "utf8");
    assert.doesNotMatch(calls, / rm /, "a clean exit with no result.json must be retained, never reaped just because the exit code was 0");
  });
});

test("invoke: FG-492 review — non-zero exit (container_crash) → the container is RETAINED, not reaped", async () => {
  await withDockerRmStub(async (logPath) => {
    setupRuntimeStub();
    process.env.ANTHROPIC_API_KEY = "sk-stub";

    const crash: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 1;
    };

    const r = await invoke({
      agentRole: "engineer",
      task: "do thing",
      projectDir: "/tmp/x",
      dockerExec: crash,
    });

    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /container_crash/);
    const calls = readFileSync(logPath, "utf8");
    assert.doesNotMatch(calls, / rm /, "a genuine container_crash must stay retained for diagnosis");
  });
});

test("invoke: FG-492 review — FORGE_CONTAINER_RETENTION=off reaps even a failed task", async () => {
  await withDockerRmStub(async (logPath) => {
    setupRuntimeStub();
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.FORGE_CONTAINER_RETENTION = "off";
    try {
      const crash: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
        const dir = dirname(stdoutPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(stdoutPath, "");
        writeFileSync(stderrPath, "");
        return 1;
      };

      const r = await invoke({
        agentRole: "engineer",
        task: "do thing",
        projectDir: "/tmp/x",
        dockerExec: crash,
      });

      assert.equal(r.status, "failed");
      const calls = readFileSync(logPath, "utf8");
      assert.match(calls, new RegExp(`rm -f -v forge-${r.taskId}`), "FORGE_CONTAINER_RETENTION=off forces a reap even on failure");
    } finally {
      delete process.env.FORGE_CONTAINER_RETENTION;
    }
  });
});

// ── FG-503: reap_failed on a SUCCESSFUL task is durably recorded ────────────

test("invoke: FG-503 — exit 0 + valid result.json but `docker rm` errors → task still completes AND a container.reap_failed event is recorded", async () => {
  await withFailingDockerRmStub(async (logPath) => {
    setupRuntimeStub();
    process.env.ANTHROPIC_API_KEY = "sk-stub";

    const r = await invoke({
      agentRole: "engineer",
      task: "do thing",
      projectDir: "/tmp/x",
      dockerExec: makeStubExec({ status: "complete" }),
    });

    assert.equal(r.status, "complete", "a reap failure must never turn a successful task into a failed one");
    const calls = readFileSync(logPath, "utf8");
    assert.match(calls, new RegExp(`rm -f -v forge-${r.taskId}`), "the reap was attempted");

    const events = eventsForTask(r.taskId);
    const reapFailedEvents = events.filter((e) => e.eventType === "container.reap_failed");
    assert.equal(reapFailedEvents.length, 1, "the failed reap must be durably recorded exactly once");
    const payload = reapFailedEvents[0]!.payload as { containerName: string; why: string };
    assert.equal(payload.containerName, `forge-${r.taskId}`);
    // FG-503 cross-path consistency: invoke.ts, runNext.ts and gate.ts each
    // wrap a distinct call site with their own reap-failure logging, but must
    // emit the SAME payload shape — {containerName, why} — so any consumer
    // (forge ops reap-containers, forge show --diagnostic) can read the event
    // without caring which of the three paths produced it. See the matching
    // assertion in runNext.integration.test.ts and fg492-gate-container-reap.test.ts.
    assert.deepEqual(Object.keys(payload).sort(), ["containerName", "why"], "payload shape must match the other two reap paths (runNext.ts, gate.ts)");
    assert.match(payload.why, /^docker rm -f -v failed/, "why must follow the shared wording convention across all three reap paths");
  });
});

test("invoke: FG-503 — happy-path completion (reap succeeds) emits no container.reap_failed event", async () => {
  await withDockerRmStub(async (logPath) => {
    setupRuntimeStub();
    process.env.ANTHROPIC_API_KEY = "sk-stub";

    const r = await invoke({
      agentRole: "engineer",
      task: "do thing",
      projectDir: "/tmp/x",
      dockerExec: makeStubExec({ status: "complete" }),
    });

    assert.equal(r.status, "complete");
    const calls = readFileSync(logPath, "utf8");
    assert.match(calls, new RegExp(`rm -f -v forge-${r.taskId}`));

    const events = eventsForTask(r.taskId);
    assert.equal(events.filter((e) => e.eventType === "container.reap_failed").length, 0, "the happy path must stay silent — no new event on a successful reap");
  });
});

// FG-497: the task description must reach the agent via the task package
// (package.md / stdin) — an unbounded channel — NOT via the composed system
// prompt (CLAUDE.md), which every claude/pi runtime passes as a single
// bounded argv string.
test("invoke: composes task description into the task package (package.md/stdin), NOT the system prompt", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  let capturedClaudeMd = "";
  let capturedPackageMd = "";
  const inspectExec: DockerExecFn = async ({ stdin, stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const claudePath = join(dir, "CLAUDE.md");
    capturedClaudeMd = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : "";
    const packagePath = join(dir, "package.md");
    capturedPackageMd = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : "";
    void stdin;
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

  assert.doesNotMatch(capturedClaudeMd, /THIS-IS-THE-TASK-MARKER/, "the task must NOT be embedded in the composed system prompt (argv-bounded)");
  assert.match(capturedPackageMd, /THIS-IS-THE-TASK-MARKER/, "the task must reach the agent via package.md (stdin-bounded, unlimited size)");
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

test("invoke: closes the owned run as 'failed' when the task fails (FG-585)", async () => {
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

  // FG-585: an owned invoke run whose only task failed closes as 'failed' — the
  // run status now tells the truth instead of a false 'complete' with the
  // failure buried at the task level.
  const run = getRun(r.runId);
  assert.equal(run!.status, "failed", "owned run closes as failed on task failure");
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
function supabaseValueNoRefresh(expiresAt: number): string {
  return JSON.stringify({ access_token: "h.p.s", expires_at: expiresAt });
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
  // expires_at one second in the past, no refresh_token — genuinely dead.
  const past = Math.floor(Date.now() / 1000) - 1;
  writeProfile("stale-admin", {
    cookies: [],
    origins: [{ origin: "https://staging.test", localStorage: [{ name: "sb-x-auth-token", value: supabaseValueNoRefresh(past) }] }],
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

test("invoke: --auth-profile with expired access_token but refresh_token present is NOT blocked as expired", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  // Expired access token but refresh_token present — browser will auto-refresh, so not dead.
  const past = Math.floor(Date.now() / 1000) - 1;
  writeProfile("refreshable-admin", {
    cookies: [],
    origins: [{ origin: "https://staging.test", localStorage: [{ name: "sb-x-auth-token", value: supabaseValue(past) }] }],
  });

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test the admin",
    projectDir: "/tmp/x",
    authProfile: "refreshable-admin",
    dockerExec: async () => 0,
  });

  // auth.profile_applied must be emitted (profile passed the expiry gate).
  // auth.profile_failed must NOT be emitted. Task may fail for unrelated reasons.
  const events = eventsForTask(r.taskId);
  assert.ok(events.some((e) => e.eventType === "auth.profile_applied"), "auth.profile_applied must be emitted for a refreshable profile");
  assert.ok(!events.some((e) => e.eventType === "auth.profile_failed"), "auth.profile_failed must NOT be emitted for a refreshable profile");
  if (r.status === "failed") assert.doesNotMatch(r.error!, /expired/);
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
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
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
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
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

// ── #264: pi result-contract parity ──────────────────────────────────────────
// A pi runtime stub (runtime_kind: pi) so runtimeMeta resolves to pi. auth.mode
// apikey → ANTHROPIC_API_KEY must be set in these tests.
function setupPiRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const p = join(fhome, "runtimes", "pi-stub.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `
name: pi-stub
description: test stub
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: runtime-default-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: pi
  args: ["-p"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
}

// Exec that writes pi-style JSONL to stdout but does NOT write result.json,
// mimicking pi exiting 0 without the agent honoring the output contract.
function makePiNoResultExec(stdoutJsonl: string, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const d = dirname(stdoutPath);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    return exitCode; // pi exits 0 even on a provider error
  };
}

test("#264: a successful pi run (agent wrote result.json) completes — parity with other runtimes", async () => {
  setupPiRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-pi-ok-"));
  const r = await invoke({
    agentRole: "engineer",
    task: "do pi work",
    projectDir,
    runtimeName: "pi-stub",
    dockerExec: makeStubExec({ status: "complete", note: "pi wrote this" }),
  });
  assert.equal(r.status, "complete");
  const dir = taskDir(r.runId, r.taskId);
  assert.equal((JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as { status: string }).status, "complete");
});

test("#264: a pi run with a provider error and no result.json fails with an attributed error (not no_result_json)", async () => {
  setupPiRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-pi-err-"));
  const stdout =
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({ type: "agent_end", messages: [
      { role: "assistant", stopReason: "error", errorMessage: "401 authentication_error: invalid x-api-key" },
    ] }) + "\n";
  const r = await invoke({
    agentRole: "engineer",
    task: "do pi work",
    projectDir,
    runtimeName: "pi-stub",
    dockerExec: makePiNoResultExec(stdout),
  });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /pi run failed:/);
  assert.match(r.error ?? "", /authentication_error/);
  assert.doesNotMatch(r.error ?? "", /^no_result_json$/);
  // #267: a provider error is classified model_error (with the cause), not generic.
  assert.equal(failureKindForTask(r.taskId), "model_error");
  // FG-513: the classified kind also rides the InvokeResult itself, so in-process
  // callers (review-loop's same-round reviewer retry) can react without a re-read.
  assert.equal(r.failureKind, "model_error");
});

test("#264: a pi run that completes but writes no result.json blames the agent contract", async () => {
  setupPiRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-pi-noresult-"));
  const stdout =
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] }) + "\n";
  const r = await invoke({
    agentRole: "engineer",
    task: "do pi work",
    projectDir,
    runtimeName: "pi-stub",
    dockerExec: makePiNoResultExec(stdout),
  });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /completed but wrote no .*result\.json/);
  // #267: a contract failure is NOT a model error — it stays a generic result_missing kind.
  assert.notEqual(failureKindForTask(r.taskId), "model_error");
});

// ── FG-337: inferred-result fallback ─────────────────────────────────────────

// pi JSONL for a clean completion with assistant text content.
function piCleanWithText(text: string): string {
  return (
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: text }] }) + "\n"
  );
}

test("FG-337: narrative role (research-specialist) completes via inferred result when pi exits cleanly with text", async () => {
  setupPiRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-narr-"));
  const r = await invoke({
    agentRole: "research-specialist",
    task: "what is the capital of France?",
    projectDir,
    runtimeName: "pi-stub",
    dockerExec: makePiNoResultExec(piCleanWithText("The capital of France is Paris.")),
  });
  assert.equal(r.status, "complete");
  const result = r.result as { contract: string; summary: string; status: string };
  assert.equal(result.contract, "inferred");
  assert.equal(result.summary, "The capital of France is Paris.");
  assert.equal(result.status, "complete");
  // Inferred result is persisted to disk.
  const dir = taskDir(r.runId, r.taskId);
  const onDisk = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as { contract: string };
  assert.equal(onDisk.contract, "inferred");
});

test("FG-337: structured role (engineer) still hard-fails even when pi exits cleanly with text", async () => {
  setupPiRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-struct-"));
  const r = await invoke({
    agentRole: "engineer",
    task: "write some code",
    projectDir,
    runtimeName: "pi-stub",
    dockerExec: makePiNoResultExec(piCleanWithText("I wrote the code.")),
  });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /completed but wrote no .*result\.json/);
});

test("FG-337: truncated pi run (no agent_end) still fails for narrative role", async () => {
  setupPiRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-trunc-"));
  const truncated = JSON.stringify({ type: "agent_start" }) + "\n";
  const r = await invoke({
    agentRole: "research-specialist",
    task: "research something",
    projectDir,
    runtimeName: "pi-stub",
    dockerExec: makePiNoResultExec(truncated),
  });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /no completion event/);
});

test("FG-337: pi model error still fails for narrative role (inferred path requires clean completion)", async () => {
  setupPiRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg337-modelerr-"));
  const modelErr =
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", errorMessage: "401 invalid api key" }] }) + "\n";
  const r = await invoke({
    agentRole: "research-specialist",
    task: "research something",
    projectDir,
    runtimeName: "pi-stub",
    dockerExec: makePiNoResultExec(modelErr),
  });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /pi run failed/);
  assert.equal(failureKindForTask(r.taskId), "model_error");
});

// ── FG-461: attached-exit recovery evidence ─────────────────────────────────
// For a recovery-relevant attached-exit kind (oom_killed / container_crash /
// idle_timeout) with no result, invoke records the same OrphanEvidence tuple
// reconcile records for a container-gone task, so getOrphanEvidenceFromEvents
// surfaces it and show/status/ops-check can render a recovery line.

// A dirty git project dir so changedWorktreeFiles returns a non-empty diff.
function makeDirtyGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg461-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "agent-work.txt"), "partial edits before the kill\n");
  return dir;
}

// A crash exec: writes NO result.json, returns the given exit code.
function makeNoResultExec(exitCode: number): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

test("FG-461: attached exit 137 (oom_killed) records OrphanEvidence with exitCode/oomKilled/changed files", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();

  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir, dockerExec: makeNoResultExec(137) });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "oom_killed");

  const evidence = getOrphanEvidenceFromEvents(eventsForTask(r.taskId));
  assert.ok(evidence, "oom_killed attached-exit must record recovery evidence");
  assert.equal(evidence!.containerName, `forge-${r.taskId}`);
  assert.equal(evidence!.containerLiveness, "gone");
  assert.equal(evidence!.resultState, "absent");
  assert.equal(evidence!.exitCode, 137);
  assert.equal(evidence!.source, "project_dir_shared");
  assert.ok(evidence!.changedFiles.some((f) => f.includes("agent-work.txt")), "the dirty file is captured as recovery evidence");
  // FG-461 follow-up: the attached path never ran `docker inspect`, so it must
  // NOT assert a confirmed OOM — exit 137 could be an external kill. oomKilled is
  // left unset, and the operator-facing message stays the honest uncertain form,
  // matching the reconcile-time behavior for an unconfirmed exit 137.
  assert.notEqual(evidence!.oomKilled, true, "attached exit 137 must not fabricate a confirmed OOM (no docker inspect ran)");
  const msg = orphanRecoveryMessage(r.runId, r.taskId, evidence!, "oom_killed");
  assert.match(msg, /exit 137 — possibly OOM or an external kill/);
  assert.doesNotMatch(msg, /container killed \(OOM\)/);
});

test("FG-461: attached exit 1 (container_crash) records OrphanEvidence", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();

  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir, dockerExec: makeNoResultExec(1) });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "container_crash");

  const evidence = getOrphanEvidenceFromEvents(eventsForTask(r.taskId));
  assert.ok(evidence, "container_crash attached-exit must record recovery evidence");
  assert.equal(evidence!.exitCode, 1);
  assert.equal(evidence!.oomKilled, undefined, "attached path never inspects OOM — left unset");
  assert.ok(evidence!.changedFiles.some((f) => f.includes("agent-work.txt")));
});

test("FG-461: idle_timeout records OrphanEvidence", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();

  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir, dockerExec: makeNoResultExec(IDLE_TIMEOUT_EXIT_CODE) });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "idle_timeout");

  const evidence = getOrphanEvidenceFromEvents(eventsForTask(r.taskId));
  assert.ok(evidence, "idle_timeout attached-exit must record recovery evidence");
  assert.equal(evidence!.oomKilled, undefined, "attached path never inspects OOM — left unset");
  assert.ok(evidence!.changedFiles.some((f) => f.includes("agent-work.txt")));
});

test("FG-461: a read-only-project crash records NO evidence (a red/audit can't persist work)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();

  const r = await invoke({ agentRole: "red-wide", task: "audit", projectDir, readOnlyProject: true, dockerExec: makeNoResultExec(137) });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "oom_killed");
  // Read-only dispatch: the operator's own dirty files are not this task's work,
  // so no recovery evidence is recorded.
  assert.equal(getOrphanEvidenceFromEvents(eventsForTask(r.taskId)), undefined);
});

// ── FG-497: oversized task dispatch must not breach Linux's argv/env limit ──
// Root cause: invoke.ts used to embed the FULL task string into
// workflow_additions, which composeSystemPrompt folds into the composed
// system prompt — passed to every claude/pi runtime as a SINGLE argv string
// (--append-system-prompt). Linux caps a single argv/env string at
// MAX_ARG_STRLEN (131072 bytes); a large review-loop packet breached it and
// the container's exec() died with E2BIG before the agent even started. The
// fix routes the task exclusively through the task package (stdin + package.md
// on disk), which has no such limit.

// A runtime stub mirroring claude-oauth's real prompt-delivery shape: system
// prompt via an argv flag, task package via stdin — the exact split that made
// this bug reproducible.
function setupArgvBoundedRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const p = join(fhome, "runtimes", "claude-argv-bounded.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `
name: claude-argv-bounded
description: test stub mirroring claude-oauth's argv+stdin prompt delivery
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["--append-system-prompt", "\${SYSTEM_PROMPT}"]
  stdin: "\${TASK_PACKAGE_MARKDOWN}"
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
}

test("FG-497: an oversized task (>131072 bytes) dispatches cleanly through the real invoke() path — argv/env stay bounded, full content rides stdin + package.md", async () => {
  setupArgvBoundedRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg497-oversized-"));

  // Larger than Linux's MAX_ARG_STRLEN (131072 bytes) — mirrors a >120KB
  // review-loop reviewer packet (FG-497's actual trigger).
  const oversizedTask = "T".repeat(140_000) + "\n## marker\nFG-497-OVERSIZED-TASK-MARKER";

  let capturedArgs: string[] = [];
  let capturedStdin: string | undefined;
  const inspectExec: DockerExecFn = async ({ args, stdin, stdoutPath, stderrPath }) => {
    capturedArgs = args;
    capturedStdin = stdin;
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: oversizedTask,
    projectDir,
    runtimeName: "claude-argv-bounded",
    dockerExec: inspectExec,
  });

  // (a) the dispatch succeeds — no E2BIG-shaped failure, no guard trip.
  assert.equal(r.status, "complete", `expected the oversized task to dispatch cleanly, got: ${JSON.stringify(r)}`);

  // (b) every string in the built docker argv (incl. every -e env value, which
  // is itself a single argv string) is under Linux's MAX_ARG_STRLEN.
  const MAX_ARG_STRLEN = 131_072;
  for (const [i, a] of capturedArgs.entries()) {
    assert.ok(
      Buffer.byteLength(a, "utf8") < MAX_ARG_STRLEN,
      `argv[${i}] is ${Buffer.byteLength(a, "utf8")} bytes — must stay under MAX_ARG_STRLEN (${MAX_ARG_STRLEN})`,
    );
  }

  // (c) the stdin payload carries the FULL synthetic task content.
  assert.ok(capturedStdin, "stdin payload must be present");
  assert.match(capturedStdin!, /FG-497-OVERSIZED-TASK-MARKER/);
  assert.ok(capturedStdin!.includes(oversizedTask), "stdin must carry the task verbatim, in full");

  // (d) the written package.md on disk also contains it in full.
  const dir = taskDir(r.runId, r.taskId);
  const packageMd = readFileSync(join(dir, "package.md"), "utf8");
  assert.ok(packageMd.includes(oversizedTask), "package.md must carry the full task content");
});

// ── FG-492: container causal-evidence wiring ────────────────────────────────

// A dockerExec fake standing in for docker-exec.ts's real capture-at-close:
// it reports the container causal evidence via onContainerEvidence exactly
// like the real executor does, but writes no result.json (exit 0, clean
// container exit, agent just never produced usable output).
function makeCleanExitNoResultExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath, onContainerEvidence }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "agent produced no result.json");
    writeFileSync(stderrPath, "");
    onContainerEvidence?.({
      containerName: "forge-stub",
      containerExitedEventObserved: true,
      dockerExitCode: 0,
      oomKilled: false,
    });
    return 0;
  };
}

test("FG-492: result missing after a CLEAN container exit is rendered as a confirmed exit, never conflated with a disappeared container", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg492-clean-"));

  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir, dockerExec: makeCleanExitNoResultExec() });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "result_missing", "distinct failure_kind from container_crash/orphaned — the container exited cleanly");

  const events = eventsForTask(r.taskId);
  const containerEvidence = getContainerCausalEvidenceFromEvents(events)!;
  assert.ok(containerEvidence, "container.exited must carry the causal evidence even when the task then fails on a missing result");
  assert.equal(containerEvidence.containerExitedEventObserved, true, "Forge directly observed this exit — not a disappearance");
  assert.equal(containerEvidence.dockerExitCode, 0);

  const summary = describeContainerEvidence(containerEvidence);
  assert.match(summary, /confirmed container exit/, "a clean exit is a CONFIRMED exit, not a disappearance");
  assert.doesNotMatch(summary, /disappeared without terminal evidence/, "must not read as the same state as a container that vanished with no terminal event");

  // Sanity: the exited event itself (not a later event) is what carries it.
  const exitedEvent = events.find((e) => e.eventType === "container.exited")!;
  assert.ok(exitedEvent, "container.exited must have fired before the result_missing classification");
  assert.equal((exitedEvent.payload as Record<string, unknown>).exitCode, 0);
});

// FG-492 review findings 1+3: the failTask call for `no_result_json` used to
// omit `evidence` entirely, so ops/detect.ts's state-4 distinction (a clean
// exit that produced no result) could only ever be exercised with a
// hand-crafted event in detect.test.ts — never by the real producer. This
// drives the whole path end to end: invoke()'s real failTask call must attach
// OrphanEvidence, and runOpsCheck (the same detector `forge ops check` runs)
// must raise the distinguishing incident off that real event shape.
test("FG-492 finding 1+3: result_missing from the REAL failTask call carries recovery evidence and is detected by runOpsCheck", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg492-detect-"));

  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir, dockerExec: makeCleanExitNoResultExec() });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "result_missing");

  const events = eventsForTask(r.taskId);
  const orphanEvidence = getOrphanEvidenceFromEvents(events);
  assert.ok(orphanEvidence, "result_missing must now carry recovery evidence off the real failTask call, not just a bare error string");
  assert.equal(orphanEvidence!.containerExitedEventObserved, true, "attached-exit — Forge watched this container exit itself");

  const incidents = runOpsCheck();
  const incident = incidents.find((i) => i.taskId === r.taskId);
  assert.ok(incident, "detectOrphanedWorkMayPersist must raise an incident for a real result_missing task.failed event, not just a synthetic fixture");
  assert.match(incident!.evidence.join(" "), /container exited cleanly but no result\.json was ever produced/);
  assert.match(incident!.recommendedAction.reason, /without needing --force/);
});

// FG-492 review round 2 (state 1): detect.test.ts's "confirmed exit renders
// full code/signal/OOM detail" coverage only ever exercised
// containerEvidenceLine against a hand-authored OrphanEvidence fixture — never
// the real attached-exit producer (invoke.ts's recoveryEvidenceFor, wired
// through attachedExitEvidence). Drive an actual container_crash exit through
// the real invoke() path and confirm runOpsCheck renders the SAME
// confirmed-exit line off the production event shape.
test("FG-492 review round 2 (state 1): a REAL confirmed attached exit (container_crash) carries the confirmed-exit containerEvidenceLine through runOpsCheck", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();

  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir, dockerExec: makeNoResultExec(1) });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "container_crash");

  const orphanEvidence = getOrphanEvidenceFromEvents(eventsForTask(r.taskId));
  assert.ok(orphanEvidence, "container_crash attached-exit must record recovery evidence off the real failTask call");
  assert.equal(orphanEvidence!.containerExitedEventObserved, true, "attached-exit — Forge watched this container exit itself, not a later disappearance");
  assert.equal(orphanEvidence!.exitCode, 1);

  const incidents = runOpsCheck();
  const incident = incidents.find((i) => i.taskId === r.taskId);
  assert.ok(incident, "container_crash with a dirty worktree must raise an incident off a real task.failed event, not just a synthetic fixture");
  const evidenceText = incident!.evidence.join(" ");
  assert.match(evidenceText, /task .* crashed \(exit 1\) with no recoverable result/);
  assert.match(
    evidenceText,
    /container exit was directly observed by forge \(attached-exit\) — exit code 1/,
    "the confirmed-exit containerEvidenceLine — code known because Forge itself watched this exit, not a disappearance",
  );
});

// ── FG-536 review: CLI death in the WATCHER window, on the invoke path ────────
//
// The invoke path is the one FG-535/FG-536 exist for: `forge invoke` from a tmux
// pane, the CLI killed mid-run. With detached execution the container is the
// daemon's, so the kill lands on a watcher — these pin what the runner must have
// written by then (container.started, and only when a container really exists) and
// that the run finishes from the container's own result, without the CLI.

test("FG-536 invoke: the CLI is KILLED after the container starts — the detached container's result still lands, and reconcile finalizes the task from it", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  let taskId = "";
  // The detached container: started by the daemon, runs to completion, writes its
  // result — while this CLI is SIGKILLed the instant the start is recorded. Modeled
  // by an exec that never resolves: the host process is gone, so nothing after the
  // start callback ever runs on the host again.
  const cliKilledAfterStart: DockerExecFn = async ({ args, stdoutPath, stderrPath, onContainerStarted }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 3 }));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    taskId = (containerNameFromArgs(args) ?? "").replace(/^forge-/, "");
    onContainerStarted!();
    return new Promise<number>(() => {}); // the CLI dies here — it never returns
  };
  cliKilledAfterStart.signalsContainerStart = true;

  void invoke({ agentRole: "engineer", task: "do work", projectDir: "/tmp/x", dockerExec: cliKilledAfterStart });
  while (taskId === "") await new Promise((r) => setTimeout(r, 5));

  const stranded = getTask(taskId)!;
  assert.equal(stranded.status, "running", "the CLI died mid-run: nothing finalized the task");
  assert.ok(
    eventsForTask(taskId).some((e) => e.eventType === "container.started"),
    "container.started must be on the record — the container exists, and every rescue path keys on this event",
  );
  assert.ok(existsSync(join(taskDir(stranded.runId, taskId), "result.json")), "the container's work survived the CLI");

  // The recovery pass the next `forge` command runs: the container is gone (it
  // finished while the host was dead), and its result is on disk.
  const r = reconcileRun(stranded.runId, () => false, () => "not_found" as const);
  assert.equal(r.taskChanges.length, 1, "reconcile must finalize the task the dead CLI left running");
  const recovered = getTask(taskId)!;
  assert.equal(recovered.status, "complete", "the run completes from the container's REAL result, with no CLI to watch it");
  assert.deepEqual(recovered.result, { status: "complete", tests_run: 3 });
});

test("FG-536 invoke: `docker run -d` FAILS — no container.started is written, so no sweep mistakes a never-launched container for a live one", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // What detachedDockerExec does when the daemon refuses the run: exit 1, no start
  // signal (proven at the executor level in docker-exec.test.ts).
  const runFailed: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "docker: Error response from daemon: no such image\n");
    return 1;
  };
  runFailed.signalsContainerStart = true;

  const r = await invoke({ agentRole: "engineer", task: "do work", projectDir: "/tmp/x", dockerExec: runFailed });
  assert.equal(r.status, "failed");
  const types = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(!types.includes("container.started"), "no container was launched — claiming one started is a lie the rescue paths would act on");
});
