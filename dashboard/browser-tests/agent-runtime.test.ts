// FG-648: the ops view's "average agent runtime over time" chart, driven in a
// real Chrome against the real shell + client with a stubbed /api/agent-runtime.
// Mirrors browser-tests/usage-limits.test.ts.

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

type Bucket = { bucketStart: string; averageMs: number | null; sampleCount: number; partial: boolean };
type Trends = {
  window: string;
  resolution: string;
  bucketMs: number;
  rangeStart: string | null;
  rangeEnd: string;
  overall: Bucket[];
  byRole: Array<{ role: string; buckets: Bucket[] }>;
  roleSummary: Array<{ role: string; averageMs: number; sampleCount: number }>;
};

const point = (bucketStart: string, averageMs: number | null, sampleCount: number, partial = false): Bucket =>
  ({ bucketStart, averageMs, sampleCount, partial });

// 5 daily buckets: a gap on day 3 (no runs), a partial trailing bucket, and a
// multi-hour average so the long-duration formatting is exercised for real.
const dailyTrends: Trends = {
  window: "7d",
  resolution: "day",
  bucketMs: DAY,
  rangeStart: "2026-06-06T00:00:00.000Z",
  rangeEnd: "2026-06-10T14:30:00.000Z",
  overall: [
    point("2026-06-06T00:00:00.000Z", 90_000, 4),
    point("2026-06-07T00:00:00.000Z", 150_000, 6),
    point("2026-06-08T00:00:00.000Z", null, 0),
    point("2026-06-09T00:00:00.000Z", 12_600_000, 3),
    point("2026-06-10T00:00:00.000Z", 45_000, 1, true),
  ],
  byRole: [
    {
      role: "engineer",
      buckets: [
        point("2026-06-06T00:00:00.000Z", 120_000, 2),
        point("2026-06-07T00:00:00.000Z", 200_000, 3),
        point("2026-06-08T00:00:00.000Z", null, 0),
        point("2026-06-09T00:00:00.000Z", 18_000_000, 2),
        point("2026-06-10T00:00:00.000Z", 45_000, 1, true),
      ],
    },
    {
      role: "red-wide",
      buckets: [
        point("2026-06-06T00:00:00.000Z", 60_000, 2),
        point("2026-06-07T00:00:00.000Z", 100_000, 3),
        point("2026-06-08T00:00:00.000Z", null, 0),
        point("2026-06-09T00:00:00.000Z", 1_800_000, 1),
        point("2026-06-10T00:00:00.000Z", null, 0, true),
      ],
    },
  ],
  roleSummary: [
    { role: "engineer", averageMs: 4_610_625, sampleCount: 8 },
    { role: "red-wide", averageMs: 370_000, sampleCount: 6 },
  ],
};

// The real 1d shape: 25 hourly buckets. Dense enough that naive axis labelling
// collides, which is the case the thinning rule has to survive.
const HOURLY_START = Date.parse("2026-06-09T14:00:00.000Z");
const hourlyBuckets = Array.from({ length: 25 }, (_, i) => {
  const start = new Date(HOURLY_START + i * 3_600_000).toISOString();
  const empty = i % 4 === 1;
  return point(start, empty ? null : 30_000 + i * 4_000, empty ? 0 : 1 + (i % 3), i === 24);
});
const hourlySamples = hourlyBuckets.reduce((sum, b) => sum + b.sampleCount, 0);

const hourlyTrends: Trends = {
  window: "1d",
  resolution: "hour",
  bucketMs: 3_600_000,
  rangeStart: hourlyBuckets[0]!.bucketStart,
  rangeEnd: "2026-06-10T14:30:00.000Z",
  overall: hourlyBuckets,
  byRole: [{ role: "engineer", buckets: hourlyBuckets }],
  roleSummary: [{ role: "engineer", averageMs: 78_000, sampleCount: hourlySamples }],
};

// A single observed point, on the partial bucket — the degenerate chart case.
const singlePointTrends: Trends = {
  window: "30d",
  resolution: "day",
  bucketMs: DAY,
  rangeStart: "2026-06-10T00:00:00.000Z",
  rangeEnd: "2026-06-10T14:30:00.000Z",
  overall: [point("2026-06-10T00:00:00.000Z", 7_384_000, 1, true)],
  byRole: [{ role: "documentation-maintainer", buckets: [point("2026-06-10T00:00:00.000Z", 7_384_000, 1, true)] }],
  roleSummary: [{ role: "documentation-maintainer", averageMs: 7_384_000, sampleCount: 1 }],
};

