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
  markDependencyCacheReady,
  parseDependencyProbeOutput,
  readDependencyCacheMarker,
  repairDisprovenDependencyCache,
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
 *  key and no test can be made green by another test's ready marker.
 *
 *  It DECLARES better-sqlite3 as a direct dependency, because that is what makes
 *  the driver load-bearing: the refusal is scoped to the natives the project
 *  itself depends on (declaredDependencyNames), so a fixture with an empty
 *  manifest would sail past a probe reporting the driver unloadable. */
function makeProject(lockSalt: string): string {
  const dir = makeTmpDir("fg664-proj-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg664-subject", dependencies: { "better-sqlite3": "^12.11.1" } }),
  );
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

/** The nonce Forge minted for a probe container, read back off its OWN argv. The
 *  fixture cannot hard-code one: the resolver generates a fresh value per
 *  dispatch and only accepts a report that carries it back, so a fake that did
 *  not read the argv would be refused exactly like a forged line. */
function probeNonce(args: string[]): string {
  const e = envArgs(args).find((v) => v.startsWith("FORGE_PROBE_NONCE="));
  return e ? e.slice("FORGE_PROBE_NONCE=".length) : "";
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
function makeExec(
  calls: Call[],
  over: {
    probe?: unknown;
    /** Overrides the report body, given the nonce the probe container was handed
     *  and how many probes this dispatch has already run — a re-probe after a
     *  stale-cache repair has to be able to answer differently from the probe
     *  that disproved the marker. */
    probeReport?: (nonce: string, probeIndex: number) => unknown;
    probeExit?: number;
    provisionerExit?: number;
  } = {},
): DockerExecFn {
  let probes = 0;
  return async ({ args, stdoutPath, stderrPath }) => {
    const kind = classifyCall(args);
    calls.push({ kind, args: [...args] });
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stderrPath, "");
    if (kind === "probe") {
      const nonce = probeNonce(args);
      const report = over.probeReport ? over.probeReport(nonce, probes++) : { nonce, ...PROBE_REPORT };
      const body = over.probe === undefined ? JSON.stringify(report) : (over.probe as string);
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
    dockerExec: makeExec(calls, { probeReport: (nonce) => ({ nonce, ...unloadable }) }),
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
    dockerExec: makeExec(calls, { probeReport: (nonce) => ({ nonce, ...emptyRoot }) }),
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
      runProbe: async (nonce) => {
        probes += 1;
        return { exitCode: 0, stdout: JSON.stringify({ nonce, ...PROBE_REPORT }), stderrTail: "" };
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

// ── (k): a DISPROVEN ready marker is repaired, not obeyed forever ────────────
//
// THE DEFECT THIS PINS. The ready marker lives under ~/.forge; the volumes it
// speaks for are docker objects. A Docker Desktop factory reset (or `docker
// volume prune`, or a `docker volume rm`) wipes the volumes and leaves the
// marker, so `isDependencyCacheReady` keeps saying yes, the provisioner is never
// re-run, and the (correct) dependencies_absent refusal below fires on every
// dispatch forever — every read-only reviewer on the host permanently blocked,
// with the only escape being an operator who knows to delete a file by hand.
// Measured on the darwin host by scripts/fg664-reviewer-engine-smoke.sh: cache
// key 5f33f1ce08f5973b, marker dated Jul 27, volume empty after the Aug 1 reset.

/** A probe report for a cache whose install root is EMPTY inside the container —
 *  what a marked-ready-but-pruned volume actually looks like. */
const EMPTY_ROOT_REPORT = {
  ...PROBE_REPORT,
  roots: [{ path: "/project/node_modules", entries: 0, installRoot: true }],
  packages: [],
};

test("fg664 (k): a ready marker the probe DISPROVES is invalidated and re-provisioned once, and the dispatch then proceeds", async () => {
  setPlatform("darwin");
  const project = makeProject("k");
  const hash = lockfileHash(project);
  markDependencyCacheReady(hash);
  const staleMarker = readDependencyCacheMarker(hash) as string;
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    // The first probe sees the wiped volume; the re-provisioned one is healthy.
    dockerExec: makeExec(calls, {
      probeReport: (nonce, i) => (i === 0 ? { nonce, ...EMPTY_ROOT_REPORT } : { nonce, ...PROBE_REPORT }),
    }),
  });

  assert.equal(res.status, "complete", res.error);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["probe", "provisioner", "probe", "agent"],
    "the disproof must re-provision and RE-PROBE before the dispatch is decided",
  );
  assert.equal(
    calls.filter((c) => c.kind === "provisioner").length,
    1,
    "exactly one re-provision attempt per dispatch — never a retry loop",
  );

  const marker = readDependencyCacheMarker(hash);
  assert.ok(marker, "a successful re-provision marks the cache ready again");
  assert.notEqual(marker, staleMarker, "the DISPROVEN marker must be gone, not merely accompanied");

  const receipt = readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment;
  assert.deepEqual(
    receipt?.staleCacheRepaired,
    {
      disprovenRoot: "/project/node_modules",
      invalidatedMarker: staleMarker,
      reprovisionedBy: "this_dispatch",
    },
    "the receipt must SAY the marker was invalidated and the cache re-provisioned — not leave the operator to infer it",
  );
  assert.equal(receipt?.packages[0]?.loaded, true, "the receipt attests the RE-PROBED environment");
});

test("fg664 (k2): when re-provisioning a disproven cache FAILS, the dispatch is refused, no marker survives, and no agent starts", async () => {
  setPlatform("darwin");
  const project = makeProject("k2");
  const hash = lockfileHash(project);
  markDependencyCacheReady(hash);
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, {
      probeReport: (nonce) => ({ nonce, ...EMPTY_ROOT_REPORT }),
      provisionerExit: 123,
    }),
  });

  assert.equal(res.failureKind, "verification_environment_unavailable");
  assert.match(res.error ?? "", /provisioning_failed/);
  assert.equal(
    isDependencyCacheReady(hash),
    false,
    "a failed repair leaves NO marker — the next dispatch re-provisions rather than inheriting the disproven claim",
  );
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0, "fail closed: no agent container on an unproven cache");
});

