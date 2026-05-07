import type { Command } from "commander";
import { gate } from "../../spine/gate.js";
import { ensureForgeDirs } from "../../util/paths.js";

export function registerGate(program: Command): void {
  program
    .command("gate")
    .argument("<task-id>", "task identifier")
    .argument("<decision>", "advance | reject | request-changes")
    .option("--rationale <text>", "human note attached to the decision")
    .option("--force", "override blocked_by_red or verdict-fail")
    .option("--decided-by <who>", "name to record on the gate row", "steven")
    .description("Decide a gate on a task")
    .action(async (taskId: string, decision: string, options) => {
      if (decision !== "advance" && decision !== "reject" && decision !== "request-changes") {
        throw new Error(`Decision must be advance | reject | request-changes (got '${decision}')`);
      }
      ensureForgeDirs();
      const result = await gate(taskId, decision, options.rationale, {
        force: options.force,
        decidedBy: options.decidedBy,
      });
      console.log(`Gate ${decision}: ${taskId}`);
      if (result.nextTasks.length > 0) {
        console.log(`Created ${result.nextTasks.length} follow-up task(s):`);
        for (const t of result.nextTasks) console.log(`  - ${t.id} (${t.phase}/${t.agentRole})`);
        console.log(`\nNext:\n  forge next ${result.task.runId} --project <path>`);
      }
    });
}
