import { AuthProfileError } from "./auth-state.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { markTaskFailed } from "../store/tasks.js";
import { logEvent } from "../store/events.js";

export type FailureKind =
  | "cancelled"
  | "container_crash"
  | "idle_timeout"
  | "result_missing"
  | "result_malformed"
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
