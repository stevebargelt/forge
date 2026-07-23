// FG-571 (FG-553 Child 4) — THE `current` POINTER: atomic promote + rollback.
//
// `current` resolves to $FORGE_HOME/releases/<id>. The machine-wide shim resolves it (once,
// physically) and execs the release's pinned interpreter; promotion is therefore a POINTER
// SWAP, and its atomicity is the whole safety property.
//
// THE POINTER IS THE PAIR (current, previous), NOT `current` ALONE — so it gets ONE commit
// point. `current` and `previous` are static links THROUGH $FORGE_HOME/selection, which
// names a directory holding the two release pointers; a promotion builds a fresh selection
// directory and renames it over `selection`. Swapping the two pointers independently is not
// atomic AS A PAIR whichever order it is done in: recording `previous` first and dying
// before the `current` swap leaves current=A, previous=A — a promotion that never happened,
// having destroyed the rollback target P it was recording; swapping `current` first and
// dying leaves previous naming P, two promotions back. Selection directories are retained,
// never recycled, for the same T9 reason releases are (below): a process resolves the chain
// physically at exec and stays anchored to what it found.
//
// ATOMIC means rename(2) of a temp symlink OVER `current` — NEVER unlink-then-symlink.
// The unlink form is not atomic and, worse, exposes a window in which there is NO current
// at all: every `forge` invocation landing in that window fails, and an interrupt inside
// it leaves the machine-wide forge permanently unselected. rename(2) over an existing
// path is atomic on POSIX: an invocation observes the old target or the new one, never
// neither (F27d).
//
// VALIDATE, THEN SWAP — in that order, always. A candidate is validated to the point of
// RUNNING its closure before the pointer moves, so a candidate that fails validation
// leaves the previously selected release selected and reports a refusal, never success
// (F26). Swapping first and validating after would promote a broken release and then
// truthfully report it broken — which is exactly the failure this ordering exists to
// prevent.
//
// SWAP AND RETAIN. Nothing here deletes a release or an interpreter, ever. T9 (settled by
// execution, uniform across ESM / CJS / native dlopen): a process anchors to a release at
// start and a pointer swap does not tear it, but DELETING a release with anchored live
// processes is fatal at its next lazy load — and better-sqlite3's dlopen at the first
// `new Database()` is forge's real hot path. So retention is not a courtesy; it is the
// invariant. There is no GC in this slice, automatic or otherwise: it waits for a proven
// anchored-process lifetime mechanism in a later ticket.
//
// Every path derives from `home` (default FORGE_HOME) — a test pointing FORGE_HOME at a
// mkdtemp dir cannot reach the operator's real ~/.forge/current or their live control plane.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FORGE_HOME, currentLinkIn, interpretersDirIn, previousLinkIn, releasesDirIn, selectionLinkIn, selectionsDirIn, unitsDirIn } from "../util/paths.js";
import {
  RELEASE_ENTRY_NAME,
  RELEASE_ENTRY_SOURCE,
  RELEASE_EXEC_NAME,
  RELEASE_LOADER_NAME,
  RELEASE_MANIFEST_NAME,
  assertDashboardClosure,
  assertReleaseCloses,
  freezeReleaseFiles,
  parseExecDescriptor,
  renderExecDescriptor,
  thawReleaseTree,
  type ReleaseManifest,
} from "./release.js";
import { isStoredInterpreter, probeInterpreter } from "./runtime-store.js";

/** A release identity is a plain token. The SAME rule the shim's fail-closed identity
 *  guard applies in shell (renderIdentityGuard) — an id that the shim would refuse at exec
 *  time must not be promotable in the first place. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The id is ALSO a path component — it addresses `releases/<id>` and its ledger entry — so
 *  the two names every filesystem reserves are refused on top of the shim's charset. `..`
 *  matches ID_PATTERN perfectly and would address the forge home ITSELF as a release unit. */
function isPromotableId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id) && id !== "." && id !== "..";
}

export type Selection = {
  releaseDir: string;
  /** null when the selected release's manifest is missing or unparseable — the release is
   *  THERE, we just cannot say what it is. Distinct from readSelection returning null
   *  (nothing is selected at all), the same distinction FG-569's locateReleaseManifest
   *  draws for the same reason: collapsing "cannot verify" into "not there" lets a caller
   *  quietly treat an unverifiable release as an absent one. */
  manifest: ReleaseManifest | null;
};

/** What `current` selects right now, or null when nothing is selected. The link is
 *  resolved PHYSICALLY (realpath) so the answer names the release itself, not the pointer
 *  — a caller asking "what is selected" wants the release. A dangling `current` reads as
 *  null rather than throwing: an unselected forge home is an ordinary state (nothing has
 *  been promoted yet), not an error.
 *
 *  A CORRUPT selection must not throw here. This is the recovery path: if a bad `current`
 *  made `promote` itself fail, the operator could not promote a good release OVER it —
 *  which would make the pointer that exists to be swappable un-swappable exactly when it
 *  most needs swapping. It reads as `manifest: null` instead, and the callers that need to
 *  know what a release IS (rollback's target, via validateCandidate) refuse it by name. */
