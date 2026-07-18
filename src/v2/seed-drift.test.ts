import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRepoSeedsDir, detectSeedDrift, renderSeedDrift } from "./seed-drift.js";
import { assetRoot } from "./asset-root.js";

// Build a (repoSeeds, forgeHome) pair under a temp root and run the detector
// against them — never touches the real ~/.forge or the package seeds.
function fixture(): { repo: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "seed-drift-"));
  const repo = join(root, "seeds");
  const home = join(root, "forge-home");
  mkdirSync(join(repo, "runtimes"), { recursive: true });
  mkdirSync(join(repo, "workflows"), { recursive: true });
  mkdirSync(join(repo, "constraints"), { recursive: true });
  mkdirSync(join(home, "runtimes"), { recursive: true });
  mkdirSync(join(home, "workflows"), { recursive: true });
  mkdirSync(join(home, "constraints"), { recursive: true });
  return { repo, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("detectSeedDrift: identical seeds report current and ok", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, true);
    assert.equal(r.stale.length, 0);
    assert.equal(r.entries.find((e) => e.path.endsWith("pi-apikey.yml"))?.status, "current");
  } finally {
    cleanup();
  }
});

test("detectSeedDrift: a drifted RUNTIME seed fails readiness (forge-owned + executable)", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "provider: anthropic\n"); // stale
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, false);
    const e = r.stale.find((x) => x.path.endsWith("pi-apikey.yml"));
    assert.equal(e?.status, "drifted");
    assert.equal(e?.ownership, "forge-owned");
    assert.equal(e?.coupling, "executable");
  } finally {
    cleanup();
  }
});

// FG-579: workflows are forge-owned AND executable, so a stale workflow is a hard
// readiness FAIL in the same class as runtimes — the silent mis-run this ticket
// exists to stop. Before FG-579 SEED_SPECS omitted the category entirely, so this
// drift produced NO entry and readiness stayed (wrongly) ok.
test("detectSeedDrift: a drifted WORKFLOW seed fails readiness (forge-owned + executable)", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "workflows", "feature.yml"), "name: feature\nsteps: []\n");
    writeFileSync(join(home, "workflows", "feature.yml"), "name: feature\nsteps: [stale]\n"); // stale
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, false, "a stale workflow silently mis-runs → not ok");
    const e = r.stale.find((x) => x.path.endsWith("feature.yml"));
    assert.equal(e?.category, "workflows");
    assert.equal(e?.status, "drifted");
    assert.equal(e?.ownership, "forge-owned");
    assert.equal(e?.coupling, "executable");
  } finally {
    cleanup();
  }
});

// FG-579: forge-* skills install OUTSIDE $FORGE_HOME (into the Claude Code skills
// dir), so before this ticket SEED_SPECS could not see them and a drifted skill
// produced NO entry — the exact coverage gap the finding names. They are
// forge-owned (upgrade converges them) but PROSE, so drift is a reported warning,
// not a hard readiness fail.
test("detectSeedDrift: a drifted forge-* SKILL is reported (forge-owned + prose), keeps ok=true", () => {
  const root = mkdtempSync(join(tmpdir(), "seed-drift-skills-"));
  const repo = join(root, "seeds");
  const home = join(root, "forge-home");
  const skills = join(root, "claude-skills");
  try {
    mkdirSync(join(repo, "skills", "forge-review-loop"), { recursive: true });
    mkdirSync(join(skills, "forge-review-loop"), { recursive: true });
    writeFileSync(join(repo, "skills", "forge-review-loop", "SKILL.md"), "v2 guidance\n");
    writeFileSync(join(skills, "forge-review-loop", "SKILL.md"), "v1 guidance\n"); // stale

    const r = detectSeedDrift(repo, home, skills);
    assert.equal(r.ok, true, "prose skill drift is a warning, not a readiness fail");
    const e = r.stale.find((x) => x.path.endsWith("forge-review-loop/SKILL.md"));
    assert.equal(e?.category, "skills");
    assert.equal(e?.status, "drifted");
    assert.equal(e?.ownership, "forge-owned");
    assert.equal(e?.coupling, "prose");

    // forge-owned drift names forge upgrade as the converging remedy even though
    // it is prose — the [warn]/[FAIL] mark is coupling, the remedy is ownership.
    const section = renderSeedDrift(r);
    assert.match(section, /\[warn\]/);
    assert.match(section, /Forge-owned seeds \(skills\)/);
    assert.match(section, /forge upgrade/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectSeedDrift: a missing installed runtime is reported missing", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-oauth.yml"), "kind: pi\n");
    const r = detectSeedDrift(repo, home); // not installed in home
    assert.equal(r.ok, false);
    assert.equal(r.stale.find((x) => x.path.endsWith("pi-oauth.yml"))?.status, "missing");
  } finally {
    cleanup();
  }
});

