// FG-836 — the Ops runtime window is honest state. Changing it shows an explicit loading
// state (window control disabled, chart dimmed under a "loading <w>…" line) with the
// previous series kept on screen and labelled "showing <old>"; the new label lands with
// the new data. The window lives in `#ops?window=<w>` so a reload restores it; an unknown
// window falls back to 7d silently; a failed or over-budget read says why inline; and a
// window change aborts the read still in flight.
//
// The summary's own window (`#ops?since=<w>`, the `since` for GET /api/ops) gets the same
// honesty: a change dims the kept summary under "loading <w>… showing <old> until it
// answers", the "showing <w>" caption and each count's "in <w>" move with the data, and
// both params survive a reload together. The fixture answers every since with the SAME
// numbers — the case the operator hit, where the control looked like it did nothing.
//
// A fixture HTTP server serves the real shell + client bundle and canned runtime series,
// each window slowable or failable on demand. Screenshots go to a fresh temp dir unless
// FG836_SCREENSHOT_DIR names one.

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

const PORT = 18840;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SHOTS = process.env.FG836_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg836-screenshots-"));
if (process.env.FG836_SCREENSHOT_DIR) mkdirSync(SHOTS, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;

const DAY = 86_400_000;
const point = (bucketStart: string, averageMs: number | null, sampleCount: number, partial = false) =>
  ({ bucketStart, averageMs, sampleCount, partial });

function trends(window: string, resolution: string, bucketMs: number, buckets: ReturnType<typeof point>[]) {
  const samples = buckets.reduce((sum, b) => sum + b.sampleCount, 0);
  return {
    window,
    resolution,
    bucketMs,
    rangeStart: buckets[0]?.bucketStart ?? null,
    rangeEnd: "2026-06-10T14:30:00.000Z",
    overall: buckets,
    byRole: [{ role: "engineer", buckets }],
    roleSummary: samples > 0 ? [{ role: "engineer", averageMs: 120_000, sampleCount: samples }] : [],
  };
}

const series = new Map<string, ReturnType<typeof trends>>([
  ["1d", trends("1d", "hour", 3_600_000, [point("2026-06-10T13:00:00.000Z", 60_000, 2), point("2026-06-10T14:00:00.000Z", 75_000, 1, true)])],
  ["7d", trends("7d", "day", DAY, [
    point("2026-06-08T00:00:00.000Z", 90_000, 4),
    point("2026-06-09T00:00:00.000Z", 150_000, 6),
    point("2026-06-10T00:00:00.000Z", 45_000, 1, true),
  ])],
  ["30d", trends("30d", "day", DAY, Array.from({ length: 12 }, (_, i) =>
    point(new Date(Date.parse("2026-05-30T00:00:00.000Z") + i * DAY).toISOString(), 60_000 + i * 20_000, 1 + (i % 4), i === 11)))],
  ["90d", trends("90d", "week", 7 * DAY, [point("2026-06-08T00:00:00.000Z", 300_000, 9, true)])],
  ["all", trends("all", "week", 7 * DAY, [point("2026-06-08T00:00:00.000Z", 310_000, 11, true)])],
]);

const opsFixture = {
  runs: { total: 40, active: 1, terminal: 39, clean: 30, withFailures: 9, successRate: 0.77 },
  taskCount: 190,
  counts: { idleKills: 1, cancels: 2, retries: 3, redBlocks: 4 },
  failureKinds: [],
  durations: [],
};

const delayByWindow = new Map<string, number>();
const statusByWindow = new Map<string, number>();
let runtimeRequests: string[] = [];
let opsRequests: string[] = [];
let opsRequestUrls: string[] = [];
const opsDelayBySince = new Map<string, number>();
let abortedWindows: string[] = [];

let server: Server;
let browser: Browser;

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

function reset(): void {
  delayByWindow.clear();
  statusByWindow.clear();
  runtimeRequests = [];
  abortedWindows = [];
  opsRequests = [];
  opsRequestUrls = [];
  opsDelayBySince.clear();
}

async function newPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

const windowButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "runtime window:" }).getByRole("button").filter({ hasText: new RegExp(`^${name}$`) });
const chartLabel = async (page: Page) => (await page.locator(".runtime-chart svg").getAttribute("aria-label")) ?? "";
const showing = async (page: Page) => (await page.locator(".runtime-showing").innerText()).trim();

const sinceButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "window:", exact: true }).getByRole("button").filter({ hasText: new RegExp(`^${name}$`) });
const summaryShowing = async (page: Page) => (await page.locator(".ops-since-showing").innerText()).trim();

async function summarySettledOn(page: Page, since: string): Promise<void> {
  await page.waitForFunction((w) => document.querySelector(".ops-since-showing")?.textContent?.trim() === `showing ${w}`
    && document.querySelector(".ops-summary-body-loading") === null, since);
}

async function settledOn(page: Page, window: string): Promise<void> {
  await page.waitForFunction((w) => document.querySelector(".runtime-showing")?.textContent?.trim() === `showing ${w}`
    && document.querySelector(".runtime-body-loading") === null, window);
}

test("FG-836: changing the window shows the loading state over the kept series, then the new label", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await settledOn(page, "7d");
  assert.match(await chartLabel(page), /by day, over 7d/);
  assert.equal(await windowButton(page, "7d").getAttribute("aria-pressed"), "true");

  delayByWindow.set("30d", 1_500);
  await windowButton(page, "30d").click();
  await page.waitForFunction(() => location.hash === "#ops?window=30d");
  const loading = page.locator(".runtime-loading");
  await loading.waitFor();
  assert.match(await loading.innerText(), /^loading 30d… showing 7d until it answers$/);
  assert.equal(await loading.getAttribute("role"), "status");
  assert.match((await loading.getAttribute("class")) ?? "", /\btone-accent-info\b/, "the loading line wears the FG-824 info tone");
  assert.equal(await showing(page), "showing 7d", "the label names the window the data on screen came from");
  assert.match(await chartLabel(page), /by day, over 7d/, "the previous series stays on screen while 30d loads");
  assert.equal(await page.locator(".runtime-body").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator(".runtime-body-loading").count(), 1, "the chart is dimmed");
  const opacity = await page.locator(".runtime-body").evaluate((el) => Number(getComputedStyle(el).opacity));
  assert.ok(opacity < 0.6, `dimmed chart opacity ${opacity}`);
  for (const w of ["1d", "7d", "30d", "90d", "all"]) assert.equal(await windowButton(page, w).isDisabled(), true, `${w} is disabled mid-read`);
  assert.equal(await windowButton(page, "7d").getAttribute("aria-pressed"), "true", "the control does not claim 30d before its data lands");
  await page.screenshot({ path: join(SHOTS, "fg836-ops-loading-30d.png"), fullPage: true });

  await settledOn(page, "30d");
  assert.match(await chartLabel(page), /by day, over 30d/);
  assert.equal(await windowButton(page, "30d").getAttribute("aria-pressed"), "true");
  assert.equal(await windowButton(page, "30d").isDisabled(), false);
  assert.equal(await page.locator(".runtime-loading").count(), 0);
  assert.match(await page.locator(".runtime-sample-note").innerText(), / in 30d$/);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(SHOTS, "fg836-ops-settled-30d.png"), fullPage: true });
  await page.close();
});

test("FG-836: the window is in the hash — a reload restores it and reads that window first", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await settledOn(page, "7d");
  await windowButton(page, "90d").click();
  await page.waitForFunction(() => location.hash === "#ops?window=90d");
  await settledOn(page, "90d");

  runtimeRequests = [];
  await page.reload();
  await settledOn(page, "90d");
  assert.equal(await page.evaluate(() => location.hash), "#ops?window=90d");
  assert.equal(runtimeRequests[0], "90d", "the reload's first runtime read is the hash's window, not the default");
  assert.equal(await windowButton(page, "90d").getAttribute("aria-pressed"), "true");
  assert.match(await chartLabel(page), /by week, over 90d/);

  await windowButton(page, "7d").click();
  await page.waitForFunction(() => location.hash === "#ops", undefined, { timeout: 5000 });
  await settledOn(page, "7d");
  await page.close();
});

