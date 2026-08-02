// FG-664 half (A) + the dispatch-side fail-closed: a read-only reviewer/rechecker
// container gets the project's REAL native dependencies, host-side, and a dispatch
// that cannot be given them is refused as a classified environment fault.
//
// THE DEFECT THIS PINS. A rechecker that could not dlopen the project's native
// driver (linux container, darwin-arm64 bindings seen through the `/project:ro`
// bind) substituted a `node:sqlite`-backed shim, ran the regression suite against a
// DIFFERENT SQLite implementation, and reported the engine-difference failures as
// the findings still being present — three false verdicts on FG-662
// (review-6b9e07e48cc6, RF-1/RF-3/RF-4). The lane was non-conservative in both
// directions: a test that passed only under the shim would have rechecked resolved.
//
// WHAT THIS TIER CAN AND CANNOT PROVE. Every container here is an injected fake
// exec — no docker daemon. So this proves the WIRING: which containers are built,
// with which mounts, in which order, and what the host does with each outcome. It
// canNOT prove that a real reviewer container loads a real better-sqlite3 against a
// real kernel; that is a property of a real image and a real mount shape and it is
// proven host-side by scripts/fg664-reviewer-engine-smoke.sh (P1 positive / P2
// negative). A green run here must never be read as evidence for AC1.
//
// The darwin gate is faked (Object.defineProperty on process.platform, the
// established pattern in this suite) because the hazard is darwin-only and the unit
// tier runs on linux.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { getTask } from "../store/tasks.js";
import {
  findingsForReview,
  getReview,
  ingestFindings,
  insertReview,
  recordDisposition,
  type ReviewFinding,
} from "../store/reviews.js";
import { fixBatchesForReview } from "../store/fix-batches.js";
import { failureKindForTask } from "./failure-kind.js";
import { invoke } from "./invoke.js";
import {
  dependencyVolumeName,
  isDependencyCacheReady,
  lockfileHash,
  parseDependencyProbeOutput,
  resolveDependencyEnvironment,
  type DependencyEnvironmentReceipt,
} from "./dependency-provisioning.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";
import { loadRuntime } from "./loader.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import { nextTransition } from "./review-coordinator.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { readTaskManifest, writeTaskManifest, type TaskManifest } from "./task-manifest.js";
import { taskDir } from "../util/paths.js";
import type { DockerExecFn } from "./docker-exec.js";
import type { Run } from "../types/index.js";

// ── fixture ──────────────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prevDb: DatabaseInstance | null;
let forgeHome: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_VARS = ["FORGE_HOME", "FORGE_NO_NM_SHADOW", "ANTHROPIC_API_KEY", "FORGE_WORKTREES"] as const;
const tmpDirs: string[] = [];
const realPlatform = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(prefix = "fg664-"): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-${prefix}`));
  tmpDirs.push(dir);
  return dir;
}

/** A project whose lockfile is unique per call, so every test gets its own cache
 *  key and no test can be made green by another test's ready marker. */
function makeProject(lockSalt: string): string {
  const dir = makeTmpDir("fg664-proj-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg664-subject" }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, salt: lockSalt }));
  return dir;
}

const RUNTIME_IMAGE = "agent-dev-worker:fg664";

function writeRuntime(): void {
  const runtimeDir = join(forgeHome, "runtimes");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "claude-apikey.yml"),
    `name: claude-apikey
description: FG-664 test runtime stub
image: ${RUNTIME_IMAGE}
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
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(forgeHome);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prevDb = setDbForTest(db);
  for (const k of ENV_VARS) savedEnv[k] = process.env[k];
  forgeHome = makeTmpDir("fg664-home-");
  process.env.FORGE_HOME = forgeHome;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  process.env.FORGE_WORKTREES = "0";
  delete process.env.FORGE_NO_NM_SHADOW;
  writeRuntime();
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  setPlatform(realPlatform);
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── container classification ─────────────────────────────────────────────────

