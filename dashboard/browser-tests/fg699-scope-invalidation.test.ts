// FG-699: changing the project/checkout scope on the ops runtime panel must
// invalidate the payload already on screen — the panel drops to its loading
// state, not the PREVIOUS scope's numbers (or error) under the NEW scope's
// label. Driven in a real Chrome against the real shell + client, with both
// runtime endpoints stubbed and BRANCHED on the scope query params so a scope
// change is a genuinely different read that can be left pending.
//
// The window-change path (agent-runtime.test.ts) already invalidated on a
// window change; this suite proves the SAME invalidation now runs when the
// operator changes scope through a `.checkout-scope-btn`, for BOTH metrics
// (duration and the completed-runs count — AC5).
// Mirrors browser-tests/agent-runtime.test.ts.

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

const DAY = 86_400_000;

// One project with two checkouts. `projectScopeQuery` sends `?projectKey=<key>`
// for the all-checkouts scope and `?projectDir=<dir>` for a single checkout —
// so the two scopes are distinct reads the fixture can answer differently.
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
    description: "scope-invalidation fixture",
    readmeFirstLine: null,
    checkouts: [
      { projectDir: CHECKOUT_MAIN, branch: "main", exists: true },
      { projectDir: CHECKOUT_FEATURE, branch: "feature", exists: true },
    ],
  },
];

type DurationBucket = { bucketStart: string; averageMs: number | null; sampleCount: number; partial: boolean };
const durationPoint = (bucketStart: string, averageMs: number | null, sampleCount: number, partial = false): DurationBucket =>
  ({ bucketStart, averageMs, sampleCount, partial });

// Two duration payloads with DIFFERENT observed sample totals, so the sample
// note ("N runs in 7d") is a fingerprint of which scope the panel is showing.
function durationTrends(counts: number[]) {
  const overall = counts.map((n, i) =>
    durationPoint(new Date(Date.parse("2026-06-06T00:00:00.000Z") + i * DAY).toISOString(), n ? 60_000 + i * 5_000 : null, n));
  const samples = counts.reduce((sum, n) => sum + n, 0);
  return {
    window: "7d",
    resolution: "day",
    bucketMs: DAY,
    rangeStart: "2026-06-06T00:00:00.000Z",
    rangeEnd: "2026-06-10T14:30:00.000Z",
    overall,
    byRole: [{ role: "engineer", buckets: overall }],
    roleSummary: [{ role: "engineer", averageMs: 90_000, sampleCount: samples }],
  };
}

// All-checkouts (projectKey) scope: 14 observed runs. Single-checkout (projectDir)
// scope: 3. A panel showing "14 runs" after a switch to the checkout is stale.
const durationAllCheckouts = durationTrends([4, 6, 0, 3, 1]); // 14
const durationOneCheckout = durationTrends([1, 0, 0, 1, 1]); //  3

type CountBucket = { bucketStart: string; completedRuns: number; partial: boolean };
const countPoint = (bucketStart: string, completedRuns: number, partial = false): CountBucket =>
  ({ bucketStart, completedRuns, partial });

function countTrends(counts: number[]) {
  const buckets = counts.map((n, i) =>
    countPoint(new Date(Date.parse("2026-06-06T00:00:00.000Z") + i * DAY).toISOString(), n, i === counts.length - 1));
  return {
    window: "7d",
    resolution: "day",
    bucketMs: DAY,
    rangeStart: "2026-06-06T00:00:00.000Z",
    rangeEnd: "2026-06-10T14:30:00.000Z",
    buckets,
    totalCompletedRuns: counts.reduce((sum, n) => sum + n, 0),
  };
}

// All-checkouts: 9 completed runs. Single-checkout: 2. `.runs-total-num` is the
// fingerprint here.
const countAllCheckouts = countTrends([3, 0, 2, 1, 3]); // 9
const countOneCheckout = countTrends([1, 0, 0, 0, 1]); //  2

