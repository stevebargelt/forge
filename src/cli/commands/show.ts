import type { Command } from "commander";
import { getTask } from "../../store/tasks.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { ensureForgeDirs } from "../../util/paths.js";

export function registerShow(program: Command): void {
  program
    .command("show")
    .argument("<task-id>", "task identifier")
    .description("Show full details of a task: package, result, verdicts")
    .action((taskId: string) => {
      ensureForgeDirs();
      const t = getTask(taskId);
      if (!t) throw new Error(`Task not found: ${taskId}`);
      console.log(`Task ${t.id}`);
      console.log(`  run:    ${t.runId}`);
      console.log(`  phase:  ${t.phase} (${t.agentRole})`);
      console.log(`  status: ${t.status}`);
      console.log(`  parent: ${t.parentId ?? "(none)"}`);
      console.log(`  created: ${t.createdAt}`);
      if (t.startedAt) console.log(`  started: ${t.startedAt}`);
      if (t.completedAt) console.log(`  completed: ${t.completedAt}`);
      if (t.error) console.log(`  error:   ${t.error}`);
      console.log("");
      console.log("Inputs:");
      console.log(JSON.stringify(t.taskPackage.inputs, null, 2));
      if (t.result) {
        console.log("");
        console.log("Result:");
        console.log(JSON.stringify(t.result, null, 2));
      }
      const verdicts = verdictsForTask(t.id);
      if (verdicts.length > 0) {
        console.log("");
        console.log("Verdicts:");
        for (const v of verdicts) {
          console.log(
            `  - ${v.redRole} (${v.authority}): ${v.verdict} (${v.confidence.toFixed(2)})`
          );
          for (const f of v.findings) {
            console.log(`      [${f.severity}] ${f.summary}`);
          }
        }
      }
    });
}
