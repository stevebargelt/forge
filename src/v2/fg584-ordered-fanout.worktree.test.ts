// FG-584 — the feature build fan-out honors declared plan-item dependencies.
//
// The defect: file-disjointness is necessary for concurrent writers and says
// NOTHING about build independence. A child cannot import a primitive a sibling
// created if that sibling's commit is absent from its base, and a composition test
// cannot verify behavior absent from its workspace. The fan-out flattened every
// plan step into a sibling, dispatched each from the same committed base, and
// ignored the declared ordering.
//
// These tests run the REAL runNext over real git, with a stub docker exec standing
// in for the agent container. setPlatform("darwin") is required because
// preflightWorktreeGate hard-fails on Linux by decision (FG-358).
//
// A NOTE ON THE CRASH CELLS (AC9). Two of the four named boundaries sit INSIDE the
// wave, between a worker's capture and the candidate's integration, where the
// FG-530 kill-point registry has no probe — an ordered wave exists only under
// workspace isolation, and the FG-530 matrix runs isolation OFF by construction,
// so a probe registered there could never fire and the registry's own coverage
// test would (correctly) reject it. Those two cells therefore CONSTRUCT the exact
// durable state a crash at that boundary leaves and drive recovery from it, which
// is if anything the stronger assertion: it does not depend on where a throw
// happens to land. The other two boundaries are reached by killing at REGISTERED
// probes inside runContainer.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { allPublicationAttempts, publicationAttemptsForTask } from "../store/publications.js";
import { startRun } from "./startRun.js";
import { runNext, analyzePlanItems, type DockerExecFn } from "./runNext.js";
import { reconcileRun } from "./reconcile.js";
import { setCrashHookForTest } from "./crash-points.js";
import type { Workflow } from "./schema.js";
import {
  capturedBranchTip,
  gatedCandidateRef,
  integrationBranchName,
  isCommitIntegrated,
} from "./worktree-lifecycle.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const RUNTIME = "fg584-ordered-test";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

function orderedWorkflow(opts: { name: string; reds?: boolean; maxConcurrency?: number }): Workflow {
  return {
    name: opts.name,
    description: "FG-584 ordered fan-out fixture",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "plan", agent: "tech-lead", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] },
      {
        id: "build",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: ["plan"],
        runtime: RUNTIME,
        reds: opts.reds
          ? [{ agent: "red-narrow", authority: "authoritative", gate_on_verdict: true }]
          : [],
        fanout: {
          from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
          max_concurrency: opts.maxConcurrency ?? 4,
          failure_mode: "fail-phase",
        },
      },
    ],
  };
}

// ─── Harness ──────────────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
});

