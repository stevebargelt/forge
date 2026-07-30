// FG-638 — what the state field IS, and what it deliberately is NOT.
//
// READ THIS BEFORE ADDING ENFORCEMENT. The FG-638 scope is "durable state + read
// surfaces ONLY"; the stage machine that DRIVES the 11 states is FG-639, and
// src/store/reviews.ts says so at the REVIEW_STATES declaration. So `setReviewState`
// is a RECORDER, not a gate: it accepts any state in the vocabulary from any other,
// and its job is to make the move auditable.
//
// That is easy to mistake for a missing feature, so this file pins it as the
// documented Change 1 contract, exhaustively over all 11×11 ordered pairs. If FG-639
// introduces a legality table, THIS FILE IS THE ONE TO CHANGE — deliberately, with
// the coordinator that owns the ordering — rather than a suite that never said which
// behavior was intended. Two of the "illegal-looking" transitions are load-bearing
// today: blocked_environment → discovering (a coordinator retrying after the
// environment came back) and settled → fixing (a recheck that reopened a review).
//
// What IS enforced, and asserted here: the vocabulary itself (a CHECK constraint
// rejects a state outside the 11, writing nothing), the existence of the review, and
// the append-only event per transition — including the same-state no-op, which
// records precisely so a coordinator re-entering a stage after a crash is visible
// rather than silent.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { insertRun } from "./runs.js";
import { eventsForRun } from "./events.js";
import { insertReview, getReview, setReviewState, updateReview, REVIEW_STATES, type ReviewState } from "./reviews.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg638-states",
  workflow: "feature",
  title: "review state machine",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function review(id = "review-states"): string {
  insertReview({ id, runId: RUN.id, reviewMode: "evidence_led", candidateSha: "cand111" });
  return id;
}

function stateEvents(): { from: string; to: string; reason?: string }[] {
  return eventsForRun(RUN.id)
    .filter((e) => e.eventType === "review.state_changed")
    .map((e) => e.payload as { from: string; to: string; reason?: string });
}