test("fg664 (k3): a re-provisioned cache that STILL probes empty is refused rather than re-provisioned again", async () => {
  setPlatform("darwin");
  const project = makeProject("k3");
  const hash = lockfileHash(project);
  markDependencyCacheReady(hash);
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, { probeReport: (nonce) => ({ nonce, ...EMPTY_ROOT_REPORT }) }),
  });

  assert.equal(res.failureKind, "verification_environment_unavailable");
  assert.match(res.error ?? "", /dependencies_absent/);
  assert.match(res.error ?? "", /STILL empty/);
  assert.equal(calls.filter((c) => c.kind === "provisioner").length, 1, "bounded: ONE re-provision, then refuse");
  assert.equal(calls.filter((c) => c.kind === "probe").length, 2);
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0);
});

test("fg664 (k4): two concurrent dispatches discovering ONE stale marker re-provision exactly once", async () => {
  setPlatform("darwin");
  const project = makeProject("k4");
  const hash = lockfileHash(project);
  markDependencyCacheReady(hash);

  // The volume's real state, as both dispatches' probes read it: empty until the
  // one provisioner that is allowed to run has run.
  let installed = false;
  let provisions = 0;
  const one = () =>
    resolveDependencyEnvironment({
      repoRoot: project,
      image: RUNTIME_IMAGE,
      platform: "darwin",
      lockOpts: { pollMs: 1 },
      runProvisioner: async () => {
        provisions += 1;
        installed = true;
        return { exitCode: 0, stderrTail: "" };
      },
      runProbe: async (nonce) => ({
        exitCode: 0,
        stdout: JSON.stringify({ nonce, ...(installed ? PROBE_REPORT : EMPTY_ROOT_REPORT) }),
        stderrTail: "",
      }),
    });

  const [a, b] = await Promise.all([one(), one()]);

  assert.equal(a.outcome, "ready", a.outcome === "refused" ? a.detail : "");
  assert.equal(b.outcome, "ready", b.outcome === "refused" ? b.detail : "");
  assert.equal(provisions, 1, "the FG-376 per-cache-key lock still admits exactly one provisioner");
  assert.ok(isDependencyCacheReady(hash));
});