type Kind = "provisioner" | "probe" | "agent";
type Call = { kind: Kind; args: string[] };

function containerName(args: string[]): string {
  const i = args.indexOf("--name");
  return i >= 0 ? (args[i + 1] ?? "") : "";
}

function classifyCall(args: string[]): Kind {
  const name = containerName(args);
  if (name.startsWith("forge-provision-")) return "provisioner";
  if (name.startsWith("forge-depprobe-")) return "probe";
  return "agent";
}

function volumeArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-v") out.push(args[i + 1] as string);
  return out;
}

function envArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-e") out.push(args[i + 1] as string);
  return out;
}

const PROBE_REPORT = {
  node: "v24.4.0",
  abi: "137",
  roots: [{ path: "/project/node_modules", entries: 412, installRoot: true }],
  packages: [
    {
      name: "better-sqlite3",
      version: "12.11.1",
      artifact: "/project/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      resolvedPath: "/project/node_modules/better-sqlite3/lib/index.js",
      loaded: true,
    },
  ],
};

/** Records every container this dispatch builds and answers each one the way a
 *  healthy host would: the provisioner exits 0, the probe prints a report whose
 *  native package LOADED, the agent writes a result. */
function makeExec(calls: Call[], over: { probe?: unknown; probeExit?: number; provisionerExit?: number } = {}): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const kind = classifyCall(args);
    calls.push({ kind, args: [...args] });
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stderrPath, "");
    if (kind === "probe") {
      const body = over.probe === undefined ? JSON.stringify(PROBE_REPORT) : (over.probe as string);
      writeFileSync(stdoutPath, typeof body === "string" ? body : JSON.stringify(body));
      return over.probeExit ?? 0;
    }
    writeFileSync(stdoutPath, "");
    if (kind === "provisioner") return over.provisionerExit ?? 0;
    writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    return 0;
  };
}

// ── (a) + (c): the reviewer argv ─────────────────────────────────────────────

test("fg664 (a): a readOnlyProject invoke resolves the environment and the reviewer argv mounts every lockfile-keyed volume :ro, with /project still :ro and PROJECT_MODE=ro", async () => {
  setPlatform("darwin");
  const project = makeProject("a");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });

  assert.equal(res.status, "complete", res.error);

  // The host provisioned, then ATTESTED with its own probe, then started the agent.
  assert.deepEqual(calls.map((c) => c.kind), ["provisioner", "probe", "agent"]);

  const agent = calls.find((c) => c.kind === "agent")!;
  const volumes = volumeArgs(agent.args);
  const hash = lockfileHash(project);
  assert.ok(
    volumes.includes(`${dependencyVolumeName(hash, "")}:/project/node_modules:ro`),
    `the reviewer must mount the lockfile-keyed dependency volume READ-ONLY; got ${volumes.join(" ")}`,
  );
  // The enforcement primitive is untouched: the project bind is still `:ro` — the one
  // thing the container's passwordless root cannot undo — and the dispatch is still
  // RECORDED as a read-only mount.
  assert.ok(volumes.includes(`${project}:/project:ro`), `/project must stay bound :ro; got ${volumes.join(" ")}`);
  assert.ok(
    !volumes.some((v) => v.startsWith(`${project}:/project:`) && !v.endsWith(":ro")),
    "no second, writable bind of the project may appear",
  );
  assert.equal(
    readTaskManifest(taskDir(res.runId, res.taskId))?.controlPlane?.mountMode,
    "ro",
    "PROJECT_MODE stays ro — the dependency environment is resolved WITHOUT relaxing the mount",
  );
});