afterEach(() => {
  setCrashHookForTest(undefined);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  setPlatform(process.platform);
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg584-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg584 ordered fan-out\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-584 ordered fan-out test runtime stub
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

function projectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

function taskIdOf(dockerArgs: string[]): string {
  const i = dockerArgs.indexOf("--name");
  return i >= 0 ? (dockerArgs[i + 1] ?? "").replace(/^forge-/, "") : "";
}

function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

function armWorktreeMode(): void {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
}

/** Workspace isolation OFF — the D5 guard's permanently-reachable trigger. */
function disarmWorktreeMode(): void {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "0";
}

type PlanItem = { id: string; summary?: string; files?: string[]; depends_on?: string[]; discipline?: string };

/** The child rows of the build phase, in dispatch order. */
function buildChildren(runId: string) {
  return tasksForRun(runId)
    .filter((t) => t.phase === "build" && t.parentId !== undefined && !t.agentRole.startsWith("red-"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function buildParent(runId: string) {
  return tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
}

function planItemIdOf(t: { taskPackage: { inputs: Record<string, unknown> } }): string | undefined {
  const id = t.taskPackage.inputs["planItemId"];
  return typeof id === "string" ? id : undefined;
}

/** A recording exec. `behavior` decides what each build child does inside its own
 *  workspace; the plan step always emits `items`. */
type ChildRun = { taskId: string; planItemId?: string; workspace: string; startedAt: number; endedAt: number };

function makeExec(
  items: PlanItem[],
  behavior: (ctx: { item: string; workspace: string; taskId: string }) => { ok: boolean } | void,
  runs: ChildRun[],
): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdOf(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-plan")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, steps: items });
      return 0;
    }
    if (taskId.startsWith("task-red-")) {
      writeTaskResult(stdoutPath, { status: "complete", verdict: "pass", confidence: 1, findings: [] });
      return 0;
    }
    const workspace = projectMountHost(args)!;
    const startedAt = Date.now();
    // The child index is in the synthetic phase segment of the task id
    // (`task-build-<index>-…`); the DECLARED id is what the assertions care about,
    // and it is read back off the row rather than guessed here.
    const row = tasksForRun(runIdOf(taskId)).find((t) => t.id === taskId);
    const item = row ? planItemIdOf(row) : undefined;
    const outcome = behavior({ item: item ?? "", workspace, taskId }) ?? { ok: true };
    // A small real delay so concurrent siblings genuinely overlap in wall-clock.
    await new Promise((r) => setTimeout(r, 25));
    const endedAt = Date.now();
    runs.push({ taskId, ...(item !== undefined ? { planItemId: item } : {}), workspace, startedAt, endedAt });
    if (!outcome.ok) {
      // A crashed container: non-zero exit and NO result.json. Unambiguously a
      // failed child, with no FG-678 "the agent reported its own failure" nuance
      // to reason about — this test is about what a failed PREREQUISITE does to
      // its dependents, not about how the failure was classified.
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(stdoutPath, "stub crashed");
      writeFileSync(join(dir, "container.stderr.log"), "boom");
      return 1;
    }
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [] });
    return 0;
  };
}

/** The run id is embedded in nothing the docker args carry, so the exec closes
 *  over it via this module-level slot — set by every test before it drives. */
let CURRENT_RUN = "";
function runIdOf(_taskId: string): string {
  return CURRENT_RUN;
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — the plan-item contract: unknown refs, self-dependencies and cycles are
// refused BEFORE any build child row is minted and before any container starts.
// ══════════════════════════════════════════════════════════════════════════════

const AC1_CASES: { name: string; items: PlanItem[]; expect: RegExp }[] = [
  {
    name: "an unknown reference",
    items: [{ id: "a" }, { id: "b", depends_on: ["nope"] }],
    expect: /plan item 'b' \(index 1\) depends_on unknown work item 'nope'/,
  },
  {
    name: "a self-dependency",
    items: [{ id: "a", depends_on: ["a"] }],
    expect: /plan item 'a' \(index 0\) depends_on itself/,
  },
  {
    name: "a cycle",
    items: [{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] }],
    expect: /cycle in plan item depends_on graph involving/,
  },
  {
    name: "a duplicate declared id",
    items: [{ id: "a" }, { id: "a" }, { id: "b", depends_on: ["a"] }],
    expect: /duplicate plan item id: 'a'/,
  },
  {
    // An ordered item with no id can never be ADOPTED after a crash, so a resumed
    // wave would re-dispatch work that is already captured and integrated —
    // the duplication AC9 forbids. Refused up front instead.
    name: "an anonymous item in an ordered plan",
    items: [{ id: "a" }, { summary: "no id" } as PlanItem, { id: "b", depends_on: ["a"] }],
    expect: /declares no 'id', but this plan declares dependency edges/,
  },
];

for (const c of AC1_CASES) {
  test(`fg584 (AC1): ${c.name} is refused before ANY build child is minted`, async () => {
    armWorktreeMode();
    const repo = makeRepo();
    const wf = orderedWorkflow({ name: `fg584-ac1-${c.name.replace(/\W+/g, "-")}` });
    const { runId } = startRun({ workflow: wf, title: "fg584 ac1", inputs: {}, projectDir: repo });
    CURRENT_RUN = runId;
    const runs: ChildRun[] = [];
    const exec = makeExec(c.items, () => ({ ok: true }), runs);

    await runNext({ runId, workflow: wf, dockerExec: exec });
    const wave = await runNext({ runId, workflow: wf, dockerExec: exec });

    assert.deepEqual(wave.completedSteps, [], "the build phase must not complete");
    const parent = buildParent(runId)!;
    assert.equal(parent.status, "failed");
    assert.match(parent.error ?? "", c.expect, `the refusal must name the offending edge; got: ${parent.error}`);

    assert.deepEqual(buildChildren(runId), [], "NO build child row may exist — the refusal is pre-dispatch");
    assert.deepEqual(runs, [], "and no container ran for a build child");

    const kind = eventsForTask(parent.id)
      .filter((e) => e.eventType === "task.failed")
      .map((e) => (e.payload as Record<string, unknown>)["failure_kind"])
      .pop();
    assert.equal(kind, "plan_dependency_invalid", "the refusal carries its own named failure kind");
  });
}

test("fg584 (AC1): the graph analyzer is pure — every refusal is decidable from the plan alone", () => {
  // The dispatch-level tests above prove the refusal WINDOW; this pins that the
  // decision itself needs no DB, no git and no container, which is what makes that
  // window possible at all.
  assert.equal(analyzePlanItems([{ id: "a" }, { id: "b", depends_on: ["a"] }]).ok, true);
  const bad = analyzePlanItems([{ id: "a", depends_on: ["ghost"] }]);
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.refusal.message, /unknown work item 'ghost'/);

  const malformed = analyzePlanItems([{ id: "a", depends_on: "b" }]);
  assert.equal(malformed.ok, false, "depends_on is executable data, not prose — a string is not an edge list");

  // An array with no dependency vocabulary at all is the pre-FG-584 shape and must
  // stay UNORDERED, or every existing fan-out would change behavior (AC11).
  const plain = analyzePlanItems(["item-a", "item-b"]);
  assert.equal(plain.ok && plain.graph.ordered, false);
});

// ══════════════════════════════════════════════════════════════════════════════
// AC12 / D5 — the flat-fan-out guard, with DISJOINT files where one step imports a
// module another step creates. Disjoint paths plus a real semantic dependency is
// the exact shape that keeps slipping through, so the regression encodes THAT and
// not a same-file overlap.
// ══════════════════════════════════════════════════════════════════════════════

