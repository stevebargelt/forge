// FG-591 (step 5): relative ranking (rank-before / rank-after) and the reorder
// concurrency guard, against a real in-memory SQLite DB running the REAL store
// code. Covers the operator-INTENT half of AC2/AC3/AC8 and decision D11.
//
// The two things these tests are actually for, beyond "the order comes out right":
//   1. ATOMICITY of the new verbs, proven by an injected mid-renumber failure —
//      the same standard fg609-queue.test.ts holds setQueueOrder to. A correct
//      final order is not evidence of atomicity; a failure landing after some rows
//      are rewritten and before the commit is.
//   2. That a STALE expectedVersion refuses by NAME and writes nothing at all —
//      not the rank, not the queue event, not a partial anything.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { upsertTicket, type TicketRow } from "./tickets.js";
import {
  rankTicket,
  enqueueTicket,
  dequeueTicket,
  setQueueOrder,
  moveQueuePosition,
  rankBefore,
  rankAfter,
  rankedOrder,
  queueEvents,
  queueVersion,
  recheckReadiness,
  setRenumberFailureHookForTest,
  QueueRefusal,
  QUEUE_ORDER_EVENT_TYPES,
} from "./queue.js";
import { claimNextEligible, MIN_LEASE_TTL_MS } from "./queue-claims.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const PK = "pk-fg591-rank";
const NOW = "2026-08-06T00:00:00Z";

// A body evaluateReadiness (FG-382) calls READY: Problem, Goal, bulleted AC.
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
  setRenumberFailureHookForTest(null);
  registerDbProject(PK);
});

afterEach(() => {
  setRenumberFailureHookForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

/** claimNextEligible refuses a project that is not registered in DB storage mode,
 *  and one test below needs a REAL claim to prove a claim event does not move the
 *  queue version. Same fixture as fg610-queue-claims.test.ts. */
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

function seed(ids: string[]): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id));
  });
}

function ranks(): [string, number][] {
  return rankedOrder(PK).map((r) => [r.ticketId, r.rank]);
}

/** Rank every id in order, then enqueue only the ones named. The point of the
 *  split is the AC's non-queued-tickets-keep-their-slot property. */
function seedRankedAndQueued(all: string[], queued: string[]): void {
  seed(all);
  for (const id of all) rankTicket(PK, id);
  for (const id of queued) assert.equal(enqueueTicket(PK, id).ok, true, `enqueue ${id}`);
}

// ─── rank-before / rank-after produce the expected total order ───────────────

test("FG-591: rank-before and rank-after move a queued ticket to the intended slot", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3", "FG-4"], ["FG-1", "FG-2", "FG-3", "FG-4"]);
  assert.deepEqual(
    ranks(),
    [
      ["FG-1", 1],
      ["FG-2", 2],
      ["FG-3", 3],
      ["FG-4", 4],
    ],
  );

  // Move the last item to the very front.
  const before = rankBefore(PK, "FG-4", "FG-1");
  assert.deepEqual(before.queue, ["FG-4", "FG-1", "FG-2", "FG-3"]);
  assert.equal(before.position, 1);
  assert.deepEqual(ranks().map(([id]) => id), ["FG-4", "FG-1", "FG-2", "FG-3"]);
  assert.deepEqual(ranks().map(([, r]) => r), [1, 2, 3, 4], "dense 1..N is preserved");

  // Move the new front item to just after FG-2 — an "after" that moves DOWN.
  const after = rankAfter(PK, "FG-4", "FG-2");
  assert.deepEqual(after.queue, ["FG-1", "FG-2", "FG-4", "FG-3"]);
  assert.equal(after.position, 3);

  // An "after" that moves UP: FG-3 to just after FG-1.
  assert.deepEqual(rankAfter(PK, "FG-3", "FG-1").queue, ["FG-1", "FG-3", "FG-2", "FG-4"]);

  // A "before" that moves DOWN: FG-1 to just before FG-4 (the last item).
  const tail = rankBefore(PK, "FG-1", "FG-4");
  assert.deepEqual(tail.queue, ["FG-3", "FG-2", "FG-1", "FG-4"]);
  assert.equal(tail.position, 3);

  // rank-after the LAST item appends.
  assert.deepEqual(rankAfter(PK, "FG-3", "FG-4").queue, ["FG-2", "FG-1", "FG-4", "FG-3"]);
  assert.deepEqual(ranks().map(([, r]) => r), [1, 2, 3, 4]);
});

