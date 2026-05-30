// Integration tests for lifecycle events backfilled in #194.
//
// Each test uses a real seeded in-memory DB (makeInMemoryDb/setDbForTest) and
// asserts that events are READABLE end-to-end via eventsForTask/eventsForRun
// and render in forge show (performShow). Covers every backfilled event on
// its actual transition, plus regressions for removed event types.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { eventsForTask, eventsForRun } from "../../store/events.js";
import { insertRun } from "../../store/runs.js";
import { insertTask, tasksForRun } from "../../store/tasks.js";
import { performCancel } from "./cancel.js";
import { performShow } from "./show.js";
import { runNext, type DockerExecFn } from "../../v2/runNext.js";
import { startRun } from "../../v2/startRun.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "../../v2/idle-watchdog.js";
import { writeProfile } from "../../util/auth-profiles.js";
import type { Workflow } from "../../v2/schema.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let savedApiKey: string | undefined;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(id: string, runId: string, overrides: Partial<Omit<Task, "id" | "taskPackage">> = {}): Task {
  return {
    id,
    runId,
    phase: overrides.phase ?? "engineer",
    agentRole: overrides.agentRole ?? "engineer",
    status: overrides.status ?? "running",
    taskPackage: {
      taskId: id,
      runId,
      phase: overrides.phase ?? "engineer",
      role: overrides.agentRole ?? "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-05-29T00:00:00Z",
  };
}

// Write the minimal claude.yml runtime stub if it does not already exist.
function ensureClaudeRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      `
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
`,
    );
  }
}

// Write a browser-capable runtime stub (has browser-tools skill + auth-inject.js).
// Returns the runtime name.
function setupBrowserRuntime(): string {
  const fhome = process.env.FORGE_HOME!;
  const btDir = join(fhome, "bt-skill");
  mkdirSync(btDir, { recursive: true });
  writeFileSync(join(btDir, "auth-inject.js"), "// stub injector\n");
  const rtPath = join(fhome, "runtimes", "claude-bt.yml");
  mkdirSync(dirname(rtPath), { recursive: true });
  writeFileSync(
    rtPath,
    `
name: claude-bt
description: bt stub with browser-tools
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
`,
  );
  return "claude-bt";
}

// A stub dockerExec that writes result.json and returns the given exitCode.
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

// A stub dockerExec that mimics an idle watchdog kill (exit 124, empty result).
const idleTimeoutExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  const dir = dirname(stdoutPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), "");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  return IDLE_TIMEOUT_EXIT_CODE;
};

// A stub dockerExec that mimics a container crash (exit 1, empty result).
const crashExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  const dir = dirname(stdoutPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), "");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "container crashed");
  return 1;
};

// Minimal one-step (auto gate) workflow using the standard claude runtime.
const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "test-lifecycle-single",
  description: "one auto-gate step for lifecycle event tests",
  inputs: [],
  steps: [
    {
      id: "work",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
  ],
};

