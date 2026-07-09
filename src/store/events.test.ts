import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";
import { logEvent, eventsForTask, eventsForRun } from "./events.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-ev-test",
  workflow: "feature",
  title: "events test",
  status: "active",
  createdAt: "2026-05-29T00:00:00Z",
};

function task(id: string): Task {
  return {
    id,
    runId: RUN.id,
    phase: "engineer",
    agentRole: "engineer",
    status: "pending",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: "engineer",
      role: "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-29T00:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(task("task-ev-1"));
  insertTask(task("task-ev-2"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("eventsForTask returns events for that task ordered by created_at ASC, id ASC", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.completed", { runId: RUN.id, taskId: "task-ev-1" });
  const events = eventsForTask("task-ev-1");
  assert.equal(events.length, 2);
  assert.equal(events[0]!.eventType, "task.started");
  assert.equal(events[1]!.eventType, "task.completed");
});

test("eventsForTask filters to only the given task, not other tasks in same run", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-2" });
  const events = eventsForTask("task-ev-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.taskId, "task-ev-1");
});

test("eventsForTask parses payload JSON from string back to object", () => {
  logEvent("task.completed", { runId: RUN.id, taskId: "task-ev-1", payload: { status: "complete", score: 42 } });
  const events = eventsForTask("task-ev-1");
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { status: string; score: number };
  assert.equal(payload.status, "complete");
  assert.equal(payload.score, 42);
});

test("eventsForTask returns null payload when no payload set", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  const events = eventsForTask("task-ev-1");
  assert.equal(events[0]!.payload, null);
});

test("eventsForTask returns [] for unknown taskId", () => {
  assert.deepEqual(eventsForTask("no-such-task"), []);
});

test("eventsForRun returns all events for the run ordered chronologically", () => {
  logEvent("run.created", { runId: RUN.id });
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.completed", { runId: RUN.id, taskId: "task-ev-1" });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 3);
  assert.equal(events[0]!.eventType, "run.created");
  assert.equal(events[1]!.eventType, "task.started");
  assert.equal(events[2]!.eventType, "task.completed");
});

test("eventsForRun filters to only the given run, not other runs", () => {
  const otherRun: Run = { ...RUN, id: "run-other" };
  insertRun(otherRun);
  logEvent("run.created", { runId: RUN.id });
  logEvent("run.created", { runId: "run-other" });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.runId, RUN.id);
});

test("eventsForRun parses payload JSON from string back to object", () => {
  logEvent("run.completed", { runId: RUN.id, payload: { workflow: "feature", tasks: 3 } });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { workflow: string; tasks: number };
  assert.equal(payload.workflow, "feature");
  assert.equal(payload.tasks, 3);
});

test("eventsForRun returns [] for unknown runId", () => {
  assert.deepEqual(eventsForRun("no-such-run"), []);
});

test("eventsForRun includes events with taskId populated when set", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("task.started", { runId: RUN.id, taskId: "task-ev-2" });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 2);
  const taskIds = events.map((e) => e.taskId).sort();
  assert.deepEqual(taskIds, ["task-ev-1", "task-ev-2"]);
});

test("eventsForRun exposes runId on each event row", () => {
  logEvent("run.created", { runId: RUN.id });
  const events = eventsForRun(RUN.id);
  assert.equal(events[0]!.runId, RUN.id);
});

