// FG-844 — the Queue board's layout decisions, pinned without a browser: when a lane's
// cards go compact, what the compact card's one status line says, which lane the
// under-900px strip shows, and the `#queue?lane=` route parameter.

import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_VIEWS,
  COMPACT_CARD_THRESHOLD,
  compactStatusLine,
  laneIsCompact,
  queueBoardState,
  selectedLane,
} from "../client/queue-board-state.js";
import { ROUTES, hashFor, parseHash } from "../client/view-routing.js";

function row(overrides: Record<string, unknown> = {}) {
  return { ticketId: "FG-1", title: "a ticket", status: "active", rank: 1, queued: true, executionState: "idle", readiness: null, view: "queued", wait: null, ...overrides };
}

function board(counts: Partial<Record<string, number>>) {
  const rows: ReturnType<typeof row>[] = [];
  const views: Record<string, string[]> = {};
  for (const view of BOARD_VIEWS) {
    views[view] = [];
    for (let i = 0; i < (counts[view] ?? 0); i += 1) {
      const id = `${view}-${i}`;
      rows.push(row({ ticketId: id, view }));
      views[view].push(id);
    }
  }
  return queueBoardState({ projectKey: "pk", storageMode: "db", queueAvailable: true, version: 1, rows, views }).columns;
}

test("FG-844: a lane goes compact only past 20 cards", () => {
  assert.equal(COMPACT_CARD_THRESHOLD, 20);
  assert.equal(laneIsCompact(0), false);
  assert.equal(laneIsCompact(20), false, "exactly the threshold keeps the full card");
  assert.equal(laneIsCompact(21), true);
  assert.equal(laneIsCompact(60), true);
  assert.equal(laneIsCompact(undefined), false);
});

test("FG-844: the compact card's one status line is the status plus why the card is where it is", () => {
  assert.equal(compactStatusLine(row()), "active");
  assert.equal(compactStatusLine(row({ executionState: "running" })), "active · running");
  assert.equal(
    compactStatusLine(row({ wait: { kind: "scheduling", reason: "x", source: "dispatcher_evaluation", observedAt: null } })),
    "active · Waiting to overlap",
    "a wait's own label, never a generic 'waiting'",
  );
  assert.equal(
    compactStatusLine(row({ wait: { kind: "blocker", reason: "x", source: "blocker_evidence", observedAt: null } })),
    "active · Blocked",
  );
  assert.equal(compactStatusLine(row({ readiness: { outcome: "ready", stale: true } })), "active · readiness stale");
  assert.equal(compactStatusLine(row({ status: "" })), "unknown");
});

test("FG-844: the strip shows the lane the hash names, else the first lane with cards, else the first lane", () => {
  const columns = board({ queued: 0, blocked: 2, done: 3 });
  assert.equal(selectedLane(columns, "done"), "done");
  assert.equal(selectedLane(columns, "in_progress"), "in_progress", "an empty lane can still be chosen");
  assert.equal(selectedLane(columns, null), "blocked", "no lane named: the first with cards");
  assert.equal(selectedLane(columns, "nope"), "blocked", "an unknown lane falls back the same way");
  assert.equal(selectedLane(board({}), null), BOARD_VIEWS[0], "an empty board shows its first lane");
});

test("FG-844: #queue?lane= is a route parameter over exactly the board's lanes", () => {
  assert.deepEqual(ROUTES.queue?.paramValues?.lane, BOARD_VIEWS, "the route table and the board name the same lanes");
  assert.equal(hashFor({ view: "queue", scope: { project: "forge" }, params: { lane: "blocked" } }), "#queue?project=forge&lane=blocked");

  const parsed = parseHash("#queue?project=forge&lane=done");
  assert.deepEqual([parsed.view, parsed.params, parsed.rewrite], ["queue", { lane: "done" }, false]);

  const unknown = parseHash("#queue?project=forge&lane=nope");
  assert.deepEqual([unknown.params, unknown.canonical], [{}, "#queue?project=forge"], "an unknown lane is dropped from the hash");

  assert.deepEqual(parseHash("#backlog?lane=done").params, {}, "lane= belongs to the queue alone");
});
