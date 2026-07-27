// FG-621: in-container git for the PRIVATE CLONE substrate.
//
// FG-559's defect twin. A mutating agent's workspace is now a
// `git clone --shared` of the parent repo, so its `.git` is a real DIRECTORY —
// which the FG-559 planner read as "a plain clone, nothing to mount" and
// returned [] for. But a shared clone owns no objects: its
// `.git/objects/info/alternates` names the PARENT's object store by ABSOLUTE
// HOST PATH, a path that does not exist inside the container. Nothing mounted →
// broken object store → `git log` and `git commit` both fail, and (as in
// FG-559) the agent works from the file tree and reports success.
//
// What this file pins:
//
//   1. PLAN — a real `--shared` clone plans exactly ONE mount: the parent's
//      `.git/objects` as the alternates entry names it (every proof runs against
//      its realpath). Not the parent `.git`.
//   2. ARGV (AC 2 standing coverage) — buildDockerArgs emits it as
//      `-v <p>:<p>:ro`, and NO argv entry binds the parent's `.git`, refs,
//      index, HEAD or packed-refs, at any width. The parent's ref namespace is
//      ABSENT from the container, not merely read-only; that absence is what
//      makes AC 2 structural rather than a comment.
//   3. FAIL CLOSED — the alternates file lives INSIDE the rw-mounted workspace,
//      so it is more agent-writable than the `gitdir:` pointer FG-559 already
//      refuses to trust. Tampered, foreign, relative, multi-entry, self-naming
//      or missing: every one REFUSES, naming the workspace and the unverified
//      path. Never [] and never the unverified path.
//   4. FUNCTIONAL — with ONLY the objects dir materialized read-only, `git log`
//      and `git commit` SUCCEED in the clone while every write aimed at the
//      parent is refused.
//
// The negative control (test 4a) is load-bearing exactly as in FG-559: without
// the objects mount, `git log` in the clone MUST fail. Every positive assertion
// about the mount only means something because that control fails first.
//
// Host-side simulation, not Docker: `:ro` is modelled by `chmod -R a-w` (a real
// ro bind is STRICTER — kernel-enforced at the mount, not the inode — so the gap
// is in the safe direction) and "not mounted" by "not present on the host". One
// gap this cannot model: docker materialises the intermediate `<parent>/.git`
// directory for the nested objects bind inside the CONTAINER's own writable
// layer, so a container can create files there — they land on the ephemeral
// layer and can never reach the host parent repo. The live proof of that is the
// operator-run smoke script (scripts/fg621-clone-boundary-smoke.sh, AC 2/AC 11).
//
// Tier: worktree — real git repos and a real `git clone --shared`. Structural
// precedent: fg559-worktree-git-mount.worktree.test.ts.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Runtime, Workflow } from "./schema.js";
import {
  buildDockerArgs,
  buildProvisionerDockerArgs,
  planWorktreeGitMounts,
  assertWorktreeGitMountPlanned,
  type SpawnContext,
} from "./spawn.js";
import type { DependencyVolumePlan } from "./dependency-provisioning.js";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { invoke, type DockerExecFn as InvokeDockerExecFn } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    // The read-only-mount simulation chmods the tree unwritable; restore before rm.
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

function identify(repo: string): void {
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: repo, stdio: "ignore" });
}

const BRANCH = "forge/run-fg621/task-1";

type CloneFixture = {
  base: string;
  /** The parent repository — Forge's canonical project directory. */
  parentRepo: string;
  parentGitDir: string;
  /** realpath of <parent>/.git/objects — the ONLY path the clone substrate mounts. */
  parentObjects: string;
  /** The private clone workspace (PROJECT_DIR for a mutating dispatch). */
  clonePath: string;
  alternatesFile: string;
  /** Saved copy of the parent object store, used to materialize the narrow mount. */
  savedObjects: string;
  shaA: string;
  shaB: string;
  shaC: string;
};

/** A real parent repo + a real `git clone --shared` of it, checked out on the
 *  deterministic private task branch at a recorded base SHA — the exact substrate
 *  FG-621 provisions for a mutating task. */
function makeSharedCloneFixture(): CloneFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg621-")));
  tmpDirs.push(base);

  const parentRepo = join(base, "host", "parent");
  mkdirSync(parentRepo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: parentRepo, stdio: "ignore" });
  identify(parentRepo);

  const shas: string[] = [];
  for (const n of [1, 2, 3]) {
    writeFileSync(join(parentRepo, "file.txt"), `revision ${n}\n`);
    execFileSync("git", ["add", "."], { cwd: parentRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `commit ${n}`], { cwd: parentRepo, stdio: "ignore" });
    shas.push(gitOk(parentRepo, "rev-parse", "HEAD").trim());
  }
  // A ref that exists ONLY in packed-refs — the same near-miss guard FG-559 uses,
  // and one of AC 2's named write targets.
  gitOk(parentRepo, "update-ref", "refs/remotes/origin/main", shas[2]!);
  gitOk(parentRepo, "pack-refs", "--all");

  const clonePath = join(base, "host", "clone");
  execFileSync("git", ["clone", "--shared", parentRepo, clonePath], { stdio: "ignore" });
  identify(clonePath);
  gitOk(clonePath, "checkout", "-b", BRANCH, shas[1]!);

  const parentGitDir = join(parentRepo, ".git");
  const parentObjects = realpathSync(join(parentGitDir, "objects"));
  const alternatesFile = join(clonePath, ".git", "objects", "info", "alternates");

  // Anti-vacuity. If a refactor turns this fixture into a plain clone or a
  // worktree, every assertion below still "passes" and proves nothing.
  assert.equal(
    statSync(join(clonePath, ".git")).isDirectory(),
    true,
    "fixture must be a CLONE — <clone>/.git must be a real DIRECTORY, not a gitdir: pointer file",
  );
  assert.equal(
    readFileSync(alternatesFile, "utf8").trim(),
    parentObjects,
    "fixture must be a --shared clone whose alternates names the parent object store by absolute host path",
  );
  assert.deepEqual(
    readdirSync(join(clonePath, ".git", "objects", "pack")),
    [],
    "fixture must BORROW its objects — a clone with its own packs would make the mount unnecessary and the test vacuous",
  );

  const savedObjects = join(base, "saved-objects");
  cpSync(parentObjects, savedObjects, { recursive: true });

  return {
    base,
    parentRepo,
    parentGitDir,
    parentObjects,
    clonePath,
    alternatesFile,
    savedObjects,
    shaA: shas[0]!,
    shaB: shas[1]!,
    shaC: shas[2]!,
  };
}

