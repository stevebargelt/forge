import type { Command } from "commander";
import { getTask, tasksForRun } from "../../store/tasks.js";
import { failTask, classify } from "../../v2/failure-kind.js";
import { getRun, updateRunStatus } from "../../store/runs.js";
import { killContainer } from "../../v2/docker-exec.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { logEvent } from "../../store/events.js";
import type { Task } from "../../types/index.js";

const TERMINAL = new Set(["complete", "failed"]);

function isTerminal(t: Task): boolean {
  return TERMINAL.has(t.status);
}

export type KillFn = (containerName: string) => void;

export type CancelOpts = { dryRun?: boolean; json?: boolean };

export type CancelOutcome =
  | { kind: "task-terminal"; taskId: string; runId: string; status: string }
  | { kind: "task-cancelled"; taskId: string; runId: string; killed: boolean; runAbandoned: boolean }
  | { kind: "run-cancelled"; runId: string; tasksKilled: string[] }
  | { kind: "run-terminal"; runId: string; status: string }
  | { kind: "unknown"; id: string };

export function performCancel(
  id: string,
  opts: CancelOpts,
  killFn: KillFn = (name) => killContainer(name),
): CancelOutcome {
  const task = getTask(id);
  if (task) {
    if (isTerminal(task)) {
      return { kind: "task-terminal", taskId: task.id, runId: task.runId, status: task.status };
    }

    let runAbandoned = false;
    if (!opts.dryRun) {
      killFn(`forge-${task.id}`);
      failTask(task.id, { runId: task.runId, kind: classify({ source: "cancelled" }), error: "cancelled via forge cancel" });
      logEvent("task.cancelled", { runId: task.runId, taskId: task.id, payload: { via: "forge cancel" } });
      const remaining = tasksForRun(task.runId).filter((t) => !isTerminal(t));
      if (remaining.length === 0) {
        updateRunStatus(task.runId, "abandoned");
        logEvent("run.cancelled", { runId: task.runId, payload: { via: "forge cancel" } });
        logEvent("run.abandoned", { runId: task.runId, payload: { via: "forge cancel" } });
        runAbandoned = true;
      }
    } else {
      const others = tasksForRun(task.runId).filter((t) => t.id !== task.id && !isTerminal(t));
      runAbandoned = others.length === 0;
    }

    return { kind: "task-cancelled", taskId: task.id, runId: task.runId, killed: !opts.dryRun, runAbandoned };
  }

  const run = getRun(id);
  if (run) {
    if (run.status === "complete" || run.status === "abandoned") {
      return { kind: "run-terminal", runId: run.id, status: run.status };
    }
    const tasks = tasksForRun(run.id);
    const nonTerminal = tasks.filter((t) => !isTerminal(t));
    if (!opts.dryRun) {
      for (const t of nonTerminal) {
        killFn(`forge-${t.id}`);
        failTask(t.id, { runId: run.id, kind: classify({ source: "cancelled" }), error: "cancelled via forge cancel" });
        logEvent("task.cancelled", { runId: run.id, taskId: t.id, payload: { via: "forge cancel" } });
      }
      updateRunStatus(run.id, "abandoned");
      logEvent("run.cancelled", { runId: run.id, payload: { via: "forge cancel" } });
      logEvent("run.abandoned", { runId: run.id, payload: { via: "forge cancel" } });
    }
    return { kind: "run-cancelled", runId: run.id, tasksKilled: nonTerminal.map((t) => t.id) };
  }

  return { kind: "unknown", id };
}

export function registerCancel(program: Command): void {
  program
    .command("cancel")
    .argument("<id>", "task id or run id to cancel")
    .description("Kill a stuck task or run and mark it failed/abandoned")
    .option("--dry-run", "report what would change, no writes or docker kills")
    .option("--json", "emit JSON result")
    .action((id: string, opts: { dryRun?: boolean; json?: boolean }) => {
      ensureForgeDirs();
      const outcome = performCancel(id, opts);

      if (outcome.kind === "unknown") {
        if (opts.json) {
          console.log(JSON.stringify({ dryRun: opts.dryRun ?? false, error: "unknown id", id: outcome.id, kind: "unknown" }, null, 2));
        } else {
          process.stderr.write(`forge cancel: unknown id '${id}' — not a task or run\n`);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ dryRun: opts.dryRun ?? false, ...outcome }, null, 2));
        return;
      }

      if (outcome.kind === "task-terminal") {
        console.log(`Task ${outcome.taskId} is already ${outcome.status} — nothing to do.`);
        return;
      }

      if (outcome.kind === "run-terminal") {
        console.log(`Run ${outcome.runId} is already ${outcome.status} — nothing to do.`);
        return;
      }

      if (outcome.kind === "task-cancelled") {
        const prefix = opts.dryRun ? "(dry-run) would kill" : "Killed";
        console.log(`${prefix} container forge-${outcome.taskId} and marked task failed.`);
        if (outcome.runAbandoned) {
          const verb = opts.dryRun ? "would be marked" : "marked";
          console.log(`Run ${outcome.runId} ${verb} abandoned.`);
        }
        return;
      }

      // run-cancelled
      const prefix = opts.dryRun ? "(dry-run) would kill" : "Killed";
      if (outcome.tasksKilled.length > 0) {
        console.log(`${prefix} ${outcome.tasksKilled.length} container(s): ${outcome.tasksKilled.join(", ")}`);
      } else {
        console.log(`Run ${outcome.runId} has no non-terminal tasks.`);
      }
      const verb = opts.dryRun ? "would be marked" : "marked";
      console.log(`Run ${outcome.runId} ${verb} abandoned.`);
    });
}
