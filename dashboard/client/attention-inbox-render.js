// FG-402: pure decision logic for the Human Attention Inbox surface, split out of the
// view for the same reason current-activity-render.js was — the render decisions
// (badge class + label per kind, severity label, link target, age string, and the
// loading/ready/unavailable/empty load state) are unit-testable with the node test
// runner, and a producer/renderer field mismatch cannot then hide behind a green suite.
//
// THE ONE RULE THIS MODULE ENFORCES (mirrors current-activity-render.js's AC7): a
// FAILED or MALFORMED read NEVER renders as an observed empty inbox. The envelope's
// empty state ("No human action is currently needed") is reachable ONLY from a payload
// this module validated; every failure resolves to an explicit `unavailable` state with
// a Retry, never to the calm empty copy.

import { caElapsedText } from "./current-activity-render.js";

/** Surface-level copy. Deliberately about the SURFACE, never about the work. */
export const INBOX_UNAVAILABLE_LABEL = "Attention inbox unavailable";
export const INBOX_LOADING_LABEL = "Loading attention inbox…";
/** The one calm statement for a SUCCESSFUL read that found nothing to act on. Reachable
 *  only from a payload we actually parsed and validated. */
export const INBOX_EMPTY_LABEL = "No human action is currently needed";

/** Per-kind badge label + class, keyed on the STRUCTURED kind (never a substring of any
 *  rendered text) so a theme change never re-derives meaning. */
const KIND_META = {
  waiting_gate: { label: "Waiting on gate", class: "inbox-kind-waiting_gate" },
  campaign_paused: { label: "Campaign paused", class: "inbox-kind-campaign_paused" },
  blocked_by_red_or_reviewer: { label: "Blocked by review", class: "inbox-kind-blocked_by_red_or_reviewer" },
  missing_acceptance_or_readiness: { label: "Readiness gap", class: "inbox-kind-missing_acceptance_or_readiness" },
  auth_setup: { label: "Auth / setup", class: "inbox-kind-auth_setup" },
  merge_conflict: { label: "Merge conflict", class: "inbox-kind-merge_conflict" },
  integration_blocked_park: { label: "Integration parked", class: "inbox-kind-integration_blocked_park" },
};

const SEVERITY_LABELS = { high: "high", medium: "medium", low: "low" };

/** The badge (class + label) for an item's kind. An unrecognized kind reads as itself
 *  under a neutral class rather than throwing — forward tolerant of a kind a newer
 *  server adds. */
export function inboxItemBadge(item) {
  const kind = item && typeof item === "object" ? item.kind : undefined;
  const meta = (typeof kind === "string" && KIND_META[kind]) || null;
  return meta ? { class: meta.class, label: meta.label } : { class: "inbox-kind-unknown", label: typeof kind === "string" && kind !== "" ? kind : "attention" };
}

/** The severity label + class. A known severity reads as its word; an unknown/absent one
 *  reads as the explicit "priority unknown", never a fabricated level. */
export function inboxSeverityBadge(item) {
  const severity = item && typeof item === "object" ? item.severity : undefined;
  const label = (typeof severity === "string" && SEVERITY_LABELS[severity]) || null;
  return label
    ? { class: `inbox-sev-${severity}`, label }
    : { class: "inbox-sev-unknown", label: "priority unknown" };
}

/** Where a row links, by kind: run/task blockers → the run map; a ticket readiness gap →
 *  backlog; a campaign pause → campaigns; an auth/setup wall → the control-plane surface.
 *  Returns null when the item carries no id the target needs (so the row renders with no
 *  link rather than a dead one). */
