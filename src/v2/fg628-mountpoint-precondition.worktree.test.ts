// FG-628 Half A: the mountpoint precondition belongs to the tree that gets MOUNTED.
//
// Every dependency volume binds at a path INSIDE a read-only project mount, and
// docker cannot mkdir a mountpoint on a read-only rootfs — so a tree missing
// `<member>/node_modules` kills the reviewer/red container before it starts:
//
//   error mounting ".../forge-deps-<hash>-<member>/_data" to rootfs at
//   "/project/<member>/node_modules": create mountpoint ...: read-only file system
//
// FG-627 created those mountpoints at isolated-workspace creation, which covers
// the linked worktree and the private clone and misses every other tree that can
// reach the same mount. Two of those are exercised here:
//
//   (1) an FG-425 PUBLICATION CANDIDATE (`createCandidateWorktree`) — the tree the
//       reds actually review in worktree mode, and the one the live dogfood died
//       on. Its checkout is fresh and `node_modules/` is gitignored, so it can
//       never carry a member mountpoint of its own.
//   (2) a plain non-isolated `--project <dir>` dispatch against an operator's live
//       checkout that ran a ROOT-ONLY install.
//
// Both reproduce from the same root cause: readiness is a property of the LOCKFILE
// (`~/.forge/dependency-cache/<hash>.ready` — host-global and ABI-free by design,
// so it legitimately spans checkouts) while MOUNTABILITY is a property of the
// specific checkout. The ready marker was authorizing a mount into a tree that had
// never been prepared for one. Both tests therefore mark the cache ready by hand:
// that is not a shortcut, it is the precondition that makes the bug reachable.
//
// What these tests assert is that the mountpoint exists in the mounted tree AT THE
// MOMENT the container is built, together with the non-vacuity check that the
// member volume is genuinely in that container's argv. What they deliberately do
// NOT assert — because assuming it is the whole defect — is that the mount then
// succeeds; that needs a real docker daemon.
//
// Tier: worktree (`npm run test:worktree`) — real git repos, real worktree-mode
// dispatch, real publication candidates.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { lockfileHash, markDependencyCacheReady, dependencyVolumeName } from "./dependency-provisioning.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const MEMBER = "dashboard";

// A specialist, non-blocking red — the exact class the live crash hit, and it must
// not interfere with the publication this test needs to reach.
const WORKFLOW: Workflow = {
  name: "fg628-mount-test",
  description: "FG-628: the mountpoint precondition follows the mounted tree",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg628-mount-test",
      reds: [{ agent: "red-narrow", authority: "specialist", gate_on_verdict: false }],
    },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "FORGE_NO_NM_SHADOW",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  ensureWorkflowYaml();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  setPlatform(process.platform);
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg628-"));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const AGENT_IDENTITY = ["-c", "user.name=Agent", "-c", "user.email=agent@forge.test"];

/** A checkout shaped exactly like the projects that hit this: a root lockfile, a
 *  declared workspace member, `node_modules/` gitignored, and a ROOT-ONLY install
 *  — the root member's directory is present and populated, the workspace member's
 *  is absent. That asymmetry is why the primary survived and only the reds died. */
function makeRootOnlyInstallRepo(): string {
  const dir = makeTmpDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  mkdirSync(join(dir, MEMBER), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg628", private: true, workspaces: [MEMBER] }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, MEMBER, "package.json"),
    JSON.stringify({ name: "@fg628/dashboard", version: "1.0.0" }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ name: "fg628", lockfileVersion: 3, packages: {} }, null, 2) + "\n",
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  // The root-only install: root node_modules populated, member's never created.
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}\n");
  assert.equal(existsSync(join(dir, MEMBER, "node_modules")), false, "fixture must start WITHOUT the member mountpoint");
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg628-mount-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg628-mount-test
description: FG-628 mountpoint precondition test runtime stub
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

