// FG-642 verify phase, AC 2 as BEHAVIOR: run the real browser tier in a
// deliberately Chrome-less environment and prove the whole thing goes RED with the
// named precondition — every test in the tier failing, zero skips.
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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CHROME_LOCATIONS } from "../../src/util/chrome-bin.js";
import { DECLARED_TIER_SUITES, countTierTests, tierSuites, tierTestTotal } from "../../src/util/browser-tier-census.js";

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = join(DASHBOARD, "..");
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

/** FG-839: the suites whose tests did not all register, from the junit report's per-testcase
 *  `file` attribute. A suite that throws on import (a module-scope mkdirSync on an
 *  unwritable path, say) reports ONE failure named after the file instead of its tests. */
function shortSuites(junit: string): string[] {
  const reported: Record<string, number> = {};
  const loadFailures = new Set<string>();
  // Attribute values may carry an unescaped `>`, so walk quoted attributes rather than `[^>]*`.
  for (const [tag] of junit.matchAll(/<testcase(?:\s+[\w-]+="[^"]*")*/g)) {
    const attr = (key: string) => new RegExp(`\\s${key}="([^"]*)"`).exec(tag)?.[1] ?? "";
    const file = basename(attr("file"));
    reported[file] = (reported[file] ?? 0) + 1;
    if (basename(attr("name")) === file) loadFailures.add(file);
  }
  return Object.entries(countTierTests())
    .filter(([file, declared]) => reported[file] !== declared || loadFailures.has(file))
    .map(([file, declared]) =>
      `${file} (${reported[file] ?? 0} of ${declared} reported${loadFailures.has(file) ? " — the file failed to load" : ""})`
    );
}

test("FG-642: a Chrome-less run of the real browser tier FAILS every test with the named precondition — it never skips to green", () => {
  const suites = tierSuites();
  assert.deepEqual(
    suites,
    DECLARED_TIER_SUITES,
    "this proof must spawn the whole declared tier — a suite missing from the run is a suite whose Chrome-less behavior nothing here proves"
  );

  assert.ok(!existsSync(BOGUS), "the override must point at a path that genuinely does not exist");
  const realChrome = KNOWN_CHROME_LOCATIONS.find(existsSync);

  const junitPath = join(mkdtempSync(join(tmpdir(), "fg642-fail-first-")), "tier.xml");
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      `--test-reporter-destination=${junitPath}`,
      ...suites.map((f) => join("browser-tests", f)),
    ],
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

  // Every test in the tier is RED and none is skipped — a file-wide `before` hook
  // failure, not one gating test with the rest passing behind it. The size comes from
  // counting the tier (src/util/browser-tier-census.ts); this file used to pin its own
  // literal, FG-694 grew the tier, and this copy is the one that went stale.
  const expected = tierTestTotal();
  const short = existsSync(junitPath) ? shortSuites(readFileSync(junitPath, "utf8")) : ["(no junit report was written)"];
  assert.equal(
    total(output, "tests"),
    expected,
    `all ${expected} tier tests must be accounted for — missing from: ${short.join(", ") || "(no suite short in the junit report)"}`
  );
  assert.deepEqual(short, [], `every suite must register all its declared tests — short: ${short.join(", ")}`);
  assert.equal(total(output, "fail"), expected, "every tier test must fail without a browser");
  assert.equal(total(output, "pass"), 0, "no tier test may pass without a browser");
  assert.equal(total(output, "skipped"), 0, "a skip is the exact regression FG-642 closed — the tier must go red, not quiet");
  assert.equal(total(output, "todo"), 0);
  assert.equal(total(output, "cancelled"), 0);
});

test("FG-839: the fail-first accounting names a suite that throws while loading", () => {
  const root = mkdtempSync(join(tmpdir(), "fg839-fail-first-"));
  const dashboard = join(root, "dashboard");
  const source = join(root, "src");
  const fixture = "fg839-load-failure.test.ts";
  try {
    // The inner process runs the real first proof against an isolated copy. Restrict it
    // to that test so this regression test does not recursively launch itself.
    cpSync(DASHBOARD, dashboard, { recursive: true, filter: (path) => !path.endsWith("node_modules") });
    cpSync(join(PROJECT, "src"), source, { recursive: true });
    symlinkSync(join(PROJECT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(dashboard, "browser-tests", fixture), 'throw new Error("FG-839 deliberate suite load failure");\n');

    const census = join(source, "util", "browser-tier-census.ts");
    writeFileSync(
      census,
      readFileSync(census, "utf8").replace(
        "export const TIER_TESTS: Readonly<Record<string, number>> = {",
        'export const TIER_TESTS: Readonly<Record<string, number>> = {\n  "fg839-load-failure.test.ts": 1,'
      )
    );
    const run = spawnSync(
      "npx",
      ["tsx", "--test", "--test-name-pattern", "Chrome-less run", "src/fg642-browser-tier-fail-first.integration.test.ts"],
      { cwd: dashboard, encoding: "utf8", timeout: 240_000, env: childEnv({ npm_config_yes: "true" }) }
    );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.notEqual(run.status, 0, `the deliberate load failure must make the copied proof fail:\n${output.slice(-3000)}`);
    assert.match(
      output,
      /fg839-load-failure\.test\.ts \(1 of 0 reported — the file failed to load\)/,
      `the fail-first accounting assertion must name the suite that failed to load:\n${output.slice(-3000)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
