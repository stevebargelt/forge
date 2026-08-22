// FG-349 / RF-2: the Control Plane config-graph read must be scope-guarded like
// every other project-scoped panel. Two obligations, driven in a real Chrome
// against the real shell + client with /api/config-graph branched on the scope
// query params so a scope change is a genuinely different read that can be left
// pending:
//   1. Changing the checkout scope invalidates the graph already on screen — the
//      panel drops to its loading state, never the PREVIOUS checkout's graph
//      under the new scope's label.
//   2. A slow LEAVING-scope response that lands AFTER the scope switch cannot
//      repaint the abandoned checkout's graph (the seq guard) — this is the exact
//      race the finding describes: an unguarded request committed every response,
//      so an old-scope graph resolving late overwrote the new scope's graph.
// Mirrors browser-tests/fg699-scope-invalidation.test.ts.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");

// One project with two checkouts. A single-checkout scope sends `?projectDir=<dir>`,
// so the two checkouts are distinct reads the fixture answers with distinct graphs.
const PROJECT_KEY = "atlas";
const CHECKOUT_MAIN = "/checkouts/atlas-main";
const CHECKOUT_FEATURE = "/checkouts/atlas-feature";

const projectsFixture = [
  {
    key: PROJECT_KEY,
    label: "Atlas",
    color: "#4c8bf5",
    runCount: 42,
    inFlightCount: 0,
    liveSessions: 0,
    lastRunAt: "2026-06-10T12:00:00.000Z",
    githubUrl: null,
    description: "control-plane scope fixture",
    readmeFirstLine: null,
    checkouts: [
      { projectDir: CHECKOUT_MAIN, branch: "main", exists: true },
      { projectDir: CHECKOUT_FEATURE, branch: "feature", exists: true },
    ],
  },
];

// A minimal-but-valid config graph whose project.dir is the fingerprint of which
// checkout scope the panel is showing (control-plane.js renders it in the header).
function graphFor(dir: string) {
  return {
    version: 1,
    project: { dir, status: "active" },
    forgeHome: "/home/forge/.forge",
    sections: {
      sources: { rows: [] },
      capabilities: { providers: [], capabilities: [], prerequisites: [] },
    },
  };
}

// The scope the fixture answers as, derived exactly as projectScopeQuery builds
// the query: a single-checkout request carries `projectDir`.
function scopeKey(url: URL): string {
  const dir = url.searchParams.get("projectDir");
  if (dir) return `dir:${dir}`;
  const key = url.searchParams.get("projectKey");
  if (key) return `key:${key}`;
  return "unscoped";
}

// Per-scope response delay, so one checkout can be made to hang while another
// answers instantly — the setup a scope-invalidation / late-response proof needs.
const delayByScope = new Map<string, number>();
// Per-scope BODY delay: headers flush immediately, the body is held. This is the
// window RF-2 targets — the client passes its post-headers seq check and then
// blocks inside `await res.json()` while a scope change retires the read.
const bodyDelayByScope = new Map<string, number>();

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

const controlPlaneTab = (page: Page) => page.getByRole("button", { name: "control plane", exact: true });

function checkoutScopeButton(page: Page, name: string) {
  return page.locator(".checkout-scope-btn").filter({ hasText: new RegExp(`^${name}$`) });
}

const cpProjectDir = (page: Page) => page.locator(".cp-header .mono").first();

// Land on the Control Plane scoped to the `main` checkout, with its graph rendered.
async function openScopedControlPlane(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open Atlas checkout main" }).click();
  await controlPlaneTab(page).click();
  await page.locator(".cp-view").waitFor();
  assert.equal(await cpProjectDir(page).innerText(), CHECKOUT_MAIN);
}

test("Switching checkout scope drops the control-plane graph to loading, not the previous checkout's graph", async () => {
  delayByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await openScopedControlPlane(page);

  // The feature-checkout read hangs. When the operator narrows to it, the panel
  // must show loading — NOT keep main's graph under the feature label.
  delayByScope.set(`dir:${CHECKOUT_FEATURE}`, 5_000);
  await checkoutScopeButton(page, "feature").click();

  await page.getByText("loading control plane…").waitFor();
  assert.equal(await page.locator(".cp-view").count(), 0,
    "the previous checkout's graph must be gone while the new scope's read is pending");
  await page.close();
});

