import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations, setDbForTest } from "../../store/db.js";
import { insertHostVerification } from "../../store/host-verifications.js";
import { writeTicket, closeTicket } from "../../backlog/structured.js";

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

// FG-442 finding 3: `campaign plan` refuses when no lane judgment is supplied
// (no --routes, no --default-lane). The overwhelming majority of tests in this
// file plan a campaign only as setup for testing unrelated behavior (approve,
// start, escalate-lane, reconcile, ...), so runForge auto-supplies a
// --default-lane for a bare `campaign plan` call unless the caller already
// passed --routes or --default-lane. Tests that exercise the lane-judgment
// requirement itself pass { rawPlan: true } to get the real, un-augmented CLI
// invocation.
function runForge(args: string[], opts: { rawPlan?: boolean } = {}) {
  const isPlan = args[0] === "campaign" && args[1] === "plan";
  const hasLaneJudgment = args.includes("--routes") || args.includes("--default-lane");
  const finalArgs =
    isPlan && !opts.rawPlan && !hasLaneJudgment
      ? [...args, "--default-lane", "full_feature", "--default-lane-rationale", "test-harness default (FG-442 compat, unrelated to the behavior under test)"]
      : args;
  return spawnSync(tsx, [entry, ...finalArgs], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

/** Campaign fixtures must use the production writer, which derives the proven
 * project_dir_canonical identity instead of accidentally creating legacy rows. */
function insertFixtureHostVerification(
  db: Database.Database,
  ticketId: string,
  commitSha: string,
  recordedAt = "2026-01-01T00:00:00Z",
): void {
  setDbForTest(db);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt,
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
    "--mode", "sequential",
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

test("integ campaign report --json: two campaigns — all-shipped-items and mixed-outcomes — both produce complete_with_issues (FG-383: all_shipped requires done-audit=pass, host recorder out of scope)", () => {
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
  // FG-383: all_shipped requires done-audit=pass; host recorder is out of scope → always complete_with_issues
  assert.equal(r1["verdict"], "complete_with_issues", "campaign with all shipped items but no host recorder must yield complete_with_issues");

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

// ── FG-411: plan_unresolvable — CLI exits non-zero with clear message ─────────

function deleteTicketFileInteg(dir: string, ticketId: string): void {
  const storiesDir = join(dir, "backlog", "stories");
  const files = readdirSync(storiesDir);
  const file = files.find((f: string) => f.startsWith(`${ticketId}-`) || f === `${ticketId}.md`);
  if (file) rmSync(join(storiesDir, file));
}

test("FG-411 integ: forge campaign start exits non-zero with re-plan message when source ticket deleted", () => {
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

  // Delete the source ticket file to trigger plan_unresolvable
  deleteTicketFileInteg(projectDir, "FG-101");

  const startResult = runForge(["campaign", "start", planOutput.campaignId]);
  assert.notEqual(startResult.status, 0, `start with deleted source ticket must exit non-zero\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`);
  const combined = (startResult.stderr + startResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("re-plan") || combined.includes("unresolvable") || combined.includes("deleted"),
    `expected re-plan/unresolvable/deleted message\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

test("FG-411 integ: forge campaign resume exits non-zero with re-plan message when source ticket deleted", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  // Set to paused
  const dbPath = join(forgeHome, "forge.db");
  const dbConn = new Database(dbPath);
  dbConn.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  dbConn.close();

  // Delete the source ticket file to trigger plan_unresolvable
  deleteTicketFileInteg(projectDir, "FG-101");

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, `resume with deleted source ticket must exit non-zero\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const combined = (resumeResult.stderr + resumeResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("re-plan") || combined.includes("unresolvable") || combined.includes("deleted"),
    `expected re-plan/unresolvable/deleted message\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

test("FG-411 integ: forge campaign show exits 0 and renders campaign even when source ticket deleted", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  // Delete the source ticket file
  deleteTicketFileInteg(projectDir, "FG-101");

  const showResult = runForge(["campaign", "show", planOutput.campaignId, "--json"]);
  assert.equal(showResult.status, 0, `show must exit 0 even when source ticket deleted\nstdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);

  const output = JSON.parse(showResult.stdout) as { nextAction: string; status: string };
  assert.equal(output.status, "planned", "campaign status must still be planned");
  assert.ok(
    output.nextAction.includes("re-plan") || output.nextAction.includes("re-plan"),
    `nextAction must advise re-plan, got: ${output.nextAction}`
  );
  assert.notEqual(output.nextAction, "start");
});

test("FG-411 integ: forge campaign report exits 0 and shows non-continuable safety when source ticket deleted", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  // Delete the source ticket file
  deleteTicketFileInteg(projectDir, "FG-101");

  const reportResult = runForge(["campaign", "report", planOutput.campaignId, "--json"]);
  assert.equal(reportResult.status, 0, `report must exit 0 even when source ticket deleted\nstdout: ${reportResult.stdout}\nstderr: ${reportResult.stderr}`);

  const output = JSON.parse(reportResult.stdout) as { safetyToContinue: string; nextOperatorAction: string };
  assert.notEqual(output.safetyToContinue, "can_start", "safetyToContinue must not be can_start");
  assert.notEqual(output.safetyToContinue, "can_resume", "safetyToContinue must not be can_resume");
  assert.ok(
    output.nextOperatorAction.includes("re-plan"),
    `nextOperatorAction must advise re-plan, got: ${output.nextOperatorAction}`
  );
});

// ── FG-413: show/report human output surfaces readiness for readiness-held items ─

test("FG-413 integ: forge campaign show (human) surfaces readiness for a readiness-held item", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set campaign to paused with FG-101 held on readiness
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness', reason = 'held because not ready', requested_human_action = 'refine FG-101 then resume' WHERE campaign_id = ?"
  ).run(planOutput.campaignId);
  db.close();

  const showResult = runForge(["campaign", "show", planOutput.campaignId]);
  assert.equal(showResult.status, 0, `show failed\nstdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);

  const output = showResult.stdout + showResult.stderr;
  assert.ok(
    output.includes("readiness"),
    `human output must include 'readiness'\nstdout: ${showResult.stdout}`
  );
  assert.ok(
    output.includes("needs_refinement"),
    `human output must include readiness outcome 'needs_refinement'\nstdout: ${showResult.stdout}`
  );
  assert.ok(
    output.includes("refinement") || output.includes("gaps"),
    `human output must include gaps or refinement proposal\nstdout: ${showResult.stdout}`
  );
  assert.ok(
    output.includes("refine") && output.includes("FG-101"),
    `human output next action must mention 'refine FG-101'\nstdout: ${showResult.stdout}`
  );
});

test("FG-413 integ: forge campaign report (human) surfaces requestedHumanAction and readiness for readiness-held item", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness', reason = 'held because not ready', requested_human_action = 'refine FG-101 then resume' WHERE campaign_id = ?"
  ).run(planOutput.campaignId);
  db.close();

  const reportResult = runForge(["campaign", "report", planOutput.campaignId]);
  assert.equal(reportResult.status, 0, `report failed\nstdout: ${reportResult.stdout}\nstderr: ${reportResult.stderr}`);

  const output = reportResult.stdout + reportResult.stderr;
  assert.ok(
    output.includes("refine FG-101 then resume"),
    `human report output must include requestedHumanAction\nstdout: ${reportResult.stdout}`
  );
  assert.ok(
    output.includes("readiness"),
    `human report output must include 'readiness'\nstdout: ${reportResult.stdout}`
  );
  assert.ok(
    output.includes("needs_refinement"),
    `human report output must include readiness outcome 'needs_refinement'\nstdout: ${reportResult.stdout}`
  );
  assert.ok(
    output.includes("refine") && output.includes("FG-101"),
    `next operator action must mention 'refine FG-101'\nstdout: ${reportResult.stdout}`
  );
});

// ── FG-413: start-time readiness-hold message ─────────────────────────────────
// Note: defect 3 (start-time paused message for readiness-held items) is exercised
// here via the CLI integration test since FG-101 has an empty body (needs_refinement).
// The readiness gate holds FG-101 without dispatching, so no real container is invoked.

test("FG-413 integ: forge campaign start emits readiness-hold message for unready items (not generic 'run resume')", () => {
  // FG-101 has empty body → needs_refinement readiness → held by readiness gate
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  const startResult = runForge(["campaign", "start", planOutput.campaignId]);
  // paused is a success reason (exit 0)
  assert.equal(startResult.status, 0, `start must exit 0 for paused campaign\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`);

  const combined = startResult.stdout + startResult.stderr;
  assert.ok(
    combined.includes("not ready") || combined.includes("refine"),
    `output must mention 'not ready' or 'refine' for readiness-held items\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-101"),
    `output must name the readiness-held ticket\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    !combined.includes("campaign paused between items"),
    `output must NOT say 'campaign paused between items' for a readiness-held campaign\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

test("FG-413 integ: forge campaign resume emits readiness-hold message after re-pause (not generic 'paused between items')", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  // Simulate a prior start that paused on the readiness gate: campaign is paused,
  // item is pending with outcome=held, blocker_kind=readiness
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness' WHERE campaign_id = ?"
  ).run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  // paused is a success reason for resume → exit 0
  assert.equal(resumeResult.status, 0, `resume must exit 0 for readiness-held campaign\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);

  const combined = resumeResult.stdout + resumeResult.stderr;
  assert.ok(
    combined.includes("not ready") || combined.includes("refine"),
    `output must mention 'not ready' or 'refine' for readiness-held items\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-101"),
    `output must name the readiness-held ticket\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    !combined.includes("campaign paused between items"),
    `output must NOT say 'campaign paused between items' for a readiness-held campaign\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

// ── FG-416: dependency-held resume message ────────────────────────────────────
// Repro: paused campaign with FG-101 (failed+blocked, local blocker) and FG-102
// (pending+held, dependency-held, no blockerKind=readiness). Before fix, resume printed
// "campaign paused between items — run resume again to continue" because the dependency-held
// record had no blockerKind and fell through all branches to the generic else.

test("FG-416 integ: forge campaign resume — dependency-held item prints blocker guidance, not 'run resume again'", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);

  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(planOutput.campaignId) as { id: string; ticket_id: string }[];

  // FG-101: failed+blocked with a LOCAL blocker (scope — not in SHARED_BLOCKER_KINDS)
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', reason = 'gate rejected' WHERE id = ?"
  ).run(items[0]!.id);

  // FG-102: pending+held, dependency-held — NO blocker_kind (not readiness), reason set
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = NULL, reason = 'held because dependency relation is unknown in sequential mode' WHERE id = ?"
  ).run(items[1]!.id);

  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  // paused is a success reason → exit 0
  assert.equal(resumeResult.status, 0, `resume must exit 0\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);

  const combined = resumeResult.stdout + resumeResult.stderr;

  assert.ok(
    !combined.includes("run resume again"),
    `output must NOT say 'run resume again'\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    !combined.includes("paused between items"),
    `output must NOT say 'paused between items'\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-102"),
    `output must name the dependency-held ticket FG-102\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes("blocker") || combined.includes("resolve"),
    `output must mention 'blocker' or 'resolve'\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes("show") || combined.includes("report"),
    `output must mention 'show' or 'report'\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

test("FG-416 integ: forge campaign resume — readiness-held pause still prints refine message (regression guard)", () => {
  // Regression: adding the dependencyHeld branch must not swallow readiness-held items.
  // This is already covered by FG-413 tests; this test anchors the FG-416 branch order.
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness' WHERE campaign_id = ?"
  ).run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.equal(resumeResult.status, 0, `resume must exit 0\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);

  const combined = resumeResult.stdout + resumeResult.stderr;
  assert.ok(
    combined.includes("not ready") || combined.includes("refine"),
    `readiness-held must still print 'not ready'/'refine'\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    !combined.includes("paused between items"),
    `readiness-held must NOT print generic 'paused between items'\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    !combined.includes("unresolved blocker"),
    `readiness-held must NOT print dependency-held message\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

// Note: `forge campaign start` cannot be driven into the dependency-held-pause state via
// integration test without a live dispatch (the executor requires real item execution to
// produce a failed+blocked item before the dependency-held hold fires at start-time).
// The start handler uses identical branch logic to the resume handler (same diff applied);
// unit-level coverage via executor.integration.test.ts (FG-393 T1/T3) exercises the itemRecord
// shape that the CLI branches against.

// ── FG-416: start handler dependency-held branch — DB injection ──────────────────────────────

test("FG-416 integ: forge campaign start — DB-injected dependency-held state emits blocker guidance, not generic 'run resume'", () => {
  // Drive the start paused handler's dependencyHeld branch by injecting prior-run terminal state:
  // item1 is already terminal (failed+blocked LOCAL), item2 is pending+held (no blockerKind=readiness).
  // startCampaign skips terminal item1 (adds it to blockedItems), re-evaluates item2 as
  // dependency-held → itemRecords[dependencyHeld] non-empty → CLI emits blocker guidance.
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(planOutput.campaignId) as { id: string; ticket_id: string }[];

  // FG-101: terminal failed+blocked LOCAL → executor adds to blockedItems, skips dispatch
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', reason = 'prior failure' WHERE id = ?"
  ).run(items[0]!.id);

  // FG-102: pending+held, no blockerKind (dependency-held) → evaluateForHold against FG-101 → stays held
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = NULL, reason = 'held because dependency relation is unknown in sequential mode' WHERE id = ?"
  ).run(items[1]!.id);

  db.close();

  const startResult = runForge(["campaign", "start", planOutput.campaignId]);
  // paused is a success reason → exit 0
  assert.equal(startResult.status, 0, `start must exit 0 for paused campaign\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`);

  const combined = startResult.stdout + startResult.stderr;
  assert.ok(
    !combined.includes("run resume"),
    `output must NOT say 'run resume' (generic branch must not fire)\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-102"),
    `output must name the dependency-held ticket FG-102\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes("blocker") || combined.includes("resolve"),
    `output must mention 'blocker' or 'resolve'\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes("show") || combined.includes("report"),
    `output must mention 'show' or 'report'\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

// ── FG-416: branch ordering — readiness wins over dependency-held ────────────────────────────

test("FG-416 branch-ordering integ: readiness-held wins over dependency-held (start handler)", () => {
  // Three items: FG-101 terminal (failed+blocked LOCAL), FG-102 readiness-held,
  // FG-103 dependency-held. Branch order: readinessHeld → dependencyHeld → blocked → generic.
  // With BOTH readiness-held and dependency-held present, readiness wins → 'refine' message.
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102,FG-103",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(planOutput.campaignId) as { id: string; ticket_id: string }[];

  // FG-101: terminal failed+blocked LOCAL (adds to blockedItems on re-drive)
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', reason = 'prior failure' WHERE id = ?"
  ).run(items[0]!.id);

  // FG-102: readiness-held — empty body (from beforeEach) → re-evaluation keeps it readiness-held
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness', reason = 'held because not ready' WHERE id = ?"
  ).run(items[1]!.id);

  // FG-103: dependency-held — no blockerKind → evaluateForHold against FG-101 → stays held
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = NULL, reason = 'held because dependency relation is unknown in sequential mode' WHERE id = ?"
  ).run(items[2]!.id);

  db.close();

  const startResult = runForge(["campaign", "start", planOutput.campaignId]);
  assert.equal(startResult.status, 0, `start must exit 0\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`);

  const combined = startResult.stdout + startResult.stderr;
  assert.ok(
    combined.includes("not ready") || combined.includes("refine"),
    `output must say 'not ready' or 'refine' (readiness wins over dependency)\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-102"),
    `output must name the readiness-held ticket FG-102\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    !combined.includes("unresolved blocker"),
    `output must NOT say 'unresolved blocker' (dependency branch must not fire over readiness)\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    !combined.includes("run resume"),
    `output must NOT say 'run resume' (generic branch must not fire)\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

test("FG-416 branch-ordering integ: readiness-held wins over dependency-held (resume handler)", () => {
  // Same three-item scenario through resume (identical branch logic to start).
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102,FG-103",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);

  // Campaign must be paused for resume to proceed
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);

  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(planOutput.campaignId) as { id: string; ticket_id: string }[];

  // FG-101: terminal failed+blocked LOCAL
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', reason = 'prior failure' WHERE id = ?"
  ).run(items[0]!.id);

  // FG-102: readiness-held — empty body → re-evaluation keeps it readiness-held
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = 'readiness', reason = 'held because not ready' WHERE id = ?"
  ).run(items[1]!.id);

  // FG-103: dependency-held — no blockerKind → stays held against FG-101
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = NULL, reason = 'held because dependency relation is unknown in sequential mode' WHERE id = ?"
  ).run(items[2]!.id);

  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.equal(resumeResult.status, 0, `resume must exit 0\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);

  const combined = resumeResult.stdout + resumeResult.stderr;
  assert.ok(
    combined.includes("not ready") || combined.includes("refine"),
    `output must say 'not ready' or 'refine' (readiness wins over dependency)\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes("FG-102"),
    `output must name the readiness-held ticket FG-102\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    !combined.includes("unresolved blocker"),
    `output must NOT say 'unresolved blocker' (dependency branch must not fire over readiness)\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    !combined.includes("run resume again"),
    `output must NOT say 'run resume again' (generic branch must not fire)\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

// ── FG-383: done-audit rendered in forge campaign report ─────────────────────

test("integ FG-383: forge campaign report surfaces done-audit outcome and, for non-pass, gaps + requestedAction", () => {
  // Plan a campaign and set item to shipped, but ticket is still 'active' (not done)
  // → done-audit ticket_closed check fails → output should include done-audit info
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Set item to shipped and campaign to complete
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(planOutput.campaignId);
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ?").all(planOutput.campaignId) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.close();

  const reportResult = runForge(["campaign", "report", planOutput.campaignId]);
  assert.equal(reportResult.status, 0, `report failed\nstdout: ${reportResult.stdout}\nstderr: ${reportResult.stderr}`);

  // done-audit outcome must be present in human output
  assert.ok(
    reportResult.stdout.includes("done-audit"),
    `output must include 'done-audit'\nstdout: ${reportResult.stdout}`
  );

  // Since ticket is active (not done), done-audit is non-pass — gaps and action must appear
  assert.ok(
    reportResult.stdout.includes("audit-gaps") || reportResult.stdout.includes("audit-action"),
    `output must include 'audit-gaps' or 'audit-action' for non-pass audit\nstdout: ${reportResult.stdout}`
  );
});

test("integ FG-383: forge campaign report --json includes doneAuditState field on items", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const reportResult = runForge(["campaign", "report", planOutput.campaignId, "--json"]);
  assert.equal(reportResult.status, 0, `report --json failed\nstdout: ${reportResult.stdout}\nstderr: ${reportResult.stderr}`);

  const output = JSON.parse(reportResult.stdout) as { items: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(output.items), "items must be an array");
  assert.ok(output.items.length > 0, "items must not be empty");
  assert.ok(
    "doneAuditState" in output.items[0]!,
    "each item must have a doneAuditState field in JSON output"
  );
});

// ── FG-419 FIX 1: hostVerificationDetail rendered in human-readable report ────

test("integ FG-419 FIX1: forge campaign report (human) renders host-verification detail in text output", () => {
  gitExec(["init", "-b", "main"], projectDir);
  const realCommit = makeCommitIn(projectDir, "impl-FG-101");

  // Re-write FG-101 with a closedCommit so collectDoneAuditInputFor queries host_verifications
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    body: "",
    closedCommit: realCommit,
  });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  // Write evidence through production's writer, including its proven identity.
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  insertFixtureHostVerification(db, "FG-101", realCommit, "2026-01-01T12:00:00Z");

  // Set item to shipped and campaign to complete
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planOutput.campaignId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(planOutput.campaignId);
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ?").all(planOutput.campaignId) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  db.close();

  const reportResult = runForge(["campaign", "report", planOutput.campaignId]);
  assert.equal(reportResult.status, 0, `report failed\nstdout: ${reportResult.stdout}\nstderr: ${reportResult.stderr}`);

  assert.ok(
    reportResult.stdout.includes("host-verification:"),
    `human-readable output must include 'host-verification:'\nstdout: ${reportResult.stdout}`
  );
  assert.ok(
    reportResult.stdout.includes("npm run test:all"),
    `human-readable output must include the gate/command name\nstdout: ${reportResult.stdout}`
  );
  assert.ok(
    reportResult.stdout.includes("exit_code: 0"),
    `human-readable output must include the exit_code\nstdout: ${reportResult.stdout}`
  );
  assert.ok(
    reportResult.stdout.includes(realCommit.slice(0, 8)),
    `human-readable output must include the commit SHA\nstdout: ${reportResult.stdout}`
  );
  assert.ok(
    reportResult.stdout.includes("recorded_at"),
    `human-readable output must include 'recorded_at'\nstdout: ${reportResult.stdout}`
  );
});

// ── FG-419 FIX 3: non-numeric --exit-code rejected ────────────────────────────

test("integ FG-419 FIX3: record-host-verification rejects non-numeric --exit-code", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-999",
    "--project-dir", projectDir,
    "--commit", "aabbccddeeff00112233445566778899aabbccdd",
    "--command", "npm run test:all",
    "--exit-code", "abc",
  ]);
  assert.notEqual(result.status, 0, "must exit non-zero for non-numeric --exit-code");
  const combined = result.stderr + result.stdout;
  assert.ok(
    combined.includes("integer") || combined.includes("exit-code") || combined.includes("abc"),
    `error output must mention the invalid value\ncombined: ${combined}`
  );
});

// ── FG-428: campaign reconcile ──────────────────────────────────────────────────

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function makeCommitIn(dir: string, label: string): string {
  writeFileSync(join(dir, `${label}.txt`), label);
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", label], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}

// Plans + approves a paused campaign over two fresh tickets: the first ships (all
// durable evidence present), the second refuses (no host verification recorded).
// Returns the campaign id so the caller can invoke `campaign reconcile` exactly
// once against it (a second reconcile of the same campaign would see the first
// item as already-reconciled/not_applicable, not shipped again).
function setupReconcileCliCampaign(eligibleTicketId: string, ineligibleTicketId: string): { campaignId: string } {
  writeTicket(projectDir, { id: eligibleTicketId, type: "story", status: "active", title: "Eligible", body: "" });
  writeTicket(projectDir, { id: ineligibleTicketId, type: "story", status: "active", title: "Ineligible", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", `${eligibleTicketId},${ineligibleTicketId}`,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  const eligibleItem = items.find((i) => i.ticket_id === eligibleTicketId)!;
  const ineligibleItem = items.find((i) => i.ticket_id === ineligibleTicketId)!;

  // Eligible item: scope-blocked with ALL durable evidence present.
  const commit = makeCommitIn(projectDir, `impl-${eligibleTicketId}`);
  closeTicket(projectDir, eligibleTicketId, commit);
  const runId = `run-${eligibleItem.id}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(runId, eligibleItem.id);
  insertFixtureHostVerification(db, eligibleTicketId, commit);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "fail", authority: "authoritative" }), "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "pass", authority: "authoritative" }), "2026-01-01T00:00:01Z");

  // Ineligible item: scope-blocked but with NO host verification recorded → refused.
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'blocked_by_red', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(`run-${ineligibleItem.id}`, ineligibleItem.id);

  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId };
}

test("integ campaign reconcile --json: paused campaign — ships an eligible scope-blocked item, refuses an ineligible one, exits 0", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupReconcileCliCampaign("FG-301", "FG-302");

  const jsonResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(jsonResult.status, 0, `reconcile must exit 0 even with a refused item\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);

  const output = JSON.parse(jsonResult.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(output.ok, true);
  const eligible = output.items.find((i) => i.ticketId === "FG-301")!;
  const ineligible = output.items.find((i) => i.ticketId === "FG-302")!;
  assert.equal(eligible.status, "shipped");
  assert.equal(ineligible.status, "refused");
  assert.ok(ineligible.missing && ineligible.missing.length > 0, "refused item must report missing facts");

  // Verify DB mutation for the shipped item and the audit event.
  const dbPath = join(forgeHome, "forge.db");
  const db2 = new Database(dbPath, { readonly: true });
  const shippedRow = db2
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-301'")
    .get(campaignId) as { lifecycle_status: string; outcome: string; blocker_kind: string | null };
  assert.equal(shippedRow.lifecycle_status, "complete");
  assert.equal(shippedRow.outcome, "shipped");
  assert.equal(shippedRow.blocker_kind, null);

  const refusedRow = db2
    .prepare("SELECT lifecycle_status FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-302'")
    .get(campaignId) as { lifecycle_status: string };
  assert.equal(refusedRow.lifecycle_status, "blocked_by_red", "refused item must be untouched");

  const auditEvent = db2
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.evidence_reconciled'")
    .get() as { payload: string } | undefined;
  assert.ok(auditEvent, "an evidence_reconciled event must be recorded for the shipped item");
  const payload = JSON.parse(auditEvent!.payload) as { decidedBy: string };
  assert.equal(payload.decidedBy, "steve");
  db2.close();
});

test("integ campaign reconcile (human): prints each item's ticketId + status, missing facts for the refused item", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupReconcileCliCampaign("FG-303", "FG-304");

  const humanResult = runForge(["campaign", "reconcile", campaignId]);
  assert.equal(humanResult.status, 0, `stdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(humanResult.stdout.includes("FG-303") && humanResult.stdout.includes("shipped"));
  assert.ok(humanResult.stdout.includes("FG-304") && humanResult.stdout.includes("refused"));
  assert.ok(
    humanResult.stdout.includes("missing:"),
    `refused item must print its missing facts\nstdout: ${humanResult.stdout}`
  );
});

test("integ campaign reconcile: refuses a non-paused campaign, exits non-zero, zero items processed", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  // Campaign is still 'planned' — not paused.

  const result = runForge(["campaign", "reconcile", planOutput.campaignId, "--json"]);
  assert.notEqual(result.status, 0, "reconcile must exit non-zero for a non-paused campaign");

  const output = JSON.parse(result.stdout) as { ok: boolean; items: unknown[] };
  assert.equal(output.ok, false);
  assert.deepEqual(output.items, []);
});

test("integ campaign reconcile: refuses an unknown campaign id, exits non-zero", () => {
  const result = runForge(["campaign", "reconcile", "campaign-does-not-exist"]);
  assert.notEqual(result.status, 0);
  const combined = result.stderr + result.stdout;
  assert.ok(combined.toLowerCase().includes("not found"), `expected a not-found message\ncombined: ${combined}`);
});

test("integ campaign reconcile --help: no --evidence/--force/free-text override option exists", () => {
  const result = runForge(["campaign", "reconcile", "--help"]);
  assert.equal(result.status, 0, `--help must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(!result.stdout.includes("--evidence"), "reconcile must not accept an --evidence override flag");
  assert.ok(!result.stdout.includes("--force"), "reconcile must not accept a --force override flag");
  assert.ok(result.stdout.includes("--json"), "reconcile must accept --json");
  assert.ok(result.stdout.includes("--by"), "reconcile must accept --by for attribution");
});

// Plans + approves a single-item paused campaign with a scope-blocked item carrying
// ALL durable evidence (ships on reconcile). Unlike setupReconcileCliCampaign, there
// is no second item — this isolates the real two-command operator chain (reconcile
// then resume) from any dispatch requirement, since after reconcile there is nothing
// left for resume to drive.
function setupSingleItemReconcileCliCampaign(ticketId: string): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Solo", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketId,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string; ticket_id: string };

  const commit = makeCommitIn(projectDir, `impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  const runId = `run-${item.id}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(runId, item.id);
  insertFixtureHostVerification(db, ticketId, commit);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "fail", authority: "authoritative" }), "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "pass", authority: "authoritative" }), "2026-01-01T00:00:01Z");

  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, itemId: item.id };
}

test("integ campaign reconcile then resume (real CLI-to-CLI chain): reconciled item lets the campaign actually complete", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupSingleItemReconcileCliCampaign("FG-310");

  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(reconcileOutput.items[0]?.status, "shipped");

  // The operator's next real command, spawned as an entirely separate process against
  // the same on-disk forge.db — proves the reconciled state actually persists and is
  // honored by a fresh `resume` invocation, not just by re-reading in-process state.
  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as { stopReason: string; itemRecords: { ticketId: string; lifecycleStatus: string; outcome?: string }[] };
  assert.equal(resumeOutput.stopReason, "complete", "campaign must reach 'complete' once its only blocker was reconciled");

  const dbPath = join(forgeHome, "forge.db");
  const db2 = new Database(dbPath, { readonly: true });
  const finalCampaign = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId) as { status: string };
  assert.equal(finalCampaign.status, "complete");
  const finalItem = db2
    .prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-310'")
    .get(campaignId) as { lifecycle_status: string; outcome: string };
  assert.equal(finalItem.lifecycle_status, "complete");
  assert.equal(finalItem.outcome, "shipped");
  db2.close();
});

test("integ campaign reconcile is idempotent under re-run: second invocation reports not_applicable, logs zero additional audit events", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupSingleItemReconcileCliCampaign("FG-311");

  const first = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(first.status, 0);
  const firstOutput = JSON.parse(first.stdout) as { items: { ticketId: string; status: string }[] };
  assert.equal(firstOutput.items[0]?.status, "shipped");

  const dbPath = join(forgeHome, "forge.db");
  const dbAfterFirst = new Database(dbPath, { readonly: true });
  const eventsAfterFirst = (
    dbAfterFirst.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.evidence_reconciled'").get() as { n: number }
  ).n;
  assert.equal(eventsAfterFirst, 1);
  dbAfterFirst.close();

  // Operator accidentally (or deliberately, to double-check) re-runs reconcile against
  // the same already-shipped campaign. The item is no longer blockerKind='scope', so it
  // must be reported not_applicable and left untouched — no re-shipping, no duplicate audit event.
  const second = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(second.status, 0, `second reconcile must still exit 0\nstdout: ${second.stdout}\nstderr: ${second.stderr}`);
  const secondOutput = JSON.parse(second.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(secondOutput.ok, true);
  assert.equal(secondOutput.items[0]?.status, "not_applicable", "an already-shipped item must not be re-evaluated as scope-blocked");

  const dbAfterSecond = new Database(dbPath, { readonly: true });
  const eventsAfterSecond = (
    dbAfterSecond.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.evidence_reconciled'").get() as { n: number }
  ).n;
  assert.equal(eventsAfterSecond, 1, "re-running reconcile on an already-shipped item must not log a second audit event");
  dbAfterSecond.close();
});

test("integ campaign show --json (real CLI, after reconcile): reflects the reconciled item as shipped with no blocker, and surfaces the audit trail", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupSingleItemReconcileCliCampaign("FG-312");

  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0);

  // The operator's normal read-only inspection command must reflect the reconciliation —
  // a shipped item with its blocker cleared — through the same path used for every other
  // campaign item, not a special-cased reconcile-only view.
  const showResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(showResult.status, 0, `show failed\nstdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);
  const showOutput = JSON.parse(showResult.stdout) as {
    items: { ticketId: string; lifecycleStatus: string; outcome: string | null; blockerKind: string | null }[];
  };
  const item = showOutput.items.find((i) => i.ticketId === "FG-312")!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
  assert.equal(item.blockerKind, null, "blocker must be cleared once reconciled");
});

// ── FG-443: campaign reconcile — out-of-band (awaiting_gate/non-pipeline) completion path ──
//
// Real CLI-subprocess coverage for the branch reconcile.ts added alongside the existing
// scope-blocked path above: an item parked at lifecycle_status='awaiting_gate' with no
// blocker_kind (the ONLY shape executor.ts's gate:human path produces — e.g. an item
// re-routed to a non-pipeline lane whose ticket shipped outside the feature run). The
// unit/direct-import tests for this path already live in reconcile.integration.test.ts
// and report.integration.test.ts; these tests prove the same behavior holds through the actual
// `forge campaign reconcile|show|report` commands, spawned as real child processes
// against the on-disk forge.db — the operator's actual interface.

function commitFileIn(dir: string, relPath: string, content: string, message: string): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", message], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}

// Plans + approves a single-item paused campaign whose item is forced into the ONLY
// shape executor.ts's gate:human path produces: lifecycle_status='awaiting_gate' with
// no blocker_kind. Distinct from setupReconcileCliCampaign/setupSingleItemReconcileCliCampaign
// above, which always set blocker_kind='scope' — that field's absence is exactly what
// routes an item to FG-443's out-of-band branch instead of the FG-428 scope-blocked one.
function setupOutOfBandCliCampaign(ticketId: string): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Out of band", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketId,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string };

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required at step review' WHERE id = ?"
  ).run(item.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, itemId: item.id };
}

test("integ campaign reconcile --json (out-of-band): ships an awaiting_gate item delivered via a docs-only commit, then a real `resume` invocation reaches complete", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-600");
  makeCommitIn(projectDir, "base-FG-600");
  const commit = commitFileIn(projectDir, "docs/FG-600.md", "docs delivering FG-600 out of band", "docs: FG-600");
  closeTicket(projectDir, "FG-600", commit);

  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(reconcileOutput.ok, true);
  assert.equal(reconcileOutput.items[0]?.status, "shipped");

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const itemRow = db
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-600'")
    .get(campaignId) as { lifecycle_status: string; outcome: string; blocker_kind: string | null };
  assert.equal(itemRow.lifecycle_status, "complete");
  assert.equal(itemRow.outcome, "shipped");
  assert.equal(itemRow.blocker_kind, null);

  const auditEvent = db
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.out_of_band_reconciled'")
    .get() as { payload: string } | undefined;
  assert.ok(auditEvent, "an out_of_band_reconciled event must be recorded for the shipped item");
  const payload = JSON.parse(auditEvent!.payload) as { decidedBy: string; ticketId: string };
  assert.equal(payload.decidedBy, "steve");
  assert.equal(payload.ticketId, "FG-600");
  db.close();

  // The operator's next real command, spawned as an entirely separate process against
  // the same on-disk forge.db — proves the campaign actually reaches 'complete' through
  // the real reconcile-then-resume operator chain, not just direct-import behavior.
  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as { stopReason: string };
  assert.equal(resumeOutput.stopReason, "complete", "campaign must reach 'complete' once its out-of-band item is reconciled");

  const db2 = new Database(dbPath, { readonly: true });
  const finalCampaign = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId) as { status: string };
  assert.equal(finalCampaign.status, "complete");
  db2.close();
});

