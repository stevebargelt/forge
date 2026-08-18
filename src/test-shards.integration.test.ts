// FG-624 guard, wiring half: src/test-shards.test.ts proves the PARTITION is a
// disjoint cover; this proves the thing CI actually invokes emits it. The shard
// script now hands Node an explicit file list instead of --test-shard, so a
// broken pipe, a bad quoting change, or a planner that throws would silently
// hand a shard fewer files — and the tier would still report green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERIAL_FILE = "src/orchestrator/fg576-codex-adapter.integration.test.ts";

function listFiles(shard?: string): string[] {
  const out = execFileSync("bash", ["scripts/run-integration-tests.sh", ...(shard ? [shard] : [])], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, FORGE_INTEGRATION_LIST_ONLY: "1" },
  });
  return out.split("\n").filter((l) => l.trim().length > 0);
}

// FG-704: the dedicated serial lane (`serial` mode, no k/N selector).
function listSerial(): string[] {
  const out = execFileSync("bash", ["scripts/run-integration-tests.sh", "serial"], {
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

test("FG-704: the six BULK shards are a disjoint cover of (discovered − fg576) and never contain fg576", () => {
  const all = listFiles();
  const expectedBulk = all.filter((f) => f !== SERIAL_FILE);
  const n = 6;
  const shards = Array.from({ length: n }, (_, i) => listFiles(`${i + 1}/${n}`));
  const flat = shards.flat();
  assert.equal(new Set(flat).size, flat.length, "a file was emitted by two bulk shards");
  for (const shard of shards) {
    assert.ok(shard.length > 0, "every bulk shard must get work — an empty shard would run the whole tier");
    assert.ok(
      !shard.includes(SERIAL_FILE),
      "fg576 must never land on a bulk shard — it is excluded from the bin-packer and runs alone in the serial lane",
    );
  }
  assert.deepEqual(
    [...flat].sort(),
    [...expectedBulk].sort(),
    "the union of the six bulk shards must be exactly (discovered − fg576) — a missing file is a green shard that proves nothing",
  );
});

test("FG-681/FG-704: (bulk ∪ serial) == the discovered tier, disjoint — the serial lane accounts for fg576 exactly once", () => {
  const all = listFiles();
  assert.ok(all.includes(SERIAL_FILE), "the unsharded integration selection lost the AC9 serial file");

  const serial = listSerial();
  assert.deepEqual(serial, [SERIAL_FILE], "the serial lane must list exactly fg576 and nothing else");

  // No bulk shard, at any N, may carry fg576 — the exclusion is a shell contract
  // independent of shard count.
  for (const n of [4, 6]) {
    const carriers = Array.from({ length: n }, (_, i) => `${i + 1}/${n}`).filter((shard) => listFiles(shard).includes(SERIAL_FILE));
    assert.deepEqual(carriers, [], `N=${n}: no bulk shard may carry fg576 — the serial lane does`);
  }

  const bulk = Array.from({ length: 6 }, (_, i) => listFiles(`${i + 1}/6`)).flat();
  const union = [...bulk, ...serial];
  assert.equal(new Set(union).size, union.length, "bulk and serial must be disjoint");
  assert.deepEqual([...union].sort(), [...all].sort(), "(bulk ∪ serial) must equal the discovered integration tier");
});

test("FG-681/FG-704: the serial lane runs ONLY fg576 under --test-concurrency=1 with no k/N selector, and its failure fails the script", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg704-serial-runner-"));
  const log = join(dir, "node-invocations.jsonl");
  const node = join(dir, "node");
  // A fake `node` that LOGS only real `--test` runs; everything else (the
  // planner call, and the AC6 manifest-weight helper) is forwarded to real node
  // so the summary path still works without polluting the invocation count.
  writeFileSync(
    node,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (!args.includes("--test")) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
appendFileSync(process.env.FG704_NODE_LOG, JSON.stringify(args) + "\\n");
if (process.env.FG704_FAIL_SERIAL === "1" && args.includes("${SERIAL_FILE}")) process.exit(23);
`,
  );
  chmodSync(node, 0o755);

  const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, FG704_NODE_LOG: log };
  const SERIAL_ARGV = ["--import", "tsx", "--import", "./src/test-setup.ts", "--test-concurrency=1", "--test", SERIAL_FILE];
  try {
    // The dedicated serial lane: exactly one `--test` run, only fg576, serial concurrency.
    rmSync(log, { force: true });
    execFileSync("bash", ["scripts/run-integration-tests.sh", "serial"], { cwd: REPO_ROOT, env, stdio: "pipe" });
    let invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 1, "the serial lane must be a single node --test run");
    assert.deepEqual(
      invocations[0],
      SERIAL_ARGV,
      "the serial lane must run only the AC9 file with node's serial test concurrency and no k/N selector",
    );

    // Unsharded dev run: bulk (excludes fg576, no forced serial concurrency) then the serial tail.
    rmSync(log, { force: true });
    execFileSync("bash", ["scripts/run-integration-tests.sh"], { cwd: REPO_ROOT, env, stdio: "pipe" });
    invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 2, "unsharded must run the bulk and the serial tail as separate node runs");
    assert.equal(invocations[0]!.includes(SERIAL_FILE), false, "the bulk invocation must exclude the serial file");
    assert.equal(invocations[0]!.includes("--test-concurrency=1"), false, "the bulk invocation must not force serial concurrency");
    assert.deepEqual(invocations[1], SERIAL_ARGV, "the unsharded serial tail must match the dedicated serial lane exactly");

    // A deliberately failing serial run must propagate its exit code.
    assert.throws(
      () => execFileSync("bash", ["scripts/run-integration-tests.sh", "serial"], { cwd: REPO_ROOT, env: { ...env, FG704_FAIL_SERIAL: "1" }, stdio: "pipe" }),
      (error: unknown) => (error as { status?: number }).status === 23,
      "a deliberately failing serial lane must propagate its exit code",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
