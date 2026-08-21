// FG-590: the policy-driven, evidence-safe container reap. Proves the per-outcome
// retention window, evidence-before-rm for failed/ambiguous containers, fail-closed
// retention when that evidence cannot be persisted, and that the running/non-terminal
// guards and the existing --older-than-minutes path are all intact.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { logEvent, eventsForTask } from "../../store/events.js";
import { getContainerCausalEvidenceFromEvents, type ContainerExitInfo } from "../../v2/failure-kind.js";
import type { Run, Task, TaskStatus, RunStatus } from "../../types/index.js";
import type { ContainerReap, ContainerLister, ContainerListEntry } from "../../v2/reconcile.js";
import { performOpsReapContainers } from "./ops.js";
import type { RetentionPolicy } from "../../v2/retention-policy.js";

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
function mkTask(id: string, runId: string, status: TaskStatus, completedAt?: string): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
    ...(completedAt ? { completedAt } : {}),
  };
}
function containerList(entries: Array<{ name: string; running?: boolean; finishedAt?: string }>): ContainerLister {
  const list: ContainerListEntry[] = entries.map((e) => ({
    name: e.name,
    running: e.running ?? false,
    ...(e.finishedAt !== undefined ? { finishedAt: e.finishedAt } : {}),
  }));
  return () => list;
}

const POLICY: RetentionPolicy = { success: 60_000, failureAmbiguous: 24 * 60 * 60_000 };
const LONG_AGO = "2020-01-01T00:00:00.000Z"; // past every window
function recentIso(): string {
  return new Date(Date.now() - 5_000).toISOString(); // 5s ago — within both windows
}

test("FG-590 reap policy: a failed container is retained within its diagnostic window, reaped past it", () => {
  insertRun(mkRun("run-a", "failed"));
  insertTask(mkTask("t-fresh", "run-a", "failed"));
  insertTask(mkTask("t-old", "run-a", "failed"));

  const reaped: string[] = [];
  const reap: ContainerReap = (n) => { reaped.push(n); return "killed"; };
  const exitInfo: ContainerExitInfo = () => ({ exitCode: 1 });

  const outcome = performOpsReapContainers(
    { policy: POLICY },
    reap,
    containerList([
      { name: "forge-t-fresh", finishedAt: recentIso() },
      { name: "forge-t-old", finishedAt: LONG_AGO },
    ]),
    exitInfo,
  );

  assert.deepEqual(outcome.reaped, ["forge-t-old"]);
  assert.deepEqual(outcome.retained, ["forge-t-fresh"]);
  assert.deepEqual(reaped, ["forge-t-old"]);
});

test("FG-590 reap policy: a completed-task leak is reaped on the SHORTER success window", () => {
  insertRun(mkRun("run-b", "complete"));
  // A completed task whose container leaked; finished within the failure window but PAST
  // the short success window — the per-outcome distinction is what retires it.
  insertTask(mkTask("t-leak", "run-b", "complete"));

  const reap: ContainerReap = () => "killed";
  const finishedAt = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
  const outcome = performOpsReapContainers(
    { policy: POLICY },
    reap,
    containerList([{ name: "forge-t-leak", finishedAt }]),
    () => ({}),
  );
  assert.deepEqual(outcome.reaped, ["forge-t-leak"]);
  assert.deepEqual(outcome.completedTaskLeaks, ["forge-t-leak"]);
});

test("FG-590 reap policy: exit/signal/OOM/timing evidence is persisted BEFORE the rm", () => {
  insertRun(mkRun("run-c", "failed"));
  insertTask(mkTask("t-ev", "run-c", "failed"));

  let evidenceDurableAtReap = false;
  const reap: ContainerReap = () => {
    // At the moment rm is invoked, the diagnostic evidence must already be on the stream.
    evidenceDurableAtReap = getContainerCausalEvidenceFromEvents(eventsForTask("t-ev")) !== undefined;
    return "killed";
  };
  const exitInfo: ContainerExitInfo = () => ({ exitCode: 137, oomKilled: true, signal: "SIGKILL", finishedAt: LONG_AGO });

  const outcome = performOpsReapContainers(
    { policy: POLICY },
    reap,
    containerList([{ name: "forge-t-ev", finishedAt: LONG_AGO }]),
    exitInfo,
  );

  assert.deepEqual(outcome.reaped, ["forge-t-ev"]);
  assert.ok(evidenceDurableAtReap, "evidence must be durable before the destructive rm");
  const evidence = getContainerCausalEvidenceFromEvents(eventsForTask("t-ev"));
  assert.equal(evidence?.dockerExitCode, 137);
  assert.equal(evidence?.oomKilled, true);
  assert.equal(evidence?.signal, "SIGKILL");
});

