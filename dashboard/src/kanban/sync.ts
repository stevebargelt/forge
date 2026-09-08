// FG-785: the HOST-SIDE OUTBOUND SYNC ENGINE.
//
// WHAT IT DOES. Projects Forge planning state onto an external kanban board ONE WAY: Forge is
// the source of truth, the board is a downstream projection. The engine is deliberately PURE —
// it takes an already-assembled FG-781 RemoteBoard as its ONLY card-data source, a KanbanProvider
// to push to, and an injected store PORT for its own two tables. It performs NO raw store queries
// for card content and it writes NOTHING but the kanban_projection_map / kanban_conflicts tables
// through that port, so by construction a sync can never reorder or mutate a Forge lifecycle row
// (AC3). Because the card data is the RemoteBoard, the same FG-781 allowlist + redaction seal that
// protects the Remote Board protects the external board too — no host path, cross-project row, or
// credential can reach a card here that could not already reach the Remote Board.
//
// WHY A RemoteBoard, NOT THE STORE. Accepting `RemoteBoard` (the output of assembleRemoteBoard)
// as input is the structural guarantee behind "reuse assembleRemoteBoard / the to* mappers, never
// raw queries". cli-entry.ts is the ONE place that calls assembleRemoteBoard and hands the result
// here; the engine itself cannot see a raw ticket/queue row.
//
// INCREMENTAL. Each projected card is hashed (its provider-neutral presentation). A card whose
// hash already equals kanban_projection_map.last_projected_hash is SKIPPED — only changed-hash
// cards are pushed. A repeated sync with no Forge change therefore pushes nothing and converges:
// no duplicate cards, stable identity (AC3).
//
// IDEMPOTENT + RETRYABLE + RATE-LIMITED. Every outbound op carries a stable idempotency key
// derived from (provider, kind, identity, revision), so a retried or duplicated delivery collapses
// to one effect (AC2). Expected provider conditions (transient fault, rate limit) are returned as
// OutboundResult DATA and handled by a bounded backoff loop; a duplicate delivery is a no-op.
//
// EXTERNAL DRIFT → CONFLICT, NEVER APPLIED (AC4). Before projecting, the engine reads the current
// external state of every previously-projected active card. If the board was edited out of band
// (moved / edited / deleted) since our last push, it records a bounded kanban_conflicts row
// carrying BOTH versions and SKIPS that card's outbound op for this sync — it never repairs or
// applies the external change back onto anything. The conflict persists until an authorized
// resolution (step 6 CLI); the engine never resolves one.
//
// A NOTE ON BACKOFF REUSE. The plan asked the engine to reuse @forge/retry's backoff. That alias
// resolves to src/v2/retry.ts — the FAILED-TASK retry subsystem (mint a replacement task row) —
// and its sibling src/v2/retry-policy.ts is the per-failure-kind disposition table. Neither
// exposes a generic delay/backoff primitive an outbound-op loop could call. Rather than fabricate
// a dependency, the engine implements a small, bounded, injectable backoff below; the alias stays
// wired for the store accessors it genuinely needs. (Surfaced as a plan-defect note in the task
// result.)

import { createHash } from "node:crypto";
import type {
  ForgeCardIdentity as ForgeStoreIdentity,
  InsertConflictInput,
  KanbanConflict,
  KanbanConflictKind,
  ProjectionMapRow,
  UpsertProjectionMapInput,
} from "@forge/kanban-projection";
import { redactRemoteFreeText } from "../remote/projection.js";
import type { RemoteBoard } from "../remote/projection.js";
import type {
  ExternalCardState,
  KanbanCardContent,
  KanbanProvider,
  OutboundOperation,
  OutboundResult,
} from "./adapter.js";

// ─── the store PORT ─────────────────────────────────────────────────────────────────
//
// Exactly the four @forge/kanban-projection accessors the engine needs, as an injectable
// interface. The integration test and cli-entry pass the real module's functions; the unit
// test passes an in-memory fake — which is what keeps sync.test.ts process- and DB-free. The
// engine writes ONLY through this port and the port names ONLY the two FG-785 tables, so there
// is no reachable path from here to a lifecycle table.

export interface KanbanSyncStore {
  getProjectionMap(identity: ForgeStoreIdentity): ProjectionMapRow | undefined;
  listProjectionMap(projectIdentity: string, provider: string): ProjectionMapRow[];
  upsertProjectionMap(input: UpsertProjectionMapInput): void;
  insertConflict(input: InsertConflictInput): void;
  /** Read one conflict (open or resolved) by id, or undefined. RF-2: the engine consults this to
   *  reopen a FRESH conflict generation when a divergence recurs after an authorized resolution,
   *  instead of colliding with the resolved row (insertConflict is ON CONFLICT(id) DO NOTHING). */
  getConflict(id: string): KanbanConflict | undefined;
}

