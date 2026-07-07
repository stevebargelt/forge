import { AuthProfileError } from "./auth-state.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { markTaskFailed } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import type { Event } from "../store/events.js";

// FG-455 p4: mirrors reconcile.ts's ContainerAlive/ContainerReap injectable-seam
// pattern — a best-effort docker exit-code/OOM probe for a just-confirmed-gone
// container. Never throws; an unknown/ambiguous result is `{}`.
export type ContainerExitInfo = (containerName: string) => { exitCode?: number; oomKilled?: boolean };

export type FailureKind =
  | "cancelled"
  | "orphaned"        // container gone with no result — reconciled after a host/parent crash (AWN-1)
  | "orphaned_work_may_persist" // FG-455: container gone, no recoverable result, but the worktree has changed files — real work may be sitting there; reconcile refuses to discard it and surfaces the diff for a human to inspect instead of silently orphaning it
  | "oom_killed"      // FG-455 p4: container gone, positively identified as OOM-killed or exit-137/SIGKILL — a more specific cause than orphaned/orphaned_work_may_persist, surfaced whenever containerExitInfo has evidence, even over a dirty worktree
  | "fanout_wave_orphaned"     // FG-455 p2: a fanout PARENT left `running` after its children finished or died mid-wave with the process gone — reconciled from child evidence; not every child completed, so the parent fails pointing the operator at `forge recover <parent> --re-drive` (forge retry refuses this kind; forge show recommends the same)
  | "orphaned_needs_finalize"  // FG-479: a PIPELINE task's container finished with a usable result, but the forge process died before the host-side finalize (worktree merge → integration gate → reds → gates) ran — reconcile refuses to complete it (that would silently bypass every trust gate); the result is preserved as evidence and the step is re-driven via `forge retry --force` (recover --continue refuses this kind for the same reason)
  | "container_crash"
  | "idle_timeout"
  | "result_missing"
  | "result_malformed"
  | "work_not_persisted"  // result claims files_modified but none landed on the host project mount (#254)
  | "merge_conflict"      // FG-352: worktree branch could not be fast-forwarded into run.projectDir
  | "integration_failed"  // FG-357: clean merge, but build+test of the merged tree failed
  | "integration_gate_timeout"  // FG-424: post-merge gate run hit its timeout — transient, may complete on retry
  | "integration_gate_crashed"  // FG-424: post-merge gate run was killed by a signal outside the timeout path (e.g. kill -9/SIGSEGV) — worktree state after an abrupt kill is not trustworthy to blindly re-run against
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
  // FG-424: raw evidence off the post-merge integration gate's process exit —
  // a disjoint shape from the exitCode-based evidence below (the gate runs on
  // the host, not attached to a container exit).
  integrationGate?: { status: number | null; signal: string | null; timedOut: boolean };
};

export function classify(ctx: FailureContext): FailureKind {
  if (ctx.source !== undefined) return ctx.source;
  if (ctx.error instanceof AuthProfileError) {
    return (ctx.error as Error).message.includes("expired") ? "auth_expired" : "auth_missing";
  }
  // FG-424: checked independent of the exitCode branches below — disjoint
  // evidence shape. Heuristic and its known false-negative bound: a timeout
  // is transient (retry may complete); a signal-kill outside the timeout path
  // means the worktree's post-kill state can't be trusted to blindly re-run.
  // Anything else — including an ordinary non-zero npm/test exit, and a
  // non-signal, non-timeout infra failure such as a corrupted on-disk cache —
  // is indistinguishable from a real test failure here and intentionally
  // still classifies as integration_failed (fail-closed default: broken code
  // must never slip through unblocked).
  if (ctx.integrationGate !== undefined) {
    if (ctx.integrationGate.timedOut) return "integration_gate_timeout";
    if (ctx.integrationGate.signal) return "integration_gate_crashed";
    return "integration_failed";
  }
  if (ctx.exitCode === IDLE_TIMEOUT_EXIT_CODE) return "idle_timeout";
  // FG-455: exit 137 = 128 + SIGKILL(9) — a Docker OOM-kill or an external kill,
  // directly detectable at attached-exit. Classify it the same specific way as
  // the reconcile-time OOM path rather than the generic container_crash below.
  // Guarded on resultState === "missing": a 137 that still produced a result
  // goes through the normal result path, not this one.
  if (ctx.exitCode === 137 && ctx.resultState === "missing") return "oom_killed";
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
    // FG-461: recovery evidence for a recovery-relevant attached-exit failure
    // (oom_killed / container_crash / idle_timeout). Recorded on the task.failed
    // payload so getOrphanEvidenceFromEvents surfaces it — the same read path the
    // reconcile-time oom_killed / orphaned_work_may_persist evidence uses. Omit
    // for kinds with no persisted-work recovery story.
    evidence?: OrphanEvidence;
  },
): void {
  markTaskFailed(taskId, opts.error, opts.result);
  logEvent("task.failed", {
    runId: opts.runId,
    taskId,
    payload: {
      failure_kind: opts.kind,
      error: opts.error,
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
    },
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
  // FG-455 p4: best-effort `docker inspect` exit-info, gathered once per
  // container-gone task alongside the rest of this evidence. Optional — a
  // daemon hiccup, a genuinely-gone container, or events recorded before this
  // field existed all omit it.
  exitCode?: number;
  oomKilled?: boolean;
};

// FG-455 p4 review finding 1: oom_killed carries the same OrphanEvidence shape
// (recorded on the same container-gone evidence-gathering path in reconcile.ts)
// as orphaned_work_may_persist — so it belongs in this same evidence lookup.
// FG-461: the attached-exit path (invoke.ts / runNext.ts) now records the same
// OrphanEvidence shape for its recovery-relevant kinds — container_crash and
// idle_timeout — so they join this lookup too.
// Match EXPLICITLY on this kind set rather than "any payload.evidence present":
// other kinds (e.g. verification_environment_unavailable) record a DIFFERENT
// evidence shape that would otherwise be mis-cast to OrphanEvidence here. Safe
// from miscast: only reconcile.ts and the FG-461 attached-exit path record an
// `evidence` payload, and both use the OrphanEvidence shape for these kinds.
export const ORPHAN_EVIDENCE_KINDS = new Set([
  "orphaned_work_may_persist",
  "oom_killed",
  "container_crash",
  "idle_timeout",
  // FG-479: recorded on reconcile's container-gone path with the same
  // OrphanEvidence shape (resultState "valid" or a recovered stdout result).
  "orphaned_needs_finalize",
]);

/** Recover the orphaned_work_may_persist / oom_killed evidence from a task's
 *  event stream, mirroring failureKindFromEvents's newest-first walk (a later
 *  task.completed means recovered — no evidence to show). undefined for any
 *  other failure kind or a task.failed pre-dating this evidence. */
export function getOrphanEvidenceFromEvents(events: Event[]): OrphanEvidence | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.eventType === "task.completed") return undefined;
    if (e.eventType === "task.failed") {
      const payload = e.payload as Record<string, unknown> | null;
      const kind = payload?.["failure_kind"];
      if (typeof kind === "string" && ORPHAN_EVIDENCE_KINDS.has(kind) && payload?.["evidence"]) {
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
