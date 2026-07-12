// #290: read-only reconcile-candidate detection, shared by `forge ops check`
// (src/ops/detect.ts) and the dashboard (dashboard/src/queries.ts).
//
// The Pixtron case: a task wrote a valid result.json but its DB row stayed
// `running` for ~2h, because nothing triggered reconcileRun. Both ops and the
// dashboard read state without reconciling, so they faithfully showed stale
// `running`. This module lets them DISTINGUISH "actually running" from "DB says
// running, container is gone, result exists, needs reconciliation" — WITHOUT
// mutating anything. The mutation stays where it belongs: reconcile.ts, reached
// via a lifecycle command (`forge show/status/next`).
//
// Boundary vs reconcile.ts: reconcile.ts OWNS the conservative liveness judgment
// AND the write. This module mirrors the same conservatism for a pure-read
// classification — and crucially keeps "docker can't tell us" as its own state
// (`liveness_unknown`) rather than collapsing it to alive the way reconcile's
// boolean `defaultContainerAlive` must (it can't risk reconciling live work on a
// transient docker hiccup). A read surface can afford to say "unknown".

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { taskDir } from "../util/paths.js";
import { liveRunLockHolder } from "../util/run-lock.js";

/** Three-state liveness — unlike reconcile's boolean, a read surface keeps
 *  "we couldn't tell" distinct from "alive" so it never mislabels a docker
 *  hiccup as a reconcile candidate. */
export type LivenessState = "alive" | "gone" | "unknown";
export type LivenessProbe = (containerName: string) => LivenessState;

/** Whether a valid (parseable, non-empty) result.json exists for the task. */
export type ResultProbe = (runId: string, taskId: string) => boolean;

/** Whether a LIVE forge process still holds the run's lock. */
export type RunLockProbe = (runId: string) => boolean;

export type ReconcileClassification =
  | "running" // container alive, no result yet — ordinary live work
  | "reconcile_candidate" // container gone — the DB row is stale and needs reconciliation
  | "liveness_unknown" // docker unavailable / ambiguous — conservatively NOT a candidate
  | "anomalous_result_while_alive"; // container alive but a result already exists — odd, not terminal

/** Sub-reason, only meaningful for `reconcile_candidate`. */
export type ReconcileReason =
  | "container_gone_result_present" // finished; DB write was lost — reconcile completes invoke tasks; pipeline steps land fail-safe as orphaned_needs_finalize (FG-479)
  | "container_gone_no_result" // orphaned; container died with nothing — likely failed
  | "pre_container_crash" // FG-533: marked running, but the agent container never launched — forge died in the pre-container window
  | null;

export type ReconcileCandidate = {
  taskId: string;
  runId: string;
  classification: ReconcileClassification;
  reason: ReconcileReason;
  hasResult: boolean;
};

/** Probe a container's liveness three-state. `docker inspect` returning "true"
 *  is alive; "false" (exited-but-not-removed) or a clear "no such object" is
 *  gone; anything else (daemon down, docker missing) is unknown — never coerced
 *  to gone, so an ambiguous docker failure cannot manufacture a candidate. */
export function probeContainerLiveness(name: string): LivenessState {
  try {
    const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return out === "true" ? "alive" : "gone"; // exists but not running → finished → gone
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (/No such object|no such container/i.test(stderr)) return "gone"; // genuinely gone
    return "unknown"; // ambiguous → not a candidate
  }
}

/** Default result probe: a parseable, non-empty result.json on disk. Mirrors
 *  reconcile.ts's readResult validity check (same "did the agent leave usable
 *  output" question). */
