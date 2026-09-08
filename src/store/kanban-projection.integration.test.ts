// FG-785 (external kanban projection, OUTBOUND-ONLY) — the store migration + accessor
// round-trip, against REAL databases. Mirrors fg606-tickets-migration.integration.test.ts
// (the migrated-shape proof) and fg608-migration-parity (the fresh-vs-migrated shape proof).
//
// FG-785 is purely ADDITIVE: it introduces two brand-new tables (kanban_projection_map,
// kanban_conflicts) via CREATE TABLE IF NOT EXISTS on the ordinary open path, and bumps NO
// user_version (the FG-568 forward-gate contract). This file proves:
//
//   - the two tables MATERIALIZE on a FRESH DB and on a PRE-EXISTING migrated DB, with
//     identical column shape (fresh+migrated fixtures)
//   - opening a pre-change DB adds them without touching user_version or losing data
//   - the migration is idempotent (re-open is a no-op)
//   - an insert/read/resolve round-trips through the accessors, and a resolved conflict
//     leaves the open-conflict projection (the inbox source contract)
//
// The real-DB accessor round-trip runs against the production getDb() path over the
// per-process temp FORGE_HOME the harness installs (src/test-setup.ts) — never
// ~/.forge/forge.db. The fresh-vs-migrated SHAPE proof uses in-memory databases so both
// fixtures can be built independently in one process, exactly as fg608-migration-parity does.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { getDb, applyMigrations } from "./db.js";
import {
  upsertProjectionMap,
  getProjectionMap,
  listProjectionMap,
  insertConflict,
  getConflict,
  listOpenConflicts,
  resolveConflict,
  kanbanTableColumns,
} from "./kanban-projection.js";
import { DB_PATH } from "../util/paths.js";

const FG785_TABLES = ["kanban_projection_map", "kanban_conflicts"];

// A minimal PRE-FG-785 store: pre-existing runs/tasks with rows, and NONE of the FG-785
// tables — exactly what a database written by a pre-FG-785 binary looks like.
const LEGACY_DDL = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  metadata TEXT,
  project_dir TEXT
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_id TEXT,
  phase TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  status TEXT NOT NULL,
  task_package TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);
