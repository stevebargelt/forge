// FG-821: the run index (#runs[?scope&status=]) and the Runs nav badge, as data. Pure,
// so unit tests over this and browser tests over the list mean the same thing.
//
// THE BADGE RULE (the Home badge's, applied to Runs): the browser counts nothing. The
// badge is GET /api/runs's server-computed `activeCount` — the same derivation
// `forge runs query --status active` prints — never `runs.length`, never a tally of a
// filtered or paged list. It is informational, so it is never danger-toned; an
// unreadable count shows "?", and 0 hides it.

import { BADGE_CAP } from "./nav-render.js";
import { projectCrumb, projectForDir } from "./breadcrumbs-render.js";
import { checkoutLabelForDir } from "./checkout-label.js";
import { hashFor } from "./view-routing.js";
import { formatDuration } from "./format.js";

export const RUNS_POLL_MS = 30000;
export const RUNS_PAGE_SIZE = 50;
// The server clamps ?limit to 200; a poll re-reads everything shown up to that.
export const RUNS_MAX_LIMIT = 200;
export const RUN_STATUSES = Object.freeze(["active", "complete", "failed", "abandoned"]);

export const RUNS_LOADING = Object.freeze({ phase: "loading", body: null });

/** GET /api/runs for a scope, status filter, page cursor and limit. */
export function runsUrl({ scope = null, status = null, cursor = null, limit = RUNS_PAGE_SIZE } = {}) {
  const q = new URLSearchParams();
  if (scope && scope.project) q.set("projectKey", scope.project);
  if (scope && scope.project && scope.checkout) q.set("projectDir", scope.checkout);
  if (status) q.set("status", status);
  if (cursor) q.set("cursor", cursor);
  q.set("limit", String(limit));
  return `/api/runs?${q.toString()}`;
}

function isRunsBody(body) {
  return Boolean(body) && typeof body === "object" && Array.isArray(body.runs);
}

/** Read one page. Failure is the return value — { phase: "unavailable" } — never a throw. */
export async function readRuns(url, fetchImpl) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (doFetch === null) return { phase: "unavailable", body: null };
  try {
    const res = await doFetch(url);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || !isRunsBody(body)) return { phase: "unavailable", body, status: res.status };
    return { phase: "ready", body };
  } catch {
    return { phase: "unavailable", body: null };
  }
}

/** The Runs badge, as data: null (no badge) or { text, tone, partial, label }. */
export function runsBadge(load) {
  if (!load || load.phase === "loading") return null;
  const count = load.phase === "ready" ? load.body?.activeCount : null;
  if (!Number.isInteger(count) || count < 0) {
    return { text: "?", tone: "unknown", partial: false, label: "Active run count unavailable" };
  }
  if (count === 0) return null;
  return {
    text: count > BADGE_CAP ? `${BADGE_CAP}+` : String(count),
    tone: "neutral",
    partial: false,
    label: `${count} active ${count === 1 ? "run" : "runs"}`,
  };
}

/** The status filter links: "all" plus each run status, with the current one flagged. */
export function statusFilters(scope, status) {
  return [null, ...RUN_STATUSES].map((value) => ({
    value,
    label: value ?? "all",
    href: hashFor({ view: "runs", scope, params: value ? { status: value } : null }),
    current: (status ?? null) === value,
  }));
}

/** One row of the index. `ticketId` renders when the row carries one. */
export function runRow(run, projects, nowMs) {
  const created = Date.parse(run.createdAt);
  const completed = run.completedAt ? Date.parse(run.completedAt) : null;
  const end = completed ?? (run.status === "active" ? nowMs : null);
  const durationMs = Number.isFinite(created) && end !== null && Number.isFinite(end) ? Math.max(0, end - created) : null;
  const ticketId = typeof run.ticketId === "string" && run.ticketId !== "" ? run.ticketId : null;
  const project = projectCrumb(run.projectDir, projects);
  const key = projectForDir(run.projectDir, projects)?.key ?? null;
  return {
    runId: run.runId,
    href: hashFor({ view: "run", id: run.runId }),
    title: run.title || run.runId,
    workflow: run.workflow,
    project,
    checkout: key ? checkoutLabelForDir(run.projectDir, projects) : null,
    ticket: ticketId ? { label: ticketId, href: hashFor({ view: "backlog", id: ticketId, scope: key ? { project: key } : null }) } : null,
    status: run.status,
    startedAt: run.createdAt,
    duration: durationMs === null ? "—" : `${formatDuration(durationMs)}${completed === null ? " so far" : ""}`,
    failed: Number.isInteger(run.failedCount) && run.failedCount > 0 ? run.failedCount : 0,
  };
}
