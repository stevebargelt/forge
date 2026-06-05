import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { taskDir } from "../../util/paths.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import type { Event } from "../../store/events.js";
import {
  performShow,
  getFailureKindFromEvents,
  classifyResultFile,
  computeElapsed,
  formatTimeAgo,
  tailLines,
  getManifestIdleTimeoutMs,
  computeIdleCountdown,
  formatIdleCountdown,
  liveIdleCountdownForTask,
  listPresentArtifacts,
  deriveNextCommandForTask,
  deriveNextCommandForRun,
  groupFailedByKind,
  getBlockerTasks,
  showReconcileStep,
} from "./show.js";
import { getTask } from "../../store/tasks.js";
import { eventsForTask } from "../../store/events.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let tmpDir: string;

const RUN: Run = {
  id: "run-show-test",
  workflow: "feature",
  title: "show test run",
  status: "active",
  createdAt: "2026-05-29T10:00:00Z",
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    runId: RUN.id,
    phase: overrides.phase ?? "engineer",
    agentRole: overrides.agentRole ?? "engineer",
    status: overrides.status ?? "pending",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: overrides.phase ?? "engineer",
      role: overrides.agentRole ?? "engineer",
      inputs: { brief: "do the thing" },
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-05-29T10:00:00Z",
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    error: overrides.error,
  };
}

function makeEvent(type: string, payload?: unknown): Event {
  return {
    id: 1,
    runId: RUN.id,
    taskId: "task-x",
    eventType: type as Event["eventType"],
    payload: payload ?? null,
    createdAt: "2026-05-29T10:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  tmpDir = mkdtempSync(join(tmpdir(), "forge-show-test-"));
  insertRun(RUN);
  insertTask(makeTask("task-show-1"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("performShow with task id returns kind=task with task and events", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.equal(result.task.id, "task-show-1");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.eventType, "task.started");
  }
});

test("performShow with run id returns kind=run with run and events", () => {
  logEvent("run.created", { runId: RUN.id });
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.run.id, RUN.id);
    assert.equal(result.run.workflow, "feature");
    assert.equal(result.events.length, 2);
  }
});

test("performShow with unknown id returns kind=not-found", () => {
  const result = performShow("no-such-id-xyz");
  assert.equal(result.kind, "not-found");
  if (result.kind === "not-found") {
    assert.equal(result.id, "no-such-id-xyz");
  }
});

test("performShow task result includes verdicts array (empty when none)", () => {
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.deepEqual(result.verdicts, []);
  }
});

test("performShow run result has events with taskId populated when present", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.events[0]!.taskId, "task-show-1");
  }
});

test("performShow task result events are empty when none logged", () => {
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.deepEqual(result.events, []);
  }
});

test("performShow run result events are empty when none logged", () => {
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.deepEqual(result.events, []);
  }
});

test("performShow: task id takes priority over run id when both could match", () => {
  // Task is looked up first; if a task exists for the id, kind=task is returned
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
});

test("performShow: run result includes tasks array", () => {
  insertTask(makeTask("task-show-2"));
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.tasks.length, 2);
  }
});

// ─── getFailureKindFromEvents ────────────────────────────────────────────────

test("getFailureKindFromEvents: returns failure_kind from task.failed payload", () => {
  const events: Event[] = [
    makeEvent("task.started"),
    makeEvent("task.failed", { failure_kind: "idle_timeout", error: "no output" }),
  ];
  assert.equal(getFailureKindFromEvents(events), "idle_timeout");
});

test("getFailureKindFromEvents: returns undefined when no task.failed event", () => {
  const events: Event[] = [makeEvent("task.started"), makeEvent("task.completed")];
  assert.equal(getFailureKindFromEvents(events), undefined);
});

test("getFailureKindFromEvents: returns undefined when payload has no failure_kind", () => {
  const events: Event[] = [makeEvent("task.failed", { error: "something" })];
  assert.equal(getFailureKindFromEvents(events), undefined);
});

test("getFailureKindFromEvents: returns undefined when payload is null", () => {
  const events: Event[] = [makeEvent("task.failed", null)];
  assert.equal(getFailureKindFromEvents(events), undefined);
});

test("getFailureKindFromEvents: returns container_crash from payload", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "container_crash", error: "exit 137" }),
  ];
  assert.equal(getFailureKindFromEvents(events), "container_crash");
});

