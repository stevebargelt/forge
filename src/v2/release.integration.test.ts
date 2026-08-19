// FG-569 (FG-553 Child 2) — the release closure + R1 provenance, EXECUTED.
//
// This builds a REAL release from the running project (a full node_modules incl.
// the compiled better-sqlite3 binding) and then EXECUTES the release entry under
// a hostile PATH — including one with NO node on PATH at all — asserting the
// runtime FROM THE RUNNING PROCESS, per FG-551 (a grep of bin/forge is hollow;
// running the entry and reading process.execPath is real).
//
// It runs wherever it is invoked from — the checkout, a clone, the forge-test scratch —
// and it NEVER writes to that repository (FG-575). Every release it builds comes from an
// isolated, committed COPY of the invoking tree made under a disposable temp workspace, so
// the closure carries a binding that actually loads and the manifest carries a real commit
// SHA without the suite committing, stashing, or otherwise touching the invoking checkout.
// The last test in this file asserts that invariant over the whole run.
//
// Precondition (shared with the sibling launch-*.integration release tests): the invoking
// checkout's own src/, package.json and lockfile must be committed, because forge refuses to
// build a release from a dirty BUILDER — and this file will not commit them for you. See
// assertBuilderCheckoutIsCommitted below.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, lstatSync, readdirSync, rmSync, renameSync, symlinkSync, appendFileSync, readFileSync, chmodSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { buildRelease, assertReleaseCloses, disposeReleaseWorkspace, renderEntry, RELEASE_BINDING_REL, RELEASE_LOADER_NAME, RELEASE_MANIFEST_NAME, type BuildReleaseResult } from "./release.js";
import { interpreterPath, storedIdentityOf, validatedInterpreter } from "./runtime-store.js";
import { findGitRoot } from "../util/git-root.js";

/** The repository this suite was INVOKED from. READ-ONLY here (FG-575): its bytes are
 *  copied out, but nothing in this file builds from it, commits into it, or writes to it. */
const checkoutRoot = findGitRoot(process.cwd());
let workspace: string;
/** The disposable forge home whose interpreter store these builds install into and pin
 *  (FG-571). Not the ambient FORGE_HOME: a build with no `home` would land a copy of node
 *  in the operator's real ~/.forge/interpreters just for running the suite. */
let buildHome: string;
/** The isolated, committed copy of the invoking checkout's WORKING TREE that every
 *  self-build in this file builds from (FG-575). */
let buildRoot: string;
let built: BuildReleaseResult;
/** The invoking repository's git state at suite start — the AC baseline the last test
 *  in this file compares against. */
let checkoutStateBefore: GitState;
/** FG-698 (AC4) — the top-level names under `workspace` that are SHARED and must outlive
 *  every test: `buildRoot`'s isolated source, the one release the file builds in before(),
 *  and the disposable forge home. Snapshotted at the end of before(); everything else that
 *  appears at the top level of the workspace belongs to ONE test and is disposed of by the
 *  afterEach below, so peak temporary space is bounded by "the shared set + the fixtures of
 *  the test currently running" instead of accumulating across ~30 builds. Undefined until
 *  before() completes — the hooks below tolerate that, because a before() that threw must
 *  not be reported as a teardown crash. */
let pinned: Set<string> | undefined;

type GitState = { head: string; branch: string; status: string; stash: string };

/** Everything the FG-575 invariant covers: which commit, which branch, what is
 *  modified/untracked, and what is stashed. */
function gitState(root: string): GitState {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  return {
    head: git("rev-parse", "HEAD").trim(),
    branch: git("rev-parse", "--abbrev-ref", "HEAD").trim(),
    status: git("status", "--porcelain"),
    stash: git("stash", "list"),
  };
}

/** Commit a buildable tree's SHIPPED source paths (src/, package.json, and any
 *  lockfile) so HEAD describes them — buildRelease now refuses a dirty source
 *  (FG-569 GAP 2). node_modules stays untracked: it is install output bound to the
 *  lockfile separately, not part of the commit's source identity (and it is huge).
 *  A no-op when the tree is already clean.
 *
 *  FG-575: only ever called on a disposable fixture under `workspace`. It used to be
 *  called on the invoking checkout too, which swept an operator's in-progress work into
 *  a `source snapshot` commit authored `t <t@t>`. The guard below makes that regression
 *  fail loudly at the call site instead of silently in someone's branch. */
function commitSource(root: string): void {
  assert.ok(
    root.startsWith(workspace + sep),
    `FG-575: commitSource may only commit into a disposable fixture under ${workspace} — refusing to commit into ${root}`,
  );
  // FG-569 Resolution B: the commit now binds the bundled asset dirs too (seeds/,
  // scripts/, docker/), so a build refuses a dirty seed/hook/docker file. Stage them
  // here alongside src/+package.json+lockfile, else buildRelease would refuse the
  // scratch's synced-but-uncommitted assets.
  // FG-580: the bundled dashboard is commit-bound too — stage it so buildRelease does not
  // refuse the scratch's synced-but-uncommitted dashboard bytes.
  const paths = ["src", "package.json", "seeds", "scripts", "docker", "dashboard"].filter((p) => existsSync(join(root, p)));
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
  // FG-580: the dashboard is a bundled release input now — buildRelease REQUIRES it
  // (assertDashboardClosure), so every buildable fixture must carry the real dashboard/
  // (real bytes, incl. the vendored client libs, so the missing-vendored-lib mutation
  // proof can remove a genuine file).
  for (const asset of ["seeds", "scripts", "docker", "dashboard"]) {
    cpSync(join(checkoutRoot, asset), join(root, asset), { recursive: true, dereference: true });
  }
}

/** An isolated, committed COPY of `root`'s WORKING TREE (real src/ + node_modules + bundled
 *  assets) as its own throwaway git repo under the workspace — the only kind of source this
 *  file ever builds from (FG-575).
 *
 *  The copy is of the working tree, not of HEAD, so `root`'s uncommitted edits still reach
 *  the release — that is what the old `commitSource(<the invoking checkout>)` was there to
 *  provide, and this provides it without writing a byte into `root`. The copy's own first
 *  commit gives buildRelease the clean, commit-described source it requires (FG-569 GAP 2).
 *
 *  A source built this way can also have its checkout RENAMED away afterwards, so a release
 *  can be proven to run with no source-checkout fallback. */
