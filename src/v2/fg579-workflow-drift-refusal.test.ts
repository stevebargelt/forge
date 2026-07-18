// FG-579: a HOST workflow (~/.forge/workflows/<name>.yml) that has drifted from
// this release's shipped seed must be REFUSED on the consume path, by name.
//
// The production defect: an installed workflow can be stale-but-schema-valid — it
// parses, it validates, and `forge next` / a campaign then dispatches it silently
// against current code, running the wrong pipeline with no signal at all. `forge
// doctor` is the advisory (FG-335); this dispatch refusal is the enforcement.
//
// SAFETY: every test uses a per-test mkdtemp FORGE_HOME and a disposable fixture
// baseline; the real ~/.forge is never read or written. The `repoSeedsDir` seam
// (default defaultRepoSeedsDir(), assetRoot-derived and NON-redirectable) lets a
// test point the release baseline at a fixture WITHOUT promoting this host — the
// exact mirror of detectSeedDrift's repoSeedsDir parameter.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow, loadWorkflowWithSource } from "./loader.js";
import { defaultRepoSeedsDir } from "./seed-drift.js";
import { assetRoot } from "./asset-root.js";

/** A schema-valid workflow body carrying `marker`, so two workflows that both load
 *  cleanly can still be byte-distinct. The whole point of the ticket is that the
 *  drift is invisible to the schema — a stale workflow is a VALID workflow. */
function validWorkflow(name: string, marker: string): string {
  return `name: ${name}\ndescription: ${marker}\ninputs: []\nsteps:\n  - { id: build, agent: engineer, gate: auto }\n`;
}

let originalForgeHome: string | undefined;
let homeDir: string;
let baselineDir: string;
let projectDir: string;

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "fg579-home-"));
  baselineDir = mkdtempSync(join(tmpdir(), "fg579-baseline-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg579-proj-"));
  process.env.FORGE_HOME = homeDir;
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  mkdirSync(join(baselineDir, "workflows"), { recursive: true });
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  for (const d of [homeDir, baselineDir, projectDir]) rmSync(d, { recursive: true, force: true });
});

// ─────────────── THE REGRESSION: the silent mis-run, now refused ───────────────
//
// RED against pre-FG-579 code (loadWorkflow returned the drifted workflow with no
// refusal — a silent mis-run); GREEN after. Uses the DEFAULT baseline (the real
// shipped seeds/workflows/feature.yml), so it exercises the exact production
// resolution path with only the existing (name, ctx) signature — no injected seam.
// MUTATION-SENSITIVE: it goes red the instant assertWorkflowNotDrifted stops
// throwing, not merely when the file is absent.
test("FG-579: dispatching a drifted HOST workflow REFUSES, it does not silently mis-run", () => {
  // A schema-valid but drifted copy of a shipped workflow (`feature`), installed
  // at the workspace path. Pre-fix this loads and dispatches; that is the defect.
  writeFileSync(join(homeDir, "workflows", "feature.yml"), validWorkflow("feature", "STALE HAND-EDIT — not this release's feature"));

  let err: unknown;
  try {
    loadWorkflow("feature");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "a drifted host workflow must be refused, not returned");
  const msg = (err as Error).message;
  assert.match(msg, /feature/, "the refusal names the workflow");
  assert.match(msg, /drift/i, "the refusal states the installed workflow has drifted from this release");
  assert.match(msg, /forge upgrade/, "the refusal names the remedy");
  assert.match(msg, new RegExp(join(homeDir, "workflows", "feature.yml").replace(/[.]/g, "\\.")), "…and names the installed path");
  assert.match(msg, /install-seeds\.sh/, "…and the FORCE remedy");
});

test("FG-579: loadWorkflowWithSource refuses a drifted HOST workflow too", () => {
  writeFileSync(join(homeDir, "workflows", "feature.yml"), validWorkflow("feature", "STALE"));
  assert.throws(() => loadWorkflowWithSource("feature"), /drift/i);
});

