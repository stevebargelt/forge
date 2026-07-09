import type { Command } from "commander";
import { resolve } from "node:path";
import type { Incident } from "../../types/index.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { runOpsCheck } from "../../ops/detect.js";
import { performOpsRepair, type OpsRepairOutcome } from "../../ops/repair.js";
import type { LivenessProbe } from "../../ops/reconcile-candidate.js";
import { getTask } from "../../store/tasks.js";
import { acquireRunLock, releaseRunLock, RunBusyError } from "../../util/run-lock.js";
import { getDb } from "../../store/db.js";
import { defaultContainerReap, type ContainerReap } from "../../v2/reconcile.js";

// `forge ops check` — read-only incident detection over the blackboard (#250).
// The orchestrator runs `--json` and decides what to act on or surface; humans
// get the plain rendering. This command NEVER mutates state.

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
// useful. Read-only by construction over the DB (only ever queries FAILED
// tasks that actually launched one — a `container.started` event is required,
// the same guard reconcile.ts/reconcile-candidate.ts use — so fanout parents
// and host-side/manual dispatch, which structurally never had a container,
// are never scanned or counted as "reaped"; a `running` task's container is
// never a candidate either), and the removal itself is best-effort via the
// same defaultContainerReap reconcile.ts already uses (never throws; "error"
// means NOT confirmed gone, left alone for a later sweep). --dry-run reports
// without touching anything.
//
// FG-503: also scans COMPLETED (successful) tasks whose explicit cleanup at
// close time failed — the `container.reap_failed` event docker-exec.ts's
// callers now emit (see invoke.ts/runNext.ts/gate.ts) — so a leaked container
// on a task that otherwise SUCCEEDED is sweepable by age too, instead of
// sitting forever with no reap candidate (the original bug: only 'failed'
// tasks were ever scanned). Requiring the reap_failed event (rather than
// scanning every completed task) keeps the scan cheap and targeted, and means
// a `not_found` reap result here is never mistaken for a leak — it just means
// a later sweep or manual cleanup already removed it since the event fired.
export type ReapContainersOutcome = {
  dryRun: boolean;
  scanned: number;
  reaped: string[];
  retained: string[]; // still within --older-than-minutes, left alone
  errors: string[]; // docker reap attempt failed — NOT confirmed gone
  // FG-503: subset of reaped/errors that came from the completed-task
  // container.reap_failed scan, not the ordinary retained-on-failure scan —
  // surfaced separately so a leak on an otherwise-successful task is
  // operator-visible rather than folded silently into the normal reap count.
  completedTaskLeaks: string[];
};

type ReapCandidateRow = { taskId: string; completedAt: string | null; source: "failed_retained" | "completed_leak" };

