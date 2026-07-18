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

// FG-492 finding 4: render the container-evidence portion of an OrphanEvidence
// tuple with the same code/signal/OOM detail `forge show`'s describeContainerEvidence
// gives, instead of a bare observed/not-observed boolean — so a reader of `forge
// ops check` can tell a CONFIRMED exit (code/signal/OOM known) apart from a
// container that disappeared with no terminal event at all, not just infer it.
// Deliberately self-contained (no import from cli/commands/show.ts) — ops/ sits
// below cli/ in the dependency direction; this mirrors describeContainerEvidence
// rather than sharing code across that boundary.
function containerEvidenceLine(evidence: OrphanEvidence): string | undefined {
  if (evidence.containerExitedEventObserved === undefined) return undefined; // pre-FG-492 event — nothing recorded
  if (evidence.containerExitedEventObserved) {
    const parts: string[] = [];
    if (evidence.exitCode !== undefined) parts.push(`exit code ${evidence.exitCode}`);
    if (evidence.signal) parts.push(`signal ${evidence.signal}`);
    if (evidence.oomKilled !== undefined) parts.push(`OOMKilled=${evidence.oomKilled}`);
    if (evidence.dockerStateError) parts.push(`docker error: ${evidence.dockerStateError}`);
    return parts.length > 0
      ? `container exit was directly observed by forge (attached-exit) — ${parts.join(", ")}`
      : "container exit was directly observed by forge (attached-exit) — no further docker evidence available";
  }
  return "container disappeared without a recorded terminal event — no container.exited event was ever observed for this task";
}

export type OpsCheckOptions = {
  /** Scope to one project's runs (runs.project_dir). Omit for the host-wide view. */
  projectDir?: string;
};

// Terminal run states — a run here will never dispatch further work on its own.
// FG-585 added `failed`: a run settled with a permanently-blocked/failed required
// phase is terminal too, so a pending task under it is just as stranded (orphan)
// and a `running` task under it just as inconsistent as under `complete`. The
// task-level guards below (`t.status = 'pending'` / `t.status = 'running'`) never
// match a failed run's OWN expected `failed` task, so adding `failed` here does
// not mistake that expected failure for an orphan or inconsistency.
const TERMINAL_RUN_STATES = ["complete", "failed", "abandoned"];

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

/** A `running` task with no live container (#290, extended by FG-533). The DB row
 *  is stale — either the container is GONE (the work finished, or it died) or it
 *  never launched at all — but no lifecycle command has run reconcileRun to
 *  finalize it, so it shows as live for hours. Unlike the two detectors above
 *  this needs an external probe (docker + result.json on disk + the run lock), so
 *  confidence is `external-required` and the only safe action is to ASK the
 *  orchestrator to run a lifecycle command — detection itself never reconciles.
 *
 *  Conservative by the shared classifier: `liveness_unknown` (docker down/
 *  ambiguous) and `anomalous_result_while_alive` (container still up) are NOT
 *  reconcile candidates and emit no incident here. The SQL guards mean only
 *  eligible running tasks are ever docker-probed, and a pre-container row
 *  (FG-533) is only ever reported under the same provenance/manual/child/liveness
 *  safeguards reconcile.ts sweeps it with. */
