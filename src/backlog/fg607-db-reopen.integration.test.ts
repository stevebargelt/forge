// FG-607 (FG-496 Slice B): the seam across a DB close/reopen.
//
// Before this slice, reading a ticket was a pure filesystem read, so a process
// that closed its DB connection could still read tickets. The seam now resolves
// a storage mode first, which opens the store — and the module-level handle
// cache in src/store/db.ts happily handed back a CLOSED connection, so the
// first prepare() after a close threw "The database connection is not open"
// from inside what still looks like a file read. That is how
// src/campaign/planner.integration.test.ts went red: it closes the DB to
// simulate a restart, and the next test's writeTicket landed on the corpse.
//
// Two properties, both of them the connection's lifecycle rather than the
// seam's:
//   1. a closed handle is not a connection — the next resolve reopens
//   2. a memoized resolution never outlives the connection it came from

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../store/schema.js";
import { applyMigrations, closeDb, getDb, setDbForTest } from "../store/db.js";
import { setStorageMode, upsertSeamTicket } from "../store/tickets.js";
import { computeRepositoryEvidence, deriveProjectKey } from "../store/project-registry.js";
import { listTickets, writeTicket } from "./structured.js";
import { clearBacklogStoreCache, resolveBacklogStore } from "./storage-mode.js";

let root: string;
let savedDbPath: string | undefined;
let savedPrev: DatabaseInstance | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-reopen-"));
  savedDbPath = process.env.FORGE_DB_PATH;
  clearBacklogStoreCache();
});

afterEach(() => {
  closeDb();
  if (savedPrev !== null) setDbForTest(savedPrev);
  savedPrev = null;
  if (savedDbPath === undefined) delete process.env.FORGE_DB_PATH;
  else process.env.FORGE_DB_PATH = savedDbPath;
  clearBacklogStoreCache();
  rmSync(root, { recursive: true, force: true });
});

function openStore(path: string): DatabaseInstance {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

function markdownTicket(projectDir: string, id: string, title: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-slug.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\n---\n\nbody\n`,
  );
}

test("integration: the seam reopens the store after a close instead of reaching into the dead handle", () => {
  const dbPath = join(root, "forge.db");
  process.env.FORGE_DB_PATH = dbPath;
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");

  const db1 = openStore(dbPath);
  savedPrev = setDbForTest(db1);

  writeTicket(projectA, { id: "FG-1", type: "story", status: "active", title: "Before", body: "" });
  assert.equal(listTickets(projectA).length, 1);

  // The restart the planner suite simulates: the connection is gone, but the
  // handle is still installed and forge.db is still on disk.
  db1.close();

  // Project B was never resolved, so no memo can mask the dead connection —
  // this is the exact shape of the planner failure. It must reopen, not throw.
  markdownTicket(projectB, "FG-2", "Fresh project");
  const fromB = listTickets(projectB);
  assert.deepEqual(
    fromB.map((t) => t.id),
    ["FG-2"],
  );

  // And the already-resolved project reopens too — the memo must not be the
  // only reason a read after a close works.
  const fromA = listTickets(projectA);
  assert.deepEqual(
    fromA.map((t) => t.id),
    ["FG-1"],
  );
  writeTicket(projectA, { id: "FG-3", type: "story", status: "active", title: "After", body: "" });
  assert.equal(listTickets(projectA).length, 2);
});

test("integration: a db-mode resolution does not outlive the connection it was resolved against", () => {
  const dbPathA = join(root, "a.db");
  const dbPathB = join(root, "b.db");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });

  process.env.FORGE_DB_PATH = dbPathA;
  const dbA = openStore(dbPathA);
  savedPrev = setDbForTest(dbA);

  // Store A knows this project and calls it db-mode.
  const evidenceKey = computeRepositoryEvidence(projectDir).key;
  const projectKey = deriveProjectKey(evidenceKey);
  getDb()
    .prepare(
      `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(projectKey, evidenceKey, "test", "2026-07-25T00:00:00Z");
  setStorageMode(projectKey, "db", "2026-07-25T00:00:00Z");
  upsertSeamTicket({
    projectKey,
    ticketId: "FG-900",
    type: "story",
    status: "active",
    title: "Lives in store A",
    body: "",
    importedAt: "2026-07-25T00:00:00Z",
  });
  // A Markdown ticket that store A's db mode deliberately ignores — it is the
  // tell for which store answered.
  markdownTicket(projectDir, "FG-901", "Lives on disk");

  assert.equal(resolveBacklogStore(projectDir).mode, "db");
  assert.deepEqual(
    listTickets(projectDir).map((t) => t.id),
    ["FG-900"],
  );

  // Swap stores well inside the memo's TTL. Store B has never heard of this
  // project, so the honest answer is markdown — a cached `db` resolution here
  // would send reads (and writes) to a project_key store B does not register.
  dbA.close();
  process.env.FORGE_DB_PATH = dbPathB;
  const dbB = openStore(dbPathB);
  setDbForTest(dbB);

  assert.equal(
    resolveBacklogStore(projectDir).mode,
    "markdown",
    "the resolution was derived from store A's connection and must not survive it",
  );
  assert.deepEqual(
    listTickets(projectDir).map((t) => t.id),
    ["FG-901"],
    "reads must follow the live store, not the dead one",
  );
});
