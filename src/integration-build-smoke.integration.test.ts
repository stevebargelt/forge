// FG-728 depth smoke test. Proves the BUILT integration tree (a per-file mirror
// of src/ sitting one level under the repo root) resolves release-owned assets
// BYTE-IDENTICALLY to the tsx src/ tree — the single non-negotiable invariant of
// the build-once mechanism. A single-file bundle would collapse every module onto
// one import.meta.url and silently mis-resolve seeds/templates/docker/git-root;
// this test is the tripwire for that class of error.
//
// It runs under the integration build preload (wired via --import in
// scripts/run-integration-tests.sh), so INTEGRATION_BUILD_DIR is already populated
// by the time this file loads.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  BUILT_AUTHORITY_TESTKIT_URL,
  BUILT_CLI_ENTRY,
  INTEGRATION_BUILD_DIR,
  NODE_EXEC,
  REPO_ROOT,
  SRC_DIR,
} from "./integration-cli-spawn.js";

// Resolve a fixed-depth asset walk from a given tree base, mirroring how a module
// at `<base>/<relDir>/x` computes it from its own import.meta.url. `offset` is
// applied from the module's DIRECTORY, exactly as join(dirname(url), ...) does.
function walkFromDir(base: string, relDir: string, offset: string[]): string {
  return resolve(base, relDir, ...offset);
}

test("built CLI entry and built authority testkit exist", () => {
  assert.ok(existsSync(BUILT_CLI_ENTRY), `missing built entry: ${BUILT_CLI_ENTRY}`);
  assert.ok(BUILT_AUTHORITY_TESTKIT_URL.endsWith(".js"), "testkit URL must be the built .js");
  const testkitPath = fileURLToPath(BUILT_AUTHORITY_TESTKIT_URL);
  assert.ok(existsSync(testkitPath), `missing built testkit: ${testkitPath}`);
});

test("build tree is EXACTLY one level under the repo root, a sibling of src/", () => {
  assert.equal(dirname(INTEGRATION_BUILD_DIR), REPO_ROOT);
  assert.equal(dirname(SRC_DIR), REPO_ROOT);
  // Same depth ⇒ every fixed-depth walk from a mirrored module lands identically.
  assert.equal(dirname(INTEGRATION_BUILD_DIR), dirname(SRC_DIR));
});

test("assetRoot()/executionMode() byte-equal between tsx-src and the built tree", async () => {
  const srcMod = await import(pathToFileURL(resolve(SRC_DIR, "v2", "asset-root.ts")).href);
  const builtMod = await import(pathToFileURL(resolve(INTEGRATION_BUILD_DIR, "v2", "asset-root.js")).href);

  // The authoritative depth check — asset-root.ts, NOT seeds (init.ts's two-
  // candidate seed fallback could mask a one-level error that this cannot).
  assert.equal(builtMod.assetRoot(), srcMod.assetRoot());
  assert.equal(builtMod.assetRoot(), REPO_ROOT);

  // Manifest-LESS build ⇒ `dev` mode, exactly as tsx resolves. A stray release
  // manifest in the tree would flip this to `release`.
  assert.equal(srcMod.executionMode(), "dev");
  assert.equal(builtMod.executionMode(), "dev");
});

test("seeds / template / docker / git-root walks land on the repo root identically", () => {
  // init.ts resolveSeedPath()/readTemplate(): join(here, '..','..','..', <asset>)
  const srcSeeds = walkFromDir(SRC_DIR, "cli/commands", ["..", "..", "..", "seeds"]);
  const builtSeeds = walkFromDir(INTEGRATION_BUILD_DIR, "cli/commands", ["..", "..", "..", "seeds"]);
  assert.equal(builtSeeds, srcSeeds);
  assert.equal(builtSeeds, join(REPO_ROOT, "seeds"));
  assert.ok(existsSync(builtSeeds), "primary seeds candidate must exist from the built tree");

  const builtTemplate = join(builtSeeds, "orchestrator-template.md");
  assert.equal(builtTemplate, join(SRC_DIR, "cli/commands", "..", "..", "..", "seeds", "orchestrator-template.md"));
  assert.ok(existsSync(builtTemplate), "orchestrator template must resolve from the built tree");

  // spawn.ts containerBacklogReaderMounts(): join(dirname(dirname(url)), '..','docker').
  // From the module DIR (src/v2), dirname(dirname(file)) is one level up (src), then
  // '../docker' — i.e. two '..' from the module dir, then docker.
  const srcDocker = walkFromDir(SRC_DIR, "v2", ["..", "..", "docker"]);
  const builtDocker = walkFromDir(INTEGRATION_BUILD_DIR, "v2", ["..", "..", "docker"]);
  assert.equal(builtDocker, srcDocker);
  assert.equal(builtDocker, join(REPO_ROOT, "docker"));
  assert.ok(existsSync(builtDocker), "docker/ must resolve from the built tree");

  // backlog.ts forgeRevision(): new URL('../../../', import.meta.url) — the git
  // repo root the CLI runs `git rev-parse` in. Computed from the module FILE.
  const srcGitRoot = new URL("../../../", pathToFileURL(resolve(SRC_DIR, "cli/commands", "backlog.ts"))).pathname;
  const builtGitRoot = new URL(
    "../../../",
    pathToFileURL(resolve(INTEGRATION_BUILD_DIR, "cli/commands", "backlog.js")),
  ).pathname;
  assert.equal(builtGitRoot, srcGitRoot);
  assert.equal(resolve(builtGitRoot), REPO_ROOT);
});

test("`node <builtEntry> --help` exits 0 and matches `tsx src/cli/index.ts --help`", () => {
  const tsxBin = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
  const tsxEntry = resolve(SRC_DIR, "cli", "index.ts");

  const built = spawnSync(NODE_EXEC, [BUILT_CLI_ENTRY, "--help"], { encoding: "utf8" });
  const viaTsx = spawnSync(tsxBin, [tsxEntry, "--help"], { encoding: "utf8" });

  assert.equal(built.status, 0, `built --help exited ${built.status}: ${built.stderr}`);
  assert.equal(viaTsx.status, 0, `tsx --help exited ${viaTsx.status}: ${viaTsx.stderr}`);
  assert.equal(built.stdout, viaTsx.stdout);
});