test("fg664 (c): the reviewer container never mounts a dependency volume rw, never gets FORGE_NM_INSTALL_ROOT, and runs no install — the FG-376 invariant holds", async () => {
  setPlatform("darwin");
  const project = makeProject("c");
  const calls: Call[] = [];

  await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });

  const hash = lockfileHash(project);
  const cacheVolume = dependencyVolumeName(hash, "");

  for (const kind of ["agent", "probe"] as const) {
    const call = calls.find((c) => c.kind === kind)!;
    const mounts = volumeArgs(call.args).filter((v) => v.startsWith(`${cacheVolume}:`));
    assert.ok(mounts.length > 0, `${kind}: expected the cache volume to be mounted`);
    for (const m of mounts) {
      assert.ok(m.endsWith(":ro"), `${kind} must mount the shared cache volume READ-ONLY, got '${m}'`);
    }
    assert.ok(
      !envArgs(call.args).some((e) => e.startsWith("FORGE_NM_INSTALL_ROOT=")),
      `${kind} must never carry FORGE_NM_INSTALL_ROOT — installing is the provisioner's job alone`,
    );
    assert.ok(
      !call.args.includes("npm") && !call.args.join(" ").includes("npm ci"),
      `${kind} must not run an install command`,
    );
  }

  // The provisioner — and ONLY the provisioner — writes to the cache.
  const provisioner = calls.find((c) => c.kind === "provisioner")!;
  assert.ok(
    volumeArgs(provisioner.args).includes(`${cacheVolume}:/project/node_modules`),
    "the dedicated provisioner is the one container that mounts the cache volume read-write",
  );
  assert.ok(envArgs(provisioner.args).includes("FORGE_NM_INSTALL_ROOT=/project"));
});

// ── (b): the refusal ─────────────────────────────────────────────────────────

test("fg664 (b): when the probe reports the real driver could not load, ZERO agent containers run and the task fails verification_environment_unavailable", async () => {
  setPlatform("darwin");
  const project = makeProject("b");
  const calls: Call[] = [];
  const unloadable = {
    ...PROBE_REPORT,
    packages: [
      {
        name: "better-sqlite3",
        version: "12.11.1",
        loaded: false,
        error:
          "Error: /project/node_modules/better-sqlite3/build/Release/better_sqlite3.node: " +
          "invalid ELF header",
      },
    ],
  };

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, { probe: JSON.stringify(unloadable) }),
  });

  assert.equal(res.status, "failed");
  assert.equal(
    res.failureKind,
    "verification_environment_unavailable",
    "InvokeResult.failureKind must carry that exact literal so review-wiring can route it to the stop",
  );
  assert.equal(failureKindForTask(res.taskId), "verification_environment_unavailable");
  assert.equal(
    calls.filter((c) => c.kind === "agent").length,
    0,
    "no agent container may start once the host knows the real driver will not load",
  );
  assert.match(res.error ?? "", /driver_unloadable/);
  assert.match(res.error ?? "", /better-sqlite3/);
  assert.equal(getTask(res.taskId)?.status, "failed");
});

test("fg664 (b2): a probe that exits 0 but attests an EMPTY install root is a refusal, not a green 'no native packages found'", async () => {
  setPlatform("darwin");
  const project = makeProject("b2");
  const calls: Call[] = [];
  const emptyRoot = {
    ...PROBE_REPORT,
    roots: [{ path: "/project/node_modules", entries: 0, installRoot: true }],
    packages: [],
  };

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, { probe: JSON.stringify(emptyRoot) }),
  });

  assert.equal(res.failureKind, "verification_environment_unavailable");
  assert.match(res.error ?? "", /dependencies_absent/);
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0);
});

test("fg664 (b3): a probe that prints nothing readable is a refusal — an unattested engine is not an attested one", async () => {
  setPlatform("darwin");
  const project = makeProject("b3");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, { probe: "forge: WARNING — something unrelated\n" }),
  });

  assert.equal(res.failureKind, "verification_environment_unavailable");
  assert.match(res.error ?? "", /probe_unparseable/);
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0);
});

// ── (d): concurrency, exactly-once, no marker on failure ─────────────────────

