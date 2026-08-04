// FG-648 (reopened) verify phase, AC8 + AC10 — the chart's SCALE arithmetic,
// swept far wider than a browser run can afford.
//
// The browser tier proves the axis a reader actually sees at a handful of sampled
// peaks. It cannot sweep five thousand of them. The invariant AC8 rests on —
// "rounding only ever adds headroom, so no bar is ever clamped, truncated or
// log-compressed" — is a property over every peak the metric can produce, and a
// property tested at four hand-picked peaks is a property tested nowhere: a later
// `Math.min(...)` in the tick chooser would keep every sampled case green.
//
// The functions under test are read out of the REAL shipped client
// (`dashboard/client/main.js`) and evaluated here, rather than restated. A copy
// would pass forever after the original changed. Extraction is loud: a rename, a
// signature change, or a body that no longer compiles fails these tests by name
// instead of silently testing nothing. The browser tier holds the other end —
// that these are the functions the chart actually draws with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "main.js");
const source = readFileSync(CLIENT, "utf8");

/** The source of one top-level `function name(...) { ... }`, brace-matched. */
function functionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from client/main.js — this suite tests nothing until it is re-pointed`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name}'s body is unbalanced — extraction cannot be trusted`);
}

/** The source of one top-level `const NAME = ...;`. */
function constantSource(name: string): string {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} is gone from client/main.js — this suite tests nothing until it is re-pointed`);
  const end = source.indexOf(";", start);
  assert.notEqual(end, -1, `${name} has no terminator`);
  return source.slice(start, end + 1);
}

type Scale = { max: number; ticks: number[] };
type Chart = {
  runtimeAxisScale: (peakMs: number) => Scale;
  runtimeCompactMs: (ms: number) => string;
  runtimeAxisGutterEm: (tickLabels: string[]) => number;
  runtimeAxisLabels: (buckets: Array<{ bucketStart: string }>, resolution: string, zone: string) => string[];
  runtimeBucketRange: (iso: string, bucketMs: number, zone: string) => string;
  opsFmtMs: (ms: number | null) => string;
  RUNTIME_TICK_STEPS_MS: number[];
  RUNTIME_TICK_TARGET: number;
  RUNTIME_AXIS_GUTTER_MIN_EM: number;
  RUNTIME_TICK_INSET_EM: number;
};

/** The real scale helpers, compiled out of the shipped client. */
function loadChart(): Chart {
  const context: Record<string, unknown> = {};
  createContext(context);
  runInContext(
    [
      constantSource("RUNTIME_TICK_STEPS_MS"),
      constantSource("RUNTIME_TICK_TARGET"),
      constantSource("RUNTIME_AXIS_GUTTER_MIN_EM"),
      constantSource("RUNTIME_TICK_INSET_EM"),
      constantSource("RUNTIME_TICK_GLYPH_EM"),
      constantSource("RUNTIME_COMPACT_OPTS"),
      constantSource("RUNTIME_RANGE_OPTS"),
      functionSource("runtimeAxisScale"),
      functionSource("runtimeCompactMs"),
      functionSource("runtimeAxisGutterEm"),
      functionSource("runtimeZoneParts"),
      functionSource("runtimeBucketLabel"),
      functionSource("runtimeAxisLabels"),
      functionSource("runtimeBucketRange"),
      functionSource("opsFmtMs"),
      "globalThis.exported = { runtimeAxisScale, runtimeCompactMs, runtimeAxisGutterEm, runtimeAxisLabels,"
      + " runtimeBucketRange, opsFmtMs,"
      + " RUNTIME_TICK_STEPS_MS, RUNTIME_TICK_TARGET, RUNTIME_AXIS_GUTTER_MIN_EM, RUNTIME_TICK_INSET_EM };",
    ].join("\n"),
    context,
  );
  const exported = context["exported"] as Chart;
  assert.equal(typeof exported.runtimeAxisScale, "function");
  assert.equal(typeof exported.runtimeCompactMs, "function");
  assert.equal(typeof exported.runtimeAxisGutterEm, "function");
  assert.equal(typeof exported.runtimeAxisLabels, "function");
  assert.equal(typeof exported.runtimeBucketRange, "function");
  assert.ok(Array.isArray(exported.RUNTIME_TICK_STEPS_MS) && exported.RUNTIME_TICK_STEPS_MS.length > 0);
  return exported;
}

const chart = loadChart();

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// FG-662's reconciliation artifact, to the millisecond: 27 rows, 232,951,071 ms.
// It is the tallest thing this chart has ever had to draw and it must keep drawing.
const FG662_ARTIFACT_MS = 232_951_071;

/** Deterministic peaks: every tick step and both sides of it, plus a seeded spread. */
function peakSweep(): number[] {
  const peaks: number[] = [1, 2, 999, SECOND, FG662_ARTIFACT_MS];
  for (const step of chart.RUNTIME_TICK_STEPS_MS) {
    for (const multiple of [1, 2, 3, 4, 5, 8]) {
      peaks.push(step * multiple - 1, step * multiple, step * multiple + 1);
    }
  }
  // A linear congruential generator, not Math.random: a sweep that samples a
  // different 5000 peaks every run reports a different suite every run.
  let seed = 20260802;
  for (let i = 0; i < 5000; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    peaks.push(1 + Math.floor((seed / 2_147_483_648) * 90 * DAY));
  }
  return peaks.filter((peak) => peak > 0);
}

test("FG-648 AC8: the axis top is never below the peak — no bar is clamped, at any peak", () => {
  const clamped: Array<{ peak: number; max: number }> = [];
  for (const peak of peakSweep()) {
    const { max } = chart.runtimeAxisScale(peak);
    if (!(max >= peak)) clamped.push({ peak, max });
  }
  assert.deepEqual(
    clamped.slice(0, 10),
    [],
    "an axis top below the peak draws the tallest bar taller than the plot — FG-662's 64.7h artifact has to stay visible at full height, not be cropped to the grid",
  );
});

test("FG-648 AC8: rounding adds headroom, and bounded headroom — the tallest bar is never compressed to a sliver", () => {
  let worst = { peak: 0, max: 0, ratio: 0 };
  for (const peak of peakSweep()) {
    if (peak < SECOND) continue; // below the smallest step the axis is a fixed 1s
    const { max } = chart.runtimeAxisScale(peak);
    const ratio = max / peak;
    if (ratio > worst.ratio) worst = { peak, max, ratio };
  }
  assert.ok(
    worst.ratio < 2,
    `the axis top may never be twice the peak — the tallest bar would draw at half the plot with the top half empty: ${JSON.stringify(worst)}`,
  );
  // And the floor: an axis that stopped rounding up would put the peak flush with
  // the frame. Both bounds together are what "rounds UP to a nice step" means.
  assert.ok(worst.ratio > 1, "the sweep must actually contain a peak that gets rounded up");
});

test("FG-648 AC8: every axis is a uniform ladder from zero — 2 to 5 legible ticks, never hundreds", () => {
  for (const peak of peakSweep()) {
    const { max, ticks } = chart.runtimeAxisScale(peak);
    assert.equal(ticks[0], 0, `the axis must start at zero (peak ${peak})`);
    assert.equal(ticks.at(-1), max, `the top tick must be the axis top (peak ${peak})`);
    assert.ok(ticks.length >= 2 && ticks.length <= 5, `peak ${peak} produced ${ticks.length} ticks: ${ticks.join(",")}`);
    const step = ticks[1]! - ticks[0]!;
    for (let i = 1; i < ticks.length; i += 1) {
      assert.equal(ticks[i]! - ticks[i - 1]!, step, `peak ${peak} produced an uneven ladder: ${ticks.join(",")}`);
    }
  }
});

test("FG-648 AC8: no two ticks carry the same label — a duration axis reading '1h, 1h, 2h' has no scale", () => {
  for (const peak of peakSweep()) {
    const labels = chart.runtimeAxisScale(peak).ticks.map(chart.runtimeCompactMs);
    assert.equal(new Set(labels).size, labels.length, `peak ${peak} rounds two distinct ticks to one label: ${labels.join(",")}`);
    for (const label of labels) {
      assert.match(label, /^\d+(\.\d)?(s|m|h)$/, `a tick must read as a duration a human uses, not as ${label} (peak ${peak})`);
    }
  }
});

test("FG-648 AC8: the four scale edges land where a reader can read them", () => {
  // Joined, not compared as arrays: the ticks come back across a vm realm boundary,
  // so their Array prototype is not this realm's and deepStrictEqual rejects them.
  const ladder = (peak: number) => chart.runtimeAxisScale(peak).ticks.map(chart.runtimeCompactMs).join(",");

  // A peak exactly on a step boundary: the top tick IS the peak, so the tallest
  // bar draws at the full plot height. Nothing above it, nothing cut off it.
  assert.equal(ladder(4 * HOUR), "0s,1h,2h,3h,4h");
  assert.equal(chart.runtimeAxisScale(4 * HOUR).max, 4 * HOUR);

  // One millisecond above that boundary: the next step up, still above the peak.
  assert.equal(ladder(4 * HOUR + 1), "0s,2h,4h,6h");
  assert.ok(chart.runtimeAxisScale(4 * HOUR + 1).max > 4 * HOUR + 1);

  // Sub-second: an axis that reads in seconds rather than collapsing to a single
  // gridline, and a peak that still measures against it.
  assert.equal(ladder(400), "0s,1s");
  assert.equal(chart.runtimeAxisScale(400).max, SECOND);

  // Multi-week: past the last tick step, the fallback keeps whole days.
  assert.equal(ladder(10 * 7 * DAY), "0s,432h,864h,1296h,1728h");
  assert.ok(chart.runtimeAxisScale(10 * 7 * DAY).max >= 10 * 7 * DAY);

  // FG-662's artifact: 64.7h against a 72h axis, at 90% of the plot. Whatever
  // classifies that outlier, this chart still draws it at its real height.
  assert.equal(ladder(FG662_ARTIFACT_MS), "0s,24h,48h,72h");
  const artifact = chart.runtimeAxisScale(FG662_ARTIFACT_MS);
  assert.equal(artifact.max, 3 * DAY);
  assert.ok(Math.abs(FG662_ARTIFACT_MS / artifact.max - 0.8988) < 0.001);
});

// The y-axis gutter used to be a fixed PAD_LEFT of 3.3em with the tick end-anchored
// 0.45em inside it — room for four glyphs. `runtimeCompactMs` has no unit above
// hours (on purpose: `65h` is the reading this ticket delivers and `2.7d` would undo
// it), so a multi-week peak prints five-character hours and the browser measured
// `1296h` and `1728h` 3.6px OUTSIDE the viewBox at every width from 320 to 1920
// (finding FG648-V2). The fix widens the gutter from the tick actually drawn rather
// than shortening the tick, so there is no longer a peak at which the axis clips.
//
// This is written as the INVARIANT — every tick the metric can produce fits the
// gutter the chart reserves for it — and not as the old 40-day boundary constant.
// A threshold is exactly what rotted: it can only be right for the unit ladder and
// the pad it was computed against, and it goes quiet the moment either moves.
// The glyph width here is measured, not the chart's own estimate: reusing
// RUNTIME_TICK_GLYPH_EM would make this test agree with the implementation by
// construction. 0.636em is a digit's advance in the browser's default UI sans, the
// number that produced the 3.6px overflow the browser tier measured; the tier is
// what holds the other end of this, by reading the real rendered boxes.
test("FG-648 AC8: every tick label the metric can produce fits the gutter the axis reserves", () => {
  const MEASURED_GLYPH_EM = 0.636;
  const gutterFor = (peak: number) => {
    const labels = chart.runtimeAxisScale(peak).ticks.map(chart.runtimeCompactMs);
    const widest = Math.max(...labels.map((label) => label.length));
    return { labels, widest, em: chart.runtimeAxisGutterEm(labels) };
  };

  // Well past the peaks that overflowed a fixed gutter — a year of runtime — so a
  // unit ladder that grows another digit is covered, not just today's widest.
  const peaks = [...peakSweep()];
  for (let peak = SECOND; peak <= 400 * DAY; peak += 6 * HOUR) peaks.push(peak);

  let widestSeen = 0;
  for (const peak of peaks) {
    const { labels, widest, em } = gutterFor(peak);
    widestSeen = Math.max(widestSeen, widest);
    assert.ok(
      em - chart.RUNTIME_TICK_INSET_EM >= widest * MEASURED_GLYPH_EM,
      `peak ${peak}ms draws ${labels.join(",")} into a ${em}em gutter — the widest tick needs `
      + `${(chart.RUNTIME_TICK_INSET_EM + widest * MEASURED_GLYPH_EM).toFixed(3)}em and would be clipped`,
    );
  }
  assert.ok(widestSeen >= 5, `the sweep must actually reach the multi-digit hours that overflowed: ${widestSeen}`);

  // And the other half of the fix: the gutter only ever GROWS. At every scale an
  // operator sees today the plot is laid out exactly as it was, so widening it for
  // a 10-week peak cannot pay for itself by narrowing the common case.
  assert.equal(gutterFor(4 * HOUR).em, chart.RUNTIME_AXIS_GUTTER_MIN_EM, "a four-hour axis keeps the shipped layout");
  assert.equal(gutterFor(FG662_ARTIFACT_MS).em, chart.RUNTIME_AXIS_GUTTER_MIN_EM, "the 64.7h artifact keeps the shipped layout");
  assert.ok(gutterFor(10 * 7 * DAY).em > chart.RUNTIME_AXIS_GUTTER_MIN_EM, "a 10-week peak must widen the gutter");
  assert.deepEqual(gutterFor(10 * 7 * DAY).labels.join(","), "0s,432h,864h,1296h,1728h",
    "the fix must not change the label TEXT — the hours reading is what FG-648 delivers");
});

test("FG-648: an absent duration formats as an em dash — an empty bucket is never a zero-duration sample", () => {
  for (const absent of [NaN, Infinity, -Infinity]) {
    assert.equal(chart.runtimeCompactMs(absent), "—", `${absent} must not render as a duration`);
  }
  // Zero is a real point on the axis (the origin), and only there.
  assert.equal(chart.runtimeCompactMs(0), "0s");
  assert.equal(chart.runtimeCompactMs(45_000), "45s");
  // ...which is what makes rounding a real sub-500ms observation to whole seconds
  // a defect and not a display choice: `0s` would be the same string an empty
  // bucket's mean is forbidden from producing, on the plot AND in the value list.
  // Every observation the metric can hold reads as its own duration instead.
  for (const ms of [0.4, 1, 40, 120, 250, 400, 499]) {
    assert.notEqual(chart.runtimeCompactMs(ms), "0s", `${ms}ms must not read as the zero the empty bucket is denied`);
    assert.match(chart.runtimeCompactMs(ms), /^\d+ms$/, `${ms}ms must read as a duration a human uses`);
  }
  assert.equal(chart.runtimeCompactMs(400), "400ms");
  assert.equal(chart.runtimeCompactMs(40), "40ms");
  // The unit switches at the point whole seconds stop losing the observation, and
  // the tick ladder (which never carries a sub-second value) is untouched.
  assert.equal(chart.runtimeCompactMs(500), "1s");
  assert.equal(chart.runtimeCompactMs(999), "1s");
  assert.equal(chart.runtimeCompactMs(1_000), "1s");

  // The exact form the tooltip, the role table and the screen-reader table use
  // makes the same reservation — otherwise the plot reads `400ms` and its own
  // tooltip reads `0s` for the same bar.
  assert.equal(chart.opsFmtMs(null), "—");
  assert.equal(chart.opsFmtMs(0), "0s");
  assert.equal(chart.opsFmtMs(400), "400ms");
  assert.equal(chart.opsFmtMs(40), "40ms");
  assert.equal(chart.opsFmtMs(499), "499ms");
  assert.equal(chart.opsFmtMs(500), "1s");
  assert.equal(chart.opsFmtMs(45_000), "45s");
  assert.equal(chart.opsFmtMs(FG662_ARTIFACT_MS), "64h42m");
  assert.equal(chart.runtimeCompactMs(90_000), "1.5m");
  // Above 10 units the decimal is dropped, so FG-662's 64h42m reads "65h" on the
  // plot. The bar's tooltip and the screen-reader table keep the exact 64h42m.
  assert.equal(chart.runtimeCompactMs(FG662_ARTIFACT_MS), "65h");
});

// FG-661: the offset PROSE these lines used to test is GONE, and with it
// `runtimeUtcOffsetNote` and its two helpers. It was wrong across a DST transition
// twice, from two different derivations, and both were instances of one cause:
// asking a reader to compute local time from a stated offset. What replaces it is
// tested here instead — the real endpoints of a bucket, in a real IANA zone, via
// `Intl`. These sweep the zones and the transitions a browser run cannot afford.
//
// Every case below is driven by a REAL zone id, not by a stubbed offset table: a
// test that hand-feeds an offset is testing the same arithmetic the design deleted.

const PACIFIC = "America/Los_Angeles";

test("FG-661 AC3: a bucket is rendered as its real local endpoints, not as an offset to apply", () => {
  // The operator's own case. A UTC day on a UTC-aligned grid opens at 17:00 the
  // previous local afternoon in PDT — the fact the deleted caption existed to
  // convey, now stated by the range itself.
  assert.equal(chart.runtimeBucketRange("2026-07-26T00:00:00.000Z", DAY, PACIFIC),
    "Jul 25 17:00 – Jul 26 17:00 PDT");
  assert.equal(chart.runtimeBucketRange("2026-08-01T14:00:00.000Z", HOUR, PACIFIC),
    "Aug 1 07:00 – Aug 1 08:00 PDT");
  assert.equal(chart.runtimeBucketRange("2026-06-08T00:00:00.000Z", 7 * DAY, PACIFIC),
    "Jun 7 17:00 – Jun 14 17:00 PDT");

  // UTC mode is the same code path with a different zone, so the two modes cannot
  // drift into two formatters.
  assert.equal(chart.runtimeBucketRange("2026-07-26T00:00:00.000Z", DAY, "UTC"),
    "Jul 26 00:00 – Jul 27 00:00 UTC");

  // A half-hour and a quarter-hour zone: the minutes are Intl's, so they survive.
  assert.equal(chart.runtimeBucketRange("2026-07-26T00:00:00.000Z", DAY, "Asia/Kolkata"),
    "Jul 26 05:30 – Jul 27 05:30 GMT+5:30");
  assert.equal(chart.runtimeBucketRange("2026-07-26T00:00:00.000Z", DAY, "Asia/Kathmandu"),
    "Jul 26 05:45 – Jul 27 05:45 GMT+5:45");
});

test("FG-661 AC5: a bucket spanning a DST transition carries a DIFFERENT abbreviation at each end", () => {
  // US Pacific springs forward at 2026-03-08T10:00Z and falls back at
  // 2026-11-01T09:00Z. The UTC day containing each transition is the case the
  // prose form could never state: one end is PST and the other is PDT.
  assert.equal(chart.runtimeBucketRange("2026-03-08T00:00:00.000Z", DAY, PACIFIC),
    "Mar 7 16:00 PST – Mar 8 17:00 PDT");
  assert.equal(chart.runtimeBucketRange("2026-11-01T00:00:00.000Z", DAY, PACIFIC),
    "Oct 31 17:00 PDT – Nov 1 16:00 PST");
  // The hourly bucket that contains the fall-back repeat, to the hour.
  assert.equal(chart.runtimeBucketRange("2026-11-01T08:00:00.000Z", HOUR, PACIFIC),
    "Nov 1 01:00 PDT – Nov 1 01:00 PST");

  // Southern-hemisphere and European transitions, in the other direction and on
  // other dates — the endpoints are read from Intl, so none of this is hand-cased.
  assert.equal(chart.runtimeBucketRange("2026-10-25T00:00:00.000Z", DAY, "Europe/London"),
    "Oct 25 01:00 GMT+1 – Oct 26 00:00 GMT");
  assert.equal(chart.runtimeBucketRange("2026-04-04T00:00:00.000Z", DAY, "Australia/Sydney"),
    "Apr 4 11:00 GMT+11 – Apr 5 10:00 GMT+10");

  // And a bucket that does NOT contain a transition keeps the single trailing
  // abbreviation — the range form is not noisier than the fact requires.
  assert.equal(chart.runtimeBucketRange("2026-03-09T00:00:00.000Z", DAY, PACIFIC),
    "Mar 8 17:00 – Mar 9 17:00 PDT");
});

test("FG-661 AC7: every axis label names its own zone, in local and UTC alike", () => {
  const series = (count: number, stepMs: number, startIso: string) =>
    Array.from({ length: count }, (_, i) => ({ bucketStart: new Date(Date.parse(startIso) + i * stepMs).toISOString() }));
  // Local abbreviations (PDT/PST/UTC/GMT) or Intl's GMT±H:MM fallback.
  const ZONED = /(?: (?:GMT[+-]\d{1,2}(?::\d{2})?|[A-Z]{2,5}))$/;

  for (const zone of [PACIFIC, "UTC", "Asia/Kolkata", "Europe/London", "Pacific/Chatham"]) {
    for (const { buckets, resolution } of [
      { buckets: series(8, DAY, "2026-07-26T00:00:00.000Z"), resolution: "day" },
      { buckets: series(25, HOUR, "2026-08-01T14:00:00.000Z"), resolution: "hour" },
      { buckets: series(14, 7 * DAY, "2026-04-27T00:00:00.000Z"), resolution: "week" },
      // Both DST transitions, at both resolutions.
      { buckets: series(30, DAY, "2026-02-24T00:00:00.000Z"), resolution: "day" },
      { buckets: series(25, HOUR, "2026-11-01T00:00:00.000Z"), resolution: "hour" },
    ]) {
      const labels = chart.runtimeAxisLabels(buckets, resolution, zone);
      assert.equal(labels.length, buckets.length, `${zone}/${resolution}: every bucket must be labelled`);
      for (const label of labels) {
        assert.match(label, ZONED, `${zone}/${resolution}: a bare period reads as whichever clock the reader holds — ${label}`);
      }
      const repeated = labels.filter((label, i) => labels.indexOf(label) !== i);
      assert.deepEqual(repeated, [], `${zone}/${resolution}: two buckets carry the same label, so neither bar is attributable`);
    }
  }

  // The local daily row for the operator's own window: the UTC grid puts each bar
  // on the PREVIOUS local date, and the row says so rather than making them guess.
  assert.equal(
    chart.runtimeAxisLabels(series(8, DAY, "2026-07-26T00:00:00.000Z"), "day", PACIFIC).join(","),
    "7/25 PDT,7/26 PDT,7/27 PDT,7/28 PDT,7/29 PDT,7/30 PDT,7/31 PDT,8/1 PDT",
  );
  // The fall-back day at hourly resolution: two buckets land on 01:00 local, and
  // the abbreviation is what keeps them distinct without escalating the whole row.
  const fallBack = chart.runtimeAxisLabels(series(4, HOUR, "2026-11-01T07:00:00.000Z"), "hour", PACIFIC);
  assert.deepEqual(fallBack, ["00:00 PDT", "01:00 PDT", "01:00 PST", "02:00 PST"]);
});

test("FG-661/FG-648: local unique-label escalation follows local calendar collisions, not UTC's", () => {
  const series = (count: number, startIso: string) =>
    Array.from({ length: count }, (_, i) => ({ bucketStart: new Date(Date.parse(startIso) + i * HOUR).toISOString() }));

  // This 25-hour window crosses the 2026 Pacific spring-forward transition. In
  // UTC, 00:00 occurs twice and the row must qualify every label with its date.
  // In Los Angeles, 02:00 never occurs and the two 01:00 labels have different
  // abbreviations (PST/PDT), so the compact local row is already unique. This is
  // deliberately a case where the two modes make opposite escalation decisions.
  const buckets = series(25, "2026-03-08T00:00:00.000Z");
  const utc = chart.runtimeAxisLabels(buckets, "hour", "UTC");
  const local = chart.runtimeAxisLabels(buckets, "hour", PACIFIC);
  assert.match(utc[0]!, /^3\/8 00:00 UTC$/, utc.join(","));
  assert.match(utc.at(-1)!, /^3\/9 00:00 UTC$/, utc.join(","));
  assert.ok(local.every((label) => /^\d\d:\d\d (?:PST|PDT)$/.test(label)), local.join(","));
  assert.equal(new Set(local).size, local.length, local.join(","));
  assert.deepEqual(local.slice(8, 12), ["00:00 PST", "01:00 PST", "03:00 PDT", "04:00 PDT"]);
});

test("FG-661 AC7: the bare-period scan preserves malformed ranges for inspection", () => {
  const zone = String.raw`(?:GMT[+-]\d{1,2}(?::\d{2})?|[A-Z]{2,5})`;
  const range = new RegExp(
    String.raw`[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}(?: ${zone})? – [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} ${zone}`,
    "g",
  );
  const bare = (text: string) => {
    const rest = text.replace(range, "⟨range⟩");
    return [
      ...rest.matchAll(new RegExp(String.raw`\d{1,2}/\d{1,2}(?!\d)(?!/\d)(?! (?:\d{2}:\d{2} )?${zone})`, "g")),
      ...rest.matchAll(new RegExp(String.raw`\d{2}:\d{2}(?! ${zone})`, "g")),
      ...rest.matchAll(new RegExp(String.raw`\b[A-Z][a-z]{2} \d{1,2}(?! \d{2}:\d{2}(?: ${zone})?)`, "g")),
      ...rest.matchAll(/–\s*(?=$)/g),
    ].map((match) => match[0]);
  };

  assert.deepEqual(bare("Mar 7 16:00 PST – Mar 8 17:00 PDT"), [], "a complete DST range is deliberately stripped");
  assert.ok(bare("Mar 7 16:00 PST – Mar 8 17:00").length > 0, "a missing end-zone must reach the scan");
  assert.ok(bare("Mar 7 16:00 PST – Mar 8").includes("Mar 8"), "a half-rendered month endpoint must reach the scan");
  assert.ok(bare("Mar 7 16:00 PST – ").length > 0, "an empty range side must reach the scan");
  // Differing endpoints are valid only on a real DST boundary. They are not bare:
  // AC5's independently-derived endpoint assertions, not AC7's bare scan, own
  // their factual correctness.
  assert.deepEqual(bare("Mar 7 16:00 PST – Mar 8 17:00 PDT"), []);
});

// AC9/AC10's attribution invariant, at the label layer: a value is only readable
// if the period naming it names ONE bucket. A 1d window is 25 hourly buckets and
// therefore always spans two UTC dates, so a bare `14:00` labelled two bars — on
// the x-tick row and, worse, as two identical chips in the fallback list, which
// carries no other positional cue.
test("FG-648 AC9/AC10: every bucket in a window carries its own period label", () => {
  const series = (count: number, stepMs: number, startIso: string) =>
    Array.from({ length: count }, (_, i) => ({ bucketStart: new Date(Date.parse(startIso) + i * stepMs).toISOString() }));
  const WEEK = 7 * DAY;

  const windows: Array<{ name: string; buckets: Array<{ bucketStart: string }>; resolution: string }> = [];
  // Every hour of the day as a starting point, plus a month and a year rollover:
  // the 25th bucket repeats the first bucket's hour wherever the window opens.
  for (let hour = 0; hour < 24; hour += 1) {
    windows.push({ name: `1d from ${hour}:00`, buckets: series(25, HOUR, `2026-08-01T${String(hour).padStart(2, "0")}:00:00.000Z`), resolution: "hour" });
  }
  windows.push({ name: "1d over a month end", buckets: series(25, HOUR, "2026-07-31T09:00:00.000Z"), resolution: "hour" });
  windows.push({ name: "1d over a year end", buckets: series(25, HOUR, "2026-12-31T09:00:00.000Z"), resolution: "hour" });
  windows.push({ name: "7d", buckets: series(8, DAY, "2026-07-26T00:00:00.000Z"), resolution: "day" });
  windows.push({ name: "30d", buckets: series(31, DAY, "2026-07-04T00:00:00.000Z"), resolution: "day" });
  windows.push({ name: "90d", buckets: series(14, WEEK, "2026-04-27T00:00:00.000Z"), resolution: "week" });
  // `all` is weekly and unbounded: past a year, `wk 6/8` comes round again.
  windows.push({ name: "all, three years", buckets: series(157, WEEK, "2023-06-05T00:00:00.000Z"), resolution: "week" });
  windows.push({ name: "all, five years", buckets: series(261, WEEK, "2021-01-04T00:00:00.000Z"), resolution: "week" });
  // Week starts drift a day or two a year, so `wk M/D` survives a good while
  // before it comes round — from 2019-01-07 the 270th bucket is the second `3/4`.
  windows.push({ name: "all, to a repeated week", buckets: series(270, WEEK, "2019-01-07T00:00:00.000Z"), resolution: "week" });

  for (const { name, buckets, resolution } of windows) {
    const labels = chart.runtimeAxisLabels(buckets, resolution, "UTC");
    assert.equal(labels.length, buckets.length, `${name}: every bucket must be labelled`);
    const repeated = labels.filter((label, i) => labels.indexOf(label) !== i);
    assert.deepEqual(repeated, [], `${name}: two buckets carry the same period label, so neither bar is attributable`);
    for (const label of labels) {
      assert.match(label, / UTC$/, `${name}: a bare period reads as a local one — ${label}`);
    }
  }

  // The escalation is per-window and uniform: a window whose compact labels are
  // already unique keeps them (they are the narrow form the thinning is sized
  // against), and one that needs qualifying qualifies EVERY label, so no chip is
  // left attributable only by the chips beside it.
  const daily = chart.runtimeAxisLabels(series(8, DAY, "2026-07-26T00:00:00.000Z"), "day", "UTC");
  assert.equal(daily.join(","), "7/26 UTC,7/27 UTC,7/28 UTC,7/29 UTC,7/30 UTC,7/31 UTC,8/1 UTC,8/2 UTC");
  const weekly = chart.runtimeAxisLabels(series(3, WEEK, "2026-05-25T00:00:00.000Z"), "week", "UTC");
  assert.equal(weekly.join(","), "wk 5/25 UTC,wk 6/1 UTC,wk 6/8 UTC");

  const hourly = chart.runtimeAxisLabels(series(25, HOUR, "2026-08-01T14:00:00.000Z"), "hour", "UTC");
  assert.equal(hourly[0], "8/1 14:00 UTC");
  assert.equal(hourly[24], "8/2 14:00 UTC");
  assert.equal(hourly.filter((label) => !/^\d+\/\d+ \d\d:00 UTC$/.test(label)).join(","), "",
    `a qualified row qualifies all of it: ${hourly.join(",")}`);
  const longRun = chart.runtimeAxisLabels(series(270, WEEK, "2019-01-07T00:00:00.000Z"), "week", "UTC");
  assert.equal(longRun[8], "wk 3/4/19 UTC");
  assert.equal(longRun[269], "wk 3/4/24 UTC");
  assert.equal(longRun.filter((label) => !/^wk \d+\/\d+\/\d\d UTC$/.test(label)).length, 0,
    "a weekly row that needs the year takes it everywhere, not only on the repeat");
});
