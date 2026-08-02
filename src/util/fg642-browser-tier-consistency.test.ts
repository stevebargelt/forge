// FG-642 verify phase: the cross-suite source-level pins the sibling
// fg642-chrome-precondition.test.ts leaves open.
//
// That pin asserts per-file properties over `>= 5` suites and `>= 18` tests. Both
// bounds are one-directional, and the tier's failure mode was coverage vanishing
// quietly — so the ways it can still shrink without anything going red are pinned
// here as EXACT sets:
//
//   - the suite FILENAMES (a rename or a delete-plus-add keeps `length >= 5`);
//   - the per-file test counts (deleting three tests from one suite and adding three
//     elsewhere keeps `total >= 18`);
//   - every `chromium.launch()` in the tier takes its `executablePath` from the
//     shared resolver — the launch site is where a private path would come back;
//   - no tier file reads a CHROME-ish env var directly (the resolver owns
//     FORGE_CHROME_BIN / CHROME_PATH; a second reader is a second precedence order);
//   - no NON-test file under src/ or dashboard/ carries a browser path literal or
//     reads a CHROME env var — the seventh hand-copied candidate list has to be
//     unable to appear anywhere, not just in the five files that already exist.
//
// The remaining way to re-darken the tier — calling the resolver and then SWALLOWING
// its precondition — is not decidable from a text scan, so it is proven by behavior
// instead: dashboard/src/fg642-browser-tier-fail-first.integration.test.ts runs the
// real tier with the override pointed at nothing and requires 18 failures, 0 skips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIER_DIR = join(ROOT, "dashboard", "browser-tests");
const RESOLVER = join("src", "util", "chrome-bin.ts");

// The tier as FG-642 restored it (5 suites, 18 tests), plus the FG-648 runtime
// suite. Growing or pruning the tier is fine — update this map in the same
// commit, on purpose.
const TIER_TESTS: Readonly<Record<string, number>> = {
  "agent-runtime.test.ts": 6,
  "backlog-count.test.ts": 2,
  "fg608-backlog-cutover.test.ts": 3,
  "inactive-checkouts.test.ts": 3,
  "offline-boot.test.ts": 2,
  "usage-limits.test.ts": 8,
};

const tierFiles = (): string[] => readdirSync(TIER_DIR).filter((f) => f.endsWith(".test.ts")).sort();
const tierSource = (file: string): string => readFileSync(join(TIER_DIR, file), "utf8");

test("FG-642 (exact set): the browser tier is exactly the suites TIER_TESTS names", () => {
  assert.deepEqual(
    tierFiles(),
    Object.keys(TIER_TESTS).sort(),
    "the tier's suite set must match exactly — a `>= 5` bound lets a suite be renamed away or deleted alongside an addition, which is precisely how this tier's coverage went missing before"
  );
});

test("FG-642 (exact set): every suite keeps its own test count, and the tier keeps all 24", () => {
  let total = 0;
  for (const [file, expected] of Object.entries(TIER_TESTS)) {
    const found = (tierSource(file).match(/^test\(/gm) ?? []).length;
    assert.equal(
      found,
      expected,
      `${file} declares ${found} top-level tests, expected ${expected} — if the tier legitimately changed, update TIER_TESTS in the same commit so the change is deliberate rather than silent`
    );
    total += found;
  }
  assert.equal(total, 24, "the tier must carry FG-642's 18 real-browser tests plus FG-648's 6");
});

test("FG-642 (launch site): every chromium.launch() in the tier takes executablePath from the shared resolver", () => {
  for (const file of tierFiles()) {
    const src = tierSource(file);
    const launches = (src.match(/chromium\.launch\(/g) ?? []).length;
    const sites = [...src.matchAll(/executablePath:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim());
    assert.ok(launches > 0, `${file} is a browser suite that never launches a browser`);
    assert.equal(
      sites.length,
      launches,
      `${file} launches Chromium ${launches} time(s) but names executablePath ${sites.length} time(s) — a launch without one bypasses the resolver and silently picks up whatever browser the runner happens to have`
    );

    // Either inline, or via a local bound from the resolver earlier in the file
    // (offline-boot.test.ts resolves first, deliberately, so a Chrome-less run fails
    // before its expensive release build rather than after it).
    const resolverBindings = [...src.matchAll(/const\s+(\w+)\s*=\s*requireChrome\(/g)].map((m) => m[1]!);
    for (const value of sites) {
      const derived =
        value.includes("requireChrome(") || resolverBindings.some((name) => new RegExp(`\\b${name}\\b`).test(value));
      assert.ok(
        derived,
        `${file}: executablePath: ${value} — must come from requireChrome() (directly or via a local bound from it), not from an env var, a literal, or a private helper`
      );
    }
  }
});

test("FG-642 (one precedence order): no tier file reads a CHROME env var directly", () => {
  for (const file of tierFiles()) {
    const src = tierSource(file);
    const reads = [...src.matchAll(/process\.env\.\w*CHROME\w*/gi)].map((m) => m[0]);
    assert.deepEqual(
      reads,
      [],
      `${file} reads ${reads.join(", ")} directly — FORGE_CHROME_BIN / CHROME_PATH precedence lives in ${RESOLVER} alone; a second reader is a second, drifting precedence order (the CHROME_PATH-driven skip is what went dark)`
    );
  }
});

test("FG-642 (no seventh list): no non-test source file carries a browser path literal or reads a CHROME env var", () => {
  const offenders: string[] = [];
  for (const root of [join(ROOT, "src"), join(ROOT, "dashboard", "src"), join(ROOT, "dashboard", "client")]) {
    for (const file of sourceFiles(root)) {
      const rel = relative(ROOT, file);
      if (rel === RESOLVER) continue; // the one place the candidate list is allowed to live
      const src = readFileSync(file, "utf8");
      if (/["'`]\/(?:usr|opt|Applications)\/[^"'`]*chrom/i.test(src)) offenders.push(`${rel}: browser path literal`);
      if (/process\.env\.\w*CHROME\w*/i.test(src)) offenders.push(`${rel}: direct CHROME env read`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these files hand-roll Chrome resolution instead of importing ${RESOLVER} — six drifting copies is what darkened the browser tier, and the fix only holds if a seventh cannot appear`
  );
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|js|mjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
