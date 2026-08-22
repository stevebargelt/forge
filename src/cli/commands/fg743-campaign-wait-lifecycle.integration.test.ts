// FG-743: lifecycle filtering has to survive the real operator surfaces, not just
// the in-memory derivation.  This seeds the production-shaped aged rows in SQLite,
// invokes the actual CLI, and proves that Current Activity is filtered while
// campaign show/report continue to expose the immutable audit evidence.

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { NODE_EXEC, BUILT_CLI_ENTRY, REPO_ROOT } from "../../integration-cli-spawn.js";

const AGED_AT = "2026-03-08T12:00:00.000Z";
const PROJECT = "/project/fg743-fixture";

let home = "";
let dbPath = "";

type CurrentActivity = {
  operatorWaits: Array<{
    source: string;
    ticketId: string | null;
    campaignId: string | null;
    reason: string;
    requestedAction: string;
  }>;
};

function forge(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NODE_EXEC, [BUILT_CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: dbPath, NO_NOTIFY: "true" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function seedCampaign(db: Database.Database, id: string, status: string): void {
  db.prepare(`
    INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
    VALUES (?, ?, 'list', '{}', 'sequential', ?, ?, ?)
  `).run(id, status, AGED_AT, AGED_AT, PROJECT);
}

function seedItem(db: Database.Database, opts: {
  id: string;
  campaignId: string;
  ticketId: string;
  reason: string;
  action: string;
}): void {
  db.prepare(`
    INSERT INTO campaign_items (
      id, campaign_id, item_order, ticket_id, lifecycle_status, blocker_kind,
      reason, requested_human_action, created_at, updated_at
    ) VALUES (?, ?, 1, ?, 'awaiting_gate', 'human_decision', ?, ?, ?, ?)
  `).run(opts.id, opts.campaignId, opts.ticketId, opts.reason, opts.action, AGED_AT, AGED_AT);
}

function seedTicket(db: Database.Database, ticketId: string, status: string): void {
  db.prepare(`
    INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at)
    VALUES ('pk-fg743', ?, 'story', ?, ?, '', ?)
  `).run(ticketId, status, `fixture ${ticketId}`, AGED_AT);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fg743-current-activity-"));
  dbPath = join(home, "forge.db");
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  // The three abandoned production rows from the incident.  Their age, park and
  // requested action are intentional: this is historical evidence, not work to do.
  for (const row of [
    ["campaign-7a56519b2f3d", "item-366", "FG-366"],
    ["campaign-e89beee993ec", "item-425", "FG-425"],
    ["campaign-922c83b7c577", "item-422", "FG-422"],
  ] as const) {
    seedCampaign(db, row[0], "abandoned");
    seedItem(db, {
      id: row[1], campaignId: row[0], ticketId: row[2],
      reason: "aged historical hard stop", action: "resolve then resume",
    });
  }

  // FG-472: campaign remains paused, but the ticket is already done and its old
  // instruction says to close it. It must not be projected as live work.
  seedCampaign(db, "campaign-2753b15667d7", "paused");
  seedTicket(db, "FG-472", "done");
  seedItem(db, {
    id: "item-472", campaignId: "campaign-2753b15667d7", ticketId: "FG-472",
    reason: "item done but campaign never resumed", action: "close the ticket",
  });

  // Control: an equally old paused stop whose ticket is still active remains a
  // real operator decision. Age alone is never a reason to hide it.
  seedCampaign(db, "campaign-live-paused", "paused");
  seedTicket(db, "FG-743-live", "active");
  seedItem(db, {
    id: "item-live", campaignId: "campaign-live-paused", ticketId: "FG-743-live",
    reason: "operator must accept or reject the risk", action: "accept the risk or abandon the campaign",
  });
  db.close();
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

test("FG-743 integration: status exposes only an actionable paused wait, while terminal and done-ticket rows remain campaign history", () => {
  const status = forge(["status", "--all", "--read-only", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const activity = (JSON.parse(status.stdout) as { currentActivity: CurrentActivity }).currentActivity;

  assert.deepEqual(
    activity.operatorWaits.filter((wait) => wait.source === "campaign_hard_stop").map((wait) => ({
      ticketId: wait.ticketId, campaignId: wait.campaignId, reason: wait.reason, requestedAction: wait.requestedAction,
    })),
    [{
      ticketId: "FG-743-live", campaignId: "campaign-live-paused",
      reason: "operator must accept or reject the risk", requestedAction: "accept the risk or abandon the campaign",
    }],
  );

  const historical = forge(["campaign", "show", "campaign-2753b15667d7", "--json"]);
  assert.equal(historical.status, 0, historical.stderr);
  const shown = JSON.parse(historical.stdout) as { items: Array<{ ticketId: string; requestedHumanAction: string | null; reason: string | null }> };
  assert.deepEqual(shown.items.map((item) => ({
    ticketId: item.ticketId, requestedHumanAction: item.requestedHumanAction, reason: item.reason,
  })), [{
    ticketId: "FG-472", requestedHumanAction: "close the ticket", reason: "item done but campaign never resumed",
  }], "show retains the stored audit evidence even though Current Activity filters it");

  const report = forge(["campaign", "report", "campaign-7a56519b2f3d", "--json"]);
  assert.equal(report.status, 0, report.stderr);
  const reported = JSON.parse(report.stdout) as { items: Array<{ ticketId: string; requestedHumanAction: string | null; reason: string | null }> };
  assert.deepEqual(reported.items.map((item) => ({
    ticketId: item.ticketId, requestedHumanAction: item.requestedHumanAction, reason: item.reason,
  })), [{
    ticketId: "FG-366", requestedHumanAction: "resolve then resume", reason: "aged historical hard stop",
  }], "report retains abandoned-campaign hard-stop evidence without reviving it as live work");
});
