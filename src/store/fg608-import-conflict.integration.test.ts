// FG-608 (acceptance 9): THE IMPORT CONFLICT RULE.
//
// After cutover the DB is authoritative, so a re-import is no longer a harmless
// refresh of a shadow — it is Markdown proposing to overwrite live truth. The rule
// is: a known id whose DB row was edited SINCE ITS IMPORT BASIS is left as-is and
// a conflict event is written. Markdown never silently clobbers a newer DB edit.
// `--force` overwrites only when explicitly supplied, and records before/after
// evidence in the event.
//
// The two revision semantics are separately load-bearing here, and both are
// asserted: the CONTENT basis (body_hash vs import_basis_hash) decides divergence,
// and the MONOTONIC counter decides advancement. An edit-and-revert proves they
// are not interchangeable — the hash returns to its original value while the
// counter keeps climbing.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { importBacklog } from "./backlog-import.js";
import { getTicket, eventsForTicket, setStorageMode, ticketContentHash } from "./tickets.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";
import { writeTicket, readTicket } from "../backlog/structured.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearBacklogStoreCache();
});

const NOW = "2026-07-29T00:00:00Z";

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg608-conflict-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  dirs.push(dir);
  return dir;
}

type Fm = Record<string, unknown> & { id: string; type: string; status: string; title: string };

