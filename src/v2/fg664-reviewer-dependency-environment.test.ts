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
import { homedir, tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { eventsForTask } from "../store/events.js";
import { insertRun } from "../store/runs.js";
import { getTask } from "../store/tasks.js";
import {
  findingsForReview,
  getReview,
  ingestFindings,
  insertReview,
  markDocsDispatchDelivered,
  openDocsDispatch,
  recordDisposition,
  type ReviewFinding,
} from "../store/reviews.js";
import { fixBatchesForReview } from "../store/fix-batches.js";
import { failureKindForTask } from "./failure-kind.js";
import { invoke } from "./invoke.js";
import { retry } from "./retry.js";
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
import { fakeReviewDiff } from "./review-diff.testkit.js";
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

function writeRuntime(env: Record<string, string> = {}): void {
  const runtimeDir = join(forgeHome, "runtimes");
  mkdirSync(runtimeDir, { recursive: true });
  const envBlock = Object.keys(env).length === 0
    ? "env: {}"
    : ["env:", ...Object.entries(env).map(([k, v]) => `  ${k}: "${v}"`)].join("\n");
  writeFileSync(
    join(runtimeDir, "claude-apikey.yml"),
    `name: claude-apikey
description: FG-664 test runtime stub
image: ${RUNTIME_IMAGE}
models:
  default: test-model
auth:
  mode: apikey
${envBlock}
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

type Kind = "provisioner" | "probe" | "load" | "agent";
type Call = { kind: Kind; args: string[] };

function containerName(args: string[]): string {
  const i = args.indexOf("--name");
  return i >= 0 ? (args[i + 1] ?? "") : "";
}

function classifyCall(args: string[]): Kind {
  const name = containerName(args);
  if (name.startsWith("forge-provision-")) return "provisioner";
  if (name.startsWith("forge-depprobe-")) return "probe";
  if (name.startsWith("forge-depload-")) return "load";
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

// The probe reports what it SAW. It says nothing about whether an artifact
// loads: that verdict is a load container's exit status, which the host
// observes (see the `load` override below).
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
    },
  ],
  missing: [] as string[],
};

/** The artifact a load container was told to dlopen — its LAST argv element. */
function loadArtifact(args: string[]): string {
  return args[args.length - 1] ?? "";
}

/** Records every container this dispatch builds and answers each one the way a
 *  healthy host would: the provisioner exits 0, the probe prints a report naming
 *  the project's native artifact, every load container exits 0 (that artifact
 *  loads), and the agent writes a result. */
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
    /** The exit code for ONE load container, by the artifact it was handed. This
     *  is where "the driver will not load" lives now: the host reads it from a
     *  container's exit status, never from anything the loaded code printed. */
    load?: (artifact: string, stderrPath: string) => number;
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
    if (kind === "load") {
      writeFileSync(stdoutPath, "");
      return over.load ? over.load(loadArtifact(args), stderrPath) : 0;
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

  // The host provisioned, ATTESTED with its own probe, LOADED the reported
  // artifact in its own container, then started the agent.
  assert.deepEqual(calls.map((c) => c.kind), ["provisioner", "probe", "load", "agent"]);

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

test("fg664: both Forge-owned containers carry the runtime's OWN env — the attested loading environment is the reviewer's, not a subset of it", async () => {
  // The probe answers "can this container load the driver". A runtime
  // LD_LIBRARY_PATH / NODE_OPTIONS is an input to that answer, and the reviewer
  // gets it (buildDockerArgs forwards runtime.env). A gate that omits it can
  // refuse a reviewer that would have loaded fine, or attest an environment the
  // reviewer does not run in — either way the receipt names the wrong thing.
  setPlatform("darwin");
  writeRuntime({ LD_LIBRARY_PATH: "/opt/forge/lib", NODE_OPTIONS: "--max-old-space-size=512", FORGE_NM_SHADOW: "/nope" });
  const project = makeProject("runtime-env");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });
  assert.equal(res.status, "complete", res.error);

  for (const kind of ["probe", "load", "agent"] as const) {
    const call = calls.find((c) => c.kind === kind);
    assert.ok(call, `expected a ${kind} container`);
    const env = envArgs(call.args);
    assert.ok(env.includes("LD_LIBRARY_PATH=/opt/forge/lib"), `${kind} must carry the runtime's LD_LIBRARY_PATH; got ${env.join(" ")}`);
    assert.ok(env.includes("NODE_OPTIONS=--max-old-space-size=512"), `${kind} must carry the runtime's NODE_OPTIONS; got ${env.join(" ")}`);
  }

  // The ONE narrowing: the entrypoint's install contract is never forwarded into
  // the two containers whose whole guarantee is that they install nothing.
  for (const kind of ["probe", "load"] as const) {
    const call = calls.find((c) => c.kind === kind)!;
    assert.deepEqual(
      envArgs(call.args).filter((e) => e.startsWith("FORGE_NM_")),
      [],
      `the ${kind} container must never be handed a FORGE_NM_* install instruction`,
    );
  }
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

test("fg664 (b): when the real driver's load container exits nonzero, ZERO agent containers run and the task fails verification_environment_unavailable", async () => {
  setPlatform("darwin");
  const project = makeProject("b");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, {
      load: (artifact, stderrPath) => {
        writeFileSync(stderrPath, `Error: ${artifact}: invalid ELF header\nNode.js v24.4.0\n`);
        return 1;
      },
    }),
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
  assert.match(
    res.error ?? "",
    /invalid ELF header/,
    "the refusal carries the real loader error, not just the load container's exit code",
  );
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

test("fg664 (b4): a DECLARED package absent from every mounted root is a refusal, even though the install root is populated", async () => {
  // The gate refused only on a declared driver that was present-but-unloadable.
  // A declared driver MISSING from the cache reported nothing at all, so the
  // unloadable set was empty and the dispatch resolved READY — the reviewer
  // started without it, and `require('better-sqlite3')` inside it threw "Could
  // not locate the bindings file". The install-root emptiness test cannot see
  // this: the root is populated, just incomplete, and it never inspects a
  // workspace member's volume at all.
  setPlatform("darwin");
  const project = makeProject("b4");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, {
      probeReport: (nonce) => ({ nonce, ...PROBE_REPORT, packages: [], missing: ["better-sqlite3"] }),
    }),
  });

  assert.equal(res.failureKind, "verification_environment_unavailable");
  assert.match(res.error ?? "", /dependencies_absent/);
  assert.match(res.error ?? "", /better-sqlite3/);
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0, "no reviewer starts without the driver it needs");
});