test("FG-836: one window control change writes one navigable hash entry, without poll-driven history churn", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await settledOn(page, "7d");
  const before = await page.evaluate(() => history.length);

  await windowButton(page, "30d").click();
  await page.waitForFunction(() => location.hash === "#ops?window=30d");
  await settledOn(page, "30d");
  assert.equal(await page.evaluate(() => history.length), before + 1, "the control writes one hash entry");

  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => history.length), before + 1, "polling the selected window does not add history entries");
  await page.close();
});

test("FG-836: a failed read says why inline and keeps the previous series labelled as what it is", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await settledOn(page, "7d");

  statusByWindow.set("1d", 500);
  await windowButton(page, "1d").click();
  const notice = page.locator(".runtime-stale");
  await notice.waitFor();
  assert.equal(await notice.getAttribute("role"), "alert");
  assert.match(await notice.innerText(), /agent runtime unavailable — HTTP 500\. Still showing 7d — these numbers are for 7d, not 1d\./);
  assert.match((await notice.getAttribute("class")) ?? "", /\btone-accent-err\b/);
  assert.equal(await showing(page), "showing 7d");
  assert.match(await chartLabel(page), /over 7d/, "the kept series is still the 7d one");
  assert.equal(await page.locator(".runtime-loading").count(), 0, "a failed read is not a load in progress");
  assert.equal(await windowButton(page, "1d").isDisabled(), false, "the control is usable again after the failure");
  await page.screenshot({ path: join(SHOTS, "fg836-ops-failed-1d.png"), fullPage: true });

  statusByWindow.delete("1d");
  await windowButton(page, "30d").click();
  await settledOn(page, "30d");
  assert.equal(await page.locator(".runtime-stale").count(), 0, "the 1d failure is not carried onto the 30d read");
  await page.close();
});

test("FG-836: a read past the 10s client budget is cancelled and reported, never a silent freeze", async () => {
  reset();
  const page = await newPage();
  await page.clock.install();
  await page.goto(`${BASE}/#ops`);
  await settledOn(page, "7d");

  delayByWindow.set("90d", 60_000);
  await windowButton(page, "90d").click();
  await page.locator(".runtime-loading").waitFor();
  await page.clock.runFor(10_500);
  const notice = page.locator(".runtime-stale");
  await notice.waitFor();
  assert.match(await notice.innerText(), /agent runtime for 90d did not answer within 10s — the read was cancelled\. Still showing 7d/);
  assert.equal(await page.locator(".runtime-loading").count(), 0);
  assert.equal(await showing(page), "showing 7d");
  await expectEventually(() => abortedWindows.includes("90d"), "the over-budget request is aborted, not left running");
  await page.close();
});

test("FG-836: a window change mid-read aborts the in-flight read, whose late answer never lands", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await settledOn(page, "7d");

  delayByWindow.set("90d", 800);
  await windowButton(page, "90d").click();
  await page.locator(".runtime-loading").waitFor();
  // The buttons are disabled mid-read; the hash (back button, an edited URL) still moves.
  await page.evaluate(() => { location.hash = "#ops?window=1d"; });
  await settledOn(page, "1d");
  await expectEventually(() => abortedWindows.includes("90d"), "the 90d read is aborted when the window changes again");
  await page.waitForTimeout(1_000);
  assert.match(await chartLabel(page), /by hour, over 1d/, "the retired 90d response never re-charts the panel");
  assert.equal(await showing(page), "showing 1d");
  await page.close();
});

