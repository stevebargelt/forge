// FG-591 (step 3 / D6): the dispatcher's durable evidence — wakes and evaluations.
//
// THE BAR THIS FILE HOLDS ITSELF TO. Every invariant is proven by its NEGATIVE
// half, because the positive half is what a broken implementation also produces:
// a wake that was consumed proves nothing about a wake that must be consumed only
// ONCE, and an evaluation row that exists proves nothing about the pass that
// granted nothing. So: a duplicate poke leaves ONE consumable record, the second
// consumer of a selected row gets NOTHING, a refused write leaves the store
// byte-identical, and no writer here touches blocker_evidence — asserted over the
// SQL the module actually prepares, with a negative control proving the capture
// can see such a statement.
//
// STATED LIMIT, so a green run is not mistaken for the whole proof: every DB test
// in this repo runs ONE process against ONE handle, and SQLite treats BEGIN
// IMMEDIATE as BEGIN when no other connection exists — so the LOCKING mechanism is
// inert here. The two-consumer race is opened deterministically through the
// module's between-SELECT-and-CAS seam (queue-claims' setClaimPhaseHookForTest
// precedent), which is what makes the CAS load-bearing rather than decorative; the
// cross-process case belongs to FG-591's dispatch integration tier.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { applyMigrations, makeInMemoryDb, setDbForTest } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { QueueRefusal } from "./queue.js";
import type { QueueClaim, ScanEntry } from "./queue-claims.js";
import * as evidence from "./dispatcher-evidence.js";
import {
  DISPATCH_REASONS,
  capacityHoldersFrom,
  claimWakes,
  evaluationsFor,
  getWake,
  isDispatchReason,
  latestCapacityRefusal,
  latestEvaluation,
  latestEvaluationPerProject,
  listWakes,
  nextWatchdogDeadlineMs,
  pendingWakeCount,
  pendingWakes,
  recordEvaluation,
  recordWake,
  setWakeConsumePhaseHookForTest,
  type DispatchReason,
  type DispatcherEvaluation,
} from "./dispatcher-evidence.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const PK = "pk-evidence";
const PK2 = "pk-evidence-two";
const OWNER = "dispatcher-a";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setPublicationClockOffsetForTest(0);
  setWakeConsumePhaseHookForTest(null);
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setWakeConsumePhaseHookForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The scan a real pass produces: the top candidate blocked, the next one ready
 *  but temporarily incompatible with the active set, the third already claimed.
 *  Every entry carries queue-claims' OWN ScanReason and a concrete detail. */
function bypassedScan(): ScanEntry[] {
  return [
    { ticketId: "FG-100", rank: 1, reason: "queue_blocked", detail: "depends on FG-099 (not done)" },
    { ticketId: "FG-101", rank: 2, reason: "readiness_ineligible", detail: "assessment stale at revision 7" },
    { ticketId: "FG-102", rank: 3, reason: "already_claimed", detail: "held by dispatcher-b until 1754352000000" },
    { ticketId: "FG-103", rank: 4, reason: "incompatible", detail: "waiting for FG-102 to finish" },
  ];
}

function claim(over: Partial<QueueClaim> = {}): QueueClaim {
  return {
    id: "qclaim-aaaaaaaaaaaa",
    projectKey: PK2,
    ticketId: "FG-500",
    owner: "dispatcher-b",
    generation: 1,
    ticketRevision: 3,
    leaseExpiresAtMs: 1_754_352_000_000,
    heartbeatAtMs: 1_754_351_000_000,
    launchId: "launch-1",
    runId: "run-1",
    state: "live",
    outcome: null,
    scanEvidence: null,
    claimedAt: "2026-08-05T00:00:00.000Z",
    releasedAt: null,
    ...over,
  };
}

/** Every table in the store, with every row, ordered deterministically. The
 *  "a refusal writes NOTHING" proof is a whole-store census rather than a look at
 *  the table we expected to be touched. */
function census(): string {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    out[t] = db.prepare(`SELECT * FROM "${t}"`).all() as unknown[];
  }
  return JSON.stringify(out);
}

/** Capture every SQL statement the module PREPARES while fn runs. The module
 *  reaches the DB only through getDb(), which returns this exact instance, so
 *  wrapping `prepare` on it sees every statement — including ones a reviewer
 *  reading the source would miss inside a helper. */
