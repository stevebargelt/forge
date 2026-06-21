// runNext integration test — stubs the docker exec so we can drive the runner
// end-to-end without real containers. Validates:
//   - Ready-queue → dispatch → result → status transitions
//   - Parallel-within-wave: multiple ready steps spawn concurrently
//   - Gate handling: gate: auto → complete, gate: human → awaiting_gate
//   - Run completes when all steps done
//   - manual: true creates a pending task without spawn

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, resolveChildAgent, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { eventsForTask, eventsForRun } from "../store/events.js";
import { verdictsForTask } from "../store/verdicts.js";
import { failureKindForTask } from "./failure-kind.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { taskDir } from "../util/paths.js";
import type { Workflow, Step, FanoutDef } from "./schema.js";
import type { TaskManifest } from "./task-manifest.js";

// Stub docker exec that writes a fixed result.json and returns 0. The runner's
// container.stdout/stderr.log paths must be writable from this exec, so create
// the parent dir as a side effect.
function makeStubExec(resultJson: unknown, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    // result.json lives in the task dir; we don't know it here directly, but
    // the runner has already created it (empty) and writes status based on
    // what's in result.json at read time. The stub writes result.json next
    // to the stdout/stderr logs (same dir).
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(resultJson));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// Synthesize a minimal claude runtime YAML so loadRuntime() succeeds in tests.
function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `name: claude
description: test stub runtime
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

const LINEAR_WORKFLOW: Workflow = {
  name: "test-linear",
  description: "two-step linear test",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "first", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "second", agent: "test-agent", gate: "auto", manual: false, depends_on: ["first"], runtime: "claude", reds: [] },
  ],
};

const PARALLEL_WORKFLOW: Workflow = {
  name: "test-parallel",
  description: "diamond fanout test",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "root", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "test-agent", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "test-agent", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "merge", agent: "test-agent", gate: "auto", manual: false, depends_on: ["left", "right"], runtime: "claude", reds: [] },
  ],
};

const HUMAN_GATE_WORKFLOW: Workflow = {
  name: "test-human-gate",
  description: "step with gate: human pauses",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "needs-review", agent: "test-agent", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ],
};

const MANUAL_WORKFLOW: Workflow = {
  name: "test-manual",
  description: "manual step doesn't dispatch a container",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "human-work", manual: true, gate: "human", depends_on: [], runtime: "claude", reds: [] },
  ],
};

test("runNext: linear workflow dispatches first step → completes → next wave dispatches second", async () => {
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "linear test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Need a runtime YAML accessible. We don't actually spawn containers (stub),
  // but the runner does call loadRuntime() before invoking the exec stub.
  // Skip the test if no runtime YAML exists in FORGE_HOME/runtimes/.
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    // Synthesize a minimal runtime YAML so loadRuntime succeeds.
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `
name: claude
description: test stub runtime
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
  // apikey auth needs ANTHROPIC_API_KEY; set a fake one for the stub.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  try {
    const stub = makeStubExec({ status: "complete", output: "first-result" });

    // Wave 1: dispatch 'first'
    const wave1 = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: stub });
    assert.deepEqual(wave1.dispatchedSteps, ["first"]);
    assert.deepEqual(wave1.completedSteps, ["first"]);
    assert.deepEqual(wave1.failedSteps, []);
    assert.equal(wave1.runStatus, "active");

    // Wave 2: dispatch 'second'
    const wave2 = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: stub });
    assert.deepEqual(wave2.dispatchedSteps, ["second"]);
    assert.deepEqual(wave2.completedSteps, ["second"]);
    assert.equal(wave2.runStatus, "complete");

    // Run should be complete
    const run = getRun(runId);
    assert.equal(run!.status, "complete");

    // Two tasks total, both complete
    const tasks = tasksForRun(runId);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.status === "complete"));
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext: gate: human transitions to awaiting_gate, doesn't auto-complete run", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "human gate test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });
  const wave = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });

  assert.deepEqual(wave.dispatchedSteps, ["needs-review"]);
  assert.deepEqual(wave.awaitingGate, ["needs-review"]);
  assert.deepEqual(wave.completedSteps, []);
  assert.equal(wave.runStatus, "active");

  const tasks = tasksForRun(runId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.status, "awaiting_gate");

  // Run is still active — human needs to gate-advance
  const run = getRun(runId);
  assert.equal(run!.status, "active");
});

test("runNext: manual step creates a pending task without invoking dockerExec", async () => {
  const { runId } = startRun({
    workflow: MANUAL_WORKFLOW,
    title: "manual test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Stub that throws if called — manual steps shouldn't invoke it.
  const failingExec: DockerExecFn = async () => {
    throw new Error("manual step should not invoke docker exec");
  };

  const wave = await runNext({ runId, workflow: MANUAL_WORKFLOW, dockerExec: failingExec });
  assert.deepEqual(wave.dispatchedSteps, ["human-work"]);

  const tasks = tasksForRun(runId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.status, "pending");
  assert.equal(tasks[0]!.agentRole, "manual");
});

test("runNext: parallel-within-wave — diamond fanout dispatches left+right together", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: PARALLEL_WORKFLOW,
    title: "diamond test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });

  // Wave 1: root only
  const wave1 = await runNext({ runId, workflow: PARALLEL_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave1.dispatchedSteps, ["root"]);

  // Wave 2: left + right in parallel
  const wave2 = await runNext({ runId, workflow: PARALLEL_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave2.dispatchedSteps.sort(), ["left", "right"]);
  assert.deepEqual(wave2.completedSteps.sort(), ["left", "right"]);

  // Wave 3: merge
  const wave3 = await runNext({ runId, workflow: PARALLEL_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave3.dispatchedSteps, ["merge"]);
  assert.equal(wave3.runStatus, "complete");

  const tasks = tasksForRun(runId);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every((t) => t.status === "complete"));
});

test("runNext: empty ready queue returns no dispatched steps (run still active)", async () => {
  // Run with a human-gated first step that already hit awaiting_gate; next
  // runNext call should be a no-op (nothing ready until human advances).
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "noop test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });
  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });
  // Second call — first step is awaiting_gate; no ready work.
  const wave = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave.dispatchedSteps, []);
  assert.equal(wave.runStatus, "active");
});