export function performOpsReapContainers(
  opts: { dryRun?: boolean; olderThanMinutes?: number; projectDir?: string } = {},
  reap: ContainerReap = defaultContainerReap,
): ReapContainersOutcome {
  const db = getDb({ readOnly: true });
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.completed_at AS completedAt, 'failed_retained' AS source
       FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'failed'
         AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.started')
         AND (? IS NULL OR r.project_dir = ?)
       UNION ALL
       SELECT t.id AS taskId, t.completed_at AS completedAt, 'completed_leak' AS source
       FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.status = 'complete'
         AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.started')
         AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'container.reap_failed')
         AND (? IS NULL OR r.project_dir = ?)`
    )
    .all(opts.projectDir ?? null, opts.projectDir ?? null, opts.projectDir ?? null, opts.projectDir ?? null) as ReapCandidateRow[];

  const cutoffMs = opts.olderThanMinutes !== undefined ? Date.now() - opts.olderThanMinutes * 60_000 : undefined;
  const reaped: string[] = [];
  const retained: string[] = [];
  const errors: string[] = [];
  const completedTaskLeaks: string[] = [];
  for (const row of rows) {
    const containerName = `forge-${row.taskId}`;
    if (cutoffMs !== undefined) {
      const completedMs = row.completedAt ? new Date(row.completedAt).getTime() : undefined;
      if (completedMs === undefined || completedMs > cutoffMs) {
        retained.push(containerName);
        continue;
      }
    }
    if (opts.dryRun) {
      reaped.push(containerName);
      if (row.source === "completed_leak") completedTaskLeaks.push(containerName);
      continue;
    }
    // "not_found" (already gone — e.g. FORGE_CONTAINER_RETENTION=off never kept
    // it, or a prior sweep already reaped it) is equally "nothing left behind"
    // as "killed" — both count as reaped from this command's perspective. For
    // a completed-task candidate specifically, "not_found" also means it was
    // never actually a leak (see FG-503 comment above) — excluded from
    // completedTaskLeaks accordingly.
    const outcome = reap(containerName);
    if (outcome === "error") {
      errors.push(containerName);
      if (row.source === "completed_leak") completedTaskLeaks.push(containerName);
    } else {
      reaped.push(containerName);
      if (outcome === "killed" && row.source === "completed_leak") completedTaskLeaks.push(containerName);
    }
  }
  return { dryRun: !!opts.dryRun, scanned: rows.length, reaped, retained, errors, completedTaskLeaks };
}

export function registerOps(program: Command): void {
  const ops = program.command("ops").description("Operational intelligence over the forge blackboard (read-only).");

  ops
    .command("check")
    .option("--json", "emit structured incidents as JSON")
    .option("--all", "check every project on this host (default: scope to the current directory's project)")
    .option("--project <dir>", "scope to a specific project dir (default: cwd). Ignored with --all.")
    .description("Detect 'needs attention' incidents from existing state. Read-only — never mutates.")
    .action((opts: { json?: boolean; all?: boolean; project?: string }) => {
      ensureForgeDirs();
      const projectDir = opts.all ? undefined : resolve(opts.project ?? process.cwd());
      const incidents = runOpsCheck({ projectDir });

      if (opts.json) {
        console.log(JSON.stringify(incidents, null, 2));
        return;
      }
      console.log(renderHuman(incidents));
    });

  ops
    .command("repair")
    .argument("<id>", "the orphaned task id (retry_orphan) or stuck run id (stuck_run) to repair")
    .option("--dry-run", "report what would change; write nothing")
    .option("--json", "emit JSON result")
    .description(
      "Repair a retry_orphan (pending task stranded under a terminal run → marked failed) or a stuck_run " +
        "(active run whose tasks are all terminal → marked abandoned). Refuses anything that is not a genuine orphan."
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
      "Remove forge-<taskId> containers retained on failure (FG-492's FORGE_CONTAINER_RETENTION policy), plus any successful task whose own cleanup failed (FG-503), once their diagnostic value has passed. Never touches a running task's container."
    )
    .action((opts: { dryRun?: boolean; olderThanMinutes?: number; all?: boolean; project?: string; json?: boolean }) => {
      ensureForgeDirs();
      const projectDir = opts.all ? undefined : resolve(opts.project ?? process.cwd());
      const outcome = performOpsReapContainers({ dryRun: opts.dryRun, olderThanMinutes: opts.olderThanMinutes, projectDir });

      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }

      const verb = outcome.dryRun ? "(dry-run) would reap" : "Reaped";
      console.log(`${verb} ${outcome.reaped.length}/${outcome.scanned} retained container(s).`);
      if (outcome.retained.length > 0) console.log(`  still within retention window: ${outcome.retained.join(", ")}`);
      if (outcome.errors.length > 0) console.log(`  reap failed (not confirmed gone — left for a later sweep): ${outcome.errors.join(", ")}`);
      // FG-503: call out leaks on otherwise-SUCCESSFUL tasks distinctly — the
      // condition FG-503 exists to make visible instead of silent.
      if (outcome.completedTaskLeaks.length > 0) console.log(`  leaked from a SUCCESSFUL task (explicit cleanup failed, now swept): ${outcome.completedTaskLeaks.join(", ")}`);
      if (outcome.dryRun) console.log("No writes.");
    });
}
