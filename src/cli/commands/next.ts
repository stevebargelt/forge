import type { Command } from "commander";
import { ensureForgeDirs, expandTildePath } from "../../util/paths.js";
import { getRun, setRunProjectDir } from "../../store/runs.js";
import { reconcileRun } from "../../v2/reconcile.js";
import { validateCredsForNewRun } from "../../util/creds.js";
import { loadWorkflow } from "../../v2/loader.js";
import { runNext } from "../../v2/runNext.js";

export function registerNext(program: Command): void {
  program
    .command("next")
    .argument("<run-id>", "run identifier")
    .option("--project <path>", "project directory to mount into agent containers (persisted on first use; reused on subsequent calls)")
    .description("Dispatch one wave of ready steps in the run. Re-run to advance further.")
    .action(async (runId: string, options) => {
      ensureForgeDirs();
      validateCredsForNewRun();

      // AWN-1: reconcile crash/Docker state before dispatching, so a stuck
      // "running" task (container gone) is finalized rather than blocking next.
      reconcileRun(runId);

      const run = getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);

      if (run.status === "abandoned" || run.status === "complete") {
        console.log(`Run ${runId} is ${run.status} — cannot dispatch.`);
        return;
      }

      const projectDir = resolveProjectDir(runId, options.project as string | undefined);

      const workflow = loadWorkflow(run.workflow, { projectDir });
      const result = await runNext({ runId, workflow });

      if (result.dispatchedSteps.length === 0) {
        console.log(`Run ${runId}: nothing ready to dispatch.`);
        if (result.runStatus === "complete") {
          console.log(`Run is complete.`);
        } else {
          console.log(`Status: ${result.runStatus}.`);
          console.log(`Use 'forge status ${runId}' to see what's blocked.`);
        }
        return;
      }

      console.log(`Run ${runId}: wave dispatched.`);
      if (result.completedSteps.length > 0) {
        console.log(`  ✓ completed: ${result.completedSteps.join(", ")}`);
      }
      if (result.awaitingGate.length > 0) {
        console.log(`  ⚠ awaiting gate: ${result.awaitingGate.join(", ")}`);
      }
      if (result.failedSteps.length > 0) {
        console.log(`  ✗ failed: ${result.failedSteps.join(", ")}`);
      }
      if (result.runStatus === "complete") {
        console.log(`\nRun complete.`);
      } else {
        console.log(`\nStatus: ${result.runStatus}.`);
        console.log(`Next:\n  forge next ${runId}`);
      }
    });
}

function resolveProjectDir(runId: string, explicit: string | undefined): string {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (explicit) {
    const expanded = expandTildePath(explicit);
    const prev = setRunProjectDir(runId, expanded);
    if (prev && prev !== expanded) {
      console.error(`[forge] project_dir changed for ${runId}: ${prev} → ${expanded}`);
    }
    return expanded;
  }
  if (run.projectDir) return run.projectDir;
  const cwd = process.cwd();
  setRunProjectDir(runId, cwd);
  console.error(`[forge] no --project supplied; persisting cwd as project_dir: ${cwd}`);
  return cwd;
}
