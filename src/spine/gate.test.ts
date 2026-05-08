import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { aggregateVerdicts, batchGate, gate } from "./gate.js";
import { tasksForRunPhase, getTask } from "../store/tasks.js";
import type { VerdictRow, RedAuthority, Run, Task } from "../types/index.js";

function v(
  partial: Partial<VerdictRow> & { verdict: VerdictRow["verdict"]; authority: RedAuthority }
): VerdictRow {
  return {
    id: partial.id ?? "verdict-x",
    taskId: partial.taskId ?? "task-x",
    redTaskId: partial.redTaskId ?? "task-red-x",
    redRole: partial.redRole ?? "red-wide",
    verdict: partial.verdict,
    confidence: partial.confidence ?? 0.8,
    authority: partial.authority,
    findings: partial.findings ?? [],
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

test("aggregateVerdicts: empty list is inconclusive", () => {
  const r = aggregateVerdicts([]);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.authoritativeFails.length, 0);
  assert.equal(r.specialistFails.length, 0);
});

test("aggregateVerdicts: all pass → pass", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "specialist" }),
    v({ verdict: "pass", authority: "authoritative" }),
  ]);
  assert.equal(r.verdict, "pass");
});

test("aggregateVerdicts: any authoritative fail → fail (regardless of others)", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "specialist" }),
    v({ verdict: "fail", authority: "authoritative" }),
    v({ verdict: "pass", authority: "specialist" }),
  ]);
  assert.equal(r.verdict, "fail");
  assert.equal(r.authoritativeFails.length, 1);
});

test("aggregateVerdicts: specialist fail with passing peers → inconclusive (warns, doesn't block)", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "authoritative" }),
    v({ verdict: "fail", authority: "specialist" }),
  ]);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.authoritativeFails.length, 0);
  assert.equal(r.specialistFails.length, 1);
});

test("aggregateVerdicts: triage fail alone → inconclusive", () => {
  const r = aggregateVerdicts([v({ verdict: "fail", authority: "triage" })]);
  assert.equal(r.verdict, "inconclusive");
});

test("aggregateVerdicts: inconclusive verdict → inconclusive (not pass, not fail)", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "authoritative" }),
    v({ verdict: "inconclusive", authority: "specialist" }),
  ]);
  assert.equal(r.verdict, "inconclusive");
});

test("aggregateVerdicts: multiple authoritative fails all captured", () => {
  const r = aggregateVerdicts([
    v({ verdict: "fail", authority: "authoritative", redRole: "red-wide" }),
    v({ verdict: "fail", authority: "authoritative", redRole: "red-narrow" }),
  ]);
  assert.equal(r.verdict, "fail");
  assert.equal(r.authoritativeFails.length, 2);
});

// ---------- batchGate (#40) ----------

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-batch",
  workflow: "investigation",
  title: "batch gate test",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
};

function task(overrides: Partial<Task> & { id: string; status: Task["status"] }): Task {
  return {
    id: overrides.id,
    runId: overrides.runId ?? RUN.id,
    parentId: overrides.parentId,
    phase: overrides.phase ?? "investigate",
    agentRole: overrides.agentRole ?? "investigator",
    status: overrides.status,
    taskPackage: overrides.taskPackage ?? {
      taskId: overrides.id,
      runId: overrides.runId ?? RUN.id,
      phase: overrides.phase ?? "investigate",
      role: overrides.agentRole ?? "investigator",
      inputs: { claim: "test" },
      composedSystemPrompt: "",
    },
    result: overrides.result ?? { status: "complete" },
    createdAt: overrides.createdAt ?? "2026-05-08T00:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("batchGate: throws on unknown run", async () => {
  await assert.rejects(
    () => batchGate("run-does-not-exist", "advance", undefined),
    /Run not found/
  );
});

test("batchGate: rejects non-advance decisions (initial scope per #40)", async () => {
  await assert.rejects(
    () => batchGate(RUN.id, "reject", undefined),
    /supports 'advance' only/
  );
  await assert.rejects(
    () => batchGate(RUN.id, "request-changes", undefined),
    /supports 'advance' only/
  );
});

test("batchGate: empty run → gated:[] and skippedBlocked:[]", async () => {
  const r = await batchGate(RUN.id, "advance", undefined);
  assert.equal(r.gated.length, 0);
  assert.equal(r.skippedBlocked.length, 0);
  assert.equal(r.failed.length, 0);
});

