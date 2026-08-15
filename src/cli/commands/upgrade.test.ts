// Tests for `forge upgrade`. The action handler itself is integration-heavy
// (shells out to bash, writes files), so we focus on the pure decision logic.
// tryGitPull git-subprocess tests live in upgrade.integration.test.ts.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  tryNpmInstall, maybeRebuildImage, renderReleaseCheckLines, decideDevAdvancement, upgradeAssetPaths, refuseDevAdvance,
  classifyStep, unresolvedReasons, classifyAdapterEntries, classifyAdapterOutcomes,
  type GitPullOutcome, type NpmInstallOutcome, type AssetInstallOutcome, type RoutingPolicyOutcome,
  type ProjectInitOutcome, type SlashCommandsOutcome, type ImageRebuildOutcome, type ReleaseCheckOutcome,
  type AuthoredRetentionOutcome, type UpgradeStepOutcomes, type SeedGenerationOutcome,
  type AdapterSurfacesOutcome, type DocsSurfacesOutcome, type ModelPolicyMigrationOutcome,
  parseRetainedLine,
} from "./upgrade.js";
import type { AdapterDecision, AdapterOutcome } from "./init.js";
import { assetRoot } from "../../v2/asset-root.js";
import { buildReleaseReport } from "../../v2/release-doctor.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
  assert.equal(r.outcome, "ran");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /build\.sh/);
  assert.match(calls[0]!.cwd, /\/repo\/docker$/);
  assert.equal(r.error, undefined);
});

test("#229 maybeRebuildImage: dry-run does NOT rebuild", () => {
  let called = false;
  const r = maybeRebuildImage({ rebuildImage: true, dryRun: true }, "/repo", "dev", "/repo", () => { called = true; });
  assert.equal(r.outcome, "would-rebuild");
  assert.equal(called, false);
});

test("#229 maybeRebuildImage: without the flag, no rebuild", () => {
  let called = false;
  const r = maybeRebuildImage({}, "/repo", "dev", "/repo", () => { called = true; });
  assert.equal(r.outcome, "skipped");
  assert.equal(called, false);
});

test("#229 maybeRebuildImage: a failing build surfaces an error, doesn't throw", () => {
  const r = maybeRebuildImage({ rebuildImage: true }, "/repo", "dev", "/repo", () => { throw new Error("docker boom"); });
  assert.equal(r.outcome, "failed");
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
  const decision = decideDevAdvancement("release", "/rel", "/home/u/code/forge", {}, () => {
    throw new Error("the refusal must not stat the checkout — a named contract error, never an EACCES or a stat of a tree that isn't there");
  });
  assert.equal(decision.kind, "refused");
});

