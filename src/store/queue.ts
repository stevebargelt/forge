// FG-609 (FG-496 Slice D): the durable OPERATOR QUEUE primitives.
//
// ─── THE MODEL ───────────────────────────────────────────────────────────────
// Three ORTHOGONAL facts about a ticket, deliberately not collapsed into one:
//
//   tickets.priority_rank   WHERE it sits in the operator's stack rank. ONE
//                           canonical rank — there is no separate "backlog
//                           priority" and "queue position" that can drift.
//                           Nullable: unranked is a valid backlog item.
//   queue_membership        WHETHER the operator selected it for execution.
//   lifecycle status        active / done / deferred. Untouched by this module.
//
// THE EXECUTABLE QUEUE is the intersection: queued AND active AND ranked, ordered
// by rank ASC then ticket_id ASC. `blocked` and `in_progress` are COMPUTED on
// every read from blocker_evidence and dispatch evidence respectively; neither is
// ever stored, because a stored one would be a second mutable status vocabulary
// beside the lifecycle status.
//
// ─── RANK REPRESENTATION (settled, not discovered) ───────────────────────────
// DENSE CONTIGUOUS INTEGERS per project, 1..N over the project's RANKED tickets,
// with a FULL RENUMBER inside one transaction on every rank-changing verb. Not
// sparse gaps, not fractional keys, not lexicographic ranks — those all buy cheap
// single-row moves at the cost of a rebalance path that is itself a concurrency
// hazard, and a project's ranked set is a few hundred rows. Consequences, stated:
//   * reorder cost is O(N) UPDATEs in one transaction. Fine at this size.
//   * a rank VALUE is NOT stable across moves. Nothing durable may key off a rank
//     value — only off the ordering.
//   * TIES: no UNIQUE constraint exists on the column (SQLite has no deferrable
//     unique index, so an in-transaction renumber would transit duplicate states
//     and abort; the index would also pin the column undroppable). If two tickets
//     ever hold the same rank — an aged row, a concurrent older binary — the read
//     order is still TOTAL and deterministic because every ordering read is
//     `ORDER BY priority_rank ASC, ticket_id ASC`, and the next rank-changing verb
//     renumbers the tie away.
//
// The RANKED DOMAIN is every ranked ticket of the project REGARDLESS of lifecycle
// status. It has to be status-independent: closing or deferring a ticket goes
// through the seam writers, which are forbidden from naming priority_rank
// (invariant: operator queue state survives re-import), so a status-scoped domain
// would silently lose density on every close. A done or deferred ticket therefore
// KEEPS its rank — which is exactly what makes reactivating it return to the same
// position — while dropping out of the executable queue, whose projection filters
// on status.
//
// ─── ATOMICITY ───────────────────────────────────────────────────────────────
// Every mutating verb runs in ONE writeTransaction (src/store/db.ts: BEGIN
// IMMEDIATE, whole-database write lock, the single host write path). No new
// transaction mode and no new locking primitive. The renumber AND its queue event
// are ONE commit, so a partially-renumbered queue is not a reachable state and a
// rank change without its event is not either.
//
// FG-591 adds ONE thing on top, and only for the reorder verbs: an OPTIONAL
// expectedVersion compare-and-set (see "the reorder concurrency guard" below). It
// is not a second concurrency scheme — it introduces no lock and no retry, and the
// comparison is read under the same BEGIN IMMEDIATE as the write it guards. It
// exists because the write lock makes a reorder ATOMIC, which was never the same
// claim as making it CORRECT: a whole-queue permutation computed from a view the
// operator read a minute ago commits perfectly and still overwrites whatever moved
// in between.
//
// ─── READINESS ───────────────────────────────────────────────────────────────
// evaluateReadiness (src/readiness/readiness.ts, FG-382) is reused VERBATIM — no
// new readiness vocabulary. It is NEVER invoked on ticket write: it is pure and
// I/O-free over an already-hydrated ticket, so freshness never needs the write
// path, and binding it there would write assessment rows machine-wide for tickets
// no operator will ever queue. It runs on exactly two paths: an ENQUEUE ATTEMPT
// (persisting the outcome whether the enqueue succeeds or is refused) and an
// explicit operator RECHECK.
//
// The stored assessment is a CACHE PLUS AN AUDIT RECORD and is NEVER the authority
// for an enqueue: enqueue re-evaluates the CURRENT revision and stores that, so a
// refusal reason can never be quoted from stale content, and a stale assessment is
// never a dead end — enqueue IS the recheck.
//
// ─── PUBLISH BARRIER ─────────────────────────────────────────────────────────
// Queue writes NEVER call markBacklogDirty. writeTransaction's publish barrier
// fans a snapshot republish out to EVERY live container on this host for a dirty
// project; queue state has no container consumer in this slice, so a rank nudge
// that republished snapshots machine-wide would be pure blast radius.

import { getDb, writeTransaction } from "./db.js";
// A CYCLE, and a deliberate one: dispatcher-evidence.ts imports QueueRefusal from
// here. Both directions are used only inside function bodies — nothing here runs at
// module-eval time — so the partially-evaluated namespace is never read.
import { recordWake } from "./dispatcher-evidence.js";
import { getTicket, ticketContentHash, type TicketRow } from "./tickets.js";
import { isStatusBearingEvidenceSource } from "./blocked-source.js";
import { evaluateReadiness, type ReadinessResult } from "../readiness/readiness.js";
// TYPE-ONLY, so this stays erased at runtime and no module cycle is created:
// structured.ts imports the store, and the store must not import structured.ts.
import type { StructuredTicket, TicketStatus, TicketType } from "../backlog/structured.js";

// Task statuses that mean the dispatch is FINISHED. Everything else — pending,
// running, awaiting_gate, awaiting_red, blocked_by_red, awaiting_recovery — is
// work still in flight, which is what makes a ticket read as in_progress.
const TERMINAL_TASK_STATUSES = ["complete", "failed"] as const;

