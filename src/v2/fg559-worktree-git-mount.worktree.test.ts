// FG-559: agents mounted on a linked git worktree must have working git.
//
// A linked worktree's `.git` is a FILE holding `gitdir: <abs path>` into the
// PARENT repo's `.git`. Forge mounts only the worktree at /project, so the
// pointer dangled and every git command failed — silently, because the agent
// still had the file tree.
//
// Strategy (no docker needed, runs in well under a second): build a real repo
// with several commits, `git worktree add` a linked worktree, then materialize
// the CANDIDATE CONTAINER VIEW by copying the worktree tree to a DIFFERENT path
// (modelling it landing at /project) and deleting the original host tree. The
// parent `.git` is then recreated — or not — under its ORIGINAL host absolute
// path, which is exactly what the bind mount does inside the container.
//
// The negative control is load-bearing: with only the worktree materialized,
// `git log` MUST fail with the dangling-gitdir error. Every positive assertion
// below is only meaningful because that control fails first.
//
// Tier: worktree (`npm run test:worktree`) — chosen by the slowest operation,
// `git worktree add`. Structural precedent: fg351-worktree-lifecycle.worktree.test.ts.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Runtime } from "./schema.js";
import {
  buildDockerArgs,
  planWorktreeGitMounts,
  assertWorktreeGitMountPlanned,
  preflightProjectMount,
  type SpawnContext,
} from "./spawn.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    // A read-only-mount simulation chmods the tree unwritable; restore before rm.
    spawnSync("chmod", ["-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  assert.equal(r.code, 0, `git ${args.join(" ")} must succeed, got exit ${r.code}: ${r.stderr}`);
  return r.stdout;
}

type Fixture = {
  /** Where the parent repo's .git lives on the "host" — the path the worktree's
   *  gitdir: pointer names, and the path the bind mount reproduces. */
  parentGitDir: string;
  /** The worktree tree as it lands in the container (a different path). */
  projectPath: string;
  /** Saved copy of the parent .git, used to materialize the mount. */
  savedGitDir: string;
  shaA: string;
  shaB: string;
  shaC: string;
};

/** Build a real linked worktree, then tear the host tree down so nothing but the
 *  copied worktree exists. `materializeGitMount()` recreates the parent .git at
 *  its original absolute path — the harness's stand-in for the bind mount. */
function makeWorktreeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg559-")));
  tmpDirs.push(base);

  const repo = join(base, "host", "parent");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: repo, stdio: "ignore" });

  const shas: string[] = [];
  for (const n of [1, 2, 3]) {
    writeFileSync(join(repo, "file.txt"), `revision ${n}\n`);
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `commit ${n}`], { cwd: repo, stdio: "ignore" });
    shas.push(gitOk(repo, "rev-parse", "HEAD").trim());
  }

  // A remote-tracking ref that exists ONLY in packed-refs. This is the near-miss
  // guard: a {HEAD, refs, objects} mount looks sufficient right up until a
  // reviewer names origin/main.
  gitOk(repo, "update-ref", "refs/remotes/origin/main", shas[2]!);
  gitOk(repo, "pack-refs", "--all");
  assert.equal(
    existsSync(join(repo, ".git", "refs", "remotes", "origin", "main")),
    false,
    "fixture must have no LOOSE refs/remotes/origin/main — the packed-refs assertion would be vacuous"
  );
  assert.match(
    readFileSync(join(repo, ".git", "packed-refs"), "utf8"),
    /refs\/remotes\/origin\/main/,
    "fixture must carry refs/remotes/origin/main in packed-refs"
  );

  const wtPath = join(base, "host", "wt");
  gitOk(repo, "worktree", "add", "-b", "fg559-wt", wtPath, shas[1]!);

  // The guard against the vacuous-pass mode: if a refactor turns this fixture
  // into a plain clone, everything below still "passes" and proves nothing.
  assert.equal(
    statSync(join(wtPath, ".git")).isFile(),
    true,
    "fixture must be a LINKED WORKTREE — <wt>/.git must be a gitdir: pointer FILE, not a directory"
  );

  const parentGitDir = join(repo, ".git");
  const projectPath = join(base, "container", "project");
  mkdirSync(dirname(projectPath), { recursive: true });
  cpSync(wtPath, projectPath, { recursive: true });

  const savedGitDir = join(base, "saved-git");
  cpSync(parentGitDir, savedGitDir, { recursive: true });
  rmSync(join(base, "host"), { recursive: true, force: true });

  return { parentGitDir, projectPath, savedGitDir, shaA: shas[0]!, shaB: shas[1]!, shaC: shas[2]! };
}

/** The harness stand-in for the bind mount: put the parent .git back at the
 *  exact host absolute path the worktree's gitdir: line names. */