function isolatedSourceFrom(root: string, label: string): string {
  const src = mkdtempSync(join(workspace, label));
  execFileSync("git", ["init", "-q"], { cwd: src });
  for (const rel of ["src", "package.json", "package-lock.json", "npm-shrinkwrap.json", "seeds", "scripts", "docker", "dashboard"]) {
    const from = join(root, rel);
    if (existsSync(from)) cpSync(from, join(src, rel), { recursive: true, dereference: true });
  }
  cpSync(join(root, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  commitSource(src);
  return src;
}

/** The IN-PROCESS buildRelease() calls below (the fixture builds) resolve their BUILDER
 *  identity from this module's own location — the invoking checkout — and a release refuses
 *  a builder whose shipped source paths are dirty (FG-569 GAP 2). That refusal is a hard
 *  precondition of this file, shared with the sibling launch-*.integration release tests.
 *
 *  It is stated ONCE here rather than surfacing as the same failure inside sixteen test
 *  bodies. What this suite will NOT do is satisfy it for you by committing your working tree:
 *  that was the FG-575 defect — it swept operators' in-progress work into a `source snapshot`
 *  commit authored `t <t@t>`. Commit or stash, or run the tier from a throwaway clone. */
function assertBuilderCheckoutIsCommitted(): void {
  const paths = ["src", "package.json", "package-lock.json", "npm-shrinkwrap.json"].filter((p) => existsSync(join(checkoutRoot, p)));
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd: checkoutRoot, encoding: "utf8" });
  assert.equal(
    dirty,
    "",
    `this suite builds releases with ${checkoutRoot} as the BUILDER checkout, and forge refuses a dirty builder. FG-575: it will not commit your work to get around that. Commit or stash these paths, or run this tier from a throwaway clone:\n${dirty}`,
  );
}

/** Build a release by EXECUTING an isolated source's OWN cli, with cwd and --source both
 *  inside it — so the builder checkout and the source checkout are one repo, the production
 *  `forge release build` shape, and the invoking checkout takes no part in the build at all
 *  (FG-575). FORGE_HOME pins the interpreter store to the disposable buildHome (FG-571). */