// #194: new event types are accepted by logEvent (runtime guard for union additions)
test("logEvent accepts new #194 event types without throwing", () => {
  logEvent("run.abandoned", { runId: RUN.id, taskId: "task-ev-1", payload: { via: "forge cancel" } });
  logEvent("task.awaiting_gate", { runId: RUN.id, taskId: "task-ev-1" });
  logEvent("container.started", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1" } });
  logEvent("container.exited", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1", exitCode: 0 } });
  logEvent("container.idle_timeout", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1", exitCode: 124 } });
  logEvent("container.killed", { runId: RUN.id, taskId: "task-ev-1", payload: { containerName: "forge-task-ev-1" } });
  logEvent("auth.profile_applied", { runId: RUN.id, taskId: "task-ev-1", payload: { profile: "my-profile" } });
  logEvent("auth.profile_failed", { runId: RUN.id, taskId: "task-ev-1", payload: { profile: "my-profile", reason: "not found" } });

  const events = eventsForTask("task-ev-1");
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("run.abandoned"));
  assert.ok(types.includes("task.awaiting_gate"));
  assert.ok(types.includes("container.started"));
  assert.ok(types.includes("container.exited"));
  assert.ok(types.includes("container.idle_timeout"));
  assert.ok(types.includes("container.killed"));
  assert.ok(types.includes("auth.profile_applied"));
  assert.ok(types.includes("auth.profile_failed"));
});

// FG-487: host-side verification events (review-loop rounds, campaign reconcile
// host-gate execs) — previously invisible activity now gets durable start/finish
// markers in the events spine.
test("logEvent accepts FG-487 host-side verification event types and round-trips their payload", () => {
  logEvent("review_loop.verification_started", {
    runId: RUN.id,
    payload: { attemptId: "attempt-1", round: 1, ticketId: "FG-487", sha: "deadbeef", mode: "ci_wait" },
  });
  logEvent("review_loop.verification_finished", {
    runId: RUN.id,
    payload: { attemptId: "attempt-1", round: 1, ok: true, ciOutcome: { kind: "reused_after_wait" }, reusedEvidence: "CI check \"CI / test\"" },
  });
  logEvent("campaign_item.host_gate_started", {
    runId: RUN.id,
    payload: { attemptId: "gate-1", ticketId: "FG-487", itemId: "citem-1", campaignId: "campaign-1", gate: "npm run test:all", command: "npm run test:all", testedSha: "deadbeef" },
  });
  logEvent("campaign_item.host_gate_finished", {
    runId: RUN.id,
    payload: { attemptId: "gate-1", ticketId: "FG-487", itemId: "citem-1", campaignId: "campaign-1", exitCode: 0 },
  });

  const events = eventsForRun(RUN.id);
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("review_loop.verification_started"));
  assert.ok(types.includes("review_loop.verification_finished"));
  assert.ok(types.includes("campaign_item.host_gate_started"));
  assert.ok(types.includes("campaign_item.host_gate_finished"));

  const started = events.find((e) => e.eventType === "review_loop.verification_started")!;
  const startedPayload = started.payload as { attemptId: string; mode: string; sha: string };
  assert.equal(startedPayload.attemptId, "attempt-1");
  assert.equal(startedPayload.mode, "ci_wait");
  assert.equal(startedPayload.sha, "deadbeef");

  const gateFinished = events.find((e) => e.eventType === "campaign_item.host_gate_finished")!;
  const gatePayload = gateFinished.payload as { attemptId: string; itemId: string; exitCode: number };
  assert.equal(gatePayload.attemptId, "gate-1");
  assert.equal(gatePayload.itemId, "citem-1");
  assert.equal(gatePayload.exitCode, 0);
});

// FG-487: round/ticketId/sha alone is NOT a safe pairing key — a crashed
// process restarting the same round (or a retried gate exec) can produce two
// starts at the identical identity. Every start/finish payload carries a
// unique attemptId specifically so pairing can never be done by key alone.
// This test proves the property directly against logged events: a naive
// pairing keyed only on (round, ticketId, sha) mispairs a same-identity
// double-start (it can't tell WHICH start a finish belongs to, so it
// incorrectly resolves BOTH once ANY finish shares the key); pairing by
// attemptId correctly leaves the un-finished attempt open.
test("FG-487 attemptId pairing survives a same-identity double-start — naive key-only pairing mispairs, attemptId pairing doesn't", () => {
  const round = 1;
  const ticketId = "FG-487";
  const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  logEvent("review_loop.verification_started", { runId: RUN.id, payload: { attemptId: "attempt-A", round, ticketId, sha, mode: "ci_wait" } });
  logEvent("review_loop.verification_started", { runId: RUN.id, payload: { attemptId: "attempt-B", round, ticketId, sha, mode: "ci_wait" } });
  // Only attempt-B ever finishes — attempt-A's process crashed mid-wait and never resumed.
  logEvent("review_loop.verification_finished", { runId: RUN.id, payload: { attemptId: "attempt-B", round, ticketId, sha, ok: true } });

  const events = eventsForRun(RUN.id);
  const starts = events.filter((e) => e.eventType === "review_loop.verification_started");
  const finishes = events.filter((e) => e.eventType === "review_loop.verification_finished");
  assert.equal(starts.length, 2);
  assert.equal(finishes.length, 1);

  type Payload = { attemptId: string; round: number; ticketId: string; sha: string };
  const key = (p: Payload): string => `${p.round}:${p.ticketId}:${p.sha}`;

  // Naive pairing: "is there ANY finish at this start's (round,ticketId,sha)
  // key" — since both starts share the identical key, the one real finish
  // (attempt-B's) makes the key look resolved for BOTH starts.
  const naiveResolvedKeys = new Set(finishes.map((f) => key(f.payload as Payload)));
  const naiveStillOpen = starts.filter((s) => !naiveResolvedKeys.has(key(s.payload as Payload)));
  assert.equal(naiveStillOpen.length, 0, "naive key-only pairing wrongly resolves BOTH starts once any finish shares their key — this is the failure mode attemptId pairing must avoid");

  // Correct: pair by attemptId — attempt-A has no matching finish and must
  // still read as open/in-progress; attempt-B is correctly resolved.
  const finishedAttemptIds = new Set(finishes.map((f) => (f.payload as Payload).attemptId));
  const stillOpenByAttemptId = starts.filter((s) => !finishedAttemptIds.has((s.payload as Payload).attemptId));
  assert.equal(stillOpenByAttemptId.length, 1);
  assert.equal((stillOpenByAttemptId[0]!.payload as Payload).attemptId, "attempt-A");
});

// FG-428: campaign_item.evidence_reconciled is distinct from run.reconciled/task.reconciled
test("logEvent accepts campaign_item.evidence_reconciled and round-trips its payload", () => {
  logEvent("campaign_item.evidence_reconciled", {
    runId: RUN.id,
    payload: { campaignId: "campaign-1", itemId: "citem-1", ticketId: "FG-1", decidedBy: "operator" },
  });
  const events = eventsForRun(RUN.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventType, "campaign_item.evidence_reconciled");
  const payload = events[0]!.payload as { ticketId: string; decidedBy: string };
  assert.equal(payload.ticketId, "FG-1");
  assert.equal(payload.decidedBy, "operator");
});
