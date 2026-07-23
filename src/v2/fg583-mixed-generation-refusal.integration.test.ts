// FG-583 (FG-572 Child 5h) integration — the mixed-but-Zod-valid dispatch
// reproduction, RED first, then GREEN under the atomic seed generation.
//
// THE DEFECT. Host seed install used to be a sequential `cp` loop with no staging
// and no publication point. A concurrent `forge next` consuming the shared flat
// $FORGE_HOME/workflows surface could read an old/new MIXTURE where every individual
// file is Zod-valid but the cross-file set is one no release ever shipped. This
// file first REPRODUCES that on the flat layout (RED), then proves the atomic
// generation makes it structurally impossible (GREEN): a reader anchored to (or
// live-resolving) the seed pointer always observes ONE complete generation.
//
// Also covers SOURCE trust (a divergent dev checkout's bytes never become the
// promoted seed source) and DESTINATION trust (a replaceable destination symlink
// cannot redirect publication outside the disposable $FORGE_HOME; refusal leaves
// the unrelated target byte-for-byte unchanged).
//
// Every test uses a DISPOSABLE FORGE_HOME and disposable asset/repo paths — the real
// ~/.forge is NEVER touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishSeedGeneration,
  resolveSeedGeneration,
  inspectSeedInstall,
  beginSeedPublish,
  completeSeedPublish,
} from "./seed-generation.js";
import { loadWorkflow } from "./loader.js";

// A minimal Zod-valid workflow whose `description` we vary per "release", so a
// mixed set is observable by content while every file individually parses.
function workflowYaml(name: string, release: string): string {
  return [
    `name: ${name}`,
    `description: "workflow ${name} shipped by release ${release}"`,
    `steps:`,
    `  - id: only`,
    `    agent: architecture-advisor`,
    ``,
  ].join("\n");
}

function runtimeYaml(name: string): string {
  return [
    `name: ${name}`,
    `description: "runtime ${name}"`,
    `runtime_kind: claude-code`,
    `log_format: claude-stream-json`,
    `prompt_strategy: claude-stdin-package`,
    `auth_strategy: env-provider-api-key`,
    `image: agent-dev-worker:latest`,
    `models:`,
    `  default: test-model`,
    ``,
  ].join("\n");
}

/** A release asset tree: <root>/seeds/{workflows,runtimes}. `release` tags the
 *  workflow descriptions so provenance is checkable by content. */
function buildAssetRoot(base: string, release: string, workflowNames: string[]): string {
  const root = join(base, `release-${release}`);
  const wf = join(root, "seeds", "workflows");
  const rt = join(root, "seeds", "runtimes");
  mkdirSync(wf, { recursive: true });
  mkdirSync(rt, { recursive: true });
  for (const n of workflowNames) writeFileSync(join(wf, `${n}.yml`), workflowYaml(n, release));
  writeFileSync(join(rt, "claude-apikey.yml"), runtimeYaml("claude-apikey"));
  return root;
}

/** Publish a generation whose executing-release provenance (FG-577 / FG-583 source
 *  trust) is the SAME disposable tree the seeds come from. Production passes
 *  assetRoot(); a test injects the disposable release so publishSeedGeneration's
 *  provenance validation accepts it. */
function publish(opts: { home: string; assetsDir: string; onBeforeSwap?: () => void; raciPath?: string }) {
  return publishSeedGeneration({ trustedAssetRoot: () => opts.assetsDir, ...opts });
}

let tmp: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fg583-mix-"));
  home = join(tmp, "forge-home");
  mkdirSync(home, { recursive: true });
  savedHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test("RED: a naive flat sequential install exposes a mixed but Zod-valid workflow set to a consumer", () => {
  // Reproduce the pre-fix defect on the FLAT layout with NO generation published:
  // install release A, then partially overwrite with B (some workflows replaced,
  // others not) — the exact mid-`cp`-loop state. Every file is Zod-valid; the SET
  // is a mixture no release shipped.
  const flatWf = join(home, "workflows");
  mkdirSync(flatWf, { recursive: true });
  // Release A: two workflows.
  writeFileSync(join(flatWf, "alpha.yml"), workflowYaml("alpha", "A"));
  writeFileSync(join(flatWf, "beta.yml"), workflowYaml("beta", "A"));
  // Interrupted upgrade to B: alpha got overwritten, beta did NOT yet.
  writeFileSync(join(flatWf, "alpha.yml"), workflowYaml("alpha", "B"));

  // No generation → loader falls back to the flat layout → it reads the MIX.
  assert.equal(resolveSeedGeneration(home), null, "precondition: no generation published");
  const alpha = loadWorkflow("alpha");
  const beta = loadWorkflow("beta");
  // The defect, observed: alpha is B's, beta is A's — a cross-file set no release
  // shipped, yet both parsed. This is the RED the atomic generation must eliminate.
  assert.match(alpha.description, /release B/);
  assert.match(beta.description, /release A/);
});

