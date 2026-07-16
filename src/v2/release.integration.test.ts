// FG-569 (FG-553 Child 2) — the release closure + R1 provenance, EXECUTED.
//
// This builds a REAL release from the running project (a full node_modules incl.
// the compiled better-sqlite3 binding) and then EXECUTES the release entry under
// a hostile PATH — including one with NO node on PATH at all — asserting the
// runtime FROM THE RUNNING PROCESS, per FG-551 (a grep of bin/forge is hollow;
// running the entry and reading process.execPath is real).
//
// Runs in the forge-test scratch (/tmp/forge-work), where node_modules is rebuilt
// for the container and the tree is a git repo — so the closure carries a binding
// that actually loads and the manifest carries a real commit SHA.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, lstatSync, readdirSync, rmSync, renameSync, symlinkSync, appendFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease, assertReleaseCloses, thawReleaseTree, renderEntry, RELEASE_BINDING_REL, RELEASE_LOADER_NAME, RELEASE_MANIFEST_NAME, type BuildReleaseResult } from "./release.js";
import { findGitRoot } from "../util/git-root.js";

const sourceRoot = findGitRoot(process.cwd());
let workspace: string;
let built: BuildReleaseResult;

/** Commit a buildable tree's SHIPPED source paths (src/, package.json, and any
 *  lockfile) so HEAD describes them — buildRelease now refuses a dirty source
 *  (FG-569 GAP 2). node_modules stays untracked: it is install output bound to the
 *  lockfile separately, not part of the commit's source identity (and it is huge).
 *  A no-op when the tree is already clean (CI runs on a committed checkout). */
function commitSource(root: string): void {
  // FG-569 Resolution B: the commit now binds the bundled asset dirs too (seeds/,
  // scripts/, docker/), so a build refuses a dirty seed/hook/docker file. Stage them
  // here alongside src/+package.json+lockfile, else buildRelease would refuse the
  // scratch's synced-but-uncommitted assets.
  const paths = ["src", "package.json", "seeds", "scripts", "docker"].filter((p) => existsSync(join(root, p)));
  for (const lf of ["package-lock.json", "npm-shrinkwrap.json"]) {
    if (existsSync(join(root, lf))) paths.push(lf);
  }
  execFileSync("git", ["add", "--", ...paths], { cwd: root });
  if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root }).status !== 0) {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "source snapshot"], { cwd: root });
  }
}

/** FG-569 Resolution B: copy the REAL bundled asset dirs (seeds/, scripts/, docker/)
 *  from this project into a synthetic fixture. buildRelease now REQUIRES these — a source
 *  lacking one is refused as a torn closure — so every buildable fixture must carry them.
 *  Real bytes (not stubs) so the dirty-seed/hook rejection test can mutate a genuine file. */
function copyBundledAssets(root: string): void {
  for (const asset of ["seeds", "scripts", "docker"]) {
    cpSync(join(sourceRoot, asset), join(root, asset), { recursive: true, dereference: true });
  }
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "fg569-rel-"));
  // FG-569 GAP 2: a release binds its commit to the shipped source, so the tree must
  // be committed before it can build. CI runs on a committed checkout (no-op here);
  // under forge-test the scratch carries this run's synced-but-uncommitted edits, so
  // snapshot them first — mirroring the clean committed state CI builds against.
  commitSource(sourceRoot);
  // The one full build the whole file shares (copying node_modules is the slow
  // part). outDir is OUTSIDE sourceRoot so the copy never recurses into itself.
  built = buildRelease({ sourceRoot, outDir: join(workspace, "release") });
});

after(() => {
  // The releases built under this workspace are FROZEN (read-only directories), so a
  // recursive unlink can't traverse them — restore write bits across the whole tree
  // first. (thawReleaseTree is idempotent on the non-frozen scratch dirs alongside them.)
  thawReleaseTree(workspace);
  rmSync(workspace, { recursive: true, force: true });
});

test("FG-569 (finding): an --out path INSIDE the source tree is REFUSED before any staging dir is created — else the copy recurses into itself", () => {
  // --out src/<x> makes src/<x>.building-* part of the copied src/ input, so the
  // recursive cpSync of src/ + node_modules/ would copy the growing staging tree into
  // itself. The build must refuse the path before creating anything.
  const badOut = join(sourceRoot, "src", "release-would-recurse");
  assert.throws(
    () => buildRelease({ sourceRoot, outDir: badOut }),
    /inside the source root/i,
    "an out dir contained by sourceRoot must be refused",
  );
  assert.ok(!existsSync(badOut), "no out dir was created");
  const leaked = readdirSync(join(sourceRoot, "src")).filter((n) => n.startsWith("release-would-recurse"));
  assert.deepEqual(leaked, [], "no `.building-*` staging dir leaked into the source tree");
});

test("FG-569 build: the manifest pins the building interpreter, its ABI, the commit, and a lockfile identity", () => {
  const m = built.manifest;
  assert.equal(m.interpreter, process.execPath, "the absolute interpreter is the building process's execPath");
  assert.equal(m.abi, process.versions.modules, "the ABI the native binding needs");
  assert.equal(m.commit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim());
  assert.match(m.lockfile.sha256, /^[0-9a-f]{64}$/, "lockfile identity is recorded");
  assert.ok(existsSync(join(built.releaseDir, RELEASE_BINDING_REL)), "the compiled native binding is inside the closure");
  assert.ok(existsSync(built.entryPath), "the entry script exists");
});

test("FG-569 INERT: the builder promotes nothing — no `current` symlink, no pointer, just the release dir", () => {
  // Neither the release dir nor its parent gains a `current` pointer — promotion
  // (the `current` symlink / PATH shim) is Child 4, deliberately not here.
  for (const p of [join(built.releaseDir, "current"), join(workspace, "current")]) {
    assert.ok(!existsSync(p), `no promotion artifact at ${p}`);
  }
  assert.ok(lstatSync(built.releaseDir).isDirectory(), "the release is a plain directory, not a symlink");
});