const opsFixture = {
  runs: { total: 40, active: 1, terminal: 39, clean: 30, withFailures: 9, successRate: 0.77 },
  taskCount: 190,
  counts: { idleKills: 1, cancels: 2, retries: 3, redBlocks: 4 },
  failureKinds: [],
  durations: [],
};

// The scope the fixture answers as, derived exactly as projectScopeQuery builds
// the query: a single-checkout request carries `projectDir` and no `projectKey`.
function scopeKey(url: URL): string {
  const dir = url.searchParams.get("projectDir");
  if (dir) return `dir:${dir}`;
  const key = url.searchParams.get("projectKey");
  if (key) return `key:${key}`;
  return "unscoped";
}

// Per-scope response delay and status, so one scope can be made to hang (or
// fail) while another answers instantly — the setup a scope-invalidation proof
// needs to observe the panel WHILE the new scope's read is still pending.
const delayByScope = new Map<string, number>();
const statusByScope = new Map<string, number>();

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

// Land on the ops runtime panel already scoped to the all-checkouts view of the
// project, with its data on screen — the state an operator is in before they
// narrow to a single checkout.
async function openScopedOps(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open all Atlas checkouts" }).click();
  await page.getByRole("button", { name: "ops" }).click();
  await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();
}

// The single-checkout scope button in the checkout-scope banner (render 576-589).
function checkoutScopeButton(page: Page, name: string) {
  return page.locator(".checkout-scope-btn").filter({ hasText: new RegExp(`^${name}$`) });
}

test("Switching checkout scope drops the DURATION panel to loading, not the previous scope's sample note", async () => {
  delayByScope.clear();
  statusByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await openScopedOps(page);
  // The all-checkouts scope resolved: its sample note is on screen.
  await page.locator(".runtime-chart svg").waitFor();
  assert.match(await page.locator(".runtime-sample-note").innerText(), /14 runs in 7d/);

  // The single-checkout read hangs. When the operator narrows scope, the panel
  // must show loading — NOT keep "14 runs" (the abandoned scope's number) under
  // the new scope's label.
  delayByScope.set(`dir:${CHECKOUT_MAIN}`, 5_000);
  await checkoutScopeButton(page, "main").click();

  const loading = page.locator(".runtime-loading");
  await loading.waitFor();
  assert.equal(await loading.getAttribute("role"), "status");
  assert.equal(await page.locator(".runtime-sample-note").count(), 0,
    "the previous scope's sample note must be gone while the new scope's read is pending");
  assert.equal(await page.locator(".runtime-chart svg").count(), 0, "the previous scope's chart is dropped, not relabelled");
  await page.close();
});

test("Switching checkout scope drops the COMPLETED-RUNS panel to loading, not the previous scope's total", async () => {
  delayByScope.clear();
  statusByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await openScopedOps(page);
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();
  // The all-checkouts scope resolved: its total is on screen.
  assert.equal(await page.locator(".runs-total-num").innerText(), "9");

  delayByScope.set(`dir:${CHECKOUT_MAIN}`, 5_000);
  await checkoutScopeButton(page, "main").click();

  const loading = page.locator(".runtime-loading");
  await loading.waitFor();
  assert.equal(await loading.getAttribute("role"), "status");
  assert.equal(await page.locator(".runs-total-num").count(), 0,
    "the previous scope's completed-runs total must be gone while the new scope's read is pending");
  assert.match(await loading.innerText(), /loading completed runs/, "the loading state belongs to the count metric, not duration");
  await page.close();
});

