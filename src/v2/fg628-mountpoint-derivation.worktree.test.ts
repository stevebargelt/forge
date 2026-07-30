// FG-628 followup coverage: the NO-DRIFT property, and non-destructiveness over an
// already-populated member directory.
//
// AC 2 mandates ONE mechanism — "Reuse `createDependencyMountpoints` rather than
// adding a second mechanism — it already derives its set from
// `planDependencyVolumes` so it cannot drift from what `spawn.ts` mounts." That is a
// STRUCTURAL claim, and a test that hardcoded an expected member list would defeat
// it: such a test passes just as happily against a second, hand-maintained list that
// happens to agree today and silently diverges on the next workspace member added.
// Every assertion here therefore derives BOTH sides from `planDependencyVolumes` and
// compares them, and the fixture carries a workspace member with a name no hardcoded
// list could plausibly contain.
//
// The second half covers idempotency over ALREADY-POPULATED state. The
// implementation's comment claims creation is "idempotent under concurrency" because
// there is no host-side mutual exclusion on a shared project dir (the only dispatch
// lock is per-run, and a fanout wave dispatches children in parallel). The existing
// A3 test proves two concurrent dispatches both succeed against an EMPTY member dir.
// The dangerous case is the other one: an operator's live checkout where
// `node_modules` is populated with a real install. Creation racing itself there must
// never clobber, empty, or replace it — that is the difference between a harmless
// `mkdir -p` and an operator losing their install to a dispatch.
//
// Platform note: the dependency-cache mechanism is gated on
// `process.platform === "darwin"` (spawn.ts). On Linux these volumes are never
// mounted at all, so every dispatch test here forces the platform the way the
// FG-376/FG-425/FG-628 tests do. A green Linux run without that forcing would be
// coverage of nothing.
//
// Tier: worktree — real git repos, real worktree-mode dispatch, real publication
// candidates.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import {
  createDependencyMountpoints,
  planDependencyVolumes,
  lockfileHash,
  markDependencyCacheReady,
} from "./dependency-provisioning.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// Two members, deliberately: one ordinary, and one whose name exists nowhere in the
// product. Nothing hardcoded could know about the second — if the mountpoint set
// were maintained as its own list rather than derived, the second member is the one
// that would be missing.
const MEMBER = "dashboard";
const INVENTED_MEMBER = "packages/fg628-derived-member";
const PROJECT_CONTAINER_PATH = "/project";

const WORKFLOW: Workflow = {
  name: "fg628-derivation-test",
  description: "FG-628: the mountpoint set is derived from planDependencyVolumes",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg628-derivation-test",
      reds: [{ agent: "red-narrow", authority: "specialist", gate_on_verdict: false }],
    },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

// Captured before any test forces a platform; restoring `process.platform` in
// afterEach would just re-set whatever the last test left behind.
const REAL_PLATFORM = process.platform;

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
  setPlatform(REAL_PLATFORM);
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg628-deriv-"));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const AGENT_IDENTITY = ["-c", "user.name=Agent", "-c", "user.email=agent@forge.test"];

/** A checkout declaring TWO workspace members plus the implicit root — enough that
 *  "the set is derived" and "the set is a two-entry list someone wrote down" are
 *  distinguishable outcomes. `members` is a parameter so a test can grow the
 *  workspace and watch both sides move together. */
function makeRepo(members: string[] = [MEMBER, INVENTED_MEMBER]): string {
  const dir = makeTmpDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeWorkspaces(dir, members);
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ name: "fg628-deriv", lockfileVersion: 3, packages: {} }, null, 2) + "\n",
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

