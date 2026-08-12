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
import { logEvent } from "../../store/events.js";
import { defaultContainerReap, defaultContainerList, type ContainerReap, type ContainerLister } from "../../v2/reconcile.js";
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
    return { dryRun: !!opts.dryRun, scanned: 0, reaped: [], retained: [], errors: [], completedTaskLeaks: [], completedTaskLeaksUnconfirmed: [], absenceHealed: [], resolutionWriteErrors: [], dockerUnavailable: true };
  }

  // No store means no forge task can own any of these containers; the reap has
  // nothing it may act on and must not open (or create) a store to say so.
  if (!storeExists()) {
    return { dryRun: !!opts.dryRun, scanned: containers.length, reaped: [], retained: [], errors: [], completedTaskLeaks: [], completedTaskLeaksUnconfirmed: [], absenceHealed: [], resolutionWriteErrors: [], dockerUnavailable: false };
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
  const absenceHealed: string[] = [];
  const resolutionWriteErrors: string[] = [];
  let scanned = 0;

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

  return { dryRun: !!opts.dryRun, scanned, reaped, retained, errors, completedTaskLeaks, completedTaskLeaksUnconfirmed, absenceHealed, resolutionWriteErrors, dockerUnavailable: false };
}

export function registerOps(program: Command): void {
  const ops = program.command("ops").description("Operational intelligence over the forge blackboard.");

  ops
    .command("check")
    .option("--json", "emit structured incidents as JSON")
    .option("--all", "check every project on this host (default: scope to the current directory's project)")
    .option("--project <dir>", "scope to a specific project dir (default: cwd). Ignored with --all.")
    .description(
      "Detect 'needs attention' incidents from existing state. The default (human) output also pushes one " +
        "notification per NEW live incident, recording orchestrator.milestone events (deduped on incident identity). " +
        "Use --json for a read-only, side-effect-free scan."
    )
    .action(async (opts: { json?: boolean; all?: boolean; project?: string }) => {
      ensureForgeDirs();
      if (renderedEmptyStore(opts.json, [], "No forge store on this host yet — no incidents to report.")) return;
      const projectDir = opts.all ? undefined : resolve(opts.project ?? process.cwd());
      const incidents = runOpsCheck({ projectDir });

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
      if (outcome.dryRun) console.log("No writes.");
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
    .option("--identity <sha>", "the incident identity you inspected (from a prior check); the write refuses on drift")
    .option("--project <dir>", "scope to a specific project dir (default: cwd)")
    .option("--json", "emit JSON result")
    .description(
      "Retire ONE orphaned_work_may_persist ops incident (outcome no_unique_work) from the active high-severity " +
        "report, preserving the failed task, failed run, detector evidence, rationale, actor and timestamp as durable " +
        "audit history. Append-only: it changes NO task, run, or result state. Fails closed (non-zero, naming the fact) " +
        "for an unknown incident, an unsupported kind, an unsupported outcome, a missing rationale, a project mismatch, " +
        "or an incident whose current identity no longer matches the record you inspected."
    )
    .action((taskId: string, opts: { rationale: string; outcome: string; actor?: string; identity?: string; project?: string; json?: boolean }) => {
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
