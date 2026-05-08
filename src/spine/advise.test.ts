import { test } from "node:test";
import assert from "node:assert/strict";
import { adviseRun } from "./advise.js";
import type { Run, Task } from "../types/index.js";

const RUN: Run = {
  id: "run-adv",
  workflow: "investigation",
  title: "advise test",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
};

function task(id: string, status: Task["status"], extra: Partial<Task> = {}): Task {
  return {
    id,
    runId: RUN.id,
    phase: "investigate",
    agentRole: "investigator",
    status,
    taskPackage: { taskId: id, runId: RUN.id, phase: "investigate", role: "investigator", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-08T00:00:00Z",
    ...extra,
  };
}

test("adviseRun: complete run → no command", () => {
  const a = adviseRun({ ...RUN, status: "complete" }, []);
  assert.equal(a.kind, "complete");
  assert.equal(a.command, "");
  assert.match(a.summary, /complete/);
});

test("adviseRun: abandoned run → no command", () => {
  const a = adviseRun({ ...RUN, status: "abandoned" }, []);
  assert.equal(a.kind, "abandoned");
  assert.equal(a.command, "");
});

test("adviseRun: awaiting_red → informational (no command), ranked after running (FORGE-DEC-017)", () => {
  const a = adviseRun(RUN, [task("t-blue", "awaiting_red")]);
  assert.equal(a.kind, "awaiting_red");
  assert.equal(a.command, ""); // informational only; nothing for the human to do
  assert.match(a.summary, /awaiting red verdicts/);
  assert.equal(a.counts.awaiting_red, 1);
});

test("adviseRun: running beats awaiting_red (a still-running blue is more salient)", () => {
  // If both running blues exist alongside awaiting_red blues, surface the
  // running ones first — they're more actively producing state changes.
  const a = adviseRun(RUN, [task("t-r", "running"), task("t-blue", "awaiting_red")]);
  assert.equal(a.kind, "running");
});

test("adviseRun: awaiting_human_input → forge submit <task> (manual phase, FORGE-DEC-016)", () => {
  const a = adviseRun(RUN, [task("t-review", "awaiting_human_input")]);
  assert.equal(a.kind, "awaiting_human_input");
  assert.match(a.command, /forge submit t-review/);
  assert.match(a.summary, /awaiting your design work/);
  assert.equal(a.counts.awaiting_human_input, 1);
});

test("adviseRun: awaiting_human_input ranks before awaiting_gate (production gates a decision)", () => {
  const a = adviseRun(RUN, [
    task("t-aw", "awaiting_gate"),
    task("t-rev", "awaiting_human_input"),
  ]);
  assert.equal(a.kind, "awaiting_human_input");
  assert.match(a.command, /forge submit t-rev/);
});

test("adviseRun: blocked_by_red beats awaiting_gate (more important)", () => {
  const a = adviseRun(RUN, [
    task("t-aw", "awaiting_gate"),
    task("t-blocked", "blocked_by_red"),
  ]);
  assert.equal(a.kind, "blocked_by_red");
  assert.match(a.command, /forge show t-blocked/);
  assert.match(a.alternativeCommand!, /--force --rationale/);
});

test("adviseRun: single awaiting_gate → forge gate <task> advance", () => {
  const a = adviseRun(RUN, [task("t-aw-1", "awaiting_gate")]);
  assert.equal(a.kind, "awaiting_gate");
  assert.equal(a.command, "forge gate t-aw-1 advance");
});

test("adviseRun: multiple awaiting_gate → forge gate <run> advance --all", () => {
  const a = adviseRun(RUN, [
    task("t-aw-1", "awaiting_gate"),
    task("t-aw-2", "awaiting_gate"),
    task("t-aw-3", "awaiting_gate"),
  ]);
  assert.equal(a.kind, "awaiting_gate");
  assert.match(a.command, /forge gate run-adv advance --all/);
  assert.match(a.summary, /3 tasks/);
});

test("adviseRun: running tasks → wait, no command", () => {
  const a = adviseRun(RUN, [
    task("t-running", "running"),
    task("t-pending", "pending"),
  ]);
  assert.equal(a.kind, "running");
  assert.equal(a.command, "");
});

test("adviseRun: pending tasks → forge next", () => {
  const a = adviseRun(RUN, [task("t-pending", "pending")]);
  assert.equal(a.kind, "ready_to_dispatch");
  assert.equal(a.command, "forge next run-adv");
});

test("adviseRun: container crash → suggest retry, alternative is show", () => {
  const a = adviseRun(RUN, [
    task("t-crash", "failed", { error: "container_crash (exit 137)" }),
  ]);
  assert.equal(a.kind, "crashed");
  assert.equal(a.command, "forge next run-adv");
  assert.match(a.alternativeCommand!, /forge show t-crash/);
});

test("adviseRun: failure that's NOT a container_crash doesn't trigger crashed kind", () => {
  // agent-level failures (e.g. agent_replied_text) shouldn't be treated like a crash
  const a = adviseRun(RUN, [task("t-fail", "failed", { error: "agent_replied_text" })]);
  // No work to do here — every task is in a terminal status. Falls through to the
  // "ready_to_dispatch / advance" final branch.
  assert.equal(a.kind, "ready_to_dispatch");
});

test("adviseRun: counts populated correctly", () => {
  const a = adviseRun(RUN, [
    task("t1", "pending"),
    task("t2", "running"),
    task("t3", "awaiting_gate"),
    task("t4", "blocked_by_red"),
    task("t5", "complete"),
    task("t6", "failed"),
  ]);
  assert.deepEqual(a.counts, {
    pending: 1,
    running: 1,
    awaiting_gate: 1,
    awaiting_human_input: 0,
    awaiting_red: 0,
    blocked_by_red: 1,
    complete: 1,
    failed: 1,
  });
});