test("fg584 (AC12/D5): with the ordered path unavailable, an interdependent plan is REFUSED before any child spawns, naming the dependency", async () => {
  // Workspace isolation OFF: children share one checkout, no private workspace is
  // provisioned, no base is resolved and there is no candidate to integrate a
  // prerequisite into. The controller CANNOT honor the edges — a capability
  // question, not a judgement about the plan's quality.
  disarmWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac12-guard" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac12", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];

  // DISJOINT FILES. Nothing here overlaps; a file-overlap check would pass this
  // plan and dispatch both children from the same base — and `consumer.ts`'s
  // import of `primitive.ts` would not resolve.
  const items: PlanItem[] = [
    { id: "primitive", summary: "create src/primitive.ts", files: ["src/primitive.ts"] },
    {
      id: "consumer",
      summary: "src/consumer.ts imports { thing } from './primitive.js'",
      files: ["src/consumer.ts"],
      depends_on: ["primitive"],
    },
  ];
  const exec = makeExec(items, () => ({ ok: true }), runs);

  await runNext({ runId, workflow: wf, dockerExec: exec });
  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });

  assert.deepEqual(wave.completedSteps, [], "the build phase must not complete");
  const parent = buildParent(runId)!;
  assert.equal(parent.status, "failed");
  assert.match(
    parent.error ?? "",
    /plan item 'consumer' \(index 1\) depends_on 'primitive'/,
    `the refusal must NAME the dependency; got: ${parent.error}`,
  );
  assert.match(parent.error ?? "", /collapse .* into one work item/, "and tell the tech lead what to do about it");

  assert.deepEqual(buildChildren(runId), [], "no build child row was minted");
  assert.deepEqual(runs, [], "and no container started");

  const kind = eventsForTask(parent.id)
    .filter((e) => e.eventType === "task.failed")
    .map((e) => (e.payload as Record<string, unknown>)["failure_kind"])
    .pop();
  assert.equal(kind, "ordered_fanout_unavailable", "the guard's refusal is a CAPABILITY kind, not a plan-quality one");
});

test("fg584 (AC12/AC2): the SAME plan with isolation ON is not refused — the guard is a capability question, not a plan-quality one", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac12-armed" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac12 armed", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const items: PlanItem[] = [
    { id: "primitive", files: ["src/primitive.ts"] },
    { id: "consumer", files: ["src/consumer.ts"], depends_on: ["primitive"] },
  ];
  let consumerSawPrimitive: boolean | undefined;
  const exec = makeExec(
    items,
    ({ item, workspace }) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      if (item === "primitive") {
        writeFileSync(join(workspace, "src", "primitive.ts"), "export const thing = 1;\n");
      } else {
        consumerSawPrimitive = existsSync(join(workspace, "src", "primitive.ts"));
        writeFileSync(join(workspace, "src", "consumer.ts"), "import { thing } from './primitive.js';\nexport const used = thing;\n");
      }
      return { ok: true };
    },
    runs,
  );

  await runNext({ runId, workflow: wf, dockerExec: exec });
  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });

  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    `the ordered path must run it; tasks: ${JSON.stringify(tasksForRun(runId).map((t) => [t.id, t.status, t.error]))}`,
  );
  assert.equal(consumerSawPrimitive, true, "THE DEFECT: the consumer's workspace must carry the primitive it imports");
});

// ══════════════════════════════════════════════════════════════════════════════
// AC6 — ordered items may share a path; CONCURRENTLY-RUNNABLE ones may not.
// ══════════════════════════════════════════════════════════════════════════════

test("fg584 (AC6): two ORDERED items declaring the same path dispatch without refusal", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac6-ordered" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac6 ordered", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const items: PlanItem[] = [
    { id: "first", files: ["src/shared.ts"] },
    { id: "second", files: ["src/shared.ts"], depends_on: ["first"] },
  ];
  const exec = makeExec(
    items,
    ({ item, workspace }) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      const path = join(workspace, "src", "shared.ts");
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      writeFileSync(path, `${existing}export const ${item} = true;\n`);
      return { ok: true };
    },
    runs,
  );

  await runNext({ runId, workflow: wf, dockerExec: exec });
  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });

  assert.deepEqual(wave.completedSteps, ["build"], "ordered overlap is legal and must not be refused");
  assert.equal(runs.length, 2, "both items ran");
  // The second item saw the first's edit, so the shared file carries BOTH — the
  // whole reason ordered overlap is safe.
  const landed = readFileSync(join(repo, "src", "shared.ts"), "utf8");
  assert.match(landed, /export const first = true;/);
  assert.match(landed, /export const second = true;/);
});