test("integ campaign reconcile --json (out-of-band): refuses when the ticket is not closed — exits 0, zero mutation, no state written", () => {
  const { campaignId, itemId } = setupOutOfBandCliCampaign("FG-601");
  // ticket stays 'active' — never closed, so closedCommit is absent.

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = dbBefore.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  const eventsBefore = (dbBefore.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
  dbBefore.close();

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0, "reconcile must exit 0 even when the only item is refused");
  const output = JSON.parse(result.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(output.ok, true);
  assert.equal(output.items[0]?.status, "refused");
  assert.ok(output.items[0]?.missing?.includes("ticket_status_not_done"));
  assert.ok(output.items[0]?.missing?.includes("ticket_closed_commit_missing"));

  const dbAfter = new Database(dbPath, { readonly: true });
  const after = dbAfter.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  const eventsAfter = (dbAfter.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
  dbAfter.close();
  assert.deepEqual(after, before, "campaign_items row must be byte-identical after a refusal");
  assert.equal(eventsAfter, eventsBefore, "no event row written on refusal");
});

test("integ campaign reconcile --json (out-of-band): refuses when the closed commit is not reachable on the base branch — zero mutation", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId, itemId } = setupOutOfBandCliCampaign("FG-602");
  // Base commit AFTER the ticket file is written so it lands on 'main' and survives
  // the branch switch back below — otherwise the ticket file (untracked until
  // committed) would only exist on the feature branch and disappear on checkout.
  makeCommitIn(projectDir, "base-FG-602");
  gitExec(["checkout", "-b", "feature/off-main-602"], projectDir);
  const offMainCommit = commitFileIn(projectDir, "docs/FG-602.md", "docs off main", "docs off main");
  gitExec(["checkout", "main"], projectDir);
  closeTicket(projectDir, "FG-602", offMainCommit);

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = dbBefore.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbBefore.close();

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout) as { items: { status: string; missing?: string[] }[] };
  assert.equal(output.items[0]?.status, "refused");
  assert.deepEqual(output.items[0]?.missing, ["closed_commit_not_reachable_on_base_branch"]);

  const dbAfter = new Database(dbPath, { readonly: true });
  const after = dbAfter.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbAfter.close();
  assert.deepEqual(after, before, "campaign_items row must be byte-identical after a refusal");
});

