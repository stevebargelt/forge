// FG-821: the ticket page (#backlog/<ticketId>[?scope]). The ticket's fields as the
// backlog list shows them, and the runs dispatched for it from GET /api/backlog/:id/runs.
//
// Ticket ids are per project, so unlike the run and task pages this one reads WITH the
// list scope in hand (?projectKey/?projectDir): unscoped, the runs list spans every
// project's ticket of that id and the fields cannot be read at all.

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { formatTimestamp } from "./format.js";
import { badgeClass, statusClass, statusLabel } from "./status-tokens.js";
import { md } from "./renderers.js";
import { breadcrumbTrail, parentHash } from "./breadcrumbs-render.js";
import { ticketHeader } from "./screen-header-render.js";
import { hashFor } from "./view-routing.js";
import { checkoutLabelForDir } from "./checkout-label.js";
import { ObjectHead, useEscapeTo } from "./object-page-view.js";

const html = htm.bind(h);
const TICKET_RUNS_POLL_MS = 30000;

function scopeQuery(scope) {
  const q = new URLSearchParams();
  if (scope && scope.project) q.set("projectKey", scope.project);
  if (scope && scope.project && scope.checkout) q.set("projectDir", scope.checkout);
  const text = q.toString();
  return text ? `?${text}` : "";
}

function useTicketRuns(ticketId, scope) {
  const url = `/api/backlog/${encodeURIComponent(ticketId)}/runs${scopeQuery(scope)}`;
  const [load, setLoad] = useState({ url: null, runs: null, error: null });
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch(url);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body || !Array.isArray(body.runs)) {
          setLoad({ url, runs: null, error: body?.error ?? `HTTP ${res.status}` });
          return;
        }
        setLoad({ url, runs: body.runs, error: null });
      } catch (e) {
        if (!cancelled) setLoad({ url, runs: null, error: String(e) });
      }
    };
    read();
    const timer = setInterval(read, TICKET_RUNS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [url]);
  return load.url === url ? load : { url, runs: null, error: null };
}

export function TicketPage({ ticketId, data, scope, projects }) {
  const runsLoad = useTicketRuns(ticketId, scope);
  const tickets = data && Array.isArray(data.tickets) ? data.tickets : [];
  const ticket = tickets.find((tk) => tk.id === ticketId) ?? null;
  const epic = ticket && ticket.epic ? tickets.find((tk) => tk.type === "epic" && tk.id === ticket.epic) ?? null : null;
  const payload = { projectKey: data?.ticketsProjectKey ?? scope?.project ?? null, projectDir: ticket?.checkoutDir ?? null, ticketId };
  useEscapeTo(parentHash("ticket", payload, scope));

  return html`
    <section class="object-page ticket-page" data-ticket-id=${ticketId}>
      <${ObjectHead} crumbs=${breadcrumbTrail("ticket", payload, projects)} title=${ticket ? ticket.title : ticketId} header=${ticketHeader(ticketId, ticket, runsLoad)} />
      ${!scope || !scope.project
        ? html`<div class="card muted" role="note">Ticket ids are per project. Select a project in the scope control to read this ticket's fields; the runs below span every project.</div>`
        : !data
        ? html`<div class="muted">loading ticket…</div>`
        : !ticket
        ? html`<div class="card muted" role="note">No ticket ${ticketId} in this project's backlog.</div>`
        : html`<${TicketFields} ticket=${ticket} epic=${epic} projects=${projects} />`}
      <section class="ticket-runs" aria-labelledby="ticket-runs-heading">
        <h2 id="ticket-runs-heading">Runs</h2>
        ${runsLoad.error
          ? html`<div class="card" style="color: var(--err);" role="alert">Runs unreadable: ${runsLoad.error}</div>`
          : runsLoad.runs === null
          ? html`<div class="muted">loading runs…</div>`
          : runsLoad.runs.length === 0
          ? html`<div class="muted">No run has been dispatched for ${ticketId}.</div>`
          : html`
            <ul class="ticket-run-list">
              ${runsLoad.runs.map((run) => html`
                <li key=${run.runId} class="ticket-run-row">
                  <span class=${badgeClass("run", run.status)}>${statusLabel("run", run.status)}</span>
                  <a href=${hashFor({ view: "run", id: run.runId })}>${run.title || run.runId}</a>
                  <span class="faint mono">${run.runId}</span>
                  <span class="muted mono" title=${run.startedAt}>${formatTimestamp(run.startedAt)}</span>
                </li>
              `)}
            </ul>
          `}
      </section>
    </section>
  `;
}

function TicketFields({ ticket, epic, projects }) {
  return html`
    <div class="ticket-fields">
      <div class="row" style="gap: 8px; flex-wrap: wrap; margin: 12px 0; align-items: baseline;">
        <span class="badge ${statusClass("ticket", ticket.status)}" aria-label=${"Status: " + ticket.status}>${statusLabel("ticket", ticket.status)}</span>
        <span class="badge backlog-type-badge">${ticket.type}</span>
        <span class="mono faint" style="font-size: 12px;">${ticket.id}</span>
        ${ticket.checkoutDir ? html`<span class="checkout-chip" title=${ticket.checkoutDir}>${checkoutLabelForDir(ticket.checkoutDir, projects, ticket.checkoutBranch)}</span>` : null}
      </div>
      ${epic || ticket.epic || ticket.created || ticket.closed || (ticket.related && ticket.related.length) ? html`<div class="subcard" style="margin-bottom: 16px; font-size: 12px;">
        <div class="row" style="gap: 16px; flex-wrap: wrap;">
          ${epic || ticket.epic ? html`<span><span class="muted">epic:</span> ${epic?.title || ticket.epic} <span class="faint mono">(${ticket.epic})</span></span>` : null}
          ${ticket.created ? html`<span><span class="muted">created:</span> ${ticket.created}</span>` : null}
          ${ticket.closed ? html`<span><span class="muted">closed:</span> ${ticket.closed}</span>` : null}
          ${ticket.related && ticket.related.length ? html`<span><span class="muted">related:</span> ${ticket.related.join(", ")}</span>` : null}
        </div>
      </div>` : null}
      ${ticket.body && ticket.body.trim()
        ? html`<div class="md ticket-body" dangerouslySetInnerHTML=${{ __html: md(ticket.body) }}></div>`
        : html`<div class="muted faint">No body content.</div>`}
    </div>
  `;
}
