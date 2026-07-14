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

/**
 * The package names passed to every `apt-get install` in one RUN layer.
 *
 * Splitting on shell separators FIRST is the whole point. The install layer folds to
 * `RUN apt-get update && apt-get install -y ... && rm -rf ... && tmux -V`, so a regex
 * like /apt-get install\b.*\btmux\b/ matches across the `&&` and finds the tmux in the
 * SMOKE (`&& tmux -V`) — not a package. Delete tmux from the package list, keep the
 * layer's smoke, and that assertion stays green against an image that installs no tmux.
 * Same class of bug as the Dockerfile comment that satisfied the first `tmux -V` check:
 * an assertion answered by a nearby token instead of the thing it claims to check.
 *
 * Packages are returned as whole tokens, so `libtmux-dev` / `tmux-plugin-manager` are
 * `!== "tmux"` and cannot pass for it.
 */
function aptInstallPackages(layer: string): string[] {
  return layer
    .replace(/^RUN\s+/i, "")
    .split(/&&|\|\||;/)
    .filter((segment) => /^\s*(?:\S+=\S+\s+|sudo\s+)*apt-get\s+install\b/.test(segment))
    .flatMap((segment) =>
      segment
        .replace(/^\s*(?:\S+=\S+\s+|sudo\s+)*apt-get\s+install\b/, "")
        .trim()
        .split(/\s+/)
        .filter((token) => token && !token.startsWith("-"))
    );
}

test("FG-551: the agent image apt-installs tmux in the stage that actually ships", () => {
  const layer = runLayers().find((l) => aptInstallPackages(l).includes("tmux"));
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
    // Removal is only the most obvious way to un-ship tmux. Renaming it off PATH,
    // stripping its exec bit, or dpkg-removing the package all leave a tmux-less
    // image with the predicate above green. The final-RUN smoke below is the real
    // catch-all; these are named here so the failure says WHY, not just "smoke moved".
    assert.doesNotMatch(
      layer,
      /\bmv\b[^&|;]*\btmux\b|\bchmod\b[^&|;]*\btmux\b|\bdpkg\b[^&|;]*--(?:remove|purge)\b[^&|;]*\btmux\b/,
      `a layer disables tmux without removing it (mv/chmod/dpkg) — the image would ship with no working tmux: ${layer}`
    );
  }
});

test("FG-551: the tmux smoke is the LAST RUN in the final stage, and it cannot be masked", () => {
  // THE hole this guard exists to close. The install-layer smoke fires at layer 1 of
  // 8; seven RUN layers follow it before `USER agent`. A single later
  // `RUN mv /usr/bin/tmux /usr/bin/tmux.disabled` builds clean, ships an image with no
  // tmux command, and leaves install ✓ / earlier-smoke ✓ / no-removal ✓ — all green.
  // "A smoke somewhere in the stage" is worthless; only a smoke that runs LAST proves
  // tmux survived every preceding layer, whatever they did to it.
  const layers = runLayers();
  const last = layers[layers.length - 1];
  assert.ok(last, "the final build stage must have at least one RUN layer");

  assert.match(
    last,
    /^RUN\s+command\s+-v\s+tmux\s*>\s*\/dev\/null\s*&&\s*tmux\s+-V$/,
    "the LAST RUN in the final stage must be exactly the tmux smoke `RUN command -v tmux >/dev/null && tmux -V`. " +
      `Found instead: ${last}\n` +
      "If a RUN layer follows the smoke, that layer is untested — it can rename, chmod -x, purge or stub out tmux " +
      "and every other assertion here still passes. Move the smoke back to last."
  );

  // A smoke that cannot fail is not a smoke. `... || true`, `; true`, a trailing `|| :`
  // — each keeps the literal `tmux -V` in the file while making the RUN exit 0 no matter
  // what. The anchored shape above already rejects these; assert it explicitly so the
  // failure names the sin.
  assert.doesNotMatch(
    last,
    /\|\||;\s*(?:true|:)\s*$|\btrue\s*$/,
    `the final tmux smoke must propagate failure — no \`|| true\`, \`; true\`, or trailing \`|| :\`. A smoke that cannot fail gates nothing: ${last}`
  );

  // The smoke proves the filesystem as of the last RUN. A COPY/ADD after it can still
  // drop a broken binary over /usr/bin/tmux, so nothing that writes files may follow.
  const stage = finalStageInstructions();
  const afterSmoke = stage.slice(stage.lastIndexOf(last) + 1);
  for (const instr of afterSmoke) {
    assert.doesNotMatch(
      instr,
      /^(?:COPY|ADD)\s/i,
      `a COPY/ADD lands after the final tmux smoke, so it is not covered by any smoke — it could overwrite tmux: ${instr}`
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
