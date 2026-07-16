// FG-571 (FG-553 Child 4) — ATOMIC PROMOTE / ROLLBACK, EXECUTED.
//
// The governing rule (FG-551): a property about the FINAL RUNTIME must be demonstrated by
// EXECUTING or MUTATION-TESTING the final artifact. Reading the `current` symlink's target
// proves NOTHING about what a process loaded — so every assertion here that matters comes
// from a RUNNING process's own report, and each acceptance case names the mutant that
// must redden it.
//
// SAFETY: every test here promotes, rolls back, installs an interpreter, installs a shim,
// or interrupts an install. ALL of it happens under a mkdtemp FORGE_HOME with an explicit
// --prefix. Nothing here touches the developer's real ~/.forge/current, their real shim,
// their real interpreter store, or any live forge runtime — and nothing here runs
// `npm link`. That isolation is not incidental: it is why paths.ts derives every promotion
// path from FORGE_HOME rather than homedir().
//
// The same containment covers the checkout releases are built FROM: they are built from a
// DISPOSABLE source root (see fg571-harness.ts), never by committing in the real repository.
// No git command in this file runs against the real checkout — asserted below, not assumed —
// so the suite is non-destructive on a dirty dev tree and safe to run concurrently with the
// F29/F32 suite.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST_NAME, SHIM_NAME, assertReleaseCloses, renderShim, thawReleaseTree, type BuildReleaseResult } from "./release.js";
import { atomicSymlinkSwap, installShim, promote, readSelection, rollback, validateCandidate } from "./promote.js";
import { installInterpreter, interpreterPath, isStoredInterpreter, probeInterpreter, validatedInterpreter } from "./runtime-store.js";
import { currentLinkIn, interpretersDirIn, previousLinkIn, releasesDirIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { canonicalMkdtemp, makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "./fg571-harness.js";

/** The REAL checkout: where the code under test lives, and what the child processes below
 *  resolve tsx + the modules under test from. It is READ, never written and never committed
 *  to — releases are built from `source.root` instead. Derived from this module's own
 *  location rather than process.cwd(), so it does not depend on where the runner was
 *  launched (and never hardcodes the forge-test scratch path). */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
let home: string;
let relA: BuildReleaseResult;
let relB: BuildReleaseResult;
/** The real checkout's git state, captured before anything runs. The containment test below
 *  proves this suite did not move it. */
let repoHeadBefore: string;
let repoStatusBefore: string;

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** Run a child that reaches an interruption seam, then SIGKILL it there — the F27 shape.
 *  The child writes `marker` from inside the seam and then parks forever; SIGKILL (not
 *  SIGTERM) so no cleanup handler can run: an interrupted install must be safe because of
 *  what is ON DISK, not because it got a chance to tidy up. */
function killAtSeam(script: string, marker: string): void {
  const child = spawnSync(
    "/bin/sh",
    [
      "-c",
      // Start the child, wait for its seam marker, then SIGKILL it.
      `"$1" --import tsx "$2" & pid=$!; ` +
        `for i in $(seq 1 3000); do [ -f "$3" ] && break; sleep 0.02; done; ` +
        `kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null; exit 0`,
      "sh",
      process.execPath,
      script,
      marker,
    ],
    // The child must resolve tsx + the modules under test, which live in the real checkout.
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(child.status, 0, "the interruption harness itself ran");
  assert.ok(existsSync(marker), `the child reached its interruption seam (marker ${marker}) — child stderr: ${child.stderr}`);
}

/** The import specifier a child script uses for a module under test, as a JS literal.
 *  Derived from THIS file's location: a hardcoded scratch path (/tmp/forge-work/...) would
 *  resolve only under forge-test and leave the suite unable to run directly from a
 *  checkout — the same "green in one place only" defect class as a GNU-only flag. */
function moduleUnderTest(name: string): string {
  return JSON.stringify(join(moduleDir, name));
}

/** Write a child script that runs against the real checkout (so tsx + the modules resolve). */
function childScript(name: string, body: string): string {
  const p = join(workspace, name);
  writeFileSync(p, body);
  return p;
}

/** EXECUTE a release entry / shim and return the RUNNING process's own provenance report.
 *  This — not the symlink — is the evidence. */
function runProvenance(cmd: string, env: NodeJS.ProcessEnv): { status: number | null; stderr: string; prov: any } {
  const r = spawnSync(cmd, ["release", "provenance", "--json"], { encoding: "utf8", env });
  let prov: any;
  try {
    prov = JSON.parse(r.stdout);
  } catch {
    prov = undefined;
  }
  return { status: r.status, stderr: r.stderr, prov };
}

function shimEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home, ...extra };
}

before(async () => {
  repoHeadBefore = gitIn(repoRoot, ["rev-parse", "HEAD"]).trim();
  repoStatusBefore = gitIn(repoRoot, ["status", "--porcelain"]);

  workspace = canonicalMkdtemp("fg571-");
  // THE isolation boundary: a disposable forge home. Every promotion, interpreter install,
  // shim install and rollback in this file lands here and nowhere else.
  home = canonicalMkdtemp("fg571-home-");
  // ...and a disposable CHECKOUT, so building the releases commits nothing in the real repo.
  source = await makeDisposableSourceRoot(repoRoot);
  // Two REAL releases from the same commit, distinguished by their ids — promotion is
  // about which one a process actually runs, so both must genuinely run.
  relA = source.build({ outDir: join(workspace, "rel-a"), rand: "aaaaaa" });
  relB = source.build({ outDir: join(workspace, "rel-b"), rand: "bbbbbb" });
  assert.notEqual(relA.manifest.id, relB.manifest.id, "the two releases have distinct identities");
});

after(() => {
  for (const dir of [workspace, home]) {
    if (existsSync(dir)) {
      thawReleaseTree(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Not thawed: it holds no frozen tree, and thawing would walk through its node_modules
  // symlink into the real one.
  if (source) removeDisposableSourceRoot(source);

  // The containment test below proves the BUILD committed nothing; this re-checks after the
  // LAST test, so the property covers the whole suite. Cleanup runs first — a leaked temp
  // dir on top of a real failure helps nobody.
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the whole suite left the real checkout's HEAD unmoved");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "the whole suite left the real working tree exactly as it found it");
});

test("FG-571 SAFETY: this suite never runs git against the REAL checkout — a dirty dev tree is not a test fixture", () => {
  // The destructive shape this replaced: `git add` + `git commit` in findGitRoot(cwd), which
  // silently committed a developer's in-progress work under a junk message, behaved
  // differently on a clean CI checkout than on a dirty dev one, and raced the F29/F32 suite
  // on .git/index.lock when both ran under one `npm run test:integration`.
  assert.notEqual(source.root, repoRoot, "releases are built from a disposable checkout, not the real repository");
  assert.ok(!source.root.startsWith(repoRoot), "and that checkout is not inside the real repository");
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the real checkout's HEAD did not move — nothing here committed");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "and its working tree is byte-for-byte as this suite found it — nothing staged, nothing swept away");
});

test("FG-571 SAFETY: every promotion path derives from FORGE_HOME — this suite cannot reach the real ~/.forge", () => {
  // The premise the whole file rests on. If any of these were homedir()-derived, a test in
  // this file would promote over the developer's live control plane.
  for (const p of [currentLinkIn(home), previousLinkIn(home), releasesDirIn(home)]) {
    assert.ok(p.startsWith(home), `${p} is inside the disposable forge home`);
  }
  assert.ok(!currentLinkIn(home).includes(process.env.HOME ?? "/nonexistent-home"), "the disposable current pointer is not under the real HOME");
});

test("FG-571 F26 (EXECUTED, from the RUNNING PROCESS): promote A then B — a new invocation's release id, execPath and ABI are all B's", () => {
  promote({ home, candidate: relA.releaseDir });
  const shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });

  // A is selected: assert it FROM THE RUNNING PROCESS, not from the symlink.
  const first = runProvenance(shim, shimEnv());
  assert.equal(first.status, 0, `stable forge failed under A: ${first.stderr}`);
  assert.equal(first.prov.releaseId, relA.manifest.id, "the running process carries A's identity");
  assert.equal(first.prov.release.id, relA.manifest.id, "and it located A's own manifest");

  const p = promote({ home, candidate: relB.releaseDir });
  assert.equal(p.id, relB.manifest.id);
  assert.equal(p.previous?.id, relA.manifest.id, "the promotion recorded what it superseded");

  // THE F26 ASSERTION: the whole closure moved. Every one of these comes from inside the
  // process that ran, not from the pointer.
  const after = runProvenance(shim, shimEnv());
  assert.equal(after.status, 0, `stable forge failed after promoting B: ${after.stderr}`);
  assert.equal(after.prov.releaseId, relB.manifest.id, "release id (from the running process) is B's");
  assert.equal(after.prov.release.id, relB.manifest.id, "the manifest the process located is B's");
  assert.equal(after.prov.execPath, relB.manifest.interpreter, "process.execPath IS B's manifest interpreter");
  assert.equal(after.prov.abi, relB.manifest.abi, "process.versions.modules IS B's manifest ABI");
  assert.equal(after.prov.bindingLoads, true, "and B's own native binding loaded");
  assert.deepEqual(after.prov.match, { interpreter: true, abi: true }, "the process self-verified against B's manifest");

  // No mixed source/runtime closure: the source the process loaded and the manifest it
  // read are the same release directory — not A's source under B's manifest.
  assert.ok(after.prov.release.id === relB.manifest.id && !JSON.stringify(after.prov).includes(relA.manifest.id), "no part of the running process's report names A");

  // RETAIN: neither release was deleted (T9 — deleting an anchored release is fatal).
  assert.ok(existsSync(join(releasesDirIn(home), relA.manifest.id, RELEASE_MANIFEST_NAME)), "A is retained after being superseded");
  assert.ok(existsSync(join(releasesDirIn(home), relB.manifest.id, RELEASE_MANIFEST_NAME)), "B is installed");
});

test("FG-571 F26 MUTANT (swap-before-validate): a candidate that fails validation leaves A selected and CANNOT report success", () => {
  promote({ home, candidate: relA.releaseDir });
  const shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });
  assert.equal(readSelection(home)?.manifest?.id, relA.manifest.id);

  // A genuinely broken candidate: a release whose manifest is not parseable. Real shape —
  // a truncated/corrupted copy.
  const broken = join(workspace, "broken-candidate");
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", broken, relB.releaseDir]);
  execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"', "sh", broken]);
  writeFileSync(join(broken, RELEASE_MANIFEST_NAME), "{ this is not json");

  assert.throws(() => promote({ home, candidate: broken }), /refusing to promote/i, "a candidate that fails validation is REFUSED by name");

  // The refusal did not move the pointer, and — the part the mutant would break — the
  // previously selected release is still what actually RUNS.
  assert.equal(readSelection(home)?.manifest?.id, relA.manifest.id, "A is still selected");
  const after = runProvenance(shim, shimEnv());
  assert.equal(after.status, 0, `A must still run after a refused promotion: ${after.stderr}`);
  assert.equal(after.prov.releaseId, relA.manifest.id, "the running process is still A");

  // MUTANT, executed: swap-before-validate. Point `current` at the broken candidate the way
  // a swap-first implementation would, and prove the F26 property genuinely reddens —
  // the invocation does NOT report the candidate as active, it fails. The swap uses
  // PRODUCTION's own primitive (symlinkSync + renameSync): a bare `mv` would follow
  // `current` (a symlink to a directory) and move the new link INSIDE the release, and the
  // `mv -T` that fixes that is GNU-only — absent on BSD/macOS, where it exits 64 and would
  // make this suite red on the operator's host while staying green on Linux CI. rename(2)
  // replaces a symlink in place, atomically, everywhere. Only the ORDERING is mutated here.
  atomicSymlinkSwap(broken, currentLinkIn(home));
  const mutant = runProvenance(shim, shimEnv());
  assert.notEqual(mutant.status, 0, "a swap-before-validate promotion yields a forge that does not run — this is what validate-then-swap prevents");
  assert.match(mutant.stderr, /refusing to run/i, "and it fails by name rather than opaquely");

  // Restore the invariant for the rest of the file.
  promote({ home, candidate: relA.releaseDir });
});

