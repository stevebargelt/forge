// FG-376 review FIX3: individual worktree/task disposal must NOT remove a
// shared dependency-cache volume (dependency-provisioning.ts) — a volume this
// task's install populated may still be the one another concurrent/later task
// reuses (cache key = lockfile hash, FIX2). These tests confirm disposal still
// removes the worktree + branch as before, and that it never shells out to
// `docker volume rm` — proven via a PATH-shadowing `docker` stub rather than a
// real docker daemon, so it runs the same on Linux CI as on macOS.
//
// Real git repos + real `git worktree` commands (not gated by
// preflightWorktreeGate/platform — these disposal functions never call it),
// so this runs on Linux CI same as macOS.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  worktreeBranchName,
  integrationBranchName,
  forceRemoveWorktree,
  removeWorktreeIfSafe,
  cleanupFailedCloneSetup,
  cleanupFailedWorktreeSetup,
  cleanupIntegrationWorktree,
  createWorktree,
  createTaskClone,
} from "./worktree-lifecycle.js";
import { cloneDir, worktreeDir, integrationWorktreeDir, WORKTREES_DIR } from "../util/paths.js";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getWorkspacePurpose } from "../store/workspace-purpose.js";
import type { Database as DatabaseInstance } from "better-sqlite3";

const tmpDirs: string[] = [];

beforeEach(() => {
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";
});

afterEach(() => {
  delete process.env.FORGE_WORKTREES_EPHEMERAL;
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

test("removeWorktreeIfSafe (EPHEMERAL): still removes the worktree + branch when the worktree has a package-lock.json", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg376-a";
  const taskId = "task-fg376-a";
  const wtPath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });
  assert.ok(existsSync(wtPath));

  assert.doesNotThrow(() => removeWorktreeIfSafe(wtPath, runId, taskId, projectDir));

  assert.ok(!existsSync(wtPath), "worktree directory must still be removed");
  const branches = execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" });
  assert.equal(branches.trim(), "", "task branch must still be force-deleted");
});

test("removeWorktreeIfSafe (EPHEMERAL): no-ops safely (no throw) when the worktree has NO lockfile", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: projectDir, stdio: "ignore" });
  writeFileSync(join(projectDir, "README.md"), "# no lockfile\n");
  execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: projectDir, stdio: "ignore" });

  const runId = "run-fg376-b";
  const taskId = "task-fg376-b";
  const wtPath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

  assert.doesNotThrow(() => removeWorktreeIfSafe(wtPath, runId, taskId, projectDir));
  assert.ok(!existsSync(wtPath));
});

test("cleanupFailedWorktreeSetup: removes a partially-created worktree (with lockfile)", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg376-c";
  const taskId = "task-fg376-c";
  const wtPath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

  assert.doesNotThrow(() => cleanupFailedWorktreeSetup(projectDir, runId, taskId));
  assert.ok(!existsSync(wtPath));
});

