// FG-820: pure decisions for the left-column navigation, split from nav-view.js so they
// are unit-testable without a DOM (the attention-inbox-render.js pattern).
//
// THE BADGE RULE: the browser counts nothing. The Home badge is the attention envelope's
// server-computed `counts` — never `items.length`, never a tally of a filtered list, never
// anything remembered from an earlier read or kept in storage. A read that failed, or an
// envelope with no readable `counts`, shows "?" rather than a number.

import { inboxPhase } from "./attention-inbox-render.js";
import { NAV_GROUPS, ROUTES, carriesScope, hashFor, navItemFor, parseHash } from "./view-routing.js";

export const BADGE_CAP = 99;

/** The five bottom-bar slots below the 720px nav breakpoint. The fifth, More, opens the
 *  drawer and is not a route. */
export const BOTTOM_BAR_ITEMS = Object.freeze(["home", "runs", "queue", "backlog"]);

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function capped(n) {
  return n > BADGE_CAP ? `${BADGE_CAP}+` : String(n);
}

/**
 * The Home badge, as data: null (no badge) or { text, tone, partial, label }.
 *
 * - loading: no badge yet (nothing has been read, so nothing is claimed);
 * - unavailable, or a ready envelope without valid counts: "?" — never 0, never the last number;
 * - `empty: true`: no badge — the only thing that removes it;
 * - otherwise counts.open (capped at 99+), danger-toned when counts.high > 0, and marked
 *   partial when the envelope names degraded sources.
 */
export function homeBadge(load) {
  const phase = inboxPhase(load);
  if (phase === "loading") return null;
  const unknown = { text: "?", tone: "unknown", partial: false, label: "Attention count unavailable" };
  if (phase === "unavailable") return unknown;
  const envelope = load.envelope;
  if (envelope.empty === true) return null;
  const counts = envelope.counts;
  if (!counts || typeof counts !== "object" || !isCount(counts.open) || !isCount(counts.high)) return unknown;
  const partial = Array.isArray(envelope.degraded) && envelope.degraded.length > 0;
  const parts = [`${counts.open} open`];
  if (counts.high > 0) parts.push(`${counts.high} high`);
  if (partial) parts.push("some sources unreadable");
  return {
    text: capped(counts.open),
    tone: counts.high > 0 ? "danger" : "neutral",
    partial,
    label: parts.join(", "),
  };
}

/** The href a nav item points at: list views carry the current scope, scope-less views
 *  and object pages do not. */
export function navHref(view, scope) {
  return hashFor({ view, scope: carriesScope(view) ? scope : null });
}

/** An in-app link carrying the current scope when it names a list view without one of
 *  its own (an inbox row's `#backlog/FG-9` keeps the project the operator is in). */
export function scopedHref(hash, scope) {
  const parsed = parseHash(hash);
  if (parsed.notice) return hash;
  return hashFor({ view: parsed.view, id: parsed.id, tab: parsed.tab, scope: parsed.scope.project ? parsed.scope : scope });
}

/** The whole column as data: groups, their items, hrefs and which one is current. */
export function navModel(view, scope) {
  const current = navItemFor(view);
  return NAV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.map((item) => ({
      view: item,
      label: ROUTES[item].label,
      href: navHref(item, scope),
      current: item === current,
    })),
  }));
}

/** The label a checkout scope button reads as — its branch, else its directory name. */
export function checkoutScopeLabel(checkout) {
  if (checkout.exists === false) {
    return (checkout.branch || checkout.projectDir.split("/").pop()) + " (missing)";
  }
  return checkout.branch || checkout.projectDir.split("/").pop();
}

/** "All projects", "<project>", or "<project> › <checkout>" for the scope control. */
export function scopeSummary(scope, project) {
  if (!scope || !scope.project) return "All projects";
  const label = project?.label || scope.project;
  if (!scope.checkout) return label;
  const checkout = (project?.checkouts || []).find((c) => c.projectDir === scope.checkout);
  return `${label} › ${checkout ? checkoutScopeLabel(checkout) : scope.checkout.split("/").pop()}`;
}
