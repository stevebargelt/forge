// FG-832 — the Backlog view opens on every type, active status only, with both
// defaults shown SELECTED; the filter lives in `#backlog?type=<t>&status=<s>` so a
// reload restores it; the header counts "N of M tickets"; the controls are keyboard
// operable and announce their pressed state (FG-692).
//
// A fixture HTTP server serves the real shell + client bundle and a canned backlog.
// Screenshots go to a fresh temp dir unless FG832_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18836;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SHOTS = process.env.FG832_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg832-screenshots-"));
if (process.env.FG832_SCREENSHOT_DIR) mkdirSync(SHOTS, { recursive: true });

const projectsFixture = [{
  key: "repo-forge",
  projectDir: "/workspace/forge",
  primaryCheckout: "/workspace/forge",
  projectDirs: ["/workspace/forge"],
  label: "Forge",
  color: "#7a9fff",
  runCount: 0,
  inFlightCount: 0,
  liveSessions: 0,
  lastRunAt: new Date().toISOString(),
  checkouts: [
    { projectDir: "/workspace/forge", projectDirs: ["/workspace/forge"], branch: "main", exists: true, runCount: 0, inFlightCount: 0, liveSessions: 0 },
  ],
}];

function ticket(id: string, type: string, status: string, title: string) {
  return { id, type, status, title, body: "", epic: null };
}
const backlogFixture = {
  notes: "",
  notesByCheckout: [],
  ticketsProjectKey: "repo-forge",
  ticketsStorageMode: "db",
  // Complete type × status matrix: the default must retain every active type.
  tickets: [
    ticket("FG-100", "epic", "active", "active epic"),
    ticket("FG-101", "epic", "blocked", "blocked epic"),
    ticket("FG-102", "epic", "deferred", "deferred epic"),
    ticket("FG-103", "epic", "done", "done epic"),
    ticket("FG-104", "story", "active", "active story"),
    ticket("FG-105", "story", "blocked", "blocked story"),
    ticket("FG-106", "story", "deferred", "deferred story"),
    ticket("FG-107", "story", "done", "done story"),
    ticket("FG-108", "idea", "active", "active idea"),
    ticket("FG-109", "idea", "blocked", "blocked idea"),
    ticket("FG-110", "idea", "deferred", "deferred idea"),
    ticket("FG-111", "idea", "done", "done idea"),
  ],
};
const ACTIVE = ["FG-100", "FG-104", "FG-108"];
const DONE = ["FG-103", "FG-107", "FG-111"];

