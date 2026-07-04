import type { Command } from "commander";
import { getTask, tasksForRun } from "../../store/tasks.js";
import { failTask, classify } from "../../v2/failure-kind.js";
import { getRun, updateRunStatus } from "../../store/runs.js";
import { killContainer } from "../../v2/docker-exec.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { logEvent } from "../../store/events.js";
import { acquireRunLock, releaseRunLock } from "../../util/run-lock.js";
import { loadWorkflow } from "../../v2/loader.js";
import { computeReadyQueue } from "../../v2/ready-queue.js";
import type { Run, Task, TaskStatus } from "../../types/index.js";

const TERMINAL = new Set(["complete", "failed"]);

function isTerminal(t: Task): boolean {
  return TERMINAL.has(t.status);
}

export type KillFn = (containerName: string) => void;

// Can the run still make forward progress once the cancelled task is gone?
// Cancelling a single task should abandon the run only when the run is genuinely
// dead — not when a completed phase can still advance to a not-yet-created next
// phase (the trap: cancelling a stray/orphan task while build is complete and
// verify is ready would abandon a perfectly advanceable run). The cancelled task
// is projected as `failed` so the answer is identical for dry-run and real, and
// so the task's own pending/running row can't count itself as "ready work".
// Injected like killFn so the decision stays unit-testable without filesystem
// workflow state.
export type CanAdvanceFn = (run: Run, cancelledTaskId: string) => boolean;

function defaultCanAdvance(run: Run, cancelledTaskId: string): boolean {
  // Invoke runs have no multi-step workflow to advance — a cancelled task is the
  // end of the line. A workflow that can't be loaded can't be reasoned about, so
  // fall back to the historical "abandon when nothing's left" behavior.
  if (run.workflow === "invoke") return false;
  let workflow;
  try {
    workflow = loadWorkflow(run.workflow, run.projectDir ? { projectDir: run.projectDir } : {});
  } catch {
    return false;
  }
  const projected = tasksForRun(run.id).map((t) =>
    t.id === cancelledTaskId ? { ...t, status: "failed" as TaskStatus } : t,
  );
  return computeReadyQueue(workflow, projected).length > 0;
}

export type CancelOpts = { dryRun?: boolean; json?: boolean; abandonRun?: boolean };

export type CancelOutcome =
  | { kind: "task-terminal"; taskId: string; runId: string; status: string }
  | {
      kind: "task-cancelled";
      taskId: string;
      runId: string;
      killed: boolean;
      runAbandoned: boolean;
      runAbandonRefused: boolean;
      childrenKilled: string[];
    }
  | { kind: "run-cancelled"; runId: string; tasksKilled: string[]; runAbandoned: boolean; runAbandonRefused: boolean }
  | { kind: "run-terminal"; runId: string; status: string }
  | { kind: "unknown"; id: string };

