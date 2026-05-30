import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { computeMetrics, median } from "./metrics.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function mkRun(id: string, o: Partial<Run> = {}): Run {
  return { id, workflow: o.workflow ?? "feature", title: id, status: o.status ?? "complete", createdAt: o.createdAt ?? "2026-05-20T00:00:00Z", ...o };
}
function mkTask(id: string, runId: string, o: Partial<Task> = {}): Task {
  return { id, runId, phase: o.phase ?? "engineer", agentRole: o.agentRole ?? "engineer", status: o.status ?? "complete",
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-20T00:00:00Z", ...o };
}

beforeEach(() => { db = makeInMemoryDb(); prev = setDbForTest(db); });
afterEach(() => { setDbForTest(prev as DatabaseInstance); db.close(); });

test("median: odd, even, empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // round((2+3)/2)=3
  assert.equal(median([]), 0);
});

test("computeMetrics: success rate counts a run with any failed task as with-failures", () => {
  insertRun(mkRun("run-clean"));
  insertTask(mkTask("t1", "run-clean", { status: "complete" }));
  insertRun(mkRun("run-bad"));
  insertTask(mkTask("t2", "run-bad", { status: "failed" }));
  logEvent("task.failed", { runId: "run-bad", taskId: "t2", payload: { failure_kind: "container_crash" } });

  const m = computeMetrics({});
  assert.equal(m.runs.total, 2);
  assert.equal(m.runs.clean, 1);
  assert.equal(m.runs.withFailures, 1);
  assert.equal(m.runs.successRate, 0.5);
  assert.deepEqual(m.failureKinds, [{ kind: "container_crash", count: 1 }]);
});

test("computeMetrics: an active in-flight run is NOT counted as a clean success", () => {
  insertRun(mkRun("run-done", { status: "complete" }));
  insertTask(mkTask("td", "run-done", { status: "complete" }));
  insertRun(mkRun("run-live", { status: "active" }));      // in-flight, no failures yet
  insertTask(mkTask("tl", "run-live", { status: "running" }));

  const m = computeMetrics({});
  assert.equal(m.runs.total, 2);
  assert.equal(m.runs.active, 1, "the active run is tracked separately");
  assert.equal(m.runs.terminal, 1, "only the completed run is terminal");
  assert.equal(m.runs.clean, 1);
  assert.equal(m.runs.successRate, 1, "100% of TERMINAL runs are clean — active doesn't dilute or inflate");
});

test("computeMetrics: abandoned run counts as terminal-not-clean (lowers success rate)", () => {
  insertRun(mkRun("run-ok", { status: "complete" }));
  insertTask(mkTask("tok", "run-ok", { status: "complete" }));
  insertRun(mkRun("run-cancelled", { status: "abandoned" })); // cancelled, no failed task
  const m = computeMetrics({});
  assert.equal(m.runs.terminal, 2);
  assert.equal(m.runs.clean, 1, "abandoned is never clean even without a failed task");
  assert.equal(m.runs.successRate, 0.5);
});

test("computeMetrics: idle_timeout failures counted as idle kills", () => {
  insertRun(mkRun("run-idle"));
  insertTask(mkTask("ti", "run-idle", { status: "failed" }));
  logEvent("task.failed", { runId: "run-idle", taskId: "ti", payload: { failure_kind: "idle_timeout" } });
  const m = computeMetrics({});
  assert.equal(m.counts.idleKills, 1);
  assert.equal(m.failureKinds[0]!.kind, "idle_timeout");
});

test("computeMetrics: median durations grouped by dimension", () => {
  insertRun(mkRun("run-d", { workflow: "feature" }));
  // two engineer tasks (10s, 30s → median 20s) and one review task (40s)
  insertTask(mkTask("e1", "run-d", { phase: "engineer", startedAt: "2026-05-20T00:00:00Z", completedAt: "2026-05-20T00:00:10Z" }));
  insertTask(mkTask("e2", "run-d", { phase: "engineer", startedAt: "2026-05-20T00:00:00Z", completedAt: "2026-05-20T00:00:30Z" }));
  insertTask(mkTask("r1", "run-d", { phase: "review", startedAt: "2026-05-20T00:00:00Z", completedAt: "2026-05-20T00:00:40Z" }));
  const m = computeMetrics({ by: "phase" });
  const eng = m.durations.find((d) => d.dimension === "engineer")!;
  const rev = m.durations.find((d) => d.dimension === "review")!;
  assert.equal(eng.count, 2);
  assert.equal(eng.medianMs, 20_000);
  assert.equal(rev.medianMs, 40_000);
});

test("computeMetrics: operational counts from events (cancels, retries, red blocks)", () => {
  insertRun(mkRun("run-ops"));
  insertTask(mkTask("to", "run-ops", { status: "complete" }));
  logEvent("task.cancelled", { runId: "run-ops", taskId: "to" });
  logEvent("task.retried", { runId: "run-ops", taskId: "to" });
  logEvent("task.blocked_by_red", { runId: "run-ops", taskId: "to" });
  const m = computeMetrics({});
  assert.equal(m.counts.cancels, 1);
  assert.equal(m.counts.retries, 1);
  assert.equal(m.counts.redBlocks, 1);
});

test("computeMetrics: respects since + workflow filters", () => {
  insertRun(mkRun("old", { createdAt: "2026-04-01T00:00:00Z", workflow: "feature" }));
  insertRun(mkRun("new-f", { createdAt: "2026-05-20T00:00:00Z", workflow: "feature" }));
  insertRun(mkRun("new-i", { createdAt: "2026-05-20T00:00:00Z", workflow: "investigation" }));
  const cutoff = new Date("2026-05-01T00:00:00Z").getTime();
  assert.equal(computeMetrics({ sinceMs: cutoff }).runs.total, 2);
  assert.equal(computeMetrics({ sinceMs: cutoff, workflow: "feature" }).runs.total, 1);
});