test("fg584 (AC6): two CONCURRENTLY-RUNNABLE items declaring the same path are refused pre-dispatch, naming the path and both items", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac6-concurrent" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac6 concurrent", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const items: PlanItem[] = [
    { id: "base" },
    { id: "left", files: ["src/shared.ts"], depends_on: ["base"] },
    { id: "right", files: ["src/shared.ts"], depends_on: ["base"] },
  ];
  const exec = makeExec(items, () => ({ ok: true }), runs);

  await runNext({ runId, workflow: wf, dockerExec: exec });
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const parent = buildParent(runId)!;
  assert.equal(parent.status, "failed");
  assert.match(parent.error ?? "", /'left' \(index 1\)/);
  assert.match(parent.error ?? "", /'right' \(index 2\)/);
  assert.match(parent.error ?? "", /src\/shared\.ts/);
  assert.deepEqual(buildChildren(runId), [], "refused before any child was minted");
  assert.deepEqual(runs, [], "and before any container started");
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 / AC5 / AC4 / AC10 — THE RECURRING REGRESSION, end to end.
//
//   A creates a primitive
//   B and C both depend on A
//   D depends on B and C and verifies their composition
// ══════════════════════════════════════════════════════════════════════════════

const DIAMOND: PlanItem[] = [
  { id: "A", summary: "create the primitive", files: ["src/a.ts"] },
  { id: "B", summary: "consume the primitive", files: ["src/b.ts"], depends_on: ["A"] },
  { id: "C", summary: "consume the primitive", files: ["src/c.ts"], depends_on: ["A"] },
  { id: "D", summary: "verify the composition", files: ["src/d.test.ts"], depends_on: ["B", "C"] },
];

function diamondBehavior(saw: Record<string, string[]>) {
  return ({ item, workspace }: { item: string; workspace: string }) => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    saw[item] = ["a", "b", "c"].filter((f) => existsSync(join(workspace, "src", `${f}.ts`)));
    const name = item === "D" ? "d.test.ts" : `${item.toLowerCase()}.ts`;
    writeFileSync(join(workspace, "src", name), `export const ${item} = "${item}";\n`);
    return { ok: true };
  };
}

test("fg584 (AC2/AC5/AC4/AC10): A → {B,C} → D, proven end to end", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-diamond", reds: true, maxConcurrency: 4 });
  const { runId } = startRun({ workflow: wf, title: "fg584 diamond", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const saw: Record<string, string[]> = {};
  const exec = makeExec(DIAMOND, diamondBehavior(saw), runs);

  await runNext({ runId, workflow: wf, dockerExec: exec });
  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });
  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    `the wave must complete; tasks: ${JSON.stringify(tasksForRun(runId).map((t) => [t.id, t.status, t.error]))}`,
  );

  const by = (id: string) => runs.find((r) => r.planItemId === id)!;
  for (const id of ["A", "B", "C", "D"]) assert.ok(by(id), `${id} must have run`);

  // (AC2) ORDER. B and C never start before A has finished; D never starts before
  // both B and C have.
  assert.ok(by("B").startedAt >= by("A").endedAt, "B must not start before A finished");
  assert.ok(by("C").startedAt >= by("A").endedAt, "C must not start before A finished");
  assert.ok(by("D").startedAt >= by("B").endedAt, "D must not start before B finished");
  assert.ok(by("D").startedAt >= by("C").endedAt, "D must not start before C finished");

  // (AC2) …and independent siblings STILL run concurrently. B and C have no path
  // between them, so they overlap in wall-clock — ordering must not serialize what
  // was never ordered.
  assert.ok(
    by("B").startedAt < by("C").endedAt && by("C").startedAt < by("B").endedAt,
    "B and C are independent siblings and must overlap in wall-clock",
  );

  // (AC5) THE POINT. Each consumer's WORKSPACE carried what it consumes.
  assert.deepEqual(saw["A"], [], "A starts from the feature base");
  assert.deepEqual(saw["B"], ["a"], "B's workspace carries the primitive A created");
  assert.deepEqual(saw["C"], ["a"], "C's workspace carries the primitive A created");
  assert.deepEqual(saw["D"]?.sort(), ["a", "b", "c"], "D's workspace carries A, B and C — it can verify the composition");

  // (AC4) …read off the DB rows, not inferred. `tasks.base_sha` is the commit the
  // workspace was created at, so what its TREE carries is exactly "what this task
  // received" — and it survives the post-publication branch cleanup that a
  // captured-branch tip does not.
  const children = buildChildren(runId);
  const rowFor = (id: string) => children.find((t) => planItemIdOf(t) === id)!;
  const baseCarries = (id: string, path: string): boolean => {
    try {
      git(repo, "cat-file", "-e", `${rowFor(id).baseSha}:${path}`);
      return true;
    } catch {
      return false;
    }
  };
  for (const dependent of ["B", "C"]) {
    assert.ok(baseCarries(dependent, "src/a.ts"), `${dependent}'s recorded base_sha must CONTAIN prerequisite A's output`);
  }
  assert.ok(baseCarries("D", "src/b.ts"), "D's recorded base_sha must contain B's output");
  assert.ok(baseCarries("D", "src/c.ts"), "D's recorded base_sha must contain C's output");
  // …and EXCLUDES an unrelated unpublished sibling's output: B and C run
  // concurrently, so neither may be in the other's base.
  assert.equal(baseCarries("B", "src/c.ts"), false, "B's base must NOT contain its concurrent sibling C's unpublished output");
  assert.equal(baseCarries("A", "src/a.ts"), false, "A started from the feature base, carrying none of the wave's output");
  assert.equal(rowFor("B").baseSha, rowFor("C").baseSha, "FG-621, narrowed: ONE base per concurrently-dispatched group");
  assert.notEqual(rowFor("A").baseSha, rowFor("B").baseSha, "and the base genuinely MOVED between groups");

  // (AC10) Reds and the final gate ran ONCE, against the fully composed candidate.
  const parent = buildParent(runId)!;
  const attempts = publicationAttemptsForTask(parent.id);
  assert.equal(attempts.length, 1, `exactly one publication attempt per build phase, got ${attempts.length}`);
  assert.equal(attempts[0]!.state, "published");
  const buildTaskIds = new Set(tasksForRun(runId).filter((t) => t.phase === "build").map((t) => t.id));
  const buildAttempts = allPublicationAttempts().filter((a) => buildTaskIds.has(a.taskId));
  assert.deepEqual(buildAttempts.map((a) => a.taskId), [parent.id], "no per-item publication — only the parent publishes");
  const reds = tasksForRun(runId).filter((t) => t.agentRole.startsWith("red-"));
  assert.equal(reds.length, 1, "one red dispatch for the phase, not one per item");

  // And the composed candidate really landed: every item's file is on the target.
  for (const f of ["a.ts", "b.ts", "c.ts", "d.test.ts"]) {
    assert.ok(existsSync(join(repo, "src", f)), `${f} must be on the publish target`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — a prerequisite's worker completing does NOT satisfy the edge. Its exact
// commit must be durably integrated into the candidate the dependent receives.
// ══════════════════════════════════════════════════════════════════════════════

const AC3_ITEMS: PlanItem[] = [
  { id: "prereq", files: ["src/p.ts"] },
  { id: "dependent", files: ["src/d.ts"], depends_on: ["prereq"] },
];

test("fg584 (AC3): the CONTROL — an integrated, gated prerequisite does release its dependent", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac3-control" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac3 control", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const exec = makeExec(
    AC3_ITEMS,
    ({ item, workspace }) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", `${item[0]}.ts`), `export const ${item} = 1;\n`);
      return { ok: true };
    },
    runs,
  );

  await runNext({ runId, workflow: wf, dockerExec: exec });
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const dependent = buildChildren(runId).find((t) => planItemIdOf(t) === "dependent")!;
  assert.ok(dependent, "the dependent dispatched");
  git(repo, "cat-file", "-e", `${dependent.baseSha}:src/p.ts`, );
});

