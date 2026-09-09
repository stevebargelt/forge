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

function backlogSection(backlog, plan) {
  const tickets = backlog.tickets ?? [];
  const list = el("ul", { class: "rb-list", "aria-label": "Backlog tickets" });
  for (const ticket of tickets.slice(0, 50)) {
    // A ticket revision is the annotation precondition. The board's backlog DTO does not carry a
    // revision today (flagged: RemoteBacklogTicket in projection.ts has no `revision`), so this
    // reads it optimistically and falls back to 0 — a superseded revision then refuses server-side
    // with a safe summary rather than clobbering. See the ticket's plan-defect note.
    const ctx = { ticketId: ticket.id, ticketRevision: typeof ticket.revision === "number" ? ticket.revision : 0 };
    list.appendChild(
      el(
        "li",
        { class: "rb-row" },
        el("span", { class: "rb-badge", text: ticket.status }),
        el("span", { class: "rb-id", text: ticket.id }),
        el("span", { class: "rb-title", text: ticket.title }),
        plan ? planActionsRow(["enqueue", "append-annotation"], { ...ctx, ...plan }) : null,
      ),
    );
  }
  return section(
    "Backlog",
    el("p", { class: "rb-muted", text: `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}` }),
    tickets.length ? list : el("p", { class: "rb-empty-note", text: "No backlog tickets." }),
  );
}