test("FG-569 Finding 3 (immutability): the built release is read-only at rest — a write into any file FAILS, directories stay traversable, executables stay executable", () => {
  // The release was FROZEN in staging BEFORE the atomic rename, so its final path was
  // never observed with a writable file. Every kind of file under the release —
  // manifest, entry, a source file, a dependency file — refuses a write.
  const files = [
    join(built.releaseDir, RELEASE_MANIFEST_NAME),
    built.entryPath,
    join(built.releaseDir, "src", "cli", "index.ts"),
    join(built.releaseDir, RELEASE_BINDING_REL),
  ];
  for (const f of files) {
    assert.ok(existsSync(f), `${f} exists in the release`);
    assert.throws(() => appendFileSync(f, "x"), /EACCES|EPERM|EROFS/, `writing ${f} must fail — the release is immutable at rest`);
    // Read still works: immutable, not inaccessible.
    assert.ok(readFileSync(f).length > 0, `${f} is still readable`);
  }
  // Directories keep their search bit, so the tree stays traversable.
  assert.ok(readdirSync(join(built.releaseDir, "src", "cli")).length > 0, "release directories remain traversable");
  // The entry keeps its executable bit — only write bits were cleared.
  assert.ok((statSync(built.entryPath).mode & 0o111) !== 0, "the entry remains executable");
});

test("FG-569 Finding 3 (immutability, DIR-tamper): the release directories are frozen too — rm+recreate a file, and inject a new file, both FAIL", () => {
  // Read-only files are meaningless if their parent directory stays writable: any file
  // can be unlink+recreated, or a brand-new file injected, through the writable dir.
  // The freeze clears directory write bits too, so both dir-level tampers are refused.
  const target = join(built.releaseDir, RELEASE_MANIFEST_NAME);
  assert.ok(existsSync(target), "the manifest exists in the release");
  // (a) rm a release file — unlink needs write on the PARENT dir, which is frozen.
  assert.throws(() => rmSync(target), /EACCES|EPERM|EROFS|ENOTEMPTY/, "rm of a release file must fail — its parent directory is frozen");
  assert.ok(existsSync(target), "the file survives the refused rm (so rm+recreate is impossible)");
  // (b) inject a brand-new file into a release dir — create needs write on the dir.
  const injected = join(built.releaseDir, "src", "cli", "injected-by-attacker.ts");
  assert.throws(() => writeFileSync(injected, "malicious\n"), /EACCES|EPERM|EROFS/, "injecting a new file into a release dir must fail — the dir is frozen");
  assert.ok(!existsSync(injected), "no injected file exists in the frozen release dir");
  // (c) the release ROOT itself is frozen — a top-level entry can't be planted either.
  assert.throws(() => writeFileSync(join(built.releaseDir, "planted.txt"), "x"), /EACCES|EPERM|EROFS/, "the release root is frozen — no top-level file can be planted");
});

// The R1 acceptance in its sharpest form: run the release entry with an
// environment whose PATH contains NO node at all, and assert the runtime FROM
// THE RUNNING PROCESS matches the manifest. If the entry consulted PATH (the old
// spawn(tsx) shape), this could not start; because it execs the pinned absolute
// interpreter with tsx in-process, it runs and self-evidences.
function runEntryUnderHostilePath(args: string[]) {
  const emptyDir = mkdtempSync(join(workspace, "nopath-"));
  const env = { PATH: emptyDir, HOME: process.env.HOME ?? "/tmp", FORGE_HOME: process.env.FORGE_HOME ?? "" };
  const r = spawnSync(built.entryPath, args, { encoding: "utf8", env });
  let prov: any;
  try { prov = JSON.parse(r.stdout); } catch { prov = undefined; }
  return { r, prov };
}

