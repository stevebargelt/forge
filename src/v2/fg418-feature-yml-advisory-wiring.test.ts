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
import { loadWorkflow } from "./loader.js";

// Resolve the seeds directory relative to this test file:
//   src/v2/fg418-feature-yml-advisory-wiring.test.ts
//   → src/v2/
//   → src/
//   → (project root)
//   → seeds/
const projectRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const SEEDS_DIR = join(projectRoot, "seeds");

let savedForgeHome: string | undefined;

before(() => {
  savedForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = SEEDS_DIR;
});

after(() => {
  if (savedForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedForgeHome;
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
  "(fg418-yml-3) shipping-reviewer red has authority:specialist (anti-accidental-authoritative guard)",
  () => {
    const wf = loadWorkflow("feature");
    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "build step must exist");

    const reds = buildStep!.reds ?? [];
    const shippingReviewerRed = reds.find((r) => r.agent === "shipping-reviewer");
    assert.ok(shippingReviewerRed !== undefined, "shipping-reviewer red must exist");

    assert.equal(
      shippingReviewerRed!.authority,
      "specialist",
      "shipping-reviewer authority must be 'specialist' — flipping to 'authoritative' would block all builds while host_verification is unknown",
    );
  },
);

test(
  "(fg418-yml-4) shipping-reviewer red has gate_on_verdict:false (advisory — must not block the build gate)",
  () => {
    const wf = loadWorkflow("feature");
    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "build step must exist");

    const reds = buildStep!.reds ?? [];
    const shippingReviewerRed = reds.find((r) => r.agent === "shipping-reviewer");
    assert.ok(shippingReviewerRed !== undefined, "shipping-reviewer red must exist");

    assert.equal(
      shippingReviewerRed!.gate_on_verdict,
      false,
      "shipping-reviewer gate_on_verdict must be false — a true here would block the build gate on every reviewer fail",
    );
  },
);
