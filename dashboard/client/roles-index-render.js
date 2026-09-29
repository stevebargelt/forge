// FG-817: the Roles list (#roles), as data — pure, so a unit test over this and the
// browser suite over the rendered table mean the same thing. Every value is read from
// GET /api/roles; nothing is counted or resolved in the browser.

import { ROUTES, hashFor } from "./view-routing.js";

function dash(value) {
  return typeof value === "string" && value !== "" ? value : "—";
}

/** "claude-subscription · claude-sonnet-5 · effort low" — the profile the policy resolves
 *  for the role's default activity, or why it could not. */
export function profileLabel(role) {
  if (role.resolutionError) return `unresolved: ${role.resolutionError}`;
  if (!role.profile) return role.model ? `legacy · ${role.model}` : "legacy (no model policy)";
  return [role.profile, role.model, role.effort ? `effort ${role.effort}` : null].filter(Boolean).join(" · ");
}

export function mountLabel(mode) {
  return mode === "ro" ? "read-only" : mode === "rw" ? "read-write" : "—";
}

export function rolesIndexRows(body) {
  if (!body || !Array.isArray(body.roles)) return [];
  return body.roles.map((r) => ({
    role: r.role,
    href: hashFor({ view: "roles", id: r.role }),
    description: dash(r.description),
    activity: dash(r.defaultActivity),
    profile: profileLabel(r),
    mount: mountLabel(r.mountMode),
    profileResolved: Boolean(r.profile) && !r.resolutionError,
    mountSource: r.mountModeSource ?? "",
    lastTaskAt: r.lastTaskAt ?? null,
    settingsMissing: r.settings === false,
  }));
}

// FG-828: the list's sortable columns, in header order. The route table owns the
// vocabulary so an unknown `?sort=` is dropped from the hash before it gets here.
export const ROLE_SORT_COLUMNS = ROUTES.roles.paramValues.sort;
export const ROLE_SORT_DEFAULT = Object.freeze({ column: "role", dir: "asc" });

/** The sort a `#roles` hash's params name, or the default for anything it does not. */
export function rolesSortState(params) {
  const column = ROLE_SORT_COLUMNS.includes(params?.sort) ? params.sort : ROLE_SORT_DEFAULT.column;
  const dir = params?.dir === "asc" || params?.dir === "desc" ? params.dir : ROLE_SORT_DEFAULT.dir;
  return { column, dir };
}

/** The hash a header click writes: ascending on a new column, flipped on the active one. */
export function rolesSortHash(state, column) {
  const dir = state.column === column && state.dir === "asc" ? "desc" : "asc";
  return hashFor({ view: "roles", params: { sort: column, dir } });
}

// The value a row sorts on, or null when it has none. lastTask sorts on the ISO
// timestamp, never on its formatted "2h ago".
function sortValue(row, column) {
  switch (column) {
    case "activity": return row.activity === "—" ? null : row.activity.toLowerCase();
    case "profile": return row.profileResolved ? row.profile.toLowerCase() : null;
    case "mount": return row.mount === "—" ? null : row.mount;
    case "lastTask": {
      const at = row.lastTaskAt ? Date.parse(row.lastTaskAt) : NaN;
      return Number.isNaN(at) ? null : at;
    }
    default: return row.role.toLowerCase();
  }
}

function byName(a, b) {
  const x = a.role.toLowerCase();
  const y = b.role.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
}

/** The rows ordered by one column. A missing value sorts last in both directions; ties
 *  fall back to role name ascending. Returns a new array. */
export function sortRoles(rows, column, dir) {
  const col = ROLE_SORT_COLUMNS.includes(column) ? column : ROLE_SORT_DEFAULT.column;
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, col);
    const y = sortValue(b, col);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
    } else if (x !== y) {
      return (x < y ? -1 : 1) * sign;
    }
    return col === "role" ? byName(a, b) * sign : byName(a, b);
  });
}

/** One-line notices the list owes the operator: no generation, a torn install, an
 *  unreadable model policy or store. */
export function rolesIndexNotices(body) {
  if (!body) return [];
  const out = [];
  if (!body.generation) out.push(`No seed generation is published (${body.seedInstall?.kind ?? "unknown"}): protocols, runtimes and the routing policy cannot be read. Run forge upgrade.`);
  if (body.seedInstall?.reason) out.push(body.seedInstall.reason);
  if (body.modelPolicy?.error) out.push(`Model policy unreadable: ${body.modelPolicy.error}`);
  if (body.storeError) out.push(`Store unreadable, so last-task times are missing: ${body.storeError}`);
  if (Array.isArray(body.roles) && body.roles.length === 0) out.push(`No role seed is installed under ${body.agentsDir ?? "$FORGE_HOME/agents"}. Run forge upgrade.`);
  return out;
}

/** The list's caption: where every column was read from. */
export function rolesIndexSource(body) {
  const gen = body?.generation ? `seed generation ${body.generation.id}` : "no seed generation";
  const policy = body?.modelPolicy?.path ?? `model policy ${body?.modelPolicy?.source ?? "unknown"}`;
  return `Source: ${body?.agentsDir ?? "$FORGE_HOME/agents"}; ${gen}; ${policy}; tasks in forge.db`;
}
