// FG-559 verify pass — the coverage the implementation's own test file does not
// have. Companion to fg559-worktree-git-mount.worktree.test.ts; that file proves
// the happy path (mount present → git works, argv carries the bind). This one
// covers the halves a "requires" contract needs to actually hold:
//
//   1. The near-miss mounts are proven insufficient FUNCTIONALLY, not just as an
//      argv predicate. The ticket's trial table records "admin dir only" as ALL
//      FAIL; the sibling file only asserts that assertWorktreeGitMountPlanned
//      REFUSES that argv. Reverting planWorktreeGitMounts to the admin-dir-only
//      plan turns three argv-level tests red and ZERO functional ones — so the
//      behavioural claim was unpinned. Pinned here.
//   2. The ENFORCEMENT direction of assertWorktreeGitMountPlanned: it must
//      refuse the broken argvs, must NOT refuse an ordinary dispatch, and the
//      refusal must land BEFORE any container starts or any state is written.
//   3. The two shell surfaces (docker/agent-entrypoint.sh's git probe and
//      docker/forge-test.sh's cold-start scratch) exercised as the REAL script
//      text, extracted from the files themselves — not a paraphrase that would
//      keep passing after the file regressed.
//
// Tier: worktree — `git worktree add` and a real `invoke()` dispatch are the
// slowest operations. Precedent for driving dispatch from this tier:
// fg351-worktree-lifecycle.worktree.test.ts (dispatch-1..3).

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
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Runtime } from "./schema.js";
import {
  buildDockerArgs,
  buildProvisionerDockerArgs,
  planWorktreeGitMounts,
  assertWorktreeGitMountPlanned,
  preflightProjectMount,
  GIT_UNAVAILABLE_EXIT_CODE,
  type SpawnContext,
} from "./spawn.js";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE, type DependencyVolumePlan } from "./dependency-provisioning.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { invoke, type DockerExecFn } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

// ─── Harness ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitQuiet(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

type Fixture = {
  /** Host absolute path of the parent repo's `.git` — what the pointer names and
   *  what the bind mount reproduces. */
  parentGitDir: string;
  /** Host absolute path of the worktree ADMIN dir (`<parent>/.git/worktrees/<n>`)
   *  — the first hop, and the mount the ticket records as insufficient alone. */
  adminGitDir: string;
  /** The worktree tree as it lands in the container, at a path of its own. */
  projectPath: string;
  /** Pristine copy of the parent `.git`, used to materialize mount variants. */
  savedGitDir: string;
  base: string;
};

/** A real linked worktree, with the host tree then torn down so ONLY the copied
 *  worktree exists. Nothing resolves until a `materialize*` call puts some
 *  subset of the parent `.git` back at its original absolute path — which is
 *  precisely what a host-path-preserving bind mount does in the container. */
