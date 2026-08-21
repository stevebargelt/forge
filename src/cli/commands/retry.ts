import type { Command } from "commander";
import {
  retry,
  dispatchRetriedAdHocTask,
  RetryNotAllowedError,
  FanoutChildRetryError,
  RedReviewRetryError,
  PublishedTaskRetryError,
  AdHocRedispatchUnavailableError,
  RetryDispatchKindUnknownError,
  type RetryOutcome,
} from "../../v2/retry.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { getTask } from "../../store/tasks.js";
import { withRunLock, RunBusyError } from "../../util/run-lock.js";

// FG-507: `forge next` only ever dispatches workflow steps, so pointing an
// ad-hoc retry at it strands the new row. The pointer prints for workflow-step
// tasks and ONLY for them; an ad-hoc task announces the direct re-dispatch that
// follows instead. Pure so the two branches are pinned by test, not by eyeball.
export function retrySummaryLines(taskId: string, out: RetryOutcome): string[] {
  const kind = out.failureKind ? ` [${out.failureKind}]` : "";
  const lines = [`Retried ${taskId}${kind} (kept as failed for audit)`, `  ${out.disposition.reason}.`];
  if (out.disposition.advice) lines.push(`  note: ${out.disposition.advice}.`);
  lines.push(`  new task: ${out.newTask.id} (pending, lineage → ${taskId})`);
  lines.push("");
  if (!out.adHoc) {
    lines.push("Next:", `  forge next ${out.newTask.runId}`);
  } else {
    lines.push(
      `${out.newTask.id} is an ad-hoc task (not a step of run ${out.newTask.runId}'s workflow), so the ` +
        "workflow ready queue would never dispatch it. Re-dispatching directly (invoke semantics)…",
    );
  }
  return lines;
}

export function registerRetry(program: Command): void {
  program
    .command("retry")
    .argument("<task-id>", "task id (must be in status failed)")
    .option("--force", "retry even a non-retryable failure kind (e.g. gate_rejected, red_blocked)")
    .description(
      "Reset a failed task back to pending. A workflow-step task is redispatched by `forge next`; an ad-hoc (forge invoke) task is re-dispatched immediately, in-process, with invoke semantics",
    )
    .action(async (taskId: string, options: { force?: boolean }) => {
      ensureForgeDirs();
      // AWN-2: serialize retry per run so it can't race a concurrent next/gate
      // and attach to stale/half-finalized task state.
      const runId = getTask(taskId)?.runId ?? taskId;
      try {
        // Only the row mutation runs under the lock. The ad-hoc dispatch below
        // runs a container to completion; holding the run lock for that would
        // block every concurrent next/gate on the run for the agent's whole
        // lifetime — which `forge invoke` never does either.
        const out = await withRunLock(runId, "retry", () => retry(taskId, { force: options.force }));
        for (const line of retrySummaryLines(taskId, out)) console.log(line);
        if (!out.adHoc) return;

        const result = await dispatchRetriedAdHocTask(out.newTask, out.adHoc);
        if (result.status === "failed") {
          console.error(`✗ ${out.newTask.agentRole} failed: ${result.error ?? "(no error)"}`);
          console.error(`  run:  ${result.runId}`);
          console.error(`  task: ${result.taskId}`);
          process.exitCode = 1;
          return;
        }
        console.log(`✓ ${out.newTask.agentRole} complete`);
        console.log(`  run:  ${result.runId}`);
        console.log(`  task: ${result.taskId}`);
        console.log(``);
        console.log(`Read full result with:`);
        console.log(`  forge show ${result.taskId}`);
      } catch (e) {
        if (e instanceof RetryNotAllowedError) {
          console.error(`forge retry: ${e.message}`);
          if (e.disposition.advice) console.error(`  ${e.disposition.advice}.`);
          process.exitCode = 1;
          return;
        }
        if (
          e instanceof FanoutChildRetryError ||
          e instanceof RedReviewRetryError ||
          e instanceof PublishedTaskRetryError ||
          e instanceof AdHocRedispatchUnavailableError ||
          e instanceof RetryDispatchKindUnknownError
        ) {
          console.error(`forge retry: ${e.message}`);
          process.exitCode = 1;
          return;
        }
        if (e instanceof RunBusyError) {
          console.error(`forge retry: ${e.message}`);
          console.error(`Another forge command is mutating this run. Wait for it to finish.`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    });
}