test("runNext: failed step (container exit nonzero + empty result.json) marks task failed", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "fail test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Stub that returns 1 and writes empty result.json (simulating a crash).
  const crashingExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), ""); // empty
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "container crashed");
    return 1;
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: crashingExec });
  assert.deepEqual(wave.failedSteps, ["first"]);
  assert.deepEqual(wave.completedSteps, []);

  const tasks = tasksForRun(runId);
  const first = tasks.find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(first!.status, "failed");
});

test("runNext: idle-timeout exit code marks the pipeline task failed with idle_timeout", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "idle test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Mimic the watchdog SIGKILLing a hung agent: empty result.json, exit 124.
  const idleKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: idleKilled });
  assert.deepEqual(wave.failedSteps, ["first"]);

  const first = tasksForRun(runId).find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(first!.status, "failed");
  assert.match(first!.error ?? "", /idle_timeout/);
});

// Finding 1: runNext guard — non-active run returns empty dispatch
test("runNext: abandoned run returns empty dispatch without starting any work", async () => {
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "abandoned guard test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Manually mark the run abandoned (as forge cancel would do).
  updateRunStatus(runId, "abandoned");

  const throwingExec: DockerExecFn = async () => {
    throw new Error("runNext dispatched a step on a non-active run");
  };

  const result = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: throwingExec });
  assert.deepEqual(result.dispatchedSteps, []);
  assert.deepEqual(result.completedSteps, []);
  assert.deepEqual(result.awaitingGate, []);
  assert.deepEqual(result.failedSteps, []);
  assert.equal(result.runStatus, "abandoned");
});

test("runNext: complete run returns empty dispatch without starting any work", async () => {
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "complete guard test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  updateRunStatus(runId, "complete");

  const throwingExec: DockerExecFn = async () => {
    throw new Error("runNext dispatched a step on a non-active run");
  };

  const result = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: throwingExec });
  assert.deepEqual(result.dispatchedSteps, []);
  assert.equal(result.runStatus, "complete");
});

// ---------------------------------------------------------------------------
// Reds + fanout
// ---------------------------------------------------------------------------

// Route docker exec by the agent role embedded in the runtime's --name arg.
// The runtime stub uses container.name = "forge-${TASK_ID}" and TASK_ID
// starts with phase or `red-<phase>` (see newTaskId). We sniff the args
// for the container name and route to the right canned result.
function makeRoutingExec(rules: Array<{ matches: (taskId: string) => boolean; result: unknown; exitCode?: number }>): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "";
    // strip "forge-" prefix to get the task id
    const taskId = fullName.replace(/^forge-/, "");
    const rule = rules.find((r) => r.matches(taskId));
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (rule) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(rule.result));
      writeFileSync(stdoutPath, "stub stdout");
      writeFileSync(stderrPath, "");
      return rule.exitCode ?? 0;
    }
    // Default: complete with empty output. Surfaces test misconfiguration.
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "stub stdout (default)");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

const REDS_AUTH_ALL_PASS_WORKFLOW: Workflow = {
  name: "test-reds-pass",
  description: "primary + 2 authoritative reds, all pass → gate: verdict → awaiting_gate",
  inputs: [],
  steps: [
    {
      id: "review",
      agent: "primary-agent",
      gate: "verdict",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
    },
  ],
};

const REDS_AUTH_FAIL_WORKFLOW: Workflow = {
  name: "test-reds-fail",
  description: "primary + 2 authoritative reds, one fails → blocked_by_red",
  inputs: [],
  steps: [
    {
      id: "review",
      agent: "primary-agent",
      gate: "verdict",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
    },
  ],
};

const REDS_SPECIALIST_FAIL_WORKFLOW: Workflow = {
  name: "test-reds-spec-fail",
  description: "specialist red fails — should NOT block (advisory only)",
  inputs: [],
  steps: [
    {
      id: "review",
      agent: "primary-agent",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [
        { agent: "red-frontend", authority: "specialist", gate_on_verdict: true },
      ],
    },
  ],
};

test("runNext: reds — all authoritative reds pass → primary moves to awaiting_gate (verdict), verdicts recorded", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: REDS_AUTH_ALL_PASS_WORKFLOW,
    title: "reds pass",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-review-"),
      result: { status: "complete", artifact: "the thing" },
    },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] },
    },
  ]);

  const wave = await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  assert.deepEqual(wave.dispatchedSteps, ["review"]);
  assert.deepEqual(wave.awaitingGate, ["review"]);
  assert.deepEqual(wave.completedSteps, []);
  assert.deepEqual(wave.failedSteps, []);

  const tasks = tasksForRun(runId);
  // 1 primary + 2 reds
  assert.equal(tasks.length, 3);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  assert.equal(primary.status, "awaiting_gate");
  const redTasks = tasks.filter((t) => t.parentId === primary.id);
  assert.equal(redTasks.length, 2);
  assert.ok(redTasks.every((t) => t.status === "complete"));

  // Verdicts persisted
  const verdicts = verdictsForTask(primary.id);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((v) => v.verdict === "pass"));
});