test("FG-591: a relative rank is a no-op when the ticket is already in that slot", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3"], ["FG-1", "FG-2", "FG-3"]);
  const before = ranks();
  assert.deepEqual(rankAfter(PK, "FG-2", "FG-1").queue, ["FG-1", "FG-2", "FG-3"]);
  assert.deepEqual(rankBefore(PK, "FG-2", "FG-3").queue, ["FG-1", "FG-2", "FG-3"]);
  assert.deepEqual(ranks(), before, "the committed order is byte-identical");
});

// ─── non-queued ranked tickets keep the slot they occupied ──────────────────

test("FG-591: rank-before leaves every non-queued ranked ticket in the slot it occupied", () => {
  // Ranked: FG-1..FG-5. Queued: only FG-1, FG-3, FG-5 — so the queue owns ranked
  // slots 1, 3 and 5, and FG-2 / FG-4 must not move out of slots 2 and 4.
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3", "FG-4", "FG-5"], ["FG-1", "FG-3", "FG-5"]);
  assert.deepEqual(
    ranks(),
    [
      ["FG-1", 1],
      ["FG-2", 2],
      ["FG-3", 3],
      ["FG-4", 4],
      ["FG-5", 5],
    ],
  );

  const res = rankBefore(PK, "FG-5", "FG-1");
  assert.deepEqual(res.queue, ["FG-5", "FG-1", "FG-3"], "the QUEUE order is what moved");

  // The queued members were permuted through slots 1/3/5; the non-queued tickets
  // are still at ranks 2 and 4, holding the exact positions they held before.
  assert.deepEqual(
    ranks(),
    [
      ["FG-5", 1],
      ["FG-2", 2],
      ["FG-1", 3],
      ["FG-4", 4],
      ["FG-3", 5],
    ],
  );
});

test("FG-591: rank-after leaves every non-queued ranked ticket in the slot it occupied", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3", "FG-4", "FG-5"], ["FG-2", "FG-4", "FG-5"]);
  const res = rankAfter(PK, "FG-2", "FG-5");
  assert.deepEqual(res.queue, ["FG-4", "FG-5", "FG-2"]);
  assert.deepEqual(
    ranks(),
    [
      ["FG-1", 1],
      ["FG-4", 2],
      ["FG-3", 3],
      ["FG-5", 4],
      ["FG-2", 5],
    ],
  );
});

// ─── atomicity, proven by an injected mid-renumber failure ──────────────────

test("FG-591: a failure partway through rank-before leaves the order byte-identical", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3", "FG-4"], ["FG-1", "FG-2", "FG-3", "FG-4"]);
  const before = ranks();
  const eventsBefore = queueEvents(PK).length;
  const versionBefore = queueVersion(PK);

  let rewritten = 0;
  setRenumberFailureHookForTest((n) => {
    rewritten = n;
    if (n === 2) throw new Error("injected mid-renumber failure");
  });
  assert.throws(() => rankBefore(PK, "FG-4", "FG-1"), /injected mid-renumber failure/);
  setRenumberFailureHookForTest(null);
  assert.equal(rewritten, 2, "the injection must land after real rows were rewritten");

  assert.deepEqual(ranks(), before, "the committed order is byte-identical");
  assert.deepEqual(ranks().map(([, r]) => r), [1, 2, 3, 4], "no ticket holds an intermediate rank");
  assert.equal(queueEvents(PK).length, eventsBefore, "no queue event was appended");
  assert.equal(queueVersion(PK), versionBefore, "the version did not move");
});

