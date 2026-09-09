// FG-783 (step 4): the CLOSED command registry for the Remote Board's bounded planning
// surface — the data structure that makes "denied by construction" a fact a source guard
// can prove, not a promise a comment makes.
//
// ─── WHY A CLOSED REGISTRY, AND WHY OVER DATA ────────────────────────────────
// FG-781 made "no remote mutation" structural by having NO non-GET branch in the remote
// listener. FG-783 adds a WRITE surface, so that structural claim has to migrate: the
// listener now answers exactly one POST route, and the ONLY actions reachable through it
// are the members of the map below. Mirroring queue-mutation.ts's QUEUE_MUTATION_FORGE_VERBS,
// the allow-set is an exported CONSTANT so "this surface can reach these actions and nothing
// else" is testable over data (registry.source-guard.test.ts) rather than by reading control
// flow. A new remote planning capability means adding a row here; there is deliberately no
// dynamic dispatch, no string-built verb, and NO path to an arbitrary CLI verb.
//
// ─── WHAT IS AND IS NOT HERE ─────────────────────────────────────────────────
// The four planning CATEGORIES the ticket authorises — change the canonical stack rank,
// enqueue/dequeue a ticket through the readiness gates, reorder the explicit operator queue,
// and append a bounded operator planning annotation — surface as the FIVE concrete wire
// actions below (enqueue and dequeue are distinct store operations, so they are distinct
// rows). Every larger capability the ticket names as out of scope — completion, closure,
// gate/override decisions, run/campaign dispatch, merge/publish/review disposition, terminal
// or process control, cleanup, credential/RACI/model-policy/routing changes — is absent by
// construction: it is not a key here, no value names it, and there is no CLI-dispatch member
// through which one could be smuggled.
//
// This module is PURE and self-contained. It imports neither the store authority (src/store,
// step 3) nor the capability constant (identity.ts, step 1); those are wired at the server
// (step 5). Its only job is to name the closed vocabulary and describe, as inert data, which
// in-process store authority each action delegates to.

/** The precondition model an action's mutation is gated on. Never a rank VALUE (renumbered on
 *  every move) — only a compare-and-set version, an order fingerprint, or a ticket revision. */
export type PlanningPrecondition =
  | "queue-version" // queue expectedVersion CAS (rank / reorder)
  | "readiness" // enqueue re-checks readiness gates at the current ticket revision
  | "none" // dequeue retains rank; there is no version to clobber
  | "ticket-revision"; // annotate binds to TicketRow.revision

/** One row of the closed registry: the in-process store authority the action delegates to
 *  (a NAME, as data — this module never imports the function) and the precondition it is
 *  gated on. `authority` mirrors the descriptor style of QUEUE_MUTATION_FORGE_VERBS: a stable
 *  string a source guard can assert over, not a live reference. */
export interface PlanningActionSpec {
  /** The src/store authority (step 3) the server invokes for this action. Data, not a binding. */
  readonly authority: string;
  /** The per-action precondition the store authority evaluates before mutating. */
  readonly precondition: PlanningPrecondition;
}

/**
 * THE CLOSED COMMAND REGISTRY. Exactly the planning actions the remote surface can reach.
 * Adding a member is the ONLY way to widen the surface, which is what makes the source guard
 * meaningful. `as const` freezes the key set at the type level so `RemotePlanningAction` cannot
 * name anything outside it.
 */
export const REMOTE_PLANNING_ACTIONS = {
  "change-rank": { authority: "queue.rankBefore/rankAfter", precondition: "queue-version" },
  enqueue: { authority: "queue.enqueueTicket", precondition: "readiness" },
  dequeue: { authority: "queue.dequeueTicket", precondition: "none" },
  "reorder-queue": { authority: "queue.setQueueOrder/moveQueuePosition", precondition: "queue-version" },
  "append-annotation": { authority: "appendPlanningAnnotation", precondition: "ticket-revision" },
} as const satisfies Record<string, PlanningActionSpec>;

/** A member of the closed planning vocabulary. Nothing outside the registry keys can be one. */
export type RemotePlanningAction = keyof typeof REMOTE_PLANNING_ACTIONS;

const REMOTE_PLANNING_ACTION_SET: ReadonlySet<string> = new Set(Object.keys(REMOTE_PLANNING_ACTIONS));

/** Runtime guard: is `value` a member of the closed planning vocabulary? Guards the seam where
 *  a request body (untyped at the boundary) names an action — an unknown or excluded verb must
 *  be refused, never dispatched. */
export function isRemotePlanningAction(value: unknown): value is RemotePlanningAction {
  return typeof value === "string" && REMOTE_PLANNING_ACTION_SET.has(value);
}

/** Look up the spec for an action, or `undefined`. Used by the server to find which store
 *  authority to delegate to; there is no other, dynamic, dispatch path. */
export function planningActionSpec(action: RemotePlanningAction): PlanningActionSpec {
  return REMOTE_PLANNING_ACTIONS[action];
}