export function inboxItemLink(item) {
  if (!item || typeof item !== "object") return null;
  const links = item.links && typeof item.links === "object" ? item.links : {};
  const runId = typeof links.runId === "string" && links.runId !== "" ? links.runId : null;
  const ticketId = typeof links.ticketId === "string" && links.ticketId !== "" ? links.ticketId : null;
  switch (item.kind) {
    case "auth_setup":
      return { hash: "#control-plane", label: "Open control plane" };
    case "campaign_paused":
      return { hash: "#campaigns", label: "Open campaigns" };
    case "missing_acceptance_or_readiness":
      return ticketId ? { hash: "#backlog", label: `Open ${ticketId}` } : { hash: "#backlog", label: "Open backlog" };
    case "waiting_gate":
    case "blocked_by_red_or_reviewer":
    case "merge_conflict":
    case "integration_blocked_park":
      if (runId) return { hash: `#run-map/${encodeURIComponent(runId)}`, label: "Open run" };
      if (ticketId) return { hash: "#backlog", label: `Open ${ticketId}` };
      return null;
    default:
      if (runId) return { hash: `#run-map/${encodeURIComponent(runId)}`, label: "Open run" };
      if (ticketId) return { hash: "#backlog", label: `Open ${ticketId}` };
      return null;
  }
}

/** The whole render decision for ONE item, as data — the view is a rendering of this and
 *  adds no decisions of its own, so a test over this and a test over the DOM mean the
 *  same thing. */
export function inboxItemSummary(item) {
  const badge = inboxItemBadge(item);
  const severity = inboxSeverityBadge(item);
  const links = item && typeof item === "object" && item.links && typeof item.links === "object" ? item.links : {};
  return {
    id: item && typeof item === "object" ? item.id : undefined,
    kind: item && typeof item === "object" ? item.kind : undefined,
    badgeClass: badge.class,
    badgeLabel: badge.label,
    severityClass: severity.class,
    severityLabel: severity.label,
    reason: item && typeof item.reason === "string" ? item.reason : "",
    requestedAction: item && typeof item.requestedAction === "string" ? item.requestedAction : "",
    startedAt: item && typeof item === "object" ? item.startedAt ?? null : null,
    source: item && typeof item.source === "string" ? item.source : "",
    ticketId: typeof links.ticketId === "string" && links.ticketId !== "" ? links.ticketId : null,
    projectLabel: typeof links.projectLabel === "string" && links.projectLabel !== "" ? links.projectLabel : null,
    link: inboxItemLink(item),
  };
}

/** The age string for an item, reusing the SAME elapsed formatter Current activity uses
 *  so the two surfaces read time identically. */
export function inboxItemAge(item, now) {
  return caElapsedText(item && typeof item === "object" ? item.startedAt : null, now);
}

// ─────────────────── The dereference contract (mirrors FG-694) ───────────────────
//
// The ONE table of what the render path dereferences per entry, at every depth it walks
// into — so a `[null]` items array is a FAILED read, not a payload that validates and
// then throws mid-render on `item.id`. `id` is the row key (a non-empty string), `kind`
// drives the badge; reason/requestedAction/severity/links are all read THROUGH guards in
// inboxItemSummary and render as text or drive a class, so they never crash and are
// deliberately not required (an older field-shape may omit them).

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value !== "";
}
function isArrayOf(value, valid) {
  return Array.isArray(value) && value.every(valid);
}

/** Is this a renderable inbox item? The id (row key) and kind (badge driver) are the
 *  crash surfaces; both must be present non-empty strings. */
export function isRenderableInboxItem(value) {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.kind);
}

/** Is this actually an attention-inbox envelope? A 200 carrying an {error} body, an HTML
 *  error page, or a truncated body is NOT an empty inbox — it is a read that failed, and
 *  saying so (never rendering the calm empty copy from it) is the whole point. Validated
 *  at every depth the renderer walks: `items` must be an array and every member a
 *  renderable item. */
export function isAttentionInboxPayload(value) {
  if (!isPlainObject(value)) return false;
  // An explicit {error} body from the degraded route is not a payload.
  if (typeof value.error === "string") return false;
  return isArrayOf(value.items, isRenderableInboxItem);
}

