// forge-dashboard — Routing / Governance view (#285).
//
// READ-ONLY observability of the effective RACI-derived routing policy for the
// current project (or the host default). Mirrors `forge route governance --json`
// via /api/governance. No mutation: there is no apply/edit control here by design.

import { h } from "https://esm.sh/preact@10.24.0";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

const list = (arr) => (arr && arr.length ? arr.join(", ") : "—");
const informedList = (arr) =>
  arr && arr.length ? arr.map((t) => (t.when ? `${t.name}:${t.when}` : t.name)).join(", ") : "—";

export function GovernanceView({ data }) {
  if (!data) return html`<div class="muted">loading governance…</div>`;

  return html`
    <section class="gov-view">
      ${SourceHeader({ data })}
      ${!data.ok
        ? html`<div class="card gov-card gov-error">
            <div class="gov-warn-title">This routing source is unhealthy — not a normal route table.</div>
            ${data.findings.map((f) => Finding({ f }))}
          </div>`
        : html`
            ${data.drift && data.drift.length ? DriftBanner({ drift: data.drift, source: data.source }) : null}
            ${RouteMatrix({ routes: data.routes })}
            ${data.diff ? OverrideDiff({ diff: data.diff }) : null}
          `}
      ${AuditPanel({ entries: data.recentAudit })}
    </section>
  `;
}

function SourceHeader({ data }) {
  const cls = data.source === "project" ? "gov-src-project" : "gov-src-host";
  return html`
    <div class="row gov-header" style="gap: 12px; align-items: baseline; flex-wrap: wrap;">
      <span class=${"badge " + cls}>source: ${data.source}</span>
      <span class="mono muted">${data.path}</span>
      ${data.ok ? html`<span class="muted">accountable: <strong>${data.accountable}</strong> (always human)</span>` : null}
    </div>
  `;
}

function Finding({ f }) {
  return html`
    <div class="row gov-finding" style="gap: 8px; align-items: baseline;">
      <span class="badge gov-bad">${f.code}</span>
      ${f.route ? html`<span class="mono">${f.route}</span>` : null}
      <span>${f.message}</span>
    </div>
  `;
}

function DriftBanner({ drift, source }) {
  const fix = "forge route compile" + (source === "project" ? " --project <dir>" : "");
  return html`
    <div class="card gov-card gov-drift">
      <div class="gov-warn-title">⚠ DRIFT — the compiled policy is stale vs its RACI source. The table below may not match the live rules. Run: <span class="mono">${fix}</span></div>
      ${drift.map((f) => Finding({ f }))}
    </div>
  `;
}

function RouteMatrix({ routes }) {
  const keys = Object.keys(routes);
  return html`
    <h2>Route matrix <span class="muted" style="font-weight: normal;">(${keys.length})</span></h2>
    <div class="card gov-card" style="overflow-x: auto;">
      <table class="gov-table">
        <thead>
          <tr>
            <th>route</th><th>path</th><th>responsible</th><th>command</th>
            <th>consulted</th><th>followups</th><th>informed</th><th>force rules</th>
          </tr>
        </thead>
        <tbody>
          ${keys.map((k) => {
            const r = routes[k];
            return html`
              <tr>
                <td>
                  <div class="mono gov-route-key">${k}</div>
                  ${r.classification_hints && r.classification_hints.length
                    ? html`<div class="faint gov-hints">${r.classification_hints.join(", ")}</div>`
                    : null}
                </td>
                <td><span class="badge gov-path">${r.path}</span></td>
                <td class="mono">${r.responsible}</td>
                <td class="mono faint">${r.command ?? "—"}</td>
                <td>${list(r.consulted)}</td>
                <td>${list(r.required_followups)}</td>
                <td>${informedList(r.informed)}</td>
                <td>${list(r.force_rules)}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}

function OverrideDiff({ diff }) {
  const empty = diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;
  return html`
    <h2 style="margin-top: 20px;">Host → project override</h2>
    <div class="card gov-card">
      ${empty
        ? html`<div class="muted">Project routing is identical to host.</div>`
        : html`
            ${diff.added.length ? html`<div class="gov-diff-line"><span class="badge gov-added">added</span> <span class="mono">${diff.added.join(", ")}</span></div>` : null}
            ${diff.removed.length ? html`<div class="gov-diff-line"><span class="badge gov-removed">removed</span> <span class="mono">${diff.removed.join(", ")}</span></div>` : null}
            ${diff.modified.map((m) => html`
              <div class="gov-diff-line">
                <span class="badge gov-modified">modified</span> <span class="mono">${m.route}</span>
                ${m.fields.map((f) => html`
                  <div class="faint gov-field" style="margin-left: 18px;">
                    ${f.field}: <span class="mono">${JSON.stringify(f.before)}</span> (host) → <span class="mono">${JSON.stringify(f.after)}</span> (project)
                  </div>
                `)}
              </div>
            `)}
          `}
    </div>
  `;
}

function AuditPanel({ entries }) {
  if (!entries || entries.length === 0) return null;
  return html`
    <h2 style="margin-top: 20px;">Recent routing changes <span class="muted" style="font-weight: normal;">(RACI audit log)</span></h2>
    <div class="card gov-card">
      ${entries.map((e) => {
        const changed = [
          ...e.routes_added.map((r) => `+${r}`),
          ...e.routes_removed.map((r) => `−${r}`),
          ...e.routes_modified.map((r) => `~${r}`),
        ];
        return html`
          <div class="row gov-audit-row" style="gap: 10px; align-items: baseline; padding: 3px 0;">
            <span class="mono faint" style="min-width: 168px;">${e.timestamp}</span>
            <span class="badge">${e.action}</span>
            <span class="mono">${changed.length ? changed.join(" ") : "no route change"}</span>
          </div>
        `;
      })}
    </div>
  `;
}
