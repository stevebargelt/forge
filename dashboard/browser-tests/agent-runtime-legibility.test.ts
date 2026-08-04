// FG-648 (reopened), AC8-AC11 — adversarial verification that the runtime chart
// can be READ, in a real Chrome.
//
// The sibling suite (agent-runtime.test.ts) proves the chart's parts exist: a
// y-axis, a value row, a run-count row, UTC in the labels. This one attacks the
// claims those assertions are shaped to confirm:
//
//   - AC8  the axis is TRUTHFUL — every bar is drawn at its own fraction of the
//          axis top, at the scale edges (a peak on a step boundary, one above it,
//          a sub-second peak, a multi-week peak), not just at the one peak the
//          sibling fixture happens to carry. A clamp added later has to redden.
//   - AC9  the mean and the run count travel TOGETHER, per bar, and the value list
//          catches every bucket the plot drops — swept across twelve real viewport
//          widths and four windows, not the two widths the implementation was
//          tuned against.
//   - AC10 no period a reader can read off the PLOT is bare. Asserted over the
//          whole SVG (which excludes the figcaption), so a fix that discloses UTC
//          only in the caption — the shipped defect — cannot pass.
//   - the metric contract: an empty bucket is never a zero-duration observation,
//          in the axis scale, the value row, the list or the accessible name.
//
// Every page runs with reducedMotion: "reduce". The bars carry a 0.2s height
// transition, so a geometry read taken right after the chart appears measures an
// animation frame, not the chart — every bar comes back at the same fraction of
// its final height and a ratio assertion silently passes on the wrong numbers.
// Reduced motion sets that transition to 0s (pinned by the sibling suite), which
// is what makes these measurements deterministic rather than timing-dependent.

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

const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

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

function trends(window: string, resolution: string, bucketMs: number, buckets: Bucket[]): Trends {
  const samples = buckets.reduce((total, b) => total + b.sampleCount, 0);
  const weighted = buckets.reduce((total, b) => total + (b.averageMs ?? 0) * b.sampleCount, 0);
  return {
    window,
    resolution,
    bucketMs,
    rangeStart: buckets[0]?.bucketStart ?? null,
    rangeEnd: "2026-08-02T14:40:00.000Z",
    overall: buckets,
    byRole: [{ role: "engineer", buckets }],
    roleSummary: [{ role: "engineer", averageMs: samples > 0 ? weighted / samples : 0, sampleCount: samples }],
  };
}

const series = (count: number, stepMs: number, startIso: string, at: (index: number) => Bucket | null): Bucket[] =>
  Array.from({ length: count }, (_, i) => {
    const bucketStart = new Date(Date.parse(startIso) + i * stepMs).toISOString();
    const drawn = at(i);
    return drawn ? { ...drawn, bucketStart } : point(bucketStart, null, 0);
  });

// FG-662's reconciliation artifact, exactly as the ticket recomputed it in SQL:
// 27 rows, 232,951,071 ms. The chart's job is to draw it, not to hide it.
const FG662_ARTIFACT_MS = 232_951_071;

// The operator's own 7d table from the reopened ticket, to the run count. 7/26
// through the partial 8/2 — the bar he attributed to the wrong local day.
const LIVE_7D: Array<[number, number]> = [
  [2_160_000, 103], [840_000, 180], [480_000, 79], [1_680_000, 40],
  [840_000, 85], [720_000, 24], [2_940_000, 35], [FG662_ARTIFACT_MS, 27],
];
const liveDaily = trends("7d", "day", DAY, series(8, DAY, "2026-07-26T00:00:00.000Z",
  (i) => point("", LIVE_7D[i]![0], LIVE_7D[i]![1], i === 7)));

// 25 hourly buckets spanning two UTC days, six of them empty — the window the
// operator was reading, at the density the thinning rule has to survive.
const hourly = trends("1d", "hour", HOUR, series(25, HOUR, "2026-08-01T14:00:00.000Z",
  (i) => (i % 4 === 1 ? null : point("", 30_000 + i * 4_000, 1 + (i % 3), i === 24))));

