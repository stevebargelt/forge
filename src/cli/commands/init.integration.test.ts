/**
 * Integration tests for FG-332: forge init scaffold additions.
 *
 * Exercises the full CLI pipeline end-to-end:
 *   forge init --prefix MYPREFIX  →  forge backlog file "ticket"  →  MYPREFIX-NNN
 *
 * Also verifies idempotency: a second `forge init` run must not clobber
 * backlog/notes.md or .forge/model-policy.yml written by the first run.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeHookPlan, planCommitMsgHook } from "./init.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;

function runForge(args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: cwd ?? projectDir,
    encoding: "utf8",
    env: { ...(env ?? process.env), ...authorityTestkitEnv() },
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-init-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── FG-332: --prefix → forge backlog file uses the configured prefix ─────────

test("integ FG-332: forge init --prefix MYPREFIX → forge backlog file creates MYPREFIX-NNN ticket", () => {
  // 1. Run forge init with the prefix flag.
  const initResult = runForge(["init", "--project", projectDir, "--no-install-hooks", "--prefix", "MYPREFIX"]);
  assert.equal(initResult.status, 0, `forge init failed: ${initResult.stderr}`);

  // 2. Verify .forge/config.yml was written with the prefix.
  const configPath = join(projectDir, ".forge", "config.yml");
  assert.ok(existsSync(configPath), ".forge/config.yml should exist after init");
  const configContent = readFileSync(configPath, "utf8");
  assert.match(configContent, /MYPREFIX/, "config.yml should contain the prefix MYPREFIX");

  // 3. Verify the backlog scaffold was created.
  assert.ok(existsSync(join(projectDir, "backlog", "stories")), "backlog/stories/ should exist");
  assert.ok(existsSync(join(projectDir, "backlog", "notes.md")), "backlog/notes.md should exist");

  // 4. Run forge backlog file from within the project dir.
  const fileResult = runForge(["backlog", "file", "test ticket"], projectDir);
  assert.equal(fileResult.status, 0, `forge backlog file failed: ${fileResult.stderr}`);

  // 5. The created ticket file should use the MYPREFIX prefix.
  const storiesDir = join(projectDir, "backlog", "stories");
  const ticketFiles = existsSync(storiesDir) ? readdirSync(storiesDir) : [];
  const ticket = ticketFiles.find((f) => f.startsWith("MYPREFIX-"));
  assert.ok(ticket !== undefined, `Expected a ticket file starting with 'MYPREFIX-' in backlog/stories/, found: ${ticketFiles.join(", ")}`);
  assert.match(ticket, /^MYPREFIX-\d+/, "ticket filename should match MYPREFIX-NNN format");
});

// ─── FG-332: forge init idempotency — second run must not clobber existing files ─

test("integ FG-332: running forge init twice does not clobber backlog/notes.md", () => {
  // First run: scaffold everything.
  const first = runForge(["init", "--project", projectDir, "--no-install-hooks", "--prefix", "FG"]);
  assert.equal(first.status, 0, `first forge init failed: ${first.stderr}`);

  // Write real content into notes.md so a clobber would be detectable.
  const notesPath = join(projectDir, "backlog", "notes.md");
  assert.ok(existsSync(notesPath), "backlog/notes.md should exist after first init");
  const customNotes = "# My session notes\n\nDo not clobber me.\n";
  writeFileSync(notesPath, customNotes);

  // Second run: should be idempotent.
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);

  // notes.md must not have been overwritten.
  const notesAfter = readFileSync(notesPath, "utf8");
  assert.equal(notesAfter, customNotes, "backlog/notes.md must not be clobbered by second forge init");
});

test("integ FG-332: running forge init twice does not clobber .forge/model-policy.yml", () => {
  // First run.
  const first = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(first.status, 0, `first forge init failed: ${first.stderr}`);

  const modelPolicyPath = join(projectDir, ".forge", "model-policy.yml");
  assert.ok(existsSync(modelPolicyPath), ".forge/model-policy.yml should exist after first init");

  // Simulate operator customization.
  const customPolicy = "# custom operator policy\nmodel_profiles: []\n";
  writeFileSync(modelPolicyPath, customPolicy);

  // Second run.
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);

  // model-policy.yml must not have been overwritten.
  const policyAfter = readFileSync(modelPolicyPath, "utf8");
  assert.equal(policyAfter, customPolicy, ".forge/model-policy.yml must not be clobbered by second forge init");
});

test("integ FG-332: running forge init twice does not clobber .forge/docs-surfaces.yml", () => {
  // First run.
  const first = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(first.status, 0, `first forge init failed: ${first.stderr}`);

  const docsSurfacesPath = join(projectDir, ".forge", "docs-surfaces.yml");
  assert.ok(existsSync(docsSurfacesPath), ".forge/docs-surfaces.yml should exist after first init");

  // Simulate operator customization.
  const customSurfaces = "# custom docs surfaces\nsurfaces: []\n";
  writeFileSync(docsSurfacesPath, customSurfaces);

  // Second run.
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);

  // docs-surfaces.yml must not have been overwritten.
  const surfacesAfter = readFileSync(docsSurfacesPath, "utf8");
  assert.equal(surfacesAfter, customSurfaces, ".forge/docs-surfaces.yml must not be clobbered by second forge init");
});

// ─── FG-332: second run output should confirm no-op for already-created items ─

test("integ FG-332: second forge init run reports already-exists for backlog/ and seed files", () => {
  runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  const second = runForge(["init", "--project", projectDir, "--no-install-hooks"]);
  assert.equal(second.status, 0, `second forge init failed: ${second.stderr}`);
  const out = second.stdout;
  assert.match(out, /backlog\/.*no-op|already exists/, "second init should report no-op for backlog/");
  assert.match(out, /model-policy\.yml.*no-op|already exists/, "second init should report no-op for model-policy.yml");
});

// ----- planCommitMsgHook — git-dependent cases (FG-408: moved from unit tier) -----

test("planCommitMsgHook: returns install when .git/hooks exists and no commit-msg present", () => {
  execSync("git init -q", { cwd: projectDir });
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.match(plan.target, /\.git\/hooks\/commit-msg$/);
    assert.match(plan.source, /commit-msg-no-ai-attribution$/);
  }
});

test("planCommitMsgHook: returns already-linked when a symlink already points at our source", () => {
  execSync("git init -q", { cwd: projectDir });
  const prodPlan = planCommitMsgHook(projectDir);
  assert.equal(prodPlan.action, "install");
  if (prodPlan.action !== "install") throw new Error("setup failed");
  symlinkSync(prodPlan.source, prodPlan.target);

  const replan = planCommitMsgHook(projectDir);
  assert.equal(replan.action, "already-linked");
});

test("planCommitMsgHook: returns exists-other when a non-symlink hook is already in place", () => {
  execSync("git init -q", { cwd: projectDir });
  const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
  writeFileSync(hookPath, "#!/bin/sh\necho 'some other hook'\n");
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action === "exists-other") {
    assert.match(plan.details, /regular file/);
  }
});

test("planCommitMsgHook: returns exists-other when a symlink points somewhere else", () => {
  execSync("git init -q", { cwd: projectDir });
  const decoy = join(projectDir, "decoy-hook");
  writeFileSync(decoy, "#!/bin/sh\nexit 0\n");
  const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
  symlinkSync(decoy, hookPath);
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action === "exists-other") {
    assert.match(plan.details, /symlink/);
  }
});

// ----- FG-582: installed hook follows a promotion through $FORGE_HOME/current.
//       Disposable FORGE_HOME + disposable repo; never touches this repo's real
//       .git/hooks. -----

test("FG-582: installed hook symlinks through $FORGE_HOME/current and a promotion changes the bytes a NEW invocation runs", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  try {
    // Two releases, each carrying the SHIPPED hook layout (release.ts copies the
    // whole tree, so the hook lives at scripts/git-hooks/commit-msg-no-ai-attribution).
    const hookRel = join("scripts", "git-hooks", "commit-msg-no-ai-attribution");
    mkdirSync(join(homeDir, "releases", "r-1", "scripts", "git-hooks"), { recursive: true });
    mkdirSync(join(homeDir, "releases", "r-2", "scripts", "git-hooks"), { recursive: true });
    writeFileSync(join(homeDir, "releases", "r-1", hookRel), "#!/bin/sh\n# RELEASE ONE\n");
    writeFileSync(join(homeDir, "releases", "r-2", hookRel), "#!/bin/sh\n# RELEASE TWO\n");
    symlinkSync(join(homeDir, "releases", "r-1"), join(homeDir, "current"));

    execSync("git init -q", { cwd: projectDir });
    const plan = planCommitMsgHook(projectDir, homeDir);
    assert.equal(plan.action, "install");
    if (plan.action !== "install") throw new Error("setup failed");
    // The install target is the STATIC current path, not a resolved release path.
    assert.equal(plan.source, join(homeDir, "current", hookRel));
    executeHookPlan(plan);

    const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
    assert.equal(readlinkSync(hookPath), join(homeDir, "current", hookRel));
    // A NEW invocation reads through current → r-1.
    assert.match(readFileSync(hookPath, "utf8"), /RELEASE ONE/);

    // Promote r-2: swap the current pointer. The installed link is untouched.
    unlinkSync(join(homeDir, "current"));
    symlinkSync(join(homeDir, "releases", "r-2"), join(homeDir, "current"));
    assert.equal(readlinkSync(hookPath), join(homeDir, "current", hookRel));
    // The NEXT invocation now resolves the promoted release's bytes.
    assert.match(readFileSync(hookPath, "utf8"), /RELEASE TWO/);

    // Re-running init over the promoted layout is a no-op (idempotent).
    assert.equal(planCommitMsgHook(projectDir, homeDir).action, "already-linked");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ----- FG-582 END-TO-END through the real `forge init` CLI. These exercise the
//       actual CLI wiring (init.ts action → planCommitMsgHook(projectDir,
//       FORGE_HOME) → executeHookPlan) with FORGE_HOME resolved from the
//       subprocess env, which the in-process plan tests above bypass. Every case
//       uses a disposable FORGE_HOME + disposable repo and NEVER touches this
//       repo's real .git/hooks. -----

// The bundled commit-msg hook's path relative to a release root — the shipped
// layout release.ts produces (it copies the whole source tree).
const RELEASE_HOOK_REL = join("scripts", "git-hooks", "commit-msg-no-ai-attribution");

// Build a disposable FORGE_HOME with `current` → releases/<release>, each release
// carrying its own commit-msg bytes in the SHIPPED hook layout so a NEW hook read
// resolves that release.
function makeForgeHome(): { home: string; layRelease: (id: string, marker: string) => void; promote: (id: string) => void } {
  const home = mkdtempSync(join(tmpdir(), "forge-home-e2e-"));
  const layRelease = (id: string, marker: string) => {
    const releaseDir = join(home, "releases", id);
    mkdirSync(join(releaseDir, "scripts", "git-hooks"), { recursive: true });
    writeFileSync(join(releaseDir, RELEASE_HOOK_REL), `#!/bin/sh\n# ${marker}\n`);
  };
  const promote = (id: string) => {
    const link = join(home, "current");
    try { unlinkSync(link); } catch { /* no prior pointer */ }
    symlinkSync(join(home, "releases", id), link);
  };
  return { home, layRelease, promote };
}

