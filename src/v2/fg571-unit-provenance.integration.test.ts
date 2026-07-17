// FG-571 (FG-553 Child 4) — UNIT PROVENANCE: what may be SELECTED, and on what evidence.
//
// THE SELECTED IMMUTABLE BYTES — NOT THE DIRECTORY'S LOCATION — ARE THE EVIDENCE.
//
// The sibling suites cover the CLEAN flow: a fresh candidate path is staged, symlink-gated,
// validated, frozen, and atomically published, and that exact unit is what `current` selects.
// This file covers every way a promotion or a rollback used to get AROUND that flow, because
// each bypass was the same defect: forge validated one directory and selected another, or
// selected a directory on the strength of where it sat rather than what forge knew about it.
//
// Store residency, pathname equality, the release id, existence, and permissions are NOT
// provenance — a hand-placed directory under `releases/` has every one of them. So the
// question each test here asks is not "did forge check the unit" but "can forge PROVE it made
// the bytes it is about to exec as the machine-wide forge".
//
// EXECUTED, per FG-551: a property about the final runtime is demonstrated by RUNNING the
// final artifact. The attacker units below carry a poisoned loader that drops a FILESYSTEM
// MARKER when its bytes are exec'd, so "the attacker's release ran" is a file on disk left by
// a real process — never an inference from a symlink's target. And every closure claim names
// the MUTANT that must redden it: the finding's own code, restored into a copy of the module
// under test, run against the same attack.
//
// SAFETY: every promotion, rollback, shim install and interpreter install here lands in a
// mkdtemp FORGE_HOME with an explicit --prefix. Releases are built from a DISPOSABLE source
// root (fg571-harness.ts), never by committing in the real checkout. Nothing here touches the
// developer's real ~/.forge/current, ~/.forge/releases, ~/.forge/interpreters, their real
// shim, or ~/.forge/runtimes, and nothing here runs `npm link`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_EXEC_NAME, RELEASE_LOADER_NAME, RELEASE_MANIFEST_NAME, SHIM_NAME, renderExecDescriptor, renderShim, thawReleaseTree, type BuildReleaseResult, type ReleaseManifest } from "./release.js";
import { installShim, promote, readPrevious, readSelection, rollback } from "./promote.js";
import { currentLinkIn, previousLinkIn, releasesDirIn, unitsDirIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { canonicalMkdtemp, makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "./fg571-harness.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
let home: string;
let relX: BuildReleaseResult;
let shim: string;

function shimEnv(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };
}

/** EXECUTE the machine-wide shim and return the RUNNING process's own provenance report.
 *  This — never the symlink — is what the assertions read. */
function runProvenance(): { status: number | null; stderr: string; prov: any } {
  const r = spawnSync(shim, ["release", "provenance", "--json"], { encoding: "utf8", env: shimEnv() });
  let prov: any;
  try {
    prov = JSON.parse(r.stdout);
  } catch {
    prov = undefined;
  }
  return { status: r.status, stderr: r.stderr, prov };
}

/** A tree digest computed INDEPENDENTLY of production's, so "the retained unit is byte-identical"
 *  is asserted against the bytes rather than against promote.ts's opinion of them. Deliberately
 *  a different construction (a sorted list of path+sha256 lines, hashed) — it has to agree about
 *  CHANGE, not about the algorithm. */
function independentTreeDigest(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      const r = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isSymbolicLink()) lines.push(`L ${r}`);
      else if (ent.isDirectory()) walk(p, r);
      else lines.push(`F ${r} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root, "");
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

/** A COMPLETE, VALID release unit at a fresh location that forge never published — the
 *  attacker's artifact, and the thing every test here tries to get selected.
 *
 *  It is a copy of a unit forge DID publish, restated under `id`: manifest identity and the
 *  canonical descriptor both rewritten, so it passes the full unit gate (parse, identity,
 *  entry containment, pinned store interpreter, descriptor/manifest agreement, and the closure
 *  actually RUNNING). That is the point — this is not a broken release that any validator would
 *  catch. It is a perfectly valid one that forge did not make.
 *
 *  `marker` poisons the release's own loader, which the entry runs via `--import` on EVERY
 *  exec of this unit. So if these bytes are ever exec'd, a real process writes that file. */
function attackerUnit(name: string, id: string, marker?: string): string {
  const dest = join(workspace, name);
  const from = realpathSync(join(releasesDirIn(home), relX.manifest.id));
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", dest, from]);
  execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"', "sh", dest]);

  const manifest = JSON.parse(readFileSync(join(dest, RELEASE_MANIFEST_NAME), "utf8")) as ReleaseManifest;
  manifest.id = id;
  writeFileSync(join(dest, RELEASE_MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dest, RELEASE_EXEC_NAME), renderExecDescriptor({ interpreter: manifest.interpreter, id }));
  if (marker) {
    appendFileSync(join(dest, RELEASE_LOADER_NAME), `\nimport { writeFileSync as __w } from "node:fs";\n__w(${JSON.stringify(marker)}, "the attacker's bytes ran");\n`);
  }
  return dest;
}

/** A copy of the module under test with ONE finding's code restored — the mutant.
 *
 *  Written into the disposable workspace with its relative imports rewritten to absolute
 *  specifiers, NEVER into src/: a mutant file inside the real checkout would show up in the
 *  sibling suite's `git status` containment assertion when both run under one
 *  `npm run test:integration`, and would redden it for a reason that has nothing to do with the
 *  code under test. */
async function mutantPromote(name: string, mutate: (src: string) => string): Promise<typeof import("./promote.js")> {
  const src = readFileSync(join(moduleDir, "promote.ts"), "utf8");
  const mutated = mutate(src);
  assert.notEqual(mutated, src, `the ${name} mutation actually applied — a no-op mutant proves nothing`);
  const p = join(workspace, name);
  writeFileSync(
    p,
    mutated
      .replace('from "../util/paths.js"', `from ${JSON.stringify(join(moduleDir, "..", "util", "paths.js"))}`)
      .replace('from "./release.js"', `from ${JSON.stringify(join(moduleDir, "release.js"))}`)
      .replace('from "./runtime-store.js"', `from ${JSON.stringify(join(moduleDir, "runtime-store.js"))}`),
  );
  return (await import(pathToFileURL(p).href)) as typeof import("./promote.js");
}

/** THE F1 FINDING, RECONSTRUCTED: the pre-fix shape, in which a candidate addressed inside the
 *  store took the realpath-equality shortcut — `forge already materialized, validated, froze,
 *  and atomically published these exact bytes` — instead of being asked for evidence. Both
 *  halves are the one finding: the shortcut only ever fired because nothing else stood in
 *  front of it. */
const RESTORE_SHORTCUT = (src: string): string =>
  src
    .replace("if (isInsideStore(home, source)) {", "if (false) {")
    .replace(
      "  const claimedId = readCandidateId(source);\n  const releases = releasesDirIn(home);",
      "  const claimedId = readCandidateId(source);\n  const releases = releasesDirIn(home);\n" +
        "  const __target = join(releases, claimedId);\n" +
        "  if (existsSync(__target) && realpathSync(__target) === realpathSync(source)) return validateUnit(__target, home);",
    );

/** THE F2 FINDING, VERBATIM: validate one directory, select ANOTHER. */
const RESTORE_OCCUPIED_ID_BRANCH = (src: string): string =>
  src.replace(
    "    // GENERATE the canonical, forge-authored execution descriptor INSIDE the staged unit,",
    "    if (existsSync(target)) {\n" +
      "      spawnSync(\"/bin/sh\", [\"-c\", 'chmod -R u+w \"$1\" 2>/dev/null; exit 0', \"sh\", staging]);\n" +
      "      rmSync(staging, { recursive: true, force: true });\n" +
      "      return validateUnit(target, home);\n" +
      "    }\n" +
      "    // GENERATE the canonical, forge-authored execution descriptor INSIDE the staged unit,",
  );

/** THE F3 FINDING: rollback with the content binding removed — validate-to-select, nothing
 *  standing between a hand-placed `previous` and the pointer swap. */
const REMOVE_ROLLBACK_BINDING = (src: string): string => src.replace("if (!isFrozenPublishedUnit(home, previous.releaseDir)) {", "if (false) {");

/** Point `previous` at `dir` while leaving `current` alone — the shape an attacker who can
 *  write the store arranges before the operator types `forge release rollback`. Uses
 *  production's own pair-publishing primitive via a plain promotion first, then rewrites the
 *  one link, so `current` stays exactly where the last promotion put it. */
function makePreviousResolveTo(dir: string): void {
  const selection = realpathSync(join(home, "selection"));
  rmSync(join(selection, "previous"), { force: true });
  symlinkSync(dir, join(selection, "previous"));
}

before(async () => {
  workspace = canonicalMkdtemp("fg571-prov-");
  home = canonicalMkdtemp("fg571-prov-home-");
  source = await makeDisposableSourceRoot(repoRoot, home);
  relX = source.build({ outDir: join(workspace, "rel-x"), rand: "provxx" });
  shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });
  promote({ home, candidate: relX.releaseDir });
});

after(() => {
  for (const dir of [workspace, home]) {
    if (existsSync(dir)) {
      thawReleaseTree(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (source) removeDisposableSourceRoot(source);
});

test("FG-571 SAFETY: every path this suite touches derives from the disposable FORGE_HOME", () => {
  for (const p of [currentLinkIn(home), previousLinkIn(home), releasesDirIn(home), unitsDirIn(home)]) {
    assert.ok(p.startsWith(home), `${p} is inside the disposable forge home`);
  }
  assert.notEqual(source.root, repoRoot, "releases are built from a disposable checkout, not the real repository");
});

test("FG-571 F1 MUTANT (EXECUTED): the restored realpath-equality shortcut EXECS a hand-placed unit's bytes as the machine-wide forge", async () => {
  const id = "fg571-f1-mutant";
  const marker = join(workspace, "f1-mutant.marker");
  const attacker = attackerUnit("atk-f1-mutant", id, marker);
  // The attack: `releases/<id>` is pre-placed as a DIRECTORY SYMLINK at the attacker's unit.
  symlinkSync(attacker, join(releasesDirIn(home), id));

  const mutant = await mutantPromote("mutant-f1.mts", RESTORE_SHORTCUT);
  const r = mutant.promote({ home, candidate: id });
  assert.equal(r.id, id, "the vulnerable version PROMOTED the hand-placed unit — realpaths matched, so it selected it");

  // The marker so far only proves validation ran the loader. Clear it: from here, the file can
  // only be written by the SHIM's own exec of whatever `current` selects.
  rmSync(marker, { force: true });
  const ran = runProvenance();
  assert.equal(ran.status, 0, `the mutant's forge ran: ${ran.stderr}`);
  assert.equal(ran.prov.releaseId, id, "and the RUNNING process is the attacker's release");
  assert.ok(existsSync(marker), "THE FINDING, EXECUTED: the machine-wide forge exec'd the attacker's own bytes — a real process wrote this file");
  assert.equal(readFileSync(marker, "utf8"), "the attacker's bytes ran");

  rmSync(join(releasesDirIn(home), id), { force: true });
  promote({ home, candidate: relX.releaseDir });
});

