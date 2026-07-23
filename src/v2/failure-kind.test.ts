import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { dirname, join } from "node:path";
import {
  classify,
  failTask,
  failureKindFromEvents,
  getOrphanEvidenceFromEvents,
  getContainerCausalEvidenceFromEvents,
  parseDockerInspectState,
  signalNameForExitCode,
  type FailureKind,
  type OrphanEvidence,
  type ContainerCausalEvidence,
} from "./failure-kind.js";
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
});

test("classify: exitCode=IDLE_TIMEOUT_EXIT_CODE → idle_timeout", () => {
  assert.equal(classify({ exitCode: IDLE_TIMEOUT_EXIT_CODE }), "idle_timeout");
});

test("classify: exitCode=137 + resultState=missing → oom_killed (FG-455 attached-exit)", () => {
  assert.equal(classify({ exitCode: 137, resultState: "missing" }), "oom_killed");
});

test("classify: exitCode=124 (idle sentinel) + resultState=missing → idle_timeout, not reclassified by the 137 rule", () => {
  assert.equal(classify({ exitCode: IDLE_TIMEOUT_EXIT_CODE, resultState: "missing" }), "idle_timeout");
});

test("classify: exitCode=137 + resultState=malformed → not oom_killed (guard on missing)", () => {
  assert.notEqual(classify({ exitCode: 137, resultState: "malformed" }), "oom_killed");
});

test("classify: exitCode=137 with no resultState → not oom_killed", () => {
  assert.notEqual(classify({ exitCode: 137 }), "oom_killed");
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

test("classify: source=verification_environment_unavailable → verification_environment_unavailable (FG-376)", () => {
  assert.equal(
    classify({ source: "verification_environment_unavailable" }),
    "verification_environment_unavailable",
  );
});

test("classify: empty context → unknown", () => {
  assert.equal(classify({}), "unknown");
});

// --- FG-424: integrationGate evidence branch ---

test("classify: integrationGate.timedOut=true → integration_gate_timeout", () => {
  assert.equal(
    classify({ integrationGate: { status: null, signal: null, timedOut: true } }),
    "integration_gate_timeout",
  );
});

test("classify: integrationGate.signal set (timedOut false) → integration_gate_crashed", () => {
  assert.equal(
    classify({ integrationGate: { status: null, signal: "SIGKILL", timedOut: false } }),
    "integration_gate_crashed",
  );
});

test("classify: integrationGate ordinary non-zero status, no signal, not timed out → integration_failed (fail-closed default)", () => {
  assert.equal(
    classify({ integrationGate: { status: 1, signal: null, timedOut: false } }),
    "integration_failed",
  );
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
    "red_blocked", "gate_rejected", "integration_failed", "integration_gate_timeout",
    "integration_gate_crashed", "verification_environment_unavailable", "pre_container_crash", "unknown",
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
  // FG-583: dispatch reads only a published generation — publish the flat runtime.
  publishFlatAsGeneration(fhome);
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

// ── getOrphanEvidenceFromEvents (FG-455) ────────────────────────────────────

const SAMPLE_EVIDENCE: OrphanEvidence = {
  containerName: "forge-t-1",
  containerLiveness: "gone",
  resultState: "absent",
  recoverableStdoutResult: false,
  worktreePathChecked: "/tmp/worktree",
  changedFiles: ["?? new-file.txt"],
};

test("getOrphanEvidenceFromEvents: returns the evidence recorded on an orphaned_work_may_persist task.failed", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "orphaned_work_may_persist", error: "x", evidence: SAMPLE_EVIDENCE }),
  ];
  assert.deepEqual(getOrphanEvidenceFromEvents(events), SAMPLE_EVIDENCE);
});

test("getOrphanEvidenceFromEvents: undefined for ordinary orphaned (no evidence to show)", () => {
  const events: Event[] = [makeEvent("task.failed", { failure_kind: "orphaned", error: "x" })];
  assert.equal(getOrphanEvidenceFromEvents(events), undefined);
});

test("getOrphanEvidenceFromEvents: undefined once a later task.completed supersedes the failure (retried + recovered)", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "orphaned_work_may_persist", error: "x", evidence: SAMPLE_EVIDENCE }),
    makeEvent("task.retried"),
    makeEvent("task.completed"),
  ];
  assert.equal(getOrphanEvidenceFromEvents(events), undefined);
});

test("getOrphanEvidenceFromEvents: undefined for other failure kinds even when a stray evidence key is present", () => {
  const events: Event[] = [makeEvent("task.failed", { failure_kind: "model_error", error: "x", evidence: SAMPLE_EVIDENCE })];
  assert.equal(getOrphanEvidenceFromEvents(events), undefined);
});

// FG-455 p4 review finding 1: oom_killed carries the same evidence shape as
// orphaned_work_may_persist (both gathered on reconcile.ts's shared
// container-gone evidence path) — forge show / status / recover must surface
// it too, not just orphaned_work_may_persist.
test("getOrphanEvidenceFromEvents: also returns the evidence recorded on an oom_killed task.failed", () => {
  const oomEvidence: OrphanEvidence = { ...SAMPLE_EVIDENCE, exitCode: 137, oomKilled: true };
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "oom_killed", error: "x", evidence: oomEvidence }),
  ];
  assert.deepEqual(getOrphanEvidenceFromEvents(events), oomEvidence);
});

test("getOrphanEvidenceFromEvents: empty event list → undefined", () => {
  assert.equal(getOrphanEvidenceFromEvents([]), undefined);
});

