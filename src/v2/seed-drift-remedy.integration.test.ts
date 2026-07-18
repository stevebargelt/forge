// FG-577: the DETECTOR ↔ REMEDY loop closes on a release host.
//
// The unit and per-half tests pin each side of this ticket in isolation: the
// detector's baseline resolves from assetRoot() (seed-drift.test.ts), and the
// installer + template resolve from assetRoot() (upgrade.integration.test.ts).
// Neither drives the COMPOSITION, and the composition is what the ticket's
// defect narrative is actually about:
//
//   "a promoted release correctly DETECTS that ~/.forge drifted — then names
//    forge upgrade as the remedy (seed-drift.ts:119), and upgrade installs from
//    the DEV checkout."
//
// Detection was already release-correct in the fallback branch. The bug was that
// the remedy the detector NAMES did not converge the detector — you could run it
// forever and stay drifted. Both halves reading one root is the mechanism; the
// loop terminating is the property, and a property nothing asserts is a property
// nothing protects. These tests fail if either half regresses, and — because the
// loop composes them — they also fail on the pairing bugs that neither half's own
// test can see.
//
// SAFETY: every root here is a disposable mkdtemp. FORGE_HOME and
// CLAUDE_SKILLS_DEST are re-pointed at temp dirs for the duration of each test
// and restored in `finally`, so the install prefix is disposable and the real
// ~/.forge and ~/.claude are never written. Release mode is reached WITHOUT
// promoting this host: a temp tree carrying a manifest is a release to the one
// mode oracle. Nothing runs npm link or mutates ~/code/forge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetRoot, executionModeFrom } from "./asset-root.js";
import { detectSeedDrift, renderSeedDrift } from "./seed-drift.js";
import { runUpgrade } from "../cli/commands/upgrade.js";

/** A tree shaped like a release: a manifest plus the REQUIRED asset dirs, every
 *  asset carrying `marker` so the bytes that land in $FORGE_HOME are
 *  attributable to exactly one tree. Mirrors upgrade.integration.test.ts's
 *  fixture rather than sharing a helper — the convention in this repo is inline,
 *  self-contained fixtures (release.test.ts:133). */
function assetTree(prefix: string, marker: string, opts: { manifest?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, "seeds", "agents"), { recursive: true });
  mkdirSync(join(base, "seeds", "constraints"), { recursive: true });
  mkdirSync(join(base, "seeds", "runtimes"), { recursive: true });
  mkdirSync(join(base, "scripts"), { recursive: true });
  // The runtime seed is the dangerous category and the #265 failure by name: a
  // stale pi-apikey.yml silently rebinds the provider. It is also the only
  // category the detector treats as a hard readiness fail (autoRefreshable).
  writeFileSync(join(base, "seeds", "runtimes", "pi-apikey.yml"), `# ${marker}\nprovider: ${marker}\n`);
  writeFileSync(join(base, "seeds", "agents", "note.md"), `${marker} agent\n`);
  writeFileSync(join(base, "seeds", "constraints", "note.md"), `${marker} constraint\n`);
  writeFileSync(join(base, "seeds", "orchestrator-template.md"), `${marker} TEMPLATE\n`);
  // The REAL installer, byte-for-byte — it already resolves its own $HERE, so a
  // release-bundled copy installs the release's seeds. The bug was purely the
  // caller, so stubbing the installer here would stub out the thing under test.
  // (Copied, never modified: scripts/install-seeds.sh is FG-578's file.)
  cpSync(join(assetRoot(), "scripts", "install-seeds.sh"), join(base, "scripts", "install-seeds.sh"));
  if (opts.manifest !== false) {
    writeFileSync(join(base, "forge-release.json"), JSON.stringify({ schema: 1, abi: "137", id: "fg577-loop-fixture" }));
  }
  return base;
}

/** Run `fn` with a disposable $FORGE_HOME (the install prefix the seed installer
 *  writes to) and a disposable skills prefix. The process-wide temp FORGE_HOME
 *  from src/test-setup.ts is shared by every test in the process; the loop tests
 *  PLANT stale bytes and then assert on convergence, so they need a home of their
 *  own or they would read each other's installs. */
function withDisposableHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "fg577-loop-home-"));
  const skills = mkdtempSync(join(tmpdir(), "fg577-loop-skills-"));
  const homeBefore = process.env.FORGE_HOME;
  const skillsBefore = process.env.CLAUDE_SKILLS_DEST;
  process.env.FORGE_HOME = home;
  process.env.CLAUDE_SKILLS_DEST = skills;
  try {
    fn(home);
  } finally {
    if (homeBefore === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = homeBefore;
    if (skillsBefore === undefined) delete process.env.CLAUDE_SKILLS_DEST;
    else process.env.CLAUDE_SKILLS_DEST = skillsBefore;
    for (const d of [home, skills]) rmSync(d, { recursive: true, force: true });
  }
}

/** runUpgrade reports failure through process.exitCode. A leaked 1 would fail
 *  this whole file with every test passing, so capture and restore it. */
