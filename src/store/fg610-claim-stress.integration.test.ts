// FG-610 verify: the repeated HOST STRESS LOOP for the three concurrency-critical
// races — duplicate claim, capacity ceiling, and expired-lease takeover.
//
// WHY REPETITION IS PART OF THE EVIDENCE. A single green execution of a concurrency
// primitive is not evidence: it shows one interleaving happened to work. These loops
// drive MANY interleavings of claim / heartbeat / clock-advance / takeover / release
// and assert the invariant AT EVERY OBSERVED INSTANT rather than only at the end.
// better-sqlite3 serializes writers on BEGIN IMMEDIATE, so each iteration exercises a
// distinct ordering of the owner+generation-fenced CAS against the store clock.
//
// LEASES ARE AGED BY MOVING THE STORE CLOCK (setPublicationClockOffsetForTest), never
// by sleeping — src/campaign/fg564-lease-stress.integration.test.ts is the precedent.
// A sleeping stress loop is a slow stress loop, and a slow one gets run less often.
//
// The ITERATION COUNTS BELOW ARE ASSERTED IN SOURCE, not left in a comment, so this
// file cannot silently become a smoke test.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { upsertTicket } from "./tickets.js";
import { enqueueTicket, rankTicket } from "./queue.js";
import {
  claimNextEligible,
  claimIsStillHeld,
  getClaim,
  heartbeatClaim,
  liveClaimCount,
  liveClaims,
  recordClaimLaunch,
  recoverableClaims,
  releaseClaim,
  takeoverExpiredClaim,
  MIN_LEASE_TTL_MS,
  TAKEOVER_OUTCOME,
  type CapacityScope,
  type QueueClaim,
} from "./queue-claims.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";

/** The stress bar. Asserted, not commented — see the header. */
const ITERATIONS = 200;
const MIN_REQUIRED_ITERATIONS = 100;

const PK = "pk-stress";
const NOW = "2026-08-05T00:00:00Z";
const TTL = MIN_LEASE_TTL_MS;
const OWNERS = ["ctl-a", "ctl-b", "ctl-c", "ctl-d"];

const READY_BODY = [
  "## Problem",
  "Contended under repetition.",
  "",
  "## Goal",
  "The invariant holds at every instant.",
  "",
  "## Acceptance Criteria",
  "- it holds",
].join("\n");

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setPublicationClockOffsetForTest(0);
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, 'stress-evidence', 'path', ?)`,
  ).run(PK, NOW);
  db.prepare(`INSERT OR REPLACE INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', ?)`).run(PK, NOW);
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

function seedQueue(n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => `FG-${i + 1}`);
  writeTransaction(() => {
    for (const id of ids) {
      upsertTicket({
        projectKey: PK,
        ticketId: id,
        type: "story",
        status: "active",
        title: `stressed ${id}`,
        body: READY_BODY,
        importedAt: NOW,
      });
    }
  });
  for (const id of ids) {
    rankTicket(PK, id);
    assert.equal(enqueueTicket(PK, id).ok, true);
  }
  return ids;
}

function claim(owner: string, capacity: number, scope: CapacityScope = "project"): ReturnType<typeof claimNextEligible> {
  return claimNextEligible({ projectKey: PK, owner, capacity, capacityScope: scope, leaseTtlMs: TTL });
}

/** Every live claim that its own (owner, generation) is still AUTHORIZED to drive.
 *  Note what this is NOT: the set of live claims. A live claim whose lease has
 *  lapsed is still a row — it is simply nobody's to drive until a takeover bumps the
 *  fencing generation. Keeping the two sets distinct is the whole point. */
function authorizedDrivers(): QueueClaim[] {
  return liveClaims(PK).filter((c) =>
    claimIsStillHeld({ projectKey: PK, claimId: c.id, owner: c.owner, generation: c.generation }),
  );
}

/** THE PRE-FIX PREDICATE, verbatim: owner + generation + state, with NO lease-expiry
 *  term. Kept as a MUTANT rather than deleted, because "no driver is authorized in
 *  the expiry window" is only evidence if the window is one where a plausible wrong
 *  implementation says the opposite. This one does, and the sampler proves it does
 *  at the same instant the real predicate says false. */
