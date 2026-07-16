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
import { mkdtempSync, cpSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
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
function stageRelease(abi: string): string {
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

test("FG-570 (EXECUTED): an EMPTY manifest ABI fails OPEN at the entry — no refusal manufactured from an unreadable value", () => {
  // checkAbi's fail-open is unit-tested; this proves it survives the whole expectedAbi()
  // → applyNodePreflight() → real-entry path. An empty string is NOT nullish, so it does
  // NOT hit the `?? REQUIRED_ABI` fallback — it reaches checkAbi as the expected value and
  // must fail open there. A future "empty means block" tightening reddens here.
  const dir = stageRelease("");
  const r = runEntry(dir);

  assert.equal(r.status, 0, `an unreadable expected ABI must not block the entry, got ${r.status}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /refusing to run/i);
});

test("FG-570 (EXECUTED): an UNPARSEABLE manifest ABI fails OPEN at the entry", () => {
  const dir = stageRelease("not-an-abi");
  const r = runEntry(dir);

  assert.equal(r.status, 0, `an unparseable expected ABI must not block the entry, got ${r.status}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /refusing to run/i);
});

test("FG-570 (EXECUTED): a manifest with NO abi field falls back to the pinned REQUIRED_ABI rather than crashing", () => {
  // readReleaseManifest JSON.parses with a bare `as ReleaseManifest` cast — nothing
  // validates the shape — so a manifest missing `abi` yields undefined. expectedAbi()'s
  // `?? REQUIRED_ABI` is the only thing standing between that and a TypeError inside
  // checkAbi at import time. This pins that branch on the real entry.
  const dir = mkdtempSync(join(workspace, "no-abi-"));
  cpSync(join(sourceRoot, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(sourceRoot, "package.json"), join(dir, "package.json"));
  symlinkSync(join(sourceRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, RELEASE_MANIFEST_NAME),
    JSON.stringify({ schema: 1, id: "release-no-abi", nodeVersion: process.version, interpreter: process.execPath }, null, 2),
  );
  const r = runEntry(dir);

  assert.equal(REQUIRED_ABI, process.versions.modules, "REQUIRED_ABI has drifted from the interpreter this checkout's binding is built for");
  assert.equal(r.status, 0, `expected the fallback to REQUIRED_ABI to run, got ${r.status}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /TypeError/, "a manifest without abi must not crash the preflight");
});

// F31's real-interpreter arm. The plan calls for executing under a genuinely
// ABI-incompatible Node (v26 / ABI 147). This test RESOLVES one if the host has it and
// executes the real entry under it; where none exists it records that concretely rather
// than passing silently — the manifest-path tests above already prove the ordering
// portably, under the interpreter that is always present.
test("FG-570 (EXECUTED, F31): a real ABI-incompatible interpreter gets a named refusal, not ERR_DLOPEN_FAILED", (t) => {
  const candidates = [
    ...(process.env.FORGE_TEST_MISMATCHED_NODE ? [process.env.FORGE_TEST_MISMATCHED_NODE] : []),
    ...["26", "25", "23", "22", "20"].flatMap((v) => [
      join(process.env.HOME ?? "", `.nvm/versions/node/v${v}`, "bin", "node"),
      `/usr/local/n/versions/node/${v}/bin/node`,
    ]),
  ];
  const mismatched = candidates.find((p) => {
    const probe = spawnSync(p, ["-p", "process.versions.modules"], { encoding: "utf8" });
    return probe.status === 0 && probe.stdout.trim() !== process.versions.modules;
  });

  if (!mismatched) {
    // Concrete, not a shrug: name what was searched so the gap is auditable.
    t.skip(
      `no ABI-incompatible interpreter on this host (running ABI ${process.versions.modules}; searched $FORGE_TEST_MISMATCHED_NODE and nvm/n paths for v26/25/23/22/20). ` +
        `The manifest-path tests above prove the pre-native-load ordering under this interpreter.`,
    );
    return;
  }

  const dir = stageRelease(process.versions.modules); // the ABI of THIS Node...
  const r = spawnSync(mismatched, ["--import", "tsx", join(dir, "src", "cli", "index.ts"), "--version"], {
    cwd: dir,
    encoding: "utf8",
  }); // ...executed under a Node that has a DIFFERENT one.

  assert.equal(r.status, 1, `expected a clean refusal under ${mismatched}, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to run/i);
  assert.doesNotMatch(r.stderr, OPAQUE, `${mismatched} reached the native loader — the preflight did not beat it`);
});
