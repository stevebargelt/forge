import type { Command } from "commander";
import { resolve } from "node:path";
import type { Incident } from "../../types/index.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { runOpsCheck } from "../../ops/detect.js";
import { performOpsRepair, type OpsRepairOutcome } from "../../ops/repair.js";
import type { LivenessProbe } from "../../ops/reconcile-candidate.js";
import { getTask } from "../../store/tasks.js";
import { acquireRunLock, releaseRunLock, RunBusyError } from "../../util/run-lock.js";
import { getDb, storeExists } from "../../store/db.js";
import { renderedEmptyStore } from "../no-store.js";
import { logEvent, eventsForTask } from "../../store/events.js";
import { defaultContainerReap, defaultContainerList, defaultContainerExitInfo, disposeRunGitWorkspaces, type ContainerReap, type ContainerLister } from "../../v2/reconcile.js";
import { getContainerCausalEvidenceFromEvents, type ContainerCausalEvidence, type ContainerExitInfo } from "../../v2/failure-kind.js";
import { classifyRetention, reapEligible, resolveRetention, type RetentionPolicy } from "../../v2/retention-policy.js";
import { readRetentionConfig } from "../../backlog/config.js";
import { sweepTerminalLaunches, type LaunchSweepResult, type TmuxRunner } from "../../v2/launch.js";
import { launchIdsOwnedByOtherProjects } from "../../store/launch-observations.js";
// FG-677: the terminal-run closeout sections + the unified report vocabulary.
import { getRun, listRuns } from "../../store/runs.js";
import { tasksForRun } from "../../store/tasks.js";
import { classifyRunTerminalState } from "../../v2/ready-queue.js";
import { sweepPublicationWorktrees } from "../../v2/integration-publisher.js";
import { pruneReadinessRecords } from "../../v2/host-readiness-store.js";
import { provenSameOnly } from "../../util/path-identity.js";
import type { ContainerAlive } from "../../v2/reconcile.js";
import type { CwdHolderResult } from "../../v2/launch.js";
import {
  emptyRunCleanupReport,
  formatRunCleanupReport,
  type RunCleanupReport,
} from "../../v2/run-cleanup-report.js";
import { emitMilestone } from "../../notify/milestone.js";
import { performAdjudicate, type AdjudicateResult } from "../../ops/adjudication.js";
import { userInfo } from "node:os";

// `forge ops check` — incident detection over the blackboard (#250). The
// orchestrator runs `--json`, which is read-only/side-effect-free, and decides
// what to act on or surface. The live (human) path renders the report AND, since
// FG-516, records + pushes one deduped milestone per new live incident
// (orchestrator.milestone events); only `--json` stays read-only.

