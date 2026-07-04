import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
import { detectRetryOrphan, detectInconsistentRunState, detectOrphanedWorkMayPersist, runOpsCheck } from "./detect.js";
import { makeIncident } from "./incident.js";
import { renderHuman } from "../cli/commands/ops.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function mkRun(id: string, status: RunStatus, projectDir?: string): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z", projectDir };
}

function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

// ── detectRetryOrphan ───────────────────────────────────────────────────────

test("detectRetryOrphan: flags a pending task under a terminal run", () => {
  insertRun(mkRun("run-a", "complete"));
  insertTask(mkTask("task-a", "run-a", "pending"));

  const incidents = detectRetryOrphan(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "retry_orphan");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "high");
  assert.equal(i.taskId, "task-a");
  assert.equal(i.recommendedAction.type, "repair");
  assert.equal(i.recommendedAction.autonomy, "ask");
  assert.equal(i.recommendedAction.command, "forge ops repair task-a");
});

test("detectRetryOrphan: also flags abandoned runs; ignores active runs and non-pending tasks", () => {
  insertRun(mkRun("run-abandoned", "abandoned"));
  insertTask(mkTask("task-ab", "run-abandoned", "pending"));
  // pending under an ACTIVE run is normal (about to dispatch) → not an orphan.
  insertRun(mkRun("run-active", "active"));
  insertTask(mkTask("task-live", "run-active", "pending"));
  // complete task under a terminal run is fine.
  insertRun(mkRun("run-done", "complete"));
  insertTask(mkTask("task-done", "run-done", "complete"));

  const incidents = detectRetryOrphan(db);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.runId, "run-abandoned");
});

// ── detectInconsistentRunState ──────────────────────────────────────────────

test("detectInconsistentRunState: flags a running task under a terminal run", () => {
  insertRun(mkRun("run-b", "complete"));
  insertTask(mkTask("task-b", "run-b", "running"));

  const incidents = detectInconsistentRunState(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "inconsistent_run_state");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.recommendedAction.type, "repair_unavailable");
  assert.equal(i.recommendedAction.command, null);
});

test("detectInconsistentRunState: running under an active run is normal", () => {
  insertRun(mkRun("run-c", "active"));
  insertTask(mkTask("task-c", "run-c", "running"));
  assert.equal(detectInconsistentRunState(db).length, 0);
});

// ── detectOrphanedWorkMayPersist (FG-455) ───────────────────────────────────

