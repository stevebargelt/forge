// FG-820: the left-column navigation that replaced the 13-button strip.
//
// The real client is booted against a fixture server. The column must render the five
// groups of docs/research/dashboard-information-architecture.md with their items as
// links, mark the current item with aria-current (an object page marks its parent),
// restore view AND scope from a reloaded deep link and send that scope to the server as
// ?projectKey/?projectDir, canonicalize alias hashes, and badge Home from the server's
// `counts` alone. Below 720px a five-slot bottom bar replaces the column and More opens a
// focus-trapped drawer that Escape closes, returning focus to More.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18824;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG820_SCREENSHOT_DIR ?? join(tmpdir(), "fg820-screenshots");
mkdirSync(SHOTS, { recursive: true });

const MAIN = "/repos/atlas-main";
const FEATURE = "/repos/atlas feature";

type InboxMode = "counts" | "high" | "degraded" | "empty" | "no-counts" | "unavailable" | "many";
let inboxMode: InboxMode = "counts";
const apiRequests: string[] = [];

function inboxItem(id: string, severity = "medium") {
  return {
    id: `att-${id}`,
    kind: "waiting_gate",
    severity,
    startedAt: "2026-09-28T10:00:00.000Z",
    reason: `reason-${id}`,
    requestedAction: `act on ${id}`,
    openState: "open",
    source: "fixture",
    links: { runId: `run-${id}`, taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null },
  };
}

// The item list is deliberately NOT the count: a badge that shows 2 counted in the browser.
function inboxEnvelope(): unknown {
  const base = { generatedAt: new Date().toISOString(), scope: { runId: null, projectDirs: null } };
  switch (inboxMode) {
    case "counts":
      return { ...base, items: [inboxItem("A"), inboxItem("B")], empty: false, degraded: [], counts: { open: 7, high: 0 } };
    case "high":
      return { ...base, items: [inboxItem("A", "high")], empty: false, degraded: [], counts: { open: 3, high: 1 } };
    case "degraded":
      return { ...base, items: [inboxItem("A")], empty: false, degraded: ["waits"], counts: { open: 4, high: 0 } };
    case "empty":
      return { ...base, items: [], empty: true, degraded: [], counts: { open: 0, high: 0 } };
    case "no-counts":
      return { ...base, items: [inboxItem("A"), inboxItem("B")], empty: false, degraded: [] };
    case "many":
      return { ...base, items: [inboxItem("A")], empty: false, degraded: [], counts: { open: 140, high: 0 } };
    default:
      return null;
  }
}

let server: Server;
let browser: Browser;
const baseUrl = `http://127.0.0.1:${PORT}`;

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

async function open(hash = "", width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return page;
}

const hashOf = (page: Page) => new URL(page.url()).hash;
const column = (page: Page) => page.locator(".nav-column");
const currentItems = (page: Page) => column(page).locator('a[aria-current="page"] .nav-item-label').allInnerTexts();
const homeBadge = (page: Page) => column(page).locator('a[data-view="home"] .nav-badge');

async function waitForBadgeText(page: Page, expected: string | null): Promise<void> {
  const deadline = Date.now() + 8000;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => document.querySelector('.nav-column a[data-view="home"] .nav-badge')?.textContent ?? null);
    if (last === expected) return;
    await page.waitForTimeout(100);
  }
  assert.equal(last, expected, "the Home badge never showed the expected text");
}

