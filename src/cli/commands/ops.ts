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
import { logEvent } from "../../store/events.js";
import { defaultContainerReap, defaultContainerList, type ContainerReap, type ContainerLister } from "../../v2/reconcile.js";

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
};

type ReapCandidateSource = "failed_retained" | "completed_leak";
type TaskLookupRow = { status: string; completedAt: string | null; projectDir: string | null; runId: string };

export function performOpsReapContainers(
  opts: { dryRun?: boolean; olderThanMinutes?: number; projectDir?: string } = {},
  reap: ContainerReap = defaultContainerReap,
  listContainers: ContainerLister = defaultContainerList,
): ReapContainersOutcome {
  const containers = listContainers();
  if (containers === undefined) {
    return { dryRun: !!opts.dryRun, scanned: 0, reaped: [], retained: [], errors: [], completedTaskLeaks: [], completedTaskLeaksUnconfirmed: [], dockerUnavailable: true };
  }

  const db = getDb({ readOnly: true });
  const lookupTask = db.prepare(
    `SELECT t.status AS status, t.completed_at AS completedAt, r.project_dir AS projectDir, t.run_id AS runId
     FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?`
  );

  const cutoffMs = opts.olderThanMinutes !== undefined ? Date.now() - opts.olderThanMinutes * 60_000 : undefined;
  const reaped: string[] = [];
  const retained: string[] = [];
  const errors: string[] = [];
  const completedTaskLeaks: string[] = [];
  const completedTaskLeaksUnconfirmed: string[] = [];
  let scanned = 0;

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

    if (cutoffMs !== undefined) {
      // Disk truth (the container's own finishedAt) is preferred for the age
      // check; the task's completedAt is the fallback when docker couldn't
      // confirm it (still a valid signal — for the crash-window leak this
      // fix targets, markTaskComplete already ran before the process died).
      const anchor = container.finishedAt ?? row.completedAt;
      const ageMs = anchor ? new Date(anchor).getTime() : undefined;
      if (ageMs === undefined || ageMs > cutoffMs) {
        retained.push(containerName);
        continue;
      }
    }

    if (opts.dryRun) {
      reaped.push(containerName);
      if (source === "completed_leak") completedTaskLeaks.push(containerName);
      continue;
    }
    // "not_found" (already gone — e.g. FORGE_CONTAINER_RETENTION=off never kept
    // it, or a prior sweep already reaped it since we listed it) is equally
    // "nothing left behind" as "killed" — both count as reaped from this
    // command's perspective. For a completed-task candidate specifically,
    // "not_found" also means it was never actually a leak — excluded from
    // completedTaskLeaks accordingly.
    const outcome = reap(containerName);
    if (outcome === "error") {
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
      logEvent("container.reaped", { runId: row.runId, taskId, payload: { containerName, outcome } });
    }
  }
  return { dryRun: !!opts.dryRun, scanned, reaped, retained, errors, completedTaskLeaks, completedTaskLeaksUnconfirmed, dockerUnavailable: false };
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
      if (outcome.completedTaskLeaks.length > 0) console.log(`  leaked from a SUCCESSFUL task (explicit cleanup failed, now swept): ${outcome.completedTaskLeaks.join(", ")}`);
      // FG-504: the reap attempt errored — NOT confirmed gone, so this must
      // never share the "now swept" line above.
      if (outcome.completedTaskLeaksUnconfirmed.length > 0) console.log(`  leaked from a SUCCESSFUL task (explicit cleanup failed, NOT confirmed gone — left for a later sweep): ${outcome.completedTaskLeaksUnconfirmed.join(", ")}`);
      if (outcome.dryRun) console.log("No writes.");
    });
}
