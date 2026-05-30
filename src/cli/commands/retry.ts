import type { Command } from "commander";
import { retry } from "../../v2/retry.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { getTask } from "../../store/tasks.js";
import { withRunLock, RunBusyError } from "../../util/run-lock.js";

export function registerRetry(program: Command): void {
  program
    .command("retry")
    .argument("<task-id>", "task id (must be in status failed)")
    .description("Reset a failed task back to pending so `forge next` redispatches it")
    .action(async (taskId: string) => {
      ensureForgeDirs();
      // AWN-2: serialize retry per run so it can't race a concurrent next/gate
      // and attach to stale/half-finalized task state.
      const runId = getTask(taskId)?.runId ?? taskId;
      try {
        await withRunLock(runId, "retry", async () => {
          const out = await retry(taskId);
          console.log(`Retried ${taskId} (kept as failed for audit)`);
          console.log(`  new task: ${out.newTask.id} (pending)`);
          console.log(`\nNext:\n  forge next ${out.newTask.runId}`);
        });
      } catch (e) {
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