function materializeGitMount(f: Fixture, opts: { readOnly?: boolean } = {}): void {
  mkdirSync(dirname(f.parentGitDir), { recursive: true });
  cpSync(f.savedGitDir, f.parentGitDir, { recursive: true });
  if (opts.readOnly) {
    // Simulates docker's `:ro`. A real ro bind is STRICTER (kernel-enforced at
    // the mount, not the inode), so the gap is in the safe direction.
    execFileSync("chmod", ["-R", "a-w", f.parentGitDir]);
  }
}

// ─── Functional harness: does git actually work? ─────────────────────────────

test("fg559 (negative control): with ONLY the worktree materialized, git fails with the dangling-gitdir error", () => {
  const f = makeWorktreeFixture();

  const r = git(f.projectPath, "log", "--oneline");
  assert.notEqual(r.code, 0, "git log MUST fail when the parent .git is not mounted — this control is what makes every positive assertion below meaningful");
  assert.match(
    r.stderr,
    /not a git repository/i,
    `git log must fail with the dangling-gitdir error, got: ${r.stderr}`
  );
});

test("fg559: with the parent .git mounted at its host path, log/diff/show all succeed with non-empty output", () => {
  const f = makeWorktreeFixture();
  materializeGitMount(f);

  const log = gitOk(f.projectPath, "log", "--oneline");
  assert.match(log, /commit 1/, `git log output must carry real history, got: ${JSON.stringify(log)}`);

  const diff = gitOk(f.projectPath, "diff", `${f.shaA}..${f.shaC}`);
  assert.ok(diff.trim().length > 0, "git diff <shaA>..<shaC> must produce non-empty output");
  assert.match(diff, /revision 3/, "git diff must show the real content change");

  const show = gitOk(f.projectPath, "show", f.shaB);
  assert.ok(show.trim().length > 0, "git show <sha> must produce non-empty output");
  assert.match(show, /commit 2/, "git show must render the named commit");
});

test("fg559: a ref that exists ONLY in packed-refs resolves (the origin/main near-miss)", () => {
  const f = makeWorktreeFixture();
  materializeGitMount(f);

  assert.equal(
    gitOk(f.projectPath, "rev-parse", "origin/main").trim(),
    f.shaC,
    "origin/main lives only in packed-refs — a narrowed {HEAD,refs,objects} mount would fail here"
  );
});

test("fg559: under a READ-ONLY mount, reads succeed and writes are refused", () => {
  const f = makeWorktreeFixture();
  materializeGitMount(f, { readOnly: true });

  assert.match(gitOk(f.projectPath, "log", "--oneline"), /commit 1/, "reads must still work under :ro");
  assert.ok(gitOk(f.projectPath, "show", f.shaC).trim().length > 0, "git show must still work under :ro");

  const updateRef = git(f.projectPath, "update-ref", "refs/heads/fg559-should-not-exist", f.shaC);
  assert.notEqual(updateRef.code, 0, "git update-ref MUST be refused under a read-only parent .git");
  assert.match(updateRef.stderr, /permission denied/i, `refusal must come from the filesystem, got: ${updateRef.stderr}`);

  writeFileSync(join(f.projectPath, "file.txt"), "agent edit\n");
  const commit = git(f.projectPath, "commit", "-am", "should be refused");
  assert.notEqual(commit.code, 0, "git commit MUST be refused under a read-only parent .git (FG-621 defers writable in-container git)");
  assert.match(commit.stderr, /permission denied/i, `refusal must come from the filesystem, got: ${commit.stderr}`);
});

// ─── Mount plan: what forge hands docker ─────────────────────────────────────

const RUNTIME: Runtime = {
  name: "fg559-test",
  description: "FG-559 mount-plan test runtime stub",
  image: "agent-dev-worker:latest",
  models: { default: "test-model" },
  auth: { mode: "oauth-volume" },
  env: {},
  mounts: [
    { host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false },
    { host: "${PROJECT_DIR}", container: "/project", mode: "${PROJECT_MODE:-rw}", optional: false },
  ],
  invocation: { command: "claude", args: ["--model", "${MODEL}"] },
  container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
  result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
};

function ctxFor(projectDir: string, mode: "rw" | "ro"): SpawnContext {
  return {
    TASK_ID: "task-fg559",
    TASK_DIR: join(tmpdir(), "fg559-task"),
    PROJECT_DIR: projectDir,
    PROJECT_MODE: mode,
    MODEL: "test-model",
    SYSTEM_PROMPT: "system",
    TASK_PACKAGE_MARKDOWN: "# Task\n",
  };
}

function mountSpecs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-v") out.push(args[i + 1]!);
  return out;
}

