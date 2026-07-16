// FG-570 (FG-553 Child 3) — the bounded ABI assertion, EXECUTED (F31).
//
// The unit tests cover checkAbi's logic. What they CANNOT prove is the property the
// guard exists for: that the refusal actually beats the native loader in a real
// process. A pure-function assertion is green even if better-sqlite3 loads (and
// crashes) three imports earlier. So this file stages a release whose manifest names
// an ABI the running interpreter does not have, then RUNS THE REAL CLI ENTRY from
// inside it and reads what the operator would read on stderr.
//
// CI-portable by construction: the mismatch is manufactured in the MANIFEST, not by
// finding a second interpreter on the host, so this proves the ordering under the one
// Node that is always present. (The real too-new-interpreter arm is below.)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, writeFileSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot } from "../util/git-root.js";
import { RELEASE_MANIFEST_NAME } from "../v2/release.js";
import { REQUIRED_ABI } from "./node-preflight.js";

const sourceRoot = findGitRoot(process.cwd());
const OPAQUE = /NODE_MODULE_VERSION|ERR_DLOPEN/;
let workspace: string;

/** A minimal release: enough of the tree that `src/cli/index.ts` runs and that
 *  readReleaseManifest, walking up from the preflight module's own dir, lands on
 *  OUR manifest. node_modules is symlinked rather than copied — the point is the
 *  preflight's decision, not a byte-exact closure (that is FG-569's test), and the
 *  guard must fire before anything in there is loaded anyway. */
function stageRelease(abi: unknown): string {
  const dir = mkdtempSync(join(workspace, "release-"));
  cpSync(join(sourceRoot, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(sourceRoot, "package.json"), join(dir, "package.json"));
  symlinkSync(join(sourceRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, RELEASE_MANIFEST_NAME),
    JSON.stringify({ schema: 1, id: "release-test", abi, nodeVersion: process.version, interpreter: process.execPath }, null, 2),
  );
  return dir;
}

/** Run the REAL CLI entry from inside the staged release, under the current Node. */
function runEntry(releaseDir: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(releaseDir, "src", "cli", "index.ts"), "--version"], {
    cwd: releaseDir,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "fg570-preflight-"));
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test("FG-570 (EXECUTED): the CLI entry REFUSES by name when the release manifest's ABI is not this interpreter's — before the native load", () => {
  // A manifest ABI the running interpreter provably does not have. 999 is not a real
  // ABI, so this is a too-old-actual mismatch under any Node the suite runs on.
  const dir = stageRelease("999");
  const r = runEntry(dir);

  assert.equal(r.status, 1, `expected a clean exit 1 refusal, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to run/i);
  assert.match(r.stderr, /ABI 999/); // the required ABI, from the manifest
  assert.match(r.stderr, new RegExp(`ABI ${process.versions.modules}`)); // the running ABI
  assert.match(r.stderr, new RegExp(`Node ${process.versions.node.replace(/\./g, "\\.")}`));
  assert.match(r.stderr, /nvm use/);
  // The whole point of FG-570: the operator gets THIS, not the native loader's crash.
  assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
});

test("FG-570 (EXECUTED): a manifest ABI EQUAL to this interpreter's runs the entry — no false refusal", () => {
  const dir = stageRelease(process.versions.modules);
  const r = runEntry(dir);

  assert.equal(r.status, 0, `expected the entry to run, got ${r.status}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /refusing to run/i);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("FG-570 (EXECUTED): a dev checkout (no manifest) falls back to the pinned REQUIRED_ABI", () => {
  // No manifest anywhere above the entry, so expectedAbi() is the constant. This is
  // the path every `bin/forge` invocation in a dev tree takes.
  const dir = mkdtempSync(join(workspace, "dev-"));
  cpSync(join(sourceRoot, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(sourceRoot, "package.json"), join(dir, "package.json"));
  symlinkSync(join(sourceRoot, "node_modules"), join(dir, "node_modules"));
  const r = runEntry(dir);

  // The scratch's node_modules IS built for the running interpreter, so the pinned
  // constant must agree with it — a REQUIRED_ABI that drifts off .nvmrc reddens here.
  assert.equal(REQUIRED_ABI, process.versions.modules, "REQUIRED_ABI has drifted from the interpreter this checkout's binding is built for");
  assert.equal(r.status, 0, `expected the dev entry to run, got ${r.status}\n${r.stderr}`);
});

test("FG-570 (EXECUTED): the preflight's import graph is NATIVE-FREE — importing it loads no better-sqlite3 binding", () => {
  // The guard only beats the native crash if nothing in its OWN graph triggers that
  // crash first. It imports src/v2/release.ts (for readReleaseManifest), which is
  // native-free only because that module's better-sqlite3 require lives inside
  // function bodies — a future top-level import there would defeat the preflight
  // silently. Executed in a fresh process: import the preflight, then inspect the
  // real CJS module cache for a loaded binding.
  const probe = `
    import { createRequire } from "node:module";
    await import(${JSON.stringify(new URL("./node-preflight.ts", import.meta.url).href)});
    const req = createRequire(${JSON.stringify(import.meta.url)});
    console.log(JSON.stringify(Object.keys(req.cache).filter((k) => /better[-_]sqlite3/.test(k))));
  `;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], { encoding: "utf8" });
  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout.trim()), [], "importing node-preflight must not load better-sqlite3");
});