test("fg664 (k5): a HEALTHY ready cache is untouched — no re-provision, no marker churn", async () => {
  setPlatform("darwin");
  const project = makeProject("k5");
  const hash = lockfileHash(project);
  markDependencyCacheReady(hash);
  const marker = readDependencyCacheMarker(hash);
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });

  assert.equal(res.status, "complete", res.error);
  assert.deepEqual(calls.map((c) => c.kind), ["probe", "agent"], "a ready cache reuses the install, as before");
  assert.equal(readDependencyCacheMarker(hash), marker, "the marker is not rewritten on the ordinary path");
  assert.equal(
    readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment?.staleCacheRepaired,
    undefined,
    "nothing was repaired, so the receipt claims no repair",
  );
});

test("fg664 (k6): a repairer whose marker was replaced while it waited provisions NOTHING and leaves the replacement alone", async () => {
  // The concurrent case at the primitive: both dispatches disprove marker M, one
  // repairs and writes M', the other reaches the lock and finds a marker it never
  // disproved. Tearing that down would restart an install another dispatch just
  // finished — the double-install the FG-376 lock exists to prevent.
  const key = "kkkk666666666666";
  markDependencyCacheReady(key);
  const disproven = readDependencyCacheMarker(key) as string;
  markDependencyCacheReady(key); // the concurrent repairer's replacement
  const replacement = readDependencyCacheMarker(key) as string;
  assert.notEqual(replacement, disproven, "two markers for one key must be distinguishable");

  let provisions = 0;
  const result = await repairDisprovenDependencyCache(key, disproven, async () => {
    provisions += 1;
    return { exitCode: 0, stderrTail: "" };
  });

  assert.equal(result.outcome, "already_repaired");
  assert.equal(provisions, 0);
  assert.equal(readDependencyCacheMarker(key), replacement, "the newer marker is left exactly as it was");
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

// ── (l): the argv-level FG-376 invariant, read off the `-e` entries ──────────

// The smoke script's p3_no_install_root once grepped the FLATTENED P1 argv for
// /FORGE_NM_INSTALL_ROOT|FORGE_NM_SHADOW/ and reported FAIL on a clean reviewer
// dispatch: the container script is itself an argv element, and it carries the
// literal text of the probe that PROVES those variables are empty in the
// container. The grep matched its own proof. This is the assertion that check
// was reaching for, stated where it belongs — over buildDockerArgs's actual env
// entries, with no docker daemon and no container script in the way.
test("fg664 (l): buildDockerArgs's read-only reviewer arm emits NO FORGE_NM_* env entry at all — no install root, no shadow — while both rw arms still emit the shadow", () => {
  setPlatform("darwin");
  const project = makeProject("l");
  const runtime = loadRuntime("claude-apikey");
  const base: SpawnContext = {
    TASK_ID: "task-l",
    TASK_DIR: makeTmpDir("fg664-taskdir-l-"),
    PROJECT_DIR: project,
    CANONICAL_PROJECT_DIR: project,
    PROJECT_MODE: "ro",
    MODEL: "test-model",
    SYSTEM_PROMPT: "sp",
    TASK_PACKAGE_MARKDOWN: "pkg",
  };

  // The reviewer arm, in the state the smoke script's P1 reproduces: read-only
  // project, cache already confirmed ready by the caller.
  const reviewer = buildDockerArgs(runtime, { ...base, DEPENDENCY_CACHE_MOUNT_RO: "1" });
  const hash = lockfileHash(project);
  assert.ok(
    volumeArgs(reviewer.args).includes(`${dependencyVolumeName(hash, "")}:/project/node_modules:ro`),
    "the arm under test must actually be the one that mounts the ready cache — otherwise the negative below is vacuous",
  );
  assert.deepEqual(
    envArgs(reviewer.args).filter((e) => e.startsWith("FORGE_NM_")),
    [],
    "a read-only reviewer dispatch must carry no FORGE_NM_* entry whatsoever: INSTALL_ROOT and SHADOW_PATHS are the entrypoint's install/chown triggers, and a reviewer never installs",
  );

  // Both rw arms still do — so the assertion above pins the ro arm specifically
  // and cannot be satisfied by the shadow having been dropped everywhere.
  const legacy = buildDockerArgs(runtime, { ...base, PROJECT_MODE: "rw" });
  assert.ok(envArgs(legacy.args).includes("FORGE_NM_SHADOW=/project/node_modules"));

  const worktree = buildDockerArgs(runtime, {
    ...base,
    PROJECT_MODE: "rw",
    IS_WORKTREE_DISPATCH: "1",
    DEPENDENCY_CACHE_MOUNT_RO: "1",
  });
  assert.ok(envArgs(worktree.args).includes("FORGE_NM_SHADOW=/project/node_modules"));
  assert.ok(envArgs(worktree.args).includes("FORGE_NM_SHADOW_PATHS=/project/node_modules"));
  assert.ok(
    !envArgs(worktree.args).some((e) => e.startsWith("FORGE_NM_INSTALL_ROOT=")),
    "no agent class ever gets FORGE_NM_INSTALL_ROOT — only the provisioner does",
  );
});

// ── the probe report reader ──────────────────────────────────────────────────

const NONCE = "b6f3c1de0000000000000000deadbeef";

test("fg664: the probe report is read from the LAST readable JSON line, so an entrypoint warning ahead of it does not defeat the attestation", () => {
  const stdout = `forge: WARNING — this task was dispatched with a db ticket authority\n${JSON.stringify({ nonce: NONCE, ...PROBE_REPORT })}\n`;
  const report = parseDependencyProbeOutput(stdout, NONCE);
  assert.equal(report?.abi, "137");
  assert.equal(report?.packages[0]?.name, "better-sqlite3");
  assert.equal(parseDependencyProbeOutput("not json at all", NONCE), undefined);
  assert.equal(parseDependencyProbeOutput('{"node":"v24"}', NONCE), undefined, "a partial report is no report");
});

test("fg664: a well-formed report that does NOT carry this dispatch's nonce is no report — the attested value is one the probed code was never handed", () => {
  // The forgery shape the old probe permitted: a well-formed, plausible report
  // printed onto the SAME stdout the host reads back, arriving AFTER the genuine
  // one so last-line-wins prefers it. Every field is right except the one thing
  // the printer could not know.
  const forged = JSON.stringify({ nonce: "0".repeat(32), ...PROBE_REPORT });
  const genuine = JSON.stringify({ nonce: NONCE, ...PROBE_REPORT });

  assert.equal(parseDependencyProbeOutput(forged, NONCE), undefined, "a foreign nonce must not be read as this dispatch's attestation");
  assert.equal(
    parseDependencyProbeOutput(JSON.stringify({ ...PROBE_REPORT }), NONCE),
    undefined,
    "a report with NO nonce at all is not this dispatch's report either",
  );
  assert.equal(
    parseDependencyProbeOutput(`${genuine}\n${forged}\n`, NONCE)?.nonce,
    NONCE,
    "the genuine line is still found when a forgery is appended after it",
  );
});

test("fg664: a probe whose stdout carries only an unattested report REFUSES the dispatch, and no agent container starts", async () => {
  setPlatform("darwin");
  const project = makeProject("nonce");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    // Everything a healthy probe reports, minus the binding to THIS dispatch.
    dockerExec: makeExec(calls, { probeReport: () => ({ nonce: "0".repeat(32), ...PROBE_REPORT }) }),
  });

  assert.equal(res.failureKind, "verification_environment_unavailable");
  assert.match(res.error ?? "", /probe_unparseable/);
  assert.match(res.error ?? "", /nonce/);
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0);
});