test("integ campaign reconcile --json (out-of-band): refuses when the closing commit touches code and no host verification is recorded — zero mutation", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId, itemId } = setupOutOfBandCliCampaign("FG-603");
  makeCommitIn(projectDir, "base-FG-603");
  const commit = commitFileIn(projectDir, "src/FG-603.ts", "export const x = 1;\n", "feat: FG-603");
  closeTicket(projectDir, "FG-603", commit);
  // Deliberately no host_verifications row inserted for this commit.

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = dbBefore.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbBefore.close();

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout) as { items: { status: string; missing?: string[] }[] };
  assert.equal(output.items[0]?.status, "refused");
  assert.deepEqual(output.items[0]?.missing, ["lane_evidence_missing"]);

  const dbAfter = new Database(dbPath, { readonly: true });
  const after = dbAfter.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbAfter.close();
  assert.deepEqual(after, before, "campaign_items row must be byte-identical after a refusal");
});

test("integ campaign reconcile (human, out-of-band): prints the out-of-band item's ticketId and shipped status", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-604");
  makeCommitIn(projectDir, "base-FG-604");
  const commit = commitFileIn(projectDir, "docs/FG-604.md", "docs", "docs: FG-604");
  closeTicket(projectDir, "FG-604", commit);

  const result = runForge(["campaign", "reconcile", campaignId]);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("FG-604") && result.stdout.includes("shipped"), `stdout: ${result.stdout}`);
});

test("integ campaign show (JSON + human, out-of-band): awaiting_gate item delivered out-of-band names the completable path explicitly, not the generic gate text", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-605");
  makeCommitIn(projectDir, "base-FG-605");
  const commit = commitFileIn(projectDir, "docs/FG-605.md", "docs delivering FG-605", "docs: FG-605");
  closeTicket(projectDir, "FG-605", commit);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { nextAction: string };
  assert.ok(jsonOutput.nextAction.includes("delivered out-of-band"), `nextAction: ${jsonOutput.nextAction}`);
  assert.ok(jsonOutput.nextAction.includes("FG-605"));
  assert.notEqual(jsonOutput.nextAction, "Human gate required at step review");

  // Same distinction must reach the human-readable operator surface, not only JSON.
  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    humanResult.stdout.includes("Next action:") && humanResult.stdout.includes("delivered out-of-band"),
    `human-readable output must name the out-of-band completable path\nstdout: ${humanResult.stdout}`
  );
});

