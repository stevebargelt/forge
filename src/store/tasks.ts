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
  resolved_capability_source: string | null;
  resolved_mapping_path: string | null;
  worktree_path: string | null;
  base_sha: string | null;
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
    resolvedCapabilitySource: row.resolved_capability_source ?? undefined,
    resolvedMappingPath: row.resolved_mapping_path ?? undefined,
    status: row.status as TaskStatus,
    taskPackage: JSON.parse(row.task_package) as TaskPackage,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    baseSha: row.base_sha ?? undefined,
  };
}

export function insertTask(task: Task): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, agent_alias, agent_model, status, task_package, result, created_at, started_at, completed_at, error, resolved_profile, resolved_provider, resolved_auth, resolved_by, resolved_capability_source, resolved_mapping_path, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      task.resolvedCapabilitySource ?? null,
      task.resolvedMappingPath ?? null,
      task.worktreePath ?? null
    );
}

export function setTaskWorktreePath(id: string, worktreePath: string): void {
  getDb()
    .prepare(`UPDATE tasks SET worktree_path = ? WHERE id = ?`)
    .run(worktreePath, id);
}

// FG-621: record a private clone's workspace path AND the base commit it was
// created at, in ONE write. They are one fact — "this task's workspace is at
// this path, holding this base" — and AC 4 is asserted on the recorded value, so
// a row that carries the path without the base would be a workspace whose base
// is once again only inferrable. Branch identity stays derived (worktreeBranchName).
export function setTaskWorkspace(id: string, workspacePath: string, baseSha: string): void {
  getDb()
    .prepare(`UPDATE tasks SET worktree_path = ?, base_sha = ? WHERE id = ?`)
    .run(workspacePath, baseSha, id);
}

// FG-621: unrecord a workspace that does not exist. The counterpart of
// setTaskWorkspace, for the failed-setup lane: the path is written BEFORE the
// clone is created (so a workspace no row names is impossible), which leaves a
// row naming a workspace whose creation then failed. The reaper tolerates that
// — it reads the path as `absent` — but every other consumer reads a non-null
// worktree_path as "a workspace exists here". Both columns go, because they are
// the one fact setTaskWorkspace wrote.
export function clearTaskWorkspace(id: string): void {
  getDb()
    .prepare(`UPDATE tasks SET worktree_path = NULL, base_sha = NULL WHERE id = ?`)
    .run(id);
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

// FG-482: single-write CAS that moves a task straight to blocked_by_red with
// its result, never passing through awaiting_gate. Mirrors markTaskComplete's
// CAS shape above — guarded on status = 'awaiting_red' so a concurrent
// forge-cancel (or any other terminal/competing write) can't be resurrected
// into blocked_by_red out from under it (AWN-2-style race guard).
export function markTaskBlockedByRed(id: string, result: unknown): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = 'blocked_by_red', result = ?, completed_at = NULL
              WHERE id = ? AND status = 'awaiting_red'`)
    .run(JSON.stringify(result), id);
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

// FG-425 (AC5): the task's publication attempt advanced the target ref and then
// lost the publication window, so its disposition is not yet knowable — the ONE
// thing forge may not do here is claim a terminal outcome. CAS'd like the other
// non-terminal landings: a concurrent `forge cancel` (or any terminal write) wins,
// and this call reports that it did not land.
export function markTaskAwaitingRecovery(id: string, error: string, result: unknown): boolean {
  const info = getDb()
    .prepare(
      `UPDATE tasks SET status = 'awaiting_recovery', result = ?, error = ?, completed_at = NULL
       WHERE id = ? AND status NOT IN ('complete', 'failed')`
    )
    .run(JSON.stringify(result), error, id);
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

// FG-676: the CAS'd counterpart of markTaskFailed, for a BACKGROUND settlement
// that arrives after the fact and must never move a row that is already terminal.
// markTaskFailed above is the LANDING writer — a container's own failure, on a row
// this process holds — and it overwrites deliberately. A sweep settling a task it
// selected some milliseconds earlier is the opposite case: a `forge cancel` or a
// gate rejection can land in that window, and the bare UPDATE would replace the
// human's error, result and completed_at with a publication failure of its own.
//
// Returns true iff this call failed the row. Callers MUST branch on it: appending
// task.failed over a refused CAS makes the event stream disagree with the row.
export function markTaskFailedIfNotTerminal(id: string, error: string, result?: unknown): boolean {
  const info = getDb()
    .prepare(
      `UPDATE tasks SET status = 'failed', error = ?, result = ?, completed_at = ?
       WHERE id = ? AND status NOT IN ('complete', 'failed')`
    )
    .run(error, result ? JSON.stringify(result) : null, nowIso(), id);
  return info.changes === 1;
}

// FG-676: reinstate a terminal row the resurrection moved off terminal, CAS'd on
// the status the caller's shape check actually OBSERVED, and stamped with the
// TRUE terminal time (the task.failed event's), never the repair's. Distinct from
// markTaskFailed because a repair is not a failure landing: it may not invent a
// completed_at, and it may not overwrite a decision made between the shape check
// and this write — the row moving underneath it means a NEWER decision won, and
// silently losing that race is the exact defect the repair exists to remove.
// Returns true iff this call reinstated the row.
export function restoreTaskFailed(
  id: string,
  opts: { error: string; result: unknown; completedAt: string; expectedStatus: TaskStatus }
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE tasks SET status = 'failed', error = ?, result = ?, completed_at = ?
       WHERE id = ? AND status = ?`
    )
    .run(opts.error, opts.result ? JSON.stringify(opts.result) : null, opts.completedAt, id, opts.expectedStatus);
  return info.changes === 1;
}

