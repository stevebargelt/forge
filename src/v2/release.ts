// FG-569 (FG-553 Child 2) — the release-closure BUILDER + R1 provenance.
//
// A release is a self-contained, IMMUTABLE directory that carries everything the
// control plane needs to run without consulting PATH or the ambient environment:
//
//   <release>/
//     forge-release.json   the manifest (commit, absolute interpreter, ABI, lockfile identity)
//     forge                the entry: `#!/bin/sh` that execs the PINNED absolute node
//     forge-loader.mjs     the in-process tsx loader (import "tsx")
//     src/                 the source tree
//     node_modules/        the ENTIRE dependency closure, incl. the compiled native binding
//     package.json, package-lock.json
//
// The entry execs an ABSOLUTE interpreter with tsx loaded in-process (--import),
// so exactly one process exists and it is the one that loads better-sqlite3 — its
// process.execPath IS the runtime the manifest names (R1), provable by executing
// the entry under a hostile PATH with no node at all.
//
// This module is INERT: it BUILDS a release. It never promotes, never writes a
// `current` symlink, never touches PATH. Promotion is Child 4.
//
// TORN CLOSURE is refused AT BUILD: before anything is copied, the builder loads
// the source root's compiled better-sqlite3 binding under the building
// interpreter. A node_modules whose native binding is missing, corrupt, or
// ABI-mismatched cannot load — so a torn closure never becomes a release.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";

export const RELEASE_MANIFEST_NAME = "forge-release.json";
export const RELEASE_ENTRY_NAME = "forge";
export const RELEASE_LOADER_NAME = "forge-loader.mjs";
export const RELEASE_BINDING_REL = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";
export const RELEASE_ENTRY_SOURCE = "src/cli/index.ts";

export type ReleaseManifest = {
  schema: 1;
  id: string;
  commit: string;
  // The ABSOLUTE interpreter the entry execs — the whole point of the closure is
  // to depend on NO PATH lookup. Recorded from the building interpreter's
  // process.execPath; a release may only ever name the interpreter that built it.
  interpreter: string;
  abi: string; // process.versions.modules — the exact ABI the native binding needs
  nodeVersion: string;
  lockfile: { name: string; sha256: string };
  builtAt: string;
  entry: string; // RELEASE_ENTRY_SOURCE, relative to the release root
  binding: string; // RELEASE_BINDING_REL, relative to the release root
};

const LOADER_SHIM = `// FG-569: in-process tsx loader for this release's entry. import "tsx" resolves
// tsx from THIS release's node_modules (relative to this file), not the caller's
// cwd — so the release entry runs from any directory under a node-free PATH.
import "tsx";
`;

/** The sh entry: resolve the release root from the script's own path (no PATH,
 *  no node needed to bootstrap), then exec the PINNED absolute interpreter with
 *  tsx loaded in-process. ONE process; it is the one that loads the binding. */
