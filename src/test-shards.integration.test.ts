// FG-624 guard, wiring half: src/test-shards.test.ts proves the PARTITION is a
// disjoint cover; this proves the thing CI actually invokes emits it. The shard
// script now hands Node an explicit file list instead of --test-shard, so a
// broken pipe, a bad quoting change, or a planner that throws would silently
// hand a shard fewer files — and the tier would still report green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function listFiles(shard?: string): string[] {
  const out = execFileSync("bash", ["scripts/run-integration-tests.sh", ...(shard ? [shard] : [])], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, FORGE_INTEGRATION_LIST_ONLY: "1" },
  });
  return out.split("\n").filter((l) => l.trim().length > 0);
}

test("FG-624: unsharded mode still selects the whole tier", () => {
  const all = listFiles();
  assert.ok(all.length > 100, `expected the full integration tier, got ${all.length} files`);
  assert.ok(
    all.every((f) => f.endsWith(".integration.test.ts")),
    "the unsharded list must contain only integration-tier files",
  );
  assert.deepEqual([...all].sort(), all, "the unsharded list must stay sorted");
});

test("FG-624: the shards the script emits are a disjoint cover of the unsharded list", () => {
  const all = listFiles();
  for (const n of [4, 6]) {
    const shards = Array.from({ length: n }, (_, i) => listFiles(`${i + 1}/${n}`));
    const flat = shards.flat();
    assert.equal(new Set(flat).size, flat.length, `N=${n}: a file was emitted by two shards`);
    assert.deepEqual(
      [...flat].sort(),
      [...all].sort(),
      `N=${n}: the union of the shards must be exactly the unsharded file list — a missing file is a green shard that proves nothing`,
    );
    for (const shard of shards) assert.ok(shard.length > 0, `N=${n}: every shard must get work`);
  }
});

test("FG-624: an empty shard exits clean instead of running the whole tier", () => {
  // `node --test` with zero file arguments discovers and runs EVERYTHING, so an
  // over-shard (N > file count) must be caught by the script, not passed on.
  const out = execFileSync("bash", ["scripts/run-integration-tests.sh", "999/999"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(out.trim(), "", "an empty shard must not run any tests");
});

test("FG-624: a malformed shard selector is rejected", () => {
  assert.throws(
    () =>
      execFileSync("bash", ["scripts/run-integration-tests.sh", "banana"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /status 2|Command failed/,
  );
});
