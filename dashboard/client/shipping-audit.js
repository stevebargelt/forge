// forge-dashboard — shipping-audit view (FG-386).
//
// READ-ONLY projection of already-persisted FG-382/383/384 evidence, keyed by
// ticket. It renders NOTHING it could not read from a row: no recompute, no
// mutation, no status toggle. Three kinds of evidence share one row but stay
// visually distinct — the mechanical block (readiness gaps + host-verification
// shipping checks), the model block (reviewer findings), and accepted deferrals.
// Absence on any axis renders "not observed", never green.

import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { auditBadgeClass, auditStatusLabel, auditReason, shortSha } from "./shipping-audit-render.js";

const html = htm.bind(h);

function StatusBadge({ status }) {
  return html`<span class="badge ${auditBadgeClass(status)}">${auditStatusLabel(status)}</span>`;
}

function MechanicalBlock({ readiness, checks }) {
  const hasGaps = readiness && readiness.gaps.length > 0;
  if (!readiness && checks.length === 0) return null;
  return html`
    <div class="audit-mechanical" data-testid="audit-mechanical">
      <h4>mechanical checks</h4>
      ${readiness
        ? html`
            <div class="audit-check-row">
              <span class="audit-axis-label">readiness</span>
              <${StatusBadge} status=${readiness.status} />
              <span>${readiness.outcome}</span>
              ${readiness.stale ? html`<span class="audit-stale-note">stale (body changed)</span>` : null}
            </div>
            ${hasGaps
              ? html`<ul class="audit-gaps">${readiness.gaps.map((g, i) => html`<li key=${i}>${g}</li>`)}</ul>`
              : null}`
        : null}
      ${checks.length > 0
        ? checks.map((c, i) => html`
            <div class="audit-check-row" data-testid="audit-check" key=${i}>
              <${StatusBadge} status=${c.status} />
              <span>${c.gateName}</span>
              <span class="audit-axis-label">${c.source}</span>
              ${c.command ? html`<code class="audit-check-command">${c.command}</code>` : null}
              ${c.ciUrl
                ? html`<a class="mono" href=${c.ciUrl} target="_blank" rel="noreferrer noopener">${shortSha(c.commitSha)}</a>`
                : html`<span class="audit-axis-label mono">${shortSha(c.commitSha)}</span>`}
              ${c.ciUrl ? html`<a class="audit-check-ci" href=${c.ciUrl} target="_blank" rel="noreferrer noopener">CI ↗</a>` : null}
            </div>`)
        : null}
    </div>`;
}

function ModelBlock({ review }) {
  if (!review) return null;
  const findings = review.modelFindings || [];
  if (findings.length === 0) {
    return html`<div class="audit-model" data-testid="audit-model"><h4>reviewer findings (model-authored)</h4>
      <div class="muted">No reviewer findings recorded.</div></div>`;
  }
  return html`
    <div class="audit-model" data-testid="audit-model">
      <h4>reviewer findings (model-authored)</h4>
      ${findings.map((f) => html`
        <div class="audit-model-finding" key=${f.findingRef}>
          <span class="mono">${f.findingRef}</span>
          ${f.severity ? html` <span class="badge ${severityClass(f.severity)}">${f.severity}</span>` : null}
          ${f.riskLens ? html` <span class="audit-axis-label">${f.riskLens}</span>` : null}
          <span> ${f.summary}</span>
          <span class="audit-axis-label"> — ${f.disposition}${f.resolution ? ` / ${f.resolution}` : ""}</span>
        </div>`)}
    </div>`;
}

function severityClass(severity) {
  const s = String(severity || "").toLowerCase();
  if (s === "critical" || s === "high") return "audit-failed";
  if (s === "medium") return "audit-needs_human";
  return "audit-not_observed";
}

