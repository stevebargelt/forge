// forge-dashboard — Backlog viewer (#FG-363).
//
// READ-ONLY view of the project backlog (backlog/ markdown files). Mirrors
// `forge backlog list` via /api/backlog. No mutation paths.

import { h } from "preact";
import { useState, useMemo } from "preact/hooks";
import htm from "htm";
import { md } from "./renderers.js";

const html = htm.bind(h);

const TYPE_LABELS = { idea: "Idea", epic: "Epic", story: "Story" };
const STATUS_LABELS = { active: "Active", done: "Done", blocked: "Blocked", deferred: "Deferred" };
const TYPES = ["epic", "story", "idea"];
const STATUSES = ["active", "blocked", "deferred", "done"];

function statusBadgeClass(status) {
  if (status === "active") return "status-complete";
  if (status === "blocked") return "status-failed";
  if (status === "done" || status === "deferred") return "status-pending";
  return "status-pending";
}

export function BacklogView({ data, projectFilter }) {
  const [typeFilter, setTypeFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const [search, setSearch] = useState("");
  const [selectedTicket, setSelectedTicket] = useState(null);

  if (!projectFilter) {
    return html`<div class="muted" style="margin-top: 20px;">Select a project to view its backlog.</div>`;
  }

  if (!data) return html`<div class="muted" style="margin-top: 20px;">loading backlog…</div>`;

  const filtered = useMemo(() => {
    let t = data.tickets || [];
    if (typeFilter) t = t.filter((tk) => tk.type === typeFilter);
    if (statusFilter) t = t.filter((tk) => tk.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      t = t.filter((tk) => tk.title.toLowerCase().includes(q) || (tk.body || "").toLowerCase().includes(q));
    }
    return t;
  }, [data.tickets, typeFilter, statusFilter, search]);

  const byType = useMemo(() => {
    const groups = {};
    for (const type of TYPES) groups[type] = filtered.filter((tk) => tk.type === type);
    return groups;
  }, [filtered]);

  const epicsById = useMemo(() => {
    const m = {};
    for (const tk of (data.tickets || [])) {
      if (tk.type === "epic") m[tk.id] = tk;
    }
    return m;
  }, [data.tickets]);

  const totalTickets = (data.tickets || []).length;

  return html`
    <div class="backlog-view">
      ${data.notes && data.notes.trim() ? html`
        <section class="backlog-notes">
          <h2>Notes / Session handoff</h2>
          <div class="card backlog-notes-body md" dangerouslySetInnerHTML=${{ __html: md(data.notes) }}></div>
        </section>
      ` : null}

      <section class="backlog-controls">
        <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 16px; margin-bottom: 8px;">
          <label class="sr-only" for="backlog-search">Search tickets</label>
          <input
            id="backlog-search"
            class="backlog-search"
            type="search"
            placeholder="Search title or body…"
            value=${search}
            onInput=${(e) => setSearch(e.target.value)}
            aria-label="Search tickets by title or body"
          />
        </div>
        <div class="row" style="gap: 6px; flex-wrap: wrap; margin-bottom: 16px; align-items: center;">
          <span class="muted" style="font-size: 12px;">type:</span>
          ${[null, ...TYPES].map((t) => html`
            <button
              key=${t ?? "all-type"}
              class=${"usage-dim-btn" + (typeFilter === t ? " usage-dim-btn-active" : "")}
              onClick=${() => setTypeFilter(t)}
              aria-pressed=${typeFilter === t}
              aria-label=${t ? `Filter by type: ${TYPE_LABELS[t]}` : "Show all types"}
            >${t ? TYPE_LABELS[t] : "all"}</button>
          `)}
          <span class="muted" style="font-size: 12px; margin-left: 8px;">status:</span>
          ${[null, ...STATUSES].map((s) => html`
            <button
              key=${s ?? "all-status"}
              class=${"usage-dim-btn" + (statusFilter === s ? " usage-dim-btn-active" : "")}
              onClick=${() => setStatusFilter(s)}
              aria-pressed=${statusFilter === s}
              aria-label=${s ? `Filter by status: ${STATUS_LABELS[s]}` : "Show all statuses"}
            >${s ? STATUS_LABELS[s] : "all"}</button>
          `)}
        </div>
      </section>

      ${totalTickets === 0
        ? html`<div class="muted backlog-empty">No backlog tickets found for this project.</div>`
        : filtered.length === 0
        ? html`<div class="muted backlog-empty">No tickets match the current filters.</div>`
        : TYPES.map((type) => {
            const group = byType[type];
            if (!group || !group.length) return null;
            return html`
              <section class="backlog-group" key=${type} aria-label=${TYPE_LABELS[type] + "s"}>
                <h2>${TYPE_LABELS[type]}s <span class="muted" style="font-weight: normal;">(${group.length})</span></h2>
                ${group.map((tk) => html`
                  <${TicketCard}
                    key=${tk.id}
                    ticket=${tk}
                    epic=${tk.epic ? epicsById[tk.epic] : null}
                    onClick=${() => setSelectedTicket(tk)}
                  />
                `)}
              </section>
            `;
          })
      }

      ${selectedTicket ? html`
        <${TicketDetail}
          ticket=${selectedTicket}
          epic=${selectedTicket.epic ? epicsById[selectedTicket.epic] : null}
          onClose=${() => setSelectedTicket(null)}
        />
      ` : null}
    </div>
  `;
}

function TicketCard({ ticket, epic, onClick }) {
  const onKey = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } };
  return html`
    <div
      class="card backlog-ticket-card"
      onClick=${onClick}
      role="button"
      tabIndex="0"
      onKeyDown=${onKey}
      aria-label=${"Open " + ticket.type + " " + ticket.id + ": " + ticket.title}
    >
      <div class="head">
        <div>
          <span class="badge ${statusBadgeClass(ticket.status)}" aria-label=${"Status: " + ticket.status}>${ticket.status}</span>
          <span class="backlog-id mono faint" style="font-size: 11px; margin: 0 6px;">${ticket.id}</span>
          <strong>${ticket.title}</strong>
        </div>
        ${epic ? html`<span class="muted" style="font-size: 11px;">Epic: ${epic.title || ticket.epic}</span>` : null}
      </div>
      ${ticket.body && ticket.body.trim() ? html`
        <div class="preview muted">${ticket.body.trim().slice(0, 200)}</div>
      ` : null}
    </div>
  `;
}

