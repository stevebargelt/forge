import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { writeTicket } from "../../backlog/structured.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;
let projectDir: string;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-campaign-cli-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-campaign-cli-proj-"));

  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    body: "",
    created: "2024-01-01",
  });
  writeTicket(projectDir, {
    id: "FG-102",
    type: "story",
    status: "active",
    title: "Story Two",
    body: "",
    created: "2024-01-02",
  });
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    body: "",
    created: "2024-01-03",
  });
  writeTicket(projectDir, {
    id: "FG-100",
    type: "epic",
    status: "active",
    title: "Test Epic",
    related: ["FG-103"],
    body: "",
  });
});

afterEach(() => {
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

// ── persistence ───────────────────────────────────────────────────────────────

test("integ campaign plan --tickets: persists campaign and items rows", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);

  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout) as {
    campaignId: string;
    orderedItems: { order: number; ticketId: string; lifecycleStatus: string }[];
    canonicalContent: Record<string, unknown>;
    planHash: string;
  };

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });

  const campaigns = db.prepare("SELECT * FROM campaigns WHERE id = ?").all(output.campaignId);
  assert.equal(campaigns.length, 1, "campaign row must be persisted");

  const items = db.prepare("SELECT * FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(output.campaignId);
  assert.equal(items.length, 2, "two campaign_item rows must be persisted");

  db.close();
});

// ── JSON shape ────────────────────────────────────────────────────────────────

test("integ campaign plan --json: output has campaignId, orderedItems, canonicalContent, planHash", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout) as Record<string, unknown>;

  assert.ok(typeof output["campaignId"] === "string" && output["campaignId"].length > 0, "campaignId must be a non-empty string");
  assert.ok(Array.isArray(output["orderedItems"]), "orderedItems must be an array");

  const items = output["orderedItems"] as { order: number; ticketId: string; lifecycleStatus: string }[];
  assert.equal(items.length, 2);
  assert.equal(items[0]?.ticketId, "FG-101");
  assert.equal(items[0]?.order, 0);
  assert.equal(items[0]?.lifecycleStatus, "pending");
  assert.equal(items[1]?.ticketId, "FG-102");
  assert.equal(items[1]?.order, 1);

  assert.ok(output["canonicalContent"] !== null && typeof output["canonicalContent"] === "object", "canonicalContent must be an object");
  assert.ok(typeof output["planHash"] === "string" && output["planHash"].length === 64, "planHash must be a 64-char hex string");

  const content = output["canonicalContent"] as Record<string, unknown>;
  assert.ok(content["itemRecommendations"] !== null && typeof content["itemRecommendations"] === "object", "canonicalContent must include itemRecommendations");
});

// ── no execution ──────────────────────────────────────────────────────────────

test("integ campaign plan: creates zero rows in runs and tasks", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout) as { campaignId: string };

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });

  const runs = db.prepare("SELECT COUNT(*) as count FROM runs").get() as { count: number };
  assert.equal(runs.count, 0, "planning must not create any run rows");

  const tasks = db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
  assert.equal(tasks.count, 0, "planning must not create any task rows");

  db.close();

  // Also check the campaignId is valid to make sure the campaign itself was created
  assert.ok(output.campaignId.length > 0);
});

// ── duplicate rejection ───────────────────────────────────────────────────────

test("integ campaign plan: duplicate --tickets ids exit non-zero with error message", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102,FG-101",
    "--project", projectDir,
  ]);

  assert.notEqual(result.status, 0, "should exit non-zero on duplicate ticket ids");
  assert.ok(
    result.stderr.toLowerCase().includes("duplicate") || result.stdout.toLowerCase().includes("duplicate"),
    `expected 'duplicate' in output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign plan: duplicate ids in --add exit non-zero with error message", () => {
  const result = runForge([
    "campaign", "plan",
    "--epic", "FG-100",
    "--add", "FG-101,FG-101",
    "--project", projectDir,
  ]);

  assert.notEqual(result.status, 0, "should exit non-zero on duplicate --add ids");
  assert.ok(
    result.stderr.toLowerCase().includes("duplicate") || result.stdout.toLowerCase().includes("duplicate"),
    `expected 'duplicate' in output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

// ── usage errors ──────────────────────────────────────────────────────────────

test("integ campaign plan: --tickets and --epic together is a usage error", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--epic", "FG-100",
    "--project", projectDir,
  ]);

  assert.notEqual(result.status, 0, "should exit non-zero when both --tickets and --epic provided");
});

test("integ campaign plan: --add without --epic is a usage error", () => {
  const result = runForge([
    "campaign", "plan",
    "--add", "FG-101",
    "--project", projectDir,
  ]);

  assert.notEqual(result.status, 0, "should exit non-zero when --add without --epic");
});

test("integ campaign plan: no --tickets and no --epic is a usage error", () => {
  const result = runForge([
    "campaign", "plan",
    "--project", projectDir,
  ]);

  assert.notEqual(result.status, 0, "should exit non-zero when neither --tickets nor --epic provided");
});

// ── epic input ────────────────────────────────────────────────────────────────

