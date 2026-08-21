import type { Command } from "commander";
import { ensureForgeDirs, expandTildePath } from "../../util/paths.js";
import { getRun, setRunProjectDir } from "../../store/runs.js";
import { reconcileRun } from "../../v2/reconcile.js";
import { withRunLock, RunBusyError } from "../../util/run-lock.js";
import { validateCredsForNewRun } from "../../util/creds.js";
import { loadWorkflow } from "../../v2/loader.js";
import { runNext, type RunNextResult } from "../../v2/runNext.js";
import { formatRunFailure } from "../../v2/ready-queue.js";
import { resolveSeedGeneration } from "../../v2/seed-generation.js";
import { promoteLaunchObservations } from "../../store/launch-observations.js";
import { performAutomaticCleanup } from "./ops.js";

// FG-585: a truthful one-line failure detail for `forge next` — names the
// phase(s) that failed and the phase(s) that could never dispatch as a result.
function runFailureDetail(result: RunNextResult): string {
  return result.terminal
    ? formatRunFailure(result.terminal)
    : "a required phase failed and downstream phase(s) never ran";
}

export function registerNext(program: Command): void {
  program
    .command("next")
    .argument("<run-id>", "run identifier")
    .option("--project <path>", "project directory to mount into agent containers (persisted on first use; reused on subsequent calls)")
    .description("Dispatch one wave of ready steps in the run. Re-run to advance further.")
    .action(async (runId: string, options) => {
      ensureForgeDirs();
      // FG-679 (BD-16): promote any launch whose exit record has landed on disk into
      // the observation store. Opportunistic and best-effort — no daemon, no resident
      // observer, and never fatal to the command that hosts it. Mirrors the
      // publication reconcile sweep at the top of every wave.
      try { promoteLaunchObservations(); } catch { /* the sweep is never the point of this command */ }
      validateCredsForNewRun();

      // AWN-2: serialize dispatch per run — a second concurrent `forge next` on
      // the same run must not double-dispatch it. The lock is held across the
      // whole wave (reconcile + spawn); a dead/stuck holder is stolen.
      try {
        await withRunLock(runId, "next", async () => {
          // AWN-1: reconcile crash/Docker state before dispatching, so a stuck
          // "running" task (container gone) is finalized rather than blocking next.
          reconcileRun(runId);

          const run = getRun(runId);
          if (!run) throw new Error(`Run not found: ${runId}`);

          // FG-590: retire terminal launch tmux sessions and expired retained task
          // containers at the wave boundary — the daemon-free cleanup mechanism. Best
          // effort and swallowed exactly like the promotion sweep above: cleanup is never
          // the point of `forge next`, and it never removes a running or non-terminal
          // resource (its destroy chokepoints re-probe liveness). Scoped to this run's
          // project for containers; the launch sweep is host-global (launches are host
          // resources) and only ever removes past-retention terminal launches.
          try { performAutomaticCleanup({ projectDir: run.projectDir ?? undefined }); } catch { /* the sweep is never the point of this command */ }

          if (run.status === "abandoned" || run.status === "complete" || run.status === "failed") {
            console.log(`Run ${runId} is ${run.status} — cannot dispatch.`);
            return;
          }

          const projectDir = resolveProjectDir(runId, options.project as string | undefined);

          // FG-583: anchor the seed generation ONCE at dispatch entry (physical
          // realpath) and thread it through the wave, so every load reads the SAME
          // complete generation even if a promotion swaps the pointer mid-wave. When no
          // complete generation is published, loadWorkflow below refuses at the loader's
          // single resolve point (no per-consumer gating) — the wave never dispatches
          // under a mixed/incomplete/flat surface.
          const seedGeneration = resolveSeedGeneration();
          const workflow = loadWorkflow(run.workflow, { projectDir, seedGeneration });
          const result = await runNext({ runId, workflow, seedGeneration });

          if (result.dispatchedSteps.length === 0) {
            console.log(`Run ${runId}: nothing ready to dispatch.`);
            if (result.runStatus === "complete") {
              console.log(`Run is complete.`);
            } else if (result.runStatus === "failed") {
              console.log(`Run failed — ${runFailureDetail(result)}`);
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
          // FG-425 (AC5): reported apart from failures, and worded so nobody reads it
          // as one. The candidate may already be on the target; a retry here is the
          // duplicate-publication path.
          if (result.awaitingRecovery.length > 0) {
            console.log(
              `  ⧗ awaiting publication recovery: ${result.awaitingRecovery.join(", ")}\n` +
                `    Their ref advance LANDED and the publication window was lost — the target may already carry the\n` +
                `    candidate. Do NOT retry them. Re-run 'forge next ${runId}' to converge (AD-5) and reconcile.`,
            );
          }
          if (result.runStatus === "complete") {
            console.log(`\nRun complete.`);
          } else if (result.runStatus === "failed") {
            console.log(`\nRun failed — ${runFailureDetail(result)}`);
          } else {
            console.log(`\nStatus: ${result.runStatus}.`);
            console.log(`Next:\n  forge next ${runId}`);
          }
        });
      } catch (e) {
        if (e instanceof RunBusyError) {
          console.error(`forge next: ${e.message}`);
          console.error(`Another forge command is advancing this run. Wait for it, or 'forge cancel ${runId}' to stop it.`);
          process.exitCode = 1;
          return;
        }
        throw e;
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
