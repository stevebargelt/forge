// FG-609 (FG-496 Slice D): the operator-queue primitives, against a real
// in-memory SQLite DB running the REAL store code. Covers A1, A3, A4, A5, A6, A7,
// A8, A9, A13 and A17.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import {
  upsertTicket,
  upsertSeamTicket,
  upsertBlockerEvidence,
  deleteBlockerEvidence,
  blockerEvidenceForTicket,
  getTicket,
  LEGACY_BLOCKED_SOURCE,
  type TicketRow,
} from "./tickets.js";
import { dependencyBlockerSource } from "./blocked-source.js";
import {
  rankTicket,
  unrankTicket,
  enqueueTicket,
  dequeueTicket,
  setQueueOrder,
  moveQueuePosition,
  rankedOrder,
  queueEvents,
  executableQueue,
  readinessView,
  recheckReadiness,
  setRenumberFailureHookForTest,
  QueueRefusal,
} from "./queue.js";
import { registerSnapshotTarget, resetPublishBarrierForTest } from "../backlog/snapshot.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const PK = "pk-queue";
const NOW = "2026-08-01T00:00:00Z";

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

const NOT_READY_BODY = "## Problem\nSomething is wrong.\n";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setRenumberFailureHookForTest(null);
});

afterEach(() => {
  setRenumberFailureHookForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

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

function seed(ids: string[], over: Partial<TicketRow> = {}): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id, over));
  });
}

function ranks(): { ticketId: string; rank: number }[] {
  return rankedOrder(PK);
}

function ordinal(): number {
  const row = db
    .prepare(`SELECT ordinal FROM backlog_publication_ordinal WHERE project_key = ?`)
    .get(PK) as { ordinal: number } | undefined;
  return row?.ordinal ?? 0;
}

// ─── A1: rank / unrank, dense contiguous, no gaps, no duplicates ─────────────

test("FG-609 A1: rank/unrank keep the ranked set exactly 1..N with no gaps or duplicates", () => {
  seed(["FG-1", "FG-2", "FG-3", "FG-4"]);

  rankTicket(PK, "FG-1");
  rankTicket(PK, "FG-2");
  rankTicket(PK, "FG-3");
  assert.deepEqual(ranks().map((r) => r.ticketId), ["FG-1", "FG-2", "FG-3"]);
  assert.deepEqual(ranks().map((r) => r.rank), [1, 2, 3]);

  // Insert at the front — everything below shifts, still dense.
  rankTicket(PK, "FG-4", 1);
  assert.deepEqual(ranks().map((r) => r.ticketId), ["FG-4", "FG-1", "FG-2", "FG-3"]);
  assert.deepEqual(ranks().map((r) => r.rank), [1, 2, 3, 4]);

  // Move an already-ranked ticket to the middle — no duplicate, no gap.
  rankTicket(PK, "FG-3", 2);
  assert.deepEqual(ranks().map((r) => r.ticketId), ["FG-4", "FG-3", "FG-1", "FG-2"]);
  assert.deepEqual(ranks().map((r) => r.rank), [1, 2, 3, 4]);

  // Unranking closes the gap it leaves.
  unrankTicket(PK, "FG-3");
  assert.deepEqual(ranks().map((r) => r.ticketId), ["FG-4", "FG-1", "FG-2"]);
  assert.deepEqual(ranks().map((r) => r.rank), [1, 2, 3]);

  // An unranked ticket is still a perfectly valid backlog item.
  assert.equal(getTicket(PK, "FG-3")?.priorityRank, null);
  assert.equal(getTicket(PK, "FG-3")?.status, "active");

  // Read order is stable across repeated reads.
  assert.deepEqual(ranks(), rankedOrder(PK));
});

test("FG-609 A1: a position beyond the end appends rather than creating a gap", () => {
  seed(["FG-1", "FG-2"]);
  rankTicket(PK, "FG-1");
  rankTicket(PK, "FG-2", 99);
  assert.deepEqual(ranks().map((r) => [r.ticketId, r.rank]), [["FG-1", 1], ["FG-2", 2]]);
});

