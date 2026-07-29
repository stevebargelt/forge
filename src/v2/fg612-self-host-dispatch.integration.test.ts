// FG-612: the forge-on-forge dispatch guard, exercised over the REAL dispatch
// machinery — real store, real invoke / runNext / retry / review-loop wiring —
// with only the container-exec boundary stubbed.
//
// self-host-guard.test.ts proves the PREDICATE against a fixture source root.
// This file proves the wired system: that the refusal actually reaches every
// dispatch entry point against the live forge checkout this process is running
// from, and — the load-bearing property — that a refused dispatch leaves NOTHING
// behind. No container, no run row, no task row, no task dir. After the first
// agent file lands, the damage the guard exists to prevent has already happened,
// so absence-of-state IS the assertion, not the exit code.
//
// The container boundary is a COUNTING stub: `calls()` is how "pre-container" is
// asserted on the refusal paths, and how "actually reached dispatch" (rather than
// merely "did not refuse early") is asserted on the two ways through.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { listRuns } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { RUNS_DIR, taskDir } from "../util/paths.js";
import { invoke, createInvokeRun, type DockerExecFn } from "./invoke.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { retry, dispatchRetriedAdHocTask } from "./retry.js";
import { forgeSourceRoot, isSelfHostDispatch, _resetSelfHostWarnings } from "./self-host-guard.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { registerNew } from "../cli/commands/new.js";
import { buildReviewLoopDeps } from "../cli/commands/review-loop.js";
import { performCancel } from "../cli/commands/cancel.js";
import type { Finding } from "./review-loop.js";
import type { Workflow } from "./schema.js";
import type { Task } from "../types/index.js";

// The tree THIS test process is executing from — the real thing the guard
// compares against, not a fixture. Every self-host assertion below is anchored
// here rather than on an injected sourceRoot, because an integration test whose
// source root is a fixture proves nothing about the wiring.
const SELF_HOST = forgeSourceRoot();
const RUNTIME = "fg612-selfhost-test";

const WORKFLOW: Workflow = {
  name: RUNTIME,
  description: "FG-612 self-host dispatch guard integration fixture",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let stderr: string[];
const tmpDirs: string[] = [];

const ENV_KEYS = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES", "ANTHROPIC_API_KEY", "FORGE_ROUTE_PREFLIGHT"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

/** The container boundary, counted. Writes the same result.json shape the real
 *  exec would, so a dispatch that DOES reach it completes end to end. */
function spyExec(result: unknown = { status: "complete", tests_run: 1 }): { exec: DockerExecFn; calls: () => number } {
  let n = 0;
  const exec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    n++;
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
  return { exec, calls: () => n };
}

/** Never resolves — leaves a REAL running row (manifest, task dir, events all
 *  written by invoke itself), which is what `forge retry` needs to plan from. */
const hangingExec: DockerExecFn = async () => new Promise<number>(() => {});

function runtimeYaml(name: string): string {
  return `name: ${name}
description: FG-612 test runtime stub
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
`;
}

function ensureRuntime(): void {
  const home = process.env["FORGE_HOME"]!;
  mkdirSync(join(home, "runtimes"), { recursive: true });
  // `claude` is the runtime every ad-hoc (`forge invoke`) dispatch resolves;
  // the workflow step above names RUNTIME explicitly.
  for (const name of [RUNTIME, "claude"]) {
    writeFileSync(join(home, "runtimes", `${name}.yml`), runtimeYaml(name));
  }
  publishFlatAsGeneration(home);
}

function tempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

function taskRowCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c;
}

function runDirs(): string[] {
  return existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).sort() : [];
}

/** The whole point of the ticket, in one helper: a refused dispatch must be
 *  indistinguishable from one that never happened. */
async function assertRefusedWithoutTrace(
  label: string,
  run: (exec: DockerExecFn) => Promise<unknown>,
): Promise<void> {
  const runsBefore = listRuns().length;
  const tasksBefore = taskRowCount();
  const dirsBefore = runDirs();
  const spy = spyExec();

  await assert.rejects(() => run(spy.exec), /REFUSING to dispatch/, `${label}: must refuse`);

  assert.equal(spy.calls(), 0, `${label}: NO container may be started`);
  assert.equal(listRuns().length, runsBefore, `${label}: no run row may be written`);
  assert.equal(taskRowCount(), tasksBefore, `${label}: no task row may be written`);
  assert.deepEqual(runDirs(), dirsBefore, `${label}: no run/task directory may be created on disk`);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // The stub runtime declares auth.mode=apikey; buildDockerArgs refuses to
  // assemble a container without the credential, before the stubbed exec runs.
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();
  stderr = [];
  mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  _resetSelfHostWarnings();
});

