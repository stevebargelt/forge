// FG-395 browser regression: the real dashboard server reads a seeded campaign
// store and renders both the list row and the blocked item's evidence modal.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium, type Browser, type Page } from "playwright-core";
import { requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18956;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "forge-fg395-browser-"));
const forgeHome = join(home, ".forge");
const projectDir = join(home, "campaign-project");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(projectDir, { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/campaigns.git"], { cwd: projectDir, stdio: "ignore" });
writeFileSync(join(projectDir, "CLAUDE.md"), "<!-- forge:orchestrator-start -->\nfixture\n");

process.env.HOME = home;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = home;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

const { SCHEMA_SQL } = await import("../../src/store/schema.js");
const { applyMigrations, closeDb, setDbForTest } = await import("../../src/store/db.js");
const { createCampaign, addCampaignItem, updateCampaignItem, updateCampaignStatus } = await import("../../src/store/campaigns.js");
const seed = new Database(join(forgeHome, "forge.db"));
seed.exec(SCHEMA_SQL);
applyMigrations(seed);
setDbForTest(seed);
const campaign = createCampaign({
  sourceKind: "list", sourceInput: { tickets: [] }, mode: "serial",
  metadata: { goal: "browser-visible campaign" }, projectDir,
});
updateCampaignStatus(campaign.id, "running");
const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-395-BROWSER" });
updateCampaignItem(item.id, {
  lifecycleStatus: "failed", outcome: "blocked", blockerKind: "scope",
  reason: "blocked evidence is visible to the operator", requestedHumanAction: "approve the launch window",
  branch: "forge/FG-395-BROWSER", worktreePath: "/tmp/fg395-browser-worktree",
});
closeDb();

let browser: Browser;
let server: import("node:http").Server;

before(async () => {
  ({ server } = await import("../src/server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try { await fetch(`${BASE}/`); break; }
    catch (error) {
      if (attempt === 74) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("Campaigns renders a real campaign row and its blocked git/action evidence", async () => {
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/#campaigns`);
  const card = page.getByTestId("campaign-card").filter({ hasText: "browser-visible campaign" });
  await card.waitFor();
  assert.match(await card.innerText(), /running/);

  const detailResponse = page.waitForResponse((response) => response.url().endsWith(`/api/campaign/${campaign.id}`) && response.status() === 200);
  await card.click();
  await detailResponse;
  const blocked = page.getByTestId("campaign-item").filter({ has: page.getByText("FG-395-BROWSER") });
  await blocked.waitFor();
  assert.match(await blocked.innerText(), /blocked evidence is visible to the operator/);
  assert.match(await blocked.innerText(), /approve the launch window/);
  assert.match(await blocked.getByTestId("campaign-git-managed").innerText(), /forge\/FG-395-BROWSER/);
  assert.equal(await blocked.getByTestId("campaign-pr-state").innerText(), "no PR");
  await page.close();
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
});

test("Campaigns card and its detail close are keyboard-operable (RF-2, RF-3)", async () => {
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/#campaigns`);

  // RF-2: the campaign card is a real, focusable control — a keyboard user opens the
  // evidence with Enter, no pointer involved.
  const card = page.getByTestId("campaign-card").filter({ hasText: "browser-visible campaign" });
  await card.waitFor();
  assert.equal(await card.getAttribute("role"), "button", "the card announces itself as a control");
  assert.equal(await card.getAttribute("tabindex"), "0", "the card is reachable by Tab");

  const detailResponse = page.waitForResponse((response) => response.url().endsWith(`/api/campaign/${campaign.id}`) && response.status() === 200);
  await card.focus();
  await page.keyboard.press("Enter");
  await detailResponse;
  await page.getByTestId("campaign-item").waitFor();

  // RF-3: the overlay close is a <button> with an accessible name, operable by keyboard.
  const close = page.getByRole("button", { name: "close" });
  await close.waitFor();
  await close.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("campaign-item").waitFor({ state: "detached" });

  await page.close();
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
});