test("FG-571 F27a (EXECUTED, SIGKILL mid release-install): nothing partial is selectable and the previous stable runtime still RUNS", () => {
  // Its OWN disposable forge home: B must genuinely not be installed here, or installRelease
  // would correctly no-op on an already-present immutable release and never reach the seam.
  const home = canonicalMkdtemp("fg571-f27a-home-");
  promote({ home, candidate: relA.releaseDir });
  const shim = installShim({ prefix: mkdtempSync(join(workspace, "f27a-prefix-")), shimText: renderShim(), shimName: SHIM_NAME });
  const shimEnv = () => ({ PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home });

  const marker = join(workspace, "f27a.marker");
  const script = childScript(
    "f27a-install.mts",
    `import { installRelease } from ${moduleUnderTest("promote.js")};
import { writeFileSync } from "node:fs";
installRelease({
  home: ${JSON.stringify(home)},
  dir: ${JSON.stringify(relB.releaseDir)},
  onBeforeCommit: () => {
    writeFileSync(${JSON.stringify(marker)}, "staged");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
  },
});
`,
  );
  killAtSeam(script, marker);

  // The install was killed with the copy fully staged and the rename NOT done.
  assert.ok(!existsSync(join(releasesDirIn(home), relB.manifest.id)), "no release is addressable at B's id — nothing partial became selectable");
  const staging = readdirSync(releasesDirIn(home)).filter((n) => n.startsWith(".installing-"));
  assert.ok(staging.length > 0, "the interrupted install left only a `.installing-*` staging dir — a name no pointer can select");

  // A promotion cannot reach the half-installed release by id.
  assert.throws(() => promote({ home, candidate: relB.manifest.id }), /refusing to promote/i, "the half-installed release is not promotable by id");

  // THE F27 ASSERTION: the previously selected stable runtime is still USABLE — executed.
  assert.equal(readSelection(home)?.manifest?.id, relA.manifest.id, "A is still selected");
  const r = runProvenance(shim, shimEnv());
  assert.equal(r.status, 0, `A must remain usable after an interrupted release install: ${r.stderr}`);
  assert.equal(r.prov.releaseId, relA.manifest.id);
  assert.equal(r.prov.bindingLoads, true, "A's native binding still loads");
});

