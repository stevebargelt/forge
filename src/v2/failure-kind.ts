import { AuthProfileError } from "./auth-state.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { markTaskFailed } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import type { Event } from "../store/events.js";

export type FailureKind =
  | "cancelled"
  | "orphaned"        // container gone with no result — reconciled after a host/parent crash (AWN-1)
  | "container_crash"
  | "idle_timeout"
  | "result_missing"
  | "result_malformed"
  | "work_not_persisted"  // result claims files_modified but none landed on the host project mount (#254)
  | "merge_conflict"      // FG-352: worktree branch could not be fast-forwarded into run.projectDir
  | "integration_failed"  // FG-357: clean merge, but build+test of the merged tree failed
  | "auth_missing"
  | "auth_expired"
  | "auth_injection_failed"
  | "model_error"
  | "tool_error"
  | "red_blocked"
  | "gate_rejected"
  | "unknown";

export type FailureContext = {
  error?: unknown;
  exitCode?: number;
  resultState?: "missing" | "malformed";
  source?: Exclude<FailureKind, "auth_missing" | "auth_expired" | "idle_timeout" | "container_crash" | "result_missing" | "result_malformed" | "unknown">;
};

export function classify(ctx: FailureContext): FailureKind {
  if (ctx.source !== undefined) return ctx.source;
  if (ctx.error instanceof AuthProfileError) {
    return (ctx.error as Error).message.includes("expired") ? "auth_expired" : "auth_missing";
  }
  if (ctx.exitCode === IDLE_TIMEOUT_EXIT_CODE) return "idle_timeout";
  if (ctx.exitCode !== undefined && ctx.exitCode !== 0 && ctx.resultState === "missing") {
    return "container_crash";
  }
  if (ctx.resultState === "missing") return "result_missing";
  if (ctx.resultState === "malformed") return "result_malformed";
  return "unknown";
}

export function failTask(
  taskId: string,
  opts: {
    runId: string;
    kind: FailureKind;
    error: string;
    result?: unknown;
  },
): void {
  markTaskFailed(taskId, opts.error, opts.result);
  logEvent("task.failed", {
    runId: opts.runId,
    taskId,
    payload: { failure_kind: opts.kind, error: opts.error },
  });
}

// ── Read side: recover a task's current failure_kind from its event stream ──
// Single source of truth for "what kind of failure is this task in". Walks the
// events newest-first and stops at the first terminal lifecycle event: the
// latest failure wins (so a retry's stale earlier kind is ignored), and a later
// task.completed (recovered) yields no kind. forge show, forge watch, and the
// notification layer all consume this.
export function failureKindFromEvents(events: Event[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.eventType === "task.completed") return undefined;
    if (e.eventType === "task.failed") {
      const payload = e.payload as Record<string, unknown> | null;
      if (payload && typeof payload["failure_kind"] === "string") return payload["failure_kind"];
      // task.failed with no recorded kind — at minimum an unknown failure, never "no info".
      // Reserve undefined for the no-terminal-event case (no task.failed and no task.completed).
      return "unknown";
    }
  }
  return undefined;
}

/** The current failure_kind for a task id (loads its events). */
export function failureKindForTask(taskId: string): string | undefined {
  return failureKindFromEvents(eventsForTask(taskId));
}