afterEach(() => {
  mock.restoreAll();
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── 1. The load-bearing property: PRE-CONTAINER, PRE-ROW ─────────────────────

test("a refused self-host invoke starts no container and writes no run row, task row, or task dir", async () => {
  await assertRefusedWithoutTrace("forge invoke", (exec) =>
    invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: SELF_HOST, dockerExec: exec }),
  );
});

test("a refused read-only red dispatch is equally traceless — the risk is the shared mount, not the role", async () => {
  await assertRefusedWithoutTrace("forge invoke (red, ro mount)", (exec) =>
    invoke({
      agentRole: "red-wide",
      task: "audit forge itself",
      projectDir: SELF_HOST,
      readOnlyProject: true,
      dockerExec: exec,
    }),
  );
});

// ── 2. Every dispatch entry point ────────────────────────────────────────────

test("entry point `forge new`: the registered command refuses before startRun, leaving no run", async () => {
  const runsBefore = listRuns().length;
  const dirsBefore = runDirs();

  const program = new Command();
  program.exitOverride();
  registerNew(program);

  await assert.rejects(
    () => program.parseAsync(["node", "forge", "new", "feature", "fg612 probe", "--project", SELF_HOST]),
    /REFUSING to dispatch/,
  );

  assert.equal(listRuns().length, runsBefore, "forge new must refuse before the run row exists");
  assert.deepEqual(runDirs(), dirsBefore, "forge new must refuse before any run directory exists");
});

test("entry point `forge next`: a run created against the forge source refuses at dispatch, before any container", async () => {
  // A run minted before the guard existed (or under FORGE_NO_WORKTREES) must
  // still not dispatch into the live source unisolated — the runNext chokepoint.
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg612 next", inputs: {}, projectDir: SELF_HOST });
  const spy = spyExec();

  await runNext({ runId, workflow: WORKFLOW, dockerExec: spy.exec });

  assert.equal(spy.calls(), 0, "no container may be started for a self-host workflow step");
  const tasks = tasksForRun(runId);
  assert.equal(tasks.length, 1, "the step's task row exists (it predates the guard's chokepoint)");
  assert.equal(tasks[0]!.status, "failed");
  assert.match(String(tasks[0]!.error), /REFUSING to dispatch/);
});

test("entry point review-loop fixer: the fixer dispatch propagates the refusal and starts no container", async () => {
  const spy = spyExec();
  const findings: Finding[] = [{ summary: "tighten the guard", file: "src/v2/self-host-guard.ts", line: 99 }];

  const { deps } = buildReviewLoopDeps(
    {
      ticketId: "FG-612",
      acceptance: "the guard refuses",
      diffProvider: () => "",
      projectDir: SELF_HOST,
      scripts: {},
      unrouted: true,
      gitRunner: () => "",
    },
    (a) => invoke({ ...a, dockerExec: spy.exec }),
  );

  await assert.rejects(() => Promise.resolve(deps.fix(findings)), /REFUSING to dispatch/);
  assert.equal(spy.calls(), 0, "the fixer must not reach a container");
});