test("fg664 (d): two concurrent read-only resolutions on one cold cache key provision EXACTLY once, through the existing lock", async () => {
  setPlatform("darwin");
  const project = makeProject("d");
  let provisions = 0;
  let probes = 0;

  // No sleep, and none is needed: `resolveDependencyEnvironment` runs
  // synchronously into the lock's first `openSync`, so the SECOND call below
  // genuinely contends for a lock the first already holds. It then blocks on the
  // real poll loop, wakes, re-checks the marker, and skips provisioning — which
  // is the exactly-once property, not a race the test got lucky on. pollMs is the
  // test seam that keeps the real wait at ~1ms instead of the production 500ms.
  const one = () =>
    resolveDependencyEnvironment({
      repoRoot: project,
      image: RUNTIME_IMAGE,
      platform: "darwin",
      lockOpts: { pollMs: 1 },
      runProvisioner: async () => {
        provisions += 1;
        return { exitCode: 0, stderrTail: "" };
      },
      runProbe: async () => {
        probes += 1;
        return { exitCode: 0, stdout: JSON.stringify(PROBE_REPORT), stderrTail: "" };
      },
    });

  const [a, b] = await Promise.all([one(), one()]);

  assert.equal(a.outcome, "ready");
  assert.equal(b.outcome, "ready");
  assert.equal(provisions, 1, "the FG-376 per-cache-key lock must let exactly one provisioner run");
  assert.equal(probes, 2, "each dispatch still attests its OWN container's environment");
  assert.ok(isDependencyCacheReady(lockfileHash(project)));
});

test("fg664 (d2): a failed provision leaves NO ready marker and refuses the dispatch; a later dispatch re-provisions", async () => {
  setPlatform("darwin");
  const project = makeProject("d2");
  const calls: Call[] = [];

  const failed = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, { provisionerExit: 123 }),
  });

  assert.equal(failed.failureKind, "verification_environment_unavailable");
  assert.match(failed.error ?? "", /provisioning_failed/);
  assert.equal(isDependencyCacheReady(lockfileHash(project)), false, "a failed provision must leave no ready marker");
  assert.equal(calls.filter((c) => c.kind === "probe").length, 0, "no probe runs against a cache that never installed");
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0);

  const retryCalls: Call[] = [];
  const ok = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1 again",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(retryCalls),
  });
  assert.equal(ok.status, "complete", ok.error);
  assert.equal(
    retryCalls.filter((c) => c.kind === "provisioner").length,
    1,
    "the marker-less cache key must be re-provisioned, not reused",
  );
});

// ── (e): the not-applicable configurations ───────────────────────────────────

test("fg664 (e): non-darwin, FORGE_NO_NM_SHADOW=1 and a project with no package-lock.json are NOT refused and build no extra container", async () => {
  const cases: Array<{ label: string; platform: string; noShadow?: boolean; withLockfile: boolean }> = [
    { label: "linux host", platform: "linux", withLockfile: true },
    { label: "FORGE_NO_NM_SHADOW=1", platform: "darwin", noShadow: true, withLockfile: true },
    { label: "no package-lock.json", platform: "darwin", withLockfile: false },
  ];

  for (const c of cases) {
    setPlatform(c.platform);
    if (c.noShadow) process.env.FORGE_NO_NM_SHADOW = "1";
    else delete process.env.FORGE_NO_NM_SHADOW;

    const project = makeTmpDir(`fg664-na-`);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "na" }));
    if (c.withLockfile) writeFileSync(join(project, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));

    const calls: Call[] = [];
    const res = await invoke({
      agentRole: "review-rechecker",
      task: "recheck RF-1",
      projectDir: project,
      readOnlyProject: true,
      dockerExec: makeExec(calls),
    });

    assert.equal(res.status, "complete", `${c.label}: must not be refused (${res.error})`);
    assert.deepEqual(
      calls.map((k) => k.kind),
      ["agent"],
      `${c.label}: the pre-existing behaviour is exactly one agent container and nothing else`,
    );
    const agent = calls[0]!;
    assert.ok(
      !volumeArgs(agent.args).some((v) => v.startsWith("forge-deps-")),
      `${c.label}: no dependency-cache volume may be mounted`,
    );
    assert.equal(
      readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment,
      undefined,
      `${c.label}: a not-applicable dispatch records no environment receipt`,
    );
  }
});