function ensureWorkflowYaml(): void {
  const wfPath = join(process.env.FORGE_HOME!, "workflows", "fg628-mount-test.yml");
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg628-mount-test
description: "FG-628: the mountpoint precondition follows the mounted tree"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: fg628-mount-test
    reds:
      - agent: red-narrow
        authority: specialist
        gate_on_verdict: false
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

type Mount = { host: string; container: string; mode: string };

function mounts(args: string[]): Mount[] {
  const out: Mount[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-v" || typeof args[i + 1] !== "string") continue;
    const parts = args[i + 1]!.split(":");
    if (parts.length < 2) continue;
    out.push({ host: parts[0]!, container: parts[1]!, mode: parts[2] ?? "" });
  }
  return out;
}

function projectMount(args: string[]): Mount | undefined {
  return mounts(args).find((m) => m.container === "/project");
}

function extractTaskId(args: string[]): string {
  const i = args.indexOf("--name");
  return i >= 0 ? (args[i + 1] ?? "").replace(/^forge-/, "") : "";
}

function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

const PASS_VERDICT = { status: "complete", tests_run: 1, verdict: "pass", confidence: 1, findings: [] };

/** What the reviewer's container argv said about the tree it was about to mount,
 *  captured at build time — the only moment at which the precondition can hold. */
type RedObservation = {
  projectMountHost: string;
  projectMountMode: string;
  memberVolumeMounted: boolean;
  memberVolumeMode: string;
  memberMountpointExists: boolean;
  rootMountpointExists: boolean;
};

// ─── (1) the publication candidate — the site that actually fires ─────────────

test("FG-628 (A1): the reds' PUBLICATION CANDIDATE carries a mountpoint for every dependency volume it will mount", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeRootOnlyInstallRepo();
  // The asymmetry the ticket names: the ready marker is keyed on the LOCKFILE and
  // is host-global, so it is already satisfied for a checkout that has never been
  // prepared for a mount. This is what authorizes the mount that then crashes.
  const hash = lockfileHash(repo);
  markDependencyCacheReady(hash);
  const memberVolume = dependencyVolumeName(hash, MEMBER);

  let red: RedObservation | undefined;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("provision-")) return 0; // the short-lived provisioner
    const mount = projectMount(args)!;
    if (taskId.startsWith("task-red-")) {
      const member = mounts(args).find((m) => m.container === `/project/${MEMBER}/node_modules`);
      red = {
        projectMountHost: mount.host,
        projectMountMode: mount.mode,
        memberVolumeMounted: member !== undefined,
        memberVolumeMode: member?.mode ?? "",
        memberMountpointExists: statSync(join(mount.host, MEMBER, "node_modules"), { throwIfNoEntry: false })?.isDirectory() === true,
        rootMountpointExists: statSync(join(mount.host, "node_modules"), { throwIfNoEntry: false })?.isDirectory() === true,
      };
      writeTaskResult(stdoutPath, PASS_VERDICT);
      return 0;
    }
    writeFileSync(join(mount.host, "work.ts"), "export const x = 1;\n");
    git(mount.host, ["add", "."]);
    git(mount.host, [...AGENT_IDENTITY, "commit", "-m", "primary output"]);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["work.ts"] });
    return 0;
  };

  const { runId } = startRun({ workflow: WORKFLOW, title: "fg628 A1", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec });

  assert.ok(red !== undefined, "the red must have been dispatched");
  // The tree under review really is a publication candidate, not the checkout and
  // not a linked task worktree — the distinction the ticket's dogfood 4 turned on.
  assert.ok(
    red!.projectMountHost.includes(join("worktrees", "publications")),
    `the red must review a publication candidate; mounted ${red!.projectMountHost}`,
  );
  assert.notEqual(red!.projectMountHost, repo, "the candidate is not the operator's checkout");

  // Non-vacuity: a volume really is being bound INSIDE the read-only project mount.
  // Without this the mountpoint assertion below could pass against a dispatch that
  // mounts nothing at all.
  assert.ok(
    red!.memberVolumeMounted,
    `the red's argv must mount ${memberVolume} at /project/${MEMBER}/node_modules — otherwise this test proves nothing`,
  );

  // AC 3: the project mount and every dependency volume stay read-only. The fix
  // must never buy mountability by relaxing either.
  assert.equal(red!.projectMountMode, "ro", "the reviewer's project mount must stay read-only");
  assert.equal(red!.memberVolumeMode, "ro", "the planned member volume must stay read-only");

  // ── THE ASSERTION THIS TEST EXISTS FOR ──────────────────────────────────────
  assert.equal(
    red!.memberMountpointExists,
    true,
    `the candidate must already contain ${MEMBER}/node_modules when the container is built — ` +
      "docker cannot mkdir a mountpoint on a read-only rootfs, so a missing one is the container_crash this ticket closes",
  );
  assert.equal(red!.rootMountpointExists, true, "the root member's mountpoint must exist too");

  const primary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
  assert.equal(primary!.status, "complete", "the run must still reach its normal outcome");
});

// ─── (2) the non-isolated `--project <dir>` dispatch, in a LIVE checkout ──────

