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

/** Three-state liveness — unlike reconcile's boolean, a read surface keeps
 *  "we couldn't tell" distinct from "alive" so it never mislabels a docker
 *  hiccup as a reconcile candidate. */
export type LivenessState = "alive" | "gone" | "unknown";
export type LivenessProbe = (containerName: string) => LivenessState;

/** Whether a valid (parseable, non-empty) result.json exists for the task. */
export type ResultProbe = (runId: string, taskId: string) => boolean;

export type ReconcileClassification =
  | "running" // container alive, no result yet — ordinary live work
  | "reconcile_candidate" // container gone — the DB row is stale and needs reconciliation
  | "liveness_unknown" // docker unavailable / ambiguous — conservatively NOT a candidate
  | "anomalous_result_while_alive"; // container alive but a result already exists — odd, not terminal

/** Sub-reason, only meaningful for `reconcile_candidate`. */
export type ReconcileReason =
  | "container_gone_result_present" // finished; DB write was lost — likely complete
  | "container_gone_no_result" // orphaned; container died with nothing — likely failed
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

export type FindReconcileCandidatesOptions = {
  /** Scope to one project's runs (runs.project_dir). Omit for the host-wide view. */
  projectDir?: string;
  /** Scope to a single run. */
  runId?: string;
  /** Scope to a single task (used by the dashboard task-detail view). */
  taskId?: string;
};

type RunningRow = { taskId: string; runId: string };

/** Find and classify every running, *containerized* task against container
 *  liveness + result presence. Read-only: pure SELECTs + external probes, no
 *  writes, no events.
 *
 *  "Containerized" is proven by a `container.started` event — session
 *  (orchestrator / forge design) and manual tasks run host-side and never launch
 *  a container, so probing `docker inspect` would always say "gone" and wrongly
 *  flag them (the same guard reconcile.ts uses). The probe is injectable so the
 *  classification logic is testable without docker; the SQL `EXISTS` guard means
 *  only running+containerized tasks are ever probed.
 *
 *  Returns ALL evaluated tasks (including `running`) so callers can map by
 *  taskId; filter on `classification` for the subset you care about. */
export function findReconcileCandidates(
  db: DatabaseInstance,
  opts: FindReconcileCandidatesOptions = {},
  probe: LivenessProbe = probeContainerLiveness,
  resultPresent: ResultProbe = defaultResultPresent
): ReconcileCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.run_id AS runId
       FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'running'
         AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.started')
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
    const { classification, reason } = classify(probe(`forge-${row.taskId}`), hasResult);
    return { taskId: row.taskId, runId: row.runId, classification, reason, hasResult };
  });
}
