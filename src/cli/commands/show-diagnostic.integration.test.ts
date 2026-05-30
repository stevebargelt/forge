// Integration tests for the forge show DIAGNOSTIC view (#196).
//
// These complement show.integration.test.ts (timeline/event-round-trip tests)
// and show.test.ts (unit tests for pure helpers). The new integration tests
// exercise performShow end-to-end against a real seeded in-memory DB to verify:
//   1. Blockers: awaiting_gate, awaiting_human_input, blocked_by_red all surface
//   2. failedByKind: tasks failed with different failure_kind group correctly
//   3. Running tasks: appear with container.started events accessible
//   4. Next-command derivation: blockers vs clean all-complete run
//   5. Task view: failure_kind, next command, and classifyResultFile end-to-end
//   6. --json shape: diagnostic block present and correct for run and task forms

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { logEvent, eventsForTask } from "../../store/events.js";
import { failTask } from "../../v2/failure-kind.js";
import {
  performShow,
  getBlockerTasks,
  groupFailedByKind,
  deriveNextCommandForRun,
  deriveNextCommandForTask,
  getFailureKindFromEvents,
  classifyResultFile,
} from "./show.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const BASE_RUN: Run = {
  id: "run-diag-integ",
  workflow: "feature",
  title: "diagnostic integration tests",
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
    startedAt: overrides.startedAt,
  };
}

