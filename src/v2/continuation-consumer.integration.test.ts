// FG-563 (Slice 4): self-validation of the orchestrator continuation-CONSUMER on
// the REAL store path. This is the engineer's self-validation (CP1–CP6); the
// downstream test-engineer owns the full red-before-green falsification suite
// (F12/F13/F14/F17/F18/F19/F22/BD-3-fabricated-stale) on the real consumer path.
//
// It exercises the consumer against real continuations / runs / lost-signal store
// rows (a file-backed better-sqlite3 under the per-process temp FORGE_HOME), the
// real FG-562 claim primitive, and the real runByDispatchKey bridge — with the
// canonical launch record and the physical dispatch INJECTED (the two seams the
// production `forge continue` wires to readLaunch and startRun/invoke).

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { getDb, closeDb, applyMigrations, assertSchemaVersionSupported, setDbForTest, SCHEMA_VERSION } from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import { FORGE_HOME } from "../util/paths.js";
import {
  recordContinuation,
  getContinuation,
  observeLaunchStatus,
  claimContinuationDispatch,
  continuationsInDispatch,
  markAdvanced as realMarkAdvanced,
  type NextAction,
} from "../store/continuations.js";
import { insertRun, runByDispatchKey } from "../store/runs.js";
import {
  lostSignalRecoveriesFor,
  recordLostSignalRecovery,
  listLostSignalRecoveries,
} from "../store/continuation-lost-signal.js";
import { renderLostSignals } from "../cli/commands/lost-signals.js";
import {
  consumeContinuation,
  recoverInFlightDispatches,
  assertFullIdentity,
  type ContinuationIdentity,
  type PhysicalDispatch,
} from "./continuation-consumer.js";
import type { LaunchStatus, LaunchView } from "./launch.js";

function freshDb(name: string): () => void {
  const path = join(FORGE_HOME, name);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  assertSchemaVersionSupported(db, SCHEMA_VERSION);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  const prev = setDbForTest(db);
  return () => {
    setPublicationClockOffsetForTest(0);
    db.close();
    if (prev) setDbForTest(prev);
    else closeDb();
  };
}

const NEXT: NextAction = { kind: "start_run", workflow: "feature", title: "next phase" };

function identity(over: Partial<ContinuationIdentity> = {}): ContinuationIdentity {
  return {
    continuationId: "cont-1",
    sourceLaunchId: "launch-1",
    consumerKind: "orchestrator",
    currentPhase: "build",
    nextAction: NEXT,
    ...over,
  };
}

/** A stub launch reader that returns a fixed status (or undefined). */
function reader(status: LaunchStatus | undefined) {
  return (id: string): LaunchView | undefined =>
    status === undefined ? undefined : ({ id, status } as unknown as LaunchView);
}

const TERMINAL: LaunchStatus = { state: "exited_ok", code: 0 };
const RUNNING: LaunchStatus = { state: "running" };

// A dispatcher that records how many physical runs it created and inserts a real
// run row carrying the receipt (mirrors startRun/createInvokeRun's CP2 metadata stamp).
function dispatcher() {
  const calls: string[] = [];
  const fn: PhysicalDispatch = (args) => {
    const runId = `run-${calls.length + 1}`;
    calls.push(runId);
    insertRun({
      id: runId,
      workflow: "feature",
      title: "next phase",
      status: "active",
      createdAt: "2026-07-19T00:00:00Z",
      metadata: { dispatchKey: args.dispatchKey },
      projectDir: "/tmp/p",
    });
    return { runId };
  };
  return { fn, calls };
}

// ── CP1: the lost-signal table is real, distinct, and additive ───────────────
test("CP1: continuation_lost_signal_recoveries exists and is DISTINCT from continuation_stale_observations", () => {
  const done = freshDb("fg563-cp1.db");
  try {
    const tables = new Set(
      (getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name),
    );
    assert.ok(tables.has("continuation_lost_signal_recoveries"), "the new lost-signal table exists");
    assert.ok(tables.has("continuation_stale_observations"), "the pre-existing stale-observation table still exists");
    assert.notEqual("continuation_lost_signal_recoveries", "continuation_stale_observations");
  } finally {
    done();
  }
});

