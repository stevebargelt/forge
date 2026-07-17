// FG-571 (FG-553 Child 4) — THE INTERPRETER STORE, one of the two artifacts that live
// OUTSIDE the release closure (§1's external-artifact contract; the other is the PATH
// shim). "Atomic `current` swap" says nothing about either, so each needs its own
// contract. This module is the interpreter half:
//
//   $FORGE_HOME/interpreters/node-<version>-<abi>-<platform>-<arch>-<digest>/bin/node
//
// `interpreters/`, NOT `runtimes/`: a real forge home already uses ~/.forge/runtimes/ for
// the PROVIDER RUNTIME REGISTRY (claude-oauth.yml, pi-apikey.yml, ...), enumerated by
// `forge doctor`. That is an unrelated meaning of "runtime" and the store does not go near it.
//
// THE BINDING INVARIANT: once a final store path exists, its BYTES and its PATHNAME are
// immutable FOREVER. It is never renamed, deleted, repaired, chmodded, thawed, or replaced
// in place. EVERY existing final path is treated as potentially pinned by a retained
// release — there is no registry of who pins what and there will never be one, so the store
// cannot ever ask "is anyone using this?". It answers by never taking anything away.
//
// - CONTENT-ADDRESSED. The key commits to the COPIED BYTES: sha256 of the binary, plus the
//   platform identity (version, ABI, platform, arch). version+ABI ALONE IS NOT AN IDENTITY —
//   a rebuilt, vendor-patched, or differently-configured node honestly reports the same
//   version and the same ABI as another build, so a version+ABI key would silently hand a
//   later install the earlier install's bytes, and a release could never name the interpreter
//   bytes it was actually validated against. Because the key commits to the bytes, "reuse"
//   means SAME IDENTITY == SAME BYTES, which is the only thing that makes reuse safe at all,
//   and a race between two installers for one key is a race to write IDENTICAL bytes.
// - CREATE-ONLY. A final path is published by rename(2) into a name that does not exist.
//   rename(2) over a POPULATED directory fails with ENOTEMPTY, so create-only publication is
//   enforced BY THE KERNEL rather than by a lock: the loser of a race is told it lost. It
//   then VALIDATES the winner's entry and reuses it — it never overwrites it.
// - NEVER MOVED ASIDE, NEVER REPLACED. An existing final path that does NOT validate is
//   REFUSED BY NAME. It is not renamed to `.invalid-*` and rebuilt under its old name: the
//   PATHNAME is the reference a retained release's manifest holds, so moving the incumbent
//   aside is not a repair, it is the fault — the retained release gets ENOENT during the gap,
//   or execs somebody else's bytes at its own unchanged absolute path. A replacement is built
//   at a NEW final path (different bytes => different digest => different key, by
//   construction), new releases may pin it, and retained releases keep their original path.
// - VALIDATE BEFORE SELECT. Installation EXECUTES the staged interpreter and confirms it
//   reports the expected process.version AND process.versions.modules, and that its bytes
//   still digest to the identity being published, BEFORE it is committed. A release manifest
//   may reference only an already-validated interpreter path — validation is a precondition
//   of selectability, not a check performed afterwards.
// - ATOMIC. Stage → validate → freeze → rename(2). An interrupted install leaves NOTHING
//   selectable (F27b): the staging dir is `.installing-*`, which is not a key any release can
//   name and which promotion never resolves.
// - NO CLEANUP, EVER. Nothing in this module deletes a published entry. Retention is
//   unbounded by design (§5's owned cost), not an oversight — see the swap-and-retain rule.
//   The only thing it removes is its OWN staging dir on its OWN failure path.
//
// EVERY path is derived from `home` (default FORGE_HOME), so a test that installs an
// interpreter under a mkdtemp FORGE_HOME cannot reach the operator's real store.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { FORGE_HOME, interpretersDirIn } from "../util/paths.js";

/** What an interpreter SAYS it is when executed. A claim about behaviour, not an identity:
 *  two entirely different binaries can report exactly this and both be telling the truth. */
export type InterpreterIdentity = { version: string; abi: string };

/** What an interpreter IS. `digest` is what makes this an identity rather than a
 *  description: it names the bytes, so two distinct binaries that honestly report the same
 *  version+ABI are two distinct identities occupying two distinct final paths. */
export type StoredInterpreterIdentity = InterpreterIdentity & {
  platform: string;
  arch: string;
  digest: string;
};

/** sha256 of a file's bytes, hex. */
function fileDigest(bin: string): string {
  return createHash("sha256").update(readFileSync(bin)).digest("hex");
}

