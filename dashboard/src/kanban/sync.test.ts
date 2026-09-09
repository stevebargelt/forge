// FG-785: UNIT tier for the outbound sync engine. Process-free and DB-free — it drives the pure
// engine with a hand-built FG-781 RemoteBoard, the deterministic FakeKanbanProvider, and an
// in-memory implementation of the store PORT. No process is spawned and no database is touched;
// the store-backed proofs live in sync.integration.test.ts.
//
// It proves the engine half of AC2/AC3/AC4:
//   - create / update / archive land as outbound effects;
//   - a repeated sync with no Forge change pushes nothing and converges (no duplicate cards);
//   - only changed-hash cards are pushed (incremental);
//   - a transient fault retries under backoff and converges;
//   - a rate-limit raises the backoff floor;
//   - a duplicate delivery (same idempotency key) collapses to one effect;
//   - external move / edit / delete records a conflict carrying both versions and applies nothing;
//   - a repeated conflict does not duplicate.

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ForgeCardIdentity as ForgeStoreIdentity,
  InsertConflictInput,
  KanbanConflict,
  ProjectionMapRow,
  UpsertProjectionMapInput,
} from "@forge/kanban-projection";
import type { RemoteBoard, RemoteBacklogTicket, RemoteQueueRow } from "../remote/projection.js";
import { FakeKanbanProvider } from "./fake-provider.js";
import { syncBoardOutbound, type KanbanSyncStore, type SyncConfig, type RetryPolicy } from "./sync.js";

// ─── in-memory store port (no DB) ─────────────────────────────────────────────────

const mapKey = (i: ForgeStoreIdentity) => `${i.projectIdentity}\u0000${i.ticketIdentity}\u0000${i.provider}`;

class MemStore implements KanbanSyncStore {
  readonly maps = new Map<string, ProjectionMapRow>();
  readonly conflicts = new Map<string, KanbanConflict>();

  getProjectionMap(identity: ForgeStoreIdentity): ProjectionMapRow | undefined {
    return this.maps.get(mapKey(identity));
  }
  listProjectionMap(projectIdentity: string, provider: string): ProjectionMapRow[] {
    return [...this.maps.values()].filter((r) => r.projectIdentity === projectIdentity && r.provider === provider);
  }
  upsertProjectionMap(input: UpsertProjectionMapInput): void {
    const key = mapKey(input);
    const existing = this.maps.get(key);
    // Mirror the real accessor: preserve the ORIGINAL created_at on a re-projection.
    this.maps.set(key, { ...input, createdAt: existing?.createdAt ?? input.createdAt });
  }
  insertConflict(input: InsertConflictInput): void {
    // ON CONFLICT(id) DO NOTHING — a repeat of the same logical conflict is a no-op.
    if (!this.conflicts.has(input.id)) {
      this.conflicts.set(input.id, { ...input, state: "open", resolvedBy: null, resolvedAt: null, resolution: null });
    }
  }
  getConflict(id: string): KanbanConflict | undefined {
    return this.conflicts.get(id);
  }

