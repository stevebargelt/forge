import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { retry, RetryNotAllowedError, FanoutChildRetryError } from "./retry.js";
import { retryPolicy } from "./retry-policy.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const RUN: Run = { id: "run-retry", workflow: "feature", title: "retry", status: "active", createdAt: "2026-05-30T00:00:00Z" };

function failedTask(id: string, failureKind: string | undefined, error = "boom"): Task {
  const t: Task = {
    id, runId: RUN.id, phase: "engineer", agentRole: "engineer", status: "failed", error,
    taskPackage: { taskId: id, runId: RUN.id, phase: "engineer", role: "engineer", inputs: { brief: "do the thing" }, composedSystemPrompt: "PROMPT" },
    createdAt: "2026-05-30T00:00:00Z",
  };
  insertTask(t);
  if (failureKind) logEvent("task.failed", { runId: RUN.id, taskId: id, payload: { failure_kind: failureKind, error } });
  return t;
}

beforeEach(() => { db = makeInMemoryDb(); prev = setDbForTest(db); insertRun(RUN); });
afterEach(() => { setDbForTest(prev as DatabaseInstance); db.close(); });

// ── retryPolicy ──

test("retryPolicy: transient kinds are retryable; outcome kinds are not", () => {
  for (const k of ["idle_timeout", "container_crash", "orphaned", "result_missing", "result_malformed", "model_error", "tool_error", "cancelled", "unknown"]) {
    assert.equal(retryPolicy(k).retryable, true, `${k} should be retryable`);
  }
  for (const k of ["gate_rejected", "red_blocked"]) {
    assert.equal(retryPolicy(k).retryable, false, `${k} should NOT be retryable`);
    assert.ok(retryPolicy(k).advice, `${k} should carry advice`);
  }
});

test("retryPolicy: auth kinds are retryable but carry resolve-auth advice", () => {
  for (const k of ["auth_missing", "auth_expired", "auth_injection_failed"]) {
    const d = retryPolicy(k);
    assert.equal(d.retryable, true);
    assert.match(d.advice ?? "", /auth|session|profile/i);
  }
});

test("retryPolicy: undefined / unknown label → retryable", () => {
  assert.equal(retryPolicy(undefined).retryable, true);
  assert.equal(retryPolicy("some_new_kind").retryable, true);
});

// ── retry() ──

