// FG-612: the forge-on-forge dispatch guard. The negative path IS the point of
// the ticket, so the refusal cases are asserted first and hardest.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSelfHostDispatchAllowed,
  isSelfHostDispatch,
  forgeSourceRoot,
  _resetSelfHostWarnings,
} from "./self-host-guard.js";
import { assetRoot } from "./asset-root.js";

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
    assertSelfHostDispatchAllowed(forgeRoot, forgeRoot);
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
    () => assertSelfHostDispatchAllowed(forgeRoot, forgeRoot),
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
  assertSelfHostDispatchAllowed(forgeRoot, forgeRoot);
  assert.equal(stderr.join(""), "");
});

test("FORGE_NO_WORKTREES=1 proceeds, loudly", () => {
  process.env["FORGE_NO_WORKTREES"] = "1";
  assertSelfHostDispatchAllowed(forgeRoot, forgeRoot);
  const out = stderr.join("");
  assert.match(out, /WARNING/);
  assert.match(out, /live forge source/);
  assert.match(out, /FORGE_NO_WORKTREES=1/);
});

test("the kill switch beats FORGE_WORKTREES=1 — worktree mode is off, so the override path is what proceeds", () => {
  process.env["FORGE_WORKTREES"] = "1";
  process.env["FORGE_NO_WORKTREES"] = "1";
  assertSelfHostDispatchAllowed(forgeRoot, forgeRoot);
  assert.match(stderr.join(""), /WARNING/);
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
    assertSelfHostDispatchAllowed(otherProject, forgeRoot);
    assert.equal(stderr.join(""), "", `unexpected output for ${JSON.stringify(combo)}`);
    assert.equal(isSelfHostDispatch(otherProject, forgeRoot), false);
  }
});

test("a sibling whose path is a string prefix of the forge root is NOT self-host", () => {
  const sibling = `${forgeRoot}-scratch`;
  mkdirSync(sibling, { recursive: true });
  assert.equal(isSelfHostDispatch(sibling, forgeRoot), false);
  assertSelfHostDispatchAllowed(sibling, forgeRoot);
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
  assert.throws(() => assertSelfHostDispatchAllowed(linked, forgeRoot), /REFUSING/);
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
  assert.throws(() => assertSelfHostDispatchAllowed(viaLink, real), /REFUSING/);
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

test("a non-existent project dir does not throw on canonicalization — existence is preflight's job", () => {
  assert.equal(isSelfHostDispatch(join(workspace, "nope", "gone"), forgeRoot), false);
});