// 30 daily buckets: the longest daily window, with gaps.
const monthly = trends("30d", "day", DAY, series(30, DAY, "2026-07-04T00:00:00.000Z",
  (i) => (i % 7 === 3 ? null : point("", 60_000 + i * 90_000, 1 + (i % 9), i === 29))));

// 14 weekly buckets. `wk 6/8 UTC` is the widest label form the axis carries.
const weeklyTrends = trends("90d", "week", WEEK, series(14, WEEK, "2026-04-27T00:00:00.000Z",
  (i) => (i === 2 || i === 9 ? null : point("", 240_000 + i * 30_000, 2 + (i % 4), i === 13))));

const BY_WINDOW = new Map<string, Trends>([
  ["7d", liveDaily], ["1d", hourly], ["30d", monthly], ["90d", weeklyTrends], ["all", weeklyTrends],
]);
const BUCKETS_IN = new Map<string, number>([["7d", 8], ["1d", 25], ["30d", 30], ["90d", 14]]);

/** Four daily buckets with the given means — the scale-edge probe shape. */
const scaleProbe = (means: number[]): Trends =>
  trends("7d", "day", DAY, series(means.length, DAY, "2026-07-26T00:00:00.000Z", (i) => point("", means[i]!, 3)));

/** Served for every window while set, so a scale edge can be driven on any page. */
let override: Trends | null = null;
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