let server: Server;
let browser: Browser;
let backlogRequests = 0;
const BASE = `http://127.0.0.1:${PORT}`;

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(PORT, "127.0.0.1", ready));
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function open(hash: string, viewport = { width: 1200, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  await page.goto(`${BASE}/${hash}`);
  await page.locator(".backlog-result-count").waitFor();
  return page;
}

async function shownIds(page: Page): Promise<string[]> {
  return (await page.locator(".backlog-id").allTextContents()).map((s) => s.trim()).sort();
}

// The hash lands before Preact re-renders; wait for the board to show `expected`.
async function expectIds(page: Page, expected: string[], message?: string): Promise<void> {
  const want = JSON.stringify(expected);
  await page.waitForFunction((w) => JSON.stringify(Array.from(document.querySelectorAll(".backlog-id")).map((e) => (e.textContent ?? "").trim()).sort()) === w, want, { timeout: 5000 })
    .catch(() => undefined);
  assert.deepEqual(await shownIds(page), expected, message);
}

async function pressed(page: Page, name: string): Promise<string | null> {
  return page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
}

async function countText(page: Page): Promise<string> {
  return (await page.locator(".backlog-result-count").innerText()).trim();
}

test("FG-832: a fresh mixed type × status fixture shows exactly every active type, selected and counted N of M", async () => {
  const page = await open("#backlog?project=repo-forge");
  await expectIds(page, ACTIVE, "only active tickets render by default");
  assert.equal(await pressed(page, "Show all types"), "true", "type All is shown selected");
  assert.equal(await pressed(page, "Filter by status: Active"), "true", "status Active is shown selected");
  assert.equal(await pressed(page, "Show all statuses"), "false", "the default is not 'no filter'");
  for (const name of ["Filter by type: Epic", "Filter by status: Done"]) assert.equal(await pressed(page, name), "false", name);
  assert.equal(await page.locator(".usage-dim-btn-active").count(), 2, "exactly one type and one status control selected");
  assert.equal(await countText(page), "3 of 12 tickets", "every non-active status is hidden but remains counted");
  const backlogBadge = page.locator('.nav-column a[data-view="backlog"] .nav-badge');
  // No Backlog badge is currently rendered. If one is added, it must match the same
  // active-only total as the default header, never all stored tickets.
  assert.ok(await backlogBadge.count() === 0 || await backlogBadge.innerText() === "3",
    "any left-column Backlog badge agrees with the active-only header count");
  assert.equal(await page.evaluate(() => location.hash), "#backlog?project=repo-forge", "the default hash stays bare");
  await page.screenshot({ path: join(SHOTS, "fg832-backlog-default.png"), fullPage: true });
  await page.close();
});

test("FG-832: choosing Done shows the done tickets, writes the hash, and a reload restores it", async () => {
  const page = await open("#backlog?project=repo-forge");
  await page.getByRole("button", { name: "Filter by status: Done", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#backlog?project=repo-forge&status=done");
  await expectIds(page, DONE);
  assert.equal(await pressed(page, "Filter by status: Done"), "true");
  assert.equal(await pressed(page, "Filter by status: Active"), "false");
  assert.equal(await countText(page), "3 of 12 tickets");
  assert.deepEqual(await page.locator(".usage-dim-btn-active").allTextContents(), ["All", "Done"], "the selected styling moves with the filter");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250); // let the buttons' 0.1s colour transition settle for the screenshot
  await page.screenshot({ path: join(SHOTS, "fg832-backlog-done.png"), fullPage: true });

  await page.getByRole("button", { name: "Filter by type: Story", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#backlog?project=repo-forge&type=story&status=done");
  await expectIds(page, ["FG-107"]);

  await page.reload();
  await page.locator(".backlog-result-count").waitFor();
  await expectIds(page, ["FG-107"], "reload restores type and status");
  assert.equal(await pressed(page, "Filter by type: Story"), "true");
  assert.equal(await pressed(page, "Filter by status: Done"), "true");
  assert.equal(await countText(page), "1 of 12 tickets");

  await page.getByRole("button", { name: "Show all statuses", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#backlog?project=repo-forge&type=story&status=all");
  await expectIds(page, ["FG-104", "FG-105", "FG-106", "FG-107"]);
  await page.close();
});

test("FG-832: a pasted link restores its filter; unknown values fall back silently; a ticket deep link is unaffected", async () => {
  const pasted = await open("#backlog?project=repo-forge&type=idea&status=all");
  await expectIds(pasted, ["FG-108", "FG-109", "FG-110", "FG-111"]);
  assert.equal(await pressed(pasted, "Filter by type: Idea"), "true");
  assert.equal(await pressed(pasted, "Show all statuses"), "true");
  await pasted.close();

  const unknown = await open("#backlog?project=repo-forge&type=bogus&status=nope");
  await unknown.waitForFunction(() => location.hash === "#backlog?project=repo-forge");
  await expectIds(unknown, ACTIVE);
  assert.equal(await pressed(unknown, "Filter by status: Active"), "true");
  assert.equal(await unknown.locator(".view-notice, [role=alert]").count(), 0, "no notice for an unknown filter value");

  await unknown.locator(".backlog-ticket-card").first().click();
  await unknown.waitForFunction(() => location.hash === "#backlog/FG-100?project=repo-forge");
  await unknown.close();

  const deep = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await deep.goto(`${BASE}/#backlog/FG-107?project=repo-forge&status=done`);
  await deep.waitForFunction(() => location.hash === "#backlog/FG-107?project=repo-forge");
  await deep.getByText("done story").first().waitFor();
  await deep.close();
});

test("FG-832 / FG-692: Tab reaches the filter controls, Enter and Space operate them, and the state is announced", async () => {
  const page = await open("#backlog?project=repo-forge");
  const done = page.getByRole("button", { name: "Filter by status: Done", exact: true });
  await page.getByRole("button", { name: "Filter by status: Deferred", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await done.evaluate((el) => el === document.activeElement), true, "Tab moves to the next filter control");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#backlog?project=repo-forge&status=done");
  await expectIds(page, DONE);
  assert.equal(await pressed(page, "Filter by status: Done"), "true");

  await page.getByRole("button", { name: "Filter by status: Active", exact: true }).focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => location.hash === "#backlog?project=repo-forge");
  await expectIds(page, ACTIVE);

  const group = page.getByRole("group", { name: "status:" });
  assert.equal(await group.getByRole("button").count(), 5, "the status controls are one labelled group");
  assert.equal(await page.getByRole("group", { name: "type:" }).getByRole("button").count(), 4);
  assert.equal(await page.locator(".backlog-result-count").getAttribute("aria-live"), "polite", "the count change is announced");
  await page.close();
});

test("FG-832: scoped filter clicks preserve the FG-820 project scope, reload restores it, and filters do not re-fetch", async () => {
  backlogRequests = 0;
  const page = await open("#backlog?project=repo-forge&status=done&type=story");
  await page.waitForFunction(() => location.hash === "#backlog?project=repo-forge&type=story&status=done");
  assert.equal(backlogRequests, 1, "opening the board reads its data once");
  await expectIds(page, ["FG-107"]);

  await page.getByRole("button", { name: "Filter by type: Epic", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#backlog?project=repo-forge&type=epic&status=done");
  await expectIds(page, ["FG-103"]);
  assert.equal(backlogRequests, 1, "a hash-only filter change reuses the loaded backlog payload");

  await page.reload();
  await page.locator(".backlog-result-count").waitFor();
  await expectIds(page, ["FG-103"]);
  assert.equal(await page.evaluate(() => location.hash), "#backlog?project=repo-forge&type=epic&status=done");
  assert.equal(backlogRequests, 2, "reload, unlike a filter click, performs a fresh backlog read");
  await page.screenshot({ path: join(SHOTS, "fg832-backlog-scoped-filter.png"), fullPage: true });
  await page.close();
});

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
      // Resolve symlinks before comparing roots, rather than trusting a lexical prefix.
      if (!realpathSync(filePath).startsWith(`${CLIENT_DIR}/`)) {
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
      backlogRequests += 1;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(backlogFixture));
      return;
    }
    const ticketRuns = url.pathname.match(/^\/api\/backlog\/([^/]+)\/runs$/);
    if (ticketRuns) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ticketId: decodeURIComponent(ticketRuns[1]!), runs: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
