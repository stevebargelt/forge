// FG-781 (step 5): the Remote Board's FOCUSED client. A dependency-free ES module served
// from dashboard/remote-client/ by the remote server's runtime-path handler — NOT the local
// dashboard's client bundle. It runs under the remote shell's `script-src 'self' 'nonce-…'`
// CSP, so it ships as first-party vanilla JS: no framework, no importmap, no CDN import.
//
// WHAT IT DOES. It reads its endpoint from the shell's inline bootstrap
// (`window.__REMOTE_BOARD__.endpoint`), fetches the projection envelope, and renders exactly
// ONE of the five honest states the contract (projection.ts) defines:
//
//   live            → the project-scoped board, marked LIVE with its generation time.
//   stale           → the SAME board shape, but marked STALE and explicitly "not live" — the
//                     one rule that cannot bend: cached/behind data is never painted as live.
//   host-unavailable→ no project data; the host store could not be read.
//   unauthorized    → no project data; no verified identity/grant (the FG-781 default).
//   unsupported     → no project data; the surface does not implement what was asked.
//
// Only `live` and `stale` carry `board`; the other three refuse with board:null, so there is
// never any project payload to mis-render. A network/parse failure is treated as
// host-unavailable — the surface degrades, it never throws a blank page at the operator.
//
// ACCESSIBILITY. Semantic landmarks and headings (one h1, an h2 per section), a role="status"
// live region that announces the current state to a screen reader, a keyboard-reachable
// Refresh control, visible focus, and state signalled by TEXT (not colour alone). The layout
// is a single responsive grid: one column on a phone, multiple on a desktop, no horizontal
// scroll. It needs no active agent session — it renders entirely from the projection.

const MOUNT_ID = "remote-board";

/** Human labels + the accessible status sentence for each of the five states. `hasData` marks
 *  the two states that carry a board; the status sentence never calls a non-live read "live". */
const STATES = {
  live: { hasData: true, label: "Live", status: "Live — showing the current board." },
  stale: {
    hasData: true,
    label: "Stale",
    status: "Stale — showing the last known board. This is NOT live data.",
  },
  "host-unavailable": {
    hasData: false,
    label: "Host unavailable",
    status: "Host unavailable — the board host could not be reached. No data is shown.",
  },
  unauthorized: {
    hasData: false,
    label: "Not authorized",
    status: "Not authorized — this board has no verified access. No data is shown.",
  },
  unsupported: {
    hasData: false,
    label: "Unsupported",
    status: "Unsupported — this board cannot serve the requested view. No data is shown.",
  },
};

// ─── tiny DOM helper (no framework) ──────────────────────────────────────────────
// Text is set via textContent, never innerHTML, so a projected title/goal can never inject
// markup onto the remote surface.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("aria-") || key === "role" || key === "tabindex")
      node.setAttribute(key, String(value));
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function formatTime(iso) {
  if (!iso) return "unknown";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "unknown";
  try {
    return new Date(parsed).toLocaleString();
  } catch {
    return iso;
  }
}

// ─── section renderers (allowlist DTOs → focused, read-only cards) ────────────────

function section(title, ...body) {
  return el("section", { class: "rb-card", "aria-label": title }, el("h2", { text: title }), ...body);
}

function defList(pairs) {
  const dl = el("dl", { class: "rb-defs" });
  for (const [term, value] of pairs) {
    dl.appendChild(el("dt", { text: term }));
    dl.appendChild(el("dd", { text: value === null || value === undefined ? "—" : String(value) }));
  }
  return dl;
}

function projectSection(project) {
  return section(
    "Project",
    el("p", { class: "rb-project-label" }, el("strong", { text: project.label }), ` (${project.projectKey})`),
    project.description ? el("p", { class: "rb-muted", text: project.description }) : null,
    defList([
      ["Runs", project.runCount],
      ["In flight", project.inFlightCount],
      ["Live sessions", project.liveSessions],
      ["Last run", formatTime(project.lastRunAt)],
    ]),
  );
}

