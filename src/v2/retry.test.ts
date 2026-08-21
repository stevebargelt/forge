import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import { insertTask, getTask, tasksForRun } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import {
  retry,
  RetryNotAllowedError,
  FanoutChildRetryError,
  RedReviewRetryError,
  OrderedFanoutParentRetryError,
  OrderedWaveReDriveUnavailableError,
  reapRetainedContainer,
} from "./retry.js";
// The verb the redirect names, called for real: these cells assert that when retry
// points at `--re-drive` the guard ACCEPTS it, and that when the guard refuses,
// retry points somewhere else.
import { performReDrive } from "../cli/commands/recover.js";
import { retryPolicy, RE_DRIVABLE_FAILURE_KINDS, isReDrivableFailureKind } from "./retry-policy.js";
import type { FailureKind } from "./failure-kind.js";
import type { Run, Task } from "../types/index.js";
import { taskDir } from "../util/paths.js";
import { protocolRelPath } from "./agent-protocol.js";
import { resolveSeedGeneration } from "./seed-generation.js";
import { createHash } from "node:crypto";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
// A non-shipped workflow name on purpose: FG-579 makes loadWorkflow refuse a HOST
// workflow whose bytes drift from a shipped seed of the same name, and these
// fixtures install a bespoke workflow body. A name the release does not ship has
// no baseline to drift from, so the loader admits the fixture as-is.
const RUN: Run = { id: "run-retry", workflow: "retry-fixture", title: "retry", status: "active", createdAt: "2026-05-30T00:00:00Z" };

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

