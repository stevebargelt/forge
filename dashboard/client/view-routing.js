// FG-820: the closed route table. Every hash is `#<path>[?<params>]`; this module is
// the only place that reads or writes one.
//
// The group a view sits under is DERIVED from ROUTES, never carried in the URL: a
// `group=` parameter or a group-shaped leading segment (`#plan/queue`) is dropped and
// the hash canonicalized, so regrouping a view later cannot break a saved link and no
// URL can disagree with the view it names.
//
// Scope (`?project=<projectKey>[&checkout=<URI-encoded projectDir>]`) rides only on
// views whose scope requirement is not `none`. Object pages (`#run/<runId>`,
// `#task/<taskId>`) are addressed by a global id and carry no scope. A route may name
// extra parameters it owns (`params`: the run index's `status=`); any other key is dropped.
// FG-832: the backlog's `type=`/`status=` omit their defaults (all, active), so
// `#backlog?status=active` canonicalizes to `#backlog`. FG-836: `#ops?window=` likewise
// omits the runtime panel's default window (7d), and `#ops?since=` the summary's (7d).
//
// FG-821: object tabs follow the Paperclip pattern — an unknown tab falls back to the
// route's default (its first tab), which the canonical hash omits. FG-817: `#roles` is
// the Roles list and `#roles/<role>[/<tab>]` a role page, with `overview` the default tab.
// Its scope is `object` (FG-835): only a role page carries scope — its Harness rows resolve
// at the scoped checkout — while the list, like Projects, drops it.
// `tabAliases` maps a retired tab name onto its successor (FG-827: `configuration` is now
// `harness`), so a saved link lands on the renamed tab and is canonicalized to it.
// FG-837: the Roles list's `family=` (an FG-829 family) filters it beside FG-828's
// `sort=`/`dir=`; an unknown family is dropped like an unknown sort.
// FG-830: `#notes/<checkout>` names a checkout by its URI-encoded directory, the one id
// that is unique and stable across label changes.
// FG-835: `#models?mode=edit&target=host|project` is the model-policy editor; `target`
// omitted means the scoped project's override when it has one, else the host file.
// FG-844: `#queue?lane=<view>` names the lane the under-900px strip shows (the values are
// queue-board-state.js's BOARD_VIEWS); an unknown lane is dropped, and the board then shows
// its first lane with cards.
// FG-843: `checkout=` rides only on the three views whose answer changes with the
// checkout (`checkout: true` — Routing, Config, Notes); every other view drops it, so a
// project scope alone means the project's primary checkout, silently. The one carve-out is
// a role PAGE (`checkout: "object"`): FG-835's Models rows link to a role's Harness tab at
// the checkout the row was resolved at, and that provenance must survive the link. It is
// never a chooser — nothing on a role page offers another checkout.

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
  backlog: { group: "plan", label: "Backlog", path: "#backlog[/<ticketId>]", scope: "optional", object: "optional", params: ["type", "status"], paramValues: { type: ["epic", "story", "idea"], status: ["all", "blocked", "deferred", "done"] }, aliases: [] },
  notes: { group: "plan", label: "Notes", path: "#notes[/<checkout>]", scope: "optional", checkout: true, object: "optional", aliases: [] },
  queue: { group: "plan", label: "Queue", path: "#queue", scope: "project", object: "none", params: ["lane"], paramValues: { lane: ["backlog", "queued", "in_progress", "blocked", "done", "executing_not_queued"] }, aliases: [] },
  campaigns: { group: "plan", label: "Campaigns", path: "#campaigns[/<campaignId>]", scope: "optional", object: "optional", aliases: [] },
  runs: { group: "evidence", label: "Runs", path: "#runs", scope: "optional", object: "none", params: ["status"], aliases: [] },
  run: { group: "evidence", label: "Run", path: "#run/<runId>[/<tab>]", scope: "none", object: "required", parent: "runs", tabs: ["map", "evidence"], aliases: ["run-map"] },
  task: { group: "evidence", label: "Task", path: "#task/<taskId>[/explain]", scope: "none", object: "required", parent: "runs", tabs: ["detail", "explain"], aliases: [] },
  reviews: { group: "evidence", label: "Reviews", path: "#reviews[/<reviewId>]", scope: "optional", object: "optional", aliases: [] },
  shipping: { group: "evidence", label: "Shipping", path: "#shipping", scope: "project", object: "none", aliases: [] },
  roles: { group: "setup", label: "Roles", path: "#roles[/<role>[/<tab>]]", scope: "object", checkout: "object", object: "optional", tabs: ["overview", "instructions", "harness", "skills", "capabilities", "tools", "secrets", "tasks", "receipts", "usage"], tabAliases: { configuration: "harness" }, params: ["family", "sort", "dir"], paramValues: { family: ["build", "red", "research", "test", "review", "plan", "author"], sort: ["role", "activity", "profile", "mount", "lastTask"], dir: ["asc", "desc"] }, aliases: [] },
  routing: { group: "setup", label: "Routing", path: "#routing", scope: "checkout", checkout: true, object: "none", params: ["mode"], paramValues: { mode: ["edit"] }, aliases: ["governance"] },
  models: { group: "setup", label: "Models", path: "#models", scope: "optional", object: "none", params: ["mode", "target"], paramValues: { mode: ["edit"], target: ["host", "project"] }, aliases: [] },
  config: { group: "setup", label: "Config", path: "#config", scope: "checkout", checkout: true, object: "none", aliases: ["control-plane"] },
  projects: { group: "setup", label: "Projects", path: "#projects", scope: "none", object: "none", aliases: [] },
  usage: { group: "health", label: "Usage", path: "#usage", scope: "optional", object: "none", aliases: [] },
  ops: { group: "health", label: "Ops", path: "#ops", scope: "optional", object: "none", params: ["since", "window"], paramValues: { since: ["30d", "all"], window: ["1d", "30d", "90d", "all"] }, aliases: [] },
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

