// FG-583 (FG-572 Child 5h) — PROMOTED-LAYOUT acceptance test, driven through the
// REAL INSTALLED CLI as SUBPROCESSES (graded AC, rewritten per the FG-583 reopen).
//
// The prior version drove runUpgrade()/resolveSeedGeneration()/loadWorkflow()
// IN-PROCESS against dev fixtures — it never proved the INSTALLED surface. This
// version builds two real releases (A and B) from a DISPOSABLE source checkout,
// PROMOTES them, installs the machine-wide SHIM, and drives the shim as
// SUBPROCESSES (`forge upgrade --skip-project`, `forge setup`, a `forge invoke`
// dispatch entry, `forge doctor`). All assertions read the on-disk seed generation
// the SUBPROCESS published — the driving is the installed CLI, never a library call.
//
// Releases A and B ship DIFFERENT marker workflow sets (A: {alpha, beta};
// B: {alpha, gamma}), each file Zod-valid but any A/B mixture a set no release
// shipped — the marker rides in each workflow `description`. The acceptance criteria:
//
//   1. FAIL-CLOSED: BEFORE `forge upgrade --skip-project`, an installed dispatch
//      entry REFUSES with the named no-generation state — so the documented step is
//      genuinely required and the install fails closed until it succeeds (Finding 2).
//   2. The documented bootstrap (promote -> shim -> `forge upgrade --skip-project`
//      -> `forge setup`) makes dispatch resolve ONE complete generation whose bytes
//      are EXCLUSIVELY release A's — a divergent FORGE_REPO_DIR never leaks in.
//   3. Promoting B (a second real `forge upgrade`) → a NEW dispatch resolves ONE
//      complete B generation, while the retained A generation still holds A's bytes
//      and B's exclusive workflow (`gamma`) is absent from it — an already-open
//      invocation anchored to A can never observe an A/B mix (Finding 3).
//   4. The destination-trust refusal fires at the INSTALLED `forge upgrade` surface:
//      a replaceable destination symlink escaping the home is refused and the
//      unrelated target is left byte-for-byte unchanged.
//
// SAFETY: every release is built from a DISPOSABLE source root and promoted into a
// mkdtemp FORGE_HOME with an explicit --prefix; the subprocess env pins FORGE_HOME
// and a stub ANTHROPIC_API_KEY so dispatch reaches the seed/policy gate on any host.
// The real ~/.forge is NEVER touched, and no git command runs against the real repo.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIM_NAME, renderShim, thawReleaseTree, type BuildReleaseResult } from "../../v2/release.js";
import { installShim, promote } from "../../v2/promote.js";
import { seedCurrentLinkIn, seedGenerationsDirIn } from "../../util/paths.js";
import { findGitRoot } from "../../util/git-root.js";
import { canonicalMkdtemp, makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "../../v2/fg571-harness.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
let releaseA: BuildReleaseResult;
let releaseB: BuildReleaseResult;
let repoHeadBefore: string;

function workflowYaml(name: string, marker: string): string {
  return [
    `name: ${name}`,
    `description: "workflow ${name} shipped by release ${marker}"`,
    `steps:`,
    `  - id: only`,
    `    agent: architecture-advisor`,
    ``,
  ].join("\n");
}

/** Shape the disposable source's marker workflow set for a release, then commit
 *  (buildRelease refuses a dirty source). Marker workflows are ADDITIVE to the real
 *  seeds; `remove` drops a marker from the previous shape. */
function shapeAndCommit(marker: string, present: string[], remove: string[]): void {
  const wf = join(source.root, "seeds", "workflows");
  for (const n of present) writeFileSync(join(wf, `${n}.yml`), workflowYaml(n, marker));
  for (const n of remove) rmSync(join(wf, `${n}.yml`), { force: true });
  execFileSync("git", ["add", "-A"], { cwd: source.root });
  execFileSync("git", ["-c", "user.email=fg583@test.invalid", "-c", "user.name=fg583", "commit", "-q", "-m", `shape ${marker}`], { cwd: source.root });
}

/** Run the installed shim as a subprocess against an explicit FORGE_HOME, with a
 *  stub API key so dispatch reaches the seed gate on any host. `repoDir` sets a
 *  DIVERGENT FORGE_REPO_DIR to prove it never leaks into the promoted seed source. */
function runForge(shimPath: string, args: string[], home: string, opts: { repoDir?: string; cwd?: string } = {}): { status: number | null; stderr: string; stdout: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_HOME: home,
    ANTHROPIC_API_KEY: "sk-stub",
    HOME: process.env.HOME ?? "/tmp",
    NO_NOTIFY: "true",
  };
  if (opts.repoDir) env.FORGE_REPO_DIR = opts.repoDir;
  else delete env.FORGE_REPO_DIR;
  const r = spawnSync(shimPath, args, { encoding: "utf8", env, timeout: 120000, cwd: opts.cwd });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

/** The generation dir the seed pointer currently resolves to (realpath), or null. */
function currentGenDir(home: string): string | null {
  const link = seedCurrentLinkIn(home);
  try {
    return existsSync(link) ? realpathSync(link) : null;
  } catch {
    return null;
  }
}

function readWorkflow(genDir: string, name: string): string {
  return readFileSync(join(genDir, "workflows", `${name}.yml`), "utf8");
}

/** A fresh disposable home built releases A and B are promotable into (both were
 *  built against `source.home`, so they promote only into that home — FG-571 F4). */
function freshHome(label: string): { home: string; shim: string } {
  const home = source.home; // the store both releases pin
  // Clear any prior generation state so each test starts from no-generation.
  rmSync(seedGenerationsDirIn(home), { recursive: true, force: true });
  rmSync(seedCurrentLinkIn(home), { force: true });
  rmSync(join(home, "seed-selection"), { force: true });
  rmSync(join(home, "seed-previous"), { force: true });
  const prefix = canonicalMkdtemp(`fg583-prefix-${label}-`);
  const shim = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
  return { home, shim };
}

before(async () => {
  repoHeadBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  workspace = canonicalMkdtemp("fg583-promoted-ws-");
  source = await makeDisposableSourceRoot(repoRoot);
  // Release A ships {alpha, beta}; release B ships {alpha, gamma}. Both built against
  // source.home so both promote into it.
  shapeAndCommit("A", ["alpha", "beta"], []);
  releaseA = source.build({ outDir: join(workspace, "release-A"), rand: "fg583a", home: source.home });
  shapeAndCommit("B", ["alpha", "gamma"], ["beta"]);
  releaseB = source.build({ outDir: join(workspace, "release-B"), rand: "fg583b", home: source.home });
});

after(() => {
  if (existsSync(workspace)) {
    thawReleaseTree(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
  // Promotions into source.home froze the materialized release units there; thaw the
  // build home (NOT source.root, whose node_modules is a symlink) so the plain rmSync
  // in removeDisposableSourceRoot can traverse it.
  if (source && existsSync(source.home)) thawReleaseTree(source.home);
  if (source) removeDisposableSourceRoot(source);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(), repoHeadBefore, "the suite left the real checkout's HEAD unmoved");
});

test("FG-583 SAFETY: releases are built from a DISPOSABLE checkout, never the real repository", () => {
  assert.notEqual(source.root, repoRoot);
  assert.ok(!source.root.startsWith(repoRoot), "the disposable checkout is not inside the real repository");
});

test("FG-583 (Finding 2): BEFORE `forge upgrade`, an installed dispatch entry FAILS CLOSED with the named no-generation state; the documented bootstrap then makes it dispatchable — exclusively A's bytes under a divergent FORGE_REPO_DIR", () => {
  const { home, shim } = freshHome("bootstrap");
  const proj = canonicalMkdtemp("fg583-proj-boot-");
  execFileSync("git", ["init", "-q"], { cwd: proj });
  promote({ home, candidate: releaseA.releaseDir });

  // FAIL-CLOSED: no generation is published yet, so an installed dispatch entry
  // REFUSES with the named no-generation state — the documented `forge upgrade`
  // step is genuinely required.
  assert.equal(currentGenDir(home), null, "no generation is published before upgrade");
  const before = runForge(shim, ["invoke", "engineer", "--task", "probe", "--project", proj, "--unrouted"], home);
  assert.notEqual(before.status, 0, "dispatch refuses before a generation exists");
  assert.match(before.stderr, /no complete seed generation|refusing to dispatch/i, `the refusal names the no-generation state — got: ${before.stderr.slice(0, 400)}`);

  // THE DOCUMENTED BOOTSTRAP, driven through the installed shim. A DIVERGENT
  // FORGE_REPO_DIR (release B's tree) is present but must never become the source.
  runForge(shim, ["upgrade", "--skip-project"], home, { repoDir: releaseB.releaseDir });
  runForge(shim, ["setup"], home);

  const gen = currentGenDir(home);
  assert.ok(gen, "after the documented bootstrap a complete generation is published");
  // EXCLUSIVELY A's bytes: alpha+beta are A's, and the divergent B checkout never leaked.
  assert.match(readWorkflow(gen!, "alpha"), /release A/, "alpha is release A's bytes");
  assert.match(readWorkflow(gen!, "beta"), /release A/, "beta is release A's bytes");
  assert.ok(!existsSync(join(gen!, "workflows", "gamma.yml")), "B-only gamma never leaked from the divergent FORGE_REPO_DIR");

  // CONSUMED: a dispatch entry now gets PAST the seed gate (no no-generation refusal).
  const after = runForge(shim, ["invoke", "engineer", "--task", "probe", "--project", proj, "--unrouted"], home);
  assert.doesNotMatch(after.stderr, /no complete seed generation/i, `dispatch consumes the published generation — got: ${after.stderr.slice(0, 400)}`);

  // Finding 5: `forge route compile` for the HOST source REFUSES-and-DIRECTS at the
  // installed surface — it does NOT silently rewrite a flat routing-policy.yml (which
  // would change nothing a run reads); it points the operator at `forge upgrade`.
  const neutralCwd = canonicalMkdtemp("fg583-neutral-cwd-");
  const compile = runForge(shim, ["route", "compile"], home, { cwd: neutralCwd });
  assert.match(compile.stdout + compile.stderr, /forge upgrade/i, `host route compile directs to forge upgrade — got: ${(compile.stdout + compile.stderr).slice(0, 400)}`);
  assert.doesNotMatch(compile.stdout, /Compiled \d+ routes \(host\) ->/, "host route compile does NOT perform a flat write");

  rmSync(neutralCwd, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("FG-583 (Finding 3): promoting B → a NEW dispatch resolves ONE complete B generation, while the retained A generation still holds A's bytes and B-only `gamma` is invisible to it — no A/B mix", () => {
  const { home, shim } = freshHome("promoteB");
  promote({ home, candidate: releaseA.releaseDir });
  runForge(shim, ["upgrade", "--skip-project"], home);
  const genA = currentGenDir(home);
  assert.ok(genA, "release A generation is published");
  assert.match(readWorkflow(genA!, "alpha"), /release A/);
  assert.match(readWorkflow(genA!, "beta"), /release A/);

  // Atomically promote B and republish via a second real `forge upgrade`.
  promote({ home, candidate: releaseB.releaseDir });
  runForge(shim, ["upgrade", "--skip-project"], home);
  const genB = currentGenDir(home);
  assert.ok(genB, "release B generation is published");
  assert.notEqual(genA, genB, "distinct complete generations — no run spans both");

  // A NEW invocation resolves the live pointer → ONE complete B generation.
  assert.match(readWorkflow(genB!, "alpha"), /release B/, "the new generation is release B's bytes");
  assert.match(readWorkflow(genB!, "gamma"), /release B/, "B's exclusive workflow is present in the new generation");

  // The ALREADY-OPEN invocation anchored to genA stays on COMPLETE A: the A
  // generation is retained (never recycled), still holds A's bytes, and B's
  // exclusive workflow gamma is NOT visible through it — so it can never observe an
  // A/B mix.
  assert.ok(existsSync(genA!), "the A generation is retained after B is promoted");
  assert.match(readWorkflow(genA!, "alpha"), /release A/, "A's anchor still reads A's bytes");
  assert.match(readWorkflow(genA!, "beta"), /release A/);
  assert.ok(!existsSync(join(genA!, "workflows", "gamma.yml")), "B-only gamma is invisible to A's anchor — no cross-generation mix");
});

test("FG-583 (Finding 3): the destination-trust refusal fires at the INSTALLED `forge upgrade` surface — a replaceable destination symlink is refused, the unrelated target unchanged", () => {
  const { home, shim } = freshHome("desttrust");
  promote({ home, candidate: releaseA.releaseDir });

  const unrelated = canonicalMkdtemp("fg583-dt-unrelated-");
  const sentinel = join(unrelated, "keep.txt");
  writeFileSync(sentinel, "do-not-touch");
  // Replace the generations store with a symlink escaping the disposable home.
  const genStore = seedGenerationsDirIn(home);
  rmSync(genStore, { recursive: true, force: true });
  symlinkSync(unrelated, genStore);

  const r = runForge(shim, ["upgrade", "--skip-project"], home);
  // The installed surface refuses the escaping destination and the unrelated target
  // is byte-for-byte unchanged; no generation slipped in.
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch", "the unrelated target is left byte-for-byte unchanged");
  assert.match(r.stdout + r.stderr, /escapes the forge home|refusing to publish|destination/i, `the installed surface names the destination refusal — got: ${(r.stdout + r.stderr).slice(0, 400)}`);
  assert.deepEqual(readdirSync(unrelated), ["keep.txt"], "nothing was written into the escaped target");

  rmSync(genStore, { force: true });
  rmSync(unrelated, { recursive: true, force: true });
});
