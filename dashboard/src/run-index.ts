// FG-821: the run index behind GET /api/runs. Kept out of queries.ts because it
// reaches core's store (queryRuns reads through getDb, held read-only here by
// runInReadOnlyDbScope, as the campaign routes do); queries.ts reads only through the
// dashboard's own read-only handle.

import { queryRuns, runQueryRowJson, type RunQueryRow } from "../../src/v2/runs-query.js";
import { runInReadOnlyDbScope } from "@forge/store-db";
import { dbPath, runIdsInScope, type ProjectScope } from "./queries.js";

// Rows come from core's queryRuns — the same derivation `forge runs query` prints,
// never a second one — filtered through the dashboard's run scope. queryRuns walks
// every run (and each matching run's tasks) per call, so its result is memoized per
// (store, resolved scope, status, since) for one dashboard poll interval. The cache
// is bounded twice: an entry is served for at most RUNS_CACHE_MS, and at most
// RUNS_CACHE_MAX_ENTRIES distinct keys are held (oldest evicted). Correctness over
// freshness: a run that starts or ends is visible within one interval, and the Runs
// badge (activeCount) is informational.
export const RUNS_CACHE_MS = 30_000;
const RUNS_CACHE_MAX_ENTRIES = 64;
const runsCache = new Map<string, { at: number; rows: RunQueryRow[] }>();

export class RunIndexRequestError extends Error {}

export type RunIndexRequest = {
  scope: ProjectScope;
  status?: string;
  since?: string;
  limit: number;
  cursor?: string;
};

export type RunIndexEntry = ReturnType<typeof runQueryRowJson>;

export type RunIndex = {
  runs: RunIndexEntry[];
  /** Count of status=active runs in scope, ignoring status/since/paging. The ONLY
   *  source of the Runs nav badge. */
  activeCount: number;
  nextCursor: string | null;
  generatedAt: string;
};

/** `all`, a duration (`<N>m|h|d`) back from now, or an ISO timestamp. */
export function parseRunIndexSince(raw: string, nowMs: number): number | undefined {
  if (raw === "all") return undefined;
  const duration = raw.match(/^(\d+)([mhd])$/);
  if (duration) {
    const unit = duration[2] === "m" ? 60_000 : duration[2] === "h" ? 3_600_000 : 86_400_000;
    return nowMs - Number(duration[1]) * unit;
  }
  const at = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(at)) {
    throw new RunIndexRequestError(`since must be "all", "<N>m|h|d" or an ISO timestamp (got: ${raw})`);
  }
  return at;
}

function scopedRunRows(scope: ProjectScope, status: string | undefined, since: string | undefined, nowMs: number): RunQueryRow[] {
  const key = JSON.stringify([dbPath(), scope ?? null, status ?? null, since ?? null]);
  const hit = runsCache.get(key);
  if (hit && nowMs - hit.at < RUNS_CACHE_MS) return hit.rows;

  const sinceMs = since === undefined ? undefined : parseRunIndexSince(since, nowMs);
  const inScope = runIdsInScope(scope);
  const rows = runInReadOnlyDbScope(() =>
    queryRuns({ ...(status ? { status } : {}), ...(sinceMs !== undefined ? { sinceMs } : {}) }),
  )
    .filter((row) => inScope === null || inScope.has(row.run.id))
    // queryRuns orders by createdAt alone; the id tiebreak makes the keyset cursor total.
    .sort((a, b) => compareRunKey(b.run, a.run));

  runsCache.delete(key);
  runsCache.set(key, { at: nowMs, rows });
  for (const [k, entry] of runsCache) if (nowMs - entry.at >= RUNS_CACHE_MS) runsCache.delete(k);
  while (runsCache.size > RUNS_CACHE_MAX_ENTRIES) runsCache.delete(runsCache.keys().next().value!);
  return rows;
}

function compareRunKey(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function encodeRunCursor(row: RunQueryRow): string {
  return Buffer.from(JSON.stringify([row.run.createdAt, row.run.id])).toString("base64url");
}

function decodeRunCursor(raw: string): [string, string] {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through to the refusal
  }
  throw new RunIndexRequestError("invalid cursor");
}

export function runIndex(request: RunIndexRequest, nowMs: number = Date.now()): RunIndex {
  let rows = scopedRunRows(request.scope, request.status, request.since, nowMs);
  if (request.cursor !== undefined) {
    const [createdAt, id] = decodeRunCursor(request.cursor);
    rows = rows.filter((row) => compareRunKey(row.run, { createdAt, id }) < 0);
  }
  const page = rows.slice(0, request.limit);
  const last = page[page.length - 1];
  return {
    runs: page.map(runQueryRowJson),
    activeCount: scopedRunRows(request.scope, "active", undefined, nowMs).length,
    nextCursor: rows.length > page.length && last ? encodeRunCursor(last) : null,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
