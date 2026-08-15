/**
 * FG-546 (AC9): the docs-surfaces migration-safety matrix, end-to-end across
 * BOTH provisioning entry points — `forge init` and `forge upgrade`.
 *
 * WHY THIS FILE EXISTS. Steps 4/5 own the per-command tests (init.*.test.ts,
 * upgrade.*.test.ts). This file is the cross-cutting SAFETY matrix the plan
 * calls the load-bearing deliverable: it drives the six AC9 scenarios through
 * the REAL command flows and then re-reads the result through the SAME
 * production resolver dispatch uses (loadOperatorSurfaces /
 * resolveDocsSurfacesReceipt in src/v2/contract.ts). A schema-only re-check
 * would not prove the seed forge SHIPS resolves clean, and a copy of the
 * classifier would not prove the write side-effect keys off the verdict — so
 * every scenario binds to the real loader.
 *
 * The two entry points are exercised with the same scenario table so a fix that
 * lands in init but not upgrade (or vice-versa) fails here:
 *   - init  is driven as a real subprocess (`forge init` via tsx), like
 *     init.integration.test.ts — the true CLI wiring.
 *   - upgrade is driven in-process via runUpgrade() against a disposable assets
 *     tree with a chdir'd project, like upgrade.integration.test.ts. Steps 1-3
 *     (git/npm/asset-install) are skipped or degrade to no-ops; only the [4/4]
 *     project-init docs-surfaces sub-step is under test. FORGE_HOME is the
 *     suite's disposable temp dir (src/test-setup.ts) — nothing here touches the
 *     real ~/.forge.
 *
 * The six AC9 scenarios: (a) fresh provisioning → production-valid; (b) exact
 * legacy-template migration → corrected form; (c) idempotent rerun; (d)
 * customized-VALID (Pixtron-shape) preserved unchanged; (e) customized-INVALID
 * preserved + actionable warning (never clobbered); (f) production fallback —
 * asserted inline in every scenario by routing the on-disk result through the
 * real resolver.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runUpgrade } from "./upgrade.js";
import {
  OPERATOR_SURFACES,
  classifyDocsSurfaces,
  loadOperatorSurfaces,
  resolveDocsSurfacesReceipt,
} from "../../v2/contract.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg546-migration-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

// The EXACT legacy object template forge's own seed used to emit (pre-FG-546).
// The migration path recognizes this structural shape and regenerates it to the
// corrected form; nothing else invalid may be mistaken for it.
const LEGACY_DOCS_SURFACES_YAML = [
  "# docs surfaces",
  "surfaces:",
  "  - name: readme",
  "    kind: user-facing",
  "    path: README.md",
  "  - name: api-reference",
  "    kind: public-api",
  "    path: docs/api.md",
  "",
].join("\n");

// A customized VALID file (the Pixtron shape): a hand-authored string list that
// already conforms to the production schema. Must survive byte-for-byte.
const CUSTOMIZED_VALID_YAML = [
  "# my project's own operator surfaces",
  "surfaces:",
  "  - src/mine/",
  "  - config/app.ts",
  "",
].join("\n");
const CUSTOMIZED_VALID_SURFACES = ["src/mine/", "config/app.ts"];

// A customized INVALID file: hand-authored, schema-invalid, and NOT the exact
// legacy template (one entry, renamed keys). It must be treated as operator-
// authored — never clobbered — and flagged with an actionable warning.
const CUSTOMIZED_INVALID_YAML = [
  "# my own broken attempt",
  "surfaces:",
  "  - label: only-one",
  "    path: README.md",
  "",
].join("\n");

// A CLAUDE.md carrying the orchestrator markers so `forge upgrade` recognizes
// the cwd as a forge project and runs its [4/4] project-init block.
const FORGE_CLAUDE_MD = [
  "# test project",
  "",
  "<!-- forge:orchestrator-start -->",
  "# forge orchestrator",
  "old body",
  "<!-- forge:orchestrator-end -->",
  "",
].join("\n");

const docsSurfacesPath = () => join(projectDir, ".forge", "docs-surfaces.yml");

function writeDocsSurfaces(content: string): string {
  const p = docsSurfacesPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function readDocsSurfaces(): string {
  return readFileSync(docsSurfacesPath(), "utf8");
}

// ── Entry-point drivers ─────────────────────────────────────────────────────

interface EntryResult {
  /** stdout + stderr combined — the surface the operator reads. */
  output: string;
}

interface Entry {
  name: "init" | "upgrade";
  run: () => EntryResult;
}