function makeWorktreeFixture(baseDir?: string): Fixture {
  const base = baseDir ?? realpathSync(mkdtempSync(join(tmpdir(), "fg559e-")));
  if (!baseDir) tmpDirs.push(base);

  const repo = join(base, "host", "parent");
  mkdirSync(repo, { recursive: true });
  gitQuiet(repo, "init", "-b", "main");
  gitQuiet(repo, "config", "user.email", "test@forge.test");
  gitQuiet(repo, "config", "user.name", "Forge Test");
  writeFileSync(join(repo, "file.txt"), "revision 1\n");
  gitQuiet(repo, "add", ".");
  gitQuiet(repo, "commit", "-m", "commit 1");

  const wtPath = join(base, "host", "wt");
  gitQuiet(repo, "worktree", "add", "-b", "fg559e-wt", wtPath);

  assert.equal(
    statSync(join(wtPath, ".git")).isFile(),
    true,
    "fixture must be a LINKED WORKTREE — <wt>/.git must be a gitdir: pointer FILE, not a directory"
  );

  const parentGitDir = join(repo, ".git");
  const adminGitDir = readFileSync(join(wtPath, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
  assert.ok(
    adminGitDir.startsWith(`${parentGitDir}/worktrees/`),
    `fixture's gitdir: pointer must be an ABSOLUTE path into the parent's admin dir, got ${adminGitDir}`
  );

  const projectPath = join(base, "container", "project");
  mkdirSync(dirname(projectPath), { recursive: true });
  cpSync(wtPath, projectPath, { recursive: true });

  const savedGitDir = join(base, "saved-git");
  cpSync(parentGitDir, savedGitDir, { recursive: true });
  rmSync(join(base, "host"), { recursive: true, force: true });

  return { parentGitDir, adminGitDir, projectPath, savedGitDir, base };
}

/** The full, correct mount: the whole common `.git` back at its host path. */
function materializeCommonGit(f: Fixture): void {
  mkdirSync(dirname(f.parentGitDir), { recursive: true });
  cpSync(f.savedGitDir, f.parentGitDir, { recursive: true });
}

/** The ticket's ALL-FAIL trial: ONLY the worktree admin dir, at its own path.
 *  The absolute hop lands; the relative `commondir` hop (`../..`) does not. */
function materializeAdminDirOnly(f: Fixture): void {
  mkdirSync(f.adminGitDir, { recursive: true });
  cpSync(f.adminGitDir.replace(f.parentGitDir, f.savedGitDir), f.adminGitDir, { recursive: true });
}

// ─── 1. Near-miss mounts, proven insufficient FUNCTIONALLY ───────────────────

test("fg559e (positive control): the full common .git at its host path makes git work in the worktree", () => {
  const f = makeWorktreeFixture();
  materializeCommonGit(f);
  const r = git(f.projectPath, "log", "--oneline");
  assert.equal(r.code, 0, `the correct mount must make git work — otherwise the two negatives below prove nothing: ${r.stderr}`);
  assert.match(r.stdout, /commit 1/, "git log must carry real history under the correct mount");
});

test("fg559e: mounting ONLY the worktree admin dir leaves git BROKEN — the ticket's ALL-FAIL trial, as behaviour not as an argv predicate", () => {
  const f = makeWorktreeFixture();
  materializeAdminDirOnly(f);

  assert.equal(existsSync(f.adminGitDir), true, "the admin dir really is materialized — otherwise this test is vacuous");
  assert.equal(existsSync(f.parentGitDir), true, "…and it sits inside a parent .git path that now exists on disk");

  const r = git(f.projectPath, "log", "--oneline");
  assert.notEqual(r.code, 0, "git MUST fail with only the admin dir mounted — commondir hops OUT of it (../..)");
  assert.match(r.stderr, /not a git repository/i, `expected the dangling-gitdir error, got: ${r.stderr}`);
});

test("fg559e: mounting the common .git but NOT its worktrees/ subtree also leaves git broken — the single outermost mount must carry BOTH hops", () => {
  const f = makeWorktreeFixture();
  materializeCommonGit(f);
  rmSync(join(f.parentGitDir, "worktrees"), { recursive: true, force: true });

  const r = git(f.projectPath, "log", "--oneline");
  assert.notEqual(r.code, 0, "a common .git with the admin dir carved out must NOT satisfy the pointer");
  assert.match(r.stderr, /not a git repository/i, `expected the dangling-gitdir error, got: ${r.stderr}`);
});

// ─── 2. The mount plan and the enforcement predicate ─────────────────────────

const RUNTIME: Runtime = {
  name: "fg559e-test",
  description: "FG-559 enforcement test runtime stub",
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
    TASK_ID: "task-fg559e",
    TASK_DIR: join(tmpdir(), "fg559e-task"),
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

test("fg559e (piece A): every insufficient argv is REFUSED — missing, wrong path, non-identity, admin-dir-only", () => {
  const f = makeWorktreeFixture();
  materializeCommonGit(f);
  const decoy = join(f.base, "somewhere-else");

  const insufficient: Array<[string, string[]]> = [
    ["no mounts at all", []],
    ["only the project mount (the pre-FG-559 argv)", ["-v", `${f.projectPath}:/project:rw`]],
    ["the bind at a DIFFERENT absolute path", ["-v", `${decoy}:${decoy}:ro`]],
    ["the parent .git bound at a NON-IDENTITY container path", ["-v", `${f.parentGitDir}:/parent-git:ro`]],
    ["only the worktree ADMIN dir", ["-v", `${f.adminGitDir}:${f.adminGitDir}:ro`]],
    ["a DESCENDANT of the required path (objects/ only)", [
      "-v", `${join(f.parentGitDir, "objects")}:${join(f.parentGitDir, "objects")}:ro`,
    ]],
  ];

  for (const [label, args] of insufficient) {
    assert.throws(
      () => assertWorktreeGitMountPlanned(f.projectPath, args),
      (e: Error) => /FG-559/.test(e.message) && e.message.includes(f.parentGitDir),
      `argv with ${label} must be REFUSED, naming the unmounted parent .git`
    );
  }
});

test("fg559e (piece A): an identity bind of the required path — or of an ancestor — satisfies the check", () => {
  const f = makeWorktreeFixture();
  materializeCommonGit(f);
  const ancestor = dirname(f.parentGitDir);

  assert.doesNotThrow(
    () => assertWorktreeGitMountPlanned(f.projectPath, ["-v", `${f.parentGitDir}:${f.parentGitDir}:ro`]),
    "the exact identity bind is the shape buildDockerArgs emits"
  );
  assert.doesNotThrow(
    () => assertWorktreeGitMountPlanned(f.projectPath, ["-v", `${ancestor}:${ancestor}:ro`]),
    "an ancestor bound at its own path also makes the gitdir: target resolve"
  );

  // Characterization, deliberately: the predicate answers "will this path
  // RESOLVE in the container", which a rw bind does. `:ro` is a separate policy,
  // enforced against buildDockerArgs' own output by the test below — not here.
  // If this ever starts throwing, the guard grew a second job; say so out loud.
  assert.doesNotThrow(
    () => assertWorktreeGitMountPlanned(f.projectPath, ["-v", `${f.parentGitDir}:${f.parentGitDir}:rw`]),
    "the mount-plan predicate is about resolvability, not about the :ro policy"
  );
});

test("fg559e (piece A): the guard NEVER refuses an ordinary dispatch — non-git, plain clone, absent dir, junk .git file", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg559e-ord-")));
  tmpDirs.push(base);

  const nonGit = join(base, "plain-dir");
  mkdirSync(nonGit, { recursive: true });
  writeFileSync(join(nonGit, "package.json"), "{}\n");

  const clone = join(base, "clone");
  mkdirSync(clone, { recursive: true });
  gitQuiet(clone, "init", "-b", "main");

  const absent = join(base, "does-not-exist");

  // A `.git` FILE that is not a gitdir: pointer — the guard must not invent a
  // requirement out of it (preflight is what judges whether it is healthy).
  const junk = join(base, "junk-dotgit");
  mkdirSync(junk, { recursive: true });
  writeFileSync(join(junk, ".git"), "this is not a pointer\n");

  for (const dir of [nonGit, clone, absent, junk]) {
    assert.deepEqual(planWorktreeGitMounts(dir), [], `${dir} must need no extra mount`);
    // Empty argv, deliberately: a guard that over-refuses here breaks every
    // ordinary dispatch, and an empty argv is the harshest input it can get.
    assert.doesNotThrow(
      () => assertWorktreeGitMountPlanned(dir, []),
      `${dir} must not be refused even with an EMPTY mount plan`
    );
  }

  for (const dir of [nonGit, clone, junk]) {
    const { args } = buildDockerArgs(RUNTIME, ctxFor(dir, "rw"));
    assert.deepEqual(
      mountSpecs(args).filter((s) => s.includes("/.git")),
      [],
      `${dir} must get NO extra .git bind — existing behaviour is unchanged`
    );
    assert.ok(mountSpecs(args).includes(`${dir}:/project:rw`), "the ordinary project mount is untouched");
  }
});

const PROVISIONER_PLAN: DependencyVolumePlan = {
  lockfileHash: "fg559ehash",
  volumes: [{ name: "forge-deps-fg559ehash", relPath: "", containerPath: "/project/node_modules" }],
  installRoot: "/project",
};

test("fg559e (piece A): a gitdir: pointer that is not a VERIFIED worktree admin dir is refused, never bind-mounted", () => {
  // The pointer line lives in the PROJECT tree, which the project itself — or a
  // prior writable agent — can rewrite. Resolving it and binding whatever it
  // names at its own host path would hand every later container arbitrary host
  // data, so anything but the shape `git worktree add` writes is refused.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg559e-hostile-")));
  tmpDirs.push(base);

  const secrets = join(base, "home", "victim", ".ssh");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "id_ed25519"), "PRIVATE KEY\n");

  // The near-miss that a shape check alone would let through: the
  // <parent>/worktrees/<name> layout with a commondir that resolves cleanly,
  // but a "common dir" that is not a git dir at all.
  const fakeAdmin = join(base, "home", "victim", "worktrees", "x");
  mkdirSync(fakeAdmin, { recursive: true });
  writeFileSync(join(fakeAdmin, "commondir"), "../..\n");
  writeFileSync(join(fakeAdmin, "gitdir"), `${base}/proj/.git\n`);

  const proj = join(base, "proj");
  mkdirSync(proj, { recursive: true });

  for (const [label, target] of [
    ["a plain host directory", secrets],
    ["a path that does not exist", join(base, "nope")],
    ["an admin-shaped dir whose common dir is not a git dir", fakeAdmin],
    ["the ancestor that holds an admin-shaped worktrees/ subtree", join(base, "home", "victim")],
  ] as Array<[string, string]>) {
    writeFileSync(join(proj, ".git"), `gitdir: ${target}\n`);
    assert.throws(() => planWorktreeGitMounts(proj), /FG-559/, `${label} must be refused, not planned`);
    assert.throws(
      () => buildDockerArgs(RUNTIME, ctxFor(proj, "rw")),
      /FG-559/,
      `${label} must never reach docker as a bind`
    );
    assert.throws(
      () => buildProvisionerDockerArgs(RUNTIME, ctxFor(proj, "rw"), PROVISIONER_PLAN),
      /FG-559/,
      `${label} must be refused on the provisioner argv too`
    );
  }

  // Non-vacuity: a REAL worktree still flows through the same code path.
  const f = makeWorktreeFixture();
  materializeCommonGit(f);
  assert.deepEqual(
    planWorktreeGitMounts(f.projectPath),
    [f.parentGitDir],
    "the verification must not refuse the shape git actually writes"
  );
});