/** The container view the FG-621 mount plan produces: the parent repository is
 *  GONE except for its object store, which is present read-only at its own host
 *  path. Nothing else of the parent — no HEAD, no refs, no index, no packed-refs. */
function materializeNarrowObjectMount(f: CloneFixture, opts: { readOnly?: boolean } = {}): void {
  rmSync(f.parentRepo, { recursive: true, force: true });
  mkdirSync(f.parentGitDir, { recursive: true });
  cpSync(f.savedObjects, f.parentObjects, { recursive: true });
  if (opts.readOnly) execFileSync("chmod", ["-R", "a-w", f.parentObjects]);
}

const RUNTIME: Runtime = {
  name: "fg621-test",
  description: "FG-621 mount-plan test runtime stub",
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

const PROVISIONER_PLAN: DependencyVolumePlan = {
  lockfileHash: "fg621hash",
  volumes: [{ name: "forge-deps-fg621hash", relPath: "", containerPath: "/project/node_modules" }],
  installRoot: "/project",
};

/** Every production dispatch supplies CANONICAL_PROJECT_DIR — Forge's own record
 *  of the parent a workspace was made from. On the clone substrate the planner
 *  REFUSES without it, so a ctx that omits it models a caller that has lost the
 *  one input the identity proof runs on, never an ordinary dispatch. */
function ctxFor(projectDir: string, mode: "rw" | "ro" = "rw", canonicalProjectDir?: string): SpawnContext {
  return {
    TASK_ID: "task-fg621",
    TASK_DIR: join(tmpdir(), "fg621-task"),
    PROJECT_DIR: projectDir,
    PROJECT_MODE: mode,
    MODEL: "test-model",
    SYSTEM_PROMPT: "system",
    TASK_PACKAGE_MARKDOWN: "# Task\n",
    ...(canonicalProjectDir === undefined ? {} : { CANONICAL_PROJECT_DIR: canonicalProjectDir }),
  };
}

function mountSpecs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-v") out.push(args[i + 1]!);
  return out;
}

// ─── 1. The plan ─────────────────────────────────────────────────────────────

test("fg621: a --shared clone plans exactly ONE mount — the parent's .git/objects, realpath-normalized", () => {
  const f = makeSharedCloneFixture();

  assert.deepEqual(
    planWorktreeGitMounts(f.clonePath, f.parentRepo),
    [f.parentObjects],
    "the clone borrows exactly one object store; the plan is that store and nothing wider",
  );
  assert.notEqual(
    planWorktreeGitMounts(f.clonePath, f.parentRepo)[0],
    f.parentGitDir,
    "the plan must NOT be the parent .git — refs/index/HEAD/packed-refs stay out of the container entirely",
  );
});

test("fg621: substrates that borrow nothing still plan no mount at all (FG-559 behavior, unchanged)", () => {
  const f = makeSharedCloneFixture();

  // A NON-shared local clone: git hardlinks the pack instead of borrowing it, so
  // the repo is self-contained and needs no bind.
  const plain = join(f.base, "host", "plain-clone");
  execFileSync("git", ["clone", "--no-hardlinks", f.parentRepo, plain], { stdio: "ignore" });
  assert.equal(existsSync(join(plain, ".git", "objects", "info", "alternates")), false, "a plain clone has no alternates");
  assert.deepEqual(planWorktreeGitMounts(plain), [], "a self-contained clone needs no extra mount");

  const fresh = join(f.base, "host", "fresh");
  mkdirSync(fresh, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: fresh, stdio: "ignore" });
  assert.deepEqual(planWorktreeGitMounts(fresh), [], "an empty repo owns no objects but has no HEAD to serve — no mount, no refusal");

  identify(fresh);
  writeFileSync(join(fresh, "a.txt"), "a\n");
  gitOk(fresh, "add", ".");
  gitOk(fresh, "commit", "-m", "c1");
  assert.deepEqual(planWorktreeGitMounts(fresh), [], "an ordinary checkout owns its objects — no extra mount");

  const nonGit = join(f.base, "host", "non-git");
  mkdirSync(nonGit, { recursive: true });
  assert.deepEqual(planWorktreeGitMounts(nonGit), [], "a non-git dir needs no extra mount");
  assert.deepEqual(planWorktreeGitMounts(join(f.base, "does-not-exist")), [], "an absent dir needs no extra mount");
});

test("fg621: a clone made through a SYMLINKED parent path plans the path the container will look up", () => {
  const f = makeSharedCloneFixture();
  // The container re-reads this same alternates file, so the bind must land at
  // exactly the path it NAMES. Planning the realpath instead would leave the
  // entry dangling in the container — FG-559's failure mode, silently.
  const link = join(f.base, "linked-parent");
  symlinkSync(f.parentRepo, link);
  const viaLink = join(f.base, "host", "clone-via-link");
  execFileSync("git", ["clone", "--shared", link, viaLink], { stdio: "ignore" });
  identify(viaLink);

  const named = readFileSync(join(viaLink, ".git", "objects", "info", "alternates"), "utf8").trim();
  assert.equal(named, join(link, ".git", "objects"), "fixture must record the symlinked path, or this test is vacuous");
  assert.deepEqual(planWorktreeGitMounts(viaLink, f.parentRepo), [named], "the plan is the path the alternates entry names");
  assert.equal(
    realpathSync(planWorktreeGitMounts(viaLink, f.parentRepo)[0]!),
    f.parentObjects,
    "and every proof still ran against the canonical parent object store behind it",
  );
  assert.deepEqual(
    planWorktreeGitMounts(viaLink, link),
    [named],
    "verification against Forge-owned state compares canonical paths, so the symlink does not defeat it",
  );
});

