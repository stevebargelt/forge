// FG-624 guard: the integration tier's shard partition is now OURS, not
// Node's --test-shard. The properties Node used to give us for free — every
// file runs, exactly once — have to be pinned here, because losing a file
// makes CI green while proving nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWeight, loadTimings, planShards, parseShardSelector, shardCost } from "./test-shards.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function discover(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...discover(full));
    else if (entry.isFile() && entry.name.endsWith(".integration.test.ts")) out.push(relative(REPO_ROOT, full));
  }
  return out.sort();
}

const FILES = discover(join(REPO_ROOT, "src"));
const TIMINGS = loadTimings();

function assertDisjointCover(shards: string[][], expected: string[], label: string): void {
  const flat = shards.flat();
  assert.deepEqual([...flat].sort(), [...expected].sort(), `${label}: union of shards must equal the input file list`);
  assert.equal(new Set(flat).size, flat.length, `${label}: no file may appear in more than one shard`);
}

test("FG-624: the real integration file list is a disjoint cover for every shard count 1..8", () => {
  assert.ok(FILES.length > 100, `expected the real integration tier, found ${FILES.length} files`);
  for (let n = 1; n <= 8; n++) {
    assertDisjointCover(planShards(FILES, TIMINGS, n), FILES, `N=${n}`);
  }
});

test("FG-624: a file missing from the timings manifest is still assigned to exactly one shard", () => {
  const orphan = "src/brand-new-nobody-measured-me.integration.test.ts";
  const files = [...FILES, orphan];
  for (const n of [1, 4, 6]) {
    const shards = planShards(files, TIMINGS, n);
    assertDisjointCover(shards, files, `unmeasured file, N=${n}`);
    assert.equal(
      shards.filter((s) => s.includes(orphan)).length,
      1,
      `an unmeasured file must land in exactly one shard (N=${n}) — silently dropping it is the failure mode this whole scheme exists to prevent`,
    );
  }
});

test("FG-624: with NO manifest at all every file still runs exactly once", () => {
  const shards = planShards(FILES, {}, 4);
  assertDisjointCover(shards, FILES, "empty manifest");
  const counts = shards.map((s) => s.length);
  assert.ok(
    Math.max(...counts) - Math.min(...counts) <= 1,
    `equal weights must degrade to round-robin (balanced by count), got ${counts.join("/")}`,
  );
});

test("FG-624: manifest entries for deleted files are ignored, not fatal", () => {
  const stale = { ...TIMINGS, "src/deleted/gone.integration.test.ts": 99_000 };
  const shards = planShards(FILES, stale, 4);
  assertDisjointCover(shards, FILES, "stale manifest");
});

test("FG-624: the partition is deterministic — same inputs, same assignment", () => {
  assert.deepEqual(planShards(FILES, TIMINGS, 5), planShards(FILES, TIMINGS, 5));
  // Input ORDER must not change the outcome either; the script's `find | sort`
  // is stable today, but the partition must not depend on that.
  assert.deepEqual(planShards([...FILES].reverse(), TIMINGS, 5), planShards(FILES, TIMINGS, 5));
});

test("FG-624: N=1 puts every file in the single shard", () => {
  const shards = planShards(FILES, TIMINGS, 1);
  assert.equal(shards.length, 1);
  assert.deepEqual(shards[0], FILES);
});

test("FG-624: N greater than the file count yields empty shards, never lost files", () => {
  const few = FILES.slice(0, 3);
  const shards = planShards(few, TIMINGS, 7);
  assert.equal(shards.length, 7);
  assertDisjointCover(shards, few, "N > file count");
  assert.equal(shards.filter((s) => s.length === 0).length, 4);
});

test("FG-624: a shard count below 1 is rejected rather than silently producing nothing", () => {
  assert.throws(() => planShards(FILES, TIMINGS, 0), /positive integer/);
  assert.throws(() => planShards(FILES, TIMINGS, -2), /positive integer/);
  assert.throws(() => planShards(FILES, TIMINGS, 2.5), /positive integer/);
});

test("FG-624: duplicate input paths cannot put the same file in two shards", () => {
  const dupes = [...FILES, ...FILES.slice(0, 5)];
  const shards = planShards(dupes, TIMINGS, 4);
  assertDisjointCover(shards, FILES, "duplicated input");
});

test("FG-624: every shard's projected cost is within 1.25x of the median shard", () => {
  const measured = Object.keys(TIMINGS).length;
  assert.ok(measured > 100, `the checked-in timings manifest must cover the tier; only ${measured} entries`);
  for (const n of [4, 5, 6]) {
    const costs = planShards(FILES, TIMINGS, n).map((s) => shardCost(s, TIMINGS));
    const sorted = [...costs].sort((a, b) => a - b);
    const median =
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    for (const cost of costs) {
      assert.ok(
        cost <= median * 1.25 && cost >= median * 0.75,
        `N=${n}: shard cost ${(cost / 1000).toFixed(1)}s is outside 0.75-1.25x of the median ${(median / 1000).toFixed(1)}s — the partition stopped balancing (costs: ${costs.map((c) => (c / 1000).toFixed(1)).join(", ")})`,
      );
    }
  }
});

test("FG-624: an unmeasured file is weighted pessimistically (p75), not optimistically", () => {
  const values = Object.values(TIMINGS).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)]!;
  assert.ok(
    defaultWeight(TIMINGS) >= median,
    "the default weight for an unmeasured file must be at least the median measured file — guessing low is what blows the 6-minute ceiling",
  );
  assert.equal(defaultWeight({}), 1, "an empty manifest must still produce a usable weight");
});

test("FG-624: shard selectors are validated", () => {
  assert.deepEqual(parseShardSelector("2/6"), { index: 2, count: 6 });
  assert.throws(() => parseShardSelector("0/4"), /shard index/);
  assert.throws(() => parseShardSelector("5/4"), /shard index/);
  assert.throws(() => parseShardSelector("1/0"), /shard count/);
  assert.throws(() => parseShardSelector("nonsense"), /k\/N/);
});
