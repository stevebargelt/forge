// Tests for `forge upgrade`. The action handler itself is integration-heavy
// (shells out to bash, writes files), so we focus on the pure decision logic.
// tryGitPull git-subprocess tests live in upgrade.integration.test.ts.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryNpmInstall, maybeRebuildImage, renderReleaseCheckLines, decideDevAdvancement, upgradeAssetPaths, refuseDevAdvance,
  classifyStep, unresolvedReasons,
  type GitPullOutcome, type NpmInstallOutcome, type AssetInstallOutcome, type RoutingPolicyOutcome,
  type ProjectInitOutcome, type ImageRebuildOutcome, type ReleaseCheckOutcome, type UpgradeStepOutcomes,
} from "./upgrade.js";
import { assetRoot } from "../../v2/asset-root.js";
import { buildReleaseReport } from "../../v2/release-doctor.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-upgrade-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("tryNpmInstall: returns 'no-package-json' when the dir has no package.json", () => {
  const r = tryNpmInstall(dir, /* dryRun */ false);
  assert.equal(r.kind, "no-package-json");
});

test("tryNpmInstall: dry-run with package.json returns 'ok' without invoking npm", () => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
  const r = tryNpmInstall(dir, /* dryRun */ true);
  assert.equal(r.kind, "ok");
});

// ── #229: --rebuild-image branch + release-check tail (operator-facing path) ──

function greenInputs() {
  return {
    mode: "dev" as const,
    image: { name: "agent-dev-worker:latest", present: true, createdMs: 2000, buildInputMtimeMs: 1000 },
    clis: [{ command: "codex", present: true, neededBy: ["codex-subscription"] }],
    policy: { present: true, valid: true },
    profileAuth: [{ profile: "codex-subscription", provider: "openai", auth: "subscription", status: "available" as const, detail: "ok" }],
    routing: { present: true, ok: true, detail: "ok" },
  };
}

test("#229 maybeRebuildImage: --rebuild-image (not dry-run) runs docker/build.sh in the docker dir", () => {
  const calls: { cmd: string; cwd: string }[] = [];
  const r = maybeRebuildImage({ rebuildImage: true }, "/repo", "dev", "/repo", (cmd, opts) => { calls.push({ cmd, cwd: opts.cwd }); });
  assert.equal(r.ran, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /build\.sh/);
  assert.match(calls[0]!.cwd, /\/repo\/docker$/);
  assert.equal(r.error, undefined);
});

test("#229 maybeRebuildImage: dry-run does NOT rebuild", () => {
  let called = false;
  const r = maybeRebuildImage({ rebuildImage: true, dryRun: true }, "/repo", "dev", "/repo", () => { called = true; });
  assert.equal(r.ran, false);
  assert.equal(called, false);
});

test("#229 maybeRebuildImage: without the flag, no rebuild", () => {
  let called = false;
  const r = maybeRebuildImage({}, "/repo", "dev", "/repo", () => { called = true; });
  assert.equal(r.ran, false);
  assert.equal(called, false);
});

test("#229 maybeRebuildImage: a failing build surfaces an error, doesn't throw", () => {
  const r = maybeRebuildImage({ rebuildImage: true }, "/repo", "dev", "/repo", () => { throw new Error("docker boom"); });
  assert.equal(r.ran, true);
  assert.match(r.error ?? "", /rebuild failed/);
});

test("#229 renderReleaseCheckLines: a clean report → single ready line", () => {
  assert.deepEqual(
    renderReleaseCheckLines(buildReleaseReport(greenInputs())),
    ["Release check: ✓ image, runtime CLIs, auth, and policies look ready."],
  );
});

test("#229 renderReleaseCheckLines: problems → action header + each problem + doctor pointer", () => {
  const inputs = greenInputs();
  inputs.clis = [{ command: "codex", present: false, neededBy: ["codex-subscription"] }];
  const lines = renderReleaseCheckLines(buildReleaseReport(inputs));
  assert.match(lines[0]!, /action needed/i);
  assert.ok(lines.some((l) => /cli codex.*missing/.test(l)), "names the failing CLI");
  assert.match(lines[lines.length - 1]!, /forge doctor/);
});

