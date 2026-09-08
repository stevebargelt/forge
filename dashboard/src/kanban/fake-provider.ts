// FG-785: the DETERMINISTIC FAKE reference provider.
//
// This is the reference implementation of the KanbanProvider contract and the substrate every
// sync test drives against. It is fully in-memory, deterministic (no timers, no clock, no
// randomness — external ids come from a monotonic counter), and FAULT-INJECTABLE so tests can
// prove the sync engine's retry / rate-limit / idempotency / conflict behaviour without a
// network. It proves, on its own unit tests, the provider-side half of AC2: create/update/
// archive apply; an injected transient fault surfaces as a retryable signal; a rate-limit
// surfaces as a backoff signal; and a duplicated idempotency key yields exactly one effect.
//
// It also exposes OUT-OF-BAND mutators (`externallyMove`/`externallyEdit`/`externallyDelete`)
// that simulate a human editing the board directly. These feed AC4 conflict detection in the
// sync engine (step 4): the engine reads `getExternalState` and, on drift, records a conflict
// WITHOUT applying the external change. The fake never applies anything inbound — it only
// reflects the drift back through the read surface.

import {
  assertIdempotencyKey,
  capabilityForOp,
  supportsCapability,
  type CapabilityDeclaration,
  type ExternalCardState,
  type ForgeCardIdentity,
  type KanbanCapability,
  type KanbanCardContent,
  type KanbanLane,
  type KanbanProvider,
  type OutboundOperation,
  type OutboundResult,
} from "./adapter.js";

/** A programmed fault the fake returns on the NEXT `apply()` call, then discards. Faults are a
 *  FIFO queue: enqueue several to script a sequence (transient, then rate-limit, then success).
 *  A fault returns its signal WITHOUT mutating board state or consuming the idempotency key, so
 *  a retry of the same op converges to exactly one effect. */
export type ProgrammedFault =
  | { kind: "transient"; message?: string }
  | { kind: "rate-limit"; retryAfterMs: number }
  | { kind: "permanent"; message?: string };

/** The internal record of a card on the fake board. `identity` is the opaque Forge identity;
 *  everything else is presentation/state the fake tracks so `getExternalState` can report drift. */
type StoredCard = {
  externalId: string;
  identity: ForgeCardIdentity;
  laneId: string;
  title: string;
  body: string | null;
  labels: string[];
  archived: boolean;
  deleted: boolean;
  lastAppliedRevision: string;
};

export type FakeProviderOptions = {
  /** Provider name; defaults to "fake". Persisted opaquely by the sync engine. */
  name?: string;
  /** Capabilities this fake does NOT support — lets a test prove the `unsupported` outcome. */
  unsupported?: readonly KanbanCapability[];
  /** Initial lanes. Defaults to a small backlog/in-progress/done set. */
  lanes?: readonly KanbanLane[];
};

const DEFAULT_LANES: readonly KanbanLane[] = [
  { id: "backlog", name: "Backlog" },
  { id: "in-progress", name: "In Progress" },
  { id: "done", name: "Done" },
];

export class FakeKanbanProvider implements KanbanProvider {
  readonly name: string;
  private readonly unsupported: readonly KanbanCapability[];
  private readonly lanes: KanbanLane[];

