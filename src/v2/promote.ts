// FG-571 (FG-553 Child 4) — THE `current` POINTER: atomic promote + rollback.
//
// `current` is a SYMLINK at $FORGE_HOME/current -> $FORGE_HOME/releases/<id>. The
// machine-wide shim resolves it (once, physically) and execs the release's pinned
// interpreter; promotion is therefore a POINTER SWAP, and its atomicity is the whole
// safety property.
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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { FORGE_HOME, currentLinkIn, previousLinkIn, releasesDirIn } from "../util/paths.js";
import {
  RELEASE_ENTRY_NAME,
  RELEASE_LOADER_NAME,
  RELEASE_MANIFEST_NAME,
  assertReleaseCloses,
  type ReleaseManifest,
} from "./release.js";
import { interpreterKey, isStoredInterpreter, probeInterpreter } from "./runtime-store.js";

/** A release identity is a plain token. The SAME rule the shim's fail-closed identity
 *  guard applies in shell (renderIdentityGuard) — an id that the shim would refuse at exec
 *  time must not be promotable in the first place. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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

/** VALIDATE a candidate release to the point of RUNNING it. Every failure throws a named,
 *  actionable error in the FG-570 refusal style (what was wrong, where, what was running,
 *  how to fix) — never a bare false, because the caller's next move is to tell an operator.
 *
 *  The checks, and why each is a promotion gate rather than a runtime surprise:
 *   - the manifest PARSES and states a usable IDENTITY (F32: fail closed — a release that
 *     cannot state who it is does not run, so it does not get promoted either);
 *   - the interpreter is ABSOLUTE, present, and VALIDATED BY EXECUTION to report exactly
 *     the version+ABI the manifest names (validate-before-select: the manifest may
 *     reference only an already-validated interpreter);
 *   - the manifest is ABI-COHERENT with that interpreter (FG-570: the shipped binding
 *     loads under one ABI only);
 *   - that interpreter is IN THE STORE (FG-571's external-artifact contract): an external
 *     path validates identically today and is mutable tomorrow, so what a promotion proves
 *     about an unowned interpreter does not survive the next `brew upgrade node`;
 *   - the entry and loader are PRESENT;
 *   - the CLOSURE RUNS — assertReleaseCloses executes the release's tsx loader AND loads
 *     its own better-sqlite3 binding under the pinned interpreter. This is what makes the
 *     "no mixed tree, no broken promotion" claim evidence rather than a file listing. */