test("fg664 (b5): a DECLARED package that builds a native addon and shipped none is driver_unloadable — there is nothing to load, which is not the same as nothing to check", async () => {
  setPlatform("darwin");
  const project = makeProject("b5");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, {
      probeReport: (nonce) => ({
        nonce,
        ...PROBE_REPORT,
        packages: [
          {
            name: "better-sqlite3",
            version: "12.11.1",
            unavailable: "the package builds a native addon but the mounted cache holds no compiled .node artifact",
          },
        ],
      }),
    }),
  });

  assert.equal(res.failureKind, "verification_environment_unavailable");
  assert.match(res.error ?? "", /driver_unloadable/);
  assert.match(res.error ?? "", /no compiled \.node artifact/);
  assert.equal(calls.filter((c) => c.kind === "load").length, 0, "there is no artifact to hand a load container");
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
      runLoad: async () => ({ exitCode: 0, stderrTail: "" }),
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
    ["probe", "provisioner", "probe", "load", "agent"],
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
  assert.match(res.error ?? "", /probed EMPTY/);
  assert.match(res.error ?? "", /STILL true/);
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
      runLoad: async () => ({ exitCode: 0, stderrTail: "" }),
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
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["probe", "load", "agent"],
    "a ready cache reuses the install, as before — it is still attested, never assumed",
  );
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
    assert.equal(
      eventsForTask(res.taskId).filter((e) => e.eventType === "container.dependency_environment_resolved").length,
      0,
      `${c.label}: nothing was attested, so nothing may claim an engine on the timeline`,
    );
  }
});

// ── FG-678: the third outcome, through this same read-only gate ──────────────
//
// The (e) case above holds "no package-lock.json" as not-applicable, and its
// fixture declares no dependencies — that is still exactly right, and it stays
// green unchanged. What FG-678 separates out is the OTHER lockfile-less project:
// one that declares dependencies it has no reproducible way to key. That project
// has something to provision and no name to bind it to, and it now refuses
// rather than dispatching a reviewer into a workspace nothing provisioned.
//
// BD-3a's stated consequence, proved here rather than asserted: the discriminator
// lives in the ONE shared resolver, with no read-only/writable branch, so the
// refusal reaches this read-only reviewer lane too. A darwin reviewer against a
// declares-dependencies-no-lockfile project REFUSES where it previously
// dispatched — bounded by the darwin gate and FORGE_NO_NM_SHADOW, both of which
// still short-circuit ahead of it.