test("FG-569 R1 (EXECUTED, NO node on PATH): the running process's execPath == manifest interpreter and its ABI == manifest ABI", () => {
  // Prove the hostile PATH truly lacks node — the premise of the test.
  const emptyDir = mkdtempSync(join(workspace, "probe-"));
  const probe = spawnSync("node", ["-v"], { env: { PATH: emptyDir }, encoding: "utf8" });
  assert.equal((probe.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT", "node is genuinely absent from this PATH");

  const { r, prov } = runEntryUnderHostilePath(["release", "provenance", "--json"]);
  assert.equal(r.status, 0, `entry failed under a node-free PATH: ${r.stderr}`);
  assert.ok(prov, `entry did not emit JSON: ${r.stdout} / ${r.stderr}`);

  assert.equal(prov.execPath, built.manifest.interpreter, "process.execPath (from the running process) IS the manifest interpreter");
  assert.equal(prov.abi, built.manifest.abi, "process.versions.modules IS the manifest ABI");
  assert.equal(prov.bindingLoads, true, "the closure's native binding actually loaded under the pinned interpreter");
  assert.equal(prov.release.id, built.manifest.id, "the running process located its own release manifest");
  assert.deepEqual(prov.match, { interpreter: true, abi: true }, "the process self-verified against its manifest");
});

test("FG-569 exec-not-spawn (EXECUTED): the release entry runs in ONE process — the CLI's pid IS the spawned pid, no tsx child", () => {
  const { r, prov } = runEntryUnderHostilePath(["release", "provenance", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  // /bin/sh execs node (same pid); node loads tsx in-process and runs the CLI.
  // If the entry had spawned a child to load the binding, the CLI would report a
  // different pid than the process we launched.
  assert.equal(prov.pid, r.pid, "the process that loaded the binding IS the one we launched — exec, not spawn");
});

test("FG-569 R2 entry (EXECUTED): the FORGE_RELEASE_ID block parses the id straight out of a real manifest", () => {
  // Relocated from release.test.ts (a spawn is a fast-tier violation). An sh that
  // reads a real manifest must set the id (the release's own id). Rip out just the
  // FORGE_RELEASE_ID block and run it — no interpreter/loader needed.
  const entry = renderEntry("/opt/node-24/bin/node");
  // FG-571 wrapped this block in the fail-closed identity guard, which derives the
  // manifest path into $__forge_m first — so the slice starts there rather than at the
  // read loop. The property under test is unchanged: a real manifest yields its own id.
  const block = entry.slice(entry.indexOf("__forge_m=$here/"), entry.indexOf("\n\nexec"));
  const dir = mkdtempSync(join(workspace, "r2entry-"));
  writeFileSync(join(dir, RELEASE_MANIFEST_NAME), JSON.stringify({ schema: 1, id: "release-feedb0d-9xk2z", commit: "feedb0d" }, null, 2) + "\n");
  const run = spawnSync("/bin/sh", ["-c", `here=${dir}\n${block}\nprintf '%s' "$FORGE_RELEASE_ID"`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "release-feedb0d-9xk2z", "the entry's shell parses the id straight out of its manifest");
});

test("FG-569 entry (EXECUTED under /bin/sh): the $here derivation resolves a leading-dash release dir without `cd --`", () => {
  // A conforming /bin/sh gives the `cd` builtin no `--` operand separator, so the old
  // `cd -- "$d"` cd'd into a directory named `--`. Rip out just the dir-derivation block
  // (from the `case ... d=${p%/*}` line through the `here=` cd) and run it under the real
  // /bin/sh with $0 pointing at an entry inside a directory whose name starts with `-`.
  const entry = renderEntry("/opt/node-24/bin/node");
  const start = entry.indexOf(`case "$p" in */*) d=`);
  // FG-571 made this cd PHYSICAL (-P) so a release reached as `$FORGE_HOME/current/forge`
  // resolves $here to the release itself rather than to the pointer — the leading-dash
  // property this test owns is unchanged by that.
  const hereLine = `here=$(CDPATH= cd -P "$d" && pwd)`;
  const block = entry.slice(start, entry.indexOf(hereLine) + hereLine.length);
  const dashDir = join(workspace, "-dashy-release");
  mkdirSync(dashDir, { recursive: true });
  // p is RELATIVE (cwd=workspace) so $d = `-dashy-release` literally starts with `-`,
  // the exact operand that `cd --` was meant to disarm and a conforming cd would reject.
  const run = spawnSync("/bin/sh", ["-c", `p='-dashy-release/entry'\n${block}\nprintf '%s' "$here"`], { encoding: "utf8", cwd: workspace });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, dashDir, "the entry's shell cd'd into the real leading-dash release dir, not a dir named `--`");
});

test("FG-569 MUST-FIX 1 (EXECUTED THROUGH A SYMLINK, NO node on PATH): the release entry resolves its release root through a promotion symlink under a hostile PATH", () => {
  // A promoted release is reached via a `current`/PATH symlink, so $0 is the
  // symlink, not the release file. The entry must canonicalize $0 first, else
  // $here/src/cli/index.ts resolves next to the symlink and node can't find it.
  // Run it under a node-free PATH: the canonicalization must NOT reach for a
  // PATH-resolved `readlink` (the old shape), or the promised current/PATH symlink
  // breaks in exactly the hostile environment the whole closure exists to survive.
  const link = join(workspace, "forge-current-link");
  symlinkSync(built.entryPath, link);
  const emptyDir = mkdtempSync(join(workspace, "symlink-nopath-"));
  const env = { PATH: emptyDir, HOME: process.env.HOME ?? "/tmp", FORGE_HOME: process.env.FORGE_HOME ?? "" };
  const r = spawnSync(link, ["release", "provenance", "--json"], { encoding: "utf8", env });
  assert.equal(r.status, 0, `release entry via symlink failed under a node-free PATH: ${r.stderr}`);
  const prov = JSON.parse(r.stdout);
  assert.equal(prov.release.id, built.manifest.id, "the symlinked entry located its OWN release manifest through the symlink");
  assert.equal(prov.bindingLoads, true, "and loaded the closure's native binding");
});

test("FG-569 bundled assets (EXECUTED, NO node on PATH): `forge init` runs FROM THE RELEASE, resolving seeds/ and scripts/ module-relative to the closure", () => {
  // The release claims to be self-contained, but shipped commands read bundled
  // assets MODULE-RELATIVE to the release root: `forge init` renders CLAUDE.md
  // from seeds/orchestrator-template.md and installs the commit-msg hook from
  // scripts/git-hooks/. If the build shipped only src/+node_modules, init would
  // die looking for its own seeds. Run the entry under a node-free PATH against a
  // fresh git project and prove BOTH assets resolved from inside the release.
  assert.ok(existsSync(join(built.releaseDir, "seeds")), "seeds/ is bundled into the closure");
  assert.ok(existsSync(join(built.releaseDir, "scripts")), "scripts/ is bundled into the closure");
  assert.ok(existsSync(join(built.releaseDir, "docker")), "docker/ is bundled into the closure");
  // The claim is scoped honestly to the control plane — the release does NOT run the dashboard.
  assert.equal(built.manifest.selfContainedFor, "control-plane", "the manifest scopes self-containment to the control-plane command set");

  const project = mkdtempSync(join(workspace, "init-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: project });

  const emptyDir = mkdtempSync(join(workspace, "init-nopath-"));
  const env = { PATH: emptyDir, HOME: process.env.HOME ?? "/tmp", FORGE_HOME: process.env.FORGE_HOME ?? "" };
  const r = spawnSync(built.entryPath, ["init", "--project", project, "--prefix", "TST"], { encoding: "utf8", env });
  assert.equal(r.status, 0, `forge init from the release failed: ${r.stderr}`);

  const claudeMd = join(project, "CLAUDE.md");
  assert.ok(existsSync(claudeMd), "init wrote CLAUDE.md");
  const body = readFileSync(claudeMd, "utf8");
  assert.match(body, /<!-- forge:orchestrator-start -->/, "CLAUDE.md carries the seed-rendered orchestrator block — seeds/ resolved from the release");
  assert.match(body, /You are this project's forge orchestrator/, "the block body is the bundled seed's content");

  const hook = join(project, ".git", "hooks", "commit-msg");
  assert.ok(existsSync(hook), "the commit-msg hook installed from scripts/git-hooks/ — scripts/ resolved from the release");
});

test("FG-569 closure: a symlinked node_modules dependency is DEREFERENCED into the release, not left pointing outside it", () => {
  // An npm-linked (or otherwise absolute-target) dependency is a symlink in
  // node_modules pointing OUTSIDE the source tree. Preserving it verbatim would
  // ship a link that loads mutable host code after the source moves/changes —
  // not a self-contained closure. The build must copy the real bytes instead.
  const src = mkdtempSync(join(workspace, "symlink-src-"));
  execFileSync("git", ["init", "-q"], { cwd: src });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: src });
  mkdirSync(join(src, "src"));
  // A tracked src/ file so the committed-snapshot archive has content to materialize (git
  // does not track an empty dir; archive errors on a pathspec matching nothing tracked).
  writeFileSync(join(src, "src", "index.ts"), "export {};\n");
  writeFileSync(join(src, "package.json"), `{"name":"symlink-src"}`);
  writeFileSync(join(src, "package-lock.json"), `{"name":"symlink-src","lockfileVersion":3}`);
  // The real, complete node_modules so the closure gate (better-sqlite3 loads +
  // the full tsx dep tree) passes — the external link below is what's under test.
  cpSync(join(sourceRoot, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  // The linked dependency lives OUTSIDE the source tree; node_modules only links to it.
  const external = mkdtempSync(join(workspace, "external-linked-"));
  writeFileSync(join(external, "index.js"), `module.exports = "from the external host location";\n`);
  writeFileSync(join(external, "package.json"), `{"name":"linked-dep","main":"index.js"}`);
  symlinkSync(external, join(src, "node_modules", "linked-dep"));
  copyBundledAssets(src);
  commitSource(src);

  const out = join(workspace, "symlink-release");
  buildRelease({ sourceRoot: src, outDir: out });

  const copied = join(out, "node_modules", "linked-dep");
  assert.ok(!lstatSync(copied).isSymbolicLink(), "the linked dependency is a real directory in the release, not a symlink");
  assert.ok(existsSync(join(copied, "index.js")), "the linked dependency's actual bytes are inside the closure");
  // The whole closure is link-free: no .bin / hoisted / linked dependency survives
  // as a symlink that could point out of the release.
  assert.equal(firstSymlink(join(out, "node_modules")), null, "the release node_modules contains NO symlinks");
  // Prove self-containment: destroy the external source, the release still has it.
  rmSync(external, { recursive: true, force: true });
  assert.ok(existsSync(join(copied, "index.js")), "the release no longer depends on the external host location");
});

/** The first symlink found under `dir` (depth-first), or null if the tree is
 *  link-free — a release that closes over its own bytes. */
function firstSymlink(dir: string): string | null {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) return p;
    if (ent.isDirectory()) {
      const found = firstSymlink(p);
      if (found) return found;
    }
  }
  return null;
}

test("FG-569 lockfile binding (RED pre-fix, GREEN after): a content-mutated installed dependency with a BYTE-IDENTICAL lockfile is REFUSED", () => {
  // The prior fix hashed the lockfile bytes — that proves only WHICH lockfile was
  // copied, NOT that the installed node_modules matches it. A dependency mutated in
  // place, with package-lock.json left byte-identical, slipped straight through and
  // was copied into the release. This binds the SHIPPED closure to the lockfile, so
  // that tamper is refused. Against the pre-binding builder this test is RED (the
  // mutant builds); with the binding it is GREEN (the mutant is refused).
  const src = mkdtempSync(join(workspace, "lockbind-src-"));
  execFileSync("git", ["init", "-q"], { cwd: src });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: src });
  mkdirSync(join(src, "src"));
  // A tracked src/ file so the committed-snapshot archive has content to materialize
  // (git does not track an empty dir; archive errors on a pathspec matching nothing).
  writeFileSync(join(src, "src", "index.ts"), "export {};\n");
  // Build from THIS project's real lockfile + node_modules, so the npm cache holds
  // every pinned tarball (the scratch install populated it) and the binding has an
  // authentic tarball to compare each shipped dependency against.
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(sourceRoot, f), join(src, f));
  cpSync(join(sourceRoot, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  copyBundledAssets(src);
  commitSource(src);

  // Untampered: the SAME tree builds cleanly — the binding never false-refuses a
  // node_modules that genuinely matches its lockfile.
  buildRelease({ sourceRoot: src, outDir: join(workspace, "lockbind-clean") });

  // The mutant: a pure (no install-script), types-only leaf dependency. Appending a
  // valid comment keeps it loadable (it is never required at runtime) but changes
  // its bytes, while package-lock.json stays BYTE-IDENTICAL — exactly the tamper the
  // lockfile-hash gate is blind to.
  const victim = join(src, "node_modules", "undici-types", "index.d.ts");
  assert.ok(existsSync(victim), "the mutation-target dependency (undici-types) is installed");
  const lockBefore = readFileSync(join(src, "package-lock.json"));
  appendFileSync(victim, "\n// FG-569 tamper: valid TypeScript, still loads, lockfile untouched\n");
  assert.deepEqual(readFileSync(join(src, "package-lock.json")), lockBefore, "the tamper left package-lock.json byte-identical");

  assert.throws(
    () => buildRelease({ sourceRoot: src, outDir: join(workspace, "lockbind-tampered") }),
    /shipped closure does not match the lockfile/i,
    "the builder must REFUSE a content-mutated dependency whose lockfile is unchanged",
  );
  assert.ok(!existsSync(join(workspace, "lockbind-tampered")), "a refused build leaves no release directory behind");
});

test("FG-569 torn closure: a MISSING native binding is REFUSED at build, and no release directory is produced", () => {
  const torn = mkdtempSync(join(workspace, "torn-missing-"));
  mkdirSync(join(torn, "src"));
  writeFileSync(join(torn, "package.json"), `{"name":"torn"}`);
  writeFileSync(join(torn, "package-lock.json"), `{"name":"torn","lockfileVersion":3}`);
  // better-sqlite3 present but its compiled binding is absent — a torn closure.
  mkdirSync(join(torn, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });

  const out = join(workspace, "torn-missing-release");
  assert.throws(() => buildRelease({ sourceRoot: torn, outDir: out }), /torn closure/i);
  assert.ok(!existsSync(out), "a refused build leaves no release directory behind");
});

test("FG-569 FIX 5: the COPIED-closure gate REJECTS a release whose tsx loader can't load (the entry would not start)", () => {
  // A dir with the loader shim but no tsx: `node --import forge-loader.mjs` fails
  // at `import "tsx"`. assertReleaseCloses must catch it — a release can otherwise
  // pass the better-sqlite3 gate yet fail to run because tsx is missing.
  const noTsx = mkdtempSync(join(workspace, "no-tsx-"));
  writeFileSync(join(noTsx, RELEASE_LOADER_NAME), `import "tsx";\n`);
  assert.throws(() => assertReleaseCloses(noTsx, process.execPath), /tsx loader did not run/i);
});

test("FG-569 FIX 4: the COPIED-closure gate REJECTS a release whose OWN binding was corrupted post-copy (the source gate cannot)", () => {
  // Build a valid release, then corrupt its OWN copied binding. The source gate ran
  // BEFORE the copy, so only a gate over the COPY catches this. assertReleaseCloses
  // loads the release's own binding under the pinned interpreter and must throw.
  const rel = buildRelease({ sourceRoot, outDir: join(workspace, "corrupt-copy-release") });
  // The build freezes the closure (files read-only), so make this one file writable
  // before corrupting it — the tamper we then prove assertReleaseCloses catches.
  const binding = join(rel.releaseDir, RELEASE_BINDING_REL);
  chmodSync(binding, 0o644);
  writeFileSync(binding, "not a real .node\n");
  assert.throws(
    () => assertReleaseCloses(rel.releaseDir, process.execPath),
    /torn closure — the COPIED better-sqlite3 binding/i,
  );
});

test("FG-569 torn closure: a CORRUPT / ABI-mismatched native binding is REFUSED at build (it cannot load)", () => {
  const torn = mkdtempSync(join(workspace, "torn-corrupt-"));
  mkdirSync(join(torn, "src"));
  writeFileSync(join(torn, "package.json"), `{"name":"torn"}`);
  writeFileSync(join(torn, "package-lock.json"), `{"name":"torn","lockfileVersion":3}`);
  // Real better-sqlite3 JS + its runtime deps, so require() reaches the binding —
  // then corrupt the binding so the load throws exactly as a torn closure would.
  for (const dep of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const from = join(sourceRoot, "node_modules", dep);
    if (existsSync(from)) cpSync(from, join(torn, "node_modules", dep), { recursive: true });
  }
  writeFileSync(join(torn, RELEASE_BINDING_REL), "not a real .node\n");

  const out = join(workspace, "torn-corrupt-release");
  assert.throws(() => buildRelease({ sourceRoot: torn, outDir: out }), /torn closure/i);
  assert.ok(!existsSync(out), "a refused build leaves no release directory behind");
});

/** A git-initialized buildable source with THIS project's real node_modules +
 *  package.json (so the closure gates pass and the npm cache holds every pinned
 *  tarball for the byte-binding). The caller adds whichever lockfile(s) the test
 *  exercises. */
function makeLockSource(label: string): string {
  const src = mkdtempSync(join(workspace, label));
  execFileSync("git", ["init", "-q"], { cwd: src });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: src });
  mkdirSync(join(src, "src"));
  // A tracked file under src/ so the committed snapshot (git archive <commit> -- src …) has
  // content to materialize — git does not track an empty directory, and archive fatally
  // errors on a pathspec that matches no tracked files. Real sources always carry src/*.
  writeFileSync(join(src, "src", "index.ts"), "export {};\n");
  cpSync(join(sourceRoot, "package.json"), join(src, "package.json"));
  cpSync(join(sourceRoot, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  copyBundledAssets(src);
  return src;
}

test("FG-569 Finding 4 (lockfile selection): a package-lock-only source builds and binds+manifests against package-lock.json", () => {
  const src = makeLockSource("lock-pl-only-");
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);

  const rel = buildRelease({ sourceRoot: src, outDir: join(workspace, "lock-pl-only-rel") });
  assert.equal(rel.manifest.lockfile.name, "package-lock.json", "the manifest names the only lockfile present");
  assert.ok(existsSync(join(rel.releaseDir, "package-lock.json")), "the selected lockfile is copied into the release");
});

test("FG-569 Finding 4 (lockfile selection): a shrinkwrap-only source builds — binds+manifests against npm-shrinkwrap.json, NO false failure", () => {
  // The prior hole: lockfileIdentity accepted npm-shrinkwrap.json but the byte-binding
  // hardcoded package-lock.json, so a shrinkwrap-only source always failed the binding.
  const src = makeLockSource("lock-sw-only-");
  // npm-shrinkwrap.json has the same shape as package-lock.json, so reuse the real one.
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "npm-shrinkwrap.json"));
  commitSource(src);

  const rel = buildRelease({ sourceRoot: src, outDir: join(workspace, "lock-sw-only-rel") });
  assert.equal(rel.manifest.lockfile.name, "npm-shrinkwrap.json", "the manifest names the shrinkwrap it bound against");
  assert.ok(existsSync(join(rel.releaseDir, "npm-shrinkwrap.json")), "the shrinkwrap is copied into the release");
  assert.ok(!existsSync(join(rel.releaseDir, "package-lock.json")), "no package-lock.json was invented");
  const shipped = readFileSync(join(rel.releaseDir, "npm-shrinkwrap.json"));
  assert.equal(rel.manifest.lockfile.sha256, createHash("sha256").update(shipped).digest("hex"), "the manifest sha is of the SHIPPED shrinkwrap bytes");
});

test("FG-569 Finding 4 (lockfile selection): both present ⇒ shrinkwrap WINS for copy, verify, and manifest", () => {
  const src = makeLockSource("lock-both-");
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "npm-shrinkwrap.json"));
  // A DECOY package-lock.json that, if it were the one selected, would FAIL the
  // byte-binding (it pins a package that isn't installed / isn't in the npm cache).
  // A clean build therefore proves the shrinkwrap — not this file — was selected.
  writeFileSync(
    join(src, "package-lock.json"),
    JSON.stringify({ name: "decoy", lockfileVersion: 3, packages: { "node_modules/not-installed": { integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", resolved: "https://example.invalid/x.tgz" } } }, null, 2),
  );
  commitSource(src);

  const rel = buildRelease({ sourceRoot: src, outDir: join(workspace, "lock-both-rel") });
  assert.equal(rel.manifest.lockfile.name, "npm-shrinkwrap.json", "shrinkwrap wins the manifest identity");
  assert.ok(existsSync(join(rel.releaseDir, "npm-shrinkwrap.json")), "shrinkwrap is the lockfile copied into the release");
  assert.ok(!existsSync(join(rel.releaseDir, "package-lock.json")), "the decoy package-lock.json was NOT copied — shrinkwrap won the copy");
  const shipped = readFileSync(join(rel.releaseDir, "npm-shrinkwrap.json"));
  assert.equal(rel.manifest.lockfile.sha256, createHash("sha256").update(shipped).digest("hex"), "the manifest sha is of the shrinkwrap, not the decoy");
});

test("FG-569 GAP 1 (install-script pkg, RED pre-fix / GREEN after): a TARBALL-OWNED source file of an install-script package, mutated in place with the lockfile byte-identical, is REFUSED", () => {
  // The old gate skipped every hasInstallScript package (better-sqlite3, esbuild,
  // sharp) — dropping their tarball-owned SOURCE from the binding, the highest-risk
  // files. This proves the skip is gone: a benign in-place mutation of a tarball-owned
  // better-sqlite3 source file, with package-lock.json left byte-identical, is refused.
  const src = makeLockSource("gap1-installscript-");
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);

  // Untampered: the SAME real tree — which INCLUDES the install-script packages —
  // builds cleanly. No false refusal from a generated artifact (the compiled
  // better_sqlite3.node / downloaded platform binaries are not tarball entries) nor
  // from esbuild's install-rewritten bin/esbuild (the one narrow per-file allowance).
  buildRelease({ sourceRoot: src, outDir: join(workspace, "gap1-clean") });

  // Mutate a TARBALL-OWNED source file of an install-script package. A trailing no-op
  // comment keeps better-sqlite3 loadable and leaves package-lock.json BYTE-IDENTICAL
  // — exactly the tamper the hasInstallScript skip waved straight through.
  const victim = join(src, "node_modules", "better-sqlite3", "lib", "index.js");
  assert.ok(existsSync(victim), "the install-script package's tarball-owned source file is present");
  const lockBefore = readFileSync(join(src, "package-lock.json"));
  appendFileSync(victim, "\n// FG-569 tamper: valid no-op JS, still loads, lockfile untouched\n");
  assert.deepEqual(readFileSync(join(src, "package-lock.json")), lockBefore, "the tamper left package-lock.json byte-identical");
  // The mutated package still opens a DB — the tamper is benign, so ONLY the shipped-
  // closure binding stands between it and a release.
  const req = createRequire(join(src, "package.json"));
  const Database = req("better-sqlite3") as new (p: string) => { close(): void };
  const db = new Database(":memory:");
  db.close();

  assert.throws(
    () => buildRelease({ sourceRoot: src, outDir: join(workspace, "gap1-tampered") }),
    /shipped closure does not match the lockfile/i,
    "a tampered TARBALL-OWNED file of an install-script package must be REFUSED — hasInstallScript no longer exempts it",
  );
  assert.ok(!existsSync(join(workspace, "gap1-tampered")), "a refused build leaves no release directory behind");
});

test("FG-569 GAP 2 (dirty source, RED pre-fix / GREEN after): an uncommitted change under src/ is REFUSED so the manifest commit can never lie about the shipped bytes", () => {
  const src = makeLockSource("gap2-dirty-src-");
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);
  // Baseline: the committed tree builds — refuse-dirty does not false-refuse a clean source.
  buildRelease({ sourceRoot: src, outDir: join(workspace, "gap2-clean") });
  const cleanHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }).trim();

  // A VALID uncommitted change under src/ — copied into the release, but HEAD still
  // names the clean commit. Pre-fix this SUCCEEDED and the manifest claimed cleanHead,
  // a commit that does NOT describe the shipped bytes. Post-fix it is refused.
  writeFileSync(join(src, "src", "uncommitted-feature.ts"), "export const x = 1;\n");
  assert.notEqual(
    execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: src, encoding: "utf8" }).trim(),
    "",
    "src/ is genuinely dirty relative to HEAD",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }).trim(),
    cleanHead,
    "HEAD still points at the clean commit while the working tree carries an uncommitted src/ change",
  );

  assert.throws(
    () => buildRelease({ sourceRoot: src, outDir: join(workspace, "gap2-dirty") }),
    /refusing to build a release from a dirty source/i,
    "buildRelease must REFUSE a dirty source — else the recorded commit describes bytes it did not produce",
  );
  assert.ok(!existsSync(join(workspace, "gap2-dirty")), "a refused build leaves no release directory behind");
});

