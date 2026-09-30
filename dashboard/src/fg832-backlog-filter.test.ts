// FG-832: the Backlog view's default filter (every type, active only), the
// `#backlog?type=<t>&status=<s>` hash round-trip and the "N of M tickets" count. The
// browser suite (browser-tests/fg832-backlog-filter.test.ts) clicks the controls.

import assert from "node:assert/strict";
import test from "node:test";
import { BACKLOG_FILTER_DEFAULT, backlogCountLabel, backlogFilterHash, backlogFilterState, filterBacklogTickets } from "../client/backlog-state.js";
import { hashFor, parseHash } from "../client/view-routing.js";

const TICKETS = [
  { id: "FG-1", type: "epic", status: "active" },
  { id: "FG-2", type: "story", status: "active" },
  { id: "FG-3", type: "story", status: "done" },
  { id: "FG-4", type: "idea", status: "deferred" },
  { id: "FG-5", type: "story", status: "blocked" },
];
const SCOPE = { project: "forge", checkout: null };
const ids = (state: { type: string; status: string }) => filterBacklogTickets(TICKETS, state).map((t) => t.id);

test("a bare #backlog opens with type All and status Active, never 'no filter'", () => {
  assert.deepEqual(BACKLOG_FILTER_DEFAULT, { type: "all", status: "active" });
  assert.deepEqual(backlogFilterState(parseHash("#backlog?project=forge").params), { type: "all", status: "active" });
  assert.deepEqual(backlogFilterState(null), { type: "all", status: "active" });
  assert.deepEqual(ids(backlogFilterState(null)), ["FG-1", "FG-2"], "the default shows active tickets of every type");
});

test("the filter narrows by type and status; 'all' status shows every state", () => {
  assert.deepEqual(ids({ type: "story", status: "active" }), ["FG-2"]);
  assert.deepEqual(ids({ type: "all", status: "done" }), ["FG-3"]);
  assert.deepEqual(ids({ type: "story", status: "all" }), ["FG-2", "FG-3", "FG-5"]);
  assert.deepEqual(ids({ type: "all", status: "all" }), ["FG-1", "FG-2", "FG-3", "FG-4", "FG-5"]);
});

test("the hash round-trips type and status, keeps the scope and omits the defaults", () => {
  const cases: Array<[{ type: string; status: string }, string]> = [
    [{ type: "all", status: "active" }, "#backlog?project=forge"],
    [{ type: "all", status: "done" }, "#backlog?project=forge&status=done"],
    [{ type: "story", status: "active" }, "#backlog?project=forge&type=story"],
    [{ type: "epic", status: "all" }, "#backlog?project=forge&type=epic&status=all"],
  ];
  for (const [state, hash] of cases) {
    assert.equal(backlogFilterHash(SCOPE, state), hash);
    const parsed = parseHash(hash);
    assert.equal(parsed.rewrite, false, `${hash} is canonical`);
    assert.deepEqual(backlogFilterState(parsed.params), state, `${hash} restores its filter`);
  }
  assert.equal(backlogFilterHash({ project: null, checkout: null }, { type: "idea", status: "blocked" }), "#backlog?type=idea&status=blocked");
});

test("a missing param is its default; an explicit default or unknown value falls back silently and drops from the canonical hash", () => {
  for (const [hash, canonical, state] of [
    ["#backlog?project=forge&type=story", "#backlog?project=forge&type=story", { type: "story", status: "active" }],
    ["#backlog?project=forge&status=done", "#backlog?project=forge&status=done", { type: "all", status: "done" }],
    ["#backlog?project=forge&type=all&status=active", "#backlog?project=forge", { type: "all", status: "active" }],
    ["#backlog?project=forge&type=bogus&status=wat", "#backlog?project=forge", { type: "all", status: "active" }],
    ["#backlog?project=forge&type=epic&status=wat", "#backlog?project=forge&type=epic", { type: "epic", status: "active" }],
  ] as const) {
    const parsed = parseHash(hash);
    assert.equal(parsed.canonical, canonical, hash);
    assert.equal(parsed.notice, null, `${hash} falls back without a notice`);
    assert.deepEqual(backlogFilterState(parsed.params), state, hash);
  }
});

test("a ticket deep link #backlog/<id> is unaffected by the filter params", () => {
  const parsed = parseHash("#backlog/FG-9?project=forge&status=done&type=story");
  assert.equal(parsed.view, "backlog");
  assert.equal(parsed.id, "FG-9");
  assert.deepEqual(parsed.params, {});
  assert.equal(parsed.canonical, "#backlog/FG-9?project=forge");
  assert.equal(hashFor({ view: "backlog", id: "FG-9", scope: SCOPE, params: { status: "done" } }), "#backlog/FG-9?project=forge");
});

test("the count reads 'N of M tickets' for the current filter", () => {
  assert.equal(backlogCountLabel(filterBacklogTickets(TICKETS, BACKLOG_FILTER_DEFAULT).length, TICKETS.length), "2 of 5 tickets");
  assert.equal(backlogCountLabel(5, 5), "5 of 5 tickets");
  assert.equal(backlogCountLabel(0, 1), "0 of 1 ticket");
});