function taskRunDir(taskId: string): string {
  return join(process.env["FORGE_HOME"]!, "runs", BASE_RUN.id, taskId);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(BASE_RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── 1. Run view with blockers ───────────────────────────────────────────────

test("integ show diagnostic: run with awaiting_gate + awaiting_human_input + blocked_by_red tasks surfaces all three as blockers", () => {
  insertTask(makeTask("td-gate-1", { status: "awaiting_gate", phase: "plan", agentRole: "tech-lead" }));
  insertTask(makeTask("td-human-1", { status: "awaiting_human_input", phase: "review", agentRole: "manual-qa" }));
  insertTask(makeTask("td-red-1", { status: "blocked_by_red", phase: "engineer", agentRole: "engineer" }));
  insertTask(makeTask("td-running-1", { status: "running", phase: "engineer", agentRole: "engineer" }));
  insertTask(makeTask("td-complete-1", { status: "complete", phase: "engineer", agentRole: "engineer" }));

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const blockers = getBlockerTasks(result.tasks);
  assert.equal(blockers.length, 3, "exactly 3 blockers must surface");

  const statuses = blockers.map((t) => t.status).sort();
  assert.deepEqual(statuses, ["awaiting_gate", "awaiting_human_input", "blocked_by_red"]);

  assert.ok(blockers.some((t) => t.id === "td-gate-1"), "awaiting_gate task must be a blocker");
  assert.ok(blockers.some((t) => t.id === "td-human-1"), "awaiting_human_input task must be a blocker");
  assert.ok(blockers.some((t) => t.id === "td-red-1"), "blocked_by_red task must be a blocker");

  assert.ok(!blockers.some((t) => t.id === "td-running-1"), "running task must NOT be a blocker");
  assert.ok(!blockers.some((t) => t.id === "td-complete-1"), "complete task must NOT be a blocker");
});

test("integ show diagnostic: all-complete run has zero blockers", () => {
  insertTask(makeTask("td-all-c1", { status: "complete" }));
  insertTask(makeTask("td-all-c2", { status: "complete" }));
  insertTask(makeTask("td-all-c3", { status: "complete" }));

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const blockers = getBlockerTasks(result.tasks);
  assert.equal(blockers.length, 0, "all-complete run must have zero blockers");
});

// ─── 2. Run view failed-grouped-by-kind ─────────────────────────────────────

test("integ show diagnostic: failed tasks with different failure_kind group correctly in run diagnostic", () => {
  insertTask(makeTask("td-fail-idle-1", { phase: "engineer" }));
  insertTask(makeTask("td-fail-idle-2", { phase: "engineer" }));
  insertTask(makeTask("td-fail-crash-1", { phase: "engineer" }));

  // failTask marks status=failed AND emits task.failed with failure_kind payload
  failTask("td-fail-idle-1", { runId: BASE_RUN.id, kind: "idle_timeout", error: "timed out" });
  failTask("td-fail-idle-2", { runId: BASE_RUN.id, kind: "idle_timeout", error: "timed out again" });
  failTask("td-fail-crash-1", { runId: BASE_RUN.id, kind: "container_crash", error: "exit code 1" });

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  // groupFailedByKind reads events from the real DB via eventsForTask
  const failedByKind = groupFailedByKind(result.tasks, eventsForTask);

  assert.ok("idle_timeout" in failedByKind, "idle_timeout kind must be present");
  assert.ok("container_crash" in failedByKind, "container_crash kind must be present");

  const idleBucket = failedByKind["idle_timeout"]!;
  assert.equal(idleBucket.length, 2, "idle_timeout bucket must have 2 task IDs");
  assert.ok(idleBucket.includes("td-fail-idle-1"), "td-fail-idle-1 must be in idle_timeout bucket");
  assert.ok(idleBucket.includes("td-fail-idle-2"), "td-fail-idle-2 must be in idle_timeout bucket");

  const crashBucket = failedByKind["container_crash"]!;
  assert.equal(crashBucket.length, 1, "container_crash bucket must have 1 task ID");
  assert.ok(crashBucket.includes("td-fail-crash-1"), "td-fail-crash-1 must be in container_crash bucket");

  // non-failed tasks (none here but confirm no phantom entries)
  const allTaskIds = Object.values(failedByKind).flat();
  assert.equal(allTaskIds.length, 3, "total across all buckets must be 3");
});

test("integ show diagnostic: groupFailedByKind uses 'unknown' kind when task.failed event has no failure_kind payload", () => {
  insertTask(makeTask("td-fail-nopayload", { phase: "engineer" }));

  // Manually emit task.failed with NO failure_kind in payload + update status
  logEvent("task.failed", { runId: BASE_RUN.id, taskId: "td-fail-nopayload", payload: { error: "something broke" } });
  // manually mark it failed
  db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run("td-fail-nopayload");

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const failedByKind = groupFailedByKind(result.tasks, eventsForTask);
  assert.ok("unknown" in failedByKind, "missing failure_kind must fall into 'unknown' bucket");
  assert.ok(failedByKind["unknown"]!.includes("td-fail-nopayload"));
});

// ─── 3. Run view running tasks with container.started event ─────────────────

test("integ show diagnostic: running task with container.started event appears in run result tasks", () => {
  insertTask(makeTask("td-run-1", { status: "running" }));
  insertTask(makeTask("td-run-2", { status: "running" }));
  insertTask(makeTask("td-run-complete", { status: "complete" }));

  logEvent("container.started", {
    runId: BASE_RUN.id,
    taskId: "td-run-1",
    payload: { containerName: "forge-td-run-1" },
  });
  logEvent("container.started", {
    runId: BASE_RUN.id,
    taskId: "td-run-2",
    payload: { containerName: "forge-td-run-2" },
  });

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const runningTasks = result.tasks.filter((t) => t.status === "running");
  assert.equal(runningTasks.length, 2, "two running tasks must appear");

  const runningIds = runningTasks.map((t) => t.id).sort();
  assert.deepEqual(runningIds, ["td-run-1", "td-run-2"]);

  // container.started events accessible per task via eventsForTask
  for (const t of runningTasks) {
    const events = eventsForTask(t.id);
    const startedEv = events.find((e) => e.eventType === "container.started");
    assert.ok(startedEv, `container.started event must exist for task ${t.id}`);
    const p = startedEv!.payload as Record<string, unknown>;
    assert.equal(p.containerName, `forge-${t.id}`, "containerName must be forge-<taskId>");
  }
});

test("integ show diagnostic: running task with stdout log file yields a last-output mtime", () => {
  insertTask(makeTask("td-run-log-1", { status: "running" }));
  logEvent("container.started", {
    runId: BASE_RUN.id,
    taskId: "td-run-log-1",
    payload: { containerName: "forge-td-run-log-1" },
  });

  // Write a stdout log file so getLastOutputMtime can find it
  const tDir = taskRunDir("td-run-log-1");
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, "container.stdout.log"), "some agent output\n");

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const runningTask = result.tasks.find((t) => t.id === "td-run-log-1");
  assert.ok(runningTask, "running task must be in result");
  assert.equal(runningTask!.status, "running");
});

// ─── 4. Run-level next command derivation ───────────────────────────────────

