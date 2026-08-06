// FG-591 step 13 — THE KANBAN BOARD'S DECISIONS, as pure functions.
//
// Everything in this file is I/O-free and DOM-free so the board's real claims can be
// pinned by unit tests without a browser — the same shape backlog-state.js and
// view-routing.js already use, and the reason fg591-queue-board-state.test.ts can
// assert the projections rather than assert that a component "renders".
//
// THREE THINGS THIS MODULE EXISTS TO GET RIGHT, all of them AC text:
//
//  1. THE FIVE VIEWS ARE PROJECTIONS, NOT STATUSES. `/api/queue` already partitioned
//     the rows (queries.ts's classifyQueueBoardView) over orthogonal durable fields;
//     this module GROUPS by that partition and never re-derives it. If the board
//     recomputed "is it blocked" from a card's own fields it would be a sixth status
//     vocabulary living in the browser, which is precisely the non-goal.
//
//  2. A BLOCKER AND A SCHEDULING WAIT ARE DIFFERENT THINGS. `wait.kind === "blocker"`
//     is durable, per-ticket evidence and puts the row in the derived Blocked column.
//     `wait.kind === "scheduling"` is a per-evaluation observation that evaporates when
//     the active set changes; the row stays QUEUED with an explanation. They get
//     different labels, different tones and different prose here, so they cannot be
//     collapsed by a renderer that only had one badge to hand.
//
//  3. A REORDER SUBMITS RELATIVE INTENT PLUS THE LOADED VERSION (D11). planRelativeMove
//     emits `{ticketId, reference, placement}` — "put A before B" — never a replayed
//     full ordering built from state the page may have loaded minutes ago. A full
//     ordering is a lossy re-statement of a queue that may have moved; a relative move
//     plus `expectVersion` is a compare-and-set the CLI can refuse by name.

/** The board's columns, in the order an operator reads them. Five projections the
 *  ticket names, plus the sixth state the projection had no name for: an operator
 *  dequeue never releases a live claim (D4), so "not a queue member AND executing"
 *  is real and reachable. Rendering it as a gap makes a live container a phantom. */
export const BOARD_COLUMNS = [
  {
    view: "backlog",
    title: "Backlog",
    hint: "Every non-done ticket, ranked or not. Deferred ones are visible and execution-ineligible.",
    derived: false,
  },
  {
    view: "queued",
    title: "Queued",
    hint: "The subset the operator selected, in canonical rank order. Membership is planning intent — never execution authorization.",
    derived: false,
  },
  {
    view: "in_progress",
    title: "In progress",
    hint: "DERIVED from run evidence. Never manually toggled.",
    derived: true,
  },
  {
    view: "blocked",
    title: "Blocked",
    hint: "DERIVED from blocker evidence. A blocked item keeps its rank and returns to its position when the blocker clears.",
    derived: true,
  },
  {
    view: "done",
    title: "Done",
    hint: "DERIVED from the ticket's lifecycle status.",
    derived: true,
  },
  {
    view: "executing_not_queued",
    title: "Executing · not queued",
    hint: "Dequeued while its container is still running. A dequeue is a planning act and never releases a live claim, so this is a real state — not a gap.",
    derived: true,
  },
];

export const BOARD_VIEWS = BOARD_COLUMNS.map((column) => column.view);

/** How each wait kind is presented. The two entries that matter most are `blocker`
 *  and `scheduling`: distinct label, distinct tone, distinct prose about DURABILITY,
 *  because the operator action differs (clear the blocker vs. wait a cycle). */
