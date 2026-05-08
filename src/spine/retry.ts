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

export async function retry(taskId: string): Promise<{ task: Task; newTask: Task }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status !== "failed") {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not failed. Retry only resets failed tasks; for other states, gate or submit instead.`
    );
  }

  // Build a fresh task row — same phase/role/inputs/agentAlias/agentModel,
  // new id, parentId pointing back to the failed one. composedSystemPrompt is
  // cleared (will be re-composed at dispatch). status starts pending.
  const newId = newTaskId(task.phase);
  const newTask: Task = {
    id: newId,
    runId: task.runId,
    parentId: task.id,
    phase: task.phase,
    agentRole: task.agentRole,
    agentAlias: task.agentAlias,
    agentModel: task.agentModel,
    status: "pending",
    taskPackage: {
      ...task.taskPackage,
      taskId: newId,
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
      previousError: task.error ?? null,
    },
  });

  return { task, newTask };
}
