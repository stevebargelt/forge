// FG-612: the guard is wired into the real dispatch entry points, not just
// available as a helper. The refusal must land BEFORE the run and task rows
// exist — after the first file is written the damage is already done.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invoke, type DockerExecFn } from "./invoke.js";
import { forgeSourceRoot, _resetSelfHostWarnings } from "./self-host-guard.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { listRuns } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";

let projectDir: string;
let stderr: string[];
const savedEnv = { ...process.env };

function stubExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function setupRuntimeStub(): void {
  const fhome = process.env["FORGE_HOME"]!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      `
name: claude
description: test stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`
    );
  }
  publishFlatAsGeneration(fhome);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg612-proj-"));
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  stderr = [];
  mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  delete process.env["FORGE_WORKTREES"];
  delete process.env["FORGE_NO_WORKTREES"];
  _resetSelfHostWarnings();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  mock.restoreAll();
  process.env = { ...savedEnv };
});

// The negative path — the point of the ticket.
test("invoke against the live forge source with worktree mode off refuses, and writes no run or task row", async () => {
  const runsBefore = listRuns().length;

  await assert.rejects(
    () => invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: forgeSourceRoot(), dockerExec: stubExec() }),
    /REFUSING to dispatch/
  );

  assert.equal(listRuns().length, runsBefore, "refusal must land before the run row is created");
});

test("the refusal fires for a read-only red too — the write risk is the shared mount, not the role", async () => {
  await assert.rejects(
    () => invoke({ agentRole: "red-wide", task: "audit", projectDir: forgeSourceRoot(), readOnlyProject: true, dockerExec: stubExec() }),
    /REFUSING to dispatch/
  );
});

test("FORGE_WORKTREES=1 lets the same self-host dispatch through", async () => {
  setupRuntimeStub();
  process.env["FORGE_WORKTREES"] = "1";
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  const r = await invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: forgeSourceRoot(), dockerExec: stubExec() });

  assert.equal(r.status, "complete");
  assert.equal(tasksForRun(r.runId).length, 1);
});

test("FORGE_NO_WORKTREES=1 lets it through and warns that agents are writing to the live forge source", async () => {
  setupRuntimeStub();
  process.env["FORGE_NO_WORKTREES"] = "1";
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  const r = await invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: forgeSourceRoot(), dockerExec: stubExec() });

  assert.equal(r.status, "complete");
  assert.match(stderr.join(""), /WARNING.*live forge source/s);
});

// The regression that matters most: normal projects behave exactly as before.
test("a normal project dispatches unaffected in every env combination, with no new warning", async () => {
  setupRuntimeStub();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  const combos = [
    {},
    { FORGE_WORKTREES: "1" },
    { FORGE_NO_WORKTREES: "1" },
    { FORGE_WORKTREES: "1", FORGE_NO_WORKTREES: "1" },
  ];

  for (const combo of combos) {
    delete process.env["FORGE_WORKTREES"];
    delete process.env["FORGE_NO_WORKTREES"];
    Object.assign(process.env, combo);
    stderr = [];

    const r = await invoke({ agentRole: "engineer", task: "normal work", projectDir, dockerExec: stubExec() });

    assert.equal(r.status, "complete", `dispatch should succeed for ${JSON.stringify(combo)}`);
    assert.doesNotMatch(stderr.join(""), /REFUSING|live forge source/, `no FG-612 output for ${JSON.stringify(combo)}`);
  }
});

// The `forge next` chokepoints are only reachable behind a full run + container
// dispatch (integration tier), so their WIRING is asserted structurally here.
// This does not prove the refusal behaves correctly on that path — the guard's
// behavior is proven above and in self-host-guard.test.ts — it proves the call
// sites cannot be dropped by a refactor without a test going red.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

test("every dispatch chokepoint calls the guard", () => {
  for (const [rel, expected] of [
    ["v2/runNext.ts", 3],   // dispatchSingleStep, dispatchFanoutStep, runContainer
    ["v2/invoke.ts", 2],    // invoke(), dispatchInvokeTask() (the `forge retry` entry)
    ["cli/commands/new.ts", 1],
  ] as const) {
    const src = readFileSync(join(SRC, rel), "utf8");
    const calls = src.match(/assertSelfHostDispatchAllowed\(/g) ?? [];
    assert.equal(calls.length, expected, `${rel} should guard ${expected} dispatch site(s)`);
  }
});

test("runContainer's guard precedes the dependency-provisioner container spawn", () => {
  const src = readFileSync(join(SRC, "v2", "runNext.ts"), "utf8");
  const runContainerAt = src.indexOf("async function runContainer(");
  const guardAt = src.indexOf("assertSelfHostDispatchAllowed(", runContainerAt);
  const provisionerAt = src.indexOf("buildProvisionerDockerArgs(", runContainerAt);

  assert.ok(runContainerAt > 0 && guardAt > 0 && provisionerAt > 0);
  assert.ok(guardAt < provisionerAt, "the refusal must land before ANY container starts, provisioner included");
});
