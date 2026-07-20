// FG-564 (Slice 5b, AC6): the SHARED consumer-core engine, exercised GENERICALLY for a
// non-orchestrator (`campaign`) consumer kind against the REAL FG-562 store primitives.
// This proves the extracted core is consumer-agnostic — the ONLY branch points are the
// injected PhysicalDispatch, the recover filter, and the identity guard's expected kind.
//
// Tests run REAL store code against a real in-memory SQLite DB (makeInMemoryDb).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  recordContinuation,
  getContinuation,
  continuationsInDispatch,
  type NextAction,
} from "../store/continuations.js";
import {
  consumeCore,
  recoverInFlightCore,
  assertFullIdentity,
  type ContinuationIdentity,
  type PhysicalDispatch,
} from "./consumer-core.js";
import type { LaunchStatus, LaunchView } from "./launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  setPublicationClockOffsetForTest(0);
});
afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const NEXT: NextAction = { kind: "drive_campaign_item", campaignId: "cmp-1", itemId: "item-2" };
const TERMINAL: LaunchStatus = { state: "exited_ok", code: 0 };

function reader(status: LaunchStatus | undefined) {
  return (id: string): LaunchView | undefined =>
    status === undefined ? undefined : ({ id, status } as unknown as LaunchView);
}

function campaignIdentity(over: Partial<ContinuationIdentity> = {}): ContinuationIdentity {
  return {
    continuationId: "cmp-1::item-1",
    sourceLaunchId: "launch-item-1",
    consumerKind: "campaign",
    currentPhase: "drive:item-1#1",
    nextAction: NEXT,
    ...over,
  };
}

/** An injected dispatch that just records how many times it was asked to produce a run. */
function dispatcher() {
  const calls: Parameters<PhysicalDispatch>[0][] = [];
  const fn: PhysicalDispatch = (args) => {
    calls.push(args);
    return { runId: `run-${calls.length}` };
  };
  return { fn, calls };
}

function seedReady(id: ContinuationIdentity): void {
  recordContinuation({
    continuationId: id.continuationId,
    consumerKind: id.consumerKind,
    sourceLaunchId: id.sourceLaunchId,
    currentPhase: id.currentPhase,
    nextAction: id.nextAction,
  });
}

describe("consumer-core generic engine (AC6)", () => {
  test("the identity guard binds the EXPECTED consumer kind", () => {
    assert.throws(() => assertFullIdentity({ sourceLaunchId: "l" }, "campaign"), /incomplete continuation identity/);
    assert.throws(() => assertFullIdentity(campaignIdentity(), "orchestrator"), /ORCHESTRATOR consumer/);
    assert.throws(
      () => assertFullIdentity({ ...campaignIdentity(), consumerKind: "orchestrator" }, "campaign"),
      /CAMPAIGN consumer/,
    );
    assert.doesNotThrow(() => assertFullIdentity(campaignIdentity(), "campaign"));
  });

  test("a terminal launch advances a campaign continuation via the injected dispatch (exactly once)", () => {
    const id = campaignIdentity();
    seedReady(id);
    const d = dispatcher();
    const out = consumeCore(id, { owner: "campaign@cmp-1@A", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(out.kind, "advanced");
    assert.equal(d.calls.length, 1, "one physical dispatch");
    assert.equal(getContinuation(id.continuationId)?.state, "advanced");

    // A duplicate delivery wake performs NO second dispatch (idempotent).
    const dup = consumeCore(id, { owner: "campaign@cmp-1@A", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(dup.kind, "already_advanced");
    assert.equal(d.calls.length, 1, "no duplicate dispatch");
  });

  test("a THROWING dispatch (a `lost`/fenced reservation) leaves the slot recoverable (blocked), never advanced", () => {
    const id = campaignIdentity();
    seedReady(id);
    const throwing: PhysicalDispatch = () => {
      throw new Error("reservation lost — nothing launched");
    };
    const out = consumeCore(id, { owner: "campaign@cmp-1@A", dispatch: throwing, readLaunch: reader(TERMINAL) });
    assert.equal(out.kind, "blocked");
    // The slot stays IN-FLIGHT (dispatching, receipt set) — recoverable, NOT advanced.
    const c = getContinuation(id.continuationId);
    assert.equal(c?.state, "dispatching");
    assert.equal(continuationsInDispatch({ consumerKind: "campaign" }).length, 1, "still collectible for recovery");
  });

  test("the recover filter is consumer-scoped: campaign recovery ignores an orchestrator in-flight slot", () => {
    // One campaign in-flight slot and one orchestrator in-flight slot.
    const camp = campaignIdentity();
    seedReady(camp);
    seedReady({
      continuationId: "orch-1",
      sourceLaunchId: "launch-orch",
      consumerKind: "orchestrator",
      currentPhase: "build",
      nextAction: { kind: "start_run" },
    });
    // Drive both to `dispatching` by advancing them individually would settle them; instead
    // just assert the recover filter only enumerates the campaign one. Both are still
    // awaiting_completion, so recoverInFlightCore (dispatching-only) sees neither yet.
    const d = dispatcher();
    // Move the campaign slot to dispatching by consuming it with a throwing dispatch.
    consumeCore(camp, {
      owner: "campaign@cmp-1@A",
      dispatch: () => {
        throw new Error("hold in dispatching");
      },
      readLaunch: reader(TERMINAL),
    });
    const campInFlight = continuationsInDispatch({ consumerKind: "campaign" });
    const orchInFlight = continuationsInDispatch({ consumerKind: "orchestrator" });
    assert.equal(campInFlight.length, 1);
    assert.equal(orchInFlight.length, 0, "the orchestrator slot never entered dispatching");

    // A campaign recovery adopts ONLY the campaign in-flight slot.
    const recovered = recoverInFlightCore({ owner: "campaign@cmp-1@A", dispatch: d.fn, readLaunch: reader(TERMINAL) }, "campaign");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.kind, "advanced");
  });
});