test("FG-571 F27b (EXECUTED, SIGKILL mid interpreter-install): no release can reference a half-installed interpreter; the store is unchanged", () => {
  // Its OWN disposable forge home + store, so the key under test is genuinely absent.
  const home = canonicalMkdtemp("fg571-f27b-home-");
  promote({ home, candidate: relA.releaseDir });
  const shim = installShim({ prefix: mkdtempSync(join(workspace, "f27b-prefix-")), shimText: renderShim(), shimName: SHIM_NAME });
  const shimEnv = () => ({ PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home });

  // The REAL identity of a REAL interpreter: the install must get all the way PAST
  // validation to its commit seam, because F27b is about what is on disk when a process
  // dies there — an install that fails validation never had anything to commit.
  const identity = probeInterpreter(process.execPath);
  assert.ok(identity, "the interpreter to install reports its own identity");
  const marker = join(workspace, "f27b.marker");
  const script = childScript(
    "f27b-interp.mts",
    `import { installInterpreter } from ${moduleUnderTest("runtime-store.js")};
import { writeFileSync } from "node:fs";
installInterpreter({
  home: ${JSON.stringify(home)},
  source: ${JSON.stringify(process.execPath)},
  expected: ${JSON.stringify(identity)},
  onBeforeCommit: () => {
    writeFileSync(${JSON.stringify(marker)}, "staged");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
  },
});
`,
  );
  killAtSeam(script, marker);

  assert.ok(!existsSync(interpreterPath(home, identity)), "the keyed interpreter path does not exist — nothing partial is selectable");
  assert.equal(validatedInterpreter(home, identity), null, "and nothing validates at that key, so no manifest may reference it");
  const staged = existsSync(interpretersDirIn(home)) ? readdirSync(interpretersDirIn(home)).filter((n) => !n.startsWith(".installing-")) : [];
  assert.deepEqual(staged, [], "the STORE is unchanged — the interrupted install added no key");

  // The previously selected stable runtime still runs.
  const r = runProvenance(shim, shimEnv());
  assert.equal(r.status, 0, `A must remain usable after an interrupted interpreter install: ${r.stderr}`);
  assert.equal(r.prov.releaseId, relA.manifest.id);
});