test("getFailureKindFromEvents: picks the LATEST task.failed after a retry, not the stale first", () => {
  const events: Event[] = [
    makeEvent("task.started"),
    makeEvent("task.failed", { failure_kind: "idle_timeout" }),
    makeEvent("task.retried"),
    makeEvent("task.started"),
    makeEvent("task.failed", { failure_kind: "container_crash" }),
  ];
  assert.equal(getFailureKindFromEvents(events), "container_crash");
});

test("getFailureKindFromEvents: returns undefined when a later task.completed supersedes an earlier failure", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "model_error" }),
    makeEvent("task.retried"),
    makeEvent("task.completed"),
  ];
  assert.equal(getFailureKindFromEvents(events), undefined);
});

test("getFailureKindFromEvents: failure_kind round-trip via DB events", () => {
  insertTask(makeTask("task-fk-roundtrip", { status: "failed" }));
  logEvent("task.failed", {
    runId: RUN.id,
    taskId: "task-fk-roundtrip",
    payload: { failure_kind: "gate_rejected", error: "rejected" },
  });
  const result = performShow("task-fk-roundtrip");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.equal(getFailureKindFromEvents(result.events), "gate_rejected");
  }
});

// ─── classifyResultFile ──────────────────────────────────────────────────────

test("classifyResultFile: missing when file does not exist", () => {
  assert.equal(classifyResultFile(join(tmpDir, "no-such-file.json")), "missing");
});

test("classifyResultFile: empty when file exists but is blank", () => {
  const p = join(tmpDir, "empty.json");
  writeFileSync(p, "");
  assert.equal(classifyResultFile(p), "empty");
});

test("classifyResultFile: empty when file contains only whitespace", () => {
  const p = join(tmpDir, "whitespace.json");
  writeFileSync(p, "   \n  ");
  assert.equal(classifyResultFile(p), "empty");
});

test("classifyResultFile: malformed when file contains invalid JSON", () => {
  const p = join(tmpDir, "bad.json");
  writeFileSync(p, "not valid json {{{");
  assert.equal(classifyResultFile(p), "malformed");
});

test("classifyResultFile: valid when file contains valid JSON object", () => {
  const p = join(tmpDir, "good.json");
  writeFileSync(p, JSON.stringify({ status: "complete" }));
  assert.equal(classifyResultFile(p), "valid");
});

test("classifyResultFile: valid when file contains valid JSON array", () => {
  const p = join(tmpDir, "arr.json");
  writeFileSync(p, "[]");
  assert.equal(classifyResultFile(p), "valid");
});

// ─── computeElapsed ─────────────────────────────────────────────────────────

test("computeElapsed: returns — when no startedAt", () => {
  assert.equal(computeElapsed(undefined, undefined, 1000), "—");
});

test("computeElapsed: uses completedAt when provided", () => {
  const start = "2026-05-29T10:00:00Z";
  const end = "2026-05-29T10:05:00Z";
  assert.equal(computeElapsed(start, end), "5m");
});

test("computeElapsed: injectable now for determinism", () => {
  const startMs = 1000;
  const nowMs = startMs + 10 * 60 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "10m");
});

test("computeElapsed: formats seconds for short elapsed", () => {
  const startMs = 1000;
  const nowMs = startMs + 45 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "45s");
});

test("computeElapsed: formats hours correctly", () => {
  const startMs = 1000;
  const nowMs = startMs + 90 * 60 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "1h 30m");
});

test("computeElapsed: exact hour with no trailing minutes", () => {
  const startMs = 1000;
  const nowMs = startMs + 60 * 60 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "1h");
});

// ─── formatTimeAgo ───────────────────────────────────────────────────────────

test("formatTimeAgo: seconds ago for < 60s", () => {
  const now = 60000;
  assert.equal(formatTimeAgo(now - 30000, now), "30s ago");
});

test("formatTimeAgo: minutes ago for < 60m", () => {
  const now = 120 * 60 * 1000;
  assert.equal(formatTimeAgo(now - 11 * 60 * 1000, now), "11m ago");
});

test("formatTimeAgo: hours ago for >= 60m", () => {
  const now = 200 * 60 * 1000;
  assert.equal(formatTimeAgo(now - 75 * 60 * 1000, now), "1h 15m ago");
});

test("formatTimeAgo: exact hour with no trailing minutes", () => {
  const now = 200 * 60 * 1000;
  assert.equal(formatTimeAgo(now - 60 * 60 * 1000, now), "1h ago");
});