export function detectReconcileCandidate(
  db: DatabaseInstance,
  opts: OpsCheckOptions = {},
  probe: LivenessProbe = probeContainerLiveness
): Incident[] {
  return findReconcileCandidates(db, { projectDir: opts.projectDir }, probe)
    .filter((c) => c.classification === "reconcile_candidate")
    .map((c) => {
      const finished = c.reason === "container_gone_result_present";
      // FG-533: this row's container NEVER launched — saying "its container is
      // gone" would name the wrong cause and point an operator at a worktree
      // diff that cannot exist. The rescue is the same lifecycle command, but
      // reconcile lands it as a retryable pre_container_crash, so the follow-up
      // is a plain `forge retry` rather than an inspect-then-force.
      const preContainer = c.reason === "pre_container_crash";
      return makeIncident({
        kind: "reconcile_candidate",
        severity: "medium",
        confidence: "external-required",
        runId: c.runId,
        taskId: c.taskId,
        evidence: preContainer
          ? [
              `task ${c.taskId} is recorded running but its agent container forge-${c.taskId} never launched (no container.started event)`,
              `no live agent container and no live forge process holding run ${c.runId}'s lock — the forge process died in the pre-container window (image pull, auth staging, dependency provisioning), so no agent work exists to lose`,
            ]
          : [
              `task ${c.taskId} is recorded running but its container forge-${c.taskId} is gone`,
              finished ? "a valid result.json exists — the work finished but the DB write was lost" : "no valid result.json — the container died without usable output (orphan)",
            ],
        recommendedAction: {
          type: "repair",
          autonomy: "ask",
          command: preContainer ? `forge show --reconcile ${c.taskId}` : `forge show ${c.taskId} --json`,
          reason: preContainer
            ? `run a lifecycle command (forge show --reconcile / status / next) to let reconcile sweep this stranded task to failed (pre_container_crash), then re-dispatch it with \`forge retry ${c.taskId}\` — nothing else can advance it (the ready queue never re-admits a running phase, and forge retry refuses a non-failed task). Detection is read-only — confirm before reconciling.`
            : finished
              ? "run a lifecycle command (forge show/status/next) to let reconcile finalize this task — an invoke task with a valid result completes; a pipeline step lands fail-safe as orphaned_needs_finalize for re-dispatch (FG-479). Detection is read-only — confirm before reconciling."
              : "run a lifecycle command (forge show/status/next) to let reconcile finalize this orphaned task as failed. Detection is read-only — confirm before reconciling.",
        },
      });
    });
}

type FailedRow = { taskId: string; runId: string; phase: string; payload: string | null };

// FG-455 p4 review: oom_killed carries the same "container gone, worktree may
// hold real work" shape as orphaned_work_may_persist (mirrors ORPHAN_EVIDENCE_KINDS
// in failure-kind.ts and CONTINUABLE_KINDS in recover.ts) — excluding it here left
// an OOM-killed task with a dirty worktree invisible to `forge ops check`.
// FG-479 review finding 1: orphaned_needs_finalize carries the same OrphanEvidence
// shape (reconcile.ts's container-gone evidence path) — a pipeline step stuck
// fail-safe in this state never raised an incident here either.
// FG-492 finding 4: fanout_wave_orphaned (state 3 — a fanout parent's derived
// failure, never had its own container) and result_missing (state 4 — a clean
// container exit that produced no result) join the set so `forge ops check` can
// distinguish all four causal states the ticket requires, not just the two
// (orphaned_work_may_persist-family / orphaned_needs_finalize) it already covered.
const WORK_MAY_PERSIST_KINDS = new Set([
  "orphaned_work_may_persist",
  "oom_killed",
  "container_crash",
  "idle_timeout",
  "orphaned_needs_finalize",
  "fanout_wave_orphaned",
  "result_missing",
]);
// FG-461: the attached-exit kinds only carry recovery evidence when it was
// actually recorded (invoke.ts / runNext.ts). A pre-FG-461 crash — or any
// read-only-dispatch crash — has no evidence payload, and container_crash /
// idle_timeout are common outcomes, so raising an incident for one with no
// recorded persisted-work evidence would be retroactive noise. Require evidence
// (with changed files) for these kinds; the reconcile-time kinds keep their
// prior behavior (they always carry evidence, or legacy events with none still
// surface as "evidence not recorded").
// FG-492 finding 4: result_missing joins this set too — invoke.ts's current
// result_missing path (see invoke.ts's `no_result_json` branch) never attaches
// an OrphanEvidence tuple, so this keeps today's behavior noise-free (no
// incident fires) while making the renderer below ready the moment a producer
// does attach evidence. fanout_wave_orphaned is NOT in this set — its evidence
// lives under a different payload key (childSummary, not evidence) and it must
// always raise an incident when it occurs (an unfinalized wave, unlike a plain
// clean-exit-no-result task, is never "just retry it").
const ATTACHED_EXIT_EVIDENCE_KINDS = new Set(["container_crash", "idle_timeout", "result_missing"]);

