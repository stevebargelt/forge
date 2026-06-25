import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../store/schema.js";
import { applyMigrations, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign, computePlanHash } from "./planner.js";
import type { CanonicalPlanContent } from "./planner.js";
import { getCampaign, listCampaignItems } from "../store/campaigns.js";

test("integration: plan survives DB close/reopen", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "fg391-integ-"));
  const dbPath = join(tmpBase, "forge.db");
  const projectDir = join(tmpBase, "project");

  let savedPrev: DatabaseInstance | null = null;

  try {
    writeTicket(projectDir, {
      id: "FG-100",
      type: "epic",
      status: "active",
      title: "Integration Epic",
      related: ["FG-101", "FG-102"],
      body: "Epic description",
    });
    writeTicket(projectDir, {
      id: "FG-101",
      type: "story",
      status: "active",
      title: "First Story",
      epic: "FG-100",
      created: "2024-01-01",
      body: "Story one",
    });
    writeTicket(projectDir, {
      id: "FG-102",
      type: "story",
      status: "active",
      title: "Second Story",
      epic: "FG-100",
      created: "2024-01-02",
      body: "Story two",
    });
    writeTicket(projectDir, {
      id: "FG-103",
      type: "story",
      status: "active",
      title: "Third Story",
      epic: "FG-100",
      created: "2024-01-03",
      body: "Story three (not in related[])",
    });

    let campaignId: string;
    let planHash: string;

    // Write phase
    {
      const db1 = new Database(dbPath);
      db1.pragma("foreign_keys = ON");
      db1.exec(SCHEMA_SQL);
      applyMigrations(db1);
      savedPrev = setDbForTest(db1);

      const result = planCampaign(
        { kind: "epic", epicId: "FG-100" },
        { projectDir, mode: "sequential" }
      );

      campaignId = result.campaign.id;
      planHash = result.planHash;

      // related[] is ["FG-101", "FG-102"]; FG-103 is not in related[] so appended by date
      assert.deepEqual(
        result.items.map((i) => i.ticketId),
        ["FG-101", "FG-102", "FG-103"]
      );
      assert.equal(result.campaign.status, "planned");
      assert.equal(result.campaign.mode, "sequential");
      assert.ok(result.planHash.length === 64, "sha256 hex should be 64 chars");

      db1.close();
    }

    // Reopen phase — verify all data survived restart
    {
      const db2 = new Database(dbPath);
      db2.pragma("foreign_keys = ON");
      db2.exec(SCHEMA_SQL);
      applyMigrations(db2);
      setDbForTest(db2);

      const loaded = getCampaign(campaignId);
      assert.ok(loaded, "campaign must survive close/reopen");
      assert.equal(loaded.status, "planned");
      assert.equal(loaded.sourceKind, "epic");
      assert.equal(loaded.mode, "sequential");
      assert.equal(loaded.planHash, planHash, "plan_hash must survive close/reopen");
      assert.deepEqual(loaded.sourceInput, { kind: "epic", epicId: "FG-100" });
      assert.ok(loaded.metadata?.planContent, "metadata.planContent must survive");

      const items = listCampaignItems(campaignId);
      assert.equal(items.length, 3);
      assert.equal(items[0]?.ticketId, "FG-101");
      assert.equal(items[0]?.itemOrder, 0);
      assert.equal(items[0]?.lifecycleStatus, "pending");
      assert.equal(items[1]?.ticketId, "FG-102");
      assert.equal(items[1]?.itemOrder, 1);
      assert.equal(items[1]?.lifecycleStatus, "pending");
      assert.equal(items[2]?.ticketId, "FG-103");
      assert.equal(items[2]?.itemOrder, 2);
      assert.equal(items[2]?.lifecycleStatus, "pending");

      db2.close();
      if (savedPrev !== null) setDbForTest(savedPrev);
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("integration: explicit-list plan persists and plan_hash is deterministic across restarts", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "fg391-integ2-"));
  const dbPath = join(tmpBase, "forge.db");
  const projectDir = join(tmpBase, "project");

  let savedPrev: DatabaseInstance | null = null;

  try {
    writeTicket(projectDir, {
      id: "FG-201",
      type: "story",
      status: "active",
      title: "Alpha",
      body: "",
    });
    writeTicket(projectDir, {
      id: "FG-202",
      type: "story",
      status: "active",
      title: "Beta",
      body: "",
    });

    let campaignId1: string;
    let campaignId2: string;
    let planHash1: string;
    let planHash2: string;

    // Plan once
    {
      const db1 = new Database(dbPath);
      db1.pragma("foreign_keys = ON");
      db1.exec(SCHEMA_SQL);
      applyMigrations(db1);
      savedPrev = setDbForTest(db1);

      const r1 = planCampaign(
        { kind: "list", ticketIds: ["FG-201", "FG-202"] },
        { projectDir, mode: "pilot" }
      );
      campaignId1 = r1.campaign.id;
      planHash1 = r1.planHash;

      // Plan again with same input — must produce same hash
      const r2 = planCampaign(
        { kind: "list", ticketIds: ["FG-201", "FG-202"] },
        { projectDir, mode: "pilot" }
      );
      campaignId2 = r2.campaign.id;
      planHash2 = r2.planHash;

      assert.equal(planHash1, planHash2, "equivalent plans must hash identically");
      assert.notEqual(campaignId1, campaignId2, "but are distinct campaigns");

      db1.close();
    }

    // Reopen and verify both campaigns with same hash survived
    {
      const db2 = new Database(dbPath);
      db2.pragma("foreign_keys = ON");
      db2.exec(SCHEMA_SQL);
      applyMigrations(db2);
      setDbForTest(db2);

      const loaded1 = getCampaign(campaignId1);
      const loaded2 = getCampaign(campaignId2);

      assert.ok(loaded1, "campaign 1 must survive");
      assert.ok(loaded2, "campaign 2 must survive");
      assert.equal(loaded1.planHash, planHash1);
      assert.equal(loaded2.planHash, planHash2);
      assert.equal(loaded1.planHash, loaded2.planHash, "hashes must match after restart");

      const items1 = listCampaignItems(campaignId1);
      const items2 = listCampaignItems(campaignId2);
      assert.equal(items1.length, 2);
      assert.equal(items2.length, 2);
      assert.equal(items1[0]?.lifecycleStatus, "pending");
      assert.equal(items2[0]?.lifecycleStatus, "pending");

      db2.close();
      if (savedPrev !== null) setDbForTest(savedPrev);
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("integration: recomputed hash from persisted canonical content matches stored plan_hash", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "fg391-integ3-"));
  const dbPath = join(tmpBase, "forge.db");
  const projectDir = join(tmpBase, "project");

  let savedPrev: DatabaseInstance | null = null;

  try {
    writeTicket(projectDir, {
      id: "FG-301",
      type: "story",
      status: "active",
      title: "Persist Hash Story One",
      body: "",
    });
    writeTicket(projectDir, {
      id: "FG-302",
      type: "story",
      status: "active",
      title: "Persist Hash Story Two",
      body: "",
    });

    let campaignId: string;
    let originalHash: string;

    // Write phase
    {
      const db1 = new Database(dbPath);
      db1.pragma("foreign_keys = ON");
      db1.exec(SCHEMA_SQL);
      applyMigrations(db1);
      savedPrev = setDbForTest(db1);

      const result = planCampaign(
        { kind: "list", ticketIds: ["FG-301", "FG-302"] },
        { projectDir, mode: "dry_run" }
      );
      campaignId = result.campaign.id;
      originalHash = result.planHash;

      db1.close();
    }

    // Reopen and recompute hash from the persisted canonical content in metadata
    {
      const db2 = new Database(dbPath);
      db2.pragma("foreign_keys = ON");
      db2.exec(SCHEMA_SQL);
      applyMigrations(db2);
      setDbForTest(db2);

      const loaded = getCampaign(campaignId);
      assert.ok(loaded, "campaign must survive close/reopen");
      assert.ok(loaded.metadata?.planContent, "metadata.planContent must survive");

      const persistedContent = loaded.metadata.planContent as CanonicalPlanContent;
      const recomputedHash = computePlanHash(persistedContent);

      assert.equal(
        recomputedHash,
        loaded.planHash,
        "hash recomputed from persisted metadata.planContent must match stored plan_hash column"
      );
      assert.equal(
        recomputedHash,
        originalHash,
        "recomputed hash must also equal the original in-memory plan hash"
      );

      db2.close();
      if (savedPrev !== null) setDbForTest(savedPrev);
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
