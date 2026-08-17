// FG-395: GET /api/campaigns (list) and GET /api/campaign/:id (detail). Boots the
// real dashboard server against a seeded temp store and pins that BOTH routes reuse
// the campaign report contract (assembleCampaignSummaries / assembleCampaignReport)
// rather than re-deriving anything in dashboard SQL.
//
// Seeding goes through the STORE API (createCampaign/addCampaignItem/updateCampaignItem)
// under setDbForTest, not a raw-table INSERT: assembleCampaignReport reads through
// src/store, so a minimal raw seed would not exercise the same path. Done-audit is
// injected with setDoneAuditMapForTest so a blocked item carries real git/PR evidence
// (a derived push state) with no git repo on disk.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { applyMigrations, setDbForTest } from "../../src/store/db.js";
import { createCampaign, addCampaignItem, updateCampaignItem, updateCampaignStatus } from "../../src/store/campaigns.js";
import { setDoneAuditMapForTest } from "../../src/campaign/report.js";
import type { DoneAuditResult } from "../../src/done-audit/done-audit.js";

const TEST_PORT = 18795;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tmpHome = mkdtempSync(join(tmpdir(), "forge-campaigns-route-"));

let alphaId = "";
let betaId = "";

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  setDbForTest(db);

  // Campaign ALPHA: a running campaign with a shipped item, a blocked item carrying
  // a blocker reason + requested human action + git/PR evidence, and a pending "next".
  const alpha = createCampaign({
    sourceKind: "epic",
    sourceInput: { epicId: "FG-ALPHA" },
    mode: "serial",
    metadata: { goal: "ship alpha" },
    projectDir: "/proj/alpha",
  });
  alphaId = alpha.id;
  updateCampaignStatus(alphaId, "running");

  const shipped = addCampaignItem({ campaignId: alphaId, itemOrder: 0, ticketId: "FG-101" });
  updateCampaignItem(shipped.id, {
    lifecycleStatus: "complete",
    outcome: "shipped",
    runId: "run-alpha-1",
    branch: "forge/FG-101",
    worktreePath: "/tmp/wt/FG-101",
  });

  const blocked = addCampaignItem({ campaignId: alphaId, itemOrder: 1, ticketId: "FG-102" });
  updateCampaignItem(blocked.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "scope",
    reason: "item outgrew its scope — needs a re-plan",
    requestedHumanAction: "re-plan FG-102 and resume the campaign",
    branch: "forge/FG-102",
    worktreePath: "/tmp/wt/FG-102",
  });

  addCampaignItem({ campaignId: alphaId, itemOrder: 2, ticketId: "FG-103" }); // pending → the "next" item

  // Campaign BETA: a different project, for the scope-filter check.
  const beta = createCampaign({
    sourceKind: "epic",
    sourceInput: { epicId: "FG-BETA" },
    mode: "serial",
    metadata: { goal: "ship beta" },
    projectDir: "/proj/beta",
  });
  betaId = beta.id;

  // Inject a done-audit for the blocked item so its git evidence carries a REAL,
  // derived push state (pushed=fail → not_pushed) with no git repo on disk.
  const doneAudit = new Map<string, DoneAuditResult>();
  doneAudit.set("FG-102", {
    outcome: "fail",
    checks: [{ name: "pushed", status: "fail" }],
    gaps: ["FG-102 not pushed"],
    requestedAction: null,
  });
  setDoneAuditMapForTest(doneAudit);
}

process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { server } = await import("./server.js");

