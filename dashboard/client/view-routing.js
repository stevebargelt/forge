// FG-820: the closed route table. Every hash is `#<path>[?<params>]`; this module is
// the only place that reads or writes one.
//
// The group a view sits under is DERIVED from ROUTES, never carried in the URL: a
// `group=` parameter or a group-shaped leading segment (`#plan/queue`) is dropped and
// the hash canonicalized, so regrouping a view later cannot break a saved link and no
// URL can disagree with the view it names.
//
// Scope (`?project=<projectKey>[&checkout=<URI-encoded projectDir>]`) rides only on
// views whose scope requirement is not `none`. Object pages (`#run-map/<runId>`) are
// addressed by a global id and carry no scope. Any other parameter key is dropped.

export const GROUPS = Object.freeze([
  { id: "now", label: "Now" },
  { id: "plan", label: "Plan" },
  { id: "evidence", label: "Evidence" },
  { id: "setup", label: "Setup" },
  { id: "health", label: "Health" },
]);

// `object`: whether the path takes an id segment (`none | optional | required`).
// `parent`: the nav item an object page highlights. Order within a group is nav order.
export const ROUTES = Object.freeze({
  home: { group: "now", label: "Home", path: "#home", scope: "optional", object: "none", aliases: [] },
  activity: { group: "now", label: "Activity", path: "#activity", scope: "optional", object: "none", aliases: [] },
  backlog: { group: "plan", label: "Backlog", path: "#backlog[/<ticketId>]", scope: "optional", object: "optional", aliases: [] },
  queue: { group: "plan", label: "Queue", path: "#queue", scope: "project", object: "none", aliases: [] },
  campaigns: { group: "plan", label: "Campaigns", path: "#campaigns[/<campaignId>]", scope: "optional", object: "optional", aliases: [] },
  runs: { group: "evidence", label: "Runs", path: "#runs", scope: "optional", object: "none", aliases: [] },
  "run-map": { group: "evidence", label: "Run Map", path: "#run-map/<runId>[/<tab>]", scope: "none", object: "required", parent: "runs", tabs: ["map"], aliases: ["run"] },
  reviews: { group: "evidence", label: "Reviews", path: "#reviews[/<reviewId>]", scope: "optional", object: "optional", aliases: [] },
  shipping: { group: "evidence", label: "Shipping", path: "#shipping", scope: "project", object: "none", aliases: [] },
  roles: { group: "setup", label: "Roles", path: "#roles", scope: "none", object: "none", aliases: [] },
  routing: { group: "setup", label: "Routing", path: "#routing", scope: "checkout", object: "none", aliases: ["governance"] },
  config: { group: "setup", label: "Config", path: "#config", scope: "checkout", object: "none", aliases: ["control-plane"] },
  projects: { group: "setup", label: "Projects", path: "#projects", scope: "none", object: "none", aliases: [] },
  usage: { group: "health", label: "Usage", path: "#usage", scope: "optional", object: "none", aliases: [] },
  ops: { group: "health", label: "Ops", path: "#ops", scope: "optional", object: "none", aliases: [] },
});

const ALIASES = Object.freeze(
  Object.fromEntries(Object.entries(ROUTES).flatMap(([view, route]) => route.aliases.map((alias) => [alias, view])))
);
const GROUP_IDS = new Set(GROUPS.map((g) => g.id));
const NO_SCOPE = Object.freeze({ project: null, checkout: null });

/** The nav column: each group with the views that are its items (object pages excluded). */
export const NAV_GROUPS = Object.freeze(
  GROUPS.map((group) => ({
    ...group,
    items: Object.entries(ROUTES)
      .filter(([, route]) => route.group === group.id && route.object !== "required")
      .map(([view]) => view),
  }))
);

export function groupOf(view) {
  return ROUTES[view]?.group ?? null;
}

/** The nav item that reads as current for a view: an object page highlights its parent. */
export function navItemFor(view) {
  const route = ROUTES[view];
  if (!route) return null;
  return route.parent ?? view;
}

export function carriesScope(view) {
  const route = ROUTES[view];
  return Boolean(route) && route.scope !== "none";
}

function normalizeScope(scope) {
  const project = scope && typeof scope.project === "string" && scope.project !== "" ? scope.project : null;
  const checkout = project && typeof scope.checkout === "string" && scope.checkout !== "" ? scope.checkout : null;
  return { project, checkout };
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The canonical hash for a location. Unscoped home is `#home`. */
export function hashFor({ view, id = null, tab = null, scope = null }) {
  const route = ROUTES[view] ?? ROUTES.home;
  const name = ROUTES[view] ? view : "home";
  let path = `#${name}`;
  if (route.object !== "none" && id) {
    path += `/${encodeURIComponent(id)}`;
    if (route.tabs && tab && tab !== route.tabs[0] && route.tabs.includes(tab)) path += `/${encodeURIComponent(tab)}`;
  }
  if (route.scope === "none") return path;
  const { project, checkout } = normalizeScope(scope);
  if (!project) return path;
  path += `?project=${encodeURIComponent(project)}`;
  if (checkout) path += `&checkout=${encodeURIComponent(checkout)}`;
  return path;
}

/**
 * Parse a location hash into { view, group, id, tab, scope, canonical, rewrite, notice }.
 *
 * `rewrite` is true when the hash is not already canonical — the caller replaces it with
 * `canonical` via history.replaceState. `notice` is a one-line operator message when the
 * hash could not be honoured as written (an unknown view, a bare run map).
 */
export function parseHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const q = raw.indexOf("?");
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  const scopeIn = normalizeScope({ project: params.get("project"), checkout: params.get("checkout") });

  const segments = pathPart.split("/").filter((s) => s !== "");
  if (segments.length > 0 && GROUP_IDS.has(segments[0].toLowerCase()) && !ROUTES[segments[0]]) segments.shift();

  let notice = null;
  let view;
  let id = null;
  let tab = null;
  let scope = scopeIn;

  if (segments.length === 0) {
    view = "home";
  } else {
    const name = safeDecode(segments[0]);
    view = ROUTES[name] ? name : ALIASES[name] ?? null;
    if (view === null) {
      view = "home";
      scope = NO_SCOPE;
      notice = `No view named “${name}”. Showing Home.`;
    } else {
      const route = ROUTES[view];
      if (route.object !== "none" && segments[1]) id = safeDecode(segments[1]);
      if (route.tabs) tab = segments[2] && route.tabs.includes(safeDecode(segments[2])) ? safeDecode(segments[2]) : route.tabs[0];
      if (route.object === "required" && !id) {
        view = "activity";
        tab = null;
        scope = NO_SCOPE;
        notice = "Open a run from the activity feed to see its Run Map.";
      }
    }
  }

  if (!carriesScope(view)) scope = NO_SCOPE;
  const canonical = hashFor({ view, id, tab, scope });
  const rewrite = raw !== "" && `#${raw}` !== canonical;
  return { view, group: groupOf(view), id, tab, scope, canonical, rewrite, notice };
}