test("FG-591: a failure partway through rank-after rolls back identically", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3"], ["FG-1", "FG-2", "FG-3"]);
  const before = ranks();
  const eventsBefore = queueEvents(PK).length;

  setRenumberFailureHookForTest((n) => {
    if (n === 1) throw new Error("injected mid-renumber failure");
  });
  assert.throws(() => rankAfter(PK, "FG-1", "FG-3"), /injected mid-renumber failure/);
  setRenumberFailureHookForTest(null);

  assert.deepEqual(ranks(), before);
  assert.equal(queueEvents(PK).length, eventsBefore);
});

// ─── the relative verbs record INTENT, not a coordinate ─────────────────────

test("FG-591: the queue event records the relative intent and reuses the reorder type", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3"], ["FG-1", "FG-2", "FG-3"]);
  rankBefore(PK, "FG-3", "FG-1");

  const evt = queueEvents(PK, "FG-3").at(-1)!;
  assert.equal(evt.eventType, "reorder", "no second event vocabulary for the same fact");
  assert.equal(evt.payload?.placement, "before");
  assert.equal(evt.payload?.relativeTo, "FG-1");
  assert.deepEqual(evt.payload?.before, ["FG-1", "FG-2", "FG-3"]);
  assert.deepEqual(evt.payload?.after, ["FG-3", "FG-1", "FG-2"]);
  assert.equal(evt.payload?.position, 1);
});

// ─── named refusals ─────────────────────────────────────────────────────────

test("FG-591: relative ranking refuses by name on a non-queued or unknown ticket", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3"], ["FG-1", "FG-2"]);
  const before = ranks();

  // FG-3 is ranked but NOT a queue member: refused, and the refusal names the verb
  // that DOES rank an unqueued backlog item.
  assert.throws(
    () => rankBefore(PK, "FG-3", "FG-1"),
    (e: unknown) =>
      e instanceof QueueRefusal &&
      e.verb === "rank-before" &&
      e.ticketId === "FG-3" &&
      /not in the operator queue/.test(e.message) &&
      /forge backlog rank FG-3 --position/.test(e.message) &&
      // Named as a command the operator can actually type: the relative forms are
      // `forge queue` verbs, not `forge backlog` ones.
      e.message.startsWith("forge: queue rank-before refuses"),
  );

  // The REFERENCE not being queued is refused just as loudly.
  assert.throws(
    () => rankAfter(PK, "FG-1", "FG-3"),
    (e: unknown) =>
      e instanceof QueueRefusal && e.verb === "rank-after" && e.ticketId === "FG-3",
  );

  // A ticket that does not exist at all refuses as a missing ticket, not as a
  // missing queue member — the operator's actual problem is a typo.
  assert.throws(
    () => rankBefore(PK, "FG-1", "FG-999"),
    (e: unknown) => e instanceof QueueRefusal && /does not exist/.test(e.message),
  );

  assert.throws(
    () => rankBefore(PK, "FG-1", "FG-1"),
    (e: unknown) => e instanceof QueueRefusal && /relative to itself/.test(e.message),
  );

  assert.deepEqual(ranks(), before, "every refusal wrote nothing");
});

// ─── the version: what it counts, and what it deliberately does not ─────────