function writeTicketFile(projectDir: string, fm: Fm, body: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${fm.id}-slug.md`),
    `---\n${stringifyYaml(fm, { lineWidth: 0 })}---\n\n${body}\n`,
  );
}

function conflictEvents(projectKey: string, id: string) {
  return eventsForTicket(projectKey, id).filter((e) => e.eventType === "import_conflict");
}

// ─── the two revision semantics ──────────────────────────────────────────────

test("FG-608: the revision counter is MONOTONIC across import and seam writes", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-1", type: "story", status: "active", title: "t" }, "one");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });
  assert.equal(getTicket(projectKey, "FG-1")!.revision, 1, "a fresh insert is revision 1");

  importBacklog(dir, { now: NOW, sourceId: "s" });
  assert.equal(getTicket(projectKey, "FG-1")!.revision, 2, "an import IS an authoritative write");

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-1"), body: "two" });
  assert.equal(getTicket(projectKey, "FG-1")!.revision, 3, "a seam edit advances it too");
});

test("FG-608: an edit-and-revert still shows ADVANCEMENT — the counter backs this, not the hash", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-2", type: "story", status: "active", title: "t" }, "original");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });
  const start = getTicket(projectKey, "FG-2")!;
  const originalHash = start.bodyHash!;
  const originalRevision = start.revision!;

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  const originalBody = readTicket(dir, "FG-2").body;
  writeTicket(dir, { ...readTicket(dir, "FG-2"), body: "changed" });
  writeTicket(dir, { ...readTicket(dir, "FG-2"), body: originalBody });

  const after = getTicket(projectKey, "FG-2")!;
  assert.equal(after.bodyHash, originalHash, "the CONTENT hash returned to its original value");
  assert.equal(
    after.revision,
    originalRevision + 2,
    "the counter still shows the ticket advanced — a hash alone could not express this",
  );
});

test("FG-608: import REBASES the content basis; a seam edit moves body_hash and leaves the basis", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-3", type: "story", status: "active", title: "t" }, "b");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  const imported = getTicket(projectKey, "FG-3")!;
  assert.equal(imported.bodyHash, imported.importBasisHash, "after import the row IS its own basis");

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-3"), body: "edited in db mode" });

  const edited = getTicket(projectKey, "FG-3")!;
  assert.notEqual(edited.bodyHash, edited.importBasisHash, "the two diverge exactly on a db-mode edit");
  assert.equal(edited.importBasisHash, imported.importBasisHash, "the basis is NOT clobbered by the seam");
});

// ─── skip + conflict event (the default) ─────────────────────────────────────

test("FG-608: a divergent id is SKIPPED and records a conflict event — Markdown does not clobber", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-10", type: "story", status: "active", title: "orig" }, "markdown body");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  // A db-mode edit lands AFTER the import basis.
  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-10"), body: "NEWER db edit" });
  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();

  // Markdown now proposes a different body for the same id.
  writeTicketFile(dir, { id: "FG-10", type: "story", status: "active", title: "orig" }, "stale markdown body");
  const result = importBacklog(dir, { now: NOW, sourceId: "s" });

  assert.deepEqual(result.skippedConflicts, ["FG-10"]);
  assert.deepEqual(result.forcedOverwrites, []);
  assert.equal(
    getTicket(projectKey, "FG-10")!.body,
    "NEWER db edit",
    "the newer DB edit survives — nothing was clobbered",
  );

  const events = conflictEvents(projectKey, "FG-10");
  assert.equal(events.length, 1, "the conflict is recorded, not merely skipped");
  assert.equal(events[0]!.payload!["resolution"], "skipped");
  assert.match(String(events[0]!.payload!["reason"]), /edited in the DB since its import basis/);
});

test("FG-608: a re-import neither duplicates nor loses rows when a conflict is skipped", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-11", type: "story", status: "active", title: "a" }, "x");
  writeTicketFile(dir, { id: "FG-12", type: "story", status: "active", title: "b" }, "y");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-11"), body: "db edit" });
  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();

  writeTicketFile(dir, { id: "FG-11", type: "story", status: "active", title: "a" }, "markdown again");
  importBacklog(dir, { now: NOW, sourceId: "s" });

  assert.equal(getTicket(projectKey, "FG-11")!.body, "db edit", "the conflicting id kept its DB edit");
  assert.equal(getTicket(projectKey, "FG-12")!.body, "y\n", "an unconflicted sibling imported normally");
});

test("FG-608: a skipped conflict still records membership — it does not become prunable", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-13", type: "story", status: "active", title: "a" }, "x");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-13"), body: "db edit" });
  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();

  writeTicketFile(dir, { id: "FG-13", type: "story", status: "active", title: "a" }, "different");
  const second = importBacklog(dir, { now: NOW, sourceId: "s" });
  assert.deepEqual(second.skippedConflicts, ["FG-13"]);
  assert.deepEqual(second.prunedTickets, [], "a skipped ticket is still claimed by this source");

  // And a THIRD import must not suddenly prune it either.
  const third = importBacklog(dir, { now: NOW, sourceId: "s" });
  assert.deepEqual(third.prunedTickets, []);
  assert.ok(getTicket(projectKey, "FG-13"));
});

// ─── --force, with before/after evidence ─────────────────────────────────────

test("FG-608: --force overwrites and records BEFORE/AFTER evidence in the event", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-20", type: "story", status: "active", title: "t" }, "original");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-20"), body: "db edit that will be destroyed" });
  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();

  writeTicketFile(dir, { id: "FG-20", type: "story", status: "active", title: "t" }, "markdown wins");
  const result = importBacklog(dir, { now: NOW, sourceId: "s", force: true });

  assert.deepEqual(result.forcedOverwrites, ["FG-20"]);
  assert.deepEqual(result.skippedConflicts, []);
  assert.equal(getTicket(projectKey, "FG-20")!.body, "markdown wins\n");

  const [event] = conflictEvents(projectKey, "FG-20");
  assert.ok(event, "a forced overwrite is recorded too");
  assert.equal(event.payload!["resolution"], "forced");
  const before = event.payload!["before"] as Record<string, unknown>;
  const after = event.payload!["after"] as Record<string, unknown>;
  assert.equal(
    before["body"],
    "db edit that will be destroyed",
    "the destroyed content is recoverable from the event, not merely noted",
  );
  assert.equal(after["body"], "markdown wins\n");
  assert.notEqual(before["bodyHash"], after["bodyHash"]);
});

test("FG-608: --force is NOT the default — the same import without it skips", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-21", type: "story", status: "active", title: "t" }, "original");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-21"), body: "db edit" });
  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();

  writeTicketFile(dir, { id: "FG-21", type: "story", status: "active", title: "t" }, "markdown");
  assert.deepEqual(importBacklog(dir, { now: NOW, sourceId: "s" }).forcedOverwrites, []);
  assert.equal(getTicket(projectKey, "FG-21")!.body, "db edit");
});

// ─── the three NON-conflict cases, each for a stated reason ──────────────────

test("FG-608: an unchanged re-import is not a conflict", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-30", type: "story", status: "active", title: "t" }, "same");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });
  const second = importBacklog(dir, { now: NOW, sourceId: "s" });
  assert.deepEqual(second.skippedConflicts, []);
  assert.equal(conflictEvents(projectKey, "FG-30").length, 0);
});

test("FG-608: Markdown that already AGREES with the db edit is not a conflict", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-31", type: "story", status: "active", title: "t" }, "v1");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, { ...readTicket(dir, "FG-31"), body: "v2\n" });
  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();

  // Markdown is brought in line with the db edit. There is nothing to clobber.
  writeTicketFile(dir, { id: "FG-31", type: "story", status: "active", title: "t" }, "v2");
  const result = importBacklog(dir, { now: NOW, sourceId: "s" });
  assert.deepEqual(result.skippedConflicts, [], "content already agrees — writing is a no-op");
  assert.equal(conflictEvents(projectKey, "FG-31").length, 0);
});

test("FG-608: a pre-FG-608 row with no content basis is adopted, not jammed as a conflict", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-32", type: "story", status: "active", title: "t" }, "body");
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });

  // Reproduce the pre-FG-608 shape: basis columns NULL.
  db.prepare(
    `UPDATE tickets SET body_hash = NULL, import_basis_hash = NULL WHERE project_key = ? AND ticket_id = ?`,
  ).run(projectKey, "FG-32");

  writeTicketFile(dir, { id: "FG-32", type: "story", status: "active", title: "t" }, "new body");
  const result = importBacklog(dir, { now: NOW, sourceId: "s" });
  assert.deepEqual(result.skippedConflicts, [], "a row that predates the basis columns is backfilled");
  const row = getTicket(projectKey, "FG-32")!;
  assert.equal(row.body, "new body\n");
  assert.equal(row.bodyHash, row.importBasisHash, "and it now HAS a basis");
});

test("FG-608: a seam-created row an import collides with IS a conflict", () => {
  const dir = newProject();
  // Claim the project with an empty import so the seam can allocate.
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "s" });
  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  writeTicket(dir, {
    id: "FG-40",
    type: "story",
    status: "active",
    title: "created in the DB",
    body: "db native",
  });
  const created = getTicket(projectKey, "FG-40")!;
  assert.equal(created.importBasisHash, null, "a seam-created row was never imported");

  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();
  writeTicketFile(dir, { id: "FG-40", type: "story", status: "active", title: "from markdown" }, "md");
  const result = importBacklog(dir, { now: NOW, sourceId: "s" });

  assert.deepEqual(result.skippedConflicts, ["FG-40"], "a genuine id collision, not a re-import");
  assert.equal(getTicket(projectKey, "FG-40")!.body, "db native");
  assert.match(
    String(conflictEvents(projectKey, "FG-40")[0]!.payload!["reason"]),
    /created in the DB and never imported/,
  );
});

test("FG-608: the content hash ignores provenance — imported_at/imported_from never move it", () => {
  const base = {
    type: "story",
    status: "active",
    title: "t",
    body: "b",
    created: null,
    closed: null,
    closedCommit: null,
    epic: null,
  };
  assert.equal(ticketContentHash(base), ticketContentHash({ ...base }));
  assert.notEqual(ticketContentHash(base), ticketContentHash({ ...base, body: "b2" }));
  assert.notEqual(ticketContentHash(base), ticketContentHash({ ...base, status: "done" }));
});
