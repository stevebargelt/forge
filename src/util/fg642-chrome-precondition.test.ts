// FG-642: the dashboard browser tier must be EVIDENCE, not a suite that reports
// green wherever Chrome happens to be missing.
//
// The tier claimed 5 suites / 18 real-browser tests but every test was declared
// `{ skip: !CHROME_PATH }` against one of five hand-copied candidate lists. Four of
// the five never listed /usr/local/bin/chromium — the path the agent image ships —
// so in every agent container the tier resolved nothing, skipped, and reported pass.
// That is how it concealed a live red through FG-608.
//
// Two properties are pinned here, in the unit tier so they fire without a browser:
//   1. the shared resolver hard-FAILS with a named precondition (fail-first), and
//      FORGE_CHROME_BIN overrides everything — including the real system paths;
//   2. the tier cannot go dark again by re-introducing a skip, a private candidate
//      list, or by deleting the tests.
//
// Property 2 is read out of the browser-test SOURCES on purpose: nothing else in a
// Chrome-less run would notice, which is precisely the failure being closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CHROME_LOCATIONS, findChrome, requireChrome } from "./chrome-bin.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIER_DIR = join(ROOT, "dashboard", "browser-tests");

const MASKED = ["/nonexistent/forge-fg642/chrome", "/nonexistent/forge-fg642/chromium"];
const NO_ENV = { FORGE_CHROME_BIN: undefined, CHROME_PATH: undefined };

const tierFiles = (): string[] => readdirSync(TIER_DIR).filter((f) => f.endsWith(".test.ts")).sort();
const tierSource = (file: string): string => readFileSync(join(TIER_DIR, file), "utf8");

test("FG-642 (fail-first): with every candidate masked, the resolver FAILS with a named precondition — it never returns undefined quietly to a skip", () => {
  assert.equal(findChrome({ env: NO_ENV, locations: MASKED }), undefined);
  assert.throws(
    () => requireChrome("the dashboard browser tier", { env: NO_ENV, locations: MASKED }),
    (err: Error) => {
      assert.match(err.message, /^chrome precondition: the dashboard browser tier requires a real Chrome\/Chromium binary/);
      assert.match(err.message, /Set FORGE_CHROME_BIN to its path/, "the failure must name the remedy, not just the absence");
      assert.match(err.message, /must FAIL this tier, never skip to green/);
      assert.match(err.message, new RegExp(MASKED[0]!), "the failure must name what it probed");
      return true;
    }
  );
});

test("FG-642: FORGE_CHROME_BIN overrides everything — a bogus override FAILS even where a real Chrome is installed, and names the override", () => {
  // The override being authoritative is what makes the fail-first demonstration
  // possible on a machine that HAS Chrome: `FORGE_CHROME_BIN=/nope npm run
  // test:browser -w dashboard` must go red. Falling through to a system Chrome
  // would silently ignore the operator's explicit choice.
  const bogus = "/nonexistent/forge-fg642/explicitly-set";
  const env = { FORGE_CHROME_BIN: bogus, CHROME_PATH: undefined };
  assert.equal(findChrome({ env }), undefined, "a set-but-missing override must not fall back to the real locations");
  assert.throws(() => requireChrome("capture", { env }), new RegExp(`FORGE_CHROME_BIN is set to ${bogus} and no file exists there`));

  // And an override that DOES exist wins over the system locations.
  assert.equal(findChrome({ env: { FORGE_CHROME_BIN: process.execPath, CHROME_PATH: undefined } }), process.execPath);
});

test("FG-642: the shared candidate list carries the agent image's chromium", () => {
  assert.ok(
    KNOWN_CHROME_LOCATIONS.includes("/usr/local/bin/chromium"),
    "docker/agent-dev-worker.Dockerfile symlinks Playwright's chromium to /usr/local/bin/chromium — dropping it re-darkens the tier in exactly the container the verify phase runs in"
  );
});

test("FG-642: every browser-tier suite resolves Chrome through the shared resolver and keeps no private candidate list", () => {
  const files = tierFiles();
  assert.ok(files.length >= 5, `the browser tier must keep its 5 suites (found ${files.length})`);
  for (const file of files) {
    const src = tierSource(file);
    assert.match(
      src,
      /import \{ requireChrome \} from "\.\.\/\.\.\/src\/util\/chrome-bin\.js"/,
      `${file} must resolve Chrome through src/util/chrome-bin.ts — six drifting copies is how this tier went dark`
    );
    assert.match(src, /requireChrome\(/, `${file} imports the resolver but never calls it`);
    for (const pattern of [/CHROME_CANDIDATES/, /"\/usr\/bin\/(?:google-)?chrom/, /"\/Applications\/Google Chrome\.app/]) {
      assert.doesNotMatch(src, pattern, `${file} re-introduces a private Chrome candidate list (${pattern.source}) — there is exactly one, in src/util/chrome-bin.ts`);
    }
  }
});

test("FG-642: the browser tier cannot be made green by skipping, and its 18 tests cannot be deleted", () => {
  const skipMechanisms = [/\btest\.skip\s*\(/, /\bit\.skip\s*\(/, /\bdescribe\.skip\s*\(/, /\bt\.skip\s*\(/, /\bskip\s*:/, /\btodo\s*:/];
  let total = 0;
  for (const file of tierFiles()) {
    const src = tierSource(file);
    for (const pattern of skipMechanisms) {
      assert.doesNotMatch(src, pattern, `${file} must not skip: ${pattern.source} — a Chrome-less environment must stay RED, not go quietly green`);
    }
    // The precondition belongs in the file-wide `before` hook: one test gating on it
    // would leave the file's other tests passing without a browser. Hence both the
    // hook shape AND the position — the first resolve must precede the first test.
    assert.match(src, /before\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]*?requireChrome\(/, `${file}'s Chrome precondition must sit in its file-wide \`before\` hook`);
    assert.ok(
      src.indexOf("requireChrome(") < src.search(/^test\(/m),
      `${file} resolves Chrome only after its first test — the precondition must gate the whole file from its \`before\` hook`
    );
    total += (src.match(/^test\(/gm) ?? []).length;
  }
  assert.ok(
    total >= 18,
    `the browser tier must keep its 18 real-browser tests (found ${total}) — deleting them is the other way to make a Chrome-less environment green`
  );
});

// The third way this tier goes dark — running in CI nowhere at all — is pinned in
// src/v2/ci-workflow.test.ts alongside the rest of the extended gate's shape, so
// there is one place that knows what ci.yml must contain.

test("FG-642: the host-side CDP capture consumes the same resolver", () => {
  const src = readFileSync(join(ROOT, "src", "util", "cdp-capture.ts"), "utf8");
  assert.match(src, /import \{ requireChrome \} from "\.\/chrome-bin\.js"/);
  assert.doesNotMatch(src, /CHROME_CANDIDATES|function findChrome/, "cdp-capture.ts must not keep its own copy of the candidate list");
});