export type QueueEventType =
  | "rank"
  | "unrank"
  | "enqueue"
  | "dequeue"
  | "reorder"
  | "readiness"
  // FG-610 (Slice E): the claim/lease/recovery history lands in THIS history, not a
  // second one. A claim and its release are operator-queue facts about the same
  // subject as every type above, so one append-only table stays the whole story.
  | "claim"
  | "release";

export type QueueEvent = {
  id: number;
  projectKey: string;
  ticketId: string;
  eventType: QueueEventType;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type StoredReadiness = {
  projectKey: string;
  ticketId: string;
  bodyHash: string;
  outcome: ReadinessResult["outcome"];
  gaps: string[];
  refinementProposal: string | null;
  revision: number | null;
  evaluatedAt: string;
};

/** A stored assessment plus the ONE thing a read surface must never omit: whether
 *  it still describes the ticket's current revision. */
export type ReadinessView = StoredReadiness & { stale: boolean };

export type QueueEntry = {
  ticketId: string;
  title: string;
  type: string;
  /** The lifecycle status, verbatim. NOT the derived projection. */
  status: string;
  rank: number | null;
  queued: boolean;
  /** DERIVED by isQueueBlocked over ALL evidence kinds — legacy status-bearing
   *  evidence OR an enriched row whose queue_projection blocks. Never stored, and
   *  NOT the same predicate as the ticket's legacy blocked status. */
  blocked: boolean;
  /** DERIVED from dispatch evidence + non-terminal task status. Never stored. */
  inProgress: boolean;
  /** null when the ticket has never been assessed. */
  readiness: ReadinessView | null;
};

/** Named refusal. Every queue verb refuses BY NAME with a concrete reason rather
 *  than returning a bare boolean or silently succeeding. */
export class QueueRefusal extends Error {
  constructor(
    message: string,
    readonly verb: string,
    readonly ticketId: string | null,
  ) {
    super(message);
    this.name = "QueueRefusal";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── test seam: a failure injected mid-renumber ──────────────────────────────
// Load-bearing for the atomicity proof. "Reorder produces the right final order"
// is not evidence of atomicity; a failure landing AFTER some rows are rewritten
// and BEFORE the commit is. Never armed in production.
let _renumberFailureHook: ((rewritten: number) => void) | null = null;

export function setRenumberFailureHookForTest(fn: ((rewritten: number) => void) | null): void {
  _renumberFailureHook = fn;
}

// ─── rank primitives ─────────────────────────────────────────────────────────

/** The project's ranked tickets in canonical read order. TOTAL: rank ASC then
 *  ticket_id ASC, so equal ranks are deterministic rather than arbitrary. */
export function rankedOrder(projectKey: string): { ticketId: string; rank: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT ticket_id, priority_rank FROM tickets
        WHERE project_key = ? AND priority_rank IS NOT NULL
        ORDER BY priority_rank ASC, ticket_id ASC`,
    )
    .all(projectKey) as { ticket_id: string; priority_rank: number }[];
  return rows.map((r) => ({ ticketId: r.ticket_id, rank: r.priority_rank }));
}

/** Rewrite the WHOLE ranked projection to 1..N in the given order. Caller holds
 *  the write transaction; every UPDATE and the caller's queue event commit
 *  together or not at all. */
function renumber(projectKey: string, orderedIds: string[]): void {
  const stmt = getDb().prepare(
    `UPDATE tickets SET priority_rank = ? WHERE project_key = ? AND ticket_id = ?`,
  );
  for (let i = 0; i < orderedIds.length; i++) {
    stmt.run(i + 1, projectKey, orderedIds[i]!);
    _renumberFailureHook?.(i + 1);
  }
}

/** Append one row to THE queue history. Exported since FG-610 so the claim
 *  primitives write claim/release history into this same table rather than
 *  opening a second one. The CALLER holds the write transaction — the event and
 *  the state change it records must commit together or not at all.
 *
 *  FG-591 AC15: an ORDER-AFFECTING event also records a durable `queue_changed`
 *  wake, HERE, so the signal commits in the same transaction as the change that
 *  caused it. Enqueue is the common case and the one that matters most — an
 *  otherwise-idle dispatcher must re-evaluate on the change rather than at its next
 *  watchdog tick, and polling is the fallback, never the correctness mechanism.
 *  Claim and release are deliberately NOT in that set: the dispatcher writes them
 *  itself and wakes on `run_terminal`, so waking on them would be a loop. */
export function appendQueueEvent(
  projectKey: string,
  ticketId: string,
  eventType: QueueEventType,
  payload: Record<string, unknown> | null,
  at: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO queue_events (project_key, ticket_id, event_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(projectKey, ticketId, eventType, payload ? JSON.stringify(payload) : null, at);
  if (QUEUE_ORDER_EVENT_TYPES.includes(eventType)) {
    recordWake({
      projectKey,
      kind: "queue_changed",
      wakeKey: `ticket:${ticketId}`,
      detail: `${eventType} ${ticketId}`,
    });
  }
}

export function queueEvents(projectKey: string, ticketId?: string): QueueEvent[] {
  const db = getDb();
  const rows = (
    ticketId === undefined
      ? db
          .prepare(
            `SELECT id, project_key, ticket_id, event_type, payload, created_at
               FROM queue_events WHERE project_key = ? ORDER BY id ASC`,
          )
          .all(projectKey)
      : db
          .prepare(
            `SELECT id, project_key, ticket_id, event_type, payload, created_at
               FROM queue_events WHERE project_key = ? AND ticket_id = ? ORDER BY id ASC`,
          )
          .all(projectKey, ticketId)
  ) as {
    id: number;
    project_key: string;
    ticket_id: string;
    event_type: string;
    payload: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    projectKey: r.project_key,
    ticketId: r.ticket_id,
    eventType: r.event_type as QueueEventType,
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  }));
}

function requireTicket(projectKey: string, ticketId: string, verb: string): TicketRow {
  const row = getTicket(projectKey, ticketId);
  if (!row) {
    throw new QueueRefusal(
      `forge: backlog ${verb} refuses — ticket ${ticketId} does not exist in project_key '${projectKey}'.`,
      verb,
      ticketId,
    );
  }
  return row;
}

function isQueued(projectKey: string, ticketId: string): boolean {
  return (
    getDb()
      .prepare(`SELECT 1 FROM queue_membership WHERE project_key = ? AND ticket_id = ?`)
      .get(projectKey, ticketId) !== undefined
  );
}

/** Place a ticket at `position` (1-based) in the ranked order, renumbering the
 *  whole projection. `position` beyond the end appends; omitted appends. */
export function rankTicket(
  projectKey: string,
  ticketId: string,
  position?: number,
  at: string = nowIso(),
): { order: string[]; position: number } {
  return writeTransaction(() => {
    requireTicket(projectKey, ticketId, "rank");
    const current = rankedOrder(projectKey).map((r) => r.ticketId);
    const previousIndex = current.indexOf(ticketId);
    const without = current.filter((id) => id !== ticketId);
    const target =
      position === undefined
        ? without.length
        : Math.max(0, Math.min(without.length, Math.trunc(position) - 1));
    const next = [...without.slice(0, target), ticketId, ...without.slice(target)];
    renumber(projectKey, next);
    appendQueueEvent(
      projectKey,
      ticketId,
      "rank",
      {
        position: target + 1,
        previousPosition: previousIndex === -1 ? null : previousIndex + 1,
        rankedCount: next.length,
      },
      at,
    );
    return { order: next, position: target + 1 };
  });
}

/** Clear a ticket's rank and close the gap it leaves.
 *
 *  REFUSES on a queued ticket by name. The executable queue is ordered BY rank, so
 *  an unranked-but-queued ticket would be a queue member with no position — it
 *  would silently vanish from the executable queue while still reading as queued.
 *  Dequeue first; that is an explicit operator decision, not an inferred one. */
export function unrankTicket(
  projectKey: string,
  ticketId: string,
  at: string = nowIso(),
): { order: string[] } {
  return writeTransaction(() => {
    requireTicket(projectKey, ticketId, "rank");
    if (isQueued(projectKey, ticketId)) {
      throw new QueueRefusal(
        `forge: backlog rank --clear refuses — ${ticketId} is in the operator queue, and the queue is ` +
          `ordered by rank, so clearing its rank would leave it queued with no position. Run ` +
          `\`forge backlog dequeue ${ticketId}\` first if you mean to take it out of the queue.`,
        "rank",
        ticketId,
      );
    }
    const current = rankedOrder(projectKey).map((r) => r.ticketId);
    if (!current.includes(ticketId)) {
      throw new QueueRefusal(
        `forge: backlog rank --clear refuses — ${ticketId} has no rank to clear.`,
        "rank",
        ticketId,
      );
    }
    getDb()
      .prepare(`UPDATE tickets SET priority_rank = NULL WHERE project_key = ? AND ticket_id = ?`)
      .run(projectKey, ticketId);
    const next = current.filter((id) => id !== ticketId);
    renumber(projectKey, next);
    appendQueueEvent(projectKey, ticketId, "unrank", { rankedCount: next.length }, at);
    return { order: next };
  });
}

