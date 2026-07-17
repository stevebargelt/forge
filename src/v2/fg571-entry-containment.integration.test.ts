// FG-571 — ENTRY CONTAINMENT at BOTH layers, EXECUTED and MUTATION-TESTED.
//
// THE DEFECT this suite exists to hold closed: the manifest's `entry` was trusted as
// authority. The shim ended with `exec "$interpreter" --import "$here/<loader>"
// "$here/$__forge_entry"` behind nothing but a non-empty check, and promotion never looked at
// `manifest.entry` at all (assertReleaseCloses runs the FIXED RELEASE_ENTRY_SOURCE constant,
// never the manifest's claim). A candidate whose manifest said `"entry": "../../outside.mjs"`
// therefore passed every promotion gate and then exec'd code OUTSIDE the immutable release
// closure as the machine-wide `forge`. A release is immutable AT REST — that is not the same
// as trustworthy: a hand-built or tampered candidate carries an attacker-controlled entry
// straight to exec.
//
// TWO INDEPENDENT LAYERS, so each is proven independently — but they are no longer the SAME
// check performed twice, and that asymmetry is the fix:
//
//   - LAYER 1, promote.ts validateCandidate: exact equality against RELEASE_ENTRY_SOURCE, PLUS
//     (FG-571 corrective pass) the filesystem half the string check cannot do — the fixed entry
//     must resolve to a REGULAR FILE physically inside the release, with no symlink at the leaf
//     and no symlinked component escaping the release. `src/cli/index.ts` as a link to
//     /tmp/attacker.ts satisfies string equality perfectly.
//
//   - LAYER 2, renderShim: the entry is a FIXED SCHEMA CONSTANT baked into the shim text. The
//     shim does not check `manifest.entry` — it never READS it. Round 1 duplicated promotion's
//     equality check in POSIX sh, which was the wrong shape: it kept caller-controlled bytes on
//     the exec path and made correctness depend on an sh line-matcher agreeing with JSON.parse
//     forever. Nothing dynamic reaches the exec now, so the check is not needed rather than
//     merely passing.
//
// The shim's independence still matters: it runs against whatever `current` selects, including
// a release promoted by an OLDER forge or hand-placed into the store, so it cannot assume
// promotion validated anything. It doesn't have to — it takes instructions ONLY from the
// forge-authored canonical descriptor, and a unit without one is refused by name (layer 2a).
//
// MUTATION-SENSITIVE, not merely green. Asserting "it is refused" proves nothing unless the
// unfixed implementation is shown to be exploitable, so both mutants are executed here:
//   - the shim mutant (restore round 1's manifest read) must ACTUALLY RUN the outside module —
//     proven by a filesystem marker, not by an exit code, which a missing file also produces —
//     and it does so against a unit forge ITSELF promoted, which is the finding's sharpest form;
//   - the promote mutant (drop the equality check) must ACCEPT the traversal candidate.
//
// SAFETY: every release is built from a DISPOSABLE source root (fg571-harness.ts) and promoted
// into a mkdtemp FORGE_HOME with an explicit --prefix. No `npm link`, no git command against
// the real checkout, and nothing reaches the operator's real ~/.forge/current, their real
// interpreter store, or their real shim. `/tmp/evil.mjs` appears below as a hostile MANIFEST
// STRING only — it is never created, and the refusal is what stops it being resolved.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_ENTRY_SOURCE,
  RELEASE_LOADER_NAME,
  RELEASE_MANIFEST_NAME,
  SHIM_NAME,
  renderShim,
  thawReleaseTree,
  type BuildReleaseResult,
  type ReleaseManifest,
} from "./release.js";
import { atomicSymlinkSwap, installShim, promote, readSelection, validateCandidate } from "./promote.js";
import { currentLinkIn, releasesDirIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { canonicalMkdtemp, makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "./fg571-harness.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
/** The forge home the GOOD release is promoted into — the "previous release stays selected"
 *  baseline every promotion refusal below is checked against. */
let home: string;
let prefix: string;
let good: BuildReleaseResult;
let repoHeadBefore: string;
let repoStatusBefore: string;

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** THE HOSTILE INPUTS. Each is an `entry` a manifest can carry that is not the one canonical
 *  entry. The near-matches are the point of the exact-equality rule: `includes`, `startsWith`,
 *  or any path-normalizing containment check would let them through, and each is a distinct
 *  way to be wrong. `undefined` means the key is absent from the manifest entirely. */
const HOSTILE: ReadonlyArray<{ name: string; entry: unknown }> = [
  // The reviewer's exact input: escapes the release root through the shim's `$here/` join.
  { name: "traversal", entry: "../../outside.mjs" },
  { name: "absolute", entry: "/tmp/evil.mjs" },
  // NEAR-MATCHES — a sloppy startsWith/includes/normalization fix passes all three.
  { name: "near-match: canonical prefix + suffix", entry: `${RELEASE_ENTRY_SOURCE}.evil` },
  { name: "near-match: dot-slash", entry: `./${RELEASE_ENTRY_SOURCE}` },
  { name: "near-match: normalizes to canonical", entry: "src/cli/../cli/index.ts" },
  { name: "missing", entry: undefined },
  { name: "malformed: non-string", entry: 42 },
  { name: "malformed: empty", entry: "" },
  { name: "malformed: whitespace", entry: "   " },
];

/** A tampered release: a thawed COPY of the good release whose manifest carries `entry` and a
 *  fresh id. Copied with tar for the same reason installRelease does — a built release is
 *  FROZEN, and a mode-first recursive copy could not write into its own directories.
 *
 *  This is the hand-built candidate the threat model names. Nothing about it is otherwise
 *  invalid: same real interpreter, same real closure, same everything — the ONLY difference
 *  from a release forge would happily promote is the entry string. That is what makes it a
 *  test of the entry check specifically rather than of some other gate catching it first. */
function makeTamperedRelease(label: string, entry: unknown): { dir: string; id: string } {
  const dir = join(workspace, `tampered-${label}`);
  mkdirSync(dir, { recursive: true });
  const copy = spawnSync("/bin/sh", ["-c", 'tar -C "$1" -cf - . | tar -C "$2" -xf -', "sh", good.releaseDir, dir], { encoding: "utf8" });
  assert.equal(copy.status, 0, `tar copy failed: ${copy.stderr}`);
  thawReleaseTree(dir);

  const manifestPath = join(dir, RELEASE_MANIFEST_NAME);
  // Deliberately untyped: a tampered manifest carries values ReleaseManifest forbids (a
  // non-string entry, no entry at all) — which is precisely the input under test.
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const id = `release-tampered-${label.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  manifest.id = id;
  if (entry === undefined) delete manifest.entry;
  else manifest.entry = entry;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { dir, id };
}

/** A disposable forge home together with a release BUILT AGAINST IT.
 *
 *  FG-571 F4: the interpreter-store rule binds to the CONFIGURED home, so a release is
 *  promotable only into the home whose store owns the interpreter it pins. A test that
 *  promotes into a home of its own therefore builds a release for that home (~650ms against
 *  the disposable source root). handPlace below needs none of this — it bypasses promotion
 *  entirely, which is exactly what layer 2a is about. */
function entryHomeWithRelease(label: string): { h: string; rel: BuildReleaseResult } {
  const slug = label.replace(/[^A-Za-z0-9]/g, "");
  const h = canonicalMkdtemp(`fg571-entry-${slug}-`);
  return { h, rel: source.build({ outDir: join(workspace, `rel-${slug}`), rand: `e${slug}`.slice(0, 6).padEnd(6, "0"), home: h }) };
}

/** A forge home whose `current` points DIRECTLY at `releaseDir`, with promote never called.
 *  This is the whole point of layer 2: the shim must refuse on its own authority, so staging
 *  the release through the promoter it is supposed to be independent of would prove nothing.
 *  Models a release promoted by an older forge, or one hand-placed into the store. */
function handPlace(label: string, releaseDir: string, id: string): string {
  const h = canonicalMkdtemp(`fg571-entry-home-${label.replace(/[^A-Za-z0-9]/g, "")}-`);
  const releases = releasesDirIn(h);
  mkdirSync(releases, { recursive: true });
  const target = join(releases, id);
  mkdirSync(target, { recursive: true });
  const copy = spawnSync("/bin/sh", ["-c", 'tar -C "$1" -cf - . | tar -C "$2" -xf -', "sh", releaseDir, target], { encoding: "utf8" });
  assert.equal(copy.status, 0, `tar copy failed: ${copy.stderr}`);
  atomicSymlinkSwap(target, currentLinkIn(h));
  return h;
}

/** Run an installed shim against a forge home. FORGE_HOME is explicit — that is what keeps
 *  this off the operator's real control plane. */
function runShim(shimPath: string, forgeHome: string): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(shimPath, ["--version"], { encoding: "utf8", env: { ...process.env, FORGE_HOME: forgeHome } });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

before(async () => {
  repoHeadBefore = gitIn(repoRoot, ["rev-parse", "HEAD"]).trim();
  repoStatusBefore = gitIn(repoRoot, ["status", "--porcelain"]);

  workspace = canonicalMkdtemp("fg571-entry-ws-");
  home = canonicalMkdtemp("fg571-entry-home-");
  prefix = canonicalMkdtemp("fg571-entry-prefix-");
  // Built against THIS suite's home: the interpreter-store rule binds to the CONFIGURED
  // home (FG-571 F4), so a release is promotable only into the home whose store owns the
  // interpreter it pins.
  source = await makeDisposableSourceRoot(repoRoot, home);

  // ONE real build. Every hostile case is a tampered COPY of it, so each differs from a
  // promotable release by exactly the entry string and nothing else.
  good = source.build({ outDir: join(workspace, "release-good"), rand: "entry01" });
  promote({ home, candidate: good.releaseDir });
});

after(() => {
  for (const d of [workspace, home, prefix]) {
    if (existsSync(d)) {
      spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", d]);
      rmSync(d, { recursive: true, force: true });
    }
  }
  if (source) removeDisposableSourceRoot(source);
});

// ─────────────────────────── LAYER 1 — the promotion gate ───────────────────────────

for (const { name, entry } of HOSTILE) {
  test(`layer 1 (promote): refuses a non-canonical entry — ${name}`, () => {
    const { dir } = makeTamperedRelease(`p-${name}`, entry);
    const selectedBefore = readSelection(home);

    assert.throws(
      () => promote({ home, candidate: dir }),
      (e: Error) => {
        // The FG-570 refusal shape: what was wrong, WHERE, what was expected, what was found,
        // how to fix. An operator who cannot see all four cannot act on the refusal.
        assert.match(e.message, /refusing to promote — this release names a non-canonical entry point/);
        assert.match(e.message, /release manifest: .*forge-release\.json/);
        assert.match(e.message, new RegExp(`expected entry:\\s+${RELEASE_ENTRY_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(e.message, /manifest entry:/);
        assert.match(e.message, /Fix: rebuild with `forge release build`/);
        return true;
      },
      `promote must refuse entry ${JSON.stringify(entry)}`,
    );

    // FAIL CLOSED: the previous release stays selected. A refusal that moved the pointer would
    // be a worse outcome than the defect it refuses.
    assert.deepEqual(readSelection(home)?.releaseDir, selectedBefore?.releaseDir);
    assert.equal(readSelection(home)?.manifest?.id, good.manifest.id);
  });
}