test("fg559e: runContainer preflights the path it MOUNTS (repoRootForMount), not args.projectDir", () => {
  // Structural, like the provisioner-ordering test above: the two paths differ
  // only on a worktree dispatch, and the difference is which tree's `.git`
  // pointer gets checked — a state no in-process fixture can reach, because
  // forge creates the worktree itself and it is healthy when it does.
  const src = readFileSync(join(REPO_ROOT, "src", "v2", "runNext.ts"), "utf8");
  const runContainerAt = src.indexOf("async function runContainer(");
  assert.ok(runContainerAt > 0, "runContainer must still be findable — otherwise this test proves nothing");
  const body = src.slice(runContainerAt);

  assert.ok(
    body.includes("preflightProjectMount(repoRootForMount)"),
    "the workflow dispatch must preflight the worktree it mounts at /project"
  );
  assert.equal(
    body.includes("preflightProjectMount(args.projectDir)"),
    false,
    "preflighting args.projectDir leaves a dangling .git pointer in the WORKTREE unchecked"
  );
});

test("fg559e: the PROVISIONER argv carries the same read-only parent .git bind — it runs the same entrypoint probe", () => {
  const f = makeWorktreeFixture();
  materializeCommonGit(f);

  const args = buildProvisionerDockerArgs(RUNTIME, ctxFor(f.projectPath, "rw"), PROVISIONER_PLAN);
  assert.ok(
    mountSpecs(args).includes(`${f.parentGitDir}:${f.parentGitDir}:ro`),
    `the provisioner must bind the parent .git read-only too, got: ${mountSpecs(args).join(" ")}`
  );
});