test("FG-569 TOCTOU (snapshot from commit, RED pre-fix / GREEN after): a LIVE-tree mutation landing after the commit is captured does NOT change the shipped bytes — the release ships the COMMITTED bytes", () => {
  // The TOCTOU the live-cpSync builder could not close: a concurrent editor modifies a
  // commit-bound file DURING the copy (even restoring the committed bytes before any
  // post-copy recheck), so the release shipped transient bytes under a manifest `commit`
  // that did not describe them. The fix materializes git-tracked paths from the COMMITTED
  // SNAPSHOT (git archive <commit>), never the live tree, so a live edit inside the build
  // window cannot leak in. Against the old live-cpSync builder this is RED (it ships the live
  // bytes); against the snapshot builder it is GREEN (it ships the committed bytes).
  const src = makeLockSource("toctou-snapshot-");
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "package-lock.json"));
  // A representative commit-bound file with KNOWN committed content.
  const relPosix = "src/toctou-marker.ts";
  const marker = join(src, "src", "toctou-marker.ts");
  const committedText = "export const committed = true;\n";
  writeFileSync(marker, committedText);
  commitSource(src);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }).trim();
  const committedBytes = execFileSync("git", ["show", `${commit}:${relPosix}`], { cwd: src, encoding: "buffer" });
  assert.equal(committedBytes.toString(), committedText, "the committed blob is the content we committed");

  // Baseline: a quiescent build ships the committed bytes.
  const clean = buildRelease({ sourceRoot: src, outDir: join(workspace, "toctou-snapshot-clean") });
  assert.deepEqual(readFileSync(join(clean.releaseDir, relPosix)), committedBytes, "a quiescent build ships the committed bytes");
  assert.equal(clean.manifest.commit, commit, "and records the commit those bytes come from");

  // The race: dirty the LIVE file AFTER the commit is captured (inside the build window). The
  // up-front dirty-check already passed on the clean tree; the seam fires before the snapshot
  // is materialized. The snapshot copy reads the commit's objects, so the live mutation is a
  // no-op on the shipped bytes.
  const liveMutation = "export const committed = false; // LIVE MUTATION — not in the commit\n";
  const raced = buildRelease({
    sourceRoot: src,
    outDir: join(workspace, "toctou-snapshot-raced"),
    onBeforeSnapshot: () => writeFileSync(marker, liveMutation),
  });
  const shipped = readFileSync(join(raced.releaseDir, relPosix));
  assert.deepEqual(shipped, committedBytes, "the SHIPPED git-tracked bytes equal the COMMITTED bytes (git show <commit>:<path>)");
  assert.notDeepEqual(shipped, Buffer.from(liveMutation), "the live mutation did NOT leak into the release — RED against a live-cpSync builder");
  assert.equal(readFileSync(marker, "utf8"), liveMutation, "the live working tree really was mutated to differ from the commit at copy time");
  assert.equal(raced.manifest.commit, commit, "the manifest commit still describes the shipped (committed) bytes");

  // Restore the working tree (HEAD is unchanged, so this returns the committed bytes) before
  // the next build, whose up-front dirty-check requires a clean tree.
  execFileSync("git", ["checkout", "--", relPosix], { cwd: src });

  // A concurrent COMMIT moving HEAD during the window is likewise ignored: the snapshot is of
  // the ORIGINALLY captured commit, so the release ships THAT commit's bytes, not the new one.
  const moved = buildRelease({
    sourceRoot: src,
    outDir: join(workspace, "toctou-snapshot-moved"),
    onBeforeSnapshot: () => {
      writeFileSync(marker, liveMutation);
      execFileSync("git", ["add", "--", "src"], { cwd: src });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "concurrent commit"], { cwd: src });
    },
  });
  assert.deepEqual(readFileSync(join(moved.releaseDir, relPosix)), committedBytes, "a concurrent commit during the window does not change the shipped snapshot bytes");
  assert.equal(moved.manifest.commit, commit, "the manifest still records the commit the snapshot was taken from");
});

