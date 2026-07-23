// FG-418 anti-silent-removal guard: asserts that seeds/workflows/feature.yml
// lists shipping-reviewer in its build-phase reds with authority:specialist and
// gate_on_verdict:false. Uses the REAL v2 loader so any edit that deletes the
// entry or flips it to authoritative will fail this test immediately.
//
// WHY a separate file: loader.test.ts has beforeEach/afterEach that override
// FORGE_HOME with a fresh temp dir; this test needs FORGE_HOME to point at the
// seeds directory, so it manages its own env save/restore.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadWorkflow } from "./loader.js";
import { publishSeedGeneration } from "./seed-generation.js";

// Resolve the seeds directory relative to this test file:
//   src/v2/fg418-feature-yml-advisory-wiring.test.ts
//   → src/v2/
//   → src/
//   → (project root)
//   → seeds/
const projectRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const SEEDS_DIR = join(projectRoot, "seeds");

let savedForgeHome: string | undefined;
let homeDir: string;

before(() => {
  savedForgeHome = process.env.FORGE_HOME;
  // FG-583: dispatch reads only a published generation — the raw seeds/ tree is no
  // longer a dispatch source. Publish the REAL release seeds (projectRoot/seeds) as a
  // complete generation into a disposable home, so loadWorkflow("feature") validates
  // the shipped feature.yml through the generation path.
  homeDir = mkdtempSync(join(tmpdir(), "fg418-home-"));
  process.env.FORGE_HOME = homeDir;
  publishSeedGeneration({ home: homeDir, assetsDir: projectRoot, trustedAssetRoot: () => projectRoot });
});

after(() => {
  if (savedForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ─── FG-418 advisory-wiring guard ─────────────────────────────────────────────

test(
  "(fg418-yml-1) feature.yml loads cleanly via v2 loader with FORGE_HOME=seeds",
  () => {
    const wf = loadWorkflow("feature");
    assert.equal(wf.name, "feature", "loaded workflow name must be 'feature'");

    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "feature workflow must have a 'build' step");
  },
);

test(
  "(fg418-yml-2) build step reds INCLUDE shipping-reviewer (anti-silent-removal guard)",
  () => {
    const wf = loadWorkflow("feature");
    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "build step must exist");

    const reds = buildStep!.reds ?? [];
    const shippingReviewerRed = reds.find((r) => r.agent === "shipping-reviewer");
    assert.ok(
      shippingReviewerRed !== undefined,
      `build step reds must include shipping-reviewer; got: ${JSON.stringify(reds.map((r) => r.agent))}`,
    );
  },
);

test(
  "(fg418-yml-3) shipping-reviewer red has authority:authoritative (FG-420 promotion — prerequisites FG-418/FG-419/FG-367 are now real)",
  () => {
    const wf = loadWorkflow("feature");
    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "build step must exist");

    const reds = buildStep!.reds ?? [];
    const shippingReviewerRed = reds.find((r) => r.agent === "shipping-reviewer");
    assert.ok(shippingReviewerRed !== undefined, "shipping-reviewer red must exist");

    assert.equal(
      shippingReviewerRed!.authority,
      "authoritative",
      "shipping-reviewer authority must be 'authoritative' after FG-420 promotion — reverting to 'specialist' would silently drop blocking coverage",
    );
  },
);

test(
  "(fg418-yml-4) shipping-reviewer red has gate_on_verdict:true (FG-420 promotion — needs_fix must block the build gate)",
  () => {
    const wf = loadWorkflow("feature");
    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "build step must exist");

    const reds = buildStep!.reds ?? [];
    const shippingReviewerRed = reds.find((r) => r.agent === "shipping-reviewer");
    assert.ok(shippingReviewerRed !== undefined, "shipping-reviewer red must exist");

    assert.equal(
      shippingReviewerRed!.gate_on_verdict,
      true,
      "shipping-reviewer gate_on_verdict must be true after FG-420 promotion — reverting to false would silently allow needs_fix to advance past the build gate",
    );
  },
);