test("A slow leaving-scope config-graph response that lands after the switch cannot repaint the abandoned checkout (seq guard)", async () => {
  delayByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  // The main read is slow: it is still IN FLIGHT when the operator narrows to the
  // feature checkout, and only lands afterwards. A generous delay keeps it pending
  // across the switch; we then await its late landing deterministically.
  delayByScope.set(`dir:${CHECKOUT_MAIN}`, 3_000);
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open Atlas checkout main" }).click();
  await controlPlaneTab(page).click();

  // The main graph read has NOT resolved: the panel is genuinely pending.
  await page.getByText("loading control plane…").waitFor();
  assert.equal(await page.locator(".cp-view").count(), 0, "the leaving read is still pending, not yet resolved");

  // Arm the wait for the leaving scope's own late response BEFORE switching.
  const leavingLate = page.waitForResponse(
    (res) => res.url().includes("/api/config-graph") && res.url().includes(`projectDir=${encodeURIComponent(CHECKOUT_MAIN)}`),
  );

  // Narrow to the fast feature checkout while main's read is in flight.
  await checkoutScopeButton(page, "feature").click();
  await page.locator(".cp-view").waitFor();
  assert.equal(await cpProjectDir(page).innerText(), CHECKOUT_FEATURE, "the new scope's own graph is shown");

  // The retired main response lands. Its seq is stale, so the guard drops it and
  // never writes: main's graph must not overwrite the feature graph on screen.
  await leavingLate;
  await page.waitForTimeout(100);
  assert.equal(await cpProjectDir(page).innerText(), CHECKOUT_FEATURE,
    "a late leaving-scope graph cannot repaint the abandoned checkout");
  assert.equal(await checkoutScopeButton(page, "feature").getAttribute("aria-pressed"), "true");
  await page.close();
});

test("A scope change during config-graph BODY decode cannot render the retired checkout's graph (RF-2 post-decode guard)", async () => {
  delayByScope.clear();
  bodyDelayByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  // Main answers headers immediately but HOLDS its body: the client passes the
  // first (post-headers) seq check and then blocks inside `await res.json()` —
  // exactly the window RF-2 describes, which the whole-response delay above never
  // reaches (that one is caught by the first check).
  bodyDelayByScope.set(`dir:${CHECKOUT_MAIN}`, 3_000);

  const mainResp = page.waitForResponse(
    (res) => res.url().includes("/api/config-graph") && res.url().includes(`projectDir=${encodeURIComponent(CHECKOUT_MAIN)}`),
  );

  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open Atlas checkout main" }).click();
  await controlPlaneTab(page).click();

  // Headers are in, but the body is still held: the panel is genuinely pending.
  await page.getByText("loading control plane…").waitFor();
  const leaving = await mainResp; // resolves on headers (immediate)

  // Narrow to the fast feature checkout while main's BODY decode is still pending.
  await checkoutScopeButton(page, "feature").click();
  await page.locator(".cp-view").waitFor();
  assert.equal(await cpProjectDir(page).innerText(), CHECKOUT_FEATURE, "the new scope's own graph is shown");

  // Main's body finally lands and `await res.json()` resolves. The post-decode seq
  // check must drop it — it must not repaint the abandoned main checkout.
  await leaving.finished();
  await page.waitForTimeout(100);
  assert.equal(await cpProjectDir(page).innerText(), CHECKOUT_FEATURE,
    "a scope change during body decode cannot render the retired checkout's graph");
  assert.equal(await checkoutScopeButton(page, "feature").getAttribute("aria-pressed"), "true");
  await page.close();
});

async function newPage(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce", timezoneId: "UTC" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

function createFixtureServer(): Server {
  return createServer(async (req, res) => {
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
    if (url.pathname === "/api/config-graph") {
      const scope = scopeKey(url);
      const dir = scope.startsWith("dir:") ? scope.slice("dir:".length) : CHECKOUT_MAIN;
      const body = JSON.stringify(graphFor(dir));
      const delay = delayByScope.get(scope) ?? 0;
      if (delay) await new Promise((wait) => setTimeout(wait, delay));
      const bodyDelay = bodyDelayByScope.get(scope) ?? 0;
      if (bodyDelay) {
        // Headers immediately; the body held. The client resolves its first seq
        // check on headers and then hangs inside `await res.json()` on the body.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.flushHeaders();
        setTimeout(() => res.end(body), bodyDelay);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(body);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
