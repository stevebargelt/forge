// FG-402: the Human Attention Inbox surface, as a component.
//
// It adds NO decisions. `inboxView` in attention-inbox-render.js decides which items
// exist, their badges, severity, age and link target, and which of loading / ready /
// unavailable / empty is true; this file renders that. The load-bearing honesty
// property (mirrors current-activity-view.js's AC7): a failed or malformed read renders
// `Attention inbox unavailable` + Retry, and NEVER the calm empty copy — because that
// copy is reachable only from a validated payload.
//
// READ-ONLY: the only control is Retry (re-reads) and the per-row link (navigates via
// the hash). There is no advance/reject/mutation here — the inbox renders existing Forge
// state and typed attention records; it invents no chat semantics.

import { h } from "preact";
import htm from "htm";
import { inboxView, inboxItemAge } from "./attention-inbox-render.js";

const html = htm.bind(h);

export function AttentionInboxSection({ load, now, onRetry }) {
  const view = inboxView(load);
  return html`
    <section class="attention-inbox" aria-labelledby="attention-inbox-heading">
      <div class="home-section-heading">
        <div>
          <div class="home-section-kicker">Needs you</div>
          <h2 id="attention-inbox-heading">Attention inbox</h2>
        </div>
      </div>
      ${view.phase === "loading"
        ? html`<div class="inbox-loading" role="status">${view.message}</div>`
        : view.phase === "unavailable"
          ? html`<${InboxUnavailable} view=${view} onRetry=${onRetry} />`
          : view.empty
            ? html`<div class="inbox-empty" role="status">${view.message}</div>`
            : html`
                ${view.degraded.length > 0
                  ? html`<div class="inbox-degraded" role="status">Some sources could not be read: ${view.degraded.join(", ")}.</div>`
                  : null}
                <div class="inbox-list">
                  ${view.items.map((summary) => html`<${InboxItemRow} key=${summary.id} summary=${summary} now=${now} />`)}
                </div>
              `}
    </section>
  `;
}

// One row: the kind badge, the severity, the identity (ticket/project), the reason and
// requested action, the age, and the link to the relevant surface.
function InboxItemRow({ summary, now }) {
  return html`
    <div class="item inbox-row">
      <div class="inbox-row-badges">
        <span class="badge ${summary.badgeClass}">${summary.badgeLabel}</span>
        <span class="badge inbox-sev ${summary.severityClass}">${summary.severityLabel}</span>
      </div>
      <div class="inbox-row-body">
        <div class="inbox-row-head">
          ${summary.ticketId ? html`<strong>${summary.ticketId}</strong><span class="faint"> · </span>` : null}
          <span class="inbox-reason">${summary.reason}</span>
        </div>
        <div class="faint inbox-action">${summary.requestedAction}</div>
        <div class="faint mono inbox-meta">
          ${summary.source}${summary.projectLabel ? ` · ${summary.projectLabel}` : ""}
        </div>
      </div>
      <div class="inbox-row-aside">
        <div class="muted mono inbox-age" title="time since this attention item began">
          ${inboxItemAge({ startedAt: summary.startedAt }, now)}
        </div>
        ${summary.link ? html`<a class="inbox-link" href=${summary.link.hash}>${summary.link.label}</a>` : null}
      </div>
    </div>
  `;
}

// The version-skew / degraded-read state, and the whole point of the honesty rule. Note
// what is NOT here: any statement that no action is needed. We failed to read; that is
// the only fact we have.
function InboxUnavailable({ view, onRetry }) {
  return html`
    <div class="inbox-unavailable" role="alert">
      <div class="inbox-unavailable-head">
        <strong>${view.message}</strong>
        <button type="button" class="ca-retry" onClick=${() => onRetry && onRetry()}>Retry</button>
      </div>
      <div class="inbox-unavailable-detail">${view.detail}</div>
    </div>
  `;
}