/** (e)'s fixture with dependencies added and the lockfile still absent — the
 *  one dimension the two outcomes differ on. */
function makeLockfilelessProjectDeclaringDependencies(): string {
  const dir = makeTmpDir("fg664-nolock-deps-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg678-subject", dependencies: { "better-sqlite3": "^12.11.1" } }),
  );
  return dir;
}

test("fg678 (BD-3a): a read-only reviewer against a project that DECLARES dependencies with no lockfile is refused lockfile_absent — no agent container, and the refusal is durable", async () => {
  setPlatform("darwin");
  const project = makeLockfilelessProjectDeclaringDependencies();
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "verification_environment_unavailable", res.error);
  assert.deepEqual(
    calls.map((c) => c.kind),
    [],
    "the decision is host-side: nothing is dispatched, not even a provisioner, into an unkeyable workspace",
  );
  assert.equal(failureKindForTask(res.taskId), "verification_environment_unavailable");

  const refusal = eventsForTask(res.taskId).filter((e) => e.eventType === "container.dependency_provisioning_failed");
  assert.equal(refusal.length, 1, "the EXISTING refusal event carries this — no new vocabulary on the task plane");
  const payload = refusal[0]!.payload as Record<string, unknown>;
  assert.equal(payload.stage, "environment_resolution");
  assert.equal(payload.reason, "lockfile_absent");
  assert.equal(payload.projectDir, project);

  const manifest = readTaskManifest(taskDir(res.runId, res.taskId));
  assert.equal(manifest?.dispatchRefused?.stage, "dependency_environment");
  assert.equal(
    manifest?.dispatchRefused?.reason,
    "lockfile_absent",
    "the reason is answerable from the manifest, not inferred from a container log",
  );
  assert.equal(manifest?.dependencyEnvironment, undefined, "nothing was bound, so nothing may claim it was");

  // BD-3, explicitly forbidden: this project HAS dependencies. Neither the
  // operator-facing error nor the durable detail may say otherwise, and both
  // must say what to do about it.
  const detail = manifest?.dispatchRefused?.detail ?? "";
  for (const [label, text] of [["error", res.error ?? ""], ["detail", detail]] as const) {
    assert.ok(text.includes("package-lock.json"), `${label} must name the supported lockfile: ${text}`);
    assert.ok(text.includes("better-sqlite3"), `${label} must name what the project declared: ${text}`);
    assert.ok(!/no dependencies/i.test(text), `${label} must never claim the workspace has none: ${text}`);
  }
  assert.ok(detail.includes(join(project, "package.json")), `the detail must name the declaring manifest: ${detail}`);
});

test("fg678: the two lockfile-less projects diverge on ONE fact — whether a manifest declares dependencies", async () => {
  setPlatform("darwin");

  // Declares nothing: (e)'s case, unchanged — one agent container, no receipt.
  const bare = makeTmpDir("fg664-nolock-bare-");
  writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "bare" }));
  const bareCalls: Call[] = [];
  const bareRes = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: bare,
    readOnlyProject: true,
    dockerExec: makeExec(bareCalls),
  });
  assert.equal(bareRes.status, "complete", bareRes.error);
  assert.deepEqual(bareCalls.map((c) => c.kind), ["agent"]);

  // Declares dependencies: refused.
  const declaring = makeLockfilelessProjectDeclaringDependencies();
  const declaringCalls: Call[] = [];
  const declaringRes = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: declaring,
    readOnlyProject: true,
    dockerExec: makeExec(declaringCalls),
  });
  assert.equal(declaringRes.failureKind, "verification_environment_unavailable");
  assert.deepEqual(declaringCalls.map((c) => c.kind), []);
});

test("fg678: the escape hatches still short-circuit ahead of the discriminator on this lane — a declares-deps-no-lockfile project dispatches on linux and under FORGE_NO_NM_SHADOW=1", async () => {
  for (const c of [
    { label: "linux host", platform: "linux", noShadow: false },
    { label: "FORGE_NO_NM_SHADOW=1", platform: "darwin", noShadow: true },
  ]) {
    setPlatform(c.platform);
    if (c.noShadow) process.env.FORGE_NO_NM_SHADOW = "1";
    else delete process.env.FORGE_NO_NM_SHADOW;

    const project = makeLockfilelessProjectDeclaringDependencies();
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
  }
  delete process.env.FORGE_NO_NM_SHADOW;
});

// ── (f): the manifest half of AC3 ────────────────────────────────────────────