function captureSql<T>(fn: () => T): { sql: string[]; value: T } {
  const original = db.prepare.bind(db);
  const sql: string[] = [];
  (db as unknown as { prepare: typeof original }).prepare = ((source: string) => {
    sql.push(source);
    return original(source);
  }) as typeof original;
  try {
    return { sql, value: fn() };
  } finally {
    (db as unknown as { prepare: typeof original }).prepare = original;
  }
}

// ─── AC: an evaluation that granted nothing leaves exactly ONE durable row ────

describe("recordEvaluation — the durable answer to 'why did nothing start'", () => {
  test("a pass that granted nothing leaves exactly one row naming the top-level reason and every bypassed candidate", () => {
    const scanned = bypassedScan();
    const written = recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      dispatcherGeneration: 4,
      reason: "incompatible_only",
      detail: "waiting for FG-102 to finish",
      scanEvidence: scanned,
      capacityScope: "host",
      capacityLimit: 2,
      capacityUsed: 1,
      wakeKind: "run_terminal",
      nextWatchdogAtMs: 1_754_352_900_000,
    });

    const rows = db.prepare(`SELECT * FROM dispatcher_evaluations`).all() as unknown[];
    assert.equal(rows.length, 1, "exactly ONE row per evaluation pass");

    const read = latestEvaluation(PK);
    assert.ok(read);
    assert.equal(read.id, written.id);
    assert.equal(read.reason, "incompatible_only");
    assert.equal(read.detail, "waiting for FG-102 to finish");
    assert.equal(read.dispatcherOwner, OWNER);
    assert.equal(read.dispatcherGeneration, 4);
    assert.equal(read.claimedTicketId, null);
    assert.equal(read.claimId, null);
    assert.equal(read.capacityScope, "host");
    assert.equal(read.capacityLimit, 2);
    assert.equal(read.capacityUsed, 1);
    assert.equal(read.wakeKind, "run_terminal");
    assert.equal(read.nextWatchdogAtMs, 1_754_352_900_000);

    // Every higher-ranked candidate survives the round trip with queue-claims'
    // own ScanReason AND its concrete detail — the AC's "record why each
    // higher-ranked candidate was passed over".
    assert.deepEqual(read.scanEvidence, scanned);
    const reasons = (read.scanEvidence ?? []).map((s) => s.reason);
    assert.deepEqual(reasons, ["queue_blocked", "readiness_ineligible", "already_claimed", "incompatible"]);
    for (const entry of read.scanEvidence ?? []) {
      assert.ok(entry.detail && entry.detail.length > 0, `candidate ${entry.ticketId} carries a detail`);
    }
  });

  test("a blocked candidate and a temporarily incompatible one stay DIFFERENT facts in the same row", () => {
    recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      reason: "incompatible_only",
      scanEvidence: bypassedScan(),
    });
    const read = latestEvaluation(PK);
    const byTicket = new Map((read?.scanEvidence ?? []).map((s) => [s.ticketId, s]));
    assert.equal(byTicket.get("FG-100")?.reason, "queue_blocked");
    assert.equal(byTicket.get("FG-103")?.reason, "incompatible");
    assert.notEqual(byTicket.get("FG-100")?.reason, byTicket.get("FG-103")?.reason);
  });

  test("each of the six top-level outcomes persists and reads back, including the four refusals", () => {
    const nonGranted: DispatchReason[] = ["disabled", "no_capacity", "no_eligible_work", "lost", "incompatible_only"];
    for (const reason of nonGranted) {
      recordEvaluation({ projectKey: PK, dispatcherOwner: OWNER, reason });
    }
    recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      reason: "granted",
      claimedTicketId: "FG-104",
      claimId: "qclaim-bbbbbbbbbbbb",
    });

    const history = evaluationsFor(PK, { limit: 50 });
    assert.equal(history.length, DISPATCH_REASONS.length);
    assert.deepEqual(
      history.map((h) => h.reason).sort(),
      [...DISPATCH_REASONS].sort(),
      "every reason in the closed vocabulary round-trips",
    );
    assert.equal(history[0]?.reason, "granted", "newest-first");
  });

  test("the top-level vocabulary is a CLOSED set: an unrecognised reason refuses by name and writes nothing", () => {
    const before = census();
    assert.throws(
      () => recordEvaluation({ projectKey: PK, dispatcherOwner: OWNER, reason: "stalled" as DispatchReason }),
      (err: unknown) => {
        assert.ok(err instanceof QueueRefusal);
        assert.match(err.message, /not one of the 6 top-level outcomes/);
        assert.match(err.message, /granted \| disabled \| no_capacity \| no_eligible_work \| lost \| incompatible_only/);
        return true;
      },
    );
    assert.equal(census(), before, "a refused evaluation leaves the whole store byte-identical");
    assert.equal(DISPATCH_REASONS.length, 6);
    assert.equal(isDispatchReason("no_capacity"), true);
    assert.equal(isDispatchReason("stalled"), false);
  });

  test("a 'granted' row with no claim refuses, and a REFUSAL carrying a claim refuses", () => {
    const before = census();
    assert.throws(
      () => recordEvaluation({ projectKey: PK, dispatcherOwner: OWNER, reason: "granted", claimedTicketId: "FG-1" }),
      (err: unknown) => {
        assert.ok(err instanceof QueueRefusal);
        assert.match(err.message, /reason 'granted' needs both claimedTicketId and claimId/);
        return true;
      },
    );
    assert.throws(
      () =>
        recordEvaluation({
          projectKey: PK,
          dispatcherOwner: OWNER,
          reason: "no_capacity",
          claimId: "qclaim-cccccccccccc",
        }),
      (err: unknown) => {
        assert.ok(err instanceof QueueRefusal);
        assert.match(err.message, /is a REFUSAL and must carry no claim/);
        return true;
      },
    );
    assert.equal(census(), before);
  });

  test("an evidence row that cannot name its project or its dispatcher refuses rather than persisting", () => {
    const before = census();
    for (const rec of [
      { projectKey: "", dispatcherOwner: OWNER, reason: "lost" as DispatchReason },
      { projectKey: PK, dispatcherOwner: "", reason: "lost" as DispatchReason },
    ]) {
      assert.throws(() => recordEvaluation(rec), QueueRefusal);
    }
    assert.equal(census(), before);
  });
});

