// FG-792: exercise the integration runner's checkout-purity guard in a disposable
// git repository. The fixture deliberately runs the real script source, while its
// fake node binary keeps the test tier tiny and controls whether a test dirties the
// fixture checkout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = readFileSync(join(REPO_ROOT, "scripts", "run-integration-tests.sh"), "utf8");

function makeFixture(): { root: string; mutation: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "fg792-tree-purity-"));
  const bin = join(root, "bin");
  const mutation = join(root, "transient-from-test");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src", "orchestrator"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(root, "scripts", "run-integration-tests.sh"), RUNNER);
  writeFileSync(join(root, "scripts", "integration-timings.json"), '{"files":{}}\n');
  writeFileSync(join(root, "src", "orchestrator", "fg576-codex-adapter.integration.test.ts"), "// fixture\n");
  writeFileSync(
    join(bin, "node"),
    `#!/usr/bin/env bash
if [[ " $* " == *" --test "* ]]; then
  if [ -n "\${FG792_MUTATION:-}" ]; then touch "$FG792_MUTATION"; fi
  exit 0
fi
if [[ " $* " == *" -e "* ]]; then echo "1 0 400 0.0"; exit 0; fi
if [[ " $* " == *" src/test-shards.ts "* ]]; then cat; exit 0; fi
exit 97
`,
  );
  chmodSync(join(root, "scripts", "run-integration-tests.sh"), 0o755);
  chmodSync(join(bin, "node"), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, mutation, bin };
}

function runFixture(fixture: ReturnType<typeof makeFixture>, extraEnv: NodeJS.ProcessEnv = {}) {
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.FORGE_INTEGRATION_TREE_GUARD_ACTIVE;
  delete fixtureEnv.FORGE_SKIP_TREE_PURITY_GUARD;
  delete fixtureEnv.FORGE_INTEGRATION_LIST_ONLY;

  return spawnSync("bash", ["scripts/run-integration-tests.sh", "serial"], {
    cwd: fixture.root,
    encoding: "utf8",
    env: { ...fixtureEnv, ...extraEnv, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
}

test("FG-792: the outer runner rejects a test that dirties its real checkout, while a clean run passes", () => {
  const fixture = makeFixture();
  try {
    const dirty = runFixture(fixture, { FG792_MUTATION: fixture.mutation });
    assert.equal(dirty.status, 1, `dirty runner stderr:\n${dirty.stderr}`);
    assert.match(dirty.stderr, /integration tier dirtied the real checkout/);
    assert.match(dirty.stderr, /\?\? transient-from-test/, "the failure must print the porcelain delta");

    rmSync(fixture.mutation, { force: true });
    const clean = runFixture(fixture);
    assert.equal(clean.status, 0, `clean runner stderr:\n${clean.stderr}`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("FG-792: the explicit debug bypass permits the mutation and announces that protection is disabled", () => {
  const fixture = makeFixture();
  try {
    const bypassed = runFixture(fixture, {
      FG792_MUTATION: fixture.mutation,
      FORGE_SKIP_TREE_PURITY_GUARD: "1",
    });
    assert.equal(bypassed.status, 0, `bypassed runner stderr:\n${bypassed.stderr}`);
    assert.match(
      `${bypassed.stdout}\n${bypassed.stderr}`,
      /tree-purity guard.*(?:bypass|disabled)|(?:bypass|disabled).*tree-purity guard/i,
      "a debugging bypass must be visible in the runner output",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("FG-792: a nested runner does not install another guard across a sibling transient", () => {
  const fixture = makeFixture();
  try {
    const nested = runFixture(fixture, {
      FG792_MUTATION: fixture.mutation,
      FORGE_INTEGRATION_TREE_GUARD_ACTIVE: "1",
    });
    assert.equal(nested.status, 0, `nested runner stderr:\n${nested.stderr}`);
    assert.match(readFileSync(fixture.mutation, "utf8"), /^$/, "the sibling transient was created during the nested run");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("FG-792: an active guard in the test process does not leak into an outer fixture runner", () => {
  const fixture = makeFixture();
  const previousGuardActive = process.env.FORGE_INTEGRATION_TREE_GUARD_ACTIVE;
  process.env.FORGE_INTEGRATION_TREE_GUARD_ACTIVE = "1";
  try {
    const dirty = runFixture(fixture, { FG792_MUTATION: fixture.mutation });
    assert.equal(dirty.status, 1, `dirty runner stderr:\n${dirty.stderr}`);
    assert.match(dirty.stderr, /integration tier dirtied the real checkout/);
  } finally {
    if (previousGuardActive === undefined) {
      delete process.env.FORGE_INTEGRATION_TREE_GUARD_ACTIVE;
    } else {
      process.env.FORGE_INTEGRATION_TREE_GUARD_ACTIVE = previousGuardActive;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