// ─────────── FG-577: the split — asset install vs dev-checkout advancement ───────────
//
// The gate at upgrade.ts:62 was ONE predicate answering TWO unrelated questions
// ("am I a release?" and "does a dev checkout exist?"). A blanket refusal there
// exits before reaching the release-bundled installer, making the remedy
// unavailable exactly in the broken state (audit MEDIUM-5). These tests pin the
// split at the right place, not merely a reordered gate.

test("FG-577 (criterion 7): release mode refuses dev-advancement BEFORE any filesystem attempt", () => {
  const decision = decideDevAdvancement("release", "/rel", "/home/u/code/forge", () => {
    throw new Error("the refusal must not stat the checkout — a named contract error, never an EACCES or a stat of a tree that isn't there");
  });
  assert.equal(decision.kind, "refused");
});

test("FG-577 (criterion 7): the refusal names both sides, says why, and carries runnable manual steps", () => {
  const text = refuseDevAdvance("advance the dev checkout (git pull / npm install)", "/rel/forge-r1", "/home/u/code/forge").join("\n");
  assert.match(text, /refusing to advance the dev checkout/, "names what it refused");
  assert.match(text, /\/rel\/forge-r1/, "names the executing release");
  assert.match(text, /\/home\/u\/code\/forge/, "names the dev checkout");
  assert.match(text, /Reconciliation is not offered/, "says why the two are not reconciled");
  assert.match(text, /forge-dev upgrade/, "names the dev command");
  // forge-dev may not be runnable on this host, so the literal steps must be
  // present too — naming a remedy the operator cannot run is the same
  // availability defect this ticket exists to avoid, one size down.
  assert.match(text, /cd \/home\/u\/code\/forge && git pull && npm install/, "carries the concrete manual steps");
});

test("FG-577: the refusal makes no ordering claim it cannot keep on every path that emits it", () => {
  // ONE string is emitted from TWO paths: the git/npm refusal prints at [1/4] and
  // [2/4] — BEFORE install-seeds runs at [3/4] — while the --rebuild-image refusal
  // prints last, after both. "has already been attempted above" is true only on
  // the second, so the string may not assert a relative order at all.
  for (const action of ["advance the dev checkout (git pull / npm install)", "rebuild the agent image (--rebuild-image)"]) {
    const text = refuseDevAdvance(action, "/rel", "/dev").join("\n");
    assert.doesNotMatch(text, /already been attempted above|attempted above/, `false on the git/npm path: ${action}`);
    assert.match(text, /refreshed from the executing release regardless/, "still promises the asset half, which is the operator's actual remedy");
  }
});

test("FG-577 (criterion 2): with NO dev checkout at all, asset repair is still reachable", () => {
  // This is the test that proves the split landed in the right place. Against a
  // naive blanket refusal at the old gate it FAILS: that implementation never
  // reaches the release-bundled installer at all.
  const missing = join(dir, "definitely-absent-checkout");
  const decision = decideDevAdvancement("release", dir, missing);
  assert.equal(decision.kind, "refused", "advancement refuses");

  // …and yet the asset half resolves and is entirely independent of that answer.
  const { installScript, templatePath } = upgradeAssetPaths(dir);
  assert.equal(installScript, join(dir, "scripts", "install-seeds.sh"));
  assert.equal(templatePath, join(dir, "seeds", "orchestrator-template.md"));
  for (const p of [installScript, templatePath]) {
    assert.ok(!p.startsWith(missing), "asset paths never route through the dev checkout");
  }
});

test("FG-577: in dev mode a present checkout proceeds; an absent one is a skip, not a hard exit", () => {
  assert.deepEqual(decideDevAdvancement("dev", assetRoot(), dir), { kind: "proceed" });
  const gone = decideDevAdvancement("dev", assetRoot(), join(dir, "nope"));
  assert.equal(gone.kind, "missing");
  assert.match(gone.lines.join("\n"), /forge repo not found/);
  assert.match(gone.lines.join("\n"), /FORGE_REPO_DIR|--forge-repo/, "still actionable");
});

