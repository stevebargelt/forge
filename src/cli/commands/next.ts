import type { Command } from "commander";
import { next } from "../../spine/next.js";
import { ensureForgeDirs } from "../../util/paths.js";

export function registerNext(program: Command): void {
  program
    .command("next")
    .argument("<run-id>", "run identifier")
    .option("--project <path>", "project directory to mount into agent containers", process.cwd())
    .description("Advance the run: dispatch pending tasks, or surface what's blocking progress")
    .action(async (runId: string, options) => {
      ensureForgeDirs();
      const result = await next(runId, { projectDir: options.project });
      switch (result.kind) {
        case "running":
          console.log(`Run ${runId}: ${result.tasks.length} task(s) running.`);
          for (const t of result.tasks) console.log(`  ⟳ ${t.id} (${t.phase}/${t.agentRole})`);
          break;
        case "awaiting_gate":
          console.log(`Run ${runId}: ${result.tasks.length} task(s) awaiting gate.`);
          for (const t of result.tasks) {
            console.log(`  ⚠ ${t.id} (${t.phase})  →  forge gate ${t.id} advance | reject | request-changes`);
          }
          break;
        case "blocked_by_red":
          console.log(`Run ${runId}: BLOCKED by red verdicts.`);
          for (const t of result.tasks) {
            console.log(`  ✗ ${t.id} (${t.phase})  →  forge show ${t.id}  to view findings`);
            console.log(`    override: forge gate ${t.id} advance --force --rationale "..."`);
          }
          break;
        case "crashed":
          console.log(`Run ${runId}: container crash detected.`);
          for (const t of result.tasks) console.log(`  ☠ ${t.id} (${t.phase}) — ${t.error}`);
          console.log(`Inspect ~/.forge/runs/${runId}/<task-id>/container.stderr.log`);
          break;
        case "dispatched":
          console.log(`Run ${runId}: dispatched phase ${result.phase} (${result.tasks.length} tasks).`);
          break;
        case "advanced":
          console.log(`Run ${runId}: advanced to phase ${result.phase} (${result.tasks.length} task(s) created).`);
          console.log(`Next: forge next ${runId}`);
          break;
        case "complete":
          console.log(`Run ${runId}: complete.`);
          break;
      }
    });
}