test("cleanupIntegrationWorktree: removes the integration worktree + branch (with lockfile)", () => {
  const projectDir = makeTmpDir("forge-fg376-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg376-d";
  const parentTaskId = "task-fg376-parent";
  const integPath = integrationWorktreeDir(runId, parentTaskId);
  const branch = integrationBranchName(runId, parentTaskId);
  mkdirSync(join(WORKTREES_DIR, runId, parentTaskId), { recursive: true });
  execFileSync("git", ["worktree", "add", integPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

  assert.doesNotThrow(() => cleanupIntegrationWorktree(projectDir, runId, parentTaskId));
  assert.ok(!existsSync(integPath));
  const branches = execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" });
  assert.equal(branches.trim(), "");
});

// ── FIX3: individual disposal must never remove a SHARED dependency-cache volume ──

// Shadows `docker` on PATH with a stub that just logs its argv — proves (or
// disproves) "disposal shells out to `docker volume rm`" without needing a
// real docker daemon, so this assertion holds the same on a docker-less CI
// box as it would against real docker.
function makeDockerStub(): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-docker-stub-"));
  const logPath = join(binDir, "docker-calls.log");
  writeFileSync(join(binDir, "docker"), `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

test("removeWorktreeIfSafe (EPHEMERAL): does not remove a shared dependency-cache volume at individual disposal, even while another task references the same cache key", () => {
  const { binDir, logPath } = makeDockerStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    const projectDir = makeTmpDir("forge-fg376-repo-");
    initGitRepo(projectDir); // writes package-lock.json with content "{}"

    const runId = "run-fg376-fix3";
    const taskId = "task-fg376-fix3-a";
    const wtPath = worktreeDir(runId, taskId);
    const branch = worktreeBranchName(runId, taskId);
    mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
    execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });

    // A second, still-active task's worktree shares the SAME lockfile content
    // (same cache key) — simulates "another task references the same key"
    // while the first task's worktree is disposed.
    const otherTaskId = "task-fg376-fix3-b";
    const otherWtPath = worktreeDir(runId, otherTaskId);
    const otherBranch = worktreeBranchName(runId, otherTaskId);
    execFileSync("git", ["worktree", "add", otherWtPath, "-b", otherBranch], { cwd: projectDir, stdio: "ignore" });

    assert.doesNotThrow(() => removeWorktreeIfSafe(wtPath, runId, taskId, projectDir));
    assert.ok(!existsSync(wtPath), "the disposed worktree directory is still removed");

    const dockerCalls = readFileSync(logPath, "utf8").trim();
    assert.equal(dockerCalls, "", `individual worktree disposal must never invoke docker (shared cache volume) — got: ${JSON.stringify(dockerCalls)}`);

    // The other task's worktree (and by extension, its claim on the shared
    // cache key) is completely untouched.
    assert.ok(existsSync(otherWtPath), "another task's worktree referencing the same cache key must be unaffected");
  } finally {
    process.env.PATH = origPath;
  }
});

test("cleanupFailedWorktreeSetup / cleanupIntegrationWorktree: neither invokes docker (no shared-volume removal at disposal)", () => {
  const { binDir, logPath } = makeDockerStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    const projectDir = makeTmpDir("forge-fg376-repo-");
    initGitRepo(projectDir);

    const runId = "run-fg376-fix3b";
    const taskId = "task-fg376-fix3b-a";
    const wtPath = worktreeDir(runId, taskId);
    const branch = worktreeBranchName(runId, taskId);
    mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });
    execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: projectDir, stdio: "ignore" });
    cleanupFailedWorktreeSetup(projectDir, runId, taskId);

    const parentTaskId = "task-fg376-fix3b-parent";
    const integPath = integrationWorktreeDir(runId, parentTaskId);
    const integBranch = integrationBranchName(runId, parentTaskId);
    mkdirSync(join(WORKTREES_DIR, runId, parentTaskId), { recursive: true });
    execFileSync("git", ["worktree", "add", integPath, "-b", integBranch], { cwd: projectDir, stdio: "ignore" });
    cleanupIntegrationWorktree(projectDir, runId, parentTaskId);

    const dockerCalls = readFileSync(logPath, "utf8").trim();
    assert.equal(dockerCalls, "", `no disposal path should invoke docker — got: ${JSON.stringify(dockerCalls)}`);
  } finally {
    process.env.PATH = origPath;
  }
});

// Shadows `git` with a stub whose `worktree remove` deletes the directory and
// THEN fails — the shape that makes path-absence a lie about removal success.
function makeFailingRemoveGitStub(): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-git-stub-"));
  const logPath = join(binDir, "git-calls.log");
  writeFileSync(
    join(binDir, "git"),
    `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then\n  for a in "$@"; do last="$a"; done\n  rm -rf "$last"\n  exit 1\nfi\nexit 0\n`
  );
  chmodSync(join(binDir, "git"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

test("cleanupFailedWorktreeSetup: prunes stale registrations when `git worktree remove` fails but the directory is gone anyway", () => {
  const projectDir = makeTmpDir("forge-fg356-repo-");
  initGitRepo(projectDir);
  const runId = "run-fg356-prune";
  const taskId = "task-fg356-prune";
  const wtPath = worktreeDir(runId, taskId);
  mkdirSync(wtPath, { recursive: true });

  const { binDir, logPath } = makeFailingRemoveGitStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    assert.doesNotThrow(() => cleanupFailedWorktreeSetup(projectDir, runId, taskId));
  } finally {
    process.env.PATH = origPath;
  }

  assert.ok(!existsSync(wtPath), "the stub removed the directory before failing");
  const gitCalls = readFileSync(logPath, "utf8");
  assert.match(
    gitCalls,
    /worktree prune/,
    `a failed remove must still prune the parent repo's stale registrations — git calls were: ${JSON.stringify(gitCalls)}`
  );
});

// ── FG-356: the forceRemoveWorktree contract itself ───────────────────────────
//
// "the directory is gone" and "git completed the removal" are two different
// facts. Returning the first as if it were the second is what let a caller
// report a clean disposal over a stale $GIT_DIR/worktrees entry — the entry that
// breaks the parent's later worktree operations. These pin both halves over REAL
// git, with no stub in sight.

/** Where git records a linked worktree in the parent repo. */
function registrationDir(projectDir: string, wtPath: string): string {
  return join(projectDir, ".git", "worktrees", basename(wtPath));
}

test("forceRemoveWorktree: an ordinary removal reports git's own verdict and leaves no registration behind", () => {
  const projectDir = makeTmpDir("forge-fg356-force-ok-");
  initGitRepo(projectDir);
  const wtPath = join(makeTmpDir("forge-fg356-wt-"), "ordinary");
  execFileSync("git", ["worktree", "add", wtPath, "-b", "forge/run/ordinary"], { cwd: projectDir, stdio: "ignore" });

  const result = forceRemoveWorktree(projectDir, wtPath);

  assert.equal(result.gitRemoved, true, "git removed it, and that is what gets reported");
  assert.equal(result.pathAbsent, true);
  assert.equal(existsSync(registrationDir(projectDir, wtPath)), false, "git clears its own registration on success");
});

test("forceRemoveWorktree: a removal git DECLINES whose directory is gone anyway is reported as declined, and the stale registration is pruned", () => {
  const projectDir = makeTmpDir("forge-fg356-force-declined-");
  initGitRepo(projectDir);
  const wtPath = join(makeTmpDir("forge-fg356-wt-"), "declined");
  execFileSync("git", ["worktree", "add", wtPath, "-b", "forge/run/declined"], { cwd: projectDir, stdio: "ignore" });
  const registration = registrationDir(projectDir, wtPath);
  assert.ok(existsSync(registration));

  // A partially-completed removal, built with real git: the working tree is gone
  // and the registration's `gitdir` pointer with it, so git no longer resolves
  // the path to a worktree — while the registration itself survives.
  rmSync(wtPath, { recursive: true, force: true });
  rmSync(join(registration, "gitdir"), { force: true });
  assert.throws(
    () => execFileSync("git", ["worktree", "remove", "--force", "--force", wtPath], { cwd: projectDir, stdio: "ignore" }),
    "the fixture must genuinely make git refuse the removal, or this test proves nothing"
  );
  assert.ok(existsSync(registration), "...and genuinely leave the registration behind");

  const result = forceRemoveWorktree(projectDir, wtPath);

  assert.equal(result.gitRemoved, false, "git did not complete the removal — reporting otherwise is the bug");
  assert.equal(result.pathAbsent, true, "the directory is gone all the same, and that is a separate fact");
  assert.equal(existsSync(registration), false, "the stale registration is pruned, not left to break later worktree ops");
});

test("forceRemoveWorktree: a path that was never a worktree is a no-op across repeated calls, and the prune never touches a live registration", () => {
  const projectDir = makeTmpDir("forge-fg356-force-noop-");
  initGitRepo(projectDir);
  const live = join(makeTmpDir("forge-fg356-wt-"), "live");
  execFileSync("git", ["worktree", "add", live, "-b", "forge/run/live"], { cwd: projectDir, stdio: "ignore" });
  const absent = join(projectDir, "never-a-worktree");

  for (let pass = 1; pass <= 3; pass++) {
    const result = forceRemoveWorktree(projectDir, absent);
    assert.equal(result.gitRemoved, false, `pass ${pass}: git has nothing to remove and says so`);
    assert.equal(result.pathAbsent, true, `pass ${pass}: nothing there is still nothing there`);
  }

  assert.ok(existsSync(live), "a registration whose working tree is still on disk is not prunable");
  assert.ok(existsSync(registrationDir(projectDir, live)), "so pruning never widens what gets disposed of");
});

// ── FG-693 (fix batch): the identity precondition on the DESTRUCTIVE primitive ─
//
// RF-2. The precondition was applied at the task-worktree disposals and missed at
// every integration-worktree one — the post-merge cleanup, the create-retry prune and
// the re-materialization all handed a derived path straight to `git worktree remove
// --force --force`. Git refuses to remove the MAIN working tree, and only that: where
// the project checkout is itself a linked worktree (which is what a fan-out publisher
// is working in), a recorded integration path that is another spelling of it deletes
// the operator's tree. So the precondition lives on the primitive, where the NEXT
// destructive consumer inherits it instead of having to remember it.
//
// RF-3. And a caller whose own next step is destructive takes the SAME decision: the
// failed-clone cleanup declined the workspace removal and then force-deleted the
// task's parent-side anchor anyway, which is the worse half to get wrong — the tree
// survives and the only durable record of the attempt does not.

/** The attack shape, built for real: a managed path that RESOLVES to the project
 *  checkout through a symlinked leaf. Nothing here is contrived about the spelling —
 *  it is exactly the "symlinked parent" case the identity contract exists for. */
function aliasOfProject(projectDir: string, at: string): string {
  mkdirSync(join(at, ".."), { recursive: true });
  symlinkSync(projectDir, at);
  return at;
}

/** A project checkout that is itself a LINKED worktree — the shape a fan-out
 *  publisher actually works in, and the one where git's own protection does not
 *  apply: `git worktree remove` refuses the MAIN working tree and only that. */
function linkedCheckout(label: string): string {
  const parent = makeTmpDir(`forge-fg693-${label}-parent-`);
  initGitRepo(parent);
  const checkout = join(makeTmpDir(`forge-fg693-${label}-`), "checkout");
  execFileSync("git", ["worktree", "add", checkout, "-b", `operator/${label}`], { cwd: parent, stdio: "ignore" });
  return checkout;
}

test("FG-693: forceRemoveWorktree REFUSES a path that is the project checkout under another spelling", () => {
  // NOT vacuous, and proven with a sacrificial twin: raw git, handed the same shape,
  // deletes the checkout. The precondition is the only thing standing between the
  // recorded integration path and the operator's tree.
  const doomed = linkedCheckout("doomed");
  const doomedAlias = aliasOfProject(doomed, join(makeTmpDir("forge-fg693-doomed-alias-"), "integration"));
  execFileSync("git", ["worktree", "remove", "--force", "--force", doomedAlias], { cwd: doomed, stdio: "ignore" });
  assert.equal(existsSync(join(doomed, "README.md")), false, "fixture: git removes a LINKED checkout without complaint");

  const projectDir = linkedCheckout("guarded");
  const alias = aliasOfProject(projectDir, join(makeTmpDir("forge-fg693-alias-"), "integration"));

  const result = forceRemoveWorktree(projectDir, alias);

  assert.ok(result.declined, "an unproven match must make a destructive consumer abstain, and SAY it did");
  assert.equal(result.gitRemoved, false);
  assert.ok(existsSync(join(projectDir, "README.md")), "the operator's checkout is still there");
  assert.ok(existsSync(join(projectDir, ".git")), "and it is still a worktree of its repository");
});

test("FG-693: the integration cleanup takes the removal's decision for its BRANCH deletion too", () => {
  const projectDir = makeTmpDir("forge-fg693-integration-alias-");
  initGitRepo(projectDir);
  const runId = "run-fg693-int";
  const parentTaskId = "task-fg693-int";
  const branch = integrationBranchName(runId, parentTaskId);
  execFileSync("git", ["branch", branch], { cwd: projectDir, stdio: "ignore" });
  aliasOfProject(projectDir, integrationWorktreeDir(runId, parentTaskId));

  cleanupIntegrationWorktree(projectDir, runId, parentTaskId);

  assert.ok(existsSync(join(projectDir, "README.md")), "the checkout the path really named is untouched");
  assert.equal(
    execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" }).trim(),
    branch,
    "the branch is disposal too — a leaked ref is reclaimable, a deleted one is not",
  );
});

test("FG-693: a failed clone setup that cannot prove its path keeps BOTH the tree and the anchor", () => {
  const projectDir = makeTmpDir("forge-fg693-clone-alias-");
  initGitRepo(projectDir);
  const runId = "run-fg693-clone";
  const taskId = "task-fg693-clone";
  const branch = worktreeBranchName(runId, taskId);
  // The parent-side anchor this attempt created — the durable record of its base.
  execFileSync("git", ["branch", branch], { cwd: projectDir, stdio: "ignore" });
  aliasOfProject(projectDir, cloneDir(runId, taskId));

  cleanupFailedCloneSetup(projectDir, runId, taskId);

  assert.ok(existsSync(join(projectDir, "README.md")), "the redirected 'clone' was the project checkout — not removed");
  assert.equal(
    execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" }).trim(),
    branch,
    "and the anchor survives with it: declining the removal while force-deleting the ref is the worst of both",
  );
});

test("FG-693: the ordinary failed-clone cleanup still disposes of the clone AND its anchor", () => {
  const projectDir = makeTmpDir("forge-fg693-clone-ok-");
  initGitRepo(projectDir);
  const runId = "run-fg693-clone-ok";
  const taskId = "task-fg693-clone-ok";
  const branch = worktreeBranchName(runId, taskId);
  execFileSync("git", ["branch", branch], { cwd: projectDir, stdio: "ignore" });
  const clone = cloneDir(runId, taskId);
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "half-finished.ts"), "export const partial = true;\n");

  cleanupFailedCloneSetup(projectDir, runId, taskId);

  assert.equal(existsSync(clone), false, "a clone that IS provably its own tree is disposed of as before");
  assert.equal(
    execFileSync("git", ["branch", "--list", branch], { cwd: projectDir, encoding: "utf8" }).trim(),
    "",
    "and its anchor goes with it — the refusal above must not have made this path timid",
  );
});

