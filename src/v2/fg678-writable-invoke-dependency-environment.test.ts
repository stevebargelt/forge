// FG-678, the `forge invoke` half: a WRITABLE dispatch gets its dependency
// environment from the platform, before the container — and an agent that says it
// failed fails.
//
// THE DEFECT THIS PINS. Writable `forge invoke <role> --project <dir>` was the one
// dispatch shape of three with no dependency provisioning at all. It fell to
// spawn.ts's anonymous `-v <containerPath>/node_modules` shadow: a volume with no
// source, which starts EMPTY, MASKS whatever the project bind carries at that path,
// and dies with the container. Two measured consequences. A host-side `npm ci`
// before dispatch could not reach the agent (the shadow masked it —
// `~/code/forge-protocoldrift` was installed on the host and its agent's log still
// carried 22 ERR_MODULE_NOT_FOUND). And whether an agent recovered by
// self-installing was left to the agent: two test-engineer dispatches identical in
// role, model, profile, runtime and workspace diverged, one running `npm ci` and
// validating 3754/3754, the other collecting 1020 ERR_MODULE_NOT_FOUND and
// reporting `status: failed`. Both behaved defensibly. The platform decided
// nothing, so the agent did — that variance is the defect, not the agents.
//
// The second dispatch also exposed the run-level half: it reported its failure
// honestly, and the ingestion seam laundered it into a `complete` task row. The run
// finished looking healthy with the validation never having executed.
//
// WHAT THIS TIER CAN AND CANNOT PROVE. Every container here is an injected fake
// exec — no docker daemon. So this proves the WIRING: which containers are built,
// in which ORDER, what the host records for each outcome, and what it does with the
// agent's own reported status. It cannot prove a real container loads a real native
// module. The darwin gate is faked (Object.defineProperty on process.platform, the
// established pattern in this suite) because the hazard is darwin-only and the unit
// tier runs on linux.
//
// SCOPE. Assertions here are on SpawnContext / manifest / ledger facts. The docker
// VOLUME argv for an rw dispatch is the mount planner's (spawn.ts) and is pinned
// where the planner lives, not here.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { eventsForTask } from "../store/events.js";
import { getRun } from "../store/runs.js";
import { getTask } from "../store/tasks.js";
import { failureKindForTask } from "./failure-kind.js";
import { invoke } from "./invoke.js";
import { lockfileHash } from "./dependency-provisioning.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { readTaskManifest } from "./task-manifest.js";
import { taskDir } from "../util/paths.js";
import type { DockerExecFn } from "./docker-exec.js";

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

function makeTmpDir(prefix = "fg678-"): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-${prefix}`));
  tmpDirs.push(dir);
  return dir;
}

/** A project whose lockfile is unique per call, so every test gets its own cache
 *  key and no test can be made green by another test's ready marker. It DECLARES
 *  a native dependency, because the probe's refusal is scoped to the natives the
 *  project itself declares (declaredDependencyNames). */
function makeProject(lockSalt: string): string {
  const dir = makeTmpDir("fg678-proj-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg678-subject", dependencies: { "better-sqlite3": "^12.11.1" } }),
  );
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, salt: lockSalt }));
  return dir;
}

const RUNTIME_IMAGE = "agent-dev-worker:fg678";

function writeRuntime(): void {
  const runtimeDir = join(forgeHome, "runtimes");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "claude-apikey.yml"),
    `name: claude-apikey
description: FG-678 test runtime stub
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
  stdin: "\${TASK_PACKAGE_MARKDOWN}"
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
  forgeHome = makeTmpDir("fg678-home-");
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
type Call = { kind: Kind; args: string[]; stdin?: string };

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

function envArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-e") out.push(args[i + 1] as string);
  return out;
}

/** The nonce Forge minted for THIS probe, read back off its own argv. The fixture
 *  cannot hard-code one: the resolver mints a fresh value per dispatch and refuses
 *  a report that does not carry it back. */
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
    },
  ],
  missing: [] as string[],
};

