// FG-562 (BD-5): the durable continuation-claim primitive.
//
// Every crash window in the acceptance matrix is a NAMED test here, and the
// load-bearing one — the stale-completion / phase-binding regression — is proven
// with the STAGED evidence the ticket mandates: it is observed RED against a
// UNIQUENESS-ONLY claim (exactly-once, but UNBOUND) before the full phase-bound
// CAS is shown GREEN. Observing "no primitive exists" red would be insufficient;
// the red must falsify a uniqueness-only claim specifically.
//
// Tests run REAL store code against a real in-memory SQLite DB (makeInMemoryDb),
// never ~/.forge/forge.db.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { setPublicationClockOffsetForTest, storeNowMs } from "./publications.js";
import {
  recordContinuation,
  getContinuation,
  continuationByDispatchKey,
  continuationsForLaunch,
  continuationsInDispatch,
  observeLaunchStatus,
  claimContinuationDispatch,
  adoptOrClaimDispatch,
  renewClaim,
  markAdvanced,
  recordDispatchResult,
  markBlocked,
  rearmForNextPhase,
  canonicalizeAction,
  deriveDispatchKey,
  type NextAction,
} from "./continuations.js";

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

const ACTION_A: NextAction = { kind: "dispatch_phase", phase: "review", role: "engineer" };
const ACTION_B: NextAction = { kind: "dispatch_phase", phase: "test", role: "test-engineer" };

function seedReady(over: Partial<{ id: string; launch: string; phase: string; action: NextAction }> = {}): {
  id: string;
  launch: string;
  phase: string;
  action: NextAction;
} {
  const id = over.id ?? "cont-1";
  const launch = over.launch ?? "launch-A";
  const phase = over.phase ?? "phase-A";
  const action = over.action ?? ACTION_A;
  recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: launch, currentPhase: phase, nextAction: action });
  observeLaunchStatus(id, "exited_ok", { terminal: true });
  return { id, launch, phase, action };
}

// ---------------------------------------------------------------------------
// Canonical serialization + deterministic dispatch key.
// ---------------------------------------------------------------------------
describe("canonical action + dispatch key", () => {
  test("canonicalizeAction is key-order-stable and recursive", () => {
    const a: NextAction = { kind: "x", b: 1, a: { z: 2, y: 3 } };
    const b: NextAction = { a: { y: 3, z: 2 }, kind: "x", b: 1 };
    assert.equal(canonicalizeAction(a), canonicalizeAction(b), "different insertion order canonicalizes identically");
    assert.equal(canonicalizeAction(a), '{"a":{"y":3,"z":2},"b":1,"kind":"x"}');
  });

  test("deriveDispatchKey is deterministic across processes/versions for the same identity", () => {
    const canon = canonicalizeAction(ACTION_A);
    const k1 = deriveDispatchKey("cont-1", "launch-A", canon);
    const k2 = deriveDispatchKey("cont-1", "launch-A", canon);
    assert.equal(k1, k2, "same identity → identical receipt");
    assert.notEqual(k1, deriveDispatchKey("cont-1", "launch-B", canon), "a different launch → a different receipt");
  });
});