test("fg559e: the PROVISIONER argv is refused when the parent .git bind cannot be expressed — the provisioner container starts BEFORE the agent one", () => {
  // Same colon-bearing host path as the dispatch test below: `-v` is
  // colon-delimited, so the bind buildProvisionerDockerArgs emits above is
  // malformed and its own assertion finds the required path unbound.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg559e-colon-prov-")));
  tmpDirs.push(base);
  const f = makeWorktreeFixture(join(base, "ho:st"));
  materializeCommonGit(f);
  assert.ok(f.parentGitDir.includes(":"), "the fixture must actually sit under a colon-bearing path");

  assert.throws(
    () => buildProvisionerDockerArgs(RUNTIME, ctxFor(f.projectPath, "rw"), PROVISIONER_PLAN),
    /FG-559[\s\S]*Refusing to dispatch/,
    "the provisioner argv must be refused host-side, not handed to docker"
  );

  const ordinary = makeWorktreeFixture();
  materializeCommonGit(ordinary);
  assert.doesNotThrow(
    () => buildProvisionerDockerArgs(RUNTIME, ctxFor(ordinary.projectPath, "rw"), PROVISIONER_PLAN),
    "an ordinary worktree provisioner argv must NOT be refused"
  );
});

test("fg559e: runContainer builds (and so asserts) the provisioner argv BEFORE it takes the provisioning lock and execs", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "v2", "runNext.ts"), "utf8");
  const runContainerAt = src.indexOf("async function runContainer(");
  const buildAt = src.indexOf("buildProvisionerDockerArgs(", runContainerAt);
  const provisionAt = src.indexOf("provisionDependencyCache(", runContainerAt);

  assert.ok(runContainerAt > 0 && buildAt > 0 && provisionAt > 0);
  assert.ok(
    buildAt < provisionAt,
    "the FG-559 refusal must land before any provisioner container starts — build the argv outside the lock callback"
  );
});