function captureExit(fn: () => void): number | undefined {
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    fn();
    return process.exitCode as number | undefined;
  } finally {
    process.exitCode = before;
  }
}

function silently(fn: () => void): void {
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { fn(); } finally { console.log = realLog; console.warn = realWarn; }
}

/** The baseline a forge executing from `release` computes for itself. Written as
 *  the release's own seeds dir rather than by calling defaultRepoSeedsDir(),
 *  which in THIS process resolves to the live checkout: the test process executes
 *  from the npm-linked checkout, not from the fixture. That the production
 *  resolver returns exactly `join(<executing root>, "seeds")` is pinned by
 *  asset-root-agreement.test.ts; this file composes on top of that fact instead
 *  of re-asserting it. */
function baselineOf(release: string): string {
  return join(release, "seeds");
}

test("FG-577: on a release host, the remedy the detector NAMES actually converges the detector", () => {
  const release = assetTree("fg577-loop-rel-", "RELEASE");
  const devCheckout = assetTree("fg577-loop-dev-", "DEV", { manifest: false });
  const repoBefore = process.env.FORGE_REPO_DIR;
  try {
    assert.equal(executionModeFrom(join(release, "src", "v2")), "release", "the fixture really is a release, by the one mode oracle");
    // The divergent dev checkout, named by the ambient environment: the exact
    // condition the ticket says is "not hypothetical — merely having a divergent
    // ~/code/forge is enough".
    process.env.FORGE_REPO_DIR = devCheckout;

    withDisposableHome((home) => {
      // ── 1. A ~/.forge that has drifted, in BOTH taxonomies — the fixture used
      //       to plant drift only in runtimes/pi-apikey.yml, which is why it
      //       could not see the prose half of this property and would have gone
      //       green on it forever (FG-578).
      //       (a) the stale runtime seed of #265, the failure this detector was
      //           built for: forge-owned, and forge WILL refresh it.
      mkdirSync(join(home, "runtimes"), { recursive: true });
      writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "# STALE\nprovider: stale-and-wrong\n");
      //       (b) an operator-authored prose seed carrying a local edit: forge
      //           will NOT refresh it, and (FG-578) must not claim it will.
      mkdirSync(join(home, "agents"), { recursive: true });
      writeFileSync(join(home, "agents", "note.md"), "LOCALLY EDITED — the operator's own words\n");

      // ── 2. The detector fires, against the RELEASE's own bytes.
      const before = detectSeedDrift(baselineOf(release), home);
      assert.equal(before.ok, false, "a drifted runtime seed is a hard readiness fail — otherwise step 4 proves nothing");
      assert.ok(
        before.stale.some((e) => e.path === join("runtimes", "pi-apikey.yml") && e.status === "drifted"),
        "the detector must see the planted drift before we try to repair it",
      );
      assert.ok(
        before.stale.some((e) => e.path === join("agents", "note.md") && e.status === "drifted" && e.ownership === "operator-authored"),
        "…and must see the PROSE drift too, or the convergence claim below is untested",
      );

      // ── 3. …and names `forge upgrade` as the remedy (seed-drift.ts). The loop
      //       under test is defined by what this string says, so read it from the
      //       renderer rather than hardcoding the assumption.
      const remedy = renderSeedDrift(before);
      assert.match(remedy, /Fix: forge upgrade/);
      // FG-578 — THE NARROWED CLAIM. `forge upgrade` converges the forge-owned
      // half and, by design, retains the authored half. So the renderer may name
      // upgrade as the remedy for runtimes and must NOT name it as the remedy for
      // prose: that would be a promise that converges nothing — run it forever,
      // stay drifted — which is the same defect class as a false refresh claim.
      assert.match(remedy, /forge upgrade will NOT/, "the prose half must say plainly that upgrade does not refresh it");
      assert.ok(!/Refresh with forge upgrade if unintended/.test(remedy), "the old non-converging promise must be gone");

      // ── 4. Run that remedy — the REAL action, driven as the release.
      const exitCode = captureExit(() => silently(() => runUpgrade(
        { skipProject: true },
        { mode: "release", assetsDir: release, devDir: devCheckout },
      )));

      // ── 5. The loop terminates. This is the assertion the whole ticket is for.
      //       Pre-fix (assets resolved from devDir) the install lands DEV bytes
      //       and this stays drifted forever: run the named remedy, still
      //       drifted, run it again, still drifted.
      const after = detectSeedDrift(baselineOf(release), home);
      assert.equal(after.ok, true, "the remedy the detector names must converge the detector — a remedy that leaves drift in place is the defect");
      // FG-578 narrows this from "nothing is stale" to "nothing forge OWNS is
      // stale". The two used to be the same claim only because the installer
      // clobbered the authored files — the defect this ticket removes. Every
      // category upgrade CLAIMS to converge, it converges; the categories it now
      // retains stay stale, which is the honest outcome and is why the renderer no
      // longer promises otherwise.
      assert.deepEqual(
        after.stale.filter((e) => e.ownership === "forge-owned"),
        [],
        "no forge-OWNED seed may remain stale against the executing release's own seeds",
      );

      // ── 6. …and it converged by installing RELEASE bytes, not by any other
      //       route. Without this, a remedy that converged by corrupting the
      //       baseline would pass step 5.
      const installed = readFileSync(join(home, "runtimes", "pi-apikey.yml"), "utf8");
      assert.match(installed, /provider: RELEASE/);
      assert.ok(!installed.includes("DEV"), "converging onto DEV bytes is the named defect, not a fix");
      assert.ok(!installed.includes("stale-and-wrong"), "FORCE=1 must actually overwrite the drifted runtime seed");

      // FG-578: the other half of the same run, and the reason the two halves
      // belong in ONE test — the remedy converged the forge-owned seed WITHOUT
      // touching the operator's prose. A fix that converged everything would pass
      // every assertion above and silently destroy the local edit.
      assert.equal(
        readFileSync(join(home, "agents", "note.md"), "utf8"),
        "LOCALLY EDITED — the operator's own words\n",
        "the operator's prose survives the very remedy that refreshed the runtime beside it",
      );
      const proseAfter = renderSeedDrift(after);
      assert.match(proseAfter, /agents\/note\.md/, "…and the surviving drift is still REPORTED — retained is not hidden");
      assert.ok(!/Fix: forge upgrade/.test(proseAfter), "with only prose left stale, upgrade is no longer named as a remedy: it would not converge it");

      // The advancement half still refused, and that is still a failed request —
      // but it did not cost us the repair. Both facts hold at once.
      assert.equal(exitCode, 1, "release-mode advancement refusal is still surfaced on the exit code");
    });

    // BD-13: the checkout the ambient env named was read for nothing and mutated
    // by nothing.
    assert.equal(
      readFileSync(join(devCheckout, "seeds", "runtimes", "pi-apikey.yml"), "utf8"),
      "# DEV\nprovider: DEV\n",
      "the dev checkout is neither an install source nor a target here",
    );
  } finally {
    if (repoBefore === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = repoBefore;
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577 (MEDIUM-5): the loop still closes on a release host with NO dev checkout at all", () => {
  // The availability half of the same property, at loop level. The per-half test
  // proves the installer is REACHED with no checkout; this proves the operator's
  // actual situation resolves — drift detected, named remedy run, drift gone —
  // on a host where the fail-closed trap would have left them with no remedy at
  // all, in exactly the state the remedy exists to repair.
  const release = assetTree("fg577-loop-nodev-", "RELEASE");
  const absent = join(tmpdir(), "fg577-loop-no-such-checkout-ever");
  try {
    assert.equal(executionModeFrom(join(release, "src", "v2")), "release");

    withDisposableHome((home) => {
      mkdirSync(join(home, "runtimes"), { recursive: true });
      writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "# STALE\nprovider: stale-and-wrong\n");

      const before = detectSeedDrift(baselineOf(release), home);
      assert.equal(before.ok, false, "drift is present before the repair");

      silently(() => captureExit(() => runUpgrade(
        { skipProject: true },
        { mode: "release", assetsDir: release, devDir: absent },
      )));

      const after = detectSeedDrift(baselineOf(release), home);
      assert.equal(after.ok, true, "the remedy must remain available — and effective — on a host that has no dev checkout");
      assert.match(readFileSync(join(home, "runtimes", "pi-apikey.yml"), "utf8"), /provider: RELEASE/);
    });
  } finally {
    rmSync(release, { recursive: true, force: true });
  }
});

