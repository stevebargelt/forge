// forge retry — reset a failed task back to pending so `forge next` redispatches.
//
// Scoped to failed tasks only. "Rerun" of a complete task is a different
// feature (different semantics; the user wants a different result and we'd
// need to reason about what "different" means) and not in scope here.
//
// Recovery path for transient failures (auth blips, crashed containers,
// network errors). The original error is preserved on the events table for
// audit; the task row gets a clean slate so the next dispatch starts fresh.

import type { Task } from "../types/index.js";
import { getTask } from "../store/tasks.js";
import { getDb } from "../store/db.js";
import { logEvent } from "../store/events.js";

export async function retry(taskId: string): Promise<{ task: Task }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status !== "failed") {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not failed. Retry only resets failed tasks; for other states, gate or submit instead.`
    );
  }

  // Clear the failure metadata. markTaskRunning would set started_at; we want
  // started_at NULL because the task hasn't been re-dispatched yet. Direct SQL
  // is cleanest — there's no spine helper for "reset to pending."
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL, result = NULL WHERE id = ?`
    )
    .run(taskId);

  logEvent("task.retried", {
    runId: task.runId,
    taskId,
    payload: { previousError: task.error ?? null },
  });

  return { task: getTask(taskId)! };
}