test("FG-569 GAP 2 (builder identity): builderCommit is recorded and EQUALS commit on a normal self-build (builder and source are one checkout)", () => {
  const m = built.manifest;
  assert.match(m.builderCommit, /^[0-9a-f]{40}$/, "the builder's own commit is recorded in the manifest");
  assert.equal(m.builderCommit, m.commit, "on a self-build the builder IS the source checkout, so the two commits are equal");
  assert.equal(
    m.commit,
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    "and both name the committed source HEAD the release was built from",
  );
});

test("FG-569 Resolution B (dashboard refusal, EXECUTED, NO node on PATH): `forge dashboard` refuses in release mode — named, nonzero — before resolving dashboard/", () => {
  // The dashboard is a SEPARATE workspace, deliberately not bundled. Run from the built
  // release under a node-free PATH: both the bare command and `dashboard start` must exit
  // nonzero with the named refusal, never the confusing "could not locate the dashboard
  // workspace" from resolveForgeRoot (which would mean it tried to resolve dashboard/ first).
  for (const args of [["dashboard"], ["dashboard", "start"]]) {
    const { r } = runEntryUnderHostilePath(args);
    assert.notEqual(r.status, 0, `forge ${args.join(" ")} must exit nonzero in release mode: ${r.stdout}`);
    assert.match(r.stderr, /not available from a control-plane release build/i, `named refusal for: ${args.join(" ")}`);
    assert.match(r.stderr, /FG-572|Child 5/, "the refusal points at the later owner");
    assert.doesNotMatch(r.stderr, /could not locate the dashboard workspace/i, "it refused BEFORE resolving dashboard/src/server.ts");
  }
});

