// FG-638 — ingestion's identity and transaction integrity.
//
// `ingestFindings` allocates RF-n by reading COALESCE(MAX(ordinal), 0) inside the
// write transaction and inserting N rows against it. Three properties fall out of
// that shape, none of which the capability tests in fg638-review-ledger.test.ts
// exercise, and each of which is the kind that only breaks in production:
//
//   IDENTITY — an RF-n is allocated ONCE. Ingesting the same reviewer's report
//   twice must never hand out an id that already exists, and ordinals must stay
//   dense (1..N, no gaps) so `RF-4` is never a number nothing was ever assigned.
//
//   ALL-OR-NOTHING — a batch that dies halfway leaves NO rows, NO events, and NO
//   consumed ordinals. A partially-ingested batch would leave the next call
//   starting at RF-3 with RF-1/RF-2 nonexistent, which is exactly the silent hole
//   an operator reading `forge review show` cannot see.
//
//   NO IMPLICIT DEDUP — re-ingesting the same observation produces a SECOND row.
//   That is deliberate: normalization/deduplication POLICY is FG-639 (the AC in
//   FG-638 is narrowed to persistence CAPABILITY), so this file pins the behavior
//   rather than asserting an idempotency the store does not claim. If FG-639 makes
//   ingestion dedup-aware, the pinned test here is the one to change on purpose.
//
// The one place the code DOES dedup is canonical absorption (mergeSources, keyed on
// structural equality) — asserted below with an IDENTICAL source, which the
// existing absorption test cannot see because its two sources differ.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { insertRun } from "./runs.js";
import { insertReview, ingestFindings, findingsForReview, getFinding, recordDisposition, type Observation } from "./reviews.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg638-ingest",
  workflow: "feature",
  title: "ingestion integrity",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

// One reviewer's report of one mechanism — the same source object both ingestion
// calls carry, so "the same verdict ingested twice" is literally that.
const SOURCE = { verdictId: "verdict-red-security-1", redTaskId: "task-red-security", redRole: "red-security", authority: "authoritative" };

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function review(id: string): string {
  insertReview({ id, runId: RUN.id, reviewMode: "evidence_led", candidateSha: "cand111", state: "discovering" });
  return id;
}

function ordinals(reviewId: string): number[] {
  return findingsForReview(reviewId).map((f) => f.ordinal);
}

function countFindings(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM review_findings`).get() as { n: number }).n;
}

function countIngestEvents(): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'review.finding_ingested'`).get() as { n: number }
  ).n;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-638: ingesting the same verdict source twice never re-assigns an RF-n or duplicates a row's sources", () => {
  const r = review("review-idem");
  const observation: Observation = { summary: "unauthenticated write path", riskLens: "security", severity: "high", sources: [SOURCE] };

  const first = ingestFindings(r, [observation]);
  const second = ingestFindings(r, [observation]);

  // Identity: two allocations, never the same id twice.
  assert.deepEqual(first.map((f) => f.id), ["review-idem/RF-1"]);
  assert.deepEqual(second.map((f) => f.id), ["review-idem/RF-2"]);
  assert.equal(new Set([...first, ...second].map((f) => f.id)).size, 2);

  // No row accumulates the source twice, and neither row leaks into the other.
  for (const f of findingsForReview(r)) {
    assert.deepEqual(f.sources, [SOURCE], `${f.findingRef} must carry exactly the one source it arrived with`);
  }

  // DOCUMENTED, NOT DESIRED-FOREVER: re-ingestion is not deduplicated here. The
  // normalization/dedup policy that would collapse these into one row carrying both
  // sources is FG-639; this store's job is only to make that shape expressible.
  assert.equal(findingsForReview(r).length, 2, "Change 1 does not dedup on ingest — FG-639 owns that policy");
});

test("FG-638: ordinals stay dense and stable across many sequential ingestion calls", () => {
  const r = review("review-dense");
  // Varying batch sizes, back to back — the MAX(ordinal)+1 allocator's actual usage
  // pattern as a discovery stage streams observations in.
  const batches = [1, 3, 1, 5, 2];
  let expected = 0;
  for (const [i, size] of batches.entries()) {
    const observations = Array.from({ length: size }, (_, k) => ({ summary: `batch ${i} observation ${k}`, sources: [SOURCE] }));
    const got = ingestFindings(r, observations);
    assert.deepEqual(
      got.map((f) => f.ordinal),
      Array.from({ length: size }, (_, k) => expected + k + 1),
      `batch ${i} must continue the sequence rather than restart or skip`,
    );
    expected += size;
  }

  const all = findingsForReview(r);
  assert.deepEqual(ordinals(r), Array.from({ length: expected }, (_, i) => i + 1), "ordinals must be dense 1..N with no gaps");
  assert.deepEqual(
    all.map((f) => f.findingRef),
    all.map((f) => `RF-${f.ordinal}`),
    "finding_ref must always be RF-<ordinal>",
  );
  assert.deepEqual(all.map((f) => f.id), all.map((f) => `${r}/${f.findingRef}`));

  // Stable: reading again returns the same ordering and the same ids.
  assert.deepEqual(findingsForReview(r).map((f) => f.id), all.map((f) => f.id));

  // Single-assignment is enforced by the DB, not only by the allocator: a writer that
  // tried to re-use an ordinal is rejected.
  assert.throws(
    () =>
      getDb()
        .prepare(
          `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, created_at, updated_at)
           VALUES ('review-dense/RF-dup', ?, 1, 'RF-1', 'T', 'T')`,
        )
        .run(r),
    /UNIQUE|constraint/i,
    "UNIQUE (review_id, ordinal) must make a double-assigned ordinal impossible",
  );
});