export const WAIT_PRESENTATION = {
  blocker: {
    label: "Blocked",
    tone: "blocker",
    durability: "durable",
    note: "A genuine blocker recorded against this ticket. It keeps its rank and returns to its position when the blocker clears.",
  },
  scheduling: {
    label: "Waiting to overlap",
    tone: "scheduling",
    durability: "temporary",
    note: "A temporary scheduling incompatibility, not a blocker. It stays Queued at its rank and is reconsidered as soon as capacity or compatibility changes.",
  },
  capacity: {
    label: "At capacity",
    tone: "capacity",
    durability: "temporary",
    note: "The ceiling was full when it was scanned. See who holds the slots on the dispatcher panel.",
  },
  readiness: {
    label: "Not ready",
    tone: "readiness",
    durability: "durable",
    note: "Readiness is assessed against the ticket's current revision. The dispatcher never silently re-evaluates it — this is operator-actionable.",
  },
  unranked: {
    label: "Unranked",
    tone: "neutral",
    durability: "durable",
    note: "A queue member with no rank. The queue is ordered BY rank, so there is no position to dispatch from.",
  },
  deferred: {
    label: "Deferred",
    tone: "neutral",
    durability: "durable",
    note: "Execution-ineligible until reactivated. Rank, membership and history are all kept.",
  },
  claimed: {
    label: "Claimed",
    tone: "claimed",
    durability: "temporary",
    note: "A live reservation exists. The reservation and the execution are separate facts and are never joined.",
  },
  disarmed: {
    label: "Dispatch disarmed",
    tone: "disarmed",
    durability: "temporary",
    note: "Autonomous dispatch is off. Queue membership is planning intent, never execution authorization.",
  },
  not_evaluated: {
    label: "Not evaluated",
    tone: "unknown",
    durability: "unknown",
    note: "No durable evaluation covers this ticket. Reported as unknown rather than guessed at.",
  },
};

const UNKNOWN_WAIT = {
  label: "Unknown",
  tone: "unknown",
  durability: "unknown",
  note: "The dispatcher reported a wait this board has no presentation for. Shown verbatim rather than dropped.",
};

/**
 * The badge for one row's wait, or null when the row is not waiting on anything.
 * @param {{wait?: {kind: string, reason: string, source: string, observedAt: string|null}|null}} row
 */
export function waitBadge(row) {
  const wait = row?.wait;
  if (!wait || typeof wait.kind !== "string") return null;
  const presentation = Object.hasOwn(WAIT_PRESENTATION, wait.kind) ? WAIT_PRESENTATION[wait.kind] : UNKNOWN_WAIT;
  return {
    kind: wait.kind,
    label: presentation.label,
    tone: presentation.tone,
    durability: presentation.durability,
    note: presentation.note,
    reason: wait.reason ?? "",
    source: wait.source ?? null,
    observedAt: wait.observedAt ?? null,
    // A per-evaluation observation and a durable per-ticket fact answer different
    // questions ("is it still true?" vs "what do I fix?"), so the board says which.
    evidence: wait.source === "dispatcher_evaluation" ? "per-evaluation" : "durable",
  };
}

/** True only for a GENUINE blocker. Deliberately not `row.blocked || wait`. */
export function isBlockerWait(row) {
  return row?.wait?.kind === "blocker";
}

/** True only for a TEMPORARY scheduling incompatibility. Never renders as Blocked. */
export function isSchedulingWait(row) {
  return row?.wait?.kind === "scheduling";
}

/**
 * THE BOARD STATE. One pure read of the `/api/queue` payload into what the view
 * renders, with the four not-a-board situations kept distinguishable — an unreadable
 * store, a project with no ticket truth, a markdown-mode project that has no queue at
 * all, and a genuinely empty one. Collapsing them is the operator-blindness failure
 * this ticket exists to close, one surface up.
 *
 * @param {object|null|undefined} data  the /api/queue payload
 * @param {{projectSelected?: boolean}} [options]
 */