test("FG-569 Resolution B (dirty seed/hook REFUSED at build): an uncommitted edit to a bundled seed OR script refuses the build — the manifest commit would not describe the shipped bytes", () => {
  const src = makeLockSource("dirty-asset-");
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);
  // Baseline: the committed tree (with real seeds/scripts/docker) builds cleanly.
  buildRelease({ sourceRoot: src, outDir: join(workspace, "dirty-asset-clean") });

  // (a) Dirty a bundled SEED — appending a comment keeps it valid but makes seeds/ dirty
  // relative to HEAD, so the commit binding no longer describes the shipped seed bytes.
  const seed = join(src, "seeds", "orchestrator-template.md");
  assert.ok(existsSync(seed), "the bundled seed is present in the fixture");
  appendFileSync(seed, "\n<!-- FG-569 uncommitted seed edit -->\n");
  assert.throws(
    () => buildRelease({ sourceRoot: src, outDir: join(workspace, "dirty-seed-rel") }),
    /refusing to build a release from a dirty source/i,
    "a dirty bundled SEED must refuse the build",
  );
  assert.ok(!existsSync(join(workspace, "dirty-seed-rel")), "a refused build leaves no release behind");

  // (b) Commit the seed, then dirty a bundled SCRIPT — proves scripts/ is bound too.
  commitSource(src);
  const script = join(src, "scripts", "install-seeds.sh");
  assert.ok(existsSync(script), "the bundled script is present in the fixture");
  appendFileSync(script, "\n# FG-569 uncommitted script edit\n");
  assert.throws(
    () => buildRelease({ sourceRoot: src, outDir: join(workspace, "dirty-script-rel") }),
    /refusing to build a release from a dirty source/i,
    "a dirty bundled SCRIPT must refuse the build",
  );
  assert.ok(!existsSync(join(workspace, "dirty-script-rel")), "a refused build leaves no release behind");
});