test("FG-638: RF-n is scoped per review — interleaved ingestion across reviews does not share a counter", () => {
  const a = review("review-a");
  const b = review("review-b");

  ingestFindings(a, [{ summary: "a-1" }]);
  ingestFindings(b, [{ summary: "b-1" }]);
  ingestFindings(a, [{ summary: "a-2" }, { summary: "a-3" }]);
  ingestFindings(b, [{ summary: "b-2" }]);

  assert.deepEqual(findingsForReview(a).map((f) => f.findingRef), ["RF-1", "RF-2", "RF-3"]);
  assert.deepEqual(findingsForReview(b).map((f) => f.findingRef), ["RF-1", "RF-2"]);
  // The refs collide across reviews by design; the ids do not. That is why the id is
  // review-scoped and why a bare RF-n needs --review to disambiguate.
  assert.equal(getFinding("review-a/RF-1")?.summary, "a-1");
  assert.equal(getFinding("review-b/RF-1")?.summary, "b-1");
});

// ─── all-or-nothing ─────────────────────────────────────────────────────────

// A batch that dies partway through. Two injection shapes, one property: whatever
// kills the loop — a malformed model payload that will not serialize, or a value
// SQLite refuses to bind — the transaction must take the whole batch with it.
const CIRCULAR_SOURCE = (): Observation => {
  const circular: Record<string, unknown> = { redRole: "red-wide" };
  circular.self = circular; // JSON.stringify throws: models the unserializable payload
  return { summary: "third observation, malformed payload", sources: [circular as never] };
};
const UNBINDABLE_LINE = (): Observation => ({ summary: "third observation, unbindable anchor", line: {} as never });

for (const [label, poison] of [
  ["an unserializable source", CIRCULAR_SOURCE],
  ["a value SQLite cannot bind", UNBINDABLE_LINE],
] as const) {
  test(`FG-638: a batch that throws on ${label} rolls back whole — no rows, no events, no consumed ordinals`, () => {
    const r = review("review-rollback");
    ingestFindings(r, [{ summary: "already ingested, must survive", sources: [SOURCE] }]);

    const rowsBefore = getDb().prepare(`SELECT * FROM review_findings ORDER BY id`).all();
    const eventsBefore = countIngestEvents();

    assert.throws(
      () => ingestFindings(r, [{ summary: "good one" }, { summary: "good two" }, poison(), { summary: "good four" }]),
      "a batch carrying a poisoned observation must throw rather than half-succeed",
    );

    assert.deepEqual(
      getDb().prepare(`SELECT * FROM review_findings ORDER BY id`).all(),
      rowsBefore,
      "not one row of the failed batch may survive — the two observations BEFORE the poison included",
    );
    assert.equal(countIngestEvents(), eventsBefore, "the rolled-back batch must leave no finding_ingested events either");

    // The allocator must not have consumed the ordinals it tried to use: the next
    // successful ingestion continues from RF-1, not from RF-4.
    const after = ingestFindings(r, [{ summary: "the retry" }]);
    assert.deepEqual(after.map((f) => f.findingRef), ["RF-2"]);
    assert.deepEqual(ordinals(r), [1, 2], "a failed batch must leave no gap for a later reader to trip over");
    assert.equal(countFindings(), 2);
  });
}

test("FG-638: a review that does not exist is refused before anything is written", () => {
  review("review-real");
  const before = countFindings();
  assert.throws(() => ingestFindings("review-absent", [{ summary: "orphan" }]), /no review review-absent/);
  assert.equal(countFindings(), before, "a rejected ingestion writes nothing");
  assert.equal(countIngestEvents(), 0);
});

// ─── the one dedup the code DOES claim ──────────────────────────────────────

test("FG-638: canonical absorption is idempotent on an IDENTICAL source — provenance grows, it does not repeat", () => {
  const r = review("review-absorb");
  // Canonical plus two duplicates, all three reporting the SAME source. The existing
  // absorption test uses two DIFFERENT sources, so it cannot see a merge that appends
  // blindly; structural equality is the claim in mergeSources, and this is the case
  // that fails if it ever becomes reference or id equality.
  const [canonical, dup1, dup2] = ingestFindings(r, [
    { summary: "canonical: unauthenticated write path", sources: [SOURCE] },
    { summary: "duplicate reported by the same red", sources: [SOURCE] },
    { summary: "duplicate again, plus a second reviewer", sources: [SOURCE, { verdictId: "verdict-red-wide-9", redRole: "red-wide" }] },
  ]) as [NonNullable<ReturnType<typeof getFinding>>, NonNullable<ReturnType<typeof getFinding>>, NonNullable<ReturnType<typeof getFinding>>];

  const first = recordDisposition(dup1.id, {
    decision: "duplicate",
    rationale: "same mechanism as the canonical row",
    operator: false,
    duplicateOf: canonical.findingRef,
  });
  assert.equal(first.ok, true);
  assert.deepEqual(
    getFinding(canonical.id)?.sources,
    [SOURCE],
    "absorbing an identical source must not record the same reviewer twice",
  );

  const second = recordDisposition(dup2.id, {
    decision: "duplicate",
    rationale: "third report of the same mechanism",
    operator: false,
    duplicateOf: canonical.findingRef,
  });
  assert.equal(second.ok, true);
  assert.deepEqual(
    getFinding(canonical.id)?.sources,
    [SOURCE, { verdictId: "verdict-red-wide-9", redRole: "red-wide" }],
    "a genuinely new reviewer IS added — dedup must not collapse two distinct reporters into one",
  );

  // The absorbed rows keep their own provenance; absorption is a copy, not a move.
  assert.deepEqual(getFinding(dup1.id)?.sources, [SOURCE]);
  assert.equal(getFinding(dup1.id)?.duplicateOf, canonical.id);
});