test("retry: refuses a missing task and a non-failed task", async () => {
  await assert.rejects(retry("does-not-exist"), /not found/);
  insertTask({ id: "t-running", runId: RUN.id, phase: "engineer", agentRole: "engineer", status: "running",
    taskPackage: { taskId: "t-running", runId: RUN.id, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z" });
  await assert.rejects(retry("t-running"), /not failed/);
});

test("retry after idle_timeout: new pending task with lineage + previous_failure context", async () => {
  failedTask("t-idle", "idle_timeout", "no output for 10m");
  const out = await retry("t-idle");
  assert.equal(out.failureKind, "idle_timeout");
  assert.equal(out.disposition.retryable, true);
  const nt = getTask(out.newTask.id)!;
  assert.equal(nt.status, "pending");
  // PRIMARY task (parentId undefined) so runNext.dispatchStep reuses it; lineage
  // is carried in previous_failure, not parentId.
  assert.equal(nt.parentId, undefined, "retry task is a primary so it actually dispatches");
  // previous failure handed forward as context (no secrets — prose + tag only).
  const pf = (nt.taskPackage.inputs as Record<string, unknown>)["previous_failure"] as Record<string, unknown>;
  assert.equal(pf.kind, "idle_timeout");
  assert.equal(pf.error, "no output for 10m");
  assert.equal(pf.failedTaskId, "t-idle");
  // original kept as failed for audit; task.retried records the kind.
  assert.equal(getTask("t-idle")!.status, "failed");
  const retried = eventsForTask("t-idle").find((e) => e.eventType === "task.retried")!;
  assert.equal((retried.payload as Record<string, unknown>).failure_kind, "idle_timeout");
});

test("retry after auth failure: allowed (user may have fixed auth), disposition carries advice", async () => {
  failedTask("t-auth", "auth_expired");
  const out = await retry("t-auth");
  assert.equal(out.disposition.retryable, true);
  assert.match(out.disposition.advice ?? "", /refresh|session|profile/i);
});

test("retry after cancelled / malformed: allowed", async () => {
  failedTask("t-cancel", "cancelled");
  assert.equal((await retry("t-cancel")).newTask.status, "pending");
  failedTask("t-mal", "result_malformed");
  assert.equal((await retry("t-mal")).newTask.status, "pending");
});

test("retry after gate_rejected: refused without --force, allowed with --force", async () => {
  failedTask("t-gate", "gate_rejected");
  await assert.rejects(retry("t-gate"), RetryNotAllowedError);
  // not retryable kinds must not have created a new task on the refused attempt
  assert.equal(eventsForTask("t-gate").some((e) => e.eventType === "task.retried"), false);
  // --force overrides
  const out = await retry("t-gate", { force: true });
  assert.equal(out.newTask.status, "pending");
  const retried = eventsForTask("t-gate").find((e) => e.eventType === "task.retried")!;
  assert.equal((retried.payload as Record<string, unknown>).forced, true);
});

test("retry after red_blocked: refused without --force", async () => {
  failedTask("t-red", "red_blocked");
  await assert.rejects(retry("t-red"), RetryNotAllowedError);
});

// FG-455: a dirty worktree may hold real, unreviewed work — a blind retry
// would re-dispatch over it. Same "needs --force" shape as gate_rejected/red_blocked.
test("retryPolicy: orphaned_work_may_persist is NOT retryable (don't clobber a dirty worktree)", () => {
  const d = retryPolicy("orphaned_work_may_persist");
  assert.equal(d.retryable, false);
  assert.ok(d.advice, "must carry advice on how to proceed");
});

test("retry after orphaned_work_may_persist: refused without --force, allowed with --force", async () => {
  failedTask("t-orphan-work", "orphaned_work_may_persist");
  await assert.rejects(retry("t-orphan-work"), RetryNotAllowedError);
  assert.equal(eventsForTask("t-orphan-work").some((e) => e.eventType === "task.retried"), false);
  const out = await retry("t-orphan-work", { force: true });
  assert.equal(out.newTask.status, "pending");
  const retried = eventsForTask("t-orphan-work").find((e) => e.eventType === "task.retried")!;
  assert.equal((retried.payload as Record<string, unknown>).forced, true);
});

// FG-455 p4 review finding 3 (HIGH, data-loss): oom_killed used to fall through
// to the default `{retryable: true, reason: "unrecognized failure kind..."}`,
// so `forge retry` would silently re-dispatch over an oom_killed task's dirty
// worktree — the exact clobber orphaned_work_may_persist's retryable:false was
// created to prevent. Same "needs --force" shape as orphaned_work_may_persist.
test("retryPolicy: oom_killed is NOT retryable (don't clobber a possibly-persisted worktree after an OOM/kill)", () => {
  const d = retryPolicy("oom_killed");
  assert.equal(d.retryable, false);
  assert.ok(d.advice, "must carry advice on how to proceed");
});

test("retry after oom_killed: refused without --force, allowed with --force", async () => {
  failedTask("t-oom-killed", "oom_killed");
  await assert.rejects(retry("t-oom-killed"), RetryNotAllowedError);
  assert.equal(eventsForTask("t-oom-killed").some((e) => e.eventType === "task.retried"), false);
  const out = await retry("t-oom-killed", { force: true });
  assert.equal(out.newTask.status, "pending");
  const retried = eventsForTask("t-oom-killed").find((e) => e.eventType === "task.retried")!;
  assert.equal((retried.payload as Record<string, unknown>).forced, true);
});

// ── FG-455 p3: retrying a fanout child directly must not strand a detached
// parentId=undefined primary in the fanout's phase — `forge recover <parent>
// --re-drive` is the coherent path instead. ──

test("retry: a fanout child is refused without --force, pointing at forge recover --re-drive", async () => {
  insertTask({
    id: "parent-fanout", runId: RUN.id, phase: "build", agentRole: "fanout", status: "failed",
    taskPackage: { taskId: "parent-fanout", runId: RUN.id, phase: "build", role: "fanout", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });
  insertTask({
    id: "child-fanout", runId: RUN.id, parentId: "parent-fanout", phase: "build", agentRole: "engineer", status: "failed", error: "boom",
    taskPackage: { taskId: "child-fanout", runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });

  await assert.rejects(retry("child-fanout"), (e: unknown) => {
    assert.ok(e instanceof FanoutChildRetryError);
    assert.match(e.message, /forge recover parent-fanout --re-drive/);
    return true;
  });
  // refused attempt must create no new task and log no task.retried
  assert.equal(eventsForTask("child-fanout").some((e) => e.eventType === "task.retried"), false);
  assert.equal(getTask("child-fanout")!.status, "failed", "left untouched by the refusal");
});

test("retry: --force preserves the old behavior for a fanout child (mints the detached primary anyway)", async () => {
  insertTask({
    id: "parent-fanout-force", runId: RUN.id, phase: "build", agentRole: "fanout", status: "failed",
    taskPackage: { taskId: "parent-fanout-force", runId: RUN.id, phase: "build", role: "fanout", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });
  insertTask({
    id: "child-fanout-force", runId: RUN.id, parentId: "parent-fanout-force", phase: "build", agentRole: "engineer", status: "failed", error: "boom",
    taskPackage: { taskId: "child-fanout-force", runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });

  const out = await retry("child-fanout-force", { force: true });
  assert.equal(out.newTask.status, "pending");
  assert.equal(out.newTask.parentId, undefined, "still mints a primary — --force preserves pre-FG-455 behavior");
  assert.equal(out.newTask.phase, "build");
});

test("retry: an ordinary primary (no fanout parent) is unaffected by the strand guard", async () => {
  failedTask("t-ordinary", "unknown");
  const out = await retry("t-ordinary");
  assert.equal(out.newTask.status, "pending");
  assert.equal(out.newTask.parentId, undefined);
});

// ── FG-455 p2/p3 review finding 1: retrying the fanout PARENT itself (not a
// child) must also be refused without --force — a blind retry mints a second,
// uncoordinated pending primary, bypassing `forge recover --re-drive`'s
// dupePending refusal and audit trail. Closed via retry-policy.ts's
// fanout_wave_orphaned entry (retryable: false), the same mechanism already
// used for gate_rejected / red_blocked / orphaned_work_may_persist. ──

test("retryPolicy: fanout_wave_orphaned is NOT retryable, advice points at forge recover --re-drive", () => {
  const d = retryPolicy("fanout_wave_orphaned");
  assert.equal(d.retryable, false);
  assert.match(d.advice ?? "", /forge recover .*--re-drive/);
});

test("retry: a fanout PARENT (failed, failure_kind fanout_wave_orphaned) is refused without --force", async () => {
  failedTask("parent-orphaned-wave", "fanout_wave_orphaned", "fanout wave orphaned: 1/2 children complete");
  await assert.rejects(retry("parent-orphaned-wave"), (e: unknown) => {
    assert.ok(e instanceof RetryNotAllowedError);
    assert.match(e.message, /forge recover .*--re-drive/);
    return true;
  });
  // refused attempt must create no new task and log no task.retried
  assert.equal(eventsForTask("parent-orphaned-wave").some((e) => e.eventType === "task.retried"), false);
  assert.equal(getTask("parent-orphaned-wave")!.status, "failed", "left untouched by the refusal");
});

test("retry: --force lets a determined operator retry a fanout parent anyway", async () => {
  failedTask("parent-orphaned-wave-force", "fanout_wave_orphaned");
  const out = await retry("parent-orphaned-wave-force", { force: true });
  assert.equal(out.newTask.status, "pending");
  const retried = eventsForTask("parent-orphaned-wave-force").find((e) => e.eventType === "task.retried")!;
  assert.equal((retried.payload as Record<string, unknown>).forced, true);
});

test("retry: a RED reviewer child (parentId + same phase, agentRole prefixed red-) is not treated as a fanout child", async () => {
  insertTask({
    id: "primary-with-red", runId: RUN.id, phase: "build", agentRole: "engineer", status: "complete",
    taskPackage: { taskId: "primary-with-red", runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });
  insertTask({
    id: "red-child", runId: RUN.id, parentId: "primary-with-red", phase: "build", agentRole: "red-security", status: "failed", error: "boom",
    taskPackage: { taskId: "red-child", runId: RUN.id, phase: "build", role: "red-security", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });

  const out = await retry("red-child");
  assert.equal(out.newTask.status, "pending");
  assert.equal(out.newTask.parentId, undefined);
});
