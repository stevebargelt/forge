import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tryGitPull } from "./upgrade.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-upgrade-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function initRepo(opts: { withRemote?: boolean; dirty?: boolean } = {}): void {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@test"', { cwd: dir });
  execSync('git config user.name "test"', { cwd: dir });
  execSync('git commit -q --allow-empty -m "initial"', { cwd: dir });
  if (opts.withRemote) {
    execSync('git remote add origin https://invalid.example.invalid/repo.git', { cwd: dir });
  }
  if (opts.dirty) {
    execSync("touch dirty-file && git add dirty-file", { cwd: dir });
  }
}

test("tryGitPull: returns 'no-remote' when repo has no remote configured", () => {
  initRepo({ withRemote: false });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "no-remote");
});

test("tryGitPull: returns 'dirty' when working tree has uncommitted changes", () => {
  initRepo({ withRemote: true, dirty: true });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "dirty");
});

test("tryGitPull: dirty takes priority over no-remote check", () => {
  initRepo({ withRemote: false, dirty: true });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "dirty");
});

test("tryGitPull: dry-run with remote + clean tree returns 'ok' without actually fetching", () => {
  initRepo({ withRemote: true });
  const r = tryGitPull(dir, /* dryRun */ true);
  assert.equal(r.kind, "ok");
});

test("tryGitPull: returns 'error' when not a git repo", () => {
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.ok(r.kind === "error" || r.kind === "no-remote");
});

// ─────────── FG-577 (criteria 1, 2, 3): EXECUTED asset repair from a release ───────────
//
// Release mode is reachable without promoting this host: a disposable tree
// carrying a manifest plus the required asset dirs IS a release for every
// purpose this ticket touches. The install prefix is a disposable FORGE_HOME and
// the skills prefix is disposable too — nothing here touches the real ~/.forge,
// ~/.claude, or ~/code/forge.

import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runUpgrade, upgradeAssetPaths } from "./upgrade.js";
import { compilePolicyFile } from "../../raci/host-policy.js";
import { assetRoot, executionModeFrom } from "../../v2/asset-root.js";

/** A tree shaped like a release: manifest + the REQUIRED asset dirs, carrying
 *  `marker` as the content of every asset whose bytes we later compare. */
function assetTree(prefix: string, marker: string, opts: { manifest?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, "seeds", "agents"), { recursive: true });
  mkdirSync(join(base, "seeds", "constraints"), { recursive: true });
  mkdirSync(join(base, "seeds", "runtimes"), { recursive: true });
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(join(base, "seeds", "runtimes", "pi-apikey.yml"), `# ${marker}\nprovider: ${marker}\n`);
  writeFileSync(join(base, "seeds", "agents", "note.md"), `${marker} agent\n`);
  writeFileSync(join(base, "seeds", "constraints", "note.md"), `${marker} constraint\n`);
  writeFileSync(join(base, "seeds", "orchestrator-template.md"), `${marker} TEMPLATE\n`);
  // The real installer, unmodified — it already resolves its own $HERE, so a
  // release-bundled copy installs the release's seeds. The bug was the caller.
  cpSync(join(assetRoot(), "scripts", "install-seeds.sh"), join(base, "scripts", "install-seeds.sh"));
  if (opts.manifest !== false) {
    writeFileSync(join(base, "forge-release.json"), JSON.stringify({ schema: 1, abi: "137", id: "fg577-fixture" }));
  }
  return base;
}

/** runUpgrade reports failure through process.exitCode, so a test that drives it
 *  must not leak that to the test runner — a leaked 1 would fail this whole file
 *  with every test passing. Captures what the action set and restores the
 *  process's own. */
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

/** Capture the operator-facing stdout of one action. */
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.log = realLog; }
  return lines.join("\n");
}

/** Drive the REAL `forge upgrade` action as a release. The whole action runs —
 *  so a refusal placed anywhere upstream of the installer (the MEDIUM-5 trap)
 *  shows up here as an absent install, not as a passing test. FORGE_HOME is
 *  already a disposable temp dir for every test process (src/test-setup.ts), so
 *  the install prefix is disposable and the real ~/.forge is never touched. */
function upgradeAsRelease(assetsDir: string, devDir: string): { installed: boolean; body: string; exitCode: number | undefined } {
  const forgeHome = process.env.FORGE_HOME!;
  const exitCode = captureExit(() => runUpgrade({ skipProject: true }, { mode: "release", assetsDir, devDir }));
  const installedPath = join(forgeHome, "runtimes", "pi-apikey.yml");
  return {
    exitCode,
    installed: existsSync(installedPath),
    body: existsSync(installedPath) ? readFileSync(installedPath, "utf8") : "",
  };
}

