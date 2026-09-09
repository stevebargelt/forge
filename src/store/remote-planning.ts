// FG-783 (step 3): the in-process store authority for the Remote Board's bounded
// planning command surface.
//
// ─── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
// The ONLY writer of remote_planning_commands and ticket_planning_annotations,
// and the single ATOMIC owner of the four things a remote planning mutation must
// do together or not at all:
//
//   (a) REPLAY short-circuit  — request_id lookup in front of every action, so a
//                               redelivery (including after a server restart, i.e.
//                               a reopened DB handle) returns the RECORDED outcome
//                               and re-applies nothing;
//   (b) PRECONDITION check    — per-action, refusing with ZERO mutation on a stale
//                               precondition and returning the current safe summary;
//   (c) MUTATION              — delegated to the SAME domain authority local ops
//                               use (src/store/queue.ts for the queue actions, the
//                               appendPlanningAnnotation primitive below for the
//                               annotation), never a hand-rolled SQL write of a
//                               queue/ticket table;
//   (d) LEDGER + AUDIT row    — one row in remote_planning_commands recording
//                               actor / transport / request-id / precondition /
//                               outcome, plus (for annotate) the annotation row,
//                               in the SAME commit as the mutation.
//
// ─── WHY IN-PROCESS AND NOT THE CLI SHELL (tech-lead decision) ────────────────
// The local dashboard's queue-mutation path shells a SEPARATE forge process. That
// cannot hold (a)+(c)+(d) in one transaction: a crash between the CLI's commit and
// a handler-side ledger write leaves a mutation with no ledger row — a double-apply
// window on the next redelivery. getDb() is read-write in-process, so ONE
// writeTransaction (BEGIN IMMEDIATE, the single host write path) covers ledger +
// precondition + mutation + audit with no cross-process seam. This still honours
// "delegate to the same authority, never write Forge tables from the HTTP handler":
// the authority lives here in src/store and reuses the exact queue accessors local
// ops call; the HTTP handler (step 5) only calls applyRemotePlanningCommand.
//
// ─── PRECONDITIONS, PER ACTION ───────────────────────────────────────────────
// NEVER keyed off a rank VALUE — priority_rank is renumbered on every move, so a
// stored rank number is never a stable precondition (see queue.ts's rank note).
//   change-rank / reorder-queue → queueVersion CAS (queue.ts's expectedVersion,
//                                 the MAX order-affecting queue_events id).
//   enqueue                     → readiness at the CURRENT revision. enqueue IS the
//                                 recheck; there is no separate version to carry.
//   dequeue                     → none. Dequeue retains rank and carries no version.
//   append-annotation           → the ticket's monotonic revision (TicketRow.revision),
//                                 symmetric with the queue actions' expectedVersion.
//
// The refusal path COMMITS the ledger row (outcome='refused') so a refusal is
// auditable and a redelivery of a refused command returns the recorded refusal — a
// genuine RETRY after re-reading is a NEW request_id with a fresh precondition, not
// a redelivery of the stale one.

import { randomUUID } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { getTicket } from "./tickets.js";
import {
  QueueRefusal,
  dequeueTicket,
  enqueueTicket,
  moveQueuePosition,
  queueVersion,
  queueView,
  setQueueOrder,
} from "./queue.js";
import { nowIso } from "../util/ids.js";

// ─── the closed action vocabulary ────────────────────────────────────────────
// Exactly the four planning capabilities the story grants, spelled as five verbs
// (enqueue and dequeue are the two halves of the readiness-gate action). The
// closed command registry (step 4) asserts this set over data; this authority
// switches over it exhaustively so an unhandled action is a compile error, never a
// silent no-op.
export type RemotePlanningAction =
  | "change-rank"
  | "enqueue"
  | "dequeue"
  | "reorder-queue"
  | "append-annotation";

/** The fields every command carries. actor / transport / projectKey are
 *  SERVER-AUTHORITATIVE — the server (step 5) fills them from the identity
 *  resolver and the read-path project scope, never from the request body. */