// ─── listPresentArtifacts ────────────────────────────────────────────────────

test("listPresentArtifacts: returns only files that exist", () => {
  writeFileSync(join(tmpDir, "result.json"), "{}");
  writeFileSync(join(tmpDir, "container.stdout.log"), "hello\n");
  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"));
  assert.ok(artifacts.includes("container.stdout.log"));
  assert.ok(!artifacts.includes("CLAUDE.md"));
  assert.ok(!artifacts.includes("container.stderr.log"));
});

test("listPresentArtifacts: empty when no known files present", () => {
  assert.deepEqual(listPresentArtifacts(tmpDir), []);
});

test("listPresentArtifacts: returns all five known files when all present", () => {
  for (const f of ["CLAUDE.md", "package.md", "result.json", "container.stdout.log", "container.stderr.log"]) {
    writeFileSync(join(tmpDir, f), "");
  }
  assert.equal(listPresentArtifacts(tmpDir).length, 5);
});

test("listPresentArtifacts: reads from manifest.json when present (authoritative)", () => {
  const manifest = {
    taskId: "t-manifest",
    runId: "r-manifest",
    files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
    container: { name: "forge-t-manifest" },
    auth: { profileRequested: false, stateMounted: false },
  };
  writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify(manifest));
  // Only create two of the five files
  writeFileSync(join(tmpDir, "result.json"), "{}");
  writeFileSync(join(tmpDir, "CLAUDE.md"), "prompt");

  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"), "result.json must be listed when present");
  assert.ok(artifacts.includes("CLAUDE.md"), "CLAUDE.md must be listed when present");
  assert.ok(!artifacts.includes("container.stdout.log"), "missing file must not appear");
});

test("listPresentArtifacts: falls back to direct read when manifest.json absent", () => {
  writeFileSync(join(tmpDir, "result.json"), "{}");
  writeFileSync(join(tmpDir, "package.md"), "");
  // No manifest.json
  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"));
  assert.ok(artifacts.includes("package.md"));
  assert.ok(!artifacts.includes("CLAUDE.md"));
});

test("listPresentArtifacts: falls back gracefully when manifest.json is malformed", () => {
  writeFileSync(join(tmpDir, "manifest.json"), "not json {{{");
  writeFileSync(join(tmpDir, "result.json"), "{}");
  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"), "fallback must still return present files");
});

// ─── tailLines ───────────────────────────────────────────────────────────────

test("tailLines: returns last N lines", () => {
  const p = join(tmpDir, "log.txt");
  writeFileSync(p, "a\nb\nc\nd\ne\nf\n");
  assert.deepEqual(tailLines(p, 3), ["d", "e", "f"]);
});

test("tailLines: returns all lines if fewer than N", () => {
  const p = join(tmpDir, "short.txt");
  writeFileSync(p, "x\ny\n");
  assert.deepEqual(tailLines(p, 5), ["x", "y"]);
});

test("tailLines: returns [] when file does not exist", () => {
  assert.deepEqual(tailLines(join(tmpDir, "nope.txt"), 5), []);
});

// ─── computeIdleCountdown / formatIdleCountdown (WALK-1) ─────────────────────

const T0 = 1_700_000_000_000; // fixed "now" base for deterministic math

test("computeIdleCountdown: fresh output — most of the budget remains", () => {
  const c = computeIdleCountdown(T0 - 10_000, 900_000, T0); // 10s idle, 15m timeout
  assert.equal(c.hasOutput, true);
  assert.equal(c.idleMs, 10_000);
  assert.equal(c.remainingMs, 890_000);
  assert.equal(c.expired, false);
});

test("computeIdleCountdown: idle past the timeout — expired, remaining clamped to 0", () => {
  const c = computeIdleCountdown(T0 - 1_000_000, 900_000, T0); // 16m40s idle > 15m
  assert.equal(c.expired, true);
  assert.equal(c.remainingMs, 0);
});

test("computeIdleCountdown: exactly at the timeout boundary counts as expired", () => {
  const c = computeIdleCountdown(T0 - 900_000, 900_000, T0);
  assert.equal(c.expired, true);
  assert.equal(c.remainingMs, 0);
});

test("computeIdleCountdown: no output and no spawn baseline → unmeasured, full budget", () => {
  const c = computeIdleCountdown(undefined, 900_000, T0);
  assert.equal(c.hasOutput, false);
  assert.equal(c.measured, false);
  assert.equal(c.idleMs, 0);
  assert.equal(c.remainingMs, 900_000);
  assert.equal(c.expired, false);
});