test("FG-569 Resolution B (required asset missing): a source lacking a bundled asset dir is REFUSED as a torn closure, no release produced", () => {
  const src = makeLockSource("missing-asset-");
  cpSync(join(sourceRoot, "package-lock.json"), join(src, "package-lock.json"));
  // Remove a required asset dir that makeLockSource copied — the closure gate (binding)
  // passes, so this proves the DEDICATED required-asset refusal, not an optional skip.
  rmSync(join(src, "docker"), { recursive: true, force: true });
  commitSource(src);
  assert.throws(
    () => buildRelease({ sourceRoot: src, outDir: join(workspace, "missing-asset-rel") }),
    /torn closure — required asset directory 'docker'/i,
    "a missing required asset dir must REFUSE the build, not silently skip it",
  );
  assert.ok(!existsSync(join(workspace, "missing-asset-rel")), "a refused build leaves no release behind");
});

/** A full, committed COPY of this project (real src/ + node_modules + bundled assets)
 *  as an isolated git checkout, so a release built from it can have its source RENAMED
 *  away and the release still proven to run with NO source-checkout fallback. */
function makeFullSource(label: string): string {
  const src = mkdtempSync(join(workspace, label));
  execFileSync("git", ["init", "-q"], { cwd: src });
  for (const rel of ["src", "package.json", "package-lock.json", "seeds", "scripts", "docker"]) {
    const from = join(sourceRoot, rel);
    if (existsSync(from)) cpSync(from, join(src, rel), { recursive: true, dereference: true });
  }
  cpSync(join(sourceRoot, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  commitSource(src);
  return src;
}

test("FG-569 successor build (EXECUTED, RED pre-fix / GREEN after): release A builds release B from a clean checkout, B runs, and B records A's builder identity SEPARATELY from B's source commit", () => {
  // The HIGH production-path gap: a BUILT release must be able to build its successor.
  // Pre-fix, builderRoot() = findGitRoot(<release>/src/v2); a release has no .git, so
  // it fell back to <release>/src/v2 (no lockfile there) and `forge release build` from
  // the release exited 1 with "no lockfile … at <release>/src/v2". The control runtime
  // could not build the next release. Here we EXECUTE release A's own entry to build B.
  assert.ok(!existsSync(join(built.releaseDir, ".git")), "release A is an immutable copy — it has NO .git (the crux of the bug)");

  // B's source: an isolated, committed clean checkout whose HEAD is DISTINCT from A's
  // commit — so builderCommit (A's) vs commit (B's source) are provably separate SHAs.
  const bSource = makeFullSource("successor-bsrc-");
  const bSourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: bSource, encoding: "utf8" }).trim();
  assert.notEqual(bSourceHead, built.manifest.commit, "B's source HEAD differs from A's commit — the separation is observable");

  // Run `release-A/forge release build --source <bSource> --out <releaseB>` — release A's
  // OWN entry (its pinned interpreter, its own src/v2/release.ts). This is the exact
  // command that exited 1 pre-fix. git/npm come from the inherited PATH (the build shells
  // out to them); the entry needs no node on PATH — it execs A's pinned interpreter.
  const releaseB = join(workspace, "successor-releaseB");
  const buildR = spawnSync(built.entryPath, ["release", "build", "--source", bSource, "--out", releaseB, "--json"], { encoding: "utf8", env: process.env });
  assert.equal(buildR.status, 0, `release A failed to build successor B: ${buildR.stderr}`);
  const bResult = JSON.parse(buildR.stdout) as { manifest: { commit: string; builderCommit: string; id: string }; entryPath: string };

  // B RUNS — a real command from the freshly built successor.
  const verR = spawnSync(bResult.entryPath, ["--version"], { encoding: "utf8", env: process.env });
  assert.equal(verR.status, 0, `successor release B did not run: ${verR.stderr}`);
  assert.match(verR.stdout.trim(), /^\d+\.\d+\.\d+/, "release B's --version prints from its own package.json");

  // The two identities are recorded SEPARATELY:
  //  - builderCommit == A's manifest commit (WHO built B — A's trusted builder identity),
  //  - commit        == B's source HEAD       (WHAT B was built from).
  assert.equal(bResult.manifest.builderCommit, built.manifest.commit, "B's builderCommit is release A's OWN commit (A built B)");
  assert.equal(bResult.manifest.commit, bSourceHead, "B's commit is B's --source HEAD");

  // MUTATION PROOF: if the release-builder path had used the --source commit (B's source)
  // for builderCommit instead of A's manifest commit, builderCommit would EQUAL commit —
  // this assertion goes RED for that substitution, killing the mutant.
  assert.notEqual(bResult.manifest.builderCommit, bResult.manifest.commit, "builderCommit is A's identity, NOT B's source commit — substituting the source commit must go RED");
});

