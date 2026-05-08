import type { Command } from "commander";
import { submit } from "../../spine/submit.js";
import { ensureForgeDirs } from "../../util/paths.js";

export function registerSubmit(program: Command): void {
  program
    .command("submit")
    .argument("<task-id>", "task id (must be in status awaiting_human_input)")
    .option("--notes <text>", "optional notes captured into the task result")
    .description("Submit human-produced artifacts; transitions an awaiting_human_input task to awaiting_gate (FORGE-DEC-016)")
    .action(async (taskId: string, options: { notes?: string }) => {
      ensureForgeDirs();
      const out = await submit(taskId, { notes: options.notes });
      console.log(`Submitted: ${taskId}`);
      console.log(`  .pen:  ${out.result.penFile}`);
      console.log(`  pngs:  ${out.result.pngFiles.length} file(s) in <designDir>/designs/`);
      console.log(`  html:  ${out.result.htmlFiles.length} file(s) in <designDir>/code/`);
      if (out.result.notes) console.log(`  notes: ${out.result.notes}`);
      console.log(`\nNext:\n  forge gate ${taskId} advance`);
      console.log(`  forge gate ${taskId} reject --rationale "..."`);
    });
}