// Minimal one-step workflow with gate: human (triggers task.awaiting_gate).
const HUMAN_GATE_WORKFLOW: Workflow = {
  name: "test-lifecycle-human-gate",
  description: "one human-gate step for awaiting_gate lifecycle event tests",
  inputs: [],
  steps: [
    {
      id: "review",
      agent: "engineer",
      gate: "human",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
  ],
};

// ─── 1. run.abandoned ───────────────────────────────────────────────────────
// Cancelling a run emits BOTH run.cancelled (the action) AND run.abandoned
// (the lifecycle transition). Both must be readable via eventsForRun and
// render in forge show.

test("integ lifecycle run.abandoned: cancel emits BOTH run.cancelled AND run.abandoned, readable via eventsForRun and performShow", () => {
  const runId = "run-abandon-lifecycle-evt";
  const run: Run = {
    id: runId,
    workflow: "feature",
    title: "lifecycle abandon test",
    status: "active",
    createdAt: "2026-05-29T00:00:00Z",
  };
  insertRun(run);
  insertTask(makeTask("t-abandon-lc-1", runId, { status: "running" }));
  insertTask(makeTask("t-abandon-lc-2", runId, { status: "pending" }));

  const outcome = performCancel(runId, {}, () => { /* stub kill */ });
  assert.equal(outcome.kind, "run-cancelled");

  // eventsForRun must include BOTH run.cancelled and run.abandoned
  const events = eventsForRun(runId);
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("run.cancelled"), "run.cancelled must be in eventsForRun");
  assert.ok(types.includes("run.abandoned"), "run.abandoned must be in eventsForRun");

  // Both are run-level events (no taskId)
  const cancelledEvt = events.find((e) => e.eventType === "run.cancelled")!;
  assert.ok(cancelledEvt, "run.cancelled event must exist");
  assert.equal(cancelledEvt.taskId, null, "run.cancelled must have null taskId");
  assert.equal(cancelledEvt.runId, runId);

  const abandonedEvt = events.find((e) => e.eventType === "run.abandoned")!;
  assert.ok(abandonedEvt, "run.abandoned event must exist");
  assert.equal(abandonedEvt.taskId, null, "run.abandoned must have null taskId");
  assert.equal(abandonedEvt.runId, runId);

  // performShow renders both events in the run timeline
  const showResult = performShow(runId);
  assert.equal(showResult.kind, "run");
  if (showResult.kind !== "run") return;
  const showTypes = showResult.events.map((e) => e.eventType);
  assert.ok(showTypes.includes("run.cancelled"), "performShow run result must include run.cancelled");
  assert.ok(showTypes.includes("run.abandoned"), "performShow run result must include run.abandoned");
});

// Also cover the task-id cancel path, which emits run.abandoned only when
// the cancelled task is the last non-terminal one.
test("integ lifecycle run.abandoned: task-id cancel path also emits run.abandoned when last non-terminal task is cancelled", () => {
  const runId = "run-abandon-task-form-lc";
  insertRun({
    id: runId,
    workflow: "feature",
    title: "task-cancel lifecycle test",
    status: "active",
    createdAt: "2026-05-29T00:00:00Z",
  });
  insertTask(makeTask("t-sole-lc", runId, { status: "running" }));

  performCancel("t-sole-lc", {}, () => { /* stub kill */ });

  const events = eventsForRun(runId);
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("run.cancelled"), "task-cancel path must emit run.cancelled");
  assert.ok(types.includes("run.abandoned"), "task-cancel path must emit run.abandoned");

  // Exactly one of each run-level event
  assert.equal(types.filter((t) => t === "run.cancelled").length, 1, "exactly one run.cancelled");
  assert.equal(types.filter((t) => t === "run.abandoned").length, 1, "exactly one run.abandoned");
});

// ─── 2. task.awaiting_gate ──────────────────────────────────────────────────
// A gate:human step transitions to awaiting_gate and emits task.awaiting_gate.
// Must be readable via eventsForTask and render in forge show (task branch).

test("integ lifecycle task.awaiting_gate: gate:human step emits task.awaiting_gate, readable via eventsForTask and performShow", async () => {
  ensureClaudeRuntime();
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "awaiting_gate lifecycle test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const wave = await runNext({
    runId,
    workflow: HUMAN_GATE_WORKFLOW,
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.deepEqual(wave.awaitingGate, ["review"], "step must be in awaitingGate");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "review" && t.parentId === undefined)!;
  assert.ok(primary, "primary task must exist");
  assert.equal(primary.status, "awaiting_gate", "task must have awaiting_gate status");

  // eventsForTask must include task.awaiting_gate
  const taskEvents = eventsForTask(primary.id);
  const gateEv = taskEvents.find((e) => e.eventType === "task.awaiting_gate");
  assert.ok(gateEv, "eventsForTask must include task.awaiting_gate");
  assert.equal(gateEv!.runId, runId);
  assert.equal(gateEv!.taskId, primary.id);

  // eventsForRun also includes it (task.awaiting_gate has a taskId)
  const runEvents = eventsForRun(runId);
  const runGateEv = runEvents.find((e) => e.eventType === "task.awaiting_gate");
  assert.ok(runGateEv, "eventsForRun must also include task.awaiting_gate");
  assert.equal(runGateEv!.taskId, primary.id);

  // performShow (task branch) includes task.awaiting_gate
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showTypes = showResult.events.map((e) => e.eventType);
  assert.ok(showTypes.includes("task.awaiting_gate"), "performShow task result must include task.awaiting_gate");
});