test("entry point `forge retry`: an override-once dispatch cannot be silently re-dispatched without the override", async () => {
  // The realistic shape: the operator acknowledged the shared checkout once with
  // FORGE_NO_WORKTREES=1, the task died, and the retry runs WITHOUT the override.
  // `forge retry` reaches dispatchInvokeTask directly, bypassing invoke() — the
  // call site the implementer found beyond the brief.
  process.env["FORGE_NO_WORKTREES"] = "1";
  const runId = createInvokeRun("engineer", SELF_HOST, undefined, "fg612 retry", undefined);
  void invoke({ agentRole: "engineer", task: "fix the guard", projectDir: SELF_HOST, runId, dockerExec: hangingExec });
  await new Promise((r) => setImmediate(r));

  const original = tasksForRun(runId)[0] as Task;
  assert.equal(original.status, "running", "fixture: a real running ad-hoc row against the forge source");

  performCancel(original.id, {}, () => {});
  assert.equal(getTask(original.id)!.status, "failed");

  delete process.env["FORGE_NO_WORKTREES"];
  _resetSelfHostWarnings();

  const out = await retry(original.id);
  assert.ok(out.adHoc, "fixture: the retried row is ad-hoc and carries a dispatch plan");

  const spy = spyExec();
  const res = await dispatchRetriedAdHocTask(out.newTask, out.adHoc!, spy.exec);

  assert.equal(res.status, "failed");
  assert.match(String(res.error), /REFUSING to dispatch/);
  assert.equal(spy.calls(), 0, "retry must refuse before the container, not after");
  assert.equal(getTask(out.newTask.id)!.status, "failed");

  // PRE-WRITE, like the other four entry points. The guard in dispatchInvokeTask
  // fires before the task dir is materialized, so a refused retry leaves no task
  // directory, no manifest.json and no staged auth — not merely no container.
  const retriedDir = taskDir(out.newTask.runId, out.newTask.id);
  assert.equal(existsSync(retriedDir), false, "a refused retry must not create the task directory");
  assert.equal(existsSync(join(retriedDir, "manifest.json")), false, "a refused retry must not write manifest.json");
  assert.equal(existsSync(join(retriedDir, "auth-state")), false, "a refused retry must not leave staged auth");
});

// ── 3. The two ways through must actually REACH dispatch ─────────────────────

// EXPECTATION CHANGE (was: "FORGE_WORKTREES=1 reaches the container against the
// forge source, silently"). invoke() provisions no workspace, so the flag never
// isolated this dispatch — it only silenced the guard. Only the acknowledged
// override is a way through here now; the flag's way-through is proven on the
// WORKFLOW path, which does provision, by `forge next` above.
test("FORGE_WORKTREES=1 is no longer a way through for a self-host invoke — it isolates nothing on this path", async () => {
  process.env["FORGE_WORKTREES"] = "1";
  await assertRefusedWithoutTrace("forge invoke, FORGE_WORKTREES=1", (exec) =>
    invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: SELF_HOST, dockerExec: exec }),
  );
});

test("the FG-345 default-on host: a self-host invoke refuses with NO env set at all, tracelessly", async () => {
  // The live regression shape — macOS, nothing configured. isWorktreeModeEnabled()
  // is true here, and the guard used to read that as "this dispatch is isolated".
  const realPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    await assertRefusedWithoutTrace("forge invoke, default-on host", (exec) =>
      invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: SELF_HOST, dockerExec: exec }),
    );
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
});

test("FORGE_NO_WORKTREES=1 reaches the container and warns", async () => {
  process.env["FORGE_NO_WORKTREES"] = "1";
  const spy = spyExec();

  const r = await invoke({ agentRole: "engineer", task: "edit forge itself", projectDir: SELF_HOST, dockerExec: spy.exec });

  assert.equal(spy.calls(), 1, "the acknowledged override must reach the container");
  assert.equal(r.status, "complete");
  assert.match(stderr.join(""), /WARNING — dispatching against the live forge source/);
});

// ── 4. The regression that matters most: a different project is invisible ────

test("a DIFFERENT project dispatches to the container unchanged in every env combination", async () => {
  const combos = [
    {},
    { FORGE_WORKTREES: "1" },
    { FORGE_NO_WORKTREES: "1" },
    { FORGE_WORKTREES: "1", FORGE_NO_WORKTREES: "1" },
  ];

  for (const combo of combos) {
    const label = JSON.stringify(combo);
    delete process.env["FORGE_WORKTREES"];
    delete process.env["FORGE_NO_WORKTREES"];
    Object.assign(process.env, combo);
    stderr = [];
    _resetSelfHostWarnings();

    const projectDir = tempProject("forge-fg612-other-");
    const spy = spyExec();
    const r = await invoke({ agentRole: "engineer", task: "normal work", projectDir, dockerExec: spy.exec });

    assert.equal(spy.calls(), 1, `${label}: a normal project must still reach the container`);
    assert.equal(r.status, "complete", `${label}: dispatch should succeed`);
    assert.equal(tasksForRun(r.runId).length, 1, `${label}: the task row is written as before`);
    assert.doesNotMatch(stderr.join(""), /REFUSING|live forge source/, `${label}: no FG-612 output at all`);
  }
});

