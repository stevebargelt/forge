// FG-565 (Slice 6 closeout) — F23 + F24: a broken DEV source must not break the
// STABLE machine-wide surfaces, in THIS project AND in an UNRELATED project dir.
//
// WHY THIS FILE EXISTS (the ledger's proven gap, docs/plans/fg565-closeout-evidence-ledger.md):
//   F23 — "broken dev source -> stable readers AND the launch observer still work."
//         FG-571's fg571-env-identity.integration.test.ts:586 proves the STATE-READER arm
//         (`release provenance`) survives a broken dev checkout, but the LAUNCH-OBSERVER arm
//         (`forge launch wait`) under a broken dev source was never asserted.
//   F24 — "broken export -> stable commands work in this AND unrelated projects."
//         The "unrelated project directory" clause had NO test at all — the ledger flagged it
//         as "most likely quietly dropped." Nothing ran a stable forge command from a SECOND,
//         unrelated project dir while the forge dev source is broken.
//
// This file closes both. It reuses the FG-571 stable/dev split substrate (bin/forge vs
// bin/forge-dev, the promotion pointer, the disposable-source harness) and adds NO production.
//
// THE RED BASELINE IS INJECTION-BASED, by construction — stated here so the shipping-reviewer
// does not expect a production revert. F23/F24 are COVERAGE holes, not shippable defects: there
// is no wrong prod line to revert. The defect the tests would catch is a REGRESSION of the
// stable/dev split (a forge-dev that silently delegates to the stable release, or a stable
// surface that reaches back into the live checkout). So the RED baseline is a broken-dev-source
// INJECTION (a missing export; a syntax error), mirroring the FG-571 mutant arms
// (fg571-env-identity.integration.test.ts:633,668 — the delegating forge-dev). Each test proves:
//   • the injection genuinely REDDENS forge-dev (the live-source loop is broken — the point of it), and
//   • the STABLE shim GREENS on the same host, for BOTH the state readers AND the launch observer,
//     from this project's cwd and from an unrelated project's cwd.
// The MANDATORY MUTANT below (a delegating forge-dev) is what proves the red baseline is not
// hollow: a forge-dev that execs the release would "pass" a naive stable-still-works test while
// destroying the dev loop — so the assertion must catch it, and it does.
//
// HERMETICITY (mandatory): the machine-wide root is a per-test mkdtemp FORGE_HOME with an
// explicit shim --prefix. The release is built from a DISPOSABLE source root (fg571-harness.ts),
// never by committing in the real repo. Both project dirs share this ONE hermetic stable
// runtime; nothing here reads or mutates the operator's real ~/.forge, real shim, live control
// plane, or the real checkout's git state (asserted, not assumed), and the two project dirs
// cannot cross-contaminate.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIM_NAME, renderShim, thawReleaseTree, type BuildReleaseResult } from "./release.js";
import { installShim, promote } from "./promote.js";
import { currentLinkIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { canonicalMkdtemp, makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "./fg571-harness.js";

/** The REAL checkout: READ for the dev-entry copies below, never written or committed to. */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
/** THE hermetic machine-wide root shared by both project dirs. */
let home: string;
let rel: BuildReleaseResult;
let shim: string;
/** A seeded terminal launch record read by the STABLE launch observer (native-free, no tmux). */
let seededLaunchId: string;
let repoHeadBefore: string;
let repoStatusBefore: string;

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** A PATH with NO node on it — the stable shim pins an absolute interpreter (F29), so it must
 *  run regardless. Using it here makes "machine-wide, caller-env-independent" explicit. */
function nodeFreePath(): string {
  return mkdtempSync(join(workspace, "nopath-"));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, cwd, timeout: 60_000, killSignal: "SIGKILL" });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { ...r, json };
}

/** A live-source checkout we are allowed to BREAK. node_modules is SYMLINKED (forge-dev
 *  resolves it at run time and this test must never touch the real one); its top-level
 *  rmSync unlinks the symlink rather than following it. */
