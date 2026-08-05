// FG-610 (FG-496 Slice E): the claim / lease / recovery primitives, against a real
// in-memory SQLite DB running the REAL store code.
//
// THE BAR THIS FILE HOLDS ITSELF TO. Every "requires" invariant is proven by its
// NEGATIVE half, because the positive half is what a broken implementation also
// produces: a claim that granted proves nothing about a claim that must NOT grant.
// So: a live lease is NOT stealable, capacity at the ceiling REFUSES rather than
// over-admitting, an ineligible ticket is NOT claimed AND its exclusion is NAMED,
// and a refused claim writes NOTHING (a full row census of every table, before and
// after, byte-identical).
//
// STATED LIMIT, so a green run here is not mistaken for the whole proof: every DB
// test in this repo runs ONE process against ONE handle, and SQLite treats BEGIN
// IMMEDIATE as BEGIN when no other connection exists — so the LOCKING mechanism
// under test is inert here. The cross-process race
// (fg610-claim-race.integration.test.ts, with its falsification mutants) and the
// repeated host stress loop (fg610-claim-stress.integration.test.ts) are the other
// two thirds of the evidence, and neither is optional.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { upsertTicket, upsertBlockerEvidence, getTicket, type TicketRow } from "./tickets.js";
import { dependencyBlockerSource } from "./blocked-source.js";
import {
  dequeueTicket,
  enqueueTicket,
  queueEvents,
  rankTicket,
  rankedOrder,
  readinessView,
  unrankTicket,
  QueueRefusal,
} from "./queue.js";
import * as claimsModule from "./queue-claims.js";
import {
  claimNextEligible,
  claimHistoryForTicket,
  claimIsStillHeld,
  getClaim,
  heartbeatClaim,
  liveClaimCount,
  liveClaims,
  liveClaimsInScope,
  recordClaimLaunch,
  recoverableClaims,
  releaseClaim,
  setClaimPhaseHookForTest,
  takeoverExpiredClaim,
  MIN_LEASE_TTL_MS,
  TAKEOVER_OUTCOME,
  type CapacityScope,
  type ClaimNextResult,
  type ScanEntry,
  type ScanReason,
} from "./queue-claims.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const PK = "pk-claims";
const PK2 = "pk-claims-two";
const NOW = "2026-08-05T00:00:00Z";
const TTL = MIN_LEASE_TTL_MS; // the derived floor; leases are aged via the STORE clock

const READY_BODY = [
  "## Problem",
  "Something is wrong.",
  "",
  "## Goal",
  "Make it right.",
  "",
  "## Acceptance Criteria",
  "- it works",
].join("\n");

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setPublicationClockOffsetForTest(0);
  setClaimPhaseHookForTest(null);
  for (const pk of [PK, PK2]) registerDbProject(pk);
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setClaimPhaseHookForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A project the D6 guard accepts: a project_identity row plus db storage mode. */
function registerDbProject(projectKey: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, 'path', ?)`,
  ).run(projectKey, `evidence-${projectKey}`, NOW);
  db.prepare(
    `INSERT OR REPLACE INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', ?)`,
  ).run(projectKey, NOW);
}

function ticket(id: string, over: Partial<TicketRow> = {}): TicketRow {
  return {
    projectKey: PK,
    ticketId: id,
    type: "story",
    status: "active",
    title: `title ${id}`,
    body: READY_BODY,
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: NOW,
    importedFrom: null,
    ...over,
  };
}

/** Seed tickets and put them in the executable queue in the given order. */
function seedQueued(ids: string[], projectKey: string = PK): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id, { projectKey }));
  });
  for (const id of ids) {
    rankTicket(projectKey, id);
    const res = enqueueTicket(projectKey, id);
    assert.equal(res.ok, true, `${id} must enqueue for the fixture to mean anything`);
  }
}

function claimNext(over: Partial<Parameters<typeof claimNextEligible>[0]> = {}): ClaimNextResult {
  return claimNextEligible({
    projectKey: PK,
    owner: "ctl-1",
    capacity: 10,
    capacityScope: "project",
    leaseTtlMs: TTL,
    ...over,
  });
}

function reasonFor(scanned: ScanEntry[], ticketId: string): ScanReason | undefined {
  return scanned.find((s) => s.ticketId === ticketId)?.reason;
}

/** EVERY row of EVERY table, as text. Stronger than counting rows: a refusal that
 *  quietly UPDATED a column would pass a count census and fail this one. */
function fullDump(): string {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
}

// ─── granting, and what a grant must NOT touch ───────────────────────────────

describe("claim-next grants", () => {
  test("grants the FIRST eligible ticket in canonical rank order and names every skip", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    const out = claimNext();
    assert.equal(out.reason, "granted");
    assert.equal(out.claimed?.ticketId, "FG-1", "rank order is read, and the head is claimed");
    assert.equal(out.claimed?.generation, 1);
    assert.equal(out.claimed?.owner, "ctl-1");
    assert.equal(out.claimed?.state, "live");
    assert.equal(out.claimed?.launchId, null, "the launch identity is stamped LATER, before the launch");
    assert.equal(out.takenOverFrom, null);
    // The scan stops at the winner; every entry carries a named reason.
    assert.deepEqual(out.scanned, [{ ticketId: "FG-1", rank: 1, reason: "eligible", detail: null }]);

    // The grant persisted its own evidence, and appended exactly one claim event.
    const stored = getClaim(PK, out.claimed!.id)!;
    assert.deepEqual(stored.scanEvidence, out.scanned, "the scan that produced the grant is durable");
    const claimEvents = queueEvents(PK, "FG-1").filter((e) => e.eventType === "claim");
    assert.equal(claimEvents.length, 1);
    assert.equal(claimEvents[0]!.payload?.["claimId"], out.claimed!.id);
  });

  test("a granted claim, a takeover and a release mutate NO rank, membership or readiness state", () => {
    seedQueued(["FG-1", "FG-2"]);
    const snapshot = () =>
      JSON.stringify([
        db.prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`).all(PK),
        db.prepare(`SELECT * FROM queue_membership WHERE project_key = ? ORDER BY ticket_id`).all(PK),
        db.prepare(`SELECT * FROM readiness_assessments WHERE project_key = ? ORDER BY ticket_id`).all(PK),
      ]);
    const before = snapshot();

    const first = claimNext();
    assert.equal(first.reason, "granted");
    assert.equal(snapshot(), before, "a grant writes no rank, membership or readiness row");

    setPublicationClockOffsetForTest(TTL + 1);
    const takeover = claimNextEligible({
      projectKey: PK,
      owner: "ctl-2",
      capacity: 10,
      capacityScope: "project",
      leaseTtlMs: TTL,
    });
    assert.equal(takeover.reason, "granted");
    assert.equal(takeover.claimed?.ticketId, "FG-1", "the expired claim's ticket is recovered, in place");
    assert.equal(snapshot(), before, "a takeover writes no rank, membership or readiness row");

    const released = releaseClaim({
      projectKey: PK,
      claimId: takeover.claimed!.id,
      owner: "ctl-2",
      generation: takeover.claimed!.generation,
      outcome: "completed",
    });
    assert.ok(released);
    assert.equal(snapshot(), before, "a release writes no rank, membership or readiness row");
    assert.deepEqual(rankedOrder(PK).map((r) => r.ticketId), ["FG-1", "FG-2"], "canonical rank is untouched");
  });

  test("releaseClaim leaves tickets.status untouched, and no in_progress/blocked column exists anywhere", () => {
    seedQueued(["FG-1"]);
    const statusBefore = getTicket(PK, "FG-1")!.status;
    const out = claimNext();
    releaseClaim({
      projectKey: PK,
      claimId: out.claimed!.id,
      owner: "ctl-1",
      generation: 1,
      outcome: "failed_and_requeued",
    });
    assert.equal(getTicket(PK, "FG-1")!.status, statusBefore, "a release outcome is a fact about the CLAIM");
    assert.equal(getClaim(PK, out.claimed!.id)!.outcome, "failed_and_requeued");
    assert.equal(getClaim(PK, out.claimed!.id)!.state, "released");

    // No second mutable status vocabulary got smuggled in as a column.
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    for (const t of tables) {
      for (const c of db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]) {
        assert.notEqual(c.name, "in_progress", `${t}.${c.name}: in_progress must stay COMPUTED, never stored`);
        assert.notEqual(c.name, "blocked", `${t}.${c.name}: blocked must stay COMPUTED, never stored`);
      }
    }
  });

  test("the release outcome is FREE TEXT — no CHECK pins FG-591's vocabulary", () => {
    const cols = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_claims'`).get() as {
      sql: string;
    };
    assert.equal(/CHECK/i.test(cols.sql), false, "a CHECK on this table could never be widened additively");
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(queue_claims)`).all(), [], "no FK — recovery evidence must survive an operator action");
  });
});

// ─── (3) THE NEGATIVE HALF: a LIVE lease is NOT stealable ────────────────────

describe("a LIVE lease is not stealable", () => {
  test("a second owner on the same host is refused, the claim row is byte-unchanged, and NOTHING is written", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();
    const rowBefore = JSON.stringify(db.prepare(`SELECT * FROM queue_claims`).all());
    const dumpBefore = fullDump();

    const second = claimNextEligible({
      projectKey: PK,
      owner: "ctl-2",
      capacity: 10,
      capacityScope: "project",
      leaseTtlMs: TTL,
    });
    assert.equal(second.claimed, null);
    assert.equal(second.reason, "no_eligible_candidate");
    assert.equal(reasonFor(second.scanned, "FG-1"), "already_claimed");
    assert.match(second.scanned[0]!.detail!, /held by ctl-1/);

    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM queue_claims`).all()), rowBefore, "owner/generation/lease byte-unchanged");
    assert.equal(fullDump(), dumpBefore, "the refusal wrote NOTHING, in any table");
    assert.equal(getClaim(PK, first.claimed!.id)!.owner, "ctl-1");
  });

  test("takeoverExpiredClaim REFUSES a live lease by name and writes nothing", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();
    const dumpBefore = fullDump();
    const out = takeoverExpiredClaim({ projectKey: PK, claimId: first.claimed!.id, owner: "thief", leaseTtlMs: TTL });
    assert.equal(out.claimed, null);
    assert.equal(out.claimed === null ? out.reason : "", "live_lease");
    assert.equal(fullDump(), dumpBefore, "a refused takeover writes nothing");
  });

  test("FALSIFICATION: a takeover that DROPS the strict-expiry predicate steals the live lease", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();
    // The mutant: the same UPDATE with the `lease_expires_at_ms < ?` binding removed.
    // It matches a LIVE row and retires it — this is what the real CAS refuses, and
    // without seeing the mutant succeed, the green assertion above cannot tell "the
    // predicate holds" from "the row was never matchable".
    const stolen = db
      .prepare(`UPDATE queue_claims SET state = 'released', outcome = 'stolen' WHERE id = ? AND state = 'live'`)
      .run(first.claimed!.id);
    assert.equal(stolen.changes, 1, "FALSIFICATION: without the strict-expiry predicate a LIVE lease is stolen");
  });

  test("the lease must be STRICTLY in the past — exactly-at-expiry is still live", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();
    const expiry = first.claimed!.leaseExpiresAtMs;

    // The store clock cannot be parked on an exact instant (it advances between two
    // reads), so strictness is proven against the CAS PREDICATE ITSELF, run with now
    // set exactly equal to the expiry. `<` matches nothing; `<=` would have retired
    // a live lease.
    const atExpiry = db
      .prepare(
        `UPDATE queue_claims SET state = 'released', outcome = 'probe'
          WHERE id = ? AND state = 'live' AND lease_expires_at_ms < ?`,
      )
      .run(first.claimed!.id, expiry);
    assert.equal(atExpiry.changes, 0, "lease_expires_at_ms == now is NOT expired");
    assert.equal(getClaim(PK, first.claimed!.id)!.state, "live");

    // And one millisecond past it, the real verb recovers it.
    setPublicationClockOffsetForTest(TTL + 1);
    const later = takeoverExpiredClaim({ projectKey: PK, claimId: first.claimed!.id, owner: "ctl-2", leaseTtlMs: TTL });
    assert.ok(later.claimed, "past expiry it IS recoverable");
  });
});

