// FG-783 (step 4): the command-envelope validator for the Remote Board planning surface.
//
// ─── WHAT AN ENVELOPE IS, AND WHAT THE BODY MAY NEVER CARRY ──────────────────
// A planning command is: an authenticated actor, a transport, a server-authoritative project
// key, a unique request id, a target id, a target revision / precondition, a requested action,
// and a timestamp. Of those, the ACTOR, the TRANSPORT, the PROJECT KEY and the TIMESTAMP are
// NEVER read from the request body — they come from the resolver / server (identity.ts, the
// bound resolver, server.ts). This module validates ONLY the body-derived operands:
//
//   * `action`   — a member of the closed registry (registry.ts); an unknown or excluded
//                  shape is refused, never dispatched.
//   * `requestId`— the idempotency key; a bounded, strict-charset string.
//   * `ticketId` — the target, gated by the same strict TICKET_ID charset the local mutation
//                  surface uses (no leading `-`, no path separator, no metacharacter).
//   * per-action operands (reference/placement/expectVersion/order/to/note/body/ticketRevision),
//                  each bounded and strictly typed.
//
// If the body names `actor`, `transport`, `projectKey`, `subject`, or `timestamp`, that is a
// client trying to forge server-authoritative identity/scope; it is REFUSED outright rather
// than ignored, so the boundary is loud (mirroring identity.ts's fail-closed posture).
//
// ─── WHY THE STRICT SHAPES, ON AN AUTHENTICATED-BUT-REMOTE SURFACE ───────────
// Even though FG-782 verified WHO is calling, the surface is off-host and the store authority
// (step 3) will apply what this produces. Bounds (MAX_*), a strict integer parse (never
// parseInt — under which "2x" is 2 and a typo becomes a different valid submission), the
// TICKET_ID gate, and the leading-`-` operand rejection are defense in depth: they keep a
// malformed or oversized body from ever reaching the mutation, and keep this envelope
// symmetric with the local queue-mutation surface's contract.
//
// PURE and self-contained: imports only the closed registry (data). No store, no capability
// constant, no I/O.

import { isRemotePlanningAction } from "./registry.js";

/** A refusal carries the HTTP status AND the concrete reason — a validator that refuses
 *  without saying why is operator-blindness. Structurally identical to queue-mutation.ts's
 *  MutationRefusal; kept local so this module stays self-contained. */
export type PlanningRefusal = { readonly ok: false; readonly status: number; readonly error: string };

function refuse(status: number, error: string): PlanningRefusal {
  return { ok: false, status, error };
}

export function isPlanningRefusal(v: unknown): v is PlanningRefusal {
  return typeof v === "object" && v !== null && (v as PlanningRefusal).ok === false;
}

// ─── ceilings and charsets ────────────────────────────────────────────────────

/** The whole-body cap the server (step 5) reads under. Exported so the listener and this
 *  validator agree on one number. An authenticated surface still does not get to trust the
 *  caller's sense of proportion. */
export const MAX_BODY_BYTES = 64 * 1024;
/** An enqueue membership note. One line of prose. */
export const MAX_NOTE_CHARS = 500;
/** A free-standing operator planning annotation body. Bounded, but larger than a note. */
export const MAX_ANNOTATION_CHARS = 2000;
/** A whole-queue reorder cannot name an unbounded number of tickets. */
export const MAX_ORDER_IDS = 1000;

/** A ticket id, strictly — the same gate the local mutation surface uses. This charset cannot
 *  express a leading `-`, a path separator, `..`, a shell metacharacter or whitespace. */
const TICKET_ID = /^[A-Za-z][A-Za-z0-9]{0,23}-[0-9]{1,9}$/;

/** A request id: the idempotency key. Bounded and strict — the first character class excludes
 *  `-`, so a request id can never itself look like a flag, and control characters / whitespace
 *  cannot enter a value that lands in the durable ledger. */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Keys a client may NEVER supply: they are server-authoritative and forging them is the whole
 *  point of the boundary. Naming any of them is a refusal, not a silent drop. */
const FORBIDDEN_BODY_KEYS = ["actor", "subject", "transport", "projectKey", "projectDir", "timestamp"] as const;

