import type { Command } from "commander";
import { listRuns, getRun } from "../../store/runs.js";
import { tasksForRun } from "../../store/tasks.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { getDb } from "../../store/db.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { loadWorkflow } from "../../spine/workflows.js";
import { reconcileRun } from "../../spine/reconcile.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .argument("[run-id]", "show one run, or omit to list all")
    .option("--read-only", "open the DB read-only (skips reconcile; never blocks a running `forge next`)")
    .option("--json", "emit structured JSON instead of human-readable text")
    .description("Show run status. Always works against whatever has been built so far.")
    .action(async (runId: string | undefined, opts: { readOnly?: boolean; json?: boolean }) => {
      ensureForgeDirs();
      if (opts.readOnly) getDb({ readOnly: true });

      if (!runId) {
        const runs = listRuns();
        if (opts.json) {
          console.log(JSON.stringify({ runs: runs.map((r) => ({
            id: r.id,
            title: r.title,
            workflow: r.workflow,
            status: r.status,
            createdAt: r.createdAt,
            completedAt: r.completedAt ?? null,
          })) }, null, 2));
          return;
        }
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

      if (!opts.readOnly) {
        try {
          const wf = await loadWorkflow(run.workflow);
          const reconciled = reconcileRun(runId, wf).filter((r) => r.resolution !== "still_running");
          if (!opts.json && reconciled.length > 0) {
            console.log(`(reconciled ${reconciled.length} orphaned task(s) before reporting)`);
          }
        } catch {
          // If the workflow can't load (deleted/renamed), skip reconciliation but still show status.
        }
      }

      const tasks = tasksForRun(runId);

      if (opts.json) {
        // Structured output for the orchestrator. One JSON object per call.
        // Stable schema: run + tasks (with verdicts inlined per task).
        const tasksJson = tasks.map((t) => ({
          id: t.id,
          phase: t.phase,
          agentRole: t.agentRole,
          status: t.status,
          parentTaskId: t.parentId ?? null,
          createdAt: t.createdAt,
          startedAt: t.startedAt ?? null,
          completedAt: t.completedAt ?? null,
          error: t.error ?? null,
          verdicts: verdictsForTask(t.id).map((v) => ({
            redRole: v.redRole,
            verdict: v.verdict,
            confidence: v.confidence,
            authority: v.authority,
            redTaskId: v.redTaskId,
          })),
        }));
        console.log(JSON.stringify({
          run: {
            id: run.id,
            title: run.title,
            workflow: run.workflow,
            status: run.status,
            createdAt: run.createdAt,
            completedAt: run.completedAt ?? null,
          },
          tasks: tasksJson,
        }, null, 2));
        return;
      }

      console.log(`Run: ${run.title}  (${run.id})`);
      console.log(`Workflow: ${run.workflow}`);
      console.log(`Status: ${run.status}`);
      console.log(`Created: ${run.createdAt}`);
      if (run.completedAt) console.log(`Completed: ${run.completedAt}`);
      console.log("");

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
    case "awaiting_human_input": return "▢";
    case "awaiting_red": return "⏵";
    case "blocked_by_red": return "✗";
    case "failed": return "☠";
    case "pending": return "○";
    default: return "?";
  }
}