type CommandBase = {
  requestId: string;
  actor: string;
  transport: string;
  projectKey: string;
  /** The ticket the action targets. For reorder-queue this is the head ticket, an
   *  attribution subject only (the whole order lives in `order`). */
  targetId: string;
  /** Envelope timestamp. Defaults to now when the caller omits it. */
  at?: string;
};

export type RemotePlanningCommand =
  | (CommandBase & { action: "change-rank"; position: number; expectedVersion: number })
  | (CommandBase & { action: "enqueue" })
  | (CommandBase & { action: "dequeue" })
  | (CommandBase & { action: "reorder-queue"; order: string[]; expectedVersion: number })
  | (CommandBase & { action: "append-annotation"; body: string; ticketRevision: number });

export type RemotePlanningOutcome = "applied" | "refused";

/** A redacted, safe-to-return-remotely summary of the outcome or the current
 *  state to re-read on a refusal. Contains NO secrets and NO filesystem paths —
 *  only ticket ids, queue ids, versions and revisions, and a refusal message that
 *  is itself already safe (the queue verbs' QueueRefusal text names commands and
 *  versions, nothing sensitive). */
export type SafeSummary = {
  message: string;
  queueVersion?: number;
  queue?: string[];
  ticketRevision?: number;
  position?: number;
  annotationId?: string;
};

export type RemotePlanningResult = {
  requestId: string;
  action: RemotePlanningAction;
  targetId: string;
  outcome: RemotePlanningOutcome;
  /** true when this result was replayed from the ledger rather than freshly
   *  applied — the caller applied NOTHING this call. */
  replayed: boolean;
  /** The per-action precondition, as recorded text. NULL for dequeue. */
  precondition: string | null;
  summary: SafeSummary;
  createdAt: string;
};

// ─── test seam: a forced failure between the mutation and the ledger write ────
// Load-bearing for the atomicity proof. Armed by a test to throw AFTER the
// mutation has run and BEFORE the ledger row is inserted; the whole outer
// writeTransaction then rolls back, so a mutation with no ledger row (the
// double-apply window) is not a reachable state. Never armed in production.
let _ledgerWriteFailureHook: (() => void) | null = null;

export function setLedgerWriteFailureHookForTest(fn: (() => void) | null): void {
  _ledgerWriteFailureHook = fn;
}

type LedgerRow = {
  request_id: string;
  actor: string;
  transport: string;
  project_key: string;
  action: string;
  target_id: string;
  precondition: string | null;
  outcome: string;
  result_summary: string | null;
  created_at: string;
};

// RF-1: the ledger lookup is scoped to the COMMITTING project. A request id is
// unique only within the identity that minted it, so keying replay on request_id
// alone let a plan-authorized identity in project A read B's recorded outcome (or
// suppress its own command) on an id collision. Scoping by (project_key, request_id)
// — the table's composite primary key — closes that cross-project seam structurally.
function findLedgerRow(projectKey: string, requestId: string): LedgerRow | undefined {
  return getDb()
    .prepare(
      `SELECT request_id, actor, transport, project_key, action, target_id,
              precondition, outcome, result_summary, created_at
         FROM remote_planning_commands WHERE project_key = ? AND request_id = ?`,
    )
    .get(projectKey, requestId) as LedgerRow | undefined;
}

/** The precondition string a command records, derived deterministically and with NO
 *  side effect — the same value the per-action branch computes below. Computed up
 *  front so a replay can verify the stored row is the SAME command before returning
 *  its outcome (RF-1). */
function preconditionForCommand(cmd: RemotePlanningCommand): string | null {
  switch (cmd.action) {
    case "change-rank":
    case "reorder-queue":
      return `expectedVersion=${cmd.expectedVersion}`;
    case "enqueue":
      return "enqueue:readiness@current-revision";
    case "dequeue":
      return null;
    case "append-annotation":
      return `ticketRevision=${cmd.ticketRevision}`;
  }
}

function resultFromLedger(row: LedgerRow, replayed: boolean): RemotePlanningResult {
  return {
    requestId: row.request_id,
    action: row.action as RemotePlanningAction,
    targetId: row.target_id,
    outcome: row.outcome as RemotePlanningOutcome,
    replayed,
    precondition: row.precondition,
    summary: parseSummary(row.result_summary),
    createdAt: row.created_at,
  };
}

