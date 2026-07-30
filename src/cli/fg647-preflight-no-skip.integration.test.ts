// FG-647 acceptance guard: the ABI preflight coverage must never skip again.
//
// FG-647's whole point was that node-preflight.integration.test.ts stopped depending on
// the host's interpreter inventory: the arm that searched ~/.nvm and /usr/local/n for an
// ABI-incompatible Node and skipped when it found none is deleted, and the ticket says in
// so many words not to replace it with "a skip, optional probe, or another
// environment-dependent test". Nothing enforced that. `src/v2/ci-workflow.test.ts` guards
// the CI half (no job provisions a second interpreter), but the test file itself could
// grow a `t.skip(...)` or a `{ skip: hasSomething }` arm and the suite would stay green —
// which is exactly the failure mode the ticket exists to end, since a skipped arm and a
// passing arm are indistinguishable in a green summary.
//
// So this is EXECUTED, not a grep for the word "skip": run the real preflight suite as a
// child and read its own reported counts. Any skip introduced by ANY mechanism —
// `t.skip()`, the `{ skip }` option, `test.skip`, `todo` — shows up in that summary, and
// so does a suite that silently stopped running arms at all.
//
// Tier: integration — spawns a real node child running the real suite. NODE_TEST_CONTEXT
// is deleted from that child's env because this file is itself running under the test
// runner, and an inherited context makes the child emit into the parent's TAP stream
// instead of its own summary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PREFLIGHT_SUITE = join("src", "cli", "node-preflight.integration.test.ts");

/** The arms that existed when FG-647 landed. A floor, not an equality: adding deterministic
 *  coverage is welcome, quietly losing it is the regression. */
const ARMS_AT_FG647 = 12;

function summaryOf(tap: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const m = tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    if (m) counts[key] = Number(m[1]);
  }
  return counts;
}

test("FG-647: the ABI preflight suite runs every arm with ZERO skips — no environment-dependent arm came back", () => {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];

  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", "./src/test-setup.ts", "--test", "--test-reporter=tap", PREFLIGHT_SUITE],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 300_000 },
  );
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const counts = summaryOf(output);

  assert.ok(
    counts["tests"] !== undefined,
    `the child never reported a summary — a suite that did not run proves nothing:\n${output}`,
  );
  assert.equal(
    counts["skipped"],
    0,
    `${PREFLIGHT_SUITE} skipped ${counts["skipped"]} arm(s). FG-647 deleted the host-inventory arm precisely so this ` +
      `tier has no skip: a skipped arm reads as green while proving nothing. Do not reintroduce a skip, an optional ` +
      `probe, or any other environment-conditional arm here — manufacture the mismatch in the MANIFEST instead.\n${output}`,
  );
  assert.equal(counts["todo"], 0, `${PREFLIGHT_SUITE} has ${counts["todo"]} todo arm(s) — a todo is a skip with better PR optics\n${output}`);
  assert.equal(counts["fail"], 0, `${PREFLIGHT_SUITE} is red:\n${output}`);
  assert.ok(
    (counts["pass"] ?? 0) >= ARMS_AT_FG647,
    `${PREFLIGHT_SUITE} passed ${counts["pass"]} arms, fewer than the ${ARMS_AT_FG647} that existed when FG-647 landed — ` +
      `deterministic ABI coverage was removed, not just rescheduled\n${output}`,
  );
  assert.equal(r.status, 0, `the child exited ${r.status}\n${output}`);
});

test("FG-647: the preflight suite carries no interpreter-discovery machinery — the mismatch is manufactured in the manifest", () => {
  // The executed check above catches a skip. This catches the deleted arm coming back BY
  // NAME as a MANDATORY test, which reddens rather than skips and so slips past the count
  // check while putting the tier's outcome back on the host's inventory. It is a denylist,
  // not a general proof: an arm that probes some other root and early-returns green passes
  // both arms of this guard. That shape is prohibited at review — see docs/how-to-testing.md.
  const src = readFileSync(join(REPO_ROOT, PREFLIGHT_SUITE), "utf8");

  for (const [needle, why] of [
    ["FORGE_TEST_MISMATCHED_NODE", "the env var CI used to provision a second Node into — FG-647 removed both sides"],
    [".nvm/versions/node", "an interpreter-discovery root — the suite must not search the host for a second Node"],
    ["/usr/local/n/versions/node", "an interpreter-discovery root — the suite must not search the host for a second Node"],
  ] as const) {
    assert.ok(!src.includes(needle), `${PREFLIGHT_SUITE} references ${needle}: ${why}`);
  }

  // Non-vacuous: the file really is the executed suite this guard thinks it is.
  assert.match(src, /src", "cli", "index\.ts"/, `${PREFLIGHT_SUITE} no longer runs the real CLI entry — this guard would be checking a file that stopped proving anything`);
});
