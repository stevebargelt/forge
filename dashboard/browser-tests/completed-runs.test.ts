// FG-683: the ops view's metric selector — "Average agent runtime" (the default,
// unchanged) and "Completed runs" (a count of forge runs per bucket). Driven in a
// real Chrome against the real shell + client, with both endpoints stubbed.
// Mirrors browser-tests/agent-runtime.test.ts.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");

const DAY = 86_400_000;
const WEEK = 604_800_000;

type DurationBucket = { bucketStart: string; averageMs: number | null; sampleCount: number; partial: boolean };
type CountBucket = { bucketStart: string; completedRuns: number; partial: boolean };

const durationPoint = (bucketStart: string, averageMs: number | null, sampleCount: number, partial = false): DurationBucket =>
  ({ bucketStart, averageMs, sampleCount, partial });
const countPoint = (bucketStart: string, completedRuns: number, partial = false): CountBucket =>
  ({ bucketStart, completedRuns, partial });

// The duration payload, exactly as FG-648 shipped it: a null average on the empty
// bucket, per-role series, and a task sample count.
const durationTrends = {
  window: "7d",
  resolution: "day",
  bucketMs: DAY,
  rangeStart: "2026-06-06T00:00:00.000Z",
  rangeEnd: "2026-06-10T14:30:00.000Z",
  overall: [
    durationPoint("2026-06-06T00:00:00.000Z", 90_000, 4),
    durationPoint("2026-06-07T00:00:00.000Z", 150_000, 6),
    durationPoint("2026-06-08T00:00:00.000Z", null, 0),
    durationPoint("2026-06-09T00:00:00.000Z", 12_600_000, 3),
    durationPoint("2026-06-10T00:00:00.000Z", 45_000, 1, true),
  ],
  byRole: [{
    role: "engineer",
    buckets: [
      durationPoint("2026-06-06T00:00:00.000Z", 90_000, 4),
      durationPoint("2026-06-07T00:00:00.000Z", 150_000, 6),
      durationPoint("2026-06-08T00:00:00.000Z", null, 0),
      durationPoint("2026-06-09T00:00:00.000Z", 12_600_000, 3),
      durationPoint("2026-06-10T00:00:00.000Z", 45_000, 1, true),
    ],
  }],
  roleSummary: [{ role: "engineer", averageMs: 4_610_625, sampleCount: 14 }],
};

// The count payload over the SAME grid. Two zero buckets — one interior, one
// leading — because a zero completion count is an observation, not a gap.
const dailyCounts = [
  countPoint("2026-06-06T00:00:00.000Z", 3),
  countPoint("2026-06-07T00:00:00.000Z", 0),
  countPoint("2026-06-08T00:00:00.000Z", 5),
  countPoint("2026-06-09T00:00:00.000Z", 2),
  countPoint("2026-06-10T00:00:00.000Z", 4, true),
];
const dailyTotal = dailyCounts.reduce((sum, b) => sum + b.completedRuns, 0);

const dailyCountTrends = {
  window: "7d",
  resolution: "day",
  bucketMs: DAY,
  rangeStart: dailyCounts[0]!.bucketStart,
  rangeEnd: "2026-06-10T14:30:00.000Z",
  buckets: dailyCounts,
  totalCompletedRuns: dailyTotal,
};

// 25 hourly buckets — the density at which the axis has to thin its labels, and
// the case the per-bucket fallback list exists for.
const HOURLY_START = Date.parse("2026-06-09T14:00:00.000Z");
const hourlyCounts = Array.from({ length: 25 }, (_, i) =>
  countPoint(new Date(HOURLY_START + i * 3_600_000).toISOString(), i % 3 === 1 ? 0 : 1 + (i % 4), i === 24));
const hourlyCountTrends = {
  window: "1d",
  resolution: "hour",
  bucketMs: 3_600_000,
  rangeStart: hourlyCounts[0]!.bucketStart,
  rangeEnd: "2026-06-10T14:30:00.000Z",
  buckets: hourlyCounts,
  totalCompletedRuns: hourlyCounts.reduce((sum, b) => sum + b.completedRuns, 0),
};

