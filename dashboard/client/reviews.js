// forge-dashboard — review ledger view (FG-638).
//
// READ-ONLY. The ledger is the managed object: a summary per review (candidate and
// trusted-remote identity, stage, lenses, counts, next required action) and one row
// per finding. Disposition controls stay on `forge review disposition` until that
// surface is proven — a click that records an authority decision is not something
// to add on the same day the ledger first renders.

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { shortSha } from "./format.js";
import {
  dispositionBadgeClass,
  severityBadgeClass,
  reviewStateBadgeClass,
  formatCounts,
  nextRequiredAction,
  sourceLabels,
  anchorText,
} from "./review-ledger-render.js";
import { breadcrumbTrail, parentHash } from "./breadcrumbs-render.js";
import { reviewHeader } from "./screen-header-render.js";
import { ObjectHead, useEscapeTo } from "./object-page-view.js";

const html = htm.bind(h);

// Interpolated, not inlined: htm parses the template as markup, so a literal
// <finding-id> would be read as a tag and an escaped one would render as
// "&lt;finding-id&gt;" on screen.
const DISPOSITION_COMMAND = 'forge review disposition <finding-id> <decision> --rationale "…"';

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

function ReviewCard({ review, expanded, onToggle, linked = false }) {
  return html`
    <div class=${"card review-card" + (linked ? " review-card-linked" : "")} data-review-id=${review.id}>
      <div class="row" style="justify-content: space-between; align-items: baseline;">
        <div>
          <span class="badge ${reviewStateBadgeClass(review.state)}">${review.state}</span>
          <a class="mono review-id-link" style="margin-left: 8px;" href=${`#reviews/${encodeURIComponent(review.id)}`}><strong>${review.id}</strong></a>
          ${review.ticketId ? html`<span class="muted" style="margin-left: 8px;">${review.ticketId}</span>` : null}
        </div>
        ${onToggle ? html`<button class="tab" onClick=${onToggle}>${expanded ? "hide findings" : `findings (${review.findings.length})`}</button>` : null}
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

// The ledger: the last 25 reviews in scope. A review opens its own page (ReviewPage).
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
              expanded=${expanded[r.id] ?? false}
              onToggle=${() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))}
            />`)}
    </section>`;
}

// FG-821: #reviews/<reviewId> — one review read by id (GET /api/review/:id), so a link
// older than the ledger's 25-row window still resolves. Read unscoped: a review id is
// global, like a run's.
export function ReviewPage({ reviewId, projects, scope }) {
  const [load, setLoad] = useState({ id: null, review: null, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/review/${encodeURIComponent(reviewId)}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body) setLoad({ id: reviewId, review: null, error: res.status === 404 ? `No review ${reviewId}.` : body?.error ?? `HTTP ${res.status}` });
        else setLoad({ id: reviewId, review: body, error: null });
      } catch (e) {
        if (!cancelled) setLoad({ id: reviewId, review: null, error: String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [reviewId]);
  const current = load.id === reviewId ? load : { review: null, error: null };
  const review = current.review;
  const payload = { projectDir: review?.projectDir ?? null, ticketId: review?.ticketId ?? null, runId: review?.runId ?? null, reviewId };
  useEscapeTo(parentHash("review", payload, scope));
  return html`
    <section class="object-page review-page" data-review-id=${reviewId}>
      <${ObjectHead} crumbs=${breadcrumbTrail("review", payload, projects)} title=${`Review ${reviewId}`} header=${reviewHeader(review, review ? nextRequiredAction(review) : null)} />
      ${current.error ? html`<div class="card" style="color: var(--err);" role="alert">${current.error}</div>` : null}
      ${review
        ? html`<${ReviewCard} review=${review} expanded=${true} linked=${true} onToggle=${null} />`
        : current.error ? null : html`<div class="muted">loading review…</div>`}
    </section>`;
}
