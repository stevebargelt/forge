// RUN-2: operational reliability metrics — distinct from `forge usage` (token /
// cost). Aggregates over runs/tasks/events: success rate, failure-kind mix,
// median task durations, and operational counts (idle kills, cancels, retries,
// red blocks). No schema change; everything is derived from existing rows.

import type { Run, Task } from "../types/index.js";
import { listRuns } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { failureKindForTask } from "./failure-kind.js";
import { runMatchesFilters } from "./runs-query.js";

export type MetricDimension = "workflow" | "phase" | "role";

export type MetricsFilters = {
  sinceMs?: number;
  project?: string;
  workflow?: string;
  by?: MetricDimension; // duration grouping (default: phase)
};

export type DurationStat = { dimension: string; count: number; medianMs: number };

export type Metrics = {
  runs: { total: number; clean: number; withFailures: number; successRate: number };
  taskCount: number;
  failureKinds: Array<{ kind: string; count: number }>;
  durationsBy: MetricDimension;
  durations: DurationStat[];
  counts: { idleKills: number; cancels: number; retries: number; redBlocks: number };
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

function dimensionValue(by: MetricDimension, run: Run, task: Task): string {
  if (by === "workflow") return run.workflow;
  if (by === "role") return task.agentRole;
  return task.phase;
}

export function computeMetrics(filters: MetricsFilters): Metrics {
  const by: MetricDimension = filters.by ?? "phase";

  let total = 0, clean = 0, withFailures = 0, taskCount = 0;
  const failureKindCounts = new Map<string, number>();
  const durationsByDim = new Map<string, number[]>();
  let idleKills = 0, cancels = 0, retries = 0, redBlocks = 0;

  for (const run of listRuns()) {
    if (!runMatchesFilters(run, filters)) continue;
    total++;

    const tasks = tasksForRun(run.id).filter((t) => t.parentId === undefined);
    taskCount += tasks.length;

    let runHadFailure = false;
    for (const t of tasks) {
      // Median duration per dimension, when the task actually ran to a terminal.
      if (t.startedAt && t.completedAt) {
        const ms = new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime();
        if (ms >= 0) {
          const key = dimensionValue(by, run, t);
          const arr = durationsByDim.get(key) ?? [];
          arr.push(ms);
          durationsByDim.set(key, arr);
        }
      }
      if (t.status === "failed") {
        runHadFailure = true;
        const kind = failureKindForTask(t.id) ?? "unknown";
        failureKindCounts.set(kind, (failureKindCounts.get(kind) ?? 0) + 1);
        if (kind === "idle_timeout") idleKills++;
      }
    }
    if (runHadFailure) withFailures++; else clean++;

    // Operational counts from the event stream.
    for (const e of eventsForRun(run.id)) {
      if (e.eventType === "task.cancelled" || e.eventType === "run.cancelled") cancels++;
      else if (e.eventType === "task.retried") retries++;
      else if (e.eventType === "task.blocked_by_red") redBlocks++;
    }
  }

  const failureKinds = [...failureKindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  const durations: DurationStat[] = [...durationsByDim.entries()]
    .map(([dimension, arr]) => ({ dimension, count: arr.length, medianMs: median(arr) }))
    .sort((a, b) => b.count - a.count);

  return {
    runs: { total, clean, withFailures, successRate: total > 0 ? clean / total : 0 },
    taskCount,
    failureKinds,
    durationsBy: by,
    durations,
    counts: { idleKills, cancels, retries, redBlocks },
  };
}
