import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { retry, RetryNotAllowedError, FanoutChildRetryError, reapRetainedContainer } from "./retry.js";
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

// RUN declares workflow 'feature', so the YAML it names must exist: retry refuses
// outright when a real run's workflow won't load (FG-507 — an unloadable workflow
// can't prove a task is a workflow step rather than an ad-hoc invoke row). Both
// phases these fixtures use are declared as steps, so every task below is a
// genuine workflow step.
function installFeatureWorkflow(): void {
  const path = join(process.env["FORGE_HOME"]!, "workflows", "feature.yml");
  if (existsSync(path)) return;
  mkdirSync(join(process.env["FORGE_HOME"]!, "workflows"), { recursive: true });
  writeFileSync(
    path,
    `
name: feature
description: retry-test fixture
inputs: []
steps:
  - id: engineer
    agent: engineer
    gate: auto
  - id: build
    agent: engineer
    gate: auto
`,
  );
}

beforeEach(() => { db = makeInMemoryDb(); prev = setDbForTest(db); installFeatureWorkflow(); insertRun(RUN); });
afterEach(() => { setDbForTest(prev as DatabaseInstance); db.close(); });

// ── retryPolicy ──

test("retryPolicy: transient kinds are retryable; outcome kinds are not", () => {
  for (const k of ["idle_timeout", "container_crash", "orphaned", "result_missing", "result_malformed", "model_error", "tool_error", "cancelled", "unknown", "integration_gate_timeout"]) {
    assert.equal(retryPolicy(k).retryable, true, `${k} should be retryable`);
  }
  for (const k of ["gate_rejected", "red_blocked", "integration_gate_crashed", "orphaned_needs_finalize"]) {
    assert.equal(retryPolicy(k).retryable, false, `${k} should NOT be retryable`);
    assert.ok(retryPolicy(k).advice, `${k} should carry advice`);
  }
});

// FG-479: a pipeline step whose finalize never ran holds a preserved result —
// a blind retry would clobber it, so the advice must route through --force.
test("retryPolicy: orphaned_needs_finalize advice points at inspect-then---force, not a blind re-dispatch", () => {
  const d = retryPolicy("orphaned_needs_finalize");
  assert.equal(d.retryable, false);
  assert.match(d.advice ?? "", /--force/);
  assert.match(d.advice ?? "", /forge show/);
});

// FG-424: integration_gate_crashed's advice must point the operator at
// inspecting the environment, not at fixing code that may not be broken.
test("retryPolicy: integration_gate_crashed advice does not say 'fix the code' or suggest git reset", () => {
  const d = retryPolicy("integration_gate_crashed");
  assert.equal(d.retryable, false);
  assert.doesNotMatch(d.advice ?? "", /fix the code/i);
  assert.doesNotMatch(d.advice ?? "", /git reset/i);
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

// FG-533: the crash landed before the container ever launched, so no agent work
// exists to clobber. This is the OPPOSITE of the orphaned_* kinds below — it must
// stay retryable with a bare `forge retry`, and must never grow a --force gate.
test("retryPolicy: pre_container_crash is retryable with no --force gate", () => {
  const d = retryPolicy("pre_container_crash");
  assert.equal(d.retryable, true);
  assert.equal(d.advice, undefined, "no work to salvage → no inspect-then---force advice");
});

test("retry after pre_container_crash: allowed without --force", async () => {
  failedTask("t-pre-container", "pre_container_crash");
  const out = await retry("t-pre-container");
  assert.equal(out.failureKind, "pre_container_crash");
  assert.equal(out.disposition.retryable, true);
  assert.equal(out.newTask.status, "pending");
  const retried = eventsForTask("t-pre-container").find((e) => e.eventType === "task.retried")!;
  assert.equal((retried.payload as Record<string, unknown>).forced, false, "a bare retry must not be recorded as forced");
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

// ── FG-492: reap-before-retry hygiene ────────────────────────────────────────
// retry() always mints a fresh task id (see the newId comment above), so the
// new task's container name (forge-<newId>) never collides with the old
// failed task's retained container — but that old container's diagnostic
// value is spent once an operator retries, so it's reaped as cleanup.

test("reapRetainedContainer: attempts `docker rm -f forge-<taskId>` for the OLD (failed) task", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fake = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;

  reapRetainedContainer("t-old-failed", fake);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cmd: "docker", args: ["rm", "-f", "-v", "forge-t-old-failed"] });
});

test("reapRetainedContainer: never throws when docker is unreachable or the container is already gone", () => {
  const throwingFake = (() => {
    throw new Error("docker: command not found");
  }) as unknown as typeof import("node:child_process").execFileSync;
  assert.doesNotThrow(() => reapRetainedContainer("t-gone", throwingFake));
});

test("retry: reaps the OLD failed task's container as part of a successful retry, without blocking it", async () => {
  failedTask("t-reap-on-retry", "container_crash", "boom");
  const out = await retry("t-reap-on-retry");
  // No real docker in this environment — retry() must still succeed; the reap
  // is best-effort and never blocks the retry itself.
  assert.equal(out.newTask.status, "pending");
});
