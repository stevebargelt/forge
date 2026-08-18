// FG-704 coverage guard (fast unit tier). The duration-aware shard planner
// (src/test-shards.ts) is only as good as the timings manifest it packs over: a
// newly-added or renamed *.integration.test.ts that nobody measured gets a
// pessimistic p75 DEFAULT weight and still runs, but enough unmeasured files
// silently unbalance the six-way partition and quietly reopen the sub-five-minute
// regression FG-704 closed. This guard fails the PR when manifest coverage of the
// discovered integration tier drops below 95%, so an unmeasured file can't stay
// unmeasured indefinitely. It lives in the unit tier so it gates EVERY PR.
//
// If this reds, regenerate scripts/integration-timings.json (the linux-container
// procedure in docs/how-to-testing.md: `npm run test:integration:timings`) — do
// NOT lower the floor or hand-edit the manifest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTimings } from "./test-shards.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE_FLOOR = 0.95;

function discover(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...discover(full));
    else if (entry.isFile() && entry.name.endsWith(".integration.test.ts"))
      out.push(relative(REPO_ROOT, full));
  }
  return out.sort();
}

function coverageOf(
  discovered: string[],
  timings: Record<string, number>,
): {
  measured: number;
  unmeasured: string[];
  coverage: number;
} {
  // `loadTimings` deliberately discards zero, NaN, and otherwise unusable
  // entries. Keep that distinction explicit here: a manifest key is not a
  // measurement unless it carries a usable positive finite duration.
  const unmeasured = discovered.filter((file) => !(file in timings));
  const measured = discovered.length - unmeasured.length;
  return { measured, unmeasured, coverage: measured / discovered.length };
}

test("FG-704: the timings manifest measures at least 95% of the discovered integration tier", () => {
  const files = discover(join(REPO_ROOT, "src"));
  assert.ok(
    files.length > 100,
    `expected the real integration tier, found only ${files.length} files`,
  );

  // loadTimings already keeps only finite, > 0 ms entries, so "present in the
  // manifest" == "measured with a usable weight".
  const timings = loadTimings();
  const { unmeasured, measured, coverage } = coverageOf(files, timings);

  assert.ok(
    coverage >= COVERAGE_FLOOR,
    `timing-manifest coverage is ${(coverage * 100).toFixed(1)}% (${measured}/${files.length}), below the ` +
      `${(COVERAGE_FLOOR * 100).toFixed(0)}% floor. Regenerate scripts/integration-timings.json ` +
      `(npm run test:integration:timings) — do NOT lower this floor or edit the manifest by hand. ` +
      `Unmeasured files:\n  ${unmeasured.join("\n  ")}`,
  );
});

test("FG-704: the coverage guard rejects an unmeasured discovered integration file", () => {
  const discovered = ["src/a.integration.test.ts", "src/b.integration.test.ts"];
  // This represents the value returned by loadTimings for a manifest where b
  // was absent (or carried a zero/NaN value): it must not count as measured.
  const timings = { "src/a.integration.test.ts": 125 };
  const result = coverageOf(discovered, timings);

  assert.deepEqual(result.unmeasured, ["src/b.integration.test.ts"]);
  assert.equal(
    result.measured,
    1,
    "an absent/invalid timing must remain distinguishable from a measurement",
  );
  assert.throws(
    () =>
      assert.ok(
        result.coverage >= COVERAGE_FLOOR,
        `coverage ${(result.coverage * 100).toFixed(1)}% is below 95%`,
      ),
    /below 95%/,
    "a tier below the 95% floor must fail rather than silently using its default weight",
  );
});
