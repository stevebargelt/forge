// FG-596 — the campaign_items.attempt_generation migration, against a REAL
// pre-change database.
//
// Mirrors the FG-523 migration test: build a database from the PRE-FG-596
// campaign_items schema on disk (no attempt_generation column), then open it
// through the production getDb() path (SCHEMA_SQL + applyMigrations, exactly what a
// real upgraded install runs on first open) and assert:
//
//   - the additive ALTER lands: attempt_generation appears on a table that lacked it
//   - no data loss: row counts unchanged, field-level spot-check intact
//   - legacy rows read back attemptGeneration === 0 (safe default, NOT back-filled to
//     anything else) — the "never allocated / legacy" marker the drive-item path
//     fails closed on
//   - the migration is idempotent (re-running applyMigrations does not throw, add a
//     duplicate column, or churn rows)
//   - new rows written after the migration coexist with legacy rows
//
// The DB lives at DB_PATH under the per-process temp FORGE_HOME the harness installs
// (src/test-setup.ts) — never ~/.forge/forge.db.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { getDb, applyMigrations } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { addCampaignItem, listCampaignItems } from "./campaigns.js";
import { DB_PATH } from "../util/paths.js";

// The campaign_items table EXACTLY as it stood before FG-596 — no
// attempt_generation. Created first, so the subsequent SCHEMA_SQL exec (all CREATE
// TABLE IF NOT EXISTS) leaves it alone and creates only the other tables. That is
// precisely the state of a database written by the pre-FG-596 binary.
const LEGACY_CAMPAIGN_ITEMS_DDL = `
CREATE TABLE campaign_items (
  id                     TEXT PRIMARY KEY,
  campaign_id            TEXT NOT NULL REFERENCES campaigns(id),
  item_order             INTEGER NOT NULL,
  ticket_id              TEXT NOT NULL,
  run_id                 TEXT,
  branch                 TEXT,
  worktree_path          TEXT,
  pr_url                 TEXT,
  lifecycle_status       TEXT NOT NULL,
  outcome                TEXT,
  blocker_kind           TEXT,
  continue_policy        TEXT,
  reason                 TEXT,
  requested_human_action TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_items_campaign ON campaign_items(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_items_status ON campaign_items(lifecycle_status);
`;

const CAMPAIGN_ID = "campaign-fg596-legacy";
const EXPECTED_ROWS = { campaigns: 1, campaign_items: 2 };

function columnNames(db: Database.Database, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(cols.map((c) => c.name));
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  const legacy = new Database(DB_PATH);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(LEGACY_CAMPAIGN_ITEMS_DDL);
  legacy.exec(SCHEMA_SQL);

  assert.equal(
    columnNames(legacy, "campaign_items").has("attempt_generation"),
    false,
    "precondition: the legacy campaign_items table must NOT have the column, or this test proves nothing",
  );

  legacy
    .prepare(
      `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(CAMPAIGN_ID, "paused", "list", JSON.stringify({ ticketIds: ["FG-1", "FG-2"] }), "sequential", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z", "/tmp/proj");

  const insertItem = legacy.prepare(
    `INSERT INTO campaign_items
       (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, outcome, blocker_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A legacy DISPATCHED item — it carries a runId but (by construction) no generation.
  insertItem.run("citem-legacy-1", CAMPAIGN_ID, 0, "FG-1", "run-legacy-fg1", "failed", "blocked", "auth", "2026-06-01T00:00:01Z", "2026-06-01T00:00:02Z");
  // A legacy pending item.
  insertItem.run("citem-legacy-2", CAMPAIGN_ID, 1, "FG-2", null, "pending", null, null, "2026-06-01T00:00:03Z", "2026-06-01T00:00:03Z");

  legacy.close();
});

test("FG-596 migration: opening a pre-change DB through getDb() adds attempt_generation and loses no data", () => {
  const db = getDb(); // the production open path: SCHEMA_SQL + applyMigrations

  assert.ok(columnNames(db, "campaign_items").has("attempt_generation"), "applyMigrations must ALTER the existing table");

  for (const [table, n] of Object.entries(EXPECTED_ROWS)) {
    assert.equal(countRows(db, table), n, `${table}: the migration must not drop or duplicate rows`);
  }

  // Field-level spot-check: the ALTER must not have rewritten the surviving columns.
  const row = db.prepare(`SELECT * FROM campaign_items WHERE id = 'citem-legacy-1'`).get() as Record<string, unknown>;
  assert.equal(row["ticket_id"], "FG-1");
  assert.equal(row["run_id"], "run-legacy-fg1");
  assert.equal(row["lifecycle_status"], "failed");
  assert.equal(row["outcome"], "blocked");
  assert.equal(row["blocker_kind"], "auth");
  assert.equal(row["created_at"], "2026-06-01T00:00:01Z");
  assert.equal(row["attempt_generation"], 0, "the new column has DEFAULT 0 — old rows are not back-filled to anything else");
});

test("FG-596 migration: migrated legacy rows read back attemptGeneration === 0 through the accessor", () => {
  getDb();
  const items = listCampaignItems(CAMPAIGN_ID);
  assert.equal(items.length, 2);
  for (const it of items) {
    assert.equal(it.attemptGeneration, 0, `${it.ticketId}: a legacy row is the never-allocated (0) shape`);
  }
});

test("FG-596 migration: re-running applyMigrations on the already-migrated DB is a byte-for-byte no-op", () => {
  const db = getDb();
  applyMigrations(db);
  applyMigrations(db);

  const cols = [...columnNames(db, "campaign_items")].filter((c) => c === "attempt_generation");
  assert.deepEqual(cols, ["attempt_generation"], "the guard makes the ALTER idempotent — no duplicate column, no throw");
  assert.equal(countRows(db, "campaign_items"), EXPECTED_ROWS.campaign_items, "and no row churn");
  const row = db.prepare(`SELECT attempt_generation FROM campaign_items WHERE id = 'citem-legacy-1'`).get() as { attempt_generation: number };
  assert.equal(row.attempt_generation, 0, "the legacy value survives the idempotent re-run unchanged");
});

test("FG-596 migration: rows written AFTER the migration coexist with legacy rows and default to 0", () => {
  getDb();
  const fresh = addCampaignItem({ campaignId: CAMPAIGN_ID, itemOrder: 2, ticketId: "FG-3" });
  assert.equal(fresh.attemptGeneration, 0, "a freshly-added item is the never-allocated (0) shape too");

  const items = listCampaignItems(CAMPAIGN_ID);
  assert.equal(items.length, 3);
  assert.equal(items.find((i) => i.ticketId === "FG-3")!.attemptGeneration, 0);
  assert.equal(items.find((i) => i.ticketId === "FG-1")!.attemptGeneration, 0, "legacy rows unaffected by new inserts");
});
