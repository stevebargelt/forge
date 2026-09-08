// FG-785: the PROVIDER-NEUTRAL external-kanban adapter CONTRACT.
//
// WHY THIS MODULE EXISTS. Forge projects planning state onto an external kanban board
// (Trello, a GitHub Project, a self-hosted board, …) ONE WAY: Forge is the source of truth,
// the external board is a downstream projection. This module is the seam between the two. It
// declares the vocabulary — lanes, cards, outbound operations — and the behavioural contract
// every concrete provider must honour, WITHOUT any provider-specific concept (a Trello list
// id, a GitHub column node id, an API base URL) leaking back toward Forge. A provider is
// named only by an opaque `name` string; that string is the only provider fact Forge persists
// (FG-785 AC1: no provider concept enters any Forge lifecycle table).
//
// OUTBOUND-ONLY (deliberate, per backlog/PLAN.md). This release ships a one-way projection.
// The contract carries NO inbound write path: there is no method here that applies an
// external edit back onto Forge planning state. The read surface (`getExternalState`) exists
// solely to DETECT external drift so the sync engine can record a CONFLICT — it never returns
// a value that mutates Forge. Inbound is a later, additive addition that must ride FG-783's
// authenticated, revision-bound planning-command contract; when it lands it will be a NEW,
// separately-declared capability on a provider, and it must not change any outbound semantics
// defined here. The "Extending inbound" note at the bottom of this file marks the seam.
//
// IDENTITY DISCIPLINE (AC1). Every card carries an OPAQUE Forge identity — a project key plus
// a ticket id. That pair, and only that pair, identifies a card. A card's lane (column
// position), title, body, and labels are PRESENTATION; they are never identity. A provider
// echoes the identity back so the sync engine can reconcile without ever treating a renamed
// or moved card as a new one. `projectionRevision` is the version of the projected content a
// card reflects (the sync engine's incremental-change signal); it too is never identity.
//
// SIGNALLING DISCIPLINE. Expected provider conditions — a rate limit, a transient outage, an
// unsupported capability, a duplicate delivery — are returned as DATA (`OutboundResult`), not
// thrown. `apply()` is therefore a total function the sync engine can branch on without a
// try/catch: it decides retry-vs-backoff-vs-conflict from the result's discriminant. Thrown
// errors are reserved for programmer/contract violations (a missing idempotency key), which a
// retry must NOT paper over — those surface as `KanbanContractError`.

// ─── identity + content ───────────────────────────────────────────────────────────

/** The opaque Forge identity every projected card carries. This pair is the ONLY identity;
 *  lane/title/body/labels are presentation and never identify a card (AC1). */
export type ForgeCardIdentity = {
  projectKey: string;
  ticketId: string;
};

/** A lane (column) on the external board. `id` is provider-local; `name` is presentation. */
export type KanbanLane = {
  id: string;
  name: string;
};

/** The provider-neutral content of a projected card. Assembled by the sync engine from the
 *  FG-781 remote projection (already allowlisted + redacted), never from raw store rows. */
export type KanbanCardContent = {
  /** Opaque Forge identity — the durable handle across renames/moves (AC1). */
  identity: ForgeCardIdentity;
  /** Target lane. This is POSITION, not identity — an external move does not change the card. */
  laneId: string;
  title: string;
  body: string | null;
  labels: readonly string[];
  /** The projected content revision this card reflects (the sync engine's incremental signal —
   *  a content hash or monotonic revision). Neutral to the provider; never identity. */
  projectionRevision: string;
};

// ─── capability declaration ─────────────────────────────────────────────────────────

/** The closed vocabulary of capabilities a provider may or may not support. */
export const KANBAN_CAPABILITIES = ["create", "update", "archive", "lanes", "labels", "body"] as const;
export type KanbanCapability = (typeof KANBAN_CAPABILITIES)[number];

/** A provider states what it does NOT support, rather than silently pretending. Any capability
 *  ABSENT from `unsupported` is a COMMITMENT that the provider honours it. The sync engine
 *  consults this before projecting, so an archive against an archive-less board becomes an
 *  explicit `unsupported` outcome, not a silent no-op or a fabricated success. */
export type CapabilityDeclaration = {
  unsupported: readonly KanbanCapability[];
};

/** True when `cap` is NOT listed as unsupported (i.e. the provider commits to it). */
export function supportsCapability(declaration: CapabilityDeclaration, cap: KanbanCapability): boolean {
  return !declaration.unsupported.includes(cap);
}

// ─── outbound operations ────────────────────────────────────────────────────────────

export type OutboundOpKind = "create" | "update" | "archive";

/** An outbound operation. EVERY variant carries a required `idempotencyKey`: a stable string
 *  the sync engine derives from (identity + operation + projectionRevision) so a retried or
 *  duplicated delivery is recognised and collapsed to one effect. An empty key is a contract
 *  violation (see `assertIdempotencyKey`), not a provider-recoverable condition. */
export type OutboundOperation =
  | { kind: "create"; idempotencyKey: string; content: KanbanCardContent }
  | { kind: "update"; idempotencyKey: string; externalId: string; content: KanbanCardContent }
  | {
      kind: "archive";
      idempotencyKey: string;
      externalId: string;
      identity: ForgeCardIdentity;
      /** The revision at which the archive was decided — recorded as provenance, not identity. */
      projectionRevision: string;
    };