test("detectOrphanedWorkMayPersist: flags a failed task classified orphaned_work_may_persist", () => {
  insertRun(mkRun("run-owmp", "active"));
  insertTask(mkTask("task-owmp", "run-owmp", "failed"));
  const evidence = {
    containerName: "forge-task-owmp",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/some/worktree",
    changedFiles: ["?? new-file.txt"],
  };
  logEvent("task.failed", {
    runId: "run-owmp", taskId: "task-owmp",
    payload: { failure_kind: "orphaned_work_may_persist", error: "orphaned_work_may_persist: ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "orphaned_work_may_persist");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "high");
  assert.equal(i.taskId, "task-owmp");
  assert.equal(i.recommendedAction.type, "investigate");
  assert.equal(i.recommendedAction.autonomy, "manual-only", "never auto-actionable — a human must inspect the diff first");
  assert.match(i.evidence.join(" "), /changed-file\.txt|1 changed file/);
});

test("detectOrphanedWorkMayPersist: ignores ordinary orphaned and non-failed tasks", () => {
  insertRun(mkRun("run-ord", "active"));
  insertTask(mkTask("task-ord", "run-ord", "failed"));
  logEvent("task.failed", { runId: "run-ord", taskId: "task-ord", payload: { failure_kind: "orphaned", error: "orphaned" } });
  insertTask(mkTask("task-running", "run-ord", "running"));

  assert.deepEqual(detectOrphanedWorkMayPersist(db), []);
});

test("detectOrphanedWorkMayPersist: project scoping", () => {
  insertRun(mkRun("run-owmp-a", "active", "/projects/alpha"));
  insertTask(mkTask("task-owmp-a", "run-owmp-a", "failed"));
  logEvent("task.failed", { runId: "run-owmp-a", taskId: "task-owmp-a", payload: { failure_kind: "orphaned_work_may_persist", error: "x" } });
  insertRun(mkRun("run-owmp-b", "active", "/projects/beta"));
  insertTask(mkTask("task-owmp-b", "run-owmp-b", "failed"));
  logEvent("task.failed", { runId: "run-owmp-b", taskId: "task-owmp-b", payload: { failure_kind: "orphaned_work_may_persist", error: "x" } });

  assert.equal(detectOrphanedWorkMayPersist(db, { projectDir: "/projects/alpha" }).length, 1);
  assert.equal(detectOrphanedWorkMayPersist(db).length, 2, "no projectDir → host-wide");
});

// ── project scoping ─────────────────────────────────────────────────────────

test("project scoping: filters to projectDir; host-wide when omitted", () => {
  insertRun(mkRun("run-p1", "complete", "/projects/alpha"));
  insertTask(mkTask("task-p1", "run-p1", "pending"));
  insertRun(mkRun("run-p2", "complete", "/projects/beta"));
  insertTask(mkTask("task-p2", "run-p2", "pending"));

  assert.equal(detectRetryOrphan(db, { projectDir: "/projects/alpha" }).length, 1);
  assert.equal(detectRetryOrphan(db, { projectDir: "/projects/alpha" })[0]!.runId, "run-p1");
  assert.equal(detectRetryOrphan(db).length, 2, "no projectDir → host-wide");
});

// ── runOpsCheck composition ─────────────────────────────────────────────────

test("runOpsCheck: composes both detectors over the read-only handle", () => {
  insertRun(mkRun("run-d", "complete"));
  insertTask(mkTask("task-pending", "run-d", "pending"));
  insertTask(mkTask("task-running", "run-d", "running"));

  const kinds = runOpsCheck().map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["inconsistent_run_state", "retry_orphan"]);
});

test("runOpsCheck: clean state → no incidents", () => {
  insertRun(mkRun("run-clean", "complete"));
  insertTask(mkTask("task-clean", "run-clean", "complete"));
  assert.deepEqual(runOpsCheck(), []);
});

// ── makeIncident invariant ──────────────────────────────────────────────────

test("makeIncident: rejects a non-db-confirmed incident carrying an auto-safe action", () => {
  assert.throws(
    () =>
      makeIncident({
        kind: "retry_orphan", severity: "high", confidence: "db-candidate", runId: "r", taskId: "t",
        evidence: [], recommendedAction: { type: "repair", autonomy: "auto-safe", command: "forge x", reason: "" },
      }),
    /only db-confirmed incidents may be auto-safe/
  );
});

test("makeIncident: rejects repair_unavailable that carries a command", () => {
  assert.throws(
    () =>
      makeIncident({
        kind: "retry_orphan", severity: "high", confidence: "db-confirmed", runId: "r", taskId: "t",
        evidence: [], recommendedAction: { type: "repair_unavailable", autonomy: "manual-only", command: "forge x", reason: "" },
      }),
    /repair_unavailable but carries a command/
  );
});

test("makeIncident: allows a db-confirmed auto-safe action", () => {
  const i = makeIncident({
    kind: "retry_orphan", severity: "low", confidence: "db-confirmed", runId: "r", taskId: "t",
    evidence: [], recommendedAction: { type: "repair", autonomy: "auto-safe", command: "forge x", reason: "ok" },
  });
  assert.equal(i.recommendedAction.autonomy, "auto-safe");
});

// ── read-only invariant (the load-bearing #250 safety claim) ─────────────────

test("runOpsCheck never mutates state — run/task statuses and event count unchanged", () => {
  // A DB with both incident conditions present, plus a healthy active run.
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-pending", "run-term", "pending"));   // retry_orphan
  insertTask(mkTask("t-running", "run-term", "running"));   // inconsistent_run_state
  insertRun(mkRun("run-live", "active"));
  insertTask(mkTask("t-live", "run-live", "running"));      // healthy, not flagged

  const snapshot = () => ({
    tasks: db.prepare("SELECT id, status FROM tasks ORDER BY id").all(),
    runs: db.prepare("SELECT id, status FROM runs ORDER BY id").all(),
    events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  });

  const before = snapshot();
  const incidents = runOpsCheck();
  assert.equal(incidents.length, 2, "detected the two conditions (precondition for a meaningful no-mutation check)");

  const after = snapshot();
  assert.deepEqual(after.tasks, before.tasks, "task statuses must be unchanged");
  assert.deepEqual(after.runs, before.runs, "run statuses must be unchanged");
  assert.equal(after.events, before.events, "no events written");
});

// ── CLI rendering ────────────────────────────────────────────────────────────

test("renderHuman: clean state", () => {
  assert.equal(renderHuman([]), "No ops incidents.");
});

test("renderHuman: surfaces kind, location, autonomy, and the repair_unavailable action", () => {
  const out = renderHuman([
    makeIncident({
      kind: "retry_orphan", severity: "high", confidence: "db-confirmed",
      runId: "run-x", taskId: "task-y", evidence: ["run run-x is complete", "child task task-y is pending"],
      recommendedAction: { type: "repair_unavailable", autonomy: "manual-only", command: null, reason: "no DB-safe repair" },
    }),
  ]);
  assert.match(out, /retry_orphan/);
  assert.match(out, /db-confirmed/);
  assert.match(out, /run-x \/ task-y/);
  assert.match(out, /\(repair_unavailable\)/);   // command null → renders the action type
  assert.match(out, /manual-only/);
  assert.match(out, /no DB-safe repair/);
});
