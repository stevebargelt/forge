// FG-636 AC 4: the gate's EXECUTION CONTEXT must not be able to change a test
// outcome. The environment-shape assertions live in the unit tier
// (fg636-verification-env.test.ts); this is the end-to-end half — it actually
// runs a representative dispatch test as a child process with the poisoned
// switch live in the parent, the same shape the integration gate and the
// review-loop's host verification use.
//
// The subject is deliberate: under the bug, FORGE_WORKTREES=1 reaching this file
// turned worktree mode on (isWorktreeModeEnabled, worktree-lifecycle.ts), the
// mkdtemp project dir has no `.git`, dispatch aborted before writing the task
// manifest, and the test died on an ENOENT for a manifest nothing ever wrote.
// It is the first of the nine false failures the gate reported against a
// candidate containing no code change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedVerificationEnv } from "./host-readiness.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUBJECT = "src/v2/fg366-runtime-name-resolved.test.ts";

/** NODE_TEST_CONTEXT is dropped because THIS file is itself running under the
 *  test runner: inherited, the child recognises a recursive run, skips every
 *  file and exits 0 — a pass that proves nothing. It is never set in the real
 *  gate, which runs from the forge CLI. Both assertions below check the reported
 *  counts as well as the exit code so a skipped child can never read as green. */
function runSubject(env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const childEnv = { ...env };
  delete childEnv["NODE_TEST_CONTEXT"];
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", "./src/test-setup.ts", "--test", SUBJECT],
    { cwd: REPO_ROOT, env: childEnv, encoding: "utf8", timeout: 120_000 },
  );
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function assertGreen(label: string, { status, output }: { status: number | null; output: string }): void {
  assert.equal(status, 0, `${label}:\n${output}`);
  assert.match(output, /^ℹ pass 1$/m, `${label} — the subject must have actually run:\n${output}`);
  assert.match(output, /^ℹ fail 0$/m, `${label}:\n${output}`);
}

test("FG-636 — a dispatch test still passes with FORGE_WORKTREES=1 in the PARENT environment", () => {
  assertGreen(
    `${SUBJECT} must be immune to an ambient control switch`,
    runSubject({ ...process.env, FORGE_WORKTREES: "1" }),
  );
});

test("FG-636 — the same test passes under the env the gate actually builds from a poisoned parent", () => {
  const saved = process.env["FORGE_WORKTREES"];
  process.env["FORGE_WORKTREES"] = "1";
  let env: NodeJS.ProcessEnv;
  try {
    env = pinnedVerificationEnv("fg636-execution");
  } finally {
    if (saved === undefined) delete process.env["FORGE_WORKTREES"];
    else process.env["FORGE_WORKTREES"] = saved;
  }

  assert.equal(env["FORGE_WORKTREES"], undefined, "the gate must not hand its own switches to the candidate");
  assertGreen("the gate's verification child must reproduce CI's answer", runSubject(env));
});
