// Integration tests for the failure_kind classifier + failTask wrapper through
// the gate.ts and cancel.ts dispatch paths. These complement the unit/invoke
// tests in failure-kind.test.ts (which covers classify() per-kind in isolation
// and the invoke failure paths).
//
// Tests use real seeded in-memory DBs (makeInMemoryDb/setDbForTest) to
// isolate DB writes from the on-disk forge.db, per the lifecycle-events pattern.
//
// Coverage:
//   1. gate_rejected via gate() "reject" decision → task.failed + failure_kind
//   2. gate_rejected via gate() "request-changes" decision → same kind
//   3. No-double-emit regression: gate reject emits task.failed EXACTLY ONCE
//   4. gate.decided + task.failed readable end-to-end via eventsForTask
//   5. cancelled via performCancel task-id form → failure_kind=cancelled
//   6. cancelled via performCancel run-id form (multiple tasks)
//   7. Secrets discipline: auth_missing payload has no credential material
//   8. Secrets discipline: auth_expired payload has no credential material

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { eventsForTask } from "../store/events.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { gate } from "./gate.js";
import { gatesForTask } from "../store/gates.js";
import { performCancel } from "../cli/commands/cancel.js";
import { invoke } from "./invoke.js";
import { writeProfile } from "../util/auth-profiles.js";
import { nowIso, newTaskId, newRunId } from "../util/ids.js";
import type { Task } from "../types/index.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

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