test("integ campaign report (JSON + human, out-of-band): awaiting_gate item delivered out-of-band names the completable path explicitly, not the generic gate text", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-606");
  makeCommitIn(projectDir, "base-FG-606");
  const commit = commitFileIn(projectDir, "docs/FG-606.md", "docs delivering FG-606", "docs: FG-606");
  closeTicket(projectDir, "FG-606", commit);

  const jsonResult = runForge(["campaign", "report", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `report --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { nextOperatorAction: string };
  assert.ok(jsonOutput.nextOperatorAction.includes("delivered out-of-band"), `nextOperatorAction: ${jsonOutput.nextOperatorAction}`);
  assert.notEqual(jsonOutput.nextOperatorAction, "Human gate required at step review");

  const humanResult = runForge(["campaign", "report", campaignId]);
  assert.equal(humanResult.status, 0, `report (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    humanResult.stdout.includes("Next operator action:") && humanResult.stdout.includes("delivered out-of-band"),
    `human-readable operator surface must name the out-of-band completable path, not only JSON\nstdout: ${humanResult.stdout}`
  );
});

test("integ campaign show (human): a genuinely unfinished gate (ticket not yet closed) still falls back to the generic gate action text", () => {
  const { campaignId } = setupOutOfBandCliCampaign("FG-607");
  // ticket left 'active' — never closed — this is a genuine unfinished gate, not an
  // out-of-band-completable one.

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `stdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    humanResult.stdout.includes("Human gate required at step review"),
    `must fall back to the generic gate text for a genuinely unfinished gate\nstdout: ${humanResult.stdout}`
  );
  assert.ok(!humanResult.stdout.includes("delivered out-of-band"), `must not claim out-of-band eligibility\nstdout: ${humanResult.stdout}`);
});

// Multi-ticket counterpart to setupOutOfBandCliCampaign above: plans and parks
// EVERY item at the out-of-band shape (lifecycle_status='awaiting_gate', no
// blocker_kind), so a test can deliver some or all of them out-of-band and
// assert per-item surfacing (FG-444) rather than just the first.
function setupOutOfBandCliCampaignMulti(ticketIds: string[]): { campaignId: string } {
  for (const ticketId of ticketIds) {
    writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Out of band", body: "" });
  }

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketIds.join(","),
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  for (const item of items) {
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required at step review' WHERE id = ?"
    ).run(item.id);
  }
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId };
}

test("FG-444 integ campaign show (JSON + human): TWO concurrently-parked awaiting_gate items both delivered out-of-band → both surfaced per-item, Next action line still singular", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaignMulti(["FG-610", "FG-611"]);
  makeCommitIn(projectDir, "base-FG-610-611");
  const commit610 = commitFileIn(projectDir, "docs/FG-610.md", "docs delivering FG-610", "docs: FG-610");
  closeTicket(projectDir, "FG-610", commit610);
  const commit611 = commitFileIn(projectDir, "docs/FG-611.md", "docs delivering FG-611", "docs: FG-611");
  closeTicket(projectDir, "FG-611", commit611);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    nextAction: string;
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const row610 = jsonOutput.items.find((i) => i.ticketId === "FG-610")!;
  const row611 = jsonOutput.items.find((i) => i.ticketId === "FG-611")!;
  assert.equal(row610.outOfBandEligible, true, "FG-610 must be marked out-of-band-eligible");
  assert.equal(row611.outOfBandEligible, true, "FG-611 must be marked out-of-band-eligible");
  assert.ok(jsonOutput.nextAction.includes("FG-610 delivered out-of-band"), `nextAction: ${jsonOutput.nextAction}`);
  assert.ok(!jsonOutput.nextAction.includes("FG-611"), "Next action must remain a single recommendation, not multiplied per item");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  const eligibleLines = humanResult.stdout.split("\n").filter((l) => l.includes("out-of-band-eligible:"));
  assert.equal(eligibleLines.length, 2, `expected one out-of-band-eligible line per eligible item\nstdout: ${humanResult.stdout}`);
  assert.ok(eligibleLines.some((l) => l.includes("FG-610")));
  assert.ok(eligibleLines.some((l) => l.includes("FG-611")));
});

// FG-444 hardening: THREE concurrently-parked items of genuinely MIXED shape —
// one out-of-band-eligible, one parked-but-ineligible (ticket never closed),
// and one blocked_by_red (not even the out-of-band awaiting_gate shape at all,
// since lifecycleStatus !== 'awaiting_gate' short-circuits outOfBandCompletable-
// Action to null regardless of blockerKind). Exercises show, report, AND a real
// `campaign reconcile` run against the SAME campaign state to prove the display
// flag never diverges from what reconcile itself would actually do (the AC's
// no-divergence requirement) — reconcile routes 'blocked_by_red' items through
// its isScopeBlocked/isOutOfBand branch selection the exact same way
// outOfBandCompletableAction's lifecycleStatus check does, so a real reconcile
// run is the strongest possible confirmation the two surfaces agree.
test("FG-444 integ: THREE concurrently-parked items of mixed eligibility — show/report agree exactly, Next action line stays singular, and reconcile ships/refuses/skips in lockstep with the displayed flag", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaignMulti(["FG-620", "FG-621", "FG-622"]);
  makeCommitIn(projectDir, "base-FG-620-621-622");

  // FG-620: eligible — closed with a docs-only (non_code_diff lane) commit, so
  // no host-verification capture is even needed for eligibility.
  const commit620 = commitFileIn(projectDir, "docs/FG-620.md", "docs delivering FG-620", "docs: FG-620");
  closeTicket(projectDir, "FG-620", commit620);

  // FG-621: stays 'active' — never closed. Still awaiting_gate/no blockerKind
  // (the right SHAPE for out-of-band), but missing the durable evidence
  // (ticket_status_not_done + ticket_closed_commit_missing) → ineligible.

  // FG-622: re-parked as blocked_by_red — a genuinely different concurrently-
  // parked state, not the awaiting_gate shape at all.
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const row622 = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? AND ticket_id = ?")
    .get(campaignId, "FG-622") as { id: string };
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'blocked_by_red', outcome = 'blocked', blocker_kind = NULL WHERE id = ?"
  ).run(row622.id);
  db.close();

  // ── show: JSON ──
  const showJson = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(showJson.status, 0, `show --json failed\nstdout: ${showJson.stdout}\nstderr: ${showJson.stderr}`);
  const showOutput = JSON.parse(showJson.stdout) as {
    nextAction: string;
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const showEligibility = new Map(showOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));
  assert.equal(showEligibility.get("FG-620"), true, "FG-620 (closed, docs-only) must be eligible");
  assert.equal(showEligibility.get("FG-621"), false, "FG-621 (never closed) must NOT be eligible");
  assert.equal(showEligibility.get("FG-622"), false, "FG-622 (blocked_by_red) must NOT be eligible");
  assert.ok(showOutput.nextAction.includes("FG-620 delivered out-of-band"), `nextAction: ${showOutput.nextAction}`);
  assert.ok(!showOutput.nextAction.includes("FG-621"), "Next action must not multiply to name the ineligible item");
  assert.ok(!showOutput.nextAction.includes("FG-622"), "Next action must not multiply to name the blocked_by_red item");

  // ── show: human ──
  const showHuman = runForge(["campaign", "show", campaignId]);
  assert.equal(showHuman.status, 0, `show (human) failed\nstdout: ${showHuman.stdout}\nstderr: ${showHuman.stderr}`);
  const showEligibleLines = showHuman.stdout.split("\n").filter((l) => l.includes("out-of-band-eligible:"));
  assert.equal(showEligibleLines.length, 1, `expected exactly one eligible line (FG-620 only)\nstdout: ${showHuman.stdout}`);
  assert.ok(showEligibleLines[0]!.includes("FG-620"));
  const showNextActionLines = showHuman.stdout.split("\n").filter((l) => l.startsWith("Next action:"));
  assert.equal(showNextActionLines.length, 1, "Next action must render as exactly one line");
  assert.ok(showNextActionLines[0]!.includes("FG-620 delivered out-of-band"));

  // ── report: JSON ──
  const reportJson = runForge(["campaign", "report", campaignId, "--json"]);
  assert.equal(reportJson.status, 0, `report --json failed\nstdout: ${reportJson.stdout}\nstderr: ${reportJson.stderr}`);
  const reportOutput = JSON.parse(reportJson.stdout) as {
    nextOperatorAction: string;
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const reportEligibility = new Map(reportOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));
  assert.ok(reportOutput.nextOperatorAction.includes("FG-620 delivered out-of-band"), `nextOperatorAction: ${reportOutput.nextOperatorAction}`);
  assert.ok(!reportOutput.nextOperatorAction.includes("FG-621"));
  assert.ok(!reportOutput.nextOperatorAction.includes("FG-622"));

  // report and show must agree EXACTLY, per item — no divergence between the surfaces.
  for (const ticketId of ["FG-620", "FG-621", "FG-622"]) {
    assert.equal(
      reportEligibility.get(ticketId),
      showEligibility.get(ticketId),
      `report/show must agree on outOfBandEligible for ${ticketId}`
    );
  }

  // ── report: human ──
  const reportHuman = runForge(["campaign", "report", campaignId]);
  assert.equal(reportHuman.status, 0, `report (human) failed\nstdout: ${reportHuman.stdout}\nstderr: ${reportHuman.stderr}`);
  const reportEligibleLines = reportHuman.stdout.split("\n").filter((l) => l.includes("out-of-band-eligible:"));
  assert.equal(reportEligibleLines.length, 1, `expected exactly one eligible line (FG-620 only)\nstdout: ${reportHuman.stdout}`);
  assert.ok(reportEligibleLines[0]!.includes("FG-620"));
  const reportNextActionLines = reportHuman.stdout.split("\n").filter((l) => l.startsWith("Next operator action:"));
  assert.equal(reportNextActionLines.length, 1, "Next operator action must render as exactly one line");

  // ── no-divergence: what does a REAL `campaign reconcile` do with this exact
  // state? It must ship the item the display marked eligible, refuse the
  // ineligible-but-right-shape item, and treat the blocked_by_red item as
  // not_applicable (neither isScopeBlocked [blockerKind !== 'scope'] nor
  // isOutOfBand [lifecycleStatus !== 'awaiting_gate']) — the exact same verdict
  // the outOfBandEligible flag predicted for every item, by construction. ──
  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(reconcileOutput.ok, true);
  const reconcileStatus = new Map(reconcileOutput.items.map((i) => [i.ticketId, i]));
  assert.equal(reconcileStatus.get("FG-620")!.status, "shipped", "reconcile must ship the item the display marked eligible");
  assert.equal(reconcileStatus.get("FG-621")!.status, "refused", "reconcile must refuse the item the display marked ineligible");
  assert.ok(
    reconcileStatus.get("FG-621")!.missing && reconcileStatus.get("FG-621")!.missing!.length > 0,
    "refused item must report missing evidence facts"
  );
  assert.equal(
    reconcileStatus.get("FG-622")!.status,
    "not_applicable",
    "reconcile must treat the blocked_by_red item as not_applicable, matching its non-out-of-band shape"
  );
});

// FG-502 finding 3: `forge campaign report` (human) already prints a per-item
// `campaign-system-recoverable:` line from item.campaignSystemEligible (see
// report.ts's renderCampaignReportHuman), but `forge campaign show` (human)
// had no analogous line — only out-of-band-eligible — so the operator-facing
// text surfaces stayed silent for a failed/campaign_system item even though
// show's own JSON already carries campaignSystemEligible. Mirrors the
// out-of-band-eligible CLI tests above (setupOutOfBandCliCampaign /
// FG-444), but for the failed/blockerKind='campaign_system' shape.
// lifecycleStatus defaults to 'failed' (the three reconcileTerminalOutcome
// producers); pass 'blocked_by_red' for FG-502's fourth producer —
// driveWorkflowItem's inconclusive-verdict park.
function setupCampaignSystemCliCampaign(
  ticketId: string,
  lifecycleStatus: "failed" | "blocked_by_red" = "failed"
): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Campaign system recoverable", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketId,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string };

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = ?, outcome = 'blocked', blocker_kind = 'campaign_system', requested_human_action = 'workflow completed but no authoritative reviewer verdicts found — check workflow reds configuration' WHERE id = ?"
  ).run(lifecycleStatus, item.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, itemId: item.id };
}

test("FG-502 integ campaign show (human): a failed/campaign_system item with full out-of-band evidence prints a campaign-system-recoverable line, matching report's human output", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupCampaignSystemCliCampaign("FG-630");
  makeCommitIn(projectDir, "base-FG-630");
  const commit = commitFileIn(projectDir, "docs/FG-630.md", "docs delivering FG-630", "docs: FG-630");
  closeTicket(projectDir, "FG-630", commit);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    items: { ticketId: string; campaignSystemEligible: boolean }[];
  };
  const row630 = jsonOutput.items.find((i) => i.ticketId === "FG-630")!;
  assert.equal(row630.campaignSystemEligible, true, "FG-630 must be marked campaign-system-recoverable");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  const recoverableLines = humanResult.stdout.split("\n").filter((l) => l.includes("campaign-system-recoverable:"));
  assert.equal(recoverableLines.length, 1, `expected exactly one campaign-system-recoverable line\nstdout: ${humanResult.stdout}`);
  assert.ok(recoverableLines[0]!.includes("FG-630"));

  // report's human output already carries the same line (pre-FG-502) — show must agree.
  const reportHuman = runForge(["campaign", "report", campaignId]);
  assert.equal(reportHuman.status, 0, `report (human) failed\nstdout: ${reportHuman.stdout}\nstderr: ${reportHuman.stderr}`);
  assert.ok(reportHuman.stdout.includes("campaign-system-recoverable:"), `expected report to also print the line\nstdout: ${reportHuman.stdout}`);
});

test("FG-502 integ campaign show (human): a failed/campaign_system item that is NOT eligible (ticket never closed) prints no campaign-system-recoverable line", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupCampaignSystemCliCampaign("FG-631");
  makeCommitIn(projectDir, "base-FG-631");
  // FG-631 stays 'active' — never closed, so out-of-band evidence can never be satisfied.

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    items: { ticketId: string; campaignSystemEligible: boolean }[];
  };
  const row631 = jsonOutput.items.find((i) => i.ticketId === "FG-631")!;
  assert.equal(row631.campaignSystemEligible, false, "FG-631 (never closed) must NOT be marked campaign-system-recoverable");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    !humanResult.stdout.includes("campaign-system-recoverable:"),
    `ineligible item must print no campaign-system-recoverable line\nstdout: ${humanResult.stdout}`
  );
});

// FG-502 round-2: same CLI human-text coverage as the failed/campaign_system
// case above, but for the blocked_by_red shape (the fourth producer —
// driveWorkflowItem's inconclusive-verdict park).
test("FG-502 integ campaign show (human): a blocked_by_red/campaign_system item with full out-of-band evidence prints a campaign-system-recoverable line, matching report's human output", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupCampaignSystemCliCampaign("FG-632", "blocked_by_red");
  makeCommitIn(projectDir, "base-FG-632");
  const commit = commitFileIn(projectDir, "docs/FG-632.md", "docs delivering FG-632", "docs: FG-632");
  closeTicket(projectDir, "FG-632", commit);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    items: { ticketId: string; campaignSystemEligible: boolean }[];
  };
  const row632 = jsonOutput.items.find((i) => i.ticketId === "FG-632")!;
  assert.equal(row632.campaignSystemEligible, true, "FG-632 (blocked_by_red) must be marked campaign-system-recoverable");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  const recoverableLines = humanResult.stdout.split("\n").filter((l) => l.includes("campaign-system-recoverable:"));
  assert.equal(recoverableLines.length, 1, `expected exactly one campaign-system-recoverable line\nstdout: ${humanResult.stdout}`);
  assert.ok(recoverableLines[0]!.includes("FG-632"));

  const reportHuman = runForge(["campaign", "report", campaignId]);
  assert.equal(reportHuman.status, 0, `report (human) failed\nstdout: ${reportHuman.stdout}\nstderr: ${reportHuman.stderr}`);
  assert.ok(reportHuman.stdout.includes("campaign-system-recoverable:"), `expected report to also print the line\nstdout: ${reportHuman.stdout}`);
});

// ── FG-473: invoke-lane out-of-band items (runId, zero authoritative verdicts) ──
//
// Real CLI-subprocess coverage for the FG-473 fix: `no_authoritative_verdict_
// or_force_advance_event` was removed from AUTHORITATIVE_OUTCOME_MISSING_CODES,
// so an out-of-band item WITH a runId (the FG-441/FG-458 manually-driven
// awaiting_gate shape — see setupOutOfBandCliCampaignMultiWithRunId below)
// whose run produced ZERO authoritative verdicts (the invoke-lane shape:
// engineer + test-engineer only, no red-team step) now SHIPS on lane evidence
// alone, while a run that DID produce an unresolved authoritative fail or
// inconclusive verdict must still refuse (FG-458 preserved). This proves the
// enforcement half through the real operator entrypoint, not just the happy
// path, and that show/report's outOfBandEligible flag never diverges from what
// a real `campaign reconcile` does (FG-444 no-divergence) for this new case.

// Multi-ticket variant of setupOutOfBandCliCampaign that ALSO stamps a runId
// on every item (the FG-441 manually-driven shape) so callers can attach
// authoritative-verdict events per ticket via runIdFor.
function setupOutOfBandCliCampaignMultiWithRunId(ticketIds: string[]): { campaignId: string; runIdFor: Map<string, string> } {
  for (const ticketId of ticketIds) {
    writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Out of band", body: "" });
  }

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketIds.join(","),
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  const runIdFor = new Map<string, string>();
  for (const item of items) {
    const runId = `run-${item.id}`;
    runIdFor.set(item.ticket_id, runId);
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, run_id = ?, requested_human_action = 'Human gate required at step review' WHERE id = ?"
    ).run(runId, item.id);
  }
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, runIdFor };
}

test("FG-473 integ: invoke-lane out-of-band items (runId, manually-driven awaiting_gate shape) — zero-verdict SHIPS, unresolved FAIL and INCONCLUSIVE still REFUSE; show/report outOfBandEligible agrees with a real `campaign reconcile` for all three", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId, runIdFor } = setupOutOfBandCliCampaignMultiWithRunId(["FG-700", "FG-701", "FG-702"]);
  makeCommitIn(projectDir, "base-FG-700-701-702");

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);

  // FG-700: invoke-lane shape — closed, code-touching commit, passing
  // host-verification, and ZERO events on its run. Must SHIP.
  const commit700 = commitFileIn(projectDir, "src/FG-700.ts", "export const x700 = 1;\n", "feat: FG-700");
  closeTicket(projectDir, "FG-700", commit700);
  insertFixtureHostVerification(db, "FG-700", commit700);

  // FG-701: SAME lane evidence, but the run carries an unresolved authoritative
  // FAIL. Must still REFUSE (FG-458 preserved).
  const commit701 = commitFileIn(projectDir, "src/FG-701.ts", "export const x701 = 1;\n", "feat: FG-701");
  closeTicket(projectDir, "FG-701", commit701);
  insertFixtureHostVerification(db, "FG-701", commit701);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(
    runIdFor.get("FG-701"),
    "verdict.received",
    JSON.stringify({ redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" }),
    "2026-01-01T00:00:00Z"
  );

  // FG-702: SAME lane evidence, but the latest authoritative verdict is
  // INCONCLUSIVE. Must still REFUSE.
  const commit702 = commitFileIn(projectDir, "src/FG-702.ts", "export const x702 = 1;\n", "feat: FG-702");
  closeTicket(projectDir, "FG-702", commit702);
  insertFixtureHostVerification(db, "FG-702", commit702);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(
    runIdFor.get("FG-702"),
    "verdict.received",
    JSON.stringify({ redRole: "shipping-reviewer", verdict: "inconclusive", authority: "authoritative" }),
    "2026-01-01T00:00:00Z"
  );
  db.close();

  // ── show: JSON ──
  const showJson = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(showJson.status, 0, `show --json failed\nstdout: ${showJson.stdout}\nstderr: ${showJson.stderr}`);
  const showOutput = JSON.parse(showJson.stdout) as {
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const showEligibility = new Map(showOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));
  assert.equal(showEligibility.get("FG-700"), true, "FG-700 (zero authoritative verdicts) must be eligible");
  assert.equal(showEligibility.get("FG-701"), false, "FG-701 (unresolved authoritative FAIL) must NOT be eligible");
  assert.equal(showEligibility.get("FG-702"), false, "FG-702 (unresolved authoritative INCONCLUSIVE) must NOT be eligible");

  // ── report: JSON ──
  const reportJson = runForge(["campaign", "report", campaignId, "--json"]);
  assert.equal(reportJson.status, 0, `report --json failed\nstdout: ${reportJson.stdout}\nstderr: ${reportJson.stderr}`);
  const reportOutput = JSON.parse(reportJson.stdout) as {
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const reportEligibility = new Map(reportOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));

  // report and show must agree EXACTLY, per item — no divergence between the surfaces.
  for (const ticketId of ["FG-700", "FG-701", "FG-702"]) {
    assert.equal(
      reportEligibility.get(ticketId),
      showEligibility.get(ticketId),
      `report/show must agree on outOfBandEligible for ${ticketId}`
    );
  }

  // ── no-divergence: a real `campaign reconcile` must ship/refuse in lockstep
  // with the displayed flag, for all three items. ──
  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(reconcileOutput.ok, true);
  const reconcileStatus = new Map(reconcileOutput.items.map((i) => [i.ticketId, i]));
  assert.equal(
    reconcileStatus.get("FG-700")!.status,
    "shipped",
    "reconcile must ship the zero-verdict invoke-lane item the display marked eligible"
  );
  assert.equal(
    reconcileStatus.get("FG-701")!.status,
    "refused",
    "reconcile must refuse the unresolved-FAIL item the display marked ineligible"
  );
  assert.ok(
    reconcileStatus.get("FG-701")!.missing?.includes(
      "run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"
    ),
    `expected the run_evidence: fail code, got: ${reconcileStatus.get("FG-701")!.missing?.join(", ")}`
  );
  assert.equal(
    reconcileStatus.get("FG-702")!.status,
    "refused",
    "reconcile must refuse the unresolved-INCONCLUSIVE item the display marked ineligible"
  );
  assert.ok(
    reconcileStatus.get("FG-702")!.missing?.includes(
      "run_evidence:latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance"
    ),
    `expected the run_evidence: inconclusive code, got: ${reconcileStatus.get("FG-702")!.missing?.join(", ")}`
  );

  // Zero mutation / no state written for the two refused items.
  const dbAfter = new Database(dbPath, { readonly: true });
  const item701 = dbAfter
    .prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-701'")
    .get(campaignId) as { lifecycle_status: string; outcome: string | null };
  assert.equal(item701.lifecycle_status, "awaiting_gate", "FG-701 must not be shipped — stays parked");
  assert.notEqual(item701.outcome, "shipped");
  const item702 = dbAfter
    .prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-702'")
    .get(campaignId) as { lifecycle_status: string; outcome: string | null };
  assert.equal(item702.lifecycle_status, "awaiting_gate", "FG-702 must not be shipped — stays parked");
  assert.notEqual(item702.outcome, "shipped");
  dbAfter.close();
});