function buildFromIsolatedSource(root: string, outDir: string): BuildReleaseResult {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "src", "cli", "index.ts"), "release", "build", "--source", root, "--out", outDir, "--json"],
    { cwd: root, encoding: "utf8", env: { ...process.env, FORGE_HOME: buildHome } },
  );
  assert.equal(r.status, 0, `release build from the isolated source ${root} failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as BuildReleaseResult;
}

before(() => {
  // realpathSync: macOS reaches the OS tmpdir through /var -> /private/var, and a release
  // records the CANONICAL path it was built at, so an expected value spelled /var/... never
  // matched the actual /private/var/... (FG-575, same shape as FG-556). Canonicalizing the
  // workspace ROOT once makes every path derived from it canonical on both sides of every
  // comparison in this file — a no-op wherever the tmpdir is already canonical (Linux CI),
  // not a platform branch.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "fg569-rel-")));
  buildHome = join(workspace, "forge-home");
  checkoutStateBefore = gitState(checkoutRoot);
  assertBuilderCheckoutIsCommitted();
  // FG-575: the source is an isolated copy, never the invoking repository. buildRoot carries
  // this run's working-tree bytes (incl. any uncommitted edits) under its own first commit.
  buildRoot = isolatedSourceFrom(checkoutRoot, "selfsrc-");
  // The one full build the whole file shares (copying node_modules is the slow part).
  // outDir is OUTSIDE buildRoot so the copy never recurses into itself.
  built = buildFromIsolatedSource(buildRoot, join(workspace, "release"));
  // FG-698 (AC4): everything that exists here is SHARED — buildRoot, the shared release,
  // forge-home. Anything a test mints afterwards is that test's own and is freed at its end.
  pinned = new Set(readdirSync(workspace));
});

/** FG-698 (AC4) — free each test's temporary space AT THE END OF THAT TEST rather than
 *  letting ~30 builds' worth (each carrying its own 93 MB node_modules copy) accumulate
 *  until after().
 *
 *  It sweeps by LIFETIME, not by name: every top-level entry under `workspace` that was not
 *  in the shared set is this test's. That deliberately covers the fixtures no per-site edit
 *  would catch — the renamed-away `${fullSrc}.GONE` source, every `mkdtempSync(join(workspace, …))`,
 *  every refused build's `outDir` — and it cannot be forgotten by whoever adds fixture 31.
 *  None of the ~30 build call sites is touched, and the per-test try/finally fixtures that
 *  already clean up after themselves are unaffected: the sweep is idempotent over a path
 *  that is already gone, and the outside-the-workspace guard's own fixture is out of reach
 *  by construction.
 *
 *  Ordering is safe because the sweep never runs against a LIVE writer: afterEach runs after
 *  the test body's own `finally`, and the two dashboard tests do not merely SIGKILL their
 *  detached process group there — they WAIT for it to be gone (killGroupAndAwaitExit), because
 *  signalling is not exit observation and a still-running server would otherwise race disposal
 *  of the release it booted from. Disposal never throws and reports residue on stderr, so a
 *  teardown fault can never redden a test — that inversion (an environment mechanism read as
 *  product breakage) is the failure shape this ticket exists because of. */
afterEach(() => {
  if (!workspace || !pinned) return;
  let entries: string[];
  try {
    entries = readdirSync(workspace);
  } catch {
    return; // The workspace is gone or unreadable; after() reports whatever survives.
  }
  for (const name of entries) {
    if (pinned.has(name)) continue;
    disposeReleaseWorkspace(join(workspace, name), `release.integration.test.ts per-test fixture ${name}`);
  }
});

after(() => {
  // FG-698 (AC1): the releases built under this workspace are FROZEN (read-only directories),
  // so a recursive unlink can't traverse them — the tree has to be made removable first. That
  // preparation used to be a strict thawReleaseTree(), which throws on the first entry it
  // cannot chmod or stat and so skipped the removal entirely, stranding the whole multi-GB
  // workspace. Disposal makes what it can removable, removes regardless, never throws, and
  // reports on stderr anything that genuinely survived.
  disposeReleaseWorkspace(workspace, "release.integration.test.ts workspace");
});

test("FG-569 (finding): an --out path INSIDE the source tree is REFUSED before any staging dir is created — else the copy recurses into itself", () => {
  // --out src/<x> makes src/<x>.building-* part of the copied src/ input, so the
  // recursive cpSync of src/ + node_modules/ would copy the growing staging tree into
  // itself. The build must refuse the path before creating anything.
  const badOut = join(buildRoot, "src", "release-would-recurse");
  assert.throws(
    () => buildRelease({ sourceRoot: buildRoot, home: buildHome, outDir:badOut }),
    /inside the source root/i,
    "an out dir contained by the source root must be refused",
  );
  assert.ok(!existsSync(badOut), "no out dir was created");
  const leaked = readdirSync(join(buildRoot, "src")).filter((n) => n.startsWith("release-would-recurse"));
  assert.deepEqual(leaked, [], "no `.building-*` staging dir leaked into the source tree");
});

test("FG-569 build: the manifest pins the building interpreter, its ABI, the commit, and a lockfile identity", () => {
  const m = built.manifest;
  // FG-571 (external-artifact contract): the pin is the INTERPRETER STORE's copy of the
  // building interpreter, NOT process.execPath itself. Same interpreter — proven by
  // execution below — but an artifact forge owns and never replaces in place, where
  // /usr/bin/node is rewritten by the next system node upgrade, under a release that has
  // already been promoted and validated against it.
  // The store key COMMITS TO THE BYTES (FG-571 F3), so the expected path is derived from the
  // building interpreter's own content — version+ABI alone does not name a store path.
  const storeId = storedIdentityOf(process.execPath)!;
  assert.equal(m.interpreter, interpreterPath(buildHome, storeId), "the absolute interpreter is the store's keyed copy of the building interpreter");
  assert.equal(validatedInterpreter(buildHome, storeId), m.interpreter, "and it validates BY EXECUTION at that key — a release may reference nothing less");
  assert.notEqual(m.interpreter, process.execPath, "the mutable external path the build ran from is NOT what the release pins");
  assert.equal(m.abi, process.versions.modules, "the ABI the native binding needs");
  assert.equal(m.commit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: buildRoot, encoding: "utf8" }).trim());
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
  // FG-580: the claim now truthfully covers the dashboard too — it is bundled and runs from the release.
  assert.equal(built.manifest.selfContainedFor, "control-plane+dashboard", "the manifest states self-containment over the control-plane set AND the dashboard");

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
  cpSync(join(checkoutRoot, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  // The linked dependency lives OUTSIDE the source tree; node_modules only links to it.
  const external = mkdtempSync(join(workspace, "external-linked-"));
  writeFileSync(join(external, "index.js"), `module.exports = "from the external host location";\n`);
  writeFileSync(join(external, "package.json"), `{"name":"linked-dep","main":"index.js"}`);
  symlinkSync(external, join(src, "node_modules", "linked-dep"));
  copyBundledAssets(src);
  commitSource(src);

  const out = join(workspace, "symlink-release");
  buildRelease({ sourceRoot: src, home: buildHome, outDir:out });

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
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(checkoutRoot, f), join(src, f));
  cpSync(join(checkoutRoot, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  copyBundledAssets(src);
  commitSource(src);

  // Untampered: the SAME tree builds cleanly — the binding never false-refuses a
  // node_modules that genuinely matches its lockfile.
  buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "lockbind-clean") });

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
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "lockbind-tampered") }),
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
  assert.throws(() => buildRelease({ sourceRoot: torn, home: buildHome, outDir: out }), /torn closure/i);
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
  const rel = buildRelease({ sourceRoot: buildRoot, home: buildHome, outDir:join(workspace, "corrupt-copy-release") });
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
    const from = join(checkoutRoot, "node_modules", dep);
    if (existsSync(from)) cpSync(from, join(torn, "node_modules", dep), { recursive: true });
  }
  writeFileSync(join(torn, RELEASE_BINDING_REL), "not a real .node\n");

  const out = join(workspace, "torn-corrupt-release");
  assert.throws(() => buildRelease({ sourceRoot: torn, home: buildHome, outDir: out }), /torn closure/i);
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
  cpSync(join(checkoutRoot, "package.json"), join(src, "package.json"));
  cpSync(join(checkoutRoot, "node_modules"), join(src, "node_modules"), { recursive: true, dereference: true });
  copyBundledAssets(src);
  return src;
}

test("FG-569 Finding 4 (lockfile selection): a package-lock-only source builds and binds+manifests against package-lock.json", () => {
  const src = makeLockSource("lock-pl-only-");
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);

  const rel = buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "lock-pl-only-rel") });
  assert.equal(rel.manifest.lockfile.name, "package-lock.json", "the manifest names the only lockfile present");
  assert.ok(existsSync(join(rel.releaseDir, "package-lock.json")), "the selected lockfile is copied into the release");
});

test("FG-569 Finding 4 (lockfile selection): a shrinkwrap-only source builds — binds+manifests against npm-shrinkwrap.json, NO false failure", () => {
  // The prior hole: lockfileIdentity accepted npm-shrinkwrap.json but the byte-binding
  // hardcoded package-lock.json, so a shrinkwrap-only source always failed the binding.
  const src = makeLockSource("lock-sw-only-");
  // npm-shrinkwrap.json has the same shape as package-lock.json, so reuse the real one.
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "npm-shrinkwrap.json"));
  commitSource(src);

  const rel = buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "lock-sw-only-rel") });
  assert.equal(rel.manifest.lockfile.name, "npm-shrinkwrap.json", "the manifest names the shrinkwrap it bound against");
  assert.ok(existsSync(join(rel.releaseDir, "npm-shrinkwrap.json")), "the shrinkwrap is copied into the release");
  assert.ok(!existsSync(join(rel.releaseDir, "package-lock.json")), "no package-lock.json was invented");
  const shipped = readFileSync(join(rel.releaseDir, "npm-shrinkwrap.json"));
  assert.equal(rel.manifest.lockfile.sha256, createHash("sha256").update(shipped).digest("hex"), "the manifest sha is of the SHIPPED shrinkwrap bytes");
});

test("FG-569 Finding 4 (lockfile selection): both present ⇒ shrinkwrap WINS for copy, verify, and manifest", () => {
  const src = makeLockSource("lock-both-");
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "npm-shrinkwrap.json"));
  // A DECOY package-lock.json that, if it were the one selected, would FAIL the
  // byte-binding (it pins a package that isn't installed / isn't in the npm cache).
  // A clean build therefore proves the shrinkwrap — not this file — was selected.
  writeFileSync(
    join(src, "package-lock.json"),
    JSON.stringify({ name: "decoy", lockfileVersion: 3, packages: { "node_modules/not-installed": { integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", resolved: "https://example.invalid/x.tgz" } } }, null, 2),
  );
  commitSource(src);

  const rel = buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "lock-both-rel") });
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
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);

  // Untampered: the SAME real tree — which INCLUDES the install-script packages —
  // builds cleanly. No false refusal from a generated artifact (the compiled
  // better_sqlite3.node / downloaded platform binaries are not tarball entries) nor
  // from esbuild's install-rewritten bin/esbuild (the one narrow per-file allowance).
  buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "gap1-clean") });

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
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "gap1-tampered") }),
    /shipped closure does not match the lockfile/i,
    "a tampered TARBALL-OWNED file of an install-script package must be REFUSED — hasInstallScript no longer exempts it",
  );
  assert.ok(!existsSync(join(workspace, "gap1-tampered")), "a refused build leaves no release directory behind");
});

test("FG-569 GAP 2 (dirty source, RED pre-fix / GREEN after): an uncommitted change under src/ is REFUSED so the manifest commit can never lie about the shipped bytes", () => {
  const src = makeLockSource("gap2-dirty-src-");
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);
  // Baseline: the committed tree builds — refuse-dirty does not false-refuse a clean source.
  buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "gap2-clean") });
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
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "gap2-dirty") }),
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
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
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
  const clean = buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "toctou-snapshot-clean") });
  assert.deepEqual(readFileSync(join(clean.releaseDir, relPosix)), committedBytes, "a quiescent build ships the committed bytes");
  assert.equal(clean.manifest.commit, commit, "and records the commit those bytes come from");

  // The race: dirty the LIVE file AFTER the commit is captured (inside the build window). The
  // up-front dirty-check already passed on the clean tree; the seam fires before the snapshot
  // is materialized. The snapshot copy reads the commit's objects, so the live mutation is a
  // no-op on the shipped bytes.
  const liveMutation = "export const committed = false; // LIVE MUTATION — not in the commit\n";
  const raced = buildRelease({
    sourceRoot: src,
    home: buildHome,
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
    home: buildHome,
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
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: buildRoot, encoding: "utf8" }).trim(),
    "and both name the committed source HEAD the release was built from",
  );
});

/** Poll a URL until it answers or the deadline passes — the dashboard boots asynchronously
 *  (a spawned tsx child), so a request may race the listen(). */
async function pollGet(url: string, timeoutMs: number): Promise<{ status: number; body: string; contentType: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      return { status: res.status, body, contentType: res.headers.get("content-type") };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`pollGet timed out for ${url}: ${String(lastErr)}`);
}

/** Members of process group `pgid` that can still RUN. A member that is already reaped, or
 *  that is defunct waiting for a parent that will never reap it (this container's pid 1 does
 *  not), cannot write anything and so is not a writer teardown has to wait for — which is why
 *  this counts states, not the existence a `kill(-pgid, 0)` probe would report. `ps -e -o
 *  pgid=,stat=` is spelled the same for procps and BSD ps; if ps cannot be read at all this
 *  reports zero, leaving the caller with the group leader's own exit, which it observes
 *  directly either way. */
function liveGroupMembers(pgid: number): number {
  let out: string;
  try {
    out = execFileSync("ps", ["-e", "-o", "pgid=,stat="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  return out.split("\n").filter((line) => {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    return m !== null && Number(m[1]) === pgid && !m[2]!.startsWith("Z");
  }).length;
}

/** FG-698 (AC4) — SIGKILL a detached child's whole process GROUP and then WAIT until nothing
 *  in it can still run. Signalling is not exit observation: kill() returns as soon as the
 *  signal is queued, so a `finally` that only signals hands control straight back to the
 *  file-level afterEach — which begins disposing this test's release tree while the dashboard
 *  server may still be writing into it. Two observations, in order: node's own `exit` (the
 *  group leader is dead AND reaped), then no runnable member of the group left behind.
 *
 *  It never throws. A teardown fault must not decide this test's verdict, so a group that
 *  outlives the deadline is REPORTED on stderr and the test's own assertions still stand —
 *  the same discipline disposal applies to residue. */
async function killGroupAndAwaitExit(child: ChildProcess, label: string): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return; // spawn never produced a process; nothing to wait for
  const deadline = Date.now() + 5000;
  let signalFailure: unknown;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    signalFailure = error;
  }
  const signalFailureReason = (): string =>
    signalFailure instanceof Error ? `group SIGKILL failed: ${signalFailure.message}` : `group SIGKILL failed: ${String(signalFailure)}`;

  while (child.exitCode === null && child.signalCode === null || liveGroupMembers(pid) > 0) {
    if (Date.now() >= deadline) {
      const reason = signalFailure === undefined ? "still had a RUNNABLE member" : signalFailureReason();
      process.stderr.write(`forge test: process group ${pid} (${label}) ${reason} 5s after SIGKILL — disposal may race it\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  // The group stopped before the deadline. A group signal that FAILED still has to surface: the
  // group exiting on its own is not evidence our kill worked, so swallowing the failed
  // process.kill on this early-exit path is the signal-inverting outcome FG-702 guards (RF-1).
  if (signalFailure !== undefined) {
    process.stderr.write(`forge test: process group ${pid} (${label}) ${signalFailureReason()} but the group exited before the 5s deadline — signal did not stop it\n`);
  }
}

