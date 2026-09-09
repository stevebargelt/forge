// FG-791 — post-review pipeline phases base their worktree on the REVIEWED candidate.
//
// The defect (observed live on run-fg-784, publication fc881287): after a run's build
// gate is settled by an evidence-led review that FIXED the build on a post-fix candidate
// (C2), the pipeline's later phases (verify, docs) derived their workspace from the build's
// FROZEN integration head (C0) instead of C2. A test authored against pre-fix semantics
// passed in-container against the stale C0 and was then published onto the reviewed branch,
// where it failed deterministically. Candidate-bound evidence was undermined: a later phase
// verified stale code and shipped a stale artifact onto the reviewed tip.
//
// The fix repoints the single base authority (resolveTaskBaseSha) at the settled review's
// candidate_sha. These tests run the REAL runNext over real git — build fan-out integrates
// at C0, a review-style fix commit advances the run's candidate to C2, and the verify phase
// is dispatched — and assert the verify worktree is cut from C2 and CONTAINS the fix commit.
//
// setPlatform("darwin") is required because preflightWorktreeGate hard-fails on Linux by
// decision (FG-358); the workspace-isolation dispatch path only exists under it.
//
// Coverage:
//   • AC2 — verify bases on the reviewed candidate C2, and its worktree contains the fix
//     commit that is ABSENT from the pre-review head C0.
//   • guard (i) — the build fan-out, dispatched BEFORE any review settles, is a clean no-op:
//     its children are cut from the feature base and the base source is `head`, never
//     `reviewed_candidate`. (Pre-settlement is today's behavior.)
//   • guard (ii) — a request-changes re-run of the post-review phase picks up the SAME
//     advanced candidate C2 (resolveTaskBaseSha is the one authority for re-runs too).
//   • the freeze — settlement is the freeze point: the settled review's candidate_sha is
//     stable through verify dispatch and its re-run (no path advances it after settlement).
//   • AC(b) degrade — a legacy verdict-mode run with no evidence-led review bases the later
//     phase on the publication receipt (C0) exactly as before: no repoint, no new refusal.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import type { Task } from "../types/index.js";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { publicationAttemptsForTask } from "../store/publications.js";
import { insertReview, setReviewState, getReview } from "../store/reviews.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { gate } from "./gate.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Workflow } from "./schema.js";

const RUNTIME = "fg791-reviewed-base-test";

// ─── Workflow fixture: plan → build (fan-out) → verify (a post-review phase) ────

type ReviewMode = Workflow["review_mode"];
type PostReviewPhase = "verify" | "docs";

function pipelineWorkflow(name: string, reviewMode: ReviewMode, postReviewPhase: PostReviewPhase = "verify"): Workflow {
  return {
    name,
    description: "FG-791 reviewed-candidate base fixture",
    review_mode: reviewMode,
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
        reds: [],
        fanout: {
          from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
          max_concurrency: 4,
          failure_mode: "fail-phase",
        },
      },
      // verify is a sequential POST-BUILD phase — the position the incident's stale-based
      // verify occupied. gate: human parks it at awaiting_gate (base recorded at dispatch,
      // nothing published) and gives request-changes a gate to act on for guard (ii).
      {
        id: postReviewPhase,
        agent: postReviewPhase === "docs" ? "documentation-maintainer" : "test-engineer",
        gate: "human",
        manual: false,
        depends_on: ["build"],
        runtime: RUNTIME,
        reds: [],
      },
    ],
  };
}

/** `gate()` re-loads the workflow from FORGE_HOME BY NAME, so a test that drives a real
 *  request-changes has to publish the same shape as YAML. */
