// FG-743 E2E: the Home dashboard must render the shared Current Activity result,
// without a client-side exception that revives old campaign waits.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";
import { makeInMemoryDb } from "../../src/store/db.js";
import { deriveCurrentActivity, type CurrentActivity } from "../../src/v2/current-activity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const NOW = new Date("2026-08-22T12:00:00.000Z");
const AGED_AT = "2026-03-08T12:00:00.000Z";
const PROJECT = "/repos/forge";

function activityFromProductionShape(): CurrentActivity {
  const db = makeInMemoryDb();
  const campaign = (id: string, status: string) => db.prepare(`
    INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
    VALUES (?, ?, 'list', '{}', 'sequential', ?, ?, ?)
  `).run(id, status, AGED_AT, AGED_AT, PROJECT);
  const item = (id: string, campaignId: string, ticketId: string, reason: string, action: string) => db.prepare(`
    INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, lifecycle_status, blocker_kind, reason, requested_human_action, created_at, updated_at)
    VALUES (?, ?, 1, ?, 'awaiting_gate', 'human_decision', ?, ?, ?, ?)
  `).run(id, campaignId, ticketId, reason, action, AGED_AT, AGED_AT);
  const ticket = (id: string, status: string) => db.prepare(`
    INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at)
    VALUES ('pk-fg743', ?, 'story', ?, ?, '', ?)
  `).run(id, status, `fixture ${id}`, AGED_AT);

  for (const [campaignId, itemId, ticketId] of [
    ["campaign-7a56519b2f3d", "item-366", "FG-366"],
    ["campaign-e89beee993ec", "item-425", "FG-425"],
    ["campaign-922c83b7c577", "item-422", "FG-422"],
  ]) {
    campaign(campaignId, "abandoned");
    item(itemId, campaignId, ticketId, "aged historical hard stop", "resolve then resume");
  }
  campaign("campaign-2753b15667d7", "paused");
  ticket("FG-472", "done");
  item("item-472", "campaign-2753b15667d7", "FG-472", "item done but campaign never resumed", "close the ticket");

  campaign("campaign-live-paused", "paused");
  ticket("FG-743-live", "active");
  item("item-live", "campaign-live-paused", "FG-743-live", "operator must accept or reject the risk", "accept the risk or abandon the campaign");
  try {
    return deriveCurrentActivity(db, { now: NOW });
  } finally {
    db.close();
  }
}

const served = activityFromProductionShape();
let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
    if (url.pathname.startsWith("/client/")) {
      const file = resolve(CLIENT_DIR, url.pathname.slice("/client/".length));
      if (!file.startsWith(`${CLIENT_DIR}/`) || !existsSync(file)) return void res.writeHead(404).end();
      return void res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "application/javascript" : "application/octet-stream" }).end(readFileSync(file));
    }
    if (url.pathname === "/api/current-activity") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(served));
    if (url.pathname === "/api/in-flight") return void res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
    if (url.pathname === "/api/usage/limits") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ generatedAt: NOW.toISOString(), services: [] }));
    if (url.pathname === "/api/ops") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ runs: {}, taskCount: 0, counts: {}, failureKinds: [], durations: [] }));
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((done) => server?.close(() => done()));
});

test("FG-743 E2E: Home and Activity show only the unresolved paused campaign wait", async () => {
  assert.deepEqual(served.operatorWaits.map((wait) => wait.ticketId), ["FG-743-live"], "fixture reaches the browser through the shared derivation");
  const page = await browser.newPage({ viewport: { width: 1280, height: 862 } });
  await page.goto(`${baseUrl}/`);
  await page.locator("section.home-view section.in-flight .ca-operator-wait-row").waitFor();

  const home = await page.locator("section.home-view section.in-flight").innerText();
  assert.match(home, /FG-743-live/);
  assert.match(home, /accept the risk or abandon the campaign/);
  for (const historical of ["FG-366", "FG-425", "FG-422", "FG-472", "close the ticket"]) {
    assert.doesNotMatch(home, new RegExp(historical), `${historical} is history, not Home in-flight work`);
  }

  await page.goto(`${baseUrl}/#activity`);
  const section = page.locator("section.current-activity section.ca-section", { has: page.locator(".ca-operator-wait-row") });
  await section.locator(".ca-operator-wait-row").waitFor();
  const activity = await section.innerText();
  assert.match(activity, /FG-743-live/);
  assert.equal(await section.locator(".ca-operator-wait-row").count(), 1, "the dashboard renders the filtered shared set without a client-only exception");
  await page.close();
});
