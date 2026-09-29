// FG-817: the Roles list (#roles) — every installed role seed with its default activity,
// the profile model policy resolves for it, its /project mount and its last task. One
// read of GET /api/roles per visit; roles-index-render.js builds the rows.

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { rolesIndexNotices, rolesIndexRows, rolesIndexSource } from "./roles-index-render.js";

const html = htm.bind(h);

function when(iso) {
  return iso ? new Date(iso).toLocaleString() : "never";
}

export function RolesIndexView() {
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
  const rows = rolesIndexRows(load.body);
  return html`
    <section class="roles-index">
      <p class="role-caption muted" data-caption="roles">${rolesIndexSource(load.body)}</p>
      ${rolesIndexNotices(load.body).map((n) => html`<div class="card muted role-notice" role="status">${n}</div>`)}
      <div class="runs-table-wrap">
        <table class="runs-table roles-table">
          <thead><tr><th>Role</th><th>Default activity</th><th>Resolved profile</th><th>Mount</th><th>Last task</th></tr></thead>
          <tbody>
            ${rows.map((r) => html`
              <tr key=${r.role} data-role=${r.role}>
                <td>
                  <a class="mono" href=${r.href}>${r.role}</a>
                  ${r.settingsMissing ? html` <span class="faint">(no settings.json)</span>` : null}
                  <div class="muted role-description">${r.description}</div>
                </td>
                <td data-col="activity">${r.activity}</td>
                <td data-col="profile">${r.profile}</td>
                <td data-col="mount" title=${r.mountSource}>${r.mount}</td>
                <td data-col="last-task">${when(r.lastTaskAt)}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}