test("FG-609: equal ranks read back in a deterministic total order (rank, then ticket_id)", () => {
  // Simulates the tie an aged row or an older concurrent binary could leave. No
  // UNIQUE constraint exists, so the read order — not the DB — is what makes this
  // deterministic.
  seed(["FG-9", "FG-3"]);
  db.prepare(`UPDATE tickets SET priority_rank = 1 WHERE project_key = ?`).run(PK);
  assert.deepEqual(ranks().map((r) => r.ticketId), ["FG-3", "FG-9"]);
  // The next rank-changing verb renumbers the tie away.
  rankTicket(PK, "FG-9", 1);
  assert.deepEqual(ranks().map((r) => [r.ticketId, r.rank]), [["FG-9", 1], ["FG-3", 2]]);
});

// ─── A2 (store half): enqueue refusal carries a concrete reason ──────────────

test("FG-609 A2: enqueue is refused on a not-ready CURRENT revision with a concrete reason", () => {
  seed(["FG-1"], { body: NOT_READY_BODY });
  const res = enqueueTicket(PK, "FG-1");
  assert.equal(res.ok, false);
  if (res.ok) return;
  // Not a bare boolean: the reason names what is missing.
  assert.match(res.reason, /Missing Goal section/);
  assert.match(res.reason, /Missing Acceptance Criteria section/);
  assert.match(res.reason, /CURRENT revision/);
  // Refused, so no membership — but the assessment DID commit (audit survives).
  assert.deepEqual(executableQueue(PK), []);
  assert.equal(readinessView(PK, "FG-1")?.outcome, "needs_refinement");
});

test("FG-609 A2: the refusal reason is derived from the current revision, not a stored row", () => {
  seed(["FG-1"], { body: READY_BODY });
  // Stash a READY assessment, then edit the ticket to be not-ready.
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  dequeueTicket(PK, "FG-1");
  writeTransaction(() => upsertSeamTicket(ticket("FG-1", { body: NOT_READY_BODY })));
  assert.equal(readinessView(PK, "FG-1")?.outcome, "ready", "the STORED row still says ready");
  assert.equal(readinessView(PK, "FG-1")?.stale, true, "...and is visibly stale");

  const res = enqueueTicket(PK, "FG-1");
  assert.equal(res.ok, false, "the stored ready row must not authorize the enqueue");
  if (res.ok) return;
  assert.match(res.reason, /Missing Acceptance Criteria/);
});

test("FG-609 A2: an exploratory ticket queues without acceptance criteria", () => {
  seed(["FG-1"], { type: "idea", body: "## Problem\nWorth a look.\n" });
  const res = enqueueTicket(PK, "FG-1");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.readiness.outcome, "exploratory");
});

// ─── A3: reorder atomicity, PROVEN BY INJECTED FAILURE ──────────────────────

test("FG-609 A3: a failure partway through the renumber leaves the order byte-identical", () => {
  seed(["FG-1", "FG-2", "FG-3", "FG-4"]);
  for (const id of ["FG-1", "FG-2", "FG-3", "FG-4"]) assert.equal(enqueueTicket(PK, id).ok, true);

  const before = ranks();
  const eventsBefore = queueEvents(PK).length;
  assert.deepEqual(before.map((r) => [r.ticketId, r.rank]), [
    ["FG-1", 1], ["FG-2", 2], ["FG-3", 3], ["FG-4", 4],
  ]);

  // Fail AFTER two rows have already been rewritten and BEFORE the commit.
  let rewritten = 0;
  setRenumberFailureHookForTest((n) => {
    rewritten = n;
    if (n === 2) throw new Error("injected mid-renumber failure");
  });
  assert.throws(() => setQueueOrder(PK, ["FG-4", "FG-3", "FG-2", "FG-1"]), /injected mid-renumber failure/);
  setRenumberFailureHookForTest(null);
  assert.equal(rewritten, 2, "the injection must land after real rows were rewritten");

  // 1. The committed order is byte-identical to the pre-reorder order.
  assert.deepEqual(ranks(), before);
  // 2. NO ticket is left holding an intermediate rank.
  assert.deepEqual(ranks().map((r) => r.rank), [1, 2, 3, 4]);
  // 3. NO queue event was appended.
  assert.equal(queueEvents(PK).length, eventsBefore);
});