/** Whether a location carries scope; `id` matters only to a route whose scope is `object`. */
export function carriesScope(view, id = null) {
  const route = ROUTES[view];
  if (!route || route.scope === "none") return false;
  return route.scope !== "object" || Boolean(id);
}

/** Whether a view's hash carries `checkout=` (FG-843): Routing, Config and Notes — and a
 *  role page, whose checkout is FG-835's resolution provenance, not a choice. */
export function carriesCheckout(view, id = null) {
  const carried = ROUTES[view]?.checkout;
  return carried === true || (carried === "object" && Boolean(id));
}

function normalizeScope(scope, view = null, id = null) {
  const project = scope && typeof scope.project === "string" && scope.project !== "" ? scope.project : null;
  const checkout = project && (view === null || carriesCheckout(view, id)) && typeof scope.checkout === "string" && scope.checkout !== "" ? scope.checkout : null;
  return { project, checkout };
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function routeParams(route, params, id) {
  if (!route.params || !params || (route.object !== "none" && id)) return [];
  return route.params
    .filter((key) => typeof params[key] === "string" && params[key] !== "")
    .filter((key) => !route.paramValues?.[key] || route.paramValues[key].includes(params[key]))
    .map((key) => `${key}=${encodeURIComponent(params[key])}`);
}

/** The canonical hash for a location. Unscoped home is `#home`. */
export function hashFor({ view, id = null, tab = null, scope = null, params = null }) {
  const route = ROUTES[view] ?? ROUTES.home;
  const name = ROUTES[view] ? view : "home";
  let path = `#${name}`;
  if (route.object !== "none" && id) {
    path += `/${encodeURIComponent(id)}`;
    if (route.tabs && tab && tab !== route.tabs[0] && route.tabs.includes(tab)) path += `/${encodeURIComponent(tab)}`;
  }
  const query = [];
  const { project, checkout } = carriesScope(name, route.object !== "none" ? id : null) ? normalizeScope(scope, name, route.object !== "none" ? id : null) : NO_SCOPE;
  if (project) query.push(`project=${encodeURIComponent(project)}`);
  if (checkout) query.push(`checkout=${encodeURIComponent(checkout)}`);
  query.push(...routeParams(route, params, route.object !== "none" ? id : null));
  return query.length > 0 ? `${path}?${query.join("&")}` : path;
}

/**
 * Parse a location hash into { view, group, id, tab, scope, params, canonical, rewrite, notice }.
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
  const routeParamsIn = {};

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
      if (route.tabs) {
        const named = segments[2] ? safeDecode(segments[2]) : null;
        const resolved = named !== null ? route.tabAliases?.[named] ?? named : null;
        tab = resolved !== null && route.tabs.includes(resolved) ? resolved : route.tabs[0];
      }
      if (route.object === "required" && !id) {
        notice = `Open a ${ROUTES[view].label.toLowerCase()} from the run index to see it.`;
        view = "runs";
        tab = null;
        scope = NO_SCOPE;
      }
    }
  }

  if (!carriesScope(view, id)) scope = NO_SCOPE;
  else scope = normalizeScope(scope, view, id);
  const owner = ROUTES[view];
  if (!(owner.object !== "none" && id)) {
    for (const key of owner.params ?? []) {
      const value = params.get(key);
      if (value && (!owner.paramValues?.[key] || owner.paramValues[key].includes(value))) routeParamsIn[key] = value;
    }
  }
  const canonical = hashFor({ view, id, tab, scope, params: routeParamsIn });
  const rewrite = raw !== "" && `#${raw}` !== canonical;
  return { view, group: groupOf(view), id, tab, scope, params: routeParamsIn, canonical, rewrite, notice };
}