/** A FAILED task classified `orphaned_work_may_persist` or `oom_killed` (FG-455):
 *  reconcile found the container gone with no recoverable result, but changed
 *  files sat in the task's worktree — real work that might otherwise be silently
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
    const failureKind = payload?.["failure_kind"];
    if (typeof failureKind !== "string" || !WORK_MAY_PERSIST_KINDS.has(failureKind)) continue;
    const evidence = payload?.["evidence"] as OrphanEvidence | undefined;
    // FG-492 finding 4 (state 3): a fanout parent's derived failure carries its
    // evidence under a DIFFERENT payload key (childSummary, not evidence) — the
    // parent never had its own container, so there's no OrphanEvidence tuple to
    // read here at all.
    const isFanoutParent = failureKind === "fanout_wave_orphaned";
    const childSummary = isFanoutParent
      ? (payload?.["childSummary"] as { total?: number; complete?: number } | undefined)
      : undefined;
    // oom_killed is emitted regardless of worktree state (failure-kind.ts /
    // reconcile.ts), unlike orphaned_work_may_persist which only fires when the
    // worktree is dirty — so a clean-worktree oom_killed task has no persisted
    // work at risk and shouldn't raise this incident.
    // FG-479: orphaned_needs_finalize is exempt from the clean-worktree skip —
    // its at-risk artifact is the preserved unfinalized RESULT, not dirty files
    // (e.g. a crash after the worktree merge leaves changedFiles empty while the
    // integration gate and reds still never ran).
    // FG-492 finding 4 (state 4): result_missing is exempt too — "container
    // exited cleanly, wrote nothing" is meaningful on its own, independent of
    // whether the (usually empty) worktree diff happens to be clean.
    if (
      evidence &&
      evidence.changedFiles.length === 0 &&
      failureKind !== "orphaned_needs_finalize" &&
      failureKind !== "result_missing"
    ) continue;
    // FG-461: an attached-exit container_crash / idle_timeout / result_missing
    // only rises to an incident when it recorded evidence — skip the
    // evidence-less ones (pre-FG-461 events, read-only-dispatch crashes, or
    // today's result_missing producer, which doesn't attach evidence yet) so
    // common crashes don't retroactively flood ops check.
    if (ATTACHED_EXIT_EVIDENCE_KINDS.has(failureKind) && !evidence) continue;
    const dir = taskDir(row.runId, row.taskId);
    const firstLine =
      failureKind === "oom_killed"
        ? evidence?.oomKilled === true
          ? `task ${row.taskId} (${row.phase}) was killed (OOM) with no recoverable result`
          : `task ${row.taskId} (${row.phase}) was killed (exit 137 — possibly OOM or an external kill) with no recoverable result`
        : failureKind === "container_crash"
          ? `task ${row.taskId} (${row.phase}) crashed (exit ${evidence?.exitCode ?? "?"}) with no recoverable result`
          : failureKind === "idle_timeout"
            ? `task ${row.taskId} (${row.phase}) idle-timed-out (killed after no output) with no recoverable result`
            : failureKind === "orphaned_needs_finalize"
              ? `task ${row.taskId} (${row.phase}) finished with a usable result, but the pipeline's host-side finalize (merge → integration gate → reds) never ran`
              // FG-492 finding 4 (state 3): never call this a killed agent — dispatchFanoutStep
              // never gives a fanout parent its own container; its failure is derived
              // purely from its children's outcomes.
              : isFanoutParent
                ? `task ${row.taskId} (${row.phase}) is a fanout wave's parent, orphaned mid-wave` +
                  (childSummary ? ` — ${childSummary.complete ?? 0}/${childSummary.total ?? 0} children completed before it was reconciled to failed` : "") +
                  "; it never had its own agent container (its failure is derived from its children's outcomes, not a killed agent)"
                // FG-492 finding 4 (state 4): distinct from a crash or an orphan — the
                // container ran to a clean exit and simply never produced a result.
                : failureKind === "result_missing"
                  ? `task ${row.taskId} (${row.phase}) — container exited cleanly but no result.json was ever produced (result missing after a clean exit, not a killed agent)`
                  : `task ${row.taskId} (${row.phase}) failed with container gone and no recoverable result`;
    incidents.push(
      makeIncident({
        kind: failureKind === "oom_killed" ? "oom_killed" : failureKind === "orphaned_needs_finalize" ? "orphaned_needs_finalize" : "orphaned_work_may_persist",
        severity: "high",
        confidence: "db-confirmed",
        runId: row.runId,
        taskId: row.taskId,
        evidence: [
          firstLine,
          // FG-492 finding 4: a fanout parent has no worktree/changed-files concept
          // at all — say so plainly instead of the generic "not recorded" line,
          // which would wrongly imply a worktree was expected here.
          ...(isFanoutParent
            ? ["n/a — a fanout parent has no dedicated container or worktree of its own to inspect"]
            : [
                evidence
                  ? `${evidence.changedFiles.length} changed file(s) found at ${evidence.worktreePathChecked ?? "(no worktree path recorded)"}` +
                    (evidence.source === "project_dir_shared"
                      ? " — SHARED project directory (no dedicated worktree); may include unrelated uncommitted changes, evidence to inspect, not proof of task work"
                      : "")
                  : "changed-file evidence not recorded on this task.failed event",
              ]),
          `task dir: ${dir}`,
          // FG-492: state explicitly whether Forge itself ever observed this
          // container exit, and with what code/signal/OOM detail, rather than
          // letting the reader infer a cause from symptoms — the ticket's
          // central distinction. Omitted for evidence recorded before this
          // field existed, and n/a for a fanout parent (no container at all).
          ...(evidence ? (() => { const l = containerEvidenceLine(evidence); return l ? [l] : []; })() : []),
        ],
        recommendedAction: {
          type: "investigate",
          autonomy: "manual-only",
          command: `forge show ${row.taskId} --json`,
          reason: isFanoutParent
            ? `this is a fanout wave's parent — it never had its own container, so there's no worktree diff to inspect here. Re-drive the whole wave coherently with \`forge recover ${row.taskId} --re-drive\` (a blind \`forge retry\` would strand a duplicate, uncoordinated primary).`
            : failureKind === "result_missing"
              ? `the container exited cleanly but produced no result — usually transient; \`forge retry ${row.taskId}\` re-dispatches without needing --force. Investigate first if this recurs for the same task/role.`
              : `the worktree may hold real, unreviewed work — inspect the diff before deciding whether to salvage it or re-dispatch with \`forge retry ${row.taskId} --force\`.`,
        },
      })
    );
  }
  return incidents;
}

const TERMINAL_TASK_STATES = ["complete", "failed"];

type StuckRunRow = { runId: string; taskIds: string };

/** An active run whose tasks are ALL terminal (FG-414) — the inverse of
 *  retry_orphan: instead of a pending task stranded under a terminal run, this
 *  is a terminal-shaped run stranded under an active status. `forge next`'s
 *  self-healing "mark complete when nothing's left to dispatch" check
 *  (runNext.ts) only runs at the tail of an actual dispatch wave — if that
 *  wave never reaches the check (a crash between the last task's terminal
 *  write and the run-completion write) the run is left `active` forever with
 *  no pending task and no container to progress it. Re-invoking `forge next`
 *  doesn't self-heal it either: computeReadyQueue is empty, so it takes the
 *  early-return path before ever reaching that check again. db-confirmed
 *  (pure status join, mirrors detectRetryOrphan); repaired by `forge ops
 *  repair <runId>` (autonomy "ask", same as retry_orphan). */