// ─── 2. The argv (AC 2 standing coverage) ────────────────────────────────────

test("fg621 (AC 2): the argv identity-binds the parent objects dir :ro — for blue AND red — and nothing wider", () => {
  const f = makeSharedCloneFixture();

  for (const mode of ["rw", "ro"] as const) {
    const { args } = buildDockerArgs(RUNTIME, ctxFor(f.clonePath, mode, f.parentRepo));
    const specs = mountSpecs(args);

    assert.ok(
      specs.includes(`${f.parentObjects}:${f.parentObjects}:ro`),
      `PROJECT_MODE=${mode} argv must bind the parent object store READ-ONLY at its own host path, got: ${specs.join(" ")}`,
    );
    assert.ok(
      specs.includes(`${f.clonePath}:/project:${mode}`),
      `PROJECT_MODE=${mode} project mount must be untouched by FG-621, got: ${specs.join(" ")}`,
    );

    // The narrowness claim, stated against the argv: every mount whose host path
    // touches the parent repository is exactly the object store. An ancestor
    // mount (the parent repo, the parent .git, or a tmp root above them) would
    // drag refs/index/HEAD/packed-refs into the container and is what this
    // assertion exists to catch.
    for (const spec of specs) {
      const host = spec.split(":")[0]!;
      if (!host.startsWith("/")) continue; // named volume, not a host bind
      const touchesParent = f.parentRepo === host || f.parentRepo.startsWith(`${host}/`) || host.startsWith(`${f.parentRepo}/`);
      if (!touchesParent) continue;
      assert.equal(
        host,
        f.parentObjects,
        `the ONLY parent-repo path in the argv may be its object store; ${spec} exposes more of the parent repo`,
      );
    }
    for (const forbidden of ["HEAD", "refs", "index", "packed-refs", "config", "hooks"]) {
      const path = join(f.parentGitDir, forbidden);
      assert.equal(
        specs.some((s) => s.split(":")[0] === path),
        false,
        `the parent's ${forbidden} must be ABSENT from the container, not merely read-only — found a bind of ${path}`,
      );
    }
  }
});

test("fg621 (piece A): the mount-plan check refuses an argv missing the parent object-store bind", () => {
  const f = makeSharedCloneFixture();

  const { args } = buildDockerArgs(RUNTIME, ctxFor(f.clonePath, "rw", f.parentRepo));
  assert.doesNotThrow(
    () => assertWorktreeGitMountPlanned(f.clonePath, args, f.parentRepo),
    "the argv buildDockerArgs produces must satisfy its own assertion",
  );

  // Drop the objects bind — this is the pre-FG-621 argv, byte for byte, and the
  // state the planner used to return [] for (the assertion was vacuous on it).
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v" && args[i + 1]!.startsWith(`${f.parentObjects}:`)) {
      i++;
      continue;
    }
    stripped.push(args[i]!);
  }
  assert.throws(
    () => assertWorktreeGitMountPlanned(f.clonePath, stripped, f.parentRepo),
    (e: Error) => e.message.includes(f.parentObjects) && e.message.includes(f.clonePath) && /FG-621/.test(e.message),
    "the check must refuse — naming the clone and the unmounted object store — rather than warn",
  );
});

test("fg621: the dependency provisioner container gets the same narrow read-only object mount", () => {
  const f = makeSharedCloneFixture();

  const args = buildProvisionerDockerArgs(
    RUNTIME,
    { TASK_ID: "task-fg621", PROJECT_DIR: f.clonePath, CANONICAL_PROJECT_DIR: f.parentRepo },
    PROVISIONER_PLAN,
  );
  const specs = mountSpecs(args);
  assert.ok(
    specs.includes(`${f.parentObjects}:${f.parentObjects}:ro`),
    `the provisioner runs the same entrypoint git probe and needs the same bind, got: ${specs.join(" ")}`,
  );
  assert.ok(specs.includes(`${f.clonePath}:/project:ro`), "the provisioner still mounts the project read-only");
});

// ─── 3. Fail closed: the alternates file is a VALUE, never an instruction ────

/** Every tampered-alternates case must REFUSE at plan time, and must refuse on
 *  every argv builder — the agent container and the provisioner that starts
 *  before it. Returning [] (history-blind container) or the unverified path
 *  (arbitrary host data bound at its own path in every later container) are the
 *  two failures this asserts against. */
function assertRefuses(f: CloneFixture, mustMention: string, why: string): void {
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath, f.parentRepo),
    (e: Error) =>
      /FG-621/.test(e.message) && e.message.includes(f.clonePath) && e.message.includes(mustMention),
    `${why}: the plan must refuse, naming the clone and the unverified value`,
  );
  assert.throws(
    () => buildDockerArgs(RUNTIME, ctxFor(f.clonePath, "rw", f.parentRepo)),
    /FG-621/,
    `${why}: must never reach docker as a bind`,
  );
  assert.throws(
    () =>
      buildProvisionerDockerArgs(
        RUNTIME,
        { TASK_ID: "task-fg621", PROJECT_DIR: f.clonePath, CANONICAL_PROJECT_DIR: f.parentRepo },
        PROVISIONER_PLAN,
      ),
    /FG-621/,
    `${why}: must be refused on the provisioner argv too`,
  );
}

test("fg621 (fails closed): alternates naming a FOREIGN non-git path is refused, never bind-mounted", () => {
  const f = makeSharedCloneFixture();
  // The whole point of not trusting the file: a rewritten entry would otherwise
  // hand every later container this directory at its own host path.
  const secrets = join(f.base, "home", "victim", ".ssh");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "id_ed25519"), "PRIVATE KEY\n");
  writeFileSync(f.alternatesFile, `${secrets}\n`);

  assertRefuses(f, secrets, "a plain host directory");
});

