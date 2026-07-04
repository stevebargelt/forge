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
import { findReconcileCandidates, type LivenessProbe, probeContainerLiveness } from "./reconcile-candidate.js";
import type { OrphanEvidence } from "../v2/failure-kind.js";
import { taskDir } from "../util/paths.js";

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

/** A `running` task whose container is GONE (#290). The DB row is stale — the
 *  work finished (or the container died) but no lifecycle command has run
 *  reconcileRun to finalize it, so it shows as live for hours. Unlike the two
 *  detectors above this needs an external probe (docker + result.json on disk),
 *  so confidence is `external-required` and the only safe action is to ASK the
 *  orchestrator to run a lifecycle command — detection itself never reconciles.
 *
 *  Conservative by the shared classifier: `liveness_unknown` (docker down/
 *  ambiguous) and `anomalous_result_while_alive` (container still up) are NOT
 *  reconcile candidates and emit no incident here. The SQL guard means only
 *  running+containerized tasks are ever docker-probed. */
export function detectReconcileCandidate(
  db: DatabaseInstance,
  opts: OpsCheckOptions = {},
  probe: LivenessProbe = probeContainerLiveness
): Incident[] {
  return findReconcileCandidates(db, { projectDir: opts.projectDir }, probe)
    .filter((c) => c.classification === "reconcile_candidate")
    .map((c) => {
      const finished = c.reason === "container_gone_result_present";
      return makeIncident({
        kind: "reconcile_candidate",
        severity: "medium",
        confidence: "external-required",
        runId: c.runId,
        taskId: c.taskId,
        evidence: [
          `task ${c.taskId} is recorded running but its container forge-${c.taskId} is gone`,
          finished ? "a valid result.json exists — the work finished but the DB write was lost" : "no valid result.json — the container died without usable output (orphan)",
        ],
        recommendedAction: {
          type: "repair",
          autonomy: "ask",
          command: `forge show ${c.taskId} --json`,
          reason: finished
            ? "run a lifecycle command (forge show/status/next) to let reconcile finalize this task as complete. Detection is read-only — confirm before reconciling."
            : "run a lifecycle command (forge show/status/next) to let reconcile finalize this orphaned task as failed. Detection is read-only — confirm before reconciling.",
        },
      });
    });
}

type FailedRow = { taskId: string; runId: string; phase: string; payload: string | null };

/** A FAILED task classified `orphaned_work_may_persist` (FG-455): reconcile
 *  found the container gone with no recoverable result, but changed files sat
 *  in the task's worktree — real work that might otherwise be silently
 *  discarded. db-confirmed: the classification + evidence already live on the
 *  task's own task.failed event, no external probe needed. Never a `repair` —
 *  a human must inspect the diff first; retry-policy.ts already blocks a blind
 *  `forge retry` on this kind (needs --force).
 *
 *  Reads only the LATEST task.failed event's payload per failed task (a
 *  correlated subquery, one round trip) instead of pulling each task's full
 *  event history via eventsForTask — every ops-check pass otherwise re-fetched
 *  and re-walked the whole event stream (created/started/progress/artifact/...)
 *  of every failed task just to re-derive a classification/evidence that
 *  already sits on that one event. A task with status='failed' always has a
 *  matching task.failed event (markTaskFailed is never called without one —
 *  see reconcile.ts/failure-kind.ts/runNext.ts/ops/repair.ts), and since the
 *  row is currently 'failed' there's no later task.completed to supersede it,
 *  so the latest task.failed IS the current classification — same result as
 *  the old failureKindFromEvents/getOrphanEvidenceFromEvents newest-first walk. */
export function detectOrphanedWorkMayPersist(db: DatabaseInstance, opts: OpsCheckOptions = {}): Incident[] {
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.run_id AS runId, t.phase AS phase, e.payload AS payload
       FROM tasks t
       JOIN runs r ON r.id = t.run_id
       JOIN events e ON e.id = (
         SELECT e2.id FROM events e2
         WHERE e2.task_id = t.id AND e2.event_type = 'task.failed'
         ORDER BY e2.created_at DESC, e2.id DESC
         LIMIT 1
       )
       WHERE t.status = 'failed'
         AND (? IS NULL OR r.project_dir = ?)`
    )
    .all(opts.projectDir ?? null, opts.projectDir ?? null) as FailedRow[];

  const incidents: Incident[] = [];
  for (const row of rows) {
    const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
    if (payload?.["failure_kind"] !== "orphaned_work_may_persist") continue;
    const evidence = payload["evidence"] as OrphanEvidence | undefined;
    const dir = taskDir(row.runId, row.taskId);
    incidents.push(
      makeIncident({
        kind: "orphaned_work_may_persist",
        severity: "high",
        confidence: "db-confirmed",
        runId: row.runId,
        taskId: row.taskId,
        evidence: [
          `task ${row.taskId} (${row.phase}) failed with container gone and no recoverable result`,
          evidence
            ? `${evidence.changedFiles.length} changed file(s) found at ${evidence.worktreePathChecked ?? "(no worktree path recorded)"}` +
              (evidence.source === "project_dir_shared"
                ? " — SHARED project directory (no dedicated worktree); may include unrelated uncommitted changes, evidence to inspect, not proof of task work"
                : "")
            : "changed-file evidence not recorded on this task.failed event",
          `task dir: ${dir}`,
        ],
        recommendedAction: {
          type: "investigate",
          autonomy: "manual-only",
          command: `forge show ${row.taskId} --json`,
          reason:
            "the worktree may hold real, unreviewed work — inspect the diff before deciding whether to salvage it or re-dispatch with `forge retry --force`.",
        },
      })
    );
  }
  return incidents;
}

const DETECTORS: Array<(db: DatabaseInstance, opts: OpsCheckOptions) => Incident[]> = [
  detectRetryOrphan,
  detectInconsistentRunState,
  detectReconcileCandidate,
  detectOrphanedWorkMayPersist,
];

/** Run every detector over a read-only handle and return the flat incident list.
 *  Opens getDb({ readOnly: true }) — never a mutating helper. */
export function runOpsCheck(opts: OpsCheckOptions = {}): Incident[] {
  const db = getDb({ readOnly: true });
  return DETECTORS.flatMap((detect) => detect(db, opts));
}
