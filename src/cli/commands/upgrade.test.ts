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
  classifyStep, unresolvedReasons,
  type GitPullOutcome, type NpmInstallOutcome, type AssetInstallOutcome, type RoutingPolicyOutcome,
  type ProjectInitOutcome, type SlashCommandsOutcome, type ImageRebuildOutcome, type ReleaseCheckOutcome,
  type AuthoredRetentionOutcome, type UpgradeStepOutcomes, type SeedGenerationOutcome,
  type AgentProtocolOutcome,
  parseRetainedLine,
} from "./upgrade.js";
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
  // ONE string is emitted from TWO paths: the git/npm refusal prints at [1/5] and
  // [2/5] — BEFORE install-seeds runs at [3/5] — while the --rebuild-image refusal
  // prints last, after both. "has already been attempted above" is true only on
  // the second, so the string may not assert a relative order at all.
  for (const action of ["advance the dev checkout (git pull / npm install)", "rebuild the agent image (--rebuild-image)"]) {
    const text = refuseDevAdvance(action, "/rel", "/dev").join("\n");
    assert.doesNotMatch(text, /already been attempted above|attempted above/, `false on the git/npm path: ${action}`);
    assert.match(text, /refreshed from the executing release regardless/, "still promises the asset half, which is the operator's actual remedy");
  }
});

// ─── FG-654 RF-6: the documented numbering IS the numbering the CLI prints ───
//
// The docs describe a five-step upgrade and call the protocol publish step 4. The CLI
// printed four, with the publish carrying no step number at all, so a documented step was
// unfindable in real output. Nothing generates one from the other — they agree by hand —
// so this reads both files and asserts they still do.
test("FG-654 RF-6: docs and CLI agree on five numbered steps, and step 4 is the protocol publish", () => {
  const source = readFileSync(join(repoRoot, "src", "cli", "commands", "upgrade.ts"), "utf8");
  const doc = readFileSync(join(repoRoot, "docs", "how-to-upgrade.md"), "utf8");

  const denominators = [...new Set([...source.matchAll(/\[(\d+)\/(\d+)\]/g)].map((m) => m[2]))];
  assert.deepEqual(denominators, ["5"], "every step label the CLI prints must count out of five");

  for (const [n, label] of [
    ["1", "git pull"],
    ["2", "npm install"],
    ["3", "install-seeds.sh"],
    ["4", "agent protocol region"],
    ["5", "project init"],
  ] as const) {
    assert.ok(source.includes(`[${n}/5] ${label}`), `the CLI must print step ${n} as \`[${n}/5] ${label}\``);
  }

  assert.match(doc, /This runs five steps in sequence:/, "the doc states the same count");
  assert.match(doc, /^4\. \*\*Publish the Forge-owned agent protocol region\*\*/m, "…and numbers the publish 4");
  assert.match(doc, /^5\. \*\*Provision the current project\*\*/m, "…and the project provision 5");
  // The release-mode refusal names the asset half by its step labels, and the doc names the
  // same span in prose. A renumbering that missed either would put them back in conflict.
  assert.ok(source.includes("(steps [3/5], [4/5] and [5/5])"), "the refusal names the asset half by label");
  assert.ok(doc.includes("steps 3 through 5"), "…and the doc names the same span");
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

// FG-654: THREE unresolved facts, and none of them may report as a clean upgrade — each
// leaves at least one of the nine covered roles refusing at every dispatch. `needs-repair`
// is the manual rung (an ambiguous fence, a heading collision, a symlinked seed) and is
// the operator's to fix; `incomplete` is a release carrying no fenced seed for a role, and
// no re-run here converges it; `failed` is the write throwing partway through the nine.
const AGENT_PROTOCOL: Record<AgentProtocolOutcome, Verdict> = {
  published: "resolved",
  "already-current": "resolved",
  "would-publish": "resolved",
  "not-run": "resolved",
  "needs-repair": "unresolved",
  incomplete: "unresolved",
  failed: "unresolved",
};

const EXPECTED: { [K in keyof UpgradeStepOutcomes]: Record<UpgradeStepOutcomes[K], Verdict> } = {
  gitPull: GIT_PULL,
  npmInstall: NPM_INSTALL,
  assetInstall: ASSET_INSTALL,
  seedGeneration: SEED_GENERATION,
  authoredRetention: AUTHORED_RETENTION,
  agentProtocol: AGENT_PROTOCOL,
  routingPolicy: ROUTING_POLICY,
  projectInit: PROJECT_INIT,
  slashCommands: SLASH_COMMANDS,
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
  assert.equal(checked, 8 + 7 + 4 + 4 + 3 + 7 + 5 + 8 + 5 + 5 + 4);
});

test("FG-577 (criterion 10): unresolvedReasons enumerates the outcomes object's own keys", () => {
  // The step LIST is derived from the object, not hand-maintained beside it, so a
  // newly added step is classified by construction rather than by memory.
  const allClean: UpgradeStepOutcomes = {
    gitPull: "pulled", npmInstall: "installed", assetInstall: "installed",
    seedGeneration: "published",
    authoredRetention: "none", agentProtocol: "published", routingPolicy: "recompiled", projectInit: "refreshed",
    slashCommands: "installed", imageRebuild: "ran", releaseCheck: "ran",
  };
  assert.deepEqual(unresolvedReasons(allClean), []);

  assert.deepEqual(
    unresolvedReasons({ ...allClean, gitPull: "dirty" }),
    ["git pull did not run — the dev checkout has uncommitted changes"],
  );
  // Every unresolved step contributes — none masks another.
  const allBroken: UpgradeStepOutcomes = {
    gitPull: "failed", npmInstall: "failed", assetInstall: "failed",
    seedGeneration: "failed",
    // FG-578: `retained` sits in the all-broken row deliberately — even here it
    // must not contribute a reason. The count below is the assertion.
    authoredRetention: "retained", agentProtocol: "needs-repair", routingPolicy: "failed", projectInit: "needs-markers",
    slashCommands: "user-override", imageRebuild: "failed", releaseCheck: "failed",
  };
  // FG-654 adds a ninth: `needs-repair` is unresolved on its own terms.
  assert.equal(unresolvedReasons(allBroken).length, 9);
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