function preFixIsStillHeld(claim: QueueClaim): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM queue_claims
          WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'`,
      )
      .get(claim.id, PK, claim.owner, claim.generation) !== undefined
  );
}

/** AUTHORIZED and TAKEOVER-ELIGIBLE partition the live claims: never both (two
 *  controllers would believe they hold the ticket), never neither (a live row nobody
 *  may drive and nobody may recover is a leaked capacity slot). Asserted at every
 *  observed instant, not merely at the end. */
function assertAuthorizedAndRecoverablePartitionLiveClaims(where: string): void {
  const recoverable = new Set(recoverableClaims("project", PK).map((c) => c.id));
  for (const c of liveClaims(PK)) {
    const held = claimIsStillHeld({ projectKey: PK, claimId: c.id, owner: c.owner, generation: c.generation });
    assert.equal(held && recoverable.has(c.id), false, `${where}: ${c.id} is BOTH authorized and takeover-eligible`);
    assert.equal(held || recoverable.has(c.id), true, `${where}: ${c.id} is NEITHER authorized nor takeover-eligible`);
  }
}

/** At most one LIVE claim per ticket, observed right now. The partial unique index
 *  makes a violation impossible to store; this asserts it is also never reached. */
function assertAtMostOneLivePerTicket(): void {
  const rows = db
    .prepare(
      `SELECT ticket_id, COUNT(*) AS n FROM queue_claims
        WHERE project_key = ? AND state = 'live' GROUP BY ticket_id HAVING n > 1`,
    )
    .all(PK) as { ticket_id: string; n: number }[];
  assert.deepEqual(rows, [], "a ticket must never carry two live claims");
}

test("FG-610: the stress loops really do run at least the required number of iterations", () => {
  assert.ok(
    ITERATIONS >= MIN_REQUIRED_ITERATIONS,
    `the host stress bar is ${MIN_REQUIRED_ITERATIONS} iterations; this file runs ${ITERATIONS}`,
  );
});

// ===========================================================================
// 1) DUPLICATE-CLAIM STRESS
// ===========================================================================
describe(`duplicate-claim host stress (${ITERATIONS} iterations)`, () => {
  test("across many interleavings, a ticket is granted to EXACTLY ONE owner at a time", () => {
    const ids = seedQueue(3);
    let grants = 0;
    let refusals = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      // Vary the contention order deterministically by iteration index (no
      // Math.random — a stress loop that cannot be replayed is not evidence).
      const order = OWNERS.map((_, k) => OWNERS[(k + i) % OWNERS.length]!);
      const wonThisRound = new Map<string, string>();

      for (const owner of order) {
        const out = claim(owner, ids.length);
        assertAtMostOneLivePerTicket();
        if (out.claimed) {
          grants++;
          assert.equal(
            wonThisRound.has(out.claimed.ticketId),
            false,
            `${out.claimed.ticketId} was granted twice in one round (iteration ${i})`,
          );
          wonThisRound.set(out.claimed.ticketId, owner);
        } else {
          refusals++;
          // A refusal names WHY, always, and never writes.
          assert.ok(["no_eligible_candidate", "capacity", "lost"].includes(out.reason));
        }
      }

      // Every ticket ended up held by exactly one owner...
      assert.equal(wonThisRound.size, ids.length, `iteration ${i}: every ticket was claimed exactly once`);
      assert.equal(liveClaims(PK).length, ids.length);
      // ...and the losers' claim attempts are all still refused while the leases live.
      for (const owner of OWNERS) {
        assert.equal(claim(owner, ids.length).claimed, null, "no second grant while every lease is live");
      }
      assertAtMostOneLivePerTicket();

      // Release everything and go round again, so the next iteration races afresh.
      for (const c of liveClaims(PK)) {
        assert.ok(
          releaseClaim({ projectKey: PK, claimId: c.id, owner: c.owner, generation: c.generation, outcome: "cycled" }),
        );
      }
      assert.equal(liveClaims(PK).length, 0);
    }

    assert.equal(grants, ITERATIONS * ids.length, `exactly ${ITERATIONS * ids.length} grants over the whole loop`);
    assert.ok(refusals > 0, "the loop genuinely contended — some attempts were refused");
    // eslint-disable-next-line no-console
    console.log(`  [FG-610 stress] duplicate-claim: ${ITERATIONS} iterations, ${grants} grants, ${refusals} refusals, 0 double-grants`);
  });
});

