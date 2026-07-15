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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
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
    "# absolute AND (for a direct invocation) the release dir is resolved with shell",
    "# builtins only (no dirname/pwd-on-PATH external), so nothing consults PATH.",
    "#",
    "# A promoted release is reached via a symlink (current/PATH shim), so canonicalize",
    "# $0 through symlinks before deriving the release root — else $here/src would",
    "# resolve next to the symlink, not the release. readlink runs ONLY when $0 is a",
    "# symlink, so a DIRECT invocation under a node-free PATH touches no external.",
    `p=$0`,
    `case "$p" in */*) ;; *) p=$(command -v "$p") ;; esac`,
    `while [ -L "$p" ]; do`,
    `  t=$(readlink -- "$p")`,
    `  case "$t" in /*) p=$t ;; *) p=\${p%/*}/$t ;; esac`,
    `done`,
    `case "$p" in */*) d=\${p%/*} ;; *) d=. ;; esac`,
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

/** Load the SOURCE ROOT's compiled better-sqlite3 under the building interpreter,
 *  and confirm the tsx loader the entry depends on is installed. This is the
 *  pre-copy gate: a missing / corrupt / ABI-mismatched binding (or a missing tsx)
 *  throws here, BEFORE any copy, so a torn closure never becomes a release. The
 *  COPIED closure is validated again post-copy under the pinned interpreter — see
 *  assertReleaseCloses (the manifest must describe the SHIPPED closure, not the
 *  source at build time). */
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
  // FIX 5: the release entry runs `node --import forge-loader.mjs` and the shim
  // does `import "tsx"`. If tsx is absent the entry can't even start, gate green
  // or not — so require its presence before we bother copying the closure.
  if (!existsSync(join(sourceRoot, "node_modules", "tsx", "package.json"))) {
    throw new Error(`forge release: the tsx loader is not installed at ${join(sourceRoot, "node_modules", "tsx")} — the release entry (node --import forge-loader.mjs) could not start. Run npm install, then rebuild the release.`);
  }
}

/** Validate the COPIED release closure by RUNNING it under the pinned interpreter
 *  — the release's actual runtime, a fresh process (no in-process double-load of
 *  the native addon). Proves two things the source pre-check cannot, because it
 *  exercises the shipped copy exactly as the entry will:
 *   - FIX 5: the tsx loader shim actually loads (`node --import <loader> -e ""`),
 *   - FIX 4: better-sqlite3 loads from the RELEASE's own node_modules and opens.
 *  A copy that corrupts the binding, drops tsx, or otherwise fails to run is
 *  caught here, before the release is published. */
export function assertReleaseCloses(releaseRoot: string, interpreter: string): void {
  const loader = join(releaseRoot, RELEASE_LOADER_NAME);
  // 1) tsx: the entry can't run at all if `import "tsx"` throws.
  try {
    execFileSync(interpreter, ["--import", loader, "-e", ""], { cwd: releaseRoot, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? (e as Error).message;
    throw new Error(`forge release: the COPIED closure's tsx loader did not run under the pinned interpreter (${interpreter}) — the release would not start: ${stderr.trim()}`);
  }
  // 2) better-sqlite3: load the RELEASE's own binding and open an in-memory DB.
  try {
    execFileSync(interpreter, ["--import", loader, "-e", "new (require('better-sqlite3'))(':memory:').close()"], { cwd: releaseRoot, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? (e as Error).message;
    throw new Error(`forge release: torn closure — the COPIED better-sqlite3 binding did not load under the pinned interpreter (${interpreter}, ABI ${process.versions.modules}): ${stderr.trim()}`);
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

/** Replace every symlink under `dir`, in place, with a real copy of its target so
 *  the release carries actual bytes and no link escapes the closure. Needed because
 *  cpSync's `dereference` follows only the top-level path, leaving nested links
 *  (an npm-linked dependency, a `.bin` entry) pointing outside the tree. A broken
 *  link resolves nowhere and throws here — the correct torn-closure refusal rather
 *  than a dangling link shipped into a "self-contained" release. */
function dereferenceSymlinks(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      const target = realpathSync(p);
      rmSync(p, { recursive: true, force: true });
      cpSync(target, p, { recursive: true, dereference: true });
      // The copied target may itself hold nested links — dereference those too.
      if (statSync(p).isDirectory()) dereferenceSymlinks(p);
    } else if (ent.isDirectory()) {
      dereferenceSymlinks(p);
    }
  }
}

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
  const interpreter = process.execPath;

  const tmpDir = `${outDir}.building-${rand}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    for (const rel of ["src", "node_modules", "package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
      const from = join(sourceRoot, rel);
      if (!existsSync(from)) continue;
      const dest = join(tmpDir, rel);
      cpSync(from, dest, { recursive: true, dereference: true });
      // cpSync's `dereference` follows ONLY the top-level path — a NESTED symlink
      // (an npm-linked dependency, a .bin entry) survives the recursive copy as a
      // link pointing OUT of the release. Shipped, it would silently load mutable
      // host code once the source tree moved or changed — not the self-contained
      // closure this release must be. Dereference every nested link into real bytes.
      if (statSync(dest).isDirectory()) dereferenceSymlinks(dest);
    }
    writeFileSync(join(tmpDir, RELEASE_LOADER_NAME), LOADER_SHIM);
    const entryPath = join(tmpDir, RELEASE_ENTRY_NAME);
    writeFileSync(entryPath, renderEntry(interpreter));
    chmodSync(entryPath, 0o755);

    // FIX 4 + FIX 5: validate the COPIED closure (binding + tsx loader) by running
    // it under the pinned interpreter, before we describe it in a manifest.
    assertReleaseCloses(tmpDir, interpreter);

    // MUST-FIX 3: the manifest's lockfile SHA must describe the SHIPPED closure,
    // so hash the release's OWN copied lockfile — not the source at build time.
    const manifest: ReleaseManifest = {
      schema: 1,
      id,
      commit,
      interpreter,
      abi: process.versions.modules,
      nodeVersion: process.version,
      lockfile: lockfileIdentity(tmpDir),
      builtAt: now.toISOString(),
      entry: RELEASE_ENTRY_SOURCE,
      binding: RELEASE_BINDING_REL,
    };
    writeFileSync(join(tmpDir, RELEASE_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

    mkdirSync(dirname(outDir), { recursive: true });
    // Rename is the atomic publish of the whole closure into its final path.
    renameSync(tmpDir, outDir);

    return { manifest, releaseDir: outDir, entryPath: join(outDir, RELEASE_ENTRY_NAME) };
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
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
