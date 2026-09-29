import type { HashScope } from "./view-routing.js";
import type { NavBadge } from "./nav-render.js";
import type { Crumb, CrumbProject } from "./breadcrumbs-render.js";

export const RUNS_POLL_MS: number;
export const RUNS_PAGE_SIZE: number;
export const RUNS_MAX_LIMIT: number;
export const RUN_STATUSES: readonly string[];
export interface RunsLoad {
  phase: "loading" | "ready" | "unavailable";
  body: { runs?: unknown[]; activeCount?: unknown; nextCursor?: string | null; error?: string } | null;
  status?: number;
}
export const RUNS_LOADING: RunsLoad;
export function runsUrl(request?: { scope?: Partial<HashScope> | null; status?: string | null; cursor?: string | null; limit?: number }): string;
export function readRuns(url: string, fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>): Promise<RunsLoad>;
export function runsBadge(load: RunsLoad | null | undefined): NavBadge | null;
export function statusFilters(scope: Partial<HashScope> | null, status: string | null): { value: string | null; label: string; href: string; current: boolean }[];
export interface RunIndexRow {
  runId: string;
  href: string;
  title: string;
  workflow: string;
  project: Crumb;
  ticket: { label: string; href: string } | null;
  status: string;
  startedAt: string;
  duration: string;
  failed: number;
}
export function runRow(
  run: { runId: string; status: string; workflow: string; title: string; projectDir: string | null; createdAt: string; completedAt: string | null; failedCount?: number; ticketId?: string | null },
  projects: CrumbProject[] | null,
  nowMs: number,
): RunIndexRow;