test("FG-609 A3: an injected failure inside moveQueuePosition rolls back identically", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  for (const id of ["FG-1", "FG-2", "FG-3"]) assert.equal(enqueueTicket(PK, id).ok, true);
  const before = ranks();
  const eventsBefore = queueEvents(PK).length;

  setRenumberFailureHookForTest((n) => {
    if (n === 1) throw new Error("injected mid-renumber failure");
  });
  assert.throws(() => moveQueuePosition(PK, "FG-3", 1), /injected mid-renumber failure/);
  setRenumberFailureHookForTest(null);

  assert.deepEqual(ranks(), before);
  assert.equal(queueEvents(PK).length, eventsBefore);
});

// ─── A4: the event is appended in the SAME transaction as the state change ───

test("FG-609 A4: no committed rank change exists without its event, and none without a rank change", () => {
  seed(["FG-1", "FG-2", "FG-3"]);

  rankTicket(PK, "FG-1");
  rankTicket(PK, "FG-2");
  rankTicket(PK, "FG-3");
  assert.equal(queueEvents(PK).filter((e) => e.eventType === "rank").length, 3);

  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  assert.equal(queueEvents(PK).filter((e) => e.eventType === "enqueue").length, 1);

  assert.equal(enqueueTicket(PK, "FG-2").ok, true);
  moveQueuePosition(PK, "FG-2", 1);
  const reorders = queueEvents(PK).filter((e) => e.eventType === "reorder");
  assert.equal(reorders.length, 1);
  assert.deepEqual(reorders[0]!.payload!["before"], ["FG-1", "FG-2"]);
  assert.deepEqual(reorders[0]!.payload!["after"], ["FG-2", "FG-1"]);

  dequeueTicket(PK, "FG-1");
  assert.equal(queueEvents(PK).filter((e) => e.eventType === "dequeue").length, 1);

  unrankTicket(PK, "FG-3");
  assert.equal(queueEvents(PK).filter((e) => e.eventType === "unrank").length, 1);

  // The converse: every state change above produced exactly one event, so the
  // total is the number of state changes and nothing is unexplained.
  assert.equal(queueEvents(PK).filter((e) => e.eventType !== "readiness").length, 3 + 1 + 1 + 1 + 1 + 1);
});

test("FG-609 A4: a readiness transition appends an event; re-evaluating unchanged content does not", () => {
  seed(["FG-1"], { body: NOT_READY_BODY });
  assert.equal(enqueueTicket(PK, "FG-1").ok, false);
  assert.equal(queueEvents(PK).filter((e) => e.eventType === "readiness").length, 1);

  // Same content, same outcome — no transition, no event.
  assert.equal(enqueueTicket(PK, "FG-1").ok, false);
  assert.equal(queueEvents(PK).filter((e) => e.eventType === "readiness").length, 1);

  // Edit to ready: outcome AND bound hash move, so a transition is recorded.
  writeTransaction(() => upsertSeamTicket(ticket("FG-1", { body: READY_BODY })));
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  const readinessEvents = queueEvents(PK).filter((e) => e.eventType === "readiness");
  assert.equal(readinessEvents.length, 2);
  assert.equal(readinessEvents[1]!.payload!["previousOutcome"], "needs_refinement");
  assert.equal(readinessEvents[1]!.payload!["outcome"], "ready");
});

// ─── A5 / A6: edit invalidates readiness; readiness is never on the write path ─

test("FG-609 A5: editing a ticket body invalidates its stored readiness by body-hash mismatch", () => {
  seed(["FG-1"]);
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  const fresh = readinessView(PK, "FG-1")!;
  assert.equal(fresh.stale, false);

  writeTransaction(() => upsertSeamTicket(ticket("FG-1", { body: READY_BODY + "\n- and another\n" })));

  const stale = readinessView(PK, "FG-1")!;
  assert.equal(stale.stale, true, "the read surface must report STALE");
  assert.equal(stale.bodyHash, fresh.bodyHash, "the stored binding is unchanged — the TICKET moved");
  assert.notEqual(getTicket(PK, "FG-1")!.bodyHash, stale.bodyHash);

  // ...until rechecked.
  const rechecked = recheckReadiness(PK, "FG-1");
  assert.equal(rechecked.stale, false);
  assert.equal(readinessView(PK, "FG-1")!.stale, false);
});