test("FG-570 (EXECUTED): a manifest ABI OLDER than this interpreter's is refused as a NEWER-actual — the exact case the old >= floor admitted", () => {
  // The 999 case above is a too-OLD actual (999 > running), which the pre-FG-570
  // minimum-major floor ALSO caught. The regression FG-570 actually exists for is the
  // opposite direction: an interpreter NEWER than the binding, which `major >= 24`
  // waved through into the native loader's opaque crash. ABI 1 is below every real
  // interpreter, so the running ABI is always the newer one here — executed, not
  // asserted in prose. If the equality is ever relaxed back to a floor, this reddens.
  const dir = stageRelease("1");
  const r = runEntry(dir);

  assert.equal(r.status, 1, `expected a clean exit 1 refusal, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to run/i);
  assert.match(r.stderr, new RegExp(`NEWER ABI \\(${process.versions.modules}\\)`));
  assert.match(r.stderr, /ABI 1\b/); // the required ABI, from the manifest
  assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
});

// A release whose manifest ABI is unreadable is the case the gate USED to fail open on:
// the value we could not read silently became "no opinion", the entry started, and the
// operator got the native loader's opaque crash — exactly what F31 requires the preflight
// to prevent. A release ships its OWN binding, so its manifest is the only authority on
// the ABI that binding needs; the pinned dev constant is not evidence about it. The
// contract is therefore: unreadable release ABI → refuse BY NAME, naming the manifest.

test("FG-570 (EXECUTED): an EMPTY manifest ABI is REFUSED at the entry — an unverified ABI is not a pass", () => {
  // An empty string is NOT nullish, so it never hit the REQUIRED_ABI fallback — it
  // reached the gate as the expected value and used to fail open there. It must block.
  const dir = stageRelease("");
  const r = runEntry(dir);

  assert.equal(r.status, 1, `an unreadable release ABI must refuse, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to run/i);
  assert.match(r.stderr, /does not state a usable ABI/);
  assert.match(r.stderr, new RegExp(RELEASE_MANIFEST_NAME.replace(/\./g, "\\."))); // the manifest, named
  assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
});

test("FG-570 (EXECUTED): an UNPARSEABLE manifest ABI is REFUSED at the entry", () => {
  const dir = stageRelease("not-an-abi");
  const r = runEntry(dir);

  assert.equal(r.status, 1, `an unparseable release ABI must refuse, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /does not state a usable ABI/);
  assert.match(r.stderr, /not-an-abi/); // the offending value, quoted back
  assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
});

test("FG-570 (EXECUTED): a manifest with NO abi field is REFUSED by name — not fallen back to the pinned constant, not a crash", () => {
  // readReleaseManifest JSON.parses with a bare `as ReleaseManifest` cast — nothing
  // validates the shape — so a manifest missing `abi` yields undefined. That must be a
  // named refusal (a release that cannot state its ABI is unverifiable), and above all
  // must not TypeError out of the gate at import time.
  const dir = mkdtempSync(join(workspace, "no-abi-"));
  cpSync(join(sourceRoot, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(sourceRoot, "package.json"), join(dir, "package.json"));
  symlinkSync(join(sourceRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, RELEASE_MANIFEST_NAME),
    JSON.stringify({ schema: 1, id: "release-no-abi", nodeVersion: process.version, interpreter: process.execPath }, null, 2),
  );
  const r = runEntry(dir);

  assert.equal(r.status, 1, `a release with no stated ABI must refuse, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /does not state a usable ABI/);
  assert.match(r.stderr, /\(missing\)/);
  assert.doesNotMatch(r.stderr, /TypeError/, "a manifest without abi must not crash the preflight");
  assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
});

