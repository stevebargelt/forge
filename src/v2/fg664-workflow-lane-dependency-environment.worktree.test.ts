// FG-664: THE WORKFLOW LANE RESOLVES THE SAME DEPENDENCY ENVIRONMENT AS `forge invoke`.
//
// THE DEFECT THIS PINS. FG-664's first cut put the host-side attestation and the
// fail-closed refusal on the `forge invoke` path only, and left runNext's
// read-only arm as it was — mount the cache if a ready key happened to exist,
// otherwise start the red with NO dependency mount at all. On darwin that means
// the red reads the HOST's darwin-arm64 `node_modules` through the `/project:ro`
// bind and cannot dlopen the project's real driver: the exact condition that
// produced FG-662's three false "still present" verdicts. Fixing one lane leaves
// every pipeline-dispatched red — including the reds that review FG-664 itself —
// able to start in a substituted environment. Worse, spawn.ts's own comment
// claimed BOTH paths called the resolver while one did not.
//
// So: same resolver, same refusal, same receipt, reached from runNext.
//
// WHAT THIS TIER CAN PROVE. Every container is an injected fake exec, so this
// proves the WIRING — which containers are built in which order, and what the
// host does with each outcome. Whether a real container can load a real driver is
// scripts/fg664-reviewer-engine-smoke.sh's job, and whether the shipped probe
// script answers correctly is fg664-dependency-probe.integration.test.ts's.
//
// The darwin gate is faked (the established pattern in this suite) because the
// hazard is darwin-only and the tier runs on linux.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { eventsForRun } from "../store/events.js";
import { tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { failureKindForTask } from "./failure-kind.js";
import { dependencyVolumeName, isDependencyCacheReady, lockfileHash } from "./dependency-provisioning.js";
import { readTaskManifest } from "./task-manifest.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { answerDependencyProbe, isDependencyProbeCall } from "./dependency-probe.testkit.js";

const RUNTIME = "fg664-lane-test";

const WORKFLOW: Workflow = {
  name: RUNTIME,
  description: "FG-664: the workflow lane's read-only red resolves its dependency environment",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: RUNTIME,
      reds: [{ agent: "red-narrow", authority: "specialist", gate_on_verdict: false }],
    },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const REAL_PLATFORM = process.platform;

const ENV_VARS = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES", "FORGE_NO_NM_SHADOW", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  // Non-isolated dispatch: the primary is rw against the checkout, the red is ro
  // against the same tree. That is the shape the pipeline reds actually take.
  process.env.FORGE_NO_WORKTREES = "1";
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
    } catch {
      /* best-effort */
    }
  }
});

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg664-lane-"));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repo with a UNIQUE lockfile (so every case gets its own, COLD cache key —
 *  the state the old arm silently started a red in) that DECLARES the native
 *  driver, so the driver is load-bearing for the refusal. */
