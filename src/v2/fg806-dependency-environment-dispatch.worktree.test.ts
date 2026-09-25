// FG-806: exercise the real pipeline dispatch seam.  render-level parity is
// covered separately; this proves runContainer replaces the early package.md
// with the receipt-aware version it actually mounts for the agent.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import { answerDependencyLoad, answerDependencyProbe } from "./dependency-probe.testkit.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { startRun } from "./startRun.js";

const RUNTIME = "fg806-dispatch";
const WORKFLOW: Workflow = {
  name: RUNTIME,
  description: "FG-806 package materialization fixture",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [{ id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] }],
};

let db: DatabaseInstance;
let priorDb: DatabaseInstance | null;
const tempDirs: string[] = [];
const realPlatform = process.platform;
const envVars = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES", "FORGE_NO_NM_SHADOW", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof envVars)[number], string>> = {};

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg806-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeProject(withDependencies: boolean): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(withDependencies ? { name: "fg806", dependencies: { "better-sqlite3": "^12.11.1" } } : { name: "fg806" }),
  );
  if (withDependencies) writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, salt: "fg806" }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

function writeDispatchFixtures(): void {
  const home = process.env.FORGE_HOME!;
  const runtimePath = join(home, "runtimes", `${RUNTIME}.yml`);
  const workflowPath = join(home, "workflows", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-806 runtime fixture
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
result:
  file: /task/result.json
`,
  );
  writeFileSync(
    workflowPath,
    `name: ${RUNTIME}
description: FG-806 workflow fixture
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${RUNTIME}
`,
  );
  publishFlatAsGeneration(home);
}

function containerName(args: string[]): string {
  const index = args.indexOf("--name");
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

function exec(): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stderrPath, "");
    const name = containerName(args);
    if (name.startsWith("forge-depprobe-")) return answerDependencyProbe(args, stdoutPath);
    if (name.startsWith("forge-depload-")) return answerDependencyLoad(args);
    writeFileSync(stdoutPath, "stub");
    if (!name.startsWith("forge-provision-")) {
      writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    }
    return 0;
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  priorDb = setDbForTest(db);
  for (const key of envVars) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  process.env.FORGE_WORKTREES = "0";
  process.env.FORGE_NO_WORKTREES = "1";
  writeDispatchFixtures();
});

afterEach(() => {
  setDbForTest(priorDb as DatabaseInstance);
  db.close();
  setPlatform(realPlatform);
  for (const key of envVars) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function dispatchPackage(withDependencies: boolean, platform: "darwin" | "linux"): Promise<string> {
  setPlatform(platform);
  const { runId } = startRun({ workflow: WORKFLOW, title: `fg806-${platform}`, inputs: {}, projectDir: makeProject(withDependencies) });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec() });
  const task = tasksForRun(runId)[0]!;
  return readFileSync(join(taskDir(runId, task.id), "package.md"), "utf8");
}

test("fg806: a ready pipeline dependency outcome reaches the mounted package.md", async () => {
  const packageMarkdown = await dispatchPackage(true, "darwin");
  assert.match(packageMarkdown, /## Dependency environment/);
  assert.match(packageMarkdown, /mounted read-only over the project's node_modules/);
});

test("fg806: a not_applicable pipeline dependency outcome leaves package.md without the section", async () => {
  const packageMarkdown = await dispatchPackage(false, "linux");
  assert.doesNotMatch(packageMarkdown, /## Dependency environment/);
});