// ─── (4) THE NEGATIVE HALF: capacity REFUSES rather than over-admitting ──────

describe("the capacity ceiling refuses rather than over-admitting", () => {
  for (const scope of ["project", "host"] as const) {
    test(`${scope} scope: with N live claims and capacity N, claim-next refuses and writes nothing`, () => {
      seedQueued(["FG-1", "FG-2", "FG-3"]);
      const capacity = 2;
      const granted: string[] = [];
      for (let i = 0; i < 5; i++) {
        const out = claimNextEligible({
          projectKey: PK,
          owner: `ctl-${i}`,
          capacity,
          capacityScope: scope,
          leaseTtlMs: TTL,
        });
        if (out.claimed) granted.push(out.claimed.ticketId);
        // THE INVARIANT, observed at every instant, not merely at the end.
        assert.ok(
          liveClaimCount(scope, PK) <= capacity,
          `COUNT(live claims in ${scope} scope) must never exceed ${capacity}`,
        );
      }
      assert.deepEqual(granted, ["FG-1", "FG-2"], "exactly the ceiling was admitted");

      const dumpBefore = fullDump();
      const refused = claimNextEligible({
        projectKey: PK,
        owner: "ctl-late",
        capacity,
        capacityScope: scope,
        leaseTtlMs: TTL,
      });
      assert.equal(refused.claimed, null);
      assert.equal(refused.reason, "capacity");
      assert.equal(reasonFor(refused.scanned, "FG-3"), "capacity", "the ceiling is NAMED against the candidate it turned away");
      assert.equal(fullDump(), dumpBefore, "a capacity refusal writes NOTHING");
    });
  }

  test("host scope counts ACROSS projects; project scope does not", () => {
    seedQueued(["FG-1"], PK);
    seedQueued(["FG-9"], PK2);
    assert.ok(claimNextEligible({ projectKey: PK, owner: "a", capacity: 1, capacityScope: "host", leaseTtlMs: TTL }).claimed);

    // Host-wide, the other project's queue is now starved at capacity 1...
    const starved = claimNextEligible({ projectKey: PK2, owner: "b", capacity: 1, capacityScope: "host", leaseTtlMs: TTL });
    assert.equal(starved.reason, "capacity");
    assert.equal(liveClaimCount("host", PK2), 1);

    // ...but per-project it is admitted, which is the whole difference between the
    // two scopes and exactly why this module refuses to pick one silently.
    const perProject = claimNextEligible({ projectKey: PK2, owner: "b", capacity: 1, capacityScope: "project", leaseTtlMs: TTL });
    assert.equal(perProject.reason, "granted");
    assert.equal(liveClaimCount("host", PK2), 2, "two containers on one host under two per-project ceilings of 1");
  });

  test("capacity is an ADMISSION test, never an eviction test: lowering it kills nothing", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    for (const owner of ["a", "b", "c"]) {
      assert.ok(claimNextEligible({ projectKey: PK, owner, capacity: 3, capacityScope: "project", leaseTtlMs: TTL }).claimed);
    }
    assert.equal(liveClaimCount("project", PK), 3);
    // The operator drops the ceiling below the live count. Nothing is terminated.
    const out = claimNextEligible({ projectKey: PK, owner: "d", capacity: 1, capacityScope: "project", leaseTtlMs: TTL });
    assert.equal(out.reason, "no_eligible_candidate", "there is nothing left to admit either way");
    assert.equal(liveClaimCount("project", PK), 3, "the three live claims are untouched — no eviction");
  });

  test("a takeover is CAPACITY-NEUTRAL, so a host at its ceiling can still recover a crashed controller", () => {
    seedQueued(["FG-1", "FG-2"]);
    const capacity = 2;
    for (const owner of ["a", "b"]) {
      assert.ok(claimNextEligible({ projectKey: PK, owner, capacity, capacityScope: "project", leaseTtlMs: TTL }).claimed);
    }
    assert.equal(liveClaimCount("project", PK), capacity, "precondition: the ceiling is full");

    setPublicationClockOffsetForTest(TTL + 1);
    const recovered = claimNextEligible({
      projectKey: PK,
      owner: "recovery",
      capacity,
      capacityScope: "project",
      leaseTtlMs: TTL,
    });
    assert.equal(recovered.reason, "granted", "a full ceiling must not deadlock recovery");
    assert.ok(recovered.takenOverFrom, "the grant recovered an expired claim rather than admitting a new one");
    assert.equal(liveClaimCount("project", PK), capacity, "the count did not move — the predecessor retired in the same transaction");
  });
});

// ─── (5) THE NEGATIVE HALF: an ineligible ticket is never claimed ────────────

