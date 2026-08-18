// FG-704 acceptance coverage: the production CI topology is only useful if the
// eight bulk jobs are balanced by the same batched cost that they actually pay.
// This deliberately uses the committed x64 manifest and real src/ discovery
// (the same sorted *.integration.test.ts corpus the shell runner selects), rather than a synthetic list, so a timing refresh that makes
// the CI plan uneven fails before it lands.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWeight, loadTimings, packWeight, planShards, shardCost, type Timings } from "./test-shards.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERIAL_FILE = "src/orchestrator/fg576-codex-adapter.integration.test.ts";
const BULK_SHARD_COUNT = 8;

function discoverBulk(): string[] {
  const discover = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return discover(full);
      return entry.isFile() && entry.name.endsWith(".integration.test.ts") ? [relative(REPO_ROOT, full)] : [];
    });
  return discover(join(REPO_ROOT, "src")).filter((file) => file !== SERIAL_FILE).sort();
}

function imbalance(loads: readonly number[]): number {
  const ideal = loads.reduce((sum, load) => sum + load, 0) / loads.length;
  return Math.max(...loads) / ideal;
}

// A deliberately local raw-LPT reference: this is the pre-FG-704 mistake, not
// an alternate production planner. It lets the regression test pin the reason
// `packWeight` exists without exposing a second planner API.
function planOnRawWeights(files: readonly string[], timings: Timings, shardCount: number): string[][] {
  const fallback = defaultWeight(timings);
  const ordered = [...new Set(files)].sort((a, b) => (timings[b] ?? fallback) - (timings[a] ?? fallback) || a.localeCompare(b));
  const shards = Array.from({ length: shardCount }, () => [] as string[]);
  const loads = new Array<number>(shardCount).fill(0);
  for (const file of ordered) {
    let lightest = 0;
    for (let index = 1; index < shardCount; index++) {
      if (loads[index]! < loads[lightest]!) lightest = index;
    }
    shards[lightest]!.push(file);
    loads[lightest]! += timings[file] ?? fallback;
  }
  return shards;
}

test("FG-704: the real eight-way bulk plan stays within the promised batched-load balance", () => {
  const timings = loadTimings();
  const bulk = discoverBulk();
  assert.ok(bulk.length > 100, `expected the real bulk corpus, got ${bulk.length} files`);

  const shards = planShards(bulk, timings, BULK_SHARD_COUNT);
  const loads = shards.map((shard) => shardCost(shard, timings));
  const ideal = loads.reduce((sum, load) => sum + load, 0) / BULK_SHARD_COUNT;
  const max = Math.max(...loads);

  // Ten percent is the FG-704 acceptance property: each CI bulk job should be
  // near the common batched workload, while retaining room for normal manifest
  // refresh noise. It is not an arbitrary LPT bound; the committed x64 campaign
  // is far tighter than this, so a regression back toward the old skew reds.
  assert.ok(
    max <= ideal * 1.1,
    `eight-way batched plan is ${(max / ideal * 100).toFixed(1)}% of ideal (max ${max}ms, ideal ${ideal.toFixed(1)}ms); FG-704 promises balanced bulk CI loads`,
  );

  const heaviest = bulk.reduce((heavy, file) => {
    const weight = packWeight(timings[file] ?? defaultWeight(timings));
    return weight > heavy.weight ? { file, weight } : heavy;
  }, { file: "", weight: -Infinity });
  const heavyShard = shards.find((shard) => shard.includes(heaviest.file));
  assert.ok(heavyShard, "the heaviest bulk file must be assigned to a shard");
  assert.ok(
    shardCost(heavyShard, timings) <= ideal * 1.1,
    "the shard constrained by the unsplittable heaviest file must not receive enough filler to violate the campaign balance floor",
  );
});

test("FG-704: batched packing avoids the small-file skew induced by raw serial timings", () => {
  // Serial measurements charge every 2.5s small file a process startup, even
  // though each CI shard pays that startup once for its whole batch. Two modest
  // heavy files plus a long small-file tail make raw LPT optimize that phantom
  // cost; evaluated on real batched weights it leaves the two heavy shards too
  // full. The production batched planner spreads the tail where it belongs.
  const timings: Timings = {};
  const files: string[] = [];
  for (let index = 0; index < 2; index++) {
    const file = `heavy-${index}.integration.test.ts`;
    files.push(file);
    timings[file] = 4_000;
  }
  for (let index = 0; index < 15; index++) {
    const file = `small-${index}.integration.test.ts`;
    files.push(file);
    timings[file] = 2_500;
  }

  const batchedPlan = planShards(files, timings, 4);
  const rawPlan = planOnRawWeights(files, timings, 4);
  const batchedImbalance = imbalance(batchedPlan.map((shard) => shardCost(shard, timings)));
  const rawModelImbalance = imbalance(rawPlan.map((shard) => shardCost(shard, timings)));

  assert.ok(
    batchedImbalance < rawModelImbalance,
    `batched model (${batchedImbalance.toFixed(3)} max/ideal) must beat raw serial weighting (${rawModelImbalance.toFixed(3)}) on a startup-heavy corpus`,
  );
  assert.ok(
    rawModelImbalance - batchedImbalance >= 0.15,
    "the fixture must preserve a material startup-amortization improvement, not a coincidental tie",
  );
});