test("FG-590 reap policy: even MISSING evidence (docker can't inspect) is persisted before rm", () => {
  insertRun(mkRun("run-d", "failed"));
  insertTask(mkTask("t-missing", "run-d", "failed"));

  const reap: ContainerReap = () => "killed";
  const outcome = performOpsReapContainers(
    { policy: POLICY },
    reap,
    containerList([{ name: "forge-t-missing", finishedAt: LONG_AGO }]),
    () => ({}), // docker inspect returned nothing — the missing-evidence case
  );
  assert.deepEqual(outcome.reaped, ["forge-t-missing"]);
  // The record still exists (naming the container, containerExitedEventObserved: false).
  assert.equal(getContainerCausalEvidenceFromEvents(eventsForTask("t-missing"))?.containerName, "forge-t-missing");
});

test("FG-590 reap policy: when evidence CANNOT be persisted, fail closed — retain the container, do NOT rm", () => {
  insertRun(mkRun("run-e", "failed"));
  insertTask(mkTask("t-failclosed", "run-e", "failed"));
  // Force the evidence INSERT to abort while leaving SELECTs (lookup, absence-heal) working.
  db.exec("CREATE TRIGGER block_event_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'blocked'); END;");

  let reapCalled = false;
  const reap: ContainerReap = () => { reapCalled = true; return "killed"; };
  const outcome = performOpsReapContainers(
    { policy: POLICY },
    reap,
    containerList([{ name: "forge-t-failclosed", finishedAt: LONG_AGO }]),
    () => ({ exitCode: 1 }),
  );

  assert.deepEqual(outcome.evidenceFailed, ["forge-t-failclosed"]);
  assert.deepEqual(outcome.reaped, []);
  assert.equal(reapCalled, false, "the container must NOT be removed when its evidence could not be persisted");
});

test("FG-590 reap policy: a failed container that ALREADY has evidence is reaped without a redundant write", () => {
  insertRun(mkRun("run-f", "failed"));
  insertTask(mkTask("t-haveev", "run-f", "failed"));
  logEvent("task.failed", { runId: "run-f", taskId: "t-haveev", payload: { containerEvidence: { containerName: "forge-t-haveev", containerExitedEventObserved: false, dockerExitCode: 2 } } });
  const before = eventsForTask("t-haveev").length;

  const reap: ContainerReap = () => "killed";
  const outcome = performOpsReapContainers(
    { policy: POLICY },
    reap,
    containerList([{ name: "forge-t-haveev", finishedAt: LONG_AGO }]),
    () => { throw new Error("exitInfo must not be probed when evidence already exists"); },
  );
  assert.deepEqual(outcome.reaped, ["forge-t-haveev"]);
  // Only the post-rm container.reaped resolution was added — no extra pre-rm evidence event.
  assert.equal(eventsForTask("t-haveev").length, before + 1);
});

test("FG-590 reap policy: a running container and a non-terminal task's container are never touched", () => {
  insertRun(mkRun("run-g", "active"));
  insertTask(mkTask("t-running-container", "run-g", "failed"));
  insertTask(mkTask("t-nonterminal", "run-g", "running"));

  let reapCalled = false;
  const reap: ContainerReap = () => { reapCalled = true; return "killed"; };
  const outcome = performOpsReapContainers(
    { policy: POLICY },
    reap,
    containerList([
      { name: "forge-t-running-container", running: true, finishedAt: LONG_AGO },
      { name: "forge-t-nonterminal", finishedAt: LONG_AGO },
    ]),
    () => ({}),
  );
  assert.deepEqual(outcome.reaped, []);
  assert.equal(reapCalled, false);
  assert.equal(outcome.scanned, 0); // neither is a candidate
});

test("FG-590 reap policy: --older-than-minutes still wins over the policy (existing path unchanged)", () => {
  insertRun(mkRun("run-h", "failed"));
  insertTask(mkTask("t-otm", "run-h", "failed"));

  const reap: ContainerReap = () => "killed";
  // finished 5s ago: past the policy failure window would NEVER reap it anyway, but the
  // point is that with --older-than-minutes set, the explicit cutoff governs and retains it.
  const outcome = performOpsReapContainers(
    { policy: POLICY, olderThanMinutes: 60 },
    reap,
    containerList([{ name: "forge-t-otm", finishedAt: recentIso() }]),
    () => ({}),
  );
  assert.deepEqual(outcome.retained, ["forge-t-otm"]);
  assert.deepEqual(outcome.reaped, []);
});