// A window in which nothing ever completed: every bucket is a real, observed zero.
const allZeroCountTrends = {
  window: "30d",
  resolution: "day",
  bucketMs: DAY,
  rangeStart: "2026-06-08T00:00:00.000Z",
  rangeEnd: "2026-06-10T14:30:00.000Z",
  buckets: [
    countPoint("2026-06-08T00:00:00.000Z", 0),
    countPoint("2026-06-09T00:00:00.000Z", 0),
    countPoint("2026-06-10T00:00:00.000Z", 0, true),
  ],
  totalCompletedRuns: 0,
};

// Nothing in scope at all: no range, no grid — the empty state, not a chart of zeros.
const emptyCountTrends = {
  window: "all",
  resolution: "week",
  bucketMs: WEEK,
  rangeStart: null,
  rangeEnd: "2026-06-10T14:30:00.000Z",
  buckets: [],
  totalCompletedRuns: 0,
};

const opsFixture = {
  runs: { total: 40, active: 1, terminal: 39, clean: 30, withFailures: 9, successRate: 0.77 },
  taskCount: 190,
  counts: { idleKills: 1, cancels: 2, retries: 3, redBlocks: 4 },
  failureKinds: [],
  durations: [],
};

const countsByWindow = new Map<string, typeof dailyCountTrends | typeof emptyCountTrends>([
  ["1d", hourlyCountTrends],
  ["7d", dailyCountTrends],
  ["30d", allZeroCountTrends],
  ["all", emptyCountTrends],
]);

let countsStatus = 200;
let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

test("The panel offers both metrics, and Average agent runtime is the default", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();

  const metrics = page.getByRole("group", { name: "metric:" }).getByRole("button");
  assert.deepEqual(await metrics.allTextContents(), ["Average agent runtime", "Completed runs"]);
  assert.equal(await metric(page, "Average agent runtime").getAttribute("aria-pressed"), "true");
  assert.equal(await metric(page, "Completed runs").getAttribute("aria-pressed"), "false");

  // The default view is the duration chart, entirely as it was: duration bars,
  // the role breakdown, and the completed-agent-task sample note.
  await page.locator(".runtime-chart svg").waitFor();
  assert.equal(await page.locator(".runs-chart").count(), 0);
  assert.equal(await page.locator(".runtime-role-select").inputValue(), "__all__");
  assert.match(await page.locator(".runtime-selector").innerText(), /14 runs in 7d/);
  assert.deepEqual(await page.locator(".runtime-chart svg .runtime-y-tick").allTextContents(),
    ["0s", "1h", "2h", "3h", "4h"]);
  await page.close();
});