// ─── 3. Refusal lands BEFORE any container starts or any state is written ────

function setupProjectMountRuntime(): void {
  const fhome = process.env["FORGE_HOME"]!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  // Unlike the shared stubs in invoke.integration.test.ts this one MOUNTS THE
  // PROJECT — without a `${PROJECT_DIR}` mount buildDockerArgs skips the whole
  // FG-559 block and the test would pass vacuously.
  writeFileSync(
    runtimePath,
    `
name: claude
description: fg559e stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
  - { host: "\${PROJECT_DIR}", container: /project, mode: "\${PROJECT_MODE:-rw}" }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`
  );
  publishFlatAsGeneration(fhome);
}

test("fg559e (piece A, dispatch): a worktree whose parent .git cannot be bound at its host path FAILS the task before any container starts", async () => {
  setupProjectMountRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  // A host path holding a `:` cannot be expressed as a docker identity bind
  // (`-v host:container:mode` is colon-delimited), so buildDockerArgs emits the
  // bind and its own assertion then finds it unsatisfied. This is the only
  // route that reaches the guard through the REAL dispatch path — everywhere
  // else the mount and the check are computed from the same call, so proving
  // "refuses before any side effect" needs a state the two disagree on.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg559e-colon-")));
  tmpDirs.push(base);
  const f = makeWorktreeFixture(join(base, "ho:st"));
  materializeCommonGit(f);
  assert.ok(f.parentGitDir.includes(":"), "the fixture must actually sit under a colon-bearing path");

  let dockerCalls = 0;
  const countingExec: DockerExecFn = async () => {
    dockerCalls += 1;
    return 0;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "do thing",
    projectDir: f.projectPath,
    dockerExec: countingExec,
  });

  assert.equal(dockerCalls, 0, "NO container may start when the mount plan is refused");
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /FG-559/, `the refusal must reach the caller, got: ${r.error}`);
  assert.match(r.error ?? "", /Refusing to dispatch/);

  const task = getTask(r.taskId);
  assert.ok(task, "the task row must exist");
  // The failure mode this pins: a returned-but-not-thrown error that leaves the
  // row `running` forever. The row must be TERMINAL.
  assert.equal(task!.status, "failed", `task must be terminal-failed, got ${task!.status}`);
  assert.match(task!.error ?? "", /FG-559/);

  const types = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(!types.includes("container.exited"), `no container lifecycle event may be recorded, got: ${types.join(", ")}`);
  assert.ok(!types.includes("container.git_unavailable"), "the host refusal is not the container probe's event");
});