// ===========================================================================
// 2) CAPACITY-CEILING STRESS — the asymmetric risk: no SQLite constraint can
//    catch a breached COUNT, so it is asserted after EVERY attempt.
// ===========================================================================
describe(`capacity-ceiling host stress (${ITERATIONS} iterations)`, () => {
  test("COUNT(live claims in scope) <= capacity at EVERY observed instant, for both scopes", () => {
    const ids = seedQueue(4);
    let breaches = 0;
    let admitted = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const capacity = (i % 3) + 1; // 1, 2, 3 — the ceiling itself varies
      const scope: CapacityScope = i % 2 === 0 ? "project" : "host";

      for (let k = 0; k < OWNERS.length + 2; k++) {
        const owner = OWNERS[(k + i) % OWNERS.length]!;
        const out = claim(owner, capacity, scope);
        if (out.claimed) admitted++;
        else assert.ok(["no_eligible_candidate", "capacity"].includes(out.reason));
        // THE INVARIANT, checked after every single attempt rather than at the end.
        const live = liveClaimCount(scope, PK);
        if (live > capacity) breaches++;
        assert.ok(live <= capacity, `iteration ${i}: ${live} live claims against a ceiling of ${capacity} (${scope})`);
        assertAtMostOneLivePerTicket();
      }

      assert.equal(liveClaimCount(scope, PK), Math.min(capacity, ids.length), `iteration ${i}: the ceiling was reached, not exceeded`);
      // Lowering the ceiling below the live count must EVICT NOTHING — capacity is an
      // admission test, never an eviction test.
      const before = liveClaims(PK).length;
      assert.equal(claim("late", 1, scope).claimed, null);
      assert.equal(liveClaims(PK).length, before, "a lowered ceiling killed nothing");

      for (const c of liveClaims(PK)) {
        releaseClaim({ projectKey: PK, claimId: c.id, owner: c.owner, generation: c.generation, outcome: "cycled" });
      }
    }

    assert.equal(breaches, 0, "the ceiling was never exceeded");
    // eslint-disable-next-line no-console
    console.log(`  [FG-610 stress] capacity: ${ITERATIONS} iterations, ${admitted} admissions, 0 over-admissions`);
  });
});

