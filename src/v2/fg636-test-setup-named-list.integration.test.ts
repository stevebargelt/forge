// FG-636 defense in depth (AC 5) — `src/test-setup.ts`'s named list is a
// CONTRACT with two sides, and both of them can be broken by a tidy-up.
//
// The list neutralizes exactly three ambient PRODUCTION switches so no launcher's
// environment can decide a test outcome:
//     FORGE_WORKTREES, FORGE_NO_WORKTREES, FORGE_WORKTREE_IGNORE_DIRTY
//
// FG-345 split how: two are CLEARED, but FORGE_WORKTREES is PINNED to "0", because
// isolation is now default-ON with a platform-dependent default. Clearing it would
// hand the suite's outcome to process.platform — green on CI's Linux, red on the
// macOS host — which is the failure mode this file exists to prevent, arriving by a
// different door. Both spellings are equally load-bearing here: an ambient "1" must
// not survive either way.
//
// It is deliberately NOT `for (const k of Object.keys(process.env)) if
// (k.startsWith("FORGE_")) delete …`, which is the obvious "simplification" and
// is wrong: harness INPUTS live in the same namespace and are legitimate.
// `FORGE_TEST_PRINT_CMD` is one — a blanket sweep would erase it inside the very
// children that are supposed to read it. (FG-647 retired the other,
// `FORGE_TEST_MISMATCHED_NODE`, along with the environment-dependent preflight arm
// and the CI provisioning that fed it; the named list is still named because the
// distinction between a production switch and a harness input outlives any one
// input.)
//
// Nothing in the suite observes this today (the clears happen before any test
// body runs, so a test cannot see the difference from the inside), which is
// exactly why it needs a test from the OUTSIDE: a child process is booted with
// all four variables set and asked what survived preload.
//
// Tier: integration — spawns a real node child. NODE_TEST_CONTEXT is deleted
// from that child's env because this file is itself running under the test
// runner; inherited, a node child recognises a recursive run and can exit 0
// having done nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Production switches that reconfigure the code under test. Each maps to what
 *  must survive preload: `undefined` for cleared, a string for pinned (FG-345). */
const PRODUCTION_SWITCHES: Record<string, string | undefined> = {
  FORGE_WORKTREES: "0",
  FORGE_NO_WORKTREES: undefined,
  FORGE_WORKTREE_IGNORE_DIRTY: undefined,
};

/** Preserved: harness inputs the suite is *supposed* to read. */
const HARNESS_INPUTS: Record<string, string> = {
  FORGE_TEST_PRINT_CMD: "1",
};

const PROBE = `console.log("FG636_PROBE " + JSON.stringify(
  Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FORGE_"))),
));
`;

test("FG-636 — test-setup neutralizes the production switches and PRESERVES the harness inputs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fg636-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, PROBE);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(PRODUCTION_SWITCHES)) childEnv[key] = "1";
  Object.assign(childEnv, HARNESS_INPUTS);
  delete childEnv["NODE_TEST_CONTEXT"];

  // The suite's own preload chain, minus the runner: whatever test-setup.ts does
  // to process.env, it does here too.
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", "./src/test-setup.ts", probe], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `the probe child failed:\n${output}`);

  const line = output.split("\n").find((l) => l.startsWith("FG636_PROBE "));
  assert.ok(line, `the probe never reported — a child that did not run proves nothing:\n${output}`);
  const seen = JSON.parse(line.slice("FG636_PROBE ".length)) as Record<string, string>;

  for (const [key, expected] of Object.entries(PRODUCTION_SWITCHES)) {
    assert.equal(
      seen[key],
      expected,
      `${key} was set to "1" in the child's environment and test-setup left it at ${JSON.stringify(seen[key])} ` +
        `instead of ${JSON.stringify(expected)}: an ambient production switch can still decide a test outcome ` +
        `(${JSON.stringify(seen)})`,
    );
  }

  for (const [key, value] of Object.entries(HARNESS_INPUTS)) {
    assert.equal(
      seen[key],
      value,
      `${key} was cleared by test-setup. It is a harness INPUT, not a production switch — clearing it is how a blanket ` +
        `FORGE_* sweep silently changes what a test child observes while staying green. ` +
        `Keep the named list named (${JSON.stringify(seen)})`,
    );
  }
});