export function defaultResultPresent(runId: string, taskId: string): boolean {
  const p = join(taskDir(runId, taskId), "result.json");
  if (!existsSync(p)) return false;
  const raw = readFileSync(p, "utf8").trim();
  if (raw.length === 0) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** Default run-lock probe. `staleMs: MAX_SAFE_INTEGER` mirrors reconcile.ts's
 *  FG-533 guard exactly: in the pre-container window the lock is the ONLY
 *  liveness signal (there is no container yet), and the span can legitimately run
 *  long under a lock acquired much earlier (cold image pull), so a LIVE holder
 *  means "still working", no matter its age. A dead holder returns null
 *  regardless of age, so a genuine crash is still surfaced. */
export function defaultRunLockLive(runId: string): boolean {
  return liveRunLockHolder(runId, { staleMs: Number.MAX_SAFE_INTEGER }) !== null;
}

function classify(liveness: LivenessState, hasResult: boolean): {
  classification: ReconcileClassification;
  reason: ReconcileReason;
} {
  switch (liveness) {
    case "unknown":
      return { classification: "liveness_unknown", reason: null };
    case "alive":
      return hasResult
        ? { classification: "anomalous_result_while_alive", reason: null }
        : { classification: "running", reason: null };
    case "gone":
      return hasResult
        ? { classification: "reconcile_candidate", reason: "container_gone_result_present" }
        : { classification: "reconcile_candidate", reason: "container_gone_no_result" };
  }
}

/** FG-533: the pre-container window — a `running` row with no container.started.
 *  The SQL below has already applied the shape guards (workflow provenance, not
 *  manual, no children, not mid-provisioning); what remains is the liveness half,
 *  and it reads STRICTER than the container-gone case because there is no result
 *  to recover and no container to inspect:
 *    alive   → docker started the container but the container.started append was
 *              lost. Real work is running; never a candidate.
 *    unknown → docker can't tell us. Same conservatism as everywhere else here.
 *    gone    → a live run-lock holder means forge is STILL in the pre-container
 *              span (image pull / auth staging / provisioning), so it is ordinary
 *              running work. Only with no live holder is the row genuinely
 *              stranded — nothing on the host or in docker can advance it. */
function classifyPreContainer(liveness: LivenessState, lockLive: boolean): {
  classification: ReconcileClassification;
  reason: ReconcileReason;
} {
  switch (liveness) {
    case "unknown":
      return { classification: "liveness_unknown", reason: null };
    case "alive":
      return { classification: "running", reason: null };
    case "gone":
      return lockLive
        ? { classification: "running", reason: null }
        : { classification: "reconcile_candidate", reason: "pre_container_crash" };
  }
}

export type FindReconcileCandidatesOptions = {
  /** Scope to one project's runs (runs.project_dir). Omit for the host-wide view. */
  projectDir?: string;
  /** Scope to a single run. */
  runId?: string;
  /** Scope to a single task (used by the dashboard task-detail view). */
  taskId?: string;
};

type RunningRow = { taskId: string; runId: string; containerStarted: number };

/** Find and classify every running task forge could have containerized, against
 *  container liveness + result presence. Read-only: pure SELECTs + external
 *  probes, no writes, no events.
 *
 *  Two eligible shapes, and the difference is `container.started`:
 *
 *  1. Containerized (the #290 shape) — a `container.started` event proves forge
 *     launched a container, so `docker inspect` is meaningful. Session
 *     (orchestrator / forge design) and manual tasks run host-side and never
 *     launch one, so probing them would always say "gone" and wrongly flag them.
 *
 *  2. Pre-container (the FG-533 shape) — marked `running` with NO
 *     container.started. runContainer flips the row to running before the
 *     container launches, and the span that follows (image pull, auth staging,
 *     dependency provisioning) is minutes long; a crash inside it strands the row
 *     with no container to probe. Shape 1's guard would omit it — the blindness
 *     this branch fixes. Because such a row has no container.started to lean on,
 *     the SQL re-applies reconcile.ts's own FG-533 guards, so this surface reports
 *     exactly what a lifecycle command would sweep, nothing looser:
 *       · workflow dispatch provenance only (FG-512 marker) — invoke, session/
 *         design, and legacy marker-less rows are exempt;
 *       · agent_role != 'manual' — runner-minted manual steps carry the workflow
 *         marker but run host-side, never containerized;
 *       · no children — a fanout parent legitimately runs container-less for its
 *         whole wave (FG-455-p2 / FG-531 own parent recovery);
 *       · not mid-provisioning (provision_started with no provision_succeeded) —
 *         reconcile's FG-437 branch owns that sub-window and probes a DIFFERENTLY
 *         NAMED provisioner container, so classifying it here would both duplicate
 *         it and name the wrong cause.
 *     The remaining two guards are liveness, applied in classifyPreContainer: a
 *     live agent container, or a live run-lock holder of any age, means the work
 *     is real and the row is not a candidate.
 *
 *  Probes are injectable so the classification logic is testable without docker
 *  or a real lock file; the SQL guards mean only eligible running tasks are ever
 *  probed.
 *
 *  Returns ALL evaluated tasks (including `running`) so callers can map by
 *  taskId; filter on `classification` for the subset you care about. */
export function findReconcileCandidates(
  db: DatabaseInstance,
  opts: FindReconcileCandidatesOptions = {},
  probe: LivenessProbe = probeContainerLiveness,
  resultPresent: ResultProbe = defaultResultPresent,
  runLockLive: RunLockProbe = defaultRunLockLive
): ReconcileCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.run_id AS runId,
              EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.started') AS containerStarted
       FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'running'
         AND (
           EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.started')
           OR (
             json_extract(t.task_package, '$.dispatchSource') = 'workflow'
             AND t.agent_role != 'manual'
             AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)
             AND NOT (
               EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.provision_started')
               AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.provision_succeeded')
             )
           )
         )
         AND (? IS NULL OR r.project_dir = ?)
         AND (? IS NULL OR t.run_id = ?)
         AND (? IS NULL OR t.id = ?)`
    )
    .all(
      opts.projectDir ?? null,
      opts.projectDir ?? null,
      opts.runId ?? null,
      opts.runId ?? null,
      opts.taskId ?? null,
      opts.taskId ?? null
    ) as RunningRow[];

  return rows.map((row) => {
    const hasResult = resultPresent(row.runId, row.taskId);
    const liveness = probe(`forge-${row.taskId}`);
    const { classification, reason } = row.containerStarted
      ? classify(liveness, hasResult)
      : classifyPreContainer(liveness, liveness === "gone" ? runLockLive(row.runId) : false);
    return { taskId: row.taskId, runId: row.runId, classification, reason, hasResult };
  });
}