describe("every exclusion is NAMED, and none of them is ever claimed", () => {
  test("D5: a rank-1 DEFERRED ticket keeps rank, membership and history — and is skipped with a NAMED reason", () => {
    seedQueued(["FG-1", "FG-2"]);
    writeTransaction(() => upsertTicket(ticket("FG-1", { status: "deferred" })));

    const out = claimNext();
    assert.equal(out.claimed?.ticketId, "FG-2", "the deferred head is skipped, not claimed");
    assert.equal(reasonFor(out.scanned, "FG-1"), "deferred", "a rank-1 deferred ticket produces a NAMED reason, not silence");
    // ...and it is STILL a ranked queue member with its history, per D5.
    assert.equal(rankedOrder(PK)[0]!.ticketId, "FG-1");
    assert.ok(
      db.prepare(`SELECT 1 FROM queue_membership WHERE project_key = ? AND ticket_id = 'FG-1'`).get(PK),
      "deferral does not dequeue",
    );
    assert.ok(queueEvents(PK, "FG-1").length > 0, "its queue history survives");
  });

  test("D7: a queue-BLOCKED entry is skipped, and eligibility read the QUEUE projection, not the ticket status", () => {
    seedQueued(["FG-1", "FG-2"]);
    // An ENRICHED dependency blocker: queue_projection blocks, but the source is not
    // status-bearing, so the ticket's own status stays 'active'.
    writeTransaction(() =>
      upsertBlockerEvidence({
        projectKey: PK,
        ticketId: "FG-1",
        reason: "waits on FG-77",
        source: dependencyBlockerSource("FG-77"),
        createdAt: NOW,
        kind: "dependency",
        detail: { dependency: "FG-77" },
        queueProjection: "blocked",
      }),
    );
    assert.equal(getTicket(PK, "FG-1")!.status, "active", "precondition: the TICKET status is NOT blocked");

    const out = claimNext();
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.equal(
      reasonFor(out.scanned, "FG-1"),
      "queue_blocked",
      "the exclusion came from the queue projection — a status-only check would have claimed it",
    );
  });

  test("an UNRANKED queue member is skipped with a named reason", () => {
    seedQueued(["FG-1", "FG-2"]);
    // Hand-shaped: queued but rankless. rankedOrder is what gives the queue a total
    // order, so such an entry has no position to dispatch from.
    db.prepare(`UPDATE tickets SET priority_rank = NULL WHERE project_key = ? AND ticket_id = 'FG-1'`).run(PK);
    const out = claimNext();
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.equal(reasonFor(out.scanned, "FG-1"), "unranked");
  });

  test("a RANKED ticket the operator never queued is skipped with a named reason", () => {
    seedQueued(["FG-2"]);
    writeTransaction(() => upsertTicket(ticket("FG-1")));
    rankTicket(PK, "FG-1", 1);
    const out = claimNext();
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.equal(reasonFor(out.scanned, "FG-1"), "not_a_queue_member");
  });

  test("a STALE readiness assessment is skipped, and evaluateReadiness is NOT re-run on the scan", () => {
    seedQueued(["FG-1", "FG-2"]);
    const assessmentBefore = JSON.stringify(db.prepare(`SELECT * FROM readiness_assessments ORDER BY ticket_id`).all());
    // Edit the ticket: the content hash moves, so the stored assessment goes stale.
    writeTransaction(() => upsertTicket(ticket("FG-1", { body: `${READY_BODY}\n- and another thing` })));
    assert.equal(readinessView(PK, "FG-1")!.stale, true, "precondition");

    const out = claimNext();
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.equal(reasonFor(out.scanned, "FG-1"), "readiness_ineligible");
    assert.match(out.scanned[0]!.detail!, /stale/);
    assert.equal(
      JSON.stringify(db.prepare(`SELECT * FROM readiness_assessments ORDER BY ticket_id`).all()),
      assessmentBefore,
      "the scan re-evaluated nothing and wrote no assessment",
    );
  });

  test("a NEVER-ASSESSED ticket is skipped with a named reason", () => {
    seedQueued(["FG-2"]);
    writeTransaction(() => upsertTicket(ticket("FG-1")));
    rankTicket(PK, "FG-1", 1);
    db.prepare(`INSERT INTO queue_membership (project_key, ticket_id, enqueued_at) VALUES (?, 'FG-1', ?)`).run(PK, NOW);
    const out = claimNext();
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.equal(reasonFor(out.scanned, "FG-1"), "readiness_ineligible");
    assert.equal(out.scanned[0]!.detail, "never assessed");
  });

  test("an ALREADY-CLAIMED ticket is skipped with a named reason and is never double-granted", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimNext();
    const out = claimNextEligible({ projectKey: PK, owner: "ctl-2", capacity: 10, capacityScope: "project", leaseTtlMs: TTL });
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.equal(reasonFor(out.scanned, "FG-1"), "already_claimed");
    assert.equal(liveClaims(PK).filter((c) => c.ticketId === "FG-1").length, 1);
  });

  test("the caller's predicate can reject a candidate, and its OWN reason is carried through", () => {
    seedQueued(["FG-1", "FG-2"]);
    const out = claimNext({
      isCompatible: (candidate) =>
        candidate.ticketId === "FG-1"
          ? { compatible: false, reason: "touches the same migration as an active run" }
          : { compatible: true },
    });
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.equal(reasonFor(out.scanned, "FG-1"), "incompatible");
    assert.equal(out.scanned[0]!.detail, "touches the same migration as an active run");
  });

  test("the predicate sees the ACTIVE claims in scope, and is evaluated OUTSIDE the write transaction", () => {
    seedQueued(["FG-1", "FG-2"]);
    const first = claimNext();
    let seenActive: readonly { ticketId: string }[] = [];
    let inTransactionAtCall: boolean | null = null;
    let claimRowsAtCall = -1;

    const out = claimNext({
      owner: "ctl-2",
      isCompatible: (_candidate, active) => {
        seenActive = active;
        // THE PURITY / LOCK-HOLDING PROOF. If the predicate ran inside the claim's
        // write transaction, better-sqlite3 would report inTransaction === true and
        // the whole-database write lock every forge process shares would be held
        // while arbitrary caller code ran.
        inTransactionAtCall = db.inTransaction;
        claimRowsAtCall = (db.prepare(`SELECT COUNT(*) AS n FROM queue_claims`).get() as { n: number }).n;
        return { compatible: true };
      },
    });
    assert.equal(out.reason, "granted");
    assert.equal(inTransactionAtCall, false, "the caller's predicate must never run under the write lock");
    assert.equal(claimRowsAtCall, 1, "the predicate ran BEFORE the claim was inserted (phase 1)");
    assert.deepEqual(seenActive.map((a) => a.ticketId), ["FG-1"], "the predicate can see what is already reserved");
  });
});

// ─── (6) A REFUSED CLAIM WRITES NOTHING — all three refusal paths ────────────