// The core no-output-hung-agent fix: a running task that NEVER emits stdout must
// still count idle from spawn and expire — not sit at a full budget forever.
test("computeIdleCountdown: no output but spawn baseline → idle measured from spawn, can expire", () => {
  const c = computeIdleCountdown(undefined, 900_000, T0, T0 - 1_000_000); // spawned 16m40s ago
  assert.equal(c.hasOutput, false, "still no stdout");
  assert.equal(c.measured, true, "measured from spawn baseline");
  assert.equal(c.idleMs, 1_000_000);
  assert.equal(c.remainingMs, 0);
  assert.equal(c.expired, true, "hung-from-spawn agent past its budget is expired");
});

test("computeIdleCountdown: stdout mtime takes precedence over spawn baseline", () => {
  const c = computeIdleCountdown(T0 - 10_000, 900_000, T0, T0 - 1_000_000);
  assert.equal(c.idleMs, 10_000, "measures from last output, not the older spawn time");
  assert.equal(c.hasOutput, true);
});

test("formatIdleCountdown: renders left/expired/no-output/awaiting variants distinctly", () => {
  assert.match(formatIdleCountdown(computeIdleCountdown(T0 - 10_000, 900_000, T0)), /left/);
  assert.match(formatIdleCountdown(computeIdleCountdown(T0 - 1_000_000, 900_000, T0)), /exhausted/);
  assert.match(formatIdleCountdown(computeIdleCountdown(undefined, 900_000, T0, T0 - 5_000)), /no output yet/);
  assert.match(formatIdleCountdown(computeIdleCountdown(undefined, 900_000, T0)), /awaiting start/);
});

test("liveIdleCountdownForTask: running task → countdown from its stdout mtime + manifest timeout", () => {
  const t = makeTask("task-live-run", { status: "running" });
  const dir = taskDir(t.runId, t.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ container: { name: "forge-x", idleTimeoutMs: 600_000 } }));
  writeFileSync(join(dir, "container.stdout.log"), "some output\n");
  const c = liveIdleCountdownForTask(t);
  assert.ok(c, "running task must yield a countdown");
  assert.equal(c!.hasOutput, true);
  // Budget reflects the manifest's recorded timeout, not the global default.
  assert.equal(c!.remainingMs + c!.idleMs, 600_000);
});

test("liveIdleCountdownForTask: terminal task → undefined (countdown is meaningless once done)", () => {
  const t = makeTask("task-live-done", { status: "complete" });
  assert.equal(liveIdleCountdownForTask(t), undefined);
});

// ─── getManifestIdleTimeoutMs ────────────────────────────────────────────────

test("getManifestIdleTimeoutMs: reads container.idleTimeoutMs from manifest.json", () => {
  writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify({ container: { name: "forge-x", idleTimeoutMs: 420000 } }));
  assert.equal(getManifestIdleTimeoutMs(tmpDir), 420000);
});

test("getManifestIdleTimeoutMs: returns undefined for a pre-#202 manifest without the field", () => {
  writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify({ container: { name: "forge-x" } }));
  assert.equal(getManifestIdleTimeoutMs(tmpDir), undefined);
});

test("getManifestIdleTimeoutMs: returns undefined when no manifest exists", () => {
  assert.equal(getManifestIdleTimeoutMs(join(tmpDir, "no-such-dir")), undefined);
});

test("tailLines: returns the correct last N lines from a file larger than the read bound", () => {
  // Build a log well past the 64KB tail window so the bounded read is exercised.
  const p = join(tmpDir, "big.log");
  const filler = "x".repeat(2000); // ~2KB per line → ~200KB total
  const lines = Array.from({ length: 100 }, (_, i) => `line${i}-${filler}`);
  writeFileSync(p, lines.join("\n") + "\n");
  const tail = tailLines(p, 3);
  assert.deepEqual(
    tail.map((l) => l.split("-")[0]),
    ["line97", "line98", "line99"],
    "tails the true last lines even though the file exceeds the read window",
  );
  // Every returned line is whole — no truncated leading fragment leaks through.
  assert.ok(tail.every((l) => l.endsWith(filler)), "no partial line in the tail");
});

// ─── deriveNextCommandForTask ────────────────────────────────────────────────