// ─── the reads the operator surface needs ────────────────────────────────────

describe("evaluation reads — the six no-run states have a durable source", () => {
  test("a HOST-scope capacity refusal records the holder list, naming the OTHER project holding the slots", () => {
    const holders = capacityHoldersFrom([
      claim(),
      claim({ id: "qclaim-dddddddddddd", ticketId: "FG-501", launchId: null, runId: null }),
    ]);
    recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      reason: "no_capacity",
      detail: "2/2 live claims in host scope",
      capacityScope: "host",
      capacityLimit: 2,
      capacityUsed: 2,
      capacityHolders: holders,
      scanEvidence: [{ ticketId: "FG-100", rank: 1, reason: "capacity", detail: "2/2 live claims in host scope" }],
    });

    const refusal = latestCapacityRefusal(PK);
    assert.ok(refusal);
    assert.equal(refusal.capacityScope, "host");
    assert.equal(refusal.capacityUsed, 2);
    assert.equal(refusal.capacityHolders?.length, 2);
    const projects = new Set((refusal.capacityHolders ?? []).map((h) => h.projectKey));
    assert.deepEqual([...projects], [PK2], "the refused project can name the project holding the slots");
    assert.deepEqual(refusal.capacityHolders?.[0], {
      claimId: "qclaim-aaaaaaaaaaaa",
      projectKey: PK2,
      ticketId: "FG-500",
      owner: "dispatcher-b",
      launchId: "launch-1",
      runId: "run-1",
    });
  });

  test("latestCapacityRefusal survives a LATER granted pass — 'why did I wait' outlives 'what happened last'", () => {
    recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      reason: "no_capacity",
      capacityScope: "host",
      capacityLimit: 1,
      capacityUsed: 1,
      capacityHolders: capacityHoldersFrom([claim()]),
    });
    recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      reason: "granted",
      claimedTicketId: "FG-100",
      claimId: "qclaim-eeeeeeeeeeee",
    });
    assert.equal(latestEvaluation(PK)?.reason, "granted");
    assert.equal(latestCapacityRefusal(PK)?.reason, "no_capacity");
  });

  test("latestEvaluationPerProject returns one row per project and never leaks another project's history", () => {
    recordEvaluation({ projectKey: PK, dispatcherOwner: OWNER, reason: "no_eligible_work" });
    recordEvaluation({ projectKey: PK2, dispatcherOwner: "dispatcher-b", reason: "disabled" });
    recordEvaluation({ projectKey: PK, dispatcherOwner: OWNER, reason: "incompatible_only" });

    const latest = latestEvaluationPerProject();
    assert.equal(latest.length, 2);
    const byProject = new Map(latest.map((e: DispatcherEvaluation) => [e.projectKey, e.reason]));
    assert.equal(byProject.get(PK), "incompatible_only");
    assert.equal(byProject.get(PK2), "disabled");
    assert.equal(evaluationsFor(PK2).length, 1, "a per-project read stays per-project");
  });

  test("the watchdog deadline distinguishes 'no pass has run' from 'the last pass armed nothing'", () => {
    assert.equal(nextWatchdogDeadlineMs(PK), undefined, "no pass has ever run");
    recordEvaluation({ projectKey: PK, dispatcherOwner: OWNER, reason: "no_eligible_work" });
    assert.equal(nextWatchdogDeadlineMs(PK), null, "a pass ran and armed no deadline");
    recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      reason: "no_eligible_work",
      nextWatchdogAtMs: 1_754_352_900_000,
    });
    assert.equal(nextWatchdogDeadlineMs(PK), 1_754_352_900_000);
  });

  test("every timestamp comes from the STORE clock, never a process clock", () => {
    setPublicationClockOffsetForTest(-3_600_000);
    const written = recordEvaluation({ projectKey: PK, dispatcherOwner: OWNER, reason: "lost" });
    const wake = recordWake({ projectKey: PK, kind: "watchdog", wakeKey: "tick-1" });
    const consumed = claimWakes({ projectKey: PK, consumer: OWNER });
    setPublicationClockOffsetForTest(0);

    const skew = Date.now() - written.evaluatedAtMs;
    assert.ok(skew > 3_000_000, `evaluated_at_ms follows the store clock offset (skew ${skew}ms)`);
    assert.equal(written.evaluatedAt, new Date(written.evaluatedAtMs).toISOString());
    assert.ok(Date.now() - new Date(wake.createdAt).getTime() > 3_000_000);
    assert.ok(consumed[0] && Date.now() - consumed[0].consumedAtMs! > 3_000_000);
  });
});