test("FG-820: the column renders the five groups with their items as links, headings are not controls, and Skip to content comes first", async () => {
  inboxMode = "counts";
  const page = await open();
  await page.locator("section.home-view").waitFor();

  const groups = await column(page).locator(".nav-group").evaluateAll((sections) =>
    sections.map((s) => ({
      heading: s.querySelector("h2")?.textContent?.trim(),
      items: Array.from(s.querySelectorAll("a.nav-item .nav-item-label"), (a) => a.textContent?.trim()),
    })),
  );
  assert.deepEqual(groups, [
    { heading: "Now", items: ["Home", "Activity"] },
    { heading: "Plan", items: ["Backlog", "Notes", "Queue", "Campaigns"] },
    { heading: "Evidence", items: ["Runs", "Reviews", "Shipping"] },
    { heading: "Setup", items: ["Roles", "Routing", "Config", "Projects"] },
    { heading: "Health", items: ["Usage", "Ops"] },
  ]);
  assert.equal(await column(page).locator(".nav-group-heading button, .nav-group-heading a, .nav-group-heading[tabindex]").count(), 0,
    "group headings are plain headings, not controls");
  assert.equal(await column(page).locator("a.nav-item:not([href^='#'])").count(), 0, "every nav item is an in-app hash link");
  assert.equal(await page.locator(".view-tabs, nav.view-tabs").count(), 0, "the horizontal strip is gone");
  assert.equal(await column(page).locator(".nav-scope-select").inputValue(), "", "unscoped reads All projects");
  assert.match(await column(page).locator(".nav-clock").innerText(), /\d/, "the last-poll clock sits at the foot");

  // Keyboard: Skip to content first, then the column, then content.
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to content");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".nav-column")), true, "Tab moves from the skip link into the column");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "main-content", "Skip to content moves focus to the content");
  const ring = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement!);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), shadow: cs.boxShadow };
  });
  assert.ok((ring.style !== "none" && ring.width > 0) || ring.shadow !== "none",
    `the skip target shows a visible focus indicator (outline ${ring.style} ${ring.width}px, box-shadow ${ring.shadow})`);
  assert.equal(hashOf(page), "", "skipping does not navigate");

  await page.screenshot({ path: join(SHOTS, "fg820-desktop-column.png") });
  await page.close();
});

test("FG-820: the current item carries aria-current, and an object page highlights its parent", async () => {
  inboxMode = "counts";
  const page = await open("#usage");
  await page.locator(".page-title", { hasText: "Usage" }).waitFor();
  assert.deepEqual(await currentItems(page), ["Usage"]);
  assert.equal(await page.locator(".page-kicker").textContent(), "Health", "the page head names the derived group");

  await column(page).getByRole("link", { name: "Routing", exact: true }).click();
  await page.locator(".page-title", { hasText: "Routing" }).waitFor();
  assert.deepEqual(await currentItems(page), ["Routing"]);
  assert.equal(hashOf(page), "#routing");

  await page.goto(`${baseUrl}/#run/run-1`);
  await page.locator(".object-head .page-title", { hasText: "Run" }).waitFor();
  assert.deepEqual(await currentItems(page), ["Runs"], "a run page highlights Runs");

  // FG-821 replaced the placeholder with the run index.
  // The Runs item's accessible name carries its badge ("?" here: this fixture serves no
  // /api/runs), so select it by view.
  await column(page).locator('a[data-view="runs"]').click();
  await page.locator("section.runs-index").waitFor();
  assert.equal(hashOf(page), "#runs");
  await page.close();
});

test("FG-840: Routing names the project audit source for a scoped checkout and the host source when unscoped", async () => {
  const page = await open(`#routing?project=atlas&checkout=${encodeURIComponent(MAIN)}`);
  await page.locator(".page-title", { hasText: "Routing" }).waitFor();
  await page.locator('[data-testid="gov-audit-source"]', { hasText: "recorded in this checkout's .forge/raci-audit.log" }).waitFor();
  assert.match(await page.locator('[data-testid="gov-audit-source"]').getAttribute("title") ?? "", /\.forge\/raci-audit\.log$/);

  await page.goto(`${baseUrl}/#routing`);
  await page.locator('[data-testid="gov-audit-source"]', { hasText: "recorded in the host log — no checkout in scope" }).waitFor();
  await page.close();
});