test("FG-836: an unknown window falls back to 7d silently and the hash is canonicalized", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops?window=fortnight`);
  await page.waitForFunction(() => location.hash === "#ops");
  await settledOn(page, "7d");
  assert.equal(runtimeRequests[0], "7d");
  assert.equal(await windowButton(page, "7d").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".view-notice, [role=alert]").count(), 0, "no notice for an unknown window");
  await page.close();
});

test("FG-836: changing the summary since shows the loading state over the kept summary, then \"showing 30d\"", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await summarySettledOn(page, "7d");
  assert.equal(opsRequests[0], "7d", "the summary's default window is 7d");
  assert.equal(await sinceButton(page, "7d").getAttribute("aria-pressed"), "true");
  assert.match(await page.locator(".ops-view .stat").first().innerText(), /of 39 terminal in 7d/);

  opsDelayBySince.set("30d", 1_500);
  await sinceButton(page, "30d").click();
  await page.waitForFunction(() => location.hash === "#ops?since=30d");
  const loading = page.locator(".ops-loading");
  await loading.waitFor();
  assert.match(await loading.innerText(), /^loading 30d… showing 7d until it answers$/);
  assert.equal(await loading.getAttribute("role"), "status");
  assert.match((await loading.getAttribute("class")) ?? "", /\btone-accent-info\b/, "the loading line wears the FG-824 info tone");
  assert.equal(await summaryShowing(page), "showing 7d", "the caption names the window the summary on screen came from");
  assert.match(await page.locator(".ops-view .stat").first().innerText(), /in 7d/, "the kept summary still names its own bounds");
  const body = page.locator(".ops-summary-body").first();
  assert.equal(await body.getAttribute("aria-busy"), "true");
  const opacity = await body.evaluate((el) => Number(getComputedStyle(el).opacity));
  assert.ok(opacity < 0.6, `dimmed summary opacity ${opacity}`);
  for (const w of ["7d", "30d", "all"]) assert.equal(await sinceButton(page, w).isDisabled(), true, `${w} is disabled mid-read`);
  assert.equal(await sinceButton(page, "7d").getAttribute("aria-pressed"), "true", "the control does not claim 30d before its data lands");
  await page.screenshot({ path: join(SHOTS, "fg836-ops-summary-loading-30d.png"), fullPage: true });

  await summarySettledOn(page, "30d");
  assert.equal(await sinceButton(page, "30d").getAttribute("aria-pressed"), "true");
  assert.equal(await sinceButton(page, "30d").isDisabled(), false);
  assert.equal(await page.locator(".ops-loading").count(), 0);
  assert.match(await page.locator(".ops-view .stat").first().innerText(), /of 39 terminal in 30d/,
    "identical numbers, but the caption moved with the data");
  await settledOn(page, "7d");
  assert.equal(await showing(page), "showing 7d", "the runtime window is its own control, untouched");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(SHOTS, "fg836-ops-summary-settled-30d.png"), fullPage: true });
  await page.close();
});

test("FG-836: a reload restores since and window together, each control keeping the other's value", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await summarySettledOn(page, "7d");
  await sinceButton(page, "all").click();
  await page.waitForFunction(() => location.hash === "#ops?since=all");
  await summarySettledOn(page, "all");
  await settledOn(page, "7d");
  await windowButton(page, "90d").click();
  await page.waitForFunction(() => location.hash === "#ops?since=all&window=90d");
  await settledOn(page, "90d");

  opsRequests = [];
  runtimeRequests = [];
  await page.reload();
  await summarySettledOn(page, "all");
  await settledOn(page, "90d");
  assert.equal(await page.evaluate(() => location.hash), "#ops?since=all&window=90d");
  assert.equal(opsRequests[0], "all", "the reload's first summary read is the hash's since");
  assert.equal(runtimeRequests[0], "90d");
  assert.equal(await sinceButton(page, "all").getAttribute("aria-pressed"), "true");
  assert.equal(await windowButton(page, "90d").getAttribute("aria-pressed"), "true");

  await sinceButton(page, "7d").click();
  await page.waitForFunction(() => location.hash === "#ops?window=90d");
  await summarySettledOn(page, "7d");
  assert.equal(await showing(page), "showing 90d");
  await page.close();
});

test("FG-836: an unknown since falls back to 7d silently and the hash is canonicalized", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops?since=fortnight&window=30d`);
  await page.waitForFunction(() => location.hash === "#ops?window=30d");
  await summarySettledOn(page, "7d");
  await settledOn(page, "30d");
  assert.equal(opsRequests[0], "7d");
  assert.equal(await sinceButton(page, "7d").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".view-notice, [role=alert]").count(), 0, "no notice for an unknown since");
  await page.close();
});