test("FG-571 F1 CLOSED (EXECUTED): production REFUSES the hand-placed unit by name, and never execs its bytes", () => {
  const id = "fg571-f1-fixed";
  const marker = join(workspace, "f1-fixed.marker");
  const attacker = attackerUnit("atk-f1-fixed", id, marker);
  symlinkSync(attacker, join(releasesDirIn(home), id));
  rmSync(marker, { force: true });

  assert.throws(
    () => promote({ home, candidate: id }),
    /refusing to promote — forge has no record of publishing a release here/i,
    "a directory something else placed in the store is refused BY NAME — realpath equality is not provenance",
  );

  // The refusal is total: nothing was selected, and the attacker's bytes never ran.
  assert.equal(readSelection(home)?.manifest?.id, relX.manifest.id, "X is still selected");
  const ran = runProvenance();
  assert.equal(ran.status, 0, `X must still run after the refusal: ${ran.stderr}`);
  assert.equal(ran.prov.releaseId, relX.manifest.id, "the RUNNING process is still X");
  assert.ok(!existsSync(marker), "the attacker's bytes were never exec'd — no process wrote the marker");

  rmSync(join(releasesDirIn(home), id), { force: true });
});

test("FG-571 F2 (EXECUTED): promoting a BENIGN candidate whose id is already occupied never selects the incumbent and never deletes the validated staged unit", () => {
  const id = "fg571-f2-occupied";
  const marker = join(workspace, "f2.marker");
  // The attacker occupies the id first — a real directory this time, not a link.
  const incumbent = join(releasesDirIn(home), id);
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", incumbent, attackerUnit("atk-f2", id, marker)]);
  const incumbentBefore = independentTreeDigest(incumbent);

  // The operator promotes their own BENIGN release, which happens to carry that id.
  const benign = attackerUnit("benign-f2", id);
  rmSync(marker, { force: true });
  const r = promote({ home, candidate: benign });

  assert.equal(r.id, id, "the benign candidate promoted");
  assert.notEqual(realpathSync(r.releaseDir), realpathSync(incumbent), "THE F2 CLOSURE: it did NOT select the incumbent");
  assert.ok(r.releaseDir.startsWith(releasesDirIn(home)), "the freshly materialized unit was published inside the store, at a fresh immutable path");
  assert.ok(existsSync(join(r.releaseDir, RELEASE_MANIFEST_NAME)), "and the validated staged unit was published, not deleted");

  // The selected bytes are the ones forge materialized and froze — asserted from the RUNNING
  // process, and by the marker the incumbent's poisoned loader would have written.
  const ran = runProvenance();
  assert.equal(ran.status, 0, `the benign release must run: ${ran.stderr}`);
  assert.equal(ran.prov.releaseId, id);
  assert.equal(realpathSync(ran.prov.release.releaseDir ?? currentLinkIn(home)), realpathSync(r.releaseDir), "the process loaded the unit forge published, not the incumbent");
  assert.ok(!existsSync(marker), "the incumbent's bytes were never exec'd");

  // NEVER overwrite, repair, replace, rename, thaw, or delete a potentially retained unit.
  assert.ok(existsSync(incumbent), "the incumbent was not deleted");
  assert.equal(independentTreeDigest(incumbent), incumbentBefore, "and it is byte-for-byte untouched — an occupied id is not permission to rewrite what is there");

  promote({ home, candidate: relX.releaseDir });
});