test("FG-698 (AC4): the dashboard teardown WAITS for the signalled process group to stop running — signalling is not exit observation", async () => {
  // What the file-level afterEach sweep depends on, stated directly: when a test body's
  // `finally` returns, nothing it spawned can still be writing into the release tree that
  // sweep is about to dispose of. A `finally` that only calls process.kill(-pid, "SIGKILL")
  // does not give that — the signal is merely queued, and the child is provably NOT reaped
  // the instant kill() returns, which is the first assertion below.
  //
  // Two members in the group on purpose: killing the leader is not killing the group.
  const child = spawn("/bin/sh", ["-c", "sleep 30 & sleep 30"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined, "the fixture process must spawn");

  // INDUCTION: the group must actually come up — `detached` means the child setsid()s after
  // spawn() returns — else tearing it down would prove nothing.
  const upBy = Date.now() + 2000;
  while (liveGroupMembers(pid) < 2 && Date.now() < upBy) await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    liveGroupMembers(pid) >= 2,
    "the fixture's process GROUP (leader + a second member) must be running before the teardown under test does anything",
  );

  await killGroupAndAwaitExit(child, "FG-698 AC4 self-check");

  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "teardown returned only after the child was actually reaped — a queued signal is not an exit",
  );
  assert.equal(liveGroupMembers(pid), 0, "and no member of the signalled group can still run when it returns");
});