function publishWorkflowYaml(wf: Workflow): void {
  const postReview = wf.steps.find((step) => step.id === "verify" || step.id === "docs")!;
  const path = join(process.env.FORGE_HOME!, "workflows", `${wf.name}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `name: ${wf.name}
description: "FG-791 reviewed-candidate base fixture"
review_mode: ${wf.review_mode}
inputs: []
steps:
  - id: plan
    agent: tech-lead
    gate: auto
    manual: false
    depends_on: []
    runtime: ${RUNTIME}
    reds: []
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: [plan]
    runtime: ${RUNTIME}
    reds: []
    fanout:
      from_upstream:
        step: plan
        array_key: steps
        input_key: step
      max_concurrency: 4
      failure_mode: fail-phase
  - id: ${postReview.id}
    agent: ${postReview.agent}
    gate: human
    manual: false
    depends_on: [build]
    runtime: ${RUNTIME}
    reds: []
`,
  );
  // The loader reads the published GENERATION, not the flat home ensureRuntime wrote —
  // republish so this workflow is visible where gate() looks for it.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Two INDEPENDENT build items → one concurrently-dispatched group → one wave base. Their
// declared files are disjoint (the AC6 concurrent-overlap check passes); the workspace
// writes below are what actually integrate into C0.
const BUILD_ITEMS = [
  { id: "impl-a", files: ["src/impl-a.ts"] },
  { id: "impl-b", files: ["src/impl-b.ts"] },
];

// ─── Harness ────────────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = [
  "FORGE_HOST_VERIFICATION_SETUP",
  "FORGE_INTEGRATION_GATE_TIMEOUT_MS",
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
  const dir = mkdtempSync(join(tmpdir(), `forge-fg791-${label}-`));
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
  writeFileSync(join(dir, "README.md"), "# fg791 reviewed-candidate base\n");
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
description: FG-791 reviewed-candidate base test runtime stub
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

function armWorktreeMode(): void {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
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

function writeResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

/** The stub agent container: the plan emits the build items; every build child writes a
 *  unique file (so its work really integrates into C0); verify (and any re-run) just
 *  completes. */
function makeExec(): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdOf(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-plan")) {
      writeResult(stdoutPath, { status: "complete", tests_run: 1, steps: BUILD_ITEMS });
      return 0;
    }
    if (taskId.startsWith("task-build")) {
      const ws = projectMountHost(args)!;
      const safe = taskId.replace(/[^a-z0-9]+/gi, "_");
      mkdirSync(join(ws, "src"), { recursive: true });
      writeFileSync(join(ws, "src", `${safe}.ts`), `export const built_${safe} = true;\n`);
      writeResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [`src/${safe}.ts`] });
      return 0;
    }
    // verify + its request-changes re-run
    writeResult(stdoutPath, { status: "complete", tests_run: 1 });
    return 0;
  };
}

// ─── Row/event helpers ────────────────────────────────────────────────────────

function buildParent(runId: string): Task {
  return tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
}

function buildChildren(runId: string): Task[] {
  return tasksForRun(runId).filter(
    (t) => t.phase === "build" && t.parentId !== undefined && !t.agentRole.startsWith("red-"),
  );
}

function verifyTasks(runId: string): Task[] {
  return phaseTasks(runId, "verify");
}

function phaseTasks(runId: string, phase: PostReviewPhase): Task[] {
  return tasksForRun(runId)
    .filter((t) => t.phase === phase && !t.agentRole.startsWith("red-"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The published integration head of the build phase — the pre-review candidate C0, read
 *  off the phase's own publication receipt rather than a working-tree tip. */
function publishedBuildHead(runId: string): string {
  const attempt = publicationAttemptsForTask(buildParent(runId).id).find((a) => a.state === "published");
  assert.ok(attempt?.publishedSha, "the build phase must have published a candidate (C0)");
  return attempt!.publishedSha!;
}

type BaseResolvedEvent = { runId: string; taskId: string; baseSha: string; source: string };

function baseResolvedFor(taskId: string): BaseResolvedEvent[] {
  return eventsForTask(taskId)
    .filter((e) => e.eventType === "phase.base_resolved")
    .map((e) => e.payload as unknown as BaseResolvedEvent);
}

/** Does the tree at `sha` carry `path`? A cheap ancestry-free presence check on the base
 *  commit itself — which is exactly the worktree a task is cut from. */
function baseTreeHas(repo: string, sha: string, path: string): boolean {
  try {
    git(repo, "cat-file", "-e", `${sha}:${path}`);
    return true;
  } catch {
    return false;
  }
}

/** Advance the run's candidate to a fix commit C2 the way an evidence-led review does: a
 *  commit ON TOP of the published build head C0, on the run's clone branch, recorded as the
 *  settled review's candidate_sha. Returns C2. Built in a throwaway linked worktree so the
 *  publish target (main) is not disturbed; the branch (and thus C2) survives its removal. */
function settleReviewAtFixCommit(repo: string, runId: string, c0: string): string {
  const wt = join(tmpRoot("fixwt"), "wt");
  git(repo, "worktree", "add", "--quiet", "-b", "fg791-reviewed-candidate", wt, c0);
  mkdirSync(join(wt, "src"), { recursive: true });
  // The review's fix — modeled on the RF-5 fix the incident's stale test refused.
  writeFileSync(join(wt, "src", "rf5-fix.ts"), "export const rf5Fixed = true;\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "review fix: RF-5 (post-review candidate)");
  const c2 = git(wt, "rev-parse", "HEAD").trim();
  git(repo, "worktree", "remove", "--force", wt);

  insertReview({
    id: "review-fg791",
    reviewMode: "evidence_led",
    runId,
    subjectTaskId: buildParent(runId).id,
    ticketId: "FG-791",
    candidateSha: c2,
  });
  setReviewState("review-fg791", "settled");
  return c2;
}

// ══════════════════════════════════════════════════════════════════════════════
// AC2 (+ guards i/ii + the freeze): the verify phase bases on the reviewed candidate.
// ══════════════════════════════════════════════════════════════════════════════

test("fg791 (AC2): verify bases on the REVIEWED candidate C2 and its worktree contains the fix commit — not the pre-review head C0", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const featureBase = git(repo, "rev-parse", "HEAD").trim();
  const wf = pipelineWorkflow("fg791-reviewed-base", "evidence_led");
  publishWorkflowYaml(wf);
  const { runId } = startRun({ workflow: wf, title: "fg791 reviewed base", inputs: {}, projectDir: repo });
  const exec = makeExec();

  // Wave 1: plan. Wave 2: the build fan-out, which integrates + publishes at C0.
  await runNext({ runId, workflow: wf, dockerExec: exec });
  await runNext({ runId, workflow: wf, dockerExec: exec });

  // ── guard (i): pre-settlement is a clean no-op. The build fan-out ran BEFORE any review
  // settled, so every child is cut from the feature base and the wave's base source is
  // `head` — never repointed at a reviewed candidate that does not exist yet.
  const kids = buildChildren(runId);
  assert.ok(kids.length >= 2, `the build fan-out dispatched its children; got ${kids.length}`);
  for (const k of kids) {
    assert.equal(k.baseSha, featureBase, "a pre-settlement build child is cut from the feature base");
  }
  // The build wave base is the feature base (plan published no source change, so its receipt
  // and HEAD both point there) — resolved via today's authority, NEVER a reviewed candidate
  // that does not exist yet.
  const buildBase = baseResolvedFor(buildParent(runId).id);
  assert.ok(
    buildBase.some((e) => e.baseSha === featureBase && e.source !== "reviewed_candidate"),
    `the build wave base is the feature base via today's authority; got ${JSON.stringify(buildBase)}`,
  );
  assert.ok(
    !buildBase.some((e) => e.source === "reviewed_candidate"),
    "a phase that predates settlement must NEVER resolve a reviewed candidate",
  );

  // C0 is the published build head; verify must not (as the incident did) base on it.
  const c0 = publishedBuildHead(runId);
  assert.equal(verifyTasks(runId).length, 0, "verify must not dispatch until the next wave — the review settles in between");

  // A review-style fix advances the run's candidate to C2 on the run's branch, and settles.
  const c2 = settleReviewAtFixCommit(repo, runId, c0);
  assert.notEqual(c2, c0, "the fix commit genuinely moved the candidate");

  // Wave 3: verify dispatches — and must be cut from the reviewed candidate C2.
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const verify = verifyTasks(runId);
  assert.equal(verify.length, 1, "the verify phase dispatched exactly once");
  const v = verify[0]!;
  assert.equal(v.baseSha, c2, "THE FIX: verify is cut from the REVIEWED candidate C2");
  assert.notEqual(v.baseSha, c0, "…not from the pre-review integration head C0");

  // The phase record names both the base sha AND its source (AC1).
  const ev = baseResolvedFor(v.id);
  assert.deepEqual(
    ev.map((e) => ({ source: e.source, baseSha: e.baseSha })),
    [{ source: "reviewed_candidate", baseSha: c2 }],
    "the verify phase record names the reviewed candidate as its base and why",
  );

  // The worktree it was cut from CONTAINS the review fix commit, and C0 does not — the exact
  // property the incident violated (the fix was absent from the base the phase actually ran on).
  assert.ok(baseTreeHas(repo, v.baseSha, "src/rf5-fix.ts"), "the verify worktree contains the review's fix commit");
  assert.equal(baseTreeHas(repo, c0, "src/rf5-fix.ts"), false, "the pre-review head C0 does NOT contain the fix");

  // ── guard (ii): a request-changes re-run of the post-review phase picks up the SAME
  // advanced candidate C2 (resolveTaskBaseSha is the one authority for re-runs too).
  await gate(v.id, "request-changes", "reviewer advanced the candidate; re-run verify on it");
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const afterReRun = verifyTasks(runId);
  const rerun = afterReRun[afterReRun.length - 1]!;
  assert.notEqual(rerun.id, v.id, "the request-changes minted a fresh verify primary");
  assert.equal(rerun.baseSha, c2, "the re-run bases on the reviewed candidate C2, exactly as the first dispatch did");
  assert.deepEqual(
    baseResolvedFor(rerun.id).map((e) => e.source),
    ["reviewed_candidate"],
    "the re-run resolved its base through the same authority",
  );

  // ── the freeze: settlement is the freeze point. The settled review's candidate_sha is
  // stable through verify dispatch and its re-run — no path advances it after settlement.
  const settled = getReview("review-fg791")!;
  assert.equal(settled.state, "settled", "the review is still settled");
  assert.equal(settled.candidateSha, c2, "and its candidate_sha never moved after settlement");
});