/** Records every container this dispatch builds and answers each the way a healthy
 *  host would, unless an override says otherwise. `agentResult` is what the agent
 *  container writes to /task/result.json — the input to the AC3 ingestion seam. */
function makeExec(
  calls: Call[],
  over: {
    provisionerExit?: number;
    probeExit?: number;
    agentResult?: unknown;
  } = {},
): DockerExecFn {
  return async ({ args, stdin, stdoutPath, stderrPath }) => {
    const kind = classifyCall(args);
    calls.push({ kind, args: [...args], ...(stdin !== undefined ? { stdin } : {}) });
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stderrPath, "");
    if (kind === "probe") {
      writeFileSync(stdoutPath, JSON.stringify({ nonce: probeNonce(args), ...PROBE_REPORT }));
      return over.probeExit ?? 0;
    }
    writeFileSync(stdoutPath, "");
    if (kind === "load") return 0;
    if (kind === "provisioner") return over.provisionerExit ?? 0;
    writeFileSync(
      join(dirname(stdoutPath), "result.json"),
      JSON.stringify(over.agentResult ?? { status: "complete", tests_run: 1 }),
    );
    return 0;
  };
}

function packageMarkdown(runId: string, taskId: string): string {
  return readFileSync(join(taskDir(runId, taskId), "package.md"), "utf8");
}

// ── (a) AC1 + AC6: the writable lane resolves BEFORE the container ───────────

test("fg678 (a): a WRITABLE invoke resolves and attests its dependency environment before any agent container, and records the receipt", async () => {
  setPlatform("darwin");
  const project = makeProject("a");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "test-engineer",
    task: "validate the change",
    projectDir: project,
    // readOnlyProject deliberately unset: this is the blue, read-WRITE shape —
    // the one that had no dependency provisioning at all.
    dockerExec: makeExec(calls),
  });

  assert.equal(res.status, "complete", res.error);

  // AC1: the platform established the environment, in its own containers, BEFORE
  // the agent's. The agent never had the opportunity to improvise one.
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["provisioner", "probe", "load", "agent"],
    "the writable lane must provision + attest ahead of the agent, exactly as the read-only lane does",
  );

  // AC6: the dependency identity is answerable from durable state, not from
  // container logs.
  const manifest = readTaskManifest(taskDir(res.runId, res.taskId));
  assert.equal(manifest?.controlPlane?.mountMode, "rw", "this is the read-WRITE shape, recorded as such");
  assert.ok(manifest?.dependencyEnvironment, "a writable dispatch that resolved an environment must record its receipt");
  assert.equal(manifest.dependencyEnvironment.cacheKey, lockfileHash(project), "the receipt is keyed to the lockfile");
  assert.equal(manifest.dependencyEnvironment.abi, "137");
  assert.equal(manifest.dependencyEnvironment.probeImage, RUNTIME_IMAGE);

  // The ledger half of the same fact, and its ORDER: the environment was resolved
  // before the container started, not reconstructed after the fact.
  const types = eventsForTask(res.taskId).map((e) => e.eventType);
  const resolvedAt = types.indexOf("container.dependency_environment_resolved");
  const startedAt = types.indexOf("container.started");
  assert.ok(resolvedAt >= 0, `expected a container.dependency_environment_resolved event; got ${types.join(", ")}`);
  assert.ok(startedAt >= 0 && resolvedAt < startedAt, "the resolution must be recorded BEFORE the agent container starts");

  const resolvedPayload = eventsForTask(res.taskId).find(
    (e) => e.eventType === "container.dependency_environment_resolved",
  )!.payload as Record<string, unknown>;
  assert.equal(resolvedPayload["stage"], "environment_resolution");
  assert.equal(resolvedPayload["cacheKey"], lockfileHash(project));

  // AC5's half that is visible from here: giving the WRITABLE lane an environment
  // must not hand the agent the writer's role. Only the Forge-owned provisioner
  // carries the install contract; the agent container never does, on any lane.
  // (The volume argv itself is the mount planner's to pin, not this file's.)
  const agent = calls.find((c) => c.kind === "agent")!;
  assert.ok(
    !envArgs(agent.args).some((e) => e.startsWith("FORGE_NM_INSTALL_ROOT=")),
    "installing is the provisioner's job alone — an agent container must never carry FORGE_NM_INSTALL_ROOT",
  );
  assert.equal(
    calls.filter((c) => c.kind === "provisioner").length,
    1,
    "exactly one Forge-owned provisioner ran, and the agent is not it",
  );
  assert.ok(
    envArgs(calls.find((c) => c.kind === "provisioner")!.args).includes("FORGE_NM_INSTALL_ROOT=/project"),
    "the provisioner — and only it — is the container told to install",
  );
});