test("fg584 (AC3/D1): a prerequisite whose worker COMPLETED but whose candidate did not pass the gate does NOT release its dependent", async () => {
  // The strongest available reading of "completion is not integration": the
  // prerequisite's container exited 0, its work was captured, and its commit was
  // merged cleanly into the candidate — every step short of the one that matters.
  // The candidate then FAILS the D1 gate, so the gated-candidate ref never advances
  // past it and the dependent is refused. A dependent released here would be built
  // on a prerequisite that is present but broken, which is the signature-mismatch
  // failure one layer down from the missing-import one.
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac3-ungated" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac3 ungated", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const exec = makeExec(
    AC3_ITEMS,
    ({ item, workspace }) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", `${item[0]}.ts`), `export const ${item} = 1;\n`);
      if (item === "prereq") {
        // The prerequisite's own change is what breaks the candidate's build.
        writeFileSync(
          join(workspace, "package.json"),
          JSON.stringify({ name: "fg584-ac3", private: true, scripts: { "test:unit": "exit 1" } }),
        );
      }
      return { ok: true };
    },
    runs,
  );

  await runNext({ runId, workflow: wf, dockerExec: exec });
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const children = buildChildren(runId);
  const prereq = children.find((t) => planItemIdOf(t) === "prereq")!;
  assert.equal(prereq.status, "complete", "the prerequisite's WORKER completed");
  assert.ok(capturedBranchTip(repo, runId, prereq.id), "…and its work was captured");
  const parent = buildParent(runId)!;
  assert.ok(
    isCommitIntegrated(repo, capturedBranchTip(repo, runId, prereq.id)!, integrationBranchName(runId, parent.id)),
    "…and MERGED into the candidate — every step short of being proven to build",
  );
  assert.equal(
    isCommitIntegrated(repo, capturedBranchTip(repo, runId, prereq.id)!, gatedCandidateRef(runId, parent.id)),
    false,
    "the gated-candidate ref did NOT advance to it",
  );

  assert.equal(
    children.some((t) => planItemIdOf(t) === "dependent"),
    false,
    "…so the dependent never dispatched: completion, capture and even a clean merge are not integration",
  );
  assert.equal(runs.filter((r) => r.planItemId === "dependent").length, 0, "no container ran for it either");
  assert.equal(parent.status, "failed");
  assert.match(parent.error ?? "", /'dependent' \(index 1\) blocked by 'prereq'/);
  assert.deepEqual(publicationAttemptsForTask(parent.id), [], "and nothing was published");
});

