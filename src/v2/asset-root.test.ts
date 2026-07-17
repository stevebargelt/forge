// FG-577: the asset-root authority. Every case here runs against a DISPOSABLE
// fixture tree — release mode is decided by walking up from the executing
// module, so a temp dir carrying a manifest IS a release for every purpose this
// ticket touches. Nothing here promotes this host, touches ~/.forge, or reads
// ~/code/forge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetRoot, assetRootFrom, devCheckoutDir, executionMode, executionModeFrom } from "./asset-root.js";

/** A disposable tree shaped like a release: <base>/forge-release.json plus the
 *  module location asset-root.ts occupies inside a real package. */
function releaseFixture(manifestBody: string): { base: string; moduleDir: string } {
  const base = mkdtempSync(join(tmpdir(), "fg577-release-"));
  const moduleDir = join(base, "src", "v2");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(base, "forge-release.json"), manifestBody);
  return { base, moduleDir };
}

test("FG-577 assetRootFrom: <pkg>/src/v2 resolves to <pkg> — the tree the module executes from", () => {
  const base = mkdtempSync(join(tmpdir(), "fg577-root-"));
  try {
    assert.equal(assetRootFrom(join(base, "src", "v2")), base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("FG-577 (criterion 3): a hostile FORGE_REPO_DIR cannot redirect the asset root", () => {
  const hostile = mkdtempSync(join(tmpdir(), "fg577-hostile-"));
  const before = process.env.FORGE_REPO_DIR;
  try {
    const clean = assetRoot();
    process.env.FORGE_REPO_DIR = hostile;
    assert.equal(assetRoot(), clean, "assetRoot() must be a pure function of where this module lives");
    assert.notEqual(assetRoot(), hostile);
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(hostile, { recursive: true, force: true });
  }
});

test("FG-577 executionModeFrom: a tree with a valid manifest is release", () => {
  const { base, moduleDir } = releaseFixture(JSON.stringify({ schema: 1, abi: "137", id: "r1" }));
  try {
    assert.equal(executionModeFrom(moduleDir), "release");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("FG-577 (criterion 6): a MALFORMED manifest is release, never dev", () => {
  // The whole point: a release whose manifest cannot be parsed must not become a
  // dev-mode install of dev bytes. Truncated fixture in release.test.ts's style.
  const { base, moduleDir } = releaseFixture('{ "schema": 1, "abi": "137"');
  try {
    assert.equal(
      executionModeFrom(moduleDir),
      "release",
      "malformed means the caller is demonstrably inside a release it could not verify — refusing dev-advancement is the safe answer, installing dev bytes is not",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("FG-577 executionModeFrom: no manifest anywhere above → dev", () => {
  const base = mkdtempSync(join(tmpdir(), "fg577-dev-"));
  const moduleDir = join(base, "src", "v2");
  mkdirSync(moduleDir, { recursive: true });
  try {
    assert.equal(executionModeFrom(moduleDir), "dev");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("FG-577 (criterion 8): this live dev checkout reports dev mode and resolves its own bytes", () => {
  assert.equal(executionMode(), "dev", "the test suite runs from the npm-linked checkout, not a release");
  assert.equal(assetRoot(), assetRootFrom(join(assetRoot(), "src", "v2")), "dev behaviour falls out of the same unconditional module-relative rule");
});

test("FG-577 devCheckoutDir: keeps FORGE_REPO_DIR / --forge-repo, scoped to advancement only", () => {
  const before = process.env.FORGE_REPO_DIR;
  const dir = mkdtempSync(join(tmpdir(), "fg577-checkout-"));
  try {
    assert.equal(devCheckoutDir(dir), dir, "--forge-repo still names the tree to advance");
    process.env.FORGE_REPO_DIR = dir;
    assert.equal(devCheckoutDir(), dir, "the env override still names the tree to advance");
    assert.equal(devCheckoutDir("/explicit/tree"), "/explicit/tree", "an explicit flag outranks the env");
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
