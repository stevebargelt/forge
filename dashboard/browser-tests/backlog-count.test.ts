// Real-browser regression for the Backlog aggregate result count (dashboard
// main-only fix).
//
// Proves the UI contract: with All type + All status selected the backlog shows
// a single aggregate result count spanning EVERY matching ticket (not the Epic
// group count, not an Epic-only view), and that Epic / Story / Idea / status /
// search selections all recalculate that same count. The multi-type fixture
// makes the aggregate (4) provably differ from the Epic-only count (1) and keeps
// the Story count at its true value (2), so a regression that reported the Epic
// group as the overall count would fail here.
//
// Harness mirrors usage-limits.test.ts: a fixture HTTP server serves the real
// shell + client bundle and canned API payloads; Playwright drives Chrome.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOT_DIR = process.env.BACKLOG_SHOT_DIR;

const projectsFixture = [{
  key: "repo-forge",
  projectDir: "/workspace/forge",
  primaryCheckout: "/workspace/forge",
  projectDirs: ["/workspace/forge"],
  label: "Forge",
  color: "#7a9fff",
  runCount: 4,
  inFlightCount: 0,
  liveSessions: 0,
  lastRunAt: new Date().toISOString(),
  checkouts: [
    { projectDir: "/workspace/forge", projectDirs: ["/workspace/forge"], branch: "main", exists: true, runCount: 4, inFlightCount: 0, liveSessions: 0 },
  ],
}];

// One epic, two stories, one idea — all from the main checkout. Aggregate = 4,
// Epic = 1, Story = 2. One story is done so the status filter has something to
// narrow to. Bodies are empty so search matches only the titles we assert on.
function ticket(id: string, type: string, status: string, title: string) {
  return { id, type, status, title, body: "", epic: null };
}
// FG-608: a payload carrying tickets ALWAYS carries the project_key they belong
// to and the store that is authoritative for them, and the board reads both
// (client/backlog-state.js) — a null key means "never imported" and renders the
// no-truth message INSTEAD of the groups, whatever the ticket array holds. This
// fixture predates those fields, so without them the board legitimately rendered
// zero groups and every count assertion below measured an empty board.
const backlogFixture = {
  notes: "# Main handoff\n\nMain checkout context.",
  notesByCheckout: [],
  ticketsProjectKey: "pk-fixture",
  ticketsStorageMode: "db",
  tickets: [
    ticket("FG-100", "epic", "active", "Alpha epic"),
    ticket("FG-101", "story", "active", "Bravo story"),
    ticket("FG-102", "story", "done", "Charlie story"),
    ticket("FG-103", "idea", "active", "Delta idea"),
  ],
};

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function openBacklog(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open all Forge checkouts" }).click();
  await page.getByRole("button", { name: "backlog" }).click();
  await page.locator(".backlog-result-count").waitFor();
}

async function countText(page: Page): Promise<string> {
  return (await page.locator(".backlog-result-count").innerText()).trim();
}

test("Backlog All/All shows the aggregate result count across every type, not the Epic count", async () => {
  const page = await newPage({ width: 1200, height: 900 });
  await openBacklog(page);

  assert.equal(await countText(page), "4 results", "All/All must aggregate every matching ticket");
  // Not Epic-only: all three type groups render with their own counts.
  const headings = await page.locator(".backlog-group > h2").allTextContents();
  assert.equal(headings.length, 3, "Epic, Story and Idea groups must all render — not Epic-only");
  assert.ok(headings.some((h) => /Epics \(1\)/.test(h)), JSON.stringify(headings));
  assert.ok(headings.some((h) => /Storys \(2\)/.test(h)), JSON.stringify(headings));
  assert.ok(headings.some((h) => /Ideas \(1\)/.test(h)), JSON.stringify(headings));
  // The aggregate (4) must not read as the Epic group count (1).
  assert.notEqual(await countText(page), "1 results");
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "backlog-all-all.png"), fullPage: true });
  await page.close();
});

test("Backlog type / status / search selections all recalculate the same result count", async () => {
  const page = await newPage({ width: 1200, height: 900 });
  await openBacklog(page);

  await page.getByRole("button", { name: "Filter by type: Epic" }).click();
  assert.equal(await countText(page), "1 result of 4", "Epic narrows the aggregate to 1");
  assert.equal((await page.locator(".backlog-group > h2").allTextContents()).length, 1);

  await page.getByRole("button", { name: "Filter by type: Story" }).click();
  assert.equal(await countText(page), "2 results of 4", "Story is not multiplied — exactly 2");
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "backlog-type-story.png"), fullPage: true });

  await page.getByRole("button", { name: "Show all types" }).click();
  assert.equal(await countText(page), "4 results", "clearing the type returns to the full aggregate");

  await page.getByRole("button", { name: "Filter by status: Done" }).click();
  assert.equal(await countText(page), "1 result of 4", "status Done narrows to the single done story");

  await page.getByRole("button", { name: "Show all statuses" }).click();
  assert.equal(await countText(page), "4 results");

  await page.locator("#backlog-search").fill("Delta");
  assert.equal(await countText(page), "1 result of 4", "search narrows to the one matching title");
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "backlog-search-delta.png"), fullPage: true });

  await page.locator("#backlog-search").fill("");
  assert.equal(await countText(page), "4 results", "clearing the search restores the aggregate");
  await page.close();
});

async function newPage(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
      return;
    }
    if (url.pathname.startsWith("/client/")) {
      const filePath = resolve(CLIENT_DIR, url.pathname.slice("/client/".length));
      if (!filePath.startsWith(`${CLIENT_DIR}/`) || !existsSync(filePath)) {
        res.writeHead(404).end();
        return;
      }
      const contentType = filePath.endsWith(".js") ? "application/javascript; charset=utf-8"
        : filePath.endsWith(".png") ? "image/png"
          : filePath.endsWith(".svg") ? "image/svg+xml"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(projectsFixture));
      return;
    }
    if (url.pathname === "/api/backlog") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(backlogFixture));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
