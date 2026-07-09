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

import { execFileSync } from "node:child_process";
import type { Task } from "../types/index.js";
import { getTask, insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { newTaskId, nowIso } from "../util/ids.js";
import { failureKindForTask } from "./failure-kind.js";
import { retryPolicy, type RetryDisposition } from "./retry-policy.js";

// FG-492: the failed task's container may have been RETAINED (docker-exec.ts's
// FORGE_CONTAINER_RETENTION policy keeps a failed task's container around for
// `forge show` / `forge ops reap-containers` to inspect). retry() always mints
// a brand-new task id (see below), so the new task's own container name
// (forge-<newId>) never collides with the old one — but once an operator has
// decided to retry, the old container's diagnostic value is spent, and leaving
// it around is just clutter a background `forge ops reap-containers` sweep
// would otherwise have to find later. Best-effort, never blocks the retry: a
// daemon hiccup or an already-gone container is silently ignored.
// Exported (mirrors docker-exec.ts's captureContainerCausalEvidence /
// finalizeContainerRetention convention) so a test can inject a fake
// execFileSync and assert the exact reap attempted, without a real docker
// daemon.
export function reapRetainedContainer(
  taskId: string,
  execFileSyncFn: typeof execFileSync = execFileSync,
): void {
  try {
    // -v: also remove the anonymous shadow volume (DEC-019) — no --rm anymore.
    execFileSyncFn("docker", ["rm", "-f", "-v", `forge-${taskId}`], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // best-effort only — container already gone, or docker unreachable
  }
}

export class RetryNotAllowedError extends Error {
  constructor(public taskId: string, public disposition: RetryDisposition) {
    super(`Task ${taskId} is not retryable: ${disposition.reason}.${disposition.advice ? ` ${disposition.advice}.` : ""} Use --force to retry anyway.`);
    this.name = "RetryNotAllowedError";
  }
}

// FG-455 p3: retrying a fanout CHILD directly mints a new parentId-undefined
// primary in the child's phase — the same phase the real fanout parent (and
// its siblings) already occupy. That stray primary confuses dispatchFanoutStep's
// existingParent lookup (which phase's the only-pending primary is now
// ambiguous) and pollutes tasksForRun with a primary that was never a genuine
// wave parent. `forge recover <parent> --re-drive` is the coherent path for
// re-driving a fanout wave; refuse the child-retry shortcut unless the operator
// explicitly forces it (preserving pre-FG-455 behavior).
export class FanoutChildRetryError extends Error {
  constructor(public taskId: string, public parentId: string) {
    super(
      `Task ${taskId} is a fanout child (parent ${parentId}) — retrying it directly would strand a detached primary in the fanout's phase. ` +
        `Use \`forge recover ${parentId} --re-drive\` to re-drive the whole wave, or pass --force to retry this child anyway.`,
    );
    this.name = "FanoutChildRetryError";
  }
}

/** Is `task` a fanout child? True iff it has a parent, that parent shares its
 *  phase (fanout children run in the SAME phase as their synthetic parent —
 *  gate.ts's reject->on_reject children land in a DIFFERENT phase, the on_reject
 *  target, so phase equality alone rules those out), and it isn't itself a red
 *  reviewer (reds also share parentId+phase with an ordinary primary, but are
 *  always prefixed "red-" — see runNext.ts's own `!agentRole.startsWith("red-")`
 *  filters for the same discriminator). */
function fanoutParentOf(task: Task): Task | undefined {
  if (task.parentId === undefined) return undefined;
  if (task.agentRole.startsWith("red-")) return undefined;
  const parent = getTask(task.parentId);
  if (!parent || parent.phase !== task.phase) return undefined;
  return parent;
}

export async function retry(taskId: string, opts?: { force?: boolean }): Promise<{ task: Task; newTask: Task; disposition: RetryDisposition; failureKind?: string }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status !== "failed") {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not failed. Retry only resets failed tasks; for other states, gate or submit instead.`
    );
  }

  const fanoutParent = fanoutParentOf(task);
  if (fanoutParent && !opts?.force) {
    throw new FanoutChildRetryError(taskId, fanoutParent.id);
  }

  // AWN-3: consult the per-failure_kind retry policy. Non-retryable kinds (gate
  // rejection, red block) would just re-run identical work — refuse unless --force.
  const failureKind = failureKindForTask(taskId);
  const disposition = retryPolicy(failureKind, taskId);
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
  reapRetainedContainer(task.id);

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