/** The concrete mutation an `applied` result performed. */
export type OutboundEffect = "created" | "updated" | "archived";

/** The total set of outcomes `apply()` can report. Only `applied` and `deduplicated` name a
 *  card; the `*-error`/`rate-limited`/`unsupported` variants carry no external id mutation.
 *  `retryable` is stated explicitly on every non-terminal outcome so the sync engine never has
 *  to infer it. */
export type OutboundResult =
  | {
      status: "applied";
      externalId: string;
      effect: OutboundEffect;
      identity: ForgeCardIdentity;
      projectionRevision: string;
    }
  /** The idempotency key was already applied — the effect happened on an earlier delivery. The
   *  same external id is returned; NO second effect occurs (AC2 duplicate-delivery). */
  | { status: "deduplicated"; externalId: string; identity: ForgeCardIdentity }
  /** The provider is rate-limiting. `retryAfterMs` is the backoff floor the provider asks for;
   *  the sync engine's retry policy MAY wait at least this long. Always retryable. */
  | { status: "rate-limited"; retryAfterMs: number; retryable: true }
  /** A transient provider/network fault. Retryable — a later delivery of the SAME idempotency
   *  key is expected to converge. */
  | { status: "transient-error"; message: string; retryable: true }
  /** The operation targets a capability the provider declared unsupported. Never retryable —
   *  retrying cannot make an unsupported capability supported. */
  | { status: "unsupported"; capability: KanbanCapability; retryable: false }
  /** A terminal provider error (bad request, permission). Never retryable. */
  | { status: "permanent-error"; message: string; retryable: false };

/** The read-back state of a previously-projected card, used ONLY to detect external drift for
 *  conflict recording (AC4). It is NEVER applied to Forge. `identity` is null when the provider
 *  could not preserve/echo the opaque identity (e.g. the card was deleted externally). */
export type ExternalCardState = {
  externalId: string;
  identity: ForgeCardIdentity | null;
  laneId: string;
  title: string;
  body: string | null;
  labels: readonly string[];
  archived: boolean;
  /** True when the card no longer exists on the external board (deleted out-of-band). */
  deleted: boolean;
  /** The projectionRevision the provider recorded from the last outbound op it accepted, if it
   *  tracks one — the baseline the sync engine diffs external drift against. */
  lastAppliedRevision: string | null;
};

// ─── the provider interface ─────────────────────────────────────────────────────────

/** A concrete external-board adapter. Provider-neutral: no method exposes a provider-specific
 *  type, and the only provider identity Forge sees is `name` (an opaque string persisted in the
 *  kanban_projection_map row — never in a lifecycle table). */
export interface KanbanProvider {
  /** Opaque provider name (e.g. "fake", "trello"). The only provider fact Forge persists. */
  readonly name: string;

  /** What this provider does NOT support. Consulted before every outbound op. */
  capabilities(): CapabilityDeclaration;

  /** The lanes the board currently exposes. */
  listLanes(): Promise<KanbanLane[]>;

  /** Apply one outbound operation. Total function: expected provider conditions are returned
   *  as `OutboundResult` data, never thrown. Throws only on a contract violation (empty
   *  idempotency key → `KanbanContractError`). */
  apply(op: OutboundOperation): Promise<OutboundResult>;

  /** Read current external state for previously-projected cards, to DETECT drift for conflict
   *  recording (AC4). This is the ONLY read path and it never mutates Forge — there is no
   *  inbound write method on this interface by design (outbound-only, this release). */
  getExternalState(externalIds: readonly string[]): Promise<ExternalCardState[]>;
}

// ─── contract guards ────────────────────────────────────────────────────────────────

/** Thrown when a caller violates the contract (as opposed to a provider-side condition, which
 *  is returned as an `OutboundResult`). A retry must NOT swallow these. */
export class KanbanContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KanbanContractError";
  }
}

/** Enforce the "idempotency key required on every outbound operation" rule at runtime — TS
 *  cannot forbid an empty string. Every provider implementation calls this first. */
export function assertIdempotencyKey(op: OutboundOperation): void {
  if (typeof op.idempotencyKey !== "string" || op.idempotencyKey.trim() === "") {
    throw new KanbanContractError(`outbound ${op.kind} operation is missing a required non-empty idempotencyKey`);
  }
}

/** Map an outbound op kind to the capability it requires, so a provider can uniformly refuse
 *  an op that targets an unsupported capability. */
export function capabilityForOp(kind: OutboundOpKind): KanbanCapability {
  return kind;
}

// ─── Extending inbound (NOT shipped this release) ─────────────────────────────────────
//
// When inbound sync is added (FG-783-bound), it arrives ADDITIVELY and must not touch any type
// above. The expected shape: a SEPARATE optional interface a provider may also implement —
//
//   export interface InboundKanbanProvider extends KanbanProvider {
//     // Pull external changes as REVISION-BOUND, AUTHENTICATED planning commands — never a raw
//     // apply. The engine that consumes them enforces FG-783's authorization + revision guard.
//     pullInbound(since: string): Promise<InboundPlanningCommand[]>;
//   }
//
// The outbound `OutboundOperation` / `OutboundResult` / `apply()` semantics stay frozen. Until
// then there is NO inbound path anywhere in this module or its consumers.
