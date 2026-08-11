// FG-612: the forge-on-forge dispatch guard. The negative path IS the point of
// the ticket, so the refusal cases are asserted first and hardest.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSelfHostDispatchAllowed,
  classifySelfHostDispatch,
  isSelfHostDispatch,
  forgeSourceRoot,
  _resetSelfHostWarnings,
  type DispatchIsolation,
} from "./self-host-guard.js";
import { assetRoot } from "./asset-root.js";
import { isWorktreeModeEnabled } from "./worktree-lifecycle.js";

/** Exactly what the workflow-dispatch sites (runNext.ts x3, new.ts) pass: those
 *  paths provision a task-scoped workspace when worktree mode is armed. The
 *  guard is given this answer; it never derives it. */
function workflowIsolation(): DispatchIsolation {
  return isWorktreeModeEnabled() ? "isolated" : "not-armed";
}

let workspace: string;
let forgeRoot: string;
let otherProject: string;
let stderr: string[];
const savedEnv = { ...process.env };

/** Captured before any test can spoof it — restoring from process.platform inside
 *  afterEach would read the spoof and leak it into every later test. */
const REAL_PLATFORM = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function refusalOn(platform: string): string {
  setPlatform(platform);
  try {
    assertSelfHostDispatchAllowed(forgeRoot, workflowIsolation(), forgeRoot);
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail(`expected a refusal on ${platform}`);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "forge-fg612-"));
  forgeRoot = join(workspace, "code", "forge");
  otherProject = join(workspace, "code", "meatgeekv2");
  mkdirSync(forgeRoot, { recursive: true });
  mkdirSync(otherProject, { recursive: true });
  stderr = [];
  mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  // FG-345: isolation is default-ON, so "unset" no longer means off — these cases
  // mean isolation is NOT armed, and must say so explicitly.
  process.env["FORGE_WORKTREES"] = "0";
  delete process.env["FORGE_NO_WORKTREES"];
  _resetSelfHostWarnings();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  mock.restoreAll();
  process.env = { ...savedEnv };
  setPlatform(REAL_PLATFORM);
});

// ── The refusal ───────────────────────────────────────────────────────────────

test("self-host dispatch with worktree mode off REFUSES", () => {
  assert.throws(
    () => assertSelfHostDispatchAllowed(forgeRoot, workflowIsolation(), forgeRoot),
    (e: Error) => {
      assert.match(e.message, /REFUSING to dispatch/);
      assert.match(e.message, /self-host/i);
      return true;
    }
  );
});

test("the refusal names the project path and the shared-mount escape — an operator must be able to act on it", () => {
  const message = refusalOn(REAL_PLATFORM);
  assert.ok(message.includes(realpathSync(forgeRoot)), `refusal must name the project path:\n${message}`);
  assert.match(message, /FORGE_NO_WORKTREES=1/);
});

// FG-345 made isolation default-on, so the remediation is platform-specific:
// "set FORGE_WORKTREES=1" is the fix ONLY where the platform default is off AND
// the worktree preflight would pass. Naming it anywhere else sends the operator
// into a no-op (darwin) or into the permanent Linux hard-fail.

test("on darwin the remediation is to UNSET the explicit off — isolation is already the default there", () => {
  const message = refusalOn("darwin");
  assert.match(message, /unset FORGE_WORKTREES/);
  assert.match(message, /default/i);
  assert.doesNotMatch(message, /FORGE_WORKTREES=1/, `darwin must not present FORGE_WORKTREES=1 as the fix:\n${message}`);
});

test("on linux the remediation does NOT present FORGE_WORKTREES=1 — that reaches the permanent platform hard-fail", () => {
  const message = refusalOn("linux");
  assert.match(message, /hard-fails on Linux/);
  assert.match(message, /will NOT arm it/);
  assert.match(message, /FORGE_NO_WORKTREES=1/);
});

test("on win32 FORGE_WORKTREES=1 IS the fix — the platform default is off but the preflight gate lets it through", () => {
  const message = refusalOn("win32");
  assert.match(message, /FORGE_WORKTREES=1 {6}arm worktree isolation/);
  assert.match(message, /win32/);
});

// ── The two ways through ──────────────────────────────────────────────────────

test("FORGE_WORKTREES=1 proceeds silently — isolation is armed", () => {
  process.env["FORGE_WORKTREES"] = "1";
  assertSelfHostDispatchAllowed(forgeRoot, workflowIsolation(), forgeRoot);
  assert.equal(stderr.join(""), "");
});