test("FG-836: pasted combined controls canonicalize in either order, survive reloads, and an unknown since preserves its runtime window", async () => {
  reset();
  const page = await newPage();

  await page.goto(`${BASE}/#ops?window=90d&since=all`);
  await page.waitForFunction(() => location.hash === "#ops?since=all&window=90d");
  await summarySettledOn(page, "all");
  await settledOn(page, "90d");
  await page.reload();
  await summarySettledOn(page, "all");
  await settledOn(page, "90d");

  await page.evaluate(() => { location.hash = "#ops?since=30d&window=1d"; });
  await summarySettledOn(page, "30d");
  await settledOn(page, "1d");
  assert.equal(await page.evaluate(() => location.hash), "#ops?since=30d&window=1d");
  await page.reload();
  await summarySettledOn(page, "30d");
  await settledOn(page, "1d");

  await page.evaluate(() => { location.hash = "#ops?since=unknown&window=90d"; });
  await page.waitForFunction(() => location.hash === "#ops?window=90d");
  await summarySettledOn(page, "7d");
  await settledOn(page, "90d");
  assert.equal(await windowButton(page, "90d").getAttribute("aria-pressed"), "true");
  await page.close();
});

test("FG-836: changing since while the runtime window read is in flight keeps each panel labelled with its own data", async () => {
  reset();
  const page = await newPage();
  await page.goto(`${BASE}/#ops`);
  await summarySettledOn(page, "7d");
  await settledOn(page, "7d");

  delayByWindow.set("90d", 900);
  await windowButton(page, "90d").click();
  await page.locator(".runtime-loading").waitFor();
  await page.evaluate(() => { location.hash = "#ops?since=30d&window=90d"; });
  await summarySettledOn(page, "30d");
  assert.equal(await summaryShowing(page), "showing 30d");
  assert.match(await page.locator(".ops-view .stat").first().innerText(), /in 30d/);
  assert.equal(await showing(page), "showing 7d", "the still-pending runtime reader cannot borrow the summary label");
  assert.match(await chartLabel(page), /over 7d/);

  await settledOn(page, "90d");
  assert.equal(await summaryShowing(page), "showing 30d", "the late runtime answer cannot rewrite the summary caption");
  assert.equal(await showing(page), "showing 90d");
  await page.close();
});

test("FG-836: a project scope hash change mid-summary-read retains since and only the newer scoped summary wins", async () => {
  reset();
  const page = await newPage();
  opsDelayBySince.set("30d", 700);
  await page.goto(`${BASE}/#ops?since=30d`);
  await page.locator(".ops-loading").waitFor();
  await page.evaluate(() => { location.hash = "#ops?project=alpha&since=30d"; });
  await summarySettledOn(page, "30d");
  assert.equal(await page.evaluate(() => location.hash), "#ops?project=alpha&since=30d");
  assert.match(opsRequestUrls.at(-1) ?? "", /projectKey=alpha/, "the replacement read uses the selected project scope");
  assert.match(await page.locator(".ops-view .stat").first().innerText(), /of 139 terminal in 30d/,
    "the later unscoped answer cannot repaint the selected project's summary");
  await page.waitForTimeout(800);
  assert.match(await page.locator(".ops-view .stat").first().innerText(), /of 139 terminal in 30d/);
  await page.close();
});

async function expectEventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.ok(check(), message);
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
      if (!filePath.startsWith(`${CLIENT_DIR}/`) || !existsSync(filePath) || !realpathSync(filePath).startsWith(`${CLIENT_DIR}/`)) {
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
    if (url.pathname === "/api/agent-runtime") {
      const window = url.searchParams.get("window") ?? "7d";
      runtimeRequests.push(window);
      res.on("close", () => { if (!res.writableFinished) abortedWindows.push(window); });
      const delay = delayByWindow.get(window) ?? 0;
      if (delay) await new Promise((wait) => setTimeout(wait, delay));
      if (res.destroyed) return;
      const status = statusByWindow.get(window) ?? 200;
      res.writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(status === 200 ? series.get(window) : { error: "store read failed" }));
      return;
    }
    if (url.pathname === "/api/ops") {
      const since = url.searchParams.get("since") ?? "7d";
      opsRequests.push(since);
      opsRequestUrls.push(url.search);
      const delay = opsDelayBySince.get(since) ?? 0;
      if (delay) await new Promise((wait) => setTimeout(wait, delay));
      if (res.destroyed) return;
      const projectKey = url.searchParams.get("projectKey");
      const body = projectKey === "alpha"
        ? { ...opsFixture, runs: { ...opsFixture.runs, terminal: 139 } }
        : opsFixture;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ generatedAt: new Date(0).toISOString(), services: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
