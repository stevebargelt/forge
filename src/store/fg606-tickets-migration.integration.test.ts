// FG-606 (FG-496 Slice A) — the migration, against a REAL pre-change database.
//
// Mirrors fg523-verdicts-migration.integration.test.ts. FG-606 is purely
// ADDITIVE: it introduces brand-new tables (tickets, ticket_events,
// ticket_relations, ticket_storage_mode, ticket_id_sequence, blocker_evidence,
// project_identity) via CREATE TABLE IF NOT EXISTS on the ordinary open path, and
// bumps NO user_version (the FG-568 forward-gate contract). This file builds a
// database from a PRE-FG-606 shape on disk (existing tables + rows, none of the
// new tables), opens it through the production getDb() path (SCHEMA_SQL +
// applyMigrations), and asserts:
//
//   - the new tables LAND (they did not exist before)
//   - no data loss: pre-existing rows survive with counts unchanged
//   - user_version stays 0 (no destructive boundary crossed)
//   - the migration is idempotent (re-open is a no-op)
//   - the new tables are usable after the migration (a ticket round-trips)
//
// The DB lives at DB_PATH under the per-process temp FORGE_HOME the harness
// installs (src/test-setup.ts) — never ~/.forge/forge.db.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { getDb, applyMigrations } from "./db.js";
import { upsertTicket, getTicket, ticketsForProject } from "./tickets.js";
import { DB_PATH } from "../util/paths.js";

// A minimal PRE-FG-606 store: the pre-existing runs/tasks tables with rows, and
// NONE of the FG-606 tables. This is exactly what a database written by a
// pre-FG-606 binary looks like from the FG-606 tables' point of view.
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

const FG606_TABLES = [
  "tickets",
  "ticket_events",
  "ticket_relations",
  "ticket_storage_mode",
  "ticket_id_sequence",
  "blocker_evidence",
  "project_identity",
];

const EXPECTED_ROWS = { runs: 1, tasks: 2 };

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) !== undefined
  );
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  const legacy = new Database(DB_PATH);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(LEGACY_DDL);

  for (const table of FG606_TABLES) {
    assert.equal(
      tableExists(legacy, table),
      false,
      `precondition: the legacy DB must NOT have ${table}, or this test proves nothing`,
    );
  }

  legacy
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-fg606-legacy", "feature", "a run recorded before FG-606", "active", "2026-07-01T00:00:00Z");

  const insertTask = legacy.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const id of ["task-fg606-a", "task-fg606-b"]) {
    insertTask.run(id, "run-fg606-legacy", "build", "backend-specialist", "complete", "{}", "2026-07-01T00:00:01Z");
  }

  assert.equal(legacy.pragma("user_version", { simple: true }), 0, "legacy store starts at user_version 0");
  legacy.close();
});

test("FG-606 migration: opening a pre-change DB through getDb() adds the ticket tables and loses no data", () => {
  const db = getDb(); // the production open path: SCHEMA_SQL + applyMigrations

  for (const table of FG606_TABLES) {
    assert.ok(tableExists(db, table), `${table} must be created additively on open`);
  }

  for (const [table, n] of Object.entries(EXPECTED_ROWS)) {
    assert.equal(countRows(db, table), n, `${table}: the migration must not drop or duplicate rows`);
  }

  // Field-level spot-check: the pre-existing rows are untouched.
  const run = db.prepare(`SELECT * FROM runs WHERE id = 'run-fg606-legacy'`).get() as Record<string, unknown>;
  assert.equal(run["workflow"], "feature");
  assert.equal(run["status"], "active");
  assert.equal(run["created_at"], "2026-07-01T00:00:00Z");

  // No destructive boundary crossed — FG-568 forward gate must never fire for this.
  assert.equal(db.pragma("user_version", { simple: true }), 0, "user_version must NOT be bumped");
});

test("FG-606 migration: the new ticket tables are usable after the migration", () => {
  getDb();
  upsertTicket({
    projectKey: "pk-migrated",
    ticketId: "FG-999",
    type: "story",
    status: "active",
    title: "written post-migration",
    body: "works",
    created: "2026-07-24",
    importedAt: "2026-07-24T00:00:00Z",
  });
  const got = getTicket("pk-migrated", "FG-999");
  assert.ok(got);
  assert.equal(got!.title, "written post-migration");
  assert.equal(ticketsForProject("pk-migrated").length, 1);
});

test("FG-606 migration: re-running applyMigrations on the already-migrated DB is a no-op", () => {
  const db = getDb();
  applyMigrations(db);
  applyMigrations(db);

  for (const table of FG606_TABLES) {
    assert.ok(tableExists(db, table), `${table} still present after idempotent re-open`);
  }
  for (const [table, n] of Object.entries(EXPECTED_ROWS)) {
    assert.equal(countRows(db, table), n, `${table}: no row churn on re-migration`);
  }
  // The post-migration ticket written above survives an idempotent re-open.
  assert.equal(ticketsForProject("pk-migrated").length, 1, "no data loss on re-open");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "still no user_version bump");
});