test("fg678 (a2): the agent is TOLD its dependency environment is bound and immutable — it does not have to discover it", async () => {
  setPlatform("darwin");
  const project = makeProject("a2");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "test-engineer",
    task: "validate the change",
    projectDir: project,
    dockerExec: makeExec(calls),
  });
  assert.equal(res.status, "complete", res.error);

  // The stated contract is what makes "the agent adds a dependency" a refusal it
  // was warned about rather than an EROFS discovered mid-task.
  const pkg = packageMarkdown(res.runId, res.taskId);
  assert.match(pkg, /## Dependency environment/);
  assert.match(pkg, /IMMUTABLE/);
  assert.match(pkg, /npm ci/, "the contract must name the install the agent would otherwise reach for");
  assert.ok(pkg.includes(lockfileHash(project)), "the agent is told WHICH environment it was given");

  // /task/package.md and the TASK_PACKAGE_MARKDOWN piped to the runtime are ONE
  // string. The receipt only exists after the package dir was already
  // materialized, so both copies have to be re-rendered from it — the agent must
  // not be able to read two different contracts depending on where it looks.
  const agent = calls.find((c) => c.kind === "agent")!;
  assert.equal(agent.stdin, pkg, "the delivered task package and /task/package.md must be byte-identical");
});

// ── (b) AC2: fail-closed — no container into an unusable workspace ───────────

test("fg678 (b): a writable dispatch whose environment cannot be established starts NO agent container and fails verification_environment_unavailable", async () => {
  const cases: Array<{ label: string; over: { provisionerExit?: number; probeExit?: number }; reason: string }> = [
    { label: "the provisioner failed", over: { provisionerExit: 1 }, reason: "provisioning_failed" },
    { label: "the probe failed", over: { probeExit: 1 }, reason: "probe_failed" },
  ];

  for (const c of cases) {
    setPlatform("darwin");
    const project = makeProject(`b-${c.reason}`);
    const calls: Call[] = [];

    const res = await invoke({
      agentRole: "test-engineer",
      task: "validate the change",
      projectDir: project,
      dockerExec: makeExec(calls, c.over),
    });

    assert.equal(res.status, "failed", `${c.label}: the dispatch must be refused`);
    assert.equal(
      calls.filter((k) => k.kind === "agent").length,
      0,
      `${c.label}: no agent container may run into a workspace whose dependencies were never established`,
    );
    assert.equal(getTask(res.taskId)?.status, "failed", `${c.label}: the task row is failed`);
    assert.equal(
      failureKindForTask(res.taskId),
      "verification_environment_unavailable",
      `${c.label}: the EXISTING kind carries this — no new task-plane vocabulary`,
    );
    assert.equal(res.failureKind, "verification_environment_unavailable");

    const event = eventsForTask(res.taskId).find((e) => e.eventType === "container.dependency_provisioning_failed");
    assert.ok(event, `${c.label}: the refusal is durable on the timeline`);
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload["stage"], "environment_resolution", `${c.label}: the refusal's grain is named`);
    assert.equal(payload["reason"], c.reason, `${c.label}: the classified reason reaches the ledger`);

    // Why a manifest exists for a task no container ever ran for.
    const manifest = readTaskManifest(taskDir(res.runId, res.taskId));
    assert.equal(manifest?.dispatchRefused?.stage, "dependency_environment");
    assert.equal(manifest?.dispatchRefused?.reason, c.reason);
    assert.equal(
      manifest?.dependencyEnvironment,
      undefined,
      `${c.label}: a refused dispatch received no environment, so it claims none`,
    );

    // The refusal message must speak to this lane, not only to read-only reviewers.
    assert.match(res.error!, /writable/i, `${c.label}: the widened message must cover the writable dispatch`);
  }
});

