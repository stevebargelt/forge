// FG-583 (FG-572 Child 5h) — THE SEED GENERATION: atomic publication of the
// forge-owned, dispatch-coupled host seed surface.
//
// THE DEFECT THIS CLOSES. Host seed installation used to be a sequential `cp` loop
// (scripts/install-seeds.sh) with no staging, no publication point, no lock, no
// rollback. A concurrent `forge next` consumes the shared workflow/runtime/policy
// surface directly. An interrupted or mid-flight upgrade could therefore expose a
// TORN yaml (fails dispatch) or — the sharp case — an old/new MIXTURE that still
// passes Zod, so dispatch runs under a workflow/policy set no release ever shipped.
// No attacker, no same-UID tampering: an ordinary interrupted upgrade is enough.
//
// THE FIX — reuse FG-571's settled atomic-publication vocabulary (promote.ts), do
// NOT invent a second mechanism. The forge-owned dispatch-coupled surfaces
// (workflows, runtimes, the derived compiled routing policy) are staged as ONE
// complete generation under a fresh directory, then committed with a SINGLE
// rename(2) over a DEDICATED seed pointer that resolves THROUGH a stable selection
// dir (seedCurrentLinkIn -> seed-selection/current). Generation dirs are retained,
// never recycled — a process resolves the pointer PHYSICALLY at dispatch entry and
// stays anchored to the generation it found, exactly as promote.ts anchors a
// release. So every consuming process observes ONE complete generation: the one
// current before the upgrade, or the complete one the upgrade publishes, never a
// torn or mixed surface.
//
// MEMBERSHIP is only the forge-owned overwrite-on-upgrade surfaces. agents,
// constraints and raci are AUTHORED_EXEMPT (seed-drift.ts SeedOwnership) — forge
// seeds them once and never writes over them — so they stay create-only OUTSIDE the
// generation, on the flat $FORGE_HOME layout the installer already writes.
//
// SOURCE TRUST — the generation is sourced through FG-577's assetRoot executing-
// release provenance (the caller passes assetRoot()); a caller-selected
// FORGE_REPO_DIR, the live dev checkout, or a bare releases/* path is never the
// source. DESTINATION TRUST — staging and publication destinations are realpath-
// contained inside the disposable $FORGE_HOME; a replaceable destination symlink
// that would redirect publication outside the home is refused BEFORE any byte is
// written, leaving the unrelated target byte-for-byte unchanged.

import { compilePolicyFile } from "../raci/host-policy.js";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  seedCurrentLinkIn,
  seedGenerationsDirIn,
  seedPreviousLinkIn,
  seedSelectionLinkIn,
  seedSelectionsDirIn,
} from "../util/paths.js";
import { atomicSymlinkSwap, realpathContains } from "./promote.js";
import { assetRoot as executingAssetRoot } from "./asset-root.js";
import { sha256OfBytes } from "../util/content-digest.js";

// Resolved LIVE from the environment, matching loader.ts's forgeHome() — the seed
// pointer resolvers and the loaders that consume them MUST agree on which home they
// read, or a process that swaps FORGE_HOME (every test uses a disposable home) would
// resolve the pointer from one home and the workflows from another. The paths.ts
// FORGE_HOME const captures the env at import time, so it is NOT usable as the default.
function liveForgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

/** The forge-owned, dispatch-coupled seed categories that ride inside the atomic
 *  generation. Each is a directory of files copied verbatim from the release's
 *  seeds/. The derived routing policy is committed alongside them (see
 *  publishSeedGeneration) so raw definitions and derived artifact land in ONE swap. */
export const SEED_GENERATION_DIRS = ["workflows", "runtimes", "agent-protocols"] as const;

/** The derived routing policy's filename inside a generation. Committed in the same
 *  rename(2) as the workflows it is compiled from (Risk#3 — no new-workflows/old-policy
 *  window). */
export const GENERATION_ROUTING_POLICY = "routing-policy.yml";