describe("a refused claim writes nothing", () => {
  test("no_eligible_candidate: a full row census is identical", () => {
    seedQueued(["FG-1"]);
    writeTransaction(() => upsertTicket(ticket("FG-1", { status: "deferred" })));
    const before = fullDump();
    const out = claimNext();
    assert.equal(out.reason, "no_eligible_candidate");
    assert.equal(fullDump(), before);
  });

  test("capacity: a full row census is identical", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimNextEligible({ projectKey: PK, owner: "a", capacity: 1, capacityScope: "project", leaseTtlMs: TTL });
    const before = fullDump();
    const out = claimNextEligible({ projectKey: PK, owner: "b", capacity: 1, capacityScope: "project", leaseTtlMs: TTL });
    assert.equal(out.reason, "capacity");
    assert.equal(fullDump(), before);
  });

  test("lost: a concurrent winner between the scan and the claim leaves the loser writing NOTHING", () => {
    seedQueued(["FG-1"]);
    let winnerId = "";
    // The window a single process cannot otherwise open: a rival dispatcher takes the
    // ticket after our scan chose it and before our claim transaction opens.
    setClaimPhaseHookForTest((candidate) => {
      setClaimPhaseHookForTest(null);
      assert.equal(candidate, "FG-1");
      const rival = claimNextEligible({ projectKey: PK, owner: "rival", capacity: 10, capacityScope: "project", leaseTtlMs: TTL });
      winnerId = rival.claimed!.id;
    });

    const before = (): string => fullDump();
    const out = claimNext();
    const after = before();
    assert.equal(out.claimed, null);
    assert.equal(out.reason, "lost", "the re-validation caught the concurrent winner");
    assert.equal(after, before(), "stable");
    assert.equal(liveClaims(PK).length, 1, "exactly one live claim survives the race");
    assert.equal(liveClaims(PK)[0]!.id, winnerId);
    assert.equal(getClaim(PK, winnerId)!.owner, "rival", "the loser did not overwrite the winner");
  });

  test("lost: a ticket edited between the scan and the claim is not claimed against a stale revision", () => {
    seedQueued(["FG-1"]);
    setClaimPhaseHookForTest(() => {
      setClaimPhaseHookForTest(null);
      writeTransaction(() => upsertTicket(ticket("FG-1", { body: `${READY_BODY}\n- edited underneath` })));
    });
    const out = claimNext();
    assert.equal(out.reason, "lost");
    assert.equal(liveClaims(PK).length, 0, "nothing was claimed against content that moved");
  });

  test("capacity filled between the scan and the claim refuses at the ceiling, writing nothing", () => {
    seedQueued(["FG-1"], PK);
    seedQueued(["FG-9"], PK2);
    setClaimPhaseHookForTest(() => {
      setClaimPhaseHookForTest(null);
      // A rival takes the last HOST slot on a DIFFERENT project's ticket, so the
      // ceiling — not this ticket — is what turns the claim away, and only the
      // IN-TRANSACTION recount can see it. A count taken in phase 1 over-admits.
      assert.ok(
        claimNextEligible({ projectKey: PK2, owner: "rival", capacity: 1, capacityScope: "host", leaseTtlMs: TTL }).claimed,
      );
    });
    const out = claimNextEligible({ projectKey: PK, owner: "late", capacity: 1, capacityScope: "host", leaseTtlMs: TTL });
    assert.equal(out.claimed, null);
    assert.equal(out.reason, "capacity");
    assert.equal(liveClaimCount("host", PK), 1, "the ceiling held under the in-transaction recount");
  });

  test("lost: a BETTER-RANKED ticket that becomes eligible between the scan and the claim is never jumped", () => {
    seedQueued(["FG-1", "FG-2"]);
    writeTransaction(() => upsertTicket(ticket("FG-1", { status: "deferred" })));

    let afterHook = "";
    setClaimPhaseHookForTest((candidate) => {
      setClaimPhaseHookForTest(null);
      assert.equal(candidate, "FG-2", "the scan legitimately chose FG-2 — FG-1 was deferred when it looked");
      // The operator un-defers the canonical head while our scan is unlocked. Its
      // content hash returns to what the stored assessment is bound to, so FG-1 is
      // eligible again — ahead of the candidate we are about to claim.
      writeTransaction(() => upsertTicket(ticket("FG-1")));
      afterHook = fullDump();
    });

    const candidateRevisionAtScan = getTicket(PK, "FG-2")!.revision;
    const out = claimNext();
    assert.equal(out.claimed, null);
    assert.equal(out.reason, "lost", "the SCAN went stale, not merely the candidate");
    assert.equal(fullDump(), afterHook, "the refused claim wrote NOTHING");

    // FALSIFICATION: every fact a CANDIDATE-ONLY re-validation re-reads is still
    // exactly as the scan saw it, so the pre-fix phase 2 grants FG-2 and the grant
    // silently jumps the operator's canonical order.
    assert.equal(getTicket(PK, "FG-2")!.revision, candidateRevisionAtScan, "FALSIFICATION: the candidate's revision never moved");
    assert.equal(readinessView(PK, "FG-2")!.stale, false, "FALSIFICATION: the candidate's readiness never moved");
    assert.equal(getTicket(PK, "FG-2")!.status, "active", "FALSIFICATION: nor its status, membership or rank");
    assert.equal(liveClaims(PK).length, 0, "FALSIFICATION: nor was it claimed by anyone");

    // And the refusal is a RESTART, not a deadlock: the very next scan grants the
    // head of the canonical order.
    const again = claimNext();
    assert.equal(again.claimed?.ticketId, "FG-1", "the re-scan claims the ticket that became eligible");
  });

  test("lost: a ticket ENQUEUED at a better rank between the scan and the claim also restarts the scan", () => {
    seedQueued(["FG-2"]);
    // FG-1 is ranked ahead of FG-2 but was never selected for execution, so the scan
    // names it not_a_queue_member and moves on.
    writeTransaction(() => upsertTicket(ticket("FG-1")));
    rankTicket(PK, "FG-1", 1);

    setClaimPhaseHookForTest(() => {
      setClaimPhaseHookForTest(null);
      assert.equal(enqueueTicket(PK, "FG-1").ok, true, "the operator selects the higher-ranked ticket mid-scan");
    });
    const out = claimNext();
    assert.equal(out.reason, "lost");
    assert.equal(reasonFor(out.scanned, "FG-1"), "not_a_queue_member", "which is what the stale scan believed");
    assert.equal(liveClaims(PK).length, 0, "nothing was claimed out of order");
    assert.equal(claimNext().claimed?.ticketId, "FG-1", "and the re-scan honours the new membership");
  });

  test("the rank re-check never fires on an exclusion the STORE cannot re-derive: a predicate-rejected head does not deadlock the queue", () => {
    seedQueued(["FG-1", "FG-2"]);
    // The predicate is not re-run inside the write transaction (it is caller code, and
    // the write lock is machine-wide), so FG-1 looks plainly eligible to any SQL the
    // re-check could run. Treating it as an intruder would refuse EVERY attempt
    // forever — the scan's own named reason is what keeps this a hardening rather
    // than a livelock.
    const rejectFg1 = {
      isCompatible: (candidate: { ticketId: string }) =>
        candidate.ticketId === "FG-1"
          ? ({ compatible: false, reason: "touches the same migration as an active run" } as const)
          : ({ compatible: true } as const),
    };
    const first = claimNext(rejectFg1);
    assert.equal(first.claimed?.ticketId, "FG-2");
    releaseClaim({ projectKey: PK, claimId: first.claimed!.id, owner: "ctl-1", generation: 1, outcome: "done" });
    assert.equal(claimNext(rejectFg1).claimed?.ticketId, "FG-2", "and again, and again — the queue still moves");
  });

  test("the rank re-check never fires on a CAPACITY exclusion either: recovery still works at a full ceiling", () => {
    seedQueued(["FG-1", "FG-2"]);
    const a = claimNext({ owner: "ctl-a", capacity: 2 });
    const b = claimNext({ owner: "ctl-b", capacity: 2 });
    assert.equal(a.claimed?.ticketId, "FG-1");
    assert.equal(b.claimed?.ticketId, "FG-2");
    releaseClaim({ projectKey: PK, claimId: a.claimed!.id, owner: "ctl-a", generation: 1, outcome: "done" });
    setPublicationClockOffsetForTest(TTL + 1); // ctl-b crashed: FG-2's lease lapsed.

    // FG-1 is now free and ranked FIRST, but the ceiling of 1 has no room to admit it;
    // the only grant available is the CAPACITY-NEUTRAL takeover of FG-2. A rank
    // re-check that counted the capacity-excluded head as an intruder would make the
    // full ceiling a permanent deadlock instead of an admission test.
    const out = claimNext({ owner: "ctl-c", capacity: 1 });
    assert.equal(out.reason, "granted");
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.ok(out.takenOverFrom, "the grant recovered rather than admitted");
    assert.equal(reasonFor(out.scanned, "FG-1"), "capacity");
  });

  test("lost: the ACTIVE-CLAIM SET moving under a compatibility predicate refuses rather than admitting", () => {
    seedQueued(["FG-1"], PK);
    seedQueued(["FG-9"], PK2);
    let afterHook = "";
    setClaimPhaseHookForTest(() => {
      setClaimPhaseHookForTest(null);
      // A rival dispatcher takes a host-scope slot on ANOTHER project's ticket. Our
      // candidate is untouched, the ceiling is nowhere near — what moved is the set
      // the predicate was shown, and its verdict is now about a host that no longer
      // exists. Two dispatchers each seeing "no conflicting claim" and then
      // serializing their writes is how two incompatible tickets both get admitted.
      assert.ok(
        claimNextEligible({ projectKey: PK2, owner: "rival", capacity: 10, capacityScope: "host", leaseTtlMs: TTL }).claimed,
      );
      afterHook = fullDump();
    });

    let sawActive = -1;
    const out = claimNextEligible({
      projectKey: PK,
      owner: "late",
      capacity: 10,
      capacityScope: "host",
      leaseTtlMs: TTL,
      isCompatible: (_candidate, active) => {
        sawActive = active.length;
        return { compatible: true };
      },
    });
    assert.equal(out.claimed, null);
    assert.equal(out.reason, "lost");
    assert.equal(sawActive, 0, "the predicate was shown an EMPTY active set — precisely the fact that moved");
    assert.equal(fullDump(), afterHook, "the refused claim wrote NOTHING");
    assert.equal(liveClaims(PK).length, 0, "no incompatible second admission");
  });

  test("a caller with NO predicate is not refused for an active-claim set it never consulted", () => {
    seedQueued(["FG-1"], PK);
    seedQueued(["FG-9"], PK2);
    setClaimPhaseHookForTest(() => {
      setClaimPhaseHookForTest(null);
      assert.ok(
        claimNextEligible({ projectKey: PK2, owner: "rival", capacity: 10, capacityScope: "host", leaseTtlMs: TTL }).claimed,
      );
    });
    // Same race, same moving set — but the only way the set entered this decision is
    // the ceiling, which is recounted in the transaction. Refusing here would be a
    // gratuitous restart on the busiest path in the system.
    const out = claimNextEligible({ projectKey: PK, owner: "late", capacity: 10, capacityScope: "host", leaseTtlMs: TTL });
    assert.equal(out.reason, "granted");
    assert.equal(out.claimed?.ticketId, "FG-1");
  });

  test("the store-level backstop: idx_queue_claims_live rejects a second live claim even without the CAS", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO queue_claims (id, project_key, ticket_id, owner, generation, ticket_revision,
               lease_expires_at_ms, heartbeat_at_ms, state, claimed_at)
             VALUES ('rogue', ?, 'FG-1', 'rogue-owner', 99, 1, 0, 0, 'live', ?)`,
          )
          .run(PK, NOW),
      /UNIQUE/i,
      "two processes that both read 'no live claim' cannot both insert",
    );
    // A RELEASED row under the same ticket is history and is deliberately allowed.
    releaseClaim({ projectKey: PK, claimId: first.claimed!.id, owner: "ctl-1", generation: 1, outcome: "done" });
    assert.doesNotThrow(() =>
      db
        .prepare(
          `INSERT INTO queue_claims (id, project_key, ticket_id, owner, generation, ticket_revision,
             lease_expires_at_ms, heartbeat_at_ms, state, claimed_at)
           VALUES ('history', ?, 'FG-1', 'someone', 98, 1, 0, 0, 'released', ?)`,
        )
        .run(PK, NOW),
    );
  });
});

// ─── lease, fencing generation, takeover history ────────────────────────────

describe("lease, fencing and takeover", () => {
  test("heartbeat renews under an owner+generation CAS; a stale generation renews NOTHING", () => {
    seedQueued(["FG-1"]);
    const out = claimNext();
    const claim = out.claimed!;
    setPublicationClockOffsetForTest(1_000);
    const renewed = heartbeatClaim({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, leaseTtlMs: TTL });
    assert.ok(renewed);
    assert.ok(renewed!.leaseExpiresAtMs > claim.leaseExpiresAtMs, "the lease moved forward");

    assert.equal(
      heartbeatClaim({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 99, leaseTtlMs: TTL }),
      null,
      "a stale generation renews nothing",
    );
    assert.equal(
      heartbeatClaim({ projectKey: PK, claimId: claim.id, owner: "someone-else", generation: 1, leaseTtlMs: TTL }),
      null,
      "another owner renews nothing",
    );
  });

  test("a takeover RETIRES its predecessor with launch identity intact and inserts generation+1", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();
    const original = first.claimed!;
    // The launch identity is durable BEFORE any physical launch, so a takeover
    // discovers the prior launch DIRECTLY rather than finding an empty slot.
    const stamped = recordClaimLaunch({
      projectKey: PK,
      claimId: original.id,
      owner: "ctl-1",
      generation: 1,
      launchId: "launch-A",
      runId: "run-A",
    });
    assert.equal(stamped!.launchId, "launch-A");

    setPublicationClockOffsetForTest(TTL + 1);
    const takeover = takeoverExpiredClaim({ projectKey: PK, claimId: original.id, owner: "ctl-2", leaseTtlMs: TTL });
    assert.ok(takeover.claimed);
    assert.equal(takeover.claimed!.generation, 2, "the fencing token is bumped");

    const predecessor = getClaim(PK, original.id)!;
    assert.equal(predecessor.state, "released", "retired, never deleted and never overwritten");
    assert.equal(predecessor.outcome, TAKEOVER_OUTCOME);
    assert.equal(predecessor.launchId, "launch-A", "the prior launch identity SURVIVES the takeover");
    assert.equal(predecessor.runId, "run-A");
    assert.equal(takeover.claimed !== null ? takeover.takenOverFrom.launchId : null, "launch-A", "and is handed to the successor's owner directly");

    // The stale owner is fenced out of every mutating verb.
    assert.equal(claimIsStillHeld({ projectKey: PK, claimId: original.id, owner: "ctl-1", generation: 1 }), false);
    assert.equal(heartbeatClaim({ projectKey: PK, claimId: original.id, owner: "ctl-1", generation: 1, leaseTtlMs: TTL }), null);
    assert.equal(releaseClaim({ projectKey: PK, claimId: original.id, owner: "ctl-1", generation: 1, outcome: "x" }), null);
    assert.equal(
      recordClaimLaunch({ projectKey: PK, claimId: original.id, owner: "ctl-1", generation: 1, launchId: "zombie" }),
      null,
      "a superseded owner cannot stamp a launch",
    );
    assert.equal(getClaim(PK, original.id)!.outcome, TAKEOVER_OUTCOME, "and none of those changed a row");

    const history = claimHistoryForTicket(PK, "FG-1");
    assert.deepEqual(history.map((c) => [c.generation, c.state]), [[1, "released"], [2, "live"]]);
  });

  test("a PARTIAL launch stamp writes ONLY the field it was given and never clears the other", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;

    // The two halves of the born-under linkage become known at different moments, so
    // they are stamped in two separate calls. Both must survive.
    const afterLaunch = recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, launchId: "launch-A" });
    assert.equal(afterLaunch!.launchId, "launch-A");
    assert.equal(afterLaunch!.runId, null, "the half that was not supplied is untouched, not written");

    const afterRun = recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, runId: "run-A" });
    assert.equal(afterRun!.runId, "run-A");
    assert.equal(afterRun!.launchId, "launch-A", "the SECOND stamp did not clear the first — this is the whole defect");
    assert.equal(getClaim(PK, claim.id)!.launchId, "launch-A", "and it is durable, not merely in the return value");
    assert.equal(getClaim(PK, claim.id)!.runId, "run-A");

    // FALSIFICATION: the pre-fix UPDATE bound BOTH columns on every call, so the
    // run-id-only stamp above wrote launch_id = NULL. Without seeing the mutant erase
    // it, the assertion above cannot tell "the partial stamp is correct" from "the
    // test happened to pass both fields".
    db.prepare(`UPDATE queue_claims SET launch_id = ?, run_id = ? WHERE id = ?`).run(null, "run-A", claim.id);
    assert.equal(
      getClaim(PK, claim.id)!.launchId,
      null,
      "FALSIFICATION: the pre-fix two-column UPDATE destroys the born-under launch linkage recovery rests on",
    );
  });

  test("the launch stamp is WRITE-ONCE per generation: an identical re-stamp is idempotent, a conflicting one refuses BY NAME", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    const stamp = (over: { launchId?: string; runId?: string }) =>
      recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, ...over });

    stamp({ launchId: "launch-A", runId: "run-A" });
    // A retry after a crash between the write and its ack is a real sequence.
    assert.equal(stamp({ launchId: "launch-A", runId: "run-A" })!.launchId, "launch-A", "an identical re-stamp is idempotent");

    const before = fullDump();
    for (const [field, over] of [
      ["launchId", { launchId: "launch-B" }],
      ["runId", { runId: "run-B" }],
    ] as const) {
      assert.throws(
        () => stamp(over),
        (e: unknown) =>
          e instanceof QueueRefusal &&
          e.verb === "claim-record-launch" &&
          new RegExp(`already carries ${field}`).test((e as Error).message) &&
          /may still be RUNNING/.test((e as Error).message),
        `a conflicting ${field} must refuse BY NAME rather than orphan a container that may still be running`,
      );
    }
    assert.equal(fullDump(), before, "a refused overwrite writes NOTHING");

    // A NEW launch belongs to a new generation, which gets its own row.
    setPublicationClockOffsetForTest(TTL + 1);
    const successor = takeoverExpiredClaim({ projectKey: PK, claimId: claim.id, owner: "ctl-2", leaseTtlMs: TTL }).claimed!;
    assert.equal(
      recordClaimLaunch({ projectKey: PK, claimId: successor.id, owner: "ctl-2", generation: 2, launchId: "launch-B" })!.launchId,
      "launch-B",
    );
    assert.equal(getClaim(PK, claim.id)!.launchId, "launch-A", "and the predecessor's stamp is still its own");
  });

  test("a launch stamp carrying NEITHER field refuses by name rather than clearing both", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    const before = fullDump();
    assert.throws(
      () => recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1 }),
      (e: unknown) => e instanceof QueueRefusal && e.verb === "claim-record-launch" && /nothing to make durable/.test((e as Error).message),
    );
    assert.equal(fullDump(), before);
  });

  test("an EXPIRED lease authorizes NOBODY: claimIsStillHeld and recoverableClaims are never both true for one row", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    const heldBy = () => claimIsStillHeld({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1 });
    const isRecoverable = () => recoverableClaims("project", PK).some((c) => c.id === claim.id);

    // The reviewer's own execution: the store clock 10x the TTL past the grant.
    setPublicationClockOffsetForTest(10 * TTL);
    assert.equal(isRecoverable(), true, "the recovery surface offers this row for takeover...");
    assert.equal(heldBy(), false, "...so the pre-work fence must NOT tell its incumbent it may still drive");

    // FALSIFICATION: the pre-fix predicate — owner + generation + state, no lease
    // term — says true at this same instant. Two surfaces contradicting each other
    // about one row is the duplicate-execution vector.
    assert.notEqual(
      db
        .prepare(`SELECT 1 FROM queue_claims WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'`)
        .get(claim.id, PK, "ctl-1", 1),
      undefined,
      "FALSIFICATION: without the lease term the taken-over-eligible row still reads as authorized",
    );

    // The exclusion is not an artifact of one clock position: at every offset from
    // well inside the lease to well past it, EXACTLY ONE of the two is true.
    for (const offset of [0, TTL / 4, TTL / 2, TTL - 1, TTL + 1, 2 * TTL, 10 * TTL]) {
      setPublicationClockOffsetForTest(offset);
      assert.equal(heldBy() && isRecoverable(), false, `offset ${offset}: authorized AND takeover-eligible`);
      assert.equal(heldBy() || isRecoverable(), true, `offset ${offset}: neither authorized NOR takeover-eligible`);
    }
  });

  test("a heartbeat on a STRICTLY expired lease renews nothing, changes zero rows, and cannot pull the claim out of the recovery set", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;

    // The reviewer's execution, step for step.
    setPublicationClockOffsetForTest(10 * TTL);
    assert.equal(recoverableClaims("project", PK).length, 1, "precondition: the claim is in the recovery set");

    const before = fullDump();
    assert.equal(
      heartbeatClaim({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, leaseTtlMs: TTL }),
      null,
      "the ORIGINAL owner at the CURRENT generation still fails closed once its lease has lapsed",
    );
    assert.equal(fullDump(), before, "the refused heartbeat changed zero rows");
    assert.equal(recoverableClaims("project", PK).length, 1, "and did not resurrect the claim out of the recovery set");

    // Which is what keeps recovery available rather than deadlocked behind a zombie.
    assert.ok(
      takeoverExpiredClaim({ projectKey: PK, claimId: claim.id, owner: "ctl-2", leaseTtlMs: TTL }).claimed,
      "a takeover after the refused heartbeat is NOT turned away with 'live_lease'",
    );

    // FALSIFICATION: the pre-fix CAS had no expiry term, so it matched and renewed.
    const successor = liveClaims(PK)[0]!;
    setPublicationClockOffsetForTest(20 * TTL);
    assert.equal(
      db
        .prepare(
          `UPDATE queue_claims SET lease_expires_at_ms = 1
            WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'`,
        )
        .run(successor.id, PK, successor.owner, successor.generation).changes,
      1,
      "FALSIFICATION: without the expiry term a dead lease renews itself back out of the recovery set",
    );
  });

  test("the expired-lease fence covers the WHOLE owner-authorized surface, one audit rather than one verb at a time", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    setPublicationClockOffsetForTest(10 * TTL);

    const before = fullDump();
    const fenced = { projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1 };
    assert.equal(claimIsStillHeld(fenced), false, "the pre-work fence");
    assert.equal(heartbeatClaim({ ...fenced, leaseTtlMs: TTL }), null, "the renewal");
    assert.equal(recordClaimLaunch({ ...fenced, launchId: "launch-A" }), null, "the durable pre-launch stamp");
    assert.equal(releaseClaim({ ...fenced, outcome: "completed" }), null, "the retirement");
    assert.equal(fullDump(), before, "not one of the four wrote a row");
    assert.equal(
      recoverableClaims("project", PK).length,
      1,
      "and at that same instant the row is takeable — the authorization and recovery surfaces never contradict",
    );
  });

  test("an EXPIRED owner cannot STAMP a launch: the pre-launch record fails closed exactly like the heartbeat", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    setPublicationClockOffsetForTest(10 * TTL);

    const before = fullDump();
    assert.equal(
      recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, launchId: "launch-A", runId: "run-A" }),
      null,
      "a lapsed lease authorizes nothing, and this is the act a physical launch follows",
    );
    assert.equal(fullDump(), before, "the refused stamp changed zero rows");
    assert.equal(getClaim(PK, claim.id)!.launchId, null);

    // FALSIFICATION: the pre-fix CAS — owner + generation + state, no lease term —
    // stamps it, so an expired owner is recorded as launching a container for a claim
    // the recovery surface is offering for takeover at that same instant.
    assert.equal(
      db
        .prepare(
          `UPDATE queue_claims SET launch_id = ?
            WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'`,
        )
        .run("launch-A", claim.id, PK, "ctl-1", 1).changes,
      1,
      "FALSIFICATION: without the lease term an expired owner stamps the launch it is not authorized to make",
    );
    assert.equal(recoverableClaims("project", PK).length, 1, "...while the same row is takeable");
  });

  test("an EXPIRED owner cannot RELEASE: retiring the row would delete the recovery record for a container that may still be running", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, launchId: "launch-A", runId: "run-A" });
    setPublicationClockOffsetForTest(10 * TTL);
    assert.equal(recoverableClaims("project", PK).length, 1, "precondition: the claim is the recovery record");

    const before = fullDump();
    assert.equal(
      releaseClaim({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, outcome: "completed" }),
      null,
      "the ORIGINAL owner at the CURRENT generation fails closed once its lease has lapsed",
    );
    assert.equal(fullDump(), before, "the refused release changed zero rows");
    assert.equal(recoverableClaims("project", PK).length, 1, "and the recovery record survives");

    // FALSIFICATION, in two halves. (a) The pre-fix CAS matches and retires the row.
    assert.equal(
      db
        .prepare(
          `UPDATE queue_claims SET state = 'released', outcome = ?, released_at = ?
            WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'`,
        )
        .run("completed", NOW, claim.id, PK, "ctl-1", 1).changes,
      1,
      "FALSIFICATION: without the lease term an expired owner retires its own claim",
    );
    // (b) The consequence, which is the whole finding: the next claimant is admitted
    // as a FRESH claim — no takenOverFrom, no prior launch identity — so it launches a
    // second container for work whose first container may still be running. Expiry
    // proves heartbeating stopped, never that the process stopped.
    const successor = claimNext({ owner: "ctl-2" });
    assert.equal(successor.reason, "granted");
    assert.equal(successor.takenOverFrom, null, "FALSIFICATION: recovery was bypassed — no predecessor to adopt");
    assert.equal(successor.claimed!.launchId, null, "FALSIFICATION: and no pointer to the container still holding launch-A");
  });

  test("the way back in for an expired owner is a TAKEOVER, which preserves the record it would have erased", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, launchId: "launch-A" });
    setPublicationClockOffsetForTest(10 * TTL);

    const recovered = takeoverExpiredClaim({ projectKey: PK, claimId: claim.id, owner: "ctl-1", leaseTtlMs: TTL });
    assert.equal(recovered.claimed?.generation, 2, "the fencing generation is bumped, even for the same owner");
    assert.equal(recovered.claimed !== null ? recovered.takenOverFrom.launchId : null, "launch-A", "the prior launch is handed over, not erased");
    assert.ok(
      releaseClaim({ projectKey: PK, claimId: recovered.claimed!.id, owner: "ctl-1", generation: 2, outcome: "completed" }),
      "and the recoverer, holding a LIVE lease, releases normally",
    );
    assert.deepEqual(
      claimHistoryForTicket(PK, "FG-1").map((c) => [c.generation, c.state, c.outcome]),
      [
        [1, "released", TAKEOVER_OUTCOME],
        [2, "released", "completed"],
      ],
    );
  });

  test("claimIsStillHeld is the pre-work re-check, and it is a pure read", () => {
    seedQueued(["FG-1"]);
    const out = claimNext();
    const before = fullDump();
    assert.equal(claimIsStillHeld({ projectKey: PK, claimId: out.claimed!.id, owner: "ctl-1", generation: 1 }), true);
    assert.equal(fullDump(), before, "the re-check writes nothing");
  });

  test("recoverableClaims returns only STRICTLY expired live claims", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimNext();
    assert.deepEqual(recoverableClaims("project", PK), [], "a live lease is not recoverable");

    // Half a TTL later a second controller claims FG-2 (FG-1 is still held).
    setPublicationClockOffsetForTest(TTL / 2);
    const second = claimNextEligible({ projectKey: PK, owner: "ctl-2", capacity: 10, capacityScope: "project", leaseTtlMs: TTL });
    assert.equal(second.claimed?.ticketId, "FG-2");

    // Past FG-1's expiry but not FG-2's: exactly one claim is recoverable.
    setPublicationClockOffsetForTest(TTL + 1);
    assert.deepEqual(
      recoverableClaims("project", PK).map((c) => c.ticketId),
      ["FG-1"],
      "the younger FG-2 lease is not recoverable; the aged FG-1 one is",
    );
  });

  test("generations are MONOTONIC per ticket, so an owner from ANY earlier claim stays fenced out", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();
    releaseClaim({ projectKey: PK, claimId: first.claimed!.id, owner: "ctl-1", generation: 1, outcome: "done" });
    const second = claimNext({ owner: "ctl-2" });
    assert.equal(second.claimed!.generation, 2, "a re-claim after a release does not reuse generation 1");
    assert.notEqual(second.claimed!.id, first.claimed!.id);
  });
});

