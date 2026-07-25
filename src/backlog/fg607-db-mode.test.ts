// FG-607 (FG-496 Slice B): the eight seam functions operating in db mode.
//
// Real store code against a real in-memory SQLite DB and real temp project dirs.
// The properties that matter beyond "it round-trips":
//   - `blocked` survives symmetrically. The DB status vocabulary has no 'blocked'
//     (a CHECK forbids it); it is stored as active + a blocker_evidence row and
//     reconstructed on read. A lossy round-trip here means readiness can never
//     report blocked and the dispatcher would hand an agent a blocked ticket.
//   - the mode is AUTHORITATIVE: a ticket missing from the DB is missing, even if
//     a Markdown file with that id is sitting right there.
//   - db writes touch NO files, so `git status` stays clean.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  blockerEvidenceForTicket,
  bumpIdSequence,
  getIdSequence,
  getTicket,
  relationsForTicket,
  setStorageMode,
  upsertBlockerEvidence,
  upsertTicket,
  LEGACY_BLOCKED_SOURCE,
} from "../store/tickets.js";
import { clearBacklogStoreCache } from "./storage-mode.js";
import {
  closeTicket,
  fileNewTicket,
  fillClosedCommit,
  listTickets,
  moveTicket,
  readTicket,
  retitleTicket,
  ticketExists,
  writeTicket,
  type StructuredTicket,
} from "./structured.js";

const PK = "pk-fg607";
const NOW = "2026-07-24T00:00:00Z";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let dir: string;
const dirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
  dir = mkdtempSync(join(tmpdir(), "fg607-db-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), `project_key: ${PK}\nbacklog:\n  prefix: FG\n`);
  setStorageMode(PK, "db", NOW);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  clearBacklogStoreCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ticket(over: Partial<StructuredTicket> = {}): StructuredTicket {
  return {
    id: "FG-1",
    type: "story",
    status: "active",
    title: "a story",
    body: "the body",
    created: "2026-01-01",
    ...over,
  };
}

// Markdown file with the SAME id, to prove the db branch never reads it.
function writeMarkdownDecoy(id: string, title: string): void {
  const sub = join(dir, "backlog", "stories");
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, `${id}-decoy.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\n---\n\ndecoy body\n`,
  );
}

test("write -> read round-trips every frontmatter field", () => {
  const t = ticket({ related: ["FG-9", "FG-8"], epic: "FG-100" });
  writeTicket(dir, t);

  const got = readTicket(dir, "FG-1");
  assert.equal(got.id, "FG-1");
  assert.equal(got.type, "story");
  assert.equal(got.status, "active");
  assert.equal(got.title, "a story");
  assert.equal(got.body, "the body");
  assert.equal(got.created, "2026-01-01");
  assert.equal(got.epic, "FG-100");
  assert.deepEqual([...(got.related ?? [])].sort(), ["FG-8", "FG-9"]);
});

test("writes create NO files — git status stays clean in db mode", () => {
  writeTicket(dir, ticket());
  closeTicket(dir, "FG-1", "abc1234");
  assert.equal(existsSync(join(dir, "backlog")), false, "db mode must not create backlog/");
});

test("ticketExists reflects the DB, not the filesystem", () => {
  writeMarkdownDecoy("FG-77", "only on disk");
  assert.equal(ticketExists(dir, "FG-77"), false, "a Markdown file is not a db-mode ticket");
  writeTicket(dir, ticket({ id: "FG-77" }));
  assert.equal(ticketExists(dir, "FG-77"), true);
});

// The mode is authoritative — NO read-through blending, NO fallback. A fallback
// here would reintroduce exactly the split truth FG-496 exists to kill.
test("a missing ticket errors instead of falling back to a Markdown file with the same id", () => {
  writeMarkdownDecoy("FG-42", "decoy title");
  assert.throws(() => readTicket(dir, "FG-42"), /Ticket FG-42 not found/);
});

test("listTickets honors type/status/search filters and sorts by numeric id", () => {
  writeTicket(dir, ticket({ id: "FG-2", title: "second", type: "epic" }));
  writeTicket(dir, ticket({ id: "FG-10", title: "tenth needle" }));
  writeTicket(dir, ticket({ id: "FG-1", title: "first", status: "done", closed: "2026-02-02" }));

  assert.deepEqual(listTickets(dir).map((t) => t.id), ["FG-1", "FG-2", "FG-10"]);
  assert.deepEqual(listTickets(dir, { status: "active" }).map((t) => t.id), ["FG-2", "FG-10"]);
  assert.deepEqual(listTickets(dir, { type: "epic" }).map((t) => t.id), ["FG-2"]);
  assert.deepEqual(listTickets(dir, { search: "NEEDLE" }).map((t) => t.id), ["FG-10"]);
});

test("closeTicket marks done, stamps the close date, and records the commit", () => {
  writeTicket(dir, ticket());
  closeTicket(dir, "FG-1", "deadbee");

  const got = readTicket(dir, "FG-1");
  assert.equal(got.status, "done");
  assert.equal(got.closedCommit, "deadbee");
  assert.match(got.closed ?? "", /^\d{4}-\d{2}-\d{2}$/);
});

test("closeTicket on a missing ticket throws, same as the Markdown path", () => {
  assert.throws(() => closeTicket(dir, "FG-404"), /Ticket FG-404 not found/);
});

test("retitleTicket updates the title and the echoing body heading", () => {
  writeTicket(dir, ticket({ body: "# a story\n\nsome text" }));
  retitleTicket(dir, "FG-1", "a better story");

  const got = readTicket(dir, "FG-1");
  assert.equal(got.title, "a better story");
  assert.equal(got.body, "# a better story\n\nsome text");
});

test("moveTicket changes type, reactivates, and drops the close fields", () => {
  writeTicket(dir, ticket());
  closeTicket(dir, "FG-1", "abc1234");
  moveTicket(dir, "FG-1", "epic");

  const got = readTicket(dir, "FG-1");
  assert.equal(got.type, "epic");
  assert.equal(got.status, "active");
  assert.equal(got.closed, undefined);
  assert.equal(got.closedCommit, undefined);
});

test("fillClosedCommit is additive and best-effort: no-ops on missing / non-done / already-set", () => {
  fillClosedCommit(dir, "FG-404", "nope"); // missing — silent no-op

  writeTicket(dir, ticket());
  fillClosedCommit(dir, "FG-1", "nope");
  assert.equal(readTicket(dir, "FG-1").closedCommit, undefined, "not done — no gap to fill");

  closeTicket(dir, "FG-1");
  fillClosedCommit(dir, "FG-1", "filled1");
  assert.equal(readTicket(dir, "FG-1").closedCommit, "filled1");

  fillClosedCommit(dir, "FG-1", "second");
  assert.equal(readTicket(dir, "FG-1").closedCommit, "filled1", "an existing SHA always wins");
});

// The headline correctness property. 'blocked' is not a stored status.
test("blocked round-trips symmetrically through blocker_evidence", () => {
  writeTicket(dir, ticket({ status: "blocked" }));

  const row = getTicket(PK, "FG-1")!;
  assert.equal(row.status, "active", "the DB vocabulary has no 'blocked'");
  const evidence = blockerEvidenceForTicket(PK, "FG-1");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.source, LEGACY_BLOCKED_SOURCE);

  assert.equal(readTicket(dir, "FG-1").status, "blocked", "reconstructed on read");
  assert.deepEqual(listTickets(dir, { status: "blocked" }).map((t) => t.id), ["FG-1"]);
});

