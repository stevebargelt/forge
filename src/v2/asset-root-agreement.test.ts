// FG-577 (criterion 5): doctor and upgrade CANNOT disagree about the asset root.
//
// The three call sites that used to re-derive `$FORGE_REPO_DIR ?? ~/code/forge`
// independently — upgrade's installer+template, doctor's image probe, and
// seed-drift's baseline — are pinned here as reading ONE resolver. This is a
// property test, not a spot check: it drives each site through its REAL entry
// point with a hostile FORGE_REPO_DIR set, which is exactly the condition under
// which the old three-way re-derivation produced three different answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetRoot } from "./asset-root.js";
import { defaultRepoSeedsDir } from "./seed-drift.js";
import { upgradeAssetPaths } from "../cli/commands/upgrade.js";
import { gatherReleaseInputs } from "../cli/commands/doctor.js";

test("FG-577: all three former re-derivation sites read the one authoritative root, even under a hostile FORGE_REPO_DIR", () => {
  const hostile = mkdtempSync(join(tmpdir(), "fg577-hostile-tree-"));
  const before = process.env.FORGE_REPO_DIR;
  process.env.FORGE_REPO_DIR = hostile;
  try {
    const root = assetRoot();

    // Site 1 (was seed-drift.ts:56) — the detector's baseline.
    assert.equal(defaultRepoSeedsDir(), join(root, "seeds"));

    // Site 2 (was upgrade.ts:305 → :133, :209) — BOTH assets, not just seeds.
    const { installScript, templatePath } = upgradeAssetPaths();
    assert.equal(installScript, join(root, "scripts", "install-seeds.sh"));
    assert.equal(templatePath, join(root, "seeds", "orchestrator-template.md"));

    // Site 3 (was doctor.ts:31-32) — the image-staleness probe's build-input root,
    // captured through the real gather path upgrade's release-check tail uses.
    let probedDir: string | undefined;
    gatherReleaseInputs("nonexistent-image-for-fg577", { projectDir: hostile }, {
      probeClisInImage: () => ({}),
      buildInputMtime: (dir) => { probedDir = dir; return 1; },
    });
    assert.equal(probedDir, root);

    // The property, stated directly: no site resolved anything under the tree the
    // ambient environment named.
    for (const p of [defaultRepoSeedsDir(), installScript, templatePath, probedDir!]) {
      assert.ok(!p.startsWith(hostile), `${p} must not resolve under the caller-chosen FORGE_REPO_DIR`);
    }
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(hostile, { recursive: true, force: true });
  }
});