// ══════════════════════════════════════════════════════════════════════════════
// AC7 / D3 — a failed prerequisite blocks every TRANSITIVE dependent by name, and
// independent ready work runs to COMPLETION before the phase fails.
// ══════════════════════════════════════════════════════════════════════════════

test("fg584 (AC7/D3): a failed prerequisite blocks its transitive dependents by name; independent work still runs to completion", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac7" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac7", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const items: PlanItem[] = [
    { id: "A", files: ["src/a.ts"] },                       // fails
    { id: "E", files: ["src/e.ts"] },                       // independent, group 0
    { id: "B", files: ["src/b.ts"], depends_on: ["A"] },    // blocked
    { id: "F", files: ["src/f.ts"], depends_on: ["E"] },    // independent, group 1 — runs AFTER A failed
    { id: "D", files: ["src/d.ts"], depends_on: ["B"] },    // transitively blocked
  ];
  const exec = makeExec(
    items,
    ({ item, workspace }) => {
      if (item === "A") return { ok: false };
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", `${item.toLowerCase()}.ts`), `export const ${item} = 1;\n`);
      return { ok: true };
    },
    runs,
  );

  await runNext({ runId, workflow: wf, dockerExec: exec });
  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });

  assert.deepEqual(wave.completedSteps, [], "fail-phase still fails the phase");
  const ran = runs.map((r) => r.planItemId).sort();
  assert.deepEqual(ran, ["A", "E", "F"], "A failed, E and F — independent ready work — ran to COMPLETION");

  const dispatched = buildChildren(runId).map(planItemIdOf).sort();
  assert.deepEqual(dispatched, ["A", "E", "F"], "B and D never got a child row at all");

  const parent = buildParent(runId)!;
  assert.equal(parent.status, "failed");
  assert.match(parent.error ?? "", /'B' \(index 2\) blocked by 'A'/, "the blocked dependent and its blocker are NAMED");
  assert.match(parent.error ?? "", /'D' \(index 4\) blocked by 'B'/, "…transitively");
  assert.match(parent.error ?? "", /Independent ready work ran to completion first/);
  assert.deepEqual(publicationAttemptsForTask(parent.id), [], "nothing was published for the build phase");

  const kind = eventsForTask(parent.id)
    .filter((e) => e.eventType === "task.failed")
    .map((e) => (e.payload as Record<string, unknown>)["failure_kind"])
    .pop();
  assert.equal(kind, "prerequisite_blocked");

  // D3's timing change, asserted rather than assumed: the pre-FG-584 runner
  // ABORTED the wave on the first failed child, so F — dispatched in a LATER group
  // than the failure — could not have run at all.
  const a = runs.find((r) => r.planItemId === "A")!;
  const f = runs.find((r) => r.planItemId === "F")!;
  assert.ok(f.startedAt >= a.endedAt, "F was dispatched AFTER A had already failed, and still ran to completion");
});

// ══════════════════════════════════════════════════════════════════════════════
// AC8 / D2 — a merge conflict is a typed integration block.
// ══════════════════════════════════════════════════════════════════════════════

test("fg584 (AC8/D2): a conflicting ordered worker parks as a typed integration block — no downstream dispatch, no publication, no auto-resolution", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac8" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac8", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  // The two group-0 items declare DISJOINT paths — so AC6's concurrent-overlap
  // refusal correctly does not fire — and then both write `collide.ts` anyway.
  // `files` is a declaration; the workspace is real. This is the shape a textual
  // conflict actually arrives in.
  const items: PlanItem[] = [
    { id: "left", files: ["src/left.ts"] },
    { id: "right", files: ["src/right.ts"] },
    { id: "after", files: ["src/after.ts"], depends_on: ["left"] },
  ];
  const exec = makeExec(
    items,
    ({ item, workspace }) => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", "collide.ts"), `export const owner = "${item}";\n`);
      return { ok: true };
    },
    runs,
  );

  await runNext({ runId, workflow: wf, dockerExec: exec });
  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });

  assert.deepEqual(wave.completedSteps, []);
  const parent = buildParent(runId)!;
  assert.equal(parent.status, "failed");

  const kind = eventsForTask(parent.id)
    .filter((e) => e.eventType === "task.failed")
    .map((e) => (e.payload as Record<string, unknown>)["failure_kind"])
    .pop();
  assert.equal(kind, "integration_blocked", "a conflict is its own typed outcome, not a generic failure");

  const blockEvent = eventsForTask(parent.id).find((e) => e.eventType === "integration.blocked");
  assert.ok(blockEvent, "the block is recorded as durable, structured data");
  const payload = blockEvent!.payload as Record<string, unknown>;
  assert.equal(typeof payload["childTaskId"], "string", "…carrying the conflicting WORKER");
  assert.equal(payload["candidateBranch"], integrationBranchName(runId, parent.id), "…the target CANDIDATE");
  assert.deepEqual(payload["conflictPaths"], ["src/collide.ts"], "…and the conflicting PATHS");

  // The parent's result carries the same fact, so `forge show` and any downstream
  // reader see what the failure message names.
  const result = parent.result as Record<string, unknown>;
  assert.ok(result["integration_block"], "the typed block is on the parent's result too");

  // No downstream dependent started, and nothing reached the target.
  assert.equal(
    buildChildren(runId).some((t) => planItemIdOf(t) === "after"),
    false,
    "the dependent of the conflicting worker never dispatched",
  );
  assert.deepEqual(publicationAttemptsForTask(parent.id), [], "no publication attempt reached the target branch");
  assert.equal(existsSync(join(repo, "src", "collide.ts")), false, "and the target is untouched");
});