// ===========================================================================
// 3) EXPIRED-LEASE-TAKEOVER STRESS
// ===========================================================================
describe(`expired-lease-takeover host stress (${ITERATIONS} iterations)`, () => {
  test("renew vs takeover races never authorize two holders, and a live lease is never taken", () => {
    seedQueue(1);
    let offset = 0;
    let takeovers = 0;
    let refusedLive = 0;
    let windowsSampled = 0;

    /** THE INTERVAL E4 EXISTS TO SAMPLE: the incumbent's lease HAS expired and the
     *  takeover has NOT yet run. Every previous version of this loop advanced the
     *  clock and took over inside the same step, so this interval — the only one in
     *  which an expired holder could still be believed authorized — was never
     *  observed at all, and the headline assertion could not fail.
     *
     *  Nothing may drive here. The row is still live, still the only claim, and its
     *  owner and generation still match: a predicate that reads owner + generation +
     *  state alone still says "authorized", which is exactly what the mutant below
     *  demonstrates at this same instant. */
    const sampleExpiryWindow = (i: number, incumbent: QueueClaim): void => {
      assert.equal(liveClaims(PK).length, 1, `iteration ${i}: the expired claim is still the one live row`);
      assert.deepEqual(
        recoverableClaims("project", PK).map((c) => c.id),
        [incumbent.id],
        `iteration ${i}: the recovery surface offers exactly this row for takeover`,
      );
      assert.equal(
        claimIsStillHeld({
          projectKey: PK,
          claimId: incumbent.id,
          owner: incumbent.owner,
          generation: incumbent.generation,
        }),
        false,
        `iteration ${i}: an EXPIRED lease authorizes nobody — not even its own owner`,
      );
      assert.deepEqual(authorizedDrivers(), [], `iteration ${i}: NO driver is authorized in the expiry window`);
      assertAuthorizedAndRecoverablePartitionLiveClaims(`iteration ${i} (expiry window)`);

      // FALSIFICATION, at this instant: the pre-fix predicate says the incumbent IS
      // still authorized while the recovery surface is offering the same row for
      // takeover. Two surfaces contradicting each other about one row is the
      // duplicate-execution vector, and its presence here is what proves the four
      // assertions above are ones the fixed code has to earn.
      assert.equal(
        preFixIsStillHeld(incumbent),
        true,
        `iteration ${i}: FALSIFICATION — the pre-fix predicate authorizes a driver in exactly this window`,
      );

      // And a heartbeat must not RESURRECT it out of the recovery set: an incumbent
      // that has lost its lease fails closed rather than driving under a dead one.
      const rowBefore = JSON.stringify(db.prepare(`SELECT * FROM queue_claims WHERE id = ?`).get(incumbent.id));
      assert.equal(
        heartbeatClaim({
          projectKey: PK,
          claimId: incumbent.id,
          owner: incumbent.owner,
          generation: incumbent.generation,
          leaseTtlMs: TTL,
        }),
        null,
        `iteration ${i}: a heartbeat on a STRICTLY expired lease renews nothing`,
      );
      assert.equal(
        JSON.stringify(db.prepare(`SELECT * FROM queue_claims WHERE id = ?`).get(incumbent.id)),
        rowBefore,
        `iteration ${i}: the refused heartbeat changed zero rows`,
      );
      assert.equal(
        recoverableClaims("project", PK).length,
        1,
        `iteration ${i}: the claim is STILL recoverable — a heartbeat cannot pull it back out of the recovery set`,
      );
      windowsSampled++;
    };

    // The incumbent.
    const first = claim("ctl-a", 5);
    assert.equal(first.reason, "granted");
    let holder = first.claimed!;
    recordClaimLaunch({
      projectKey: PK,
      claimId: holder.id,
      owner: holder.owner,
      generation: holder.generation,
      launchId: "launch-0",
      runId: "run-0",
    });

    for (let i = 0; i < ITERATIONS; i++) {
      const mode = i % 4;
      const challenger = OWNERS[(i + 1) % OWNERS.length]!;

      if (mode === 0) {
        // The incumbent renews, then the clock advances a little — the lease stays live.
        assert.ok(
          heartbeatClaim({
            projectKey: PK,
            claimId: holder.id,
            owner: holder.owner,
            generation: holder.generation,
            leaseTtlMs: TTL,
          }),
          `iteration ${i}: the incumbent must be able to renew`,
        );
        offset += Math.floor(TTL / 4);
        setPublicationClockOffsetForTest(offset);
        const attempt = takeoverExpiredClaim({ projectKey: PK, claimId: holder.id, owner: challenger, leaseTtlMs: TTL });
        assert.equal(attempt.claimed, null, `iteration ${i}: a renewed lease is NOT stealable`);
        refusedLive++;
      } else if (mode === 1) {
        // A challenger races claim-next while the lease is live — refused, and the
        // incumbent's row is byte-unchanged.
        const rowBefore = JSON.stringify(db.prepare(`SELECT * FROM queue_claims WHERE id = ?`).get(holder.id));
        const out = claim(challenger, 5);
        assert.equal(out.claimed, null, `iteration ${i}: claim-next must not steal a live lease`);
        assert.equal(JSON.stringify(db.prepare(`SELECT * FROM queue_claims WHERE id = ?`).get(holder.id)), rowBefore);
        refusedLive++;
      } else if (mode === 2) {
        // The clock jumps past expiry and the challenger recovers it through the
        // explicit takeover verb — with the window between the two SAMPLED, not
        // stepped over.
        offset += TTL + 1;
        setPublicationClockOffsetForTest(offset);
        sampleExpiryWindow(i, holder);
        const out = takeoverExpiredClaim({ projectKey: PK, claimId: holder.id, owner: challenger, leaseTtlMs: TTL });
        assert.ok(out.claimed, `iteration ${i}: a STRICTLY expired lease must be recoverable`);
        const predecessor = getClaim(PK, holder.id)!;
        assert.equal(predecessor.state, "released");
        assert.equal(predecessor.outcome, TAKEOVER_OUTCOME);
        assert.equal(predecessor.launchId, "launch-0", "the prior launch identity survives every takeover");
        assert.equal(out.claimed!.generation, holder.generation + 1, "the fencing token is bumped");
        // The superseded owner is fenced out of every mutating verb.
        assert.equal(
          claimIsStillHeld({ projectKey: PK, claimId: holder.id, owner: holder.owner, generation: holder.generation }),
          false,
        );
        assert.equal(
          heartbeatClaim({
            projectKey: PK,
            claimId: holder.id,
            owner: holder.owner,
            generation: holder.generation,
            leaseTtlMs: TTL,
          }),
          null,
          "a stale generation renews nothing",
        );
        assert.equal(
          releaseClaim({
            projectKey: PK,
            claimId: holder.id,
            owner: holder.owner,
            generation: holder.generation,
            outcome: "zombie",
          }),
          null,
          "a stale generation releases nothing",
        );
        holder = out.claimed!;
        recordClaimLaunch({
          projectKey: PK,
          claimId: holder.id,
          owner: holder.owner,
          generation: holder.generation,
          launchId: "launch-0",
          runId: "run-0",
        });
        takeovers++;
      } else {
        // The clock jumps past expiry and claim-next itself recovers it, which must
        // be capacity-neutral even with the ceiling exactly full.
        offset += TTL + 1;
        setPublicationClockOffsetForTest(offset);
        sampleExpiryWindow(i, holder);
        const liveBefore = liveClaimCount("project", PK);
        const out = claim(challenger, liveBefore);
        assert.equal(out.reason, "granted", `iteration ${i}: recovery must work at a full ceiling`);
        assert.ok(out.claimed !== null && out.takenOverFrom, "the grant recovered rather than admitted");
        assert.equal(liveClaimCount("project", PK), liveBefore, "a takeover does not move the slot count");
        holder = out.claimed!;
        recordClaimLaunch({
          projectKey: PK,
          claimId: holder.id,
          owner: holder.owner,
          generation: holder.generation,
          launchId: "launch-0",
          runId: "run-0",
        });
        takeovers++;
      }

      // AT EVERY INSTANT once the step has settled: exactly one live claim for the
      // ticket, and exactly one (owner, generation) authorized to drive it.
      //
      // On its own this assertion is weak — cardinality 1 in, cardinality ≤1 out. It
      // earns its keep only because sampleExpiryWindow above proves the SAME
      // predicate returns 0 in the interval where the lease has lapsed, so the count
      // here tracks lease state rather than merely counting rows.
      assertAtMostOneLivePerTicket();
      assert.equal(liveClaims(PK).length, 1, `iteration ${i}: exactly one live claim`);
      const authorized = authorizedDrivers();
      assert.equal(authorized.length, 1, `iteration ${i}: exactly one authorized driver`);
      assert.equal(authorized[0]!.id, holder.id);
      assertAuthorizedAndRecoverablePartitionLiveClaims(`iteration ${i} (settled)`);
    }

    assert.ok(takeovers >= ITERATIONS / 4, `the loop performed real takeovers (${takeovers})`);
    assert.ok(refusedLive >= ITERATIONS / 4, `and refused real live-lease attempts (${refusedLive})`);
    assert.equal(windowsSampled, takeovers, "every takeover was preceded by an observation of the expiry window");
    assert.ok(windowsSampled >= ITERATIONS / 4, `the expiry window was genuinely sampled (${windowsSampled})`);
    // eslint-disable-next-line no-console
    console.log(
      `  [FG-610 stress] expired-lease takeover: ${ITERATIONS} iterations, ${takeovers} takeovers, ${refusedLive} live-lease refusals, ${windowsSampled} expiry windows sampled (0 authorized drivers in each), 0 double-holders`,
    );
  });
});