export function readSelection(home: string = FORGE_HOME, link: string = currentLinkIn(home)): Selection | null {
  if (!existsSync(link)) return null;
  const releaseDir = realpathSync(link);
  const manifestPath = join(releaseDir, RELEASE_MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { releaseDir, manifest: null };
  try {
    return { releaseDir, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest };
  } catch {
    return { releaseDir, manifest: null };
  }
}

/** The previously selected release (what `forge release rollback` would select). */
export function readPrevious(home: string = FORGE_HOME): Selection | null {
  return readSelection(home, previousLinkIn(home));
}

export type Candidate = {
  releaseDir: string;
  manifest: ReleaseManifest;
  interpreter: string;
};

/** Require `rel` to resolve, inside `releaseDir`, to a REGULAR FILE that is PHYSICALLY
 *  contained in the release — no symlink at the leaf, and no symlinked component anywhere in
 *  the path escaping the release.
 *
 *  lstat, NOT stat, on the leaf: stat follows the link and would cheerfully report the
 *  attacker's file as a perfectly good regular file. And the realpath comparison covers the
 *  DIRECTORY components the leaf's lstat cannot see — a symlinked `src/` reaches outside the
 *  release with a leaf that is a genuine regular file at the far end.
 *
 *  The release root is canonicalized first so this compares like with like: a release under a
 *  symlinked component (macOS's /var -> /private/var) is not an escape, and refusing it would
 *  be an over-refusal that makes the whole check untrustworthy on a real host. What is
 *  refused is a component that escapes THIS release, not the existence of links above it. */
function assertContainedRegularFile(releaseDir: string, rel: string, what: string): void {
  const root = realpathSync(releaseDir);
  const expected = join(root, rel);
  let st: Stats;
  try {
    st = lstatSync(expected);
  } catch {
    throw new Error(
      `forge release: refusing to promote — this release is incomplete.\n` +
        `  release:      ${releaseDir}\n` +
        `  missing ${what}: ${expected}\n` +
        `A promoted release must be able to start; this one cannot.\n` +
        `Fix: rebuild with \`forge release build\`.`,
    );
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(
      `forge release: refusing to promote — this release's ${what} is not a regular file.\n` +
        `  release: ${releaseDir}\n` +
        `  ${what}: ${expected} (${st.isSymbolicLink() ? "a symlink" : st.isDirectory() ? "a directory" : "not a regular file"})\n` +
        `The ${what} is exec'd relative to the release root as the machine-wide forge, so it must be bytes ` +
        `this release physically contains. A link is precisely a thing whose target something outside the ` +
        `immutable closure can choose and change — which is the containment the closure exists to provide.\n` +
        `Fix: rebuild with \`forge release build\` (it dereferences every link into real bytes).`,
    );
  }
  const real = realpathSync(expected);
  if (real !== expected) {
    throw new Error(
      `forge release: refusing to promote — this release's ${what} escapes the release.\n` +
        `  release:   ${releaseDir}\n` +
        `  ${what}:   ${expected}\n` +
        `  resolves to: ${real}\n` +
        `A path component is a symlink pointing out of the release, so the ${what} exec'd as the ` +
        `machine-wide forge would be bytes from outside the immutable closure.\n` +
        `Fix: rebuild with \`forge release build\` (it dereferences every link into real bytes).`,
    );
  }
}

/** THE STAGED UNIT CONTAINS NO SYMLINKS, ANYWHERE — checked over the materialized bytes
 *  BEFORE anything else reads them, and before forge authors a descriptor into them.
 *
 *  WHY A LINK IS FATAL HERE. `tar -cf - . | tar -xf -` faithfully PRESERVES a symlink, so a
 *  candidate's link arrives intact in the staging tree. Every subsequent operation then
 *  follows it OUT of the unit: writeFileSync of the canonical descriptor writes forge's own
 *  trusted bytes to the attacker's file, parseExecDescriptor validates that same external
 *  file and passes, and the freeze chmods a file its planter still owns and can chmod back.
 *  The link survives publication, still pointing out — and after publication the attacker
 *  rewrites the target to name their own interpreter, which the shim then execs. The
 *  descriptor is only the sharpest instance: `forge-loader.mjs` is the identical attack via
 *  `--import`, as is anything the entry lazily loads out of `node_modules/`.
 *
 *  WHY REFUSE RATHER THAN DEREFERENCE. buildRelease already dereferences every link into
 *  real bytes, so a legitimate forge-built release contains ZERO symlinks and this costs it
 *  nothing. A candidate that holds one is therefore not forge-built or has been tampered
 *  with. Dereferencing here would "fix" it by pulling the attacker's bytes INTO the unit and
 *  publishing them as forge's own — laundering the payload rather than rejecting it. Refusing
 *  is fail-closed and compatible with every real release.
 *
 *  `ent.isSymbolicLink()` is checked BEFORE `ent.isDirectory()` — the latter is FALSE for a
 *  symlink-to-directory, so an ordering that tested for a directory first would descend into
 *  (or silently skip) a linked directory instead of refusing it. */
function assertNoSymlinks(root: string, dir: string = root): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(p);
      } catch {
        target = "(broken link — resolves nowhere)";
      }
      throw new Error(
        `forge release: refusing to promote — this release candidate holds a symbolic link.\n` +
          `  candidate: ${root}\n` +
          `  link:      ${p}\n` +
          `  points to: ${target}\n` +
          `  expected:  a real file or directory — a release carries bytes, never links\n` +
          `  found:     a symbolic link\n` +
          `A release unit is an IMMUTABLE, SELF-CONTAINED closure, and a link is neither: forge would ` +
          `follow it out of the unit when it authors the execution descriptor, when it validates the ` +
          `bytes, and when it freezes them — proving and freezing a file outside the release that its ` +
          `owner stays free to rewrite afterwards. \`forge release build\` dereferences every link into ` +
          `real bytes, so a candidate carrying one was not built by forge or was modified after it was.\n` +
          `Fix: rebuild with \`forge release build --out <dir>\` and promote that.`,
      );
    }
    if (ent.isDirectory()) assertNoSymlinks(root, p);
  }
}

/** BELT AND BRACES on the descriptor forge just authored: it must be a REGULAR, non-symlink
 *  file physically inside the staged unit. assertNoSymlinks already proves no link could have
 *  been there for the authoring write to follow, so this asserts that the write landed where
 *  forge meant it to land — checked before the bytes are validated and before they are frozen.
 *  The descriptor is the one file the shim treats as authority, so it gets the redundant
 *  check rather than the benefit of the doubt. */
function assertDescriptorIsContained(staging: string): void {
  const path = join(staging, RELEASE_EXEC_NAME);
  const st = lstatSync(path);
  const real = realpathSync(path);
  if (!st.isSymbolicLink() && st.isFile() && real === join(realpathSync(staging), RELEASE_EXEC_NAME)) return;
  throw new Error(
    `forge release: refusing to promote — this release's execution descriptor is not a real file inside the release.\n` +
      `  release:    ${staging}\n` +
      `  descriptor: ${path}\n` +
      `  resolves to: ${real}\n` +
      `  expected:   a regular file at ${join(staging, RELEASE_EXEC_NAME)}\n` +
      `  found:      ${st.isSymbolicLink() ? "a symbolic link" : st.isFile() ? "a regular file outside the release" : "not a regular file"}\n` +
      `The descriptor is the ONLY file the machine-wide shim reads, and forge authors it into the unit ` +
      `itself so that what the shim execs is what promotion validated. One that resolves anywhere else ` +
      `is a file forge does not own and cannot freeze.\n` +
      `Fix: rebuild with \`forge release build --out <dir>\` and promote that.`,
  );
}

/** VALIDATE a published/staged unit's CANONICAL EXECUTION DESCRIPTOR — the file the
 *  machine-wide shim will consume, and the only thing it consumes. Two claims:
 *   - the bytes have exactly the shape the shim enforces (exact field count, fixed order,
 *     fixed prefix, restricted character set) — checked here with the SAME rules, so a unit
 *     forge publishes can never be one the shim then refuses; and
 *   - the descriptor AGREES with the unit's own authoritative manifest. The manifest stays
 *     the authority on what the release IS; the descriptor is a derived, shim-readable
 *     projection of the two values that vary. A disagreement means the unit was not authored
 *     by this promotion, so it is refused by name rather than reconciled. */
function assertUnitDescriptor(unit: Candidate): void {
  const path = join(unit.releaseDir, RELEASE_EXEC_NAME);
  if (!existsSync(path)) {
    throw new Error(
      `forge release: refusing to select — this release carries no canonical execution descriptor.\n` +
        `  release:             ${unit.releaseDir}\n` +
        `  expected descriptor: ${path}\n` +
        `The machine-wide shim execs only what forge authored into the release unit at promotion — it ` +
        `never parses the release's manifest, because an sh reader and forge's JSON parser can disagree ` +
        `about what the same manifest says. A release promoted by an older forge carries no descriptor.\n` +
        `Fix: re-promote this release — \`forge release promote <dir|id>\` — which authors one.`,
    );
  }
  const parsed = parseExecDescriptor(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    throw new Error(
      `forge release: refusing to select — this release's execution descriptor is malformed.\n` +
        `  release:    ${unit.releaseDir}\n` +
        `  descriptor: ${path}\n` +
        `  problem:    ${parsed.reason}\n` +
        `Forge authors this file itself, so a descriptor that is not exactly what forge writes was not ` +
        `written by a forge promotion.\n` +
        `Fix: re-promote this release, or \`forge release rollback\` to the previous release.`,
    );
  }
  const want: [string, string, string][] = [
    ["interpreter", parsed.value.interpreter, unit.interpreter],
    ["release id", parsed.value.id, unit.manifest.id],
  ];
  for (const [field, got, expected] of want) {
    if (got !== expected) {
      throw new Error(
        `forge release: refusing to select — this release's execution descriptor and its manifest disagree.\n` +
          `  release:            ${unit.releaseDir}\n` +
          `  descriptor:         ${path}\n` +
          `  descriptor ${field}: ${JSON.stringify(got)}\n` +
          `  manifest ${field}:   ${JSON.stringify(expected)}\n` +
          `The manifest is the authority on what this release IS, and the descriptor is what the shim ` +
          `actually execs. A release whose two halves disagree is one where what forge validated and what ` +
          `the machine runs are different things — which is the entire failure this descriptor exists to ` +
          `make impossible.\n` +
          `Fix: re-promote this release, or \`forge release rollback\` to the previous release.`,
      );
    }
  }
}

/** THE COMPLETE UNIT GATE: everything validateCandidate proves about the bytes, PLUS the
 *  canonical descriptor. Applied to the STAGED unit before it is frozen and published, and
 *  applied again to an already-published unit before `current` is pointed at it — so the
 *  thing that gets selected is always the exact thing that was just validated. */