test("FG-820: a reloaded deep link restores view and scope, and the scope reaches the server as ?projectKey/?projectDir", async () => {
  inboxMode = "counts";
  apiRequests.length = 0;
  const hash = `#ops?project=atlas&checkout=${encodeURIComponent(MAIN)}`;
  const page = await open(hash);
  await page.locator(".page-title", { hasText: "Ops" }).waitFor();
  const opsScoped = () => apiRequests.some((u) => u.startsWith("/api/ops") && new URL(u, baseUrl).searchParams.get("projectDir") === MAIN);
  await page.waitForFunction(() => document.querySelectorAll(".checkout-scope-btn").length > 0);
  assert.ok(opsScoped(), `the ops read carried projectDir=${MAIN}: ${JSON.stringify(apiRequests.filter((u) => u.startsWith("/api/ops")))}`);
  assert.equal(await column(page).locator(".nav-scope-select").inputValue(), "atlas");
  assert.equal(await column(page).locator(".checkout-scope-btn-active").innerText(), "atlas-main · main");

  // Nav links carry the scope to other list views; scope-less views do not take it.
  assert.equal(await column(page).getByRole("link", { name: "Usage", exact: true }).getAttribute("href"), `#usage?project=atlas&checkout=${encodeURIComponent(MAIN)}`);
  assert.equal(await column(page).getByRole("link", { name: "Projects", exact: true }).getAttribute("href"), "#projects");

  // A scope change rewrites the hash in place — no new history entry.
  const historyBefore = await page.evaluate(() => history.length);
  await column(page).locator(".checkout-scope-btn", { hasText: /^atlas feature · feature$/ }).click();
  assert.equal(hashOf(page), `#ops?project=atlas&checkout=${encodeURIComponent(FEATURE)}`);
  assert.equal(await page.evaluate(() => history.length), historyBefore, "scope change used replaceState");
  await page.waitForFunction((dir) => document.querySelector(".checkout-scope-btn-active")?.getAttribute("title") === dir, FEATURE);

  apiRequests.length = 0;
  await page.reload();
  await page.locator(".page-title", { hasText: "Ops" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".checkout-scope-btn").length > 0);
  assert.equal(await column(page).locator(".checkout-scope-btn-active").innerText(), "atlas feature · feature", "reload restored the checkout scope");
  assert.ok(apiRequests.some((u) => u.startsWith("/api/ops") && new URL(u, baseUrl).searchParams.get("projectDir") === FEATURE),
    "after reload the server still receives the scope from the hash");
  assert.ok(await page.evaluate(() => Object.keys(localStorage).length === 0 && Object.keys(sessionStorage).length === 0), "nothing is stored client-side");

  // Clearing the scope clears it from the hash.
  await column(page).locator(".clear-filter").click();
  assert.equal(hashOf(page), "#ops");
  assert.equal(await column(page).locator(".nav-scope-select").inputValue(), "");
  await page.close();
});

test("FG-820: alias, group-shaped and unknown hashes redirect to their canonical form", async () => {
  inboxMode = "counts";
  const cases: [string, string, string][] = [
    ["#governance", "#routing", "Routing"],
    ["#control-plane?project=atlas", "#config?project=atlas", "Config"],
    ["#run-map/run-1", "#run/run-1", "Runs"],
    ["#plan/queue?group=health&project=atlas&utm=x", "#queue?project=atlas", "Queue"],
    ["#run-map", "#runs", "Runs"],
    ["#nope", "#home", "Home"],
  ];
  const page = await open();
  for (const [from, to, current] of cases) {
    await page.goto(`${baseUrl}/${from}`);
    await page.waitForFunction((expected) => location.hash === expected, to);
    await page.waitForFunction((label) => document.querySelector('.nav-column a[aria-current="page"] .nav-item-label')?.textContent === label, current);
  }
  // The last two carry their one-line notices.
  await page.goto(`${baseUrl}/#run-map`);
  await page.locator(".route-notice", { hasText: "Open a run from the run index" }).waitFor();
  await page.goto(`${baseUrl}/#nope`);
  await page.locator(".route-notice", { hasText: "No view named “nope”" }).waitFor();
  assert.equal(await page.locator("section.home-view").count(), 1);
  // Navigating on clears the notice.
  await column(page).getByRole("link", { name: "Usage", exact: true }).click();
  await page.locator(".page-title", { hasText: "Usage" }).waitFor();
  assert.equal(await page.locator(".route-notice").count(), 0);
  await page.close();
});