test("batchGate: advances every awaiting_gate task in the run, skips blocked_by_red", async () => {
  insertTask(task({ id: "t-aw-1", status: "awaiting_gate" }));
  insertTask(task({ id: "t-aw-2", status: "awaiting_gate" }));
  insertTask(task({ id: "t-aw-3", status: "awaiting_gate" }));
  insertTask(task({ id: "t-blocked", status: "blocked_by_red" }));
  insertTask(task({ id: "t-pending", status: "pending" }));

  const r = await batchGate(RUN.id, "advance", "looks good");

  // All 3 awaiting_gate tasks should be gated.
  assert.equal(r.gated.length, 3);
  const gatedIds = r.gated.map((g) => g.taskId).sort();
  assert.deepEqual(gatedIds, ["t-aw-1", "t-aw-2", "t-aw-3"]);
  // Blocked task is reported, not silently ignored, not advanced.
  assert.equal(r.skippedBlocked.length, 1);
  assert.equal(r.skippedBlocked[0]!.taskId, "t-blocked");
  // Pending task is not in eligible set and not in skipped (only blocked_by_red counts).
  assert.equal(r.failed.length, 0);
});

test("batchGate: tasks not in awaiting_gate are ignored, not failed", async () => {
  insertTask(task({ id: "t-running", status: "running" }));
  insertTask(task({ id: "t-complete", status: "complete" }));
  insertTask(task({ id: "t-failed", status: "failed" }));
  insertTask(task({ id: "t-aw", status: "awaiting_gate" }));

  const r = await batchGate(RUN.id, "advance", undefined);
  assert.equal(r.gated.length, 1);
  assert.equal(r.gated[0]!.taskId, "t-aw");
  assert.equal(r.failed.length, 0);
  assert.equal(r.skippedBlocked.length, 0);
});

// ---------- manual-phase reject (FORGE-DEC-016 + #25 onReject end-to-end) ----------

const UI_RUN: Run = {
  id: "run-ui-design",
  workflow: "ui-design",
  title: "ui-design test",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
  metadata: { designDir: "/tmp/x" },
};

test("gate reject on a review task triggers onReject and creates a brief task with rejectedRationale", async () => {
  insertRun(UI_RUN);
  // Simulate the review task having been submitted (so it's in awaiting_gate
  // with the artifact paths captured in result).
  insertTask({
    id: "t-review",
    runId: UI_RUN.id,
    phase: "ui-review",
    agentRole: "",
    status: "awaiting_gate",
    taskPackage: {
      taskId: "t-review",
      runId: UI_RUN.id,
      phase: "ui-review",
      role: "",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { status: "complete", penFile: "/x.pen", pngFiles: [], htmlFiles: [] },
    createdAt: "2026-05-08T00:00:00Z",
  });

  const out = await gate("t-review", "reject", "design feels off-style; too saturated");

  assert.equal(out.task.status, "failed");
  // onReject loop should have produced a new pending brief task.
  const briefTasks = tasksForRunPhase(UI_RUN.id, "brief");
  assert.equal(briefTasks.length, 1);
  const brief = briefTasks[0]!;
  assert.equal(brief.status, "pending");
  assert.equal(brief.taskPackage.inputs.rejectedRationale, "design feels off-style; too saturated");
  assert.equal(brief.taskPackage.inputs.rejectedTaskId, "t-review");
});

test("gate advance on the last task of the terminal phase finalizes the run", async () => {
  insertRun(UI_RUN);
  // Brief task already complete; review task is the terminal one being advanced.
  insertTask({
    id: "t-brief-done",
    runId: UI_RUN.id,
    phase: "brief",
    agentRole: "prompt-author",
    status: "complete",
    taskPackage: {
      taskId: "t-brief-done",
      runId: UI_RUN.id,
      phase: "brief",
      role: "prompt-author",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { status: "complete" },
    createdAt: "2026-05-08T00:00:00Z",
  });
  insertTask({
    id: "t-review-final",
    runId: UI_RUN.id,
    phase: "ui-review",
    agentRole: "",
    status: "awaiting_gate",
    taskPackage: {
      taskId: "t-review-final",
      runId: UI_RUN.id,
      phase: "ui-review",
      role: "",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { status: "complete", penFile: "/x.pen", pngFiles: [], htmlFiles: [] },
    createdAt: "2026-05-08T00:00:01Z",
  });

  await gate("t-review-final", "advance", undefined);

  // The run should have transitioned to complete because review is the last
  // phase of ui-design and the terminal task just advanced. (#41 fix at the
  // gate() entry point.)
  const { getRun } = await import("../store/runs.js");
  const finalRun = getRun(UI_RUN.id)!;
  assert.equal(finalRun.status, "complete");
});

test("gate request-changes on a manual-phase task throws (no agent to re-run)", async () => {
  insertRun(UI_RUN);
  insertTask({
    id: "t-review-2",
    runId: UI_RUN.id,
    phase: "ui-review",
    agentRole: "",
    status: "awaiting_gate",
    taskPackage: {
      taskId: "t-review-2",
      runId: UI_RUN.id,
      phase: "ui-review",
      role: "",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-08T00:00:00Z",
  });

  await assert.rejects(
    () => gate("t-review-2", "request-changes", "noop"),
    /manual phase.*request-changes is not supported/
  );

  // Task stays in awaiting_gate — the failed gate didn't mutate state inappropriately.
  const refreshed = getTask("t-review-2")!;
  assert.equal(refreshed.status, "awaiting_gate");
});
