import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { eventsForTask, eventsForRun, logEvent } from "../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
import type { LivenessState } from "./reconcile-candidate.js";
import { failureKindForTask } from "../v2/failure-kind.js";
import { performOpsRepair } from "./repair.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function mkRun(id: string, status: RunStatus): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z" };
}
function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

// ── repairs the orphan shape ─────────────────────────────────────────────────

test("performOpsRepair: marks a genuine orphan failed (orphaned) with audit events; run untouched", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-orphan", "run-term", "pending"));

  const outcome = performOpsRepair("t-orphan");
  assert.equal(outcome.kind, "repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, false);

  // task is now failed
  assert.equal(getTask("t-orphan")!.status, "failed");
  // audit events: task.failed (orphaned) + task.reconciled (retry_orphan_repaired)
  const events = eventsForTask("t-orphan");
  const failed = events.find((e) => e.eventType === "task.failed");
  const reconciled = events.find((e) => e.eventType === "task.reconciled");
  assert.ok(failed, "emits task.failed");
  assert.equal((failed!.payload as { failure_kind?: string }).failure_kind, "orphaned");
  assert.ok(reconciled, "emits task.reconciled");
  assert.equal((reconciled!.payload as { reason?: string }).reason, "retry_orphan_repaired");
  // run status deliberately untouched
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get("run-term") as { status: string };
  assert.equal(runStatus.status, "complete");
});

test("performOpsRepair: treats a FAILED run as terminal — a pending task under it is a genuine orphan (FG-585)", () => {
  insertRun(mkRun("run-failed", "failed"));
  insertTask(mkTask("t-orphan-failed", "run-failed", "pending"));

  const outcome = performOpsRepair("t-orphan-failed");
  assert.equal(outcome.kind, "repaired", "a failed run is terminal, same as complete — the pending task is orphaned");
  assert.equal(getTask("t-orphan-failed")!.status, "failed");
  // run status deliberately untouched — the fix is the task, not the already-terminal run
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get("run-failed") as { status: string };
  assert.equal(runStatus.status, "failed", "failed run is not reconciled/repaired as if it were live");
});

// ── dry-run writes nothing ───────────────────────────────────────────────────

test("performOpsRepair: --dry-run reports the repair but writes nothing", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-orphan", "run-term", "pending"));

  const outcome = performOpsRepair("t-orphan", { dryRun: true });
  assert.equal(outcome.kind, "repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, true);

  assert.equal(getTask("t-orphan")!.status, "pending", "task stays pending");
  assert.equal(eventsForTask("t-orphan").length, 0, "no events written");
});

// ── refuses everything that is not the orphan shape ──────────────────────────

test("performOpsRepair: refuses a running task under a terminal run (not pending)", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-running", "run-term", "running"));
  const outcome = performOpsRepair("t-running");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not pending/);
  assert.equal(getTask("t-running")!.status, "running", "unchanged");
});

test("performOpsRepair: refuses a pending task under an ACTIVE run (not orphaned)", () => {
  insertRun(mkRun("run-live", "active"));
  insertTask(mkTask("t-live", "run-live", "pending"));
  const outcome = performOpsRepair("t-live");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not terminal/);
  assert.equal(getTask("t-live")!.status, "pending", "unchanged");
});

test("performOpsRepair: refuses an already-terminal task", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-done", "run-term", "failed"));
  const outcome = performOpsRepair("t-done");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not pending/);
});

test("performOpsRepair: unknown task id", () => {
  assert.equal(performOpsRepair("nope").kind, "unknown");
});

// ── idempotent ───────────────────────────────────────────────────────────────

test("performOpsRepair: idempotent — repairing twice refuses the second (now failed, not pending)", () => {
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-orphan", "run-term", "pending"));

  assert.equal(performOpsRepair("t-orphan").kind, "repaired");
  const second = performOpsRepair("t-orphan");
  assert.equal(second.kind, "refused");
  assert.match((second as { reason: string }).reason, /not pending/);
});

// ── stuck_run repair (FG-414): repair takes a run id, not a task id ─────────

const NEVER_ALIVE = (): LivenessState => "gone";
const ALWAYS_ALIVE = (): LivenessState => "alive";
const ALWAYS_UNKNOWN = (): LivenessState => "unknown";

