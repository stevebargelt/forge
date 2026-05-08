import type { Command } from "commander";
import { adviseRun } from "../../spine/advise.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { getRun } from "../../store/runs.js";
import { tasksForRun } from "../../store/tasks.js";

export function registerAdvise(program: Command): void {
  program
    .command("advise")
    .argument("<run-id>", "run identifier")
    .description("Print the recommended next command for a run")
    .action((runId: string) => {
      ensureForgeDirs();
      const run = getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      const tasks = tasksForRun(runId);
      const advice = adviseRun(run, tasks);

      console.log(advice.summary);
      if (advice.command) {
        console.log(`\n  ${advice.command}`);
      }
      if (advice.alternativeCommand) {
        console.log(`\nAlternatively:\n  ${advice.alternativeCommand}`);
      }
    });
}
