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

// FG-640 SUPERSEDES the FG-420 promotion for this workflow — and the guard keeps its teeth
// by moving, not by relaxing. `feature` is now `review_mode: evidence_led`, where the
// shipping reviewer's verdict is EVIDENCE (its findings enter the ledger and are settled
// through the review_disposition gate) rather than authority. What must never happen is
// either half alone: an advisory shipping reviewer on a workflow that has NOT declared the
// cutover is exactly the silent drop of blocking coverage FG-420 guarded against, and an
// authoritative one on a workflow that HAS declared it combines two authority models in one
// run (refused by name at the gate — mixed_authority_model). So the two are asserted as a
// PAIR, and reverting either side alone reddens here.
test(
  "(fg418-yml-3) shipping-reviewer's authority is PAIRED with the workflow's declared review_mode",
  () => {
    const wf = loadWorkflow("feature");
    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "build step must exist");

    const shippingReviewerRed = (buildStep!.reds ?? []).find((r) => r.agent === "shipping-reviewer");
    assert.ok(shippingReviewerRed !== undefined, "shipping-reviewer red must exist");

    if (wf.review_mode === "evidence_led") {
      assert.equal(
        shippingReviewerRed!.authority,
        "specialist",
        "under review_mode: evidence_led the shipping reviewer is advisory — an authoritative one would combine two authority models in one run",
      );
      assert.equal(
        shippingReviewerRed!.gate_on_verdict,
        false,
        "under review_mode: evidence_led the shipping reviewer's verdict must not gate — the ledger does",
      );
    } else {
      assert.equal(
        shippingReviewerRed!.authority,
        "authoritative",
        "on a workflow that has NOT declared the evidence-led cutover, reverting the shipping reviewer to 'specialist' silently drops blocking coverage (FG-420)",
      );
      assert.equal(
        shippingReviewerRed!.gate_on_verdict,
        true,
        "on a legacy-mode workflow, gate_on_verdict:false would silently allow needs_fix to advance past the build gate (FG-420)",
      );
    }
  },
);

// The other half of the pair, stated as its own guard so a diff that flips ONLY the workflow
// line reddens with a message about the reds it just orphaned.
test(
  "(fg418-yml-4) every build red's authority agrees with the workflow's declared review_mode",
  () => {
    const wf = loadWorkflow("feature");
    const buildStep = wf.steps.find((s) => s.id === "build");
    assert.ok(buildStep !== undefined, "build step must exist");

    const expected = wf.review_mode === "evidence_led" ? "specialist" : "authoritative";
    for (const red of buildStep!.reds ?? []) {
      assert.equal(
        red.authority,
        expected,
        `build red '${red.agent}' is ${red.authority} while the workflow declares review_mode: ${wf.review_mode} — one run, one authority model`,
      );
      assert.equal(red.gate_on_verdict, expected === "authoritative", `build red '${red.agent}' gate_on_verdict disagrees with review_mode: ${wf.review_mode}`);
    }
  },
);