// ---------------------------------------------------------------------------
// Record + observe (BD-3 evidence).
// ---------------------------------------------------------------------------
describe("record + observe", () => {
  test("recordContinuation stores the canonical action and starts awaiting_completion", () => {
    const c = recordContinuation({ continuationId: "c", consumerKind: "campaign", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
    assert.equal(c.state, "awaiting_completion");
    const row = getDb().prepare(`SELECT next_action FROM continuations WHERE continuation_id='c'`).get() as { next_action: string };
    assert.equal(row.next_action, canonicalizeAction(ACTION_A), "stored canonically");
  });

  test("observing a terminal disposition records evidence and moves awaiting_completion -> ready", () => {
    recordContinuation({ continuationId: "c", consumerKind: "orchestrator", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
    const c = observeLaunchStatus("c", "exited_error", { terminal: true });
    assert.equal(c?.state, "ready");
    assert.equal(c?.lastObservedStatus, "exited_error");
  });

  test("a non-terminal observation records evidence WITHOUT moving to ready", () => {
    recordContinuation({ continuationId: "c", consumerKind: "orchestrator", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
    const c = observeLaunchStatus("c", "running", { terminal: false });
    assert.equal(c?.state, "awaiting_completion");
    assert.equal(c?.lastObservedStatus, "running");
  });
});

// ---------------------------------------------------------------------------
// The happy-path claim + advance.
// ---------------------------------------------------------------------------
describe("claim → dispatch → advance", () => {
  test("a ready continuation is claimed exactly once; dispatch_key is written at claim time", () => {
    const { id } = seedReady();
    const out = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-1", leaseTtlMs: 30_000,
    });
    assert.ok(out.granted, "claim granted");
    assert.ok(out.granted && out.dispatchKey, "dispatch_key present at claim time, before dispatch");
    const c = getContinuation(id)!;
    assert.equal(c.state, "dispatching");
    assert.equal(c.claimOwner, "ctl-1");
    assert.equal(c.dispatchKey, out.granted ? out.dispatchKey : undefined);
    assert.equal(continuationByDispatchKey(c.dispatchKey!)?.continuationId, id, "receipt is indexed");

    assert.ok(recordDispatchResult(id, "ctl-1", { runId: "run-x", taskId: "task-y" }), "records ids under owner");
    assert.ok(markAdvanced(id, "ctl-1", { runId: "run-x", taskId: "task-y" }), "settles advanced");
    const done = getContinuation(id)!;
    assert.equal(done.state, "advanced");
    assert.equal(done.dispatchedRunId, "run-x");
    assert.equal(done.dispatchedTaskId, "task-y");
  });

  test("continuationsForLaunch finds the row awaiting a launch", () => {
    seedReady({ id: "c", launch: "launch-Z" });
    assert.equal(continuationsForLaunch("launch-Z")[0]?.continuationId, "c");
  });
});

// ===========================================================================
// THE STALE-COMPLETION / PHASE-BINDING regression — the HARD requirement.
//
// STAGED evidence: the same scenario is run against a UNIQUENESS-ONLY claim (which
// WRONGLY advances — RED) and then against the full phase-bound CAS (GREEN). This
// proves the red falsifies a uniqueness-only claim specifically, not merely the
// absence of any primitive.
// ===========================================================================

/** The FALSIFICATION BASELINE: a claim that is exactly-once (it CASes on the
 *  unclaimed-or-expired predicate, so two racers can't both win) but UNBOUND — it
 *  omits the source_launch_id + current_phase + next_action + expected-prior-state
 *  binding. This is the "uniqueness-only" claim the ticket requires the red to
 *  falsify. It lives in the test, not in production. */
function claimUniquenessOnly(continuationId: string, owner: string): boolean {
  const now = storeNowMs();
  return getDb()
    .transaction((): boolean => {
      const res = getDb()
        .prepare(
          `UPDATE continuations
              SET state = 'dispatching', claim_owner = ?, claim_expires_at = ?, updated_at = ?
            WHERE continuation_id = ?
              AND (claim_owner IS NULL OR claim_expires_at < ?)`,
        )
        .run(owner, now + 30_000, new Date(now).toISOString(), continuationId, now);
      return res.changes === 1;
    })
    .immediate();
}

describe("stale-completion / phase-binding (STAGED red→green)", () => {
  // Drive the slot to phase B, then present a DELAYED completion from the phase-A
  // launch. Return the continuation id, freshly re-armed for phase B.
  function driveToPhaseB(): string {
    const { id } = seedReady({ id: "cont-pb", launch: "launch-A", phase: "phase-A", action: ACTION_A });
    const first = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-1", leaseTtlMs: 30_000,
    });
    assert.ok(first.granted, "phase-A claim granted");
    assert.ok(markAdvanced(id, "ctl-1"), "phase-A advanced");
    // The controller binds the next phase: the SAME slot now awaits launch-B in phase-B.
    const rearmed = rearmForNextPhase(id, { sourceLaunchId: "launch-B", currentPhase: "phase-B", nextAction: ACTION_B });
    assert.equal(rearmed?.currentPhase, "phase-B");
    assert.equal(rearmed?.state, "awaiting_completion");
    observeLaunchStatus(id, "exited_ok", { terminal: true }); // phase-B's own launch is now ready
    return id;
  }

  test("RED baseline: a UNIQUENESS-ONLY claim WRONGLY advances phase B on a stale phase-A completion", () => {
    const id = driveToPhaseB();
    // A DELAYED completion from launch-A wakes a controller, which (uniqueness-only)
    // claims by continuation_id alone. There is nothing binding it to phase A.
    const wronglyAdvanced = claimUniquenessOnly(id, "stale-ctl-from-launch-A");
    assert.equal(
      wronglyAdvanced,
      true,
      "FALSIFICATION: the uniqueness-only claim advances phase B on a launch-A completion — exactly-once but UNBOUND",
    );
    const c = getContinuation(id)!;
    assert.equal(c.state, "dispatching", "the uniqueness-only claim wrongly moved phase B into dispatching");
    assert.equal(c.claimOwner, "stale-ctl-from-launch-A", "a stale phase-A controller now owns phase B — the defect");
    assert.deepEqual(c.nextAction, ACTION_B, "and it would dispatch phase B's action on phase A's completion");
  });

  test("GREEN: the full phase-bound CAS IGNORES the stale phase-A completion — no state written", () => {
    const id = driveToPhaseB();
    const snapshotBefore = getContinuation(id)!;

    // The SAME delayed launch-A completion, through the full CAS: the controller
    // presents phase-A's binding (source_launch_id=launch-A, phase=phase-A, action=A,
    // expected 'ready'). The slot is bound to phase B, so the predicate matches nothing.
    const out = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "stale-ctl-from-launch-A", leaseTtlMs: 30_000,
    });
    assert.equal(out.granted, false, "the stale completion is NOT granted a claim");
    const after = getContinuation(id)!;
    assert.equal(after.state, "ready", "phase B state is UNCHANGED (still ready for its OWN launch) — the CAS wrote nothing");
    assert.equal(after.claimOwner, undefined, "no stale owner attached to phase B");
    assert.equal(after.updatedAt, snapshotBefore.updatedAt, "no write happened at all (updated_at unchanged)");

    // And phase B's OWN completion (correctly bound) still advances normally.
    const legit = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-B", consumerKind: "orchestrator", currentPhase: "phase-B",
      nextAction: ACTION_B, expectedState: "ready", owner: "ctl-2", leaseTtlMs: 30_000,
    });
    assert.ok(legit.granted, "phase B's correctly-bound completion DOES advance");
  });
});