// ─── readiness ───────────────────────────────────────────────────────────────

/** The hash the assessment binds to. It is the EXISTING ticketContentHash
 *  (src/store/tickets.ts) — the row's own body_hash when the writers stamped one,
 *  recomputed identically otherwise. No second canonical definition of "ticket
 *  content" is introduced: that drift is what FG-608 spent a reopen eliminating.
 *
 *  What it covers, exactly: sha256 hex over JSON.stringify of the ARRAY
 *  [type, status, title, body, created, closed, closedCommit, epic], absent
 *  optionals normalized to null, in that order, with no whitespace or unicode
 *  normalization. So ANY edit to the body, title, type, lifecycle status, created/
 *  closed dates or epic invalidates a stored assessment; frontmatter overflow keys
 *  and imported_at/imported_from do NOT. That field set is a strict SUPERSET of
 *  what evaluateReadiness reads (status, type, title, body), so an assessment can
 *  never be stale-but-considered-fresh. The accepted cost is spurious
 *  invalidation; the accepted blind spot is frontmatter. */
export function ticketBodyHash(row: TicketRow): string {
  return row.bodyHash ?? ticketContentHash(row);
}

/** Reconstruct the StructuredTicket evaluateReadiness expects. `blocked` is
 *  derived here from STATUS-BEARING evidence only, through the one canonical
 *  predicate — the same reconstruction the host seam performs. */
export function hydrateForReadiness(row: TicketRow): StructuredTicket {
  const blocked = isBlocked(row.projectKey, row.ticketId);
  const status: TicketStatus = blocked && row.status === "active" ? "blocked" : (row.status as TicketStatus);
  return {
    id: row.ticketId,
    type: row.type as TicketType,
    status,
    title: row.title,
    ...(row.created ? { created: row.created } : {}),
    ...(row.closed ? { closed: row.closed } : {}),
    ...(row.closedCommit ? { closedCommit: row.closedCommit } : {}),
    ...(row.epic ? { epic: row.epic } : {}),
    body: row.body,
  };
}

function storedReadiness(projectKey: string, ticketId: string): StoredReadiness | undefined {
  const row = getDb()
    .prepare(
      `SELECT project_key, ticket_id, body_hash, outcome, gaps_json, refinement_proposal, revision, evaluated_at
         FROM readiness_assessments WHERE project_key = ? AND ticket_id = ?`,
    )
    .get(projectKey, ticketId) as
    | {
        project_key: string;
        ticket_id: string;
        body_hash: string;
        outcome: string;
        gaps_json: string;
        refinement_proposal: string | null;
        revision: number | null;
        evaluated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    projectKey: row.project_key,
    ticketId: row.ticket_id,
    bodyHash: row.body_hash,
    outcome: row.outcome as ReadinessResult["outcome"],
    gaps: JSON.parse(row.gaps_json) as string[],
    refinementProposal: row.refinement_proposal,
    revision: row.revision,
    evaluatedAt: row.evaluated_at,
  };
}