test("integ FG-582: `forge init` installs commit-msg through $FORGE_HOME/current and a promotion changes the bytes a NEW invocation runs", () => {
  execSync("git init -q", { cwd: projectDir });
  const { home, layRelease, promote } = makeForgeHome();
  try {
    layRelease("r-1", "RELEASE ONE");
    layRelease("r-2", "RELEASE TWO");
    promote("r-1");

    // Real CLI, FORGE_HOME resolved from the subprocess env.
    const init = runForge(["init", "--project", projectDir], projectDir, { ...process.env, FORGE_HOME: home });
    assert.equal(init.status, 0, `forge init failed: ${init.stderr}`);
    assert.match(init.stdout, /commit-msg hook:\s+installed → /, "CLI should report the hook installed");

    const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
    // The installed link is the STATIC $FORGE_HOME/current path, not a resolved
    // release path — that is what lets it follow a promotion.
    assert.ok(lstatSync(hookPath).isSymbolicLink(), "commit-msg must be a symlink");
    assert.equal(readlinkSync(hookPath), join(home, "current", RELEASE_HOOK_REL));
    // A NEW read resolves through current → r-1.
    assert.match(readFileSync(hookPath, "utf8"), /RELEASE ONE/);

    // Promote r-2. The installed link is untouched; the NEXT read follows it.
    promote("r-2");
    assert.equal(readlinkSync(hookPath), join(home, "current", RELEASE_HOOK_REL), "installed link must not change on promotion");
    assert.match(readFileSync(hookPath, "utf8"), /RELEASE TWO/, "a NEW invocation resolves the promoted release's bytes");

    // Re-running init over the promoted layout is idempotent (no-op).
    const reinit = runForge(["init", "--project", projectDir], projectDir, { ...process.env, FORGE_HOME: home });
    assert.equal(reinit.status, 0, `second forge init failed: ${reinit.stderr}`);
    assert.match(reinit.stdout, /commit-msg hook:\s+already current \(no change\)/, "re-init must be a no-op");
    assert.equal(readlinkSync(hookPath), join(home, "current", RELEASE_HOOK_REL), "idempotent re-init must not repoint");
    assert.match(readFileSync(hookPath, "utf8"), /RELEASE TWO/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("integ FG-582: `forge init` refuses to overwrite a foreign commit-msg hook and leaves it byte-for-byte intact", () => {
  execSync("git init -q", { cwd: projectDir });
  const { home, layRelease, promote } = makeForgeHome();
  try {
    layRelease("r-1", "RELEASE ONE");
    promote("r-1");

    // A foreign hook someone else installed, in place before forge init runs.
    const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
    const foreign = "#!/bin/sh\n# someone-elses commit-msg hook — do not touch\nexit 0\n";
    writeFileSync(hookPath, foreign);

    const init = runForge(["init", "--project", projectDir], projectDir, { ...process.env, FORGE_HOME: home });
    assert.equal(init.status, 0, `forge init failed: ${init.stderr}`);
    assert.match(init.stdout, /commit-msg hook:\s+SKIPPED — existing hook/, "CLI must report it skipped the foreign hook");

    // The foreign hook is a regular file, untouched, with identical bytes.
    assert.ok(!lstatSync(hookPath).isSymbolicLink(), "foreign hook must remain a regular file (never symlinked over)");
    assert.equal(readFileSync(hookPath, "utf8"), foreign, "foreign hook bytes must be preserved exactly");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ----- forge init CLI end-to-end via execSync (FG-408: moved from unit tier) -----

test("forge init --prefix: writes prefix into .forge/config.yml", () => {
  execSync(`npm run forge -- init --project ${projectDir} --no-install-hooks --prefix FG`, {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  const configPath = join(projectDir, ".forge", "config.yml");
  assert.ok(existsSync(configPath), ".forge/config.yml should be created");
  const content = readFileSync(configPath, "utf8");
  assert.match(content, /prefix.*FG|FG.*prefix/, "config.yml should contain the prefix");
});

test("forge init --dry-run: reports backlog scaffold, config, model-policy, docs-surfaces without writing", () => {
  const out = execSync(`npm run forge -- init --project ${projectDir} --no-install-hooks --prefix TEST --dry-run`, {
    cwd: process.cwd(),
    stdio: "pipe",
  }).toString();
  assert.match(out, /backlog\//i, "dry-run should mention backlog/ scaffold");
  assert.match(out, /prefix.*TEST|config\.yml/i, "dry-run should mention config.yml prefix");
  assert.match(out, /model-policy\.yml/i, "dry-run should mention model-policy.yml");
  assert.match(out, /docs-surfaces\.yml/i, "dry-run should mention docs-surfaces.yml");
  assert.ok(!existsSync(join(projectDir, ".forge")), ".forge/ should not be created in dry-run");
  assert.ok(!existsSync(join(projectDir, "backlog")), "backlog/ should not be created in dry-run");
});

// ----- FG-582: git ACTUALLY EXECUTES the installed hook. The tests above assert
//       the symlink bytes via readFileSync; these prove the end-to-end user flow
//       — git itself invoking commit-msg through the $FORGE_HOME/current chain,
//       and a promotion changing which release's policy a NEW `git commit` runs.
//       Disposable FORGE_HOME + disposable repo; never touches this repo's real
//       .git/hooks. -----

// An EXECUTABLE release commit-msg hook whose policy rejects any commit message
// matching `forbidden` (exit 1) and passes everything else (exit 0). Executable
// so git can run it through the current symlink; the makeForgeHome helper above
// writes non-executable byte markers (fine for readFileSync assertions, not for
// real git execution).
function layPolicyRelease(home: string, id: string, forbidden: string): void {
  const releaseDir = join(home, "releases", id);
  mkdirSync(join(releaseDir, "scripts", "git-hooks"), { recursive: true });
  const hook = join(releaseDir, RELEASE_HOOK_REL);
  writeFileSync(hook, `#!/bin/sh\ngrep -qi '${forbidden}' "$1" && exit 1\nexit 0\n`);
  chmodSync(hook, 0o755);
}

// Stage a distinct file revision (so there is always something to commit) and
// attempt a real `git commit`. Returns the spawn result — status!==0 means the
// commit-msg hook (or git) rejected it.
function commitAttempt(repo: string, message: string, revision: string) {
  writeFileSync(join(repo, "work.txt"), revision + "\n");
  execSync("git add work.txt", { cwd: repo });
  return spawnSync("git", ["commit", "-m", message], { cwd: repo, encoding: "utf8" });
}

function initGitRepo(repo: string): void {
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "tester@example.com"', { cwd: repo });
  execSync('git config user.name "Tester"', { cwd: repo });
}

test("integ FG-582: git executes the hook through $FORGE_HOME/current, and a promotion changes which release's policy a NEW commit runs", () => {
  initGitRepo(projectDir);
  const { home, promote } = makeForgeHome();
  try {
    layPolicyRelease(home, "r-1", "FORBIDDEN-ONE");
    layPolicyRelease(home, "r-2", "FORBIDDEN-TWO");
    promote("r-1");

    const init = runForge(["init", "--project", projectDir], projectDir, { ...process.env, FORGE_HOME: home });
    assert.equal(init.status, 0, `forge init failed: ${init.stderr}`);
    const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
    assert.equal(readlinkSync(hookPath), join(home, "current", RELEASE_HOOK_REL), "hook must link through current");

    // r-1 promoted: git runs r-1's policy through the current symlink. A message
    // with FORBIDDEN-ONE is blocked; FORBIDDEN-TWO passes (proving it is r-1's
    // bytes executing, not r-2's).
    const blockedByR1 = commitAttempt(projectDir, "message with FORBIDDEN-ONE inside", "v1");
    assert.notEqual(blockedByR1.status, 0, "r-1 policy must block FORBIDDEN-ONE via the current symlink");
    const allowedByR1 = commitAttempt(projectDir, "message with FORBIDDEN-TWO inside", "v2");
    assert.equal(allowedByR1.status, 0, `r-1 must allow FORBIDDEN-TWO: ${allowedByR1.stderr}`);

    // Promote r-2 by swapping the current pointer — the installed link is untouched.
    promote("r-2");
    assert.equal(readlinkSync(hookPath), join(home, "current", RELEASE_HOOK_REL), "installed link must not change on promotion");

    // A NEW `git commit` now resolves r-2's bytes: FORBIDDEN-TWO is now blocked,
    // FORBIDDEN-ONE now passes. This is the promotion being followed by git itself.
    const blockedByR2 = commitAttempt(projectDir, "another FORBIDDEN-TWO here", "v3");
    assert.notEqual(blockedByR2.status, 0, "after promotion a NEW commit must run r-2's policy (blocks FORBIDDEN-TWO)");
    const allowedByR2 = commitAttempt(projectDir, "now FORBIDDEN-ONE is fine", "v4");
    assert.equal(allowedByR2.status, 0, `after promotion r-2 must allow FORBIDDEN-ONE: ${allowedByR2.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("integ FG-582: with NO current pointer, `forge init` installs the dev-checkout hook and git enforces it (dev loop preserved)", () => {
  initGitRepo(projectDir);
  // Disposable FORGE_HOME with NO `current` pointer → dev-checkout fallback arm.
  const home = mkdtempSync(join(tmpdir(), "forge-home-nocurrent-"));
  try {
    const init = runForge(["init", "--project", projectDir], projectDir, { ...process.env, FORGE_HOME: home });
    assert.equal(init.status, 0, `forge init failed: ${init.stderr}`);
    const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
    // Falls back to the absolute bundled dev hook, NOT through $FORGE_HOME/current.
    const linkTarget = readlinkSync(hookPath);
    assert.notEqual(linkTarget, join(home, "current", RELEASE_HOOK_REL), "must not link through a non-existent current pointer");
    assert.match(linkTarget, /commit-msg-no-ai-attribution$/, "must fall back to the dev-checkout hook source");

    // The REAL bundled hook actually runs: a prose Anthropic mention is blocked...
    const blocked = commitAttempt(projectDir, "wire the Anthropic reference into prose here", "d1");
    assert.notEqual(blocked.status, 0, "dev-checkout hook must block a prose Anthropic mention");
    // ...and a clean message passes.
    const ok = commitAttempt(projectDir, "add an unrelated feature", "d2");
    assert.equal(ok.status, 0, `clean message must pass the dev-checkout hook: ${ok.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("integ FG-582: `forge init` migrates a stale legacy dev-path hook onto $FORGE_HOME/current, then git runs the promoted release", () => {
  initGitRepo(projectDir);
  const { home, promote } = makeForgeHome();
  try {
    layPolicyRelease(home, "r-1", "FORBIDDEN-ONE");
    promote("r-1");

    // Simulate an already-onboarded repo: first install via the dev-checkout arm
    // (a home with no current pointer) so a legacy absolute-dev-path link exists.
    const devHome = mkdtempSync(join(tmpdir(), "forge-home-dev-"));
    const devInit = runForge(["init", "--project", projectDir], projectDir, { ...process.env, FORGE_HOME: devHome });
    assert.equal(devInit.status, 0, `dev init failed: ${devInit.stderr}`);
    rmSync(devHome, { recursive: true, force: true });
    const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
    assert.match(readlinkSync(hookPath), /commit-msg-no-ai-attribution$/, "precondition: legacy dev-path link installed");

    // Re-init WITH a promoted current pointer: the stale-but-ours link is provably
    // Forge-owned, so it is re-pointed (migrated) onto $FORGE_HOME/current.
    const reinit = runForge(["init", "--project", projectDir], projectDir, { ...process.env, FORGE_HOME: home });
    assert.equal(reinit.status, 0, `re-init failed: ${reinit.stderr}`);
    assert.match(reinit.stdout, /commit-msg hook:\s+installed → /, "re-init should re-point the legacy link");
    assert.equal(readlinkSync(hookPath), join(home, "current", RELEASE_HOOK_REL), "legacy link must migrate onto current");

    // git now runs r-1's promoted policy through the migrated link.
    const blocked = commitAttempt(projectDir, "carries a FORBIDDEN-ONE token", "m1");
    assert.notEqual(blocked.status, 0, "migrated hook must run r-1's promoted policy");
    const ok = commitAttempt(projectDir, "a perfectly clean message", "m2");
    assert.equal(ok.status, 0, `clean message must pass the migrated hook: ${ok.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