// ─── config + result ──────────────────────────────────────────────────────────────

/** A bounded backoff policy. `maxAttempts` counts the FIRST try, so `1` means no retry. */
export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  /** Exponential factor applied per retry (delay = base * factor^retryIndex). */
  factor: number;
  /** Hard ceiling on any single wait, so a large provider `retryAfterMs` cannot hang a sync. */
  maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 200,
  factor: 2,
  maxDelayMs: 5_000,
};

export type SyncConfig = {
  /** The OPAQUE Forge project identity persisted in the map/conflict rows. Must be the board's
   *  own projectKey — the engine asserts this so a card can never be keyed to a foreign project. */
  projectIdentity: string;
  /** The opaque provider name (KanbanProvider.name), persisted opaquely — never a lifecycle table. */
  provider: string;
  /** Write provenance: who/what produced each card write and detected each conflict (AC: provenance
   *  recorded). NEVER a credential — an opaque actor label like "kanban-sync@host". */
  projectedBy: string;
  detectedBy: string;
  /** Caller-supplied clock (the accessors are clock-free by design). Returns an ISO timestamp. */
  now: () => string;
  /** Bounded backoff policy; defaults to DEFAULT_RETRY_POLICY. */
  retry?: RetryPolicy;
  /** Injectable delay so a test proves backoff without real time. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

/** A per-card outcome, for the summary and for tests to assert on. */
export type CardOutcome = {
  ticketId: string;
  action: "created" | "updated" | "archived" | "skipped" | "conflict" | "unsupported" | "error";
  externalId?: string;
  /** How many provider.apply attempts this card consumed (retries included). */
  attempts?: number;
  /** Total backoff waited for this card, ms — the rate-limit/backoff evidence surface. */
  waitedMs?: number;
  conflictKind?: KanbanConflictKind;
  message?: string;
};

export type SyncResult = {
  projectIdentity: string;
  provider: string;
  created: number;
  updated: number;
  archived: number;
  skipped: number;
  conflicts: number;
  unsupported: number;
  errors: number;
  /** Cards examined this sync (projected + archive candidates). */
  cardsExamined: number;
  outcomes: CardOutcome[];
};

// ─── card projection (the FG-781 RemoteBoard is the ONLY source) ────────────────────

/** The provider-neutral card content for one board ticket, PLUS the content hash used both as
 *  the incremental signal and as the card's projectionRevision. Split out so drift detection can
 *  recompute a hash over external state with the identical function. */
function cardContentHash(fields: {
  projectKey: string;
  ticketId: string;
  laneId: string;
  title: string;
  body: string | null;
  labels: readonly string[];
}): string {
  // Stable, field-ordered serialization — labels copied so a caller's array identity can't leak
  // in, and the object shape is fixed so the hash is reproducible across processes.
  const canonical = JSON.stringify({
    projectKey: fields.projectKey,
    ticketId: fields.ticketId,
    laneId: fields.laneId,
    title: fields.title,
    body: fields.body,
    labels: [...fields.labels],
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Project the FG-781 RemoteBoard into provider-neutral cards — one per backlog ticket, with its
 *  lane taken from the queue projection's view (the kanban column) when present, else the ticket
 *  status. Body is deliberately null: the FG-781 seal already excludes ticket bodies from the
 *  remote projection, so there is none to carry, and this keeps the outbound card strictly within
 *  the sealed surface. Titles arrive already redacted from the RemoteBoard. */
export function projectBoardToCards(board: RemoteBoard): KanbanCardContent[] {
  const projectKey = board.projectSummary.projectKey;
  const laneByTicket = new Map<string, string>();
  for (const row of board.queue.rows) laneByTicket.set(row.ticketId, row.view);

  return board.backlog.tickets.map((ticket) => {
    const laneId = laneByTicket.get(ticket.id) ?? ticket.status;
    const labels = [ticket.type, ticket.status];
    const revision = cardContentHash({
      projectKey,
      ticketId: ticket.id,
      laneId,
      title: ticket.title,
      body: null,
      labels,
    });
    return {
      identity: { projectKey, ticketId: ticket.id },
      laneId,
      title: ticket.title,
      body: null,
      labels,
      projectionRevision: revision,
    };
  });
}

// ─── idempotency key derivation ─────────────────────────────────────────────────────

/** A stable idempotency key for an outbound op: (provider, kind, project, ticket, revision). A
 *  retry of the same op — or a duplicate delivery — derives the SAME key, so the provider collapses
 *  it to one effect (AC2). The revision is included so a genuinely new content revision is a new
 *  op, not a silent dedup of the prior one. */
export function idempotencyKeyFor(
  provider: string,
  kind: OutboundOperation["kind"],
  projectKey: string,
  ticketId: string,
  revision: string,
): string {
  return `${provider}:${kind}:${projectKey}:${ticketId}:${revision}`;
}

// ─── the bounded, injectable backoff loop ───────────────────────────────────────────

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ApplyOutcome = { result: OutboundResult; attempts: number; waitedMs: number };

/** Apply one op, retrying the retryable outcomes (transient-error / rate-limited) under bounded
 *  exponential backoff. A rate-limit's `retryAfterMs` raises the wait floor (clamped to the
 *  policy ceiling). Non-retryable outcomes (applied / deduplicated / unsupported / permanent) return
 *  immediately. Exhausting the attempt budget returns the LAST result — the caller records it as an
 *  error and the NEXT sync re-attempts the same idempotency key and converges. */
async function applyWithRetry(
  provider: KanbanProvider,
  op: OutboundOperation,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void>,
): Promise<ApplyOutcome> {
  let attempts = 0;
  let waitedMs = 0;
  let last: OutboundResult | undefined;

  for (let i = 0; i < policy.maxAttempts; i++) {
    attempts++;
    last = await provider.apply(op);
    if (last.status !== "transient-error" && last.status !== "rate-limited") {
      return { result: last, attempts, waitedMs };
    }
    // Retryable. If this was the final attempt, stop — no point sleeping before giving up.
    if (i === policy.maxAttempts - 1) break;
    const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(policy.factor, i));
    const floor = last.status === "rate-limited" ? last.retryAfterMs : 0;
    const wait = Math.min(policy.maxDelayMs, Math.max(backoff, floor));
    waitedMs += wait;
    await sleep(wait);
  }
  return { result: last!, attempts, waitedMs };
}

// ─── drift detection ────────────────────────────────────────────────────────────────

/** Classify external drift for a previously-projected card, or undefined when the external state
 *  still matches what we last pushed. `deleted` short-circuits; otherwise a hash of the external
 *  presentation is compared to the map row's last_projected_hash. A mismatch is drift: `moved` when
 *  the external lane differs from the Forge-canonical lane, else `edited`. */
function classifyDrift(
  row: ProjectionMapRow,
  ext: ExternalCardState,
  canonical: KanbanCardContent | undefined,
): KanbanConflictKind | undefined {
  if (ext.deleted) return "deleted";
  const externalHash = cardContentHash({
    projectKey: row.projectIdentity,
    ticketId: row.ticketIdentity,
    laneId: ext.laneId,
    title: ext.title,
    body: ext.body,
    labels: ext.labels,
  });
  if (externalHash === row.lastProjectedHash) return undefined; // still matches our last push
  if (canonical && ext.laneId !== canonical.laneId) return "moved";
  return "edited";
}

// ─── the engine ───────────────────────────────────────────────────────────────────

/** Run one outbound sync of `board` onto `provider`, persisting identity/provenance and conflicts
 *  through `store`. Pure host-side: performs no raw store query and writes only the two FG-785
 *  tables via the port. See the module header for the full contract. */
export async function syncBoardOutbound(
  board: RemoteBoard,
  provider: KanbanProvider,
  store: KanbanSyncStore,
  config: SyncConfig,
): Promise<SyncResult> {
  const policy = config.retry ?? DEFAULT_RETRY_POLICY;
  const sleep = config.sleep ?? realSleep;
  const provName = config.provider;

  if (board.projectSummary.projectKey !== config.projectIdentity) {
    // The card identity is the OPAQUE Forge (project, ticket) pair; a board whose projectKey does
    // not match the configured project identity would key cards to a foreign project. Refuse.
    throw new Error(
      `kanban sync: board projectKey '${board.projectSummary.projectKey}' does not match ` +
        `configured projectIdentity '${config.projectIdentity}'`,
    );
  }

  const cards = projectBoardToCards(board);
  const cardByTicket = new Map<string, KanbanCardContent>();
  for (const card of cards) cardByTicket.set(card.identity.ticketId, card);

  const existing = store.listProjectionMap(config.projectIdentity, provName);
  const existingByTicket = new Map<string, ProjectionMapRow>();
  for (const row of existing) existingByTicket.set(row.ticketIdentity, row);
  const activeRows = existing.filter((r) => r.projectionState === "active");

  const result: SyncResult = {
    projectIdentity: config.projectIdentity,
    provider: provName,
    created: 0,
    updated: 0,
    archived: 0,
    skipped: 0,
    conflicts: 0,
    unsupported: 0,
    errors: 0,
    cardsExamined: 0,
    outcomes: [],
  };

  const storeIdentity = (ticketId: string): ForgeStoreIdentity => ({
    projectIdentity: config.projectIdentity,
    ticketIdentity: ticketId,
    provider: provName,
  });

  // ── 1. Drift detection (AC4). Read current external state of every active mapped card; record a
  // conflict for any that drifted, and mark its ticket so the reconcile/archive passes leave it
  // alone this sync. Recording is ALL that happens — nothing is applied back. ──
  const conflictedTickets = new Set<string>();
  if (activeRows.length > 0) {
    const externalStates = await provider.getExternalState(activeRows.map((r) => r.externalCardId));
    const byExternalId = new Map<string, ExternalCardState>();
    for (const state of externalStates) byExternalId.set(state.externalId, state);

    for (const row of activeRows) {
      const ext = byExternalId.get(row.externalCardId);
      if (!ext) continue; // provider returned nothing for this id — nothing to compare, no drift claim
      const canonical = cardByTicket.get(row.ticketIdentity);
      const drift = classifyDrift(row, ext, canonical);
      if (!drift) continue;

      conflictedTickets.add(row.ticketIdentity);
      const externalVersion = {
        externalId: ext.externalId,
        laneId: ext.laneId,
        title: ext.title,
        body: ext.body,
        labels: [...ext.labels],
        archived: ext.archived,
        deleted: ext.deleted,
        lastAppliedRevision: ext.lastAppliedRevision,
      };
      const forgeVersion = canonical
        ? {
            ticketId: canonical.identity.ticketId,
            laneId: canonical.laneId,
            title: canonical.title,
            body: canonical.body,
            labels: [...canonical.labels],
            projectionRevision: canonical.projectionRevision,
          }
        : { ticketId: row.ticketIdentity, lastProjectedHash: row.lastProjectedHash };

      // Reopen-safe conflict id (RF-2). The base is deterministic per logical drift, so a repeat
      // of a still-OPEN divergence collapses to a no-op (ON CONFLICT DO NOTHING) and never
      // duplicates. But a divergence that recurs AFTER an authorized resolution must NOT reuse the
      // now-RESOLVED row's id — DO NOTHING would silently swallow it, leaving the ticket skipped
      // forever with no OPEN conflict to act on. Walk generations until the id is either unused
      // (mint a fresh OPEN row) or already OPEN (the same live divergence — dedup still holds); a
      // resolved generation is stepped over, reopening the divergence as a new actionable conflict.
      const conflictBase = `${provName}:${config.projectIdentity}:${row.ticketIdentity}:${row.externalCardId}:${drift}`;
      let generation = 0;
      let conflictId = `${conflictBase}:g${generation}`;
      for (;;) {
        const prior = store.getConflict(conflictId);
        if (prior === undefined || prior.state === "open") break;
        conflictId = `${conflictBase}:g${++generation}`;
      }
      const at = config.now();
      store.insertConflict({
        id: conflictId,
        projectIdentity: config.projectIdentity,
        ticketIdentity: row.ticketIdentity,
        provider: provName,
        externalCardId: row.externalCardId,
        kind: drift,
        forgeVersion,
        externalVersion,
        detectedBy: config.detectedBy,
        detectedAt: at,
        createdAt: at,
      });
      result.conflicts++;
      result.outcomes.push({
        ticketId: row.ticketIdentity,
        action: "conflict",
        externalId: row.externalCardId,
        conflictKind: drift,
      });
    }
  }

  // ── 2. Reconcile creates/updates, incrementally. Skip conflicted tickets and unchanged-hash
  // cards. ──
  for (const card of cards) {
    result.cardsExamined++;
    const ticketId = card.identity.ticketId;
    if (conflictedTickets.has(ticketId)) {
      result.skipped++;
      continue; // a conflict was recorded; do not project over the drifted card this sync
    }
    const row = existingByTicket.get(ticketId);
    if (row && row.projectionState === "active" && row.lastProjectedHash === card.projectionRevision) {
      result.skipped++;
      result.outcomes.push({ ticketId, action: "skipped", externalId: row.externalCardId });
      continue; // incremental: unchanged since last push
    }

    // RF-1: a ticket that RETURNS after its card was archived must not be projected as an update
    // of the archived external card — that would leave an active map row pointing at an archived
    // card (an update never clears the external archived flag). Treat the re-appearance as a fresh
    // CREATE of a new active card, retiring the old archived mapping. The create key is salted with
    // the retired external id so identical returning content does not dedup back to the ORIGINAL
    // create (whose idempotency key the provider still remembers, pointing at the archived card).
    const isArchivedReturn = row !== undefined && row.projectionState === "archived";
    const isCreate = row === undefined || isArchivedReturn;
    const createRevision = isArchivedReturn
      ? `${card.projectionRevision}:recreate:${row!.externalCardId}`
      : card.projectionRevision;
    const op: OutboundOperation = isCreate
      ? {
          kind: "create",
          idempotencyKey: idempotencyKeyFor(provName, "create", config.projectIdentity, ticketId, createRevision),
          content: card,
        }
      : {
          kind: "update",
          idempotencyKey: idempotencyKeyFor(provName, "update", config.projectIdentity, ticketId, card.projectionRevision),
          externalId: row!.externalCardId,
          content: card,
        };

    const { result: res, attempts, waitedMs } = await applyWithRetry(provider, op, policy, sleep);
    if (res.status === "applied" || res.status === "deduplicated") {
      const externalId = res.externalId;
      const at = config.now();
      store.upsertProjectionMap({
        projectIdentity: config.projectIdentity,
        ticketIdentity: ticketId,
        provider: provName,
        externalCardId: externalId,
        projectionState: "active",
        lastProjectedHash: card.projectionRevision,
        projectedBy: config.projectedBy,
        projectedAt: at,
        createdAt: row?.createdAt ?? at,
      });
      if (isCreate) result.created++;
      else result.updated++;
      result.outcomes.push({ ticketId, action: isCreate ? "created" : "updated", externalId, attempts, waitedMs });
    } else if (res.status === "unsupported") {
      result.unsupported++;
      result.outcomes.push({ ticketId, action: "unsupported", attempts, waitedMs, message: res.capability });
    } else {
      // transient (retries exhausted) or permanent error — record, converge on a later sync.
      result.errors++;
      result.outcomes.push({
        ticketId,
        action: "error",
        attempts,
        waitedMs,
        message:
          res.status === "permanent-error" || res.status === "transient-error"
            ? redactRemoteFreeText(res.message) // RF-4: a provider/intermediary may echo the host credential in an error; never let it reach SyncResult/stdout/logs
            : res.status,
      });
    }
  }

  // ── 3. Archive: an active mapped card whose ticket has left the board (and is not conflicted). ──
  for (const row of activeRows) {
    if (cardByTicket.has(row.ticketIdentity) || conflictedTickets.has(row.ticketIdentity)) continue;
    result.cardsExamined++;
    const op: OutboundOperation = {
      kind: "archive",
      idempotencyKey: idempotencyKeyFor(
        provName,
        "archive",
        config.projectIdentity,
        row.ticketIdentity,
        row.lastProjectedHash,
      ),
      externalId: row.externalCardId,
      identity: { projectKey: config.projectIdentity, ticketId: row.ticketIdentity },
      projectionRevision: row.lastProjectedHash,
    };
    const { result: res, attempts, waitedMs } = await applyWithRetry(provider, op, policy, sleep);
    if (res.status === "applied" || res.status === "deduplicated") {
      const at = config.now();
      store.upsertProjectionMap({
        projectIdentity: config.projectIdentity,
        ticketIdentity: row.ticketIdentity,
        provider: provName,
        externalCardId: row.externalCardId,
        projectionState: "archived",
        lastProjectedHash: row.lastProjectedHash,
        projectedBy: config.projectedBy,
        projectedAt: at,
        createdAt: row.createdAt,
      });
      result.archived++;
      result.outcomes.push({ ticketId: row.ticketIdentity, action: "archived", externalId: row.externalCardId, attempts, waitedMs });
    } else if (res.status === "unsupported") {
      result.unsupported++;
      result.outcomes.push({ ticketId: row.ticketIdentity, action: "unsupported", attempts, waitedMs, message: res.capability });
    } else {
      result.errors++;
      result.outcomes.push({
        ticketId: row.ticketIdentity,
        action: "error",
        attempts,
        waitedMs,
        message:
          res.status === "permanent-error" || res.status === "transient-error"
            ? redactRemoteFreeText(res.message) // RF-4: a provider/intermediary may echo the host credential in an error; never let it reach SyncResult/stdout/logs
            : res.status,
      });
    }
  }

  return result;
}