// ─── 3. container.started + container.exited ────────────────────────────────
// A successful dispatch (exit 0) emits container.started then container.exited
// in order. Payloads must carry containerName = forge-<taskId> and exitCode 0.

test("integ lifecycle container.started + container.exited: emitted in order on exit 0, payloads correct, readable end-to-end", async () => {
  ensureClaudeRuntime();
  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "container events lifecycle test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeStubExec({ status: "complete" }, 0),
  });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.ok(primary, "primary task must exist");
  assert.equal(primary.status, "complete");

  // eventsForTask: both events present
  const taskEvents = eventsForTask(primary.id);
  const types = taskEvents.map((e) => e.eventType);

  assert.ok(types.includes("container.started"), "must emit container.started");
  assert.ok(types.includes("container.exited"), "must emit container.exited on exit 0");

  // Ordering: started before exited
  const startedIdx = types.indexOf("container.started");
  const exitedIdx = types.indexOf("container.exited");
  assert.ok(startedIdx < exitedIdx, "container.started must precede container.exited");

  // Payloads carry containerName = forge-<taskId> and exitCode 0
  const expectedName = `forge-${primary.id}`;
  const startedEv = taskEvents[startedIdx]!;
  const exitedEv = taskEvents[exitedIdx]!;

  const startedPayload = startedEv.payload as Record<string, unknown>;
  assert.equal(startedPayload.containerName, expectedName, "container.started payload must have correct containerName");

  const exitedPayload = exitedEv.payload as Record<string, unknown>;
  assert.equal(exitedPayload.containerName, expectedName, "container.exited payload must have correct containerName");
  assert.equal(exitedPayload.exitCode, 0, "container.exited payload must have exitCode 0");

  // eventsForRun also includes both
  const runEvents = eventsForRun(runId);
  const runTypes = runEvents.map((e) => e.eventType);
  assert.ok(runTypes.includes("container.started"));
  assert.ok(runTypes.includes("container.exited"));

  // performShow (task branch) includes both events
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showTypes = showResult.events.map((e) => e.eventType);
  assert.ok(showTypes.includes("container.started"), "performShow must include container.started");
  assert.ok(showTypes.includes("container.exited"), "performShow must include container.exited");

  // Payloads survive the round-trip through performShow
  const showExited = showResult.events.find((e) => e.eventType === "container.exited")!;
  assert.equal((showExited.payload as Record<string, unknown>).exitCode, 0);
  assert.equal((showExited.payload as Record<string, unknown>).containerName, expectedName);
});

// ─── 3b. task.created + task.completed (primary step) ───────────────────────
// The primary-step dispatch path historically logged neither task.created nor
// task.completed (only reds/fanout/manual did), leaving a gap in the forge show
// timeline. Both must now bracket the primary task's lifecycle.

