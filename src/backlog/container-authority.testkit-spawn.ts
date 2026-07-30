// FG-645: the PARENT-SIDE half of the FG-644 container-authority test seam.
//
// container-authority.testkit.ts is what the CHILD loads. This module is what the
// test that spawns it needs: the preload's file URL, and the environment that arms
// it. Both were being hand-rolled per suite, with the testkit path spelled relative
// to each suite's own depth — 27 copies of a three-part recipe where getting one
// part wrong (forgetting FORGE_BACKLOG_SNAPSHOT_DIR, say) fails only inside an
// agent container, i.e. nowhere the author would see it.
//
// On a host, where there is no marker at the compiled-in path and no snapshot
// pointer in the environment, arming this changes nothing: the child resolves no
// container authority either way. That equivalence is the point — the suites mean
// the same thing in both places.
//
// This does not weaken the FG-608 F2 gate. The mount variable is inert unless the
// process was explicitly told to `--import` the testkit, and choosing what code
// your own process loads was never something the gate could prevent.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SNAPSHOT_DIR_ENV } from "./container-authority.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The `--import` argument for a spawned forge CLI child. */
export const AUTHORITY_TESTKIT_URL = pathToFileURL(resolve(here, "container-authority.testkit.ts")).href;

let mount: string | null = null;

/** A directory carrying no authority marker, created once per test process and never
 *  written to. Pointing the child's compiled-in probe here is what makes it resolve
 *  the fixture the test built instead of the container's mounted snapshot. */
export function neutralAuthorityMount(): string {
  if (!mount) mount = mkdtempSync(resolve(tmpdir(), "forge-no-authority-"));
  return mount;
}

/** Env overlay for a spawned forge CLI child. Spread it over `process.env` LAST, so
 *  it wins over an inherited container pointer.
 *
 *  Both keys are required inside an agent container: the marker at the compiled-in
 *  path is what the probe checks first (hence the mount repoint), and
 *  FORGE_BACKLOG_SNAPSHOT_DIR is exported into every agent container as the fallback
 *  pointer (hence clearing it). */
export function authorityTestkitEnv(): Record<string, string> {
  return { [SNAPSHOT_DIR_ENV]: "", FORGE_TEST_AUTHORITY_MOUNT: neutralAuthorityMount() };
}

/** `tsx`/`node` argv prefix that loads the preload ahead of `entry`. */
export function withAuthorityTestkit(entry: string, args: string[]): string[] {
  return ["--import", AUTHORITY_TESTKIT_URL, entry, ...args];
}

/** The same seam for a child launched through `bin/forge`, which builds its OWN node
 *  argv and so has nowhere to take an `--import` from the caller. NODE_OPTIONS's
 *  imports run BEFORE the argv ones, which is why the tsx loader has to be named here
 *  too — the testkit is TypeScript, and nothing can parse it until tsx is registered.
 *  bin/forge's own `--import` of that same loader is then a module-cache hit. */
export function authorityTestkitBinEnv(): Record<string, string> {
  const loader = pathToFileURL(resolve(here, "..", "..", "bin", "forge-loader.mjs")).href;
  const existing = process.env["NODE_OPTIONS"];
  return {
    ...authorityTestkitEnv(),
    NODE_OPTIONS: `${existing ? existing + " " : ""}--import ${loader} --import ${AUTHORITY_TESTKIT_URL}`,
  };
}
