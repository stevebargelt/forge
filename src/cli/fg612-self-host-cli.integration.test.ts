// FG-612: the forge-on-forge dispatch guard at the REAL process boundary.
//
// fg612-self-host-dispatch.integration.test.ts drives the dispatch functions
// in-process. This file drives the LIVE control entry — `bin/forge`, the same
// file the machine-wide `forge` on PATH resolves to — as a real subprocess, with
// a throwaway $FORGE_HOME per case. That buys two things the in-process file
// cannot:
//
//   1. The state assertion becomes filesystem-level and total. A refused
//      dispatch must leave the store file itself UNCREATED and $FORGE_HOME/runs
//      empty — not merely "no rows in the handle this test opened".
//   2. The symlinked-binary case is only real here. npm-link installs `forge` as
//      a SYMLINK on PATH; the source root the guard compares against is derived
//      from the executing module, so the guard is only non-decorative if it
//      survives being reached through that link (FG-569 pins the same property
//      for module resolution).
//
// Every case is differential: the refusals are asserted against a control that
// reaches the dispatch machinery under the same harness, so "nothing was
// written" can never pass because nothing ran.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/cli/<this file> → the checkout root. Derived from this module rather than
// cwd so the test targets the tree it was loaded from — the same tree the
// spawned CLI derives its own source root from.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORGE_BIN = join(REPO_ROOT, "bin", "forge");

const tmpDirs: string[] = [];

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

type Run = { status: number | null; stdout: string; stderr: string; home: string };

/** Spawn the live control entry with a throwaway $FORGE_HOME. Worktree env is
 *  cleared unless the case sets it, so an ambient FORGE_WORKTREES on the
 *  developer's shell can never make a refusal case pass vacuously. */
function runForge(args: string[], env: Record<string, string> = {}, root = REPO_ROOT): Run {
  const home = temp("forge-fg612-home-");
  const child = spawnSync(join(root, "bin", "forge"), args, {
    encoding: "utf8",
    cwd: home,
    timeout: 120_000,
    env: {
      ...process.env,
      FORGE_HOME: home,
      NO_NOTIFY: "true",
      FORGE_WORKTREES: "",
      FORGE_NO_WORKTREES: "",
      ...env,
    },
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "", home };
}

/** Everything a dispatch writes before it can start a container: the store file
 *  and the per-run directory. Both must be absent after a refusal. */
function footprint(home: string): { db: boolean; runs: string[] } {
  const runsDir = join(home, "runs");
  return {
    db: existsSync(join(home, "forge.db")),
    runs: existsSync(runsDir) ? readdirSync(runsDir) : [],
  };
}

function assertRefusedAndTraceless(label: string, r: Run): void {
  const out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, `${label}: must exit non-zero\n${out}`);
  assert.match(out, /REFUSING to dispatch/, `${label}: must name the refusal\n${out}`);
  assert.match(out, /FG-612/, `${label}: must cite the ticket\n${out}`);

  const fp = footprint(r.home);
  assert.equal(fp.db, false, `${label}: the store file must never be created`);
  assert.deepEqual(fp.runs, [], `${label}: no run directory may be created`);
}

/** The control: a dispatch the guard must be invisible to. It gets past the
 *  guard into the real dispatch machinery (which then stops at the unpublished
 *  seed generation in this throwaway $FORGE_HOME) — proven by the run row and
 *  run directory it leaves behind, exactly the footprint a refusal must not. */
function assertReachedDispatch(label: string, r: Run): void {
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /REFUSING to dispatch/, `${label}: must not be refused\n${out}`);

  const fp = footprint(r.home);
  assert.equal(fp.db, true, `${label}: the dispatch reached the store\n${out}`);
  assert.equal(fp.runs.length, 1, `${label}: the dispatch minted its run directory\n${out}`);
}