test("integ lifecycle task.created + task.completed: primary step brackets its lifecycle, readable end-to-end", async () => {
  ensureClaudeRuntime();
  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "primary lifecycle events test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: makeStubExec({ status: "complete" }, 0),
  });

  const primary = tasksForRun(runId).find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.ok(primary, "primary task must exist");
  assert.equal(primary.status, "complete");

  const types = eventsForTask(primary.id).map((e) => e.eventType);
  assert.ok(types.includes("task.created"), "primary step must emit task.created");
  assert.ok(types.includes("task.completed"), "primary step must emit task.completed");

  // Order: created → started → completed.
  const createdIdx = types.indexOf("task.created");
  const startedIdx = types.indexOf("task.started");
  const completedIdx = types.indexOf("task.completed");
  assert.ok(createdIdx < startedIdx, "task.created must precede task.started");
  assert.ok(startedIdx < completedIdx, "task.started must precede task.completed");

  // performShow round-trips them.
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showTypes = showResult.events.map((e) => e.eventType);
  assert.ok(showTypes.includes("task.created"), "performShow must include task.created");
  assert.ok(showTypes.includes("task.completed"), "performShow must include task.completed");
});

// ─── 4. container.idle_timeout ──────────────────────────────────────────────
// When the watchdog kills a hung agent (IDLE_TIMEOUT_EXIT_CODE = 124),
// container.idle_timeout is emitted — NOT container.exited. The task ends
// failed. Readable via eventsForTask and performShow.

test("integ lifecycle container.idle_timeout: emitted (NOT container.exited) on exit 124, task ends failed, readable end-to-end", async () => {
  ensureClaudeRuntime();
  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "idle timeout lifecycle test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const wave = await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: idleTimeoutExec,
  });

  assert.deepEqual(wave.failedSteps, ["work"], "step must be failed on idle timeout");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.ok(primary);
  assert.equal(primary.status, "failed", "task must be failed after idle timeout");
  assert.match(primary.error ?? "", /idle_timeout/, "error message must mention idle_timeout");

  // eventsForTask: container.idle_timeout present, container.exited NOT present
  const taskEvents = eventsForTask(primary.id);
  const types = taskEvents.map((e) => e.eventType);

  assert.ok(types.includes("container.started"), "must still emit container.started");
  assert.ok(types.includes("container.idle_timeout"), "must emit container.idle_timeout on exit 124");
  assert.ok(!types.includes("container.exited"), "must NOT emit container.exited for idle timeout path");

  // Payload carries containerName and exitCode = IDLE_TIMEOUT_EXIT_CODE
  const idleEv = taskEvents.find((e) => e.eventType === "container.idle_timeout")!;
  const idlePayload = idleEv.payload as Record<string, unknown>;
  assert.equal(idlePayload.exitCode, IDLE_TIMEOUT_EXIT_CODE, "idle_timeout payload must carry exitCode 124");
  assert.equal(
    idlePayload.containerName,
    `forge-${primary.id}`,
    "idle_timeout payload must carry containerName forge-<taskId>",
  );

  // performShow (task branch) includes container.idle_timeout, not container.exited
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showTypes = showResult.events.map((e) => e.eventType);
  assert.ok(showTypes.includes("container.idle_timeout"), "performShow must include container.idle_timeout");
  assert.ok(!showTypes.includes("container.exited"), "performShow must NOT include container.exited for idle timeout");

  // Payload survives round-trip
  const showIdleEv = showResult.events.find((e) => e.eventType === "container.idle_timeout")!;
  assert.equal((showIdleEv.payload as Record<string, unknown>).exitCode, IDLE_TIMEOUT_EXIT_CODE);
});

// ─── 5. auth.profile_applied ────────────────────────────────────────────────
// Dispatching a browser-capable role with a valid auth profile emits
// auth.profile_applied. The payload must contain ONLY { profile: <name> } —
// no token, state, path, or any other credential material.