test("performOpsRepair: transitions a stuck run (active, all tasks terminal, no live container) to abandoned", () => {
  insertRun(mkRun("run-stuck", "active"));
  insertTask(mkTask("t-stuck-1", "run-stuck", "complete"));
  insertTask(mkTask("t-stuck-2", "run-stuck", "failed"));

  const outcome = performOpsRepair("run-stuck", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "run-repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, false);

  assert.equal(getRun("run-stuck")!.status, "abandoned");
  const events = eventsForRun("run-stuck");
  const abandoned = events.find((e) => e.eventType === "run.abandoned");
  const reconciled = events.find((e) => e.eventType === "run.reconciled");
  assert.ok(abandoned, "emits run.abandoned");
  assert.ok(reconciled, "emits run.reconciled");
  assert.equal((reconciled!.payload as { reason?: string }).reason, "stuck_run_repaired");
});

test("performOpsRepair: --dry-run reports the stuck-run repair but writes nothing", () => {
  insertRun(mkRun("run-stuck-dry", "active"));
  insertTask(mkTask("t-stuck-dry", "run-stuck-dry", "failed"));

  const outcome = performOpsRepair("run-stuck-dry", { dryRun: true }, NEVER_ALIVE);
  assert.equal(outcome.kind, "run-repaired");
  assert.equal((outcome as { dryRun: boolean }).dryRun, true);
  assert.equal(getRun("run-stuck-dry")!.status, "active", "run stays active");
  assert.equal(eventsForRun("run-stuck-dry").length, 0, "no events written");
});

test("performOpsRepair: refuses a run with a non-terminal task (not orphaned)", () => {
  insertRun(mkRun("run-live", "active"));
  insertTask(mkTask("t-live-done", "run-live", "complete"));
  insertTask(mkTask("t-live-pending", "run-live", "pending"));

  const outcome = performOpsRepair("run-live", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /non-terminal task/);
  assert.equal(getRun("run-live")!.status, "active", "unchanged");
});

test("performOpsRepair: refuses a run with a live container even though every task row is terminal", () => {
  insertRun(mkRun("run-live-container", "active"));
  insertTask(mkTask("t-live-container", "run-live-container", "failed"));

  const outcome = performOpsRepair("run-live-container", {}, ALWAYS_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /container.*still alive/);
  assert.equal(getRun("run-live-container")!.status, "active", "unchanged");
});

test("performOpsRepair: refuses a run when container liveness is unknown (probe failure, not coerced to gone)", () => {
  insertRun(mkRun("run-unknown", "active"));
  insertTask(mkTask("t-unknown", "run-unknown", "failed"));

  const outcome = performOpsRepair("run-unknown", {}, ALWAYS_UNKNOWN);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /liveness is unknown/);
  assert.equal(getRun("run-unknown")!.status, "active", "unchanged — a probe failure must not be treated as gone");
});

test("performOpsRepair: refuses a run that is not active (already terminal)", () => {
  insertRun(mkRun("run-already-done", "complete"));
  insertTask(mkTask("t-already-done", "run-already-done", "complete"));

  const outcome = performOpsRepair("run-already-done", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /not active/);
});

test("performOpsRepair: refuses a run with no tasks", () => {
  insertRun(mkRun("run-no-tasks", "active"));
  const outcome = performOpsRepair("run-no-tasks", {}, NEVER_ALIVE);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /no tasks/);
});

// ── resurrected_gate_decision repair (FG-676) ───────────────────────────────
//
// The row says awaiting_gate; its own event stream says a human already decided
// it. The event stream is authoritative (the resurrection NULLed the row's
// error), so the repair reconstructs the terminal row from it — and refuses by
// name whenever the events do not prove the shape.

const REJECTED_ARTIFACT = { status: "complete", diff_summary: "the rejected work", files_modified: ["src/a.ts"] };

function mkResurrectedTask(id: string, runId: string, result?: unknown): Task {
  return { ...mkTask(id, runId, "awaiting_gate"), result };
}

/** Replay the production order: gate.decided → task.failed(gate_rejected) →
 *  the resurrecting task.awaiting_gate. The row itself is left as the
 *  resurrection left it: awaiting_gate, error NULL, result carried. */
function replayResurrection(runId: string, taskId: string, error: string): void {
  logEvent("gate.decided", { runId, taskId, payload: { decision: "request-changes", rationale: error } });
  logEvent("task.failed", { runId, taskId, payload: { failure_kind: "gate_rejected", error } });
  logEvent("task.awaiting_gate", { runId, taskId, payload: {} });
}