// ── FG-440: automatic host-verification capture — real CLI-subprocess coverage ──
//
// Everything above exercises reconcileCampaign()/collectReconcileEvidence() as
// directly-imported functions (reconcile.integration.test.ts) or the CLI with a
// PRE-SEEDED host_verifications row (setupReconcileCliCampaign above). Neither
// proves the actual operator entrypoint — `forge campaign reconcile`, spawned as
// a real child process — performs the REAL gate run itself: writes package.json
// into the real (temp) projectDir, spawns `forge campaign reconcile` as a
// separate process, and lets it invoke `npm run test:all` for real. This is the
// FG-440 anti-spoofing proof end-to-end, not just at the function seam. It also
// proves the two-way reason-code split (host_verification_not_recorded vs
// host_verification_recorded_but_failed) renders correctly on both the raw JSON
// path (campaign.ts's `--json` branch, which must NOT run codes through
// describeMissingReason) and the human path (which must).

function commitGateScriptIn(dir: string, label: string, scriptBody: string): string {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.0.0", scripts: { "test:all": scriptBody } }, null, 2)
  );
  writeFileSync(join(dir, `${label}.txt`), label);
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", label], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}

function commitPendingChangesIn(dir: string, message: string): string {
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", message], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}

// Plans + approves a single-item paused campaign whose item is scope-blocked with
// the fact-5 supersession events present (fail then authoritative pass) but
// DELIBERATELY no host_verifications row — the precondition for FG-440's
// automatic capture to fire on the next `campaign reconcile` invocation.
function setupHostGateCaptureCliCampaign(ticketId: string): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Capture", body: "" });

  const planResult = runForge(["campaign", "plan", "--tickets", ticketId, "--project", projectDir, "--json"]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string };
  const runId = `run-${item.id}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(runId, item.id);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "fail", authority: "authoritative" }), "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "pass", authority: "authoritative" }), "2026-01-01T00:00:01Z");
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, itemId: item.id };
}

test("integ campaign reconcile --json (FG-440): a real `npm run test:all` PASS is captured automatically — writes a real host_verifications row and ships the item, all within one CLI invocation", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupHostGateCaptureCliCampaign("FG-620");
  const closedCommit = commitGateScriptIn(projectDir, "impl-FG-620", "exit 0");
  closeTicket(projectDir, "FG-620", closedCommit);
  const testedHead = commitPendingChangesIn(projectDir, "close FG-620");

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = (
    dbBefore.prepare("SELECT COUNT(*) as n FROM host_verifications WHERE ticket_id = ?").get("FG-620") as { n: number }
  ).n;
  dbBefore.close();
  assert.equal(before, 0, "precondition: no host_verifications row exists before reconcile runs");

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0, `reconcile failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(output.ok, true);
  assert.equal(output.items[0]?.status, "shipped", "the real gate ran and passed within this same reconcile call");

  const db2 = new Database(dbPath, { readonly: true });
  const rows = db2
    .prepare("SELECT exit_code, gate_name, command, commit_sha FROM host_verifications WHERE ticket_id = ?")
    .all("FG-620") as { exit_code: number; gate_name: string; command: string; commit_sha: string }[];
  db2.close();
  assert.equal(rows.length, 1, "exactly one real row written by the actual `npm run test:all` invocation");
  assert.equal(rows[0]!.exit_code, 0);
  assert.equal(rows[0]!.gate_name, "npm run test:all", "gate_name is the configured requiredHostGate string, never the executed argv");
  assert.equal(rows[0]!.command, "npm run test:all");
  assert.equal(rows[0]!.commit_sha, testedHead, "recorded commit_sha is the real tested HEAD, not closedCommit");
});

test("integ campaign reconcile --json (FG-440): a real `npm run test:all` FAILURE is captured with its actual exit code — item stays refused with the distinct 'recorded_but_failed' code, never conflated with 'not_recorded'", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupHostGateCaptureCliCampaign("FG-621");
  const closedCommit = commitGateScriptIn(projectDir, "impl-FG-621", "exit 4");
  closeTicket(projectDir, "FG-621", closedCommit);
  const testedHead = commitPendingChangesIn(projectDir, "close FG-621");

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0, `reconcile failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { items: { ticketId: string; status: string; missing?: string[] }[] };
  assert.equal(output.items[0]?.status, "refused");
  assert.deepEqual(
    output.items[0]?.missing,
    ["host_verification_recorded_but_failed"],
    "raw JSON must carry the un-rewritten reason code, distinct from host_verification_not_recorded"
  );

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT exit_code, commit_sha FROM host_verifications WHERE ticket_id = ?")
    .all("FG-621") as { exit_code: number; commit_sha: string }[];
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exit_code, 4, "the actual non-zero exit code must be recorded, never fabricated as 0 or 1");
  assert.equal(rows[0]!.commit_sha, testedHead);
});

test("integ campaign reconcile (human, FG-440): renders distinct operator-facing text for not_recorded vs recorded_but_failed — never describes a real failure as pending automatic capture", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  // FG-622: no package.json at all in projectDir yet → the gate is unrunnable →
  // skip → not_recorded.
  const { campaignId: notRecordedCampaignId } = setupHostGateCaptureCliCampaign("FG-622");
  const closedCommitA = makeCommitIn(projectDir, "impl-FG-622");
  closeTicket(projectDir, "FG-622", closedCommitA);
  commitPendingChangesIn(projectDir, "close FG-622");

  const notRecordedResult = runForge(["campaign", "reconcile", notRecordedCampaignId]);
  assert.equal(notRecordedResult.status, 0, `stdout: ${notRecordedResult.stdout}\nstderr: ${notRecordedResult.stderr}`);
  assert.ok(
    notRecordedResult.stdout.includes("host_verification_not_recorded") &&
      notRecordedResult.stdout.includes("will be captured automatically"),
    `not_recorded hint must point at automatic capture on the next reconcile/drive run\nstdout: ${notRecordedResult.stdout}`
  );
  assert.ok(
    !notRecordedResult.stdout.includes("genuine failure"),
    `a not-yet-run gate must never be described as a genuine failure\nstdout: ${notRecordedResult.stdout}`
  );

  // FG-623: same projectDir now has the FG-620/FG-621 package.json from earlier
  // in this suite's git history — force it to a real, real failure for THIS commit.
  const { campaignId: failedCampaignId } = setupHostGateCaptureCliCampaign("FG-623");
  const closedCommitB = commitGateScriptIn(projectDir, "impl-FG-623", "exit 9");
  closeTicket(projectDir, "FG-623", closedCommitB);
  commitPendingChangesIn(projectDir, "close FG-623");

  const failedResult = runForge(["campaign", "reconcile", failedCampaignId]);
  assert.equal(failedResult.status, 0, `stdout: ${failedResult.stdout}\nstderr: ${failedResult.stderr}`);
  assert.ok(
    failedResult.stdout.includes("host_verification_recorded_but_failed") &&
      failedResult.stdout.includes("genuine failure"),
    `recorded_but_failed hint must state the gate ran for real and failed\nstdout: ${failedResult.stdout}`
  );
  assert.ok(
    !failedResult.stdout.includes("will be captured automatically"),
    `a genuine gate failure must never be rendered as something pending automatic capture\nstdout: ${failedResult.stdout}`
  );
});

test("integ campaign show (human, FG-440): prints a host-verification-status line for a scope-blocked item awaiting automatic capture", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupHostGateCaptureCliCampaign("FG-624");
  const closedCommit = makeCommitIn(projectDir, "impl-FG-624"); // no package.json → stays not_recorded
  closeTicket(projectDir, "FG-624", closedCommit);
  commitPendingChangesIn(projectDir, "close FG-624");

  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `stdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);
  assert.ok(
    showResult.stdout.includes("host-verification-status:") && showResult.stdout.includes("host_verification_not_recorded"),
    `campaign show must surface the host-verification hint for a scope-blocked item\nstdout: ${showResult.stdout}`
  );

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { items: { ticketId: string; hostVerificationReconcileHint: string | null }[] };
  const item = jsonOutput.items.find((i) => i.ticketId === "FG-624")!;
  assert.ok(item.hostVerificationReconcileHint?.includes("host_verification_not_recorded"));
});

