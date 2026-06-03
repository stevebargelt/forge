// Ops intelligence substrate (#250) — detectors + composition.
//
// Each detector is a pure function over a read-only DB handle returning
// Incident[]. The per-entity store accessors (tasksForRun, ...) are single-run
// scoped, so cross-run detection uses targeted parametrized SQL (the same choice
// dashboard/src/queries.ts made for cross-run aggregates) rather than N+1 loops.
//
// Read-only by construction: this module opens getDb({ readOnly: true }) and
// imports NO mutating store helper — detection never mutates. The repair half
// lives in ops/repair.ts (the `forge ops repair` command); detectors only name
// the recommended command, they don't run it. The boundary with reconcile.ts is
// deliberate — reconcile owns the conservative container-liveness judgment for
// running tasks; where a condition has a safe, shape-guarded repair, the detector
// points at `forge ops repair` (retry_orphan), and where none exists yet it emits
// `repair_unavailable` rather than recommend a repair that wouldn't work
// (inconsistent_run_state, whose true repair needs liveness confirmation).

import type { Database as DatabaseInstance } from "better-sqlite3";
import type { Incident } from "../types/index.js";
import { getDb } from "../store/db.js";
import { makeIncident } from "./incident.js";

export type OpsCheckOptions = {
  /** Scope to one project's runs (runs.project_dir). Omit for the host-wide view. */
  projectDir?: string;
};

// Terminal run states — a run here will never dispatch further work on its own.
const TERMINAL_RUN_STATES = ["complete", "abandoned"];

type OrphanRow = { taskId: string; runId: string; phase: string; runStatus: string };

/** A pending task under a terminal run (#232). `forge next` won't dispatch it
 *  (the run is terminal) and reconcile.ts skips it (it only acts on `running`
 *  tasks), so it sits pending forever. db-confirmed (pure status join); repaired
 *  by `forge ops repair` (autonomy "ask"). */
export function detectRetryOrphan(db: DatabaseInstance, opts: OpsCheckOptions = {}): Incident[] {
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.run_id AS runId, t.phase AS phase, r.status AS runStatus
       FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'pending'
         AND r.status IN (${TERMINAL_RUN_STATES.map(() => "?").join(",")})
         AND (? IS NULL OR r.project_dir = ?)`
    )
    .all(...TERMINAL_RUN_STATES, opts.projectDir ?? null, opts.projectDir ?? null) as OrphanRow[];

  return rows.map((row) =>
    makeIncident({
      kind: "retry_orphan",
      severity: "high",
      confidence: "db-confirmed",
      runId: row.runId,
      taskId: row.taskId,
      evidence: [`run ${row.runId} is ${row.runStatus}`, `child task ${row.taskId} (${row.phase}) is pending`],
      recommendedAction: {
        type: "repair",
        autonomy: "ask",
        command: `forge ops repair ${row.taskId}`,
        reason:
          "a pending task stranded under a terminal run will never dispatch; `forge ops repair` marks it failed (orphaned) to clear the inconsistent state. Re-invoke if the work is still wanted (#232). Autonomy is 'ask' — confirm before running.",
      },
    })
  );
}

type InconsistentRow = { taskId: string; runId: string; phase: string; runStatus: string };

/** A still-`running` task under a terminal run (#201). The run was finalized
 *  while a child task is recorded running, so `forge status` reads "nothing
 *  running" while a container may be churning. db-confirmed inconsistency, but
 *  the DB can't see container liveness, so no DB-safe repair → repair_unavailable. */
export function detectInconsistentRunState(db: DatabaseInstance, opts: OpsCheckOptions = {}): Incident[] {
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.run_id AS runId, t.phase AS phase, r.status AS runStatus
       FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'running'
         AND r.status IN (${TERMINAL_RUN_STATES.map(() => "?").join(",")})
         AND (? IS NULL OR r.project_dir = ?)`
    )
    .all(...TERMINAL_RUN_STATES, opts.projectDir ?? null, opts.projectDir ?? null) as InconsistentRow[];

  return rows.map((row) =>
    makeIncident({
      kind: "inconsistent_run_state",
      severity: "high",
      confidence: "db-confirmed",
      runId: row.runId,
      taskId: row.taskId,
      evidence: [`run ${row.runId} is ${row.runStatus}`, `child task ${row.taskId} (${row.phase}) is still running`],
      recommendedAction: {
        type: "repair_unavailable",
        autonomy: "manual-only",
        command: null,
        reason:
          "task is recorded running under a terminal run; container liveness is unknowable from the DB — confirm the container, then let reconcile finalize it or fail it. No DB-safe automated repair.",
      },
    })
  );
}

const DETECTORS: Array<(db: DatabaseInstance, opts: OpsCheckOptions) => Incident[]> = [
  detectRetryOrphan,
  detectInconsistentRunState,
];

/** Run every detector over a read-only handle and return the flat incident list.
 *  Opens getDb({ readOnly: true }) — never a mutating helper. */
export function runOpsCheck(opts: OpsCheckOptions = {}): Incident[] {
  const db = getDb({ readOnly: true });
  return DETECTORS.flatMap((detect) => detect(db, opts));
}
