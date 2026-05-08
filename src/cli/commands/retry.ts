import type { Command } from "commander";
import { retry } from "../../spine/retry.js";
import { ensureForgeDirs } from "../../util/paths.js";

export function registerRetry(program: Command): void {
  program
    .command("retry")
    .argument("<task-id>", "task id (must be in status failed)")
    .description("Reset a failed task back to pending so `forge next` redispatches it")
    .action(async (taskId: string) => {
      ensureForgeDirs();
      const out = await retry(taskId);
      console.log(`Reset: ${taskId}`);
      console.log(`  status: ${out.task.status}`);
      console.log(`\nNext:\n  forge next ${out.task.runId}`);
    });
}