function makeDevCheckout(label: string): string {
  const dir = canonicalMkdtemp(`fg565-dev-${label}-`);
  for (const p of ["src", "bin", "package.json", "package-lock.json"]) {
    if (existsSync(join(repoRoot, p))) execFileSync("cp", ["-R", join(repoRoot, p), join(dir, p)]);
  }
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/** A genuinely UNRELATED project directory: not a forge checkout, its own identity, and its own
 *  broken source file — so "the machine-wide forge works from here" is a claim about cwd
 *  independence, not about anything forge-shaped happening to sit in this dir. */
function makeUnrelatedProject(): string {
  const dir = canonicalMkdtemp("fg565-unrelated-proj-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "some-unrelated-service", version: "9.9.9", private: true }, null, 2) + "\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  // This project's OWN source is broken — the point of F24: a broken export in the cwd project
  // is irrelevant to the machine-wide stable forge.
  writeFileSync(join(dir, "src", "index.ts"), "export const totally = broken syntax ((( <<< \n");
  return dir;
}

/** Seed a TERMINAL launch record on the filesystem the stable observer reads
 *  ($FORGE_HOME/launches/<id>). A parseable exit record is authoritative in readLaunch — no
 *  tmux, no better-sqlite3, no live owner needed — so `forge launch wait <id>` returns a
 *  terminal observation deterministically. */
function seedTerminalLaunch(id: string): void {
  const dir = join(home, "launches", id);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    command: ["sh", "-c", "exit 0"],
    tmuxSession: `forge-${id}`,
    launcherPid: process.pid,
    ownerPid: null,
    startedAt: "2026-07-21T00:00:00.000Z",
    logPath: join(dir, "out.log"),
    cwd: home,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "exit"), JSON.stringify({ code: 0, signal: null }));
}

/** The env a STABLE shim invocation runs under: a node-free PATH (F29), the hermetic FORGE_HOME,
 *  and an explicit cwd so the "which project dir am I standing in" axis is exercised. */
function stableEnv(): NodeJS.ProcessEnv {
  return { PATH: nodeFreePath(), HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };
}

/** ALL the STABLE machine-wide surfaces F23/F24 require to survive a broken dev source: the two
 *  state readers AND the launch observer, asserted from the running process's own report, with
 *  the given cwd (this project or an unrelated one). */
function assertStableSurfacesWork(cwd: string, where: string): void {
  // (a) machine-wide state reader — the selected release, read from the promotion pointer.
  const current = run(shim, ["release", "current", "--json"], stableEnv(), cwd);
  assert.equal(current.status, 0, `[${where}] stable 'release current' must run: ${current.stderr}`);
  assert.equal(current.json.current.id, rel.manifest.id, `[${where}] it reports the promoted release`);

  // (a') machine-wide state reader — provenance from the RUNNING process (the F25 arm, re-run here
  //      to keep this test self-contained about the reader arm too).
  const prov = run(shim, ["release", "provenance", "--json"], stableEnv(), cwd);
  assert.equal(prov.status, 0, `[${where}] stable 'release provenance' must run: ${prov.stderr}`);
  assert.equal(prov.json.releaseId, rel.manifest.id, `[${where}] provenance is the release's own identity`);
  assert.equal(prov.json.bindingLoads, true, `[${where}] and its native binding loaded`);

  // (b) THE LAUNCH OBSERVER — the arm F23 left untested. Reads the seeded terminal record from
  //     the hermetic FORGE_HOME and reports it, entirely independent of the broken dev checkout.
  const wait = run(shim, ["launch", "wait", seededLaunchId, "--json"], stableEnv(), cwd);
  assert.equal(wait.status, 0, `[${where}] the STABLE launch observer must run: ${wait.stderr}`);
  assert.equal(wait.json.kind, "terminal", `[${where}] it observed the seeded launch as terminal`);
  assert.deepEqual(wait.json.status, { state: "exited_ok", code: 0 }, `[${where}] with the recorded disposition`);
}

before(async () => {
  repoHeadBefore = gitIn(repoRoot, ["rev-parse", "HEAD"]).trim();
  repoStatusBefore = gitIn(repoRoot, ["status", "--porcelain"]);

  workspace = canonicalMkdtemp("fg565-f23-");
  home = canonicalMkdtemp("fg565-f23-home-");
  // Built against THIS suite's home: the interpreter-store rule binds to the configured home
  // (FG-571 F4), so the release is promotable only into the home whose store owns its interpreter.
  source = await makeDisposableSourceRoot(repoRoot, home);
  rel = source.build({ outDir: join(workspace, "release"), rand: "f23f24" });
  promote({ home, candidate: rel.releaseDir });
  shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });

  seededLaunchId = "launch-fg565-f23seed";
  seedTerminalLaunch(seededLaunchId);
});