/** The store key. It COMMITS TO THE BYTES — that is the whole point (see the header): a key
 *  that named only version+ABI would let a rebuilt-but-identically-reporting node collide
 *  with an existing entry, and collision in an immutable store is either a silent
 *  substitution or a demand to replace a pinned path. Neither is allowed, so the identity is
 *  made fine-grained enough that the collision cannot arise: different bytes, different key.
 *
 *  The digest is carried IN FULL — never truncated for a legible pathname. The store validates
 *  bytes only THROUGH this key (validatedInterpreter re-digests, but compares by resolving the
 *  keyed pathname), so a truncated digest is not merely a shorter label: it is the entire
 *  strength of the commitment. At 64 bits a second binary that honestly reports the same
 *  version+ABI+platform+arch can be ground out to land on an existing entry's path, and the
 *  store would then reuse — and a release would exec — bytes it never validated, at a path
 *  another release pins. The full 256-bit digest is what makes "different bytes, different key"
 *  a fact rather than a probability. */
export function interpreterKey(id: StoredInterpreterIdentity): string {
  return `node-${id.version}-${id.abi}-${id.platform}-${id.arch}-${id.digest}`;
}

/** The identity of THIS host's platform, which the store copy will run on. */
function hostPlatform(): { platform: string; arch: string } {
  return { platform: process.platform, arch: process.arch };
}

/** ONE TRUSTED CANONICAL STORE ROOT, derived from the CONFIGURED home — never re-derived by
 *  walking up from a candidate's own resolved target.
 *
 *  FG-571 F4: deriving the root from the candidate is how a redirected path authenticates
 *  itself. `/tmp/attacker/interpreters/node-.../bin/node` implies the home `/tmp/attacker`,
 *  and a check that asks "does this path equal the keyed path its OWN implied home names?"
 *  answers yes for every path shaped like a store path, wherever its bytes actually live. The
 *  authority has to come from the configured FORGE_HOME instead, so it is passed in.
 *
 *  `home` itself is canonicalized (a legitimate forge home is routinely reached through a
 *  symlinked component — macOS's /var -> /private/var, a symlinked $HOME — and refusing those
 *  would refuse real hosts), but `interpreters/` is a component the STORE owns and must
 *  therefore be a real directory: a symlink there redirects the entire store, and it is a
 *  thing whose target something else can move after this check passes. */
function trustedStoreRoot(home: string): string {
  const root = join(realpathSync(home), "interpreters");
  if (existsSync(root) && !lstatSync(root).isDirectory()) {
    throw new Error(
      `forge release: refusing to use the interpreter store — its root is not a real directory.\n` +
        `  store root: ${root}\n` +
        `The store's own path component is a symbolic link (or not a directory), so every interpreter ` +
        `path forge published or validated through it would resolve wherever that link's owner points ` +
        `it — including after this check passed. The store's authority comes from the configured forge ` +
        `home, so its root must be a directory forge owns, not a redirect.\n` +
        `Fix: remove or replace ${root} with a real directory.`,
    );
  }
  return root;
}

/** The absolute path an interpreter with this identity occupies. Content-addressed — a
 *  DIFFERENT version, ABI, platform, arch, or BYTE occupies a different path, so this is
 *  never an overwrite of an existing one. */
export function interpreterPath(home: string, id: StoredInterpreterIdentity): string {
  return join(interpretersDirIn(home), interpreterKey(id), "bin", "node");
}

/** EXECUTE `bin` and ask it what it is. This is the only honest way to learn an
 *  interpreter's version+ABI: reading them off a filename or a package manifest describes
 *  what someone SAID it is. Returns null when the binary does not run or does not answer
 *  — an interpreter we cannot interrogate is not one a release may reference. */
export function probeInterpreter(bin: string): InterpreterIdentity | null {
  let out: string;
  try {
    out = execFileSync(bin, ["-p", "process.version + ' ' + process.versions.modules"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A hostile ambient env must not decide what this reports: NODE_OPTIONS can inject
      // into (or block) this very probe. Pass the minimal env the probe needs instead —
      // the same F29 reasoning the shim applies, one level down.
      env: { PATH: "/usr/bin:/bin" },
    }).trim();
  } catch {
    return null;
  }
  const [version, abi] = out.split(/\s+/);
  if (!version || !abi) return null;
  return { version, abi };
}

/** The FULL identity of the binary at `bin`: what it reports when EXECUTED, plus what its
 *  bytes actually are. Null when it does not run or does not answer. */