export function performCancel(
  id: string,
  opts: CancelOpts,
  killFn: KillFn = (name) => killContainer(name),
  canAdvance: CanAdvanceFn = defaultCanAdvance,
): CancelOutcome {
  const task = getTask(id);
  if (task) {
    if (isTerminal(task)) {
      return { kind: "task-terminal", taskId: task.id, runId: task.runId, status: task.status };
    }

    const taskRun = getRun(task.runId);
    // Abandon the run only when this task was the last non-terminal work AND the
    // run can't still advance through its workflow. A completed phase whose next
    // step is ready keeps the run alive (don't abandon over a cancelled orphan).
    const runStillAdvances = taskRun ? canAdvance(taskRun, task.id) : false;

    // Fanout-parent cancel: children hang off this task via parentId and have
    // no cancel path of their own — cancelling the parent must kill/fail them
    // too, or every forge-<childId> container is orphaned (FG-455 p2).
    const nonTerminalChildren = tasksForRun(task.runId).filter(
      (t) => t.parentId === task.id && !isTerminal(t),
    );

    let runAbandoned = false;
    let runAbandonRefused = false;
    const childrenKilled: string[] = [];
    if (!opts.dryRun) {
      killFn(`forge-${task.id}`);
      logEvent("container.killed", { runId: task.runId, taskId: task.id, payload: { containerName: `forge-${task.id}`, via: "forge cancel" } });
      failTask(task.id, { runId: task.runId, kind: classify({ source: "cancelled" }), error: "cancelled via forge cancel" });
      logEvent("task.cancelled", { runId: task.runId, taskId: task.id, payload: { via: "forge cancel" } });

      for (const child of nonTerminalChildren) {
        const childContainer = `forge-${child.id}`;
        killFn(childContainer);
        childrenKilled.push(childContainer);
        logEvent("container.killed", { runId: task.runId, taskId: child.id, payload: { containerName: childContainer, via: "forge cancel", fanoutParentId: task.id } });
        failTask(child.id, { runId: task.runId, kind: classify({ source: "cancelled" }), error: "cancelled via forge cancel (fanout parent cancelled)" });
        logEvent("task.cancelled", { runId: task.runId, taskId: child.id, payload: { via: "forge cancel", fanoutParentId: task.id } });
      }

      const remaining = tasksForRun(task.runId).filter((t) => !isTerminal(t));
      if (remaining.length === 0 && !runStillAdvances) {
        // FG-455 p2: abandoning the whole run is a bigger call than cancelling
        // one task — require an explicit --abandon-run rather than silently
        // escalating (the trap: cancelling a stray task quietly kills the run).
        if (opts.abandonRun) {
          updateRunStatus(task.runId, "abandoned");
          logEvent("run.cancelled", { runId: task.runId, payload: { via: "forge cancel" } });
          logEvent("run.abandoned", { runId: task.runId, payload: { via: "forge cancel" } });
          runAbandoned = true;
        } else {
          runAbandonRefused = true;
        }
      }
    } else {
      const others = tasksForRun(task.runId).filter(
        (t) => t.id !== task.id && !isTerminal(t) && !nonTerminalChildren.some((c) => c.id === t.id),
      );
      const wouldAbandon = others.length === 0 && !runStillAdvances;
      runAbandoned = wouldAbandon && !!opts.abandonRun;
      runAbandonRefused = wouldAbandon && !opts.abandonRun;
      childrenKilled.push(...nonTerminalChildren.map((c) => `forge-${c.id}`));
    }

    return {
      kind: "task-cancelled",
      taskId: task.id,
      runId: task.runId,
      killed: !opts.dryRun,
      runAbandoned,
      runAbandonRefused,
      childrenKilled,
    };
  }

  const run = getRun(id);
  if (run) {
    if (run.status === "complete" || run.status === "abandoned") {
      return { kind: "run-terminal", runId: run.id, status: run.status };
    }
    const tasks = tasksForRun(run.id);
    const nonTerminal = tasks.filter((t) => !isTerminal(t));
    let runAbandoned = false;
    let runAbandonRefused = false;
    if (!opts.dryRun) {
      for (const t of nonTerminal) {
        killFn(`forge-${t.id}`);
        logEvent("container.killed", { runId: run.id, taskId: t.id, payload: { containerName: `forge-${t.id}`, via: "forge cancel" } });
        failTask(t.id, { runId: run.id, kind: classify({ source: "cancelled" }), error: "cancelled via forge cancel" });
        logEvent("task.cancelled", { runId: run.id, taskId: t.id, payload: { via: "forge cancel" } });
      }
      logEvent("run.cancelled", { runId: run.id, payload: { via: "forge cancel" } });
      // FG-455 p2: same explicit-confirm gate as the single-task escalation
      // above — killing every non-terminal task's container still happens, but
      // the run is only marked abandoned (a terminal, non-resumable state) when
      // --abandon-run is set.
      if (opts.abandonRun) {
        updateRunStatus(run.id, "abandoned");
        logEvent("run.abandoned", { runId: run.id, payload: { via: "forge cancel" } });
        runAbandoned = true;
      } else {
        runAbandonRefused = true;
      }
    } else {
      runAbandoned = !!opts.abandonRun;
      runAbandonRefused = !opts.abandonRun;
    }
    return { kind: "run-cancelled", runId: run.id, tasksKilled: nonTerminal.map((t) => t.id), runAbandoned, runAbandonRefused };
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
    .option("--abandon-run", "confirm abandoning the whole run when this cancel would leave no dispatchable work")
    .action((id: string, opts: { dryRun?: boolean; json?: boolean; abandonRun?: boolean }) => {
      ensureForgeDirs();
      // AWN-2: cancel is authoritative — it STEALS the run lock so it interrupts
      // a running next/gate/retry rather than waiting. Resolve the run to lock
      // (id may be a task or a run). dry-run takes no lock (it writes nothing).
      const lockRunId = getTask(id)?.runId ?? id;
      if (!opts.dryRun) acquireRunLock(lockRunId, "cancel", { steal: true });
      let outcome;
      try {
        outcome = performCancel(id, opts);
      } finally {
        if (!opts.dryRun) releaseRunLock(lockRunId);
      }

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
        if (outcome.childrenKilled.length > 0) {
          console.log(`${prefix} ${outcome.childrenKilled.length} fanout child container(s): ${outcome.childrenKilled.join(", ")}`);
        }
        if (outcome.runAbandoned) {
          const verb = opts.dryRun ? "would be marked" : "marked";
          console.log(`Run ${outcome.runId} ${verb} abandoned.`);
        } else if (outcome.runAbandonRefused) {
          console.log(
            `Run ${outcome.runId} has no dispatchable work remaining but was NOT abandoned — ` +
              `re-run with --abandon-run to abandon it, or forge recover/re-invoke to continue.`,
          );
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
      if (outcome.runAbandoned) {
        const verb = opts.dryRun ? "would be marked" : "marked";
        console.log(`Run ${outcome.runId} ${verb} abandoned.`);
      } else {
        console.log(
          `Run ${outcome.runId} was NOT abandoned — re-run with --abandon-run to abandon it, or forge recover/re-invoke to continue.`,
        );
      }
    });
}