// ─── (11) ONE CLOCK ──────────────────────────────────────────────────────────

describe("one clock", () => {
  test("offsetting the STORE clock expires a lease; offsetting the PROCESS clock does not", () => {
    seedQueued(["FG-1"]);
    const first = claimNext();

    // The PROCESS clock jumps far past the lease. Nothing about expiry moves,
    // because no lease value is ever written or compared against Date.now().
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 10 * TTL;
      assert.deepEqual(recoverableClaims("project", PK), [], "a skewed process clock must not expire a lease");
      const stolen = takeoverExpiredClaim({ projectKey: PK, claimId: first.claimed!.id, owner: "ctl-2", leaseTtlMs: TTL });
      assert.equal(stolen.claimed, null, "and must not authorize a takeover");
    } finally {
      Date.now = realNow;
    }

    // The STORE clock is the only one that counts.
    setPublicationClockOffsetForTest(TTL + 1);
    assert.deepEqual(recoverableClaims("project", PK).map((c) => c.id), [first.claimed!.id]);
  });

  test("the TTL floor is DERIVED and enforced by refusal, not by comment", () => {
    seedQueued(["FG-1"]);
    const before = fullDump();
    for (const verb of [
      () => claimNext({ leaseTtlMs: MIN_LEASE_TTL_MS - 1 }),
      () => takeoverExpiredClaim({ projectKey: PK, claimId: "any", owner: "o", leaseTtlMs: 1_000 }),
      () => heartbeatClaim({ projectKey: PK, claimId: "any", owner: "o", generation: 1, leaseTtlMs: 1_000 }),
    ]) {
      assert.throws(verb, (e: unknown) => e instanceof QueueRefusal && /below the derived floor/.test((e as Error).message));
    }
    assert.equal(fullDump(), before, "a refused TTL writes nothing");
  });
});

