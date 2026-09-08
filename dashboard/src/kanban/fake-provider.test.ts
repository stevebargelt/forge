// FG-785: unit tests for the deterministic fake provider. Pure — no process, no DB, no timers.
// Proves the provider-side half of AC2: create/update/archive apply; an injected transient
// fault surfaces as a retryable signal; a rate-limit surfaces as a backoff signal; and a
// duplicated idempotency key produces exactly one effect.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FakeKanbanProvider } from "./fake-provider.js";
import { KanbanContractError, type KanbanCardContent, type OutboundResult } from "./adapter.js";

const identity = { projectKey: "forge", ticketId: "FG-785" };

function content(over: Partial<KanbanCardContent> = {}): KanbanCardContent {
  return {
    identity,
    laneId: "backlog",
    title: "Provider-neutral external kanban projection",
    body: null,
    labels: ["planning"],
    projectionRevision: "rev-1",
    ...over,
  };
}

/** Narrow an OutboundResult to `applied`, failing the test with context otherwise. */
function assertApplied(result: OutboundResult): Extract<OutboundResult, { status: "applied" }> {
  assert.equal(result.status, "applied", `expected applied, got ${result.status}`);
  return result as Extract<OutboundResult, { status: "applied" }>;
}

/** The single external state read back — asserts exactly one row (satisfies noUncheckedIndexedAccess). */
function only<T>(rows: readonly T[]): T {
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}`);
  return rows[0] as T;
}

describe("create / update / archive apply", () => {
  test("create lands a card and echoes the opaque identity", async () => {
    const provider = new FakeKanbanProvider();
    const result = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));
    assert.equal(result.effect, "created");
    assert.deepEqual(result.identity, identity);
    assert.equal(result.projectionRevision, "rev-1");
    assert.equal(provider.cardCount(), 1);
    assert.equal(provider.totalEffects(), 1);
  });

  test("update mutates presentation, keeps identity and external id stable", async () => {
    const provider = new FakeKanbanProvider();
    const created = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));

    const updated = assertApplied(
      await provider.apply({
        kind: "update",
        idempotencyKey: "u1",
        externalId: created.externalId,
        content: content({ laneId: "in-progress", title: "moved", projectionRevision: "rev-2" }),
      }),
    );
    assert.equal(updated.effect, "updated");
    assert.equal(updated.externalId, created.externalId, "external id (identity handle) is stable across an update");
    assert.deepEqual(updated.identity, identity);

    const state = only(await provider.getExternalState([created.externalId]));
    assert.equal(state.laneId, "in-progress");
    assert.equal(state.title, "moved");
    assert.equal(state.lastAppliedRevision, "rev-2");
    assert.equal(provider.cardCount(), 1, "an update does not create a second card");
  });

  test("archive flags the card without deleting it", async () => {
    const provider = new FakeKanbanProvider();
    const created = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));

    const archived = assertApplied(
      await provider.apply({
        kind: "archive",
        idempotencyKey: "a1",
        externalId: created.externalId,
        identity,
        projectionRevision: "rev-2",
      }),
    );
    assert.equal(archived.effect, "archived");

    const state = only(await provider.getExternalState([created.externalId]));
    assert.equal(state.archived, true);
    assert.equal(state.deleted, false);
  });
});

describe("capability declaration is honoured, not pretended", () => {
  test("an op against an unsupported capability returns `unsupported`, never a fake success", async () => {
    const provider = new FakeKanbanProvider({ unsupported: ["archive"] });
    const created = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));

    const result = await provider.apply({
      kind: "archive",
      idempotencyKey: "a1",
      externalId: created.externalId,
      identity,
      projectionRevision: "rev-2",
    });
    assert.equal(result.status, "unsupported");
    assert.equal(result.status === "unsupported" && result.capability, "archive");
    assert.equal(result.status === "unsupported" && result.retryable, false);
    assert.equal(provider.totalEffects(), 1, "the unsupported archive produced no effect");
  });
});

describe("fault injection surfaces retryable / rate-limited signals", () => {
  test("an injected transient fault is retryable and mutates nothing; the retry converges", async () => {
    const provider = new FakeKanbanProvider();
    provider.injectFault({ kind: "transient" });

    const faulted = await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() });
    assert.equal(faulted.status, "transient-error");
    assert.equal(faulted.status === "transient-error" && faulted.retryable, true);
    assert.equal(provider.cardCount(), 0, "a faulted create left no partial card");
    assert.equal(provider.totalEffects(), 0);

    // Retry the SAME idempotency key — no fault queued now, so it converges to exactly one card.
    const retried = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));
    assert.equal(retried.effect, "created");
    assert.equal(provider.cardCount(), 1);
    assert.equal(provider.totalEffects(), 1);
  });

  test("an injected rate-limit surfaces a backoff floor and is retryable", async () => {
    const provider = new FakeKanbanProvider();
    provider.injectFault({ kind: "rate-limit", retryAfterMs: 250 });

    const limited = await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() });
    assert.equal(limited.status, "rate-limited");
    assert.equal(limited.status === "rate-limited" && limited.retryAfterMs, 250);
    assert.equal(limited.status === "rate-limited" && limited.retryable, true);
    assert.equal(provider.cardCount(), 0);
  });

  test("faults are a FIFO queue — a scripted transient-then-success sequence converges once", async () => {
    const provider = new FakeKanbanProvider();
    provider.injectFault({ kind: "transient" });
    provider.injectFault({ kind: "rate-limit", retryAfterMs: 10 });

    assert.equal((await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() })).status, "transient-error");
    assert.equal((await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() })).status, "rate-limited");
    assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));
    assert.equal(provider.cardCount(), 1);
    assert.equal(provider.totalEffects(), 1);
  });
});

describe("duplicate delivery — same idempotency key twice yields exactly one effect (AC2)", () => {
  test("a replayed create deduplicates to the same external id, no second card", async () => {
    const provider = new FakeKanbanProvider();
    const first = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));

    const second = await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() });
    assert.equal(second.status, "deduplicated");
    assert.equal(second.status === "deduplicated" && second.externalId, first.externalId);
    assert.deepEqual(second.status === "deduplicated" ? second.identity : null, identity);

    assert.equal(provider.cardCount(), 1, "exactly one card exists after a duplicate delivery");
    assert.equal(provider.totalEffects(), 1, "exactly one effect landed");
  });

  test("a replayed update deduplicates and does not re-apply", async () => {
    const provider = new FakeKanbanProvider();
    const created = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));
    const op = {
      kind: "update" as const,
      idempotencyKey: "u1",
      externalId: created.externalId,
      content: content({ title: "v2", projectionRevision: "rev-2" }),
    };
    assertApplied(await provider.apply(op));
    const replay = await provider.apply(op);
    assert.equal(replay.status, "deduplicated");
    assert.equal(provider.totalEffects(), 2, "one create + one update; the replay added no effect");
  });
});

describe("external state read — the drift surface for conflict detection (AC4)", () => {
  test("an external move/edit is reflected in getExternalState but never applied by the provider", async () => {
    const provider = new FakeKanbanProvider();
    const created = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));

    provider.externallyMove(created.externalId, "done");
    provider.externallyEdit(created.externalId, { title: "hand-edited externally" });

    const state = only(await provider.getExternalState([created.externalId]));
    assert.equal(state.laneId, "done");
    assert.equal(state.title, "hand-edited externally");
    assert.equal(state.identity?.ticketId, "FG-785", "the opaque identity is preserved through an external edit");
    assert.equal(provider.totalEffects(), 1, "no outbound effect resulted from the external edit");
  });

  test("an externally deleted card reports deleted with a null-safe shape", async () => {
    const provider = new FakeKanbanProvider();
    const created = assertApplied(await provider.apply({ kind: "create", idempotencyKey: "c1", content: content() }));
    provider.externallyDelete(created.externalId);

    const state = only(await provider.getExternalState([created.externalId]));
    assert.equal(state.deleted, true);
    assert.equal(provider.cardCount(), 0);

    // A later update targeting the vanished card is a non-retryable drift signal, not a crash.
    const result = await provider.apply({
      kind: "update",
      idempotencyKey: "u1",
      externalId: created.externalId,
      content: content({ title: "late" }),
    });
    assert.equal(result.status, "permanent-error");
    assert.equal(result.status === "permanent-error" && result.retryable, false);
  });

  test("getExternalState for an unknown id returns a deleted/null-identity placeholder", async () => {
    const provider = new FakeKanbanProvider();
    const state = only(await provider.getExternalState(["never-seen"]));
    assert.equal(state.deleted, true);
    assert.equal(state.identity, null);
  });
});

describe("contract enforcement bubbles through the fake", () => {
  test("apply throws on an empty idempotency key", async () => {
    const provider = new FakeKanbanProvider();
    await assert.rejects(
      () => provider.apply({ kind: "create", idempotencyKey: "", content: content() }),
      KanbanContractError,
    );
  });

  test("lanes are exposed and defaulted", async () => {
    const provider = new FakeKanbanProvider();
    const lanes = await provider.listLanes();
    assert.deepEqual(lanes.map((l) => l.id), ["backlog", "in-progress", "done"]);
  });
});