test("FG-609 A6: a ticket import or edit writes ZERO readiness assessment rows", () => {
  seed(["FG-1", "FG-2"]);
  writeTransaction(() => upsertSeamTicket(ticket("FG-1", { body: NOT_READY_BODY })));
  writeTransaction(() => upsertTicket(ticket("FG-2", { body: READY_BODY })));

  const count = db.prepare(`SELECT COUNT(*) AS n FROM readiness_assessments`).get() as { n: number };
  assert.equal(count.n, 0, "evaluateReadiness must never run on a ticket write path");
  assert.equal(queueEvents(PK).length, 0);
});

test("FG-609 A6: an enqueue ATTEMPT persists the assessment whether it succeeds or is refused", () => {
  seed(["FG-1"], { body: NOT_READY_BODY });
  seed(["FG-2"], { body: READY_BODY });

  assert.equal(enqueueTicket(PK, "FG-1").ok, false);
  assert.equal(enqueueTicket(PK, "FG-2").ok, true);

  assert.equal(readinessView(PK, "FG-1")?.outcome, "needs_refinement");
  assert.equal(readinessView(PK, "FG-2")?.outcome, "ready");
});

// ─── A7: blocked retains rank and membership ────────────────────────────────

test("FG-609 A7: a blocked queued ticket keeps its rank; resolving returns an IDENTICAL ordered list", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  for (const id of ["FG-1", "FG-2", "FG-3"]) assert.equal(enqueueTicket(PK, id).ok, true);
  const before = executableQueue(PK).map((e) => e.ticketId);
  assert.deepEqual(before, ["FG-1", "FG-2", "FG-3"]);

  writeTransaction(() =>
    upsertBlockerEvidence({
      projectKey: PK,
      ticketId: "FG-2",
      reason: "waiting on an upstream decision",
      source: LEGACY_BLOCKED_SOURCE,
      createdAt: NOW,
    }),
  );

  const blockedQueue = executableQueue(PK);
  assert.deepEqual(
    blockedQueue.map((e) => e.ticketId),
    before,
    "a blocked ticket stays in the queue at the same position — blocked is derived, not a status",
  );
  assert.equal(blockedQueue.find((e) => e.ticketId === "FG-2")!.blocked, true);
  assert.equal(blockedQueue.find((e) => e.ticketId === "FG-2")!.rank, 2);

  writeTransaction(() => deleteBlockerEvidence(PK, "FG-2", LEGACY_BLOCKED_SOURCE));
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), before);
  assert.equal(executableQueue(PK).find((e) => e.ticketId === "FG-2")!.blocked, false);
});

test("FG-609 A7: a non-status-bearing enriched blocker does NOT mark a queue entry blocked", () => {
  seed(["FG-1"]);
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  writeTransaction(() =>
    upsertBlockerEvidence({
      projectKey: PK,
      ticketId: "FG-1",
      reason: "waits on FG-99",
      source: dependencyBlockerSource("FG-99"),
      createdAt: NOW,
      kind: "dependency",
      queueProjection: "blocked",
    }),
  );
  assert.equal(executableQueue(PK)[0]!.blocked, false);
});

// ─── A8 / A9: done and deferred leave the ACTIVE queue, history survives ────

test("FG-609 A8: a done ticket leaves the executable queue; its queue history stays readable", () => {
  seed(["FG-1", "FG-2"]);
  for (const id of ["FG-1", "FG-2"]) assert.equal(enqueueTicket(PK, id).ok, true);
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-1", "FG-2"]);

  writeTransaction(() => upsertSeamTicket(ticket("FG-1", { status: "done", closed: "2026-08-02" })));

  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-2"]);
  const history = queueEvents(PK, "FG-1");
  assert.ok(history.length > 0, "queue history must remain auditable after the ticket is done");
  assert.deepEqual(history.map((e) => e.eventType).filter((t) => t === "enqueue"), ["enqueue"]);
  assert.ok(history.every((e) => e.createdAt.length > 0), "every event stays attributable in time");
});

