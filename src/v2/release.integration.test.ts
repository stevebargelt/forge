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
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease, assertReleaseCloses, RELEASE_BINDING_REL, RELEASE_LOADER_NAME, type BuildReleaseResult } from "./release.js";
import { findGitRoot } from "../util/git-root.js";

const sourceRoot = findGitRoot(process.cwd());
let workspace: string;
let built: BuildReleaseResult;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "fg569-rel-"));
  // The one full build the whole file shares (copying node_modules is the slow
  // part). outDir is OUTSIDE sourceRoot so the copy never recurses into itself.
  built = buildRelease({ sourceRoot, outDir: join(workspace, "release") });
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
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

test("FG-569 MUST-FIX 1 (EXECUTED THROUGH A SYMLINK): the release entry resolves its release root through a promotion symlink", () => {
  // A promoted release is reached via a `current`/PATH symlink, so $0 is the
  // symlink, not the release file. The entry must canonicalize $0 first, else
  // $here/src/cli/index.ts resolves next to the symlink and node can't find it.
  const link = join(workspace, "forge-current-link");
  symlinkSync(built.entryPath, link);
  const r = spawnSync(link, ["release", "provenance", "--json"], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, `release entry via symlink failed: ${r.stderr}`);
  const prov = JSON.parse(r.stdout);
  assert.equal(prov.release.id, built.manifest.id, "the symlinked entry located its OWN release manifest through the symlink");
  assert.equal(prov.bindingLoads, true, "and loaded the closure's native binding");
});

test("FG-569 torn closure: a MISSING native binding is REFUSED at build, and no release directory is produced", () => {
  const torn = mkdtempSync(join(workspace, "torn-missing-"));
  mkdirSync(join(torn, "src"));
  writeFileSync(join(torn, "package.json"), `{"name":"torn"}`);
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
  writeFileSync(join(rel.releaseDir, RELEASE_BINDING_REL), "not a real .node\n");
  assert.throws(
    () => assertReleaseCloses(rel.releaseDir, process.execPath),
    /torn closure — the COPIED better-sqlite3 binding/i,
  );
});

test("FG-569 torn closure: a CORRUPT / ABI-mismatched native binding is REFUSED at build (it cannot load)", () => {
  const torn = mkdtempSync(join(workspace, "torn-corrupt-"));
  mkdirSync(join(torn, "src"));
  writeFileSync(join(torn, "package.json"), `{"name":"torn"}`);
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
