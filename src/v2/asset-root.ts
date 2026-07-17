// FG-577: the ONE authority for "where do release-owned bytes live" — and the
// deliberately separate answer to "which tree does dev-advancement mutate".
//
// Three call sites used to re-derive `$FORGE_REPO_DIR ?? ~/code/forge` on their
// own (upgrade's installer + template, doctor's image probe, seed-drift's
// baseline), so a promoted release repaired ~/.forge with DEV bytes and doctor
// and upgrade could disagree about what is installed. The fix is caller-side:
// FG-569 already declares seeds/, scripts/ and docker/ REQUIRED in every release
// and already specifies them resolving module-relative to the release root.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { locateReleaseManifest } from "./release.js";

export type ExecutionMode = "release" | "dev";

const THIS_MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** `<pkg>/src/v2/asset-root.ts` → `<pkg>`. Pure over its input so a test can
 *  point it at a disposable fixture tree without promoting this host. */
export function assetRootFrom(moduleDir: string): string {
  return resolve(moduleDir, "..", "..");
}

/** Where release-owned assets (seeds/, scripts/, docker/) live: the tree this
 *  module is executing from. Under a release that is the release; under a live
 *  dev checkout it is the npm-linked checkout — so no mode branch is needed and
 *  dev behaviour is preserved by construction. Ambient FORGE_REPO_DIR /
 *  --forge-repo must never influence this. */
export function assetRoot(): string {
  return assetRootFrom(THIS_MODULE_DIR);
}

export function executionModeFrom(moduleDir: string): ExecutionMode {
  // A manifest that is PRESENT but unparseable is `malformed`, and malformed
  // means RELEASE: the caller is demonstrably inside a release, so falling back
  // to dev would install dev bytes for a release we could not verify. Do not
  // infer safety from node-preflight's exit(1) on an unusable manifest — that
  // gate may be relaxed or bypassed; this mapping must stand on its own.
  return locateReleaseManifest(moduleDir).kind === "none" ? "dev" : "release";
}

export function executionMode(): ExecutionMode {
  return executionModeFrom(THIS_MODULE_DIR);
}

/** The checkout that `git pull` / `npm install` / an image rebuild ADVANCE.
 *  Scoped to dev-advancement only: it is authoritative for nothing that lands in
 *  $FORGE_HOME or a project, and is structurally never an install source. That
 *  scope is what keeps a hostile ambient FORGE_REPO_DIR out of release-owned
 *  bytes as a property rather than a patch at each call site. */
export function devCheckoutDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.FORGE_REPO_DIR) return resolve(process.env.FORGE_REPO_DIR);
  return join(homedir(), "code", "forge");
}