test("FG-609 A9: defer then reactivate returns an IDENTICAL ORDERED LIST", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  for (const id of ["FG-1", "FG-2", "FG-3"]) assert.equal(enqueueTicket(PK, id).ok, true);
  const before = executableQueue(PK).map((e) => e.ticketId);
  assert.deepEqual(before, ["FG-1", "FG-2", "FG-3"]);

  writeTransaction(() => upsertSeamTicket(ticket("FG-2", { status: "deferred" })));
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-1", "FG-3"]);
  // Rank and membership are RETAINED, not cleared.
  assert.equal(getTicket(PK, "FG-2")!.priorityRank, 2);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM queue_membership WHERE ticket_id = 'FG-2'`).get() as { n: number }).n,
    1,
  );

  writeTransaction(() => upsertSeamTicket(ticket("FG-2", { status: "active" })));
  assert.deepEqual(
    executableQueue(PK).map((e) => e.ticketId),
    before,
    "reactivation must restore the identical ordered list, not merely re-add the ticket",
  );
});

// ─── membership / rank orthogonality ────────────────────────────────────────

test("FG-609: dequeue RETAINS the rank, so re-enqueueing returns to the same position", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  for (const id of ["FG-1", "FG-2", "FG-3"]) assert.equal(enqueueTicket(PK, id).ok, true);
  dequeueTicket(PK, "FG-2");
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-1", "FG-3"]);
  assert.equal(getTicket(PK, "FG-2")!.priorityRank, 2);
  assert.equal(enqueueTicket(PK, "FG-2").ok, true);
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-1", "FG-2", "FG-3"]);
});

test("FG-609: rank --clear refuses BY NAME on a queued ticket", () => {
  seed(["FG-1"]);
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  assert.throws(
    () => unrankTicket(PK, "FG-1"),
    (e: unknown) =>
      e instanceof QueueRefusal && /is in the operator queue/.test(e.message) && e.verb === "rank",
  );
});

test("FG-609: dequeue and rank refuse BY NAME on an unknown or unqueued ticket", () => {
  seed(["FG-1"]);
  assert.throws(
    () => dequeueTicket(PK, "FG-1"),
    (e: unknown) => e instanceof QueueRefusal && /not in the operator queue/.test(e.message),
  );
  assert.throws(
    () => rankTicket(PK, "FG-404"),
    (e: unknown) => e instanceof QueueRefusal && /does not exist/.test(e.message),
  );
});

test("FG-609: reorder refuses a non-permutation by name", () => {
  seed(["FG-1", "FG-2"]);
  for (const id of ["FG-1", "FG-2"]) assert.equal(enqueueTicket(PK, id).ok, true);
  assert.throws(
    () => setQueueOrder(PK, ["FG-1"]),
    (e: unknown) => e instanceof QueueRefusal && /exact permutation/.test(e.message),
  );
});

test("FG-609: reorder leaves non-queued ranked tickets in the slots they already occupy", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  rankTicket(PK, "FG-1");
  rankTicket(PK, "FG-2"); // ranked but NOT queued
  rankTicket(PK, "FG-3");
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  assert.equal(enqueueTicket(PK, "FG-3").ok, true);

  setQueueOrder(PK, ["FG-3", "FG-1"]);
  // FG-2 keeps slot 2; the queued pair swap the slots they held (1 and 3).
  assert.deepEqual(ranks().map((r) => [r.ticketId, r.rank]), [
    ["FG-3", 1], ["FG-2", 2], ["FG-1", 3],
  ]);
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-3", "FG-1"]);
});

// ─── A13: no evidence collision; the legacy delete is not widened ───────────

test("FG-609 A13: two distinct dependency blockers on one ticket both survive", () => {
  seed(["FG-1"]);
  writeTransaction(() => {
    upsertBlockerEvidence({
      projectKey: PK, ticketId: "FG-1", reason: "waits on FG-50",
      source: dependencyBlockerSource("FG-50"), createdAt: NOW,
      kind: "dependency", detail: { dependency: "FG-50" }, queueProjection: "blocked",
    });
    upsertBlockerEvidence({
      projectKey: PK, ticketId: "FG-1", reason: "waits on FG-51",
      source: dependencyBlockerSource("FG-51"), createdAt: NOW,
      kind: "dependency", detail: { dependency: "FG-51" }, queueProjection: "blocked",
    });
  });
  const rows = blockerEvidenceForTicket(PK, "FG-1");
  assert.equal(rows.length, 2, "distinct dependency identities must not collide on the UNIQUE key");
  assert.deepEqual(rows.map((r) => r.detail?.["dependency"]).sort(), ["FG-50", "FG-51"]);
});

test("FG-609 A13: unblocking removes ONLY the legacy row and leaves enriched rows intact", () => {
  seed(["FG-1"]);
  writeTransaction(() => {
    upsertBlockerEvidence({
      projectKey: PK, ticketId: "FG-1", reason: "legacy blocked",
      source: LEGACY_BLOCKED_SOURCE, createdAt: NOW,
    });
    upsertBlockerEvidence({
      projectKey: PK, ticketId: "FG-1", reason: "waits on FG-50",
      source: dependencyBlockerSource("FG-50"), createdAt: NOW, kind: "dependency",
    });
  });
  writeTransaction(() => deleteBlockerEvidence(PK, "FG-1", LEGACY_BLOCKED_SOURCE));
  const rows = blockerEvidenceForTicket(PK, "FG-1");
  assert.deepEqual(rows.map((r) => r.source), [dependencyBlockerSource("FG-50")]);
});

test("FG-609 A13: the blocker_evidence UNIQUE constraint shape is unchanged", () => {
  const indexes = db.prepare(`PRAGMA index_list(blocker_evidence)`).all() as {
    name: string; unique: number; origin: string;
  }[];
  // origin 'pk' is the auto-index behind `id TEXT PRIMARY KEY`, not a constraint
  // this slice could have changed. 'u' is the declared UNIQUE.
  const uniques = indexes.filter((i) => i.unique === 1 && i.origin !== "pk");
  assert.equal(uniques.length, 1, "exactly one declared UNIQUE, the Slice A natural key");
  const cols = (db.prepare(`PRAGMA index_info(${uniques[0]!.name})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.deepEqual(cols, ["project_key", "ticket_id", "source"]);
});