// ── FG-745: purpose recording at the Forge CREATION sites ────────────────────────

function headSha(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

test("FG-745: createWorktree records a 'worktree' purpose with owner run/task", () => {
  const projectDir = makeTmpDir("forge-fg745-wt-");
  initGitRepo(projectDir);
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    const runId = "run-fg745-wt";
    const taskId = "task-fg745-wt";
    const { worktreePath } = createWorktree(projectDir, runId, taskId);
    const purpose = getWorkspacePurpose(worktreePath);
    assert.ok(purpose, "the created worktree has a recorded purpose row");
    assert.equal(purpose.kind, "worktree");
    assert.equal(purpose.runId, runId);
    assert.equal(purpose.taskId, taskId);
  } finally {
    setDbForTest(prev as DatabaseInstance);
    db.close();
  }
});

test("FG-745: createTaskClone records a 'disposable_clone' purpose", () => {
  const projectDir = makeTmpDir("forge-fg745-clone-");
  initGitRepo(projectDir);
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    const runId = "run-fg745-clone";
    const taskId = "task-fg745-clone";
    const { clonePath } = createTaskClone(projectDir, runId, taskId, headSha(projectDir));
    const purpose = getWorkspacePurpose(clonePath);
    assert.ok(purpose, "the created clone has a recorded purpose row");
    assert.equal(purpose.kind, "disposable_clone");
    assert.equal(purpose.runId, runId);
    assert.equal(purpose.taskId, taskId);
  } finally {
    setDbForTest(prev as DatabaseInstance);
    db.close();
  }
});

test("FG-745: a store write failure does not abort createWorktree (best-effort)", () => {
  const projectDir = makeTmpDir("forge-fg745-nostore-");
  initGitRepo(projectDir);
  // A closed DB handle makes every store write throw; creation must still succeed.
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  db.close();
  try {
    const runId = "run-fg745-nostore";
    const taskId = "task-fg745-nostore";
    let result: { worktreePath: string } | undefined;
    assert.doesNotThrow(() => {
      result = createWorktree(projectDir, runId, taskId);
    });
    assert.ok(result && existsSync(result.worktreePath), "the worktree is created even when the purpose store is unwritable");
  } finally {
    setDbForTest(prev as DatabaseInstance);
  }
});
