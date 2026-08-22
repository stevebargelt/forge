// forge-dashboard — Control Plane area, first panel: Sources + Provider/Runtime
// Capabilities (FG-349 / FG-401). Read-only observability over the shared
// buildConfigGraph() contract via /api/config-graph. A grouped provenance table,
// not a graph. No mutation anywhere in this file — the view answers "what config
// would Forge use if I started a run here?" and nothing more.

import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// Non-color symbols per row status (FG-123 a11y: never color-only). Every status
// gets a DISTINCT symbol so the badge is legible without color.
export const STATUS_META = {
  "active": { symbol: "✓", label: "active", cls: "cp-status-active" },
  "absent": { symbol: "○", label: "absent", cls: "cp-status-absent" },
  "overridden": { symbol: "⇄", label: "overridden", cls: "cp-status-overridden" },
  "template-only": { symbol: "⧉", label: "template only", cls: "cp-status-template" },
  "derived": { symbol: "⚙", label: "derived", cls: "cp-status-derived" },
  "stale": { symbol: "↯", label: "stale", cls: "cp-status-stale" },
  "missing": { symbol: "✗", label: "missing", cls: "cp-status-missing" },
  "warning": { symbol: "⚠", label: "warning", cls: "cp-status-warning" },
};

// Readiness symbols for providers / prerequisites (FG-401).
export const READINESS_META = {
  "available": { symbol: "✓", label: "available", cls: "cp-ready-available" },
  "unavailable": { symbol: "✗", label: "unavailable", cls: "cp-ready-unavailable" },
  "deferred": { symbol: "…", label: "deferred", cls: "cp-ready-deferred" },
  "unknown": { symbol: "?", label: "unknown", cls: "cp-ready-unknown" },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META["warning"];
  return html`<span class=${"cp-badge " + meta.cls} aria-label=${"status: " + meta.label}>${meta.symbol} ${meta.label}</span>`;
}

function ReadinessBadge({ readiness }) {
  const meta = READINESS_META[readiness] ?? READINESS_META["unknown"];
  return html`<span class=${"cp-badge " + meta.cls} aria-label=${"readiness: " + meta.label}>${meta.symbol} ${meta.label}</span>`;
}

export function ControlPlaneView({ data }) {
  if (!data) return html`<div class="muted">loading control plane…</div>`;

  return html`
    <section class="cp-view">
      <header class="cp-header">
        <h2 class="workbench-section-label">CONTROL PLANE — EFFECTIVE CONFIG</h2>
        <div class="row" style="gap: 12px; align-items: baseline; flex-wrap: wrap;">
          <span class="muted">project</span>
          <span class="mono" title=${data.project.dir}>${data.project.dir}</span>
          <${StatusBadge} status=${data.project.status} />
          <span class="muted">forge home</span>
          <span class="mono muted" title=${data.forgeHome}>${data.forgeHome}</span>
          <span class="faint">contract v${data.version}</span>
        </div>
      </header>
      <${SourcesPanel} sources=${data.sections.sources} />
      <${CapabilitiesPanel} capabilities=${data.sections.capabilities} />
    </section>
  `;
}

function SourcesPanel({ sources }) {
  const rows = sources && sources.rows ? sources.rows : [];
  return html`
    <section class="workbench-section" role="region" aria-label="Sources — effective config provenance">
      <h3 class="workbench-section-label">Sources</h3>
      ${rows.length === 0
        ? html`<div class="muted">No config surfaces resolved for this project.</div>`
        : html`
          <div class="card cp-card" style="overflow-x: auto;">
            <table class="cp-table" aria-label=${`Config surfaces (${rows.length})`}>
              <thead>
                <tr>
                  <th scope="col">surface</th><th scope="col">truth</th><th scope="col">status</th>
                  <th scope="col">effective</th><th scope="col">provenance / semantics</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => html`<${SourceRow} row=${r} />`)}
              </tbody>
            </table>
          </div>
        `}
    </section>
  `;
}

function SourceRow({ row }) {
  return html`
    <tr id=${"cp-row-" + row.key}>
      <td><div class="cp-surface-label">${row.label}</div></td>
      <td><span class="badge cp-truth">${row.truth}</span></td>
      <td><${StatusBadge} status=${row.status} /></td>
      <td class="mono faint">${row.effectivePath ?? "—"}</td>
      <td>
        ${row.overrideCallout ? html`<div class="cp-callout">${row.overrideCallout}</div>` : null}
        ${row.warning ? html`<div class="cp-warn">⚠ ${row.warning}</div>` : null}
        ${!row.warning && row.detail ? html`<div class="faint">${row.detail}</div>` : null}
        <div class="faint cp-semantics">override: ${row.overrideSemantics}</div>
      </td>
    </tr>
  `;
}

function CapabilitiesPanel({ capabilities }) {
  const caps = capabilities ?? { providers: [], capabilities: [], prerequisites: [] };
  return html`
    <section class="workbench-section" role="region" aria-label="Provider and runtime capabilities">
      <h3 class="workbench-section-label">Provider / Runtime Capabilities</h3>

      <h4 class="cp-subhead">Providers &amp; auth <span class="faint">(host-observed)</span></h4>
      ${caps.providers.length === 0
        ? html`<div class="muted">No providers configured.</div>`
        : html`<div class="card cp-card">
            ${caps.providers.map((p) => html`
              <div class="row cp-provider-row" style="gap: 10px; align-items: baseline;">
                <${ReadinessBadge} readiness=${p.readiness} />
                <span class="mono">${p.provider}</span>
                <span class="faint">(${p.mode})</span>
                <span class="badge cp-provenance">${p.provenance}</span>
                <span class="muted">${p.detail}</span>
                <span class="faint">${p.observedBy}</span>
              </div>
            `)}
          </div>`}

      <h4 class="cp-subhead">Capability matrix <span class="faint">(inferred — would-be run container)</span></h4>
      <div class="card cp-card" style="overflow-x: auto;">
        <table class="cp-table" aria-label=${`Capability matrix (${caps.capabilities.length})`}>
          <thead>
            <tr><th scope="col">capability</th><th scope="col">adapter</th><th scope="col">support</th><th scope="col">provenance</th><th scope="col">limitation</th></tr>
          </thead>
          <tbody>
            ${caps.capabilities.map((c) => html`
              <tr>
                <td>${c.title}</td>
                <td class="mono">${c.adapter}</td>
                <td><span class=${"badge cp-support-" + c.support}>${c.support}</span></td>
                <td><span class="badge cp-provenance">${c.provenance}</span></td>
                <td class="faint">${c.limitation ?? "—"}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>

      <h4 class="cp-subhead">Workflow prerequisites</h4>
      <div class="card cp-card">
        ${caps.prerequisites.map((pr) => html`
          <div class="row cp-prereq-row" style="gap: 10px; align-items: baseline;">
            <${ReadinessBadge} readiness=${pr.readiness} />
            <strong>${pr.name}</strong>
            <span class="faint">${pr.observedBy}</span>
            <span class="muted">${pr.reason}</span>
          </div>
        `)}
      </div>
    </section>
  `;
}