// AWN-7: a run-level model profile (`forge new --profile`, stored as
// metadata.modelProfile) must pin EVERY task in the run — primary and red —
// at the highest profile-selection precedence, beating both agent overrides
// and activity defaults, and recording resolvedBy="run.profile". Writes a
// throwaway policy + claude-apikey runtime into FORGE_HOME and removes them in
// finally so the legacy-mode tests sharing this process aren't affected.
test("runNext: run-level --profile (metadata.modelProfile) pins primary AND red, beating agent overrides", async () => {
  const policyPath = join(process.env.FORGE_HOME!, "model-policy.yml");
  const apikeyRuntimePath = join(process.env.FORGE_HOME!, "runtimes", "claude-apikey.yml");
  process.env.ANTHROPIC_API_KEY = "sk-stub"; // makes auth:api available (probeAuth)

  // default-api is what defaults/overrides would select; pinned-api is the
  // run override. red-wide has an explicit agent override to default-api so the
  // assertion proves run.profile beats overrides.agents, not just the default.
  writeFileSync(policyPath, `
on_unavailable: fail
model_profiles:
  default-api:
    provider: anthropic
    auth: api
    map:
      review:  { model: model-default-review, cost_tier: standard }
      default: { model: model-default,        cost_tier: standard }
  pinned-api:
    provider: anthropic
    auth: api
    map:
      review:  { model: model-pinned-review, cost_tier: premium }
      default: { model: model-pinned,        cost_tier: premium }
defaults:
  profile: default-api
  activity:
    review: default-api
overrides:
  agents:
    red-wide: default-api
allowed_profiles: [default-api, pinned-api]
`);
  if (!existsSync(apikeyRuntimePath)) {
    mkdirSync(dirname(apikeyRuntimePath), { recursive: true });
    writeFileSync(apikeyRuntimePath, `name: claude-apikey
description: test stub apikey runtime
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

  try {
    const { runId } = startRun({
      workflow: REDS_AUTH_ALL_PASS_WORKFLOW,
      title: "run profile pin",
      inputs: {},
      projectDir: "/tmp/test-project",
      modelProfile: "pinned-api",
    });

    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
      { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    ]);

    await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

    const tasks = tasksForRun(runId);
    const primary = tasks.find((t) => t.parentId === undefined)!;
    const reds = tasks.filter((t) => t.parentId === primary.id);
    assert.equal(reds.length, 2);

    // Primary: capability "default" → pinned-api's default model, via run.profile.
    assert.equal(primary.resolvedProfile, "pinned-api");
    assert.equal(primary.resolvedBy, "run.profile");
    assert.equal(primary.agentModel, "model-pinned");

    // The pin is control-plane — it must NOT leak into the task inputs/prompt.
    assert.ok(!("modelProfile" in primary.taskPackage.inputs), "modelProfile must not ride into primary task inputs");

    // Both reds: capability "review" → pinned-api's review model, via run.profile —
    // overriding red-wide's explicit agent override (default-api) too.
    for (const red of reds) {
      assert.equal(red.resolvedProfile, "pinned-api");
      assert.equal(red.resolvedBy, "run.profile");
      assert.equal(red.agentModel, "model-pinned-review");
    }
  } finally {
    rmSync(policyPath, { force: true });
  }
});

test("runNext: AWN-5 grading is ENFORCED on verdict ingestion — malformed rejected, weak downgraded (finding)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "grade", inputs: {}, projectDir: "/tmp/test-project" });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      result: {
        status: "complete", verdict: "fail", confidence: 0.9,
        findings: [
          { summary: "", severity: "high", evidence: "", hypothesis: "" },                                    // malformed → rejected
          { summary: "weak unverified claim", severity: "high", evidence: "", hypothesis: "", confidence: 0.3 }, // unsupported+confident → downgraded
        ],
      },
    },
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  const verdicts = verdictsForTask(primary.id);
  assert.ok(verdicts.length >= 1);
  const findings = verdicts[0]!.findings;
  assert.equal(findings.length, 1, "the malformed (no-summary) finding is rejected at ingestion");
  assert.equal(findings[0]!.severity, "medium", "the weak unsupported high-severity finding is downgraded to medium");
});

test("runNext: an authoritative fail whose findings are ALL malformed does NOT block — grading downgrades it to inconclusive (finding)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "grade-gate", inputs: {}, projectDir: "/tmp/test-project" });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      // an authoritative FAIL, but its only finding is malformed (no summary)
      result: { status: "complete", verdict: "fail", confidence: 0.9, findings: [{ summary: "", severity: "high", evidence: "", hypothesis: "" }] },
    },
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  assert.notEqual(primary.status, "blocked_by_red", "an all-malformed fail must NOT block the gate");
  assert.equal(primary.status, "awaiting_gate", "downgraded → no authoritative block → normal verdict gate");
  const verdicts = verdictsForTask(primary.id);
  assert.ok(verdicts.every((v) => v.verdict === "inconclusive"), "fail with all-malformed findings is downgraded to inconclusive");
});

test("runNext: an authoritative fail with NO findings at all does NOT block — unsubstantiated → inconclusive (finding)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "empty-fail", inputs: {}, projectDir: "/tmp/test-project" });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
    { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "fail", confidence: 0.9, findings: [] } }, // fail, zero findings
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  assert.notEqual(primary.status, "blocked_by_red", "an unsubstantiated fail (no findings) must NOT block");
  assert.equal(primary.status, "awaiting_gate");
  const verdicts = verdictsForTask(primary.id);
  assert.ok(verdicts.every((v) => v.verdict === "inconclusive"), "fail with no findings downgraded to inconclusive");
});

test("runNext: reds — authoritative fail blocks the primary (blocked_by_red)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: REDS_AUTH_FAIL_WORKFLOW,
    title: "reds fail",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  let redSeq = 0;
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-review-"),
      result: { status: "complete", artifact: "the thing" },
    },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      // First red passes, second fails. Order isn't strictly deterministic
      // because they run in parallel, but the routing closure captures the
      // sequence — the test cares that at least one red fail produces blocked_by_red.
      result: undefined as never, // overwritten below
    },
  ]);
  // Custom exec: alternate pass / fail for reds.
  const customExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "";
    const taskId = fullName.replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (taskId.startsWith("task-review-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", artifact: "x" }));
    } else if (taskId.startsWith("task-red-review-")) {
      // First red passes, second fails.
      const result = redSeq === 0
        ? { status: "complete", verdict: "pass", confidence: 0.9, findings: [] }
        : { status: "complete", verdict: "fail", confidence: 0.9, findings: [{ severity: "high", summary: "boom", evidence: "logs", hypothesis: "bug" }] };
      redSeq++;
      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    } else {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    }
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  // Suppress lint about unused exec.
  void exec;

  const wave = await runNext({ runId, workflow: REDS_AUTH_FAIL_WORKFLOW, dockerExec: customExec });

  assert.deepEqual(wave.awaitingGate, ["review"]); // awaitingGate bucket includes blocked_by_red
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  assert.equal(primary.status, "blocked_by_red");

  const verdicts = verdictsForTask(primary.id);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.some((v) => v.verdict === "fail"));
});

test("runNext: reds — specialist fail does NOT block (advisory), primary proceeds to complete", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: REDS_SPECIALIST_FAIL_WORKFLOW,
    title: "specialist red fail",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-review-"),
      result: { status: "complete", artifact: "x" },
    },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      // A SUBSTANTIATED fail (real finding) so it stays 'fail' through grading —
      // the point is that a specialist fail is advisory and doesn't block.
      result: { status: "complete", verdict: "fail", confidence: 0.8, findings: [{ severity: "high", summary: "real issue", evidence: "observed in logs", hypothesis: "bug" }] },
    },
  ]);

  const wave = await runNext({ runId, workflow: REDS_SPECIALIST_FAIL_WORKFLOW, dockerExec: exec });

  assert.deepEqual(wave.completedSteps, ["review"]);
  assert.deepEqual(wave.awaitingGate, []);

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  // gate: auto + only specialist verdict-fail → primary completes (advisory only)
  assert.equal(primary.status, "complete");

  const verdicts = verdictsForTask(primary.id);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.verdict, "fail", "a substantiated specialist fail stays fail (advisory, not blocking)");
  assert.equal(verdicts[0]!.authority, "specialist");
});

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

const FANOUT_WORKFLOW: Workflow = {
  name: "test-fanout",
  description: "research step fans out per claim from upstream",
  inputs: [],
  steps: [
    {
      id: "plan",
      agent: "planner-agent",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
    {
      id: "research",
      agent: "research-agent",
      gate: "auto",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [],
      fanout: {
        from_upstream: { step: "plan", array_key: "claims", input_key: "claim" },
        max_concurrency: 2,
        failure_mode: "fail-phase",
      },
    },
  ],
};

test("runNext: fanout — plan returns N claims, research spawns N children, parent aggregates", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fanout test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const claims = ["claim-a", "claim-b", "claim-c"];
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-plan-"),
      result: { status: "complete", claims },
    },
    {
      matches: (id) => id.startsWith("task-research-"),
      result: { status: "complete", evidence: "found stuff" },
    },
  ]);

  // Wave 1: plan
  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave1.dispatchedSteps, ["plan"]);
  assert.deepEqual(wave1.completedSteps, ["plan"]);

  // Wave 2: research (fanout)
  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave2.dispatchedSteps, ["research"]);
  assert.deepEqual(wave2.completedSteps, ["research"]);

  const tasks = tasksForRun(runId);
  // plan (1 primary) + research parent (1) + 3 children = 5
  assert.equal(tasks.length, 5);

  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.equal(researchParent.status, "complete");

  const children = tasks.filter((t) => t.phase === "research" && t.parentId === researchParent.id);
  assert.equal(children.length, 3);
  assert.ok(children.every((c) => c.status === "complete"));

  // Parent result aggregates children
  const parentResult = researchParent.result as { children: Array<{ index: number; status: string }> };
  assert.equal(parentResult.children.length, 3);
  assert.ok(parentResult.children.every((c) => c.status === "complete"));

  const wave3 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave3.dispatchedSteps, []);
  assert.equal(wave3.runStatus, "complete");
});

// AWN-7 leak guard: a run-level --profile (metadata.modelProfile) pours through
// run metadata into fanout child inputs unless stripped. The leak is independent
// of policy mode — modelProfile is in metadata regardless — so this runs in
// legacy mode (no model-policy.yml) and asserts the child task packages are
// clean of every control-plane key.
test("runNext: fanout — control-plane metadata (modelProfile/workspace) is stripped from child task inputs", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fanout leak guard",
    inputs: {},
    projectDir: "/tmp/test-project",
    workspace: "/tmp/test-workspace",
    modelProfile: "some-profile",
  });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", claims: ["a", "b"] } },
    { matches: (id) => id.startsWith("task-research-"), result: { status: "complete", evidence: "x" } },
  ]);

  await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // plan
  await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // research fanout

  const tasks = tasksForRun(runId);
  const parent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  const children = tasks.filter((t) => t.phase === "research" && t.parentId === parent.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.ok(!("modelProfile" in child.taskPackage.inputs), "modelProfile must not leak into fanout child inputs");
    assert.ok(!("workspace" in child.taskPackage.inputs), "workspace must not leak into fanout child inputs");
    // the real per-child input is still present
    assert.ok(["a", "b"].includes(child.taskPackage.inputs["claim"] as string), "the fanout claim input survives the strip");
  }
  assert.deepEqual(
    children.map((c) => c.taskPackage.inputs["claim"]).sort(),
    ["a", "b"],
    "both claims dispatched exactly once",
  );
});

test("runNext: fanout — failure_mode=fail-phase short-circuits and parent fails", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf: Workflow = {
    ...FANOUT_WORKFLOW,
    name: "test-fanout-failphase",
  };

  const { runId } = startRun({
    workflow: wf,
    title: "fanout fail-phase",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  // Custom exec: plan returns 4 claims; first research child fails (exit 1, empty result.json).
  let researchCount = 0;
  const customExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "";
    const taskId = fullName.replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (taskId.startsWith("task-plan-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", claims: ["a", "b", "c", "d"] }));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    }
    // research child
    researchCount++;
    if (researchCount === 1) {
      // crash
      writeFileSync(join(dir, "result.json"), "");
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "boom");
      return 1;
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  await runNext({ runId, workflow: wf, dockerExec: customExec });
  await runNext({ runId, workflow: wf, dockerExec: customExec });

  const tasks = tasksForRun(runId);
  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.equal(researchParent.status, "failed");

  const children = tasks.filter((t) => t.phase === "research" && t.parentId === researchParent.id);
  // fail-phase short-circuits after the first batch. max_concurrency=2 means
  // 2 children launched in batch 1; the failing one stops further dispatch.
  // So we expect 2 children total, not 4.
  assert.equal(children.length, 2);
});

test("runNext: fanout — missing array_key on upstream marks parent failed", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf: Workflow = {
    ...FANOUT_WORKFLOW,
    name: "test-fanout-noarr",
  };
  const { runId } = startRun({
    workflow: wf,
    title: "fanout missing key",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  // plan returns no claims array
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-plan-"),
      result: { status: "complete", other: "field" },
    },
  ]);

  await runNext({ runId, workflow: wf, dockerExec: exec });
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.equal(researchParent.status, "failed");
  assert.match(researchParent.error ?? "", /no array/);
  // Defensive fanout failure must still go through normal lifecycle bookkeeping:
  // completedAt is set (markTaskFailed), and the timeline brackets created→failed.
  assert.ok(researchParent.completedAt, "defensively-failed fanout parent must have completedAt set");
  const types = eventsForTask(researchParent.id).map((e) => e.eventType);
  assert.ok(types.includes("task.created"), "fanout parent must emit task.created even on defensive failure");
  assert.ok(types.includes("task.failed"), "fanout parent must emit task.failed");
  assert.ok(
    types.indexOf("task.created") < types.indexOf("task.failed"),
    "task.created must precede task.failed",
  );
  // failure_kind comes from the classifier (via failTask), not a hardcoded string.
  const failedEv = eventsForTask(researchParent.id).find((e) => e.eventType === "task.failed")!;
  assert.equal(typeof (failedEv.payload as Record<string, unknown>).failure_kind, "string");
});

// ------------------------------------------------------------------
// resolveChildAgent (#139) — pure function unit tests
// ------------------------------------------------------------------

const _step: Step = {
  id: "build",
  agent: "engineer",
  runtime: "claude",
  depends_on: [],
  gate: "human",
  manual: false,
  reds: [],
};

function fanoutWith(over: Partial<FanoutDef>): FanoutDef {
  return {
    from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
    failure_mode: "fail-phase",
    ...over,
  };
}

test("resolveChildAgent: returns mapped agent when discipline matches", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist", backend: "backend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "frontend" }), "frontend-specialist");
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "backend" }), "backend-specialist");
});

test("resolveChildAgent: falls back to step.agent when discipline not in map", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "general" }), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "unknown" }), "engineer");
});

test("resolveChildAgent: falls back to step.agent when discipline key missing on input", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, { id: "1", summary: "x" }), "engineer");
});

test("resolveChildAgent: falls back to step.agent when input is not an object", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, "frontend"), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, 42), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, null), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, ["frontend"]), "engineer");
});

test("resolveChildAgent: respects custom discipline_key (not default 'discipline')", () => {
  const fanout = fanoutWith({
    agent_map: { fe: "frontend-specialist" },
    discipline_key: "track",
  });
  assert.equal(resolveChildAgent(_step, fanout, { track: "fe" }), "frontend-specialist");
  // The default key 'discipline' should NOT be consulted when discipline_key is set.
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "fe" }), "engineer");
});

test("resolveChildAgent: returns step.agent when agent_map is undefined (backwards compat)", () => {
  const fanout = fanoutWith({});
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "frontend" }), "engineer");
});

// ---------------------------------------------------------------------------
// #194: lifecycle event backfill — task.awaiting_gate, container.*
// ---------------------------------------------------------------------------

function ensureClaudeRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `
name: claude
description: test stub runtime
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
}

test("runNext: gate: human emits task.awaiting_gate with runId and taskId", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "awaiting_gate event test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "needs-review" && t.parentId === undefined)!;
  assert.equal(primary.status, "awaiting_gate");

  const events = eventsForTask(primary.id);
  const gateEv = events.find((e) => e.eventType === "task.awaiting_gate");
  assert.ok(gateEv, "must emit task.awaiting_gate when task enters awaiting_gate");
  assert.equal(gateEv!.runId, runId);
  assert.equal(gateEv!.taskId, primary.id);
});

test("runNext: container.started and container.exited emitted on successful step", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-container-events",
    description: "one step for container event test",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "container event test", inputs: {}, projectDir: "/tmp/test-project" });

  await runNext({ runId, workflow: WF, dockerExec: makeStubExec({ status: "complete" }) });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  const events = eventsForTask(primary.id);
  const types = events.map((e) => e.eventType);

  assert.ok(types.includes("container.started"), "must emit container.started");
  assert.ok(types.includes("container.exited"), "must emit container.exited on success");

  const started = events.find((e) => e.eventType === "container.started")!;
  assert.equal((started.payload as Record<string, unknown>).containerName, `forge-${primary.id}`);

  const exited = events.find((e) => e.eventType === "container.exited")!;
  assert.equal((exited.payload as Record<string, unknown>).exitCode, 0);
});

