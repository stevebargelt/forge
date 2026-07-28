// FG-345 — the SUITE PIN is itself a contract.
//
// `src/test-setup.ts` pins FORGE_WORKTREES="0" for every test process. That pin is
// load-bearing in a way a tidy-up will not see: after FG-345 the production default
// is PLATFORM-dependent (darwin on, else off), so a cleared FORGE_WORKTREES does
// not mean "off" — it means "ask the host". Leave it ambient and the suite's
// outcome is decided by process.platform: green on CI's Linux, red on the operator's
// macOS host, where ~39 unit-tier files would take the isolated path against a
// `.git`-less mkdtemp fixture. That asymmetry is the main risk this whole change
// carried, so it gets a test that fails if it ever returns.
//
// This file is deliberately the ONE place that reads the AMBIENT env rather than
// clearing it. Every other FG-345 test sets or deletes the switches to exercise a
// specific arm; this one asserts what the preload leaves behind, and what that
// implies:
//
//   (pin-1) under the preload, isWorktreeModeEnabled() is false REGARDLESS of
//       process.platform — spoofed both ways, so neither host can pass by accident;
//   (pin-2) the falseness comes from the PIN, not from the kill switch — pinning
//       FORGE_NO_WORKTREES instead would also disable the ~42 worktree-tier files
//       that legitimately opt in, so which variable carries the pin is the contract;
//   (pin-3) a test's own FORGE_WORKTREES="1" still WINS over the pin, on every
//       platform. That is what keeps those opt-in files working, and it must not
//       rest on assignment-order luck.
//
// Unit tier: pure env + predicate, no subprocess, no filesystem, no git.
//
// process.platform is restored from REAL_PLATFORM captured at module load — never
// re-read inside afterEach, which by then reads the spoof.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { isWorktreeModeEnabled } from "./worktree-lifecycle.js";

const PLATFORMS = ["darwin", "linux", "win32"] as const;

/** Captured before any test can spoof it. */
const REAL_PLATFORM = process.platform;

/** The ambient values as the preload left them, captured before any test edits. */
const PRELOAD_WORKTREES = process.env.FORGE_WORKTREES;
const PRELOAD_NO_WORKTREES = process.env.FORGE_NO_WORKTREES;

const ENV_VARS = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES"] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  // Save, do NOT clear: the ambient state is the subject.
  for (const k of ENV_VARS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  setPlatform(REAL_PLATFORM);
});

// ─── (pin-1) The suite's outcome does not depend on the host ──────────────────

test("fg345 (pin-1): under the test preload, worktree mode is OFF on every platform", () => {
  for (const platform of PLATFORMS) {
    setPlatform(platform);
    assert.equal(
      isWorktreeModeEnabled(),
      false,
      `the preload must resolve worktree mode OFF on ${platform} — a suite whose answer follows process.platform is green on CI and red on the macOS host`
    );
  }
});

// ─── (pin-2) …and it is the PIN that makes it so, not the kill switch ─────────

test("fg345 (pin-2): the pin is an explicit FORGE_WORKTREES=0, and the kill switch is left clear", () => {
  assert.equal(
    PRELOAD_WORKTREES,
    "0",
    "src/test-setup.ts must PIN FORGE_WORKTREES to an explicit off — clearing it hands the suite to process.platform (FG-345 rule 3)"
  );
  assert.equal(
    PRELOAD_NO_WORKTREES,
    undefined,
    "FORGE_NO_WORKTREES must stay CLEARED — pinning the kill switch instead would outrank every worktree-tier test's own opt-in"
  );
});

// ─── (pin-3) An explicit opt-in still beats the pin ───────────────────────────

test("fg345 (pin-3): a test's own FORGE_WORKTREES=1 still wins over the pin, on every platform", () => {
  process.env.FORGE_WORKTREES = "1";
  for (const platform of PLATFORMS) {
    setPlatform(platform);
    assert.equal(
      isWorktreeModeEnabled(),
      true,
      `an opt-in assigned inside a test must beat the preload pin on ${platform} — this is what the ~42 worktree-tier files rely on`
    );
  }
});

test("fg345 (pin-3): deleting the pin inside a test restores the PLATFORM default, not a fixed off", () => {
  // The reason the pin cannot simply be dropped: with the variable gone, the
  // answer follows the host. A test that deletes it owns that consequence.
  delete process.env.FORGE_WORKTREES;

  setPlatform("darwin");
  assert.equal(isWorktreeModeEnabled(), true, "with the pin removed, darwin resolves ON — the pin is what holds the suite still");

  setPlatform("linux");
  assert.equal(isWorktreeModeEnabled(), false, "with the pin removed, a non-darwin host resolves OFF — the two hosts disagree");
});
