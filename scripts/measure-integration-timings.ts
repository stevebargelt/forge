#!/usr/bin/env -S node --import tsx
//
// FG-624 — measure per-file wall-clock cost of the root integration tier and
// write the timings manifest the shard planner (src/test-shards.ts) reads.
//
// Method: run each *.integration.test.ts file in its OWN `node --test` process
// and record wall-clock ms for that process. One process per file is what a
// shard actually pays — it includes tsx transpile + module load + fixture
// setup, none of which show up in the runner's per-test duration events. Files
// are measured SERIALLY by default (--jobs 1) so no two runs contend for CPU;
// contention is what makes a timing manifest unreproducible.
//
// Host timings are NOT CI timings. The manifest is used for RELATIVE weight
// only — the planner balances shards by proportion of total, so a host that is
// uniformly 2x faster than a CI runner produces the same partition.
//
// Usage:
//   npm run test:integration:timings              # serial, rewrites the manifest
//   node --import tsx scripts/measure-integration-timings.ts --jobs 4
//   node --import tsx scripts/measure-integration-timings.ts --out /tmp/t.json
//   node --import tsx scripts/measure-integration-timings.ts --top 25 --dry-run

import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INTEGRATION_TIMINGS_PATH } from "../src/test-shards.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function discover(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...discover(full));
    else if (entry.isFile() && entry.name.endsWith(".integration.test.ts")) {
      out.push(relative(REPO_ROOT, full));
    }
  }
  return out.sort();
}

type Measurement = { file: string; ms: number; code: number | null };

function measure(file: string): Promise<Measurement> {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", "./src/test-setup.ts", "--test", file],
      { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("close", (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ file, ms: Math.round(ms), code });
    });
  });
}

async function runPool(files: string[], jobs: number, onDone: (m: Measurement) => void): Promise<Measurement[]> {
  const results: Measurement[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, files.length) }, async () => {
    for (;;) {
      const i = next++;
      const file = files[i];
      if (file === undefined) return;
      const m = await measure(file);
      results.push(m);
      onDone(m);
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const jobs = Number(arg("--jobs") ?? 1);
const out = arg("--out") ?? INTEGRATION_TIMINGS_PATH;
const top = Number(arg("--top") ?? 15);
const dryRun = process.argv.includes("--dry-run");

const files = discover(join(REPO_ROOT, "src"));
process.stderr.write(`measuring ${files.length} integration files, jobs=${jobs}\n`);

const wallStart = process.hrtime.bigint();
let done = 0;
const results = await runPool(files, jobs, (m) => {
  done++;
  process.stderr.write(`[${String(done).padStart(3)}/${files.length}] ${(m.ms / 1000).toFixed(1)}s ${m.code === 0 ? "ok " : `EXIT ${m.code}`} ${m.file}\n`);
});
const wallMs = Math.round(Number(process.hrtime.bigint() - wallStart) / 1e6);

const totalMs = results.reduce((a, r) => a + r.ms, 0);
const failed = results.filter((r) => r.code !== 0);

const byCost = [...results].sort((a, b) => b.ms - a.ms);
process.stderr.write(`\ntop ${top} by duration:\n`);
for (const r of byCost.slice(0, top)) {
  process.stderr.write(`  ${(r.ms / 1000).toFixed(1).padStart(7)}s  ${((r.ms / totalMs) * 100).toFixed(1).padStart(4)}%  ${r.file}\n`);
}
process.stderr.write(`\nserial total ${(totalMs / 1000).toFixed(1)}s across ${results.length} files (wall ${(wallMs / 1000).toFixed(1)}s at jobs=${jobs})\n`);
if (failed.length > 0) {
  process.stderr.write(`${failed.length} file(s) exited non-zero (still timed): ${failed.map((f) => f.file).join(", ")}\n`);
}

if (dryRun) process.exit(0);

const manifest = {
  $comment:
    "FG-624 per-file wall-clock cost of the root integration tier, in ms. Regenerate with `npm run test:integration:timings`. Host timings, not CI timings — used for RELATIVE weight only. A file missing from `files` still runs: the planner gives it a pessimistic default weight (see src/test-shards.ts).",
  measuredWith: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: `${cpus().length} (availableParallelism ${availableParallelism()})`,
    jobs,
    serialTotalMs: totalMs,
  },
  files: Object.fromEntries(results.map((r) => [r.file, r.ms])),
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
process.stderr.write(`wrote ${out}\n`);
