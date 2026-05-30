import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { queryRuns, parseSince } from "./runs-query.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function mkRun(id: string, o: Partial<Run> = {}): Run {
  return { id, workflow: o.workflow ?? "feature", title: o.title ?? id, status: o.status ?? "complete", createdAt: o.createdAt ?? "2026-05-20T00:00:00Z", ...o };
}
function mkTask(id: string, runId: string, o: Partial<Task> = {}): Task {
  return { id, runId, phase: "engineer", agentRole: "engineer", status: o.status ?? "complete",
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-20T00:00:00Z", ...o };
}

beforeEach(() => { db = makeInMemoryDb(); prev = setDbForTest(db); });
afterEach(() => { setDbForTest(prev as DatabaseInstance); db.close(); });

// ─── parseSince ──────────────────────────────────────────────────────────────

test("parseSince: 'all' → undefined, '7d' → now-7d, bad input throws", () => {
  const now = 1_700_000_000_000;
  assert.equal(parseSince("all", now), undefined);
  assert.equal(parseSince("7d", now), now - 7 * 86_400_000);
  assert.throws(() => parseSince("yesterday", now));
  assert.throws(() => parseSince("7", now));
});

// ─── queryRuns filters ───────────────────────────────────────────────────────

test("queryRuns: filters by status and returns most-recent-first", () => {
  insertRun(mkRun("run-a", { status: "complete", createdAt: "2026-05-01T00:00:00Z" }));
  insertRun(mkRun("run-b", { status: "abandoned", createdAt: "2026-05-10T00:00:00Z" }));
  insertRun(mkRun("run-c", { status: "complete", createdAt: "2026-05-20T00:00:00Z" }));
  const complete = queryRuns({ status: "complete" });
  assert.deepEqual(complete.map((r) => r.run.id), ["run-c", "run-a"], "complete only, newest first");
  assert.deepEqual(queryRuns({ status: "abandoned" }).map((r) => r.run.id), ["run-b"]);
});

test("queryRuns: filters by since cutoff", () => {
  insertRun(mkRun("run-old", { createdAt: "2026-04-01T00:00:00Z" }));
  insertRun(mkRun("run-new", { createdAt: "2026-05-20T00:00:00Z" }));
  const cutoff = new Date("2026-05-01T00:00:00Z").getTime();
  assert.deepEqual(queryRuns({ sinceMs: cutoff }).map((r) => r.run.id), ["run-new"]);
});

test("queryRuns: filters by project (exact path and bare-name basename)", () => {
  insertRun(mkRun("run-app", { projectDir: "/Users/me/code/app" }));
  insertRun(mkRun("run-other", { projectDir: "/Users/me/code/other" }));
  assert.deepEqual(queryRuns({ project: "/Users/me/code/app" }).map((r) => r.run.id), ["run-app"]);
  assert.deepEqual(queryRuns({ project: "app" }).map((r) => r.run.id), ["run-app"], "bare name → basename match");
});

test("queryRuns: a full-path project filter does NOT degrade to basename (cross-repo name collision)", () => {
  insertRun(mkRun("run-a", { projectDir: "/Users/me/work/app" }));
  insertRun(mkRun("run-b", { projectDir: "/Users/me/personal/app" })); // same basename, different repo
  // A FULL path must match only the exact repo, not the other "app".
  assert.deepEqual(queryRuns({ project: "/Users/me/work/app" }).map((r) => r.run.id), ["run-a"]);
  assert.deepEqual(queryRuns({ project: "/Users/me/personal/app" }).map((r) => r.run.id), ["run-b"]);
  // A bare name still matches both (intentional convenience).
  assert.equal(queryRuns({ project: "app" }).length, 2, "bare name is the deliberate basename shortcut");
});

test("queryRuns: filters by workflow", () => {
  insertRun(mkRun("run-f", { workflow: "feature" }));
  insertRun(mkRun("run-i", { workflow: "investigation" }));
  assert.deepEqual(queryRuns({ workflow: "investigation" }).map((r) => r.run.id), ["run-i"]);
});

// ─── failure_kind scan ───────────────────────────────────────────────────────

test("queryRuns: summarizes failed tasks + filters by failure_kind from events", () => {
  insertRun(mkRun("run-fk", { status: "complete" }));
  insertTask(mkTask("task-ok", "run-fk", { status: "complete" }));
  insertTask(mkTask("task-bad", "run-fk", { status: "failed" }));
  logEvent("task.failed", { runId: "run-fk", taskId: "task-bad", payload: { failure_kind: "idle_timeout", error: "hang" } });

  insertRun(mkRun("run-clean", { status: "complete" }));
  insertTask(mkTask("task-good", "run-clean", { status: "complete" }));

  const fk = queryRuns({ failureKind: "idle_timeout" });
  assert.deepEqual(fk.map((r) => r.run.id), ["run-fk"], "only the run with that failure kind");
  assert.equal(fk[0]!.failedCount, 1);
  assert.deepEqual(fk[0]!.failureKinds, ["idle_timeout"]);

  assert.equal(queryRuns({ failureKind: "container_crash" }).length, 0, "no run has this kind");
  // run-clean still appears in an unfiltered query with zero failures
  const all = queryRuns({});
  assert.equal(all.find((r) => r.run.id === "run-clean")!.failedCount, 0);
});

test("queryRuns: failure_kind scan ignores failed CHILD tasks (top-level only)", () => {
  insertRun(mkRun("run-child", { status: "complete" }));
  insertTask(mkTask("task-parent", "run-child", { status: "complete" }));
  insertTask(mkTask("task-c", "run-child", { status: "failed", parentId: "task-parent" }));
  logEvent("task.failed", { runId: "run-child", taskId: "task-c", payload: { failure_kind: "tool_error" } });
  assert.equal(queryRuns({ failureKind: "tool_error" }).length, 0, "child failures don't match");
  assert.equal(queryRuns({})[0]!.failedCount, 0, "child not counted as a top-level failure");
});