test("A slow leaving-scope failure that lands after the scope switch cannot repaint the abandoned scope (seq guard)", async () => {
  delayByScope.clear();
  statusByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  // The all-checkouts read is slow AND will fail: it is still IN FLIGHT when the
  // operator narrows scope, and only lands (HTTP 500) afterwards. This is the
  // state AC2 is about — a pending leaving-scope response the seq bump must
  // retire — so the read must NOT have resolved before the switch. A generous
  // delay keeps it pending across the switch; we then await its late landing
  // deterministically rather than guessing a timeout.
  statusByScope.set(`key:${PROJECT_KEY}`, 500);
  delayByScope.set(`key:${PROJECT_KEY}`, 3_000);
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open all Atlas checkouts" }).click();
  await page.getByRole("button", { name: "ops" }).click();
  await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();

  // Loading, not error: the leaving read has NOT resolved, so it is genuinely
  // pending at the moment of the switch (the flaw the previous test missed — it
  // waited for the error to render, retiring nothing).
  await page.locator(".runtime-loading").waitFor();
  assert.equal(await page.locator(".runtime-error").count(), 0, "the leaving read is still pending, not yet resolved");

  // Arm the wait for the leaving scope's own late response BEFORE switching, so
  // we can assert on the panel exactly after that retired 500 has been received.
  const leavingLate = page.waitForResponse(
    (res) => res.url().includes("/api/agent-runtime") && res.url().includes(`projectKey=${PROJECT_KEY}`),
  );

  // Narrow to a fast, clean checkout scope while the leaving 500 is in flight.
  await checkoutScopeButton(page, "main").click();
  await page.getByRole("img", { name: /Average agent runtime for/ }).waitFor();
  assert.match(await page.locator(".runtime-sample-note").innerText(), /3 runs in 7d/, "the new scope's own data is shown");

  // The retired 500 lands. Its seq is stale, so the guard drops it and never
  // writes: no error is attributed to the checkout the operator moved to. The
  // decisive check is `.runtime-stale`, NOT `.runtime-error` — with the new
  // scope's data on screen a broken guard would attach the leaving 500 to it as
  // the stale-data notice (render 1144), never the bare error card (render 1159).
  await leavingLate;
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".runtime-stale").count(), 0, "a late leaving-scope failure cannot be pinned to the new scope's data as stale");
  assert.equal(await page.locator(".runtime-error").count(), 0, "a late leaving-scope failure cannot repaint the abandoned scope");
  assert.match(await page.locator(".runtime-sample-note").innerText(), /3 runs in 7d/, "the new scope's data still stands");
  assert.equal(await checkoutScopeButton(page, "main").getAttribute("aria-pressed"), "true");
  await page.close();
});

test("Switching checkout scope clears the leaving scope's on-screen error (checkout-scope-btn)", async () => {
  delayByScope.clear();
  statusByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  // The all-checkouts scope has already FAILED — its error is fully rendered
  // (nothing in flight). This is the AC3 leg: the switch must clear that error
  // rather than carry it under the new scope's label.
  statusByScope.set(`key:${PROJECT_KEY}`, 500);
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open all Atlas checkouts" }).click();
  await page.getByRole("button", { name: "ops" }).click();
  await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();

  const error = page.locator(".runtime-error");
  await error.waitFor();
  assert.match(await error.innerText(), /HTTP 500/);

  // The new (checkout) scope answers cleanly: the leaving error must clear.
  await checkoutScopeButton(page, "main").click();
  await page.getByRole("img", { name: /Average agent runtime for/ }).waitFor();
  assert.equal(await page.locator(".runtime-error").count(), 0, "the leaving scope's error is not attributed to the new scope");
  assert.match(await page.locator(".runtime-sample-note").innerText(), /3 runs in 7d/, "the new scope's own data is shown");
  assert.equal(await checkoutScopeButton(page, "main").getAttribute("aria-pressed"), "true");
  await page.close();
});

