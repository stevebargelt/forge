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
import { isWorktreeModeEnabled } from "./worktree-lifecycle.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { listRuns } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";

let projectDir: string;
let stderr: string[];
const savedEnv = { ...process.env };

/** Captured before any case can spoof it — restoring from process.platform in
 *  afterEach would read the spoof and leak it into every later test. */
const REAL_PLATFORM = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

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
  // FG-345: isolation is default-ON, so "unset" no longer means off — these cases
  // mean isolation is NOT armed, and must say so explicitly.
  process.env["FORGE_WORKTREES"] = "0";
  delete process.env["FORGE_NO_WORKTREES"];
  _resetSelfHostWarnings();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  mock.restoreAll();
  process.env = { ...savedEnv };
  setPlatform(REAL_PLATFORM);
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

// EXPECTATION CHANGE (was: "FORGE_WORKTREES=1 lets the same self-host dispatch
// through"). Arming the flag never isolated an invoke — invoke.ts provisions no
// workspace and mounts args.projectDir either way — so letting it through was the
// FG-612 hazard reached by a flag that did nothing. The flag is no longer a way
// through on this path; FORGE_NO_WORKTREES=1 (below) still is.
test("FORGE_WORKTREES=1 does NOT let a self-host invoke through — arming the flag isolates nothing here", async () => {
  setupRuntimeStub();
  process.env["FORGE_WORKTREES"] = "1";
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  await assert.rejects(
    () => invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: forgeSourceRoot(), dockerExec: stubExec() }),
    /REFUSING to dispatch/
  );
});

// The regression FG-345's default-on introduced: on a host where isolation is
// the platform default, the guard used to read "the default is on" as "this
// dispatch is isolated" and permit an invoke onto the live checkout.
test("with isolation ON by default and no env set, a self-host invoke still refuses and writes no run row", async () => {
  setupRuntimeStub();
  delete process.env["FORGE_WORKTREES"];
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  setPlatform("darwin");
  assert.equal(isWorktreeModeEnabled(), true, "fixture: the FG-345 default-on host");
  const runsBefore = listRuns().length;

  await assert.rejects(
    () => invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: forgeSourceRoot(), dockerExec: stubExec() }),
    /provisions no isolated workspace/
  );

  assert.equal(listRuns().length, runsBefore, "the refusal must still land before the run row");
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
    process.env["FORGE_WORKTREES"] = "0"; // FG-345: the empty combo means isolation OFF, not "unset"
    delete process.env["FORGE_NO_WORKTREES"];
    Object.assign(process.env, combo);
    stderr = [];

    const r = await invoke({ agentRole: "engineer", task: "normal work", projectDir, dockerExec: stubExec() });

    assert.equal(r.status, "complete", `dispatch should succeed for ${JSON.stringify(combo)}`);
    assert.doesNotMatch(stderr.join(""), /REFUSING|live forge source/, `no FG-612 output for ${JSON.stringify(combo)}`);
  }
});

test("an ordinary project invoke is unaffected on that same default-on host", async () => {
  setupRuntimeStub();
  delete process.env["FORGE_WORKTREES"];
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  setPlatform("darwin");

  const r = await invoke({ agentRole: "engineer", task: "normal work", projectDir, dockerExec: stubExec() });

  assert.equal(r.status, "complete");
  assert.doesNotMatch(stderr.join(""), /REFUSING|live forge source/);
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

// The isolation argument is the whole fix: a refactor that hands the invoke sites
// anything but the literal, or the workflow sites a hardcoded answer instead of
// the live worktree mode, reopens FG-612 without a behavioral test necessarily
// covering that particular site.
test("each dispatch site tells the guard what IT provisions", () => {
  const invokeSrc = readFileSync(join(SRC, "v2", "invoke.ts"), "utf8");
  const neverIsolated = invokeSrc.match(/assertSelfHostDispatchAllowed\(args\.projectDir, "never-isolated"\)/g) ?? [];
  assert.equal(neverIsolated.length, 2, "both invoke sites must report that they provision no workspace");

  for (const [rel, expected] of [
    ["v2/runNext.ts", 3],
    ["cli/commands/new.ts", 1],
  ] as const) {
    const src = readFileSync(join(SRC, rel), "utf8");
    const passthrough =
      src.match(/assertSelfHostDispatchAllowed\([^,]+, isWorktreeModeEnabled\(\) \? "isolated" : "not-armed"\)/g) ?? [];
    assert.equal(passthrough.length, expected, `${rel} must pass live worktree mode through at every site`);
  }
});

test("runContainer's guard precedes the dependency-provisioner container spawn", () => {
  const src = readFileSync(join(SRC, "v2", "runNext.ts"), "utf8");
  const runContainerAt = src.indexOf("async function runContainer(");
  const guardAt = src.indexOf("assertSelfHostDispatchAllowed(", runContainerAt);
  // FG-678: runNext no longer builds the provisioner argv itself — every lane
  // reaches the provisioner (and the probe/load containers) through the shared
  // resolver, so THAT call is the first thing in runContainer that can start a
  // container of any kind. Same property, moved anchor.
  const provisionerAt = src.indexOf("prepareDependencyEnvironmentForDispatch(", runContainerAt);

  assert.ok(runContainerAt > 0 && guardAt > 0 && provisionerAt > 0);
  assert.ok(guardAt < provisionerAt, "the refusal must land before ANY container starts, provisioner included");
});