test("GREEN: an interrupted publish never exposes a torn/mixed surface — the prior generation stays whole", () => {
  const assetsA = buildAssetRoot(tmp, "A", ["alpha", "beta"]);
  const assetsB = buildAssetRoot(tmp, "B", ["alpha", "beta"]);

  // Publish A atomically.
  publish({ home, assetsDir: assetsA });
  const genA = resolveSeedGeneration(home);
  assert.ok(genA, "A published");
  assert.match(loadWorkflow("alpha", { seedGeneration: genA }).description, /release A/);
  assert.match(loadWorkflow("beta", { seedGeneration: genA }).description, /release A/);

  // Now attempt to publish B but interrupt BEFORE the atomic swap.
  assert.throws(() =>
    publish({
      home,
      assetsDir: assetsB,
      onBeforeSwap: () => {
        throw new Error("kill -9 mid-publish");
      },
    }),
  );

  // The pointer still resolves to the COMPLETE A generation — never a mix of A/B.
  const stillA = resolveSeedGeneration(home);
  assert.ok(stillA);
  assert.equal(stillA.root, genA.root, "seed pointer unmoved by the interrupted publish");
  assert.match(loadWorkflow("alpha").description, /release A/);
  assert.match(loadWorkflow("beta").description, /release A/);
  // And there is no partial/incomplete state — the install is healthy on A.
  assert.equal(inspectSeedInstall(home).kind, "healthy");
});

test("GREEN: anchoring pins an invocation to its generation; a new invocation gets the newly promoted one", () => {
  const assetsA = buildAssetRoot(tmp, "A", ["alpha"]);
  const assetsB = buildAssetRoot(tmp, "B", ["alpha"]);

  publish({ home, assetsDir: assetsA });
  // An already-running invocation captures its anchor ONCE.
  const anchoredA = resolveSeedGeneration(home);
  assert.ok(anchoredA);

  // Atomically promote B (a complete generation).
  publish({ home, assetsDir: assetsB });

  // The already-running invocation, threading its anchor, still reads A.
  assert.match(loadWorkflow("alpha", { seedGeneration: anchoredA }).description, /release A/);
  // A NEW invocation resolves the live pointer and reads the complete B generation.
  const fresh = resolveSeedGeneration(home);
  assert.ok(fresh);
  assert.match(loadWorkflow("alpha", { seedGeneration: fresh }).description, /release B/);
  // No run spans two generations: the two roots are distinct, each complete.
  assert.notEqual(anchoredA.root, fresh.root);
});

test("a reader interleaved between individual installed files never sees a torn surface", () => {
  // publishSeedGeneration stages the WHOLE generation under a private dir and
  // commits it with one rename(2) over the pointer, so a reader resolving the
  // pointer while files are being staged sees the prior generation (here: none),
  // never a half-written one. Model the interleave by resolving during staging.
  const assetsA = buildAssetRoot(tmp, "A", ["alpha", "beta", "gamma"]);
  let midStageObservation: ReturnType<typeof resolveSeedGeneration> = null;
  publish({
    home,
    assetsDir: assetsA,
    onBeforeSwap: () => {
      // Files are fully staged in a private dir but the pointer has NOT swapped:
      // a concurrent reader still sees no published generation (not a torn one).
      midStageObservation = resolveSeedGeneration(home);
    },
  });
  assert.equal(midStageObservation, null, "no torn generation observable before the swap");
  // After the swap, the complete generation is visible with all three workflows.
  const gen = resolveSeedGeneration(home);
  assert.ok(gen);
  for (const n of ["alpha", "beta", "gamma"]) {
    assert.ok(loadWorkflow(n, { seedGeneration: gen }));
  }
});