test("FORGE_NO_WORKTREES=1 proceeds, loudly", () => {
  process.env["FORGE_NO_WORKTREES"] = "1";
  assertSelfHostDispatchAllowed(forgeRoot, workflowIsolation(), forgeRoot);
  const out = stderr.join("");
  assert.match(out, /WARNING/);
  assert.match(out, /live forge source/);
  assert.match(out, /FORGE_NO_WORKTREES=1/);
  assert.match(out, /unset FORGE_NO_WORKTREES/, `on a path that CAN isolate, unsetting it is the fix:\n${out}`);
});

test("the kill switch beats FORGE_WORKTREES=1 — worktree mode is off, so the override path is what proceeds", () => {
  process.env["FORGE_WORKTREES"] = "1";
  process.env["FORGE_NO_WORKTREES"] = "1";
  assertSelfHostDispatchAllowed(forgeRoot, workflowIsolation(), forgeRoot);
  assert.match(stderr.join(""), /WARNING/);
});

// ── FG-345 regression: the guard keys on THIS dispatch, not the global default ─
//
// isWorktreeModeEnabled() answers "is isolation the default on this host".
// FG-345 made that true by default on darwin, and reading it as "this dispatch
// is isolated" then permitted the exact dispatch the guard exists to refuse:
// invoke.ts provisions no workspace and mounts the live checkout regardless.

test("a self-host INVOKE refuses even where isolation is on by default — that path provisions nothing", () => {
  setPlatform("darwin");
  delete process.env["FORGE_WORKTREES"];
  assert.equal(isWorktreeModeEnabled(), true, "fixture: the FG-345 default-on host, no env set");

  assert.throws(
    () => assertSelfHostDispatchAllowed(forgeRoot, "never-isolated", forgeRoot),
    (e: Error) => {
      assert.match(e.message, /REFUSING to dispatch/);
      assert.match(e.message, /provisions no isolated workspace/);
      return true;
    }
  );
});

test("the same host, WORKFLOW dispatch: default-on isolation still proceeds silently — unchanged", () => {
  setPlatform("darwin");
  delete process.env["FORGE_WORKTREES"];
  assert.equal(workflowIsolation(), "isolated");

  assertSelfHostDispatchAllowed(forgeRoot, workflowIsolation(), forgeRoot);
  assert.equal(stderr.join(""), "");
});

test("FORGE_NO_WORKTREES=1 still permits the no-isolation path, loudly", () => {
  setPlatform("darwin");
  process.env["FORGE_NO_WORKTREES"] = "1";

  assertSelfHostDispatchAllowed(forgeRoot, "never-isolated", forgeRoot);
  const out = stderr.join("");
  assert.match(out, /WARNING/);
  assert.match(out, /live forge source/);
});

// The override warning must agree with the refusal above: on a path that
// provisions nothing, "unset the flag to isolate instead" is false advice —
// unsetting it only turns this acknowledged dispatch into the refusal.
test("the no-isolation override warning advises a CLONE and never advises unsetting the flag to isolate", () => {
  setPlatform("darwin");
  process.env["FORGE_NO_WORKTREES"] = "1";

  assertSelfHostDispatchAllowed(forgeRoot, "never-isolated", forgeRoot);
  const out = stderr.join("");
  assert.match(out, /disposable CLONE of the forge checkout/, `the only real fix must be named:\n${out}`);
  assert.match(out, /no worktree flag isolates it/, `the warning must read as structural:\n${out}`);
  assert.doesNotMatch(
    out,
    /unset FORGE_NO_WORKTREES/,
    `unsetting it turns this allowed dispatch into the structural refusal, it does not isolate:\n${out}`
  );
  assert.doesNotMatch(out, /FORGE_WORKTREES=0/, `arming isolation cannot create a workspace here:\n${out}`);
});

test("a DIFFERENT project on the no-isolation path is untouched — the refusal is about the forge tree", () => {
  setPlatform("darwin");
  delete process.env["FORGE_WORKTREES"];

  assertSelfHostDispatchAllowed(otherProject, "never-isolated", forgeRoot);
  assert.equal(stderr.join(""), "");
});

test("the no-isolation refusal advises a CLONE and never FORGE_WORKTREES=1 — arming it would not isolate an invoke", () => {
  setPlatform("darwin");
  delete process.env["FORGE_WORKTREES"];
  let message = "";
  try {
    assertSelfHostDispatchAllowed(forgeRoot, "never-isolated", forgeRoot);
  } catch (e) {
    message = (e as Error).message;
  }

  assert.match(message, /CLONE of the forge checkout/, `the actual fix must be named:\n${message}`);
  assert.match(message, /FORGE_NO_WORKTREES=1/);
  assert.match(message, /forge invoke/, `the operator must learn WHICH surface is uncovered:\n${message}`);
  assert.match(message, /structural/, `the refusal must read as structural, not as a missing flag:\n${message}`);
  assert.doesNotMatch(
    message,
    /FORGE_WORKTREES=1/,
    `arming isolation does not isolate an invoke — advising it lands the operator back in the hazard:\n${message}`
  );
});