test("fg559e (dispatch): an ordinary worktree dispatch is NOT refused — it reaches docker with the parent .git bind in the argv", async () => {
  setupProjectMountRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  const f = makeWorktreeFixture();
  materializeCommonGit(f);

  let seen: string[] = [];
  const capturingExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    seen = args;
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const r = await invoke({
    agentRole: "engineer",
    task: "do thing",
    projectDir: f.projectPath,
    dockerExec: capturingExec,
  });

  assert.equal(r.status, "complete", `an ordinary worktree dispatch must not be refused, got: ${r.error}`);
  assert.ok(
    mountSpecs(seen).includes(`${f.parentGitDir}:${f.parentGitDir}:ro`),
    `the argv actually handed to docker must carry the read-only parent .git bind, got: ${mountSpecs(seen).join(" ")}`
  );
});

// ─── 4. preflightProjectMount — the latent surface (FG-559 fix 1) ────────────

test("fg559e: preflightProjectMount refuses ONLY the broken pointer — healthy worktree, plain clone and non-git all still pass", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg559e-pre-")));
  tmpDirs.push(base);

  const f = makeWorktreeFixture();
  materializeCommonGit(f);
  assert.doesNotThrow(() => preflightProjectMount(f.projectPath), "a worktree whose parent .git exists must pass");

  const clone = join(base, "clone");
  mkdirSync(clone, { recursive: true });
  gitQuiet(clone, "init", "-b", "main");
  assert.doesNotThrow(() => preflightProjectMount(clone), "a plain clone must pass — .git is a real directory");

  const nonGit = join(base, "non-git");
  mkdirSync(nonGit, { recursive: true });
  writeFileSync(join(nonGit, "package.json"), "{}\n");
  assert.doesNotThrow(() => preflightProjectMount(nonGit), "a non-git project must still dispatch (warn, never refuse)");

  // The pointer target vanishes host-side: a pruned worktree, or a parent repo
  // that moved. Broken on the HOST, so refuse rather than dispatch blind.
  rmSync(f.parentGitDir, { recursive: true, force: true });
  assert.throws(
    () => preflightProjectMount(f.projectPath),
    (e: Error) => /gitdir: pointer/.test(e.message) && e.message.includes(f.parentGitDir),
    "a pointer whose target is gone must be refused, naming the missing target"
  );

  // A `.git` FILE that parses as nothing at all is equally unusable.
  const junk = join(base, "junk");
  mkdirSync(junk, { recursive: true });
  writeFileSync(join(junk, ".git"), "not a pointer\n");
  assert.throws(
    () => preflightProjectMount(junk),
    /unparseable path/,
    "a .git FILE that is not a gitdir: pointer must be refused, not read as a healthy marker"
  );
});

// ─── 5. The shell surfaces, exercised as the REAL script text ────────────────

/** Slice a self-contained block out of a shell script by anchor lines, so the
 *  test runs the FILE's code rather than a paraphrase of it. Both anchors are
 *  asserted, so a rename fails loudly instead of silently testing nothing. */