test("FG-577 (criterion 9): the rebuild ACTION refuses in release mode and runs no docker", () => {
  let called = false;
  const r = maybeRebuildImage({ rebuildImage: true }, "/home/u/code/forge", "release", "/rel/forge-r1", () => { called = true; });
  assert.equal(called, false, "no build is attempted");
  assert.equal(r.ran, false);
  assert.equal(r.refused, true, "an explicitly-requested action that refuses is a failed request → exit code 1");
  assert.match(r.error ?? "", /rebuild the agent image/);
  assert.match(r.error ?? "", /cd \/home\/u\/code\/forge && git pull && npm install/);
});

test("FG-577 (criterion 1/3): upgradeAssetPaths resolves BOTH assets from one root, never from the environment", () => {
  const before = process.env.FORGE_REPO_DIR;
  process.env.FORGE_REPO_DIR = dir;
  try {
    const { installScript, templatePath } = upgradeAssetPaths();
    // The named partial-fix mode: re-pointing the installer while leaving the
    // template on dev bytes. Both are asserted, so a seeds-only fix fails here.
    assert.equal(installScript, join(assetRoot(), "scripts", "install-seeds.sh"));
    assert.equal(templatePath, join(assetRoot(), "seeds", "orchestrator-template.md"));
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
  }
});

// ───────── FG-577 (criterion 10): the inverted default — one TOTAL classifier ─────────
//
// `unresolved` was a fail-OPEN allowlist: three pushes testing specific literals,
// so every state nobody named defaulted to resolved = silent success. Two review
// rounds each closed one more literal, which is the signature of a default that
// was never inverted. These tables are the assertion that it now is.
//
// Each is `Record<Outcome, ...>` — TOTAL over its union. That is the type-level
// half of the proof and it is checked in BOTH directions: adding a variant to any
// outcome union breaks upgrade.ts (its classification table is no longer total)
// AND breaks this file (this expectation table is no longer total). A reviewer can
// verify the guarantee by deleting one key from either and running `npm run
// typecheck`. The mechanised version of that mutation — a real `tsc` run over a
// really-mutated source — is in upgrade.integration.test.ts.

type Verdict = "resolved" | "unresolved";

const GIT_PULL: Record<GitPullOutcome, Verdict> = {
  pulled: "resolved",
  "would-pull": "resolved",
  "no-remote": "resolved",
  skipped: "resolved",
  unavailable: "resolved",
  refused: "unresolved",
  dirty: "unresolved",
  failed: "unresolved",
};

const NPM_INSTALL: Record<NpmInstallOutcome, Verdict> = {
  installed: "resolved",
  "would-install": "resolved",
  "no-package-json": "resolved",
  skipped: "resolved",
  unavailable: "resolved",
  refused: "unresolved",
  failed: "unresolved",
};

const ASSET_INSTALL: Record<AssetInstallOutcome, Verdict> = {
  installed: "resolved",
  "would-install": "resolved",
  "not-found": "unresolved",
  failed: "unresolved",
};

const ROUTING_POLICY: Record<RoutingPolicyOutcome, Verdict> = {
  recompiled: "resolved",
  "would-recompile": "resolved",
  "no-raci": "resolved",
  failed: "unresolved",
};

const PROJECT_INIT: Record<ProjectInitOutcome, Verdict> = {
  refreshed: "resolved",
  "already-current": "resolved",
  "would-refresh": "resolved",
  skipped: "resolved",
  "no-claude-md": "unresolved",
  "no-forge-block": "unresolved",
  "template-not-found": "unresolved",
  "needs-markers": "unresolved",
};

const IMAGE_REBUILD: Record<ImageRebuildOutcome, Verdict> = {
  ran: "resolved",
  "would-rebuild": "resolved",
  skipped: "resolved",
  refused: "unresolved",
  failed: "unresolved",
};