test("runNext: container.idle_timeout emitted (not container.exited) on idle timeout", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-idle-timeout-events",
    description: "one step that idle-timeouts",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "idle timeout event test", inputs: {}, projectDir: "/tmp/test-project" });

  const idleKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  await runNext({ runId, workflow: WF, dockerExec: idleKilled });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  const events = eventsForTask(primary.id);
  const types = events.map((e) => e.eventType);

  assert.ok(types.includes("container.started"), "must emit container.started");
  assert.ok(types.includes("container.idle_timeout"), "must emit container.idle_timeout");
  assert.ok(!types.includes("container.exited"), "must NOT emit container.exited for idle_timeout");

  const idleEv = events.find((e) => e.eventType === "container.idle_timeout")!;
  assert.equal((idleEv.payload as Record<string, unknown>).exitCode, IDLE_TIMEOUT_EXIT_CODE);
});

// ----- #197: manifest.json written on pipeline dispatch -----

test("runNext: writes manifest.json into the task dir on pipeline dispatch", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-manifest-dispatch",
    description: "one step for manifest test",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "manifest test", inputs: {}, projectDir: "/tmp/test-project" });

  await runNext({ runId, workflow: WF, dockerExec: makeStubExec({ status: "complete" }) });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.ok(primary, "primary task must exist");

  const dir = taskDir(runId, primary.id);
  const manifestPath = join(dir, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json must be written in the task dir");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
  assert.equal(manifest.taskId, primary.id);
  assert.equal(manifest.runId, runId);
  assert.equal(manifest.files.prompt, "CLAUDE.md");
  assert.equal(manifest.files.result, "result.json");
  assert.equal(manifest.container.name, `forge-${primary.id}`);
  assert.equal(manifest.auth.profileRequested, false);
  assert.equal(manifest.auth.stateMounted, false);

  // Auth block: booleans only, no credential/path values
  const authKeys = Object.keys(manifest.auth).sort();
  assert.deepEqual(authKeys, ["profileRequested", "stateMounted"]);
  for (const v of Object.values(manifest.auth as Record<string, unknown>)) {
    assert.ok(typeof v !== "string" || !v.includes("/"), `auth value must not be a path: ${String(v)}`);
  }
});