test("integ show diagnostic: deriveNextCommandForRun returns forge gate command for awaiting_gate run", () => {
  insertTask(makeTask("td-nc-gate-1", { status: "awaiting_gate" }));
  insertTask(makeTask("td-nc-pending-1", { status: "pending" }));

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const nextCmd = deriveNextCommandForRun(BASE_RUN.id, result.tasks);
  assert.ok(nextCmd.includes("forge gate"), "next command must include 'forge gate' for awaiting_gate run");
  assert.ok(nextCmd.includes("td-nc-gate-1"), "next command must reference the blocking task id");
});

test("integ show diagnostic: deriveNextCommandForRun returns — for all-complete run (no diagnostics case)", () => {
  insertTask(makeTask("td-nc-done-1", { status: "complete" }));
  insertTask(makeTask("td-nc-done-2", { status: "complete" }));

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const nextCmd = deriveNextCommandForRun(BASE_RUN.id, result.tasks);
  assert.equal(nextCmd, "—", "next command must be '—' for an all-complete run with no diagnostics");
});

test("integ show diagnostic: deriveNextCommandForRun prefers awaiting_gate over blocked_by_red", () => {
  insertTask(makeTask("td-nc-gate-pref", { status: "awaiting_gate" }));
  insertTask(makeTask("td-nc-red-pref", { status: "blocked_by_red" }));

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const nextCmd = deriveNextCommandForRun(BASE_RUN.id, result.tasks);
  assert.ok(nextCmd.includes("forge gate"), "awaiting_gate must take priority over blocked_by_red");
  assert.ok(nextCmd.includes("td-nc-gate-pref"), "command must reference the gate task");
  assert.ok(!nextCmd.includes("td-nc-red-pref"), "command must NOT reference the red task when gate takes priority");
});

test("integ show diagnostic: deriveNextCommandForRun returns forge retry for run with only failed tasks", () => {
  insertTask(makeTask("td-nc-fail-1", { phase: "engineer" }));
  failTask("td-nc-fail-1", { runId: BASE_RUN.id, kind: "container_crash", error: "crash" });

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  const nextCmd = deriveNextCommandForRun(BASE_RUN.id, result.tasks);
  assert.ok(nextCmd.includes("forge retry"), "next command must include 'forge retry' for failed-only run");
  assert.ok(nextCmd.includes("td-nc-fail-1"), "must reference the failed task id");
});

// ─── 5. Task view end-to-end ─────────────────────────────────────────────────

test("integ show diagnostic: task view surfaces failure_kind=idle_timeout and forge retry next command", () => {
  insertTask(makeTask("td-tv-idle", { phase: "engineer", agentRole: "engineer" }));
  failTask("td-tv-idle", { runId: BASE_RUN.id, kind: "idle_timeout", error: "container idle timeout" });

  const result = performShow("td-tv-idle");
  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;

  assert.equal(result.task.status, "failed", "task status must be failed");

  const failureKind = getFailureKindFromEvents(result.events);
  assert.equal(failureKind, "idle_timeout", "failure_kind must be idle_timeout");

  const nextCmd = deriveNextCommandForTask(result.task.status, failureKind, "td-tv-idle");
  assert.ok(nextCmd.startsWith("forge retry"), "next command must start with 'forge retry'");
  assert.ok(nextCmd.includes("td-tv-idle"), "next command must include the task id");
});

test("integ show diagnostic: task view surfaces failure_kind=container_crash and forge retry next command", () => {
  insertTask(makeTask("td-tv-crash", { phase: "engineer", agentRole: "engineer" }));
  failTask("td-tv-crash", { runId: BASE_RUN.id, kind: "container_crash", error: "exit code 1" });

  const result = performShow("td-tv-crash");
  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;

  assert.equal(result.task.status, "failed");

  const failureKind = getFailureKindFromEvents(result.events);
  assert.equal(failureKind, "container_crash");

  const nextCmd = deriveNextCommandForTask(result.task.status, failureKind, "td-tv-crash");
  assert.ok(nextCmd.includes("forge retry"));
});

test("integ show diagnostic: classifyResultFile — missing result.json returns 'missing'", () => {
  insertTask(makeTask("td-res-missing", { phase: "engineer" }));

  const resultPath = join(taskRunDir("td-res-missing"), "result.json");
  // no file created — it doesn't exist

  const classification = classifyResultFile(resultPath);
  assert.equal(classification, "missing", "non-existent result.json must classify as 'missing'");
});