test("FG-591: the queue version is the max id of order-affecting events only", () => {
  assert.equal(queueVersion(PK), 0, "a queue that never moved is version 0");

  seed(["FG-1", "FG-2"]);
  rankTicket(PK, "FG-1");
  const afterRank = queueVersion(PK);
  assert.ok(afterRank > 0);

  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  const afterEnqueue = queueVersion(PK);
  assert.ok(afterEnqueue > afterRank, "an enqueue moves the version");

  // A readiness recheck records an assessment, not a move. It must NOT invalidate
  // an in-flight reorder.
  recheckReadiness(PK, "FG-1");
  assert.equal(queueVersion(PK), afterEnqueue, "a readiness event is not an order change");

  // Nor is a dispatcher claim — the whole reason the version is a filtered max.
  const claim = claimNextEligible({
    projectKey: PK,
    owner: "dispatcher-a",
    capacity: 1,
    capacityScope: "host",
    leaseTtlMs: MIN_LEASE_TTL_MS,
  });
  assert.equal(claim.reason, "granted", "the claim must actually land for this to prove anything");
  assert.ok(
    queueEvents(PK).some((e) => e.eventType === "claim"),
    "a claim event was in fact appended to the same history",
  );
  assert.equal(queueVersion(PK), afterEnqueue, "a claim is not an order change");

  // A dequeue IS.
  dequeueTicket(PK, "FG-1");
  assert.ok(queueVersion(PK) > afterEnqueue, "a dequeue moves the version");

  assert.deepEqual(
    [...QUEUE_ORDER_EVENT_TYPES],
    ["rank", "unrank", "enqueue", "dequeue", "reorder"],
    "the counted set is closed and pinned",
  );
});

test("FG-591: every reorder verb returns the version it just produced", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3"], ["FG-1", "FG-2", "FG-3"]);

  const a = setQueueOrder(PK, ["FG-3", "FG-2", "FG-1"]);
  assert.equal(a.version, queueVersion(PK));

  const b = moveQueuePosition(PK, "FG-1", 1);
  assert.ok(b.version > a.version);
  assert.equal(b.version, queueVersion(PK));

  const c = rankAfter(PK, "FG-1", "FG-2");
  assert.ok(c.version > b.version);
  assert.equal(c.version, queueVersion(PK));

  // And the returned version is immediately usable as the next expectedVersion.
  assert.deepEqual(
    rankBefore(PK, "FG-1", "FG-2", { expectedVersion: c.version }).queue,
    ["FG-3", "FG-1", "FG-2"],
  );
});

// ─── the guard: a stale version refuses by name and writes nothing ──────────

test("FG-591: a reorder carrying a stale expectedVersion refuses and leaves the order byte-identical", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3", "FG-4"], ["FG-1", "FG-2", "FG-3"]);

  // The operator's board loaded here.
  const loaded = queueVersion(PK);

  // Meanwhile someone else enqueues FG-4 — the queue moved underneath them.
  assert.equal(enqueueTicket(PK, "FG-4").ok, true);
  const orderAfterOther = ranks();
  const eventsAfterOther = queueEvents(PK).length;

  for (const [label, run] of [
    ["setQueueOrder", () => setQueueOrder(PK, ["FG-3", "FG-2", "FG-1"], { expectedVersion: loaded })],
    ["moveQueuePosition", () => moveQueuePosition(PK, "FG-3", 1, { expectedVersion: loaded })],
    ["rankBefore", () => rankBefore(PK, "FG-3", "FG-1", { expectedVersion: loaded })],
    ["rankAfter", () => rankAfter(PK, "FG-1", "FG-3", { expectedVersion: loaded })],
  ] as const) {
    assert.throws(
      run,
      (e: unknown) =>
        e instanceof QueueRefusal &&
        /moved underneath/.test(e.message) &&
        new RegExp(`queue version ${loaded}\\b`).test(e.message) &&
        /enqueue FG-4/.test(e.message) &&
        /Nothing was written/.test(e.message),
      `${label} must refuse by name`,
    );
    assert.deepEqual(ranks(), orderAfterOther, `${label} wrote no rank`);
    assert.equal(queueEvents(PK).length, eventsAfterOther, `${label} wrote no event`);
  }

  // Note what the stale submission WOULD have done: setQueueOrder's permutation
  // check is over the CURRENT queue, so a stale full ordering that omits FG-4 is
  // caught. moveQueuePosition and the relative verbs have no such backstop — a
  // stale "FG-3 to position 1" applies cleanly and silently discards the fact that
  // FG-4 arrived at the back. That is the case the version guard exists for.
  assert.deepEqual(moveQueuePosition(PK, "FG-3", 1).queue, ["FG-3", "FG-1", "FG-2", "FG-4"]);
});