function parseSummary(text: string | null): SafeSummary {
  if (!text) return { message: "" };
  try {
    return JSON.parse(text) as SafeSummary;
  } catch {
    // A summary the current binary cannot parse is degraded to its raw text
    // rather than throwing — a replay must never fail on a formatting drift.
    return { message: text };
  }
}

/** The queued ticket ids in canonical rank order — the "re-read this" list on a
 *  refusal. Derived from the same read surface the CLI renders (queueView), so it
 *  cannot drift from what the operator sees. */
function queuedIds(projectKey: string): string[] {
  return queueView(projectKey)
    .filter((e) => e.queued)
    .map((e) => e.ticketId);
}

/** The safe summary for a refused queue action: the current version and order to
 *  re-read, plus the verb's own refusal message. */
function refusedQueueSummary(projectKey: string, message: string): SafeSummary {
  return { message, queueVersion: queueVersion(projectKey), queue: queuedIds(projectKey) };
}

// ─── the annotation primitive (new; the annotation half of the authority) ─────
//
// The authoritative operator PLANNING-ANNOTATION write. It did not exist before
// FG-783: FG-703's ops.adjudicated is an EVENT, and queue/backlog --note annotates
// a queue MEMBERSHIP row, not a free-standing ticket annotation. The CALLER holds
// the write transaction and has ALREADY validated the revision precondition — this
// only writes the row, so the annotation and its ledger row commit together.
export function appendPlanningAnnotation(args: {
  projectKey: string;
  ticketId: string;
  ticketRevision: number;
  actor: string;
  body: string;
  requestId: string | null;
  at: string;
}): { id: string } {
  const id = `pa-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO ticket_planning_annotations
         (id, project_key, ticket_id, ticket_revision, actor, body, created_at, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.projectKey,
      args.ticketId,
      args.ticketRevision,
      args.actor,
      args.body,
      args.at,
      args.requestId,
    );
  return { id };
}

// ─── the single atomic entry point ───────────────────────────────────────────

/** Apply one bounded remote planning command. ONE writeTransaction (BEGIN
 *  IMMEDIATE) holds the replay short-circuit, the precondition check, the mutation
 *  (delegated to the local authority), and the ledger+audit write. Returns the
 *  recorded outcome — never a synthesized/optimistic success; the caller renders
 *  exactly what committed. */
export function applyRemotePlanningCommand(cmd: RemotePlanningCommand): RemotePlanningResult {
  const at = cmd.at ?? nowIso();
  return writeTransaction(() => {
    // (a) REPLAY short-circuit — in FRONT of every action. A recorded request_id
    // (scoped to THIS project) returns its outcome verbatim and touches NOTHING (no
    // primitive re-invoked, no enqueue readiness re-run, no annotation re-appended).
    //
    // RF-1: before returning the recorded outcome, verify the stored row is the SAME
    // command — same actor, action, target and precondition. The composite key already
    // stops a CROSS-PROJECT collision (the lookup is project-scoped); this guard stops a
    // SAME-project request-id reuse for a different command from replaying an unrelated
    // outcome. A mismatch refuses with a named reason and ZERO mutation — no ledger row
    // is written (one already exists for this key), nothing is applied.
    const existing = findLedgerRow(cmd.projectKey, cmd.requestId);
    if (existing) {
      const expectedPrecondition = preconditionForCommand(cmd);
      if (
        existing.actor === cmd.actor &&
        existing.action === cmd.action &&
        existing.target_id === cmd.targetId &&
        existing.precondition === expectedPrecondition
      ) {
        return resultFromLedger(existing, true);
      }
      return {
        requestId: cmd.requestId,
        action: cmd.action,
        targetId: cmd.targetId,
        outcome: "refused",
        replayed: false,
        precondition: expectedPrecondition,
        summary: {
          message:
            "request id reused for a different command — refused with no mutation. " +
            "Re-read the board and resubmit with a fresh request id.",
        },
        createdAt: at,
      };
    }

    // (b)+(c) precondition + mutation, per action. A QueueRefusal from a delegated
    // verb is CAUGHT and recorded as outcome='refused' — throwing out of the
    // transaction would roll back the very ledger row that makes the refusal
    // auditable. A non-QueueRefusal (a real fault) propagates and rolls everything
    // back.
    let outcome: RemotePlanningOutcome;
    let precondition: string | null;
    let summary: SafeSummary;

    switch (cmd.action) {
      case "change-rank": {
        precondition = `expectedVersion=${cmd.expectedVersion}`;
        try {
          const res = moveQueuePosition(
            cmd.projectKey,
            cmd.targetId,
            cmd.position,
            { expectedVersion: cmd.expectedVersion },
            at,
          );
          outcome = "applied";
          summary = {
            message: `${cmd.targetId} moved to queue position ${res.position}`,
            queueVersion: res.version,
            queue: res.queue,
            position: res.position,
          };
        } catch (e) {
          if (!(e instanceof QueueRefusal)) throw e;
          outcome = "refused";
          summary = refusedQueueSummary(cmd.projectKey, e.message);
        }
        break;
      }

      case "reorder-queue": {
        precondition = `expectedVersion=${cmd.expectedVersion}`;
        try {
          const res = setQueueOrder(
            cmd.projectKey,
            cmd.order,
            { expectedVersion: cmd.expectedVersion },
            at,
          );
          outcome = "applied";
          summary = {
            message: `operator queue reordered`,
            queueVersion: res.version,
            queue: res.queue,
          };
        } catch (e) {
          if (!(e instanceof QueueRefusal)) throw e;
          outcome = "refused";
          summary = refusedQueueSummary(cmd.projectKey, e.message);
        }
        break;
      }

      case "enqueue": {
        // The precondition IS readiness at the current revision; enqueueTicket
        // evaluates it on this call. It returns a discriminated result on a
        // readiness refusal (committing the assessment) and throws QueueRefusal
        // for a missing / non-active ticket — both are refusals here.
        precondition = "enqueue:readiness@current-revision";
        try {
          const res = enqueueTicket(cmd.projectKey, cmd.targetId, { by: cmd.actor }, at);
          if (res.ok) {
            outcome = "applied";
            summary = {
              message: `${cmd.targetId} enqueued at position ${res.position}`,
              queueVersion: queueVersion(cmd.projectKey),
              queue: res.queue,
              position: res.position,
            };
          } else {
            outcome = "refused";
            summary = {
              message: res.reason,
              queueVersion: queueVersion(cmd.projectKey),
              queue: queuedIds(cmd.projectKey),
            };
          }
        } catch (e) {
          if (!(e instanceof QueueRefusal)) throw e;
          outcome = "refused";
          summary = refusedQueueSummary(cmd.projectKey, e.message);
        }
        break;
      }

      case "dequeue": {
        // Retains rank, carries no version — no precondition to record.
        precondition = null;
        try {
          const res = dequeueTicket(cmd.projectKey, cmd.targetId, at);
          outcome = "applied";
          summary = {
            message: `${cmd.targetId} dequeued (rank retained)`,
            queueVersion: queueVersion(cmd.projectKey),
            queue: res.queue,
          };
        } catch (e) {
          if (!(e instanceof QueueRefusal)) throw e;
          outcome = "refused";
          summary = refusedQueueSummary(cmd.projectKey, e.message);
        }
        break;
      }

      case "append-annotation": {
        // Precondition: the ticket's monotonic revision. Evaluated here, in front
        // of the write, so a superseded revision refuses with ZERO mutation.
        precondition = `ticketRevision=${cmd.ticketRevision}`;
        const row = getTicket(cmd.projectKey, cmd.targetId);
        const currentRevision = row?.revision ?? null;
        if (!row) {
          outcome = "refused";
          summary = {
            message: `annotation refused — ${cmd.targetId} does not exist in this project`,
          };
        } else if (currentRevision !== cmd.ticketRevision) {
          outcome = "refused";
          summary = {
            message:
              `annotation refused — ${cmd.targetId} was at revision ${cmd.ticketRevision} when this ` +
              `was submitted and is now at revision ${currentRevision}. Re-read the ticket and resubmit.`,
            ticketRevision: currentRevision ?? undefined,
          };
        } else {
          const { id } = appendPlanningAnnotation({
            projectKey: cmd.projectKey,
            ticketId: cmd.targetId,
            ticketRevision: cmd.ticketRevision,
            actor: cmd.actor,
            body: cmd.body,
            requestId: cmd.requestId,
            at,
          });
          outcome = "applied";
          summary = {
            message: `annotation appended to ${cmd.targetId}`,
            ticketRevision: cmd.ticketRevision,
            annotationId: id,
          };
        }
        break;
      }

      default: {
        // Exhaustiveness backstop — an action outside the closed vocabulary is a
        // type error at compile time and refuses at runtime, never a silent apply.
        const _never: never = cmd;
        throw new Error(`forge: remote planning refuses — unknown action ${JSON.stringify(_never)}`);
      }
    }

    // (d) LEDGER + AUDIT row. The test seam fires HERE — between the mutation and
    // this write — to prove a failure in that gap rolls BOTH back.
    _ledgerWriteFailureHook?.();
    getDb()
      .prepare(
        `INSERT INTO remote_planning_commands
           (request_id, actor, transport, project_key, action, target_id,
            precondition, outcome, result_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cmd.requestId,
        cmd.actor,
        cmd.transport,
        cmd.projectKey,
        cmd.action,
        cmd.targetId,
        precondition,
        outcome,
        JSON.stringify(summary),
        at,
      );

    return {
      requestId: cmd.requestId,
      action: cmd.action,
      targetId: cmd.targetId,
      outcome,
      replayed: false,
      precondition,
      summary,
      createdAt: at,
    };
  });
}