test("FG-628 (A2): a non-isolated red dispatch prepares the operator's own checkout — and leaves it clean", async () => {
  setPlatform("darwin");
  process.env.FORGE_NO_WORKTREES = "1";

  const repo = makeRootOnlyInstallRepo();
  const hash = lockfileHash(repo);
  markDependencyCacheReady(hash);

  // AC 4: what git could see BEFORE the dispatch. The comparison is against this,
  // not against "", because the root-only install is itself ignored content that
  // was already there.
  const ignoredBefore = git(repo, ["status", "--porcelain", "--ignored"]);
  const trackedBefore = git(repo, ["status", "--porcelain"]);

  let red: RedObservation | undefined;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("provision-")) return 0;
    const mount = projectMount(args)!;
    if (taskId.startsWith("task-red-")) {
      const member = mounts(args).find((m) => m.container === `/project/${MEMBER}/node_modules`);
      red = {
        projectMountHost: mount.host,
        projectMountMode: mount.mode,
        memberVolumeMounted: member !== undefined,
        memberVolumeMode: member?.mode ?? "",
        memberMountpointExists: statSync(join(mount.host, MEMBER, "node_modules"), { throwIfNoEntry: false })?.isDirectory() === true,
        rootMountpointExists: statSync(join(mount.host, "node_modules"), { throwIfNoEntry: false })?.isDirectory() === true,
      };
      writeTaskResult(stdoutPath, PASS_VERDICT);
      return 0;
    }
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [] });
    return 0;
  };

  const { runId } = startRun({ workflow: WORKFLOW, title: "fg628 A2", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec });

  assert.ok(red !== undefined, "the red must have been dispatched");
  assert.equal(red!.projectMountHost, repo, "a non-isolated red mounts the operator's checkout itself");
  assert.ok(red!.memberVolumeMounted, "non-vacuity: the member volume must be in the red's argv");
  assert.equal(red!.projectMountMode, "ro", "the reviewer's project mount must stay read-only");
  assert.equal(red!.memberMountpointExists, true, `${MEMBER}/node_modules must exist in the checkout at container-build time`);

  // AC 4: an EMPTY directory under an already-gitignored path is invisible to git.
  // Capture, the reaper's `--ignored` probe, and `ls-files --others` must all read
  // exactly as they did before the dispatch — otherwise this fix would retain every
  // workspace forever and dirty every operator's tree.
  assert.equal(existsSync(join(repo, MEMBER, "node_modules")), true, "the mountpoint persists in the live checkout");
  assert.equal(git(repo, ["status", "--porcelain"]), trackedBefore, "tracked status must be unchanged");
  assert.equal(
    git(repo, ["status", "--porcelain", "--ignored"]),
    ignoredBefore,
    "the reaper's own probe (`status --porcelain --ignored`) must not see the new mountpoint",
  );
  assert.equal(git(repo, ["ls-files", "--others", "--exclude-standard"]), "", "the mountpoint must not surface as untracked");
});

// ─── (3) idempotent under concurrency, and a no-lockfile project is untouched ──

test("FG-628 (A3): two concurrent dispatches into the SAME non-isolated checkout both succeed", async () => {
  setPlatform("darwin");
  process.env.FORGE_NO_WORKTREES = "1";

  // There is no host-side mutual exclusion on a non-isolated project dir — the only
  // dispatch lock is per-run, and a fanout wave dispatches its children in parallel.
  // Two runs against one checkout is the shape that has to be a no-op, not a
  // conflict.
  const repo = makeRootOnlyInstallRepo();
  markDependencyCacheReady(lockfileHash(repo));

  const seen: boolean[] = [];
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("provision-")) return 0;
    const mount = projectMount(args)!;
    if (taskId.startsWith("task-red-")) {
      seen.push(existsSync(join(mount.host, MEMBER, "node_modules")));
      writeTaskResult(stdoutPath, PASS_VERDICT);
      return 0;
    }
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [] });
    return 0;
  };

  const a = startRun({ workflow: WORKFLOW, title: "fg628 A3a", inputs: {}, projectDir: repo });
  const b = startRun({ workflow: WORKFLOW, title: "fg628 A3b", inputs: {}, projectDir: repo });
  await Promise.all([
    runNext({ runId: a.runId, workflow: WORKFLOW, dockerExec: stubExec }),
    runNext({ runId: b.runId, workflow: WORKFLOW, dockerExec: stubExec }),
  ]);

  assert.equal(seen.length, 2, "both runs' reds must have dispatched");
  assert.deepEqual(seen, [true, true], "concurrent creation of the same mountpoint must be a no-op, not a failure");
});