export function queueBoardState(data, options = {}) {
  const projectSelected = options.projectSelected !== false;

  if (!projectSelected) {
    return emptyState("no-project", "Select a project to see its work queue.", data);
  }
  if (!data) {
    return emptyState("loading", "loading queue…", data);
  }
  if (typeof data.error === "string" && data.error) {
    // A failed read has an UNKNOWN row count, not a zero one.
    return { ...emptyState("error", data.error, data), error: data.error };
  }
  if (data.queueAvailable === false) {
    const kind = data.projectKey === null ? "no-truth" : "unavailable";
    return emptyState(kind, data.unavailableReason ?? "this project has no operator queue.", data);
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const rowsById = new Map();
  for (const row of rows) {
    if (row && typeof row.ticketId === "string") rowsById.set(row.ticketId, row);
  }

  const views = data.views && typeof data.views === "object" ? data.views : {};
  const columns = BOARD_COLUMNS.map((column) => {
    const ids = Array.isArray(views[column.view]) ? views[column.view] : [];
    return {
      ...column,
      // The server's partition, resolved to rows IN ITS ORDER. An id the payload
      // partitioned but did not describe is dropped rather than rendered as a blank
      // card — but it is counted as missing so the discrepancy is visible.
      rows: ids.map((id) => rowsById.get(id)).filter(Boolean),
      missing: ids.filter((id) => !rowsById.has(id)),
      count: ids.length,
    };
  });

  const queuedIds = Array.isArray(views.queued) ? [...views.queued] : [];

  return {
    kind: rows.length === 0 ? "empty" : "board",
    message: rows.length === 0 ? "No tickets in this project's queue truth yet." : null,
    error: null,
    projectKey: data.projectKey ?? null,
    storageMode: data.storageMode ?? null,
    version: Number.isSafeInteger(data.version) ? data.version : 0,
    rows,
    rowsById,
    columns,
    queuedIds,
    dispatcher: dispatcherSummary(data.dispatcher, data.nowMs),
    capacity: capacitySummary(data.capacity),
    degraded: Array.isArray(data.degraded) ? data.degraded : [],
    nowMs: typeof data.nowMs === "number" ? data.nowMs : null,
  };
}

function emptyState(kind, message, data) {
  return {
    kind,
    message,
    error: null,
    projectKey: data?.projectKey ?? null,
    storageMode: data?.storageMode ?? null,
    version: Number.isSafeInteger(data?.version) ? data.version : 0,
    rows: [],
    rowsById: new Map(),
    columns: BOARD_COLUMNS.map((column) => ({ ...column, rows: [], missing: [], count: 0 })),
    queuedIds: [],
    dispatcher: dispatcherSummary(data?.dispatcher, data?.nowMs),
    capacity: capacitySummary(data?.capacity),
    degraded: Array.isArray(data?.degraded) ? data.degraded : [],
    nowMs: typeof data?.nowMs === "number" ? data.nowMs : null,
  };
}

// ─── the dispatcher panel (READ-ONLY here — arm and capacity are CLI-only) ────

/** The one affordance D2 requires: an explicit statement of WHERE the control lives,
 *  not a disabled button. A disabled button says "you may not"; this says "here is
 *  the command", which is the true and useful thing. */
export const DISPATCH_CONTROL_NOTICE =
  "Arming autonomous dispatch and changing max_active_runs are CLI-only: `forge queue dispatcher arm` / " +
  "`--max-active-runs <n>`. They authorize unattended repo-writing containers, which is a materially larger " +
  "capability than reordering a list, so this unauthenticated surface never exposes them.";

/** The six no-run answers that must stay DISTINGUISHABLE rather than collapsing into
 *  "nothing is running", plus the two honest unknowns and the running case. Every one
 *  is read from a durable record the server already resolved — this maps it to prose. */
export const DISPATCHER_STATE_PRESENTATION = {
  dispatching: { label: "Dispatching", tone: "ok" },
  disarmed: { label: "Disarmed", tone: "disarmed" },
  no_capacity: { label: "At capacity", tone: "capacity" },
  no_eligible_work: { label: "No eligible work", tone: "neutral" },
  incompatible_only: { label: "Waiting to overlap", tone: "scheduling" },
  lost: { label: "Claim lost — re-scanning", tone: "warn" },
  stale_dispatcher: { label: "Dispatcher stale", tone: "err" },
  no_dispatcher: { label: "No dispatcher", tone: "warn" },
  not_evaluated: { label: "Not evaluated", tone: "unknown" },
};

export function dispatcherSummary(panel, nowMs) {
  if (!panel || typeof panel !== "object") {
    return {
      present: false,
      armed: false,
      configured: false,
      state: "not_evaluated",
      label: DISPATCHER_STATE_PRESENTATION.not_evaluated.label,
      tone: "unknown",
      detail: "No dispatcher panel in this payload.",
      lease: null,
      leaseLive: false,
      leaseExpired: false,
      leaseStaleness: null,
      lastEvaluation: null,
      lastEvaluationAgeMs: null,
      nextWatchdogInMs: null,
      pendingWakes: 0,
      controlSurface: "cli-only",
      controlNotice: DISPATCH_CONTROL_NOTICE,
    };
  }

  const state = Object.hasOwn(DISPATCHER_STATE_PRESENTATION, panel.state) ? panel.state : "not_evaluated";
  const presentation = DISPATCHER_STATE_PRESENTATION[state];
  const now = typeof nowMs === "number" ? nowMs : null;
  const evaluatedAtMs = panel.lastEvaluation?.evaluatedAtMs;

  return {
    present: true,
    armed: panel.armed === true,
    configured: panel.configured === true,
    maxActiveRuns: panel.maxActiveRuns ?? null,
    capacityScope: panel.capacityScope ?? null,
    leaseTtlMs: panel.leaseTtlMs ?? null,
    heartbeatMs: panel.heartbeatMs ?? null,
    defaultWorkflow: panel.defaultWorkflow ?? null,
    updatedAt: panel.updatedAt ?? null,
    updatedBy: panel.updatedBy ?? null,
    state,
    label: presentation.label,
    tone: presentation.tone,
    detail: panel.stateDetail ?? "",
    lease: panel.lease ?? null,
    leaseLive: panel.leaseLive === true,
    leaseExpired: panel.leaseExpired === true,
    // "Nothing to do" and "the dispatcher died four hours ago" must never read the
    // same. Only the heartbeat column can tell them apart, so it is surfaced as its
    // own number rather than folded into the state label.
    leaseStaleness: typeof panel.msSinceHeartbeatMs === "number" ? panel.msSinceHeartbeatMs : null,
    lastEvaluation: panel.lastEvaluation ?? null,
    lastEvaluationAgeMs:
      now !== null && typeof evaluatedAtMs === "number" ? Math.max(0, now - evaluatedAtMs) : null,
    nextWatchdogInMs:
      now !== null && typeof panel.nextWatchdogAtMs === "number" ? panel.nextWatchdogAtMs - now : null,
    pendingWakes: typeof panel.pendingWakes === "number" ? panel.pendingWakes : 0,
    controlSurface: panel.controlSurface ?? "cli-only",
    controlNotice: DISPATCH_CONTROL_NOTICE,
  };
}

export function capacitySummary(capacity) {
  if (!capacity || typeof capacity !== "object") {
    return { present: false, scope: null, limit: null, queueOwnedActive: 0, holders: [], otherProjectHolders: 0, notCounted: null, lastRefusal: null };
  }
  const holders = Array.isArray(capacity.holders) ? capacity.holders : [];
  return {
    present: true,
    scope: capacity.scope ?? null,
    limit: typeof capacity.limit === "number" ? capacity.limit : null,
    queueOwnedActive: typeof capacity.queueOwnedActive === "number" ? capacity.queueOwnedActive : holders.length,
    holders,
    // Under a HOST-scoped ceiling a per-project board must be able to explain its own
    // refusal, so the holders in OTHER projects are named rather than counted away.
    otherProjectHolders:
      typeof capacity.otherProjectHolders === "number"
        ? capacity.otherProjectHolders
        : holders.filter((holder) => holder && holder.thisProject === false).length,
    notCounted: capacity.notCounted ?? null,
    lastRefusal: capacity.lastRefusal ?? null,
  };
}

// ─── the reorder: relative intent, plus the version the board loaded ──────────

/**
 * The MOVE, as relative intent. Given the queued ids AS THE BOARD LOADED THEM, moving
 * `ticketId` to `targetIndex` becomes "before" or "after" exactly one neighbour.
 *
 * Why not send the resulting array: a full ordering re-states positions the operator
 * never touched, so a concurrent enqueue elsewhere gets silently overwritten by a page
 * that simply had not seen it. A relative move plus `expectVersion` names one intent
 * and refuses when the queue moved underneath it.
 *
 * @returns {{ticketId: string, reference: string, placement: "before"|"after"}|null}
 *          null when the move is a no-op or cannot be expressed.
 */
export function planRelativeMove(queuedIds, ticketId, targetIndex) {
  if (!Array.isArray(queuedIds)) return null;
  const from = queuedIds.indexOf(ticketId);
  if (from < 0) return null;
  if (!Number.isInteger(targetIndex)) return null;
  const to = Math.max(0, Math.min(queuedIds.length - 1, targetIndex));
  if (to === from) return null;
  const reference = queuedIds[to];
  if (typeof reference !== "string" || reference === ticketId) return null;
  // Moving UP lands before the row currently at the target; moving DOWN lands after
  // it. Either way the reference is a ticket the operator can see on the board.
  return { ticketId, reference, placement: to < from ? "before" : "after" };
}

/** What a rendered board would look like after a planned move — used for the optimistic
 *  ordering only. It is never submitted; the submission is the relative intent. */
export function previewMove(queuedIds, move) {
  if (!Array.isArray(queuedIds) || !move) return Array.isArray(queuedIds) ? [...queuedIds] : [];
  const next = queuedIds.filter((id) => id !== move.ticketId);
  const at = next.indexOf(move.reference);
  if (at < 0) return [...queuedIds];
  next.splice(move.placement === "before" ? at : at + 1, 0, move.ticketId);
  return next;
}

/** The POST a planned move becomes. `expectVersion` is REQUIRED (D11) — the surface
 *  refuses to submit a move that never carried one rather than letting a stale board
 *  clobber a queue that moved. */
export function rankRequest(move, version) {
  if (!move) return null;
  if (!Number.isSafeInteger(version) || version < 0) return null;
  return {
    path: "/api/queue/rank",
    body: { ticketId: move.ticketId, reference: move.reference, placement: move.placement, expectVersion: version },
  };
}

export function enqueueRequest(ticketId, note) {
  const body = { ticketId };
  if (typeof note === "string" && note.trim() !== "") body.note = note.trim();
  return { path: "/api/queue/enqueue", body };
}

/** DEQUEUE IS A PLANNING ACT. It never stops work and never releases a live claim —
 *  a released reservation over a still-running container is the duplicate execution
 *  the claim primitive exists to prevent. Stopping work is `forge queue cancel`. */
export function dequeueRequest(ticketId) {
  return { path: "/api/queue/dequeue", body: { ticketId } };
}

export const DEQUEUE_NOTE =
  "Dequeue is a planning act: it removes the item from the queue and keeps its rank. It never stops a run and " +
  "never releases a live claim — stopping work is `forge queue cancel <ticket>`, which is CLI-only.";

// ─── what came back ──────────────────────────────────────────────────────────

/** A refusal the CLI issued because the queue moved underneath the board. Matched on
 *  the version vocabulary the `--expect-version` refusal uses. */
const STALE_VERSION = /expect-?version|version mismatch|moved underneath|stale (queue )?version/i;

/**
 * Classify one mutation response. A refusal is SURFACED — never swallowed into a
 * silent reload, which would erase both the operator's intent and the reason it was
 * refused. A stale-version refusal in particular asks for an explicit reload, because
 * the board the operator composed the move against no longer exists.
 *
 * @param {{status: number, payload: any}} response
 */
export function mutationOutcome(response) {
  const status = response?.status ?? 0;
  const payload = response?.payload ?? null;

  if (status === 200 && payload && payload.ok === true) {
    return { ok: true, kind: "applied", verb: payload.verb ?? null, message: null, needsReload: true, blocking: false };
  }

  const message =
    (payload && typeof payload.error === "string" && payload.error) ||
    (status === 0 ? "the dashboard could not reach the server." : `the request failed (HTTP ${status}).`);

  if (status === 409 && STALE_VERSION.test(message)) {
    return {
      ok: false,
      kind: "stale_version",
      verb: payload?.verb ?? null,
      message,
      // The board does NOT quietly re-fetch and re-apply: the operator's move was
      // composed against an order that has since changed, so re-applying it would be
      // guessing at an intent they never expressed against this queue.
      needsReload: true,
      blocking: true,
      hint: "The queue changed while this board was open. Reload the board and make the move again — it was not applied.",
    };
  }

  return {
    ok: false,
    kind: status === 409 ? "refused" : status === 403 || status === 415 ? "rejected" : "error",
    verb: payload?.verb ?? null,
    message,
    needsReload: false,
    blocking: true,
    hint: null,
  };
}