after(() => {
  setDoneAuditMapForTest(null);
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/campaigns`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error("campaigns test server did not start");
}

await waitForServer();

test("GET /api/campaigns returns cheap summaries and filters by owner project", async () => {
  const res = await fetch(`${BASE}/api/campaigns?projectDir=/proj/alpha`);
  assert.equal(res.status, 200);
  const body = await res.json() as { campaigns: Array<Record<string, any>>; error?: string };
  assert.equal(body.error, undefined);
  assert.equal(body.campaigns.length, 1, "only the /proj/alpha campaign matches");

  const summary = body.campaigns[0]!;
  assert.equal(summary.campaignId, alphaId);
  assert.equal(summary.goal, "ship alpha");
  assert.equal(summary.status, "running");
  assert.equal(summary.mode, "serial");
  assert.equal(summary.verdict, "not_complete");
  assert.equal(summary.projectDir, "/proj/alpha");
  assert.deepEqual(summary.counts, { shipped: 1, blocked: 1, held: 0, skipped: 0, failed: 0, total: 3 });
  // The pending item is the running/next item surfaced as current.
  assert.equal(summary.currentItem.ticketId, "FG-103");
});

test("GET /api/campaigns scopes to the requested project and lists all when unscoped", async () => {
  const beta = await (await fetch(`${BASE}/api/campaigns?projectDir=/proj/beta`)).json() as { campaigns: Array<{ campaignId: string }> };
  assert.deepEqual(beta.campaigns.map((c) => c.campaignId), [betaId]);

  const all = await (await fetch(`${BASE}/api/campaigns`)).json() as { campaigns: Array<{ campaignId: string }> };
  const ids = all.campaigns.map((c) => c.campaignId);
  assert.ok(ids.includes(alphaId) && ids.includes(betaId), "an unscoped list carries every project's campaigns");

  const limited = await (await fetch(`${BASE}/api/campaigns?limit=1`)).json() as { campaigns: unknown[] };
  assert.equal(limited.campaigns.length, 1, "limit clamps the row count");

  // A non-numeric limit must not read as an empty list: NaN would slice to 0 rows and
  // report success (RF-1). It falls back to the default, so the full list still lists.
  const garbage = await (await fetch(`${BASE}/api/campaigns?limit=abc`)).json() as { campaigns: unknown[] };
  assert.equal(garbage.campaigns.length, ids.length, "a garbage limit falls back to the default, not an empty list");
});

test("GET /api/campaign/:id is the full report for a blocked item with git/PR evidence", async () => {
  const res = await fetch(`${BASE}/api/campaign/${alphaId}`);
  assert.equal(res.status, 200);
  const report = await res.json() as {
    campaignId: string; status: string; verdict: string;
    groupings: Record<string, string[]>;
    items: Array<Record<string, any>>;
    nextOperatorAction: string;
  };

  assert.equal(report.campaignId, alphaId);
  assert.equal(report.status, "running");
  assert.equal(report.verdict, "not_complete");
  assert.deepEqual(report.groupings.shipped, ["FG-101"]);
  assert.deepEqual(report.groupings.blocked, ["FG-102"]);
  assert.equal(report.items.length, 3);
  assert.equal(typeof report.nextOperatorAction, "string");

  const blocked = report.items.find((i) => i.ticketId === "FG-102")!;
  assert.equal(blocked.lifecycleStatus, "failed");
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.blockerKind, "scope");
  assert.match(blocked.reason, /outgrew its scope/);
  assert.match(blocked.requestedHumanAction, /re-plan FG-102/);
  // Git / PR evidence — worktree-managed, no PR (literal null), derived push state.
  assert.equal(blocked.branch, "forge/FG-102");
  assert.equal(blocked.worktreePath, "/tmp/wt/FG-102");
  assert.equal(blocked.prUrl, null, "prUrl is a literal null — never a fabricated link");
  assert.ok(blocked.doneAuditState, "the injected done-audit is surfaced");
  const pushed = blocked.doneAuditState.checks.find((c: { name: string }) => c.name === "pushed");
  assert.equal(pushed.status, "fail", "the pushed check drives the client's not_pushed state");
});

test("GET /api/campaign/:id returns 404 JSON for an unknown id", async () => {
  const res = await fetch(`${BASE}/api/campaign/camp-does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json() as { error: string };
  assert.match(body.error, /not found/);
});
