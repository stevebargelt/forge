// FG-636 — the two REAL callers of `pinnedVerificationEnv`, driven end to end.
//
// The existing regressions cover the env CONSTRUCTOR
// (fg636-verification-env.test.ts) and one hand-spawned node child
// (fg636-gate-execution-context.integration.test.ts). Neither drives a caller:
// both build or receive the env themselves, so a future change that keeps
// `pinnedVerificationEnv` clean but stops using it — or spreads `process.env`
// over it at the callsite — passes them both while the leak returns.
//
// So this file starts from the orchestrator's own poisoned process environment,
// calls the shipped entrypoints, and asks the CHILD what it saw:
//
//   1. `runIntegrationGate()` (integration-gate.ts:63) — the post-merge gate.
//      This is the observed failure: a wave launched as
//      `env FORGE_WORKTREES=1 forge next …` spread the switch into every
//      unit-test child, worktree mode came on inside code that dispatches
//      against `.git`-less mkdtemp dirs, and nine tests "failed" on a candidate
//      that contained no code change.
//   2. `runVerification()` (review-loop.ts:366) via its DEFAULT runner — the
//      second and higher-stakes caller. Since FG-474 its result is persisted as
//      a `host_verifications` row and reused as covering evidence, so a false
//      verdict here is not just a blocked publication, it is audit evidence. The
//      default runner is the only honest seam: an injected `run` would test the
//      test's own runner and never reach `pinnedVerificationEnv` at all.
//
// The fixture project is what makes this a proof rather than a restatement of
// the constructor test. Its scripts are a real candidate suite in miniature:
// they record their own `FORGE_*` environment to disk, and they FAIL (exit 1)
// when `FORGE_WORKTREES=1` reaches them — the same shape as the nine, so a
// regression reddens on the caller's own `ok` field and not only on an env
// assertion. Reverting `pinnedVerificationEnv` to `{ ...process.env, PATH }`
// fails every test below.
//
// Tier: integration — real npm subprocesses and a real temp filesystem, which
// src/test-tiers.test.ts bans from the unit tier.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrationGate } from "./integration-gate.js";
import { runVerification } from "./review-loop.js";

/** The orchestrator environment a candidate must be insensitive to. Three
 *  production switches (the first is the one that actually bit) plus a harness
 *  input, because the gate-side strip is the whole namespace — the candidate's
 *  suite is not forge's suite, and none of these are its business. */
const POISON: Record<string, string> = {
  FORGE_WORKTREES: "1",
  FORGE_NO_WORKTREES: "1",
  FORGE_WORKTREE_IGNORE_DIRTY: "1",
  FORGE_TEST_PRINT_CMD: "1",
};

/** A non-reserved operator variable. The fix is a DENYLIST on forge's namespace,
 *  not a conversion to setupEnv's allowlist: an arbitrary project's suite may
 *  legitimately need the operator's environment, so proving what still gets
 *  through matters as much as proving what does not. */
const OPERATOR_VAR = "FG636_OPERATOR_VAR";

function withPoisonedEnv<T>(fn: () => T): T {
  const vars = { ...POISON, [OPERATOR_VAR]: "keep-me" };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A candidate suite in miniature: it reports what it saw, and it dies on the
// leak the way the real nine did. `console.log` of a count, not a bare exit 0,
// so a script that never ran cannot read as a pass.
const OBSERVER = `import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
const forgeVars = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FORGE_")));
writeFileSync(
  join(here, \`observed-\${label}.json\`),
  JSON.stringify({ forgeVars, operatorVar: process.env["${OPERATOR_VAR}"] ?? null }),
);

if (process.env.FORGE_WORKTREES === "1") {
  console.error(\`fg636-fixture \${label}: worktree mode was forced on from outside — 1 failure\`);
  process.exit(1);
}
console.log(\`fg636-fixture \${label}: pass 1 fail 0\`);
`;

const SCRIPTS: Record<string, string> = {
  // The gate's entrypoint.
  "test:unit": "node observe.mjs unit",
  // The review-loop's entrypoints, in the order runVerification runs them.
  typecheck: "node observe.mjs typecheck",
  test: "node observe.mjs test",
};

function makeFixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "fg636-candidate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg636-candidate", private: true, type: "module", scripts: SCRIPTS }, null, 2),
  );
  writeFileSync(join(dir, "observe.mjs"), OBSERVER);
  return dir;
}

/** What the child process actually saw. Reading it back from disk is the point:
 *  it is the candidate's own environment, not a re-assertion of the env object
 *  the test just built. */
function observed(dir: string, label: string): { forgeVars: Record<string, string>; operatorVar: string | null } {
  return JSON.parse(readFileSync(join(dir, `observed-${label}.json`), "utf8")) as {
    forgeVars: Record<string, string>;
    operatorVar: string | null;
  };
}

function assertNoLeak(dir: string, label: string): void {
  const seen = observed(dir, label);
  const leaked = Object.keys(seen.forgeVars);
  assert.deepEqual(
    leaked,
    [],
    `the candidate's \`${label}\` child saw forge's control switches: ${JSON.stringify(seen.forgeVars)}`,
  );
  assert.equal(seen.operatorVar, "keep-me", `the operator's general environment must still reach \`${label}\``);
}

test("FG-636 — runIntegrationGate passes a candidate whose suite the orchestrator's FORGE_* would have failed", (t) => {
  const dir = makeFixture(t);

  const gate = withPoisonedEnv(() => runIntegrationGate(dir));

  // ok:true first: under the bug this is `false`, with the fixture's failure on
  // stderr — a code verdict on a candidate containing no code change, which is
  // the harm the ticket exists to stop.
  assert.equal(gate.ok, true, `the gate must not fail a candidate over its own environment:\n${gate.output}`);
  assert.match(
    gate.output,
    /fg636-fixture unit: pass 1 fail 0/,
    `the candidate's test:unit script must have actually run:\n${gate.output}`,
  );
  assertNoLeak(dir, "unit");
});

test("FG-636 — review-loop verification (default runner) reaches the candidate with no FORGE_* set", (t) => {
  const dir = makeFixture(t);

  // No `run` injected: this must go through makeDefaultRunner, which is the only
  // place review-loop.ts calls pinnedVerificationEnv. Passing a stub runner here
  // would exercise the stub and prove nothing about the shipped path.
  const result = withPoisonedEnv(() => runVerification(SCRIPTS, { cwd: dir }));

  assert.equal(
    result.ok,
    true,
    `a false verdict here is persisted as a host_verifications row and reused as covering evidence:\n${result.steps
      .map((s) => `${s.name}: ok=${s.ok}\n${s.output}`)
      .join("\n")}`,
  );
  assert.deepEqual(
    result.steps.map((s) => s.name),
    ["typecheck", "test"],
    "both discoverable steps must have run — a step that never ran cannot show a leak",
  );
  for (const step of result.steps) {
    assert.match(step.output, /fg636-fixture \w+: pass 1 fail 0/, `${step.name} did not actually run:\n${step.output}`);
  }
  assertNoLeak(dir, "typecheck");
  assertNoLeak(dir, "test");
});