test("FG-571 F27c (EXECUTED, SIGKILL mid shim-install): the previous shim is intact and still RUNS — a torn shim is never on PATH", () => {
  promote({ home, candidate: relA.releaseDir });
  const prefix = mkdtempSync(join(workspace, "f27c-prefix-"));
  const shim = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
  const before = readFileSync(shim, "utf8");

  const marker = join(workspace, "f27c.marker");
  const script = childScript(
    "f27c-shim.mts",
    `import { installShim } from ${moduleUnderTest("promote.js")};
import { writeFileSync } from "node:fs";
installShim({
  prefix: ${JSON.stringify(prefix)},
  shimName: "forge",
  shimText: "#!/bin/sh\\nexit 42\\n",
  onBeforeCommit: () => {
    writeFileSync(${JSON.stringify(marker)}, "staged");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
  },
});
`,
  );
  killAtSeam(script, marker);

  // The shim on PATH is byte-for-byte the OLD one: the replacement died before its rename,
  // so the new bytes only ever existed at a dot-prefixed temp name.
  assert.equal(readFileSync(shim, "utf8"), before, "the installed shim is untouched — the interrupted install never renamed over it");
  // ...and it still WORKS (the property that matters, executed).
  const r = runProvenance(shim, shimEnv());
  assert.equal(r.status, 0, `the previous shim must still run after an interrupted shim install: ${r.stderr}`);
  assert.equal(r.prov.releaseId, relA.manifest.id);
  assert.notEqual(r.status, 42, "the half-installed replacement never executed");
});

test("FG-571 F27d (EXECUTED, SIGKILL mid current-swap): the previous stable runtime stays selected and usable", () => {
  promote({ home, candidate: relA.releaseDir });
  const shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });

  const marker = join(workspace, "f27d.marker");
  const script = childScript(
    "f27d-swap.mts",
    `import { promote } from ${moduleUnderTest("promote.js")};
import { writeFileSync } from "node:fs";
promote({
  home: ${JSON.stringify(home)},
  candidate: ${JSON.stringify(relB.releaseDir)},
  onBeforeSwap: () => {
    writeFileSync(${JSON.stringify(marker)}, "validated");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
  },
});
`,
  );
  killAtSeam(script, marker);

  // The kill landed after B was validated and installed but before the pointer moved.
  assert.equal(readSelection(home)?.manifest?.id, relA.manifest.id, "A is still selected");
  const r = runProvenance(shim, shimEnv());
  assert.equal(r.status, 0, `A must remain usable after an interrupted swap: ${r.stderr}`);
  assert.equal(r.prov.releaseId, relA.manifest.id, "the running process is A — the interrupted promotion selected nothing");
  // No stray temp symlink was left ON the pointer path itself.
  assert.ok(lstatSync(currentLinkIn(home)).isSymbolicLink(), "`current` is still a single, intact symlink");
});