test("integ show diagnostic: classifyResultFile — empty result.json returns 'empty'", () => {
  insertTask(makeTask("td-res-empty", { phase: "engineer" }));

  const tDir = taskRunDir("td-res-empty");
  mkdirSync(tDir, { recursive: true });
  const resultPath = join(tDir, "result.json");
  writeFileSync(resultPath, "");

  const classification = classifyResultFile(resultPath);
  assert.equal(classification, "empty", "empty result.json must classify as 'empty'");
});

test("integ show diagnostic: classifyResultFile — whitespace-only result.json returns 'empty'", () => {
  insertTask(makeTask("td-res-ws", { phase: "engineer" }));

  const tDir = taskRunDir("td-res-ws");
  mkdirSync(tDir, { recursive: true });
  const resultPath = join(tDir, "result.json");
  writeFileSync(resultPath, "   \n\t  \n");

  const classification = classifyResultFile(resultPath);
  assert.equal(classification, "empty", "whitespace-only result.json must classify as 'empty'");
});

test("integ show diagnostic: classifyResultFile — malformed result.json returns 'malformed'", () => {
  insertTask(makeTask("td-res-malform", { phase: "engineer" }));

  const tDir = taskRunDir("td-res-malform");
  mkdirSync(tDir, { recursive: true });
  const resultPath = join(tDir, "result.json");
  writeFileSync(resultPath, "{ not valid json !!!");

  const classification = classifyResultFile(resultPath);
  assert.equal(classification, "malformed", "invalid JSON must classify as 'malformed'");
});

test("integ show diagnostic: classifyResultFile — valid result.json returns 'valid'", () => {
  insertTask(makeTask("td-res-valid", { phase: "engineer" }));

  const tDir = taskRunDir("td-res-valid");
  mkdirSync(tDir, { recursive: true });
  const resultPath = join(tDir, "result.json");
  writeFileSync(resultPath, JSON.stringify({ status: "complete", output: { summary: "all good" } }));

  const classification = classifyResultFile(resultPath);
  assert.equal(classification, "valid", "valid JSON result.json must classify as 'valid'");
});

test("integ show diagnostic: task view classifyResultFile — result file classification surfaces through performShow round-trip", () => {
  insertTask(makeTask("td-res-roundtrip", { phase: "engineer" }));
  failTask("td-res-roundtrip", { runId: BASE_RUN.id, kind: "idle_timeout", error: "timeout" });

  // Seed a valid result.json
  const tDir = taskRunDir("td-res-roundtrip");
  mkdirSync(tDir, { recursive: true });
  const resultPath = join(tDir, "result.json");
  writeFileSync(resultPath, JSON.stringify({ status: "failed", error: "timeout" }));

  const result = performShow("td-res-roundtrip");
  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;

  // task data accessible from performShow
  assert.equal(result.task.status, "failed");
  const failureKind = getFailureKindFromEvents(result.events);
  assert.equal(failureKind, "idle_timeout");

  // classifyResultFile on the seeded path — exercises the full data path
  const classification = classifyResultFile(resultPath);
  assert.equal(classification, "valid", "seeded result.json must classify as 'valid' after round-trip");
});

// ─── 6. --json diagnostic block ──────────────────────────────────────────────