// ─── AWN-3 finding: retry must be the task that actually dispatches ──────────

test("runNext after retry: the RETRIED task is dispatched (not a fresh one) and carries previous_failure", async () => {
  const { retry } = await import("./retry.js");
  const { insertTask } = await import("../store/tasks.js");
  const { logEvent } = await import("../store/events.js");

  ensureRuntime();
  const { runId } = startRun({ workflow: LINEAR_WORKFLOW, title: "retry e2e", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });

  // A failed primary task for the "first" step (as if its first attempt failed).
  insertTask({
    id: "task-first-failed", runId, phase: "first", agentRole: "test-agent", status: "failed",
    error: "no output for 10m",
    taskPackage: { taskId: "task-first-failed", runId, phase: "first", role: "test-agent", inputs: { brief: "x" }, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  });
  logEvent("task.failed", { runId, taskId: "task-first-failed", payload: { failure_kind: "idle_timeout", error: "no output for 10m" } });

  const out = await retry("task-first-failed");
  const retriedId = out.newTask.id;

  await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: makeStubExec({ status: "complete" }) });

  // The retried task itself must have been dispatched (reached a terminal state),
  // NOT a separate fresh primary created alongside it.
  const firstTasks = tasksForRun(runId).filter((t) => t.phase === "first" && t.parentId === undefined);
  const dispatchedRetry = getTask(retriedId)!;
  assert.notEqual(dispatchedRetry.status, "pending", "the retried task must actually be dispatched");
  assert.ok(["running", "complete"].includes(dispatchedRetry.status), `retried task should have run, got ${dispatchedRetry.status}`);
  assert.equal(firstTasks.length, 2, "exactly the failed task + the retried task — no third fresh primary");

  // And the dispatched retry carried the previous-failure context to the agent.
  const pkg = readFileSync(join(taskDir(runId, retriedId), "package.md"), "utf8");
  assert.match(pkg, /previous_failure/, "the retry's package must carry previous_failure context");
  assert.match(pkg, /idle_timeout/, "previous failure kind reaches the agent");
});