function extractShellBlock(relPath: string, startsWith: string, endsBefore: string): string {
  const lines = readFileSync(join(REPO_ROOT, relPath), "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes(startsWith));
  assert.ok(start >= 0, `${relPath} no longer contains the anchor line ${JSON.stringify(startsWith)}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === endsBefore);
  assert.ok(end > start, `${relPath} no longer contains the end anchor ${JSON.stringify(endsBefore)}`);
  return lines.slice(start, end).join("\n");
}

function runBash(script: string, cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("fg559e (entrypoint probe): exits 122 on a broken worktree UNCONDITIONALLY, and passes a healthy one and a non-git dir", () => {
  const probe = extractShellBlock("docker/agent-entrypoint.sh", "# FG-559: prove git actually RESOLVES", 'exec "$@"');
  assert.match(probe, /exit 122/, "the extracted block must be the git probe");

  const broken = makeWorktreeFixture(); // parent .git deliberately NOT materialized
  const rBroken = runBash(probe, broken.projectPath);
  assert.equal(
    rBroken.code,
    GIT_UNAVAILABLE_EXIT_CODE,
    `an unmounted parent .git must exit ${GIT_UNAVAILABLE_EXIT_CODE}, got ${rBroken.code}: ${rBroken.stderr}`
  );
  assert.match(rBroken.stderr, /git is unusable/, "the probe must say why");
  assert.match(rBroken.stderr, /FG-559/, "the probe must name the ticket so the operator can find the cause");

  // No env-var escape hatch: a bypass is the silent history-blind dispatch the
  // probe exists to prevent, so the old FORGE_SKIP_GIT_PROBE=1 must do nothing.
  assert.doesNotMatch(probe, /FORGE_SKIP_GIT_PROBE/, "the probe must carry no bypass variable");
  const rSkipAttempt = runBash(probe, broken.projectPath, { FORGE_SKIP_GIT_PROBE: "1" });
  assert.equal(
    rSkipAttempt.code,
    GIT_UNAVAILABLE_EXIT_CODE,
    "FORGE_SKIP_GIT_PROBE=1 must NOT bypass the refusal on the SAME broken tree"
  );

  const healthy = makeWorktreeFixture();
  materializeCommonGit(healthy);
  assert.equal(runBash(probe, healthy.projectPath).code, 0, "a correctly-mounted worktree must fall through");

  const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "fg559e-nogit-")));
  tmpDirs.push(nonGit);
  assert.equal(runBash(probe, nonGit).code, 0, "a project with no .git at all must fall through, not be refused");
});

test("fg559e (entrypoint probe): the 122 sentinel matches GIT_UNAVAILABLE_EXIT_CODE and collides with no other sentinel", () => {
  const entrypoint = readFileSync(join(REPO_ROOT, "docker/agent-entrypoint.sh"), "utf8");
  assert.equal(GIT_UNAVAILABLE_EXIT_CODE, 122);
  assert.ok(
    entrypoint.includes(`exit ${GIT_UNAVAILABLE_EXIT_CODE}`),
    "docker/agent-entrypoint.sh must exit the SAME sentinel spawn.ts classifies — nothing else couples the two"
  );
  assert.notEqual(GIT_UNAVAILABLE_EXIT_CODE, DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE);
  assert.notEqual(GIT_UNAVAILABLE_EXIT_CODE, IDLE_TIMEOUT_EXIT_CODE);
});

test("fg559e (forge-test.sh): the cold-start scratch for a WORKTREE source ends up with a working git", () => {
  const block = extractShellBlock("docker/forge-test.sh", 'if [[ ! -d "$WORK_DIR" ]]; then', "_sync_sources");
  assert.match(block, /-e "\$SRC_DIR\/\.git"/, "the guard must be -e (pointer FILE or directory), not -d");
  assert.match(block, /cp -R "\$SRC_DIR\/\.git"/, "the copy must follow the -e guard");

  const f = makeWorktreeFixture();
  materializeCommonGit(f);
  const work = join(f.base, "forge-work");

  const r = runBash(block, f.base, { SRC_DIR: f.projectPath, WORK_DIR: work });
  assert.equal(r.code, 0, `the cold-start block must succeed: ${r.stderr}`);
  assert.equal(existsSync(join(work, ".git")), true, "the scratch must carry the source's .git");

  const probe = git(work, "rev-parse", "--git-dir");
  assert.equal(probe.code, 0, `git must RESOLVE in the scratch, not merely have a .git entry: ${probe.stderr}`);
  assert.equal(
    git(work, "log", "--oneline").code,
    0,
    "history must be readable from the scratch — this is the path every agent runs tests on"
  );

  // Non-vacuity: the pre-FG-559 `-d` guard is FALSE for a pointer FILE, so the
  // scratch was built with no git at all. Same block, one character reverted.
  const preFix = block.replace('-e "$SRC_DIR/.git"', '-d "$SRC_DIR/.git"');
  assert.notEqual(preFix, block, "the -d reversion must actually apply — otherwise this control proves nothing");
  const work2 = join(f.base, "forge-work-prefix");
  assert.equal(runBash(preFix, f.base, { SRC_DIR: f.projectPath, WORK_DIR: work2 }).code, 0);
  assert.equal(
    existsSync(join(work2, ".git")),
    false,
    "the pre-FG-559 -d guard must be shown to skip the copy — otherwise the fix is untested"
  );
});

test("fg559e (forge-test.sh): a PLAIN-CLONE source is unaffected by the -e widening", () => {
  const block = extractShellBlock("docker/forge-test.sh", 'if [[ ! -d "$WORK_DIR" ]]; then', "_sync_sources");

  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg559e-clone-src-")));
  tmpDirs.push(base);
  const src = join(base, "clone");
  mkdirSync(src, { recursive: true });
  gitQuiet(src, "init", "-b", "main");
  gitQuiet(src, "config", "user.email", "test@forge.test");
  gitQuiet(src, "config", "user.name", "Forge Test");
  writeFileSync(join(src, "f.txt"), "x\n");
  gitQuiet(src, "add", ".");
  gitQuiet(src, "commit", "-m", "c1");

  const work = join(base, "scratch");
  assert.equal(runBash(block, base, { SRC_DIR: src, WORK_DIR: work }).code, 0);
  assert.equal(statSync(join(work, ".git")).isDirectory(), true, "a plain clone still copies a real .git DIRECTORY");
  assert.equal(git(work, "log", "--oneline").code, 0, "and git still works in the scratch");
});

// ─── 6. Known limitation: RELATIVE gitdir pointers ───────────────────────────

test("fg559e: a RELATIVE gitdir: pointer is resolved against the HOST path — a mount the container will never look up (known FG-559 limitation)", () => {
  const f = makeWorktreeFixture();
  materializeCommonGit(f);

  // Rewrite the pointer the way `git submodule` always does, and the way
  // `git worktree add --relative-paths` / worktree.useRelativePaths does on
  // git >= 2.48. Host-side this resolves identically; IN THE CONTAINER the
  // worktree lands at /project, so the same relative path resolves to
  // /<something> and the host-path bind is never consulted.
  const relative = `../..${f.adminGitDir.slice(f.base.length)}`;
  writeFileSync(join(f.projectPath, ".git"), `gitdir: ${relative}\n`);
  assert.equal(git(f.projectPath, "rev-parse", "--git-dir").code, 0, "the relative pointer must be valid ON THE HOST");

  assert.deepEqual(
    planWorktreeGitMounts(f.projectPath),
    [f.parentGitDir],
    "the plan is the HOST-resolved path — correct host-side, but not the path /project/<relative> reaches in the container"
  );
  assert.doesNotThrow(
    () => assertWorktreeGitMountPlanned(f.projectPath, ["-v", `${f.parentGitDir}:${f.parentGitDir}:ro`]),
    "the host guard ACCEPTS this argv: it proves the plan was satisfied, not that the container can resolve the pointer"
  );

  // Consequence, pinned so it cannot regress into a SILENT failure: the only
  // thing that catches this is the container-side probe, which exits 122 and is
  // classified verification_environment_unavailable. If relative-pointer
  // support ever lands, this test is the one that should be revisited.
  assert.equal(GIT_UNAVAILABLE_EXIT_CODE, 122, "the container probe remains the backstop for this case");
});
