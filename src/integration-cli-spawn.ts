// FG-728: the single spawn authority for the integration tier. Every
// `*.integration.test.ts` that spawns a real forge CLI — and every helper that
// wraps that spawn — resolves the executable + entry HERE, instead of each file
// re-deriving `node_modules/.bin/tsx` + `src/cli/index.ts` at its own depth.
//
// The entry is the BUILT CLI (`node <BUILT_CLI_ENTRY>`), a per-file transpile of
// the whole src/ graph produced once per `node --test` process by
// integration-build-preload.ts. Spawning `node` against the prebuilt tree replaces
// the tsx/esbuild cold-transpile of the entire CLI import graph that every spawn
// used to pay (~600-700ms) with a plain Node cold-start (~50-80ms) — the sole
// source of the integration tier's dominant runner-minute cost.
//
// This module is NOT a `*.integration.test.ts` file on purpose: node:test must not
// collect it. Later steps import these constants; they never recompute tsx/entry.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/src

/** The repo root — the parent of src/ AND of the build tree (they are siblings). */
export const REPO_ROOT = resolve(here, "..");

/** The tsx source tree this file lives in. */
export const SRC_DIR = here;

/** The build tree: a gitignored, per-file mirror of src/ that sits EXACTLY one
 *  level under the repo root, a SIBLING of src/. The sibling-at-equal-depth
 *  placement is load-bearing, not cosmetic: the codebase resolves release-owned
 *  assets and the repo root by walking a FIXED number of levels up from each
 *  module's own import.meta.url, at several different depths (asset-root ../../,
 *  backlog git-root ../../../, init seeds ../../../{,../}, spawn docker via
 *  dirname(dirname)/../docker). Because the mirror is at the same depth as src/,
 *  every one of those fixed-depth walks lands on the repo root BY CONSTRUCTION —
 *  identically to running the same file under tsx from src/. A single-file bundle
 *  would collapse every module onto one import.meta.url and silently mis-resolve
 *  seeds/templates/docker/git-root; the per-file mirror is what preserves them.
 *
 *  FORGE_INTEGRATION_BUILD_DIR overrides the location (default byte-identical to
 *  the sibling path above). A test that spawns a NESTED integration-tier `node
 *  --test` sets it to a per-invocation dir so the nested preload's wipe + rebuild
 *  never contends on the shard's shared `.forge-integration-build`. That override
 *  MUST itself be a sibling of src/ at REPO_ROOT depth (e.g.
 *  `<REPO_ROOT>/.forge-integration-build.<invocation-id>`) so the same fixed-depth
 *  walks keep landing on the repo root; an arbitrary tmpdir would break them. */
export const INTEGRATION_BUILD_DIR = process.env.FORGE_INTEGRATION_BUILD_DIR
  ? resolve(process.env.FORGE_INTEGRATION_BUILD_DIR)
  : resolve(REPO_ROOT, ".forge-integration-build");

/** The node executable that runs the built CLI. */
export const NODE_EXEC = process.execPath;

/** The built CLI entry. Spawn `node BUILT_CLI_ENTRY ...` in place of the old
 *  `tsx src/cli/index.ts ...`. */
export const BUILT_CLI_ENTRY = resolve(INTEGRATION_BUILD_DIR, "cli", "index.js");

/** The BUILT (.js) authority testkit URL. A spawned `node` CLI has no tsx
 *  registered, so it cannot parse the `.ts` testkit; the `--import` argument that
 *  container-authority.testkit-spawn.ts hands every spawn must be the built .js at
 *  the mirrored location. Its own `resolve(here,'..','..','bin','forge-loader.mjs')`
 *  stays depth-correct because the mirror is a sibling of src/. */
export const BUILT_AUTHORITY_TESTKIT_URL = pathToFileURL(
  resolve(INTEGRATION_BUILD_DIR, "backlog", "container-authority.testkit.js"),
).href;