function validateUnit(dir: string, home: string): Candidate {
  const unit = validateCandidate(dir, home);
  assertUnitDescriptor(unit);
  return unit;
}

/** VALIDATE a candidate release to the point of RUNNING it. Every failure throws a named,
 *  actionable error in the FG-570 refusal style (what was wrong, where, what was running,
 *  how to fix) — never a bare false, because the caller's next move is to tell an operator.
 *
 *  The checks, and why each is a promotion gate rather than a runtime surprise:
 *   - the manifest PARSES and states a usable IDENTITY (FG571-RI: fail closed — a release that
 *     cannot state who it is does not run, so it does not get promoted either);
 *   - the interpreter is ABSOLUTE, present, and VALIDATED BY EXECUTION to report exactly
 *     the version+ABI the manifest names (validate-before-select: the manifest may
 *     reference only an already-validated interpreter);
 *   - the manifest is ABI-COHERENT with that interpreter (FG-570: the shipped binding
 *     loads under one ABI only);
 *   - that interpreter is IN THIS HOME'S STORE (FG-571's external-artifact contract): an
 *     external path validates identically today and is mutable tomorrow, so what a promotion
 *     proves about an unowned interpreter does not survive the next `brew upgrade node`. The
 *     store root is derived from `home` — the CONFIGURED forge home — and never from the
 *     candidate's own path, which would let a release vouch for its own interpreter (F4);
 *   - the entry and loader are PRESENT;
 *   - the CLOSURE RUNS — assertReleaseCloses executes the release's tsx loader AND loads
 *     its own better-sqlite3 binding under the pinned interpreter. This is what makes the
 *     "no mixed tree, no broken promotion" claim evidence rather than a file listing;
 *   - the DASHBOARD CLOSURE is present and CLAIMED (FG-580): the manifest states the
 *     `control-plane+dashboard` capability AND the release carries every required dashboard
 *     runtime file + dep. A promoted release must run `forge dashboard`, so a control-plane-only
 *     release (older forge) or one torn after build is refused before it can be selected. */
export function validateCandidate(dir: string, home: string = FORGE_HOME): Candidate {
  const releaseDir = resolve(dir);
  if (!existsSync(releaseDir)) {
    throw new Error(
      `forge release: refusing to promote — no release at ${releaseDir}.\n` +
        `Fix: build one with \`forge release build --out <dir>\`, or promote an installed release by id ` +
        `(\`forge release current\` lists what is selected).`,
    );
  }
  const manifestPath = join(releaseDir, RELEASE_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `forge release: refusing to promote — ${releaseDir} is not a release.\n` +
        `  expected manifest: ${manifestPath}\n` +
        `A release carries a ${RELEASE_MANIFEST_NAME} naming its interpreter, ABI, and identity. Without ` +
        `it forge cannot tell what promoting this directory would select.\n` +
        `Fix: promote a directory built by \`forge release build\`.`,
    );
  }
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  } catch (e) {
    throw new Error(
      `forge release: refusing to promote — this release's manifest is unreadable.\n` +
        `  release manifest: ${manifestPath}\n` +
        `  parse error:      ${(e as Error).message}\n` +
        `The manifest is the only authority on this release's identity, interpreter, and ABI. A manifest ` +
        `forge cannot parse states none of them, so promoting it would select a release forge cannot vouch for.\n` +
        `Fix: rebuild with \`forge release build\`, or promote a different release.`,
    );
  }

  // FG571-RI at the promotion gate: the shim fails closed on a missing/malformed identity at
  // exec time. Refusing here means the operator learns at `promote`, with the previous
  // release still selected, instead of at the next `forge` invocation with nothing usable.
  const id: unknown = manifest.id;
  if (!isPromotableId(id)) {
    throw new Error(
      `forge release: refusing to promote — this release does not state a usable identity.\n` +
        `  release manifest: ${manifestPath}\n` +
        `  manifest id:      ${id === undefined ? "(missing)" : JSON.stringify(id)}\n` +
        `Release identity comes solely from the manifest and is never read from the ambient environment, ` +
        `so a release that cannot state who it is cannot be promoted: every process it started would ` +
        `record unknown provenance, and the shim would refuse to exec it anyway.\n` +
        `Fix: rebuild with \`forge release build\` (it records \`id\`).`,
    );
  }

  // ENTRY CONTAINMENT. The shim execs `$here/$__forge_entry` — the manifest's entry joined to
  // the release root — so an entry of `../../outside.mjs` or `/tmp/evil.mjs` runs code OUTSIDE
  // the immutable closure as the machine-wide forge, defeating the containment the closure
  // exists to establish. assertReleaseCloses does NOT cover this: it runs the FIXED
  // RELEASE_ENTRY_SOURCE constant, never the manifest's claim, so a hand-built or tampered
  // candidate passes every other gate here and carries an attacker-chosen entry to exec.
  //
  // The architecture defines ONE canonical entry, so this is EXACT EQUALITY against the schema
  // constant — deliberately not realpath containment or path normalization. There is no
  // supported multi-entry case, so a looser rule would be more machinery and more attack
  // surface for zero capability; equality refuses missing, non-string, absolute, traversal, and
  // near-miss (`./src/cli/index.ts`, `src/cli/../cli/index.ts`, `src/cli/index.ts.evil`) alike.
  // The shim re-checks this independently: a release promoted by an older forge never passed here.
  const entry: unknown = manifest.entry;
  if (entry !== RELEASE_ENTRY_SOURCE) {
    throw new Error(
      `forge release: refusing to promote — this release names a non-canonical entry point.\n` +
        `  release manifest: ${manifestPath}\n` +
        `  expected entry:   ${RELEASE_ENTRY_SOURCE}\n` +
        `  manifest entry:   ${entry === undefined ? "(missing)" : JSON.stringify(entry)}\n` +
        `A release closes over exactly one entry point, and it is exec'd relative to the release ` +
        `root — so any other value would run code from outside the immutable release closure as the ` +
        `machine-wide forge, which is the containment the closure exists to provide.\n` +
        `Fix: rebuild with \`forge release build\` (it records the canonical entry).`,
    );
  }

  const interpreter = manifest.interpreter;
  if (typeof interpreter !== "string" || !isAbsolute(interpreter)) {
    throw new Error(
      `forge release: refusing to promote — this release does not pin an absolute interpreter.\n` +
        `  release manifest:     ${manifestPath}\n` +
        `  manifest interpreter: ${interpreter === undefined ? "(missing)" : JSON.stringify(interpreter)}\n` +
        `The whole point of the closure is to depend on NO PATH lookup: a release names the absolute ` +
        `interpreter its native binding was built against, or it does not run.\n` +
        `Fix: rebuild with \`forge release build\`.`,
    );
  }

  // VALIDATE BEFORE SELECT, by EXECUTION. `existsSync` proves a file is there; running it
  // proves it is the interpreter this release's binding needs.
  const got = probeInterpreter(interpreter);
  if (!got) {
    throw new Error(
      `forge release: refusing to promote — this release's pinned interpreter does not run.\n` +
        `  release:     ${releaseDir}\n` +
        `  interpreter: ${interpreter}\n` +
        `  expected:    node ${manifest.nodeVersion}, ABI ${manifest.abi}\n` +
        `It is missing, not executable, or did not report its version — so nothing can be promoted onto ` +
        `it: the machine-wide shim execs this exact path and never substitutes a node from PATH.\n` +
        `Fix: restore that interpreter at that exact path, or promote a release built against an ` +
        `interpreter this host has.`,
    );
  }
  if (got.version !== manifest.nodeVersion || got.abi !== manifest.abi) {
    throw new Error(
      `forge release: refusing to promote — this release's manifest and its interpreter disagree.\n` +
        `  release:     ${releaseDir}\n` +
        `  interpreter: ${interpreter}\n` +
        `  it reports:  node ${got.version}, ABI ${got.abi}\n` +
        `  manifest says: node ${manifest.nodeVersion}, ABI ${manifest.abi}\n` +
        `The release ships a native binding compiled for ABI ${manifest.abi}, and a binding loads under its ` +
        `own ABI only — so promoting this would hand the operator an opaque native-loader crash on the next ` +
        `command instead of a refusal now.\n` +
        `Fix: rebuild the release against the interpreter now at that path, or restore the interpreter it pins.`,
    );
  }

  // THE EXTERNAL-ARTIFACT CONTRACT, enforced at the gate that creates the reference's
  // consequences. Running and agreeing with the manifest proves what the interpreter IS
  // right now; neither proves it will STAY that. An interpreter outside the store is a
  // mutable external artifact — /usr/local/bin/node is rewritten in place by the next
  // `brew upgrade node`, and the release that pins it keeps exec'ing that path — so a
  // promotion that accepted one would hand back a release whose validation expires
  // silently, and retention (which is the whole T9 answer for anchored processes) would
  // protect the release directory while the thing that RUNS it moved underneath.
  // A store path cannot do that: the store is CONTENT-ADDRESSED and create-only, so a store
  // path names specific BYTES and those bytes never change under it — what validated here is
  // what runs later, or the path stops matching its own key and this gate refuses it.
  //
  // The trusted store root comes from the CONFIGURED home, never from the candidate's own
  // resolved path (FG-571 F4): a manifest that pins `/tmp/attacker/interpreters/node-.../bin/node`
  // would otherwise supply both the claim and the authority that vouches for it.
  const identity = { version: manifest.nodeVersion, abi: manifest.abi };
  if (!isStoredInterpreter(interpreter, identity, home)) {
    throw new Error(
      `forge release: refusing to promote — this release's interpreter is not in the interpreter store.\n` +
        `  release:      ${releaseDir}\n` +
        `  interpreter:  ${interpreter}\n` +
        `  store root:   ${interpretersDirIn(home)}\n` +
        `  expected form: <store-root>/node-${manifest.nodeVersion}-${manifest.abi}-<platform>-<arch>-<digest>/bin/node\n` +
        `It runs and it reports the version+ABI the manifest names, but it is not an entry this forge home's ` +
        `store owns and vouches for. Either it is an external path forge does not own — whatever installed it ` +
        `(a system package, homebrew, nvm) can rewrite those bytes in place while this release keeps exec'ing ` +
        `that path — or it sits at a store-shaped path whose name no longer matches the bytes actually there.\n` +
        `Promoting either would select a release whose validation expires silently, including under processes ` +
        `already anchored to it. The store exists to make that impossible: entries are named by their own ` +
        `content, published create-only, validated by execution before anything may reference them, and never ` +
        `replaced in place.\n` +
        `Fix: rebuild with \`forge release build\` — it installs its interpreter into the store and pins the ` +
        `store's copy.`,
    );
  }

  // ENTRY CONTAINMENT, THE HALF THE STRING CHECK CANNOT DO. The equality test above proves the
  // manifest NAMES the canonical entry; it says nothing about what that name RESOLVES TO on
  // disk. `src/cli/index.ts` as a symlink to /tmp/attacker.ts satisfies exact equality
  // perfectly and still execs attacker bytes as the machine-wide forge — as does a symlinked
  // `src/` or `src/cli/` component. The string check and this one are the two halves of the
  // same containment claim: the fixed entry must resolve to a REGULAR FILE that is PHYSICALLY
  // inside this release. The loader gets the identical treatment — the shim execs
  // `node --import $here/forge-loader.mjs`, so a linked loader runs attacker code just as
  // early and just as privileged.
  for (const [rel, what] of [
    [RELEASE_ENTRY_SOURCE, "entry"],
    [RELEASE_LOADER_NAME, "loader"],
    [RELEASE_ENTRY_NAME, "release entry script"],
  ] as const) {
    assertContainedRegularFile(releaseDir, rel, what);
  }

  // The closure RUNS: executes the release's own tsx loader and loads its own native
  // binding under the pinned interpreter. Throws a named torn-closure error (FG-569) if not.
  assertReleaseCloses(releaseDir, interpreter);

  // FG-580: the dashboard is a MANDATORY part of a promoted release. A candidate must both
  // CLAIM the dashboard capability in its manifest and actually CARRY the closure that backs
  // the claim — otherwise `forge release promote` could select a control-plane-only release
  // (built by an older forge) or a release torn after build (dashboard/src/server.ts, a
  // vendored client lib, or a dashboard dep removed), leaving the stable forge with no
  // working `forge dashboard`. Both halves are checked, for the same reason the entry check
  // has a string half and a bytes half: the manifest claim is what a reader trusts, and the
  // closure is what actually runs — a release where they disagree is exactly the mixed state
  // this gate exists to refuse.
  if (manifest.selfContainedFor !== "control-plane+dashboard") {
    throw new Error(
      `forge release: refusing to promote — this release does not claim the mandatory dashboard capability.\n` +
        `  release manifest:      ${manifestPath}\n` +
        `  manifest selfContainedFor: ${manifest.selfContainedFor === undefined ? "(missing)" : JSON.stringify(manifest.selfContainedFor)}\n` +
        `  expected:              "control-plane+dashboard"\n` +
        `A promoted release MUST bundle a working \`forge dashboard\` (FG-580, Option A). A release that ` +
        `does not state that capability was built by a forge that predates the dashboard bundle, so ` +
        `selecting it would leave the stable forge with no dashboard.\n` +
        `Fix: rebuild with \`forge release build\` from a source that includes dashboard/ and its vendored ` +
        `client libs (run scripts/vendor-dashboard-libs.mjs).`,
    );
  }
  assertDashboardClosure(releaseDir);

  return { releaseDir, manifest, interpreter };
}