test("fg664: a REFUSED read-only dispatch still writes its manifest, so `forge retry` re-dispatches it READ-ONLY instead of guessing from the role name", async () => {
  // THE DEFECT. The gate refuses before the manifest was written, so a refused
  // task left none. retry.ts recovers the mount from that manifest and, with
  // none, falls back to `agentRole.startsWith("red-")` — and the recheck lane's
  // role is `review-rechecker`, which does not. The retry therefore re-dispatched
  // a reviewer with PROJECT_MODE=rw: a read-WRITE project mount, the legacy
  // shadow arm (so the container installs), and no FG-664 gate at all, since the
  // gate is guarded on readOnlyProject. A red with a writable project mount is
  // the one thing the kernel-enforced `:ro` bind exists to prevent.
  setPlatform("darwin");
  const project = makeProject("retry-mount");
  const calls: Call[] = [];

  const refused = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, { probeExit: 1 }),
  });
  assert.equal(refused.failureKind, "verification_environment_unavailable");
  assert.equal(calls.filter((c) => c.kind === "agent").length, 0);

  const manifest = readTaskManifest(taskDir(refused.runId, refused.taskId));
  assert.ok(manifest, "a dispatch decision was made, so the receipt that records it must exist");
  assert.equal(manifest.controlPlane?.mountMode, "ro", "the mount this task was dispatched under is RECORDED, not inferred");
  assert.equal(manifest.controlPlane?.projectDir, project);
  assert.ok(manifest.runtime?.name, "retry refuses a manifest that records no runtime, so the refusal path must record one");
  assert.equal(manifest.dispatchRefused?.stage, "dependency_environment", "and it says why no container ran");
  assert.equal(
    manifest.agentProtocol,
    undefined,
    "no container ran, so no protocol was executed — the ledger's protocol stamp means 'this agent ran under'",
  );

  // The consequence, through the real retry planner: the re-dispatch is read-only.
  const outcome = await retry(refused.taskId);
  assert.ok(outcome.adHoc, "an invoke-dispatched row retries ad-hoc");
  assert.equal(
    outcome.adHoc.readOnlyProject,
    true,
    "the retry of a refused reviewer must keep the kernel-enforced read-only project mount",
  );
});

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

// ── (f2): the LEDGER half of AC3 ─────────────────────────────────────────────
//
// THE GAP THESE CLOSE. Events were written on REFUSAL only, so a lane that
// resolved cleanly left `SELECT COUNT(*) FROM events WHERE event_type LIKE
// '%depend%'` returning 0 — measured on a real read-only dispatch through the
// repaired lane (run-fg-664-ac4-lane-proof-4889d0, task-red-wide-0ca8fd), whose
// manifest nevertheless carried a full receipt. The manifest is a file beside one
// dispatch; the successful case is the one an auditor checks, and it is the one
// that reached no timeline.

/** Every string anywhere in the payload that is an absolute path. Both kinds are
 *  refused, not only the host's: the receipt's `artifact` / `resolvedPath` are
 *  container paths and still have no business in a table read far from the
 *  dispatch that wrote it. */
