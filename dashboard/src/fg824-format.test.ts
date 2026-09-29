// FG-824: client/format.js is the ONE place the dashboard client formats ids, shas,
// durations, token counts and timestamps. Render tests for each formatter, and a scan that
// fails when another client module formats one of them directly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MONO_CLASS, formatClock, formatDuration, formatRelativeTime, formatTimestamp, formatTokens, idDisplay,
  shortId, shortSha, timestampDisplay,
} from "../client/format.js";

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
const FORMAT_MODULE = "format.js";
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

describe("FG-824: the formatters", () => {
  test("formatDuration keeps the FG-694 format", () => {
    assert.equal(formatDuration(null), null);
    assert.equal(formatDuration(42_000), "42s");
    assert.equal(formatDuration(12 * 60_000 + 3_000), "12m 3s");
    assert.equal(formatDuration(3 * 3_600_000 + 5 * 60_000), "3h 5m");
  });

  test("shortSha shortens, names absence, and takes a length", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(shortSha(sha), "0123456789ab");
    assert.equal(shortSha(sha, 7), "0123456");
    assert.equal(shortSha(null), "—");
    assert.equal(shortSha(""), "—");
  });

  test("shortId truncates long ids with an ellipsis and passes short ones through", () => {
    assert.equal(shortId("task-engineer-feab0f"), "task-engineer-feab0f");
    assert.equal(shortId("run-fg-824-status-tokens-freshness-recovery-card-0290d8", 20), "run-fg-824-status-t…");
    assert.equal(shortId(undefined), "—");
  });

  test("idDisplay keeps the full value in the title and one monospace class", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.deepEqual(idDisplay(sha, "sha"), { text: "0123456789ab", title: sha, class: MONO_CLASS });
    assert.deepEqual(idDisplay("task-1"), { text: "task-1", title: "task-1", class: MONO_CLASS });
    assert.equal(MONO_CLASS, "mono");
  });

  test("formatTokens reads counts at a glance", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(1_234), "1.2K");
    assert.equal(formatTokens(3_400_000), "3.4M");
    assert.equal(formatTokens(1_250_000_000), "1.25B");
    assert.equal(formatTokens(2_000_000_000), "2B");
    assert.equal(formatTokens(null), "—");
    assert.equal(formatTokens(Number.NaN), "—");
  });

  test("formatRelativeTime is relative to the clock it is handed", () => {
    assert.equal(formatRelativeTime("2026-09-29T11:59:30.000Z", NOW), "30s ago");
    assert.equal(formatRelativeTime("2026-09-29T11:55:00.000Z", NOW), "5m ago");
    assert.equal(formatRelativeTime("2026-09-29T09:00:00.000Z", NOW), "3h ago");
    assert.equal(formatRelativeTime("2026-09-27T12:00:00.000Z", NOW), "2d ago");
    assert.equal(formatRelativeTime(null, NOW), "—");
    assert.equal(formatRelativeTime("not a time", NOW), "—");
  });

  test("a timestamp renders relative, with the absolute time as its title", () => {
    const iso = "2026-09-29T11:55:00.000Z";
    const shown = timestampDisplay(iso, NOW);
    assert.equal(shown.text, "5m ago");
    assert.equal(shown.title, new Date(iso).toLocaleString());
    assert.equal(shown.class, MONO_CLASS);
    assert.equal(formatTimestamp(null, "never"), "never");
    assert.equal(formatClock(iso), new Date(iso).toLocaleTimeString());
    assert.equal(formatClock("garbage", undefined, "garbage"), "garbage");
  });
});

// Direct formatting another module must not do. Each names what it catches.
const DIRECT_FORMATTING: Array<[RegExp, string]> = [
  [/sha\w*\)?\s*\.slice\(/i, "slices a sha — use shortSha"],
  [/\.toLocale(?:Date|Time)?String\(/, "calls toLocale*String — use formatTimestamp/formatClock"],
  [/function\s+(?:fmt\w*|format(?:Duration|DurMs|RelativeTime|Clock|Timestamp|Tokens?)|shortSha|shortId)\s*\(/, "defines its own formatter"],
  [/\/\s*1_?000(?:_?000)*\)\.toFixed\(/, "formats a count — use formatTokens"],
];

function directFormatting(file: string, source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    for (const [pattern, what] of DIRECT_FORMATTING) {
      if (pattern.test(line)) hits.push(`${file}:${i + 1} ${what}: ${code}`);
    }
  });
  return hits;
}

describe("FG-824: no client module formats ids, shas, durations, tokens or timestamps directly", () => {
  test("the scan catches the shapes it exists for", () => {
    assert.equal(directFormatting("x.js", "const s = v.sha.slice(0, 12);").length, 1);
    assert.equal(directFormatting("x.js", "return sha ? String(sha).slice(0, 12) : x;").length, 1);
    assert.equal(directFormatting("x.js", "new Date(iso).toLocaleString()").length, 1);
    assert.equal(directFormatting("x.js", "function fmtK(n) {").length, 1);
    assert.equal(directFormatting("x.js", "function formatDurMs(ms) {").length, 1);
    assert.equal(directFormatting("x.js", "return (n / 1_000_000).toFixed(1) + \"M\";").length, 1);
    assert.equal(directFormatting("x.js", "const pct = (rate * 100).toFixed(0);").length, 0);
    assert.equal(directFormatting("x.js", "export function formatCounts(counts) {").length, 0);
  });

  test("every client module other than format.js calls the shared formatters", () => {
    const hits = readdirSync(CLIENT_DIR)
      .filter((f) => f.endsWith(".js") && f !== FORMAT_MODULE)
      .flatMap((f) => directFormatting(f, readFileSync(join(CLIENT_DIR, f), "utf8")));
    assert.deepEqual(hits, [], "route these through client/format.js");
  });
});
