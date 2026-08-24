// FG-754 (steps 2 & 5, end-to-end via the CLI): abandoning a campaign terminalizes its
// non-terminal items + parked runs atomically, and `forge campaign reap-abandoned` cleans
// up items ORPHANED by a pre-fix abandon. Pins:
//   - `forge campaign abandon` terminalizes items and flips the parked linked run;
//   - `reap-abandoned --dry-run` lists identities and mutates NOTHING;
//   - `reap-abandoned` terminalizes only abandoned-campaign non-terminal items, idempotent;
//   - a PAUSED campaign's items are NEVER touched (AC4).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { setup, teardown, runForge, forgeHome, projectDir } from "./campaign.support.js";

beforeEach(setup);
afterEach(teardown);

function db(): InstanceType<typeof Database> {
  return new Database(join(forgeHome, "forge.db"));
}

// campaign.support.setup() does not create forge.db — the first CLI run does. The reap
// tests inject state BEFORE any CLI run, so materialize the migrated schema first.
function ensureDb(): void {
  const d = db();
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA_SQL);
  applyMigrations(d);
  d.close();
}

const NOW = "2026-06-30T00:00:00.000Z";

/** Inject a campaign with one non-terminal item parked on an active run — the shape the
 *  leak keys on. Mirrors the live example (an aged awaiting_gate item on an active run). */
function injectCampaignWithParkedItem(opts: { campaignId: string; status: string; runStatus?: string }): void {
  ensureDb();
  const d = db();
  d.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at) VALUES (?, ?, 'list', '{}', 'serial', ?, ?)`
  ).run(opts.campaignId, opts.status, NOW, NOW);
  const runId = `run-${opts.campaignId}`;
  d.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, 'feature', ?, ?, ?)`).run(
    runId,
    opts.campaignId,
    opts.runStatus ?? "active",
    NOW
  );
  d.prepare(
    `INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, created_at, updated_at)
     VALUES (?, ?, 0, 'FG-1', ?, 'awaiting_gate', ?, ?)`
  ).run(`item-${opts.campaignId}`, opts.campaignId, runId, NOW, NOW);
  d.close();
}

test("integ FG-754: campaign abandon terminalizes items and flips the parked run atomically", () => {
  const planOut = JSON.parse(
    runForge(["campaign", "plan", "--tickets", "FG-101", "--project", projectDir, "--json"]).stdout
  ) as { campaignId: string };
  const campaignId = planOut.campaignId;

  // Drive the item to awaiting_gate on an active linked run (the leak shape).
  {
    const d = db();
    d.prepare(`UPDATE campaigns SET status = 'running' WHERE id = ?`).run(campaignId);
    const runId = `run-${campaignId}`;
    d.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, 'feature', ?, 'active', ?)`).run(
      runId,
      campaignId,
      NOW
    );
    d.prepare(`UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', run_id = ? WHERE campaign_id = ?`).run(
      runId,
      campaignId
    );
    d.close();
  }

  const abandon = runForge(["campaign", "abandon", campaignId, "--json"]);
  assert.equal(abandon.status, 0, `abandon failed: ${abandon.stderr}`);
  const out = JSON.parse(abandon.stdout) as { status: string; itemsTerminalized: unknown[]; runsAbandoned: number };
  assert.equal(out.status, "abandoned");
  assert.equal(out.itemsTerminalized.length, 1);
  assert.equal(out.runsAbandoned, 1);

  const d = db();
  const item = d.prepare(`SELECT lifecycle_status, outcome, reason FROM campaign_items WHERE campaign_id = ?`).get(
    campaignId
  ) as { lifecycle_status: string; outcome: string; reason: string };
  const run = d.prepare(`SELECT status FROM runs WHERE id = ?`).get(`run-${campaignId}`) as { status: string };
  d.close();
  assert.equal(item.lifecycle_status, "failed");
  assert.equal(item.outcome, "failed");
  assert.ok(item.reason.startsWith("campaign_abandoned"));
  assert.equal(run.status, "abandoned");
});

test("integ FG-754: reap-abandoned --dry-run lists identities and mutates nothing", () => {
  injectCampaignWithParkedItem({ campaignId: "camp-orphan", status: "abandoned" });

  const dry = runForge(["campaign", "reap-abandoned", "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { dryRun: boolean; wouldReap: Array<Record<string, unknown>> };
  assert.equal(out.dryRun, true);
  assert.equal(out.wouldReap.length, 1);
  assert.equal(out.wouldReap[0]!["campaignId"], "camp-orphan");
  assert.equal(out.wouldReap[0]!["itemId"], "item-camp-orphan");
  assert.equal(out.wouldReap[0]!["lifecycleStatus"], "awaiting_gate");
  assert.equal(out.wouldReap[0]!["runId"], "run-camp-orphan");
  assert.ok(String(out.wouldReap[0]!["reason"]).startsWith("campaign_abandoned"));

  // Nothing changed.
  const d = db();
  const item = d.prepare(`SELECT lifecycle_status FROM campaign_items WHERE id = 'item-camp-orphan'`).get() as {
    lifecycle_status: string;
  };
  const run = d.prepare(`SELECT status FROM runs WHERE id = 'run-camp-orphan'`).get() as { status: string };
  d.close();
  assert.equal(item.lifecycle_status, "awaiting_gate", "dry-run mutated nothing");
  assert.equal(run.status, "active", "dry-run mutated nothing");
});

test("integ FG-754: reap-abandoned terminalizes only abandoned items, is idempotent, and never touches a paused campaign", () => {
  injectCampaignWithParkedItem({ campaignId: "camp-dead", status: "abandoned" });
  injectCampaignWithParkedItem({ campaignId: "camp-paused", status: "paused" });

  const reap = runForge(["campaign", "reap-abandoned", "--json"]);
  assert.equal(reap.status, 0, reap.stderr);
  const out = JSON.parse(reap.stdout) as { reaped: unknown[]; runsAbandoned: number };
  assert.equal(out.reaped.length, 1);
  assert.equal(out.runsAbandoned, 1);

  const d = db();
  const dead = d.prepare(`SELECT lifecycle_status FROM campaign_items WHERE id = 'item-camp-dead'`).get() as {
    lifecycle_status: string;
  };
  const deadRun = d.prepare(`SELECT status FROM runs WHERE id = 'run-camp-dead'`).get() as { status: string };
  const paused = d.prepare(`SELECT lifecycle_status FROM campaign_items WHERE id = 'item-camp-paused'`).get() as {
    lifecycle_status: string;
  };
  d.close();
  assert.equal(dead.lifecycle_status, "failed");
  assert.equal(deadRun.status, "abandoned");
  assert.equal(paused.lifecycle_status, "awaiting_gate", "AC4: a paused campaign's items are never reaped");

  // Idempotent: a second run finds nothing.
  const again = JSON.parse(runForge(["campaign", "reap-abandoned", "--json"]).stdout) as { reaped: unknown[] };
  assert.equal(again.reaped.length, 0);
});
