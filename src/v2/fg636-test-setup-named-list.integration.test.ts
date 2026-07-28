// FG-636 defense in depth (AC 5) — `src/test-setup.ts`'s named list is a
// CONTRACT with two sides, and both of them can be broken by a tidy-up.
//
// The list clears exactly three ambient PRODUCTION switches so no launcher's
// environment can decide a test outcome:
//     FORGE_WORKTREES, FORGE_NO_WORKTREES, FORGE_WORKTREE_IGNORE_DIRTY
// It is deliberately NOT `for (const k of Object.keys(process.env)) if
// (k.startsWith("FORGE_")) delete …`, which is the obvious "simplification" and
// is wrong: harness INPUTS live in the same namespace and are legitimate.
// `FORGE_TEST_MISMATCHED_NODE` is provisioned by CI into all five test-extended
// integration shards (.github/workflows/ci.yml), and
// src/cli/node-preflight.integration.test.ts:287 treats it as a HARD
// requirement — with it set, every failure mode there reddens instead of
// skipping. A blanket sweep would erase it inside the child that runs that test
// and silently demote CI's required extended gate to the local skip path: still
// green, no longer proving anything. `FORGE_TEST_PRINT_CMD` is the other one.
//
// Nothing in the suite observes this today (the clears happen before any test
// body runs, so a test cannot see the difference from the inside), which is
// exactly why it needs a test from the OUTSIDE: a child process is booted with
// all five variables set and asked what survived preload.
//
// Tier: integration — spawns a real node child. NODE_TEST_CONTEXT is deleted
// from that child's env because this file is itself running under the test
// runner; inherited, a node child recognises a recursive run and can exit 0
// having done nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Cleared: production switches that reconfigure the code under test. */
const PRODUCTION_SWITCHES = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES", "FORGE_WORKTREE_IGNORE_DIRTY"] as const;

/** Preserved: harness inputs the suite is *supposed* to read. */
const HARNESS_INPUTS: Record<string, string> = {
  FORGE_TEST_MISMATCHED_NODE: "/fg636/not/a/real/interpreter",
  FORGE_TEST_PRINT_CMD: "1",
};

const PROBE = `console.log("FG636_PROBE " + JSON.stringify(
  Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FORGE_"))),
));
`;

test("FG-636 — test-setup clears the production switches and PRESERVES the harness inputs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fg636-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, PROBE);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PRODUCTION_SWITCHES) childEnv[key] = "1";
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

  for (const key of PRODUCTION_SWITCHES) {
    assert.equal(
      seen[key],
      undefined,
      `${key} survived test-setup: an ambient production switch can still decide a test outcome (${JSON.stringify(seen)})`,
    );
  }

  for (const [key, value] of Object.entries(HARNESS_INPUTS)) {
    assert.equal(
      seen[key],
      value,
      `${key} was cleared by test-setup. It is a harness INPUT, not a production switch — clearing it is how a blanket ` +
        `FORGE_* sweep silently demotes CI's test-extended shards to the local skip path while staying green. ` +
        `Keep the named list named (${JSON.stringify(seen)})`,
    );
  }
});

test("FG-636 — the CI side of that contract: every integration shard still provisions the mismatched Node", () => {
  // The other half of why the list must stay named. If this ever drops to zero,
  // preserving FORGE_TEST_MISMATCHED_NODE above stops being load-bearing — and
  // whoever removes it should have to say so here rather than discover it as a
  // permanently-skipping F31 arm.
  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const provisioned = ci.match(/FORGE_TEST_MISMATCHED_NODE=.*>> "\$GITHUB_ENV"/g) ?? [];
  assert.equal(
    provisioned.length,
    5,
    "all five test-extended integration shards must export FORGE_TEST_MISMATCHED_NODE — the shard planner can route " +
      `node-preflight.integration.test.ts to any of them (found ${provisioned.length})`,
  );

  const preflight = readFileSync(join(REPO_ROOT, "src", "cli", "node-preflight.integration.test.ts"), "utf8");
  assert.match(
    preflight,
    /process\.env\.FORGE_TEST_MISMATCHED_NODE/,
    "node-preflight.integration.test.ts is the consumer that makes the preserved variable matter",
  );
});
