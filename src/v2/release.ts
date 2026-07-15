// FG-569 (FG-553 Child 2) — the release-closure BUILDER + R1 provenance.
//
// A release is a self-contained, IMMUTABLE directory that carries everything the
// declared CONTROL-PLANE command set needs to run without consulting PATH or the
// ambient environment. "Self-contained" is scoped HONESTLY to that set (recorded on
// the manifest as `selfContainedFor: "control-plane"`): the dashboard is a SEPARATE
// application workspace with its OWN dependency tree and is deliberately NOT bundled
// (deferred to FG-572 / Child 5), so `forge dashboard` refuses in release mode rather
// than pretending to run. Every SUPPORTED control command's module-relative assets ARE
// bundled, so none of them silently falls back to a source checkout:
//
//   <release>/
//     forge-release.json   the manifest (commit, absolute interpreter, ABI, lockfile identity)
//     forge                the entry: `#!/bin/sh` that execs the PINNED absolute node
//     forge-loader.mjs     the in-process tsx loader (import "tsx")
//     src/                 the source tree
//     seeds/               agent seeds, forge-raci.md, orchestrator-template.md, seed-drift baseline
//     scripts/             git-hooks, claude-hooks, claude-commands, install-seeds.sh
//     docker/              build.sh + Dockerfile (doctor image probe, upgrade --rebuild-image)
//     node_modules/        the ENTIRE dependency closure, incl. the compiled native binding
//     package.json, package-lock.json
//
// seeds/ + scripts/ + docker/ are REQUIRED, not optional: a supported command whose
// module-relative asset dir is absent at build time is a TORN CLOSURE refusal, not a
// silent skip (the shipped release would carry a command that cannot find its own
// assets). They are commit-bound like src/ (see assertCommitDescribesTree), so a dirty
// seed/hook/docker file refuses the build for the same reason a dirty src/ does.
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
import { dirname, join, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { findGitRoot } from "../util/git-root.js";

export const RELEASE_MANIFEST_NAME = "forge-release.json";
export const RELEASE_ENTRY_NAME = "forge";
export const RELEASE_LOADER_NAME = "forge-loader.mjs";
export const RELEASE_BINDING_REL = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";
export const RELEASE_ENTRY_SOURCE = "src/cli/index.ts";

export type ReleaseManifest = {
  schema: 1;
  id: string;
  // The commit of the --source checkout, BOUND to the shipped src/+package.json+
  // lockfile bytes: buildRelease refuses a dirty source, so this commit always
  // describes what was copied. (FG-569 GAP 2 — a dirty source made this lie.)
  commit: string;
  // The RUNNING builder's own commit — the checkout that produced the generated
  // entry (renderEntry) and loader (LOADER_SHIM) bytes. Distinct from `commit` so a
  // release built by builder A from a different --source checkout B never presents
  // B's commit as if it also produced the entry/loader. Equal to `commit` on the
  // normal self-build (builder and source are the same checkout).
  builderCommit: string;
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
  // FG-569 (Resolution B): the "self-contained" claim, scoped honestly. This release
  // closes over the CONTROL-PLANE command set — not the dashboard application (its own
  // workspace/deps, deferred to FG-572). Recorded so nothing downstream reads the
  // release as if it could run `forge dashboard`.
  selfContainedFor: "control-plane";
};

// FG-569 (Resolution B): asset directories a SUPPORTED control command resolves
// module-relative to the release root (seeds via init/upgrade/doctor-seed-drift,
// scripts via init hooks + upgrade install-seeds, docker via doctor image probe +
// upgrade --rebuild-image). REQUIRED — absence is a torn-closure refusal, and each is
// commit-bound so a dirty asset refuses the build. `dashboard/` is deliberately absent:
// a separate workspace, not a control-plane asset (forge dashboard refuses in release
// mode). Bound paths for the commit check add package.json + the selected lockfile;
// node_modules is lockfile-bound separately, not part of the commit's source identity.
const REQUIRED_ASSET_DIRS = ["seeds", "scripts", "docker"] as const;

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
    "# resolve next to the symlink, not the release. readlink is NOT a shell builtin: it",
    "# is resolved through PATH, so a symlinked entry under a node-free PATH could not",
    "# find it (the exact case a promotion symlink hits). Canonicalize instead with the",
    "# PINNED interpreter — an ABSOLUTE path, no PATH lookup, the one process the entry",
    "# already depends on being present — whose realpathSync resolves the whole symlink",
    "# chain (and any relative target) in a single call. The `-- \"$p\"` stops node from",
    "# reading a leading-dash link name as one of its own options. This runs ONLY when $0",
    "# is a symlink, so a DIRECT invocation stays a single node exec.",
    `p=$0`,
    `case "$p" in */*) ;; *) p=$(command -v "$p") ;; esac`,
    `if [ -L "$p" ]; then`,
    `  p=$(${q} -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' -- "$p")`,
    `fi`,
    `case "$p" in */*) d=\${p%/*} ;; *) d=. ;; esac`,
    `here=$(CDPATH= cd -- "$d" && pwd)`,
    "",
    "# FG-569 (R2): export this release's OWN id, read from its manifest with shell",
    "# builtins only (no sed/grep/node), so a node-free PATH still touches no external.",
    "# Every process the release starts — notably the `forge launch` exit-recorder —",
    "# then records this release's provenance instead of null. bin/forge (the dev",
    "# entry) has no manifest and is a separate file, so a dev launch stays null.",
    `while IFS= read -r ln; do`,
    `  case "$ln" in`,
    `  *\\"id\\":*)`,
    `    ln=\${ln#*\\"id\\": \\"}`,
    `    FORGE_RELEASE_ID=\${ln%%\\"*}`,
    `    export FORGE_RELEASE_ID`,
    `    break ;;`,
    `  esac`,
    `done < "$here/${RELEASE_MANIFEST_NAME}"`,
    "",
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

/** WHO built this release — the trusted builder identity recorded on the manifest as
 *  `builderCommit`, distinct from the --source `commit`. There are two builder kinds,
 *  distinguished by whether THIS module runs from inside an immutable release:
 *
 *   - A RELEASE builder (a release manifest resolves for this module's location): its
 *     own tree has NO `.git` — an immutable release is a COPY, not a git checkout — so
 *     its trusted identity is its OWN release manifest's `commit`, read here. It must
 *     NOT call findGitRoot / selectLockfile / the dirty-check against the release tree:
 *     there is nothing to commit or stash in an immutable release, and findGitRoot would
 *     fall back to the release's src/v2 dir (no lockfile there → a false torn-closure
 *     refusal). This is the FG-569 fix that lets a built release build its successor.
 *   - A DEVELOPMENT builder (no release manifest resolves): derive and verify identity
 *     from its Git checkout — findGitRoot + the builder dirty-check + gitCommit. On a
 *     self-build (builder root IS the --source checkout) the two commits are equal, so
 *     `sourceCommit` is reused directly.
 *
 *  Never manufactured from --source: the builder identity is WHO BUILT this release
 *  (e.g. release A's own commit), recorded SEPARATELY from the successor's source
 *  `commit`. */
function resolveBuilderCommit(sourceRoot: string, sourceCommit: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const runningRelease = readReleaseManifest(moduleDir);
  if (runningRelease) return runningRelease.manifest.commit;

  const bRoot = findGitRoot(moduleDir);
  if (bRoot === sourceRoot) return sourceCommit;
  // The builder contributes only the generated entry/loader bytes (from src/), so bind
  // its own src/package.json/lockfile — the assets come from --source, checked above.
  const builderLockfile = selectLockfile(bRoot);
  assertCommitDescribesTree(bRoot, ["src", "package.json", builderLockfile], "builder");
  return gitCommit(bRoot);
}

/** Refuse to build when ANY commit-bound SHIPPED source path of `root` is dirty
 *  relative to HEAD, so the recorded commit can never lie about the copied bytes
 *  (FG-569 GAP 2, extended by Resolution B to EVERY copied source asset). `paths` is
 *  the exact set copied under the commit's identity — src/, package.json, the selected
 *  lockfile, AND the bundled asset dirs (seeds/, scripts/, docker/). A dirty seed OR
 *  hook OR docker file therefore refuses the build for the same reason a dirty src/
 *  does: the manifest commit would not describe the shipped bytes. node_modules is NOT
 *  here — it is install OUTPUT, bound to the lockfile separately
 *  (assertShippedClosureMatchesLockfile), not part of the commit's source identity.
 *  `label` names which checkout (source / builder) so the refusal is actionable. */
function assertCommitDescribesTree(root: string, paths: readonly string[], label: string): void {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd: root, encoding: "utf8" });
  } catch (e) {
    throw new Error(`forge release: cannot check the ${label} tree at ${root} for uncommitted changes (not a git repo?) — ${(e as Error).message}`);
  }
  if (porcelain.trim() !== "") {
    throw new Error(`forge release: refusing to build a release from a dirty ${label} at ${root} — one of the shipped source paths (${paths.join(", ")}) has uncommitted changes relative to HEAD, so the manifest commit would not describe the shipped bytes. Commit or stash these changes, then rebuild:\n${porcelain.trimEnd()}`);
  }
}