after(() => {
  for (const dir of [workspace, home]) {
    if (existsSync(dir)) {
      thawReleaseTree(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (source) removeDisposableSourceRoot(source);

  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the whole suite left the real checkout's HEAD unmoved");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "the whole suite left the real working tree exactly as it found it");
});

// ---------------------------------------------------------------------------
// F23 — broken dev source, THIS project. Both the missing-export shape and the
// syntactic-break shape; the state-reader arm AND the launch-observer arm.
// ---------------------------------------------------------------------------

test("FG-565 F23 (EXECUTED, MISSING-EXPORT injection): a dev source that no longer exports runForge REDDENS forge-dev, while the stable state readers AND launch observer stay green", () => {
  const dev = makeDevCheckout("miss-export");
  const devEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };

  // Working first: the dev entry runs its OWN live source against an intact checkout.
  const before = run(join(dev, "bin", "forge-dev"), ["release", "provenance", "--json"], devEnv);
  assert.equal(before.status, 0, `forge-dev must run against an intact checkout: ${before.stderr}`);

  // INJECT the defect: drop the `runForge` export the CLI entry destructures + calls. A genuine
  // missing export — `const { runForge } = await import("./program.js")` then yields undefined and
  // the call throws. index.ts routes `launch wait` BEFORE importing program.js, so this breaks the
  // registry/state-reader path specifically.
  const programPath = join(dev, "src", "cli", "program.ts");
  const programSrc = readFileSync(programPath, "utf8");
  assert.ok(programSrc.includes("export async function runForge"), "the dev source exports runForge (this injection is not stale)");
  writeFileSync(programPath, programSrc.replace("export async function runForge", "async function runForge"));

  // RED BASELINE: forge-dev's state-reader path now fails against the broken live source.
  const brokenDev = run(join(dev, "bin", "forge-dev"), ["release", "provenance", "--json"], devEnv);
  assert.notEqual(brokenDev.status, 0, "forge-dev must FAIL against a dev source missing a needed export — that broken dev loop IS the red baseline");

  // GREEN: every stable machine-wide surface is unaffected, from this project's cwd.
  assertStableSurfacesWork(dev, "this-project/missing-export");
});

test("FG-565 F23 (EXECUTED, SYNTAX injection — the LAUNCH-OBSERVER arm): a dev source whose launch module is broken REDDENS forge-dev's OWN observer, while the STABLE launch observer stays green", () => {
  const dev = makeDevCheckout("syntax");
  const devEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };

  // Working first: forge-dev's launch observer reads the seeded record fine on an intact checkout.
  const before = run(join(dev, "bin", "forge-dev"), ["launch", "wait", seededLaunchId, "--json"], devEnv);
  assert.equal(before.status, 0, `forge-dev's launch observer must run against an intact checkout: ${before.stderr}`);
  assert.equal(before.json.kind, "terminal", "and it observes the seeded terminal record");

  // INJECT the defect INTO the observer's own import graph: a real syntax error in v2/launch.ts,
  // which commands/launch-wait.ts imports. This is the sharpest form of the F23 launch-observer
  // arm — the very module the observer needs is broken in the DEV checkout.
  const launchPath = join(dev, "src", "v2", "launch.ts");
  assert.ok(existsSync(launchPath), "the dev checkout carries the launch module");
  writeFileSync(launchPath, "this is not valid typescript ((( <<< \n");

  // RED BASELINE: forge-dev's OWN launch observer now fails to load the broken live source.
  const brokenDev = run(join(dev, "bin", "forge-dev"), ["launch", "wait", seededLaunchId, "--json"], devEnv);
  assert.notEqual(brokenDev.status, 0, "forge-dev's launch observer must FAIL against a broken live launch module — the red baseline for the observer arm");

  // GREEN: the STABLE launch observer (and the readers) are unaffected — this is the arm the
  // ledger flagged as never asserted.
  assertStableSurfacesWork(dev, "this-project/syntax");
});

// ---------------------------------------------------------------------------
// F24 — the "unrelated project directory" clause the ledger flagged as dropped.
// ---------------------------------------------------------------------------

test("FG-565 F24 (EXECUTED): with the forge dev source broken, the STABLE surfaces work from a SECOND, unrelated project dir — and the two project dirs do not cross-contaminate", () => {
  // The broken forge dev checkout (the F23 machine condition).
  const forgeDev = makeDevCheckout("f24");
  const devEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };
  writeFileSync(join(forgeDev, "src", "cli", "index.ts"), "this is not valid typescript ((( <<< \n");
  const brokenDev = run(join(forgeDev, "bin", "forge-dev"), ["release", "provenance", "--json"], devEnv);
  assert.notEqual(brokenDev.status, 0, "the forge dev source is genuinely broken");

  // A genuinely unrelated project dir (not a forge checkout; its own broken source).
  const unrelated = makeUnrelatedProject();
  assert.ok(!existsSync(join(unrelated, "bin", "forge-dev")), "the unrelated project is not a forge checkout");

  // THE F24 ASSERTION: every stable surface works standing in the forge project dir...
  assertStableSurfacesWork(forgeDev, "f24/forge-project");
  // ...AND standing in the completely unrelated project dir. The machine-wide shim pins an
  // absolute interpreter and resolves `current` from FORGE_HOME, so the cwd's (broken) source is
  // irrelevant — the clause the ledger said was quietly dropped.
  assertStableSurfacesWork(unrelated, "f24/unrelated-project");

  // NO CROSS-CONTAMINATION: both dirs drove the SAME hermetic stable runtime, and neither is
  // inside the other. Breaking one project's source left the other's stable runs green (asserted
  // above), and the shared FORGE_HOME is a disposable temp, never the real install.
  assert.ok(!forgeDev.startsWith(unrelated) && !unrelated.startsWith(forgeDev), "the two project dirs are disjoint");
  assert.ok(currentLinkIn(home).startsWith(home), "and both resolved the one hermetic promotion pointer under the temp FORGE_HOME");
});

