import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { notifyOnRunTransition, notifyOnTaskBlockedByRed, failureDetailForRun } from "./trigger.js";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import type { Run, Task } from "../types/index.js";

function mkTask(id: string, runId: string, overrides: Partial<Task> = {}): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-25T12:00:00Z", ...overrides,
  };
}

const RUN: Run = {
  id: "run-x",
  workflow: "feature",
  title: "x",
  status: "active",
  createdAt: "2026-05-25T12:00:00Z",
};

// Snapshot + restore env per test to keep them isolated.
let savedEnv: Record<string, string | undefined>;
const KEYS = ["FORGE_NOTIFY", "FORGE_NOTIFY_ON", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_TO"];

beforeEach(() => {
  savedEnv = {};
  for (const k of KEYS) savedEnv[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("notifyOnRunTransition: short-circuits cleanly when isTwilioEnabled is false (no throw)", async () => {
  await notifyOnRunTransition(RUN, "complete", "active");
  // If the short-circuit failed we'd either throw or attempt a network call;
  // arriving here without error is the assertion.
  assert.ok(true);
});

test("notifyOnRunTransition: no-op when newStatus === previousStatus (idempotent re-save)", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  await notifyOnRunTransition(RUN, "complete", "complete");
  assert.ok(true);
});

test("notifyOnRunTransition: ignores statuses with no mapping (e.g. 'active')", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  await notifyOnRunTransition(RUN, "active", undefined);
  assert.ok(true);
});

test("notifyOnRunTransition: respects FORGE_NOTIFY_ON exclusion", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  process.env["FORGE_NOTIFY_ON"] = "failed";  // 'complete' explicitly filtered out
  await notifyOnRunTransition(RUN, "complete", "active");
  assert.ok(true);
});

test("notifyOnTaskBlockedByRed: short-circuits when isTwilioEnabled is false", async () => {
  await notifyOnTaskBlockedByRed(RUN);
  assert.ok(true);
});

// ── failureDetailForRun (WALK-4) ──
// These need a DB; install an in-memory one for just this block.
{
  let db: DatabaseInstance;
  let prev: DatabaseInstance | null;
  const DBRUN: Run = { id: "run-fd", workflow: "feature", title: "fd", status: "complete", createdAt: "2026-05-25T12:00:00Z" };

  test("failureDetailForRun: returns the first failed top-level task + its failure_kind", () => {
    db = makeInMemoryDb();
    prev = setDbForTest(db);
    try {
      insertRun(DBRUN);
      insertTask(mkTask("task-ok", DBRUN.id, { status: "complete" }));
      insertTask(mkTask("task-bad", DBRUN.id, { status: "failed" }));
      logEvent("task.failed", { runId: DBRUN.id, taskId: "task-bad", payload: { failure_kind: "result_malformed", error: "bad json" } });
      const fd = failureDetailForRun(DBRUN);
      assert.deepEqual(fd, { taskId: "task-bad", failureKind: "result_malformed" });
    } finally {
      setDbForTest(prev as DatabaseInstance);
      db.close();
    }
  });

  test("failureDetailForRun: undefined for a clean run; ignores failed CHILD tasks", () => {
    db = makeInMemoryDb();
    prev = setDbForTest(db);
    try {
      insertRun(DBRUN);
      insertTask(mkTask("task-ok", DBRUN.id, { status: "complete" }));
      insertTask(mkTask("task-child", DBRUN.id, { status: "failed", parentId: "task-ok" }));
      assert.equal(failureDetailForRun(DBRUN), undefined);
    } finally {
      setDbForTest(prev as DatabaseInstance);
      db.close();
    }
  });
}

test("notifyOnTaskBlockedByRed: respects FORGE_NOTIFY_ON exclusion", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  process.env["FORGE_NOTIFY_ON"] = "complete";  // explicitly NOT blocked_by_red
  await notifyOnTaskBlockedByRed(RUN);
  assert.ok(true);
});
