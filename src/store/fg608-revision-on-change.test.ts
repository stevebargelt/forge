// FG-608 red F11: the monotonic revision must advance on a CONTENT CHANGE, not on
// a write. Re-importing byte-identical Markdown bumped it, which published a new
// snapshot whose only difference was the number — and every running agent then read
// "this ticket has ADVANCED since the task was dispatched" for a ticket that had
// not moved. A notice that cries wolf on routine re-imports stops meaning anything
// on the amendment it exists to announce.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { ensureStorageMode, getTicket, upsertTicket } from "./tickets.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const KEY = "pk-revision";
const NOW = "2026-07-29T00:00:00Z";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  writeTransaction(() => ensureStorageMode(KEY, NOW));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

function importTicket(fields: { title?: string; status?: string; body?: string } = {}): void {
  writeTransaction(() =>
    upsertTicket({
      projectKey: KEY,
      ticketId: "FG-1",
      type: "story",
      status: (fields.status ?? "active") as "active",
      title: fields.title ?? "a title",
      body: fields.body ?? "a body",
      importedAt: NOW,
      importedFrom: "backlog/stories/FG-1-a.md",
    }),
  );
}

test("FG-608 F11: re-importing identical content leaves the revision alone", () => {
  importTicket();
  assert.equal(getTicket(KEY, "FG-1")!.revision, 1);
  const hash = getTicket(KEY, "FG-1")!.bodyHash;

  importTicket();
  importTicket();
  const row = getTicket(KEY, "FG-1")!;
  assert.equal(row.revision, 1, "three imports of the same bytes are one state, not three");
  assert.equal(row.bodyHash, hash);
  assert.equal(row.importBasisHash, hash, "the import basis is still rebased — only the counter holds still");
});

test("FG-608 F11: any real edit still advances it — body, title and status alike", () => {
  importTicket();
  importTicket({ body: "amended" });
  assert.equal(getTicket(KEY, "FG-1")!.revision, 2);

  importTicket({ body: "amended", title: "retitled" });
  assert.equal(getTicket(KEY, "FG-1")!.revision, 3);

  importTicket({ body: "amended", title: "retitled", status: "done" });
  assert.equal(getTicket(KEY, "FG-1")!.revision, 4, "the hash covers type/status/title/body");

  importTicket({ body: "amended", title: "retitled", status: "done" });
  assert.equal(getTicket(KEY, "FG-1")!.revision, 4, "and holds again once the content settles");
});
