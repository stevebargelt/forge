import type { Command } from "commander";
import { listRuns, getRun } from "../../store/runs.js";
import { tasksForRun } from "../../store/tasks.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { loadWorkflow } from "../../spine/workflows.js";
import { reconcileRun } from "../../spine/reconcile.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .argument("[run-id]", "show one run, or omit to list all")
    .description("Show run status. Always works against whatever has been built so far.")
    .action(async (runId?: string) => {
      ensureForgeDirs();
      if (!runId) {
        const runs = listRuns();
        if (runs.length === 0) {
          console.log("No runs yet. Try: forge new investigation \"my-question\" --question \"...\"");
          return;
        }
        for (const r of runs) {
          console.log(`${r.id}  [${r.status}]  ${r.workflow}  —  ${r.title}`);
        }
        return;
      }
      const run = getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      // Reconcile orphaned running tasks before reporting — keeps `status` honest
      // when an earlier `forge next` lost track of a docker child.
      try {
        const wf = await loadWorkflow(run.workflow);
        const reconciled = reconcileRun(runId, wf).filter((r) => r.resolution !== "still_running");
        if (reconciled.length > 0) {
          console.log(`(reconciled ${reconciled.length} orphaned task(s) before reporting)`);
        }
      } catch {
        // If the workflow can't load (deleted/renamed), skip reconciliation but still show status.
      }
      console.log(`Run: ${run.title}  (${run.id})`);
      console.log(`Workflow: ${run.workflow}`);
      console.log(`Status: ${run.status}`);
      console.log(`Created: ${run.createdAt}`);
      if (run.completedAt) console.log(`Completed: ${run.completedAt}`);
      console.log("");

      const tasks = tasksForRun(runId);
      const byPhase = new Map<string, typeof tasks>();
      for (const t of tasks) {
        const arr = byPhase.get(t.phase) ?? [];
        arr.push(t);
        byPhase.set(t.phase, arr);
      }
      for (const [phase, list] of byPhase) {
        console.log(`Phase: ${phase}`);
        for (const t of list) {
          const icon = statusIcon(t.status);
          let line = `  ${icon} ${t.id}  ${t.agentRole}  [${t.status}]`;
          const verdicts = verdictsForTask(t.id);
          if (verdicts.length > 0) {
            const summary = verdicts
              .map((v) => `${v.redRole}: ${v.verdict} (${v.confidence.toFixed(2)})`)
              .join("  ");
            line += `  — ${summary}`;
          }
          console.log(line);
        }
      }
    });
}

function statusIcon(s: string): string {
  switch (s) {
    case "complete": return "✓";
    case "running": return "⟳";
    case "awaiting_gate": return "⚠";
    case "blocked_by_red": return "✗";
    case "failed": return "☠";
    case "pending": return "○";
    default: return "?";
  }
}