function TicketDetail({ ticket, epic, onClose }) {
  const onKey = (e) => { if (e.key === "Escape") onClose(); };
  const onCloseKey = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClose(); } };
  return html`
    <div class="detail-overlay" onClick=${onClose} onKeyDown=${onKey} role="dialog" aria-modal="true" aria-label=${"Ticket " + ticket.id}>
      <div class="detail" onClick=${(e) => e.stopPropagation()}>
        <span
          class="close"
          onClick=${onClose}
          role="button"
          tabIndex="0"
          aria-label="Close ticket detail"
          onKeyDown=${onCloseKey}
        >×</span>

        <div class="row" style="gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: baseline;">
          <span class="badge ${statusBadgeClass(ticket.status)}" aria-label=${"Status: " + ticket.status}>${ticket.status}</span>
          <span class="badge backlog-type-badge">${ticket.type}</span>
          <span class="mono faint" style="font-size: 12px;">${ticket.id}</span>
        </div>

        <h1 style="margin-bottom: 12px;">${ticket.title}</h1>

        <div class="subcard" style="margin-bottom: 16px; font-size: 12px;">
          <div class="row" style="gap: 16px; flex-wrap: wrap;">
            ${epic ? html`<span><span class="muted">epic:</span> ${epic.title || ticket.epic} <span class="faint mono">(${ticket.epic})</span></span>` : null}
            ${ticket.created ? html`<span><span class="muted">created:</span> ${ticket.created}</span>` : null}
            ${ticket.closed ? html`<span><span class="muted">closed:</span> ${ticket.closed}</span>` : null}
            ${ticket.related && ticket.related.length ? html`<span><span class="muted">related:</span> ${ticket.related.join(", ")}</span>` : null}
          </div>
        </div>

        ${ticket.body && ticket.body.trim()
          ? html`<div class="md" dangerouslySetInnerHTML=${{ __html: md(ticket.body) }}></div>`
          : html`<div class="muted faint">No body content.</div>`}
      </div>
    </div>
  `;
}