function backlogSection(backlog) {
  const tickets = backlog.tickets ?? [];
  const list = el("ul", { class: "rb-list", "aria-label": "Backlog tickets" });
  for (const ticket of tickets.slice(0, 50)) {
    list.appendChild(
      el(
        "li",
        { class: "rb-row" },
        el("span", { class: "rb-badge", text: ticket.status }),
        el("span", { class: "rb-id", text: ticket.id }),
        el("span", { class: "rb-title", text: ticket.title }),
      ),
    );
  }
  return section(
    "Backlog",
    el("p", { class: "rb-muted", text: `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}` }),
    tickets.length ? list : el("p", { class: "rb-empty-note", text: "No backlog tickets." }),
  );
}

function queueSection(queue) {
  if (!queue.queueAvailable) {
    return section(
      "Queue",
      el("p", { class: "rb-empty-note", text: queue.unavailableReason || "Queue unavailable." }),
    );
  }
  const rows = queue.rows ?? [];
  const list = el("ul", { class: "rb-list", "aria-label": "Queue rows" });
  for (const row of rows.slice(0, 50)) {
    const flags = [
      row.inProgress ? "in progress" : null,
      row.blocked ? "blocked" : null,
      row.queued ? "queued" : null,
      row.waitKind ? `waiting: ${row.waitKind}` : null,
    ].filter(Boolean);
    list.appendChild(
      el(
        "li",
        { class: "rb-row" },
        el("span", { class: "rb-id", text: row.ticketId }),
        el("span", { class: "rb-title", text: row.title }),
        el("span", { class: "rb-muted", text: flags.join(" · ") || row.executionState }),
      ),
    );
  }
  return section(
    "Queue",
    el("p", { class: "rb-muted", text: `${rows.length} row${rows.length === 1 ? "" : "s"}` }),
    rows.length ? list : el("p", { class: "rb-empty-note", text: "Queue is empty." }),
  );
}

function campaignsSection(campaigns) {
  const list = el("ul", { class: "rb-list", "aria-label": "Campaigns" });
  for (const campaign of campaigns.slice(0, 50)) {
    list.appendChild(
      el(
        "li",
        { class: "rb-row" },
        el("span", { class: "rb-badge", text: campaign.status }),
        el("span", { class: "rb-title", text: campaign.goal || campaign.campaignId }),
        el("span", {
          class: "rb-muted",
          text: `${campaign.counts.shipped}/${campaign.counts.total} shipped`,
        }),
      ),
    );
  }
  return section(
    "Campaigns",
    el("p", { class: "rb-muted", text: `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}` }),
    campaigns.length ? list : el("p", { class: "rb-empty-note", text: "No campaigns." }),
  );
}

function inboxSection(inbox) {
  const items = inbox.items ?? [];
  const list = el("ul", { class: "rb-list", "aria-label": "Attention inbox" });
  for (const item of items.slice(0, 50)) {
    list.appendChild(
      el(
        "li",
        { class: "rb-row" },
        item.severity ? el("span", { class: "rb-badge", text: item.severity }) : null,
        el("span", { class: "rb-title", text: item.reason }),
        el("span", { class: "rb-muted", text: item.requestedAction }),
      ),
    );
  }
  return section(
    "Attention",
    el("p", { class: "rb-muted", text: inbox.empty ? "Nothing needs attention." : `${items.length} item${items.length === 1 ? "" : "s"}` }),
    items.length ? list : null,
  );
}

function activitySection(activity) {
  const agents = activity.agents ?? [];
  const list = el("ul", { class: "rb-list", "aria-label": "Current activity" });
  for (const agent of agents.slice(0, 50)) {
    list.appendChild(
      el(
        "li",
        { class: "rb-row" },
        el("span", { class: "rb-badge", text: agent.status }),
        el("span", { class: "rb-title", text: `${agent.agentRole} · ${agent.phase}` }),
        el("span", { class: "rb-muted", text: agent.runTitle }),
      ),
    );
  }
  // No dependency on a live agent session: when nothing is running we say so explicitly and
  // still render the section, rather than blanking or spinning.
  return section(
    "Activity",
    el("p", { class: "rb-muted", text: activity.hasLiveWork ? `${activity.counts.agents} agent${activity.counts.agents === 1 ? "" : "s"} active` : "No active agent session." }),
    agents.length ? list : null,
  );
}