test("FG-591: a fresh expectedVersion applies, and the guard is exact — not >=", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3"], ["FG-1", "FG-2", "FG-3"]);
  const fresh = queueVersion(PK);

  const res = rankBefore(PK, "FG-3", "FG-1", { expectedVersion: fresh });
  assert.deepEqual(res.queue, ["FG-3", "FG-1", "FG-2"]);

  // Replaying the SAME version now refuses: the caller's view is one move old.
  assert.throws(
    () => rankBefore(PK, "FG-2", "FG-1", { expectedVersion: fresh }),
    (e: unknown) => e instanceof QueueRefusal && /moved underneath/.test(e.message),
  );

  // A version from the future is a different failure and says so, rather than
  // being reported as staleness the operator could "fix" by reloading.
  assert.throws(
    () => rankBefore(PK, "FG-2", "FG-1", { expectedVersion: queueVersion(PK) + 500 }),
    (e: unknown) =>
      e instanceof QueueRefusal &&
      /never been past version/.test(e.message) &&
      !/moved underneath/.test(e.message),
  );

  // A malformed version refuses rather than being coerced into a comparison.
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.throws(
      () => rankBefore(PK, "FG-2", "FG-1", { expectedVersion: bad }),
      (e: unknown) => e instanceof QueueRefusal && /non-negative integer/.test(e.message),
      `expectedVersion ${bad}`,
    );
  }

  assert.deepEqual(ranks().map(([id]) => id), ["FG-3", "FG-1", "FG-2"]);
});

test("FG-591: expectedVersion 0 is a real assertion, not an opt-out", () => {
  seed(["FG-1", "FG-2"]);
  // Version 0 means "this queue has never moved" — and here it truly has not, so a
  // first rank submitted against 0 must be ACCEPTED.
  assert.equal(queueVersion(PK), 0);
  rankTicket(PK, "FG-1");
  rankTicket(PK, "FG-2");
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  assert.equal(enqueueTicket(PK, "FG-2").ok, true);

  // Now it HAS moved, so the same 0 must be refused rather than treated as absent.
  assert.throws(
    () => moveQueuePosition(PK, "FG-2", 1, { expectedVersion: 0 }),
    (e: unknown) => e instanceof QueueRefusal && /moved underneath/.test(e.message),
  );
});

// ─── omitting expectedVersion preserves today's behaviour ───────────────────

test("FG-591: omitting expectedVersion applies unconditionally, exactly as before", () => {
  seedRankedAndQueued(["FG-1", "FG-2", "FG-3"], ["FG-1", "FG-2", "FG-3"]);

  // Move the queue underneath, then submit with no version at all: it applies.
  assert.equal(dequeueTicket(PK, "FG-3").queue.length, 2);
  assert.deepEqual(setQueueOrder(PK, ["FG-2", "FG-1"]).queue, ["FG-2", "FG-1"]);
  assert.deepEqual(moveQueuePosition(PK, "FG-1", 1).queue, ["FG-1", "FG-2"]);
  assert.deepEqual(rankAfter(PK, "FG-1", "FG-2").queue, ["FG-2", "FG-1"]);

  // An explicitly-undefined option is the same as omitting it — the CLI will pass
  // through an unset flag this way, and it must not become a version-0 assertion.
  assert.deepEqual(
    moveQueuePosition(PK, "FG-1", 1, { expectedVersion: undefined }).queue,
    ["FG-1", "FG-2"],
  );
});