// ─── field validators ──────────────────────────────────────────────────────────

/** THE LAST GATE for any caller-derived string that could be read as a flag. Mirrors
 *  queue-mutation.ts's assertOperand: nothing caller-supplied may be empty or begin with `-`. */
function assertOperand(value: string, field: string): PlanningRefusal | null {
  if (value.length === 0) return refuse(400, `${field} must not be empty.`);
  if (value.startsWith("-")) return refuse(400, `${field} must not begin with "-".`);
  return null;
}

function ticketIdField(raw: unknown, field: string): string | PlanningRefusal {
  if (typeof raw !== "string") return refuse(400, `${field} is required and must be a string.`);
  const value = raw.trim();
  if (!TICKET_ID.test(value)) {
    return refuse(400, `${field} is not a ticket id (expected e.g. FG-123, got ${JSON.stringify(raw)}).`);
  }
  return assertOperand(value, field) ?? value;
}

/** A non-negative integer parsed STRICTLY — never parseInt, under which "2x" is 2 and "1.9"
 *  is 1, so a typo becomes a different valid-looking precondition. */
function integerField(raw: unknown, field: string, min: number): number | PlanningRefusal {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    return refuse(400, `${field} must be an integer >= ${min} (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

/** A bounded prose field (an enqueue note or an annotation body): a string, within the char
 *  cap, no control characters (they would land in a durable operator record and in logs), and
 *  no leading `-`. */
function proseField(raw: unknown, field: string, maxChars: number): string | PlanningRefusal {
  if (typeof raw !== "string") return refuse(400, `${field} must be a string.`);
  if (raw.length > maxChars) return refuse(400, `${field} must be at most ${maxChars} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(raw)) return refuse(400, `${field} must not contain control characters.`);
  return assertOperand(raw, field) ?? raw;
}

function requestIdField(raw: unknown): string | PlanningRefusal {
  if (typeof raw !== "string") return refuse(400, "requestId is required and must be a string.");
  const value = raw.trim();
  if (!REQUEST_ID.test(value)) {
    return refuse(400, `requestId is malformed (1-128 chars, [A-Za-z0-9._:-], no leading "-"), got ${JSON.stringify(raw)}.`);
  }
  return value;
}

// ─── the validated envelope ─────────────────────────────────────────────────────

/** A whole-queue reorder names every id in order; a single-move reorder names one id and its
 *  target 1-based position. The two forms are mutually exclusive. */
export type ReorderOperand =
  | { readonly kind: "full"; readonly order: readonly string[] }
  | { readonly kind: "move"; readonly ticketId: string; readonly to: number };

/**
 * The validated, body-derived half of a planning command. The server COMPLETES this into a
 * full command by attaching the server-authoritative actor / transport / projectKey / timestamp
 * — none of which appear here, by construction. `action` and `requestId` are common to all;
 * the rest is a discriminated union over the closed action vocabulary.
 */
export type PlanningEnvelope =
  | { readonly action: "change-rank"; readonly requestId: string; readonly ticketId: string; readonly reference: string; readonly placement: "before" | "after"; readonly expectVersion: number }
  | { readonly action: "enqueue"; readonly requestId: string; readonly ticketId: string; readonly note?: string }
  | { readonly action: "dequeue"; readonly requestId: string; readonly ticketId: string }
  | { readonly action: "reorder-queue"; readonly requestId: string; readonly expectVersion: number; readonly reorder: ReorderOperand }
  | { readonly action: "append-annotation"; readonly requestId: string; readonly ticketId: string; readonly ticketRevision: number; readonly body: string };

/**
 * Validate a parsed request body into a {@link PlanningEnvelope}, or refuse (fail closed).
 *
 * The body must be a plain JSON object naming a registry action and a requestId, and must NOT
 * carry any server-authoritative key. Everything else is validated per action. Actor, transport,
 * project key and timestamp are the server's to supply and are deliberately unrepresentable here.
 */