test("a different project's `forge next` dispatch is untouched by the guard", async () => {
  const projectDir = tempProject("forge-fg612-other-next-");
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg612 other next", inputs: {}, projectDir });
  const spy = spyExec();

  await runNext({ runId, workflow: WORKFLOW, dockerExec: spy.exec });

  assert.equal(spy.calls(), 1, "the workflow step must still spawn its container");
  assert.doesNotMatch(String(tasksForRun(runId)[0]!.error ?? ""), /REFUSING/);
});

// ── 5. Overlap in BOTH directions, and the string-prefix negative ────────────

test("project CONTAINS the forge source root (a parent-dir mount) refuses, traceless", async () => {
  const parent = resolve(SELF_HOST, "..");
  await assertRefusedWithoutTrace("parent-dir mount", (exec) =>
    invoke({ agentRole: "engineer", task: "mount the parent", projectDir: parent, dockerExec: exec }),
  );
});

test("project is a SUBDIR of the forge source root (the --allow-subproject shape) refuses, traceless", async () => {
  const sub = join(SELF_HOST, "dashboard");
  assert.ok(existsSync(sub), `fixture: ${sub} must exist in the forge checkout`);
  await assertRefusedWithoutTrace("subproject mount", (exec) =>
    invoke({
      agentRole: "engineer",
      task: "work in the dashboard workspace",
      projectDir: sub,
      explicitSubproject: true,
      dockerExec: exec,
    }),
  );
});

test("a sibling directory that merely shares a string prefix with the forge root dispatches normally", async () => {
  // `<root>-scratch` startsWith `<root>` — the exact false positive a naive
  // prefix compare produces, and it would refuse a legitimate project forever.
  //
  // FG-644: the fixture used to be mkdir'd literally next to the forge root, which
  // is unwritable when the checkout is mounted at /project — the shape every agent
  // container has. The collision itself needs no directory (canonical() falls back
  // to resolve() for a path that does not exist), so it is asserted against the REAL
  // root this process is executing from, and the wired dispatch below runs against a
  // project the test owns.
  assert.equal(
    isSelfHostDispatch(`${SELF_HOST}-fg612-sibling-dispatch`, SELF_HOST),
    false,
    "a string-prefix neighbour of the forge root is not self-host",
  );
  const sibling = tempProject("forge-fg612-sibling-dispatch-");
  const spy = spyExec();

  const r = await invoke({ agentRole: "engineer", task: "normal work", projectDir: sibling, dockerExec: spy.exec });

  assert.equal(spy.calls(), 1, "a string-prefix sibling must reach the container");
  assert.equal(r.status, "complete");
  assert.doesNotMatch(stderr.join(""), /REFUSING|live forge source/);
});

// ── 6. Symlink resolution ────────────────────────────────────────────────────

test("a project path spelled through a symlinked parent still refuses (the /var → /private/var shape)", async () => {
  // macOS spells the same tree two ways; a guard comparing un-canonicalized
  // paths would silently never match here and be purely decorative.
  const linkFarm = mkdtempSync(join(tmpdir(), "forge-fg612-link-"));
  tmpDirs.push(linkFarm);
  const aliasParent = join(linkFarm, "alias");
  symlinkSync(resolve(SELF_HOST, ".."), aliasParent);
  // basename, not a slice of the parent's length: a checkout mounted AT a filesystem
  // root (/project, every agent container) has parent "/", and the arithmetic
  // spelling ate the first character of the name.
  const viaLink = join(aliasParent, basename(SELF_HOST));

  assert.notEqual(viaLink, SELF_HOST, "fixture: a different string for the same tree");
  assert.equal(realpathSync(viaLink), SELF_HOST, "fixture: the alias must spell the SAME tree");
  await assertRefusedWithoutTrace("symlinked parent", (exec) =>
    invoke({ agentRole: "engineer", task: "edit forge via an alias", projectDir: viaLink, dockerExec: exec }),
  );
});