test("performOpsRepair: restores a resurrected gate decision to failed, with the error recovered from the event stream", () => {
  insertRun(mkRun("run-res", "active"));
  insertTask(mkResurrectedTask("t-res", "run-res", REJECTED_ARTIFACT));
  replayResurrection("run-res", "t-res", "request-changes; superseded");
  const rawResultBefore = (db.prepare("SELECT result FROM tasks WHERE id = ?").get("t-res") as { result: string }).result;

  const outcome = performOpsRepair("t-res");
  assert.equal(outcome.kind, "gate-decision-restored");
  assert.equal((outcome as { dryRun: boolean }).dryRun, false);
  assert.equal((outcome as { restoredError: string }).restoredError, "request-changes; superseded");

  const task = getTask("t-res")!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, "request-changes; superseded", "error restored from the task.failed payload, not NULL");
  assert.ok(task.completedAt, "completed_at set");
  // AC2: the rejected artifact survives BYTE-IDENTICALLY.
  const rawResultAfter = (db.prepare("SELECT result FROM tasks WHERE id = ?").get("t-res") as { result: string | null }).result;
  assert.equal(rawResultAfter, rawResultBefore, "result column byte-identical — never NULLed, never re-shaped");
  assert.deepEqual(task.result, REJECTED_ARTIFACT);
});

test("performOpsRepair: appends exactly ONE audit event (task.reconciled) and no second failure kind", () => {
  insertRun(mkRun("run-res-ev", "active"));
  insertTask(mkResurrectedTask("t-res-ev", "run-res-ev", REJECTED_ARTIFACT));
  replayResurrection("run-res-ev", "t-res-ev", "request-changes; superseded");
  const before = eventsForTask("t-res-ev").length;

  performOpsRepair("t-res-ev");

  const events = eventsForTask("t-res-ev");
  assert.equal(events.length, before + 1, "exactly one event appended");
  const appended = events[events.length - 1]!;
  assert.equal(appended.eventType, "task.reconciled");
  assert.deepEqual(appended.payload, {
    from: "awaiting_gate",
    to: "failed",
    reason: "resurrected_gate_decision_repaired",
  });
  assert.equal(events.filter((e) => e.eventType === "task.failed").length, 1, "no second, contradictory task.failed");
  // AC3: the ORIGINAL decision still reads as the task's failure kind.
  assert.equal(failureKindForTask("t-res-ev"), "gate_rejected");
});

test("performOpsRepair: --dry-run on a resurrected gate decision writes nothing", () => {
  insertRun(mkRun("run-res-dry", "active"));
  insertTask(mkResurrectedTask("t-res-dry", "run-res-dry", REJECTED_ARTIFACT));
  replayResurrection("run-res-dry", "t-res-dry", "request-changes; superseded");
  const before = eventsForTask("t-res-dry").length;

  const outcome = performOpsRepair("t-res-dry", { dryRun: true });
  assert.equal(outcome.kind, "gate-decision-restored");
  assert.equal((outcome as { dryRun: boolean }).dryRun, true);
  assert.equal((outcome as { restoredError: string }).restoredError, "request-changes; superseded");

  const task = getTask("t-res-dry")!;
  assert.equal(task.status, "awaiting_gate", "row untouched");
  assert.equal(task.error, undefined, "error still NULL");
  assert.equal(eventsForTask("t-res-dry").length, before, "no events written");
});

test("performOpsRepair: a gate `reject` decision restores identically to request-changes", () => {
  insertRun(mkRun("run-res-reject", "active"));
  insertTask(mkResurrectedTask("t-res-reject", "run-res-reject", REJECTED_ARTIFACT));
  logEvent("gate.decided", { runId: "run-res-reject", taskId: "t-res-reject", payload: { decision: "reject", rationale: "wrong approach" } });
  logEvent("task.failed", { runId: "run-res-reject", taskId: "t-res-reject", payload: { failure_kind: "gate_rejected", error: "wrong approach" } });
  logEvent("task.awaiting_gate", { runId: "run-res-reject", taskId: "t-res-reject", payload: {} });

  const outcome = performOpsRepair("t-res-reject");
  assert.equal(outcome.kind, "gate-decision-restored");
  assert.equal(getTask("t-res-reject")!.error, "wrong approach");
});

// ── refusals: each names the fact that blocked it ──────────────────────────

test("performOpsRepair: refuses an awaiting_gate row with NO terminal event — legitimately waiting on a human", () => {
  insertRun(mkRun("run-legit", "active"));
  insertTask(mkResurrectedTask("t-legit", "run-legit", REJECTED_ARTIFACT));
  logEvent("task.awaiting_gate", { runId: "run-legit", taskId: "t-legit", payload: {} });

  const outcome = performOpsRepair("t-legit");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /legitimately awaiting a gate decision/);
  assert.equal(getTask("t-legit")!.status, "awaiting_gate", "unchanged");
  assert.equal(eventsForTask("t-legit").length, 1, "no events written");
});

