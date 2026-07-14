import { getDb, writeTransaction } from "./db.js";
import type { Run, RunStatus } from "../types/index.js";
import { nowIso } from "../util/ids.js";
import { notifyOnRunTransition } from "../notify/trigger.js";

type RunRow = {
  id: string;
  workflow: string;
  title: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  metadata: string | null;
  project_dir: string | null;
};

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    workflow: row.workflow,
    title: row.title,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    projectDir: row.project_dir ?? undefined,
  };
}

export function insertRun(run: Run): void {
  getDb()
    .prepare(
      `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, metadata, project_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.id,
      run.workflow,
      run.title,
      run.status,
      run.createdAt,
      run.completedAt ?? null,
      run.metadata ? JSON.stringify(run.metadata) : null,
      run.projectDir ?? null
    );
}

// Set the project_dir on a run. Used by `forge next --project ...` to remember
// the path so subsequent calls can omit it. Returns the previous value (if any)
// so the caller can decide whether to warn the user about a change.
export function setRunProjectDir(id: string, projectDir: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT project_dir FROM runs WHERE id = ?`)
    .get(id) as { project_dir: string | null } | undefined;
  const prev = row?.project_dir ?? undefined;
  getDb().prepare(`UPDATE runs SET project_dir = ? WHERE id = ?`).run(projectDir, id);
  return prev;
}

export function getRun(id: string): Run | undefined {
  const row = getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

export function listRuns(): Run[] {
  const rows = getDb().prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as RunRow[];
  return rows.map(rowToRun);
}

/** Runs whose projectDir OR metadata.workspace matches the given directory.
 *  Used by `forge status` to filter out runs from other workspaces by default
 *  (per #138). The metadata.workspace clause handles audit-workspace runs
 *  where the orchestrator's workspace ≠ the target repo's projectDir. */
export function listRunsForWorkspace(workspace: string): Run[] {
  // Filter in-process rather than in SQL — metadata is JSON-encoded TEXT, and
  // adding a SQL JSON predicate makes the query non-portable for what is at
  // most O(hundreds) of runs in practice.
  return listRuns().filter((r) => {
    if (r.projectDir === workspace) return true;
    const ws = r.metadata?.["workspace"];
    if (typeof ws === "string" && ws === workspace) return true;
    return false;
  });
}

// Per-project aggregate for the registry view (#152). Returns one row per
// distinct project_dir with lifetime + current-state counts.
export type ProjectAggregate = {
  projectDir: string;
  lastRunAt: string;     // ISO of most recent run's created_at
  runCount: number;
  inFlightCount: number; // active or awaiting_gate runs
};

// FG-414: "in-flight" for this aggregate must agree with the dashboard's
// in-flight view — a run with >= 1 non-terminal task, excluding orchestrator
// session rows (`forge claude`'s long-lived session run/task, workflow ===
// "orchestrator"; tracked separately via liveSessions/#153 heartbeats). Plain
// `status = 'active'` over-counted: it included orchestrator rows that never
// terminate on a crashed session, and stuck_run/un-reconciled orphans whose
// tasks are all terminal despite the run row still saying active.
const NON_TERMINAL_TASK_STATES = ["running", "awaiting_gate", "awaiting_red", "blocked_by_red"];

export function uniqueProjectDirs(): ProjectAggregate[] {
  const rows = getDb().prepare(`
    SELECT
      r.project_dir AS projectDir,
      MAX(r.created_at) AS lastRunAt,
      COUNT(*) AS runCount,
      SUM(CASE WHEN r.status = 'active' AND r.workflow != 'orchestrator' AND EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.run_id = r.id
              AND t.status IN (${NON_TERMINAL_TASK_STATES.map(() => "?").join(",")})
          ) THEN 1 ELSE 0 END) AS inFlightCount
    FROM runs r
    WHERE r.project_dir IS NOT NULL AND r.project_dir != ''
    GROUP BY r.project_dir
    ORDER BY lastRunAt DESC
  `).all(...NON_TERMINAL_TASK_STATES) as Array<{ projectDir: string; lastRunAt: string; runCount: number; inFlightCount: number }>;
  return rows;
}

// FG-484: compare-and-set that completes a run ONLY out of 'active' — the
// only other live state RunStatus has is 'abandoned', so this equally
// refuses abandoned->complete (a concurrent `forge cancel` won the race) and
// complete->complete (redundant re-finalization double-notifying / clobbering
// completed_at). Returns true iff this call completed it. Mirrors
// store/tasks.ts's markTaskComplete CAS shape.
//
// The status read + guarded UPDATE run inside ONE transaction so no
// concurrent writer can interleave between "read previous status" and
// "write" — better-sqlite3 transactions serialize against the same
// connection. The notification fires strictly AFTER that transaction
// commits, and only when the write actually applied, so a refused call never
// emits a false "complete" push and no interleaving can double-notify.
//
// opts.onApplied runs INSIDE the same transaction as the status write, before
// commit — callers (finalizeRunIfSettled) use it to make their own paired
// run.completed/run.reconciled events atomic with the status write (FG-463).
export function completeRun(id: string, opts?: { onApplied?: () => void }): boolean {
  const completedAt = nowIso();
  const { applied, prevStatus } = writeTransaction(() => {
    const prev = getDb()
      .prepare(`SELECT status FROM runs WHERE id = ?`)
      .get(id) as { status: string } | undefined;
    const info = getDb()
      .prepare(`UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'active'`)
      .run(completedAt, id);
    const applied = info.changes === 1;
    if (applied) opts?.onApplied?.();
    return { applied, prevStatus: prev?.status };
  });

  if (!applied) return false;

  const updated = getRun(id);
  if (updated) {
    void notifyOnRunTransition(updated, "complete", prevStatus);
  }
  return true;
}

export function updateRunStatus(id: string, status: RunStatus): void {
  // Read the previous status and (for a "complete" write) apply the FG-484
  // universal backstop in the SAME transaction as the write, so no concurrent
  // writer can interleave between the read and the UPDATE. This is the store
  // layer's own guard — it holds regardless of which caller reaches it,
  // unlike relying on every call site to route through completeRun.
  const { applied, prevStatus } = writeTransaction(() => {
    const prev = getDb()
      .prepare(`SELECT status FROM runs WHERE id = ?`)
      .get(id) as { status: string } | undefined;

    // FG-484: abandoned is authoritatively terminal. No caller — including
    // ones that bypass completeRun/finalizeRunIfSettled entirely — may
    // resurrect an abandoned run to "complete".
    if (prev?.status === "abandoned" && status === "complete") {
      return { applied: false, prevStatus: prev?.status };
    }

    const completedAt = status === "complete" || status === "abandoned" ? nowIso() : null;
    getDb()
      .prepare(`UPDATE runs SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, completedAt, id);
    return { applied: true, prevStatus: prev?.status };
  });

  if (!applied) return;

  // Notification: fires on terminal transitions only (complete/abandoned).
  // Reads the just-updated row so durationMs reflects the completed_at write.
  // Async fire-and-forget — never throws, never blocks the caller.
  if (status === "complete" || status === "abandoned") {
    const updated = getRun(id);
    if (updated) {
      void notifyOnRunTransition(updated, status, prevStatus);
    }
  }
}