// FG-452 AC5 parity: the FG-440 test above proves the human `forge campaign show`
// surface for the scope-blocked lane. This is its out-of-band code-touching
// counterpart — reconcile.integration.test.ts:1313 only asserted the JSON-shaped
// hostVerificationReconcileHint field and renderCampaignReportHuman directly; it
// never spawned a real `forge campaign show` subprocess and read its stdout.
test("integ campaign show (human, FG-452): prints a host-verification-status line for an out-of-band code-touching item awaiting automatic capture", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-625");
  makeCommitIn(projectDir, "base-FG-625");
  const commit = commitFileIn(projectDir, "src/FG-625.ts", "export const x = 1;\n", "feat: FG-625");
  closeTicket(projectDir, "FG-625", commit);
  // Deliberately no host_verifications row inserted for this commit — the item
  // stays awaiting_gate, which is the precondition for the hint to appear.

  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `stdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);
  assert.ok(
    showResult.stdout.includes("host-verification-status:") && showResult.stdout.includes("forge campaign reconcile"),
    `campaign show must surface the host-verification hint for an out-of-band code-touching item\nstdout: ${showResult.stdout}`
  );

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { items: { ticketId: string; hostVerificationReconcileHint: string | null }[] };
  const item = jsonOutput.items.find((i) => i.ticketId === "FG-625")!;
  assert.match(item.hostVerificationReconcileHint ?? "", /forge campaign reconcile/);
});

// ── FG-442: execution lanes ───────────────────────────────────────────────────

function writeProjectRoutingPolicy(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const policy = {
    version: 1,
    governance: { accountable: "human" },
    routes: {
      implementation_full: {
        responsible: "engineer", path: "workflow",
        consulted: [], required_followups: [], informed: [], force_rules: [],
      },
      implementation_quick: {
        responsible: "engineer", path: "invoke_chain",
        consulted: [], required_followups: [], informed: [], force_rules: [],
      },
      documentation_durable: {
        responsible: "documentation-maintainer", path: "invoke",
        consulted: [], required_followups: [], informed: [], force_rules: [],
      },
    },
  };
  // Hand-rolled YAML — avoids adding a yaml-package dependency to a CLI-only test.
  const yaml =
    "version: 1\n" +
    "governance:\n  accountable: human\n" +
    "routes:\n" +
    Object.entries(policy.routes)
      .map(
        ([key, route]) =>
          `  ${key}:\n` +
          `    responsible: ${route.responsible}\n` +
          `    path: ${route.path}\n` +
          `    consulted: []\n` +
          `    required_followups: []\n` +
          `    informed: []\n` +
          `    force_rules: []\n`
      )
      .join("");
  writeFileSync(join(projectDir, ".forge", "routing-policy.yml"), yaml);
}

test("integ campaign plan --routes: classifies each item's lane and prints lane + rationale (human + --json)", () => {
  writeProjectRoutingPolicy();

  const routes = JSON.stringify({ "FG-101": "implementation_quick", "FG-102": "documentation_durable" });
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--routes", routes,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout) as {
    orderedItems: { ticketId: string; lane: string; laneRationale: string }[];
    canonicalContent: { orderedItems: { ticketId: string; lane: string; agentRole?: string }[] };
  };
  const fg101 = output.orderedItems.find((i) => i.ticketId === "FG-101")!;
  const fg102 = output.orderedItems.find((i) => i.ticketId === "FG-102")!;
  assert.equal(fg101.lane, "quick_implementation");
  assert.ok(fg101.laneRationale.length > 0);
  assert.equal(fg102.lane, "docs_only");

  const canonicalFg102 = output.canonicalContent.orderedItems.find((i) => i.ticketId === "FG-102")!;
  assert.equal(canonicalFg102.agentRole, "documentation-maintainer");

  const humanResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--routes", routes,
    "--project", projectDir,
  ]);
  assert.equal(humanResult.status, 0);
  assert.match(humanResult.stdout, /lane=quick_implementation/);
  assert.match(humanResult.stdout, /lane=docs_only/);
});

test("integ campaign plan without --routes and without --default-lane: refuses non-zero, plans nothing (FG-442 finding 3)", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
  ], { rawPlan: true });

  assert.notEqual(result.status, 0, `expected non-zero exit\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /no lane judgment supplied for 2 item\(s\) \(FG-442\)/);
  assert.match(result.stderr, /--routes/);
  assert.match(result.stderr, /--default-lane/);

  const dbPath = join(forgeHome, "forge.db");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    const campaigns = db.prepare("SELECT * FROM campaigns").all();
    assert.equal(campaigns.length, 0, "no campaign should be persisted when the refusal fires");
    db.close();
  }
});

test("integ campaign plan --default-lane full_feature --default-lane-rationale: succeeds, every item gets the operator lane + rationale, folded into plan_hash", () => {
  const rationale = "operator reviewed backlog manually — everything here is a full feature build";
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--default-lane", "full_feature",
    "--default-lane-rationale", rationale,
    "--json",
  ], { rawPlan: true });

  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    planHash: string;
    orderedItems: { ticketId: string; lane: string; laneRationale: string }[];
    canonicalContent: { orderedItems: { ticketId: string; lane: string; laneRationale: string }[] };
  };

  for (const item of output.orderedItems) {
    assert.equal(item.lane, "full_feature");
    assert.equal(item.laneRationale, rationale);
  }
  for (const entry of output.canonicalContent.orderedItems) {
    assert.equal(entry.lane, "full_feature");
    assert.equal(entry.laneRationale, rationale);
    assert.notEqual(entry.laneRationale, "no lane override supplied — defaulting to full_feature");
  }

  // The operator rationale is part of canonicalContent, which the plan_hash
  // is derived from — re-planning with a different rationale must change it.
  const differentRationaleResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--default-lane", "full_feature",
    "--default-lane-rationale", "a completely different rationale",
    "--json",
  ], { rawPlan: true });
  assert.equal(differentRationaleResult.status, 0);
  const differentOutput = JSON.parse(differentRationaleResult.stdout) as { planHash: string };
  assert.notEqual(differentOutput.planHash, output.planHash, "plan_hash must reflect the operator-supplied rationale");
});

test("integ campaign plan --default-lane <bad-lane>: rejected", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--default-lane", "not_a_real_lane",
    "--default-lane-rationale", "text",
  ], { rawPlan: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid --default-lane/);
});

test("integ campaign plan --default-lane docs_only (agentRole-bearing lane): rejected as a blanket default", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--default-lane", "docs_only",
    "--default-lane-rationale", "text",
  ], { rawPlan: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid --default-lane/);
});

test("integ campaign plan --default-lane without --default-lane-rationale: rejected", () => {
  const result = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--default-lane", "full_feature",
  ], { rawPlan: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--default-lane-rationale/);
});

test("integ campaign approve: restates the lane basis being recorded (human + --json)", () => {
  writeProjectRoutingPolicy();

  const routes = JSON.stringify({ "FG-101": "implementation_quick" });
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--routes", routes,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "LGTM",
  ]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);
  assert.match(approveResult.stdout, /Lane basis being recorded:/);
  assert.match(approveResult.stdout, /FG-101: lane=quick_implementation/);

  const approveJsonResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "already approved, re-check json shape",
    "--json",
  ]);
  // Second approve call: campaign is now 'planned' still (approve doesn't transition status),
  // so this remains a valid re-approval — asserts the JSON laneBasis shape independent of the
  // human-output assertions above.
  assert.equal(approveJsonResult.status, 0, `stdout: ${approveJsonResult.stdout}\nstderr: ${approveJsonResult.stderr}`);
  const approveJson = JSON.parse(approveJsonResult.stdout) as {
    laneBasis: { ticketId: string; lane: string; laneRationale: string }[];
  };
  const laneEntry = approveJson.laneBasis.find((e) => e.ticketId === "FG-101")!;
  assert.equal(laneEntry.lane, "quick_implementation");
});

// ── RED-WIDE FG-442 follow-on fixes: escalation lifecycle integrity ──────────