// ── (c) the not-applicable configurations are unchanged ─────────────────────

test("fg678 (c): non-darwin and FORGE_NO_NM_SHADOW=1 writable dispatches build exactly one container, record no receipt, and are told nothing about deps", async () => {
  const cases: Array<{ label: string; platform: string; noShadow?: boolean }> = [
    { label: "linux host", platform: "linux" },
    { label: "FORGE_NO_NM_SHADOW=1", platform: "darwin", noShadow: true },
  ];

  for (const c of cases) {
    setPlatform(c.platform);
    if (c.noShadow) process.env.FORGE_NO_NM_SHADOW = "1";
    else delete process.env.FORGE_NO_NM_SHADOW;

    const project = makeProject(`c-${c.label}`);
    const calls: Call[] = [];

    const res = await invoke({
      agentRole: "engineer",
      task: "do the work",
      projectDir: project,
      dockerExec: makeExec(calls),
    });

    assert.equal(res.status, "complete", `${c.label}: an escape hatch must never refuse (${res.error})`);
    assert.deepEqual(
      calls.map((k) => k.kind),
      ["agent"],
      `${c.label}: the pre-existing behaviour is exactly one agent container and nothing else`,
    );
    assert.equal(
      readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment,
      undefined,
      `${c.label}: nothing was attested, so no receipt may be recorded`,
    );
    assert.equal(
      eventsForTask(res.taskId).filter((e) => e.eventType === "container.dependency_environment_resolved").length,
      0,
      `${c.label}: nothing was attested, so nothing may claim an engine on the timeline`,
    );
    // A dispatch with no bound environment says NOTHING about the workspace's
    // dependencies. Claiming one either way would be the falsehood.
    assert.doesNotMatch(
      packageMarkdown(res.runId, res.taskId),
      /## Dependency environment/,
      `${c.label}: no environment was bound, so no contract may be stated about one`,
    );
  }
});

// ── (d) AC4: identical dispatches bind the identical environment ────────────

test("fg678 (d): two identical writable dispatches against the same workspace and lockfile record the SAME cacheKey", async () => {
  setPlatform("darwin");
  const project = makeProject("d");

  const first = await invoke({
    agentRole: "test-engineer",
    task: "validate the change",
    projectDir: project,
    dockerExec: makeExec([]),
  });
  const second = await invoke({
    agentRole: "test-engineer",
    task: "validate the change",
    projectDir: project,
    dockerExec: makeExec([]),
  });

  assert.equal(first.status, "complete", first.error);
  assert.equal(second.status, "complete", second.error);

  const a = readTaskManifest(taskDir(first.runId, first.taskId))?.dependencyEnvironment;
  const b = readTaskManifest(taskDir(second.runId, second.taskId))?.dependencyEnvironment;
  assert.ok(a && b, "both dispatches must record a receipt");
  assert.equal(a.cacheKey, b.cacheKey, "same workspace, same lockfile → same environment, deterministically");
  assert.equal(a.cacheKey, lockfileHash(project), "and the key is the lockfile's, answerable host-side");
});

// ── (e) AC3: a self-declared failure is not laundered into a complete row ────