test("FG-571 F2 MUTANT (EXECUTED): restore the occupied-id branch and the benign promotion selects the INCUMBENT's bytes, having deleted the unit it validated", async () => {
  const id = "fg571-f2-mutant";
  const marker = join(workspace, "f2-mutant.marker");
  const incumbent = join(releasesDirIn(home), id);
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", incumbent, attackerUnit("atk-f2-mutant", id, marker)]);
  const benign = attackerUnit("benign-f2-mutant", id);

  const mutant = await mutantPromote("mutant-f2.mts", RESTORE_OCCUPIED_ID_BRANCH);
  const r = mutant.promote({ home, candidate: benign });
  assert.equal(realpathSync(r.releaseDir), realpathSync(incumbent), "THE FINDING: validating the benign candidate authorized selection of DIFFERENT bytes");

  rmSync(marker, { force: true });
  const ran = runProvenance();
  assert.equal(ran.status, 0, `the mutant's forge ran: ${ran.stderr}`);
  assert.ok(existsSync(marker), "THE FINDING, EXECUTED: the machine-wide forge exec'd the INCUMBENT's bytes, which no promotion ever validated");

  promote({ home, candidate: relX.releaseDir });
});

test("FG-571 F3 (EXECUTED): rollback REFUSES a hand-placed `previous` by name — a pointer is not provenance", () => {
  const id = "fg571-f3-previous";
  const marker = join(workspace, "f3.marker");
  const attacker = attackerUnit("atk-f3", id, marker);

  // Two real promotions, so `previous` is genuinely recorded, then the attacker re-points it.
  promote({ home, candidate: relX.releaseDir });
  makePreviousResolveTo(attacker);
  assert.equal(readPrevious(home)?.manifest?.id, id, "the premise: `previous` resolves to the attacker's unit, which is a COMPLETE, VALID release");
  rmSync(marker, { force: true });

  assert.throws(
    () => rollback({ home }),
    /refusing to roll back — forge cannot vouch for the bytes the previous release points at/i,
    "rollback selects a unit only on forge's own durable record that it published those exact bytes",
  );

  const ran = runProvenance();
  assert.equal(ran.status, 0, `X must still run after the refused rollback: ${ran.stderr}`);
  assert.equal(ran.prov.releaseId, relX.manifest.id, "the RUNNING process is still X — the refusal moved nothing");
  assert.ok(!existsSync(marker), "and the attacker's bytes were never exec'd");
});