export function storedIdentityOf(bin: string): StoredInterpreterIdentity | null {
  const reported = probeInterpreter(bin);
  if (!reported) return null;
  return { ...reported, ...hostPlatform(), digest: fileDigest(bin) };
}

/** Is `bin` a path the store rooted at `home` OWNS, holding an interpreter that reports `id`?
 *
 *  FG-571 — THIS IS A FILESYSTEM QUESTION, NOT A STRING ONE. It used to be lexical path
 *  arithmetic: `bin === interpreterPath(resolve(bin, "../../../.."), id)`. That form is
 *  trivially satisfied by a path that merely LOOKS like a store path while the bytes it
 *  reaches live anywhere at all — `$home/interpreters/node-v24.0.0-137/bin/node` as a
 *  SYMLINK to /tmp/attacker-node passes string equality perfectly, and the whole purpose of
 *  the check is the opposite claim: that the interpreter a release pins is an artifact the
 *  store OWNS and therefore never replaces in place. A symlink is exactly a thing whose
 *  bytes something else can move.
 *
 *  So three things must hold, and each closes a distinct escape:
 *   - the final component is a REGULAR, NON-SYMLINK file (lstat, not stat — stat follows the
 *     link and would report the attacker's node as a fine regular file);
 *   - the CANONICAL path (every directory component resolved through symlinks) sits under the
 *     ONE TRUSTED ROOT derived from the CONFIGURED `home` — not under a root re-derived from
 *     this very path, which would let any store-shaped path vouch for itself (F4). A linked
 *     `bin/`, `node-<key>/`, or `interpreters/` therefore cannot smuggle the resolved bytes
 *     out of the store, and a later swap of a parent component moves the canonical path off
 *     the expected name rather than redirecting execution under it;
 *   - the canonical path equals the path this file's OWN CONTENT keys to. This is what makes
 *     the check self-authenticating (F3): the name commits to a digest, so bytes that are not
 *     those bytes cannot be sitting at that name. Substituting matching-version content at a
 *     store-shaped path no longer passes, because matching the VERSION is no longer enough to
 *     match the NAME.
 *
 *  That last point is also why a release manifest needs no digest field of its own: it pins an
 *  absolute path, and the path IS the content commitment. The manifest→exec boundary is
 *  unchanged and stays that way.
 *
 *  It answers the REFERENCE question ("may a release name this?"); callers pair it with
 *  probeInterpreter, which answers the EXECUTION question. */
export function isStoredInterpreter(bin: string, id: InterpreterIdentity, home: string = FORGE_HOME): boolean {
  if (!isAbsolute(bin)) return false;
  let st: Stats;
  try {
    st = lstatSync(bin);
  } catch {
    return false;
  }
  if (!st.isFile()) return false; // a symlink, directory, or device — never the store's own binary

  let root: string;
  let canonicalDir: string;
  try {
    root = trustedStoreRoot(home);
    canonicalDir = realpathSync(dirname(bin));
  } catch {
    return false; // no store, or a store root forge will not trust
  }
  const canonicalBin = join(canonicalDir, basename(bin));

  const actual = storedIdentityOf(bin);
  if (!actual) return false;
  if (actual.version !== id.version || actual.abi !== id.abi) return false;
  return canonicalBin === join(root, interpreterKey(actual), "bin", "node");
}

/** The store path for `id` IF an interpreter is installed there AND it still EXECUTES, still
 *  reports that identity, and still holds those exact BYTES — otherwise null. VALIDATE BEFORE
 *  SELECT, applied at selection time too: `existsSync` proves a file is present, not that it
 *  is the interpreter the release needs. Callers use this as the gate on referencing a path.
 *
 *  Re-digesting rather than trusting the key is the point: the key states what SHOULD be
 *  there, and this is the function that finds out whether it still is. */
export function validatedInterpreter(home: string, id: StoredInterpreterIdentity): string | null {
  const path = interpreterPath(home, id);
  if (!existsSync(path)) return null;
  if (!isStoredInterpreter(path, id, home)) return null;
  const got = storedIdentityOf(path);
  if (!got || got.digest !== id.digest) return null;
  return path;
}

export type InstallInterpreterOptions = {
  home?: string;
  /** Absolute path to the node binary to install (e.g. a downloaded distribution's
   *  bin/node, or process.execPath). Its bytes are COPIED — the store never links to a
   *  location it does not own, which would let the interpreter change under a release. */
  source: string;
  /** The identity the source MUST report. Installation refuses when it reports anything
   *  else, so a mislabeled binary can never be committed to a key that lies about it. */
  expected: InterpreterIdentity;
  /** Test seam: fires at each named point of the staging pipeline, so an interruption test
   *  can be SIGKILLed at a chosen one (F27b). ONE seam rather than a callback per phase —
   *  the phases are the states an interrupted install can be found in, and every one of them
   *  must leave nothing selectable. Never set in production. (buildRelease's
   *  onBeforeSnapshot is the same seam, one layer up.) */
  onPhase?: (phase: InstallPhase) => void;
};