// ─── the state view ───────────────────────────────────────────────────────────────

function stateBanner(state, envelope) {
  const meta = STATES[state] ?? STATES.unsupported;
  const banner = el(
    "div",
    {
      // role="status" is an implicit polite live region: a screen reader announces the state
      // text on each render, so a live→stale flip is spoken, never silent.
      role: "status",
      class: `rb-state rb-state--${state}`,
      "data-state": state,
    },
    el("span", { class: "rb-state-dot", "aria-hidden": "true" }),
    el("span", { class: "rb-state-label", text: meta.label }),
    el("span", { class: "rb-state-detail", text: meta.status }),
  );
  if (meta.hasData && envelope && envelope.generatedAt) {
    banner.appendChild(
      el("span", {
        class: "rb-state-time",
        text: `${state === "stale" ? "as of" : "updated"} ${formatTime(envelope.generatedAt)}`,
      }),
    );
  }
  return banner;
}

function render(mount, state, envelope, onRefresh) {
  const known = STATES[state] ? state : "unsupported";
  const meta = STATES[known];

  // A refresh replaces the whole subtree, which would drop keyboard focus to <body> and strand
  // a keyboard user. If the Refresh control held focus going in, restore it to the rebuilt one
  // so activating Refresh does not cost the operator their place.
  const active = document.activeElement;
  const refocusRefresh = active instanceof HTMLElement && mount.contains(active) && active.classList.contains("rb-refresh");

  mount.setAttribute("aria-busy", "false");
  mount.replaceChildren();

  const header = el(
    "header",
    { class: "rb-header" },
    el("h1", { text: "forge remote board" }),
    stateBanner(known, envelope),
    el(
      "button",
      { type: "button", class: "rb-refresh", "aria-label": "Refresh the board" },
      "Refresh",
    ),
  );
  const refreshButton = header.querySelector(".rb-refresh");
  refreshButton.addEventListener("click", onRefresh);
  mount.appendChild(header);
  if (refocusRefresh) refreshButton.focus();

  const board = envelope && envelope.board;
  if (meta.hasData && board) {
    const grid = el("div", { class: "rb-grid" });
    grid.appendChild(projectSection(board.projectSummary));
    grid.appendChild(backlogSection(board.backlog));
    grid.appendChild(queueSection(board.queue));
    grid.appendChild(campaignsSection(board.campaigns ?? []));
    grid.appendChild(inboxSection(board.inbox));
    grid.appendChild(activitySection(board.activity));
    mount.appendChild(grid);
  } else {
    // Every refusal/degradation paints a message region and NO project data.
    mount.appendChild(
      el(
        "div",
        { class: "rb-refusal", role: "region", "aria-label": "Board unavailable" },
        el("p", { class: "rb-refusal-text", text: meta.status }),
      ),
    );
  }
}

// ─── boot ───────────────────────────────────────────────────────────────────────