// ══════════════════════════════════════════════════════════════════════════════
// AC9 — crash recovery converges across the four named boundaries, without
// duplicating completed work and without skipping a dependency.
// ══════════════════════════════════════════════════════════════════════════════

/** Drive reconcile + runNext to a fixpoint, exactly as a fresh `forge next` does. */
async function recoverToFixpoint(runId: string, wf: Workflow, exec: DockerExecFn): Promise<void> {
  for (let pass = 0; pass < 6; pass++) {
    reconcileRun(runId, () => false, () => "not_found" as const);
    const before = JSON.stringify(tasksForRun(runId).map((t) => [t.id, t.status]));
    await runNext({ runId, workflow: wf, dockerExec: exec });
    const after = JSON.stringify(tasksForRun(runId).map((t) => [t.id, t.status]));
    const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
    if (parent && (parent.status === "complete" || parent.status === "failed")) return;
    if (before === after) return;
  }
}

/** Containers that actually STARTED, per declared plan item. The AC9 assertion is
 *  about work being re-run, so it counts dispatches — not rows. */
function dispatchCount(runs: ChildRun[], item: string): number {
  return runs.filter((r) => r.planItemId === item).length;
}

const AC9_CHAIN: PlanItem[] = [
  { id: "P1", files: ["src/p1.ts"] },
  { id: "P2", files: ["src/p2.ts"] },
  { id: "DEP", files: ["src/dep.ts"], depends_on: ["P1", "P2"] },
];

function chainBehavior(saw: Record<string, string[]>) {
  return ({ item, workspace }: { item: string; workspace: string }) => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    saw[item] = ["p1", "p2"].filter((f) => existsSync(join(workspace, "src", `${f}.ts`)));
    writeFileSync(join(workspace, "src", `${item.toLowerCase()}.ts`), `export const ${item} = 1;\n`);
    return { ok: true };
  };
}

test("fg584 (AC9 boundary 1): crash with a worker CAPTURED but not yet integrated — recovery adopts it, never re-runs it", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  // max_concurrency 1 so group 0's two items dispatch SEQUENTIALLY: without that
  // both containers launch before either has finished, and the only reachable
  // crash window is the one boundary 3 already covers.
  const wf = orderedWorkflow({ name: "fg584-ac9-capture", maxConcurrency: 1 });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac9-1", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const saw: Record<string, string[]> = {};
  const exec = makeExec(AC9_CHAIN, chainBehavior(saw), runs);

  await runNext({ runId, workflow: wf, dockerExec: exec });

  // Kill at a REGISTERED probe, as the SECOND group-0 worker's container launches.
  // At that instant P1 has completed and been captured, and NOTHING has been
  // merged into the candidate yet — the wave merges only once its whole group has
  // settled. That is boundary 1, exactly.
  let armed = true;
  setCrashHookForTest((point) => {
    if (!armed) return;
    if (point !== "runContainer:after-mark-running-before-container-launch") return;
    if (runs.length < 1) return; // let the first worker through
    armed = false;
    throw new Error("simulated host crash");
  });
  await assert.rejects(() => runNext({ runId, workflow: wf, dockerExec: exec }), /simulated host crash/);
  setCrashHookForTest(undefined);

  const p1Row = buildChildren(runId).find((t) => planItemIdOf(t) === "P1")!;
  assert.equal(p1Row.status, "complete", "P1's worker landed before the crash");
  assert.ok(capturedBranchTip(repo, runId, p1Row.id), "…and its work was CAPTURED");
  const parentBefore = buildParent(runId)!;
  assert.equal(
    isCommitIntegrated(repo, capturedBranchTip(repo, runId, p1Row.id)!, integrationBranchName(runId, parentBefore.id)),
    false,
    "precondition: it is NOT yet in the candidate — this is the boundary under test",
  );

  await recoverToFixpoint(runId, wf, exec);

  const parent = buildParent(runId)!;
  assert.equal(parent.status, "complete", `recovery must converge; error: ${parent.error}`);
  assert.equal(dispatchCount(runs, "P1"), 1, "P1's already-captured work was ADOPTED, never re-run");
  assert.equal(dispatchCount(runs, "DEP"), 1, "…and the dependent ran exactly once");
  assert.deepEqual(saw["DEP"]?.sort(), ["p1", "p2"], "…with BOTH prerequisites present in its workspace");
});

