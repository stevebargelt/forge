// FG-571 (FG-553 Child 4) — THE INTERPRETER STORE, one of the two artifacts that live
// OUTSIDE the release closure (§1's external-artifact contract; the other is the PATH
// shim). "Atomic `current` swap" says nothing about either, so each needs its own
// contract. This module is the interpreter half:
//
//   $FORGE_HOME/interpreters/node-<version>-<abi>/bin/node
//
// `interpreters/`, NOT `runtimes/`: a real forge home already uses ~/.forge/runtimes/ for
// the PROVIDER RUNTIME REGISTRY (claude-oauth.yml, pi-apikey.yml, ...), enumerated by
// `forge doctor`. That is an unrelated meaning of "runtime" and the store does not go near it.
//
// - KEYED BY VERSION+ABI. Two interpreters that differ in either are different
//   interpreters — better-sqlite3's binding loads under ONE ABI only (FG-570), so ABI is
//   part of the identity, not a detail.
// - IMMUTABLE. An installed key is NEVER modified in place: re-installing a key that is
//   already valid is a NO-OP, and a partial/corrupt install is DISCARDED and rebuilt at a
//   FRESH staging path — never patched under a live reference. A retained release names
//   its interpreter by absolute path; mutating that path under an anchored process is the
//   same class of fault as deleting an anchored release (T9).
// - VALIDATE BEFORE SELECT. Installation EXECUTES the staged interpreter and confirms it
//   reports the expected process.version AND process.versions.modules BEFORE it is
//   committed to its keyed path. A release manifest may reference only an
//   already-validated interpreter path — validation is a precondition of selectability,
//   not a check performed afterwards.
// - ATOMIC. Stage → validate → rename(2) into the keyed path. An interrupted install
//   leaves NOTHING selectable (F27b): the staging dir is `.installing-*`, which is not a
//   key any release can name and which promotion never resolves.
// - RETAINED while referenced. There is NO GC here, deliberately and by construction —
//   nothing in this module deletes an installed interpreter. An interpreter is reclaimable
//   only when no retained release names it, and T9 forbids reclaiming a release with
//   anchored live processes, so automatic reclamation waits for a proven
//   anchored-process lifetime mechanism in a later ticket. Retention is unbounded by
//   design (§5's owned cost), not an oversight.
//
// EVERY path is derived from `home` (default FORGE_HOME), so a test that installs an
// interpreter under a mkdtemp FORGE_HOME cannot reach the operator's real store.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { FORGE_HOME, interpretersDirIn } from "../util/paths.js";

export type InterpreterIdentity = { version: string; abi: string };

/** The store key: version+ABI, the full identity of an interpreter for our purposes. */
export function interpreterKey(id: InterpreterIdentity): string {
  return `node-${id.version}-${id.abi}`;
}

/** The absolute path an interpreter with this identity occupies. Keyed — a DIFFERENT
 *  version or ABI is a different path, never an overwrite of this one. */
export function interpreterPath(home: string, id: InterpreterIdentity): string {
  return join(interpretersDirIn(home), interpreterKey(id), "bin", "node");
}

/** Is `bin` a path THIS store owns for `id` — i.e. the keyed path an interpreter with that
 *  identity occupies? Pure path arithmetic on the store's own layout
 *  ($home/interpreters/node-<version>-<abi>/bin/node), so it answers the REFERENCE question
 *  ("may a release name this?") without asserting anything about what is on disk; callers
 *  pair it with probeInterpreter, which answers the EXECUTION question.
 *
 *  Deliberately not scoped to ONE home: it recognizes a store path under whatever home owns
 *  it, because a release built against home A's store is still naming an immutable,
 *  version+ABI-keyed artifact when it is promoted under home B. What the check buys is the
 *  property that matters — the release names an interpreter the store OWNS and therefore
 *  never replaces in place, rather than an arbitrary external path (/usr/local/bin/node)
 *  that a system package upgrade can change under an anchored release. */
