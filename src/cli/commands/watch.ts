import type { Command } from "commander";
import { join } from "node:path";
import { getRun } from "../../store/runs.js";
import { tasksForRun } from "../../store/tasks.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { eventsForTask } from "../../store/events.js";
import { ensureForgeDirs, taskDir } from "../../util/paths.js";
import { resolveIdleTimeoutMs } from "../../v2/idle-watchdog.js";
import {
  computeIdleCountdown,
  getManifestIdleTimeoutMs,
  getLastOutputMtime,
  getFailureKindFromEvents,
  type IdleCountdown,
} from "./show.js";

// `forge watch <runId>` blocks until the run reaches a terminal state OR a task
// transitions (status change, new task created, new verdict written). Emits one
// JSON event per line on each change. Designed for the orchestrator to consume:
//
//   { "type": "task_status_changed", "taskId": "...", "from": "running", "to": "complete", ... }
//   { "type": "task_created",        "taskId": "...", "phase": "...", "agentRole": "...", ... }
//   { "type": "task_activity",       "taskId": "...", "idle": { ... }, ... }   // WALK-2
//   { "type": "task_idle_warning",   "taskId": "...", "idle": { "expired": true }, ... } // WALK-2
//   { "type": "verdict_written",     "taskId": "...", "redRole": "...", "verdict": "...", ... }
//   { "type": "run_status_changed",  "from": "running", "to": "complete", ... }
//
// WALK-2: between status transitions, running tasks emit `task_activity` when
// they produce new stdout (alive + progressing) and `task_idle_warning` once
// their idle budget is exhausted (a kill is imminent). Failure transitions carry
// `failureKind`. Every event carries `runId` and a `spanKind` (run|task|
// red-review) so consumers can build a trace shape without parsing strings.
//
// On terminal state (`complete` / `failed` / `abandoned`), emits a final
// `run_status_changed` then exits 0. The caller (orchestrator) gets a clean
// signal to stop watching.
//
// Implementation: poll-based, snapshot-diff approach. Each tick reads the
// full state, diffs against the prior snapshot, emits events. Simpler than
// SQLite WAL hooks; tolerates concurrent writers; loses no events because
// every poll catches up.

const DEFAULT_POLL_MS = 2000;
const TERMINAL_RUN_STATUSES = new Set(["complete", "failed", "abandoned"]);

export type TaskSnap = {
  id: string;
  phase: string;
  agentRole: string;
  status: string;
  // Live-activity fields, populated only while the task is running (WALK-2).
  lastOutputMtime?: number; // epoch ms of the last stdout write; advance ⇒ progress
  idle?: IdleCountdown;     // idle budget snapshot at this poll
};
export type VerdictSnap = {
  taskId: string;
  redTaskId: string;
  redRole: string;
  verdict: string;
};

export type Snapshot = {
  runStatus: string;
  tasks: Map<string, TaskSnap>;
  verdicts: Map<string, VerdictSnap>; // keyed by redTaskId for stable identity
};

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .argument("<run-id>", "run id to watch")
    .option("--interval <ms>", "poll interval in milliseconds (default 2000)", String(DEFAULT_POLL_MS))
    .option("--timeout <ms>", "max time to wait before exiting (default: no limit)", "0")
    .description("Watch a run; emit one JSON event per line on each state change; exit on terminal state")
    .action(async (runId: string, opts: { interval: string; timeout: string }) => {
      ensureForgeDirs();
      const intervalMs = Math.max(250, Number(opts.interval) || DEFAULT_POLL_MS);
      const timeoutMs = Math.max(0, Number(opts.timeout) || 0);

      const run = getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);

      // Initial snapshot. Emit baseline events so callers know the starting state.
      let prev = snapshot(runId);
      emit({
        type: "watch_started",
        runId,
        spanKind: "run",
        runStatus: prev.runStatus,
        taskCount: prev.tasks.size,
      });

      if (TERMINAL_RUN_STATUSES.has(prev.runStatus)) {
        emit({ type: "run_status_changed", runId, spanKind: "run", from: prev.runStatus, to: prev.runStatus, terminal: true });
        return;
      }

      const startedAt = Date.now();
      while (true) {
        await sleep(intervalMs);
        if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
          emit({ type: "watch_timeout", runId, spanKind: "run", elapsedMs: Date.now() - startedAt });
          return;
        }

        const next = snapshot(runId);
        for (const e of diffEvents(prev, next, runId)) emit(e);

        if (TERMINAL_RUN_STATUSES.has(next.runStatus)) {
          return; // run_status_changed already emitted by diffEvents
        }
        prev = next;
      }
    });
}