export function detectStuckRun(db: DatabaseInstance, opts: OpsCheckOptions = {}): Incident[] {
  const rows = db
    .prepare(
      `SELECT r.id AS runId, GROUP_CONCAT(t.id) AS taskIds
       FROM runs r JOIN tasks t ON t.run_id = r.id
       WHERE r.status = 'active'
         AND (? IS NULL OR r.project_dir = ?)
       GROUP BY r.id
       HAVING SUM(CASE WHEN t.status IN (${TERMINAL_TASK_STATES.map(() => "?").join(",")}) THEN 0 ELSE 1 END) = 0`
    )
    .all(opts.projectDir ?? null, opts.projectDir ?? null, ...TERMINAL_TASK_STATES) as StuckRunRow[];

  return rows.map((row) => {
    const taskIds = row.taskIds.split(",");
    return makeIncident({
      kind: "stuck_run",
      severity: "high",
      confidence: "db-confirmed",
      runId: row.runId,
      taskId: null,
      evidence: [
        `run ${row.runId} is active but all ${taskIds.length} of its task(s) are terminal`,
        `no pending task and no container can advance it: ${taskIds.join(", ")}`,
      ],
      recommendedAction: {
        type: "repair",
        autonomy: "ask",
        command: `forge ops repair ${row.runId}`,
        reason:
          "an active run with only terminal tasks will never progress — forge next's self-healing completion check never got to run (likely an interrupted dispatch). `forge ops repair` marks it abandoned. `forge cancel " +
          row.runId +
          " --abandon-run` is the equivalent manual remediation. Autonomy is 'ask' — confirm before running.",
      },
    });
  });
}