test("deriveNextCommandForTask: failed+idle_timeout → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "idle_timeout", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+container_crash → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "container_crash", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+result_missing → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "result_missing", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+result_malformed → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "result_malformed", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+red_blocked → show red task + gate", () => {
  const cmd = deriveNextCommandForTask("failed", "red_blocked", "task-abc");
  assert.match(cmd, /forge show/);
  assert.match(cmd, /forge gate task-abc/);
});

test("deriveNextCommandForTask: failed+undefined failure_kind → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", undefined, "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: awaiting_gate → forge gate --advance | --reject", () => {
  const cmd = deriveNextCommandForTask("awaiting_gate", undefined, "task-abc");
  assert.match(cmd, /forge gate task-abc/);
  assert.match(cmd, /--advance/);
});

test("deriveNextCommandForTask: blocked_by_red → forge show red task + gate", () => {
  const cmd = deriveNextCommandForTask("blocked_by_red", undefined, "task-abc");
  assert.match(cmd, /forge show/);
  assert.match(cmd, /forge gate task-abc/);
});

test("deriveNextCommandForTask: awaiting_human_input → forge gate --advance", () => {
  assert.match(deriveNextCommandForTask("awaiting_human_input", undefined, "task-abc"), /forge gate task-abc --advance/);
});

test("deriveNextCommandForTask: complete → —", () => {
  assert.equal(deriveNextCommandForTask("complete", undefined, "task-abc"), "—");
});

// ─── deriveNextCommandForRun ─────────────────────────────────────────────────

test("deriveNextCommandForRun: awaiting_gate first priority", () => {
  const tasks: Task[] = [
    makeTask("t-gate", { status: "awaiting_gate" }),
    makeTask("t-fail", { status: "failed" }),
  ];
  assert.match(deriveNextCommandForRun(RUN.id, tasks), /forge gate t-gate/);
});

test("deriveNextCommandForRun: blocked_by_red is second priority", () => {
  const tasks: Task[] = [
    makeTask("t-red", { status: "blocked_by_red" }),
    makeTask("t-fail", { status: "failed" }),
  ];
  assert.match(deriveNextCommandForRun(RUN.id, tasks), /forge show t-red/);
});

test("deriveNextCommandForRun: failed task → forge retry", () => {
  const tasks: Task[] = [
    makeTask("t-fail", { status: "failed" }),
    makeTask("t-ok", { status: "complete" }),
  ];
  assert.match(deriveNextCommandForRun(RUN.id, tasks), /forge retry t-fail/);
});

test("deriveNextCommandForRun: only running → show run with count", () => {
  const tasks: Task[] = [makeTask("t-run", { status: "running" })];
  const cmd = deriveNextCommandForRun(RUN.id, tasks);
  assert.match(cmd, /forge show.*1 task/);
});

test("deriveNextCommandForRun: all complete → —", () => {
  assert.equal(deriveNextCommandForRun(RUN.id, [makeTask("t", { status: "complete" })]), "—");
});

test("deriveNextCommandForRun: empty tasks → —", () => {
  assert.equal(deriveNextCommandForRun(RUN.id, []), "—");
});

// ─── groupFailedByKind ───────────────────────────────────────────────────────

test("groupFailedByKind: groups failed tasks by failure_kind", () => {
  const eventsMap: Record<string, Event[]> = {
    "t-a": [makeEvent("task.failed", { failure_kind: "idle_timeout" })],
    "t-b": [makeEvent("task.failed", { failure_kind: "container_crash" })],
    "t-c": [makeEvent("task.failed", { failure_kind: "idle_timeout" })],
  };
  const tasks: Task[] = [
    makeTask("t-a", { status: "failed" }),
    makeTask("t-b", { status: "failed" }),
    makeTask("t-c", { status: "failed" }),
  ];
  const result = groupFailedByKind(tasks, (id) => eventsMap[id] ?? []);
  assert.deepEqual((result["idle_timeout"] ?? []).sort(), ["t-a", "t-c"]);
  assert.deepEqual(result["container_crash"], ["t-b"]);
});

test("groupFailedByKind: uses unknown when no failure_kind in events", () => {
  const tasks: Task[] = [makeTask("t-a", { status: "failed" })];
  assert.deepEqual(groupFailedByKind(tasks, () => []), { unknown: ["t-a"] });
});