// ─────────────── The four consume-path cases, hermetically, via the seam ───────

test("FG-579: byte-identical HOST workflow is admitted (no drift to measure)", () => {
  const body = validWorkflow("feature", "release bytes");
  writeFileSync(join(baselineDir, "workflows", "feature.yml"), body);
  writeFileSync(join(homeDir, "workflows", "feature.yml"), body); // identical bytes
  const wf = loadWorkflow("feature", {}, baselineDir);
  assert.equal(wf.name, "feature");
});

test("FG-579: HOST workflow drifted from the injected baseline refuses", () => {
  writeFileSync(join(baselineDir, "workflows", "feature.yml"), validWorkflow("feature", "release"));
  writeFileSync(join(homeDir, "workflows", "feature.yml"), validWorkflow("feature", "STALE")); // differs by one byte-run
  assert.throws(() => loadWorkflow("feature", {}, baselineDir), /drift/i);
});

test("FG-579: a PROJECT override is intentional specialization — NEVER refused", () => {
  // Host is drifted AND a project override differs from the baseline: the override
  // is the operator deliberately specializing, so dispatch must load it, not refuse.
  writeFileSync(join(baselineDir, "workflows", "feature.yml"), validWorkflow("feature", "release"));
  writeFileSync(join(homeDir, "workflows", "feature.yml"), validWorkflow("feature", "STALE HOST"));
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "workflows", "feature.yml"), validWorkflow("feature", "PROJECT SPECIALIZATION"));

  const wf = loadWorkflow("feature", { projectDir }, baselineDir);
  assert.equal(wf.description, "PROJECT SPECIALIZATION", "the project override loads, unrefused");
  const withSrc = loadWorkflowWithSource("feature", { projectDir }, baselineDir);
  assert.equal(withSrc.source, "project");
});

test("FG-579: a workflow the release does NOT ship has no baseline → admitted", () => {
  // baselineDir/workflows has no `bespoke.yml`, so there is no drift to measure.
  writeFileSync(join(homeDir, "workflows", "bespoke.yml"), validWorkflow("bespoke", "operator's own workflow"));
  const wf = loadWorkflow("bespoke", {}, baselineDir);
  assert.equal(wf.name, "bespoke");
});

// ─────────────── FG-577 property: the baseline is env-proof ────────────────────
//
// The refusal compares against the assetRoot-derived release baseline, which no
// ambient FORGE_REPO_DIR may redirect (FG-577). A hostile env pointed at a tree
// whose "seeds" MATCH the installed drift must NOT be able to launder the drifted
// workflow into looking current: the comparison still runs against the executing
// release's own shipped bytes.
test("FG-579: a hostile FORGE_REPO_DIR cannot defeat the refusal", () => {
  const hostile = mkdtempSync(join(tmpdir(), "fg579-hostile-"));
  const before = process.env.FORGE_REPO_DIR;
  try {
    // The hostile tree's seeds are byte-identical to the drifted install, so IF the
    // baseline followed FORGE_REPO_DIR the detector would call the install "current".
    const stale = validWorkflow("feature", "STALE HAND-EDIT — not this release's feature");
    mkdirSync(join(hostile, "seeds", "workflows"), { recursive: true });
    writeFileSync(join(hostile, "seeds", "workflows", "feature.yml"), stale);
    writeFileSync(join(homeDir, "workflows", "feature.yml"), stale);

    process.env.FORGE_REPO_DIR = hostile;
    // The baseline is unmoved: still the executing release's own seeds.
    assert.equal(defaultRepoSeedsDir(), join(assetRoot(), "seeds"), "FORGE_REPO_DIR must not steer the release baseline");
    // …and against the REAL shipped feature.yml, the planted bytes are still drift.
    assert.throws(() => loadWorkflow("feature"), /drift/i, "the env cannot launder drifted bytes into looking current");
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(hostile, { recursive: true, force: true });
  }
});