test("fg664: a native package the project does NOT depend on cannot refuse the dispatch, and one it DOES depend on still can", async () => {
  // The gate as first built required every top-level directory carrying a `.node`
  // to be loadable, with no allowlist. This project's own @img/sharp-linux-arm64
  // — installed by the provisioner's npm ci, publishing `exports` with no "."
  // entry — was never loadable that way, so the fail-closed gate refused EVERY
  // read-only dispatch on darwin. The question is "can this container load the
  // drivers this project needs", and the project's manifest is what says which
  // those are.
  setPlatform("darwin");
  const incidental = {
    ...PROBE_REPORT,
    packages: [
      ...PROBE_REPORT.packages,
      {
        name: "@img/sharp-linux-arm64",
        version: "0.34.5",
        loaded: false,
        error: "Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No \"exports\" main defined",
      },
    ],
  };

  const okCalls: Call[] = [];
  const ok = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: makeProject("scoped-ok"),
    readOnlyProject: true,
    dockerExec: makeExec(okCalls, { probeReport: (nonce) => ({ nonce, ...incidental }) }),
  });
  assert.equal(ok.status, "complete", `an undeclared native package must not refuse the dispatch (${ok.error})`);
  assert.equal(okCalls.filter((c) => c.kind === "agent").length, 1);
  assert.deepEqual(
    readTaskManifest(taskDir(ok.runId, ok.taskId))?.dependencyEnvironment?.packages.map((p) => `${p.name}:${p.loaded}`),
    ["better-sqlite3:true", "@img/sharp-linux-arm64:false"],
    "the unloadable incidental package is still RECORDED — non-fatal is not unseen",
  );

  // The fail-closed direction is unchanged: the driver the project declares is
  // still load-bearing, in the same report shape.
  const badCalls: Call[] = [];
  const bad = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: makeProject("scoped-bad"),
    readOnlyProject: true,
    dockerExec: makeExec(badCalls, {
      probeReport: (nonce) => ({
        nonce,
        ...incidental,
        packages: incidental.packages.map((p) =>
          p.name === "better-sqlite3" ? { ...p, loaded: false, error: "invalid ELF header" } : p,
        ),
      }),
    }),
  });
  assert.equal(bad.failureKind, "verification_environment_unavailable");
  assert.match(bad.error ?? "", /driver_unloadable/);
  assert.match(bad.error ?? "", /better-sqlite3/);
  assert.ok(
    !/@img\/sharp-linux-arm64/.test(bad.error ?? ""),
    "the refusal names the driver the project depends on, not every native-looking package",
  );
  assert.equal(badCalls.filter((c) => c.kind === "agent").length, 0);
});