`;

function tableExists(db: DatabaseInstance, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) !== undefined;
}

function countRows(db: DatabaseInstance, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// The FRESH fixture: the production schema on an empty DB.
function freshInMemory(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

// The MIGRATED fixture: a pre-FG-785 DB (legacy tables, none of the FG-785 tables) brought
// forward through the production open path — SCHEMA_SQL then applyMigrations.
function migratedInMemory(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(LEGACY_DDL);
  for (const table of FG785_TABLES) {
    assert.equal(tableExists(db, table), false, `precondition: legacy DB must NOT have ${table}`);
  }
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

// Seed a pre-FG-785 store on disk BEFORE any getDb() call, so the FIRST production open
// migrates it — the real-DB accessor round-trip below runs against that migrated store.
before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  const legacy = new Database(DB_PATH);
  legacy.exec(LEGACY_DDL);
  legacy
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-fg785-legacy", "feature", "a run recorded before FG-785", "active", "2026-09-01T00:00:00Z");
  assert.equal(legacy.pragma("user_version", { simple: true }), 0, "legacy store starts at user_version 0");
  legacy.close();
});

test("FG-785: both tables materialize on a FRESH DB and a MIGRATED DB with identical shape", () => {
  const fresh = freshInMemory();
  const migrated = migratedInMemory();

  for (const table of FG785_TABLES) {
    assert.ok(tableExists(fresh, table), `${table} must exist on a fresh DB`);
    assert.ok(tableExists(migrated, table), `${table} must be created additively on a migrated DB`);
    // A migrated DB (whole-table CREATE IF NOT EXISTS) must carry the same columns a fresh
    // one does — the fresh+migrated parity the FG-785 tables promise.
    assert.deepEqual(
      kanbanTableColumns(migrated, table as "kanban_projection_map" | "kanban_conflicts").sort(),
      kanbanTableColumns(fresh, table as "kanban_projection_map" | "kanban_conflicts").sort(),
      `${table}: migrated column shape must equal fresh`,
    );
  }

  // The migration crossed no destructive boundary — the FG-568 forward gate must not fire.
  assert.equal(migrated.pragma("user_version", { simple: true }), 0, "user_version must NOT be bumped");
  // No data loss: the pre-existing legacy tables survive (empty here, but present).
  assert.ok(tableExists(migrated, "runs") && tableExists(migrated, "tasks"), "legacy tables survive the migration");
});

test("FG-785: opening a pre-change DB through getDb() adds the tables and loses no data", () => {
  const db = getDb(); // the production open path: SCHEMA_SQL + applyMigrations

  for (const table of FG785_TABLES) {
    assert.ok(tableExists(db, table), `${table} must be created additively on open`);
  }
  assert.equal(countRows(db, "runs"), 1, "the migration must not drop the pre-existing run");
  const run = db.prepare(`SELECT * FROM runs WHERE id = 'run-fg785-legacy'`).get() as Record<string, unknown>;
  assert.equal(run["workflow"], "feature");
  assert.equal(run["status"], "active");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "user_version must NOT be bumped");
});

test("FG-785: the projection map round-trips through the accessors and is idempotent", () => {
  getDb();
  const identity = { projectIdentity: "pk-alpha", ticketIdentity: "FG-100", provider: "fake" };

  upsertProjectionMap({
    ...identity,
    externalCardId: "card-1",
    projectionState: "active",
    lastProjectedHash: "hash-v1",
    projectedBy: "kanban-sync@host",
    projectedAt: "2026-09-08T10:00:00Z",
    createdAt: "2026-09-08T10:00:00Z",
  });

  const first = getProjectionMap(identity);
  assert.ok(first);
  assert.equal(first!.externalCardId, "card-1");
  assert.equal(first!.lastProjectedHash, "hash-v1");
  assert.equal(first!.projectionState, "active");
  assert.equal(first!.createdAt, "2026-09-08T10:00:00Z");

  // A re-projection UPSERTs the same identity row — never a duplicate — refreshing the hash
  // and provenance while preserving the original created_at (AC3: repeated sync converges).
  upsertProjectionMap({
    ...identity,
    externalCardId: "card-1",
    projectionState: "archived",
    lastProjectedHash: "hash-v2",
    projectedBy: "kanban-sync@host",
    projectedAt: "2026-09-08T11:00:00Z",
    createdAt: "2026-09-08T99:99:99Z", // must be ignored on conflict
  });

  const second = getProjectionMap(identity);
  assert.ok(second);
  assert.equal(second!.lastProjectedHash, "hash-v2");
  assert.equal(second!.projectionState, "archived");
  assert.equal(second!.createdAt, "2026-09-08T10:00:00Z", "created_at is preserved across re-projection");
  assert.equal(listProjectionMap("pk-alpha", "fake").length, 1, "no duplicate card row after re-projection");
});

test("FG-785: a conflict inserts open, projects into listOpenConflicts, and resolves out of it", () => {
  getDb();
  const forgeVersion = { lane: "In Progress", title: "[redacted]", rank: 3 };
  const externalVersion = { lane: "Done", movedBy: "someone-external" };

  insertConflict({
    id: "conflict-1",
    projectIdentity: "pk-alpha",
    ticketIdentity: "FG-200",
    provider: "fake",
    externalCardId: "card-9",
    kind: "moved",
    forgeVersion,
    externalVersion,
    detectedBy: "kanban-sync@host",
    detectedAt: "2026-09-08T12:00:00Z",
    createdAt: "2026-09-08T12:00:00Z",
  });

  // Duplicate delivery of the same logical conflict is a no-op (idempotent on the id).
  insertConflict({
    id: "conflict-1",
    projectIdentity: "pk-alpha",
    ticketIdentity: "FG-200",
    provider: "fake",
    externalCardId: "card-9",
    kind: "moved",
    forgeVersion: { changed: "ignored" },
    externalVersion: { changed: "ignored" },
    detectedBy: "kanban-sync@host",
    detectedAt: "2026-09-08T12:05:00Z",
    createdAt: "2026-09-08T12:05:00Z",
  });

  const open = listOpenConflicts({ projectIdentity: "pk-alpha", provider: "fake" });
  assert.equal(open.length, 1, "exactly one open conflict, no duplicate from repeated delivery");
  const c = open[0]!;
  assert.equal(c.state, "open");
  assert.equal(c.kind, "moved");
  // Both versions round-trip through the JSON payload columns.
  assert.deepEqual(c.forgeVersion, forgeVersion);
  assert.deepEqual(c.externalVersion, externalVersion);
  assert.equal(c.resolvedBy, null);

  // An authorized resolution closes the row — last-writer-wins is not the default; the store
  // is the resolution authority.
  const resolved = resolveConflict("conflict-1", {
    resolvedBy: "steve@bargelt.com",
    resolvedAt: "2026-09-08T13:00:00Z",
    resolution: "acknowledged external move; Forge projection is canonical",
  });
  assert.equal(resolved, true, "an open conflict resolves");

  // Resolving again is refused — the first resolution wins.
  assert.equal(resolveConflict("conflict-1", {
    resolvedBy: "someone-else",
    resolvedAt: "2026-09-08T14:00:00Z",
    resolution: "second attempt",
  }), false, "an already-resolved conflict does not re-resolve");

  // The resolved row leaves the open projection (the inbox source contract) but persists.
  assert.equal(listOpenConflicts({ projectIdentity: "pk-alpha", provider: "fake" }).length, 0, "resolved conflict is not open");
  const stored = getConflict("conflict-1");
  assert.ok(stored);
  assert.equal(stored!.state, "resolved");
  assert.equal(stored!.resolvedBy, "steve@bargelt.com");
  assert.equal(stored!.resolution, "acknowledged external move; Forge projection is canonical");
});

test("FG-785: re-running applyMigrations on the already-migrated DB is a no-op", () => {
  const db = getDb();
  applyMigrations(db);
  applyMigrations(db);

  for (const table of FG785_TABLES) {
    assert.ok(tableExists(db, table), `${table} still present after idempotent re-open`);
  }
  // The map + conflict rows written above survive an idempotent re-open (no data loss).
  assert.equal(listProjectionMap("pk-alpha", "fake").length, 1, "map row survives re-open");
  assert.ok(getConflict("conflict-1"), "conflict row survives re-open");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "still no user_version bump");
});