test("performOpsRepair: refuses when the newest terminal failure is not a gate rejection", () => {
  insertRun(mkRun("run-otherkind", "active"));
  insertTask(mkResurrectedTask("t-otherkind", "run-otherkind"));
  logEvent("task.failed", { runId: "run-otherkind", taskId: "t-otherkind", payload: { failure_kind: "container_crash", error: "exit 1" } });

  const outcome = performOpsRepair("t-otherkind");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /container_crash, not gate_rejected/);
  assert.equal(getTask("t-otherkind")!.status, "awaiting_gate", "unchanged");
});

test("performOpsRepair: refuses when a later task.completed means the task recovered", () => {
  insertRun(mkRun("run-recovered", "active"));
  insertTask(mkResurrectedTask("t-recovered", "run-recovered"));
  replayResurrection("run-recovered", "t-recovered", "rejected once");
  logEvent("task.completed", { runId: "run-recovered", taskId: "t-recovered", payload: {} });
  logEvent("task.awaiting_gate", { runId: "run-recovered", taskId: "t-recovered", payload: {} });

  const outcome = performOpsRepair("t-recovered");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /task\.completed.*recovered/);
  assert.equal(getTask("t-recovered")!.status, "awaiting_gate", "unchanged");
});

test("performOpsRepair: refuses when the gate_rejected event records no error string — never fabricates a reason", () => {
  insertRun(mkRun("run-noerr", "active"));
  insertTask(mkResurrectedTask("t-noerr", "run-noerr"));
  logEvent("task.failed", { runId: "run-noerr", taskId: "t-noerr", payload: { failure_kind: "gate_rejected" } });

  const outcome = performOpsRepair("t-noerr");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /no error string.*fabricated reason/);
  assert.equal(getTask("t-noerr")!.status, "awaiting_gate", "unchanged");
});

test("performOpsRepair: refuses when the result column cannot be reproduced byte-for-byte — audit history is never re-shaped", () => {
  insertRun(mkRun("run-bytes", "active"));
  insertTask(mkResurrectedTask("t-bytes", "run-bytes", REJECTED_ARTIFACT));
  replayResurrection("run-bytes", "t-bytes", "request-changes; superseded");
  // A stored artifact whose JSON.parse → JSON.stringify round trip does NOT
  // reproduce the stored bytes (pretty-printed whitespace).
  const pretty = JSON.stringify(REJECTED_ARTIFACT, null, 2);
  db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(pretty, "t-bytes");

  const outcome = performOpsRepair("t-bytes");
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { reason: string }).reason, /cannot be reproduced byte-for-byte/);
  const after = db.prepare("SELECT status, result FROM tasks WHERE id = ?").get("t-bytes") as { status: string; result: string };
  assert.equal(after.status, "awaiting_gate", "row left untouched");
  assert.equal(after.result, pretty, "artifact left untouched");
});

test("performOpsRepair: resurrected repair is idempotent — the second call refuses (the row is terminal again)", () => {
  insertRun(mkRun("run-twice", "active"));
  insertTask(mkResurrectedTask("t-twice", "run-twice", REJECTED_ARTIFACT));
  replayResurrection("run-twice", "t-twice", "request-changes; superseded");

  assert.equal(performOpsRepair("t-twice").kind, "gate-decision-restored");
  const second = performOpsRepair("t-twice");
  assert.equal(second.kind, "refused");
  assert.match((second as { reason: string }).reason, /not pending/, "a restored row is failed — no longer either task shape");
  assert.equal(getTask("t-twice")!.error, "request-changes; superseded", "still the restored terminal row");
  assert.equal(eventsForTask("t-twice").filter((e) => e.eventType === "task.reconciled").length, 1);
});

test("performOpsRepair: an awaiting_gate row is never mistaken for a retry_orphan, even under a terminal run", () => {
  insertRun(mkRun("run-term-res", "complete"));
  insertTask(mkResurrectedTask("t-term-res", "run-term-res", REJECTED_ARTIFACT));
  replayResurrection("run-term-res", "t-term-res", "request-changes; superseded");

  const outcome = performOpsRepair("t-term-res");
  assert.equal(outcome.kind, "gate-decision-restored", "routed by status, not by the run's terminality");
  assert.equal(getTask("t-term-res")!.error, "request-changes; superseded");
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get("run-term-res") as { status: string };
  assert.equal(runStatus.status, "complete", "run status deliberately untouched");
});