// ─── (14) recovery evidence survives an operator action ─────────────────────

describe("recovery evidence survives operator actions", () => {
  test("dequeue removes the membership row and leaves the claim, its lease and its launch identity intact", () => {
    seedQueued(["FG-1"]);
    const out = claimNext();
    recordClaimLaunch({
      projectKey: PK,
      claimId: out.claimed!.id,
      owner: "ctl-1",
      generation: 1,
      launchId: "launch-A",
      runId: "run-A",
    });

    dequeueTicket(PK, "FG-1");
    assert.equal(
      db.prepare(`SELECT 1 FROM queue_membership WHERE project_key = ? AND ticket_id = 'FG-1'`).get(PK),
      undefined,
      "precondition: the operator really did dequeue it",
    );
    const claim = getClaim(PK, out.claimed!.id);
    assert.ok(claim, "the recovery record for a container that may still be executing SURVIVES");
    assert.equal(claim!.state, "live");
    assert.equal(claim!.launchId, "launch-A");
    assert.equal(claim!.runId, "run-A");
  });

  // E10: assert E2, do not merely inherit it. For EACH of dequeue, unrank and defer
  // applied to a CLAIMED ticket: the claim row survives, its live state and its
  // owner / generation / lease_expires_at_ms are byte-unchanged, AND a second claimer
  // attempting that same ticket is still refused with `already_claimed`.
  //
  // The third assertion is the load-bearing one, and it needs the ticket to be
  // SCANNABLE to mean anything. Straight after a dequeue the ticket is out of the
  // scan's candidate set, so a second claimer is refused `not_a_queue_member` —
  // which would still be reported if the operator verb had wrongly RELEASED the
  // claim, and the regression E2 exists to prevent would sail through. So each case
  // also runs the operator's own undo (they changed their mind while the container is
  // still executing), putting the ticket back in front of a second claimer. If the
  // verb had released the live claim, THAT is where a second grant — a duplicate
  // execution — appears.
  const operatorActions: [
    string,
    { apply: () => void; undo: () => void; reasonWhileApplied: ScanReason | undefined },
  ][] = [
    [
      "dequeue",
      {
        apply: () => void dequeueTicket(PK, "FG-1"),
        undo: () => assert.equal(enqueueTicket(PK, "FG-1").ok, true),
        reasonWhileApplied: "not_a_queue_member",
      },
    ],
    [
      "unrank",
      {
        // unrankTicket REFUSES a queued ticket by name, so the real operator sequence
        // is dequeue-then-unrank; both verbs are applied to a live-claimed ticket.
        apply: () => {
          dequeueTicket(PK, "FG-1");
          unrankTicket(PK, "FG-1");
        },
        undo: () => {
          rankTicket(PK, "FG-1", 1);
          assert.equal(enqueueTicket(PK, "FG-1").ok, true);
        },
        // Neither ranked nor queued, so it is outside the scan DOMAIN altogether —
        // not an exclusion that needs naming, but a ticket that is no longer in the
        // queue in any sense. The claim over it still exists, which is the point.
        reasonWhileApplied: undefined,
      },
    ],
    [
      "defer",
      {
        apply: () => writeTransaction(() => upsertTicket(ticket("FG-1", { status: "deferred" }))),
        undo: () => writeTransaction(() => upsertTicket(ticket("FG-1", { status: "active" }))),
        reasonWhileApplied: "deferred",
      },
    ],
  ];

  for (const [verb, action] of operatorActions) {
    test(`E10: ${verb} on a CLAIMED ticket leaves the claim byte-unchanged, and a second claimer is still refused already_claimed`, () => {
      seedQueued(["FG-1"]);
      const claim = claimNext().claimed!;
      recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: "ctl-1", generation: 1, launchId: "launch-A", runId: "run-A" });
      const claimRow = () => JSON.stringify(db.prepare(`SELECT * FROM queue_claims WHERE id = ?`).get(claim.id));
      const before = claimRow();

      action.apply();

      // 1 — the row survives, and 2 — it is still live with owner, generation and
      // lease_expires_at_ms byte-unchanged. Compared as the whole row, so a verb that
      // touched any column at all fails here rather than only the three checked ones.
      const survived = getClaim(PK, claim.id);
      assert.ok(survived, `${verb} must not delete the recovery record of a container that may still be executing`);
      assert.equal(survived!.state, "live");
      assert.equal(survived!.owner, "ctl-1");
      assert.equal(survived!.generation, 1);
      assert.equal(survived!.leaseExpiresAtMs, claim.leaseExpiresAtMs);
      assert.equal(survived!.launchId, "launch-A");
      assert.equal(survived!.runId, "run-A");
      assert.equal(claimRow(), before, `${verb} left the claim row byte-unchanged`);

      // While the verb is applied the ticket is not a candidate at all, and the
      // exclusion is NAMED as the operator's action rather than as a claim.
      const whileApplied = claimNextEligible({ projectKey: PK, owner: "ctl-2", capacity: 10, capacityScope: "project", leaseTtlMs: TTL });
      assert.equal(whileApplied.claimed, null, `${verb} must not open the ticket to a second claimer`);
      assert.equal(
        reasonFor(whileApplied.scanned, "FG-1"),
        action.reasonWhileApplied,
        `${verb} keeps FG-1 out of a second claimer's reach — but by the OPERATOR verb, which is why the undo below is what proves the claim did the fencing`,
      );

      // 3 — THE LOAD-BEARING ONE. The operator puts it back; the live claim must
      // still fence a second claimer, by the already_claimed reason specifically.
      action.undo();
      const afterUndo = claimNextEligible({ projectKey: PK, owner: "ctl-2", capacity: 10, capacityScope: "project", leaseTtlMs: TTL });
      assert.equal(afterUndo.claimed, null, `a second claimer must NOT be granted FG-1 across a ${verb}`);
      assert.equal(
        reasonFor(afterUndo.scanned, "FG-1"),
        "already_claimed",
        `${verb} must not release the live claim — this is the assertion that fails if it ever does`,
      );
      assert.match(afterUndo.scanned.find((s) => s.ticketId === "FG-1")!.detail!, /held by ctl-1 \(generation 1\)/);
      assert.equal(liveClaims(PK).filter((c) => c.ticketId === "FG-1").length, 1, "still exactly one live claim");
      assert.equal(claimRow(), before, `and the whole ${verb} + undo sequence changed nothing about the claim`);
    });
  }

  test("deleting the TICKET row leaves the claim history intact (no cascading foreign key)", () => {
    seedQueued(["FG-1"]);
    const out = claimNext();
    db.pragma("foreign_keys = ON");
    db.prepare(`DELETE FROM tickets WHERE project_key = ? AND ticket_id = 'FG-1'`).run(PK);
    assert.ok(getClaim(PK, out.claimed!.id), "an FK would have erased the evidence a takeover needs");
  });
});