test("FG-571 F28/T9 (EXECUTED): a process anchored to A completes on A — lazy ESM import AND lazy CJS require AND lazy NATIVE dlopen — across a mid-flight promotion to B", () => {
  // T9, settled by execution in the FG-553 plan (uniform ESM = CJS = native dlopen): a
  // process anchors at its first resolution of `current` and stays in that release; a
  // pointer swap does not tear it; DELETING the anchored release is fatal at the next lazy
  // load. The anchoring mechanism IS "resolve `current` once, physically, then stay
  // module-relative to that path" — exactly what the shim's `cd -P` does before it execs.
  // So this probe anchors the way the shim anchors, then does its lazy loads AFTER the
  // swap. An ESM-only probe is the rejected hollow version: better-sqlite3's dlopen at the
  // first `new Database()` is forge's real hot path, so the native arm is the one that
  // matters.
  promote({ home, candidate: relA.releaseDir });
  const shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });

  const anchoredMarker = join(workspace, "t9-anchored.json");
  const swapped = join(workspace, "t9-swapped");
  const probe = childScript(
    "t9-probe.mts",
    `import { realpathSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// ANCHOR: one physical resolution of \`current\`, at start — the shim's \`cd -P\`, in JS.
const anchored = realpathSync(${JSON.stringify(currentLinkIn(home))});

// Wait for the promotion to land, so every load below happens AFTER the swap.
const park = new Int32Array(new SharedArrayBuffer(4));
const end = Date.now() + 60000;
while (Date.now() < end && !existsSync(${JSON.stringify(swapped)})) Atomics.wait(park, 0, 0, 20);

// (1) lazy ESM import, module-relative to the anchored release
const esm = await import(pathToFileURL(join(anchored, "forge-loader.mjs")).href);
// (2) lazy CJS require, module-relative to the anchored release
const require = createRequire(join(anchored, "package.json"));
const cjs = require("better-sqlite3/package.json");
// (3) lazy NATIVE dlopen — forge's real hot path
const Database = require("better-sqlite3");
new Database(":memory:").close();
const binding = Object.keys(require.cache).find((k) => k.endsWith(".node"));

writeFileSync(${JSON.stringify(anchoredMarker)}, JSON.stringify({
  anchored,
  esmLoaded: esm !== undefined,
  cjsFrom: require.resolve("better-sqlite3/package.json"),
  cjsVersion: cjs.version,
  binding,
  completed: true,
}));
`,
  );

  // The mid-flight promotion runs as its own executable, so the harness shell below stays
  // readable: start the probe, let it anchor, promote B UNDER it, then release it.
  const promoter = join(workspace, "promote-b.sh");
  writeFileSync(
    promoter,
    `#!/bin/sh\nexec "${process.execPath}" --import tsx "${childScript(
      "t9-promote.mts",
      `import { promote } from ${moduleUnderTest("promote.js")};\npromote({ home: ${JSON.stringify(home)}, candidate: ${JSON.stringify(relB.releaseDir)} });\n`,
    )}"\n`,
  );
  execFileSync("chmod", ["755", promoter]);
  rmSync(anchoredMarker, { force: true });
  rmSync(swapped, { force: true });

  const run = spawnSync("/bin/sh", [
    "-c",
    `"$1" --import tsx "$2" & pid=$!; sleep 1; "$3"; touch "$4"; wait $pid; exit $?`,
    "sh",
    process.execPath,
    probe,
    promoter,
    swapped,
  ]);
  assert.equal(run.status, 0, `the anchored process must COMPLETE across the swap: ${run.stderr}`);

  const anchoredResult = JSON.parse(readFileSync(anchoredMarker, "utf8"));
  const dirA = realpathSync(join(releasesDirIn(home), relA.manifest.id));
  const dirB = realpathSync(join(releasesDirIn(home), relB.manifest.id));

  assert.equal(anchoredResult.completed, true, "the anchored process completed");
  assert.equal(anchoredResult.anchored, dirA, "it anchored to A");
  assert.equal(anchoredResult.esmLoaded, true, "its lazy ESM import resolved");
  assert.ok(anchoredResult.cjsFrom.startsWith(dirA), `its lazy CJS require resolved inside A, not B (${anchoredResult.cjsFrom})`);
  assert.ok(!anchoredResult.cjsFrom.startsWith(dirB), "no CJS module came from B");
  assert.ok(anchoredResult.binding?.startsWith(dirA), `its lazy NATIVE dlopen loaded A's binding (${anchoredResult.binding})`);

  // The swap DID land, and new invocations get B — the point of promoting at all.
  assert.equal(readSelection(home)?.manifest?.id, relB.manifest.id, "B is selected");
  const fresh = runProvenance(shim, shimEnv());
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.prov.releaseId, relB.manifest.id, "a NEW invocation gets B (from the running process)");

  // RETENTION: no release was deleted, and A still RUNS.
  assert.ok(existsSync(dirA), "A was not deleted while a process was anchored to it");
  const stillA = spawnSync(join(dirA, "forge"), ["release", "provenance", "--json"], { encoding: "utf8", env: shimEnv() });
  assert.equal(stillA.status, 0, `the retained A must still execute: ${stillA.stderr}`);
  assert.equal(JSON.parse(stillA.stdout).release.id, relA.manifest.id);
});