test("detectSeedDrift: drifted PROSE seed warns but keeps ok=true", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "constraints", "no-ai-attribution.md"), "rule v2\n");
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "rule v1\n"); // local/old
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, true); // prose drift alone is a warning, not a fail
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0]?.ownership, "operator-authored");
    assert.equal(r.stale[0]?.coupling, "prose");
  } finally {
    cleanup();
  }
});

test("renderSeedDrift: empty when nothing is stale; FAIL marker on runtime drift", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "a.yml"), "x\n");
    writeFileSync(join(home, "runtimes", "a.yml"), "x\n");
    assert.equal(renderSeedDrift(detectSeedDrift(repo, home)), "");

    writeFileSync(join(home, "runtimes", "a.yml"), "y\n"); // now drifted
    const section = renderSeedDrift(detectSeedDrift(repo, home));
    assert.match(section, /Seed drift/);
    assert.match(section, /\[FAIL\]/);
    assert.match(section, /forge upgrade/);
  } finally {
    cleanup();
  }
});

// ─────────── FG-577 (criterion 4): the DETECTOR's baseline is release-owned ───────────
//
// seed-drift.ts:56 used to short-circuit on FORGE_REPO_DIR BEFORE the
// module-relative resolution, so a divergent or hostile ambient environment
// re-pointed the detector's own evidence and drift reported "current" against
// caller-chosen bytes — silently. The bytes are the evidence (FG-571), so the
// bytes compared AGAINST must be the executing release's own.

test("FG-577: a divergent FORGE_REPO_DIR does not redirect the detector's baseline", () => {
  const hostile = mkdtempSync(join(tmpdir(), "fg577-hostile-seeds-"));
  const home = mkdtempSync(join(tmpdir(), "fg577-forge-home-"));
  const before = process.env.FORGE_REPO_DIR;
  try {
    // A tree the caller controls, and an installed ~/.forge that matches it
    // exactly. Under the old short-circuit this pair is self-consistent, so the
    // detector declares the install "current" while never having compared it
    // against a single byte the running code actually ships.
    mkdirSync(join(hostile, "seeds", "runtimes"), { recursive: true });
    writeFileSync(join(hostile, "seeds", "runtimes", "planted.yml"), "provider: attacker\n");
    mkdirSync(join(home, "runtimes"), { recursive: true });
    writeFileSync(join(home, "runtimes", "planted.yml"), "provider: attacker\n");

    process.env.FORGE_REPO_DIR = hostile;
    assert.notEqual(defaultRepoSeedsDir(), join(hostile, "seeds"), "the baseline must not follow the ambient env");
    assert.equal(defaultRepoSeedsDir(), join(assetRoot(), "seeds"), "the baseline is the executing tree's own seeds");

    const report = detectSeedDrift(defaultRepoSeedsDir(), home);
    const planted = report.entries.find((e) => e.path === join("runtimes", "planted.yml"));
    assert.equal(planted, undefined, "the caller-chosen tree contributes no entries at all");
    assert.equal(
      report.ok,
      false,
      "a ~/.forge holding only planted bytes is stale against the real seeds — reporting it clean is the silent failure",
    );
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(hostile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