test("FG-570 (EXECUTED): a MALFORMED manifest is REFUSED at the entry — a release forge cannot parse is not a dev checkout", () => {
  // A truncated/corrupted manifest is PRESENT, so this IS a release — but discovery used
  // to swallow the parse error and report "no manifest", which took the REQUIRED_ABI dev
  // fallback. On an interpreter matching the dev pin the guard then passed and the process
  // reached the native loader, where a release whose shipped binding needs a different ABI
  // dies opaquely. Staged with the running ABI's dev pin exactly so the fallback would have
  // PASSED: this reddens if the malformed case ever collapses back into "no release".
  const dir = mkdtempSync(join(workspace, "malformed-"));
  cpSync(join(sourceRoot, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(sourceRoot, "package.json"), join(dir, "package.json"));
  symlinkSync(join(sourceRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, RELEASE_MANIFEST_NAME), `{ "schema": 1, "abi": "${process.versions.modules}"`); // truncated
  const r = runEntry(dir);

  assert.equal(r.status, 1, `a malformed release manifest must refuse, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to run/i);
  assert.match(r.stderr, /manifest is unreadable/);
  assert.match(r.stderr, new RegExp(RELEASE_MANIFEST_NAME.replace(/\./g, "\\."))); // the manifest, named
  assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
});

// A hand-written or third-party-generated manifest can carry `abi` as an unquoted JSON
// number. readReleaseManifest casts without validating, so whatever JSON.parse produced
// reaches the preflight verbatim. The boundary must coerce rather than trust the type:
// the contract is numeric-compatible RUNS, numeric-mismatched refuses BY NAME, and
// unusable refuses BY NAME too (never a fall-back, never a pass).

test("FG-570 (EXECUTED): a NUMERIC manifest ABI equal to this interpreter's runs the entry — a compatible release must not crash on its own manifest's type", () => {
  const dir = stageRelease(Number(process.versions.modules));
  const r = runEntry(dir);

  assert.equal(r.status, 0, `a numeric abi equal to the running ABI is COMPATIBLE and must run, got ${r.status}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /TypeError/, "a numeric abi must not crash the preflight");
  assert.doesNotMatch(r.stderr, /refusing to run/i);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("FG-570 (EXECUTED): a NUMERIC manifest ABI unequal to this interpreter's is refused BY NAME — not a stack trace", () => {
  const dir = stageRelease(999);
  const r = runEntry(dir);

  assert.equal(r.status, 1, `expected a clean exit 1 refusal, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to run/i);
  assert.match(r.stderr, /ABI 999/);
  assert.match(r.stderr, new RegExp(`ABI ${process.versions.modules}`));
  assert.doesNotMatch(r.stderr, /TypeError/, "the refusal must be the named message, not a crash");
  assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
});

test("FG-570 (EXECUTED): a structurally GARBAGE manifest ABI is REFUSED by name — cleanly, not as a stack trace", () => {
  // Each of these stringifies to something Number.parseInt cannot read, so the coercion
  // hands the gate an unreadable release ABI: refuse. (A single-element numeric array
  // like [137] is deliberately NOT here: it stringifies to "137" and is therefore a
  // readable, compatible ABI — it runs on its own merits.)
  for (const garbage of [{ major: 24 }, ["not-an-abi"], true]) {
    const dir = stageRelease(garbage);
    const r = runEntry(dir);

    assert.equal(r.status, 1, `abi=${JSON.stringify(garbage)} is unreadable and must refuse, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /does not state a usable ABI/);
    assert.doesNotMatch(r.stderr, /TypeError/, `abi=${JSON.stringify(garbage)} crashed the preflight`);
    assert.doesNotMatch(r.stderr, OPAQUE, "the native binding loaded before the guard — the preflight lost the race");
  }
});

// F31's real-interpreter arm. The manifest-path tests above manufacture the mismatch in
// the MANIFEST and run under this one interpreter — they prove the ORDERING, but not that
// the guard prevents a genuinely-doomed native load. Only executing under a Node whose ABI
// really differs proves that, so on CI this arm is MANDATORY: `test-extended` provisions
// Node 26 (ABI 147) and exports $FORGE_TEST_MISMATCHED_NODE, and when that variable is set
// every failure mode here reddens rather than skips. Locally, with no variable set, it
// still executes against an installed mismatched Node if one exists, else skips concretely.

const installRoots = [join(process.env.HOME ?? "", ".nvm/versions/node"), "/usr/local/n/versions/node"];

/** The running ABI if `p` is a usable interpreter; otherwise why it isn't. */
function probeAbi(p: string): { abi: string } | { error: string } {
  const r = spawnSync(p, ["-p", "process.versions.modules"], { encoding: "utf8" });
  if (r.error) return { error: `${r.error.message}` };
  if (r.status !== 0) return { error: `exited ${r.status}: ${r.stderr.trim()}` };
  return { abi: r.stdout.trim() };
}

/** Stage a release carrying THIS Node's ABI, execute the real entry under `node`, and
 *  assert the operator gets the named refusal rather than the native loader's crash. */
function assertNamedRefusalUnder(node: string): void {
  const dir = stageRelease(process.versions.modules); // the ABI of THIS Node...
  const r = spawnSync(node, ["--import", "tsx", join(dir, "src", "cli", "index.ts"), "--version"], {
    cwd: dir,
    encoding: "utf8",
  }); // ...executed under a Node that has a DIFFERENT one.

  assert.equal(r.status, 1, `expected a clean refusal under ${node}, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to run/i);
  assert.doesNotMatch(r.stderr, OPAQUE, `${node} reached the native loader — the preflight did not beat it`);
}

test("FG-570 (EXECUTED, F31): a real ABI-incompatible interpreter gets a named refusal, not ERR_DLOPEN_FAILED", (t) => {
  const named = process.env.FORGE_TEST_MISMATCHED_NODE;

  if (named) {
    // The CI gate path. Anything wrong with the provisioning — a missing binary, an
    // interpreter that won't run, an ABI that turns out to match — is a BROKEN GATE, and a
    // broken gate must redden. Skipping here is what let a green suite mean nothing.
    const probed = probeAbi(named);
    if (!("abi" in probed)) {
      assert.fail(`FORGE_TEST_MISMATCHED_NODE=${named} is not a usable interpreter: ${probed.error}`);
    }
    assert.notEqual(
      probed.abi,
      process.versions.modules,
      `FORGE_TEST_MISMATCHED_NODE=${named} reports ABI ${probed.abi}, the same as the running interpreter — it is not actually mismatched, so this arm would prove nothing`,
    );
    assertNamedRefusalUnder(named);
    return;
  }

  // Local dev, no opt-in. Version managers install under the FULL version (nvm:
  // ~/.nvm/versions/node/v26.3.1, n: /usr/local/n/versions/node/26.3.1), so a major-only
  // path like `v26` matches nothing on a normal install. Enumerate what is actually
  // installed instead of guessing directory names.
  const candidates = installRoots.flatMap((root) => {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    return entries
      .sort()
      .reverse()
      .map((v) => join(root, v, "bin", "node"));
  });
  const mismatched = candidates.find((p) => {
    const probed = probeAbi(p);
    return "abi" in probed && probed.abi !== process.versions.modules;
  });

  if (!mismatched) {
    // Concrete, not a shrug: name what was searched so the gap is auditable.
    t.skip(
      `no ABI-incompatible interpreter on this host (running ABI ${process.versions.modules}; $FORGE_TEST_MISMATCHED_NODE unset, and searched every version installed under ${installRoots.join(", ")} — probed ${candidates.length} interpreter path(s)). ` +
        `Set FORGE_TEST_MISMATCHED_NODE to a mismatched interpreter to make this arm mandatory, as CI's test-extended job does.`,
    );
    return;
  }

  assertNamedRefusalUnder(mismatched);
});