test("FG-571 F3 MUTANT (EXECUTED): remove the content binding and rollback EXECS bytes that were mutated after validation and before the swap", async () => {
  const id = "fg571-f3-mutant";
  const marker = join(workspace, "f3-mutant.marker");
  const attacker = attackerUnit("atk-f3-mutant", id);

  promote({ home, candidate: relX.releaseDir });
  makePreviousResolveTo(attacker);

  // THE F3 WINDOW, made concrete: the unit validates cleanly, and is then rewritten AFTER
  // validation returns and BEFORE the pointer swap. onBeforeSwap is production's own seam for
  // exactly that instant.
  const mutant = await mutantPromote("mutant-f3.mts", REMOVE_ROLLBACK_BINDING);
  const r = mutant.rollback({
    home,
    onBeforeSwap: () => {
      appendFileSync(join(attacker, RELEASE_LOADER_NAME), `\nimport { writeFileSync as __w2 } from "node:fs";\n__w2(${JSON.stringify(marker)}, "the attacker's bytes ran");\n`);
    },
  });
  assert.equal(r.id, id, "the vulnerable version rolled back onto it");
  assert.ok(!existsSync(marker), "the premise: the mutation landed AFTER validation ran the loader — nothing has exec'd the new bytes yet");

  const ran = runProvenance();
  assert.equal(ran.status, 0, `the mutant's forge ran: ${ran.stderr}`);
  assert.ok(existsSync(marker), "THE FINDING, EXECUTED: the shim exec'd bytes that never passed validation — the validate-to-select window");

  promote({ home, candidate: relX.releaseDir });
});