test("integ campaign plan --epic: plans all active epic children and persists them", () => {
  const result = runForge([
    "campaign", "plan",
    "--epic", "FG-100",
    "--project", projectDir,
    "--json",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout) as {
    campaignId: string;
    orderedItems: { order: number; ticketId: string }[];
    planHash: string;
  };

  assert.ok(output.campaignId.length > 0);
  assert.equal(output.orderedItems.length, 1, "epic FG-100 has one active child (FG-103)");
  assert.equal(output.orderedItems[0]?.ticketId, "FG-103");
  assert.ok(output.planHash.length === 64);
});

// ── usage-error message clarity ────────────────────────────────────────────

test("integ campaign plan: --tickets and --epic shows mutual-exclusion message", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--epic", "FG-100",
    "--project", projectDir,
  ]);
  assert.notEqual(result.status, 0);
  const combined = (result.stderr + result.stdout).toLowerCase();
  assert.ok(
    combined.includes("mutually exclusive") || combined.includes("exclusive"),
    `expected mutual-exclusion wording\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign plan: --add without --epic shows clear message", () => {
  const result = runForge([
    "campaign", "plan",
    "--add", "FG-101",
    "--project", projectDir,
  ]);
  assert.notEqual(result.status, 0);
  const combined = (result.stderr + result.stdout).toLowerCase();
  assert.ok(
    combined.includes("require") || combined.includes("epic"),
    `expected 'require' or 'epic' in output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign plan: --exclude without --epic is a usage error with clear message", () => {
  const result = runForge([
    "campaign", "plan",
    "--exclude", "FG-103",
    "--project", projectDir,
  ]);
  assert.notEqual(result.status, 0, "should exit non-zero when --exclude without --epic");
  const combined = (result.stderr + result.stdout).toLowerCase();
  assert.ok(
    combined.includes("require") || combined.includes("epic"),
    `expected 'require' or 'epic' in output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign plan: no --tickets and no --epic shows clear message", () => {
  const result = runForge([
    "campaign", "plan",
    "--project", projectDir,
  ]);
  assert.notEqual(result.status, 0);
  const combined = (result.stderr + result.stdout).toLowerCase();
  assert.ok(
    combined.includes("tickets") || combined.includes("epic") || combined.includes("must provide"),
    `expected usage guidance in output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign plan: invalid --mode exits non-zero with clear message", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "badmode",
    "--project", projectDir,
  ]);
  assert.notEqual(result.status, 0, "should exit non-zero for invalid --mode");
  const combined = (result.stderr + result.stdout).toLowerCase();
  assert.ok(
    combined.includes("mode") || combined.includes("invalid"),
    `expected 'mode' or 'invalid' in output\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

// ── campaign lifecycle status from CLI path ────────────────────────────────

test("integ campaign plan: campaign status is planned and all items are pending", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    campaignId: string;
    orderedItems: { order: number; ticketId: string; lifecycleStatus: string }[];
  };

  for (const item of output.orderedItems) {
    assert.equal(item.lifecycleStatus, "pending", `item ${item.ticketId} must start pending`);
  }

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT status FROM campaigns WHERE id = ?").get(output.campaignId) as { status: string };
  assert.equal(row.status, "planned", "campaign status must be planned");
  db.close();
});

// ── duplicate rejection: no partial persistence ────────────────────────────

test("integ campaign plan: duplicate --tickets rejection leaves DB clean", () => {
  // First create a valid campaign so the DB is initialized
  const good = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(good.status, 0);

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const countBefore = (dbBefore.prepare("SELECT COUNT(*) as count FROM campaigns").get() as { count: number }).count;
  dbBefore.close();

  // Now attempt a plan with duplicate ticket ids — must fail and not add a campaign
  const bad = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102,FG-101",
    "--project", projectDir,
  ]);
  assert.notEqual(bad.status, 0, "duplicate tickets must exit non-zero");

  const dbAfter = new Database(dbPath, { readonly: true });
  const countAfter = (dbAfter.prepare("SELECT COUNT(*) as count FROM campaigns").get() as { count: number }).count;
  dbAfter.close();

  assert.equal(countAfter, countBefore, "rejected plan must not add any campaign row");
});

test("integ campaign plan: --add re-adding non-excluded epic child exits non-zero, nothing persisted", () => {
  // FG-103 is already an active child of epic FG-100; --add FG-103 must be rejected
  const result = runForge([
    "campaign", "plan",
    "--epic", "FG-100",
    "--add", "FG-103",
    "--project", projectDir,
  ]);
  assert.notEqual(result.status, 0, "should exit non-zero when --add re-adds an epic child");
  const combined = (result.stderr + result.stdout).toLowerCase();
  assert.ok(
    combined.includes("re-adds") || combined.includes("already") || combined.includes("duplicate"),
    `expected duplicate-rejection wording\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );

  // DB must be empty or non-existent (no partial campaign persisted)
  const dbPath = join(forgeHome, "forge.db");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    const campaigns = db.prepare("SELECT COUNT(*) as count FROM campaigns").get() as { count: number };
    assert.equal(campaigns.count, 0, "no campaign must be persisted on rejected plan");
    db.close();
  }
});

// ── --json output completeness ─────────────────────────────────────────────

test("integ campaign plan --json: itemRecommendations present for every resolved item", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    orderedItems: { ticketId: string }[];
    canonicalContent: { itemRecommendations: Record<string, string> };
  };

  for (const item of output.orderedItems) {
    assert.equal(
      output.canonicalContent.itemRecommendations[item.ticketId],
      "sequential",
      `itemRecommendations must have 'sequential' for ${item.ticketId}`
    );
  }
});

// ── FG-392: additive migration ─────────────────────────────────────────────