/** The states a killed install can be found in: bytes copied but unproven; proven but still
 *  writable; frozen but not yet reachable under any name a release can pin; and about to be
 *  published. rename(2) is atomic, so there is no state BETWEEN the last one and a published
 *  entry — that is what makes the list complete. */
export type InstallPhase = "copied" | "validated" | "frozen" | "beforeCommit";

export type InstallInterpreterResult = {
  path: string;
  key: string;
  identity: StoredInterpreterIdentity;
  /** True when this identity was ALREADY published and still validates — the install was a
   *  no-op. An immutable store's re-install is not a rewrite. Also true for the LOSER of a
   *  concurrent race for the same identity: same identity means same bytes, so the winner's
   *  entry is exactly what this install would have written. */
  reused: boolean;
};

/** Remove this install's OWN staging dir. The only deletion in this module, and it only ever
 *  touches `.installing-*` — never a published entry. The staged binary is frozen read-only
 *  before publication, so the write bit is restored to remove it (the FILE's mode, not any
 *  published path's). */
function discardStaging(staging: string): void {
  const stagedBin = join(staging, "bin", "node");
  if (existsSync(stagedBin)) chmodSync(stagedBin, 0o700);
  rmSync(staging, { recursive: true, force: true });
}

/** The refusal for a final path that exists but does not validate. FAIL CLOSED BY NAME —
 *  never a silent redirect to replacement bytes (rule 6). */
function refuseInvalidEntry(target: string, key: string): Error {
  return new Error(
    `forge release: refusing to touch an existing interpreter entry that does not validate.\n` +
      `  entry: ${target}\n` +
      `An entry with this exact identity is already published here, and it no longer runs, no longer ` +
      `reports the version+ABI its key names, or no longer holds the bytes its key commits to.\n` +
      `It is NOT repaired, replaced, or moved aside, because this pathname is the reference: a retained ` +
      `release's manifest pins this absolute path and execs it forever. Moving it aside would give that ` +
      `release ENOENT; rebuilding under the same name would silently hand it bytes it was never ` +
      `validated against. Every existing entry is treated as pinned — there is no registry that could ` +
      `say otherwise — so the store never takes one back.\n` +
      `The release pinning ${key} therefore fails closed, by name, rather than running something else.\n` +
      `Fix: leave this entry alone and build a release against a working interpreter — a different ` +
      `interpreter is a different identity and gets its own fresh path, with this one untouched.`,
  );
}

/** Install an interpreter into the store, immutably and atomically.
 *
 *  Digest the source → derive the CONTENT-ADDRESSED identity → if that final path is already
 *  published, VALIDATE and reuse it (or refuse it by name) → otherwise stage to a FRESH
 *  `.installing-*` path, EXECUTE the staged binary, confirm it reports `expected` and digests
 *  to the identity being published, FREEZE it, and rename(2) it into a final path that DOES
 *  NOT EXIST.
 *
 *  Nothing partial is ever selectable: until the rename the only artifact on disk is a staging
 *  dir no release can name; after it, the final path holds bytes proven to run and to be
 *  exactly what the key says before they got there (F27b).
 *
 *  NOTHING EXISTING IS EVER MOVED OR OVERWRITTEN. There is no rename-aside: rename(2) into a
 *  populated directory fails with ENOTEMPTY, and that failure is the create-only guarantee, so
 *  it is handled as the benign race it is (same key means same bytes, so the winner's entry is
 *  what this install would have produced) rather than defeated. A key that is present but does
 *  NOT validate is refused BY NAME — never rebuilt under a pinned pathname. */