/** The stored assessment plus its freshness against the ticket's CURRENT content
 *  hash. A body-hash mismatch is what STALE means; there is no other definition. */
export function readinessView(projectKey: string, ticketId: string): ReadinessView | null {
  const stored = storedReadiness(projectKey, ticketId);
  if (!stored) return null;
  const row = getTicket(projectKey, ticketId);
  const currentHash = row ? ticketBodyHash(row) : null;
  return { ...stored, stale: currentHash === null || currentHash !== stored.bodyHash };
}

/** Persist an assessment and append a queue event WHEN THE OUTCOME OR THE BOUND
 *  REVISION MOVED — that is a readiness TRANSITION. Re-running the same evaluation
 *  against unchanged content appends nothing, so the history stays a record of
 *  changes rather than of polling. Caller holds the write transaction. */
function persistReadiness(
  row: TicketRow,
  result: ReadinessResult,
  at: string,
): { view: ReadinessView; transitioned: boolean } {
  const projectKey = row.projectKey;
  const ticketId = row.ticketId;
  const hash = ticketBodyHash(row);
  const previous = storedReadiness(projectKey, ticketId);
  const transitioned = previous === undefined || previous.outcome !== result.outcome || previous.bodyHash !== hash;

  getDb()
    .prepare(
      `INSERT INTO readiness_assessments
         (project_key, ticket_id, body_hash, outcome, gaps_json, refinement_proposal, revision, evaluated_at)
       VALUES (@projectKey, @ticketId, @bodyHash, @outcome, @gaps, @proposal, @revision, @at)
       ON CONFLICT(project_key, ticket_id) DO UPDATE SET
         body_hash = excluded.body_hash,
         outcome = excluded.outcome,
         gaps_json = excluded.gaps_json,
         refinement_proposal = excluded.refinement_proposal,
         revision = excluded.revision,
         evaluated_at = excluded.evaluated_at`,
    )
    .run({
      projectKey,
      ticketId,
      bodyHash: hash,
      outcome: result.outcome,
      gaps: JSON.stringify(result.gaps),
      proposal: result.refinementProposal,
      revision: row.revision ?? null,
      at,
    });

  if (transitioned) {
    appendQueueEvent(
      projectKey,
      ticketId,
      "readiness",
      {
        outcome: result.outcome,
        previousOutcome: previous?.outcome ?? null,
        bodyHash: hash,
        previousBodyHash: previous?.bodyHash ?? null,
        gaps: result.gaps,
      },
      at,
    );
  }

  return {
    view: {
      projectKey,
      ticketId,
      bodyHash: hash,
      outcome: result.outcome,
      gaps: result.gaps,
      refinementProposal: result.refinementProposal,
      revision: row.revision ?? null,
      evaluatedAt: at,
      stale: false,
    },
    transitioned,
  };
}

/** The explicit operator RECHECK: evaluate the ticket's CURRENT revision and
 *  persist the outcome. Never called from a ticket write path. */
export function recheckReadiness(
  projectKey: string,
  ticketId: string,
  at: string = nowIso(),
): ReadinessView {
  return writeTransaction(() => {
    const row = requireTicket(projectKey, ticketId, "enqueue");
    const result = evaluateReadiness(hydrateForReadiness(row));
    return persistReadiness(row, result, at).view;
  });
}

/** The outcomes that permit an enqueue. `exploratory` is deliberately included —
 *  a spike is queueable without acceptance criteria. */
const QUEUEABLE_OUTCOMES = new Set<ReadinessResult["outcome"]>(["ready", "exploratory"]);

/** The CONCRETE refusal reason, derived from the CURRENT-revision evaluation and
 *  never from a stored row. It names what is missing; a bare boolean is not an
 *  acceptable answer to "why can I not queue this". */
function refusalReason(ticketId: string, result: ReadinessResult): string {
  const gaps = result.gaps.length > 0 ? result.gaps.join("; ") : "no specific gap was reported";
  const fix = result.refinementProposal ? ` ${result.refinementProposal}` : "";
  return (
    `forge: backlog enqueue refuses — ${ticketId} evaluates '${result.outcome}' at its CURRENT ` +
    `revision, not ready: ${gaps}.${fix} The assessment was recorded, so re-running enqueue after ` +
    `editing the ticket rechecks it — there is nothing else to clear.`
  );
}

export type EnqueueResult =
  | { ok: true; ticketId: string; position: number; queue: string[]; readiness: ReadinessView }
  | { ok: false; ticketId: string; reason: string; readiness: ReadinessView };

/** Add a ticket to the operator queue.
 *
 *  REFUSED unless the ticket's CURRENT revision evaluates ready (or exploratory).
 *  The evaluation happens here, on this call, against the row as it is right now —
 *  the stored assessment is never consulted for the decision. The outcome is
 *  persisted EITHER WAY, so a refusal is auditable and the operator's next read
 *  surface shows why.
 *
 *  Returns a discriminated result rather than throwing on refusal: the refusal
 *  path must COMMIT (the assessment and its readiness event are the audit record),
 *  and throwing out of writeTransaction would roll exactly that back. */