const LOCKFILE_PRECEDENCE = ["npm-shrinkwrap.json", "package-lock.json"] as const;

/** FG-569 (Finding 4): the ONE effective lockfile, selected the way npm selects it —
 *  npm-shrinkwrap.json takes precedence over package-lock.json when both are present.
 *  The copy, the byte-binding (assertShippedClosureMatchesLockfile), and the manifest
 *  identity (lockfileIdentity) all read THIS one selection, so no part of the binding
 *  path hardcodes a lockfile name. Throws if neither exists. */
function selectLockfile(root: string): string {
  for (const name of LOCKFILE_PRECEDENCE) {
    if (existsSync(join(root, name))) return name;
  }
  throw new Error(`forge release: no lockfile (npm-shrinkwrap.json or package-lock.json) at ${root} — a release must pin an exact dependency closure`);
}

/** The lockfile identity recorded in the manifest: the SELECTED lockfile's name and a
 *  sha256 of its bytes. The caller passes the single selection so the manifest binds
 *  the same lockfile the copy and the byte-binding used. */
function lockfileIdentity(root: string, name: string): { name: string; sha256: string } {
  return { name, sha256: createHash("sha256").update(readFileSync(join(root, name))).digest("hex") };
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

type LockPackage = { resolved?: string; integrity?: string; link?: boolean; hasInstallScript?: boolean };

/** The npm content-addressable cache holds every tarball the lockfile pins, keyed
 *  BY its integrity — npm verifies the bytes against that integrity on write, so a
 *  cache hit IS the authentic, lockfile-pinned tarball. Derive the store path the
 *  way cacache does: hex-encode the digest, split 2/2/rest. Returns null on a miss
 *  (the tarball for that integrity is not local). */
function cacheTarballPath(cacheDir: string, integrity: string): string | null {
  for (const entry of integrity.trim().split(/\s+/)) {
    const dash = entry.indexOf("-");
    if (dash < 0) continue;
    const algo = entry.slice(0, dash);
    const hex = Buffer.from(entry.slice(dash + 1), "base64").toString("hex");
    const p = join(cacheDir, "_cacache", "content-v2", algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read a gzipped npm package tarball into a map of regular-file entry -> bytes.
 *  A minimal ustar reader (no dependency): honours the PAX 'x' and GNU 'L' long-
 *  name extensions that appear when a path exceeds the 100+155-char header fields
 *  (some deep dependency trees hit this), so every file name is recovered exactly. */
function readTarFiles(tarball: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let longName: string | null = null;
  let paxPath: string | null = null;
  let off = 0;
  while (off + 512 <= tarball.length) {
    const hdr = tarball.subarray(off, off + 512);
    off += 512;
    if (hdr.every((b) => b === 0)) break;
    const field = (start: number, len: number): string => hdr.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(field(124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(hdr[156]!);
    const data = tarball.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (type === "x" && m) paxPath = m[1]!;
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const entryName = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    if (type === "0" || type === "\0" || type === "") files.set(entryName, Buffer.from(data));
  }
  return files;
}

/** BIND the SHIPPED closure to the lockfile (FG-569). Hashing the lockfile bytes
 *  proves only WHICH lockfile was copied, not that the installed tree MATCHES it —
 *  a content-mutated dependency with an unchanged lockfile slips through. This
 *  closes that hole: for every package the lockfile pins by `integrity` that is
 *  present in the shipped node_modules, compare each of its tarball's files, byte
 *  for byte, against the shipped file. The lockfile-pinned tarball comes from the
 *  npm content cache (keyed by integrity — the authentic bytes), so this ties the
 *  SHIPPED content to the lockfile, not merely the lockfile file to itself.
 *
 *  An install-script package (better-sqlite3, esbuild, sharp) is NOT skipped: the
 *  loop iterates the TARBALL's files and binds each, and a package's genuinely
 *  install-generated artifacts (the compiled better_sqlite3.node, a downloaded
 *  platform binary) are naturally unbound because they are not tarball entries —
 *  so an install-script package's tarball-owned SOURCE (lib/index.js, package.json)
 *  is still byte-bound, which is where a supply-chain tamper would hide. Verified
 *  against this closure: better-sqlite3's 49 and sharp's 33 tarball files are all
 *  byte-identical on disk; esbuild rewrites exactly one tarball-owned file (see
 *  INSTALL_REWRITTEN_ALLOWANCE below).
 *
 *  Carve-outs, each principled — NOT a weakening to "just tsx + better-sqlite3":
 *   - Packages absent from node_modules (optional / other-platform deps like
 *     @esbuild/darwin-*) are not shipped, so nothing to bind.
 *   - `link` (workspace/local link — no tarball) and `!integrity` (nothing to
 *     verify against) are the ONLY package-level skips. */

// esbuild's postinstall (install.js → maybeOptimizePackage) renames the platform-
// native binary over this one tarball-owned placeholder, so its on-disk bytes
// legitimately differ from the tarball BY DESIGN — like a generated artifact, except
// it happens to share a path the tarball also ships. It is the ONLY tarball-owned
// file any install-script package in this closure rewrites. The allowance is EXACTLY
// this package + path — never a directory or glob — so every other file in esbuild
// (and everywhere else) stays byte-bound.
const INSTALL_REWRITTEN_ALLOWANCE = new Set<string>(["node_modules/esbuild/bin/esbuild"]);

export function assertShippedClosureMatchesLockfile(root: string, lockfileName: string): void {
  const lockPath = join(root, lockfileName);
  if (!existsSync(lockPath)) {
    throw new Error(`forge release: no ${lockfileName} at ${root} — cannot bind the shipped closure to a lockfile`);
  }
  const cacheDir = execFileSync("npm", ["config", "get", "cache"], { cwd: root, encoding: "utf8" }).trim();
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages?: Record<string, LockPackage> };
  const packages = lock.packages ?? {};

  for (const [key, meta] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/")) continue; // the "" root + workspace entries
    if (meta.link || !meta.integrity) continue;
    const pkgDir = join(root, key);
    if (!existsSync(pkgDir)) continue; // not shipped (optional / other-platform)

    const tarballPath = cacheTarballPath(cacheDir, meta.integrity);
    if (!tarballPath) {
      // Fail closed: without the authentic tarball we cannot prove the shipped
      // bytes match the lockfile. A warm cache is the norm right after install; a
      // miss means the cache was cleared — repopulate it rather than ship unbound.
      throw new Error(`forge release: cannot bind ${key} to the lockfile — its tarball (integrity ${meta.integrity}) is not in the npm cache at ${cacheDir}. Run 'npm ci' to repopulate the cache, then rebuild the release.`);
    }
    const tarFiles = readTarFiles(gunzipSync(readFileSync(tarballPath)));
    for (const [entryName, content] of tarFiles) {
      // npm strips the tarball's single top-level dir (usually `package/`, but
      // e.g. `node v22.19/` for @types/node) on extract — strip the first segment.
      const rel = entryName.replace(/^[^/]*\//, "");
      if (!rel || rel.endsWith("/")) continue;
      if (INSTALL_REWRITTEN_ALLOWANCE.has(`${key}/${rel}`)) continue;
      const shipped = join(pkgDir, rel);
      if (!existsSync(shipped)) {
        throw new Error(`forge release: shipped closure does not match the lockfile — ${key}/${rel} is pinned by package-lock.json but MISSING from the shipped node_modules. The installed tree is incomplete or was tampered; refusing to ship.`);
      }
      if (Buffer.compare(readFileSync(shipped), content) !== 0) {
        throw new Error(`forge release: shipped closure does not match the lockfile — ${key}/${rel} differs from the bytes pinned by package-lock.json (integrity ${meta.integrity}). A dependency was modified after install; refusing to ship a closure that does not match its lockfile.`);
      }
    }
  }
}

export type BuildReleaseOptions = {
  sourceRoot: string;
  outDir: string;
  now?: Date;
  rand?: string;
  // Test seam: fires AFTER the commit-bound copy has read the source tree but BEFORE the
  // post-copy revalidation, so a test can simulate a concurrent edit landing inside the
  // copy window and prove the TOCTOU gate refuses it. Never set in production.
  onCopied?: () => void;
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

/** FG-569 (Finding 3): freeze the staging tree for shipping — recursively clear the
 *  write bits on every FILE **and DIRECTORY** so the released closure is immutable at
 *  rest. Read-only files alone are defeatable: a writable parent directory lets any
 *  file be unlink+recreated or a brand-new file injected, so the frozen files mean
 *  nothing. Directories keep their read + search/execute bits (the tree stays
 *  traversable and the release still runs) but lose write, so no entry can be added or
 *  removed. POST-ORDER — freeze a directory's children BEFORE the directory itself, so
 *  children can still be chmod'd while their parent is writable — and the passed-in ROOT
 *  is frozen last (top-level entries like forge-release.json must not be rm+recreatable).
 *  An existing-executable file stays executable (only write bits are cleared). Runs on
 *  the STAGING dir BEFORE the atomic rename, so the FINAL release path is never observed
 *  writable. (Symlinks are already dereferenced away, so every entry is a real file or
 *  directory.) A fully frozen tree cannot be rmSync'd without restoring write bits first
 *  — see thawReleaseTree, used on the build's own cleanup path. */
function freezeReleaseFiles(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) freezeReleaseFiles(p);
    else chmodSync(p, statSync(p).mode & ~0o222);
  }
  chmodSync(dir, statSync(dir).mode & ~0o222);
}

/** Restore write bits across a (possibly) frozen release tree so it can be removed:
 *  freezeReleaseFiles clears directory write bits, and a recursive unlink needs write
 *  on every parent directory. Used on the build's own cleanup path (a refused build
 *  must leave no release behind, even after the tree was frozen) and exported for tests
 *  that build a release and must tear it down. This is ONLY for removing a tree
 *  wholesale — never call it to weaken the freeze on a published release. Skips symlinks
 *  so it never chmods a link's out-of-tree target. */
export function thawReleaseTree(dir: string): void {
  chmodSync(dir, statSync(dir).mode | 0o200);
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) thawReleaseTree(p);
    else chmodSync(p, statSync(p).mode | 0o200);
  }
}

/** True when `child` is `parent` itself or a path nested under it. Both must already be
 *  resolved absolute paths. Used to keep the release out dir out of the source tree. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
  // The out dir (and thus its sibling `.building-*` staging dir) must live OUTSIDE the
  // source tree: staging inside sourceRoot makes the staging dir part of the copy input,
  // so the recursive cpSync of src/ + node_modules/ would copy the growing staging tree
  // into itself. Refuse before anything is created.
  if (isWithin(sourceRoot, outDir)) {
    throw new Error(`forge release: --out ${outDir} is inside the source root ${sourceRoot} — the release (and its staging dir) must be built outside the source tree, or the copy would recurse into itself. Choose an --out path outside ${sourceRoot}.`);
  }

  // FG-569 (Finding 4): select the ONE effective lockfile up front (input validation)
  // and thread this single selection through copy, byte-binding, and manifest —
  // npm-shrinkwrap.json wins over package-lock.json; neither present is a clear error.
  const lockfileName = selectLockfile(sourceRoot);

  // Gate FIRST: a torn closure must be refused BEFORE any copy so no partial
  // release survives the refusal.
  assertClosureLoads(sourceRoot);

  // FG-569 (Resolution B): a SUPPORTED control command resolves these module-relative
  // to the release root (init → seeds/ + scripts/, doctor → seeds/ via seed-drift, etc.).
  // A missing one is a TORN CLOSURE — the release would ship a command that cannot find
  // its own assets — so REFUSE the build rather than optionally skip (the round-1
  // seeds?/scripts? glob was too loose). Checked AFTER the native-binding gate so a torn
  // binding is still reported as such; this is not a silent optional-skip either way.
  for (const rel of REQUIRED_ASSET_DIRS) {
    if (!existsSync(join(sourceRoot, rel))) {
      throw new Error(`forge release: torn closure — required asset directory '${rel}' is missing at ${join(sourceRoot, rel)}. A supported control-plane command resolves it module-relative to the release; a release without it ships a command that cannot find its own assets. Add ${rel}/ to the source, then rebuild.`);
    }
  }

  // FG-569 (GAP 2): bind the recorded commit(s) to the shipped bytes. Refuse a dirty
  // SOURCE (its src/+package.json+lockfile are what gets copied) so `commit` cannot
  // lie, and record the BUILDER's own identity separately — the entry/loader bytes are
  // generated by THIS forge, not by --source. When the running builder is itself a
  // RELEASE, its trusted identity is its OWN manifest's commit (a release has no .git);
  // on a dev self-build the builder IS the source checkout, so the two commits are equal.
  const now = opts.now ?? new Date();
  // The commit-bound source paths: src/, package.json, the selected lockfile, AND every
  // bundled asset dir. A dirty seed/hook/docker file refuses the build (Resolution B).
  const sourceBoundPaths = ["src", "package.json", lockfileName, ...REQUIRED_ASSET_DIRS];
  assertCommitDescribesTree(sourceRoot, sourceBoundPaths, "source");
  const commit = gitCommit(sourceRoot);
  const builderCommit = resolveBuilderCommit(sourceRoot, commit);
  const rand = opts.rand ?? Math.random().toString(36).slice(2, 8);
  const id = `release-${commit.slice(0, 7)}-${rand}`;
  const interpreter = process.execPath;

  const tmpDir = `${outDir}.building-${rand}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    // FG-569 (Resolution B): `src` + `node_modules` is not the whole runtime. Shipped
    // commands resolve bundled assets MODULE-RELATIVE to the release root — `forge init`
    // reads `seeds/` (also seed-drift/raci) and copies hooks out of `scripts/` (git-hooks,
    // claude-hooks, claude-commands); doctor reads seeds/ via seed-drift; docker/ carries
    // the build inputs upgrade/doctor consult. All three are REQUIRED (their presence was
    // asserted above), so no optional-skip here. (`dashboard/` is a SEPARATE npm workspace
    // with its own dependency tree — deliberately NOT bundled; `forge dashboard` refuses in
    // release mode, deferred to FG-572 / Child 5.)
    for (const rel of ["src", "node_modules", "package.json", lockfileName, ...REQUIRED_ASSET_DIRS]) {
      const from = join(sourceRoot, rel);
      const dest = join(tmpDir, rel);
      cpSync(from, dest, { recursive: true, dereference: true });
      // cpSync's `dereference` follows ONLY the top-level path — a NESTED symlink
      // (an npm-linked dependency, a .bin entry) survives the recursive copy as a
      // link pointing OUT of the release. Shipped, it would silently load mutable
      // host code once the source tree moved or changed — not the self-contained
      // closure this release must be. Dereference every nested link into real bytes.
      if (statSync(dest).isDirectory()) dereferenceSymlinks(dest);
    }

    // FG-569 (TOCTOU): the pre-copy gate (assertCommitDescribesTree above) proved the
    // source clean and at `commit`, but cpSync reads the tree LATER — a concurrent edit
    // in that window would be copied into the release under a manifest commit that does
    // not describe the copied bytes. RE-ASSERT, now that the copy has read every
    // commit-bound path, that the source is STILL clean AND HEAD is STILL `commit`: a
    // persistent concurrent edit leaves the tree dirty, and a concurrent commit moves
    // HEAD — either refuses the build rather than shipping mis-attributed bytes.
    opts.onCopied?.();
    assertCommitDescribesTree(sourceRoot, sourceBoundPaths, "source");
    const commitAfterCopy = gitCommit(sourceRoot);
    if (commitAfterCopy !== commit) {
      throw new Error(`forge release: the source HEAD at ${sourceRoot} moved during the build (recorded ${commit.slice(0, 7)}, now ${commitAfterCopy.slice(0, 7)}) — the copied bytes may not describe the recorded commit. Rebuild from a quiescent source.`);
    }

    writeFileSync(join(tmpDir, RELEASE_LOADER_NAME), LOADER_SHIM);
    const entryPath = join(tmpDir, RELEASE_ENTRY_NAME);
    writeFileSync(entryPath, renderEntry(interpreter));
    chmodSync(entryPath, 0o755);

    // MUST-FIX 3: the manifest's lockfile SHA must describe the SHIPPED closure, so
    // hash the release's OWN copied lockfile (the selected one) — not the source at
    // build time.
    const manifest: ReleaseManifest = {
      schema: 1,
      id,
      commit,
      builderCommit,
      interpreter,
      abi: process.versions.modules,
      nodeVersion: process.version,
      lockfile: lockfileIdentity(tmpDir, lockfileName),
      builtAt: now.toISOString(),
      entry: RELEASE_ENTRY_SOURCE,
      binding: RELEASE_BINDING_REL,
      selfContainedFor: "control-plane",
    };
    writeFileSync(join(tmpDir, RELEASE_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

    // FG-569 (Finding 3): FREEZE the staging tree BEFORE the atomic rename — clear the
    // write bits on every file so the closure is immutable at rest — then VERIFY the
    // now-frozen tree, THEN rename the already-frozen tree into place. The final
    // release path is never observed with a writable file, so there is no post-rename
    // mutation window.
    freezeReleaseFiles(tmpDir);

    // Verify the FROZEN closure — both gates only READ the tree:
    //  - FIX 4 + FIX 5: it RUNS under the pinned interpreter (the tsx loader loads and
    //    better-sqlite3 loads from the release's OWN node_modules), and
    //  - FG-569: its shipped bytes MATCH the selected lockfile — a content-mutated dep
    //    with an untouched lockfile is refused rather than shipped.
    // Proven AFTER the freeze, so the thing that ships is exactly what was verified.
    assertReleaseCloses(tmpDir, interpreter);
    assertShippedClosureMatchesLockfile(tmpDir, lockfileName);

    mkdirSync(dirname(outDir), { recursive: true });
    // Atomic publish of the already-frozen closure into its final, immutable path.
    renameSync(tmpDir, outDir);

    return { manifest, releaseDir: outDir, entryPath: join(outDir, RELEASE_ENTRY_NAME) };
  } catch (e) {
    // The freeze may already have run (a post-freeze gate can throw — e.g. the
    // lockfile byte-binding), leaving read-only directories a recursive unlink
    // can't traverse. Restore write bits before removing, so a refused build
    // still leaves no release behind.
    if (existsSync(tmpDir)) thawReleaseTree(tmpDir);
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
