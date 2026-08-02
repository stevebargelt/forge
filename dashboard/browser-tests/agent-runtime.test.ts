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

// The real 90d shape: 14 weekly buckets. `wk 6/10` is the WIDEST label form the
// axis thinning has to survive, so this is the fixture that decides whether the
// rule holds — a weekly window rendered as an empty payload proves nothing.
const WEEK = 604_800_000;
const WEEKLY_START = Date.parse("2026-03-09T00:00:00.000Z");
const weeklyBuckets = Array.from({ length: 14 }, (_, i) => {
  const start = new Date(WEEKLY_START + i * WEEK).toISOString();
  const empty = i === 2 || i === 9;
  return point(start, empty ? null : 240_000 + i * 30_000, empty ? 0 : 2 + (i % 4), i === 13);
});
const weeklySamples = weeklyBuckets.reduce((sum, b) => sum + b.sampleCount, 0);

const weeklyTrends: Trends = {
  window: "90d",
  resolution: "week",
  bucketMs: WEEK,
  rangeStart: weeklyBuckets[0]!.bucketStart,
  rangeEnd: "2026-06-10T14:30:00.000Z",
  overall: weeklyBuckets,
  byRole: [{ role: "engineer", buckets: weeklyBuckets }],
  roleSummary: [{ role: "engineer", averageMs: 435_000, sampleCount: weeklySamples }],
};

const emptyTrends: Trends = {
  window: "all",
  resolution: "week",
  bucketMs: WEEK,
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
  ["90d", weeklyTrends],
  ["all", emptyTrends],
]);

// Per-window response delay: the runtime read's cost varies sharply by window, so
// the out-of-order case is reproduced by making one window slow and another fast.
const runtimeDelayByWindow = new Map<string, number>();
let runtimeStatus = 200;
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

  // 90d — weekly resolution. The widest label form there is, actually rendered.
  await pick("90d").click();
  await page.getByRole("img", { name: /by week, over 90d/ }).waitFor();
  assert.match(await page.locator(".runtime-caption").innerText(), /per week \(UTC\)/);
  const weekLabels = (await page.locator(".runtime-chart svg text").allTextContents()).filter((t) => t.startsWith("wk "));
  assert.ok(weekLabels.length > 0, "the weekly axis must actually render weekly labels");
  assert.match(weekLabels.at(-1) ?? "", /^wk 6\/8$/, "the trailing (current) week is always labelled");
  assert.equal(await axisLabelsOverlap(page), false, "weekly axis labels must not run into each other");
  assert.match(await page.locator(".runtime-partial-note").innerText(), /The last week \(wk 6\/8\) is hatched/);
  assert.equal(await page.locator(".runtime-chart rect.runtime-bar-partial").count(), 1);

  // all — no observations at all: an empty state, not an empty chart.
  await pick("all").click();
  await page.locator(".runtime-empty").waitFor();
  assert.match(await page.locator(".runtime-empty").innerText(), /No completed agent runs for All agents in this window/);
  assert.equal(await page.locator(".runtime-chart").count(), 0);
  assert.equal(await page.locator(".runtime-table").count(), 0);
  assert.match(await page.locator(".runtime-selector").innerText(), /0 runs in all/);

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