test("FG-577: an operator skip outranks the mode refusal — you cannot refuse what was never requested", () => {
  const skipped = decideDevAdvancement("release", "/rel", "/home/u/code/forge", { skipGit: true, skipNpm: true }, () => {
    throw new Error("a skip must be decided without touching the filesystem either");
  });
  assert.equal(skipped.kind, "not-requested", "both steps skipped: there is no advancement left to refuse");

  // The mutant this guards against: weakening the refusal generally. A skip of
  // ONE step leaves the OTHER genuinely refused — the two are independent.
  for (const skips of [{}, { skipGit: true }, { skipNpm: true }]) {
    assert.equal(
      decideDevAdvancement("release", "/rel", "/home/u/code/forge", skips).kind,
      "refused",
      `still refused with ${JSON.stringify(skips)} — the release cannot do what was actually asked`,
    );
  }
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

// ─── RF-6: the documented numbering IS the numbering the CLI prints ─────────
//
// Nothing generates one from the other — docs/how-to-upgrade.md and upgrade.ts agree by
// hand — so a step renumbered in one and not the other leaves a documented step that is
// unfindable in real output. This reads both files and asserts they still agree.
test("RF-6: docs and CLI agree on four numbered steps, and on which step is which", () => {
  const source = readFileSync(join(repoRoot, "src", "cli", "commands", "upgrade.ts"), "utf8");
  const doc = readFileSync(join(repoRoot, "docs", "how-to-upgrade.md"), "utf8");

  const denominators = [...new Set([...source.matchAll(/\[(\d+)\/(\d+)\]/g)].map((m) => m[2]))];
  assert.deepEqual(denominators, ["4"], "every step label the CLI prints must count out of four");

  for (const [n, label] of [
    ["1", "git pull"],
    ["2", "npm install"],
    ["3", "install-seeds"],
    ["4", "project init"],
  ] as const) {
    assert.ok(source.includes(`[${n}/4] ${label}`), `the CLI must print step ${n} as \`[${n}/4] ${label}\``);
  }

  assert.match(doc, /This runs four steps in sequence:/, "the doc states the same count");
  assert.match(doc, /^3\. \*\*`FORCE=1 \.\/scripts\/install-seeds\.sh`\*\*/m, "…and numbers install-seeds 3");
  assert.match(doc, /^4\. \*\*Provision the current project\*\*/m, "…and the project provision 4");
  // The release-mode refusal names the asset half by its step labels, and the doc names
  // the same span in prose. A renumbering that missed either would put them in conflict.
  assert.ok(source.includes("(steps [3/4] and [4/4])"), "the refusal names the asset half by label");
  assert.ok(doc.includes("steps 3 and 4"), "…and the doc names the same span");
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
  assert.equal(r.outcome, "refused", "an explicitly-requested action that refuses is a failed request → exit code 1");
  assert.match(r.error ?? "", /rebuild the agent image/);
  assert.match(r.error ?? "", /cd \/home\/u\/code\/forge && git pull && npm install/);
});

// ─────────── FG-577: the ORDERING generator — skip → mode → dryRun ───────────
//
// Two instances of ONE bug shape have now been found here: a predicate evaluated
// in the wrong order relative to the mode decision. `decideDevAdvancement` read
// the mode BEFORE the skips and refused what was never requested; then
// `maybeRebuildImage` read `dryRun` BEFORE the mode and forecast an action the
// mode would refuse. These tests pin the ORDER itself, in both decision
// functions, so a third instance cannot open quietly.
//
// The rule: a skip is a fact about what was REQUESTED and outranks everything —
// you cannot refuse what nobody asked for. The mode is a fact about what CAN
// happen. A dry run PREDICTS the decision the real run would make; it never gets
// an answer of its own.

test("FG-577 (ordering): a release dry run REPORTS the rebuild refusal — it does not forecast past it", () => {
  // The reported second instance. `dryRun` was fused into the not-requested
  // check (`!rebuildImage || dryRun`) and returned BEFORE the mode check, so a
  // release forecast `would-rebuild` — resolved, exit 0 — for a dev-checkout
  // action it would in fact refuse.
  let called = false;
  const r = maybeRebuildImage({ rebuildImage: true, dryRun: true }, "/home/u/code/forge", "release", "/rel/forge-r1", () => { called = true; });
  assert.equal(r.outcome, "refused", "the dry run reports the decision the real run would make");
  assert.equal(called, false, "and a dry run still executes nothing");
  assert.match(r.error ?? "", /rebuild the agent image/, "with the same named refusal the real run prints");
});

test("FG-577 (ordering): a rebuild nobody requested is not refused, even on a release", () => {
  // The guard in the other direction: hoisting the mode check above the REQUEST
  // check is the first instance's bug (5925e71) reintroduced one step down —
  // every release upgrade would report a refusal for a flag nobody passed.
  for (const options of [{}, { dryRun: true }]) {
    const r = maybeRebuildImage(options, "/home/u/code/forge", "release", "/rel/forge-r1", () => {
      throw new Error("nothing to execute — nothing was asked for");
    });
    assert.equal(r.outcome, "skipped", `no --rebuild-image → nothing to refuse (${JSON.stringify(options)})`);
    assert.equal(r.error, undefined);
  }
});

test("FG-577 (ordering): in dev, the dry run forecasts the rebuild the mode permits", () => {
  const r = maybeRebuildImage({ rebuildImage: true, dryRun: true }, "/repo", "dev", "/repo", () => {
    throw new Error("a dry run mutates nothing");
  });
  assert.equal(r.outcome, "would-rebuild");
  assert.equal(r.error, undefined);
});

test("FG-577 (ordering): the skip outranks the checkout lookup in DEV too, not just the release refusal", () => {
  // The first instance was fixed only inside the release branch, leaving the
  // same order wrong one branch over: in dev, both skips still fell through to a
  // `missing` verdict, so a host with no checkout was told to set FORGE_REPO_DIR
  // for advancement it had explicitly declined. Same generator, same rule.
  const decision = decideDevAdvancement("dev", "/assets", "/definitely/absent", { skipGit: true, skipNpm: true }, () => {
    throw new Error("a skip is decided without going looking for what was not requested");
  });
  assert.equal(decision.kind, "not-requested");

  // …and the guard: one skip is not both. The other half is still genuinely
  // requested, so the checkout is still looked for and still reported missing.
  const half = decideDevAdvancement("dev", "/assets", "/definitely/absent", { skipGit: true });
  assert.equal(half.kind, "missing");
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
  "failed-not-neutralized": "unresolved",
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

const SLASH_COMMANDS: Record<SlashCommandsOutcome, Verdict> = {
  installed: "resolved",
  "already-current": "resolved",
  "would-install": "resolved",
  // The project owns the file; forge not clobbering it is the command working.
  // Visible in --json (`slashCommands` + `slashCommandOverrides`), not exit 1.
  "user-override": "resolved",
  "not-run": "resolved",
};

// FG-578: forge declining to overwrite a file the OPERATOR authors is the command
// working — same shape as `user-override` above. Visible in --json
// (`authoredRetention` + `authoredRetentions`) and in the human ⚠, never exit 1:
// `retained` fires on every host whose operator has ever run `forge raci apply`,
// so classing it unresolved would make exit 1 permanent for the supported,
// audited workflow. `not-run` is honest ignorance (the installer never ran), not
// a second failure — the assetInstall step already carries that one.
const AUTHORED_RETENTION: Record<AuthoredRetentionOutcome, Verdict> = {
  none: "resolved",
  retained: "resolved",
  "not-run": "resolved",
};

// FG-253 step 5: the WHOLE adapter set (Claude commands + Codex skills) as its own
// step. `user-override` is resolved for the same reason it is under SLASH_COMMANDS
// — forge declining to clobber a file it does not own is the command working, and
// an exit code that fires forever on every project that owns its own /orient is
// noise, not signal. Visible in --json (`adapterSurfaces` + `adapterOverrides`).
const ADAPTER_SURFACES: Record<AdapterSurfacesOutcome, Verdict> = {
  installed: "resolved",
  "already-current": "resolved",
  "would-install": "resolved",
  "user-override": "resolved",
  "not-run": "resolved",
};

// FG-546: create / migrate / preserve (and the dry-run forecasts) are the command
// working. `requires-operator-repair` is RESOLVED for the same reason
// `user-override` is under SLASH_COMMANDS/ADAPTER_SURFACES — forge declining to
// overwrite a file it does not own is the command working, the never-clobber
// guarantee is upheld, and the actionable ⚠ (visible in --json as `docsSurfaces` +
// `docsSurfacesRepair`) is where the operator SEES it; an exit code that fires
// forever on a hand-authored file is noise. `seed-missing` IS unresolved: forge's
// own bundled seed is absent, the same class of forge-install defect as
// PROJECT_INIT's `template-not-found`.
const DOCS_SURFACES: Record<DocsSurfacesOutcome, Verdict> = {
  created: "resolved",
  migrated: "resolved",
  preserved: "resolved",
  "would-create": "resolved",
  "would-migrate": "resolved",
  "requires-operator-repair": "resolved",
  "seed-missing": "unresolved",
  "not-run": "resolved",
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

// FG-583: only a failed atomic publication is unresolved; not-run/would-publish/
// published are all resolved.
const SEED_GENERATION: Record<SeedGenerationOutcome, Verdict> = {
  published: "resolved",
  "would-publish": "resolved",
  "not-run": "resolved",
  failed: "unresolved",
};

// FG-560: migrated/would-migrate/all-current/none/not-run are the command working;
// only action-required and failed leave the fleet unresolved.
const MODEL_POLICY: Record<ModelPolicyMigrationOutcome, Verdict> = {
  none: "resolved",
  "all-current": "resolved",
  migrated: "resolved",
  "would-migrate": "resolved",
  "action-required": "unresolved",
  failed: "unresolved",
  "not-run": "resolved",
};

const EXPECTED: { [K in keyof UpgradeStepOutcomes]: Record<UpgradeStepOutcomes[K], Verdict> } = {
  gitPull: GIT_PULL,
  npmInstall: NPM_INSTALL,
  assetInstall: ASSET_INSTALL,
  seedGeneration: SEED_GENERATION,
  modelPolicy: MODEL_POLICY,
  authoredRetention: AUTHORED_RETENTION,
  routingPolicy: ROUTING_POLICY,
  projectInit: PROJECT_INIT,
  docsSurfaces: DOCS_SURFACES,
  slashCommands: SLASH_COMMANDS,
  adapterSurfaces: ADAPTER_SURFACES,
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
  // FG-546: + 8 for DOCS_SURFACES (created/migrated/preserved/would-create/
  // would-migrate/requires-operator-repair/seed-missing/not-run).
  // FG-560: + 7 for MODEL_POLICY (none/all-current/migrated/would-migrate/
  // action-required/failed/not-run).
  assert.equal(checked, 8 + 7 + 4 + 4 + 7 + 3 + 5 + 8 + 8 + 5 + 5 + 5 + 4);
});

test("FG-577 (criterion 10): unresolvedReasons enumerates the outcomes object's own keys", () => {
  // The step LIST is derived from the object, not hand-maintained beside it, so a
  // newly added step is classified by construction rather than by memory.
  const allClean: UpgradeStepOutcomes = {
    gitPull: "pulled", npmInstall: "installed", assetInstall: "installed",
    seedGeneration: "published", modelPolicy: "migrated",
    authoredRetention: "none", routingPolicy: "recompiled", projectInit: "refreshed",
    docsSurfaces: "created",
    slashCommands: "installed", adapterSurfaces: "installed", imageRebuild: "ran", releaseCheck: "ran",
  };
  assert.deepEqual(unresolvedReasons(allClean), []);

  assert.deepEqual(
    unresolvedReasons({ ...allClean, gitPull: "dirty" }),
    ["git pull did not run — the dev checkout has uncommitted changes"],
  );
  // Every unresolved step contributes — none masks another.
  const allBroken: UpgradeStepOutcomes = {
    gitPull: "failed", npmInstall: "failed", assetInstall: "failed",
    seedGeneration: "failed", modelPolicy: "action-required",
    // FG-578: `retained` sits in the all-broken row deliberately — even here it
    // must not contribute a reason. The count below is the assertion.
    authoredRetention: "retained", routingPolicy: "failed", projectInit: "needs-markers",
    // FG-546: `requires-operator-repair` sits in the all-broken row deliberately —
    // even here it must not contribute a reason (forge declining to clobber a
    // customized-invalid file is the command working; the ⚠ is where it is seen).
    docsSurfaces: "requires-operator-repair",
    // FG-253 step 5: `user-override` sits in the all-broken row on BOTH surfaces
    // deliberately — even here neither may contribute a reason. The count is the
    // assertion.
    slashCommands: "user-override", adapterSurfaces: "user-override",
    imageRebuild: "failed", releaseCheck: "failed",
  };
  // FG-560: model-policy action-required adds the 9th unresolved reason.
  assert.equal(unresolvedReasons(allBroken).length, 9);
});

// ─────────── FG-253 step 5: adapters as their own step ───────────

test("FG-253 step 5: an adapter `user-override` is RESOLVED, and contributes no unresolved reason", () => {
  assert.equal(classifyStep({ step: "adapterSurfaces", outcome: "user-override" }).kind, "resolved");

  // The acceptance, stated as the surface an operator actually feels: an outcome
  // set whose ONLY notable state is a project override yields an EMPTY reason
  // list — so exit 0, `ok: true`, and "Upgrade complete." A project that
  // deliberately owns its own /orient (or its own forge-orient skill) is not a
  // broken project, and a red light that fires forever on it is noise.
  const withOverride: UpgradeStepOutcomes = {
    gitPull: "skipped", npmInstall: "skipped", assetInstall: "installed",
    seedGeneration: "published", modelPolicy: "all-current", authoredRetention: "none", routingPolicy: "no-raci",
    projectInit: "already-current", docsSurfaces: "preserved", slashCommands: "user-override",
    adapterSurfaces: "user-override", imageRebuild: "skipped", releaseCheck: "ran",
  };
  assert.deepEqual(unresolvedReasons(withOverride), []);

  // The guard: the row above is not vacuously empty — one genuine failure in the
  // same set still reports, so the emptiness is about the override specifically.
  assert.deepEqual(
    unresolvedReasons({ ...withOverride, assetInstall: "failed" }),
    ["install-seeds.sh FAILED"],
  );
});

test("FG-253 step 5: each surface is classified from its OWN entries — neither is inferred from the other", () => {
  const claude = (decision: AdapterDecision) => ({ surface: "claude-command" as const, decision });
  const codex = (decision: AdapterDecision) => ({ surface: "codex-skill" as const, decision });

  // The bug this replaces: `slashCommands` mixed the Claude-only override list
  // with the WHOLE plan's action, so a Codex skill needing an install made the
  // slash-command step claim an install that touched no slash command.
  const codexNeedsWork = [claude("already-current"), claude("already-current"), codex("install"), codex("install")];
  assert.equal(classifyAdapterEntries(codexNeedsWork.filter((e) => e.surface === "claude-command"), false), "already-current");
  assert.equal(classifyAdapterEntries(codexNeedsWork, false), "installed");

  // And the mirror: a Codex-only override must not be reported as a slash-command
  // override, while the whole-set step must still see it.
  const codexOverridden = [claude("already-current"), claude("already-current"), codex("override"), codex("already-current")];
  assert.equal(classifyAdapterEntries(codexOverridden.filter((e) => e.surface === "claude-command"), false), "already-current");
  assert.equal(classifyAdapterEntries(codexOverridden, false), "user-override");
});

test("FG-253 step 5: classifyAdapterEntries reaches every outcome it can name", () => {
  assert.equal(classifyAdapterEntries([], false), "not-run", "nobody looked — not 'already current'");
  assert.equal(classifyAdapterEntries([{ decision: "already-current" }], false), "already-current");
  assert.equal(classifyAdapterEntries([{ decision: "install" }], false), "installed");
  assert.equal(classifyAdapterEntries([{ decision: "migrate" }], false), "installed", "a legacy symlink migrated to bytes is an install");
  assert.equal(classifyAdapterEntries([{ decision: "refresh" }], false), "installed");
  assert.equal(classifyAdapterEntries([{ decision: "install" }], true), "would-install", "a dry run forecasts, never claims");
  // An override outranks work still to do: it is the state an operator must SEE,
  // and a run that also installed two files should not hide it behind "installed".
  assert.equal(classifyAdapterEntries([{ decision: "install" }, { decision: "override" }], false), "user-override");
  assert.equal(classifyAdapterEntries([{ decision: "override" }], true), "user-override", "…on a dry run too — the override is decided by what is already on disk");
});

// RF-1: on a run that EXECUTED, every reported field is read off the outcomes. The
// plan and the outcomes disagree precisely where the operator's trust surface lives —
// a target that became somebody's between the plan and the write.
test("FG-253: a run that executed classifies from its OUTCOMES, so a skipped write is never reported as installed", () => {
  const outcome = (applied: AdapterOutcome["applied"], decision: AdapterDecision = "install"): AdapterOutcome => ({
    relPath: ".claude/commands/orient.md",
    target: "/p/.claude/commands/orient.md",
    surface: "claude-command",
    label: "/orient",
    name: "orient.md",
    decision,
    applied,
  });

  assert.equal(classifyAdapterOutcomes([]), "not-run", "nobody looked — not 'already current'");
  assert.equal(classifyAdapterOutcomes([outcome("written")]), "installed");
  assert.equal(classifyAdapterOutcomes([outcome("unchanged", "already-current")]), "already-current");
  assert.equal(classifyAdapterOutcomes([outcome("left-alone", "override")]), "user-override");
  // The one the plan gets wrong: the plan still says `install`, so a plan-derived
  // classification reports an install of a file forge deliberately did not write.
  assert.equal(classifyAdapterEntries([{ decision: "install" }], false), "installed");
  assert.equal(classifyAdapterOutcomes([outcome("skipped-changed")]), "user-override");
  assert.equal(classifyAdapterOutcomes([outcome("written"), outcome("skipped-changed")]), "user-override");
});

// ─────────── FG-546: docs-surfaces as a reported [4/4] sub-step ───────────

test("FG-546: docs-surfaces write outcomes are resolved; only a missing forge seed is unresolved", () => {
  // The command working: created / migrated / preserved (and their dry-run
  // forecasts) never fire exit 1.
  for (const outcome of ["created", "migrated", "preserved", "would-create", "would-migrate", "not-run"] as const) {
    assert.equal(classifyStep({ step: "docsSurfaces", outcome }).kind, "resolved", `${outcome} must be resolved`);
  }
  // The never-clobber guarantee upheld: a customized-invalid file forge left
  // untouched is the command working — resolved, surfaced by the ⚠, never exit 1.
  assert.equal(classifyStep({ step: "docsSurfaces", outcome: "requires-operator-repair" }).kind, "resolved");
  // A missing forge-own seed is a forge-install defect, like a missing template.
  const missing = classifyStep({ step: "docsSurfaces", outcome: "seed-missing" });
  assert.equal(missing.kind, "unresolved");
  if (missing.kind === "unresolved") assert.match(missing.reason, /docs-surfaces NOT provisioned/);
});

test("FG-546: a customized-invalid docs-surfaces file does not, by itself, make upgrade INCOMPLETE", () => {
  // The parallel to the `user-override` acceptance: a project holding a
  // hand-authored (invalid) docs-surfaces file is not a broken upgrade — forge
  // preserved it and warned. Exit 0, ok:true.
  const withRepair: UpgradeStepOutcomes = {
    gitPull: "skipped", npmInstall: "skipped", assetInstall: "installed",
    seedGeneration: "published", modelPolicy: "all-current", authoredRetention: "none", routingPolicy: "no-raci",
    projectInit: "already-current", docsSurfaces: "requires-operator-repair",
    slashCommands: "already-current", adapterSurfaces: "already-current",
    imageRebuild: "skipped", releaseCheck: "ran",
  };
  assert.deepEqual(unresolvedReasons(withRepair), []);
  // The guard: a genuine failure in the same set still reports — the emptiness is
  // about the repair outcome specifically, not a vacuous row.
  assert.deepEqual(
    unresolvedReasons({ ...withRepair, docsSurfaces: "seed-missing" }),
    ["docs-surfaces NOT provisioned — forge's bundled docs-surfaces.example.yml seed was not found in the executing tree"],
  );
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

// ─────────── FG-578: the retention parse seam ───────────
//
// upgrade counts installer stdout lines starting with "Installing" to report what
// it refreshed. That string seam is where a FALSE REFRESH CLAIM gets manufactured
// with nobody deciding to make one: leave the installer echoing "Installing
// forge-raci.md" while it skips the copy, and upgrade reports a refresh that did
// not happen. The two halves of the contract are pinned here — a retained file is
// announced on its OWN line, and that line is not an "Installing" line.

test("FG-578: a retained file is parsed off its own line, keyed by $FORGE_HOME-relative path", () => {
  assert.equal(
    parseRetainedLine("Retained: forge-raci.md (differs from this release's seed at /rel/seeds/forge-raci.md)"),
    "forge-raci.md",
  );
  assert.equal(
    parseRetainedLine("Retained: agents/engineer/CLAUDE.md (differs from this release's seed at /rel/seeds/agents/engineer/CLAUDE.md)"),
    "agents/engineer/CLAUDE.md",
    "the key is relative to $FORGE_HOME — the same key seed-drift reports drift under",
  );
});

test("FG-578: a retained line is NOT an 'Installing' line, and vice versa — the false-refresh seam", () => {
  const retained = "Retained: forge-raci.md (differs from this release's seed at /rel/seeds/forge-raci.md)";
  const installing = "Installing runtimes into /home/u/.forge/runtimes/";
  // The exact predicate upgrade.ts counts refreshes with. If the retention line
  // ever started with "Installing", the retained file would be counted as
  // refreshed — the precise defect FG-578 forbids.
  assert.equal(retained.startsWith("Installing"), false, "a retained file must never be counted as refreshed");
  assert.equal(parseRetainedLine(installing), null, "an actual install is not a retention");
  // The human header of the retention block carries no path, so it must not parse
  // as a retained entry and inflate the machine-readable list.
  assert.equal(parseRetainedLine("Retained (operator-authored — forge did not overwrite these, and did not refresh them):"), null);
  assert.equal(parseRetainedLine("Done."), null);
});