test("FG-571: a unit forge published IS re-selectable — by id and by its own path — on durable content-bound evidence, and rollback returns to it", () => {
  const relZ = source.build({ outDir: join(workspace, "rel-z"), rand: "provzz" });
  promote({ home, candidate: relX.releaseDir });
  const published = promote({ home, candidate: relZ.releaseDir });
  const unitDir = realpathSync(published.releaseDir);
  const bytes = independentTreeDigest(unitDir);

  // The FULL SHA-256, never truncated: this value is the whole of the claim "these are the
  // bytes forge froze", so a shortened one would trade it for nothing.
  const ev = JSON.parse(readFileSync(join(unitsDirIn(home), `${relZ.manifest.id}.json`), "utf8"));
  assert.equal(ev.dir, unitDir, "forge recorded the PHYSICAL directory it published");
  assert.match(ev.tree, /^[0-9a-f]{64}$/, "bound to the FULL sha256 of the unit's bytes — 64 hex chars, untruncated");

  // Re-promotion by id is a pointer operation onto the SAME unit — end-state (2).
  assert.equal(realpathSync(promote({ home, candidate: relX.releaseDir }).releaseDir), realpathSync(join(releasesDirIn(home), relX.manifest.id)), "re-promoting a published release by its build dir selects the unit already published for it");
  assert.equal(realpathSync(promote({ home, candidate: relZ.manifest.id }).releaseDir), unitDir, "and promoting by id selects that same unit");

  const back = rollback({ home });
  assert.equal(back.id, relX.manifest.id, "rollback returns to the unit the previous promotion published");
  const ran = runProvenance();
  assert.equal(ran.status, 0, `X must run after the rollback: ${ran.stderr}`);
  assert.equal(ran.prov.releaseId, relX.manifest.id, "asserted from the RUNNING process");

  // RETAINED AND UNTOUCHED throughout: still there, still byte-identical, still executable.
  assert.equal(independentTreeDigest(unitDir), bytes, "the retained unit is byte-for-byte what forge froze");
  const direct = spawnSync(join(unitDir, "forge"), ["release", "provenance", "--json"], { encoding: "utf8", env: shimEnv() });
  assert.equal(direct.status, 0, `the retained unit still executes: ${direct.stderr}`);
  assert.equal(JSON.parse(direct.stdout).release.id, relZ.manifest.id);
});