test("fg678 (e): an agent result declaring status:failed lands a FAILED task row with failure kind agent_reported_failure", async () => {
  const project = makeProject("e");
  const calls: Call[] = [];

  const res = await invoke({
    agentRole: "test-engineer",
    task: "validate the change",
    projectDir: project,
    dockerExec: makeExec(calls, {
      // The FG-673 shape, verbatim in spirit: the required validation could not
      // execute, and the agent said so instead of faking a pass.
      agentResult: {
        status: "failed",
        error: "Validation is blocked by absent declared dependencies in the mounted /project workspace",
        tests_run: 0,
      },
    }),
  });

  assert.equal(res.status, "failed", "invoke must report the agent's own verdict, not a laundered success");
  assert.equal(res.failureKind, "agent_reported_failure");
  assert.equal(getTask(res.taskId)?.status, "failed", "the TASK ROW is what an operator reads; it must say failed");
  assert.equal(failureKindForTask(res.taskId), "agent_reported_failure");

  // The agent's own stated reason survives onto the task, and the result is kept.
  assert.match(res.error!, /Validation is blocked by absent declared dependencies/);
  assert.equal((getTask(res.taskId)?.result as { tests_run?: number } | undefined)?.tests_run, 0);

  // The defect was a `complete` row for work that never happened. No completion
  // event may be emitted for it.
  const types = eventsForTask(res.taskId).map((e) => e.eventType);
  assert.equal(types.includes("task.completed"), false, "a self-declared failure must emit no task.completed");
  assert.equal(types.includes("task.failed"), true);

  // FG-585: the owned run settles from its task, so the run reads failed too —
  // the run-level half of "the failure is visible at the run level".
  assert.equal(getRun(res.runId)?.status, "failed");
});

test("fg678 (e2): the agent's declared failure wins over the #254 persistence assertion — its own reason is not replaced", async () => {
  const project = makeProject("e2");

  // An agent that failed partway may well name files it never landed. Reporting
  // that as "the work was discarded" would bury the reason the agent actually gave.
  const res = await invoke({
    agentRole: "engineer",
    task: "do the work",
    projectDir: project,
    dockerExec: makeExec([], {
      agentResult: { status: "failed", error: "the API contract could not be resolved", files_modified: ["src/never-landed.ts"] },
    }),
  });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "agent_reported_failure", "not work_not_persisted");
  assert.match(res.error!, /the API contract could not be resolved/);
});

test("fg678 (e3): results that do NOT declare failure are untouched — complete stays complete", async () => {
  const cases: Array<{ label: string; result: unknown }> = [
    { label: "status: complete", result: { status: "complete", tests_run: 12 } },
    { label: "no status field at all", result: { summary: "narrative output", findings: [] } },
    // A red's Verdict shape: `verdict` carries the review outcome; `status`
    // still reports whether the RED itself ran. A blocking verdict is not a
    // failed dispatch and must not be turned into one.
    { label: "a red's blocking verdict", result: { status: "complete", verdict: "fail", confidence: "high", findings: [{ id: "RF-1" }] } },
    { label: "a non-object result", result: ["not", "an", "object"] },
    { label: "status: partial", result: { status: "partial" } },
  ];

  for (const c of cases) {
    const project = makeProject(`e3-${c.label}`);
    const res = await invoke({
      agentRole: "engineer",
      task: "do the work",
      projectDir: project,
      dockerExec: makeExec([], { agentResult: c.result }),
    });
    assert.equal(res.status, "complete", `${c.label}: must be unaffected by the AC3 seam (${res.error})`);
    assert.equal(getTask(res.taskId)?.status, "complete", `${c.label}: the task row completes`);
    assert.equal(
      eventsForTask(res.taskId).some((e) => e.eventType === "task.completed"),
      true,
      `${c.label}: task.completed is still emitted`,
    );
  }
});

test("fg678 (e4): the declared-failure seam is bounded — it reads `status` only, and does not gate on tests_run (BD-4)", async () => {
  // FG-524/FG-525 stay undecided: an ad-hoc invoke completion is NOT gated on
  // validation evidence by this ticket. An implementer role reporting complete
  // with zero tests still completes here; only a self-declared FAILURE fails.
  const project = makeProject("e4");
  const res = await invoke({
    agentRole: "test-engineer",
    task: "validate the change",
    projectDir: project,
    dockerExec: makeExec([], { agentResult: { status: "complete", tests_run: 0 } }),
  });

  assert.equal(res.status, "complete", "the validation contract is not widened here");
  assert.equal(getTask(res.taskId)?.status, "complete");
});
