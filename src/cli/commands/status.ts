import type { Command } from "commander";
import { resolve } from "node:path";
import { listRuns, listRunsForWorkspace, getRun } from "../../store/runs.js";
import { tasksForRun } from "../../store/tasks.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { getDb } from "../../store/db.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { liveIdleCountdownForTask, formatIdleCountdown, orphanRecoveryMessage, describeContainerEvidence } from "./show.js";
import { reconcileRun, reconcileRuns } from "../../v2/reconcile.js";
import { eventsForTask } from "../../store/events.js";
import { failureKindFromEvents, getOrphanEvidenceFromEvents, getContainerCausalEvidenceFromEvents } from "../../v2/failure-kind.js";
import { taskHasPipelineFinalize } from "../../v2/run-kind.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .argument("[run-id]", "show one run, or omit to list all")
    .option("--read-only", "open the DB read-only")
    .option("--all", "show runs from every project + workspace on this host (default: filter to current workspace)")
    .option("--workspace <path>", "workspace to filter by (default: cwd). Ignored with --all.")
    .option("--json", "emit structured JSON instead of human-readable text")
    .description("Show run status. Filters to the current workspace by default; use --all for the cross-project view.")
    .action(async (runId: string | undefined, opts: { readOnly?: boolean; all?: boolean; workspace?: string; json?: boolean }) => {
      ensureForgeDirs();
      const reconcileEnabled = !opts.readOnly;
      if (opts.readOnly) getDb({ readOnly: true });

      // AWN-1: reconcile crash/Docker state before reporting (writable path only).
      // Scope it to EXACTLY the runs this command will display — a workspace-
      // scoped `forge status` must not reconcile (and mutate) other workspaces'
      // runs. The single-run path is already scoped.
      if (reconcileEnabled && runId) reconcileRun(runId);

      if (!runId) {
        // Default: filter to the current workspace. --all bypasses the filter
        // for the cross-project survey case (matches the dashboard behavior).
        const workspace = resolve(opts.workspace ?? process.cwd());
        const selectRuns = () => (opts.all ? listRuns() : listRunsForWorkspace(workspace));
        if (reconcileEnabled) {
          reconcileRuns(selectRuns().filter((r) => r.status === "active").map((r) => r.id));
        }
        // Re-read post-reconcile so the display reflects any state changes.
        const runs = selectRuns();
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
          if (opts.all) {
            console.log("No runs yet. Try: forge new feature \"my-feature\" --brief \"...\"");
          } else {
            console.log("No runs in this workspace. Use --all to see runs from other projects.");
          }
          return;
        }
        for (const r of runs) {
          console.log(`${r.id}  [${r.status}]  ${r.workflow}  —  ${r.title}`);
        }
        return;
      }

      const run = getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);

      const tasks = tasksForRun(runId);
      // FG-481: recover.ts's --continue now refuses unconditionally for a
      // pipeline-run task — thread that same signal into orphanRecoveryMessage
      // so `forge status` doesn't steer the operator toward a refused command.
      // FG-486: invoke_chain tasks have no finalize either — shared predicate.
      const runIsInvokeRun = !taskHasPipelineFinalize(run);

      if (opts.json) {
        // Structured output for the orchestrator. One JSON object per call.
        // Stable schema: run + tasks (with verdicts inlined per task).
        const tasksJson = tasks.map((t) => {
          // FG-455: orphaned_work_may_persist carries recovery evidence — surface
          // it here too, not just in `forge show`, so scripted/orchestrator
          // consumers of `forge status --json` see it without a second call.
          const events = eventsForTask(t.id);
          const taskFailureKind = t.status === "failed" ? failureKindFromEvents(events) : undefined;
          const orphanEvidence = t.status === "failed" ? getOrphanEvidenceFromEvents(events) : undefined;
          // FG-492: causal container evidence, same source `forge show` reads —
          // distinguishes a confirmed exit from a container that disappeared
          // with no terminal event, without asserting an unproven "killed" cause.
          const containerEvidence = t.status === "failed" ? getContainerCausalEvidenceFromEvents(events) : undefined;
          return {
            id: t.id,
            phase: t.phase,
            agentRole: t.agentRole,
            status: t.status,
            parentTaskId: t.parentId ?? null,
            createdAt: t.createdAt,
            startedAt: t.startedAt ?? null,
            completedAt: t.completedAt ?? null,
            error: t.error ?? null,
            failureKind: taskFailureKind ?? null,
            orphanRecovery: orphanEvidence
              ? { evidence: orphanEvidence, message: orphanRecoveryMessage(t.runId, t.id, orphanEvidence, taskFailureKind ?? "orphaned_work_may_persist", runIsInvokeRun) }
              : null,
            containerEvidence: containerEvidence
              ? { evidence: containerEvidence, message: describeContainerEvidence(containerEvidence) }
              : null,
            idleCountdown: liveIdleCountdownForTask(t) ?? null,
            verdicts: verdictsForTask(t.id).map((v) => ({
              redRole: v.redRole,
              verdict: v.verdict,
              confidence: v.confidence,
              authority: v.authority,
              redTaskId: v.redTaskId,
            })),
          };
        });
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
          const countdown = liveIdleCountdownForTask(t);
          if (countdown) line += `  — ${formatIdleCountdown(countdown)}`;
          const verdicts = verdictsForTask(t.id);
          if (verdicts.length > 0) {
            const summary = verdicts
              .map((v) => `${v.redRole}: ${v.verdict} (${v.confidence.toFixed(2)})`)
              .join("  ");
            line += `  — ${summary}`;
          }
          console.log(line);
          // FG-455: a generic ☠ icon doesn't distinguish "safe to retry" from
          // "the worktree may hold real work" — print the recovery message.
          if (t.status === "failed") {
            const events = eventsForTask(t.id);
            const orphanEvidence = getOrphanEvidenceFromEvents(events);
            if (orphanEvidence) {
              const kind = failureKindFromEvents(events) ?? "orphaned_work_may_persist";
              console.log(`      ${orphanRecoveryMessage(t.runId, t.id, orphanEvidence, kind, runIsInvokeRun)}`);
            }
            // FG-492: same causal-evidence line `forge show` prints — a confirmed
            // container exit vs. one that disappeared with no terminal event.
            const containerEvidence = getContainerCausalEvidenceFromEvents(events);
            if (containerEvidence) {
              console.log(`      container evidence: ${describeContainerEvidence(containerEvidence)}`);
            }
          }
        }
      }
    });
}

function statusIcon(s: string): string {
  switch (s) {
    case "complete": return "✓";
    case "running": return "⟳";
    case "awaiting_gate": return "⚠";
    case "awaiting_red": return "⏵";
    case "blocked_by_red": return "✗";
    case "failed": return "☠";
    case "pending": return "○";
    default: return "?";
  }
}
