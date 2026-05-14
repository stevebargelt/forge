// ops.ts unit tests — purely synthetic backlogs, no fs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addTicket, closeTicket, findTicket, listTickets, maxTicketId, moveTicket, appendNotes, setNotes } from "./ops.js";
import { type Backlog, SECTION_ORDER, type Ticket } from "./types.js";

function emptyBacklog(): Backlog {
  return {
    preamble: "# title\n",
    notes: "Some notes.\n",
    sections: new Map(SECTION_ORDER.map((s) => [s, []])),
    sectionPrelude: new Map(SECTION_ORDER.map((s) => [s, ""])),
  };
}

function tk(id: number, title: string, section: Ticket["section"] = "Active"): Ticket {
  return { id, title, section, body: `**Why:** body for #${id}.\n\n` };
}

test("listTickets: no filter returns all tickets in section order", () => {
  const b = emptyBacklog();
  b.sections.get("Active")!.push(tk(2, "second"));
  b.sections.get("Active")!.push(tk(1, "first"));
  b.sections.get("Done (recent)")!.push(tk(100, "done"));

  const out = listTickets(b);
  assert.deepEqual(out.map((t) => t.id), [2, 1, 100]);
});

test("listTickets: status=active includes Active + In progress only", () => {
  const b = emptyBacklog();
  b.sections.get("Active")!.push(tk(1, "a"));
  b.sections.get("In progress")!.push(tk(2, "b"));
  b.sections.get("Done (recent)")!.push(tk(3, "c"));

  const out = listTickets(b, { status: "active" });
  assert.deepEqual(out.map((t) => t.id), [1, 2]);
});

test("listTickets: status=done includes Done (recent) + Done (archived)", () => {
  const b = emptyBacklog();
  b.sections.get("Done (recent)")!.push(tk(1, "a", "Done (recent)"));
  b.sections.get("Done (archived)")!.push(tk(2, "b", "Done (archived)"));
  b.sections.get("Active")!.push(tk(3, "c"));

  const out = listTickets(b, { status: "done" });
  assert.deepEqual(out.map((t) => t.id), [1, 2]);
});

test("listTickets: search filters by title and body, case-insensitive", () => {
  const b = emptyBacklog();
  b.sections.get("Active")!.push({ id: 1, title: "AUTH bug", section: "Active", body: "irrelevant\n" });
  b.sections.get("Active")!.push({ id: 2, title: "dashboard", section: "Active", body: "mentions Auth\n" });
  b.sections.get("Active")!.push({ id: 3, title: "totally unrelated", section: "Active", body: "nothing here\n" });

  const out = listTickets(b, { search: "auth" });
  assert.deepEqual(out.map((t) => t.id), [1, 2]);
});

test("findTicket: returns the right ticket regardless of section", () => {
  const b = emptyBacklog();
  b.sections.get("Active")!.push(tk(1, "a"));
  b.sections.get("Done (recent)")!.push(tk(2, "b", "Done (recent)"));

  assert.equal(findTicket(b, 1)?.title, "a");
  assert.equal(findTicket(b, 2)?.title, "b");
  assert.equal(findTicket(b, 999), undefined);
});

test("maxTicketId: returns the highest id across all sections", () => {
  const b = emptyBacklog();
  b.sections.get("Active")!.push(tk(7, "a"));
  b.sections.get("Done (recent)")!.push(tk(42, "b", "Done (recent)"));
  b.sections.get("Done (archived)")!.push(tk(3, "c", "Done (archived)"));
  assert.equal(maxTicketId(b), 42);
});

test("maxTicketId: empty backlog returns 0", () => {
  assert.equal(maxTicketId(emptyBacklog()), 0);
});

test("addTicket: appends to the named section, returns a new Backlog", () => {
  const b = emptyBacklog();
  const updated = addTicket(b, tk(5, "new"));
  assert.equal(b.sections.get("Active")!.length, 0); // original unchanged
  assert.equal(updated.sections.get("Active")!.length, 1);
  assert.equal(updated.sections.get("Active")![0]!.id, 5);
});

test("moveTicket: relocates the ticket and updates its section field", () => {
  const b0 = emptyBacklog();
  const b1 = addTicket(b0, tk(5, "x"));
  const b2 = moveTicket(b1, 5, "Done (recent)");

  assert.equal(b2.sections.get("Active")!.length, 0);
  assert.equal(b2.sections.get("Done (recent)")!.length, 1);
  assert.equal(b2.sections.get("Done (recent)")![0]!.section, "Done (recent)");
});

test("moveTicket: no-op when target == current section", () => {
  const b1 = addTicket(emptyBacklog(), tk(5, "x"));
  const b2 = moveTicket(b1, 5, "Active");
  // Same object reference for no-op
  assert.equal(b2, b1);
});

test("moveTicket: throws on unknown id", () => {
  assert.throws(() => moveTicket(emptyBacklog(), 999, "Done (recent)"), /not found/);
});

test("closeTicket: moves to Done (recent) and prepends Closed line", () => {
  const b1 = addTicket(emptyBacklog(), { id: 5, title: "x", section: "Active", body: "**Why:** body\n\n" });
  const b2 = closeTicket(b1, 5, { commitSha: "abc1234", date: "2026-05-15" });
  const closed = findTicket(b2, 5)!;
  assert.equal(closed.section, "Done (recent)");
  assert.match(closed.body, /^\*\*Closed:\*\* 2026-05-15\. Commit `abc1234`\./);
  assert.match(closed.body, /\*\*Why:\*\* body/);
});

test("closeTicket: doesn't double-prepend Closed line if already present", () => {
  const b1 = addTicket(emptyBacklog(), {
    id: 5, title: "x", section: "Active",
    body: "**Closed:** 2026-05-01. Already closed.\n\n",
  });
  const b2 = closeTicket(b1, 5, { date: "2026-05-15" });
  const closed = findTicket(b2, 5)!;
  // Should still start with the original Closed line, not a new one
  assert.match(closed.body, /^\*\*Closed:\*\* 2026-05-01/);
  // Count occurrences of "**Closed:**"
  const occurrences = (closed.body.match(/\*\*Closed:\*\*/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test("setNotes: replaces the notes block", () => {
  const b1 = setNotes(emptyBacklog(), "Fresh notes.\n");
  assert.equal(b1.notes, "Fresh notes.\n");
});

test("appendNotes: appends with a blank-line separator", () => {
  const b0: Backlog = { ...emptyBacklog(), notes: "Existing notes.\n" };
  const b1 = appendNotes(b0, "New entry.");
  assert.match(b1.notes, /Existing notes\.\n\nNew entry\.\n$/);
});
