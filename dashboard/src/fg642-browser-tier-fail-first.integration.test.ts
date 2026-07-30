// FG-642 verify phase, AC 2 as BEHAVIOR: run the real browser tier in a
// deliberately Chrome-less environment and prove the whole thing goes RED with the
// named precondition — 18 failures, zero skips.
//
// The unit-tier pins next to the resolver (src/util/fg642-*.test.ts) read the tier's
// SOURCES: they prove no `{ skip }` and no private candidate list is present today.
// They cannot prove what the tier DOES when the browser is missing, and that is the
// property that regressed: the tier reported green in every agent container for
// months while executing nothing. So this spawns the actual entry point.
//
// Deterministic on a machine that HAS Chrome, which is the whole point of
// FORGE_CHROME_BIN being authoritative when set (src/util/chrome-bin.ts): pointing it
// at a path that does not exist masks every system location, so the fail-first
// demonstration is reproducible on a developer laptop, on an ubuntu runner, and in an
// agent container alike. CHROME_PATH is deliberately left pointing at the real
// browser when there is one — the override must outrank it in the live tier, not just
// in a unit test.
//
// Lives in the dashboard integration tier (glob-collected, so it cannot be forgotten
// by a runner list) and costs one ~2s spawn: every suite fails in its file-wide
// `before` hook, so no browser is ever launched and no fixture server survives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CHROME_LOCATIONS } from "../../src/util/chrome-bin.js";

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIER_DIR = join(DASHBOARD, "browser-tests");
const BOGUS = "/nonexistent/forge-fg642/deliberately-absent/chromium";

/** node:test marks its own children with NODE_TEST_CONTEXT, and a runner that sees it
 *  refuses to run files ("run() is being called recursively") and exits 0 — a false
 *  green for a test whose whole point is a red child. Same idiom as the root tier's
 *  spawning suites (src/v2/fg644-dirty-tree-execution.integration.test.ts). */
function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env["NODE_TEST_CONTEXT"];
  return env;
}

function total(output: string, label: string): number {
  const match = new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(output);
  assert.ok(match, `the tier's run did not report a '${label}' total:\n${output.slice(-2000)}`);
  return Number(match![1]);
}

test("FG-642: a Chrome-less run of the real browser tier FAILS every test with the named precondition — it never skips to green", () => {
  const suites = readdirSync(TIER_DIR).filter((f) => f.endsWith(".test.ts")).sort();
  assert.equal(suites.length, 5, `the tier must be its five suites (found ${suites.join(", ")})`);

  assert.ok(!existsSync(BOGUS), "the override must point at a path that genuinely does not exist");
  const realChrome = KNOWN_CHROME_LOCATIONS.find(existsSync);

  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...suites.map((f) => join("browser-tests", f))],
    {
      cwd: DASHBOARD,
      encoding: "utf8",
      timeout: 240_000,
      env: childEnv({
        FORGE_CHROME_BIN: BOGUS,
        // The hint stays valid where a browser exists: the override must still win.
        ...(realChrome ? { CHROME_PATH: realChrome } : {}),
      }),
    }
  );

  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.notEqual(run.status, 0, `a Chrome-less tier run must exit non-zero:\n${output.slice(-2000)}`);

  // The failure has to be the NAMED precondition, not an incidental crash.
  assert.ok(
    output.includes("chrome precondition: the dashboard browser tier requires a real Chrome/Chromium binary"),
    `the tier must fail on the named precondition:\n${output.slice(-2000)}`
  );
  assert.ok(
    output.includes(`FORGE_CHROME_BIN is set to ${BOGUS} and no file exists there`),
    "the failure must name the override the operator actually set"
  );
  assert.ok(output.includes("Set FORGE_CHROME_BIN to its path"), "the failure must name the remedy");
  assert.ok(output.includes("must FAIL this tier, never skip to green"), "the failure must name the rule it enforces");

  // Every one of the 18 tests is RED and none is skipped — a file-wide `before` hook
  // failure, not one gating test with 17 passes behind it.
  assert.equal(total(output, "tests"), 18, "all 18 tier tests must be accounted for");
  assert.equal(total(output, "fail"), 18, "every tier test must fail without a browser");
  assert.equal(total(output, "pass"), 0, "no tier test may pass without a browser");
  assert.equal(total(output, "skipped"), 0, "a skip is the exact regression FG-642 closed — the tier must go red, not quiet");
  assert.equal(total(output, "todo"), 0);
  assert.equal(total(output, "cancelled"), 0);
});