test("FG-571 F28/T9 MUTANT (EXECUTED): DELETE the anchored release and the anchored process's lazy NATIVE load goes RED — which is why promotion retains", () => {
  // The mutant for the retention invariant. Deleting a superseded release is fatal to an
  // anchored process at its next lazy load (native dlopen — forge's real hot path). This
  // proves the invariant is load-bearing rather than decorative: promote() must never do
  // what this test does by hand.
  const doomed = join(workspace, "doomed-release");
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", doomed, relA.releaseDir]);

  const probe = childScript(
    "t9-mutant.mts",
    `import { createRequire } from "node:module";
const anchored = ${JSON.stringify(doomed)};
const require = createRequire(anchored + "/package.json");
// The release is deleted between anchoring and this lazy native load.
const Database = require("better-sqlite3");
new Database(":memory:").close();
console.log("LOADED");
`,
  );
  execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"; rm -rf "$1"', "sh", doomed]);
  const r = spawnSync(process.execPath, ["--import", "tsx", probe], { encoding: "utf8", cwd: repoRoot });
  assert.notEqual(r.status, 0, "a lazy native load from a DELETED release fails — deleting an anchored release is fatal");
  assert.doesNotMatch(r.stdout, /LOADED/, "the binding did not load");
});

test("FG-571 rollback (EXECUTED): an atomic swap back to the complete prior release — asserted from the RUNNING process", () => {
  promote({ home, candidate: relA.releaseDir });
  promote({ home, candidate: relB.releaseDir });
  const shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });
  assert.equal(runProvenance(shim, shimEnv()).prov.releaseId, relB.manifest.id, "B is running");

  const r = rollback({ home });
  assert.equal(r.id, relA.manifest.id, "rollback selected the complete prior release");

  const after = runProvenance(shim, shimEnv());
  assert.equal(after.status, 0, `A must run after rollback: ${after.stderr}`);
  assert.equal(after.prov.releaseId, relA.manifest.id, "the RUNNING process is A again");
  assert.equal(after.prov.execPath, relA.manifest.interpreter, "under A's pinned interpreter");
  assert.equal(after.prov.bindingLoads, true, "with A's native binding loaded");

  // RETAIN: rollback deleted nothing — B is still there and still runs, so the rollback
  // can be rolled forward.
  assert.ok(existsSync(join(releasesDirIn(home), relB.manifest.id)), "B is retained after being rolled back from");
  const rolledForward = promote({ home, candidate: relB.manifest.id });
  assert.equal(rolledForward.id, relB.manifest.id, "and B can be selected again by id");
});