test("fg791 (AC1): docs bases on the settled reviewed candidate and records its reviewed_candidate source", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = pipelineWorkflow("fg791-reviewed-docs-base", "evidence_led", "docs");
  publishWorkflowYaml(wf);
  const { runId } = startRun({ workflow: wf, title: "fg791 reviewed docs base", inputs: {}, projectDir: repo });
  const exec = makeExec();

  await runNext({ runId, workflow: wf, dockerExec: exec }); // plan
  await runNext({ runId, workflow: wf, dockerExec: exec }); // build → C0
  const c0 = publishedBuildHead(runId);
  const c2 = settleReviewAtFixCommit(repo, runId, c0);

  await runNext({ runId, workflow: wf, dockerExec: exec }); // docs

  const docs = phaseTasks(runId, "docs");
  assert.equal(docs.length, 1, "the post-review docs phase dispatched exactly once");
  const d = docs[0]!;
  assert.equal(d.baseSha, c2, "docs is cut from the reviewed candidate, not the build integration head");
  assert.notEqual(d.baseSha, c0, "docs must not use the stale pre-review integration head");
  assert.deepEqual(
    baseResolvedFor(d.id).map((e) => ({ source: e.source, baseSha: e.baseSha })),
    [{ source: "reviewed_candidate", baseSha: c2 }],
    "the docs task record names the reviewed candidate base and its authority",
  );
  assert.ok(baseTreeHas(repo, d.baseSha, "src/rf5-fix.ts"), "the docs worktree includes the review fix");
});

