// forge retry — preserve the failed task as an audit record; create a new
// task row that inherits the same phase/role/inputs and points back to the
// failed task via parentId. The new task is `pending`; next forge-next
// redispatches it.
//
// This mirrors gate.ts's `request-changes` shape (task → failed, new task
// created with parentId pointing back). Audit trail is preserved on the
// original row; retries form a walkable chain via parentId.
//
// Scoped to failed tasks only. Rerun-on-complete is a different feature
// (different semantics; what does "different" mean from same inputs?) and
// not in scope.

import type { Task } from "../types/index.js";
import { getTask, insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { newTaskId, nowIso } from "../util/ids.js";
import { failureKindForTask } from "./failure-kind.js";
import { retryPolicy, type RetryDisposition } from "./retry-policy.js";

export class RetryNotAllowedError extends Error {
  constructor(public taskId: string, public disposition: RetryDisposition) {
    super(`Task ${taskId} is not retryable: ${disposition.reason}.${disposition.advice ? ` ${disposition.advice}.` : ""} Use --force to retry anyway.`);
    this.name = "RetryNotAllowedError";
  }
}

export async function retry(taskId: string, opts?: { force?: boolean }): Promise<{ task: Task; newTask: Task; disposition: RetryDisposition; failureKind?: string }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status !== "failed") {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not failed. Retry only resets failed tasks; for other states, gate or submit instead.`
    );
  }

  // AWN-3: consult the per-failure_kind retry policy. Non-retryable kinds (gate
  // rejection, red block) would just re-run identical work — refuse unless --force.
  const failureKind = failureKindForTask(taskId);
  const disposition = retryPolicy(failureKind);
  if (!disposition.retryable && !opts?.force) {
    throw new RetryNotAllowedError(taskId, disposition);
  }

  // Build a fresh task row — same phase/role/inputs/agentAlias/agentModel, NEW id
  // (so it gets a fresh task dir: no reuse of the failed attempt's result.json or
  // staged auth-state). parentId points back to the failed one for lineage.
  // composedSystemPrompt is cleared (re-composed at dispatch). status pending.
  const newId = newTaskId(task.phase);
  const newTask: Task = {
    id: newId,
    runId: task.runId,
    // PRIMARY task (parentId undefined) — runNext.dispatchStep only reuses pending
    // PRIMARY rows, so a parentId-child would be ignored and a fresh task created
    // instead, dropping this retry's context. Lineage is preserved via
    // inputs.previous_failure.failedTaskId + the task.retried event, not parentId.
    phase: task.phase,
    agentRole: task.agentRole,
    agentAlias: task.agentAlias,
    agentModel: task.agentModel,
    status: "pending",
    taskPackage: {
      ...task.taskPackage,
      taskId: newId,
      // AWN-3: hand the agent the previous failure as context so the retry is
      // informed. Prose + tag only — never secrets (task.error is a summary,
      // failure_kind is a classifier label).
      inputs: {
        ...task.taskPackage.inputs,
        previous_failure: { kind: failureKind ?? "unknown", error: task.error ?? null, failedTaskId: task.id },
      },
      composedSystemPrompt: "", // re-compose at dispatch
    },
    createdAt: nowIso(),
  };
  insertTask(newTask);

  logEvent("task.retried", {
    runId: task.runId,
    taskId: task.id,
    payload: {
      newTaskId: newId,
      failure_kind: failureKind ?? null,
      previousError: task.error ?? null,
      forced: !!opts?.force && !disposition.retryable,
    },
  });

  return { task, newTask, disposition, ...(failureKind ? { failureKind } : {}) };
}
