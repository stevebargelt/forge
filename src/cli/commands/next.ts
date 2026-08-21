import type { Command } from "commander";
import { ensureForgeDirs, expandTildePath } from "../../util/paths.js";
import { getRun, setRunProjectDir } from "../../store/runs.js";
import { reconcileRun } from "../../v2/reconcile.js";
import { withRunLock, RunBusyError } from "../../util/run-lock.js";
import { validateCredsForNewRun } from "../../util/creds.js";
import { loadWorkflow } from "../../v2/loader.js";
import { runNext, type RunNextResult } from "../../v2/runNext.js";
import { formatRunFailure } from "../../v2/ready-queue.js";
import { resolveSeedGeneration, type SeedGeneration } from "../../v2/seed-generation.js";
import type { Workflow } from "../../v2/schema.js";
import { promoteLaunchObservations } from "../../store/launch-observations.js";
import { performAutomaticCleanup } from "./ops.js";

/** Best-effort terminal-run closeout. The sweep is never the point of `forge next`, so a
 *  cleanup problem never breaks the command that hosts it. */
function closeoutTerminalRun(o: { projectDir?: string; runId: string }): void {
  try { performAutomaticCleanup(o); } catch { /* the sweep is never the point of this command */ }
}

/** RF-5: run the wave, THEN close out — never before. The closeout MUST follow the wave that
 *  can make the run terminal; ordering it earlier (as next.ts:59 once did) means a run
 *  terminalized by THIS wave is left with its disposable Git artifacts un-reconciled at this
 *  wave boundary — and nothing re-runs `forge next` on a now-terminal run to converge them.
 *  Extracted with injectable deps so the ordering is directly testable. */
export async function runWaveThenCloseout(
  args: { runId: string; projectDir: string; workflow: Workflow; seedGeneration: SeedGeneration | null },
  deps: { runNext?: typeof runNext; closeout?: (o: { projectDir?: string; runId: string }) => void } = {},
): Promise<RunNextResult> {
  const runNextFn = deps.runNext ?? runNext;
  const closeout = deps.closeout ?? closeoutTerminalRun;
  const result = await runNextFn({ runId: args.runId, workflow: args.workflow, seedGeneration: args.seedGeneration });
  closeout({ projectDir: args.projectDir, runId: args.runId });
  return result;
}

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

          // RF-5: a run already terminal at entry is closed out here — nothing dispatches,
          // so this is the wave boundary that must converge its disposable Git artifacts
          // (and it is the crash-safe fixpoint if a prior wave's closeout was interrupted).
          // Best effort and swallowed: cleanup is never the point of `forge next`.
          if (run.status === "abandoned" || run.status === "complete" || run.status === "failed") {
            closeoutTerminalRun({ projectDir: run.projectDir ?? undefined, runId });
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
          // RF-5: dispatch the wave, THEN close out — the closeout follows the transition
          // that may make this run terminal, so a run terminalized by this very wave has its
          // disposable Git artifacts reconciled at this boundary rather than skipped.
          const result = await runWaveThenCloseout({ runId, projectDir, workflow, seedGeneration });

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
