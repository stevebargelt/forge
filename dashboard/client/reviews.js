// forge-dashboard — review ledger view (FG-638).
//
// READ-ONLY. The ledger is the managed object: a summary per review (candidate and
// trusted-remote identity, stage, lenses, counts, next required action) and one row
// per finding. Disposition controls stay on `forge review disposition` until that
// surface is proven — a click that records an authority decision is not something
// to add on the same day the ledger first renders.

import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import {
  dispositionBadgeClass,
  severityBadgeClass,
  reviewStateBadgeClass,
  formatCounts,
  nextRequiredAction,
  sourceLabels,
  anchorText,
} from "./review-ledger-render.js";

const html = htm.bind(h);

// Interpolated, not inlined: htm parses the template as markup, so a literal
// <finding-id> would be read as a tag and an escaped one would render as
// "&lt;finding-id&gt;" on screen.
const DISPOSITION_COMMAND = 'forge review disposition <finding-id> <decision> --rationale "…"';

function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : "—";
}

function FindingsTable({ findings }) {
  if (findings.length === 0) {
    return html`<div class="muted" style="padding: 4px 8px;">No findings ingested for this review.</div>`;
  }
  return html`
    <div style="overflow-x: auto;">
      <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr class="muted" style="text-align: left;">
            <th style="padding: 4px 8px;">id</th>
            <th style="padding: 4px 8px;">severity</th>
            <th style="padding: 4px 8px;">lens</th>
            <th style="padding: 4px 8px;">reachability</th>
            <th style="padding: 4px 8px;">summary</th>
            <th style="padding: 4px 8px;">sources</th>
            <th style="padding: 4px 8px;">criterion / invariant</th>
            <th style="padding: 4px 8px;">disposition</th>
            <th style="padding: 4px 8px;">resolution</th>
          </tr>
        </thead>
        <tbody>
          ${findings.map((f) => html`
            <tr key=${f.id} style="border-top: 1px solid var(--border); vertical-align: top;">
              <td class="mono" style="padding: 4px 8px;" title=${f.id}>${f.findingRef}</td>
              <td style="padding: 4px 8px;">
                <span class="badge ${severityBadgeClass(f.severity)}">${f.severity || "—"}</span>
              </td>
              <td style="padding: 4px 8px;">${f.riskLens || "—"}</td>
              <td style="padding: 4px 8px;">${f.reachability || "—"}</td>
              <td style="padding: 4px 8px;">
                <div>${f.summary}</div>
                ${anchorText(f) ? html`<div class="muted mono" style="font-size: 11px;">${anchorText(f)}</div>` : null}
              </td>
              <td class="muted" style="padding: 4px 8px;">${sourceLabels(f.sources).join(", ") || "—"}</td>
              <td class="muted" style="padding: 4px 8px;">${f.acceptanceRef || f.invariantRef || "—"}</td>
              <td style="padding: 4px 8px;">
                <span class="badge ${dispositionBadgeClass(f.disposition)}">${f.disposition}</span>
                ${f.decidedBy ? html`<div class="muted" style="font-size: 11px;">by ${f.decidedBy}</div>` : null}
                ${f.dispositionRationale ? html`<div class="faint" style="font-size: 11px;">${f.dispositionRationale}</div>` : null}
                ${f.duplicateOf ? html`<div class="faint mono" style="font-size: 11px;">dup of ${f.duplicateOf}</div>` : null}
                ${f.followupTicketId ? html`<div class="faint mono" style="font-size: 11px;">→ ${f.followupTicketId}</div>` : null}
              </td>
              <td style="padding: 4px 8px;">
                <div>${f.resolution || "—"}</div>
                ${f.resolutionEvidence
                  ? html`<div class="faint" style="font-size: 11px;">[${f.resolutionEvidenceKind || "—"}] ${f.resolutionEvidence}</div>`
                  : null}
              </td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>`;
}

function ReviewCard({ review, expanded, onToggle }) {
  return html`
    <div class="card review-card">
      <div class="row" style="justify-content: space-between; align-items: baseline;">
        <div>
          <span class="badge ${reviewStateBadgeClass(review.state)}">${review.state}</span>
          <strong class="mono" style="margin-left: 8px;">${review.id}</strong>
          ${review.ticketId ? html`<span class="muted" style="margin-left: 8px;">${review.ticketId}</span>` : null}
        </div>
        <button class="tab" onClick=${onToggle}>${expanded ? "hide findings" : `findings (${review.findings.length})`}</button>
      </div>

      <div class="review-summary-grid">
        <div><span class="muted">candidate</span> <span class="mono">${shortSha(review.candidateSha)}</span></div>
        <div><span class="muted">trusted remote</span> <span class="mono">${shortSha(review.trustedRemoteSha)}</span></div>
        <div><span class="muted">contract confirmed</span> <span class="mono">${shortSha(review.contractConfirmedSha)}</span></div>
        <div><span class="muted">base</span> <span class="mono">${shortSha(review.baseSha)}</span></div>
        <div><span class="muted">risk lenses</span> ${review.riskLenses.length ? review.riskLenses.join(", ") : "—"}</div>
        <div><span class="muted">review mode</span> ${review.reviewMode}</div>
        <div><span class="muted">dispositions</span> ${formatCounts(review.countsByDisposition)}</div>
        <div><span class="muted">resolutions</span> ${formatCounts(review.countsByResolution)}</div>
      </div>

      <div class="review-next">next: ${nextRequiredAction(review)}</div>

      ${expanded ? html`<div class="subcard" style="margin-top: 8px;"><${FindingsTable} findings=${review.findings} /></div>` : null}
    </div>`;
}

export function ReviewsView({ data }) {
  const [expanded, setExpanded] = useState({});
  if (!data) return html`<div class="muted" style="margin-top: 20px;">loading reviews…</div>`;

  const reviews = data.reviews || [];
  return html`
    <section class="reviews-view">
      <h2>Review ledger</h2>
      <div class="muted" style="margin-bottom: 8px;">
        Read-only. Record decisions with <span class="mono">${DISPOSITION_COMMAND}</span>.
      </div>
      ${data.error ? html`<div class="card" style="color: var(--err);">Ledger unreadable: ${data.error}</div>` : null}
      ${reviews.length === 0
        ? html`<div class="muted">No reviews recorded yet.</div>`
        : reviews.map((r) => html`
            <${ReviewCard}
              key=${r.id}
              review=${r}
              expanded=${expanded[r.id] === true}
              onToggle=${() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))}
            />`)}
    </section>`;
}