type ReapFailedRow = { taskId: string; runId: string; phase: string; payload: string | null };

/** FG-503 finding 4 (review): a `container.reap_failed` event (invoke.ts/
 *  runNext.ts/gate.ts/reconcile.ts's four success-path reap sites) was only
 *  ever observable via `forge ops reap-containers`' own disk-truth scan, which
 *  rediscovers leaked containers independently of these events — the events
 *  themselves were logged for evidence but nothing ever read them back, so a
 *  reap failure recorded well before a container aged past --older-than-minutes
 *  (or one that got orphaned entirely off the default sweep's project scope)
 *  had no representation in `forge ops check` / the dashboard's incident list
 *  at all. db-confirmed (the event is a plain DB fact); the action is always
 *  `forge ops reap-containers`, the same idempotent best-effort sweep the
 *  reap sites themselves defer to — safe to re-run, so 'ask' rather than
 *  'manual-only', but not 'auto-safe' since a still-failing docker daemon
 *  makes re-running it a no-op worth a human noticing.
 *
 *  Reads only the LATEST container.reap_failed event per task (mirrors
 *  detectOrphanedWorkMayPersist's correlated-subquery approach) — a task can
 *  only be reaped once it's terminal, so there's no risk of shadowing a more
 *  recent successful reap (the happy path logs nothing, by design).
 *
 *  FG-504: a task's forge-<taskId> container name is 1:1 with its taskId, so
 *  "superseded by a later resolution event for the same containerName" (the
 *  ticket's design direction) is just "a later container.reaped event for the
 *  same task_id" — no JSON payload parsing needed in SQL. Once `forge ops
 *  reap-containers` confirms the container gone (rm succeeded, or not_found)
 *  it logs container.reaped, and that incident stops firing here. */
export function detectContainerReapFailed(db: DatabaseInstance, opts: OpsCheckOptions = {}): Incident[] {
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.run_id AS runId, t.phase AS phase, e.payload AS payload
       FROM tasks t
       JOIN runs r ON r.id = t.run_id
       JOIN events e ON e.id = (
         SELECT e2.id FROM events e2
         WHERE e2.task_id = t.id AND e2.event_type = 'container.reap_failed'
         ORDER BY e2.created_at DESC, e2.id DESC
         LIMIT 1
       )
       WHERE (? IS NULL OR r.project_dir = ?)
         AND NOT EXISTS (
           SELECT 1 FROM events e3
           WHERE e3.task_id = t.id AND e3.event_type = 'container.reaped'
             AND (e3.created_at > e.created_at OR (e3.created_at = e.created_at AND e3.id > e.id))
         )`
    )
    .all(opts.projectDir ?? null, opts.projectDir ?? null) as ReapFailedRow[];

  return rows.map((row) => {
    const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
    const containerName = typeof payload?.["containerName"] === "string" ? payload["containerName"] : `forge-${row.taskId}`;
    const why = typeof payload?.["why"] === "string" ? payload["why"] : "docker rm -f -v failed after task completion";
    return makeIncident({
      kind: "container_reap_failed",
      severity: "low",
      confidence: "db-confirmed",
      runId: row.runId,
      taskId: row.taskId,
      evidence: [
        `task ${row.taskId} (${row.phase}) recorded a container.reap_failed event for ${containerName}`,
        why,
      ],
      recommendedAction: {
        type: "repair",
        autonomy: "ask",
        command: "forge ops reap-containers",
        reason:
          "the automatic reap attempt at task completion failed (docker error); `forge ops reap-containers` is the same best-effort sweep and safe to retry. Autonomy is 'ask' — confirm before running.",
      },
    });
  });
}

const DETECTORS: Array<(db: DatabaseInstance, opts: OpsCheckOptions) => Incident[]> = [
  detectRetryOrphan,
  detectInconsistentRunState,
  detectReconcileCandidate,
  detectOrphanedWorkMayPersist,
  detectStuckRun,
  detectContainerReapFailed,
];

/** Run every detector over a read-only handle and return the flat incident list.
 *  Opens getDb({ readOnly: true }) — never a mutating helper. */
export function runOpsCheck(opts: OpsCheckOptions = {}): Incident[] {
  const db = getDb({ readOnly: true });
  return DETECTORS.flatMap((detect) => detect(db, opts));
}