// ---------------------------------------------------------------------------
// The red baseline is not hollow — the mandatory delegating-forge-dev mutant.
// ---------------------------------------------------------------------------

test("FG-565 F23/F24 MANDATORY MUTANT (EXECUTED): a forge-dev that DELEGATES to the stable release would pass a naive 'stable still works' test — the real forge-dev does not, so the red baseline is genuine", () => {
  // Mirrors fg571-env-identity.integration.test.ts:633. If forge-dev silently exec'd the promoted
  // release, "stable surfaces work under a broken dev source" would be trivially true while the
  // dev loop was destroyed — the developer could no longer run the code they just edited. This
  // proves the injection reddens the REAL dev entry rather than being papered over by delegation.
  const dev = makeDevCheckout("mutant");
  writeFileSync(join(dev, "src", "cli", "index.ts"), "this is not valid typescript ((( <<< \n");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };

  // The hollow mutant: a forge-dev that execs the machine-wide release.
  const delegating = join(dev, "bin", "forge-dev-delegating");
  writeFileSync(delegating, `#!/bin/sh\nexec "\${FORGE_HOME}/current/forge" "$@"\n`);
  chmodSync(delegating, 0o755);
  const mutant = run(delegating, ["release", "provenance", "--json"], env);
  assert.equal(mutant.status, 0, "MUTANT: a delegating forge-dev SUCCEEDS against a broken checkout — a naive test would call the dev loop fine");
  assert.equal(mutant.json.releaseId, rel.manifest.id, "MUTANT: because it reports the STABLE release's identity, not the dev's");

  // The REAL forge-dev does neither: it runs the broken live source and dies there.
  const real = run(join(dev, "bin", "forge-dev"), ["release", "provenance", "--json"], env);
  assert.notEqual(real.status, 0, "the real forge-dev FAILS on the broken checkout — it never reaches for the release, so the F23/F24 red baseline is real");
});

// ---------------------------------------------------------------------------
// Hermeticity / safety, asserted rather than assumed.
// ---------------------------------------------------------------------------

test("FG-565 F23/F24 SAFETY: the machine-wide root is a disposable temp — no npm link, the real ~/.forge, shim and current pointer are untouched", () => {
  assert.ok(shim.startsWith(workspace), "the shim under test lives in a disposable prefix");
  assert.ok(currentLinkIn(home).startsWith(home), "the current pointer under test lives in a disposable FORGE_HOME");
  assert.ok(home.startsWith(join(process.env.HOME ?? "/nonexistent", ".forge")) === false, "the hermetic home is not the operator's real ~/.forge");
  const realHome = join(process.env.HOME ?? "/nonexistent", ".forge");
  assert.ok(!shim.startsWith(realHome), "nothing was installed into the real forge home");
  assert.notEqual(home, realHome, "and FORGE_HOME never points at the operator's real forge home");
  // The seeded launch record lives under the hermetic home, not the operator's launches dir.
  assert.ok(existsSync(join(home, "launches", seededLaunchId, "exit")), "the seeded launch record is under the disposable FORGE_HOME");
});