/** Atomically point `link` at `target`: create a temp symlink beside it and rename(2) it
 *  over. NEVER unlink-then-symlink — that is not atomic and exposes a window with NO
 *  pointer at all, in which every `forge` invocation fails and an interrupt leaves the
 *  machine-wide forge permanently unselected. The temp lives in the same directory so the
 *  rename stays within one filesystem (rename(2) across filesystems is EXDEV, and a
 *  fallback copy would not be atomic).
 *
 *  Exported because the FG-571 suites swap pointers by hand to stage mutants, and they must
 *  do it with THIS primitive rather than a shell `mv`: `current` is a symlink to a
 *  directory, so a bare `mv` moves the new link INSIDE the target, and GNU's `mv -T` fix is
 *  not portable (BSD/macOS mv has no -T). rename(2) replaces a symlink in place everywhere. */
export function atomicSymlinkSwap(target: string, link: string): void {
  const tmp = `${link}.swap-${Math.random().toString(36).slice(2, 8)}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, link);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Realpath containment: is `child` at, or physically inside, `parent`? BOTH are
 *  canonicalized (realpath), so a home under a symlinked component (macOS
 *  /var → /private/var) is not misread as an escape, and — the follow-safe part —
 *  a destination that IS a symlink, or has any symlinked path COMPONENT, resolving
 *  outside `parent` is caught: realpath follows every link, so the compared string
 *  is the physical target, never the replaceable pointer. For a `child` that does
 *  not exist yet, the nearest existing ancestor is canonicalized and the remainder
 *  appended, so a symlinked ancestor still counts as an escape.
 *
 *  Exported so FG-583's seed publication reuses THIS containment vocabulary rather
 *  than inventing a second one. (An irreducible sub-microsecond same-UID swap of a
 *  path component AFTER this check and BEFORE the write — the FG-604 class — is not
 *  closed here; closing the realistic pre-existing-symlink case is.) */
export function realpathContains(parent: string, child: string): boolean {
  let p: string;
  let c: string;
  try {
    p = realpathSync(parent);
  } catch {
    p = resolve(parent);
  }
  try {
    c = realpathSync(child);
  } catch {
    c = resolve(child);
    let probe = c;
    while (probe !== resolve(probe, "..")) {
      if (existsSync(probe)) {
        c = join(realpathSync(probe), relative(probe, c));
        break;
      }
      probe = resolve(probe, "..");
    }
  }
  return c === p || c.startsWith(`${p}${sep}`);
}

/** Where `current` and `previous` point once a home is linked through `selection`. Relative,
 *  so the chain resolves from the home itself and a home that is moved or bind-mounted at a
 *  different path still resolves. */
const CURRENT_VIA_SELECTION = join("selection", "current");
const PREVIOUS_VIA_SELECTION = join("selection", "previous");

/** Publish a (current, previous) PAIR: build a fresh selection directory holding both
 *  pointers and rename(2) `selection` over — ONE swap, both pointers. */
function writeSelection(home: string, current: string | null, previous: string | null): void {
  const dir = join(selectionsDirIn(home), `sel-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(dir, { recursive: true });
  if (current) symlinkSync(current, join(dir, "current"));
  if (previous) symlinkSync(previous, join(dir, "previous"));
  atomicSymlinkSwap(dir, selectionLinkIn(home));
}