/** The provenance manifest forge writes LAST into a staged generation, so a
 *  generation dir carrying a valid manifest is by construction COMPLETE. `files`
 *  records every published file's sha256, which lets the drift measure (FG-579)
 *  check a consumed file against the generation's OWN provenance rather than against
 *  the executing-release assetRoot baseline — a generation is internally consistent
 *  by construction, so the two-pointer window (Risk#2) cannot produce a spurious
 *  hard refusal. */
export const GENERATION_MANIFEST_NAME = ".seed-generation.json";

export type SeedGenerationManifest = {
  schema: 1;
  /** the assetRoot the generation was sourced from — FG-577 executing-release provenance. */
  sourceAssetRoot: string;
  /** sha256 by generation-relative path, e.g. "workflows/feature.yml". */
  files: Record<string, string>;
};

/** A resolved, held generation: an ABSOLUTE physical root captured once (realpath),
 *  plus its provenance. Anchoring a run to this at dispatch entry and threading it to
 *  every lazy load is what keeps a single invocation on ONE generation even if the
 *  pointer swaps mid-run. */
export type SeedGeneration = {
  root: string;
  manifest: SeedGenerationManifest;
};

/** A NAMED, repairable install state — not a byte diff. Propagated to doctor and the
 *  upgrade result. `incomplete` names a mixed/torn generation the pointer resolves to;
 *  `no-generation` is a host with nothing published yet (fresh / pre-migration). Since
 *  FG-583 both are NOT-ready for dispatch — the loader refuses either, and doctor
 *  reports both as readiness findings with the `forge upgrade` remedy; only `healthy`
 *  (a complete generation is published) dispatches. */
export type SeedInstallState =
  | { kind: "healthy"; generation: string }
  | { kind: "no-generation" }
  | { kind: "incomplete"; reason: string; generation: string | null };

function manifestPath(genRoot: string): string {
  return join(genRoot, GENERATION_MANIFEST_NAME);
}