const emptyTrends: Trends = {
  window: "90d",
  resolution: "week",
  bucketMs: 604_800_000,
  rangeStart: null,
  rangeEnd: "2026-06-10T14:30:00.000Z",
  overall: [],
  byRole: [],
  roleSummary: [],
};

const opsFixture = {
  runs: { total: 40, active: 1, terminal: 39, clean: 30, withFailures: 9, successRate: 0.77 },
  taskCount: 190,
  counts: { idleKills: 1, cancels: 2, retries: 3, redBlocks: 4 },
  failureKinds: [],
  durations: [],
};

const trendsByWindow = new Map<string, Trends>([
  ["1d", hourlyTrends],
  ["7d", dailyTrends],
  ["30d", singlePointTrends],
  ["90d", emptyTrends],
  ["all", emptyTrends],
]);

let runtimeDelayMs = 0;
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

test("Ops defaults to the All agents series and renders an accessible, labelled chart", async () => {
  runtimeDelayMs = 0;
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();
  await page.locator(".runtime-chart svg").waitFor();

  assert.equal(await page.locator(".runtime-role-select").inputValue(), "__all__");
  assert.match(await page.locator(".runtime-selector").innerText(), /14 runs in 7d/);

  // The chart is not a bare unlabelled canvas: it carries an accessible name
  // that states the series, the resolution, and the plotted values.
  const chart = page.getByRole("img", { name: /Average agent runtime for All agents/ });
  assert.equal(await chart.count(), 1);
  const label = await chart.getAttribute("aria-label") ?? "";
  assert.match(label, /by day, over 7d/);
  assert.match(label, /6\/9 3h30m/, "a multi-hour average must read as hours, not raw ms");
  assert.match(label, /6\/10 45s \(partial\)/);
  assert.doesNotMatch(label, /6\/8/, "the empty bucket must not appear as a plotted value");

  // Four bars for four observed buckets; the empty bucket draws no bar.
  assert.equal(await page.locator(".runtime-chart rect.runtime-bar").count(), 4);
  assert.equal(await page.locator(".runtime-chart rect.runtime-bar-partial").count(), 1);

  const equivalent = await page.locator(".runtime-text-equivalent").innerText();
  assert.match(equivalent, /6\/8\s+no runs\s+0/, "an empty bucket reads as 'no runs', never 0s");
  assert.match(equivalent, /6\/10 \(partial\)/);
  await page.close();
});