function isLinkedThroughSelection(home: string): boolean {
  const reads = (link: string, expected: string) => {
    try {
      return lstatSync(link).isSymbolicLink() && readlinkSync(link) === expected;
    } catch {
      return false;
    }
  };
  return reads(currentLinkIn(home), CURRENT_VIA_SELECTION) && reads(previousLinkIn(home), PREVIOUS_VIA_SELECTION);
}

/** Bring a home onto the selection layout WITHOUT changing what it selects. Every swap here
 *  replaces a pointer with one that resolves to the SAME release (or to nothing, where there
 *  was nothing), so an interrupt at any point inside this migration leaves the home selecting
 *  exactly what it selected before — which is what lets the caller treat the single
 *  writeSelection that follows as the whole transition. */
function ensureSelectionLayout(home: string): void {
  if (isLinkedThroughSelection(home)) return;
  writeSelection(home, readSelection(home)?.releaseDir ?? null, readPrevious(home)?.releaseDir ?? null);
  atomicSymlinkSwap(CURRENT_VIA_SELECTION, currentLinkIn(home));
  atomicSymlinkSwap(PREVIOUS_VIA_SELECTION, previousLinkIn(home));
}

export type InstallReleaseOptions = {
  home?: string;
  dir: string;
  /** Test seam: fires after the unit is fully staged, validated, descriptor-authored and
   *  FROZEN, but BEFORE the atomic rename that makes it addressable by id — the F27a
   *  interruption window. Never set in production. */
  onBeforeCommit?: () => void;
};

/** Read the candidate's identity — THE ONE PARSE OF CALLER-CONTROLLED BYTES anywhere on this
 *  path, and deliberately narrow: the id is used ONLY to address the store (which unit path
 *  this candidate is asking for), never to decide anything about what runs. Everything that
 *  governs execution is parsed and validated later, from the MATERIALIZED bytes.
 *
 *  Reading it up front rather than after materialization is what makes re-promoting an
 *  already-installed id a pointer operation instead of a pointless full re-copy of the
 *  closure — and the id read here is checked against the STAGED manifest's id before
 *  anything is published, so a candidate that mutates its identity mid-copy is refused
 *  rather than silently landing at the path it named first. */
function readCandidateId(source: string): string {
  const manifestPath = join(source, RELEASE_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `forge release: refusing to promote — ${source} is not a release.\n` +
        `  expected manifest: ${manifestPath}\n` +
        `A release carries a ${RELEASE_MANIFEST_NAME} naming its interpreter, ABI, and identity. Without it ` +
        `forge cannot tell what promoting this directory would select.\n` +
        `Fix: promote a directory built by \`forge release build\`.`,
    );
  }
  let id: unknown;
  try {
    ({ id } = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest);
  } catch (e) {
    throw new Error(
      `forge release: refusing to promote — this release's manifest is unreadable.\n` +
        `  release manifest: ${manifestPath}\n` +
        `  parse error:      ${(e as Error).message}\n` +
        `The manifest is the only authority on this release's identity, interpreter, and ABI. A manifest ` +
        `forge cannot parse states none of them, so promoting it would select a release forge cannot vouch for.\n` +
        `Fix: rebuild with \`forge release build\`, or promote a different release.`,
    );
  }
  if (!isPromotableId(id)) {
    throw new Error(
      `forge release: refusing to promote — this release does not state a usable identity.\n` +
        `  release manifest: ${manifestPath}\n` +
        `  manifest id:      ${id === undefined ? "(missing)" : JSON.stringify(id)}\n` +
        `The store is keyed by identity, so a release with none has nowhere to go.\n` +
        `Fix: rebuild with \`forge release build\` (it records \`id\`).`,
    );
  }
  return id;
}

/** THE CONTENT BINDING: a full SHA-256 over the unit's ENTIRE tree — every path, every
 *  regular file's complete bytes, and its executable bit — in one stable order.
 *
 *  FULL DIGEST, never truncated, for the same reason the interpreter store's key commits to
 *  the whole hash: this value is the ONLY thing standing between "these are the bytes forge
 *  froze" and "these are bytes something else put here", so shortening it trades that claim
 *  for nothing. The interior file digests are full too — a truncated leaf would let a
 *  substituted file collide under a full-width root.
 *
 *  EVERY file, not a security-critical subset. F3's window is not about `forge-exec` alone:
 *  `forge-loader.mjs`, `src/cli/index.ts`, and anything the entry lazily loads out of
 *  `node_modules/` are all exec'd as the machine-wide forge, so a binding that covered only
 *  the descriptor would prove the one file an attacker has least need to touch.
 *
 *  Names AND shape are hashed, not just contents: a bare concatenation of file digests would
 *  be identical for two trees that renamed a file across each other, and a `D` record for
 *  every directory means an added or removed empty directory changes the digest too.
 *
 *  Symlinks and non-regular entries THROW rather than hash: assertNoSymlinks has already run
 *  over anything this digests, so reaching one means the tree changed underneath — and a
 *  digest that silently skipped it would certify a unit around the file that was hiding. */
function treeDigest(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, ent.name);
      const r = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isSymbolicLink() || !(ent.isDirectory() || ent.isFile())) {
        throw new Error(
          `forge release: refusing to bind this release unit to its contents — it holds an entry that is not a file or a directory.\n` +
            `  unit:  ${root}\n` +
            `  entry: ${p}\n` +
            `A unit carries bytes, never links or devices, and the content binding must cover everything the ` +
            `unit contains or it would vouch for a tree around the entry it could not describe.`,
        );
      }
      if (ent.isDirectory()) {
        h.update(`D ${r}\n`);
        walk(p, r);
        continue;
      }
      h.update(`F ${r} ${lstatSync(p).mode & 0o111 ? "x" : "-"} ${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** FORGE'S OWN RECORD that it published a unit: which directory, and the digest of the bytes
 *  it froze there. This is the PROVENANCE the audit says a location cannot supply — store
 *  residency, pathname equality, release id, existence and permissions are all things a
 *  hand-placed directory has too, and none of them is evidence that forge made it. */
type UnitEvidence = { schema: 1; dir: string; tree: string };

/** The ledger entry for a published unit, keyed by its DIRECTORY NAME rather than by the
 *  manifest's id: the id is a claim the unit makes about itself, and a lookup keyed on it
 *  would let a unit choose which record vouches for it. Every unit directory forge publishes
 *  sits directly in `releases/`, so its basename is already unique there. */
function unitEvidencePath(home: string, unitDirName: string): string {
  return join(unitsDirIn(home), `${unitDirName}.json`);
}

/** RECORD a publication — CREATE-ONLY (`wx`) and atomic (write beside, rename over).
 *
 *  Create-only is the point: a ledger forge would overwrite is one an attacker can make forge
 *  overwrite, and re-pointing an existing id's evidence at fresh bytes is precisely how a
 *  retained release would lose the record of what it actually is. An occupied entry is never
 *  rewritten — the caller publishes at a fresh name instead. */
function writeUnitEvidence(home: string, unitDirName: string, ev: UnitEvidence): void {
  const dir = unitsDirIn(home);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${unitDirName}.json.writing-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(ev, null, 2)}\n`, { flag: "wx" });
    renameSync(tmp, unitEvidencePath(home, unitDirName));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read forge's record for a unit directory, or null when forge has none — which is the
 *  ordinary answer for a hand-placed directory AND for a unit published by a forge that
 *  predates the ledger. Both are "cannot vouch", and every caller treats them as such. */
