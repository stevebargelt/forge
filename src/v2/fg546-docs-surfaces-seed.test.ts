import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  loadOperatorSurfaces,
  resolveDocsSurfacesReceipt,
  OPERATOR_SURFACES,
} from "./contract.js";

// ------------------------------------------------------------------
// FG-546 (AC3): the BUNDLED seed must resolve through the SAME production
// loader dispatch uses. FG-308/FG-332 shipped seeds/docs-surfaces.example.yml
// with no test that routed it through loadOperatorSurfaces — so the seed drifted
// to a schema-invalid object shape that the loader silently rejected and replaced
// with built-in defaults. This test binds the on-disk seed to the REAL resolver
// (loadOperatorSurfaces / resolveDocsSurfacesReceipt), not a schema-only copy, so
// any regression to a schema-invalid shape fails here.
// ------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_SEED = join(repoRoot, "seeds", "docs-surfaces.example.yml");

/** Provision the bundled seed into a fresh temp project exactly as init/upgrade
 *  do — copy the seed bytes to <project>/.forge/docs-surfaces.yml. */
function provisionSeed(projectDir: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  copyFileSync(BUNDLED_SEED, join(projectDir, ".forge", "docs-surfaces.yml"));
}

/** Run `fn`, returning any console.warn messages it emitted. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-fg546-seed-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("bundled seed exists and parses to a non-empty string-list of path prefixes", () => {
  const parsed = parseYaml(readFileSync(BUNDLED_SEED, "utf8"));
  assert.ok(parsed && typeof parsed === "object", "seed must parse to an object");
  const surfaces = (parsed as { surfaces?: unknown }).surfaces;
  assert.ok(Array.isArray(surfaces) && surfaces.length > 0, "surfaces must be a non-empty array");
  for (const s of surfaces) {
    assert.equal(typeof s, "string", "each surface must be a string, not an object");
    assert.ok((s as string).length > 0, "each surface must be a non-empty string");
  }
});

test("loadOperatorSurfaces resolves the bundled seed's values (source:project, not fallback)", () => {
  provisionSeed(dir);
  const expected = (parseYaml(readFileSync(BUNDLED_SEED, "utf8")) as { surfaces: string[] }).surfaces;

  const warnings = captureWarnings(() => {
    const surfaces = loadOperatorSurfaces(dir);
    // Bound to the REAL loader — the seed's own values, in order.
    assert.deepEqual(surfaces, expected);
    // It must NOT have silently fallen back to forge's built-in defaults. If the
    // seed regressed to a schema-invalid shape, loadOperatorSurfaces returns
    // OPERATOR_SURFACES instead — this guards exactly that regression.
    assert.notDeepEqual(surfaces, OPERATOR_SURFACES);
  });
  assert.deepEqual(warnings, [], `no invalid-config warning expected, got: ${warnings.join(" | ")}`);
});

test("resolveDocsSurfacesReceipt reports source:project with no warning for the bundled seed", () => {
  provisionSeed(dir);
  const { receipt, warning } = resolveDocsSurfacesReceipt(dir);
  assert.equal(receipt.source, "project");
  assert.equal(receipt.path, join(dir, ".forge", "docs-surfaces.yml"));
  assert.equal(warning, undefined, `no invalid-config warning expected, got: ${warning}`);
});