export function enqueueTicket(
  projectKey: string,
  ticketId: string,
  opts: { by?: string; note?: string } = {},
  at: string = nowIso(),
): EnqueueResult {
  return writeTransaction(() => {
    const row = requireTicket(projectKey, ticketId, "enqueue");
    if (row.status !== "active") {
      throw new QueueRefusal(
        `forge: backlog enqueue refuses — ${ticketId} is '${row.status}', and only an active ticket ` +
          `can enter the executable queue.`,
        "enqueue",
        ticketId,
      );
    }
    const result = evaluateReadiness(hydrateForReadiness(row));
    const { view } = persistReadiness(row, result, at);

    if (!QUEUEABLE_OUTCOMES.has(result.outcome)) {
      return { ok: false as const, ticketId, reason: refusalReason(ticketId, result), readiness: view };
    }

    getDb()
      .prepare(
        `INSERT INTO queue_membership (project_key, ticket_id, enqueued_at, enqueued_by, note)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_key, ticket_id) DO UPDATE SET
           enqueued_at = excluded.enqueued_at,
           enqueued_by = excluded.enqueued_by,
           note = excluded.note`,
      )
      .run(projectKey, ticketId, at, opts.by ?? null, opts.note ?? null);

    // An unranked ticket joins at the BACK of the stack rank. A ticket that
    // already has a rank keeps it — enqueueing must never silently reprioritize.
    let order = rankedOrder(projectKey).map((r) => r.ticketId);
    if (!order.includes(ticketId)) {
      order = [...order, ticketId];
      renumber(projectKey, order);
    }
    const position = order.indexOf(ticketId) + 1;
    appendQueueEvent(projectKey, ticketId, "enqueue", { position, rankedCount: order.length }, at);
    return {
      ok: true as const,
      ticketId,
      position,
      queue: queuedOrder(projectKey),
      readiness: view,
    };
  });
}

/** Remove a ticket from the operator queue. The RANK IS RETAINED — dequeue is not
 *  a deprioritization, and re-enqueueing returns the ticket to the same place. */
export function dequeueTicket(
  projectKey: string,
  ticketId: string,
  at: string = nowIso(),
): { queue: string[] } {
  return writeTransaction(() => {
    requireTicket(projectKey, ticketId, "dequeue");
    const res = getDb()
      .prepare(`DELETE FROM queue_membership WHERE project_key = ? AND ticket_id = ?`)
      .run(projectKey, ticketId);
    if (res.changes === 0) {
      throw new QueueRefusal(
        `forge: backlog dequeue refuses — ${ticketId} is not in the operator queue.`,
        "dequeue",
        ticketId,
      );
    }
    appendQueueEvent(projectKey, ticketId, "dequeue", { rankRetained: true }, at);
    return { queue: queuedOrder(projectKey) };
  });
}

// ─── reorder ─────────────────────────────────────────────────────────────────

/** Every queued ticket in rank order, INCLUDING ones whose lifecycle took them out
 *  of the executable queue. This is the set `reorder` permutes. */
function queuedOrder(projectKey: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT t.ticket_id FROM queue_membership m
         JOIN tickets t ON t.project_key = m.project_key AND t.ticket_id = m.ticket_id
        WHERE m.project_key = ?
        ORDER BY t.priority_rank ASC, t.ticket_id ASC`,
    )
    .all(projectKey) as { ticket_id: string }[];
  return rows.map((r) => r.ticket_id);
}

/** Rewrite the ranked projection so the QUEUED tickets appear in `desired` order,
 *  leaving every non-queued ranked ticket in the slot it already occupies. */
function applyQueuePermutation(projectKey: string, desired: string[]): string[] {
  const ranked = rankedOrder(projectKey).map((r) => r.ticketId);
  const queued = new Set(desired);
  const slots: number[] = [];
  for (let i = 0; i < ranked.length; i++) if (queued.has(ranked[i]!)) slots.push(i);
  const next = [...ranked];
  for (let i = 0; i < slots.length; i++) next[slots[i]!] = desired[i]!;
  renumber(projectKey, next);
  return next;
}

/** Same multiset of ids, order aside. Compared element-wise on sorted copies
 *  rather than by joining on a separator — a separator that can occur inside an id
 *  makes two different queues compare equal, and picking an "impossible" one is how
 *  a control character ends up in a source file. */
function isSamePermutation(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/** Same ids in the SAME order — an ORDER-SENSITIVE equality, distinct from
 *  isSamePermutation, which ignores order. A reorder to the order the queue already
 *  has moves nothing, so it must not append a `reorder` event: that event is the
 *  queue version (queueVersion = MAX order-affecting event id), and bumping it on a
 *  no-op refuses a concurrent reorder submitted against a version the queue never
 *  actually left (RF-6). */
function isSameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function assertReorderable(projectKey: string, verb: string): string[] {
  const queue = queuedOrder(projectKey);
  const ranked = new Set(rankedOrder(projectKey).map((r) => r.ticketId));
  const unranked = queue.filter((id) => !ranked.has(id));
  if (unranked.length > 0) {
    throw new QueueRefusal(
      `forge: backlog ${verb} refuses — ${unranked.join(", ")} ${unranked.length === 1 ? "is" : "are"} ` +
        `queued without a rank, so the queue has no total order to permute. Rank ${unranked.length === 1 ? "it" : "them"} first.`,
      verb,
      unranked[0] ?? null,
    );
  }
  return queue;
}

// ─── the reorder concurrency guard (FG-591 D11) ──────────────────────────────
//
// A reorder is submitted against a view the operator read some time ago — a board
// render, a `queue list`, a drag that started three seconds and one dispatch ago.
// Every reorder verb below rewrites the WHOLE queue order, so a submission built on
// a stale view does not merge with what happened meanwhile: it OVERWRITES it. The
// classic loss is an enqueue that lands between the read and the write and is then
// silently dropped back out of position by a permutation that never knew about it.
//
// THE VERSION IS queue_events' OWN AUTOINCREMENT id — the project's highest
// ORDER-AFFECTING event. No new column, no new counter, no vector clock: this table
// already appends exactly one row per committed order change, in the same
// transaction as the change (see appendQueueEvent), which is precisely the property
// a version needs and the only one it needs.
//
// WHY A FILTERED MAX rather than the plain max id. queue_events is ONE history for
// the whole operator queue, and since FG-610 it also carries `claim` and `release`
// — and `readiness`, which records an assessment, not a move. None of those change
// membership or order, so counting them would refuse an operator's drag every time
// the dispatcher claimed something. That is a false refusal with a real cost and no
// safety return. What IS counted is every verb that can change WHICH tickets are in
// the queue or WHAT ORDER they are in: rank, unrank, enqueue, dequeue, reorder.
//
// Known blind spot, stated rather than papered over: a lifecycle status change
// (closing a ticket, deferring it) appends no queue event, so it does not move the
// version. It also changes neither membership nor rank order — the ticket keeps
// both — so a reorder submitted across one still permutes exactly the set it read.
//
// The check is a genuine compare-and-set because it is READ INSIDE the caller's
// writeTransaction: BEGIN IMMEDIATE already holds the whole-database write lock, so
// no third party can append between the comparison and the renumber.
export const QUEUE_ORDER_EVENT_TYPES: readonly QueueEventType[] = [
  "rank",
  "unrank",
  "enqueue",
  "dequeue",
  "reorder",
];

/** The project's current queue version: the id of its most recent order-affecting
 *  queue event, or 0 for a project whose queue has never moved. Monotonic, since
 *  queue_events.id is AUTOINCREMENT and this set only ever gains rows. */
export function queueVersion(projectKey: string): number {
  const placeholders = QUEUE_ORDER_EVENT_TYPES.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT MAX(id) AS version FROM queue_events
        WHERE project_key = ? AND event_type IN (${placeholders})`,
    )
    .get(projectKey, ...QUEUE_ORDER_EVENT_TYPES) as { version: number | null } | undefined;
  return row?.version ?? 0;
}