test("runNext: a pipeline task cancelled mid-spawn stays failed; no task.completed when the container returns success (AWN-2 task-level)", async () => {
  const { failTask } = await import("./failure-kind.js");
  const { basename } = await import("node:path");
  ensureRuntime();
  const { runId } = startRun({ workflow: LINEAR_WORKFLOW, title: "cancel race e2e", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });

  // Stub: mark the dispatched task failed (cancelled) mid-spawn, then return a
  // successful result — the post-container completion must not overwrite it.
  const cancelMidSpawn: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const taskId = basename(dir);
    failTask(taskId, { runId, kind: "cancelled", error: "cancelled via forge cancel" });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
    return 0;
  };

  await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: cancelMidSpawn });

  const first = tasksForRun(runId).find((t) => t.phase === "first" && t.parentId === undefined)!;
  assert.equal(first.status, "failed", "cancelled pipeline task must not be overwritten to complete");
  const types = eventsForTask(first.id).map((e) => e.eventType);
  assert.ok(types.includes("task.failed"), "task.failed (cancelled) emitted");
  assert.ok(!types.includes("task.completed"), "no task.completed after cancellation");
});

// ---------------------------------------------------------------------------
// forge-site regression: reds aren't fed the artifact, and fanout build reds
// never dispatch. Three independent gaps in the v2 red-feed path.
// ---------------------------------------------------------------------------