function DeferralsBlock({ review }) {
  const deferrals = review?.acceptedDeferrals || [];
  if (deferrals.length === 0) return null;
  return html`
    <div class="audit-deferrals" data-testid="audit-deferrals">
      <h4>accepted deferrals</h4>
      ${deferrals.map((d) => html`
        <div key=${d.findingRef}>
          <span class="mono">${d.findingRef}</span> ${d.summary}
          ${d.followupTicketId
            ? html` <a class="mono audit-followup-link" href=${`#audit-ticket-${d.followupTicketId}`}>→ ${d.followupTicketId}</a>`
            : html` <span class="audit-axis-label">(no follow-up ticket)</span>`}
        </div>`)}
    </div>`;
}

function AuditRow({ row, expanded, onToggle }) {
  const detailsId = `audit-details-${row.ticketId}`;
  return html`
    <div class="card audit-row" data-testid="audit-row" data-status=${row.status} id=${`audit-ticket-${row.ticketId}`}>
      <div class="row audit-row-head">
        <div>
          <${StatusBadge} status=${row.status} />
          <strong class="mono" style="margin-left: 8px;">${row.ticketId}</strong>
          ${row.title ? html`<span class="muted" style="margin-left: 8px;">${row.title}</span>` : null}
        </div>
        <button class="tab" onClick=${onToggle} aria-expanded=${expanded} aria-controls=${detailsId}>${expanded ? "hide" : "details"}</button>
      </div>

      <div class="audit-axes">
        <div>
          <span class="audit-axis-label">readiness</span>
          <${StatusBadge} status=${row.readiness ? row.readiness.status : "not_observed"} />
        </div>
        <div>
          <span class="audit-axis-label">shipping review</span>
          <${StatusBadge} status=${row.review ? row.review.status : "not_observed"} />
          ${row.review ? html`<span class="audit-axis-label" style="margin-left: 6px;">${row.review.state}</span>` : null}
        </div>
        <div>
          <span class="audit-axis-label">candidate</span>
          <span class="mono">${shortSha(row.candidateSha)}</span>
        </div>
      </div>

      <div class="muted" style="margin-top: 6px; font-size: 12px;">${auditReason(row)}</div>

      ${expanded
        ? html`
          <div id=${detailsId}>
            <${MechanicalBlock} readiness=${row.readiness} checks=${row.shippingChecks || []} />
            <${ModelBlock} review=${row.review} />
            <${DeferralsBlock} review=${row.review} />
            <div class="muted" style="margin-top: 8px; font-size: 11px;">
              ${row.links.runId ? html`run ${row.links.runId} · ` : null}
              ${row.links.subjectTaskId ? html`task ${row.links.subjectTaskId} · ` : null}
              ticket ${row.links.ticketId}
              ${row.links.commit ? html` · commit ${shortSha(row.links.commit)}` : null}
              ${row.campaign ? html` · campaign ${row.campaign.campaignId} (${row.campaign.lifecycleStatus}${row.campaign.outcome ? `/${row.campaign.outcome}` : ""})` : null}
            </div>
          </div>`
        : null}
    </div>`;
}

export function ShippingAuditView({ data }) {
  const [expanded, setExpanded] = useState({});
  if (!data) return html`<div class="muted" style="margin-top: 20px;">loading shipping audit…</div>`;

  const rows = data.rows || [];
  return html`
    <section class="shipping-view">
      <h2>Shipping audit</h2>
      <div class="muted" style="margin-bottom: 8px;">
        Read-only projection of readiness, shipping-review and mechanical-check evidence, keyed by ticket. Absence renders "not observed", never green.
      </div>
      ${data.error ? html`<div class="card" style="color: var(--err);">Audit unreadable: ${data.error}</div>` : null}
      ${data.projectKey === null && !data.error
        ? html`<div class="muted" data-testid="audit-no-project">Select a project to see its shipping audit.</div>`
        : rows.length === 0
          ? html`<div class="muted" data-testid="audit-empty">No readiness or review evidence recorded for this project yet.</div>`
          : rows.map((r) => html`
              <${AuditRow}
                key=${r.ticketId}
                row=${r}
                expanded=${expanded[r.ticketId] === true}
                onToggle=${() => setExpanded((e) => ({ ...e, [r.ticketId]: !e[r.ticketId] }))}
              />`)}
    </section>`;
}