// ── CP4/BD-3: a launch-id-only identity is rejected ──────────────────────────
test("CP4: a launch-id-only identity is rejected — full phase-bound identity required", () => {
  assert.throws(() => assertFullIdentity({ sourceLaunchId: "launch-1" } as Partial<ContinuationIdentity>), /incomplete continuation identity/);
  assert.throws(() => assertFullIdentity({ ...identity(), consumerKind: "campaign" }), /ORCHESTRATOR consumer/);
  assert.doesNotThrow(() => assertFullIdentity(identity()));
});

// ── CP3/BD-3: a fabricated status can NEVER drive an advance ──────────────────
test("BD-3: the consumer re-reads the launch — a fabricated terminal never advances a still-running launch", () => {
  const done = freshDb("fg563-bd3.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    // The launch is genuinely RUNNING. Even if the caller "believed" it was terminal,
    // the consumer reads the record itself and refuses to advance.
    const out = consumeContinuation(identity(), { owner: "ctl", dispatch: d.fn, readLaunch: reader(RUNNING) });
    assert.equal(out.kind, "rearmed");
    assert.equal(out.kind === "rearmed" ? out.reason : "", "still_running");
    assert.equal(d.calls.length, 0, "nothing dispatched");
    assert.equal(getContinuation("cont-1")?.state, "awaiting_completion", "slot never promoted");
  } finally {
    done();
  }
});

test("BD-3: unknown/absent launch record re-arms and never advances", () => {
  const done = freshDb("fg563-bd3b.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    const out = consumeContinuation(identity(), { owner: "ctl", dispatch: d.fn, readLaunch: reader(undefined) });
    assert.equal(out.kind, "rearmed");
    assert.equal(out.kind === "rearmed" ? out.reason : "", "unknown_launch");
    assert.equal(d.calls.length, 0);
  } finally {
    done();
  }
});

// ── CP4/F13: a happy-path advance dispatches exactly once ─────────────────────
test("CP4: terminal delivery advances exactly once and dispatches one physical run", () => {
  const done = freshDb("fg563-advance.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    const out = consumeContinuation(identity(), { owner: "ctl", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(out.kind, "advanced");
    assert.equal(d.calls.length, 1, "exactly one physical dispatch");
    const c = getContinuation("cont-1");
    assert.equal(c?.state, "advanced");
    assert.equal(c?.dispatchedRunId, d.calls[0]);
    assert.equal(lostSignalRecoveriesFor("cont-1").length, 0, "normal delivery writes NO lost-signal row");
  } finally {
    done();
  }
});

// ── F13: a duplicate delivery wake yields ONE claim + ONE advance ─────────────
test("F13: a duplicate delivery wake produces exactly one advance; the loser observes advanced state", () => {
  const done = freshDb("fg563-dup.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    const first = consumeContinuation(identity(), { owner: "ctl-A", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    const second = consumeContinuation(identity(), { owner: "ctl-B", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(first.kind, "advanced");
    assert.equal(second.kind, "already_advanced", "the duplicate wake sees advanced state and does nothing");
    assert.equal(d.calls.length, 1, "still exactly one physical dispatch across both wakes");
  } finally {
    done();
  }
});

// ── CP5/F18: watchdog discipline ─────────────────────────────────────────────
test("CP5: watchdog on a STILL-RUNNING launch writes zero lost-signal rows and re-arms", () => {
  const done = freshDb("fg563-wd-running.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    const out = consumeContinuation(identity(), { owner: "wd", trigger: "watchdog", dispatch: d.fn, readLaunch: reader(RUNNING) });
    assert.equal(out.kind, "rearmed");
    assert.equal(d.calls.length, 0);
    assert.equal(lostSignalRecoveriesFor("cont-1").length, 0, "still-running watchdog writes NO lost-signal row");
  } finally {
    done();
  }
});

test("CP5: watchdog on TERMINAL-and-unadvanced writes exactly one lost-signal row and advances", () => {
  const done = freshDb("fg563-wd-lost.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    const out = consumeContinuation(identity(), { owner: "wd", trigger: "watchdog", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(out.kind, "advanced");
    assert.equal(out.kind === "advanced" ? out.lostSignalRecovered : false, true);
    const rows = lostSignalRecoveriesFor("cont-1");
    assert.equal(rows.length, 1, "exactly one lost-signal recovery row");
    assert.equal(rows[0]!.controller, "wd", "row answers WHICH controller");
    assert.equal(rows[0]!.sourceLaunchId, "launch-1", "row answers WHICH launch");
    assert.equal(rows[0]!.recoveryTrigger, "watchdog", "row answers recovered-by-watchdog");
  } finally {
    done();
  }
});