test("FG-577 (criteria 1, 3): from a release with a DIVERGENT dev checkout, the seed install and the template are RELEASE bytes", () => {
  const release = assetTree("fg577-rel-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-", "DEV", { manifest: false });
  const before = process.env.FORGE_REPO_DIR;
  try {
    assert.equal(executionModeFrom(join(release, "src", "v2")), "release", "the fixture really is a release, by the one mode oracle");
    process.env.FORGE_REPO_DIR = devCheckout; // the hostile/divergent ambient env (F29)

    const { installed, body } = upgradeAsRelease(release, devCheckout);

    // Criterion 1a: the HOST seed install carries release bytes.
    assert.ok(installed, "the release-bundled installer must be reached");
    assert.match(body, /provider: RELEASE/);
    assert.ok(!body.includes("DEV"), "a dev-bytes install is the whole defect");

    // Criterion 1b — the PROJECT orchestrator template — is proven against the
    // production refresh branch in the test below, NOT here: reading
    // upgradeAssetPaths().templatePath back would only prove a helper's return
    // value, and a regression in the branch that consumes it would sail past.
    const { installScript, templatePath } = upgradeAssetPaths(release);

    // Criterion 3: nothing resolved out of the caller-named tree, and that tree
    // was not mutated.
    for (const p of [installScript, templatePath]) {
      assert.ok(!p.startsWith(devCheckout), `${p} must not resolve under FORGE_REPO_DIR`);
    }
    assert.equal(readFileSync(join(devCheckout, "seeds", "runtimes", "pi-apikey.yml"), "utf8"), "# DEV\nprovider: DEV\n", "the dev checkout is untouched");
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

// FG-577 acceptance criterion 1 names the PROJECT ORCHESTRATOR TEMPLATE — the
// production branch at upgrade.ts's project init, which is what audit HIGH-1 was
// about. So drive that branch (no --skip-project) against a disposable project and
// read the bytes it actually WROTE. A seeds-only fix that leaves the template
// resolving out of the dev checkout fails here on "DEV TEMPLATE".
test("FG-577 (criterion 1): the production CLAUDE.md refresh writes the RELEASE's template bytes", () => {
  const release = assetTree("fg577-rel-tmpl-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-tmpl-", "DEV", { manifest: false });
  const project = mkdtempSync(join(tmpdir(), "fg577-proj-"));
  const cwdBefore = process.cwd();
  const repoBefore = process.env.FORGE_REPO_DIR;
  try {
    writeFileSync(join(project, "CLAUDE.md"), [
      "# my project",
      "",
      "<!-- forge:orchestrator-start -->",
      "STALE BLOCK — must be replaced",
      "<!-- forge:orchestrator-end -->",
      "",
      "## project-specific tail",
      "",
    ].join("\n"));
    process.env.FORGE_REPO_DIR = devCheckout; // the divergent ambient env (F29)
    process.chdir(project); // the branch reads process.cwd()

    const exitCode = captureExit(() => runUpgrade({}, { mode: "release", assetsDir: release, devDir: devCheckout }));

    const written = readFileSync(join(project, "CLAUDE.md"), "utf8");
    assert.match(written, /RELEASE TEMPLATE/, "the block must carry the EXECUTING release's template bytes");
    assert.ok(!written.includes("DEV TEMPLATE"), "the named partial fix: seeds re-pointed, template still on dev bytes");
    assert.ok(!written.includes("STALE BLOCK"), "the refresh genuinely ran — otherwise the assertions above are vacuous");
    assert.match(written, /project-specific tail/, "the project's own content outside the fence survives");
    // The advancement half still refused, and that is still a failed request.
    assert.equal(exitCode, 1);
  } finally {
    process.chdir(cwdBefore);
    if (repoBefore === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = repoBefore;
    for (const d of [release, devCheckout, project]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577 (criterion 2): with NO dev checkout on the host at all, release asset repair STILL runs", () => {
  // The test that proves the split landed in the right place. Against a naive
  // blanket refusal at the old upgrade.ts:62 gate this FAILS: that
  // implementation exits before ever reaching the release-bundled installer, so
  // the remedy seed-drift.ts:119 names is unavailable exactly in the broken
  // state — a fail-closed availability defect, not a fix.
  const release = assetTree("fg577-rel-nodev-", "RELEASE");
  const absent = join(tmpdir(), "fg577-no-such-checkout-ever");
  try {
    assert.equal(existsSync(absent), false, "the host genuinely has no dev checkout");
    const { installed, body } = upgradeAsRelease(release, absent);
    assert.ok(installed, "asset repair must not be gated on a dev checkout that does not exist");
    assert.match(body, /provider: RELEASE/);
  } finally {
    rmSync(release, { recursive: true, force: true });
  }
});

test("FG-577 (criterion 7): driving the real action as a release refuses advancement and mutates no checkout", () => {
  const release = assetTree("fg577-rel-refuse-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-refuse-", "DEV", { manifest: false });
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  let stdout = "";
  try {
    const exitCode = captureExit(() => {
      stdout = captureLog(() => runUpgrade({ skipProject: true }, { mode: "release", assetsDir: release, devDir: devCheckout }));
    });
    const text = warnings.join("\n");
    assert.match(text, /refusing to advance the dev checkout/, "the named refusal, not an EACCES");
    assert.match(text, /cd .* && git pull && npm install/, "carries steps the operator can actually run");
    // Criterion 10: EXIT CODE is a consumer surface of a refusal, not just the
    // warning text. An ordinary release-mode advancement refusal is a requested
    // action that did not happen — it may not complete with the inherited success
    // code, and it may not claim completion on stdout either.
    assert.equal(exitCode, 1, "a refused request must not exit 0");
    assert.ok(!stdout.includes("Upgrade complete."), "the closing line must agree with the exit code");
    assert.match(stdout, /Upgrade INCOMPLETE — git pull refused \(release\); npm install refused \(release\)/);
    // BD-13: the checkout is not advanced under the operator.
    assert.equal(existsSync(join(devCheckout, ".git")), false);
    assert.equal(readFileSync(join(devCheckout, "seeds", "runtimes", "pi-apikey.yml"), "utf8"), "# DEV\nprovider: DEV\n");
  } finally {
    console.warn = realWarn;
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

// The asset half is the SOLE remedy on a release host (FG-577), so a failed
// install-seeds.sh reporting success is the exit code overstating exactly the
// state this ticket targets. Driven in DEV mode with advancement skipped, so the
// install failure is the ONLY unresolved item — a refusal cannot mask a
// regression here.
test("FG-577: a FAILED asset install exits nonzero and does not claim completion", () => {
  const assets = assetTree("fg577-failinstall-", "RELEASE", { manifest: false });
  try {
    // Break the FIXTURE's bundled copy — scripts/install-seeds.sh in the repo is
    // FG-578's and is not touched.
    writeFileSync(join(assets, "scripts", "install-seeds.sh"), "#!/usr/bin/env bash\necho 'seed install exploded' >&2\nexit 17\n");

    let stdout = "";
    const exitCode = captureExit(() => {
      stdout = captureLog(() => runUpgrade(
        { skipProject: true, skipGit: true, skipNpm: true },
        { mode: "dev", assetsDir: assets, devDir: assets },
      ));
    });

    assert.match(stdout, /\[3\/4\] install-seeds\.sh: FAILED/, "the failure is reported…");
    assert.equal(exitCode, 1, "…and carried in the exit code, not swallowed");
    assert.ok(!stdout.includes("Upgrade complete."), "a failed sole remedy must not print completion");
    assert.match(stdout, /Upgrade INCOMPLETE — install-seeds\.sh FAILED/);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577: a clean dev upgrade still exits 0 and still says complete", () => {
  // The guard on the two tests above: they must fire on the defect, not on every
  // run. Same action, nothing refused and nothing failed.
  const assets = assetTree("fg577-clean-", "CLEAN", { manifest: false });
  try {
    let stdout = "";
    const exitCode = captureExit(() => {
      stdout = captureLog(() => runUpgrade(
        { skipProject: true, skipGit: true, skipNpm: true },
        { mode: "dev", assetsDir: assets, devDir: assets },
      ));
    });
    assert.equal(exitCode, undefined, "nothing refused, nothing failed → the inherited success code stands");
    assert.match(stdout, /Upgrade complete\./);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

// ─────────── FG-577 (criterion 10): the refusal on the --json consumer ───────────
//
// The acceptance names EVERY consumer, and a refusal that exists only as console
// prose is unreadable to the scripted half of them. These drive the same real
// action as the tests above, so a JSON surface that drifted from the human one
// (or from the exit code) fails here rather than in a caller's parser.

test("FG-577 (criterion 10): the release-mode refusal reaches the --json consumer, not just the console", () => {
  const release = assetTree("fg577-rel-json-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-json-", "DEV", { manifest: false });
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  let stdout = "";
  try {
    const exitCode = captureExit(() => {
      stdout = captureLog(() => runUpgrade(
        { skipProject: true, json: true },
        { mode: "release", assetsDir: release, devDir: devCheckout },
      ));
    });

    // Parsing IS the assertion that stdout is exactly one document: a single
    // interleaved human progress line breaks every scripted consumer, so a
    // --json that merely appends JSON after the prose fails right here.
    const parsed = JSON.parse(stdout) as {
      ok: boolean; mode: string; unresolved: string[];
      assetInstall: string; imageRebuild: string;
      devAdvancement: { kind: string; lines: string[]; gitPull: string; npmInstall: string };
    };

    assert.equal(parsed.mode, "release");
    assert.equal(parsed.devAdvancement.kind, "refused", "the refusal is a named state, not a boolean the caller must re-derive");
    assert.ok(
      parsed.devAdvancement.lines.some((l) => /refusing to advance the dev checkout/.test(l)),
      "the refusal REGISTER itself is machine-readable — the same named lines the human surface prints",
    );
    assert.ok(
      parsed.devAdvancement.lines.some((l) => /forge-dev upgrade/.test(l)),
      "and carries the actionable remedy, not just a verdict",
    );

    // Per-step, not one lumped verdict: a script can see WHICH half refused.
    assert.equal(parsed.devAdvancement.gitPull, "refused");
    assert.equal(parsed.devAdvancement.npmInstall, "refused");

    // The three surfaces derive from ONE list, so they cannot disagree.
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.unresolved, ["git pull refused (release)", "npm install refused (release)"]);
    assert.equal(exitCode, 1, "--json must agree with the exit code a script also reads");

    // MEDIUM-5 again, on this surface: the refusal does not gate asset repair,
    // and the JSON says so.
    assert.equal(parsed.assetInstall, "installed");
    assert.equal(parsed.imageRebuild, "skipped");
    assert.equal(warnings.length, 0, "--json is the summary, not a second copy of it");
  } finally {
    console.warn = realWarn;
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577 (criterion 10): a clean dev --json reports no refusal", () => {
  // The guard: the test above must fire on the refusal, not on --json itself.
  const assets = assetTree("fg577-clean-json-", "CLEAN", { manifest: false });
  try {
    let stdout = "";
    const exitCode = captureExit(() => {
      stdout = captureLog(() => runUpgrade(
        { skipProject: true, skipGit: true, skipNpm: true, json: true },
        { mode: "dev", assetsDir: assets, devDir: assets },
      ));
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; mode: string; unresolved: string[]; devAdvancement: { kind: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "dev");
    // `not-requested`, not `proceed`: this run skips BOTH advancement steps, and
    // once the skip is ordered ahead of the mode check in dev too (FG-577
    // ordering), the payload says so. The old `proceed` described a decision this
    // run never acted on — neither step ran.
    assert.equal(parsed.devAdvancement.kind, "not-requested");
    assert.deepEqual(parsed.unresolved, []);
    assert.equal(exitCode, undefined);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

// ─────────── FG-577 (criterion 10): the INVERTED default, per cell ───────────
//
// One regression per state that previously yielded exit 0 + "Upgrade complete." +
// `--json ok:true` while the requested action did not happen. Each was proven red
// against HEAD~ (the three-push allowlist) before this pass: with `unresolved`
// built from three literals, every assertion below on exitCode / INCOMPLETE /
// ok:false fails, because the state was not on the allowlist.
//
// Every one drives the REAL action against a disposable assets tree and the
// per-process disposable FORGE_HOME. Nothing here touches ~/.forge, ~/code/forge,
// npm link, or this host's promotion.

/** Drive the real action in dev mode with advancement + project skipped unless a
 *  test overrides, and report every consumer surface at once. */
function drive(options: Parameters<typeof runUpgrade>[0], env: Parameters<typeof runUpgrade>[1]): {
  exitCode: number | undefined; stdout: string; warnings: string; result: UpgradeResult;
} {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  let stdout = "";
  let result!: UpgradeResult;
  try {
    const exitCode = captureExit(() => {
      stdout = captureLog(() => { result = runUpgrade(options, env); });
    });
    return { exitCode, stdout, warnings: warnings.join("\n"), result };
  } finally {
    console.warn = realWarn;
  }
}

/** Every closed cell asserts the SAME three surfaces, because criterion 10 is
 *  about all of them agreeing — a cell closed on --json alone is still exit 0 to
 *  a shell script, and a cell closed on the exit code alone is still ok:true to a
 *  parser. */
function assertUnresolved(r: ReturnType<typeof drive>, reason: RegExp): void {
  assert.equal(r.exitCode, 1, "exit code: a requested action that did not happen is a failed request");
  assert.ok(!r.stdout.includes("Upgrade complete."), "completion line: must not claim completion");
  assert.match(r.stdout, /Upgrade INCOMPLETE — /, "completion line: says so, and says why");
  assert.equal(r.result.ok, false, "--json: ok must agree with the other two");
  assert.ok(r.result.unresolved.some((u) => reason.test(u)), `--json: unresolved names it truthfully — got ${JSON.stringify(r.result.unresolved)}`);
}

import type { UpgradeResult } from "./upgrade.js";
import { RACI_PATH, ROUTING_POLICY_PATH } from "../../util/paths.js";
// FG-581 (verify): the REAL downstream routing consumer. A quarantined policy is
// only fail-closed if a consumer that USED to route from it now refuses — proving
// non-consumption through behavior, not just a renamed file.
import { governanceView } from "../../raci/governance.js";

// A real, valid host RACI: the shipped seed, which compiles clean. Used to prove
// the SUCCESS path is untouched by the FG-581 fail-closed change. `dirname` /
// `fileURLToPath` are imported later in this file (imports hoist).
const SEED_RACI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "seeds", "forge-raci.md");

test("FG-577 (cell 3): git pull skipped by a DIRTY checkout is unresolved — the operator asked and did not get it", () => {
  const assets = assetTree("fg577-dirty-", "CLEAN", { manifest: false });
  try {
    execSync("git init -q", { cwd: assets });
    execSync('git config user.email "t@t" && git config user.name "t"', { cwd: assets });
    execSync('git commit -q --allow-empty -m i', { cwd: assets });
    execSync("touch uncommitted && git add uncommitted", { cwd: assets });

    const r = drive({ skipProject: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });

    // Human surface: NOT the word that makes it read like --skip-git.
    assert.match(r.stdout, /\[1\/4\] git pull: DID NOT RUN/);
    assert.equal(r.result.devAdvancement.gitPull, "dirty", "distinguished from an operator skip in --json");
    assertUnresolved(r, /uncommitted changes/);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 1): a FAILED npm install is unresolved on every surface", () => {
  const assets = assetTree("fg577-npmfail-", "CLEAN", { manifest: false });
  try {
    writeFileSync(join(assets, "package.json"), "{ this is not valid json");
    const r = drive({ skipProject: true, skipGit: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.match(r.stdout, /\[2\/4\] npm install: FAILED/);
    assert.equal(r.result.devAdvancement.npmInstall, "failed");
    assertUnresolved(r, /npm install FAILED/);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 1): install-seeds.sh NOT FOUND is unresolved — the sole remedy on a release host silently absent", () => {
  const assets = assetTree("fg577-noinstaller-", "CLEAN", { manifest: false });
  try {
    rmSync(join(assets, "scripts", "install-seeds.sh"));
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.match(r.stdout, /\[3\/4\] install-seeds\.sh: NOT FOUND/);
    assert.equal(r.result.assetInstall, "not-found");
    assertUnresolved(r, /install-seeds\.sh NOT FOUND/);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 1): a routing-policy recompile FAILURE is unresolved — the derived policy is now stale", () => {
  const assets = assetTree("fg577-raci-", "CLEAN", { manifest: false });
  try {
    // A host RACI that EXISTS and will not compile. FORGE_HOME is the suite's
    // disposable temp home; the file is removed again below, so no other test in
    // this process inherits it.
    writeFileSync(RACI_PATH, "not a RACI document at all\n");
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.equal(r.result.routingPolicy, "failed");
    assert.match(r.warnings, /routing-policy\.yml NOT recompiled/);
    assertUnresolved(r, /routing-policy\.yml INVALIDATED/);
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

// ─────────── FG-581: fail-closed post-promotion RACI compile refusal ───────────
//
// The binding invariant: after a promotion, if the promoted runtime cannot
// compile the installed operator-authored RACI, the PREVIOUS runtime's compiled
// routing-policy.yml must NOT stay silently authoritative. Every cell drives the
// production `runUpgrade` path against the suite's disposable FORGE_HOME — never
// ~/.forge — with a host RACI present that the (promoted) runtime rejects.

test("FG-581 (RED): a failed post-promotion compile does NOT leave the previous routing-policy.yml authoritative — it is quarantined", () => {
  const assets = assetTree("fg581-quarantine-", "CLEAN", { manifest: false });
  try {
    // The previous runtime's compiled policy is on disk and currently authoritative.
    writeFileSync(ROUTING_POLICY_PATH, "routes: {}\n# previous runtime's compiled policy\n");
    // The promoted runtime is handed a host RACI it cannot compile.
    writeFileSync(RACI_PATH, "not a RACI document at all\n");
    assert.equal(existsSync(ROUTING_POLICY_PATH), true, "precondition: the stale policy exists");

    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });

    // DISCRIMINATING assertion — this FAILS against the pre-fix warn-and-continue
    // code (which left the file untouched) and PASSES after: stale-policy
    // NON-consumption. The file is no longer at its authoritative path.
    assert.equal(existsSync(ROUTING_POLICY_PATH), false, "the stale routing-policy.yml must NOT remain authoritative");
    assert.equal(existsSync(`${ROUTING_POLICY_PATH}.quarantined`), true, "it is quarantined to a sibling name no policy loader matches");
    assert.equal(r.result.routingPolicy, "failed");
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(`${ROUTING_POLICY_PATH}.quarantined`, { force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-581: the refusal NAMES the rejected RACI construct (compiler's verbatim error) on the human warning AND --json, and is signalled as a failure", () => {
  const assets = assetTree("fg581-names-", "CLEAN", { manifest: false });
  try {
    // A RACI shaped enough to reach the compiler but rejected by it — the error
    // string names the offending construct (a non-human accountable role).
    writeFileSync(RACI_PATH, "### route: x\nresponsible: orchestrator\naccountable: not-human\npath: in_session\n");
    const compileError = compilePolicyFile(RACI_PATH, join(assets, "probe.yml"), { write: false });
    assert.equal(compileError.ok, false, "fixture precondition: this RACI really does not compile");
    const errText = (compileError as { ok: false; error: string }).error;

    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });

    // Human warning carries the compiler's exact reason, verbatim.
    assert.ok(r.warnings.includes(errText), `human warning names the rejected construct — got ${JSON.stringify(r.warnings)}`);
    // --json surface carries the SAME verbatim reason (not the generic reason).
    assert.equal(r.result.routingPolicyError, errText, "--json routingPolicyError is the compiler's verbatim error");
    // Failure signalled on every surface (exit 1 / INCOMPLETE / ok:false).
    assertUnresolved(r, /routing-policy\.yml INVALIDATED/);
    // Repair guidance ends in the actionable recompile command.
    assert.match(r.warnings, /forge route compile/, "operator is told how to fix");
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(`${ROUTING_POLICY_PATH}.quarantined`, { force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-581 (dry-run): a compile failure FORECASTS the quarantine and does NOT mutate disk — --json ok and exit code still agree", () => {
  const assets = assetTree("fg581-dryrun-", "CLEAN", { manifest: false });
  try {
    writeFileSync(ROUTING_POLICY_PATH, "routes: {}\n# previous runtime's compiled policy\n");
    writeFileSync(RACI_PATH, "not a RACI document at all\n");

    const r = drive({ dryRun: true, skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });

    // No disk mutation on a forecast: the stale policy is STILL where it was, and
    // no quarantine sibling was created.
    assert.equal(existsSync(ROUTING_POLICY_PATH), true, "dry run must not delete/rename routing-policy.yml");
    assert.equal(existsSync(`${ROUTING_POLICY_PATH}.quarantined`), false, "dry run creates no quarantine file");
    // But it forecasts the invalidation, and ok/exit still agree with a real run.
    assert.match(r.warnings, /would invalidate the stale routing-policy\.yml/);
    assert.equal(r.result.routingPolicy, "failed");
    assert.equal(r.exitCode, 1, "dry-run exit code agrees: this upgrade would NOT complete");
    assert.equal(r.result.ok, false);
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(`${ROUTING_POLICY_PATH}.quarantined`, { force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-581 (success preserved): a VALID host RACI still recompiles routing-policy.yml cleanly — exit 0, ok:true, no new friction", () => {
  const assets = assetTree("fg581-success-", "CLEAN", { manifest: false });
  try {
    // The shipped seed RACI is valid and compiles clean.
    cpSync(SEED_RACI_PATH, RACI_PATH);
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });

    assert.equal(r.result.routingPolicy, "recompiled", "the success path is unchanged");
    assert.equal(r.result.routingPolicyError, null, "no error surfaced on success");
    assert.equal(existsSync(ROUTING_POLICY_PATH), true, "the derived policy is written, not quarantined");
    assert.equal(existsSync(`${ROUTING_POLICY_PATH}.quarantined`), false, "nothing quarantined on success");
    assert.equal(r.exitCode, undefined, "exit 0");
    assert.equal(r.result.ok, true);
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-581 (fail-closed): a quarantine rename FAILURE falls back to REMOVING the stale policy — it does not stay authoritative, and the command does not crash", () => {
  const assets = assetTree("fg581-quarantine-fail-", "CLEAN", { manifest: false });
  const quarantinePath = `${ROUTING_POLICY_PATH}.quarantined`;
  try {
    // The previous runtime's compiled policy is on disk and currently authoritative.
    writeFileSync(ROUTING_POLICY_PATH, "routes: {}\n# previous runtime's compiled policy\n");
    // The promoted runtime is handed a host RACI it cannot compile.
    writeFileSync(RACI_PATH, "not a RACI document at all\n");
    // Force renameSync to fail: a DIRECTORY sits at the quarantine destination, and a
    // file cannot be renamed over a directory. Pre-fix, the bare renameSync throws —
    // the exception escapes AND the stale policy stays where it is (fail-OPEN). The
    // fix must catch that and fall back to unlinking the stale policy.
    mkdirSync(quarantinePath, { recursive: true });

    let threw: unknown = null;
    let r!: ReturnType<typeof drive>;
    try {
      r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    } catch (e) {
      threw = e;
    }

    // (a) the command does not crash on the rename failure.
    assert.equal(threw, null, "a quarantine rename failure must not escape and crash the command");
    // (b) the stale routing-policy.yml is NOT left authoritative — the fallback unlink
    // removed it. This is the fail-closed invariant; the pre-fix code fails it.
    assert.equal(existsSync(ROUTING_POLICY_PATH), false, "fail-open would leave the stale policy here; the fallback unlink must remove it");
    // (c) the refusal still renders on every surface.
    assert.equal(r.result.routingPolicy, "failed");
    assert.equal(r.result.ok, false);
    assert.equal(r.exitCode, 1);
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(quarantinePath, { recursive: true, force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-581 (AC c): the REAL --json serialization path emits ok:false, the rejected construct in `unresolved`, and routingPolicyError verbatim", () => {
  const assets = assetTree("fg581-json-", "CLEAN", { manifest: false });
  try {
    // A RACI shaped enough to reach the compiler but rejected by it — the error
    // names the offending construct (a non-human accountable role).
    writeFileSync(RACI_PATH, "### route: x\nresponsible: orchestrator\naccountable: not-human\npath: in_session\n");
    const compileError = compilePolicyFile(RACI_PATH, join(assets, "probe.yml"), { write: false });
    assert.equal(compileError.ok, false, "fixture precondition: this RACI really does not compile");
    const errText = (compileError as { ok: false; error: string }).error;

    // Drive the REAL --json production branch (json:true) so the
    // `if (json) console.log(JSON.stringify(result))` path actually runs — the prior
    // FG-581 tests inspect the returned object and never exercise serialization.
    const r = drive({ json: true, skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });

    // Parse the ACTUAL serialized payload a --json consumer reads off stdout.
    const parsed = JSON.parse(r.stdout) as UpgradeResult;
    assert.equal(parsed.ok, false, "--json ok:false on a post-promotion compile failure");
    assert.ok(
      parsed.unresolved.some((u) => /routing-policy\.yml INVALIDATED/.test(u)),
      `--json unresolved names the refusal — got ${JSON.stringify(parsed.unresolved)}`,
    );
    assert.equal(parsed.routingPolicyError, errText, "--json routingPolicyError carries the compiler's verbatim error string");
    assert.equal(r.exitCode, 1, "--json still sets the exit code a shell script reads");
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(`${ROUTING_POLICY_PATH}.quarantined`, { force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

// The engineer's FG-581 (RED) cell proves the stale policy is renamed off its
// authoritative PATH. This cell proves the CONSEQUENCE that path change exists
// for: a real downstream consumer (governanceView, backing `forge route
// governance` + the dashboard panel) that WOULD route from the stale policy now
// fails closed instead. That is the binding invariant expressed as behavior — the
// previous runtime's routing-policy.yml is genuinely no longer authoritative, not
// merely moved. Drives the same production `runUpgrade` path against the suite's
// disposable FORGE_HOME.
test("FG-581 (downstream fail-closed): after a failed post-promotion compile, a consumer that USED to route from the stale policy now fails closed (policy_not_found)", () => {
  const assets = assetTree("fg581-downstream-", "CLEAN", { manifest: false });
  // A VALID compiled policy — governanceView loads it and routes from it. This is
  // exactly the previous runtime's authoritative artifact, not a broken stub.
  const VALID_STALE_POLICY = [
    "version: 1",
    "governance:",
    "  accountable: human",
    "routes:",
    "  stale_route:",
    "    responsible: orchestrator",
    "    path: in_session",
    "    consulted: []",
    "    required_followups: []",
    "    informed: []",
    "    force_rules: []",
    "",
  ].join("\n");
  try {
    writeFileSync(ROUTING_POLICY_PATH, VALID_STALE_POLICY);

    // PRE-condition: the stale policy is authoritative to the live consumer — it
    // returns the stale routes. This is what makes the post-assertion a claim about
    // NON-consumption rather than about an already-absent file.
    const before = governanceView({});
    assert.equal(before.ok, true, "precondition: the stale policy is loadable and authoritative to the routing consumer");
    if (before.ok) assert.ok(before.routes.stale_route, "…and the consumer really is routing from the stale rules");

    // The promoted runtime is handed a host RACI it cannot compile.
    writeFileSync(RACI_PATH, "not a RACI document at all\n");

    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.equal(r.result.routingPolicy, "failed");

    // POST-condition — the binding invariant, proven through the REAL consumer: the
    // stale policy is no longer consumed. governanceView now fails closed with
    // `policy_not_found` rather than returning the stale routes it returned above.
    const after = governanceView({});
    assert.equal(after.ok, false, "the stale policy must NOT remain silently authoritative to the routing consumer");
    if (!after.ok) {
      assert.ok(
        after.findings.some((f) => f.code === "policy_not_found"),
        `the consumer fails closed (policy_not_found) — got ${JSON.stringify(after.findings)}`,
      );
    }
  } finally {
    rmSync(RACI_PATH, { force: true });
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(`${ROUTING_POLICY_PATH}.quarantined`, { force: true });
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 1): a host with NO RACI is resolved — there is no derived artifact to keep in lockstep", () => {
  // The guard on the test above: it must fire on a compile failure, not on every
  // host that has never installed a RACI.
  const assets = assetTree("fg577-noraci-", "CLEAN", { manifest: false });
  try {
    assert.equal(existsSync(RACI_PATH), false, "the disposable FORGE_HOME really has no RACI");
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.equal(r.result.routingPolicy, "no-raci");
    assert.equal(r.exitCode, undefined);
    assert.equal(r.result.ok, true);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

/** Run one action with cwd pointed at a disposable project dir. */
function inProject(claudeMd: string | null, fn: (project: string) => void): void {
  const project = mkdtempSync(join(tmpdir(), "fg577-proj-"));
  const cwdBefore = process.cwd();
  try {
    if (claudeMd !== null) writeFileSync(join(project, "CLAUDE.md"), claudeMd);
    process.chdir(project);
    fn(project);
  } finally {
    process.chdir(cwdBefore);
    rmSync(project, { recursive: true, force: true });
  }
}

test("FG-577 (cell 1): a project that was never inited is unresolved — no CLAUDE.md", () => {
  const assets = assetTree("fg577-noclaude-", "CLEAN", { manifest: false });
  try {
    inProject(null, () => {
      const r = drive({ skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(r.result.projectInit, "no-claude-md");
      assertUnresolved(r, /no CLAUDE\.md/);
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 1): a CLAUDE.md with no forge block is unresolved — the requested re-init did not happen", () => {
  const assets = assetTree("fg577-noblock-", "CLEAN", { manifest: false });
  try {
    inProject("# some other project\n\nnothing forge about it.\n", () => {
      const r = drive({ skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(r.result.projectInit, "no-forge-block");
      assertUnresolved(r, /no forge orchestrator block/);
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 1): a MISSING orchestrator template is unresolved — the block was not refreshed", () => {
  const assets = assetTree("fg577-notmpl-", "CLEAN", { manifest: false });
  try {
    rmSync(join(assets, "seeds", "orchestrator-template.md"));
    inProject([
      "# p", "", "<!-- forge:orchestrator-start -->", "STALE", "<!-- forge:orchestrator-end -->", "",
    ].join("\n"), () => {
      const r = drive({ skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(r.result.projectInit, "template-not-found");
      assertUnresolved(r, /template missing from the executing tree/);
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 1): an orchestrator block needing manual markers is unresolved", () => {
  const assets = assetTree("fg577-markers-", "CLEAN", { manifest: false });
  try {
    // A lone END marker with no heading to anchor a start: applyOrchestratorBlock
    // refuses to guess the boundary, so the block is NOT refreshed.
    inProject("# p\n\nbody\n\n<!-- forge:orchestrator-end -->\n", () => {
      const r = drive({ skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(r.result.projectInit, "needs-markers");
      assertUnresolved(r, /needs manual markers/);
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

// ─────────── FG-577: a project-local slash-command override ───────────
//
// The state the ⚠ warned about but --json had no field for: a script parsing the
// result saw `projectInit: refreshed`, `ok: true`, and no trace that /orient was
// never installed. It is not unresolved — the project owns that file and forge
// declining to clobber it is the command working — but "not a failure" is not
// "not a state", and the machine surface has to carry it.

test("FG-577: a project-local slash-command override reaches --json, not only the human ⚠", () => {
  const assets = assetTree("fg577-override-", "CLEAN", { manifest: false });
  try {
    inProject("# p\n\n<!-- forge:orchestrator-start -->\nSTALE\n<!-- forge:orchestrator-end -->\n", (project) => {
      // The project's OWN /orient — a regular file where forge would symlink.
      const commandsDir = join(project, ".claude", "commands");
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, "orient.md"), "# my project's own /orient\n");

      const r = drive({ skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });

      assert.equal(r.result.slashCommands, "user-override");
      assert.ok(
        r.result.slashCommandOverrides.some((o) => /^\/orient NOT installed/.test(o)),
        `--json names WHICH command and why — got ${JSON.stringify(r.result.slashCommandOverrides)}`,
      );
      assert.match(r.warnings, /\/orient was NOT installed/, "the human surface still says it too");
      // The project's file is untouched — the whole reason this state exists.
      assert.equal(readFileSync(join(commandsDir, "orient.md"), "utf8"), "# my project's own /orient\n");

      // Resolved: a signal that fires forever on every project that deliberately
      // owns its own /orient is not a signal.
      assert.equal(r.result.ok, true);
      assert.equal(r.exitCode, undefined);
      assert.equal(r.result.projectInit, "refreshed", "the rest of the project init still ran");
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577: the override ⚠ is a RENDER of the payload — suppressed by --json, and printed on a dry run", () => {
  // The OTHER escape hatch in this model (the shape fixed in 70908d0): a direct
  // console.warn that reaches a consumer surface without passing through the step
  // outcome. This one is now backed by a discriminant (`slashCommands` +
  // `slashCommandOverrides`), so it is not a classification escape — but it was
  // still ordered like a side-channel: written straight to the console even under
  // --json, and only from the executed branch, so a dry run predicted the state in
  // its payload while telling the human nothing.
  const assets = assetTree("fg577-override-render-", "CLEAN", { manifest: false });
  const claudeMd = "# p\n\n<!-- forge:orchestrator-start -->\nSTALE\n<!-- forge:orchestrator-end -->\n";
  try {
    inProject(claudeMd, (project) => {
      const commandsDir = join(project, ".claude", "commands");
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, "orient.md"), "# my project's own /orient\n");

      const j = drive({ skipGit: true, skipNpm: true, json: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(j.warnings, "", "--json is the whole answer, not a document with a warning shouted beside it");
      assert.ok(j.result.slashCommandOverrides.length > 0, "…and the state is still IN that answer, not lost with the ⚠");
      assert.equal(j.result.slashCommands, "user-override");
    });

    inProject(claudeMd, (project) => {
      const commandsDir = join(project, ".claude", "commands");
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(join(commandsDir, "orient.md"), "# my project's own /orient\n");

      const d = drive({ skipGit: true, skipNpm: true, dryRun: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.match(d.warnings, /\/orient was NOT installed/, "the dry run reports the decision the real run would make");
      assert.equal(d.result.slashCommands, "user-override");
      assert.equal(readFileSync(join(project, ".claude", "commands", "orient.md"), "utf8"), "# my project's own /orient\n", "and still mutates nothing");
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577: with no override, the same project reports the commands INSTALLED and an empty override list", () => {
  // The guard: `user-override` must fire on the override, not on every project.
  const assets = assetTree("fg577-nooverride-", "CLEAN", { manifest: false });
  try {
    inProject("# p\n\n<!-- forge:orchestrator-start -->\nSTALE\n<!-- forge:orchestrator-end -->\n", () => {
      const r = drive({ skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(r.result.slashCommands, "installed");
      assert.deepEqual(r.result.slashCommandOverrides, []);
      assert.equal(r.result.ok, true);
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577: a project upgrade nobody asked for reports slashCommands `not-run`, not a false `installed`", () => {
  const assets = assetTree("fg577-slash-skipped-", "CLEAN", { manifest: false });
  try {
    inProject("# p\n\n<!-- forge:orchestrator-start -->\nSTALE\n<!-- forge:orchestrator-end -->\n", () => {
      const r = drive({ skipGit: true, skipNpm: true, skipProject: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(r.result.slashCommands, "not-run");
      assert.deepEqual(r.result.slashCommandOverrides, []);
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 4): a FAILED --rebuild-image is unresolved and visible in --json, not a warning beside ok:true", () => {
  const assets = assetTree("fg577-rebuildfail-", "CLEAN", { manifest: false });
  try {
    // No docker/ in the fixture, so build.sh cannot run and the rebuild fails —
    // no docker daemon is involved, and nothing on this host is built.
    assert.equal(existsSync(join(assets, "docker")), false);
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true, rebuildImage: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.equal(r.result.imageRebuild, "failed");
    assertUnresolved(r, /image rebuild FAILED/);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 5): after the asset install did not run, the release-check tail does NOT report on an untouched host", () => {
  const assets = assetTree("fg577-tailgate-", "CLEAN", { manifest: false });
  try {
    rmSync(join(assets, "scripts", "install-seeds.sh"));
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    // The defect: the tail gated on !dryRun only, so it ran against a ~/.forge
    // this upgrade never touched and presented that stale state as a fresh verdict.
    assert.equal(r.result.releaseCheck, "skipped-asset-install");
    assert.equal(r.result.releaseProblems, null, "no verdict is published about a host this upgrade did not modify");
    assert.doesNotMatch(r.stdout, /Release check: ✓/, "and it may not print a green tick over an unrefreshed host");
    assert.match(r.stdout, /Release check: not run — host seeds were not refreshed/, "the operator is told WHY there is no verdict");
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 5): when the asset install DID run, the tail still runs and publishes its verdict", () => {
  // The guard: the gate above must fire on the unrefreshed host, not disable the
  // tail outright.
  const assets = assetTree("fg577-tailruns-", "CLEAN", { manifest: false });
  try {
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.equal(r.result.assetInstall, "installed");
    assert.equal(r.result.releaseCheck, "ran");
    assert.ok(Array.isArray(r.result.releaseProblems), "the verdict is published to --json too");
    assert.match(r.stdout, /Release check/);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

// ─────────── FG-577 (cell 6): dry-run honesty ───────────

test("FG-577 (cell 6): on a dry run --json `ok` and the exit code AGREE", () => {
  // The one surviving disagreement between surfaces: `--dry-run` on a release
  // yielded ok:false at exit 0. Two consumers of one run, contradicting.
  const release = assetTree("fg577-dryrel-", "RELEASE");
  const devCheckout = assetTree("fg577-drydev-", "DEV", { manifest: false });
  try {
    const r = drive({ skipProject: true, dryRun: true }, { mode: "release", assetsDir: release, devDir: devCheckout });
    assert.equal(r.result.ok, false, "the refusal is real and predictable on a dry run");
    assert.equal(r.exitCode, 1, "…so the exit code must say the same thing --json does");
  } finally {
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577 (cell 6): a clean dry run agrees the other way, and says what it CANNOT predict", () => {
  const assets = assetTree("fg577-dryclean-", "CLEAN", { manifest: false });
  try {
    const r = drive({ skipProject: true, skipGit: true, skipNpm: true, dryRun: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.equal(r.result.ok, true);
    assert.equal(r.exitCode, undefined);
    assert.equal(r.result.assetInstall, "would-install");
    // The old "Dry run complete." implied a clean forecast while the run was
    // STRUCTURALLY BLIND to every state that requires execution to observe.
    assert.ok(!r.stdout.includes("Dry run complete."), "must not imply a verdict it did not compute");
    assert.match(r.stdout, /NOT predicted/, "names its own blindness…");
    assert.match(r.stdout, /would SUCCEED is unknown/, "…specifically, that it cannot forecast execution outcomes");
    assert.equal(r.result.releaseCheck, "skipped-dry-run");
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (cell 2): operator-requested skips are RESOLVED but still VISIBLE in --json", () => {
  // A skip is the operator's call, not a failure — but a payload that omits it
  // makes "did the pull happen?" unanswerable to a script.
  const assets = assetTree("fg577-skips-", "CLEAN", { manifest: false });
  try {
    inProject("# p\n\nno forge block\n", () => {
      const r = drive({ skipGit: true, skipNpm: true, skipProject: true }, { mode: "dev", assetsDir: assets, devDir: assets });
      assert.equal(r.result.devAdvancement.gitPull, "skipped");
      assert.equal(r.result.devAdvancement.npmInstall, "skipped");
      assert.equal(r.result.projectInit, "skipped");
      assert.equal(r.result.imageRebuild, "skipped");
      assert.equal(r.result.ok, true, "operator-requested is not a failure");
      assert.equal(r.exitCode, undefined);
      assert.match(r.stdout, /Upgrade complete\./);
    });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

// ─────────── FG-577: an operator skip outranks the mode refusal ───────────
//
// Before this fix there was NO flag combination that yielded a clean `forge
// upgrade` on a release host — the normal state of every promoted machine exited
// 1. An exit code that is always 1 in the common path is noise, and it discredits
// the `unresolved` model the rest of this ticket built. The classification was
// right; the ORDERING was wrong.

test("FG-577: --skip-git --skip-npm on a release COMPLETES — the operator skipped exactly what the release cannot do", () => {
  const release = assetTree("fg577-rel-skips-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-skips-", "DEV", { manifest: false });
  try {
    const r = drive(
      { skipProject: true, skipGit: true, skipNpm: true },
      { mode: "release", assetsDir: release, devDir: devCheckout },
    );

    assert.equal(r.exitCode, undefined, "nothing was refused — an operator skip is the operator's own call, not a failed request");
    assert.match(r.stdout, /Upgrade complete\./);
    assert.deepEqual(r.result.unresolved, []);

    // Visible as skips, not laundered into silence: a script can still answer
    // "did the pull happen?".
    assert.equal(r.result.devAdvancement.gitPull, "skipped");
    assert.equal(r.result.devAdvancement.npmInstall, "skipped");
    assert.equal(r.result.devAdvancement.kind, "not-requested");
    assert.deepEqual(r.result.devAdvancement.lines, [], "no refusal register for a refusal that never happened");
    assert.equal(r.warnings, "", "and no refusal warning on the console either");

    // The asset half — the whole point of running upgrade on a release — still ran.
    assert.equal(r.result.assetInstall, "installed");
    // The checkout is still not advanced under the operator.
    assert.equal(readFileSync(join(devCheckout, "seeds", "runtimes", "pi-apikey.yml"), "utf8"), "# DEV\nprovider: DEV\n");

    // The scripted consumer of the same run agrees — `--json` is a surface of its
    // own, and an exit 0 beside ok:false is two answers to one question.
    const j = drive(
      { skipProject: true, skipGit: true, skipNpm: true, json: true },
      { mode: "release", assetsDir: release, devDir: devCheckout },
    );
    const parsed = JSON.parse(j.stdout) as { ok: boolean; unresolved: string[] };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.unresolved, []);
    assert.equal(j.exitCode, undefined);
  } finally {
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577: --skip-git alone on a release classifies the two steps INDEPENDENTLY", () => {
  // The guard against fixing the above by weakening the refusal generally: npm
  // advancement WAS requested here, and a release still cannot do it.
  const release = assetTree("fg577-rel-halfskip-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-halfskip-", "DEV", { manifest: false });
  try {
    const r = drive(
      { skipProject: true, skipGit: true },
      { mode: "release", assetsDir: release, devDir: devCheckout },
    );

    assert.equal(r.result.devAdvancement.gitPull, "skipped", "the operator's skip stands");
    assert.equal(r.result.devAdvancement.npmInstall, "refused", "the unrequested-by-nobody half is still genuinely refused");
    assert.match(r.stdout, /\[1\/4\] git pull: skipped \(--skip-git\)/);
    assert.match(r.stdout, /\[2\/4\] npm install: REFUSED/);
    assert.match(r.warnings, /refusing to advance the dev checkout/, "the refusal register still prints — something really was refused");
    assertUnresolved(r, /npm install refused \(release\)/);
    assert.deepEqual(r.result.unresolved, ["npm install refused (release)"], "and ONLY npm — the skip is not on the list");
  } finally {
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577 (ordering): a release dry run with --rebuild-image reports the REFUSAL on all three surfaces", () => {
  // The reported cell: `maybeRebuildImage` returned for `dryRun` before its mode
  // check, so the real command forecast `would-rebuild` — classified resolved —
  // for an action a release refuses. Human output, --json and the exit status
  // were all falsely clean for a requested dev-checkout action.
  const release = assetTree("fg577-rel-dryrebuild-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-dryrebuild-", "DEV", { manifest: false });
  // FORGE_HOME is disposable but shared by every test in this process, so a
  // sibling's install would make a bare existsSync() assertion lie in both
  // directions. Compare this run's own before/after instead — that is the claim.
  const hostSeed = (): string | null => {
    const p = join(process.env.FORGE_HOME!, "runtimes", "pi-apikey.yml");
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const before = hostSeed();
  try {
    const r = drive(
      { skipProject: true, skipGit: true, skipNpm: true, dryRun: true, rebuildImage: true },
      { mode: "release", assetsDir: release, devDir: devCheckout },
    );

    // The skips take git/npm off the table, so the rebuild is the ONLY thing this
    // run can be unresolved ABOUT — no other refusal can carry these assertions.
    assert.equal(r.result.imageRebuild, "refused", "not `would-rebuild`: a dry run reports the decision, it does not bypass it");
    // The three surfaces, asserted here rather than through `assertUnresolved`:
    // that helper pins the EXECUTED closing line, and a dry run has a closing line
    // of its own. The claim is the same — all three agree, and none reads clean.
    assert.equal(r.exitCode, 1, "exit code: a requested action the mode refuses is a failed request, dry run or not");
    assert.equal(r.result.ok, false, "--json: ok agrees with the exit code");
    assert.deepEqual(r.result.unresolved, ["image rebuild refused (release)"], "--json: named truthfully, and the ONLY thing unresolved here");
    assert.match(r.warnings, /refusing to rebuild the agent image/, "the named refusal reaches the operator on the dry run too");
    assert.match(r.stdout, /Dry run: this upgrade would NOT complete — image rebuild refused \(release\)/, "the closing line agrees with the other two");
    assert.ok(!r.stdout.includes("would-rebuild"), "and never forecasts the action it just refused");

    // …and it is still a dry run: nothing was executed and nothing was written.
    assert.equal(readFileSync(join(devCheckout, "seeds", "runtimes", "pi-apikey.yml"), "utf8"), "# DEV\nprovider: DEV\n", "the checkout is untouched");
    assert.equal(r.result.assetInstall, "would-install", "the asset half is still only forecast");
    assert.equal(hostSeed(), before, "a dry run installs nothing into FORGE_HOME either");
  } finally {
    for (const d of [release, devCheckout] ) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577 (ordering): a dev dry run with --rebuild-image still forecasts, and runs no docker", () => {
  // The guard against fixing the above by refusing dry-run rebuilds generally:
  // dev is the mode that CAN rebuild, so its forecast must survive untouched.
  const assets = assetTree("fg577-dev-dryrebuild-ok-", "CLEAN", { manifest: false });
  try {
    const r = drive(
      { skipProject: true, skipGit: true, skipNpm: true, dryRun: true, rebuildImage: true },
      { mode: "dev", assetsDir: assets, devDir: assets },
    );
    assert.equal(r.result.imageRebuild, "would-rebuild");
    assert.equal(r.result.ok, true);
    assert.equal(r.exitCode, undefined);
    assert.equal(r.warnings, "", "nothing was refused");
    assert.equal(existsSync(join(assets, "docker")), false, "no build.sh was ever reached — there is no docker dir to reach");
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test("FG-577 (ordering): --dry-run without --rebuild-image on a release refuses NOTHING about the image", () => {
  // The request check outranks the mode check: a flag nobody passed cannot be
  // refused. Without this, every release dry run would report a rebuild refusal.
  const release = assetTree("fg577-rel-norebuild-", "RELEASE");
  const devCheckout = assetTree("fg577-dev-norebuild-", "DEV", { manifest: false });
  try {
    const r = drive(
      { skipProject: true, skipGit: true, skipNpm: true, dryRun: true },
      { mode: "release", assetsDir: release, devDir: devCheckout },
    );
    assert.equal(r.result.imageRebuild, "skipped");
    assert.deepEqual(r.result.unresolved, []);
    assert.equal(r.exitCode, undefined);
  } finally {
    for (const d of [release, devCheckout]) rmSync(d, { recursive: true, force: true });
  }
});

// ─────────── FG-577 (criterion 10): the exhaustiveness proof ───────────

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { symlinkSync } from "node:fs";

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(COMMANDS_DIR, "..", "..", "..");

/** Typecheck a DISPOSABLE copy of src/, optionally mutated first.
 *
 *  A copy, not the checkout: an earlier draft of this test wrote its probe into
 *  src/ and ran the project's typecheck in place. That is a mutation of the real
 *  working tree, and the FG-571 promote/identity suites — which snapshot `git
 *  status --porcelain` around themselves — caught it as tree drift when run
 *  concurrently under one `test:integration`. A test that has to be alone to be
 *  correct isn't correct. node_modules is symlinked (read-only use: tsc resolving
 *  types), never copied or written. */
function typecheckCopy(mutate: (source: string) => string): { failed: boolean; output: string } {
  const tmp = mkdtempSync(join(tmpdir(), "fg577-tsc-probe-"));
  try {
    cpSync(join(PKG_ROOT, "src"), join(tmp, "src"), { recursive: true });
    cpSync(join(PKG_ROOT, "tsconfig.json"), join(tmp, "tsconfig.json"));
    cpSync(join(PKG_ROOT, "package.json"), join(tmp, "package.json")); // src/cli/index.ts imports it (resolveJsonModule)
    symlinkSync(join(PKG_ROOT, "node_modules"), join(tmp, "node_modules"));

    const target = join(tmp, "src", "cli", "commands", "upgrade.ts");
    const before = readFileSync(target, "utf8");
    const after = mutate(before);
    writeFileSync(target, after);

    try {
      execSync("npx tsc --noEmit", { cwd: tmp, encoding: "utf8", stdio: "pipe" });
      return { failed: false, output: "" };
    } catch (e) {
      return { failed: true, output: String((e as { stdout?: Buffer }).stdout ?? "") };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** THE test for this pass. Every other test here pins a cell that is closed
 *  TODAY; this one pins that the NEXT cell of this family cannot open silently.
 *
 *  A bounded review loop found this family twice, and each round closed one more
 *  literal — the signature of a fail-OPEN default that was never inverted. So the
 *  claim under test is not "these ten states are handled", it is "an eleventh
 *  state CANNOT be added without a classification". That claim is only worth
 *  anything mechanised: a comment saying `never` proves nothing, and a
 *  hand-written type-level assertion proves only itself. So this really mutates
 *  upgrade.ts — adding an unclassified variant exactly as a future author would —
 *  and really runs the project's own typecheck over the result.
 *
 *  Proven mutation-sensitive: weakening GIT_PULL to `Partial<Record<…>>` with a
 *  `?? resolved` fallback — the precise fail-open shape this pass exists to
 *  remove — turns this test RED while every other test in this file stays green. */
test("FG-577 (criterion 10): a new outcome variant with no classification FAILS the typecheck", () => {
  const probe = typecheckCopy((source) => {
    // The mutation a future author makes: a new thing git pull can do, added to
    // the union and left unclassified. Under the three-push allowlist this
    // compiled and silently meant resolved — exit 0, "Upgrade complete.", ok:true.
    const mutated = source.replace(
      'export type GitPullOutcome =\n  | "pulled"',
      'export type GitPullOutcome =\n  | "detached-head-cannot-fast-forward"\n  | "pulled"',
    );
    assert.notEqual(mutated, source, "the mutation must actually apply — otherwise this test proves nothing");
    return mutated;
  });

  assert.ok(probe.failed, "an unclassified variant must not typecheck — if it does, the default is still fail-OPEN and this whole pass failed");
  assert.match(probe.output, /upgrade\.ts/, "the failure is attributed to the mutated source");
  // Not merely nonzero: the error must BE the missing classification. A probe that
  // failed for an unrelated reason would otherwise sail through this assertion.
  assert.match(probe.output, /detached-head-cannot-fast-forward/, "tsc names the unclassified variant");
  assert.match(probe.output, /Record<GitPullOutcome, Resolution>|is missing the following properties|is not assignable/, "…as a totality violation of the classification table");
});

test("FG-577 (criterion 10): the probe harness is honest — the UNMUTATED source typechecks in the same rig", () => {
  // The guard on the test above: it must fail on the missing classification, not
  // because the rig cannot compile this project at all.
  const probe = typecheckCopy((source) => source);
  assert.equal(probe.failed, false, probe.output);
});

test("FG-577 (cell 1): a FAILED git pull is unresolved on every surface", () => {
  const assets = assetTree("fg577-gitfail-", "CLEAN", { manifest: false });
  try {
    // A .git FILE pointing at a gitdir that isn't there: `git status` fails for a
    // reason of its own, independent of whatever ancestor repo tmpdir() may sit
    // under — so this pins the FAILED branch rather than whichever branch the host
    // happens to produce.
    writeFileSync(join(assets, ".git"), "gitdir: /nonexistent-gitdir-fg577\n");
    const r = drive({ skipProject: true, skipNpm: true }, { mode: "dev", assetsDir: assets, devDir: assets });
    assert.equal(r.result.devAdvancement.gitPull, "failed");
    assert.match(r.stdout, /\[1\/4\] git pull: FAILED/);
    assertUnresolved(r, /git pull FAILED/);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});