// ─── A17: queue writes trigger ZERO snapshot republishes ────────────────────

test("FG-609 A17: rank/enqueue/dequeue/reorder mark NOTHING dirty and publish NOTHING", () => {
  const targetDir = mkdtempSync(join(tmpdir(), "fg609-target-"));
  try {
    seed(["FG-1", "FG-2"]);
    registerSnapshotTarget(PK, targetDir, "task-x");

    // The seed above IS a ticket write, so it legitimately bumped the ordinal.
    // Everything after this line is queue-only.
    const ordinalBefore = ordinal();
    rmSync(join(targetDir, "backlog.db"), { force: true });

    rankTicket(PK, "FG-1");
    rankTicket(PK, "FG-2");
    assert.equal(enqueueTicket(PK, "FG-1").ok, true);
    assert.equal(enqueueTicket(PK, "FG-2").ok, true);
    moveQueuePosition(PK, "FG-2", 1);
    dequeueTicket(PK, "FG-1");

    assert.equal(
      ordinal(),
      ordinalBefore,
      "markBacklogDirty bumps the publication ordinal — a queue write must never call it",
    );
    assert.equal(
      existsSync(join(targetDir, "backlog.db")),
      false,
      "a rank nudge must not republish a snapshot to every live container on the host",
    );
    assert.deepEqual(readdirSync(targetDir), [], "no artifact at all");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

// ─── derived in_progress ────────────────────────────────────────────────────

test("FG-609: in_progress is COMPUTED from dispatch evidence, never stored", () => {
  seed(["FG-1"]);
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  assert.equal(executableQueue(PK)[0]!.inProgress, false);

  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('run-1', 'feature', 't', 'active', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at)
     VALUES ('task-1', 'run-1', 'build', 'backend', 'running', '{}', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO ticket_dispatch_evidence (task_id, project_key, ticket_id, revision, body_hash, dispatched_at)
     VALUES ('task-1', ?, 'FG-1', 1, 'h', ?)`,
  ).run(PK, NOW);

  assert.equal(executableQueue(PK)[0]!.inProgress, true);

  db.prepare(`UPDATE tasks SET status = 'complete' WHERE id = 'task-1'`).run();
  assert.equal(executableQueue(PK)[0]!.inProgress, false);

  // And it is genuinely derived: there is no column to store it in.
  const ticketCols = (db.prepare(`PRAGMA table_info(tickets)`).all() as { name: string }[]).map((c) => c.name);
  assert.equal(ticketCols.includes("in_progress"), false);
  assert.equal(ticketCols.includes("blocked"), false);
  // The lifecycle vocabulary is untouched.
  assert.deepEqual(
    (db.prepare(`SELECT DISTINCT status FROM tickets`).all() as { status: string }[]).map((r) => r.status),
    ["active"],
  );
});