  // ─── test helpers (mirror the store's authorized-resolution write) ──────────────────
  resolve(id: string): void {
    const c = this.conflicts.get(id);
    if (c) this.conflicts.set(id, { ...c, state: "resolved", resolvedBy: "op", resolvedAt: "t", resolution: "done" });
  }
  openConflicts(): KanbanConflict[] {
    return [...this.conflicts.values()].filter((c) => c.state === "open");
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────────

const PK = "pk-test";

function ticket(id: string, over: Partial<RemoteBacklogTicket> = {}): RemoteBacklogTicket {
  return {
    id,
    type: "story",
    status: "active",
    title: `Title ${id}`,
    epic: null,
    created: null,
    closed: null,
    related: [],
    ...over,
    revision: over.revision === undefined ? 1 : over.revision,
  };
}

function queueRow(ticketId: string, view: RemoteQueueRow["view"]): RemoteQueueRow {
  return {
    ticketId,
    title: `Title ${ticketId}`,
    type: "story",
    status: "active",
    rank: null,
    revision: 1,
    queued: false,
    blocked: false,
    inProgress: false,
    executionState: "idle",
    view,
    waitKind: null,
  };
}

function board(tickets: RemoteBacklogTicket[], rows: RemoteQueueRow[] = []): RemoteBoard {
  return {
    projectSummary: {
      projectKey: PK,
      label: "Test",
      color: "#fff",
      description: null,
      lastRunAt: null,
      runCount: 0,
      inFlightCount: 0,
      liveSessions: 0,
    },
    backlog: { projectKey: PK, storageMode: "db", tickets },
    queue: {
      projectKey: PK,
      storageMode: "db",
      queueAvailable: true,
      unavailableReason: null,
      version: 1,
      rows,
      views: {} as RemoteBoard["queue"]["views"],
    },
    campaigns: [],
    inbox: { generatedAt: "t", items: [], empty: true, degraded: [] },
    activity: {
      generatedAt: "t",
      agents: [],
      counts: { agents: 0, hostVerifications: 0, launches: 0, ciWaits: 0, operatorWaits: 0 },
      requiredCiState: "none",
      hasLiveWork: false,
    },
  };
}

const FAST_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 10, factor: 2, maxDelayMs: 100 };

function config(over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    projectIdentity: PK,
    provider: "fake",
    projectedBy: "kanban-sync",
    detectedBy: "kanban-sync",
    now: () => "2026-09-08T00:00:00Z",
    retry: FAST_RETRY,
    sleep: async () => {}, // no real wait; waitedMs is still tallied from the policy
    ...over,
  };
}

// ─── create / incremental / update / archive ────────────────────────────────────────

test("create: a fresh board projects one card per ticket and records the identity map", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  const b = board([ticket("FG-1"), ticket("FG-2")]);

  const res = await syncBoardOutbound(b, provider, store, config());

  assert.equal(res.created, 2);
  assert.equal(res.updated, 0);
  assert.equal(provider.cardCount(), 2, "two cards on the board");
  assert.equal(provider.totalEffects(), 2, "exactly two real effects");
  assert.equal(store.listProjectionMap(PK, "fake").length, 2, "two active map rows");
  for (const row of store.listProjectionMap(PK, "fake")) {
    assert.equal(row.projectionState, "active");
    assert.equal(row.projectedBy, "kanban-sync");
    assert.ok(row.lastProjectedHash.length > 0);
  }
});

test("AC3 converge: a repeated sync with no change pushes nothing and mints no duplicate card", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  const b = board([ticket("FG-1"), ticket("FG-2")]);

  await syncBoardOutbound(b, provider, store, config());
  const res2 = await syncBoardOutbound(b, provider, store, config());

  assert.equal(res2.created, 0);
  assert.equal(res2.updated, 0);
  assert.equal(res2.skipped, 2, "both cards are unchanged and skipped");
  assert.equal(provider.cardCount(), 2, "still two cards — no duplicates");
  assert.equal(provider.totalEffects(), 2, "no new effect on a converged sync");
});

test("incremental: only the changed-hash card is pushed", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1"), ticket("FG-2")]), provider, store, config());

  // Change ONLY FG-2's title → its hash changes; FG-1 is untouched.
  const res = await syncBoardOutbound(
    board([ticket("FG-1"), ticket("FG-2", { title: "Re-titled FG-2" })]),
    provider,
    store,
    config(),
  );

  assert.equal(res.updated, 1, "only the changed card is updated");
  assert.equal(res.skipped, 1, "the unchanged card is skipped");
  assert.equal(provider.cardCount(), 2);
  assert.equal(provider.totalEffects(), 3, "one additional effect for the single update");
});

test("archive: a ticket that leaves the board archives its card and flips the map state", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1"), ticket("FG-2")]), provider, store, config());

  const res = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(res.archived, 1);
  const archived = provider.snapshot().find((c) => c.identity.ticketId === "FG-2");
  assert.ok(archived, "the card still exists");
  assert.equal(archived!.archived, true, "and is archived, not deleted");
  const row = store.getProjectionMap({ projectIdentity: PK, ticketIdentity: "FG-2", provider: "fake" });
  assert.equal(row!.projectionState, "archived");
});