// ─── AC: a duplicate wake collapses to ONE consumable record ─────────────────

describe("recordWake — durable, at-least-once, idempotent by construction", () => {
  test("a duplicate poke with the same idempotency key collapses to ONE consumable record", () => {
    const first = recordWake({ projectKey: PK, kind: "run_terminal", wakeKey: "run-42", detail: "exited_ok" });
    const second = recordWake({ projectKey: PK, kind: "run_terminal", wakeKey: "run-42", detail: "exited_ok again" });

    assert.equal(second.id, first.id, "the duplicate returns the record that stands, not a new one");
    assert.equal(pendingWakeCount(PK), 1);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatcher_wakes`).get() as { n: number }).n,
      1,
      "the second poke inserted no row at all",
    );
    assert.equal(second.detail, "exited_ok", "the collapse keeps the FIRST detail; it is not a merge");
    assert.equal(second.createdAt, first.createdAt, "and does not rewrite when the change happened");

    const consumed = claimWakes({ projectKey: PK, consumer: OWNER });
    assert.equal(consumed.length, 1, "one consumable record, so one re-evaluation");
  });

  test("a DIFFERENT kind or key for the same project is a different wake, not a duplicate", () => {
    recordWake({ projectKey: PK, kind: "run_terminal", wakeKey: "run-42" });
    recordWake({ projectKey: PK, kind: "queue_changed", wakeKey: "run-42" });
    recordWake({ projectKey: PK, kind: "run_terminal", wakeKey: "run-43" });
    recordWake({ projectKey: PK2, kind: "run_terminal", wakeKey: "run-42" });

    assert.equal(pendingWakeCount(PK), 3);
    assert.equal(pendingWakeCount(PK2), 1, "wakes are per-project and never bleed across");
  });

  test("once CONSUMED, the next change to the same subject gets its OWN record", () => {
    const first = recordWake({ projectKey: PK, kind: "readiness_changed", wakeKey: "FG-100" });
    assert.equal(claimWakes({ projectKey: PK, consumer: OWNER }).length, 1);
    const second = recordWake({ projectKey: PK, kind: "readiness_changed", wakeKey: "FG-100" });

    assert.notEqual(second.id, first.id, "a consumed wake is history and is never revived");
    assert.equal(second.state, "pending");
    assert.equal(getWake(first.id)?.state, "consumed");
    assert.equal(pendingWakeCount(PK), 1);
    assert.equal(listWakes(PK).length, 2, "both are visible as history");
  });

  test("a wake with no project, kind or key refuses by name and writes nothing", () => {
    const before = census();
    for (const rec of [
      { projectKey: "", kind: "manual" as const, wakeKey: "k" },
      { projectKey: PK, kind: "" as evidence.WakeKind, wakeKey: "k" },
      { projectKey: PK, kind: "manual" as const, wakeKey: "" },
    ]) {
      assert.throws(() => recordWake(rec), QueueRefusal);
    }
    assert.equal(census(), before);
  });

  test("pendingWakes is a READ: it consumes nothing and can be called beside the dispatcher", () => {
    recordWake({ projectKey: PK, kind: "capacity_changed", wakeKey: "policy" });
    assert.equal(pendingWakes(PK).length, 1);
    assert.equal(pendingWakes(PK).length, 1);
    assert.equal(pendingWakeCount(PK), 1);
    assert.equal(claimWakes({ projectKey: PK, consumer: OWNER }).length, 1, "the CONSUME is the separate act");
  });
});

// ─── AC: consumed EXACTLY once under two concurrent consumers ────────────────

describe("claimWakes — compare-and-set consume", () => {
  test("two consumers PARTITION the pending set; neither sees the other's rows", () => {
    recordWake({ projectKey: PK, kind: "queue_changed", wakeKey: "FG-1" });
    recordWake({ projectKey: PK, kind: "queue_changed", wakeKey: "FG-2" });

    const a = claimWakes({ projectKey: PK, consumer: "dispatcher-a" });
    const b = claimWakes({ projectKey: PK, consumer: "dispatcher-b" });

    assert.equal(a.length, 2);
    assert.equal(b.length, 0, "the second consumer finds nothing left, rather than the same rows again");
    for (const w of a) {
      assert.equal(w.state, "consumed");
      assert.equal(w.consumedBy, "dispatcher-a");
      assert.equal(getWake(w.id)?.consumedBy, "dispatcher-a");
    }
  });

  test("a row taken by the OTHER consumer between this one's SELECT and its CAS is NOT returned", () => {
    const wake = recordWake({ projectKey: PK, kind: "run_terminal", wakeKey: "run-99" });
    let stolen = false;
    setWakeConsumePhaseHookForTest((wakeId) => {
      if (stolen) return;
      stolen = true;
      // The concurrent consumer, executing in the window after our SELECT saw the
      // row and before our CAS runs. Raw SQL on the same handle: a nested
      // writeTransaction is not what a second PROCESS would do here.
      db.prepare(
        `UPDATE dispatcher_wakes SET state = 'consumed', consumed_by = 'dispatcher-b', consumed_at_ms = 1
          WHERE id = ? AND state = 'pending'`,
      ).run(wakeId);
    });

    const taken = claimWakes({ projectKey: PK, consumer: "dispatcher-a" });

    assert.equal(taken.length, 0, "the losing CAS reports 0 changes, so the row is not in the result");
    assert.equal(getWake(wake.id)?.consumedBy, "dispatcher-b", "consumed exactly once, by the winner");
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatcher_wakes WHERE state = 'consumed'`).get() as { n: number }).n,
      1,
    );
  });

  test("the loser of one row still takes the rows it DID win — a lost CAS is not a failed pass", () => {
    const first = recordWake({ projectKey: PK, kind: "queue_changed", wakeKey: "FG-1" });
    const second = recordWake({ projectKey: PK, kind: "queue_changed", wakeKey: "FG-2" });
    setWakeConsumePhaseHookForTest((wakeId) => {
      if (wakeId !== first.id) return;
      db.prepare(`UPDATE dispatcher_wakes SET state = 'consumed', consumed_by = 'dispatcher-b' WHERE id = ?`).run(
        wakeId,
      );
    });

    const taken = claimWakes({ projectKey: PK, consumer: "dispatcher-a" });
    assert.deepEqual(
      taken.map((w) => w.id),
      [second.id],
    );
    assert.equal(getWake(first.id)?.consumedBy, "dispatcher-b");
    assert.equal(pendingWakeCount(PK), 0);
  });

  test("the limit bounds a pass without losing the remainder", () => {
    for (let i = 0; i < 5; i++) recordWake({ projectKey: PK, kind: "queue_changed", wakeKey: `FG-${i}` });
    assert.equal(claimWakes({ projectKey: PK, consumer: OWNER, limit: 2 }).length, 2);
    assert.equal(pendingWakeCount(PK), 3, "the rest stay pending for the next pass");
  });

  test("a consume with no project or no consumer refuses by name and writes nothing", () => {
    recordWake({ projectKey: PK, kind: "manual", wakeKey: "k" });
    const before = census();
    assert.throws(() => claimWakes({ projectKey: "", consumer: OWNER }), QueueRefusal);
    assert.throws(() => claimWakes({ projectKey: PK, consumer: "" }), QueueRefusal);
    assert.equal(census(), before, "an unattributed consume takes nothing");
  });
});