test("FG-648 AC8: every bar measures against the axis at all four scale edges — a clamp cannot hide here", async () => {
  // peak on a step boundary / one ms above it / sub-second / multi-week, each with
  // the ladder the reader sees and the fraction of the plot each bar must occupy.
  const edges: Array<{ name: string; means: number[]; ladder: string[] }> = [
    { name: "peak exactly on a tick boundary", means: [4 * HOUR, HOUR, 1_800_000, 900_000], ladder: ["0s", "1h", "2h", "3h", "4h"] },
    { name: "peak one millisecond above a boundary", means: [4 * HOUR + 1, HOUR, 1_800_000, 900_000], ladder: ["0s", "2h", "4h", "6h"] },
    { name: "a sub-second peak", means: [400, 250, 120, 40], ladder: ["0s", "1s"] },
    { name: "a multi-week peak", means: [30 * DAY, 10 * DAY, 5 * DAY, DAY], ladder: ["0s", "192h", "384h", "576h", "768h"] },
  ];

  for (const edge of edges) {
    override = scaleProbe(edge.means);
    const page = await newPage({ width: 1280, height: 1100 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();

    assert.deepEqual(await page.locator(".runtime-chart svg .runtime-y-tick").allTextContents(), edge.ladder, edge.name);
    const geometry = await measureBars(page);
    const axisTop = tickValue(edge.ladder.at(-1)!);
    assert.ok(axisTop >= Math.max(...edge.means), `${edge.name}: the axis top must clear the peak`);

    edge.means.forEach((mean, i) => {
      const drawn = geometry.bars[i]!.height / geometry.plotHeight;
      const truthful = mean / axisTop;
      // The em floor keeps a bar three orders of magnitude under the peak visible,
      // so a bar is either at its true fraction or standing on that floor.
      const onFloor = Math.abs(geometry.bars[i]!.height - geometry.floorPx) < 0.4;
      assert.ok(
        Math.abs(drawn - truthful) < 0.02 || (onFloor && truthful < drawn),
        `${edge.name}: bar ${i} (${mean}ms of ${axisTop}ms) draws at ${drawn.toFixed(4)} of the plot, not ${truthful.toFixed(4)} — ${JSON.stringify(geometry)}`,
      );
      assert.ok(geometry.bars[i]!.top >= geometry.axisTopPx - 1, `${edge.name}: bar ${i} escapes the top of the axis`);
    });
    await page.close();
  }
  override = null;
});

test("FG-648 AC8: a peak flush with the axis top draws a full-height bar and still fits its value label", async () => {
  // The sibling suite's peak sits at 87.5% of its axis, so the label above the
  // tallest bar never reaches the top of the viewBox. On a boundary peak it does.
  override = scaleProbe([4 * HOUR, HOUR, 1_800_000, 900_000]);
  for (const width of [390, 768, 1024, 1280, 1920]) {
    const page = await newPage({ width, height: 1000 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();

    const geometry = await measureBars(page);
    const tallest = geometry.bars[0]!;
    assert.ok(
      Math.abs(tallest.height / geometry.plotHeight - 1) < 0.02,
      `at ${width}px a peak equal to the axis top must fill the plot: ${JSON.stringify(geometry)}`,
    );
    assert.deepEqual(await clippedLabels(page), [], `at ${width}px the value label above the full-height bar must stay inside the viewBox`);
    assert.equal(await anyRowOverlaps(page), null, `labels collide at ${width}px`);
    await page.close();
  }
  override = null;
});

test("FG-648 AC8: the y-axis gutter holds the widest tick the metric can produce, at every width", async () => {
  // `runtimeCompactMs` has no unit above hours — deliberately, because `65h` is the
  // reading this ticket exists to deliver and `2.7d` would undo it — so a multi-week
  // peak prints four-digit hours. The gutter has to be sized from the tick actually
  // drawn: at a fixed 3.3em, `1296h` and `1728h` sat 3.6px OUTSIDE the SVG box at
  // every width from 320 to 1920 (finding FG648-V2), which is a clip, not a
  // narrow-viewport artifact.
  override = scaleProbe([10 * WEEK, 3 * WEEK, WEEK, DAY]);
  for (const width of [320, 390, 768, 1280, 1920]) {
    const page = await newPage({ width, height: 1000 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();

    const ladder = await page.locator(".runtime-chart svg .runtime-y-tick").allTextContents();
    assert.deepEqual(ladder, ["0s", "432h", "864h", "1296h", "1728h"], `at ${width}px the multi-week ladder is unchanged`);
    assert.deepEqual(await clippedLabels(page), [], `at ${width}px a four-digit hour tick is drawn outside the viewBox`);
    assert.equal(await anyRowOverlaps(page), null, `labels collide at ${width}px`);

    // The gutter WIDENED to hold it, rather than the label being shortened: the
    // plot still starts to the right of the longest tick, with the bars inside it.
    const gutter = await page.evaluate(() => {
      const svg = document.querySelector(".runtime-chart svg")!;
      const ticks = Array.from(svg.querySelectorAll(".runtime-y-tick")).map((t) => t.getBoundingClientRect());
      const gridLeft = svg.querySelector(".runtime-gridline")!.getBoundingClientRect().left;
      const bars = Array.from(svg.querySelectorAll("rect.runtime-bar")).map((b) => b.getBoundingClientRect());
      return {
        widestTickRight: Math.max(...ticks.map((t) => t.right)),
        tickLeft: Math.min(...ticks.map((t) => t.left)),
        svgLeft: svg.getBoundingClientRect().left,
        gridLeft,
        firstBarLeft: Math.min(...bars.map((b) => b.left)),
      };
    });
    assert.ok(gutter.tickLeft >= gutter.svgLeft - 0.5, `at ${width}px the widest tick starts left of the chart: ${JSON.stringify(gutter)}`);
    assert.ok(gutter.widestTickRight <= gutter.gridLeft + 0.5, `at ${width}px a tick runs into the plot: ${JSON.stringify(gutter)}`);
    assert.ok(gutter.firstBarLeft >= gutter.gridLeft - 0.5, `at ${width}px a bar starts left of the axis: ${JSON.stringify(gutter)}`);
    await page.close();
  }
  override = null;
});

test("FG-648 AC8/FG-662: the 64.7h artifact draws at its real height, and the axis says how tall that is", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  // Rounded UP to whole days: 72h of axis for a 64.7h peak. Not clamped to the
  // peak, not log-compressed, not suppressed as an outlier — FG-662 classifies it.
  assert.deepEqual(await page.locator(".runtime-chart svg .runtime-y-tick").allTextContents(), ["0s", "24h", "48h", "72h"]);
  const geometry = await measureBars(page);
  assert.ok(
    Math.abs(geometry.bars[7]!.height / geometry.plotHeight - FG662_ARTIFACT_MS / (3 * DAY)) < 0.02,
    `the artifact must draw at 90% of the plot: ${JSON.stringify(geometry)}`,
  );
  // And the reader is told what it is, on the plot and in the tooltip, in both forms.
  assert.ok((await page.locator(".runtime-chart svg .runtime-value").allTextContents()).includes("65h"));
  assert.match(await page.locator(".runtime-chart svg rect.runtime-bar").last().innerHTML(), /8\/2 UTC: 64h42m over 27 runs \(partial\)/);

  // Every other bar is a minute-scale mean against a 72h axis: they stand on the
  // em floor rather than vanishing, and the floor is the same handful of pixels
  // for all of them — so the VALUE labels, not the heights, are what is read here.
  const shortBars = geometry.bars.slice(0, 7);
  for (const bar of shortBars) assert.ok(Math.abs(bar.height - geometry.floorPx) < 0.4, JSON.stringify(geometry));
  assert.ok(geometry.floorPx < geometry.plotHeight * 0.03, `the floor must stay a floor, not a compression: ${JSON.stringify(geometry)}`);
  await page.close();
});

test("FG-648 AC9: a bar's mean and its run count are drawn together, at every width and every window", async () => {
  for (const width of [320, 360, 390, 414, 480, 600, 768, 834, 1024, 1280, 1600, 1920]) {
    const page = await newPage({ width, height: 1000 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();

    for (const window of ["7d", "1d", "30d", "90d"]) {
      if (window !== "7d") {
        await runtimeWindow(page, window).click();
        await page.getByRole("img", { name: new RegExp(`over ${window}\\.`) }).waitFor();
      }
      const where = `${window} at ${width}px`;
      const rows = await measureLabelRows(page);
      assert.equal(rows.bucketCentres.length, BUCKETS_IN.get(window), `${where}: every bucket must occupy the x-axis`);

      // The rows are matched on the label's own anchor x, in viewBox units — the
      // same number the bar centre is computed from, so this is exact rather than
      // a pixel tolerance over three text-anchor modes.
      assert.deepEqual(rows.unplacedValues, [], `${where}: a value label sits over no bucket`);
      assert.deepEqual(rows.unplacedCounts, [], `${where}: a run-count label sits over no bucket`);
      assert.deepEqual(rows.valuesWithoutCount, [], `${where}: a mean is drawn with no run count under it`);
      assert.deepEqual(rows.countsWithoutValue, [], `${where}: a run count is drawn over a bar with no mean above it`);
      assert.deepEqual(rows.valuesOverEmpty, [], `${where}: an empty bucket must carry no mean`);

      // The RUNS row is headed, and the head does not sit on top of the first count.
      assert.equal(rows.head, "RUNS", `${where}: a bare row of numbers is not a run count`);
      assert.ok(rows.headClearancePx > 0, `${where}: the RUNS head overlaps the first run count by ${-rows.headClearancePx}px`);

      assert.equal(await anyRowOverlaps(page), null, `${where}: chart labels collide`);
      assert.deepEqual(await clippedLabels(page), [], `${where}: a chart label is clipped by the viewBox`);
      assert.ok(rows.minTextPx >= 8, `${where}: chart text must stay legible — ${rows.minTextPx}px`);
    }
    await page.close();
  }
});

test("FG-648 AC9: whenever the plot drops a bar's labels, the list beneath carries every bucket", async () => {
  for (const width of [320, 390, 480, 768, 1280, 1920]) {
    const page = await newPage({ width, height: 1000 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();

    for (const window of ["7d", "1d", "30d", "90d"]) {
      const total = BUCKETS_IN.get(window)!;
      if (window !== "7d") {
        await runtimeWindow(page, window).click();
        await page.getByRole("img", { name: new RegExp(`over ${window}\\.`) }).waitFor();
      }
      const where = `${window} at ${width}px`;
      // BOTH rows. The period row is much wider than the count row, so it thins
      // first and independently: at 90d/1280px the plot draws a count over all 14
      // bars and a period over 7 of them. A list gated on the count row alone is
      // absent exactly there, and buckets 1,3,5,7,9,11,12 carry a mean and a run
      // count that belong to no readable period — the counting-bars workaround
      // does not recover them either, because an empty bucket draws no bar and the
      // trailing label is force-kept, so the stride breaks at the end.
      const labelled = await page.locator(".runtime-chart svg .runtime-count").count();
      const dated = await page.locator(".runtime-chart svg .runtime-x-tick").count();
      const listed = await page.locator(".runtime-bucket-values li").allTextContents();

      if (labelled === total && dated === total) {
        assert.equal(listed.length, 0, `${where}: with every bar labelled there is nothing left to spell out`);
        continue;
      }
      assert.equal(listed.length, total,
        `${where}: ${labelled} of ${total} bars carry a run count and ${dated} carry a period, so the list must carry all ${total} — a bucket that falls through both paths is unreadable`);
      for (const entry of listed) {
        // Period, then either a mean and its run count, or an explicit "no runs".
        assert.match(entry, /UTC/, `${where}: a list entry without its period cannot be attributed: ${entry}`);
        assert.match(entry, /(no runs|·\s*\d+ runs?)$/, `${where}: a list entry must carry a run count or say there are none: ${entry}`);
      }
    }
    await page.close();
  }
});

test("FG-648 AC10: no period a reader can read off the PLOT is bare — the caption is not the only disclosure", async () => {
  // Los Angeles, the operator's own timezone. The shipped defect was a bare `8/2`
  // on the axis with `(UTC)` only in the figcaption below it, so this asserts over
  // the SVG alone — the figcaption is not part of it.
  const page = await newPage({ width: 1440, height: 1200 }, { timezoneId: "America/Los_Angeles" });
  await page.goto(`${baseUrl}/#ops`);
  await page.locator(".runtime-chart svg").waitFor();

  for (const window of ["7d", "1d", "30d", "90d"]) {
    if (window !== "7d") {
      await runtimeWindow(page, window).click();
      await page.getByRole("img", { name: new RegExp(`over ${window}\\.`) }).waitFor();
    }
    const plotText = await page.locator(".runtime-chart svg").textContent() ?? "";
    assert.ok(plotText.length > 0, `${window}: the plot must carry text`);
    // Every date and every clock time inside the plot — axis ticks, bar tooltips,
    // the list's own periods — is followed by its timezone. Dropping the marker
    // from any ONE of those rows fails here.
    const bare = [
      ...plotText.matchAll(/\d{1,2}\/\d{1,2}(?!\d)(?! UTC)/g),
      ...plotText.matchAll(/\d{2}:\d{2}(?! UTC)/g),
    ].map((match) => plotText.slice(Math.max(0, match.index - 12), match.index + 18));
    assert.deepEqual(bare, [], `${window}: a bare period reads as a LOCAL date to a reader in America/Los_Angeles`);
  }

  // The ticket's demonstrated misattribution, end to end: at 07:40 PDT on 8/2 the
  // `8/2` bar looked like "this morning, when nothing has run". It covers 17:00 PDT
  // on 8/1 onward. The label now says which 8/2 it means, and the caption converts
  // that into the reader's own clock.
  await runtimeWindow(page, "7d").click();
  await page.getByRole("img", { name: /over 7d\./ }).waitFor();
  assert.deepEqual(await page.locator(".runtime-chart svg .runtime-x-tick").allTextContents(),
    ["7/26 UTC", "7/27 UTC", "7/28 UTC", "7/29 UTC", "7/30 UTC", "7/31 UTC", "8/1 UTC", "8/2 UTC"]);
  assert.match(await page.locator(".runtime-tz-note").innerText(),
    /You are UTC-[78], so each UTC day here starts at 1[67]:00 on the previous local day\./);
  assert.match(await page.locator(".runtime-partial-note").innerText(), /The last day \(8\/2 UTC\) is hatched/);
  await page.close();
});

test("FG-648: an empty bucket is not a zero-duration observation — not in the axis, the values, the list or the name", async () => {
  const observed = [600_000, 800_000, 1_000_000, 1_200_000];
  // The same four observations, once with four empty buckets interleaved and once
  // without any. If a gap were entering the scale as a 0ms sample, the axis or the
  // bar geometry would move between these two.
  const withGaps = trends("7d", "day", DAY, series(8, DAY, "2026-07-26T00:00:00.000Z",
    (i) => (i % 2 === 1 ? null : point("", observed[i / 2]!, 5))));
  const withoutGaps = trends("7d", "day", DAY, series(4, DAY, "2026-07-26T00:00:00.000Z",
    (i) => point("", observed[i]!, 5)));

  const read = async (fixture: Trends) => {
    override = fixture;
    const page = await newPage({ width: 1440, height: 1200 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();
    const geometry = await measureBars(page);
    const state = {
      ladder: await page.locator(".runtime-chart svg .runtime-y-tick").allTextContents(),
      tallest: geometry.bars.reduce((a, b) => (b.height > a.height ? b : a)).height / geometry.plotHeight,
      bars: await page.locator(".runtime-chart rect.runtime-bar").count(),
      values: await page.locator(".runtime-chart svg .runtime-value").allTextContents(),
      counts: await page.locator(".runtime-chart svg .runtime-count").allTextContents(),
      label: await page.locator(".runtime-chart svg").getAttribute("aria-label") ?? "",
      equivalent: await page.locator(".runtime-text-equivalent").innerText(),
      list: await page.locator(".runtime-bucket-values li").allTextContents(),
    };
    await page.close();
    return state;
  };

  const gapped = await read(withGaps);
  const solid = await read(withoutGaps);
  override = null;

  assert.deepEqual(gapped.ladder, solid.ladder, "four empty buckets must not move the axis — a 0ms sample would");
  assert.ok(Math.abs(gapped.tallest - solid.tallest) < 0.01, "the tallest bar must measure the same against both");

  assert.equal(gapped.bars, 4, "an empty bucket draws no bar");
  assert.deepEqual(gapped.values, solid.values, "an empty bucket contributes no mean to the value row");
  assert.deepEqual(gapped.counts, ["5", "0", "5", "0", "5", "0", "5", "0"], "an empty bucket's run count is zero runs, not a zero-length run");
  assert.doesNotMatch(gapped.label, /7\/27 UTC/, "an empty bucket must not appear as a plotted value in the accessible name");
  assert.match(gapped.equivalent, /7\/27 UTC\s+no runs\s+0/, "the text equivalent reads 'no runs', never 0s");
  for (const entry of gapped.list) assert.doesNotMatch(entry, /\b0s\b/, `an empty bucket must never render as a 0s mean: ${entry}`);
});

test("FG-648: the plot keeps its height and its smallest bar visible across the whole width range", async () => {
  // Both are new coupling the rewrite introduced: the viewBox height is derived
  // from the label scale, and the bar-height floor is em-relative. Either one
  // going back to a fixed user-unit value shows up here as a width-dependent plot.
  override = scaleProbe([FG662_ARTIFACT_MS, 600_000, 60_000, 1_000]);
  const measured: Array<{ width: number; plot: number; min: number; yGap: number }> = [];
  for (const width of [320, 390, 480, 768, 1024, 1280, 1920]) {
    const page = await newPage({ width, height: 1000 });
    await page.goto(`${baseUrl}/#ops`);
    await page.locator(".runtime-chart svg").waitFor();
    const geometry = await measureBars(page);
    measured.push({
      width,
      plot: geometry.plotHeight,
      min: Math.min(...geometry.bars.map((b) => b.height)),
      yGap: geometry.closestYTickGapPx,
    });
    assert.ok(geometry.closestYTickGapPx > 0, `y-axis tick labels overlap each other at ${width}px: ${JSON.stringify(geometry)}`);
    await page.close();
  }
  override = null;

  const plots = measured.map((m) => m.plot);
  assert.ok(Math.max(...plots) / Math.min(...plots) <= 1.02,
    `the plot's rendered height must not vary with the column width: ${JSON.stringify(measured)}`);
  for (const m of measured) {
    assert.ok(m.min >= 2, `a bar 200,000x under the peak must still be visible at ${m.width}px: ${JSON.stringify(measured)}`);
    assert.ok(m.min <= m.plot * 0.03, `the floor must not inflate a bar into a readable value at ${m.width}px: ${JSON.stringify(measured)}`);
  }
});

/** The axis-top value a tick label names, back in milliseconds. */
function tickValue(label: string): number {
  const match = /^(\d+(?:\.\d)?)(s|m|h)$/.exec(label);
  assert.ok(match, `a tick label must read as a duration: ${label}`);
  const scale = { s: SECOND, m: 60_000, h: HOUR }[match![2] as "s" | "m" | "h"];
  return Number(match![1]) * scale;
}

/** Bar and axis geometry in rendered CSS pixels, plus the em-relative bar floor. */
async function measureBars(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector(".runtime-chart svg")!;
    const gridTops = Array.from(svg.querySelectorAll(".runtime-gridline")).map((line) => line.getBoundingClientRect().top);
    const yBoxes = Array.from(svg.querySelectorAll(".runtime-y-tick"))
      .map((tick) => tick.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    let closestYTickGapPx = Number.POSITIVE_INFINITY;
    for (let i = 1; i < yBoxes.length; i += 1) closestYTickGapPx = Math.min(closestYTickGapPx, yBoxes[i]!.top - yBoxes[i - 1]!.bottom);
    // The floor the chart applies to a bar too short to draw, in the same pixels.
    const scaled = svg.getBoundingClientRect().width / Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    const fontUnits = Number(svg.querySelector(".runtime-y-tick")!.getAttribute("font-size"));
    return {
      plotHeight: +(Math.max(...gridTops) - Math.min(...gridTops)).toFixed(2),
      axisTopPx: Math.min(...gridTops),
      floorPx: +(fontUnits * 0.25 * scaled).toFixed(2),
      closestYTickGapPx: +closestYTickGapPx.toFixed(2),
      bars: Array.from(svg.querySelectorAll("rect.runtime-bar")).map((bar) => {
        const box = bar.getBoundingClientRect();
        return { height: +box.height.toFixed(2), top: box.top };
      }),
    };
  });
}

/** Which bucket each label row is anchored over, matched in viewBox units.
 *  Every callback here is an inline anonymous arrow on purpose: tsx compiles a
 *  NAMED function inside a page.evaluate body into an esbuild `__name(...)` call
 *  that does not exist in the browser realm, and the read dies as a ReferenceError. */
async function measureLabelRows(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector(".runtime-chart svg")!;
    // Every bucket draws exactly one rect on the baseline: a bar, or the 1-unit
    // tick that keeps a gap reading as a gap.
    const slots = Array.from(svg.querySelectorAll(":scope > rect")).map((rect) => ({
      centre: Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2,
      empty: !rect.classList.contains("runtime-bar"),
    })).sort((a, b) => a.centre - b.centre);

    const values = Array.from(svg.querySelectorAll(".runtime-value"))
      .map((text) => slots.findIndex((slot) => Math.abs(slot.centre - Number(text.getAttribute("x"))) < 0.5));
    const counts = Array.from(svg.querySelectorAll(".runtime-count"))
      .map((text) => slots.findIndex((slot) => Math.abs(slot.centre - Number(text.getAttribute("x"))) < 0.5));
    const head = svg.querySelector(".runtime-count-head")!.getBoundingClientRect();
    const firstCount = svg.querySelector(".runtime-count")?.getBoundingClientRect();
    return {
      bucketCentres: slots.map((slot) => slot.centre),
      unplacedValues: values.filter((index) => index < 0),
      unplacedCounts: counts.filter((index) => index < 0),
      valuesOverEmpty: values.filter((index) => index >= 0 && slots[index]!.empty),
      valuesWithoutCount: values.filter((index) => !counts.includes(index)),
      countsWithoutValue: counts.filter((index) => index >= 0 && !slots[index]!.empty && !values.includes(index)),
      head: svg.querySelector(".runtime-count-head")!.textContent,
      headClearancePx: firstCount ? +(firstCount.left - head.right).toFixed(2) : 1,
      minTextPx: Math.min(...Array.from(svg.querySelectorAll("text")).map((text) => text.getBoundingClientRect().height)),
    };
  });
}

/** Every chart label that escapes an edge of the scaled viewBox, with its overflow. */
async function clippedLabels(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector(".runtime-chart svg")!;
    const frame = svg.getBoundingClientRect();
    return Array.from(svg.querySelectorAll("text")).flatMap((element) => {
      const box = element.getBoundingClientRect();
      const overflow = {
        top: +(frame.top - box.top).toFixed(2),
        bottom: +(box.bottom - frame.bottom).toFixed(2),
        left: +(frame.left - box.left).toFixed(2),
        right: +(box.right - frame.right).toFixed(2),
      };
      const escapes = Object.entries(overflow).filter(([, px]) => px > 0.5).map(([edge]) => edge);
      return escapes.length === 0 ? [] : [{ text: element.textContent ?? "", escapes, overflow }];
    });
  });
}

const LABEL_ROWS = [[".runtime-x-tick"], [".runtime-value"], [".runtime-count", ".runtime-count-head"]];

/** The first label row whose labels run into each other, or null when none do. */
async function anyRowOverlaps(page: Page): Promise<string | null> {
  for (const row of LABEL_ROWS) {
    const collides = await page.evaluate((selector) => {
      const boxes = Array.from(document.querySelectorAll(selector))
        .map((element) => element.getBoundingClientRect())
        .sort((a, b) => a.left - b.left);
      return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1]!.right);
    }, row.map((className) => `.runtime-chart svg ${className}`).join(", "));
    if (collides) return row.join(",");
  }
  return null;
}

/** The runtime panel's own window button — distinct from the ops-summary row. */
function runtimeWindow(page: Page, name: string) {
  return page.getByRole("group", { name: "runtime window:" }).getByRole("button")
    .filter({ hasText: new RegExp(`^${name}$`) });
}

async function newPage(
  viewport: { width: number; height: number },
  options: { timezoneId?: string } = {},
): Promise<Page> {
  // reducedMotion is not a preference under test here — it is what stops the bars'
  // 0.2s height transition from being what these geometry reads measure.
  const page = await browser.newPage({ viewport, reducedMotion: "reduce", ...options });
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
      const window = url.searchParams.get("window") ?? "7d";
      const payload = override ?? BY_WINDOW.get(window) ?? BY_WINDOW.get("7d")!;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...payload, window }));
      return;
    }
    if (url.pathname === "/api/ops") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        runs: { total: 40, active: 1, terminal: 39, clean: 30, withFailures: 9, successRate: 0.77 },
        taskCount: 190,
        counts: { idleKills: 1, cancels: 2, retries: 3, redBlocks: 4 },
        failureKinds: [],
        durations: [],
      }));
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ generatedAt: new Date(0).toISOString(), services: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