test("RF-1: a ticket that returns after archival converges to an ACTIVE external card, not an archived one", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1"), ticket("FG-2")]), provider, store, config());

  // FG-2 leaves the board → its card is archived and the map row flips to archived.
  await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  const archivedRow = store.getProjectionMap({ projectIdentity: PK, ticketIdentity: "FG-2", provider: "fake" });
  assert.equal(archivedRow!.projectionState, "archived");
  const archivedExternalId = archivedRow!.externalCardId;

  // FG-2 RE-APPEARS with byte-identical content — the collision-prone case (same content hash →
  // same original create idempotency key). It must not resurrect the archived card.
  await syncBoardOutbound(board([ticket("FG-1"), ticket("FG-2")]), provider, store, config());

  const row = store.getProjectionMap({ projectIdentity: PK, ticketIdentity: "FG-2", provider: "fake" })!;
  assert.equal(row.projectionState, "active", "the returned ticket's map row is active again");
  const card = provider.snapshot().find((c) => c.externalId === row.externalCardId);
  assert.ok(card, "the map row points at a live external card");
  assert.equal(card!.archived, false, "and that external card is ACTIVE, not the archived one");
  assert.notEqual(row.externalCardId, archivedExternalId, "a fresh card retires the archived mapping");
});

// ─── retry / rate-limit / duplicate delivery ─────────────────────────────────────────

test("AC2 retry: a transient fault retries under backoff and converges to one effect", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  provider.injectFault({ kind: "transient", message: "blip" });

  const res = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(res.created, 1, "the create lands after the retry");
  assert.equal(provider.totalEffects(), 1, "the faulted attempt produced no effect — exactly one");
  const outcome = res.outcomes.find((o) => o.ticketId === "FG-1")!;
  assert.equal(outcome.action, "created");
  assert.ok((outcome.attempts ?? 0) >= 2, "at least two attempts (one faulted, one applied)");
  assert.ok((outcome.waitedMs ?? 0) > 0, "backoff was waited between attempts");
});

test("AC2 rate-limit: the provider's retryAfterMs raises the backoff floor", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  provider.injectFault({ kind: "rate-limit", retryAfterMs: 90 });

  const res = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(res.created, 1);
  const outcome = res.outcomes.find((o) => o.ticketId === "FG-1")!;
  assert.ok((outcome.waitedMs ?? 0) >= 90, "waited at least the rate-limit floor");
});

test("AC2 retries exhausted: a persistent transient fault records an error and converges next sync", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  // More faults than attempts → the first sync exhausts its budget and records an error.
  for (let i = 0; i < 6; i++) provider.injectFault({ kind: "transient" });

  const res1 = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  assert.equal(res1.errors, 1, "the create could not land within the attempt budget");
  assert.equal(store.listProjectionMap(PK, "fake").length, 0, "no map row for an unlanded card");

  // Faults are drained; the next sync converges with the SAME idempotency key.
  const res2 = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  assert.equal(res2.created, 1);
  assert.equal(provider.cardCount(), 1, "exactly one card after convergence");
});

test("AC2 duplicate delivery: re-issuing the same create (lost map row) collapses to one effect", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  assert.equal(provider.totalEffects(), 1);

  // Simulate a lost map write: the engine will re-issue a CREATE with the SAME derived idempotency
  // key. The provider must recognise the key and produce no second effect.
  store.maps.clear();
  const res = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(provider.cardCount(), 1, "no duplicate card from the re-issued create");
  assert.equal(provider.totalEffects(), 1, "the duplicate delivery produced no second effect");
  assert.equal(store.listProjectionMap(PK, "fake").length, 1, "the map row is restored from the dedup result");
  assert.equal(res.outcomes[0]!.action, "created");
});

// ─── unsupported capability ─────────────────────────────────────────────────────

test("unsupported: a provider that declares create unsupported reports it, writes no map row", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider({ unsupported: ["create"] });

  const res = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(res.unsupported, 1);
  assert.equal(res.created, 0);
  assert.equal(store.listProjectionMap(PK, "fake").length, 0, "an unsupported op leaves no identity row");
});

// ─── AC4: external drift → conflict, never applied ───────────────────────────────

