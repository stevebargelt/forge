import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify, failTask, failureKindFromEvents, type FailureKind } from "./failure-kind.js";
import type { Event } from "../store/events.js";
import { AuthProfileError } from "./auth-state.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { eventsForTask } from "../store/events.js";
import { insertTask, getTask } from "../store/tasks.js";
import { insertRun } from "../store/runs.js";
import { invoke, type DockerExecFn } from "./invoke.js";
import { nowIso, newTaskId, newRunId } from "../util/ids.js";

// --- classify() unit tests — one per FailureKind ---

test("classify: source=cancelled → cancelled", () => {
  assert.equal(classify({ source: "cancelled" }), "cancelled");
});

test("classify: exitCode=non-zero + resultState=missing → container_crash", () => {
  assert.equal(classify({ exitCode: 1, resultState: "missing" }), "container_crash");
  assert.equal(classify({ exitCode: 137, resultState: "missing" }), "container_crash");
});

test("classify: exitCode=IDLE_TIMEOUT_EXIT_CODE → idle_timeout", () => {
  assert.equal(classify({ exitCode: IDLE_TIMEOUT_EXIT_CODE }), "idle_timeout");
});

test("classify: resultState=missing (no exitCode) → result_missing", () => {
  assert.equal(classify({ resultState: "missing" }), "result_missing");
});

test("classify: resultState=missing + exitCode=0 → result_missing (not container_crash)", () => {
  assert.equal(classify({ exitCode: 0, resultState: "missing" }), "result_missing");
});

test("classify: resultState=malformed → result_malformed", () => {
  assert.equal(classify({ resultState: "malformed" }), "result_malformed");
});

test("classify: AuthProfileError without 'expired' → auth_missing", () => {
  const err = new AuthProfileError("auth profile 'x' not found — run: forge auth-profile login x");
  assert.equal(classify({ error: err }), "auth_missing");
});

test("classify: AuthProfileError with 'expired' → auth_expired", () => {
  const err = new AuthProfileError("auth profile 'x' is expired — run: forge auth-profile login x");
  assert.equal(classify({ error: err }), "auth_expired");
});

test("classify: source=auth_injection_failed → auth_injection_failed", () => {
  assert.equal(classify({ source: "auth_injection_failed" }), "auth_injection_failed");
});

test("classify: source=model_error → model_error", () => {
  assert.equal(classify({ source: "model_error" }), "model_error");
});

test("classify: source=tool_error → tool_error", () => {
  assert.equal(classify({ source: "tool_error" }), "tool_error");
});

test("classify: source=red_blocked → red_blocked", () => {
  assert.equal(classify({ source: "red_blocked" }), "red_blocked");
});

test("classify: source=gate_rejected → gate_rejected", () => {
  assert.equal(classify({ source: "gate_rejected" }), "gate_rejected");
});

test("classify: empty context → unknown", () => {
  assert.equal(classify({}), "unknown");
});

test("classify: source takes precedence over exitCode", () => {
  assert.equal(
    classify({ source: "cancelled", exitCode: IDLE_TIMEOUT_EXIT_CODE }),
    "cancelled",
  );
});

test("classify: IDLE_TIMEOUT_EXIT_CODE takes precedence over resultState=missing (no container_crash)", () => {
  assert.equal(
    classify({ exitCode: IDLE_TIMEOUT_EXIT_CODE, resultState: "missing" }),
    "idle_timeout",
  );
});

// --- failTask() emits task.failed with failure_kind ---

function makeRun(runId: string): void {
  insertRun({
    id: runId,
    workflow: "invoke",
    title: "test run",
    status: "active",
    createdAt: nowIso(),
  });
}

function makeTask(taskId: string, runId: string): void {
  insertTask({
    id: taskId,
    runId,
    phase: "task",
    agentRole: "engineer",
    status: "running",
    taskPackage: { taskId, runId, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: nowIso(),
  });
}

test("failTask: emits task.failed event with failure_kind and marks task failed", () => {
  const runId = newRunId("test-fail-task");
  const taskId = newTaskId("engineer");
  makeRun(runId);
  makeTask(taskId, runId);

  failTask(taskId, { runId, kind: "idle_timeout", error: "idle_timeout (no agent output for 10m)" });

  const task = getTask(taskId);
  assert.equal(task!.status, "failed");
  assert.match(task!.error ?? "", /idle_timeout/);

  const events = eventsForTask(taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed event must be emitted");
  const payload = failedEv!.payload as Record<string, unknown>;
  assert.equal(payload["failure_kind"], "idle_timeout");
  assert.ok(typeof payload["error"] === "string");
});

test("failTask: preserves result when provided", () => {
  const runId = newRunId("test-fail-task-result");
  const taskId = newTaskId("engineer");
  makeRun(runId);
  makeTask(taskId, runId);

  const partialResult = { status: "partial", children: [] };
  failTask(taskId, { runId, kind: "unknown", error: "fanout failed", result: partialResult });

  const task = getTask(taskId);
  assert.deepEqual(task!.result, partialResult);
  assert.equal(task!.status, "failed");
});

test("failTask: covers all FailureKind values in payload", () => {
  const kinds: FailureKind[] = [
    "cancelled", "container_crash", "idle_timeout", "result_missing", "result_malformed",
    "auth_missing", "auth_expired", "auth_injection_failed", "model_error", "tool_error",
    "red_blocked", "gate_rejected", "integration_failed", "unknown",
  ];
  for (const kind of kinds) {
    const runId = newRunId(`test-fk-${kind}`);
    const taskId = newTaskId("engineer");
    makeRun(runId);
    makeTask(taskId, runId);
    failTask(taskId, { runId, kind, error: `test error for ${kind}` });
    const events = eventsForTask(taskId);
    const failedEv = events.find((e) => e.eventType === "task.failed");
    assert.ok(failedEv, `task.failed must be emitted for kind=${kind}`);
    assert.equal((failedEv!.payload as Record<string, unknown>)["failure_kind"], kind, `failure_kind must be ${kind}`);
  }
});

// --- Integration: invoke() paths emit task.failed with failure_kind ---

function setupRuntimeStub(): void {
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

function makeIdleKilledExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };
}

function makeCrashExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "crash");
    return 1;
  };
}

function makeMalformedExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "not valid json {{{");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function makeEmptyResultExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("invoke path: idle_timeout failure emits task.failed with failure_kind=idle_timeout", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "hang forever",
    projectDir: "/tmp/x",
    dockerExec: makeIdleKilledExec(),
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted");
  assert.equal((failedEv!.payload as Record<string, unknown>)["failure_kind"], "idle_timeout");
});

test("invoke path: container_crash failure emits task.failed with failure_kind=container_crash", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "crash",
    projectDir: "/tmp/x",
    dockerExec: makeCrashExec(),
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted");
  assert.equal((failedEv!.payload as Record<string, unknown>)["failure_kind"], "container_crash");
});

test("invoke path: malformed result.json emits task.failed with failure_kind=result_malformed", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "produce bad json",
    projectDir: "/tmp/x",
    dockerExec: makeMalformedExec(),
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted");
  assert.equal((failedEv!.payload as Record<string, unknown>)["failure_kind"], "result_malformed");
});

test("invoke path: empty result.json (exit 0) emits task.failed with failure_kind=result_missing", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "write nothing",
    projectDir: "/tmp/x",
    dockerExec: makeEmptyResultExec(),
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted");
  assert.equal((failedEv!.payload as Record<string, unknown>)["failure_kind"], "result_missing");
});

test("invoke path: missing auth profile emits task.failed with failure_kind=auth_missing", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test",
    projectDir: "/tmp/x",
    authProfile: "no-such-profile-xyz-abc",
    dockerExec: async () => 0,
  });

  assert.equal(r.status, "failed");
  const events = eventsForTask(r.taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted");
  assert.equal((failedEv!.payload as Record<string, unknown>)["failure_kind"], "auth_missing");
});

// --- failureKindFromEvents() unit tests (FG-412) ---

function makeEvent(eventType: string, payload: unknown = null): Event {
  return { id: 1, runId: "run-x", taskId: "task-x", eventType: eventType as Event["eventType"], payload, createdAt: "2024-01-01T00:00:00Z" };
}

test("failureKindFromEvents: task.failed with recorded failure_kind → returns that kind", () => {
  const events: Event[] = [makeEvent("task.failed", { failure_kind: "idle_timeout", error: "no output" })];
  assert.equal(failureKindFromEvents(events), "idle_timeout");
});

test("failureKindFromEvents: task.failed with NO failure_kind in payload → 'unknown' (FG-412)", () => {
  // A failed task with no recorded kind is at minimum unknown — never "no info".
  const events: Event[] = [makeEvent("task.failed", { error: "something failed" })];
  assert.equal(failureKindFromEvents(events), "unknown", "task.failed + no failure_kind must return 'unknown', not undefined");
});

test("failureKindFromEvents: task.failed with null payload → 'unknown' (FG-412)", () => {
  const events: Event[] = [makeEvent("task.failed", null)];
  assert.equal(failureKindFromEvents(events), "unknown", "task.failed + null payload must return 'unknown'");
});

test("failureKindFromEvents: no terminal event → undefined (no information)", () => {
  const events: Event[] = [makeEvent("task.started")];
  assert.equal(failureKindFromEvents(events), undefined, "no terminal event must return undefined");
});

test("failureKindFromEvents: empty event list → undefined", () => {
  assert.equal(failureKindFromEvents([]), undefined);
});

test("failureKindFromEvents: task.completed (recovered) → undefined", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "model_error" }),
    makeEvent("task.retried"),
    makeEvent("task.completed"),
  ];
  assert.equal(failureKindFromEvents(events), undefined, "later task.completed supersedes earlier failure");
});

test("failureKindFromEvents: picks LATEST task.failed (newest-first walk, post-retry)", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "idle_timeout" }),
    makeEvent("task.retried"),
    makeEvent("task.failed", { failure_kind: "container_crash" }),
  ];
  assert.equal(failureKindFromEvents(events), "container_crash", "latest failure wins");
});