const FANOUT_REDS_WORKFLOW: Workflow = {
  name: "test-fanout-reds",
  description: "build fanout with authoritative reds on the parent",
  inputs: [],
  steps: [
    { id: "plan", agent: "planner", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    {
      id: "build",
      agent: "engineer",
      gate: "verdict",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
      fanout: {
        from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
        max_concurrency: 2,
        failure_mode: "fail-phase",
      },
    },
  ],
};

test("runNext: fanout reds — build fanout dispatches authoritative reds on the parent (forge-site Symptom B)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: FANOUT_REDS_WORKFLOW, title: "fanout reds", inputs: {}, projectDir: "/tmp/test-project" });
  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", steps: ["s1", "s2"] } },
    { matches: (id) => id.startsWith("task-red-build-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    { matches: (id) => id.startsWith("task-build-"), result: { status: "complete", diff_summary: "did the thing", files_modified: [] } },
  ]);
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const parent = tasks.find((t) => t.phase === "build" && t.parentId === undefined)!;
  const reds = tasks.filter((t) => t.parentId === parent.id && t.agentRole.startsWith("red-"));
  assert.equal(reds.length, 2, "build fanout must dispatch 2 reds on the parent (was 0 — the bug)");
  assert.ok(reds.every((t) => t.status === "complete"));
  assert.equal(parent.status, "awaiting_gate", "verdict gate + all reds pass → awaiting_gate");
  assert.equal(verdictsForTask(parent.id).length, 2, "verdicts recorded for the fanout parent");
});

test("runNext: fanout reds — an authoritative red fail blocks the fanout parent (forge-site Symptom B)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: FANOUT_REDS_WORKFLOW, title: "fanout reds fail", inputs: {}, projectDir: "/tmp/test-project" });
  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", steps: ["s1"] } },
    { matches: (id) => id.startsWith("task-red-build-"), result: { status: "complete", verdict: "fail", confidence: 0.9, findings: [{ severity: "high", summary: "broken", evidence: "x" }] } },
    { matches: (id) => id.startsWith("task-build-"), result: { status: "complete", diff_summary: "did the thing", files_modified: [] } },
  ]);
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });

  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(parent.status, "blocked_by_red", "an authoritative red fail must block the fanout parent, not silently awaiting_gate");
});

test("runNext: reds receive the artifact in their package (forge-site Symptom A — artifact)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "red artifact", inputs: {}, projectDir: "/tmp/test-project" });
  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "the-reviewed-thing" } },
    { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  const red = tasks.find((t) => t.parentId === primary.id)!;
  const pkg = readFileSync(join(taskDir(runId, red.id), "package.md"), "utf8");
  assert.match(pkg, /## Artifact under review/, "red package must include the artifact section");
  assert.match(pkg, /the-reviewed-thing/, "red package must contain the primary's result.json");
  assert.ok(
    Array.isArray((red.taskPackage.inputs as Record<string, unknown>).failureModes),
    "failureModes input present (inputs no longer empty {})",
  );
});

test("runNext: reds receive force-level anti-prompts as failureModes (forge-site Symptom A — failureModes)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const cdir = join(process.env.FORGE_HOME as string, "constraints");
  mkdirSync(cdir, { recursive: true });
  const cfile = join(cdir, "zz-test-antiprompt.md");
  writeFileSync(
    cfile,
    ["---", "id: zz-test-antiprompt", "level: force", "roles: []", "workflows: []", 'antiPrompt: "Demonstrate the artifact is broken"', "---", "", "body", ""].join("\n"),
  );
  try {
    const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "red failuremodes", inputs: {}, projectDir: "/tmp/test-project" });
    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
      { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    ]);
    await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });
    const tasks = tasksForRun(runId);
    const primary = tasks.find((t) => t.parentId === undefined)!;
    const red = tasks.find((t) => t.parentId === primary.id)!;
    const fm = (red.taskPackage.inputs as Record<string, unknown>).failureModes as string[];
    assert.ok(fm.includes("Demonstrate the artifact is broken"), "force-level antiPrompt fed to the red as a failureMode");
  } finally {
    rmSync(cfile, { force: true });
  }
});