test("FG-571 MUTATION WINDOW: a published unit that is thawed and rewritten stops being selectable at EVERY entry point", () => {
  const relW = source.build({ outDir: join(workspace, "rel-w"), rand: "provww" });
  promote({ home, candidate: relW.releaseDir });
  promote({ home, candidate: relX.releaseDir });
  const unit = realpathSync(join(releasesDirIn(home), relW.manifest.id));

  // The freeze is a chmod, and whoever owns the directory can undo it. This is that: the unit
  // stays a COMPLETE, VALID release — it just is no longer the bytes forge froze.
  execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"', "sh", unit]);
  appendFileSync(join(unit, RELEASE_LOADER_NAME), `\n// rewritten after the freeze\n`);

  assert.throws(() => rollback({ home }), /cannot vouch for the bytes/i, "rollback refuses it — the content binding is what notices");
  assert.throws(() => promote({ home, candidate: relW.manifest.id }), /no record of publishing a release here/i, "and promoting it by id refuses too");

  // Promoting the release's own BUILD directory still works: the candidate is materialized
  // fresh, and the rewritten incumbent is left alone rather than selected or repaired.
  const r = promote({ home, candidate: relW.releaseDir });
  assert.notEqual(realpathSync(r.releaseDir), unit, "the rewritten unit was not selected");
  assert.ok(existsSync(join(unit, RELEASE_LOADER_NAME)), "and it was not deleted or repaired — a retained unit is never forge's to touch");
  assert.equal(runProvenance().prov.releaseId, relW.manifest.id, "what runs is the freshly materialized unit — asserted from the RUNNING process");

  promote({ home, candidate: relX.releaseDir });
});

test("FG-571: an internal symlink is refused at every promotion entry point, before anything reads or follows it", () => {
  const id = "fg571-symlink";
  const unit = attackerUnit("atk-symlink", id);
  // The classic: the loader the shim execs via --import, pointed out of the unit.
  rmSync(join(unit, RELEASE_LOADER_NAME), { force: true });
  symlinkSync(join(workspace, "outside-loader.mjs"), join(unit, RELEASE_LOADER_NAME));
  writeFileSync(join(workspace, "outside-loader.mjs"), `import "tsx";\n`);

  assert.throws(() => promote({ home, candidate: unit }), /refusing to promote — this release candidate holds a symbolic link/i, "promote-by-path stages it and refuses on the materialized bytes");

  symlinkSync(unit, join(releasesDirIn(home), id));
  assert.throws(() => promote({ home, candidate: id }), /no record of publishing a release here/i, "promote-by-id refuses it without ever reading it");
  rmSync(join(releasesDirIn(home), id), { force: true });

  makePreviousResolveTo(unit);
  assert.throws(() => rollback({ home }), /cannot vouch for the bytes/i, "and rollback refuses it");
  assert.equal(runProvenance().prov.releaseId, relX.manifest.id, "X still runs throughout");
});

test("FG-571: the first promotion into a fresh home publishes at the id and records it; `..` is not a promotable identity", () => {
  const fresh = canonicalMkdtemp("fg571-prov-first-");
  try {
    // A fresh home has no `previous` to roll back to, and nothing in its store to trust.
    assert.throws(() => rollback({ home: fresh }), /refusing to roll back — no previous release is recorded/i);
    assert.throws(() => promote({ home: fresh, candidate: relX.manifest.id }), /refusing to promote/i, "an empty store yields nothing promotable by id");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }

  // `..` matches the shim's identity charset perfectly and would address the forge home itself
  // as a release unit.
  const bogus = attackerUnit("atk-dotdot", "fg571-dotdot");
  const manifest = JSON.parse(readFileSync(join(bogus, RELEASE_MANIFEST_NAME), "utf8")) as ReleaseManifest;
  manifest.id = "..";
  writeFileSync(join(bogus, RELEASE_MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  assert.throws(() => promote({ home, candidate: bogus }), /does not state a usable identity/i, "`..` is refused as an identity");
});