function project(prefix: string): string {
  const dir = temp(prefix);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** A test-owned forge root the spawned CLI genuinely executes from: this
 *  checkout's dispatch surface copied into a writable parent, so a
 *  prefix-colliding sibling can exist next to it. bin/forge canonicalizes $0 and
 *  node realpaths every module, so a symlinked tree would resolve straight back
 *  to this checkout and prove nothing — the source files must be real copies.
 *  node_modules is the one symlink: nothing derives a root from it. */
function forgeRootCopy(): string {
  const root = join(temp("forge-fg612-fixture-"), "forge");
  mkdirSync(root, { recursive: true });
  for (const d of ["bin", "src", "seeds", "scripts", "docker"]) {
    cpSync(join(REPO_ROOT, d), join(root, d), { recursive: true });
  }
  for (const f of ["package.json", "tsconfig.json"]) {
    cpSync(join(REPO_ROOT, f), join(root, f));
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  return root;
}

beforeEach(() => {
  assert.ok(existsSync(FORGE_BIN), `the live control entry must exist at ${FORGE_BIN}`);
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── The refusal, end to end, writing nothing ─────────────────────────────────

test("`forge invoke` against the live forge checkout refuses and leaves no store file and no run directory", () => {
  const r = runForge(["invoke", "engineer", "--task", "edit forge itself", "--project", REPO_ROOT, "--unrouted"]);
  assertRefusedAndTraceless("forge invoke", r);
});

test("`forge new` against the live forge checkout refuses before the run exists", () => {
  const r = runForge(["new", "feature", "fg612 probe", "--project", REPO_ROOT]);
  assertRefusedAndTraceless("forge new", r);
});

// EXPECTATION CHANGE (was: this case asserted the invoke refusal offers
// FORGE_WORKTREES=1). It is the wrong advice on this surface: arming isolation
// does not isolate an invoke, so an operator who followed it would be back on the
// live checkout believing it fixed. The refusal now names the clone instead.
test("the invoke refusal names the source root and the two things that actually work: a clone, or the acknowledged override", () => {
  const r = runForge(["invoke", "engineer", "--task", "t", "--project", REPO_ROOT, "--unrouted"]);
  const out = r.stdout + r.stderr;
  assert.match(out, /forge source root:/);
  assert.match(out, /CLONE of the forge checkout/, `the actual fix must be named\n${out}`);
  assert.match(out, /FORGE_NO_WORKTREES=1/);
  assert.doesNotMatch(out, /FORGE_WORKTREES=1/, `arming isolation does not isolate an invoke\n${out}`);
});

// ── Symlinks: the two shapes that would make the guard silently inert ────────

test("invoked THROUGH an npm-link style symlinked binary, the guard still fires", () => {
  // ~/.nvm/versions/node/vXX/bin/forge → <checkout>/bin/forge. The CLI resolves
  // its source root from the executing module, so a guard that compared the
  // symlink's own path would never match and would be purely decorative.
  const linkDir = temp("forge-fg612-bin-");
  const link = join(linkDir, "forge");
  symlinkSync(FORGE_BIN, link);

  const home = temp("forge-fg612-home-");
  const child = spawnSync(link, ["invoke", "engineer", "--task", "t", "--project", REPO_ROOT, "--unrouted"], {
    encoding: "utf8",
    cwd: home,
    timeout: 120_000,
    env: { ...process.env, FORGE_HOME: home, NO_NOTIFY: "true", FORGE_WORKTREES: "", FORGE_NO_WORKTREES: "" },
  });

  assertRefusedAndTraceless("via symlinked binary", {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    home,
  });
});

test("a project spelled through a symlinked parent still refuses (the /var → /private/var shape)", () => {
  // macOS spells /var/folders/... and /private/var/folders/... for one tree; an
  // un-canonicalized compare silently never matches.
  const linkFarm = temp("forge-fg612-link-");
  const aliasParent = join(linkFarm, "alias");
  symlinkSync(dirname(REPO_ROOT), aliasParent);
  // basename, not a slice of the parent's length: a checkout mounted AT a filesystem
  // root (/project, every agent container) has dirname "/", and the arithmetic
  // spelling ate the first character — the alias pointed at a tree that does not
  // exist, so the case passed for the wrong reason or not at all.
  const viaLink = join(aliasParent, basename(REPO_ROOT));

  assert.notEqual(viaLink, REPO_ROOT, "fixture: a different string for the same tree");
  assert.equal(realpathSync(viaLink), REPO_ROOT, "fixture: the alias must spell the SAME tree");
  assertRefusedAndTraceless(
    "symlinked parent",
    runForge(["invoke", "engineer", "--task", "t", "--project", viaLink, "--unrouted"]),
  );
});

// ── Overlap in both directions, and the string-prefix negative ───────────────

test("a parent-dir mount that CONTAINS the forge checkout refuses", () => {
  assertRefusedAndTraceless(
    "parent-dir mount",
    runForge(["invoke", "engineer", "--task", "t", "--project", dirname(REPO_ROOT), "--unrouted"]),
  );
});

test("a SUBDIR of the forge checkout (--allow-subproject) refuses", () => {
  const sub = join(REPO_ROOT, "dashboard");
  assert.ok(existsSync(sub), `fixture: ${sub} must exist`);
  assertRefusedAndTraceless(
    "subproject mount",
    runForge(["invoke", "engineer", "--task", "t", "--project", sub, "--allow-subproject", "--unrouted"]),
  );
});

test("a sibling directory that merely shares a string prefix with the checkout is NOT refused", () => {
  // `<root>-scratch` startsWith `<root>` — the exact false positive a naive prefix
  // compare produces, and it would refuse a legitimate project forever.
  //
  // FG-644: this used to mkdir that directory literally next to the checkout. A
  // checkout mounted at /project has an unwritable parent, so the fixture died
  // EACCES and the case never ran in the environment agents actually use. Asserting
  // the collision on the PREDICATE instead, while spawning the CLI at an unrelated
  // mkdtemp project, split the two halves: the spawned CLI derives its own source
  // root from its executing module, so a divergence between that derivation and the
  // predicate's — or a prefix-based preflight ahead of the guard — would leave both
  // halves green while production regressed.
  //
  // So the CLI is spawned from a forge root the TEST owns: a copy of this checkout's
  // dispatch surface (the same source files, so it is the real guard running), with
  // a writable prefix-colliding sibling next to it. Both halves then go through the
  // live control entry.
  const fixture = forgeRootCopy();
  const sibling = `${fixture}-scratch`;
  mkdirSync(join(sibling, ".git"), { recursive: true });
  assert.ok(
    realpathSync(sibling).startsWith(realpathSync(fixture)),
    "fixture: the sibling must actually collide on the forge root's string prefix",
  );

  // The control, through the same spawned entry: the copied tree IS the source root
  // this CLI resolves. Without it the case below could pass because the CLI never
  // ran from the fixture, not because the sibling is allowed.
  const control = runForge(["invoke", "engineer", "--task", "t", "--project", fixture, "--unrouted"], {}, fixture);
  assertRefusedAndTraceless("test-owned forge root", control);
  assert.match(
    control.stdout + control.stderr,
    new RegExp(`forge source root:\\s+${realpathSync(fixture)}\\b`),
    "the refusal must name the test-owned root — proof the CLI is executing from it",
  );

  assertReachedDispatch(
    "prefix-colliding sibling of the forge root",
    runForge(["invoke", "engineer", "--task", "t", "--project", sibling, "--unrouted"], {}, fixture),
  );
});

// ── The two ways through must reach the dispatch machinery ──────────────────

// EXPECTATION CHANGE (was: FORGE_WORKTREES=1 let this through). `forge invoke`
// provisions no workspace, so the flag only ever silenced the guard here. It
// remains a way through on the workflow-dispatch path, which does provision one.
test("FORGE_WORKTREES=1 does NOT let the self-host invoke through — the flag isolates nothing on this path", () => {
  const r = runForge(["invoke", "engineer", "--task", "t", "--project", REPO_ROOT, "--unrouted"], {
    FORGE_WORKTREES: "1",
  });
  assertRefusedAndTraceless("FORGE_WORKTREES=1", r);
});

test("`forge new` — the workflow path — is unchanged: FORGE_WORKTREES=1 is still a way past the guard", () => {
  // assertReachedDispatch is not usable here: `forge new` mints neither the store
  // nor a run directory in a throwaway $FORGE_HOME — it stops at one of the gates
  // the guard sits in front of, and WHICH one it reaches is a property of the host,
  // not of the guard. new.ts runs them in this order, all strictly after
  // assertSelfHostDispatchAllowed(): the unrouted route preflight (always emitted —
  // this case passes neither --route nor --unrouted), then validateCredsForNewRun()
  // (fires on a host that can see it has no usable credentials — CI's Linux runner),
  // then the seed-generation resolve (fires on a host whose auth resolves — the dev
  // Mac). Pinning any single one made the test hostage to that ordering. So: match
  // the union — downstream markers, any of which proves the guard was passed,
  // because the guard throws and none of them can be reached if it fires.
  const r = runForge(["new", "feature", "fg612 probe", "--project", REPO_ROOT], { FORGE_WORKTREES: "1" });
  const out = r.stdout + r.stderr;

  assert.doesNotMatch(out, /REFUSING to dispatch/, `the workflow path must not be refused\n${out}`);
  assert.doesNotMatch(out, /FG-612/, `no self-host refusal may fire on the workflow path\n${out}`);
  assert.match(
    out,
    /dispatching WITHOUT a resolved route|Auth error: |no complete seed generation/,
    `it must get downstream of the guard\n${out}`,
  );
});

test("FORGE_NO_WORKTREES=1 lets it through and warns that agents write to the live source", () => {
  const r = runForge(["invoke", "engineer", "--task", "t", "--project", REPO_ROOT, "--unrouted"], {
    FORGE_NO_WORKTREES: "1",
  });
  assertReachedDispatch("FORGE_NO_WORKTREES=1", r);
  assert.match(r.stderr, /WARNING — dispatching against the live forge source/);
  assert.match(r.stderr, /FORGE_NO_WORKTREES=1/);
  assert.match(
    r.stderr,
    /disposable CLONE of the forge checkout/,
    `invoke provisions nothing — a clone is the only fix\n${r.stderr}`,
  );
  assert.doesNotMatch(
    r.stderr,
    /unset FORGE_NO_WORKTREES/,
    `unsetting it turns this allowed dispatch into the refusal — it does not isolate\n${r.stderr}`,
  );
});

// ── The regression that matters most ────────────────────────────────────────

test("a DIFFERENT project is untouched by the guard in every env combination", () => {
  const combos: Record<string, string>[] = [
    {},
    { FORGE_WORKTREES: "1" },
    { FORGE_NO_WORKTREES: "1" },
    { FORGE_WORKTREES: "1", FORGE_NO_WORKTREES: "1" },
  ];

  for (const combo of combos) {
    const label = `normal project ${JSON.stringify(combo)}`;
    const r = runForge(
      ["invoke", "engineer", "--task", "normal work", "--project", project("forge-fg612-other-"), "--unrouted"],
      combo,
    );
    assertReachedDispatch(label, r);
    assert.doesNotMatch(r.stdout + r.stderr, /live forge source/, `${label}: no FG-612 output at all`);
  }
});
