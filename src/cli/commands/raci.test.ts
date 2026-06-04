// `forge raci validate` command tests (#277) — the fs-aware wrapper + render.
// The pure lint is covered in src/raci/validate.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRaciFile, renderHuman } from "./raci.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "..", "seeds", "forge-raci.md");

test("validateRaciFile lints the real seed clean", () => {
  const v = validateRaciFile(SEED_PATH);
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("a missing file is a structured finding, not a crash", () => {
  const v = validateRaciFile(join(HERE, "does-not-exist.md"));
  assert.equal(v.ok, false);
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0]!.code, "file_not_found");
});

test("renderHuman: clean vs findings", () => {
  const clean = renderHuman("/x/forge-raci.md", { ok: true, findings: [] });
  assert.match(clean, /OK/);

  const bad = renderHuman("/x/forge-raci.md", {
    ok: false,
    findings: [{ code: "informed_unknown", route: "bug_fix", message: "bad target" }],
  });
  assert.match(bad, /informed_unknown/);
  assert.match(bad, /route: bug_fix/);
});
