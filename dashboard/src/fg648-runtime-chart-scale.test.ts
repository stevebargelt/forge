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
      functionSource("runtimeAxisScale"),
      functionSource("runtimeCompactMs"),
      functionSource("runtimeAxisGutterEm"),
      "globalThis.exported = { runtimeAxisScale, runtimeCompactMs, runtimeAxisGutterEm,"
      + " RUNTIME_TICK_STEPS_MS, RUNTIME_TICK_TARGET, RUNTIME_AXIS_GUTTER_MIN_EM, RUNTIME_TICK_INSET_EM };",
    ].join("\n"),
    context,
  );
  const exported = context["exported"] as Chart;
  assert.equal(typeof exported.runtimeAxisScale, "function");
  assert.equal(typeof exported.runtimeCompactMs, "function");
  assert.equal(typeof exported.runtimeAxisGutterEm, "function");
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
  assert.equal(chart.runtimeCompactMs(90_000), "1.5m");
  // Above 10 units the decimal is dropped, so FG-662's 64h42m reads "65h" on the
  // plot. The bar's tooltip and the screen-reader table keep the exact 64h42m.
  assert.equal(chart.runtimeCompactMs(FG662_ARTIFACT_MS), "65h");
});

// AC10's other half. The labels say which day boundary they mark; this sentence is
// what converts "8/2 UTC" into the reader's own clock. If its arithmetic is wrong
// it is worse than absent — the operator who misread the 8/2 bar would be handed a
// confident, wrong conversion.
test("FG-648 AC10: the UTC-offset note is arithmetically true at every real-world offset", () => {
  const noteSource = functionSource("runtimeUtcOffsetNote");

  const noteAt = (offsetMinutes: number): string | null => {
    const context: Record<string, unknown> = {};
    createContext(context);
    // The function reads its offset from `new Date().getTimezoneOffset()`, which is
    // the OPPOSITE sign of the UTC offset — the stub keeps that convention.
    context["Date"] = class {
      getTimezoneOffset(): number {
        return -offsetMinutes;
      }
    };
    runInContext(`${noteSource}\nglobalThis.note = runtimeUtcOffsetNote();`, context);
    return context["note"] as string | null;
  };

  assert.equal(noteAt(0), null, "a reader already in UTC is told nothing they do not know");

  for (let offset = -720; offset <= 840; offset += 15) {
    if (offset === 0) continue;
    const note = noteAt(offset);
    assert.ok(note, `UTC${offset} must be disclosed`);

    // Derived independently of the implementation: take a real UTC midnight, shift
    // it by the offset, and read the wall clock and the date it lands on.
    const utcMidnight = Date.UTC(2026, 7, 2, 0, 0, 0);
    const local = new Date(utcMidnight + offset * 60_000);
    const clock = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
    const sameDay = local.getUTCDate() === 2;

    assert.match(note, new RegExp(`starts at ${clock} on `), `UTC${offset}: the note names the wrong clock time — ${note}`);
    assert.match(
      note,
      sameDay ? /on the same local day\.$/ : /on the previous local day\.$/,
      `UTC${offset}: the note names the wrong day — ${note}`,
    );
    assert.match(note, offset < 0 ? /You are UTC-/ : /You are UTC\+/, `UTC${offset}: the note names the wrong sign — ${note}`);
  }

  // The two the operator and the ticket actually name, spelled out.
  assert.equal(noteAt(-420), "You are UTC-7, so each UTC day here starts at 17:00 on the previous local day.");
  assert.equal(noteAt(330), "You are UTC+5:30, so each UTC day here starts at 05:30 on the same local day.");
});