// The chart's labels live in a viewBox that is scaled to the column width, so
// their rendered size is a continuous function of the viewport — every width is a
// case, not just the three this suite used to sample. 721-808px is the band a
// 720px breakpoint left below the 8px floor asserted above; iPad portrait is in it.
test("Chart labels hold their size across the whole width range, not just at sampled widths", async () => {
  runtimeDelayMs = 0;
  const measured: Array<{ width: number; min: number; max: number }> = [];
  for (const width of [1440, 1024, 809, 808, 768, 744, 721, 720, 390]) {
    const page = await newPage({ width, height: 900 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();
    const heights = await page.evaluate(() => Array.from(document.querySelectorAll(".runtime-chart svg text"))
      .map((element) => element.getBoundingClientRect().height));
    assert.ok(heights.length > 0, `no chart labels rendered at ${width}px`);
    measured.push({ width, min: Math.min(...heights), max: Math.max(...heights) });
    assert.ok(Math.min(...heights) >= 8,
      `axis labels must stay legible at ${width}px: ${JSON.stringify(heights)}`);
    assert.equal(await axisLabelsOverlap(page), false, `axis labels must not collide at ${width}px`);
    await page.close();
  }
  const smallest = Math.min(...measured.map((m) => m.min));
  const largest = Math.max(...measured.map((m) => m.max));
  assert.ok(largest / smallest <= 1.3,
    `label size must vary continuously with width, not step at a breakpoint: ${JSON.stringify(measured)}`);
});

test("Chart text meets WCAG AA contrast against the surface it is painted on", async () => {
  const page = await newPage({ width: 1280, height: 1100 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  // Colours come out of the real cascade; the ratio is computed here, because the
  // page context has no module helpers.
  const colors = await page.evaluate(() => ({
    axisFill: getComputedStyle(document.querySelector(".runtime-chart svg text")!).fill,
    peakFill: getComputedStyle(document.querySelectorAll(".runtime-chart svg text")[0]!).fill,
    captionColor: getComputedStyle(document.querySelector(".runtime-caption")!).color,
    tableCaptionColor: getComputedStyle(document.querySelector(".runtime-table caption")!).color,
    chartBackground: getComputedStyle(document.querySelector(".runtime-chart")!).backgroundColor,
    tableBackground: getComputedStyle(document.querySelector(".runtime-table")!).backgroundColor,
    pageBackground: getComputedStyle(document.body).backgroundColor,
  }));

  // The table sets no background of its own, so its caption sits on the page's.
  assert.match(colors.tableBackground, /rgba\(0, 0, 0, 0\)|transparent/);
  const ratios = {
    axis: contrastRatio(colors.axisFill, colors.chartBackground),
    peak: contrastRatio(colors.peakFill, colors.chartBackground),
    caption: contrastRatio(colors.captionColor, colors.chartBackground),
    tableCaption: contrastRatio(colors.tableCaptionColor, colors.pageBackground),
  };
  for (const [name, ratio] of Object.entries(ratios)) {
    assert.ok(ratio >= 4.5, `${name} is ${ratio}:1 — AA needs 4.5:1 for text this size (${JSON.stringify(ratios)})`);
  }
  await page.close();
});

test("The bars do not animate when the operator has asked for reduced motion", async () => {
  const reduced = await newPage({ width: 1280, height: 1100 }, { reducedMotion: "reduce" });
  await reduced.goto(`${baseUrl}/#ops`);
  await reduced.locator(".runtime-chart rect.runtime-bar").first().waitFor();
  const reducedDuration = await reduced.locator(".runtime-chart rect.runtime-bar").first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  assert.equal(reducedDuration, "0s");
  await reduced.close();

  // The guard is a preference, not a removal: the default page still animates.
  const normal = await newPage({ width: 1280, height: 1100 }, { reducedMotion: "no-preference" });
  await normal.goto(`${baseUrl}/#ops`);
  await normal.locator(".runtime-chart rect.runtime-bar").first().waitFor();
  const normalDuration = await normal.locator(".runtime-chart rect.runtime-bar").first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  assert.match(normalDuration, /0\.2s/);
  await normal.close();
});

test("A failing runtime read is reported, not left as a permanent loading state", async () => {
  const page = await newPage({ width: 1280, height: 1100 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  // The reachable path: an ordinary window switch, which drops the cached series
  // first, against a store read that is now failing.
  runtimeStatus = 500;
  await runtimeWindow(page, "1d").click();
  const error = page.locator(".runtime-error");
  await error.waitFor();
  assert.match(await error.innerText(), /HTTP 500/);
  assert.equal(await error.getAttribute("role"), "alert");
  assert.equal(await page.locator(".runtime-loading").count(), 0, "a failed read is not a load in progress");

  runtimeStatus = 200;
  await runtimeWindow(page, "7d").click();
  await page.getByRole("img", { name: /by day, over 7d/ }).waitFor();
  assert.equal(await page.locator(".runtime-error").count(), 0, "the panel recovers once the read succeeds");
  await page.close();
});

test("A slow earlier window's response cannot overwrite the window the operator moved to", async () => {
  const page = await newPage({ width: 1280, height: 1100 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  // 90d answers slowly, 1d immediately — so the FIRST request resolves LAST.
  runtimeDelayByWindow.set("90d", 700);
  await runtimeWindow(page, "90d").click();
  await page.locator(".runtime-loading").waitFor();
  await runtimeWindow(page, "1d").click();
  await page.getByRole("img", { name: /by hour, over 1d/ }).waitFor();

  await page.waitForTimeout(1200);
  const label = await page.locator(".runtime-chart svg").getAttribute("aria-label") ?? "";
  assert.match(label, /by hour, over 1d/, "the retired 90d response must not re-chart the panel");
  assert.match(await page.locator(".runtime-selector").innerText(), new RegExp(`${hourlySamples} runs in 1d`));
  assert.equal(await runtimeWindow(page, "1d").getAttribute("aria-pressed"), "true");

  runtimeDelayByWindow.delete("90d");
  await page.close();
});

test("A role with no observations in the new window is written back, not just displayed as All agents", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  await page.locator(".runtime-role-select").selectOption("red-wide");
  await page.getByRole("img", { name: /Average agent runtime for red-wide/ }).waitFor();

  // 30d has no red-wide runs, so the panel falls back to All agents. Re-picking
  // "All agents" in the select would fire no change event — the value is already
  // that — so the fallback has to be the stored selection, not just the shown one.
  await runtimeWindow(page, "30d").click();
  await page.getByRole("img", { name: /Average agent runtime for All agents/ }).waitFor();
  assert.equal(await page.locator(".runtime-role-select").inputValue(), "__all__");

  await runtimeWindow(page, "7d").click();
  await page.getByRole("img", { name: /Average agent runtime for All agents/ }).waitFor();
  assert.equal(await page.locator(".runtime-role-select").inputValue(), "__all__");
  assert.match(await page.locator(".runtime-selector").innerText(), /14 runs in 7d/,
    "a role the operator never re-selected must not silently come back");
  await page.close();
});

/** WCAG 2.x relative-luminance contrast ratio between two computed CSS colours. */
function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    return [r, g, b].reduce((total, value, index) => {
      const c = value / 255;
      const linear = c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      return total + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
}

/** True when any two axis labels' rendered boxes intersect horizontally. Every
 *  label but the peak one is an axis label — including the weekly `wk 6/10` form,
 *  which a digit-prefix filter would silently exclude from the check. */
async function axisLabelsOverlap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll(".runtime-chart svg text"))
      .filter((element) => !(element.textContent ?? "").startsWith("peak"))
      .map((element) => element.getBoundingClientRect())
      .sort((a, b) => a.left - b.left);
    return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1]!.right);
  });
}

/** The runtime panel's own window button — distinct from the ops-summary row. */
function runtimeWindow(page: Page, name: string) {
  return page.getByRole("group", { name: "runtime window:" }).getByRole("button")
    .filter({ hasText: new RegExp(`^${name}$`) });
}

async function newPage(
  viewport: { width: number; height: number },
  options: { reducedMotion?: "reduce" | "no-preference" } = {},
): Promise<Page> {
  const page = await browser.newPage({ viewport, ...options });
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
      const window = url.searchParams.get("window") ?? "7d";
      const delay = runtimeDelayByWindow.get(window) ?? runtimeDelayMs;
      if (delay) await new Promise((wait) => setTimeout(wait, delay));
      if (runtimeStatus !== 200) {
        res.writeHead(runtimeStatus, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "store read failed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(trendsByWindow.get(window) ?? emptyTrends));
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