/** Drive `forge init` as a real subprocess against `projectDir`. */
function initEntry(): EntryResult {
  const res = spawnSync(tsx, withAuthorityTestkit(entry, ["init", "--project", projectDir, "--no-install-hooks"]), {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
  assert.equal(res.status, 0, `forge init failed: ${res.stderr}`);
  return { output: `${res.stdout}\n${res.stderr}` };
}

/** runUpgrade reports failure via process.exitCode; a leaked value would fail
 *  the whole file. Capture + restore the process's own around a run. */
function captureExit(fn: () => void): void {
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    fn();
  } finally {
    process.exitCode = before;
  }
}

/** A minimal disposable assets tree: just the orchestrator template. No
 *  install-seeds.sh on purpose — the [3/4] asset install degrades to NOT FOUND
 *  and the seed-generation publish never runs, so this driver mutates nothing in
 *  FORGE_HOME. The docs-surfaces seed itself resolves from the executing source
 *  tree (the real corrected seed), not from here. */
function makeAssetsTree(): string {
  const base = mkdtempSync(join(tmpdir(), "fg546-assets-"));
  mkdirSync(join(base, "seeds"), { recursive: true });
  writeFileSync(
    join(base, "seeds", "orchestrator-template.md"),
    ["<!-- forge:orchestrator-start -->", "# forge orchestrator", "release body", "<!-- forge:orchestrator-end -->", ""].join("\n"),
  );
  return base;
}

/** Drive the real `forge upgrade` [4/4] project-init path in-process against a
 *  chdir'd `projectDir`. Steps 1-2 (git/npm) are skipped; the docs-surfaces
 *  sub-step is what runs. */
function upgradeEntry(): EntryResult {
  // A forge project the [4/4] block recognizes.
  if (!existsSync(join(projectDir, "CLAUDE.md"))) {
    writeFileSync(join(projectDir, "CLAUDE.md"), FORGE_CLAUDE_MD);
  }
  const assets = makeAssetsTree();
  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  const cwdBefore = process.cwd();
  try {
    process.chdir(projectDir);
    captureExit(() => {
      runUpgrade(
        { skipGit: true, skipNpm: true },
        { mode: "dev", assetsDir: assets, devDir: assets },
      );
    });
  } finally {
    process.chdir(cwdBefore);
    console.log = realLog;
    console.warn = realWarn;
    rmSync(assets, { recursive: true, force: true });
  }
  return { output: lines.join("\n") };
}

const ENTRIES: Entry[] = [
  { name: "init", run: initEntry },
  { name: "upgrade", run: upgradeEntry },
];

// ── Shared production-resolver assertions ───────────────────────────────────

/** After a create/migrate/preserve of a VALID file, the on-disk result must
 *  resolve through the REAL production resolver as source:project with no
 *  warning, and loadOperatorSurfaces must return the file's own values. */
function assertResolvesAsProject(expectedSurfaces: readonly string[]): void {
  assert.equal(classifyDocsSurfaces(projectDir).verdict, "valid-project");
  const { receipt, warning } = resolveDocsSurfacesReceipt(projectDir);
  assert.equal(receipt.source, "project", "a valid project file must resolve as source:project");
  assert.equal(warning, undefined, "a valid project file must not warn");
  assert.deepEqual(loadOperatorSurfaces(projectDir), expectedSurfaces);
}

/** After forge declines to clobber a customized-invalid file, the read/dispatch
 *  surface must stay FAIL-SOFT: warn + fall back to the built-in OPERATOR_SURFACES
 *  (never crash a read-only diagnostic). */
function assertFailsSoftToBuiltIn(): void {
  assert.equal(classifyDocsSurfaces(projectDir).verdict, "customized-invalid");
  const { receipt, warning } = resolveDocsSurfacesReceipt(projectDir);
  assert.equal(receipt.source, "built-in", "an invalid project file must fall back to built-in defaults");
  assert.match(warning ?? "", /invalid/i, "the receipt must carry a warning naming it invalid");
  assert.deepEqual(loadOperatorSurfaces(projectDir), OPERATOR_SURFACES, "the loader falls back to forge's built-in surfaces");
}

// ── The matrix, run against BOTH entry points ───────────────────────────────

for (const ep of ENTRIES) {
  // (a) Fresh provisioning yields a production-valid file.
  test(`FG-546/${ep.name}: (a) fresh provisioning yields a production-valid docs-surfaces.yml`, () => {
    assert.equal(classifyDocsSurfaces(projectDir).verdict, "missing", "precondition: no file yet");

    const { output } = ep.run();
    assert.match(output, /docs-surfaces(\.yml)?:\s*created/i, "the entry must report it created the file");

    // The provisioned seed is the corrected string-list shape, resolving clean.
    const created = classifyDocsSurfaces(projectDir);
    assert.equal(created.verdict, "valid-project");
    const surfaces = loadOperatorSurfaces(projectDir);
    assert.ok(surfaces.includes("src/cli/"), `the seed's operator path prefixes must load — got ${JSON.stringify(surfaces)}`);
    // A project override REPLACES the built-in list, so the resolved set is the
    // seed's shorter list, not the 16-entry forge default — that distinguishes a
    // real source:project load from a silent fallback.
    assert.notEqual(surfaces.length, OPERATOR_SURFACES.length, "the loaded set is the seed's, not the built-in fallback");
    const { receipt, warning } = resolveDocsSurfacesReceipt(projectDir);
    assert.equal(receipt.source, "project");
    assert.equal(warning, undefined, "no invalid-config warning for the corrected seed");
  });

  // (b) Exact legacy-template migration to the corrected form.
  test(`FG-546/${ep.name}: (b) MIGRATES the exact known legacy object template to the corrected form`, () => {
    const p = writeDocsSurfaces(LEGACY_DOCS_SURFACES_YAML);
    assert.equal(classifyDocsSurfaces(projectDir).verdict, "known-legacy-generated", "precondition: recognized legacy shape");

    const { output } = ep.run();
    assert.match(output, /docs-surfaces(\.yml)?:\s*migrated/i, "the entry must report it migrated the legacy template");

    const after = readFileSync(p, "utf8");
    assert.ok(!after.includes("kind:"), "the legacy object entries must be gone");
    assert.ok(!after.includes("name: readme"), "the legacy object entries must be gone");
    // The migrated form resolves clean through the production resolver.
    assertResolvesAsProject(loadOperatorSurfaces(projectDir));
    assert.ok(loadOperatorSurfaces(projectDir).includes("src/cli/"), "migrated to the corrected seed's surfaces");
  });

  // (c) Idempotent rerun: the corrected form is a clean no-op, never re-migrated.
  test(`FG-546/${ep.name}: (c) rerun on the corrected form is an idempotent no-op`, () => {
    writeDocsSurfaces(LEGACY_DOCS_SURFACES_YAML);
    ep.run(); // migrate
    const afterMigrate = readDocsSurfaces();
    assert.equal(classifyDocsSurfaces(projectDir).verdict, "valid-project");

    const { output } = ep.run(); // rerun
    assert.match(output, /docs-surfaces(\.yml)?:\s*already exists/i, "the rerun must report a preserve no-op");
    assert.equal(readDocsSurfaces(), afterMigrate, "no re-migration on rerun — bytes are unchanged");
    assert.equal(classifyDocsSurfaces(projectDir).verdict, "valid-project");
  });

  // (d) Customized-VALID (Pixtron-shape) preserved unchanged.
  test(`FG-546/${ep.name}: (d) a customized-VALID (string-list) file is preserved byte-for-byte`, () => {
    const p = writeDocsSurfaces(CUSTOMIZED_VALID_YAML);
    assert.equal(classifyDocsSurfaces(projectDir).verdict, "valid-project", "precondition: valid operator file");

    const { output } = ep.run();
    assert.match(output, /docs-surfaces(\.yml)?:\s*already exists/i, "a valid operator file is a preserve no-op");
    assert.equal(readFileSync(p, "utf8"), CUSTOMIZED_VALID_YAML, "a valid operator file must never be rewritten");
    // The operator's own surfaces resolve — forge did not substitute its defaults.
    assertResolvesAsProject(CUSTOMIZED_VALID_SURFACES);
  });

  // (e) Customized-INVALID preserved + actionable warning (never clobbered).
  test(`FG-546/${ep.name}: (e) a customized-INVALID file is NEVER clobbered and draws an actionable warning`, () => {
    const p = writeDocsSurfaces(CUSTOMIZED_INVALID_YAML);
    assert.equal(classifyDocsSurfaces(projectDir).verdict, "customized-invalid", "precondition: hand-authored invalid, not the legacy template");

    const { output } = ep.run();
    // Byte-for-byte survival is the crux of the never-clobber invariant.
    assert.equal(readFileSync(p, "utf8"), CUSTOMIZED_INVALID_YAML, "a customized-invalid file must survive byte-for-byte");
    // The write surface flags it as invalid with an actionable warning naming the
    // file and the repair action (never a silent skip).
    assert.match(output, /docs-surfaces(\.yml)?:\s*INVALID/i, "the write surface flags the file as invalid");
    assert.match(output, /docs-surfaces\.yml/, "the warning names the file");
    assert.match(output, /repair|re-run|forge init|forge upgrade/i, "the warning names the repair action");
    // And the read/dispatch surface stays fail-soft against the built-in defaults.
    assertFailsSoftToBuiltIn();
  });
}

// ── (f) Production fallback, stated once as its own guard ────────────────────
//
// The inline assertions above already route every write outcome through the
// production resolver. This case states the fallback contract directly, and
// independent of any command run, so a regression in the resolver's fail-soft
// behavior is caught even if both command paths change.

test("FG-546: (f) production fallback — a valid project file is source:project; a customized-invalid file warns + falls back to built-in", () => {
  // Valid → source:project, no warning, the file's own surfaces.
  writeDocsSurfaces(CUSTOMIZED_VALID_YAML);
  assertResolvesAsProject(CUSTOMIZED_VALID_SURFACES);

  // Customized-invalid → built-in fallback + warning; the read surface never crashes.
  writeDocsSurfaces(CUSTOMIZED_INVALID_YAML);
  assertFailsSoftToBuiltIn();

  // Absent → the built-in defaults, cleanly (no file, no warning).
  rmSync(docsSurfacesPath());
  assert.equal(classifyDocsSurfaces(projectDir).verdict, "missing");
  const { receipt, warning } = resolveDocsSurfacesReceipt(projectDir);
  assert.equal(receipt.source, "built-in");
  assert.equal(warning, undefined);
  assert.deepEqual(loadOperatorSurfaces(projectDir), OPERATOR_SURFACES);
});