  /** externalId → card. The board. */
  private readonly cards = new Map<string, StoredCard>();
  /** idempotencyKey → externalId. The dedup ledger that makes duplicate delivery a no-op. */
  private readonly appliedKeys = new Map<string, string>();
  /** Programmed faults, consumed one per apply() (FIFO). */
  private readonly faults: ProgrammedFault[] = [];
  /** Monotonic external-id counter — deterministic, no randomness. */
  private seq = 0;
  /** Observability for tests: how many real effects (not dedup/faults) have landed. */
  private effectCount = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.name = options.name ?? "fake";
    this.unsupported = options.unsupported ?? [];
    this.lanes = (options.lanes ?? DEFAULT_LANES).map((l) => ({ ...l }));
  }

  capabilities(): CapabilityDeclaration {
    return { unsupported: [...this.unsupported] };
  }

  async listLanes(): Promise<KanbanLane[]> {
    return this.lanes.map((l) => ({ ...l }));
  }

  async apply(op: OutboundOperation): Promise<OutboundResult> {
    // Contract first: an empty idempotency key is a caller bug, thrown, never a soft outcome.
    assertIdempotencyKey(op);

    // Capability gate: refuse an op targeting a capability we declared unsupported. Explicit
    // outcome, never a silent success (the provider does not pretend).
    const cap = capabilityForOp(op.kind);
    if (!supportsCapability(this.capabilities(), cap)) {
      return { status: "unsupported", capability: cap, retryable: false };
    }

    // Fault injection: consume one programmed fault, if any. Returns WITHOUT mutating state or
    // recording the idempotency key, so the retry that follows converges to one effect.
    const fault = this.faults.shift();
    if (fault) {
      if (fault.kind === "transient") {
        return { status: "transient-error", message: fault.message ?? "injected transient fault", retryable: true };
      }
      if (fault.kind === "rate-limit") {
        return { status: "rate-limited", retryAfterMs: fault.retryAfterMs, retryable: true };
      }
      return { status: "permanent-error", message: fault.message ?? "injected permanent fault", retryable: false };
    }

    // Idempotency: a key we have already applied returns the SAME external id and no new effect.
    const priorExternalId = this.appliedKeys.get(op.idempotencyKey);
    if (priorExternalId !== undefined) {
      const prior = this.cards.get(priorExternalId);
      const identity = prior ? prior.identity : this.identityForOp(op);
      return { status: "deduplicated", externalId: priorExternalId, identity };
    }

    switch (op.kind) {
      case "create":
        return this.applyCreate(op.idempotencyKey, op.content);
      case "update":
        return this.applyUpdate(op.idempotencyKey, op.externalId, op.content);
      case "archive":
        return this.applyArchive(op.idempotencyKey, op.externalId, op.identity, op.projectionRevision);
    }
  }

  async getExternalState(externalIds: readonly string[]): Promise<ExternalCardState[]> {
    return externalIds.map((externalId) => {
      const card = this.cards.get(externalId);
      if (!card || card.deleted) {
        return {
          externalId,
          identity: card ? card.identity : null,
          laneId: card?.laneId ?? "",
          title: card?.title ?? "",
          body: card?.body ?? null,
          labels: card ? [...card.labels] : [],
          archived: card?.archived ?? false,
          deleted: true,
          lastAppliedRevision: card?.lastAppliedRevision ?? null,
        };
      }
      return {
        externalId: card.externalId,
        identity: card.identity,
        laneId: card.laneId,
        title: card.title,
        body: card.body,
        labels: [...card.labels],
        archived: card.archived,
        deleted: false,
        lastAppliedRevision: card.lastAppliedRevision,
      };
    });
  }

  // ─── fault + inspection controls (test-facing) ────────────────────────────────────

  /** Enqueue a fault to be returned on the next apply() call. */
  injectFault(fault: ProgrammedFault): void {
    this.faults.push(fault);
  }

  /** Total number of REAL effects (create/update/archive) that have landed — never counts a
   *  deduplicated delivery or a faulted call. Lets a test assert "exactly one effect". */
  totalEffects(): number {
    return this.effectCount;
  }

  /** Number of non-deleted cards on the board — the duplicate-detection assertion surface. */
  cardCount(): number {
    let n = 0;
    for (const card of this.cards.values()) if (!card.deleted) n++;
    return n;
  }

  /** All live cards, for assertions. Copies, so a test cannot mutate the board through them. */
  snapshot(): StoredCard[] {
    return [...this.cards.values()].filter((c) => !c.deleted).map((c) => ({ ...c, labels: [...c.labels] }));
  }

  // ─── out-of-band external mutators (simulate a human editing the board — AC4 groundwork) ──

  /** Simulate an external actor moving a card to another lane. */
  externallyMove(externalId: string, laneId: string): void {
    const card = this.cards.get(externalId);
    if (card && !card.deleted) card.laneId = laneId;
  }

  /** Simulate an external actor editing a card's presentation. */
  externallyEdit(externalId: string, edit: { title?: string; body?: string | null; labels?: string[] }): void {
    const card = this.cards.get(externalId);
    if (!card || card.deleted) return;
    if (edit.title !== undefined) card.title = edit.title;
    if (edit.body !== undefined) card.body = edit.body;
    if (edit.labels !== undefined) card.labels = [...edit.labels];
  }

  /** Simulate an external actor deleting a card. `getExternalState` reports it deleted. */
  externallyDelete(externalId: string): void {
    const card = this.cards.get(externalId);
    if (card) card.deleted = true;
  }

  // ─── internals ────────────────────────────────────────────────────────────────────

  private applyCreate(idempotencyKey: string, content: KanbanCardContent): OutboundResult {
    const externalId = `fake-card-${++this.seq}`;
    this.cards.set(externalId, {
      externalId,
      identity: { ...content.identity },
      laneId: content.laneId,
      title: content.title,
      body: content.body,
      labels: [...content.labels],
      archived: false,
      deleted: false,
      lastAppliedRevision: content.projectionRevision,
    });
    this.appliedKeys.set(idempotencyKey, externalId);
    this.effectCount++;
    return {
      status: "applied",
      externalId,
      effect: "created",
      identity: { ...content.identity },
      projectionRevision: content.projectionRevision,
    };
  }

  private applyUpdate(idempotencyKey: string, externalId: string, content: KanbanCardContent): OutboundResult {
    const card = this.cards.get(externalId);
    if (!card || card.deleted) {
      // The card the update targets is gone externally — a permanent (non-retryable) error the
      // sync engine reads as drift; it records a conflict rather than resurrecting the card.
      return { status: "permanent-error", message: `card ${externalId} not found`, retryable: false };
    }
    card.laneId = content.laneId;
    card.title = content.title;
    card.body = content.body;
    card.labels = [...content.labels];
    card.lastAppliedRevision = content.projectionRevision;
    this.appliedKeys.set(idempotencyKey, externalId);
    this.effectCount++;
    return {
      status: "applied",
      externalId,
      effect: "updated",
      identity: { ...card.identity },
      projectionRevision: content.projectionRevision,
    };
  }

  private applyArchive(
    idempotencyKey: string,
    externalId: string,
    identity: ForgeCardIdentity,
    projectionRevision: string,
  ): OutboundResult {
    const card = this.cards.get(externalId);
    if (!card || card.deleted) {
      return { status: "permanent-error", message: `card ${externalId} not found`, retryable: false };
    }
    card.archived = true;
    card.lastAppliedRevision = projectionRevision;
    this.appliedKeys.set(idempotencyKey, externalId);
    this.effectCount++;
    return {
      status: "applied",
      externalId,
      effect: "archived",
      identity: { ...identity },
      projectionRevision,
    };
  }

  /** Best-effort identity recovery for a deduplicated op whose card is no longer present. */
  private identityForOp(op: OutboundOperation): ForgeCardIdentity {
    if (op.kind === "archive") return { ...op.identity };
    return { ...op.content.identity };
  }
}