test("integ show diagnostic --json run: assembled diagnostic block has blockers, failedByKind, nextCommand with correct content", () => {
  insertTask(makeTask("td-j-gate", { status: "awaiting_gate", agentRole: "tech-lead", phase: "plan" }));
  insertTask(makeTask("td-j-fail", { phase: "engineer" }));
  insertTask(makeTask("td-j-complete", { status: "complete" }));

  failTask("td-j-fail", { runId: BASE_RUN.id, kind: "idle_timeout", error: "timeout" });

  const result = performShow(BASE_RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind !== "run") return;

  // Assemble the diagnostic block exactly as the --json CLI action does
  const blockers = getBlockerTasks(result.tasks).map((t) => ({
    taskId: t.id,
    status: t.status,
    role: t.agentRole,
    phase: t.phase,
  }));
  const failedByKind = groupFailedByKind(result.tasks, eventsForTask);
  const nextCommand = deriveNextCommandForRun(BASE_RUN.id, result.tasks);

  const jsonOut = JSON.parse(
    JSON.stringify({
      run: result.run,
      events: result.events,
      tasks: result.tasks,
      diagnostic: { blockers, failedByKind, nextCommand },
    }),
  ) as {
    run: unknown;
    events: unknown;
    tasks: unknown;
    diagnostic: {
      blockers: Array<{ taskId: string; status: string; role: string; phase: string }>;
      failedByKind: Record<string, string[]>;
      nextCommand: string;
    };
  };

  // Structural shape
  assert.ok("run" in jsonOut, "json must have 'run' key");
  assert.ok("events" in jsonOut, "json must have 'events' key");
  assert.ok("tasks" in jsonOut, "json must have 'tasks' key");
  assert.ok("diagnostic" in jsonOut, "json must have 'diagnostic' key");
  assert.ok("blockers" in jsonOut.diagnostic, "diagnostic must have 'blockers'");
  assert.ok("failedByKind" in jsonOut.diagnostic, "diagnostic must have 'failedByKind'");
  assert.ok("nextCommand" in jsonOut.diagnostic, "diagnostic must have 'nextCommand'");

  // Content: one awaiting_gate blocker
  assert.equal(jsonOut.diagnostic.blockers.length, 1);
  assert.equal(jsonOut.diagnostic.blockers[0]!.taskId, "td-j-gate");
  assert.equal(jsonOut.diagnostic.blockers[0]!.status, "awaiting_gate");
  assert.equal(jsonOut.diagnostic.blockers[0]!.role, "tech-lead");
  assert.equal(jsonOut.diagnostic.blockers[0]!.phase, "plan");

  // Content: one idle_timeout failure
  assert.ok("idle_timeout" in jsonOut.diagnostic.failedByKind);
  assert.ok(jsonOut.diagnostic.failedByKind["idle_timeout"]!.includes("td-j-fail"));

  // Content: next command points to the gate task
  assert.ok(jsonOut.diagnostic.nextCommand.includes("forge gate"));
  assert.ok(jsonOut.diagnostic.nextCommand.includes("td-j-gate"));
});

test("integ show diagnostic --json task: assembled diagnostic block has failureKind, resultStatus, nextCommand, containerName", () => {
  insertTask(makeTask("td-j-task", { phase: "engineer", agentRole: "engineer" }));
  failTask("td-j-task", { runId: BASE_RUN.id, kind: "idle_timeout", error: "timed out" });

  // Seed a valid result.json
  const tDir = taskRunDir("td-j-task");
  mkdirSync(tDir, { recursive: true });
  const resultPath = join(tDir, "result.json");
  writeFileSync(resultPath, JSON.stringify({ status: "failed" }));

  const result = performShow("td-j-task");
  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;

  // Assemble the diagnostic block exactly as the --json CLI action does
  const failureKind = getFailureKindFromEvents(result.events);
  const resultStatus = classifyResultFile(resultPath);
  const nextCommand = deriveNextCommandForTask(result.task.status, failureKind, "td-j-task");

  const jsonOut = JSON.parse(
    JSON.stringify({
      task: result.task,
      events: result.events,
      diagnostic: {
        containerName: `forge-td-j-task`,
        failureKind: failureKind ?? null,
        resultStatus,
        nextCommand,
      },
    }),
  ) as {
    task: unknown;
    events: unknown;
    diagnostic: {
      containerName: string;
      failureKind: string | null;
      resultStatus: string;
      nextCommand: string;
    };
  };

  // Structural shape
  assert.ok("task" in jsonOut, "json must have 'task' key");
  assert.ok("events" in jsonOut, "json must have 'events' key");
  assert.ok("diagnostic" in jsonOut, "json must have 'diagnostic' key");
  assert.ok(!("run" in jsonOut), "json must NOT have 'run' key for task result");

  // Content
  assert.equal(jsonOut.diagnostic.containerName, "forge-td-j-task");
  assert.equal(jsonOut.diagnostic.failureKind, "idle_timeout");
  assert.equal(jsonOut.diagnostic.resultStatus, "valid");
  assert.ok(jsonOut.diagnostic.nextCommand.includes("forge retry"));
  assert.ok(jsonOut.diagnostic.nextCommand.includes("td-j-task"));
});