/** What moved since the caller's view, named concretely. "The queue changed" is not
 *  an answer an operator can act on; "FG-7 was enqueued" is. */
function changesSince(projectKey: string, version: number): string {
  const placeholders = QUEUE_ORDER_EVENT_TYPES.map(() => "?").join(", ");
  const db = getDb();
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM queue_events
          WHERE project_key = ? AND id > ? AND event_type IN (${placeholders})`,
      )
      .get(projectKey, version, ...QUEUE_ORDER_EVENT_TYPES) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT event_type, ticket_id FROM queue_events
        WHERE project_key = ? AND id > ? AND event_type IN (${placeholders})
        ORDER BY id ASC LIMIT 5`,
    )
    .all(projectKey, version, ...QUEUE_ORDER_EVENT_TYPES) as {
    event_type: string;
    ticket_id: string;
  }[];
  const shown = rows.map((r) => `${r.event_type} ${r.ticket_id}`).join(", ");
  const more = count > rows.length ? `, and ${count - rows.length} more` : "";
  return `${count} change${count === 1 ? "" : "s"} since: ${shown}${more}`;
}

/** How each verb is spelled ON THE OPERATOR'S COMMAND LINE. `reorder` shipped under
 *  `forge backlog` in FG-609 and stays there; the relative forms are `forge queue`
 *  verbs. A refusal that names a command the operator cannot type is a worse answer
 *  than one that names none. */
function verbSurface(verb: string): string {
  return verb === "rank-before" || verb === "rank-after" ? `queue ${verb}` : `backlog ${verb}`;
}

/** The optimistic-concurrency opt-in carried by every reorder verb. */
export type ReorderOptions = {
  /** The queue version the caller's view was built from (see queueVersion). When
   *  present, the verb refuses BY NAME rather than clobbering a queue that moved
   *  underneath it. OMITTED means "apply unconditionally" — that is today's
   *  behaviour and stays the default, because a CLI operator typing a reorder
   *  against a queue they just listed is not the racing caller this guards. */
  expectedVersion?: number;
};

/** Compare-and-set on the queue version. Runs FIRST inside the verb's transaction
 *  and before any mutation, so a refusal writes nothing at all. */
function assertQueueVersion(projectKey: string, verb: string, opts: ReorderOptions): void {
  const expected = opts.expectedVersion;
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected < 0) {
    throw new QueueRefusal(
      `forge: ${verbSurface(verb)} refuses — the expected queue version must be a non-negative integer ` +
        `(see \`forge queue list\`), got '${String(expected)}'. Nothing was written.`,
      verb,
      null,
    );
  }
  const actual = queueVersion(projectKey);
  if (actual === expected) return;
  if (expected > actual) {
    throw new QueueRefusal(
      `forge: ${verbSurface(verb)} refuses — this ${verb} was submitted against queue version ${expected}, ` +
        `but project_key '${projectKey}' has never been past version ${actual}. That version did not ` +
        `come from this queue. Nothing was written.`,
      verb,
      null,
    );
  }
  throw new QueueRefusal(
    `forge: ${verbSurface(verb)} refuses — the queue moved underneath this ${verb}. It was submitted ` +
      `against queue version ${expected} and project_key '${projectKey}' is now at version ${actual} ` +
      `(${changesSince(projectKey, expected)}). Applying it would silently overwrite that change. ` +
      `Nothing was written — re-read the queue and resubmit.`,
    verb,
    null,
  );
}

/** Set the queue's order to an exact permutation of its current members. ATOMIC:
 *  the whole renumber and its event are one commit, so a crash mid-renumber leaves
 *  the previous order byte-identical rather than partially renumbered. */