test("unblocking DELETES the evidence row — otherwise it reads back blocked forever", () => {
  writeTicket(dir, ticket({ status: "blocked" }));
  writeTicket(dir, { ...ticket(), status: "active" });

  assert.equal(blockerEvidenceForTicket(PK, "FG-1").length, 0);
  assert.equal(readTicket(dir, "FG-1").status, "active");
});

test("closing a blocked ticket clears its blocked state", () => {
  writeTicket(dir, ticket({ status: "blocked" }));
  closeTicket(dir, "FG-1");

  assert.equal(readTicket(dir, "FG-1").status, "done");
  assert.equal(blockerEvidenceForTicket(PK, "FG-1").length, 0);
});

test("an imported blocked ticket keeps its evidence (and reason) across an unrelated edit", () => {
  writeTicket(dir, ticket({ status: "blocked" }));
  const reasonBefore = blockerEvidenceForTicket(PK, "FG-1")[0]!.reason;

  const t = readTicket(dir, "FG-1");
  writeTicket(dir, { ...t, body: "edited body" });

  assert.equal(readTicket(dir, "FG-1").status, "blocked", "an edit must not silently unblock");
  assert.equal(blockerEvidenceForTicket(PK, "FG-1")[0]!.reason, reasonBefore, "provenance preserved");
});

// The evidence row's created_at is the ticket's "blocked since". ON CONFLICT
// overwrites it, so a seam write that always passed `now` let an unrelated body
// edit reset it — the ticket would read as freshly blocked forever.
test("a body edit preserves 'blocked since'; a fresh block re-stamps it", () => {
  writeTicket(dir, ticket({ status: "blocked" }));
  const blockedSince = "2020-01-01T00:00:00.000Z";
  upsertBlockerEvidence({ ...blockerEvidenceForTicket(PK, "FG-1")[0]!, createdAt: blockedSince });

  const t = readTicket(dir, "FG-1");
  writeTicket(dir, { ...t, body: "an unrelated body edit" });

  assert.equal(readTicket(dir, "FG-1").status, "blocked");
  assert.equal(
    blockerEvidenceForTicket(PK, "FG-1")[0]!.createdAt,
    blockedSince,
    "an unrelated edit must not reset when the ticket became blocked",
  );

  // Unblock (the row is deleted) and block again: that IS a new blocker, so it
  // stamps now.
  writeTicket(dir, { ...t, status: "active" });
  assert.equal(blockerEvidenceForTicket(PK, "FG-1").length, 0);
  writeTicket(dir, { ...t, status: "blocked" });
  assert.ok(
    blockerEvidenceForTicket(PK, "FG-1")[0]!.createdAt > blockedSince,
    "a fresh block stamps the current time",
  );
});