function writeWorkspaces(dir: string, members: string[]): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg628-deriv", private: true, workspaces: members }, null, 2) + "\n",
  );
  for (const m of members) {
    mkdirSync(join(dir, m), { recursive: true });
    writeFileSync(
      join(dir, m, "package.json"),
      JSON.stringify({ name: `@fg628/${m.replace(/\//g, "-")}`, version: "1.0.0" }, null, 2) + "\n",
    );
  }
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg628-derivation-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg628-derivation-test
description: FG-628 mountpoint-derivation test runtime stub
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
    container: ${PROJECT_CONTAINER_PATH}
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
  const wfPath = join(process.env.FORGE_HOME!, "workflows", "fg628-derivation-test.yml");
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg628-derivation-test
description: "FG-628: the mountpoint set is derived from planDependencyVolumes"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: fg628-derivation-test
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
  return mounts(args).find((m) => m.container === PROJECT_CONTAINER_PATH);
}

/** Every dependency-volume mount in an argv: a NAMED volume (no leading `/`, so it
 *  cannot be a bind) bound somewhere under the project mount. Collected by SHAPE, not
 *  by expected name — an expected-name filter would smuggle the hardcoded list this
 *  file exists to avoid back in through the collector. */
function dependencyVolumeMounts(args: string[]): Mount[] {
  return mounts(args).filter(
    (m) => !m.host.startsWith("/") && m.container.startsWith(`${PROJECT_CONTAINER_PATH}/`),
  );
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

/** Rebase a plan's CONTAINER path onto the host tree that will be bound there. This
 *  is the only translation the assertions do — the sets themselves both come from
 *  the plan. */
function hostPathForContainerPath(mountHost: string, containerPath: string): string {
  const rel = relative(PROJECT_CONTAINER_PATH, containerPath).split("/").join(sep);
  return join(mountHost, rel);
}

/** Recursive content snapshot: relative path → file bytes (directories appear as
 *  their entries). Used to prove nothing under an existing node_modules was touched. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        out[`${rel}/`] = "<dir>";
        walk(abs);
      } else {
        out[rel] = readFileSync(abs, "utf8");
      }
    }
  };
  walk(root);
  return out;
}

// ─── (D1) the mechanism itself: created set ≡ planDependencyVolumes ───────────

test("FG-628 (D1): createDependencyMountpoints derives its set from planDependencyVolumes — add a workspace member and BOTH sides move together", async () => {
  // The structural claim in AC 2, tested at the mechanism rather than through a
  // dispatch: there is no second list. A hand-maintained list would agree with the
  // plan for the members it was written against and lose the one added below.
  const repo = makeRepo([MEMBER]);

  const before = createDependencyMountpoints(repo);
  assert.deepEqual(
    [...before].sort(),
    planDependencyVolumes(repo, repo).volumes.map((v) => v.containerPath).sort(),
    "the created set must BE the plan's set — not a list that happens to match it",
  );

  // Grow the workspace with a member no hardcoded list could anticipate.
  writeWorkspaces(repo, [MEMBER, INVENTED_MEMBER]);

  const after = createDependencyMountpoints(repo);
  const planAfter = planDependencyVolumes(repo, repo).volumes.map((v) => v.containerPath);
  assert.deepEqual(
    [...after].sort(),
    [...planAfter].sort(),
    "after adding a member the created set must STILL be exactly the plan's set",
  );
  assert.equal(after.length, before.length + 1, "the new member must have produced exactly one new mountpoint");
  assert.ok(
    after.some((p) => p === join(repo, INVENTED_MEMBER, "node_modules")),
    `the invented member ${INVENTED_MEMBER} must be covered without anyone naming it — that is the no-drift property`,
  );
  for (const path of after) {
    assert.equal(statSync(path, { throwIfNoEntry: false })?.isDirectory(), true, `${path} must exist as a directory`);
  }
});

// ─── (D2) at dispatch: what is CREATED ≡ what spawn.ts MOUNTS ────────────────

test("FG-628 (D2): at dispatch the mountpoints created in the mounted tree are exactly the volumes spawn.ts binds — derived on both sides, nothing hardcoded", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeRepo();
  markDependencyCacheReady(lockfileHash(repo));

  let redArgs: string[] | undefined;
  let mountHost: string | undefined;
  // Both the plan and the mountpoint probe are taken INSIDE the exec. The precondition
  // only means anything at the moment the container is built — reading it afterwards
  // would not distinguish "created before the mount" from "created after it would
  // already have crashed" — and the publication candidate is a disposable worktree
  // that is gone by the time the wave returns, so there is nothing left to plan from.
  let planAtBuildTime: { name: string; containerPath: string }[] | undefined;
  let existedAtBuildTime: Record<string, boolean> | undefined;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("provision-")) return 0;
    const mount = projectMount(args)!;
    if (taskId.startsWith("task-red-")) {
      redArgs = args;
      mountHost = mount.host;
      // The plan for the tree that is ACTUALLY bound at the container's project
      // path. Every comparison below has this one call on both of its sides.
      const plan = planDependencyVolumes(mount.host, PROJECT_CONTAINER_PATH);
      planAtBuildTime = plan.volumes.map((v) => ({ name: v.name, containerPath: v.containerPath }));
      existedAtBuildTime = {};
      for (const v of plan.volumes) {
        existedAtBuildTime[v.containerPath] =
          statSync(hostPathForContainerPath(mount.host, v.containerPath), { throwIfNoEntry: false })?.isDirectory() === true;
      }
      writeTaskResult(stdoutPath, PASS_VERDICT);
      return 0;
    }
    writeFileSync(join(mount.host, "work.ts"), "export const x = 1;\n");
    git(mount.host, ["add", "."]);
    git(mount.host, [...AGENT_IDENTITY, "commit", "-m", "primary output"]);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["work.ts"] });
    return 0;
  };

  const { runId } = startRun({ workflow: WORKFLOW, title: "fg628 D2", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec });

  assert.ok(redArgs !== undefined && mountHost !== undefined, "the red must have been dispatched");
  assert.ok(
    mountHost!.includes(join("worktrees", "publications")),
    `the tree under test must be the publication candidate — the site FG-628's dogfood 4 died on; mounted ${mountHost}`,
  );

  const planVolumes = planAtBuildTime!;
  assert.ok(planVolumes.length >= 3, `non-vacuity: root + ${MEMBER} + ${INVENTED_MEMBER}; got ${planVolumes.length}`);

  // (a) what spawn.ts binds ≡ the plan. If spawn's own derivation ever diverged from
  // planDependencyVolumes, the mountpoint precondition would be established against
  // the wrong set and the crash would come back.
  const mounted = dependencyVolumeMounts(redArgs!);
  assert.deepEqual(
    mounted.map((m) => `${m.host}@${m.container}`).sort(),
    planVolumes.map((v) => `${v.name}@${v.containerPath}`).sort(),
    "spawn.ts must bind exactly the plan's volumes at exactly the plan's container paths",
  );
  for (const m of mounted) {
    assert.equal(m.mode, "ro", `${m.host} must stay read-only (AC 3) — mountability is never bought by relaxing the mount`);
  }

  // (b) what was CREATED ≡ the plan, at container-build time. Together with (a) this
  // is the no-drift property: one plan, both sides, no list to fall out of step.
  assert.deepEqual(
    existedAtBuildTime,
    Object.fromEntries(planVolumes.map((v) => [v.containerPath, true])),
    "every planned volume's mountpoint must already exist in the mounted tree when the container is built — " +
      "docker cannot mkdir on a read-only rootfs, so any false here is the container_crash this ticket closes",
  );

  // (c) and the invented member really travelled the whole way through, so (a) and
  // (b) cannot both be trivially satisfied by a two-entry hardcoded set.
  assert.ok(
    mounted.some((m) => m.container === `${PROJECT_CONTAINER_PATH}/${INVENTED_MEMBER}/node_modules`),
    `${INVENTED_MEMBER} must be bound and prepared without being named anywhere but package.json`,
  );

  const primary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
  assert.equal(primary!.status, "complete", "the run must still reach its normal outcome");
});

// ─── (D3) never clobber an ALREADY-POPULATED member node_modules ─────────────

test("FG-628 (D3): repeated and CONCURRENT dispatch over an already-populated node_modules is non-destructive — nothing is clobbered or emptied", async () => {
  setPlatform("darwin");
  process.env.FORGE_NO_WORKTREES = "1";

  // The operator's live checkout, fully installed: both members populated with real
  // content, including a nested package. `mkdir -p` over this must be a no-op; a
  // mechanism that "ensured" the directory by recreating it would silently destroy an
  // install, and the only dispatch lock is per-run so nothing serializes two runs
  // against one project dir.
  const repo = makeRepo();
  const memberDirs = [join(repo, "node_modules"), join(repo, MEMBER, "node_modules"), join(repo, INVENTED_MEMBER, "node_modules")];
  for (const nm of memberDirs) {
    mkdirSync(join(nm, "left-pad", "lib"), { recursive: true });
    writeFileSync(join(nm, ".package-lock.json"), `{"marker":"${nm}"}\n`);
    writeFileSync(join(nm, "left-pad", "package.json"), '{"name":"left-pad","version":"9.9.9"}\n');
    writeFileSync(join(nm, "left-pad", "lib", "index.js"), "module.exports = () => 'do not clobber me';\n");
  }
  const before = memberDirs.map((nm) => snapshotTree(nm));
  markDependencyCacheReady(lockfileHash(repo));

  // What the reds saw at container-build time, per dispatch: the mountpoint must be
  // present AND still carry its contents. "Present but emptied" is the failure mode a
  // bare existsSync check would wave through.
  const observed: { present: boolean; entries: string[] }[] = [];

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("provision-")) return 0;
    const mount = projectMount(args)!;
    if (taskId.startsWith("task-red-")) {
      const nm = join(mount.host, MEMBER, "node_modules");
      observed.push({
        present: statSync(nm, { throwIfNoEntry: false })?.isDirectory() === true,
        entries: existsSync(nm) ? readdirSync(nm).sort() : [],
      });
      writeTaskResult(stdoutPath, PASS_VERDICT);
      return 0;
    }
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [] });
    return 0;
  };

  // Two runs in parallel — the fanout shape, with no host-side mutual exclusion.
  const a = startRun({ workflow: WORKFLOW, title: "fg628 D3a", inputs: {}, projectDir: repo });
  const b = startRun({ workflow: WORKFLOW, title: "fg628 D3b", inputs: {}, projectDir: repo });
  await Promise.all([
    runNext({ runId: a.runId, workflow: WORKFLOW, dockerExec: stubExec }),
    runNext({ runId: b.runId, workflow: WORKFLOW, dockerExec: stubExec }),
  ]);
  // ...and a third, sequentially, so "repeated" is covered as well as "concurrent".
  const c = startRun({ workflow: WORKFLOW, title: "fg628 D3c", inputs: {}, projectDir: repo });
  await runNext({ runId: c.runId, workflow: WORKFLOW, dockerExec: stubExec });

  assert.equal(observed.length, 3, "all three runs' reds must have dispatched");
  for (const [i, o] of observed.entries()) {
    assert.equal(o.present, true, `dispatch ${i}: the mountpoint must be present`);
    assert.deepEqual(
      o.entries,
      [".package-lock.json", "left-pad"],
      `dispatch ${i}: the populated install must still be there at container-build time — never emptied to "ensure" the mountpoint`,
    );
  }

  // The durable check, byte for byte, over every member's tree.
  for (const [i, nm] of memberDirs.entries()) {
    assert.deepEqual(
      snapshotTree(nm),
      before[i],
      `${nm} must be byte-identical after three dispatches — creating a mountpoint over a populated dir is a no-op, not a replace`,
    );
  }
});