export function setQueueOrder(
  projectKey: string,
  desired: string[],
  opts: ReorderOptions = {},
  at: string = nowIso(),
): { queue: string[]; version: number } {
  return writeTransaction(() => {
    assertQueueVersion(projectKey, "reorder", opts);
    const queue = assertReorderable(projectKey, "reorder");
    if (queue.length === 0) {
      throw new QueueRefusal(
        `forge: backlog reorder refuses — the operator queue is empty, so there is nothing to reorder.`,
        "reorder",
        null,
      );
    }
    const before = [...queue];
    const wanted = [...desired];
    if (!isSamePermutation(wanted, queue)) {
      throw new QueueRefusal(
        `forge: backlog reorder refuses — --order must be an exact permutation of the current queue ` +
          `(${queue.join(", ") || "empty"}), got (${wanted.join(", ") || "empty"}).`,
        "reorder",
        null,
      );
    }
    // A reorder to the order already in place moves nothing: skip the event so the
    // version does not advance and a concurrent reorder against the loaded version
    // still lands (RF-6).
    if (isSameOrder(wanted, before)) {
      return { queue: queuedOrder(projectKey), version: queueVersion(projectKey) };
    }
    applyQueuePermutation(projectKey, wanted);
    // Attributed to the ticket that ends up at the head — a whole-queue reorder has
    // no single subject, and an event row with an empty ticket_id would be an
    // unattributable line in an audit log.
    appendQueueEvent(projectKey, wanted[0]!, "reorder", { before, after: wanted }, at);
    return { queue: queuedOrder(projectKey), version: queueVersion(projectKey) };
  });
}

/** Move ONE queued ticket to `position` (1-based) within the queue, renumbering
 *  the ranked projection atomically. */
export function moveQueuePosition(
  projectKey: string,
  ticketId: string,
  position: number,
  opts: ReorderOptions = {},
  at: string = nowIso(),
): { queue: string[]; position: number; version: number } {
  return writeTransaction(() => {
    assertQueueVersion(projectKey, "reorder", opts);
    const queue = assertReorderable(projectKey, "reorder");
    if (!queue.includes(ticketId)) {
      throw new QueueRefusal(
        `forge: backlog reorder refuses — ${ticketId} is not in the operator queue.`,
        "reorder",
        ticketId,
      );
    }
    const before = [...queue];
    const without = queue.filter((id) => id !== ticketId);
    const target = Math.max(0, Math.min(without.length, Math.trunc(position) - 1));
    const wanted = [...without.slice(0, target), ticketId, ...without.slice(target)];
    // Already in that slot: a no-op that must not advance the version (RF-6).
    if (isSameOrder(wanted, before)) {
      return { queue: queuedOrder(projectKey), position: target + 1, version: queueVersion(projectKey) };
    }
    applyQueuePermutation(projectKey, wanted);
    appendQueueEvent(projectKey, ticketId, "reorder", { before, after: wanted, position: target + 1 }, at);
    return { queue: queuedOrder(projectKey), position: target + 1, version: queueVersion(projectKey) };
  });
}

// ─── relative ranking (FG-591) ───────────────────────────────────────────────
//
// WHY A RELATIVE FORM AT ALL, given moveQueuePosition already exists. A position
// is not what the operator means. "Put FG-7 above FG-3" is intent that survives the
// queue moving; "put FG-7 at position 4" is a coordinate that silently means
// something else the moment anything else is enqueued, dequeued or reordered. A
// drag on the board, and an operator at a terminal reading a list, are both
// expressing the first thing. Position 4 is what an unguarded replay of a stale
// view looks like — which is exactly what the version guard above exists to catch,
// and why the relative form and the guard land together.
//
// SCOPE: these permute THE QUEUE, exactly like setQueueOrder and moveQueuePosition,
// so every non-queued ranked ticket keeps the slot it already occupied (see
// applyQueuePermutation). Ranking a ticket that is NOT a queue member relative to
// another is `rankTicket` with a position over the whole ranked domain; these
// verbs refuse it by name rather than quietly widening their domain, because the
// two operate on different sets and collapsing them would make "leave the rest of
// the backlog where it is" depend on an argument the caller did not pass.

function rankRelative(
  projectKey: string,
  ticketId: string,
  referenceId: string,
  placement: "before" | "after",
  opts: ReorderOptions,
  at: string,
): { queue: string[]; position: number; version: number } {
  const verb = `rank-${placement}`;
  return writeTransaction(() => {
    assertQueueVersion(projectKey, verb, opts);
    if (ticketId === referenceId) {
      throw new QueueRefusal(
        `forge: ${verbSurface(verb)} refuses — ${ticketId} cannot be ranked relative to itself.`,
        verb,
        ticketId,
      );
    }
    const queue = assertReorderable(projectKey, verb);
    for (const [id, role] of [
      [ticketId, "the ticket being moved"],
      [referenceId, "the reference ticket"],
    ] as const) {
      if (!queue.includes(id)) {
        requireTicket(projectKey, id, verb);
        throw new QueueRefusal(
          `forge: ${verbSurface(verb)} refuses — ${id} (${role}) is not in the operator queue, and ` +
            `${verb} permutes the queue. Enqueue it first, or use \`forge backlog rank ${id} ` +
            `--position <n>\` to place it in the stack rank without queueing it.`,
          verb,
          id,
        );
      }
    }

    const before = [...queue];
    const without = queue.filter((id) => id !== ticketId);
    const referenceIndex = without.indexOf(referenceId);
    const target = placement === "before" ? referenceIndex : referenceIndex + 1;
    const wanted = [...without.slice(0, target), ticketId, ...without.slice(target)];
    // A relative rank that lands the ticket exactly where it already sits changes
    // neither membership nor order: skip the event so the version holds and a
    // concurrent reorder against the loaded version is not falsely refused (RF-6).
    if (isSameOrder(wanted, before)) {
      return { queue: queuedOrder(projectKey), position: target + 1, version: queueVersion(projectKey) };
    }
    applyQueuePermutation(projectKey, wanted);
    // Recorded as a `reorder` event — the fact IS a reorder, and a second event type
    // for the same fact would be a second vocabulary for it. The operator's INTENT
    // is preserved in the payload, so the history says "before FG-3", not "to 4".
    appendQueueEvent(
      projectKey,
      ticketId,
      "reorder",
      { before, after: wanted, position: target + 1, placement, relativeTo: referenceId },
      at,
    );
    return { queue: queuedOrder(projectKey), position: target + 1, version: queueVersion(projectKey) };
  });
}