/** How a read FAILED. Kept structured so a 404 can name the one useful thing (the server
 *  predates the route). */
export function inboxUnavailable(reason, status = null) {
  return Object.freeze({ phase: "unavailable", reason, status: typeof status === "number" ? status : null });
}

export const INBOX_LOADING = Object.freeze({ phase: "loading" });

/** A parsed response body → a load state. The ONLY door from a network read into
 *  `ready`, so nothing renders as an observed inbox without having passed validation. */
export function inboxFromBody(body) {
  if (!isAttentionInboxPayload(body)) return inboxUnavailable("malformed");
  return { phase: "ready", envelope: body };
}

export const INBOX_TIMEOUT_MS = 8000;

/** Reads /api/attention-inbox. NEVER rejects — its failure IS its return value, so no
 *  caller can drop it on the floor and let a stale render linger. Shares the reader
 *  contract with readCurrentActivity, so `createActivityReader` drives it unchanged. */
export async function readAttentionInbox(url, fetchImpl, timeoutMs = INBOX_TIMEOUT_MS) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (doFetch === null) return inboxUnavailable("network");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res || res.ok !== true) return inboxUnavailable("http", res ? res.status : null);
    let body;
    try {
      body = await res.json();
    } catch {
      return inboxUnavailable("malformed");
    }
    return inboxFromBody(body);
  } catch (e) {
    return inboxUnavailable(e && e.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

export function inboxPhase(load) {
  if (!load || typeof load !== "object") return "loading";
  if (load.phase === "ready" && isAttentionInboxPayload(load.envelope)) return "ready";
  if (load.phase === "unavailable") return "unavailable";
  if (load.phase === "ready") return "unavailable"; // a `ready` with no readable envelope is not ready
  return "loading";
}

/** What went wrong, in operator words. Never speculates about the WORK — only the read. */
export function inboxUnavailableDetail(load) {
  const reason = load && typeof load === "object" ? load.reason : undefined;
  const status = load && typeof load === "object" && typeof load.status === "number" ? load.status : null;
  switch (reason) {
    case "http":
      return status === 404
        ? "/api/attention-inbox answered 404 — this dashboard server predates the route; restart it from the current forge."
        : `/api/attention-inbox answered ${status === null ? "an error" : status}.`;
    case "malformed":
      return "/api/attention-inbox answered with a body this client could not read.";
    case "timeout":
      return "/api/attention-inbox did not answer in time.";
    case "network":
      return "/api/attention-inbox could not be reached.";
    default:
      return "/api/attention-inbox could not be read.";
  }
}

/** The WHOLE inbox decision, as data. loading / unavailable carry NO items and NO empty
 *  claim; ready carries the item summaries and the honest `empty` flag. A read that
 *  failed can never produce `empty: true`, which is the whole of the honesty rule. */
export function inboxView(load) {
  const phase = inboxPhase(load);
  if (phase === "loading") {
    return { phase, message: INBOX_LOADING_LABEL, items: [], empty: false, degraded: [] };
  }
  if (phase === "unavailable") {
    return {
      phase,
      message: INBOX_UNAVAILABLE_LABEL,
      detail: inboxUnavailableDetail(load),
      retry: true,
      items: [],
      empty: false,
      degraded: [],
    };
  }
  const envelope = load.envelope;
  const items = envelope.items.map(inboxItemSummary);
  const degraded = Array.isArray(envelope.degraded) ? envelope.degraded : [];
  // Genuinely empty (all sources read OK, nothing to act on) is a DIFFERENT fact from a
  // partial-read failure that happened to return no items: only the former earns the calm
  // "no action needed" copy. A zero-item read with a degraded source keeps `empty: false`
  // so the view shows the degraded warning, never the empty state (invariant #4).
  const empty = items.length === 0 && degraded.length === 0;
  return {
    phase,
    items,
    empty,
    message: empty ? INBOX_EMPTY_LABEL : null,
    degraded,
  };
}