test("integ RED-WIDE fix 1: campaign resume after a lane_escalation pause (no escalate) refuses, item2 never dispatched", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
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

  // Simulate the campaign having already paused on a lane_escalation blocker for
  // item1 — the state escalateCampaignItemLane/finalizeInvokeDispatch produce,
  // without needing a real dispatch to outgrow a lane.
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation', requested_human_action = 'escalate the lane and re-approve before resuming' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, "resume after an unresolved lane_escalation pause must exit non-zero");
  const combined = (resumeResult.stderr + resumeResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("lane") && combined.includes("escalat"),
    `expected a lane-escalation-specific refusal message\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );

  const db2 = new Database(dbPath);
  const item2After = db2.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[1]!.id) as {
    lifecycle_status: string;
  };
  const campaignAfter = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(planOutput.campaignId) as { status: string };
  db2.close();
  assert.equal(item2After.lifecycle_status, "pending", "item2 must never be dispatched past the unresolved lane_escalation item");
  assert.equal(campaignAfter.status, "paused", "a refused resume must not silently transition the campaign");
});

test("integ RED-WIDE fix 2: campaign approve refuses a paused campaign with an unresolved lane_escalation blocker and unchanged plan_hash", () => {
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

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const rubberStampResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "rubber stamp attempt",
  ]);
  assert.notEqual(rubberStampResult.status, 0, "approve must refuse a rubber-stamp on an unresolved lane_escalation pause");
  const combined = (rubberStampResult.stderr + rubberStampResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("lane") && combined.includes("escalat"),
    `expected a lane-escalation-specific refusal message\nstdout: ${rubberStampResult.stdout}\nstderr: ${rubberStampResult.stderr}`
  );

  const db2 = new Database(dbPath);
  const campaignAfter = db2.prepare("SELECT approval_rationale FROM campaigns WHERE id = ?").get(planOutput.campaignId) as {
    approval_rationale: string | null;
  };
  db2.close();
  assert.equal(
    campaignAfter.approval_rationale,
    "LGTM",
    "the refused rubber-stamp attempt must not have overwritten the original approval record"
  );
});

test("integ RED-WIDE follow-on: real `campaign escalate-lane` + approve + resume proceeds only after the genuine escalate", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;

  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const escalateResult = runForge([
    "campaign", "escalate-lane", campaignId, "FG-101",
    "--new-lane", "quick_implementation",
    "--rationale", "agent reported outgrowing full_feature",
    "--json",
  ]);
  assert.equal(escalateResult.status, 0, `escalate-lane failed\nstdout: ${escalateResult.stdout}\nstderr: ${escalateResult.stderr}`);
  const escalateOutput = JSON.parse(escalateResult.stdout) as { planHash: string };

  const dbAfterEscalate = new Database(dbPath, { readonly: true });
  const itemAfterEscalate = dbAfterEscalate.prepare("SELECT lifecycle_status, blocker_kind FROM campaign_items WHERE id = ?").get(items[0]!.id) as {
    lifecycle_status: string;
    blocker_kind: string | null;
  };
  const campaignAfterEscalate = dbAfterEscalate.prepare("SELECT plan_hash, approved_plan_hash FROM campaigns WHERE id = ?").get(campaignId) as {
    plan_hash: string;
    approved_plan_hash: string;
  };
  dbAfterEscalate.close();
  assert.equal(itemAfterEscalate.lifecycle_status, "pending", "a genuine escalate must reset the escalated item to pending");
  assert.equal(itemAfterEscalate.blocker_kind, null, "a genuine escalate must clear the lane_escalation blocker");
  assert.equal(campaignAfterEscalate.plan_hash, escalateOutput.planHash);
  assert.notEqual(campaignAfterEscalate.plan_hash, campaignAfterEscalate.approved_plan_hash, "escalate must mint a fresh unapproved plan hash");

  const reapproveResult = runForge(["campaign", "approve", campaignId, "--rationale", "re-approved after genuine escalate"]);
  assert.equal(reapproveResult.status, 0, `re-approve after a genuine escalate must succeed\nstdout: ${reapproveResult.stdout}\nstderr: ${reapproveResult.stderr}`);

  // Simulate the re-dispatched item completing under its new lane (no real agent dispatch in this test).
  const dbComplete = new Database(dbPath);
  dbComplete.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  dbComplete.close();

  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as Record<string, unknown>;
  assert.equal(resumeOutput["stopReason"], "complete", "resume must proceed to complete only after the real escalate+approve");

  const dbFinal = new Database(dbPath, { readonly: true });
  const finalCampaign = dbFinal.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId) as { status: string };
  dbFinal.close();
  assert.equal(finalCampaign.status, "complete");
});

test("integ RED-WIDE follow-on: `campaign escalate-lane` with an unrelated/unknown ticket id is rejected and mints no approvable plan hash", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;

  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaignId) as { id: string; ticket_id: string }[];
  // FG-101 (items[0]) is the REAL item blocked on lane_escalation; FG-102 (items[1]) is unrelated and still pending.
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  const planHashBefore = (db.prepare("SELECT plan_hash FROM campaigns WHERE id = ?").get(campaignId) as { plan_hash: string }).plan_hash;
  db.close();

  // Escalate the WRONG ticket: FG-102 is not the item blocked on lane_escalation.
  const wrongTicketResult = runForge([
    "campaign", "escalate-lane", campaignId, "FG-102",
    "--new-lane", "quick_implementation",
    "--rationale", "attempted escalate of an unrelated ticket",
  ]);
  assert.notEqual(wrongTicketResult.status, 0, "escalate-lane on a ticket not blocked on lane_escalation must be rejected");
  const wrongTicketCombined = (wrongTicketResult.stderr + wrongTicketResult.stdout).toLowerCase();
  assert.ok(
    wrongTicketCombined.includes("lane_escalation") || wrongTicketCombined.includes("lane escalation") || wrongTicketCombined.includes("blocked"),
    `expected a lane_escalation-specific refusal\nstdout: ${wrongTicketResult.stdout}\nstderr: ${wrongTicketResult.stderr}`
  );

  // Escalate an UNKNOWN ticket id entirely.
  const unknownTicketResult = runForge([
    "campaign", "escalate-lane", campaignId, "FG-999-does-not-exist",
    "--new-lane", "quick_implementation",
    "--rationale", "attempted escalate of a nonexistent ticket",
  ]);
  assert.notEqual(unknownTicketResult.status, 0, "escalate-lane on an unknown ticket id must be rejected");

  const dbAfter = new Database(dbPath, { readonly: true });
  const campaignAfter = dbAfter.prepare("SELECT plan_hash, approved_plan_hash FROM campaigns WHERE id = ?").get(campaignId) as {
    plan_hash: string;
    approved_plan_hash: string;
  };
  const item2After = dbAfter.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[1]!.id) as { lifecycle_status: string };
  dbAfter.close();
  assert.equal(campaignAfter.plan_hash, planHashBefore, "a rejected escalate must not mint any new plan hash");
  assert.equal(item2After.lifecycle_status, "pending", "the unrelated ticket must not be reset/touched by the rejected escalate");

  // A subsequent approve must still be refused: the REAL escalated item (FG-101) is still unresolved.
  const approveAfterResult = runForge(["campaign", "approve", campaignId, "--rationale", "attempted rubber stamp"]);
  assert.notEqual(approveAfterResult.status, 0, "approve must still refuse while the real lane_escalation item remains unresolved");
  const approveCombined = (approveAfterResult.stderr + approveAfterResult.stdout).toLowerCase();
  assert.ok(
    approveCombined.includes("lane") && approveCombined.includes("escalat"),
    `expected a lane-escalation-specific refusal\nstdout: ${approveAfterResult.stdout}\nstderr: ${approveAfterResult.stderr}`
  );
  assert.equal(campaignAfter.approved_plan_hash, planHashBefore, "approved_plan_hash must be unchanged since the rejected escalate never re-approved anything");
});

// ── FG-489: `campaign retry` — supported reset-to-pending for transiently-failed items ──

test("integ FG-489: real `campaign retry` resets an auth-blocked item to pending; a subsequent `campaign resume` re-dispatches it to complete", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;

  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'auth', run_id = 'run-auth-dead', reason = 'auth token expired' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101", "--json"]);
  assert.equal(retryResult.status, 0, `retry failed\nstdout: ${retryResult.stdout}\nstderr: ${retryResult.stderr}`);
  const retryOutput = JSON.parse(retryResult.stdout) as { lifecycleStatus: string };
  assert.equal(retryOutput.lifecycleStatus, "pending");

  const dbAfterRetry = new Database(dbPath, { readonly: true });
  const itemAfterRetry = dbAfterRetry.prepare(
    "SELECT lifecycle_status, outcome, blocker_kind, run_id FROM campaign_items WHERE id = ?"
  ).get(items[0]!.id) as { lifecycle_status: string; outcome: string | null; blocker_kind: string | null; run_id: string | null };
  dbAfterRetry.close();
  assert.equal(itemAfterRetry.lifecycle_status, "pending", "retry must reset the item to pending");
  assert.equal(itemAfterRetry.outcome, null, "retry must clear the blocked outcome");
  assert.equal(itemAfterRetry.blocker_kind, null, "retry must clear the auth blockerKind");
  assert.equal(itemAfterRetry.run_id, null, "retry must clear the dead run's linkage for a clean re-dispatch");

  // Simulate the re-dispatched item completing under a fresh run (no real agent dispatch in this test).
  const dbComplete = new Database(dbPath);
  dbComplete.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(items[0]!.id);
  dbComplete.close();

  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as Record<string, unknown>;
  assert.equal(resumeOutput["stopReason"], "complete", "resume must proceed to complete once the retried item is re-dispatched");
});

test("integ FG-489: `campaign retry` refuses a running campaign", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;
  runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
  const items = db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaignId) as { id: string }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'auth' WHERE id = ?").run(items[0]!.id);
  db.close();

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(retryResult.status, 0, "retry must refuse a running campaign");
  assert.match(retryResult.stderr.toLowerCase(), /paused/);

  const dbAfter = new Database(dbPath, { readonly: true });
  const itemAfter = dbAfter.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[0]!.id) as { lifecycle_status: string };
  dbAfter.close();
  assert.equal(itemAfter.lifecycle_status, "failed", "a refused retry must not mutate the item");
});

test("integ FG-489: `campaign retry` refuses a scope-blocked item and names the escalate-lane path for a lane_escalation blocker", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101,FG-102",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  const campaignId = planOutput.campaignId;
  runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").all(campaignId) as {
    id: string;
    ticket_id: string;
  }[];
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?").run(items[1]!.id);
  db.close();

  const scopeRetryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(scopeRetryResult.status, 0, "retry must refuse a scope-blocked item");
  assert.match(scopeRetryResult.stderr.toLowerCase(), /scope/);

  const laneRetryResult = runForge(["campaign", "retry", campaignId, "FG-102"]);
  assert.notEqual(laneRetryResult.status, 0, "retry must refuse a lane_escalation-blocked item");
  assert.match(laneRetryResult.stderr.toLowerCase(), /escalate-lane/);

  const dbAfter = new Database(dbPath, { readonly: true });
  const item1After = dbAfter.prepare("SELECT lifecycle_status, blocker_kind FROM campaign_items WHERE id = ?").get(items[0]!.id) as {
    lifecycle_status: string;
    blocker_kind: string;
  };
  const item2After = dbAfter.prepare("SELECT lifecycle_status, blocker_kind FROM campaign_items WHERE id = ?").get(items[1]!.id) as {
    lifecycle_status: string;
    blocker_kind: string;
  };
  dbAfter.close();
  assert.equal(item1After.lifecycle_status, "failed");
  assert.equal(item1After.blocker_kind, "scope");
  assert.equal(item2After.lifecycle_status, "failed");
  assert.equal(item2After.blocker_kind, "lane_escalation");
});

// ── FG-511: `campaign retry` on a campaign_system item, through the real CLI ──
//
// The executor-level tests cover retryCampaignItem's evidence probe directly.
// These pin the CLI contract the operator actually touches: exit code, the human
// and --json stdout on acceptance, and the stderr refusal naming the
// non-transient evidence — for the campaign_system shape specifically, whose
// verdict depends on run/task rows the CLI process must read for itself.

// Seeds the durable evidence the probe reads back: a paused campaign whose single
// item is parked on the campaign_system placeholder, pointing at an abandoned run
// with one failed primary task per kind (each with the task.failed event that
// carries its failure_kind).
function seedCampaignSystemItem(dbPath: string, campaignId: string, failureKinds: string[]): { itemId: string; runId: string } {
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const itemId = (db.prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC").get(campaignId) as { id: string }).id;
  const runId = `run-${itemId}`;
  const now = new Date().toISOString();

  db.prepare("INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, 'abandoned', ?, ?)").run(runId, "FG-101", now, projectDir);
  failureKinds.forEach((kind, i) => {
    const taskId = `${runId}-task-${i}`;
    db.prepare(
      "INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, error) VALUES (?, ?, 'implement', 'engineer', 'failed', '{}', ?, ?)"
    ).run(taskId, runId, now, `seeded ${kind}`);
    db.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, 'task.failed', ?, ?)").run(
      runId,
      taskId,
      JSON.stringify({ failure_kind: kind, error: `seeded ${kind}` }),
      now
    );
  });
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'campaign_system', run_id = ?, requested_human_action = 'run ended without a terminal outcome' WHERE id = ?"
  ).run(runId, itemId);
  db.close();
  return { itemId, runId };
}

function planAndApprove(): string {
  const planResult = runForge(["campaign", "plan", "--tickets", "FG-101", "--project", projectDir, "--mode", "sequential", "--json"]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const campaignId = (JSON.parse(planResult.stdout) as { campaignId: string }).campaignId;
  const approveResult = runForge(["campaign", "approve", campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);
  return campaignId;
}

test("integ FG-511: real `campaign retry` accepts a campaign_system item on transient run evidence — human and --json stdout, audit event, item reset", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { itemId, runId } = seedCampaignSystemItem(dbPath, campaignId, ["idle_timeout"]);

  // `campaign show` must point the operator at retry BEFORE they run it — the
  // human line and the --json field both.
  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `show failed\nstderr: ${showResult.stderr}`);
  assert.ok(
    showResult.stdout.includes(`forge campaign retry ${campaignId} FG-101`),
    `show must name the evidence-gated retry\nstdout: ${showResult.stdout}`
  );
  const showJson = JSON.parse(runForge(["campaign", "show", campaignId, "--json"]).stdout) as {
    items: { campaignSystemRetryEligible: boolean }[];
  };
  assert.equal(showJson.items[0]!.campaignSystemRetryEligible, true, "the JSON surface must expose retry eligibility");

  const humanResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.equal(humanResult.status, 0, `retry failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.match(humanResult.stdout, /Reset FG-101 in campaign .* to pending\./);
  assert.match(humanResult.stdout, new RegExp(`forge campaign resume ${campaignId}`));

  const dbAfter = new Database(dbPath, { readonly: true });
  const item = dbAfter.prepare("SELECT lifecycle_status, outcome, blocker_kind, run_id FROM campaign_items WHERE id = ?").get(itemId) as {
    lifecycle_status: string;
    outcome: string | null;
    blocker_kind: string | null;
    run_id: string | null;
  };
  const auditEvents = dbAfter
    .prepare("SELECT payload FROM events WHERE run_id = ? AND event_type = 'campaign_item.campaign_system_retried'")
    .all(runId) as { payload: string }[];
  dbAfter.close();

  assert.equal(item.lifecycle_status, "pending", "retry must reset the item to pending");
  assert.equal(item.blocker_kind, null, "retry must clear the campaign_system blockerKind");
  assert.equal(item.run_id, null, "retry must clear the abandoned run's linkage");
  assert.equal(auditEvents.length, 1, "acceptance must record exactly one campaign_system_retried audit event");
  const evidence = (JSON.parse(auditEvents[0]!.payload) as { evidence: { failureKind: string; classified: string }[] }).evidence;
  assert.deepEqual(evidence.map((e) => [e.failureKind, e.classified]), [["idle_timeout", "infrastructure"]]);

  // The --json surface of a second, independent acceptance.
  const campaignId2 = planAndApprove();
  seedCampaignSystemItem(dbPath, campaignId2, ["idle_timeout"]);
  const jsonResult = runForge(["campaign", "retry", campaignId2, "FG-101", "--json"]);
  assert.equal(jsonResult.status, 0, `retry --json failed\nstderr: ${jsonResult.stderr}`);
  assert.deepEqual(JSON.parse(jsonResult.stdout), { campaignId: campaignId2, ticketId: "FG-101", lifecycleStatus: "pending" });
});

test("integ FG-511: real `campaign retry` refuses a campaign_system item on non-transient run evidence, naming it — item unchanged, no audit event", () => {
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");
  const { itemId, runId } = seedCampaignSystemItem(dbPath, campaignId, ["idle_timeout", "gate_rejected"]);

  // The mirror surface must refuse too: no retry pointer for evidence retry rejects.
  const showResult = runForge(["campaign", "show", campaignId]);
  assert.ok(!showResult.stdout.includes("forge campaign retry"), `show must not name retry for mixed evidence\nstdout: ${showResult.stdout}`);
  const showJson = JSON.parse(runForge(["campaign", "show", campaignId, "--json"]).stdout) as {
    items: { campaignSystemRetryEligible: boolean }[];
  };
  assert.equal(showJson.items[0]!.campaignSystemRetryEligible, false);

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(retryResult.status, 0, "mixed transient+scope evidence must refuse fail-closed");
  assert.match(retryResult.stderr, new RegExp(`${runId}-task-1`), `refusal must name the non-transient task\nstderr: ${retryResult.stderr}`);
  assert.match(retryResult.stderr, /gate_rejected/, "refusal must name the failure kind");
  assert.match(retryResult.stderr, /'scope'/, "refusal must name the classification");

  const dbAfter = new Database(dbPath, { readonly: true });
  const item = dbAfter.prepare("SELECT lifecycle_status, blocker_kind, run_id FROM campaign_items WHERE id = ?").get(itemId) as {
    lifecycle_status: string;
    blocker_kind: string | null;
    run_id: string | null;
  };
  const auditCount = (
    dbAfter.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.campaign_system_retried'").get() as { n: number }
  ).n;
  dbAfter.close();
  assert.equal(item.lifecycle_status, "failed", "a refused retry must not mutate the item");
  assert.equal(item.blocker_kind, "campaign_system");
  assert.equal(item.run_id, runId, "a refused retry must not clear the run linkage");
  assert.equal(auditCount, 0, "a refused retry must record no audit event");
});

// FG-511 round 2: the same transient run evidence, but the ticket was delivered
// out-of-band anyway. Through the real CLI: `show` must point at reconcile and
// never print the retry hint, and `retry` must refuse rather than re-dispatch
// work already on main.
test("integ FG-511: real `campaign retry` refuses a campaign_system item whose ticket is provably delivered, naming reconcile — show points there too", () => {
  gitExec(["init", "-b", "main"], projectDir);
  const campaignId = planAndApprove();
  const dbPath = join(forgeHome, "forge.db");

  makeCommitIn(projectDir, "base");
  const shipCommit = makeCommitIn(projectDir, "ship-FG-101");
  closeTicket(projectDir, "FG-101", shipCommit);
  const { itemId, runId } = seedCampaignSystemItem(dbPath, campaignId, ["idle_timeout"]);

  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `show failed\nstderr: ${showResult.stderr}`);
  assert.ok(showResult.stdout.includes("forge campaign reconcile"), `show must point at reconcile\nstdout: ${showResult.stdout}`);
  assert.ok(
    !showResult.stdout.includes("campaign-system-retryable"),
    `show must not print a retry hint for delivered work\nstdout: ${showResult.stdout}`
  );
  assert.ok(!showResult.stdout.includes("forge campaign retry"), `show must not name retry at all\nstdout: ${showResult.stdout}`);

  const showJson = JSON.parse(runForge(["campaign", "show", campaignId, "--json"]).stdout) as {
    items: { campaignSystemEligible: boolean; campaignSystemRetryEligible: boolean }[];
  };
  assert.equal(showJson.items[0]!.campaignSystemEligible, true, "the JSON surface must expose reconcile eligibility");
  assert.equal(showJson.items[0]!.campaignSystemRetryEligible, false, "the JSON surface must not claim retry eligibility");

  const retryResult = runForge(["campaign", "retry", campaignId, "FG-101"]);
  assert.notEqual(retryResult.status, 0, "delivered work must never be reset for re-dispatch");
  assert.match(retryResult.stderr, /provably delivered/i, `refusal must say the work already landed\nstderr: ${retryResult.stderr}`);
  assert.match(retryResult.stderr, new RegExp(`forge campaign reconcile ${campaignId}`), `refusal must name reconcile\nstderr: ${retryResult.stderr}`);

  const dbAfter = new Database(dbPath, { readonly: true });
  const item = dbAfter.prepare("SELECT lifecycle_status, blocker_kind, run_id FROM campaign_items WHERE id = ?").get(itemId) as {
    lifecycle_status: string;
    blocker_kind: string | null;
    run_id: string | null;
  };
  const auditCount = (
    dbAfter.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.campaign_system_retried'").get() as { n: number }
  ).n;
  dbAfter.close();
  assert.equal(item.lifecycle_status, "failed", "a refused retry must not mutate the item");
  assert.equal(item.blocker_kind, "campaign_system");
  assert.equal(item.run_id, runId, "a refused retry must not clear the run linkage");
  assert.equal(auditCount, 0, "a refused retry must record no audit event");
});