// RUN declares workflow 'retry-fixture', so the YAML it names must exist: retry
// refuses outright when a real run's workflow won't load (FG-507 — an unloadable
// workflow can't prove a task is a workflow step rather than an ad-hoc invoke row).
// Both phases these fixtures use are declared as steps, so every task below is a
// genuine workflow step.
function installFeatureWorkflow(): void {
  const path = join(process.env["FORGE_HOME"]!, "workflows", "retry-fixture.yml");
  if (existsSync(path)) return;
  mkdirSync(join(process.env["FORGE_HOME"]!, "workflows"), { recursive: true });
  writeFileSync(
    path,
    `
name: retry-fixture
description: retry-test fixture
inputs: []
steps:
  - id: engineer
    agent: engineer
    gate: auto
  - id: build
    agent: engineer
    gate: auto
    reds:
      - agent: red-security
        authority: authoritative
      - agent: shipping-reviewer
        authority: authoritative
`,
  );
  // FG-583: dispatch reads only a published generation — publish the flat fixture.
  publishFlatAsGeneration(process.env["FORGE_HOME"]!);
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

// ── FG-688: isReDrivableFailureKind — the shared re-drive enumeration ──

// Every FailureKind this build declares, written out ONCE here so the runtime
// key-set assertion below has something to compare against (the union is a type,
// not a value). The two type-level checks that follow make this list itself
// exhaustive: adding a kind to FailureKind without adding it here fails to
// COMPILE, so the runtime assertion can never silently check a stale subset.
const ALL_FAILURE_KINDS = [
  "cancelled", "orphaned", "orphaned_work_may_persist", "oom_killed", "fanout_wave_orphaned",
  "orphaned_needs_finalize", "container_crash", "idle_timeout", "result_missing", "result_malformed",
  "work_not_persisted", "merge_conflict", "capture_failed", "integration_failed", "integration_gate_timeout",
  "integration_gate_crashed", "publish_base_churn", "dirty_publish_target", "publication_refused",
  "lane_taken_over", "auth_missing", "auth_expired", "auth_injection_failed", "model_error", "tool_error",
  "red_blocked", "gate_rejected", "verification_environment_unavailable", "agent_reported_failure",
  "pre_container_crash", "plan_dependency_invalid", "ordered_fanout_unavailable", "integration_blocked",
  "prerequisite_blocked", "unknown",
] as const;

// Compile-time exhaustiveness, both directions: nothing in FailureKind may be
// missing from the list, and nothing in the list may name a kind that no longer
// exists. Written as `AssertNever<Exclude<…>>` rather than the tempting
// `const x: Exclude<…>[] = []` — an EMPTY ARRAY is assignable to any element
// type, so that form silently passes and proves nothing.
type AssertNever<T extends never> = T;
type _MissingKinds = AssertNever<Exclude<FailureKind, (typeof ALL_FAILURE_KINDS)[number]>>;
type _StaleKinds = AssertNever<Exclude<(typeof ALL_FAILURE_KINDS)[number], FailureKind>>;

const RE_DRIVABLE = new Set<string>([
  "fanout_wave_orphaned",
  "prerequisite_blocked",
  "integration_gate_timeout",
  "integration_gate_crashed",
  "verification_environment_unavailable",
  "integration_blocked",
]);

// The map is Record<FailureKind, boolean>, so a new kind cannot be added to the
// union without deciding this question — that guarantee is a COMPILE-time one
// and lives in retry-policy.ts. This asserts the value agrees with it: no key
// the union doesn't declare, and no kind the map forgot.
test("RE_DRIVABLE_FAILURE_KINDS: key set is exactly the FailureKind union", () => {
  assert.deepEqual(
    Object.keys(RE_DRIVABLE_FAILURE_KINDS).sort(),
    [...ALL_FAILURE_KINDS].sort(),
  );
});

test("isReDrivableFailureKind: true for the six accepted kinds, false for every other declared kind", () => {
  for (const kind of ALL_FAILURE_KINDS) {
    assert.equal(
      isReDrivableFailureKind(kind),
      RE_DRIVABLE.has(kind),
      `${kind} should ${RE_DRIVABLE.has(kind) ? "" : "NOT "}be re-drivable`,
    );
  }
  // Spelled out rather than left implicit in the loop: these six are the
  // authored membership, and a change to it should break a named assertion.
  assert.deepEqual(
    Object.entries(RE_DRIVABLE_FAILURE_KINDS).filter(([, v]) => v).map(([k]) => k).sort(),
    [...RE_DRIVABLE].sort(),
  );
});

// The load-bearing divergence: retryPolicy is ADVISORY and defaults an unknown
// kind OPEN (retryable); this is a MUTATION guard and defaults CLOSED. Asserted
// side by side in one test so the contrast is recorded in the suite, not only in
// a comment that a future edit could quietly contradict.
test("isReDrivableFailureKind: fails CLOSED on undefined and on a kind from a future build — unlike retryPolicy", () => {
  assert.equal(isReDrivableFailureKind(undefined), false);
  assert.equal(isReDrivableFailureKind("kind_from_a_future_build"), false);
  assert.equal(isReDrivableFailureKind(""), false);

  // Same two inputs through the advisory surface: permissive, on purpose.
  assert.equal(retryPolicy("kind_from_a_future_build").retryable, true);
  assert.equal(retryPolicy(undefined).retryable, true);
});

// A prototype-chain key ("toString", "constructor") must not read back as a
// re-drivable kind. The map is an object literal, so a bare `map[k]` truthiness
// check would have accepted these; the `=== true` comparison is what refuses.
test("isReDrivableFailureKind: inherited Object.prototype keys are refused", () => {
  for (const k of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(isReDrivableFailureKind(k), false, `${k} must not be re-drivable`);
  }
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

// ── FG-688: `forge retry <ordered fanout parent>` is the OTHER misadvising
// surface. It mints a fresh PRIMARY with parentId unset, and adoption is scoped
// to the CURRENT parent, so the retried wave cannot reach this parent's captured,
// already-integrated children — it re-runs every completed item. The refusal
// redirects to the verb that adopts them, and preserves --force. ──

/** An ordered fan-out wave's parent: a parent-less failed row with children, plus
 *  the durable `integration.worktree_created` evidence runOrderedWave writes before
 *  any child is dispatched. `ordered: false` (or the event's absence) is what makes
 *  the SAME fixture an unordered wave, which is how the tests below prove the flag
 *  — not the shape — is what discriminates the two lanes. */
function fanoutWaveParent(
  id: string,
  failureKind: string,
  opts?: { ordered?: boolean | "no-event"; childStatus?: string },
): void {
  insertTask({
    id, runId: RUN.id, phase: "build", agentRole: "engineer", status: "failed", error: "prerequisite blocked",
    taskPackage: { taskId: id, runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });
  // FG-716: a real fanout child carries the fanoutIndex dispatchFanoutChild stamps —
  // recover's --re-drive path (performReDrive) counts fanout children (isFanoutChildRow).
  ["a", "b"].forEach((suffix, index) => {
    insertTask({
      id: `${id}-${suffix}`, runId: RUN.id, parentId: id, phase: "build", agentRole: "engineer",
      status: (opts?.childStatus ?? "complete") as Task["status"],
      taskPackage: { taskId: `${id}-${suffix}`, runId: RUN.id, phase: "build", role: "engineer", inputs: { fanoutIndex: index }, composedSystemPrompt: "" },
      createdAt: "2026-05-30T00:00:00Z",
    });
  });
  const ordered = opts?.ordered ?? true;
  if (ordered !== "no-event") {
    logEvent("integration.worktree_created", { runId: RUN.id, taskId: id, payload: { ordered } });
  }
  logEvent("task.failed", { runId: RUN.id, taskId: id, payload: { failure_kind: failureKind, error: "prerequisite blocked" } });
}

test("FG-688: a bare `forge retry` on an ordered fanout parent (prerequisite_blocked) is refused and names the re-drive", async () => {
  fanoutWaveParent("ord-parent-blocked", "prerequisite_blocked");
  const before = tasksForRun(RUN.id).length;

  await assert.rejects(retry("ord-parent-blocked"), (e: unknown) => {
    assert.ok(e instanceof OrderedFanoutParentRetryError, "the ordered lane gets its own named refusal");
    assert.equal(e.failureKind, "prerequisite_blocked");
    assert.match(e.message, /forge recover ord-parent-blocked --re-drive/);
    // The refusal must say WHY retry is the wrong verb — that a fresh primary
    // cannot adopt this parent's already-integrated children — not merely that
    // another command exists.
    assert.match(e.message, /adopt/i);
    return true;
  });

  // The whole point of refusing BEFORE any write: no discarding primary exists.
  assert.equal(tasksForRun(RUN.id).length, before, "no new task row was inserted");
  assert.equal(eventsForTask("ord-parent-blocked").some((e) => e.eventType === "task.retried"), false);
  assert.equal(getTask("ord-parent-blocked")!.status, "failed", "left untouched by the refusal");
});

test("FG-688: the CLI renders the ordered-parent refusal — it is a RetryNotAllowedError, so no new catch arm is needed", async () => {
  fanoutWaveParent("ord-parent-render", "prerequisite_blocked");
  await assert.rejects(retry("ord-parent-render"), (e: unknown) => {
    assert.ok(e instanceof RetryNotAllowedError, "cli/commands/retry.ts catches this class and prints its message + advice");
    assert.equal((e as RetryNotAllowedError).disposition.retryable, false);
    assert.match((e as RetryNotAllowedError).disposition.advice ?? "", /forge recover ord-parent-render --re-drive/);
    return true;
  });
});

test("FG-688: --force still retries an ordered fanout parent — the operator's explicit override is preserved", async () => {
  fanoutWaveParent("ord-parent-force", "prerequisite_blocked");
  const out = await retry("ord-parent-force", { force: true });
  assert.equal(out.newTask.status, "pending");
  assert.equal(out.newTask.parentId, undefined, "still mints a fresh primary — --force is the pre-FG-688 behaviour verbatim");
  assert.equal(out.newTask.phase, "build");
});

test("FG-688: an UNORDERED fanout parent keeps its existing fanout_wave_orphaned behaviour exactly", async () => {
  // Same rows, same children, same failure — only `ordered` differs. That is what
  // proves the new lane is gated on the durable ordering flag and cannot swallow
  // the pre-existing refusal.
  fanoutWaveParent("unord-parent", "fanout_wave_orphaned", { ordered: false });

  await assert.rejects(retry("unord-parent"), (e: unknown) => {
    assert.ok(e instanceof RetryNotAllowedError);
    assert.ok(!(e instanceof OrderedFanoutParentRetryError), "the unordered lane must not be rerouted");
    // retry-policy.ts's own fanout_wave_orphaned entry, untouched by this ticket.
    assert.match(e.message, /uncoordinated pending primary/);
    return true;
  });
  assert.equal(getTask("unord-parent")!.status, "failed");
});

test("FG-688: a fanout parent with no integration.worktree_created event at all is not provably ordered — untouched", async () => {
  // `fanout_wave_orphaned` is in the re-drive enumeration, so ONLY the ordering
  // evidence stands between this row and the new lane. Absence must read as "not
  // provably ordered", never as a default.
  fanoutWaveParent("no-eviden-parent", "fanout_wave_orphaned", { ordered: "no-event" });
  await assert.rejects(retry("no-eviden-parent"), (e: unknown) => {
    assert.ok(!(e instanceof OrderedFanoutParentRetryError));
    return true;
  });
});

test("FG-688: a NON-fanout failed task with the same failure kind is unaffected", async () => {
  // prerequisite_blocked is retryable:true, so an ordinary primary carrying it
  // must retry cleanly — the redirect is scoped to wave PARENTS, not to the kind.
  failedTask("t-blocked-primary", "prerequisite_blocked");
  const out = await retry("t-blocked-primary");
  assert.equal(out.newTask.status, "pending");
  assert.equal(out.newTask.parentId, undefined);
});

// ── FG-688 build review, finding 1: the redirect must consult the SAME live state
// the re-drive guard enforces. Supersession and the run's status are two clauses
// `performReDrive` refuses on and the first cut of this redirect never read, so
// `forge retry` could advise a `--re-drive` that immediately refused — bouncing the
// operator between two refusals with no accepted verb named. Each cell below drives
// the guard for real, so "the named verb is accepted" is proved, not asserted. ──

/** A later parent-less primary in the parent's phase — exactly what `forge retry
 *  <parent> --force` and `forge gate request-changes` mint. */
function supersedingPrimaryRow(id: string): void {
  insertTask({
    id, runId: RUN.id, phase: "build", agentRole: "engineer", status: "pending",
    taskPackage: { taskId: id, runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T00:00:00Z",
  });
}

test("FG-688 (finding 1): a SUPERSEDED ordered parent is refused with a verb that IS accepted — not the --re-drive that would refuse it", async () => {
  fanoutWaveParent("ord-parent-superseded", "prerequisite_blocked");
  supersedingPrimaryRow("ord-parent-live");

  // The verb the first cut advised, driven for real at this exact state.
  assert.equal(
    performReDrive("ord-parent-superseded").kind,
    "re-drive-refused",
    "sanity: `forge recover <parent> --re-drive` refuses a superseded parent — so advising it is the defect",
  );

  const before = tasksForRun(RUN.id).length;
  await assert.rejects(retry("ord-parent-superseded"), (e: unknown) => {
    assert.ok(e instanceof OrderedWaveReDriveUnavailableError, "the ineligible lane gets its own named refusal");
    assert.ok(!(e instanceof OrderedFanoutParentRetryError), "…and NOT the one that names --re-drive");
    assert.equal(e.reDrive.disposition, "superseded");
    assert.equal(e.reDrive.supersededBy, "ord-parent-live");
    // The VERB, read off the discrete commands — the same standard the recover
    // surface's own invariant test uses, since a refusal's prose may legitimately
    // mention --re-drive while explaining why it is not being offered.
    assert.deepEqual(e.recommendationCommands, [`forge next ${RUN.id}`], "it names the verb the recover surface names");
    assert.equal(e.recommendationCommands.some((c) => c.includes("--re-drive")), false);
    assert.match(e.message, /ord-parent-live/, "…and says which primary owns the phase now");
    return true;
  });

  assert.equal(tasksForRun(RUN.id).length, before, "the refusal minted no discarding primary");
  assert.equal(eventsForTask("ord-parent-superseded").some((e) => e.eventType === "task.retried"), false);

  // --force is untouched: this is medium and not high precisely because the
  // operator's explicit override still proceeds.
  const out = await retry("ord-parent-superseded", { force: true });
  assert.equal(out.newTask.status, "pending");
  assert.equal(out.newTask.parentId, undefined);
});

test("FG-688 (finding 1): an ordered parent whose run was CANCELLED is refused with an accepted verb — an abandoned run is terminal for --re-drive", async () => {
  fanoutWaveParent("ord-parent-abandoned", "prerequisite_blocked");
  updateRunStatus(RUN.id, "abandoned");

  assert.equal(
    performReDrive("ord-parent-abandoned").kind,
    "re-drive-refused",
    "sanity: no recovery verb resurrects an abandoned run — so advising --re-drive is the defect",
  );

  const before = tasksForRun(RUN.id).length;
  await assert.rejects(retry("ord-parent-abandoned"), (e: unknown) => {
    assert.ok(e instanceof OrderedWaveReDriveUnavailableError);
    assert.ok(!(e instanceof OrderedFanoutParentRetryError));
    assert.equal(e.reDrive.disposition, "run_not_reopenable");
    assert.equal(e.recommendationCommands.some((c) => c.includes("--re-drive")), false, "never the verb that refuses");
    assert.match(e.disposition.advice ?? "", /forge retry ord-parent-abandoned --force/, "it names the forward verb that IS accepted");
    assert.match(e.message, /abandoned/);
    return true;
  });

  assert.equal(tasksForRun(RUN.id).length, before, "the refusal minted no discarding primary");

  // And the named verb really is accepted — the only way to prove the operator is
  // no longer bounced between two refusals.
  const out = await retry("ord-parent-abandoned", { force: true });
  assert.equal(out.newTask.status, "pending");
  assert.equal(getRun(RUN.id)!.status, "active", "the forced retry reactivated the cancelled run, as it always has");
});

test("FG-688 (finding 1): the ELIGIBLE case still names --re-drive — and that command is accepted at the same state", async () => {
  fanoutWaveParent("ord-parent-eligible", "prerequisite_blocked");
  await assert.rejects(retry("ord-parent-eligible"), (e: unknown) => {
    assert.ok(e instanceof OrderedFanoutParentRetryError);
    assert.match(e.message, /forge recover ord-parent-eligible --re-drive/);
    return true;
  });
  // The invariant, driven: the verb retry named is the verb the guard accepts.
  const outcome = performReDrive("ord-parent-eligible");
  assert.equal(outcome.kind, "re-drive-done", `retry may only name a verb that is accepted; got ${JSON.stringify(outcome)}`);
});

test("FG-688: an ordered fanout parent whose kind the re-drive REFUSES is not redirected at it", async () => {
  // plan_dependency_invalid is false in the enumeration: a re-drive re-reads the
  // same plan and refuses at the same place, so pointing an operator there would
  // reintroduce exactly the defect this ticket closes, in mirror image.
  fanoutWaveParent("ord-parent-plan-invalid", "plan_dependency_invalid");
  await assert.rejects(retry("ord-parent-plan-invalid"), (e: unknown) => {
    assert.ok(e instanceof RetryNotAllowedError);
    assert.ok(!(e instanceof OrderedFanoutParentRetryError), "the guard would reject this kind, so the advice must not name it");
    assert.match(e.message, /request-changes/, "it keeps plan_dependency_invalid's own remediation");
    return true;
  });
});

test("FG-688: an ordered fanout parent carrying a kind from a FUTURE build is not redirected — fail closed", async () => {
  fanoutWaveParent("ord-parent-future", "kind_from_a_future_build");
  // Unrecognized → isReDrivableFailureKind false → no redirect. retryPolicy's
  // opposite (advisory, permissive) default then lets the ordinary retry proceed.
  const out = await retry("ord-parent-future");
  assert.equal(out.newTask.status, "pending", "it falls through to the ordinary retry path, not to a verb that would refuse");
});

// The advice half of the same defect: retry-policy.ts is what `forge show` and
// `forge retry` PRINT, and for these two kinds it named a verb that discards the
// captured work.

test("FG-688: prerequisite_blocked advice names `forge recover <id> --re-drive` with the placeholder substituted", () => {
  const d = retryPolicy("prerequisite_blocked", "task-x");
  assert.equal(d.retryable, true, "retryability was already right — the wave IS re-drivable");
  assert.match(d.advice ?? "", /forge recover task-x --re-drive/);
  assert.match(d.advice ?? "", /adopt/i, "and it must say the re-drive adopts the integrated items rather than re-running them");
});

test("FG-688: integration_blocked's final step is a re-drive, not `forge retry <id> --force`", () => {
  const d = retryPolicy("integration_blocked", "task-y");
  assert.match(d.advice ?? "", /forge recover task-y --re-drive/);
  assert.doesNotMatch(d.advice ?? "", /forge retry task-y --force/);
  // The rebase-the-worker remediation ahead of it is unchanged.
  assert.match(d.advice ?? "", /rebase the worker's branch/);
});

// FG-629: a workflow-step red reviewer (classifier kind `red_review`, whether or not
// its agent name starts with `red-`) is NOT independently retryable. Retrying it used
// to mint a fresh parentId-undefined primary (see the git history of these two cells,
// which asserted exactly that) — which dispatchSingleStep then reuses as the phase's
// primary and runs under the STEP's agent/prompt, producing a duplicate artifact and
// a fresh red wave. `forge retry` now REFUSES with RedReviewRetryError, naming the
// primary the red reviewed and the through-the-primary recovery, and writes no row.
// The build step of the retry-fixture declares both a `red-`-prefixed red
// (red-security) and one that is NOT prefixed (shipping-reviewer), so these two cells
// exercise both classification paths.
test("retry (FG-629): a RED reviewer child (red-security, `red-`-prefixed) is refused — no duplicate primary minted", async () => {
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
  const before = tasksForRun(RUN.id).map((t) => t.id);

  await assert.rejects(() => retry("red-child"), (e: unknown) => {
    assert.ok(e instanceof RedReviewRetryError, `expected RedReviewRetryError, got ${e}`);
    assert.equal((e as RedReviewRetryError).primaryId, "primary-with-red", "the refusal names the primary the red reviewed");
    assert.match((e as RedReviewRetryError).message, /forge gate primary-with-red/, "and points recovery through the primary's gate");
    return true;
  });
  assert.deepEqual(tasksForRun(RUN.id).map((t) => t.id), before, "no row created — refused before any write");
});

test("retry (FG-629): --force does NOT override a red_review refusal — there is no coherent forced 'mint a primary from a red'", async () => {
  insertTask({
    id: "primary-force", runId: RUN.id, phase: "build", agentRole: "engineer", status: "complete",
    taskPackage: { taskId: "primary-force", runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });
  insertTask({
    id: "red-force", runId: RUN.id, parentId: "primary-force", phase: "build", agentRole: "red-security", status: "failed", error: "boom",
    taskPackage: { taskId: "red-force", runId: RUN.id, phase: "build", role: "red-security", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });

  await assert.rejects(() => retry("red-force", { force: true }), RedReviewRetryError);
});

test("retry (FG-629): a failed shipping-reviewer red on a fanout step — NO `red-` prefix — is red_review, so retry is refused", async () => {
  // The classifier calls this red_review (the `build` step declares
  // `shipping-reviewer` as a red), so it goes through the SAME FG-629 refusal as a
  // `red-`-prefixed red — the name prefix never enters into it.
  insertTask({
    id: "primary-with-sr", runId: RUN.id, phase: "build", agentRole: "engineer", status: "complete",
    taskPackage: { taskId: "primary-with-sr", runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });
  insertTask({
    id: "sr-child", runId: RUN.id, parentId: "primary-with-sr", phase: "build", agentRole: "shipping-reviewer", status: "failed", error: "boom",
    taskPackage: { taskId: "sr-child", runId: RUN.id, phase: "build", role: "shipping-reviewer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z",
  });
  const before = tasksForRun(RUN.id).map((t) => t.id);

  await assert.rejects(() => retry("sr-child"), (e: unknown) => {
    assert.ok(e instanceof RedReviewRetryError, `expected RedReviewRetryError, got ${e}`);
    assert.equal((e as RedReviewRetryError).primaryId, "primary-with-sr");
    return true;
  });
  assert.deepEqual(tasksForRun(RUN.id).map((t) => t.id), before, "no row created — refused before any write");
});

test("retry (FG-629): an ad-hoc `forge invoke` red (dispatchSource=invoke) is NOT a red_review — its direct re-dispatch is untouched", async () => {
  // The refusal keys on classifier kind red_review, which an invoke-attached red
  // (adhoc_invoke, phase `task`, no parent) never is — so the FG-507 direct
  // re-dispatch of a `forge invoke red-wide` task still plans an ad-hoc dispatch.
  adHocFailedTask("adhoc-red-fg629");

  const out = await retry("adhoc-red-fg629");
  assert.ok(out.adHoc !== undefined, "an ad-hoc invoke red re-dispatches directly, not through a red_review refusal");
  assert.equal(out.newTask.status, "pending");
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

// FG-654 / D12: A RETRY RE-VERIFIES AND RE-STAMPS; IT NEVER REPLAYS THE ORIGINAL STAMP.
//
// `planAdHocRedispatch` recomposes the prompt fresh (it always has), which means it now
// also re-runs the protocol gate against the CURRENTLY PUBLISHED generation. A retry
// after a `forge upgrade` genuinely runs a different protocol, so replaying the original
// task's recorded sha would make the ledger lie in exactly the direction FG-654 exists to
// prevent. Refused BEFORE any row is written, like every other precondition there — so a
// retry that cannot dispatch never leaves a stranded pending task behind.

const STALE_SHA = "0".repeat(64);

function protocolPathIn(role: string): string {
  return join(resolveSeedGeneration(process.env["FORGE_HOME"]!)!.root, protocolRelPath(role));
}

function adHocFailedTask(id: string, stamp?: { role: string; sha256: string; source: string }): void {
  insertTask({
    id,
    runId: RUN.id,
    phase: "task",
    agentRole: "red-wide",
    status: "failed",
    error: "boom",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: "task",
      role: "red-wide",
      inputs: { task: "audit the change" },
      composedSystemPrompt: "PROMPT",
      dispatchSource: "invoke",
      ...(stamp ? { agentProtocol: stamp } : {}),
    },
    createdAt: "2026-05-30T00:00:00Z",
  });
  logEvent("task.failed", { runId: RUN.id, taskId: id, payload: { failure_kind: "idle_timeout", error: "boom" } });
  const dir = taskDir(RUN.id, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      taskId: id,
      runId: RUN.id,
      runtime: { name: "claude" },
      // The stamp the ORIGINAL dispatch recorded. The retry must not replay it.
      agentProtocol: { role: "red-wide", sha256: STALE_SHA, source: protocolPathIn("red-wide") },
      controlPlane: { projectDir: process.env["FORGE_HOME"], mountMode: "ro" },
    }),
  );
}

test("FG-654: retrying an ad-hoc covered-role task re-verifies the protocol and refuses when the generation is tampered", async () => {
  const path = protocolPathIn("red-wide");
  const pristine = readFileSync(path, "utf8");
  const id = "t-fg654-adhoc";
  adHocFailedTask(id);

  // The published generation's protocol goes out of sync with its own manifest — the
  // torn/tampered state dispatch must refuse rather than run against unknown bytes.
  writeFileSync(path, `${pristine}\n\nTAMPERED\n`);
  try {
    await assert.rejects(retry(id), /provenance manifest|forge upgrade/);
    assert.equal(getTask(id)!.status, "failed", "the original stays failed for audit");
  } finally {
    writeFileSync(path, pristine);
  }
});

// The POSITIVE half of the same claim. The stamp now RIDES the task package from the
// compose that produced the prompt (it is no longer re-derived at manifest-write time), so
// the retried row must carry the stamp THIS retry composed — not the one it inherits by
// spreading the failed attempt's package forward.
test("FG-654: a retried row carries THIS retry's stamp, never the failed attempt's inherited one", async () => {
  const path = protocolPathIn("red-wide");
  const id = "t-fg654-restamp";
  // A generation this host no longer runs — what a pre-upgrade dispatch left behind.
  adHocFailedTask(id, { role: "red-wide", sha256: STALE_SHA, source: path });

  const out = await retry(id);
  const stamp = out.newTask.taskPackage.agentProtocol;
  assert.equal(stamp?.role, "red-wide");
  assert.notEqual(stamp?.sha256, STALE_SHA, "the inherited stamp must not survive the retry");
  assert.equal(
    stamp?.sha256,
    createHash("sha256").update(readFileSync(path)).digest("hex"),
    "the currently published protocol is what gets recorded",
  );
  assert.equal(stamp?.source, path, "and the source names the generation, not an installed seed");
});