test("layer 1 (promote): the canonical entry still promotes — the guard is not a blanket refusal", () => {
  const { h, rel: good } = entryHomeWithRelease("ok");
  try {
    const r = promote({ home: h, candidate: good.releaseDir });
    assert.equal(r.id, good.manifest.id);
    assert.equal(readSelection(h)?.manifest?.entry, RELEASE_ENTRY_SOURCE);
  } finally {
    spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", h]);
    rmSync(h, { recursive: true, force: true });
  }
});

// ───────── LAYER 2a — the installed shim vs a HAND-PLACED unit, promote BYPASSED ─────────
//
// A unit that no forge promotion ever authored carries no canonical execution descriptor, and
// the descriptor is the ONLY thing the shim reads inside the selected unit. So every hostile
// manifest below is refused for a reason that does not depend on inspecting the manifest at
// all: there is nothing here the shim is willing to take instructions from. This is the case
// that models a release promoted by an OLDER forge or hand-placed into the store — the shim
// cannot assume any promotion validated anything, and it doesn't need to.

for (const { name, entry } of HOSTILE) {
  test(`layer 2a (shim): a hand-placed unit carrying a non-canonical entry never execs — ${name}`, () => {
    const { dir, id } = makeTamperedRelease(`s-${name}`, entry);
    const h = handPlace(name, dir, id);
    try {
      // The escape target for the traversal case: $here/../../outside.mjs resolves to
      // <home>/outside.mjs. It EXISTS and is executable — so if the shim resolves the entry at
      // all, it runs, and the marker's absence below is evidence rather than an accident of
      // a missing file.
      const marker = join(h, `marker-${name.replace(/[^a-z]/gi, "")}`);
      writeFileSync(join(h, "outside.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "OUTSIDE MODULE EXECUTED\\n");\n`);

      const shimPath = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
      const r = runShim(shimPath, h);

      assert.notEqual(r.status, 0, `the shim must refuse the hand-placed unit for entry ${JSON.stringify(entry)}, got exit 0`);
      assert.match(r.stderr, /refusing to run — this release carries no canonical execution descriptor/);
      assert.match(r.stderr, /expected descriptor: .*forge-exec/, "and says WHERE");
      assert.match(r.stderr, /running:\s+the machine-wide forge shim/, "and what was running");
      assert.match(r.stderr, /Fix:/, "and how to fix it");
      assert.equal(existsSync(marker), false, "the outside module must not have executed");
    } finally {
      spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", h]);
      rmSync(h, { recursive: true, force: true });
    }
  });
}

// ───────── LAYER 2b — the SHARP case: a PROPERLY PROMOTED unit, manifest poisoned after ─────────
//
// Layer 2a proves a unit forge never authored cannot instruct the shim. This proves the
// stronger claim, and it is the one the whole descriptor design exists to buy: even a unit
// that forge DID promote — real descriptor, real everything — cannot redirect the exec through
// its manifest, because the entry and the loader are FIXED SCHEMA CONSTANTS baked into the
// shim text and the shim never reads the manifest at all. The manifest's `entry` field is
// simply not on the trust path any more. Nothing to diverge, nothing to check.

/** A properly promoted unit whose manifest is poisoned AFTERWARDS — the post-promotion tamper
 *  the old shim would have obeyed. Returns the home, so the shim can be pointed at it. */
function promoteThenPoisonManifest(label: string, entry: unknown): { home: string; marker: string } {
  const { h, rel } = entryHomeWithRelease(`poisoned${label}`);
  promote({ home: h, candidate: rel.releaseDir });
  const unit = readSelection(h)!.releaseDir;

  thawReleaseTree(unit);
  const manifestPath = join(unit, RELEASE_MANIFEST_NAME);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (entry === undefined) delete manifest.entry;
  else manifest.entry = entry;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const marker = join(h, "OUTSIDE-EXECUTED");
  writeFileSync(join(h, "outside.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "OUTSIDE MODULE EXECUTED\\n");\n`);
  return { home: h, marker };
}

for (const { name, entry } of HOSTILE) {
  test(`layer 2b (shim): a poisoned manifest CANNOT redirect a promoted unit's exec — ${name}`, () => {
    const { home: h, marker } = promoteThenPoisonManifest(`b-${name}`, entry);
    try {
      const shimPath = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
      const r = runShim(shimPath, h);

      // It RUNS — and it runs the CANONICAL entry, which is the whole point. The poisoned
      // manifest is not an error to report; it is an input the shim does not have.
      assert.equal(r.status, 0, `the canonical entry must still exec despite the poisoned manifest: ${r.stderr}`);
      assert.equal(existsSync(marker), false, `the outside module named by entry ${JSON.stringify(entry)} must not have executed`);
    } finally {
      spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", h]);
      rmSync(h, { recursive: true, force: true });
    }
  });
}

test("layer 2 (shim): the canonical entry still execs — the guard is not a blanket refusal", () => {
  const shimPath = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
  const r = runShim(shimPath, home);
  assert.equal(r.status, 0, `the canonical entry must still run: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /non-canonical entry/);
});

// ──────────────────────────── MUTATION SENSITIVITY ────────────────────────────

/** The shim as it was BEFORE the fix: instead of exec'ing the baked entry CONSTANT, read
 *  `entry` out of the raw manifest with an sh line-matcher and exec whatever it says, joined
 *  to $here. This is FG-571 round 1's shim, and the equality guard it carried is deliberately
 *  NOT reproduced — the point being demonstrated is not that one guard was removable, it is
 *  that reading the manifest at all is what put attacker-controlled bytes on the exec path.
 *  Derived from the REAL shim so it goes stale loudly if the real exec line ever moves. */
function manifestReadingShimText(): string {
  const real = renderShim();
  const exec = `exec "$__forge_interpreter" --import "$here/${RELEASE_LOADER_NAME}" "$here/${RELEASE_ENTRY_SOURCE}" "$@"`;
  assert.ok(real.includes(exec), "the real shim no longer execs the baked entry constant — this mutant is stale");
  const vulnerable = [
    `__forge_m=$here/${RELEASE_MANIFEST_NAME}`,
    `while IFS= read -r __forge_ln; do`,
    `  case "$__forge_ln" in`,
    `  *\\"entry\\":*)`,
    `    __forge_v=\${__forge_ln#*\\"entry\\": \\"}`,
    `    __forge_entry=\${__forge_v%%\\"*} ;;`,
    `  esac`,
    `done < "$__forge_m"`,
    `exec "$__forge_interpreter" --import "$here/${RELEASE_LOADER_NAME}" "$here/$__forge_entry" "$@"`,
  ].join("\n");
  const mutant = real.replace(exec, vulnerable);
  assert.notEqual(mutant, real, "the mutation did not change the shim");
  return mutant;
}

test("MUTANT (shim): a manifest-reading shim ACTUALLY EXECUTES the traversal entry — on a unit forge itself promoted", () => {
  // The sharpest form of the finding. This unit is fully legitimate: forge materialized it,
  // validated it, authored its descriptor, froze it, and published it. Only the manifest's
  // `entry` was poisoned afterwards. A shim that reads that field therefore execs attacker
  // bytes out of a release that PASSED every promotion gate — which is exactly why the field
  // had to leave the trust path rather than get one more check.
  const { home: h, marker } = promoteThenPoisonManifest("mutant-traversal", "../../outside.mjs");
  const mutantPrefix = canonicalMkdtemp("fg571-entry-mutprefix-");
  try {
    const shimPath = installShim({ prefix: mutantPrefix, shimText: manifestReadingShimText(), shimName: SHIM_NAME });
    const r = runShim(shimPath, h);

    // THE EXPLOIT, demonstrated rather than asserted. The marker is a filesystem side effect of
    // a module OUTSIDE the release closure having run as the machine-wide forge. An exit code
    // could not carry this evidence — a nonexistent entry also exits nonzero.
    assert.equal(existsSync(marker), true, `the vulnerable shim must actually exec the outside module — it did not (exit ${r.status}): ${r.stderr}`);
    assert.match(readFileSync(marker, "utf8"), /OUTSIDE MODULE EXECUTED/);
    assert.equal(r.status, 0, `the vulnerable shim ran the outside module to completion: ${r.stderr}`);

    // ...and the FIXED shim, on the very same unit, execs the canonical entry and leaves no marker.
    rmSync(marker, { force: true });
    const fixed = installShim({ prefix: mutantPrefix, shimText: renderShim(), shimName: `${SHIM_NAME}-fixed` });
    const r2 = runShim(fixed, h);
    assert.equal(r2.status, 0, `the fixed shim runs the canonical entry: ${r2.stderr}`);
    assert.equal(existsSync(marker), false, "the fixed shim must not exec the outside module");
  } finally {
    for (const d of [h, mutantPrefix]) {
      spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", d]);
      rmSync(d, { recursive: true, force: true });
    }
  }
});

test("MUTANT (promote): with the equality check dropped, validateCandidate ACCEPTS the traversal candidate", async () => {
  // The mutant is a real copy of promote.ts with the guard excised, imported from the
  // disposable source root so its relative imports (../util/paths.js) still resolve. Every
  // release was built in before(), so writing here cannot dirty a later build.
  const realPath = join(source.root, "src", "v2", "promote.ts");
  const mutantPath = join(source.root, "src", "v2", "promote-entry-mutant.ts");
  const src = readFileSync(realPath, "utf8");
  const guard = /  const entry: unknown = manifest\.entry;\n  if \(entry !== RELEASE_ENTRY_SOURCE\) \{[\s\S]*?\n  \}\n/;
  assert.match(src, guard, "the entry guard is not where this mutant expects it — the mutant is stale");
  const mutantSrc = src.replace(guard, "");
  assert.notEqual(mutantSrc, src, "the mutation did not change promote.ts");
  writeFileSync(mutantPath, mutantSrc);

  try {
    const { validateCandidate: vulnerable } = (await import(mutantPath)) as { validateCandidate: (d: string, home?: string) => { manifest: ReleaseManifest } };
    const { dir } = makeTamperedRelease("mutant-promote", "../../outside.mjs");

    // The vulnerable promoter waves the traversal candidate straight through — proof that the
    // equality check, and not some other gate, is what refuses it in the fixed version.
    const accepted = vulnerable(dir, home);
    assert.equal(accepted.manifest.entry as unknown, "../../outside.mjs");

    // Same candidate, same directory, fixed promoter: refused.
    assert.throws(() => validateCandidate(dir), /non-canonical entry point/);
  } finally {
    rmSync(mutantPath, { force: true });
  }
});

// ──────────────────────────── CONTAINMENT ────────────────────────────

test("this suite never touched the real checkout", () => {
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the real checkout's HEAD moved");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "the real checkout's working tree changed");
});