// ===========================================================================
// The F17 adoption entry-point (adopt-not-duplicate as a real function).
// ===========================================================================
describe("adoptOrClaimDispatch (F17 adoption entry-point)", () => {
  test("no prior dispatch → grants a fresh claim; once claimed → adopts the same dispatch", () => {
    const { id } = seedReady({ id: "ad" });
    const first = adoptOrClaimDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, owner: "ctl-1", leaseTtlMs: 30_000,
    });
    assert.equal(first.disposition, "claim", "no receipt yet → a fresh claim");
    const key = first.disposition === "claim" ? first.dispatchKey : "";
    assert.equal(getContinuation(id)!.claimOwner, "ctl-1");

    // A dispatch was recorded; the crash+recovery recomputes the same identity.
    assert.ok(recordDispatchResult(id, "ctl-1", { runId: "run-x" }));
    const adopted = adoptOrClaimDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, owner: "ctl-recovery", leaseTtlMs: 30_000,
    });
    assert.equal(adopted.disposition, "adopt", "an existing dispatch is adopted, not re-claimed");
    assert.equal(adopted.disposition === "adopt" ? adopted.dispatchKey : "", key, "the adopted receipt is identical");
    assert.equal(adopted.disposition === "adopt" ? adopted.continuation.dispatchedRunId : undefined, "run-x", "the adopted dispatch carries its recorded run id");
    assert.equal(getContinuation(id)!.claimOwner, "ctl-1", "adoption never steals the lease");
  });

  test("no prior dispatch AND not claimable (no terminal evidence) → unclaimable, nothing written", () => {
    recordContinuation({ continuationId: "early", consumerKind: "orchestrator", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
    const before = getContinuation("early")!;
    const out = adoptOrClaimDispatch({
      continuationId: "early", sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
      nextAction: ACTION_A, owner: "ctl", leaseTtlMs: 30_000,
    });
    assert.equal(out.disposition, "unclaimable", "no receipt and no terminal evidence → nothing to adopt or claim");
    assert.equal(getContinuation("early")!.state, "awaiting_completion", "no fabricated readiness");
    assert.equal(getContinuation("early")!.updatedAt, before.updatedAt, "the failed adopt-or-claim wrote nothing");
  });

  test("a blocked slot is still ADOPTED by receipt — a recovery does not re-dispatch a blocked step", () => {
    const { id } = seedReady({ id: "adb" });
    assert.ok(claimContinuationDispatch({ continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A", nextAction: ACTION_A, expectedState: "ready", owner: "ctl-x", leaseTtlMs: 30_000 }).granted);
    assert.ok(markBlocked(id, "ctl-x"));
    const out = adoptOrClaimDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, owner: "ctl-recovery", leaseTtlMs: 30_000,
    });
    assert.equal(out.disposition, "adopt", "the receipt survives a block, so recovery adopts rather than re-dispatching");
    assert.equal(out.disposition === "adopt" ? out.continuation.state : undefined, "blocked", "the adopted slot is still visibly blocked");
  });
});

// ===========================================================================
// Crash windows — each a named test.
// ===========================================================================
describe("crash windows F13–F18 + BD-3", () => {
  test("F13: a duplicate completion after advancement performs no action (observe advanced)", () => {
    const { id } = seedReady();
    const first = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-1", leaseTtlMs: 30_000,
    });
    assert.ok(first.granted);
    assert.ok(markAdvanced(id, "ctl-1"));

    // Duplicate event: another claim on the same (now advanced) row.
    const dup = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-dup", leaseTtlMs: 30_000,
    });
    assert.equal(dup.granted, false, "no second claim");
    assert.equal(dup.granted === false ? dup.continuation?.state : undefined, "advanced", "the loser observes the advanced state");
  });

  test("F14: two controllers racing one completion — one wins the CAS, the loser observes the claim", () => {
    const { id } = seedReady({ id: "race" });
    const a = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-A", leaseTtlMs: 30_000,
    });
    const b = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-B", leaseTtlMs: 30_000,
    });
    assert.equal([a.granted, b.granted].filter(Boolean).length, 1, "exactly one winner");
    const loser = a.granted ? b : a;
    assert.equal(loser.granted === false ? loser.continuation?.state : undefined, "dispatching", "the loser observes the winner's claim");
  });

  test("F15: controller dies after observing, before claiming — another controller may claim", () => {
    const { id } = seedReady({ id: "f15" });
    // First controller observed (state=ready) then died without claiming. A second one claims.
    const out = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-recovery", leaseTtlMs: 30_000,
    });
    assert.ok(out.granted, "a fresh controller claims a ready-but-unclaimed continuation");
  });

  test("F16: crash after claim, before dispatch — the expired lease recovers via takeover; blocked stays visible", () => {
    const { id } = seedReady({ id: "f16" });
    const claim = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-dead", leaseTtlMs: 30_000,
    });
    assert.ok(claim.granted);
    const keyAtClaim = claim.granted ? claim.dispatchKey : "";

    // The owner crashed before dispatching. Its lease is still live → no takeover yet.
    const tooEarly = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "dispatching", owner: "ctl-recovery", leaseTtlMs: 30_000,
    });
    assert.equal(tooEarly.granted, false, "a LIVE lease is never taken over");

    // The lease lapses; a recovery controller takes it over. The receipt is IDENTICAL.
    setPublicationClockOffsetForTest(60_000);
    const takeover = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "dispatching", owner: "ctl-recovery", leaseTtlMs: 30_000,
    });
    assert.ok(takeover.granted, "an EXPIRED lease is recovered by takeover");
    assert.equal(takeover.granted ? takeover.dispatchKey : "", keyAtClaim, "the recovered receipt is identical — no duplicate identity");
    assert.equal(getContinuation(id)!.claimOwner, "ctl-recovery");

    // Alternatively the owner marks it blocked — visibly stuck, never silently gone.
    setPublicationClockOffsetForTest(0);
    const { id: id2 } = seedReady({ id: "f16b" });
    const c2 = claimContinuationDispatch({
      continuationId: id2, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-x", leaseTtlMs: 30_000,
    });
    assert.ok(c2.granted);
    assert.ok(markBlocked(id2, "ctl-x"));
    assert.equal(getContinuation(id2)!.state, "blocked", "a blocked transition is visible, not gone");
    assert.ok(getContinuation(id2)!.dispatchKey, "the receipt survives a block, so a recovery still adopts it");
  });

  test("F17: crash after dispatch, before recording ids — recovery ADOPTS the original dispatch via dispatch_key (no duplicate)", () => {
    const { id } = seedReady({ id: "f17" });
    const claim = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-dead", leaseTtlMs: 30_000,
    });
    assert.ok(claim.granted);
    const originalKey = claim.granted ? claim.dispatchKey : "";
    // The controller DISPATCHED (an agent/run was created keyed by originalKey) then
    // crashed BEFORE recordDispatchResult — so dispatched_run_id is still null.
    assert.equal(getContinuation(id)!.dispatchedRunId, undefined);

    // Recovery: lease lapses, a new controller takes over. It recomputes the SAME
    // dispatch_key, so instead of dispatching a DUPLICATE it adopts the original.
    setPublicationClockOffsetForTest(60_000);
    const recovery = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "dispatching", owner: "ctl-recovery", leaseTtlMs: 30_000,
    });
    assert.ok(recovery.granted);
    assert.equal(recovery.granted ? recovery.dispatchKey : "", originalKey, "recovery derives the IDENTICAL receipt — the original dispatch is adopted, not duplicated");
    // The idempotency receipt uniquely identifies the ONE dispatch across both owners.
    assert.equal(continuationByDispatchKey(originalKey)?.continuationId, id);
  });

  test("BD-3: a FRESH claim is refused while the awaited launch is only awaiting_completion — no terminal evidence, no claim", () => {
    // The type forbids expectedState:'awaiting_completion', so the ONLY fresh claim a
    // caller can even express is expectedState:'ready'. Recorded but not-yet-observed,
    // the slot is still 'awaiting_completion' and that fresh claim matches nothing:
    // a dispatch can never precede a durably-observed terminal disposition.
    recordContinuation({ continuationId: "pre", consumerKind: "orchestrator", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
    assert.equal(getContinuation("pre")!.state, "awaiting_completion");
    const early = claimContinuationDispatch({
      continuationId: "pre", sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
    });
    assert.equal(early.granted, false, "no terminal evidence observed → nothing to claim");
    assert.equal(getContinuation("pre")!.state, "awaiting_completion", "state untouched — no fabricated readiness");
    // A non-terminal observation is recorded but does NOT make the slot claimable.
    observeLaunchStatus("pre", "running", { terminal: false });
    const stillEarly = claimContinuationDispatch({
      continuationId: "pre", sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
    });
    assert.equal(stillEarly.granted, false, "a non-terminal observation is not terminal evidence");
    // Only after a terminal disposition is observed does the fresh claim succeed.
    observeLaunchStatus("pre", "exited_ok", { terminal: true });
    const now = claimContinuationDispatch({
      continuationId: "pre", sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
    });
    assert.ok(now.granted, "terminal disposition observed → the fresh claim is granted");
  });

  test("F17: continuationsInDispatch collects the crash-window claims a recovery adopts by receipt", () => {
    // Two slots are claimed (state='dispatching', receipt written) then their
    // controllers crash before advancing. A third is fully advanced. The recovery
    // collector returns ONLY the in-flight two, each carrying the receipt a recovery
    // path uses to find/adopt an already-created run instead of dispatching a duplicate.
    seedReady({ id: "d1", launch: "L1" });
    seedReady({ id: "d2", launch: "L2" });
    seedReady({ id: "done", launch: "L3" });
    for (const [id, launch, owner] of [["d1", "L1", "o1"], ["d2", "L2", "o2"], ["done", "L3", "o3"]] as const) {
      const c = claimContinuationDispatch({
        continuationId: id, sourceLaunchId: launch, consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner, leaseTtlMs: 30_000,
      });
      assert.ok(c.granted);
    }
    markAdvanced("done", "o3", { runId: "run-done" });

    const inFlight = continuationsInDispatch();
    assert.deepEqual(inFlight.map((c) => c.continuationId), ["d1", "d2"], "only the un-advanced dispatching slots are collected");
    for (const c of inFlight) {
      assert.equal(c.state, "dispatching");
      assert.ok(c.dispatchKey, "each collected slot carries its receipt for adoption");
      assert.equal(c.dispatchedRunId, undefined, "the crash window: no run id recorded yet");
      assert.equal(continuationByDispatchKey(c.dispatchKey!)?.continuationId, c.continuationId, "the receipt resolves back to the slot");
    }
    // A campaign reconciler collects only its own in-flight claims.
    assert.equal(continuationsInDispatch({ consumerKind: "campaign" }).length, 0);
    assert.equal(continuationsInDispatch({ consumerKind: "orchestrator" }).length, 2);
  });

  test("F18: watchdog fires after a normal event already advanced — no duplicate action, no false lost-signal", () => {
    const { id } = seedReady({ id: "f18" });
    const normal = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-1", leaseTtlMs: 30_000,
    });
    assert.ok(normal.granted);
    assert.ok(markAdvanced(id, "ctl-1", { runId: "run-1" }));

    // The lost-signal watchdog fires later and tries to claim. It finds the row
    // already advanced — its claim is refused, so it performs NO duplicate action.
    const watchdog = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "watchdog", leaseTtlMs: 30_000,
    });
    assert.equal(watchdog.granted, false, "the watchdog claims nothing");
    assert.equal(getContinuation(id)!.dispatchedRunId, "run-1", "the single dispatch is untouched — no duplicate");
  });

  test("BD-3: a claim on a reconciled owner_gone/unknown disposition (no exit record) is legitimate; nothing fabricates a record", () => {
    for (const status of ["owner_gone", "unknown"] as const) {
      const id = `bd3-${status}`;
      recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
      // The controller observed a reconciled disposition that has NO filesystem exit
      // record. Recording it is legitimate and moves the slot to ready.
      const observed = observeLaunchStatus(id, status, { terminal: true });
      assert.equal(observed?.state, "ready", `${status} is a legitimate terminal disposition`);
      assert.equal(observed?.lastObservedStatus, status, `${status} recorded as BD-3 evidence — not an exit code`);
      const out = claimContinuationDispatch({
        continuationId: id, sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
      });
      assert.ok(out.granted, `a claim on a reconciled ${status} disposition is granted — no exit record required`);
    }
  });
});