test("FG-702: a failed group signal against a live child reaches the bounded teardown diagnostic", async () => {
  // Induce the formerly-unbounded path directly: the fixture process is live, but the group
  // signal throws. The real kill is restored for cleanup only after the helper has returned.
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined, "the fixture process must spawn");
  const upBy = Date.now() + 2000;
  while (liveGroupMembers(pid) < 1 && Date.now() < upBy) await new Promise((r) => setTimeout(r, 10));
  assert.ok(liveGroupMembers(pid) >= 1, "the child must still be live before signalling fails");

  const originalKill = process.kill;
  const originalStderrWrite = process.stderr.write;
  const diagnostics: string[] = [];
  process.kill = ((...args: Parameters<typeof process.kill>) => {
    const [target, signal] = args;
    if (target === -pid && signal === "SIGKILL") throw new Error("FG-702 induced group signal failure");
    return originalKill(...args);
  }) as typeof process.kill;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const started = Date.now();
    await killGroupAndAwaitExit(child, "FG-702 bounded signal failure");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4500 && elapsed < 6500, `the failed-signal wait returned at its 5s deadline, not the enclosing test timeout (${elapsed}ms)`);
    assert.match(diagnostics.join(""), /FG-702 induced group signal failure/, "the bounded-deadline diagnostic names the signal failure");
    assert.ok(liveGroupMembers(pid) >= 1, "the helper returned because its deadline passed while the unsignalled child was still live");
  } finally {
    process.kill = originalKill;
    process.stderr.write = originalStderrWrite;
    originalKill(-pid, "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
});

test("FG-702 (RF-1): a failed group signal is reported even when the group exits before the deadline", async () => {
  // Same induced failure as above — the group SIGKILL throws — but the fixture exits on its
  // own well before the 5s deadline. The wait loop then ends by OBSERVING the exit, not by the
  // deadline, which is the path the deadline-only diagnostic left silent: a failed process.kill
  // swallowed on early exit inverts the signal FG-702 guards. The failure must still reach
  // stderr, and the helper must return early (not stall to the deadline).
  const child = spawn("/bin/sh", ["-c", "sleep 1"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined, "the fixture process must spawn");
  const upBy = Date.now() + 2000;
  while (liveGroupMembers(pid) < 1 && Date.now() < upBy) await new Promise((r) => setTimeout(r, 10));
  assert.ok(liveGroupMembers(pid) >= 1, "the child must be live before signalling fails");

  const originalKill = process.kill;
  const originalStderrWrite = process.stderr.write;
  const diagnostics: string[] = [];
  process.kill = ((...args: Parameters<typeof process.kill>) => {
    const [target, signal] = args;
    if (target === -pid && signal === "SIGKILL") throw new Error("FG-702 RF-1 induced group signal failure");
    return originalKill(...args);
  }) as typeof process.kill;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const started = Date.now();
    await killGroupAndAwaitExit(child, "FG-702 RF-1 early exit with failed signal");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4500, `the helper returned when the group exited on its own, not at the 5s deadline (${elapsed}ms)`);
    assert.equal(liveGroupMembers(pid), 0, "the group had exited on its own before the helper returned");
    assert.match(diagnostics.join(""), /FG-702 RF-1 induced group signal failure/, "the failed group signal is reported even though the group exited before the deadline");
  } finally {
    process.kill = originalKill;
    process.stderr.write = originalStderrWrite;
    try {
      originalKill(-pid, "SIGKILL");
    } catch {
      // the fixture group already exited on its own — nothing left to signal
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
});

test("FG-580 (dashboard bundled, EXECUTED, NO node on PATH): the release ships the complete dashboard closure and `forge dashboard start` boots under the release's pinned runtime, offline", async () => {
  // (1) The release carries the whole dashboard runtime — entry, tsconfig (the runtime
  // @forge/* resolver), a representative static asset, and every VENDORED client lib
  // (offline boot) — beside src/ so the sibling layout / tsconfig-paths hold.
  for (const rel of [
    "dashboard/src/server.ts",
    "dashboard/tsconfig.json",
    "dashboard/package.json",
    "dashboard/client/main.js",
    "dashboard/client/vendor/preact/preact.js",
    "dashboard/client/vendor/preact/hooks.js",
    "dashboard/client/vendor/htm/htm.js",
    "dashboard/client/vendor/marked/marked.js",
  ]) {
    assert.ok(existsSync(join(built.releaseDir, rel)), `${rel} is bundled into the release closure`);
  }
  assert.ok(existsSync(join(built.releaseDir, "src")), "src/ sits beside dashboard/ in the release (sibling layout preserved for @forge/* resolution)");

  // (2) Bare `forge dashboard` from the release under a node-free PATH: help, exit 0, NO refusal.
  const { r: bare } = runEntryUnderHostilePath(["dashboard"]);
  assert.equal(bare.status, 0, `bare forge dashboard must exit 0 from the release: ${bare.stderr}`);
  assert.doesNotMatch(bare.stderr, /not available from a control-plane release build/i, "the FG-569 release-mode refusal is retired");

  // (3) BOOT the server from the release under a node-free PATH on a disposable port and a
  // disposable FORGE_HOME. Prove it serves its shell + vendored-lib import map + a VENDORED
  // lib first-party (offline boot — no esm.sh), then kill the whole process group so no
  // orphaned server keeps the port. process.execPath under the release IS the pinned
  // interpreter, so a node-free caller PATH cannot stop it.
  const port = 8100 + Math.floor(Math.random() * 800);
  const nopath = mkdtempSync(join(workspace, "dash-nopath-"));
  const dashHome = mkdtempSync(join(workspace, "dash-fh-"));
  const env = { PATH: nopath, HOME: process.env.HOME ?? "/tmp", FORGE_HOME: dashHome };
  const child = spawn(built.entryPath, ["dashboard", "start", "--port", String(port)], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += String(d); });
  try {
    const base = `http://127.0.0.1:${port}`;
    const shell = await pollGet(`${base}/`, 12000);
    assert.equal(shell.status, 200, `the release-served dashboard shell responds 200 (stderr: ${stderr})`);
    assert.match(shell.body, /<script type="importmap"/, "the shell carries the vendored-lib import map");
    assert.match(shell.body, /\/client\/vendor\/preact\/preact\.js/, "the import map points preact at the first-party vendored path");
    assert.doesNotMatch(shell.body, /esm\.sh/, "the release-served shell references NO esm.sh/CDN origin");
    const lib = await pollGet(`${base}/client/vendor/preact/preact.js`, 4000);
    assert.equal(lib.status, 200, "the vendored preact serves first-party from the release closure");
    assert.match(lib.contentType ?? "", /javascript/, "the vendored lib serves as executable JS (module MIME)");
  } finally {
    await killGroupAndAwaitExit(child, "FG-580 dashboard server");
  }
});

