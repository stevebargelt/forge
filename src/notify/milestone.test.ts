import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decideMilestone, emitMilestone, isMilestoneKind, composeDispatchBody, BATCH_ELAPSED_MIN_MS } from "./milestone.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import { logEvent, eventsForRun } from "../store/events.js";
import type { Run, Task } from "../types/index.js";

function mkRun(id: string, createdAt = new Date().toISOString()): Run {
  const run: Run = {
    id,
    workflow: "invoke",
    title: "t",
    status: "active",
    createdAt,
    metadata: {},
    projectDir: "/tmp/x",
  };
  insertRun(run);
  return run;
}

// ---- pure policy ----

test("decideMilestone: interrupt-worthy kinds always send", () => {
  for (const k of ["decision_needed", "blocked", "risk_found", "acceptance_green", "shipped", "ready_for_review"] as const) {
    assert.equal(decideMilestone(k, 0, false).send, true, `${k} should send`);
  }
});

test("decideMilestone: plan_started is suppressed by default", () => {
  const d = decideMilestone("plan_started", 9_999_999, false);
  assert.equal(d.send, false);
  assert.match(d.reason, /low importance/);
});

test("decideMilestone: batch_complete gates on elapsed (>=10m sends, <10m suppresses)", () => {
  assert.equal(decideMilestone("batch_complete", BATCH_ELAPSED_MIN_MS, false).send, true);
  assert.equal(decideMilestone("batch_complete", BATCH_ELAPSED_MIN_MS - 1, false).send, false);
});

test("decideMilestone: dedupe wins over everything (even always-send kinds)", () => {
  const d = decideMilestone("blocked", 0, true, "k1");
  assert.equal(d.send, false);
  assert.match(d.reason, /dedupe.*k1/);
});

test("isMilestoneKind rejects unknown kinds", () => {
  assert.equal(isMilestoneKind("blocked"), true);
  assert.equal(isMilestoneKind("nope"), false);
});

// ---- emit (record + policy + dedupe) ----

test("emitMilestone: always records an orchestrator.milestone event (provider off → dispatched=false)", async () => {
  const run = mkRun("run-ms-1");
  const res = await emitMilestone({ runId: run.id, kind: "decision_needed", title: "need a call" });
  assert.equal(res.decision.send, true, "policy wants to send");
  assert.equal(res.dispatched, false, "no provider in tests → not dispatched");
  const evts = eventsForRun(run.id).filter((e) => e.eventType === "orchestrator.milestone");
  assert.equal(evts.length, 1);
  const p = evts[0]!.payload as Record<string, unknown>;
  assert.equal(p["kind"], "decision_needed");
  assert.equal(p["title"], "need a call");
  assert.equal(p["importance"], "high");
  assert.equal(p["dispatched"], false);
});

test("emitMilestone: suppressed kind is still recorded (audit), not dispatched", async () => {
  const run = mkRun("run-ms-2");
  const res = await emitMilestone({ runId: run.id, kind: "plan_started", title: "starting" });
  assert.equal(res.decision.send, false);
  assert.equal(eventsForRun(run.id).filter((e) => e.eventType === "orchestrator.milestone").length, 1);
});

test("emitMilestone: dedupe suppresses a second push for a key already dispatched this run", async () => {
  const run = mkRun("run-ms-3");
  // Simulate a prior DISPATCHED milestone with the same dedupe key.
  logEvent("orchestrator.milestone", { runId: run.id, payload: { kind: "blocked", dedupeKey: "dk", dispatched: true } });
  const res = await emitMilestone({ runId: run.id, kind: "blocked", title: "again", dedupeKey: "dk" });
  assert.equal(res.decision.send, false, "deduped");
  assert.match(res.decision.reason, /dedupe/);
});

test("emitMilestone: a prior NON-dispatched same-key milestone does NOT dedupe", async () => {
  const run = mkRun("run-ms-4");
  logEvent("orchestrator.milestone", { runId: run.id, payload: { kind: "blocked", dedupeKey: "dk2", dispatched: false } });
  const res = await emitMilestone({ runId: run.id, kind: "blocked", title: "go", dedupeKey: "dk2" });
  assert.equal(res.decision.send, true, "prior was never sent, so not a dup");
});

test("emitMilestone: unknown kind throws; missing run throws", async () => {
  const run = mkRun("run-ms-5");
  await assert.rejects(() => emitMilestone({ runId: run.id, kind: "bogus", title: "x" }), /unknown milestone kind/);
  await assert.rejects(() => emitMilestone({ runId: "no-such-run", kind: "blocked", title: "x" }), /run not found/);
});

// ---- #242 advisory docs-impact on shipped ----

function mkCompleteTask(runId: string, id: string, filesModified: string[]): void {
  const task: Task = {
    id,
    runId,
    phase: "engineer",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  };
  insertTask(task);
  const dir = taskDir(runId, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", files_modified: filesModified }));
}

test("composeDispatchBody: appends the advisory to the pushed body, or returns base", () => {
  assert.equal(composeDispatchBody("done"), "done");
  const withWarn = composeDispatchBody("done", "UNRESOLVED docs impact");
  assert.match(withWarn, /done/);
  assert.match(withWarn, /⚠ UNRESOLVED docs impact/);
});

test("emitMilestone: shipped on a run that changed operator surfaces returns + records the advisory", async () => {
  const run = mkRun("run-ms-ship-1");
  mkCompleteTask(run.id, "task-eng-ship-1", ["src/cli/commands/usage.ts"]); // operator surface, no docs work
  const res = await emitMilestone({ runId: run.id, kind: "shipped", title: "feature X" });
  assert.ok(res.docsImpactWarning, "advisory computed for shipped with unresolved impact");
  assert.match(res.docsImpactWarning!, /UNRESOLVED/);
  const evt = eventsForRun(run.id).find((e) => e.eventType === "orchestrator.milestone");
  assert.ok((evt!.payload as Record<string, unknown>)["docsImpactWarning"], "advisory recorded in the event payload");
});

test("emitMilestone: shipped on a docs-only run yields no advisory", async () => {
  const run = mkRun("run-ms-ship-2");
  mkCompleteTask(run.id, "task-doc-ship-2", ["docs/concepts.md"]); // remediation, not a behavior change
  const res = await emitMilestone({ runId: run.id, kind: "shipped", title: "doc tidy" });
  assert.equal(res.docsImpactWarning, undefined);
});

test("emitMilestone: non-shipped kinds never compute the advisory", async () => {
  const run = mkRun("run-ms-ship-3");
  mkCompleteTask(run.id, "task-eng-ship-3", ["src/cli/commands/usage.ts"]);
  const res = await emitMilestone({ runId: run.id, kind: "ready_for_review", title: "rfr" });
  assert.equal(res.docsImpactWarning, undefined);
});