export function isStoredInterpreter(bin: string, id: InterpreterIdentity): boolean {
  // $home/interpreters/node-<version>-<abi>/bin/node — four segments up is the home.
  return bin === interpreterPath(resolve(bin, "..", "..", "..", ".."), id);
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

/** The store path for `id` IF an interpreter is installed there AND it still EXECUTES and
 *  still reports that identity — otherwise null. VALIDATE BEFORE SELECT, applied at
 *  selection time too: `existsSync` proves a file is present, not that it is the
 *  interpreter the release needs. Callers use this as the gate on referencing a path. */
export function validatedInterpreter(home: string, id: InterpreterIdentity): string | null {
  const path = interpreterPath(home, id);
  if (!existsSync(path)) return null;
  const got = probeInterpreter(path);
  if (!got || got.version !== id.version || got.abi !== id.abi) return null;
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
  /** Test seam: fires after the interpreter is staged and validated but BEFORE the atomic
   *  rename that makes it selectable — the F27b interruption window. Never set in
   *  production. (buildRelease's onBeforeSnapshot is the same seam, one layer up.) */
  onBeforeCommit?: () => void;
};

export type InstallInterpreterResult = {
  path: string;
  key: string;
  identity: InterpreterIdentity;
  /** True when the key was ALREADY installed and still validates — the install was a
   *  no-op. An immutable store's re-install is not a rewrite. */
  reused: boolean;
};

/** Install an interpreter into the store, immutably and atomically.
 *
 *  Stage to a FRESH `.installing-*` path → EXECUTE the staged binary and confirm it
 *  reports `expected` → rename(2) into the keyed path. Nothing partial is ever
 *  selectable: until the rename, the only artifact on disk is a staging dir no release
 *  can name; after it, the keyed path holds a binary that was proven to run and to report
 *  the right version+ABI before it got there (F27b).
 *
 *  A key that is already installed AND still validates is returned untouched — an
 *  immutable store answers a re-install with the existing artifact, never an overwrite. A
 *  key that is present but does NOT validate is a partial/corrupt install: it is rebuilt
 *  at a fresh staging path and renamed over, never patched in place. */
export function installInterpreter(opts: InstallInterpreterOptions): InstallInterpreterResult {
  const home = opts.home ?? FORGE_HOME;
  const key = interpreterKey(opts.expected);
  const target = join(interpretersDirIn(home), key);
  const finalPath = join(target, "bin", "node");

  const already = validatedInterpreter(home, opts.expected);
  if (already) return { path: already, key, identity: opts.expected, reused: true };

  if (!existsSync(opts.source)) {
    throw new Error(`forge release: cannot install an interpreter — no such file: ${opts.source}`);
  }

  mkdirSync(interpretersDirIn(home), { recursive: true });
  const staging = join(interpretersDirIn(home), `.installing-${key}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(join(staging, "bin"), { recursive: true });
    const stagedBin = join(staging, "bin", "node");
    copyFileSync(opts.source, stagedBin);
    chmodSync(stagedBin, 0o755);

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
          `The store is keyed by version+ABI and a release's native binding loads under its own ABI ` +
          `only, so committing this binary to ${key} would make the key lie about what it holds.\n` +
          `Fix: install this binary under the identity it actually reports, or supply the interpreter ` +
          `matching node ${opts.expected.version} / ABI ${opts.expected.abi}.`,
      );
    }

    opts.onBeforeCommit?.();

    // A present-but-invalid key is DISCARDED and replaced by this freshly-built tree —
    // never patched under a live reference. rename(2) over an existing directory fails, so
    // move the invalid one aside first; it is left on disk (RETAIN: this module deletes
    // nothing an anchored process might still hold).
    if (existsSync(target)) {
      renameSync(target, `${target}.invalid-${Math.random().toString(36).slice(2, 8)}`);
    }
    mkdirSync(join(target, ".."), { recursive: true });
    renameSync(staging, target);
    return { path: finalPath, key, identity: got, reused: false };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
