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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
function runForge(args: string[], env: Record<string, string> = {}): Run {
  const home = temp("forge-fg612-home-");
  const child = spawnSync(FORGE_BIN, args, {
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

test("the refusal names both the project and the executing source root, and both escape hatches", () => {
  const r = runForge(["invoke", "engineer", "--task", "t", "--project", REPO_ROOT, "--unrouted"]);
  const out = r.stdout + r.stderr;
  assert.match(out, /FORGE_WORKTREES=1/);
  assert.match(out, /FORGE_NO_WORKTREES=1/);
  assert.match(out, /forge source root:/);
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
  const viaLink = join(aliasParent, REPO_ROOT.slice(dirname(REPO_ROOT).length + 1));

  assert.notEqual(viaLink, REPO_ROOT, "fixture: a different string for the same tree");
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
  const sibling = `${REPO_ROOT}-fg612-sibling`;
  mkdirSync(join(sibling, ".git"), { recursive: true });
  tmpDirs.push(sibling);
  assertReachedDispatch(
    "string-prefix sibling",
    runForge(["invoke", "engineer", "--task", "t", "--project", sibling, "--unrouted"]),
  );
});

// ── The two ways through must reach the dispatch machinery ──────────────────

test("FORGE_WORKTREES=1 lets the self-host dispatch through to the dispatch machinery, silently", () => {
  const r = runForge(["invoke", "engineer", "--task", "t", "--project", REPO_ROOT, "--unrouted"], {
    FORGE_WORKTREES: "1",
  });
  assertReachedDispatch("FORGE_WORKTREES=1", r);
  assert.doesNotMatch(r.stdout + r.stderr, /WARNING — dispatching against the live forge source/);
});

test("FORGE_NO_WORKTREES=1 lets it through and warns that agents write to the live source", () => {
  const r = runForge(["invoke", "engineer", "--task", "t", "--project", REPO_ROOT, "--unrouted"], {
    FORGE_NO_WORKTREES: "1",
  });
  assertReachedDispatch("FORGE_NO_WORKTREES=1", r);
  assert.match(r.stderr, /WARNING — dispatching against the live forge source/);
  assert.match(r.stderr, /FORGE_NO_WORKTREES=1/);
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
