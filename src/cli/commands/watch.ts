import type { Command } from "commander";
import { getRun } from "../../store/runs.js";
import { tasksForRun } from "../../store/tasks.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { ensureForgeDirs } from "../../util/paths.js";

// `forge watch <runId>` blocks until the run reaches a terminal state OR a task
// transitions (status change, new task created, new verdict written). Emits one
// JSON event per line on each change. Designed for the orchestrator to consume:
//
//   { "type": "task_status_changed", "taskId": "...", "from": "running", "to": "complete", ... }
//   { "type": "task_created",        "taskId": "...", "phase": "...", "agentRole": "...", ... }
//   { "type": "verdict_written",     "taskId": "...", "redRole": "...", "verdict": "...", ... }
//   { "type": "run_status_changed",  "from": "running", "to": "complete", ... }
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

type TaskSnap = {
  id: string;
  phase: string;
  agentRole: string;
  status: string;
};
type VerdictSnap = {
  taskId: string;
  redTaskId: string;
  redRole: string;
  verdict: string;
};

type Snapshot = {
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
        runStatus: prev.runStatus,
        taskCount: prev.tasks.size,
      });

      if (TERMINAL_RUN_STATUSES.has(prev.runStatus)) {
        emit({ type: "run_status_changed", from: prev.runStatus, to: prev.runStatus, terminal: true });
        return;
      }

      const startedAt = Date.now();
      while (true) {
        await sleep(intervalMs);
        if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
          emit({ type: "watch_timeout", elapsedMs: Date.now() - startedAt });
          return;
        }

        const next = snapshot(runId);
        emitDiff(prev, next);

        if (TERMINAL_RUN_STATUSES.has(next.runStatus)) {
          return; // run_status_changed already emitted by emitDiff
        }
        prev = next;
      }
    });
}

function snapshot(runId: string): Snapshot {
  const run = getRun(runId);
  const tasks = tasksForRun(runId);
  const taskMap = new Map<string, TaskSnap>();
  const verdictMap = new Map<string, VerdictSnap>();
  for (const t of tasks) {
    taskMap.set(t.id, {
      id: t.id,
      phase: t.phase,
      agentRole: t.agentRole,
      status: t.status,
    });
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

function emitDiff(prev: Snapshot, next: Snapshot): void {
  // New tasks
  for (const [id, t] of next.tasks) {
    if (!prev.tasks.has(id)) {
      emit({
        type: "task_created",
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
      emit({
        type: "task_status_changed",
        taskId: id,
        agentRole: t.agentRole,
        from: p.status,
        to: t.status,
      });
    }
  }
  // New verdicts
  for (const [redTaskId, v] of next.verdicts) {
    if (!prev.verdicts.has(redTaskId)) {
      emit({
        type: "verdict_written",
        taskId: v.taskId,
        redTaskId,
        redRole: v.redRole,
        verdict: v.verdict,
      });
    }
  }
  // Run-level status change
  if (prev.runStatus !== next.runStatus) {
    emit({
      type: "run_status_changed",
      from: prev.runStatus,
      to: next.runStatus,
      terminal: TERMINAL_RUN_STATUSES.has(next.runStatus),
    });
  }
}

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