test("the drift measure NAMES a mixed/incomplete generation rather than re-checking bytes file-by-file", () => {
  const assetsA = buildAssetRoot(tmp, "A", ["alpha"]);
  const gen = (() => {
    publish({ home, assetsDir: assetsA });
    return resolveSeedGeneration(home)!;
  })();
  // Tamper with the installed workflow inside the generation so it disagrees with
  // the generation's own provenance manifest — a genuinely mixed/incomplete state.
  writeFileSync(join(gen.root, "workflows", "alpha.yml"), workflowYaml("alpha", "TAMPERED"));
  assert.throws(
    () => loadWorkflow("alpha", { seedGeneration: gen }),
    /mixed\/incomplete generation|does not match its published seed generation/,
    "refusal names the mixed/incomplete generation state",
  );
});

test("SOURCE trust: a divergent dev checkout's bytes never become the promoted seed source", () => {
  // Release A is the executing release; a dev checkout with DIFFERENT bytes exists.
  const assetsA = buildAssetRoot(tmp, "A", ["alpha"]);
  const devCheckout = buildAssetRoot(tmp, "DEV", ["alpha"]); // divergent bytes
  assert.notEqual(
    readFileSync(join(assetsA, "seeds", "workflows", "alpha.yml"), "utf8"),
    readFileSync(join(devCheckout, "seeds", "workflows", "alpha.yml"), "utf8"),
  );

  // The installer sources STRICTLY from the executing release (assetsDir = A).
  publish({ home, assetsDir: assetsA });
  const gen = resolveSeedGeneration(home);
  assert.ok(gen);
  // The published bytes are A's, never the dev checkout's; provenance records A.
  assert.match(loadWorkflow("alpha", { seedGeneration: gen }).description, /release A/);
  assert.equal(gen.manifest.sourceAssetRoot, realpathSync(assetsA));
});

test("SOURCE trust: publishing dev/arbitrary bytes is REFUSED — they are not the executing release", () => {
  // FG-583 finding 4: publishSeedGeneration DERIVES its source from the executing-
  // release provenance and REFUSES a caller-supplied assetsDir that does not match
  // it. A dev checkout / FORGE_REPO_DIR / bare releases path cannot make its bytes
  // the promoted seed source, even by passing itself as assetsDir directly.
  const assetsA = buildAssetRoot(tmp, "A", ["alpha"]); // the executing release
  const devCheckout = buildAssetRoot(tmp, "DEV", ["alpha"]); // divergent dev bytes
  assert.throws(
    // trustedAssetRoot = A (the executing release), but the caller tries to publish
    // the dev bytes: refused before anything is published.
    () => publishSeedGeneration({ home, assetsDir: devCheckout, trustedAssetRoot: () => assetsA }),
    /not the executing release|refusing to publish/,
    "dev bytes cannot become the promoted seed source",
  );
  assert.equal(resolveSeedGeneration(home), null, "nothing was published from the untrusted source");
});

test("DESTINATION trust: a replaceable destination symlink is refused BEFORE any byte is written; the unrelated target is left unchanged", () => {
  const assetsA = buildAssetRoot(tmp, "A", ["alpha"]);
  // An unrelated host path the attacker's link points at, with a sentinel file.
  const unrelated = join(tmp, "unrelated-host-path");
  mkdirSync(unrelated, { recursive: true });
  const sentinel = join(unrelated, "keep.txt");
  writeFileSync(sentinel, "do-not-touch");

  // Replace the generations store with a symlink that escapes the disposable home.
  symlinkSync(unrelated, join(home, "seed-generations"));

  assert.throws(
    () => publish({ home, assetsDir: assetsA }),
    /escapes the forge home|refusing to publish/,
    "publication refuses before writing when a destination escapes the home",
  );
  // The unrelated target is byte-for-byte unchanged, and no generation slipped in.
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch");
  assert.equal(resolveSeedGeneration(home), null);
});