test("integ lifecycle auth.profile_applied: emitted with payload {profile} only (no credential material), readable end-to-end", async () => {
  const btRuntime = setupBrowserRuntime();
  const profileName = "integ-lc-valid-profile";
  // Write a valid profile with a future expiry (no localhost origins → no reconciliation).
  writeProfile(profileName, {
    cookies: [],
    origins: [
      {
        origin: "http://example.com:4000",
        localStorage: [
          {
            name: "sb-x-auth-token",
            value: JSON.stringify({
              access_token: "tok.stub.123",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              refresh_token: "ref.stub.456",
            }),
          },
        ],
      },
    ],
  });

  const wf: Workflow = {
    name: "test-auth-applied-lc",
    description: "one engineer step with valid auth profile",
    inputs: [],
    steps: [
      {
        id: "work",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: btRuntime,
        reds: [],
      },
    ],
  };

  const { runId } = startRun({
    workflow: wf,
    title: "auth.profile_applied lifecycle test",
    inputs: {},
    projectDir: "/tmp/test-project",
    authProfile: profileName,
  });

  await runNext({
    runId,
    workflow: wf,
    dockerExec: makeStubExec({ status: "complete" }),
  });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.ok(primary, "primary task must exist");

  // eventsForTask must include auth.profile_applied
  const taskEvents = eventsForTask(primary.id);
  const appliedEv = taskEvents.find((e) => e.eventType === "auth.profile_applied");
  assert.ok(appliedEv, "eventsForTask must include auth.profile_applied");
  assert.equal(appliedEv!.runId, runId);
  assert.equal(appliedEv!.taskId, primary.id);

  // CRUCIAL: payload must contain ONLY { profile: <name> } — no credential material
  const payload = appliedEv!.payload as Record<string, unknown>;
  assert.equal(payload.profile, profileName, "payload.profile must be the profile name");
  const keys = Object.keys(payload);
  // payload carries only safe metadata: profile name + kind (captured | project-command).
  assert.ok(keys.every((k) => k === "profile" || k === "kind"), `payload must only have profile/kind, got: ${keys.join(", ")}`);
  assert.equal(payload.kind, "captured", "this is a captured #176 profile");
  assert.ok(!("token" in payload), "payload must NOT contain 'token'");
  assert.ok(!("state" in payload), "payload must NOT contain 'state'");
  assert.ok(!("path" in payload), "payload must NOT contain 'path'");
  assert.ok(!("hostPath" in payload), "payload must NOT contain 'hostPath'");
  assert.ok(!("origins" in payload), "payload must NOT contain 'origins'");
  assert.ok(!("cookies" in payload), "payload must NOT contain 'cookies'");
  assert.ok(!("access_token" in payload), "payload must NOT contain 'access_token'");

  // eventsForRun also includes it
  const runEvents = eventsForRun(runId);
  assert.ok(
    runEvents.some((e) => e.eventType === "auth.profile_applied"),
    "eventsForRun must include auth.profile_applied",
  );

  // performShow (task branch) renders auth.profile_applied with clean payload
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showAppliedEv = showResult.events.find((e) => e.eventType === "auth.profile_applied");
  assert.ok(showAppliedEv, "performShow must include auth.profile_applied");
  const showPayload = showAppliedEv!.payload as Record<string, unknown>;
  assert.equal(showPayload.profile, profileName);
  assert.ok(
    Object.keys(showPayload).every((k) => k === "profile" || k === "kind"),
    "performShow payload must only carry profile/kind (no credential material)",
  );
});

// ─── 6. auth.profile_failed ─────────────────────────────────────────────────
// Dispatching a browser-capable role with a missing/expired profile emits
// auth.profile_failed. The payload must have profile + reason — and again
// NO credential material. Container must never start.