export function validatePlanningEnvelope(body: unknown): PlanningEnvelope | PlanningRefusal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(400, "the request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;

  // A client trying to forge server-authoritative identity/scope is refused LOUDLY.
  for (const key of FORBIDDEN_BODY_KEYS) {
    if (Object.hasOwn(input, key)) {
      return refuse(400, `${key} may not be supplied in the request body: it is server-authoritative.`);
    }
  }

  const requestId = requestIdField(input["requestId"]);
  if (isPlanningRefusal(requestId)) return requestId;

  const action = input["action"];
  if (!isRemotePlanningAction(action)) {
    return refuse(400, `action must be one of the closed planning actions (got ${JSON.stringify(action)}).`);
  }

  switch (action) {
    case "change-rank": {
      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isPlanningRefusal(ticketId)) return ticketId;
      const reference = ticketIdField(input["reference"], "reference");
      if (isPlanningRefusal(reference)) return reference;
      const placement = input["placement"];
      if (placement !== "before" && placement !== "after") {
        return refuse(400, `placement must be "before" or "after" (got ${JSON.stringify(placement)}).`);
      }
      if (ticketId === reference) return refuse(400, "a ticket cannot be ranked relative to itself.");
      const expectVersion = integerField(input["expectVersion"], "expectVersion", 0);
      if (isPlanningRefusal(expectVersion)) return expectVersion;
      return { action, requestId, ticketId, reference, placement, expectVersion };
    }

    case "enqueue": {
      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isPlanningRefusal(ticketId)) return ticketId;
      const rawNote = input["note"];
      if (rawNote === undefined || rawNote === null || rawNote === "") {
        return { action, requestId, ticketId };
      }
      const note = proseField(rawNote, "note", MAX_NOTE_CHARS);
      if (isPlanningRefusal(note)) return note;
      return { action, requestId, ticketId, note };
    }

    case "dequeue": {
      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isPlanningRefusal(ticketId)) return ticketId;
      return { action, requestId, ticketId };
    }

    case "reorder-queue": {
      const expectVersion = integerField(input["expectVersion"], "expectVersion", 0);
      if (isPlanningRefusal(expectVersion)) return expectVersion;

      const rawOrder = input["order"];
      const hasOrder = rawOrder !== undefined && rawOrder !== null;
      const hasMove = input["ticketId"] !== undefined || input["to"] !== undefined;
      if (hasOrder && hasMove) {
        return refuse(400, "pass either `order` (the whole queue) or `ticketId` + `to` (one move), never both.");
      }
      if (!hasOrder && !hasMove) {
        return refuse(400, "a reorder must carry either `order` or `ticketId` + `to`.");
      }

      if (hasOrder) {
        if (!Array.isArray(rawOrder) || rawOrder.length === 0) {
          return refuse(400, "order must be a non-empty array of ticket ids.");
        }
        if (rawOrder.length > MAX_ORDER_IDS) {
          return refuse(400, `order must contain at most ${MAX_ORDER_IDS} ticket ids.`);
        }
        const ids: string[] = [];
        for (const [index, raw] of rawOrder.entries()) {
          const id = ticketIdField(raw, `order[${index}]`);
          if (isPlanningRefusal(id)) return id;
          if (ids.includes(id)) return refuse(400, `order lists ${id} more than once.`);
          ids.push(id);
        }
        return { action, requestId, expectVersion, reorder: { kind: "full", order: ids } };
      }

      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isPlanningRefusal(ticketId)) return ticketId;
      const to = integerField(input["to"], "to", 1);
      if (isPlanningRefusal(to)) return to;
      return { action, requestId, expectVersion, reorder: { kind: "move", ticketId, to } };
    }

    case "append-annotation": {
      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isPlanningRefusal(ticketId)) return ticketId;
      const ticketRevision = integerField(input["ticketRevision"], "ticketRevision", 0);
      if (isPlanningRefusal(ticketRevision)) return ticketRevision;
      const bodyText = proseField(input["body"], "body", MAX_ANNOTATION_CHARS);
      if (isPlanningRefusal(bodyText)) return bodyText;
      if (bodyText.trim() === "") return refuse(400, "an annotation body must not be blank.");
      return { action, requestId, ticketId, ticketRevision, body: bodyText };
    }
  }
}
