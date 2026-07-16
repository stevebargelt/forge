import { test } from "node:test";
import assert from "node:assert/strict";
// Importing this module runs applyNodePreflight() once at load. The test runner is
// on the repo's pinned Node, so the live check passes and does not exit — the cases
// below exercise the pure function across ABIs.
import { checkAbi, REQUIRED_ABI } from "./node-preflight.js";

// The opaque native-loader text the whole preflight exists to PREEMPT. If any of
// this reaches the operator, better-sqlite3 loaded first and the guard lost.
const OPAQUE = /NODE_MODULE_VERSION|ERR_DLOPEN/;

test("checkAbi: the matching ABI passes", () => {
  assert.equal(checkAbi("137", "137").ok, true);
  assert.equal(checkAbi(REQUIRED_ABI, REQUIRED_ABI).ok, true);
});

test("checkAbi: a too-NEW ABI is refused by name (the case the old >= floor admitted)", () => {
  const r = checkAbi("147", "137");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /NEWER ABI \(147\)/);
    assert.match(r.message, /ABI 147/); // the running ABI, named
    assert.match(r.message, /ABI 137/); // the required ABI, named
    assert.match(r.message, new RegExp(`Node ${process.versions.node.replace(/\./g, "\\.")}`));
    assert.match(r.message, /nvm use/);
    assert.doesNotMatch(r.message, OPAQUE);
  }
});

test("checkAbi: a too-OLD ABI is refused by name", () => {
  const r = checkAbi("115", "137");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /OLDER ABI \(115\)/);
    assert.match(r.message, /ABI 115/);
    assert.match(r.message, /ABI 137/);
    assert.match(r.message, /nvm use/);
    assert.doesNotMatch(r.message, OPAQUE);
  }
});

test("checkAbi: an undeterminable expected ABI fails OPEN (ok)", () => {
  assert.equal(checkAbi("137", "").ok, true);
  assert.equal(checkAbi("137", "   ").ok, true);
  assert.equal(checkAbi("137", "not-an-abi").ok, true);
});

test("checkAbi: an unreadable ACTUAL ABI against a known expected is still a block, not fail-open", () => {
  // Fail-open is scoped to an expected ABI we could not read. A known expected vs a
  // value that is not that ABI is a real mismatch — refuse, without claiming a direction.
  const r = checkAbi("", "137");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /different ABI/);
    assert.doesNotMatch(r.message, OPAQUE);
  }
});

// MUTATION PROOF (the FG-570 red baseline, executed rather than asserted in prose).
// The pre-FG-570 gate was a minimum-major floor: `major >= requiredMajor` → ok. This
// reproduces that exact predicate over the same too-new input and shows it goes
// green-wrong where checkAbi refuses. If someone reverts the equality to a `>=`
// range compare, the too-new case stops refusing — which is what this pins.
test("MUTANT: the old >= floor admits the too-new ABI that checkAbi refuses (FG-570 red baseline)", () => {
  const oldFloor = (actual: string, expected: string): boolean =>
    Number.parseInt(actual, 10) >= Number.parseInt(expected, 10);

  assert.equal(oldFloor("147", "137"), true, "the old floor ADMITS ABI 147 — this is the defect");
  assert.equal(checkAbi("147", "137").ok, false, "the ABI equality REFUSES it");
  // Both agree on too-old; the floor's only correct case is the one it was built for.
  assert.equal(oldFloor("115", "137"), false);
  assert.equal(checkAbi("115", "137").ok, false);
});