test("AC4 moved: an external move records a `moved` conflict with both versions and applies nothing", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1")], [queueRow("FG-1", "backlog")]), provider, store, config());
  const externalId = provider.snapshot()[0]!.externalId;

  // A human moves the card on the board, out of band.
  provider.externallyMove(externalId, "done");

  const res = await syncBoardOutbound(board([ticket("FG-1")], [queueRow("FG-1", "backlog")]), provider, store, config());

  assert.equal(res.conflicts, 1, "the external move is recorded as a conflict");
  assert.equal(res.skipped, 1, "the drifted card is skipped this sync — nothing projected over it");
  const conflict = [...store.conflicts.values()][0]!;
  assert.equal(conflict.kind, "moved");
  assert.equal(conflict.ticketIdentity, "FG-1");
  assert.ok(conflict.forgeVersion, "the Forge canonical version is carried");
  assert.ok(conflict.externalVersion, "the observed external version is carried");
  // The external change was NOT reverted — the engine applied nothing.
  assert.equal(provider.snapshot()[0]!.laneId, "done", "the external move is untouched by the sync");
});

test("AC4 edited: an external title edit records an `edited` conflict", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  const externalId = provider.snapshot()[0]!.externalId;

  provider.externallyEdit(externalId, { title: "Edited externally" });
  const res = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(res.conflicts, 1);
  assert.equal([...store.conflicts.values()][0]!.kind, "edited");
});

test("AC4 deleted: an external delete records a `deleted` conflict", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  const externalId = provider.snapshot()[0]!.externalId;

  provider.externallyDelete(externalId);
  const res = await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(res.conflicts, 1);
  assert.equal([...store.conflicts.values()][0]!.kind, "deleted");
});

test("AC4 idempotent: a repeated sync over the same drift does not duplicate the conflict", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  provider.externallyMove(provider.snapshot()[0]!.externalId, "done");

  await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());
  await syncBoardOutbound(board([ticket("FG-1")]), provider, store, config());

  assert.equal(store.conflicts.size, 1, "the same logical drift yields exactly one conflict row");
});

test("RF-2: a resolved conflict whose divergence persists reopens a NEW open conflict (no invisible deadlock)", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  const b = board([ticket("FG-1")], [queueRow("FG-1", "backlog")]);
  await syncBoardOutbound(b, provider, store, config());
  const externalId = provider.snapshot()[0]!.externalId;

  // An external move → first conflict, projection skipped over the drifted card.
  provider.externallyMove(externalId, "done");
  const r1 = await syncBoardOutbound(b, provider, store, config());
  assert.equal(r1.conflicts, 1);
  assert.equal(store.openConflicts().length, 1, "one open conflict recorded");
  const firstId = store.openConflicts()[0]!.id;

  // The host operator resolves it — but the external divergence is NOT reverted.
  store.resolve(firstId);
  assert.equal(store.openConflicts().length, 0, "no open conflict remains after resolution");

  // The SAME drift persists on the next sync. Old behavior: ON CONFLICT DO NOTHING swallows it, so
  // the ticket is skipped forever with NO open conflict. Fixed behavior: a fresh generation reopens.
  const r2 = await syncBoardOutbound(b, provider, store, config());
  assert.equal(r2.conflicts, 1, "the persistent divergence is surfaced again");
  assert.equal(store.conflicts.size, 2, "a new conflict row was minted — the resolved one was not reused");
  const open = store.openConflicts();
  assert.equal(open.length, 1, "exactly one OPEN conflict is actionable again");
  assert.notEqual(open[0]!.id, firstId, "the reopened conflict carries a fresh id");

  // Projection resumes once the divergence clears: the operator reverts the external move and
  // resolves the reopened conflict, then a genuine Forge change projects again — no longer stuck.
  provider.externallyMove(externalId, "backlog");
  store.resolve(open[0]!.id);
  const r3 = await syncBoardOutbound(
    board([ticket("FG-1", { title: "Now changed" })], [queueRow("FG-1", "backlog")]),
    provider,
    store,
    config(),
  );
  assert.equal(r3.updated, 1, "with the divergence cleared, projection resumes and the change lands");
  assert.equal(r3.conflicts, 0);
});

// ─── identity guard ──────────────────────────────────────────────────────────────

test("identity guard: a board whose projectKey does not match the config is refused", async () => {
  const store = new MemStore();
  const provider = new FakeKanbanProvider();
  const b = board([ticket("FG-1")]);
  await assert.rejects(
    () => syncBoardOutbound(b, provider, store, config({ projectIdentity: "pk-other" })),
    /does not match configured projectIdentity/,
  );
});