function makeRepo(salt: string): string {
  const dir = makeTmpDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg664-lane", private: true, dependencies: { "better-sqlite3": "^12.11.1" } }),
  );
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, salt }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-664 workflow-lane test runtime stub
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
  const wfPath = join(process.env.FORGE_HOME!, "workflows", `${RUNTIME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${RUNTIME}
description: "FG-664: the workflow lane resolves its dependency environment"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${RUNTIME}
    reds:
      - agent: red-narrow
        authority: specialist
        gate_on_verdict: false
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

type Kind = "provisioner" | "probe" | "agent";
type Call = { kind: Kind; taskId: string; args: string[] };

function containerName(args: string[]): string {
  const i = args.indexOf("--name");
  return i >= 0 ? (args[i + 1] ?? "") : "";
}

function classify(args: string[]): Kind {
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

const PASS_VERDICT = { status: "complete", tests_run: 1, verdict: "pass", confidence: 1, findings: [] };

function makeExec(
  calls: Call[],
  over: { probe?: (args: string[], stdoutPath: string) => number; provisionerExit?: number } = {},
): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const kind = classify(args);
    calls.push({ kind, taskId: containerName(args).replace(/^forge-/, ""), args: [...args] });
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stderrPath, "");
    if (kind === "probe") {
      return over.probe ? over.probe(args, stdoutPath) : answerDependencyProbe(args, stdoutPath);
    }
    writeFileSync(stdoutPath, "stub stdout");
    if (kind === "provisioner") return over.provisionerExit ?? 0;
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(containerName(args).includes("red") ? PASS_VERDICT : { status: "complete", tests_run: 1, files_modified: [] }),
    );
    return 0;
  };
}

function redTask(runId: string) {
  return tasksForRun(runId).find((t) => t.agentRole.startsWith("red-"));
}

test("FG-664: a workflow red on a COLD cache key provisions, probes and mounts the real dependencies — it no longer starts unmounted", async () => {
  setPlatform("darwin");
  const repo = makeRepo("lane-cold");
  const hash = lockfileHash(repo);
  assert.equal(isDependencyCacheReady(hash), false, "the fixture must start COLD — that is the state the old arm shipped a red in");

  const calls: Call[] = [];
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg664 lane cold", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: makeExec(calls) });

  const red = redTask(runId);
  assert.ok(red, "the reviewer task must exist");
  assert.equal(red.status, "complete", `the red must run once its environment is attested (${red.error})`);

  // The lane ran Forge's OWN two containers before the reviewer's, in that order.
  assert.deepEqual(
    calls.filter((c) => c.kind !== "agent").map((c) => c.kind),
    ["provisioner", "probe"],
    `expected exactly one provisioner and one probe; got ${JSON.stringify(calls.map((c) => c.kind))}`,
  );
  assert.ok(
    calls.findIndex((c) => c.kind === "probe") < calls.findIndex((c) => c.taskId === red.id),
    "the probe must precede the reviewer container it attests for",
  );

  // The reviewer got the real dependencies, read-only, with /project still :ro.
  const redCall = calls.find((c) => c.taskId === red.id);
  assert.ok(redCall, "the reviewer container must have been built");
  const volumes = volumeArgs(redCall.args);
  assert.ok(
    volumes.includes(`${dependencyVolumeName(hash, "")}:/project/node_modules:ro`),
    `the reviewer must mount the lockfile-keyed dependency volume READ-ONLY; got ${volumes.join(" ")}`,
  );
  assert.ok(volumes.includes(`${repo}:/project:ro`), `/project must stay bound :ro; got ${volumes.join(" ")}`);

  // AC3: the engine identity is recorded on the workflow lane's manifest too.
  const receipt = readTaskManifest(taskDir(runId, red.id))?.dependencyEnvironment;
  assert.ok(receipt, "the workflow lane must record its attested environment, exactly as invoke does");
  assert.equal(receipt.cacheKey, hash);
  assert.equal(receipt.abi, process.versions.modules);
  assert.deepEqual(receipt.packages.map((p) => p.name), ["better-sqlite3"]);
});

test("FG-664: a workflow red whose probe says the real driver will not load is REFUSED — no reviewer container, verification_environment_unavailable", async () => {
  setPlatform("darwin");
  const repo = makeRepo("lane-unloadable");

  const calls: Call[] = [];
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg664 lane unloadable", inputs: {}, projectDir: repo });
  await runNext({
    runId,
    workflow: WORKFLOW,
    dockerExec: makeExec(calls, {
      probe: (args, stdoutPath) =>
        answerDependencyProbe(args, stdoutPath, {
          packages: [
            {
              name: "better-sqlite3",
              version: "12.11.1",
              loaded: false,
              error: "invalid ELF header",
            },
          ],
        }),
    }),
  });

  const red = redTask(runId);
  assert.ok(red);
  assert.equal(red.status, "failed");
  assert.equal(failureKindForTask(red.id), "verification_environment_unavailable");
  assert.match(String(red.error), /driver_unloadable/);
  assert.match(String(red.error), /better-sqlite3/);

  assert.equal(
    calls.filter((c) => c.taskId === red.id).length,
    0,
    "no reviewer container may start once the host knows the real driver will not load",
  );
  const refusal = eventsForRun(runId).filter(
    (e) =>
      e.eventType === "container.dependency_provisioning_failed" &&
      (e.payload as { stage?: string }).stage === "environment_resolution",
  );
  assert.equal(refusal.length, 1, "the refusal is recorded with the same event and grain the invoke lane uses");
  assert.equal(refusal[0]!.taskId, red.id);
});

test("FG-664: a workflow red whose provisioner FAILS is refused, leaves no ready marker, and never reaches the probe", async () => {
  setPlatform("darwin");
  const repo = makeRepo("lane-provision-fail");

  const calls: Call[] = [];
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg664 lane provision fail", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: makeExec(calls, { provisionerExit: 123 }) });

  const red = redTask(runId);
  assert.ok(red);
  assert.equal(failureKindForTask(red.id), "verification_environment_unavailable");
  assert.match(String(red.error), /provisioning_failed/);
  assert.equal(isDependencyCacheReady(lockfileHash(repo)), false, "FG-376: a failed provision leaves no ready marker");
  assert.equal(calls.filter((c) => c.kind === "probe").length, 0, "no probe runs against a cache that never installed");
  assert.equal(calls.filter((c) => c.taskId === red.id).length, 0);
});

test("FG-664: the workflow lane is untouched off the hazard — a non-darwin host builds neither extra container and refuses nothing", async () => {
  setPlatform("linux");
  const repo = makeRepo("lane-linux");

  const calls: Call[] = [];
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg664 lane linux", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: makeExec(calls) });

  const red = redTask(runId);
  assert.ok(red);
  assert.equal(red.status, "complete", red.error);
  assert.deepEqual(calls.map((c) => c.kind), ["agent", "agent"], "primary + red, and nothing else");
  assert.equal(readTaskManifest(taskDir(runId, red.id))?.dependencyEnvironment, undefined);
});