export function installInterpreter(opts: InstallInterpreterOptions): InstallInterpreterResult {
  const home = opts.home ?? FORGE_HOME;

  if (!existsSync(opts.source)) {
    throw new Error(`forge release: cannot install an interpreter — no such file: ${opts.source}`);
  }

  // The identity COMMITS TO THE BYTES ABOUT TO BE COPIED. Derived before anything is written,
  // because it is what decides the destination: there is no "where does this go, and is
  // something already there?" question that is answerable without it.
  const identity: StoredInterpreterIdentity = { ...opts.expected, ...hostPlatform(), digest: fileDigest(opts.source) };
  const key = interpreterKey(identity);

  mkdirSync(interpretersDirIn(home), { recursive: true });
  const root = trustedStoreRoot(home);
  const target = join(root, key);
  const finalPath = join(target, "bin", "node");

  // ALREADY PUBLISHED: reuse it, or fail closed by name. Never rename it aside, never rebuild
  // over it. Same identity means same bytes, so a valid entry here IS this install's result.
  if (existsSync(target)) {
    const already = validatedInterpreter(home, identity);
    if (already) return { path: already, key, identity, reused: true };
    throw refuseInvalidEntry(target, key);
  }

  const staging = join(root, `.installing-${key}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(join(staging, "bin"), { recursive: true });
    const stagedBin = join(staging, "bin", "node");
    copyFileSync(opts.source, stagedBin);
    chmodSync(stagedBin, 0o755);
    opts.onPhase?.("copied");

    // VALIDATE BEFORE SELECT: execute the STAGED binary — the actual bytes about to be
    // committed, not the source they were copied from.
    const got = probeInterpreter(stagedBin);
    if (!got) {
      throw new Error(
        `forge release: refusing to install an interpreter that does not run.\n` +
          `  source: ${opts.source}\n` +
          `  expected: node ${opts.expected.version}, ABI ${opts.expected.abi}\n` +
          `The staged binary did not execute or did not report its version/ABI. A release may reference ` +
          `only an interpreter that has been proven to run, so this install is discarded rather than ` +
          `committed to ${target}.`,
      );
    }
    if (got.version !== opts.expected.version || got.abi !== opts.expected.abi) {
      throw new Error(
        `forge release: refusing to install an interpreter that is not what it claims.\n` +
          `  source:   ${opts.source}\n` +
          `  reports:  node ${got.version}, ABI ${got.abi}\n` +
          `  expected: node ${opts.expected.version}, ABI ${opts.expected.abi}\n` +
          `The store is keyed by the identity an interpreter reports AND the bytes it is, and a release's ` +
          `native binding loads under its own ABI only, so committing this binary to ${key} would make the ` +
          `key lie about what it holds.\n` +
          `Fix: install this binary under the identity it actually reports, or supply the interpreter ` +
          `matching node ${opts.expected.version} / ABI ${opts.expected.abi}.`,
      );
    }
    // The COPY is what gets published, so the copy is what must match the key. Digesting the
    // source proved what was asked for; this proves what is about to be published.
    const stagedDigest = fileDigest(stagedBin);
    if (stagedDigest !== identity.digest) {
      throw new Error(
        `forge release: refusing to install an interpreter whose bytes changed while being copied.\n` +
          `  source: ${opts.source}\n` +
          `  keyed:  ${identity.digest}\n` +
          `  staged: ${stagedDigest}\n` +
          `The destination is chosen from the source's digest, so a source rewritten mid-copy would be ` +
          `published at a path that does not describe it — and that path is what a release pins forever.\n` +
          `Fix: install an interpreter that is not being written to.`,
      );
    }
    opts.onPhase?.("validated");

    // FREEZE THE VALIDATED BYTES, before they are reachable under a name any release can pin.
    // What gets published is then read-only from the instant it is published — there is no
    // window in which a validated-but-still-writable artifact sits at a final path.
    chmodSync(stagedBin, 0o555);
    opts.onPhase?.("frozen");

    // CREATE-ONLY PUBLICATION, enforced by the kernel. rename(2) onto a POPULATED directory
    // fails with ENOTEMPTY — so a concurrent installer that published this identity first
    // cannot be overwritten by this one, and no partial content is ever exposed at `target`
    // (the rename is atomic; before it there is no `target` at all).
    //
    // The race is BENIGN BY CONSTRUCTION and needs no lock: the key commits to the bytes, so
    // both installers are writing byte-identical content. Whoever won is correct. The loser
    // VALIDATES the winner's published entry and reuses it — it never replaces it.
    //
    // Nothing happens between "frozen" and here, which is the point: a validated artifact goes
    // from frozen straight to published, in one atomic syscall.
    opts.onPhase?.("beforeCommit");
    try {
      renameSync(staging, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOTDIR") throw e;
      discardStaging(staging);
      const winner = validatedInterpreter(home, identity);
      if (winner) return { path: winner, key, identity, reused: true };
      throw refuseInvalidEntry(target, key);
    }
    return { path: finalPath, key, identity, reused: false };
  } catch (e) {
    discardStaging(staging);
    throw e;
  }
}