test("Completed runs charts an integer count axis, labelled in runs, that cannot be read as the duration chart", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();

  // Its own title, distinguishable from the duration chart's at a glance.
  await page.getByRole("heading", { name: "Completed runs over time" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Average agent runtime over time" }).count(), 0);
  assert.equal(await metric(page, "Completed runs").getAttribute("aria-pressed"), "true");

  // An integer y-axis, in runs, with the unit named on the chart itself.
  const ticks = await page.locator(".runs-chart svg .runs-y-tick").allTextContents();
  assert.deepEqual(ticks, ["0", "2", "4", "6"], `the count axis steps in whole runs: ${ticks.join(",")}`);
  for (const tick of ticks) assert.match(tick, /^\d+$/, `a count tick carries no duration unit: ${tick}`);
  assert.equal(await page.locator(".runs-chart svg .runs-axis-unit").textContent(), "runs");

  // Every bucket's count is on the plot, the zero bucket included.
  assert.deepEqual(await page.locator(".runs-chart svg .runs-value").allTextContents(), ["3", "0", "5", "2", "4"]);
  assert.equal(await page.locator(".runs-chart rect.runs-bar").count(), 5);
  assert.equal(await page.locator(".runs-chart rect.runs-bar-zero").count(), 1, "the zero bucket draws, on the baseline");
  assert.equal(await page.locator(".runs-chart rect.runs-bar-partial").count(), 1);

  // The range total, stated once and unambiguously, equal to the sum of the bars.
  assert.equal(await page.locator(".runs-total-num").textContent(), String(dailyTotal));
  assert.match(await page.locator(".runs-total").innerText(), new RegExp(`${dailyTotal}\\s+completed runs in 7d`));
  const plotted = (await page.locator(".runs-chart svg .runs-value").allTextContents())
    .reduce((sum, text) => sum + Number(text), 0);
  assert.equal(plotted, dailyTotal);

  // None of the duration metric's furniture appears on this view.
  const panel = await page.locator(".runtime-view").innerText();
  assert.doesNotMatch(panel, /Average agent runtime for/);
  assert.doesNotMatch(panel, /\d+h\d+m|\d+m\d+s/, `no duration reading may appear on the count chart: ${panel}`);
  assert.equal(await page.locator(".runtime-role-select").count(), 0, "there is no per-role duration series here");
  assert.equal(await page.locator(".runtime-table").count(), 0, "the role breakdown belongs to the duration metric");
  assert.equal(await page.locator(".runtime-sample-note").count(), 0, "the agent-task sample note is not a run count");
  assert.equal(await page.locator(".runtime-chart rect.runtime-bar").count(), 0);

  // The accessible name says what it is, in runs, with the total.
  const label = await page.locator(".runs-chart svg").getAttribute("aria-label") ?? "";
  assert.match(label, /^Completed runs by day, over 7d\./);
  assert.match(label, new RegExp(`Total ${dailyTotal} completed runs\\.$`));

  // The caption states the counting rule the operator has to know to read it.
  const caption = await page.locator(".runs-caption").innerText();
  assert.match(caption, /Completed forge runs per day, counted once each and bucketed by run completion time/);
  assert.match(caption, /Interactive orchestrator\s+sessions are excluded/);
  assert.match(caption, /a run that started earlier still counts in the day it finished in/);
  await page.close();
});

test("A window with no completions charts real zeros, and a window with no runs at all is an empty state", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();

  // 30d: every bucket observed, every bucket zero. The chart still draws, and
  // every bar says 0 — the duration metric's "no runs" gap would be a lie here.
  await runtimeWindow(page, "30d").click();
  await page.getByRole("img", { name: /over 30d/ }).waitFor();
  assert.deepEqual(await page.locator(".runs-chart svg .runs-value").allTextContents(), ["0", "0", "0"]);
  assert.equal(await page.locator(".runs-chart rect.runs-bar-zero").count(), 3);
  assert.equal(await page.locator(".runs-total-num").textContent(), "0");
  assert.match(await page.locator(".runs-total").innerText(), /0\s+completed runs in 30d/);
  assert.deepEqual(await page.locator(".runs-chart svg .runs-y-tick").allTextContents(), ["0", "1"]);

  // all: no range at all — there is no grid to draw, so it is an empty state.
  await runtimeWindow(page, "all").click();
  await page.locator(".runs-empty").waitFor();
  assert.match(await page.locator(".runs-empty").innerText(), /No completed runs in this window/);
  assert.equal(await page.locator(".runs-chart").count(), 0);
  await page.close();
});

