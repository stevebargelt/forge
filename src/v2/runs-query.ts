// RUN-1: search historical runs by status, failure_kind, project, age.
//
// In-process query (not raw SQL) because failure_kind lives in task.failed event
// payloads, not a column (Crawl decision) — so filtering by it means scanning a
// run's tasks. For the O(hundreds) of runs forge accumulates this is fine, and
// it keeps the logic testable without SQL fixtures.

import { basename } from "node:path";
import type { Run } from "../types/index.js";
import { listRuns } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { failureKindForTask } from "./failure-kind.js";

export type RunFilters = {
  status?: string;
  project?: string;     // matches projectDir exactly or by basename
  workflow?: string;
  sinceMs?: number;     // keep runs created at or after this epoch-ms cutoff
  failureKind?: string; // keep runs with >=1 top-level task failed with this kind
};

export type RunQueryRow = {
  run: Run;
  taskCount: number;
  failedCount: number;
  failureKinds: string[]; // distinct kinds across this run's failed top-level tasks
};

/** Parse a `--since` window into an epoch-ms cutoff. "all" → undefined (no
 *  cutoff). "<N>d" → now - N days. Throws on anything else. */
export function parseSince(raw: string, nowMs = Date.now()): number | undefined {
  if (raw === "all") return undefined;
  const m = raw.match(/^(\d+)d$/);
  if (!m || !m[1]) throw new Error(`--since must be "all" or "<N>d" (got: ${raw})`);
  return nowMs - parseInt(m[1], 10) * 86_400_000;
}

export function projectMatches(run: Run, project: string): boolean {
  if (!run.projectDir) return false;
  const rd = run.projectDir.replace(/\/+$/, "");
  if (rd === project.replace(/\/+$/, "")) return true;
  // Basename matching ONLY when the filter is a bare name (no path separator).
  // A full path like /a/app must NOT match a different repo /b/app that happens
  // to share the basename "app".
  if (!project.includes("/")) return basename(rd) === project;
  return false;
}

/** Shared run-level filter predicate (status/workflow/since/project). Reused by
 *  queryRuns and the metrics aggregator. */
export function runMatchesFilters(run: Run, f: Pick<RunFilters, "status" | "workflow" | "sinceMs" | "project">): boolean {
  if (f.status && run.status !== f.status) return false;
  if (f.workflow && run.workflow !== f.workflow) return false;
  if (f.sinceMs !== undefined && new Date(run.createdAt).getTime() < f.sinceMs) return false;
  if (f.project && !projectMatches(run, f.project)) return false;
  return true;
}

export function queryRuns(filters: RunFilters): RunQueryRow[] {
  const rows: RunQueryRow[] = [];
  for (const run of listRuns()) {
    if (!runMatchesFilters(run, filters)) continue;

    // Top-level tasks only — fanout children and reds roll up under their parent.
    const tasks = tasksForRun(run.id).filter((t) => t.parentId === undefined);
    const failed = tasks.filter((t) => t.status === "failed");
    const kinds = new Set<string>();
    for (const t of failed) {
      const k = failureKindForTask(t.id);
      if (k) kinds.add(k);
    }
    if (filters.failureKind && !kinds.has(filters.failureKind)) continue;

    rows.push({ run, taskCount: tasks.length, failedCount: failed.length, failureKinds: [...kinds] });
  }
  // Most recent first.
  rows.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  return rows;
}