// ── #264: pi attribution on the WORKFLOW/runNext path (mirrors invoke.test.ts) ─
const PI_ATTR_WORKFLOW: Workflow = {
  name: "test-pi-attr",
  description: "single pi step",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "pi-step", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

function ensurePiRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "pi-stub.yml");
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `name: pi-stub
description: test stub pi runtime
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: test-model
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

// Exec that writes pi JSONL to stdout but NO result.json (pi exits 0 on error).
function makePiNoResultExec(stdoutJsonl: string, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

test("runNext: #264 pi step with no result.json fails with an attributed error, not no_result_json", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: PI_ATTR_WORKFLOW,
      title: "pi attribution test",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_start" }) + "\n" +
      JSON.stringify({ type: "agent_end", messages: [
        { role: "assistant", stopReason: "error", errorMessage: "401 authentication_error: invalid x-api-key" },
      ] }) + "\n";

    const wave = await runNext({ runId, workflow: PI_ATTR_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["pi-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "pi-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /pi run failed:/);
    assert.match(task.error ?? "", /authentication_error/);
    assert.doesNotMatch(task.error ?? "", /^no_result_json$/);
    // #267: the workflow path classifies a pi provider error as model_error too
    // (parity with the direct invoke path — guards against drift).
    assert.equal(failureKindForTask(task.id), "model_error");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

// #265: full-path integration — a pi profile must thread the resolved UPSTREAM
// provider all the way through runNext -> SpawnContext -> buildDockerArgs into
// pi's `--provider` arg (the spawn unit test builds SpawnContext by hand; this
// proves runNext actually wires resolution.provider into it).
const PI_UPSTREAM_WORKFLOW: Workflow = {
  name: "test-pi-upstream",
  description: "single pi step resolved via model-policy",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "pi-step", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

test("runNext: a pi profile threads the resolved upstream provider into pi's --provider (#265)", async () => {
  const policyPath = join(process.env.FORGE_HOME!, "model-policy.yml");
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "pi-upstream-stub.yml");
  // #303: groq/api is now probeable, so the availability gate requires a key —
  // set GROQ_API_KEY so the run reaches dispatch (this test asserts --provider
  // threading, not the key gate, which is covered in provider-doctor/invoke tests).
  const savedGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "gsk-test";
  writeFileSync(policyPath, `
on_unavailable: fail
model_profiles:
  pi-groq:
    provider: groq
    auth: api
    runtime: pi-upstream-stub
    map:
      default: { model: llama-3.3-70b-versatile, cost_tier: cheap, tool_capable: true }
defaults:
  profile: pi-groq
  activity: {}
allowed_profiles: [pi-groq]
`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `name: pi-upstream-stub
description: test stub pi runtime with --provider threading
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: test-model
auth:
  mode: oauth-volume
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: pi
  args: ["-p", "--provider", "\${UPSTREAM_PROVIDER:-anthropic}", "--model", "\${MODEL}"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);

  try {
    const { runId } = startRun({
      workflow: PI_UPSTREAM_WORKFLOW,
      title: "pi upstream threading",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });

    let captured: string[] | undefined;
    const capturingExec: DockerExecFn = async ({ args }) => { captured = args; return 0; };
    await runNext({ runId, workflow: PI_UPSTREAM_WORKFLOW, dockerExec: capturingExec });

    assert.ok(captured, "dockerExec should have been invoked");
    const provIdx = captured!.indexOf("--provider");
    assert.ok(provIdx >= 0, "docker args must contain --provider");
    assert.equal(captured![provIdx + 1], "groq"); // resolved upstream, not the :- fallback
    const modelIdx = captured!.indexOf("--model");
    assert.equal(captured![modelIdx + 1], "llama-3.3-70b-versatile");
  } finally {
    rmSync(policyPath, { force: true });
    rmSync(runtimePath, { force: true });
    if (savedGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedGroq;
  }
});

// ── FG-337: inferred-result fallback on the runNext/workflow path ─────────────

const FG337_NARRATIVE_WORKFLOW: Workflow = {
  name: "test-fg337-narrative",
  description: "single narrative pi step",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "research-step", agent: "research-specialist", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

const FG337_STRUCTURED_WORKFLOW: Workflow = {
  name: "test-fg337-structured",
  description: "single structured pi step",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "engineer-step", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

test("runNext FG-337: narrative role completes via inferred result when pi exits cleanly with assistant text", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_NARRATIVE_WORKFLOW,
      title: "fg337 narrative",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: "Paris is the capital of France." }] }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_NARRATIVE_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.completedSteps, ["research-step"]);
    assert.deepEqual(wave.failedSteps, []);

    const task = tasksForRun(runId).find((t) => t.phase === "research-step")!;
    assert.equal(task.status, "complete");
    const result = task.result as { contract: string; summary: string; status: string } | undefined;
    assert.equal(result?.contract, "inferred");
    assert.equal(result?.summary, "Paris is the capital of France.");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext FG-337: structured role (engineer) still hard-fails even with pi clean completion + text", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_STRUCTURED_WORKFLOW,
      title: "fg337 structured",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: "I did the work." }] }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_STRUCTURED_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["engineer-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "engineer-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /completed but wrote no .*result\.json/);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext FG-337: truncated pi run (no agent_end) still fails even for narrative role", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_NARRATIVE_WORKFLOW,
      title: "fg337 truncated",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout = JSON.stringify({ type: "agent_start" }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_NARRATIVE_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["research-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "research-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /no completion event/);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext FG-337: pi model error still fails for narrative role (not inferrable)", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_NARRATIVE_WORKFLOW,
      title: "fg337 model error",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", errorMessage: "401 invalid api key" }] }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_NARRATIVE_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["research-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "research-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /pi run failed/);
    assert.equal(failureKindForTask(task.id), "model_error");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