function snapshot(): unknown {
  const d = getDb();
  return {
    reviews: d.prepare(`SELECT * FROM reviews ORDER BY id`).all(),
    events: d.prepare(`SELECT * FROM events ORDER BY id`).all(),
  };
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

test("FG-638: Change 1 does NOT enforce transition ordering — every ordered pair of the 11 states is recorded", () => {
  const id = review();
  let transitions = 0;

  for (const from of REVIEW_STATES) {
    for (const to of REVIEW_STATES) {
      setReviewState(id, from, { reason: "arrange" });
      const after = setReviewState(id, to, { reason: `${from}->${to}` });
      transitions += 2;
      assert.equal(after.state, to, `${from} -> ${to} must be recorded, not refused (ordering is FG-639's coordinator, not the store's)`);
    }
  }

  // Named individually so a future reader sees the two that MUST keep working even if
  // FG-639 adds a legality table, and the one that looks most obviously wrong.
  const named: [ReviewState, ReviewState, string][] = [
    ["settled", "confirming_contract", "settled -> confirming_contract is recorded in Change 1 (see FG-639)"],
    ["blocked_environment", "discovering", "a coordinator retrying after an environment block depends on this"],
    ["settled", "fixing", "a recheck that reopens a settled review depends on this"],
  ];
  for (const [from, to, why] of named) {
    setReviewState(id, from);
    assert.equal(setReviewState(id, to).state, to, why);
    transitions += 2;
  }

  assert.equal(stateEvents().length, transitions, "every transition — legal-looking or not — must be on the append-only record");
  assert.equal(REVIEW_STATES.length, 11);
});

test("FG-638: a same-state transition still records, so a re-entered stage is visible rather than silent", () => {
  const id = review();
  setReviewState(id, "discovering", { reason: "first entry" });
  setReviewState(id, "discovering", { reason: "re-entered after a container died" });

  assert.deepEqual(
    stateEvents().map((e) => [e.from, e.to, e.reason]),
    [
      ["confirming_contract", "discovering", "first entry"],
      ["discovering", "discovering", "re-entered after a container died"],
    ],
    "a no-op transition is not dropped — the audit half exists to show the retry",
  );
  assert.equal(getReview(id)?.state, "discovering");
});

test("FG-638: the event stream replays to the row's current state", () => {
  const id = review();
  const walk: ReviewState[] = ["discovering", "awaiting_disposition", "fixing", "verifying", "rechecking", "shipping_review", "settled"];
  for (const s of walk) setReviewState(id, s);

  const events = stateEvents();
  assert.deepEqual(events.map((e) => e.to), walk, "the recorded destinations must be the walk, in order");
  // Each event's `from` is the previous event's `to` — an unbroken chain from the
  // state the review was created in.
  assert.deepEqual(events.map((e) => e.from), ["confirming_contract", ...walk.slice(0, -1)]);
  assert.equal(getReview(id)?.state, events.at(-1)?.to, "replaying the stream must land on the row's current state");
});

test("FG-638: settled_at is stamped on entering settled and RETAINED when a review is reopened", () => {
  const id = review();
  assert.equal(getReview(id)?.settledAt, undefined);

  setReviewState(id, "settled");
  const firstSettledAt = getReview(id)?.settledAt;
  assert.ok(firstSettledAt !== undefined, "entering settled must stamp settled_at");

  // Documented behavior: reopening does NOT clear the stamp — "this review settled
  // once, at this time" stays true, and the current state says it is open again. A
  // coordinator that needs "settled and still settled" reads state, not settled_at.
  setReviewState(id, "fixing");
  assert.equal(getReview(id)?.settledAt, firstSettledAt, "the historical settle stamp survives a reopen");
  assert.equal(getReview(id)?.state, "fixing");

  // Re-settling re-stamps to the latest settle.
  setReviewState(id, "settled");
  assert.ok(getReview(id)?.settledAt !== undefined);
});

test("FG-638: a review inserted directly in the settled state carries NO settled_at — only a transition stamps it", () => {
  // Pinned because it is asymmetric and easy to trip over: insertReview always writes
  // settled_at NULL. The coordinator (FG-639) reaches settled through setReviewState,
  // which is the only path that stamps.
  insertReview({ id: "review-born-settled", runId: RUN.id, reviewMode: "evidence_led", state: "settled" });
  const r = getReview("review-born-settled");
  assert.equal(r?.state, "settled");
  assert.equal(r?.settledAt, undefined, "documented: insertReview does not stamp settled_at, even at state 'settled'");
});

test("FG-638: a state outside the 11 is rejected by the CHECK constraint and writes nothing", () => {
  const id = review();
  setReviewState(id, "discovering");
  const before = snapshot();

  for (const bogus of ["shipping", "SETTLED", "done", ""]) {
    assert.throws(
      () => setReviewState(id, bogus as ReviewState),
      /CHECK constraint failed|constraint/i,
      `'${bogus}' is outside the vocabulary and must be rejected`,
    );
  }

  assert.deepEqual(snapshot(), before, "a rejected transition must leave neither a changed row nor a state_changed event");
  assert.equal(getReview(id)?.state, "discovering");
});

test("FG-638: transitioning a review that does not exist is refused by name and writes nothing", () => {
  review();
  const before = snapshot();
  assert.throws(() => setReviewState("review-absent", "settled"), /no review review-absent/);
  assert.deepEqual(snapshot(), before);
});

test("FG-638: updateReview moves the identity fields WITHOUT emitting a lifecycle event", () => {
  const id = review();
  const before = stateEvents().length;

  const updated = updateReview(id, { candidateSha: "cand222", trustedRemoteSha: "rem999" });

  assert.equal(updated.candidateSha, "cand222");
  assert.equal(updated.trustedRemoteSha, "rem999");
  assert.equal(updated.state, "confirming_contract", "advancing the candidate is not itself a transition");
  assert.equal(
    stateEvents().length,
    before,
    "documented: updateReview emits no state_changed — a coordinator that advances the candidate emits its own transition around it",
  );
});