// ══════════════════════════════════════════════════════════════════════════════
// AC(b) — a legacy verdict-mode run with NO evidence-led review degrades to today's
// behavior: the later phase bases on the publication receipt (C0). No repoint, no refusal.
// ══════════════════════════════════════════════════════════════════════════════

test("fg791 (AC(b)): a legacy verdict-mode run bases the later phase on the publication receipt — no reviewed-candidate repoint", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const wf = pipelineWorkflow("fg791-legacy-degrade", "legacy_verdict");
  const { runId } = startRun({ workflow: wf, title: "fg791 legacy degrade", inputs: {}, projectDir: repo });
  const exec = makeExec();

  await runNext({ runId, workflow: wf, dockerExec: exec }); // plan
  await runNext({ runId, workflow: wf, dockerExec: exec }); // build → C0

  const c0 = publishedBuildHead(runId);
  await runNext({ runId, workflow: wf, dockerExec: exec }); // verify

  const verify = verifyTasks(runId);
  assert.equal(verify.length, 1, "the verify phase dispatched");
  const v = verify[0]!;
  assert.equal(v.baseSha, c0, "with no evidence-led review, verify bases on the publication receipt — today's behavior");
  assert.deepEqual(
    baseResolvedFor(v.id).map((e) => ({ source: e.source, baseSha: e.baseSha })),
    [{ source: "publication_receipt", baseSha: c0 }],
    "the base source degrades to the publication receipt; no new source is reachable for a verdict-mode run",
  );
});