test("fg621 (fails closed): alternates naming a FOREIGN REAL repository's object store is refused", () => {
  const f = makeSharedCloneFixture();
  // The near-miss a shape check alone lets through: a genuine git object store,
  // structurally indistinguishable from the parent's. What refuses it is the
  // base-commit containment proof — an unrelated repo does not hold THIS
  // workspace's checked-out commit.
  const other = join(f.base, "host", "other-repo");
  mkdirSync(other, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: other, stdio: "ignore" });
  identify(other);
  writeFileSync(join(other, "secret.txt"), "someone else's history\n");
  gitOk(other, "add", ".");
  gitOk(other, "commit", "-m", "other");
  const otherObjects = realpathSync(join(other, ".git", "objects"));
  writeFileSync(f.alternatesFile, `${otherObjects}\n`);

  assertRefuses(f, otherObjects, "a foreign but genuine git object store");
});

test("fg621 (fails closed): a RELATIVE alternates entry is refused", () => {
  const f = makeSharedCloneFixture();
  // Host-side this resolves against the object dir and works; in the container
  // the workspace lands at /project, so the same relative path resolves
  // somewhere else entirely. Identity binds only make sense for absolute paths.
  writeFileSync(f.alternatesFile, "../../../parent/.git/objects\n");

  assertRefuses(f, "../../../parent/.git/objects", "a relative alternate");
});

test("fg621 (fails closed): a SECOND alternates entry is refused", () => {
  const f = makeSharedCloneFixture();
  const other = join(f.base, "host", "second-store");
  mkdirSync(other, { recursive: true });
  writeFileSync(f.alternatesFile, `${f.parentObjects}\n${other}\n`);

  assertRefuses(f, other, "a second alternate object store");
});

test("fg621 (fails closed): a MISSING alternates file on a borrowing clone is refused", () => {
  const f = makeSharedCloneFixture();
  rmSync(f.alternatesFile);

  // Not [] — the clone owns no objects, so it cannot serve its own history to
  // anyone. Silently planning nothing here is precisely the FG-559 defect.
  assertRefuses(f, "HEAD resolves", "a deleted alternates file");
});

test("fg621 (fails closed): an EMPTY alternates file, a directory in its place, and a SELF-naming entry are refused", () => {
  const f = makeSharedCloneFixture();

  writeFileSync(f.alternatesFile, "\n# only a comment\n");
  assertRefuses(f, f.alternatesFile, "an alternates file with no entries");

  writeFileSync(f.alternatesFile, `${realpathSync(join(f.clonePath, ".git", "objects"))}\n`);
  assertRefuses(f, "own object store", "a self-naming alternate");

  rmSync(f.alternatesFile);
  mkdirSync(f.alternatesFile);
  assertRefuses(f, f.alternatesFile, "a directory where the alternates file belongs");
});

// ─── 4. Identity against Forge-owned state — MANDATORY, never conditional ────

test("fg621 (fails closed): a borrowed object store with NO Forge-owned parent to verify against is refused", () => {
  const f = makeSharedCloneFixture();

  // The shape checks all pass here — this is a genuine, untampered `--shared`
  // clone. What is missing is the only input that can say "THIS project's
  // parent" rather than "some git repository". A planner that skipped the
  // comparison when it had no canonical dir would mount whatever the
  // agent-writable alternates file named, and the skip would be invisible.
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath),
    (e: Error) => /FG-621/.test(e.message) && e.message.includes(f.clonePath) && /canonical/.test(e.message),
    "no canonical project dir means no identity proof — refuse, never fall back to the shape checks",
  );
  assert.throws(
    () => buildDockerArgs(RUNTIME, ctxFor(f.clonePath)),
    /FG-621/,
    "and the refusal holds on the agent argv",
  );
  assert.throws(
    () => buildProvisionerDockerArgs(RUNTIME, { TASK_ID: "task-fg621", PROJECT_DIR: f.clonePath }, PROVISIONER_PLAN),
    /FG-621/,
    "and on the provisioner argv, which is the FIRST container of a dispatch",
  );
});

test("fg621 (fails closed): a SECOND repository holding the very same history is refused — shape and containment cannot tell it apart", () => {
  const f = makeSharedCloneFixture();

  // The near-miss no shape check and no containment proof can catch: an ordinary
  // (non-shared) clone of the parent is a real git object store, holds THIS
  // workspace's checked-out commit, and sits at a path the agent chose. Only the
  // derive-and-compare against Forge-owned state refuses it — and without that,
  // an agent that repoints its own alternates gets an arbitrary host directory
  // identity-bind-mounted into every container of the dispatch.
  const twin = join(f.base, "host", "twin");
  execFileSync("git", ["clone", "--no-hardlinks", f.parentRepo, twin], { stdio: "ignore" });
  const twinObjects = realpathSync(join(twin, ".git", "objects"));
  writeFileSync(f.alternatesFile, `${twinObjects}\n`);

  assert.equal(
    git(f.base, "--git-dir", twinObjects.replace(/objects$/, ""), "cat-file", "-e", `${f.shaB}^{commit}`).code,
    0,
    "fixture: the twin really does contain this workspace's base commit, so containment alone would sanction it",
  );
  assertRefuses(f, twinObjects, "a second repository carrying the same history");
});

test("fg621: given the canonical project dir, the plan is VERIFIED against it and refuses any mismatch", () => {
  const f = makeSharedCloneFixture();

  assert.deepEqual(
    planWorktreeGitMounts(f.clonePath, f.parentRepo),
    [f.parentObjects],
    "the alternates value agrees with the store derived from Forge-owned state, so the plan stands",
  );

  const other = join(f.base, "host", "other-repo");
  mkdirSync(other, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: other, stdio: "ignore" });
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath, other),
    (e: Error) => /FG-621/.test(e.message) && e.message.includes(other),
    "a workspace borrowing from anywhere but the canonical project's own object store must be refused",
  );

  const notARepo = join(f.base, "host", "not-a-repo");
  mkdirSync(notARepo, { recursive: true });
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath, notARepo),
    /FG-621/,
    "a canonical project dir with no resolvable object store leaves nothing to verify against — refuse, never fall back",
  );
});

