import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDefaultDesignDir, defaultPenFileName } from "./new.js";

// #67: design-touching workflows default --design-dir to <projectDir>/designs/
// (per-project shared corpus), replacing the prior ~/code/<sanitized-title>/
// per-run convention. Non-design workflows still get no default.

test("deriveDefaultDesignDir: returns <projectDir>/designs for ui-design workflow", () => {
  assert.equal(
    deriveDefaultDesignDir("ui-design", "/Users/x/code/forge"),
    "/Users/x/code/forge/designs",
  );
});

test("deriveDefaultDesignDir: returns <projectDir>/designs for ui-design-revise workflow", () => {
  assert.equal(
    deriveDefaultDesignDir("ui-design-revise", "/Users/x/code/dashboard"),
    "/Users/x/code/dashboard/designs",
  );
});

test("deriveDefaultDesignDir: returns <projectDir>/designs for feature-ui-design-needed workflow", () => {
  assert.equal(
    deriveDefaultDesignDir("feature-ui-design-needed", "/Users/x/code/myapp"),
    "/Users/x/code/myapp/designs",
  );
});

test("deriveDefaultDesignDir: returns undefined for non-design workflows", () => {
  assert.equal(deriveDefaultDesignDir("feature", "/Users/x/code/forge"), undefined);
  assert.equal(deriveDefaultDesignDir("investigation", "/Users/x/code/forge"), undefined);
  assert.equal(deriveDefaultDesignDir("audit", "/Users/x/code/forge"), undefined);
});

test("deriveDefaultDesignDir: invariant — the default ALWAYS lands inside projectDir (no per-run drift)", () => {
  // The whole point of #67: every design run for the same project shares one
  // corpus. Two invocations with different titles must produce the same dir.
  const a = deriveDefaultDesignDir("ui-design", "/Users/x/code/forge");
  const b = deriveDefaultDesignDir("ui-design", "/Users/x/code/forge");
  assert.equal(a, b);
  assert.match(a ?? "", /\/Users\/x\/code\/forge\/designs$/);
});

test("defaultPenFileName: uses basename of projectDir", () => {
  assert.equal(defaultPenFileName("/Users/x/code/forge"), "forge.pen");
  assert.equal(defaultPenFileName("/Users/x/code/my-dashboard"), "my-dashboard.pen");
  assert.equal(defaultPenFileName("/tmp/scratch"), "scratch.pen");
});

test("defaultPenFileName: handles trailing slash gracefully", () => {
  assert.equal(defaultPenFileName("/Users/x/code/forge/"), "forge.pen");
});