test("FG-577: the loop closes in dev mode too, and a clean run stays clean", () => {
  // The guard on the two tests above: they must fire on the defect, not on every
  // run. A live dev checkout is the preserved-behaviour case (criterion 8) — the
  // same loop, same assertions, no refusal — and re-running the remedy against an
  // already-current install is a no-op rather than a new source of drift.
  const dev = assetTree("fg577-loop-devmode-", "DEVTREE", { manifest: false });
  try {
    assert.equal(executionModeFrom(join(dev, "src", "v2")), "dev", "no manifest → the fixture is a dev checkout");

    withDisposableHome((home) => {
      const exitCode = captureExit(() => silently(() => runUpgrade(
        { skipProject: true, skipGit: true, skipNpm: true },
        { mode: "dev", assetsDir: dev, devDir: dev },
      )));
      assert.equal(exitCode, undefined, "nothing refused, nothing failed → dev behaviour is preserved");

      const after = detectSeedDrift(baselineOf(dev), home);
      assert.equal(after.ok, true, "a fresh install is current against the tree it came from");
      assert.deepEqual(after.stale, []);

      // Idempotence: the remedy is safe to re-run, which is what makes "run
      // forge upgrade" honest advice rather than a coin flip.
      silently(() => captureExit(() => runUpgrade(
        { skipProject: true, skipGit: true, skipNpm: true },
        { mode: "dev", assetsDir: dev, devDir: dev },
      )));
      assert.deepEqual(detectSeedDrift(baselineOf(dev), home).stale, [], "re-running the remedy must not introduce drift");
    });
  } finally {
    rmSync(dev, { recursive: true, force: true });
  }
});
