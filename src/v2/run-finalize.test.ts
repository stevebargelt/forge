// FG-484 — unit tests for the shared settled-finalization helper.
//
// These tests exercise finalizeRunIfSettled's OWN pre-check short-circuit
// (run.status !== "active"), not the store CAS's mid-write refusal — that
// proof lives in store/runs.test.ts's completeRun tests. Written so they'd
// still pass even if completeRun were a naive unconditional update, since
// the helper never reaches the write once a run is no longer active.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import { eventsForRun, logEvent } from "../store/events.js";
import { finalizeRunIfSettled } from "./run-finalize.js";
import type { Run } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-finalize",
  workflow: "investigation",
  title: "finalize helper test",
  status: "active",
  createdAt: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("finalizeRunIfSettled: an already-abandoned run is never touched — no write, no run.completed event", () => {
  insertRun({ ...RUN, id: "run-abandoned" });
  updateRunStatus("run-abandoned", "abandoned");
  const abandonedAt = getRun("run-abandoned")?.completedAt;

  const result = finalizeRunIfSettled("run-abandoned", "test-source");

  assert.equal(result, false, "must refuse to finalize an abandoned run");
  const run = getRun("run-abandoned");
  assert.equal(run?.status, "abandoned", "status must stay abandoned");
  assert.equal(run?.completedAt, abandonedAt, "completedAt must be untouched by the refused call");
  assert.ok(
    !eventsForRun("run-abandoned").some((e) => e.eventType === "run.completed"),
    "no run.completed event may be logged for a refused finalize",
  );
});

test("finalizeRunIfSettled: a settled active run completes and logs run.completed exactly once", () => {
  insertRun({ ...RUN, id: "run-active" });

  const result = finalizeRunIfSettled("run-active", "test-source");

  assert.equal(result, true, "must complete a settled active run");
  const run = getRun("run-active");
  assert.equal(run?.status, "complete");
  assert.ok(run?.completedAt, "completedAt must be set");

  const completedEvents = eventsForRun("run-active").filter((e) => e.eventType === "run.completed");
  assert.equal(completedEvents.length, 1, "run.completed must be logged exactly once");
  assert.equal((completedEvents[0]!.payload as Record<string, unknown>).via, "test-source");
});

test("finalizeRunIfSettled: an already-complete run is a no-op — idempotent close never re-fires run.completed", () => {
  insertRun({ ...RUN, id: "run-already-complete" });
  finalizeRunIfSettled("run-already-complete", "first-close");
  const completedAt = getRun("run-already-complete")?.completedAt;

  const result = finalizeRunIfSettled("run-already-complete", "second-close");

  assert.equal(result, false, "must refuse to re-finalize an already-complete run");
  assert.equal(getRun("run-already-complete")?.completedAt, completedAt, "completedAt must not be bumped");
  const completedEvents = eventsForRun("run-already-complete").filter((e) => e.eventType === "run.completed");
  assert.equal(completedEvents.length, 1, "run.completed must still be logged exactly once total");
});

// FG-463/FG-484: reconcile.ts pairs finalizeRunIfSettled's completion write
// with its own run.reconciled audit event via onCompleted. The old
// getDb().transaction() wrapping reconcile.ts used to give that pairing
// atomicity for free; the FG-484 refactor moved the write into this helper,
// so the helper itself must now guarantee it — onCompleted runs inside the
// SAME transaction as the status write, before commit.
test("finalizeRunIfSettled: onCompleted's paired event commits atomically with the status write — both present when applied, neither when refused", () => {
  insertRun({ ...RUN, id: "run-onCompleted-applied" });

  const result = finalizeRunIfSettled("run-onCompleted-applied", "reconcile", { source: "reconcile" }, () =>
    logEvent("run.reconciled", { runId: "run-onCompleted-applied", payload: { from: "active", to: "complete" } }),
  );

  assert.equal(result, true);
  const eventTypes = eventsForRun("run-onCompleted-applied").map((e) => e.eventType);
  assert.ok(eventTypes.includes("run.completed"), "run.completed must be logged when the write applies");
  assert.ok(eventTypes.includes("run.reconciled"), "the caller-paired event must be logged atomically alongside it");
});

test("finalizeRunIfSettled: onCompleted's paired event is never logged when the write is refused (abandoned run)", () => {
  insertRun({ ...RUN, id: "run-onCompleted-refused" });
  updateRunStatus("run-onCompleted-refused", "abandoned");

  const result = finalizeRunIfSettled("run-onCompleted-refused", "reconcile", { source: "reconcile" }, () =>
    logEvent("run.reconciled", { runId: "run-onCompleted-refused", payload: { from: "active", to: "complete" } }),
  );

  assert.equal(result, false);
  const eventTypes = eventsForRun("run-onCompleted-refused").map((e) => e.eventType);
  assert.ok(!eventTypes.includes("run.completed"), "no run.completed for a refused finalize");
  assert.ok(!eventTypes.includes("run.reconciled"), "onCompleted must not fire when the underlying write is refused");
});

test("finalizeRunIfSettled: extraPayload is merged into the run.completed event payload", () => {
  insertRun({ ...RUN, id: "run-extra-payload" });

  finalizeRunIfSettled("run-extra-payload", "test-source", { anyFailed: true, owned: false });

  const completed = eventsForRun("run-extra-payload").find((e) => e.eventType === "run.completed");
  assert.ok(completed);
  const payload = completed!.payload as Record<string, unknown>;
  assert.equal(payload.via, "test-source");
  assert.equal(payload.anyFailed, true);
  assert.equal(payload.owned, false);
});