// ── FG-492: parseDockerInspectState / signalNameForExitCode ─────────────────

test("parseDockerInspectState: parses a full docker inspect array into the shared shape", () => {
  const raw = JSON.stringify([
    { State: { StartedAt: "2026-01-01T00:00:00Z", FinishedAt: "2026-01-01T00:05:00Z", ExitCode: 137, OOMKilled: true, Error: "" } },
  ]);
  assert.deepEqual(parseDockerInspectState(raw), {
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:05:00Z",
    exitCode: 137,
    oomKilled: true,
    signal: "SIGKILL",
  });
});

test("parseDockerInspectState: a non-signal exit code (0) carries no signal field", () => {
  const raw = JSON.stringify([{ State: { ExitCode: 0, OOMKilled: false } }]);
  const parsed = parseDockerInspectState(raw);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.signal, undefined);
});

test("parseDockerInspectState: State.Error is surfaced as dockerStateError when non-empty", () => {
  const raw = JSON.stringify([{ State: { Error: "OCI runtime error" } }]);
  assert.equal(parseDockerInspectState(raw).dockerStateError, "OCI runtime error");
});

test("parseDockerInspectState: empty State.Error is omitted, not recorded as an empty string", () => {
  const raw = JSON.stringify([{ State: { ExitCode: 0, Error: "" } }]);
  assert.equal(parseDockerInspectState(raw).dockerStateError, undefined);
});

test("parseDockerInspectState: malformed JSON → {} (never throws)", () => {
  assert.deepEqual(parseDockerInspectState("not json {{{"), {});
});

test("parseDockerInspectState: empty array / no State → {}", () => {
  assert.deepEqual(parseDockerInspectState("[]"), {});
  assert.deepEqual(parseDockerInspectState(JSON.stringify([{}])), {});
});

test("parseDockerInspectState: FinishedAt at Docker's zero-value sentinel (never started/exited) is omitted, not treated as a real ancient timestamp", () => {
  const raw = JSON.stringify([{ State: { StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z", ExitCode: 0 } }]);
  const parsed = parseDockerInspectState(raw);
  assert.equal(parsed.finishedAt, undefined);
  assert.equal(parsed.startedAt, "0001-01-01T00:00:00Z", "only FinishedAt's sentinel is reap-containers' age-fallback concern");
});

test("signalNameForExitCode: maps 128+signal to the POSIX name; <=128 is not a signal", () => {
  assert.equal(signalNameForExitCode(137), "SIGKILL");
  assert.equal(signalNameForExitCode(143), "SIGTERM");
  assert.equal(signalNameForExitCode(128), undefined);
  assert.equal(signalNameForExitCode(1), undefined);
  assert.equal(signalNameForExitCode(0), undefined);
});

test("signalNameForExitCode: an above-128 code with no known mapping returns undefined (best-effort, not a guess)", () => {
  assert.equal(signalNameForExitCode(999), undefined);
});

// ── FG-492: getContainerCausalEvidenceFromEvents ────────────────────────────
// Deliberately reads a SEPARATE `containerEvidence` payload key from
// getOrphanEvidenceFromEvents's `evidence` key — the explicit-match discipline
// this ticket requires: a structurally different evidence shape must never be
// mis-cast by the other reader.

const SAMPLE_CONTAINER_EVIDENCE: ContainerCausalEvidence = {
  containerName: "forge-t-1",
  containerExitedEventObserved: true,
  dockerExitCode: 0,
};

test("getContainerCausalEvidenceFromEvents: returns the evidence recorded under the containerEvidence key", () => {
  const events: Event[] = [
    makeEvent("container.exited", { containerName: "forge-t-1", exitCode: 0, containerEvidence: SAMPLE_CONTAINER_EVIDENCE }),
  ];
  assert.deepEqual(getContainerCausalEvidenceFromEvents(events), SAMPLE_CONTAINER_EVIDENCE);
});

test("getContainerCausalEvidenceFromEvents: undefined when no event carries the key", () => {
  const events: Event[] = [makeEvent("container.exited", { containerName: "forge-t-1", exitCode: 0 })];
  assert.equal(getContainerCausalEvidenceFromEvents(events), undefined);
});

test("getContainerCausalEvidenceFromEvents: never mis-cast from an OrphanEvidence-shaped `evidence` key on the same event stream", () => {
  // An orphaned_work_may_persist task.failed event carries `evidence` (OrphanEvidence)
  // but NOT `containerEvidence` unless reconcile.ts explicitly attached it — the
  // two keys are distinct and this reader must not fall back to the other.
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "orphaned_work_may_persist", error: "x", evidence: SAMPLE_EVIDENCE }),
  ];
  assert.equal(getContainerCausalEvidenceFromEvents(events), undefined);
});

test("getContainerCausalEvidenceFromEvents: empty event list → undefined", () => {
  assert.equal(getContainerCausalEvidenceFromEvents([]), undefined);
});

test("getContainerCausalEvidenceFromEvents: picks the LATEST recorded evidence (newest-first)", () => {
  const first: ContainerCausalEvidence = { containerName: "forge-t-1", containerExitedEventObserved: true, dockerExitCode: 1 };
  const second: ContainerCausalEvidence = { containerName: "forge-t-1", containerExitedEventObserved: true, dockerExitCode: 0 };
  const events: Event[] = [
    makeEvent("container.exited", { containerEvidence: first }),
    makeEvent("container.exited", { containerEvidence: second }),
  ];
  assert.deepEqual(getContainerCausalEvidenceFromEvents(events), second);
});
