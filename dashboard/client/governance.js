// forge-dashboard — RACI Workbench (FG-359).
//
// Read-only observability: SOURCE / DERIVED / EFFECTIVE / RECORDED.
// Mirrors `forge route governance --json` via /api/governance.
// No mutation anywhere in this file — that is FG-361.

import { h } from "https://esm.sh/preact@10.24.0";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

const list = (arr) => (arr && arr.length ? arr.join(", ") : "—");
const informedList = (arr) =>
  arr && arr.length ? arr.map((t) => (t.when ? `${t.name}:${t.when}` : t.name)).join(", ") : "—";

// Non-color symbols for each health state (FG-123 a11y: not color-only).
const HEALTH_META = {
  "ok":                  { symbol: "✓", label: "ok",                  cls: "gov-health-ok" },
  "stale-drift":         { symbol: "⚠", label: "stale — policy drift", cls: "gov-health-warn" },
  "compile-error":       { symbol: "✗", label: "compile error",        cls: "gov-health-err" },
  "uncompiled-override": { symbol: "⊘", label: "uncompiled override",  cls: "gov-health-err" },
  "policy-not-found":    { symbol: "✗", label: "policy not found",     cls: "gov-health-err" },
};

export function GovernanceView({ data }) {
  if (!data) return html`<div class="muted">loading workbench…</div>`;

  return html`
    <section class="gov-view">
      <${SourceSection} source=${data.source} accountable=${data.derived.accountable} />
      <${DerivedSection} derived=${data.derived} />
      <${EffectiveSection} effective=${data.effective} />
      <${RecordedSection} entries=${data.recorded.entries} />
    </section>
  `;
}

function SourceSection({ source, accountable }) {
  const cls = source.kind === "project" ? "gov-src-project" : "gov-src-host";
  return html`
    <section class="workbench-section" role="region" aria-label="SOURCE — active RACI file">
      <h2 class="workbench-section-label">SOURCE</h2>
      <div class="row" style="gap: 12px; align-items: baseline; flex-wrap: wrap;">
        <span class=${"badge " + cls}>${source.kind}</span>
        <span class="mono muted" title=${source.raciPath}>${source.raciPath}</span>
        ${accountable ? html`<span class="muted">accountable: <strong>${accountable}</strong> (always human)</span>` : null}
      </div>
    </section>
  `;
}

function DerivedSection({ derived }) {
  const meta = HEALTH_META[derived.health] ?? HEALTH_META["policy-not-found"];
  const cardCls = derived.health === "stale-drift" ? "gov-drift" : "gov-error";
  return html`
    <section class="workbench-section" role="region" aria-label="DERIVED — compiled routing policy">
      <h2 class="workbench-section-label">DERIVED</h2>
      <div class="row" style="gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px;">
        <span class=${"gov-health-badge " + meta.cls} aria-label=${"policy health: " + meta.label}>
          ${meta.symbol} ${meta.label}
        </span>
        <span class="mono muted" title=${derived.policyPath}>${derived.policyPath}</span>
      </div>
      ${derived.findings && derived.findings.length ? html`
        <div class="card gov-card ${cardCls}">
          <div class="gov-warn-title">${meta.symbol} ${meta.label}</div>
          ${derived.findings.map((f) => html`<${Finding} f=${f} />`)}
        </div>
      ` : null}
    </section>
  `;
}

function EffectiveSection({ effective }) {
  if (!effective) {
    return html`
      <section class="workbench-section" role="region" aria-label="EFFECTIVE — routes in force">
        <h2 class="workbench-section-label">EFFECTIVE</h2>
        <div class="card gov-card gov-error">
          <div class="gov-warn-title">✗ No effective routes — see DERIVED above for details.</div>
        </div>
      </section>
    `;
  }
  return html`
    <section class="workbench-section" role="region" aria-label="EFFECTIVE — routes in force">
      <h2 class="workbench-section-label">EFFECTIVE</h2>
      <${RouteMatrix} routes=${effective.routes} />
      ${effective.diff ? html`<${OverrideDiff} diff=${effective.diff} />` : null}
    </section>
  `;
}

function RecordedSection({ entries }) {
  return html`
    <section class="workbench-section" role="region" aria-label="RECORDED — RACI audit log">
      <h2 class="workbench-section-label">RECORDED</h2>
      <${AuditPanel} entries=${entries} />
    </section>
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

function RouteMatrix({ routes }) {
  const keys = Object.keys(routes);
  return html`
    <div class="card gov-card" style="overflow-x: auto;">
      <table class="gov-table" aria-label=${`Route matrix (${keys.length} routes)`}>
        <caption class="sr-only">Route matrix — ${keys.length} route${keys.length === 1 ? "" : "s"}</caption>
        <thead>
          <tr>
            <th scope="col">route</th><th scope="col">path</th><th scope="col">responsible</th>
            <th scope="col">command</th><th scope="col">consulted</th>
            <th scope="col">followups</th><th scope="col">informed</th><th scope="col">force rules</th>
          </tr>
        </thead>
        <tbody>
          ${keys.map((k) => {
            const r = routes[k];
            return html`
              <tr id=${"route-" + k}>
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
    <div style="margin-top: 16px;">
      <h3>Host → project override</h3>
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
    </div>
  `;
}

function AuditPanel({ entries }) {
  if (!entries || entries.length === 0) {
    return html`<div class="muted">No RACI audit entries yet.</div>`;
  }
  return html`
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
