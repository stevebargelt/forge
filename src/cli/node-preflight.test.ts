import { test } from "node:test";
import assert from "node:assert/strict";
// Importing this module runs applyNodePreflight() once at load. The test runner
// is on Node >=24 (the repo requirement), so the live check passes and does not
// exit — the cases below exercise the pure function across versions.
import { checkNodeVersion, REQUIRED_NODE_MAJOR } from "./node-preflight.js";

test("checkNodeVersion: too-old Node fails with an actionable message", () => {
  const r = checkNodeVersion("20.18.2");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /requires Node >=24/);
    assert.match(r.message, /you're on Node 20\.18\.2/);
    assert.match(r.message, /nvm use 24/);
  }
});

test("checkNodeVersion: a leading 'v' prefix is tolerated", () => {
  assert.equal(checkNodeVersion("v20.18.2").ok, false);
});

test("checkNodeVersion: the required major passes", () => {
  assert.equal(checkNodeVersion(`${REQUIRED_NODE_MAJOR}.17.0`).ok, true);
});

test("checkNodeVersion: a newer major passes (minimum-major guard)", () => {
  assert.equal(checkNodeVersion(`${REQUIRED_NODE_MAJOR + 1}.0.0`).ok, true);
});

test("checkNodeVersion: an unparseable version fails open (ok)", () => {
  assert.equal(checkNodeVersion("not-a-version").ok, true);
});

test("checkNodeVersion: honors an explicit requiredMajor argument", () => {
  assert.equal(checkNodeVersion("22.0.0", 24).ok, false);
  assert.equal(checkNodeVersion("22.0.0", 20).ok, true);
});