test("A dense window thins its axis labels and spells every bucket's count out beneath the plot", async () => {
  const page = await newPage({ width: 1280, height: 1100 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();

  await runtimeWindow(page, "1d").click();
  await page.getByRole("img", { name: /Completed runs by hour, over 1d/ }).waitFor();
  const labels = await page.locator(".runs-chart svg .runs-x-tick").allTextContents();
  assert.ok(labels.length < 25, `25 hourly labels cannot all be drawn: ${labels.length}`);
  assert.match(labels.at(-1) ?? "", /^6\/10 14:00 UTC$/, "the current bucket is always labelled");

  const listed = page.locator(".runs-bucket-values li");
  assert.equal(await listed.count(), 25);
  assert.match(await listed.first().innerText(), /Jun 9 14:00 – Jun 9 15:00 UTC\s+1 run/);
  assert.match(await listed.nth(1).innerText(), /Jun 9 15:00 – Jun 9 16:00 UTC\s+0 runs/);
  assert.equal(await page.locator(".runs-total-num").textContent(), String(hourlyCountTrends.totalCompletedRuns));
  await page.close();
});

// The presentation toggle moves LABELS. Bucket membership, counts, the range
// boundaries and the total are decided by the UTC-aligned grid underneath it, and
// a reader switching zones must not see throughput change.
test("Local and UTC presentation change the labels only — never a count, a bucket, a boundary or the total", async () => {
  const page = await newPage({ width: 1440, height: 1200 }, { timezoneId: "America/Los_Angeles" });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();

  const reading = async () => ({
    values: await page.locator(".runs-chart svg .runs-value").allTextContents(),
    total: await page.locator(".runs-total-num").textContent(),
    bars: await page.locator(".runs-chart rect.runs-bar").count(),
    zeroBars: await page.locator(".runs-chart rect.runs-bar-zero").count(),
    partialBars: await page.locator(".runs-chart rect.runs-bar-partial").count(),
    tableCounts: await page.locator(".runs-text-equivalent tbody td").allTextContents(),
  });

  const tz = (name: string) => page.getByRole("group", { name: "times:" }).getByRole("button")
    .filter({ hasText: new RegExp(`^${name}$`) });

  const local = await reading();
  const localTicks = await page.locator(".runs-chart svg .runs-x-tick").allTextContents();
  assert.deepEqual(localTicks, ["6/5 PDT", "6/6 PDT", "6/7 PDT", "6/8 PDT", "6/9 PDT"]);

  await tz("UTC").click();
  await page.locator(".runs-chart svg").waitFor();
  const utc = await reading();
  const utcTicks = await page.locator(".runs-chart svg .runs-x-tick").allTextContents();
  assert.deepEqual(utcTicks, ["6/6 UTC", "6/7 UTC", "6/8 UTC", "6/9 UTC", "6/10 UTC"]);

  // The labels moved; nothing a count is read off did.
  assert.notDeepEqual(localTicks, utcTicks, "the toggle must actually change the presentation");
  assert.deepEqual(utc, local, "counts, buckets and the total are the same numbers in both modes");
  assert.deepEqual(local.values, ["3", "0", "5", "2", "4"]);
  assert.equal(local.total, String(dailyTotal));
  assert.deepEqual(local.tableCounts, ["3", "0", "5", "2", "4"]);

  // The bucket a given count sits in is the same bucket in both modes: the third
  // bar carries 5 either way, and only its stated endpoints move.
  const thirdBarTitle = () => page.locator(".runs-chart rect.runs-bar").nth(2).innerHTML();
  assert.match(await thirdBarTitle(), /Jun 8 00:00 – Jun 9 00:00 UTC: 5 completed runs/);
  await tz("Local").click();
  await page.locator(".runs-chart svg").waitFor();
  assert.match(await thirdBarTitle(), /Jun 7 17:00 – Jun 8 17:00 PDT: 5 completed runs/);
  await page.close();
});

test("Switching back to Average agent runtime restores the duration chart untouched", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();
  await metric(page, "Average agent runtime").click();
  await page.getByRole("img", { name: /Average agent runtime for All agents/ }).waitFor();

  assert.equal(await page.locator(".runs-chart").count(), 0);
  assert.equal(await page.locator(".runs-total").count(), 0);
  assert.deepEqual(await page.locator(".runtime-chart svg .runtime-value").allTextContents(),
    ["1.5m", "2.5m", "3.5h", "45s"]);
  assert.deepEqual(await page.locator(".runtime-chart svg .runtime-count").allTextContents(), ["4", "6", "0", "3", "1"]);
  assert.equal(await page.locator(".runtime-chart svg .runtime-count-head").textContent(), "RUNS");
  assert.match(await page.locator(".runtime-caption").innerText(), /Mean duration of completed agent tasks per day/);
  assert.match(await page.locator(".runtime-selector").innerText(), /14 runs in 7d/);
  await page.close();
});

test("A failing completed-runs read is reported without touching the duration series", async () => {
  const page = await newPage({ width: 1280, height: 1100 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  countsStatus = 500;
  await metric(page, "Completed runs").click();
  const error = page.locator(".runtime-error");
  await error.waitFor();
  assert.match(await error.innerText(), /completed runs unavailable — HTTP 500/);
  assert.equal(await error.getAttribute("role"), "alert");

  countsStatus = 200;
  await metric(page, "Average agent runtime").click();
  await page.getByRole("img", { name: /Average agent runtime for All agents/ }).waitFor();
  assert.equal(await page.locator(".runtime-error").count(), 0);
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();
  assert.equal(await page.locator(".runs-total-num").textContent(), String(dailyTotal));
  await page.close();
});

test("The count chart stays contained and legible at a narrow viewport", async () => {
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();

  const layout = await page.evaluate(() => {
    const svg = document.querySelector(".runs-chart svg")!.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      svgRight: svg.right,
      svgWidth: svg.width,
      axisTextPx: Array.from(document.querySelectorAll(".runs-chart svg text"))
        .map((element) => element.getBoundingClientRect().height),
      clipped: Array.from(document.querySelectorAll(".runs-chart svg text")).flatMap((element) => {
        const box = element.getBoundingClientRect();
        const escapes = box.top < svg.top - 0.5 || box.bottom > svg.bottom + 0.5
          || box.left < svg.left - 0.5 || box.right > svg.right + 0.5;
        return escapes ? [element.textContent ?? ""] : [];
      }),
    };
  });
  assert.ok(layout.documentWidth <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.svgRight <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.svgWidth > 200, JSON.stringify(layout));
  assert.ok(Math.min(...layout.axisTextPx) >= 8, `count-chart labels must stay legible: ${JSON.stringify(layout.axisTextPx)}`);
  assert.deepEqual(layout.clipped, [], "no count-chart label may be clipped by the viewBox");
  assert.equal(await labelRowOverlaps(page), null, "count-chart labels must not collide at 390px");
  await page.close();
});

/** True when two labels in one row of the count chart intersect horizontally. */
async function labelRowOverlaps(page: Page): Promise<string | null> {
  for (const row of [".runs-x-tick", ".runs-value"]) {
    const collides = await page.evaluate((sel) => {
      const boxes = Array.from(document.querySelectorAll(`.runs-chart svg ${sel}`))
        .map((element) => element.getBoundingClientRect())
        .sort((a, b) => a.left - b.left);
      return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1]!.right);
    }, row);
    if (collides) return row;
  }
  return null;
}

/** The panel's metric button. */
function metric(page: Page, name: string) {
  return page.getByRole("group", { name: "metric:" }).getByRole("button")
    .filter({ hasText: new RegExp(`^${name}$`) });
}

/** The panel's own window button — distinct from the ops-summary row above it. */
function runtimeWindow(page: Page, name: string) {
  return page.getByRole("group", { name: "runtime window:" }).getByRole("button")
    .filter({ hasText: new RegExp(`^${name}$`) });
}

async function newPage(
  viewport: { width: number; height: number },
  options: { timezoneId?: string } = {},
): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce", timezoneId: "UTC", ...options });
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
    if (url.pathname === "/api/agent-runtime") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(durationTrends));
      return;
    }
    if (url.pathname === "/api/completed-runs") {
      if (countsStatus !== 200) {
        res.writeHead(countsStatus, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "store read failed" }));
        return;
      }
      const window = url.searchParams.get("window") ?? "7d";
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(countsByWindow.get(window) ?? emptyCountTrends));
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
