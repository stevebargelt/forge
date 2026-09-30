// forge-dashboard — RACI Workbench (FG-359).
//
// Read-only observability: SOURCE / DERIVED / EFFECTIVE / RECORDED.
// Mirrors `forge route governance --json` via /api/governance.
// No mutation anywhere in this file — the Edit RACI mode is raci-editor-view.js (FG-834).

import { h } from "preact";
import htm from "htm";
import { auditRows } from "./raci-editor-state.js";
import { MONO_CLASS, formatUtcMinute, shortSha } from "./format.js";

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

// FG-834: `sourceActions` (the Edit RACI button) sits on the SOURCE label row, `afterSource`
// under it (an apply's result) — raci-editor-view.js.
export function GovernanceView({ data, sourceActions = null, afterSource = null }) {
  if (!data) return html`<div class="muted">loading workbench…</div>`;

  return html`
    <section class="gov-view">
      <${SourceSection} source=${data.source} accountable=${data.derived.accountable} actions=${sourceActions} />
      ${afterSource}
      <${DerivedSection} derived=${data.derived} />
      <${EffectiveSection} effective=${data.effective} />
      <${RecordedAudit} audit=${data.recorded} />
    </section>
  `;
}

export function SourceSection({ source, accountable, actions = null, note = null, boxed = false }) {
  const cls = source.kind === "project" ? "gov-src-project" : "gov-src-host";
  const kind = boxed ? (source.kind === "project" ? "project override" : "host default") : source.kind;
  return html`
    <section class="workbench-section" role="region" aria-label="SOURCE — active RACI file">
      <div class="gov-source-label-row">
        <h2 class="workbench-section-label">SOURCE</h2>
        ${actions ? html`<div class="gov-source-actions">${actions}</div>` : null}
      </div>
      <div class=${boxed ? "card gov-source-card" : "row"} style="gap: 12px; align-items: baseline; flex-wrap: wrap;">
        <span class=${"badge " + cls}>${kind}</span>
        <span class="mono muted" title=${source.raciPath}>${source.raciPath}</span>
        ${accountable ? html`<span class="muted">accountable: <strong>${accountable}</strong> (always human)</span>` : null}
        ${note ? html`<span class="gov-source-note">${note}</span>` : null}
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

export function AuditSourceCaption({ source, path, skippedLines = 0, refused = false }) {
  const caption = source === "project"
    ? "recorded in this checkout's .forge/raci-audit.log"
    : "recorded in the host log — no checkout in scope";
  return html`
    <div class="muted gov-audit-source" data-testid="gov-audit-source" title=${path}>
      ${caption} · <span class="mono">${path}</span>${skippedLines ? ` · ${skippedLines} unreadable line(s) skipped` : ""}${refused ? " · not read: the log resolves outside this checkout's .forge" : ""}
    </div>
  `;
}

// FG-840: the ONE RECORDED renderer — the workbench (host log, or the scoped checkout's
// via /api/governance) and the editor (the same reader's tail via /api/raci) both use it.
// `audit` is src/raci-audit.ts's RaciAuditTail.
export function RecordedAudit({ audit }) {
  const label = html`<h2 class="workbench-section-label">RECORDED</h2><${AuditSourceCaption} source=${audit.source} path=${audit.path} skippedLines=${audit.skippedLines} refused=${audit.refused} />`;
  const rows = auditRows(audit.entries);
  return html`
    <section class="workbench-section raci-recorded" role="region" aria-label="RECORDED — RACI audit log">
      ${label}
      ${rows.length === 0
        ? html`<div class="muted">${audit.source === "project" ? "No RACI changes recorded for this checkout yet." : "No RACI audit entries yet."}</div>`
        : html`<div class="card raci-table-card">
            <table class="raci-table raci-audit" aria-label="RACI audit log, newest first">
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Change</th><th scope="col">Rationale</th><th scope="col">Candidate</th></tr></thead>
              <tbody>
                ${rows.map((r, i) => {
                  const via = audit.entries[i].source;
                  return html`<tr class="gov-audit-row">
                    <td class=${MONO_CLASS} title=${r.timestamp ?? ""}>${formatUtcMinute(r.timestamp)}</td>
                    <td class="gov-audit-actor">${r.who}${via && via !== r.who ? ` via ${via}` : ""}</td>
                    <td><span class="raci-chip">${r.action}</span></td>
                    <td>${r.change}</td>
                    <td class="raci-rationale" title=${r.rationale ?? ""}>${r.rationale ?? html`<span class="muted">—</span>`}</td>
                    <td class=${`${MONO_CLASS} muted`} title=${r.sha ?? ""}>${shortSha(r.sha, 8)}</td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>`}
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