function absolutePathsIn(value: unknown, at = "payload"): string[] {
  if (typeof value === "string") return value.startsWith("/") ? [`${at}=${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => absolutePathsIn(v, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => absolutePathsIn(v, `${at}.${k}`));
  }
  return [];
}

test("fg664 (f2): a SUCCESSFUL read-only resolution records the attested engine on the task timeline, with the cache key, node, ABI, image and per-package load verdict", async () => {
  setPlatform("darwin");
  const project = makeProject("f2");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });
  assert.equal(res.status, "complete", res.error);

  const emitted = eventsForTask(res.taskId).filter(
    (e) => e.eventType === "container.dependency_environment_resolved",
  );
  assert.equal(emitted.length, 1, "one resolution, one durable record");
  assert.equal(emitted[0]!.runId, res.runId);

  const payload = emitted[0]!.payload as {
    stage: string;
    cacheKey: string;
    probeImage: string;
    nodeVersion: string;
    abi: string;
    packages: Array<{ name: string; version: string; loaded: boolean }>;
  };
  assert.equal(payload.stage, "environment_resolution", "the refusal event's grain — one vocabulary, one decision");
  assert.equal(payload.cacheKey, lockfileHash(project));
  assert.equal(payload.probeImage, RUNTIME_IMAGE);
  assert.equal(payload.nodeVersion, PROBE_REPORT.node);
  assert.equal(payload.abi, PROBE_REPORT.abi);
  assert.deepEqual(
    payload.packages,
    [{ name: "better-sqlite3", version: "12.11.1", loaded: true }],
    "the declared native package and the host-observed verdict on whether it loaded",
  );
});

test("fg664 (f2): the resolved-environment payload carries no host path and no path at all — the receipt's own path fields are dropped, not forwarded", async () => {
  setPlatform("darwin");
  const project = makeProject("f2-redaction");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls),
  });
  assert.equal(res.status, "complete", res.error);

  const payload = eventsForTask(res.taskId).find(
    (e) => e.eventType === "container.dependency_environment_resolved",
  )!.payload as Record<string, unknown>;

  // The field set is CLOSED. This is what makes the redaction survive a later
  // field being added to the receipt: the payload is built by naming fields, so
  // a new one cannot arrive here by default, and this pins that.
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["abi", "cacheKey", "nodeVersion", "packages", "probeImage", "stage"],
  );
  const pkg = (payload.packages as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(Object.keys(pkg).sort(), ["loaded", "name", "version"]);

  assert.deepEqual(absolutePathsIn(payload), [], "no absolute path may reach the events table");

  const receipt = readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment;
  assert.ok(receipt, "the manifest half of AC3 is unchanged and still carries the whole receipt");
  const probed = receipt.packages[0];
  assert.ok(probed, "the fixture probes one package");
  const { artifact, resolvedPath } = probed;
  assert.ok(artifact, "the receipt itself DOES carry the artifact path — that is the thing dropped here");
  assert.ok(resolvedPath, "and the resolved entry point");

  const serialized = JSON.stringify(payload);
  for (const leak of [artifact, resolvedPath, project, forgeHome, tmpdir(), homedir()]) {
    assert.ok(!serialized.includes(leak), `the payload must not carry ${leak}`);
  }
});

test("fg664 (f2): a REFUSED dispatch emits exactly what it emitted before, and nothing claims an engine — the success case ADDS a record, it does not change the failure one", async () => {
  setPlatform("darwin");
  const project = makeProject("f2-refusal");
  const calls: Call[] = [];

  const refused = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: project,
    readOnlyProject: true,
    dockerExec: makeExec(calls, { probeExit: 1 }),
  });
  assert.equal(refused.failureKind, "verification_environment_unavailable");

  const events = eventsForTask(refused.taskId);
  assert.equal(
    events.filter((e) => e.eventType === "container.dependency_environment_resolved").length,
    0,
    "nothing was attested, so nothing may say which engine ran",
  );

  const refusal = events.filter((e) => e.eventType === "container.dependency_provisioning_failed");
  assert.equal(refusal.length, 1);
  const payload = refusal[0]!.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["detail", "projectDir", "reason", "stage"]);
  assert.equal(payload.stage, "environment_resolution");
  assert.equal(payload.reason, "probe_failed");
  assert.equal(payload.projectDir, project);
});

// ── (j): the rw/blue path after FG-678, and the two argv arms that still stand ─
//
// FG-664 gave the read-only reviewer lane a host-resolved environment and left the
// writable one alone; FG-678 closed that gap, so the blue path now resolves and
// attests exactly as this file's (a) does. What FG-664 pinned here that FG-678 did
// NOT change is the mount planner's fallback: an rw dispatch whose caller resolved
// NO environment still takes the legacy anonymous shadow rather than a shared
// writable cache over a live project directory (AC5).

test("fg664 (j): a read-write invoke dispatch resolves and attests its dependency environment BEFORE the agent (FG-678), while buildDockerArgs's no-environment rw arm still emits the legacy anonymous shadow", async () => {
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
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["provisioner", "probe", "load", "agent"],
    "the blue path provisions and attests ahead of the agent, exactly as the read-only lane does",
  );

  // The ordering property, stated on the ledger as well as on the container
  // sequence: the agent container starts only after the environment it was given
  // was resolved AND recorded. An agent that ran first would have improvised one.
  const types = eventsForTask(res.taskId).map((e) => e.eventType);
  const resolvedAt = types.indexOf("container.dependency_environment_resolved");
  const startedAt = types.indexOf("container.started");
  assert.ok(resolvedAt >= 0, `expected a resolution on the timeline; got ${types.join(", ")}`);
  assert.ok(startedAt > resolvedAt, "the resolution is recorded BEFORE the agent container starts");

  const receipt = readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment;
  assert.ok(receipt, "a writable dispatch that resolved an environment carries its receipt");
  assert.equal(receipt.cacheKey, lockfileHash(project), "and the receipt is keyed to the lockfile it was built from");

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

  // The legacy anonymous shadow (DEC-019): an rw dispatch whose caller resolved
  // no environment (no DEPENDENCY_CACHE_MOUNT_RO). This arm is what keeps a shared
  // writable cache off a live shared project directory, and FG-678 kept it.
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
  assert.equal(parseDependencyProbeOutput(`${genuine}\n`, NONCE)?.nonce, NONCE, "the genuine line alone is read");
  assert.equal(
    parseDependencyProbeOutput(`${genuine}\n${forged}\n`, NONCE),
    undefined,
    "and a stream carrying a SECOND report is refused outright — picking one of two reports is a rule an injected " +
      "line only has to be positioned to win, so there is no picking",
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
  const SHARP_ARTIFACT = "/project/node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node";
  const incidental = {
    ...PROBE_REPORT,
    packages: [
      ...PROBE_REPORT.packages,
      { name: "@img/sharp-linux-arm64", version: "0.34.5", artifact: SHARP_ARTIFACT },
    ],
  };
  const sharpFailsToLoad = (artifact: string, stderrPath: string): number => {
    if (artifact !== SHARP_ARTIFACT) return 0;
    writeFileSync(stderrPath, "Error [ERR_DLOPEN_FAILED]: wrong ELF class\n");
    return 1;
  };

  const okCalls: Call[] = [];
  const ok = await invoke({
    agentRole: "review-rechecker",
    task: "recheck RF-1",
    projectDir: makeProject("scoped-ok"),
    readOnlyProject: true,
    dockerExec: makeExec(okCalls, { probeReport: (nonce) => ({ nonce, ...incidental }), load: sharpFailsToLoad }),
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
      probeReport: (nonce) => ({ nonce, ...incidental }),
      load: (artifact, stderrPath) => {
        if (artifact === SHARP_ARTIFACT) return sharpFailsToLoad(artifact, stderrPath);
        writeFileSync(stderrPath, "Error: invalid ELF header\n");
        return 1;
      },
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
  lens_scopes: { backend: ["src/store/"] },
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
/** FG-655: the durable docs-dispatch binding a stubbed `dispatchDocs` must create, exactly as
 *  the real wiring does — the row exists before the dispatch, and the host-minted task
 *  identity is written onto it. The re-entry short-circuit reads this row, so a stub that
 *  returned a binding the store does not hold would be a stub that cannot be re-entered. */
function docsBinding(reviewId: string, candidateSha: string, taskId = "task-docs-1") {
  const opened = openDocsDispatch(reviewId, candidateSha);
  return markDocsDispatchDelivered(opened.id, { taskId });
}

function harness(over: Partial<CoordinatorDeps> = {}): { deps: CoordinatorDeps; calls: { fixer: number } } {
  const calls = { fixer: 0 };
  let head = CANDIDATE;
  const deps: CoordinatorDeps = {
    headSha: () => head,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" }),
    // FG-689 AC2: the rendered path is one CONTRACT's backend scope owns. The old fake named
    // `src/v2/reconcile.ts` against a `src/store/` scope, which nothing compared until the
    // coverage check existed.
    reviewDiff: fakeReviewDiff(["src/store/reconcile.ts"]),
    // FG-689 RF-1: an explicit ZERO dispatch envelope — this harness is not exercising the
    // composed-input reserve, and an ABSENT measurement refuses by design.
    measureLensEnvelope: () => 0,
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
            executed_assertion: "the reconcile path guards a partial write",
          })),
        },
      };
    },
    captureFixWorkspace: () => ({ diffPatch: "", porcelainStatus: "" }),
    dispatchFixRepair: () => ({ ok: false, taskId: "", error: "no repair in this test" }),
    commitFixCycle: ({ declaredFiles }) =>
      declaredFiles.length > 0
        ? { kind: "committed", sha: head, committedPaths: [...declaredFiles] }
        : { kind: "no_change", sha: head },
    // FG-655: the docs stage's seams. This fixture's docs agent declares nothing and leaves
    // a clean tree, so Stage 6 is the legitimate no-op and the candidate stays where the fix
    // cycle left it.
    dispatchDocs: ({ review, candidateSha }) => ({ ok: true, binding: docsBinding(review.id, candidateSha) }),
    docsDelivery: ({ binding }) => ({ kind: "delivered", taskId: binding.taskId ?? "task-docs", docsUpdated: [] }),
    commitDocsCycle: () => ({ kind: "no_change", sha: head }),
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