function readGenerationManifest(genRoot: string): SeedGenerationManifest | null {
  const p = manifestPath(genRoot);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as SeedGenerationManifest;
    if (m?.schema !== 1 || typeof m.sourceAssetRoot !== "string" || typeof m.files !== "object" || m.files === null) {
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

/** Resolve the seed `current` pointer PHYSICALLY, ONCE. Returns the held generation,
 *  or null when nothing is published (fresh host / pre-migration flat layout). Since
 *  FG-583 the loaders do NOT fall back to the flat layout on null — they refuse
 *  dispatch (there is no flat dispatch source), so a null here means dispatch is
 *  refused until `forge upgrade` publishes a generation. A pointer resolving to a
 *  directory with no valid manifest reads as null here too: inspectSeedInstall names
 *  it `incomplete`, and doctor / callers that must not run under a partial install
 *  consult that. */
export function resolveSeedGeneration(home: string = liveForgeHome()): SeedGeneration | null {
  const link = seedCurrentLinkIn(home);
  if (!existsSync(link)) return null;
  let root: string;
  try {
    root = realpathSync(link);
  } catch {
    return null;
  }
  const manifest = readGenerationManifest(root);
  if (!manifest) return null;
  return { root, manifest };
}

/** The NAMED install state for doctor / preflight. Distinguishes:
 *   - no pointer at all            → no-generation (healthy; flat layout / fresh host)
 *   - pointer → dir, valid manifest → healthy
 *   - pointer → nothing / dir with no|invalid manifest → incomplete (torn/mid-publish),
 *     repairable by re-running `forge upgrade`. */
export function inspectSeedInstall(home: string = liveForgeHome()): SeedInstallState {
  const link = seedCurrentLinkIn(home);
  if (!existsSync(link)) return { kind: "no-generation" };
  let root: string;
  try {
    root = realpathSync(link);
  } catch {
    return {
      kind: "incomplete",
      generation: null,
      reason: `the seed generation pointer ${link} does not resolve — a publish was interrupted before it committed`,
    };
  }
  const manifest = readGenerationManifest(root);
  if (!manifest) {
    return {
      kind: "incomplete",
      generation: root,
      reason: `the seed generation at ${root} carries no valid provenance manifest — it is mid-publish or torn`,
    };
  }
  return { kind: "healthy", generation: root };
}

/** DESTINATION TRUST — FOLLOW-SAFE. Before any byte is staged, prove that the two
 *  directories a publish will write — the generations store and the selection store
 *  — resolve PHYSICALLY inside the disposable home. realpathContains (reused from
 *  promote.ts, FG-571's containment vocabulary — NOT a second machinery) follows
 *  every symlink, so a `seed-generations`/`seed-selection` an attacker replaced with
 *  a symlink, or one reached through a symlinked path component, that points outside
 *  the home is caught here — before writing — leaving the unrelated target
 *  byte-for-byte unchanged. The irreducible sub-microsecond same-UID swap of a
 *  component AFTER this check and BEFORE the write (the FG-604 class) is out of
 *  scope; the realistic pre-existing-symlink case is what this closes. */
function assertDestinationsContained(home: string): void {
  const realHome = existsSync(home) ? realpathSync(home) : resolve(home);
  for (const dir of [seedGenerationsDirIn(home), seedSelectionsDirIn(home), seedSelectionLinkIn(home)]) {
    // Only an EXISTING path can be a redirect; a not-yet-created dir is made below
    // and lands inside the home by construction.
    if (!existsSync(dir) && !isSymlink(dir)) continue;
    if (!realpathContains(realHome, dir)) {
      throw new Error(
        `forge seed: refusing to publish — a publication destination escapes the forge home.\n` +
          `  forge home:  ${realHome}\n` +
          `  destination: ${dir}\n` +
          `  resolves to: ${safeRealpath(dir)}\n` +
          `A destination that resolves outside the home is a replaceable symlink that would carry this ` +
          `publish onto an unrelated host path. Forge refuses before writing any byte, so that path is ` +
          `left byte-for-byte unchanged.\n` +
          `Fix: remove the redirecting link at ${dir} and re-run \`forge upgrade\`.`,
      );
    }
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return "(does not resolve)";
  }
}

/** Where `seed-current` and `seed-previous` point once a home is linked through
 *  `seed-selection` — relative, so the chain resolves from the home itself and a
 *  moved/bind-mounted home still resolves. Mirrors promote.ts CURRENT_VIA_SELECTION. */
const SEED_CURRENT_VIA_SELECTION = join("seed-selection", "current");
const SEED_PREVIOUS_VIA_SELECTION = join("seed-selection", "previous");

/** Publish a (current, previous) PAIR for the seed pointer with ONE swap: build a
 *  fresh selection dir holding both links and rename(2) `seed-selection` over it. */
function writeSeedSelection(home: string, current: string | null, previous: string | null): void {
  const dir = join(seedSelectionsDirIn(home), `sel-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(dir, { recursive: true });
  if (current) symlinkSync(current, join(dir, "current"));
  if (previous) symlinkSync(previous, join(dir, "previous"));
  atomicSymlinkSwap(dir, seedSelectionLinkIn(home));
}

/** Bring a home onto the seed-selection layout WITHOUT changing what it selects.
 *  Every swap replaces a pointer with one resolving to the SAME generation (or to
 *  nothing), so an interrupt anywhere inside leaves the home selecting exactly what
 *  it selected before. */
function ensureSeedSelectionLayout(home: string): void {
  const readsThrough = (link: string, expected: string): boolean => {
    try {
      return lstatSync(link).isSymbolicLink() && readlinkSync(link) === expected;
    } catch {
      return false;
    }
  };
  if (readsThrough(seedCurrentLinkIn(home), SEED_CURRENT_VIA_SELECTION) && readsThrough(seedPreviousLinkIn(home), SEED_PREVIOUS_VIA_SELECTION)) {
    return;
  }
  const current = resolveSeedGeneration(home)?.root ?? currentPointerTarget(home);
  const previous = previousPointerTarget(home);
  writeSeedSelection(home, current, previous);
  atomicSymlinkSwap(SEED_CURRENT_VIA_SELECTION, seedCurrentLinkIn(home));
  atomicSymlinkSwap(SEED_PREVIOUS_VIA_SELECTION, seedPreviousLinkIn(home));
}

/** What `seed-current` physically resolves to, without requiring a valid manifest —
 *  used to preserve the incumbent target while migrating the pointer layout. */
function currentPointerTarget(home: string): string | null {
  const link = seedCurrentLinkIn(home);
  try {
    return existsSync(link) ? realpathSync(link) : null;
  } catch {
    return null;
  }
}

function previousPointerTarget(home: string): string | null {
  const link = seedPreviousLinkIn(home);
  try {
    return existsSync(link) ? realpathSync(link) : null;
  } catch {
    return null;
  }
}

export type PublishSeedGenerationOptions = {
  home?: string;
  /** FG-577 executing-release provenance: the assetRoot the seeds are sourced from.
   *  The caller passes assetRoot(); its seeds/ subtree is the ONLY source. This is
   *  VALIDATED against the executing-release provenance below, not trusted — a
   *  caller-selected FORGE_REPO_DIR / dev checkout / bare releases path that does not
   *  match the executing release is REFUSED, so those bytes can never become the
   *  promoted seed source. */
  assetsDir: string;
  /** Test seam ONLY: the executing-release provenance resolver, defaulting to
   *  FG-577's assetRoot() (the tree THIS process runs from). publishSeedGeneration
   *  DERIVES the seed source from this — not from the caller-supplied `assetsDir` —
   *  and refuses if `assetsDir` does not resolve to the same physical tree. A test
   *  injects a disposable release root here; production passes nothing and the real
   *  executing-release root is enforced. */
  trustedAssetRoot?: () => string;
  /** The installed host RACI source to compile the derived routing policy from. When
   *  absent (no host RACI), the generation ships no routing policy — routing falls
   *  back fail-closed, unchanged. */
  raciPath?: string;
  /** Test seam: fires after the generation is fully staged (manifest written) but
   *  BEFORE the atomic swap — the interruption window. Never set in production. */
  onBeforeSwap?: () => void;
};

export type PublishSeedGenerationResult = {
  generation: string;
  previous: string | null;
  files: number;
  routingPolicyCompiled: boolean;
};

/** PUBLISH the complete forge-owned seed surface as ONE atomic generation.
 *
 *  Order IS the safety property:
 *    validate destinations contained -> stage a fresh generation dir from
 *    assetsDir/seeds -> compile the derived routing policy INTO the staging dir ->
 *    write the provenance manifest LAST -> ONE rename(2) over the seed pointer.
 *
 *  An interrupt before the swap leaves only a `.staging-*` dir the pointer never
 *  names, so the prior generation stays fully intact and selectable and NOTHING
 *  partial is ever observable — the torn/mixed surface is structurally impossible.
 *  The staged generation is retained-never-recycled once published, so a process
 *  anchored to a prior generation keeps reading it. */
export function publishSeedGeneration(opts: PublishSeedGenerationOptions): PublishSeedGenerationResult {
  const home = opts.home ?? liveForgeHome();

  // SOURCE TRUST (FG-577). DERIVE the seed source from the executing-release
  // provenance itself — never trust the caller-supplied assetsDir. `trustedRoot` is
  // assetRoot() (the tree this process runs from) in production; a test injects a
  // disposable release. The caller-supplied assetsDir must resolve to the SAME
  // physical tree, or a dev/FORGE_REPO_DIR/bare-releases path could make arbitrary
  // bytes the promoted seed source — the exact thing this refuses.
  const trustedRoot = (opts.trustedAssetRoot ?? executingAssetRoot)();
  const realTrusted = safeRealpath(trustedRoot);
  const realAssets = safeRealpath(opts.assetsDir);
  if (realAssets !== realTrusted) {
    throw new Error(
      `forge seed: refusing to publish — the seed source is not the executing release.\n` +
        `  supplied assetsDir:   ${opts.assetsDir} (resolves to ${realAssets})\n` +
        `  executing release:    ${trustedRoot} (resolves to ${realTrusted})\n` +
        `Seeds are sourced ONLY from the release this forge is executing from (FG-577). A dev checkout, a ` +
        `caller-selected FORGE_REPO_DIR, or a bare releases/* path can never become the promoted seed source. ` +
        `Fix: publish from the executing release (forge upgrade), not a hand-picked directory.`,
    );
  }
  // Read from the TRUSTED root, not the caller's string — provenance is derived,
  // not merely asserted (the two are equal here, so behavior is unchanged).
  const seedsSrc = join(trustedRoot, "seeds");
  if (!existsSync(seedsSrc)) {
    throw new Error(
      `forge seed: refusing to publish — the release's seeds/ tree is missing.\n` +
        `  assetRoot: ${trustedRoot}\n` +
        `  expected:  ${seedsSrc}\n` +
        `Seeds are sourced only from the executing release (FG-577). Fix: reinstall the release.`,
    );
  }

  mkdirSync(home, { recursive: true });
  // DESTINATION TRUST first — before any byte is written.
  assertDestinationsContained(home);

  const generationsDir = seedGenerationsDirIn(home);
  mkdirSync(generationsDir, { recursive: true });
  const staging = join(generationsDir, `.staging-${Math.random().toString(36).slice(2, 10)}`);
  try {
    mkdirSync(staging, { recursive: true });

    const files: Record<string, string> = {};
    for (const category of SEED_GENERATION_DIRS) {
      const srcDir = join(seedsSrc, category);
      const dstDir = join(staging, category);
      mkdirSync(dstDir, { recursive: true });
      if (!existsSync(srcDir)) continue;
      for (const rel of walkRelFiles(srcDir)) {
        const src = join(srcDir, rel);
        const dst = join(dstDir, rel);
        mkdirSync(join(dst, ".."), { recursive: true });
        cpSync(src, dst);
        files[`${category}/${rel}`] = sha256OfBytes(dst);
      }
    }

    // Compile the derived routing policy INTO the staging generation so the raw
    // workflow definitions and the derived artifact commit together in ONE rename
    // (Risk#3 — no new-workflows/old-policy window).
    let routingPolicyCompiled = false;
    if (opts.raciPath && existsSync(opts.raciPath)) {
      const policyDst = join(staging, GENERATION_ROUTING_POLICY);
      const res = compilePolicyFile(opts.raciPath, policyDst, { write: true });
      if (!res.ok) {
        throw new Error(
          `forge seed: refusing to publish — the host RACI does not compile under this release.\n` +
            `  raci:   ${opts.raciPath}\n` +
            `  reason: ${res.error}\n` +
            `Publishing a generation whose derived routing policy is stale or missing would let dispatch ` +
            `run under a policy no release shipped. Fix: correct ${opts.raciPath} and re-run \`forge upgrade\`.`,
        );
      }
      files[GENERATION_ROUTING_POLICY] = sha256OfBytes(policyDst);
      routingPolicyCompiled = true;
    }

    const manifest: SeedGenerationManifest = {
      schema: 1,
      sourceAssetRoot: realTrusted,
      files,
    };
    // Written LAST: a generation dir with a valid manifest is COMPLETE by construction.
    writeFileSync(manifestPath(staging), `${JSON.stringify(manifest, null, 2)}\n`);

    // COMMIT: rename the staging dir to an immutable, retained generation name, then
    // one swap over the pointer. The rename off `.staging-*` makes it addressable;
    // the pointer swap selects it.
    const generation = join(generationsDir, `gen-${Math.random().toString(36).slice(2, 12)}`);
    renameSync(staging, generation);

    const before = resolveSeedGeneration(home)?.root ?? currentPointerTarget(home);
    ensureSeedSelectionLayout(home);
    opts.onBeforeSwap?.();
    writeSeedSelection(home, generation, before);

    return {
      generation,
      previous: before,
      files: Object.keys(files).length,
      routingPolicyCompiled,
    };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** Relative paths of every regular file under `base` (recursive). */
function walkRelFiles(base: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(base, { withFileTypes: true })) {
    const rel = prefix === "" ? ent.name : `${prefix}/${ent.name}`;
    const p = join(base, ent.name);
    if (ent.isDirectory()) out.push(...walkRelFiles(p, rel));
    else if (ent.isFile() && statSync(p).isFile()) out.push(rel);
  }
  return out;
}

/** Resolve a category directory (workflows/runtimes) for a resolved generation, or
 *  null when the generation does not carry that category. Consumed by the loader's
 *  generation-anchored resolution. */
export function generationCategoryDir(gen: SeedGeneration, category: (typeof SEED_GENERATION_DIRS)[number]): string {
  return join(gen.root, category);
}

/** FG-583 (finding 2): the integrity state of a generation's compiled routing
 *  policy, measured against the generation's OWN provenance manifest — the SAME
 *  closed-set / digest check assertGenerationWorkflowConsistent / assertGeneration-
 *  RuntimeConsistent give workflows/runtimes. Without it a torn/tampered generation
 *  could carry a schema-valid but REPLACED routing-policy.yml while workflows/runtimes
 *  stay intact, so route preflight / receipts / dispatch would consume mis-routing
 *  bytes no release shipped.
 *
 *  - `absent`   → the generation ships NO policy (published with no host RACI): not
 *                 in the manifest AND not on disk. Fail-closed fallback, unchanged.
 *  - `present`  → policy present and its bytes match the manifest. Authoritative.
 *  - `tampered` → an unmanifested EXTRA file, a manifested-but-missing file, or a
 *                 byte mismatch — a torn/tampered generation. Consumers refuse
 *                 (dispatch) or report the named state (operator). */
export type GenerationPolicyState =
  | { kind: "absent" }
  | { kind: "present"; path: string }
  | { kind: "tampered"; path: string; reason: string };

export function generationPolicyState(gen: SeedGeneration): GenerationPolicyState {
  const rel = GENERATION_ROUTING_POLICY;
  const expected = gen.manifest.files[rel];
  const path = join(gen.root, rel);
  const onDisk = existsSync(path);
  // A generation with no policy in EITHER the manifest or on disk is the legitimate
  // no-host-RACI case — routing falls back fail-closed, unchanged.
  if (!expected && !onDisk) return { kind: "absent" };
  // Present under the generation dir but absent from its provenance manifest — an
  // unmanifested EXTRA file (the closed-set violation), exactly as the workflow /
  // runtime checks refuse.
  if (!expected) {
    return {
      kind: "tampered",
      path,
      reason:
        `the routing policy at ${path} resolves inside the published seed generation but is not in its provenance manifest ` +
        `(${gen.root}) — a file present under the generation but absent from its manifest means this generation is torn or was tampered with, a state no release shipped`,
    };
  }
  // Manifested but missing on disk — a torn/mid-publish generation.
  if (!onDisk) {
    return {
      kind: "tampered",
      path,
      reason: `the routing policy manifested in the seed generation is missing from ${path} — the generation is torn or mid-publish`,
    };
  }
  if (sha256OfBytes(path) !== expected) {
    return {
      kind: "tampered",
      path,
      reason:
        `the routing policy at ${path} does not match the seed generation's provenance manifest (${gen.root}) — ` +
        `the generation is torn or was tampered with, a state no release shipped`,
    };
  }
  return { kind: "present", path };
}