test("F18: watchdog fires AFTER the normal event already advanced — no duplicate action, NO false lost-signal row", () => {
  const done = freshDb("fg563-f18.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    // Normal delivery advances first.
    consumeContinuation(identity(), { owner: "ctl", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    // Watchdog re-fires later.
    const wd = consumeContinuation(identity(), { owner: "wd", trigger: "watchdog", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(wd.kind, "already_advanced");
    assert.equal(d.calls.length, 1, "no duplicate dispatch");
    assert.equal(lostSignalRecoveriesFor("cont-1").length, 0, "NO false lost-signal claim (F18)");
  } finally {
    done();
  }
});

// ── CP2: a run created carrying the receipt is discoverable by runByDispatchKey ─
test("CP2: a run stamped with the dispatch receipt is found by runByDispatchKey (the F17 bridge)", () => {
  const done = freshDb("fg563-cp2.db");
  try {
    insertRun({
      id: "run-bridge",
      workflow: "feature",
      title: "t",
      status: "active",
      createdAt: "2026-07-19T00:00:00Z",
      metadata: { dispatchKey: "receipt-abc" },
      projectDir: "/tmp/p",
    });
    assert.equal(runByDispatchKey("receipt-abc")?.id, "run-bridge", "the run is discoverable by receipt");
    assert.equal(runByDispatchKey("no-such-receipt"), undefined, "an unknown receipt resolves nothing");
  } finally {
    done();
  }
});

// ── F17: crash-after-spawn recovery ADOPTS the original run, never duplicates ─
test("F17: recovery over a dispatching slot ADOPTS the original run via the receipt — no second dispatch", () => {
  const done = freshDb("fg563-f17.db");
  try {
    // Build the crash-after-spawn-before-recordDispatchResult window directly on the
    // primitives so the slot is genuinely stuck in 'dispatching':
    //   1. record + observe terminal (-> ready)
    //   2. claim (-> dispatching; the deterministic receipt is written)
    //   3. create the physical run carrying that receipt (CP2 metadata bridge)
    //   4. CRASH — never recordDispatchResult / markAdvanced
    recordContinuation({ continuationId: "cont-9", consumerKind: "orchestrator", sourceLaunchId: "launch-9", currentPhase: "build", nextAction: NEXT });
    observeLaunchStatus("cont-9", "launch-9", "exited_ok");
    const claim = claimContinuationDispatch({
      continuationId: "cont-9",
      sourceLaunchId: "launch-9",
      consumerKind: "orchestrator",
      currentPhase: "build",
      nextAction: NEXT,
      expectedState: "ready",
      owner: "crashed-ctl",
      leaseTtlMs: 1000,
    });
    assert.ok(claim.granted, "the original controller claimed the slot");
    const receipt = getContinuation("cont-9")!.dispatchKey!;
    // The physical run was created under the receipt (before the crash).
    insertRun({
      id: "run-original",
      workflow: "feature",
      title: "next phase",
      status: "active",
      createdAt: "2026-07-19T00:00:00Z",
      metadata: { dispatchKey: receipt },
      projectDir: "/tmp/p",
    });
    assert.equal(getContinuation("cont-9")?.state, "dispatching", "the slot is stuck mid-dispatch");
    assert.equal(continuationsInDispatch({ consumerKind: "orchestrator" }).length, 1, "the in-flight replay set has the stuck slot");

    // The controller crashed — age the clock past its lease so a recovery may take over.
    setPublicationClockOffsetForTest(5000);

    // Restart replay: adopt the ORIGINAL run via the receipt; NEVER spawn a duplicate.
    const d = dispatcher();
    const recovered = recoverInFlightDispatches({ owner: "recoverer", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.kind, "advanced");
    assert.equal(recovered[0]!.kind === "advanced" ? recovered[0]!.adopted : false, true, "it ADOPTED (did not spawn)");
    assert.equal(d.calls.length, 0, "no duplicate physical dispatch on recovery");
    const c = getContinuation("cont-9");
    assert.equal(c?.state, "advanced");
    assert.equal(c?.dispatchedRunId, "run-original", "the ORIGINAL in-flight run was adopted, not a new one");
  } finally {
    done();
  }
});

// ── FIX1: record-before-advance ordering (BD-4) ──────────────────────────────
test("FIX1: a watchdog recovery records the lost-signal row BEFORE the advance is observable", () => {
  const done = freshDb("fg563-fix1-order.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    // Observe, at the exact instant we settle the advance, whether the durable
    // lost-signal audit row already exists. record-before-notify requires it does.
    let rowsAtAdvance = -1;
    const out = consumeContinuation(identity(), {
      owner: "wd",
      trigger: "watchdog",
      dispatch: d.fn,
      readLaunch: reader(TERMINAL),
      markAdvanced: (continuationId, owner, ids) => {
        rowsAtAdvance = lostSignalRecoveriesFor(continuationId).length;
        return realMarkAdvanced(continuationId, owner, ids);
      },
    });
    assert.equal(out.kind, "advanced");
    assert.equal(rowsAtAdvance, 1, "the lost-signal row was durable BEFORE markAdvanced ran (record-before-advance)");
    assert.equal(lostSignalRecoveriesFor("cont-1").length, 1);
  } finally {
    done();
  }
});

// ── FIX2/F22: every terminal disposition, including reconciled persistent-unreadable ─
test("FIX2/F22: a persistently-unreadable terminal (owner_gone) drives an advance through the consumer", () => {
  const done = freshDb("fg563-fix2-unreadable.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    const OWNER_GONE: LaunchStatus = { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" };
    // The bare record still reads `running` (F11), but the reconciled disposition —
    // the SAME derivation the canonical waiter wakes on — is a terminal owner_gone.
    const unreadable = (id: string): LaunchView =>
      ({ id, status: { state: "running" }, pendingUnreadableExit: { terminal: OWNER_GONE } } as unknown as LaunchView);
    const out = consumeContinuation(identity(), { owner: "ctl", dispatch: d.fn, readLaunch: unreadable });
    assert.equal(out.kind, "advanced", "the reconciled persistent-unreadable terminal advanced (BD-7)");
    assert.equal(d.calls.length, 1);
    assert.equal(getContinuation("cont-1")?.lastObservedStatus, "owner_gone", "observed the reconciled disposition, not `running`");
  } finally {
    done();
  }
});

test("FIX2: wait_timeout / wait_cancelled are waiter-control outcomes — they NEVER advance", () => {
  const done = freshDb("fg563-fix2-control.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const d = dispatcher();
    // Even with a record that reads TERMINAL, a waiter-control outcome forces re-arm.
    const timeout = consumeContinuation(identity(), {
      owner: "ctl",
      dispatch: d.fn,
      readLaunch: reader(TERMINAL),
      waitOutcome: { kind: "wait_timeout", id: "launch-1", lastObserved: RUNNING },
    });
    assert.equal(timeout.kind, "rearmed");
    const cancelled = consumeContinuation(identity(), {
      owner: "ctl",
      dispatch: d.fn,
      readLaunch: reader(TERMINAL),
      waitOutcome: { kind: "wait_cancelled", id: "launch-1", lastObserved: RUNNING },
    });
    assert.equal(cancelled.kind, "rearmed");
    assert.equal(d.calls.length, 0, "no dispatch on any waiter-control wake");
    assert.equal(getContinuation("cont-1")?.state, "awaiting_completion", "never advanced on a control outcome");
  } finally {
    done();
  }
});

// ── FIX3: the operator surface renders human-readable output over real rows ────
test("FIX3: forge lost-signals renders a human-readable operator listing over real store rows", () => {
  const done = freshDb("fg563-fix3.db");
  try {
    recordLostSignalRecovery({
      continuationId: "cont-1",
      sourceLaunchId: "launch-1",
      currentPhase: "build",
      consumerKind: "orchestrator",
      controller: "ctl-42",
      observedStatus: "exited_ok",
      recoveryTrigger: "watchdog",
      dispatchKey: "receipt-k",
      dispatchedRunId: "run-7",
    });
    const rows = listLostSignalRecoveries({ consumerKind: "orchestrator" });
    const human = renderLostSignals(rows, false);
    assert.match(human, /1 lost-signal recovery/);
    assert.match(human, /controller=ctl-42/, "answers WHICH controller");
    assert.match(human, /launch=launch-1/, "answers WHICH launch");
    assert.match(human, /recovered-by=watchdog/, "answers recovered-by-watchdog vs normal delivery");
    assert.match(human, /run=run-7/);
    assert.match(renderLostSignals([], false), /No lost-signal recoveries/);
  } finally {
    done();
  }
});

// ── FIX4(a): a transient dispatch failure is recoverable ─────────────────────
test("FIX4(a): a transient dispatch failure is recoverable — a later wake re-attempts and advances", () => {
  const done = freshDb("fg563-fix4a.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    let attempts = 0;
    const created: string[] = [];
    const flaky: PhysicalDispatch = (args) => {
      attempts++;
      if (attempts === 1) throw new Error("transient EAGAIN spawning container");
      const runId = "run-ok";
      created.push(runId);
      insertRun({ id: runId, workflow: "feature", title: "next phase", status: "active", createdAt: "2026-07-19T00:00:00Z", metadata: { dispatchKey: args.dispatchKey }, projectDir: "/tmp/p" });
      return { runId };
    };
    const first = consumeContinuation(identity(), { owner: "ctl", dispatch: flaky, readLaunch: reader(TERMINAL) });
    assert.equal(first.kind, "blocked", "the failed attempt surfaces a blocked OUTCOME");
    assert.equal(getContinuation("cont-1")?.state, "dispatching", "the slot stays IN-FLIGHT, not wedged in a non-recoverable 'blocked' state");
    // A watchdog re-fire (SAME owner) re-adopts the in-flight claim and re-dispatches.
    const second = consumeContinuation(identity(), { owner: "ctl", trigger: "watchdog", dispatch: flaky, readLaunch: reader(TERMINAL) });
    assert.equal(second.kind, "advanced", "the transient failure recovered on the re-attempt");
    assert.equal(created.length, 1, "exactly one physical run ultimately created");
    assert.equal(getContinuation("cont-1")?.dispatchedRunId, "run-ok");
  } finally {
    done();
  }
});

// ── FIX4(b): same-owner restart re-adoption vs different-owner live-lease loss ─
test("FIX4(b)/F17: a SAME-owner restart re-adopts its in-flight dispatch even with a NON-expired lease", () => {
  const done = freshDb("fg563-fix4b.db");
  try {
    recordContinuation({ continuationId: "cont-9", consumerKind: "orchestrator", sourceLaunchId: "launch-9", currentPhase: "build", nextAction: NEXT });
    observeLaunchStatus("cont-9", "launch-9", "exited_ok");
    const claim = claimContinuationDispatch({
      continuationId: "cont-9",
      sourceLaunchId: "launch-9",
      consumerKind: "orchestrator",
      currentPhase: "build",
      nextAction: NEXT,
      expectedState: "ready",
      owner: "ctl-same",
      leaseTtlMs: 5 * 60 * 1000, // a LONG, still-LIVE lease
    });
    assert.ok(claim.granted);
    const receipt = getContinuation("cont-9")!.dispatchKey!;
    insertRun({ id: "run-original", workflow: "feature", title: "next phase", status: "active", createdAt: "2026-07-19T00:00:00Z", metadata: { dispatchKey: receipt }, projectDir: "/tmp/p" });

    // NO clock advance — the lease is still LIVE. The SAME controller restarts and replays.
    const d = dispatcher();
    const recovered = recoverInFlightDispatches({ owner: "ctl-same", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.kind, "advanced", "same-owner restart re-adopted despite a live lease (was previously a no-op wedge)");
    assert.equal(recovered[0]!.kind === "advanced" ? recovered[0]!.adopted : false, true, "ADOPTED, did not spawn");
    assert.equal(d.calls.length, 0, "no duplicate physical dispatch");
    assert.equal(getContinuation("cont-9")?.dispatchedRunId, "run-original");
  } finally {
    done();
  }
});

test("FIX4(b): a DIFFERENT owner with a LIVE lease still loses — only same-owner or an expired lease may take over", () => {
  const done = freshDb("fg563-fix4b-diff.db");
  try {
    recordContinuation({ continuationId: "cont-9", consumerKind: "orchestrator", sourceLaunchId: "launch-9", currentPhase: "build", nextAction: NEXT });
    observeLaunchStatus("cont-9", "launch-9", "exited_ok");
    assert.ok(
      claimContinuationDispatch({
        continuationId: "cont-9",
        sourceLaunchId: "launch-9",
        consumerKind: "orchestrator",
        currentPhase: "build",
        nextAction: NEXT,
        expectedState: "ready",
        owner: "ctl-A",
        leaseTtlMs: 5 * 60 * 1000,
      }).granted,
    );
    const receipt = getContinuation("cont-9")!.dispatchKey!;
    insertRun({ id: "run-original", workflow: "feature", title: "next phase", status: "active", createdAt: "2026-07-19T00:00:00Z", metadata: { dispatchKey: receipt }, projectDir: "/tmp/p" });

    const d = dispatcher();
    const recovered = recoverInFlightDispatches({ owner: "ctl-B", dispatch: d.fn, readLaunch: reader(TERMINAL) });
    assert.equal(recovered[0]!.kind, "lost_claim", "a different owner cannot steal a live lease");
    assert.equal(d.calls.length, 0);
    assert.equal(getContinuation("cont-9")?.claimOwner, "ctl-A", "still the original owner's in-flight claim");
  } finally {
    done();
  }
});

// ── FIX4(c): the lease is renewed across a long dispatch window ────────────────
test("FIX4(c): a long dispatch renews the claim lease across the dispatch window", () => {
  const done = freshDb("fg563-fix4c.db");
  try {
    recordContinuation({ continuationId: "cont-1", consumerKind: "orchestrator", sourceLaunchId: "launch-1", currentPhase: "build", nextAction: NEXT });
    const LEASE = 60 * 1000;
    let leaseAtDispatch = -1;
    const slowDispatch: PhysicalDispatch = (args) => {
      // The claim already set an expiry; capture it, then let the clock run PAST the
      // lease to model a dispatch longer than the lease TTL.
      leaseAtDispatch = getContinuation("cont-1")!.claimExpiresAt!;
      setPublicationClockOffsetForTest(5 * LEASE);
      insertRun({ id: "run-slow", workflow: "feature", title: "next phase", status: "active", createdAt: "2026-07-19T00:00:00Z", metadata: { dispatchKey: args.dispatchKey }, projectDir: "/tmp/p" });
      return { runId: "run-slow" };
    };
    const out = consumeContinuation(identity(), { owner: "ctl", dispatch: slowDispatch, readLaunch: reader(TERMINAL), leaseTtlMs: LEASE });
    assert.equal(out.kind, "advanced");
    const finalLease = getContinuation("cont-1")!.claimExpiresAt!;
    assert.ok(finalLease > leaseAtDispatch, "the lease was renewed across the long dispatch window (not left to expire mid-dispatch)");
  } finally {
    done();
  }
});

// ── FIX5: runByDispatchKey resolves via the indexed json_extract query ─────────
test("FIX5: runByDispatchKey resolves the receipt via the additive dispatch-key expression index", () => {
  const done = freshDb("fg563-fix5.db");
  try {
    const idx = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runs_dispatch_key'`)
      .get();
    assert.ok(idx, "the additive idx_runs_dispatch_key expression index exists (CP1)");
    insertRun({ id: "run-a", workflow: "feature", title: "t", status: "active", createdAt: "2026-07-19T00:00:00Z", metadata: { dispatchKey: "k1" }, projectDir: "/tmp/p" });
    insertRun({ id: "run-b", workflow: "feature", title: "t", status: "active", createdAt: "2026-07-19T00:00:01Z", metadata: { dispatchKey: "k2" }, projectDir: "/tmp/p" });
    insertRun({ id: "run-c", workflow: "feature", title: "t", status: "active", createdAt: "2026-07-19T00:00:02Z", metadata: { other: "x" }, projectDir: "/tmp/p" });
    assert.equal(runByDispatchKey("k1")?.id, "run-a");
    assert.equal(runByDispatchKey("k2")?.id, "run-b");
    assert.equal(runByDispatchKey("no-such-key"), undefined, "an unmatched receipt (incl. runs with no dispatchKey) resolves nothing");
  } finally {
    done();
  }
});
