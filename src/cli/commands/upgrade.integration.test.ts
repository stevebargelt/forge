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
    assert.match(stdout, /Upgrade INCOMPLETE — dev advancement refused/);
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
