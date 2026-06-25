import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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
