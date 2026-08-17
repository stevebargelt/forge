// FG-395 regression coverage beyond the route smoke tests: this fixture uses a
// real on-disk store and registered Git checkouts, so owner resolution, the
// read-only store scope, and the dashboard HTTP boundary all participate.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const PORT = 18955;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "forge-campaigns-coverage-"));
const forgeHome = join(home, ".forge");
const checkouts = join(home, "checkouts");
const alphaDir = join(checkouts, "alpha");
const betaDir = join(checkouts, "beta");

mkdirSync(forgeHome, { recursive: true });
mkdirSync(checkouts, { recursive: true });
for (const [dir, remote] of [[alphaDir, "alpha"], [betaDir, "beta"]] as const) {
  mkdirSync(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", `git@github.com:acme/${remote}.git`], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "CLAUDE.md"), "<!-- forge:orchestrator-start -->\nfixture\n");
}

process.env.HOME = home;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = checkouts;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

const { SCHEMA_SQL } = await import("../../src/store/schema.js");
const { applyMigrations, closeDb, getDb, runInReadOnlyDbScope, setDbForTest } = await import("../../src/store/db.js");
const { createCampaign, addCampaignItem, updateCampaignItem, updateCampaignStatus } = await import("../../src/store/campaigns.js");

const dbPath = join(forgeHome, "forge.db");
const seedDb = new Database(dbPath);
seedDb.pragma("foreign_keys = ON");
seedDb.exec(SCHEMA_SQL);
applyMigrations(seedDb);
setDbForTest(seedDb);

const complete = createCampaign({
  sourceKind: "list", sourceInput: { tickets: [] }, mode: "serial",
  metadata: { goal: "all outcomes" }, projectDir: alphaDir,
});
updateCampaignStatus(complete.id, "running");
for (const [order, ticketId, lifecycleStatus, outcome] of [
  [0, "FG-395-SHIP", "complete", "shipped"],
  [1, "FG-395-BLOCK", "failed", "blocked"],
  [2, "FG-395-HOLD", "pending", "held"],
  [3, "FG-395-SKIP", "complete", "skipped"],
  [4, "FG-395-FAIL", "failed", "needs_refinement"],
] as const) {
  const item = addCampaignItem({ campaignId: complete.id, itemOrder: order, ticketId });
  updateCampaignItem(item.id, { lifecycleStatus, outcome });
}
updateCampaignStatus(complete.id, "complete");

const running = createCampaign({
  sourceKind: "list", sourceInput: { tickets: [] }, mode: "serial",
  metadata: { goal: "checkpoint" }, projectDir: alphaDir,
});
updateCampaignStatus(running.id, "running");
const evidence = addCampaignItem({ campaignId: running.id, itemOrder: 0, ticketId: "FG-395-EVIDENCE" });
updateCampaignItem(evidence.id, {
  lifecycleStatus: "failed", outcome: "blocked", blockerKind: "scope",
  reason: "needs an operator decision", requestedHumanAction: "choose the rollout owner",
  branch: "forge/FG-395-EVIDENCE", worktreePath: "/tmp/fg395-worktree",
});

// More than two matching rows proves the route truncates rather than merely
// passing an arbitrary limit through to the store.
for (let n = 0; n < 3; n += 1) {
  createCampaign({ sourceKind: "list", sourceInput: { tickets: [] }, mode: "serial", projectDir: alphaDir });
}
const beta = createCampaign({ sourceKind: "list", sourceInput: { tickets: [] }, mode: "serial", projectDir: betaDir });

// Dispose the writable test singleton before the route is imported. The server's
// no-argument store reads must now reopen this same file through the read-only path.
closeDb();

test("runInReadOnlyDbScope forces a no-argument store read onto a non-writing handle", () => {
  const readOnly = runInReadOnlyDbScope(() => getDb());
  assert.throws(
    () => readOnly.exec("CREATE TABLE fg395_must_not_be_created (id INTEGER)"),
    /readonly|attempt to write/i,
  );
  closeDb();
});

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try { await fetch(`${BASE}/api/projects`); return; }
    catch (error) {
      if (attempt === 74) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}

await waitForServer();

type Summary = { campaignId: string; verdict: string; counts: Record<string, number>; currentItem: { ticketId: string } | null };
type Report = {
  campaignId: string; status: string; verdict: string;
  groupings: Record<"shipped" | "blocked" | "held" | "skipped" | "failed", string[]>;
  items: Array<Record<string, unknown>>;
};

test("campaign owner resolution by projectKey matches projectDir and a clamped limit truncates", async () => {
  const projects = await (await fetch(`${BASE}/api/projects`)).json() as Array<{ key: string; projectDirs: string[] }>;
  const alpha = projects.find((project) => project.projectDirs.includes(alphaDir));
  assert.ok(alpha, "fixture checkout is registered by the dashboard");

  const byDir = await (await fetch(`${BASE}/api/campaigns?projectDir=${encodeURIComponent(alphaDir)}&limit=2`)).json() as { campaigns: Summary[] };
  const byKey = await (await fetch(`${BASE}/api/campaigns?projectKey=${encodeURIComponent(alpha.key)}&limit=2`)).json() as { projectKey: string; campaigns: Summary[] };
  assert.equal(byKey.projectKey, alpha.key);
  assert.equal(byDir.campaigns.length, 2);
  assert.deepEqual(byKey.campaigns.map((campaign) => campaign.campaignId), byDir.campaigns.map((campaign) => campaign.campaignId));
  assert.ok(byDir.campaigns.every((campaign) => campaign.campaignId !== beta.id), "another owner's campaign never leaks into alpha");
});

test("list summary counts and verdict are the same derivation as the complete detail report", async () => {
  const list = await (await fetch(`${BASE}/api/campaigns?projectDir=${encodeURIComponent(alphaDir)}&limit=200`)).json() as { campaigns: Summary[] };
  const summary = list.campaigns.find((campaign) => campaign.campaignId === complete.id);
  assert.ok(summary);
  assert.deepEqual(summary.counts, { shipped: 1, blocked: 1, held: 1, skipped: 1, failed: 1, total: 5 });
  assert.equal(summary.currentItem?.ticketId, "FG-395-HOLD");

  const detail = await (await fetch(`${BASE}/api/campaign/${complete.id}`)).json() as Report;
  assert.equal(detail.status, "complete");
  assert.equal(summary.verdict, detail.verdict);
  assert.deepEqual(summary.counts, {
    shipped: detail.groupings.shipped.length, blocked: detail.groupings.blocked.length,
    held: detail.groupings.held.length, skipped: detail.groupings.skipped.length,
    failed: detail.groupings.failed.length, total: detail.items.length,
  });
});

test("a running checkpoint and final report distinguish verdicts, while blocker evidence survives detail serialization", async () => {
  const checkpoint = await (await fetch(`${BASE}/api/campaign/${running.id}`)).json() as Report;
  const final = await (await fetch(`${BASE}/api/campaign/${complete.id}`)).json() as Report;
  assert.equal(checkpoint.status, "running");
  assert.equal(checkpoint.verdict, "not_complete");
  assert.equal(final.status, "complete");
  assert.notEqual(final.verdict, checkpoint.verdict);

  const item = checkpoint.items.find((row) => row.ticketId === "FG-395-EVIDENCE")!;
  assert.equal(item.reason, "needs an operator decision");
  assert.equal(item.requestedHumanAction, "choose the rollout owner");
  assert.equal(item.branch, "forge/FG-395-EVIDENCE");
  assert.equal(item.worktreePath, "/tmp/fg395-worktree");
  assert.equal(item.prUrl, null);
});