test("integ migration: pre-FG-392 campaigns table gets new columns on open; existing rows readable with null new fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg392-migration-"));
  const dbPath = join(dir, "pre392.db");

  try {
    // Simulate a pre-FG-392 DB: create schema without the new columns
    const db1 = new Database(dbPath);
    db1.pragma("foreign_keys = ON");
    // Create old schema manually (without approved_* and project_dir columns)
    db1.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id         TEXT PRIMARY KEY,
        status     TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_input TEXT NOT NULL,
        mode       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata   TEXT,
        plan_hash  TEXT
      );
      CREATE TABLE IF NOT EXISTS campaign_items (
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
    `);
    // Also create stub tables needed by schema.ts FK references
    db1.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, metadata TEXT, project_dir TEXT);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, phase TEXT NOT NULL, agent_role TEXT NOT NULL, status TEXT NOT NULL, task_package TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, red_task_id TEXT NOT NULL, red_role TEXT NOT NULL, verdict TEXT NOT NULL, confidence REAL NOT NULL, authority TEXT NOT NULL, findings TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gates (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT, decided_at TEXT NOT NULL, decided_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, model TEXT NOT NULL, alias TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    db1.prepare(`INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, plan_hash)
                 VALUES ('campaign-legacy', 'planned', 'list', '{"kind":"list","ticketIds":["FG-101"]}', 'dry_run', ?, ?, 'hash-abc')`)
      .run(now, now);
    db1.close();

    // Now open with FG-392 applyMigrations — should add new columns
    const db2 = new Database(dbPath);
    db2.pragma("foreign_keys = ON");
    db2.exec(SCHEMA_SQL);
    applyMigrations(db2);

    // Check new columns exist
    const cols = db2.prepare("PRAGMA table_info(campaigns)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has("approved_by"), "approved_by column must exist after migration");
    assert.ok(colNames.has("approved_at"), "approved_at column must exist after migration");
    assert.ok(colNames.has("approval_rationale"), "approval_rationale column must exist after migration");
    assert.ok(colNames.has("approved_plan_hash"), "approved_plan_hash column must exist after migration");
    assert.ok(colNames.has("project_dir"), "project_dir column must exist after migration");

    // Existing row is readable with null new fields
    const row = db2.prepare("SELECT * FROM campaigns WHERE id = 'campaign-legacy'").get() as {
      id: string; status: string; plan_hash: string;
      approved_by: string | null; approved_plan_hash: string | null; project_dir: string | null;
    };
    assert.ok(row, "legacy campaign row must be readable");
    assert.equal(row.id, "campaign-legacy");
    assert.equal(row.status, "planned");
    assert.equal(row.plan_hash, "hash-abc");
    assert.equal(row.approved_by, null, "approved_by must be null for legacy row");
    assert.equal(row.approved_plan_hash, null, "approved_plan_hash must be null for legacy row");
    assert.equal(row.project_dir, null, "project_dir must be null for legacy row");

    // Round-trip the approved fields: write approval and close/reopen
    const now2 = new Date().toISOString();
    db2.prepare("UPDATE campaigns SET approved_by = ?, approved_at = ?, approval_rationale = ?, approved_plan_hash = ? WHERE id = ?")
      .run("tester", now2, "test rationale", "hash-abc", "campaign-legacy");
    db2.close();

    const db3 = new Database(dbPath);
    db3.pragma("foreign_keys = ON");
    db3.exec(SCHEMA_SQL);
    applyMigrations(db3);
    const row3 = db3.prepare("SELECT approved_by, approved_at, approval_rationale, approved_plan_hash FROM campaigns WHERE id = ?").get("campaign-legacy") as {
      approved_by: string; approved_at: string; approval_rationale: string; approved_plan_hash: string;
    };
    assert.equal(row3.approved_by, "tester");
    assert.equal(row3.approval_rationale, "test rationale");
    assert.equal(row3.approved_plan_hash, "hash-abc");
    db3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FG-392: CLI approve ────────────────────────────────────────────────────

test("integ campaign approve: exits non-zero with message when campaign not found", () => {
  const result = runForge([
    "campaign", "approve", "campaign-doesnotexist",
    "--rationale", "test",
  ]);
  assert.notEqual(result.status, 0);
  assert.ok(
    (result.stderr + result.stdout).includes("not found"),
    `expected 'not found'\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign approve: exits non-zero when campaign already running", () => {
  // Plan a campaign
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Manually set it to running in the DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const result = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "approve after running",
  ]);
  assert.notEqual(result.status, 0);
  const combined = (result.stderr + result.stdout).toLowerCase();
  assert.ok(
    combined.includes("planned") || combined.includes("running") || combined.includes("not in planned"),
    `expected state-rejection message\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign approve --json: records approval and outputs JSON", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string; planHash: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
    "--by", "testoperator",
    "--json",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const output = JSON.parse(approveResult.stdout) as {
    campaignId: string;
    approvedBy: string | null;
    approvedAt: string | null;
    approvedPlanHash: string | null;
  };
  assert.equal(output.campaignId, planOutput.campaignId);
  assert.equal(output.approvedBy, "testoperator");
  assert.ok(output.approvedAt, "approvedAt must be set");
  assert.equal(output.approvedPlanHash, planOutput.planHash, "approvedPlanHash must equal the plan hash");
});

// ── FG-392: CLI start refusals ─────────────────────────────────────────────

// ── FG-392: project_dir CLI persistence ───────────────────────────────────────

test("integ campaign plan: project_dir column persisted as absolute path in campaigns row", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { campaignId: string };

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT project_dir FROM campaigns WHERE id = ?").get(output.campaignId) as {
    project_dir: string | null;
  };
  db.close();

  assert.ok(row.project_dir, "project_dir must be persisted in campaigns table");
  assert.ok(row.project_dir!.startsWith("/"), "stored project_dir must be an absolute path");
  assert.ok(
    row.project_dir!.includes(projectDir.replace(/\\/g, "/")),
    `stored project_dir must include the planned directory\ngot: ${row.project_dir}`
  );
});

test("integ campaign start: exits non-zero with message for unapproved campaign", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const startResult = runForge([
    "campaign", "start", planOutput.campaignId,
  ]);
  assert.notEqual(startResult.status, 0, "start of unapproved campaign must exit non-zero");
  const combined = (startResult.stderr + startResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("not_approved") || combined.includes("approved") || combined.includes("approve"),
    `expected approval-related message\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

// ── FG-392: --project mismatch guard ─────────────────────────────────────────

test("integ campaign start --project: exits non-zero when --project differs from stored projectDir", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const otherDir = mkdtempSync(join(tmpdir(), "forge-other-proj-"));
  try {
    const startResult = runForge([
      "campaign", "start", planOutput.campaignId,
      "--project", otherDir,
    ]);
    assert.notEqual(startResult.status, 0, "start with mismatched --project must exit non-zero");
    const combined = (startResult.stderr + startResult.stdout).toLowerCase();
    assert.ok(
      combined.includes("does not match") || combined.includes("mismatch") || combined.includes("stored"),
      `expected mismatch error\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
    );
  } finally {
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("integ campaign start --project: succeeds when --project matches stored projectDir exactly", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Approve the campaign
  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // start --project <same dir as stored> should not be rejected by the guard.
  // It will fail at not_approved or stale_plan — but NOT at the --project mismatch check.
  // We can't do a full start without a dispatch, so just verify the guard passes.
  // We look for the NOT "does not match" error in the output.
  const startResult = runForge([
    "campaign", "start", planOutput.campaignId,
    "--project", projectDir,
    "--json",
  ]);
  const combined = (startResult.stderr + startResult.stdout);
  assert.ok(
    !combined.includes("does not match") && !combined.includes("does not match stored"),
    `matching --project must not trigger the mismatch guard\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

// ── Fix 3: partial-schema migration fills missing approval columns ─────────────

test("integ migration: partial approval schema (only approved_by present) gets missing columns filled", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-partial-schema-"));
  const dbPath = join(dir, "partial.db");

  try {
    // Build a DB that has approved_by but is missing approved_at, approval_rationale, approved_plan_hash
    const db1 = new Database(dbPath);
    db1.pragma("foreign_keys = ON");
    db1.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id         TEXT PRIMARY KEY,
        status     TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_input TEXT NOT NULL,
        mode       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata   TEXT,
        plan_hash  TEXT,
        approved_by TEXT
      );
      CREATE TABLE IF NOT EXISTS campaign_items (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, item_order INTEGER NOT NULL,
        ticket_id TEXT NOT NULL, run_id TEXT, branch TEXT, worktree_path TEXT, pr_url TEXT,
        lifecycle_status TEXT NOT NULL, outcome TEXT, blocker_kind TEXT, continue_policy TEXT,
        reason TEXT, requested_human_action TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, metadata TEXT, project_dir TEXT);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, phase TEXT NOT NULL, agent_role TEXT NOT NULL, status TEXT NOT NULL, task_package TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, red_task_id TEXT NOT NULL, red_role TEXT NOT NULL, verdict TEXT NOT NULL, confidence REAL NOT NULL, authority TEXT NOT NULL, findings TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gates (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT, decided_at TEXT NOT NULL, decided_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, model TEXT NOT NULL, alias TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    `);
    db1.close();

    // applyMigrations should add the three missing columns independently
    const db2 = new Database(dbPath);
    db2.pragma("foreign_keys = ON");
    db2.exec(SCHEMA_SQL);
    applyMigrations(db2);

    const cols = db2.prepare("PRAGMA table_info(campaigns)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has("approved_by"), "approved_by must still be present");
    assert.ok(colNames.has("approved_at"), "approved_at must be added by independent guard");
    assert.ok(colNames.has("approval_rationale"), "approval_rationale must be added by independent guard");
    assert.ok(colNames.has("approved_plan_hash"), "approved_plan_hash must be added by independent guard");
    assert.ok(colNames.has("project_dir"), "project_dir must be present");

    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FG-394: show command ───────────────────────────────────────────────────────

test("integ campaign show: exits non-zero for unknown campaign", () => {
  const result = runForge(["campaign", "show", "campaign-does-not-exist"]);
  assert.notEqual(result.status, 0);
  assert.ok(
    (result.stderr + result.stdout).includes("not found"),
    `expected 'not found'\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign show --json: outputs valid JSON with required fields", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const showResult = runForge(["campaign", "show", planOutput.campaignId, "--json"]);
  assert.equal(showResult.status, 0, `show failed\nstdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);

  const output = JSON.parse(showResult.stdout) as Record<string, unknown>;
  assert.ok(typeof output["campaignId"] === "string", "campaignId must be present");
  assert.ok(typeof output["status"] === "string", "status must be present");
  assert.ok(typeof output["mode"] === "string", "mode must be present");
  assert.ok("approvedPlanHash" in output, "approvedPlanHash must be present");
  assert.ok("currentPlanHash" in output, "currentPlanHash must be present");
  assert.ok("planStale" in output, "planStale must be present");
  assert.ok("projectDir" in output, "projectDir must be present");
  assert.ok("activeItem" in output, "activeItem must be present");
  assert.ok(Array.isArray(output["items"]), "items must be an array");
  assert.ok(typeof output["nextAction"] === "string", "nextAction must be present");
  assert.equal(output["status"], "planned");
  assert.equal(output["nextAction"], "approve");
});

test("integ campaign show: human output exits 0 and prints campaign status", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const showResult = runForge(["campaign", "show", planOutput.campaignId]);
  assert.equal(showResult.status, 0, `show failed\nstdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);
  assert.ok(
    showResult.stdout.includes("planned") || showResult.stdout.includes("Status"),
    `expected status info in output\nstdout: ${showResult.stdout}`
  );
});

// ── FG-394: report command ─────────────────────────────────────────────────────

test("integ campaign report: exits non-zero for unknown campaign", () => {
  const result = runForge(["campaign", "report", "campaign-does-not-exist"]);
  assert.notEqual(result.status, 0);
  assert.ok(
    (result.stderr + result.stdout).includes("not found"),
    `expected 'not found'\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
});

test("integ campaign report --json: outputs valid JSON with required fields + groupings", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const reportResult = runForge(["campaign", "report", planOutput.campaignId, "--json"]);
  assert.equal(reportResult.status, 0, `report failed\nstdout: ${reportResult.stdout}\nstderr: ${reportResult.stderr}`);

  const output = JSON.parse(reportResult.stdout) as Record<string, unknown>;
  // Required top-level fields
  assert.ok(typeof output["campaignId"] === "string");
  assert.ok("sourceInput" in output);
  assert.ok("goal" in output);
  assert.ok(typeof output["mode"] === "string");
  assert.ok(typeof output["status"] === "string");
  assert.ok("approvedPlanHash" in output);
  assert.ok("currentPlanHash" in output);
  assert.ok(typeof output["safetyToContinue"] === "string");
  assert.ok(typeof output["verdict"] === "string");
  assert.ok(Array.isArray(output["items"]));
  assert.ok(typeof output["groupings"] === "object" && output["groupings"] !== null);
  assert.ok("dirtyGitState" in output);
  assert.ok(Array.isArray(output["deferredScope"]));
  assert.ok(Array.isArray(output["followUpTickets"]));
  assert.ok(typeof output["nextOperatorAction"] === "string");

  // Groupings must have all five keys
  const groupings = output["groupings"] as Record<string, unknown>;
  assert.ok(Array.isArray(groupings["shipped"]));
  assert.ok(Array.isArray(groupings["blocked"]));
  assert.ok(Array.isArray(groupings["held"]));
  assert.ok(Array.isArray(groupings["skipped"]));
  assert.ok(Array.isArray(groupings["failed"]));
});

// ── FG-394: pause command ──────────────────────────────────────────────────────

test("integ campaign pause: exits non-zero for non-running campaign (planned)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const pauseResult = runForge(["campaign", "pause", planOutput.campaignId]);
  assert.notEqual(pauseResult.status, 0, "pausing a planned campaign must exit non-zero");
  const combined = (pauseResult.stderr + pauseResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("planned") || combined.includes("running") || combined.includes("only"),
    `expected clear error message\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`
  );
});

test("integ campaign pause --json: outputs JSON with paused status", () => {
  // Plan and approve a campaign, then manually set it to running in the DB
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to running via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const pauseResult = runForge(["campaign", "pause", planOutput.campaignId, "--json"]);
  assert.equal(pauseResult.status, 0, `pause failed\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`);

  const output = JSON.parse(pauseResult.stdout) as Record<string, unknown>;
  assert.equal(output["campaignId"], planOutput.campaignId);
  assert.equal(output["status"], "paused");
  assert.ok(
    typeof output["note"] === "string" && (output["note"] as string).includes("item"),
    "pause note must mention item (cooperative semantics)"
  );

  // Verify campaign is now paused in DB
  const db2 = new Database(dbPath, { readonly: true });
  const row = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(planOutput.campaignId) as { status: string };
  db2.close();
  assert.equal(row.status, "paused");
});

// ── FG-394: abandon command ────────────────────────────────────────────────────

test("integ campaign abandon: transitions planned->abandoned and exits 0", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const abandonResult = runForge(["campaign", "abandon", planOutput.campaignId, "--json"]);
  assert.equal(abandonResult.status, 0, `abandon failed\nstdout: ${abandonResult.stdout}\nstderr: ${abandonResult.stderr}`);

  const output = JSON.parse(abandonResult.stdout) as Record<string, unknown>;
  assert.equal(output["status"], "abandoned");

  // Verify in DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT status FROM campaigns WHERE id = ?").get(planOutput.campaignId) as { status: string };
  db.close();
  assert.equal(row.status, "abandoned");
});

test("integ campaign abandon: exits non-zero for already-terminal campaign", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to complete via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const abandonResult = runForge(["campaign", "abandon", planOutput.campaignId]);
  assert.notEqual(abandonResult.status, 0, "abandoning a complete campaign must exit non-zero");
  const combined = (abandonResult.stderr + abandonResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("complete") || combined.includes("terminal"),
    `expected terminal state message\nstdout: ${abandonResult.stdout}\nstderr: ${abandonResult.stderr}`
  );
});

// ── FG-394: no project-tracked file writes ────────────────────────────────────

test("integ: show/report/pause/abandon do not write any file to projectDir", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;

  function listFiles(dir: string): string[] {
    const result: string[] = [];
    function walk(d: string) {
      try {
        const entries = readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else result.push(full);
        }
      } catch { /* ignore */ }
    }
    walk(dir);
    return result.sort();
  }

  const before = listFiles(projectDir);

  // show
  runForge(["campaign", "show", campaignId]);
  runForge(["campaign", "show", campaignId, "--json"]);

  // report
  runForge(["campaign", "report", campaignId]);
  runForge(["campaign", "report", campaignId, "--json"]);

  // pause (will fail since campaign is planned, not running — still must not write files)
  runForge(["campaign", "pause", campaignId]);

  // abandon
  runForge(["campaign", "abandon", campaignId]);

  const after = listFiles(projectDir);

  assert.deepEqual(after, before, "no commands must create or modify files in projectDir");
});

// ── FG-394: resume command ─────────────────────────────────────────────────────

test("integ campaign resume: exits non-zero for non-paused campaign (planned)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, "resuming a planned campaign must exit non-zero");
  const combined = (resumeResult.stderr + resumeResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("not_paused") || combined.includes("paused") || combined.includes("not paused"),
    `expected paused-state message\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

test("integ campaign resume: happy path — all items already complete, campaign reaches complete", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Approve campaign
  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Set campaign to paused and mark item as complete (simulates prior run that got paused after last item)
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE campaign_id = ?").run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);

  const output = JSON.parse(resumeResult.stdout) as Record<string, unknown>;
  assert.equal(output["stopReason"], "complete", "resume must reach complete when all items are already terminal");

  // Verify campaign is complete in DB
  const db2 = new Database(dbPath, { readonly: true });
  const row = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(planOutput.campaignId) as { status: string };
  db2.close();
  assert.equal(row.status, "complete", "campaign must be complete in DB after resume");
});

test("integ campaign resume: exits non-zero for stale plan", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--epic", "FG-100",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Set to paused
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  // Add a story to make the plan stale
  writeTicket(projectDir, {
    id: "FG-999",
    type: "story",
    status: "active",
    title: "Stale trigger",
    epic: "FG-100",
    created: "2024-01-10",
    body: "Added after approval",
  });

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, "resume of stale campaign must exit non-zero");
  const combined = (resumeResult.stderr + resumeResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("stale") || combined.includes("backlog") || combined.includes("re-plan"),
    `expected stale-plan message\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

test("integ campaign resume --project: exits non-zero when --project differs from stored projectDir", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Set to paused
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const otherDir = mkdtempSync(join(tmpdir(), "forge-other-resume-"));
  try {
    const resumeResult = runForge([
      "campaign", "resume", planOutput.campaignId,
      "--project", otherDir,
    ]);
    assert.notEqual(resumeResult.status, 0, "resume with mismatched --project must exit non-zero");
    const combined = (resumeResult.stderr + resumeResult.stdout).toLowerCase();
    assert.ok(
      combined.includes("does not match") || combined.includes("mismatch") || combined.includes("stored"),
      `expected mismatch error\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
    );
  } finally {
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("integ campaign resume --project: passes guard when --project matches stored projectDir", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Set to paused and all items complete so resume completes without dispatching
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE campaign_id = ?").run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge([
    "campaign", "resume", planOutput.campaignId,
    "--project", projectDir,
  ]);
  // Must NOT trigger mismatch guard — may succeed or fail for other reasons (stale plan etc.)
  const combined = (resumeResult.stderr + resumeResult.stdout);
  assert.ok(
    !combined.includes("does not match") && !combined.includes("does not match stored"),
    `matching --project must not trigger mismatch guard\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

// ── FG-394: abandon additional legal/illegal states ────────────────────────────

test("integ campaign abandon: transitions running->abandoned and exits 0", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to running via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const abandonResult = runForge(["campaign", "abandon", planOutput.campaignId, "--json"]);
  assert.equal(abandonResult.status, 0, `abandon from running failed\nstdout: ${abandonResult.stdout}\nstderr: ${abandonResult.stderr}`);

  const output = JSON.parse(abandonResult.stdout) as Record<string, unknown>;
  assert.equal(output["status"], "abandoned");

  const db2 = new Database(dbPath, { readonly: true });
  const row = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(planOutput.campaignId) as { status: string };
  db2.close();
  assert.equal(row.status, "abandoned");
});

test("integ campaign abandon: transitions paused->abandoned and exits 0", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to paused via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const abandonResult = runForge(["campaign", "abandon", planOutput.campaignId, "--json"]);
  assert.equal(abandonResult.status, 0, `abandon from paused failed\nstdout: ${abandonResult.stdout}\nstderr: ${abandonResult.stderr}`);

  const output = JSON.parse(abandonResult.stdout) as Record<string, unknown>;
  assert.equal(output["status"], "abandoned");

  const db2 = new Database(dbPath, { readonly: true });
  const row = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(planOutput.campaignId) as { status: string };
  db2.close();
  assert.equal(row.status, "abandoned");
});

test("integ campaign abandon: exits non-zero for failed campaign (no stack trace)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to failed via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const abandonResult = runForge(["campaign", "abandon", planOutput.campaignId]);
  assert.notEqual(abandonResult.status, 0, "abandoning a failed campaign must exit non-zero");
  // Must produce a clean error message, not a stack trace
  const combined = abandonResult.stderr + abandonResult.stdout;
  assert.ok(
    combined.includes("failed") || combined.includes("terminal"),
    `expected terminal-state message\nstdout: ${abandonResult.stdout}\nstderr: ${abandonResult.stderr}`
  );
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace\nstdout: ${abandonResult.stdout}\nstderr: ${abandonResult.stderr}`);
});

test("integ campaign abandon: exits non-zero for already-abandoned campaign (no stack trace)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Abandon it first
  const firstAbandon = runForge(["campaign", "abandon", planOutput.campaignId]);
  assert.equal(firstAbandon.status, 0);

  // Try to abandon again
  const secondAbandon = runForge(["campaign", "abandon", planOutput.campaignId]);
  assert.notEqual(secondAbandon.status, 0, "double-abandon must exit non-zero");
  const combined = secondAbandon.stderr + secondAbandon.stdout;
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace\nstdout: ${secondAbandon.stdout}\nstderr: ${secondAbandon.stderr}`);
  assert.ok(
    combined.toLowerCase().includes("abandoned") || combined.toLowerCase().includes("terminal"),
    `expected abandoned/terminal message\nstdout: ${secondAbandon.stdout}\nstderr: ${secondAbandon.stderr}`
  );
});

// ── FG-394: pause illegal from non-running states ─────────────────────────────

test("integ campaign pause: exits non-zero for paused campaign (no stack trace)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to paused via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const pauseResult = runForge(["campaign", "pause", planOutput.campaignId]);
  assert.notEqual(pauseResult.status, 0, "pausing an already-paused campaign must exit non-zero");
  const combined = pauseResult.stderr + pauseResult.stdout;
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`);
  assert.ok(
    combined.toLowerCase().includes("paused") || combined.toLowerCase().includes("running") || combined.toLowerCase().includes("only"),
    `expected clear refusal message\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`
  );
});

test("integ campaign pause: exits non-zero for complete campaign (no stack trace)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to complete via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const pauseResult = runForge(["campaign", "pause", planOutput.campaignId]);
  assert.notEqual(pauseResult.status, 0, "pausing a complete campaign must exit non-zero");
  const combined = pauseResult.stderr + pauseResult.stdout;
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`);
});

test("integ campaign pause: exits non-zero for failed campaign (no stack trace)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set to failed via DB
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const pauseResult = runForge(["campaign", "pause", planOutput.campaignId]);
  assert.notEqual(pauseResult.status, 0, "pausing a failed campaign must exit non-zero");
  const combined = pauseResult.stderr + pauseResult.stdout;
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`);
});

