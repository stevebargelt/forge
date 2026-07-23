// FG-583 (FG-572 Child 5h) — PROMOTED-LAYOUT acceptance test (graded AC).
//
// Drives the REAL installed command surface (`runUpgrade` — the exact function the
// CLI `.action()` calls, minus commander parsing → the real install-seeds.sh →
// publishSeedGeneration) as a PROMOTED RELEASE, with a deliberately DIVERGENT dev
// checkout present, and exercises the DISPATCH RESOLUTION PATH (the same
// resolveSeedGeneration anchor + loader every dispatch entry — `forge next` /
// invoke / gate — uses), NOT a direct one-off library call against a dev fixture.
//
// Two release fixtures A and B are built so that each INDIVIDUAL workflow file is
// Zod-valid, but a cross-file A/B mixture is a set NO release shipped (each carries
// its release marker in the workflow `description`, and the two ship DIFFERENT
// workflow sets). The acceptance criteria proven here:
//
//   1. Upgrade from release A publishes a generation whose bytes are EXCLUSIVELY
//      A's — the divergent dev checkout never leaks in (FG-577 assetRoot provenance,
//      enforced end-to-end through the installed command path).
//   2. The dispatch-resolution path (resolveSeedGeneration anchor + loader) reads
//      ONE COMPLETE A generation — never an A/B mix.
//   3. Atomically promoting B (a second real upgrade) → a NEW invocation resolves
//      ONE complete B generation, while an ALREADY-RUNNING invocation holding its
//      open anchor stays on complete A and never observes an A/B mix.
//   4. The destination-trust refusal fires at the INSTALLED surface too: a
//      replaceable destination symlink escaping the home is refused, and the
//      unrelated target is left byte-for-byte unchanged.
//
// FORGE_HOME is the disposable temp home every test process runs under
// (src/test-setup.ts) — the real ~/.forge is NEVER touched.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpgrade, type UpgradeResult } from "./upgrade.js";
import { assetRoot } from "../../v2/asset-root.js";
import { resolveSeedGeneration, inspectSeedInstall } from "../../v2/seed-generation.js";
import { loadWorkflow } from "../../v2/loader.js";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

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

/** A tree shaped like a promoted release: forge-release.json manifest + the
 *  required asset dirs, with a distinctive workflow set tagged by `marker`. The
 *  REAL install-seeds.sh is copied in unmodified (it resolves its own $HERE). */
function releaseTree(prefix: string, marker: string, workflowNames: string[]): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(base);
  for (const d of ["agents", "constraints", "runtimes", "workflows"]) {
    mkdirSync(join(base, "seeds", d), { recursive: true });
  }
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(join(base, "seeds", "runtimes", "claude-apikey.yml"),
    [`name: claude-apikey`, `description: "${marker} runtime"`, `runtime_kind: claude-code`,
     `log_format: claude-stream-json`, `prompt_strategy: claude-stdin-package`,
     `auth_strategy: env-provider-api-key`, `image: agent-dev-worker:latest`,
     `models:`, `  default: test-model`, ``].join("\n"));
  writeFileSync(join(base, "seeds", "agents", "note.md"), `${marker} agent\n`);
  writeFileSync(join(base, "seeds", "constraints", "note.md"), `${marker} constraint\n`);
  writeFileSync(join(base, "seeds", "orchestrator-template.md"), `${marker} TEMPLATE\n`);
  for (const n of workflowNames) writeFileSync(join(base, "seeds", "workflows", `${n}.yml`), workflowYaml(n, marker));
  cpSync(join(assetRoot(), "scripts", "install-seeds.sh"), join(base, "scripts", "install-seeds.sh"));
  writeFileSync(join(base, "forge-release.json"), JSON.stringify({ schema: 1, abi: "137", id: `fg583-${marker}` }));
  return base;
}

/** Drive the real command action as a promoted release. exitCode is captured so a
 *  release-check failure (no docker in-container) doesn't leak to the runner, and
 *  the structured UpgradeResult is returned for assertions on the installed surface. */
function upgradeAsRelease(assetsDir: string, devDir: string): UpgradeResult {
  const before = process.exitCode;
  process.exitCode = undefined;
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return runUpgrade({ skipProject: true }, { mode: "release", assetsDir, devDir });
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    process.exitCode = before;
  }
}

