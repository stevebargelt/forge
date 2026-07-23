// FG-579 under FG-583: a HOST workflow that drifted from this release's shipped seed
// must never silently mis-run on the consume path.
//
// FG-579 originally enforced this by byte-comparing the FLAT $FORGE_HOME/workflows
// against the release baseline at load time. FG-583 SUBSUMES that: dispatch reads ONLY
// a published seed generation — the flat layout is no longer a dispatch source at all —
// so a drifted flat workflow is refused WHOLESALE (no complete generation), a strictly
// stronger guarantee than the per-file drift measure. Drift WITHIN a published
// generation (a file hand-edited inside the generation dir) is still caught, by the
// generation's OWN provenance manifest. A PROJECT override remains intentional
// specialization and is never refused.
//
// SAFETY: every test uses a per-test mkdtemp FORGE_HOME; the real ~/.forge is never
// touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow, loadWorkflowWithSource } from "./loader.js";
import { publishTestGeneration } from "./seed-generation.testkit.js";
import { resolveSeedGeneration } from "./seed-generation.js";

/** A schema-valid workflow body carrying `marker`, so two workflows that both load
 *  cleanly can still be byte-distinct — the drift is invisible to the schema. */
function validWorkflow(name: string, marker: string): string {
  return `name: ${name}\ndescription: ${marker}\ninputs: []\nsteps:\n  - { id: build, agent: engineer, gate: auto }\n`;
}

let originalForgeHome: string | undefined;
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "fg579-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg579-proj-"));
  process.env.FORGE_HOME = homeDir;
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  for (const d of [homeDir, projectDir]) rmSync(d, { recursive: true, force: true });
});

// ─────────── The silent mis-run is structurally impossible under FG-583 ───────────

test("FG-579/FG-583: a drifted FLAT host workflow does not dispatch — no published generation refuses wholesale", () => {
  // A schema-valid but drifted copy of a shipped workflow, on the FLAT layout with NO
  // generation published. Pre-FG-579 this loaded and mis-ran; pre-FG-583 it was refused
  // as drift. Now the flat layout is not a dispatch source at all, so it is refused
  // wholesale — the silent mis-run cannot happen.
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(join(homeDir, "workflows", "feature.yml"), validWorkflow("feature", "STALE HAND-EDIT"));

  for (const load of [() => loadWorkflow("feature"), () => loadWorkflowWithSource("feature")]) {
    let err: unknown;
    try {
      load();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "a flat host workflow must be refused, not returned");
    assert.match((err as Error).message, /no complete seed generation|forge upgrade/, "the refusal names the repair");
  }
});

test("FG-579/FG-583: drift WITHIN a published generation is refused by the generation's own manifest", () => {
  // Publish a complete generation carrying feature.yml, then hand-edit the file INSIDE
  // the generation dir so its bytes no longer match the manifest — a torn/mid-publish
  // state no release shipped. The consume path refuses it, naming the generation.
  const gen = publishTestGeneration(homeDir, { workflows: { feature: validWorkflow("feature", "release bytes") } });
  writeFileSync(join(gen.root, "workflows", "feature.yml"), validWorkflow("feature", "STALE HAND-EDIT inside the generation"));

  let err: unknown;
  try {
    loadWorkflow("feature", { seedGeneration: gen });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "a generation-internal drift must be refused");
  const msg = (err as Error).message;
  assert.match(msg, /does not match its published seed generation|mixed\/incomplete/, "the refusal names the generation mismatch");
  assert.match(msg, /forge upgrade/, "the refusal names the remedy");
});

test("FG-579: a PROJECT override is intentional specialization — NEVER refused", () => {
  // A published generation ships feature; a project override differs. The override is
  // the operator deliberately specializing, so dispatch loads it — unrefused.
  publishTestGeneration(homeDir, { workflows: { feature: validWorkflow("feature", "release bytes") } });
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "workflows", "feature.yml"), validWorkflow("feature", "PROJECT SPECIALIZATION"));

  const wf = loadWorkflow("feature", { projectDir });
  assert.equal(wf.description, "PROJECT SPECIALIZATION", "the project override loads, unrefused");
  const withSrc = loadWorkflowWithSource("feature", { projectDir });
  assert.equal(withSrc.source, "project");
});

test("FG-579: a project override is honored even with NO generation published (never refused)", () => {
  // No generation at all: the host workspace refuses, but a project override still
  // loads — a project symbol is never gated on the host seed surface.
  assert.equal(resolveSeedGeneration(homeDir), null, "precondition: nothing published");
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "workflows", "bespoke.yml"), validWorkflow("bespoke", "operator's own workflow"));

  const wf = loadWorkflow("bespoke", { projectDir });
  assert.equal(wf.name, "bespoke");
});