test("groupFailedByKind: ignores non-failed tasks", () => {
  const tasks: Task[] = [
    makeTask("t-ok", { status: "complete" }),
    makeTask("t-run", { status: "running" }),
    makeTask("t-fail", { status: "failed" }),
  ];
  const result = groupFailedByKind(tasks, () => [makeEvent("task.failed", { failure_kind: "model_error" })]);
  assert.deepEqual(Object.values(result).flat(), ["t-fail"]);
});

test("groupFailedByKind: empty tasks → empty object", () => {
  assert.deepEqual(groupFailedByKind([], () => []), {});
});

// ─── getBlockerTasks ─────────────────────────────────────────────────────────

test("getBlockerTasks: returns awaiting_gate, awaiting_human_input, blocked_by_red", () => {
  const tasks: Task[] = [
    makeTask("t1", { status: "awaiting_gate" }),
    makeTask("t2", { status: "awaiting_human_input" }),
    makeTask("t3", { status: "blocked_by_red" }),
    makeTask("t4", { status: "running" }),
    makeTask("t5", { status: "failed" }),
    makeTask("t6", { status: "complete" }),
  ];
  const ids = getBlockerTasks(tasks).map((t) => t.id).sort();
  assert.deepEqual(ids, ["t1", "t2", "t3"]);
});

test("getBlockerTasks: empty when no blockers", () => {
  assert.deepEqual(getBlockerTasks([makeTask("t1", { status: "running" })]), []);
});

// ── #298: forge show is read-only by default; reconcile must be explicit ──────
// Regression: in Pixtron, `forge show task-engineer-b26b0f --json` reconciled the
// task to complete at the inspection timestamp — a read action mutated state.

function setupStaleRunning(taskId: string, withResult: boolean): void {
  insertTask(makeTask(taskId, { status: "running", startedAt: "2026-05-29T10:00:00Z" }));
  logEvent("container.started", { runId: RUN.id, taskId }); // proves it was containerized
  if (withResult) {
    const dir = taskDir(RUN.id, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
  }
}

test("#298: plain forge show is read-only — surfaces the candidate, emits no task.reconciled (Pixtron regression)", () => {
  setupStaleRunning("task-engineer-b26b0f", true); // the actual incident id
  const { reconciled, candidateReason } = showReconcileStep("task-engineer-b26b0f", {}, { probe: () => "gone" });
  assert.equal(reconciled, false);
  assert.equal(candidateReason, "container_gone_result_present");
  // No mutation: still running, no reconcile event written by the read path.
  assert.equal(getTask("task-engineer-b26b0f")!.status, "running");
  assert.equal(eventsForTask("task-engineer-b26b0f").filter((e) => e.eventType === "task.reconciled").length, 0);
});

test("#298: plain show surfaces container_gone_no_result when no result.json exists", () => {
  setupStaleRunning("task-orphan-298", false);
  const { candidateReason } = showReconcileStep("task-orphan-298", {}, { probe: () => "gone" });
  assert.equal(candidateReason, "container_gone_no_result");
  assert.equal(getTask("task-orphan-298")!.status, "running");
});

test("#298: --reconcile is the explicit mutating path — finalizes + emits task.reconciled", () => {
  setupStaleRunning("task-reconcile-298", true);
  const { reconciled } = showReconcileStep("task-reconcile-298", { reconcile: true }, { containerAlive: () => false });
  assert.equal(reconciled, true);
  assert.equal(getTask("task-reconcile-298")!.status, "complete");
  assert.equal(eventsForTask("task-reconcile-298").filter((e) => e.eventType === "task.reconciled").length, 1);
});

test("#298: a healthy running task (container alive) is not a candidate and is not mutated", () => {
  setupStaleRunning("task-live-298", true);
  const { reconciled, candidateReason } = showReconcileStep("task-live-298", {}, { probe: () => "alive" });
  assert.equal(reconciled, false);
  assert.equal(candidateReason, null);
  assert.equal(getTask("task-live-298")!.status, "running");
  assert.equal(eventsForTask("task-live-298").filter((e) => e.eventType === "task.reconciled").length, 0);
});

test("#298: a completed task is never probed or reconciled by plain show", () => {
  insertTask(makeTask("task-done-298", { status: "complete", completedAt: "2026-05-29T11:00:00Z" }));
  let probed = false;
  const { reconciled, candidateReason } = showReconcileStep("task-done-298", {}, { probe: () => { probed = true; return "gone"; } });
  assert.equal(reconciled, false);
  assert.equal(candidateReason, null);
  assert.equal(probed, false, "a non-running task must not be docker-probed");
});
