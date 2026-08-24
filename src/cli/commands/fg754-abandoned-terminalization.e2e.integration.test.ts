// FG-754 independent CLI regression. These assertions use the built command and
// persistent SQLite store, rather than the store-level helpers, to pin operator
// transitions and recovery behavior end to end.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { forgeHome, projectDir, runForge, setup, teardown } from "./campaign.support.js";

const AGED = "2026-06-30T00:00:00.000Z";

beforeEach(setup);
afterEach(teardown);

function openDb(): InstanceType<typeof Database> {
  return new Database(join(forgeHome, "forge.db"));
}

function ensureDb(): void {
  const db = openDb();
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.close();
}

function seed(campaignId: string, status: string, lifecycle: string, runStatus: string, ticketId: string): void {
  ensureDb();
  const db = openDb();
  db.prepare("INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at) VALUES (?, ?, 'list', '{}', 'serial', ?, ?)")
    .run(campaignId, status, AGED, AGED);
  db.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, 'feature', ?, ?, ?)")
    .run(`run-${campaignId}`, campaignId, runStatus, AGED);
  db.prepare("INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?, ?, 'build', 'engineer', ?, '{}', ?, ?)")
    .run(`task-${campaignId}`, `run-${campaignId}`, lifecycle === "running" ? "running" : "awaiting_gate", AGED, AGED);
  db.prepare("INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?)")
    .run(`item-${campaignId}`, campaignId, ticketId, `run-${campaignId}`, lifecycle, AGED, AGED);
  db.close();
}

test("FG-754: abandon atomically preserves items, terminals parked runs, and leaves a live container run active", () => {
  const planned = JSON.parse(runForge(["campaign", "plan", "--tickets", "FG-101,FG-102,FG-103", "--project", projectDir, "--json"]).stdout) as { campaignId: string };
  const db = openDb();
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(planned.campaignId);
  const items = db.prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order").all(planned.campaignId) as Array<{ id: string; ticket_id: string }>;
  for (const [index, item] of items.entries()) {
    const runId = `run-atomic-${index}`;
    db.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, 'feature', ?, 'active', ?)").run(runId, runId, AGED);
    db.prepare("INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?, ?, 'build', 'engineer', ?, '{}', ?, ?)")
      .run(`task-atomic-${index}`, runId, index === 2 ? "running" : "awaiting_gate", AGED, AGED);
    db.prepare("UPDATE campaign_items SET run_id = ?, lifecycle_status = ? WHERE id = ?").run(runId, index === 2 ? "running" : "awaiting_gate", item.id);
  }
  const beforeCount = (db.prepare("SELECT COUNT(*) AS count FROM campaign_items WHERE campaign_id = ?").get(planned.campaignId) as { count: number }).count;
  db.close();

  const result = runForge(["campaign", "abandon", planned.campaignId, "--json"]);
  assert.equal(result.status, 0, result.stderr);

  const observed = openDb();
  const campaign = observed.prepare("SELECT status FROM campaigns WHERE id = ?").get(planned.campaignId) as { status: string };
  const after = observed.prepare("SELECT lifecycle_status, outcome, reason FROM campaign_items WHERE campaign_id = ? ORDER BY item_order").all(planned.campaignId) as Array<{ lifecycle_status: string; outcome: string; reason: string | null }>;
  const runs = observed.prepare("SELECT status FROM runs WHERE id LIKE 'run-atomic-%' ORDER BY id").all() as Array<{ status: string }>;
  observed.close();
  assert.equal(campaign.status, "abandoned");
  assert.equal(after.length, beforeCount, "all original item rows are preserved in place");
  for (const item of after.slice(0, 2)) {
    assert.deepEqual({ lifecycle: item.lifecycle_status, outcome: item.outcome }, { lifecycle: "failed", outcome: "failed" });
    assert.match(item.reason ?? "", /^campaign_abandoned/);
  }
  assert.equal(after[2]!.lifecycle_status, "running", "a genuinely running item is not terminalized by abandon");
  assert.deepEqual(runs.map((run) => run.status), ["abandoned", "abandoned", "active"], "only parked runs are flipped");
});

test("FG-754: reaper dry-run identities are exact; live run only reaps abandoned parked work and skips paused/planned/running", () => {
  seed("abandoned-parked", "abandoned", "awaiting_gate", "active", "FG-901");
  seed("abandoned-running", "abandoned", "running", "active", "FG-902");
  seed("paused-parked", "paused", "awaiting_gate", "active", "FG-903");
  seed("planned-parked", "planned", "awaiting_gate", "active", "FG-904");

  const dry = runForge(["campaign", "reap-abandoned", "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const preview = JSON.parse(dry.stdout) as { wouldReap: Array<{ campaignId: string; itemId: string; ticketId: string; lifecycleStatus: string; runId: string; reason: string }> };
  assert.equal(preview.wouldReap.length, 1);
  assert.deepEqual(
    (({ campaignId, itemId, ticketId, lifecycleStatus, runId }) => ({ campaignId, itemId, ticketId, lifecycleStatus, runId }))(preview.wouldReap[0]!),
    { campaignId: "abandoned-parked", itemId: "item-abandoned-parked", ticketId: "FG-901", lifecycleStatus: "awaiting_gate", runId: "run-abandoned-parked" },
  );
  assert.match(preview.wouldReap[0]!.reason, /^campaign_abandoned/);

  let db = openDb();
  assert.equal((db.prepare("SELECT lifecycle_status FROM campaign_items WHERE id = 'item-abandoned-parked'").get() as { lifecycle_status: string }).lifecycle_status, "awaiting_gate", "dry-run does not mutate item state");
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = 'run-abandoned-parked'").get() as { status: string }).status, "active", "dry-run does not mutate run state");
  db.close();

  const reap = runForge(["campaign", "reap-abandoned", "--json"]);
  assert.equal(reap.status, 0, reap.stderr);
  assert.equal((JSON.parse(reap.stdout) as { reaped: unknown[] }).reaped.length, 1);
  const again = runForge(["campaign", "reap-abandoned", "--json"]);
  assert.equal((JSON.parse(again.stdout) as { reaped: unknown[] }).reaped.length, 0, "reaper is idempotent");

  db = openDb();
  const rows = db.prepare("SELECT id, lifecycle_status FROM campaign_items ORDER BY id").all() as Array<{ id: string; lifecycle_status: string }>;
  const states = new Map(rows.map((row) => [row.id, row.lifecycle_status]));
  assert.equal(states.get("item-abandoned-parked"), "failed");
  assert.equal(states.get("item-abandoned-running"), "running", "a live container remains executor-owned");
  assert.equal(states.get("item-paused-parked"), "awaiting_gate", "paused campaigns are never reaped");
  assert.equal(states.get("item-planned-parked"), "awaiting_gate", "planned campaigns are never reaped");
  db.close();
});