// FG-676: compare-and-set, like every other status writer here. It was a bare
// UPDATE, and a bare UPDATE moves a TERMINAL row off terminal — which launders it
// past markTaskHeldForGate's `status NOT IN ('complete','failed')` guard and
// resurrects a human's decision to awaiting_gate with its error NULLed. Making
// the guard structural is what BD-3 asks for: the one deliberate terminal ->
// non-terminal move in the codebase is named below, and every other caller is
// refused rather than trusted.
//
// Returns true iff this call moved the row. Callers MUST branch on it: emitting a
// status event over a refused CAS makes the event stream disagree with the row.
export function setTaskStatus(id: string, status: TaskStatus): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = ? WHERE id = ? AND status NOT IN ('complete', 'failed')`)
    .run(status, id);
  return info.changes === 1;
}

// FG-425 (AC5) / FG-676: the ONE deliberate terminal -> non-terminal transition,
// named so it cannot be reached by accident. reconcilePublicationRecoveries clears
// a `failed` claim that a crash left standing over an attempt AD-5 recovery has
// since converged to `published`, so finalizePrimary's completion CAS (which
// refuses to overwrite a failed row on purpose) can land it. Narrowed to exactly
// that source status: only `failed` is reopenable, and only into awaiting_recovery.
// The caller must already have proven the terminal state was NOT a human's
// decision — this writer cannot tell the difference.
export function reopenFailedTaskForRecovery(id: string): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = 'awaiting_recovery' WHERE id = ? AND status = 'failed'`)
    .run(id);
  return info.changes === 1;
}

// FG-688: the SECOND named terminal -> non-terminal transition, and the only one
// that returns a row to `pending`. `forge recover <parent> --re-drive` reopens a
// terminally-failed ORDERED fanout parent in place — reusing the row rather than
// minting a fresh primary — so that runOrderedWave's per-group recomputation can
// adopt the children whose commits are already integrated instead of re-running
// them. Narrowed like reopenFailedTaskForRecovery above: exactly one source status
// (`failed`) and exactly one target (`pending`), named so it cannot be reached by
// accident, and NOT achieved by relaxing setTaskStatus's terminal guard — that
// guard being structural is the FG-676/BD-3 property, and a second named exit is
// the sanctioned shape.
//
// completed_at is NULLed because the row is no longer settled; `error` and `result`
// are deliberately LEFT STANDING. markTaskRunning already clears both when the row
// is actually re-dispatched, and clearing them here would erase the failure evidence
// for a re-drive whose enclosing transaction then rolls back.
//
// The caller must already have proven the terminal state was NOT a human's decision
// — this writer cannot tell the difference, which is why `cancelled` is outside the
// re-drive's accepted failure kinds.
//
// Returns true iff this call moved the row. Callers MUST branch on it: emitting a
// status event over a refused CAS makes the event stream disagree with the row.
export function reopenFailedFanoutParentForReDrive(id: string): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = 'pending', completed_at = NULL WHERE id = ? AND status = 'failed'`)
    .run(id);
  return info.changes === 1;
}

export function setTaskParentId(id: string, parentId: string): void {
  getDb().prepare(`UPDATE tasks SET parent_id = ? WHERE id = ?`).run(parentId, id);
}

// Write captured result and transition to awaiting_gate before the human gate.
// Distinct from markTaskComplete: gate completion still has to happen via the
// human's gate decision; this is just the data-capture step before the gate.
//
// Compare-and-set, and the ONLY writer of `awaiting_gate` (FG-523 added the CAS
// for the validation-contract hold; FG-676 deleted the unconditional variant
// that used to sit above it). A terminal row is never overwritten: a concurrent
// `forge cancel`, or a `gate reject`/`request-changes` that already failed this
// task, is a HUMAN's decision, and this write is a background one — resurrecting
// it to awaiting_gate NULLs the error and parks the task on a decision no agent
// will ever run for and no gate can resolve. That is the AWN-2 race
// markTaskComplete guards against, arriving on the gate side.
//
// Returns true iff this call held the task. Callers MUST branch on it: emitting
// task.awaiting_gate or an operator notification over a refused CAS would make
// the event stream disagree with the row it describes.
export function markTaskHeldForGate(id: string, result: unknown): boolean {
  const info = getDb()
    .prepare(
      `UPDATE tasks SET status = 'awaiting_gate', result = ?, completed_at = NULL, error = NULL
       WHERE id = ? AND status NOT IN ('complete', 'failed')`
    )
    .run(JSON.stringify(result), id);
  return info.changes === 1;
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