function readUnitEvidence(home: string, unitDirName: string): UnitEvidence | null {
  const p = unitEvidencePath(home, unitDirName);
  if (!existsSync(p)) return null;
  try {
    const ev = JSON.parse(readFileSync(p, "utf8")) as UnitEvidence;
    if (ev?.schema !== 1 || typeof ev.dir !== "string" || typeof ev.tree !== "string") return null;
    return ev;
  } catch {
    return null;
  }
}

/** IS the directory at `dir` the exact unit forge published and froze there?
 *
 *  THE THREE CLAIMS, and none of them is about location:
 *   - forge HAS a record for this directory name (a hand-placed unit has none);
 *   - the record names THIS PHYSICAL directory — realpath, so `releases/<id>` turned into a
 *     symlink at an attacker's unit resolves somewhere the record does not name and fails
 *     here rather than being followed; and
 *   - the bytes ACTUALLY THERE hash to what forge recorded when it froze them.
 *
 *  The third is what makes this content-bound rather than another assumption from location:
 *  the freeze is a chmod, so a unit's owner can thaw and rewrite it, and this is the check
 *  that notices. */
function isFrozenPublishedUnit(home: string, dir: string): boolean {
  const ev = readUnitEvidence(home, basename(dir));
  if (!ev) return false;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  if (ev.dir !== real) return false;
  try {
    return treeDigest(real) === ev.tree;
  } catch {
    return false;
  }
}

/** MATERIALIZE a release into $FORGE_HOME/releases/<id> as a COMPLETE, VALIDATED, FROZEN
 *  UNIT — and return the unit that is now published there.
 *
 *  THE INVARIANT, in order, and the order IS the safety property:
 *
 *    candidate input -> trusted materialization -> parse and validate STAGED bytes ->
 *    generate canonical descriptor -> validate complete unit -> freeze ->
 *    atomic publication
 *
 *  A CALLER-CONTROLLED CANDIDATE DIRECTORY IS NEVER PROMOTED IN PLACE. The old shape
 *  validated the candidate and then copied it — so the bytes that got validated and the bytes
 *  that got installed were read at two different instants, and a candidate mutated in between
 *  shipped unvalidated. Worse, when the candidate already sat at its store path the copy was
 *  skipped entirely and re-validation with it, leaving a clean validate-to-swap window. Both
 *  are the same defect: validating one thing and selecting another. Materializing FIRST and
 *  validating the materialized bytes closes it structurally — what is validated, frozen, and
 *  renamed is one directory, and nothing else is ever a candidate for selection.
 *
 *  AN OCCUPIED ID IS NOT A REASON TO TRUST WHAT OCCUPIES IT, AND NOT A REASON TO TOUCH IT.
 *  Two shortcuts used to live here, and both were the same defect wearing different clothes:
 *  `realpath(target) === realpath(source)` skipped materialization entirely (so nothing ever
 *  ran the no-symlink gate over the bytes about to be selected), and `existsSync(target)`
 *  DELETED the freshly validated staged unit and selected whatever already sat at the id
 *  instead. Store residency, pathname equality, the id, existence, and permissions are not
 *  provenance — a directory hand-placed under `releases/` has every one of them. So this
 *  materializes, ALWAYS, and selects only bytes it can vouch for:
 *
 *   - the id is FREE → publish the fresh frozen unit there and record it (end-state 1);
 *   - the id is occupied by a unit forge's OWN LEDGER proves it published and froze, whose
 *     bytes still hash to what was recorded, and which is byte-for-byte the unit just
 *     materialized → select that unit, discard the twin (end-state 2). Not a shortcut: the
 *     candidate was still fully materialized and validated, and the reuse rests on durable
 *     content-bound evidence rather than on the id being taken;
 *   - anything else — no record, a record naming somewhere else, or bytes that no longer
 *     hash to it → publish the fresh frozen unit at a FRESH immutable path and select THAT.
 *
 *  The incumbent is NEVER overwritten, repaired, renamed, thawed, or deleted in any of the
 *  three: a retained release that loses its bytes is fatal to every process anchored to it
 *  (T9), and an occupied id is not permission to do that to whatever is there.
 *
 *  Staging → validate → freeze → rename(2) into the keyed path: an interrupted install leaves
 *  only an `.installing-*` dir, which is not an id any pointer names and which promotion never
 *  resolves, so NOTHING partial is selectable (F27a).
 *
 *  The copy goes through `tar`, not cpSync: a built release is FROZEN (write bits cleared on
 *  every file AND directory, FG-569 Finding 3), and a recursive copy that recreated those
 *  directories mode-first would be unable to write their contents. */
/** Does the operator's candidate name a path in THIS home's store namespace? Lexical, on the
 *  path as given — the question is whether forge's own store is what was named, and a realpath
 *  would answer a different one (a `releases/<id>` symlink pointing at /tmp/attacker resolves
 *  outside the store while being addressed squarely inside it). */
function isInsideStore(home: string, dir: string): boolean {
  const releases = resolve(releasesDirIn(home));
  return dir === releases || dir.startsWith(`${releases}${sep}`);
}