test("integ lifecycle auth.profile_failed (missing profile): emitted with profile+reason only (no credential material), container not started", async () => {
  ensureClaudeRuntime();
  const missingProfile = "integ-lc-missing-profile-xyz-not-created";

  const wf: Workflow = {
    name: "test-auth-failed-missing-lc",
    description: "one engineer step with missing auth profile",
    inputs: [],
    steps: [
      {
        id: "work",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: "claude",
        reds: [],
      },
    ],
  };

  const { runId } = startRun({
    workflow: wf,
    title: "auth.profile_failed lifecycle test",
    inputs: {},
    projectDir: "/tmp/test-project",
    authProfile: missingProfile,
  });

  // Container must never be started — guard confirms auth.profile_failed exits early.
  const forbiddenExec: DockerExecFn = async () => {
    throw new Error("container must NOT be spawned when auth.profile_failed");
  };

  const wave = await runNext({ runId, workflow: wf, dockerExec: forbiddenExec });
  assert.deepEqual(wave.failedSteps, ["work"], "step must fail when auth profile is missing");

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.ok(primary);
  assert.equal(primary.status, "failed", "task must be failed after auth.profile_failed");

  // eventsForTask must include auth.profile_failed
  const taskEvents = eventsForTask(primary.id);
  const failedEv = taskEvents.find((e) => e.eventType === "auth.profile_failed");
  assert.ok(failedEv, "eventsForTask must include auth.profile_failed");
  assert.equal(failedEv!.runId, runId);
  assert.equal(failedEv!.taskId, primary.id);

  // Payload must have profile + reason, nothing else credential-bearing
  const payload = failedEv!.payload as Record<string, unknown>;
  assert.equal(payload.profile, missingProfile, "payload.profile must be the profile name");
  assert.ok(
    typeof payload.reason === "string" && (payload.reason as string).length > 0,
    "payload.reason must be a non-empty string",
  );
  assert.ok(
    (payload.reason as string).includes(missingProfile),
    "reason must mention the profile name",
  );
  const keys = Object.keys(payload);
  assert.equal(keys.length, 2, `payload must have exactly 2 keys (profile + reason), got: ${keys.join(", ")}`);
  assert.ok(!("token" in payload), "payload must NOT contain 'token'");
  assert.ok(!("state" in payload), "payload must NOT contain 'state'");
  assert.ok(!("path" in payload), "payload must NOT contain 'path'");
  assert.ok(!("hostPath" in payload), "payload must NOT contain 'hostPath'");
  assert.ok(!("access_token" in payload), "payload must NOT contain 'access_token'");

  // container.started must NOT be in the events (auth.profile_failed exits before container)
  const types = taskEvents.map((e) => e.eventType);
  assert.ok(!types.includes("container.started"), "container.started must NOT be emitted when auth.profile_failed");
  assert.ok(!types.includes("container.exited"), "container.exited must NOT be emitted when auth.profile_failed");

  // performShow (task branch) renders auth.profile_failed with clean payload
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showFailedEv = showResult.events.find((e) => e.eventType === "auth.profile_failed");
  assert.ok(showFailedEv, "performShow must include auth.profile_failed");
  const showPayload = showFailedEv!.payload as Record<string, unknown>;
  assert.equal(showPayload.profile, missingProfile);
  assert.ok(typeof showPayload.reason === "string");
  assert.equal(
    Object.keys(showPayload).length,
    2,
    "performShow payload must have exactly 2 keys (profile + reason)",
  );
});

