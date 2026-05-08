import { getDb } from "./db.js";
import type { Task, TaskStatus, TaskPackage } from "../types/index.js";
import { nowIso } from "../util/ids.js";

type TaskRow = {
  id: string;
  run_id: string;
  parent_id: string | null;
  phase: string;
  agent_role: string;
  agent_alias: string | null;
  agent_model: string | null;
  status: string;
  task_package: string;
  result: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
};

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id ?? undefined,
    phase: row.phase,
    agentRole: row.agent_role,
    agentAlias: row.agent_alias ?? undefined,
    agentModel: row.agent_model ?? undefined,
    status: row.status as TaskStatus,
    taskPackage: JSON.parse(row.task_package) as TaskPackage,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
}

export function insertTask(task: Task): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, agent_alias, agent_model, status, task_package, result, created_at, started_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.id,
      task.runId,
      task.parentId ?? null,
      task.phase,
      task.agentRole,
      task.agentAlias ?? null,
      task.agentModel ?? null,
      task.status,
      JSON.stringify(task.taskPackage),
      task.result ? JSON.stringify(task.result) : null,
      task.createdAt,
      task.startedAt ?? null,
      task.completedAt ?? null,
      task.error ?? null
    );
}

export function getTask(id: string): Task | undefined {
  const row = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function tasksForRun(runId: string): Task[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC`)
    .all(runId) as TaskRow[];
  return rows.map(rowToTask);
}

export function tasksForRunPhase(runId: string, phase: string): Task[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE run_id = ? AND phase = ? ORDER BY created_at ASC`)
    .all(runId, phase) as TaskRow[];
  return rows.map(rowToTask);
}

export function pendingTasksForRun(runId: string): Task[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE run_id = ? AND status = 'pending' ORDER BY created_at ASC`)
    .all(runId) as TaskRow[];
  return rows.map(rowToTask);
}

export function markTaskRunning(id: string): void {
  // Clear `error` and stale `result` from any prior failed attempt — this row is being
  // re-dispatched, so prior failure data would be misleading once the new attempt completes.
  getDb()
    .prepare(`UPDATE tasks SET status = 'running', started_at = ?, error = NULL, result = NULL WHERE id = ?`)
    .run(nowIso(), id);
}

export function markTaskComplete(id: string, result: unknown): void {
  getDb()
    .prepare(`UPDATE tasks SET status = 'complete', result = ?, completed_at = ?, error = NULL WHERE id = ?`)
    .run(JSON.stringify(result), nowIso(), id);
}

export function markTaskFailed(id: string, error: string, result?: unknown): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'failed', error = ?, result = ?, completed_at = ? WHERE id = ?`
    )
    .run(error, result ? JSON.stringify(result) : null, nowIso(), id);
}

export function setTaskStatus(id: string, status: TaskStatus): void {
  getDb().prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id);
}

// Used by `forge submit` to transition a manual-phase task (FORGE-DEC-016) from
// awaiting_human_input → awaiting_gate while writing the captured artifact paths
// into result. Distinct from markTaskComplete: gate completion still has to happen
// via the human's gate decision; this is just the data-capture step before the gate.
export function markTaskAwaitingGate(id: string, result: unknown): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'awaiting_gate', result = ?, completed_at = NULL, error = NULL WHERE id = ?`
    )
    .run(JSON.stringify(result), id);
}