test("FG-571 rollback: with no previous release recorded, it REFUSES by name rather than selecting something", () => {
  const fresh = canonicalMkdtemp("fg571-fresh-home-");
  try {
    assert.throws(() => rollback({ home: fresh }), /refusing to roll back — no previous release is recorded/i);
    assert.ok(!existsSync(currentLinkIn(fresh)), "and it selected nothing");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("FG-571 interpreter store: immutable, keyed, validated BY EXECUTION before it is selectable; a re-install is a no-op", () => {
  const identity = probeInterpreter(process.execPath);
  assert.ok(identity, "the running interpreter reports its own version+ABI when EXECUTED");

  const first = installInterpreter({ home, source: process.execPath, expected: identity });
  assert.equal(first.reused, false, "the first install committed the interpreter");
  assert.ok(first.path.startsWith(interpretersDirIn(home)), "it landed in the keyed store under the disposable forge home");
  assert.equal(first.key, `node-${identity.version}-${identity.abi}`, "keyed by version+ABI");

  // VALIDATE BEFORE SELECT: the store's answer comes from EXECUTING the installed binary.
  assert.equal(validatedInterpreter(home, identity), first.path, "the installed interpreter validates by execution");
  const reported = probeInterpreter(first.path);
  assert.deepEqual(reported, identity, "the stored binary IS the interpreter its key names");

  // IMMUTABLE: re-installing an already-valid key is a NO-OP, not a rewrite.
  const again = installInterpreter({ home, source: process.execPath, expected: identity });
  assert.equal(again.reused, true, "a re-install of a valid key is a no-op");
  assert.equal(again.path, first.path, "at the same keyed path");
});

test("FG-571 interpreter store: its path does NOT collide with the PROVIDER RUNTIME REGISTRY — two unrelated meanings of 'runtime', two directories", () => {
  // ~/.forge/runtimes/ is NOT free real estate: on a real forge home it is the provider
  // runtime registry (claude-oauth.yml, pi-apikey.yml, ...), which doctor.ts enumerates with
  // readdirSync(join(FORGE_HOME,"runtimes")). Keying the interpreter store under it would
  // drop node-<version>-<abi>/ inside the operator's provider config — today merely
  // conflated (doctor's `.yml` filter hides it), tomorrow broken by any enumeration that
  // does not filter. The store lives in its own directory instead.
  const providerRuntimeRegistry = join(home, "runtimes");
  const store = interpretersDirIn(home);

  assert.notEqual(store, providerRuntimeRegistry, "the interpreter store is not the provider runtime registry");
  assert.ok(!store.startsWith(providerRuntimeRegistry + "/"), "and it is not nested INSIDE it");
  assert.equal(store, join(home, "interpreters"), "it is ~/.forge/interpreters/");

  // Executed, not just computed: a real install lands clear of the registry, and a registry
  // populated the way a real forge home has it is untouched by one.
  mkdirSync(providerRuntimeRegistry, { recursive: true });
  writeFileSync(join(providerRuntimeRegistry, "claude-oauth.yml"), "kind: claude\n");
  const identity = probeInterpreter(process.execPath);
  assert.ok(identity, "the interpreter reports its identity");
  const installed = installInterpreter({ home, source: process.execPath, expected: identity });

  assert.ok(!installed.path.startsWith(providerRuntimeRegistry + "/"), `the installed interpreter is outside the provider runtime registry (${installed.path})`);
  assert.deepEqual(readdirSync(providerRuntimeRegistry), ["claude-oauth.yml"], "the registry holds exactly what it held — the store added no node-* subdir to it");
});

test("FG-571 interpreter store: a binary that is not what it claims is REFUSED — validate BEFORE select, so no manifest can reference it", () => {
  const lying = { version: "v0.0.1-not-really", abi: process.versions.modules };
  assert.throws(
    () => installInterpreter({ home, source: process.execPath, expected: lying }),
    /not what it claims/i,
    "the store refuses to commit a binary under an identity it does not report",
  );
  assert.ok(!existsSync(interpreterPath(home, lying)), "and nothing was committed to that key");
  assert.equal(validatedInterpreter(home, lying), null, "so no release manifest could reference it");
});

test("FG-571 provenance (BOTH SURFACES): a refused promotion reports no success; `current` and the JSON identify the release and interpreter truthfully", () => {
  promote({ home, candidate: relA.releaseDir });
  const forgeDev = join(repoRoot, "bin", "forge-dev");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };

  // --json surface
  const j = spawnSync(forgeDev, ["release", "current", "--json"], { encoding: "utf8", env });
  assert.equal(j.status, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.forgeHome, home, "the JSON names the forge home it reports on");
  assert.equal(parsed.current.id, relA.manifest.id, "and identifies the selected release");
  assert.equal(parsed.current.interpreter, relA.manifest.interpreter, "with truthful interpreter provenance");
  assert.equal(parsed.current.abi, relA.manifest.abi);

  // HUMAN surface — tested too, not just the JSON.
  const h = spawnSync(forgeDev, ["release", "current"], { encoding: "utf8", env });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, new RegExp(relA.manifest.id), "the human surface names the selected release");
  assert.match(h.stdout, new RegExp(relA.manifest.interpreter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and its interpreter");

  // A REFUSED promotion: neither surface may report success or claim the candidate active.
  const refusedJson = spawnSync(forgeDev, ["release", "promote", join(workspace, "does-not-exist"), "--json"], { encoding: "utf8", env });
  assert.notEqual(refusedJson.status, 0, "a refused promotion exits non-zero");
  assert.doesNotMatch(refusedJson.stdout, /"promoted": true/, "and prints no success payload");
  const refusedHuman = spawnSync(forgeDev, ["release", "promote", join(workspace, "does-not-exist")], { encoding: "utf8", env });
  assert.notEqual(refusedHuman.status, 0, "the human surface refuses too");
  assert.doesNotMatch(refusedHuman.stdout, /promoted/i, "and never says it promoted anything");
  assert.equal(readSelection(home)?.manifest?.id, relA.manifest.id, "the previously selected release is still selected");
});

test("FG-571 provenance: `current` on a forge home with nothing selected reads as NOT RECORDED — never a manufactured value", () => {
  const fresh = canonicalMkdtemp("fg571-empty-home-");
  try {
    const forgeDev = join(repoRoot, "bin", "forge-dev");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: fresh };
    const j = JSON.parse(spawnSync(forgeDev, ["release", "current", "--json"], { encoding: "utf8", env }).stdout);
    assert.equal(j.current, null, "nothing selected reads as null — the FG-569 rule: absent provenance is 'not recorded', never guessed");
    assert.equal(j.previous, null, "and so does an absent previous");
    const h = spawnSync(forgeDev, ["release", "current"], { encoding: "utf8", env });
    assert.match(h.stdout, /nothing selected/i, "the human surface says so plainly");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("FG-571 install-shim is EXPLICIT: promoting does not install, rewrite, or touch the shim", () => {
  // The shim sits outside the release closure, so its contract is NOT atomic with a
  // release — which is exactly why changing it must be an install-level act the operator
  // performs, never a side effect a promotion performs on them.
  const prefix = mkdtempSync(join(workspace, "explicit-prefix-"));
  promote({ home, candidate: relA.releaseDir });
  assert.deepEqual(readdirSync(prefix), [], "a promotion into a fresh forge home installed no shim anywhere");

  const shim = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
  const bytes = readFileSync(shim, "utf8");
  promote({ home, candidate: relB.releaseDir });
  assert.equal(readFileSync(shim, "utf8"), bytes, "and a later promotion did not rewrite the installed shim");
  // The shim still works across that promotion — it resolves `current` at run time.
  const r = runProvenance(shim, shimEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.prov.releaseId, relB.manifest.id, "an unchanged shim selects the newly promoted release");
});

test("FG-571 external-artifact contract (EXECUTED): a built release pins its interpreter IN THE STORE, and the promoted release RUNS under that store copy", () => {
  // The contract is only real if it is on the PRODUCTION path: an interpreter store that
  // nothing builds into and nothing requires is an unreferenced module with tests. So the
  // evidence here is the same shape as everything else in this file — what the RUNNING
  // process execs, not what a module returns.
  const identity = { version: relA.manifest.nodeVersion, abi: relA.manifest.abi };
  assert.ok(
    isStoredInterpreter(relA.manifest.interpreter, identity),
    `the built release pins a STORE path keyed by its own version+ABI, not the building process.execPath (${relA.manifest.interpreter})`,
  );
  assert.ok(relA.manifest.interpreter.startsWith(interpretersDirIn(source.home)), "and it is the store of the home the release was built against");
  // VALIDATE BEFORE SELECT: the store's answer comes from EXECUTING what is at that key.
  assert.equal(validatedInterpreter(source.home, identity), relA.manifest.interpreter, "the pinned interpreter validates by execution at its keyed path");

  // THE EXECUTED ASSERTION: a promoted release's process really does exec the store copy —
  // the pin is what runs, not merely what the manifest says.
  promote({ home, candidate: relA.releaseDir });
  const shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });
  const r = runProvenance(shim, shimEnv());
  assert.equal(r.status, 0, `the release must run under its store interpreter: ${r.stderr}`);
  assert.equal(r.prov.execPath, relA.manifest.interpreter, "process.execPath IS the store's copy — the running process is on the immutable artifact");
  assert.ok(isStoredInterpreter(r.prov.execPath, identity), "and that execPath is store-owned, keyed by the ABI the process reports");
  assert.equal(r.prov.bindingLoads, true, "the native binding loads under the store interpreter");

  // RETAINED while referenced: promotion added no GC, so the key a selected release names
  // is still there and still validates afterwards.
  assert.equal(validatedInterpreter(source.home, identity), relA.manifest.interpreter, "the referenced interpreter is retained after promotion");
});

test("FG-571 external-artifact MUTANT (EXECUTED): a release pinning a MUTABLE EXTERNAL interpreter is REFUSED — it passes every other gate", () => {
  // THE MUTANT for the store rule, and the pre-fix behavior exactly: a release whose
  // manifest pins process.execPath — the node running this very test. It is absolute, it
  // exists, it RUNS, and it reports precisely the version+ABI the manifest names, so it
  // sails through every other promotion gate (isAbsolute, probeInterpreter, ABI coherence,
  // and the closure actually CLOSES under it — asserted below). Only the store rule catches
  // it. That is the point: `/usr/local/bin/node` validates identically today and is rewritten
  // in place by the next `brew upgrade node`, taking the release's proven runtime with it —
  // under processes already anchored to that release, which retention cannot protect.
  const external = join(workspace, "external-interp-release");
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", external, relA.releaseDir]);
  execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"', "sh", external]);
  const m = JSON.parse(readFileSync(join(external, RELEASE_MANIFEST_NAME), "utf8"));
  m.interpreter = process.execPath;
  writeFileSync(join(external, RELEASE_MANIFEST_NAME), JSON.stringify(m, null, 2));

  // The premise, proven rather than asserted: this interpreter is genuinely good — it is
  // NOT refused for running badly, disagreeing about its ABI, or failing to close.
  assert.ok(!isStoredInterpreter(process.execPath, { version: m.nodeVersion, abi: m.abi }), "the external interpreter is outside the store");
  assert.deepEqual(probeInterpreter(process.execPath), { version: m.nodeVersion, abi: m.abi }, "it runs and reports exactly the version+ABI the manifest names");
  assert.doesNotThrow(() => assertReleaseCloses(external, process.execPath), "and the release's closure genuinely CLOSES under it — every non-store gate is green");

  assert.throws(
    () => validateCandidate(external),
    /not in the interpreter store/i,
    "a release referencing an interpreter forge does not own is refused BY NAME — the external-artifact contract",
  );

  // ...and the refusal holds at the promotion surface, leaving the selection untouched.
  promote({ home, candidate: relA.releaseDir });
  assert.throws(() => promote({ home, candidate: external }), /not in the interpreter store/i, "promote refuses it too");
  assert.equal(readSelection(home)?.manifest?.id, relA.manifest.id, "and the previously selected release is still selected");

  // The same release, pinned back to the STORE path, promotes — so the refusal is the store
  // rule doing its job, not the fixture being broken in some other way.
  m.interpreter = relA.manifest.interpreter;
  writeFileSync(join(external, RELEASE_MANIFEST_NAME), JSON.stringify(m, null, 2));
  assert.equal(validateCandidate(external).interpreter, relA.manifest.interpreter, "the identical release with a STORE-pinned interpreter validates");
});

test("FG-571 validateCandidate: a release whose pinned interpreter is gone is REFUSED by name, not promoted into a broken state", () => {
  const fake = join(workspace, "fake-interp-release");
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", fake, relA.releaseDir]);
  execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"', "sh", fake]);
  const m = JSON.parse(readFileSync(join(fake, RELEASE_MANIFEST_NAME), "utf8"));
  m.interpreter = "/nonexistent/node-that-was-uninstalled";
  writeFileSync(join(fake, RELEASE_MANIFEST_NAME), JSON.stringify(m, null, 2));
  assert.throws(() => validateCandidate(fake), /pinned interpreter does not run/i, "validate-before-select: an absent interpreter is refused by name");
});