/** Move a queued ticket to immediately BEFORE `referenceId` in the queue. */
export function rankBefore(
  projectKey: string,
  ticketId: string,
  referenceId: string,
  opts: ReorderOptions = {},
  at: string = nowIso(),
): { queue: string[]; position: number; version: number } {
  return rankRelative(projectKey, ticketId, referenceId, "before", opts, at);
}

/** Move a queued ticket to immediately AFTER `referenceId` in the queue. */
export function rankAfter(
  projectKey: string,
  ticketId: string,
  referenceId: string,
  opts: ReorderOptions = {},
  at: string = nowIso(),
): { queue: string[]; position: number; version: number } {
  return rankRelative(projectKey, ticketId, referenceId, "after", opts, at);
}

// ─── derived projections (COMPUTED, never stored) ────────────────────────────

/** Blocked as the TICKET STATUS vocabulary means it. Only STATUS-BEARING evidence
 *  counts — the enriched dependency / campaign / run-derived kinds are excluded
 *  here, exactly as they are on the other three surfaces, and are read instead by
 *  isQueueBlocked below. Feeds hydrateForReadiness, so an enriched blocker can
 *  never reach StructuredTicket.status. */
export function isBlocked(projectKey: string, ticketId: string): boolean {
  const rows = getDb()
    .prepare(`SELECT source FROM blocker_evidence WHERE project_key = ? AND ticket_id = ?`)
    .all(projectKey, ticketId) as { source: string }[];
  return rows.some((r) => isStatusBearingEvidenceSource(r.source));
}

/** The queue projection value that means "this evidence blocks execution". The
 *  other value the column carries, 'not_ready', is a READINESS hint and is
 *  deliberately not blocking: readiness has its own reported projection, and
 *  folding it into `blocked` would report one fact twice under two names. */
const QUEUE_BLOCKING_PROJECTION = "blocked";

/** THE QUEUE'S OWN blocked derivation, over ALL supported evidence kinds — the
 *  second, deliberately WIDER predicate of the two (D7).
 *
 *  It is separate from isBlocked rather than a widening of it, because they answer
 *  different questions and only one of them is container-visible:
 *    isBlocked      — may this evidence make the ticket READ BACK as status
 *                     'blocked' on the host seam, the container authority, the
 *                     snapshot and the dashboard? Legacy only, forever, via the
 *                     zero-import leaf predicate.
 *    isQueueBlocked — does the OPERATOR QUEUE show this entry as blocked? Legacy
 *                     evidence OR any enriched row whose stored queue_projection
 *                     says it blocks.
 *  Collapsing them would make the first enriched dependency row flip every
 *  container's view of that ticket's status, which is the exact defect the leaf
 *  predicate exists to prevent.
 *
 *  Blocked here is REPORTED, not enforced: it does not remove the entry from the
 *  executable queue (see executableQueue). Deferred is the ineligible case. */
export function isQueueBlocked(projectKey: string, ticketId: string): boolean {
  const rows = getDb()
    .prepare(
      `SELECT source, queue_projection FROM blocker_evidence WHERE project_key = ? AND ticket_id = ?`,
    )
    .all(projectKey, ticketId) as { source: string; queue_projection: string | null }[];
  return rows.some(
    (r) =>
      isStatusBearingEvidenceSource(r.source) || r.queue_projection === QUEUE_BLOCKING_PROJECTION,
  );
}

/** In progress, derived: the ticket has dispatch evidence for a task that has not
 *  reached a terminal disposition. Never stored — a stored one would be a second
 *  mutable status vocabulary beside the lifecycle status. */
export function isInProgress(projectKey: string, ticketId: string): boolean {
  const placeholders = TERMINAL_TASK_STATUSES.map(() => "?").join(", ");
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM ticket_dispatch_evidence e
           JOIN tasks t ON t.id = e.task_id
          WHERE e.project_key = ? AND e.ticket_id = ? AND t.status NOT IN (${placeholders})
          LIMIT 1`,
      )
      .get(projectKey, ticketId, ...TERMINAL_TASK_STATUSES) !== undefined
  );
}

/** THE EXECUTABLE QUEUE: queued AND active AND ranked, in rank order.
 *
 *  A blocked ticket STAYS here with its rank and membership intact — the blocked
 *  projection is derived and reported, and it does not make a ticket
 *  queue-INELIGIBLE, it makes it visibly blocked. A done or deferred one leaves,
 *  because its lifecycle says it is not executable; its rank, its membership and
 *  its queue-event history all survive, so reactivating it returns it to exactly
 *  the same position. */
export function executableQueue(projectKey: string): QueueEntry[] {
  return queueView(projectKey).filter((e) => e.queued && e.status === "active" && e.rank !== null);
}

/** Every ranked or queued ticket of the project, in canonical read order, with all
 *  derived projections resolved. The one read surface the CLI renders. */
export function queueView(projectKey: string): QueueEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT t.ticket_id, t.title, t.type, t.status, t.priority_rank,
              (m.ticket_id IS NOT NULL) AS queued
         FROM tickets t
         LEFT JOIN queue_membership m
           ON m.project_key = t.project_key AND m.ticket_id = t.ticket_id
        WHERE t.project_key = ?
          AND (t.priority_rank IS NOT NULL OR m.ticket_id IS NOT NULL)
        ORDER BY t.priority_rank ASC, t.ticket_id ASC`,
    )
    .all(projectKey) as {
    ticket_id: string;
    title: string;
    type: string;
    status: string;
    priority_rank: number | null;
    queued: number;
  }[];

  return rows.map((r) => ({
    ticketId: r.ticket_id,
    title: r.title,
    type: r.type,
    status: r.status,
    rank: r.priority_rank,
    queued: r.queued === 1,
    blocked: isQueueBlocked(projectKey, r.ticket_id),
    inProgress: isInProgress(projectKey, r.ticket_id),
    readiness: readinessView(projectKey, r.ticket_id),
  }));
}