function queueSection(queue, plan) {
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
    // Rank/reorder carry the queue version the board LOADED (a compare-and-set precondition); a
    // queue that moved since refuses. Dequeue carries no version (it retains rank). Only queued
    // rows can be dequeued/ranked/moved; every row can be annotated.
    const ctx = { ticketId: row.ticketId, ticketRevision: typeof row.revision === "number" ? row.revision : 0 };
    const actions = row.queued ? ["dequeue", "change-rank", "reorder-queue", "append-annotation"] : ["append-annotation"];
    list.appendChild(
      el(
        "li",
        { class: "rb-row" },
        el("span", { class: "rb-id", text: row.ticketId }),
        el("span", { class: "rb-title", text: row.title }),
        el("span", { class: "rb-muted", text: flags.join(" · ") || row.executionState }),
        plan ? planActionsRow(actions, { ...ctx, ...plan }) : null,
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

  // The last rendered envelope is the source of the preconditions a planning submit carries
  // (the queue version / ticket revision the operator was looking at). Captured here so a
  // dialog opened after this render pins the values THIS board showed.
  currentEnvelope = meta.hasData ? envelope : null;

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
    // RF-2: whether THIS identity may plan is SERVER-AUTHORITATIVE and now carried on the
    // envelope. Planning affordances render ONLY when the granted capabilities include 'plan';
    // a read-only board shows no action controls the host would refuse. RF-4: and only when a
    // secure random source exists to mint the idempotency key (else planning fails closed).
    const canPlan = Array.isArray(envelope.capabilities) && envelope.capabilities.includes("plan");
    const planningSupported = planningRandomAvailable();
    // The planning context every actionable row shares: the queue version the board loaded (the
    // rank/reorder compare-and-set precondition) and the current queued ids (the change-rank
    // reference set). Null when this identity cannot plan — sections then render no affordances.
    const queue = board.queue ?? {};
    const plan =
      canPlan && planningSupported
        ? {
            expectVersion: typeof queue.version === "number" ? queue.version : 0,
            queuedIds: (queue.rows ?? []).filter((r) => r.queued).map((r) => r.ticketId),
          }
        : null;
    // A one-line, screen-reader-available note only when planning is actually offered. A read-only
    // identity sees no note and no controls; a plan-capable identity on a crypto-less browser sees
    // an explicit 'unsupported' note instead of dead controls (RF-4).
    if (canPlan && planningSupported) {
      mount.appendChild(
        el("p", {
          class: "rb-plan-note",
          text: "Planning actions change the queue/backlog on the host. They require the ‘plan’ capability; a refusal explains what the host rejected and no change is made until the host confirms it.",
        }),
      );
    } else if (canPlan && !planningSupported) {
      mount.appendChild(
        el("p", {
          class: "rb-plan-note rb-plan-unsupported",
          text: "Planning actions are unavailable in this browser: it has no secure random source (Web Crypto), which is required to submit a command safely.",
        }),
      );
    }
    const grid = el("div", { class: "rb-grid" });
    grid.appendChild(projectSection(board.projectSummary));
    grid.appendChild(backlogSection(board.backlog, plan));
    grid.appendChild(queueSection(board.queue, plan));
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

// ─── FG-783: bounded planning actions (confirm → submit → result) ─────────────────
//
// The Remote Board is read-only by default; a plan-capable identity can additionally reach the
// four planning categories the host exposes (five wire commands): enqueue / dequeue a ticket,
// change its stack rank relative to a neighbour, reorder the operator queue, and append a bounded
// planning annotation. This client is NEVER OPTIMISTIC: on a recorded `applied` outcome it CLOSES
// the dialog and RE-READS /api/board, so the board only ever shows what the host actually
// committed — it never paints a hoped-for state. A refusal (a stale precondition, a missing
// capability, a CSRF/scope refusal, a malformed/oversized body) is surfaced with the server's own
// safe summary and a retry path; nothing in the DOM is mutated to imply success.
//
// IDEMPOTENCY. Each open dialog carries ONE requestId (the server's replay-ledger key). On a
// TRANSPORT failure (no server verdict — the command may or may not have applied) the retry
// REUSES that id, so a redelivery replays the recorded outcome instead of double-applying. On a
// definitive server REFUSAL (a verdict arrived; the host applied nothing) the retry re-reads the
// board and the operator resubmits from a fresh dialog with a NEW id + refreshed precondition —
// the refused id is spent (the ledger would just replay the refusal).
//
// PRECONDITIONS are the ones the board LOADED, captured when the dialog opens: the queue version
// for rank/reorder (a compare-and-set — a moved queue refuses) and the ticket revision for an
// annotation. Rank is expressed RELATIVE to a neighbour, never as an absolute number (a rank value
// renumbers on every move; the host keys the precondition off the version, not the number).

/** The reusable modal overlay (one at a time) and the control to refocus when it closes. */
let planOverlay = null;
let planReturnFocus = null;

/** RF-3: a persistent, screen-reader live region for the applied-outcome confirmation. The
 *  dialog's OWN role=status region is removed synchronously when the dialog closes, so a screen
 *  reader never hears "Applied" if the success is announced only there. This region lives OUTSIDE
 *  the board mount (which render() replaces wholesale on every re-read), so the confirmation
 *  persists across the close + re-read rather than being wiped with the dialog. */
let planAnnouncer = null;
function announcePlanOutcome(text) {
  if (!planAnnouncer) {
    planAnnouncer = el("div", { role: "status", "aria-live": "polite", class: "rb-sr-only" });
    document.body.appendChild(planAnnouncer);
  }
  planAnnouncer.textContent = text;
}

/** RF-4: is a cryptographically secure random source available? A unique idempotency key is
 *  load-bearing for the server's replay ledger — without one, every command would carry the
 *  same id and be treated as a replay of the first. When neither randomUUID nor getRandomValues
 *  exists we FAIL CLOSED (disable planning) rather than emit a constant. */
function planningRandomAvailable() {
  const c = globalThis.crypto;
  return !!(c && (typeof c.randomUUID === "function" || typeof c.getRandomValues === "function"));
}

/** A unique idempotency key. crypto.randomUUID satisfies the server's REQUEST_ID charset
 *  (alphanumeric first char, then [A-Za-z0-9._:-]); a getRandomValues hex fallback covers its
 *  rare absence. RF-4: with NEITHER available it returns null — it never falls back to an
 *  all-zero constant, which would make every later command a replay of the first. The caller
 *  refuses to submit on a null id (and the affordances are gated on planningRandomAvailable so
 *  this path is not normally reachable). */
function newRequestId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return "r" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return null;
}

/** The closed set of planning actions this client can offer, each with the operands it collects
 *  and the body it builds. `action` is a member of the server's closed registry; nothing else is
 *  reachable from here. Actor / transport / project key / timestamp are NEVER in the body — the
 *  host attaches them from the verified identity. */
const PLAN_ACTION_SPECS = {
  enqueue: {
    verb: "Enqueue",
    title: (ctx) => `Enqueue ${ctx.ticketId}`,
    describe: (ctx) => `Enqueue ${ctx.ticketId} through the readiness gates.`,
    precondition: () => "Precondition: the host re-checks readiness at the current revision when it applies.",
    fields: [{ name: "note", label: "Membership note (optional)", control: "textarea", required: false, maxLength: 500 }],
    buildBody: (ctx, v) => (v.note ? { action: "enqueue", ticketId: ctx.ticketId, note: v.note } : { action: "enqueue", ticketId: ctx.ticketId }),
  },
  dequeue: {
    verb: "Dequeue",
    title: (ctx) => `Dequeue ${ctx.ticketId}`,
    describe: (ctx) => `Remove ${ctx.ticketId} from the operator queue. Its stack rank is retained.`,
    precondition: () => "Precondition: none — dequeue retains rank and clobbers no version.",
    fields: [],
    buildBody: (ctx) => ({ action: "dequeue", ticketId: ctx.ticketId }),
  },
  "change-rank": {
    verb: "Rank",
    title: (ctx) => `Change the stack rank of ${ctx.ticketId}`,
    describe: (ctx) => `Rank ${ctx.ticketId} before or after another queued ticket.`,
    precondition: (ctx) => `Precondition: queue version ${ctx.expectVersion} — a compare-and-set. If the queue moved, this refuses and you re-read.`,
    fields: [
      { name: "placement", label: "Placement", control: "select", options: () => ["before", "after"], required: true },
      { name: "reference", label: "Relative to", control: "select", options: (ctx) => ctx.queuedIds.filter((id) => id !== ctx.ticketId), required: true },
    ],
    buildBody: (ctx, v) => ({ action: "change-rank", ticketId: ctx.ticketId, reference: v.reference, placement: v.placement, expectVersion: ctx.expectVersion }),
  },
  "reorder-queue": {
    verb: "Move",
    title: (ctx) => `Move ${ctx.ticketId} in the queue`,
    describe: (ctx) => `Move ${ctx.ticketId} to a new 1-based position in the operator queue.`,
    precondition: (ctx) => `Precondition: queue version ${ctx.expectVersion} — a compare-and-set. If the queue moved, this refuses and you re-read.`,
    fields: [{ name: "to", label: "Move to position (1 = top)", control: "number", required: true, min: 1 }],
    buildBody: (ctx, v) => ({ action: "reorder-queue", ticketId: ctx.ticketId, to: v.to, expectVersion: ctx.expectVersion }),
  },
  "append-annotation": {
    verb: "Annotate",
    title: (ctx) => `Annotate ${ctx.ticketId}`,
    describe: (ctx) => `Append a bounded operator planning annotation to ${ctx.ticketId}.`,
    precondition: (ctx) => `Precondition: ticket revision ${ctx.ticketRevision} — a superseded revision refuses.`,
    fields: [{ name: "body", label: "Annotation", control: "textarea", required: true, maxLength: 2000 }],
    buildBody: (ctx, v) => ({ action: "append-annotation", ticketId: ctx.ticketId, ticketRevision: ctx.ticketRevision, body: v.body }),
  },
};

/** A row of planning-action trigger buttons for one target. */
function planActionsRow(actions, ctx) {
  const group = el("div", { class: "rb-actions", role: "group", "aria-label": `Planning actions for ${ctx.ticketId}` });
  for (const action of actions) {
    const spec = PLAN_ACTION_SPECS[action];
    if (!spec) continue;
    const btn = el("button", { type: "button", class: "rb-plan-trigger", "data-plan-action": action, "data-plan-target": ctx.ticketId });
    btn.textContent = spec.verb;
    btn.setAttribute("aria-label", `${spec.verb} ${ctx.ticketId}`);
    btn.addEventListener("click", () => openPlanDialog(action, { ...ctx, triggerEl: btn }));
    group.appendChild(btn);
  }
  return group;
}

/** Render the server's redacted safe summary into one operator-readable line. */
function planSummaryText(summary) {
  if (!summary || typeof summary !== "object") return null;
  const parts = [];
  if (summary.message) parts.push(String(summary.message));
  if (typeof summary.queueVersion === "number") parts.push(`queue is now at version ${summary.queueVersion}`);
  if (Array.isArray(summary.queue) && summary.queue.length) parts.push(`current order: ${summary.queue.join(" → ")}`);
  if (typeof summary.ticketRevision === "number") parts.push(`current ticket revision ${summary.ticketRevision}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Keyboard handling for the open dialog: Escape closes, Tab is trapped inside. */
function onPlanKeydown(event) {
  if (!planOverlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePlanDialog();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...planOverlay.querySelectorAll("button, input, select, textarea")].filter(
    (n) => !n.disabled && !n.hidden && n.getAttribute("aria-hidden") !== "true",
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function closePlanDialog() {
  if (planOverlay) {
    planOverlay.remove();
    planOverlay = null;
  }
  document.removeEventListener("keydown", onPlanKeydown, true);
  const trigger = planReturnFocus;
  planReturnFocus = null;
  // Return focus to the control that opened the dialog so a keyboard operator keeps their place.
  if (trigger && document.contains(trigger)) trigger.focus();
}

/** Open the accessible confirm → submit → result dialog for one planning action + target. */
function openPlanDialog(action, ctx) {
  const spec = PLAN_ACTION_SPECS[action];
  if (!spec) return;
  closePlanDialog(); // never stack two
  planReturnFocus = ctx.triggerEl || (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  // ONE idempotency key per open dialog. A transport retry reuses it (idempotent replay); a
  // refusal spends it (the operator re-reads and reopens for a fresh one).
  const attempt = { requestId: newRequestId() };

  const titleId = "rb-plan-title";
  const descId = "rb-plan-desc";
  const dialog = el("div", { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": descId, class: "rb-plan-dialog" });
  dialog.appendChild(el("h2", { id: titleId, class: "rb-plan-title", text: spec.title(ctx) }));
  dialog.appendChild(el("p", { id: descId, class: "rb-plan-desc", text: spec.describe(ctx) }));
  dialog.appendChild(el("p", { class: "rb-plan-precond", text: spec.precondition(ctx) }));

  const form = el("form", { class: "rb-plan-form" });
  const controls = {};
  for (const field of spec.fields) {
    const fieldId = `rb-plan-field-${field.name}`;
    const label = el("label", { class: "rb-plan-label", for: fieldId, text: field.label });
    let control;
    if (field.control === "textarea") {
      control = el("textarea", { id: fieldId, class: "rb-plan-input", rows: "3" });
      if (field.maxLength) control.setAttribute("maxlength", String(field.maxLength));
    } else if (field.control === "select") {
      control = el("select", { id: fieldId, class: "rb-plan-input" });
      const options = (typeof field.options === "function" ? field.options(ctx) : field.options) || [];
      for (const option of options) control.appendChild(el("option", { value: option, text: option }));
    } else {
      control = el("input", { id: fieldId, class: "rb-plan-input", type: field.control === "number" ? "number" : "text" });
      if (field.control === "number" && field.min != null) control.setAttribute("min", String(field.min));
      if (field.maxLength) control.setAttribute("maxlength", String(field.maxLength));
    }
    if (field.required) control.setAttribute("aria-required", "true");
    controls[field.name] = control;
    form.appendChild(el("div", { class: "rb-plan-field" }, label, control));
  }

  // role="status" (polite) narrates progress; role="alert" (assertive) announces a refusal.
  const statusLine = el("p", { class: "rb-plan-status", role: "status", "aria-live": "polite" });
  const errorLine = el("div", { class: "rb-plan-error", role: "alert", hidden: true });
  const confirm = el("button", { type: "submit", class: "rb-plan-confirm" });
  confirm.textContent = spec.verb;
  const cancel = el("button", { type: "button", class: "rb-plan-cancel", text: "Cancel" });
  const retry = el("button", { type: "button", class: "rb-plan-retry", hidden: true });
  cancel.addEventListener("click", () => closePlanDialog());
  const buttons = el("div", { class: "rb-plan-buttons" }, confirm, cancel, retry);
  form.appendChild(statusLine);
  form.appendChild(errorLine);
  form.appendChild(buttons);
  dialog.appendChild(form);

  const overlay = el("div", { class: "rb-plan-overlay" }, dialog);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closePlanDialog(); // click the backdrop to dismiss
  });

  const readValues = () => {
    const values = {};
    for (const [name, ctrl] of Object.entries(controls)) values[name] = ctrl.value.trim();
    return values;
  };
  const firstInvalidField = (values) => {
    for (const field of spec.fields) {
      if (field.required && !values[field.name]) return field;
    }
    return null;
  };
  const setSubmitting = (busy) => {
    confirm.disabled = busy;
    cancel.disabled = busy;
    for (const ctrl of Object.values(controls)) ctrl.disabled = busy;
  };
  const showError = (message, summary) => {
    errorLine.replaceChildren();
    errorLine.appendChild(el("span", { class: "rb-plan-error-msg", text: message }));
    if (summary) errorLine.appendChild(el("span", { class: "rb-plan-summary", text: summary }));
    errorLine.removeAttribute("hidden");
  };
  const clearError = () => {
    errorLine.setAttribute("hidden", "true");
    errorLine.replaceChildren();
  };

  const submit = async () => {
    clearError();
    const values = readValues();
    const invalid = firstInvalidField(values);
    if (invalid) {
      showError(`${invalid.label} is required.`);
      (controls[invalid.name] || confirm).focus();
      return;
    }
    // RF-4: never submit without a real idempotency key. The affordances are gated on
    // planningRandomAvailable(), so this is a fail-closed backstop, not a normal path.
    if (!attempt.requestId) {
      showError("This browser cannot generate a secure request id, so the planning command was not sent.");
      return;
    }
    const body = { ...spec.buildBody(ctx, values), requestId: attempt.requestId };
    setSubmitting(true);
    retry.setAttribute("hidden", "true");
    statusLine.textContent = "Submitting…";

    let payload = null;
    let applied = false;
    let transportError = false;
    try {
      const res = await fetch(planEndpoint, {
        method: "POST",
        // A non-simple content type is required by the CSRF guard; the browser adds Origin +
        // Sec-Fetch-Site, which the server pins to the Serve hostname.
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      payload = await res.json().catch(() => null);
      applied = res.ok && !!payload && payload.outcome === "applied";
    } catch {
      transportError = true;
    }
    setSubmitting(false);

    if (applied) {
      // NON-OPTIMISTIC: announce, close, and RE-READ the board — never paint the mutation here.
      // RF-3: the confirmation goes to the PERSISTENT announcer (outside the mount) BEFORE the
      // dialog is removed, so a screen reader still hears it after the dialog's own status region
      // is gone; it stays until the re-read completes and the board banner speaks the fresh state.
      announcePlanOutcome("Applied — re-reading the board.");
      statusLine.textContent = "Applied — re-reading the board.";
      closePlanDialog();
      if (boardMount) void load(boardMount, boardEndpoint);
      return;
    }

    if (transportError) {
      // No server verdict. Retry REUSES the id so a lost-response redelivery replays rather than
      // double-applying.
      statusLine.textContent = "";
      showError("The planning command could not be sent — it may not have reached the host.");
      retry.textContent = "Retry";
      retry.removeAttribute("hidden");
      retry.onclick = () => void submit();
      retry.focus();
      return;
    }

    // A definitive server refusal: the host applied nothing. Surface its safe summary; the retry
    // re-reads the board so the operator resubmits with a fresh precondition + a fresh id.
    statusLine.textContent = "";
    const message = (payload && payload.error) || "The planning command was refused.";
    const summary = payload && planSummaryText(payload.summary);
    showError(message, summary);
    retry.textContent = "Re-read board";
    retry.removeAttribute("hidden");
    retry.onclick = () => {
      closePlanDialog();
      if (boardMount) void load(boardMount, boardEndpoint);
    };
    retry.focus();
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  document.body.appendChild(overlay);
  planOverlay = overlay;
  document.addEventListener("keydown", onPlanKeydown, true);
  // Move focus into the dialog: the first field, else the confirm button.
  const firstField = spec.fields.length ? controls[spec.fields[0].name] : null;
  (firstField || confirm).focus();
}

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

// FG-783: the mount + endpoints the planning flow needs to RE-READ the board after a recorded
// outcome (never optimistically painting the mutation) and to POST a bounded planning command.
// Set on boot; the planning dialog reads them rather than threading them through every call.
let boardMount = null;
let boardEndpoint = "/api/board";
let planEndpoint = "/api/plan";
// The last envelope rendered with board data — the source of loaded preconditions (set in render).
let currentEnvelope = null;

async function load(mount, endpoint) {
  boardMount = mount;
  boardEndpoint = endpoint;
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
  const boot = window.__REMOTE_BOARD__ || {};
  const endpoint = boot.endpoint || "/api/board";
  planEndpoint = boot.planEndpoint || "/api/plan";
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

/* RF-3: a visually-hidden but screen-reader-available live region for the applied-outcome
   confirmation. Standard clip pattern so the text is announced without occupying layout. */
.rb-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

/* FG-783: planning affordances. State (enabled/disabled, focus) is carried by more than colour. */
.rb-plan-note {
  color: #cfcfd6; background: #16161b; border: 1px solid #26262c; border-radius: 8px;
  padding: 8px 12px; margin: 0 0 14px; font-size: 0.85rem;
}
.rb-actions { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 100%; margin-top: 4px; }
.rb-plan-trigger {
  font: inherit; font-size: 0.78rem; color: #dbeafe; background: #1c2530;
  border: 1px solid #34506b; border-radius: 6px; padding: 3px 9px; cursor: pointer;
}
.rb-plan-trigger:hover { background: #223143; }
.rb-plan-trigger:focus-visible, .rb-plan-trigger:focus { outline: 2px solid #7dd3fc; outline-offset: 2px; }
.rb-plan-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(4, 4, 6, 0.66);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 6vh 16px; overflow-y: auto;
}
.rb-plan-dialog {
  width: 100%; max-width: 440px;
  background: #17171b; color: #e5e5e7;
  border: 1px solid #34343c; border-radius: 12px; padding: 18px 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.rb-plan-title { font-size: 1.05rem; margin: 0 0 8px; }
.rb-plan-desc { margin: 0 0 6px; color: #cfcfd6; }
.rb-plan-precond { margin: 0 0 14px; color: #9a9aa3; font-size: 0.82rem; }
.rb-plan-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.rb-plan-label { font-size: 0.85rem; color: #cfcfd6; }
.rb-plan-input {
  font: inherit; color: #e5e5e7; background: #0f0f12;
  border: 1px solid #3a3a42; border-radius: 8px; padding: 7px 10px; width: 100%;
}
.rb-plan-input:focus-visible, .rb-plan-input:focus { outline: 2px solid #7dd3fc; outline-offset: 1px; }
.rb-plan-status { margin: 4px 0; color: #9a9aa3; min-height: 1.2em; }
.rb-plan-error {
  margin: 6px 0 10px; padding: 10px 12px;
  border: 1px solid #6b3a3a; background: #241618; border-radius: 8px;
  display: flex; flex-direction: column; gap: 4px;
}
/* A class selector setting display would otherwise override the UA [hidden] rule, leaving the
   alert visible-but-empty until it is populated; this keeps [hidden] authoritative. */
.rb-plan-error[hidden] { display: none; }
.rb-plan-error-msg { color: #fca5a5; font-weight: 600; }
.rb-plan-summary { color: #cfcfd6; font-size: 0.85rem; }
.rb-plan-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.rb-plan-confirm {
  font: inherit; color: #041016; background: #7dd3fc;
  border: 1px solid #7dd3fc; border-radius: 8px; padding: 7px 16px; cursor: pointer; font-weight: 600;
}
.rb-plan-confirm:hover { background: #93dbfd; }
.rb-plan-cancel, .rb-plan-retry {
  font: inherit; color: #e5e5e7; background: #1c1c22;
  border: 1px solid #3a3a42; border-radius: 8px; padding: 7px 14px; cursor: pointer;
}
.rb-plan-cancel:hover, .rb-plan-retry:hover { background: #26262e; }
.rb-plan-confirm:focus-visible, .rb-plan-cancel:focus-visible, .rb-plan-retry:focus-visible,
.rb-plan-confirm:focus, .rb-plan-cancel:focus, .rb-plan-retry:focus {
  outline: 2px solid #7dd3fc; outline-offset: 2px;
}
.rb-plan-confirm:disabled, .rb-plan-cancel:disabled, .rb-plan-input:disabled { opacity: 0.55; cursor: not-allowed; }
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