test("fg584 (AC9 boundary 2): crash with the integration DONE but readiness not yet recorded — recovery re-proves it, re-runs nothing", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac9-readiness" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac9-2", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const saw: Record<string, string[]> = {};
  const exec = makeExec(AC9_CHAIN, chainBehavior(saw), runs);

  await runNext({ runId, workflow: wf, dockerExec: exec });

  // Crash as the DEPENDENT's container launches: group 0 is merged AND gated by
  // then. Rewinding the gated-candidate ref afterwards reconstructs the exact
  // state a crash BETWEEN the merge and the readiness record leaves — integration
  // complete on the object graph, readiness unproven.
  let armed = true;
  setCrashHookForTest((point) => {
    if (!armed) return;
    if (point !== "runContainer:after-mark-running-before-container-launch") return;
    if (runs.length < 2) return;
    armed = false;
    throw new Error("simulated host crash");
  });
  await assert.rejects(() => runNext({ runId, workflow: wf, dockerExec: exec }), /simulated host crash/);
  setCrashHookForTest(undefined);

  const parentBefore = buildParent(runId)!;
  const p1Row = buildChildren(runId).find((t) => planItemIdOf(t) === "P1")!;
  assert.ok(
    isCommitIntegrated(repo, capturedBranchTip(repo, runId, p1Row.id)!, integrationBranchName(runId, parentBefore.id)),
    "precondition: the integration really did complete",
  );
  git(repo, "update-ref", "-d", gatedCandidateRef(runId, parentBefore.id));

  await recoverToFixpoint(runId, wf, exec);

  const parent = buildParent(runId)!;
  assert.equal(parent.status, "complete", `recovery must converge; error: ${parent.error}`);
  assert.equal(dispatchCount(runs, "P1"), 1, "no prerequisite was re-run to re-establish readiness");
  assert.equal(dispatchCount(runs, "P2"), 1);
  assert.equal(dispatchCount(runs, "DEP"), 1, "and the dependent ran exactly once");
  assert.deepEqual(saw["DEP"]?.sort(), ["p1", "p2"], "…never skipping a dependency");
});

test("fg584 (AC9 boundary 3): crash after the prerequisite is integrated and before the dependent dispatches", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac9-predispatch" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac9-3", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const saw: Record<string, string[]> = {};
  const exec = makeExec(AC9_CHAIN, chainBehavior(saw), runs);

  await runNext({ runId, workflow: wf, dockerExec: exec });

  let armed = true;
  setCrashHookForTest((point) => {
    if (!armed) return;
    if (point !== "runContainer:after-mark-running-before-container-launch") return;
    if (runs.length < 2) return; // both prerequisites are done, merged and gated
    armed = false;
    throw new Error("simulated host crash");
  });
  await assert.rejects(() => runNext({ runId, workflow: wf, dockerExec: exec }), /simulated host crash/);
  setCrashHookForTest(undefined);

  await recoverToFixpoint(runId, wf, exec);

  const parent = buildParent(runId)!;
  assert.equal(parent.status, "complete", `recovery must converge; error: ${parent.error}`);
  assert.equal(dispatchCount(runs, "P1"), 1, "neither integrated prerequisite was re-run");
  assert.equal(dispatchCount(runs, "P2"), 1);
  assert.deepEqual(saw["DEP"]?.sort(), ["p1", "p2"], "and the dependent's base carried both prerequisites");
});

test("fg584 (AC9 boundary 4): crash after the dependent is dispatched and before its task-state write completes", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = orderedWorkflow({ name: "fg584-ac9-statewrite" });
  const { runId } = startRun({ workflow: wf, title: "fg584 ac9-4", inputs: {}, projectDir: repo });
  CURRENT_RUN = runId;
  const runs: ChildRun[] = [];
  const saw: Record<string, string[]> = {};
  const exec = makeExec(AC9_CHAIN, chainBehavior(saw), runs);

  await runNext({ runId, workflow: wf, dockerExec: exec });

  // The dependent's container has STARTED; its completion write never happens.
  let armed = true;
  setCrashHookForTest((point) => {
    if (!armed) return;
    if (point !== "runContainer:after-container-started-before-exec") return;
    if (runs.length < 2) return;
    armed = false;
    throw new Error("simulated host crash");
  });
  await assert.rejects(() => runNext({ runId, workflow: wf, dockerExec: exec }), /simulated host crash/);
  setCrashHookForTest(undefined);

  const stranded = buildChildren(runId).find((t) => planItemIdOf(t) === "DEP");
  assert.ok(stranded, "precondition: the dependent's row exists");
  assert.equal(stranded!.status, "running", "…and it is stranded mid-dispatch");

  await recoverToFixpoint(runId, wf, exec);

  const parent = buildParent(runId)!;
  assert.equal(parent.status, "complete", `recovery must converge; error: ${parent.error}`);
  assert.equal(dispatchCount(runs, "P1"), 1, "the prerequisites were not re-run");
  assert.equal(dispatchCount(runs, "P2"), 1);
  assert.deepEqual(saw["DEP"]?.sort(), ["p1", "p2"], "the re-dispatched dependent still received both prerequisites");
  assert.equal(
    buildChildren(runId).filter((t) => planItemIdOf(t) === "DEP" && t.status === "complete").length,
    1,
    "exactly one completed dependent — recovery neither duplicated nor skipped",
  );
});
