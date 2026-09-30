// forge-dashboard — Backlog viewer (#FG-363).
//
// READ-ONLY view of the project backlog (backlog/ markdown files). Mirrors
// `forge backlog list` via /api/backlog. No mutation paths.

import { h } from "preact";
import { useState, useMemo } from "preact/hooks";
import htm from "htm";
import { badgeClass, statusClass, statusLabel } from "./status-tokens.js";
import { backlogBoardState, backlogCountLabel, backlogFilterHash, backlogFilterState, filterBacklogTickets, NO_TRUTH_MESSAGE, SHADOW_BADGE_TITLE } from "./backlog-state.js";
import { hashFor } from "./view-routing.js";
import { checkoutLabelForDir } from "./checkout-label.js";

const html = htm.bind(h);

const TYPE_LABELS = { idea: "Idea", epic: "Epic", story: "Story" };
const STATUS_LABELS = { active: "Active", done: "Done", blocked: "Blocked", deferred: "Deferred" };
const TYPES = ["epic", "story", "idea"];
const STATUSES = ["active", "blocked", "deferred", "done"];

// FG-821: a ticket opens its page, #backlog/<ticketId> (ticket-page-view.js), keeping
// the scope in hand — ticket ids are per project. FG-832: the type/status filter is the
// hash's (`#backlog?type=&status=`), defaulting to every type, active only. FG-830: the
// session-handoff notes moved to their own view (notes-view.js); the tickets start here.
export function BacklogView({ data, projectFilter, scope, projects = [], params = null }) {
  const filter = backlogFilterState(params);
  const [search, setSearch] = useState("");

  if (!projectFilter) {
    return html`<div class="muted" style="margin-top: 20px;">Select a project to view its backlog.</div>`;
  }

  if (!data) return html`<div class="muted" style="margin-top: 20px;">loading backlog…</div>`;

  const filtered = useMemo(() => {
    let t = filterBacklogTickets(data.tickets, filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      t = t.filter((tk) => tk.title.toLowerCase().includes(q) || (tk.body || "").toLowerCase().includes(q));
    }
    return t;
  }, [data.tickets, filter.type, filter.status, search]);

  const byType = useMemo(() => {
    const groups = {};
    for (const type of TYPES) groups[type] = filtered.filter((tk) => tk.type === type);
    return groups;
  }, [filtered]);

  const epicsById = useMemo(() => {
    const m = {};
    for (const tk of (data.tickets || [])) {
      if (tk.type === "epic") m[`${tk.checkoutDir || ""}:${tk.id}`] = tk;
    }
    return m;
  }, [data.tickets]);

  const totalTickets = (data.tickets || []).length;
  const board = backlogBoardState(data);

  return html`
    <div class="backlog-view">
      ${board.error ? html`
        <div class="card backlog-error" role="alert" style="border-left: 3px solid var(--status-failed, #c0392b); margin-top: 16px;">
          <strong>Backlog read failed.</strong> This board is not showing this project's tickets —
          it is showing nothing, which is not the same as an empty backlog.
          <div class="muted" style="font-size: 12px; margin-top: 6px; word-break: break-word;">${board.error}</div>
        </div>
      ` : null}
      ${board.shadow ? html`
        <div class="muted backlog-shadow-badge" title=${SHADOW_BADGE_TITLE} style="margin-top: 16px; font-size: 12px;">
          <span class=${badgeClass("task", "pending")}>import shadow — not authoritative</span>
          ${" "}markdown mode: <code>backlog/*.md</code> in the checkout is this project's ticket truth.
        </div>
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
          <span class="muted" style="font-size: 12px;" id="backlog-type-label">type:</span>
          <span class="row" style="gap: 6px; flex-wrap: wrap;" role="group" aria-labelledby="backlog-type-label">
            ${["all", ...TYPES].map((t) => html`
              <${FilterButton}
                key=${t}
                pressed=${filter.type === t}
                href=${backlogFilterHash(scope, { ...filter, type: t })}
                label=${t === "all" ? "Show all types" : `Filter by type: ${TYPE_LABELS[t]}`}
              >${t === "all" ? "All" : TYPE_LABELS[t]}</${FilterButton}>
            `)}
          </span>
          <span class="muted" style="font-size: 12px; margin-left: 8px;" id="backlog-status-label">status:</span>
          <span class="row" style="gap: 6px; flex-wrap: wrap;" role="group" aria-labelledby="backlog-status-label">
            ${["all", ...STATUSES].map((st) => html`
              <${FilterButton}
                key=${st}
                pressed=${filter.status === st}
                href=${backlogFilterHash(scope, { ...filter, status: st })}
                label=${st === "all" ? "Show all statuses" : `Filter by status: ${STATUS_LABELS[st]}`}
              >${st === "all" ? "All" : STATUS_LABELS[st]}</${FilterButton}>
            `)}
          </span>
        </div>
        ${totalTickets > 0 ? html`
          <div class="backlog-result-count muted" style="font-size: 12px; margin-bottom: 12px;" aria-live="polite">
            ${backlogCountLabel(filtered.length, totalTickets)}
          </div>
        ` : null}
      </section>

      ${board.kind === "error"
        ? null
        : board.kind === "no-truth"
        ? html`<div class="muted backlog-empty backlog-no-truth">${NO_TRUTH_MESSAGE}</div>`
        : totalTickets === 0
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
                    key=${`${tk.checkoutDir || ""}:${tk.id}`}
                    ticket=${tk}
                    epic=${tk.epic ? epicsById[`${tk.checkoutDir || ""}:${tk.epic}`] : null}
                    href=${hashFor({ view: "backlog", id: tk.id, scope })}
                    projects=${projects}
                  />
                `)}
              </section>
            `;
          })
      }
    </div>
  `;
}

function FilterButton({ pressed, href, label, children }) {
  return html`
    <button
      type="button"
      class=${"usage-dim-btn" + (pressed ? " usage-dim-btn-active" : "")}
      onClick=${() => { window.location.hash = href; }}
      aria-pressed=${pressed ? "true" : "false"}
      aria-label=${label}
    >${children}</button>
  `;
}

function TicketCard({ ticket, epic, href, projects }) {
  return html`
    <a
      class="card backlog-ticket-card"
      href=${href}
      aria-label=${"Open " + ticket.type + " " + ticket.id + ": " + ticket.title}
    >
      <div class="head">
        <div>
          <span class="badge ${statusClass("ticket", ticket.status)}" aria-label=${"Status: " + ticket.status}>${statusLabel("ticket", ticket.status)}</span>
          <span class="backlog-id mono faint" style="font-size: 11px; margin: 0 6px;">${ticket.id}</span>
          <strong>${ticket.title}</strong>
          ${ticket.checkoutDir ? html`<span class="checkout-chip" title=${ticket.checkoutDir}>${checkoutLabelForDir(ticket.checkoutDir, projects, ticket.checkoutBranch)}</span>` : null}
        </div>
        ${epic ? html`<span class="muted" style="font-size: 11px;">Epic: ${epic.title || ticket.epic}</span>` : null}
      </div>
      ${ticket.body && ticket.body.trim() ? html`
        <div class="preview muted">${ticket.body.trim().slice(0, 200)}</div>
      ` : null}
    </a>
  `;
}
