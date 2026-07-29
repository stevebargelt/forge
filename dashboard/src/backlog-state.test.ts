// FG-608 reds F4, F5, F6: the backlog board must distinguish the three things it
// used to render as one line ("No backlog tickets found for this project").
//
//   F4 — no ticket truth at all (never imported) vs. an empty backlog
//   F5 — a markdown-mode project's DB rows are an import SHADOW, not authority
//   F6 — a FAILED read is not an empty backlog
//
// The server has emitted ticketsProjectKey / ticketsStorageMode / ticketsError all
// along; the client read none of them. Testing the decision as a pure function is
// the same shape verification-label.js / view-routing.js use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { backlogBoardState } from "../client/backlog-state.js";

const TICKET = { id: "FG-1", type: "story", status: "active", title: "t", body: "" };

test("F4: a project with NO ticket truth is not an empty backlog", () => {
  const state = backlogBoardState({ tickets: [], ticketsProjectKey: null, ticketsStorageMode: null });
  assert.equal(state.kind, "no-truth");
  assert.equal(state.projectKey, null);
});

test("F4: a registered project with zero tickets IS an empty backlog", () => {
  const state = backlogBoardState({ tickets: [], ticketsProjectKey: "pk-a", ticketsStorageMode: "db" });
  assert.equal(state.kind, "empty", "reporting a key means the store answered — it is genuinely empty");
});

test("F4: a registered project with tickets renders them", () => {
  const state = backlogBoardState({ tickets: [TICKET], ticketsProjectKey: "pk-a", ticketsStorageMode: "db" });
  assert.equal(state.kind, "tickets");
  assert.equal(state.total, 1);
});

test("F5: markdown mode flags the rows as a non-authoritative import shadow", () => {
  const shadow = backlogBoardState({ tickets: [TICKET], ticketsProjectKey: "pk-a", ticketsStorageMode: "markdown" });
  assert.equal(shadow.shadow, true, "backlog/*.md is the truth; these rows are an import of it");
  assert.equal(shadow.kind, "tickets", "still rendered — flagged, not hidden");

  const authoritative = backlogBoardState({ tickets: [TICKET], ticketsProjectKey: "pk-a", ticketsStorageMode: "db" });
  assert.equal(authoritative.shadow, false);
});

test("F6: a read failure is an ERROR state — never a zero count", () => {
  const state = backlogBoardState({
    tickets: [],
    ticketsProjectKey: "pk-a",
    ticketsStorageMode: "db",
    ticketsError: "SQLITE_CORRUPT: database disk image is malformed",
  });
  assert.equal(state.kind, "error", "the count is UNKNOWN after a failed read, not zero");
  assert.match(state.error!, /SQLITE_CORRUPT/, "the operator sees the actual failure");
});

test("F6: the error state outranks no-truth — the most actionable fact wins", () => {
  const state = backlogBoardState({ tickets: [], ticketsProjectKey: null, ticketsError: "store would not open" });
  assert.equal(state.kind, "error");
});

test("a missing/partial payload degrades without throwing", () => {
  assert.equal(backlogBoardState({}).kind, "no-truth");
  assert.equal(backlogBoardState({ tickets: undefined, ticketsProjectKey: undefined }).total, 0);
});
