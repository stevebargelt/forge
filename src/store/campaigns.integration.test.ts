import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, setDbForTest } from "./db.js";
import {
  createCampaign,
  addCampaignItem,
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  updateCampaignStatus,
  updateCampaignItem,
} from "./campaigns.js";
import type { CampaignItemOutcome, BlockerKind, ContinuePolicy } from "../types/index.js";

test("restart persistence: campaign and items survive close/reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-campaign-integ-"));
  const dbPath = join(dir, "test.db");

  let campaignId: string;
  let item1Id: string;
  let item2Id: string;

  try {
    // --- Write phase: open db1, create data, then close ---
    const db1 = new Database(dbPath);
    db1.pragma("foreign_keys = ON");
    db1.exec(SCHEMA_SQL);
    applyMigrations(db1);
    const savedPrev = setDbForTest(db1);

    const campaign = createCampaign({
      sourceKind: "epic",
      sourceInput: { epicId: "FG-100" },
      mode: "serial",
      metadata: { label: "integ-test" },
    });
    campaignId = campaign.id;
    updateCampaignStatus(campaignId, "running");

    const item1 = addCampaignItem({ campaignId, itemOrder: 0, ticketId: "FG-101" });
    item1Id = item1.id;
    updateCampaignItem(item1Id, {
      lifecycleStatus: "complete",
      outcome: "shipped",
      runId: "run-integ-abc",
    });

    const item2 = addCampaignItem({ campaignId, itemOrder: 1, ticketId: "FG-102" });
    item2Id = item2.id;

    db1.close(); // simulate process exit

    // --- Reopen phase: open db2 on the same file and verify rows survived ---
    const db2: DatabaseInstance = new Database(dbPath);
    db2.pragma("foreign_keys = ON");
    // CREATE TABLE IF NOT EXISTS is safe to re-run on an existing DB
    db2.exec(SCHEMA_SQL);
    applyMigrations(db2);
    setDbForTest(db2);

    const loadedCampaign = getCampaign(campaignId);
    assert.ok(loadedCampaign, "campaign must survive close/reopen");
    assert.equal(loadedCampaign.status, "running");
    assert.equal(loadedCampaign.sourceKind, "epic");
    assert.deepEqual(loadedCampaign.sourceInput, { epicId: "FG-100" });
    assert.deepEqual(loadedCampaign.metadata, { label: "integ-test" });
    assert.equal(loadedCampaign.mode, "serial");

    const loadedItem1 = getCampaignItem(item1Id);
    assert.ok(loadedItem1, "item1 must survive close/reopen");
    assert.equal(loadedItem1.ticketId, "FG-101");
    assert.equal(loadedItem1.lifecycleStatus, "complete");
    assert.equal(loadedItem1.outcome, "shipped");
    assert.equal(loadedItem1.runId, "run-integ-abc");

    const loadedItem2 = getCampaignItem(item2Id);
    assert.ok(loadedItem2, "item2 must survive close/reopen");
    assert.equal(loadedItem2.ticketId, "FG-102");
    assert.equal(loadedItem2.lifecycleStatus, "pending");

    const items = listCampaignItems(campaignId);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.ticketId, "FG-101");
    assert.equal(items[1]?.ticketId, "FG-102");

    db2.close();
    // Restore prior singleton if one existed before this test
    if (savedPrev !== null) setDbForTest(savedPrev);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart persistence: blockerKind, continuePolicy, and complex sourceInput survive close/reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-campaign-integ2-"));
  const dbPath = join(dir, "test2.db");

  let campaignId: string;
  let blockedItemId: string;
  let shippedItemId: string;
  let pendingItemId: string;

  try {
    // --- Write phase ---
    const db1 = new Database(dbPath);
    db1.pragma("foreign_keys = ON");
    db1.exec(SCHEMA_SQL);
    applyMigrations(db1);
    const savedPrev = setDbForTest(db1);

    const campaign = createCampaign({
      sourceKind: "list",
      sourceInput: { tickets: ["FG-001", "FG-002", "FG-003"], dryRun: false },
      mode: "serial",
    });
    campaignId = campaign.id;
    updateCampaignStatus(campaignId, "running");

    // Item 1: blocked with all blocker fields set (non-contiguous order: 1)
    const item1 = addCampaignItem({ campaignId, itemOrder: 1, ticketId: "FG-001" });
    blockedItemId = item1.id;
    updateCampaignItem(blockedItemId, {
      lifecycleStatus: "failed",
      outcome: "blocked" as CampaignItemOutcome,
      blockerKind: "merge_conflict" as BlockerKind,
      continuePolicy: "hold_dependents" as ContinuePolicy,
      reason: "Merge conflict detected in main branch",
      requestedHumanAction: "Resolve merge conflict then retry",
    });

    // Item 2: shipped (non-contiguous order: 10)
    const item2 = addCampaignItem({ campaignId, itemOrder: 10, ticketId: "FG-002" });
    shippedItemId = item2.id;
    updateCampaignItem(shippedItemId, {
      lifecycleStatus: "complete",
      outcome: "shipped" as CampaignItemOutcome,
      continuePolicy: "continue_allowed" as ContinuePolicy,
      runId: "run-integ-shipped",
      branch: "forge/run-shipped/citem-002",
      prUrl: "https://github.com/example/repo/pull/99",
    });

    // Item 3: still pending (non-contiguous order: 20)
    const item3 = addCampaignItem({ campaignId, itemOrder: 20, ticketId: "FG-003" });
    pendingItemId = item3.id;

    db1.close();

    // --- Reopen phase ---
    const db2: DatabaseInstance = new Database(dbPath);
    db2.pragma("foreign_keys = ON");
    db2.exec(SCHEMA_SQL);
    applyMigrations(db2);
    setDbForTest(db2);

    // Campaign + complex sourceInput round-trip
    const loadedCampaign = getCampaign(campaignId);
    assert.ok(loadedCampaign, "campaign must survive close/reopen");
    assert.equal(loadedCampaign.status, "running");
    assert.equal(loadedCampaign.sourceKind, "list");
    assert.deepEqual(loadedCampaign.sourceInput, { tickets: ["FG-001", "FG-002", "FG-003"], dryRun: false });

    // Blocked item: blockerKind + continuePolicy + reason + requestedHumanAction survive
    const loadedBlocked = getCampaignItem(blockedItemId);
    assert.ok(loadedBlocked, "blocked item must survive");
    assert.equal(loadedBlocked.ticketId, "FG-001");
    assert.equal(loadedBlocked.lifecycleStatus, "failed");
    assert.equal(loadedBlocked.outcome, "blocked");
    assert.equal(loadedBlocked.blockerKind, "merge_conflict");
    assert.equal(loadedBlocked.continuePolicy, "hold_dependents");
    assert.equal(loadedBlocked.reason, "Merge conflict detected in main branch");
    assert.equal(loadedBlocked.requestedHumanAction, "Resolve merge conflict then retry");

    // Shipped item: continuePolicy + runId + prUrl survive
    const loadedShipped = getCampaignItem(shippedItemId);
    assert.ok(loadedShipped, "shipped item must survive");
    assert.equal(loadedShipped.outcome, "shipped");
    assert.equal(loadedShipped.continuePolicy, "continue_allowed");
    assert.equal(loadedShipped.runId, "run-integ-shipped");
    assert.equal(loadedShipped.branch, "forge/run-shipped/citem-002");
    assert.equal(loadedShipped.prUrl, "https://github.com/example/repo/pull/99");

    // Pending item
    const loadedPending = getCampaignItem(pendingItemId);
    assert.ok(loadedPending, "pending item must survive");
    assert.equal(loadedPending.lifecycleStatus, "pending");
    assert.equal(loadedPending.outcome, undefined);
    assert.equal(loadedPending.blockerKind, undefined);

    // Ordering is stable across non-contiguous item_order values (1, 10, 20)
    const items = listCampaignItems(campaignId);
    assert.equal(items.length, 3);
    assert.equal(items[0]?.ticketId, "FG-001");
    assert.equal(items[0]?.itemOrder, 1);
    assert.equal(items[1]?.ticketId, "FG-002");
    assert.equal(items[1]?.itemOrder, 10);
    assert.equal(items[2]?.ticketId, "FG-003");
    assert.equal(items[2]?.itemOrder, 20);

    db2.close();
    if (savedPrev !== null) setDbForTest(savedPrev);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
