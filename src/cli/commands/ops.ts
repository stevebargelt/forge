import type { Command } from "commander";
import { resolve } from "node:path";
import type { Incident } from "../../types/index.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { runOpsCheck } from "../../ops/detect.js";
import { performOpsRepair, type OpsRepairOutcome } from "../../ops/repair.js";
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
    .argument("<task-id>", "the orphaned task to repair")
    .option("--dry-run", "report what would change; write nothing")
    .option("--json", "emit JSON result")
    .description(
      "Repair a retry_orphan: mark a pending task stranded under a terminal run as failed (orphaned). Refuses anything that is not a genuine orphan."
    )
    .action((taskId: string, opts: { dryRun?: boolean; json?: boolean }) => {
      ensureForgeDirs();
      // Serialize the mutation against a concurrent next/gate/retry on the same
      // run (mirrors cancel/retry). dry-run writes nothing, so it takes no lock.
      const runId = getTask(taskId)?.runId;
      let outcome: OpsRepairOutcome;
      try {
        if (!opts.dryRun && runId) acquireRunLock(runId, "ops repair");
        try {
          outcome = performOpsRepair(taskId, { dryRun: opts.dryRun });
        } finally {
          if (!opts.dryRun && runId) releaseRunLock(runId);
        }
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
        process.stderr.write(`forge ops repair: unknown task '${taskId}'\n`);
        process.exit(1);
      }
      if (outcome.kind === "refused") {
        process.stderr.write(`forge ops repair: refused — ${outcome.reason}\n`);
        process.exit(1);
      }
      const verb = outcome.dryRun ? "(dry-run) would mark" : "Marked";
      console.log(`${verb} task ${outcome.taskId} failed (orphaned); run ${outcome.runId} left terminal/untouched.`);
      if (outcome.dryRun) console.log("No writes.");
    });
}
