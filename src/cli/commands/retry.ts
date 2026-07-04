import type { Command } from "commander";
import { retry, RetryNotAllowedError, FanoutChildRetryError } from "../../v2/retry.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { getTask } from "../../store/tasks.js";
import { withRunLock, RunBusyError } from "../../util/run-lock.js";

export function registerRetry(program: Command): void {
  program
    .command("retry")
    .argument("<task-id>", "task id (must be in status failed)")
    .option("--force", "retry even a non-retryable failure kind (e.g. gate_rejected, red_blocked)")
    .description("Reset a failed task back to pending so `forge next` redispatches it")
    .action(async (taskId: string, options: { force?: boolean }) => {
      ensureForgeDirs();
      // AWN-2: serialize retry per run so it can't race a concurrent next/gate
      // and attach to stale/half-finalized task state.
      const runId = getTask(taskId)?.runId ?? taskId;
      try {
        await withRunLock(runId, "retry", async () => {
          const out = await retry(taskId, { force: options.force });
          const kind = out.failureKind ? ` [${out.failureKind}]` : "";
          console.log(`Retried ${taskId}${kind} (kept as failed for audit)`);
          console.log(`  ${out.disposition.reason}.`);
          if (out.disposition.advice) console.log(`  note: ${out.disposition.advice}.`);
          console.log(`  new task: ${out.newTask.id} (pending, lineage → ${taskId})`);
          console.log(`\nNext:\n  forge next ${out.newTask.runId}`);
        });
      } catch (e) {
        if (e instanceof RetryNotAllowedError) {
          console.error(`forge retry: ${e.message}`);
          if (e.disposition.advice) console.error(`  ${e.disposition.advice}.`);
          process.exitCode = 1;
          return;
        }
        if (e instanceof FanoutChildRetryError) {
          console.error(`forge retry: ${e.message}`);
          process.exitCode = 1;
          return;
        }
        if (e instanceof RunBusyError) {
          console.error(`forge retry: ${e.message}`);
          console.error(`Another forge command is mutating this run. Wait for it to finish.`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    });
}
