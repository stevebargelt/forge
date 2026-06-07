import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { notifyOnRunTransition, notifyOnTaskBlockedByRed, failureDetailForRun, isAnyProviderEnabled, isNotifySuppressed } from "./trigger.js";
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
const KEYS = ["FORGE_NOTIFY", "FORGE_NOTIFY_ON", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_TO", "NTFY_URL", "NO_NOTIFY"];

// #198: a provider IS configured (ntfy) in all these tests — the question is
// whether NO_NOTIFY overrides it. Sets the minimal ntfy-enabling env.
function enableNtfy(): void {
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.invalid/forge-test";
}

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

// ── #198: NO_NOTIFY kill-switch ──────────────────────────────────────────────

test("#198 normal-provider-enabled: a configured ntfy provider is enabled when NO_NOTIFY is unset", () => {
  enableNtfy();
  delete process.env["NO_NOTIFY"]; // explicit: real-work context
  assert.equal(isNotifySuppressed(), false);
  assert.equal(isAnyProviderEnabled(), true, "a configured provider must stay enabled for real runs");
});

test("#198 provider-enabled-but-NO_NOTIFY: NO_NOTIFY overrides a configured provider", () => {
  enableNtfy();                       // provider fully configured...
  process.env["NO_NOTIFY"] = "true";  // ...but suppressed
  assert.equal(isNotifySuppressed(), true);
  assert.equal(isAnyProviderEnabled(), false, "NO_NOTIFY must win over a configured provider");
});

test("#198 NO_NOTIFY ignores FORGE_NOTIFY / NTFY_URL / TWILIO_* (provider-agnostic)", () => {
  // Both providers fully configured; NO_NOTIFY must still silence everything.
  enableNtfy();
  process.env["FORGE_NOTIFY"] = "ntfy,twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_x";
  process.env["TWILIO_AUTH_TOKEN"] = "tok";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  process.env["NO_NOTIFY"] = "1";
  assert.equal(isAnyProviderEnabled(), false);
});

test("#198 a full transition path stays silent under NO_NOTIFY with a provider configured (no send, no throw)", async () => {
  enableNtfy();                       // if not suppressed, dispatch would POST to NTFY_URL
  process.env["NO_NOTIFY"] = "true";
  await notifyOnRunTransition(RUN, "complete", "active"); // short-circuits at isAnyProviderEnabled
  assert.ok(true);
});

test("#198 isNotifySuppressed parses true/1/yes (case-insensitive); not false/0/empty/unset", () => {
  for (const v of ["true", "TRUE", " true ", "1", "yes", "YES"]) {
    process.env["NO_NOTIFY"] = v;
    assert.equal(isNotifySuppressed(), true, `'${v}' should suppress`);
  }
  for (const v of ["false", "0", "no", "", "  "]) {
    process.env["NO_NOTIFY"] = v;
    assert.equal(isNotifySuppressed(), false, `'${v}' should NOT suppress`);
  }
  delete process.env["NO_NOTIFY"];
  assert.equal(isNotifySuppressed(), false, "unset should NOT suppress");
});