test("df02eb: a fresh/interrupted INITIAL install exposes NO torn flat workflow surface", () => {
  // With FG-583, install-seeds.sh no longer writes workflows/runtimes into the flat
  // $FORGE_HOME layout — they ship ONLY via the atomic generation. So an install
  // interrupted BEFORE the first publishSeedGeneration commits leaves the create-only
  // authored surfaces (agents/constraints) but NO flat workflow surface: there is
  // nothing torn or mixed for dispatch to fall back onto. Simulate that state.
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(join(home, "constraints"), { recursive: true });
  // No seed pointer and (crucially) no populated flat workflows dir.
  assert.equal(resolveSeedGeneration(home), null);
  // A workflow load cannot reach a mixed/torn set — it fails cleanly "not found"
  // rather than dispatching a half-written flat surface, which is exactly what the
  // removed flat `cp` loop could otherwise leave behind.
  assert.throws(() => loadWorkflow("alpha"), /not found/);
});

test("finding 1: a failed/interrupted re-publish is a NAMED incomplete state even though the prior generation pointer still resolves healthy", () => {
  // Publish a complete generation A — the install is healthy.
  const assetsA = buildAssetRoot(tmp, "A", ["alpha"]);
  publish({ home, assetsDir: assetsA });
  const genA = resolveSeedGeneration(home);
  assert.ok(genA);
  assert.equal(inspectSeedInstall(home).kind, "healthy");

  // The upgrade command's marker lifecycle: a re-publish that BEGAN and then
  // threw/was interrupted leaves the marker behind (the catch in upgrade.ts does
  // NOT clear it). The prior pointer still resolves to complete A...
  beginSeedPublish("forge upgrade did not finish publishing host seeds", home);
  const stillA = resolveSeedGeneration(home);
  assert.ok(stillA);
  assert.equal(stillA.root, genA.root, "prior generation pointer is untouched");

  // ...but inspectSeedInstall now NAMES the incomplete state, carrying the prior
  // generation root, so doctor + dispatch consumers refuse and advise repair rather
  // than reading the stale pointer as healthy.
  const state = inspectSeedInstall(home);
  assert.equal(state.kind, "incomplete");
  if (state.kind === "incomplete") {
    assert.equal(state.generation, genA.root);
    assert.match(state.reason, /did not finish|interrupted or failed|forge upgrade/);
  }

  // A subsequent successful publish clears the marker → healthy again.
  completeSeedPublish(home);
  assert.equal(inspectSeedInstall(home).kind, "healthy");
});

test("finding 2: an interrupted FIRST install (marker set, no pointer) is incomplete — distinct from an untouched pre-migration home", () => {
  // No generation published yet. An untouched pre-migration home carries no marker →
  // no-generation (healthy); the loader's flat fallback is legitimate there.
  assert.equal(resolveSeedGeneration(home), null);
  assert.equal(inspectSeedInstall(home).kind, "no-generation");

  // An interrupted first upgrade mutated the flat workflows/runtimes but crashed
  // before the atomic generation committed. The marker written before install-seeds.sh
  // distinguishes that from the untouched home: inspectSeedInstall reports incomplete
  // (generation null), so dispatch refuses instead of falling back to the mixed flat
  // surface.
  beginSeedPublish("forge upgrade did not finish publishing host seeds", home);
  const state = inspectSeedInstall(home);
  assert.equal(state.kind, "incomplete");
  if (state.kind === "incomplete") assert.equal(state.generation, null);

  completeSeedPublish(home);
  assert.equal(inspectSeedInstall(home).kind, "no-generation");
});

test("inspectSeedInstall NAMES a torn generation (pointer → dir with no manifest) as incomplete/repairable", () => {
  // A generation dir that never got its provenance manifest — a mid-publish/torn
  // state. Point seed-current at it directly (bypassing the atomic path).
  const gens = join(home, "seed-generations");
  const torn = join(gens, "gen-torn");
  mkdirSync(join(torn, "workflows"), { recursive: true });
  writeFileSync(join(torn, "workflows", "alpha.yml"), workflowYaml("alpha", "A"));
  symlinkSync(torn, join(home, "seed-current"));

  const state = inspectSeedInstall(home);
  assert.equal(state.kind, "incomplete");
  if (state.kind === "incomplete") assert.match(state.reason, /no valid provenance manifest|torn|mid-publish/);
  // A torn generation is NOT resolved as usable (loader falls back / dispatch refuses).
  assert.equal(resolveSeedGeneration(home), null);
});
