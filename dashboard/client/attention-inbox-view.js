// FG-402: the Human Attention Inbox surface, as a component.
//
// It adds NO decisions. `inboxView` in attention-inbox-render.js decides which items
// exist, their badges, severity, age and link target, and which of loading / ready /
// unavailable / empty is true; this file renders that. The load-bearing honesty
// property (mirrors current-activity-view.js's AC7): a failed or malformed read renders
// `Attention inbox unavailable` + Retry, and NEVER the calm empty copy — because that
// copy is reachable only from a validated payload.
//
// The section's own controls are Retry / Refresh (re-read; Refresh also re-sorts the
// pinned rows, FG-819) and the per-row link (navigates via the hash). A host may pass
// `rowActions` (FG-822): for a row naming a task, it renders that task's eligible action
// buttons in place of the copy-paste requestedAction — the eligibility is the server's
// preview, never decided here. The inbox invents no chat semantics.

import { h } from "preact";
import htm from "htm";
import { inboxView, inboxItemAge } from "./attention-inbox-render.js";
import { PinRefreshButton, usePinnedOrder } from "./order-pin-view.js";

const html = htm.bind(h);

// `orderedItems`/`listProps`/`onRefresh` are supplied by PinnedAttentionInboxSection
// (FG-819 order pinning); without them the section renders the server order as-is.
// `hrefFor` lets the host carry its current scope onto a row link (FG-820); the default
// is the link as the render module decided it.
export function AttentionInboxSection({ load, now, onRetry, orderedItems = null, listProps = {}, onRefresh = null, hrefFor = (hash) => hash, rowActions = null }) {
  const view = inboxView(load);
  const items = orderedItems ?? view.items;
  return html`
    <section class="attention-inbox" aria-labelledby="attention-inbox-heading">
      <div class="home-section-heading">
        <div>
          <div class="home-section-kicker">Needs you</div>
          <h2 id="attention-inbox-heading">Attention inbox</h2>
        </div>
        ${onRefresh ? html`<${PinRefreshButton} label="Refresh and re-sort the attention inbox" onClick=${onRefresh} />` : null}
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
                <div class="inbox-list" ...${listProps}>
                  ${items.map((summary) => html`<${InboxItemRow} key=${summary.id} summary=${summary} now=${now} hrefFor=${hrefFor} rowActions=${rowActions} />`)}
                </div>
              `}
    </section>
  `;
}

/** The Home inbox: the section above, with its rows pinned to the order first shown until
 *  an idle, tab-visibility, or manual-refresh boundary (FG-819). */
export function PinnedAttentionInboxSection({ load, now, onRetry, hrefFor, rowActions = null }) {
  const view = inboxView(load);
  const pin = usePinnedOrder(view.phase === "ready" ? view.items : null, (summary) => summary.id);
  const refresh = () => pin.refresh(onRetry);
  return html`<${AttentionInboxSection}
    load=${load}
    now=${now}
    onRetry=${refresh}
    orderedItems=${pin.items}
    listProps=${pin.activityProps}
    onRefresh=${refresh}
    hrefFor=${hrefFor}
    rowActions=${rowActions}
  />`;
}

// One row: the kind badge, the severity, the identity (ticket/project), the reason and
// requested action, the age, and the link to the relevant surface.
function InboxItemRow({ summary, now, hrefFor, rowActions }) {
  const action = html`<div class="faint inbox-action">${summary.requestedAction}</div>`;
  return html`
    <div class="item inbox-row" data-item-id=${summary.id}>
      <div class="inbox-row-badges">
        <span class="badge ${summary.badgeClass}">${summary.badgeLabel}</span>
        <span class="badge inbox-sev ${summary.severityClass}">${summary.severityLabel}</span>
      </div>
      <div class="inbox-row-body">
        <div class="inbox-row-head">
          ${summary.ticketId ? html`<strong>${summary.ticketId}</strong><span class="faint"> · </span>` : null}
          <span class="inbox-reason">${summary.reason}</span>
        </div>
        ${summary.taskId && rowActions ? rowActions(summary, action) : action}
        <div class="faint mono inbox-meta">
          ${summary.source}${summary.projectLabel ? ` · ${summary.projectLabel}` : ""}
        </div>
      </div>
      <div class="inbox-row-aside">
        <div class="muted mono inbox-age" title="time since this attention item began">
          ${inboxItemAge({ startedAt: summary.startedAt }, now)}
        </div>
        ${summary.link ? html`<a class="inbox-link" href=${hrefFor(summary.link.hash)}>${summary.link.label}</a>` : null}
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
        <button type="button" class="inbox-retry" onClick=${() => onRetry && onRetry()}>Retry</button>
      </div>
      <div class="inbox-unavailable-detail">${view.detail}</div>
    </div>
  `;
}
