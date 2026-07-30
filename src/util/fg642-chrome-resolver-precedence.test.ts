// FG-642 verify phase: adversity coverage for the ONE Chrome resolver.
//
// The sibling pin (fg642-chrome-precondition.test.ts) proves the resolver FAILS
// instead of skipping, and that the tier's sources can't reintroduce a skip. These
// are the properties an operator leans on the moment that failure lands in front of
// them — the ORDERING the resolver promises and the CONTENT of what it says:
//
//   1. `FORGE_CHROME_BIN` beats a system browser the probe order really would have
//      resolved. Proven NON-VACUOUSLY: the same probe order is first shown resolving
//      that system browser, so the assertion cannot pass by both paths being absent.
//      In an agent container the system path is the image's /usr/local/bin/chromium —
//      the entry four of the five old hand-copied lists lacked.
//   2. `CHROME_PATH` stays a lenient first CANDIDATE while `FORGE_CHROME_BIN` is
//      AUTHORITY: a set-but-missing override must not quietly launch a different
//      browser, and a set-but-missing hint must not fail a machine that has one.
//   3. A set-but-missing override names the override AND the remedy, and does NOT
//      report a probe list it deliberately skipped — sending the operator hunting a
//      path the resolver never looked at is its own wasted hour.
//   4. An exported-but-EMPTY override is not an override. Shell profiles and CI
//      `env:` blocks export empty vars routinely; treating "" as an authoritative
//      path would turn the fail-first behavior into a self-inflicted red on a
//      perfectly provisioned machine.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_CHROME_LOCATIONS,
  chromePreconditionMessage,
  findChrome,
  requireChrome,
} from "./chrome-bin.js";

const PURPOSE = "the dashboard browser tier";
const NO_ENV = { FORGE_CHROME_BIN: undefined, CHROME_PATH: undefined };
const MASKED = [
  "/nonexistent/forge-fg642/probe-a/chrome",
  "/nonexistent/forge-fg642/probe-b/chromium",
  "/nonexistent/forge-fg642/probe-c/google-chrome",
];

// A real, existing file the probe order WILL resolve. In an agent container that is
// the image's chromium; on a Chrome-less machine it falls back to this node binary.
// Either way the precedence assertions below stay deterministic instead of becoming
// conditional — a conditional assertion here would be the skip this ticket removed.
const systemLike = KNOWN_CHROME_LOCATIONS.find(existsSync) ?? process.execPath;

let scratch = "";
let override = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "fg642-chrome-"));
  // A second, operator-chosen path to the SAME real browser: the override wins on
  // precedence, not because it happens to be the only thing that exists.
  override = join(scratch, "operator-chosen-chromium");
  symlinkSync(systemLike, override);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("FG-642 (precedence): FORGE_CHROME_BIN wins over a system browser the probe order really would have resolved", () => {
  // Non-vacuity, established first: with no override, this exact probe order
  // resolves the system browser.
  assert.equal(findChrome({ env: NO_ENV, locations: [systemLike] }), systemLike);
  assert.notEqual(override, systemLike, "the override must be a different path, or precedence is untested");
  assert.ok(existsSync(override) && existsSync(systemLike), "both paths must exist for this to be a precedence test");

  const env = { FORGE_CHROME_BIN: override, CHROME_PATH: undefined };
  assert.equal(findChrome({ env, locations: [systemLike] }), override);
  // The same claim against the REAL location list: in an agent container that list
  // resolves /usr/local/bin/chromium with no env at all, so this is the
  // container-authority form — the override outranks the shipped image browser.
  assert.equal(
    findChrome({ env }),
    override,
    `the override must outrank the system resolution (${String(findChrome({ env: NO_ENV }))})`
  );
  assert.equal(requireChrome(PURPOSE, { env }), override);
});

test("FG-642 (precedence): CHROME_PATH is a lenient first candidate; FORGE_CHROME_BIN is authority over it", () => {
  const hint = join(scratch, "chrome-path-hint");
  writeFileSync(hint, "");

  // The hint outranks the system locations…
  assert.equal(
    findChrome({ env: { FORGE_CHROME_BIN: undefined, CHROME_PATH: hint }, locations: [systemLike] }),
    hint
  );
  // …and loses to the authoritative override.
  assert.equal(
    findChrome({ env: { FORGE_CHROME_BIN: override, CHROME_PATH: hint }, locations: [systemLike] }),
    override
  );
  // A missing HINT is lenient — it falls through rather than failing a machine that
  // has a browser. This is exactly where the hint differs from the override.
  assert.equal(
    findChrome({ env: { FORGE_CHROME_BIN: undefined, CHROME_PATH: MASKED[0] }, locations: [systemLike] }),
    systemLike
  );
  // A missing OVERRIDE is not lenient, with the same system browser present.
  assert.equal(
    findChrome({ env: { FORGE_CHROME_BIN: MASKED[0], CHROME_PATH: undefined }, locations: [systemLike] }),
    undefined
  );
});