test("related[] is a replace-set — a removed id is really removed", () => {
  writeTicket(dir, ticket({ related: ["FG-2", "FG-3"] }));
  assert.equal(relationsForTicket(PK, "FG-1").length, 2);

  writeTicket(dir, ticket({ related: ["FG-3"] }));
  assert.deepEqual(readTicket(dir, "FG-1").related, ["FG-3"]);

  writeTicket(dir, ticket());
  assert.equal(readTicket(dir, "FG-1").related, undefined);
  assert.equal(relationsForTicket(PK, "FG-1").length, 0);
});

// Import preserves the FULL raw frontmatter as JSON so nothing the Markdown
// carried is lost. The seam must not clobber those unmodeled keys on write.
test("unknown frontmatter survives a seam read-modify-write; owned keys are rewritten", () => {
  upsertTicket({
    projectKey: PK,
    ticketId: "FG-5",
    type: "story",
    status: "done",
    title: "imported",
    body: "b",
    created: "2026-01-01",
    closed: "2026-02-02",
    frontmatter: { id: "FG-5", type: "story", status: "done", title: "imported", closed: "2026-02-02", sticky: 41, owner: "sb" },
    importedAt: NOW,
  });

  moveTicket(dir, "FG-5", "epic"); // reactivates and drops `closed`

  const fm = getTicket(PK, "FG-5")!.frontmatter!;
  assert.equal(fm["sticky"], 41, "unmodeled keys survive");
  assert.equal(fm["owner"], "sb");
  assert.equal(fm["type"], "epic", "owned keys track the new state");
  assert.equal(fm["status"], "active");
  assert.equal(fm["closed"], undefined, "a dropped owned key does not linger as stale overflow");
});

// imported_at / imported_from mean "when and where this row was imported from
// Markdown" (schema.ts) — they are the import's reconcile provenance. A db-mode
// edit is not an import, so the seam must leave both alone.
test("a seam write preserves import provenance — imported_at/imported_from are not touched", () => {
  upsertTicket({
    projectKey: PK,
    ticketId: "FG-5",
    type: "story",
    status: "active",
    title: "imported",
    body: "b",
    importedAt: "2026-01-01T00:00:00Z",
    importedFrom: "/repos/main",
  });

  writeTicket(dir, { ...readTicket(dir, "FG-5"), body: "edited body" });
  retitleTicket(dir, "FG-5", "renamed");
  closeTicket(dir, "FG-5", "abc1234");

  const row = getTicket(PK, "FG-5")!;
  assert.equal(row.body, "edited body", "the edit landed");
  assert.equal(row.title, "renamed");
  assert.equal(row.importedAt, "2026-01-01T00:00:00Z", "the EDIT time must not overwrite the import time");
  assert.equal(row.importedFrom, "/repos/main", "import provenance survives every seam write");
});

test("a ticket the seam CREATES was never imported — imported_from stays null", () => {
  writeTicket(dir, ticket({ id: "FG-6" }));
  assert.equal(getTicket(PK, "FG-6")!.importedFrom, null);
});

test("fileNewTicket allocates from the (project_key, prefix) sequence and advances it", () => {
  bumpIdSequence(PK, "FG", 7);

  const a = fileNewTicket(dir, { type: "story", title: "first", body: "one" });
  const b = fileNewTicket(dir, { type: "idea", title: "second", body: "two" });

  assert.equal(a, "FG-7");
  assert.equal(b, "FG-8");
  assert.equal(getIdSequence(PK, "FG"), 9);
  assert.equal(readTicket(dir, "FG-8").type, "idea");
  assert.equal(readTicket(dir, "FG-7").status, "active");
  assert.equal(existsSync(join(dir, "backlog")), false, "filing writes no files in db mode");
});

test("fileNewTicket refuses on an unseeded sequence rather than minting FG-1 over Markdown history", () => {
  assert.throws(() => fileNewTicket(dir, { type: "story", title: "x", body: "" }), /forge backlog import/);
});

// Markdown mode is the DEFAULT and is unchanged this slice — fileNewTicket's
// markdown branch is the read-max-id -> write critical section lifted out of the
// CLI verbatim.
test("markdown mode still allocates max-id + 1 and writes a file", () => {
  const mdDir = mkdtempSync(join(tmpdir(), "fg607-md-"));
  dirs.push(mdDir);
  mkdirSync(join(mdDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(mdDir, "backlog", "stories", "FG-4-x.md"),
    `---\nid: FG-4\ntype: story\nstatus: active\ntitle: x\n---\n\nbody\n`,
  );

  const id = fileNewTicket(mdDir, { type: "story", title: "new one", body: "b" });
  assert.equal(id, "FG-5");
  assert.ok(readdirSync(join(mdDir, "backlog", "stories")).includes("FG-5-new-one.md"));
  assert.equal(readTicket(mdDir, "FG-5").title, "new one");
});
