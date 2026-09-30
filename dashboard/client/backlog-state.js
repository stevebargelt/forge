// FG-608: what the backlog board is actually looking at.
//
// /api/backlog has emitted `ticketsProjectKey`, `ticketsStorageMode` and
// `ticketsError` since the DB cutover, and the board read NONE of them. Three
// distinct situations therefore rendered as one line — "No backlog tickets found
// for this project":
//
//   * the project has no ticket truth at all (never imported: projectKey === null),
//   * the ticket read FAILED (ticketsError set),
//   * the project genuinely has zero tickets.
//
// The first two are things an operator must act on; the third is a fact. Collapsing
// them means a broken store looks like an empty backlog, which is the failure mode
// FG-607 spent four test files on. Kept as a pure function so it is unit-testable
// without a DOM — same shape as verification-label.js / view-routing.js.

import { hashFor, ROUTES } from "./view-routing.js";

/**
 * @param {{tickets?: unknown[], ticketsProjectKey?: string|null, ticketsStorageMode?: string|null, ticketsError?: string}} data
 */
export function backlogBoardState(data) {
  const tickets = data?.tickets || [];
  const projectKey = data?.ticketsProjectKey ?? null;
  const storageMode = data?.ticketsStorageMode ?? null;
  const error = data?.ticketsError || null;

  return {
    total: tickets.length,
    projectKey,
    storageMode,
    error,
    // An error is never "empty": the count is unknown, not zero.
    kind: error ? "error" : projectKey === null ? "no-truth" : tickets.length === 0 ? "empty" : "tickets",
    // Markdown mode means the DB rows are an import SHADOW, not authority — the
    // checkout's backlog/*.md is. Rendering them unlabelled invites edits against
    // a store nothing reads back.
    shadow: storageMode === "markdown",
  };
}

export const NO_TRUTH_MESSAGE =
  "No ticket truth for this project yet — its backlog has never been imported into the forge store. " +
  "Run `forge backlog import` in the project to populate it.";

export const SHADOW_BADGE_TITLE =
  "This project is in markdown mode: backlog/*.md in the checkout is authoritative and these rows are " +
  "an import shadow of it. They are not ticket truth.";

// FG-832: the board's type/status filter, carried in `#backlog?type=<t>&status=<s>`.
// A missing (or unknown — the route table drops it) param is the default: every type,
// active status only. "all" is a real status choice; the type default already is all.
export const BACKLOG_FILTER_DEFAULT = Object.freeze({ type: "all", status: "active" });

export function backlogFilterState(params) {
  const type = ROUTES.backlog.paramValues.type.includes(params?.type) ? params.type : BACKLOG_FILTER_DEFAULT.type;
  const status = params?.status === "active" || ROUTES.backlog.paramValues.status.includes(params?.status)
    ? params.status
    : BACKLOG_FILTER_DEFAULT.status;
  return { type, status };
}

/** The hash a filter button writes, keeping the scope; defaults are omitted. */
export function backlogFilterHash(scope, state) {
  return hashFor({ view: "backlog", scope, params: { type: state.type, status: state.status } });
}

export function filterBacklogTickets(tickets, state) {
  return (tickets || []).filter((tk) =>
    (state.type === "all" || tk.type === state.type) && (state.status === "all" || tk.status === state.status));
}

export function backlogCountLabel(shown, total) {
  return `${shown} of ${total} ${total === 1 ? "ticket" : "tickets"}`;
}