// Write the minimal claude.yml runtime stub (needed by invoke() auth paths).
function ensureClaudeRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
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
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Write a minimal one-step human-gate workflow YAML for gate() tests.
// gate() loads the workflow from FORGE_HOME/workflows/<name>.yml.
function ensureGatedWorkflow(name: string): void {
  const fhome = process.env.FORGE_HOME!;
  const wfPath = join(fhome, "workflows", `${name}.yml`);
  if (!existsSync(wfPath)) {
    mkdirSync(dirname(wfPath), { recursive: true });
    writeFileSync(wfPath, `name: ${name}
description: gate integration test workflow
inputs: []
steps:
  - id: work
    agent: engineer
    gate: human
    manual: false
    depends_on: []
    runtime: claude
    reds: []
`);
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Seed a run pointing to the given workflow name.
function seedRun(runId: string, workflow: string): void {
  insertRun({
    id: runId,
    workflow,
    title: "failure-kind gate/cancel integration test",
    status: "active",
    createdAt: nowIso(),
    projectDir: "/tmp/fk-test-project-nonexistent",
  });
}

// Seed a task in awaiting_gate status (required for gate() calls).
function seedAwaitingGateTask(taskId: string, runId: string, phase = "work"): Task {
  const t: Task = {
    id: taskId,
    runId,
    phase,
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: {
      taskId,
      runId,
      phase,
      role: "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: nowIso(),
  };
  insertTask(t);
  return t;
}

// Seed a task in running status (for cancel tests).
function seedRunningTask(taskId: string, runId: string, phase = "engineer"): void {
  insertTask({
    id: taskId,
    runId,
    phase,
    agentRole: "engineer",
    status: "running",
    taskPackage: {
      taskId,
      runId,
      phase,
      role: "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: nowIso(),
  });
}

// ─── 1. gate_rejected via gate() "reject" decision ──────────────────────────

test("integ failure_kind: gate reject emits task.failed with failure_kind=gate_rejected, task status=failed", async () => {
  const wfName = "fk-gate-reject-wf";
  ensureGatedWorkflow(wfName);
  const runId = newRunId("fk-gate-reject");
  const taskId = newTaskId("engineer");
  seedRun(runId, wfName);
  seedAwaitingGateTask(taskId, runId);

  await gate(taskId, "reject", "prototype lacks error handling");

  const task = getTask(taskId)!;
  assert.equal(task.status, "failed", "task must be failed after reject");
  assert.match(task.error ?? "", /prototype lacks error handling/, "task.error must contain the rationale");

  const events = eventsForTask(taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed event must be emitted on gate reject");
  assert.equal(failedEv!.runId, runId);
  assert.equal(failedEv!.taskId, taskId);
  const payload = failedEv!.payload as Record<string, unknown>;
  assert.equal(payload.failure_kind, "gate_rejected", "failure_kind must be gate_rejected");
  assert.ok(typeof payload.error === "string" && (payload.error as string).length > 0, "payload.error must be non-empty");
});

// ─── 2. gate_rejected via gate() "request-changes" decision ─────────────────

test("integ failure_kind: gate request-changes emits task.failed with failure_kind=gate_rejected", async () => {
  const wfName = "fk-gate-req-changes-wf";
  ensureGatedWorkflow(wfName);
  const runId = newRunId("fk-gate-req");
  const taskId = newTaskId("engineer");
  seedRun(runId, wfName);
  seedAwaitingGateTask(taskId, runId);

  await gate(taskId, "request-changes", "add tests for the happy path");

  const task = getTask(taskId)!;
  assert.equal(task.status, "failed", "task must be failed after request-changes");

  const events = eventsForTask(taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted on request-changes");
  assert.equal(
    (failedEv!.payload as Record<string, unknown>).failure_kind,
    "gate_rejected",
    "failure_kind must be gate_rejected for request-changes too",
  );
  assert.ok(typeof (failedEv!.payload as Record<string, unknown>).error === "string");
});

// ─── 3. No-double-emit regression ───────────────────────────────────────────
// Previously the gate reject path emitted task.failed TWICE. The engineer
// removed the duplicate call. This test locks in that fix.

test("integ failure_kind: gate reject emits task.failed EXACTLY ONCE (no-double-emit regression)", async () => {
  const wfName = "fk-gate-double-emit-wf";
  ensureGatedWorkflow(wfName);
  const runId = newRunId("fk-gate-double");
  const taskId = newTaskId("engineer");
  seedRun(runId, wfName);
  seedAwaitingGateTask(taskId, runId);

  await gate(taskId, "reject", "double-emit regression check");

  const events = eventsForTask(taskId);
  const failedEvents = events.filter((e) => e.eventType === "task.failed");
  assert.equal(
    failedEvents.length,
    1,
    `task.failed must be emitted EXACTLY ONCE; got ${failedEvents.length}. Regression: gate reject previously double-emitted.`,
  );
  assert.equal(
    (failedEvents[0]!.payload as Record<string, unknown>).failure_kind,
    "gate_rejected",
  );
});

// Also verify request-changes emits task.failed exactly once
test("integ failure_kind: gate request-changes emits task.failed EXACTLY ONCE (no-double-emit regression)", async () => {
  const wfName = "fk-gate-req-double-emit-wf";
  ensureGatedWorkflow(wfName);
  const runId = newRunId("fk-gate-req-double");
  const taskId = newTaskId("engineer");
  seedRun(runId, wfName);
  seedAwaitingGateTask(taskId, runId);

  await gate(taskId, "request-changes", "request-changes double-emit regression check");

  const events = eventsForTask(taskId);
  const failedEvents = events.filter((e) => e.eventType === "task.failed");
  assert.equal(
    failedEvents.length,
    1,
    `task.failed must be emitted EXACTLY ONCE for request-changes; got ${failedEvents.length}`,
  );
});

// ─── 4. gate reject readable end-to-end via eventsForTask ───────────────────

test("integ failure_kind: gate reject task.failed is readable via eventsForTask with gate.decided in timeline", async () => {
  const wfName = "fk-gate-readable-wf";
  ensureGatedWorkflow(wfName);
  const runId = newRunId("fk-gate-readable");
  const taskId = newTaskId("engineer");
  seedRun(runId, wfName);
  seedAwaitingGateTask(taskId, runId);

  await gate(taskId, "reject", "not meeting acceptance criteria");

  const events = eventsForTask(taskId);

  // task.failed event is present with correct payload
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be in eventsForTask timeline");
  assert.equal(failedEv!.taskId, taskId);
  assert.equal(failedEv!.runId, runId);
  assert.equal((failedEv!.payload as Record<string, unknown>).failure_kind, "gate_rejected");

  // gate.decided event is also present (confirms the full gate path ran)
  const gateEv = events.find((e) => e.eventType === "gate.decided");
  assert.ok(gateEv, "gate.decided must be in the eventsForTask timeline");
  assert.equal((gateEv!.payload as Record<string, unknown>).decision, "reject");
});

// ─── 4b. gate.decided write-path atomicity (FG-427) ─────────────────────────
// FG-427 makes the events table the sole source for outcome derivation, so
// insertGate + logEvent("gate.decided") must commit as one transaction: a
// crash between the two statements must not leave an orphaned gates row
// with no matching event. Forces the SECOND write to fail via a trigger on
// the events table (keyed off a marker embedded in the rationale, which
// flows straight into the event payload) and asserts the FIRST write was
// rolled back too.

function installForceFailTrigger(): void {
  db.exec(`
    CREATE TRIGGER force_fail_gate_decided
    BEFORE INSERT ON events
    WHEN NEW.event_type = 'gate.decided' AND NEW.payload LIKE '%FORCE_FAIL_MARKER%'
    BEGIN
      SELECT RAISE(ABORT, 'forced failure for atomicity test');
    END;
  `);
}

test("integ FG-427 atomicity: gate.decided logEvent failure rolls back insertGate (no orphaned gate row)", async () => {
  const wfName = "fk-gate-atomicity-wf";
  ensureGatedWorkflow(wfName);
  const runId = newRunId("fk-gate-atomicity");
  const taskId = newTaskId("engineer");
  seedRun(runId, wfName);
  seedAwaitingGateTask(taskId, runId);
  installForceFailTrigger();

  await assert.rejects(
    () => gate(taskId, "reject", "FORCE_FAIL_MARKER: forced failure for atomicity test"),
    /forced failure for atomicity test/,
    "gate() must propagate the forced logEvent failure",
  );

  assert.deepEqual(
    gatesForTask(taskId),
    [],
    "insertGate must be rolled back when the paired logEvent throws — no orphaned gate row",
  );
  const events = eventsForTask(taskId);
  assert.equal(
    events.filter((e) => e.eventType === "gate.decided").length,
    0,
    "no gate.decided event must be recorded when the write failed",
  );
  assert.equal(
    events.filter((e) => e.eventType === "task.failed").length,
    0,
    "downstream failTask() must not have run — the transaction failure must short-circuit gate() before decision handling",
  );
  const task = getTask(taskId)!;
  assert.equal(task.status, "awaiting_gate", "task status must be untouched — the whole write pair rolled back");
});

test("integ FG-427 atomicity: gate.decided happy path still writes both insertGate and logEvent", async () => {
  const wfName = "fk-gate-atomicity-happy-wf";
  ensureGatedWorkflow(wfName);
  const runId = newRunId("fk-gate-atomicity-happy");
  const taskId = newTaskId("engineer");
  seedRun(runId, wfName);
  seedAwaitingGateTask(taskId, runId);
  installForceFailTrigger();

  await gate(taskId, "reject", "no marker here, this rationale is unrelated to the trigger");

  const gates = gatesForTask(taskId);
  assert.equal(gates.length, 1, "insertGate must have written exactly one row on the happy path");
  assert.equal(gates[0]!.decision, "reject");

  const events = eventsForTask(taskId);
  const gateEvents = events.filter((e) => e.eventType === "gate.decided");
  assert.equal(gateEvents.length, 1, "logEvent must have written exactly one gate.decided event on the happy path");
  assert.equal((gateEvents[0]!.payload as Record<string, unknown>).decision, "reject");
});

// ─── 5. cancelled via performCancel — task-id form ───────────────────────────

test("integ failure_kind: performCancel (task-id) emits task.failed with failure_kind=cancelled", () => {
  const runId = newRunId("fk-cancel-task");
  const taskId = newTaskId("engineer");
  seedRun(runId, "feature");
  seedRunningTask(taskId, runId);

  performCancel(taskId, {}, () => { /* stub kill — no docker */ });

  const task = getTask(taskId)!;
  assert.equal(task.status, "failed", "task must be failed after cancel");

  const events = eventsForTask(taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted when task is cancelled");
  assert.equal(failedEv!.taskId, taskId);
  const payload = failedEv!.payload as Record<string, unknown>;
  assert.equal(payload.failure_kind, "cancelled", "failure_kind must be 'cancelled'");
  assert.ok(typeof payload.error === "string" && (payload.error as string).length > 0);
});

// ─── 6. cancelled via performCancel — run-id form (multiple tasks) ──────────

test("integ failure_kind: performCancel (run-id) emits task.failed with failure_kind=cancelled for each non-terminal task", () => {
  const runId = newRunId("fk-cancel-run");
  const taskId1 = newTaskId("engineer");
  const taskId2 = newTaskId("plan-reviewer");
  seedRun(runId, "feature");
  seedRunningTask(taskId1, runId);
  insertTask({
    id: taskId2,
    runId,
    phase: "review",
    agentRole: "plan-reviewer",
    status: "pending",
    taskPackage: { taskId: taskId2, runId, phase: "review", role: "plan-reviewer", inputs: {}, composedSystemPrompt: "" },
    createdAt: nowIso(),
  });

  performCancel(runId, {}, () => { /* stub kill */ });

  for (const taskId of [taskId1, taskId2]) {
    const events = eventsForTask(taskId);
    const failedEv = events.find((e) => e.eventType === "task.failed");
    assert.ok(failedEv, `task.failed must be emitted for task ${taskId}`);
    assert.equal(
      (failedEv!.payload as Record<string, unknown>).failure_kind,
      "cancelled",
      `failure_kind must be 'cancelled' for task ${taskId}`,
    );
  }
});

// ─── 7. Secrets discipline — auth_missing ───────────────────────────────────
// The task.failed payload for an auth_missing failure must contain ONLY
// { failure_kind, error } — no token, state, credential, or other material.

test("integ failure_kind: auth_missing task.failed payload has failure_kind + error ONLY (no credential material)", async () => {
  ensureClaudeRuntime();

  const r = await invoke({
    agentRole: "manual-qa",
    task: "secrets discipline test — auth missing",
    projectDir: "/tmp/fk-secrets-project",
    authProfile: "fk-secrets-missing-profile-xyz-not-created",
    dockerExec: async () => {
      throw new Error("container must NOT be spawned when auth profile is missing");
    },
  });

  assert.equal(r.status, "failed");

  const events = eventsForTask(r.taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted for auth_missing");
  const payload = failedEv!.payload as Record<string, unknown>;

  // failure_kind must be auth_missing
  assert.equal(payload.failure_kind, "auth_missing", "failure_kind must be auth_missing");

  // Payload must contain EXACTLY two keys: failure_kind + error
  const keys = Object.keys(payload).sort();
  assert.deepEqual(keys, ["error", "failure_kind"], "payload must contain ONLY failure_kind + error — no extra keys");

  // None of these sensitive key names
  const forbidden = ["token", "state", "credential", "secret", "password", "access_token", "refresh_token", "api_key", "apikey", "origins", "cookies"];
  for (const k of forbidden) {
    assert.ok(!(k in payload), `payload must NOT contain key '${k}'`);
  }

  // Error string must not contain common credential prefixes
  const errorStr = payload.error as string;
  assert.ok(!errorStr.includes("eyJ"), "error must not contain base64-encoded JWT content");
  assert.ok(!errorStr.includes("sk-ant"), "error must not contain Anthropic API key prefix");
});

// ─── 8. Secrets discipline — auth_expired ───────────────────────────────────
// Write an expired profile with real-looking credential values, then assert
// those values do NOT appear in the task.failed event payload.

test("integ failure_kind: auth_expired task.failed payload has failure_kind + error ONLY (credential values must not leak)", async () => {
  ensureClaudeRuntime();

  const profileName = "fk-secrets-expired-profile-integ";
  const fakeAccessToken = "SECRETS_INTEG_TEST_ACCESS_TOKEN_MUST_NOT_LEAK";
  const fakeRefreshToken = "SECRETS_INTEG_TEST_REFRESH_TOKEN_MUST_NOT_LEAK";

  writeProfile(profileName, {
    cookies: [],
    origins: [
      {
        origin: "http://example-test.local:9999",
        localStorage: [
          {
            name: "sb-x-auth-token",
            value: JSON.stringify({
              access_token: fakeAccessToken,
              expires_at: Math.floor(Date.now() / 1000) - 7200, // 2 hours in the past — no refresh_token, genuinely dead
            }),
          },
        ],
      },
    ],
  });

  const r = await invoke({
    agentRole: "manual-qa",
    task: "secrets discipline test — auth expired",
    projectDir: "/tmp/fk-secrets-expired-project",
    authProfile: profileName,
    dockerExec: async () => {
      throw new Error("container must NOT be spawned for an expired auth profile");
    },
  });

  assert.equal(r.status, "failed");

  const events = eventsForTask(r.taskId);
  const failedEv = events.find((e) => e.eventType === "task.failed");
  assert.ok(failedEv, "task.failed must be emitted for auth_expired");
  const payload = failedEv!.payload as Record<string, unknown>;

  // failure_kind must be auth_expired
  assert.equal(payload.failure_kind, "auth_expired", "failure_kind must be auth_expired");

  // Payload must contain EXACTLY two keys: failure_kind + error
  const keys = Object.keys(payload).sort();
  assert.deepEqual(keys, ["error", "failure_kind"], "payload must contain ONLY failure_kind + error — no extra keys");

  // The actual credential values must NOT appear anywhere in the payload
  const errorStr = payload.error as string;
  assert.ok(!errorStr.includes(fakeAccessToken), "error must NOT contain the access_token value");
  assert.ok(!errorStr.includes(fakeRefreshToken), "error must NOT contain the refresh_token value");
  assert.ok(!errorStr.includes("eyJ"), "error must not contain base64-encoded JWT content");

  // None of these sensitive key names in the payload object
  const forbidden = ["token", "state", "credential", "secret", "password", "access_token", "refresh_token", "api_key", "apikey", "origins", "cookies"];
  for (const k of forbidden) {
    assert.ok(!(k in payload), `payload must NOT contain key '${k}'`);
  }
});