// ── (f): the manifest half of AC3 ────────────────────────────────────────────

test("fg664 (f): the task manifest records the dependencyEnvironment receipt, and a manifest written without one still parses", async () => {
  setPlatform("darwin");
  const project = makeProject("f");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });
  assert.equal(res.status, "complete", res.error);

  const receipt = readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment;
  assert.ok(receipt, "a read-only dispatch must record its attested environment");
  assert.equal(receipt.cacheKey, lockfileHash(project));
  assert.equal(receipt.probeImage, RUNTIME_IMAGE);
  assert.equal(receipt.nodeVersion, PROBE_REPORT.node);
  assert.equal(receipt.abi, PROBE_REPORT.abi);
  assert.deepEqual(
    receipt.packages.map((p) => `${p.name}@${p.version}`),
    ["better-sqlite3@12.11.1"],
    "per-package ENGINE IDENTITY, not just a count",
  );

  // Optional, so every pre-FG-664 manifest still parses.
  const legacyDir = makeTmpDir("fg664-legacy-manifest-");
  const legacy: TaskManifest = {
    taskId: "task-legacy",
    runId: "run-legacy",
    files: {
      prompt: "CLAUDE.md",
      package: "package.md",
      result: "result.json",
      stdout: "container.stdout.log",
      stderr: "container.stderr.log",
    },
    container: { name: "forge-task-legacy" },
    auth: { profileRequested: false, stateMounted: false },
  };
  writeTaskManifest(legacyDir, legacy);
  const back = readTaskManifest(legacyDir);
  assert.equal(back?.taskId, "task-legacy");
  assert.equal(back?.dependencyEnvironment, undefined);
});

// ── (j): the rw/blue paths are untouched ─────────────────────────────────────

test("fg664 (j): a read-write invoke dispatch builds NO probe and NO provisioner, and buildDockerArgs's two rw arms emit the pre-change argv", async () => {
  setPlatform("darwin");
  const project = makeProject("j");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "engineer",
    task: "do the work",
    projectDir: project,
    dockerExec: makeExec(calls),
  });
  assert.equal(res.status, "complete", res.error);
  assert.deepEqual(calls.map((c) => c.kind), ["agent"], "the blue path resolves no dependency environment at all");
  assert.equal(readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment, undefined);

  const runtime = loadRuntime("claude-apikey");
  const base: SpawnContext = {
    TASK_ID: "task-rw",
    TASK_DIR: makeTmpDir("fg664-taskdir-"),
    PROJECT_DIR: project,
    CANONICAL_PROJECT_DIR: project,
    PROJECT_MODE: "rw",
    MODEL: "test-model",
    SYSTEM_PROMPT: "sp",
    TASK_PACKAGE_MARKDOWN: "pkg",
  };

  // The legacy anonymous shadow (DEC-019): a plain rw dispatch.
  const legacy = buildDockerArgs(runtime, base);
  assert.ok(volumeArgs(legacy.args).includes("/project/node_modules"), "the anonymous shadow volume must survive");
  assert.ok(envArgs(legacy.args).includes("FORGE_NM_SHADOW=/project/node_modules"));

  // The FG-376 worktree-rw arm: named volumes, read-only, plus the diagnostic env.
  const worktree = buildDockerArgs(runtime, {
    ...base,
    IS_WORKTREE_DISPATCH: "1",
    DEPENDENCY_CACHE_MOUNT_RO: "1",
  });
  const hash = lockfileHash(project);
  assert.ok(volumeArgs(worktree.args).includes(`${dependencyVolumeName(hash, "")}:/project/node_modules:ro`));
  assert.ok(envArgs(worktree.args).includes(`FORGE_NM_LOCKFILE_HASH=${hash}`));
  assert.ok(
    !envArgs(worktree.args).some((e) => e.startsWith("FORGE_NM_INSTALL_ROOT=")),
    "no agent class ever gets FORGE_NM_INSTALL_ROOT",
  );
});