export function snapshot(runId: string): Snapshot {
  const run = getRun(runId);
  const tasks = tasksForRun(runId);
  const taskMap = new Map<string, TaskSnap>();
  const verdictMap = new Map<string, VerdictSnap>();
  for (const t of tasks) {
    const snap: TaskSnap = {
      id: t.id,
      phase: t.phase,
      agentRole: t.agentRole,
      status: t.status,
    };
    if (t.status === "running") {
      const tDir = taskDir(t.runId, t.id);
      const mtime = getLastOutputMtime(join(tDir, "container.stdout.log"));
      const timeout = getManifestIdleTimeoutMs(tDir) ?? resolveIdleTimeoutMs();
      snap.lastOutputMtime = mtime;
      snap.idle = computeIdleCountdown(mtime, timeout);
    }
    taskMap.set(t.id, snap);
    for (const v of verdictsForTask(t.id)) {
      verdictMap.set(v.redTaskId, {
        taskId: t.id,
        redTaskId: v.redTaskId,
        redRole: v.redRole,
        verdict: v.verdict,
      });
    }
  }
  return {
    runStatus: run?.status ?? "unknown",
    tasks: taskMap,
    verdicts: verdictMap,
  };
}

// Build the events implied by the prev→next snapshot diff. Pure except for the
// failure_kind lookup (reads the task's events). Returned, not emitted, so the
// diff logic is unit-testable. Exported for tests.
export function diffEvents(prev: Snapshot, next: Snapshot, runId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // New tasks
  for (const [id, t] of next.tasks) {
    if (!prev.tasks.has(id)) {
      out.push({
        type: "task_created",
        runId,
        spanKind: "task",
        taskId: id,
        phase: t.phase,
        agentRole: t.agentRole,
        status: t.status,
      });
    }
  }
  // Status changes
  for (const [id, t] of next.tasks) {
    const p = prev.tasks.get(id);
    if (p && p.status !== t.status) {
      const event: Record<string, unknown> = {
        type: "task_status_changed",
        runId,
        spanKind: "task",
        taskId: id,
        agentRole: t.agentRole,
        from: p.status,
        to: t.status,
      };
      // WALK-2: a failure transition carries the machine-readable failure_kind
      // so consumers branch without parsing the prose error.
      if (t.status === "failed") {
        const kind = getFailureKindFromEvents(eventsForTask(id));
        if (kind) event["failureKind"] = kind;
      }
      out.push(event);
    }
  }
  // WALK-2: live activity for tasks running across both polls.
  for (const [id, t] of next.tasks) {
    const p = prev.tasks.get(id);
    if (!p || p.status !== "running" || t.status !== "running") continue;
    // New stdout since last poll ⇒ the agent is alive and progressing.
    const advanced =
      t.lastOutputMtime !== undefined &&
      (p.lastOutputMtime === undefined || t.lastOutputMtime > p.lastOutputMtime);
    if (advanced) {
      out.push({ type: "task_activity", runId, spanKind: "task", taskId: id, agentRole: t.agentRole, idle: t.idle });
    }
    // Idle budget just crossed into exhausted ⇒ a watchdog kill is imminent.
    if (t.idle?.expired && !p.idle?.expired) {
      out.push({ type: "task_idle_warning", runId, spanKind: "task", taskId: id, agentRole: t.agentRole, idle: t.idle });
    }
  }
  // New verdicts
  for (const [redTaskId, v] of next.verdicts) {
    if (!prev.verdicts.has(redTaskId)) {
      out.push({
        type: "verdict_written",
        runId,
        spanKind: "red-review",
        taskId: v.taskId,
        redTaskId,
        redRole: v.redRole,
        verdict: v.verdict,
      });
    }
  }
  // Run-level status change
  if (prev.runStatus !== next.runStatus) {
    out.push({
      type: "run_status_changed",
      runId,
      spanKind: "run",
      from: prev.runStatus,
      to: next.runStatus,
      terminal: TERMINAL_RUN_STATUSES.has(next.runStatus),
    });
  }
  return out;
}

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
