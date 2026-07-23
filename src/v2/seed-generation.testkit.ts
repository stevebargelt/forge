// FG-583 test support — publish a COMPLETE seed generation into a disposable
// FORGE_HOME from in-memory fixture bytes, via the REAL publishSeedGeneration.
//
// Since FG-583 there is no flat $FORGE_HOME/{workflows,runtimes} dispatch fallback:
// dispatch reads ONLY a published generation, and the loader REFUSES (named,
// repairable) when none is published. Tests that used to write the flat layout and
// call loadWorkflow/loadRuntime must instead publish a generation. This helper is the
// migration path — it stages fixture bytes into a disposable asset root and publishes
// them atomically, exercising the real source/destination trust and the atomic swap,
// and returns the resolved generation so a test can anchor to it.
//
// Not a test file (no `.test.ts`) — imported by tests. Every caller passes a disposable
// home; the real ~/.forge is never touched.

import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSeedGeneration, resolveSeedGeneration, type SeedGeneration } from "./seed-generation.js";

export type TestGenerationFixture = {
  /** filename (with or without a `.yml` suffix) → YAML bytes, staged under seeds/workflows. */
  workflows?: Record<string, string>;
  /** filename (with or without a `.yml` suffix) → YAML bytes, staged under seeds/runtimes. */
  runtimes?: Record<string, string>;
  /** host RACI to compile the derived routing policy from (optional). */
  raciPath?: string;
  /** where to build the disposable asset root — defaults to a fresh tmp dir. Pass the
   *  test's own tmp so it is cleaned up with everything else. */
  assetsParent?: string;
};

function withYml(name: string): string {
  return name.endsWith(".yml") ? name : `${name}.yml`;
}

/** Stage + atomically publish a COMPLETE seed generation into `home` from fixture
 *  bytes, returning the resolved generation. */
export function publishTestGeneration(home: string, fixture: TestGenerationFixture = {}): SeedGeneration {
  const parent = fixture.assetsParent ?? tmpdir();
  const assetRoot = mkdtempSync(join(parent, "forge-testgen-"));
  const seeds = join(assetRoot, "seeds");
  const wfDir = join(seeds, "workflows");
  const rtDir = join(seeds, "runtimes");
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(rtDir, { recursive: true });
  for (const [name, body] of Object.entries(fixture.workflows ?? {})) {
    writeFileSync(join(wfDir, withYml(name)), body);
  }
  for (const [name, body] of Object.entries(fixture.runtimes ?? {})) {
    writeFileSync(join(rtDir, withYml(name)), body);
  }
  publishSeedGeneration({
    home,
    assetsDir: assetRoot,
    trustedAssetRoot: () => assetRoot,
    raciPath: fixture.raciPath,
  });
  const gen = resolveSeedGeneration(home);
  if (!gen) throw new Error("publishTestGeneration: generation did not resolve after publish");
  return gen;
}

/** Migration convenience for tests that already write the flat $FORGE_HOME/{workflows,
 *  runtimes} layout: copy whatever those flat dirs currently hold into a disposable
 *  asset root and publish it as a complete generation. One added call after the
 *  existing flat writes is the whole migration — the flat dirs stay in place (harmless;
 *  the drift detector / doctor still read them), but dispatch now reads the published
 *  generation. Returns the resolved generation. */
export function publishFlatAsGeneration(
  home: string,
  opts: { raciPath?: string; assetsParent?: string } = {},
): SeedGeneration {
  const parent = opts.assetsParent ?? tmpdir();
  const assetRoot = mkdtempSync(join(parent, "forge-testgen-flat-"));
  const seeds = join(assetRoot, "seeds");
  for (const cat of ["workflows", "runtimes"] as const) {
    const src = join(home, cat);
    const dst = join(seeds, cat);
    mkdirSync(dst, { recursive: true });
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
  }
  publishSeedGeneration({
    home,
    assetsDir: assetRoot,
    trustedAssetRoot: () => assetRoot,
    raciPath: opts.raciPath,
  });
  const gen = resolveSeedGeneration(home);
  if (!gen) throw new Error("publishFlatAsGeneration: generation did not resolve after publish");
  return gen;
}