test("FG-642 (message): a set-but-missing FORGE_CHROME_BIN names the override and the remedy, and reports no probe list it skipped", () => {
  const bogus = "/nonexistent/forge-fg642/operator-typo/chromium";
  // A resolvable stand-in for the system browser that does NOT appear in the
  // remedy text, so "the message must not name what it skipped" stays a real
  // assertion rather than colliding with the remedy's /usr/local/bin/chromium hint.
  const decoy = join(scratch, "decoy-system-chromium");
  symlinkSync(systemLike, decoy);
  const opts = { env: { FORGE_CHROME_BIN: bogus, CHROME_PATH: undefined }, locations: [decoy] };

  assert.equal(findChrome(opts), undefined, "authoritative-when-set: no silent fallback to the system browser");

  const message = chromePreconditionMessage(PURPOSE, opts);
  assert.ok(message.includes(`FORGE_CHROME_BIN is set to ${bogus} and no file exists there`), message);
  assert.ok(message.includes("Set FORGE_CHROME_BIN to its path"), "the failure must name the remedy, not just the absence");
  assert.ok(message.includes("/usr/local/bin/chromium"), "the remedy must name the path agent containers ship");
  assert.ok(message.includes("must FAIL this tier, never skip to green"), message);
  assert.ok(
    !message.includes("probed:"),
    "an authoritative override is resolved WITHOUT probing — printing a probe list would send the operator hunting a path the resolver never looked at"
  );
  assert.ok(
    !message.includes(decoy),
    `the failure must not name ${decoy}: it was deliberately not consulted once FORGE_CHROME_BIN was set`
  );

  // requireChrome must throw exactly that message — one wording, one place.
  assert.throws(
    () => requireChrome(PURPOSE, opts),
    (err: Error) => {
      assert.equal(err.message, message);
      return true;
    }
  );
});

test("FG-642 (message): with no override and every candidate masked, the failure lists exactly what it probed, in probe order", () => {
  const opts = { env: NO_ENV, locations: MASKED };
  assert.equal(findChrome(opts), undefined);

  const message = chromePreconditionMessage(PURPOSE, opts);
  assert.ok(message.startsWith(`chrome precondition: ${PURPOSE} requires a real Chrome/Chromium binary`), message);
  assert.ok(message.includes(`probed: ${MASKED.join(", ")}`), `every candidate, in order: ${message}`);
  assert.throws(
    () => requireChrome(PURPOSE, opts),
    (err: Error) => {
      assert.ok(err instanceof Error, "the precondition must be a thrown Error, not a returned undefined");
      assert.equal(err.message, message);
      return true;
    }
  );

  // A set-but-missing CHROME_PATH is reported FIRST — the order printed is the order tried.
  const hinted = chromePreconditionMessage(PURPOSE, {
    env: { FORGE_CHROME_BIN: undefined, CHROME_PATH: "/nonexistent/forge-fg642/hinted-first" },
    locations: MASKED,
  });
  assert.ok(
    hinted.includes(`probed: /nonexistent/forge-fg642/hinted-first, ${MASKED.join(", ")}`),
    hinted
  );
});

test("FG-642 (adversity): an exported-but-empty FORGE_CHROME_BIN is not an override — it must not fail a machine that has a browser", () => {
  for (const raw of ["", "   ", "\t\n"]) {
    const env = { FORGE_CHROME_BIN: raw, CHROME_PATH: undefined };
    assert.equal(
      findChrome({ env, locations: [systemLike] }),
      systemLike,
      `FORGE_CHROME_BIN=${JSON.stringify(raw)} must fall through to the probe order, not become an authoritative empty path`
    );
    const message = chromePreconditionMessage(PURPOSE, { env, locations: MASKED });
    assert.ok(message.includes("probed:"), `an empty override must report the probe list: ${message}`);
    assert.ok(!message.includes("is set to"), `an empty override must not be reported as set: ${message}`);
  }
});

test("FG-642 (this environment): the resolver hands back an existing known location or fails by name — never a path that does not exist", () => {
  const resolved = findChrome({ env: NO_ENV });
  if (resolved === undefined) {
    // A Chrome-less machine: the contract is a named failure, and nothing else.
    assert.throws(() => requireChrome(PURPOSE, { env: NO_ENV }), /^Error: chrome precondition: /);
    return;
  }
  assert.ok(existsSync(resolved), `${resolved} was resolved but does not exist`);
  assert.ok(
    KNOWN_CHROME_LOCATIONS.includes(resolved),
    `${resolved} is not one of the shared candidate locations — the resolver must only ever return a path it knows`
  );
  assert.equal(requireChrome(PURPOSE, { env: NO_ENV }), resolved);
});