export function installRelease(opts: InstallReleaseOptions): Candidate {
  const home = opts.home ?? FORGE_HOME;
  const source = resolve(opts.dir);

  // THE CANDIDATE IS ADDRESSED INSIDE FORGE'S OWN STORE — `forge release promote <id>`, or a
  // path written straight at `releases/`. There is nothing to materialize FROM: the store is
  // not a place operators build releases, it is the place forge publishes them, so the only
  // honest reading of this request is "select the unit you published there". Forge answers it
  // from its own durable record or not at all (end-state 2).
  //
  // MATERIALIZING IT INSTEAD WOULD BE THE LAUNDERING VERSION of the same bug: the id namespace
  // is addressed by a value out of a candidate's own manifest, so anyone who can write the
  // store can plant `releases/<id>` — or point it at their own unit — and wait for the
  // operator to type that id. Copying those bytes into a unit forge freezes and vouches for
  // would publish the attacker's release as forge's own. A store path is not provenance, and
  // neither is the fact that the bytes there validate.
  if (isInsideStore(home, source)) {
    if (!isFrozenPublishedUnit(home, source)) {
      throw new Error(
        `forge release: refusing to promote — forge has no record of publishing a release here.\n` +
          `  candidate:      ${source}\n` +
          `  forge's record: ${unitEvidencePath(home, basename(source))}\n` +
          `  store root:     ${releasesDirIn(home)}\n` +
          `This path is inside forge's own release store, so promoting it can only mean "select the unit ` +
          `forge published there" — the store is where forge publishes releases, not somewhere releases are ` +
          `built. Forge holds no record that it materialized, validated, froze, and published a unit at this ` +
          `exact directory, the record names a different one, or the bytes no longer match what it froze. So ` +
          `this is a directory something else placed in the store, a unit published by a forge too old to ` +
          `record one, or one that has been modified since. Being in the store, carrying a release id, and ` +
          `validating are not evidence that forge made it.\n` +
          `Fix: promote the release directory itself — \`forge release promote <dir>\` — and forge will ` +
          `materialize, validate, freeze, and record it.`,
      );
    }
    return validateUnit(source, home);
  }

  const claimedId = readCandidateId(source);
  const releases = releasesDirIn(home);
  const target = join(releases, claimedId);

  mkdirSync(releases, { recursive: true });
  const staging = join(releases, `.installing-${claimedId}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(staging, { recursive: true });
    const copy = spawnSync("/bin/sh", ["-c", 'tar -C "$1" -cf - . | tar -C "$2" -xf -', "sh", source, staging], { encoding: "utf8" });
    if (copy.status !== 0) {
      throw new Error(`forge release: cannot install the release at ${source} into ${target} — ${copy.stderr?.trim() || `tar exited ${copy.status}`}`);
    }
    // NO LINKS, BEFORE ANYTHING FOLLOWS ONE. tar preserves symlinks, so this runs on the
    // materialized bytes FIRST — before the thaw, before the bytes are read, and above all
    // before forge authors the descriptor, because the authoring write would follow a link
    // out of the unit and hand its trusted output to whoever owns the target.
    assertNoSymlinks(staging);

    // The candidate was frozen, so the copy arrives frozen and the descriptor could not be
    // written into it. Thaw the STAGING tree only — it is forge's own scratch, not yet a
    // release, and it is re-frozen below before anything can address it.
    thawReleaseTree(staging);

    // PARSE AND VALIDATE THE STAGED BYTES — never the mutable source. Everything downstream
    // reads from this one materialization: the identity, the interpreter binding, the entry,
    // the loader, and the closure that actually runs.
    const staged = validateCandidate(staging, home);
    if (staged.manifest.id !== claimedId) {
      throw new Error(
        `forge release: refusing to install — this release's identity changed while it was being copied.\n` +
          `  candidate:  ${source}\n` +
          `  it claimed: ${JSON.stringify(claimedId)}\n` +
          `  it copied as: ${JSON.stringify(staged.manifest.id)}\n` +
          `The store is keyed by identity and the destination was chosen from the first read, so a candidate ` +
          `whose identity moved underneath the copy would be published at a path that does not describe it.\n` +
          `Fix: promote a release directory that is not being written to.`,
      );
    }

    // GENERATE the canonical, forge-authored execution descriptor INSIDE the staged unit,
    // AFTER validation — so it can only ever carry an interpreter that was proven to run, to
    // agree with the manifest's ABI, and to live in the immutable store.
    writeFileSync(join(staging, RELEASE_EXEC_NAME), renderExecDescriptor({ interpreter: staged.interpreter, id: staged.manifest.id }));
    assertDescriptorIsContained(staging);

    // VALIDATE THE COMPLETE UNIT: the staged bytes plus the descriptor that now ships with
    // them, under exactly the rules the shim will apply.
    const unit = validateUnit(staging, home);

    // FREEZE the complete unit, THEN bind it to its contents. The digest is taken over the
    // bytes that were just validated and frozen — the same directory, in the same call — so
    // what the ledger records below is what this promotion actually proved.
    freezeReleaseFiles(staging);
    const tree = treeDigest(staging);

    // REUSE, on durable content-bound evidence and nothing else (end-state 2). All three
    // claims must hold: forge's own ledger says it published and froze a unit at this exact
    // physical directory, the bytes there STILL hash to what it recorded (the freeze is a
    // chmod, so this is what notices a thawed-and-rewritten unit), and that digest is the one
    // this promotion just materialized and validated. Then the incumbent IS this unit, and
    // selecting it selects the bytes that were validated. The staged twin is forge's own
    // scratch and is byte-identical by the digest above, so discarding it discards nothing.
    if (isFrozenPublishedUnit(home, target) && readUnitEvidence(home, claimedId)?.tree === tree) {
      spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", staging]);
      rmSync(staging, { recursive: true, force: true });
      return validateUnit(target, home);
    }

    // PUBLISH the freshly frozen unit and select THAT (end-state 1). It goes to the id when
    // the id is free and forge holds no record there; otherwise to a FRESH immutable path,
    // because the incumbent is a unit forge cannot vouch for and MUST NOT touch — it may be
    // retained bytes some live process is anchored to (T9), and it is never this promotion's
    // to overwrite, repair, or delete. `.unit-` is the same unaddressable-by-a-pointer shape
    // `.installing-` uses.
    const free = !existsSync(target) && !readUnitEvidence(home, claimedId);
    const dir = free ? target : join(releases, `.unit-${claimedId}-${Math.random().toString(36).slice(2, 8)}`);

    opts.onBeforeCommit?.();
    renameSync(staging, dir);
    // AFTER the rename, never before: evidence that named a directory the interrupted rename
    // never created would vouch for a path forge did not publish. An interrupt in the other
    // order leaves a unit with no record — which every reader treats as "cannot vouch", so
    // the next promotion publishes fresh rather than trusting it.
    writeUnitEvidence(home, basename(dir), { schema: 1, dir: realpathSync(dir), tree });
    return { ...unit, releaseDir: dir };
  } catch (e) {
    // A frozen tree's read-only directories defeat a recursive unlink; force the write bit
    // back on the staging tree (never on a published release) so a failed install leaves
    // nothing behind.
    spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", staging]);
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

export type PromoteOptions = {
  home?: string;
  /** A release directory, or the id of a release already in the store. */
  candidate: string;
  /** Test seam: fires after validation + install but BEFORE the atomic pointer swap — the
   *  F27d interruption window. Never set in production. */
  onBeforeSwap?: () => void;
};

export type PromoteResult = {
  id: string;
  releaseDir: string;
  interpreter: string;
  abi: string;
  nodeVersion: string;
  /** The release that WAS selected — what `forge release rollback` will return to. null
   *  when this is the first promotion into this forge home. Never manufactured: `id` is
   *  null when the superseded release's own manifest could not state one, because "not
   *  recorded" is the honest answer there and a guess would be worse than a gap. */
  previous: { id: string | null; releaseDir: string } | null;
};

/** Resolve `<dir|id>` to a directory: an existing path is taken as-is, anything else is an
 *  id in the store. */
function resolveCandidateDir(home: string, candidate: string): string {
  if (existsSync(candidate) && lstatSync(candidate).isDirectory()) return resolve(candidate);
  return join(releasesDirIn(home), candidate);
}

/** PROMOTE: materialize → validate the staged unit → author its descriptor → validate the
 *  complete unit → freeze → publish atomically → ONE atomic swap that selects the release
 *  AND records what it superseded. In that order.
 *
 *  ONE SWAP, and the descriptor rides INSIDE the unit it describes. A separately-published
 *  sibling record next to `current` is forbidden: a record swap plus a pointer swap is not
 *  atomic AS A PAIR, so it would create exactly the selection/description mismatch window the
 *  descriptor exists to close. Because the descriptor ships inside the immutable unit, this
 *  single rename(2) selects the release AND its descriptor together and there is nothing left
 *  that could desynchronize.
 *
 *  A candidate that fails ANY gate throws rather than returning, so no caller can report
 *  success for it and the previously selected release stays selected (F26).
 *
 *  Nothing is deleted. The superseded release stays exactly where it is, because processes
 *  anchored to it are still using it and will die at their next lazy native load if it goes
 *  away (T9). */
export function promote(opts: PromoteOptions): PromoteResult {
  const home = opts.home ?? FORGE_HOME;
  const dir = resolveCandidateDir(home, opts.candidate);
  if (!existsSync(dir)) {
    throw new Error(
      `forge release: refusing to promote — no release at ${dir}.\n` +
        `Fix: build one with \`forge release build --out <dir>\`, or promote an installed release by id ` +
        `(\`forge release current\` lists what is selected).`,
    );
  }

  // The complete pipeline: nothing caller-controlled is validated, and nothing validated is
  // left mutable. What comes back is a frozen unit at its final, immutable store path.
  const selected = installRelease({ home, dir });

  const before = readSelection(home);

  mkdirSync(home, { recursive: true });
  ensureSelectionLayout(home);

  opts.onBeforeSwap?.();
  // ONE swap publishes `current` AND the `previous` it supersedes. Recording `previous`
  // in a swap of its own — in either order — is not atomic AS A PAIR: a kill between the
  // two leaves `current=A, previous=A`, a promotion that never happened having destroyed
  // the rollback target it was in the middle of recording.
  writeSelection(home, selected.releaseDir, before?.releaseDir ?? null);

  return {
    id: selected.manifest.id,
    releaseDir: selected.releaseDir,
    interpreter: selected.interpreter,
    abi: selected.manifest.abi,
    nodeVersion: selected.manifest.nodeVersion,
    previous: before ? { id: before.manifest?.id ?? null, releaseDir: before.releaseDir } : null,
  };
}

export type RollbackOptions = {
  home?: string;
  /** Test seam: the F27d interruption window on the rollback path. Never set in production. */
  onBeforeSwap?: () => void;
};

/** ROLLBACK: an atomic pointer swap back to the COMPLETE prior release — the same rename(2)
 *  mechanism as promote, and the same validation. The prior release is re-validated (its
 *  closure RUN) rather than trusted: it was complete when it was promoted, but the
 *  interpreter it pins lives outside the closure and time has passed.
 *
 *  Nothing is deleted here either. `previous` and `current` exchange targets, so a rollback
 *  can be rolled forward.
 *
 *  THE FG-568 ONE-WAY BOUNDARY IS NOT OBSERVABLE FROM HERE — stated, not papered over.
 *  BD-15 makes the destructive convergence migration (`forge store converge`) a one-way
 *  boundary that bounds rollback: a release promoted BEFORE it cannot be rolled back to
 *  AFTER it and still trust the store. Deciding that here would need two facts. The store's
 *  side IS observable (the boundary is stamped in `user_version`). The release's side is
 *  NOT: nothing records a release's UNDERSTOOD schema version — not the FG-569 manifest,
 *  which carries no such field, and not any CLI surface (`forge store` exposes only
 *  `converge`). So this module cannot tell whether a rollback target predates the boundary,
 *  and inventing a manifest field or a probe command to find out is a contract change, not
 *  this ticket's work. What EXISTS instead, one level down: FG-568's forward gate
 *  (assertSchemaVersionSupported) makes any FG-568-or-later target refuse a post-boundary
 *  store BY NAME on its first open — so the crossing is refused, just by the release rather
 *  than by the promoter. Only a PRE-FG-568 target is unprotected, and that is precisely the
 *  HONEST LIMIT FG-568 already owns and records: a gate cannot be retrofitted into an
 *  already-installed binary. */
export function rollback(opts: RollbackOptions = {}): PromoteResult {
  const home = opts.home ?? FORGE_HOME;
  const previous = readPrevious(home);
  if (!previous) {
    throw new Error(
      `forge release: refusing to roll back — no previous release is recorded.\n` +
        `  previous pointer: ${previousLinkIn(home)}\n` +
        `  current:          ${readSelection(home)?.manifest?.id ?? "(nothing selected)"}\n` +
        `Rollback returns to the release that was selected before the last promotion; this forge home has ` +
        `not promoted over one.\n` +
        `Fix: promote the release you want explicitly — \`forge release promote <dir|id>\`.`,
    );
  }

  // ROLLBACK IS THE HARD CASE, AND THIS IS THE HONEST ANSWER TO IT. There is no source to
  // materialize from: rollback selects a unit some earlier promotion published, so end-state
  // (1) is not available to it and it runs on end-state (2) — durable content-bound evidence,
  // then the complete unit gate.
  //
  // WHY EVIDENCE AND NOT A CHECK. `previous` is a pointer, and a pointer is not provenance:
  // it can be made to resolve to a hand-placed, writable directory that validates perfectly.
  // Validating that directory and then swapping to it is the F3 defect — the bytes are free to
  // change between the two, so what gets exec'd never passed anything. Re-validating harder,
  // or later, does not close that: it is the same point-in-time claim about mutable bytes.
  // What closes it is refusing to select bytes forge cannot prove are its own: the ledger says
  // forge published and froze THIS physical directory with THESE contents, and the contents
  // still hash to it. A hand-placed unit has no such record and cannot acquire one — the
  // ledger lives outside the id namespace it would have to write to — so it is refused BY NAME
  // here rather than validated and selected.
  if (!isFrozenPublishedUnit(home, previous.releaseDir)) {
    throw new Error(
      `forge release: refusing to roll back — forge cannot vouch for the bytes the previous release points at.\n` +
        `  previous pointer: ${previousLinkIn(home)}\n` +
        `  it resolves to:   ${previous.releaseDir}\n` +
        `  forge's record:   ${unitEvidencePath(home, basename(previous.releaseDir))}\n` +
        `Rollback has no candidate to materialize from — it selects a unit an earlier promotion published — ` +
        `so it selects one ONLY on forge's own durable record that it materialized, validated, froze, and ` +
        `published those exact bytes there. There is no such record for this directory, it names a different ` +
        `one, or the bytes no longer match it: the unit was published by a forge too old to record one, it was ` +
        `hand-placed rather than promoted, or it has been modified since it was frozen. A release's location, ` +
        `its id, and the fact that it validates are not evidence that forge made it, and rolling back onto ` +
        `bytes forge cannot vouch for would exec them as the machine-wide forge.\n` +
        `Fix: promote the release you want explicitly — \`forge release promote <dir|id>\` — which materializes ` +
        `it, validates it, freezes it, and records what it published.`,
    );
  }

  // Validate the target to the point of RUNNING it: "the COMPLETE prior release" is a claim
  // about right now, not about when it was promoted. The full unit gate, descriptor included
  // — a rollback selects an already-published unit, so it validates and selects THE SAME
  // directory, the one the evidence above just bound to its contents.
  const target = validateUnit(previous.releaseDir, home);
  const before = readSelection(home);

  ensureSelectionLayout(home);
  opts.onBeforeSwap?.();
  writeSelection(home, target.releaseDir, before?.releaseDir ?? null);

  return {
    id: target.manifest.id,
    releaseDir: target.releaseDir,
    interpreter: target.interpreter,
    abi: target.manifest.abi,
    nodeVersion: target.manifest.nodeVersion,
    previous: before ? { id: before.manifest?.id ?? null, releaseDir: before.releaseDir } : null,
  };
}

export type InstallShimOptions = {
  prefix: string;
  shimText: string;
  shimName: string;
  /** Test seam: fires after the shim is fully written and chmod'd but BEFORE the atomic
   *  rename onto PATH — the F27c interruption window. Never set in production. */
  onBeforeCommit?: () => void;
};

/** Install the machine-wide PATH shim ATOMICALLY: write to a temp path in the SAME
 *  directory, chmod it executable, then rename(2) into place. A torn shim is never on PATH
 *  (F27c) — the file at <prefix>/forge is either the old complete shim or the new complete
 *  one, never a half-written script that a shell would happily start executing.
 *
 *  chmod BEFORE the rename, not after: a rename-then-chmod order publishes a
 *  non-executable forge onto PATH for a window.
 *
 *  Called ONLY by `forge release install-shim`, never as a side effect of a promotion. The
 *  shim sits outside the release closure, so its contract is not atomic with a release —
 *  which is exactly why changing it is an explicit install-level operation the operator
 *  performs, not something a promotion does to them. */
export function installShim(opts: InstallShimOptions): string {
  const prefix = resolve(opts.prefix);
  if (!existsSync(prefix)) {
    throw new Error(
      `forge release: refusing to install the shim — no such directory: ${prefix}.\n` +
        `Fix: create it, or pass a --prefix that exists (e.g. a directory on your PATH).`,
    );
  }
  const target = join(prefix, opts.shimName);
  // Same directory as the target, so the rename stays on one filesystem (rename(2) across
  // filesystems is EXDEV, and a fallback copy would not be atomic).
  const tmp = join(prefix, `.${opts.shimName}.installing-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmp, opts.shimText);
    chmodSync(tmp, 0o755);
    opts.onBeforeCommit?.();
    renameSync(tmp, target);
    return target;
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