test("FG-580 (closure validation, mutation proofs): a source missing a required dashboard entry / static asset / vendored lib / dashboard-relevant dep is REFUSED by name, no release produced", () => {
  // Each removal targets a DISTINCT required input and asserts the build refuses with a
  // message naming that input. Proven red against the precise defect: with the
  // assertDashboardClosure(sourceRoot) gate removed, each build would proceed (git-archive
  // simply omits the absent tracked file; a missing dep is not otherwise checked pre-copy),
  // so every assert.throws below flips to a passing build — the test goes RED. See notes.
  const cases: Array<{ label: string; remove: string; underNodeModules?: boolean; pattern: RegExp }> = [
    { label: "entry", remove: "dashboard/src/server.ts", pattern: /required dashboard file 'dashboard\/src\/server\.ts'/i },
    { label: "static", remove: "dashboard/client/main.js", pattern: /required dashboard file 'dashboard\/client\/main\.js'/i },
    { label: "vendored", remove: "dashboard/client/vendor/preact/preact.js", pattern: /required dashboard file 'dashboard\/client\/vendor\/preact\/preact\.js'/i },
    { label: "dep", remove: "marked", underNodeModules: true, pattern: /required dashboard runtime dependency 'marked'/i },
  ];
  for (const c of cases) {
    const src = makeLockSource(`dash-omit-${c.label}-`);
    cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
    const target = c.underNodeModules ? join(src, "node_modules", c.remove) : join(src, c.remove);
    rmSync(target, { recursive: true, force: true });
    commitSource(src); // node_modules is untracked; tracked-file removals commit cleanly
    assert.throws(
      () => buildRelease({ sourceRoot: src, home: buildHome, outDir: join(workspace, `dash-omit-${c.label}-rel`) }),
      c.pattern,
      `omitting the dashboard ${c.label} must refuse the build by name`,
    );
    assert.ok(!existsSync(join(workspace, `dash-omit-${c.label}-rel`)), `a refused build (${c.label}) leaves no release behind`);
  }
});

test("FG-580 (Option A, mutation proof): a source WITHOUT a dashboard/ dir REFUSES the build BY NAME — no control-plane-only release with a +dashboard manifest", () => {
  // The capability-claim invariant: selfContainedFor is ALWAYS "control-plane+dashboard",
  // so a source that cannot furnish a dashboard closure must NOT produce a release at all.
  // Pre-fix, the dashboard gate was presence-conditional (`if (hasDashboard) …`) and
  // dashboardTracked was `[]` for a dashboard-less source — so this build SUCCEEDED and
  // emitted a manifest claiming a dashboard the release did not carry. This test observed
  // RED against exactly that defect (the build completed instead of throwing). With the
  // mandatory gate it refuses by name.
  const src = makeLockSource("no-dashboard-");
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
  // Remove the dashboard/ workspace that copyBundledAssets staged — everything ELSE the
  // build needs is present, so this isolates the mandatory-dashboard refusal.
  rmSync(join(src, "dashboard"), { recursive: true, force: true });
  commitSource(src);
  assert.throws(
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir: join(workspace, "no-dashboard-rel") }),
    /has no dashboard\/ workspace, but a promoted release MUST bundle a working `forge dashboard`/i,
    "a dashboard-less source must REFUSE the build by name, not emit a control-plane-only +dashboard release",
  );
  assert.ok(!existsSync(join(workspace, "no-dashboard-rel")), "a refused build leaves no release behind");
});

test("FG-580 (commit-binding): a dirty (uncommitted) VENDORED client lib refuses the build BY NAME — the manifest commit cannot describe dashboard bytes it did not produce", () => {
  const src = makeLockSource("dash-dirty-vendor-");
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);
  // Baseline: the committed tree (with vendored libs) builds cleanly.
  buildRelease({ sourceRoot: src, home: buildHome, outDir: join(workspace, "dash-dirty-vendor-clean") });
  // Dirty a VENDORED client lib — appending a comment leaves valid JS but makes
  // dashboard/client dirty relative to HEAD, so the commit no longer describes the shipped bytes.
  const vendored = join(src, "dashboard", "client", "vendor", "htm", "htm.js");
  assert.ok(existsSync(vendored), "the vendored client lib is present in the fixture");
  appendFileSync(vendored, "\n// FG-580 uncommitted vendored edit\n");
  assert.throws(
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir: join(workspace, "dash-dirty-vendor-rel") }),
    /refusing to build a release from a dirty source/i,
    "a dirty VENDORED client lib must refuse the build",
  );
  assert.ok(!existsSync(join(workspace, "dash-dirty-vendor-rel")), "a refused build leaves no release behind");
});

test("FG-569 Resolution B (dirty seed/hook REFUSED at build): an uncommitted edit to a bundled seed OR script refuses the build — the manifest commit would not describe the shipped bytes", () => {
  const src = makeLockSource("dirty-asset-");
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
  commitSource(src);
  // Baseline: the committed tree (with real seeds/scripts/docker) builds cleanly.
  buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "dirty-asset-clean") });

  // (a) Dirty a bundled SEED — appending a comment keeps it valid but makes seeds/ dirty
  // relative to HEAD, so the commit binding no longer describes the shipped seed bytes.
  const seed = join(src, "seeds", "orchestrator-template.md");
  assert.ok(existsSync(seed), "the bundled seed is present in the fixture");
  appendFileSync(seed, "\n<!-- FG-569 uncommitted seed edit -->\n");
  assert.throws(
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "dirty-seed-rel") }),
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
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "dirty-script-rel") }),
    /refusing to build a release from a dirty source/i,
    "a dirty bundled SCRIPT must refuse the build",
  );
  assert.ok(!existsSync(join(workspace, "dirty-script-rel")), "a refused build leaves no release behind");
});

test("FG-569 Resolution B (required asset missing): a source lacking a bundled asset dir is REFUSED as a torn closure, no release produced", () => {
  const src = makeLockSource("missing-asset-");
  cpSync(join(checkoutRoot, "package-lock.json"), join(src, "package-lock.json"));
  // Remove a required asset dir that makeLockSource copied — the closure gate (binding)
  // passes, so this proves the DEDICATED required-asset refusal, not an optional skip.
  rmSync(join(src, "docker"), { recursive: true, force: true });
  commitSource(src);
  assert.throws(
    () => buildRelease({ sourceRoot: src, home: buildHome, outDir:join(workspace, "missing-asset-rel") }),
    /torn closure — required asset directory 'docker'/i,
    "a missing required asset dir must REFUSE the build, not silently skip it",
  );
  assert.ok(!existsSync(join(workspace, "missing-asset-rel")), "a refused build leaves no release behind");
});

