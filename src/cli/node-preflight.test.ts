import { test } from "node:test";
import assert from "node:assert/strict";
// Importing this module runs applyNodePreflight() once at load. The test runner is
// on the repo's pinned Node, so the live check passes and does not exit — the cases
// below exercise the pure function across ABIs.
import { checkAbi, resolveExpectedAbi, REQUIRED_ABI } from "./node-preflight.js";

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

test("checkAbi: an undeterminable expected ABI is a BLOCK, not fail-open", () => {
  // An ABI we never determined is not evidence that this interpreter can load the
  // binding. Passing here would start the CLI and hand the operator the opaque
  // native-loader crash the preflight exists to preempt.
  for (const expected of ["", "   ", "not-an-abi"]) {
    const r = checkAbi("137", expected);
    assert.equal(r.ok, false, `expected ABI ${JSON.stringify(expected)} must refuse`);
    if (!r.ok) {
      assert.match(r.message, /cannot determine the ABI/);
      assert.doesNotMatch(r.message, OPAQUE);
    }
  }
});

test("checkAbi: an unreadable ACTUAL ABI against a known expected is a block", () => {
  // A known expected vs a value that is not that ABI is a real mismatch — refuse,
  // without claiming a direction.
  const r = checkAbi("", "137");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /different ABI/);
    assert.doesNotMatch(r.message, OPAQUE);
  }
});

test("resolveExpectedAbi: no manifest (a dev checkout) uses the pinned constant", () => {
  const r = resolveExpectedAbi({ kind: "none" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.abi, REQUIRED_ABI);
});

test("resolveExpectedAbi: a release's stated ABI wins over the pinned constant", () => {
  const r = resolveExpectedAbi({ kind: "release", manifest: { abi: "147" }, releaseDir: "/opt/forge" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.abi, "147");
});

test("resolveExpectedAbi: a numeric (unquoted) manifest abi is coerced, not refused", () => {
  // A hand-written manifest's `"abi": 137` arrives as a number — genuinely compatible
  // on an ABI-137 interpreter, so it must RUN.
  const r = resolveExpectedAbi({ kind: "release", manifest: { abi: 137 }, releaseDir: "/opt/forge" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.abi, "137");
});

test("resolveExpectedAbi: a MALFORMED manifest is refused BY NAME — never the dev fallback", () => {
  // A present-but-unparseable manifest used to collapse into "no manifest" and take the
  // REQUIRED_ABI path, so a release whose shipped binding needs a different ABI than the
  // dev pin was waved through to the native loader on a matching dev interpreter.
  const r = resolveExpectedAbi({ kind: "malformed", releaseDir: "/opt/forge", error: "Unexpected token }" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /manifest is unreadable/);
    assert.match(r.message, /\/opt\/forge\/forge-release\.json/); // named, so it's actionable
    assert.match(r.message, /Unexpected token \}/); // the parse error, quoted back
    assert.doesNotMatch(r.message, OPAQUE);
  }
});

test("resolveExpectedAbi: a release with an unusable ABI is refused BY NAME, never fallen back", () => {
  // The fail-open this replaced: an unreadable release ABI silently became REQUIRED_ABI
  // (or passed), so a mismatched interpreter started and died in the native loader.
  // The pinned dev constant is not evidence about a release's own shipped binding.
  for (const abi of [undefined, null, "", "   ", "not-an-abi", {}]) {
    const r = resolveExpectedAbi({ kind: "release", manifest: { abi }, releaseDir: "/opt/forge" });
    assert.equal(r.ok, false, `manifest abi ${JSON.stringify(abi) ?? "undefined"} must refuse`);
    if (!r.ok) {
      assert.match(r.message, /does not state a usable ABI/);
      assert.match(r.message, /\/opt\/forge\/forge-release\.json/); // named, so it's actionable
      assert.doesNotMatch(r.message, OPAQUE);
    }
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