// ── the probe report reader ──────────────────────────────────────────────────

test("fg664: the probe report is read from the LAST readable JSON line, so an entrypoint warning ahead of it does not defeat the attestation", () => {
  const stdout = `forge: WARNING — this task was dispatched with a db ticket authority\n${JSON.stringify(PROBE_REPORT)}\n`;
  const report = parseDependencyProbeOutput(stdout);
  assert.equal(report?.abi, "137");
  assert.equal(report?.packages[0]?.name, "better-sqlite3");
  assert.equal(parseDependencyProbeOutput("not json at all"), undefined);
  assert.equal(parseDependencyProbeOutput('{"node":"v24"}'), undefined, "a partial report is no report");
});

// ── (g) (h) (i): Stage 8 ─────────────────────────────────────────────────────

const RUN: Run = {
  id: "run-fg664",
  workflow: "feature",
  title: "fg664 recheck",
  status: "active",
  createdAt: "2026-08-02T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg664";
const CANDIDATE = "cand664";
const CONTRACT = {
  threat_model: "a reviewer that cannot load the real driver substitutes one",
  protected_invariants: ["the project mount stays :ro"],
  acceptance_refs: ["FG-664 AC2"],
  risk_lenses: ["backend"] as const,
  non_goals: ["detecting a fabricated verdict from a lane that CAN load the real driver"],
};
const EXECUTED_OUTPUT = "ok 1 - the rechecker reuses the real driver";

const RECEIPT: DependencyEnvironmentReceipt = {
  cacheKey: "0badc0de0badc0de",
  probeImage: RUNTIME_IMAGE,
  nodeVersion: "v24.4.0",
  abi: "137",
  packages: [{ name: "better-sqlite3", version: "12.11.1", loaded: true }],
};

/** The full injected-deps coordinator, driving the REAL stage machine — the same seam
 *  pattern review-run.test.ts uses. Only `dispatchRechecker` is under test here; the
 *  stages ahead of Stage 8 are stubbed just well enough to reach it honestly, because a
 *  hand-written row set could park the review in a state the machine would never produce. */
function harness(over: Partial<CoordinatorDeps> = {}): { deps: CoordinatorDeps; calls: { fixer: number } } {
  const calls = { fixer: 0 };
  let head = CANDIDATE;
  const deps: CoordinatorDeps = {
    headSha: () => head,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" }),
    changedPaths: () => ["src/v2/reconcile.ts"],
    diff: () => "--- a/src/v2/reconcile.ts",
    proposeContract: ({ changedPaths }) => ({
      candidateSha: "",
      changedPaths,
      noDrift: { diffSummary: "1 path", statement: "no lens to add" },
    }),
    dispatchLens: (ctx) => ({
      lens: ctx.lens,
      role: ctx.role,
      dispatched: true,
      taskId: `task-${ctx.lens}`,
      result: {
        outcome: "fail",
        findings: [
          {
            summary: "the reconcile path can write a partial result",
            evidence: "reconcile.ts writes before the guard",
            severity: "high",
            risk_lens: "backend",
            reachability: "demonstrated",
            challenges_contract: false,
            remediation_advice: "guard it",
            file: "src/v2/reconcile.ts",
            line: 12,
          },
        ],
      },
    }),
    materializeFixBatch: (ctx) => ctx.payload,
    dispatchFixer: (ctx) => {
      calls.fixer += 1;
      head = "afterfix664";
      return {
        ok: true,
        taskId: "task-fixer-664",
        result: {
          fix_batch_id: ctx.batch.id,
          revision: ctx.batch.revision,
          findings: ctx.batch.payload.findings.map((f) => ({
            finding_id: f.finding_id,
            result: "fixed",
            remediation_summary: "guarded",
            files_changed: ["src/v2/reconcile.ts"],
            evidence: "added the named regression test",
          })),
        },
      };
    },
    commitFixCycle: ({ declaredFiles }) =>
      declaredFiles.length > 0
        ? { kind: "committed", sha: head, committedPaths: [...declaredFiles] }
        : { kind: "no_change", sha: head },
    dispatchDocs: () => ({ ok: true }),
    dispatchRechecker: () => ({ ok: true, taskId: "task-recheck-664", result: {} }),
    shippingInput: () => assert.fail("these cases never reach the shipping review"),
    ...over,
  };
  return { deps, calls };
}

function pending() {
  return nextTransition({
    review: getReview(REVIEW) as never,
    findings: findingsForReview(REVIEW),
    batches: fixBatchesForReview(REVIEW),
  });
}

/** Drive real stages until the PERSISTED next transition is Stage 8, dispositioning
 *  whatever discovery raised as fix_now on the way. */
async function parkAtRecheck(deps: CoordinatorDeps): Promise<void> {
  insertRun(RUN);
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-664",
    reviewMode: "evidence_led",
    baseSha: "base664",
    candidateSha: CANDIDATE,
    contract: CONTRACT,
    state: "confirming_contract",
  });
  for (let i = 0; i < 16; i++) {
    if (pending().kind === "recheck") return;
    if (pending().kind === "await_disposition") {
      for (const f of findingsForReview(REVIEW)) {
        if (f.disposition !== "untriaged") continue;
        recordDisposition(f.id, { decision: "fix_now", rationale: "remediate this cycle", operator: false });
      }
      continue;
    }
    const outcome = await runNextStage(REVIEW, deps);
    assert.notEqual(outcome.status, "refused", `parking at recheck: ${outcome.transition.kind} — ${outcome.message}`);
  }
  assert.fail("never reached Stage 8");
}