// ─── 5. Functional: does git actually work, and is the parent actually safe? ──

test("fg621 (negative control): with the parent objects NOT materialized, git in the clone fails", () => {
  const f = makeSharedCloneFixture();
  rmSync(f.parentRepo, { recursive: true, force: true });

  const log = git(f.clonePath, "log", "--oneline");
  assert.notEqual(
    log.code,
    0,
    "git log MUST fail when the borrowed object store is absent — this control is what makes every positive assertion below meaningful",
  );
});

test("fg621 (AC 2 + AC 11 support): with ONLY the objects dir mounted :ro, log and commit succeed and every parent write is refused", () => {
  const f = makeSharedCloneFixture();
  materializeNarrowObjectMount(f, { readOnly: true });

  // Reads resolve through the read-only borrowed store.
  const log = gitOk(f.clonePath, "log", "--oneline");
  assert.match(log, /commit 1/, `git log must carry real parent history, got: ${JSON.stringify(log)}`);
  assert.ok(gitOk(f.clonePath, "show", f.shaA).trim().length > 0, "git show of a parent commit must work");

  // The whole point of the substrate: the agent can commit, privately.
  writeFileSync(join(f.clonePath, "file.txt"), "agent edit\n");
  const commit = git(f.clonePath, "commit", "-am", "agent checkpoint");
  assert.equal(commit.code, 0, `git commit MUST succeed inside the private clone, got: ${commit.stderr}`);
  const tip = gitOk(f.clonePath, "rev-parse", "HEAD").trim();
  assert.notEqual(tip, f.shaB, "the commit must actually advance the private branch tip");
  assert.equal(gitOk(f.clonePath, "rev-parse", "--abbrev-ref", "HEAD").trim(), BRANCH, "on the deterministic private branch");
  // Writing its own refs is fine — that namespace is the clone's own.
  assert.equal(git(f.clonePath, "update-ref", "refs/heads/private-scratch", tip).code, 0, "the clone's OWN ref namespace stays writable");

  // AC 2, each attempted against the PARENT and each refused. The parent's ref
  // namespace is not read-only — it is ABSENT, so there is nothing to update.
  for (const [what, args] of [
    ["ref creation", ["update-ref", "refs/heads/fg621-should-not-exist", f.shaC]],
    ["main", ["update-ref", "refs/heads/main", f.shaA]],
    ["origin/*", ["update-ref", "refs/remotes/origin/main", f.shaA]],
    ["packed-ref rewrite", ["pack-refs", "--all"]],
  ] as Array<[string, string[]]>) {
    const r = git(f.base, "--git-dir", f.parentGitDir, ...args);
    assert.notEqual(r.code, 0, `parent ${what} MUST be refused`);
    assert.match(
      r.stderr,
      /not a git repository|permission denied|cannot|unable/i,
      `parent ${what} must be refused by the environment, not silently skipped — got: ${JSON.stringify(r.stderr)}`,
    );
  }
  for (const marker of ["HEAD", "refs", "packed-refs", "index", "config"]) {
    assert.equal(
      existsSync(join(f.parentGitDir, marker)),
      false,
      `the parent's ${marker} must not exist in the container view at all`,
    );
  }

  // Object-store deletion: refused by the read-only bind itself.
  const victims: string[] = [];
  for (const entry of readdirSync(f.parentObjects, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "info") continue;
    for (const name of readdirSync(join(f.parentObjects, entry.name))) {
      victims.push(join(f.parentObjects, entry.name, name));
    }
  }
  assert.ok(victims.length > 0, "the fixture's parent object store must hold real objects for the deletion attempt to be meaningful");
  assert.throws(
    () => rmSync(victims[0]!),
    (e: NodeJS.ErrnoException) => e.code === "EACCES" || e.code === "EPERM",
    "deleting from the parent object store MUST be refused — a writable objects/ is a deletable objects/",
  );
  assert.equal(existsSync(victims[0]!), true, "the parent object store must be intact after the attempt");

  // And the clone's own work is still retrievable by the host afterwards.
  assert.match(gitOk(f.clonePath, "log", "--oneline", "-1"), /agent checkpoint/, "the agent's commit survives on the private branch");
});

// ─── 6. Through the PRODUCTION dispatch path ─────────────────────────────────
//
// Every assertion above hands the planner a canonical project dir explicitly.
// That is exactly what let the identity proof go unrun in production for as long
// as it did: nothing on the dispatch path supplied one, so the comparison was
// skipped and only the shape checks — which an agent-controlled alternates file
// satisfies with any git repository on the host — actually ran. This section
// asserts the boundary through `runNext`, with no canonical dir passed by the
// test at all, so it can only pass if production dispatch supplies it itself.
//
// The tamper window is real, not synthetic: a dispatch that provisions a
// dependency cache starts the PROVISIONER container first and builds the agent
// container's argv only after it exits, so a workspace mutated in between is a
// workspace a later argv builder in the SAME dispatch reads.

const DISPATCH_RUNTIME = "fg621-mount-dispatch";

const MUTATING: Workflow = {
  name: "fg621-mount-dispatch",
  description: "FG-621 mount boundary through the real dispatch path",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: DISPATCH_RUNTIME, reds: [] },
  ],
};

function ensureDispatchRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${DISPATCH_RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${DISPATCH_RUNTIME}
description: FG-621 mount-boundary dispatch runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
env: {}
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
  - host: "\${PROJECT_DIR}"
    container: /project
    mode: "\${PROJECT_MODE:-rw}"
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
  remove_on_exit: true
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

/** A project repo carrying a package-lock.json, so the dispatch resolves a
 *  dependency plan and therefore runs a provisioner container BEFORE the agent
 *  container's argv is built. The lockfile marker is unique per call so the
 *  cache key is never already-ready from an earlier test in this process. */
function makeDispatchProject(marker: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg621-dispatch-")));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  identify(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg621-dispatch", version: "0.0.0", private: true }));
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ name: "fg621-dispatch", lockfileVersion: 3, marker, packages: {} }),
  );
  writeFileSync(join(dir, "README.md"), "# fg621 dispatch\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("fg621 (AC 2, production dispatch): a clone that repoints its alternates at ANOTHER repo is refused by the real dispatch path", async () => {
  const savedPlatform = process.platform;
  const savedEnv = {
    worktrees: process.env.FORGE_WORKTREES,
    dirty: process.env.FORGE_WORKTREE_IGNORE_DIRTY,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
  const db = makeInMemoryDb();
  const prevDb = setDbForTest(db);
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureDispatchRuntime();

  try {
    const project = makeDispatchProject("fg621-mount-boundary");
    // The foreign store: a full clone of the project, so it is a genuine git
    // object store that CONTAINS the workspace's base commit. Shape checks and
    // the base-commit containment proof both sanction it; only the derive-and-
    // compare against Forge's own record of the parent refuses it.
    const foreign = join(dirname(project), `${project.split("/").pop()}-foreign`);
    tmpDirs.push(foreign);
    execFileSync("git", ["clone", "--no-hardlinks", project, foreign], { stdio: "ignore" });
    const foreignObjects = realpathSync(join(foreign, ".git", "objects"));

    const { runId } = startRun({ workflow: MUTATING, title: "fg621 mount boundary", inputs: {}, projectDir: project });

    const seenArgv: string[][] = [];
    const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      seenArgv.push(args);
      mkdirSync(dirname(stdoutPath), { recursive: true });
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      // The provisioner is the first container of this dispatch. Standing in for
      // an agent that rewrote its own workspace, repoint the clone's alternates
      // at the foreign store before the AGENT container's argv is built.
      const clonePath = args.find((a) => a.includes(":/project:"))?.split(":")[0];
      if (clonePath) {
        const alternates = join(clonePath, ".git", "objects", "info", "alternates");
        if (existsSync(alternates)) writeFileSync(alternates, `${foreignObjects}\n`);
      }
      return 0;
    };

    const wave = await runNext({ runId, workflow: MUTATING, dockerExec: stubExec });

    // The load-bearing claim, asserted FIRST: no container this dispatch started
    // ever got the foreign directory bound at its own host path. Without the
    // mandatory derive-and-compare this is the assertion that fires — the agent
    // container's argv carries `-v <foreign>:<foreign>:ro`.
    for (const argv of seenArgv) {
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] !== "-v") continue;
        assert.notEqual(
          argv[i + 1]!.split(":")[0],
          foreignObjects,
          `a container was handed the foreign object store: ${argv[i + 1]}`,
        );
      }
    }
    assert.equal(seenArgv.length, 1, "only the provisioner ran — the agent container was never started");

    assert.deepEqual(wave.completedSteps, [], "the step must NOT complete — the dispatch is refused, not repaired");
    const task = tasksForRun(runId).find((t) => t.phase === "build")!;
    assert.equal(task.status, "failed", `task must fail; got ${task.status}`);
    assert.match(String(task.error), /FG-621/, `the failure must be the mount refusal, got: ${task.error}`);
    assert.ok(
      String(task.error).includes(foreignObjects),
      `the refusal must name the store it would have bound, got: ${task.error}`,
    );
    assert.ok(
      String(task.error).includes(project),
      `and the Forge-owned parent it was checked against, got: ${task.error}`,
    );
  } finally {
    setDbForTest(prevDb as never);
    db.close();
    Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
    for (const [k, v] of [
      ["FORGE_WORKTREES", savedEnv.worktrees],
      ["FORGE_WORKTREE_IGNORE_DIRTY", savedEnv.dirty],
      ["ANTHROPIC_API_KEY", savedEnv.apiKey],
    ] as Array<[string, string | undefined]>) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ─── 7. What the CANONICAL project dir may itself be ─────────────────────────
//
// The identity proof stays MANDATORY. What round 1 got wrong is how the expected
// parent object store is DERIVED from Forge's canonical dir: `<dir>/.git/objects`
// is only the shape of an ORDINARY CHECKOUT. When a run's projectDir is itself a
// linked worktree that path does not exist at all, so the derivation returned
// nothing and the mandatory check hard-refused EVERY mutating dispatch in that
// configuration — a fail-closed regression, but a total one.
//
// Derivation now goes through git, and the expected value is the SET of object
// stores the canonical dir itself reaches. That is also what makes a project dir
// that BORROWS (`clone --shared` / `--reference`) dispatchable, and it is why the
// mount plan must follow the whole chain: mounting one hop of a borrowing parent
// leaves the container's object graph incomplete, which is the FG-559
// history-blind failure wearing a different substrate.

/** A parent repo plus a LINKED WORKTREE of it, and a `--shared` clone of that
 *  worktree — the substrate a mutating dispatch provisions when the operator runs
 *  forge from a worktree of their project. */
function makeWorktreeCanonicalFixture(): {
  base: string;
  parentRepo: string;
  /** The run's projectDir: a linked worktree, whose `.git` is a POINTER FILE. */
  worktreePath: string;
  /** The one real object store — it lives in the COMMON git dir, not the worktree. */
  commonObjects: string;
  clonePath: string;
  baseSha: string;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg621-wtcanon-")));
  tmpDirs.push(base);

  const parentRepo = join(base, "parent");
  mkdirSync(parentRepo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: parentRepo, stdio: "ignore" });
  identify(parentRepo);
  writeFileSync(join(parentRepo, "file.txt"), "revision 1\n");
  gitOk(parentRepo, "add", ".");
  gitOk(parentRepo, "commit", "-m", "commit 1");

  const worktreePath = join(base, "wt");
  gitOk(parentRepo, "worktree", "add", "-b", "fg621-wt", worktreePath);
  assert.equal(
    statSync(join(worktreePath, ".git")).isFile(),
    true,
    "fixture must be a LINKED WORKTREE — <wt>/.git must be a gitdir: POINTER FILE, which is exactly the shape <dir>/.git/objects cannot describe",
  );

  const clonePath = join(base, "clone");
  execFileSync("git", ["clone", "--shared", worktreePath, clonePath], { stdio: "ignore" });
  identify(clonePath);
  const baseSha = gitOk(clonePath, "rev-parse", "HEAD").trim();
  gitOk(clonePath, "checkout", "-b", BRANCH, baseSha);

  const commonObjects = realpathSync(join(parentRepo, ".git", "objects"));
  assert.equal(
    readFileSync(join(clonePath, ".git", "objects", "info", "alternates"), "utf8").trim(),
    commonObjects,
    "fixture: cloning a worktree borrows the COMMON object store — the very path the old derivation could not name",
  );

  return { base, parentRepo, worktreePath, commonObjects, clonePath, baseSha };
}