// ── FG-394: no project-tracked writes — include resume ────────────────────────

test("integ: resume does not write any file to projectDir", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Approve campaign
  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0);

  // Set to paused with item complete (so resume completes without dispatching anything)
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE campaign_id = ?").run(planOutput.campaignId);
  db.close();

  function listFiles(dir: string): string[] {
    const result: string[] = [];
    function walk(d: string) {
      try {
        const entries = readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else result.push(full);
        }
      } catch { /* ignore */ }
    }
    walk(dir);
    return result.sort();
  }

  const before = listFiles(projectDir);

  runForge(["campaign", "resume", planOutput.campaignId]);
  runForge(["campaign", "resume", planOutput.campaignId, "--json"]);

  const after = listFiles(projectDir);
  assert.deepEqual(after, before, "resume must not create or modify any file in projectDir");
});

// ── FG-394: report two-campaign two-verdict integration ───────────────────────

test("integ campaign report --json: two campaigns produce all_shipped and complete_with_issues verdicts", () => {
  // Campaign 1: all items shipped
  const plan1 = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(plan1.status, 0);
  const out1 = JSON.parse(plan1.stdout) as { campaignId: string };

  // Campaign 2: one shipped, one failed
  const plan2 = runForge([
    "campaign", "plan",
    "--tickets", "FG-102,FG-103",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(plan2.status, 0);
  const out2 = JSON.parse(plan2.stdout) as { campaignId: string };

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);

  // Set campaign 1 to complete with all items shipped
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(out1.campaignId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(out1.campaignId);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE campaign_id = ?").run(out1.campaignId);

  // Set campaign 2 to complete with mixed outcomes
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(out2.campaignId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(out2.campaignId);
  const items2 = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(out2.campaignId) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items2[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'failed', blocker_kind = 'campaign_system' WHERE id = ?").run(items2[1]!.id);
  db.close();

  const report1 = runForge(["campaign", "report", out1.campaignId, "--json"]);
  assert.equal(report1.status, 0, `report1 failed\nstdout: ${report1.stdout}\nstderr: ${report1.stderr}`);
  const r1 = JSON.parse(report1.stdout) as Record<string, unknown>;
  assert.equal(r1["verdict"], "all_shipped", "campaign with all shipped must have verdict=all_shipped");

  const report2 = runForge(["campaign", "report", out2.campaignId, "--json"]);
  assert.equal(report2.status, 0, `report2 failed\nstdout: ${report2.stdout}\nstderr: ${report2.stderr}`);
  const r2 = JSON.parse(report2.stdout) as Record<string, unknown>;
  assert.equal(r2["verdict"], "complete_with_issues", "campaign with mixed outcomes must have verdict=complete_with_issues");
});

// ── Fix 3: accurate control-command errors ────────────────────────────────────────────────────────

test("integ Fix3: pause on planned campaign emits clean message naming ACTUAL status (planned), no stack trace", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const pauseResult = runForge(["campaign", "pause", planOutput.campaignId]);
  assert.notEqual(pauseResult.status, 0, "pausing a planned campaign must exit non-zero");
  const combined = pauseResult.stderr + pauseResult.stdout;
  assert.ok(
    combined.includes("planned"),
    `error must name the actual status 'planned'\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`
  );
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`);
});

test("integ Fix3: pause on paused campaign emits clean message naming ACTUAL status (paused), no stack trace", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const pauseResult = runForge(["campaign", "pause", planOutput.campaignId]);
  assert.notEqual(pauseResult.status, 0, "pausing a paused campaign must exit non-zero");
  const combined = pauseResult.stderr + pauseResult.stdout;
  assert.ok(
    combined.includes("paused"),
    `error must name the actual status 'paused'\nstdout: ${pauseResult.stdout}\nstderr: ${pauseResult.stderr}`
  );
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace`);
});

test("integ Fix3: abandon on already-abandoned campaign emits clean message naming ACTUAL status, no stack trace", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // First abandon succeeds
  const first = runForge(["campaign", "abandon", planOutput.campaignId]);
  assert.equal(first.status, 0, `first abandon must succeed\nstderr: ${first.stderr}`);

  // Second abandon: already-abandoned
  const second = runForge(["campaign", "abandon", planOutput.campaignId]);
  assert.notEqual(second.status, 0, "second abandon must exit non-zero");
  const combined = second.stderr + second.stdout;
  assert.ok(
    combined.includes("abandoned"),
    `error must name the actual status 'abandoned'\nstdout: ${second.stdout}\nstderr: ${second.stderr}`
  );
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace`);
});

test("integ Fix3: abandon on complete campaign emits message naming ACTUAL status (complete), no stack trace", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const abandonResult = runForge(["campaign", "abandon", planOutput.campaignId]);
  assert.notEqual(abandonResult.status, 0, "abandoning a complete campaign must exit non-zero");
  const combined = abandonResult.stderr + abandonResult.stdout;
  assert.ok(
    combined.includes("complete"),
    `error must name the actual status 'complete'\nstdout: ${abandonResult.stdout}\nstderr: ${abandonResult.stderr}`
  );
  assert.ok(!combined.includes("at Object."), `must not expose a stack trace`);
});

// ── FG-394-fix2: start CLI recovery_needed ────────────────────────────────────

test("integ campaign start: planned+approved campaign with in-flight item → exits non-zero, stderr has recovery guidance naming ticket+run_id", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Force item into 'running' state (simulates crashed driver)
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-inflight-integ-123' WHERE id = ?").run(items[0]!.id);
  db.close();

  const startResult = runForge(["campaign", "start", planOutput.campaignId]);
  assert.notEqual(startResult.status, 0, `start with in-flight item must exit non-zero\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`);

  const combined = startResult.stderr + startResult.stdout;
  assert.ok(
    combined.includes("recovery needed"),
    `output must mention 'recovery needed'\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-101"),
    `output must name the in-flight ticket FG-101\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes("run-inflight-integ-123"),
    `output must include the run_id\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

// ── FG-394-fix2: resume CLI recovery_needed regression guard ──────────────────

test("integ campaign resume: paused campaign with in-flight item → exits non-zero with recovery guidance (regression guard)", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Set campaign to paused with an in-flight item
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-stuck-resume-789' WHERE id = ?").run(items[0]!.id);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, `resume with in-flight item must exit non-zero\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);

  const combined = resumeResult.stderr + resumeResult.stdout;
  assert.ok(
    combined.includes("recovery needed"),
    `output must mention 'recovery needed'\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-101"),
    `output must name the in-flight ticket\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes("run-stuck-resume-789"),
    `output must include the run_id\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

// ── FG-394-fix2: exhaustive exit-code guard — start ───────────────────────────

test("integ exhaustive exit-code guard: start command exits non-zero for every pre-flight refusal", () => {
  const dbPath = join(forgeHome, "forge.db");

  // (a) not_approved: plan sequential, don't approve
  const planA = runForge([
    "campaign", "plan", "--tickets", "FG-101", "--mode", "sequential", "--project", projectDir, "--json",
  ]);
  assert.equal(planA.status, 0);
  const outA = JSON.parse(planA.stdout) as { campaignId: string };
  const startA = runForge(["campaign", "start", outA.campaignId]);
  assert.notEqual(startA.status, 0, `not_approved must exit non-zero\nstdout: ${startA.stdout}\nstderr: ${startA.stderr}`);

  // (b) dry_run_not_executable: plan dry_run, approve it
  const planB = runForge([
    "campaign", "plan", "--tickets", "FG-101", "--mode", "dry_run", "--project", projectDir, "--json",
  ]);
  assert.equal(planB.status, 0);
  const outB = JSON.parse(planB.stdout) as { campaignId: string };
  runForge(["campaign", "approve", outB.campaignId, "--rationale", "ok"]);
  const startB = runForge(["campaign", "start", outB.campaignId]);
  assert.notEqual(startB.status, 0, `dry_run_not_executable must exit non-zero\nstdout: ${startB.stdout}\nstderr: ${startB.stderr}`);

  // (c) not_planned: campaign in wrong state (complete)
  const planC = runForge([
    "campaign", "plan", "--tickets", "FG-101", "--mode", "sequential", "--project", projectDir, "--json",
  ]);
  assert.equal(planC.status, 0);
  const outC = JSON.parse(planC.stdout) as { campaignId: string };
  const dbC = new Database(dbPath);
  dbC.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(outC.campaignId);
  dbC.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(outC.campaignId);
  dbC.close();
  const startC = runForge(["campaign", "start", outC.campaignId]);
  assert.notEqual(startC.status, 0, `not_planned must exit non-zero\nstdout: ${startC.stdout}\nstderr: ${startC.stderr}`);

  // (d) recovery_needed: plan, approve, force item to running
  const planD = runForge([
    "campaign", "plan", "--tickets", "FG-102", "--mode", "sequential", "--project", projectDir, "--json",
  ]);
  assert.equal(planD.status, 0);
  const outD = JSON.parse(planD.stdout) as { campaignId: string };
  runForge(["campaign", "approve", outD.campaignId, "--rationale", "ok"]);
  const dbD = new Database(dbPath);
  const itemsD = dbD.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(outD.campaignId) as { id: string }[];
  dbD.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-exhaust-test' WHERE id = ?").run(itemsD[0]!.id);
  dbD.close();
  const startD = runForge(["campaign", "start", outD.campaignId]);
  assert.notEqual(startD.status, 0, `recovery_needed must exit non-zero\nstdout: ${startD.stdout}\nstderr: ${startD.stderr}`);
});

// ── FG-394-fix2: exhaustive exit-code guard — resume ─────────────────────────

test("integ exhaustive exit-code guard: resume command exits non-zero for every pre-flight refusal", () => {
  const dbPath = join(forgeHome, "forge.db");

  // (a) not_paused: campaign is planned (not paused)
  const planA = runForge([
    "campaign", "plan", "--tickets", "FG-101", "--mode", "sequential", "--project", projectDir, "--json",
  ]);
  assert.equal(planA.status, 0);
  const outA = JSON.parse(planA.stdout) as { campaignId: string };
  runForge(["campaign", "approve", outA.campaignId, "--rationale", "ok"]);
  const resumeA = runForge(["campaign", "resume", outA.campaignId]);
  assert.notEqual(resumeA.status, 0, `not_paused must exit non-zero\nstdout: ${resumeA.stdout}\nstderr: ${resumeA.stderr}`);

  // (b) not_approved: paused but no approval
  const planB = runForge([
    "campaign", "plan", "--tickets", "FG-101", "--mode", "sequential", "--project", projectDir, "--json",
  ]);
  assert.equal(planB.status, 0);
  const outB = JSON.parse(planB.stdout) as { campaignId: string };
  const dbB = new Database(dbPath);
  dbB.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(outB.campaignId);
  dbB.close();
  const resumeB = runForge(["campaign", "resume", outB.campaignId]);
  assert.notEqual(resumeB.status, 0, `not_approved (paused) must exit non-zero\nstdout: ${resumeB.stdout}\nstderr: ${resumeB.stderr}`);

  // (c) abandoned: campaign abandoned (not paused)
  const planC = runForge([
    "campaign", "plan", "--tickets", "FG-102", "--mode", "sequential", "--project", projectDir, "--json",
  ]);
  assert.equal(planC.status, 0);
  const outC = JSON.parse(planC.stdout) as { campaignId: string };
  const dbC = new Database(dbPath);
  dbC.prepare("UPDATE campaigns SET status = 'abandoned' WHERE id = ?").run(outC.campaignId);
  dbC.close();
  const resumeC = runForge(["campaign", "resume", outC.campaignId]);
  assert.notEqual(resumeC.status, 0, `not_paused (abandoned) must exit non-zero\nstdout: ${resumeC.stdout}\nstderr: ${resumeC.stderr}`);

  // (d) recovery_needed: paused with in-flight item
  const planD = runForge([
    "campaign", "plan", "--tickets", "FG-103", "--mode", "sequential", "--project", projectDir, "--json",
  ]);
  assert.equal(planD.status, 0);
  const outD = JSON.parse(planD.stdout) as { campaignId: string };
  runForge(["campaign", "approve", outD.campaignId, "--rationale", "ok"]);
  const dbD = new Database(dbPath);
  dbD.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(outD.campaignId);
  const itemsD = dbD.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(outD.campaignId) as { id: string }[];
  dbD.prepare("UPDATE campaign_items SET lifecycle_status = 'running', run_id = 'run-exhaust-resume-test' WHERE id = ?").run(itemsD[0]!.id);
  dbD.close();
  const resumeD = runForge(["campaign", "resume", outD.campaignId]);
  assert.notEqual(resumeD.status, 0, `recovery_needed must exit non-zero\nstdout: ${resumeD.stdout}\nstderr: ${resumeD.stderr}`);
});