test("fg664 (g): a rechecker dispatch refused verification_environment_unavailable STOPS the review as blocked_environment — no fixer, no cycle consumed, no resolution", async () => {
  const { deps, calls } = harness({
    dispatchRechecker: () => ({
      ok: false,
      failureKind: "verification_environment_unavailable",
      error: "verification_environment_unavailable (driver_unloadable): better-sqlite3 could not be loaded",
    }),
  });
  await parkAtRecheck(deps);
  const fixersBefore = calls.fixer;
  const cyclesBefore = fixBatchesForReview(REVIEW).length;
  const finding = findingsForReview(REVIEW)[0] as ReviewFinding;

  const outcome = await runNextStage(REVIEW, deps);

  assert.equal(outcome.transition.kind, "recheck");
  assert.equal(outcome.status, "stopped", "an environment fault is a STOP, never a refusal that re-dispatches");
  assert.equal(getReview(REVIEW)?.state, "blocked_environment");
  assert.equal(calls.fixer, fixersBefore, "the stop dispatches no fixer");
  assert.equal(fixBatchesForReview(REVIEW).length, cyclesBefore, "the stop consumes no review cycle");
  assert.match(outcome.message, /blocked_environment/);

  const after = findingsForReview(REVIEW).find((f) => f.id === finding.id) as ReviewFinding;
  assert.equal(after.resolution, undefined, "no resolution — not resolved, and not still-present either");
  assert.equal(getReview(REVIEW)?.stageEvidence?.recheck, undefined, "no recheck stage record was written");
});

