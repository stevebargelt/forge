// FG-817: the Roles list (#roles) — every installed role seed with its default activity,
// the profile model policy resolves for it, its /project mount and its last task. One
// read of GET /api/roles per visit; roles-index-render.js builds the rows. FG-828: the
// header buttons sort that payload in place — the sort rides the hash
// (`#roles?sort=<column>&dir=asc|desc`) and changing it never refetches.
// FG-837: laid out after Paperclip's agent list — a lede, family filter tabs
// (`#roles?family=<f>`, composing with the sort) with the count and the sort on the right,
// then one bordered panel of rows: tile · name and a one-line subtitle · model over
// profile · family · activity · last task · mount pill. The header buttons stay FG-828's,
// drawn as a light caption row; the Source line is the faint footer.

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { formatRelativeTime, formatTimestamp } from "./format.js";
import { RoleTile } from "./role-glyph-view.js";
import { TILE_SIZES } from "./role-glyph.js";
import {
  filterRolesByFamily, rolesCountLabel, rolesFamilyHash, rolesFamilyState, rolesFamilyTabs, rolesIndexNotices, rolesIndexRows,
  rolesIndexSource, rolesSortHash, rolesSortLabel, rolesSortState, sortRoles,
} from "./roles-index-render.js";

const html = htm.bind(h);

// Mock order: name, model, family · activity, last task, mount.
const COLUMNS = [
  ["role", "Role"],
  ["profile", "Model"],
  ["activity", "Family · activity"],
  ["lastTask", "Last task"],
  ["mount", "Mount"],
];

function SortHeader({ column, label, sort, family }) {
  const active = sort.column === column;
  const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  return html`
    <th aria-sort=${ariaSort} data-sort=${column} class=${`roles-col-${column}`}>
      <button type="button" class="sort-header" onClick=${() => { window.location.hash = rolesSortHash(sort, column, family); }}>
        ${label}<span class=${active ? "sort-glyph" : "sort-glyph faint"} aria-hidden="true">${active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  `;
}

function FamilyTabs({ tabs, params }) {
  return html`
    <div class="roles-family-tabs" role="group" aria-label="Family">
      ${tabs.map((t) => html`
        <button key=${t.id} type="button" class=${"roles-family-tab" + (t.current ? " roles-family-tab-current" : "")} data-family=${t.id}
          aria-pressed=${t.current ? "true" : "false"} onClick=${() => { window.location.hash = rolesFamilyHash(params, t.id); }}>${t.label}</button>
      `)}
    </div>
  `;
}

export function RolesIndexView({ params = null }) {
  const [load, setLoad] = useState({ body: null, error: null });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/roles")
      .then(async (res) => (res.ok ? { body: await res.json(), error: null } : { body: null, error: `Roles read failed (HTTP ${res.status}).` }))
      .catch((e) => ({ body: null, error: String(e) }))
      .then((next) => { if (!cancelled) setLoad(next); });
    return () => { cancelled = true; };
  }, []);

  if (load.error) return html`<div class="card" style="color: var(--err);" role="alert">${load.error}</div>`;
  if (!load.body) return html`<div class="muted roles-loading">loading roles…</div>`;
  const sort = rolesSortState(params);
  const family = rolesFamilyState(params);
  const all = rolesIndexRows(load.body);
  const rows = sortRoles(filterRolesByFamily(all, family), sort.column, sort.dir);
  const now = Date.now();
  return html`
    <section class="roles-index">
      <p class="roles-lede">What each role is and runs on. A seed changes only through <code class="mono">forge upgrade</code>.</p>
      ${rolesIndexNotices(load.body).map((n) => html`<div class="card muted role-notice" role="status">${n}</div>`)}
      <div class="roles-toolbar">
        <${FamilyTabs} tabs=${rolesFamilyTabs(all, family)} params=${params} />
        <span class="roles-toolbar-meta" aria-live="polite">
          <span data-roles-count>${rolesCountLabel(rows.length)}</span>
          <span data-roles-sort>${rolesSortLabel(sort)}</span>
        </span>
      </div>
      <div class="roles-panel">
        <table class="roles-table">
          <thead><tr>${COLUMNS.map(([column, label]) => html`<${SortHeader} key=${column} column=${column} label=${label} sort=${sort} family=${family} />`)}</tr></thead>
          <tbody>
            ${rows.length === 0 ? html`<tr class="roles-empty"><td colspan=${COLUMNS.length} class="muted">No role in this family.</td></tr>` : null}
            ${rows.map((r) => html`
              <tr key=${r.role} data-role=${r.role} data-family=${r.family}>
                <td>
                  <div class="roles-ident">
                    <span class="role-name"><${RoleTile} role=${r.role} size=${TILE_SIZES.list} /><a href=${r.href}>${r.role}</a></span>
                    ${r.settingsMissing ? html`<span class="roles-flag" data-settings-missing>no settings.json</span>` : null}
                    <div class="role-subtitle" title=${r.description}>${r.subtitle}</div>
                  </div>
                </td>
                <td data-col="profile" title=${r.profile}><div class="mono role-model">${r.model}</div><div class="role-profile">${r.profileLine}</div></td>
                <td class="roles-fam"><span data-col="family">${r.family}</span> · <span data-col="activity">${r.activity}</span></td>
                <td data-col="last-task" class="roles-when" title=${formatTimestamp(r.lastTaskAt, "")}>${r.lastTaskAt ? formatRelativeTime(r.lastTaskAt, now) : "never"}</td>
                <td data-col="mount" title=${r.mountSource}><span class=${`role-pill role-pill-${r.mountMode ?? "none"}`}>${r.mount}</span></td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      <p class="role-caption role-footer faint" data-caption="roles">${rolesIndexSource(load.body)}</p>
    </section>
  `;
}