// ─── AC: a recorded wake survives a FRESH STORE HANDLE ──────────────────────

describe("durability across handles", () => {
  test("a recorded wake survives a fresh store handle and is consumed exactly once through it", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg591-evidence-"));
    const path = join(dir, "forge.db");
    const first = new Database(path);
    first.pragma("foreign_keys = ON");
    first.exec(SCHEMA_SQL);
    applyMigrations(first);
    const restore = setDbForTest(first);
    try {
      const wake = recordWake({ projectKey: PK, kind: "run_terminal", wakeKey: "run-7", detail: "exited_ok" });
      recordEvaluation({
        projectKey: PK,
        dispatcherOwner: OWNER,
        reason: "no_eligible_work",
        scanEvidence: bypassedScan(),
        nextWatchdogAtMs: 1_754_352_900_000,
      });
      first.close();

      // A DIFFERENT handle to the same file: the dispatcher process that restarted.
      const second = new Database(path);
      second.pragma("foreign_keys = ON");
      second.exec(SCHEMA_SQL);
      applyMigrations(second);
      setDbForTest(second);

      const survived = pendingWakes(PK);
      assert.equal(survived.length, 1, "a restart cannot lose a wake");
      assert.equal(survived[0]?.id, wake.id);
      assert.equal(survived[0]?.detail, "exited_ok");
      assert.equal(latestEvaluation(PK)?.scanEvidence?.length, 4, "and the evaluation evidence survives with it");
      assert.equal(nextWatchdogDeadlineMs(PK), 1_754_352_900_000);

      const a = claimWakes({ projectKey: PK, consumer: "dispatcher-successor" });
      const b = claimWakes({ projectKey: PK, consumer: "dispatcher-successor" });
      assert.equal(a.length, 1, "consumed once");
      assert.equal(b.length, 0, "and only once");
      second.close();
    } finally {
      setDbForTest(restore as DatabaseInstance);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── AC: NOTHING here ever writes blocker_evidence ──────────────────────────

describe("the blocker_evidence boundary", () => {
  /** Every WRITER on the module's surface, driven for real. If an export is added
   *  without being listed here, the surface-coverage test below fails. */
  const writers: { name: string; run: () => void }[] = [
    {
      name: "recordWake",
      run: () => void recordWake({ projectKey: PK, kind: "blocker_changed", wakeKey: "FG-100", detail: "blocked" }),
    },
    {
      name: "recordWake (duplicate/collapse path)",
      run: () => void recordWake({ projectKey: PK, kind: "blocker_changed", wakeKey: "FG-100", detail: "blocked" }),
    },
    { name: "claimWakes", run: () => void claimWakes({ projectKey: PK, consumer: OWNER }) },
    {
      name: "recordEvaluation (granted)",
      run: () =>
        void recordEvaluation({
          projectKey: PK,
          dispatcherOwner: OWNER,
          reason: "granted",
          claimedTicketId: "FG-104",
          claimId: "qclaim-ffffffffffff",
          scanEvidence: bypassedScan(),
        }),
    },
    {
      name: "recordEvaluation (every refusal, including the blocked and incompatible scans)",
      run: () => {
        for (const reason of ["disabled", "no_capacity", "no_eligible_work", "lost", "incompatible_only"] as const) {
          recordEvaluation({
            projectKey: PK,
            dispatcherOwner: OWNER,
            reason,
            detail: "waiting for FG-102 to finish",
            scanEvidence: bypassedScan(),
            capacityHolders: capacityHoldersFrom([claim()]),
          });
        }
      },
    },
  ];

  test("no statement any writer prepares mentions blocker_evidence, and no row appears there", () => {
    const { sql } = captureSql(() => {
      for (const w of writers) w.run();
    });
    assert.ok(sql.length > 0, "the capture saw the module's statements");
    const offenders = sql.filter((s) => /blocker_evidence/i.test(s));
    assert.deepEqual(offenders, [], "a scheduling wait is per-evaluation evidence, never a durable blocker row");
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get() as { n: number }).n, 0);
  });

  test("negative control: the SQL capture CAN see a blocker_evidence statement", () => {
    const { sql } = captureSql(() => {
      db.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get();
    });
    assert.equal(sql.filter((s) => /blocker_evidence/i.test(s)).length, 1, "the capture is not blind");
  });

  test("the module SOURCE contains no write against blocker_evidence, on any path", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "dispatcher-evidence.ts"), "utf8");
    // Comments legitimately NAME the table to explain the boundary; SQL must not.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.equal(/blocker_evidence/i.test(code), false, "the table is named only in prose, never in a statement");
    assert.equal(/INSERT\s+INTO\s+blocker_evidence/i.test(source), false);
    assert.equal(/UPDATE\s+blocker_evidence/i.test(source), false);
    assert.equal(/from\s+["'].*blocked-source/.test(source), false, "and no import can reach a writer for it");
    assert.equal(/from\s+["'].*tickets\.js/.test(source), false, "upsertBlockerEvidence lives there");
  });

  test("the writer census covers the module's whole export surface", () => {
    const exported = Object.keys(evidence).sort();
    // Every export is either exercised by the writers above, a read, a pure
    // helper, or the test seam. Listed explicitly so a NEW export forces a
    // decision rather than silently escaping the blocker_evidence proof.
    const known = [
      "DISPATCH_REASONS",
      "capacityHoldersFrom",
      "claimWakes",
      "evaluationsFor",
      "getWake",
      "isDispatchReason",
      "latestCapacityRefusal",
      "latestEvaluation",
      "latestEvaluationPerProject",
      "listWakes",
      "nextWatchdogDeadlineMs",
      "pendingWakeCount",
      "pendingWakes",
      "recordEvaluation",
      "recordWake",
      "setWakeConsumePhaseHookForTest",
    ].sort();
    assert.deepEqual(exported, known);
  });
});

// ─── the pure holder mapper ─────────────────────────────────────────────────

describe("capacityHoldersFrom", () => {
  test("maps live claims to the recorded holder shape and mutates nothing", () => {
    const live = [claim(), claim({ id: "qclaim-dddddddddddd", ticketId: "FG-501" })];
    const snapshot = JSON.stringify(live);
    const holders = capacityHoldersFrom(live);
    assert.equal(holders.length, 2);
    assert.deepEqual(Object.keys(holders[0] ?? {}).sort(), [
      "claimId",
      "launchId",
      "owner",
      "projectKey",
      "runId",
      "ticketId",
    ]);
    assert.equal(JSON.stringify(live), snapshot, "the claims it was handed are untouched");
    assert.deepEqual(capacityHoldersFrom([]), []);
  });

  test("a recorded holder list is a SNAPSHOT: mutating the caller's array after the write changes nothing", () => {
    const holders = capacityHoldersFrom([claim()]);
    recordEvaluation({
      projectKey: PK,
      dispatcherOwner: OWNER,
      reason: "no_capacity",
      capacityHolders: holders,
    });
    holders[0]!.ticketId = "FG-999";
    assert.equal(latestEvaluation(PK)?.capacityHolders?.[0]?.ticketId, "FG-500");
  });
});