// FG-516: in LIVE (human/interactive) mode, `forge ops check` pushes ONE
// milestone per detected incident so a standing incident (orphaned work, stuck
// run) surfaces without waiting for an operator to eyeball the report. Deduped on
// incident identity — kind + runId + taskId — and scoped to the incident's run so
// emitMilestone's persistent, run-scoped dedupe holds across `ops check`
// invocations: re-running over the same standing incidents never re-pushes. Only
// the human path calls this; `--json` stays read-only (side-effect-free) by
// design. A notify failure never breaks `ops check` — every error is swallowed.
// NO_NOTIFY is honored automatically: emitMilestone gates dispatch on
// isAnyProviderEnabled(), which NO_NOTIFY short-circuits.
export async function notifyLiveIncidents(incidents: Incident[]): Promise<void> {
  for (const inc of incidents) {
    // FG-703 (step 5): an adjudicated incident (only present under
    // `--include-adjudicated`) has been RETIRED from the active high-severity
    // report — it must not push a fresh risk_found milestone. In the default
    // path no incident carries `adjudication`, so this is a no-op there and the
    // shipped notify behavior is byte-for-byte unchanged.
    if (inc.adjudication) continue;
    try {
      await emitMilestone({
        runId: inc.runId,
        kind: "risk_found",
        title: `ops: ${inc.kind} (${inc.severity}) needs attention`,
        body: `${inc.evidence.join("; ")} — ${inc.recommendedAction.reason}`,
        dedupeKey: `ops-incident:${inc.kind}:${inc.runId}:${inc.taskId ?? "none"}`,
      });
    } catch (err) {
      console.error(`FG-516: ops incident notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function renderHuman(incidents: Incident[]): string {
  if (incidents.length === 0) return "No ops incidents.";
  const lines: string[] = [`${incidents.length} ops incident(s):`, ""];
  for (const i of incidents) {
    const where = i.taskId ? `${i.runId} / ${i.taskId}` : i.runId;
    lines.push(`  [${i.severity}] ${i.kind}  (${i.confidence})`);
    lines.push(`    where:  ${where}`);
    lines.push(`    why:    ${i.evidence.join("; ")}`);
    const a = i.recommendedAction;
    const action = a.command ? a.command : `(${a.type})`;
    lines.push(`    action: ${action}  [autonomy: ${a.autonomy}]`);
    lines.push(`            ${a.reason}`);
    // FG-703: surface the canonical adjudication identity on an adjudicable
    // (orphaned_work_may_persist) incident so an operator can copy it straight
    // into `forge ops adjudicate --identity`. Only that kind carries `identity`
    // (detect.ts). Suppressed here when the incident is already annotated as
    // adjudicated (include-adjudicated view) — the audit block below shows the
    // recorded identity, so a second, identical line would be noise.
    if (i.identity && !i.adjudication) {
      lines.push(`    identity: ${i.identity}  (adjudicate with: forge ops adjudicate ${i.taskId} --identity ${i.identity})`);
    }
    // FG-703 (step 5): an adjudicated incident surfaced under
    // `--include-adjudicated` renders its durable audit record BENEATH the
    // ORIGINAL detector evidence above (`why:`), so an operator sees WHAT they
    // decided alongside the facts that justified it. Only ever present in the
    // include-adjudicated read path — the default report never sets it.
    if (i.adjudication) {
      const adj = i.adjudication;
      lines.push(`    adjudicated: ${adj.outcome}  by ${adj.actor}  at ${adj.at}  (retired from the active high-severity report)`);
      lines.push(`            rationale: ${adj.rationale}`);
      lines.push(`            identity:  ${adj.identity}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** `id` may be a task id (retry_orphan) or a run id (stuck_run) — the lock must
 *  key on the RUN either way, since both repairs mutate state under it (mirrors
 *  cancel.ts's same task-or-run lock resolution). Factored out of the CLI
 *  action so the resolution + lock dispatch is directly testable. */
export function performOpsRepairCommand(
  id: string,
  opts: { dryRun?: boolean } = {},
  probe?: LivenessProbe
): OpsRepairOutcome {
  const runId = getTask(id)?.runId ?? id;
  if (!opts.dryRun) acquireRunLock(runId, "ops repair");
  try {
    return performOpsRepair(id, { dryRun: opts.dryRun }, probe);
  } finally {
    if (!opts.dryRun) releaseRunLock(runId);
  }
}

// FG-492: `forge ops reap-containers` — removes forge-<taskId> containers
// docker-exec.ts RETAINED under its FORGE_CONTAINER_RETENTION policy (a failed
// task's container is kept for `forge show`/diagnostic inspection instead of
// being auto-removed), once they're past the point that evidence is still
// useful. The removal itself is best-effort via the same defaultContainerReap
// reconcile.ts already uses (never throws; "error" means NOT confirmed gone,
// left alone for a later sweep). --dry-run reports without touching anything.
//
// FG-503 (redesign): candidacy is DISK-truth-driven, not event-enumeration-
// driven. The original scan only ever looked at task/event rows — a FAILED
// task needed a `container.started` event, a COMPLETED task additionally
// needed a `container.reap_failed` event. That left a real gap (AC2): a task
// that completed successfully whose forge process then died between
// markTaskComplete and the reap call never got a `container.reap_failed`
// event (a happy-path reap deliberately logs nothing on success) — its
// leaked container was permanently invisible to the sweep, since
// event-absence is ambiguous (did it reap cleanly, or never even attempt to?).
// Instead, `listContainers` (defaultContainerList, reconcile.ts) runs
// `docker ps -a` scoped to `forge-*` — the actual disk truth — and this scan
// reconciles that list against task rows: a STOPPED forge-<taskId> container
// whose task is TERMINAL (complete or failed) and past the age threshold is a
// candidate regardless of what events were or weren't recorded. A container
// still `running` is never touched; nor is one whose task is still
// non-terminal (running/pending/awaiting_*) even if the container itself
// looks stopped — that combination is left for a later reconcile pass, not
// this sweep. A container with no matching task row at all (unknown origin)
// is left alone too. `listContainers` returning undefined means docker itself
// couldn't be reached — reported via `dockerUnavailable`, never thrown.
export type ReapContainersOutcome = {
  dryRun: boolean;
  scanned: number;
  reaped: string[];
  retained: string[]; // still within --older-than-minutes, left alone
  errors: string[]; // docker reap attempt failed — NOT confirmed gone
  // FG-503: subset of reaped whose task was COMPLETE (a leak on an
  // otherwise-successful task) rather than the ordinary retained-on-failure
  // case — surfaced separately so it's operator-visible, not folded silently
  // into the normal reap count. Confirmed-gone only (killed, or dry-run's
  // speculative would-reap) — this is the "now swept" set.
  completedTaskLeaks: string[];
  // FG-504: the completed-task-leak counterpart whose rm attempt returned
  // "error" — NOT confirmed gone, distinct from completedTaskLeaks so the CLI
  // never claims "now swept" for a container that might still be there.
  completedTaskLeaksUnconfirmed: string[];
  // FG-503: `docker ps -a` itself couldn't be reached (daemon down, docker
  // missing) — the scan found nothing because it couldn't look, not because
  // there was nothing to find. Distinct from a docker error on an individual
  // `rm -f` (still captured in `errors`).
  dockerUnavailable: boolean;
  // FG-505: containers healed by ABSENCE this sweep — an unresolved
  // container.reap_failed event whose container no longer appears anywhere in
  // the docker ps -a listing (the crash-window "resolution write was lost, or
  // an operator ran `docker rm` by hand" case). Recorded with a
  // confirmed-absent-at-scan outcome, distinct from an actively-removed one.
  absenceHealed: string[];
  // FG-505: a container.reaped write (either the post-rm resolution or an
  // absence-heal one) threw. The underlying docker fact (reaped / absent) is
  // still true — only the DB write failed — so this never blocks the sweep;
  // the next sweep's absence-heal pass closes it.
  resolutionWriteErrors: string[];
  // FG-590: a FAILED/AMBIGUOUS container we DID NOT reap because its exit/signal/
  // OOM/timing evidence could not be persisted before the destructive rm — fail
  // closed. The container is deliberately LEFT so the failure evidence is never
  // destroyed unrecorded, and it is surfaced here so the cleanup failure is visible.
  evidenceFailed: string[];
  // RF-2/RF-1: a candidate we DID NOT reap because it was found running and left
  // alive. Two backstops feed this bucket: (1) a FRESH liveness re-probe at the
  // destroy chokepoint found it running (it restarted since the initial `docker ps
  // -a` scan) or could not confirm it dead; (2) the non-forced `docker rm` itself
  // refused to remove it because it came back to running in the residual window
  // between that re-probe and the rm (the atomic daemon-level guarantee, RF-1). A
  // running container is never removed across that race — mirrors the launch
  // sweep's skippedRunning bucket.
  skippedRunning: string[];
};

type ReapCandidateSource = "failed_retained" | "completed_leak";
type TaskLookupRow = { status: string; completedAt: string | null; projectDir: string | null; runId: string };

export function performOpsReapContainers(
  opts: { dryRun?: boolean; olderThanMinutes?: number; projectDir?: string; policy?: RetentionPolicy; nowMs?: number } = {},
  reap: ContainerReap = defaultContainerReap,
  listContainers: ContainerLister = defaultContainerList,
  containerExitInfo: ContainerExitInfo = defaultContainerExitInfo,
): ReapContainersOutcome {
  const containers = listContainers();
  if (containers === undefined) {
    return { dryRun: !!opts.dryRun, scanned: 0, reaped: [], retained: [], errors: [], completedTaskLeaks: [], completedTaskLeaksUnconfirmed: [], absenceHealed: [], resolutionWriteErrors: [], evidenceFailed: [], skippedRunning: [], dockerUnavailable: true };
  }

  // No store means no forge task can own any of these containers; the reap has
  // nothing it may act on and must not open (or create) a store to say so.
  if (!storeExists()) {
    return { dryRun: !!opts.dryRun, scanned: containers.length, reaped: [], retained: [], errors: [], completedTaskLeaks: [], completedTaskLeaksUnconfirmed: [], absenceHealed: [], resolutionWriteErrors: [], evidenceFailed: [], skippedRunning: [], dockerUnavailable: false };
  }
  const db = getDb({ readOnly: true });
  const lookupTask = db.prepare(
    `SELECT t.status AS status, t.completed_at AS completedAt, r.project_dir AS projectDir, t.run_id AS runId
     FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?`
  );

  const nowForAge = opts.nowMs ?? Date.now();
  const cutoffMs = opts.olderThanMinutes !== undefined ? nowForAge - opts.olderThanMinutes * 60_000 : undefined;
  const reaped: string[] = [];
  const retained: string[] = [];
  const errors: string[] = [];
  const completedTaskLeaks: string[] = [];
  const completedTaskLeaksUnconfirmed: string[] = [];
  const absenceHealed: string[] = [];
  const resolutionWriteErrors: string[] = [];
  const evidenceFailed: string[] = [];
  const skippedRunning: string[] = [];
  let scanned = 0;
  const nowMs = nowForAge;

  // RF-1 (TOCTOU): the destroy chokepoint re-probes liveness PER CONTAINER against a
  // FRESH listing taken immediately before THAT container's reap — never a snapshot
  // memoized across the whole sweep, and never the initial scan snapshot
  // (`container.running` above came from `containers`, fetched at the top of this call).
  // A single memoized re-list still loses the race: a container reported stopped when
  // that one list was taken can restart before its own (later) reap, and the stale
  // snapshot would greenlight destroying live work. So re-list at every chokepoint and
  // treat a candidate that is now running — or that we cannot confirm dead (the fresh
  // list is unreachable) — as ALIVE: never destroyed on absence of evidence. Mirrors the
  // launch sweep, whose removeLaunch chokepoint re-probes via readLaunch per launch
  // immediately before destroying.
  const isRunningAtChokepoint = (name: string): boolean => {
    const fresh = listContainers();
    if (fresh === undefined) return true; // docker now unreachable — cannot determine, treat as alive
    const entry = fresh.find((c) => c.name === name);
    if (!entry) return false; // gone from disk — the reap below will confirm not_found
    return entry.running;
  };

  // FG-505: the post-rm resolution write (and the absence-heal write below)
  // must never abort the sweep — if `docker rm` already confirmed the
  // container gone (or absence-scan did), that fact stands regardless of
  // whether logEvent's insert succeeds. A failed write is reported and left
  // for the next sweep's absence-heal pass to close.
  function recordResolution(runId: string, taskId: string, containerName: string, outcome: string): boolean {
    try {
      logEvent("container.reaped", { runId, taskId, payload: { containerName, outcome } });
      return true;
    } catch {
      resolutionWriteErrors.push(containerName);
      return false;
    }
  }

  // FG-590: before the destructive rm of a FAILED/AMBIGUOUS container, GUARANTEE the
  // exit/signal/OOM/timing (and missing-evidence) facts `forge show --diagnostic` needs
  // are durable. Reconcile usually recorded them at failure time already; when it did
  // (getContainerCausalEvidenceFromEvents finds a containerEvidence payload) there is
  // nothing to do. When it did NOT, capture them now via the same defaultContainerExitInfo
  // probe and persist a containerEvidence payload the diagnostic reader will find. A
  // durable exit code alone is NOT proof the task is terminal (that gate is the task's DB
  // status above), so this only ADDS evidence — it never drives task state. Returns false
  // if the persist WRITE fails: the caller then fails closed and retains the container so
  // the evidence is never destroyed unrecorded.
  //
  // RF-2: the pre-rm capture is recorded under `container.evidence_captured`, NOT
  // `container.reaped`. `container.reaped` is the durable RESOLUTION marker — the reap
  // succeeded — and detectContainerReapFailed / the absence-heal query below treat any
  // `container.reaped` newer than a `container.reap_failed` as "cleanup resolved". Emitting
  // it BEFORE the rm (when the rm may still error and leave the container present) fabricated
  // a resolution and could suppress a still-unresolved reap_failed incident. The diagnostic
  // reader keys on the `containerEvidence` payload, not the event type, so it still finds
  // this; only the resolution markers, which key on the type, no longer match it.
  function ensureFailureEvidencePersisted(runId: string, taskId: string, containerName: string): boolean {
    if (getContainerCausalEvidenceFromEvents(eventsForTask(taskId)) !== undefined) return true;
    const info = containerExitInfo(containerName);
    const evidence: ContainerCausalEvidence = {
      containerName,
      containerExitedEventObserved: false,
      ...(info.exitCode !== undefined ? { dockerExitCode: info.exitCode } : {}),
      ...(info.signal !== undefined ? { signal: info.signal } : {}),
      ...(info.oomKilled !== undefined ? { oomKilled: info.oomKilled } : {}),
      ...(info.startedAt !== undefined ? { startedAt: info.startedAt } : {}),
      ...(info.finishedAt !== undefined ? { finishedAt: info.finishedAt } : {}),
      ...(info.dockerStateError !== undefined ? { dockerStateError: info.dockerStateError } : {}),
    };
    try {
      logEvent("container.evidence_captured", { runId, taskId, payload: { containerName, stage: "pre_reap_evidence", containerEvidence: evidence } });
      return true;
    } catch {
      return false;
    }
  }

  for (const container of containers) {
    if (container.running) continue; // never touch a live container
    if (!container.name.startsWith("forge-")) continue;
    const taskId = container.name.slice("forge-".length);
    const row = lookupTask.get(taskId) as TaskLookupRow | undefined;
    if (!row) continue; // no known task for this container — not a candidate
    if (row.status !== "complete" && row.status !== "failed") continue; // non-terminal — never touch
    if (opts.projectDir !== undefined && row.projectDir !== opts.projectDir) continue; // out of scope

    scanned++;
    const source: ReapCandidateSource = row.status === "complete" ? "completed_leak" : "failed_retained";
    const containerName = container.name;

    // Disk truth (the container's own finishedAt) is preferred for the age check;
    // the task's completedAt is the fallback when docker couldn't confirm it (still
    // a valid signal — for the crash-window leak, markTaskComplete already ran).
    const anchor = container.finishedAt ?? row.completedAt;
    const ageMs = anchor ? nowMs - new Date(anchor).getTime() : undefined;

    if (cutoffMs !== undefined) {
      // FG-492/FG-503: the explicit --older-than-minutes gate — UNCHANGED. When the
      // operator names a single cutoff it wins over the per-outcome policy below.
      const ageAt = anchor ? new Date(anchor).getTime() : undefined;
      if (ageAt === undefined || ageAt > cutoffMs) {
        retained.push(containerName);
        continue;
      }
    } else if (opts.policy !== undefined) {
      // FG-590: automatic, per-outcome retention. A complete task's leaked container is
      // retired on the success window; a failed/ambiguous one is retained for the whole
      // diagnostic window. An UNKNOWN age (no finishedAt AND no completedAt) is retained,
      // never reaped on missing evidence.
      const cls = classifyRetention({ kind: "container", taskStatus: row.status });
      if (ageMs === undefined || !reapEligible(cls, ageMs, opts.policy)) {
        retained.push(containerName);
        continue;
      }
    }

    if (opts.dryRun) {
      reaped.push(containerName);
      if (source === "completed_leak") completedTaskLeaks.push(containerName);
      continue;
    }

    // RF-1: re-probe liveness at the single destroy chokepoint — never remove a container
    // that came back to running after the initial scan (or one we cannot confirm dead).
    if (isRunningAtChokepoint(containerName)) {
      skippedRunning.push(containerName);
      continue;
    }

    // FG-590: on the AUTOMATIC (policy-driven) path, fail closed BEFORE the destructive
    // rm of a failed/ambiguous container — if its diagnostic evidence cannot be made
    // durable, retain it and report, never destroy failure evidence unrecorded. This is
    // gated on `opts.policy` so the existing manual `forge ops reap-containers` (no policy)
    // stays byte-for-byte unchanged; the automatic cleanup that runs unattended is the one
    // that must not silently destroy evidence. Successful-task leaks carry no such evidence
    // requirement (nothing failed) and skip this.
    if (opts.policy !== undefined && source === "failed_retained" && !ensureFailureEvidencePersisted(row.runId, taskId, containerName)) {
      evidenceFailed.push(containerName);
      continue;
    }
    // "not_found" (already gone — e.g. FORGE_CONTAINER_RETENTION=off never kept
    // it, or a prior sweep already reaped it since we listed it) is equally
    // "nothing left behind" as "killed" — both count as reaped from this
    // command's perspective. For a completed-task candidate specifically,
    // "not_found" also means it was never actually a leak — excluded from
    // completedTaskLeaks accordingly.
    const outcome = reap(containerName);
    if (outcome === "skipped_running") {
      // RF-1: the atomic backstop. Even though the chokepoint re-probe above saw
      // it stopped, the container restarted before the (non-forced) rm, so the
      // docker daemon itself refused to remove it. It is alive and was correctly
      // left — never a reap error, never counted as reaped. Skip.
      skippedRunning.push(containerName);
    } else if (outcome === "error") {
      errors.push(containerName);
      // FG-504: NOT confirmed gone — must never join completedTaskLeaks
      // (that list is the "now swept" set the CLI reports as resolved).
      if (source === "completed_leak") completedTaskLeaksUnconfirmed.push(containerName);
    } else {
      reaped.push(containerName);
      if (outcome === "killed" && source === "completed_leak") completedTaskLeaks.push(containerName);
      // FG-504: confirmed gone (rm succeeded, or already not_found) — record
      // the durable resolution so detectContainerReapFailed stops flagging a
      // prior container.reap_failed for this task. Only the sweeper records
      // this; happy-path task-completion reaps stay silent (FG-503 AC4).
      // FG-505: this write is non-fatal (see recordResolution) — a thrown
      // insert here no longer aborts the rest of the sweep.
      recordResolution(row.runId, taskId, containerName, outcome);
    }
  }

  // FG-505: absence-heal pass — a `container.reap_failed` event can go
  // unresolved forever if the resolution write itself was lost (crash between
  // `docker rm` and logEvent above) or an operator cleaned the container up by
  // hand, since FG-503 candidacy only looks at containers docker still knows
  // about. Reconcile every unresolved reap_failed against the SAME `docker ps
  // -a` listing already fetched at the top of this scan (zero extra docker
  // calls): a container absent from that listing entirely (not merely
  // stopped) is confirmed gone one way or another. Live mode only — dry-run
  // writes nothing, and a container still present here is left for the
  // ordinary candidate loop above (or a later sweep) rather than healed.
  if (!opts.dryRun) {
    const presentNames = new Set(containers.map((c) => c.name));
    const unresolvedReapFailed = db
      .prepare(
        `SELECT t.id AS taskId, t.run_id AS runId, e.payload AS payload
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
      .all(opts.projectDir ?? null, opts.projectDir ?? null) as { taskId: string; runId: string; payload: string | null }[];

    for (const row of unresolvedReapFailed) {
      const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
      const containerName = typeof payload?.["containerName"] === "string" ? (payload["containerName"] as string) : `forge-${row.taskId}`;
      if (presentNames.has(containerName)) continue; // still on disk — never absence-heal
      if (recordResolution(row.runId, row.taskId, containerName, "confirmed-absent-at-scan")) {
        absenceHealed.push(containerName);
      }
    }
  }

  return { dryRun: !!opts.dryRun, scanned, reaped, retained, errors, completedTaskLeaks, completedTaskLeaksUnconfirmed, absenceHealed, resolutionWriteErrors, evidenceFailed, skippedRunning, dockerUnavailable: false };
}

// FG-590: the daemon-free automatic cleanup orchestrator. It drives BOTH terminal-resource
// paths — the filesystem-authoritative launch sweep and the DB+docker-authoritative
// container reap — under ONE resolved retention policy (readRetentionConfig overrides →
// FORGE_* env → code defaults). It is attached to the `forge next` wave boundary (next.ts)
// and exposed as `forge ops cleanup`; there is no resident scheduler.
//
// SAFETY POSTURE. It NEVER throws into its caller (each path is independently guarded), so
// a cleanup problem never breaks the wave that hosts it. The container reap opens the store
// READ-ONLY and only when one already exists (storeExists) — a store-less or clean host does
// no store write and mints nothing. The launch sweep touches only $FORGE_HOME/launches.
export type AutomaticCleanupResult = {
  policy: RetentionPolicy;
  launches: LaunchSweepResult | { error: string };
  containers: ReapContainersOutcome | { error: string };
  // FG-677: the terminal-run closeout's OWNED sections (git workspaces, generated
  // branches, publication worktrees, readiness records), each independently guarded and
  // composed alongside — never merged with — the FG-590 launches/containers sections
  // above, which are REPORTED into report.reportedElsewhere, not re-run.
  report: RunCleanupReport;
};

/** FG-677: a run is closed out only when it is DURABLY TERMINAL. Gated on the shared
 *  terminal-state classifier (classifyRunTerminalState) so the closeout never acts on a
 *  run still in flight; a run whose status is already a terminal disposition
 *  (complete/failed/abandoned) is durably terminal by definition. */
function isRunDurablyTerminal(runId: string): boolean {
  const run = getRun(runId);
  if (!run) return false;
  if (run.status === "complete" || run.status === "failed" || run.status === "abandoned") return true;
  const tasks = tasksForRun(runId);
  return tasks.length > 0 && classifyRunTerminalState(undefined, tasks) !== null;
}

function cleanupErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** FG-677: assemble the terminal-run closeout report. Three independently-erroring
 *  sections — git-workspace/branch (per durably-terminal run), publication-worktree, and
 *  readiness — with the readiness prune's workspaceRetired predicate wired from the
 *  workspaces the git-workspace + publication sections positively retired IN THIS PASS. On
 *  a dry run nothing is mutated; the proposed dispositions match the real pass because each
 *  section re-derives its own safety proofs immediately before acting and forks only at the
 *  mutation. */
function performRunCloseout(opts: {
  dryRun?: boolean;
  projectDir: string;
  runId?: string;
  now?: Date;
  policy: RetentionPolicy;
  // Injected for tests; production uses the real docker/tmux probes inside each section.
  containerAlive?: ContainerAlive;
  cwdGuard?: (path: string) => CwdHolderResult;
}): RunCleanupReport {
  const report = emptyRunCleanupReport({ dryRun: opts.dryRun, ...(opts.runId ? { runId: opts.runId } : {}) });
  const dryRun = !!opts.dryRun;
  // Workspaces this pass positively retired (or, under dry run, would retire) — the ONLY
  // authority the readiness prune uses to remove a bound record.
  const retired = new Set<string>();

  // ── git-workspace + generated-branch section (per durably-terminal run) ──
  if (storeExists()) {
    try {
      const runIds = opts.runId
        ? [opts.runId]
        : listRuns()
            .filter((r) => r.projectDir && provenSameOnly(r.projectDir, opts.projectDir))
            .map((r) => r.id);
      for (const rid of runIds) {
        if (!isRunDurablyTerminal(rid)) {
          // Only surface a not-terminal run when the caller named it explicitly; a
          // full-project sweep silently skips runs still in flight.
          if (opts.runId) {
            report.gitWorkspaces.push({ resourceClass: "git_workspace", path: `run ${rid}`, action: "retained", reason: "run_not_terminal" });
          }
          continue;
        }
        const res = disposeRunGitWorkspaces(rid, {
          dryRun,
          ...(opts.containerAlive ? { containerAlive: opts.containerAlive } : {}),
          ...(opts.cwdGuard ? { cwdGuard: (p: string) => opts.cwdGuard!(p) } : {}),
        });
        report.gitWorkspaces.push(...res.gitWorkspaces);
        report.generatedBranches.push(...res.generatedBranches);
        for (const w of res.retiredWorkspaces) retired.add(w);
      }
    } catch (e) {
      report.sectionErrors.gitWorkspaces = cleanupErrorMessage(e);
    }

    // ── publication-worktree section (host-global sweep, project-agnostic on disk) ──
    try {
      const res = sweepPublicationWorktrees({ dryRun, ...(opts.now ? { now: opts.now } : {}), policy: opts.policy, ...(opts.cwdGuard ? { cwdGuard: opts.cwdGuard } : {}) });
      report.publicationWorktrees.push(...res.publicationWorktrees);
      for (const d of res.publicationWorktrees) if (d.action === "removed") retired.add(d.path);
    } catch (e) {
      report.sectionErrors.publications = cleanupErrorMessage(e);
    }
  }

  // ── readiness-record prune (tied to the workspaces retired above) ──
  try {
    const res = pruneReadinessRecords({ dryRun, workspaceRetired: (w) => retired.has(w) });
    report.readinessRecords.push(...res.readinessRecords);
  } catch (e) {
    report.sectionErrors.readiness = cleanupErrorMessage(e);
  }

  return report;
}

function summarizeLaunches(l: AutomaticCleanupResult["launches"], dryRun: boolean): string {
  if ("error" in l) return `error: ${l.error}`;
  if (dryRun) return "(dry-run) launch sweep skipped (it removes, so it does not run under --dry-run)";
  return `retired ${l.removed.length}, retained ${l.retained.length}, running (untouched) ${l.skippedRunning.length}`;
}

function summarizeContainers(c: AutomaticCleanupResult["containers"]): string {
  if ("error" in c) return `error: ${c.error}`;
  if (c.dockerUnavailable) return "docker unavailable — no scan performed";
  const verb = c.dryRun ? "would retire" : "retired";
  return `${verb} ${c.reaped.length}/${c.scanned}, retained ${c.retained.length}`;
}

export function performAutomaticCleanup(
  opts: {
    dryRun?: boolean;
    projectDir?: string;
    now?: Date;
    tmux?: TmuxRunner;
    reap?: ContainerReap;
    listContainers?: ContainerLister;
    containerExitInfo?: ContainerExitInfo;
    // FG-677: the wave-boundary caller (forge next) names the run it just settled so the
    // git-workspace closeout targets exactly that run. Absent (the manual full sweep), the
    // closeout enumerates every durably-terminal run in the project.
    runId?: string;
    // Injected for tests; production resolves from config + env below.
    policy?: RetentionPolicy;
    // FG-677: injected for tests; production uses the real docker/tmux probes.
    containerAlive?: ContainerAlive;
    cwdGuard?: (path: string) => CwdHolderResult;
  } = {},
): AutomaticCleanupResult {
  const projectDir = opts.projectDir ?? process.cwd();
  const policy =
    opts.policy ??
    resolveRetention(safeReadRetentionOverrides(projectDir), process.env);

  let launches: AutomaticCleanupResult["launches"];
  try {
    // RF-5: scope the launch sweep to this project. The container reap is already
    // projectDir-scoped; the launch sweep was host-global, so a project-local retention
    // override (a repo `.forge/config.yml` or a FORGE_* env with a short/zero window) would
    // retire terminal launches OWNED BY OTHER PROJECTS. Exclude any launch the observation
    // store places in a provably-different project; unowned/host-global launches stay in
    // scope.
    const foreignResult = safeForeignLaunchIds(projectDir);
    if (!foreignResult.ok) {
      // RF-5: cross-project ownership could not be established. FAIL CLOSED — retire NOTHING
      // (removing now could purge another project's terminal launch) and surface the failure
      // rather than silently sweeping over launches we cannot prove are ours to remove.
      launches = { error: `launch sweep skipped: cannot establish cross-project ownership (${foreignResult.error})` };
    } else {
      const foreign = foreignResult.foreign;
      // The launch sweep does not remove anything on a dry run — it only reports would-be
      // work — so a dry run passes a clock but never destroys. sweepTerminalLaunches itself
      // has no dry-run mode (it removes), so a dry-run cleanup skips the destructive sweep
      // and reports an empty result rather than removing launches.
      launches = opts.dryRun
        ? { scanned: 0, removed: [], retained: [], skippedRunning: [], errors: [] }
        : sweepTerminalLaunches(policy, { now: opts.now, tmux: opts.tmux, scope: (id) => !foreign.has(id) });
    }
  } catch (e) {
    launches = { error: e instanceof Error ? e.message : String(e) };
  }

  let containers: AutomaticCleanupResult["containers"];
  try {
    containers = performOpsReapContainers(
      { dryRun: opts.dryRun, projectDir, policy, ...(opts.now ? { nowMs: opts.now.getTime() } : {}) },
      opts.reap ?? defaultContainerReap,
      opts.listContainers ?? defaultContainerList,
      opts.containerExitInfo ?? defaultContainerExitInfo,
    );
  } catch (e) {
    containers = { error: e instanceof Error ? e.message : String(e) };
  }

  // FG-677: the terminal-run closeout's OWNED sections. Independently guarded — a closeout
  // problem never breaks the launches/containers sections above or the wave that hosts them.
  let report: RunCleanupReport;
  try {
    report = performRunCloseout({
      dryRun: opts.dryRun,
      projectDir,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      policy,
      ...(opts.containerAlive ? { containerAlive: opts.containerAlive } : {}),
      ...(opts.cwdGuard ? { cwdGuard: opts.cwdGuard } : {}),
    });
  } catch (e) {
    report = emptyRunCleanupReport({ dryRun: opts.dryRun, ...(opts.runId ? { runId: opts.runId } : {}) });
    report.sectionErrors.closeout = cleanupErrorMessage(e);
  }
  // The FG-590 launch/container disposition is REPORTED here, never re-run or re-authorized.
  report.reportedElsewhere.launches = summarizeLaunches(launches, !!opts.dryRun);
  report.reportedElsewhere.containers = summarizeContainers(containers);

  return { policy, launches, containers, report };
}

/** Read the optional per-project retention override, never letting a read problem abort
 *  cleanup — a symlink/parse issue reads as "no override" and the code defaults apply. */
function safeReadRetentionOverrides(projectDir: string): ReturnType<typeof readRetentionConfig> {
  try {
    return readRetentionConfig(projectDir);
  } catch {
    return undefined;
  }
}

/** RF-5: the launch ids owned by a project OTHER than this one, to exclude from the
 *  project-scoped launch sweep — or an explicit FAILURE when cross-project ownership
 *  cannot be established. It FAILS CLOSED: a store/query problem is NOT flattened into
 *  "no foreign launches" (which would let a project-local zero-window sweep purge another
 *  project's terminal launch). The caller must retire NOTHING and surface the failure when
 *  this returns `{ ok: false }`, never widen the deletion scope on absence of evidence. */
type ForeignLaunchIds = { ok: true; foreign: Set<string> } | { ok: false; error: string };
function safeForeignLaunchIds(projectDir: string): ForeignLaunchIds {
  // No store means no launch is recorded as owned by any project — nothing to exclude,
  // and the read must NOT open (or mint) a store to say so (store-less host invariant).
  // This is a PROVEN "no foreign launches", not an unread store, so it is ok:true.
  if (!storeExists()) return { ok: true, foreign: new Set() };
  try {
    return { ok: true, foreign: launchIdsOwnedByOtherProjects(projectDir) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerOps(program: Command): void {
  const ops = program.command("ops").description("Operational intelligence over the forge blackboard.");

  ops
    .command("check")
    .option("--json", "emit structured incidents as JSON")
    .option("--all", "check every project on this host (default: scope to the current directory's project)")
    .option("--project <dir>", "scope to a specific project dir (default: cwd). Ignored with --all.")
    // FG-703 (step 5): the operator READ surface for adjudicated incidents. A
    // flag on `check`, NOT a new verb — so an adjudicated incident renders WITH
    // its ORIGINAL detector evidence through the SAME runOpsCheck/renderHuman
    // choke point, and the widening is explicit and one-directional. Without it,
    // `check` is byte-for-byte unchanged (adjudicated incidents stay suppressed).
    .option("--include-adjudicated", "also show orphaned_work_may_persist incidents already retired via `forge ops adjudicate`, each annotated with its audit record (default: hidden)")
    .description(
      "Detect 'needs attention' incidents from existing state. The default (human) output also pushes one " +
        "notification per NEW live incident, recording orchestrator.milestone events (deduped on incident identity). " +
        "Use --json for a read-only, side-effect-free scan. Use --include-adjudicated to also surface incidents " +
        "already retired by `forge ops adjudicate`, together with their original evidence and audit record."
    )
    .action(async (opts: { json?: boolean; all?: boolean; project?: string; includeAdjudicated?: boolean }) => {
      ensureForgeDirs();
      if (renderedEmptyStore(opts.json, [], "No forge store on this host yet — no incidents to report.")) return;
      const projectDir = opts.all ? undefined : resolve(opts.project ?? process.cwd());
      const incidents = runOpsCheck({ projectDir, includeAdjudicated: opts.includeAdjudicated });

      if (opts.json) {
        // Read-only contract: the --json path must stay side-effect-free (no notify).
        console.log(JSON.stringify(incidents, null, 2));
        return;
      }
      console.log(renderHuman(incidents));
      await notifyLiveIncidents(incidents);
    });

  ops
    .command("repair")
    .argument(
      "<id>",
      "the orphaned task id (retry_orphan), the resurrected task id (resurrected_gate_decision), or the stuck run id (stuck_run) to repair"
    )
    .option("--dry-run", "report what would change; write nothing")
    .option("--json", "emit JSON result")
    .description(
      "Repair a retry_orphan (pending task stranded under a terminal run → marked failed), a " +
        "resurrected_gate_decision (task sitting at awaiting_gate over its own gate rejection → terminal row " +
        "restored from the event stream, rejected artifact preserved), or a stuck_run (active run whose tasks " +
        "are all terminal → marked abandoned). Refuses anything that is not one of those exact shapes."
    )
    .action((id: string, opts: { dryRun?: boolean; json?: boolean }) => {
      ensureForgeDirs();
      let outcome: OpsRepairOutcome;
      try {
        outcome = performOpsRepairCommand(id, opts);
      } catch (e) {
        if (e instanceof RunBusyError) {
          process.stderr.write(`forge ops repair: ${e.message}\n  Another forge command is mutating this run. Wait for it to finish.\n`);
          process.exit(1);
        }
        throw e;
      }

      if (opts.json) {
        console.log(JSON.stringify({ dryRun: opts.dryRun ?? false, ...outcome }, null, 2));
        if (outcome.kind === "unknown" || outcome.kind === "refused") process.exit(1);
        return;
      }

      if (outcome.kind === "unknown") {
        process.stderr.write(`forge ops repair: unknown task or run '${id}'\n`);
        process.exit(1);
      }
      if (outcome.kind === "refused") {
        process.stderr.write(`forge ops repair: refused — ${outcome.reason}\n`);
        process.exit(1);
      }
      // FG-676: distinct wording — this repair REINSTATES a human's decision from
      // the event stream; "marked task X failed (orphaned)" would name the wrong
      // cause and hide that the rejected artifact was preserved.
      if (outcome.kind === "gate-decision-restored") {
        const verb = outcome.dryRun ? "(dry-run) would restore" : "Restored";
        console.log(
          `${verb} task ${outcome.taskId} to failed (resurrected_gate_decision) — gate decision reinstated from the event stream: "${outcome.restoredError}".`
        );
        console.log(`  result (the rejected artifact) preserved unchanged; run ${outcome.runId} left untouched.`);
        if (outcome.dryRun) console.log("No writes.");
        return;
      }
      if (outcome.kind === "run-repaired") {
        const verb = outcome.dryRun ? "(dry-run) would mark" : "Marked";
        console.log(`${verb} run ${outcome.runId} abandoned (stuck_run — no non-terminal tasks, no live container).`);
        if (outcome.dryRun) console.log("No writes.");
        return;
      }
      const verb = outcome.dryRun ? "(dry-run) would mark" : "Marked";
      console.log(`${verb} task ${outcome.taskId} failed (orphaned); run ${outcome.runId} left terminal/untouched.`);
      if (outcome.dryRun) console.log("No writes.");
    });

  ops
    .command("reap-containers")
    .option("--dry-run", "report what would be removed; remove nothing")
    .option("--older-than-minutes <n>", "only reap a container whose task completed at least this many minutes ago", (v) => Number(v))
    .option("--all", "scan every project on this host (default: scope to the current directory's project)")
    .option("--project <dir>", "scope to a specific project dir (default: cwd). Ignored with --all.")
    .option("--json", "emit structured JSON")
    .description(
      "Remove forge-<taskId> containers retained on failure (FG-492's FORGE_CONTAINER_RETENTION policy), plus any successful task whose own cleanup failed (FG-503), once their diagnostic value has passed. Candidacy is disk-truth-driven (docker ps -a), not dependent on any event having been recorded. Never touches a running task's container."
    )
    .action((opts: { dryRun?: boolean; olderThanMinutes?: number; all?: boolean; project?: string; json?: boolean }) => {
      ensureForgeDirs();
      const projectDir = opts.all ? undefined : resolve(opts.project ?? process.cwd());
      const outcome = performOpsReapContainers({ dryRun: opts.dryRun, olderThanMinutes: opts.olderThanMinutes, projectDir });

      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }

      if (outcome.dockerUnavailable) {
        console.log("docker unavailable — could not list forge-* containers. No scan performed.");
        return;
      }

      const verb = outcome.dryRun ? "(dry-run) would reap" : "Reaped";
      console.log(`${verb} ${outcome.reaped.length}/${outcome.scanned} retained container(s).`);
      if (outcome.retained.length > 0) console.log(`  still within retention window: ${outcome.retained.join(", ")}`);
      if (outcome.errors.length > 0) console.log(`  reap failed (not confirmed gone — left for a later sweep): ${outcome.errors.join(", ")}`);
      // FG-503: call out leaks on otherwise-SUCCESSFUL tasks distinctly — the
      // condition FG-503 exists to make visible instead of silent.
      // FG-505: dry-run never claims a completed action — "would be swept" is
      // conditional, matching the "(dry-run) would reap" verb above; only a
      // real (live) sweep gets to say "now swept".
      if (outcome.completedTaskLeaks.length > 0) {
        const phrase = outcome.dryRun ? "would be swept" : "now swept";
        console.log(`  leaked from a SUCCESSFUL task (explicit cleanup failed, ${phrase}): ${outcome.completedTaskLeaks.join(", ")}`);
      }
      // FG-504: the reap attempt errored — NOT confirmed gone, so this must
      // never share the "now swept" line above.
      if (outcome.completedTaskLeaksUnconfirmed.length > 0) console.log(`  leaked from a SUCCESSFUL task (explicit cleanup failed, NOT confirmed gone — left for a later sweep): ${outcome.completedTaskLeaksUnconfirmed.join(", ")}`);
      // FG-505: a prior container.reap_failed healed by absence (container
      // gone from docker entirely — a lost resolution write, or a manual
      // `docker rm`), not by this sweep's own reap attempt.
      if (outcome.absenceHealed.length > 0) console.log(`  healed by absence (container gone, prior reap resolution now recorded): ${outcome.absenceHealed.join(", ")}`);
      if (outcome.resolutionWriteErrors.length > 0) console.log(`  resolution write failed (container confirmed gone, but the event insert threw — a later sweep will heal it): ${outcome.resolutionWriteErrors.join(", ")}`);
      // FG-590: a failed/ambiguous container we REFUSED to reap because its diagnostic
      // evidence could not be persisted — fail closed, retained, and named here.
      if (outcome.evidenceFailed.length > 0) console.log(`  RETAINED — evidence could not be persisted before reap (failing closed, left for inspection): ${outcome.evidenceFailed.join(", ")}`);
      // RF-1: a candidate that came back to running (or could not be confirmed dead) at
      // the destroy chokepoint — never removed across the race.
      if (outcome.skippedRunning.length > 0) console.log(`  skipped (running again / liveness unconfirmed at reap time): ${outcome.skippedRunning.join(", ")}`);
      if (outcome.dryRun) console.log("No writes.");
    });

  // FG-677 (FG-590 base): `forge ops cleanup` — the immediate manual terminal-run closeout,
  // the same work the `forge next` wave does at its boundary, on demand. It reconciles the
  // OWNED disposable artifacts (git workspaces, generated branches, publication worktrees,
  // readiness records) and REPORTS the separate FG-590 tmux/container disposition without
  // re-running it. --dry-run performs no mutation and reports the exact proposed
  // dispositions the subsequent real pass would perform.
  ops
    .command("cleanup")
    .option("--dry-run", "inventory only: perform NO mutation; report the exact proposed disposition and proof for every artifact")
    .option("--project <dir>", "scope the closeout to a specific project dir (default: cwd)")
    .option("--json", "emit structured JSON")
    .description(
      "Terminal-run closeout: reconcile every disposable git workspace, generated branch, publication worktree, " +
        "and host readiness record a durably-terminal run created — removing only artifacts proven safe and retaining " +
        "every uniquely-held, active, or ambiguous artifact with a named reason and recovery action. Also retires terminal " +
        "launch tmux sessions and expired retained task containers under the configured retention policy (success retires " +
        "promptly; failed/ambiguous is kept for its diagnostic window). Defaults live in code; override with " +
        ".forge/config.yml `retention:` or FORGE_RETENTION_* env. Never removes a running launch/container, a non-terminal " +
        "task's container, a workspace held by a live process/mount, or an artifact of ambiguous ownership."
    )
    .action((opts: { dryRun?: boolean; project?: string; json?: boolean }) => {
      ensureForgeDirs();
      const projectDir = resolve(opts.project ?? process.cwd());
      const result = performAutomaticCleanup({ dryRun: opts.dryRun, projectDir });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // FG-677: the owned closeout report first — every retained artifact with its reason,
      // path, and recovery action; every removed artifact named.
      console.log(formatRunCleanupReport(result.report));

      const l = result.launches;
      if ("error" in l) {
        console.log(`launch sweep failed: ${l.error}`);
      } else if (opts.dryRun) {
        console.log("launches: (dry-run) launch sweep skipped — it removes, so it does not run under --dry-run.");
      } else {
        console.log(`launches: retired ${l.removed.length}, retained ${l.retained.length}, running (untouched) ${l.skippedRunning.length}.`);
        if (l.errors.length > 0) console.log(`  refused (raced back to running / removal error): ${l.errors.join(", ")}`);
      }

      const c = result.containers;
      if ("error" in c) {
        console.log(`container reap failed: ${c.error}`);
      } else if (c.dockerUnavailable) {
        console.log("containers: docker unavailable — no scan performed.");
      } else {
        const verb = c.dryRun ? "(dry-run) would retire" : "retired";
        console.log(`containers: ${verb} ${c.reaped.length}/${c.scanned}, retained (within window) ${c.retained.length}.`);
        if (c.errors.length > 0) console.log(`  reap failed (not confirmed gone): ${c.errors.join(", ")}`);
        if (c.evidenceFailed.length > 0) console.log(`  RETAINED — evidence not persisted before reap (failing closed): ${c.evidenceFailed.join(", ")}`);
        if (c.skippedRunning.length > 0) console.log(`  skipped (running again / liveness unconfirmed at reap time): ${c.skippedRunning.join(", ")}`);
        if (c.absenceHealed.length > 0) console.log(`  healed by absence: ${c.absenceHealed.join(", ")}`);
      }
      if (opts.dryRun) console.log("No writes.");
    });

  // FG-703: `forge ops adjudicate <taskId>` — operator-authorized, fail-closed,
  // append-only. Retires ONE orphaned_work_may_persist incident (outcome
  // no_unique_work) from the active high-severity report by recording a single
  // ops.adjudicated audit event. It writes NOTHING else: failed stays failed, the
  // run is untouched, the result column and the original task.failed evidence are
  // never rewritten. Every refusal names the blocking fact and exits non-zero.
  ops
    .command("adjudicate")
    .argument("<taskId>", "the failed task whose orphaned_work_may_persist incident to adjudicate (the incident's task id)")
    .requiredOption("--rationale <text>", "why the incident is retired — recorded as durable audit history (must be non-empty)")
    .option("--outcome <outcome>", "the disposition; only 'no_unique_work' is accepted", "no_unique_work")
    .option("--actor <who>", "who is adjudicating (defaults to the current OS user); recorded in the audit event")
    .requiredOption("--identity <sha>", "the incident identity you inspected (from a prior check); REQUIRED — the write refuses on drift and there is no way to adjudicate without naming it")
    .option("--project <dir>", "scope to a specific project dir (default: cwd)")
    .option("--json", "emit JSON result")
    .description(
      "Retire ONE orphaned_work_may_persist ops incident (outcome no_unique_work) from the active high-severity " +
        "report, preserving the failed task, failed run, detector evidence, rationale, actor and timestamp as durable " +
        "audit history. Append-only: it changes NO task, run, or result state. Fails closed (non-zero, naming the fact) " +
        "for an unknown incident, an unsupported kind, an unsupported outcome, a missing rationale, a project mismatch, " +
        "or an incident whose current identity no longer matches the record you inspected."
    )
    .action((taskId: string, opts: { rationale: string; outcome: string; actor?: string; identity: string; project?: string; json?: boolean }) => {
      ensureForgeDirs();
      const projectDir = resolve(opts.project ?? process.cwd());
      const result: AdjudicateResult = performAdjudicate(taskId, {
        outcome: opts.outcome,
        rationale: opts.rationale,
        actor: resolveActor(opts.actor),
        projectDir,
        expectedIdentity: opts.identity,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (result.kind !== "adjudicated") process.exit(1);
        return;
      }

      if (result.kind === "unknown") {
        process.stderr.write(`forge ops adjudicate: unknown incident — no live orphaned_work_may_persist incident for task '${result.id}'\n`);
        process.exit(1);
      }
      if (result.kind === "refused") {
        process.stderr.write(`forge ops adjudicate: refused — ${result.reason}\n`);
        process.exit(1);
      }
      console.log(`Adjudicated orphaned_work_may_persist incident for task ${result.taskId} (${result.outcome}).`);
      console.log(`  actor: ${result.actor}  at: ${result.at}`);
      console.log(`  identity: ${result.identity}`);
      console.log(`  failed task, failed run, and detector evidence left untouched (audit-only).`);
    });
}

/** WHO is adjudicating. An explicit --actor wins; otherwise the current OS user,
 *  so the durable audit event is never blank. Never throws — a userInfo() failure
 *  in a minimal environment falls back to "unknown". */
function resolveActor(explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  try {
    const name = userInfo().username;
    return name && name.length > 0 ? name : "unknown";
  } catch {
    return "unknown";
  }
}
