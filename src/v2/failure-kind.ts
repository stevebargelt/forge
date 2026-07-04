import { AuthProfileError } from "./auth-state.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { markTaskFailed } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import type { Event } from "../store/events.js";

export type FailureKind =
  | "cancelled"
  | "orphaned"        // container gone with no result — reconciled after a host/parent crash (AWN-1)
  | "orphaned_work_may_persist" // FG-455: container gone, no recoverable result, but the worktree has changed files — real work may be sitting there; reconcile refuses to discard it and surfaces the diff for a human to inspect instead of silently orphaning it
  | "fanout_wave_orphaned"     // FG-455 p2: a fanout PARENT left `running` after its children finished or died mid-wave with the process gone — reconciled from child evidence; not every child completed, so the parent fails pointing the operator at `forge recover <parent> --re-drive` (forge retry refuses this kind; forge show recommends the same)
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
  | "verification_environment_unavailable"  // FG-376: dependency provisioning failed before tests could run
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

// FG-455: recovery evidence reconcile gathers BEFORE classifying a container-gone
// task, recorded on the task.failed / task.reconciled payload so any consumer of
// the event stream (forge show, forge status, forge ops check) can render it —
// not just the process that did the classifying.
export type OrphanEvidence = {
  containerName: string;
  containerLiveness: "gone";
  resultState: "absent" | "empty" | "malformed" | "valid";
  recoverableStdoutResult: boolean;
  worktreePathChecked: string | null;
  changedFiles: string[];
  // FG-455 finding 2: where changedFiles came from. "worktree" = a dedicated
  // worktree_path — task-exclusive, confident evidence. "project_dir_shared" =
  // the no-worktree fallback onto run.projectDir, which the operator (and any
  // other no-worktree task in the run) may also be touching — evidence to
  // inspect, not proof of this task's work. Optional: events recorded before
  // this field existed omit it.
  source?: "worktree" | "project_dir_shared";
  // FG-455 review finding 1: the recovered stdout result is written to
  // result.json best-effort — completion always proceeds from the in-memory
  // result regardless of whether the disk write succeeded. Set when that write
  // threw, so a bad task dir doesn't silently look like a clean recovery.
  resultWriteFailed?: boolean;
};

/** Recover the orphaned_work_may_persist evidence from a task's event stream,
 *  mirroring failureKindFromEvents's newest-first walk (a later task.completed
 *  means recovered — no evidence to show). undefined for any other failure kind
 *  or a task.failed pre-dating this evidence. */
export function getOrphanEvidenceFromEvents(events: Event[]): OrphanEvidence | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.eventType === "task.completed") return undefined;
    if (e.eventType === "task.failed") {
      const payload = e.payload as Record<string, unknown> | null;
      if (payload?.["failure_kind"] === "orphaned_work_may_persist" && payload["evidence"]) {
        return payload["evidence"] as OrphanEvidence;
      }
      return undefined;
    }
  }
  return undefined;
}

// FG-455 p2/p3 review finding 2: reconcile.ts records how many children finished
// before a fanout parent got reconciled to fanout_wave_orphaned — the same
// childSummary shape it also writes onto task.reconciled. Sibling to
// getOrphanEvidenceFromEvents (same newest-first, completed-supersedes walk) so
// `forge show` can surface this alongside the generic failure summary.
export type FanoutWaveEvidence = { total: number; complete: number };

export function getFanoutWaveEvidenceFromEvents(events: Event[]): FanoutWaveEvidence | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.eventType === "task.completed") return undefined;
    if (e.eventType === "task.failed") {
      const payload = e.payload as Record<string, unknown> | null;
      if (payload?.["failure_kind"] === "fanout_wave_orphaned" && payload["childSummary"]) {
        return payload["childSummary"] as FanoutWaveEvidence;
      }
      return undefined;
    }
  }
  return undefined;
}