test("FG-583: upgrade from release A publishes EXCLUSIVELY A's bytes, and the dispatch path reads ONE complete A generation — under a divergent dev checkout", () => {
  const releaseA = releaseTree("fg583-relA-", "A", ["alpha", "beta"]);
  const devCheckout = releaseTree("fg583-dev-", "DEVDIVERGENT", ["alpha", "beta"]);
  // runUpgrade is told mode:"release" + assetsDir:releaseA explicitly, mirroring a
  // promoted runtime installing its OWN release-bundled seeds. The installer runs
  // for real; the generation is then published from the executing release.
  const result = upgradeAsRelease(releaseA, devCheckout);
  assert.equal(result.seedGeneration, "published", "the installed command published an atomic generation");

  // DISPATCH RESOLUTION PATH: the anchor every dispatch entry captures.
  const anchor = resolveSeedGeneration();
  assert.ok(anchor, "the dispatch anchor resolves one published generation");
  assert.equal(inspectSeedInstall().kind, "healthy", "the install is healthy, not partial/torn");

  // Every workflow read THROUGH the anchor (the dispatch consume path) is release
  // A's bytes — never the divergent dev checkout's, never a cross-file mix.
  for (const n of ["alpha", "beta"]) {
    assert.match(loadWorkflow(n, { seedGeneration: anchor }).description, /release A/, `${n} is A's`);
    assert.doesNotMatch(loadWorkflow(n, { seedGeneration: anchor }).description, /DEVDIVERGENT/, `${n} is not dev bytes`);
  }
  assert.equal(anchor.manifest.sourceAssetRoot.includes(devCheckout), false, "dev checkout is never the recorded source");
});

test("FG-583: promoting B — a NEW invocation consumes complete B; an ALREADY-RUNNING invocation stays on complete A, never an A/B mix", () => {
  // A and B ship DIFFERENT workflow sets AND different marker bytes, so a mix is a
  // set no release shipped: A has {alpha, beta}; B has {alpha, gamma}.
  const releaseA = releaseTree("fg583-A2-", "A", ["alpha", "beta"]);
  const releaseB = releaseTree("fg583-B2-", "B", ["alpha", "gamma"]);
  const devCheckout = releaseTree("fg583-dev2-", "DEVDIVERGENT", ["alpha", "beta"]);

  // Promote A, then an already-running invocation captures its anchor ONCE.
  upgradeAsRelease(releaseA, devCheckout);
  const anchorA = resolveSeedGeneration();
  assert.ok(anchorA);
  assert.match(loadWorkflow("alpha", { seedGeneration: anchorA }).description, /release A/);
  assert.match(loadWorkflow("beta", { seedGeneration: anchorA }).description, /release A/);

  // Atomically promote B via a second real upgrade.
  const resultB = upgradeAsRelease(releaseB, devCheckout);
  assert.equal(resultB.seedGeneration, "published");

  // A NEW invocation resolves the live pointer → ONE complete B generation.
  const fresh = resolveSeedGeneration();
  assert.ok(fresh);
  assert.match(loadWorkflow("alpha", { seedGeneration: fresh }).description, /release B/);
  assert.match(loadWorkflow("gamma", { seedGeneration: fresh }).description, /release B/);

  // The ALREADY-RUNNING invocation, threading its open anchor, stays on COMPLETE A:
  // every A workflow still resolves to A's bytes, and B's exclusive workflow
  // (`gamma`) is NOT visible through A's anchor — so it can never observe an A/B mix.
  assert.match(loadWorkflow("alpha", { seedGeneration: anchorA }).description, /release A/);
  assert.match(loadWorkflow("beta", { seedGeneration: anchorA }).description, /release A/);
  assert.throws(() => loadWorkflow("gamma", { seedGeneration: anchorA }), /not found/, "B-only workflow is invisible to A's anchor — no cross-generation mix");
  assert.notEqual(anchorA.root, fresh.root, "distinct complete generations — no run spans both");
});

test("FG-583: destination-trust refusal fires at the INSTALLED surface — a replaceable destination symlink is refused, the unrelated target unchanged", () => {
  // runUpgrade operates on the disposable $FORGE_HOME constant (src/test-setup.ts),
  // so the escaping symlink must stand in for THAT home's seed-generations store.
  // Clear any prior generation state so the symlink can take its place, and remove
  // the symlink in `finally` so later work re-publishes cleanly.
  const home = process.env.FORGE_HOME!;
  const genStore = join(home, "seed-generations");
  rmSync(genStore, { recursive: true, force: true });
  rmSync(join(home, "seed-current"), { force: true });

  const unrelated = mkdtempSync(join(tmpdir(), "fg583-dt-unrelated-"));
  cleanups.push(unrelated);
  const sentinel = join(unrelated, "keep.txt");
  writeFileSync(sentinel, "do-not-touch");
  // Replace the generations store with a symlink escaping the disposable home.
  symlinkSync(unrelated, genStore);
  try {
    const releaseA = releaseTree("fg583-dt-", "A", ["alpha"]);
    const result = upgradeAsRelease(releaseA, releaseA);
    // The installed command surface reports the publication REFUSED (a named,
    // repairable partial-install state) — not a healthy install.
    assert.equal(result.seedGeneration, "failed", "the installed surface refuses the escaping destination");
    assert.ok((result.seedGenerationError ?? "").length > 0, "and names the refusal reason");
    // The unrelated target is byte-for-byte unchanged, and no generation slipped in.
    assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch");
  } finally {
    rmSync(genStore, { force: true });
  }
});