test("fg664 (i): an ingested application carrying blocked_environment coverage stops the stage and writes NOTHING", async () => {
  // A lane that RAN and declared, per the rechecker protocol, that it could not execute
  // the coverage it cited. Step 2 is what makes this value reachable from a real
  // rechecker's output; the stop it triggers is this step's.
  const { deps, calls } = harness({
    dispatchRechecker: ({ review, candidateSha, expected }) => ({
      ok: true,
      taskId: "task-recheck-664",
      result: {
        review_id: review.id,
        candidate_sha: candidateSha,
        rechecked: expected.map((f) => ({
          finding_id: f.id,
          result: "resolved",
          evidence_kind: "regression_test",
          evidence: {
            kind: "regression_test",
            test_name: "the reconcile path guards a partial write",
            environment_blocked: "better-sqlite3 could not be loaded in this container",
          },
        })),
        new_findings: [],
      },
    }),
  });
  await parkAtRecheck(deps);
  const fixersBefore = calls.fixer;
  const finding = findingsForReview(REVIEW)[0] as ReviewFinding;

  const outcome = await runNextStage(REVIEW, deps);

  assert.equal(outcome.status, "stopped", outcome.message);
  assert.equal(getReview(REVIEW)?.state, "blocked_environment");
  assert.equal(calls.fixer, fixersBefore, "the stop dispatches no fixer");
  const after = findingsForReview(REVIEW).find((f) => f.id === finding.id) as ReviewFinding;
  assert.equal(after.resolution, undefined, "a lane that could not run proves nothing in either direction");
  assert.equal(getReview(REVIEW)?.stageEvidence?.recheck, undefined, "no stage record");
});

test("fg664 (h): a successful recheck records the SAME receipt in the stage evidence that the manifest carries — one fact in two places", async () => {
  const { deps } = harness({
      dispatchRechecker: ({ review, candidateSha, expected }) => ({
        ok: true,
        taskId: "task-recheck-664",
        dependencyEnvironment: RECEIPT,
        result: {
          review_id: review.id,
          candidate_sha: candidateSha,
          rechecked: expected.map((f) => ({
            finding_id: f.id,
            result: "resolved",
            evidence_kind: "regression_test",
            evidence: {
              kind: "regression_test",
              test_name: "the reconcile path guards a partial write",
              runner_output: EXECUTED_OUTPUT,
            },
          })),
          new_findings: [],
        },
      }),
  });
  await parkAtRecheck(deps);

  const outcome = await runNextStage(REVIEW, deps);
  assert.equal(outcome.status, "advanced", outcome.message);

  const meta = getReview(REVIEW)?.stageEvidence?.recheck?.meta as
    | { dependencyEnvironment?: DependencyEnvironmentReceipt }
    | undefined;
  assert.ok(meta?.dependencyEnvironment, "the recheck stage evidence must record which engine produced the resolutions");
  assert.equal(meta.dependencyEnvironment.cacheKey, RECEIPT.cacheKey);
  assert.equal(meta.dependencyEnvironment.abi, RECEIPT.abi);
  assert.deepEqual(meta.dependencyEnvironment.packages, RECEIPT.packages);
});

test("fg664: a rechecker that RAN and crashed is still the ordinary refusal — it re-enters, and it is NOT blocked_environment", async () => {
  const { deps } = harness({ dispatchRechecker: () => ({ ok: false, error: "the container died" }) });
  await parkAtRecheck(deps);

  const outcome = await runNextStage(REVIEW, deps);
  assert.equal(outcome.status, "refused");
  assert.notEqual(getReview(REVIEW)?.state, "blocked_environment");
  assert.equal(
    nextTransition({
      review: getReview(REVIEW) as never,
      findings: findingsForReview(REVIEW),
      batches: fixBatchesForReview(REVIEW),
    }).kind,
    "recheck",
    "the crash arm re-enters Stage 8; the environment arm does not",
  );
});

// A cheap guard on the fixture itself: if the probe log path ever moves, the
// attestation silently reads an empty file and every dispatch refuses.
test("fg664: the probe writes its report where the resolver reads it", async () => {
  setPlatform("darwin");
  const project = makeProject("probe-log");
  const calls: Call[] = [];
  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });
  const log = join(taskDir(res.runId, res.taskId), "container.depprobe.stdout.log");
  assert.ok(existsSync(log), "the probe's stdout is retained as dispatch evidence");
  assert.match(readFileSync(log, "utf8"), /better-sqlite3/);
});
