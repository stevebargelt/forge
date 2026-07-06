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
  resolved_profile: string | null;
  resolved_provider: string | null;
  resolved_auth: string | null;
  resolved_by: string | null;
  worktree_path: string | null;
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
    resolvedProfile: row.resolved_profile ?? undefined,
    resolvedProvider: row.resolved_provider ?? undefined,
    resolvedAuth: row.resolved_auth ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    status: row.status as TaskStatus,
    taskPackage: JSON.parse(row.task_package) as TaskPackage,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
  };
}

export function insertTask(task: Task): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, agent_alias, agent_model, status, task_package, result, created_at, started_at, completed_at, error, resolved_profile, resolved_provider, resolved_auth, resolved_by, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      task.error ?? null,
      task.resolvedProfile ?? null,
      task.resolvedProvider ?? null,
      task.resolvedAuth ?? null,
      task.resolvedBy ?? null,
      task.worktreePath ?? null
    );
}

export function setTaskWorktreePath(id: string, worktreePath: string): void {
  getDb()
    .prepare(`UPDATE tasks SET worktree_path = ? WHERE id = ?`)
    .run(worktreePath, id);
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

// Compare-and-set: complete a task ONLY if it isn't already terminal. Returns
// true iff this call completed it. A task that a concurrent `forge cancel`
// already marked failed (failure_kind=cancelled) — or that's already complete —
// must NOT be overwritten when its container then returns successfully (AWN-2
// task-level race). awaiting_gate/awaiting_red/running → complete is allowed
// (gate advance, reconcile, normal finish); failed/complete → blocked.
export function markTaskComplete(id: string, result: unknown): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = 'complete', result = ?, completed_at = ?, error = NULL
              WHERE id = ? AND status NOT IN ('complete', 'failed')`)
    .run(JSON.stringify(result), nowIso(), id);
  return info.changes === 1;
}

// FG-455 p3: `forge recover --continue` explicitly completes a task the
// operator has confirmed is safe to adopt — a DIFFERENT transition than
// markTaskComplete's compare-and-set above, which deliberately BLOCKS
// failed -> complete (that guard exists to stop a completing container racing
// a `forge cancel`, not to block an operator's explicit recovery decision).
// This CAS only ever fires from 'failed', so it can never clobber a task that
// legitimately completed (or was already recovered) through another path.
export function markTaskRecovered(id: string, result: unknown): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = 'complete', result = ?, completed_at = ?, error = NULL
              WHERE id = ? AND status = 'failed'`)
    .run(JSON.stringify(result), nowIso(), id);
  return info.changes === 1;
}

// FG-455 p4 Mode A: a detached `forge invoke` whose wrapper died can leave a
// task `complete` in the DB with no result ever written. reconcile discovers
// this out-of-band and needs to persist a recovered result WITHOUT touching
// status — markTaskComplete's CAS blocks complete->complete (WHERE status NOT
// IN ('complete','failed')), so it can't be reused here. Guards on the result
// column still being empty so a concurrent write in between isn't clobbered.
export function backfillTaskResult(id: string, result: unknown): boolean {
  const info = getDb()
    .prepare(
      `UPDATE tasks SET result = ? WHERE id = ? AND status = 'complete' AND (result IS NULL OR result = '')`
    )
    .run(JSON.stringify(result), id);
  return info.changes === 1;
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

export function setTaskParentId(id: string, parentId: string): void {
  getDb().prepare(`UPDATE tasks SET parent_id = ? WHERE id = ?`).run(parentId, id);
}

// Write captured result and transition to awaiting_gate before the human gate.
// Distinct from markTaskComplete: gate completion still has to happen via the
// human's gate decision; this is just the data-capture step before the gate.
export function markTaskAwaitingGate(id: string, result: unknown): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'awaiting_gate', result = ?, completed_at = NULL, error = NULL WHERE id = ?`
    )
    .run(JSON.stringify(result), id);
}

export function updateTaskPackageInputs(id: string, inputs: Record<string, unknown>): void {
  const task = getTask(id);
  if (!task) return;
  const updated: TaskPackage = {
    ...task.taskPackage,
    inputs: { ...task.taskPackage.inputs, ...inputs },
  };
  getDb()
    .prepare(`UPDATE tasks SET task_package = ? WHERE id = ?`)
    .run(JSON.stringify(updated), id);
}