// ── FG-442 review (PR #11 follow-up), Finding 2: paused-approve plan-hash scoping ──

test("integ FG-442 Finding 2: campaign approve refuses a paused campaign parked at awaiting_gate with an unchanged plan_hash (campaign-922 shape)", () => {
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

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  // The out-of-band shape: awaiting_gate with NO blocker_kind — e.g. an invoke-lane
  // item that finished without shipping (Finding 1) or a gate:human pause. No plan change.
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'agent finished but ticket FG-101 is not closed with a closedCommit — close the ticket and run `forge campaign reconcile`, or resolve manually' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const rubberStampResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "rubber stamp attempt",
  ]);
  assert.notEqual(rubberStampResult.status, 0, "approve must refuse a paused campaign whose plan_hash is unchanged since approval");
  const combined = (rubberStampResult.stderr + rubberStampResult.stdout).toLowerCase();
  assert.ok(
    combined.includes("plan hash") || combined.includes("plan_hash"),
    `expected a plan-hash-scoping refusal message\nstdout: ${rubberStampResult.stdout}\nstderr: ${rubberStampResult.stderr}`
  );

  const db2 = new Database(dbPath);
  const campaignAfter = db2.prepare("SELECT approval_rationale FROM campaigns WHERE id = ?").get(planOutput.campaignId) as {
    approval_rationale: string | null;
  };
  const itemAfter = db2.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = ?").get(items[0]!.id) as {
    lifecycle_status: string;
  };
  db2.close();
  assert.equal(
    campaignAfter.approval_rationale,
    "LGTM",
    "the refused rubber-stamp attempt must not have overwritten the original approval record"
  );
  assert.equal(itemAfter.lifecycle_status, "awaiting_gate", "the preserved item must not be mutated by the refused approve");
});

test("integ FG-442 Finding 2: a genuine escalate->approve re-approval (fresh plan_hash) still proceeds", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--mode", "sequential",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'lane_escalation' WHERE id = ?"
  ).run(items[0]!.id);
  db.close();

  const escalateResult = runForge([
    "campaign", "escalate-lane", planOutput.campaignId, "FG-101",
    "--new-lane", "quick_implementation",
    "--rationale", "genuinely outgrew the assigned lane",
  ]);
  assert.equal(escalateResult.status, 0, `escalate-lane failed\nstdout: ${escalateResult.stdout}\nstderr: ${escalateResult.stderr}`);

  const reapproveResult = runForge([
    "campaign", "approve", planOutput.campaignId,
    "--rationale", "re-approved after genuine escalate",
  ]);
  assert.equal(
    reapproveResult.status,
    0,
    `genuine post-escalate re-approve must succeed\nstdout: ${reapproveResult.stdout}\nstderr: ${reapproveResult.stderr}`
  );

  const db2 = new Database(dbPath, { readonly: true });
  const campaignAfter = db2.prepare("SELECT plan_hash, approved_plan_hash FROM campaigns WHERE id = ?").get(planOutput.campaignId) as {
    plan_hash: string;
    approved_plan_hash: string;
  };
  db2.close();
  assert.equal(campaignAfter.plan_hash, campaignAfter.approved_plan_hash, "the genuine re-approve must record the fresh plan hash as approved");
});

// ── FG-490 review: drive-error rethrow renders through the CLI's stop-reason
// output paths instead of escaping as a bare uncaught exception ────────────
//
// A project-override `feature.yml` that declares a required input the
// executor never supplies forces the real (non-mocked) startRun to throw
// synchronously the moment the item dispatches — the same drive-path throw
// parkCampaignOnDriveThrow wraps and rethrows in production.
function writeDriveErrorForcingWorkflow(): void {
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  const yaml = [
    "name: feature",
    "description: FG-490 fixture — forces startRun's required-input check to throw.",
    "inputs:",
    "  - name: brief",
    "    required: true",
    "    type: text",
    "  - name: drive-error-fixture-field",
    "    required: true",
    "    type: text",
    "    help: never supplied by the campaign executor — forces the drive-time throw",
    "steps:",
    "  - id: architect",
    "    agent: architecture-advisor",
    "",
  ].join("\n");
  writeFileSync(join(projectDir, ".forge", "workflows", "feature.yml"), yaml);
}

// The shared beforeEach's FG-101 has an empty body, so it never clears the
// readiness gate (evaluateReadiness) and the item parks on outcome=held
// before it ever reaches dispatch. Rewrite it with Problem/Goal/Acceptance
// Criteria sections — same shape executor.integration.test.ts's real-dispatch fixtures
// use — so the item actually dispatches and hits the drive-error fixture.
function writeReadyTicket(): void {
  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    created: "2024-01-01",
    body: "## Problem\nStory One needs implementation.\n\n## Goal\nComplete story one.\n\n## Acceptance Criteria\n- Story one is complete\n",
  });
}

test("integ FG-490 review: campaign start --json renders a drive-error as structured JSON, not a bare non-JSON exception", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const startResult = runForge(["campaign", "start", planOutput.campaignId, "--json"]);
  assert.notEqual(startResult.status, 0, "a drive-error must still exit non-zero");

  let parsed: { stopReason: string; ticketId?: string; runId?: string; error: string; guidance: string };
  assert.doesNotThrow(
    () => { parsed = JSON.parse(startResult.stdout); },
    `--json output must be parseable JSON, not a bare 'forge: ...' line\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  parsed = JSON.parse(startResult.stdout);
  assert.equal(parsed.stopReason, "drive_error");
  assert.equal(parsed.ticketId, "FG-101");
  assert.ok(parsed.runId, "runId must be derivable from the parked campaign item");
  assert.match(parsed.error, /required input 'drive-error-fixture-field' missing/, "error must carry the ORIGINAL drive-path error, not the wrapped guidance text");
  // FG-490 reopen: this fixture parks failed/blocked/infrastructure (the
  // startRun-throw shape) — bare resume SKIPS failed items, so the guidance
  // must lead with retry (targeting this exact campaign+ticket) before resume,
  // never recommend bare resume alone.
  assert.ok(
    parsed.guidance.includes(`forge campaign retry ${planOutput.campaignId} FG-101`),
    `guidance must recommend retry for the parked ticket, got: ${parsed.guidance}`
  );
  assert.ok(
    parsed.guidance.includes(`forge campaign resume ${planOutput.campaignId}`),
    `guidance must still chain into resume, got: ${parsed.guidance}`
  );
  assert.notEqual(
    parsed.guidance,
    `forge campaign resume ${planOutput.campaignId}`,
    "guidance must not be bare resume alone — that silently skips the failed item"
  );
});

test("integ FG-490 review: campaign start (human) still prints the wrapped drive-error message with resume guidance", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const startResult = runForge(["campaign", "start", planOutput.campaignId]);
  assert.notEqual(startResult.status, 0, "a drive-error must still exit non-zero");

  const combined = startResult.stderr + startResult.stdout;
  assert.ok(
    combined.includes(`campaign ${planOutput.campaignId} paused after a drive error on FG-101`),
    `human output must keep the executor's wrapped message text\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  assert.ok(
    combined.includes(`forge campaign resume ${planOutput.campaignId}`),
    `human output must keep the resume guidance\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
});

test("integ FG-490 review: campaign resume --json renders a fresh drive-error as structured JSON", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  // Drive resume straight into dispatch (skipping a real `start`): flip the
  // campaign to paused with its item still pending, exactly as the other
  // in-flight/held resume tests in this file seed state directly via DB.
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId, "--json"]);
  assert.notEqual(resumeResult.status, 0, "a drive-error must still exit non-zero");

  let parsed: { stopReason: string; ticketId?: string; runId?: string; error: string; guidance: string };
  assert.doesNotThrow(
    () => { parsed = JSON.parse(resumeResult.stdout); },
    `--json output must be parseable JSON, not a bare 'forge: ...' line\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  parsed = JSON.parse(resumeResult.stdout);
  assert.equal(parsed.stopReason, "drive_error");
  assert.equal(parsed.ticketId, "FG-101");
  assert.ok(parsed.runId, "runId must be derivable from the parked campaign item");
  assert.match(parsed.error, /required input 'drive-error-fixture-field' missing/);
  // FG-490 reopen: same startRun-throw shape as the `start` case above — resume
  // must also lead with retry, not bare resume.
  assert.ok(
    parsed.guidance.includes(`forge campaign retry ${planOutput.campaignId} FG-101`),
    `guidance must recommend retry for the parked ticket, got: ${parsed.guidance}`
  );
  assert.notEqual(
    parsed.guidance,
    `forge campaign resume ${planOutput.campaignId}`,
    "guidance must not be bare resume alone — that silently skips the failed item"
  );
});

test("integ FG-490 review: campaign resume (human) still prints the wrapped drive-error message with resume guidance", () => {
  writeDriveErrorForcingWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  const resumeResult = runForge(["campaign", "resume", planOutput.campaignId]);
  assert.notEqual(resumeResult.status, 0, "a drive-error must still exit non-zero");

  const combined = resumeResult.stderr + resumeResult.stdout;
  assert.ok(
    combined.includes(`campaign ${planOutput.campaignId} paused after a drive error on FG-101`),
    `human output must keep the executor's wrapped message text\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
  assert.ok(
    combined.includes(`forge campaign resume ${planOutput.campaignId}`),
    `human output must keep the resume guidance\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`
  );
});

// ── FG-490 reopen: the runNext-throw (awaiting_gate) shape, exercised at the
// CLI layer ──────────────────────────────────────────────────────────────
//
// startRun succeeds (only `brief` is required, and the executor always
// supplies it) but runNext throws while resolving the model for the
// `architect` step's role: the model-policy fixture below defines a profile
// whose `map` covers `review` but not `reasoning` (architecture-advisor's
// default capability, per DEFAULT_ACTIVITY_BY_ROLE) and has no `default`
// fallback — resolveModel (src/v2/model-resolution.ts) throws synchronously,
// uncaught inside runNext, which driveWorkflowItem's runNextFn try/catch
// (src/campaign/executor.ts) hands to parkCampaignOnDriveThrow. That parks
// the item at 'awaiting_gate' (not failed/blocked/infrastructure) — the
// shape a real `forge campaign resume` reattaches to and re-drives, so the
// bare resume guidance is correct here (unlike the startRun-throw shape
// above, which needs retry first).
function writeRunNextThrowWorkflow(): void {
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  const yaml = [
    "name: feature",
    "description: FG-490 reopen fixture — startRun succeeds; runNext throws resolving the model for `architect`.",
    "inputs:",
    "  - name: brief",
    "    required: true",
    "    type: text",
    "steps:",
    "  - id: architect",
    "    agent: architecture-advisor",
    "",
  ].join("\n");
  writeFileSync(join(projectDir, ".forge", "workflows", "feature.yml"), yaml);

  const policyYaml = [
    "schema_version: 2",
    "model_profiles:",
    "  main:",
    "    provider: anthropic",
    "    auth: subscription",
    "    map:",
    "      review:",
    "        model: claude-sonnet-4",
    "        cost_tier: standard",
    "defaults:",
    "  profile: main",
    "",
  ].join("\n");
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), policyYaml);
}

test("FG-490 reopen integ: campaign start --json (runNext-throw / awaiting_gate shape) guidance stays bare resume, not retry", () => {
  writeRunNextThrowWorkflow();
  writeReadyTicket();

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--mode", "sequential",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "LGTM"]);
  assert.equal(approveResult.status, 0, `approve failed\nstderr: ${approveResult.stderr}`);

  const startResult = runForge(["campaign", "start", planOutput.campaignId, "--json"]);
  assert.notEqual(startResult.status, 0, "a drive-error must still exit non-zero");

  let parsed: { stopReason: string; ticketId?: string; runId?: string; error: string; guidance: string };
  assert.doesNotThrow(
    () => { parsed = JSON.parse(startResult.stdout); },
    `--json output must be parseable JSON, not a bare 'forge: ...' line\nstdout: ${startResult.stdout}\nstderr: ${startResult.stderr}`
  );
  parsed = JSON.parse(startResult.stdout);
  assert.equal(parsed.stopReason, "drive_error");
  assert.equal(parsed.ticketId, "FG-101");
  assert.ok(parsed.runId, "runId must be derivable from the parked campaign item");
  assert.match(parsed.error, /has no mapping for capability 'reasoning'/, "error must carry the ORIGINAL runNext-path error");

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE ticket_id = ? AND campaign_id = ?")
    .get("FG-101", planOutput.campaignId) as { lifecycle_status: string; outcome: string | null; blocker_kind: string | null };
  db.close();
  assert.equal(item.lifecycle_status, "awaiting_gate", "runNext-throw must park at awaiting_gate, not the failed/blocked/infrastructure shape");

  assert.equal(
    parsed.guidance,
    `forge campaign resume ${planOutput.campaignId}`,
    "awaiting_gate parks reattach cleanly on resume — guidance must stay the bare resume command, not retry"
  );
});
