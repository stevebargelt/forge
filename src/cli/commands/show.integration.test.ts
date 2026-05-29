import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { insertVerdict } from "../../store/verdicts.js";
import { logEvent, eventsForRun, eventsForTask } from "../../store/events.js";
import { performShow } from "./show.js";
import type { Run, Task, VerdictRow } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const BASE_RUN: Run = {
  id: "run-show-integ",
  workflow: "feature",
  title: "show integration tests",
  status: "active",
  createdAt: "2026-05-29T10:00:00Z",
};

function makeTask(id: string, overrides: Partial<Omit<Task, "id" | "taskPackage">> = {}): Task {
  const runId = overrides.runId ?? BASE_RUN.id;
  return {
    id,
    runId,
    phase: overrides.phase ?? "engineer",
    agentRole: overrides.agentRole ?? "engineer",
    status: overrides.status ?? "pending",
    taskPackage: {
      taskId: id,
      runId,
      phase: overrides.phase ?? "engineer",
      role: overrides.agentRole ?? "engineer",
      inputs: { brief: "do the thing" },
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-05-29T10:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(BASE_RUN);
  insertTask(makeTask("task-si-1"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── 1. End-to-end read path ─────────────────────────────────────────────────

test("integ show: full event sequence — eventsForRun returns all events in chronological order with parsed payloads", () => {
  const verdictPayload = { verdict: "pass", confidence: 0.95, notes: "looks good" };

  logEvent("run.created", { runId: BASE_RUN.id });
  logEvent("task.created", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("verdict.received", { runId: BASE_RUN.id, taskId: "task-si-1", payload: verdictPayload });
  logEvent("task.completed", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("run.completed", { runId: BASE_RUN.id });

  const events = eventsForRun(BASE_RUN.id);

  assert.equal(events.length, 6);
  assert.equal(events[0]!.eventType, "run.created");
  assert.equal(events[1]!.eventType, "task.created");
  assert.equal(events[2]!.eventType, "task.started");
  assert.equal(events[3]!.eventType, "verdict.received");
  assert.equal(events[4]!.eventType, "task.completed");
  assert.equal(events[5]!.eventType, "run.completed");

  // payload is a parsed object, not a raw JSON string
  assert.deepEqual(events[3]!.payload, verdictPayload);
  assert.equal(typeof events[3]!.payload, "object");

  // null payloads remain null
  assert.equal(events[0]!.payload, null);
});

test("integ show: eventsForTask returns only task-scoped events — run-level events (null task_id) correctly excluded", () => {
  logEvent("run.created", { runId: BASE_RUN.id });           // task_id = null
  logEvent("task.created", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("verdict.received", {
    runId: BASE_RUN.id,
    taskId: "task-si-1",
    payload: { verdict: "pass", confidence: 0.9 },
  });
  logEvent("task.completed", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("run.completed", { runId: BASE_RUN.id });         // task_id = null

  const taskEvents = eventsForTask("task-si-1");

  // run.created and run.completed have task_id=null — must NOT appear here
  assert.equal(taskEvents.length, 4);
  assert.equal(taskEvents[0]!.eventType, "task.created");
  assert.equal(taskEvents[1]!.eventType, "task.started");
  assert.equal(taskEvents[2]!.eventType, "verdict.received");
  assert.equal(taskEvents[3]!.eventType, "task.completed");

  // every event carries the correct task_id
  for (const e of taskEvents) {
    assert.equal(e.taskId, "task-si-1");
  }

  // verdict payload is parsed back to an object
  assert.deepEqual(taskEvents[2]!.payload, { verdict: "pass", confidence: 0.9 });
});

test("integ show: eventsForRun includes events from multiple tasks in the same run", () => {
  insertTask(makeTask("task-si-2"));

  logEvent("run.created", { runId: BASE_RUN.id });
  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-2" });
  logEvent("task.completed", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("task.completed", { runId: BASE_RUN.id, taskId: "task-si-2" });

  const runEvents = eventsForRun(BASE_RUN.id);
  assert.equal(runEvents.length, 5);

  const taskIds = runEvents.map((e) => e.taskId);
  assert.ok(taskIds.includes("task-si-1"));
  assert.ok(taskIds.includes("task-si-2"));

  // eventsForTask still isolates per task
  const t1Events = eventsForTask("task-si-1");
  const t2Events = eventsForTask("task-si-2");
  assert.equal(t1Events.length, 2);
  assert.equal(t2Events.length, 2);
  for (const e of t1Events) assert.equal(e.taskId, "task-si-1");
  for (const e of t2Events) assert.equal(e.taskId, "task-si-2");
});

// ─── 2. performShow run-id branch ───────────────────────────────────────────

test("integ performShow run-id: returns run ShowResult with timeline in chronological order, task_id carried per event", () => {
  logEvent("run.created", { runId: BASE_RUN.id });
  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("task.completed", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("run.completed", { runId: BASE_RUN.id });

  const result = performShow(BASE_RUN.id);

  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  assert.equal(result.run.id, BASE_RUN.id);
  assert.equal(result.run.workflow, BASE_RUN.workflow);
  assert.equal(result.events.length, 4);

  // chronological ordering
  assert.equal(result.events[0]!.eventType, "run.created");
  assert.equal(result.events[1]!.eventType, "task.started");
  assert.equal(result.events[2]!.eventType, "task.completed");
  assert.equal(result.events[3]!.eventType, "run.completed");

  // task_id is carried on task-level events
  assert.equal(result.events[1]!.taskId, "task-si-1");
  assert.equal(result.events[2]!.taskId, "task-si-1");

  // run-level events have null taskId
  assert.equal(result.events[0]!.taskId, null);
  assert.equal(result.events[3]!.taskId, null);
});

// ─── 3. performShow task-id branch: regression check on prior output ─────────

test("integ performShow task-id: task status and verdicts STILL present after timeline addition, events appended", () => {
  // red_task_id references tasks(id) — insert the red task row first
  insertTask(makeTask("red-task-si-1", { agentRole: "security-advisor", phase: "red" }));
  const verdict: VerdictRow = {
    id: "v-si-1",
    taskId: "task-si-1",
    redTaskId: "red-task-si-1",
    redRole: "security-advisor",
    verdict: "pass",
    confidence: 0.95,
    authority: "authoritative",
    findings: [{ severity: "low", summary: "minor style issue", evidence: "line 42", hypothesis: "cosmetic" }],
    createdAt: "2026-05-29T10:05:00Z",
  };
  insertVerdict(verdict);

  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("verdict.received", { runId: BASE_RUN.id, taskId: "task-si-1", payload: { verdict: "pass" } });
  logEvent("task.completed", { runId: BASE_RUN.id, taskId: "task-si-1" });

  const result = performShow("task-si-1");

  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;

  // task identity + status preserved
  assert.equal(result.task.id, "task-si-1");
  assert.equal(result.task.runId, BASE_RUN.id);
  assert.equal(result.task.status, "pending");

  // verdicts still returned correctly
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0]!.verdict, "pass");
  assert.equal(result.verdicts[0]!.redRole, "security-advisor");
  assert.equal(result.verdicts[0]!.confidence, 0.95);
  assert.equal(result.verdicts[0]!.findings.length, 1);
  assert.equal(result.verdicts[0]!.findings[0]!.severity, "low");

  // new timeline also populated and correctly ordered
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0]!.eventType, "task.started");
  assert.equal(result.events[1]!.eventType, "verdict.received");
  assert.equal(result.events[2]!.eventType, "task.completed");
});

// ─── 4. Unknown id ───────────────────────────────────────────────────────────

test("integ performShow unknown id: returns kind=not-found with the original id", () => {
  const result = performShow("no-such-id-integ-xyz");

  assert.equal(result.kind, "not-found");
  if (result.kind !== "not-found") return;
  assert.equal(result.id, "no-such-id-integ-xyz");
});

// ─── 5. --json shape ─────────────────────────────────────────────────────────

test("integ performShow json shape task: result serialises to { task, events } with payloads as parsed objects", () => {
  const verdictPayload = { verdict: "pass", confidence: 0.95, tier: "authoritative" };
  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-1" });
  logEvent("verdict.received", { runId: BASE_RUN.id, taskId: "task-si-1", payload: verdictPayload });
  logEvent("task.completed", { runId: BASE_RUN.id, taskId: "task-si-1" });

  const result = performShow("task-si-1");
  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;

  // simulate what `--json` does in the CLI action
  const raw = JSON.stringify({ task: result.task, events: result.events }, null, 2);
  const json = JSON.parse(raw) as { task: unknown; events: Array<{ eventType: string; payload: unknown }> };

  // top-level shape: { task, events }
  assert.ok("task" in json, "json must have 'task' key");
  assert.ok("events" in json, "json must have 'events' key");
  assert.ok(!("run" in json), "json must NOT have 'run' key for task result");

  // payloads are objects in the serialised form, not double-encoded strings
  const verdictEvent = json.events.find((e) => e.eventType === "verdict.received");
  assert.ok(verdictEvent, "verdict.received event must be in json output");
  assert.deepEqual(verdictEvent!.payload, verdictPayload);
  assert.equal(typeof verdictEvent!.payload, "object");
});

test("integ performShow json shape run: result serialises to { run, events } with payloads as parsed objects", () => {
  const startPayload = { context: { env: "ci", branch: "main" } };
  logEvent("run.created", { runId: BASE_RUN.id });
  logEvent("task.started", { runId: BASE_RUN.id, taskId: "task-si-1", payload: startPayload });
  logEvent("run.completed", { runId: BASE_RUN.id });

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  // simulate what `--json` does in the CLI action
  const raw = JSON.stringify({ run: result.run, events: result.events }, null, 2);
  const json = JSON.parse(raw) as { run: unknown; events: Array<{ eventType: string; payload: unknown }> };

  // top-level shape: { run, events }
  assert.ok("run" in json, "json must have 'run' key");
  assert.ok("events" in json, "json must have 'events' key");
  assert.ok(!("task" in json), "json must NOT have 'task' key for run result");

  // payloads are objects in the serialised form, not double-encoded strings
  const taskStartedEvent = json.events.find((e) => e.eventType === "task.started");
  assert.ok(taskStartedEvent, "task.started event must be in json output");
  assert.deepEqual(taskStartedEvent!.payload, startPayload);
  assert.equal(typeof taskStartedEvent!.payload, "object");
});

// ─── 6. Empty timeline ───────────────────────────────────────────────────────

test("integ performShow: run with zero events returns empty events array without crashing", () => {
  const result = performShow(BASE_RUN.id);

  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;
  assert.deepEqual(result.events, []);
  // run details still returned correctly
  assert.equal(result.run.id, BASE_RUN.id);
  assert.equal(result.run.status, "active");
});

test("integ performShow: task with zero events returns empty events array without crashing", () => {
  const result = performShow("task-si-1");

  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.verdicts, []);
  // task details still returned correctly
  assert.equal(result.task.id, "task-si-1");
  assert.equal(result.task.status, "pending");
});