test("fg621 (regression): a linked-worktree projectDir derives its object store THROUGH GIT — the identity check verifies, it does not hard-refuse", () => {
  const f = makeWorktreeCanonicalFixture();

  assert.equal(
    existsSync(join(f.worktreePath, ".git", "objects")),
    false,
    "fixture: the layout the old derivation assumed does not exist here at all",
  );
  assert.deepEqual(
    planWorktreeGitMounts(f.clonePath, f.worktreePath),
    [f.commonObjects],
    "a linked-worktree canonical dir resolves to the same real object store its clone borrows",
  );
  assert.ok(
    mountSpecs(buildDockerArgs(RUNTIME, ctxFor(f.clonePath, "rw", f.worktreePath)).args).includes(
      `${f.commonObjects}:${f.commonObjects}:ro`,
    ),
    "and the argv carries the read-only object bind",
  );

  // Still mandatory, and still fail-closed. Resolving the parent through git is a
  // better derivation, not a weaker proof.
  const stranger = join(f.base, "stranger");
  mkdirSync(stranger, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: stranger, stdio: "ignore" });
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath, stranger),
    /FG-621/,
    "a workspace borrowing from outside the canonical project's own reach is still refused",
  );
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath),
    /FG-621/,
    "and no canonical dir at all is still a refusal, never a skip",
  );
});

test("fg621 (regression, production dispatch): a mutating task dispatches from a linked-worktree projectDir", async () => {
  const savedPlatform = process.platform;
  const savedEnv = {
    worktrees: process.env.FORGE_WORKTREES,
    dirty: process.env.FORGE_WORKTREE_IGNORE_DIRTY,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
  const db = makeInMemoryDb();
  const prevDb = setDbForTest(db);
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureDispatchRuntime();

  try {
    // The whole configuration, end to end: the operator's project dir IS a linked
    // worktree, and the dispatch provisions a private clone of it. Before this
    // fix the mandatory identity check could not derive an object store from that
    // projectDir at all, so every mutating dispatch here died on the host with an
    // FG-621 refusal — a total outage of the substrate in this configuration.
    const project = makeDispatchProject("fg621-worktree-canonical");
    const worktreePath = join(dirname(project), `${project.split("/").pop()}-wt`);
    tmpDirs.push(worktreePath);
    execFileSync("git", ["worktree", "add", "-b", "fg621-dispatch-wt", worktreePath], { cwd: project, stdio: "ignore" });
    const commonObjects = realpathSync(join(project, ".git", "objects"));

    const { runId } = startRun({ workflow: MUTATING, title: "fg621 worktree canonical", inputs: {}, projectDir: worktreePath });

    const seenArgv: string[][] = [];
    const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      seenArgv.push(args);
      mkdirSync(dirname(stdoutPath), { recursive: true });
      writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify({ status: "complete" }));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    await runNext({ runId, workflow: MUTATING, dockerExec: stubExec });

    const task = tasksForRun(runId).find((t) => t.phase === "build")!;
    assert.doesNotMatch(
      String(task.error ?? ""),
      /FG-621/,
      `the dispatch must not be refused by the mount planner, got: ${task.error}`,
    );
    assert.ok(seenArgv.length > 0, "a container must actually have been started");
    assert.ok(
      seenArgv.every((argv) => mountSpecs(argv).includes(`${commonObjects}:${commonObjects}:ro`)),
      `every container of the dispatch must carry the common object store read-only, got: ${seenArgv.map((a) => mountSpecs(a).join(" ")).join(" | ")}`,
    );
    for (const argv of seenArgv) {
      for (const spec of mountSpecs(argv)) {
        assert.notEqual(
          spec.split(":")[0],
          join(project, ".git"),
          `the parent .git is still never bound, only its object store: ${spec}`,
        );
      }
    }
  } finally {
    setDbForTest(prevDb as never);
    db.close();
    Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
    for (const [k, v] of [
      ["FORGE_WORKTREES", savedEnv.worktrees],
      ["FORGE_WORKTREE_IGNORE_DIRTY", savedEnv.dirty],
      ["ANTHROPIC_API_KEY", savedEnv.apiKey],
    ] as Array<[string, string | undefined]>) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ─── 8. A borrowing project dir: `forge invoke`, and the whole alternates chain ─

/** grandparent ← `--shared` parent ← `--shared` clone. The parent is the shape an
 *  operator gets from `git clone --shared` / `--reference`; the clone is the
 *  workspace forge provisions from it. */
function makeChainFixture(): {
  base: string;
  grandparentObjects: string;
  parentRepo: string;
  parentObjects: string;
  clonePath: string;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg621-chain-")));
  tmpDirs.push(base);

  const grandparent = join(base, "grandparent");
  mkdirSync(grandparent, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: grandparent, stdio: "ignore" });
  identify(grandparent);
  writeFileSync(join(grandparent, "file.txt"), "revision 1\n");
  gitOk(grandparent, "add", ".");
  gitOk(grandparent, "commit", "-m", "commit 1");

  const parentRepo = join(base, "parent");
  execFileSync("git", ["clone", "--shared", grandparent, parentRepo], { stdio: "ignore" });
  identify(parentRepo);
  const clonePath = join(base, "clone");
  execFileSync("git", ["clone", "--shared", parentRepo, clonePath], { stdio: "ignore" });
  identify(clonePath);
  gitOk(clonePath, "checkout", "-b", BRANCH);

  return {
    base,
    grandparentObjects: realpathSync(join(grandparent, ".git", "objects")),
    parentRepo,
    parentObjects: realpathSync(join(parentRepo, ".git", "objects")),
    clonePath,
  };
}

test("fg621: the plan follows the WHOLE alternates chain — one hop of a borrowing parent is an incomplete object graph", () => {
  const f = makeChainFixture();

  assert.deepEqual(
    planWorktreeGitMounts(f.clonePath, f.parentRepo),
    [f.parentObjects, f.grandparentObjects],
    "the parent borrows too, so the container needs both stores — mounting only the first is FG-559's history-blind container in a new place",
  );
  assert.ok(
    mountSpecs(buildDockerArgs(RUNTIME, ctxFor(f.clonePath, "rw", f.parentRepo)).args).includes(
      `${f.grandparentObjects}:${f.grandparentObjects}:ro`,
    ),
    "and the far hop reaches the argv as a read-only identity bind like the near one",
  );

  // Negative control: with the far hop absent, git in the clone genuinely cannot
  // read the history — which is what makes the extra mount load-bearing rather
  // than decorative.
  rmSync(join(f.base, "grandparent"), { recursive: true, force: true });
  assert.notEqual(
    git(f.clonePath, "log", "--oneline").code,
    0,
    "git log MUST fail without the far hop — otherwise the chain assertion above proves nothing",
  );
});

test("fg621 (fails closed): a chain forge cannot bind is REFUSED, never silently truncated", () => {
  const f = makeChainFixture();
  const parentAlternates = join(f.parentRepo, ".git", "objects", "info", "alternates");

  // Every hop past the first is resolved by git INSIDE the container, against a
  // bind mount rather than this host's symlinks, so a relative entry can name a
  // different directory there than here. Truncating the chain to what forge can
  // bind would ship the incomplete graph this whole section exists to prevent.
  writeFileSync(parentAlternates, "../../../grandparent/.git/objects\n");
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath, f.parentRepo),
    (e: Error) => /FG-621/.test(e.message) && /RELATIVE/.test(e.message),
    "a relative deeper hop must refuse",
  );

  // A cycle is the other way a chain fails to terminate. Closed at the FAR end so
  // every other proof still passes: the objects are all really reachable, and the
  // only thing wrong is that the walk never ends.
  writeFileSync(parentAlternates, `${f.grandparentObjects}\n`);
  writeFileSync(join(f.grandparentObjects, "info", "alternates"), `${f.parentObjects}\n`);
  assert.throws(
    () => planWorktreeGitMounts(f.clonePath, f.parentRepo),
    (e: Error) => /FG-621/.test(e.message) && /CYCLE/i.test(e.message),
    "a cycle of alternate object stores must refuse",
  );
});