// ─── E1: the counting scope fails CLOSED, in BOTH scopes ────────────────────

describe("E1: a scoped claim read with no project_key refuses BY NAME rather than answering empty", () => {
  const scopedReads: [string, (scope: CapacityScope, pk: string | undefined) => unknown][] = [
    ["claim-live-in-scope", (scope, pk) => liveClaimsInScope(scope, pk)],
    ["claim-recoverable", (scope, pk) => recoverableClaims(scope, pk)],
    ["claim-count", (scope, pk) => liveClaimCount(scope, pk as string)],
  ];

  for (const scope of ["project", "host"] as const) {
    test(`${scope} scope: an absent project_key is a named refusal, not an empty answer`, () => {
      seedQueued(["FG-1"]);
      assert.ok(claimNext().claimed, "there IS something to find, so an empty answer would be a lie");

      for (const [verb, read] of scopedReads) {
        // undefined and "" are the same fail-open wearing two hats: the second is what
        // the removed `projectKey ?? ""` fallback turned the first into.
        for (const absent of [undefined, ""]) {
          assert.throws(
            () => read(scope, absent),
            (e: unknown) =>
              e instanceof QueueRefusal &&
              e.verb === verb &&
              /needs the project_key of the project asking/.test((e as Error).message) &&
              /Nothing was read/.test((e as Error).message),
            `${verb} in ${scope} scope must refuse BY NAME on a ${absent === undefined ? "missing" : "blank"} project_key`,
          );
        }
      }
    });
  }

  test("FALSIFICATION: the pre-fix fallback answers 'nothing to recover' for a project that HAS a live claim", () => {
    seedQueued(["FG-1"]);
    const claim = claimNext().claimed!;
    setPublicationClockOffsetForTest(TTL + 1);
    assert.deepEqual(recoverableClaims("project", PK).map((c) => c.id), [claim.id], "the truth: one claim is recoverable");

    // `liveClaims(projectKey ?? "")` — the removed fallback — queries project_key = ''
    // and returns []. A recovery read surface that answers "nothing to recover" when
    // it means "you did not tell me which project" is the exact fail-open E1 forbids.
    assert.deepEqual(
      db.prepare(`SELECT id FROM queue_claims WHERE project_key = '' AND state = 'live'`).all(),
      [],
      "FALSIFICATION: the empty-key query is silently empty, so the fallback could never have refused",
    );
  });

  test("a supplied project_key is still D6-guarded in HOST scope, where the count spans every project", () => {
    seedQueued(["FG-1"], PK);
    seedQueued(["FG-9"], PK2);
    assert.ok(claimNextEligible({ projectKey: PK2, owner: "b", capacity: 1, capacityScope: "project", leaseTtlMs: TTL }).claimed);
    assert.equal(liveClaimCount("host", PK), 1, "host scope answers across projects for the project that asked");

    db.prepare(`UPDATE ticket_storage_mode SET mode = 'markdown' WHERE project_key = ?`).run(PK);
    assert.throws(() => liveClaimCount("host", PK), QueueRefusal, "and the asking project is still the one D6 resolves");
    assert.throws(() => liveClaimsInScope("host", PK), QueueRefusal);
    assert.throws(() => recoverableClaims("host", PK), QueueRefusal);
  });
});