// ─── read accessors (same-project scoped) ────────────────────────────────────

export type PlanningAnnotation = {
  id: string;
  projectKey: string;
  ticketId: string;
  ticketRevision: number;
  actor: string;
  body: string;
  createdAt: string;
  requestId: string | null;
};

/** Every planning annotation on a ticket, newest last. Scoped to the given
 *  project — a caller can never read another project's annotations through it. */
export function planningAnnotations(projectKey: string, ticketId: string): PlanningAnnotation[] {
  const rows = getDb()
    .prepare(
      `SELECT id, project_key, ticket_id, ticket_revision, actor, body, created_at, request_id
         FROM ticket_planning_annotations
        WHERE project_key = ? AND ticket_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(projectKey, ticketId) as {
    id: string;
    project_key: string;
    ticket_id: string;
    ticket_revision: number;
    actor: string;
    body: string;
    created_at: string;
    request_id: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    projectKey: r.project_key,
    ticketId: r.ticket_id,
    ticketRevision: r.ticket_revision,
    actor: r.actor,
    body: r.body,
    createdAt: r.created_at,
    requestId: r.request_id,
  }));
}

/** One row of the remote planning audit/ledger, as a redactable DTO. The store
 *  layer scopes it to a single project; the remote surface (step 5) applies the
 *  existing redactor before returning it. No secrets or filesystem paths are ever
 *  stored in these columns, so the DTO carries none. */
export type RemotePlanningAuditRow = {
  requestId: string;
  actor: string;
  transport: string;
  projectKey: string;
  action: RemotePlanningAction;
  targetId: string;
  precondition: string | null;
  outcome: RemotePlanningOutcome;
  summary: SafeSummary;
  createdAt: string;
};

/** The remote planning audit for ONE project, newest last. Scoped by project_key
 *  so a remote reader can never see another project's planning history. */
export function remotePlanningAudit(projectKey: string): RemotePlanningAuditRow[] {
  const rows = getDb()
    .prepare(
      `SELECT request_id, actor, transport, project_key, action, target_id,
              precondition, outcome, result_summary, created_at
         FROM remote_planning_commands
        WHERE project_key = ?
        ORDER BY created_at ASC, request_id ASC`,
    )
    .all(projectKey) as LedgerRow[];
  return rows.map((r) => ({
    requestId: r.request_id,
    actor: r.actor,
    transport: r.transport,
    projectKey: r.project_key,
    action: r.action as RemotePlanningAction,
    targetId: r.target_id,
    precondition: r.precondition,
    outcome: r.outcome as RemotePlanningOutcome,
    summary: parseSummary(r.result_summary),
    createdAt: r.created_at,
  }));
}