test("FG-569 successor build (EXECUTED, RED pre-fix / GREEN after): release A builds release B from a clean checkout, B runs, and B records A's builder identity SEPARATELY from B's source commit", () => {
  // The HIGH production-path gap: a BUILT release must be able to build its successor.
  // Pre-fix, builderRoot() = findGitRoot(<release>/src/v2); a release has no .git, so
  // it fell back to <release>/src/v2 (no lockfile there) and `forge release build` from
  // the release exited 1 with "no lockfile … at <release>/src/v2". The control runtime
  // could not build the next release. Here we EXECUTE release A's own entry to build B.
  assert.ok(!existsSync(join(built.releaseDir, ".git")), "release A is an immutable copy — it has NO .git (the crux of the bug)");

  // B's source: an isolated, committed clean checkout whose HEAD is DISTINCT from A's
  // commit — so builderCommit (A's) vs commit (B's source) are provably separate SHAs.
  // A's source is an isolated copy of the same working tree, so give B's a byte A's does
  // not have: identical trees committed in the same second would hash to the same commit.
  const bSource = isolatedSourceFrom(checkoutRoot, "successor-bsrc-");
  writeFileSync(join(bSource, "src", "successor-b-marker.ts"), "export const bSource = true;\n");
  commitSource(bSource);
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

test("FG-569 Resolution B (EXECUTED, SOURCE RENAMED AWAY): supported commands — INCLUDING the dashboard SERVER — run FROM THE RELEASE with the source checkout inaccessible — no fallback", async () => {
  // The sharpest proof of self-containment for the control-plane set: build a release
  // from an isolated source, then RENAME the source away so it cannot be resolved, and
  // exercise the release's own entry. Every supported command must run from the release's
  // OWN bundled bytes; forge dashboard must refuse (release mode) rather than reach out.
  const fullSrc = isolatedSourceFrom(checkoutRoot, "srcgone-");
  const built2 = buildRelease({ sourceRoot: fullSrc, home: buildHome, outDir: join(workspace, "srcgone-release") });
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

  // 2) FG-580: forge dashboard is BUNDLED — the bare command shows help and exits 0 from
  // the release's OWN bytes (source gone), no release-mode refusal, no reach to the source.
  const dashR = spawnSync(built2.entryPath, ["dashboard"], { encoding: "utf8", env: baseEnv });
  assert.equal(dashR.status, 0, `forge dashboard (bundled) must succeed from the release: ${dashR.stderr}`);
  assert.doesNotMatch(dashR.stderr, /not available from a control-plane release build/i, "the FG-569 release-mode refusal is retired");
  assert.doesNotMatch(dashR.stdout + dashR.stderr, /\.GONE/, "dashboard did not reach the renamed-away source checkout");
  assert.match(dashR.stdout + dashR.stderr, /Boot the dashboard HTTP server|Web view of forge runs/i, "the bundled dashboard command help renders from the release");

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

  // 5) FG-580 (MEDIUM 4): the dashboard SERVER actually BOOTS from the release WITH the
  // source checkout renamed away — the production scenario (checkout unavailable AND the
  // server serving) proven in ONE scenario, not just `forge dashboard` help. Bare help (step
  // 2) does not exercise the server; a self-contained release must serve the dashboard from
  // its OWN bytes when the source is gone. Boots under the same node-free PATH on a disposable
  // port + FORGE_HOME, serves its shell + vendored-lib import map + a VENDORED lib first-party
  // (offline boot — no esm.sh), then kills the whole process group so no orphan holds the port.
  const dashPort = 8100 + Math.floor(Math.random() * 800);
  const dashHome = mkdtempSync(join(workspace, "srcgone-dash-fh-"));
  const dashChild = spawn(built2.entryPath, ["dashboard", "start", "--port", String(dashPort)], {
    env: { ...baseEnv, FORGE_HOME: dashHome },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let dashStderr = "";
  dashChild.stderr?.on("data", (d) => { dashStderr += String(d); });
  try {
    const base = `http://127.0.0.1:${dashPort}`;
    const shell = await pollGet(`${base}/`, 12000);
    assert.equal(shell.status, 200, `the dashboard server booted from the release (source gone) responds 200 (stderr: ${dashStderr})`);
    assert.match(shell.body, /<script type="importmap"/, "the release-served shell carries the vendored-lib import map, source gone");
    assert.match(shell.body, /\/client\/vendor\/preact\/preact\.js/, "the import map points preact at the first-party vendored path");
    assert.doesNotMatch(shell.body, /esm\.sh/, "the release-served shell references NO esm.sh/CDN origin");
    assert.doesNotMatch(dashStderr, /\.GONE/, "the dashboard server did not reach the renamed-away source checkout");
    const lib = await pollGet(`${base}/client/vendor/preact/preact.js`, 4000);
    assert.equal(lib.status, 200, "the vendored preact serves first-party from the release closure, source gone");
    assert.match(lib.contentType ?? "", /javascript/, "the vendored lib serves as executable JS (module MIME)");
  } finally {
    await killGroupAndAwaitExit(dashChild, "FG-569 dashboard server, source renamed away");
  }
});

test("FG-575 (canonical paths): the workspace root IS its own realpath, so every path this file compares is canonical on macOS exactly as on Linux", () => {
  // macOS reaches the OS tmpdir through /var -> /private/var; Linux has no such symlink, so
  // the two spellings are identical there and CI never saw the split. Every path this file
  // asserts on is derived from `workspace`, so canonicalizing that one root canonicalizes
  // both sides of every comparison — no platform branch, and a no-op where /tmp is already
  // canonical. RED on macOS before FG-575 (workspace was the raw /var/folders/... mkdtemp).
  assert.equal(workspace, realpathSync(workspace), "the workspace is its own realpath — no /var vs /private/var split is possible");
  assert.equal(built.releaseDir, realpathSync(built.releaseDir), "so the built release's path is canonical too");
  assert.equal(buildHome, realpathSync(buildHome), "and so is the interpreter store's home, which the manifest pins a path under");
});

test("FG-575: a DIRTY invoking checkout is NEVER committed into — the build runs off an isolated copy that carries the uncommitted work, and the checkout's git state is untouched", () => {
  // The defect this kills only fires on a DIRTY tree: the old commitSource(<invoking repo>)
  // staged and committed whatever the operator had in progress under `t <t@t>`, and on a
  // clean tree it was a no-op — so asserting the invariant against a clean checkout passes
  // VACUOUSLY even with the bug fully present. Stand in for the invoking checkout with a
  // disposable copy, dirty it exactly as in-progress work would, and drive the SAME
  // prepare-then-build path `before()` runs.
  const standIn = isolatedSourceFrom(checkoutRoot, "fg575-standin-");
  const wip = join(standIn, "src", "fg575-operator-work-in-progress.ts");
  writeFileSync(wip, "export const inProgress = 1;\n");
  appendFileSync(join(standIn, "seeds", "orchestrator-template.md"), "\n<!-- an operator edit in progress -->\n");
  const before = gitState(standIn);
  // The premise, asserted by NAMING the in-progress paths. A bare `status !== ""` check does
  // not state it: isolatedSourceFrom does not copy the root .gitignore, so every isolated copy
  // carries an untracked node_modules/ and its porcelain is non-empty even when nothing was
  // dirtied — the guard would hold with the dirtying deleted, and this test would silently
  // stop exercising the only case the defect fires in.
  assert.match(before.status, /\?\? src\/fg575-operator-work-in-progress\.ts/, "the stand-in carries UNTRACKED in-progress work under src/ — the bytes the old commitSource swept up");
  assert.match(before.status, / M seeds\/orchestrator-template\.md/, "and a MODIFIED bundled asset — against a clean stand-in this test would prove nothing");

  const isolated = isolatedSourceFrom(standIn, "fg575-standin-iso-");
  assert.ok(!isolated.startsWith(standIn + sep) && isolated !== standIn, "the build source is a COPY under the workspace, not the checkout itself");
  const rel = buildFromIsolatedSource(isolated, join(workspace, "fg575-standin-release"));

  assert.deepEqual(gitState(standIn), before, "same HEAD, same branch, same porcelain, same stash list — nothing was committed, stashed, or cleaned in the invoking checkout");
  assert.equal(readFileSync(wip, "utf8"), "export const inProgress = 1;\n", "the in-progress work is still sitting uncommitted in the working tree");

  // And the property the commit-into-the-checkout existed to provide survives: the release
  // is built from the WORKING TREE's bytes, uncommitted edits included.
  assert.ok(existsSync(join(rel.releaseDir, "src", "fg575-operator-work-in-progress.ts")), "the isolated copy carried the checkout's UNCOMMITTED edits into the release");
  assert.match(readFileSync(join(rel.releaseDir, "seeds", "orchestrator-template.md"), "utf8"), /an operator edit in progress/, "including the uncommitted bundled-asset edit");
});

test("FG-575 (guard): commitSource REFUSES a root outside the disposable workspace, without writing a byte into it", () => {
  // The guard is what keeps the sixteen fixture call sites honest: if one ever regresses to
  // naming the invoking checkout again, it must fail loudly AT THE CALL SITE instead of
  // landing a `source snapshot` commit in an operator's branch. Exercised against a throwaway
  // repo outside the workspace — deliberately NOT checkoutRoot, because a run in which the
  // guard had been removed would then commit into the very checkout this file exists to protect.
  const outside = mkdtempSync(join(tmpdir(), "fg575-outside-workspace-"));
  try {
    assert.ok(!outside.startsWith(workspace + sep), "the fixture genuinely sits outside the workspace");
    execFileSync("git", ["init", "-q"], { cwd: outside });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: outside });
    mkdirSync(join(outside, "src"));
    // Uncommitted work of exactly the kind the defect swept up — so a guard-less commitSource
    // has something to stage, and this test goes RED on the commit rather than passing blind.
    writeFileSync(join(outside, "src", "in-progress.ts"), "export const inProgress = 1;\n");
    const before = gitState(outside);

    assert.throws(
      () => commitSource(outside),
      /FG-575: commitSource may only commit into a disposable fixture under/,
      "committing into a root outside the workspace must be REFUSED",
    );
    // The refusal lands BEFORE any git write — nothing staged, nothing committed, HEAD unmoved.
    assert.deepEqual(gitState(outside), before, "the refused call left the outside repository's git state untouched");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("FG-575: the whole suite left the INVOKING repository's git state completely unchanged", () => {
  // Declared after every test that builds anything, so it covers all of them. (Only the
  // FG-698 lifetime guard below it is later, and that one runs no git command and creates
  // no fixture.) A regression fails HERE, loudly, instead of being discovered by an operator
  // whose branch moved under them.
  assert.deepEqual(
    gitState(checkoutRoot),
    checkoutStateBefore,
    `running this suite must leave ${checkoutRoot} on the same HEAD and branch, with no new or rewritten commits, no stash entries, and no modified or untracked files`,
  );
});

test("FG-698 (AC4, lifetime guard): every fixture this file built was freed at the end of its own test — only the SHARED set survives the whole run", () => {
  // Declared LAST, so it observes the workspace after every test above it has run and been
  // swept. The bound on peak temporary space is expressed STRUCTURALLY — as this lifetime
  // invariant — not as a byte threshold: a megabyte number depends on the host, the installed
  // dependency tree and how many builds a future edit adds, so it would degrade into a flaky
  // figure that gets raised until it means nothing. What actually has to hold is that nothing
  // a test creates outlives it, and that the shared set stays exactly these three fixtures.
  //
  // It fails in both directions on purpose. A fixture that leaks past its test shows up as an
  // extra name. A new SHARED fixture pinned in before() shows up as a missing name — which is
  // the point: growing the set that lives for the whole file is a deliberate decision about
  // peak disk, and it should be made here rather than discovered as silent growth.
  assert.ok(pinned, "before() completed and snapshotted the shared set");
  const expected = [...pinned!].sort();
  assert.deepEqual(
    readdirSync(workspace).sort(),
    expected,
    `only the shared fixtures may survive the run; anything else was created by a test and should have been freed at its end (expected exactly ${expected.join(", ")})`,
  );
  // And name what the shared set IS, so the invariant above cannot be satisfied by an empty
  // or wrong `pinned` — it is exactly buildRoot's isolated source, the shared release, and
  // the disposable forge home, the three fixtures every test in this file reads.
  assert.deepEqual(
    expected,
    ["forge-home", "release", basename(buildRoot)].sort(),
    "the shared set is exactly the isolated build source, the one shared release, and the disposable forge home",
  );
  for (const p of [buildRoot, built.releaseDir, buildHome]) {
    assert.ok(existsSync(p), `${p} is shared and survived to the end of the file`);
  }
});