test("integ lifecycle auth.profile_failed (expired profile): emits auth.profile_failed with expiry reason", async () => {
  ensureClaudeRuntime();
  const expiredProfile = "integ-lc-expired-profile";
  // Write a profile with an expiry in the past so profileStatus.expired = true.
  writeProfile(expiredProfile, {
    cookies: [],
    origins: [
      {
        origin: "http://example.com:4001",
        localStorage: [
          {
            name: "sb-x-auth-token",
            value: JSON.stringify({
              access_token: "expired.tok",
              expires_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
              refresh_token: "expired.ref",
            }),
          },
        ],
      },
    ],
  });

  const wf: Workflow = {
    name: "test-auth-failed-expired-lc",
    description: "one engineer step with expired auth profile",
    inputs: [],
    steps: [
      {
        id: "work",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: "claude",
        reds: [],
      },
    ],
  };

  const { runId } = startRun({
    workflow: wf,
    title: "auth.profile_failed expired test",
    inputs: {},
    projectDir: "/tmp/test-project",
    authProfile: expiredProfile,
  });

  const forbiddenExec: DockerExecFn = async () => {
    throw new Error("container must NOT be spawned for an expired auth profile");
  };

  const wave = await runNext({ runId, workflow: wf, dockerExec: forbiddenExec });
  assert.deepEqual(wave.failedSteps, ["work"]);

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.equal(primary.status, "failed");

  const taskEvents = eventsForTask(primary.id);
  const failedEv = taskEvents.find((e) => e.eventType === "auth.profile_failed");
  assert.ok(failedEv, "eventsForTask must include auth.profile_failed for expired profile");

  const payload = failedEv!.payload as Record<string, unknown>;
  assert.equal(payload.profile, expiredProfile);
  assert.ok(
    typeof payload.reason === "string" && (payload.reason as string).includes("expired"),
    "reason must mention 'expired'",
  );
  // Still no credential material
  assert.ok(!("access_token" in payload), "payload must NOT contain access_token");
  assert.ok(!("origins" in payload), "payload must NOT contain origins");

  // performShow renders this too
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  assert.ok(
    showResult.events.some((e) => e.eventType === "auth.profile_failed"),
    "performShow must include auth.profile_failed for expired profile",
  );
});

// ─── 7. Regression: task.idle_timeout and task.crashed are NOT emitted ───────
// These event types were removed. Idle timeout → container.idle_timeout only.
// Container crash → container.exited with non-zero exit code only.

test("integ lifecycle regression: task.idle_timeout is NOT emitted — idle timeout only emits container.idle_timeout", async () => {
  ensureClaudeRuntime();
  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "regression task.idle_timeout test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: idleTimeoutExec,
  });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  const allEvents = eventsForTask(primary.id);
  const types = allEvents.map((e) => e.eventType);

  // task.idle_timeout must NOT appear — it was removed
  assert.ok(
    !types.includes("task.idle_timeout" as never),
    "task.idle_timeout must NOT be emitted (removed event type); only container.idle_timeout is valid",
  );
  assert.ok(types.includes("container.idle_timeout"), "container.idle_timeout must be emitted instead");

  // Also verify via performShow
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showTypes = showResult.events.map((e) => e.eventType);
  assert.ok(!showTypes.includes("task.idle_timeout" as never), "performShow must NOT include task.idle_timeout");
});

test("integ lifecycle regression: task.crashed is NOT emitted — container crash only emits container.exited with non-zero exitCode", async () => {
  ensureClaudeRuntime();
  const { runId } = startRun({
    workflow: SINGLE_STEP_WORKFLOW,
    title: "regression task.crashed test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  await runNext({
    runId,
    workflow: SINGLE_STEP_WORKFLOW,
    dockerExec: crashExec,
  });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.equal(primary.status, "failed", "task must fail on container crash");

  const allEvents = eventsForTask(primary.id);
  const types = allEvents.map((e) => e.eventType);

  // task.crashed must NOT appear — it was never a valid EventType
  assert.ok(
    !types.includes("task.crashed" as never),
    "task.crashed must NOT be emitted (never a valid EventType)",
  );
  // container.exited IS still emitted, with non-zero exitCode
  assert.ok(types.includes("container.exited"), "container.exited must still be emitted on crash");
  const exitedEv = allEvents.find((e) => e.eventType === "container.exited")!;
  assert.equal(
    (exitedEv.payload as Record<string, unknown>).exitCode,
    1,
    "container.exited payload must carry the non-zero exit code",
  );

  // Also verify via performShow
  const showResult = performShow(primary.id);
  assert.equal(showResult.kind, "task");
  if (showResult.kind !== "task") return;
  const showTypes = showResult.events.map((e) => e.eventType);
  assert.ok(!showTypes.includes("task.crashed" as never), "performShow must NOT include task.crashed");
  assert.ok(showTypes.includes("container.exited"), "performShow must include container.exited for crash");
});