function injectStyle() {
  if (document.getElementById("rb-style")) return;
  const style = document.createElement("style");
  style.id = "rb-style";
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// RF-3: overlapping refreshes must never let an OLDER in-flight read overwrite a newer render
// (an older `live` landing after a newer `stale` would repaint stale data as live — the one
// rule the contract forbids). Each load takes a monotonically increasing generation; only the
// LATEST generation is allowed to render. A superseded response is discarded, not painted.
let requestGeneration = 0;

async function load(mount, endpoint) {
  const generation = ++requestGeneration;
  const isCurrent = () => generation === requestGeneration;
  mount.setAttribute("aria-busy", "true");
  const onRefresh = () => load(mount, endpoint);
  try {
    const res = await fetch(endpoint, { headers: { Accept: "application/json" }, cache: "no-store" });
    const envelope = await res.json();
    if (!isCurrent()) return; // a newer refresh already superseded this read — never repaint over it
    const state = envelope && typeof envelope.state === "string" ? envelope.state : "host-unavailable";
    render(mount, state, envelope, onRefresh);
  } catch {
    if (!isCurrent()) return; // a superseded read's failure must not clobber the newer render either
    // A transport/parse failure is a host-unavailable read — never a blank page, and never a
    // fabricated "live".
    render(mount, "host-unavailable", null, onRefresh);
  }
}

function start() {
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;
  injectStyle();
  const endpoint = (window.__REMOTE_BOARD__ && window.__REMOTE_BOARD__.endpoint) || "/api/board";
  void load(mount, endpoint);
}

// ─── styles (inline <style>; style-src is unconstrained by the shell CSP) ─────────
// Responsive: an auto-fit grid gives one column on a phone and several on a desktop with no
// media query needed for the cards; the header wraps. Focus is always visible. State colour
// is a SECONDARY channel — every state also carries its label + detail text.
const STYLE = String.raw`
#${MOUNT_ID} { max-width: 1100px; }
.rb-header {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px;
  padding-bottom: 12px; margin-bottom: 16px; border-bottom: 1px solid #2a2a30;
}
.rb-header h1 { font-size: 1.25rem; margin: 0; flex: 0 0 auto; }
.rb-state {
  display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
  padding: 6px 12px; border-radius: 999px; font-size: 0.85rem;
  border: 1px solid currentColor;
}
.rb-state-dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.rb-state-label { font-weight: 700; letter-spacing: 0.02em; }
.rb-state-detail { color: #cfcfd6; font-weight: 400; }
.rb-state-time { color: #9a9aa3; font-variant-numeric: tabular-nums; }
.rb-state--live { color: #4ade80; }
.rb-state--stale { color: #fbbf24; }
.rb-state--host-unavailable { color: #f87171; }
.rb-state--unauthorized { color: #f87171; }
.rb-state--unsupported { color: #a1a1aa; }
.rb-refresh {
  margin-left: auto; flex: 0 0 auto;
  font: inherit; color: #e5e5e7; background: #1c1c22;
  border: 1px solid #3a3a42; border-radius: 8px; padding: 6px 14px; cursor: pointer;
}
.rb-refresh:hover { background: #26262e; }
.rb-refresh:focus-visible, .rb-refresh:focus {
  outline: 2px solid #7dd3fc; outline-offset: 2px;
}
.rb-grid {
  display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}
.rb-card {
  background: #17171b; border: 1px solid #26262c; border-radius: 12px; padding: 14px 16px;
  min-width: 0;
}
.rb-card h2 { font-size: 1rem; margin: 0 0 10px; }
.rb-muted { color: #9a9aa3; margin: 4px 0; }
.rb-empty-note { color: #9a9aa3; font-style: italic; margin: 4px 0; }
.rb-project-label { margin: 0 0 6px; }
.rb-defs { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 8px 0 0; }
.rb-defs dt { color: #9a9aa3; }
.rb-defs dd { margin: 0; font-variant-numeric: tabular-nums; }
.rb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rb-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.rb-badge {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em;
  background: #26262e; color: #cfcfd6; border-radius: 5px; padding: 1px 6px; flex: 0 0 auto;
}
.rb-id { color: #7dd3fc; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.rb-title { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.rb-refusal {
  border: 1px solid #3a2a2a; background: #1c1618; border-radius: 12px; padding: 20px 18px;
}
.rb-refusal-text { margin: 0; color: #e5e5e7; }
@media (prefers-reduced-motion: no-preference) {
  .rb-refresh { transition: background 120ms ease; }
}
`;

// ─── boot ───────────────────────────────────────────────────────────────────────
// Kept at the very end so `STYLE` (a `const` declared above) is initialized before this
// module-eval-time boot runs. A `type="module"` script is deferred, so by the time it
// executes the document is already parsed (readyState "interactive"/"complete") and start()
// runs synchronously — referencing STYLE any earlier would hit its temporal dead zone.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
