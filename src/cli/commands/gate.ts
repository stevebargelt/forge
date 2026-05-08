import type { Command } from "commander";
import { gate, batchGate } from "../../spine/gate.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { getTask } from "../../store/tasks.js";
import { getRun } from "../../store/runs.js";

export function registerGate(program: Command): void {
  program
    .command("gate")
    .argument("<id>", "task id (single-task gate) or run id (batch gate, requires --all)")
    .argument("<decision>", "advance | reject | request-changes")
    .option("--rationale <text>", "human note attached to the decision")
    .option("--force", "override blocked_by_red or verdict-fail (single-task only)")
    .option("--all", "batch mode: <id> is a run id; gate every awaiting_gate task in the run")
    .option("--decided-by <who>", "name to record on the gate row", "steven")
    .description("Decide a gate on a task, or batch-decide every awaiting_gate task in a run with --all")
    .action(async (id: string, decision: string, options) => {
      if (decision !== "advance" && decision !== "reject" && decision !== "request-changes") {
        throw new Error(`Decision must be advance | reject | request-changes (got '${decision}')`);
      }
      ensureForgeDirs();

      if (options.all) {
        const r = await batchGate(id, decision, options.rationale, {
          decidedBy: options.decidedBy,
        });
        if (r.skippedBlocked.length > 0) {
          console.log(
            `Skipping ${r.skippedBlocked.length} blocked_by_red task(s) — gate those individually with --force --rationale "...":`
          );
          for (const s of r.skippedBlocked) console.log(`  ✗ ${s.taskId} (${s.phase})`);
        }
        if (r.gated.length === 0 && r.failed.length === 0) {
          console.log(`No tasks awaiting_gate in run ${id}.`);
          return;
        }
        console.log(`Batch ${decision}: ${r.gated.length} task(s) in run ${id}`);
        for (const g of r.gated) console.log(`  ✓ ${g.taskId}`);
        for (const f of r.failed) console.log(`  ✗ ${f.taskId} — ${f.error}`);
        const totalFollowups = r.gated.reduce((acc, g) => acc + g.followups, 0);
        console.log(
          `\nGated ${r.gated.length} task(s)${r.failed.length > 0 ? `, ${r.failed.length} failed` : ""}.`
        );
        if (totalFollowups > 0) {
          console.log(`${totalFollowups} follow-up task(s) created.`);
          console.log(`\nNext:\n  forge next ${id}`);
        }
        return;
      }

      // Single-task path. Disambiguate accidental run-id usage with a clearer error.
      if (!getTask(id) && getRun(id)) {
        throw new Error(
          `'${id}' is a run id, not a task id. Use --all to batch-gate every awaiting_gate task in the run.`
        );
      }

      const result = await gate(id, decision, options.rationale, {
        force: options.force,
        decidedBy: options.decidedBy,
      });
      console.log(`Gate ${decision}: ${id}`);
      if (result.nextTasks.length > 0) {
        console.log(`Created ${result.nextTasks.length} follow-up task(s):`);
        for (const t of result.nextTasks) console.log(`  - ${t.id} (${t.phase}/${t.agentRole})`);
        console.log(`\nNext:\n  forge next ${result.task.runId}`);
      }
    });
}