export function validateCandidate(dir: string): Candidate {
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

  // F32 at the promotion gate: the shim fails closed on a missing/malformed identity at
  // exec time. Refusing here means the operator learns at `promote`, with the previous
  // release still selected, instead of at the next `forge` invocation with nothing usable.
  const id: unknown = manifest.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
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
  // A store path cannot do that: the store is keyed by version+ABI and never replaces a
  // key in place, so what validated here is what runs later.
  const identity = { version: manifest.nodeVersion, abi: manifest.abi };
  if (!isStoredInterpreter(interpreter, identity)) {
    throw new Error(
      `forge release: refusing to promote — this release's interpreter is not in the interpreter store.\n` +
        `  release:      ${releaseDir}\n` +
        `  interpreter:  ${interpreter}\n` +
        `  expected form: <forge-home>/interpreters/${interpreterKey(identity)}/bin/node\n` +
        `It runs and it reports the version+ABI the manifest names, but it is an external path forge does ` +
        `not own: whatever installed it (a system package, homebrew, nvm) can rewrite those bytes in place, ` +
        `and this release would keep exec'ing that path — so promoting it would select a release whose ` +
        `validation expires the moment something else upgrades node, including under processes already ` +
        `anchored to it. The store exists to make that impossible: it is keyed by version+ABI, validated by ` +
        `execution before anything may reference it, and never replaced in place.\n` +
        `Fix: rebuild with \`forge release build\` — it installs its interpreter into the store and pins the ` +
        `store's copy.`,
    );
  }

  for (const [rel, what] of [
    [RELEASE_ENTRY_NAME, "entry"],
    [RELEASE_LOADER_NAME, "loader"],
  ] as const) {
    if (!existsSync(join(releaseDir, rel))) {
      throw new Error(
        `forge release: refusing to promote — this release is incomplete.\n` +
          `  release:      ${releaseDir}\n` +
          `  missing ${what}: ${join(releaseDir, rel)}\n` +
          `A promoted release must be able to start; this one cannot.\n` +
          `Fix: rebuild with \`forge release build\`.`,
      );
    }
  }

  // The closure RUNS: executes the release's own tsx loader and loads its own native
  // binding under the pinned interpreter. Throws a named torn-closure error (FG-569) if not.
  assertReleaseCloses(releaseDir, interpreter);

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

export type InstallReleaseOptions = {
  home?: string;
  dir: string;
  /** Test seam: fires after the release is fully staged but BEFORE the atomic rename that
   *  makes it addressable by id — the F27a interruption window. Never set in production. */
  onBeforeCommit?: () => void;
};

/** Install a release into $FORGE_HOME/releases/<id>, atomically.
 *
 *  `current` selects a release by its store path, so a release built somewhere else is
 *  copied in before it can be selected. Copy → `.installing-*` staging → rename(2) into
 *  the keyed path: an interrupted install leaves only a staging dir, which is not an id
 *  any pointer names and which promotion never resolves, so NOTHING partial is selectable
 *  (F27a).
 *
 *  A release already at its store path is returned untouched — a release directory is
 *  IMMUTABLE and never overwritten (re-promoting an installed release is a pointer
 *  operation, not a reinstall).
 *
 *  The copy goes through `tar`, not cpSync: a built release is FROZEN (write bits cleared
 *  on every file AND directory, FG-569 Finding 3), and a recursive copy that recreated
 *  those directories mode-first would be unable to write their contents. tar extracts
 *  contents and applies directory modes afterwards, so the frozen tree round-trips with
 *  its permissions — the installed copy is as immutable as the original. */
export function installRelease(opts: InstallReleaseOptions): string {
  const home = opts.home ?? FORGE_HOME;
  const source = resolve(opts.dir);
  const manifestPath = join(source, RELEASE_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`forge release: refusing to install — ${source} is not a release (no ${RELEASE_MANIFEST_NAME})`);
  }
  const { id } = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(
      `forge release: refusing to install — this release does not state a usable identity.\n` +
        `  release manifest: ${manifestPath}\n` +
        `  manifest id:      ${id === undefined ? "(missing)" : JSON.stringify(id)}\n` +
        `The store is keyed by identity, so a release with none has nowhere to go.\n` +
        `Fix: rebuild with \`forge release build\` (it records \`id\`).`,
    );
  }

  const releases = releasesDirIn(home);
  const target = join(releases, id);
  if (source === target) return target;
  if (existsSync(target)) {
    // The store already holds this identity. A release directory is immutable, so there is
    // nothing to update and nothing to overwrite.
    return target;
  }

  mkdirSync(releases, { recursive: true });
  const staging = join(releases, `.installing-${id}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(staging, { recursive: true });
    const copy = spawnSync("/bin/sh", ["-c", 'tar -C "$1" -cf - . | tar -C "$2" -xf -', "sh", source, staging], {
      encoding: "utf8",
    });
    if (copy.status !== 0) {
      throw new Error(`forge release: cannot install the release at ${source} into ${target} — ${copy.stderr?.trim() || `tar exited ${copy.status}`}`);
    }
    opts.onBeforeCommit?.();
    renameSync(staging, target);
    return target;
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

/** PROMOTE: validate → install → record previous → ATOMIC swap. In that order.
 *
 *  Nothing is deleted. The superseded release stays exactly where it is, because processes
 *  anchored to it are still using it and will die at their next lazy native load if it goes
 *  away (T9). */
export function promote(opts: PromoteOptions): PromoteResult {
  const home = opts.home ?? FORGE_HOME;
  const dir = resolveCandidateDir(home, opts.candidate);

  // VALIDATE FIRST — before the store is touched and long before the pointer moves. A
  // candidate that fails leaves the previously selected release selected, and this throws
  // rather than returning, so no caller can report success for it (F26).
  const candidate = validateCandidate(dir);

  const installed = installRelease({ home, dir: candidate.releaseDir });
  // Re-validate at the STORE path when the install actually copied: the promoted artifact
  // is the copy, so the copy is what must be proven to run — not the directory it came from.
  const selected = installed === candidate.releaseDir ? candidate : validateCandidate(installed);

  const before = readSelection(home);

  mkdirSync(home, { recursive: true });
  // Record `previous` BEFORE the swap: after it, `current` no longer names the release
  // being superseded, and rollback would have nothing to return to.
  if (before) atomicSymlinkSwap(before.releaseDir, previousLinkIn(home));

  opts.onBeforeSwap?.();
  atomicSymlinkSwap(selected.releaseDir, currentLinkIn(home));

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

  // Validate the target to the point of RUNNING it: "the COMPLETE prior release" is a claim
  // about right now, not about when it was promoted.
  const target = validateCandidate(previous.releaseDir);
  const before = readSelection(home);

  if (before) atomicSymlinkSwap(before.releaseDir, previousLinkIn(home));
  opts.onBeforeSwap?.();
  atomicSymlinkSwap(target.releaseDir, currentLinkIn(home));

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