test("fg559: planWorktreeGitMounts resolves BOTH hops to the single common .git (and is empty for a plain clone)", () => {
  const f = makeWorktreeFixture();
  materializeGitMount(f);

  assert.deepEqual(
    planWorktreeGitMounts(f.projectPath),
    [f.parentGitDir],
    "the worktree admin dir lives inside the common .git, so one mount of the common .git covers the absolute hop AND the relative commondir hop"
  );

  const plainClone = realpathSync(mkdtempSync(join(tmpdir(), "fg559-clone-")));
  tmpDirs.push(plainClone);
  execFileSync("git", ["init", "-b", "main"], { cwd: plainClone, stdio: "ignore" });
  assert.deepEqual(planWorktreeGitMounts(plainClone), [], "a plain clone needs no extra mount — .git is a real directory");
  assert.deepEqual(planWorktreeGitMounts(join(plainClone, "nope")), [], "a non-git dir needs no extra mount");
});

test("fg559: a dispatch whose PROJECT_DIR is a linked worktree produces the parent .git bind — :ro for blue AND red", () => {
  const f = makeWorktreeFixture();
  materializeGitMount(f);

  for (const mode of ["rw", "ro"] as const) {
    const { args } = buildDockerArgs(RUNTIME, ctxFor(f.projectPath, mode));
    const specs = mountSpecs(args);
    assert.ok(
      specs.includes(`${f.parentGitDir}:${f.parentGitDir}:ro`),
      `PROJECT_MODE=${mode} argv must bind the parent .git READ-ONLY at its own host path, got: ${specs.join(" ")}`
    );
    assert.ok(
      specs.includes(`${f.projectPath}:/project:${mode}`),
      `PROJECT_MODE=${mode} must be untouched by FG-559, got: ${specs.join(" ")}`
    );
  }
});

test("fg559: a plain-clone dispatch adds no git mount at all", () => {
  const plainClone = realpathSync(mkdtempSync(join(tmpdir(), "fg559-clone-")));
  tmpDirs.push(plainClone);
  execFileSync("git", ["init", "-b", "main"], { cwd: plainClone, stdio: "ignore" });

  const { args } = buildDockerArgs(RUNTIME, ctxFor(plainClone, "rw"));
  assert.deepEqual(
    mountSpecs(args).filter((s) => s.includes("/.git")),
    [],
    "a plain clone's .git rides along inside the /project mount — no extra bind"
  );
});

test("fg559 (piece A): the mount-plan check REFUSES an argv missing the parent .git bind", () => {
  const f = makeWorktreeFixture();
  materializeGitMount(f);

  const { args } = buildDockerArgs(RUNTIME, ctxFor(f.projectPath, "rw"));
  assert.doesNotThrow(
    () => assertWorktreeGitMountPlanned(f.projectPath, args),
    "the argv buildDockerArgs produces must satisfy its own assertion"
  );

  // Drop the git bind — this is the pre-FG-559 argv, byte for byte.
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v" && args[i + 1]!.startsWith(`${f.parentGitDir}:`)) {
      i++;
      continue;
    }
    stripped.push(args[i]!);
  }
  assert.throws(
    () => assertWorktreeGitMountPlanned(f.projectPath, stripped),
    (e: Error) => e.message.includes(f.parentGitDir) && /FG-559/.test(e.message),
    "the check must refuse — naming the unmounted path — rather than warn"
  );

  // Mounting ONLY the worktree admin dir is the trial the ticket recorded as
  // "ALL FAIL": the absolute hop lands, the relative commondir hop does not.
  const adminOnly = [...stripped];
  const admin = readFileSync(join(f.projectPath, ".git"), "utf8").replace("gitdir:", "").trim();
  adminOnly.push("-v", `${admin}:${admin}:ro`);
  assert.throws(
    () => assertWorktreeGitMountPlanned(f.projectPath, adminOnly),
    /FG-559/,
    "mounting the admin dir alone must still be refused — commondir hops OUT of it"
  );
});

// ─── preflightProjectMount: the seam the defect walked through ───────────────

test("fg559: preflightProjectMount accepts a live worktree pointer and refuses a dangling one", () => {
  const f = makeWorktreeFixture();
  materializeGitMount(f);
  assert.doesNotThrow(
    () => preflightProjectMount(f.projectPath),
    "a worktree whose parent .git exists on the host is a valid project mount"
  );

  rmSync(f.parentGitDir, { recursive: true, force: true });
  assert.throws(
    () => preflightProjectMount(f.projectPath),
    /gitdir: pointer/,
    "a .git POINTER FILE whose target is gone must be refused — bare existsSync read it as a healthy marker"
  );
});