test("FG-820: the Home badge shows the server's counts — danger when high, ? when unavailable, partial when degraded, hidden only when empty, capped at 99+", async () => {
  inboxMode = "counts";
  const page = await open();
  await waitForBadgeText(page, "7");
  assert.match(await homeBadge(page).getAttribute("class") ?? "", /nav-badge-neutral/);
  const neutralColor = await homeBadge(page).evaluate((el) => getComputedStyle(el).color);

  inboxMode = "high";
  await waitForBadgeText(page, "3");
  assert.match(await homeBadge(page).getAttribute("class") ?? "", /nav-badge-danger/);
  assert.notEqual(await homeBadge(page).evaluate((el) => getComputedStyle(el).color), neutralColor, "a high item tones the badge");
  assert.match(await column(page).locator('a[data-view="home"]').innerText(), /3 open, 1 high/, "the accessible label names the counts");
  await page.screenshot({ path: join(SHOTS, "fg820-desktop-column-home-badge.png") });

  inboxMode = "degraded";
  await waitForBadgeText(page, "4*");
  assert.match(await column(page).locator('a[data-view="home"] .nav-sr-only').innerText(), /4 open, some sources unreadable/);

  inboxMode = "many";
  await waitForBadgeText(page, "99+");

  inboxMode = "no-counts";
  await waitForBadgeText(page, "?");

  inboxMode = "unavailable";
  await waitForBadgeText(page, "?");

  inboxMode = "empty";
  await waitForBadgeText(page, null);
  await page.close();
});

test("FG-820: below 720px a five-slot bottom bar replaces the column; More opens a focus-trapped drawer that Escape closes", async () => {
  inboxMode = "high";
  const page = await open("#usage", 400);
  await page.locator(".page-title", { hasText: "Usage" }).waitFor();
  assert.equal(await column(page).isVisible(), false, "the column is hidden at 400px");
  const bar = page.locator("nav.bottom-bar");
  assert.equal(await bar.isVisible(), true);
  assert.deepEqual(
    (await bar.locator(".bottom-bar-item").allInnerTexts()).map((t) => t.replace(/\s+.*/s, "")),
    ["Home", "Runs", "Queue", "Backlog", "More"],
  );
  await page.waitForFunction(() => document.querySelector('.bottom-bar a[data-view="home"] .nav-badge')?.textContent === "3");
  assert.match(await bar.locator(".bottom-bar-more").getAttribute("class") ?? "", /bottom-bar-item-current/, "a drawer-only view marks More");
  const barBox = await bar.boundingBox();
  assert.ok(barBox && Math.round(barBox.y + barBox.height) === 900, "the bar is fixed to the bottom edge");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 400px");
  await page.screenshot({ path: join(SHOTS, "fg820-mobile-400-bottom-bar.png") });

  const more = bar.getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await drawer.waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), "true");
  assert.equal(await more.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await drawer.locator(".nav-group-heading").allTextContents(), ["Now", "Plan", "Evidence", "Setup", "Health"], "the drawer holds the full column");
  assert.equal(await drawer.locator(".nav-scope-select").count(), 1, "the scope control is in the drawer");
  assert.equal(await drawer.locator(".nav-clock").count(), 1, "the poll clock is in the drawer");
  await page.waitForFunction(() => document.activeElement?.classList.contains("nav-drawer-close"));
  await page.screenshot({ path: join(SHOTS, "fg820-mobile-400-drawer-open.png") });

  // Focus is trapped: a full lap of Tab and a Shift+Tab from the first control stay inside.
  const inDrawer = () => page.evaluate(() => !!document.activeElement?.closest("#nav-drawer"));
  const focusables = await drawer.locator("a[href], button, select").count();
  for (let i = 0; i < focusables + 2; i++) {
    await page.keyboard.press("Tab");
    assert.equal(await inDrawer(), true, `Tab ${i + 1} stayed inside the drawer`);
  }
  await drawer.locator(".nav-drawer-close").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await inDrawer(), true, "Shift+Tab from the first control wraps to the last");

  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("bottom-bar-more"));
  assert.equal(await more.getAttribute("aria-expanded"), "false");

  // Following a link in the drawer navigates and closes it.
  await more.click();
  await drawer.getByRole("link", { name: "Ops", exact: true }).click();
  await drawer.waitFor({ state: "detached" });
  await page.locator(".page-title", { hasText: "Ops" }).waitFor();
  assert.equal(hashOf(page), "#ops");
  await page.close();
});