// ── No effect on any other project ────────────────────────────────────────────

test("a DIFFERENT project is unaffected in every env combination", () => {
  const combos = [
    {},
    { FORGE_WORKTREES: "1" },
    { FORGE_NO_WORKTREES: "1" },
    { FORGE_WORKTREES: "1", FORGE_NO_WORKTREES: "1" },
  ];
  for (const combo of combos) {
    process.env["FORGE_WORKTREES"] = "0"; // FG-345: the empty combo means isolation OFF, not "unset"
    delete process.env["FORGE_NO_WORKTREES"];
    Object.assign(process.env, combo);
    stderr = [];
    assertSelfHostDispatchAllowed(otherProject, workflowIsolation(), forgeRoot);
    assert.equal(stderr.join(""), "", `unexpected output for ${JSON.stringify(combo)}`);
    assert.equal(isSelfHostDispatch(otherProject, forgeRoot), false);
  }
});

test("a sibling whose path is a string prefix of the forge root is NOT self-host", () => {
  const sibling = `${forgeRoot}-scratch`;
  mkdirSync(sibling, { recursive: true });
  assert.equal(isSelfHostDispatch(sibling, forgeRoot), false);
  assertSelfHostDispatchAllowed(sibling, workflowIsolation(), forgeRoot);
});

// ── Symlink resolution: the case that would make the guard silently inert ─────

test("detection survives the npm-link style symlink forge is invoked through", () => {
  // ~/.nvm/versions/node/vXX/bin/forge -> <checkout>/bin/forge: the source root
  // derived from the symlink's own path is a DIFFERENT string for the same tree.
  const linkFarm = join(workspace, "nvm-bin");
  mkdirSync(linkFarm, { recursive: true });
  const linked = join(linkFarm, "forge-checkout");
  symlinkSync(forgeRoot, linked);

  assert.equal(isSelfHostDispatch(linked, forgeRoot), true);
  assert.equal(isSelfHostDispatch(forgeRoot, linked), true);
  assert.throws(() => assertSelfHostDispatchAllowed(linked, workflowIsolation(), forgeRoot), /REFUSING/);
});

test("detection survives a /var -> /private/var style symlinked ancestor", () => {
  // macOS: /var is a symlink to /private/var, so an un-canonicalized compare of
  // /var/folders/... against /private/var/folders/... never matches.
  const real = join(workspace, "private", "var", "forge");
  mkdirSync(real, { recursive: true });
  const varLink = join(workspace, "var");
  symlinkSync(join(workspace, "private", "var"), varLink);
  const viaLink = join(varLink, "forge");

  assert.notEqual(viaLink, real);
  assert.equal(isSelfHostDispatch(viaLink, real), true);
  assert.throws(() => assertSelfHostDispatchAllowed(viaLink, workflowIsolation(), real), /REFUSING/);
});

test("a subdir mount of the forge checkout is still self-host — agents write into the live tree either way", () => {
  const sub = join(forgeRoot, "dashboard");
  mkdirSync(sub, { recursive: true });
  assert.equal(isSelfHostDispatch(sub, forgeRoot), true);

  const parent = join(workspace, "code");
  assert.equal(isSelfHostDispatch(parent, forgeRoot), true);
});

// ── The source root the guard actually compares against ───────────────────────

test("forgeSourceRoot() is the canonicalized assetRoot() — one answer, not a second derivation", () => {
  assert.equal(forgeSourceRoot(), realpathSync(assetRoot()));
});

// EXPECTATION CHANGE (FG-693, was: "a non-existent project dir does not throw on
// canonicalization — existence is preflight's job", asserting FALSE). It still
// does not throw. But it no longer answers FALSE: the old canonical() caught
// realpath's failure and returned a LEXICALLY resolved path, so an unresolvable
// project was compared as though it were a proven separate tree — a guard
// deciding "not self-host" from a spelling nobody confirmed. Identity is
// three-valued now and this guard takes the GUARD-class bias: unproven counts as
// self-host, because an unresolved path is not evidence of a separate tree and
// the cost of being wrong the other way is agent writes in the live source tree.
test("a non-existent project dir does not throw — and is UNPROVEN, so the guard fires rather than assuming it is separate", () => {
  const gone = join(workspace, "nope", "gone");
  assert.equal(isSelfHostDispatch(gone, forgeRoot), true);
  assert.equal(classifySelfHostDispatch(gone, forgeRoot).kind, "unproven");
  assert.throws(
    () => assertSelfHostDispatchAllowed(gone, workflowIsolation(), forgeRoot),
    /REFUSING to dispatch/
  );
});