test("fg664: a BROKEN project mount is diagnosed as the broken mount it is, not as an unavailable dependency cache", async () => {
  // The FG-664 gate prepares mountpoints INSIDE the project tree and provisions
  // against it, so while it ran AHEAD of the mount preflight a tree Forge already
  // knew was broken still got a provisioner and a probe container spent on it —
  // and whatever those said was the diagnosis the operator saw first. The mount
  // is the more specific fact; it is checked before anything is built.
  setPlatform("darwin");
  const broken = makeProject("broken-mount");
  // FG-559's shape: a linked worktree whose parent repo is gone. `.git` is a
  // pointer FILE to a path that does not exist, which is broken on the HOST.
  writeFileSync(join(broken, ".git"), `gitdir: ${join(broken, "does-not-exist", "worktrees", "gone")}\n`);
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: broken,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });

  assert.equal(res.status, "failed");
  assert.match(res.error ?? "", /preflightProjectMount failed/);
  assert.match(res.error ?? "", /gitdir: pointer/);
  assert.ok(
    !/mountpoints_unavailable|provisioning_failed/.test(res.error ?? ""),
    `a broken project mount must not be reported as a dependency-environment fault; got: ${res.error}`,
  );
  assert.deepEqual(
    calls.map((c) => c.kind),
    [],
    "no provisioner and no probe may be spent on a tree Forge already knows cannot be mounted",
  );
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