test("FG-569 Resolution B (EXECUTED, SOURCE RENAMED AWAY): supported commands run FROM THE RELEASE with the source checkout inaccessible — no fallback", () => {
  // The sharpest proof of self-containment for the control-plane set: build a release
  // from an isolated source, then RENAME the source away so it cannot be resolved, and
  // exercise the release's own entry. Every supported command must run from the release's
  // OWN bundled bytes; forge dashboard must refuse (release mode) rather than reach out.
  const fullSrc = makeFullSource("srcgone-");
  const built2 = buildRelease({ sourceRoot: fullSrc, outDir: join(workspace, "srcgone-release") });
  renameSync(fullSrc, `${fullSrc}.GONE`);
  assert.ok(!existsSync(fullSrc), "the source checkout is now inaccessible");

  const nopath = mkdtempSync(join(workspace, "srcgone-nopath-"));
  const baseEnv = { PATH: nopath, HOME: process.env.HOME ?? "/tmp", FORGE_HOME: process.env.FORGE_HOME ?? "" };

  // 1) forge init SUCCEEDS from the release's OWN bundled seeds/ + scripts/ (source gone).
  const project = mkdtempSync(join(workspace, "srcgone-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  const initR = spawnSync(built2.entryPath, ["init", "--project", project, "--prefix", "TST"], { encoding: "utf8", env: baseEnv });
  assert.equal(initR.status, 0, `forge init from the release (source gone) failed: ${initR.stderr}`);
  assert.match(readFileSync(join(project, "CLAUDE.md"), "utf8"), /<!-- forge:orchestrator-start -->/, "init rendered CLAUDE.md from the release's bundled seed");
  assert.ok(existsSync(join(project, ".git", "hooks", "commit-msg")), "init installed the git hook from the release's bundled scripts/");

  // 2) forge dashboard REFUSES in release mode — nonzero + named — without consulting the source.
  const dashR = spawnSync(built2.entryPath, ["dashboard"], { encoding: "utf8", env: baseEnv });
  assert.notEqual(dashR.status, 0, "forge dashboard must refuse in release mode");
  assert.match(dashR.stderr, /not available from a control-plane release build/i, "named release-mode refusal");

  // 3) A representative set of OTHER supported commands START without the source checkout.
  const verR = spawnSync(built2.entryPath, ["--version"], { encoding: "utf8", env: baseEnv });
  assert.equal(verR.status, 0, `--version failed: ${verR.stderr}`);
  assert.match(verR.stdout.trim(), /^\d+\.\d+\.\d+/, "forge --version prints a version from the release's package.json");

  const forgeHome = mkdtempSync(join(workspace, "srcgone-fh-"));
  const statR = spawnSync(built2.entryPath, ["status", "--json"], { encoding: "utf8", env: { ...baseEnv, FORGE_HOME: forgeHome } });
  assert.equal(statR.status, 0, `status --json failed: ${statR.stderr}`);
  assert.doesNotThrow(() => JSON.parse(statR.stdout), "status --json emitted valid JSON from the release");
  assert.doesNotMatch(statR.stderr, /\.GONE/, "status did not try to reach the renamed-away source checkout");

  // 4) provenance runs — the native binding loads from the RELEASE's OWN node_modules.
  const provR = spawnSync(built2.entryPath, ["release", "provenance", "--json"], { encoding: "utf8", env: baseEnv });
  assert.equal(provR.status, 0, `release provenance failed: ${provR.stderr}`);
  assert.equal(JSON.parse(provR.stdout).bindingLoads, true, "the closure's binding loaded from the release, source gone");
});