test("The partial bucket is visibly identified in the chart affordance", async () => {
  const page = await newPage({ width: 1280, height: 1100 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  const note = page.locator(".runtime-partial-note");
  assert.equal(await note.count(), 1);
  assert.match(await note.innerText(), /The last day \(6\/10\) is hatched/);
  const partialFill = await page.locator(".runtime-chart rect.runtime-bar-partial").getAttribute("fill");
  assert.equal(partialFill, "url(#runtime-partial-hatch)");
  const solidFill = await page.locator(".runtime-chart rect.runtime-bar:not(.runtime-bar-partial)").first().getAttribute("fill");
  assert.equal(solidFill, "var(--accent)");
  await page.close();
});

test("Selecting an observed role recharts that role, from the selector and the breakdown table", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  // The breakdown table lists every observed role with its average and sample count.
  const rows = page.locator(".runtime-table tbody tr");
  assert.deepEqual(await rows.locator("th button").allTextContents(), ["All agents", "engineer", "red-wide"]);
  // "All agents" is the sample-weighted mean of the roles below it, not a mean of means.
  const cells = await rows.locator("td").allTextContents();
  assert.deepEqual(cells, ["46m33s", "14", "1h16m", "8", "6m10s", "6"]);

  await page.getByRole("button", { name: "engineer", exact: true }).click();
  await page.getByRole("img", { name: /Average agent runtime for engineer/ }).waitFor();
  assert.equal(await page.locator(".runtime-role-select").inputValue(), "engineer");
  assert.equal(await page.getByRole("button", { name: "engineer", exact: true }).getAttribute("aria-pressed"), "true");
  assert.match(await page.locator(".runtime-selector").innerText(), /8 runs in 7d/);
  assert.match(await page.locator(".runtime-text-equivalent").innerText(), /6\/9\s+5h0m\s+2/);

  await page.locator(".runtime-role-select").selectOption("red-wide");
  await page.getByRole("img", { name: /Average agent runtime for red-wide/ }).waitFor();
  assert.match(await page.locator(".runtime-selector").innerText(), /6 runs in 7d/);
  // red-wide has no runs in the partial bucket: 3 bars, none partial.
  assert.equal(await page.locator(".runtime-chart rect.runtime-bar").count(), 3);
  assert.equal(await page.locator(".runtime-chart rect.runtime-bar-partial").count(), 0);
  assert.equal(await page.locator(".runtime-partial-note").count(), 0);

  await page.getByRole("button", { name: "All agents" }).click();
  await page.getByRole("img", { name: /Average agent runtime for All agents/ }).waitFor();
  assert.equal(await page.locator(".runtime-role-select").inputValue(), "__all__");
  await page.close();
});

test("Window controls switch resolution, and cover the empty and single-point cases", async () => {
  const page = await newPage({ width: 1280, height: 1100 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  // The runtime window group is distinct from the ops-summary window row above it.
  const windows = page.getByRole("group", { name: "runtime window:" }).getByRole("button");
  assert.deepEqual(await windows.allTextContents(), ["1d", "7d", "30d", "90d", "all"]);
  assert.equal(await windows.nth(1).getAttribute("aria-pressed"), "true");
  const pick = (name: string) => windows.filter({ hasText: new RegExp(`^${name}$`) });

  // 1d — hourly labels, and the one empty leading hour draws no bar.
  await pick("1d").click();
  await page.getByRole("img", { name: /by hour, over 1d/ }).waitFor();
  assert.equal(await page.locator(".runtime-chart rect.runtime-bar").count(), 19, "6 of 25 hourly buckets are empty");
  assert.match(await page.locator(".runtime-chart svg").textContent() ?? "", /14:00/);
  assert.match(await page.locator(".runtime-caption").innerText(), /per hour \(UTC\)/);
  // 25 buckets in a 1000-unit viewBox cannot all be labelled without colliding.
  const hourLabels = await page.locator(".runtime-chart svg text").allTextContents();
  assert.ok(hourLabels.length < 25, `the hourly axis must thin its labels: ${hourLabels.length}`);
  assert.equal(await axisLabelsOverlap(page), false, "hourly axis labels must not run into each other");
  // The trailing (current) bucket is always labelled, whatever the thinning drops.
  assert.match(hourLabels.at(-1) ?? "", /^14:00$/);

  // 30d — a single point, still a legible bar inside the plot area.
  await pick("30d").click();
  await page.getByRole("img", { name: /Average agent runtime for All agents/ }).waitFor();
  await page.getByRole("button", { name: "documentation-maintainer" }).waitFor();
  const bar = page.locator(".runtime-chart rect.runtime-bar");
  assert.equal(await bar.count(), 1);
  const box = await bar.boundingBox();
  const svgBox = await page.locator(".runtime-chart svg").boundingBox();
  assert.ok(box && svgBox, "the single bar must be laid out");
  assert.ok(box.width > 4 && box.height > 4, JSON.stringify(box));
  assert.ok(box.x >= svgBox.x - 1 && box.x + box.width <= svgBox.x + svgBox.width + 1, JSON.stringify({ box, svgBox }));
  assert.match(await page.locator(".runtime-table").innerText(), /2h3m/, "a multi-hour average must format as hours");

  // 90d — no observations at all: an empty state, not an empty chart.
  await pick("90d").click();
  await page.locator(".runtime-empty").waitFor();
  assert.match(await page.locator(".runtime-empty").innerText(), /No completed agent runs for All agents in this window/);
  assert.equal(await page.locator(".runtime-chart").count(), 0);
  assert.equal(await page.locator(".runtime-table").count(), 0);
  assert.match(await page.locator(".runtime-selector").innerText(), /0 runs in 90d/);

  await pick("7d").click();
  await page.getByRole("img", { name: /Average agent runtime for All agents/ }).waitFor();
  await page.close();
});

test("The runtime panel shows a loading state before the first response", async () => {
  runtimeDelayMs = 400;
  const page = await newPage({ width: 1280, height: 1000 });
  await page.goto(`${baseUrl}/#ops`);
  const loading = page.locator(".runtime-loading");
  await loading.waitFor();
  assert.match(await loading.innerText(), /loading agent runtime/);
  assert.equal(await loading.getAttribute("role"), "status");
  // The window controls stay usable while the series is in flight.
  assert.equal(await page.locator(".runtime-window-btns button").count(), 5);
  await page.locator(".runtime-chart svg").waitFor();
  assert.equal(await page.locator(".runtime-loading").count(), 0);
  runtimeDelayMs = 0;
  await page.close();
});

test("The runtime panel stays contained and legible at a narrow viewport", async () => {
  runtimeDelayMs = 0;
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  const layout = await page.evaluate(() => {
    const svg = document.querySelector(".runtime-chart svg")?.getBoundingClientRect();
    const table = document.querySelector(".runtime-table")?.getBoundingClientRect();
    const select = document.querySelector(".runtime-role-select")?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      svgRight: svg ? svg.right : 0,
      svgWidth: svg ? svg.width : 0,
      tableRight: table ? table.right : 0,
      selectRight: select ? select.right : 0,
      barsVisible: Array.from(document.querySelectorAll(".runtime-chart rect.runtime-bar"))
        .every((element) => element.getBoundingClientRect().width >= 1),
      // The rendered (post-viewBox-scale) axis text height in CSS pixels.
      axisTextPx: Array.from(document.querySelectorAll(".runtime-chart svg text"))
        .map((element) => element.getBoundingClientRect().height),
      // Nothing may be clipped off the top or bottom of the scaled viewBox. Each
      // offender carries its measured overflow so a failure names the label and
      // the pixels instead of reading "false !== true".
      clippedLabels: Array.from(document.querySelectorAll(".runtime-chart svg text")).flatMap((element) => {
        const svgBox = document.querySelector(".runtime-chart svg")!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const overflowTopPx = +(svgBox.top - box.top).toFixed(2);
        const overflowBottomPx = +(box.bottom - svgBox.bottom).toFixed(2);
        if (overflowTopPx <= 0.5 && overflowBottomPx <= 0.5) return [];
        return [{
          text: element.textContent ?? "",
          escapes: overflowTopPx > 0.5 ? "top" : "bottom",
          overflowTopPx,
          overflowBottomPx,
          textTop: +box.top.toFixed(2),
          textBottom: +box.bottom.toFixed(2),
          svgTop: +svgBox.top.toFixed(2),
          svgBottom: +svgBox.bottom.toFixed(2),
        }];
      }),
    };
  });
  const textInsideSvg = layout.clippedLabels.length === 0;
  assert.ok(layout.documentWidth <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.bodyWidth <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.svgRight <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.svgWidth > 200, JSON.stringify(layout));
  assert.ok(layout.tableRight <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.selectRight <= layout.innerWidth, JSON.stringify(layout));
  assert.equal(layout.barsVisible, true, JSON.stringify(layout));
  // The viewBox scales the axis text down with the column. It must still be readable.
  assert.ok(layout.axisTextPx.length > 0, JSON.stringify(layout));
  assert.ok(Math.min(...layout.axisTextPx) >= 8, `axis labels must stay legible: ${JSON.stringify(layout.axisTextPx)}`);
  assert.equal(textInsideSvg, true,
    `no chart label may be clipped by the viewBox — clipped: ${JSON.stringify(layout.clippedLabels)}`);
  assert.equal(await axisLabelsOverlap(page), false, "axis labels must not collide at a narrow width");

  // Long durations must not overflow their cell at this width.
  assert.match(await page.locator(".runtime-table").innerText(), /1h16m/);
  await page.close();
});

/** True when any two axis labels' rendered boxes intersect horizontally. */
async function axisLabelsOverlap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll(".runtime-chart svg text"))
      .filter((element) => /^[0-9]/.test(element.textContent ?? ""))
      .map((element) => element.getBoundingClientRect())
      .sort((a, b) => a.left - b.left);
    return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1]!.right);
  });
}

async function newPage(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
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
    if (url.pathname === "/api/agent-runtime") {
      if (runtimeDelayMs) await new Promise((wait) => setTimeout(wait, runtimeDelayMs));
      const trends = trendsByWindow.get(url.searchParams.get("window") ?? "7d") ?? emptyTrends;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(trends));
      return;
    }
    if (url.pathname === "/api/ops") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(opsFixture));
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ generatedAt: new Date(0).toISOString(), services: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
