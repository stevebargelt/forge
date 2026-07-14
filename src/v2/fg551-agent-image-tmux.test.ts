// FG-551 regression guard: the agent image must ship tmux. `forge launch` owns
// long host-side commands under tmux (FG-535) and its launch tier drives the real
// tmux-owned path, so an image without tmux hard-fails 10 tests in every agent
// container — every suite looks red and a genuine tmux regression hides in the
// noise. Docker builds can't run in the unit tier, so this pins the image SPEC;
// the `tmux -V` smoke it requires is what fails the actual build.
//
// This guard is adversarial by construction: it parses the Dockerfile's
// INSTRUCTIONS, never its raw text. The first cut of it matched /tmux -V/ against
// the whole file, which the file's own comment ("`tmux -V` is a build-time smoke")
// satisfied all by itself — deleting the real `&& tmux -V` from the RUN layer left
// the guard green with no smoke in the build. Every assertion below therefore runs
// against comment-stripped, continuation-folded instructions scoped to the FINAL
// build stage, which is the only stage whose layers survive into the shipped image.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(join(root, "docker", "agent-dev-worker.Dockerfile"), "utf8");
const launchCliTests = readFileSync(join(root, "src", "v2", "launch-cli.integration.test.ts"), "utf8");

/**
 * The Dockerfile's real instructions: comments stripped (so prose about tmux can
 * never satisfy an assertion), backslash-continuations folded so each instruction
 * is one line, and — critically — scoped to the FINAL build stage.
 *
 * The final-stage scoping is what closes the multi-stage hole: `apt-get install
 * tmux` in a `FROM ubuntu AS builder` stage that the final stage only `COPY
 * --from=builder`s a few artifacts out of produces an image with NO tmux, while a
 * whole-file text search still finds the install line and reports green.
 */
function finalStageInstructions(): string[] {
  const folded = dockerfile
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line)) // drop comment lines before folding
    .join("\n")
    .replace(/\\\r?\n\s*/g, " ");

  const lines = folded
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const lastFrom = lines.reduce((idx, l, i) => (/^FROM\s/i.test(l) ? i : idx), -1);
  assert.ok(lastFrom >= 0, "the Dockerfile must have a FROM instruction");
  return lines.slice(lastFrom);
}

const runLayers = (): string[] => finalStageInstructions().filter((l) => /^RUN\s/i.test(l));

test("FG-551: the agent image apt-installs tmux in the stage that actually ships", () => {
  const layer = runLayers().find((l) => /apt-get install\b.*\btmux\b(?!-)/.test(l));
  assert.ok(
    layer,
    "an apt-get install layer in the FINAL build stage must install tmux — without it the FG-535 launch tier hard-fails in every agent container. " +
      "(Installing it in an earlier, discarded multi-stage stage does not count: those layers never reach the shipped image.)"
  );
  assert.match(layer, /rm -rf \/var\/lib\/apt\/lists\/\*/, "the tmux install layer must clean apt lists, per the file's convention");
});

test("FG-551: the image build smoke-checks tmux in a real RUN layer, so it cannot be built without one", () => {
  // Deliberately NOT a text search over the file. The Dockerfile's own comment
  // says "`tmux -V` is a build-time smoke", so /tmux -V/ against raw text passes
  // even with the actual smoke deleted. Only an executable RUN layer gates a build.
  const smoke = runLayers().find((l) => /(^|&&|;|\|\|)\s*tmux\s+-V\b/.test(l));
  assert.ok(
    smoke,
    "a RUN layer in the final stage must execute `tmux -V` — this is the smoke that FAILS THE BUILD when tmux is missing or broken. " +
      "A comment mentioning `tmux -V` is not a smoke; it gates nothing."
  );
});

test("FG-551: no later layer removes tmux back out of the image", () => {
  // The install can be perfectly intact and the shipped image still tmux-less: a
  // later cleanup/slimming layer that purges it, or an `rm` of the binary, leaves
  // both assertions above green. The build-time smoke does not catch this either
  // when the removal lands in a layer AFTER the smoke.
  for (const layer of runLayers()) {
    assert.doesNotMatch(
      layer,
      /apt-get\s+(?:remove|purge|autoremove)\b[^&|;]*\btmux\b|\brm\b[^&|;]*\btmux\b/,
      `a layer removes tmux after installing it — the image would ship without tmux and the FG-535 launch tier would hard-fail: ${layer}`
    );
  }
});

test("FG-551: the launch tier hard-fails on a tmux-less image rather than skipping", () => {
  // The ticket's key anti-regression property: "make it green by skipping" must
  // remain impossible. The assert must live in the file-wide `before` hook — a
  // hasTmux assert buried inside ONE test would let the other 9 pass on a
  // tmux-less image, which is exactly the silent-green outcome this guards.
  assert.match(
    launchCliTests,
    /before\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[^}]*assert\.ok\(hasTmux,/,
    "the launch tier's tmux precondition must be an assert inside its file-wide `before` hook — skipping (or gating only one test) is how a missing tmux would go unnoticed"
  );
});

test("FG-551: the launch tier's 10 tmux tests cannot be converted to skips or deleted", () => {
  // Closing the loop on the above: even with the `before` assert intact, marking
  // the tests `{ skip: !hasTmux }` / `t.skip()` would turn a tmux-less image green.
  // So would simply deleting the tests. Both are forbidden.
  const skipMechanisms = [
    /\btest\.skip\s*\(/,
    /\bit\.skip\s*\(/,
    /\bdescribe\.skip\s*\(/,
    /\bt\.skip\s*\(/,
    /\bthis\.skip\s*\(/,
    /\bskip\s*:/,
    /\btodo\s*:/,
  ];
  for (const pat of skipMechanisms) {
    assert.doesNotMatch(
      launchCliTests,
      pat,
      `the launch tier must not skip: ${pat.source} — a tmux-less image must stay RED, not go quietly green`
    );
  }

  const topLevelTests = launchCliTests.match(/^test\(/gm) ?? [];
  assert.ok(
    topLevelTests.length >= 10,
    `the launch tier must keep its 10 real tmux-owned tests (found ${topLevelTests.length}) — deleting them is the other way to make a tmux-less image green`
  );
});
