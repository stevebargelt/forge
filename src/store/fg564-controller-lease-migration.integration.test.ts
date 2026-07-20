// FG-564 (Slice 5b) — the additive migration for the two new campaign-controller
// tables (campaign_controller_leases, campaign_item_launches), against a REAL
// pre-FG-564 database.
//
// Both tables are brand-new CREATE TABLE IF NOT EXISTS in SCHEMA_SQL (exec'd on every
// open), the same additive-only BD-15 contract as the FG-425/FG-562 tables — so an old
// binary that predates them is never broken, and a first open by the new binary brings
// an existing DB forward without an ALTER. This proves:
//
//   - a pre-FG-564 DB (with campaigns + campaign_items but NEITHER new table) opens
//     through the production getDb() path and the two new tables + their indices appear;
//   - existing campaign / campaign_items rows survive untouched (no data loss);
//   - the new tables are immediately writable through the accessors and enforce their
//     idempotency constraints (one lease per campaign; one linkage per item-attempt);
//   - re-opening is idempotent (no throw, no churn).
//
// The DB lives at DB_PATH under the per-process temp FORGE_HOME the harness installs —
// never ~/.forge/forge.db.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { getDb, applyMigrations, closeDb } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { acquireCampaignLease, recordItemLaunch, getItemLaunch } from "./campaign-controller.js";
import { listCampaignItems } from "./campaigns.js";
import { DB_PATH } from "../util/paths.js";

const CAMPAIGN_ID = "campaign-fg564-legacy";

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name) !== undefined
  );
}
function indexExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?`).get(name) !== undefined
  );
}
function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  // Build a valid DB, then DROP the two FG-564 tables to simulate the exact on-disk
  // state a pre-FG-564 binary would have written (everything else present, these two
  // absent). campaigns / campaign_items do not reference the FG-564 tables, so the drop
  // is clean.
  const legacy = new Database(DB_PATH);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(SCHEMA_SQL);
  legacy.exec(`DROP TABLE IF EXISTS campaign_item_launches`);
  legacy.exec(`DROP TABLE IF EXISTS campaign_controller_leases`);

  assert.equal(tableExists(legacy, "campaign_controller_leases"), false, "precondition: lease table must be absent");
  assert.equal(tableExists(legacy, "campaign_item_launches"), false, "precondition: launch-link table must be absent");

  legacy
    .prepare(
      `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(CAMPAIGN_ID, "running", "list", JSON.stringify({ ticketIds: ["FG-1"] }), "sequential", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z", "/tmp/proj");
  legacy
    .prepare(
      `INSERT INTO campaign_items
         (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, attempt_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("citem-1", CAMPAIGN_ID, 0, "FG-1", "run-legacy", "running", 1, "2026-06-01T00:00:01Z", "2026-06-01T00:00:01Z");

  legacy.close();
});

test("FG-564 migration: opening a pre-FG-564 DB adds both tables + indices and loses no data", () => {
  const db = getDb(); // production open path: SCHEMA_SQL + applyMigrations

  assert.ok(tableExists(db, "campaign_controller_leases"), "the lease table appears on open");
  assert.ok(tableExists(db, "campaign_item_launches"), "the launch-link table appears on open");
  assert.ok(indexExists(db, "idx_campaign_item_launches_source_launch"), "the source-launch unique index appears");
  assert.ok(indexExists(db, "idx_campaign_item_launches_campaign"), "the campaign index appears");

  // Existing rows survive untouched.
  assert.equal(countRows(db, "campaigns"), 1);
  assert.equal(countRows(db, "campaign_items"), 1);
  const items = listCampaignItems(CAMPAIGN_ID);
  assert.equal(items[0]?.ticketId, "FG-1");
  assert.equal(items[0]?.runId, "run-legacy");
  assert.equal(items[0]?.attemptGeneration, 1, "existing attempt_generation unchanged");
});

test("FG-564 migration: the new tables are immediately writable through the accessors", () => {
  getDb();
  const grant = acquireCampaignLease({ campaignId: CAMPAIGN_ID, owner: "campaign@cmp@A", ttlMs: 60_000 });
  assert.ok(grant.granted);
  recordItemLaunch({
    campaignId: CAMPAIGN_ID,
    itemId: "citem-1",
    attemptGeneration: 1,
    sourceLaunchId: "launch-legacy",
    controllerOwner: "campaign@cmp@A",
    controllerGeneration: 1,
  });
  assert.equal(getItemLaunch(CAMPAIGN_ID, "citem-1", 1)?.sourceLaunchId, "launch-legacy");
});

test("FG-564 migration: the source-launch unique index enforces one linkage per launch id", () => {
  const db = getDb();
  // A duplicate source_launch_id on a DIFFERENT item-attempt violates the unique index.
  assert.throws(() => {
    db.prepare(
      `INSERT INTO campaign_item_launches
         (campaign_id, item_id, attempt_generation, source_launch_id, controller_owner,
          controller_generation, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(CAMPAIGN_ID, "citem-1", 2, "launch-legacy", "campaign@cmp@A", 1, "launched", "t", "t");
  }, /UNIQUE|constraint/i);
});

test("FG-564 migration: re-running applyMigrations on the already-open DB is a no-op", () => {
  const db = getDb();
  applyMigrations(db);
  applyMigrations(db);
  assert.ok(tableExists(db, "campaign_controller_leases"));
  assert.ok(tableExists(db, "campaign_item_launches"));
  closeDb();
});