test("Choosing a project from Projects invalidates the retained COMPLETED-RUNS panel before its new project read resolves", async () => {
  delayByScope.clear();
  statusByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  // Start unscoped, where the count panel has a distinct visible fingerprint.
  // `filterByProject` is deliberately different from the checkout banner: it
  // switches to Activity after changing scope, so return to Ops as an operator
  // would and leave the new project read pending there.
  await page.goto(`${baseUrl}/#ops`);
  await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();
  assert.equal(await page.locator(".runs-total-num").innerText(), "9");

  delayByScope.set(`key:${PROJECT_KEY}`, 5_000);
  await page.getByRole("button", { name: "projects" }).click();
  await page.getByRole("button", { name: "Open all Atlas checkouts" }).click();
  await page.getByRole("button", { name: "ops" }).click();

  const loading = page.locator(".runtime-loading");
  await loading.waitFor();
  assert.equal(await loading.getAttribute("role"), "status");
  assert.match(await loading.innerText(), /loading completed runs/);
  assert.equal(await page.locator(".runs-total-num").count(), 0,
    "filterByProject must drop the unscoped total while its project-scoped read is pending");
  assert.equal(await page.locator(".runs-chart svg").count(), 0,
    "filterByProject must not relabel the unscoped count chart as project-scoped");
  await page.close();
});

test("Clearing the project filter drops DURATION data and clears the old scope's error", async () => {
  delayByScope.clear();
  statusByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await openScopedOps(page);
  await page.locator(".runtime-chart svg").waitFor();
  assert.match(await page.locator(".runtime-sample-note").innerText(), /14 runs in 7d/);

  // The unscoped response hangs, which gives the assertion a real pending
  // interval rather than merely checking the eventual replacement payload.
  delayByScope.set("unscoped", 5_000);
  await page.locator(".clear-filter").click();

  const loading = page.locator(".runtime-loading");
  await loading.waitFor();
  assert.equal(await loading.getAttribute("role"), "status");
  assert.equal(await page.locator(".runtime-sample-note").count(), 0,
    "clearProjectFilter must drop the project sample note while the unscoped read is pending");
  assert.equal(await page.locator(".runtime-chart svg").count(), 0,
    "clearProjectFilter must drop the project chart instead of presenting it as unscoped");

  // Establish an old-scope error, then clear through the same wrapper. This is
  // a separate page state because a panel cannot simultaneously display data
  // and its request error; together the two legs prove both invalidation jobs.
  await page.close();
  delayByScope.clear();
  statusByScope.clear();
  statusByScope.set(`dir:${CHECKOUT_MAIN}`, 500);
  const errorPage = await newPage({ width: 1440, height: 1200 });
  await errorPage.goto(`${baseUrl}/#projects`);
  await errorPage.getByRole("button", { name: "Open Atlas checkout main" }).click();
  await errorPage.getByRole("button", { name: "ops" }).click();
  const error = errorPage.locator(".runtime-error");
  await error.waitFor();
  assert.match(await error.innerText(), /HTTP 500/);

  delayByScope.set("unscoped", 5_000);
  await errorPage.locator(".clear-filter").click();
  await errorPage.locator(".runtime-loading").waitFor();
  assert.equal(await errorPage.locator(".runtime-error").count(), 0,
    "clearProjectFilter must not attribute the project error to the unscoped panel");
  await errorPage.close();
});

function metric(page: Page, name: string) {
  return page.getByRole("group", { name: "metric:" }).getByRole("button").filter({ hasText: new RegExp(`^${name}$`) });
}

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
    if (url.pathname === "/api/agent-runtime" || url.pathname === "/api/completed-runs") {
      const scope = scopeKey(url);
      const delay = delayByScope.get(scope) ?? 0;
      if (delay) await new Promise((wait) => setTimeout(wait, delay));
      const status = statusByScope.get(scope) ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "store read failed" }));
        return;
      }
      const single = scope.startsWith("dir:");
      const payload = url.pathname === "/api/completed-runs"
        ? (single ? countOneCheckout : countAllCheckouts)
        : (single ? durationOneCheckout : durationAllCheckouts);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === "/api/ops") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(opsFixture));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