export function renderEntry(interpreter: string): string {
  // The interpreter is an absolute filesystem path captured from process.execPath;
  // single-quote it so a space in the path can't split the exec argv.
  const q = `'${interpreter.replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# FG-569 release entry — exec the pinned interpreter, tsx in-process, ONE process.",
    "# Works under a hostile PATH (incl. NO node at all): the interpreter path is",
    "# absolute AND the release dir is resolved with shell builtins only (no",
    "# dirname/pwd-on-PATH external), so nothing here consults PATH.",
    `case "$0" in */*) d=\${0%/*} ;; *) d=. ;; esac`,
    `here=$(CDPATH= cd -- "$d" && pwd)`,
    `exec ${q} --import "$here/${RELEASE_LOADER_NAME}" "$here/${RELEASE_ENTRY_SOURCE}" "$@"`,
    "",
  ].join("\n");
}

function gitCommit(sourceRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(`forge release: cannot read the commit SHA at ${sourceRoot} (not a git repo?) — ${(e as Error).message}`);
  }
}

function lockfileIdentity(sourceRoot: string): { name: string; sha256: string } {
  for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const p = join(sourceRoot, name);
    if (existsSync(p)) {
      return { name, sha256: createHash("sha256").update(readFileSync(p)).digest("hex") };
    }
  }
  throw new Error(`forge release: no lockfile (package-lock.json) at ${sourceRoot} — a release must pin an exact dependency closure`);
}

/** Load the SOURCE ROOT's compiled better-sqlite3 under the building interpreter.
 *  This is the torn-closure gate: a missing / corrupt / ABI-mismatched binding
 *  throws here, before any copy, so a torn closure is REFUSED at build. */
export function assertClosureLoads(sourceRoot: string): void {
  const bindingPath = join(sourceRoot, RELEASE_BINDING_REL);
  if (!existsSync(bindingPath)) {
    throw new Error(`forge release: torn closure — the compiled native binding is missing at ${bindingPath}. Run npm install/rebuild, then rebuild the release.`);
  }
  let Database: new (path: string) => { close(): void };
  try {
    const require = createRequire(join(sourceRoot, "package.json"));
    Database = require("better-sqlite3") as typeof Database;
  } catch (e) {
    throw new Error(`forge release: torn closure — cannot load better-sqlite3 from ${join(sourceRoot, "node_modules")} under this interpreter (${process.execPath}, ABI ${process.versions.modules}): ${(e as Error).message}`);
  }
  let db: { close(): void } | undefined;
  try {
    db = new Database(":memory:");
  } catch (e) {
    throw new Error(`forge release: torn closure — the native binding at ${bindingPath} did not load (corrupt or ABI-mismatched) under this interpreter (ABI ${process.versions.modules}): ${(e as Error).message}`);
  } finally {
    db?.close();
  }
}

export type BuildReleaseOptions = {
  sourceRoot: string;
  outDir: string;
  now?: Date;
  rand?: string;
};

export type BuildReleaseResult = {
  manifest: ReleaseManifest;
  releaseDir: string;
  entryPath: string;
};

/** Build an immutable release closure from `sourceRoot` into `outDir`. Refuses a
 *  torn closure before writing anything. Builds into a sibling temp dir and
 *  renames into place, so an interrupted build never leaves a partial release. */
export function buildRelease(opts: BuildReleaseOptions): BuildReleaseResult {
  const sourceRoot = resolve(opts.sourceRoot);
  const outDir = resolve(opts.outDir);

  for (const rel of ["package.json", "src", "node_modules"]) {
    if (!existsSync(join(sourceRoot, rel))) {
      throw new Error(`forge release: ${sourceRoot} is not a buildable source root — missing ${rel}`);
    }
  }
  if (existsSync(outDir)) {
    throw new Error(`forge release: ${outDir} already exists — a release directory is immutable and never overwritten`);
  }

  // Gate FIRST: a torn closure must be refused BEFORE any copy so no partial
  // release survives the refusal.
  assertClosureLoads(sourceRoot);

  const now = opts.now ?? new Date();
  const commit = gitCommit(sourceRoot);
  const rand = opts.rand ?? Math.random().toString(36).slice(2, 8);
  const id = `release-${commit.slice(0, 7)}-${rand}`;

  const manifest: ReleaseManifest = {
    schema: 1,
    id,
    commit,
    interpreter: process.execPath,
    abi: process.versions.modules,
    nodeVersion: process.version,
    lockfile: lockfileIdentity(sourceRoot),
    builtAt: now.toISOString(),
    entry: RELEASE_ENTRY_SOURCE,
    binding: RELEASE_BINDING_REL,
  };

  const tmpDir = `${outDir}.building-${rand}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    for (const rel of ["src", "node_modules", "package.json", "package-lock.json"]) {
      const from = join(sourceRoot, rel);
      if (existsSync(from)) cpSync(from, join(tmpDir, rel), { recursive: true, verbatimSymlinks: true });
    }
    writeFileSync(join(tmpDir, RELEASE_LOADER_NAME), LOADER_SHIM);
    writeFileSync(join(tmpDir, RELEASE_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
    const entryPath = join(tmpDir, RELEASE_ENTRY_NAME);
    writeFileSync(entryPath, renderEntry(manifest.interpreter));
    chmodSync(entryPath, 0o755);

    mkdirSync(dirname(outDir), { recursive: true });
    // Rename is the atomic publish of the whole closure into its final path.
    renameSync(tmpDir, outDir);
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  return { manifest, releaseDir: outDir, entryPath: join(outDir, RELEASE_ENTRY_NAME) };
}

/** Walk up from `startDir` to the nearest release root (a dir holding
 *  forge-release.json) and return the parsed manifest, or null if the caller is
 *  not running inside a release (e.g. the dev bin/forge). */
export function readReleaseManifest(startDir: string): { manifest: ReleaseManifest; releaseDir: string } | null {
  let dir = isAbsolute(startDir) ? startDir : resolve(startDir);
  for (;;) {
    const p = join(dir, RELEASE_MANIFEST_NAME);
    if (existsSync(p)) {
      try {
        return { manifest: JSON.parse(readFileSync(p, "utf8")) as ReleaseManifest, releaseDir: dir };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type RuntimeProvenance = {
  pid: number;
  execPath: string;
  abi: string;
  nodeVersion: string;
  bindingLoads: boolean;
  release: ReleaseManifest | null;
  match: { interpreter: boolean; abi: boolean } | null;
};

/** R1: report the RUNNING process's own runtime — process.execPath IS the
 *  control runtime. When run inside a release, compare it against the manifest.
 *  `requireFrom` resolves better-sqlite3 from the running module's location so
 *  bindingLoads reflects THIS closure's binding. */
export function collectProvenance(fromModuleDir: string, requireFrom: NodeRequire): RuntimeProvenance {
  const found = readReleaseManifest(fromModuleDir);
  let bindingLoads = false;
  try {
    const Database = requireFrom("better-sqlite3") as new (p: string) => { close(): void };
    const db = new Database(":memory:");
    db.close();
    bindingLoads = true;
  } catch {
    bindingLoads = false;
  }
  const execPath = process.execPath;
  const abi = process.versions.modules;
  return {
    pid: process.pid,
    execPath,
    abi,
    nodeVersion: process.version,
    bindingLoads,
    release: found?.manifest ?? null,
    match: found ? { interpreter: execPath === found.manifest.interpreter, abi: abi === found.manifest.abi } : null,
  };
}