test("fg621 (regression): `forge invoke` on a project dir that itself BORROWS is dispatched, not hard-refused", async () => {
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const db = makeInMemoryDb();
  const prevDb = setDbForTest(db);
  setupInvokeProjectRuntime();

  try {
    const f = makeChainFixture();
    // `forge invoke` creates no workspace, so PROJECT_DIR is the canonical dir.
    // It is the third path into the mount planner and the only one that supplied
    // no canonical dir at all — fail-closed, but it turned every `--shared` /
    // `--reference` project dir into a hard invoke failure.
    assert.deepEqual(
      planWorktreeGitMounts(f.parentRepo, f.parentRepo),
      [f.grandparentObjects],
      "the store a borrowing project dir reaches is one it legitimately reaches",
    );

    let seen: string[] = [];
    const capturingExec: InvokeDockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      seen = args;
      mkdirSync(dirname(stdoutPath), { recursive: true });
      writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify({ status: "complete" }));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const r = await invoke({
      agentRole: "engineer",
      task: "do thing",
      projectDir: f.parentRepo,
      dockerExec: capturingExec,
    });

    assert.equal(r.status, "complete", `invoke on a borrowing project dir must not be refused, got: ${r.error}`);
    assert.ok(
      mountSpecs(seen).includes(`${f.grandparentObjects}:${f.grandparentObjects}:ro`),
      `the argv handed to docker must carry the borrowed object store read-only, got: ${mountSpecs(seen).join(" ")}`,
    );

    // And the refusal is NOT weakened on this path: a project dir whose alternates
    // name something it does not reach is still refused, on invoke as everywhere.
    const foreign = join(f.base, "foreign");
    mkdirSync(foreign, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: foreign, stdio: "ignore" });
    identify(foreign);
    writeFileSync(join(foreign, "x.txt"), "other history\n");
    gitOk(foreign, "add", ".");
    gitOk(foreign, "commit", "-m", "other");
    writeFileSync(
      join(f.parentRepo, ".git", "objects", "info", "alternates"),
      `${realpathSync(join(foreign, ".git", "objects"))}\n`,
    );
    const refused = await invoke({
      agentRole: "engineer",
      task: "do thing",
      projectDir: f.parentRepo,
      dockerExec: capturingExec,
    });
    assert.equal(refused.status, "failed", "a project dir borrowing from a store it does not reach is still refused");
    assert.match(refused.error ?? "", /FG-621/, `the refusal must reach the caller, got: ${refused.error}`);
  } finally {
    setDbForTest(prevDb as never);
    db.close();
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
  }
});

/** `forge invoke` resolves the `claude` runtime by name. It MUST mount the
 *  project — without a `${PROJECT_DIR}` mount buildDockerArgs skips the whole git
 *  block and the assertions above pass vacuously. */
function setupInvokeProjectRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: claude
description: fg621 invoke stub
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
`,
  );
  publishFlatAsGeneration(fhome);
}
