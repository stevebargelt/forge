// #299 regression guard (runs in `npm test`, unlike the docker smoke at
// scripts/forge-test-smoke.sh): the agent image must ship tsx, and forge-test
// must drive the `tsx` CLI — not `node --import tsx`, which can't resolve a global
// tsx. forge-site #12: agents hit "Cannot find package 'tsx'" and improvised with
// ad hoc globals, reintroducing the native-module mismatch forge-test prevents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(join(root, "docker", "agent-dev-worker.Dockerfile"), "utf8");
const script = join(root, "docker", "forge-test.sh");
const wrapper = readFileSync(script, "utf8");

test("#299: the agent image installs tsx globally with a build-time smoke", () => {
  assert.match(dockerfile, /npm install -g tsx/, "Dockerfile must install tsx globally");
  assert.match(dockerfile, /tsx --version/, "Dockerfile must smoke-check tsx at build time");
});

test("#299: forge-test drives the tsx CLI, not `node --import tsx` (unresolvable for a global tsx)", () => {
  assert.match(wrapper, /exec tsx --test/, "forge-test must exec the tsx CLI");
  assert.doesNotMatch(wrapper, /exec node --import tsx/, "must NOT exec `node --import tsx` — global tsx isn't on node's import path");
});

test("#299: forge-test loads forge's test-setup only in the forge repo, not any project with that file", () => {
  assert.match(wrapper, /-f \.\/src\/test-setup\.ts/, "test-setup.ts load must check the file exists");
  // src/test-setup.ts is a common filename — gate on BEING the forge repo too,
  // not file-existence alone, so a stranger's setup is never preloaded.
  assert.match(wrapper, /"name".*forge/, "test-setup load must be gated on package.json name == forge");
});

test("#299: forge-test fails loud with a useful diagnostic when the runner is absent", () => {
  assert.match(wrapper, /command -v tsx/, "must guard on tsx availability");
  assert.match(wrapper, /Do NOT 'npm i -g tsx' ad hoc/, "diagnostic must steer away from ad hoc globals");
  assert.match(wrapper, /no test runner to invoke/, "must explain a project with no test script");
});

// ── FG-695: a tier flag must never silently discard its path arguments ──────
// `forge-test --integration <one file>` used to exec `npm run test:integration`
// and run the ENTIRE tier without a word, so an agent that asked for a narrow run
// got a broad one — and reported its result as evidence for the narrow run it
// thought it had made. The resolved commands and the refusals are exercised for
// real in src/cli/commands/forge-test-default-tier.integration.test.ts (spawning
// bash is an integration-tier act — src/test-tiers.test.ts); what is guarded here
// is the structure that makes those results mean anything.

test("FG-695: PRINT-CMD mode and the real run share one definition of a tier flag", () => {
  // They used to carry a copy of the tier logic each, so a fix to one graded a code
  // path the other did not take. Both now go through _is_tier_flag/_resolve_tier_cmd.
  assert.equal(
    (wrapper.match(/--unit\|--integration\|--worktree\|--extended\|--all/g) ?? []).length,
    1,
    "the tier-flag list must be spelled exactly once",
  );
  assert.equal(
    (wrapper.match(/^\s*_resolve_tier_cmd "/gm) ?? []).length,
    2,
    "exactly two call sites: PRINT-CMD mode and the real run",
  );
});

test("FG-695: a tier's paths are never handed to `npm run <tier> --`, which would BROADEN the run", () => {
  // Measured: with test:unit ending in `$(find ...)`, `npm run test:unit -- src/a.test.ts`
  // appends the path AFTER the find output — the whole tier plus a duplicate.
  assert.doesNotMatch(wrapper, /npm run \S+ -- /, "a tier script must never be given `-- <paths>`");
  assert.match(wrapper, /_tier_files/, "narrowing must go through the tier's own file set");
});

test("FG-695: the narrowed integration runner still matches run-integration-tests.sh's bulk runner", () => {
  // The wrapper cannot invoke that script for a narrowed run (it selects its own
  // files), so it reproduces its runner — including the test-setup preload that
  // keeps the suite off the real ~/.forge/forge.db (#199). This fails if either moves.
  const bulkLine = readFileSync(join(root, "scripts", "run-integration-tests.sh"), "utf8").match(
    /^\s*(node --import tsx --import \.\/src\/test-setup\.ts --test) "\$\{BULK_FILES\[@\]\}"$/m,
  )?.[1];
  assert.ok(bulkLine, "run-integration-tests.sh must retain its explicit bulk runner");
  const runner = bulkLine;
  assert.match(runner, /--import \.\/src\/test-setup\.ts/);
  assert.ok(
    wrapper.includes(`_TIER_CMD=(${runner})`),
    `forge-test.sh must narrow --integration with \`${runner}\``,
  );
});

test("FG-695: the usage block documents what a tier flag plus a path actually does", () => {
  // The old header said file paths "are passthroughs ... and are unaffected", which
  // read as "tier flag plus path narrows the run". It did not — it ran the whole tier.
  assert.match(wrapper, /forge-test --unit src\/a\.test\.ts/, "usage must show the tier+path form");
  assert.match(wrapper, /Paths AFTER one narrow that tier's run/, "usage must state the narrowing");
  assert.match(wrapper, /`--extended` and `--all`[\s\S]{0,220}refused/, "usage must state the refusal");
});