test("FG-820: every legacy hash reaches its rendered heading, and keyboard order is Skip, scope, then every column item", async () => {
  inboxMode = "counts";
  apiRequests.length = 0;
  const page = await open("#queue?project=atlas");
  await page.locator(".page-title", { hasText: "Queue" }).waitFor();
  assert.equal(await column(page).locator(".nav-scope-select").inputValue(), "atlas", "a cold queue link restores its project scope");
  await page.waitForFunction(() => Array.from(document.querySelectorAll("body *")).some((el) => el.textContent?.includes("Queue")));
  assert.ok(apiRequests.some((request) => request.startsWith("/api/queue?") && new URL(request, baseUrl).searchParams.get("projectKey") === "atlas"),
    "the queue read uses the project restored from its hash");

  // Starting from the document, there is no invisible nav stop between the skip link,
  // scope control, and the complete table order.
  await page.goto(`${baseUrl}/`);
  await page.locator("section.home-view").waitFor();
  const tabStops: string[] = [];
  for (let i = 0; i < 17; i++) {
    await page.keyboard.press("Tab");
    tabStops.push(await page.evaluate(() => {
      const active = document.activeElement;
      if (active?.classList.contains("skip-link")) return "Skip to content";
      if (active?.classList.contains("nav-scope-select")) return "Scope";
      return active?.getAttribute("data-view") ?? active?.textContent?.trim() ?? "";
    }));
  }
  assert.deepEqual(tabStops, [
    "Skip to content", "Scope", "home", "activity", "backlog", "notes", "queue", "campaigns", "runs", "reviews", "shipping",
    "roles", "routing", "config", "projects", "usage", "ops",
  ]);

  const legacy: Array<[string, string]> = [
    ["#activity", "Activity"], ["#projects", "Projects"], ["#usage", "Usage"], ["#ops", "Ops"],
    ["#governance", "Routing"], ["#backlog", "Backlog"], ["#reviews", "Reviews"], ["#queue?project=atlas", "Queue"],
    ["#shipping?project=atlas", "Shipping"], ["#campaigns", "Campaigns"], ["#control-plane", "Config"],
    ["#run-map/run-1", "Run"], ["#run/run-1", "Run"],
  ];
  for (const [hash, heading] of legacy) {
    await page.goto(`${baseUrl}/${hash}`);
    await page.locator(".page-title", { hasText: heading }).waitFor();
    assert.equal(await page.locator(".page-title").innerText(), heading, `${hash} renders ${heading}`);
  }
  await page.close();
});

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) apiRequests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
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
        : filePath.endsWith(".svg") ? "image/svg+xml"
          : filePath.endsWith(".png") ? "image/png"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/attention-inbox") {
      const body = inboxEnvelope();
      if (body === null) json({ error: "store unreadable" }, 503);
      else json(body);
      return;
    }
    if (url.pathname === "/api/projects") {
      json([{
        key: "atlas",
        label: "Atlas",
        color: "#345",
        classification: "independent",
        checkouts: [
          { projectDir: MAIN, branch: "main", exists: true },
          { projectDir: FEATURE, branch: "feature", exists: true },
        ],
      }]);
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      json({ generatedAt: new Date(0).toISOString(), services: [] });
      return;
    }
    if (url.pathname === "/api/ops") {
      json({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 },
        failureKinds: [], durations: [],
      });
      return;
    }
    if (url.pathname === "/api/governance") {
      const scoped = url.searchParams.has("projectDir");
      json({
        source: { kind: scoped ? "project" : "host", raciPath: scoped ? `${MAIN}/.forge/forge-raci.md` : "/host/.forge/forge-raci.md" },
        derived: { policyPath: scoped ? `${MAIN}/.forge/routing-policy.yml` : "/host/.forge/routing-policy.yml", health: "ok" },
        effective: null,
        recorded: {
          source: scoped ? "project" : "host",
          path: scoped ? `${MAIN}/.forge/raci-audit.log` : "/host/.forge/raci-audit.log",
          entries: [],
          skippedLines: 0,
        },
      });
      return;
    }
    if (["/api/in-flight", "/api/feed", "/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname)
      || url.pathname.startsWith("/api/usage")) {
      json([]);
      return;
    }
    json({ error: "not in this fixture" }, 404);
  });
}
