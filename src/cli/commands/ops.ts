import type { Command } from "commander";
import { resolve } from "node:path";
import type { Incident } from "../../types/index.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { runOpsCheck } from "../../ops/detect.js";
import { performOpsRepair, type OpsRepairOutcome } from "../../ops/repair.js";
import type { LivenessProbe } from "../../ops/reconcile-candidate.js";
import { getTask } from "../../store/tasks.js";
import { acquireRunLock, releaseRunLock, RunBusyError } from "../../util/run-lock.js";

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
}