// ─── (15) the FG-609 D6 guard, on EVERY entry point ─────────────────────────

describe("D6: the queue is DB-mode only, and every entry point refuses by name", () => {
  // EVERY export, not a sample. A read that answers "no claims" for a project the
  // store cannot resolve is the same fail-open as a write that reserves a row nothing
  // reads — and it is the more dangerous half, because a recovery caller acts on it.
  // The completeness test below is what stops this table from silently going stale
  // when a new export lands.
  const verbs: [string, keyof typeof claimsModule, () => unknown][] = [
    ["claim-next", "claimNextEligible", () => claimNextEligible({ projectKey: PK, owner: "o", capacity: 1, capacityScope: "project", leaseTtlMs: TTL })],
    ["claim-takeover", "takeoverExpiredClaim", () => takeoverExpiredClaim({ projectKey: PK, claimId: "c", owner: "o", leaseTtlMs: TTL })],
    ["claim-heartbeat", "heartbeatClaim", () => heartbeatClaim({ projectKey: PK, claimId: "c", owner: "o", generation: 1, leaseTtlMs: TTL })],
    ["claim-record-launch", "recordClaimLaunch", () => recordClaimLaunch({ projectKey: PK, claimId: "c", owner: "o", generation: 1, launchId: "l" })],
    ["claim-release", "releaseClaim", () => releaseClaim({ projectKey: PK, claimId: "c", owner: "o", generation: 1, outcome: "x" })],
    ["claim-get", "getClaim", () => getClaim(PK, "c")],
    ["claim-live", "liveClaims", () => liveClaims(PK)],
    ["claim-live-in-scope", "liveClaimsInScope", () => liveClaimsInScope("project", PK)],
    ["claim-count", "liveClaimCount", () => liveClaimCount("project", PK)],
    ["claim-recoverable", "recoverableClaims", () => recoverableClaims("project", PK)],
    ["claim-history", "claimHistoryForTicket", () => claimHistoryForTicket(PK, "FG-1")],
    ["claim-is-still-held", "claimIsStillHeld", () => claimIsStillHeld({ projectKey: PK, claimId: "c", owner: "o", generation: 1 })],
  ];

  test("the verb table covers EVERY exported entry point of the module, not a sample", () => {
    // The test seam is deliberately unguarded: it is armed only from a test and takes
    // no project. Everything else that is a function must be in the table above.
    const seams = new Set(["setClaimPhaseHookForTest"]);
    const covered = new Set(verbs.map(([, name]) => name as string));
    const exported = Object.entries(claimsModule)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .filter((k) => !seams.has(k));
    assert.deepEqual(
      exported.filter((k) => !covered.has(k)).sort(),
      [],
      "an exported entry point with no D6 coverage — add it to the verb table, don't let the guard shrink silently",
    );
    assert.deepEqual(
      [...covered].filter((k) => !exported.includes(k)).sort(),
      [],
      "the verb table names something the module no longer exports",
    );
  });

  test("a MARKDOWN-mode project is refused by name on every entry point, and nothing is written", () => {
    seedQueued(["FG-1"]);
    db.prepare(`UPDATE ticket_storage_mode SET mode = 'markdown' WHERE project_key = ?`).run(PK);
    const before = fullDump();
    for (const [verb, , run] of verbs) {
      assert.throws(
        run,
        (e: unknown) =>
          e instanceof QueueRefusal &&
          e.verb === verb &&
          /markdown' storage mode/.test((e as Error).message) &&
          /forge backlog migrate/.test((e as Error).message),
        `${verb} must refuse BY NAME and name the way forward`,
      );
    }
    assert.equal(fullDump(), before);
  });

  test("a project with NO project_identity row is refused by name on every entry point", () => {
    seedQueued(["FG-1"]);
    db.prepare(`DELETE FROM project_identity WHERE project_key = ?`).run(PK);
    for (const [verb, , run] of verbs) {
      assert.throws(
        run,
        (e: unknown) => e instanceof QueueRefusal && e.verb === verb && /no project_identity row/.test((e as Error).message),
        `${verb} must refuse a project with no resolvable identity`,
      );
    }
  });
});

// ─── (16) source-level guards ────────────────────────────────────────────────

test("queue-claims.ts calls no markBacklogDirty and opens no transaction outside writeTransaction", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "queue-claims.ts"), "utf8");
  assert.equal(/markBacklogDirty\s*\(/.test(src), false, "queue state has no container consumer in this slice");
  assert.equal(/\bdb\.transaction\b/.test(src), false, "no second transaction mechanism");
  assert.equal(/\bBEGIN\b/.test(src.replace(/BEGIN IMMEDIATE/g, "")), false, "no hand-rolled transaction control");
  assert.equal(/Date\.now\(\)/.test(src), false, "THE CLOCK RULE: lease values come from storeNowMs only");
});