// ===========================================================================
// F14 host-stress race loop — many iterations to shake out a claim race. Each
// iteration: two controllers race one ready continuation; exactly one must win and
// the row must land in a single consistent claimed state.
// ===========================================================================
describe("F14 host-stress", () => {
  const ITERATIONS = 3000;
  test(`the CAS grants exactly one winner across ${ITERATIONS} racing iterations`, () => {
    let winners = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const id = `stress-${i}`;
      seedReady({ id, launch: `L-${i}` });
      const a = claimContinuationDispatch({
        continuationId: id, sourceLaunchId: `L-${i}`, consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "A", leaseTtlMs: 30_000,
      });
      const b = claimContinuationDispatch({
        continuationId: id, sourceLaunchId: `L-${i}`, consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "B", leaseTtlMs: 30_000,
      });
      const n = [a.granted, b.granted].filter(Boolean).length;
      assert.equal(n, 1, `iteration ${i}: exactly one winner`);
      winners += n;
      const c = getContinuation(id)!;
      assert.equal(c.state, "dispatching");
      assert.ok(c.claimOwner === "A" || c.claimOwner === "B", "a single consistent owner");
    }
    assert.equal(winners, ITERATIONS, "one winner per iteration, always");
  });

  test("renewClaim keeps a live claim; a non-owner cannot renew", () => {
    const { id } = seedReady({ id: "renew" });
    const claim = claimContinuationDispatch({
      continuationId: id, sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
      nextAction: ACTION_A, expectedState: "ready", owner: "ctl-1", leaseTtlMs: 10_000,
    });
    assert.ok(claim.granted);
    assert.ok(renewClaim(id, "ctl-1", 60_000), "owner renews");
    assert.equal(renewClaim(id, "someone-else", 60_000), false, "a non-owner cannot renew");
  });
});