const RELEASE_CHECK: Record<ReleaseCheckOutcome, Verdict> = {
  ran: "resolved",
  "skipped-dry-run": "resolved",
  "skipped-asset-install": "resolved",
  failed: "unresolved",
};

const EXPECTED: { [K in keyof UpgradeStepOutcomes]: Record<UpgradeStepOutcomes[K], Verdict> } = {
  gitPull: GIT_PULL,
  npmInstall: NPM_INSTALL,
  assetInstall: ASSET_INSTALL,
  routingPolicy: ROUTING_POLICY,
  projectInit: PROJECT_INIT,
  imageRebuild: IMAGE_REBUILD,
  releaseCheck: RELEASE_CHECK,
};

test("FG-577 (criterion 10): EVERY variant of EVERY step is classified — no variant defaults to success", () => {
  let checked = 0;
  for (const [step, table] of Object.entries(EXPECTED)) {
    for (const [outcome, want] of Object.entries(table)) {
      const got = classifyStep({ step, outcome } as never);
      assert.equal(got.kind, want, `${step}/${outcome} must be ${want}`);
      if (got.kind === "unresolved") {
        // A reason a script can act on, not a bare boolean: the reason IS the
        // operator-facing text on the closing line and in --json.
        assert.ok(got.reason.length > 0, `${step}/${outcome} must name WHY`);
        assert.ok(!/undefined|\[object/.test(got.reason), `${step}/${outcome} reason is real text`);
      }
      checked++;
    }
  }
  // Guards against the tables silently emptying and the loop vacuously passing.
  assert.equal(checked, 8 + 7 + 4 + 4 + 8 + 5 + 4);
});

test("FG-577 (criterion 10): unresolvedReasons enumerates the outcomes object's own keys", () => {
  // The step LIST is derived from the object, not hand-maintained beside it, so a
  // newly added step is classified by construction rather than by memory.
  const allClean: UpgradeStepOutcomes = {
    gitPull: "pulled", npmInstall: "installed", assetInstall: "installed",
    routingPolicy: "recompiled", projectInit: "refreshed", imageRebuild: "ran", releaseCheck: "ran",
  };
  assert.deepEqual(unresolvedReasons(allClean), []);

  assert.deepEqual(
    unresolvedReasons({ ...allClean, gitPull: "dirty" }),
    ["git pull did not run — the dev checkout has uncommitted changes"],
  );
  // Every unresolved step contributes — none masks another.
  const allBroken: UpgradeStepOutcomes = {
    gitPull: "failed", npmInstall: "failed", assetInstall: "failed",
    routingPolicy: "failed", projectInit: "needs-markers", imageRebuild: "failed", releaseCheck: "failed",
  };
  assert.equal(unresolvedReasons(allBroken).length, 7);
});

test("FG-577 (cell 3): a dirty dev checkout is NOT an operator-requested skip", () => {
  // The operator asked for advancement and did not get it. Classing this beside
  // --skip-git is what made it read as a success on every surface.
  assert.equal(classifyStep({ step: "gitPull", outcome: "dirty" }).kind, "unresolved");
  assert.equal(classifyStep({ step: "gitPull", outcome: "skipped" }).kind, "resolved");
});

test("FG-577 (cell 2): operator-requested skips stay RESOLVED — a skip is not a failure", () => {
  for (const step of [
    { step: "gitPull", outcome: "skipped" },
    { step: "npmInstall", outcome: "skipped" },
    { step: "projectInit", outcome: "skipped" },
  ] as const) {
    assert.equal(classifyStep(step).kind, "resolved", `${step.step} --skip-* is the operator's call, not a defect`);
  }
});

test("FG-577 (cell 4): a FAILED image rebuild is unresolved, not a warning beside ok:true", () => {
  assert.equal(classifyStep({ step: "imageRebuild", outcome: "failed" }).kind, "unresolved");
  assert.equal(classifyStep({ step: "imageRebuild", outcome: "refused" }).kind, "unresolved");
  assert.equal(classifyStep({ step: "imageRebuild", outcome: "skipped" }).kind, "resolved");
});
